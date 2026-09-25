"""
pipeline.py - the AI orchestrator that ties the whole stack together and ENFORCES
staged, gated processing (the model cannot skip a stage; each stage must pass).

  spec (NL)
    -> [1 retrieve]  RAG verified-library-first context
    -> [2 generate]  LLM + GBNF grammar -> Intent-JSON (topology only)  (retry on fail)
    -> [3 validate]  ERC (validateIntent mirror)                         GATE
    -> [4 simulate]  netlist -> truth table (real logic, not the model's claim)  GATE
    -> [5 verify]    oracle/equivalence check (vs spec oracle or corpus golden)   GATE*
    -> [6 codegen]   DETERMINISTIC Intent -> VHDL (cannot hallucinate the code)
    -> [7 gate]      status = VERIFIED | VALID_UNVERIFIED | REJECTED  (+ full evidence)

Anti-hallucination layers stacked here: GBNF (structure) + ERC (validity) + RAG
(correct logic guidance) + simulation (ground truth) + oracle equivalence + retry
+ deterministic codegen. The result carries EVIDENCE for every stage.
"""
from __future__ import annotations
import json
import re
from pathlib import Path

from intent_validate import validate_intent, hints_for_retry
from netlist_sim import truth_table, table_signature, is_sequential, simulate_sequential
from gen_vhdl import generate_vhdl
import boolexpr

HERE = Path(__file__).resolve().parent
LABS = HERE / "rag" / "labs"


# ---- oracle helpers -------------------------------------------------------
def _sig_from_rows(in_names, out_names, rows):
    return {"inputs": list(in_names), "outputs": list(out_names),
            "rows": {tuple(b): tuple(o) for b, o in rows}}


def oracle_from_callable(inputs, outputs, fn):
    """fn(**inputs)->tuple(outputs) -> a frozen oracle signature."""
    from itertools import product
    rows = {}
    for bits in product((0, 1), repeat=len(inputs)):
        rows[bits] = tuple(fn(**dict(zip(inputs, bits))))
    return {"inputs": list(inputs), "outputs": list(outputs), "rows": rows}


def oracle_from_equations(exprs: dict, inputs: list | None = None,
                          outputs: list | None = None) -> dict:
    """Deterministic oracle from boolean equations {name: expr} (independent of the
    netlist -> cross-check catches wiring/logic hallucinations). Equations may include
    INTERNAL signals (an LHS referenced by another equation, e.g. s1 = a xor b); those are
    resolved in dependency order and are NOT reported as inputs or outputs."""
    from itertools import product
    trees = {o: boolexpr.parse(e) for o, e in exprs.items()}
    lhs = set(trees)
    referenced = set()
    for t in trees.values():
        boolexpr.variables(t, referenced)
    real_inputs = list(inputs) if inputs is not None else sorted(referenced - lhs)
    inset = set(real_inputs)
    internal = {o for o in lhs if o.startswith("_")} - inset   # "_name" = internal helper, not an output
    out_list = list(outputs) if outputs is not None else [o for o in trees if o not in internal]
    rows = {}
    for bits in product((0, 1), repeat=len(real_inputs)):
        env = dict(zip(real_inputs, bits))
        rem = dict(trees)
        for _ in range(len(rem) + 1):              # resolve internals in dependency order
            progressed = False
            for name, t in list(rem.items()):
                if boolexpr.variables(t, set()) <= set(env):
                    env[name] = boolexpr.eval_node(t, env); del rem[name]; progressed = True
            if not rem or not progressed:
                break
        rows[bits] = tuple(env.get(o, 0) for o in out_list)
    return {"inputs": real_inputs, "outputs": out_list, "rows": rows}


_EQ = re.compile(r"([A-Za-z_]\w*)\s*=\s*([^=;.\n]+)")


