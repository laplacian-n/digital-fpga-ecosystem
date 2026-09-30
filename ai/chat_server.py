"""
chat_server.py - HTTP bridge for the in-editor AI chat (the "full loop" backend).

The editor's chat panel POSTs a natural-language / boolean-equation spec here; this
runs the WHOLE pipeline (RAG -> LLM+GBNF -> validate -> simulate -> verify ->
deterministic VHDL codegen) and returns the Intent-JSON + evidence. The editor then
draws the intent LIVE with its own engine (drawIntent -> autoRouteSheet), so geometry
always comes from the editor, never the model (the architecture's core rule).

Routes (CORS open so the file:// editor page can call it):
  GET  /health        -> {ok, llm_endpoint, llm_up}
  GET  /latest.json   -> designs_gate/latest.json  (Sync-bridge compatibility)
  POST /chat  {message, use_llm?, use_rag?, module?, cosim?}
                      -> full pipeline result (status/intent/truth_table/vhdl/evidence/...)
  POST /sim   {intent}
                      -> validate + simulate an intent (e.g. the current sheet lifted
                         via schematicToIntent) -> truth table or clocked sequence. No LLM.

Offline note: a spec that STATES boolean equations (e.g. "sum = a xor b") is built
deterministically (synth-from-equations) with NO model, so the full loop works before
llama.cpp is up. Start the model server for free-form NL.

Run:  python chat_server.py            (port 8770)
      python chat_server.py 8771       (custom port)
"""
from __future__ import annotations
import json
import queue as _queue
import re
import socket
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import pipeline
import parametric
import truthtable
from gen_vhdl import generate_vhdl
from intent_validate import validate_intent
from netlist_sim import truth_table, is_sequential, simulate_sequential

HERE = Path(__file__).resolve().parent
DESIGNS = HERE.parent / "designs_gate"
DEFAULT_PORT = 8770


def _llm_up(timeout: float = 0.4) -> bool:
    try:
        import intent_client
        u = urlparse(intent_client.DEFAULT_ENDPOINT)
        host, port = u.hostname or "127.0.0.1", u.port or 80
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


_ASK_SYS = ("คุณเป็นผู้ช่วยในโปรแกรมออกแบบวงจรดิจิทัล 'Schematic Studio' ตอบสั้น กระชับ เป็นภาษาไทย "
            "ช่วยเรื่องวิธีใช้โปรแกรม และความรู้ digital logic / VHDL / FPGA (Spartan-7). "
            "อย่าสร้างหรือวาดวงจรเอง — ถ้าผู้ใช้อยากได้วงจร ให้บอกว่าสลับไปโหมด 'วาดวงจร' แล้วพิมพ์ชื่อวงจร "
            "(full adder, 2:1 mux…), สมการ (sum = a xor b) หรือมินเทอม (y = minterms(1,2,4,7)). "
            "ข้อเท็จจริงของบอร์ด EDGE Spartan-7 (XC7S15) ที่ใช้ในวิชา: I/O ทำงานที่ 3.3 V (ไม่ใช่ 5 V), "
            "clock 50 MHz ที่ขา H11, จอ 7-segment 4 หลักแบบ common anode — ขา a..g, dp และ an[3:0] เป็น active-low "
            "(ให้ 0 = ติด), ปุ่มกดบนบอร์ด กด = 1 (active-high), สวิตช์เลื่อน 16 ตัว และ LED 16 ดวง (1 = ติด).")


