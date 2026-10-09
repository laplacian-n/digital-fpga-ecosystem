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
const AIAG_BUDGET_S = 300;        // a local run past 5 minutes is told to answer (one ran 10 min for 0 wires)
const AIAG_STALL = 4;             // rounds in a row that changed nothing: nudged, and stopped at +2
const AIAG_EDIT_OPS = new Set(["build_hierarchy","add_component","connect","disconnect","delete","update_component","apply","build_circuit","make_bus_ports","new_sheet","set_pins","auto_pins","undo"]);
const AIAG_VERIFY_OPS = new Set(["check","simulate","probe","verify_truth_table","check_spec","set_spec"]);

function aiagSystemPrompt(){
  const P=state.project, s=activeSch();
  const sheets=Object.values(P.schematics).map(x=>`${x.name}${x.id===P.topId?" (top)":""}: ${x.components.filter(c=>c.type!=="JUNCTION").length} parts`).join("; ");
  let ports=""; try{ ports=s?schPortList(s).map(p=>`${p.dir} ${p.id}${p.width>1?"["+(p.width-1)+":0]":""}`).join(", "):""; }catch(_){}
  return [
"You are the assistant inside Schematic Studio, a digital-logic lab editor for the EDGE Spartan-7 FPGA board.",
"You work ONLY through the tools. Every change you make is drawn live on the user's screen and can be undone.",
"",
"How to work:",
"0. For a new circuit, first write down what it must do with set_spec (a formula / table / clock sequence taken from",
"   the REQUEST), then build until check_spec passes. The spec is the yardstick — never derive it from your circuit.",
"1. Look first: get_sheet (detail:'brief') before changing a sheet you have not seen.",
"2. A standard circuit (adder, subtractor, comparator, mux, decoder, encoder, 7-seg, parity, counters, divider,",
"   registers, toggle, edge detector, debounce): build_part — it is generated AND checked for you (list_parts shows them).",
"   Anything else: build_circuit with formula (equations like \"y = a&b | ~c\", \"{cout,sum} = a+b+cin\") — never type",
"   0/1 columns yourself unless the user gave the table. Output 1 for certain input values (primes, a range, a list)?",
"   give the ROWS: truth_table:{inputs:['x2','x1','x0'], ones:{p:[2,3,5,7]}} (set_spec table takes ones too).",
"   Bigger designs: build the pieces, then ONE build_hierarchy call with every block, the top ports and all the",
"   connections (buses by name: cnt.ones → cmp.a_lo) — never wire blocks with connect one pin at a time.",
"   Edit with add_component, connect, disconnect, delete, update_component, or apply.",
"3. After ANY change: call check AND simulate ON THE SHEET YOU CHANGED — pass its name as `sheet`. For logic you",
"   derived, verify_truth_table with a formula written from the REQUIREMENT (not the table you built from — that",
"   proves nothing). Look at `recognized` in the answer. Never say it works without that.",
"4. If a tool returns an error, read its hint and correct the call. Do not repeat the same failing call.",
"   A wrong circuit: rebuild it ON THE SAME SHEET (same sheet name, replace:true) — never a new sheet per try.",
"   verify / check_spec answering pass:null or independent:false checked nothing: check against the request instead —",
"   and if there is nothing else to check against, STOP and answer, saying it is checked only against your own table.",
"   A question \"if the inputs are X, does Y happen?\": probe with exactly those inputs and answer from the outputs",
"   (a numbered group like sw0..sw15 takes one number: sw:'0x1260'). check_spec only checks a spec someone set.",
"   Before saying a design is ready for the board, run board_check.",
"5. Finish with a short answer IN THAI: what you did and what the check / simulation showed.",
"",
"Be quick: call SEVERAL tools in one turn when they do not depend on each other (e.g. every add_component at once),",
"or one apply with all the steps. Do not write your plan out again each turn — just make the next calls.",
"A new circuit on a sheet the user names: build_circuit with sheet:'<that name>' (it creates or fills that sheet) —",
"do not make an empty sheet first. Stay in the current project. A pin of a bus takes a bit index: 'y.i[2]', 's.o[0]'.",
"",
"References: a component is its id, an INPUT/OUTPUT name or a label; a pin is 'component.pin' (U1.i0, ff0.q).",
"Truth tables list rows with the FIRST input as the MSB. Sub-circuits are sheets placed as 'block:<sheet name>'.",
"Counters: build_circuit generator {kind:'mod_counter'|'jk_counter', n}; divide a clock by any N: {kind:'clock_divider', n}.",
"Add bus:true to build_circuit to get q[3:0] instead of q0..q3.",
"If the request is only a question (no change needed), answer it directly in Thai.",
"For how the course / a lab sheet does something, or the board's pins, call search_course.",
"EDGE board facts: 3.3 V I/O, 50 MHz clock, 4-digit common-anode 7-seg (a..g, dp, an[3:0] all active-low: 0 = on),",
"push buttons 1 when pressed, 16 switches, 16 LEDs (1 = on). A whole lab 6 (counter 00-yy): build_part kind lab6_counter.",
"",
`Project: ${P.name}. Sheets: ${sheets}. Active sheet: ${s?s.name:"-"}${ports?" (ports: "+ports+")":""}.`
  ].join("\n");
}
async function aiagPost(url, body, signal){
  const r=await fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body||{}), signal});
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
  if(tool==="verify_truth_table" || tool==="check_spec") return r.pass===null || r.independent===false
    ? "NOT A CHECK — compared with the table it was built from" : `pass ${r.pass}`+(r.total_mismatches||(r.mismatches||[]).length?` · ${r.total_mismatches||r.mismatches.length} rows differ`:"");
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
/* the answer when the run is stopped: what was built, and how far it was checked */
function aiagWrapUp(run, why){
  const tools=run.steps.filter(s=>s.kind==="tool" && s.ok), last=[...tools].reverse().find(s=>/^build_/.test(s.tool));
  const sim=[...tools].reverse().find(s=>s.tool==="simulate");
  const tail=(last?`\nวงจรล่าสุดอยู่ที่แผ่น ${(last.args&&(last.args.sheet||last.args.name))||"-"}`:"")+(sim?`\nผลจำลอง: ${sim.summary||""}`:"");
  if(why==="verified" && run.verified) return `เสร็จแล้ว: แผ่น ${run.verified.sheet} ผ่านการตรวจ`+tail;
  if(why==="stall" || why==="time"){
    // what is still open on the sheet it worked on, from the editor, not the model
    let open="";
    try{ const edits=[...tools].reverse().find(s=>AIAG_EDIT_OPS.has(s.tool)||/^build_/.test(s.tool));
      const nm=edits&&((edits.args&&edits.args.sheet)||(edits.result&&(/"sheet":"([^"]+)"/.exec(edits.result)||[])[1]));
      const sch=(nm&&Object.values(state.project.schematics).find(x=>x.name===nm))||activeSch();
      if(sch){ const c=MCP_OPS.check({sheet:sch.name}), H=typeof wireHints==="function"?wireHints(sch):[];
        open=`\nแผ่น ${sch.name}: error ${c.errors}, warning ${c.warnings}`+(H.length?` · ยังมีสายที่เดาได้ ${H.length} เส้น — กด 💡 "ต่อทั้งหมด" ใน Inspector (ไม่ต้องใช้โมเดล)`:""); } }catch(_){}
    return (why==="time" ? `หยุดเอง: ใช้เวลาเกิน ${AIAG_BUDGET_S/60} นาที` : `หยุดเอง: ${AIAG_STALL+2} รอบติดกันไม่มีอะไรบนแผ่นเปลี่ยน (เรียกเครื่องมือไม่สำเร็จ / ต่อสายไม่ได้)`)
      +tail+open+"\nงานที่ต้องต่อบล็อกหลายตัวเข้าด้วยกันยากเกินโมเดลในเครื่อง — ลองสั่งทีละบล็อก, ใช้ 💡 แนะนำการต่อสาย หรือชิ้นส่วนทั้งแลปในคลัง (เช่น แลป 6)";
  }
  return `หยุดเอง: ตรวจเทียบกับสิ่งที่เป็นอิสระจากวงจรไม่ได้ จึงไม่สร้างซ้ำต่อ`+tail+"\n⚠ ตรวจแค่เทียบกับตาราง/สมการที่โมเดลเขียนเอง — โปรดเทียบกับใบงานอีกครั้ง";
}
/* every sheet's content: a round that leaves it unchanged made no progress */
function aiagFingerprint(){ try{ return Object.values(state.project.schematics).map(s=>s.id+":"+sheetHash(s)).join("|"); }catch(_){ return ""; } }
/* stop the running agent now: the model call in flight is aborted, no further tool runs */
function aiagStop(why){
  const run=AIAG.cur; if(!run || run.state!=="running") return false;
  run.cancel=true; run.cancelWhy=why||"สั่งหยุด"; try{ run.ctl && run.ctl.abort(); }catch(_){}
  return true;
}
/* finished runs outlive a reload of the page: ai_chat_status can still read the answer */
function aiagRunSummary(run, full){
  return {id:run.id, message:run.message, state:run.state, final:run.final, error:run.error||undefined, seconds:run.seconds,
    model_calls:run.model_calls, model_seconds:Math.round((run.model_seconds||0)*10)/10, tokens:run.tokens,
    profile:run.profile, calls:run.calls,
    in_model_call:run.inCall ? {round:run.inCall.round, seconds:Math.round((Date.now()-run.inCall.since)/1000)} : undefined,
    resumable:!!run.resumable, resumed_from:run.resumed_from, verified:run.verified||undefined, escalated:run.escalated||undefined,
    steps:run.steps.map(s=>s.kind!=="tool" ? (full||s.kind==="nudge" ? {kind:s.kind, text:s.text} : {kind:s.kind, text:aiagClip(s.text, 300)})
      : Object.assign({tool:s.tool, args:s.args, ok:s.ok, summary:s.summary, error:s.error, ms:s.ms}, full?{result:s.result}:{}, s.by_app?{by_app:true}:{}, s.fast_path?{fast_path:true}:{}))};
}
function aiagRemember(run){
  try{ const L=JSON.parse(localStorage.getItem("schstudio.agentRuns")||"[]").filter(x=>x.id!==run.id);
    L.push(Object.assign(aiagRunSummary(run, false), {at:new Date().toISOString()}));
    localStorage.setItem("schstudio.agentRuns", JSON.stringify(L.slice(-10))); }catch(_){}
}
function aiagStored(){ try{ return JSON.parse(localStorage.getItem("schstudio.agentRuns")||"[]"); }catch(_){ return []; } }
/* a chat line that is NOT part of the conversation memory (the live status, each tool step) */
function aiagLine(html, cls){
  const log=$("#acLog"); if(!log) return null;
  const d=document.createElement("div"); d.className="ac-msg ai ag "+(cls||""); d.innerHTML=html;
  log.appendChild(d); log.scrollTop=log.scrollHeight; return d;
}
/* opts: maxSteps, budgetS (a ceiling for this run), resume (a run that stopped before answering: go on from
   its conversation instead of starting over) */
async function aiAgentRun(msg, opts){
  opts=opts||{};
  const prev=opts.resume||null;
  // earlier turns (not this message, which the caller already put in the log)
  const hist=(AICHAT.history||[]).slice(0,-1).slice(-6).filter(h=>!/^⚠/.test(String(h.text||""))).map(h=>({role:h.role==="user"?"user":"assistant", content:String(h.text||"").slice(0,600)}));
  const maxSteps=Math.max(1, Math.min(60, +opts.maxSteps||AIAG_MAX_STEPS)), budgetS=Math.max(10, +opts.budgetS||AIAG_BUDGET_S);
  const run={id:++AIAG.seq, message:prev?prev.message:msg, started:Date.now(), state:"running", steps:[], final:null, error:null,
             model_calls:0, tokens:{prompt:0, completion:0}, model_seconds:0, max_steps:maxSteps, budget_s:budgetS,
             resumed_from:prev?prev.id:undefined, cancel:false, ctl:null, noEscalate:!!opts.noEscalate};
  if(prev) msg=prev.message;
  AIAG.cur=run; AIAG.runs.push(run); if(AIAG.runs.length>20) AIAG.runs.shift();
  const status=aiagLine('<span class="ac-badge v">เอเจนต์</span> <span class="ag-live">กำลังคิด…</span> <button class="btn2 ag-stop" title="หยุดเอเจนต์ตอนนี้">⏹ หยุด</button>');
  const live=t=>{ const e=status&&status.querySelector(".ag-live"); if(e) e.textContent=t; };
  const sb=status&&status.querySelector(".ag-stop"); if(sb) sb.onclick=()=>aiagStop("ผู้ใช้กดหยุด");
  try{
    await aiagTools();
    // how this model is run: a model fine-tuned on this app's conversations (trained without thinking) runs
    // the way it was trained (49-agent-checks: aiagProfile); ai_chat {think, temperature} overrides
    run.profile={think:true, temperature:0.6};
    run.multiGoal=typeof aiagMultiGoal==="function" && aiagMultiGoal(run.message);
    if(typeof aiagProfile==="function") try{ run.profile=Object.assign(run.profile, await aiagProfile(opts)); }catch(e){ console.warn("agent profile", e); }
    if(prev) run.steps.push({kind:"resume", text:`continuing run ${prev.id} (${prev.steps.filter(x=>x.kind==="tool").length} tool steps so far)`});
    // a part it can name is built and checked straight away (23-formula-verify: aiagFastPath) —
    // alone that answers the request with no model round; otherwise the model gets told it exists
    let notes="";
    if(!prev && typeof aiagFastPath==="function"){ live("สร้างจากคลังชิ้นส่วน…");
      try{ const fp=await aiagFastPath(msg, run); if(fp&&fp.final){ run.final=fp.final; run.fastFinal=true; } else if(fp&&fp.note) notes+="\n\n"+fp.note; }catch(e){ console.warn("fast path", e); } }
    // the acceptance test the request itself states, derived by code (36-oracle-gate): attached to the
    // sheet it builds, and a pass ends the run
    run.touched=new Set(prev&&prev.touched||[]); if(prev&&prev.oracle) run.oracle=prev.oracle;
    if(!prev && !run.final && typeof oracleDerive==="function") try{ const o=oracleDerive(msg);
      if(o.ok){ run.oracle=o; run.steps.push({kind:"oracle", text:o.what});
        notes+=`\n\n(system) The app derived this request's acceptance test by code, independent of any circuit: ${o.what}.`
          +` Name the ports — inputs: ${o.ports.in.join(", ")}; outputs: ${o.ports.out.join(", ")}.`
          +" It is put on the sheet you build and checked automatically (spec_check in the answer); when it passes you are done."; } }catch(e){ console.warn("oracle", e); }
    // the course notes most related to the request go in up front (RAG); more via search_course
    if(!prev && !run.final) try{ const ctl=new AbortController(); setTimeout(()=>ctl.abort(), 8000);   // never wait long on it
      const rj=await (await fetch("/api/rag/search?k=2&q="+encodeURIComponent(msg), {signal:ctl.signal})).json();
      if(rj.ok && rj.hits.length){ notes+="\n\nCourse notes that may help (search_course finds more):\n"+rj.hits.map(h=>`[${h.group}] ${h.title}: ${h.text.slice(0,350)}`).join("\n");
        run.steps.push({kind:"rag", text:rj.hits.map(h=>h.group+": "+h.title).join(" | ")}); } }catch(_){}
    const messages=prev ? prev._messages.concat([{role:"user", content:"(system) You were stopped before you finished. Carry on from where you were — do not redo what is already built — and finish the request."}])
      : [{role:"system", content:aiagSystemPrompt()+notes}, ...hist, {role:"user", content:msg}];
    run._messages=messages;
    // sheets changed and not yet checked / simulated on — the nudge names them
    const needCheck=new Set(), needSim=new Set(), made=new Set();
    let nudges=0, unanswered=false, think=true, planned=false, circularN=0, stopAt=Infinity, stopWhy="", stall=0, gated=false;
    const built=new Set();          // sheet + what it was built from: the same rebuild twice is a loop
    let budgetStart=run.started;    // restarts when a bigger model takes over
    for(let i=0; i<maxSteps && !run.final; i++){
      if(run.cancel) break;
      if(i>=stopAt){
        // stuck on a small model: a bigger installed one continues the same conversation (44-escalate)
        if((stopWhy==="stall"||stopWhy==="time") && typeof aiagEscalate==="function" && await aiagEscalate(run, live)){
          stopAt=Infinity; stopWhy=""; stall=0; budgetStart=Date.now(); think=true;
          messages.push({role:"user", content:"(system) A larger model now continues this task from where it stopped. Look at what is on the sheets (get_sheet), then finish it — for a design made of blocks use ONE build_hierarchy call."});
          continue; }
        run.final=aiagWrapUp(run, stopWhy); break; }
      if(stopAt===Infinity && (Date.now()-budgetStart)/1000>budgetS){ stopAt=i+2; stopWhy="time";
        run.steps.push({kind:"nudge", text:"time budget used — asked to finish"});
        messages.push({role:"user", content:"(system) Time is up. Make no more changes: answer now in Thai with what is done, what is still missing, and what the user should do next."}); }
      const fp0=aiagFingerprint();
      live(`กำลังคิด… (รอบ ${i+1})`);
      // reasoning costs most of the time: think to plan, after an error and when nudged; not for the
      // routine next call (the plan from the first turn stays in the system prompt instead)
      run.ctl=new AbortController();
      const t0=Date.now(), thinkNow=think && run.profile.think!==false;
      run.inCall={round:i+1, since:t0};
      let j; try{ j=await aiagPost("/api/llm/chat", {messages, tools:AIAG.tools, temperature:run.profile.temperature, top_p:0.95, top_k:20,
        parallel_tool_calls:true, chat_template_kwargs:{enable_thinking:thinkNow}}, run.ctl.signal); }
      catch(e){ if(run.cancel) break; throw e; }
      run.inCall=null;
      if(run.cancel) break;
      if(!j.ok){ run.error=j.error+(j.hint?" — "+j.hint:""); break; }
      if(j.restarted){ run.steps.push({kind:"restart", text:"the model server had stopped — restarted it and repeated the call"});
        aiagLine('<div class="ag-step bad"><span class="ag-tool">↻ โมเดลหยุดทำงาน</span><div class="ag-res">เริ่มใหม่ให้แล้ว ทำต่อจากเดิม</div></div>', "step"); }
      run.model_calls++; run.model_seconds+=j.elapsed_s||0;
      if(j.usage){ run.tokens.prompt=j.usage.prompt_tokens||run.tokens.prompt; run.tokens.completion+=j.usage.completion_tokens||0; }
      // where the time goes, per call (ai_chat_status → calls): reading the prompt vs writing (incl. reasoning)
      (run.calls=run.calls||[]).push({s:Math.round((j.elapsed_s||(Date.now()-t0)/1000)*10)/10, think:thinkNow,
        prompt_tokens:j.usage&&j.usage.prompt_tokens, completion_tokens:j.usage&&j.usage.completion_tokens,
        prompt_ms:j.timings&&Math.round(j.timings.prompt_ms), gen_ms:j.timings&&Math.round(j.timings.predicted_ms), cached:j.timings&&j.timings.cache_n});
      const m=((j.choices||[])[0]||{}).message||{};
      const thought=String(m.reasoning_content||"");
      let calls=(m.tool_calls||[]).filter(c=>c&&c.function);
      if(!calls.length && typeof aiagTextCalls==="function"){ const tc=aiagTextCalls(m.content, thought);
        if(tc.length){ calls=tc; m.content=""; run.steps.push({kind:"nudge", text:`${tc.length} tool call(s) written as text — run as calls`}); } }
      // a plan in words but no call: the same model writes the call again under a JSON-schema grammar (49)
      if(!calls.length && typeof aiagStructuredCall==="function" && (run.structTries||0)<2 && stopAt===Infinity){
        const plan=[m.content, thought].filter(Boolean).join("\n").trim(), done=run.steps.some(x=>x.kind==="tool" && x.ok && !x.fast_path);
        if(plan && aiagWantsChange(run.message) && (!done || /→|->|ต่อ|connect|แล้ว(ต่อ|ให้|วาง)|ต่อไป|next/i.test(plan))){
          run.structTries=(run.structTries||0)+1; live("แปลงแผนเป็นคำสั่ง…");
          const sc=await aiagStructuredCall(run, messages, plan);
          if(sc){ calls=[sc]; run.steps.push({kind:"nudge", text:`no call in the reply — ${sc.function.name} written under the tool's schema (constrained decoding)`}); } } }
      messages.push(Object.assign({role:"assistant", content:m.content||""}, calls.length?{tool_calls:calls}:{}));
      if(thought) run.steps.push({kind:"think", text:aiagClip(thought, 4000)});
      // the plan rides on this assistant turn, not the system prompt: an unchanged prefix lets llama-server
      // reuse its cache, where editing messages[0] made it re-read ~9k prompt tokens on every call
      if(!planned && thought){ planned=true; messages[messages.length-1].content=(m.content?m.content+"\n\n":"")+"(my plan) "+aiagClip(thought, 1500); }
      think=false;
      if(calls.length){
        unanswered=false;
        // the app's own notes wait until every call of this turn has its result: a user message between
        // two tool results breaks the order the chat template expects (assistant → tool, tool, … → user)
        const after=[];
        for(const tc of calls){
          if(run.cancel) break;
          const tool=tc.function.name; let args={}, bad=null;
          try{ args=typeof tc.function.arguments==="string" ? JSON.parse(tc.function.arguments||"{}") : (tc.function.arguments||{}); }
          catch(_){ bad="the arguments are not valid JSON: "+aiagClip(tc.function.arguments, 200); }
          live(`กำลังใช้ ${tool}…`);
          // a rebuild of a sheet this run made replaces it (it used to leave prime3, prime3_2 … prime3_5)
          if(!bad && /^build_(circuit|part|fsm|hierarchy)$/.test(tool)){ const nm=String(args.sheet||args.name||"").trim().toLowerCase();
            const s=nm && Object.values(state.project.schematics).find(x=>String(x.name).toLowerCase()===nm);
            if(s && made.has(s.id) && s.components.some(c=>c.type!=="JUNCTION")) args=Object.assign({}, args, {sheet:s.name, replace:true}); }
          const before=new Set(Object.keys(state.project.schematics));
          const t0=performance.now();
          const r=bad ? {ok:false, error:bad} : await aiagCall(tool, args);
          Object.keys(state.project.schematics).forEach(id=>{ if(!before.has(id)) made.add(id); });
          const passNote=typeof aiagOracleAfter==="function" ? aiagOracleAfter(run, tool, r) : null;
          let content=r.ok ? aiagClip(JSON.stringify(r.result), 6000) : "ERROR: "+r.error;
          if(r.ok && /^build_(circuit|part|fsm|hierarchy)$/.test(tool) && r.result && r.result.sheet){
            const s=Object.values(state.project.schematics).find(x=>x.name===r.result.sheet), key=r.result.sheet+"|"+(s?sheetHash(s):"");
            if(built.has(key)) content+="\n(system) This is exactly the circuit you had already built on that sheet — rebuilding changed nothing. Do not rebuild it again.";
            built.add(key); }
          if(r.ok && r.result && r.result.spec_check && !/spec_check/.test(content)) content=aiagClip(JSON.stringify(r.result), 6000);
          messages.push({role:"tool", tool_call_id:tc.id||("call"+i), content});
          if(passNote && stopAt===Infinity && !run.multiGoal){ stopAt=i+2; stopWhy="verified"; run.steps.push({kind:"nudge", text:"passed the acceptance test — asked to answer"});
            after.push({role:"user", content:passNote}); }
          else if(passNote && run.multiGoal && !run.partNoted){ run.partNoted=true;
            run.steps.push({kind:"nudge", text:"one part passed — the request asks for more"});
            after.push({role:"user", content:passNote.replace(/It is done:.*$/, "")+" That is only part of what the user asked — carry on with the rest now. They already asked for all of it: do not ask for permission."}); }
          const st={kind:"tool", tool, args, ok:r.ok, ms:Math.round(performance.now()-t0),
                    summary:r.ok?aiagSummary(tool, r.result):undefined, error:r.ok?undefined:r.error, result:aiagClip(content, 2500)};
          run.steps.push(st);
          aiagLine(aiagStepHtml(st), "step");
          // which sheet this call worked on: the tool's own answer, else its argument, else the one on screen
          const on=(r.ok && r.result && r.result.sheet) || args.sheet || (activeSch()||{}).name;
          if(r.ok && AIAG_EDIT_OPS.has(tool) && on){ needCheck.add(on); needSim.add(on); }
          if(r.ok && (AIAG_EDIT_OPS.has(tool) || /^build_/.test(tool)) && on) run.touched.add(on);
          if(r.ok && tool==="check") needCheck.delete(on);
          const R=r.ok&&r.result||{}, circular=r.ok && (R.independent===false || R.pass===null || R.pending || (R.result&&(R.result.independent===false||R.result.pending)));
          // a spec still waiting for its circuit (set first, as asked) is not a failed check
          if(r.ok && (R.independent===false || (R.result&&R.result.independent===false) || (tool==="verify_truth_table" && R.pass===null))) circularN++;
          if(r.ok && tool!=="check" && AIAG_VERIFY_OPS.has(tool) && !circular) needSim.delete(on);
          if(!r.ok) think=true;                // an error: let it reason about the fix
        }
        messages.push(...after);
        // rounds that change nothing (failed connects, the same look again): point at the tools that do it, then stop
        if(aiagFingerprint()===fp0) stall++; else stall=0;
        if(stall===AIAG_STALL && stopAt===Infinity){ stopAt=i+3; stopWhy="stall";
          run.steps.push({kind:"nudge", text:`${stall} rounds without a change — asked to finish`});
          messages.push({role:"user", content:`(system) The last ${stall} rounds changed nothing on any sheet. Stop trying the same thing. `
            +"If you were wiring blocks: suggest_wires {sheet, apply:true} connects the pins it can match by name in one call — try it once. "
            +"Then answer in Thai: what is done, what is still not connected, and what the user should do."}); }
        // twice nothing independent to check against: say so and finish — do not loop until the step limit
        if(circularN>=2 && stopAt===Infinity){ stopAt=i+3; stopWhy="circular";
          run.steps.push({kind:"nudge", text:"no independent check possible — asked to finish"});
          messages.push({role:"user", content:"(system) There is nothing independent to check this circuit against. Stop building and answer now in Thai: what you built, what the simulation shows, and that it was checked only against your own table / formula (the user should confirm it against the lab sheet)."}); }
        continue;
      }
      // it changed a circuit but did not check / simulate THAT sheet (it once verified an empty sheet
      // while the real one had a wrong carry): name the sheets and what is missing
      // a nudge answered with words only is not repeated: the model that cannot make the call there wrote
      // made-up results ("ผ่าน 1,000 จาก 1,000") each time it was pushed again (div25: 4 calls, 120 s)
      if(unanswered && typeof aiagUnansweredFinish==="function"){ run.final=await aiagUnansweredFinish(run, m.content, needCheck, needSim); break; }
      if((needCheck.size || needSim.size) && nudges<2 && stopAt===Infinity){
        nudges++; think=true; unanswered=true;
        const miss=[...new Set([...needCheck, ...needSim])].map(n=>`'${n}' (${[needCheck.has(n)&&"check", needSim.has(n)&&"simulate or verify_truth_table"].filter(Boolean).join(" + ")})`).join(", ");
        run.steps.push({kind:"nudge", text:"not verified yet: "+miss});
        messages.push({role:"user", content:`(system) You changed ${miss} but did not verify ${needCheck.size+needSim.size>2?"them":"it"}. Call those tools with sheet set to that name, compare the result with what the circuit must do, fix it if it is wrong, then answer.`});
        continue;
      }
      // it changed a circuit that nothing independent has confirmed: once, point at derive_spec / set_spec
      if(!run.verified && run.touched.size && !gated && stopAt===Infinity){
        gated=true; think=true; const sh=[...run.touched].join(", ");
        run.steps.push({kind:"nudge", text:"not checked against the request: "+sh});
        messages.push({role:"user", content:`(system) Nothing has checked '${sh}' against the REQUEST yet. Call derive_spec {request:<the user's words>, sheet} — or set_spec with what the request says (formula / table.ones), not your circuit's table — then check_spec. If the request gives nothing to check against, answer and say it is unchecked.`});
        continue;
      }
      const didWork=run.steps.some(x=>x.kind==="tool" && x.ok && !x.fast_path);
      const wantsChange=typeof aiagWantsChange==="function" ? aiagWantsChange(run.message) : false;
      if(!didWork && wantsChange && !run.noToolNudged && stopAt===Infinity){
        run.noToolNudged=true;
        run.steps.push({kind:"nudge", text:String(m.content||"").trim() ? "answered without calling any tool — asked to make the calls" : "empty answer, no tool call — asked to make the calls"});
        messages.push({role:"user", content:"(system) You have not called any tool in this run — nothing has been changed or checked yet. "
          +"The user already asked for this change: make the tool calls now (follow your plan). If you cannot do it, say so plainly in Thai — never say it is done or checked."});
        continue; }
      run.final=String(m.content||"").trim() || (didWork ? "(เอเจนต์ไม่ได้เขียนสรุป — ดูขั้นตอนด้านบน)" : "เอเจนต์ไม่ได้ทำอะไรในรอบนี้ (ไม่ได้เรียกเครื่องมือเลย) — ลองสั่งใหม่ให้ชัดขึ้น หรือแบ่งเป็นขั้นตอนเล็กลง");
      if(typeof aiagNoWorkGuard==="function") run.final=aiagNoWorkGuard(run, run.final, didWork, wantsChange);
      if(didWork && typeof aiagClaimGuard==="function") run.final=aiagClaimGuard(run, run.final);
      break;
    }
    if(run.cancel && !run.final){ run.error="หยุดแล้ว ("+(run.cancelWhy||"สั่งหยุด")+")"; run.stopped=true; }
    if(!run.final && !run.error){ run.error=`หยุดที่ ${maxSteps} รอบ — งานนี้อาจใหญ่เกินไปสำหรับโมเดลในเครื่อง`; run.stopped=true; }
    if(run.final && typeof aiagScrubLang==="function") run.final=aiagScrubLang(run, run.final);
    if(run.final && typeof aiagVerdict==="function" && !run.fastFinal) run.final+=aiagVerdict(run);
  }catch(e){ run.error=String(e&&e.message||e); }
  run.state=run.final?"done":run.stopped?"stopped":"error"; run.seconds=Math.round((Date.now()-run.started)/100)/10;
  run.resumable=!run.final && !!run._messages;
  if(typeof aiagDeescalate==="function") aiagDeescalate(run);
  if(sb) sb.remove();
  aiagRemember(run);
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
    const opts=AIAG.nextOpts||{}; AIAG.nextOpts=null;
    try{ return await aiAgentRun(msg, opts); } finally{ AICHAT.busy=false; aiSetBusy(false); }
  };
  try{ const m=localStorage.getItem("schstudio.aiMode"); if(m==="agent" && /^https?:/.test(location.protocol)) aiSetMode("agent"); }catch(_){}
}

