// "มันก็ต่อละนะ": a pin on a wire that is plainly connected was reported as "ปลายลอย"
// (and got '0' in the VHDL). Two ways a drawing gets there.
const { test, expect } = require("@playwright/test");
const { openEditor, drawSheet } = require("./helpers");

const floating = page => page.evaluate(() =>
  (runSynthesis() || []).filter(i => /ปลายลอย/.test(i.msg)).map(i => i.msg));

test("a free wire end dropped exactly on a dot joins that net", async ({ page }) => {
  await openEditor(page);
  await drawSheet(page, [
    { k: "x", type: "IN", x: 60, y: 200, params: { name: "x" } },
    { k: "g1", type: "AND", x: 320, y: 160 },
    { k: "g2", type: "AND", x: 320, y: 300 },
    { k: "y1", type: "OUT", x: 520, y: 160, params: { name: "y1" } },
    { k: "y2", type: "OUT", x: 520, y: 300, params: { name: "y2" } },
  ], [["x", "o", "g1", "in0"], ["x", "o", "g1", "in1"], ["g1", "o", "y1", "i"], ["g2", "o", "y2", "i"]]);
  const r = await page.evaluate(() => {
    const s = activeSch(); normalizePortFanout(s); healJunctions(s);
    const dot = s.components.find(c => c.type === "JUNCTION");
    const g2 = s.components.filter(c => c.type === "AND")[1];
    const ins = getPorts(g2).filter(p => p.dir === "in");
    // the user's drawing: a wire from g2's inputs that ends in mid-air, right on the dot
    const e = { id: uid("c"), type: "JUNCTION", x: dot.x, y: dot.y, params: { endpoint: true } };
    s.components.push(e);
    s.wires.push({ id: uid("w"), from: { cid: e.id, pid: "j" }, to: { cid: g2.id, pid: ins[0].id }, name: "" });
    const e2 = { id: uid("c"), type: "JUNCTION", x: dot.x, y: dot.y, params: { endpoint: true } };
    s.components.push(e2);
    s.wires.push({ id: uid("w"), from: { cid: e2.id, pid: "j" }, to: { cid: g2.id, pid: ins[1].id }, name: "" });
    const before = (runSynthesis() || []).filter(i => /ปลายลอย/.test(i.msg)).length;
    healJunctions(s);
    return { before, dots: s.components.filter(c => c.type === "JUNCTION").length,
             oneIn: s.wires.filter(w => w.to.cid === dot.id).length };
  });
  expect(r.before).toBe(2);           // the bug: looks joined, reads floating
  expect(r.dots).toBe(1);             // welded into the existing dot
  expect(r.oneIn).toBe(1);
  expect(await floating(page)).toEqual([]);
  const vhdl = await page.evaluate(() => Object.values(generateAllVhdl()).map(e => typeof e === "string" ? e : e.code).join("\n"));
  expect(vhdl).not.toMatch(/<=\s*'0'/);
});

test("a dot-to-dot wire drawn the other way still finds the driver", async ({ page }) => {
  await openEditor(page);
  await drawSheet(page, [
    { k: "x", type: "IN", x: 60, y: 200, params: { name: "x" } },
    { k: "g", type: "AND", x: 320, y: 200 },
    { k: "y", type: "OUT", x: 520, y: 200, params: { name: "y" } },
  ], [["g", "o", "y", "i"]]);
  await page.evaluate(() => {
    const s = activeSch();
    const x = s.components.find(c => c.type === "IN"), g = s.components.find(c => c.type === "AND");
    const ins = getPorts(g).filter(p => p.dir === "in");
    const J = { id: uid("c"), type: "JUNCTION", x: 200, y: 180, params: {} };
    const K = { id: uid("c"), type: "JUNCTION", x: 200, y: 240, params: {} };
    s.components.push(J, K);
    // x feeds K; J hangs off K through a wire pointing K <- J; the AND's inputs sit on J and K
    s.wires.push({ id: uid("w"), from: { cid: x.id, pid: "o" }, to: { cid: K.id, pid: "j" }, name: "" });
    s.wires.push({ id: uid("w"), from: { cid: J.id, pid: "j" }, to: { cid: K.id, pid: "j" }, name: "" });
    s.wires.push({ id: uid("w"), from: { cid: J.id, pid: "j" }, to: { cid: g.id, pid: ins[0].id }, name: "" });
    s.wires.push({ id: uid("w"), from: { cid: K.id, pid: "j" }, to: { cid: g.id, pid: ins[1].id }, name: "" });
  });
  // the check already sees through it
  expect(await floating(page)).toEqual([]);
  // and healing (on load, after every edit) turns the wire round, so the generator does too
  await page.evaluate(() => healJunctions(activeSch()));
  expect(await floating(page)).toEqual([]);
  const vhdl = await page.evaluate(() => Object.values(generateAllVhdl()).map(e => typeof e === "string" ? e : e.code).join("\n"));
  expect(vhdl).not.toMatch(/<=\s*'0'/);
  expect(vhdl).toMatch(/x\s+and\s+x/i);
});
