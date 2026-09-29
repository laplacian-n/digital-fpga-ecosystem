// End-to-end: MCP client (this test) → launcher/mcp_server.py (stdio) → launcher relay → live editor page.
const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const ROOT = path.join(__dirname, "..");
const PY = process.platform === "win32" ? "python" : "python3";
const PORT = 19100 + Math.floor(Math.random() * 80);
const BASE = `http://127.0.0.1:${PORT}`;
let launcher, server, browser, page, env;

/** minimal MCP client over the server's stdio */
function mcpClient(proc) {
  let buf = "", n = 0; const waiting = {};
  proc.stdout.on("data", d => { buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue; const m = JSON.parse(line); if (waiting[m.id]) { waiting[m.id](m); delete waiting[m.id]; } } });
  const rpc = (method, params) => new Promise(res => { const id = ++n; waiting[id] = res;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const tool = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args || {} });
    const c = r.result.content, t = c.find(x => x.type === "text");
    let data = null; try { data = JSON.parse(t.text); } catch (_) {}
    return { error: !!r.result.isError, text: t && t.text, data, image: c.find(x => x.type === "image") };
  };
  return { rpc, tool };
}
let mcp;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser: b }) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fe-mcp-"));
  env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), APPDATA: path.join(home, "AppData"),
          NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  // no network in tests: the update check is off (about then says so instead of asking GitHub)
  const cfgDir = path.join(home, ".config", "fpga-ecosystem"); fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ update: { auto_check: false } }));
  launcher = spawn(PY, [path.join(ROOT, "launcher", "app.py"), "--no-open", "--port", String(PORT)], { env, stdio: "ignore" });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + "/api/info")).ok) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  browser = b;
  page = await browser.newPage();
  page.errors = []; page.on("pageerror", e => page.errors.push(e.message));
  await page.goto(BASE + "/studio.html");
  await page.waitForFunction(() => typeof MCPB === "object" && MCPB.on);
  await page.evaluate(() => document.querySelectorAll(".modal-bg").forEach(m => m.remove()));
  server = spawn(PY, [path.join(ROOT, "launcher", "mcp_server.py")], { env });
  mcp = mcpClient(server);
  await mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
});
test.afterAll(async () => {
  try { server.stdin.end(); } catch (_) {} server && server.kill();
  try { await fetch(BASE + "/api/quit", { method: "POST", body: "{}" }); } catch (_) {} launcher && launcher.kill();
});

test("build, verify and inspect a half adder through MCP", async () => {
  const st = await mcp.tool("status");
  expect(st.error).toBe(false);
  expect(st.data.editor).toBe("Schematic Studio");
  await mcp.tool("new_sheet", { name: "ha" });
  const ap = await mcp.tool("apply", { steps: [
    { op: "add_component", type: "IN", name: "a" }, { op: "add_component", type: "IN", name: "b" },
    { op: "add_component", type: "XOR", name: "X1" }, { op: "add_component", type: "AND", name: "A1" },
    { op: "add_component", type: "OUT", name: "sum" }, { op: "add_component", type: "OUT", name: "carry" },
    { op: "connect", connections: [["a", "X1"], ["b", "X1"], ["a", "A1"], ["b", "A1"], ["X1", "sum"], ["A1", "carry"]] }] });
  expect(ap.error).toBe(false);
  expect(ap.data.auto_layout).toBe(true);
  expect(ap.data.layout.clean).toBe(true);
  // the user sees it: the editor's active sheet is the one Claude built
  expect(await page.evaluate(() => activeSch().name)).toBe("ha");
  const v = await mcp.tool("verify_truth_table", { expected: { sum: "0110", carry: "0001" } });
  expect(v.data.pass).toBe(true);
  const chk = await mcp.tool("check");
  expect(chk.data.ok).toBe(true);
  const net = await mcp.tool("get_netlist");
  expect(net.data.nets.find(n => n.driver === "X1.o").sinks).toEqual(["sum.i"]);
  const pr = await mcp.tool("probe", { inputs: { a: 1, b: 1 } });
  expect(pr.data.outputs).toEqual({ sum: 0, carry: 1 });
  const shot = await mcp.tool("screenshot");
  expect(shot.image.mimeType).toBe("image/png");
  expect(shot.image.data.length).toBeGreaterThan(5000);
});