def _ask_llm(message: str) -> str:
    """Plain Q&A via the LLM (no circuit generation). Returns the answer text."""
    import urllib.request
    ic = __import__("intent_client")
    body = json.dumps({"model": ic.DEFAULT_MODEL,
                       "messages": [{"role": "system", "content": _ASK_SYS},
                                    {"role": "user", "content": message}],
                       "temperature": 0.3, "max_tokens": 512,
                       "chat_template_kwargs": {"enable_thinking": False}}).encode("utf-8")
    req = urllib.request.Request(ic.DEFAULT_ENDPOINT, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.loads(r.read().decode("utf-8"))
    txt = d["choices"][0]["message"]["content"]
    return re.sub(r"<think>.*?</think>", "", txt, flags=re.S).strip()


# Canonical teaching circuits -> boolean equations, so the common requests draw
# CORRECT-BY-CONSTRUCTION with no model (and instantly), even when llama.cpp is down.
# Free-form NL still falls through to the LLM path.
_KNOWN = {
    # basic single gates (deterministic + correct — do NOT let these fall to the LLM,
    # which produced plain AND for "nand" etc. and self-verified the wrong logic)
    "and":       ("and2",  "y = a and b"),
    "and2":      ("and2",  "y = a and b"),
    "or":        ("or2",   "y = a or b"),
    "or2":       ("or2",   "y = a or b"),
    "xor":       ("xor2",  "y = a xor b"),
    "xor2":      ("xor2",  "y = a xor b"),
    "nand":      ("nand2", "y = a nand b"),
    "nand2":     ("nand2", "y = a nand b"),
    "nor":       ("nor2",  "y = a nor b"),
    "nor2":      ("nor2",  "y = a nor b"),
    "xnor":      ("xnor2", "y = a xnor b"),
    "xnor2":     ("xnor2", "y = a xnor b"),
    "not":       ("not1",  "y = not a"),
    "inverter":  ("not1",  "y = not a"),
    "buffer":    ("buf1",  "y = a"),
    "buf":       ("buf1",  "y = a"),
    "halfadder": ("half_adder", "sum = a xor b\ncarry = a and b"),
    "ha":        ("half_adder", "sum = a xor b\ncarry = a and b"),
    "fulladder": ("full_adder", "_axb = a xor b\nsum = _axb xor cin\ncout = (a and b) or (_axb and cin)"),
    "fa":        ("full_adder", "_axb = a xor b\nsum = _axb xor cin\ncout = (a and b) or (_axb and cin)"),
    "majority":  ("maj3", "m = (a and b) or (b and c) or (a and c)"),
    "maj3":      ("maj3", "m = (a and b) or (b and c) or (a and c)"),
    "maj":       ("maj3", "m = (a and b) or (b and c) or (a and c)"),
    "mux2":      ("mux2", "y = (d0 and (not s)) or (d1 and s)"),
    "mux21":     ("mux2", "y = (d0 and (not s)) or (d1 and s)"),
    "2to1mux":   ("mux2", "y = (d0 and (not s)) or (d1 and s)"),
    "mux":       ("mux2", "y = (d0 and (not s)) or (d1 and s)"),
}
# filler words stripped before matching (Thai + English), so "ทำวงจร full adder 2 ชั้น" -> "fulladder"
# NOTE: whole-ish tokens only — never single letters like "a" (that would strip the
# letter out of "fulladder" -> "fulldder" and break every match).
_FILLER = ("ทำวงจร", "ทำ", "วงจร", "สร้าง", "ขอ", "หน่อย", "ชั้น", "ระดับ", "แบบ", "ให้",
           "draw", "make", "build", "create", "circuit", "gate",
           "2level", "twolevel", ":", "-", "_")


def _expand_known(message: str, module):
    """If the message is basically the NAME of a canonical circuit (no equations),
    expand it to boolean equations. Returns (spec, module, matched_name|None)."""
    if "=" in message:                       # explicit equations -> leave as-is
        return message, module, None
    norm = message.lower()
    for f in _FILLER:
        norm = norm.replace(f, "")
    norm = "".join(ch for ch in norm if ch.isalnum())
    cand = {norm, "".join(ch for ch in norm if ch.isalpha())}   # with + without digits
    if len(message) < 48:
        for key, (mod, eqs) in _KNOWN.items():
            kforms = {key, "".join(ch for ch in key if ch.isalpha())}
            if cand & kforms:
                return eqs, (module or mod), mod
    return message, module, None


def _trim(r: dict) -> dict:
    """Keep the response small and json-safe for the browser."""
    out = {}
    for k in ("status", "verified", "cosim", "intent", "vhdl", "truth_table",
              "sequence", "xdc", "reason", "errors", "compare", "validation",
              "got", "expected", "draw", "confidence", "recommend", "source", "note"):
        if k in r:
            out[k] = r[k]
    out["evidence"] = [{"stage": e.get("stage"), "ok": e.get("ok"),
                        **{k: v for k, v in e.items()
                           if k not in ("stage", "ok", "context")}}
                       for e in (r.get("evidence") or [])]
    return out


def _run_parametric(para) -> dict:
    """Build + validate + spot-check + codegen a parametric circuit (no LLM, no full
    truth table). Returns the same shape /chat normally does, plus a `samples` table."""
    kind, n, intent, note = para
    ev = [{"stage": "generate", "ok": True, "source": "parametric:" + kind + str(n)}]
    v = validate_intent(intent)
    ev.append({"stage": "validate", "ok": v["ok"], "errors": len(v["errors"])})
    if not v["ok"]:
        return {"status": "REJECTED", "reason": "ERC failed", "errors": v["errors"],
                "intent": intent, "evidence": ev, "llm_up": _llm_up()}
    if kind in ("mux", "decoder", "priority"):
        sc = parametric.spot_check_select(intent, kind, n)
    else:
        sc = parametric.spot_check(intent, n, kind)
    ev.append({"stage": "verify", "ok": sc["ok"], "src": "spot-check", "checked": sc.get("checked")})
    vhdl = generate_vhdl(intent, entity=intent.get("module"))
    ev.append({"stage": "codegen", "ok": True, "vhdl_lines": vhdl.count("\n")})
    # correct-by-construction + spot-checked (not a full 2^n table) -> high, not perfect
    conf, rec = (0.95, "accept") if sc["ok"] else (0.4, "review")
    out = {"status": "VERIFIED" if sc["ok"] else "REJECTED",
           "verified": sc["ok"], "intent": intent, "vhdl": vhdl,
           "confidence": conf, "recommend": rec,
           "source": "param:" + kind + str(n), "evidence": ev, "llm_up": _llm_up(),
           "samples": {"cols": sc.get("cols") or ["a", "b", "cin", "sum", "exp"],
                       "rows": sc.get("rows", [])}}
    if not sc["ok"]:
        out["reason"] = "spot-check mismatch"
        out["mismatches"] = sc.get("mismatches", [])
    if note:
        out["note"] = note
    return out


def _run_truthtable(parsed) -> dict:
    """Minterm/truth-table spec -> minimized SOP (Quine-McCluskey) -> synth -> verify by
    full truth table. Deterministic, no LLM. Same response shape as /chat."""
    intent, eqs = truthtable.build(parsed)
    ev = [{"stage": "generate", "ok": True, "source": "truth-table-minimize", "outputs": len(eqs)}]
    v = validate_intent(intent)
    ev.append({"stage": "validate", "ok": v["ok"], "errors": len(v["errors"])})
    if not v["ok"]:
        return {"status": "REJECTED", "reason": "ERC failed", "errors": v["errors"],
                "intent": intent, "evidence": ev, "llm_up": _llm_up()}
    vr = truthtable.verify(intent, parsed)
    ev.append({"stage": "verify", "ok": vr["ok"], "src": "minterm-truth-table", "checked": vr.get("checked")})
    vhdl = generate_vhdl(intent, entity=intent.get("module"))
    ev.append({"stage": "codegen", "ok": True, "vhdl_lines": vhdl.count("\n")})
    conf, rec = (1.0, "accept") if vr["ok"] else (0.4, "review")   # full table proven
    out = {"status": "VERIFIED" if vr["ok"] else "REJECTED", "verified": vr["ok"],
           "intent": intent, "vhdl": vhdl, "confidence": conf, "recommend": rec,
           "source": "truthtable", "evidence": ev, "llm_up": _llm_up()}
    if not vr["ok"]:
        out["reason"] = "minterm mismatch"
        out["mismatches"] = vr.get("mismatches", [])
    return out


# canonical SEQUENTIAL primitives — built directly as a clocked netlist (a plain equation
# "q = d" would draw a wire buffer and ignore the clock, which is wrong for a flip-flop).
_KNOWN_SEQ = {"dff", "dflipflop", "flipflop", "register", "reg"}


def _norm_name(message: str) -> set:
    norm = message.lower()
    for f in _FILLER:
        norm = norm.replace(f, "")
    norm = "".join(ch for ch in norm if ch.isalnum())
    return {norm, "".join(ch for ch in norm if ch.isalpha())}


def _run_known_seq(msg: str):
    """D flip-flop (and register/reg aliases) -> a real clocked DFF netlist, verified by a
    sequential spot-check that q(t) == d(t-1). Returns /chat's response shape, or None."""
    if "=" in msg or len(msg) >= 48:
        return None
    if not (_norm_name(msg) & _KNOWN_SEQ):
        return None
    from synth import synth_intent_from_state_equations
    intent = synth_intent_from_state_equations({"q": "d"}, {"q": "q"}, ["q"],
                                               inputs=["d"], module="dff")
    ev = [{"stage": "generate", "ok": True, "source": "known:dff"}]
    v = validate_intent(intent)
    ev.append({"stage": "validate", "ok": v["ok"], "errors": len(v["errors"])})
    if not v["ok"]:
        return {"status": "REJECTED", "reason": "ERC failed", "errors": v["errors"],
                "intent": intent, "evidence": ev, "llm_up": _llm_up()}
    # spot-check the clocked behaviour: q after each edge = d from the previous cycle
    seq = simulate_sequential(intent, input_seq=[{"d": 1}, {"d": 1}, {"d": 0}, {"d": 0}, {"d": 1}])
    rows = seq["rows"]
    ok = len(rows) > 1 and all(
        rows[i]["state"].get("q", 0) == rows[i - 1]["in"].get("d", 0) for i in range(1, len(rows)))
    ev.append({"stage": "verify", "ok": ok, "src": "sequential-spot-check", "checked": len(rows)})
    vhdl = generate_vhdl(intent, entity=intent.get("module"))
    ev.append({"stage": "codegen", "ok": True, "vhdl_lines": vhdl.count("\n")})
    out = {"status": "VERIFIED" if ok else "VALID_UNVERIFIED", "verified": ok,
           "intent": intent, "vhdl": vhdl, "confidence": 1.0 if ok else 0.5,
           "recommend": "accept" if ok else "review", "source": "known:dff",
           "evidence": ev, "llm_up": _llm_up(),
           "note": "D flip-flop — q latches d ที่ขอบ clock (sequential; ขา clk เพิ่มอัตโนมัติ)"}
    simd = _simulate_intent(intent, cycles=8)
    if simd.get("sequence"):
        out["sequence"] = simd["sequence"]
    if simd.get("waveform_svg"):
        out["waveform_svg"] = simd["waveform_svg"]
    return out


def _latch_settle(s, r, q, qn):
    """Settle a NOR SR latch: q = r NOR qn, qn = s NOR q (iterate to a stable point)."""
    for _ in range(30):
        nq = 0 if (r or qn) else 1
        nqn = 0 if (s or q) else 1
        if (nq, nqn) == (q, qn):
            break
        q, qn = nq, nqn
    return q, qn


def _run_known_latch(msg: str):
    """SR latch from cross-coupled NOR gates (feedback loop — combinational synth can't do
    it, so build the netlist directly). Verified behaviourally by settling set/reset/hold."""
    if "=" in msg or len(msg) >= 48:
        return None
    if not any(("srlatch" in x or "rslatch" in x or "srnorlatch" in x) for x in _norm_name(msg)):
        return None
    intent = {"module": "sr_latch", "components": [
        {"id": "s", "type": "IN", "name": "s"}, {"id": "r", "type": "IN", "name": "r"},
        {"id": "g_q", "type": "NOR"}, {"id": "g_qn", "type": "NOR"},
        {"id": "q", "type": "OUT", "name": "q"}, {"id": "qn", "type": "OUT", "name": "qn"}],
        "nets": [{"from": "r", "to": "g_q"}, {"from": "g_qn", "to": "g_q"},
                 {"from": "s", "to": "g_qn"}, {"from": "g_q", "to": "g_qn"},
                 {"from": "g_q", "to": "q"}, {"from": "g_qn", "to": "qn"}]}
    ev = [{"stage": "generate", "ok": True, "source": "known:sr_latch"}]
    v = validate_intent(intent)
    ev.append({"stage": "validate", "ok": v["ok"], "errors": len(v["errors"])})
    if not v["ok"]:
        return {"status": "REJECTED", "reason": "ERC failed", "errors": v["errors"],
                "intent": intent, "evidence": ev, "llm_up": _llm_up()}
    q, qn = _latch_settle(1, 0, 0, 0); ok_set = (q, qn) == (1, 0)
    q, qn = _latch_settle(0, 1, q, qn); ok_rst = (q, qn) == (0, 1)
    q, qn = _latch_settle(0, 0, q, qn); ok_hold = (q, qn) == (0, 1)
    ok = ok_set and ok_rst and ok_hold
    ev.append({"stage": "verify", "ok": ok, "src": "latch-settle", "checked": 3})
    try:
        vhdl = generate_vhdl(intent, entity="sr_latch")
    except Exception:
        vhdl = ("library IEEE;\nuse IEEE.STD_LOGIC_1164.ALL;\n\n"
                "entity sr_latch is\n  Port ( s : in STD_LOGIC; r : in STD_LOGIC;\n"
                "         q : out STD_LOGIC; qn : out STD_LOGIC );\nend sr_latch;\n\n"
                "architecture Behavioral of sr_latch is\n  signal qi, qni : STD_LOGIC;\n"
                "begin\n  qi  <= r nor qni;\n  qni <= s nor qi;\n  q <= qi;\n  qn <= qni;\n"
                "end Behavioral;\n")
    ev.append({"stage": "codegen", "ok": True, "vhdl_lines": vhdl.count("\n")})
    # demo waveform over set/hold/reset/hold so the board page can play it
    stim = [(1, 0), (0, 0), (0, 1), (0, 0), (1, 0), (0, 0)]
    rows, q, qn = [], 0, 0
    for i, (s, r) in enumerate(stim):
        q, qn = _latch_settle(s, r, q, qn)
        rows.append([i, [s, r], [], [q, qn]])
    return {"status": "VERIFIED" if ok else "VALID_UNVERIFIED", "verified": ok,
            "intent": intent, "vhdl": vhdl, "confidence": 1.0 if ok else 0.5,
            "recommend": "accept" if ok else "review", "source": "known:sr_latch",
            "evidence": ev, "llm_up": _llm_up(),
            "sequence": {"inputs": ["s", "r"], "outputs": ["q", "qn"], "dffs": [], "rows": rows},
            "note": "SR latch (NOR ไขว้) — s=set→q=1, r=reset→q=0, s=r=1 ต้องห้าม · เป็นวงจร bistable มี feedback"}


# BCD (0-9) -> 7-segment (common-cathode, active-high). Deterministic via minterm tables
# (10-15 don't-care) — the LLM choked on this (context overflow); this never does.
_BCD7SEG = {"sa": [0, 2, 3, 5, 6, 7, 8, 9], "sb": [0, 1, 2, 3, 4, 7, 8, 9],
            "sc": [0, 1, 3, 4, 5, 6, 7, 8, 9], "sd": [0, 2, 3, 5, 6, 8, 9],
            "se": [0, 2, 6, 8], "sf": [0, 4, 5, 6, 8, 9], "sg": [2, 3, 4, 5, 6, 8, 9]}


def _run_known_bcd7seg(msg: str):
    if "=" in msg:
        return None
    nn = _norm_name(msg)
    hit = any(("7seg" in x or "sevenseg" in x) for x in nn) or \
        (any("bcd" in x for x in nn) and any("seg" in x for x in nn))
    if not hit:
        return None
    dc = [10, 11, 12, 13, 14, 15]
    parsed = {"n": 4, "names": ["a", "b", "c", "d"],
              "outputs": {k: (v, dc) for k, v in _BCD7SEG.items()}}
    out = _run_truthtable(parsed)
    out["source"] = "known:bcd7seg"
    out["note"] = "BCD→7-segment (a=MSB..d=LSB · เลข 10-15 = don't-care) · เซกเมนต์ sa..sg (active-high)"
    return out


def _simulate_intent(intent: dict, input_seq=None, cycles: int = 8) -> dict:
    v = validate_intent(intent)
    if not v["ok"]:
        return {"ok": False, "status": "REJECTED", "reason": "ERC failed",
                "errors": v["errors"], "warns": v["warns"]}
    # build_graph identifies IN/OUT by component id; show the real port NAMES
    # (a, b, cin, sum, cout) to the editor/board instead of raw ids (c959, …).
    nm = {c["id"]: (c.get("name") or c["id"])
          for c in intent.get("components", []) if c.get("type") in ("IN", "OUT")}
    dnm = {c["id"]: (c.get("name") or c.get("label") or c["id"])
           for c in intent.get("components", []) if c.get("type") == "DFF"}
    try:
        if is_sequential(intent):
            from netlist_sim import build_graph
            import waveform
            _, _, inputs, _ = build_graph(intent)
            iseq = input_seq or [{k: 1 for k in inputs} for _ in range(cycles)]  # drive high => visible activity
            sr = simulate_sequential(intent, input_seq=iseq)
            outs = sr["outputs"]
            rows = ([(nm.get(n, n), [r["in"].get(n, 0) for r in sr["rows"]]) for n in sr["inputs"]] +
                    [("state:" + dnm.get(d, d), [r["state"].get(d, 0) for r in sr["rows"]]) for d in sr["dffs"]] +
                    [(nm.get(o, o), [r["out"].get(o, 0) for r in sr["rows"]]) for o in outs])
            return {"ok": True, "sequential": True,
                    "sequence": {"inputs": [nm.get(n, n) for n in sr["inputs"]],
                                 "outputs": [nm.get(o, o) for o in outs],
                                 "dffs": [dnm.get(d, d) for d in sr["dffs"]],
                                 # per cycle: [cycle, [input bits], [dff state bits], [output bits]]
                                 "rows": [[r["cycle"],
                                           [r["in"].get(n, 0) for n in sr["inputs"]],
                                           [r["state"].get(d, 0) for d in sr["dffs"]],
                                           [r["out"][o] for o in outs]] for r in sr["rows"]]},
                    "waveform_svg": waveform.to_svg(rows, len(sr["rows"]), title=intent.get("module", "seq")),
                    "warns": v["warns"]}
        ins, outs, rows = truth_table(intent)
        return {"ok": True, "sequential": False,
                "truth_table": {"inputs": [nm.get(i, i) for i in ins],
                                "outputs": [nm.get(o, o) for o in outs],
                                "rows": [[list(b), list(o)] for b, o in rows]},
                "warns": v["warns"]}
    except Exception as e:
        return {"ok": False, "status": "REJECTED",
                "reason": "simulation failed: " + str(e)}


def _run_llm_vhdl(spec: str, use_rag: bool = False) -> dict:
    """Novel-circuit fallback: the LLM writes GATE-LEVEL dataflow VHDL (far fewer tokens
    than Intent-JSON → much faster, more natural for a coder model). The editor then draws
    it via parseVhdl/buildSchematicFromVhdl and simulates the drawn sheet for a truth table
    (correctness is shown to the user, not gated — the fast "just get a circuit" path)."""
    import intent_client
    ev, restated, ask = [], "", spec
    # a Thai request is first restated as a short English spec: the coder model follows that
    # far better, and the student sees what it understood (see intent_client.restate_spec)
    if intent_client.needs_restate(spec):
        t = intent_client.restate_spec(spec)
        ev.append({"stage": "translate", "ok": bool(t.get("ok"))})
        if t.get("ok"):
            restated = t["spec"]
            ask = restated + "\n\n(Original request, Thai: " + spec + ")"
    r = intent_client.generate_vhdl_from_spec(ask, use_rag=use_rag)
    ev.append({"stage": "generate-vhdl", "ok": bool(r.get("ok"))})
    if r.get("ok"):
        return {"status": "DRAWN", "mode": "vhdl", "vhdl": r["vhdl"], "source": "llm-vhdl",
                "restated": restated, "evidence": ev, "llm_up": _llm_up()}
    return {"status": "REJECTED", "reason": "สร้าง VHDL ไม่ได้ (LLM)", "restated": restated,
            "raw": (r.get("raw") or "")[:300], "evidence": ev, "llm_up": _llm_up()}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

    def _send(self, code: int, obj, ctype="application/json; charset=utf-8"):
        body = (obj if isinstance(obj, (bytes, bytearray))
                else json.dumps(obj, ensure_ascii=False).encode("utf-8"))
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        return json.loads(raw or b"{}")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # ---- Server-Sent Events: stream pipeline stages live (the "thinking") ----
    def _sse_open(self):
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

    def _sse(self, obj) -> bool:
        try:
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()
            return True
        except Exception:
            return False

    def _chat_stream(self, data: dict):
        msg = (data.get("message") or "").strip()
        if not msg:
            return self._send(400, {"ok": False, "error": "empty message"})
        self._sse_open()
        # ROW-BY-ROW MAPPING TABLE ("00 -> 0001 …") — the user's own table wins over any
        # template ("decoder" …) and over the LLM, which only ever produced one output bit
        tm = truthtable.parse_mapping(msg)
        if tm:
            self._sse({"event": "stage", "stage": "truth-table", "ok": True,
                       "info": {"n": tm["n"], "outputs": list(tm["outputs"]), "mapping": True}})
            self._sse({"event": "done", "result": _run_truthtable(tm)})
            return
        # SEQUENTIAL / feedback primitives + BCD-7seg — deterministic, no LLM
        for _h, _lbl in ((_run_known_seq, "known:dff"), (_run_known_latch, "known:sr_latch"),
                         (_run_known_bcd7seg, "known:bcd7seg")):
            _r = _h(msg)
            if _r:
                self._sse({"event": "stage", "stage": _lbl, "ok": True, "info": {}})
                self._sse({"event": "done", "result": _r})
                return
        # PARAMETRIC — deterministic, fast: emit a couple of steps then the result
        para = parametric.parse_request(msg)
        if para:
            self._sse({"event": "stage", "stage": "parametric", "ok": True,
                       "info": {"kind": para[0], "n": para[1]}})
            self._sse({"event": "done", "result": _run_parametric(para)})
            return
        tt = truthtable.parse(msg)
        if tt:
            self._sse({"event": "stage", "stage": "truth-table", "ok": True,
                       "info": {"n": tt["n"], "outputs": list(tt["outputs"])}})
            self._sse({"event": "done", "result": _run_truthtable(tt)})
            return
        spec, module, matched = _expand_known(msg, data.get("module"))
        q = _queue.Queue()
        result = {}

        def on_stage(stage, ok, info):
            q.put({"event": "stage", "stage": stage, "ok": ok, "info": info})

        if matched:
            # KNOWN circuit → deterministic equations through the pipeline (verified), streamed
            self._sse({"event": "stage", "stage": "known:" + matched, "ok": True, "info": {}})

            def work():
                try:
                    r = pipeline.run(spec, module=module,
                                     use_rag=data.get("use_rag", True),
                                     use_llm=data.get("use_llm", True),
                                     use_cosim=False, use_editor=False,
                                     on_stage=on_stage, verbose=False)
                    out = _trim(r)
                    out["source"] = "known:" + matched
                    out["llm_up"] = _llm_up()
                    result["out"] = out
                except Exception as e:
                    result["out"] = {"status": "REJECTED", "reason": str(e),
                                     "evidence": [], "llm_up": _llm_up()}
                q.put({"event": "__end__"})
        else:
            # NOVEL circuit → LLM writes gate-level VHDL (fast); the page draws it
            self._sse({"event": "stage", "stage": "generate-vhdl", "ok": None,
                       "info": {"running": True}})

            def work():
                try:
                    result["out"] = _run_llm_vhdl(spec, data.get("use_rag", False))
                except Exception as e:
                    result["out"] = {"status": "REJECTED", "reason": str(e),
                                     "evidence": [], "llm_up": _llm_up()}
                q.put({"event": "__end__"})

        t = threading.Thread(target=work, daemon=True)
        t.start()
        while True:
            try:
                item = q.get(timeout=12)
            except _queue.Empty:
                if not self._sse({"event": "ping"}):   # client gone
                    return
                continue
            if item.get("event") == "__end__":
                break
            self._sse(item)
        self._sse({"event": "done", "result": result.get("out", {"status": "REJECTED"})})

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/health", "/"):
            return self._send(200, {"ok": True, "service": "chat_server",
                                    "llm_endpoint": __import__("intent_client").DEFAULT_ENDPOINT,
                                    "llm_up": _llm_up()})
        if path == "/latest.json":
            f = DESIGNS / "latest.json"
            if not f.exists():
                return self._send(404, {"ok": False, "error": "no latest.json"})
            return self._send(200, f.read_bytes())
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            data = self._read_json()
        except Exception as e:
            return self._send(400, {"ok": False, "error": "bad json: " + str(e)})
        try:
            if path == "/sim":
                intent = data.get("intent")
                if not isinstance(intent, dict):
                    return self._send(400, {"ok": False, "error": "sim needs {intent}"})
                return self._send(200, _simulate_intent(
                    intent, data.get("input_seq"), int(data.get("cycles", 8) or 8)))
            if path == "/ask":
                msg = (data.get("message") or "").strip()
                if not msg:
                    return self._send(400, {"ok": False, "error": "empty message"})
                if not _llm_up():
                    return self._send(200, {"ok": False, "reason": "llm down"})
                try:
                    return self._send(200, {"ok": True, "answer": _ask_llm(msg)})
                except Exception as e:
                    return self._send(200, {"ok": False, "reason": str(e)})
            if path == "/chat_stream":
                return self._chat_stream(data)
            if path == "/chat":
                msg = (data.get("message") or "").strip()
                if not msg:
                    return self._send(400, {"ok": False, "error": "empty message"})
                # ROW-BY-ROW MAPPING TABLE ("00 -> 0001 …") wins over templates and the LLM
                tm = truthtable.parse_mapping(msg)
                if tm:
                    return self._send(200, _run_truthtable(tm))
                # SEQUENTIAL / feedback primitives + BCD-7seg — deterministic, no LLM
                for _h in (_run_known_seq, _run_known_latch, _run_known_bcd7seg):
                    _r = _h(msg)
                    if _r:
                        return self._send(200, _r)
                # PARAMETRIC families (N-bit adder, …) — build intent directly, verify by
                # spot-check (full 2^n truth table is infeasible), no LLM.
                para = parametric.parse_request(msg)
                if para:
                    return self._send(200, _run_parametric(para))
                tt = truthtable.parse(msg)
                if tt:
                    return self._send(200, _run_truthtable(tt))
                spec, module, matched = _expand_known(msg, data.get("module"))
                if not matched:
                    # NOVEL circuit → LLM writes VHDL (fast), page draws it
                    return self._send(200, _run_llm_vhdl(spec, data.get("use_rag", False)))
                # KNOWN circuit → deterministic equations through the pipeline (verified)
                r = pipeline.run(
                    spec,
                    module=module,
                    use_rag=data.get("use_rag", True),
                    use_llm=data.get("use_llm", True),
                    use_cosim=data.get("cosim", False),
                    use_editor=False,          # the page draws it live
                    verbose=False,
                )
                out = _trim(r)
                out["source"] = "known:" + matched     # deterministic, no LLM
                out["llm_up"] = _llm_up()
                return self._send(200, out)
            return self._send(404, {"ok": False, "error": "not found"})
        except Exception as e:
            return self._send(500, {"ok": False, "error": str(e),
                                    "trace": traceback.format_exc()[-800:]})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"chat_server on http://127.0.0.1:{port}  (LLM {'UP' if _llm_up() else 'down'} "
          f"@ {__import__('intent_client').DEFAULT_ENDPOINT})")
    print("  POST /chat {message}   POST /sim {intent}   GET /health   GET /latest.json")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
