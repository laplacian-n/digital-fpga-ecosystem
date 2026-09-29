// From testing the in-app AI: rows-that-are-1 tables, spec before the sheet exists, rebuild in place,
// a table in `formula`, a circular check that is not a pass, and build mode using the part library.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("a prime detector by its rows; spec first on a sheet that does not exist yet; replace instead of prime3_2", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const out = {};
    const px = ["x2", "x1", "x0"];
    // the spec, written from the request, before there is a sheet
    const sp = MCP_OPS.set_spec({ sheet: "prime3", table: { inputs: px, ones: { p: [2, 3, 5, 7] } } });
    out.note = sp.note;
    // the model's mistyped column: built, and the spec catches it at once
    const bad = await MCP_OPS.build_circuit({ sheet: "prime3", truth_table: { inputs: px, outputs: ["p"], columns: { p: "00110111" } } });
    out.bad = bad.spec_check;
    let refused = null; try { await MCP_OPS.build_circuit({ sheet: "prime3", truth_table: { inputs: px, ones: { p: [2, 3, 5, 7] } } }); } catch (e) { refused = e.message; }
    out.refused = refused;
    const good = await MCP_OPS.build_circuit({ sheet: "prime3", replace: true, truth_table: { inputs: px, ones: { p: [2, 3, 5, 7] } } });
    out.good = good.spec_check;
    out.col = clientCombSim(mcpSheet("prime3")).truth_table.rows.map(x => x[1][0]).join("");
    out.sheets = Object.values(state.project.schematics).map(s => s.name).filter(n => /^prime3/.test(n));
    // a check against what it was built from is not a pass
    const v = MCP_OPS.verify_truth_table({ sheet: "prime3", expected: { ones: { p: [2, 3, 5, 7] } } });
    out.circ = [v.pass, v.independent];
    // and a spec that IS the build table proves nothing either
    await MCP_OPS.build_circuit({ sheet: "maj", truth_table: { inputs: ["a", "b", "c"], ones: { y: [3, 5, 6, 7] } } });
    out.sameSpec = MCP_OPS.set_spec({ sheet: "maj", table: { ones: { y: [3, 5, 6, 7] } } }).result.independent;
    // a truth table handed over as `formula`
    const f = await MCP_OPS.build_circuit({ sheet: "xo", formula: { inputs: ["a", "b"], outputs: ["y"], columns: { y: "0110" } } });
    out.xo = clientCombSim(mcpSheet(f.sheet)).truth_table.rows.map(x => x[1][0]).join("");
    let e2 = null; try { MCP_OPS.check_spec({ sheet: "nope" }); } catch (e) { e2 = e.hint; }
    out.hint = e2;
    return out;
  });
  expect(r.note).toContain("made empty");
  expect(r.bad.pass).toBe(false);
  expect(r.bad.total_mismatches).toBe(1);                  // row 6 is not prime
  expect(r.refused).toContain("already has parts");
  expect(r.good.pass).toBe(true);
  expect(r.col).toBe("00110101");
  expect(r.sheets).toEqual(["prime3"]);
  expect(r.circ).toEqual([null, false]);
  expect(r.sameSpec).toBe(false);
  expect(r.xo).toBe("0110");
  expect(r.hint).toContain("build_circuit");
});

test("build mode: 'full adder' comes from the part library, no model call", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { AICHAT.mode = "build"; if (!AICHAT.open) toggleAiChat(); });
  await page.fill("#acInput", "full adder");
  await page.evaluate(() => aiSend());
  await expect(page.locator("#acLog")).toContainText("คลังชิ้นส่วน");
  await expect(page.locator("#acLog")).toContainText("ตรวจเทียบโมเดลอ้างอิงแล้ว");
  expect(await page.evaluate(() => sheetVerified(activeSch()))).toBe(true);
  expect(page.errors).toEqual([]);
});
