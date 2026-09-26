// "ในsimสลับกับของจริงนะ" — the sim painted every 7-seg pattern on the LEFTMOST digit. On the board
// an:0 is the rightmost digit and a digit lights while its select is low.
const { test, expect } = require("@playwright/test");
const { openEditor, drawSheet } = require("./helpers");

async function segSheet(page, sel) {
  const parts = [{ k: "x", type: "IN", x: 100, y: 60, params: { name: "x" } }], wires = [];
  "abcdefg".split("").forEach((s, i) => { parts.push({ k: s, type: "OUT", x: 600, y: 60 + i * 66, params: { name: s } }); wires.push(["x", "o", s, "i"]); });
  if (sel) { parts.push({ k: "gnd", type: "GND", x: 300, y: 600 }, { k: sel, type: "OUT", x: 600, y: 600, params: { name: sel } }); wires.push(["gnd", "o", sel, "i"]); }
  await drawSheet(page, parts, wires);
  await page.evaluate(() => showSimPage("signals"));
  await page.locator('#simPcb .swUnit.mapped', { hasText: "x" }).click();
}
const lit = page => page.evaluate(() => [0, 1, 2, 3].map(d =>
  [...document.querySelectorAll(`#simPcb .seg[data-seg^="${d}-"]`)].filter(e => e.style.background === "rgb(0, 0, 0)" || e.style.background === "#000").length));

test("no digit select: the pattern shows on the rightmost digit", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await openEditor(page);
  await segSheet(page, null);
  await expect.poll(() => lit(page)).toEqual([0, 0, 0, 7]);
});

test("an1 held low lights the second digit from the right, like the board", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await openEditor(page);
  await segSheet(page, "an1");
  await expect.poll(() => lit(page)).toEqual([0, 0, 7, 0]);
});
