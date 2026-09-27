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
}
const flip = page => page.locator('#simPcb .swUnit.mapped', { hasText: "x" }).click();
const lit = page => page.evaluate(() => [0, 1, 2, 3].map(d =>
  [...document.querySelectorAll(`#simPcb .seg[data-seg^="${d}-"]`)].filter(e => e.style.background === "rgb(0, 0, 0)" || e.style.background === "#000").length));

test("no digit select: the pattern shows on the rightmost digit", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await openEditor(page);
  await segSheet(page, null);
  await expect.poll(() => lit(page)).toEqual([0, 0, 0, 7]);     // x = 0: every segment pin low → all lit
  await flip(page);
  await expect.poll(() => lit(page)).toEqual([0, 0, 0, 0]);     // x = 1: segments are active-low → dark
});

test("an1 held low lights the second digit from the right, like the board", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await openEditor(page);
  await segSheet(page, "an1");
  await expect.poll(() => lit(page)).toEqual([0, 0, 7, 0]);
});

test("segments are active-low like the board: the seg7dec pattern for 0 shows a 0, not a dash", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await openEditor(page);
  // a..f tied low, g tied high → the digit 0 on a common-anode display
  const parts = [{ k: "x", type: "IN", x: 100, y: 60, params: { name: "x" } }, { k: "gnd", type: "GND", x: 300, y: 60 }, { k: "vcc", type: "VCC", x: 300, y: 500 }], wires = [];
  "abcdefg".split("").forEach((s, i) => { parts.push({ k: s, type: "OUT", x: 600, y: 60 + i * 66, params: { name: s } }); wires.push([s === "g" ? "vcc" : "gnd", "o", s, "i"]); });
  parts.push({ k: "y", type: "OUT", x: 600, y: 600, params: { name: "y" } }); wires.push(["x", "o", "y", "i"]);
  await drawSheet(page, parts, wires);
  await page.evaluate(() => showSimPage("signals"));
  const segs = await page.evaluate(() => new Promise(r => setTimeout(() => r([...document.querySelectorAll('#simPcb .seg[data-seg^="3-"]')]
    .map(e => (e.style.background === "rgb(0, 0, 0)" || e.style.background === "#000") ? 1 : 0).join("")), 300)));
  expect(segs).toBe("11111100");                                 // a..f lit, g dark (8th = decimal point, unused)
});
