# Schematic Studio — Data Model Reference

Source file: `C:\Users\dinuc\OneDrive\เอกสาร\digital\schematic&bus2vhdl.html` (single-file HTML/JS app, ~8226 lines, no build step, no framework — plain DOM + inline SVG). All line numbers below refer to this file as it exists today; re-check if the file is edited.

This document describes the in-memory data model and the on-disk (localStorage / file) JSON serialization, so a Python service can read/write/generate the same structures.

---

## 1. Global `state` and `state.project` shape

### 1.1 `state` (in-memory only, NOT what gets serialized as a whole)

Defined at `schematic&bus2vhdl.html:2157-2184`:

```js
const state = {
  projects: {},             // {pid: project}  — the whole open workspace
  activeProjectId: null,
  project: blankProject(),  // the ACTIVE project object (same object as projects[activeProjectId])
  activeId: null,           // id of the currently-open schematic (sheet) within state.project
  openTabs: [],             // [schId, ...] open sheet tabs for the active project
  selection: new Set(),     // component/wire ids selected in the active schematic (UI only)
  pendingWire: null,        // transient wire-drawing state (UI only)
  wireDrag: null, cornerDrag: null, wireAnchor: null,   // transient (UI only)
  spaceDown: false, tool: "select", drag: null, pan: null,
  view: {x:0,y:0,k:1},      // pan/zoom camera (UI only, per-session, not persisted with project data)
  mouse:{x:0,y:0}, hover:null,
  history:{stack:[],idx:-1,muted:false},   // undo/redo, JSON snapshots of {p,a,t,pid} (2212-2235)
  autosaveTimer:null,
  clipboard:null,           // {components:[], wires:[]} for copy/paste
};
```

Everything durable lives under `state.projects` / `state.project`. `state.project` is always the *same object reference* as `state.projects[state.activeProjectId]` (see `switchProject`, 7041-7059).

### 1.2 `state.project` (a "project" = one Vivado-style workspace with multiple sheets)

Created by `blankProject()` (1185-1193 — actually 2185-2193):

```js
function blankProject(){
  const id = uid("sch");
  return {
    name: "my_project",
    topId: id,                              // id of the schematic to treat as top-level entity
    schematics: { [id]: blankSchematic(id, "top") },   // map: schId -> schematic object
    customs: {}                              // map: customName -> custom-component object
  };
}
```

Fields actually found on a live/loaded `project` object:

| field | type | notes |
|---|---|---|
| `name` | string | sanitized with `sanId()` on save (line 6998, 8162) |
| `id` | string | project id, `uid("prj")`; assigned lazily by `seedWorkspace`/`serialize`/`deserialize` (2199-2202, 6852-6856, 6978) |
| `topId` | string | key into `schematics`; the entity Vivado treats as top |
| `schematics` | `{ [schId]: Schematic }` | every sheet in the project |
| `customs` | `{ [name]: CustomComponent }` | reusable custom blocks (see §4) |
| `activeId`, `openTabs`, `expanded` | UI state stashed onto the project by `stashProjectUi()` (7035-7040) so each project remembers its own open tabs/desk across `switchProject` |

### 1.3 A single schematic / sheet

`blankSchematic()` (2194-2196):

```js
function blankSchematic(id, name){
  return { id, name, components: [], wires: [] };
}
```

So a schematic is exactly `{ id, name, components: Component[], wires: Wire[] }`. No other required fields; `deserialize()`'s `fixSheet()` (6916-6922) defensively adds `components`/`wires` arrays and fills `id`/`name` if missing when loading external files. `name` is a VHDL-legal, deduplicated identifier — `deserialize` re-runs every sheet name through `sanId()` and dedups project-wide (6969-6975), and this `name` becomes the generated VHDL **entity name** for that sheet.

---

## 2. Component object shape and the `TYPES` catalog

### 2.1 Component instance shape

A component instance (as it lives in `schematic.components[]`) has this shape (see e.g. the seed circuit at 8195-8200, `addComp` at 2580 ff., `stampTapOnWire` at 2747):

```js
{
  id:     "c3",        // uid("c") — see §6
  type:   "AND",        // key into TYPES, or "SCH:<schId>", or "CUSTOM:<name>"
  x: 264, y: 220,        // top-left of the component's local bounding box, canvas coords, GRID-snapped
  params: { inputs: 2, width: 1 },   // type-specific params, see 2.2
  label:  "",            // OPTIONAL user-editable instance designator (free text, see below)
  rot:    0,             // OPTIONAL rotation in degrees, one of 0/90/180/270 (3121-3126)
  mirror: false          // OPTIONAL horizontal-flip flag (3118, mirrorSelection at 3146-3153)
}
```

