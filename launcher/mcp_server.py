"""
mcp_server.py - FPGA Ecosystem as an MCP server, so Claude can work in Schematic Studio.

Claude (Desktop / Code / any MCP client) starts this over stdio. Every tool call is
forwarded to the running FPGA Ecosystem app (started here if needed), which hands it to
the open Schematic Studio window; the editor executes it with its own engine and the
user watches it happen. Nothing here re-implements the editor: placement, routing,
checks, simulation, pin mapping and VHDL all come from the editor itself.

Pure standard library (no `pip install mcp`). Protocol: MCP over stdio, JSON-RPC 2.0,
one message per line.

    python launcher/mcp_server.py          # from source
    FPGAEcosystem-MCP.exe                  # installed (console build)
    FPGAEcosystem.exe --mcp                # installed (fallback)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SERVER_NAME = "fpga-ecosystem"
PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]
HERE = Path(__file__).resolve().parent

INSTRUCTIONS = """\
You are connected to FPGA Ecosystem — the desktop app for a digital-logic lab on the EDGE Spartan-7 (XC7S15) FPGA
board: Schematic Studio (gate-level schematic editor + simulator), a ลงบอร์ด page (Vivado builds the .bit,
openFPGALoader loads it) and a Top-Down view (block diagrams for the lab report). Students use it in Thai.
Every change you make is drawn live in the user's editor window and can be undone (Ctrl+Z / `undo`).

Start with `about`: the app version, whether a newer version is out (tell the user, with what's new — they update
from Home, `open_home`), which workspace/projects exist, and whether Vivado / openFPGALoader / the board's USB driver
are ready (before promising a .bit or programming the board). New work: `new_project`, or open one with
`list_projects` → `open_project`.

Good workflow:
1. `status` → see the project and sheets; `get_sheet` → parts, pins (with coordinates) and nets.
2. Build: `build_circuit` (truth table / generators / intent) for whole circuits, or `add_component` + `connect`
   (or `apply` for many steps at once, all-or-nothing) for edits.
3. Verify: `check` (design-rule errors with fixes), `simulate` / `verify_truth_table` / `probe`, and
   `explain_simulation` when results look wrong. Always check before telling the user a design is done.
4. Look: `layout_report` (overlaps, wires through parts) and `screenshot`; tidy with `auto_layout`.
5. Board: `board_pins` → `set_pins` or `auto_pins` → `get_pins` (conflicts / unassigned) → `get_xdc`.
6. Deliver: `get_vhdl`, `export_files` (writes .vhd/.xdc into the project folder), `save_project`.
7. On the board: `board_build` (Vivado makes the .bit, ~1-3 min) → `board_status` until done → `board_program`
   (load into the FPGA; writing the Flash permanently is only ever done by the user on the ลงบอร์ด page).

References: a component is its id ("c12"), an INPUT/OUTPUT name ("a", "sum") or a label ("U1");
a pin is "<component>.<pin>" ("U1.i0", "ff0.q"). A bare component means its output (as a wire source)
or its first free input (as a wire sink). Truth tables list rows with the FIRST input as the MSB.
Sub-circuits are other sheets placed as "block:<sheet name>". Use `get_events` to see what the user changed.
Prefer small verified steps; call `notify_user` to tell the user something inside the editor.

THE USER'S OWN SHEETS: `get_sheet` is always the live, current drawing — never answer from a saved file. When a
sheet the user placed / arranged has a wrong connection, fix it IN PLACE with `disconnect` + `connect` (or
`update_component`) so their placement and wiring stay; never rebuild it (`build_circuit` into the same name,
`auto_layout`) or replace it from a file unless they ask. The user watches each change appear.

LAB / TOP-DOWN WORK — always in this order, never skip or reorder a step:
  A. Schematic: build the real circuit in Schematic Studio (gate level; one sheet per sub-circuit, placed
     on its parent as "block:<sheet>"; set_top_sheet on the top one).
  B. Simulate: check + simulate / verify_truth_table every sheet, fix what fails, and tell the user the results.
  C. Approval: request_approval with a short summary (blocks, what the simulation showed), then call
     approval_status until it is no longer "waiting". If the user asks for changes, make them, go back to B,
     and ask again. Do not continue without "approved".
  D. Top-Down: make_topdown — it draws the approved circuit's layers in the Top-Down view.
