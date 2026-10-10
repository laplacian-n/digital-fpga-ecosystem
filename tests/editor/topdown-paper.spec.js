// Top-Down sheets redrawn for paper (53-topdown-paper): lab-sheet layout, buses regrouped, wires routed by
// the gate editor's own router — checked on what the Top-Down page actually renders.
const { test, expect } = require("@playwright/test");
const fs = require("fs"), path = require("path");
const { openEditor } = require("./helpers");

const CHECK = () => {
  const s = SH(), rt = computeRoutes(s), bad = [];
  const net = w => w.from.node + "." + w.from.pin;
  const bodies = s.nodes.filter(n => n.type === "block" || n.type === "gate").map(n => ({ n, x1: n.x + 3, y1: n.y + 3, x2: n.x + n.w - 3, y2: n.y + n.h - 3 }));
  // a block's name sits above it: nothing may run through it either
  const names = s.nodes.filter(n => n.type === "block").map(n => ({ n, x1: n.x, y1: n.y - 16, x2: n.x + String(n.label).length * 7, y2: n.y - 2 }));
  const segs = [];
  for (const w of s.wires) {
    const r = rt.get(w.id); if (!r) { bad.push("no route"); continue; }
    const a = endPoint(w.from), b = endPoint(w.to), p0 = r.pts[0], p1 = r.pts[r.pts.length - 1];
    if (Math.hypot(p0[0] - a.x, p0[1] - a.y) > 1 || Math.hypot(p1[0] - b.x, p1[1] - b.y) > 1) bad.push("loose end " + net(w));
    for (const p of r.parts) {
      segs.push({ w, p });
      for (const B of bodies.concat(names)) {
        const hit = p.t === "h" ? (p.y > B.y1 && p.y < B.y2 && Math.max(p.x1, p.x2) > B.x1 && Math.min(p.x1, p.x2) < B.x2)
                                : (p.x > B.x1 && p.x < B.x2 && Math.max(p.y1, p.y2) > B.y1 && Math.min(p.y1, p.y2) < B.y2);
        if (hit) bad.push("through " + (B.n.label || B.n.gate));
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
  // parts never overlap (with their names)
  let overlap = 0; const box = n => { const b = nodeBounds(n); return [b.x, b.y - (n.type === "block" ? 16 : 0), b.x + b.w, b.y + b.h]; };
  const P2 = s.nodes.filter(n => n.type === "block" || n.type === "gate");
  for (let i = 0; i < P2.length; i++) for (let j = i + 1; j < P2.length; j++) { const a = box(P2[i]), b = box(P2[j]); if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) overlap++; }
  const f = s.frame;
  const portsOut = s.nodes.filter(n => n.type === "port").every(n => n.side === "left" ? (n.x > f.x && n.x - 26 < f.x) : (n.x < f.x + f.w && n.x + 26 > f.x + f.w));
  return { title: s.title, bad: [...new Set(bad)], shared, overlap, portsOut, paper: !!s.paper, buses: s.nodes.filter(n => n.type === "port" && n.bus).map(n => n.name),
    bubbles: s.nodes.filter(n => n.type === "gate" && (n.invIn || []).some(Boolean)).length, dots: gJunctions(s, rt).length };
};

test("lab 6 sheets and library parts are drawn for paper: no wire through a part or a name, nets never share a run, ports outside the frame", async ({ page }) => {
  test.setTimeout(180000);
  await openEditor(page);
  const proj = fs.readFileSync(path.join(__dirname, "..", "fixtures", "lab6_digital_counter.schproj.json"), "utf-8");
  await page.evaluate(s => deserialize(s), proj);
  await page.evaluate(async () => {
    await MCP_OPS.build_part({ kind: "shift_register", params: { n: 4 }, sheet: "shift_reg4" });
    await MCP_OPS.build_part({ kind: "counter_digit", params: { m: 10, load: true }, sheet: "cdig" });
  });
  const frame = () => page.frames().find(fr => /topdown-schematic\.html/.test(fr.url()));
  const out = {};
  for (const nm of ["top", "counter", "mod10", "seg7dec", "display", "comparator", "shift_reg4", "cdig"]) {
    const ok = await page.evaluate(nm => { const s = Object.values(state.project.schematics).find(x => x.name === nm);
      const t = schematicToTopdownSheet(s); sendToTopdown({ type: "td:loadSheet", sheet: t }); return !!t.paper; }, nm);
    expect(ok, nm).toBe(true);
    await expect.poll(async () => { try { return await frame().evaluate(nm => SH() && SH().module === nm && SH().paper, nm); } catch (_) { return false; } }, { timeout: 8000 }).toBe(true);
    out[nm] = await frame().evaluate(`(${CHECK})()`);
  }
  for (const [nm, c] of Object.entries(out)) {
    expect(c.bad, nm).toEqual([]);
    expect(c.shared, nm).toBe(0);
    expect(c.overlap, nm).toBe(0);
    expect(c.portsOut, nm).toBe(true);
  }
  // numbered pins carrying the same bits became buses; a NOT before a gate became its bubble
  expect(out.top.buses).toEqual(expect.arrayContaining(["swt[3:0]", "swu[3:0]", "seg[a:g]"]));
  expect(out.counter.buses).toEqual(["units[3:0]", "tens[3:0]"]);
  expect(out.top.bubbles).toBeGreaterThan(0);
  expect(out.top.dots).toBeGreaterThan(2);
  // titled by depth under the top sheet, as the lab sheets are
  expect([out.top.title, out.counter.title]).toEqual(["1st Layer (top)", "2nd Layer (counter)"]);
  expect(page.errors.filter(e => !/Failed to load resource: net::/.test(e))).toEqual([]);
});
