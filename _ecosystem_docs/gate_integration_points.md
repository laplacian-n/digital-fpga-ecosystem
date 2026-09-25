# Gate-level editor — MCP bridge integration points

Target file: `schematic&bus2vhdl.html` (~8226 lines).
Reference pattern: `topdown/topdown-schematic.html` (button `#bBridge`, `topdown_mcp.py`, port 8765).
Goal: add an equivalent "Sync ⟳" pull from `http://127.0.0.1:8766/latest.json` for a new `schematic_mcp.py`.

All line numbers below are current as of this analysis; re-check them before editing since the
file is large and actively maintained.

---

## 1. THE LOADER

**Function:** `deserialize(json)` — `schematic&bus2vhdl.html:6874-6996`

**Signature / accepted input:** takes a **JSON string**, not a parsed object — the very first line
is `const o = JSON.parse(json);` (line 6876). Any bridge code must call it as
`deserialize(await r.text())`, or `deserialize(JSON.stringify(obj))` if it already has an object.
Do **not** call it with the result of `r.json()` directly.

**Shape it accepts — both of these work, same function, no separate path:**

1. **Full envelope** (what `serialize()` itself writes, `schematic&bus2vhdl.html:6845-6866`):
   ```json
   { "version": 2, "workspace": { "projects": {...}, "activeId": "prj1" },
     "project": {...}, "activeId": "sch1", "openTabs": ["sch1"] }
   ```
   Detected by `o.workspace && o.workspace.projects && Object.keys(...).length` (line 6883). Each
   project in the map is recursively fed back through `deserialize` as a synthetic version-1
   payload (line 6889) — there is only one repair code path.

2. **Single project** (version 1, or no `version` key at all — `version` is never actually
   checked by the function):
   ```json
   { "project": { ... }, "activeId": "sch1", "openTabs": ["sch1"] }
   ```
   This is the shape to use for the MCP bridge — smallest, and `activeId`/`openTabs` are optional
   (line 6983-6985 default them to the first schematic).

   `o.project` is **required** — `if(!o.project || typeof o.project !== "object") throw new Error("Invalid file")` (line 6903). There is no "bare sheet" shape; a lone `Sheet` object must be wrapped as `{"project":{"schematics":{"<id>":<Sheet>}}}`.

**Minimal valid payload** — one sheet, `IN a` → `NOT` → `OUT y`:

```json
{
  "project": {
    "id": "prj_demo",
    "name": "demo",
    "topId": "sch_top",
    "customs": {},
    "schematics": {
      "sch_top": {
        "id": "sch_top",
        "name": "top",
        "components": [
          { "id": "c1", "type": "IN",  "x": 40,  "y": 40, "params": { "name": "a", "width": 1 } },
          { "id": "c2", "type": "NOT", "x": 160, "y": 40, "params": { "inputs": 1, "width": 1 } },
          { "id": "c3", "type": "OUT", "x": 280, "y": 40, "params": { "name": "y", "width": 1 } }
        ],
        "wires": [
          { "id": "w1", "from": { "cid": "c1", "pid": "o" },  "to": { "cid": "c2", "pid": "i0" } },
          { "id": "w2", "from": { "cid": "c2", "pid": "o" },  "to": { "cid": "c3", "pid": "i" } }
        ]
      }
    }
  }
}
```

**Exact type strings and port ids, cross-checked against the TYPES catalog and `gatePortsAndSize`:**

- `TYPES.IN` (`schematic&bus2vhdl.html:1288-1303`): `type:"IN"`, `defaultParams:{name:"in",width:1}`,
  `ports: p => [{id:"o", dir:"out", ...}]` — **single output port, id `"o"`**.
- `TYPES.OUT` (line 1304-1319): `type:"OUT"`, `defaultParams:{name:"out",width:1}`,
  `ports: p => [{id:"i", dir:"in", ...}]` — **single input port, id `"i"`**.
- `TYPES.NOT` (line 1387): `gateDef("not","NOT","not")` → shared `gatePortsAndSize()`
  (line 1096-1111). For a NOT gate `defaultParams:{inputs:1,width:1}` (line 1209), so `n=1`:
  ```js
  for(let i=0;i<n;i++) ins.push({id:"i"+i, dir:"in", ...});   // i0
  const out = {id:"o", dir:"out", ...};                        // o
  ```
  **Input port id `"i0"`, output port id `"o"`.** (All AND/OR/NAND/NOR/XOR/XNOR/NOT gates share
  this scheme: inputs are `i0`, `i1`, …, output is always `o`.)
- Component→type-def lookup is `typeDef(c)` → `TYPES[c.type]` (line 1695-1707), so `c.type` must be
  exactly one of the catalog keys (`"IN"`, `"OUT"`, `"NOT"`, `"AND"`, `"VCC"`, `"GND"`, `"CONST"`,
  `"JUNCTION"`, …) — there is no case-insensitivity or alias handled here except the legacy
  `TAP`→`BUSTAP` migration in `deserialize` (line 6928).
