#!/usr/bin/env python3
"""
Schematic Studio (gate-level) — MCP server
==========================================

A local MCP connector so Claude (now) and the local AI (later) can build
gate-level schematics for `schematic&bus2vhdl.html` by writing the design JSON
and calling `save_design(...)`. The editor imports it either by opening the
saved .schproj.json file, or live via the built-in `--serve` bridge and a
"Sync ⟳" button (port 8766).

This mirrors the sibling `topdown/topdown_mcp.py` (port 8765) but targets the
gate-level editor's own `deserialize()` shape and validates every wire endpoint
against the real port ids each component TYPE + params would generate — the
editor itself does NOT check pids, so this validator is the guard.

Run as a Claude Desktop / Code connector (stdio, default):
    pip install "mcp[cli]"
    python schematic_mcp.py

Run with the live HTTP bridge for the app's Sync button:
    python schematic_mcp.py --serve        # serves designs on http://127.0.0.1:8766

Files are written to ./designs_gate/ (override with SCHSTUDIO_DIR).
Port override: SCHSTUDIO_PORT.
"""

import argparse
import json
import math
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from mcp.server.mcpserver import MCPServer

DESIGN_DIR = Path(os.environ.get("SCHSTUDIO_DIR", Path(__file__).parent / "designs_gate"))
DESIGN_DIR.mkdir(parents=True, exist_ok=True)
BRIDGE_PORT = int(os.environ.get("SCHSTUDIO_PORT", "8766"))

mcp = MCPServer("schematic-studio")

# --------------------------------------------------------------------------- #
# Catalog: the exact port-id rules the editor's TYPES generate.
# (Mirrors schematic&bus2vhdl.html TYPES / gatePortsAndSize — see doc 01.)
# --------------------------------------------------------------------------- #
GATES = {"AND", "OR", "NAND", "NOR", "XOR", "XNOR", "NOT", "BUF"}
FFS = {"DFF", "JKFF", "TFF", "SRFF"}
KNOWN_TYPES = (
    {"IN", "OUT", "VCC", "GND", "CONST", "JUNCTION",
     "MUX", "DEMUX", "COMP", "COMPM", "BUSTAP", "ENC", "DEC"}
    | GATES | FFS
)


def _clamp(v, lo, hi):
    try:
        v = int(v)
    except (TypeError, ValueError):
        v = lo
    return max(lo, min(hi, v))


def _clog2(n):
    return max(1, math.ceil(math.log2(max(2, int(n)))))


def port_ids(comp):
    """Return the list of valid port ids for a component, exactly as the editor
    would generate from its type + params. Returns None for hierarchy types
    (SCH:/CUSTOM:) whose ports depend on another sheet — caller skips pid check.
    """
    t = comp.get("type", "")
    p = comp.get("params") or {}
    if t.startswith("SCH:") or t.startswith("CUSTOM:"):
        return None  # derived from child sheet; not validated here
    if t in ("IN", "VCC", "GND", "CONST"):
        return ["o"]
    if t == "OUT":
        return ["i"]
    if t == "JUNCTION":
        return ["j"]
    if t in GATES:
        n = 1 if t in ("NOT", "BUF") else _clamp(p.get("inputs", 2), 1, 8)
        return [f"i{i}" for i in range(n)] + ["o"]
    if t == "MUX":
        n = _clamp(p.get("inputs", 2), 2, 16)
        sel = _clog2(n)
        return [f"d{i}" for i in range(n)] + [f"s{i}" for i in range(sel)] + ["y"]
    if t == "DEMUX":
        n = _clamp(p.get("outputs", 2), 2, 16)
        sel = _clog2(n)
        return ["d"] + [f"s{i}" for i in range(sel)] + [f"y{i}" for i in range(n)]
    if t in ("COMP", "COMPM"):
        w = _clamp(p.get("width", 4), 2, 16)
        outs = ["eq"] if t == "COMP" else ["gt", "lt"]
        if w >= 8:  # bus form
            return ["a", "b"] + outs
        return [f"a{i}" for i in range(w)] + [f"b{i}" for i in range(w)] + outs
    if t == "BUSTAP":
        return ["d", "y"]
    if t == "ENC":
        n = _clamp(p.get("inputs", 4), 4, 16)
        ow = _clog2(n)
        return [f"i{i}" for i in range(n)] + [f"y{i}" for i in range(ow)]
    if t == "DEC":
        n = _clamp(p.get("outputs", 4), 4, 16)
        iw = _clog2(n)
        return [f"a{i}" for i in range(iw)] + ["en"] + [f"y{i}" for i in range(n)]
    if t in FFS:
        ins = {"DFF": ["d", "clk"], "JKFF": ["j", "k", "clk"],
               "TFF": ["t", "clk"], "SRFF": ["s", "r", "clk"]}[t]
        ids = list(ins)
        if p.get("reset"):
            ids.append("rst")
        if p.get("preset"):
            ids.append("pre")
        return ids + ["q", "qn"]
    return []  # known-but-unhandled -> caller treats empty as "unknown pids"