test("errors are specific and a failed batch changes nothing", async () => {
  const bad = await mcp.tool("connect", { from: "X1.zz", to: "carry" });
  expect(bad.error).toBe(true);
  expect(bad.text).toContain("pin 'zz' does not exist on X1");
  expect(bad.text).toContain("hint: pins: i0(in), i1(in), o(out)");
  const dup = await mcp.tool("add_component", { type: "OUT", name: "sum" });
  expect(dup.error).toBe(true);
  const before = await page.evaluate(() => activeSch().components.length);
  const tx = await mcp.tool("apply", { steps: [{ op: "add_component", type: "NOT", name: "N1" }, { op: "connect", from: "N1", to: "nope" }] });
  expect(tx.error).toBe(true);
  expect(tx.text).toContain("nothing was changed");
  expect(await page.evaluate(() => activeSch().components.length)).toBe(before);
});

test("check finds a floating input and explains the fix", async () => {
  await mcp.tool("add_component", { type: "AND", name: "A2" });
  await mcp.tool("connect", { from: "a", to: "A2.i0" });
  const chk = await mcp.tool("check");
  const w = chk.data.issues.find(i => i.component === "A2");
  expect(w).toBeTruthy();
  expect(w.fix).toBeTruthy();
  const u = await mcp.tool("undo"); expect(u.error).toBe(false);
  await mcp.tool("undo");
  expect(await page.evaluate(() => activeSch().components.some(c => c.label === "A2"))).toBe(false);
});

test("generators, sequential sim, pins and xdc", async () => {
  const b = await mcp.tool("build_circuit", { name: "mod10", generator: { kind: "mod_counter", n: 10 } });
  expect(b.error).toBe(false);
  const sim = await mcp.tool("simulate", { sheet: "mod10", cycles: 12 });
  expect(sim.data.kind).toBe("sequential");
  const counts = sim.data.rows.map(r => parseInt(r.outputs.split("").reverse().join(""), 2));
  expect(counts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1]);
  const pins = await mcp.tool("set_pins", { sheet: "ha", map: { a: "sw:3", b: "sw:2", sum: "led:0", carry: "led:1" } });
  expect(pins.data.unassigned).toEqual([]);
  const badPin = await mcp.tool("set_pins", { sheet: "ha", map: { a: "led:0" } });
  expect(badPin.error).toBe(true);
  const xdc = await mcp.tool("get_xdc", { sheet: "ha" });
  expect(xdc.data.xdc).toContain("PACKAGE_PIN P12");        // sw:3
});

test("user edits show up in get_events; files are exported to the workspace", async () => {
  const ev0 = await mcp.tool("get_events", { since: 0 });
  await page.evaluate(() => { const s = activeSch(); s.components.push({ id: uid("c"), type: "OR", x: 900, y: 500, params: JSON.parse(JSON.stringify(TYPES.OR.defaultParams)), label: "" }); snapshot(); });
  const ev = await mcp.tool("get_events", { since: ev0.data.latest });
  expect(ev.data.events.some(e => e.kind === "user_edit")).toBe(true);
  await page.evaluate(() => { document.querySelector("#projectName").value = "mcptest"; });
  const ex = await mcp.tool("export_files", { what: ["vhdl", "xdc", "project"], sheet: "ha" });
  expect(ex.error).toBe(false);
  expect(ex.data.vhdl).toMatch(/mcptest[\\/]mcptest\.vhd$/);
  const lp = await mcp.tool("list_projects");
  expect(lp.data.projects.map(p => p.name)).toContain("mcptest");
  expect(page.errors).toEqual([]);
});

test("the relay refuses calls without the token and cross-origin pages", async ({ request }) => {
  expect((await request.post(BASE + "/api/mcp/call", { data: { op: "status" } })).status()).toBe(401);
  expect((await request.post(BASE + "/api/mcp/result", { data: {}, headers: { Origin: "https://evil.example" } })).status()).toBe(403);
  expect((await request.get(BASE + "/api/mcp/poll?client=x", { headers: { Origin: "https://evil.example" } })).status()).toBe(403);
});

test("you see Claude's change straight away: canvas forward, in view, highlighted", async () => {
  await mcp.tool("new_sheet", { name: "watch" });
  await mcp.tool("add_component", { type: "IN", name: "w_in" });
  await page.evaluate(() => showSimPage("signals"));                    // the user is looking at the sim page
  await expect(page.locator("#simPage")).toHaveClass(/show/);
  // a part placed far off-screen
  const r = await mcp.tool("add_component", { type: "NOT", name: "far", x: 4400, y: 3300 });
  expect(r.error).toBe(false);
  await expect(page.locator("#simPage")).not.toHaveClass(/show/);       // back on the canvas
  const inView = await page.evaluate(() => { const s = activeSch(), c = s.components.find(x => x.label === "far");
    const r = canvas.getBoundingClientRect(), v = state.view, z = getSize(c);
    return c.x >= -v.x / v.k && c.y >= -v.y / v.k && c.x + z.w <= (r.width - v.x) / v.k && c.y + z.h <= (r.height - v.y) / v.k; });
  expect(inView).toBe(true);
  await expect(page.locator(".node.mcp-flash")).toHaveCount(1);          // the new part glows
  // a read-only call does not move the view
  const before = await page.evaluate(() => JSON.stringify(state.view));
  await mcp.tool("get_sheet");
  expect(await page.evaluate(() => JSON.stringify(state.view))).toBe(before);
});

