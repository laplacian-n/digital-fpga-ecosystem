// "ฝากทำพอร์ตแบบ bus ในตัวสร้างวงจร": q0..q3 of a generated sheet become one bus port q[3:0].
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("Tools ▸ รวมขาเป็นบัส: the placement stays, the taps sit where the ports were, the count is unchanged", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    const it = fsmCounterIntent([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); it.module = "m10";
    const dr = aiDrawIntent(it), s = dr.sch;
    const ffAt = s.components.filter(c => c.type === "DFF").map(c => c.x + "," + c.y).join(" ");
    const pinAt = s.components.filter(c => c.type === "OUT").map(c => { const p = portPos(c, "i"); return p.x + "," + p.y; }).sort().join(" ");
    return { ffAt, pinAt };
  });
  await page.click("#menu >> text=Tools").catch(() => {});
  await page.evaluate(() => runGenerator("busports"));
  const a = await page.evaluate(() => { const s = activeSch();
    const taps = s.components.filter(c => c.type === "BUSTAP").map(c => { const p = portPos(c, "y"); return p.x + "," + p.y; }).sort().join(" ");
    const sq = clientSeqSim(s, 11).sequence;
    return { ffAt: s.components.filter(c => c.type === "DFF").map(c => c.x + "," + c.y).join(" "), taps,
      ports: schPortList(s).map(p => p.id + ":" + p.width), counts: sq.rows.map(x => x[4][0]),
      issues: uxQuietIssues().filter(i => i.schId === s.id && i.lvl === "err").length, undo: state.history.idx > 0 }; });
  expect(a.ffAt).toBe(r.ffAt);                       // nothing the generator placed moved
  expect(a.taps).toBe(r.pinAt);                      // each tap's bit pin is where q0..q3's pin was
  expect(a.ports).toEqual(["clk:1", "q:4"]);
  expect(a.counts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0]);
  expect(a.issues).toBe(0);
  expect(await page.locator('#menu [data-gen="busports"]').count()).toBe(1);
  expect(page.errors).toEqual([]);
});
