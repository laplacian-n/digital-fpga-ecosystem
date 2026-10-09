// From testing the fine-tuned 4B on lab 7: check_spec with no spec read as "pass undefined", sw0..sw15
// could not be probed as one number, and "พร้อมลงบอร์ด" came without board_check.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("check_spec with no spec says so; probe takes sw0..sw3 as one number; a board claim gets the doctor's verdict", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ formula: "err = sw3 & (sw2 | sw1)", inputs: ["sw3", "sw2", "sw1", "sw0"], sheet: "t1" });
    const cs = MCP_OPS.check_spec({ sheet: "t1" });
    const all = MCP_OPS.check_spec({ all_sheets: true });
    const p = v => MCP_OPS.probe({ sheet: "t1", inputs: { sw: v } }).outputs.err;
    let bad = null; try { MCP_OPS.probe({ sheet: "t1", inputs: { sw: "lots" } }); } catch (e) { bad = e.message; }
    const run = { final: "เสร็จแล้ว พร้อมลงบอร์ด", steps: [] };
    const v1 = aiagVerdict(run);
    run.steps.push({ tool: "board_check", ok: true });
    const v2 = aiagVerdict(run);
    return { cs, all, sum: aiagSummary("check_spec", cs), p12: p(12), p10: p("0xA"), p8: p("1000"), p1: p(1), bad, v1, v2,
      direct: MCP_OPS.probe({ sheet: "t1", inputs: { sw3: 1, sw2: 1 } }).outputs.err };
  });
  expect(r.cs).toMatchObject({ spec: null, pass: null, checked: false });
  expect(r.cs.note).toContain("probe");
  expect(r.all).toMatchObject({ pass: null, checked: false });
  expect(r.sum).toContain("NO SPEC");
  expect([r.p12, r.p10, r.p8, r.p1, r.direct]).toEqual([1, 1, 0, 0, 1]);
  expect(r.bad).toContain("one number");
  expect(r.v1).toContain("🩺");
  expect(r.v1).toContain("ยังไม่พร้อม");          // no pins on t1
  expect(r.v2).not.toContain("🩺");
});

test("a fine-tuned model runs the way it was trained: no thinking, lower temperature; ai_chat options override", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const as = st => { aiagModelStatus = async () => st; };
    as({ model: "C:/m/qwen3.5-4B-SFT1.gguf", catalog: [{ path: "C:/m/qwen3.5-4B-SFT1.gguf", trained: true }] });
    const sft = await aiagProfile({}), over = await aiagProfile({ think: true, temperature: 0.7 });
    as({ model: "/m/Qwen3.5-4B-Q6_K.gguf", catalog: [{ path: "/m/Qwen3.5-4B-Q6_K.gguf" }] });
    const base = await aiagProfile({});
    as(null); const none = await aiagProfile({});
    return { sft, over, base, none };
  });
  expect(r.sft).toMatchObject({ think: false, temperature: 0.3, trained: true });
  expect(r.over).toMatchObject({ think: true, temperature: 0.7 });
  expect(r.base.think).toBeUndefined();
  expect(r.none).toEqual({});
});

