# Gate-level editor — wire-rendering & routing internals

Target file: `schematic&bus2vhdl.html` (8245 lines, plain DOM + inline SVG, vanilla JS, `"use strict"` at
`schematic&bus2vhdl.html:981`). Read-only mapping for adding a custom orthogonal `autoRouteSheet(sch)`
router without breaking existing net/junction/bus logic. All line numbers verified against the file as
currently on disk; re-check before editing since it is actively maintained.

Companion docs already in this folder: `11_wire_router.md` (algorithm design, Thai) and
`gate_integration_points.md` (MCP bridge — different feature, same file).

---

## 0. Globals / coordinate conventions

- `GRID = 11` — `schematic&bus2vhdl.html:998`. Snap-to-grid step in px. Component sizes and port offsets
  are always chosen as multiples of `GRID` (see `gatePortsAndSize`, line 1097-1111) so a snapped
  component's pins land exactly on grid lines.
- `snap = v => Math.round(v/GRID)*GRID` — `schematic&bus2vhdl.html:1060`.
- `clamp = (v,a,b)=>Math.max(a,Math.min(b,v))` — line 1059.
- Canvas coordinates: everything (`c.x`, `c.y`, port positions, `w.pts`, `w.autoPts`, `w.mx`, `w.my`) is
  in one flat **absolute canvas coordinate space** in px, pre-pan/zoom. The view transform
  (`translate(state.view.x,state.view.y) scale(state.view.k)`) is applied once to the whole `<g>` root
  in `render()` (line 4501) — it never touches stored geometry. Y increases downward (SVG convention).
  `c.x,c.y` is a component's top-left corner (pre-rotation, pre-mirror) — see §1 for how rotation/mirror
  are layered on top for both ports and the render transform.
- `comp(cid, sch=activeSch())` — line 2208: `sch.components.find(c=>c.id===cid)`.
- `activeSch()` — line 2207: `state.project.schematics[state.activeId]`.

---

## 1. Wire endpoint geometry — ports, bboxes, rotation/mirror

### `getPorts`/`getPort`/`getSize` — `schematic&bus2vhdl.html:1708-1711`

```js
function typeDef(c){ ... return TYPES[c.type]; }         // 1696-1708 (handles CUSTOM:/SCH: too)
function getPorts(c){ const td = typeDef(c); return td ? td.ports(c.params||{}) : []; }   // 1709
function getSize(c){ const td = typeDef(c); return td ? td.size(c.params||{}) : {w:40,h:40}; } // 1710
function getPort(c,pid){ return getPorts(c).find(p=>p.id===pid); }                        // 1711
```

`getSize(c)` returns the **unrotated, unmirrored** local box `{w,h}` (e.g. `JUNCTION` is always
`{w:12,h:12}`, line 1372). Every `ports(p)` function returns `{id, dir:'in'|'out', dx, dy, width}`
where `dx,dy` are local offsets in that same unrotated box (e.g. junction port `j` is at `dx:6,dy:6`,
its center — line 1376).

### `orientLocal(c,dx,dy)` — `schematic&bus2vhdl.html:3116-3129`

Maps a 0°-local offset to the oriented local offset, applying **mirror then rotate about the box
center** — the same transform order the render group uses (see §1 rotation note below):

```js
function orientLocal(c, dx, dy){
  const sz = getSize(c), w = sz.w, h = sz.h;
  let x = dx, y = dy;
  if(c.mirror) x = w - x;                       // flip left-right about the centre
  const cx = w/2, cy = h/2, rx = x - cx, ry = y - cy;
  let nx, ny;
  switch(((c.rot||0)%360+360)%360){
    case 90:  nx = -ry; ny =  rx; break;        // SVG rotate() is clockwise (y-down)
    case 180: nx = -rx; ny = -ry; break;
    case 270: nx =  ry; ny = -rx; break;
    default:  nx =  rx; ny =  ry; break;
  }
  return { x: cx + nx, y: cy + ny };
}
```

