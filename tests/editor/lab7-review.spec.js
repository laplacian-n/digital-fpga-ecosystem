// Lab 7 done by hand over MCP turned up these: a bus OUTPUT that build_hierarchy lost (a "ghost" an[3:0]),
// check saying 0/0 for an OUTPUT on a net nothing drives, build_part dropping params:{…}, formulas past
// 10 inputs refused, pin_preset lab 7 with the wrong buttons, and pins kept for ports that are gone.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("build_hierarchy: a bus port that cannot be made stays as bits, and says so — never a ghost", async ({ page }) => {
  test.setTimeout(180000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const plan = { sheet: "d1", inputs: ["clk", "o[3:0]", "t[3:0]", "h[3:0]", "k[3:0]"], outputs: ["an[3:0]", "a", "b", "c", "d", "e", "f", "g"],
      blocks: [{ name: "DISP", part: "seg7_mux4" }],
      connect: [["clk", "DISP.clk"], ["o", "DISP.ones"], ["t", "DISP.tens"], ["h", "DISP.hundreds"], ["k", "DISP.thousands"], ["DISP.an", "an"],
        ["DISP.a", "a"], ["DISP.b", "b"], ["DISP.c", "c"], ["DISP.d", "d"], ["DISP.e", "e"], ["DISP.f", "f"], ["DISP.g", "g"]] };
    const ok = await MCP_OPS.build_hierarchy(plan);
    const s1 = Object.values(state.project.schematics).find(s => s.name === "d1");
    const outs = s => s.components.filter(c => c.type === "OUT").map(c => c.params.name + ":" + (c.params.width || 1)).sort().join(" ");
    // the bus step fails half-way: everything it did is undone and reported
    const real = _uniquePortName; let n = 0;
    _uniquePortName = function () { if (++n === 2) throw new Error("boom"); return real.apply(this, arguments); };
    let bad; try { bad = await MCP_OPS.build_hierarchy(Object.assign({}, plan, { sheet: "d2" })); } finally { _uniquePortName = real; }
    const s2 = Object.values(state.project.schematics).find(s => s.name === "d2");
    return { okOuts: outs(s1), okWarn: ok.warnings, badWarn: bad.warnings, badOuts: outs(s2),
      badCheck: MCP_OPS.check({ sheet: "d2" }).issues.filter(i => i.level === "error").map(i => i.message) };
  });
  expect(r.okOuts).toBe("a:1 an:4 b:1 c:1 d:1 e:1 f:1 g:1");
  expect(r.okWarn).toBeUndefined();
  expect(r.badWarn.join(" ")).toMatch(/stay as single bits.*boom/);
  expect(r.badOuts).toContain("an0:1");                         // the bits, all of them, wired
  expect(r.badOuts).not.toMatch(/an:4/);
  expect(r.badCheck).toEqual([]);
});

test("check: an OUTPUT on a net that nothing drives (bus taps with their bit side open)", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ sheet: "u1", formula: "y = a & b" });
    const s = Object.values(state.project.schematics).find(x => x.name === "u1");
    const out = { id: uid("c"), type: "OUT", x: 700, y: 300, label: "", params: { name: "q", width: 2 } };
    const tap = { id: uid("c"), type: "BUSTAP", x: 600, y: 300, label: "", params: { bit: 0, nbit: 1, mode: "merge", dir: "left" } };
    s.components.push(out, tap);
    s.wires.push({ id: uid("w"), from: { cid: tap.id, pid: "d" }, to: { cid: out.id, pid: "i" }, name: "" });
    return MCP_OPS.check({ sheet: "u1" }).issues.map(i => i.message);
  });
  expect(r.join("\n")).toMatch(/OUTPUT 'q' ต่อสายแล้ว แต่สายนั้นไม่มีอะไรขับ/);
});

