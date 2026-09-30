/* ===== 36. The independent oracle, and the gate that makes "verified" mean something ==============
   The root of most in-app AI failures: the model built a circuit from ITS OWN table and then checked it
   against that same table — a wrong prime detector / a misread "ไม่ d" came back "ตรวจแล้วถูกต้อง".
   Marking such a check "NOT A CHECK" (33) made it honest but left the agent nothing that could ever
   pass, so it looped until the step limit. Here the yardstick comes from the REQUEST, derived by code:
     - equations written in it (34: aioEquations) → a formula spec;
     - a minterm list "f(a,b,c) = Σm(1,2,4,7)" → a table over those inputs;
     - "1 when the n-bit input is prime / even / > k …" (34: aioPredicate) → the rows;
     - a part it names ("4-bit adder", "BCD to 7-seg", "mod-6 counter") → spec kind "part": the sheet is
       checked against that part's reference model (22: partVerifyComb / partVerifySeq), by port name.
   MCP derive_spec (also the agent's) puts it on a sheet; the agent derives it itself before the first
   model call and attaches it to the sheet it builds. A pass of a spec that is not the circuit's own
   table ends the run; the final answer always ends with the APP's verdict, not the model's claim. */

/* "f(a,b,c) = Σm(1,2,4,7)", "y = minterms 1,3,5 of a b c" → {out, inputs, ones} or null */
function oracleMinterms(msg){
  const s=String(msg||"");
  const m=/([A-Za-z_]\w*)\s*(?:\(\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)+)\s*\))?\s*=\s*(?:Σ|∑|sum|sigma)?\s*m(?:interms?)?\s*\(?\s*(\d+(?:\s*,\s*\d+)*)\s*\)?/i.exec(s);
  if(!m) return null;
  let inputs=m[2] ? m[2].split(",").map(x=>x.trim()) : null;
  if(!inputs){ const li=/(?:inputs?|ขาเข้า|อินพุต)\s*[:：]?\s*([A-Za-z_]\w*(?:[\s,]+[A-Za-z_]\w*)+)/i.exec(s);
    if(li) inputs=li[1].split(/[\s,]+/).filter(x=>x && !/^(and|และ|output|ขาออก)$/i.test(x)); }
  const ones=m[3].split(",").map(x=>+x.trim());
  if(!inputs){ const n=Math.max(1, (Math.max(...ones)).toString(2).length); inputs=Array.from({length:n},(_,i)=>String.fromCharCode(97+i)); }
  if(inputs.length>10 || ones.some(v=>v>=(1<<inputs.length))) return null;
  return {out:m[1], inputs, ones:[...new Set(ones)].sort((a,b)=>a-b)};
}
/* the per-bit port names a part gets (bus:true → the base names) */
function oraclePartPorts(kind, p, bus){
  const P=PARTS[kind].ports(p), names=side=>Object.entries(P[side]).filter(([,w])=>w>0)
    .flatMap(([b,w])=>w>1&&!bus ? Array.from({length:w},(_,i)=>b+(w-1-i)) : [w>1?`${b}[${w-1}:0]`:b]);
  return {in:names("in"), out:names("out")};
}
/* the acceptance test a request states, derived by code — {ok, source, what, spec, ports} | {ok:false, reason} */
function oracleDerive(msg){
  msg=String(msg||"").trim(); if(!msg) return {ok:false, reason:"empty request"};
  const mt=oracleMinterms(msg);
  if(mt) return {ok:true, source:"minterms", what:`${mt.out} = Σm(${mt.ones.join(",")}) ของ ${mt.inputs.join(" ")}`,
    spec:{kind:"table", inputs:mt.inputs, cols:ttOnesToCols(mt.inputs.length, {[mt.out]:mt.ones})}, ports:{in:mt.inputs, out:[mt.out]}};
  const eq=typeof aioEquations==="function" && aioEquations(msg);
  if(eq) return {ok:true, source:"equations", what:"สมการในคำขอ "+eq.text, spec:{kind:"formula", text:eq.text}, ports:{in:eq.F.inputs, out:eq.F.outputs}};
  const pr=typeof aioPredicate==="function" && aioPredicate(msg);
  if(pr) return {ok:true, source:"condition", what:`${pr.out} = 1 เมื่อ ${pr.inputs.join(" ")} ${pr.what} (แถว ${pr.ones.join(", ")||"—"})`,
    spec:{kind:"table", inputs:pr.inputs, cols:ttOnesToCols(pr.inputs.length, {[pr.out]:pr.ones})}, ports:{in:pr.inputs, out:[pr.out]}};
  const fp=typeof partFromMessage==="function" && partFromMessage(msg);
  if(fp && PARTS[fp.kind]){
    let p; try{ p=partParams(fp.kind, fp.args||{}); }catch(e){ return {ok:false, reason:e.message}; }
    const P=PARTS[fp.kind];
    if(P.seq){ const S=P.seq(p); if(S.small) return {ok:false, reason:`${P.label}: too many clocks to check one by one — build_part ${fp.kind} is checked on a small copy`}; }
    else if(!P.ref) return {ok:false, reason:`${P.label} has no reference model`};
    return {ok:true, source:"part", what:`${P.label} ${JSON.stringify(p)} — เทียบกับโมเดลอ้างอิงของชิ้นส่วน`,
      spec:{kind:"part", part:fp.kind, params:p}, ports:oraclePartPorts(fp.kind, p, !!(fp.args&&fp.args.bus))};
  }
  return {ok:false, reason:"the request states no equations, minterms, numeric condition or standard part the app can read"};
}
/* is the sheet's spec the one derived from a request (and not edited since)? */
const oracleSig=sp=>JSON.stringify(sp||null);
function oracleIsRequestSpec(sch){ return !!(sch && sch.spec && sch.specSource==="request" && sch.specSig===oracleSig(sch.spec)); }
function oracleAttach(sch, o){
  sch.spec=JSON.parse(JSON.stringify(o.spec)); sch.specSource="request"; sch.specSig=oracleSig(sch.spec); sch.specWhat=o.what;
  delete sch.specResult; return specRun(sch);
}

