"""
gen_vhdl.py - DETERMINISTIC Intent-JSON -> synthesizable VHDL (IEEE std_logic).

The LLM never writes VHDL: it only emits topology (validated + simulated). This
module turns that topology into code by construction, so the emitted VHDL cannot
hallucinate logic that differs from the verified netlist. Combinational only
(Intent v1): concurrent signal assignments in dependency order.

Target: Xilinx Spartan-7 (Vivado) friendly, plain std_logic.
"""
from __future__ import annotations
import re
from netlist_sim import build_graph, dff_pins, is_sequential, SRC, GATES, SEQ

_OP = {"AND": " and ", "OR": " or ", "XOR": " xor ", "NAND": " and ", "NOR": " or ", "XNOR": " xor "}
_NEG = {"NAND", "NOR", "XNOR"}


def _san(name: str) -> str:
    s = re.sub(r"\W", "_", str(name)).strip("_") or "n"
    if not re.match(r"[A-Za-z]", s):
        s = "n_" + s
    return s.lower()


def _order(comps, fanin):
    """Topological order of non-IO nodes (gates), inputs first."""
    ready = {cid for cid, c in comps.items() if c["type"] in SRC or c["type"] in SEQ}
    order, pending = [], [cid for cid, c in comps.items() if c["type"] in GATES]
    guard = 0
    while pending:
        guard += 1
        if guard > len(comps) + 5:
            order += pending  # break cycles defensively
            break
        prog = False
        for cid in list(pending):
            if all(s in ready for s in fanin.get(cid, [])):
                order.append(cid); ready.add(cid); pending.remove(cid); prog = True
        if not prog:
            order += pending
            break
    return order


def _ast_vhdl(node) -> str:
    """boolexpr AST -> a VHDL boolean expression (safe-parenthesized, readable)."""
    op = node[0]
    if op == "var":
        return _san(node[1])
    if op == "const":
        return "'1'" if node[1] else "'0'"
    if op == "not":
        inner = _ast_vhdl(node[1])
        return f"not {inner}" if node[1][0] in ("var", "const", "not") else f"not ({inner})"
    a, b = _ast_vhdl(node[1]), _ast_vhdl(node[2])
    opw = {"and": " and ", "or": " or ", "xor": " xor "}[op]
    return f"({a}{opw}{b})"


def generate_vhdl_from_equations(eqs: dict, entity: str | None = None,
                                 inputs: list | None = None) -> str:
    """Human-readable VHDL: ONE concurrent assignment per output, straight from the
    boolean equation (`sum <= a xor b xor cin;`). Correct because it IS the verified
    equation. This is the submittable/editable form the user asked for."""
    import boolexpr as B
    trees = {o: B.parse(e) for o, e in eqs.items()}
    if inputs is None:
        vs = set()
        for t in trees.values():
            B.variables(t, vs)
        inputs = sorted(vs)
    ent = _san(entity or "ai_design")
    ports = [f"    {_san(i)} : in  std_logic" for i in inputs]
    ports += [f"    {_san(o)} : out std_logic" for o in eqs]
    L = ["library IEEE;", "use IEEE.STD_LOGIC_1164.ALL;", "",
         f"entity {ent} is", "  port (", ";\n".join(ports), "  );", f"end {ent};", "",
         f"architecture rtl of {ent} is", "begin"]
    for o, t in trees.items():
        L.append(f"  {_san(o)} <= {_ast_vhdl(t)};")
    L.append("end rtl;")
    return "\n".join(L) + "\n"


