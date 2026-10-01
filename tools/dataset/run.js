#!/usr/bin/env node
// Runs tasks through the app's REAL agent loop, in a private copy of the app (its own home folder:
// your projects and settings are never touched).
//
// Making data — the teacher (teacher.py) stands in for llama-server and answers from the task:
//   node tools/dataset/run.js --tasks tasks.jsonl --out out/ [--limit 50] [--split train]
//   out/train.jsonl     one conversation per line: {id, cat, messages, meta}   (tool schemas: out/tools.json)
//   out/eval.jsonl      the eval-split tasks (full, with their answers) — never trained on
//   out/rejected.jsonl  what failed and why (fix the generator / teacher, never the rows)
//
// Measuring a real model on the held-out tasks (before / after training):
//   node tools/dataset/run.js --eval-model Qwen3.5-4B-Q6_K.gguf --llama path/to/llama-server \
//        --tasks tools/dataset/data/eval_tasks.jsonl.gz --out eval_4b/ [--per-cat 20] [--budget 300]
//   out/eval_report.json + eval_report.md: pass rate per category, and every run's answer and steps.
//
// Every task is checked OUTSIDE the conversation against what it means (truth table, a 64-clock stream,
// the pin map, the function of a composed block, the number a question asks for).
const { chromium } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");

const ROOT = path.join(__dirname, "..", "..");
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const TASKS = path.resolve(arg("tasks", "tasks.jsonl")), OUT = path.resolve(arg("out", "out"));
const EVAL_MODEL = arg("eval-model", null), LLAMA = arg("llama", null);
const EVAL = !!EVAL_MODEL;
const LIMIT = +arg("limit", 1e9), SPLIT = arg("split", EVAL ? "eval" : "train"), PER_CAT = +arg("per-cat", 1e9);
const CHAIN = +arg("chain", 0);       // share of tasks sent as the next message in the same chat (history + earlier sheets)
const BUDGET = +arg("budget", 300), PY = arg("python", process.platform === "win32" ? "python" : "python3");
const PORT = 19600 + Math.floor(Math.random() * 200), LPORT = PORT + 300, BASE = `http://127.0.0.1:${PORT}`;

const readLines = p => (p.endsWith(".gz") ? zlib.gunzipSync(fs.readFileSync(p)).toString("utf-8") : fs.readFileSync(p, "utf-8"))
  .split("\n").filter(Boolean).map(l => JSON.parse(l));

