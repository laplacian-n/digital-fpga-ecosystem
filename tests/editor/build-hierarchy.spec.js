// build_hierarchy: a top sheet from a block list + connections by name, in one call and one undo step.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("a 4-bit ripple adder from four full-adder parts: buses by name, checked, errors leave nothing behind", async ({ page }) => {
  test.setTimeout(180000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const plan = { sheet: "add4", inputs: ["a[3:0]", "b[3:0]", "cin"], outputs: ["s[3:0]", "cout"],
      blocks: [0, 1, 2, 3].map(i => ({ name: "fa" + i, part: "full_adder" })),
      connect: [["cin", "fa0.cin"], ["fa3.cout", "cout"]] };
    for (let i = 0; i < 4; i++) { plan.connect.push(["a[" + i + "]", "fa" + i + ".a"], ["b[" + i + "]", "fa" + i + ".b"], ["fa" + i + ".sum", "s[" + i + "]"]);
      if (i) plan.connect.push(["fa" + (i - 1) + ".cout", "fa" + i + ".cin"]); }
    const res = await MCP_OPS.build_hierarchy(plan);
    const spec = MCP_OPS.set_spec({ sheet: "add4", formula: "{cout,s} = a + b + cin" });
    const sheets0 = Object.keys(state.project.schematics).length;
    const err = async p => { try { await MCP_OPS.build_hierarchy(p); return "no error"; } catch (e) { return e.message; } };
    const e1 = await err({ sheet: "x1", inputs: ["a[3:0]"], blocks: [{ name: "u", part: "full_adder" }], connect: [["a", "u.a"]] });
    const e2 = await err({ sheet: "x2", inputs: ["p", "q"], blocks: [{ name: "u", part: "full_adder" }], connect: [["p", "u.a"], ["q", "u.a"]] });
    const e3 = await err({ sheet: "x3", inputs: ["p"], blocks: [{ name: "u", part: "full_adder" }], connect: [["p", "u.nope"]] });
    const e4 = await err({ sheet: "x4", inputs: ["p"], blocks: [{ name: "u", part: "decoder", params: { n: 99 } }], connect: [] });
    const afterErrors = Object.keys(state.project.schematics).length;
    // same-named pins join by themselves: clk to both blocks, the one 'pulse' output to OUTPUT pulse
    const auto = await MCP_OPS.build_hierarchy({ sheet: "btn_top", inputs: ["clk", "btn"], outputs: ["pulse"],
      blocks: [{ name: "db", part: "debounce" }, { name: "ed", part: "edge_detector" }], connect: [["btn", "db.x"], ["db.y", "ed.x"]] });
    const top = Object.values(state.project.schematics).find(s => s.name === "add4");
    return { res, pass: spec.result.pass, sheets0, after: afterErrors,
      busPorts: top.components.filter(c => c.type === "IN" || c.type === "OUT").map(c => c.params.name + ":" + (c.params.width || 1)).sort(),
      labels: top.components.filter(c => c.label).map(c => c.label).sort(), e1, e2, e3, e4, auto };
  });
  expect(r.res.unconnected_block_inputs).toEqual([]);
  expect(r.res.undriven_outputs).toEqual([]);
  expect(r.res.check.errors).toBe(0);
  expect(r.pass).toBe(true);
  expect(r.busPorts).toEqual(["a:4", "b:4", "cin:1", "cout:1", "s:4"]);
  expect(r.labels).toEqual(["fa0", "fa1", "fa2", "fa3"]);
  expect(r.e1).toMatch(/4 bit.*1/);
  expect(r.e2).toMatch(/driven twice/);
  expect(r.e3).toMatch(/no pin 'nope'.*|its pins/);
  expect(r.e4).toMatch(/block u/);
  expect(r.after).toBe(r.sheets0);             // the failed calls left no sheet behind
  expect(r.auto.auto_connected.sort()).toEqual(["clk → db.clk", "clk → ed.clk", "ed.pulse → pulse"]);
  expect(r.auto.unconnected_block_inputs).toEqual([]);
});