test("build_part: settings under params:{} count, a setting the part lacks is refused", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const a = await MCP_OPS.build_part({ kind: "bcd_counter_multi", sheet: "c1", params: { format: "mm.ss", down: true, load: true } });
    let e1, e2; try { await MCP_OPS.build_part({ kind: "bcd_counter_multi", sheet: "c2", output: "q" }); } catch (e) { e1 = e.message + " | " + e.hint; }
    try { await MCP_OPS.build_hierarchy({ sheet: "c3", blocks: [{ name: "u", part: "bcd_valid", params: { n: 4 } }] }); } catch (e) { e2 = e.message; }
    return { params: a.params, outs: a.ports.filter(p => p.dir === "out").map(p => p.name).join(" "), e1, e2 };
  });
  expect(r.params).toEqual({ format: "mm.ss", down: true, load: true });
  expect(r.outs).toMatch(/min_hi/);
  expect(r.e1).toMatch(/no setting 'output'.*takes: format=/);
  expect(r.e2).toMatch(/block u: bcd_valid has no setting 'n'/);
});

test("build_circuit: a formula past 10 inputs is drawn as written and checked", async ({ page }) => {
  test.setTimeout(180000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const z = await MCP_OPS.build_circuit({ sheet: "zero", formula: "zero = ~(m3|m2|m1|m0|n3|n2|n1|n0|s3|s2|s1|s0|t3|t2|t1|t0)" });
    const e = await MCP_OPS.build_circuit({ sheet: "err", formula: "err = (a3&(a2|a1)) | (b3&(b2|b1)) | (c3&(c2|c1)) | (d2&(d1|d0)&~d3); ok = ~err" });
    const types = s => Object.values(state.project.schematics).find(x => x.name === s).components.map(c => c.type).filter(t => !/IN|OUT|JUNCTION/.test(t)).sort().join(" ");
    return { z: z.formula_check, zt: types("zero"), e: e.formula_check, note: e.note, sim: MCP_OPS.probe({ sheet: "zero", inputs: {} }).outputs };
  });
  expect(r.z.pass).toBe(true);
  expect(r.zt).toBe("NOR OR OR");               // 16 inputs → two 8-input ORs into a NOR
  expect(r.e.pass).toBe(true);
  expect(r.note).toMatch(/drawn as written/);
  expect(r.sim.zero).toBe(1);
});

test("pin_preset lab 7 follows the lab sheet; a pin left for a port that is gone is shown and removable", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ sheet: "t7", intent: { module: "t7", components: [
      ...["SET", "STARTSTOP", "RESET", "clk"].map(n => ({ id: n, type: "IN", name: n })), { id: "SW", type: "IN", name: "SW", width: 16 },
      { id: "g", type: "AND" }, { id: "led_error", type: "OUT", name: "led_error" }, { id: "led_timeup", type: "OUT", name: "led_timeup" }],
      nets: [{ from: "SET", to: "g" }, { from: "STARTSTOP", to: "g" }, { from: "g", to: "led_error" }, { from: "RESET", to: "led_timeup" }] } });
    const s = Object.values(state.project.schematics).find(x => x.name === "t7");
    s.components.find(c => String(c.params.name).toLowerCase() === "sw").params.width = 16;     // SW[15:0], as the lab draws it
    const p = MCP_OPS.pin_preset({ sheet: "t7", lab: 7 });
    s.pinmap["an[3]"] = "an:3";
    const warn = MCP_OPS.check({ sheet: "t7" }).issues.map(i => i.message).filter(m => /ไม่มีแล้ว/.test(m));
    MCP_OPS.set_pins({ sheet: "t7", map: { "an[3]": null } });
    return { pm: s.pinmap, warn, left: p.not_placed, ports: schPortList(s).map(q => q.id + ":" + (q.width || 1)).join(" ") };
  });
  expect(r.pm.SET || r.pm.set).toBe("pb:2");
  expect(r.pm.STARTSTOP || r.pm.startstop).toBe("pb:0");
  expect(r.pm.RESET || r.pm.reset).toBe("pb:4");
  expect(r.pm["SW[15]"] || r.pm["sw[15]"], JSON.stringify(r)).toBe("sw:15");
  expect(r.pm.led_error).toBe("led:0");
  expect(r.pm.led_timeup).toBe("led:1");
  expect(r.warn.join(" ")).toMatch(/an\[3\] → an:3/);
  expect(r.pm["an[3]"]).toBeUndefined();
});

