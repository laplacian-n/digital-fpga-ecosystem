// ลงบอร์ด inside the editor: the launcher runs Vivado + openFPGALoader (fakes here) for the page.
const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const PORT = 19300 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc, home, bin;

test.skip(process.platform === "win32", "the fake tools are shell scripts");
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "fe-board-"));
  bin = path.join(home, "bin"); fs.mkdirSync(bin);
  // fake Vivado: reads build.tcl like the real one would, writes <top>.bit next to it
  fs.writeFileSync(path.join(bin, "vivado"), `#!/bin/sh
echo "fake vivado $*"; cat build.tcl | grep -q read_xdc || exit 3
top=$(sed -n 's/^write_bitstream -force "\\(.*\\)"$/\\1/p' build.tcl)
grep -q PACKAGE_PIN *.xdc || { echo "ERROR: [Place 30-58] unconstrained"; exit 1; }
# Tcl, like the real read_xdc: a '#' after a command is not a comment — the constraint is dropped
if grep -E '^[^#].*\] +#' *.xdc; then echo "ERROR: [DRC NSTD-1] Unspecified I/O Standard"; exit 1; fi
echo "write_bitstream ok"; printf 'BIT' > "$top"; echo "Vivado log" > vivado_build.log
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "openFPGALoader"), `#!/bin/sh\necho "ofl $*"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), APPDATA: path.join(home, "AppData"),
                NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  proc = spawn(process.platform === "win32" ? "python" : "python3",
    [path.join(__dirname, "..", "launcher", "app.py"), "--no-open", "--port", String(PORT)], { env, stdio: "ignore" });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/api/info")).ok) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const cfg = await (await fetch(BASE + "/api/config")).json();
  cfg.features.vivado = path.join(bin, "vivado"); cfg.features.openfpgaloader = path.join(bin, "openFPGALoader");
  await fetch(BASE + "/api/config", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(cfg) });
});
test.afterAll(async () => { try { await fetch(BASE + "/api/quit", { method: "POST", body: "{}" }); } catch (_) {} proc && proc.kill(); });

test("build the .bit and load it onto the board without leaving the editor", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(BASE + "/studio.html");
  await page.waitForFunction(() => typeof openBoardPage === "function");
  await page.waitForTimeout(800);                         // the welcome dialog opens after 500 ms
  await page.evaluate(() => { document.querySelectorAll(".modal-bg").forEach(m => m.remove()); document.querySelector("#projectName").value = "halfadd"; });
  await page.click('.step[data-stage="upload"]');
  await expect(page.locator("#boardPage")).toBeVisible();
  await expect(page.locator("#brdTools")).toContainText("Vivado");
  await expect(page.locator("#brdPins .brd-pin")).toHaveCount(4);            // a, b, sum, cout
  await page.click('[data-brd="build"]');
  await expect(page.locator("#brdStatus")).toContainText("สร้าง .bit" + "สำเร็จ", { timeout: 15000 });
  await expect(page.locator("#brdLog")).toContainText("write_bitstream ok");
  const bit = path.join((await (await fetch(BASE + "/api/projects")).json()).dir, "halfadd");
  expect(fs.readdirSync(bit).some(f => f.endsWith(".bit"))).toBe(true);     // copied into the project folder
  await page.click('[data-brd="sram"]');
  await expect(page.locator("#brdStatus")).toContainText("สำเร็จ", { timeout: 15000 });
  await expect(page.locator("#brdLog")).toContainText("-m");
  await page.screenshot({ path: test.info().outputPath("board-page.png") });
  await page.click('[data-brd="close"]');
  await expect(page.locator("#boardPage")).toBeHidden();
  // coming back later: the .bit is still there and still matches → load it without building again
  await page.click('.step[data-stage="upload"]');
  await expect(page.locator("#brdBit")).toContainText("ไม่ต้องสร้างใหม่");
  await expect(page.locator('[data-brd="sram"]')).toBeEnabled();
  await page.click('[data-brd="close"]');
  // change the circuit: the old .bit is flagged as out of date
  await page.evaluate(() => { const o = activeSch().components.find(c => c.type === "OUT"); o.params.name = "total"; renderAll(); });
  await page.click('.step[data-stage="upload"]');
  await expect(page.locator("#brdBit")).toContainText("เปลี่ยนไปแล้ว");
  await page.click('[data-brd="close"]');
  expect(errors).toEqual([]);
});

test("a failed build explains itself", async ({ page }) => {
  await page.goto(BASE + "/studio.html");
  await page.waitForFunction(() => typeof openBoardPage === "function");
  await page.waitForTimeout(800);                         // the welcome dialog opens after 500 ms
  // no pins at all: the xdc has no PACKAGE_PIN → the fake Vivado fails like the real one
  await page.evaluate(() => { document.querySelectorAll(".modal-bg").forEach(m => m.remove());
    activeSch().pinmap = {}; uxAutoPins = () => {}; autoSpecialTarget = () => null; });
  await page.click('.step[data-stage="upload"]');
  page.once("dialog", d => d.accept());
  await page.click('[data-brd="build"]');
  await expect(page.locator("#brdStatus")).toContainText("ไม่สำเร็จ", { timeout: 15000 });
  await expect(page.locator("#brdHint")).toBeVisible();
});

