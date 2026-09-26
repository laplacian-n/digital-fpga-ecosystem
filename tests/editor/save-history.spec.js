// 1. Lost-work protection: saved/unsaved chip, close warning, snapshot timeline
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("chip goes dirty on edit and clean on save", async ({ page }) => {
  await openEditor(page);
  await expect(page.locator("#saveChip")).toHaveClass(/clean/);
  await page.evaluate(() => { activeSch().components.push({ id: uid("c"), type: "AND", x: 300, y: 300, params: {}, label: "" }); snapshot(); renderAll(); });
  await expect(page.locator("#saveChip")).toHaveClass(/dirty/);
  const dl = page.waitForEvent("download");
  await page.click(".topbar .btn-primary[data-act=save-project]");
  await dl;
  await expect(page.locator("#saveChip")).toHaveClass(/clean/);
  await expect(page.locator("#saveChip")).toContainText("บันทึกแล้ว");
  expect(page.errors).toEqual([]);
});

test("closing with unsaved work asks first", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { activeSch().components.push({ id: uid("c"), type: "OR", x: 300, y: 300, params: {}, label: "" }); snapshot(); });
  await page.waitForTimeout(800);
  let asked = null;
  page.on("dialog", d => { asked = d.type(); d.dismiss(); });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toBe("beforeunload");
});

test("timeline keeps a checkpoint before auto-route and restores it", async ({ page }) => {
  await openEditor(page);
  await page.click("#btnAutoRoute");
  await page.click("[data-act=history-open]");
  await expect(page.locator(".tl-row")).not.toHaveCount(0);
  await expect(page.locator(".tl-list")).toContainText("ก่อนจัดสายอัตโนมัติ");
  await page.locator("[data-tl]").first().click();
  await expect(page.locator(".modal-bg")).toHaveCount(0);
  expect(page.errors).toEqual([]);
});
