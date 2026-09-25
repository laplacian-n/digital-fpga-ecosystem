# Schematic → VHDL Internals: `schematic&bus2vhdl.html`

Source file (read-only reference for this doc):
`C:\Users\dinuc\OneDrive\เอกสาร\digital\schematic&bus2vhdl.html` (~8226 lines, single-file HTML/JS app, Thai UI / English identifiers).

Target device declared in generated comments: Xilinx **Spartan-7 XC7S15**, toolchain **Vivado**.

This document is a from-source technical reference for two purposes:
1. Reproduce the schematic→VHDL algorithm on the Python side of the ecosystem hub.
2. Port the **ERC rule list in `runSynthesis`** (line 5710) into an AI-side validation layer that catches hallucinated/broken circuits before they reach VHDL/board.

All line numbers refer to the file above and were correct at the time of writing (do not assume stability across edits to the HTML file).

---

## 1. Net / connectivity model

### 1.1 Data shapes

A schematic (`sch`) is `{ id, name, components:[], wires:[] }`.

- `component` = `{ id, type, x, y, params, label }`. Special types used purely for wiring: `JUNCTION` (branch/dot, transparent), `IN`, `OUT`, `VCC`, `GND`, `CONST`, `BUSTAP`.
- `wire` = `{ id, from:{cid,pid}, to:{cid,pid}, name?, pts?, width? }`. Wires are **directed** (`from` = the end nearer the driver in the app's bookkeeping) but electrically a net is undirected; direction is a drawing/traversal convenience, not a hard constraint (see `orientNetFrom`).
- A **net** = the maximal set of wires connected transitively through `JUNCTION` components. Real component pins (gates, FF, IN/OUT, BUSTAP) terminate a net; they do not merge two nets together implicitly — only `JUNCTION` nodes do (this is the "ISE rule": a port drives one wire, everything else branches off through a visible dot).

### 1.2 Walking a net

- **`netWires(sch, w0)`** (line 3745) — BFS/DFS over `JUNCTION` endpoints starting from wire `w0`; returns a `Set` of every wire id electrically in the same net. Used for selection/highlight and for "does this net already have a name" checks (`applyWireName`, line 2648).
- **`netWiresFrom(sch, cid, pid)`** (line 3760) — walks *forward only*, from a specific driving pin, following `to`-side junctions. Used by fan-out normalization (`normalizePortFanout`) to find "other wires already leaving this exact port."
- **`branchFromNet(sch, fromPort, toPort, tap)`** (line 4256) — implements the ISE branching rule: when a second wire needs to leave a port that already drives one, this finds the best point on the existing net to drop a `JUNCTION`, splits the host wire through it (`splitWireThroughJunction`), and adds the new wire from the junction to `toPort`. If the user's click point is supplied (`tap.wid`/`tap.at`) that point wins outright over the nearest-point heuristic. Reuses an existing junction within `1.5*GRID` instead of stacking two dots.
- **`weldTouchingEnds(sch)`** (line 1740) — a *live-edit* pass: a dangling one-wire junction (`params.endpoint===true`) whose position exactly (`<2px`) coincides with another wire or another dangling end is turned into a real connection (splits the host wire through it, or merges the two ends). Computes `ownNet(j)` first so a junction is never welded onto its own net (which would create a `from===to` self-loop wire). Only fires on exact overlap so parked stubs are not accidentally grabbed.
- **`healJunctions(sch)`** (line 1904) — a maintenance sweep (**not** run on every edit, only on load/explicit calls) that:
  - removes 0-wire junctions (stray dots),
  - removes 1-wire junctions unless flagged `params.endpoint` (deliberate free end) or the far side is a **real component** (kept as an endpoint instead of deleted, to avoid silently unwiring a live pin),
  - collapses a clean 1-in/1-out junction into a single merged wire (pass-through), preserving the drawn polyline via `keepPicture`,
  - collapses two coincident/short-stub fan-out junctions into one dot — but **only if they are already the same net** (checked via `netDriverPort` equality or a joining stub) to avoid silently shorting two different nets together (explicit safety comment in the code, line ~1973).

### 1.3 Driver identification

- **`netDriverPort(sch, w, seen)`** (line 4351) — walks `w.from` backward through `JUNCTION`s to the first non-junction component; returns `{cid, pid}` of that real port (the ultimate driver), or `{cid: junctionId, pid:"j"}` if the chain dead-ends on a bare junction with nothing upstream (i.e., a dangling stub — this is the "looks connected but isn't" case).
- **`netHasDriver(sch, w, seen)`** (line 4335) — same walk, but returns a strict boolean: `false` when the chain ends on a junction with no incoming wire. This is the function that distinguishes "net legitimately has no single driver because it's assembled by BUSTAP merge taps" (checked first via `netMergeDriven`) from "net is simply undriven" (a floating stub) — the latter is what triggers the ERC "driver ไม่มี → VHDL จะได้ '0'/(others => '0')" warnings/errors.
- **`netMergeDriven(sch, w)`** (line 4318) — scans every wire on the net for a `BUSTAP` endpoint whose `params.mode !== "split"` (i.e., mode `"merge"`, or an old file with no mode recorded, treated permissively as driving). If found, the net counts as driven even though its "far end" dangles — because the bus is being assembled bit-by-bit by taps rather than fed from one single source port.
- **`orientNetFrom(sch, rootCid)`** (line 4402) — once a real driver lands on a previously undirected/undriven net (e.g., input pins tied together, then a source is attached), this walks outward from the driver and flips any wire that points the wrong way (`from`/`to` swapped, waypoints reversed) so the net's wire records are all consistently "away from the driver." Only ever invoked on a net that had no driver before, so it can never flip an already-real source.
- Multi-driver conflicts are refused live in `tapWire` (line 4432): completing a wire from an `out`-type pin (or a junction that already drives something) onto a wire whose net `netHasDriver()===true` is blocked with a toast ("แตะ (tap) สายด้วย output ไม่ได้ — จะทำให้มี driver ชนกัน").

### 1.4 Bus taps and width propagation

- `BUSTAP` component (`type:"BUSTAP"`) has `params:{bit, nbit, dir, mode}` where `mode` is `"split"` (reading `nbit` bits out of a bus, i.e. bus→thin wire) or `"merge"` (writing a thin wire's value into `bit..bit+nbit-1` of a bus, i.e. thin wire→bus).
- **`tappedBitsOnNet(w, sch)`** (line 2672) — unions, over the *whole net* (both directions), the bit ranges already claimed by existing taps, so a new tap never doubly-claims a bit.
- **`stampTapOnWire(w, point)`** (line 2706) — the "click on a bus" gesture: finds a nearby dangling free end (`freeEndNear`), determines tap direction/mode from whether that free end is already driven (`op.dir==="out"` ⇒ `mode:"merge"`), picks the next free bit via `tappedBitsOnNet`, and wires the tap's bus-side pin (`d`) onto the bus via a new `JUNCTION` spliced into the bus wire.
- Width is **not stored per-wire as authoritative** — it is derived from the *driving port's* declared `width` (an `IN`/`OUT`/gate/etc. port has `width` in its `ports()` definition). `driverWidth(cid, pid)` (inside `generateSchVhdl`, line 6143) and the ERC's local `traceSrc` (line 5815, inside `runSynthesis`) both walk back through junctions the same way `netDriverPort` does, to find the real port and read its `width`.
- **`traceSrc(w, visited)`** (runSynthesis, line 5815) — same junction-transparent backward walk, used specifically for the ERC's bus-width-mismatch check: for every wire whose `to` side lands on a **real** (non-junction) port, trace back to the ultimate driving port and compare `driver.width` vs `consumer.width`. Two special-cased exceptions:
  - `BUSTAP`'s bus pin (`tp.id==="d"`) accepts a bus of any width ≥ 2; the check instead verifies the tap's `bit..bit+nbit-1` range fits inside the source bus width.
  - A 1-bit driver feeding a wide `AND/OR/NAND/NOR/XOR/XNOR/NOT/BUF` gate is *allowed* (this is the "one select/enable bit masking a byte" idiom) — everything else with `fw !== tw` is an error.

---

## 2. VHDL generation

### 2.1 Entry points and call graph

```
generateVHDL()                       (6753)  — UI action for "⚙ Generate VHDL"
 ├─ runSynthesis()                   (5710)  — ERC first; issues shown regardless
 ├─ generateAllVhdl()                (5975)  — one entity per reachable schematic/custom
 │    ├─ collectReachable()          (5945)  — walk top down through SCH:/CUSTOM: instances
 │    └─ generateSchVhdl(sch)  ×N    (6014)  — the actual codegen, one call per entity
 └─ showVhdlFor(...) / bundleAll(...)         — renders into the VHDL panel
```

`exportVhdlFile()` (7327) and `exportAllVhdl()` (7342) just take the already-generated text (or call `generateVHDL()`/`generateAllVhdl()` if needed) and download it as `.vhd`, with a **layout stamp** appended (see §5).

### 2.2 `generateAllVhdl()` (line 5975)

- Calls `collectReachable()` (line 5945) to compute the set of entities actually placed (transitively) inside the **top** schematic (`state.project.topId`) — sub-schematics (`SCH:<id>`) and custom components (`CUSTOM:<name>`) that exist in the project but are never instantiated under top are *not* bundled (they're still individually viewable/exportable, flagged "ยังไม่ได้วางใน top").
- For every reachable schematic, calls `generateSchVhdl(sch)`; for every reachable custom component, builds a synthetic `sch`-shaped object from the custom's stored `{components, wires}` and calls `generateSchVhdl` on that too (customs with only `cc.vhdl` — hand-written/legacy — are passed through verbatim as a string).
- Guards against **entity name collisions**: two design units whose *display* names both sanitize (`sanId`) to the same VHDL identifier would emit two `entity foo is` blocks in one bundle. `clashWarn()` tracks claimed identifiers and appends a warning; `stash()` never overwrites an existing `out` key (appends `*` to the key instead) so no entity silently disappears from the bundle.
- Returns `{ [displayName]: {code, warns} }`.

### 2.3 `generateSchVhdl(sch)` (line 6014) — the core algorithm

**Step 1 — classify components.**
`inputs` = `IN` components, `outputs` = `OUT` components, `inners` = everything else *except* `IN/OUT/VCC/GND/CONST` (those last three are pure literals with no signal of their own).

**Step 2 — name allocation (`uniq()`, a per-generation dedup table `used{}`).**
Order matters for stability and legality:
1. Reserve sub-entity type names and instance labels first (`u_<label>`), *before* any net gets a name — otherwise a net could steal the identifier a `component`/instance declaration needs.
2. Each `IN`/`OUT` gets `c._net = uniq(paramName)`.
3. Each inner component gets one **signal name per output port**: `c._nets[portId] = uniq(label ? "<label>_<port>" : "n<index>_<port>")` — i.e., a labelled block's signal reads like the drawing (`carry_o`), an unlabelled one gets a positional `n7_o`. Widths recorded in `c._netW`.
4. Any wire the user explicitly named (`w.name`, set via the Net Name tool) **overrides** the auto name of its source port's signal (each source port renamed once only, via `renamedPorts` guard).
5. **Merge-bus allocation** (`allocMergeBuses`, line 6084): for every `BUSTAP` in `mode:"merge"`, find the net its bus pin sits on; if that net doesn't already own a name (from an `OUT` marker or a real port), mint one (`uniq(wireName || "bus")`) and stamp it onto every junction on that net as `_busNet`/`_busW`, so both the merge-writer side and the consumer side can find the same signal.

**Step 3 — the `driver(cid, pid)` resolver** (line 6120) — the semantic heart of codegen. Given a *sink* pin, returns the VHDL expression text that should feed it:
- `IN` source → the input's own signal name (`src._net`).
- `VCC` → literal `'1'`; `GND` → literal `'0'`; `CONST` → `constVhdl(params)` (hex `x".."` when width is a multiple of 4, else a binary string literal `"..."`, or `'0'/'1'` for width 1).
- `JUNCTION` → recurse upstream; if nothing drives it, falls back to `src._busNet` (a merge-assembled bus signal with no single "port" driver).
- Any other component → `src._nets[fromPid]` (the signal allocated in Step 2).
- Returns `null` if truly unconnected.
- **`driverWidth(cid, pid)`** — same walk, but returns the *declared port width* of the ultimate driver (used to legally decide whether to replicate a 1-bit signal across a wide gate).
- Unconnected inputs are covered by `driverFor(pid)` (a wrapper local to each component's emission block): when `driver()` returns null, it pushes a warning and substitutes `zlit(width)` — `'0'` for a 1-bit port, `(others => '0')` for a bus.

**Step 4 — per-component VHDL emission** (the `inners.forEach` in lines 6194–6599). One `if(c.type===...)` branch per component family, appending to one of three buffers:
- `concurrent[]` — plain `signal <= expr;` statements (combinational logic, output drivers, mux/demux/comparator/encoder/decoder/bus-tap expressions).
- `processes[]` — one entry per flip-flop: `{clk, edge, rst, pre, body, rstAssign, preAssign}`, rendered later into a `process(...) ... end process;` block.
- `subInstances[]` — one entry per `SCH:`/`CUSTOM:` instance: `{entity, inst, label, maps:[...]}`.

Component-family logic (all inside `generateSchVhdl`):
| Type | VHDL emitted |
|---|---|
| `AND/OR/NAND/NOR/XOR/XNOR/NOT/BUF` | `sig <= <expr>;` via each gate's own `.expr(ins)` (e.g. `ins.join(" and ")`, `"not (" + ins.join(" or ") + ")"`). A 1-bit operand feeding a wide gate is replicated: `std_logic_vector'(N-1 downto 0 => v)`. |
| `MUX` | `y <= d0 when (sel=…) else d1 when (sel=…) else … else '0';` — select bits combined into per-case AND conditions via `eq()`. |
| `DEMUX` | one line per output: `y_i <= d when (sel=…) else '0';` |
| `BUSTAP` (`mode:"split"`) | `y <= bus(hi downto lo);` (or `bus(bit)` for 1 bit) |
| `BUSTAP` (`mode:"merge"`) | deferred into `busMerges[]`: `bus(hi downto lo) <= v;`, emitted after regular output assignments so the bus signal already exists |
| `COMP`/`COMPM` | `eq <= '1' when unsigned'(A) = unsigned'(B) else '0';` (bus form uses `unsigned(a)`/`unsigned(b)` conversions instead of qualification); magnitude form emits `gt`/`lt` with `>`/`<` on `unsigned` operands (1-bit special-cased to avoid the ambiguous `std_logic` `>`/`<`) |
| `ENC` (priority encoder) | per output bit: OR of `(i_k and not i_(k+1) and … and not i_(n-1))` terms, highest index wins |
| `DEC` | per output: `y_i <= en when (a = i) else '0';` |
| `DFF/JKFF/TFF/SRFF` | pushed to `processes[]`; see §2.4 |
| `CUSTOM:<name>` | pushed to `subInstances[]`, port map built from `customPorts(cc)` |
| `SCH:<id>` | pushed to `subInstances[]`, port map built from `schPortList(subSch)` |
| `JUNCTION` | no VHDL emitted (fully transparent) |

Two literal-safety helpers used throughout: `isLit(v)` detects a driver string that is a bare literal (`'0'/'1'`, `(others=>'0'/'1')`, `x"..."`, `"..."`) — such a value can never be used as a clock/async-control signal name (VHDL requires an actual signal there) nor as one side of an unqualified `=` comparison (ambiguous overload). `eq(v, bit)` folds a comparison against a literal driver at compile-generation time into `"true"`/`"false"` instead of emitting `'0' = '1'`.

### 2.4 Flip-flop process synthesis (lines 6446–6564)

For each of `DFF/JKFF/TFF/SRFF`:
1. `ffClock()` requires a **real signal** driver on `clk` — if unconnected or tied to a literal (GND/VCC/CONST), the flip-flop's outputs are tied off (`tieOffOutputs()`: `sig <= zlit(width);` for every one of its output nets) and **no process is emitted** (this exact condition is also flagged as an ERC error, §3).
2. `asyncCtrl("rst"/"pre", enabled)` resolves the async control pin the same way, but tolerates a literal: GND (inactive tie-off, just a warning) is fine and simply drops that branch from the process; VCC means the control is permanently asserted, so instead of an unparseable process the function calls `holdOutputs()`, which emits constant concurrent assignments (`q <= '0'/'1'`) and a warning, and the FF process is skipped entirely.
3. `warnBothAsync(RST, PRE)` warns (not an error) if *both* async reset and preset are wired, since AMD/Xilinx families including Spartan-7 give a register only one async control.
4. `Q̄`/`qn` output is only declared/driven if some wire actually reads it (`ffQn()`), to avoid "unused signal" Vivado noise.
5. The process body is assembled per FF kind (D: `q<=D; qn<=not D;`; JK: literal-folded fast paths plus an `if/elsif` chain for the general case; T: toggle or hold; SR: `if S… elsif R…`), and the outer template is:

```vhdl
process(clk[, rst][, pre])
begin
  if rst = '1' then
    <rstAssign>
  elsif pre = '1' then
    <preAssign>
  elsif rising_edge(clk) then    -- or falling_edge
    <body>
  end if;
end process;
```
(`rst`/`pre` clauses included only if that control is wired; async reset always takes priority over async preset when both exist.)

6. **Register initial values**: every FF's `q`/`qn` signal is declared with `signal q_sig : STD_LOGIC := '0';` (or `'1'` for `qn`) — line 6626–6638, 6678 — so simulation doesn't start at `'U'` and the value maps to the Spartan-7 register `INIT` attribute at synthesis (per UG901, per the code's own comment).

### 2.5 Entity / architecture template (assembly, lines 6614–6733)

```vhdl
library IEEE;
use IEEE.STD_LOGIC_1164.ALL;
use IEEE.NUMERIC_STD.ALL;

-- Generated by Schematic Studio  (target: Xilinx Spartan-7 / Vivado)
-- Schematic: <sch.name>

entity <ename> is
  Port (
    <in1>  : in  STD_LOGIC | STD_LOGIC_VECTOR(N-1 downto 0);
    ...
    <out1> : out STD_LOGIC | STD_LOGIC_VECTOR(N-1 downto 0)
  );                              -- Port(...) block omitted entirely if there are no ports (empty Port() is illegal)
end <ename>;

architecture Behavioral of <ename> is
  component <sub_entity_1>        -- one per distinct instantiated sub-entity
    Port ( ... );                 -- omitted if the sub-entity is portless
  end component;
  signal <s1>, <s2>, ... : STD_LOGIC;                 -- all 1-bit combinational nets, one grouped line
  signal <q1> : STD_LOGIC := '0';                     -- one line per register, WITH init value
  signal <busN> : STD_LOGIC_VECTOR(W-1 downto 0);      -- one line per bus/vector net
begin

  -- combinational logic
  <sig> <= <expr>;
  ...

  -- sequential logic (flip-flops)
  process(clk, ...)
  begin
    if ... rising_edge(clk) then
      ...
    end if;
  end process;

  -- sub-component instantiations
  u_<label> : <entity> port map (
    <formal> => <actual>,
    ...
  );

  -- output drivers
  <out_net> <= <driver_expr>;
  <bus_from_merge_taps>(<hi> downto <lo>) <= <bit_signal>;

end Behavioral;
```

`ename` = `sanId(sch.name)`; identifiers pass through `sanId()` (line 1047) which lowercases, replaces non-`[a-z0-9_]` with `_`, collapses/trims underscores, prefixes `n_` if the result starts with a digit, and appends `_s` if the result collides with a VHDL reserved word (`VHDL_RESERVED`, line 1026, e.g. `in`, `out`, `entity`, `signal`, `process`…). Component/instance declarations reuse `formatComponentDecl(name, ports)` (line 6725) which also special-cases a portless sub-entity to avoid `Port ( );` (illegal VHDL).

Instance labels: `u_<sanId(label)>` if the placed instance was labelled on the canvas, else `u_<index>_<internalId>`.

### 2.6 Reconstructed example

Schematic "top": `IN a(1)`, `IN b(1)`, `IN sel(1)`, `OUT y(1)`; a 2-input `MUX` fed by `a`→`d0`, `b`→`d1`, `sel`→`s0`; `MUX.y` wired to `OUT y`.

Generated VHDL (`generateSchVhdl` output, reconstructed by hand-tracing the algorithm above):

```vhdl
library IEEE;
use IEEE.STD_LOGIC_1164.ALL;
use IEEE.NUMERIC_STD.ALL;

-- Generated by Schematic Studio  (target: Xilinx Spartan-7 / Vivado)
-- Schematic: top

entity top is
  Port (
    a   : in  STD_LOGIC;
    b   : in  STD_LOGIC;
    sel : in  STD_LOGIC;
    y   : out STD_LOGIC
  );
end top;

architecture Behavioral of top is
  signal n1_y : STD_LOGIC;
begin

  -- combinational logic
  n1_y <= a when sel = '0' else
          b when sel = '1' else '0';

  -- output drivers
  y <= n1_y;

end Behavioral;
```

(The `MUX`'s own output signal is unlabelled, so it gets the positional name `n1_y` — first inner component, port `y`. If the MUX block were labelled `"mx0"` on the canvas, the signal would instead be `mx0_y`.)

---

## 3. ERC — `runSynthesis()` (line 5710) — complete rule list

`runSynthesis()` returns `issues:[{lvl:"err"|"warn", msg, ref, schId?, cid?}]`, rendered in the Issues tab and re-shown (merged with generator warnings) after `generateVHDL()`. Rules below are grouped as they appear in the source; each line is `condition → severity → message` (message text kept in Thai as emitted, since the AI-side validator should key off the *condition*, not the localized string).

**Top-entity sanity**
1. No top schematic set → **err** → "ไม่มี top entity"
2. Top schematic has zero `IN` components → **warn** → "top entity ไม่มี INPUT pin"
3. Top schematic has zero `OUT` components → **warn** → "top entity ไม่มี OUTPUT pin"

**Hierarchy well-formedness** (checked across *every* schematic in the project, not just top)
4. A schematic instantiates a `SCH:<id>` sub-block that (transitively, via `schUsesSheet`) uses the parent sheet itself → **err** → hierarchy loop, "Vivado elaborate ไม่ได้"
5. (separately, `hierarchyCycles()`, run once at the end) Any sheet that contains itself transitively through `SCH:`/`CUSTOM:` instances → **err** → "schematic วนกลับมาหาตัวเอง: A → B → A"

**Per-sheet, per-component checks** (`Object.values(schematics).forEach`)

6. Two `IN` components share the same `params.name` → **err** → "INPUT 'n' ชื่อซ้ำ"
7. Two `OUT` components share the same `params.name` → **err** → "OUTPUT 'n' ชื่อซ้ำ"
8. An `IN` and an `OUT` share the same name → **err** → duplicate port name; VHDL would silently rename the output to `name_1` and the parent's wiring would land on the wrong (renumbered) pin
9. An `IN` pin has **no wire touching it at all** → **err** → "INPUT 'n' ไม่ได้ต่อไปไหน — เป็นขาของ entity ที่ไม่มีใครอ่านค่า"
10. For every `in`-direction port on every component (`td.ports(...).filter(dir==="in")`):
    - Port is wired, but `netHasDriver(sch, wIn)===false` (wire's far end dangles with nothing driving it), and the component is an `OUT` marker → **err** → "ต่อสายไว้แต่ปลายสายลอย — ไม่มีตัวขับ VHDL จะได้ (others => '0')"
    - Same condition, component is **not** `OUT` → **warn** → "ต่อกับสายที่ปลายลอย — ไม่มีตัวขับ VHDL จะได้ '0'"
    - Port has **no wire at all**, and component is not `OUT`/`GND` → **warn** → "ขา 'p' ยังไม่ได้ต่อสาย"
    - Port has no wire at all, and component **is** `OUT` → **err** → "ยังไม่ได้ต่อสาย" (an unconnected output pin is always an error, never just a warning)
11. Multiple-driver / short: any sink pin (`to.cid`+`to.pid`, including a `JUNCTION`'s implicit input) receiving **more than one incoming wire** → **err** → "จุดแยกสาย (junction) มีสายเข้าซ้อนกัน N เส้น — driver ชนกัน" (junction target) or "ขา 'p' มีสายเข้าซ้อนกัน N เส้น (multi-driver)" (real pin target)
12. Bus-tap range validity: a `BUSTAP`'s bus pin (`d`) is fed by a signal narrower than 2 bits → **err** → "Bus Tap ต้องแตะสายบัส (กว้างมากกว่า 1 bit) แต่สายที่แตะกว้าง N bit"
13. A `BUSTAP` claims bits `[bit, bit+nbit-1]` that exceed the actual source bus width → **err** → "Bus Tap แตะบิต hi:lo แต่บัสมีแค่ (W-1:0)"
14. General bus-width mismatch: a wire's traced driver width `fw` ≠ consumer port width `tw`, **except** the allowed idiom of a 1-bit driver feeding a wide `AND/OR/NAND/NOR/XOR/XNOR/NOT/BUF` gate → **err** → "สายเชื่อม X (fw bit) เข้ากับ Y (tw bit) — ความกว้างบัสไม่ตรงกัน"
15. Flip-flop (`DFF/JKFF/TFF/SRFF`) `clk` pin has no driver at all → **err** → "ขา 'clk' ยังไม่ได้ต่อสัญญาณนาฬิกา — flip-flop นี้จะไม่ถูกสร้าง"
16. Flip-flop `clk` pin is driven by a constant (`VCC`/`GND`/`CONST`) → **err** → "ขา 'clk' ต่อกับ ... (ค่าคงที่) — นาฬิกาต้องเป็นสัญญาณ ไม่ใช่ค่าคงที่"
17. Flip-flop `clk` pin is driven by a **combinational** block (any component that isn't `IN/VCC/GND/CONST/JUNCTION` and isn't itself a `SEQ_TYPES` FF) → **warn** → "รับนาฬิกาจาก ... (วงจร combinational = gated clock) — มี glitch ได้"
    - Explicitly **not** flagged (by design, per an inline code comment quoting the course's own instructor): a ripple clock (one FF's `Q` clocking the next FF) and an async reset built from gates — both are considered legitimate, commonly taught constructions.
18. Combinational feedback loop with **no register** anywhere in the cycle (`combinationalLoops(sch)`, line 5648 — builds a dependency graph over every non-`IN/OUT/VCC/GND/CONST/JUNCTION` and non-FF node, and DFS-detects cycles) → **err** → "สายป้อนกลับแบบไม่มี flip-flop (combinational loop): A → B → ... → A — Vivado จะ error DRC LUTLP-1"

**Warnings emitted specifically during flip-flop VHDL emission** (not part of `runSynthesis()` proper, but surfaced into the same Issues tab via `generateVHDL()`'s `warnItems` merge — worth including because the AI validator should reproduce them too):
19. Async control (`rst`/`pre`) enabled on a FF but its pin is unconnected → **warn** → "เปิด async X แต่ขา X ไม่ได้ต่อสาย — ข้าม X ในโค้ด"
20. Async control tied to GND (inactive tie-off) → **warn** ("ถูกต้องตามแบบ tie-off" — informational, not a defect)
21. Async control tied to VCC (permanently asserted, register becomes a constant) → **warn** → names which output value the FF is stuck at
22. Both async reset and async preset wired simultaneously → **warn** → Spartan-7/AMD parts support only one async control per register
23. Any component input pin with no driver, during codegen (`driverFor`) → **warn** → "ขา 'p' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน" (this duplicates/reinforces rule 10's warn case at generation time)
24. Comparator (`COMP`/`COMPM`) bus form with A or B unconnected/literal → **warn** → "ยังต่อขา A/B ไม่ครบ — ผลลัพธ์ถูกตรึงเป็น '0'"
25. `BUSTAP` merge mode with no bus net found, or no bit-signal driver → **warn** → "ยังไม่ได้แตะสายบัส" / "ยังไม่มีสัญญาณเข้าขาบิต"
26. `BUSTAP` split mode: unconnected, non-bus source, or out-of-range bit → **warn**, expression falls back to `zlit`
27. `OUTPUT` marker with no driver at generation time → **warn** → "OUTPUT 'net' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน"
28. `MUX` import/generation with an unparseable select condition → **warn** → falls back to positional placement
29. Sub-entity / custom-component input pin unconnected → **warn** → "ขา 'p' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน"
30. Entity name collision between two design units after `sanId()` → **warn** → appended into that unit's own `warns[]` by `generateAllVhdl`'s `clashWarn`

**Total distinct condition→message rules in `runSynthesis()` itself: 18** (items 1–18 above). Items 19–30 are additional validation-relevant warnings raised by the code generator (`generateSchVhdl`) and surfaced through the same UI panel — for a complete AI-side validation layer, both sets (≈30 rules total) should be ported, since the app treats them as one unified "is this buildable" signal to the student.

All ERC issues carry `{ref: sheetName, schId, cid}` when they're localizable to a component, enabling `focusComp(schId, cid)` (line 5629) to jump the canvas to the offending part — worth mirroring as `(sheet, component_id)` in any Python port so the AI can point at the exact node.

---

## 4. VHDL import (`parseVhdl` / `buildSchematicFromVhdl`)

Entry points: `importVhdlFile()` (line 7837, "Import VHDL" UI action) and `importCustomComponent()` (line 7886, imports `.sccomp.json` custom-component packages — a different, JSON-native format, not text VHDL).

### 4.1 Round-trip shortcut: the layout stamp

Every `.vhd` this app exports has a trailing comment block (`layoutStamp()`, line 7120) containing the **entire schematic JSON** (`{schematics, customs, topId}`), base64-encoded, wrapped in `-- ` comment lines between `LAYOUT_TAG_BEGIN`/`LAYOUT_TAG_END` markers — pure VHDL comment, invisible to Vivado. On import, `readLayoutStamp(text)` (line 7135) checks for this first; if present, `adoptSchematics(stamp.schematics)` (line 7299) rebuilds the drawing **exactly as it was drawn** (fresh ids, but identical geometry, wiring, layout) rather than re-deriving anything from the VHDL text. This is the path taken when re-importing the app's own exports. Only files lacking the stamp (hand-written or third-party VHDL) fall through to real parsing.

### 4.2 `parseVhdl(src)` (line 7734) — what subset of VHDL is understood

A regex/hand-rolled recursive-descent parser, **not** a real VHDL grammar. It extracts:
- **Entity name**: first `entity <name> is ... end` block.
- **Ports**: from a single `Port ( ... );` clause inside the entity, split on top-level `;` (`vhSplitTop`, delimiter-depth-aware for parens only). Each declaration matched as `name[, name...] : in|out <type>`. Width from `vhTypeWidth` (matches `(N downto M)` or `(N to M)`, else defaults to 1). **`inout` is treated as `out`** by the direction regex (`m[2].toLowerCase()==="in" ? "in" : "out"`) — a real limitation for bidirectional ports.
- **Architecture**: first `architecture X of Y is ... begin ... end` block; `signal` declarations parsed the same way as ports (name/width only, no other subtype support).
- **Statement bodies** (`vhParseBody`, line 7720): 
  - `process (...) ... end process;` blocks routed to `vhParseProcess` (line 7686), which requires a `rising_edge(clk)`/`falling_edge(clk)` call to recognize it as a flip-flop; the **last** (or first-after-edge) `target <= expr;` inside becomes the D input; a nested `if ctrl='1' then sig<='0'` pattern is heuristically read as an async **reset**, and the same shape assigning `'1'` as an async **preset**. Anything without a `rising_edge`/`falling_edge` call is skipped with a warning ("ข้าม process ที่ไม่ใช่ flip-flop") — **only single-bit D-type inference is supported**; JK/T/SR-style processes, multi-signal processes, case statements, and non-clocked (combinational) processes are not understood.
  - Everything else split on top-level `;`, matched as `target <= rhs;`. If `rhs` contains `when`/`else`, routed to `vhParseWhenElse` → a MUX inference (`vhMuxSel` decodes the selecting condition's constant into a binary index + selector net name(s), supporting both `sel = "01"` vector form and `(a='1' and b='0')` per-bit form). Otherwise treated as a combinational `assign` and parsed as a boolean expression tree (`vhParseExpr`/`vhTokenize`) supporting only `and/or/xor/nand/nor/xnor/not`, parens, `'0'`/`'1'` literals, `(others => '0'/'1')` aggregates, and bare signal names — **no arithmetic (`+`/`-`), no `to_integer`/type-conversion functions, no `case`/`with...select`, no generics, no records/arrays beyond `std_logic_vector`.**
- Any statement matching none of the above (and containing a letter) → warning "ข้ามคำสั่งที่อ่านไม่ได้: ...".
- If any port/signal width > 1 → global warning "มีสัญญาณบัส (>1 bit) — วาดลอจิกระดับบิตอาจไม่ครบ" (bit-level logic on buses is not fully reconstructed as bit-sliced gates; it's carried through as a whole-vector net).

### 4.3 `buildSchematicFromVhdl(ast)` (line 7757) — AST → schematic

- Emits an `IN` component per input port, a `VCC` for any literal `'1'` in an expression tree, an `AND/OR/.../NOT/BUF` gate per boolean operator node (`VH_OPGATE` maps operator names to component types), a `DFF` per recognized clocked process, a `MUX` per recognized when/else chain (sized to 2/4/8/16 inputs based on the highest decoded select index), and an `OUT` per output port.
- Builds a `driver{}` map (signal name → `{cid,pid}`) as it goes; unresolved references are collected into `need[]` and wired up in a final pass — any signal never driven ends up in the returned `unresolved:[]` list, surfaced to the user as "สัญญาณไม่พบต้นทาง: ...".
- **Auto-layout**: every generated component gets a `depth` (logic-level, 0 for `IN`, `maxD+1` for `OUT`, `1+max(operand depths)` for gates, fixed depth 2 for `DFF`/`MUX`) and is placed on a grid (`COLW=176, ROWH=88`) by depth-column, snapped to `GRID`.
- After insertion into the project, `normalizePortFanout(sch)` and `healLayout(sch)` are run so parallel same-port fan-out wires become visible junction dots and the routing looks native, exactly as it does for a loaded save file.

### 4.4 Known limitations (explicit, for the AI's code→drawing path)

- No arithmetic operators, no `case`/`with...select`, no generics/functions/records, no multi-process or combinational (non-clocked) processes, no `inout` ports (silently treated as `out`), no JK/T/SR flip-flop *inference* from VHDL (only D-type is recognized on the way in — even though the schematic side can generate all four types on the way out), no component instantiation import (i.e., a VHDL file with `u1: some_entity port map (...)` is not turned back into a `SCH:`/`CUSTOM:` block instance — only the flattened gate/mux/FF primitives are reconstructed).
- Because of this asymmetry, **round-tripping through real VHDL text (not the layout-stamp shortcut) is lossy** for anything beyond combinational gates + one MUX level + D-flip-flops. Any AI "code → drawing" feature should either (a) rely on the same flattened-primitive reconstruction and accept the same limitations, or (b) build a stronger parser rather than reusing `parseVhdl` verbatim.

---

## 5. Export paths and UI wiring

- **`generateVHDL()`** (line 6753) — bound to the "⚙ Generate VHDL" button (`data-act="gen-vhdl"`, line 334). Always runs `runSynthesis()` first (ERC issues are shown regardless of whether generation proceeds — the app does **not** block generation on ERC errors; it generates best-effort code and reports both ERC issues and generator warnings together in the Issues tab), then `generateAllVhdl()`, then populates the entity dropdown (`#vhdlEntitySel`): `★ All entities (bundle for Vivado)` plus one entry per reachable entity, plus a separated, disabled-header section listing schematics that exist in the project but are **not** reachable from top (shown read-only, individually viewable/downloadable, but excluded from the bundle).
- **`runSynthesis()`** (line 5710) — bound to both the F7 key (`ev.key==="F7"`, line 5302) and the "🔍 Check" button (`data-act="synth"`, lines 313/333, dispatched in the action switch at line 8096). Populates the Issues tab (`renderErrors`) and a pass/fail toast.
- **Top-entity selection**: `state.project.topId` (set via the sheet properties dropdown, line 5348/5358, or "★ Set Active as Top", line 2384). `collectReachable()` always starts from `state.project.schematics[topId]`; entity name in generated VHDL is `sanId(topSchematic.name)` lower-cased with special chars → `_` (doc comment at line 751 gives the example: sheet "My Top" → entity `my_top`).
- **Multi-sheet output**: `generateAllVhdl()` returns one `{code, warns}` per reachable schematic/custom; `bundleAll(all)` (line 6738) concatenates them into one text blob with `-- Entity: <name>` banner comments between sections — this is what `★ All entities` shows and what `exportVhdlFile()`/`exportAllVhdl()` download as a single `.vhd`.
- **`exportVhdlFile()`** (line 7327) — downloads whatever is currently shown in the VHDL panel (`#vhdlOutput`'s `dataset.raw`) — either the full bundle or a single selected entity — as `<name>.vhd`, with the base64 layout stamp appended (§4.1) so the file can be re-imported with its drawing intact.
- **`exportAllVhdl()`** (line 7342) — always regenerates and downloads the full bundle regardless of what's selected in the dropdown, again with the layout stamp appended.
- **`exportCustomComponent(name)`** (line 7620) — a **different artifact type**: not VHDL text but a `.sccomp.json` package (`{type:"schstudio-custom-pkg", version:1, root:name, customs:{...}}`) containing the named custom component's full schematic (components+wires, JSON) plus every custom component it transitively depends on (`collectCustomDeps`, line 7607) — this is the format `importCustomComponent()` (line 7886) reads back, distinct from `importVhdlFile()`'s text-VHDL/layout-stamp path.
- `exportActiveAsCustom()` (line 7952) is the same JSON package format, sourced from whatever schematic tab is currently open rather than a saved custom-component entry.

---

## 6. Testbench / stimulus generation

**None exists in this file.** A targeted search for `testbench`, `stimulus`, `tb_`, and simulation-related identifiers found no generator: the single occurrence of the word "testbench" in the source (comment near line 5747–5748) is only explaining *why* a duplicate IN/OUT port name is dangerous ("...that is the name that reaches Vivado, the port map and the testbench") — i.e., an observation about downstream Vivado-side testbenches a *student* might write by hand, not something this tool produces.

There is no `.vhd` testbench template, no stimulus/waveform generator, no simulation runner, and no `--sim`/`--tb` code path anywhere in `generateSchVhdl`, `generateVHDL`, `generateAllVhdl`, or the export functions. **Implication for the ecosystem hub: the "simulate" stage of the spec → draw → simulate → VHDL → board pipeline must be built independently** — this file only covers draw → VHDL (and, partially, VHDL → draw for a narrow VHDL subset). If simulation is meant to validate the schematic pre-synthesis, the ERC rules in §3 are the closest thing this tool offers to a correctness gate, and they are structural/static (no waveform or logic-value simulation is performed anywhere in the app).

---

## Appendix: key line-number index

| Symbol | Line |
|---|---|
| `VHDL_RESERVED` | 1026 |
| `sanId` | 1047 |
| `weldTouchingEnds` | 1740 |
| `healJunctions` | 1904 |
| `schPortList` | 2073 |
| `customPorts` | 2091 |
| `tappedBitsOnNet` | 2672 |
| `stampTapOnWire` | 2706 |
| `netWires` | 3745 |
| `netWiresFrom` | 3760 |
| `branchFromNet` | 4256 |
| `netMergeDriven` | 4318 |
| `netHasDriver` | 4335 |
| `netDriverPort` | 4351 |
| `orientNetFrom` | 4402 |
| `tapWire` | 4432 |
| `combinationalLoops` | 5648 |
| `hierarchyCycles` | 5689 |
| `runSynthesis` | 5710 |
| `collectReachable` | 5945 |
| `generateAllVhdl` | 5975 |
| `generateSchVhdl` | 6014 |
| `formatComponentDecl` | 6725 |
| `generateVHDL` | 6753 |
| `bundleAll` | 6738 |
| `exportVhdlFile` | 7327 |
| `exportAllVhdl` | 7342 |
| `layoutStamp` / `readLayoutStamp` | 7120 / 7135 |
| `exportCustomComponent` | 7620 |
| `vhParseExpr` / `vhParseProcess` / `vhParseWhenElse` / `vhMuxSel` | 7660 / 7686 / 7698 / 7711 |
| `parseVhdl` | 7734 |
| `buildSchematicFromVhdl` | 7757 |
| `importVhdlFile` | 7837 |
| `importCustomComponent` | 7886 |
| `exportActiveAsCustom` | 7952 |