def extract_equations(spec: str, out_names: set | None = None) -> dict:
    """Pull `name = expr` boolean equations out of a spec. Keeps only ones that
    parse as boolean and (if given) whose LHS is an output name. `Sigma m(...)`
    style and unparseable RHS are skipped."""
    _OPS = {"and", "or", "xor", "not", "nand", "nor", "xnor",
            "+", "*", "^", "'", "~", "|", "&"}
    eqs = {}
    for lhs, rhs in _EQ.findall(spec):
        rhs = rhs.strip()
        if out_names is not None and lhs not in out_names:
            continue
        if "(" in rhs and re.search(r"[A-Za-z]\s*\(", rhs) and "xor" not in rhs.lower():
            # e.g. "f(a,b,c,d)" or "majority(a,b,c)" - a call, not a boolean expr
            if not re.match(r"\(", rhs):
                continue
        try:
            toks = boolexpr.tokenize(rhs)
            boolexpr.parse(rhs)
        except Exception:
            continue
        # PROSE GUARD: reject natural-language that merely happens to contain "name = ...".
        # A real boolean RHS with >1 token uses an explicit operator; prose ("1 when an
        # odd number of inputs are 1") is pure word juxtaposition. Also cap distinct
        # identifiers (prose has many words; equations reference a few signals).
        has_op = any(t.lower() in _OPS for t in toks)
        words = {t.lower() for t in toks if re.match(r"[A-Za-z_]\w*$", t) and t.lower() not in _OPS}
        if len(toks) > 1 and not has_op:
            continue
        if len(words) > 6:
            continue
        eqs[lhs] = rhs
    return eqs


def load_corpus_goldens() -> dict:
    """module-name -> intent_json, from verified lab items."""
    out = {}
    for f in sorted(LABS.glob("*.json")):
        d = json.load(open(f, encoding="utf-8"))
        items = d.get("items", []) if isinstance(d, dict) else d
        for it in items:
            sol = it.get("solution") or {}
            ij = sol.get("intent_json")
            cands = []
            if isinstance(ij, dict) and "components" in ij:
                cands = [ij]
            elif isinstance(ij, dict):
                cands = [v for v in ij.values() if isinstance(v, dict) and "components" in v]
            for c in cands:
                m = c.get("module")
                if m:
                    out[m] = c
    return out


def compare_to_oracle(intent: dict, oracle: dict) -> dict:
    """Equivalence by input/output NAME. Returns {ok, mismatches, checked}."""
    in_names, out_names, rows = table_signature(intent)
    if set(in_names) != set(oracle["inputs"]) or set(out_names) != set(oracle["outputs"]):
        return {"ok": False, "reason": "port names differ",
                "cand_inputs": in_names, "cand_outputs": out_names,
                "oracle_inputs": oracle["inputs"], "oracle_outputs": oracle["outputs"]}
    # reorder candidate columns to oracle order
    iperm = [in_names.index(n) for n in oracle["inputs"]]
    operm = [out_names.index(n) for n in oracle["outputs"]]
    mism = []
    for bits, obits in rows:
        key = tuple(bits[i] for i in iperm)
        got = tuple(obits[i] for i in operm)
        exp = oracle["rows"].get(key)
        if exp is not None and got != exp:
            mism.append({"in": dict(zip(oracle["inputs"], key)),
                         "got": got, "exp": exp})
    return {"ok": not mism, "mismatches": mism[:8], "checked": len(rows)}


