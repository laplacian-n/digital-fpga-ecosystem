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