- `getPorts(c)` / `getPort(c,pid)` at `schematic&bus2vhdl.html:1708-1710` are the only accessors
  used elsewhere (rendering, wire routing, VHDL gen) — they always go back through `typeDef(c)`,
  so params must be enough for that type's `ports(p)` function to run without throwing (e.g. NOT
  needs `params.inputs` to compute `n`, though it also works if `inputs` is missing since
  `clamp(p.inputs||2,1,8)` defaults to 2 — **but that would make it a 2-input gate, not a true NOT**,
  so always pass `inputs:1` explicitly for NOT).

**Component object shape actually required:** `{id, type, x, y, params}` — `label` is optional.
`x`/`y` must be numbers; nothing defaults them, and downstream position math
(`portPos`, `schematic&bus2vhdl.html:3129-3134`: `c.x + o.x`) will silently produce `NaN` positions
if they're missing, without throwing.

---

## 2. EXISTING BRIDGE — does one already exist in this file?

**No.** Grepping `schematic&bus2vhdl.html` for `fetch(`, `127.0.0.1`, and `Sync` finds nothing
resembling a bridge — the only hits are unrelated identifiers (`portSync`, a junction-remap
variable at lines 2886/2894). There is no `fetch()` call, no hardcoded localhost URL, and no
"Sync" button anywhere in the file today. This confirms the sibling `topdown-schematic.html`
bridge (button `#bBridge`, handler at `topdown/topdown-schematic.html:2479-2502`, using
`http://127.0.0.1:8765/latest.json`) has no counterpart here yet — it needs to be added from
scratch, mirroring that pattern but adapted to this file's own idioms (see §3).

---

## 3. HOW TO ADD "Sync ⟳"

This file does **not** use topdown's raw `document.getElementById('bBridge').onclick = ...`
style for toolbar buttons (that pattern appears only 3 times in the whole file, for hidden file
inputs). Instead, essentially every toolbar/menu action here is wired through a single delegated
`data-act` dispatcher. The smallest, most consistent edit adds one button with `data-act="sync-bridge"`
and one `case` in the existing switch — no new event listener needed.

### (a) HTML — button markup and insertion point

Existing toolbar buttons live in the `<header class="topbar">` block. The relevant neighboring
markup (`schematic&bus2vhdl.html:329-334`):

```html
    <div class="grow"></div>
    <span style="font-size:11px;color:var(--muted)">Project:</span>
    <input class="proj-name" id="projectName" value="my_project" spellcheck="false">
    <button class="btn btn-ghost" data-act="open-manual" title="เปิดคู่มือการใช้งาน">📘 คู่มือ</button>
    <button class="btn btn-ghost" data-act="synth" title="Run synthesis check (F7)">🔍 Check</button>
    <button class="btn btn-primary" data-act="gen-vhdl">⚙ Generate VHDL</button>
  </header>
```

Insert a new ghost button right after the `#projectName` input and before the `open-manual`
button (line 332), matching the existing `.btn.btn-ghost` style:

```html
    <button class="btn btn-ghost" data-act="sync-bridge" title="Load design from local MCP bridge (127.0.0.1:8766)">Sync ⟳</button>
```

(Alternatively it could go in the File `<div class="dd">` dropdown, e.g. right after
`data-act="save-as-project"` at line 286 — either location wires up identically since both feed
the same delegated dispatcher. The toolbar button matches topdown's visible always-on placement
more closely.)

### (b) Action dispatch — where `data-act` is wired

The single delegated click handler is at `schematic&bus2vhdl.html:8039-8158`:

```js
document.addEventListener("click",ev=>{
  const a = ev.target.closest("[data-act]");
  if(!a) return;
  const act = a.dataset.act;
  switch(act){
    case "new-project": newProject(); break;
    ...
    case "split-project": openSplitDialog(); break;
  }
});
```

Add a new case just before the closing `}` of the switch, i.e. right after
`case "split-project": openSplitDialog(); break;` (line 8157):

```js
    case "sync-bridge": syncFromBridge(); break;
```

Then define `syncFromBridge()` as a normal top-level function near the other file/project
functions (e.g. right after `openProjectFromFile` at line 7024), mirroring topdown's handler but
using `fetch` + `deserialize` directly (no `prompt()`, remembers the URL, non-blocking toast):

```js
/* local MCP bridge sync — mirrors topdown-schematic.html's #bBridge, port 8766 */
async function syncFromBridge(){
  const BRIDGE_KEY = "schstudio.bridgeUrl";
  const last = (()=>{ try{ return localStorage.getItem(BRIDGE_KEY); }catch(_){ return null; } })();
  const url = last || "http://127.0.0.1:8766/latest.json";
  try{
    const r = await fetch(url, {cache:"no-store"});
    if(!r.ok) throw new Error("server said " + r.status + " " + r.statusText);
    const text = await r.text();
    deserialize(text);
    try{ localStorage.setItem(BRIDGE_KEY, url); }catch(_){}
    toast("Synced จาก MCP bridge แล้ว", "ok");
  }catch(e){
    toast("Sync ไม่สำเร็จ: " + e.message, "err", 3200);
    console.warn("bridge:", e);
  }
}
```

