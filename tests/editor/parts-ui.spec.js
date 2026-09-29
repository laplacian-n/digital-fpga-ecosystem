// "ไล่ทำที่เสนอมา": the checked parts in the Modules tab — pick one, set its size, place it as a block.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("Modules tab: a checked part placed as a block on the sheet on screen", async ({ page }) => {
  await openEditor(page);
  await page.click('.pane-tabs button:has-text("Modules")');
  await expect(page.locator("#modulesPane .pt-h").first()).toContainText("ชิ้นส่วนสำเร็จรูป");
  await page.click('[data-ptgrp="บวก/ลบ"]');
  await page.click('[data-part="adder"]');
  const dlg = page.locator(".modal").last();
  await dlg.locator('[data-pp="n"]').fill("4");
  await dlg.locator('[data-pp="bus"]').check();
  await expect(dlg.locator("#ptPorts")).toContainText("a[3:0]");
  await page.screenshot({ path: test.info().outputPath("parts-dialog.png") });
  const before = await page.evaluate(() => activeSch().name);
  await dlg.locator("#ptPlace").click();
  const r = await page.evaluate(() => { const s = activeSch(); const blk = s.components.find(c => String(c.type).startsWith("SCH:"));
    const sub = blk && state.project.schematics[blk.type.slice(4)];
    return { name: s.name, block: !!blk, pins: blk ? getPorts(blk).map(p => p.id + ":" + (p.width || 1)) : [], verified: sub && sheetVerified(sub) }; });
  expect(r.name).toBe(before);                                           // still on the sheet the user was on
  expect(r.block).toBe(true);
  expect(r.pins).toEqual(["a:4", "b:4", "cin:1", "s:4", "cout:1"]);
  expect(r.verified).toBe(true);
  // beside the drawing, not on top of what was there
  const overlap = await page.evaluate(() => { const s = activeSch(), b = s.components.find(c => String(c.type).startsWith("SCH:")), B = getSize(b);
    return s.components.filter(c => c !== b && c.type !== "JUNCTION").some(c => { const S = getSize(c); return c.x < b.x + B.w && b.x < c.x + S.w && c.y < b.y + B.h && b.y < c.y + S.h; }); });
  expect(overlap).toBe(false);
  // search reaches the parts too
  await page.fill("#modSearch", "7-seg");
  await expect(page.locator('[data-part="bcd_7seg"]')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("parts-pane.png") });
  expect(page.errors).toEqual([]);
});