# --------------------------------------------------------------------------- #
# Schema / example returned to the model
# --------------------------------------------------------------------------- #
SCHEMA = {
    "description": "A gate-level schematic project for schematic&bus2vhdl.html. "
                   "Return a single project (recommended) or a bare sheet; save with save_design.",
    "emit_shape": {
        "project": {
            "id": "prj1", "name": "my_project", "topId": "<schId of top sheet>",
            "customs": {},
            "schematics": {"<schId>": "<Sheet>"},
        },
        "note": "You may also send just a bare Sheet {name,components,wires} or a bare "
                "project; the server wraps/normalizes it. Every generated file is the "
                "editor's own deserialize() shape.",
    },
    "sheet": {"id": "sch1", "name": "top (becomes the VHDL entity name)",
              "components": ["<Component>"], "wires": ["<Wire>"]},
    "component": {
        "id": "c1 (unique in the whole payload)",
        "type": "one of the TYPE keys below, or 'SCH:<schId>' / 'CUSTOM:<name>'",
        "x": "int (canvas coords, e.g. multiples of ~88)", "y": "int",
        "params": "type-specific (see type_ports)",
        "label": "OPTIONAL free-text designator; seeds VHDL signal/instance name",
    },
    "wire": {"id": "w1", "from": {"cid": "c1", "pid": "o"},
             "to": {"cid": "c2", "pid": "i0"},
             "name": "OPTIONAL net name (sanitized to a VHDL id)"},
    "type_ports": {
        "IN": "params{name,width}; ports: o(out)",
        "OUT": "params{name,width}; ports: i(in)",
        "VCC": "drives '1'; ports: o", "GND": "drives '0'; ports: o",
        "CONST": "params{value:hexstr,width}; ports: o",
        "JUNCTION": "params{axis?,endpoint?,fixed?}; ports: j (branch/fan-out dot)",
        "AND/OR/NAND/NOR/XOR/XNOR": "params{inputs:2..8,width:1..32}; ports: i0..i(n-1), o",
        "NOT/BUF": "params{inputs:1,width}; ports: i0, o",
        "MUX": "params{inputs:2|4|8|16}; ports: d0..d(n-1), s0..s(sel-1), y",
        "DEMUX": "params{outputs:2|4|8|16}; ports: d, s0..s(sel-1), y0..y(n-1)",
        "COMP": "params{width:2|4|8|16}; width<8: a0..a(n-1),b0..b(n-1),eq ; width>=8: a,b,eq",
        "COMPM": "like COMP but outputs gt,lt",
        "BUSTAP": "params{bit,nbit,mode:split|merge,dir}; ports: d, y",
        "ENC": "params{inputs:4|8|16}; ports: i0..i(n-1), y0..y(ow-1)",
        "DEC": "params{outputs:4|8|16}; ports: a0..a(iw-1), en, y0..y(n-1)",
        "DFF": "params{edge,reset:bool,preset:bool}; ports: d,clk,[rst],[pre],q,qn",
        "JKFF": "ports: j,k,clk,[rst],[pre],q,qn",
        "TFF": "ports: t,clk,[rst],[pre],q,qn",
        "SRFF": "ports: s,r,clk,[rst],[pre],q,qn",
    },
    "rules": [
        "A top-level entity's ports come from IN/OUT marker components on the top sheet.",
        "Every wire endpoint pid MUST be a real port id for that component's type+params "
        "(this server rejects wires that aren't — the editor would silently drop them).",
        "x/y must be numbers. Every id (components+wires+sheet keys) unique in the payload.",
        "7-seg on the EDGE board is common-anode => segments are ACTIVE-LOW.",
        "EDGE clock = 50 MHz on pin H11 (signal 'clk'); e.g. 20 Hz scan divider = /2,500,000.",
    ],
}

