// "Make Y out of N × X" is a structure to wire (build_hierarchy), not one library part to drop in —
// and the part the request ends up as (Y) is what the oracle checks.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("a composition request: the target is read as the spec, nothing is fast-built", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const rd = m => { const f = partFromMessage(m); return f ? f.kind + JSON.stringify(f.args) + (f.compose ? "+" : "") : null; };
    const fast = await aiagFastPath("เอาตัวบวก 4 บิต 2 ตัวมาต่อเป็นตัวบวก 8 บิต", { steps: [] });
    return { eight: rd("เอาตัวบวก 4 บิต 2 ตัวมาต่อเป็นตัวบวก 8 บิต"), mux: rd("ต่อ mux 2:1 สามตัวเป็น mux 4:1"),
      none: rd("ต่อ full adder แบบ ripple carry 2 ตัว"), from: rd("ประกอบ mux 4:1 จาก mux 2:1 3 ตัว"), plain: rd("ตัวบวก 4 บิต"), fast,
      sheets: Object.values(state.project.schematics).map(s => s.name) };
  });
  expect(r.eight).toBe('adder{"n":8}+');
  expect(r.mux).toBe('mux{"n":4}+');
  expect(r.none).toBe(null);
  expect(r.from).toBe('mux{"n":4}+');
  expect(r.plain).toBe('adder{"n":4}');
  expect(r.fast.final).toBeUndefined();          // the agent's fast path did not draw anything
  expect(r.fast.note).toMatch(/build_hierarchy/);
  expect(r.sheets).toEqual(["top"]);
});
