/* ===== 18. Local AI agent: the model on this machine works through the MCP tools ==============
   "ฟีเจอร์ AI ห่วยมาก": the chat used to ask the model for ONE intent JSON and draw it. In the
   chat's เอเจนต์ mode the local model (Qwen3.5 / Typhoon via llama-server --jinja) instead gets
   the same tools Claude has over MCP (a core set: launcher/mcp_server.py AGENT_TOOLS) and works
   step by step: look → build / edit → check → simulate → answer, every step drawn live and shown
   in the chat. Tool calls run HERE (MCP_OPS), after the MCP server's own argument checks
   (/api/agent/normalize: aliases, unknown fields). The model is reached through the launcher
   (/api/llm/chat). Every run is logged (/api/agent/log) and kept in AIAG.runs, so Claude can
   drive the chat over MCP (ai_chat / ai_chat_status) to test and debug this feature. */
const AIAG = { runs:[], cur:null, tools:null, seq:0, pending:null, capture:null };
const AIAG_MAX_STEPS = 24;
const AIAG_EDIT_OPS = new Set(["add_component","connect","disconnect","delete","update_component","apply","build_circuit","make_bus_ports","new_sheet","set_pins","auto_pins","undo"]);
const AIAG_VERIFY_OPS = new Set(["check","simulate","probe"]);

