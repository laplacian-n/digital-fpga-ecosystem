// "เวลากดย่อมันหายไปทั้งหน้าต่าง ทิ้งเป็นช่องโล่งๆ": after a pane was resized, collapsing it left
// its (now empty) column behind instead of giving the space to the sheet.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

for (const side of ["right", "left"]) test(`collapse the ${side} pane after resizing it: the sheet takes the space`, async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 820 });
  await openEditor(page);
  const pane = side === "right" ? "#rightPane" : "#leftPane";
  // what dragging the resizer leaves behind: the width as an inline style
  await page.evaluate(s => document.querySelector(".workspace").style.setProperty(s === "right" ? "--w-right" : "--w-left", "420px"), side);
  const before = (await page.locator("#canvas").boundingBox()).width;
  await page.click(`[data-act="collapse-${side}"]`);
  await expect.poll(async () => (await page.locator(pane).boundingBox()).width).toBeLessThan(2);
  const after = (await page.locator("#canvas").boundingBox()).width;
  expect(after).toBeGreaterThan(before + 400);
  // and it comes back at the width the user chose
  await page.click(`#reopen${side === "right" ? "Right" : "Left"}`);
  await expect.poll(async () => Math.round((await page.locator(pane).boundingBox()).width)).toBe(420);
});
