/* ===== 33. What testing the in-app AI (Qwen3.5 4B through ai_chat) turned up =====================
   - A prime detector came out WRONG and was reported "ตรวจแล้วถูกต้อง": the model listed the primes
     right in its reasoning, then typed the 0/1 column wrong (one bit off), built from it and verified
     against the same column. Small models reason about VALUES well and type bit strings badly, so a
     table can now be given as the rows that are 1 (ones:{p:[2,3,5,7]}), and a check that only
     compares a circuit with what it was built from says pass:null — it is not a check.
   - It called set_spec / check_spec on a sheet it had not made yet ("sheet not found", then gave
     up on the spec): set_spec now makes the empty sheet, the builders fill it and report the spec.
   - Each retry drew a NEW sheet (prime3, prime3_2 … prime3_5): builders take replace:true, and the
     agent passes it itself for a sheet it made in the same run.
   - It put a truth-table object into build_circuit.formula: taken as the table it is.
   - Build mode (not the agent) sent "full adder" to the model and failed after 55 s: a part it can
     name is built from the part library first, in both modes. */

/* {p:[2,3,5,7]} over n inputs (first input = MSB of the row number) → {p:"00110101"} */
function ttOnesToCols(n, ones, dc){
  const out={};
  if(!n || n>10) mcpFail(`ones needs the inputs (1..10 of them), got ${n||0}`, "give inputs:[…] with ones");
  Object.entries(ones||{}).forEach(([o,L])=>{
    if(!Array.isArray(L)) mcpFail(`ones.${o} must be a list of row numbers`, "e.g. ones:{p:[2,3,5,7]} — the rows (input values) where p is 1");
    const s=new Array(1<<n).fill("0");
    L.forEach(v=>{ v=+v; if(!(Number.isInteger(v) && v>=0 && v<(1<<n))) mcpFail(`ones.${o}: ${v} is not a row of ${n} inputs (0..${(1<<n)-1})`); s[v]="1"; });
    ((dc||{})[o]||[]).forEach(v=>{ v=+v; if(v>=0 && v<(1<<n) && s[v]!=="1") s[v]="x"; });
    out[o]=s.join(""); });
  return out;
}
function aifSheetByName(n){ if(!n) return null; const low=String(n).trim().toLowerCase(); return Object.values(state.project.schematics).find(s=>String(s.name).toLowerCase()===low)||null; }
/* replace:true — empty the named sheet so a builder fills it again (one undo step brings it back) */
function aifClearForRebuild(a){
  const name=a.sheet||a.name, s=aifSheetByName(name);
  if(!a.replace || !s || !s.components.some(c=>c.type!=="JUNCTION")) return a;
  mcpBeforeChange("สร้างแผ่น "+s.name+" ใหม่");
  s.components=[]; s.wires=[]; delete s.verified; delete s.builtFrom; delete s.fsm;
  return Object.assign({}, a, {sheet:s.name, replace:undefined});
}
/* a sheet with a spec reports it as soon as something is built into it */
function aifSpecOf(r){
  try{ const s=r && aifSheetByName(r.sheet); if(!s || !s.spec) return;
    const x=specRun(s); if(x) r.spec_check={pass:x.pass, checked:x.checked, reason:x.reason, independent:x.independent!==false,
      mismatches:(x.mismatches||[]).slice(0,4), total_mismatches:x.total_mismatches};
    try{ renderProjectTree(); }catch(_){}
  }catch(_){}
}
function aifInputsOf(sch){ try{ const j=clientCombSim(sch); return j.ok ? j.truth_table.inputs.length : 0; }catch(_){ return 0; } }

