// "อยากได้สร้างวงจรแบบนี้ด้วย ระบุไปว่าจะให้นับเท่าไหร่": the lab's synchronous JK-FF divider.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("mod 10 gives the textbook equations and divides clk_in by 10", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => jkCounterIntent([0,1,2,3,4,5,6,7,8,9], { out: "clk_out" }));
  expect(r.error).toBeUndefined();
  expect(r.equations).toEqual(["J0=1 K0=1", "J1=Q0·Q3' K1=Q0", "J2=Q0·Q1 K2=Q0·Q1", "J3=Q0·Q1·Q2 K3=Q0"]);
  // J2 and K2 share one AND, one VCC for J0/K0 — as drawn in the lab
  expect(r.components.filter(c => c.type === "AND").length).toBe(3);
  expect(r.components.filter(c => c.type === "VCC").length).toBe(1);
  // draw it and run it: clk_out is high on counts 8 and 9 of every 10
  const sim = await page.evaluate(() => { const d = aiDrawIntent(Object.assign(jkCounterIntent([0,1,2,3,4,5,6,7,8,9], { out: "clk_out" }), { module: "div10" }));
    const s = d.sch, j = clientSeqSim(s, 20);
    const k = j.sequence ? j.sequence.outputs.indexOf("clk_out") : -1;
    return { ok: d.ok, jk: s.components.filter(c => c.type === "JKFF").length, rows: j.sequence ? j.sequence.rows.map(r => r[3][k]) : j,
             names: s.components.filter(c => c.type === "IN" || c.type === "OUT").map(c => c.params.name).sort().join(",") }; });
  expect(sim.ok).toBe(true);
  expect(sim.jk).toBe(4);
  expect(sim.names).toBe("clk_in,clk_out");
  expect(sim.rows.join("")).toBe("00000000110000000011");
});

test("any N works: every count checked, and the Tools menu has it", async ({ page }) => {
  await openEditor(page);
  const bad = await page.evaluate(() => { const out = [];
    for (let N = 2; N <= 40; N++) { const r = jkCounterIntent(Array.from({ length: N }, (_, i) => i), { outputs: "q" }); if (r.error) out.push(N + ":" + r.error); }
    return out; });
  expect(bad).toEqual([]);
  await expect(page.locator('#menu [data-gen="jkmod"]')).toHaveCount(1);
  // a mod-6 with q outputs counts 0..5 and wraps
  const seq = await page.evaluate(() => { const d = aiDrawIntent(Object.assign(jkCounterIntent([0,1,2,3,4,5], { outputs: "q" }), { module: "m6" }));
    const j = clientSeqSim(d.sch, 8), o = j.sequence.outputs; return j.sequence.rows.map(r => o.reduce((v, n, i) => v | (r[3][i] << +n.slice(1)), 0)); });
  expect(seq).toEqual([0, 1, 2, 3, 4, 5, 0, 1]);
});

test("laid out like the lab sheet: FF column MSB on top, clean wiring, still counts", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => { const r = jkCounterIntent([0,1,2,3,4,5,6,7,8,9], { out: "clk_out" });
    const d = aiDrawIntent(Object.assign(r, { module: "div10" })); jkLayout(d.sch, r.bits); const s = d.sch, by = id => s.components.find(c => c.id === id);
    const j = clientSeqSim(s, 10), k = j.sequence.outputs.indexOf("clk_out");
    return { xs: [0,1,2,3].map(i => by("ff" + i).x), ys: [0,1,2,3].map(i => by("ff" + i).y),
             bad: wireBodyCrossings(s).length + wirePinCrossings(s).length + netSelfOverlaps(s).length + netCollinearOverlaps(s).length,
             out: j.sequence.rows.map(x => x[3][k]).join("") }; });
  expect(new Set(r.xs).size).toBe(1);                                  // one column
  expect(r.ys[3]).toBeLessThan(r.ys[2]); expect(r.ys[2]).toBeLessThan(r.ys[1]); expect(r.ys[1]).toBeLessThan(r.ys[0]);   // MSB on top
  expect(r.bad).toBe(0);
  expect(r.out).toBe("0000000011");
});
