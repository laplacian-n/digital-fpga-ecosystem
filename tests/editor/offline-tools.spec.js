// 2. Works without the Python backend: browser sim, truth table / K-map, generators
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("demo half adder simulates in the browser", async ({ page }) => {
  await openEditor(page);
  const tt = await page.evaluate(() => clientCombSim(activeSch()).truth_table);
  expect(tt.outputs).toEqual(["sum", "cout"]);
  expect(tt.rows.map(r => r[1].join(""))).toEqual(["00", "10", "10", "01"]);
  await page.click(".step[data-stage=sim]");
  await expect(page.locator("#simBoardTable tr")).toHaveCount(5);
});

test("truth table tool builds a correct XOR", async ({ page }) => {
  await openEditor(page);
  await page.click("[data-ltab=palette]");
  await page.click("[data-gen=tt]");
  await page.locator(".tt-c").nth(1).click();
  await page.locator(".tt-c").nth(2).click();
  await expect(page.locator("#ttExpr")).toContainText("y = a'·b + a·b'");
  await page.click("#ttBuild");
  const rows = await page.evaluate(() => clientCombSim(activeSch()).truth_table.rows.map(r => r[1][0]).join(""));
  expect(rows).toBe("0110");
});

test("BCD → 7-seg matches the segment table for 0-9", async ({ page }) => {
  await openEditor(page);
  const bad = await page.evaluate(() => {
    const P = seg7Preset(false); uxDrawGenerated(ttToIntent(P.inputs, P.outputs, P.rows, P.module).intent, "7seg");
    const j = clientCombSim(activeSch()), bad = [];
    j.truth_table.rows.forEach(([bits, outs]) => { const r = parseInt(bits.join(""), 2); if (r > 9) return;
      j.truth_table.outputs.forEach((o, k) => { if (String(outs[k]) !== SEG7[o][r]) bad.push(o + r); }); });
    return bad;
  });
  expect(bad).toEqual([]);
});

test("mod-10 generator counts 0..9 and wraps", async ({ page }) => {
  await openEditor(page);
  const seq = await page.evaluate(() => {
    const r = fsmCounterIntent([0,1,2,3,4,5,6,7,8,9]); r.module = "mod10"; uxDrawGenerated(r, "mod10");
    return clientSeqSim(activeSch(), 12).sequence.rows.map(r => parseInt(r[3].slice().reverse().join(""), 2)).join(",");
  });
  expect(seq).toBe("0,1,2,3,4,5,6,7,8,9,0,1");
});

test("backend-down message explains what to do", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { toggleAiChat(); aiAppend("ai", "ต่อ backend ไม่ได้ — รัน python ai/chat_server.py", { err: true }); });
  await expect(page.locator("#acLog .ux-need")).toContainText("python ai/chat_server.py");
});
