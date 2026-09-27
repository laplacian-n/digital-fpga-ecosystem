// "ปรับปรุง sim หน่อย มันใช้จริงในสถานการณ์ที่ clk ซับซ้อนไม่ได้เลย" — lab 6 divides 50 MHz down
// through a ripple chain; the real-time engine runs the board clock itself.
const { test, expect } = require("@playwright/test");
const fs = require("fs"), path = require("path");
const { openEditor } = require("./helpers");
const LAB6 = fs.readFileSync(path.join(__dirname, "..", "fixtures", "lab6_digital_counter.schproj.json"), "utf-8");

test("the real-time engine gives exactly the stepped simulator's outputs, clock by clock (lab 6)", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(j => { deserialize(j); const top = state.project.schematics[state.project.topId];
    const N = 2000, btnId = top.components.find(c => c.type === "IN" && c.params.name === "btn").id, press = i => i >= 5 && i < 60 ? 1 : 0;
    const js = clientSeqSim(top, N, { holdAt: i => ({ [btnId]: press(i) }) }), outs = js.sequence.outputs;
    const s = rtCompile(top), btn = s.ins.find(x => x.name === "btn");
    let diff = 0;
    for (let i = 0; i < N; i++) { s.setIn(btn, press(i));
      if (outs.map(n => s.out(s.outs.find(o => o.name === n)) ? 1 : 0).join("") !== js.sequence.rows[i][3].join("")) diff++;
      s.run(1); }
    const t0 = performance.now(); s.run(100000); const mps = 100000 / (performance.now() - t0) / 1000;
    return { diff, clk: s.clk && s.clk.name, mps };
  }, LAB6);
  expect(r.clk).toBe("clk");
  expect(r.diff).toBe(0);
  expect(r.mps).toBeGreaterThan(0.3);                          // millions of clocks per second (CI machines are slow)
});

test("the ripple divider chain (clkdiv): same internal states as the stepped simulator", async ({ page }) => {
  test.setTimeout(180000);
  await openEditor(page);
  const r = await page.evaluate(j => { deserialize(j); const sch = Object.values(state.project.schematics).find(s => s.name === "clkdiv");
    const N = 3000, js = clientSeqSim(sch, N), s = rtCompile(sch);
    // internal flip-flops, in the stepped simulator's order (same flattening)
    const fs = flattenSchematic(sch).sch, ids = fs.components.filter(c => PROBE_SEQ[c.type]).map(c => c.id);
    const byId = new Map(s.ffs.map(f => [f.c.id, f]));
    let diff = 0, changes = 0, prev = "";
    for (let i = 0; i < N; i++) { const got = ids.map(id => byId.get(id).st).join(""), want = js.sequence.rows[i][2].join("");
      if (got !== want) diff++; if (got !== prev) changes++; prev = got; s.run(1); }
    return { diff, changes, ffs: ids.length };
  }, LAB6);
  expect(r.ffs).toBeGreaterThan(30);
  expect(r.changes).toBeGreaterThan(2500);                     // the chain really runs
  expect(r.diff).toBe(0);
});

test("a JK-FF mod-10 divider: clk_out rises once every 10 board clocks", async ({ page }) => {
  await openEditor(page);
  const edges = await page.evaluate(() => { const r = jkCounterIntent([0,1,2,3,4,5,6,7,8,9], { out: "clk_out", clk: "clk" });
    const d = aiDrawIntent(Object.assign(r, { module: "div10" })); const s = rtCompile(d.sch), o = s.outs[0];
    let prev = s.out(o), n = 0; for (let i = 0; i < 10000; i++) { s.run(1); const v = s.out(o); if (v && !prev) n++; prev = v; } return n; });
  expect(edges).toBe(1000);
});

test("⚡ on the sim page: runs the 50 MHz clock, buttons and bus switches act live", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1500, height: 900 });
  await openEditor(page);
  await page.evaluate(j => { deserialize(j); openSchTab(state.project.topId); renderAll(); document.querySelectorAll(".modal-bg").forEach(m => m.remove()); }, LAB6);
  await page.evaluate(() => showSimPage("signals"));
  await expect(page.locator('[data-act="rt-toggle"]')).toBeVisible({ timeout: 20000 });
  await expect(page.locator("#simSignals")).not.toContainText("รองรับ 1 บิตเท่านั้น");   // backend-only warnings are gone
  await page.selectOption("#rtSpeed", "1");
  await page.click('[data-act="rt-toggle"]');
  await expect(page.locator("#simValbar")).toContainText("เวลาจริง");
  await expect.poll(() => page.evaluate(() => RT.cyc), { timeout: 10000 }).toBeGreaterThan(100000);
  // the centre button is btn (pb:4): held while the mouse is down
  const btn = () => page.evaluate(() => { const i = RT.sim.ins.find(x => x.name === "btn"); return RT.sim.val[i.net]; });
  const centre = page.locator("#simPcb .pbtn").nth(2);
  await centre.hover(); await page.mouse.down();
  await expect.poll(btn).toBe(1);
  await page.mouse.up();
  await expect.poll(btn).toBe(0);
  // a bus bit: swt[1] lives on its own switch
  const swtBit1 = await page.evaluate(() => +pmGet(activeSch().pinmap, "swt[1]").slice(3));
  await page.locator(`#simPcb .swUnit[data-sw="${swtBit1}"]`).click();
  await expect.poll(() => page.evaluate(() => { const i = RT.sim.ins.find(x => x.name === "swt"); return RT.sim.val[i.net]; })).toBe(2);
  // the display shows something (persistence: lit segments on some digit)
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll("#simPcb .seg")].filter(e => /rgba\(0, 0, 0/.test(e.style.background)).length)).toBeGreaterThan(1);
  await page.click('[data-act="rt-toggle"]');
  expect(await page.evaluate(() => RT.on)).toBe(false);
  expect(page.errors).toEqual([]);
});