function aiagSystemPrompt(){
  const P=state.project, s=activeSch();
  const sheets=Object.values(P.schematics).map(x=>`${x.name}${x.id===P.topId?" (top)":""}: ${x.components.filter(c=>c.type!=="JUNCTION").length} parts`).join("; ");
  let ports=""; try{ ports=s?schPortList(s).map(p=>`${p.dir} ${p.id}${p.width>1?"["+(p.width-1)+":0]":""}`).join(", "):""; }catch(_){}
  return [
"You are the assistant inside Schematic Studio, a digital-logic lab editor for the EDGE Spartan-7 FPGA board.",
"You work ONLY through the tools. Every change you make is drawn live on the user's screen and can be undone.",
"",
"How to work:",
"1. Look first: get_sheet (detail:'brief') before changing a sheet you have not seen.",
"2. Build whole circuits with build_circuit (truth_table / generator / intent). Edit with add_component, connect,",
"   disconnect, delete, update_component, or apply for several steps at once. Fix the user's own sheets in place.",
"3. After ANY change: call check, then simulate (or probe for chosen inputs). Never say it works without that.",
"4. If a tool returns an error, read its hint and correct the call. Do not repeat the same failing call.",
"5. Finish with a short answer IN THAI: what you did and what the check / simulation showed.",
"",
"References: a component is its id, an INPUT/OUTPUT name or a label; a pin is 'component.pin' (U1.i0, ff0.q).",
"Truth tables list rows with the FIRST input as the MSB. Sub-circuits are sheets placed as 'block:<sheet name>'.",
"Counters: build_circuit generator {kind:'mod_counter'|'jk_counter', n}; divide a clock by any N: {kind:'clock_divider', n}.",
"Add bus:true to build_circuit to get q[3:0] instead of q0..q3.",
"If the request is only a question (no change needed), answer it directly in Thai.",
"For how the course / a lab sheet does something, or the board's pins, call search_course.",
"",
`Project: ${P.name}. Sheets: ${sheets}. Active sheet: ${s?s.name:"-"}${ports?" (ports: "+ports+")":""}.`
  ].join("\n");
}
async function aiagPost(url, body){
  const r=await fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body||{})});
  return r.json();
}
async function aiagTools(){
  if(!AIAG.tools){ const j=await aiagPost("/api/agent/tools", {}); if(!j.ok) throw new Error(j.error||"no tools"); AIAG.tools=j.tools; }
  return AIAG.tools;
}
const aiagClip=(s,n)=>{ s=String(s==null?"":s); return s.length>n ? s.slice(0,n)+` …(+${s.length-n} chars)` : s; };
function aiagStepHtml(st){
  const a=aiagClip(JSON.stringify(st.args||{}), 160);
  const res=st.ok ? aiagClip(st.summary||"ok", 220) : aiagClip(st.error, 300);
  return `<div class="ag-step ${st.ok?"":"bad"}"><span class="ag-tool">${st.ok?"🔧":"⚠"} ${esc(st.tool)}</span> <code>${esc(a)}</code>`
    +`<div class="ag-res">${esc(res)}</div></div>`;
}
/* one line of what a tool gave back, for the chat (the model gets the full JSON) */
function aiagSummary(tool, r){
  if(!r || typeof r!=="object") return String(r);
  if(tool==="check") return `errors ${r.errors} · warnings ${r.warnings}`+(r.issues&&r.issues.length?" — "+r.issues.slice(0,2).map(i=>i.message).join(" | "):"");
  if(tool==="simulate") return r.kind==="sequential" ? `${r.rows.length} cycles` : r.rows ? `${r.rows.length} rows` : "";
  if(tool==="build_circuit") return `sheet ${r.sheet} · ${r.parts||""} parts`+(r.note?" · "+r.note:"");
  if(tool==="get_sheet") return `${r.sheet}: ${(r.components||[]).length} parts, ${(r.nets||[]).length} nets`;
  if(r.connected) return r.connected.join(", ");
  if(r.deleted) return "deleted "+r.deleted.join(", ");
  return aiagClip(JSON.stringify(r), 200);
}
async function aiagCall(tool, rawArgs){
  if(!AIAG.tools.some(t=>t.function.name===tool)) return {ok:false, error:`unknown tool '${tool}' — use one of: ${AIAG.tools.map(t=>t.function.name).join(", ")}`};
  const n=await aiagPost("/api/agent/normalize", {name:tool, args:rawArgs});
  if(!n.ok) return {ok:false, error:n.error};
  const pre=(()=>{ try{ return mcpSheetState(); }catch(_){ return null; } })();
  try{
    MCPB.busy=true;
    const r=await MCP_OPS[tool](n.args||{});
    try{ mcpShowChange(pre); }catch(_){}
    try{ uxRefreshPages(); }catch(_){}
    return {ok:true, result:r};
  }catch(e){ return {ok:false, error:String(e&&e.message||e)+(e&&e.hint?"\nhint: "+e.hint:"")}; }
  finally{ MCPB.busy=false; }
}
/* a chat line that is NOT part of the conversation memory (the live status, each tool step) */
function aiagLine(html, cls){
  const log=$("#acLog"); if(!log) return null;
  const d=document.createElement("div"); d.className="ac-msg ai ag "+(cls||""); d.innerHTML=html;
  log.appendChild(d); log.scrollTop=log.scrollHeight; return d;
}
async function aiAgentRun(msg){
  // earlier turns (not this message, which the caller already put in the log)
  const hist=(AICHAT.history||[]).slice(0,-1).slice(-6).map(h=>({role:h.role==="user"?"user":"assistant", content:String(h.text||"").slice(0,600)}));
  const run={id:++AIAG.seq, message:msg, started:Date.now(), state:"running", steps:[], final:null, error:null,
             model_calls:0, tokens:{prompt:0, completion:0}, model_seconds:0};
  AIAG.cur=run; AIAG.runs.push(run); if(AIAG.runs.length>20) AIAG.runs.shift();
  const status=aiagLine('<span class="ac-badge v">เอเจนต์</span> <span class="ag-live">กำลังคิด…</span>');
  const live=t=>{ const e=status&&status.querySelector(".ag-live"); if(e) e.textContent=t; };
  try{
    await aiagTools();
    // the course notes most related to the request go in up front (RAG); more via search_course
    let notes="";
    try{ const rj=await (await fetch("/api/rag/search?k=3&q="+encodeURIComponent(msg))).json();
      if(rj.ok && rj.hits.length){ notes="\n\nCourse notes that may help (search_course finds more):\n"+rj.hits.map(h=>`[${h.group}] ${h.title}: ${h.text.slice(0,500)}`).join("\n");
        run.steps.push({kind:"rag", text:rj.hits.map(h=>h.group+": "+h.title).join(" | ")}); } }catch(_){}
    const messages=[{role:"system", content:aiagSystemPrompt()+notes}, ...hist, {role:"user", content:msg}];
    let edited=false, verified=true, nudged=false;
    for(let i=0; i<AIAG_MAX_STEPS; i++){
      live(`กำลังคิด… (รอบ ${i+1})`);
      const j=await aiagPost("/api/llm/chat", {messages, tools:AIAG.tools, temperature:0.6, top_p:0.95, top_k:20});
      if(!j.ok){ run.error=j.error+(j.hint?" — "+j.hint:""); break; }
      run.model_calls++; run.model_seconds+=j.elapsed_s||0;
      if(j.usage){ run.tokens.prompt=j.usage.prompt_tokens||run.tokens.prompt; run.tokens.completion+=j.usage.completion_tokens||0; }
      const m=((j.choices||[])[0]||{}).message||{};
      const think=String(m.reasoning_content||"");
      const calls=(m.tool_calls||[]).filter(c=>c&&c.function);
      messages.push(Object.assign({role:"assistant", content:m.content||""}, calls.length?{tool_calls:calls}:{}));
      if(think) run.steps.push({kind:"think", text:aiagClip(think, 4000)});
      if(calls.length){
        for(const tc of calls){
          const tool=tc.function.name; let args={}, bad=null;
          try{ args=typeof tc.function.arguments==="string" ? JSON.parse(tc.function.arguments||"{}") : (tc.function.arguments||{}); }
          catch(_){ bad="the arguments are not valid JSON: "+aiagClip(tc.function.arguments, 200); }
          live(`กำลังใช้ ${tool}…`);
          const t0=performance.now();
          const r=bad ? {ok:false, error:bad} : await aiagCall(tool, args);
          const content=r.ok ? aiagClip(JSON.stringify(r.result), 6000) : "ERROR: "+r.error;
          messages.push({role:"tool", tool_call_id:tc.id||("call"+i), content});
          const st={kind:"tool", tool, args, ok:r.ok, ms:Math.round(performance.now()-t0),
                    summary:r.ok?aiagSummary(tool, r.result):undefined, error:r.ok?undefined:r.error, result:aiagClip(content, 2500)};
          run.steps.push(st);
          aiagLine(aiagStepHtml(st), "step");
          if(r.ok && AIAG_EDIT_OPS.has(tool)){ edited=true; verified=false; }
          if(r.ok && AIAG_VERIFY_OPS.has(tool)) verified=true;
        }
        continue;
      }
      if(edited && !verified && !nudged){      // it changed the circuit but did not look at the result
        nudged=true; run.steps.push({kind:"nudge", text:"asked to check + simulate before answering"});
        messages.push({role:"user", content:"(system) You changed the circuit but did not verify it. Call check, then simulate or probe, then answer."});
        continue;
      }
      run.final=String(m.content||"").trim() || "(ไม่มีคำตอบ)";
      break;
    }
    if(!run.final && !run.error) run.error=`หยุดที่ ${AIAG_MAX_STEPS} รอบ — งานนี้อาจใหญ่เกินไปสำหรับโมเดลในเครื่อง`;
  }catch(e){ run.error=String(e&&e.message||e); }
  run.state=run.error?"error":"done"; run.seconds=Math.round((Date.now()-run.started)/100)/10;
  live(run.error?"หยุด":`เสร็จ · ${run.steps.filter(s=>s.kind==="tool").length} ขั้น · ${run.seconds} วิ`);
  if(run.final) aiAppend("ai", run.final);
  if(run.error) aiAppend("ai", "เอเจนต์: "+run.error, {err:true});
  try{ await aiagPost("/api/agent/log", {message:run.message, state:run.state, final:run.final, error:run.error, steps:run.steps,
    model_calls:run.model_calls, tokens:run.tokens, seconds:run.seconds}); }catch(_){}
  return run;
}

