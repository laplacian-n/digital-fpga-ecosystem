// A whole lab as a part: lab 6's counter 00-yy is assembled from verified blocks by code, its glue
// checked clock by clock on a small divider, the EDGE pins mapped — and "ทำแลป 6" in the chat builds it.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("lab 6 system: built, verified on a small divider, pins mapped, no check sheets left", async ({ page }) => {
  test.setTimeout(300000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const t0 = performance.now();
    const res = MCP_OPS.build_part({ kind: "lab6_counter" });
    const ms = Math.round(performance.now() - t0);
    const s = Object.values(state.project.schematics).find(x => x.name === res.sheet);
    const blocks = [...new Set(s.components.filter(c => c.type.startsWith("SCH:")).map(c => state.project.schematics[c.type.slice(4)].name))];
    const chk = MCP_OPS.check({ sheet: res.sheet });
    return { ms, sheet: res.sheet, method: res.verified.method, blocks, pinmap: s.pinmap, errors: chk.errors,
      names: Object.values(state.project.schematics).map(x => x.name) };
  });
  console.log("lab6_counter built in", r.ms, "ms:", r.method, r.blocks.join(", "));
  expect(r.method).toMatch(/tick=4/);
  expect(r.blocks.join()).toMatch(/bcd_counter_multi/);
  expect(r.blocks.join()).toMatch(/seg7_mux4/);
  expect(r.errors).toBe(0);
  expect(r.pinmap.btn).toBe("pb:4");
  expect(r.pinmap.yy_tens3).toBe("sw:7");
  expect(r.pinmap.an1).toBe("an:1");
  expect(r.names.filter(n => /__chk|clock_divider_n[24]$/.test(n))).toEqual([]);
});

test("chat routing: 'ทำแลป 6' is the lab 6 part; a question about an idea is not this sheet's diagnosis", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const k = m => (partFromMessage(m) || {}).kind || null;
    // a sheet with parts is open (the diagnosis used to answer every "ทำไม…นับ" question about it)
    MCP_OPS.build_part({ kind: "mod_counter", n: 6 });
    const asked = [], diag = [];
    const _ask = aiAsk; aiAsk = async m => { asked.push(m); };
    const _app = aiAppend; aiAppend = (who, h, o) => { if (/ตรวจแผ่นนี้/.test(String(h))) diag.push(h); return _app(who, h, o); };
    AICHAT.mode = "qa";
    for (const q of ["ทำไมตัวนับต้องมีตัวหารความถี่?", "JK กับ D flip-flop เลือกตัวไหนทำตัวนับ", "ทำไมตัวนับของผมไม่นับ"]) {
      $("#acInput").value = q; await aiSend(); }
    aiAsk = _ask; aiAppend = _app;
    return { lab: [k("ทำแลป 6 ให้หน่อย"), k("ต่อ Lab 6 ให้จบ"), k("digital counter 00-yy"), k("แลป 6 ใช้ความถี่นับเท่าไร?"), k("lab 60")],
      asked, diag: diag.length };
  });
  expect(r.lab).toEqual(["lab6_counter", "lab6_counter", "lab6_counter", null, null]);
  expect(r.asked).toEqual(["ทำไมตัวนับต้องมีตัวหารความถี่?", "JK กับ D flip-flop เลือกตัวไหนทำตัวนับ"]);
  expect(r.diag).toBe(1);
});
