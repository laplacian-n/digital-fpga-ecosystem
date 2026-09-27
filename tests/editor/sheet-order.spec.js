// "ทำให้เลื่อนวางไอ่ตัวพวกนี้ได้ด้วย": drag a sheet in the project tree to reorder it.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

const names = page => page.locator("#projectPane .tree-item.sch .label").allTextContents();

test("drag a sheet above another; the order is kept, saved, and undoable", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { ["bin4", "seg7dec", "bcd_dec"].forEach(n => { const id = uid("sch");
    state.project.schematics[id] = blankSchematic(id, uniqueSchName(n, id)); }); snapshot(); renderAll(); });
  const before = await names(page);
  expect(before.slice(-3)).toEqual(["bin4", "seg7dec", "bcd_dec"]);
  const src = page.locator("#projectPane .tree-item.sch", { hasText: "bcd_dec" });
  const dst = page.locator("#projectPane .tree-item.sch", { hasText: "bin4" });
  await expect(src).toHaveAttribute("draggable", "true");
  await src.dragTo(dst, { targetPosition: { x: 20, y: 2 } });          // upper half of bin4 → above it
  const after = await names(page);
  expect(after.indexOf("bcd_dec")).toBe(after.indexOf("bin4") - 1);
  // it is the project's own order, so it is what gets saved
  const saved = await page.evaluate(() => Object.values(JSON.parse(serialize()).project.schematics).map(s => s.name));
  expect(saved.indexOf("bcd_dec")).toBe(saved.indexOf("bin4") - 1);
  await page.keyboard.press("Control+z");
  await expect.poll(() => names(page)).toEqual(before);
  expect(page.errors).toEqual([]);
});