TESTING THE APP'S OWN AI: `ai_model` (start/stop the local model, see its log), `ai_chat` (send a chat message,
mode 'agent' for the local model working with tools) and `ai_chat_status` (the transcript: thinking, tool calls,
errors). Use these when the user asks you to test or improve the AI feature; report what the local model got wrong.
Never write Top-Down JSON by hand or use another server's save_design / Sync: the Top-Down must come from the
approved, simulated circuit (make_topdown refuses anything else)."""


# --------------------------------------------------------------------------- tools
def T(name, desc, props=None, required=None, timeout=60):
    schema = {"type": "object", "properties": props or {}, "additionalProperties": False}
    if required:
        schema["required"] = required
    return {"name": name, "description": desc, "inputSchema": schema, "_timeout": timeout}


SHEET = {"type": "string", "description": "Sheet name or id. Default: the active sheet."}
REF = {"type": "string", "description": "Component: id, INPUT/OUTPUT name, or label."}
PIN = {"type": "string", "description": "Pin reference 'component.pin' (e.g. 'U1.i0', 'ff0.q') or a bare component."}
INPUTS = {"type": "object", "description": "INPUT name → 0/1.", "additionalProperties": {"type": "integer", "enum": [0, 1]}}

TOOLS = [
    # --- the app itself (answered by the app, no editor window needed)
    T("about", "Which app and version this is, whether an update is available (version + what's new), the workspace "
      "and number of projects, whether the editor window is open, and whether the board toolchain is ready "
      "(Vivado, openFPGALoader, flash bridge, USB driver) and the local AI model. Call this first."),
    T("check_update", "Ask GitHub now whether a newer FPGA Ecosystem is out (about uses a cached answer ≤12 h old)."),
    T("open_home", "Open the app's Home window: 'home' (projects, update banner — the user clicks อัปเดตเลย), "
      "'setup' (first-run checklist: Vivado / openFPGALoader / USB driver / AI model) or 'settings'.",
      {"tab": {"type": "string", "enum": ["home", "setup", "settings"]}}),
    # --- looking at the design
    T("status", "Project, sheets (with part/wire counts), active and top sheet, unsaved changes. Start here."),
    T("list_component_types", "Every placeable component type with its default params and pin names."),
    T("get_sheet", "A sheet as data: ports, components (type, name, position, size, params, pins with x/y and "
      "whether connected) and nets (driver → sinks, with problems such as 'no driver' or 'multiple drivers').",
      {"sheet": SHEET, "detail": {"type": "string", "enum": ["full", "brief"], "description": "brief = no positions/pins."}}),
    T("get_netlist", "Only the connectivity of a sheet: each net's driver pin, sink pins, name and problems.", {"sheet": SHEET}),
    T("screenshot", "PNG image of the sheet as the user sees it (problem markers included unless show_problems=false).",
      {"sheet": SHEET, "fit": {"type": "boolean", "description": "Zoom to fit first (default true)."},
       "show_problems": {"type": "boolean"}}, timeout=40),
    T("get_events", "What happened in the editor since sequence number `since` (user edits, issue count changes). "
      "Use it to follow along with the user.", {"since": {"type": "integer"}}),
    # --- sheets
    T("open_sheet", "Make a sheet the active tab (the user sees it).", {"sheet": SHEET}, ["sheet"]),
    T("new_sheet", "Create an empty sheet (a new sub-circuit or top level).",
      {"name": {"type": "string"}, "make_top": {"type": "boolean"}}, ["name"]),
    T("delete_sheet", "Delete a sheet (undo brings it back). Refused when another sheet uses it as a block, unless "
      "force (the block instances go too); the last sheet stays.", {"sheet": SHEET, "force": {"type": "boolean"}}, ["sheet"]),
    T("rename_sheet", "Rename a sheet.", {"sheet": SHEET, "name": {"type": "string"}}, ["sheet", "name"]),
    T("set_top_sheet", "Choose which sheet is the top entity (what goes to the board).", {"sheet": SHEET}, ["sheet"]),
    # --- editing
    T("add_component", "Place one component. type: a type from list_component_types (AND, OR, NOT, XOR, NAND, NOR, "
      "XNOR, BUF, IN, OUT, VCC, GND, CONST, MUX, DFF, JKFF, TFF, SRFF, …) or 'block:<sheet name>' for a sub-circuit. "
      "Without x/y it goes to a free spot right of the drawing. Returns the part with its pins.",
      {"sheet": SHEET, "type": {"type": "string"}, "name": {"type": "string", "description": "INPUT/OUTPUT port name, or a label for other parts."},
       "width": {"type": "integer", "description": "Bus width for IN/OUT (default 1)."},
       "params": {"type": "object", "description": "Type params, e.g. {\"inputs\":3} for a 3-input gate, {\"reset\":true} for a DFF with reset."},
       "x": {"type": "number"}, "y": {"type": "number"}, "rot": {"type": "integer", "enum": [0, 90, 180, 270]}},
      ["type"]),
    T("connect", "Wire an output pin to an input pin (fan-out is fine; an input takes one driver). "
      "Give from/to, or `connections` [[from,to],…] for several. The new wires are routed. One bit of a bus pin "
      "takes an index — 'a', 'y.i[2]' or 's.o[3]', 'z' — and the bus tap is placed for you.",
      {"sheet": SHEET, "from": PIN, "to": PIN,
       "connections": {"type": "array", "items": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 2}},
       "net_name": {"type": "string"}}),
    T("disconnect", "Remove wiring: `pin` drops every wire on that pin; `from`+`to` removes one connection.",
      {"sheet": SHEET, "pin": PIN, "from": PIN, "to": PIN}),
    T("delete", "Delete components (and their wires). A net a deleted part drove is removed with it (no leftover "
      "wiring still 'driving' its sinks); the inputs it fed come back as now_unconnected.", {"sheet": SHEET, "refs": {"type": "array", "items": {"type": "string"}}}, ["refs"]),
    T("update_component", "Rename, change params, change a basic gate's type, move (x/y) or rotate a component.",
      {"sheet": SHEET, "ref": REF, "name": {"type": "string"}, "params": {"type": "object"},
       "type": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"},
       "rot": {"type": "integer", "enum": [0, 90, 180, 270]}}, ["ref"]),
    T("apply", "Run several edit steps as one transaction — if a step fails nothing changes (unless keep_going). "
      "Each step is {\"op\": \"add_component\"|\"connect\"|\"disconnect\"|\"delete\"|\"update_component\"|\"set_pins\", …that tool's args}.",
      {"sheet": SHEET, "steps": {"type": "array", "items": {"type": "object"}}, "keep_going": {"type": "boolean"}}, ["steps"]),
    T("build_fsm", "Build a state machine from its state diagram: binary encoding (reset state = 0), minimised next-state "
      "and output logic, D flip-flops — then run clock by clock against the diagram before it is handed over (verified). "
      "fsm as text: 'inputs: x\\noutputs: z\\nstate S0: z=0\\nstate S1: z=1\\nS0 -> S1 when x\\nS0 -> S0 else\\nS1 -> S0 when ~x\\nreset S0' "
      "(Mealy: 'S0 -> S1 when x / z=1'; conditions & | ^ ~ ( ) else) or an object {inputs, outputs, states:[{name,out}], "
      "transitions:[{from,to,when,out?}], reset}. Ports: clk, the inputs, the outputs, state bits (state_out:false drops them).",
      {"fsm": {"type": ["string", "object"]}, "sheet": SHEET, "name": {"type": "string"}, "state_out": {"type": "boolean"}},
      ["fsm"], timeout=90),
    T("make_report", "Write the lab report into the project folder (<project>_report.html): every sheet (top first, then its "
      "blocks) as a picture, ports, truth table + minimised equations or the first 16 clocks, state diagram, acceptance "
      "test, board pin table, VHDL. The user prints it to PDF.",
      {"sheets": {"type": "array", "items": {"type": "string"}}, "vhdl": {"type": "boolean"}}, timeout=90),
    T("board_check", "Before building the .bit: what will go wrong on the real EDGE board — ports without a pin, two ports "
      "on one pin, an input on an LED, 7-seg segments written active-high for this common-anode display, no digit "
      "enabled (an), a clock from a bouncing push button, a counter on the raw 50 MHz clock. Default sheet: the one "
      "the ลงบอร์ด page builds.", {"sheet": SHEET}),
    T("suggest_wires", "Wiring hints for the unconnected pins of a sheet: blocks of one kind in a row chain carry-like pins "
      "(cout→cin, x_out→x_in), a block input named like a sheet INPUT takes it (clk, rst, en; a2 or bit 2 of bus a for "
      "the block labelled …2), a sheet OUTPUT named like a block output takes it. Each hint has a reason; apply:true "
      "wires them all (one undo step).", {"sheet": SHEET, "apply": {"type": "boolean"}}),
    T("board_troubleshoot", "The real board does not do what the simulation did: give the symptom (load, darkx, map, "
      "segpol, segan, segmap, fast, stuck, bounce, btninv; none = list them) and get the causes checked on this design "
      "(pins, polarity, clock source, reset, stale .bit) plus what to try.", {"sheet": SHEET, "symptom": {"type": "string"}}),
    T("set_spec", "Say what a sheet MUST do — its acceptance test, written from the requirement (never from the circuit): "
      "formula (\"sum = a^b^cin; cout = …\"), table ({out:\"0110…\"}, first input = MSB) or sequence ({expect:{q:[0,1,2,…]}, "
      "inputs:[{name:value} per clock], cycles}). The app re-checks it after every change (✓/✗ on the sheet) and a pass marks "
      "the sheet verified. Set it FIRST, then build until check_spec passes.",
      {"sheet": SHEET, "formula": {"type": ["string", "array"], "items": {"type": "string"}}, "table": {"type": "object"},
       "sequence": {"type": "object"}}),
    T("check_spec", "Run a sheet's acceptance test (or every sheet's with all_sheets) and get pass / the mismatches.",
      {"sheet": SHEET, "all_sheets": {"type": "boolean"}}),
    T("list_parts", "The part library: standard circuits (adders, subtractors, comparator, mux/demux, decoder, encoder, "
      "BCD→7-seg, parity, majority, counters, clock divider, shift register, register, toggle, edge detector, debounce) "
      "with their parameters and ports. `query` filters.", {"query": {"type": "string"}}),
    T("build_part", "Build a standard circuit from the part library on a sheet — generated by code and CHECKED against a "
      "reference model before it is drawn (every row, or 300 vectors / a clock-by-clock run), so it is right by construction "
      "and marked verified. Prefer this over drawing gates or typing truth tables. Place it on other sheets as block:<sheet>.",
      {"kind": {"type": "string", "description": "a kind from list_parts, e.g. full_adder, adder, mux, bcd_7seg, mod_counter, clock_divider"},
       "n": {"type": "integer", "description": "size: bits / inputs / modulus / divisor, per kind"},
       "bus": {"type": "boolean", "description": "a0..a3 → one bus port a[3:0]"},
       "cin": {"type": "boolean"}, "en": {"type": "boolean"}, "odd": {"type": "boolean"}, "active_low": {"type": "boolean"},
       "output": {"type": "string", "enum": ["clk_out", "q"]},
       "sheet": {"type": "string", "description": "sheet to build on (created, or an empty one filled)"},
       "name": {"type": "string", "description": "entity name when no sheet is given"}}, ["kind"], timeout=90),
    T("build_circuit", "Create a whole circuit, minimised and laid out by the editor, on a new sheet. One of:\n"
      "• formula: equations — \"sum = a ^ b ^ cin; cout = a&b | cin&(a^b)\" or \"{cout,sum} = a + b + cin\" (& | ^ ~ ' and/or/xor/not; "
      "{…} on the left = arithmetic, MSB first). The truth table is computed for you — prefer this to typing columns.\n"
      "• truth_table: {inputs:[...], outputs:[...], columns:{out:\"0110…\"}} (one char per row, 0/1/x, first input = MSB; "
      "into:\"current\" fills a sheet that has exactly those ports, e.g. a lab template)\n"
      "• generator: {kind: mod_counter|jk_counter|sequence_counter|ripple_counter|shift_register|register|bcd_7seg, n, sequence, active_low} — "
      "jk_counter = synchronous JK-FF counter / clock divider like the lab's (clk_in → clk_out = MSB; output:'q' gives q0..qN; clk / output rename); "
      "clock_divider = divide clk_in by ANY n (2..2^31, e.g. 50 MHz → 20 Hz: n=2500000), one sheet, 50 % duty for even n\n"
      "• intent: {module, components:[{id,type,name?}], nets:[{from:'id.pin', to:'id.pin'}]} — a sub-circuit is "
      "type 'block:<sheet name>', its pins are that sheet's port names and must be spelled ('cnt.en', 'cnt.q')",
      {"name": {"type": "string"}, "truth_table": {"type": "object"}, "generator": {"type": "object"},
       "intent": {"type": "object"}, "into": {"type": "string", "enum": ["new", "current"]},
       "formula": {"type": ["string", "array"], "items": {"type": "string"}},
       "inputs": {"type": "array", "items": {"type": "string"}, "description": "formula: input order (first = MSB); default: order of appearance"},
       "sheet": {"type": "string", "description": "Sheet to build on: a new name creates that sheet, an existing EMPTY "
                                                  "sheet is filled (one with parts is refused). Default: a new sheet named after `name`."},
       "bus": {"type": ["boolean", "array"], "items": {"type": "string"},
               "description": "Numbered ports become one bus port: true = every group (q0..q3 → q[3:0], yu0..yu3 → yu[3:0]), "
                              "or a list of group names ['q']. Bit i = the number in the name; bus taps are drawn for you."}},
      timeout=90),
    T("make_bus_ports", "Turn numbered INPUT/OUTPUT ports of a sheet (q0..q3) into one bus port each (q, 4 bits) with bus taps, "
      "keeping the drawing. Only for a sheet no other sheet uses as a block yet (their wiring would come loose).",
      {"sheet": SHEET, "ports": {"type": "array", "items": {"type": "string"}, "description": "group names, e.g. ['q','yu']; default: all"}}),
    # --- layout
    T("auto_layout", "Re-place and route the whole sheet (mode 'full'), or only re-route wires keeping parts ('wires_only').",
      {"sheet": SHEET, "mode": {"type": "string", "enum": ["full", "wires_only"]}, "lock": {"type": "boolean"}}, timeout=120),
    T("layout_report", "Drawing quality: wire overlaps, wires through parts/pins, overlapping parts, bounding box, score (lower = tidier).",
      {"sheet": SHEET}),
    T("lock_layout", "Lock (or unlock) a sheet so nothing gets re-routed automatically.", {"sheet": SHEET, "locked": {"type": "boolean"}}),
    # --- verification
    T("check", "Design-rule check (what Vivado would reject + common mistakes): errors and warnings with the "
      "component and a suggested fix.", {"sheet": SHEET, "all_sheets": {"type": "boolean"}}),
    T("simulate", "Simulate a sheet. Combinational: full truth table (rows 'inputs → outputs', and per-output columns) "
      "up to 10 input bits; for more, or to check chosen rows, give `vectors` [{input: value, …}, …] (≤256, inputs "
      "left out are 0, bus values as in probe). "
      "Sequential: `cycles` clock pulses on every INPUT that drives a flip-flop clock, other inputs held at `inputs` (default 0), "
      "or `vectors` = the inputs during each clock ([{x:1},{x:1},{x:0},…]; the last one stays).",
      {"sheet": SHEET, "cycles": {"type": "integer", "minimum": 1, "maximum": 256}, "inputs": INPUTS,
       "vectors": {"type": "array", "items": {"type": "object"}, "maxItems": 256}}),
    T("verify_truth_table", "Compare a combinational sheet against what it MUST do: expected output columns ({out:\"0110…\"}, "
      "x = don't care) or a formula written from the requirement (\"sum = a^b^cin; cout = …\"). Returns pass, the mismatching "
      "rows, `recognized` (the standard circuit it is, if any) and `independent` — an expectation identical to what the sheet "
      "was built from proves nothing and does not count as verified.",
      {"sheet": SHEET, "expected": {"type": "object"}, "formula": {"type": ["string", "array"], "items": {"type": "string"}}}),
    T("probe", "Set inputs and read every net's value (combinational evaluation) — find where a signal goes wrong. "
      "A bus INPUT takes its whole value: 5, \"0101\" (binary as wide as the bus), \"0b0101\" or \"0x5\"; "
      "a bus OUTPUT comes back as {value, bin}. Comparators, encoders, decoders, (de)muxes, bus taps are all evaluated.",
      {"sheet": SHEET, "inputs": INPUTS}),
    T("explain_simulation", "Likely reasons a simulation doesn't behave as expected (clock not reaching FFs, reset stuck, "
      "gated clock, floating pins, multi-driver, constant outputs, unused inputs, divider chains).", {"sheet": SHEET}),
    # --- board
    T("board_pins", "Every board target you can assign: switches sw:0-15, buttons pb:0-4, clk (50 MHz), leds led:0-15, "
      "7-seg seg:a-g/dp, digit selects an:0-3, buzzer — with package pins."),
    T("get_pins", "Current pin assignment of a sheet's ports (bus bits as name[i]), unassigned ports and conflicts.", {"sheet": SHEET}),
    T("set_pins", "Assign ports/bits to board targets, e.g. {\"a\":\"sw:0\", \"seg[6]\":\"seg:a\", \"clk\":\"clk\"}; null clears.",
      {"sheet": SHEET, "map": {"type": "object"}}, ["map"]),
    T("auto_pins", "Fill pin assignments automatically (mode 'missing' keeps existing ones, 'all' redoes them).",
      {"sheet": SHEET, "mode": {"type": "string", "enum": ["missing", "all"]}}),
    T("get_xdc", "The Vivado constraints (.xdc) the sheet's pin map produces, and which ports are still unassigned.", {"sheet": SHEET}),
    # --- the real board
    T("board_build", "Build the .bit with Vivado (the ลงบอร์ด page opens so the user sees the log). `sheet` = which "
      "sheet is the top entity — a sub-circuit can be built and tested on the board by itself (default: the sheet "
      "the board page has, else top). Every port of that sheet needs a board pin first (get_pins / auto_pins). "
      "Returns at once — then call board_status.",
      {"sheet": SHEET}, timeout=40),
    T("board_program", "Load the last .bit into the FPGA over USB (temporary, lost at power-off), or 'detect' to "
      "check the board answers. Permanent Flash writing is left to the user (💾 on the ลงบอร์ด page).",
      {"sheet": SHEET, "mode": {"type": "string", "enum": ["sram", "detect"]},
       "cable": {"type": "string", "description": "openFPGALoader cable (default ft2232)"}}, timeout=40),
    T("board_status", "Wait (≤`wait` s, max 40) for the running build / program job, then report state "
      "(running / ok / error), the last log lines, a Thai explanation of an error, and whether a .bit exists and "
      "matches the circuit.", {"wait": {"type": "integer", "minimum": 1, "maximum": 40}}, timeout=55),
    # --- output
    T("get_vhdl", "Generated VHDL: the whole bundle for the top sheet, or one entity.", {"entity": {"type": "string"}}),
    T("export_files", "Write files into the project's folder in the user's workspace: vhdl, xdc, project.",
      {"what": {"type": "array", "items": {"type": "string", "enum": ["vhdl", "xdc", "project"]}}, "sheet": SHEET}),
    T("save_project", "Save the project file (.schproj.json) into the workspace project folder."),
    T("new_project", "Start a new, empty project in the editor (with one blank top sheet) and switch to it. The "
      "previous project stays open in the editor's project list. Name it like the lab, e.g. 'lab6_counter'.",
      {"name": {"type": "string"}}, ["name"]),
    T("list_projects", "Projects saved in the user's workspace folder (paths usable with open_project)."),
    T("open_project", "Open a saved project from the workspace (replaces what's on screen; a checkpoint is kept).",
      {"path": {"type": "string", "description": "e.g. 'lab4/lab4.schproj.json'"}}, ["path"]),
    # --- history & collaboration
    T("undo", "Undo the last change (yours or the user's)."),
    T("redo", "Redo."),
    T("checkpoint", "Save a named restore point in the editor's history.", {"label": {"type": "string"}}),
    T("list_checkpoints", "Restore points (automatic and named)."),
    T("restore_checkpoint", "Go back to a restore point (the current state is kept as a new one first).", {"id": {"type": "integer"}}, ["id"]),
    T("focus", "Select a component and centre the user's view on it.", {"sheet": SHEET, "ref": REF}, ["ref"]),
    # --- lab workflow: approval, then Top-Down
    T("request_approval", "Ask the user to approve the circuit before the Top-Down is made. Shows your summary in a "
      "card in the editor with 'approve' / 'request changes'. Returns at once — then call approval_status.",
      {"summary": {"type": "string", "description": "What you built (sheets/blocks) and what the simulation showed. Plain text; Thai is fine."}},
      ["summary"]),
    T("approval_status", "Wait (up to `wait` seconds, max 40) for the user's answer to request_approval: "
      "'waiting' (call again), 'approved' (then make_topdown), 'changes' (with the user's comment), or 'none'.",
      {"wait": {"type": "integer", "minimum": 1, "maximum": 40}}, timeout=55),
    T("make_topdown", "Draw the APPROVED circuit in the Top-Down view: the top sheet and every sheet it uses as a block, "
      "as layers (1st Layer (top), 2nd Layer (…), …). Refuses unless the user approved exactly the circuit on screen.",
      {"sheet": {"type": "string", "description": "Top sheet to start from. Default: the project's top sheet."}}),
    # --- the course (RAG)
    T("search_course", "Search the course material that ships with the app: textbook chapters, the lab sheets "
      "(with worked solutions), the EDGE board's pins and peripherals, and checked VHDL examples. Use it to "
      "follow how the course does something (a lab's requirements, a design method, a board connection).",
      {"query": {"type": "string"}, "k": {"type": "integer", "minimum": 1, "maximum": 12},
       "group": {"type": "string", "enum": ["content", "lab", "board", "vhdl_ref"],
                 "description": "content = chapters, lab = lab sheets, board = pins/peripherals, vhdl_ref = VHDL"}},
      ["query"]),
    # --- the module library (the Modules tab, shared by every project)
    T("list_modules", "Modules in the user's library (the Modules tab, shared across projects): name, description, "
      "ports, part count, the sub-blocks each carries. `query` filters by name / description / port names.",
      {"query": {"type": "string"}}),
    T("save_module", "Save a sheet (with every sheet it uses as a block) into the module library, so it can be reused "
      "in any project. Default: the active sheet, named after it.",
      {"sheet": SHEET, "name": {"type": "string"}, "description": {"type": "string"},
       "replace": {"type": "boolean", "description": "overwrite a module with the same name"},
       "force": {"type": "boolean", "description": "save a sheet that is not verified (only when the user asks for it)"}}),
    T("use_module", "Place a library module on a sheet as a block (its sheet is brought into the project once, then "
      "reused). Returns the block with its pins — connect them like any part.",
      {"module": {"type": "string", "description": "module name or id"}, "sheet": SHEET,
       "name": {"type": "string", "description": "label for the block"}, "x": {"type": "number"}, "y": {"type": "number"}},
      ["module"]),
    T("open_module", "Open a library module as a new sheet (a copy) to look at or change it.",
      {"module": {"type": "string"}}, ["module"]),
    T("delete_module", "Remove a module from the library (sheets already brought into projects stay). Only when the user asks.",
      {"module": {"type": "string"}}, ["module"]),
    # --- the app's own AI (the chat panel + the local model): drive it to test / debug it
    T("ai_model", "The local AI model the app runs (llama.cpp): status (state, model, installed catalog, llama-server "
      "log), start {model: catalog id like 'qwen3.5-9b' or a .gguf path}, stop, or download {model: id | 'llama.cpp'}.",
      {"action": {"type": "string", "enum": ["status", "start", "stop", "download"]},
       "model": {"type": "string"}, "wait": {"type": "integer", "minimum": 5, "maximum": 40}}, timeout=55),
    T("ai_chat", "Type a message into the editor's AI chat panel and send it, exactly as the user would (the user "
      "sees it). mode: 'agent' = the local model works step by step with the editor's tools (a core set of these "
      "same tools); 'build' = the older one-shot circuit pipeline; 'qa' = questions. Returns at once — then "
      "ai_chat_status. Use it to test the app's AI feature and find what goes wrong.",
      {"message": {"type": "string"}, "mode": {"type": "string", "enum": ["agent", "build", "qa"]}}, ["message"]),
    T("ai_chat_status", "Wait (≤`wait` s) for the chat to finish the message sent with ai_chat, then return what "
      "appeared in the chat and, for agent mode, the run: every step (the model's thinking, each tool call with its "
      "arguments and result or error, nudges), the final answer, model calls, tokens and time. detail:'full' "
      "includes the complete tool results and thinking.",
      {"wait": {"type": "integer", "minimum": 1, "maximum": 40}, "detail": {"type": "string", "enum": ["steps", "full"]}},
      timeout=55),
    T("notify_user", "Show a short message to the user inside the editor.",
      {"message": {"type": "string"}, "level": {"type": "string", "enum": ["info", "warn"]}}, ["message"]),
]
TOOL_MAP = {t["name"]: t for t in TOOLS}
APPLY_OPS = ["add_component", "connect", "disconnect", "delete", "update_component", "set_pins"]


def fields_of(name):
    """'refs* (array), sheet' — a tool's fields, required ones starred."""
    sch = TOOL_MAP[name]["inputSchema"]
    req = set(sch.get("required", []))
    return ", ".join(f"{k}{'*' if k in req else ''} ({v.get('type', 'any')})" for k, v in sch["properties"].items())