### `portPos(c, pid)` — `schematic&bus2vhdl.html:3130-3135`

```js
function portPos(c, pid){
  const p = getPort(c, pid);
  if(!p) return null;                 // defensive: bad pid, deleted sub-sheet port, etc.
  const o = orientLocal(c, p.dx, p.dy);
  return { x: c.x + o.x, y: c.y + o.y };
}
```

This is **the** function to call for "give me the absolute (x,y) of component `c`'s port `pid`". It
returns `null` (not a throw) for a bad/missing port — every caller in the file guards for that; the
router must too.

### Component obbox for rendering (how the render group is actually transformed)

`schematic&bus2vhdl.html:4720-4728` (inside `render()`):

```js
const sz = td.size(c.params||{});
const rot = ((c.rot||0)%360+360)%360;
let ntf = `translate(${c.x},${c.y})`;
if(rot)      ntf += ` rotate(${rot} ${sz.w/2} ${sz.h/2})`;   // about the LOCAL box centre
if(c.mirror) ntf += ` translate(${sz.w} 0) scale(-1 1)`;
```

So a component's true screen footprint is a `sz.w × sz.h` box rotated **about its own center**
`(c.x+sz.w/2, c.y+sz.h/2)`. At rot 90/270 the box's on-screen extent swaps width and height, but stays
centered on that same point. Mirror is a horizontal flip and does not change footprint extent.

### Copy-paste axis-aligned bbox for obstacle tests

The app's own `symbolBoxes(sch)` (line 4095-4100, used by `avoidBodies`) does **NOT** swap w/h at
rot 90/270 — it always returns `{x1:c.x, y1:c.y, x2:c.x+sz.w, y2:c.y+sz.h}`. That is adequate for the
app's own straight/z/s auto-router (most placed gates are never rotated 90/270 in practice), but it is
**not a true axis-aligned bbox** for a rotated part. For a router that must guarantee "never crosses a
component," use the rotation-correct version instead:

```js
function compBBox(c){
  const sz = getSize(c);                                  // {w,h}, local/unrotated
  const rot = ((c.rot||0)%360+360)%360;
  const swapped = (rot===90 || rot===270);
  const w = swapped ? sz.h : sz.w, h = swapped ? sz.w : sz.h;
  const cx = c.x + sz.w/2, cy = c.y + sz.h/2;              // rotation pivot (unchanged by rotation)
  return { x: cx - w/2, y: cy - h/2, w, h };                // top-left + size, canvas coords
}
```

`JUNCTION` components should be excluded from the obstacle set — they are wire-attached points, not
bodies (this mirrors `symbolBoxes`'s own `c.type!=="JUNCTION"` filter, line 4096). The existing
`BODY_PAD = GRID/2` (line 4105) is the margin the app itself inflates obstacle boxes by before testing
a wire segment against them (`segCutsBox`, line 4106-4114) — reuse that constant for the router's own
margin so gaps look consistent with hand-drawn wires.

---

## 2. Wire path points + rendering — `pts` vs `autoPts`, exact format

### Field priority — `wireRoute(w, p1, p2, opts)` — `schematic&bus2vhdl.html:3450-3462`

```js
const way = (w && w.pts && w.pts.length) ? w.pts
          : (w && w.autoPts && w.autoPts.length) ? w.autoPts : null;
if(way){
  const raw = [{x:x1,y:y1}, ...way.map(p=>({x:Math.round(p.x),y:Math.round(p.y)})), {x:x2,y:y2}];
  const pts = orthoPolyline(raw, opts?opts.fromH!==false:true, opts?opts.toH!==false:true);
  return {kind:"poly", x1,y1,x2,y2, pts, d:"M"+pts.map(p=>`${p.x},${p.y}`).join("L")};
}
```

- **`w.pts` wins over `w.autoPts`.** Both are **interior waypoints only** — the two port endpoints
  (`p1`,`p2`, i.e. `portPos(A,w.from.pid)` / `portPos(B,w.to.pid)`) are **auto-prepended/appended** by
  `wireRoute` itself (the `[{x:x1,y:y1}, ...way, {x:x2,y:y2}]` line). **Do not include the endpoints in
  the array you assign** — only the bend points between them.
- Both are **absolute canvas coordinates**, the same space as `c.x/c.y` and `portPos()` (confirmed by
  the comment at line 2939: `/* pts / autoPts / mx / my are ABSOLUTE canvas coordinates, not offsets
  from the pins.`, and by `moveSelection`'s `mv(w.pts)` translation at 2944-2945).
- **Semantic difference (not a rendering difference):** `w.pts` = "hand-routed, the user's call, never
  touched" (explicit comment at line 3455-3456 and enforced at line 4141 inside `avoidBodies`:
  `if(w.pts && w.pts.length) continue;`). `w.autoPts` = "a detour the auto-router computed to dodge a
  body; owned by the healer, recomputed/deleted freely" (line 4134, 4142, 4196, 4200). **A router that
  wants its output to survive the app's own auto-layout passes (including a forced `↻ relayout`, see
  §3) must write to `w.pts`, not `w.autoPts`.**