test("lab flow: Top-Down only after the user approves the simulated circuit", async () => {
  const tt = await mcp.tool("build_circuit", { name: "lab_ha", truth_table: { inputs: ["a", "b"], outputs: ["s", "c"], columns: { s: "0110", c: "0001" } } });
  expect(tt.error).toBe(false);
  await page.evaluate(() => { const s = Object.values(state.project.schematics).find(x => x.name === "lab_ha"); state.project.topId = s.id; });
  // not approved yet → refused
  let r = await mcp.tool("make_topdown");
  expect(r.error).toBe(true); expect(r.text).toContain("not approved");
  // ask: the card shows the summary; the answer is pending
  r = await mcp.tool("request_approval", { summary: "half adder: s = a xor b, c = a and b — simulation matches" });
  expect(r.data.status).toBe("waiting");
  await expect(page.locator("#mcpApproval")).toContainText("half adder");
  r = await mcp.tool("approval_status", { wait: 1 });
  expect(r.data.status).toBe("waiting");
  // the user approves in the editor
  const pending = mcp.tool("approval_status", { wait: 20 });
  await page.click('#mcpApproval [data-ap="approve"]');
  r = await pending;
  expect(r.data).toMatchObject({ status: "approved", design_unchanged: true });
  r = await mcp.tool("make_topdown");
  expect(r.error).toBe(false);
  expect(r.data.sheets[0]).toBe("1st Layer (lab_ha)");
  await expect(page.locator("#topdownView")).toBeVisible();
  await page.evaluate(() => closeTopdown());
  // the circuit changes after approval → must be approved again
  await mcp.tool("add_component", { sheet: "lab_ha", type: "NOT", name: "extra" });
  r = await mcp.tool("make_topdown");
  expect(r.error).toBe(true); expect(r.text).toContain("changed after");
  // asking for changes gives Claude the user's comment
  await mcp.tool("request_approval", { summary: "half adder + extra NOT" });
  await page.fill("#mcpApNote", "เอา NOT ออก");
  await page.click('#mcpApproval [data-ap="changes"]');
  r = await mcp.tool("approval_status", { wait: 5 });
  expect(r.data).toMatchObject({ status: "changes", comment: "เอา NOT ออก" });
});

test("Claude knows the app: about, projects, board readiness; new_project; board errors are clear", async () => {
  const ver = fs.readFileSync(path.join(ROOT, "launcher", "app.py"), "utf8").match(/^VERSION = "(.+)"/m)[1];
  const init = await mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  expect(init.result.serverInfo.version).toBe(ver);
  expect(init.result.instructions).toContain("Start with `about`");
  let r = await mcp.tool("about");
  expect(r.error).toBe(false);
  expect(r.data.app).toMatchObject({ name: "FPGA Ecosystem", version: ver });
  expect(r.data.update.current).toBe(ver);
  expect(r.data.editor_open).toBe(true);
  expect(r.data.board).toHaveProperty("vivado_ok");
  expect(r.data.board).toHaveProperty("usb_driver");
  expect(r.data.mcp_server.version).toBe(ver);
  r = await mcp.tool("open_home", { tab: "nope" });
  expect(r.error).toBe(true);
  // a new project
  r = await mcp.tool("new_project", { name: "lab7 counter" });
  expect(r.error).toBe(false);
  expect(r.data.created).toBe("lab7_counter");
  expect(await page.evaluate(() => state.project.name)).toBe("lab7_counter");
  // building without Vivado: a clear answer, not a hang
  await mcp.tool("build_circuit", { name: "t", truth_table: { inputs: ["a"], outputs: ["y"], columns: { y: "10" } } });
  await page.evaluate(() => { const s = Object.values(state.project.schematics).find(x => x.name === "t"); state.project.topId = s.id; });
  await mcp.tool("auto_pins");
  r = await mcp.tool("board_build");
  expect(r.error).toBe(true);
  expect(r.text).toMatch(/Vivado/);
  r = await mcp.tool("board_status", { wait: 1 });
  expect(r.error).toBe(false);
  expect(r.data).toHaveProperty("state");
});

