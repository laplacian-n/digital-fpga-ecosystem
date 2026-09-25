"""
netlist_sim.py - deterministic logic simulator for an Intent-JSON netlist.

This is a core anti-hallucination tool: it turns a generated topology into a
TRUTH TABLE by actually evaluating the gates, so we can check what the circuit
really computes (never trust the model's claim about its own logic).

Intent v1 is combinational: types IN OUT VCC GND CONST AND OR XOR NAND NOR XNOR
NOT BUF; nets {from: driverId (out pin 'o'), to: sinkId[.iK]}. Gate inputs are
commutative here, so only the fan-in SET per component matters.
"""
from __future__ import annotations
from itertools import product

SRC = {"IN", "VCC", "GND", "CONST"}
GATES = {"AND", "OR", "XOR", "NAND", "NOR", "XNOR", "NOT", "BUF"}
SEQ = {"DFF"}          # Intent v2: rising-edge D flip-flop (pins d, optional en/arst; out q)


def _ref_id(s):
    s = str(s or "").strip()
    return s.split(".", 1)[0]


def _ref_pin(s):
    s = str(s or "").strip()
    return s.split(".", 1)[1] if "." in s else None


def is_sequential(intent: dict) -> bool:
    return any(c.get("type") in SEQ for c in intent.get("components", []))


def dff_pins(intent: dict) -> dict:
    """{dff_id: {'d':driver, 'en':driver?, 'arst':driver?}} from the nets."""
    comps = {c["id"]: c for c in intent.get("components", [])}
    pins = {}
    for n in intent.get("nets", []):
        tid, pin = _ref_id(n.get("to")), (_ref_pin(n.get("to")) or "d")
        f = _ref_id(n.get("from"))
        if tid in comps and comps[tid].get("type") in SEQ and f in comps:
            pins.setdefault(tid, {})[pin] = f
    return pins


def build_graph(intent: dict):
    comps = {c["id"]: c for c in intent.get("components", [])}
    fanin = {cid: [] for cid in comps}
    for n in intent.get("nets", []):
        f, t = _ref_id(n.get("from")), _ref_id(n.get("to"))
        if f in comps and t in comps:
            fanin[t].append(f)
    inputs = [c["id"] for c in intent.get("components", []) if c.get("type") == "IN"]
    outputs = [c["id"] for c in intent.get("components", []) if c.get("type") == "OUT"]
    return comps, fanin, inputs, outputs


def _gate(t, xs):
    if t == "BUF":
        return xs[0]
    if t == "NOT":
        return xs[0] ^ 1
    if not xs:
        raise ValueError("gate with no inputs")
    acc = xs[0]
    if t in ("AND", "NAND"):
        for v in xs[1:]:
            acc &= v
        return acc ^ 1 if t == "NAND" else acc
    if t in ("OR", "NOR"):
        for v in xs[1:]:
            acc |= v
        return acc ^ 1 if t == "NOR" else acc
    if t in ("XOR", "XNOR"):
        for v in xs[1:]:
            acc ^= v
        return acc ^ 1 if t == "XNOR" else acc
    raise ValueError("unknown gate " + str(t))


def eval_once(comps, fanin, assign: dict) -> dict:
    """Evaluate all component outputs given input assignment (acyclic combinational)."""
    val = dict(assign)
    pending = set(comps) - set(val)
    # sources
    for cid in list(pending):
        t = comps[cid]["type"]
        if t == "VCC":
            val[cid] = 1; pending.discard(cid)
        elif t == "GND":
            val[cid] = 0; pending.discard(cid)
        elif t == "CONST":
            val[cid] = int((comps[cid].get("params") or {}).get("value", 0)) & 1; pending.discard(cid)
    guard = 0
    while pending:
        guard += 1
        if guard > len(comps) + 5:
            raise ValueError("combinational loop or undriven node: " + ",".join(pending))
        for cid in list(pending):
            srcs = fanin.get(cid, [])
            if all(s in val for s in srcs) and srcs:
                t = comps[cid]["type"]
                if t == "OUT":
                    val[cid] = val[srcs[0]]
                elif t in GATES:
                    val[cid] = _gate(t, [val[s] for s in srcs])
                else:
                    val[cid] = val[srcs[0]]
                pending.discard(cid)
            elif not srcs:
                # undriven non-source -> treat as 0 but flag by leaving; here default 0
                val[cid] = 0; pending.discard(cid)
    return val


