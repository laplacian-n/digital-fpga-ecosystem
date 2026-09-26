// "จัดต่อก็วุ่นวาย … จะลบลากใหม่ก็จำไม่ได้ว่าอันไหนต่ออันไหน": tidy redraws the PATHS from the
// connection list — every connection survives, parts stay put, the result is clean.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

/* a 3-bit counter-ish sheet placed by hand (no auto-place), wired pin to pin */
async function messySheet(page){
  await page.evaluate(() => {
    const s = activeSch(); s.components = []; s.wires = []; const id = {};
    const put = (k, type, x, y, params) => { const c = { id: uid("c"), type, x, y, label: "",
      params: Object.assign(JSON.parse(JSON.stringify((TYPES[type] && TYPES[type].defaultParams) || {})), params || {}) };
      s.components.push(c); id[k] = c; };
    put("clk", "IN", 44, 330, { name: "clk" }); put("en", "IN", 44, 110, { name: "en" });
    put("f0", "JKFF", 264, 88); put("f1", "JKFF", 264, 286); put("f2", "JKFF", 264, 484);
    put("a1", "AND", 506, 198); put("a2", "AND", 506, 396);
    put("q0", "OUT", 726, 88, { name: "q0" }); put("q1", "OUT", 726, 286, { name: "q1" }); put("q2", "OUT", 726, 484, { name: "q2" });
    const W = (a, ap, b, bp) => s.wires.push({ id: uid("w"), from: { cid: id[a].id, pid: ap }, to: { cid: id[b].id, pid: bp }, name: "" });
    ["f0", "f1", "f2"].forEach(f => W("clk", "o", f, "clk"));
    W("en", "o", "f0", "j"); W("en", "o", "f0", "k"); W("en", "o", "a1", "i0");
    W("f0", "q", "a1", "i1"); W("a1", "o", "f1", "j"); W("a1", "o", "f1", "k"); W("a1", "o", "a2", "i0");
    W("f1", "q", "a2", "i1"); W("a2", "o", "f2", "j"); W("a2", "o", "f2", "k");
    W("f0", "q", "q0", "i"); W("f1", "q", "q1", "i"); W("f2", "q", "q2", "i");
    normalizePortFanout(s); healJunctions(s); snapshot(); renderAll();
  });
}
const signature = page => page.evaluate(() => {
  const s = activeSch(), seen = new Set(), nets = [];
  s.wires.forEach(w => { if (seen.has(w.id)) return; const ids = netWires(s, w); ids.forEach(i => seen.add(i));
    const t = new Set(); ids.forEach(i => { const x = s.wires.find(y => y.id === i);
      [x.from, x.to].forEach(e => { const c = comp(e.cid, s); if (c && c.type !== "JUNCTION") t.add((c.params.name || c.type + "@" + c.x + "," + c.y) + "." + e.pid); }); });
    nets.push([...t].sort().join(" ")); });
  return nets.sort();
});
const problems = page => page.evaluate(() => { const s = activeSch(); return {
  body: wireBodyCrossings(s).length, pin: wirePinCrossings(s).length,
  self: netSelfOverlaps(s).length, coll: netCollinearOverlaps(s).length, cross: netCrossings(s).length }; });

test("tidy keeps every connection and every part, and comes out clean", async ({ page }) => {
  await openEditor(page);
  await messySheet(page);
  const before = await signature(page);
  const where = await page.evaluate(() => activeSch().components.filter(c => c.type !== "JUNCTION").map(c => c.x + "," + c.y).join(" "));
  const r = await page.evaluate(() => wtTidySheet(activeSch()));
  console.log("tidy", JSON.stringify(r), JSON.stringify(await problems(page)));
  expect(await signature(page)).toEqual(before);
  expect(await page.evaluate(() => activeSch().components.filter(c => c.type !== "JUNCTION").map(c => c.x + "," + c.y).join(" "))).toBe(where);
  expect(r.plain).toBe(0);
  const p = await problems(page);
  expect(p.body + p.pin + p.self + p.coll).toBe(0);
  expect(page.errors).toEqual([]);
});

