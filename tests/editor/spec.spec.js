// Acceptance tests: the user says what a sheet must do, the sheet shows ✓ / ✗ after every change.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("a formula spec from the Inspector: ✓ on a right circuit, ✗ right after it is broken", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { MCP_OPS.build_part({ kind: "full_adder", sheet: "fa" }); state.selection.clear(); renderAll(); });
  await page.click("#specEdit");
  await page.fill("#spF", "{cout,sum} = a + b + cin");
  await page.click("#spSave");
  await expect(page.locator(".spec-s")).toContainText("✓ ผ่าน");
  await expect(page.locator('#projectPane .tree-item.sch.active .spec-b')).toHaveText("✓");
  // break it: an XOR becomes an OR — the badge turns red by itself
  await page.evaluate(() => { const s = activeSch(); s.components.find(c => c.type === "XOR").type = "OR"; snapshot(); renderAll(); });
  await expect(page.locator('#projectPane .tree-item.sch.active .spec-b')).toHaveText("✗", { timeout: 5000 });
  const v = await page.evaluate(() => ({ verified: sheetVerified(activeSch()), r: specCheck(activeSch()) }));
  expect(v.verified).toBe(false);
  expect(v.r.pass).toBe(false);
  expect(v.r.total_mismatches).toBeGreaterThan(0);
  await page.evaluate(() => undo());
  await expect(page.locator('#projectPane .tree-item.sch.active .spec-b')).toHaveText("✓", { timeout: 5000 });
  expect(page.errors).toEqual([]);
});

test("a clock-by-clock spec (MCP set_spec); 'use what it does now' freezes a hand-drawn sheet's behaviour", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    MCP_OPS.build_part({ kind: "mod_counter", n: 6, bus: true, sheet: "cnt6" });
    const ok = MCP_OPS.set_spec({ sheet: "cnt6", sequence: { expect: { q: [0, 1, 2, 3, 4, 5, 0, 1] } } });
    const bad = MCP_OPS.set_spec({ sheet: "cnt6", sequence: { expect: { q: [0, 1, 2, 3, 4, 5, 6, 7] } } });
    const all = MCP_OPS.check_spec({ all_sheets: true });
    return { ok: ok.result.pass, bad: bad.result.pass, first: bad.result.mismatches[0], all: all.pass };
  });
  expect(r.ok).toBe(true);
  expect(r.bad).toBe(false);
  expect(r.first).toMatchObject({ output: "q", cycle: 6, want: 6, got: 0 });
  expect(r.all).toBe(false);
  // a hand-drawn sheet: freeze what it does now, then saving it as a module is allowed (verified by its spec)
  await page.evaluate(() => { openSchTab(state.project.topId); state.selection.clear(); renderAll(); });
  await page.click("#specEdit");
  await page.click("#spNow");
  await expect(page.locator("#spT")).toHaveValue(/=/);
  await page.click("#spSave");
  await expect(page.locator(".spec-s")).toContainText("✓");
  const saved = await page.evaluate(() => { try { return MCP_OPS.save_module({ name: "top_frozen" }).verified; } catch (e) { return "ERR " + e.message; } });
  expect(saved).toContain("spec");
  expect(page.errors).toEqual([]);
});
