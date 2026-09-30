// DRC: two outputs on one net, logic whose output goes nowhere, an INPUT nothing reads (plus the loop check that was there).
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("check reports multi-driver nets, dangling logic and unused inputs", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    MCP_OPS.new_sheet({ name: "d" });
    MCP_OPS.apply({ sheet: "d", steps: [{ op: "add_component", type: "IN", name: "a" }, { op: "add_component", type: "IN", name: "b" },
      { op: "add_component", type: "IN", name: "unused" }, { op: "add_component", type: "AND", name: "G1" }, { op: "add_component", type: "OR", name: "G2" },
      { op: "add_component", type: "NOT", name: "N1" }, { op: "add_component", type: "OUT", name: "y" },
      { op: "connect", from: "a", to: "G1.i0" }, { op: "connect", from: "b", to: "G1.i1" }, { op: "connect", from: "a", to: "G2.i0" },
      { op: "connect", from: "b", to: "G2.i1" }, { op: "connect", from: "a", to: "N1" }, { op: "connect", from: "G1", to: "y" }] });
    const clean = MCP_OPS.check({ sheet: "d" });
    // the canvas lets a second output onto the same net (through the wire into y): the editor must say so
    const s = activeSch(), n1 = s.components.find(c => c.label === "N1"), y = s.components.find(c => c.type === "OUT");
    // G1 → dot → y, and N1 drawn onto the same dot: two outputs on one net
    const into = s.wires.find(w => w.to.cid === y.id), j = { id: uid("c"), type: "JUNCTION", x: 400, y: 200, params: {} };
    s.components.push(j);
    s.wires.push({ id: uid("w"), from: { cid: j.id, pid: "j" }, to: { cid: y.id, pid: "i" }, pts: [] });
    into.to = { cid: j.id, pid: "j" };
    s.wires.push({ id: uid("w"), from: { cid: n1.id, pid: "o" }, to: { cid: j.id, pid: "j" }, pts: [] });
    const bad = MCP_OPS.check({ sheet: "d" });
    return { clean: clean.issues.map(i => i.level + ":" + i.message), bad: bad.issues.map(i => i.level + ":" + i.message), errs: bad.errors,
      fixes: bad.issues.map(i => !!i.fix) };
  });
  expect(r.clean.some(m => /^error:INPUT 'unused' ไม่ได้ต่อไปไหน/.test(m))).toBe(true);     // the editor's own check
  expect(r.clean.some(m => /^warning:เอาต์พุตของ OR 'G2' ไม่ได้ต่อไปไหน/.test(m))).toBe(true);
  expect(r.clean.some(m => /^warning:เอาต์พุตของ NOT 'N1'/.test(m))).toBe(true);
  expect(r.clean.filter(m => /^error/.test(m)).length).toBe(1);
  expect(r.errs).toBeGreaterThan(0);
  expect(r.bad.some(m => /^error:สายเส้นเดียวมีต้นทาง 2 ตัว \(multi-driver\): AND 'G1'\.o, NOT 'N1'\.o/.test(m)), JSON.stringify(r.bad)).toBe(true);
  expect(r.fixes.every(Boolean)).toBe(true);
});