test("moving a part re-routes only its own branches; other wires stay exactly", async ({ page }) => {
  await openEditor(page);
  await messySheet(page);
  await page.evaluate(() => wtTidySheet(activeSch()));
  const before = await signature(page);
  const r = await page.evaluate(() => {
    const s = activeSch();
    const q2 = s.components.find(c => c.type === "OUT" && c.params.name === "q2");
    const pic = () => new Map(s.wires.map(w => [w.id, polyKey(drawnPoints(s, w))]));
    const touching = new Set(netWires(s, s.wires.find(w => w.to.cid === q2.id)));
    const was = pic();
    q2.y += 66;                                           // drag it down three grid squares
    wtAfterMove(s, [q2]);
    const now = pic();
    let changedOther = 0;
    was.forEach((k, id) => { if (!touching.has(id) && now.has(id) && now.get(id) !== k) changedOther++; });
    return { changedOther, missing: [...was.keys()].filter(id => !touching.has(id) && !now.has(id)).length };
  });
  expect(r.changedOther).toBe(0);
  expect(await signature(page)).toEqual(before);
  const p = await problems(page);
  expect(p.body + p.pin + p.self + p.coll).toBe(0);
});

test("🧲 placement mode: coloured straight lines per net, drag parts by eye, then จัดสายให้", async ({ page }) => {
  await openEditor(page);
  await messySheet(page);
  const before = await signature(page);
  await page.click("#btnRatsnest");
  await expect(page.locator("#wtRatsBar")).toBeVisible();
  await expect(page.locator("#canvas")).toHaveClass(/wt-rats/);
  const lines = await page.locator(".wt-rats-layer line").count();
  expect(lines).toBeGreaterThan(8);
  await expect(page.locator("#wtRatsInfo")).toContainText("เน็ต");
  // drag q2 somewhere else with the mouse: nothing is re-routed while placing
  const q2 = page.locator('.node[data-cid]').filter({ hasText: "q2" }).first();
  const bb = await q2.boundingBox();
  const wiresBefore = await page.evaluate(() => JSON.stringify(activeSch().wires.map(w => [w.id, w.pts || null])));
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2 - 60, bb.y + bb.height / 2 + 120, { steps: 6 });
  await page.mouse.up();
  expect(await page.evaluate(() => JSON.stringify(activeSch().wires.map(w => [w.id, w.pts || null])))).toBe(wiresBefore);
  await page.screenshot({ path: "/tmp/claude-0/-home-user-digital-fpga-ecosystem/64563043-28d0-56af-bf6c-155361dce1e5/scratchpad/rats.png" });
  await page.click("#wtRatsGo");
  await expect(page.locator("#wtRatsBar")).toBeHidden();
  await expect(page.locator("#canvas")).not.toHaveClass(/wt-rats/);
  expect(await signature(page)).toEqual(before);
  const p = await problems(page);
  expect(p.body + p.pin + p.self + p.coll).toBe(0);
  await page.screenshot({ path: "/tmp/claude-0/-home-user-digital-fpga-ecosystem/64563043-28d0-56af-bf6c-155361dce1e5/scratchpad/rats-done.png" });
  expect(page.errors).toEqual([]);
});

test("pointing at a wire says what the net joins; debug panel offers a fix", async ({ page }) => {
  await openEditor(page);
  await messySheet(page);
  const html = await page.evaluate(() => { const s = activeSch(); const clk = s.components.find(c => c.params && c.params.name === "clk");
    return wtNetHtml(s.wires.find(w => w.from.cid === clk.id).id); });
  expect(html).toContain("ต่อ 4 ขา");
  expect(html).toContain("INPUT 'clk'");
  expect(html).toContain("CLK");
  await page.click("#btnDebugOverlay");
  await expect(page.locator("#dbgFixAll")).toBeVisible();
  await page.click("#dbgFixAll");
  const p = await problems(page);
  expect(p.body + p.pin + p.self + p.coll).toBe(0);
});