test("the retired offline servers read the LIVE sheet, not their stale files", async () => {
  // what the old schematic_mcp.py / topdown_mcp.py read_design now answers while the app runs
  await mcp.tool("new_sheet", { name: "live_one" });
  await mcp.tool("add_component", { type: "AND", name: "g_live" });
  const { execFileSync } = require("child_process");
  const out = execFileSync(PY, ["-c", "import legacy_live, sys; print(legacy_live.live_sheet('live_one')); print('---'); print(legacy_live.live_sheets())"],
    { cwd: ROOT, env, encoding: "utf-8" });
  const [sheet, sheets] = out.split("---");
  expect(sheet).toContain("g_live");
  expect(sheets).toContain("live_one");
  expect(fs.readFileSync(path.join(ROOT, "schematic_mcp.py"), "utf-8")).toContain("legacy_live.live_sheet(name)");
  // and they refuse to save a file that a Sync would paste over the user's arranged sheet
  const run = execFileSync(PY, ["-c", "import legacy_live; print(legacy_live.running())"], { cwd: ROOT, env, encoding: "utf-8" });
  expect(run.trim()).toBe("True");
  for (const f of ["schematic_mcp.py", path.join("topdown", "topdown_mcp.py")])
    expect(fs.readFileSync(path.join(ROOT, f), "utf-8")).toContain("return legacy_live.SAVE_REFUSED");
});

test("a big change draws in piece by piece (ค่อยๆโผล่มา), and ends fully shown", async () => {
  await mcp.tool("build_circuit", { name: "reveal", truth_table: { inputs: ["a", "b", "c"], outputs: ["y", "z"], columns: { y: "01101001", z: "00010111" } } });
  const seen = await page.evaluate(() => new Promise(res => { let max = 0; const t0 = Date.now();
    const f = () => { const n = document.querySelectorAll("#canvas .mcp-hide").length; max = Math.max(max, n);
      if (Date.now() - t0 > 4000 || (max && !n)) res({ max, left: n }); else requestAnimationFrame(f); }; f(); }));
  expect(seen.max).toBeGreaterThan(2);       // things were still hidden, waiting their turn
  expect(seen.left).toBe(0);                 // and everything ended up on screen
  // the sheet itself was complete from the start: reading it does not wait for the animation
  const g = await mcp.tool("get_sheet", { sheet: "reveal" });
  expect(g.error).toBe(false);
});

test("probe a comparator through MCP with bus values (a=0101, b=0011 → GT=1, LT=0)", async () => {
  // what Claude reported as "unknown": COMPM4 / COMP were not evaluated, and a=0101 was squashed to 1
  await mcp.tool("new_sheet", { name: "cmp_probe" });
  const put = async (type, name, params) => (await mcp.tool("add_component", { type, name, params })).data;
  await put("IN", "a", { width: 8 }); await put("IN", "b", { width: 8 });
  const m = await put("COMPM", "", { width: 8 });   // 8 bits → bus pins a / b
  const e = await put("COMP", "", { width: 8 });
  await put("OUT", "gt"); await put("OUT", "lt"); await put("OUT", "eq");
  const q = await put("IN", "q", { width: 8 });     // 8-bit operands
  const id = x => x.id || x.component || x;
  const mid = id(m), eid = id(e);
  const conn = async (f, t) => { const r = await mcp.tool("connect", { from: f, to: t }); expect(r.error, r.text).toBe(false); };
  await conn("a", mid + ".a"); await conn("b", mid + ".b");
  await conn("a", eid + ".a"); await conn("q", eid + ".b");
  await conn(mid + ".gt", "gt"); await conn(mid + ".lt", "lt"); await conn(eid + ".eq", "eq");
  let p = await mcp.tool("probe", { sheet: "cmp_probe", inputs: { a: "0101", b: "00000011", q: 5 } });
  expect(p.error, p.text).toBe(false);
  expect(p.data.outputs).toEqual({ gt: 1, lt: 0, eq: 1 });
  p = await mcp.tool("probe", { sheet: "cmp_probe", inputs: { a: "0x3", b: "0b101", q: 4 } });
  expect(p.data.outputs).toEqual({ gt: 0, lt: 1, eq: 0 });
  const bad = await mcp.tool("probe", { sheet: "cmp_probe", inputs: { a: "01x1" } });
  expect(bad.error).toBe(true);
  expect(bad.text).toContain("bus INPUT 'a'");
});