# the apply step fields, spelled out (they used to be guessed: delete takes `refs`, not target/components)
_apply = TOOL_MAP["apply"]
_apply["description"] += " Step fields (* = required): " + "; ".join(
    f"{op}: {fields_of(op).replace('sheet (string), ', '').replace(', sheet (string)', '')}" for op in APPLY_OPS) + \
    ". Steps run in order and each sees the ones before it (delete then connect to the freed pin works)."

# the tools the LOCAL model gets in the editor's agent mode (18-ai-agent.js): the editing,
# checking and simulating core — a 4–9B model does better with ~20 tools than with all of them
AGENT_TOOLS = ["status", "get_sheet", "get_netlist", "list_component_types", "open_sheet", "new_sheet",
               "set_top_sheet", "add_component", "connect", "disconnect", "delete", "update_component", "apply",
               "build_part", "list_parts", "build_fsm", "set_spec", "check_spec",
               "build_circuit", "make_bus_ports", "check", "simulate", "verify_truth_table", "probe", "explain_simulation",
               "get_pins", "set_pins", "auto_pins", "board_check", "board_troubleshoot", "suggest_wires", "undo", "list_modules", "use_module", "save_module", "search_course"]


def openai_tools(names=None):
    """The tools as OpenAI-style function definitions (what llama-server --jinja expects)."""
    out = []
    for n in names or AGENT_TOOLS:
        t = TOOL_MAP[n]
        out.append({"type": "function", "function": {"name": n, "description": t["description"],
                                                     "parameters": t["inputSchema"]}})
    return out


