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

test("a formula spec on per-bit ports: a0..a3 is the number a, s0..s3 the number s", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    MCP_OPS.build_part({ kind: "adder", n: 4, sheet: "bitadd" });
    const ok = MCP_OPS.set_spec({ sheet: "bitadd", formula: "{cout,s} = a + b + cin" }).result;
    const bad = MCP_OPS.set_spec({ sheet: "bitadd", formula: "{cout,s} = a + b" }).result;       // forgot cin: must fail
    const bit = MCP_OPS.set_spec({ sheet: "bitadd", formula: "s0 = a0 ^ b0 ^ cin" }).result;       // one bit by its own name
    return { ok: ok.pass, bad: bad.pass, badN: bad.total_mismatches, bit: bit.pass };
  });
  expect(r.ok).toBe(true);
  expect(r.bad).toBe(false);
  expect(r.badN).toBeGreaterThan(0);
  expect(r.bit).toBe(true);
});

test("xnor / nand / nor in equations (also Thai เอ็กซ์นอร์), and a table too big to draw is refused at once", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const F = formulaTable("z = (a xnor b) & (c & ~d); n = a nand b; o = c nor d; q = a ⊙ b");
    const o = oracleDerive("สร้าง z = (a เอ็กซ์นอร์ b) และ (c และ ไม่ d)");
    await MCP_OPS.build_circuit({ name: "xn", formula: "z = (a XNOR b) & (c & ~d)" });
    const chk = MCP_OPS.derive_spec({ request: "z = (a XNOR b) & (c & ~d)", sheet: "xn" }).result;
    let col = "", s = 7; for (let i = 0; i < 1024; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; col += (s >> 16) & 1; }
    const t0 = performance.now(); let err = "";
    try { await MCP_OPS.build_circuit({ name: "big", truth_table: { inputs: "abcdefghij".split(""), outputs: ["y"], columns: { y: col } } }); } catch (e) { err = e.message; }
    return { z: F.cols.z, n: F.cols.n, o: F.cols.o, q: F.cols.q, derived: o.ok && o.spec.text, pass: chk.pass, err, ms: performance.now() - t0,
      waiting: [...MCP_WAITING_OPS] };
  });
  expect(r.z).toBe("0000000000100010".replace(/./g, (c, i) => { const a = i >> 3 & 1, b = i >> 2 & 1, c2 = i >> 1 & 1, d = i & 1; return String(+(a === b && c2 && !d)); }));
  expect(r.n).toBe("1111111111110000");
  expect(r.o).toBe("1000100010001000");
  expect(r.q).toBe("1111000000001111");
  expect(r.derived).toMatch(/xnor/i);
  expect(r.pass).toBe(true);
  expect(r.err).toMatch(/too big to draw/);
  expect(r.ms).toBeLessThan(5000);
  expect(r.waiting).toContain("ai_chat_stop");
});
