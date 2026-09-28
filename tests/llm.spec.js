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
  fs.writeFileSync(path.join(data, "models", "Qwen3.5-9B-Q4_K_M.gguf"), "GGUF");
  fs.writeFileSync(path.join(bin, "llama-server"), `#!/usr/bin/env python3
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
port = int(sys.argv[sys.argv.index("--port") + 1]); model = sys.argv[sys.argv.index("-m") + 1]
print("fake llama-server loading", model, flush=True)
EMB = "--embedding" in sys.argv
with open(sys.argv[0] + (".embed" if EMB else "") + ".args", "w") as f: f.write(" ".join(sys.argv[1:]))
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, o):
        b = json.dumps(o).encode(); self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self): self._j({"status": "ok"})
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path.startswith("/v1/embeddings"):     # a toy embedding: which topic words the text has
            with open(sys.argv[0] + ".embed.count", "a") as f: f.write("x")
            inp = req["input"] if isinstance(req["input"], list) else [req["input"]]
            topics = [("adder", "บวก", "sum"), ("counter", "นับ"), ("segment", "7-seg", "ตัวถอดรหัส")]
            vec = lambda t: [float(sum(t.lower().count(w) for w in ws)) for ws in topics] + [0.01]
            return self._j({"data": [{"index": i, "embedding": vec(t)} for i, t in enumerate(inp)]})
        msgs = req.get("messages") or []
        import os
        if req.get("tools"):
            with open(sys.argv[0] + ".kw", "a") as f: f.write(json.dumps(req.get("chat_template_kwargs")) + "\\n")
            if os.path.exists(sys.argv[0] + ".crash"):      # die mid-request, like WinError 10054
                os.remove(sys.argv[0] + ".crash"); os._exit(1)
        if not req.get("tools"):
            return self._j({"choices": [{"message": {"content": "latch ไวต่อระดับสัญญาณ ส่วน flip-flop ไวต่อขอบ clock"}}]})
        # a scripted agent: the tool results so far decide the next step (like a model reading them)
        done = [m for m in msgs if m.get("role") == "tool"]
        last = done[-1]["content"] if done else ""
        def call(name, args, think):
            return self._j({"choices": [{"message": {"content": "", "reasoning_content": think, "tool_calls": [
                {"id": "c%d" % len(done), "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}}],
                "usage": {"prompt_tokens": 1000 + 50 * len(msgs), "completion_tokens": 40}})
        tt = {"inputs": ["a", "b"], "outputs": ["sum", "carry"], "columns": {"sum": "0110", "carry": "0001"}}
        if len(done) == 0:
            return call("build_circuit", {"name": "ha_agent", "truth_table": tt, "colour": "red"}, "half adder = truth table")
        if len(done) == 1:        # the wrong field came back as an error: fix the call
            assert "unknown field 'colour'" in last, last
            return call("build_circuit", {"name": "ha_agent", "truth_table": tt}, "drop the bad field")
        nudged = any("did not verify" in str(m.get("content")) for m in msgs)
        if len(done) == 2 and not nudged:     # stopping here gets a nudge: verify first
            return self._j({"choices": [{"message": {"content": "เสร็จแล้ว"}}]})
        if not any('"errors"' in m["content"] for m in done):
            return call("check", {"sheet": "ha_agent"}, "verify")
        if not any('"columns"' in m["content"] for m in done):
            return call("simulate", {"sheet": "ha_agent"}, "simulate")
        return self._j({"choices": [{"message": {"content": "สร้าง half adder แล้ว ตรวจไม่มี error และจำลองได้ sum=0110 carry=0001"}}]})
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

test("agent mode: the local model works through the tools; Claude drives the chat over MCP and reads every step", async ({ page, context }) => {
  test.setTimeout(90000);
  await page.goto(BASE + "/");
  await page.click('nav button[data-tab="settings"]');
  await page.click("#llmStart");
  await expect(page.locator("#llmState")).toContainText("พร้อมใช้", { timeout: 10000 });
  // started without -ngl (llama.cpp fits the layers itself), with tool calls and a 64K context
  const bin = path.join(home, ".local", "share", "fpga-ecosystem", "llama", "llama-test-bin", "llama-server");
  const ed = await context.newPage();
  ed.errors = []; ed.on("pageerror", e => ed.errors.push(e.message));
  await ed.goto(BASE + "/studio.html");
  await ed.waitForFunction(() => typeof MCPB === "object" && MCPB.on);
  await ed.evaluate(() => document.querySelectorAll(".modal-bg").forEach(m => m.remove()));
  // Claude's side: the real MCP server
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
                APPDATA: path.join(home, "AppData"), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  const srv = spawn("python3", [path.join(__dirname, "..", "launcher", "mcp_server.py")], { env });
  let buf = "", n = 0; const waiting = {};
  srv.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (l.trim()) { const m = JSON.parse(l); if (waiting[m.id]) { waiting[m.id](m); delete waiting[m.id]; } } } });
  const rpc = (method, params) => new Promise(res => { const id = ++n; waiting[id] = res; srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const tool = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args || {} }); const t = r.result.content[0].text;
    let data = null; try { data = JSON.parse(t); } catch (_) {} return { error: !!r.result.isError, text: t, data }; };
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const st = await tool("ai_model", { action: "status" });
    expect(st.data, st.text).not.toBe(null);
    expect(st.data.state).toBe("ready");
    expect(st.data.catalog[0].id).toBe("qwen3.5-9b");
    expect(fs.readFileSync(bin + ".args", "utf-8")).toBe(`-m ${path.join(home, ".local", "share", "fpga-ecosystem", "models", "Qwen3.5-9B-Q4_K_M.gguf")} --host 127.0.0.1 --port ${LPORT} -c 65536 --jinja -fa on -ctk q8_0 -ctv q8_0 -np 1 --cache-ram 1024`);
    const go = await tool("ai_chat", { message: "ทำวงจร sum กับ carry ของ a และ b ให้หน่อย", mode: "agent" });
    expect(go.error, go.text).toBe(false);
    let s = await tool("ai_chat_status", { wait: 30 });
    expect(s.data.state).toBe("done");
    const a = s.data.agent;
    expect(a.state, JSON.stringify(a)).toBe("done");
    const tools = a.steps.filter(x => x.tool);
    expect(tools.map(x => x.tool)).toEqual(["build_circuit", "build_circuit", "check", "simulate"]);
    expect(tools[0].ok).toBe(false);                               // the bad field was refused, with the fields it takes
    expect(tools[0].error).toContain("build_circuit takes:");
    expect(a.steps.some(x => x.kind === "nudge")).toBe(true);      // "done" without verifying → asked to check first
    expect(a.steps.some(x => x.kind === "think" && /half adder/.test(x.text))).toBe(true);
    expect(a.final).toContain("sum=0110");
    expect(s.data.chat[0]).toEqual({ role: "user", text: "ทำวงจร sum กับ carry ของ a และ b ให้หน่อย" });
    expect(s.data.chat.pop().text).toContain("จำลองได้");
    // the user watched it happen: the sheet is there, and each step is a line in the chat
    expect(await ed.evaluate(() => activeSch().name)).toBe("ha_agent");
    expect(await ed.locator("#acLog .ag-step").count()).toBe(4);
    // and the run is logged for later (examples / debugging)
    const logs = fs.readdirSync(path.join(home, ".config", "fpga-ecosystem", "agent-runs"));
    expect(logs.length).toBe(1);
    // it thinks to plan and when nudged, not on every routine call
    const kw = fs.readFileSync(bin + ".kw", "utf-8").trim().split("\n").map(l => JSON.parse(l).enable_thinking);
    expect(kw[0]).toBe(true);
    expect(kw.filter(x => x === false).length).toBeGreaterThan(0);
    // the model server dies mid-run: it is started again and the run carries on
    fs.writeFileSync(bin + ".crash", "1");
    await ed.evaluate(() => { const s = Object.values(state.project.schematics).find(x => x.name === "ha_agent"); delete state.project.schematics[s.id]; state.openTabs = state.openTabs.filter(i => i !== s.id); renderAll(); });
    await tool("ai_chat", { message: "ทำวงจร sum กับ carry ของ a และ b อีกที", mode: "agent" });
    s = await tool("ai_chat_status", { wait: 40 });
    if (s.data.state !== "done") s = await tool("ai_chat_status", { wait: 40 });
    expect(s.data.agent.steps.some(x => x.kind === "restart"), JSON.stringify(s.data.agent)).toBe(true);
    expect(s.data.agent.state).toBe("done");
    expect(s.data.agent.final).toContain("sum=0110");
    // a part it can name: built and checked with no model call at all
    await tool("ai_chat", { message: "สร้าง full adder ลงชีต fa3", mode: "agent" });
    s = await tool("ai_chat_status", { wait: 30 });
    expect(s.data.agent.model_calls).toBe(0);
    expect(s.data.agent.steps.find(x => x.tool === "build_part")).toMatchObject({ ok: true });
    expect(s.data.agent.final).toContain("fa3");
    expect(s.data.agent.final).toContain("ตรวจแล้วถูกต้อง");
    expect(ed.errors).toEqual([]);
  } finally { srv.kill(); }
});

test("semantic search over the course notes: the embedding model runs on the CPU beside the chat model", async ({ request }) => {
  test.setTimeout(120000);
  const data = path.join(home, ".local", "share", "fpga-ecosystem");
  const bin = path.join(data, "llama", "llama-test-bin", "llama-server");
  let r = await (await request.get(BASE + "/api/rag/search?k=3&q=" + encodeURIComponent("วงจรบวกเลข"))).json();
  expect(r.mode).toBe("bm25");                                   // no embedding model yet: keyword search still works
  expect(r.semantic).toContain("no embedding model");
  fs.mkdirSync(path.join(data, "models", "embed"), { recursive: true });
  fs.writeFileSync(path.join(data, "models", "embed", "Qwen3-Embedding-0.6B-Q8_0.gguf"), "GGUF");
  // the first search answers at once (keyword) while the notes are embedded in the background
  const t0 = Date.now();
  r = await (await request.get(BASE + "/api/rag/search?k=3&q=" + encodeURIComponent("วงจรบวกเลข"))).json();
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(r.mode).toBe("bm25");
  expect(r.semantic).toContain("being built in the background");
  await expect.poll(async () => (await (await request.get(BASE + "/api/rag/search?k=3&q=" + encodeURIComponent("วงจรบวกเลข"))).json()).mode,
    { timeout: 30000 }).toBe("hybrid");
  r = await (await request.get(BASE + "/api/rag/search?k=3&q=" + encodeURIComponent("วงจรบวกเลข"))).json();
  expect(fs.readFileSync(bin + ".embed.args", "utf-8")).toContain("--embedding --pooling last -ngl 0");
  expect(fs.readFileSync(bin + ".embed.args", "utf-8")).toContain("-t 4 -tb 4");
  expect(r.hits.some(h => /adder|บวก/i.test(h.title + h.text))).toBe(true);
  // the documents were embedded once; the next query only embeds the query
  const n1 = fs.readFileSync(bin + ".embed.count", "utf-8").length;
  await request.get(BASE + "/api/rag/search?q=counter");
  expect(fs.readFileSync(bin + ".embed.count", "utf-8").length).toBe(n1 + 1);
  const st = await (await request.get(BASE + "/api/llm/status")).json();
  expect(st.embed).toMatchObject({ id: "qwen3-embedding-0.6b", installed: true, running: true });
});