# names people (and models) reach for first → the field the tool actually has
ALIASES = {
    "*": {"sheet": ["sheet_name", "sheetName", "schematic"]},
    "delete": {"refs": ["ref", "components", "component", "ids", "id", "targets", "target", "names", "name", "parts"]},
    "update_component": {"ref": ["target", "component", "id"]},
    "focus": {"ref": ["target", "component", "id", "name"]},
    "connect": {"from": ["source", "src", "driver"], "to": ["dest", "sink", "target"]},
    "disconnect": {"pin": ["target", "ref"]},
    "add_component": {"name": ["label"]},
    "set_pins": {"map": ["pins", "pinmap", "mapping"]},
    "use_module": {"module": ["name", "id", "ref"]},
    "open_module": {"module": ["name", "id", "ref"]},
    "delete_module": {"module": ["name", "id", "ref"]},
    "simulate": {"inputs": ["hold"]},
    "search_course": {"query": ["q", "text", "question"]},
    "build_part": {"kind": ["part", "type"], "n": ["bits", "size", "width", "inputs", "modulus", "divisor", "N"]},
}


def normalize_args(name, args):
    """Rename known aliases, then refuse fields the tool does not have — naming the ones it does.
    Returns (args, error)."""
    tool = TOOL_MAP[name]
    props = tool["inputSchema"]["properties"]
    args = dict(args or {})
    alias = dict(ALIASES["*"], **ALIASES.get(name, {}))
    for field, names in alias.items():
        if field not in props or field in args:
            continue
        for a in names:
            if a in args and a not in props:
                v = args.pop(a)
                if props[field].get("type") == "array" and not isinstance(v, list):
                    v = [v]
                args[field] = v
                break
    unknown = [k for k in args if k not in props]
    if unknown:
        return args, (f"{name}: unknown field{'s' if len(unknown) > 1 else ''} {', '.join(repr(k) for k in unknown)}"
                      f" — {name} takes: {fields_of(name) or '(no fields)'}")
    missing = [k for k in tool["inputSchema"].get("required", []) if k not in args]
    if missing:
        return args, f"{name}: missing {', '.join(repr(k) for k in missing)} — {name} takes: {fields_of(name)}"
    if name == "apply":
        steps = args.get("steps")
        if not isinstance(steps, list):
            return args, "apply: steps must be a list of {op, …}"
        fixed = []
        for i, st in enumerate(steps, 1):
            if not isinstance(st, dict) or st.get("op") not in APPLY_OPS:
                return args, f"apply step {i}: op must be one of {', '.join(APPLY_OPS)}"
            body, e = normalize_args(st["op"], {k: v for k, v in st.items() if k != "op"})
            if e:
                return args, f"apply step {i}: {e}"
            fixed.append(dict(body, op=st["op"]))
        args["steps"] = fixed
    return args, None
