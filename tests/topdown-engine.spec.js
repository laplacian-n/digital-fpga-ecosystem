// Top-Down layout + router (topdown/td-engine.js) on the two reference sheets from the
// owner's hand drawings: 2nd Layer (RandomDice) and 5th Layer (Mod20m).
const { test, expect } = require("@playwright/test");
const path = require("path");
const { pathToFileURL } = require("url");
const TOPDOWN = pathToFileURL(path.join(__dirname, "..", "topdown", "topdown-schematic.html")).href;

const BUILD = () => {
  const W = (a, ap, b, bp, bus) => ({ id: uid(), from: { node: a.id, pin: ap }, to: { node: b.id, pin: bp }, bus: bus || 0 });
  const out = [];
  { const s = newSheet("2nd Layer (RandomDice)", "RandomDice");
    const and = mkGate(0, 0, "and", 2); and.invIn = [false, true];
    const cnt = mkBlock(0, 0, "Counter0_99", [{ name: "CLK", inv: true }], ["D0[3:0]", "D1[3:0]"]);
    const dsp = mkBlock(0, 0, "Display", ["D0[3:0]", "D1[3:0]", { name: "CLK", inv: true }], ["Segment[a:g]", "Common[3:0]"]);
    const cmp = mkBlock(0, 0, "Compare", ["D0[3:0]", "D1[3:0]", "Button", { name: "CLK", inv: true }], ["Buzzer"]);
    const btn = mkPort(0, 0, "Button", "left"), clk = mkPort(0, 0, "CLK", "left");
    const seg = mkPort(0, 0, "Segment[a:g]", "right"), com = mkPort(0, 0, "Common[3:0]", "right"), buz = mkPort(0, 0, "Buzzer", "right");
    s.nodes = [btn, clk, and, cnt, dsp, cmp, seg, com, buz];
    s.wires = [W(btn, "p", and, "in0"), W(cmp, "R0", and, "in1"), W(and, "out", cnt, "L0"),
      W(cnt, "R0", dsp, "L0", 4), W(cnt, "R1", dsp, "L1", 4), W(cnt, "R0", cmp, "L0", 4), W(cnt, "R1", cmp, "L1", 4),
      W(clk, "p", dsp, "L2"), W(clk, "p", cmp, "L3"), W(btn, "p", cmp, "L2"),
      W(dsp, "R0", seg, "p", 7), W(dsp, "R1", com, "p", 4), W(cmp, "R0", buz, "p")];
    out.push(s); }
  { const s = newSheet("5th Layer (Mod20m)", "Mod20m");
    const clk = mkPort(0, 0, "CLK", "left"), clr = mkPort(0, 0, "CLR", "left"), q = mkPort(0, 0, "Q", "right");
    const m = []; for (let i = 0; i < 7; i++) m.push(mkBlock(0, 0, "Mod10", [{ name: "CLK", inv: true }, "CLR"], ["Q"]));
    const jk = mkBlock(0, 0, "JK_FLIP_FLOP_CLR", ["J", "K", { name: "CLK", inv: true }, "CLR"], ["Q"]);
    const one = mkConst(0, 0, "'1'");
    s.nodes = [clk, clr, ...m, jk, one, q];
    s.wires = [W(clk, "p", m[0], "L0")];
    for (let i = 0; i < 6; i++) s.wires.push(W(m[i], "R0", m[i + 1], "L0"));
    s.wires.push(W(m[6], "R0", jk, "L2"), W(one, "p", jk, "L0"), W(one, "p", jk, "L1"), W(jk, "R0", q, "p"));
    [...m, jk].forEach(b => s.wires.push(W(clr, "p", b, b === jk ? "L3" : "L1")));
    out.push(s); }
  P.sheets = out; P.active = 0;
};