test("div50 session: build_hierarchy takes an existing sheet named as a part and keeps a used sheet's ports; delete takes refs as JSON text", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_part({ kind: "clock_divider", n: 5, sheet: "div5" });
    await MCP_OPS.build_part({ kind: "clock_divider", n: 10, sheet: "div10" });
    await MCP_OPS.build_part({ kind: "clock_divider", n: 50, sheet: "div50" });
    // a parent that places div50 as a block (like clkgen)
    await MCP_OPS.build_hierarchy({ sheet: "clkgen", blocks: [{ name: "d", sheet: "div50" }], inputs: ["clk"], outputs: ["slow"],
      connect: [["clk", "d.clk_in"], ["d.clk_out", "slow"]] });
    const plan = { sheet: "div50", replace: true, inputs: ["clk_in"], outputs: ["clk_out"],
      blocks: [{ name: "d5", part: "sheet:div5" }, { name: "d10", part: "div10" }],
      connect: [["clk_in", "d5.clk_in"], ["d5.clk_out", "d10.clk_in"], ["d10.clk_out", "clk_out"]] };
    const ok = await MCP_OPS.build_hierarchy(plan);
    let bad = null; try { await MCP_OPS.build_hierarchy(Object.assign({}, plan, { outputs: ["q"], connect: [["clk_in", "d5.clk_in"], ["d5.clk_out", "d10.clk_in"], ["d10.clk_out", "q"]] })); } catch (e) { bad = e.message; }
    const S = n => Object.values(state.project.schematics).find(s => s.name === n);
    // clock clk through clkgen: ÷50, 50 % duty
    const g = S("clkgen"), j = clientSeqSim(g, 200), k = j.sequence.outputs.indexOf("slow");
    const seq = j.sequence.rows.map(r => (r[4] ? r[4][k] : r[3][k])).join("");
    const edges = [...seq.matchAll(/01/g)].map(m => m.index);
    MCP_OPS.add_component({ sheet: "div10", type: "AND" }); const and = S("div10").components.find(c => c.type === "AND" && !S("div10").wires.some(w => w.to.cid === c.id || w.from.cid === c.id));
    const del = MCP_OPS.delete({ sheet: "div10", refs: JSON.stringify([and.id]) });
    return { blocks: ok.blocks.map(b => b.sheet), bad, period: edges.length > 2 ? edges[2] - edges[1] : null,
      ports: schPortList(S("div50")).map(p => p.id).sort(), deleted: !S("div10").components.some(c => c.id === and.id), del: !!del };
  });
  expect(r.blocks).toEqual(["div5", "div10"]);
  expect(r.bad).toContain("used as a block in clkgen");
  expect(r.ports).toEqual(["clk_in", "clk_out"]);
  expect(r.period).toBe(50);
  expect(r.deleted).toBe(true);
});

test("agent helpers: text tool calls, change requests, two goals, no-work guard", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    AIAG.tools = [{ function: { name: "build_hierarchy" } }, { function: { name: "delete" } }];
    const a = aiagTextCalls('<tool_call>\n{"name": "delete", "arguments": {"refs": ["ff0"]}}\n</tool_call>', "");
    const b = aiagTextCalls("", "plan: <tool_call>\n<function=build_hierarchy>\n<parameter=sheet>\ndiv50\n</parameter>\n<parameter=replace>\ntrue\n</parameter>\n</function>\n</tool_call>");
    const c = aiagTextCalls("<tool_call>{\"name\":\"rm_rf\",\"arguments\":{}}</tool_call>", "");
    return { a: a.map(x => [x.function.name, JSON.parse(x.function.arguments)]), b: b.map(x => [x.function.name, JSON.parse(x.function.arguments)]), c: c.length,
      w1: aiagWantsChange("อ้าว ก็บอกตั้งแต่แรกแล้ว เอาเลยจัดไป ลบของเดิมในแผ่น div50 ทิ้ง"), w2: aiagWantsChange("JK กับ D ต่างกันยังไง"),
      m1: aiagMultiGoal("ทำแผ่น div5 กับแผ่น div10 แยกไว้ แล้วให้แผ่น div50 เอา div5 มาต่อกับ div10 แทนของเดิม"), m2: aiagMultiGoal("สร้าง full adder ลงแผ่น fa"),
      g1: aiagNoWorkGuard({}, "สร้างใหม่แล้ว ตรวจผ่าน", false, true), g2: aiagNoWorkGuard({}, "สร้างแล้ว", true, true) };
  });
  expect(r.a).toEqual([["delete", { refs: ["ff0"] }]]);
  expect(r.b).toEqual([["build_hierarchy", { sheet: "div50", replace: true }]]);
  expect(r.c).toBe(0);
  expect([r.w1, r.w2, r.m1, r.m2]).toEqual([true, false, true, false]);
  expect(r.g1.startsWith("⚠")).toBe(true);
  expect(r.g2).toBe("สร้างแล้ว");
});
