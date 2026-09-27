// "ทำให้กดดูตารางความจริงได้" + "เอาวาดวงจรอัตโนมัติออกจากตรงนี้ไปใส่ใน tools"
const { test, expect } = require("@playwright/test");
const { openEditor, drawSheet } = require("./helpers");

test("select COMPM4: the Inspector opens its truth table; ✨ lives in Tools now", async ({ page }) => {
  await openEditor(page);
  await drawSheet(page, [{ k: "c", type: "COMPM", x: 330, y: 132, params: { width: 4 } }], []);
  await page.evaluate(() => { const c = activeSch().components[0]; state.selection = new Set([c.id]); renderInspector(); });
  await expect(page.locator("#iRealize")).toHaveCount(0);
  await expect(page.locator('#menu [data-act="realize-block"]')).toHaveCount(1);
  await page.click("#iTruth");
  const modal = page.locator(".modal-bg .part-tt");
  await expect(modal).toBeVisible();
  await expect(page.locator(".modal-bg")).toContainText("256 แถว");
  // read it back: GT = A > B, LT = A < B, with A = A3..A0 and B = B3..B0
  const bad = await page.evaluate(() => {
    const T = partTruthTable(activeSch().components[0]).table, ix = n => T.inputs.indexOf(n);
    let wrong = 0;
    T.rows.forEach(([a, o]) => { let A = 0, B = 0; for (let i = 0; i < 4; i++) { A |= a[ix("A" + i)] << i; B |= a[ix("B" + i)] << i; }
      if (o[T.outputs.indexOf("GT")] !== (A > B ? 1 : 0) || o[T.outputs.indexOf("LT")] !== (A < B ? 1 : 0)) wrong++; });
    return wrong;
  });
  expect(bad).toBe(0);
  expect(page.errors).toEqual([]);
});

test("decoder, encoder, demux and a flip-flop", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    const mk = (type, params) => ({ id: "x", type, x: 0, y: 0, label: "", params: Object.assign(JSON.parse(JSON.stringify(TYPES[type].defaultParams || {})), params || {}) });
    const row = (T, ins) => T.rows.find(([a]) => a.join("") === ins)[1].join("");
    const dec = partTruthTable(mk("DEC", { outputs: 4 })).table;     // inputs a0 a1 en
    const enc = partTruthTable(mk("ENC", { inputs: 4 })).table;      // i0..i3 → y0 y1
    const dmx = partTruthTable(mk("DEMUX", { outputs: 2 })).table;   // d s0 → y0 y1
    return { decIn: dec.inputs.join(","), dec: row(dec, "101"), dec0: row(dec, "100"),
             enc: row(enc, "1010"), dmx: row(dmx, "11"), ff: partTruthTable(mk("DFF")).reason || "" };
  });
  expect(r.decIn).toBe("a1,a0,en");
  expect(r.dec).toBe("0100");          // a1=1 a0=0 → 2 → y2 (outputs y3 y2 y1 y0)
  expect(r.dec0).toBe("0000");         // en = 0
  expect(r.enc).toBe("11");            // i3 and i1 on → highest (3) wins → y1=1 y0=1
  expect(r.dmx).toBe("10");            // d=1 s0=1 → y1 (outputs y1 y0)
  expect(r.ff).toContain("flip-flop");
});