/* ---- checking the new spec kinds ---- */
{
  const _sc=specCheck;
  specCheck=function(sch){
    const sp=sch && sch.spec;
    if(sp && sp.kind==="part"){
      if(!sch.components.some(c=>c.type!=="JUNCTION")) return _sc.apply(this, arguments);   // 34: pending
      const P=PARTS[sp.part]; if(!P) return {pass:false, reason:"ไม่รู้จักชิ้นส่วน "+sp.part};
      const want=P.ports(sp.params), pm=partPortMap(sch), miss=[];
      ["in","out"].forEach(side=>Object.entries(want[side]).filter(([,w])=>w>0).forEach(([b,w])=>{
        const L=pm[side][b]||[], ok=L.some(x=>x.bit==null && x.width===w) || (w===1&&L.length) || L.filter(x=>x.bit!=null).length===w;
        if(!ok) miss.push(w>1?`${side} ${b}${w-1}..${b}0 (หรือบัส ${b}[${w-1}:0])`:`${side} ${b}`); }));
      if(miss.length) return {pass:false, reason:"ชื่อขาไม่ตรงกับที่ต้องมี: "+miss.join(", "), expected_ports:oraclePartPorts(sp.part, sp.params, false)};
      // a part too slow to run clock by clock (lab 6: a count every 2 500 000 clocks) is checked on a small
      // copy when it is built: a sheet still exactly as that generator drew it passes on that check
      if(P.seq && P.seq(sp.params).small){
        const how=sch.verified && String(sch.verified.how||"");
        if(sheetVerified(sch) && how.startsWith(`part ${sp.part} ${JSON.stringify(sp.params)}`))
          return {pass:true, checked:"drawn by the part's own generator, unchanged since — "+how.replace(/^part \S+ \{[^}]*\} — /,"")};
        return {pass:null, reason:`${P.label}: ${JSON.stringify(sp.params)} runs too many clocks to compare one by one`,
          hint:`build both at a small scale and compare those — e.g. build_part {kind:'${sp.part}', ${Object.entries(P.seq(sp.params).small).map(([k,v])=>k+":"+v).join(", ")}} on another sheet, then compare_sheets {with}`};
      }
      try{ const v=P.seq ? partVerifySeq(sch, P, sp.params) : partVerifyComb(sch, P, sp.params);
        return {pass:v.pass, checked:v.method, mismatches:v.mismatch?[v.mismatch]:[], total_mismatches:v.pass?0:1, reason:v.pass?undefined:"ไม่ตรงกับโมเดลอ้างอิง: "+JSON.stringify(v.mismatch)}; }
      catch(e){ return {pass:false, reason:String(e&&e.message||e)}; }
    }
    // a table over NAMED inputs: rows matched by name, whatever order the sheet's inputs are in
    if(sp && sp.kind==="table" && Array.isArray(sp.inputs) && sch.components.some(c=>c.type!=="JUNCTION")){
      const sim=clientCombSim(sch); if(!sim.ok) return {pass:false, reason:sim.reason||"จำลองไม่ได้"};
      const tt=sim.truth_table, idx=sp.inputs.map(n=>tt.inputs.findIndex(x=>x.toLowerCase()===String(n).toLowerCase()));
      if(idx.some(k=>k<0) || tt.inputs.length!==sp.inputs.length)
        return {pass:false, reason:`ขาเข้าต้องเป็น ${sp.inputs.join(", ")} (แผ่นนี้มี ${tt.inputs.join(", ")})`};
      const n=sp.inputs.length, bad=[];
      Object.entries(sp.cols).forEach(([o,col])=>{ const k=tt.outputs.findIndex(x=>x.toLowerCase()===o.toLowerCase());
        if(k<0){ bad.push({output:o, reason:"ไม่มีขาออกนี้ (มี: "+tt.outputs.join(", ")+")"}); return; }
        tt.rows.forEach(([iv,ov])=>{ let r=0; idx.forEach((ti,j)=>{ if(+iv[ti]) r|=1<<(n-1-j); });
          const ch=String(col[r]||"x").toLowerCase(); if(ch==="x") return;
          if(String(ov[k])!==ch) bad.push({output:o, row:r, inputs:sp.inputs.map((nm,j)=>nm+"="+((r>>(n-1-j))&1)).join(" "), want:+ch, got:ov[k]}); }); });
      return {pass:!bad.length, checked:`${tt.rows.length} แถว`, mismatches:bad.slice(0,16), total_mismatches:bad.length, inputs:tt.inputs};
    }
    return _sc.apply(this, arguments);
  };
  // a spec from the request is independent by construction, even when the model typed the same table
  const _sr=specRun;
  specRun=function(sch){
    const r=_sr.apply(this, arguments);
    if(r && oracleIsRequestSpec(sch)){ r.independent=true; r.source="request"; delete r.warning;
      if(r.pass){ sheetVerifyStamp(sch, "spec from the request ("+(sch.specWhat||sch.spec.kind)+") — "+r.checked);
        if(sch.specResult) sch.specResult.summary=`✓ ผ่านข้อกำหนดจากคำขอ (${r.checked})`; } }
    return r;
  };
  const _sd=specDescribe;
  specDescribe=function(sp){
    if(sp && sp.kind==="part") return `ชิ้นส่วน ${PARTS[sp.part]?PARTS[sp.part].label:sp.part} ${JSON.stringify(sp.params||{})} (เทียบโมเดลอ้างอิง)`;
    return _sd.apply(this, arguments);
  };
}
/* set_spec by hand or by a model: remember whether it came before the circuit */
{
  const _ss=MCP_OPS.set_spec;
  MCP_OPS.set_spec=a=>{
    const s0=a.sheet && aifSheetByName(a.sheet), first=!s0 || !s0.components.some(c=>c.type!=="JUNCTION");
    const r=_ss(a), sch=aifSheetByName(r.sheet);
    if(sch){ sch.specSource=first?"spec-first":"after-build"; delete sch.specSig; }
    if(r && r.result && sch) r.result.spec_source=sch.specSource;
    return r;
  };
}
MCP_OPS.derive_spec = a=>{
  const req=String(a.request||a.message||"").trim(); if(!req) mcpFail("request is required: the user's words, as they wrote them");
  const o=oracleDerive(req);
  if(!o.ok) return {derived:false, reason:o.reason,
    hint:"write the spec yourself FROM THE REQUEST before building (set_spec formula / table.ones) — never from your circuit's table"};
  const out={derived:true, source:o.source, what:o.what, spec:o.spec, ports:o.ports,
    note:"derived by code from the request, not from any circuit: a sheet that passes it is right; name the ports as listed"};
  if(a.sheet && a.apply!==false){
    let s=aifSheetByName(a.sheet); if(!s) s=mcpSheet(MCP_OPS.new_sheet({name:String(a.sheet).trim()}).sheet);
    mcpBeforeChange("ข้อกำหนดจากคำขอ"); out.result=oracleAttach(s, o); out.sheet=s.name; mcpCommit(s);
    try{ renderProjectTree(); }catch(_){}
  }
  return out;
};