LOCAL_TOOLS = {"list_projects", "about", "check_update", "open_home"}   # answered by the app itself, no editor needed

RESOURCES = [
    {"uri": "fpga://guide", "name": "How to work with Schematic Studio", "mimeType": "text/markdown"},
    {"uri": "fpga://board/edge-spartan7", "name": "EDGE Spartan-7 board targets and pins", "mimeType": "application/json"},
    {"uri": "fpga://sheet/active", "name": "The active sheet (parts, pins, nets)", "mimeType": "application/json"},
    {"uri": "fpga://component-types", "name": "Component types and their pins", "mimeType": "application/json"},
]
PROMPTS = [
    {"name": "design_from_spec", "description": "Design, verify and pin-map a circuit from a description.",
     "arguments": [{"name": "spec", "description": "What the circuit should do", "required": True}]},
    {"name": "debug_simulation", "description": "Find out why the current sheet doesn't simulate as expected.",
     "arguments": [{"name": "expected", "description": "What you expected to see", "required": False}]},
    {"name": "prepare_for_board", "description": "Check, assign pins and export VHDL + XDC for the board.", "arguments": []},
    {"name": "lab_topdown", "description": "A lab: schematic → simulate → the user approves → Top-Down.",
     "arguments": [{"name": "spec", "description": "The lab assignment / what the circuit must do", "required": True}]},
]


