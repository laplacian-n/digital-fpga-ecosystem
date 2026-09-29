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

Claude starts with `about`, which tells it:
- which app and version it is talking to, and whether a newer version is out (with the release notes);
- whether the board toolchain is ready (Vivado, openFPGALoader, the flash bridge, the USB driver);
- the local AI model's state, the workspace and number of projects, and whether the editor window is open.

The server also reports the app version as its own version when Claude connects.

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
| The app | `about` (app + version, update available and what's new, workspace, editor open?, Vivado / openFPGALoader / USB driver / AI model ready?), `check_update`, `open_home` (Home / setup checklist / settings — the user clicks อัปเดตเลย there) |
| Look | `status`, `get_sheet`, `get_netlist`, `list_component_types`, `screenshot` (PNG), `get_events` (what you changed) |
| Sheets | `open_sheet`, `new_sheet`, `rename_sheet`, `set_top_sheet` |
| Edit | `add_component`, `connect`, `disconnect`, `delete`, `update_component` (rename / params / type / move / rotate), `apply` (many steps in one all-or-nothing transaction) |
| Build | `build_circuit`: from a truth table (minimised), a generator (mod-N, JK-FF counter, `clock_divider` for any N such as 50 MHz → 20 Hz, sequence, ripple counter, shift register, register, BCD→7-seg) or an intent netlist (sub-circuits as `block:<sheet>`). With `bus: true`, numbered ports come out as one bus port (q0..q3 → `q[3:0]`). `make_bus_ports` does the same for an existing sheet. |
| Layout | `auto_layout`, `layout_report` (overlaps, wires through parts, score), `lock_layout` |
| Verify | `check` (errors with suggested fixes), `simulate`, `verify_truth_table`, `probe` (every net's value), `explain_simulation`, `set_spec` / `check_spec` (the sheet's acceptance test) |
| Board | `board_pins`, `get_pins`, `set_pins`, `auto_pins`, `get_xdc`, `board_check` (what will go wrong on the real board, before a build) |
| Output | `make_report` (the lab report into the project folder), `get_vhdl`, `export_files` (writes .vhd / .xdc / project into the workspace), `save_project`, `new_project`, `list_projects`, `open_project` |
| Real board | `board_build` (Vivado → .bit), `board_program` (load into the FPGA, or `detect`), `board_status` (follow the job: log tail, Thai explanation of an error, does the .bit match the circuit). Writing the Flash stays the user's click. |
| History | `undo`, `redo`, `checkpoint`, `list_checkpoints`, `restore_checkpoint` |
| With you | `focus` (centres your view on a part), `notify_user` (a message in the editor) |
| Lab / Top-Down | `request_approval`, `approval_status`, `make_topdown` (see below) |

### Circuits that are right by construction
- **`build_part` / `list_parts`:** a library of standard circuits: adders, subtractors, comparator, mux/demux,
  decoder, encoder, BCD→7-seg, parity, counters, clock divider, registers, toggle, edge detector and debounce.
  - Each part is generated by code and checked against a reference model before it is drawn, so the sheet
    comes back marked as verified.
- **`build_circuit {formula}`:** you write equations and the app computes the truth table. For example
  `sum = a^b^cin; cout = a&b | cin&(a^b)`, or `{cout,sum} = a+b+cin`.
- **`verify_truth_table {formula}`:** checks the sheet against the requirement.
  - An expectation identical to the table the sheet was built from proves nothing. The result says so
    (`independent: false`), and it does not count as verified.
  - `recognized` names the standard circuit the sheet is.
- **`build_fsm`:** a state machine from a few lines (`inputs: x`, `state S0: z=0`, `S0 -> S1 when x`, `else`,
  Mealy `/ z=1`, `reset S0`) or an object. It is built from D flip-flops, checked clock by clock against the
  diagram, and the diagram becomes the sheet's acceptance test.
- **`set_spec` / `check_spec`:** what a sheet must do, written from the requirement: a formula, a table, or
  a sequence of clocks. The app re-checks it after every edit (✓/✗ in the project tree). A pass marks the
  sheet verified. Set it first, then build until it passes.
- **`save_module`:** refuses a sheet that is not verified, unless you pass `force: true`.
- **Calls that only wait** (`approval_status`, `board_status`, `ai_chat_status`) run beside the others. They
  no longer hold up the queue.

### Before the board
`board_check` lists what will go wrong on the real EDGE board, so you can fix it before a one-minute Vivado build:
- a port without a pin, two ports on one pin, or an input on an LED
- 7-seg segments written active-high for this common-anode display, or no digit enabled
- a clock from a bouncing push button, or a counter on the raw 50 MHz clock

The same check is behind the ลงบอร์ด page's 🩺 button. That button also has a preview: flip the mapped
switches and see which LEDs and digits the design lights.

### Course notes (RAG)
`search_course` searches the course material that ships with the app: the textbook chapters, the lab sheets
with their solutions, the board's pins and peripherals, and checked VHDL examples. The local agent gets the
closest notes automatically, and can call `search_course` for more. Search is by keyword (BM25). With the optional embedding model
(Settings ▸ โมเดล AI ▸ Qwen3-Embedding 0.6B, 640 MB), it also searches by meaning, in Thai or English. That
model runs on the CPU, so the graphics card stays free for the chat model.

### Module library (the Modules tab)
- `list_modules` shows the library. It is shared by every project in the editor.
- `save_module` stores a sheet in the library, together with every sheet it uses as a block.
- `use_module` places a module as a block, and `open_module` opens it as a sheet you can edit.
- `delete_module` removes a module from the library.

### Testing the app's own AI
Claude can use the app's AI feature the same way the user does, and see what goes wrong:
- `ai_model` shows the local model's state, its installed models and the llama-server log. It can also
  start, stop or download a model.
- `ai_chat` types a message into the editor's AI chat and sends it. You see it happen. Mode `agent` means the
  local model works step by step with the editor's tools.
- `ai_chat_status` returns the transcript: the model's thinking, each tool call with its arguments and
  result or error, the final answer, and the time and tokens used.

Every agent run is also saved to `agent-runs/*.jsonl` in the app's config folder.

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
  placed by the editor's own placer at the end. Steps run in order, and each step sees the ones before it,
  so "delete, then connect to the freed pin" works in one call.
- **Wrong field names are caught before they run.** Common aliases are accepted (`delete {target}` means
  `refs`). Any other unknown field is an error that lists the fields the tool takes. The `apply` description
  spells out every step's fields.
- **Deleting a part takes the nets it drove with it.** No leftover wiring keeps "driving" a pin. The inputs
  it fed come back as `now_unconnected`.
- **The loop check looks inside blocks.** A feedback path through a flip-flop inside a sub-circuit is legal,
  just as it is in Vivado. Only a path with no register anywhere is reported as a combinational loop.
- **One slow call does not hang the others.** A very large `auto_layout` keeps the editor busy. Calls queued
  behind it answer "busy with auto_layout" after about 15 s, instead of waiting until they time out.
- **`simulate` with many inputs:** above 10 input bits it asks for `vectors` (the rows you want), instead of
  producing 65,536 rows.
- **Edits report layout quality.** Editing tools return layout metrics, so Claude can tell when the drawing
  needs `auto_layout`.

## Tests
`tests/mcp.spec.js` runs a real MCP session against a live editor: build, verify, errors, rollback, undo,
generators, sequential simulation, pins, XDC, events, export, and the security checks.
`tests/test_mcp_protocol.py` covers the protocol surface, and checks that every tool has a handler in the editor.

## Older server
`schematic_mcp.py` (repo root) is the previous offline server: it writes a JSON file that you then import with
the Sync button. It still works, but the server described here replaces it.

Both old servers (`schematic_mcp.py`, `topdown/topdown_mcp.py`) only know files they saved themselves. A student
who rearranged a circuit and asked Claude to check it got an answer from the stale file. So while the app is
running, their `list_designs` / `read_design` answer with the LIVE sheet (read through the launcher relay by
`legacy_live.py`, which never starts the app) and say the server is retired. Home also offers to remove them.
