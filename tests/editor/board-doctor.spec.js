// Board doctor: the mistakes that only show on the real board, found before a Vivado build.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("board_check: active-high segments, missing digit select, shared pins, clock from a push button / raw 50 MHz", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    const titles = res => res.findings.map(f => f.level + " " + f.title);
    const pin7 = extra => Object.assign({ b3: "sw:3", b2: "sw:2", b1: "sw:1", b0: "sw:0" },
      ...[..."abcdefg"].map(s => ({ [s]: "seg:" + s })), extra || {});
    const out = {};
    // a BCD decoder written for a common-cathode display, on this common-anode board
    MCP_OPS.build_part({ kind: "bcd_7seg", active_low: false, sheet: "hi" });
    activeSch().pinmap = pin7();
    out.hi = titles(MCP_OPS.board_check({ sheet: "hi" }));
    // the right one, with digit 0 enabled through an OUTPUT an0 = GND
    MCP_OPS.build_part({ kind: "bcd_7seg", active_low: true, sheet: "lo" });
    activeSch().pinmap = pin7();
    out.lo = titles(MCP_OPS.board_check({ sheet: "lo" }));
    // shared pins and an input on an LED
    activeSch().pinmap = pin7({ b2: "sw:3", b1: "led:0" });
    out.bad = titles(MCP_OPS.board_check({ sheet: "lo" }));
    // a counter: clock from a push button, then from the 50 MHz oscillator
    MCP_OPS.build_part({ kind: "mod_counter", n: 10, sheet: "cnt" });
    const s = activeSch(), bits = uxPortBits(s);
    const map = clk => { s.pinmap = {}; let l = 0; bits.forEach(b => { s.pinmap[b.key] = b.dir === "out" ? "led:" + (l++) : /clk/.test(b.key) ? clk : "sw:" + (8 + l++); }); };
    map("pb:0"); out.pb = titles(MCP_OPS.board_check({ sheet: "cnt" }));
    map("clk"); out.fast = titles(MCP_OPS.board_check({ sheet: "cnt" }));
    return out;
  });
  expect(r.hi.join("\n")).toMatch(/err 7-seg เขียนแบบ active-high/);
  expect(r.hi.join("\n")).toMatch(/warn .*an0–an3/);
  expect(r.lo.join("\n")).not.toMatch(/active-high/);
  expect(r.bad.join("\n")).toMatch(/b2 กับ b3 ใช้ขาเดียวกัน/);
  expect(r.bad.join("\n")).toMatch(/INPUT b1 ต่อกับ LED 0/);
  expect(r.pb.join("\n")).toMatch(/warn นาฬิกา .* มาจากปุ่มกด/);
  expect(r.fast.join("\n")).toMatch(/warn วงจรใช้นาฬิกา 50 MHz ตรงๆ/);
  expect(r.fast.join("\n")).not.toMatch(/ปุ่มกด/);
});

test("the doctor's board preview: flip the mapped switches, the digit shows what the board will show", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    MCP_OPS.build_part({ kind: "bcd_7seg", active_low: true, sheet: "lo" });
    activeSch().pinmap = Object.assign({ b3: "sw:3", b2: "sw:2", b1: "sw:1", b0: "sw:0" }, ...[..."abcdefg"].map(s => ({ [s]: "seg:" + s })));
    BRD.sheetId = activeSch().id; openBoardDoctor();
  });
  const lit = () => page.evaluate(() => [...document.querySelectorAll(".bd-dig")].pop().querySelectorAll('path[stroke="#ff3b30"]').length);
  expect(await lit()).toBe(6);                               // 0 → a..f
  await page.locator('[data-bdin="b0"]').check();
  expect(await lit()).toBe(2);                               // 1 → b, c
  await page.locator('[data-bdin="b3"]').check();            // 9
  expect(await lit()).toBe(6);
  await page.screenshot({ path: test.info().outputPath("board-doctor.png") });
  expect(page.errors).toEqual([]);
});
