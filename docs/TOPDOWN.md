# Top-Down: how the hand-drawn sheets look, and how the engine reproduces them

Reference: the lab sheets *2nd Layer (RandomDice)*, *4th/5th Layer (Mod20m)* drawn on A4 grid paper.
`topdown/td-engine.js` implements the rules below; `tests/topdown-engine.spec.js` checks them on
those two circuits.

## Page
- A4 landscape. Student ID / name / section in the top-right corner of the paper.
- Title centred above the frame: `Nth Layer (Module)`, with the ordinal as a superscript.
- The module is a **dashed rectangle**. Its name is written at the top-left corner.

## Parts
- A block is a plain rectangle. Its **name is written above the box, left-aligned**
  (`Mod10`, `Counter0_99`, `Display`), and the pin names are inside the box.
- Inputs are on the left edge and outputs on the right edge.
- A clock pin has the wedge `>` inside the body. An active-low clock has a bubble outside the body.
- Gates use the usual shapes. An inverted gate input has a bubble on the pin
  (the RandomDice AND gets `~Buzzer`). A constant is written as `'1'` with a short line.
- Blocks of the same kind are the same size.

## Placement
- **Signal flows left → right.** Parts are placed in columns by logic depth.
  A feedback loop is broken where it points back: Buzzer → AND does not push the AND to the right.
- **What feeds a part sets its row.** A part is moved up or down so the wire from the part
  that drives it runs **straight**:
  - `Q → CLK` runs along one row in Mod20m.
  - `D0/D1` from the counter run level into Display.
- **Several consumers of one source stack in the same column**, with their left edges
  aligned (Display above Compare).
- **Long chains wrap.** When a row would not fit the paper, the chain continues on a new row
  that starts again at the left. For Mod20m that gives 4 blocks, then 3 blocks plus the JK-FF.
- **Ports sit outside the frame as bare names.** Each one is on the row of the pin it feeds or
  comes from. If that row runs into a part, the nearest clear row is used and the wire steps once.
  Ports keep their pin order (D0 above D1).
- **Channels between columns and rows** are sized for the wires that have to turn in them.

## Wires
- All wires are orthogonal and never pass through a part or across a pin's lead.
- **A net with several sinks is one tree.** There is one spine, and each sink branches off it
  with a **junction dot** at every T:
  - CLR runs as a bus under the first row, with a drop into each CLR pin.
  - Button branches just left of the AND gate.
- A branch never starts at a pin. It joins the spine instead.
- Different nets are never collinear, and they keep at least one track apart.
- Nets cross plainly, with no hop arcs; the dots show what is joined. Hops can be turned
  back on (ขนาดตัวอักษร ▸ วาดสะพาน).
- **Buses:** a slash with the width is drawn near the source, and again near each sink
  (the `4` at Counter, again at Display and at Compare). A port draws its own slash.

## Engine
- `TDE.layout(s)`:
  - It places parts, ports, constants and the frame, then calls `TDE.route`.
  - If any net needed a relaxed route, it widens the channels and tries again, at most twice.
- `TDE.route(s)`:
  - The track grid is every pin tip plus the 10-unit grid. Grid lines that would crowd
    a pin row are dropped.
  - Nets are routed in this order: straight 2-pin nets first, then by size, big fan-outs last.
  - Each sink is found with an A* search from the sink back to the net's tree.
  - Costs: +34 per bend, +28 per crossing, and a penalty for running within 9 units of
    another net.
  - Forbidden: sharing a run with another net, turning on another net's line,
    crossing a pin lead, entering a body.
  - The result is written to `w.pts` with `w.exact = w.auto = true`.
- **Re-routing:** the page calls `TDE.route` again after a part is moved or resized, or a
  wire is added or deleted.
  - A wire whose corner the user drags becomes theirs: `auto` is cleared, and it becomes an
    obstacle for the others.
- Sheets sent from the gate editor are **redrawn for paper** by the gate editor itself
  (`editor/ux/53-topdown-paper.js`, `tdPaperSheet`): the placement rules above, buses regrouped from
  numbered pins, and every wire routed by the gate editor's own router on parts shaped like these
  symbols — then sent as an exact sheet with its own frame (`paper:true`). If that cannot join every
  pin cleanly, the old 1:1 transfer (`schematicToTopdownExact`) is used. This engine (`TDE`) stays for
  sheets drawn in Top-Down itself.
