// 6. Pin page built from the entity ports (works on a top sheet with blocks and buses)
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("top sheet with buses lists every bit and writes a per-bit xdc", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    const s = activeSch(); s.components = []; s.wires = []; s.pinmap = {};
    const mk = (type, y, name, width) => s.components.push({ id: uid("c"), type, x: type === "IN" ? 88 : 700, y, label: "", params: { name, width: width || 1 } });
    mk("IN", 110, "clk"); mk("IN", 200, "sw", 8); mk("IN", 290, "rst"); mk("OUT", 110, "seg", 7); mk("OUT", 200, "an", 4); mk("OUT", 290, "led0");
    snapshot(); renderAll();
  });
  await page.click(".step[data-stage=pins]");
  await expect(page.locator(".pp-t tr[data-key]")).toHaveCount(22);
  const pm = await page.evaluate(() => activeSch().pinmap);
  expect(pm).toMatchObject({ clk: "clk", rst: "pb:4", "sw[0]": "sw:0", "seg[6]": "seg:a", "seg[0]": "seg:g", "an[3]": "an:3", led0: "led:0" });
  await page.selectOption('select[data-bus="sw"]', "sw:8");
  expect(await page.evaluate(() => activeSch().pinmap["sw[0]"])).toBe("sw:8");
  const xdc = await page.evaluate(() => uxXdcBody());
  expect(xdc).toContain("[get_ports {sw[0]}]");
  expect(xdc).toContain("create_clock -period 20.000");
  expect(page.errors).toEqual([]);
});

test("old files keyed by typed names still map (case-insensitive)", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { startLabTemplate("walk"); const s = activeSch(); s.pinmap = { P: "sw:9", Walk: "led:5" }; });
  const xdc = await page.evaluate(() => uxXdcBody());
  expect(xdc).toContain("## SW 9");
  expect(xdc).toContain("[get_ports p]\n");
  // XDC is Tcl: a `#` after a command is NOT a comment — it becomes arguments and the constraint is lost
  expect(xdc.split("\n").filter(l => /^\s*set_property/.test(l) && /#/.test(l))).toEqual([]);
});