### (c) Loader function to call

`deserialize(json)` — `schematic&bus2vhdl.html:6874`, string-in, void return, throws on hard
failure (only when `o.project` is missing/not an object — everything else is repaired
tolerantly, see §4). Call as `deserialize(text)` where `text = await r.text()` (do **not**
pre-parse with `r.json()` since `deserialize` parses internally).

`toast(msg, kind, ms)` — `schematic&bus2vhdl.html:1072`, `kind` is one of
`"info"|"ok"|"warn"|"err"`.

---

## 4. VALIDATION EXPECTATIONS — what the editor tolerates vs. rejects

**Hard rejects (throws, caught by caller as "Invalid file"/error message):**
- `o.project` missing or not an object (line 6903) — the single hard requirement.
- A schematic entry that is not an object at all (line 6917: `if(!s || typeof s !== "object") throw`).

**Silently repaired / tolerant (the MCP does not need to guarantee these, but should not rely on
them producing exactly what was intended):**
- Empty/missing `schematics` map → replaced wholesale with a fresh blank project's schematics
  (line 6905-6909) — **if you send an empty `schematics: {}`, your design is discarded** and a
  blank "top" sheet appears instead. Always include at least one non-empty sheet.
- Missing `customs` → defaults to `{}` (line 6910).
- Missing/invalid `topId` → defaults to the first schematic key (line 6911-6913).
- Per-sheet: missing/non-array `components`/`wires` → coerced to `[]` (line 6918-6919).
- Wires missing `from`/`to`/`from.cid`/`to.cid` → **silently dropped** (line 6920 filter) — no
  error, the wire just doesn't appear. This is the main footgun for a hand-built payload: a typo
  in `from`/`to` shape produces a design with disconnected components and no error message.
- Missing sheet `id`/`name` → filled from the schematics-map key (line 6921).
- Legacy dead component types (`SPLIT`,`MERGE`,`BUSMERGE`,`BUSRIP`,`SHIFT`) and their wires are
  stripped (line 6926-6936); old `TAP` type is renamed to `BUSTAP` (line 6928).
- Duplicate schematic names are auto-suffixed (`_2`, `_3`, …) to keep VHDL entity names unique
  (line 6969-6975).
- `activeId` invalid/missing → first schematic; `openTabs` invalid/missing → `[activeId]`
  (line 6983-6985).
- Component/wire `id` collisions with the running session are avoided by `reseedUid` (line 6953,
  6988) scanning trailing digits of every id — but ids must still be **distinct from each other
  inside the payload itself**; nothing in `deserialize` deduplicates colliding ids within the
  incoming file.

**NOT validated — will not throw, but produces a broken or silently-wrong circuit:**
- **Wire `pid` values that don't exist on the referenced component's port list.** `fixSheet` only
  checks `from.cid`/`to.cid` are non-null (line 6920); it never calls `getPort`. Downstream,
  `getPort`/`portPos` return `undefined`/`null` for a bad pid (defensive checks at
  `schematic&bus2vhdl.html:1710`, `3129-3134`, `3398`) so nothing crashes — but the wire silently
  fails to route/render or is excluded from VHDL generation. **The MCP's own validator must
  guarantee every wire endpoint's `pid` is a real port id for that component's `type` + `params`**
  (cross-check against the TYPES catalog / `gatePortsAndSize`), since the app will not catch this.
- **Missing/non-numeric `x`/`y`** on a component — not defaulted; produces `NaN` in position math
  (line 3133) with no thrown error, just a mis-rendered/invisible component.
- **`params` not matching what a type's `ports(p)`/`size(p)` expects** (e.g. a `NOT` gate given
  `inputs:3`) — no validation against `defaultParams`/`paramSchema`; it will just render as a
  3-input gate instead of a true NOT, no error surfaced.
- **`type` string not in the TYPES catalog** and not a `CUSTOM:`/`SCH:` prefix referencing an
  existing entry — `typeDef(c)` returns `undefined` (line 1706), and callers that don't guard for
  that (unlike `getPorts`, line 1708, which does) may throw a runtime `TypeError` deep in
  rendering. Best guaranteed by the MCP: only ever emit catalog type strings.

**Practical guidance for `schematic_mcp.py`'s own validator:** guarantee (1) `schematics` is
non-empty, (2) every `type` is a real TYPES key, (3) every component has numeric `x`/`y` and a
`params` object with at least the keys that type's `defaultParams` defines, (4) every wire's
`from.pid`/`to.pid` is actually present in `getPorts()`-equivalent output for that component
(mirror `gatePortsAndSize`/IN/OUT tables above), and (5) all `id` values (components + wires +
sheet keys) are unique within the payload. Everything else the editor will repair or tolerate.
