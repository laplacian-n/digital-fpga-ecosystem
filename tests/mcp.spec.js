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
