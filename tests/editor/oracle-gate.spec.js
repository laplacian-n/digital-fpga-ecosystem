// The independent oracle: a spec derived from the REQUEST by code (equations, minterms, a numeric
// condition, a named part) — a wrong circuit fails it even when it matches its own build table.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("derive_spec: request → spec; a wrong circuit built from its own table fails it, the right one passes", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const d = m => { const o = oracleDerive(m); return o.ok ? o.source + ":" + o.spec.kind : "no"; };
    const kinds = [d("f(a,b,c) = Σm(1,2,4,7)"), d("สร้าง y = (a และ b) หรือ (c และ ไม่ d)"), d("p = 1 เมื่อ x2 x1 x0 เป็นจำนวนเฉพาะ"),
      d("full adder"), d("ตัวบวก 4 บิต"), d("mod 6 counter"), d("ทำวงจรอะไรก็ได้ที่เจ๋งๆ")];
    // the prime detector with one bit wrong, built from the model's own column: its own table "passes"…
    await MCP_OPS.build_circuit({ name: "pr", truth_table: { inputs: ["x2", "x1", "x0"], outputs: ["p"], columns: { p: "00110111" } } });
    const own = MCP_OPS.verify_truth_table({ sheet: "pr", expected: { p: "00110111" } });
    // …the spec from the request does not
    const bad = MCP_OPS.derive_spec({ request: "p = 1 เมื่อ x2 x1 x0 เป็นจำนวนเฉพาะ", sheet: "pr" });
    await MCP_OPS.build_circuit({ sheet: "pr", replace: true, truth_table: { inputs: ["x2", "x1", "x0"], outputs: ["p"], columns: { p: "00110101" } } });
    const good = MCP_OPS.check_spec({ sheet: "pr" });
    const s = Object.values(state.project.schematics).find(x => x.name === "pr");
    // input order does not matter for a table over named inputs
    await MCP_OPS.build_circuit({ name: "mt", formula: "f = ~a&~b&c | ~a&b&~c | a&~b&~c | a&b&c", inputs: ["c", "b", "a"] });
    const mt = MCP_OPS.derive_spec({ request: "f(a,b,c) = Σm(1,2,4,7)", sheet: "mt" }).result;
    // a part spec: a hand-built full adder with a wrong carry fails, the library one passes
    await MCP_OPS.build_circuit({ name: "fa_h", formula: "sum = a^b^cin; cout = a&b" });
    const fah = MCP_OPS.derive_spec({ request: "full adder", sheet: "fa_h" }).result;
    MCP_OPS.build_part({ kind: "full_adder", sheet: "fa_ok" });
    const fao = MCP_OPS.derive_spec({ request: "full adder", sheet: "fa_ok" }).result;
    const none = MCP_OPS.derive_spec({ request: "ทำวงจรอะไรก็ได้ที่เจ๋งๆ" });
    return { kinds, own: own.pass, bad: bad.result.pass, badN: bad.result.total_mismatches, good: good.pass, indep: good.independent,
      verified: sheetVerified(s), mt: mt.pass, fah: fah.pass, fao: fao.pass, none: none.derived };
  });
  expect(r.kinds).toEqual(["minterms:table", "equations:formula", "condition:table", "part:part", "part:part", "part:part", "no"]);
  expect(r.own).not.toBe(true);             // its own table is no check
  expect(r.bad).toBe(false);
  expect(r.badN).toBe(1);
  expect([r.good, r.indep, r.verified]).toEqual([true, true, true]);
  expect(r.mt).toBe(true);
  expect([r.fah, r.fao]).toEqual([false, true]);
  expect(r.none).toBe(false);
});
