// Launcher: one server, backend in-process, editor downloads land in the project folder.
const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const PORT = 18900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc, home;

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "fe-home-"));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), APPDATA: path.join(home, "AppData") };
  proc = spawn(process.platform === "win32" ? "python" : "python3",
    [path.join(__dirname, "..", "launcher", "app.py"), "--no-open", "--port", String(PORT)], { env, stdio: "ignore" });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/api/info")).ok) return; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error("launcher did not start");
});
test.afterAll(async () => { try { await fetch(BASE + "/api/quit", { method: "POST", body: "{}" }); } catch (_) {} proc && proc.kill(); });

test("backend runs in the launcher; paths outside the workspace are refused", async ({ request }) => {
  const st = await (await request.get(BASE + "/api/status")).json();
  expect(st.backend).toBe(true);
  const chat = await (await request.post(BASE + "/chat", { data: { message: "full adder" } })).json();
  expect(chat.status).toBe("VERIFIED");
  expect((await request.get(BASE + "/api/files/read?path=../../etc/passwd")).status()).toBe(403);
});

test("editor saves into the workspace project folder and reopens it", async ({ page, request }) => {
  await page.goto(BASE + "/studio.html");
  await page.waitForFunction(() => typeof UX === "object");
  await page.evaluate(() => document.querySelectorAll(".modal-bg").forEach(m => m.remove()));
  await page.fill("#projectName", "citest");
  await page.evaluate(() => saveProjectToFile());
  await expect.poll(async () => (await (await request.get(BASE + "/api/projects")).json()).projects.map(p => p.main)).toContain("citest/citest.schproj.json");
  await page.goto(BASE + "/studio.html?open=" + encodeURIComponent("citest/citest.schproj.json"));
  await page.waitForFunction(() => typeof UX === "object");
  await expect(page.locator("#projectName")).toHaveValue("citest");
  await expect(page.locator("#saveChip")).toHaveClass(/clean/);
});

test("Settings spots an old offline MCP server in Claude Desktop and removes it (with a backup)", async ({ request }) => {
  const f = path.join(home, ".config", "Claude", "claude_desktop_config.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ mcpServers: {
    "top-down-schematic": { command: "python", args: ["C:/x/topdown/topdown_mcp.py"] },
    "fpga-ecosystem": { command: "FPGAEcosystem-MCP.exe", args: [] }, "other": { command: "node", args: ["x.js"] } } }));
  let j = await (await request.get(BASE + "/api/mcp/setup")).json();
  expect(j.legacy).toEqual(["top-down-schematic"]);
  const r = await (await request.post(BASE + "/api/mcp/remove_legacy", { data: {}, headers: { Origin: BASE } })).json();
  expect(r).toMatchObject({ ok: true, removed: ["top-down-schematic"] });
  const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
  expect(Object.keys(cfg.mcpServers).sort()).toEqual(["fpga-ecosystem", "other"]);
  expect(fs.existsSync(f.replace(/\.json$/, ".json.bak"))).toBe(true);
  j = await (await request.get(BASE + "/api/mcp/setup")).json();
  expect(j.legacy).toEqual([]);
});