# ---- the pipeline ---------------------------------------------------------
def run(spec: str, *, intent: dict | None = None, oracle: dict | None = None,
        module: str | None = None, use_rag: bool = True, use_llm: bool = True,
        use_cosim: bool = True, expect: list | None = None, cycles: int = 16,
        input_seq: list | None = None, use_synth: bool = False, synth_mode: str = "synth",
        use_editor: bool = False, endpoint=None, model=None, max_retries: int = 3,
        gen_mode: str = "auto", out_dir: str | None = None,
        on_stage=None, verbose: bool = True) -> dict:
    ev = []

    def log(stage, ok, **info):
        ev.append({"stage": stage, "ok": ok, **info})
        if on_stage:                       # live progress hook (SSE streaming)
            try:
                on_stage(stage, ok, {k: v for k, v in info.items() if k != 'context'})
            except Exception:
                pass
        if verbose:
            print(f"[{stage:9}] {'ok' if ok else 'FAIL'} " +
                  " ".join(f"{k}={v}" for k, v in info.items() if k != 'context'))

    # ---- obtain + gate, with a verify-driven RETRY loop for the LLM path ----
    # Prefer DETERMINISTIC synthesis: if the spec CLEANLY states COMBINATIONAL equations,
    # build from them (correct by construction). Guard against (a) sequential specs — prose
    # like "q2+=..., outputs c=q" extracts a degenerate partial set and must go to the LLM
    # instead; (b) an extraction that doesn't pass ERC — fall through to the LLM, don't
    # dead-end as a provided-but-broken intent.
    _SEQ_KW = ("clock", "flip-flop", "flipflop", "flip flop", "register", "counter",
               "state", "next-state", "next state", " fsm", "shift", "latch",
               "rising edge", "edge-trigger", "+=", "on each clock", "twisted-ring", "ring counter")
    if intent is None and spec and not any(k in spec.lower() for k in _SEQ_KW):
        try:
            from synth import synth_intent_from_equations
            eqs_all = extract_equations(spec)
            if eqs_all:
                cand = synth_intent_from_equations(eqs_all, module=module or "synth")
                cand["equations"] = eqs_all                 # -> readable VHDL too
                if validate_intent(cand)["ok"]:
                    intent = cand
                    log("generate", True, source="synth-from-equations", eqs=len(eqs_all))
                else:
                    log("generate", True, synth_skipped="ERC fail -> LLM")
        except Exception as e:
            log("generate", True, synth_skipped=str(e)[:40])
    provided = intent is not None
    n_try = 1 if (provided or not use_llm) else max(1, max_retries)
    ep = endpoint or __import__("intent_client").DEFAULT_ENDPOINT
    md = model or __import__("intent_client").DEFAULT_MODEL
    oracle_src = "explicit" if oracle else None
    feedback = []
    last = {"status": "REJECTED", "reason": "no result", "intent": None, "evidence": ev}

    for attempt in range(1, n_try + 1):
        # 2. obtain intent.  EQUATION-FIRST (default): the model emits boolean equations
        # (its most compact output), and we synthesize the gate netlist deterministically
        # (correct by construction). Topology-LLM is the fallback / when gen_mode="topology".
        temp = 0.1 + 0.2 * (attempt - 1)
        if provided:
            cur = intent
        else:
            cur = None
            if use_llm and gen_mode in ("auto", "equations"):
                try:
                    from intent_client import generate_equations
                    from synth import (synth_intent_from_equations,
                                       synth_intent_from_state_equations)
                    # escalate: fast no-think first pass, then let the model REASON on
                    # retry (much better on hard decomposition, at ~10-40x the latency).
                    ge = generate_equations(spec, endpoint=ep, model=md, use_rag=use_rag,
                                            temperature=temp, feedback=feedback,
                                            think=(attempt > 1), verbose=verbose)

                    def _keep(d):
                        out = {}
                        for k, e in (d or {}).items():
                            try:
                                boolexpr.parse(e); out[k] = e
                            except Exception:
                                pass
                        return out
                    ok_eqs = _keep(ge.get("outputs"))
                    ok_next = _keep(ge.get("next"))
                    regs = ge.get("registers") or []
                    mod = module or ge.get("module") or "synth"
                    if ok_eqs and regs and ok_next:                 # SEQUENTIAL (phase 2)
                        cur = synth_intent_from_state_equations(
                            ok_next, ok_eqs, regs, inputs=ge.get("inputs") or None, module=mod)
                        cur["equations"] = {"next": ok_next, "out": ok_eqs}
                        log("generate", True, source="llm-equations", seq=True,
                            regs=len(regs), attempt=attempt)
                    elif ok_eqs:                                    # combinational
                        cur = synth_intent_from_equations(
                            ok_eqs, module=mod, inputs=ge.get("inputs") or None)
                        cur["equations"] = ok_eqs                   # -> readable VHDL + provenance
                        log("generate", True, source="llm-equations", eqs=len(ok_eqs), attempt=attempt)
                except Exception as e:
                    log("generate", False, eq_error=str(e)[:60], attempt=attempt)
                if cur is None and gen_mode == "equations":
                    last = {"status": "REJECTED", "reason": "could not derive boolean equations",
                            "intent": None, "evidence": ev}
                    feedback = ["ออกสมการบูลีนต่อ output ให้ครบเป็น JSON ไม่ได้ ลองใหม่"]
                    continue
            if cur is None:                                  # topology path (fallback / explicit)
                from intent_client import generate_intent
                gi = generate_intent(spec, use_rag=use_rag, max_retries=max_retries,
                                     endpoint=ep, model=md, feedback=feedback,
                                     temperature=temp, verbose=verbose)
                cur = gi.get("intent")
                log("generate", bool(gi["ok"] and cur), source="llm-topology", attempt=attempt)
                if not gi["ok"] or not cur:
                    last = {"status": "REJECTED", "reason": "generation/validate failed",
                            "validation": gi.get("validation"), "intent": cur, "evidence": ev}
                    continue
        # 3. validate (ERC gate)
        v = validate_intent(cur)
        log("validate", v["ok"], errors=len(v["errors"]), warns=len(v["warns"]))
        if not v["ok"]:
            last = {"status": "REJECTED", "reason": "ERC failed", "errors": v["errors"],
                    "intent": cur, "evidence": ev}
            feedback = ["ERC ไม่ผ่าน แก้ให้ถูก:\n" + hints_for_retry(v)]
            if provided:
                return last
            continue
        seq = is_sequential(cur)
        # 4. simulate
        sequence = None
        rows = None
        try:
            if seq:
                n_cyc = len(input_seq) if input_seq else cycles
                sr = simulate_sequential(cur, cycles=n_cyc, input_seq=input_seq)
                ins, outs = sr["inputs"], sr["outputs"]
                sequence = [[r["cycle"], [r["out"][o] for o in outs]] for r in sr["rows"]]
                log("simulate", True, seq=True, cycles=len(sr["rows"]), dffs=len(sr["dffs"]))
            else:
                ins, outs, rows = truth_table(cur)
                log("simulate", True, inputs=len(ins), outputs=len(outs), rows=len(rows))
        except Exception as e:
            log("simulate", False, error=str(e)[:80])
            last = {"status": "REJECTED", "reason": "simulation failed: " + str(e),
                    "intent": cur, "evidence": ev}
            if provided:
                return last
            feedback = ["วงจรจำลองไม่ได้ (อาจมี loop ที่ไม่ผ่าน DFF): " + str(e)[:120]]
            continue
        # 5. verify
        verified = None
        if seq:
            if expect is not None:
                # weight each output bit by the trailing number in its name (c1->2, c0->1),
                # falling back to column index — so declaration order doesn't scramble the value.
                wts = [int(m.group(1)) if (m := re.search(r"(\d+)$", o)) else i
                       for i, o in enumerate(outs)]
                got = [sum(b << wts[j] for j, b in enumerate(row[1])) for row in sequence]
                exp = list(expect)[:len(got)]
                ok = got[:len(exp)] == exp
                verified = ok
                log("verify", ok, src="expected-sequence", checked=len(exp),
                    mismatches=sum(1 for a, b in zip(got, exp) if a != b))
                if not ok:
                    last = {"status": "REJECTED", "reason": "sequence mismatch", "got": got,
                            "expected": exp, "intent": cur, "sequence": sequence, "evidence": ev}
                    feedback = [f"ลำดับ output ผิด: ได้ {got[:len(exp)]} ควรเป็น {exp}. แก้ตรรกะ next-state (d ของ DFF)."]
                    if provided or attempt == n_try:
                        return last
                    continue
            else:
                log("verify", True, note="no-oracle-unverified(seq)")
            intent = cur
            return _finish(cur, module, ins, outs, rows, sequence, verified,
                           use_cosim, cycles, out_dir, ev, log, spec, verbose, input_seq, use_synth, synth_mode, use_editor)
        # combinational: resolve oracle (once) then verify
        if oracle is None:
            oracle, oracle_src = _resolve_oracle(cur, spec, module, use_llm, ep, md)
        if oracle:
            cmp = compare_to_oracle(cur, oracle)
            verified = cmp["ok"]
            log("verify", cmp["ok"], src=oracle_src, checked=cmp.get("checked"),
                mismatches=len(cmp.get("mismatches", [])))
            if not cmp["ok"]:
                last = {"status": "REJECTED", "reason": "oracle mismatch", "compare": cmp,
                        "intent": cur, "evidence": ev}
                feedback = [_mismatch_feedback(cmp)]
                if provided or attempt == n_try:
                    return last
                continue
        else:
            log("verify", True, note="no-oracle-unverified")
        intent = cur
        return _finish(cur, module, ins, outs, rows, sequence, verified,
                       use_cosim, cycles, out_dir, ev, log, spec, verbose, None, use_synth, synth_mode, use_editor)
    return last


