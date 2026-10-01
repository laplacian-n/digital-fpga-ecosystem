// What the 4B model got almost right in the baseline eval is read as meant (47-agent-robust.js).
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("near-misses from the baseline eval are taken as meant; real errors read as text", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const out = {};
    const err = async f => { try { await f(); return "ok"; } catch (e) { return e.message + (e.hint ? " | " + e.hint : ""); } };
    // the FSM as a JSON string, conditions a=1 / a=0
    const fsmObj = { inputs: ["s"], outputs: ["hit"], states: [{ name: "S0", out: { hit: 0 } }, { name: "S1", out: { hit: 1 } }],
      transitions: [{ from: "S0", to: "S1", when: "s=1" }, { from: "S0", to: "S0", when: "s=0" }, { from: "S1", to: "S1", when: "s==1" }, { from: "S1", to: "S0", when: "else" }], reset: "S0" };
    out.fsmJson = await err(() => MCP_OPS.build_fsm({ sheet: "f1", fsm: JSON.stringify(fsmObj) }));
    out.fsmText = await err(() => MCP_OPS.build_fsm({ sheet: "f2", fsm: "inputs: a\noutputs: z\nstate S0: z=0\nstate S1: z=1\nS0 -> S1 when a=1\nS0 -> S0 when a=0\nS1 -> S0 when a=0 / z=1\nS1 -> S1 else\nreset S0" }));
    // intent types in lower case
    out.intent = await err(() => MCP_OPS.build_circuit({ sheet: "i1", intent: { module: "i1", components: [{ id: "a", type: "input" }, { id: "b", type: "Input" }, { id: "g", type: "and" }, { id: "y", type: "OUTPUT" }],
      nets: [{ from: "a", to: "g" }, { from: "b", to: "g" }, { from: "g", to: "y" }] } }));
    // a broken intent says what is wrong
    out.broken = await err(() => MCP_OPS.build_circuit({ sheet: "i2", intent: { module: "i2", components: [{ id: "y", type: "OUT", name: "y" }], nets: [{ from: "s", to: "y" }] } }));
    // pins
    await MCP_OPS.build_circuit({ sheet: "p1", formula: "y1 = a & b; y0 = a | b" });
    out.pins = await err(() => MCP_OPS.set_pins({ sheet: "p1", map: { a: "SW3", b: "sw[4]", y1: "LED:14", y0: "led 3" } }));
    out.pinmap = Object.values(state.project.schematics).find(s => s.name === "p1").pinmap;
    out.badPin = await err(() => MCP_OPS.set_pins({ sheet: "p1", map: { y0: "LED99" } }));
    // ones as a list
    out.ones = await err(() => MCP_OPS.build_circuit({ sheet: "o1", truth_table: { inputs: ["s", "q"], outputs: ["f"], ones: [1, 2] } }));
    out.onesNoOut = await err(() => MCP_OPS.build_circuit({ sheet: "o2", truth_table: { inputs: ["s", "q"], ones: [1, 2] } }));
    // a library part as a generator / a component type
    out.gen = await err(() => MCP_OPS.build_circuit({ name: "adder4", generator: { kind: "adder", n: 4 } }));
    out.comp = await err(() => MCP_OPS.add_component({ type: "adder" }));
    const sim = n => { const s = Object.values(state.project.schematics).find(x => x.name === n); const j = clientCombSim(s); return j.ok ? j.truth_table.rows.map(r => r[1].join("")).join(",") : j.reason; };
    out.i1 = sim("i1"); out.o1 = sim("o1");
    out.sheets = Object.values(state.project.schematics).map(s => s.name);
    return out;
  });
  expect(r.fsmJson).toBe("ok");
  expect(r.fsmText).toBe("ok");
  expect(r.intent).toBe("ok");
  expect(r.i1).toBe("0,0,0,1");                          // y = a & b
  expect(r.broken).not.toMatch(/object Object/);
  expect(r.pins).toBe("ok");
  expect(r.pinmap).toEqual({ a: "sw:3", b: "sw:4", y1: "led:14", y0: "led:3" });
  expect(r.badPin).toMatch(/led:0–led:15/);
  expect(r.ones).toBe("ok");
  expect(r.o1).toBe("0,1,1,0");
  expect(r.onesNoOut).toMatch(/needs the one output/);
  expect(r.gen).toBe("ok");
  expect(r.sheets).toContain("adder4");
  expect(r.comp).toMatch(/library part/);
});