test("lab7_countdown: the whole lab 7 as one verified part, pins from the lab sheet; 'ทำแลป 7' asks for it", async ({ page }) => {
  test.setTimeout(300000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const res = await MCP_OPS.build_part({ kind: "lab7_countdown", sheet: "lab7" });
    const s = Object.values(state.project.schematics).find(x => x.name === "lab7");
    const bc = await MCP_OPS.board_check({ sheet: "lab7" });
    const rd = m => { const f = partFromMessage(m); return f ? f.kind : null; };
    return { method: res.verified.method, outs: res.ports.filter(p => p.dir === "out").map(p => p.name).sort().join(" "),
      pins: [s.pinmap.set, s.pinmap.startstop, s.pinmap.reset, s.pinmap.sw15, s.pinmap.led_error, s.pinmap.led_timeup],
      check: MCP_OPS.check({ sheet: "lab7" }).errors, bc: bc.errors,
      asks: [rd("ทำแลป 7"), rd("สร้าง countdown timer mm.ss"), rd("ทำแลป 7 ลงแผ่น t7"), rd("ทำแลป 6"), rd("แลป 7 ใช้ flip-flop กี่ตัว")],
      bcd: (() => { const p = partParams("bcd_counter_multi", { format: "99.59", down: true }); return PARTS.bcd_counter_multi.ports(p).out.min_hi; })() };
  });
  expect(r.method).toMatch(/tick=6.*230 clock/);
  expect(r.outs).toBe("a an0 an1 an2 an3 b c d dp e f g led_error led_timeup running");
  expect(r.pins).toEqual(["pb:2", "pb:0", "pb:4", "sw:15", "led:0", "led:1"]);
  expect(r.check).toBe(0);
  expect(r.bc).toBe(0);
  expect(r.asks).toEqual(["lab7_countdown", "lab7_countdown", "lab7_countdown", "lab6_counter", null]);
  expect(r.bcd).toBe(4);
});

test("build_hierarchy wires a block's BUS pins (whole, slices, single bits); an unused bit of a nibble is a warning", async ({ page }) => {
  test.setTimeout(180000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_part({ kind: "adder", n: 4, cin: false, bus: true, sheet: "inc" });       // pins a[3:0] b[3:0] s[3:0] cout
    const run = async (nm, C) => { const res = await MCP_OPS.build_hierarchy({ sheet: nm, inputs: ["st[3:0]"], outputs: ["q[3:0]", "co"],
      blocks: [{ name: "u", sheet: "inc" }], connect: [...C, ["u.s", "q"], ["u.cout", "co"]] });
      return { open: res.unconnected_block_inputs, errs: MCP_OPS.check({ sheet: nm }).errors,
        q: [3, 5].map(v => { const o = MCP_OPS.probe({ sheet: nm, inputs: { st: v } }).outputs; return o.q.value + 16 * o.co; }) }; };
    const plain = await run("p1", [["st", "u.a"], ["st", "u.b"]]);
    const rev = await run("p2", [["st", "u.a"], ["st[0]", "u.b[3]"], ["st[1]", "u.b[2]"], ["st[2]", "u.b[1]"], ["st[3]", "u.b[0]"]]);
    const half = await MCP_OPS.build_hierarchy({ sheet: "p3", inputs: ["st[3:0]"], outputs: ["q[3:0]"], blocks: [{ name: "u", sheet: "inc" }], connect: [["st", "u.a"], ["u.s", "q"]] });
    await MCP_OPS.build_circuit({ sheet: "nib", formula: "y = st3 & (st2 | st1)", inputs: ["st3", "st2", "st1", "st0"] });
    return { plain, rev, half: half.unconnected_block_inputs, nib: MCP_OPS.check({ sheet: "nib" }).issues.map(i => i.level + ": " + i.message) };
  });
  expect(r.plain).toEqual({ open: [], errs: 0, q: [6, 10] });          // st + st
  expect(r.rev).toEqual({ open: [], errs: 0, q: [15, 15] });           // st + (st with its bits reversed)
  expect(r.half).toEqual(["u.b"]);
  expect(r.nib.join("\n")).toMatch(/^warning: INPUT 'st0' \(บิตหนึ่งของกลุ่ม st\)/);
  expect(r.nib.join("\n")).not.toMatch(/^error/m);
});
