// The board doctor repairs what it finds (active-high 7-seg, no digit enabled, unmapped pins); lab pin presets.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("board_check fix: NOT before a–g, an0 = 0 on digit 0, pins guessed — and the result equals the active-low part", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    MCP_OPS.build_part({ kind: "bcd_7seg", active_low: false, sheet: "s7" });
    const before = MCP_OPS.board_check({ sheet: "s7" });
    const fix = MCP_OPS.board_check({ sheet: "s7", fix: true });
    const after = MCP_OPS.board_check({ sheet: "s7" });
    const eq = MCP_OPS.compare_sheets({ sheet: "s7", part: "bcd_7seg", params: { active_low: true } });
    MCP_OPS.undo();
    const undone = MCP_OPS.board_check({ sheet: "s7" });
    // lab 6 roles → the lab's switches, button and LED
    await MCP_OPS.build_circuit({ name: "l6", formula: "err = yy_tens3 & (yy_tens2 | yy_tens1) | yy_ones3 & (yy_ones2 | yy_ones1) | btn & 0",
      inputs: ["yy_tens3", "yy_tens2", "yy_tens1", "yy_tens0", "yy_ones3", "yy_ones2", "yy_ones1", "yy_ones0", "btn"] });
    const pre = MCP_OPS.pin_preset({ sheet: "l6", lab: "6" });
    const pm = Object.values(state.project.schematics).find(s => s.name === "l6").pinmap;
    return { before: before.fixable.map(f => f.fix).sort(), fixed: fix.fixed, after: after.findings.map(f => f.title), eq: eq.equivalent, eqWhy: eq,
      undone: undone.fixable.map(f => f.fix).sort(), pre, pm };
  });
  expect(r.before).toEqual(expect.arrayContaining(["pins"]));
  expect(r.fixed.length).toBeGreaterThan(0);
  expect(r.after.some(t => /active-high/.test(t))).toBe(false);
  expect(r.after.some(t => /ขาเลือกหลัก/.test(t))).toBe(false);
  expect(r.eq, JSON.stringify(r.eqWhy)).toBe(true);
  expect(r.pm.yy_tens3).toBe("sw:7");
  expect(r.pm.yy_ones0).toBe("sw:0");
  expect(r.pm.btn).toBe("pb:4");
  expect(r.pm.err).toBe("led:0");
  expect(r.pre.not_placed).toEqual([]);
});