def _resolve_oracle(intent, spec, module, use_llm, ep, md):
    """(oracle, src) from: corpus golden (by module) > spec equations > LLM-derived
    equations (independent representation for cross-check)."""
    if module:
        g = load_corpus_goldens().get(module)
        if isinstance(g, dict) and "components" in g:
            gi_ins, gi_outs, gi_rows = table_signature(g)
            return _sig_from_rows(gi_ins, gi_outs, gi_rows), "corpus-golden"
    in_names = [(c.get("name") or c["id"]) for c in intent.get("components", []) if c.get("type") == "IN"]
    out_names = [(c.get("name") or c["id"]) for c in intent.get("components", []) if c.get("type") == "OUT"]
    if spec:
        # include INTERNAL signals (s1 = a xor b …) so shared-subexpression specs verify;
        # the oracle resolves them and reports only the real outputs.
        eqs_all = extract_equations(spec)
        eqs = {k: v for k, v in eqs_all.items() if k in set(out_names)}
        if eqs:
            # pull in any internal equations the kept outputs depend on
            need = set()
            for e in eqs.values():
                boolexpr.variables(boolexpr.parse(e), need)
            for k, v in eqs_all.items():
                if k in need and k not in eqs:
                    eqs[k] = v
            try:
                return (oracle_from_equations(eqs, inputs=in_names, outputs=out_names),
                        "spec-equations:" + ",".join(out_names))
            except Exception:
                pass
    if use_llm and spec:
        try:
            from intent_client import derive_equations
            eqs = derive_equations(spec, in_names, out_names, endpoint=ep, model=md)
            ok_eqs = {}
            for o, e in eqs.items():
                try:
                    if boolexpr.variables(boolexpr.parse(e)) <= set(in_names):
                        ok_eqs[o] = e
                except Exception:
                    pass
            if ok_eqs:
                return oracle_from_equations(ok_eqs, inputs=in_names), "llm-derived-equations:" + ",".join(ok_eqs)
        except Exception:
            pass
    return None, None