def prompt_text(name, args):
    if name == "design_from_spec":
        return (f"Design this in Schematic Studio: {args.get('spec', '')}\n"
                "Plan the ports first, then build (build_circuit when a truth table or generator fits, otherwise "
                "add_component/connect via apply). Then run check and simulate/verify_truth_table and fix every error. "
                "Use layout_report and auto_layout so the drawing is clean, assign pins with auto_pins/set_pins, and "
                "finish with a short summary and a screenshot.")
    if name == "debug_simulation":
        return ("The current sheet doesn't simulate as expected" + (f" (expected: {args['expected']})" if args.get("expected") else "") +
                ". Use explain_simulation, check, simulate and probe to find the cause; show the user where it is with focus, "
                "propose the fix and apply it only after explaining it.")
    if name == "lab_topdown":
        return (f"Lab assignment: {args.get('spec', '')}\n"
                "Work strictly in this order. (A) Build the circuit in Schematic Studio: plan the blocks, one sheet per "
                "sub-circuit placed on its parent as block:<sheet>, set_top_sheet. (B) check and simulate / "
                "verify_truth_table each sheet, fix every failure, and report the results. (C) request_approval with a "
                "summary, then call approval_status until it is not 'waiting'; on 'changes' fix and ask again. "
                "(D) Only after 'approved': make_topdown. Never write a Top-Down file yourself.")
    if name == "prepare_for_board":
        return ("Get the top sheet ready for the EDGE Spartan-7: check (no errors), get_pins (resolve conflicts and "
                "unassigned ports with set_pins/auto_pins), get_xdc, then export_files ['vhdl','xdc','project'] and report the paths.")
    raise KeyError(name)


