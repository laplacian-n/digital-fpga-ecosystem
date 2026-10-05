// Sequence detectors read from the request by code (48): the 4B model, trained twice, still got 0–1 of 10
// FSM requests — and every one was a detector the request fully describes.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

const SAID = [   // phrasings not written by gen_fsm.py
  ["ออกแบบวงจรตรวจจับ 1011 แบบมีลี่ ซ้อนทับได้ อินพุต x เอาต์พุต z", { pattern: "1011", mealy: true, overlap: true, x: "x", z: "z" }],
  ["Design a Moore sequence detector for 110, non-overlapping, input din, output found", { pattern: "110", mealy: false, overlap: false, x: "din", z: "found" }],
  ["ทำ FSM จับลำดับ 0110 จาก sin ให้ led เป็น 1 ลงแผ่น lab8", { pattern: "0110", mealy: false, overlap: true, x: "sin", z: "led", sheet: "lab8" }],
  ["detect 101 on input a, output y, mealy, overlap", { pattern: "101", mealy: true, overlap: true, x: "a", z: "y" }],
];
const NOT = ["ตัวนับ 0000 ถึง 1001", "Moore กับ Mealy ต่างกันยังไง", "y = a & b", "ทำแลป 7", "หารความถี่ 101 เท่า",
  "ตรวจจับ 101 หรือ 110 ก็ได้", "ลำดับ 1 2 3"];

test("the request → pattern / Moore-Mealy / overlap / names / sheet, for every generated phrasing and others", async ({ page }) => {
  await openEditor(page);
  const tasks = require(process.env.FSM_TASKS || "../fixtures/fsm_requests.json");
  const r = await page.evaluate(({ tasks, SAID, NOT }) => {
    const bad = [];
    tasks.forEach(t => { const d = sqdParse(t.message);
      const want = { pattern: t.pattern, mealy: t.kind === "mealy", overlap: t.overlap, x: t.x, z: t.z, sheet: t.sheet || null };
      const got = d && { pattern: d.pattern, mealy: d.mealy, overlap: d.overlap, x: d.x, z: d.z, sheet: d.sheet || null };
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push([t.message, got, want]); });
    SAID.forEach(([m, w]) => { const d = sqdParse(m); if (!d || Object.keys(w).some(k => d[k] !== w[k])) bad.push([m, d, w]); });
    NOT.forEach(m => { if (sqdParse(m)) bad.push([m, "should not parse"]); });
    return { n: tasks.length, bad };
  }, { tasks, SAID, NOT });
  expect(r.bad).toEqual([]);
  expect(r.n).toBeGreaterThan(50);
});

test("built through the agent's fast path with no model: matches an independent 64-clock stream, stamped verified", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const tasks = require("../fixtures/fsm_requests.json").filter((t, i) => i % 5 === 0).slice(0, 8);
  const r = await page.evaluate(async tasks => {
    // from disk there is no launcher (tool list / argument check): the tools are called directly
    aiagCall = async (tool, args) => { try { return { ok: true, result: await MCP_OPS[tool](args) }; } catch (e) { return { ok: false, error: e.message }; } };
    const out = [];
    for (const t of tasks) {
      const run = { steps: [] }, f = await aiagFastPath(t.message, run);
      const sch = Object.values(state.project.schematics).find(s => s.name === (t.sheet || "det_" + t.pattern));
      // the eval's own check (tools/dataset/run.js): a stream the build never saw
      const ins = sch.components.filter(c => c.type === "IN"), V = t.verify;
      const holdAt = i => { const o = {}; Object.entries(V.inputs[i]).forEach(([n, v]) => { o[ins.find(c => c.params.name.toLowerCase() === n.toLowerCase()).id] = v; }); return o; };
      const j = clientSeqSim(sch, V.inputs.length, { holdAt, hold: holdAt(0) }), k = j.sequence.outputs.findIndex(o => o.toLowerCase() === t.z.toLowerCase());
      const bad = V.expect[t.z].filter((w, i) => { const row = j.sequence.rows[i]; return (row[4] ? row[4][k] : row[3][k]) !== w; }).length;
      out.push({ m: t.message, final: !!(f && f.final), verified: !!sch.verified, bad, model: run.steps.some(s => s.kind === "model") });
    }
    return out;
  }, tasks);
  r.forEach(x => expect(x, x.m).toMatchObject({ final: true, verified: true, bad: 0, model: false }));
});
