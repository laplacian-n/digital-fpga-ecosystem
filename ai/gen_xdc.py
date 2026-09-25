"""
gen_xdc.py - generate a Vivado .xdc (pin constraints) for a design, mapping its
top-level ports to real EDGE Spartan-7 pins from the board profile. This is the
bridge from a verified netlist to something that can actually be put on the board.

Auto-map convention (override with `mapping={port: board_signal}`):
  - a port named clk            -> board clk (H11, 50 MHz)
  - inputs named rst/reset/*btn*/en -> push buttons pb[0..] (have pulldowns)
  - other inputs                -> switches sw[0..]
  - outputs                     -> LEDs led[0..]
Ports already matching a board bus name (e.g. led, sw, digit) map 1:1.
"""
from __future__ import annotations
import json
import re
from pathlib import Path

from netlist_sim import build_graph, is_sequential
from gen_vhdl import _san

HERE = Path(__file__).resolve().parent
PROFILE = HERE / "board" / "board_profile.json"


def load_profile(path: Path = PROFILE) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _ports(intent):
    comps, _, inputs, outputs = build_graph(intent)
    ins = [_san(comps[i].get("name") or i) for i in inputs]
    outs = [_san(comps[o].get("name") or o) for o in outputs]
    return ins, outs, is_sequential(intent)


def auto_map(ins, outs, seq, profile, mapping=None):
    """Return {port: (pin, iostandard, pulldown, board_sig)} and a list of warnings."""
    g = profile["groups"]
    sig = profile["signals"]
    used = set()
    out_map, warns = {}, []

    def take(group, want_port):
        for p in g.get(group, []):
            if p not in used:
                used.add(p)
                return p
        warns.append(f"ไม่มีขา {group} เหลือให้ {want_port}")
        return None

    mapping = mapping or {}
    sw_i = led_i = pb_i = 0
    for p in ins:
        if p in mapping:
            bs = mapping[p]
        elif p == "clk":
            bs = "clk"
        elif re.search(r"rst|reset|btn|button|^en$|center|start|stop", p, re.I):
            bs = None
            for cand in g.get("pb", []):
                if cand not in used:
                    bs = cand; break
        else:
            bs = None
            for cand in g.get("sw", []):
                if cand not in used:
                    bs = cand; break
        if not bs or bs not in sig:
            warns.append(f"map ไม่ได้: input {p}")
            continue
        used.add(bs)
        s = sig[bs]
        out_map[p] = (s["pin"], s["iostandard"], s.get("pulldown", False), bs)
    for p in outs:
        bs = mapping.get(p)
        if not bs:
            for cand in g.get("led", []):
                if cand not in used:
                    bs = cand; break
        if not bs or bs not in sig:
            warns.append(f"map ไม่ได้: output {p}")
            continue
        used.add(bs)
        s = sig[bs]
        out_map[p] = (s["pin"], s["iostandard"], s.get("pulldown", False), bs)
    return out_map, warns


def generate_xdc(intent: dict, profile: dict | None = None, mapping=None) -> dict:
    profile = profile or load_profile()
    ins, outs, seq = _ports(intent)
    if seq and "clk" not in ins:
        ins = ["clk"] + ins           # sequential design has an implicit clk port
    m, warns = auto_map(ins, outs, seq, profile, mapping)
    lines = [f"## EDGE Spartan-7 ({profile.get('part')}) - auto-generated pin map",
             "## review before board use; commented ports were not mapped", ""]
    for p in ins + outs:
        if p not in m:
            lines.append(f"# UNMAPPED: {p}")
            continue
        pin, iostd, pd, bs = m[p]
        extra = " PULLDOWN true" if pd else ""
        lines.append(f"set_property -dict {{ PACKAGE_PIN {pin}  IOSTANDARD {iostd}{extra} }} "
                     f"[get_ports {{ {p} }}];  # <- board {bs}")
    if seq:
        lines += ["", "## 50 MHz clock period constraint",
                  "create_clock -period 20.000 -name sys_clk [get_ports clk];"]
    return {"xdc": "\n".join(lines) + "\n", "map": m, "warnings": warns}


if __name__ == "__main__":
    import sys
    intent = json.load(open(sys.argv[1], encoding="utf-8"))
    r = generate_xdc(intent)
    print(r["xdc"])
    if r["warnings"]:
        print("# warnings:", r["warnings"])
