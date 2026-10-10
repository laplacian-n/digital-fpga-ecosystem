// Dragging a block's pins in the Inspector on a GENERATED sheet (one that carries sch.portOrder): the port
// blocks moved but schPortList read portOrder first, so the symbol kept its old order — the drag did nothing.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("reordering a generated sheet's pins changes the symbol (portOrder follows) and re-routes its wires", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ name: "dcomb", formula: "d3 = a & b; d2 = a | b; d1 = a ^ b; d0 = ~a" });
    const sub = Object.values(state.project.schematics).find(s => s.name === "dcomb");
    sub.portOrder = { in: ["a", "b"], out: ["d3", "d2", "d1", "d0"] }; sub.locked = true;
    await MCP_OPS.build_hierarchy({ sheet: "top2", inputs: ["a", "b"], outputs: ["y"], blocks: [{ name: "u", part: "dcomb" }], connect: "u.d0 -> y" });
    const top = Object.values(state.project.schematics).find(s => s.name === "top2");
    const blk = top.components.find(c => c.type === "SCH:" + sub.id);
    const outs = () => schPortList(sub).filter(p => p.dir === "out").map(p => p.name);
    const before = outs();
    const ok = reorderSubPins(blk, "out", ["d0", "d3", "d2", "d1"]);
    return { before, ok, after: outs(), po: sub.portOrder.out, pinCross: wirePinCrossings(sub).length,
      sim: clientCombSim(sub).ok !== false };
  });
  expect(r.before).toEqual(["d3", "d2", "d1", "d0"]);
  expect(r.ok).toBe(true);
  expect(r.after).toEqual(["d0", "d3", "d2", "d1"]);
  expect(r.po).toEqual(["d0", "d3", "d2", "d1"]);
  expect(r.pinCross).toBe(0);
  expect(page.errors).toEqual([]);
});