/* ---- the chat's third mode: เอเจนต์ (local model + tools) ---- */
{
  const modes=document.querySelector("#aiChat .ac-mode");
  if(modes && !modes.querySelector('[data-aimode="agent"]')){
    const b=document.createElement("button"); b.className="acm"; b.dataset.aimode="agent"; b.textContent="เอเจนต์";
    b.title="โมเดลในเครื่องทำงานเองทีละขั้นด้วยเครื่องมือชุดเดียวกับ Claude (ต้องเปิดโมเดลใน ตั้งค่า ▸ โมเดล AI)";
    b.addEventListener("click", ()=>aiSetMode("agent")); modes.appendChild(b);
  }
  const _mode=aiSetMode;
  aiSetMode=function(m){ const r=_mode.apply(this, arguments);
    const t=$("#acInput"); if(m==="agent" && t) t.placeholder="สั่งงานได้เลย เช่น 'สร้างตัวนับ mod 6 แล้วจำลองให้ดู', 'ทำไม err_led ไม่ติด' — เอเจนต์ใช้เครื่องมือเองทีละขั้น";
    try{ localStorage.setItem("schstudio.aiMode", m); }catch(_){}
    return r; };
  const _send=aiSend;
  aiSend=async function(){
    const t=$("#acInput"), msg=((t&&t.value)||"").trim();
    if(AICHAT.mode!=="agent" || !msg || msg[0]==="/" || AICHAT.busy) return _send.apply(this, arguments);
    aiAppend("user", msg); t.value="";
    AICHAT.busy=true; aiSetBusy(true);
    try{ return await aiAgentRun(msg); } finally{ AICHAT.busy=false; aiSetBusy(false); }
  };
  try{ const m=localStorage.getItem("schstudio.aiMode"); if(m==="agent" && /^https?:/.test(location.protocol)) aiSetMode("agent"); }catch(_){}
}

