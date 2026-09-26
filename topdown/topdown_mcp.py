#!/usr/bin/env python3
"""
Top-Down Schematic — MCP server
================================

A local MCP connector so you can build schematic sheets by *talking to Claude*
on your normal Claude subscription (Desktop / Code) — no API key, no per-token
billing. Claude reads the schema from `get_schema()`, writes the design JSON
itself, and calls `save_design(...)`. The HTML editor then imports it (either by
opening the saved .json file, or live via the built-in `--serve` bridge and the
app's "Sync ⟳" button).

Run as a Claude Desktop connector (stdio, default):
    pip install "mcp[cli]"
    python topdown_mcp.py

Run with the live HTTP bridge for the app's Sync button:
    python topdown_mcp.py --serve      # serves designs on http://127.0.0.1:8765

Files are written to ./designs/ (override with TOPDOWN_DIR).
"""

import argparse
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from mcp.server.mcpserver import MCPServer

DESIGN_DIR = Path(os.environ.get("TOPDOWN_DIR", Path(__file__).parent / "designs"))
DESIGN_DIR.mkdir(parents=True, exist_ok=True)
BRIDGE_PORT = int(os.environ.get("TOPDOWN_PORT", "8765"))

mcp = MCPServer("top-down-schematic")

# --------------------------------------------------------------------------- #
# Schema the editor understands. Claude should follow this exactly.
# --------------------------------------------------------------------------- #
SCHEMA = {
    "description": "A hierarchical schematic. Return EITHER a full project OR a single sheet.",
    "project": {
        "meta": {"projectName": "str", "studentId": "str", "studentName": "str",
                 "section": "str", "page": "str"},
        "sheets": ["<sheet>", "..."],
    },
    "sheet": {
        "title": "e.g. '3rd Layer \u2282 (Comparator)'",
        "module": "top-left module name, e.g. 'Comparator'",
        "frame": {"x": 120, "y": 150, "w": 1000, "h": 560},
        "nodes": ["<node>", "..."],
        "wires": ["<wire>", "..."],
    },
    "node": {
        "IMPORTANT": "All fields below are FLAT directly on the node object — "
                     "there is NO nested 'block'/'gate'/'mux'/'port'/'const' wrapper key. "
                     "e.g. a block node is {id,type:'block',x,y,label,pinsL,pinsR,pinsB,pinsT} — "
                     "see get_example() for a working reference.",
        "id": "unique string",
        "type": "block | gate | mux | port | const",
        "x": "int (top-left)", "y": "int",
        "if type=='block'": {"label": "str", "pinsL": ["clk", "~CLR", "D0[3:0]"],
                  "pinsR": ["Q"], "pinsB": [], "pinsT": [],
                  "note": "prefix a pin with ~ to draw an inversion bubble; a pin named 'clk' gets a clock triangle"},
        "if type=='gate'": {"gate": "and|or|nand|nor|xor|xnor|not|buf", "inputs": 2,
                 "pins": "in0,in1,...,out"},
        "if type=='mux'": {"label": "Mux2-1(4)", "pins": "d0,d1,sel,out"},
        "if type=='port'": {"name": "CLK", "side": "left|right|top|bottom", "bus": 0,
                 "note": "bus>0 draws a /n bus tap and [n-1:0]; a port has one pin 'p'"},
        "if type=='const'": {"value": "1 | 0", "pin": "p"},
    },
    "wire": {
        "from": {"node": "nodeId", "pin": "pinId (e.g. R0, in1, out, p)"},
        "to": {"node": "nodeId", "pin": "pinId"},
        "bus": "0 for a plain wire, or n to draw a /n bus",
    },
    "pin_ids": {
        "block": "left pins L0,L1,... ; right R0,R1,... ; bottom B0,... ; top T0,...",
        "gate": "inputs in0,in1,... ; output out",
        "mux": "d0, d1, sel, out",
        "port": "p", "const": "p",
    },
    "conventions": {
        "layers": "Name sheets 'Nth Layer \u2282 (Module)'. Higher layer number = deeper in the hierarchy.",
        "top_down": "Sheet 1 = whole system; each child module gets its own sheet expanding one block.",
        "facts": "Keep engineering facts correct. For the FPGA counter lab: 50MHz/20Hz divider = 2,500,000; "
                 "7-seg on the EDGE board is common-anode so segments are active-LOW; scan >= 1 kHz.",
    },
}