test("the pin page on screen follows set_pins from Claude (and Undo)", async () => {
  await mcp.tool("new_sheet", { name: "pins_live" });
  await mcp.tool("add_component", { type: "IN", name: "a" });
  await mcp.tool("add_component", { type: "OUT", name: "y" });
  await mcp.tool("connect", { from: "a", to: "y" });
  await mcp.tool("set_pins", { map: { a: "sw:0", y: "led:0" } });
  await page.evaluate(() => showSimPage("pins"));
  const sel = page.locator('#simPinPicker select[data-pk="a"]');
  await expect(sel).toHaveValue("sw:0");
  const r = await mcp.tool("set_pins", { map: { a: "sw:5" } });           // Claude changes it while the page is open
  expect(r.error, r.text).toBe(false);
  await expect(sel).toHaveValue("sw:5");
  await page.evaluate(() => undo());
  await expect(sel).toHaveValue("sw:0");
  await page.evaluate(() => hideSimPage());
});

// ---- from a Claude session's review of lab 6 work through this server ----
test("blocks in an intent; a loop through a flip-flop inside a block is not an error; a real one is", async () => {
  await mcp.tool("new_sheet", { name: "rcnt" });
  let r = await mcp.tool("apply", { steps: [
    { op: "add_component", type: "IN", name: "en" }, { op: "add_component", type: "IN", name: "clk" },
    { op: "add_component", type: "DFF", name: "ff" }, { op: "add_component", type: "AND", name: "g" },
    { op: "add_component", type: "OUT", name: "q" },
    { op: "connect", connections: [["en", "g"], ["ff.q", "g"], ["g", "ff.d"], ["clk", "ff.clk"], ["ff.q", "q"]] }] });
  expect(r.error, r.text).toBe(false);
  await mcp.tool("new_sheet", { name: "rel" });
  r = await mcp.tool("apply", { steps: [{ op: "add_component", type: "IN", name: "q" }, { op: "add_component", type: "NOT", name: "n" },
    { op: "add_component", type: "OUT", name: "en" }, { op: "connect", connections: [["q", "n"], ["n", "en"]] }] });
  expect(r.error, r.text).toBe(false);
  // the intent instantiates both sheets as blocks; pins are spelled with the sheets' port names
  r = await mcp.tool("build_circuit", { intent: { module: "rtop", components: [
    { id: "clk", type: "IN", name: "clk" }, { id: "cnt", type: "block:rcnt" }, { id: "el", type: "block:rel" },
    { id: "led", type: "OUT", name: "err_led" }, { id: "led2", type: "OUT", name: "en_led" }],
    nets: [{ from: "clk", to: "cnt.clk" }, { from: "cnt.q", to: "el.q" }, { from: "el", to: "cnt.en" },
           { from: "el.en", to: "led" }, { from: "el.en", to: "led2" }] } });
  expect(r.error, r.text).toBe(false);
  const badPin = await mcp.tool("build_circuit", { intent: { module: "x", components: [{ id: "c", type: "block:rcnt" }, { id: "o", type: "OUT" }],
    nets: [{ from: "c", to: "o" }, { from: "o", to: "c" }] } });
  expect(badPin.error).toBe(true);
  // cnt → el → cnt goes through ff inside rcnt: legal (Vivado builds it), so no loop error
  const chk = await mcp.tool("check", { sheet: "rtop" });
  expect(chk.data.issues.filter(i => /combinational loop/.test(i.message))).toEqual([]);
  // a block that is combinational all the way through does close a real loop
  await mcp.tool("new_sheet", { name: "rpass" });
  await mcp.tool("apply", { steps: [{ op: "add_component", type: "IN", name: "a" }, { op: "add_component", type: "NOT", name: "n" },
    { op: "add_component", type: "OUT", name: "y" }, { op: "connect", connections: [["a", "n"], ["n", "y"]] }] });
  await mcp.tool("build_circuit", { intent: { module: "rloop", components: [
    { id: "p", type: "block:rpass" }, { id: "el", type: "block:rel" }, { id: "o", type: "OUT", name: "y" }],
    nets: [{ from: "p.y", to: "el.q" }, { from: "el.en", to: "p.a" }, { from: "el.en", to: "o" }] } });
  const loop = await mcp.tool("check", { sheet: "rloop" });
  expect(loop.data.issues.some(i => i.level === "error" && /combinational loop/.test(i.message))).toBe(true);
});

