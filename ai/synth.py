"""
synth.py - DETERMINISTIC synthesis of an Intent-JSON netlist directly from boolean
equations (parsed by boolexpr). When the spec already states the equations, we
build the circuit by construction — correct 100% of the time, no LLM guessing.
The LLM is only needed for natural-language specs with no equations.

synth_intent_from_equations({"sum":"a^b^cin", "cout":"a*b+(a^b)*cin"}) -> intent
"""
from __future__ import annotations
import boolexpr as B


def synth_intent_from_equations(eqs: dict, module: str = "synth", inputs: list | None = None) -> dict:
    trees = {o: B.parse(e) for o, e in eqs.items()}
    lhs = set(trees)
    referenced = set()
    for t in trees.values():
        B.variables(t, referenced)
    if inputs is None:
        inputs = sorted(referenced - lhs)      # real inputs = variables never defined by an equation
    inset = set(inputs)
    # INTERNAL signals are named with a leading underscore (e.g. _axb = a xor b). They are
    # shared gate nodes with NO output port. Every other LHS is a real output — and an
    # output referenced by another output (gray->binary: b1 uses b2) is STILL an output,
    # just also shared. (Using "_" instead of "referenced?" avoids silently dropping such
    # chained outputs.)
    internal = {o for o in lhs if o.startswith("_")} - inset
    outputs = [o for o in trees if o not in internal]
    comps, nets = [], []
    seen = set()

    def add(cid, typ, **extra):
        if cid not in seen:
            comps.append({"id": cid, "type": typ, **extra})
            seen.add(cid)
        return cid

    for name in inputs:
        add(name, "IN", name=name)
    ctr = [0]

    def newgid():
        # underscore prefix + uniqueness check so gate ids never collide with signal
        # names like g0/g1/g2 (Gray code etc.) — that collision silently dropped gates.
        while True:
            ctr[0] += 1
            g = f"_g{ctr[0]}"
            if g not in seen:
                return g

    drv_cache = {}
    gate_cache = {}   # (op, sorted-input-ids) -> gate id : common-subexpression sharing
                      # so one NOT feeds every a', one AND feeds every reuse of a*b, across
                      # ALL outputs (a 7-seg decoder drops from ~120 gates to ~40)

    def emit_eq(name) -> str:
        """Driver id for a defined signal (output or internal), built once and shared."""
        if name in drv_cache:
            return drv_cache[name]
        d = emit(trees[name])
        drv_cache[name] = d
        return d

    def emit(node) -> str:
        """Return the id of a component/driver producing this node's value."""
        op = node[0]
        if op == "var":
            v = node[1]
            if v in trees and v not in inset:   # reference to a defined signal -> shared node
                return emit_eq(v)
            return v
        if op == "const":
            return add("vcc" if node[1] else "gnd", "VCC" if node[1] else "GND")
        if op == "not":
            src = emit(node[1])
            key = ("not", src)
            if key in gate_cache:
                return gate_cache[key]
            gid = newgid()
            add(gid, "NOT"); nets.append({"from": src, "to": gid})
            gate_cache[key] = gid
            return gid
        # binary and/or/xor — commutative, so order the inputs before hashing
        a = emit(node[1]); b = emit(node[2])
        key = (op, tuple(sorted((a, b))))
        if key in gate_cache:
            return gate_cache[key]
        gid = newgid()
        add(gid, op.upper()); nets.append({"from": a, "to": gid}); nets.append({"from": b, "to": gid})
        gate_cache[key] = gid
        return gid

    for out in outputs:
        drv = emit_eq(out)
        oid = out if out not in seen else out + "_o"
        add(oid, "OUT", name=out)
        nets.append({"from": drv, "to": oid})
    return {"module": module, "components": comps, "nets": nets}


def synth_intent_from_state_equations(next_eqs: dict, outputs: dict, registers: list,
                                      inputs: list | None = None, module: str = "fsm") -> dict:
    """SEQUENTIAL synthesis (phase 2). Each register -> a DFF whose id IS the register
    name (so a `var` referencing it reads its q). `next_eqs[r]` = the value latched into
    r.d on the clock edge (may use inputs AND register names). `outputs` = Moore/Mealy
    output equations. clk is implicit (added by gen_vhdl). Correct by construction."""
    reg_set = list(registers)
    regset = set(reg_set)
    next_trees = {r: B.parse(e) for r, e in next_eqs.items()}
    out_trees = {o: B.parse(e) for o, e in outputs.items()}
    if inputs is None:
        allvars = set()
        for t in list(next_trees.values()) + list(out_trees.values()):
            B.variables(t, allvars)
        inputs = sorted(v for v in allvars if v not in regset)
    comps, nets = [], []
    seen = set()

    def add(cid, typ, **extra):
        if cid not in seen:
            comps.append({"id": cid, "type": typ, **extra})
            seen.add(cid)
        return cid

    for name in inputs:
        add(name, "IN", name=name)
    for r in reg_set:
        add(r, "DFF")                       # id == register name; its output is q
    ctr = [0]

    def newgid():
        while True:
            ctr[0] += 1
            g = f"_g{ctr[0]}"
            if g not in seen:
                return g

    gate_cache = {}   # common-subexpression sharing (see synth_intent_from_equations)

    def emit(node) -> str:
        op = node[0]
        if op == "var":
            return node[1]                  # IN id, or DFF id (reads its q)
        if op == "const":
            return add("vcc" if node[1] else "gnd", "VCC" if node[1] else "GND")
        if op == "not":
            src = emit(node[1])
            key = ("not", src)
            if key in gate_cache:
                return gate_cache[key]
            gid = newgid()
            add(gid, "NOT"); nets.append({"from": src, "to": gid})
            gate_cache[key] = gid
            return gid
        a = emit(node[1]); b = emit(node[2])
        key = (op, tuple(sorted((a, b))))
        if key in gate_cache:
            return gate_cache[key]
        gid = newgid()
        add(gid, op.upper()); nets.append({"from": a, "to": gid}); nets.append({"from": b, "to": gid})
        gate_cache[key] = gid
        return gid

    for r, tree in next_trees.items():
        drv = emit(tree)
        nets.append({"from": drv, "to": f"{r}.d"})     # next-state -> DFF d pin
    for out, tree in out_trees.items():
        drv = emit(tree)
        oid = out if out not in seen else out + "_o"
        add(oid, "OUT", name=out)
        nets.append({"from": drv, "to": oid})
    return {"module": module, "components": comps, "nets": nets}


if __name__ == "__main__":
    import json
    import sys
    eqs = dict(kv.split("=", 1) for kv in sys.argv[1:])
    print(json.dumps(synth_intent_from_equations(eqs), ensure_ascii=False, indent=2))