EXAMPLE_SHEET = {
    "title": "4th Layer \u2282 (Comparator)",
    "module": "Comparator",
    "frame": {"x": 120, "y": 150, "w": 900, "h": 600},
    "nodes": [
        {"id": "a1", "type": "port", "x": 150, "y": 240, "name": "A1", "side": "left"},
        {"id": "b1", "type": "port", "x": 150, "y": 440, "name": "B1", "side": "left"},
        {"id": "g1", "type": "gate", "x": 560, "y": 300, "gate": "xnor", "inputs": 2},
        {"id": "and", "type": "gate", "x": 800, "y": 380, "gate": "and", "inputs": 4},
        {"id": "reg", "type": "block", "x": 560, "y": 460, "label": "D_FF_CLR",
         "pinsL": ["D", "clk", "~CLR"], "pinsR": ["Q"], "pinsB": [], "pinsT": []},
        {"id": "eq", "type": "port", "x": 1000, "y": 402, "name": "EQ", "side": "right"},
    ],
    "wires": [
        {"from": {"node": "a1", "pin": "p"}, "to": {"node": "g1", "pin": "in0"}, "bus": 0},
        {"from": {"node": "b1", "pin": "p"}, "to": {"node": "g1", "pin": "in1"}, "bus": 0},
        {"from": {"node": "g1", "pin": "out"}, "to": {"node": "and", "pin": "in0"}, "bus": 0},
        {"from": {"node": "and", "pin": "out"}, "to": {"node": "eq", "pin": "p"}, "bus": 0},
        {"from": {"node": "g1", "pin": "out"}, "to": {"node": "reg", "pin": "L0"}, "bus": 0},
    ],
}

# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _safe(name: str) -> str:
    s = re.sub(r"[^\w.-]+", "_", name.strip())
    return s or "design"