/* ---- build_circuit: ones, a table in `formula`, replace ---- */
{
  const _b=MCP_OPS.build_circuit;
  MCP_OPS.build_circuit=async a=>{
    a=Object.assign({}, a);
    if(a.formula && typeof a.formula==="object" && !Array.isArray(a.formula) && !a.formula.equations){
      const f=a.formula;
      if(f.columns || f.ones){ a.truth_table=f; delete a.formula; }
      else if(Object.keys(f).length && Object.values(f).every(v=>typeof v==="string" && /^[01x]+$/i.test(v))){
        if(!Array.isArray(a.inputs)) mcpFail("formula got a table of 0/1 columns but no inputs", "use truth_table:{inputs:[…], outputs:[…], columns:{…}} — or ones:{out:[rows that are 1]}");
        a.truth_table={inputs:a.inputs, outputs:Object.keys(f), columns:f}; delete a.formula; delete a.inputs; }
      else mcpFail("formula must be equations text, e.g. \"y = a&b | ~c\"", "a table goes in truth_table:{inputs, outputs, columns} or truth_table:{inputs, ones:{y:[rows that are 1]}}");
    }
    const t=a.truth_table;
    if(t && t.ones){
      if(!Array.isArray(t.inputs) || !t.inputs.length) mcpFail("truth_table.ones needs truth_table.inputs", 'e.g. truth_table:{inputs:["x2","x1","x0"], ones:{p:[2,3,5,7]}}');
      const cols=ttOnesToCols(t.inputs.length, t.ones, t.dont_care||t.dc);
      a.truth_table={inputs:t.inputs, outputs:t.outputs||Object.keys(Object.assign({}, t.columns||{}, cols)), columns:Object.assign({}, t.columns||{}, cols)};
    }
    a=aifClearForRebuild(a);
    const r=await _b(a); aifSpecOf(r); return r;
  };
  // build_part / build_fsm answer synchronously (the parts dialog and tests rely on it): stay that way
  ["build_part","build_fsm"].forEach(op=>{ const _o=MCP_OPS[op];
    MCP_OPS[op]=a=>{ const r=_o(aifClearForRebuild(Object.assign({}, a)));
      if(r && typeof r.then==="function") return r.then(x=>{ aifSpecOf(x); return x; });
      aifSpecOf(r); return r; }; });
}
/* ---- set_spec: makes the sheet it names; a table may be given as ones ---- */
{
  const _ss=MCP_OPS.set_spec;
  MCP_OPS.set_spec=a=>{
    a=Object.assign({}, a); let made=null;
    if(a.sheet && !aifSheetByName(a.sheet)){ made=MCP_OPS.new_sheet({name:String(a.sheet).trim()}).sheet; a.sheet=made; }
    if(a.table && a.table.ones){ const s=mcpSheet(a.sheet);
      const n=Array.isArray(a.table.inputs) ? a.table.inputs.length : aifInputsOf(s);
      if(!n) mcpFail("table.ones needs table.inputs on a sheet with no inputs yet", 'e.g. table:{inputs:["x2","x1","x0"], ones:{p:[2,3,5,7]}}');
      a.table=ttOnesToCols(n, a.table.ones, a.table.dont_care||a.table.dc); }
    const r=_ss(a);
    if(made) r.note=`sheet '${made}' did not exist — it was made empty and holds this spec. Build into it with build_circuit / build_part / build_fsm {sheet:'${made}', …}: the answer then includes spec_check.`;
    return r;
  };
}
/* ---- a check against what the sheet was built from is not a check ---- */
{
  const _v=MCP_OPS.verify_truth_table;
  MCP_OPS.verify_truth_table=a=>{
    a=Object.assign({}, a);
    if(a.expected && a.expected.ones){ const s=mcpSheet(a.sheet); a.expected=ttOnesToCols(aifInputsOf(s), a.expected.ones, a.expected.dont_care||a.expected.dc); }
    const r=_v(a);
    if(r && r.independent===false){ r.pass=null; r.result="NOT A CHECK — it only compared the circuit with the table it was built from"; }
    return r;
  };
  const _sr=specRun;
  specRun=function(sch){
    const r=_sr.apply(this, arguments);
    const sp=sch&&sch.spec, B=sch&&sch.builtFrom; if(!r || !sp || !B) return r;
    const same=(sp.kind==="table" && Object.keys(sp.cols||{}).length && Object.entries(sp.cols).every(([k,v])=>B.cols&&B.cols[k]!=null && String(v).toLowerCase()===String(B.cols[k]).toLowerCase()))
      || (sp.kind==="formula" && B.via==="formula" && String(B.text)===String(sp.text).replace(/\s+/g,""));
    if(same){ r.independent=false;
      r.warning="the spec is the very table / formula the sheet was built from, so passing it proves nothing — write what the circuit must do another way (its equations, the rows that are 1, a known property)";
      if(sch.verified && /^spec /.test(sch.verified.how||"")) delete sch.verified;
      if(sch.specResult) sch.specResult.summary="⚠ ข้อกำหนดเหมือนตารางที่ใช้สร้างวงจร — ยังไม่ได้ตรวจจริง"; }
    return r;
  };
}

/* ---- build mode: a part it can name comes from the library, not the model ---- */
{
  const _send=aiSend;
  aiSend=async function(){
    const t=$("#acInput"), msg=t?String(t.value||"").trim():"";
    if(AICHAT.busy || !msg || msg[0]==="/" || AICHAT.mode==="agent" || AICHAT.mode==="qa" || typeof partFromMessage!=="function"
       || (typeof aiLooksLikeQuestion==="function" && aiLooksLikeQuestion(msg))) return _send.apply(this, arguments);
    const fp=partFromMessage(msg);
    if(!fp || !fp.simple) return _send.apply(this, arguments);
    aiAppend("user", msg); t.value="";
    // a big part (a whole lab) takes half a minute: say so before the page is busy drawing it
    aiAppend("ai", `⏳ กำลังสร้าง ${PARTS[fp.kind].label} จากคลังชิ้นส่วน…`); await new Promise(r=>setTimeout(r, 60));
    try{
      const r=await MCP_OPS.build_part(Object.assign({kind:fp.kind}, fp.args));
      const io=d=>r.ports.filter(p=>p.dir===d).map(p=>p.name+(p.width>1?"["+(p.width-1)+":0]":"")).join(", ");
      aiAppend("ai", `<span class="ac-badge v">คลังชิ้นส่วน</span> สร้าง ${esc(PARTS[fp.kind].label)} ลงแผ่น <b>${esc(r.sheet)}</b> แล้ว<br>ขาเข้า ${esc(io("in"))} · ขาออก ${esc(io("out"))}<br>✓ ตรวจเทียบโมเดลอ้างอิงแล้ว: ${esc(r.verified.method)}`, {html:true});
    }catch(e){ aiAppend("ai", "สร้างจากคลังชิ้นส่วนไม่ได้: "+e.message+" — ลองอธิบายเพิ่มหรือใช้โหมดเอเจนต์", {err:true}); }
  };
}