- `orthoPolyline(raw, fromH, toH)` (line 3375-3396) then walks the point list and only inserts an
  elbow when two consecutive points are diagonal to each other (`|dx|>0.5 && |dy|>0.5`); it also drops
  redundant collinear midpoints. **If every consecutive pair in your `[endpoint, ...pts, endpoint]`
  array already shares an x or a y (i.e. the list is already a valid Manhattan polyline), `orthoPolyline`
  passes it through unchanged** (module tidy-up of duplicate/collinear points). `fromH`/`toH` only
  matter if you leave a diagonal segment for it to break — a router producing fully-orthogonal points
  should never rely on this fallback.

### Rendering — `render()` → `wireRoute()` → `<path d="...">` — `schematic&bus2vhdl.html:4487-4568`

`render()` clears and rebuilds the whole SVG every call. For each wire it does:

```js
const p1 = portPos(a, w.from.pid), p2 = portPos(b, w.to.pid);
const r  = wireRoute(w, p1, p2, wireOpts(w));      // wireOpts(w,sch) → {fromH, toH} exit-side hints
...
const D = fastRender ? r.d : hoppedPathD(r, allV, w.id);   // hop-over-crossing only in "hop" theme, non-fast
const path = el("path", {d: D, class:"wire"+(isBus?" bus":"")+(isSel?" selected":""), stroke: ...});
```

So there is **no separate `<polyline>`** — every wire becomes one `<path>` whose `d` attribute is an
`M x,y L x,y L x,y ...` string built from the resolved point list (`r.pts` for `kind:"poly"`, i.e. when
`w.pts`/`w.autoPts` is present; otherwise a synthesized `h`/`v`/`l`/`lh`/`z`/`s` shape — see
`wireRoute`, line 3450-3521, and `routeParts`, line 3551-3579, for those synthetic shapes). A second,
invisible, wider `<path>` (`class="wire-hit"`, line 4565) is added for easier clicking/dragging — it
uses the same `r.d` (or the un-hopped version) and needs no special handling from a router.

`drawnPoints(sch, w)` (line 1810-1819) is a convenience wrapper used elsewhere (e.g. `healJunctions`)
that returns the **full** corner list including both endpoints — `routePoints(wireRoute(w, p1, p2,
wireOpts(w, sch)))`. Useful for inspecting a wire's current drawn shape, not for writing to it.

### Minimal example — render wire `w` as `source → (x1,y) → (x2,y) → sink`