- `x`/`y`: absolute canvas coordinates of the untransformed (rot=0, mirror=false) bounding box's top-left corner; every port position is computed as `x/y + orientLocal(c, port.dx, port.dy)` (`portPos`, 3129-3134), where `orientLocal` (3115-3128) applies mirror-then-rotate about the component's own center using its `getSize()` box.
- `params`: plain JS object, shape depends on `type` (see TYPES catalog below). Always JSON-cloned when copy/pasting (`JSON.parse(JSON.stringify(...))`, e.g. 7593-7595, 7964-7966).
- `label`: **not** the type's display name (`TYPES[type].label`, e.g. "AND") — it's an optional free-text designator the user types in the Inspector (`#iLabel`, 5388). It must be unique per-sheet (`uniqueLabel()`, 5612 ff.) and, when set, it (a) is shown under the symbol on canvas (4831-4837), (b) seeds the VHDL signal name for that block's output ports (`carry_o` instead of `n7_o`, line 6053), and (c) becomes the instantiation label `u_<label>` for `SCH:`/`CUSTOM:` sub-block instances (line 6036).
- `JUNCTION` components additionally carry params like `{axis:"h"|"v", endpoint:true, fixed:true}` — internal bookkeeping for wire routing/healing (see §3.3).

### 2.2 The `TYPES` catalog (schematic&bus2vhdl.html:1286-1692)

`TYPES` is a plain object `{ TYPE_KEY: TypeDef }`. Every `TypeDef` has this contract (comment at 1082-1091):

```js
{
  label: "AND",             // display name
  category: "gate"|"io"|"wire"|"mux"|"cmp"|"bus"|"code"|"ff"|"custom"|"sch",
  defaultParams: {...},     // params object used when a new instance is dropped
  paramSchema: [ {key, label, type:"string"|"int"|"select"|"bool", ...} ],  // drives the Inspector form
  size(params) -> {w,h},
  ports(params) -> [ {id, dir:"in"|"out", dx, dy, width?, label?} ],
  shape(params) -> "<svg innerHTML string>",
  expr(ins) -> "vhdl expression string"   // gates only; other types build VHDL via generateSchVhdl instead
}
```

Every port entry is `{ id, dir, dx, dy, width, label }`: `id` is the string used in `wire.from.pid`/`wire.to.pid`; `width` (bits) defaults to `1` when absent; `dx,dy` are LOCAL offsets from the component's `x,y` before rotate/mirror.

Full catalog, one row per type key:

