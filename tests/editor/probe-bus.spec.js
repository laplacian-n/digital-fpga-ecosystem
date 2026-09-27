// "โหมดตรวจค่าไม่รองรับหลายบิต": a bus INPUT gets a per-bit picker, bus taps pass the right bit,
// gates and merge taps work on the values, and bus wires show their value.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

async function busSheet(page){
  await page.evaluate(() => {
    const s = activeSch(); s.components = []; s.wires = []; const id = {};
    const put = (k, type, x, y, params) => { const c = { id: uid("c"), type, x, y, label: "",
      params: Object.assign(JSON.parse(JSON.stringify((TYPES[type] && TYPES[type].defaultParams) || {})), params || {}) };
      s.components.push(c); id[k] = c; };
    const W = (a, ap, b, bp) => s.wires.push({ id: uid("w"), from: { cid: id[a].id, pid: ap }, to: { cid: id[b].id, pid: bp }, name: "" });
    put("swt", "IN", 88, 198, { name: "swt", width: 4 });
    for (let i = 0; i < 4; i++) {
      put("t" + i, "BUSTAP", 308, 88 + i * 110, { bit: i, nbit: 1, mode: "split", dir: "right" });
      put("n" + i, "NOT", 418, 77 + i * 110);
      put("m" + i, "BUSTAP", 616, 88 + i * 110, { bit: i, nbit: 1, mode: "merge", dir: "left" });
      W("swt", "o", "t" + i, "d"); W("t" + i, "y", "n" + i, getPorts(id["n" + i]).find(p => p.dir === "in").id);
      W("n" + i, "o", "m" + i, "y");
    }
    put("y", "OUT", 792, 198, { name: "y", width: 4 });
    // y's bus, with the four merge taps dropped onto it (one net through a dot)
    const J = { id: uid("c"), type: "JUNCTION", x: 700 - 6, y: 220 - 6, params: {} }; s.components.push(J); id.J = J;
    s.wires.push({ id: uid("w"), from: { cid: J.id, pid: "j" }, to: { cid: id.y.id, pid: "i" }, name: "" });
    for (let i = 0; i < 4; i++) s.wires.push({ id: uid("w"), from: { cid: J.id, pid: "j" }, to: { cid: id["m" + i].id, pid: "d" }, name: "" });
    normalizePortFanout(s); snapshot(); renderAll();
  });
}
const outs = page => page.evaluate(() => { const s = activeSch(), e = probeEval(s);
  const v = n => e.compVal.get(s.components.find(c => c.params && c.params.name === n).id);
  return { swt: v("swt"), y: v("y") }; });

test("click a bus INPUT in probe mode: set bits one by one; taps, gates and merge follow", async ({ page }) => {
  await openEditor(page);
  await busSheet(page);
  await page.click("#btnProbe");
  expect(await outs(page)).toEqual({ swt: 0, y: 15 });        // NOT of every bit
  const node = page.locator('.node[data-cid]').filter({ hasText: "swt" }).first();
  await node.click();
  await expect(page.locator("#probeBusPick")).toBeVisible();
  await page.click('#probeBusPick button[data-bit="2"]');
  expect(await outs(page)).toEqual({ swt: 4, y: 11 });        // 0100 → NOT → 1011
  await page.click('#probeBusPick button[data-bit="0"]');
  expect(await outs(page)).toEqual({ swt: 5, y: 10 });
  await expect(page.locator("#probeBusPick .pbp-h")).toContainText("0b0101");
  await page.click('#probeBusPick button[data-all="1"]');
  expect(await outs(page)).toEqual({ swt: 15, y: 0 });
  await page.click('#probeBusPick button[data-step="-1"]');
  expect(await outs(page)).toEqual({ swt: 14, y: 1 });
  // the bus wires say their value
  await expect(page.locator(".probe-busval").first()).toBeVisible();
  expect(await page.locator(".probe-busval").allTextContents()).toEqual(expect.arrayContaining(["1110", "0001"]));
  // the thin wire of tap 0 (bit 0 = 0) is dark, tap 1 (bit 1 = 1) is lit
  await page.keyboard.press("Escape");
  await expect(page.locator("#probeBusPick")).toBeHidden();
  expect(page.errors).toEqual([]);
});

test("a sheet with bus ports simulates in the browser (no more 'ERC failed')", async ({ page }) => {
  await openEditor(page);
  await busSheet(page);
  const r = await page.evaluate(() => clientCombSim(activeSch()));
  expect(r.ok).toBe(true);
  expect(r.truth_table.inputs).toEqual(["swt[3]", "swt[2]", "swt[1]", "swt[0]"]);
  expect(r.truth_table.outputs).toEqual(["y[3]", "y[2]", "y[1]", "y[0]"]);
  expect(r.truth_table.rows.length).toBe(16);
  const row5 = r.truth_table.rows.find(([b]) => b.join("") === "0101");
  expect(row5[1].join("")).toBe("1010");                    // y = NOT swt, bit by bit
  // and a backend refusal now says what it means and what is wrong
  const html = await page.evaluate(() => simFailHtml({ ok: false, reason: "ERC failed", errors: [{ code: "X", msg: "pin not found", hint: "check the pin id" }] }));
  expect(html).toContain("ERC");
  expect(html).toContain("pin not found");
  expect(html).toContain("check the pin id");
});

test("the sim page runs a bus sheet: switches per bit, outputs follow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await openEditor(page);
  await busSheet(page);
  await page.evaluate(() => showSimPage("signals"));
  await expect(page.locator("#simSignals")).not.toContainText("จำลองไม่ได้");
  const sw = page.locator('#simPcb .swUnit.mapped', { hasText: "swt[1]" });
  await expect(sw).toHaveCount(1);
  await sw.click();
  await expect(page.locator("#simValbar")).toContainText("swt[1]=1");
  await expect(page.locator("#simValbar")).toContainText("y[1]=0");
  await expect(page.locator("#simValbar")).toContainText("y[0]=1");
  expect(page.errors).toEqual([]);
});