# --------------------------------------------------------------------------- app connection
def config_dir() -> Path:
    if os.name == "nt":
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "FPGA Ecosystem"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "FPGA Ecosystem"
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "fpga-ecosystem"


class App:
    """The running FPGA Ecosystem launcher (started on demand)."""

    def __init__(self):
        self.base = None
        self.token = None
        self.lock = threading.Lock()

    def _read_runtime(self):
        try:
            rt = json.loads((config_dir() / "runtime.json").read_text("utf-8"))
            return f"http://127.0.0.1:{rt['port']}", rt["token"]
        except Exception:
            return None, None

    def _alive(self, base, token):
        try:
            req = urllib.request.Request(base + "/api/mcp/status", headers={"X-FE-Token": token})
            with urllib.request.urlopen(req, timeout=2) as r:
                return json.loads(r.read()).get("ok") is True
        except Exception:
            return False

    def _spawn(self):
        if getattr(sys, "frozen", False):
            exe = Path(sys.executable)
            main = exe.with_name("FPGAEcosystem.exe") if exe.name.lower().startswith("fpgaecosystem-mcp") else exe
            cmd = [str(main), "--no-open"]
        else:
            cmd = [sys.executable, str(HERE / "app.py"), "--no-open"]
        flags = 0
        if os.name == "nt":
            flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=flags, start_new_session=(os.name != "nt"))

    def ensure(self):
        with self.lock:
            if self.base and self._alive(self.base, self.token):
                return
            base, token = self._read_runtime()
            if base and self._alive(base, token):
                self.base, self.token = base, token
                return
            self._spawn()
            end = time.time() + 45
            while time.time() < end:
                time.sleep(0.5)
                base, token = self._read_runtime()
                if base and self._alive(base, token):
                    self.base, self.token = base, token
                    return
            raise RuntimeError("could not start FPGA Ecosystem (launcher). Is it installed / is Python able to run launcher/app.py?")

    def request(self, method, path, body=None, timeout=70):
        self.ensure()
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json", "X-FE-Token": self.token})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "null")

    def call(self, op, args, timeout):
        try:
            return self.request("POST", "/api/mcp/call", {"op": op, "args": args, "timeout": timeout}, timeout=timeout + 40)
        except urllib.error.HTTPError as e:
            if e.code == 401:           # the app restarted with a new token
                self.base = None
                return self.request("POST", "/api/mcp/call", {"op": op, "args": args, "timeout": timeout}, timeout=timeout + 40)
            raise

    def keepalive(self):
        """The launcher quits when nobody pings it; keep it up while Claude is connected."""
        while True:
            time.sleep(30)
            try:
                if self.base:
                    urllib.request.urlopen(self.base + "/api/ping", timeout=3).read()
            except Exception:
                pass


APP = App()


# --------------------------------------------------------------------------- MCP handlers
def text(obj):
    return {"type": "text", "text": obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, indent=1)}


