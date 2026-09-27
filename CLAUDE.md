# Digital FPGA Ecosystem — notes for working on this repo

Teaching toolchain for the EDGE Spartan-7 (XC7S15) board: draw gates → simulate → pick pins → build.
UI text is Thai; code and comments are English.

## Layout
| Path | What |
|---|---|
| `schematic&bus2vhdl.html` | **Schematic Studio**, the gate editor. One self-contained HTML file (opens from disk and from the launcher). ~12k lines of editor + an inlined UX layer at the end. |
| `editor/ux/*.js`, `editor/ux/ux.css` | **Source of the UX layer** (save chip/timeline, browser sim, truth-table tool, generators, welcome/templates, stepper, pin page, problem markers, Ctrl+K, …). Inlined into the HTML by `editor/build.py`. |
| `editor/ux/12-wire-tidy.js` | Wire tidy: re-routes paths from the connection list (🧹 sheet / selected net, Debug panel "แก้ให้"), the 🧲 ratsnest placement mode (straight coloured lines per net → "จัดสายให้"), and moving a part re-routes only the branches off it (`wtAfterMove`, called from the core mouseup/nudge). |
| `editor/ux/13-sheet-order.js` | Drag a sheet in the project tree to reorder it (the order = key order of `schematics`, rewritten in place; saved, undoable). |
| `editor/ux/14-part-truth.js` | Inspector ▸ "📋 ดูตารางความจริง" for the selected part: copies it onto a scratch sheet (an IN per input pin, an OUT per output) and runs the browser simulator (`clientCombSim`). |
| `editor/build.py` | Inlines `editor/ux/` between `<!-- UX-LAYER:BEGIN/END -->`. `--check` fails if the HTML is stale. |
| `topdown/` | Top-Down block-diagram editor, embedded in the gate editor via iframe (Tools ▸ Top-Down, or the launcher's Home button → `studio.html?view=topdown`). It receives the active sheet as drawn: `schematicToTopdownExact` maps the gate editor's placement + routed wires 1:1 (`w.exact`, `n.pinOff`); its layout buttons ask the gate editor to re-layout (`gate:relayout`). `td-engine.js` = Top-Down's own layout + router for block-level sheets (auto-layout / import): columns by signal flow, rows that wrap, ports on the frame, every net routed as one tree on a track grid (A*), stored as `w.pts` + `w.auto`; re-routes after a part moves. Style rules it follows: `docs/TOPDOWN.md`. |
| `launcher/` | `app.py` = the desktop app: one local server (127.0.0.1:8770) serving the editors + `ai/chat_server.py` in-process, settings, project workspace, update check. `board.py` = build .bit (Vivado batch) + program (openFPGALoader) for the editor's ลงบอร์ด page (`/api/board/*`). `llm.py` = local model manager: download llama.cpp + a .gguf, start/stop (`/api/llm/*`, Settings ▸ โมเดล AI). `web/home.html` (Home/settings), `web/shim.js` (injected into editor pages), `web/icon.svg` (source of `icon.ico` / `web/icon-*.png`). Windows build: `build_windows.ps1` + `installer.iss`. |
| `ai/` | Python backend (stdlib only): intent validate, netlist sim, VHDL/XDC codegen, cosim, Vivado synth, `chat_server.py`. |
| `hub/` | Canonical IR / hashes / SQLite store. |
| `FPGA_Builder_Package/source/fpga_builder.py` | Tk app: VHDL → .bit → board. The launcher runs it as `FPGAEcosystem.exe --fpga-builder`. |
| `launcher/mcp_server.py` | MCP server (stdio, stdlib). Tools are forwarded to the launcher relay (`/api/mcp/*`, token in `runtime.json`) and executed in the open editor by `editor/ux/08-mcp-bridge.js` (`MCP_OPS`). Adding a tool = an entry in `TOOLS` + an `MCP_OPS.<name>` handler (a unit test enforces both). See `docs/MCP.md`. |
| `tests/` | Playwright tests: `tests/editor/*.spec.js` (editor from disk), `tests/launcher.spec.js` (spawns the launcher). |

## Workflow
```
python3 editor/build.py        # after editing editor/ux/* — never edit the inlined copy in the HTML
npm install && npm test        # Playwright (chromium)
python3 launcher/app.py        # run the app locally (--no-open to only serve)
```
CI (`.github/workflows/ci.yml`) runs `build.py --check`, compiles the Python and runs the Playwright suite on every push.

## How the UX layer hooks in
The editor defines everything as top-level functions/consts in one classic `<script>`. The UX layer is a second
`<script>` that **wraps globals by reassignment** (`snapshot = function(){ … _snapshot.apply(this, arguments) … }`),
so the editor's own internal calls go through the wrapper. Rules:
- Don't declare a top-level name the editor already uses (a `const` clash kills the whole UX script — this happened with `STEP`).
- Files load in name order (`01-…` → `07-…`); a later file may wrap or reassign what an earlier one defined.
- Sheets carry optional extras that serialize with the project: `sch.pinmap` (port/bit → board target, keyed by the
  VHDL port name `sanId(name)` / `name[i]`) and `sch.portOrder` (declared IN/OUT order for generated sheets).

## Releasing
1. Bump `VERSION` in `launcher/app.py`, commit.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` → `.github/workflows/build-windows.yml` builds Setup.exe + portable zip
   and attaches them to a GitHub Release (it fails if the tag and `VERSION` disagree).
3. Installed copies see the new release on their next start (launcher update check) and can update in place;
   projects (Documents) and settings (%APPDATA%) are untouched.

## Not in the repo
Vivado/ISE, `*.lic`, LLM models (`ai/models`, `ai/llama`), GHDL, RAG index, course material — see README.

## Conventions (owner's wishes)
- Commit as the repo owner (`git config user.name laplacian-n`, `user.email dinucleotide10292910@gmail.com`).
  **No `Co-Authored-By: Claude` / `Claude-Session` trailers and no "Generated with Claude Code" footer** in commits or PRs
  (the owner removed Claude from Contributors on purpose).
- Talk to the owner in Thai. Before a release, bump `VERSION` — a tag that doesn't match fails the Windows build
  (this is what left v0.3.0 without an installer).
- Not verified on real hardware yet: the ลงบอร์ด page with real Vivado / openFPGALoader / board on Windows.
  openFPGALoader is not in the repo; `build_windows.ps1` bundles it from MSYS2 at build time (plus Zadig).
- Home's "เริ่มต้นใช้งาน" tab (first-run checklist, `setup_check()` in `app.py`, `board.usb_driver()`)
  opens on start until dismissed (`setup_done`).