/* ---- the agent's gate (called from 18-ai-agent) ---- */
/* after every tool call: put the derived spec on the sheet it built, and notice a pass that counts */
function aiagOracleAfter(run, tool, r){
  if(!r || !r.ok || !r.result) return null;
  const R=r.result, name=R.sheet;
  if(run.oracle && /^build_(circuit|part|fsm|hierarchy)$/.test(tool) && name){
    const s=aifSheetByName(name);
    if(s && !oracleIsRequestSpec(s)){ const x=oracleAttach(s, run.oracle);
      if(x) R.spec_check={pass:x.pass, checked:x.checked, reason:x.reason, independent:true, source:"request",
        mismatches:(x.mismatches||[]).slice(0,4), total_mismatches:x.total_mismatches}; } }
  const sc=R.spec_check || (tool==="check_spec" ? R : null) || (tool==="set_spec"||tool==="derive_spec" ? R.result : null);
  const s=name && aifSheetByName(name);
  if(sc && sc.pass===true && sc.independent!==false && s && !run.verified){
    const req=oracleIsRequestSpec(s), how=req ? "ข้อกำหนดที่โปรแกรมอ่านจากคำขอ ("+(s.specWhat||"")+")"
      : s.specSource==="spec-first" ? "ข้อกำหนดที่ตั้งจากคำขอก่อนสร้างวงจร: "+specDescribe(s.spec) : "ข้อกำหนด "+specDescribe(s.spec);
    run.verified={sheet:s.name, how, checked:sc.checked, request:req};
    return `(system) Sheet '${s.name}' passes its acceptance test (${req?"derived by the app from the request":"set from the request"}, ${sc.checked||""}). It is done: stop changing it and answer now in Thai.`;
  }
  return null;
}
/* the line the app adds to every final answer that changed a circuit */
function aiagVerdict(run){
  if(run.verified) return `\n\n✓ ตรวจโดยโปรแกรม: แผ่น ${run.verified.sheet} ผ่าน${run.verified.how}${run.verified.checked?" — "+run.verified.checked:""}`;
  if(run.touched && run.touched.size) return `\n\n⚠ โปรแกรมยังไม่ได้ยืนยันแผ่น ${[...run.touched].join(", ")} กับข้อกำหนดที่เป็นอิสระจากวงจร — โปรดเทียบกับใบงาน`;
  return "";
}
/* "cout = a + b + cin" on one-bit ports is an OR (the course's notation) — right, but not what someone
   meaning addition expects: say so wherever such a formula comes in */
function oraclePlusWarning(text){
  const t=String(text||"");
  if(!/\+/.test(t) || /\{[^}]*\}\s*=/.test(t)) return null;
  return "'+' here is OR (boolean). For addition write the outputs as one number: {cout,s} = a + b + cin (or name the part: 'full adder', '4-bit adder')";
}
{
  const _ds=MCP_OPS.derive_spec;
  MCP_OPS.derive_spec=a=>{ const r=_ds(a); const w=r.spec&&r.spec.kind==="formula"&&oraclePlusWarning(r.spec.text); if(w) r.warning=w; return r; };
  const _ss=MCP_OPS.set_spec;
  MCP_OPS.set_spec=a=>{ const r=_ss(a); const w=a.formula!=null&&oraclePlusWarning(Array.isArray(a.formula)?a.formula.join("; "):a.formula);
    if(w && !(r.result&&r.result.pass)) r.warning=w; return r; };
}