test("delete takes its nets along: connect to the freed pin in the same apply, no ghost driver", async () => {
  await mcp.tool("open_sheet", { sheet: "rtop" });
  const r = await mcp.tool("apply", { steps: [{ op: "delete", target: "el" }, { op: "connect", from: "cnt.q", to: "err_led" }] });
  expect(r.error, r.text).toBe(false);
  expect(r.data.steps[0].result.now_unconnected.sort()).toEqual(["cnt.en", "en_led.i", "err_led.i"]);
  const net = await mcp.tool("get_netlist", { sheet: "rtop" });
  expect(net.data.nets.filter(n => n.driver && /\.j$/.test(n.driver))).toEqual([]);   // no dot posing as a driver
  expect(net.data.nets.find(n => n.driver === "cnt.q").sinks).toEqual(["err_led.i"]);
  const dots = await page.evaluate(() => { const s = Object.values(state.project.schematics).find(x => x.name === "rtop");
    return s.components.filter(c => c.type === "JUNCTION" && !s.wires.some(w => w.from.cid === c.id || w.to.cid === c.id)).length; });
  expect(dots).toBe(0);
  const bad = await mcp.tool("delete", { whatever: "x" });
  expect(bad.error).toBe(true);
  expect(bad.text).toContain("delete takes: sheet (string), refs* (array)");
  const drv = await mcp.tool("connect", { from: "clk", to: "err_led.i" });
  expect(drv.text).toContain("already driven by cnt.q");
});

test("simulate: chosen input vectors, and a clear answer instead of 65536 rows", async () => {
  await mcp.tool("build_circuit", { name: "ha2", truth_table: { inputs: ["a", "b"], outputs: ["sum", "carry"], columns: { sum: "0110", carry: "0001" } } });
  const v = await mcp.tool("simulate", { sheet: "ha2", vectors: [{ a: 1, b: 1 }, { a: 1 }] });
  expect(v.error, v.text).toBe(false);
  expect(v.data.rows.map(r => r.outputs)).toEqual([{ sum: 0, carry: 1 }, { sum: 1, carry: 0 }]);
  await mcp.tool("new_sheet", { name: "wide" });
  await mcp.tool("apply", { steps: [{ op: "add_component", type: "IN", name: "a", width: 16 }, { op: "add_component", type: "OUT", name: "y", width: 16 },
    { op: "connect", from: "a", to: "y" }] });
  const big = await mcp.tool("simulate", { sheet: "wide" });
  expect(big.error).toBe(true);
  expect(big.text).toContain("vectors");
  const w = await mcp.tool("simulate", { sheet: "wide", vectors: [{ a: "0x1234" }] });
  expect(w.data.rows[0].outputs.y).toBe((0x1234).toString(2).padStart(16, "0"));
});

test("clock_divider: any N on one sheet (÷6 simulated, ÷2 500 000 builds)", async () => {
  let r = await mcp.tool("build_circuit", { name: "div6", generator: { kind: "clock_divider", n: 6 } });
  expect(r.error, r.text).toBe(false);
  const sim = await mcp.tool("simulate", { sheet: "div6", cycles: 24 });
  const out = sim.data.rows.map(x => x.outputs).join("");
  expect(out.slice(6, 18)).toBe(out.slice(12, 24));                       // period 6
  expect(out.slice(6, 12).split("").filter(x => x === "1").length).toBe(3); // 50 % duty
  r = await mcp.tool("build_circuit", { name: "div20hz", generator: { kind: "clock_divider", n: 2500000 } });
  expect(r.error, r.text).toBe(false);
  expect(r.data.note).toContain("clk_in/2500000");
  const chk = await mcp.tool("check", { sheet: "div20hz" });
  expect(chk.data.errors).toBe(0);
});

test("bus ports: a generator's q0..q3 become q[3:0] (simulates, makes VHDL, wires as one pin on a parent)", async () => {
  const b = await mcp.tool("build_circuit", { name: "cnt10b", generator: { kind: "jk_counter", n: 10, output: "q" }, bus: true });
  expect(b.error, b.text).toBe(false);
  expect(b.data.bus_ports).toEqual(["out q[3:0] ← q0,q1,q2,q3"]);
  const sh = await mcp.tool("get_sheet", { sheet: "cnt10b", detail: "brief" });
  expect(sh.data.ports).toEqual([{ name: "clk_in", dir: "in", width: 1 }, { name: "q", dir: "out", width: 4 }]);
  const chk = await mcp.tool("check", { sheet: "cnt10b" });
  expect(chk.data.errors, JSON.stringify(chk.data.issues)).toBe(0);
  const sim = await mcp.tool("simulate", { sheet: "cnt10b", cycles: 12 });
  expect(sim.data.rows.map(r => parseInt(r.outputs.q, 2))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1]);
  const v = await mcp.tool("get_vhdl", { entity: "cnt10b" });
  expect(v.error, v.text).toBe(false);
  expect(v.data.vhdl.code).toMatch(/q\s*:\s*out\s+std_logic_vector\s*\(\s*3\s+downto\s+0\s*\)/i);
  // a truth table's inputs a0..a2 / b0..b2 → a, b (3 bits each), still the same function
  const tt = { inputs: ["a2", "a1", "a0", "b2", "b1", "b0"], outputs: ["eq"], columns: { eq: Array.from({ length: 64 }, (_, r) => (r >> 3) === (r & 7) ? "1" : "0").join("") } };
  const t = await mcp.tool("build_circuit", { name: "eq3", truth_table: tt, bus: ["a", "b"] });
  expect(t.error, t.text).toBe(false);
  const vec = await mcp.tool("simulate", { sheet: "eq3", vectors: [{ a: 5, b: 5 }, { a: 5, b: 4 }, { a: "111", b: "111" }] });
  expect(vec.data.rows.map(r => r.outputs.eq)).toEqual([1, 0, 1]);
  // the parent wires the counter's whole bus in one connection
  const top = await mcp.tool("build_circuit", { intent: { module: "bustop", components: [
    { id: "clk", type: "IN", name: "clk" }, { id: "c", type: "block:cnt10b" }, { id: "o", type: "OUT", name: "leds", params: { width: 4 } }],
    nets: [{ from: "clk", to: "c.clk_in" }, { from: "c.q", to: "o" }] } });
  expect(top.error, top.text).toBe(false);
  const ts = await mcp.tool("simulate", { sheet: "bustop", cycles: 4 });
  expect(ts.data.rows.map(r => r.outputs.leds)).toEqual(["0000", "0001", "0010", "0011"]);
  // an existing sheet that is used as a block is refused (its parent's wires would come loose)
  const used = await mcp.tool("make_bus_ports", { sheet: "cnt10b" });
  expect(used.error).toBe(true);
});

