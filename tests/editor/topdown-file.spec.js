// A Top-Down project (.json with {meta, sheets}) opened in Schematic Studio goes to the Top-Down
// view — it used to fail with "โหลดไม่สำเร็จ: Invalid file".
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

const TD = { meta: { projectName: "Lab 6 - Digital Counter" }, sheets: [
  { title: "1st Layer (Digital Counter System)", module: "Digital Counter System", frame: { x: 80, y: 80, w: 900, h: 500 },
    nodes: [ { id: "CLK", type: "port", x: 120, y: 140, name: "CLK", side: "left" },
             { id: "CNT", type: "block", x: 300, y: 120, label: "Counter Unit", pinsL: ["clk"], pinsR: ["Q[3:0]"], pinsB: [], pinsT: [] },
             { id: "Q", type: "port", x: 700, y: 148, name: "Q[3:0]", side: "right", bus: 4 } ],
    wires: [ { from: { node: "CLK", pin: "p" }, to: { node: "CNT", pin: "L0" }, bus: 0 },
             { from: { node: "CNT", pin: "R0" }, to: { node: "Q", pin: "p" }, bus: 4 } ] },
  { title: "2nd Layer (Counter Unit)", module: "Counter Unit", frame: { x: 80, y: 80, w: 600, h: 400 }, nodes: [], wires: [] } ] };

test("a Top-Down project opened here lands in the Top-Down view, added to what is there", async ({ page }) => {
  await openEditor(page);
  const before = await page.evaluate(() => JSON.stringify(state.project.schematics));
  await page.evaluate(t => deserialize(JSON.stringify(t)), TD);
  await expect(page.locator("#topdownView")).toBeVisible();
  const frame = () => page.frames().find(fr => /topdown-schematic\.html/.test(fr.url()));
  // the iframe may still be loading: keep asking until its project has the sheets
  await expect.poll(async () => { try { return await frame().evaluate(() => P.sheets.map(s => s.title).join("|")); } catch (_) { return ""; } }, { timeout: 8000 })
    .toContain("1st Layer (Digital Counter System)|2nd Layer (Counter Unit)");
  const f = frame();
  expect(await f.evaluate(() => SH().title)).toBe("1st Layer (Digital Counter System)");   // opened on its first sheet
  expect(await f.evaluate(() => P.sheets.length)).toBeGreaterThan(2);                        // the seed sheets are still there
  expect(await f.evaluate(() => SH().wires.every(w => w.id))).toBe(true);
  // the gate editor's own project is untouched, and no error toast
  expect(await page.evaluate(() => JSON.stringify(state.project.schematics))).toBe(before);
  await expect(page.locator(".toast", { hasText: "Invalid file" })).toHaveCount(0);
  // a real Schematic Studio file still opens as before
  const own = await page.evaluate(() => serialize());
  await page.evaluate(s => deserialize(s), own);
  // (the Top-Down page fetches its font library from a CDN; offline / behind a proxy that fails — not ours)
  expect(page.errors.filter(e => !/Failed to load resource: net::/.test(e))).toEqual([]);
});