| TYPE key | category | ports (id: dir, width) | key params | notes |
|---|---|---|---|---|
| `IN` | io | `o`: out, width=`params.width` | `{name, width}` | INPUT pin marker; VHDL entity input; `ioLabel()`=`name(width-1:0)` (1239); shape width via `ioShapeW()` (1241) |
| `OUT` | io | `i`: in, width=`params.width` | `{name, width}` | OUTPUT pin marker |
| `VCC` | io | `o`: out (width 1 implied) | `{}` | drives constant `'1'` |
| `GND` | io | `o`: out, `dy:0` | `{}` | drives constant `'0'` (fixed bug noted in comment: GND is a driver, not a sink, 1333-1336) |
| `CONST` | io | `o`: out, width=`constWidth(p)` | `{value:"hex string", width}` | fixed value; `constVhdl()` emits `x".."` (width%4==0) or `"binary"` literal (1273-1277); `constHex/constBits/constLabel` (1249-1268) normalize free-typed hex |
| `JUNCTION` | wire | `j`: out (used bidirectionally) | `{axis?, endpoint?, fixed?}` | connection dot / branch point; not a real gate — VHDL gen traces through it |
| `AND`,`OR`,`NAND`,`NOR`,`XOR`,`XNOR` | gate | `i0..i(n-1)`: in, `o`: out, all width=`params.width` | `{inputs:2-8, width:1-32}` | built by `gateDef()`/`gatePortsAndSize()`/`gateBodyShape()` (1096-1227); n inputs configurable 1-8 (2 default), bit width 1-32 applies uniformly (element-wise VHDL op) |
| `NOT`,`BUF` | gate | `i0`: in, `o`: out | `{inputs:1, width:1-32}` (inputs fixed at 1, no schema row) | same gate family, `expr()` = `not x` / `x` |
| `MUX` | mux | `d0..d(n-1)`: in, `s0..s(sel-1)`: in, `y`: out (all width 1 implied) | `{inputs: 2\|4\|8\|16}` | `sel = ceil(log2(inputs))`; size/ports built in 1393-1419 |
| `DEMUX` | mux | `d`: in, `s0..s(sel-1)`: in, `y0..y(n-1)`: out | `{outputs: 2\|4\|8\|16}` | 1420-1446 |
| `COMP` | cmp | scalar form (width<8): `a0..a(n-1)`,`b0..b(n-1)`: in; bus form (width>=8): `a`,`b`: in width=n; `eq`: out | `{width: 2\|4\|8\|16}` | equality-only comparator; `cmpDef(false)` (1165-1200); pin style picked by `cmpIsBus(p)` = `width>=8` (1164) |
| `COMPM` | cmp | same as COMP plus `gt`,`lt`: out instead of `eq` | `{width: 2\|4\|8\|16}` | magnitude comparator; `cmpDef(true)` |
| `BUSTAP` | bus | `d`: in, width=2 (marker only); `y`: dir depends on `mode` (out if split, in if merge), width=`nbit` | `{bit:0-31, nbit:1-32, mode:"split"\|"merge", dir:"right"\|"down"\|"left"\|"up"}` | reads/writes a bit-range out of/into a bus; see §3.4 |
| `ENC` | code | `i0..i(n-1)`: in, `y0..y(ow-1)`: out | `{inputs: 4\|8\|16}` | priority encoder, `ow=ceil(log2(inputs))` (1517-1535) |
| `DEC` | code | `a0..a(iw-1)`: in, `en`: in, `y0..y(n-1)`: out | `{outputs: 4\|8\|16}` | decoder, `iw=ceil(log2(outputs))` (1536-1555) |
| `DFF` | ff | `d`,`clk`: in; `rst`: in (if `reset`); `pre`: in (if `preset`); `q`,`qn`: out | `{edge:"rising"\|"falling", reset:bool, preset:bool}` | 1558-1590 |
| `JKFF` | ff | `j`,`k`,`clk`: in; optional `rst`,`pre`; `q`,`qn`: out | same params | 1591-1624 |
| `TFF` | ff | `t`,`clk`: in; optional `rst`,`pre`; `q`,`qn`: out | same params | 1625-1656 |
| `SRFF` | ff | `s`,`r`,`clk`: in; optional `rst`,`pre`; `q`,`qn`: out | same params | 1657-1691 |

Only `IN`/`OUT`/`CONST`, the 8 gate types, and `COMP`/`COMPM`/`BUSTAP` expose a per-instance bit **width** at all — MUX/DEMUX/ENC/DEC/FF ports are always effectively 1-bit (no `width` param in their schema).

`TYPES` is looked up indirectly through `typeDef(c)` (1695-1707), which special-cases `c.type` prefixes:

```js
function typeDef(c){
  if(c.type.startsWith("CUSTOM:")) return customTypeDef(state.project.customs[c.type.slice(7)]);
  if(c.type.startsWith("SCH:"))    return schTypeDef(state.project.schematics[c.type.slice(4)]);
  return TYPES[c.type];
}
```
`getPorts(c)`, `getSize(c)`, `getPort(c,pid)` (1708-1710) are the standard accessors used everywhere else in the code — always go through `typeDef()`, never index `TYPES` directly, so hierarchy types resolve correctly.

---

## 3. Wire object shape, nets, junctions, bus taps, net names

### 3.1 Wire shape

```js
{
  id:   "w6",                         // uid("w")
  from: { cid: "c1", pid: "o" },      // source component id + port id
  to:   { cid: "c3", pid: "i0" },     // sink component id + port id
  name: "sum_w",                      // OPTIONAL net name (see 3.2); "" or absent = unnamed
  width: 1,                           // OPTIONAL, LEGACY/vestigial — see note below
  pts:  [ {x:308,y:110} ],            // OPTIONAL hand-placed interior waypoints (absolute canvas coords)
  autoPts: [ {x:...,y:...} ]          // OPTIONAL auto-router-computed detour points (never both meaningful at once)
}
```

Found via `splitWireThroughJunction` (3710-3739), `keepPicture` (1859-1873), and every `sch.wires.push({...})` call site (2754, 2789, 2796, 3036, 3170, 3227, 3236-3237, 4300, 4310, 8203-8208).

**Important: `wire.width` is NOT authoritative.** A wire stores nothing reliable about its own bit width; the width is *always derived* by walking to the real driving port:

