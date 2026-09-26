// 3. New-user guidance: welcome, lab templates, stepper badges, tour
const { test, expect } = require("@playwright/test");
const { openEditor, drawSheet } = require("./helpers");

test("first run shows the welcome screen and a template maps its pins", async ({ page }) => {
  await openEditor(page, { keepWelcome: true });
  await expect(page.locator(".wl-big")).toHaveCount(3);
  await page.click("[data-go=labs]");
  await page.click("[data-tpl=hex7]");
  const s = await page.evaluate(() => ({ name: state.project.name, bits: uxPortBits().length, pm: activeSch().pinmap }));
  expect(s.name).toBe("lab4_1_hex7");
  expect(s.pm.a).toBe("seg:a");
  expect(s.pm.an0).toBe("an:0");
  const xdc = await page.evaluate(() => uxXdcBody());
  expect(xdc).toContain("PACKAGE_PIN L3");       // 7-seg a
  expect(xdc).toContain("PACKAGE_PIN H4");       // digit 0
});

test("stepper badges follow the work", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => startLabTemplate("gate2"));
  await drawSheet(page, [
    { k: "a", type: "IN", x: 88, y: 110, params: { name: "a" } }, { k: "b", type: "IN", x: 88, y: 198, params: { name: "b" } },
    { k: "g", type: "AND", x: 352, y: 132 }, { k: "y", type: "OUT", x: 660, y: 132, params: { name: "y" } },
  ], [["a", "o", "g", "in0"], ["b", "o", "g", "in1"], ["g", "o", "y", "i"]]);
  const badge = st => page.locator(`#pipeline .step[data-stage="${st}"] .st-b`);
  await expect(badge("draw")).toHaveText("✓");
  await expect(badge("sim")).toHaveText("•");
  await page.click(".step[data-stage=sim]");
  await page.click("[data-act=sim-close]");
  await expect(badge("sim")).toHaveText("✓");
});

test("tour walks five stops", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => startTour());
  for (let i = 0; i < 5; i++) await page.click("[data-t=next]");
  await expect(page.locator(".tour-ov")).toHaveCount(0);
});
