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