test("module library over MCP: save a sheet with its sub-blocks, use it in another project, open, delete", async () => {
  const gate = await mcp.tool("save_module", { sheet: "bustop", name: "counter_leds" });
  expect(gate.error).toBe(true);                                     // not verified: kept out of the library
  expect(gate.text).toContain("not verified");
  const sv = await mcp.tool("save_module", { sheet: "bustop", name: "counter_leds", description: "mod-10 counter on 4 LEDs", force: true });
  expect(sv.error, sv.text).toBe(false);
  expect(sv.data.blocks).toEqual(["cnt10b"]);                       // the block inside goes with it
  expect(sv.data.ports).toEqual([{ name: "clk", dir: "in", width: 1 }, { name: "leds", dir: "out", width: 4 }]);
  const dup = await mcp.tool("save_module", { sheet: "bustop", name: "counter_leds", force: true });
  expect(dup.error).toBe(true);
  expect(dup.text).toContain("replace:true");
  expect((await mcp.tool("save_module", { sheet: "bustop", name: "counter_leds", replace: true, force: true })).data.replaced).toBe(true);
  const ls = await mcp.tool("list_modules", { query: "leds" });
  expect(ls.data.modules.map(m => m.name)).toEqual(["counter_leds"]);
  // the Modules tab shows it too
  await page.evaluate(() => renderModulesPane());
  await expect(page.locator("#modulesPane")).toContainText("counter_leds");
  // another project: place it as a block, wire it, simulate — the counter inside counts
  await mcp.tool("new_project", { name: "modtest" });
  const u = await mcp.tool("use_module", { module: "counter_leds", name: "U1" });
  expect(u.error, u.text).toBe(false);
  expect(u.data.pins.map(p => p.id)).toEqual(["clk", "leds"]);
  await mcp.tool("apply", { steps: [{ op: "add_component", type: "IN", name: "clk" }, { op: "add_component", type: "OUT", name: "y", width: 4 },
    { op: "connect", connections: [["clk", "U1.clk"], ["U1.leds", "y"]] }] });
  const sim = await mcp.tool("simulate", { cycles: 3 });
  expect(sim.data.rows.map(r => r.outputs.y)).toEqual(["0000", "0001", "0010"]);
  // a second use reuses the sheet already brought in
  const u2 = await mcp.tool("use_module", { module: "counter_leds" });
  expect(u2.data.sheet_in_project).toBe(u.data.sheet_in_project);
  const op = await mcp.tool("open_module", { module: "counter_leds" });
  expect(op.data.blocks_added).toBe(1);
  expect((await mcp.tool("delete_module", { module: "counter_leds" })).data.deleted).toBe("counter_leds");
  expect((await mcp.tool("list_modules")).data.count).toBe(0);
});

test("search_course: the course notes (RAG) answer through MCP", async () => {
  const r = await mcp.tool("search_course", { query: "JK flip-flop excitation table", k: 3 });
  expect(r.error, r.text).toBe(false);
  expect(r.data.hits.length).toBe(3);
  const b = await mcp.tool("search_course", { q: "seven segment digit select", group: "board" });   // alias q → query
  expect(b.data.hits.every(h => h.group === "board")).toBe(true);
});

