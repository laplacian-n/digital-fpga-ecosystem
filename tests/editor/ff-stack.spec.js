// Synchronous counters / dividers drawn like the lab sheet (50-ff-stack): flip-flops in one column,
// bit 0 at the bottom, each gate level with the pin it feeds — not one long row.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("clock divider and mod-N counter: FF column bit 0 at the bottom, gates to the left, no overlaps, still verified", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const out = {};
    for (const [kind, n] of [["clock_divider", 50], ["mod_counter", 10], ["clock_divider", 7]]) {
      const res = await MCP_OPS.build_part({ kind, n });
      const s = Object.values(state.project.schematics).find(x => x.name === res.sheet);
      const ffs = s.components.filter(c => c.type === "DFF");
      const bits = ffs.filter(c => /^ff\d+$/.test(c.id)).sort((a, b) => +a.id.slice(2) - +b.id.slice(2));
      const box = c => { const z = getSize(c); return [c.x, c.y, c.x + z.w, c.y + z.h]; };
      const C = s.components.filter(c => c.type !== "JUNCTION"); let ov = 0;
      for (let i = 0; i < C.length; i++) for (let j = i + 1; j < C.length; j++) { const a = box(C[i]), b = box(C[j]); if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) ov++; }
      const gates = s.components.filter(c => ["AND", "OR", "XOR", "NOT"].includes(c.type));
      const dead = gates.filter(g => !s.wires.some(w => w.from.cid === g.id)).length;
      out[kind + n] = { verified: !!s.verified, oneColumn: new Set(ffs.map(f => f.x)).size === 1,
        bottomUp: bits.every((f, i) => i === 0 || f.y < bits[i - 1].y),
        toggleOnTop: ffs.every(f => f.y >= Math.min(...ffs.map(x => x.y))) && (!ffs.find(f => f.id === "tq") || ffs.find(f => f.id === "tq").y === Math.min(...ffs.map(x => x.y))),
        gatesLeft: gates.every(g => g.x + getSize(g).w <= ffs[0].x), overlaps: ov, dead,
        body: wireBodyCrossings(s).length, pin: wirePinCrossings(s).length, locked: !!s.locked };
    }
    return out;
  });
  for (const [k, v] of Object.entries(r))
    expect(v, k).toEqual({ verified: true, oneColumn: true, bottomUp: true, toggleOnTop: true, gatesLeft: true, overlaps: 0, dead: 0, body: 0, pin: 0, locked: true });
  expect(page.errors).toEqual([]);
});

test("library counters (counter_digit with en/clr/tc, ripple binary counter) are drawn the same way", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const out = {};
    for (const [kind, params] of [["counter_digit", { m: 8 }], ["counter_digit", { m: 10, load: true }], ["counter_digit", { m: 10, down: true }],
      ["counter_digit", { m: 6, down: true, load: true }], ["binary_counter", { n: 4 }]]) {
      const res = await MCP_OPS.build_part({ kind, params });
      const s = Object.values(state.project.schematics).find(x => x.name === res.sheet);
      const ffs = s.components.filter(c => ["DFF", "TFF", "JKFF"].includes(c.type));
      const net = (cid, pid) => { const seen = new Set([cid + ":" + pid]), st = [cid + ":" + pid];
        while (st.length) { const k = st.pop(); s.wires.forEach(w => { const a = w.from.cid + ":" + w.from.pid, b = w.to.cid + ":" + w.to.pid;
          [[a, b], [b, a]].forEach(([x, y]) => { if (x === k && !seen.has(y)) { seen.add(y); st.push(y); } }); });
          const [c] = k.split(":"); if (s.components.find(z => z.id === c && z.type === "JUNCTION") && !seen.has(c + ":j")) { seen.add(c + ":j"); st.push(c + ":j"); } }
        return seen; };
      const ffOf = i => { const o = s.components.find(c => c.type === "OUT" && c.params.name === "q" + i); if (!o) return null;
        const n = net(o.id, "i"); return ffs.find(f => n.has(f.id + ":q")); };
      const order = ffs.map((_, i) => ffOf(i)).filter(Boolean);
      const box = c => { const z = getSize(c); return [c.x, c.y, c.x + z.w, c.y + z.h]; };
      const C = s.components.filter(c => c.type !== "JUNCTION"); let ov = 0;
      for (let i = 0; i < C.length; i++) for (let j = i + 1; j < C.length; j++) { const a = box(C[i]), b = box(C[j]); if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) ov++; }
      const tc = s.components.find(c => c.type === "OUT" && c.params.name === "tc");
      // no two parts' pins on one spot (a 4-input AND's i3 on the next gate's i0 shorted en to q0n)
      const at = new Map(); C.forEach(c => getPorts(c).forEach(p => { const q = portPos(c, p.id), k = q.x + "," + q.y; at.set(k, (at.get(k) || 0) + 1); }));
      ov += [...at.values()].filter(n => n > 1).length;
      out[kind + JSON.stringify(params)] = { verified: !!s.verified, oneColumn: new Set(ffs.map(f => f.x)).size === 1, all: order.length === ffs.length,
        bottomUp: order.every((f, i) => i === 0 || f.y < order[i - 1].y), overlaps: ov, locked: !!s.locked,
        tcRight: !tc || tc.x > ffs[0].x };
    }
    return out;
  });
  for (const [k, v] of Object.entries(r))
    expect(v, k).toEqual({ verified: true, oneColumn: true, all: true, bottomUp: true, overlaps: 0, locked: true, tcRight: true });
  expect(page.errors).toEqual([]);
});