```js
delete w.mx; delete w.my; delete w.zjog; delete w.autoPts;   // clear any stale auto/manual route state
w.pts = [ {x:x1, y:y1}, {x:x2, y:y2} ];                        // interior waypoints ONLY, absolute coords
render();                                                       // (or renderAll() — see §3)
```
`y1`/`y2` above should be picked to actually make each leg orthogonal against the real port
positions — e.g. for a "one jog" S/Z-style route from `p1=portPos(A,...)` to `p2=portPos(B,...)`, a
common shape is `w.pts = [{x:midX, y:p1.y}, {x:midX, y:p2.y}]` (leaves `p1` horizontally, drops to
`p2`'s row, arrives horizontally) — every consecutive pair (`p1`→pt0, pt0→pt1, pt1→`p2`) shares an x or
a y, so `orthoPolyline` will not need to insert anything extra.

This exact "clear-then-set-`w.pts`" sequence is precisely what the app's own manual wire-drag code does
(`schematic&bus2vhdl.html:5017-5018`, `5002-5003`, and the inspector's "reset route" button at
`5509-5510`: `delete w.mx; delete w.my; delete w.pts; delete w.zjog; delete w.autoPts;`) — the router
should mirror that reset pattern before writing its own points, so it can re-run idempotently on a
sheet that already has manual or previously-auto-routed wires.

---

## 3. Existing auto-router / relayout

### `data-act="relayout"` (button `#btnRelayout`, `↻`) — `schematic&bus2vhdl.html:368` (button), `8103-8109` (handler)

```js
case "relayout": {
  const sch = activeSch(); if(!sch) return;
  healLayout(sch, null, true);       // one-shot, on request, even when locked
  snapshot(); renderAll();
  toast("จัดสายใหม่ทั้งแผ่นแล้ว (กด Ctrl+Z เพื่อย้อนกลับ)","ok",3000);
  break;
}
```

### `healLayout(sch, scope, force)` — `schematic&bus2vhdl.html:4226-4236` — the ONE canonical layout pass

```js
function healLayout(sch, scope, force){
  sch = sch || activeSch();
  if(!force && layoutLocked(sch)){ healJunctions(sch); return; }   // locked + not forced → structural heal ONLY
  sch.wires.forEach(w=>{ if(!scope || scope.has(w.id)) delete w.autoPts; });
  retapBranches(sch, scope);        // 4047 — re-pick which dot a branch taps off of
  alignJunctionBranch(sch, scope);  // 3785 — slide a 3-leg junction so the odd branch exits perpendicular
  reflowJunctions(sch, scope);      // 3854 — slide a fan-out junction to where its branches actually diverge
  separateWireOverlaps(sch, scope); // 3913 — nudge DIFFERENT-net z/s legs off each other's tracks
  healJunctions(sch);               // 1905 — structural: prune/merge orphan & pass-through junctions
  avoidBodies(sch, scope);          // 4135 — bend any wire that cuts through a symbol body
}
```

Called with `scope=null, force=true` by the ↻ button (all wires, unconditionally, even on a locked
sheet — comment at line 4214: *"The one-shot '↻ จัดสายใหม่' button routes around the lock when the user
actually asks for a tidy-up."*). **This means the router's own output must survive being re-run
through this whole pipeline, not just render:**

- `delete w.autoPts` (line 4229) — always wipes `autoPts`. **A router writing to `autoPts` will be
  silently discarded by ↻, even offline of lock.**
- `retapBranches`/`alignJunctionBranch`/`reflowJunctions`/`separateWireOverlaps` **move `JUNCTION`
  components** (`j.x`/`j.y`) **unless `j.params.fixed` is truthy** (checked explicitly in all four:
  lines 4058, 3789, 3861, 3943 — *"user parked this dot — hands off"*). A router that repositions
  junctions must set `j.params.fixed = true` on every junction it places, or ↻ will slide them again.
- `avoidBodies` (§2) skips any wire with `w.pts.length` truthy (line 4141) — **this is the one pass
  that respects the router's output** as long as it writes `w.pts`, not `autoPts`.
- `healJunctions` (§4) is **always** run, even in the locked-and-not-forced branch — it structurally
  prunes/merges junctions regardless of `fixed`/lock. The router must keep its junction topology
  consistent with `healJunctions`'s rules (§4) so it never gets unexpectedly collapsed.

### Other net/junction helpers referenced in the task

- `netWires(sch, w0)` — `schematic&bus2vhdl.html:3746-3760`: BFS through `JUNCTION` nodes from wire
  `w0`, returns a `Set` of wire ids on the same net (undirected — used for "what set of wires is
  electrically one signal").
- `netWiresFrom(sch, cid, pid)` — line 3761-3779: **directed** walk from a driving `{cid,pid}` forward
  through `JUNCTION`s, returns an **array of wire objects** (used to enumerate all sink wires of a net
  given its driver — this is the natural way for a router to enumerate `source → [sink...]` fan-out).
- `orientNetFrom(sch, rootCid)` — line 4403-4423: walks a net outward from `rootCid` and flips any
  wire pointing the wrong way (`w.from`/`w.to` swapped, `w.pts` reversed) so every wire's `from` is
  upstream of its `to`. Only meaningful for a driver-less net (comment: *"Only ever called on a net
  that had NO driver, so no real source can be reversed."*) — not something the router calls itself,
  but explains why `w.from`/`w.to` direction is reliable after load (see `netDriverPort` below).
- `netDriverPort(sch, w, seen)` — line 4352-4361: walks `w.from` back through `JUNCTION`s to the real
  driving port `{cid,pid}` (or a dangling junction if undriven). This is the router's way to identify,
  for any wire, which net (by driver identity) it belongs to.
- `weldTouchingEnds(sch)` — line 1741-1799: a **live-edit-only** helper (called from finishing a
  hand-drawn wire / drag-end, e.g. line 3350, 5074) that merges a dangling wire end onto a
  coincident junction or wire it happens to land on. **Not called during load or by `healLayout`** —
  the router does not need to call it, and should not rely on it firing automatically.

### Re-render + undo entry points

- **`render()`** — line 4487: rebuilds the SVG for the active sheet only (clears `canvas`, redraws grid,
  components, wires, selection, lock-button state). This is enough after any pure wire/junction
  geometry change.
- **`renderAll()`** — line 8197-8203: `renderSchTabs(); renderProjectTree(); renderPalette(); render();
  renderInspector();` — also refreshes the sheet-tab bar / project tree / inspector panel. Every
  toolbar action (`relayout`, `lock-layout`, load, etc.) calls `renderAll()`, not bare `render()`, so
  the router's toolbar action should too.
- **`snapshot()`** — line 2213-2221: pushes `JSON.stringify({p:state.project, a:state.activeId,
  t:state.openTabs, pid:state.activeProjectId})` onto the undo stack (cap 80 entries). It reads
  `state.project` directly with no arguments — call it **after** mutating the sheet's components/wires,
  in the same order every existing handler uses: `mutate(); snapshot(); renderAll();`.

---

## 4. Junctions & fan-out

### Representation

A net with fan-out is `1` driving port + a tree of `JUNCTION` components (`type:"JUNCTION"`,
`defaultParams:{}`, single port id `"j"` at local `dx:6,dy:6` of its `{w:12,h:12}` box — line
1369-1379) connected by ordinary wire objects (`{id, from:{cid,pid}, to:{cid,pid}, name}`). A
junction's absolute position is `portPos(j,"j")`, i.e. `{x:j.x+6, y:j.y+6}` when unrotated (junctions
are never rotated/mirrored — `orientable()`, line 3138, explicitly excludes `type==="JUNCTION"`). To
place a junction so its dot sits at canvas point `P`: `j.x = P.x - 6; j.y = P.y - 6;`.

`j.params.axis` (`"h"` or `"v"`, stamped by `stampJunctionAxis`, line 1879-1904, and set explicitly by
`branchFromNet`/`retapBranches`/`alignJunctionBranch` as `{axis: at.seg}` wherever they mint a new
junction) records **which axis the junction's host wire runs along** — this decides whether attached
branch wires should exit the dot horizontally or vertically (`junctionExitH`, line 3409-3434). A router
placing a junction must set `params.axis` to the host trunk's direction ("h" for a junction sitting on
a horizontal run, "v" for vertical), or downstream rendering falls back to the ambiguous default
(`"h"`, i.e. exit vertical — see line 1902's comment).

`j.params.fixed = true` — set by the user (via `startWireBranch`'s userPicked path, line 4307) or a
router — means *"parked, hands off"*: `retapBranches`, `alignJunctionBranch`, `reflowJunctions`, and
`separateWireOverlaps` all skip a fixed junction (§3). **The router should set this on every junction
it places**, both to protect its own layout from a later ↻ relayout, and because it is the existing
convention for "this dot's position is intentional, not auto-derived."

`j.params.endpoint = true` marks a deliberate free (unconnected) wire end — irrelevant to a router that
should never leave a dangling wire.

### `normalizePortFanout(sch)` — `schematic&bus2vhdl.html:4373-4395`

Only relevant to **legacy files**: it finds a component output port driving 2+ parallel wires directly
(no junction), and rewrites the 2nd+ such wire as a branch off the first via `branchFromNet` (which
mints a `JUNCTION` + splits the host wire through it — line 4257-4313). Called during `deserialize`
(line 6963) before `reseedUid`, and once more ad hoc when the user manually ties nets (line 7891, 8229).
**A router never needs to call this** — by the time `autoRouteSheet` runs, the sheet it reads is already
in canonical junction form (one wire per port-to-port hop, dots at every branch point); the router's own
job is only to choose the *geometry* of the wires/junctions that already exist, not to restructure the
net topology (though it MAY add/reposition junctions to make a rectilinear fan-out tree — see below).

### May a router move/add/remove junctions?

- **Move**: yes — set `j.x/j.y` (+ `params.axis`, `params.fixed=true` as above). This is exactly what
  `alignJunctionBranch`/`reflowJunctions` already do for the app's own layout.
- **Add**: yes, to turn a rectilinear fan-out tree's branch points into visible dots — mirror
  `branchFromNet`'s pattern (line 4308-4311): create `{id:uid("c"), type:"JUNCTION", x, y, params:{axis,
  fixed:true}}`, push to `sch.components`, then either `splitWireThroughJunction(hostWire, j, sch)` (if
  tapping an existing wire — see that function, referenced at line 1793/4082/4310, splits one wire into
  two through `j`) or wire the new branches directly as `{id:uid("w"), from:{cid:j.id,pid:"j"},
  to:{cid:sinkCid,pid:sinkPid}}`.
- **Remove**: only if also removing/re-homing every wire attached to it — **never leave a junction with
  exactly 1 total attached wire and no `params.endpoint`**, and **never leave a junction with exactly 1
  incoming + 1 outgoing wire** — `healJunctions` (§ below) will unconditionally collapse both of those
  shapes on the very next call (which happens on every `render`-adjacent structural pass, and always
  runs even on a locked sheet).

### What must stay consistent — `healJunctions(sch)` — `schematic&bus2vhdl.html:1905-1993`

Invariant enforced on every call (runs unconditionally inside `healLayout`, even in the
locked+not-forced short-circuit, line 4228):

- **0 wires attached** → junction silently deleted (line 1917-1919).
- **Exactly 1 wire attached, no `params.endpoint`** → junction **and its one wire are deleted**
  (line 1923-1938) *unless* the wire's other end is a real (non-junction) component, in which case the
  junction is instead retro-flagged `params.endpoint=true` and kept as a dangling stub (line 1929-1935).
  ⇒ **a router must never leave a junction with just one attached wire mid-tree** (every non-leaf
  junction needs ≥2 outgoing branches, i.e. ≥3 total wires) unless it is a genuine single leftover stub.
- **Exactly 1 in + 1 out** (`ins.length===1 && outs.length===1`) → **pass-through**: the junction is
  removed and its two wires merged into one (`from` of the in-wire, `to` of the out-wire), preserving
  any `w.pts` through the junction's old point (line 1939-1956). ⇒ **never model a router "corner" as a
  1-in-1-out junction** — a plain bend belongs in `w.pts`, not as a junction; only use a `JUNCTION`
  where the net genuinely branches (a real driving port feeding ≥2 sink wires, i.e. total wires ≥3 at
  that node, ins=1 & outs≥2).
- **Coincident/near-coincident junctions of the same net** get merged (line 1957-1990) — a router
  should avoid placing two of its own junctions within 2px (or within `1.5*GRID` joined by a plain
  stub) of each other on the same net, since a merge here silently discards whichever one the healer
  drops.

---

## 5. Lock-layout — `data-act="lock-layout"` / `#btnLockLayout`

Button: `schematic&bus2vhdl.html:367`. Handler: `schematic&bus2vhdl.html:8095-8102`:

```js
case "lock-layout": {
  const sch = activeSch(); if(!sch) return;
  sch.locked = !sch.locked;
  snapshot(); renderAll();
  toast(sch.locked ? "🔒 ล็อกการจัดวางแล้ว — สายและจุดจะอยู่กับที่ ไม่มีการจัดใหม่อัตโนมัติ"
                   : "🔓 ปลดล็อกการจัดวาง — ระบบจะช่วยจัดสายให้อีกครั้ง", "ok", 3000);
  break;
}
```

**Flag**: `sch.locked` (boolean, per-sheet, part of the serialized project — persists across
save/load). Read via `layoutLocked(sch)` — `schematic&bus2vhdl.html:4216`: `!!((sch ||
activeSch()||{}).locked)`.

**What it prevents** — precisely the non-forced call to `healLayout` (§3): when `layoutLocked(sch)` is
true and `force` is not passed, `healLayout` skips `retapBranches`, `alignJunctionBranch`,
`reflowJunctions`, `separateWireOverlaps`, and `avoidBodies` entirely, running **only**
`healJunctions(sch)` (structural prune/merge — §4, cannot be disabled by lock). It also blocks
**interactive re-aiming of pins**: `rotateSelection`/`mirrorSelection` check `layoutLocked(sch)` and
bail with `lockedNudge()` (toast) instead of rotating/mirroring when locked (line 3143 and the mirror
equivalent), because re-aiming a symbol's pins would otherwise force a re-route.

**What it does NOT prevent**: the ↻ relayout button passes `force=true` explicitly to override lock
(§3) — so lock alone is not enough to protect a router's routing from the user later clicking ↻. It
also does not block direct component drag or wire drag by the user, or dispatched geometry writes.
`healJunctions`'s structural invariants (§4) always apply.

**Recommended usage for the router**: after computing and writing all `w.pts`/junction positions, set
`sch.locked = true` (same line the toolbar handler uses) so ordinary edits do not silently re-route the
sheet. This does not protect against ↻ relayout, but ↻ relayout is (a) named "one-shot, on request"
and (b) something the router itself could also just call safely — since `avoidBodies` (the pass
`↻`'s `healLayout(sch,null,true)` still runs) explicitly skips any wire with `w.pts.length`, and
junctions with `params.fixed=true` are skipped by the other four passes — a well-formed router output
survives a stray ↻ press intact as long as `w.pts` + `params.fixed` are set as described in §2-§4.

---

## 6. Integration hook recommendation

**Add** a new top-level function `autoRouteSheet(sch)`, placed right after `healLayout`/`avoidBodies`
(i.e. after line ~4236, before `scopeOf`) since it belongs in the same "layout pass" neighborhood and
can reuse `symbolBoxes`/`obstaclesFor`/`segCutsBox`/`routeParts`/`wireRoute` from that section.

**Toolbar**: add a button next to the existing `↻` relayout button (`schematic&bus2vhdl.html:368`),
e.g. `<button data-act="auto-route" id="btnAutoRoute" title="จัดเส้นแบบตั้งฉากอัตโนมัติ (ไม่ทับ
component, ไม่ทับกันเอง)">🧭</button>`, and one `case` in the delegated `data-act` switch right next to
`case "relayout"` (`schematic&bus2vhdl.html:8103-8109`):

```js
case "auto-route": {
  const sch = activeSch(); if(!sch) return;
  autoRouteSheet(sch);
  sch.locked = true;                 // protect the computed layout from later auto-heals
  snapshot(); renderAll();
  toast("จัดเส้นแบบตั้งฉากอัตโนมัติแล้ว (กด Ctrl+Z เพื่อย้อนกลับ)","ok",3000);
  break;
}
```

**Call sequence inside `autoRouteSheet(sch)`:**

1. **Read components/ports/bboxes**: iterate `sch.components`; for obstacles use `compBBox(c)` (§1,
   rotation-correct — do not reuse `symbolBoxes` verbatim if any component may be rotated 90/270) over
   every non-`JUNCTION` component; for terminals use `getPorts(c)` + `portPos(c, port.id)`.
2. **Enumerate wires + nets**: iterate `sch.wires`; group by `netDriverPort(sch, w)` (line 4352) to
   find each net's driver, then `netWiresFrom(sch, drv.cid, drv.pid)` (line 3761) to get that net's
   ordered sink-wire list (source → each sink). `netWires(sch, w)` (line 3746) gives the undirected
   wire-id `Set` for a net if that's more convenient for a first grouping pass.
3. **Write computed points**: for each wire, `delete w.mx; delete w.my; delete w.zjog; delete
   w.autoPts;` then `w.pts = [...]` — interior waypoints only, absolute canvas coords, every consecutive
   pair (including the endpoints `wireRoute` will prepend/append) axis-aligned (§2).
4. **Reposition/add junctions**: for every branch point in the computed rectilinear tree, set/create a
   `JUNCTION` at `{x: P.x-6, y: P.y-6}` with `params:{axis:"h"|"v", fixed:true}` (§4); never create a
   junction with total attached wires < 3, and split an existing host wire through a new tap junction
   with the same helper pattern as `branchFromNet`/`splitWireThroughJunction`.
5. **Re-render**: call `render()` (or `renderAll()` from the toolbar action, to also refresh tabs/
   inspector/palette).
6. **Snapshot undo**: call `snapshot()` after all mutation, before/with the render call — same ordering
   every existing handler uses (`mutate(); snapshot(); renderAll();`).
7. **Set lock**: `sch.locked = true` after routing, so `healLayout`'s non-forced auto-heal passes never
   run on this sheet again until the user explicitly unlocks it. (It will not survive a user-triggered
   ↻; see §5 for why that is fine as long as `w.pts`/`params.fixed` are set correctly.)

**Globals the router needs**: `state` (only to call `activeSch()`/read `state.project` indirectly via
`snapshot()` — the router itself should take `sch` as a parameter, not reach into `state` directly, to
stay reusable for a chosen non-active sheet), `GRID`, `snap`, `comp(cid,sch)`, and the helpers named
above (`getPorts`, `getPort`, `getSize`, `portPos`, `orientLocal` indirectly via `portPos`,
`netDriverPort`, `netWiresFrom`, `netWires`, `uid`, `splitWireThroughJunction`, `render`/`renderAll`,
`snapshot`). Do **not** call `healLayout`/`avoidBodies`/`retapBranches`/etc. from inside
`autoRouteSheet` — those are the existing auto-router being replaced for this pass; calling them after
writing `w.pts` would just re-validate/no-op (they skip `w.pts` wires) but calling them **before** could
alter the junction positions the router is about to read.
