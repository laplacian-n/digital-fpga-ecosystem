// The lab sheets' worked solutions (ai/rag/labs/*.json) reach students twice — the lab helper shows them
// and the agent gets them as course notes. Lab 3-1's minimum SOP had b'c'd' for b'cd' (wrong at rows 8
// and 10) in both the expression and the stored circuit. Each solution circuit is drawn and compared with
// what the lab asks for.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");
const fs = require("fs");

const sol = (lab, id) => JSON.parse(fs.readFileSync(`ai/rag/labs/${lab}.json`, "utf-8")).items.find(i => i.id === id).solution;

test("lab solutions do what the labs ask", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const cases = [
    // f = Σm(2,3,4,10,12,13,15) + d(0,1,5,6,7) (the example don't-cares): a table, x = don't care
    [sol("Lab3-2569", "lab3-1").intent_json, { table: { inputs: ["a", "b", "c", "d"], ones: { f: [2, 3, 4, 10, 12, 13, 15] }, dont_care: { f: [0, 1, 5, 6, 7] } } }],
    [sol("Lab2-2569", "lab2-1").intent_json.walk, { formula: "walk = P&(~C | R)&~E" }],
    [sol("Lab2-2569", "lab2-1").intent_json.caution, { formula: "caution = (S | E)&(R | P&C)" }],
    [sol("Lab4-2569", "lab4-2").intent_json, { formula: "S = A^B^Cin; Cout = A&B | (A^B)&Cin" }],
    [sol("Lab6-2569", "lab6-2").intent_json, { formula: "invalid = W&X | W&Y" }],
    [sol("Lab1-2569", "lab1-6").intent_json, { formula: "x = a ^ b; y = a & b" }],
  ];
  const r = await page.evaluate(async cases => cases.map(([intent, against]) => {
    const dr = aiDrawIntent(intent); if (!dr || !dr.ok) return "not drawn";
    if (against.formula) { const c = MCP_OPS.compare_sheets({ sheet: dr.sch.name, formula: against.formula }); return c.equivalent === true ? "ok" : JSON.stringify(c).slice(0, 200); }
    const t = against.table, j = clientCombSim(dr.sch), tt = j.truth_table, o = tt.outputs.indexOf("f");
    const pos = t.inputs.map(n => tt.inputs.indexOf(n)), bad = [];
    tt.rows.forEach(([bits, out]) => { const r = pos.reduce((v, p) => v * 2 + (+bits[p]), 0);
      if (!t.dont_care.f.includes(r) && out[o] !== (t.ones.f.includes(r) ? 1 : 0)) bad.push(r); });
    return bad.length ? "wrong rows " + bad : "ok";
  }), cases);
  expect(r).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
  // and the written expression says the same as the circuit
  expect(sol("Lab3-2569", "lab3-1").final_expression).toBe("f = a' + b*d + b*c' + b'*c*d'");
});
