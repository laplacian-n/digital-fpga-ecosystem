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

test("Home: สร้าง opens the editor on the new project, saved into its folder; an empty folder opens too", async ({ page, request }) => {
  await (await request.post(BASE + "/api/projects/new", { data: { name: "lab9" }, headers: { Origin: BASE } })).json();
  await page.goto(BASE + "/");
  await expect(page.locator("#projects .row", { hasText: "lab9" }).locator('[data-act="open"]')).toHaveCount(1);   // no file yet, still openable
  await page.goto(BASE + "/studio.html?new=lab9");
  await page.waitForFunction(() => typeof UX === "object" && state.project && state.project.name === "lab9");
  await expect(page.locator("#projectName")).toHaveValue("lab9");
  await expect.poll(async () => (await (await request.get(BASE + "/api/projects")).json()).projects.find(p => p.name === "lab9").main)
    .toBe("lab9/lab9.schproj.json");
  // opening it again does not make a second project
  await page.goto(BASE + "/studio.html?new=lab9");
  await page.waitForFunction(() => state.project && state.project.name === "lab9");
  expect(await page.evaluate(() => Object.values(state.projects).filter(p => /^lab9/.test(p.name)).length)).toBe(1);
});

test("a project folder holds one project: open from Home loads only it, saving writes only it", async ({ page, request }) => {
  const dir = (await (await request.get(BASE + "/api/projects")).json()).dir;
  await page.goto(BASE + "/studio.html");
  await page.waitForFunction(() => typeof UX === "object");
  await page.evaluate(() => document.querySelectorAll(".modal-bg").forEach(m => m.remove()));
  // an older file: the whole workspace (lab6 + lab5_2, lab5_2 active) saved into lab6's folder
  const multi = await page.evaluate(() => { state.project.name = "lab6"; $("#projectName").value = "lab6";
    addProject("lab5_2"); return serialize(); });
  expect(Object.keys(JSON.parse(multi).workspace.projects).length).toBe(2);
  fs.mkdirSync(path.join(dir, "lab6"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lab6", "lab6.schproj.json"), multi);
  await page.goto(BASE + "/studio.html?open=" + encodeURIComponent("lab6/lab6.schproj.json"));
  await page.waitForFunction(() => typeof UX === "object" && state.project && state.project.name === "lab6");
  expect(await page.evaluate(() => Object.values(state.projects).map(p => p.name))).toEqual(["lab6"]);
  // and saving it back writes lab6 alone
  await page.evaluate(() => { addProject("scratch"); switchProject(Object.values(state.projects).find(p => p.name === "lab6").id); });
  await page.evaluate(() => saveProjectToFile());
  await expect.poll(() => { try { return Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "lab6", "lab6.schproj.json"), "utf-8")).workspace.projects).length; } catch (_) { return -1; } }).toBe(1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "lab6", "lab6.schproj.json"), "utf-8"));
  expect(Object.values(saved.workspace.projects)[0].name).toBe("lab6");
  expect(saved.project.name).toBe("lab6");
});
