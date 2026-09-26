# Claude + Schematic Studio (MCP server)

Claude can work **inside Schematic Studio**: read the design, place parts, wire them, lay them out, check them,
simulate, pick board pins and export VHDL/XDC. Claude does this in the editor window you have open, so you see
every step. Every change can be undone with Ctrl+Z, and the editor keeps a history timeline you can restore from.

## Connecting

**The easy way:** open FPGA Ecosystem → **ตั้งค่า → เชื่อมกับ Claude**
- **ติดตั้งให้ Claude Desktop:** adds the server to Claude Desktop's config (the old file is backed up to
  `claude_desktop_config.json.bak`). Then quit Claude Desktop completely (from the tray) and open it again.
- **Claude Code:** copy the command shown and run it once, for example:
  ```
  claude mcp add fpga-ecosystem -- "C:\Users\<you>\AppData\Local\Programs\FPGA Ecosystem\FPGAEcosystem-MCP.exe"
  ```
- **Any other MCP client:** use the JSON shown there, for example:
  ```json
  {"mcpServers": {"fpga-ecosystem": {"command": "C:\\...\\FPGAEcosystem-MCP.exe", "args": []}}}
  ```

**From source** (no install): `python launcher/mcp_server.py`. It needs only the Python standard library.

You don't need to start anything else. The MCP server starts FPGA Ecosystem if it isn't running, and opens a
Schematic Studio window if none is open. A **Claude** chip in the editor's top bar shows the connection and
flashes while Claude is working.

## How it works
```
Claude ──stdio──▶ mcp_server.py ──HTTP + token──▶ launcher (127.0.0.1) ──long-poll──▶ Schematic Studio page
                                                                                        runs the operation with
                                                                                        the editor's own engine
```
- **Nothing is re-implemented.** Placement, routing, design-rule checks, simulation, pin mapping and VHDL all
  come from the editor itself, so what Claude builds is exactly what you would get by hand.
- **Security:** the launcher listens only on 127.0.0.1. MCP calls need a random token that the launcher writes
  to `runtime.json` in your settings folder, which only you can read. The editor-side endpoints refuse requests
  coming from other websites.
- **You see it as it happens:** after every call that changes the drawing, the editor:
  - brings the canvas forward, even if you were on the sim, board or Top-Down page;
  - brings the change into view, zooming or panning only when it is off-screen, so the view doesn't jump on every call;
  - makes the changed parts glow for a moment.

  Read-only calls leave your view alone.
- **Undo:** every tool call is one undo step. Before a burst of changes, a timeline checkpoint
  ("ก่อน Claude แก้") is saved.

## Tools
| Group | Tools |
|---|---|
| Look | `status`, `get_sheet`, `get_netlist`, `list_component_types`, `screenshot` (PNG), `get_events` (what you changed) |
| Sheets | `open_sheet`, `new_sheet`, `rename_sheet`, `set_top_sheet` |
| Edit | `add_component`, `connect`, `disconnect`, `delete`, `update_component` (rename / params / type / move / rotate), `apply` (many steps in one all-or-nothing transaction) |
| Build | `build_circuit`: from a truth table (minimised), a generator (mod-N, sequence, ripple counter, shift register, register, BCD→7-seg) or an intent netlist |
| Layout | `auto_layout`, `layout_report` (overlaps, wires through parts, score), `lock_layout` |
| Verify | `check` (errors with suggested fixes), `simulate`, `verify_truth_table`, `probe` (every net's value), `explain_simulation` |
| Board | `board_pins`, `get_pins`, `set_pins`, `auto_pins`, `get_xdc` |
| Output | `get_vhdl`, `export_files` (writes .vhd / .xdc / project into the workspace), `save_project`, `list_projects`, `open_project` |
| History | `undo`, `redo`, `checkpoint`, `list_checkpoints`, `restore_checkpoint` |
| With you | `focus` (centres your view on a part), `notify_user` (a message in the editor) |
| Lab / Top-Down | `request_approval`, `approval_status`, `make_topdown` (see below) |

### Lab work: schematic → simulate → you approve → Top-Down
Claude is told to work in this order, and the tools enforce it:
1. **Schematic:** Claude builds the circuit in Schematic Studio. Each sub-circuit is its own sheet, placed on its parent as a block.
2. **Simulate:** Claude checks and simulates every sheet, and tells you the results.
3. **Approve:** `request_approval` shows Claude's summary in a card in the editor, with **✓ อนุมัติ** and **✎ ขอแก้**.
   - For ขอแก้, you type what to change; Claude gets your comment, fixes it, simulates again and asks again.
   - Claude waits for your answer with `approval_status`. It returns after ≤40 s per call, because MCP clients cancel long calls.
4. **Top-Down:** `make_topdown` draws the top sheet and every sheet it uses as layers in the Top-Down view:
   `1st Layer (top)`, `2nd Layer (…)`, and so on.
   - It **refuses** unless you approved exactly the circuit that is on screen.
   - The approval is tied to each sheet's parts, parameters and connections, not to positions. Tidying the drawing is fine; changing the circuit needs a new approval.

The prompt `lab_topdown` starts this flow. The old offline servers (`topdown/topdown_mcp.py`, `schematic_mcp.py`)
write a Top-Down JSON that you then import yourself, so they skip steps 1–3. If Claude Desktop still has one of them
configured, **ตั้งค่า → เชื่อมกับ Claude** warns about it and can remove it. The config file is backed up to `.json.bak`.

There are also **resources** (`fpga://guide`, `fpga://board/edge-spartan7`, `fpga://sheet/active`,
`fpga://component-types`) and **prompts** (`design_from_spec`, `debug_simulation`, `prepare_for_board`).

### References
- **A component** is referred to by its id (`c12`), its INPUT/OUTPUT name (`a`, `sum`) or its label (`U1`).
- **A pin** is written `component.pin`, for example `U1.i0` or `ff0.q`. A bare component means its output when
  it is a wire source, and its first free input when it is a wire sink.
- **Truth-table rows** put the first input as the MSB.
- **Sub-circuits** are other sheets, placed with the type `block:<sheet name>`.

### Designed for an AI to use well
- **Errors say what to do next.** For example: `pin 'zz' does not exist on X1 (XOR)` together with
  `hint: pins: i0(in), i1(in), o(out)`.
- **Names are never changed silently.** A duplicate name is an error, never an automatic `sum_1`.
- **`apply` is a transaction.** If any step fails, nothing is changed. Parts added without coordinates are
  placed by the editor's own placer at the end.
- **Edits report layout quality.** Editing tools return layout metrics, so Claude can tell when the drawing
  needs `auto_layout`.

## Tests
`tests/mcp.spec.js` runs a real MCP session against a live editor: build, verify, errors, rollback, undo,
generators, sequential simulation, pins, XDC, events, export, and the security checks.
`tests/test_mcp_protocol.py` covers the protocol surface, and checks that every tool has a handler in the editor.

## Older server
`schematic_mcp.py` (repo root) is the previous offline server: it writes a JSON file that you then import with
the Sync button. It still works, but the server described here replaces it.
