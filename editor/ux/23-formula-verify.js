/* ===== 23. Equations instead of 0/1 columns; checks that cannot agree with themselves; a gate
   before the module library; the agent's fast path for parts it can name =========================
   From testing the agent: the model wrote "sum = a⊕b⊕cin" correctly, then typed sum's column as
   "00001110", built that, verified it against the same string (pass), and saved it as FA1.
   - build_circuit {formula}: equations are turned into the truth table HERE ("sum = a^b^cin",
     "{cout,sum} = a+b+cin"), so no bits are typed by the model.
   - verify_truth_table: `formula` as the expectation; an expectation identical to what the sheet was
     built from proves nothing — it says so (independent:false) and does not count; the result
     names the circuit it recognises (uxRecognize), and simulate does too.
   - save_module refuses a sheet that is not verified (a part from build_part, or an independent
     truth-table check) unless force:true — the user asked for it anyway.
   - aiagFastPath: "full adder บนชีต fa3" → build_part directly, no model round at all. */

/* ---------- equations → truth table ---------- */
function fxTokens(src){
  const T=[], re=/\s*(?:([A-Za-z_][A-Za-z0-9_]*)|(\d+)|(==|[-+*&|^~!'()=,{}·⊕⊙¬∧∨]))/y;
  let m, i=0; src=String(src);
  while(i<src.length){ re.lastIndex=i; m=re.exec(src); if(!m){ if(/\s/.test(src[i])){ i++; continue; } throw new Error(`unexpected '${src[i]}' in "${src}"`); }
    i=re.lastIndex; if(m[1]){ const w=m[1].toLowerCase();
      if(["and","or","xor","not","xnor","nand","nor"].includes(w)) T.push({op:w}); else T.push({id:m[1]}); }
    else if(m[2]) T.push({num:+m[2]}); else T.push({op:m[3]}); }
  return T;
}
/* Pratt parser. bool mode: ~ ! ¬ ' NOT, & * · ∧ and AND, ^ ⊕ xor XOR, | + ∨ or OR;
   xnor ⊙ (= ~(a^b)), nand, nor at the level of xor / and / or.
   arith mode ({x,y} = …): + − * on integers, & | ^ ~ bitwise. */
function fxParse(tokens, arith){
  let k=0; const peek=()=>tokens[k], next=()=>tokens[k++];
  const BOOL={"|":1,"+":1,"∨":1,"or":1,"nor":1,"^":2,"⊕":2,"xor":2,"xnor":2,"⊙":2,"&":3,"*":3,"·":3,"∧":3,"and":3,"nand":3};
  const ARITH={"|":1,"or":1,"nor":1,"^":2,"xor":2,"⊕":2,"xnor":2,"⊙":2,"&":3,"and":3,"nand":3,"+":4,"-":4,"*":5};
  const bp=t=>t&&t.op&&(arith?ARITH:BOOL)[t.op]||0;
  const prefix=()=>{ const t=next(); if(!t) throw new Error("the expression ends too early");
    if(t.id) return {id:t.id}; if(t.num!=null) return {num:t.num};
    if(t.op==="("){ const e=expr(0); if(!peek()||peek().op!==")") throw new Error("missing )"); next(); return e; }
    if(["~","!","¬","not"].includes(t.op)) return {not:unary()};
    if(t.op==="-" && arith) return {neg:unary()};
    throw new Error(`unexpected '${t.op}'`); };
  const unary=()=>{ let e=prefix(); while(peek()&&peek().op==="'"){ next(); e={not:e}; } return e; };
  const expr=min=>{ let l=unary(); for(;;){ const t=peek(), p=bp(t); if(!p||p<=min) break; next(); l={op:t.op, l, r:expr(p)}; } return l; };
  const e=expr(0); if(k<tokens.length) throw new Error(`unexpected '${tokens[k].op||tokens[k].id||tokens[k].num}'`);
  return e;
}
function fxEval(e, env, arith){
  if(e.id!=null){ if(!(e.id in env)) throw new Error(`'${e.id}' is not an input`); return env[e.id]; }
  if(e.num!=null) return arith?e.num:(e.num?1:0);
  if(e.not) { const v=fxEval(e.not, env, arith); return arith?~v:(v?0:1); }
  if(e.neg) return -fxEval(e.neg, env, arith);
  const a=fxEval(e.l, env, arith), b=fxEval(e.r, env, arith), o=e.op;
  if(arith) return o==="+"?a+b : o==="-"?a-b : o==="*"?a*b : o==="&"||o==="and"?a&b : o==="|"||o==="or"?a|b
    : o==="nand"?~(a&b) : o==="nor"?~(a|b) : o==="xnor"||o==="⊙"?~(a^b) : a^b;
  if(["|","+","∨","or"].includes(o)) return a|b; if(["^","⊕","xor"].includes(o)) return a^b;
  if(o==="nor") return (a|b)?0:1; if(o==="xnor"||o==="⊙") return (a^b)?0:1; if(o==="nand") return (a&b)?0:1; return a&b;
}
/* equations (string with ; or newlines, or a list) → {inputs, outputs, cols:{out:"0110…"}} */
function formulaTable(formula, inputsGiven){
  let eqs=Array.isArray(formula) ? formula : (formula&&formula.equations) ? formula.equations : String(formula||"").split(/[;\n]+/);
  if(!inputsGiven && formula && formula.inputs) inputsGiven=formula.inputs;
  eqs=eqs.map(s=>String(s).trim()).filter(Boolean);
  if(!eqs.length) mcpFail("formula is empty", 'e.g. "sum = a ^ b ^ cin; cout = a&b | cin&(a^b)" or "{cout,sum} = a + b + cin"');
  const parsed=eqs.map(src=>{ const i=src.indexOf("="); if(i<1) mcpFail(`"${src}" is not an equation`, "write out = expression");
    const lhs=src.slice(0,i).trim(), rhs=src.slice(i+1).trim();
    const cat=/^\{(.*)\}$/.exec(lhs);
    const outs=(cat?cat[1]:lhs).split(",").map(s=>s.trim()).filter(Boolean);
    if(!outs.length || outs.some(o=>!/^[A-Za-z_]\w*$/.test(o))) mcpFail(`bad left side "${lhs}"`, "one name, or {msb,…,lsb}");
    let ast; try{ ast=fxParse(fxTokens(rhs), !!cat); }catch(e){ mcpFail(`cannot read "${src}": ${e.message}`); }
    return {src, outs, ast, arith:!!cat}; });
  const outputs=parsed.flatMap(p=>p.outs);
  const ids=[]; const walk=e=>{ if(!e) return; if(e.id!=null){ if(!ids.includes(e.id)) ids.push(e.id); return; } walk(e.not); walk(e.neg); walk(e.l); walk(e.r); };
  parsed.forEach(p=>walk(p.ast));
  const inputs=inputsGiven && inputsGiven.length ? inputsGiven.map(String) : ids.filter(x=>!outputs.includes(x));
  if(inputs.length>10) mcpFail(`${inputs.length} inputs — at most 10 for a truth table`, "split it into blocks, or use build_part");
  const cols={}; outputs.forEach(o=>cols[o]="");
  const n=inputs.length;
  for(let r=0;r<(1<<n);r++){
    const env={}; inputs.forEach((nm,i)=>env[nm]=(r>>(n-1-i))&1);
    for(const p of parsed){
      let v; try{ v=fxEval(p.ast, env, p.arith); }catch(e){ mcpFail(`"${p.src}": ${e.message}`, "inputs: "+inputs.join(", ")); }
      if(p.arith){ const L=p.outs.length; p.outs.forEach((o,k)=>{ const b=(v>>(L-1-k))&1; env[o]=b; cols[o]+=b; }); }
      else { const b=v?1:0; env[p.outs[0]]=b; cols[p.outs[0]]+=b; }
    }
  }
  return {inputs, outputs, cols, text:parsed.map(p=>p.src.replace(/\s+/g,"")).join(";")};
}

/* ---------- build_circuit: formula, and remember what the sheet was built from ---------- */
{
  const _build=MCP_OPS.build_circuit;
  MCP_OPS.build_circuit=async a=>{
    let from=null, args=a;
    if(a.formula!=null){
      const F=formulaTable(a.formula, a.inputs);
      args=Object.assign({}, a, {formula:undefined, inputs:undefined, truth_table:{inputs:F.inputs, outputs:F.outputs, columns:F.cols}});
      from={via:"formula", cols:F.cols, text:F.text};
    } else if(a.truth_table && a.truth_table.columns) from={via:"truth_table", cols:Object.fromEntries(Object.entries(a.truth_table.columns).map(([k,v])=>[k,String(v).toLowerCase()]))};
    const r=await _build(args);
    const sch=r && r.sheet ? Object.values(state.project.schematics).find(s=>s.name===r.sheet) : null;
    if(sch && from){ sch.builtFrom=from; delete sch.verified; }
    if(from && from.via==="formula") r.truth_table={inputs:args.truth_table.inputs, columns:from.cols, note:"computed from your equations"};
    if(sch){ try{ const j=clientCombSim(sch); if(j.ok){ const rec=uxRecognize(j.truth_table); if(rec) r.recognized=rec; } }catch(_){} }
    return r;
  };
}
/* ---------- simulate / verify_truth_table: what the circuit IS, and checks that mean something ---------- */
{
  const _sim=MCP_OPS.simulate;
  MCP_OPS.simulate=a=>{ const r=_sim(a);
    if(r && r.kind==="combinational" && !a.vectors){ try{ const j=clientCombSim(mcpSheet(a.sheet)); const rec=j.ok && uxRecognize(j.truth_table);
      r.recognized=rec || "not a standard circuit the checker knows"; }catch(_){} }
    return r; };
  const _ver=MCP_OPS.verify_truth_table;
  MCP_OPS.verify_truth_table=a=>{
    const sch=mcpSheet(a.sheet);
    let expected=a.expected, fromFormula=null;
    if(a.formula!=null){
      const sim=clientCombSim(sch); if(!sim.ok) mcpFail(sim.reason||"cannot simulate");
      const F=formulaTable(a.formula, sim.truth_table.inputs);
      fromFormula=F; expected=F.cols;
    }
    if(!expected) mcpFail("give expected ({out:\"0110…\"}) or formula (\"sum = a^b^cin; …\")");
    const r=_ver(Object.assign({}, a, {expected, formula:undefined}));
    // did the expectation come from somewhere else than what the sheet was built from?
    const B=sch.builtFrom;
    const same=B && Object.keys(expected).length && Object.entries(expected).every(([k,v])=>B.cols[k]!=null && String(v).toLowerCase()===String(B.cols[k]).toLowerCase());
    const tauto = same && (fromFormula ? (B.via==="formula" && B.text===fromFormula.text) : true);
    r.independent=!tauto;
    if(tauto){ r.warning="this expectation is exactly what the sheet was built from, so the check proves nothing. Derive what the circuit must do another way (e.g. its equations as formula, or a known property: a full adder's sum has four 1s, cout = majority) and verify against that.";
      r.counts_as_verified=false; }
    else if(r.pass){ sheetVerifyStamp(sch, fromFormula ? "truth table = formula "+fromFormula.text : "truth table = an independent table"); r.counts_as_verified=true; }
    try{ const j=clientCombSim(sch); if(j.ok){ const rec=uxRecognize(j.truth_table); r.recognized=rec||"not a standard circuit the checker knows"; } }catch(_){}
    return r;
  };
}
/* ---------- save_module: only what has been shown to work ---------- */
{
  const _save=MCP_OPS.save_module;
  MCP_OPS.save_module=a=>{
    const sch=mcpSheet(a.sheet);
    const ok=sheetVerified(sch);
    if(!ok && !a.force) mcpFail(`sheet '${sch.name}' is not verified — a module is reused everywhere, so a wrong one spreads`,
      "build it with build_part, or check it with verify_truth_table against an independently derived formula / table (not the columns it was built from); force:true saves it anyway (only when the user asks)");
    const r=_save(Object.assign({}, a, {force:undefined}));
    const m=state.modules && state.modules[r.id]; if(m){ m.verified=ok?sch.verified.how:"not verified (saved with force)"; saveModules(); }
    r.verified=ok?sch.verified.how:false;
    return r;
  };
  const _list=MCP_OPS.list_modules;
  MCP_OPS.list_modules=a=>{ const r=_list(a); r.modules.forEach(x=>{ const m=state.modules[x.id]; x.verified=(m&&m.verified)||false; }); return r; };
}

/* ---------- the agent's fast path: a part it can name needs no model round ---------- */
function partFromMessage(msg){
  const t=" "+String(msg||"").toLowerCase()+" ";
  const num=re=>{ const m=re.exec(t); return m?+m[1]:null; };
  const bits=num(/(\d+)\s*-?\s*(?:bit|บิต)/);
  const busy=/\b(bus|บัส)\b|บัส/.test(t);
  let kind=null, args={};
  const div=/(\d+(?:\.\d+)?)\s*(mhz|khz|hz)\s*(?:→|->|=>|เป็น|to|ไป|ลงเหลือ|เหลือ)\s*(\d+(?:\.\d+)?)\s*(mhz|khz|hz)/.exec(t);
  const hz=(v,u)=>+v*({mhz:1e6,khz:1e3,hz:1}[u]);
  if(/7\s*-?\s*seg|เจ็ดส่วน|seven\s*-?\s*seg/.test(t)){ kind="bcd_7seg"; args.active_low=!/active[\s-]*high|แอคทีฟไฮ/.test(t); }
  else if(/demux|ดีมัลติ/.test(t)){ kind="demux"; args.n=num(/1\s*(?:to|:|ต่อ|x|→)\s*(\d+)/)||4; }
  else if(/\bmux\b|multiplexer|มัลติเพล็ก/.test(t)){ kind="mux"; args.n=num(/(\d+)\s*(?:to|:|ต่อ|x|→)\s*1\b/)||4; }
  else if(div || /หารความถี่|clock\s*div|frequency\s*div|÷\s*\d|divide\s*by/.test(t)){
    kind=/\bjk\b/.test(t)?"jk_counter":"clock_divider";
    args.n=div?Math.round(hz(div[1],div[2])/hz(div[3],div[4])):num(/(?:หาร(?:ความถี่)?\s*(?:ด้วย)?|÷|divide\s*by)\s*(\d+)/); if(!args.n) return null; }
  else if(/\bjk\b/.test(t) && /counter|นับ|หาร/.test(t)){ kind="jk_counter"; args.n=num(/mod\s*-?\s*(\d+)/)||((num(/นับ\s*0\s*(?:-|–|ถึง)\s*(\d+)/)||9)+1); }
  else if(/bcd\s*counter|นับ\s*bcd|นับ\s*0\s*(?:-|–|ถึง)\s*9(?!\d)/.test(t)) kind="bcd_counter";
  else if(/mod\s*-?\s*\d+|นับ\s*0\s*(?:-|–|ถึง)\s*\d+/.test(t)){ kind="mod_counter"; args.n=num(/mod\s*-?\s*(\d+)/)||(num(/นับ\s*0\s*(?:-|–|ถึง)\s*(\d+)/)+1); }
  else if(/full\s*-?\s*sub|ตัวลบเต็ม/.test(t)) kind="full_subtractor";
  else if(/half\s*-?\s*sub|ตัวลบครึ่ง/.test(t)) kind="half_subtractor";
  else if(/full\s*-?\s*add|ฟูล\s*แอด|ตัวบวกเต็ม/.test(t)){ kind=bits>1?"adder":"full_adder"; if(bits>1) args.n=bits; }
  else if(/half\s*-?\s*add|ฮาล์ฟ\s*แอด|ตัวบวกครึ่ง/.test(t)) kind="half_adder";
  else if(/adder|ตัวบวก|วงจรบวก/.test(t) && bits){ kind="adder"; args.n=bits; }
  else if(/subtractor|ตัวลบ|วงจรลบ/.test(t) && bits){ kind="subtractor"; args.n=bits; }
  else if(/comparator|เปรียบเทียบ/.test(t)){ kind="comparator"; args.n=bits||4; }
  else if(/decoder|ดีโค้ด|ถอดรหัส/.test(t)){ kind="decoder"; args.n=num(/(\d)\s*(?:to|:|x|→|ไป)\s*\d+/)||bits||3; }
  else if(/encoder|เอนโค้ด|เข้ารหัส/.test(t)){ kind="encoder"; args.n=num(/(\d+)\s*(?:to|:|x|→|ไป)\s*\d/)||4; }
  else if(/parity|พาริตี/.test(t)){ kind="parity"; args.n=bits||4; args.odd=/odd|คี่/.test(t); }
  else if(/majority|เสียงข้างมาก/.test(t)) kind="majority";
  else if(/shift\s*-?\s*reg|ชิฟต์|ชิฟท์|เลื่อนบิต/.test(t)){ kind="shift_register"; args.n=bits||4; }
  else if(/(ripple|binary)\s*counter|ตัวนับ\s*\d+\s*บิต|counter\s*\d+\s*bit/.test(t)){ kind="binary_counter"; args.n=bits||4; }
  else if(/register|รีจิสเตอร์|เรจิสเตอร์/.test(t)){ kind="register"; args.n=bits||4; }
  else if(/toggle|ท็อกเกิล|t\s*-?\s*flip/.test(t)) kind="toggle";
  else if(/edge\s*-?\s*detect|จับขอบ/.test(t)) kind="edge_detector";
  else if(/debounce|ดีบาวซ์|กันเด้ง|กันสั่น/.test(t)) kind="debounce";
  if(!kind) return null;
  if(busy) args.bus=true;
  const sm=/(?:ชีต|ชีท|แผ่น|sheet)\s*(?:ใหม่\s*)?(?:ชื่อ\s*)?[`"'“]?([A-Za-z_][A-Za-z0-9_]*)/.exec(msg) || /ชื่อ\s*[`"'“]?([A-Za-z_][A-Za-z0-9_]*)/.exec(msg);
  if(sm) args.sheet=sm[1];
  // more than "make this part" (connect it, place it, pins, a board) → the model does the rest
  const more=/(ต่อ(กับ|เข้า|ไป)|เชื่อม|connect\s+\S+\s+to|วาง.*(บน|ใน)|บล็อก|\bblock\b|\btop\b|ลงบอร์ด|\bboard\b|\bpin|\bled|\bsw\d|สวิตช์|ปุ่ม|แล้วใช้|แล้วเอา|แล้วต่อ|แล้วสร้าง|และสร้าง|\bthen\b|ขาบอร์ด)/.test(t);
  // port names the user asked for must be the part's (else the model renames them)
  const named=[...String(msg).matchAll(/(?:อินพุต|เอาต์พุต|เอาท์พุต|inputs?|outputs?)\s*[:：]?\s*([A-Za-z_][\w\s,]*)/gi)].flatMap(m=>m[1].split(/[\s,]+/).filter(Boolean));
  return {kind, args, simple:!more, named};
}
async function aiagFastPath(msg, run){
  const fp=partFromMessage(msg); if(!fp) return null;
  const r=await aiagCall("build_part", Object.assign({kind:fp.kind}, fp.args));
  const st={kind:"tool", tool:"build_part", args:Object.assign({kind:fp.kind}, fp.args), ok:r.ok, fast_path:true,
            summary:r.ok?`sheet ${r.result.sheet} · ${r.result.verified.method}`:undefined, error:r.ok?undefined:r.error};
  run.steps.push(st); aiagLine(aiagStepHtml(st), "step");
  if(!r.ok) return {note:`(system) build_part ${fp.kind} failed: ${r.error}. Handle the request with the other tools.`};
  const R=r.result, portNames=R.ports.map(p=>p.name.toLowerCase());
  const wrongNames=fp.named.filter(n=>!portNames.includes(n.toLowerCase()) && !/^(and|or|xor|not)$/i.test(n));
  const desc=`build_part already made ${PARTS[fp.kind].label} on sheet '${R.sheet}' (ports: ${R.ports.map(p=>p.dir+" "+p.name+(p.width>1?"["+(p.width-1)+":0]":"")).join(", ")}) and it passed its reference check (${R.verified.method}) — do not rebuild or re-derive it.`;
  if(fp.simple && !wrongNames.length){
    let chk=""; try{ const c=MCP_OPS.check({sheet:R.sheet}); chk=` · check: error ${c.errors}, warning ${c.warnings}`; run.steps.push({kind:"tool", tool:"check", args:{sheet:R.sheet}, ok:true, summary:`errors ${c.errors} · warnings ${c.warnings}`}); }catch(_){}
    return {final:`สร้าง ${PARTS[fp.kind].label} ลงแผ่น ${R.sheet} แล้ว — ขาเข้า ${R.ports.filter(p=>p.dir==="in").map(p=>p.name+(p.width>1?"["+(p.width-1)+":0]":"")).join(", ")} · ขาออก ${R.ports.filter(p=>p.dir==="out").map(p=>p.name+(p.width>1?"["+(p.width-1)+":0]":"")).join(", ")}\nตรวจแล้วถูกต้อง: ${R.verified.method} (เทียบกับโมเดลอ้างอิงของชิ้นส่วน)${chk}`};
  }
  return {note:"(system) "+desc+(wrongNames.length?` The user named ports ${wrongNames.join(", ")} — rename the part's ports with update_component to match.`:"")+" Do only the rest of the request."};
}
