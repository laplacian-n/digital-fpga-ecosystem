// The lab-level parts (labs 4–10): every kind builds and passes its reference check, big ones are
// hierarchical (verified sub-parts as blocks), and the ALU answers lab 9's test table.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("every lab part builds and passes its reference check", async ({ page }) => {
  test.setTimeout(400000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const cases = [["bcd_valid",{}],["one_pulse",{}],["counter_digit",{}],["counter_digit",{m:6,down:true,load:true}],["counter_digit",{m:4}],
      ["bcd_counter_multi",{}],["bcd_counter_multi",{format:"mm.ss",down:true,load:true}],["bcd_counter_multi",{format:"00-59",bus:true}],
      ["bcd2_compare",{}],["add3",{}],["bin2bcd",{n:8}],["bin2bcd",{n:5}],["hex_7seg",{}],["hex_7seg",{active_low:false}],
      ["seg7_mux4",{}],["seg7_mux4",{hex:true,dp:true}],["addsub",{n:4}],["alu_slice",{ops:"4"}],["alu",{n:4,ops:"8"}],
      ["register_en",{n:4}],["register_en",{n:3,async:true}],["mux_bus",{k:4,n:4}],["bcd_ascii",{}]];
    const bad = [], kinds = new Set(), sheets = {};
    for (const [k, a] of cases) { kinds.add(k);
      try { const res = MCP_OPS.build_part(Object.assign({ kind: k }, a)); if (!res.verified.pass) bad.push(k);
        sheets[k] = res.sheet; }
      catch (e) { bad.push(k + " " + JSON.stringify(a) + ": " + e.message); } }
    // hierarchical: the mm.ss counter is made of counter_digit blocks, bin2bcd of add3 blocks
    const blocksOf = n => { const s = Object.values(state.project.schematics).find(x => x.name === n);
      return [...new Set(s.components.filter(c => c.type.startsWith("SCH:")).map(c => state.project.schematics[c.type.slice(4)].name))]; };
    return { bad, missing: PARTS_LABS.filter(k => !kinds.has(k)), cnt: blocksOf(sheets.bcd_counter_multi), b2b: blocksOf(sheets.bin2bcd) };
  });
  expect(r.bad).toEqual([]);
  expect(r.missing).toEqual([]);
  expect(r.cnt.join()).toMatch(/counter_digit/);
  expect(r.b2b).toEqual(["add3"]);
});

test("lab 9's test table on the ALU part (ADD SUB XOR SHL), and a mm.ss countdown loaded from switches", async ({ page }) => {
  test.setTimeout(200000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    MCP_OPS.build_part({ kind: "alu", n: 8, ops: "4", bus: true, sheet: "alu9" });
    const T = [["0F","01",0],["5A","25",0],["FF","01",0],["0A","05",1],["05","0A",1],["00","01",1],["F0","0F",2],["5A","FF",2],["AA","AA",2],["01","00",3],["5A","00",3],["FF","00",3]];
    const sim = MCP_OPS.simulate({ sheet: "alu9", vectors: T.map(([a, b, op]) => ({ a: "0x" + a, b: "0x" + b, op })) });
    const got = sim.rows.map(x => { const y = x.outputs.y; return parseInt(typeof y === "string" ? y : y.bin || y, 2).toString(16).toUpperCase().padStart(2, "0") + "/" + x.outputs.carry; });
    // countdown: load 01.02, count down three seconds, stop at 00.59
    MCP_OPS.build_part({ kind: "bcd_counter_multi", format: "mm.ss", down: true, load: true, bus: true, sheet: "timer" });
    const ld = { sec_lo_d: 2, sec_hi_d: 0, min_lo_d: 1, min_hi_d: 0 };
    const s = MCP_OPS.simulate({ sheet: "timer", vectors: [Object.assign({ load: 1, en: 0 }, ld), { en: 1 }, { en: 1 }, { en: 1 }, { en: 0 }] });
    const t = s.rows.map(x => { const o = x.outputs, d = n => parseInt(o[n] != null ? o[n] : 0, 2);
      return typeof o === "string" ? o : `${d("min_hi")}${d("min_lo")}.${d("sec_hi")}${d("sec_lo")}`; });
    return { got, t, cols: s.columns };
  });
  expect(r.got).toEqual(["10/0","7F/0","00/1","05/0","FB/1","FF/1","FF/0","A5/0","00/0","02/0","B4/0","FE/0"]);
  expect(r.t.slice(1)).toEqual(["01.02","01.01","01.00","00.59"]);
});
