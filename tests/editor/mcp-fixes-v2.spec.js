// Found by Claude testing 2.0.0 over MCP: a spec on bus ports, probe across blocks,
// sequential simulate with per-clock vectors, delete_sheet.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("set_spec: a 4-bit addition on bus ports ({cout,s} = a + b + cin, a[3:0], s[0] = …)", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_part({ kind: "adder", n: 4, bus: true, sheet: "add4" });
    const t = f => { const x = MCP_OPS.set_spec({ formula: f }).result; return { pass: x.pass, n: x.total_mismatches, reason: x.reason }; };
    return { cat: t("{cout,s} = a + b + cin"), bus: t("s = a[3:0] + b[3:0] + cin"), bit: t("s[0] = a[0] ^ b[0] ^ cin"),
      wrong: t("{cout,s} = a + b"), missing: t("q = a + b"), bad: t("s = a > b"),
      stamped: sheetVerified(activeSch()) };
  });
  expect(r.cat).toMatchObject({ pass: true, n: 0 });
  expect(r.bus).toMatchObject({ pass: true, n: 0 });
  expect(r.bit).toMatchObject({ pass: true, n: 0 });
  expect(r.wrong.pass).toBe(false);
  expect(r.wrong.n).toBeGreaterThan(0);
  expect(r.missing.pass).toBe(false);
  expect(r.bad.reason).toContain("unexpected");
});

test("probe reads a block's outputs (the carry between two FA blocks), simulate takes per-clock vectors, delete_sheet", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_part({ kind: "full_adder", sheet: "FA" });
    await MCP_OPS.new_sheet({ name: "add2" });
    await MCP_OPS.apply({ steps: [..."a0 b0 a1 b1 cin".split(" ").map(n => ({ op: "add_component", type: "IN", name: n })),
      { op: "add_component", type: "block:FA", name: "FA0" }, { op: "add_component", type: "block:FA", name: "FA1" },
      ...["sum0", "sum1", "cout"].map(n => ({ op: "add_component", type: "OUT", name: n }))] });
    MCP_OPS.suggest_wires({ apply: true });
    const p = MCP_OPS.probe({ inputs: { a0: 1, b0: 1 } });
    const net = n => (p.nets.find(x => x.driver === n) || {}).value;
    MCP_OPS.build_fsm({ fsm: FSM_EXAMPLE, sheet: "det11" });
    const sim = MCP_OPS.simulate({ vectors: [1, 1, 1, 0, 1, 1, 0].map(x => ({ x })) });
    const zk = sim.columns.outputs.indexOf("z");
    let refused = null; try { MCP_OPS.delete_sheet({ sheet: "FA" }); } catch (e) { refused = e.message; }
    const del = MCP_OPS.delete_sheet({ sheet: "FA", force: true });
    const after = Object.values(state.project.schematics).map(s => s.name.toLowerCase());
    undo();
    return { carry: net("FA0.cout"), sum1: net("FA1.sum"), z: sim.rows.map(x => x.outputs[zk]).join(""), refused, del, after,
      back: Object.values(state.project.schematics).some(s => s.name.toLowerCase() === "fa") };
  });
  expect(r.carry).toBe(1);
  expect(r.sum1).toBe(1);
  expect(r.z).toBe("0011001");
  expect(r.refused).toContain("used as a block on add2");
  expect(r.del.block_instances_removed).toBe(2);
  expect(r.after).not.toContain("fa");
  expect(r.back).toBe(true);
});