test("build_circuit into a named sheet (new or empty); connect to one bit of a bus pin", async () => {
  await mcp.tool("new_sheet", { name: "fa_empty" });
  const tt = { inputs: ["a", "b", "cin"], outputs: ["sum", "cout"], columns: { sum: "01101001", cout: "00010111" } };
  let r = await mcp.tool("build_circuit", { truth_table: tt, sheet: "fa_empty" });
  expect(r.error, r.text).toBe(false);
  expect(r.data.sheet).toBe("fa_empty");                                   // filled, not a new "logic" sheet beside it
  // checked against its own table it proves nothing (pass:null); against the requirement it passes
  expect((await mcp.tool("verify_truth_table", { sheet: "fa_empty", expected: tt.columns })).data.pass).toBe(null);
  expect((await mcp.tool("verify_truth_table", { sheet: "fa_empty", formula: "{cout,sum} = a + b + cin" })).data.pass).toBe(true);
  expect((await mcp.tool("status")).data.sheets.filter(s => /^logic/.test(s.name))).toEqual([]);
  r = await mcp.tool("build_circuit", { truth_table: tt, sheet: "fa_empty" });
  expect(r.error).toBe(true);                                              // has parts now: refused, not overwritten
  expect(r.text).toContain("already has parts");
  r = await mcp.tool("build_circuit", { generator: { kind: "mod_counter", n: 5 }, sheet: "cnt5_here" });
  expect(r.data.sheet).toBe("cnt5_here");
  // bits of a bus
  await mcp.tool("new_sheet", { name: "bits" });
  await mcp.tool("apply", { steps: [{ op: "add_component", type: "IN", name: "a" }, { op: "add_component", type: "IN", name: "b" },
    { op: "add_component", type: "OUT", name: "y", width: 4 }, { op: "add_component", type: "IN", name: "s", width: 4 },
    { op: "add_component", type: "OUT", name: "z" }] });
  r = await mcp.tool("connect", { connections: [["a", "y.i[0]"], ["b", "y.i[2]"], ["s.o[3]", "z"]] });
  expect(r.error, r.text).toBe(false);
  expect(r.data.bus_bits.length).toBe(3);
  const v = await mcp.tool("simulate", { sheet: "bits", vectors: [{ a: 1, b: 1, s: 8 }, { a: 0, b: 1, s: 7 }] });
  expect(v.data.rows.map(x => x.outputs)).toEqual([{ y: "0101", z: 1 }, { y: "0100", z: 0 }]);
  const again = await mcp.tool("connect", { from: "b", to: "y.i[2]" });
  expect(again.error).toBe(true);
  expect(again.text).toContain("bit 2");
  expect((await mcp.tool("check", { sheet: "bits" })).data.errors).toBe(0);
});

test("build_part through MCP: a checked full adder on a named sheet, saved to the library without force", async () => {
  const ls = await mcp.tool("list_parts", { query: "adder" });
  expect(ls.data.parts.map(p => p.kind)).toEqual(expect.arrayContaining(["half_adder", "full_adder", "adder"]));
  const b = await mcp.tool("build_part", { kind: "full_adder", sheet: "fa3" });
  expect(b.error, b.text).toBe(false);
  expect(b.data).toMatchObject({ sheet: "fa3", verified: { pass: true } });
  const w = await mcp.tool("build_part", { part: "adder", bits: 4, bus: true, sheet: "add4" });    // aliases
  expect(w.data.ports.map(p => p.name + ":" + p.width)).toEqual(["a:4", "b:4", "cin:1", "s:4", "cout:1"]);
  const sv = await mcp.tool("save_module", { sheet: "fa3", name: "FA_checked" });
  expect(sv.error, sv.text).toBe(false);
  expect(sv.data.verified).toContain("full_adder");
  const f = await mcp.tool("build_circuit", { formula: "y = a&b | ~c", sheet: "eq1" });
  expect(f.data.truth_table.columns.y).toBe("10101011");
  await mcp.tool("delete_module", { module: "FA_checked" });
});

test("a call that only waits (approval_status) does not hold up the others", async () => {
  await mcp.tool("request_approval", { summary: "test" });
  const t0 = Date.now();
  const waiting = mcp.tool("approval_status", { wait: 12 });          // waits for the user's click
  await new Promise(r => setTimeout(r, 500));
  const st = await mcp.tool("status");                                 // sent meanwhile
  expect(st.error, st.text).toBe(false);
  expect(Date.now() - t0).toBeLessThan(6000);                          // answered while the other still waits
  expect((await waiting).data.status).toBe("waiting");
  await page.evaluate(() => { const c = document.getElementById("mcpApproval"); if (c) c.remove(); MCPB.approval = { state: "none" }; });
});
