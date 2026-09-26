// Launcher update check against a stub of the GitHub Releases API.
const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs"), os = require("os"), path = require("path");

const PORT = 18990 + Math.floor(Math.random() * 9);
const BASE = `http://127.0.0.1:${PORT}`;
let proc, stub, stubPort, release = null;

test.beforeAll(async () => {
  stub = http.createServer((req, res) => {
    if (req.url === "/repos/test/repo/releases/latest" && release) {
      res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(release));
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise(r => stub.listen(0, "127.0.0.1", r));
  stubPort = stub.address().port;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fe-upd-"));
  const cfgDir = path.join(home, ".config", "fpga-ecosystem");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ update: { repo: "test/repo", api: `http://127.0.0.1:${stubPort}` } }));
  proc = spawn(process.platform === "win32" ? "python" : "python3",
    [path.join(__dirname, "..", "launcher", "app.py"), "--no-open", "--port", String(PORT)],
    { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/api/info")).ok) return; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error("launcher did not start");
});
test.afterAll(async () => { try { await fetch(BASE + "/api/quit", { method: "POST", body: "{}" }); } catch (_) {} proc && proc.kill(); stub && stub.close(); });

test("no release yet (or private repo) is reported, not an error page", async ({ request }) => {
  release = null;
  const r = await (await request.get(BASE + "/api/update/check?force=1")).json();
  expect(r.ok).toBe(false);
  expect(r.error).toContain("release");
});

test("newer release is offered, can be skipped, banner follows", async ({ request, page }) => {
  release = { tag_name: "v9.9.9", body: "- เร็วขึ้น\n- แก้บั๊ก", html_url: "https://example.invalid/rel",
    assets: [{ name: "FPGAEcosystem-Setup-9.9.9.exe", browser_download_url: "https://example.invalid/setup.exe" },
             { name: "FPGAEcosystem-Portable-9.9.9.zip", browser_download_url: "https://example.invalid/p.zip" }] };
  const r = await (await request.get(BASE + "/api/update/check?force=1")).json();
  expect(r).toMatchObject({ ok: true, available: true, latest: "9.9.9", asset_name: "FPGAEcosystem-Setup-9.9.9.exe", can_install: false });
  // from source / not Windows: install sends the user to the release page
  const inst = await (await request.post(BASE + "/api/update/install", { data: {} })).json();
  expect(inst).toMatchObject({ manual: true, url: "https://example.invalid/rel" });

  await page.goto(BASE + "/");
  await expect(page.locator("#updBanner")).toBeVisible();
  await expect(page.locator("#updVer")).toHaveText("v9.9.9");
  await page.click("#updSkip");
  await expect(page.locator("#updBanner")).toBeHidden();
  const again = await (await request.get(BASE + "/api/update/check")).json();   // cached, not forced
  expect(again.skipped).toBe(true);
  await page.reload();
  await expect(page.locator("#updBanner")).toBeHidden();
});

test("same version is not offered", async ({ request }) => {
  const cur = (await (await request.get(BASE + "/api/info")).json()).version;
  release = { tag_name: "v" + cur, assets: [] };
  const r = await (await request.get(BASE + "/api/update/check?force=1")).json();
  expect(r.available).toBe(false);
});
