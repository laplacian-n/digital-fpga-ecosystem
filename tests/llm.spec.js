// Local model from Settings: pick a model, start it, the editor's chat uses it — no terminal.
const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const PORT = 19400 + Math.floor(Math.random() * 80), LPORT = PORT + 100;
const BASE = `http://127.0.0.1:${PORT}`;
let proc, home;

test.skip(process.platform === "win32", "the fake llama-server is a python script with a shebang");
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "fe-llm-"));
  const data = path.join(home, ".local", "share", "fpga-ecosystem");
  // what "ดาวน์โหลด" leaves behind: llama.cpp unpacked under llama/, a model under models/
  const bin = path.join(data, "llama", "llama-test-bin"); fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(data, "models"), { recursive: true });
  fs.writeFileSync(path.join(data, "models", "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"), "GGUF");
  fs.writeFileSync(path.join(bin, "llama-server"), `#!/usr/bin/env python3
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
port = int(sys.argv[sys.argv.index("--port") + 1]); model = sys.argv[sys.argv.index("-m") + 1]
print("fake llama-server loading", model, flush=True)
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, o):
        b = json.dumps(o).encode(); self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self): self._j({"status": "ok"})
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self._j({"choices": [{"message": {"content": "latch ไวต่อระดับสัญญาณ ส่วน flip-flop ไวต่อขอบ clock"}}]})
HTTPServer(("127.0.0.1", port), H).serve_forever()
`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
                APPDATA: path.join(home, "AppData"), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  proc = spawn("python3", [path.join(__dirname, "..", "launcher", "app.py"), "--no-open", "--port", String(PORT)], { env, stdio: "ignore" });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/api/info")).ok) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const cfg = await (await fetch(BASE + "/api/config")).json();
  cfg.features.llm_endpoint = `http://127.0.0.1:${LPORT}/v1/chat/completions`; cfg.features.llama_args = "";
  await fetch(BASE + "/api/config", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(cfg) });
});
test.afterAll(async () => { try { await fetch(BASE + "/api/llm/stop", { method: "POST", headers: { Origin: BASE }, body: "{}" }); await fetch(BASE + "/api/quit", { method: "POST", body: "{}" }); } catch (_) {} proc && proc.kill(); });

test("start the model from Settings, then the chat answers with it", async ({ page, context }) => {
  await page.goto(BASE + "/");
  await page.click('nav button[data-tab="settings"]');
  await expect(page.locator("#llmServer")).toContainText("พร้อม");            // found under the data folder
  await expect(page.locator("#llmModels .mdl").first()).toContainText("มีแล้ว");
  await expect(page.locator("#llmState")).toContainText("ยังไม่ได้เริ่ม");
  await page.locator("#llmCard").screenshot({ path: test.info().outputPath("llm-card.png") });
  await page.click("#llmStart");
  await expect(page.locator("#llmState")).toContainText("พร้อมใช้", { timeout: 10000 });
  // the editor's chat (llm was "off" at start-up) now reaches the model without a restart
  const ed = await context.newPage();
  await ed.goto(BASE + "/studio.html");
  await ed.waitForFunction(() => typeof aiSend === "function");
  await ed.waitForTimeout(800);
  await ed.evaluate(() => document.querySelectorAll(".modal-bg").forEach(m => m.remove()));
  const txt = await ed.evaluate(async () => { document.querySelector("#acInput").value = "flip-flop ต่างจาก latch ยังไง"; await aiSend();
    return [...document.querySelectorAll("#acLog > *")].pop().innerText; });
  expect(txt).toContain("ไวต่อขอบ clock");
  await page.click("#llmStop");
  await expect(page.locator("#llmState")).toContainText("ยังไม่ได้เริ่ม", { timeout: 10000 });
});