test("Top-Down from Home opens inside the editor with the circuit", async ({ page }) => {
  await page.goto(BASE + "/studio.html?view=topdown");
  await expect(page.locator("#topdownView")).toBeVisible({ timeout: 5000 });
  const f = page.frameLocator("#topdownFrame");
  await expect(f.locator("svg [data-node]").first()).toBeVisible({ timeout: 5000 });
  // a small circuit prints at the standard size, not blown up to fill the A4 page
  await expect(f.locator("svg text", { hasText: "1 หน่วย = 0.3 มม." })).toHaveCount(1);
});

test("first run opens the setup checklist until it is dismissed", async ({ page }) => {
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(BASE + "/");
  await expect(page.locator("#tab-setup")).toBeVisible();
  const list = page.locator("#setupList");
  await expect(list.locator(".chk")).toHaveCount(4);        // editor, Vivado, openFPGALoader, AI (no USB row off Windows)
  await expect(list.locator(".chk", { hasText: "Vivado" }).locator(".ic")).toHaveClass(/ok/);
  await expect(list.locator(".chk", { hasText: "openFPGALoader" })).toContainText("spiOverJtag");   // no flash bridge next to the fake
  await expect(list.locator(".chk", { hasText: "โมเดล AI" }).locator(".ic")).toHaveClass(/opt/);
  await expect(page.locator("#setupBadge")).toBeEmpty();
  await list.locator('[data-goto="llm"]').click();
  await expect(page.locator("#tab-settings")).toBeVisible();
  await page.click('nav [data-tab="setup"]');
  await page.click("#setupDone");
  expect((await (await fetch(BASE + "/api/config")).json()).setup_done).toBe(true);
  await page.reload();
  await expect(page.locator("#tab-home")).toBeVisible();
  await expect(page.locator("#tab-setup")).toBeHidden();
  expect(errors).toEqual([]);
});

test("on a sub-circuit's sheet, ลงบอร์ด builds THAT sheet as the top entity (and the menu can switch)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE + "/studio.html");
  await page.waitForFunction(() => typeof openBoardPage === "function");
  await page.waitForTimeout(800);
  await page.evaluate(() => { document.querySelectorAll(".modal-bg").forEach(m => m.remove());
    document.querySelector("#projectName").value = "subtest";
    // a second sheet "inv": x → NOT → y, and we stay on it (like being in its sim)
    const id = uid("sch"); state.project.schematics[id] = blankSchematic(id, "inv"); openSchTab(id);
    const s = activeSch(); const put = (type, x, y, params) => { const c = { id: uid("c"), type, x, y, label: "", params: Object.assign({}, TYPES[type].defaultParams || {}, params || {}) }; s.components.push(c); return c; };
    const x = put("IN", 88, 110, { name: "x" }), n = put("NOT", 300, 99), y = put("OUT", 500, 110, { name: "y" });
    s.wires.push({ id: uid("w"), from: { cid: x.id, pid: "o" }, to: { cid: n.id, pid: getPorts(n).find(p => p.dir === "in").id }, name: "" },
                 { id: uid("w"), from: { cid: n.id, pid: "o" }, to: { cid: y.id, pid: "i" }, name: "" });
    snapshot(); renderAll(); });
  await page.click('.step[data-stage="upload"]');
  await expect(page.locator("#brdSheetSel")).toHaveValue(await page.evaluate(() => activeSch().id));
  await expect(page.locator("#brdSheet")).toContainText("entity inv");
  await expect(page.locator("#brdSheet")).toContainText("วงจรย่อย");
  await expect(page.locator("#brdPins .brd-pin")).toHaveCount(2);             // x, y — not top's ports
  const d = await page.evaluate(() => { const d = brdDesign(); return { top: d.top, vhdl: d.vhdl, topId: state.project.topId, inv: activeSch().id }; });
  expect(d.top).toBe("inv");
  expect(d.vhdl).toMatch(/entity inv is/);
  expect(d.topId).not.toBe(d.inv);                                          // the project's real top is untouched
  await page.click('[data-brd="build"]');
  await expect(page.locator("#brdStatus")).toContainText("สร้าง .bit" + "สำเร็จ", { timeout: 15000 });
  const dir = path.join((await (await fetch(BASE + "/api/projects")).json()).dir, "subtest");
  expect(fs.readdirSync(dir)).toContain("inv.bit");
  // the menu switches to top
  const topId = d.topId;
  await page.selectOption("#brdSheetSel", topId);
  await expect(page.locator("#brdSheet")).not.toContainText("entity inv");
  await page.click('[data-brd="close"]');
});
