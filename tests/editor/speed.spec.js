// 5. Faster work: letter keys, Ctrl+K, drag-out I/O, array placement
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("letter keys place parts; Shift+N keeps the net-name tool", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { const s = activeSch(); s.components = []; s.wires = []; renderAll(); });
  const c = await page.locator("#canvas").boundingBox();
  await page.mouse.move(c.x + 500, c.y + 300);
  for (const k of ["a", "Shift+O", "n", "q", "i", "d"]) await page.keyboard.press(k);
  expect(await page.evaluate(() => activeSch().components.map(c => c.type).join(","))).toBe("AND,NOR,NOT,OUT,IN,DFF");
  await page.keyboard.press("Shift+N");
  expect(await page.evaluate(() => state.tool)).toBe("netname");
});

test("Ctrl+K finds commands in Thai", async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press("Control+k");
  await page.keyboard.type("จัดสาย");
  await expect(page.locator(".cmdk-i").first()).toContainText("จัดสายอัตโนมัติ");
  await page.fill(".cmdk-in", "xor");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => activeSch().components.some(c => c.type === "XOR"))).toBe(true);
});

test("dragging out of a free pin creates a named INPUT", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { const s = activeSch(); s.components = [{ id: uid("c"), type: "AND", x: 440, y: 220, params: JSON.parse(JSON.stringify(TYPES.AND.defaultParams)), label: "" }]; s.wires = []; renderAll(); });
  const pin = await page.evaluate(() => { const c = activeSch().components[0]; const pp = portPos(c, getPorts(c).find(p => p.dir === "in").id);
    const r = canvas.getBoundingClientRect(); return { x: r.left + pp.x * state.view.k + state.view.x, y: r.top + pp.y * state.view.k + state.view.y }; });
  await page.mouse.move(pin.x, pin.y); await page.mouse.down();
  await page.mouse.move(pin.x - 140, pin.y, { steps: 6 }); await page.mouse.up();
  expect(await page.evaluate(() => activeSch().components.filter(c => c.type === "IN").map(c => c.params.name))).toEqual(["a"]);
});

test("array placement chains copies and keeps block pins in order", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    const m = fsmCounterIntent([0,1,2,3,4,5,6,7,8,9]); m.module = "mod10"; drawIntent(m);
    const s = activeSch(); s.components = []; s.wires = [];
    const sub = Object.values(state.project.schematics).find(x => x.name.startsWith("mod10"));
    arrayPlace("SCH:" + sub.id, 3, "h", ["q3", "clk"], []);
    return { pins: uxTypePorts("SCH:" + sub.id).map(p => p.id).join(","),
      wires: s.wires.map(w => comp(w.from.cid).label + "." + w.from.pid + ">" + comp(w.to.cid).label + "." + w.to.pid) };
  });
  expect(r.pins).toBe("clk,q0,q1,q2,q3");
  expect(r.wires).toEqual(["mod10_1.q3>mod10_2.clk", "mod10_2.q3>mod10_3.clk"]);
});
