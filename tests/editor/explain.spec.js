// 4. Problems shown in place + "why doesn't the sim do what I expect"
const { test, expect } = require("@playwright/test");
const { openEditor, drawSheet } = require("./helpers");

test("floating pin and multi-driver are marked, and the pin is still clickable", async ({ page }) => {
  await openEditor(page);
  await drawSheet(page, [
    { k: "a", type: "IN", x: 88, y: 110, params: { name: "a" } }, { k: "b", type: "IN", x: 88, y: 198, params: { name: "b" } },
    { k: "g", type: "AND", x: 308, y: 110 }, { k: "y", type: "OUT", x: 660, y: 154, params: { name: "y" } },
  ], [["a", "o", "g", "in0"], ["g", "o", "y", "i"], ["b", "o", "y", "i"]]);
  await expect(page.locator(".ux-marks .ux-mp")).toHaveCount(1);
  await expect(page.locator(".ux-marks .ux-mw")).not.toHaveCount(0);
  const top = await page.evaluate(() => explainSim(activeSch())[0].title);
  expect(top).toContain("multi-driver");
  // the red dot must not swallow the click that starts a wire from that pin
  const box = await page.locator(".ux-marks .ux-mp").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await page.evaluate(() => !!state.pendingWire)).toBe(true);
});

test("stuck reset and gated clock are explained", async ({ page }) => {
  await openEditor(page);
  await drawSheet(page, [
    { k: "clk", type: "IN", x: 88, y: 110, params: { name: "clk" } }, { k: "f", type: "DFF", x: 308, y: 110, params: { reset: true } },
    { k: "v", type: "VCC", x: 200, y: 250 }, { k: "q", type: "OUT", x: 660, y: 110, params: { name: "q" } },
  ], [["clk", "o", "f", "clk"], ["v", "o", "f", "rst"], ["f", "qn", "f", "d"], ["f", "q", "q", "i"]]);
  const titles = await page.evaluate(() => explainSim(activeSch()).map(f => f.title).join(" | "));
  expect(titles).toContain("reset ค้างอยู่ที่ 1");
});
