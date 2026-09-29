// "สร้างคลังโมดูลให้แน่นๆ ... ตัวโมเดลเพียงแค่ดึงมาใช้และประกอบ": every part of the library builds AND
// passes its own reference check (all rows / vectors / a clock-by-clock state model).
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("every part in the library builds and passes its reference check", async ({ page }) => {
  test.setTimeout(300000);
  await openEditor(page);
  const r = await page.evaluate(() => {
    const cases = [["half_adder",{}],["full_adder",{}],["half_subtractor",{}],["full_subtractor",{}],["adder",{n:1}],["adder",{n:4}],["adder",{n:8}],
      ["adder",{n:4,cin:false}],["adder",{n:4,bus:true}],["subtractor",{n:4}],["subtractor",{n:6,bus:true}],["comparator",{n:1}],["comparator",{n:4}],["comparator",{n:8}],
      ["mux",{n:2}],["mux",{n:4}],["mux",{n:8,bus:true}],["demux",{n:4}],["decoder",{n:3}],["decoder",{n:2,en:true}],["decoder",{n:4,bus:true}],
      ["encoder",{n:4}],["encoder",{n:8}],["bcd_7seg",{}],["bcd_7seg",{active_low:false,bus:true}],["parity",{n:4}],["parity",{n:8,odd:true}],["majority",{}],
      ["mod_counter",{n:10}],["mod_counter",{n:6,bus:true}],["mod_counter",{n:2}],["bcd_counter",{}],["jk_counter",{n:10}],["jk_counter",{n:6,output:"q"}],
      ["binary_counter",{n:3}],["clock_divider",{n:6}],["clock_divider",{n:7}],["clock_divider",{n:2}],["clock_divider",{n:2500000}],
      ["shift_register",{n:4}],["register",{n:4}],["register",{n:4,bus:true}],["toggle",{}],["edge_detector",{}],["debounce",{}]];
    const bad = [], kinds = new Set();
    for (const [k, a] of cases) { kinds.add(k);
      try { const res = MCP_OPS.build_part(Object.assign({ kind: k }, a)); if (!res.verified.pass) bad.push(k);
        const s = Object.values(state.project.schematics).find(x => x.name === res.sheet); if (!sheetVerified(s)) bad.push(k + " (no stamp)"); }
      catch (e) { bad.push(k + " " + JSON.stringify(a) + ": " + e.message); } }
    const missing = Object.keys(PARTS).filter(k => !kinds.has(k) && !PARTS_LABS.includes(k));   // those: parts-labs.spec.js
    // the stamp dies with an edit
    const fa = MCP_OPS.build_part({ kind: "full_adder", sheet: "fa_stamp" }), s = Object.values(state.project.schematics).find(x => x.name === "fa_stamp");
    const before = sheetVerified(s); s.components.find(c => c.type === "XOR").type = "OR";
    return { bad, missing, before, after: sheetVerified(s), ports: fa.ports.map(p => p.name) };
  });
  expect(r.bad).toEqual([]);
  expect(r.missing).toEqual([]);
  expect(r.ports).toEqual(["a", "b", "cin", "sum", "cout"]);
  expect([r.before, r.after]).toEqual([true, false]);
});

test("equations become the truth table; a check against what it was built from does not count", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const F = formulaTable("sum = a ^ b ^ cin; cout = a&b | cin&(a^b)");
    const G = formulaTable("{cout,sum} = a + b + cin");
    const H = formulaTable(["y = a'b + ab'"].map(s => s.replace("a'b", "a'&b").replace("ab'", "a&b'")));
    // the agent's mistake: wrong columns, "verified" against themselves
    const wrong = { inputs: ["a", "b", "cin"], outputs: ["sum", "cout"], columns: { sum: "00001110", cout: "00011111" } };
    await MCP_OPS.build_circuit({ truth_table: wrong, sheet: "fa_wrong" });
    const t1 = MCP_OPS.verify_truth_table({ sheet: "fa_wrong", expected: wrong.columns });
    const t2 = MCP_OPS.verify_truth_table({ sheet: "fa_wrong", formula: "{cout,sum} = a + b + cin" });
    let saveErr = null; try { MCP_OPS.save_module({ sheet: "fa_wrong", name: "FA1" }); } catch (e) { saveErr = e.message; }
    // built from equations it is right, and a check from the requirement verifies it
    const b = await MCP_OPS.build_circuit({ formula: "sum = a ^ b ^ cin; cout = a&b | cin&(a^b)", sheet: "fa_eq" });
    const t3 = MCP_OPS.verify_truth_table({ sheet: "fa_eq", formula: "{cout,sum} = a + b + cin" });
    const saved = MCP_OPS.save_module({ sheet: "fa_eq", name: "FA_ok" });
    return { F: F.cols, G: G.cols, H: H.cols, t1: [t1.pass, t1.independent, t1.counts_as_verified], t2: [t2.pass, t2.mismatches.length],
      saveErr, rec: b.recognized, t3: [t3.pass, t3.independent, t3.counts_as_verified, t3.recognized], saved: saved.verified };
  });
  expect(r.F).toEqual({ sum: "01101001", cout: "00010111" });
  expect(r.G).toEqual({ cout: "00010111", sum: "01101001" });
  expect(r.H).toEqual({ y: "0110" });
  expect(r.t1).toEqual([null, false, false]);        // proves nothing — says so, and is not a pass
  expect(r.t2).toEqual([false, 6]);                  // against the requirement: the 6 wrong rows from the test log
  expect(r.saveErr).toContain("not verified");       // the wrong FA1 never reaches the library
  expect(r.rec).toContain("Full Adder");
  expect(r.t3.slice(0, 3)).toEqual([true, true, true]);
  expect(r.saved).toContain("formula");
});

test("the agent's fast path: 'full adder on sheet fa3' is built and checked with no model at all", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => [
    partFromMessage("สร้างชีตใหม่ชื่อ fa แล้วออกแบบวงจร full adder 1 บิต: อินพุต a, b, cin ; เอาต์พุต sum, cout โดยใช้ประตูลอจิก (XOR, AND, OR) ต่อสายให้ครบทุกขา แล้วรัน DRC check ให้ผ่าน"),
    partFromMessage("ทำ mux 8:1 แบบบัส"), partFromMessage("หารความถี่ 50 MHz → 20 Hz"), partFromMessage("decoder 3 to 8 ชื่อ dec3"),
    partFromMessage("bcd to 7-seg"), partFromMessage("ตัวนับ mod 6 แล้วต่อเข้ากับ led"), partFromMessage("อธิบาย flip-flop หน่อย")]);
  expect(r[0]).toMatchObject({ kind: "full_adder", args: { sheet: "fa" }, simple: true });
  expect(r[1]).toMatchObject({ kind: "mux", args: { n: 8, bus: true } });
  expect(r[2]).toMatchObject({ kind: "clock_divider", args: { n: 2500000 } });
  expect(r[3]).toMatchObject({ kind: "decoder", args: { n: 3, sheet: "dec3" } });
  expect(r[4]).toMatchObject({ kind: "bcd_7seg", args: { active_low: true } });
  expect(r[5]).toMatchObject({ kind: "mod_counter", args: { n: 6 }, simple: false });
  expect(r[6]).toBe(null);
});
