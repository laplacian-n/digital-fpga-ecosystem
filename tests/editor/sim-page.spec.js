// Sim page: live switches on a clocked circuit, and the board + table fit side by side.
const { test, expect } = require("@playwright/test");
const { openEditor, drawSheet } = require("./helpers");

async function drawRegister(page) {
  const parts = [{ k: "clk", type: "IN", x: 100, y: 60, params: { name: "clk" } }];
  const wires = [];
  for (let i = 0; i < 4; i++) {
    parts.push({ k: "d" + i, type: "IN", x: 100, y: 160 + i * 120, params: { name: "d" + i } },
               { k: "f" + i, type: "DFF", x: 400, y: 160 + i * 120 },
               { k: "q" + i, type: "OUT", x: 700, y: 160 + i * 120, params: { name: "q" + i } });
    wires.push(["d" + i, "o", "f" + i, "d"], ["clk", "o", "f" + i, "clk"], ["f" + i, "q", "q" + i, "i"]);
  }
  await drawSheet(page, parts, wires);
}

test("register: flip a data switch, step one clock, q follows d", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await openEditor(page);
  await drawRegister(page);
  await page.evaluate(() => showSimPage("signals"));
  await page.waitForFunction(() => SIM_SEQ && SIM_SEQ.rows.length);
  const d1 = page.locator('#simPcb .swUnit.mapped', { hasText: "d1" });
  await expect(d1).toHaveCount(1);
  await d1.click();
  await expect(page.locator("#simValbar")).toContainText("d1=1");
  await expect(page.locator("#simValbar")).toContainText("q1=0");
  await page.click('[data-act="seq-step"]');
  await expect(page.locator("#simValbar")).toContainText("q1=1");
  await expect(page.locator("#simValbar")).toContainText("q0=0");
  // the switch stays up on the next clock; flip it back and q drops one clock later
  await expect(page.locator("#simValbar")).toContainText("d1=1");
  await d1.click();
  await page.click('[data-act="seq-step"]');
  await expect(page.locator("#simValbar")).toContainText("q1=0");

  // layout: the truth table is beside the board and the page does not scroll
  const box = await page.evaluate(() => {
    const b = document.querySelector(".sim-boardwrap").getBoundingClientRect(), t = document.querySelector("#simSide").getBoundingClientRect(),
          body = document.querySelector(".sim-body");
    return { boardRight: b.right, sideLeft: t.left, sideTop: t.top, boardTop: b.top, scroll: body.scrollHeight - body.clientHeight };
  });
  expect(box.sideLeft).toBeGreaterThanOrEqual(box.boardRight - 1);
  expect(Math.abs(box.sideTop - box.boardTop)).toBeLessThan(40);
  expect(box.scroll).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath("register-sim.png") });
  expect(page.errors).toEqual([]);
});

test("register: plays on past the first run and takes a switch flip without stopping", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await openEditor(page);
  await drawRegister(page);
  await page.evaluate(() => showSimPage("signals"));
  await page.waitForFunction(() => SIM_SEQ && SIM_SEQ.rows.length);
  const n0 = await page.evaluate(() => SIM_SEQ.rows.length);
  await page.fill("#seqSpeed", "120");
  await page.click('[data-act="seq-play"]');
  await page.locator('#simPcb .swUnit.mapped', { hasText: "d2" }).click();       // while playing
  expect(await page.evaluate(() => SIM_SEQ.playing)).toBe(true);                   // still running
  await page.waitForFunction(n => SIM_SEQ.idx >= n + 2, n0, { timeout: 10000 });  // went past the first run
  expect(await page.evaluate(() => SIM_SEQ.rows.length)).toBeGreaterThan(n0);
  await expect(page.locator("#simValbar")).toContainText("q2=1");                  // the flip took effect
  await page.click('[data-act="seq-play"]');
  // timing: compact, with a cursor on the clock being shown
  const w = await page.evaluate(() => +document.querySelector("#simTiming svg").dataset.cw);
  expect(w).toBeLessThanOrEqual(24);
  await expect(page.locator("#simTiming .wv-now")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("sim-live.png") });
  expect(page.errors).toEqual([]);
});