EXAMPLE = {
    "project": {
        "id": "prj_ha", "name": "half_adder", "topId": "sch_top", "customs": {},
        "schematics": {
            "sch_top": {
                "id": "sch_top", "name": "half_adder",
                "components": [
                    {"id": "a", "type": "IN", "x": 88, "y": 110, "params": {"name": "a", "width": 1}},
                    {"id": "b", "type": "IN", "x": 88, "y": 250, "params": {"name": "b", "width": 1}},
                    {"id": "gx", "type": "XOR", "x": 320, "y": 120, "params": {"inputs": 2, "width": 1}},
                    {"id": "ga", "type": "AND", "x": 320, "y": 260, "params": {"inputs": 2, "width": 1}},
                    {"id": "s", "type": "OUT", "x": 560, "y": 130, "params": {"name": "sum", "width": 1}},
                    {"id": "co", "type": "OUT", "x": 560, "y": 270, "params": {"name": "carry", "width": 1}},
                ],
                "wires": [
                    {"id": "w1", "from": {"cid": "a", "pid": "o"}, "to": {"cid": "gx", "pid": "i0"}},
                    {"id": "w2", "from": {"cid": "b", "pid": "o"}, "to": {"cid": "gx", "pid": "i1"}},
                    {"id": "w3", "from": {"cid": "a", "pid": "o"}, "to": {"cid": "ga", "pid": "i0"}},
                    {"id": "w4", "from": {"cid": "b", "pid": "o"}, "to": {"cid": "ga", "pid": "i1"}},
                    {"id": "w5", "from": {"cid": "gx", "pid": "o"}, "to": {"cid": "s", "pid": "i"}},
                    {"id": "w6", "from": {"cid": "ga", "pid": "o"}, "to": {"cid": "co", "pid": "i"}},
                ],
            }
        },
    }
}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _safe(name):
    s = re.sub(r"[^\w.-]+", "_", (name or "").strip())
    return s or "design"


def _normalize(obj):
    """Accept a full envelope / bare project / bare sheet and return a
    version-1 bare payload {project, activeId, openTabs} the editor loads."""
    if not isinstance(obj, dict):
        raise ValueError("top level must be a JSON object")
    # already an envelope with a project
    if "project" in obj and isinstance(obj["project"], dict):
        proj = obj["project"]
    elif "schematics" in obj and isinstance(obj["schematics"], dict):
        proj = obj  # bare project
    elif "components" in obj or "wires" in obj:  # bare sheet
        sid = obj.get("id") or "sch1"
        proj = {"id": "prj1", "name": obj.get("name") or "my_project",
                "topId": sid, "customs": {},
                "schematics": {sid: {"id": sid, "name": obj.get("name") or "top",
                                     "components": obj.get("components", []),
                                     "wires": obj.get("wires", [])}}}
    else:
        raise ValueError("unrecognized shape: need a project {schematics:{...}} "
                         "or a bare sheet {components,wires}. See get_schema().")
    proj.setdefault("id", "prj1")
    proj.setdefault("name", "my_project")
    proj.setdefault("customs", {})
    schs = proj.get("schematics") or {}
    if not schs:
        raise ValueError("schematics is empty — include at least one non-empty sheet "
                         "(an empty map is discarded by the editor).")
    proj.setdefault("topId", next(iter(schs)))
    top = proj["topId"]
    return {"project": proj, "activeId": top, "openTabs": [top]}


