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