/* ---- Claude drives the chat (MCP ai_chat / ai_chat_status / ai_model): test the AI feature ---- */
function aiagChatLog(from){
  return [...document.querySelectorAll("#acLog > .ac-msg")].slice(from).map(d=>({role:d.classList.contains("user")?"user":"ai",
    text:aiagClip(d.innerText.trim(), 3000), error:d.classList.contains("err")||undefined}));
}
MCP_OPS.ai_chat = a=>{
  if(AICHAT.busy || AIAG.pending) mcpFail("the chat is still busy with the previous message", "call ai_chat_status until it is done, or ai_chat_stop");
  let prev=null;
  if(a.resume){ prev=[...AIAG.runs].reverse().find(r=>a.run_id ? r.id===+a.run_id : true);
    if(!prev || !prev.resumable) mcpFail("no run to resume"+(prev?` — run ${prev.id} ended with an answer or cannot be continued`:""), "resume works on a run stopped by ai_chat_stop, the step limit or the time budget, in this page (not after a reload)");
    a=Object.assign({}, a, {message:"(ทำต่อ) "+prev.message, mode:"agent"}); }
  const msg=String(a.message||"").trim(); if(!msg) mcpFail("message is required — what the user would type in the chat");
  AIAG.nextOpts={maxSteps:a.max_steps, budgetS:a.budget_s, resume:prev, noEscalate:a.escalate===false, think:a.think, temperature:a.temperature};
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
  const cap=AIAG.capture;
  // a finished run by id, or the latest one when this page has no capture (it was reloaded)
  if(a.run_id!=null || !cap){
    const live=AIAG.runs.find(r=>r.id===+a.run_id), old=aiagStored(), hit=live ? aiagRunSummary(live, a.detail==="full") : (a.run_id!=null ? old.find(x=>x.id===+a.run_id) : old[old.length-1]);
    if(!hit) return {state:"none", next:"send something with ai_chat first", recent_runs:old.map(x=>({id:x.id, message:aiagClip(x.message,80), state:x.state}))};
    return {state:hit.state==="running"?"running":"done", from:live?"this page":"saved (the page was reloaded since)", agent:hit,
      recent_runs:old.map(x=>({id:x.id, message:aiagClip(x.message,80), state:x.state, at:x.at}))};
  }
  const until=Date.now()+1000*Math.max(1, Math.min(40, +a.wait||40));
  while(!cap.done && Date.now()<until) await new Promise(r=>setTimeout(r, 300));
  const out={state:cap.done?"done":"running", mode:cap.mode, message:cap.message, seconds:cap.done?cap.seconds:Math.round((Date.now()-cap.started)/1000),
             chat:aiagChatLog(cap.from)};
  if(cap.error) out.error=cap.error;
  const run=AIAG.seq>cap.runBefore ? AIAG.runs.find(r=>r.id===cap.runBefore+1) : null;
  if(run) out.agent=aiagRunSummary(run, a.detail==="full");
  // the latest finished run's answer rides on every status, so a poll that timed out never loses it
  const last=aiagStored().slice(-1)[0];
  if(last && (!run || last.id!==run.id)) out.last_finished_run={id:last.id, state:last.state, message:aiagClip(last.message, 120), final:last.final, error:last.error, at:last.at};
  if(run && run.resumable) out.next_resume="ai_chat {resume:true} continues this run from where it stopped";
  if(!cap.done) out.next="still running — call ai_chat_status again";
  return out;
};
MCP_OPS.ai_chat_stop = async a=>{
  const run=AIAG.cur;
  if(!aiagStop(a.reason||"สั่งหยุดผ่าน MCP")) return {stopped:false, note:"nothing is running", last:run?{id:run.id, state:run.state}:null};
  // wait for the loop to notice (the model call is aborted at once; a tool that is running finishes first)
  const until=Date.now()+15000; while(run.state==="running" && Date.now()<until) await new Promise(r=>setTimeout(r, 200));
  return {stopped:true, run:run.id, state:run.state, resumable:!!run.resumable, next:"ai_chat {resume:true} to continue it, or ai_chat with a new message"};
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
    llama_processes:(s.processes||[]).map(p=>({pid:p.pid, mb:p.mb, ours:p.ours, path:p.path})),
    leftovers_stopped:(s.leftovers_stopped||[]).length||undefined,
    download:s.download, log_tail:aiagClip(s.log, 2500), agent_runs_logged:"launcher config folder ▸ agent-runs/*.jsonl"};
};
/* run ids go on across reloads, so a saved run is never overwritten by a new one with the same id */
try{ AIAG.seq=Math.max(0, ...aiagStored().map(x=>+x.id||0)); }catch(_){}
