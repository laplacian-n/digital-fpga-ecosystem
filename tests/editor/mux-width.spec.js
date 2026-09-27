// "MUX ปรับความกว้างบิตได้แต่ mcp ไม่รู้": the MUX was 1-bit only. Now it has a width, like the
// gates: every data pin and y carry that many bits, and everything downstream agrees.
const { test, expect } = require("@playwright/test");
const { openEditor, drawSheet } = require("./helpers");

test("a 4-bit 2:1 MUX: pins, check, VHDL, simulation, and the component list Claude reads", async ({ page }) => {
  await openEditor(page);
  await drawSheet(page, [
    { k: "a", type: "IN", x: 88, y: 88, params: { name: "a", width: 4 } },
    { k: "b", type: "IN", x: 88, y: 198, params: { name: "b", width: 4 } },
    { k: "s", type: "IN", x: 88, y: 308, params: { name: "s" } },
    { k: "m", type: "MUX", x: 330, y: 132, params: { inputs: 2, width: 4 } },
    { k: "y", type: "OUT", x: 600, y: 176, params: { name: "y", width: 4 } },
  ], [["a", "o", "m", "d0"], ["b", "o", "m", "d1"], ["s", "o", "m", "s0"], ["m", "y", "y", "i"]]);
  const r = await page.evaluate(() => {
    const s = activeSch(), m = s.components.find(c => c.type === "MUX");
    const errs = (runSynthesis() || []).filter(i => i.lvl === "err").map(i => i.msg);
    const vhdl = Object.values(generateAllVhdl()).map(e => typeof e === "string" ? e : e.code).join("\n");
    const sim = clientCombSim(s);
    const ty = MCP_OPS.list_component_types().find(t => t.type === "MUX");
    return { widths: getPorts(m).map(p => p.id + ":" + (p.width || 1)).join(" "), errs, vhdl, sim, ty };
  });
  expect(r.widths).toBe("d0:4 d1:4 s0:1 y:4");
  expect(r.errs).toEqual([]);
  expect(r.vhdl).toMatch(/y\s*:\s*out\s+STD_LOGIC_VECTOR\(3 downto 0\)/);
  expect(r.vhdl).toContain("else (others => '0')");
  expect(r.sim.ok).toBe(true);
  // s = 1 picks b: find the row a=0101, b=1100, s=1 → y=1100
  const T = r.sim.truth_table, idx = n => T.inputs.indexOf(n);
  const row = T.rows.find(([b]) => b.slice(idx("a[3]"), idx("a[3]") + 4).join("") === "0101"
                                 && b.slice(idx("b[3]"), idx("b[3]") + 4).join("") === "1100" && b[idx("s")] === 1);
  expect(row[1].join("")).toBe("1100");
  // Claude sees the setting and its range
  expect(r.ty.params.width).toBe(1);
  expect(r.ty.param_help.join(" ")).toMatch(/width: .*\(1\.\.32\)/);
  expect(page.errors).toEqual([]);
});
