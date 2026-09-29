// Wiring hints: four FA blocks + the ports → the hints wire a working ripple-carry adder.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("four FA blocks: hints chain cout→cin, feed a0..a3 / b0..b3, collect sum0..sum3; wired, it adds", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_part({ kind: "full_adder", sheet: "FA" });
    await MCP_OPS.new_sheet({ name: "add4" });
    const steps = [];
    for (let i = 0; i < 4; i++) steps.push({ op: "add_component", type: "IN", name: "a" + i }, { op: "add_component", type: "IN", name: "b" + i });
    steps.push({ op: "add_component", type: "IN", name: "cin" });
    for (let i = 0; i < 4; i++) steps.push({ op: "add_component", type: "block:FA", name: "FA" + i }, { op: "add_component", type: "OUT", name: "sum" + i });
    steps.push({ op: "add_component", type: "OUT", name: "cout" });
    await MCP_OPS.apply({ steps });
    const pins = getPorts(activeSch().components.find(c => c.label === "FA0")).map(p => p.id);
    const hints = MCP_OPS.suggest_wires({}).hints;
    const applied = MCP_OPS.suggest_wires({ apply: true });
    const left = MCP_OPS.suggest_wires({}).hints.length;
    // 5 + 9 + 1 = 15, and 15 + 15 + 1 = 31
    const add = (a, b, c) => { const inp = { cin: String(c) }; for (let i = 0; i < 4; i++) { inp["a" + i] = String((a >> i) & 1); inp["b" + i] = String((b >> i) & 1); }
      const s = activeSch(), fs = flattenSchematic(s).sch, o = mcpEvalOuts(s, fs, probeStruct(fs), inp);
      return [0, 1, 2, 3].reduce((v, i) => v + (+o["sum" + i] << i), 0) + (+o.cout << 4); };
    return { pins, hints, n: applied.count, left, sums: [add(5, 9, 1), add(15, 15, 1), add(0, 0, 0)] };
  });
  expect(r.pins).toEqual(expect.arrayContaining(["a", "b", "cin", "sum", "cout"]));
  const h = r.hints.map(x => x.from + " → " + x.to);
  expect(h).toEqual(expect.arrayContaining(["FA0.cout → FA1.cin", "FA2.cout → FA3.cin", "a2 → FA2.a", "b0 → FA0.b", "cin → FA0.cin", "FA3.cout → cout"]));
  expect(h.some(x => /^a\d → FA\d\.a$/.test(x) && x[1] !== x[x.length - 3])).toBe(false);   // a2 never into FA1
  expect(r.left).toBe(0);
  expect(r.sums).toEqual([15, 31, 0]);
});

test("the Inspector shows the selected block's hints with dashed guides; one click wires it", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(async () => {
    await MCP_OPS.build_part({ kind: "full_adder", sheet: "FA" });
    await MCP_OPS.new_sheet({ name: "chain" });
    await MCP_OPS.apply({ steps: [{ op: "add_component", type: "block:FA", name: "FA0" }, { op: "add_component", type: "block:FA", name: "FA1" }] });
    const c = activeSch().components.find(x => x.label === "FA1");
    state.selection = new Set([c.id]); renderAll();
  });
  await expect(page.locator(".wh-box")).toContainText("FA0.cout");
  expect(await page.locator(".wh-ghost .wh-line").count()).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath("wire-hints.png") });
  await page.locator('.wh-box [data-wh="0"]').click();
  expect(await page.evaluate(() => activeSch().wires.length)).toBeGreaterThan(0);
  expect(page.errors).toEqual([]);
});
