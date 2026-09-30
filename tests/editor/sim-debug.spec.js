// Simulation you can debug with: ports as numbers, a text waveform, and probe inside a block.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("simulate gives numbers per port and a waveform; probe sees the nets inside a block", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    MCP_OPS.build_part({ kind: "adder", n: 4, bus: true, sheet: "ad" });
    const full = MCP_OPS.simulate({ sheet: "ad" });
    const vec = MCP_OPS.simulate({ sheet: "ad", vectors: [{ a: 5, b: 3, cin: 1 }] });
    MCP_OPS.build_part({ kind: "mod_counter", n: 6, sheet: "c6" });
    const seq = MCP_OPS.simulate({ sheet: "c6", cycles: 8 });
    // a wrong wire inside a block: the adder's bit 1 carry
    MCP_OPS.build_part({ kind: "adder", n: 4, sheet: "ad2" });
    await MCP_OPS.build_hierarchy({ sheet: "h", inputs: ["a[3:0]", "b[3:0]"], outputs: ["s[3:0]"], blocks: [{ name: "u", sheet: "ad2" }],
      connect: [["a", "u.a"], ["b", "u.b"], ["0", "u.cin"], ["u.s", "s"]] });
    const inside = MCP_OPS.probe({ sheet: "h", inside: "u", inputs: { a: 5, b: 3 } });
    let bad; try { MCP_OPS.probe({ sheet: "h", inside: "nope" }); } catch (e) { bad = e.message; }
    return { t0: full.table && full.table[0], t: full.table && full.table.find(x => x.a === 5 && x.b === 3 && x.cin === 1), vec: vec.rows[0].values,
      seq: seq.values.map(v => v.q), wave: seq.waveform, inside, bad };
  });
  expect(r.t, JSON.stringify(r.t0)).toEqual({ a: 5, b: 3, cin: 1, s: 9, cout: 0 });
  expect(r.vec.s).toBe(9);
  expect(r.seq).toEqual([0, 1, 2, 3, 4, 5, 0, 1]);
  expect(r.wave.join("\n")).toMatch(/q\s+│\s+0\s+1\s+2\s+3\s+4\s+5\s+0\s+1/);
  expect(r.inside.inner_sheet).toBe("ad2");
  const port = n => r.inside.ports.find(p => p.name === n).value;
  expect([port("a0"), port("a1"), port("a2"), port("b0"), port("b1"), port("s3")]).toEqual([1, 0, 1, 1, 1, 1]);
  expect(r.inside.nets.every(n => n.value !== "unknown"), JSON.stringify(r.inside.nets.filter(n => n.value === "unknown"))).toBe(true);
  expect(r.bad).toMatch(/no block 'nope'/);
});