/* in the page: is the circuit on `sheet` what task t means? */
function checkInPage({ t, sheet }) {
  const s = Object.values(state.project.schematics).find(x => x.name === sheet);
  if (!s) return { ok: false, why: "no sheet " + sheet };
  const lc = a => a.map(x => String(x).toLowerCase());     // names compare like VHDL: case-insensitive
  if (t.cat === "nl_logic" || t.cat === "nl_fix") {
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
  if (t.cat === "nl_compose") {                          // the function itself, not the part it was checked against
    const c = MCP_OPS.compare_sheets({ sheet, formula: t.check_formula });
    if (c.equivalent === true) return { ok: true };
    if (!/อินพุตรวม|too many/.test(String(c.reason)) || !/^\{cout,s\} = a \+ b \+ cin$/.test(t.check_formula))
      return { ok: false, why: JSON.stringify(c).slice(0, 300) };
    // an adder too wide for every row: 400 random sums, evaluated on the drawn circuit
    const fs = flattenSchematic(s).sch, st = probeStruct(fs), w = +/\[(\d+):0\]/.exec(t.plan.inputs[0])[1] + 1, bad = [];
    for (let i = 0; i < 400; i++) {
      const a = Math.floor(Math.random() * 2 ** w), b = Math.floor(Math.random() * 2 ** w), ci = Math.random() < 0.5 ? 1 : 0;
      let o; try { o = mcpEvalOuts(s, fs, st, { a, b, cin: ci }); } catch (e) { return { ok: false, why: e.message }; }
      const sum = a + b + ci;
      if (parseInt(o.s, 2) !== sum % 2 ** w || +o.cout !== (sum >> w)) bad.push(`${a}+${b}+${ci}`);
    }
    return { ok: !bad.length, why: "random sums wrong: " + bad.slice(0, 5).join(", ") };
  }
  if (t.cat === "nl_pins") {
    const pm = s.pinmap || {}, bad = Object.entries(t.map).filter(([k, v]) => pm[k] !== v).map(([k, v]) => `${k}: ${pm[k]} ≠ ${v}`);
    return { ok: !bad.length, why: bad.join(", ") };
  }
  return { ok: false, why: "no check for " + t.cat };
}

/* a question's answer: the number / code it asks for (spaces, commas ignored), or a minimal SOP that is right */
function gradeAnswer(t, text) {
  const norm = s => String(s || "").replace(/[\s,_]/g, "");
  const c = t.check || {};
  if (c.key != null) return String(c.key).split(" ").every(k => norm(text).includes(norm(k))) ? "" : "the answer does not contain " + c.key;
  if (c.ones) {
    const m = [...String(text).matchAll(/f\s*=\s*([^\n=]+)/g)].pop(); if (!m) return "no f = … in the answer";
    const expr = m[1].replace(/[·*]/g, "").trim(), names = c.names;
    for (let r = 0; r < 1 << c.n; r++) {
      const val = n => (r >> (c.n - 1 - names.indexOf(n))) & 1;
      const v = expr.split("+").some(term => { const lits = [...term.replace(/\s+/g, "").matchAll(/([a-d])('?)/g)]; if (!lits.length) return term.trim() === "1";
        return lits.every(([, n, neg]) => val(n) === (neg ? 0 : 1)); }) ? 1 : 0;
      if (v !== (c.ones.includes(r) ? 1 : 0)) return "f is wrong at row " + r;
    }
    return "";
  }
  return "";
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const all = readLines(TASKS);
  if (!EVAL) fs.writeFileSync(path.join(OUT, "eval.jsonl"), all.filter(t => t.split === "eval").map(t => JSON.stringify(t)).join("\n") + "\n");
  const per = {};
  const tasks = all.filter(t => t.split === SPLIT).filter(t => (per[t.cat] = (per[t.cat] || 0) + 1) <= PER_CAT).slice(0, LIMIT);

  // a private app: its own home; for data the teacher is installed as "llama-server" with a dummy model
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fe-data-"));
  const tdir = EVAL && process.env.FE_TEACHER_DIR ? process.env.FE_TEACHER_DIR : path.join(home, "teacher");   // (eval: a teacher as the model = a self-test)
  const data = process.platform === "win32" ? path.join(home, "AppData", "Local", "fpga-ecosystem") : path.join(home, ".local", "share", "fpga-ecosystem");
  if (!EVAL) {
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(path.join(tdir, "tasks.jsonl"), tasks.map(t => JSON.stringify(t)).join("\n") + "\n");
    const bin = path.join(data, "llama", "teacher-bin"); fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(data, "models"), { recursive: true });
    fs.writeFileSync(path.join(data, "models", "Qwen3.5-4B-Q6_K.gguf"), "GGUF");
    fs.copyFileSync(path.join(__dirname, "teacher.py"), path.join(bin, "llama-server"));
    fs.chmodSync(path.join(bin, "llama-server"), 0o755);
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
                APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), FE_TEACHER_DIR: tdir,
                NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  const app = spawn(PY, [path.join(ROOT, "launcher", "app.py"), "--no-open", "--port", String(PORT)], { env, stdio: "ignore" });
  const post = (u, b) => fetch(BASE + u, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(b || {}) }).then(r => r.json());
  let browser;
  const stats = { mode: EVAL ? "eval" : "data", tasks: tasks.length, ok: 0, rejected: 0, reasons: {}, started: new Date().toISOString() };
  const train = EVAL ? null : fs.createWriteStream(path.join(OUT, "train.jsonl"), { flags: "a" });
  const rej = fs.createWriteStream(path.join(OUT, EVAL ? "eval_runs.jsonl" : "rejected.jsonl"), { flags: "a" });
  const results = [];
  const reject = (t, why, extra) => { stats.rejected++; stats.reasons[why] = (stats.reasons[why] || 0) + 1;
    if (!EVAL) rej.write(JSON.stringify(Object.assign({ id: t.id, message: t.message, why }, extra || {})) + "\n"); };
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + "/api/info")).ok) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
    const cfg = await (await fetch(BASE + "/api/config")).json();
    cfg.features.llm_endpoint = `http://127.0.0.1:${LPORT}/v1/chat/completions`; cfg.features.llama_args = "";
    if (EVAL) { cfg.features.llama_server = path.resolve(LLAMA || ""); cfg.features.llama_model = path.resolve(EVAL_MODEL); }
    await post("/api/config", cfg);
    const st = await post("/api/llm/start", {});
    if (!st.ok) throw new Error("could not start the model server: " + JSON.stringify(st));
    for (let i = 0; i < (EVAL ? 600 : 40); i++) { const s = await (await fetch(BASE + "/api/llm/status")).json(); if (s.state === "ready") break;
      if (s.state === "crashed") throw new Error("the model server crashed: " + (s.log || "").slice(-800)); await new Promise(r => setTimeout(r, 250)); }

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
    const chainSheets = new Set();       // sheets already in the project of the current chat
    for (const [k, t] of tasks.entries()) {
      const t0 = Date.now();
      // usually a new, empty project; sometimes the next message in the same chat (not after a setup)
      const chained = k > 0 && !t.setup && !tasks[k - 1].setup && Math.random() < CHAIN && !chainSheets.has(t.use_sheet);
      if (!chained) { await fresh(); chainSheets.clear(); }
      chainSheets.add(t.use_sheet);
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
          if (fp && !fp.compose) r.part = fp.kind;
        } catch (_) {}
        return r;
      }, t);
      if (!EVAL) {
        if (!pre.ok) { reject(t, pre.why, pre); continue; }
        if (pre.oracle && t.cat !== "qa" && t.cat !== "nl_compose") { reject(t, "the app answers it without the model (oracle)", { oracle: pre.oracle }); continue; }
        if (pre.part) { reject(t, "the app builds it from the part library (fast path)", { part: pre.part }); continue; }
      }
      // a circuit that must be there before the request (drawn the way a user / earlier run left it)
      if (t.setup) {
        const su = await page.evaluate(async steps => { try { for (const [op, args] of steps) await MCP_OPS[op](args); return { ok: true }; }
          catch (e) { return { ok: false, why: String(e && e.message || e) }; } }, t.setup);
        if (!su.ok) { reject(t, "setup failed: " + su.why); continue; }
      }
      // 2. the run, exactly as a user's
      const run = await page.evaluate(async ({ msg, budget, evalMode }) => {
        MCP_OPS.ai_chat(Object.assign({ message: msg, mode: "agent" }, evalMode ? { escalate: false, budget_s: budget } : {}));
        let s; const until = Date.now() + 1000 * (budget + 180);
        while (Date.now() < until) { s = await MCP_OPS.ai_chat_status({ wait: 20 }); if (s.state === "done") break; }
        if (s.state !== "done") { try { await MCP_OPS.ai_chat_stop({}); } catch (_) {} }
        return s;
      }, { msg: t.message, budget: BUDGET, evalMode: EVAL });
      const a = (run && run.agent) || {};
      // 3. the result, against what the task means — outside the conversation. A real model names its own
      //    sheet when the request does not: then any sheet that does the job counts
      const sheets = await page.evaluate(() => Object.values(state.project.schematics).filter(s => s.components.some(c => c.type !== "JUNCTION")).map(s => s.name));
      let chk = { ok: false, why: "nothing built" };
      if (t.cat === "qa") {
        const tools = (a.steps || []).filter(x => x.tool && !x.fast_path);
        const why = EVAL ? gradeAnswer(t, a.final) : (tools.length ? "a question took tool calls" : "");
        chk = { ok: !why, why };
      } else {
        const cands = EVAL && !t.sheet && t.cat !== "nl_pins" && t.cat !== "nl_fix" ? [t.use_sheet, ...sheets.filter(n => n !== t.use_sheet)] : [t.use_sheet];
        for (const sheet of cands) { chk = await page.evaluate(checkInPage, { t, sheet }); if (chk.ok) { chk.sheet = sheet; break; } }
      }
      if (EVAL) {
        const res = { id: t.id, cat: t.cat, pass: !!chk.ok, why: chk.ok ? "" : chk.why, verified_by_app: !!a.verified, state: a.state,
          seconds: Math.round((Date.now() - t0) / 1000), model_calls: a.model_calls, tool_calls: (a.steps || []).filter(x => x.tool).length,
          tool_errors: (a.steps || []).filter(x => x.tool && x.ok === false).length, message: t.message, final: a.final,
          steps: (a.steps || []).map(x => x.tool ? { tool: x.tool, ok: x.ok, args: x.args, error: x.error } : { kind: x.kind, text: String(x.text || "").slice(0, 300) }) };
        results.push(res); rej.write(JSON.stringify(res) + "\n");
        if (chk.ok) stats.ok++; else stats.rejected++;
        process.stderr.write(`${k + 1}/${tasks.length} ${t.cat} ${chk.ok ? "PASS" : "FAIL " + chk.why} (${res.seconds}s)\n`);
        continue;
      }
      const raw = (() => { try { return JSON.parse(fs.readFileSync(path.join(tdir, "raw", t.id.replace(/[^\w.-]/g, "_") + ".json"), "utf-8")); } catch (_) { return null; } })();
      if (!raw || !raw.done) { reject(t, "the run did not finish", { state: run && run.state }); continue; }
      if (raw.failed) { reject(t, "teacher: " + raw.turns.slice(-1)[0].content.slice(0, 80), { steps: a.steps }); continue; }
      if (!chk.ok) { reject(t, "circuit wrong: " + chk.why); continue; }
      if (t.cat !== "qa" && !a.verified) { reject(t, "the app did not count it verified", { final: a.final, nudges: (a.steps || []).filter(x => x.kind === "nudge").map(x => x.text) }); continue; }
      // 4. the row: what the app sent the model, with the model's own turns as it gave them.
      // Assistant turns after the request are the teacher's (the app rewrites the first one's content as
      // "(my plan) …" in later requests); earlier ones are chat history (the editor's greeting): not trained on
      let ask = -1; raw.messages.forEach((m, i) => { if (m.role === "user" && !String(m.content).startsWith("(system)")) ask = i; });   // the last request; before it = history
      let ti = 0;
      const messages = raw.messages.map((m, i) => m.role === "assistant" && i > ask ? Object.assign({}, raw.turns[ti++]) : m);
      // a planned mistake is in the conversation (the error and the fix are the lesson) but never a target:
      // `train: false` = mask it out of the loss
      if (t.mistake) { const j = messages.findIndex((m, i) => i > ask && m.role === "assistant"); if (j > 0) messages[j].train = false; }
      // the chat protocol: an assistant turn with tool calls is followed by exactly its tool results
      const order = (() => { for (let i = 0; i < messages.length; i++) { const m = messages[i]; if (!m.tool_calls) continue;
        const ids = m.tool_calls.map(c => c.id), got = messages.slice(i + 1, i + 1 + ids.length);
        if (got.length !== ids.length || got.some((g, j) => g.role !== "tool" || g.tool_call_id !== ids[j])) return "tool results out of order after message " + i; } return ""; })();
      if (order) { reject(t, order); continue; }
      if (!toolsSaved) { fs.writeFileSync(path.join(OUT, "tools.json"), JSON.stringify(raw.tools, null, 1)); toolsSaved = true; }
      train.write(JSON.stringify({ id: t.id, cat: t.cat, messages, meta: { train_from: ask + 1, chained, formula: t.formula, mistake: t.mistake, sheet: t.use_sheet,
        checked: a.verified && a.verified.checked, steps: (a.steps || []).filter(s => s.tool).map(s => s.tool),
        nudges: (a.steps || []).filter(s => s.kind === "nudge").map(s => s.text), request_options: raw.request_options, seconds: (Date.now() - t0) / 1000 } }) + "\n");
      stats.ok++;
      if ((k + 1) % 25 === 0) process.stderr.write(`${k + 1}/${tasks.length} ok ${stats.ok} rejected ${stats.rejected}\n`);
    }
  } finally {
    stats.finished = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, "stats.json"), JSON.stringify(stats, null, 1));
    if (train) train.end();
    rej.end();
    if (EVAL) {
      const by = {};
      results.forEach(r => { const b = by[r.cat] = by[r.cat] || { tasks: 0, pass: 0, verified_by_app: 0, seconds: 0, tool_errors: 0 };
        b.tasks++; b.pass += r.pass; b.verified_by_app += r.verified_by_app; b.seconds += r.seconds; b.tool_errors += r.tool_errors; });
      Object.values(by).forEach(b => { b.pass_rate = +(b.pass / b.tasks).toFixed(3); b.avg_seconds = Math.round(b.seconds / b.tasks); delete b.seconds; });
      const total = { tasks: results.length, pass: results.filter(r => r.pass).length };
      total.pass_rate = total.tasks ? +(total.pass / total.tasks).toFixed(3) : 0;
      fs.writeFileSync(path.join(OUT, "eval_report.json"), JSON.stringify({ model: EVAL_MODEL, total, by_category: by, finished: stats.finished }, null, 1));
      fs.writeFileSync(path.join(OUT, "eval_report.md"), `# Eval: ${path.basename(EVAL_MODEL)}\n\nทั้งหมด ${total.pass}/${total.tasks} (${(100 * total.pass_rate).toFixed(1)} %)\n\n`
        + "| หมวด | ผ่าน | อัตรา | แอปยืนยันเอง | เฉลี่ย s | tool error |\n|---|---|---|---|---|---|\n"
        + Object.entries(by).map(([c, b]) => `| ${c} | ${b.pass}/${b.tasks} | ${(100 * b.pass_rate).toFixed(0)} % | ${b.verified_by_app} | ${b.avg_seconds} | ${b.tool_errors} |`).join("\n") + "\n");
    }
    try { await post("/api/llm/stop", {}); await post("/api/quit", {}); } catch (_) {}
    if (browser) await browser.close();
    app.kill();
  }
  console.log(JSON.stringify(stats, null, 1));
}
main().catch(e => { console.error(e); process.exit(1); });
