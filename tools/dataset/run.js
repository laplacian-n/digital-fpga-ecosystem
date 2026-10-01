#!/usr/bin/env node
// Runs tasks through the app's REAL agent loop with the teacher (teacher.py) in place of the model,
// checks every circuit against the task's known truth table, and writes the passing conversations.
//
//   node tools/dataset/run.js --tasks tasks.jsonl --out out/ [--limit 50] [--split train]
//
// out/train.jsonl   one conversation per line: {id, cat, messages, meta}  (tools: out/tools.json)
// out/eval.jsonl    eval-split tasks with their answers, never trained on: {id, cat, message, truth}
// out/rejected.jsonl what failed and why (fix the generator / teacher, not the rows)
// out/stats.json    counts
const { chromium } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const TASKS = path.resolve(arg("tasks", "tasks.jsonl")), OUT = path.resolve(arg("out", "out"));
const LIMIT = +arg("limit", 1e9), SPLIT = arg("split", "train");
const PORT = 19600 + Math.floor(Math.random() * 200), LPORT = PORT + 300, BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const all = fs.readFileSync(TASKS, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  // eval tasks are only written out (with their answers); the model never sees them in training
  const evalRows = all.filter(t => t.split === "eval").map(t => ({ id: t.id, cat: t.cat, message: t.message,
    truth: { out: t.out, inputs: t.inputs, ones: t.ones, formula: t.formula, sheet: t.sheet } }));
  fs.writeFileSync(path.join(OUT, "eval.jsonl"), evalRows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const tasks = all.filter(t => t.split === SPLIT).slice(0, LIMIT);

  // a private app: its own home, the teacher installed as "llama-server", a dummy 4B model file
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fe-data-"));
  const tdir = path.join(home, "teacher");
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, "tasks.jsonl"), tasks.map(t => JSON.stringify(t)).join("\n") + "\n");
  const data = path.join(home, ".local", "share", "fpga-ecosystem");
  const bin = path.join(data, "llama", "teacher-bin"); fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(data, "models"), { recursive: true });
  fs.writeFileSync(path.join(data, "models", "Qwen3.5-4B-Q6_K.gguf"), "GGUF");
  fs.copyFileSync(path.join(__dirname, "teacher.py"), path.join(bin, "llama-server"));
  fs.chmodSync(path.join(bin, "llama-server"), 0o755);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
                APPDATA: path.join(home, "AppData"), FE_TEACHER_DIR: tdir, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  const app = spawn("python3", [path.join(ROOT, "launcher", "app.py"), "--no-open", "--port", String(PORT)], { env, stdio: "ignore" });
  const post = (u, b) => fetch(BASE + u, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(b || {}) }).then(r => r.json());
  let browser;
  const stats = { tasks: tasks.length, ok: 0, rejected: 0, reasons: {}, eval: evalRows.length, started: new Date().toISOString() };
  const train = fs.createWriteStream(path.join(OUT, "train.jsonl"), { flags: "a" });
  const rej = fs.createWriteStream(path.join(OUT, "rejected.jsonl"), { flags: "a" });
  const reject = (t, why, extra) => { stats.rejected++; stats.reasons[why] = (stats.reasons[why] || 0) + 1;
    rej.write(JSON.stringify(Object.assign({ id: t.id, message: t.message, why }, extra || {})) + "\n"); };
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + "/api/info")).ok) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
    const cfg = await (await fetch(BASE + "/api/config")).json();
    cfg.features.llm_endpoint = `http://127.0.0.1:${LPORT}/v1/chat/completions`; cfg.features.llama_args = "";
    await post("/api/config", cfg);
    const st = await post("/api/llm/start", {});
    if (!st.ok) throw new Error("could not start the teacher: " + JSON.stringify(st));
    for (let i = 0; i < 40; i++) { const s = await (await fetch(BASE + "/api/llm/status")).json(); if (s.state === "ready") break; await new Promise(r => setTimeout(r, 250)); }

    browser = await chromium.launch();
    const page = await (await browser.newContext()).newPage();
    const fresh = async () => {        // a new, empty project for every task (the system prompt lists the sheets)
      await page.goto(BASE + "/studio.html");
      await page.waitForFunction(() => typeof MCP_OPS === "object" && typeof aiAgentRun === "function");
      await page.evaluate(() => { document.querySelectorAll(".modal-bg").forEach(m => m.remove());
        const keep = localStorage.getItem("schstudio.agentRuns"); localStorage.clear(); if (keep) localStorage.setItem("schstudio.agentRuns", keep); });
      await page.reload();
      await page.waitForFunction(() => typeof MCP_OPS === "object" && typeof aiAgentRun === "function");
      await page.waitForTimeout(600);
      await page.evaluate(() => document.querySelectorAll(".modal-bg").forEach(m => m.remove()));
    };
    let toolsSaved = false;
    for (const [k, t] of tasks.entries()) {
      const t0 = Date.now();
      await fresh();
      // 1. before the run: the ground truth agrees with the app's own reading, and the app cannot answer
      //    it by itself (then the model never sees the request)
      const pre = await page.evaluate(t => {
        const o = oracleDerive(t.message), r = { ok: true, oracle: o.ok ? o.what : null };
        if (t.cat === "nl_logic") {
          for (const q of (t.outputs || [t])) {
            const F = formulaTable(t.formula, q.inputs), col = F.cols[q.out];
            const want = Array.from({ length: 1 << q.inputs.length }, (_, i) => q.ones.includes(i) ? "1" : "0").join("");
            if (col !== want) return Object.assign(r, { ok: false, why: "truth table disagrees with the app", col, want });
          }
        }
        try {                                                   // what aiagFastPath would build before any model call
          const q = aiLooksLikeQuestion(t.message) && !AIAG_MAKE_RE.test(t.message), fp = !q && partFromMessage(t.message);
          if (fp) r.part = fp.kind;
        } catch (_) {}
        return r;
      }, t);
      if (!pre.ok) { reject(t, pre.why, pre); continue; }
      if (pre.oracle && t.cat !== "qa") { reject(t, "the app answers it without the model (oracle)", { oracle: pre.oracle }); continue; }
      // a circuit that must be there before the request (drawn the way a user / earlier run left it)
      if (t.setup) {
        const su = await page.evaluate(async steps => { try { for (const [op, args] of steps) await MCP_OPS[op](args); return { ok: true }; }
          catch (e) { return { ok: false, why: String(e && e.message || e) }; } }, t.setup);
        if (!su.ok) { reject(t, "setup failed: " + su.why); continue; }
      }
      if (pre.part) { reject(t, "the app builds it from the part library (fast path)", { part: pre.part }); continue; }
      // 2. the run, exactly as a user's
      const run = await page.evaluate(async msg => {
        MCP_OPS.ai_chat({ message: msg, mode: "agent" });
        let s; for (let i = 0; i < 20; i++) { s = await MCP_OPS.ai_chat_status({ wait: 20 }); if (s.state === "done") break; }
        return s;
      }, t.message);
      const raw = (() => { try { return JSON.parse(fs.readFileSync(path.join(tdir, "raw", t.id.replace(/[^\w.-]/g, "_") + ".json"), "utf-8")); } catch (_) { return null; } })();
      if (!raw || !raw.done) { reject(t, "the run did not finish", { state: run && run.state }); continue; }
      if (raw.failed) { reject(t, "teacher: " + raw.turns.slice(-1)[0].content.slice(0, 80), { steps: run.agent && run.agent.steps }); continue; }
      // 3. the circuit on the sheet, against what the task means — outside the conversation
      const sheet = t.use_sheet;
      // a question: answered with no tool call, nothing changed
      const chk = t.cat === "qa" ? ((run.agent && (run.agent.steps || []).some(x => x.tool)) ? { ok: false, why: "a question took tool calls" } : { ok: true }) : await page.evaluate(({ t, sheet }) => {
        const s = Object.values(state.project.schematics).find(x => x.name === sheet);
        if (!s) return { ok: false, why: "no sheet " + sheet };
        const lc = a => a.map(x => String(x).toLowerCase());     // names compare like VHDL: case-insensitive
        if (t.cat === "nl_logic") {
          const j = clientCombSim(s); if (!j.ok) return { ok: false, why: j.reason };
          const tt = j.truth_table, bad = [];
          for (const q of (t.outputs || [t])) {
            const oi = lc(tt.outputs).indexOf(q.out.toLowerCase()); if (oi < 0) return { ok: false, why: "no output " + q.out + " (has " + tt.outputs.join(",") + ")" };
            const pos = q.inputs.map(n => lc(tt.inputs).indexOf(n.toLowerCase())); if (pos.some(p => p < 0)) return { ok: false, why: "inputs " + tt.inputs.join(",") };
            tt.rows.forEach(([bits, o]) => { const r = pos.reduce((v, p) => v * 2 + (+bits[p]), 0); if ((o[oi] ? 1 : 0) !== (q.ones.includes(r) ? 1 : 0)) bad.push(q.out + "@" + r); });
          }
          return { ok: !bad.length, why: bad.length ? "rows differ: " + bad.slice(0, 8).join(",") : "" };
        }
        if (t.cat === "nl_fsm") {                               // a 64-clock stream the conversation never used
          const ins = s.components.filter(c => c.type === "IN"), V = t.verify;
          const holdAt = i => { const v = V.inputs[i] || {}, o = {}; Object.entries(v).forEach(([n, val]) => { const c = ins.find(x => String(x.params.name).toLowerCase() === n.toLowerCase()); if (c) o[c.id] = val; }); return o; };
          const j = clientSeqSim(s, V.inputs.length, { holdAt, hold: holdAt(0) }); if (!j.ok) return { ok: false, why: j.reason };
          const sq = j.sequence, bad = [];
          Object.entries(V.expect).forEach(([o, L]) => { const k = lc(sq.outputs).indexOf(o.toLowerCase()); if (k < 0) { bad.push("no output " + o); return; }
            L.forEach((w, i) => { const row = sq.rows[i], got = row[4] ? row[4][k] : row[3][k]; if (got !== w) bad.push(o + "@" + i); }); });
          return { ok: !bad.length, why: bad.slice(0, 8).join(",") };
        }
        if (t.cat === "nl_pins") {
          const pm = s.pinmap || {}, bad = Object.entries(t.map).filter(([k, v]) => pm[k] !== v).map(([k, v]) => `${k}: ${pm[k]} ≠ ${v}`);
          return { ok: !bad.length, why: bad.join(", ") };
        }
        return { ok: false, why: "no check for " + t.cat };
      }, { t, sheet });
      if (!chk.ok) { reject(t, "circuit wrong: " + chk.why); continue; }
      const a = run.agent || {};
      if (t.cat !== "qa" && !a.verified) { reject(t, "the app did not count it verified", { final: a.final, nudges: (a.steps || []).filter(x => x.kind === "nudge").map(x => x.text) }); continue; }
      // 4. the row: what the app sent the model, with the model's own turns as it gave them
      // assistant turns after the request are the teacher's own (the app rewrites the first one's content
      // as "(my plan) …" in later requests); earlier ones are chat history (the editor's greeting): not trained on
      const ask = raw.messages.findIndex(m => m.role === "user" && !String(m.content).startsWith("(system)"));
      let ti = 0;
      const messages = raw.messages.map((m, i) => m.role === "assistant" && i > ask ? Object.assign({}, raw.turns[ti++]) : m);
      // a planned mistake is in the conversation (the error and the fix are the lesson) but never a target:
      // `train: false` = mask it out of the loss
      if (t.mistake) { const k = messages.findIndex((m, i) => i > ask && m.role === "assistant"); if (k > 0) messages[k].train = false; }
      // the chat protocol: an assistant turn with tool calls is followed by exactly its tool results
      const order = (() => { for (let i = 0; i < messages.length; i++) { const m = messages[i]; if (!m.tool_calls) continue;
        const ids = m.tool_calls.map(c => c.id), got = messages.slice(i + 1, i + 1 + ids.length);
        if (got.length !== ids.length || got.some((g, j) => g.role !== "tool" || g.tool_call_id !== ids[j])) return "tool results out of order after message " + i; } return ""; })();
      if (order) { reject(t, order); continue; }
      if (!toolsSaved) { fs.writeFileSync(path.join(OUT, "tools.json"), JSON.stringify(raw.tools, null, 1)); toolsSaved = true; }
      train.write(JSON.stringify({ id: t.id, cat: t.cat, messages, meta: { train_from: ask + 1, formula: t.formula, mistake: t.mistake, sheet, checked: a.verified && a.verified.checked,
        steps: (a.steps || []).filter(s => s.tool).map(s => s.tool), nudges: (a.steps || []).filter(s => s.kind === "nudge").map(s => s.text),
        request_options: raw.request_options, seconds: (Date.now() - t0) / 1000 } }) + "\n");
      stats.ok++;
      if ((k + 1) % 25 === 0) process.stderr.write(`${k + 1}/${tasks.length} ok ${stats.ok} rejected ${stats.rejected}\n`);
    }
  } finally {
    stats.finished = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, "stats.json"), JSON.stringify(stats, null, 1));
    train.end(); rej.end();
    try { await post("/api/llm/stop", {}); await post("/api/quit", {}); } catch (_) {}
    if (browser) await browser.close();
    app.kill();
  }
  console.log(JSON.stringify(stats, null, 1));
}
main().catch(e => { console.error(e); process.exit(1); });
