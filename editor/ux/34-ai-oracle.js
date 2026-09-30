/* ===== 34. Requests the app turns into a spec ITSELF — no model in between ======================
   Testing 2.1.1 with Qwen3.5 4B: "y = (a และ b) หรือ (c และ ไม่ d)" came out as (a&b)|(~c&~d) — the
   model misread "ไม่ d" in its own reasoning, built that, and could only check the circuit against
   its own formula, so it reported a wrong circuit as right (after 468 s of retrying). Another run
   got the prime detector right but looped for 390 s because nothing independent could confirm it.
   Where the request itself says exactly what the circuit must do, code reads it:
     - equations written in the message, with Thai or English operators
       (และ/and → &, หรือ/or → |, ไม่/not → ~, เอ็กซ์ออร์/xor → ^): built straight from them;
     - "output 1 when the n-bit input is prime / even / odd / > k / < k / divisible by k":
       the rows are computed, not typed.
   Either way the result is simulated against what the code derived, and stamped verified. It runs
   before any model call (agent and build mode); a request that also asks for more (connect it, put
   it on the board…) goes on to the model with the part already built. */
const AIO_OPS=[[/เอ็กซ์ออร์|เอกซ์ออร์|เอ็กซ์ออ/g," ^ "],[/และ|แอนด์/g," & "],[/หรือ|ออร์/g," | "],[/ไม่|นอต|น็อต/g," ~ "]];
function aioThaiOps(s){ AIO_OPS.forEach(([re,op])=>{ s=s.replace(re, op); }); return s; }
/* the equations the message states, or null */
function aioEquations(msg){
  const src=aioThaiOps(String(msg||"")).replace(/เท่ากับ/g,"=").replace(/[×·]/g,"&").replace(/⊕/g,"^").replace(/[¬]/g,"~");
  const starts=[]; const re=/(\{[^}=]*\}|[A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g; let m;
  while((m=re.exec(src))) starts.push({i:m.index, lhs:m[1], at:re.lastIndex});
  if(!starts.length) return null;
  const eqs=[];
  for(let k=0;k<starts.length;k++){
    let rhs=src.slice(starts[k].at, k+1<starts.length?starts[k+1].i:src.length);
    rhs=rhs.split(/[;\n]|[^\x00-\x7f]/)[0];                         // stops at Thai text ("ลงแผ่น …") or a new line
    rhs=rhs.split(/\s+(?:on|in|into|to|sheet|named|called|as|with|using|please)\s+/i)[0].replace(/[,.\s]+$/,"").trim();
    if(!rhs || !/[A-Za-z_]/.test(rhs)) return null;
    let ok=null; const words=rhs.split(/\s+/);
    for(let cut=0; cut<=Math.min(3, words.length-1) && !ok; cut++){   // trailing words that are not part of it
      const cand=words.slice(0, words.length-cut).join(" ");
      try{ fxParse(fxTokens(cand), /^\{/.test(starts[k].lhs)); ok=cand; }catch(_){}
    }
    if(!ok) return null;
    eqs.push(starts[k].lhs+" = "+ok);
  }
  try{ const F=formulaTable(eqs.join("; ")); if(!F.inputs.length || F.inputs.length>8) return null;
    // an equation must have an operator (not "sheet = fx", not "n = 4")
    if(!eqs.some(e=>/[&|^~'+*!()]|\b(and|or|xor|not)\b/i.test(e.split("=").slice(1).join("=")))) return null;
    return {text:eqs.join("; "), F}; }catch(_){ return null; }
}
/* "output 1 when the input is prime / even / … " over n bits, or null */
function aioPredicate(msg){
  const t=" "+String(msg||"").toLowerCase()+" ";
  // counters, clocks, state machines count THROUGH values — that is not a condition on one input value
  if(/counter|นับ|clock|clk|flip|state|สถานะ|register|shift|รีจิสเตอร์|fsm|ลำดับ|sequence/.test(t)) return null;
  let pred=null, k=null;
  if(/prime|จำนวนเฉพาะ|เลขเฉพาะ/.test(t)) pred=v=>{ if(v<2) return false; for(let d=2;d*d<=v;d++) if(v%d===0) return false; return true; }, k="prime";
  else if((k=/(?:หาร\s*(?:ด้วย)?\s*(\d+)\s*ลงตัว|divisible\s+by\s+(\d+)|multiple\s+of\s+(\d+)|ผลคูณของ\s*(\d+))/.exec(t))){ const n=+(k[1]||k[2]||k[3]||k[4]); if(!n) return null; pred=v=>v%n===0; k="divisible by "+n; }
  else if((k=/(?:มากกว่าหรือเท่ากับ|ไม่น้อยกว่า|greater\s+than\s+or\s+equal\s+to|at\s+least|>=|≥)\s*(\d+)/.exec(t))){ const n=+k[1]; pred=v=>v>=n; k=">= "+n; }
  else if((k=/(?:น้อยกว่าหรือเท่ากับ|ไม่เกิน|less\s+than\s+or\s+equal\s+to|at\s+most|<=|≤)\s*(\d+)/.exec(t))){ const n=+k[1]; pred=v=>v<=n; k="<= "+n; }
  else if((k=/(?:มากกว่า|greater\s+than|more\s+than|>)\s*(\d+)/.exec(t))){ const n=+k[1]; pred=v=>v>n; k="> "+n; }
  else if((k=/(?:น้อยกว่า|less\s+than|fewer\s+than|<)\s*(\d+)/.exec(t))){ const n=+k[1]; pred=v=>v<n; k="< "+n; }
  else if(/\beven\b|เลขคู่|จำนวนคู่|เป็นคู่/.test(t)) pred=v=>v%2===0, k="even";
  else if(/\bodd\b|เลขคี่|จำนวนคี่|เป็นคี่/.test(t) && !/parity|พาริตี/.test(t)) pred=v=>v%2===1, k="odd";
  if(!pred) return null;
  // the inputs: listed (x2 x1 x0 / a3 a2 a1 a0, MSB first as written) or "n bits"
  const listed=[]; const lre=/\b([a-z_]+)(\d)\b/gi; let m; const seen=new Set();
  while((m=lre.exec(String(msg)))){ const nm=m[1]+m[2]; if(!seen.has(nm.toLowerCase())){ seen.add(nm.toLowerCase()); listed.push({b:m[1], i:+m[2], nm}); } }
  const byBase={}; listed.forEach(x=>(byBase[x.b.toLowerCase()]=byBase[x.b.toLowerCase()]||[]).push(x));
  const grp=Object.values(byBase).sort((a,b)=>b.length-a.length)[0];
  const nb=(/(\d+)\s*-?\s*(?:bit|บิต)/.exec(t)||[])[1];
  let inputs=null;
  if(grp && grp.length>=2 && (!nb || grp.length===+nb)) inputs=grp.slice().sort((a,b)=>b.i-a.i).map(x=>x.nm);
  else if(nb && +nb>=1 && +nb<=8) inputs=Array.from({length:+nb},(_,i)=>"x"+(+nb-1-i));
  if(!inputs) return null;
  const om=/(?:output|เอาต์พุต|เอาท์พุต|ขาออก|ออกที่)\s*(?:ชื่อ\s*)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(String(msg));
  const out=om && !inputs.includes(om[1]) ? om[1] : (k==="prime"?"p":"y");
  const ones=[]; for(let v=0; v<(1<<inputs.length); v++) if(pred(v)) ones.push(v);
  return {what:k, inputs, out, ones};
}
function aioSheetName(msg){
  const sm=/(?:ชีต|ชีท|แผ่น|sheet)\s*(?:ใหม่\s*)?(?:ชื่อ\s*)?[`"'“]?([A-Za-z_][A-Za-z0-9_]*)/.exec(msg) || /(?:ชื่อ|named|called)\s*[`"'“]?([A-Za-z_][A-Za-z0-9_]*)/.exec(msg);
  return sm ? sm[1] : null;
}
/* build what the request states; returns {kind, sheet, text, rows, final?} or null (let the model do it) */
async function aioBuild(msg, call){
  if(typeof aiLooksLikeQuestion==="function" && aiLooksLikeQuestion(msg) && !/=/.test(msg)) return null;
  const eq=aioEquations(msg), pr=eq?null:aioPredicate(msg);
  if(!eq && !pr) return null;
  const sheet=aioSheetName(msg);
  const args = eq ? {formula:eq.text, inputs:eq.F.inputs, name:"expr_"+sanId(eq.F.outputs[0])} :
    {truth_table:{inputs:pr.inputs, ones:{[pr.out]:pr.ones}}, name:(pr.what==="prime"?"prime":"cond")+pr.inputs.length};
  if(sheet){ args.sheet=sheet; const s=aifSheetByName(sheet); if(s && s.components.some(c=>c.type!=="JUNCTION")) args.replace=true; }
  const r=await call("build_circuit", args);
  if(!r.ok) return {error:r.error};
  // simulate it against what the CODE derived from the request
  const sch=aifSheetByName(r.result.sheet), j=clientCombSim(sch);
  if(!j.ok) return {error:j.reason||"simulate failed"};
  const tt=j.truth_table, want=eq ? eq.F.cols : ttOnesToCols(pr.inputs.length, {[pr.out]:pr.ones});
  let bad=0; Object.entries(want).forEach(([o,col])=>{ const k=tt.outputs.findIndex(x=>x.toLowerCase()===o.toLowerCase());
    col.split("").forEach((ch,rw)=>{ if(k<0 || String(tt.rows[rw][1][k])!==ch) bad++; }); });
  const what = eq ? "สมการในคำขอ "+eq.text : `${pr.out} = 1 เมื่อค่า ${pr.inputs.join(" ")} เป็น ${({prime:"จำนวนเฉพาะ",even:"เลขคู่",odd:"เลขคี่"})[pr.what]||pr.what} (แถว ${pr.ones.join(", ")||"—"})`;
  if(!bad) sheetVerifyStamp(sch, "request read by the app (no model): "+(eq?eq.text:pr.what+" over "+pr.inputs.join(",")));
  return {sheet:sch.name, text:what, rows:tt.rows.length, bad,
    final:`สร้างลงแผ่น ${sch.name} จาก${what} — โปรแกรมอ่านจากคำขอเองโดยตรง ไม่ผ่านการตีความของโมเดล\n`+
      (bad ? `⚠ จำลองแล้วไม่ตรง ${bad} จุด` : `✓ จำลองครบ ${tt.rows.length} แถว ตรงกับที่คำขอกำหนดทุกแถว`)+
      `\nขาเข้า ${tt.inputs.join(", ")} · ขาออก ${tt.outputs.join(", ")}`};
}
const AIO_MORE=/(ต่อ(กับ|เข้า|ไป)|เชื่อม|connect\s+\S+\s+to|วาง.*(บน|ใน)|บล็อก|\bblock\b|ลงบอร์ด|\bboard\b|\bpin|\bled|สวิตช์|ปุ่ม|แล้วใช้|แล้วเอา|แล้วต่อ|แล้วสร้าง|\bthen\b|ขาบอร์ด)/i;

/* ---- the agent: before the model ---- */
{
  const _fp=aiagFastPath;
  aiagFastPath=async function(msg, run){
    const r=await _fp.apply(this, arguments); if(r) return r;
    let res=null;
    try{ res=await aioBuild(msg, async (tool, args)=>{ const x=await aiagCall(tool, args);
      const st={kind:"tool", tool, args, ok:x.ok, fast_path:true, summary:x.ok?`sheet ${x.result.sheet} · built from the request, no model`:undefined, error:x.ok?undefined:x.error};
      run.steps.push(st); aiagLine(aiagStepHtml(st), "step"); return x; }); }catch(e){ console.warn("request oracle", e); }
    if(!res) return null;
    if(res.error) return {note:`(system) The request states what the circuit must do, but building it failed: ${res.error}. Build it yourself.`};
    run.steps.push({kind:"tool", tool:"simulate", args:{sheet:res.sheet}, ok:true, summary:res.bad?`${res.bad} rows differ`:`all ${res.rows} rows match the request`});
    if(res.bad || AIO_MORE.test(msg)) return {note:`(system) The app read the request itself and built it on sheet '${res.sheet}' (${res.text})${res.bad?`, but ${res.bad} rows differ — fix it`:" — it matches the request on every row, do not rebuild it"}. Do only the rest of the request.`};
    return {final:res.final};
  };
}
/* ---- build mode: the same, before the old pipeline ---- */
{
  const _send=aiSend;
  aiSend=async function(){
    const t=$("#acInput"), msg=t?String(t.value||"").trim():"";
    if(AICHAT.busy || !msg || msg[0]==="/" || AICHAT.mode==="agent" || AICHAT.mode==="qa" || AIO_MORE.test(msg)) return _send.apply(this, arguments);
    if(!aioEquations(msg) && !aioPredicate(msg)) return _send.apply(this, arguments);
    aiAppend("user", msg); t.value="";
    try{ const r=await aioBuild(msg, async (tool, args)=>{ try{ return {ok:true, result:await MCP_OPS[tool](args)}; }catch(e){ return {ok:false, error:e.message}; } });
      if(!r) aiAppend("ai", "อ่านคำขอนี้เองไม่ได้ — ลองโหมดเอเจนต์", {err:true});
      else if(r.error) aiAppend("ai", "สร้างไม่ได้: "+r.error, {err:true});
      else aiAppend("ai", `<span class="ac-badge v">อ่านจากคำขอ</span> `+esc(r.final).replace(/\n/g,"<br>"), {html:true}); }
    catch(e){ aiAppend("ai", "สร้างไม่ได้: "+e.message, {err:true}); }
  };
}
/* ---- a spec on a sheet with nothing on it yet is waiting, not failing ---- */
{
  const _sc=specCheck;
  specCheck=function(sch){
    if(sch && sch.spec && !sch.components.some(c=>c.type!=="JUNCTION"))
      return {pass:null, pending:true, reason:"ยังไม่มีวงจรบนแผ่นนี้ — สร้างลงแผ่นนี้แล้วข้อกำหนดจะถูกตรวจเอง"};
    return _sc.apply(this, arguments);
  };
  const _sr=specRun;
  specRun=function(sch){ const r=_sr.apply(this, arguments);
    if(r && r.pending && sch.specResult){ sch.specResult.summary="⏳ รอวงจร"; delete sch.verified; }
    return r; };
}