def _validate(payload):
    """Return a list of human-readable errors (empty = OK)."""
    errs = []
    proj = payload["project"]
    schs = proj.get("schematics") or {}
    seen_ids = {}  # id -> location

    def note(_id, where):
        if not _id:
            errs.append(f"{where}: missing 'id'")
        elif _id in seen_ids:
            errs.append(f"{where}: duplicate id {_id!r} (also at {seen_ids[_id]})")
        else:
            seen_ids[_id] = where

    for sid, sheet in schs.items():
        note(sid, f"schematic key {sid!r}")
        if not isinstance(sheet, dict):
            errs.append(f"schematic {sid!r} is not an object")
            continue
        comps = sheet.get("components")
        wires = sheet.get("wires")
        if not isinstance(comps, list):
            errs.append(f"sheet {sid!r}: 'components' must be a list")
            comps = []
        if not isinstance(wires, list):
            errs.append(f"sheet {sid!r}: 'wires' must be a list")
            wires = []
        by_id = {}
        for i, c in enumerate(comps):
            tag = f"sheet {sid!r} component[{i}] (id={c.get('id')!r})"
            note(c.get("id"), tag)
            if c.get("id"):
                by_id[c["id"]] = c
            t = c.get("type")
            if not t or (t not in KNOWN_TYPES and not t.startswith(("SCH:", "CUSTOM:"))):
                errs.append(f"{tag}: unknown type {t!r} — must be a catalog key or SCH:/CUSTOM:")
            for k in ("x", "y"):
                if not isinstance(c.get(k), (int, float)):
                    errs.append(f"{tag}: '{k}' must be a number (got {c.get(k)!r})")
            if not isinstance(c.get("params"), dict):
                errs.append(f"{tag}: 'params' must be an object (use {{}} if none)")
        # wires: endpoints must reference existing components and real pids
        has_in = any(c.get("type") == "IN" for c in comps)
        has_out = any(c.get("type") == "OUT" for c in comps)
        if sid == proj.get("topId"):
            if not has_in:
                errs.append(f"top sheet {sid!r}: no IN marker (entity would have no inputs)")
            if not has_out:
                errs.append(f"top sheet {sid!r}: no OUT marker (entity would have no outputs)")
        for i, w in enumerate(wires):
            note(w.get("id"), f"sheet {sid!r} wire[{i}]")
            for end in ("from", "to"):
                ref = w.get(end)
                if not isinstance(ref, dict) or "cid" not in ref or "pid" not in ref:
                    errs.append(f"sheet {sid!r} wire[{i}].{end}: needs {{cid,pid}}")
                    continue
                c = by_id.get(ref["cid"])
                if c is None:
                    errs.append(f"sheet {sid!r} wire[{i}].{end}: component id {ref['cid']!r} not found")
                    continue
                valid = port_ids(c)
                if valid is None:
                    continue  # SCH:/CUSTOM: — ports come from another sheet, skip
                if ref["pid"] not in valid:
                    errs.append(f"sheet {sid!r} wire[{i}].{end}: component {ref['cid']!r} "
                                f"(type {c.get('type')}) has no port {ref['pid']!r} — "
                                f"valid: {valid}")
    return errs


