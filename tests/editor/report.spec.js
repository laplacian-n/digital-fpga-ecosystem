// Tools ▸ ทำรายงานแลป: a report made from the project — pictures, tables, equations, pins, VHDL.
const { test, expect } = require("@playwright/test");
const fs = require("fs"), path = require("path");
const { openEditor } = require("./helpers");
const LAB6 = fs.readFileSync(path.join(__dirname, "..", "fixtures", "lab6_digital_counter.schproj.json"), "utf-8");

test("the lab report covers every sheet, top first, with pictures and tables", async ({ page, context }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(j => { deserialize(j); MCP_OPS.build_part({ kind: "full_adder", sheet: "fa" });
    const html = reportHtml({}); return { html, sheets: reportSheets().map(s => s.name), top: state.project.schematics[state.project.topId].name }; }, LAB6);
  expect(r.sheets[0]).toBe(r.top);
  expect(r.sheets).toContain("fa");
  const view = await context.newPage();
  await view.setContent(r.html);
  await expect(view.locator("section")).toHaveCount(r.sheets.length + 1);          // + VHDL
  await expect(view.locator("section h2").first()).toContainText("(top)");
  expect(await view.locator("section .pic svg").count()).toBe(r.sheets.length);
  const fa = view.locator("section", { hasText: "fa" }).filter({ hasText: "Full Adder" });
  await expect(fa).toContainText("ตารางความจริง");
  await expect(view.locator("pre").last()).toContainText("entity");
  await view.screenshot({ path: test.info().outputPath("report.png"), fullPage: false });
  await view.locator("section").nth(1).screenshot({ path: test.info().outputPath("report-sec.png") });
  expect(page.errors).toEqual([]);
});
