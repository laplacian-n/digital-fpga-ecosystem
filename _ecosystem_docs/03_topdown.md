# Top-Down Schematic Editor + MCP Bridge — Technical Reference

Files covered:
- `topdown/topdown-schematic.html` (~3247 lines) — single-file hierarchical block-diagram editor. UI chrome/comments are English; on-page labels are Thai ("แฟ้ม" = sheet/folder, "ตรวจงาน" = check).
- `topdown/topdown_mcp.py` (335 lines) — local MCP server (stdio) + optional HTTP bridge (`--serve`) that lets an AI write design JSON and push it into the editor.

This doc is written to support building a **shared data model** spanning this tool and the gate-level editor (`schematic&bus2vhdl.html`). Section 5 is the delta analysis for that purpose.

---

## 1. Data model

### 1.1 Project (`P` global in the HTML, `topdown-schematic.html:360-365`)

```js
P = {
  meta: {projectName, studentId, studentName, section, page},  // title-block, top-right of print
  page: {show, orient:'landscape'|'portrait', mmPerUnit, marginMm},  // A4 print guide, editor-only
  text: {scale},                                                // global text-size multiplier, editor-only
  sheets: [ <sheet>, ... ],
  active: 0                                                     // index of sheet currently shown
}
```

`meta` fields map directly to the right-hand "Title block" panel inputs (`mId/mName/mSec/mPage/mProj`, `topdown-schematic.html:297-302`). `page`/`text` are rendering/print concerns, not part of the design itself — `ensureProjectDefaults()` (`:377-386`) backfills them on any load so older saves don't come back missing fields.

`P.active` and sheet `id`s are the *only* thing that make this a single tree rather than a flat sheet list — see §1.3 hierarchy.

### 1.2 Sheet

```js
{
  id: "abc123",                 // stable uid, used for parent/child links
  title: "3rd Layer ⊂ (Comparator)",   // shown top-center; "⊂" is stripped on load (cleanTitle, :2453)
  module: "Comparator",         // shown top-left
  frame: {x, y, w, h},          // dashed "module boundary" rectangle in world units — cosmetic, not a hard clip
  nodes: [ <node>, ... ],
  wires: [ <wire>, ... ]
}
```

Defaults come from `newSheet(title, module)` (`:2244`): `frame:{x:80,y:120,w:1120,h:560}`.

### 1.3 Nodes

Every node is **flat** — there is no nested wrapper keyed by type. `type` is one of `block | gate | mux | port | const`, plus an editor-only 6th type, `netlabel`, that the MCP schema does not mention (see §5). Common fields: `id`, `type`, `x`, `y` (top-left, except port/const — see below).

**block** (`mkBlock`, `:430-436`; pins `:450-455`)
```js
{id, type:'block', x, y, w, h, label,
 pinsL:['clk','~CLR','D0[3:0]'], pinsR:['Q'], pinsB:[], pinsT:[],
 sheet: 'childSheetId'  // optional — present once the block has been "drilled into"
}
```
- `w`/`h` are **derived**, not authored: `recalc(n)` (`:1903-1930`) sizes the box from label length and the longest paired L/R pin-name row (7px/char at the current text scale), floors at `HARD_W=34,HARD_H=26`. An AI-authored node can omit `w`/`h` entirely; the editor computes them on `fixSheetDefaults()`.
- Each pin entry is either a plain string or `{name, inv}`. A leading `~` (e.g. `~CLR`) is sugar for `{name:'CLR', inv:true}` and draws an inversion bubble (`norm()`, `:447`).
- A pin literally named `clk` (case-insensitive, ignoring the `~`/bus suffix) gets a clock wedge (`bareName(p.name).toLowerCase()==='clk'`, `:500`).
- A bus width can be embedded in the pin's own name as a suffix: `D0[3:0]` → 4 bits, or a lettered range `Segment[a:g]` → 7 bits (`busOfName()`, `:2262-2268`). This is the *only* place block pin width lives — there is no separate numeric width field.
- `sheet` links this block to a child sheet that "details" its insides (§ hierarchy below).

