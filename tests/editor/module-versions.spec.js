// Module versions: saving over a module bumps it, placed copies see they are old and update in place; where_used; parts via use_module.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("a module changed in the library updates the copies placed in the project", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ name: "maj", formula: "y = a&b | a&c | b&c" });
    MCP_OPS.verify_truth_table({ sheet: "maj", formula: "y = a&b | a&c | b&c | a&b&c" });
    const s1 = MCP_OPS.save_module({ sheet: "maj", name: "vote", force: true });
    MCP_OPS.new_sheet({ name: "top" });
    MCP_OPS.use_module({ module: "vote", sheet: "top", name: "V1" });
    // the module changes: now "y = a" (a different circuit), saved over it
    await MCP_OPS.build_circuit({ name: "maj2", formula: "y = a & b & c" });
    const s2 = MCP_OPS.save_module({ sheet: "maj2", name: "vote", replace: true, force: true });
    const lst = MCP_OPS.list_modules({}).modules.find(m => m.name === "vote");
    const wu = MCP_OPS.where_used({ module: "vote" });
    const up = MCP_OPS.update_module({ module: "vote" });
    const copy = Object.values(state.project.schematics).find(s => s.moduleId && s.moduleId === s2.id);
    const tt = clientCombSim(copy).truth_table.rows.map(x => x[1][0]).join("");
    const again = MCP_OPS.update_module({ module: "vote" });
    // a library part through use_module
    const part = MCP_OPS.use_module({ module: "bcd_valid", sheet: "top", name: "BV" });
    return { v1: s1.saved, v2: lst.version, outdated: lst.outdated_copies, wu: wu.copies, up, tt, again: again.updated.length, part };
  });
  expect(r.v2).toBe(2);
  expect(r.outdated).toBe(1);
  expect(r.wu[0].placed_in).toEqual(["top"]);
  expect(r.wu[0].outdated).toBe(true);
  expect(r.up.updated.length).toBe(1);
  expect(r.up.updated[0].to).toBe(2);
  expect(r.tt).toBe("00000001");
  expect(r.again).toBe(0);
  expect(r.part.part).toBe("bcd_valid");
  expect(r.part.verified).toBe(true);
});