def generate_vhdl(intent: dict, entity: str | None = None) -> str:
    # equation-first designs carry their equations -> emit the clean readable form
    eqs = intent.get("equations")
    if isinstance(eqs, dict) and eqs and not is_sequential(intent):
        try:
            in_names = [c.get("name") or c["id"] for c in intent.get("components", [])
                        if c.get("type") == "IN"]
            return generate_vhdl_from_equations(eqs, entity=entity or intent.get("module"),
                                                inputs=in_names or None)
        except Exception:
            pass          # fall back to the gate-level emitter below
    comps, fanin, inputs, outputs = build_graph(intent)
    pins = dff_pins(intent)
    dffs = [cid for cid, c in comps.items() if c["type"] in SEQ]
    ent = _san(entity or intent.get("module") or "ai_design")
    name = {}
    for cid, c in comps.items():
        if c["type"] in ("IN", "OUT"):
            name[cid] = _san(c.get("name") or cid)
        elif c["type"] in SEQ:
            name[cid] = "q_" + _san(cid)
        else:
            name[cid] = "s_" + _san(cid)
    # port list (add implicit single clock 'clk' when the design has flip-flops)
    ports = [f"    {name[i]} : in  std_logic" for i in inputs]
    if dffs:
        ports.append("    clk : in  std_logic")
    ports += [f"    {name[o]} : out std_logic" for o in outputs]
    L = ["library IEEE;", "use IEEE.STD_LOGIC_1164.ALL;", "",
         f"entity {ent} is", "  port (", ";\n".join(ports), "  );", f"end {ent};", "",
         f"architecture rtl of {ent} is"]
    # signals for gate outputs
    gate_ids = [cid for cid in comps if comps[cid]["type"] in GATES]
    for cid in gate_ids:
        L.append(f"  signal {name[cid]} : std_logic;")
    for cid in dffs:
        L.append(f"  signal {name[cid]} : std_logic := '0';")
    # constants
    for cid, c in comps.items():
        if c["type"] in ("VCC", "GND", "CONST"):
            L.append(f"  signal {name[cid]} : std_logic;")
    L.append("begin")
    for cid, c in comps.items():
        if c["type"] == "VCC":
            L.append(f"  {name[cid]} <= '1';")
        elif c["type"] == "GND":
            L.append(f"  {name[cid]} <= '0';")
        elif c["type"] == "CONST":
            v = int((c.get('params') or {}).get('value', 0)) & 1
            L.append(f"  {name[cid]} <= '{v}';")
    # gate assignments in dependency order
    for cid in _order(comps, fanin):
        t = comps[cid]["type"]
        srcs = [name[s] for s in fanin.get(cid, [])]
        if not srcs:
            expr = "'0'"
        elif t == "BUF":
            expr = srcs[0]
        elif t == "NOT":
            expr = f"not {srcs[0]}"
        else:
            inner = _OP[t].join(srcs)
            expr = f"not ({inner})" if t in _NEG else f"({inner})" if len(srcs) > 1 else srcs[0]
        L.append(f"  {name[cid]} <= {expr};")
    # DFF processes (rising-edge; optional async reset / enable)
    for cid in dffs:
        p = pins.get(cid, {})
        d = name.get(p.get("d"), "'0'")
        arst = name.get(p.get("arst")) if p.get("arst") else None
        en = name.get(p.get("en")) if p.get("en") else None
        q = name[cid]
        assign = f"{q} <= {d};" if not en else f"if {en} = '1' then {q} <= {d}; end if;"
        if arst:
            L += [f"  process(clk, {arst})", "  begin",
                  f"    if {arst} = '1' then {q} <= '0';",
                  f"    elsif rising_edge(clk) then {assign}",
                  "    end if;", "  end process;"]
        else:
            L += ["  process(clk)", "  begin",
                  f"    if rising_edge(clk) then {assign} end if;",
                  "  end process;"]
    # output drivers
    for o in outputs:
        srcs = fanin.get(o, [])
        drv = name[srcs[0]] if srcs else "'0'"
        L.append(f"  {name[o]} <= {drv};")
    L.append(f"end rtl;")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    import json
    import sys
    intent = json.load(open(sys.argv[1], encoding="utf-8"))
    print(generate_vhdl(intent, sys.argv[2] if len(sys.argv) > 2 else None))