def _write(name, payload):
    path = DESIGN_DIR / (_safe(name) + ".schproj.json")
    txt = json.dumps(payload, ensure_ascii=False, indent=2)
    path.write_text(txt, encoding="utf-8")
    (DESIGN_DIR / "latest.json").write_text(txt, encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# tools
# --------------------------------------------------------------------------- #
@mcp.tool()
def get_schema() -> str:
    """Return the JSON schema the gate-level Schematic Studio editor expects.

    Call this BEFORE building a design. You return a single project
    {id,name,topId,customs,schematics:{...}} (recommended) or a bare sheet;
    save it with save_design. type_ports lists every component TYPE and its
    exact port ids — wire endpoints must use those ids.
    """
    return json.dumps(SCHEMA, ensure_ascii=False, indent=2)


@mcp.tool()
def get_example() -> str:
    """Return one worked example (a half-adder: a XOR b = sum, a AND b = carry)."""
    return json.dumps(EXAMPLE, ensure_ascii=False, indent=2)


@mcp.tool()
def save_design(name: str, design: str) -> str:
    """Save a gate-level design so the editor can import it.

    Args:
        name:   file name (no extension), e.g. "half_adder".
        design: the design as a JSON string — a project or a bare sheet matching
                get_schema(). Invalid JSON is rejected with a hint.

    Validates every wire endpoint against the actual port ids its component type
    would generate (a wire pointing at a non-existent port is REJECTED, not
    silently dropped as the editor would), checks unique ids, numeric x/y, known
    types, and that the top sheet has IN/OUT markers. Fix all listed errors and
    call save_design again.

    Writes ./designs_gate/<name>.schproj.json and updates latest.json (loaded by
    the editor's "Sync ⟳" button when this server runs with --serve on :8766).
    """
    try:
        obj = json.loads(design)
    except json.JSONDecodeError as e:
        return f"ERROR: design is not valid JSON ({e}). Fix and call save_design again."
    try:
        payload = _normalize(obj)
    except ValueError as e:
        return f"ERROR: {e}"
    errs = _validate(payload)
    if errs:
        listing = "\n".join(f"  - {e}" for e in errs[:30])
        more = f"\n  ... and {len(errs) - 30} more" if len(errs) > 30 else ""
        return (f"ERROR: design has {len(errs)} problem(s), NOT saved:\n{listing}{more}\n"
                f"Fix these and call save_design again.")
    path = _write(name, payload)
    n = len(payload["project"]["schematics"])
    return (f"Saved {path} ({n} sheet(s)). In the editor click 'Sync ⟳' "
            f"(if running --serve) or open this .schproj.json file.")


@mcp.tool()
def list_designs() -> str:
    """List saved gate-level design files with their sheet counts."""
    out = []
    for p in sorted(DESIGN_DIR.glob("*.schproj.json")):
        try:
            o = json.loads(p.read_text(encoding="utf-8"))
            n = len((o.get("project") or {}).get("schematics") or {})
        except Exception:
            n = "?"
        out.append(f"{p.name}  ({n} sheet(s))")
    return "\n".join(out) or "No designs saved yet."


@mcp.tool()
def read_design(name: str) -> str:
    """Return the JSON of a previously saved design so you can revise it."""
    path = DESIGN_DIR / (_safe(name) + ".schproj.json")
    if not path.exists():
        return f"ERROR: {path.name} not found. Use list_designs()."
    return path.read_text(encoding="utf-8")


@mcp.resource("schstudio://schema")
def schema_resource() -> str:
    """The editor's JSON schema, as a resource."""
    return json.dumps(SCHEMA, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------------- #
# optional local HTTP bridge for the app's "Sync" button (mirrors topdown)
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
        if (target.suffix == ".json"
                and target.resolve().parent == DESIGN_DIR.resolve()
                and target.exists()):
            self._send(200, target.read_bytes())
        else:
            self._send(404, b'{"error":"not found"}')

    def log_message(self, *a):  # quiet
        pass


def run_bridge():
    # Bind first, then log. Log to stderr (stdout is the MCP JSON-RPC channel) and
    # never interpolate a non-ASCII path here: Claude Desktop launches this process
    # with a cp1252 stdout, so printing a Thai path used to raise UnicodeEncodeError
    # and kill this thread before serve_forever() — leaving nothing listening.
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
                    help="also run the HTTP bridge for the app's Sync button (:8766)")
    args = ap.parse_args()
    if args.serve:
        threading.Thread(target=run_bridge, daemon=True).start()
    mcp.run()  # stdio transport for Claude Desktop / Code
