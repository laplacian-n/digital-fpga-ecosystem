"""
parse_xdc.py - parse the EDGE Spartan-7 .xdc into a Board Profile: the menu of
board signals -> FPGA pins the AI can target when generating constraints.

Produces board_profile.json:
  {"part": "...", "signals": {sig: {pin, iostandard, note, group, bus, index}},
   "groups": {group: [sig,...]}}   # e.g. group "sw" -> sw[0..15]

Note: the board .xdc is a general template where several peripherals SHARE pins
(7-seg reuses LED pins, expansion reuses camera pins). We keep all entries and
mark the group; a real design must pick mutually-exclusive peripherals.
"""
from __future__ import annotations
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
XDC = HERE / "edge_spartan7.xdc"
OUT = HERE / "board_profile.json"

# set_property -dict { PACKAGE_PIN H11  IOSTANDARD LVCMOS33 [PULLDOWN true] } [get_ports { clk }]; #note
LINE = re.compile(
    r"PACKAGE_PIN\s+(\w+)\s+IOSTANDARD\s+(\w+)([^}]*)\}\s*\[get_ports\s*\{\s*([^}]+?)\s*\}", re.I)
CUR_GROUP = re.compile(r"#\$\s*(.+)")


def _group_of(sig, header):
    base = re.sub(r"\[\d+\]$", "", sig).strip()
    return base


def parse(xdc_text: str) -> dict:
    signals, groups = {}, {}
    header = ""
    for raw in xdc_text.splitlines():
        h = CUR_GROUP.search(raw)
        if h:
            header = h.group(1).strip()
            continue
        s = raw.strip()
        if not s.startswith("set_property"):
            continue
        m = LINE.search(s)
        if not m:
            continue
        pin, iostd, extra, port = m.group(1), m.group(2), m.group(3), m.group(4).strip()
        port = port.strip().strip("{}").strip()
        note = ""
        cm = re.search(r"#(.*)$", raw)
        if cm:
            note = cm.group(1).strip()
        mb = re.match(r"(\w+)\s*\[\s*(\d+)\s*\]$", port)
        base = mb.group(1) if mb else port
        idx = int(mb.group(2)) if mb else None
        pulldown = "PULLDOWN" in extra.upper()
        signals[port] = {"pin": pin, "iostandard": iostd, "note": note,
                         "group": header or base, "bus": base, "index": idx,
                         "pulldown": pulldown}
        groups.setdefault(base, []).append(port)
    # sort bus members by index
    for b, lst in groups.items():
        lst.sort(key=lambda p: (signals[p]["index"] if signals[p]["index"] is not None else -1))
    return {"part": "xc7s15ftgb196-1", "board": "EDGE Spartan-7",
            "clock": {"port": "clk", "pin": signals.get("clk", {}).get("pin", "H11"),
                      "freq_hz": 50_000_000},
            "signals": signals, "groups": groups}


def main():
    prof = parse(XDC.read_text(encoding="utf-8"))
    OUT.write_text(json.dumps(prof, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", OUT)
    print("signals:", len(prof["signals"]), "groups:", len(prof["groups"]))
    for g in ("clk", "sw", "led", "pb", "digit", "Seven_Segment"):
        print(f"  {g}: {len(prof['groups'].get(g, []))} pins",
              "->", [prof['signals'][p]['pin'] for p in prof['groups'].get(g, [])][:4], "...")


if __name__ == "__main__":
    main()
