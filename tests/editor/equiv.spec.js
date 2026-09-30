// compare_sheets: two sheets driven with the same inputs, outputs compared by name (combinational rows, or clock by clock).
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("equivalence: a student's full adder vs the part, a wrong carry found, counters clock by clock", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    MCP_OPS.build_part({ kind: "full_adder", sheet: "ref" });
    await MCP_OPS.build_circuit({ name: "stu", formula: "sum = a^b^cin; cout = a&b | cin&(a^b)" });
    await MCP_OPS.build_circuit({ name: "bad", formula: "sum = a^b^cin; cout = a&b" });
    await MCP_OPS.build_circuit({ name: "other", formula: "sum = a^b; cout = a&b" });
    const same = MCP_OPS.compare_sheets({ sheet: "stu", with: "ref" });
    const diff = MCP_OPS.compare_sheets({ sheet: "bad", with: "ref" });
    const ports = MCP_OPS.compare_sheets({ sheet: "other", with: "ref" });
    const part = MCP_OPS.compare_sheets({ sheet: "bad", part: "full_adder" });
    const formula = MCP_OPS.compare_sheets({ sheet: "stu", formula: "{cout,sum} = a + b + cin" });
    // sequential: two mod-6 counters (library vs generator) agree; a mod-5 does not
    MCP_OPS.build_part({ kind: "mod_counter", n: 6, sheet: "c6" });
    await MCP_OPS.build_circuit({ name: "g6", generator: { kind: "mod_counter", n: 6 } });
    MCP_OPS.build_part({ kind: "mod_counter", n: 5, sheet: "c5" });
    const seq = MCP_OPS.compare_sheets({ sheet: "c6", with: "g6" }), seqBad = MCP_OPS.compare_sheets({ sheet: "c6", with: "c5" });
    return { same, diff, ports, part, formula, seq, seqBad };
  });
  expect(r.same.equivalent, JSON.stringify(r.same)).toBe(true);
  expect(r.same.method).toMatch(/8 แถว/);
  expect(r.diff.equivalent).toBe(false);
  expect(r.diff.differences[0].output).toBe("cout");
  expect(r.ports.equivalent).toBe(false);
  expect(r.ports.port_differences.join()).toMatch(/cin/);
  expect(r.part.equivalent).toBe(false);
  expect(r.formula.equivalent).toBe(true);
  expect(r.seq.equivalent, JSON.stringify(r.seq)).toBe(true);
  expect(r.seq.method).toMatch(/clock/);
  expect(r.seqBad.equivalent).toBe(false);
});