def _write(name: str, obj) -> Path:
    path = DESIGN_DIR / (_safe(name) + ".json")
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    (DESIGN_DIR / "latest.json").write_text(
        json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return path


# --------------------------------------------------------------------------- #
# tools
# --------------------------------------------------------------------------- #
@mcp.tool()
def get_schema() -> str:
    """Return the JSON schema the Top-Down Schematic editor expects.

    Call this BEFORE building a design so the JSON you produce imports cleanly.
    You return either a full project ({meta, sheets:[...]}) or a single sheet
    ({title, module, frame, nodes, wires}); save it with save_design.
    """
    return json.dumps(SCHEMA, ensure_ascii=False, indent=2)


@mcp.tool()
def get_example() -> str:
    """Return one worked example sheet (a 4-bit equality comparator) as reference."""
    return json.dumps(EXAMPLE_SHEET, ensure_ascii=False, indent=2)


def _node_pin_ids(node: dict) -> list:
    t = node.get("type")
    if t == "block":
        ids = []
        for key, prefix in (("pinsL", "L"), ("pinsR", "R"), ("pinsB", "B"), ("pinsT", "T")):
            ids += [f"{prefix}{i}" for i in range(len(node.get(key) or []))]
        return ids
    if t == "gate":
        n = node.get("inputs") or 2
        return [f"in{i}" for i in range(n)] + ["out"]
    if t == "mux":
        return ["d0", "d1", "sel", "out"]
    if t in ("port", "const"):
        return ["p"]
    return []


def _validate_sheet(s: dict, where: str) -> list:
    """Return a list of human-readable error strings for one sheet (empty = OK)."""
    errs = []
    if not isinstance(s.get("nodes"), list):
        return [f"{where}: missing/invalid 'nodes' array"]
    if not isinstance(s.get("wires"), list):
        return [f"{where}: missing/invalid 'wires' array"]
    ids_seen = {}
    for i, n in enumerate(s["nodes"]):
        tag = f"{where} node[{i}] (id={n.get('id')!r})"
        t = n.get("type")
        for wrapper in ("block", "gate", "mux", "port", "const"):
            if wrapper in n and isinstance(n.get(wrapper), dict):
                errs.append(f"{tag}: field '{wrapper}' must NOT be nested -- move its keys "
                            f"(e.g. label/pinsL/pinsR, or name/side, ...) directly onto the node "
                            f"object. See get_example().")
        if not n.get("id"):
            errs.append(f"{tag}: missing 'id'")
        elif n["id"] in ids_seen:
            errs.append(f"{tag}: duplicate node id (also used by node[{ids_seen[n['id']]}])")
        else:
            ids_seen[n["id"]] = i
        if t not in ("block", "gate", "mux", "port", "const"):
            errs.append(f"{tag}: invalid/missing 'type' {t!r} (must be block|gate|mux|port|const)")
        elif t == "block" and not n.get("label"):
            errs.append(f"{tag}: block node needs a non-empty 'label'")
        elif t == "gate" and n.get("gate") not in ("and", "or", "nand", "nor", "xor", "xnor", "not", "buf"):
            errs.append(f"{tag}: gate node needs 'gate' in and|or|nand|nor|xor|xnor|not|buf")
        elif t == "port" and not n.get("name"):
            errs.append(f"{tag}: port node needs a non-empty 'name'")
        elif t == "const" and str(n.get("value")) not in ("0", "1"):
            errs.append(f"{tag}: const node needs 'value' of '0' or '1'")
    nodes_by_id = {n.get("id"): n for n in s["nodes"] if n.get("id")}
    for i, w in enumerate(s["wires"]):
        for end in ("from", "to"):
            ref = w.get(end)
            if not isinstance(ref, dict) or "node" not in ref:
                continue  # a literal {x,y} endpoint - nothing to check
            n = nodes_by_id.get(ref.get("node"))
            if n is None:
                errs.append(f"{where} wire[{i}].{end}: node id {ref.get('node')!r} does not exist")
                continue
            valid_pins = _node_pin_ids(n)
            if ref.get("pin") not in valid_pins:
                errs.append(f"{where} wire[{i}].{end}: node {ref['node']!r} (type {n.get('type')}) "
                            f"has no pin {ref.get('pin')!r} - valid pins: {valid_pins}")
    return errs


@mcp.tool()
def save_design(name: str, design: str) -> str:
    """Save a design so the editor can import it.

    SUPERSEDED for lab work: when the "fpga-ecosystem" server is also connected, do NOT use this.
    Build the circuit in Schematic Studio there, simulate it, get the user's approval
    (request_approval / approval_status) and then call make_topdown — the Top-Down must come
    from the approved, simulated circuit, not from JSON written by hand.

    Args:
        name:   file name (no extension needed), e.g. "randomdice" or "comparator_4th".
        design: the design as a JSON string -- a full project or a single sheet,
                matching get_schema(). Invalid JSON is rejected with a hint.

    Validates every wire against the actual pins its endpoints would generate (a wire
    pointing at a node/pin that doesn't exist is rejected, not silently dropped) and checks
    required per-type fields. Fix all listed errors and call save_design again.

    Writes ./designs/<name>.json and updates ./designs/latest.json (which the
    editor's "Sync ⇳" button loads when this server runs with --serve).
    """
    try:
        obj = json.loads(design)
    except json.JSONDecodeError as e:
        return f"ERROR: design is not valid JSON ({e}). Fix and call save_design again."
    if not isinstance(obj, dict):
        return "ERROR: top level must be an object (a project or a sheet)."
    ok = ("sheets" in obj and "meta" in obj) or ("nodes" in obj and "frame" in obj) \
         or ("title" in obj and ("blocks" in obj or "nodes" in obj))
    if not ok:
        return ("ERROR: shape not recognized. Return a full project {meta, sheets:[...]} "
                "or a single sheet {title, module, frame, nodes, wires}. See get_schema().")

    errs = []
    if "sheets" in obj and "meta" in obj:
        for i, s in enumerate(obj["sheets"]):
            errs += _validate_sheet(s, f"sheet[{i}] {s.get('title', '')!r}")
    elif "nodes" in obj and "frame" in obj:
        errs += _validate_sheet(obj, "sheet")
    # the loose {title, blocks|nodes} shape is intentionally not strictly validated --
    # the editor's tolerant fromLoose() loader normalizes it on import.
    if errs:
        listing = "\n".join(f"  - {e}" for e in errs[:25])
        more = f"\n  ... and {len(errs) - 25} more" if len(errs) > 25 else ""
        return (f"ERROR: design has {len(errs)} problem(s), NOT saved:\n{listing}{more}\n"
                f"Fix these and call save_design again.")

    path = _write(name, obj)
    n_sheets = len(obj["sheets"]) if "sheets" in obj else 1
    return (f"Saved {path} ({n_sheets} sheet(s)). In the editor click 'Sync ⇳' "
            f"(if running --serve) or 'Import' → load this file.")


@mcp.tool()
def list_designs() -> str:
    """List saved design files with their sheet counts."""
    out = []
    for p in sorted(DESIGN_DIR.glob("*.json")):
        try:
            o = json.loads(p.read_text(encoding="utf-8"))
            n = len(o["sheets"]) if isinstance(o, dict) and "sheets" in o else 1
        except Exception:
            n = "?"
        out.append(f"{p.name}  ({n} sheet(s))")
    return "\n".join(out) or "No designs saved yet."


@mcp.tool()
def read_design(name: str) -> str:
    """Return the JSON of a previously saved design so you can revise it."""
    path = DESIGN_DIR / (_safe(name) + ".json")
    if not path.exists():
        return f"ERROR: {path.name} not found. Use list_designs()."
    return path.read_text(encoding="utf-8")


@mcp.resource("topdown://schema")
def schema_resource() -> str:
    """The editor's JSON schema, as a resource."""
    return json.dumps(SCHEMA, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------------- #
# optional local HTTP bridge for the app's "Sync" button
# --------------------------------------------------------------------------- #
class _Bridge(BaseHTTPRequestHandler):
    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        rel = self.path.lstrip("/").split("?")[0] or "latest.json"
        target = DESIGN_DIR / rel
        if target.suffix == ".json" and target.resolve().parent == DESIGN_DIR.resolve() and target.exists():
            self._send(200, target.read_bytes())
        else:
            self._send(404, b'{"error":"not found"}')

    def log_message(self, *a):  # quiet
        pass


def run_bridge():
    # Log to stderr (stdout is the MCP JSON-RPC channel) and never interpolate a
    # non-ASCII path: Claude Desktop launches this with a cp1252 stdout, so printing
    # a Thai path raised UnicodeEncodeError and killed this thread before
    # serve_forever() — leaving nothing listening on the bridge port.
    srv = ThreadingHTTPServer(("127.0.0.1", BRIDGE_PORT), _Bridge)
    try:
        print(f"[bridge] serving on http://127.0.0.1:{BRIDGE_PORT}/latest.json",
              file=sys.stderr, flush=True)
    except Exception:
        pass
    srv.serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true",
                    help="also run the HTTP bridge for the app's Sync button")
    args = ap.parse_args()
    if args.serve:
        threading.Thread(target=run_bridge, daemon=True).start()
    mcp.run()  # stdio transport for Claude Desktop / Code