// the invariants a drawing has to keep, measured on what the page actually renders
const CHECK = () => {
  const s = SH(), rt = computeRoutes(s), bad = [];
  const net = w => w.from.node + "." + w.from.pin;
  const bodies = s.nodes.filter(n => n.type === "block" || n.type === "gate" || n.type === "mux")
    .map(n => ({ n, x1: n.x + 3, y1: n.y + 3, x2: n.x + n.w - 3, y2: n.y + n.h - 3 }));
  const segs = [];
  for (const w of s.wires) {
    const r = rt.get(w.id); if (!r) { bad.push("no route " + w.id); continue; }
    for (const p of r.parts) {
      segs.push({ w, p });
      for (const b of bodies) {
        const hit = p.t === "h" ? (p.y > b.y1 && p.y < b.y2 && Math.max(p.x1, p.x2) > b.x1 && Math.min(p.x1, p.x2) < b.x2)
                                : (p.x > b.x1 && p.x < b.x2 && Math.max(p.y1, p.y2) > b.y1 && Math.min(p.y1, p.y2) < b.y2);
        if (hit) bad.push("through " + (b.n.label || b.n.gate));
      }
    }
  }
  let shared = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const a = segs[i], b = segs[j]; if (net(a.w) === net(b.w) || a.p.t !== b.p.t) continue;
    const ov = a.p.t === "h"
      ? Math.abs(a.p.y - b.p.y) < 1 && Math.min(Math.max(a.p.x1, a.p.x2), Math.max(b.p.x1, b.p.x2)) - Math.max(Math.min(a.p.x1, a.p.x2), Math.min(b.p.x1, b.p.x2)) > 2
      : Math.abs(a.p.x - b.p.x) < 1 && Math.min(Math.max(a.p.y1, a.p.y2), Math.max(b.p.y1, b.p.y2)) - Math.max(Math.min(a.p.y1, a.p.y2), Math.min(b.p.y1, b.p.y2)) > 2;
    if (ov) shared++;
  }
  const f = s.frame;
  const ports = s.nodes.filter(n => n.type === "port").map(n => ({ side: n.side, x: n.x, left: n.x - f.x, right: f.x + f.w - n.x }));
  return { bad, shared, ports, dots: gJunctions(s, rt).length,
           straight: s.wires.filter(w => (rt.get(w.id) || { parts: [] }).parts.length === 1).length };
};

test("RandomDice and Mod20m lay out like the hand-drawn sheets", async ({ page }) => {
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(TOPDOWN);
  await page.waitForFunction(() => window.TDE && typeof newSheet === "function");
  await page.evaluate(BUILD);
  for (const [i, want] of [[0, { bands: 1 }], [1, { bands: 2 }]]) {
    const r = await page.evaluate(i => { P.active = i; const s = SH(); fixSheetDefaults(s); return TDE.layout(s); }, i);
    expect(r.relaxed).toBe(0);                              // every net found a legal route
    expect(r.bands).toBe(want.bands);                       // Mod20m wraps: 4 blocks, then 3 + the JK-FF
    const c = await page.evaluate(`(${CHECK})()`);
    expect(c.bad).toEqual([]);                              // nothing runs through a part
    expect(c.shared).toBe(0);                               // two nets never share a run
    for (const p of c.ports) expect(p.side === "right" ? p.right : p.left).toBeLessThanOrEqual(12);  // ports sit on the frame
    expect(c.dots).toBeGreaterThan(i ? 6 : 2);              // fan-out drawn as trees with junction dots
    if (i === 1) expect(c.straight).toBeGreaterThanOrEqual(7);   // CLK → Mod10 → … chain runs straight along each row
    await page.evaluate(() => { fitPageScale(true); fitView(); render(); });
    await page.locator("#cv").screenshot({ path: test.info().outputPath(`sheet-${i}.png`) });
  }
  // moving a part re-routes the sheet as a whole — still clean
  await page.evaluate(() => { const s = SH(); const b = s.nodes.find(n => n.label === "JK_FLIP_FLOP_CLR"); b.y += 40; TDE.route(s); });
  const c = await page.evaluate(`(${CHECK})()`);
  expect(c.bad).toEqual([]);
  expect(errors).toEqual([]);
});