def _eval_comb(comps, fanin, assign: dict, dstate: dict) -> dict:
    """Combinational evaluation with DFF q outputs seeded from current state."""
    val = dict(assign)
    for cid, c in comps.items():
        t = c["type"]
        if t == "VCC":
            val[cid] = 1
        elif t == "GND":
            val[cid] = 0
        elif t == "CONST":
            val[cid] = int((c.get("params") or {}).get("value", 0)) & 1
        elif t in SEQ:
            val[cid] = dstate.get(cid, 0)            # q = current state (a source now)
    pending = [cid for cid, c in comps.items() if c["type"] in GATES or c["type"] == "OUT"]
    guard = 0
    while pending:
        guard += 1
        if guard > len(comps) + 5:
            raise ValueError("combinational loop (a cycle not broken by a DFF): " + ",".join(pending))
        prog = False
        for cid in list(pending):
            srcs = fanin.get(cid, [])
            if srcs and all(s in val for s in srcs):
                t = comps[cid]["type"]
                val[cid] = val[srcs[0]] if t == "OUT" else _gate(t, [val[s] for s in srcs])
                pending.remove(cid); prog = True
            elif not srcs:
                val[cid] = 0; pending.remove(cid); prog = True
        if not prog:
            raise ValueError("undriven/looped nodes: " + ",".join(pending))
    return val


def simulate_sequential(intent: dict, cycles: int | None = None,
                        input_seq: list | None = None, init: int = 0) -> dict:
    """Clock a sequential design. Moore-style: outputs recorded from CURRENT state
    each cycle, then the state advances (rising edge). Returns
    {inputs, outputs, dffs, rows:[{cycle,in,state,out}]}."""
    comps = {c["id"]: c for c in intent.get("components", [])}
    _, fanin, inputs, outputs = build_graph(intent)
    pins = dff_pins(intent)
    dffs = [cid for cid, c in comps.items() if c.get("type") in SEQ]
    state = {d: init & 1 for d in dffs}
    if input_seq is None:
        n = cycles or (2 ** len(dffs) + 2 if dffs else 4)
        input_seq = [{k: 0 for k in inputs} for _ in range(n)]
    rows = []
    for i, step in enumerate(input_seq):
        assign = {k: int(step.get(k, 0)) & 1 for k in inputs}
        # pass 1: read control signals (arst/en) from the raw state
        v0 = _eval_comb(comps, fanin, assign, state)
        # ASYNC reset takes effect immediately (before this cycle's output), so
        # apply it to the effective state, then re-evaluate for outputs.
        eff = {d: (0 if (pins.get(d, {}).get("arst") is not None
                         and v0.get(pins[d]["arst"], 0) == 1) else state[d]) for d in dffs}
        val = _eval_comb(comps, fanin, assign, eff)
        rows.append({"cycle": i, "in": dict(assign), "state": dict(eff),
                     "out": {o: val.get(o, 0) for o in outputs}})
        nxt = {}
        for d in dffs:
            p = pins.get(d, {})
            if p.get("arst") is not None and val.get(p["arst"], 0) == 1:
                nxt[d] = 0
            elif p.get("en") is not None and val.get(p["en"], 0) == 0:
                nxt[d] = eff[d]
            else:
                nxt[d] = val.get(p.get("d"), 0)
        state = nxt
    return {"inputs": inputs, "outputs": outputs, "dffs": dffs, "rows": rows}


def truth_table(intent: dict):
    """Return (inputs, outputs, rows) where rows[i] = (in_bits_tuple, out_bits_tuple)."""
    comps, fanin, inputs, outputs = build_graph(intent)
    rows = []
    for bits in product((0, 1), repeat=len(inputs)):
        assign = dict(zip(inputs, bits))
        val = eval_once(comps, fanin, assign)
        rows.append((bits, tuple(val.get(o, 0) for o in outputs)))
    return inputs, outputs, rows


def table_signature(intent: dict):
    """Canonical (inputs, outputs, frozenset rows) for equivalence — by NAME not id."""
    comps = {c["id"]: c for c in intent.get("components", [])}
    inn = {c["id"]: (c.get("name") or c["id"]) for c in intent.get("components", []) if c.get("type") == "IN"}
    outn = {c["id"]: (c.get("name") or c["id"]) for c in intent.get("components", []) if c.get("type") == "OUT"}
    inputs, outputs, rows = truth_table(intent)
    in_names = [inn[i] for i in inputs]
    out_names = [outn[o] for o in outputs]
    return in_names, out_names, rows


if __name__ == "__main__":
    import json
    import sys
    intent = json.load(open(sys.argv[1], encoding="utf-8"))
    ins, outs, rows = truth_table(intent)
    print("inputs:", ins, "outputs:", outs)
    for bits, ob in rows:
        print(" ".join(map(str, bits)), "->", " ".join(map(str, ob)))
