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
      made: rd("ใช้ mux 2 ต่อ 1 จำนวน 3 ตัวสร้าง mux 4:1"), eight8: rd("ใช้ mux 4:1 2 ตัวและ mux 2:1 หนึ่งตัวทำ mux 8:1 ลงแผ่น lab8"),
      named6: rd("ใช้ตัวบวก 3 บิต 2 ตัวต่อกันเป็นตัวบวก 6 บิต ตั้งชื่อแผ่น lab6"), sheet6: rd("ทำวงจร half adder ลงแผ่น lab6"), lab6: rd("ทำแลป 6"),
      none: rd("ต่อ full adder แบบ ripple carry 2 ตัว"), from: rd("ประกอบ mux 4:1 จาก mux 2:1 3 ตัว"), plain: rd("ตัวบวก 4 บิต"), fast,
      sheets: Object.values(state.project.schematics).map(s => s.name) };
  });
  expect(r.eight).toBe('adder{"n":8}+');
  expect(r.mux).toBe('mux{"n":4}+');
  expect(r.none).toBe(null);
  expect([r.made, r.eight8, r.named6]).toEqual(['mux{"n":4}+', 'mux{"n":8}+', 'adder{"n":6}+']);
  expect(r.sheet6).toBe('half_adder{"sheet":"lab6"}');   // a sheet named lab6 is not lab 6
  expect(r.lab6).toBe("lab6_counter{}");
  expect(r.from).toBe('mux{"n":4}+');
  expect(r.plain).toBe('adder{"n":4}');
  expect(r.fast.final).toBeUndefined();          // the agent's fast path did not draw anything
  expect(r.fast.note).toMatch(/build_hierarchy/);
  expect(r.sheets).toEqual(["top"]);
});