/* ---- Claude drives the chat (MCP ai_chat / ai_chat_status / ai_model): test the AI feature ---- */
function aiagChatLog(from){
  return [...document.querySelectorAll("#acLog > .ac-msg")].slice(from).map(d=>({role:d.classList.contains("user")?"user":"ai",
    text:aiagClip(d.innerText.trim(), 3000), error:d.classList.contains("err")||undefined}));
}
MCP_OPS.ai_chat = a=>{
  const msg=String(a.message||"").trim(); if(!msg) mcpFail("message is required — what the user would type in the chat");
  if(AICHAT.busy || AIAG.pending) mcpFail("the chat is still busy with the previous message", "call ai_chat_status until it is done");
  if(!AICHAT.open) toggleAiChat();
  if(a.mode){ if(!["build","qa","agent"].includes(a.mode)) mcpFail("mode is build | qa | agent"); aiSetMode(a.mode); }
  const t=$("#acInput"); t.value=msg;
  const from=document.querySelectorAll("#acLog > .ac-msg").length, runBefore=AIAG.seq;
  const cap=AIAG.capture={from, runBefore, mode:AICHAT.mode, message:msg, started:Date.now(), done:false};
  AIAG.pending=Promise.resolve().then(()=>aiSend()).catch(e=>{ cap.error=String(e&&e.message||e); })
    .finally(()=>{ cap.done=true; cap.seconds=Math.round((Date.now()-cap.started)/100)/10; AIAG.pending=null; });
  return {started:true, mode:AICHAT.mode, next:"call ai_chat_status (it waits up to `wait` s) until state is 'done'"};
};
MCP_OPS.ai_chat_status = async a=>{
  const cap=AIAG.capture; if(!cap) return {state:"none", next:"send something with ai_chat first"};
  const until=Date.now()+1000*Math.max(1, Math.min(40, +a.wait||40));
  while(!cap.done && Date.now()<until) await new Promise(r=>setTimeout(r, 300));
  const out={state:cap.done?"done":"running", mode:cap.mode, message:cap.message, seconds:cap.done?cap.seconds:Math.round((Date.now()-cap.started)/1000),
             chat:aiagChatLog(cap.from)};
  if(cap.error) out.error=cap.error;
  const run=AIAG.seq>cap.runBefore ? AIAG.runs.find(r=>r.id===cap.runBefore+1) : null;
  if(run){
    const detail=a.detail||"steps";
    out.agent={state:run.state, final:run.final, error:run.error||undefined, model_calls:run.model_calls,
      model_seconds:Math.round(run.model_seconds*10)/10, tokens:run.tokens,
      steps:run.steps.map(s=>s.kind!=="tool" ? (detail==="full"||s.kind==="nudge" ? s : {kind:s.kind, text:aiagClip(s.text, 300)})
        : detail==="full" ? s : {tool:s.tool, args:s.args, ok:s.ok, summary:s.summary, error:s.error, ms:s.ms})};
  }
  if(!cap.done) out.next="still running — call ai_chat_status again";
  return out;
};
MCP_OPS.ai_model = async a=>{
  if(!/^https?:/.test(location.protocol)) mcpFail("the local model needs the FPGA Ecosystem app");
  const act=a.action||"status";
  if(act==="start"){ let model=a.model||"";
    const st0=await (await fetch("/api/llm/status")).json();
    const hit=(st0.catalog||[]).find(m=>m.id===model||m.name===model); if(hit) model=hit.path;
    const r=await aiagPost("/api/llm/start", model?{model}:{}); if(!r.ok) mcpFail(r.error||"could not start");
    const until=Date.now()+1000*Math.max(5, Math.min(40, +a.wait||30));
    while(Date.now()<until){ const s=await (await fetch("/api/llm/status")).json(); if(s.state==="ready"||s.state==="crashed") break; await new Promise(r=>setTimeout(r, 700)); } }
  else if(act==="stop"){ await aiagPost("/api/llm/stop", {}); }
  else if(act==="download"){ const r=await aiagPost("/api/llm/download", a.model==="llama.cpp"?{what:"llama", variant:a.variant||"gpu"}:{id:a.model}); if(!r.ok) mcpFail(r.error||"could not start the download"); }
  else if(act!=="status") mcpFail("action is status | start | stop | download");
  const s=await (await fetch("/api/llm/status")).json();
  return {state:s.state, model:s.model, llama_server:s.server||null, mode:s.mode, running_for_s:s.since,
    catalog:(s.catalog||[]).map(m=>({id:m.id, name:m.name, size_gb:m.size_gb, installed:m.installed, agent:!!m.agent})),
    embedding_model:s.embed?{id:s.embed.id, installed:s.embed.installed, running:s.embed.running, note:"semantic search for search_course (download with action:'download', model:'"+s.embed.id+"')"}:undefined,
    download:s.download, log_tail:aiagClip(s.log, 2500), agent_runs_logged:"launcher config folder ▸ agent-runs/*.jsonl"};
};