**gate** (`mkGate`, `:437`)
```js
{id, type:'gate', x, y, w, h, gate:'and'|'or'|'nand'|'nor'|'xor'|'xnor'|'not'|'buf', inputs:2, label:''}
```
`w/h` default `42×44` for not/buf, `52×44` otherwise; `inputs` defaults to 1 for not/buf else 2. `inputs` is arbitrary (fan-in AND/OR/NAND/NOR/XOR/XNOR gates are drawn with N stubs), but the symbol shape itself (from `geom()`, `:517-536`) is only really validated visually for 2. Pins are generated, never authored: `in0..in{N-1}` on the left, `out` on the right (with a bubble offset for the inverted gates).

**mux** (`mkMux`, `:438`) — fixed 2:1 shape, `w=74,h=110`:
```js
{id, type:'mux', x, y, w, h, label:'Mux2-1'}
```
Pins are fixed: `d0, d1` (left), `sel` (bottom), `out` (right) (`:461-465`). There's no way to make a wider mux via JSON fields alone — `inputs`/`sel` count isn't parametrized in this node type (unlike the gate-level tool's parametric mux — see §5).

**port** (`mkPort`, `:439`) — an off-sheet I/O pin, anchor at `(x,y)`:
```js
{id, type:'port', x, y, name:'CLK', side:'left'|'right'|'top'|'bottom', bus:0}
```
`bus>0` draws a diagonal bus tick and a `[n-1:0]` suffix on the label (`geom()`, `:552-553`). A port has exactly one pin, id `'p'`. Direction for the checker is inferred from `side`: left/top = drives the sheet (source, `pinDir()`, `:1018`), right/bottom = sink.

**const** (`mkConst`, `:440`) — a literal driver:
```js
{id, type:'const', x, y, value:'1'|'0'}
```
One pin, id `'p'`, drawn as a short stub with the value text at the end (`:554-555`). Always an output (`pinDir`, `:1015`).

**netlabel** (editor-only; `mkNetLabel`, `:444`) — *not* in the MCP schema:
```js
{id, type:'netlabel', x, y, name:'CLR_Button', side:'left'|'right'}
```
Joins nets **by matching name** instead of a drawn wire — used so one reset signal can reach six blocks without a wire running across the whole sheet. The checker's net-builder unions all `netlabel` pins sharing a lowercased `bareName()` (`checkSheet()`, `:1056-1062`). One pin, id `'p'`; direction is ambiguous (`'?'`, `:1016`, so it never trips the "no driver"/"two drivers" checks by itself).

### 1.4 Pin-id conventions (`_node_pin_ids()` in the MCP, `topdown_mcp.py:152-166`, matches `pins()` in the HTML, `topdown-schematic.html:448-474`)

| node type | pin ids |
|---|---|
| block | `L0,L1,...` (pinsL, in row order), `R0,R1,...`, `B0,B1,...`, `T0,T1,...` |
| gate | `in0,in1,...,in{inputs-1}`, `out` |
| mux | `d0`, `d1`, `sel`, `out` (fixed) |
| port | `p` (single pin) |
| const | `p` (single pin) |
| netlabel | `p` (single pin; editor-only) |

### 1.5 Wire

```js
{id: 'uid', from:{node:'a1', pin:'p'}, to:{node:'g1', pin:'in0'}, bus: 0}
```
- `id` is assigned by the editor on load if missing (`fixSheetDefaults`, `:2463`) — the MCP schema doesn't require it.
- `bus`: `0` = plain wire, `n` = draw a `/n` bus slash + width label at the longest clear horizontal run (`routeMid()`, `:650-672`). This is a **display annotation**, not a real per-bit netlist — the checker cross-checks it against `pinWidth()` inferred from the endpoints' names (`checkSheet()` rule 4, `:1079-1089`) but nothing downstream fans a bus out into individual bits.
- Optional editor-only fields, **not part of the authoring schema**: `pts:[[x,y],...]` (hand-placed routing waypoints) and legacy `mx,my` (old single-midpoint hint). An AI should omit these — omitting them (or an explicit `delete`) hands routing back to the auto-router (`routeThrough()`, `:685-731`).
- An endpoint can also be a literal `{x,y}` (no `node` key) for a dangling stub — the MCP's `_validate_sheet` explicitly skips checking those (`topdown_mcp.py:205-206`).

### 1.6 Hierarchy — how sheets become a tree

A block becomes a "detailed" block by carrying `sheet: <childSheetId>` (comment at `topdown-schematic.html:2246-2250`). There is **no explicit parent pointer or tree structure stored** — `parentOf(sheetId)` (`:2254-2259`) reconstructs the parent by scanning every sheet's nodes for a block whose `.sheet` equals the target id. Consequences for a generator:
- Each sheet is assumed to have **at most one** parent block across the whole project; nothing stops two blocks pointing at the same child sheet, but `parentOf()` will only ever find the first one it scans — i.e. no supported "instantiate the same sub-sheet twice" pattern (contrast with the gate-level tool, §5).
- Double-clicking an undetailed block calls `openChild()` (`:2298-2307`), which **auto-generates** a starter child sheet via `makeChildSheet()` (`:2282-2297`): every block pin becomes a port on the new sheet, placed on the matching side, and the block's own `.sheet` is set to the new sheet's id. An AI building a full project top-down can pre-populate this link itself (set `sheet` on the parent-sheet block and include the child sheet in `sheets[]`) rather than relying on the editor to synthesize it.
- `pinPortDiff(block, childSheet)` (`:2311-2327`) is the drift detector: it matches block pins to child-sheet ports by bare (suffix-stripped) name and flags `missing` (pin has no port), `extra` (port has no pin), and `width` (bus size differs) — surfaced by the in-editor checker as errors/warnings, not enforced on save.

---

## 2. Serialization — two shapes, one strict, one loose

`loadJSON(o)` (`topdown-schematic.html:2426-2432`) accepts exactly three top-level shapes, checked in order:

1. **Full project** — `o.sheets && o.meta` → replace `P` wholesale, `ensureProjectDefaults()` backfills.
2. **Single strict sheet** — `o.nodes && o.frame` → `normalizeSheet()` fills missing `id/frame/nodes/wires/title/module`, then insert as a new sheet after the active one.
3. **Loose shape** — `o.title && (o.blocks || o.nodes)` → run through `fromLoose()`.

`topdown_mcp.py`'s `save_design()` recognizes the same three shapes (`ok = ("sheets" in obj and "meta" in obj) or ("nodes" in obj and "frame" in obj) or ("title" in obj and ("blocks" in obj or "nodes" in obj))`, `topdown_mcp.py:240-244`) — **the MCP's schema (`get_schema()`) documents only the strict shapes** (project / single sheet); the loose shape is accepted by both sides but intentionally left unvalidated server-side (comment at `topdown_mcp.py:252-253`), because the tolerant client-side loader is what's supposed to fix it up.

### 2.1 `fromLoose()` — the tolerant loader (`topdown-schematic.html:2466-2473`)

```js
function fromLoose(o){
  const s=newSheet(o.title,o.module||o.title);
  (o.blocks||o.nodes||[]).forEach(b=>{
    if(b.type&&b.type!=='block'){ s.nodes.push(Object.assign({id:b.id||uid()},b)); return; }
    s.nodes.push(mkBlockAt(b));            // b.label/pinsL/pinsR/pinsB/pinsT, defaults 'in'/'out'
  });
  (o.wires||[]).forEach(w=>s.wires.push({id:uid(), from:w.from, to:w.to, bus:w.bus||0}));
  return s;
}
```
What it tolerates that the strict schema doesn't:
- Either key `blocks` or `nodes` for the node array.
- Items with no `type` (or `type:'block'`) are treated as blocks and defaulted through `mkBlockAt()` (`:2473`) — missing `x/y` → `100,100`; missing `pinsL/pinsR` → `['in']`/`['out']`; missing `label` → `'Block'`.
- Items that *do* have a non-`block` `type` are passed through almost as-is (`Object.assign({id:...}, b)`), still flat, still not size-computed until `fixSheetDefaults()` runs afterward.
- No `frame`, `wires`, or `id` required at all (all synthesized by `newSheet`/`fixSheetDefaults`).

Regardless of which of the three shapes was used, **every** sheet is finally run through `fixSheetDefaults()` (`:2454-2464`), which:
1. Assigns a sheet `id` if missing.
2. Strips the legacy `⊂` glyph from the title.
3. **Unwraps nested type-wrapper objects** via `unwrapNode()` (`:2439-2448`): older generators (and an earlier, incorrect version of this very MCP server) emitted `{type:'block', block:{label,pinsL,...}}`. The loader detects a `block|gate|mux|port|const` key holding an object and hoists its fields onto the node directly, deleting the wrapper. **The current MCP schema explicitly warns against this** and `_validate_sheet` rejects it outright with a hint (`topdown_mcp.py:180-184`) rather than relying on the client-side unwrap — i.e. the server is stricter than the client on this specific mistake.
4. Recomputes `w/h` for blocks (`recalc`), backfills gate `w/h/inputs` and mux `w/h` if absent.
5. Assigns wire `id`s if missing.

### 2.2 Canonical JSON — full project

```json
{
  "meta": {"projectName":"Digital Systems Lab","studentId":"67010500","studentName":"...","section":"CE","page":"1"},
  "sheets": [
    {
      "title": "4th Layer ⊂ (Comparator)",
      "module": "Comparator",
      "frame": {"x":120,"y":150,"w":900,"h":600},
      "nodes": [
        {"id":"a1","type":"port","x":150,"y":240,"name":"A1","side":"left"},
        {"id":"b1","type":"port","x":150,"y":440,"name":"B1","side":"left"},
        {"id":"g1","type":"gate","x":560,"y":300,"gate":"xnor","inputs":2},
        {"id":"and","type":"gate","x":800,"y":380,"gate":"and","inputs":4},
        {"id":"reg","type":"block","x":560,"y":460,"label":"D_FF_CLR",
         "pinsL":["D","clk","~CLR"],"pinsR":["Q"],"pinsB":[],"pinsT":[]},
        {"id":"eq","type":"port","x":1000,"y":402,"name":"EQ","side":"right"}
      ],
      "wires": [
        {"from":{"node":"a1","pin":"p"},"to":{"node":"g1","pin":"in0"},"bus":0},
        {"from":{"node":"b1","pin":"p"},"to":{"node":"g1","pin":"in1"},"bus":0},
        {"from":{"node":"g1","pin":"out"},"to":{"node":"and","pin":"in0"},"bus":0},
        {"from":{"node":"and","pin":"out"},"to":{"node":"eq","pin":"p"},"bus":0},
        {"from":{"node":"g1","pin":"out"},"to":{"node":"reg","pin":"L0"},"bus":0}
      ]
    }
  ]
}
```
(This is `EXAMPLE_SHEET` from `topdown_mcp.py:93-113`, wrapped in a project envelope; also returned verbatim as a single sheet by `get_example()`.)

### 2.3 Canonical JSON — single sheet (no project envelope)

Same as one entry of `"sheets"` above — a bare `{title, module, frame, nodes, wires}` object, which `save_design`/`loadJSON` both accept directly (shape 2, §2 above).

---

## 3. Sync / bridge mechanism

### 3.1 Editor side (`topdown-schematic.html:2479-2502`)

The "Sync ⟳" button is **manual, pull-based, one-shot** — there is no polling loop.

1. On click, `prompt()` asks for a bridge URL, pre-filled from `localStorage['tdd_bridge']` if previously used, else defaulting to `http://127.0.0.1:8765/latest.json`.
2. `fetch(url, {cache:'no-store'})` (`:2486`) — a plain GET, no auth, no request body.
3. On success, the returned JSON is passed straight into `loadJSON(o)` — i.e. it goes through the exact same three-shape dispatch as manual Import (§2), so a full project **replaces** `P` wholesale, while a single sheet or loose shape is **inserted** as a new sheet right after the active one (`P.sheets.splice(P.active+1,0,...); P.active++`). It is never a diff/merge against the currently open sheet's nodes.
4. The URL is remembered in `localStorage` on success; a toast reports how many sheets/parts loaded; `runCheck(false)` re-runs the ERC checker on the freshly loaded sheet automatically.
5. On failure (network error, non-2xx, bad JSON), the error is shown in the checker panel with a specific hint: *"A page opened from claude.ai cannot reach localhost; save this file and open it from disk."* — i.e. this mechanism only works when the HTML is opened as a local file or from a local dev server, not from a hosted origin (CORS/localhost-reachability caveat worth carrying into the shared design).

### 3.2 MCP server side (`topdown_mcp.py`)

Two independent transports sharing the same `./designs/` directory (override via `TOPDOWN_DIR` env var):

- **stdio MCP transport** (`mcp.run()`, always on) — the actual Claude-facing tool surface:
  - `get_schema()` → returns the `SCHEMA` dict verbatim (also exposed as MCP resource `topdown://schema`). Documents the flat-field convention explicitly ("IMPORTANT: no nested wrapper key").
  - `get_example()` → returns `EXAMPLE_SHEET`, a worked 4-bit comparator.
  - `save_design(name, design)`:
    - Parses `design` as JSON; rejects non-dict top level.
    - Classifies shape (project / strict sheet / loose) exactly as `loadJSON` does.
    - For project/strict-sheet shapes, runs `_validate_sheet()` per sheet (loose shape is intentionally skipped — the client-side `fromLoose()` is the tolerant path).
    - `_validate_sheet()` (`:169-215`) checks: no nested type-wrapper keys; every node has a unique non-empty `id`; `type` is one of the 5 strict types; per-type required fields (`block.label`, `gate.gate` in the 8-value enum, `port.name`, `const.value` in `{0,1}`); and — the important one — **every wire endpoint's `{node,pin}` is checked against the pins that node's own fields would actually generate** (`_node_pin_ids()`, mirroring the HTML's `pins()`), so a wire into a nonexistent pin is rejected at save time rather than silently drawn broken. Up to 25 errors are listed per call.
    - On success, writes `designs/<safe-name>.json` **and** overwrites `designs/latest.json` with the same content (`_write()`, `:123-129`) — `latest.json` is what Sync fetches by convention.
  - `list_designs()` → lists `designs/*.json` with sheet counts.
  - `read_design(name)` → round-trips a saved file back to the model so it can be revised and re-saved.
- **HTTP bridge** (`_Bridge` / `ThreadingHTTPServer`, only started with `--serve`, port from `TOPDOWN_PORT` env, default `8765`):
  - `GET /<name>.json` (or bare `/` → `latest.json`) serves a file straight out of `DESIGN_DIR`, refusing anything that resolves outside that directory (path-traversal guard, `:311`).
  - Every response sets `Access-Control-Allow-Origin: *` and `Cache-Control: no-store` — CORS-open by design since it's `127.0.0.1`-only anyway, and no-cache so Sync always sees the latest save.
  - 404 JSON body for anything else; logging silenced.

### 3.3 This as a reusable pattern

The pattern worth carrying into a shared hub is: **(schema tool) → (example tool) → (validate-before-write save tool, with structural + referential checks specific to the target renderer) → (flat-file "latest" pointer) → (dumb polling-free HTTP GET bridge) → (manual pull button in the target app, replace-or-insert semantics, remembered URL)**. It cleanly separates "AI produces JSON it can get right on the first or second try because validation errors are specific and file/line-free" from "the target app decides how to merge it," and needs no push channel, websockets, or the target app running anything beyond a GET. The main portability wrinkle is the localhost-only reachability, which already breaks for a hosted (non-file://, non-localhost-dev) version of the editor — a shared hub design should either keep every editor as a local file/dev server, or replace the pull-fetch with something reachable from a hosted origin (e.g. the hub pushing via `postMessage`/a WebSocket instead of the editor polling `127.0.0.1`).

---

## 4. Rendering / layout basics

- **Coordinate system**: one flat "world" coordinate space per sheet (arbitrary units, not pixels — a `view{x,y,w,h}` viewbox + `mmPerUnit` maps world units to millimeters for the print/SVG/G-code export paths). `view` is fit to the sheet's `frame` plus padding by `fitView()` (`:2399`).
- **Node anchor semantics differ by type**:
  - `block`/`gate`/`mux`: `(x,y)` is the **top-left** of the bounding box; `w/h` are derived (blocks) or fixed-by-type (gate/mux).
  - `port`/`const`/`netlabel`: `(x,y)` is the **anchor/pin point** itself; the visible tail extends *outward* from it in the direction implied by `side` (26 world units for a port, 16 for a const, `geom()` :543-562). There is no `w/h` for these types.
- **Pin geometry is always computed, never authored** — `pins(n)` (`:448-474`) derives every pin's absolute `{x,y}` from the owning node's box/anchor plus its declared side and index; row spacing for block pins is a fixed `top=20, sp=22` world units. A JSON author only ever supplies pin *names/order*, never coordinates.
- **Auto-sizing**: `recalc(n)` (block only) grows the box to fit the longest paired left/right pin-name row and the label, at 7px/char scaled by the global `P.text.scale` multiplier (`TS()`, `:372`); gates and muxes are fixed-size per type.
- **Auto-routing**: wires are Manhattan-routed automatically (`routeThrough()`, `:685-731`, building on the lower-level `mkRoute`/`routeParts` shape primitives `:625-649`) — straight/L/Z/staircase depending on relative pin positions and approach direction (`approachDir()` accounts for the fact that a port's stub faces outward, so the wire must approach from the *circuit* side, the opposite of a block/gate pin). A generator does not need to place wire geometry — supplying just `{from,to,bus}` is sufficient and matches how the MCP schema is written. Optional hand-placed `pts` waypoints can override the router per-wire but are an editor/UI feature, not something an AI author needs to (or should) produce.
- **No auto-placement of nodes**: `x/y` for every node must be supplied (or defaults to `100,100` via `mkBlockAt` in the loose loader) — there's no force-directed or grid auto-layout pass anywhere in the file. A generator authoring a full sheet is responsible for laying out `x/y` sensibly (left-to-right signal flow, ports on the sheet edges, room for `recalc()`'s label-driven block widths) since the editor will draw exactly the coordinates it's given.
- **Hierarchy marker**: a block with a `.sheet` link gets a small nested-rectangle glyph drawn in its bottom-right corner (`geom()`, `:489-494`) so a rendered sheet visually distinguishes "detailed" blocks from leaf ones.

---

## 5. Comparison with the gate-level editor (`schematic&bus2vhdl.html`)

| Aspect | Top-down (`topdown-schematic.html`) | Gate-level (`schematic&bus2vhdl.html`) |
|---|---|---|
| Project container | Single `P{meta, sheets[]}` — one ordered list of sheets forming (via `block.sheet` back-links) one implicit tree | `state.project.schematics{id → {name, components[], wires[]}}` — a dict of independently-named, potentially reusable schematics, plus `customs{}` and a `topId` designating the synthesis entry point |
| Component/node granularity | 5 authorable node types (`block,gate,mux,port,const`) + editor-only `netlabel`; `block` is a free-form, opaque architectural box — arbitrary named pins grouped by side, no behavior | Large parametric library (LIB) of primitives — basic gates, but also adders, comparators, decoders, counters, registers, flip-flops with optional `reset`/`preset` params, RAM, and instanced sub-schematics (`type:"sch:<id>"`) — each generates its own pin list *and* pixel geometry from parameters |
| Pin geometry | Always computed from node box + declared side/index (`pins()`) | Also computed, but per-component via a `ports(params)` generator returning **explicit `dx,dy` pixel offsets** (`{id,dir,dx,dy,width,label}`) |
| Bit width | Advisory only: parsed out of a pin's *name string* suffix (`D0[3:0]`) via `busOfName()`, or a wire's own `bus:n` label; nothing downstream is bit-exact | First-class, numeric `width` field on every pin/port, used to build a real per-bit netlist and to emit synthesizable VHDL |
| Wires | Single drawn line per connection, optional `bus` display label, no true fan-out to bits; checker cross-validates width labels against inferred pin widths as an ERC warning/error | Netlist-accurate; wires participate in bit-level connectivity used directly for VHDL codegen |
| Hierarchy mechanism | `block.sheet = childSheetId`; parent found by reverse scan (`parentOf`); pin↔port drift is only checker-flagged (`pinPortDiff`), not enforced; **implicitly assumes one parent block per child sheet** (no supported multi-instantiation) | A schematic can be instanced as a component (`sch:<id>`) any number of times across the project; its port list is derived live from the referenced schematic (`schPortList`) and is authoritative for every instance |
| Output artifact | None beyond the drawing itself — SVG/PNG export and G-code (pen-plotter) export for hand-drawn-style paper submissions; explicitly **not** synthesizable | VHDL generation is the point of the tool — components/wires exist specifically to be translatable to structural VHDL |
| Validation | Static ERC-style checker (`checkSheet`): dangling pins, unconnected nets, multi-driver nets, bus-width mismatches along a net, block/child-sheet pin drift — advisory, not blocking on save except via the MCP's own `save_design` referential check | Presumably a fuller netlist/ERC feeding directly into codegen (not required for this doc's scope, but width/connectivity checks are load-bearing for VHDL correctness, not just advisory) |
| AI-authoring surface | `topdown_mcp.py`: schema/example/save/list/read tools + local HTTP bridge, described in §3 | Not covered by this doc (no equivalent MCP server observed in these two files) |

### Concrete challenges for a shared data model / topdown → gate refinement step

1. **Width representation.** Topdown widths live in *text* (`Name[3:0]`) or an advisory `bus:n` int; gate-level widths are canonical numeric fields on every pin. A shared schema needs one canonical numeric `width` per pin/port; topdown's bracket-suffix convention should become a *derived display label*, not the source of truth, so refinement into a gate schematic doesn't have to re-parse strings.
2. **Opaque block vs. generated-parametric component.** A topdown `block` is just a named pin list with no behavior; a gate-level component is a typed instance of a library entry whose *geometry and pin count* are a function of its parameters. A block has no equivalent on the gate side until it is refined — the shared model likely needs a node kind that can be "abstract" (topdown block: pins only, no semantics) versus "concrete" (gate-level: typed + parametrized), with an explicit state transition between them rather than one universal node shape.
3. **Hierarchy authority direction.** Topdown treats the child sheet as loosely-coupled and checker-corrected after the fact (`pinPortDiff` just warns); gate-level treats the referenced schematic's port list as always authoritative for every instance. Refining a topdown block into a gate-level sheet means deciding whether the *topdown block's pin list* seeds the new gate schematic's ports one-way (mirroring what `makeChildSheet()` already does inside the topdown tool, §1.6), or whether the two must be kept in sync bidirectionally after refinement (topdown pin renamed → gate ports renamed, and vice versa).
4. **No supported multi-instantiation on the topdown side.** `parentOf()`'s reverse-scan assumes a child sheet has one parent block. Gate-level explicitly supports instancing the same schematic many times. If the shared/AI-facing format wants "reusable topdown sub-blocks" (e.g. same 4-bit adder block appearing three times), the topdown side needs either a real instance/definition split (unlike its current per-block sheet pointer) or an explicit decision to keep topdown sheets 1:1 with their parent block and only allow multi-instancing once refined to gate level.
5. **Netlist fidelity gap is exactly the refinement boundary.** Nothing in the topdown model is bit-exact or synthesizable; everything in the gate-level model is. This means "topdown → gate" is not a lossless format conversion — it is a genuine design step (the human/AI must decide gate-level implementation for every topdown `block`), whereas topdown's `gate`/`mux`/`port`/`const` node types map close to 1:1 onto gate-level primitives/ports already (same logical roles, different metadata richness). A shared AI tool-format should probably model this explicitly: "refine block X" as its own operation/tool call that consumes a topdown block's pin list and produces a brand-new gate-level schematic + component-library choices, rather than trying to force one JSON shape to serve both editors natively.
6. **Bridge/sync pattern reuse.** The MCP `get_schema/get_example/save_design/list_designs/read_design` + `latest.json` + `127.0.0.1` HTTP GET bridge + manual "Sync" button pattern documented in §3 is renderer-agnostic and directly reusable for a gate-level MCP server (or a unified one) — the main required additions for gate-level are (a) per-pin numeric width in the schema/validation and (b) validation against the parametric library's generated port lists instead of a fixed per-type pin-id function.