```js
// 2018-2035
function wireWidth(w, sch, seen){
  const src = comp(w.from.cid, sch);
  if(src.type==="JUNCTION"){
    const up = sch.wires.find(x=>x.to.cid===src.id);
    return up ? wireWidth(up, sch, seen) : netPortWidth(sch, w);
  }
  const fp = getPort(src, w.from.pid);
  return fp ? (fp.width||1) : 1;
}
```
See §7 for the full width story. A Python emitter should NOT trust a `width` key on a wire object if present (it's copied around for legacy/undo reasons, e.g. `splitWireThroughJunction` line 3726/3732) — always recompute from the driving port.

### 3.2 Net names

There is **no separate "NETNAME" component type**. A net name is just the optional `name` string on ONE wire segment of the net (conventionally the segment nearest the driver — `splitWireThroughJunction` keeps `name` only on the "head" half, line 3720-3726). Setting it is done by the `netname` UI tool via `applyWireName(w, raw)` (2648-2668):

```js
function applyWireName(w, raw){
  if(raw===null) return;               // cancelled
  const txt = String(raw).trim();
  if(!txt){ /* clear .name on every wire in the net (netWires) */ delete w.name; return; }
  w.name = sanId(txt);                 // sanitized VHDL identifier
}
```
`sanId()` is applied, so the stored name is already a legal VHDL identifier. During VHDL generation, an explicit wire `.name` overrides the auto-generated signal name for that net (6059-6070+).

### 3.3 Junctions (`type:"JUNCTION"`)

A junction is a real component (`type:"JUNCTION"`, single port `j`, `ports:_=>[{id:"j",dir:"out",dx:6,dy:6}]`, 1368-1378) used as:
- a **branch/fan-out dot** (multiple wires meeting),
- a **pass-through** point (one wire split into two, e.g. so a Bus Tap can attach mid-run),
- a **dangling free end** (`params.endpoint:true` — a wire deliberately left unconnected in open space).

`params` fields seen on junctions: `axis: "h"|"v"` (which direction it was "hosting" a straight run when last drawn/loaded — stamped once by `stampJunctionAxis()`, 1878-1902, so editing siblings doesn't re-elbow it), `endpoint: true` (dangling free end, kept across saves — see `healJunctions`, 1904-1992), `fixed: true` (seen on tap-created junctions, 2751).

A **net** = the transitive closure of all wires connected to each other through JUNCTION endpoints only (real component pins terminate a net). Traversal: `netWires(sch, w0)` (3745-3759) walks undirected across junctions and returns a `Set` of wire ids; `netDriverPort(sch, w)` (4351-4360) walks strictly *upstream* (via `w.from.cid` chains) until it hits a non-JUNCTION component, returning that `{cid,pid}` as the net's driver.

`healJunctions(sch)` (1904-1992) is the garbage-collector/normalizer for junctions, run on load and after edits: removes 0-wire orphans, promotes 1-wire dots to `endpoint:true` stubs (only if the remaining wire reaches a real symbol) or deletes them (if it reaches another junction), merges pure pass-through (1-in/1-out) dots back into a single wire, and welds coincident/near fan-out dots.

### 3.4 Bus taps (`type:"BUSTAP"`)

Represents ISE's bus "rip": a small triangle where a thin (usually 1-bit or narrow) wire meets a bus. It is a real component with two ports:
- `d` (width 2 — a drawing-only marker meaning "this pin sits on the bus", NOT a real 2-bit claim, 1485-1488),
- `y` (width = `params.nbit`, direction = `out` if `mode:"split"` (reading a slice out of the bus) or `in` if `mode:"merge"` (writing a slice into the bus)).

`params: { bit, nbit, mode:"split"|"merge", dir:"right"|"down"|"left"|"up" }` — `bit`/`nbit` select which bit-range of the bus this tap reads/writes; `mode` is decided by whether the thin wire it attaches to already has a driver (§2748-2769, `stampTapOnWire`); `dir` is purely the drawn orientation of the triangle glyph.

Net width for an undriven bus (before any tap exists) is resolved by `netPortWidth(sch, w0)` (2042-2054), which scans every real (non-JUNCTION, non-BUSTAP) port touching the net and takes the widest one — this is how "drag a 16-bit OUTPUT into open space, then tap bits off it one at a time" works before any tap is placed.

---

## 4. Hierarchy: sub-sheets and custom components

### 4.1 Sub-schematic instances — `type: "SCH:<schId>"`

Any schematic can be dropped as a component INTO another schematic of the same project by using the pseudo-type string `"SCH:" + schId` (e.g. `"SCH:sch3"`). `typeDef()` (1695-1707) detects the `SCH:` prefix and returns `schTypeDef(sch)` (2123-2152) instead of a `TYPES[...]` entry:

```js
function schTypeDef(sch){
  const ins = sch.components.filter(c=>c.type==="IN"), outs = sch.components.filter(c=>c.type==="OUT");
  // ports come from schPortList(sch): dedup'd list, ordered IN-then-OUT, sorted by y then x
  // on the CHILD sheet — moving IN/OUT blocks up/down on the child re-orders the parent's pins
  ...
  return { label: sch.name, category:"sch", ports(){...}, shape(){...}, _sch: sch };
}
```
So an instance's ports are derived live from the child sheet's `IN`/`OUT` marker components — there is no separate stored port list on the instance; add/remove/rename an `IN`/`OUT` on the child and every parent instance's pins update automatically. Port **id** on the instance == the deduped port id from `schPortList()` (see §4.3); port **label** shown == the `IN`/`OUT`'s `params.name`; port **order** follows the child sheet's Y-then-X layout position of the IN/OUT blocks (comment 2077-2084), NOT creation order.

Cycle/self-instantiation guards: `schUsesSheet(id, targetId)` (2563-2572, recursive `SCH:` walk) and `subBlockBlockedWhy(id, hostId)` (2573-2578) forbid: instancing a sheet into itself, instancing the project's own `topId` sheet anywhere, or creating a cycle through nested `SCH:` instances. Enforced in `addComp()` (2589-2593) before an instance can be placed.

Renaming a sheet just needs its `name` field changed (the `SCH:<id>` type string is keyed on the **id**, which never changes) — this is why sheet identity is the `id`, not the `name`.

`removeInstancesOf(typeStr)` (1714-1727) and `rewriteInstanceType(from,to)` (1729-1733) sweep every schematic AND every custom component's inner schematic for a given `type` string — used respectively when a sheet/custom is deleted, or a custom is renamed (its `CUSTOM:oldname` instances get rewritten to `CUSTOM:newname`).

### 4.2 Custom components — `type: "CUSTOM:<name>"`

A **custom component** is a named, savable/exportable snapshot of a schematic's components+wires, stored under `state.project.customs[name]`:

```js
{
  name: "half_adder",
  description: "Exported from schematic",      // optional free text
  sourceSchematicId: "sch2",                    // optional, only set when freshly created from a live sheet (7591)
  schematic: {
    components: [ /* deep-cloned Component[] */ ],
    wires:      [ /* deep-cloned Wire[] */ ]
  }
}
```
(shape confirmed at 7588-7596 `openWizard()` "Create Component" path, and 7960-7967 `exportActiveAsCustom()`). Unlike `SCH:` instances, a custom component's schematic is a **frozen deep copy**, not a live reference to a project sheet — editing the original sheet afterward does NOT affect existing `CUSTOM:` instances. `customTypeDef(cc)` (2099-2121) builds its port list from `customPorts(cc)` → `schPortList(cc.schematic)` (2091-2096, 2073-2089), same dedup/ordering rules as §4.1. Legacy custom-component files may instead carry a flat `cc.ports: [{name,dir,width}]` array (no `schematic` field) — `customPorts()` falls back to that (2094-2095).

Export/Import (JSON, NOT localStorage):
- `exportCustomComponent(name)` (7620-7639) writes a package `{ type:"schstudio-custom-pkg", version:1, root:name, customs:{ [name]: cc, ...transitiveDeps } }` as a `.sccomp.json` download — nested `CUSTOM:` dependencies are walked via `collectCustomDeps()` (7607-7619) and bundled in the same file.
- `exportActiveAsCustom()` (7952-7978) does the same but builds `cc` on the fly from whatever sheet is currently open (no wizard, no `sourceSchematicId`).
- `importCustomComponent()` (7886-7951) accepts either the package format (`schstudio-custom-pkg`) or a legacy single-component format (`{ type:"schstudio-custom", custom: {...} }`); on name collision it renames the imported custom (`name_1`, `name_2`, ...) and rewrites any nested `CUSTOM:` references inside the imported bundle to match the renamed keys.

### 4.3 Port derivation shared by both hierarchy mechanisms — `schPortList()`

```js
// 2073-2089
function schPortList(sch){
  // dedupe IN/OUT params.name -> legal, unique port id via sanId() + numeric suffix
  // IN ports first (sorted by y,x), then OUT ports (sorted by y,x)
  return [ {cid, id, name, dir:"in"|"out", width}, ... ];
}
```
This ONE function is the canonical source for: the sub-entity's VHDL port list, its component-declaration, its port-map formals, AND the drawn instance's pin list — guaranteeing they can never disagree. A Python-side implementation of "instance the child sheet as a block" MUST reproduce this exact algorithm (dedupe collisions by appending `_1`, `_2`... via `sanId`, order = IN-then-OUT sorted by drawn `(y,x)` position) to get identical port ids to what the JS app would generate.

---

## 5. Persistence / serialization (MOST IMPORTANT SECTION)

### 5.1 Constants

```js
const AUTOSAVE_KEY = "schstudio.autosave.v2";   // line 998
const AUTOSAVE_MS  = 4000;                       // line 999 — autosave every 4s
```
Theme/hop-style prefs also ride in localStorage under separate keys (`"schstudio.hopStyle"`, `"schstudio.theme"`, `"schstudio.canvasHintDismissed"`-style key) — unrelated to project data.

### 5.2 Autosave (localStorage)

```js
// 7360-7383
function autosave(){ localStorage.setItem(AUTOSAVE_KEY, serialize()); }
function loadAutosave(){ const s = localStorage.getItem(AUTOSAVE_KEY); if(s) deserialize(s); }
function startAutoSave(){ state.autosaveTimer = setInterval(autosave, AUTOSAVE_MS); }
```
`init()` (8186-8219) calls `loadAutosave()` first; if nothing restores, it seeds a hard-coded half-adder demo circuit (see §5.5) and calls `startAutoSave()`. There is exactly one autosave slot — the WHOLE workspace (all open projects), not per-project.

### 5.3 The exact serialized shape — `serialize()` / `deserialize()`

```js
// 6845-6866
function serialize(){
  const SCRATCH = new Set(["_net","_nets","_netW"]);   // VHDL-codegen scratch fields, stripped on save
  stashProjectUi();  // pushes state.openTabs/state.activeId onto state.project.{openTabs,activeId}
  // ensures state.projects/state.activeProjectId are populated even from a half-built state
  return JSON.stringify({
    version: 2,
    workspace: { projects: state.projects, activeId: state.activeProjectId },
    project: state.project,     // ALSO written at top level = the active project (v1 back-compat)
    activeId: state.activeId,
    openTabs: state.openTabs,
  }, (k,v)=> SCRATCH.has(k) ? undefined : v, 2);
}
```

This is used both for `AUTOSAVE_KEY` (localStorage) and for the downloadable `.schproj.json` file (`saveProjectToFile`, 6997-7009 — filename via `dlName(name, ".schproj.json", "project")`, §6). **Same JSON shape both places.**

`deserialize(json)` (6874-6996) accepts either:
- a **version-2 payload** with `workspace.projects` (a multi-project workspace) — each project is round-tripped through this same function recursively as a synthetic version-1 payload, healed, then collected into `state.projects`; or
- a **version-1 / bare payload** with just `project` (+ optional `activeId`, `openTabs`) — treated as a single-project workspace.

On load it also runs a chain of repair/migration passes (order matters): `fixSheet` (ensure `components`/`wires` arrays, drop wires with a missing endpoint) → strip dead component types (`SPLIT,MERGE,BUSMERGE,BUSRIP,SHIFT` — pre-BUSTAP experiments) → migrate the very first bus-tap type name `"TAP"` → `"BUSTAP"` → `stampJunctionAxis` → `healJunctions` → `reseedUid(proj)` (MUST run before any new id is minted) → `normalizePortFanout` (old parallel-fanout wires → junction branches) → dedupe schematic names → commit to `state`.

### 5.4 Canonical serialized JSON example

A minimal, complete, valid saved project — one sheet ("top"), one 1-bit `IN` named `a`, one `NOT` gate, one `OUT` named `y`, wired straight through (matches the exact object shapes emitted by this app; ids follow the real `uid()` numbering rule from §6):

```json
{
  "version": 2,
  "workspace": {
    "projects": {
      "prj1": {
        "id": "prj1",
        "name": "my_project",
        "topId": "sch2",
        "schematics": {
          "sch2": {
            "id": "sch2",
            "name": "top",
            "components": [
              { "id": "c3", "type": "IN",  "x": 88,  "y": 110, "params": { "name": "a", "width": 1 } },
              { "id": "c4", "type": "NOT", "x": 264, "y": 104, "params": { "inputs": 1, "width": 1 } },
              { "id": "c5", "type": "OUT", "x": 440, "y": 110, "params": { "name": "y", "width": 1 } }
            ],
            "wires": [
              { "id": "w6", "from": { "cid": "c3", "pid": "o" }, "to": { "cid": "c4", "pid": "i0" }, "name": "" },
              { "id": "w7", "from": { "cid": "c4", "pid": "o" }, "to": { "cid": "c5", "pid": "i" },  "name": "" }
            ]
          }
        },
        "customs": {},
        "openTabs": ["sch2"],
        "activeId": "sch2"
      }
    },
    "activeId": "prj1"
  },
  "project": { "$ref": "same object as workspace.projects.prj1 above" },
  "activeId": "sch2",
  "openTabs": ["sch2"]
}
```

Notes for a Python implementation:
- `project` at the top level is a **redundant duplicate** of the active entry in `workspace.projects` (kept for version-1 readers). Emit both, keeping them structurally identical.
- Every id (`prj1`, `sch2`, `c3`, `c4`, `c5`, `w6`, `w7`) comes from ONE shared monotonic counter, not per-prefix counters — see §6. Do not assume `c1` exists just because `c3` does.
- `customs: {}` must be present even when empty (deserialize defaults it, but don't rely on that when emitting from Python — match the app's own output).
- Wire `name` is `""` when unnamed (the app always writes the key, just empty) — do not use `null`/omit for "no name" if you want byte-identical round-trips; note both are treated identically as falsy by `deserialize`/`applyWireName`.
- `wires[].pts` / `wires[].autoPts` are omitted entirely for straight auto-routed runs (only appear when geometry is hand-adjusted).
- A `SCRATCH` filter strips any lingering `_net`, `_nets`, `_netW` keys (VHDL-generator scratch state occasionally left on component objects) — a Python emitter never needs to produce these.

### 5.5 Reference "real" example already embedded in the app

The hard-coded seed circuit in `init()` (8195-8209) is a full half-adder (`a XOR b = sum`, `a AND b = carry`) and is the best "known-good, hand-verified" example to test a parser/generator against — components `IN a`, `IN b`, `XOR`, `AND`, `OUT sum`, `OUT cout`, six wires, one of them named `"sum_w"` and one named `"carry"`.

### 5.6 New Project / Save / Load / project switch entry points

| action | function | line |
|---|---|---|
| New Project (adds to workspace, does not clear others) | `newProject()` → `addProject()` | 7093-7099, 7060-7071 |
| Save to file | `saveProjectToFile()` | 6997-7009 |
| Load from file | `openProjectFromFile()` → `deserialize()` | 7010-7024 |
| Switch active project | `switchProject(pid)` | 7041-7059 |
| Rename / delete project | `renameProjectById`, `deleteProjectById` | 7072-7089 |
| New schematic (sheet) inside a project | inline handler at | 8055-8060 (`state.project.schematics[id] = blankSchematic(...)`) |
| Set a sheet as project top | inline handler at | 8069-8073 (`state.project.topId = state.activeId`) |

VHDL export additionally embeds the ENTIRE layout (all schematics + customs + topId, base64-JSON) inside a comment block in the generated `.vhd` file (`layoutStamp()`/`readLayoutStamp()`, 7106-7144, tags `-- @SCHEMATIC-STUDIO-LAYOUT-BEGIN/END`), specifically so re-importing generated VHDL restores the exact original schematic (not just a re-derived AST layout). This is a THIRD serialization channel worth knowing about for the AI pipeline: the `.vhd` file itself can round-trip the full schematic JSON.

---

## 6. IDs: `uid()`, `sanId()`, `reseedUid()`, `dlName()`, `VHDL_RESERVED`

```js
// 1024-1026
let _uidN = 1;
const uid = (p="i") => p + (_uidN++);
```
**One single global counter (`_uidN`) is shared across every prefix.** Calling `uid("c")`, `uid("w")`, `uid("sch")`, `uid("prj")` all draw from the same increasing sequence — so ids look like `sch1`, `c2`, `c3`, `w4`, `prj5`, `c6`, ... interleaved, never independent per-prefix counters. A Python generator that wants indistinguishable-from-native output must replicate this (keep one counter, advance it on every id mint regardless of type).

Prefixes actually used in the codebase: `"c"` (components), `"w"` (wires), `"sch"` (schematics), `"prj"` (projects). No fixed prefix is enforced anywhere at load time — `deserialize`/`reseedUid` only look at the trailing digits of every id string encountered.

```js
// 1998-2014
function reseedUid(p){
  // scans EVERY id in the given project (schematic ids, component ids, wire ids,
  // including inside every `customs[name].schematic`) for a trailing /(\d+)$/ and
  // bumps _uidN to (max found)+1
}
```
Called after loading any external project (file or autosave) so freshly-minted ids during subsequent editing/healing can never collide with ids already in the file. Must run BEFORE any healing pass that mints ids (e.g. `normalizePortFanout`), hence its placement in `deserialize()` (line 6953, and again 6988 after commit).

```js
// 1047-1057
const sanId = s => {
  s = (s||"").trim().toLowerCase().replace(/[^a-z0-9_]/g,"_");
  s = s.replace(/_+/g,"_").replace(/^_+|_+$/g,"");   // no leading/trailing/double underscore
  if(!s) s="net";
  if(/^[0-9]/.test(s)) s="n_"+s;                      // VHDL ids can't start with a digit
  if(VHDL_RESERVED.has(s)) s += "_s";                 // dodge reserved words
  return s;
};
```
`sanId()` is THE canonical "make this a legal, lowercase, unique-ish VHDL identifier" function — used for project names, schematic names, pin names, wire names, custom-component names, and generated signal names. It is NOT guaranteed globally unique by itself (callers add numeric suffixes via local `uniq()`/`used{}` maps when they need uniqueness, e.g. `schPortList`'s `uq()` at 2075).

`VHDL_RESERVED` (line 1026): a single `Set` built from a space-separated string of ~90 VHDL-93 reserved words (`abs access after alias all and architecture array assert attribute begin block body buffer bus case component configuration constant disconnect downto else elsif end entity exit file for function generate generic group guarded if impure in inertial inout is label library linkage literal loop map mod nand new next nor not null of on open or others out package port postponed procedure process pure range record register reject rem report return rol ror select severity shared signal sla sll sra srl subtype then to transport type unaffected units until use variable wait when while with xnor xor`).

`dlName(base, ext, fallback)` (1033-1045): NOT an identifier sanitizer — a **download filename** generator. Produces `YYYYMMDDHHMMSS` + (letters/digits-only stem of `base`, or `fallback` if `base` sanitizes to empty, e.g. an all-Thai name) + `ext`, with a colliding-timestamp counter suffix (so double-clicking Export never produces a browser `" (1)"` filename). Used for every file download: `.schproj.json` (project save), `.vhd`/`.vhd` bundle (VHDL export), `.sccomp.json` (custom component export).

---

## 7. Bus / width representation

There is **no dedicated "bus" object type** — a bus is simply a wire/net whose driving port has `width > 1`. Width is a property of a **port** (from the `TYPES[...].ports()` definition, or from `IN`/`OUT`/`CONST` `params.width`), never stored redundantly and authoritatively on the wire itself.

Key functions:

- `getPort(c, pid).width` — the declared bit width of a specific port on a specific component (defaults to `1` if the port definition omits `width`).
- `wireWidth(w, sch)` (2018-2035) — walks from a wire strictly to its ultimate driving port through any chain of `JUNCTION`s, and returns that port's `width`. **This is the single source of truth used everywhere for "how wide is this wire drawn / generated".**
- `netPortWidth(sch, w0)` (2036-2054) — fallback for a net that has **no driver yet** (e.g. a bus being assembled bit-by-bit via Bus Taps before the first tap is placed): scans every wire in the net (`netWires`) and takes the max `width` among all real (non-JUNCTION, non-BUSTAP) ports touching it.
- `cmpIsBus(p)` (1164) — `width >= 8` on a COMP/COMPM instance switches its pin style from one-pin-per-bit (`a0..an`) to one bus pin (`a(n-1:0)`); this is purely a drawing/pin-count decision, derived from `params.width`, never a separate flag.
- `BUSTAP.params.nbit` — width of the slice a given tap reads/writes; `BUSTAP` ports' `d` side always reports `width:2` as a "this is a bus pin" drawing marker ONLY (excluded from `netPortWidth`'s max-width scan, 2048).

How width flows visually/generatively:
1. A component's `ports()` function computes each port's `width` from `params` (e.g. gate `width` param applies to every pin; `IN`/`OUT`/`CONST` use `params.width` directly for their single port).
2. Every wire touching that port is, by definition, that many bits wide — computed on demand via `wireWidth()`, never cached (comment at 2015-2017: "Never cached — always derived, so it can never go stale").
3. `JUNCTION`s are 100% width-transparent — `wireWidth` recurses through them without any width field of their own.
4. `BUSTAP` is where a net's width can locally CHANGE: the `d` side matches the bus's width, the `y` side is only `nbit` bits (a slice).
5. VHDL codegen (`generateSchVhdl`) uses this same walked width (`p.width||1`, e.g. line 6054's `c._netW[p.id] = p.width||1`) to decide `std_logic` (`width===1`) vs `std_logic_vector(width-1 downto 0)` (`width>1`) for every declared signal/port — see the wizard preview code building the same `std_logic_vector(${w-1} downto 0)` string at 7546/7551.

For a Python schema: model width as a derived/computed property (a function of the graph, resolved by walking to the driving port), not a stored attribute of a wire or net object, to stay bit-for-bit consistent with this app's own generator.