def _mismatch_feedback(cmp: dict) -> str:
    rows = cmp.get("mismatches", [])[:6]
    lines = [f"  {m['in']} -> วงจรให้ {m['got']} แต่ต้องเป็น {m['exp']}" for m in rows]
    return ("ผลลัพธ์ไม่ตรงสเปคที่อินพุตต่อไปนี้ (แก้ตรรกะ/สมการให้ถูก, "
            "อย่าเปลี่ยนชื่อขา):\n" + "\n".join(lines))


def _finish(intent, module, ins, outs, rows, sequence, verified,
            use_cosim, cycles, out_dir, ev, log, spec, verbose=True, input_seq=None,
            use_synth=False, synth_mode="synth", use_editor=False):
    # 6. codegen (deterministic)
    vhdl = generate_vhdl(intent, entity=module or intent.get("module"))
    log("codegen", True, vhdl_lines=vhdl.count("\n"))
    # 6b. co-sim on GHDL (bit-for-bit vs netlist_sim; combinational or clocked)
    cosim_ok = None
    n_cyc = len(sequence) if sequence is not None else cycles
    if use_cosim:
        try:
            from cosim import cosim as _cosim
            cs = _cosim(intent, entity=module or intent.get("module"),
                        cycles=n_cyc, input_seq=input_seq)
            if cs.get("error"):
                log("cosim", True, skipped=cs["error"][:40])
            else:
                cosim_ok = cs["ok"]
                log("cosim", cs["ok"], checked=cs.get("checked"),
                    mismatches=len(cs.get("mismatches", [])))
                if not cs["ok"]:
                    return {"status": "REJECTED", "reason": "cosim mismatch (codegen bug)",
                            "cosim": cs, "intent": intent, "vhdl": vhdl, "evidence": ev}
        except Exception as e:
            log("cosim", True, skipped=str(e)[:40])
    # 6b2. (optional) hand the topology to the gate EDITOR's own engine so it draws
    #      + routes (master router) and saves a native .schproj.json — the AI→drawing
    #      bridge (geometry from the editor, never the LLM).
    draw_res = None
    if use_editor:
        try:
            from push_to_editor import draw_intent
            de = draw_intent(intent, name=module or intent.get("module"))
            draw_res = {k: de.get(k) for k in ("ok", "guarantees", "schproj", "comps", "wires")}
            log("draw", bool(de.get("ok")), guarantees=de.get("guarantees"))
        except Exception as e:
            log("draw", True, skipped=str(e)[:50])
    # 6c. (optional) real-toolchain synthesis on Vivado — confirms synthesizable
    #     on xc7s15 (and can build a .bit). Best-effort: off by default (slow), and
    #     skips gracefully if Vivado/its signature check is unavailable here.
    synth_res = None
    if use_synth:
        try:
            from synth_vivado import synth as _vsynth
            sv = _vsynth(intent, entity=module or intent.get("module"), mode=synth_mode)
            synth_res = {k: sv.get(k) for k in ("ok", "utilization", "bitstream", "errors")}
            log("synth", bool(sv.get("ok")), util=sv.get("utilization"),
                bit=bool(sv.get("bitstream")), err=len(sv.get("errors") or []))
        except Exception as e:
            log("synth", True, skipped=str(e)[:50])
    # 7. gate + confidence (abstain when we could not verify the logic)
    status = "VERIFIED" if verified else "VALID_UNVERIFIED"
    if verified and cosim_ok:
        confidence, recommend = 1.0, "accept"          # oracle + real simulator agree
    elif verified:
        confidence, recommend = 0.85, "accept"         # oracle agrees (no cosim run)
    else:
        confidence, recommend = 0.4, "review"          # no oracle -> logic UNVERIFIED, human check
    res = {"status": status, "intent": intent, "vhdl": vhdl,
           "verified": bool(verified), "cosim": cosim_ok, "synth": synth_res,
           "draw": draw_res, "confidence": confidence, "recommend": recommend,
           "evidence": ev}
    if rows is not None:
        res["truth_table"] = {"inputs": ins, "outputs": outs,
                              "rows": [[list(b), list(o)] for b, o in rows]}
    if sequence is not None:
        res["sequence"] = {"outputs": outs, "rows": sequence}
    # constraints for the real board (pin map)
    try:
        from gen_xdc import generate_xdc
        xr = generate_xdc(intent)
        res["xdc"] = xr["xdc"]
        if xr["warnings"]:
            log("constraints", True, warns=len(xr["warnings"]))
    except Exception as e:
        log("constraints", True, skipped=str(e)[:40])
    if out_dir:
        base = _safe(module or intent.get("module") or "design")
        top = _safe(module or intent.get("module") or "design")
        d = Path(out_dir); d.mkdir(parents=True, exist_ok=True)
        (d / (base + ".vhd")).write_text(vhdl, encoding="utf-8")
        res["vhdl_path"] = str(d / (base + ".vhd"))
        if res.get("xdc"):
            (d / (base + ".xdc")).write_text(res["xdc"], encoding="utf-8")
            res["xdc_path"] = str(d / (base + ".xdc"))
        # preserve the bitstream (Vivado work dir is temporary)
        bit = (res.get("synth") or {}).get("bitstream")
        if bit and Path(bit).exists():
            import shutil
            shutil.copy2(bit, d / (base + ".bit"))
            res["bitstream_path"] = str(d / (base + ".bit"))
        # turnkey Vivado build script -> hand off to FPGA_Builder / Vivado for the .bit
        tcl = (f"# build {top} for EDGE Spartan-7 (xc7s15ftgb196-1)\n"
               f"read_vhdl {base}.vhd\n"
               + (f"read_xdc {base}.xdc\n" if res.get("xdc") else "")
               + f"synth_design -top {top} -part xc7s15ftgb196-1\n"
               "opt_design\nplace_design\nroute_design\n"
               f"write_bitstream -force {base}.bit\n")
        (d / (base + "_build.tcl")).write_text(tcl, encoding="utf-8")
        res["build_tcl_path"] = str(d / (base + "_build.tcl"))
        if verbose:
            print("  wrote", base + ".vhd", "+ .xdc + _build.tcl")
    return res


def _safe(s):
    import re
    return re.sub(r"\W", "_", str(s)).strip("_").lower() or "design"


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("spec", nargs="*")
    ap.add_argument("--intent", help="path to an intent json (offline, skip LLM)")
    ap.add_argument("--module")
    ap.add_argument("--no-rag", action="store_true")
    ap.add_argument("--out")
    a = ap.parse_args()
    intent = json.load(open(a.intent, encoding="utf-8")) if a.intent else None
    r = run(" ".join(a.spec), intent=intent, module=a.module,
            use_rag=not a.no_rag, use_llm=intent is None, out_dir=a.out)
    print("\nSTATUS:", r["status"])
    if r.get("vhdl"):
        print("\n" + r["vhdl"])