def call_tool(name, args):
    tool = TOOL_MAP.get(name)
    if not tool:
        return {"content": [text(f"unknown tool '{name}'")], "isError": True}
    try:
        if name in LOCAL_TOOLS and name != "list_projects":
            qs = "action=" + name + "".join(f"&{k}={urllib.parse.quote(str(v))}" for k, v in (args or {}).items())
            res = APP.request("GET", "/api/mcp/app?" + qs)
            if not res.get("ok"):
                return {"content": [text(res.get("error", "failed") + (f"\nhint: {res['hint']}" if res.get("hint") else ""))],
                        "isError": True}
            res.pop("ok", None)
            if name == "about":
                res["mcp_server"] = {"name": SERVER_NAME, "version": version()}
            return {"content": [text(res)]}
        if name in LOCAL_TOOLS:
            res = APP.request("GET", "/api/projects")
            return {"content": [text({"folder": res.get("dir"), "projects": [
                {"name": p["name"], "path": p.get("main"), "files": [f["name"] for f in p.get("files", [])]}
                for p in res.get("projects", [])]})]}
        args, bad = normalize_args(name, args)
        if bad:
            return {"content": [text(bad)], "isError": True}
        reply = APP.call(name, args, tool["_timeout"])
    except Exception as e:
        return {"content": [text(f"FPGA Ecosystem is not reachable: {e}")], "isError": True}
    if not reply.get("ok"):
        msg = reply.get("error") or "failed"
        if reply.get("hint"):
            msg += f"\nhint: {reply['hint']}"
        return {"content": [text(msg)], "isError": True}
    result = reply.get("result")
    if name == "screenshot" and isinstance(result, dict) and result.get("image_png_base64"):
        img = result.pop("image_png_base64")
        return {"content": [{"type": "image", "data": img, "mimeType": "image/png"}, text(result)]}
    return {"content": [text(result)]}


def read_resource(uri):
    if uri == "fpga://guide":
        return {"uri": uri, "mimeType": "text/markdown", "text": INSTRUCTIONS}
    op = {"fpga://board/edge-spartan7": "board_pins", "fpga://sheet/active": "get_sheet",
          "fpga://component-types": "list_component_types"}.get(uri)
    if not op:
        raise KeyError(uri)
    reply = APP.call(op, {}, 30)
    if not reply.get("ok"):
        raise RuntimeError(reply.get("error"))
    return {"uri": uri, "mimeType": "application/json", "text": json.dumps(reply.get("result"), ensure_ascii=False, indent=1)}


def handle(msg):
    method, mid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if mid is None:                     # notification (initialized, cancelled …)
        return None
    try:
        if method == "initialize":
            want = params.get("protocolVersion")
            return ok(mid, {"protocolVersion": want if want in PROTOCOLS else PROTOCOLS[0],
                            "capabilities": {"tools": {"listChanged": False}, "resources": {}, "prompts": {}},
                            "serverInfo": {"name": SERVER_NAME, "title": "FPGA Ecosystem — Schematic Studio", "version": version()},
                            "instructions": INSTRUCTIONS})
        if method == "ping":
            return ok(mid, {})
        if method == "tools/list":
            return ok(mid, {"tools": [{k: v for k, v in t.items() if not k.startswith("_")} for t in TOOLS]})
        if method == "tools/call":
            return ok(mid, call_tool(params.get("name"), params.get("arguments") or {}))
        if method == "resources/list":
            return ok(mid, {"resources": RESOURCES})
        if method == "resources/templates/list":
            return ok(mid, {"resourceTemplates": []})
        if method == "resources/read":
            try:
                return ok(mid, {"contents": [read_resource(params.get("uri"))]})
            except KeyError:
                return err(mid, -32002, f"resource not found: {params.get('uri')}")
        if method == "prompts/list":
            return ok(mid, {"prompts": PROMPTS})
        if method == "prompts/get":
            try:
                t = prompt_text(params.get("name"), params.get("arguments") or {})
            except KeyError:
                return err(mid, -32602, f"unknown prompt: {params.get('name')}")
            return ok(mid, {"messages": [{"role": "user", "content": {"type": "text", "text": t}}]})
        return err(mid, -32601, f"method not found: {method}")
    except Exception as e:  # never let one bad request kill the server
        return err(mid, -32603, f"internal error: {e}")


def ok(mid, result):
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def err(mid, code, message):
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


def version():
    import re
    try:                                     # from source: read it from app.py
        m = re.search(r'^VERSION = "(.+)"', (HERE / "app.py").read_text("utf-8"), re.M)
        if m:
            return m.group(1)
    except Exception:
        pass
    try:                                     # installed: the running app tells us
        return json.loads((config_dir() / "runtime.json").read_text("utf-8")).get("version") or "0"
    except Exception:
        return "0"


def _stdio():
    """stdin/stdout as UTF-8 text. A windowed (GUI) exe gets None for sys.stdin/stdout even
    when Claude hands it pipes — reopen the real OS handles in that case."""
    if sys.stdin is None or sys.stdout is None:
        import msvcrt, ctypes  # noqa: E401  (Windows only)
        k32 = ctypes.windll.kernel32
        fin = msvcrt.open_osfhandle(k32.GetStdHandle(-10), os.O_RDONLY)
        fout = msvcrt.open_osfhandle(k32.GetStdHandle(-11), 0)
        return os.fdopen(fin, "r", encoding="utf-8", newline="\n"), os.fdopen(fout, "w", encoding="utf-8", newline="\n")
    return (open(sys.stdin.fileno(), "r", encoding="utf-8", newline="\n", closefd=False),
            open(sys.stdout.fileno(), "w", encoding="utf-8", newline="\n", closefd=False))


def main():
    fin, fout = _stdio()
    sys.stdout = sys.stderr            # nothing but protocol may reach stdout
    threading.Thread(target=APP.keepalive, daemon=True).start()
    wlock = threading.Lock()

    def send(obj):
        with wlock:
            fout.write(json.dumps(obj, ensure_ascii=False) + "\n")
            fout.flush()

    def work(msg):
        reply = handle(msg)
        if reply is not None:
            send(reply)

    running = []
    for line in fin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            send(err(None, -32700, "parse error"))
            continue
        batch = msg if isinstance(msg, list) else [msg]
        for m in batch:
            # tool calls can take a while (layout, screenshots): answer each on its own thread
            t = threading.Thread(target=work, args=(m,), daemon=True)
            t.start()
            running.append(t)
        running = [t for t in running if t.is_alive()]
    for t in running:                  # client closed stdin: let in-flight answers go out
        t.join(timeout=30)
    return 0


if __name__ == "__main__":
    sys.exit(main())
