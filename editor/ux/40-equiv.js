/* ===== 40. Are two circuits the same? (Tools ▸ เทียบวงจร, MCP compare_sheets) =======================
   Marking a student's gates against a reference with no AI at all: the two sheets are driven with the
   same inputs, port by port by name, and every output is compared —
     - no flip-flops: every input row (≤ 12 input bits), else corners + 1000 random vectors;
     - flip-flops: clock by clock from reset, the same random stimulus into both (clk is the clock).
   A sheet can also be compared with a formula, a truth table, a library part or the request's own words
   (36-oracle-gate: the same checks as an acceptance test, run once without touching the sheet's spec). */
const eqPorts=sch=>schPortList(sch).map(p=>({name:p.id, dir:p.dir, width:p.width||1}));
const eqHasFF=sch=>{ try{ return flattenSchematic(sch).sch.components.some(c=>PROBE_SEQ[c.type]); }catch(_){ return false; } };
const eqNum=v=>typeof v==="string" ? (/^[01]+$/.test(v)?parseInt(v,2):NaN) : (v==null?NaN:+v);
const EQ_CLOCK=/^(clk|clock|clk_?in|clk50|clk_?50m?)$/i;
function eqRng(seed){ let s=seed>>>0||1; return ()=>{ s=(Math.imul(s,1103515245)+12345)>>>0; return s; }; }
/* compare sheet A with sheet B */
function eqSheets(A, B, opts){
  opts=opts||{};
  const pa=eqPorts(A), pb=eqPorts(B), k=p=>p.name.toLowerCase();
  const ins=pa.filter(p=>p.dir==="in"), insB=pb.filter(p=>p.dir==="in");
  const diffPorts=[];
  ins.forEach(p=>{ const q=insB.find(x=>k(x)===k(p)); if(!q) diffPorts.push(`INPUT ${p.name} อยู่ใน ${A.name} แต่ไม่มีใน ${B.name}`); else if(q.width!==p.width) diffPorts.push(`INPUT ${p.name}: ${p.width} บิต กับ ${q.width} บิต`); });
  insB.forEach(q=>{ if(!ins.find(p=>k(p)===k(q))) diffPorts.push(`INPUT ${q.name} อยู่ใน ${B.name} แต่ไม่มีใน ${A.name}`); });
  const outsA=pa.filter(p=>p.dir==="out"), outsB=pb.filter(p=>p.dir==="out");
  const common=outsA.filter(p=>outsB.find(q=>k(q)===k(p) && q.width===p.width));
  const onlyA=outsA.filter(p=>!common.includes(p)).map(p=>p.name), onlyB=outsB.filter(q=>!common.find(p=>k(p)===k(q))).map(q=>q.name);
  if(diffPorts.length) return {equivalent:false, reason:"ขาเข้าไม่ตรงกัน", port_differences:diffPorts, hint:"ตั้งชื่อ/ความกว้างขาเข้าให้ตรงกันก่อน แล้วเทียบอีกครั้ง"};
  if(!common.length) return {equivalent:false, reason:"ไม่มีขาออกชื่อเดียวกันให้เทียบ", only_in_a:onlyA, only_in_b:onlyB};
  const seq=eqHasFF(A) || eqHasFF(B), diffs=[];
  let method;
  if(!seq){
    const total=ins.reduce((n,p)=>n+p.width,0), V=[];
    if(total<=12){ for(let r=0;r<(1<<total);r++){ let s=0; const v={}; ins.forEach(p=>{ v[p.name]=(r>>s)&((1<<p.width)-1); s+=p.width; }); V.push(v); } method=`ทุกแถว (${V.length} แถว)`; }
    else { const rnd=eqRng(opts.seed||7);
      V.push(Object.fromEntries(ins.map(p=>[p.name,0])), Object.fromEntries(ins.map(p=>[p.name,2**p.width-1])));
      for(let i=0;i<1000;i++) V.push(Object.fromEntries(ins.map(p=>[p.name, p.width>=31 ? rnd() : rnd()%(2**p.width)])));
      method=`${V.length} ชุดอินพุต (มุม + สุ่ม) จาก ${total} บิต`; }
    const fa=flattenSchematic(A).sch, fb=flattenSchematic(B).sch, sa=probeStruct(fa), sb=probeStruct(fb);
    for(const v of V){ const oa=mcpEvalOuts(A, fa, sa, v), ob=mcpEvalOuts(B, fb, sb, v);
      common.forEach(p=>{ const x=eqNum(oa[p.name]), y=eqNum(ob[Object.keys(ob).find(n=>n.toLowerCase()===k(p))]);
        if(x!==y && diffs.length<20) diffs.push({inputs:v, output:p.name, a:isNaN(x)?"undriven":x, b:isNaN(y)?"undriven":y}); });
      if(diffs.length>=20) break; }
  } else {
    const cycles=Math.max(4, Math.min(512, +opts.cycles||64)), rnd=eqRng(opts.seed||11);
    const drive=ins.filter(p=>!EQ_CLOCK.test(p.name)), stim=[];
    for(let i=0;i<cycles;i++) stim.push(Object.fromEntries(drive.map(p=>{
      // reset-like inputs mostly off, so the circuit gets to run between resets
      const rare=/^(rst|reset|clr|clear|load|ld)$/i.test(p.name); return [p.name, rare ? (rnd()%9===0?1:0) : rnd()%(2**p.width)]; })));
    const run=S=>{ const INs=S.components.filter(c=>c.type==="IN"), id=n=>(INs.find(c=>String(c.params.name).toLowerCase()===n.toLowerCase())||{}).id;
      const holdAt=i=>{ const o={}; Object.entries(stim[i]||stim[stim.length-1]).forEach(([n,v])=>{ const c=id(n); if(c) o[c]=v; }); return o; };
      const j=clientSeqSim(S, cycles, {holdAt, hold:holdAt(0)}); if(!j.ok) throw new Error(S.name+": "+(j.reason||"จำลองไม่ได้")); return j.sequence; };
    let qa, qb; try{ qa=run(A); qb=run(B); }catch(e){ return {equivalent:false, reason:e.message}; }
    const at=(sq,row,n)=>{ const i=sq.outputs.findIndex(x=>x.toLowerCase()===n.toLowerCase()); return i<0?NaN:(row[4]?row[4][i]:row[3][i]); };
    for(let i=0;i<Math.min(qa.rows.length, qb.rows.length) && diffs.length<20;i++)
      common.forEach(p=>{ const x=at(qa, qa.rows[i], p.name), y=at(qb, qb.rows[i], p.name);
        if(x!==y && diffs.length<20) diffs.push({cycle:i, inputs:stim[i], output:p.name, a:x, b:y}); });
    method=`${cycles} clock จาก reset ด้วยอินพุตสุ่มชุดเดียวกัน`;
  }
  return {equivalent:!diffs.length, method, compared_outputs:common.map(p=>p.name),
    only_in_a:onlyA.length?onlyA:undefined, only_in_b:onlyB.length?onlyB:undefined, differences:diffs.length?diffs:undefined};
}
/* a sheet against a formula / table / part / the request: the acceptance-test checks, run once */
function eqAgainst(sch, spec){
  const keep={spec:sch.spec, specResult:sch.specResult, verified:sch.verified, specSource:sch.specSource, specSig:sch.specSig};
  try{ sch.spec=spec; delete sch.specResult; const r=specCheck(sch) || {pass:false, reason:"ตรวจไม่ได้"};
    return {equivalent:r.pass===true, method:r.checked, reason:r.reason, differences:(r.mismatches||[]).length?r.mismatches:undefined, total_differences:r.total_mismatches||undefined}; }
  finally{ Object.entries(keep).forEach(([k,v])=>{ if(v===undefined) delete sch[k]; else sch[k]=v; }); }
}
MCP_OPS.compare_sheets = a=>{
  const A=mcpSheet(a.sheet);
  let r, what;
  if(a.with){ const B=mcpSheet(a.with); if(B.id===A.id) mcpFail("compare a sheet with ANOTHER sheet"); r=eqSheets(A, B, a); what="sheet "+B.name; }
  else if(a.formula!=null){ r=eqAgainst(A, {kind:"formula", text:Array.isArray(a.formula)?a.formula.join("; "):String(a.formula)}); what="formula"; }
  else if(a.table){ const t=a.table; r=eqAgainst(A, t.ones ? {kind:"table", inputs:t.inputs, cols:ttOnesToCols((t.inputs||[]).length, t.ones)} : {kind:"table", inputs:t.inputs, cols:t.columns||t}); what="table"; }
  else if(a.part){ if(!PARTS[a.part]) mcpFail(`unknown part '${a.part}'`, "list_parts shows them"); r=eqAgainst(A, {kind:"part", part:a.part, params:partParams(a.part, a.params||{})}); what="part "+a.part; }
  else if(a.request){ const o=oracleDerive(a.request); if(!o.ok) mcpFail("the request gives nothing to compare with: "+o.reason); r=eqAgainst(A, o.spec); what=o.what; }
  else mcpFail("compare with what? with:<sheet>, formula, table, part or request");
  return Object.assign({sheet:A.name, against:what}, r);
};
/* Tools ▸ เทียบวงจร: pick two sheets (or a sheet and a library part) */
GENERATORS.push({id:"equiv", icon:"⚖", name:"เทียบวงจรสองแผ่น", desc:"ตรวจว่าวงจรสองแผ่นทำงานเหมือนกันไหม — เช่น วงจรของนักศึกษา เทียบกับวงจรอ้างอิง", run:()=>{
  const S=Object.values(state.project.schematics), opt=sel=>S.map(s=>`<option value="${esc(s.id)}"${s.id===sel?" selected":""}>${esc(s.name)}</option>`).join("");
  const cur=(activeSch()||{}).id, other=(S.find(s=>s.id!==cur)||{}).id;
  const m=uxModal("⚖ เทียบวงจร", `<p class="muted" style="margin:0 0 10px">ป้อนอินพุตชุดเดียวกันให้ทั้งสองแผ่น แล้วเทียบขาออกที่ชื่อเดียวกัน (มี flip-flop = เทียบทีละ clock)</p>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><select id="eqA">${opt(cur)}</select> เทียบกับ
      <select id="eqB">${opt(other)}<option value="part:">— ชิ้นส่วนมาตรฐาน —</option>${Object.keys(PARTS).map(k=>`<option value="part:${k}">${esc(PARTS[k].label)}</option>`).join("")}</select>
      <button class="btn" id="eqGo">เทียบ</button></div><div id="eqOut" style="margin-top:12px"></div>`, {width:640});
  m.querySelector("#eqGo").onclick=()=>{ const out=m.querySelector("#eqOut"), a=state.project.schematics[m.querySelector("#eqA").value], bv=m.querySelector("#eqB").value;
    let r; try{ r = bv.startsWith("part:") ? (bv.length>5 ? Object.assign({against:PARTS[bv.slice(5)].label}, eqAgainst(a, {kind:"part", part:bv.slice(5), params:partParams(bv.slice(5), {})})) : null)
      : eqSheets(a, state.project.schematics[bv]); }catch(e){ r={equivalent:false, reason:e.message}; }
    if(!r){ out.textContent="เลือกชิ้นส่วนก่อน"; return; }
    const d=(r.differences||[]).slice(0,8).map(x=>`<li>${x.cycle!=null?`clock ${x.cycle}: `:""}${esc(x.output)} — ${esc(JSON.stringify(x.inputs||x.inputs===0?x.inputs:x.row))}: ได้ ${esc(String(x.a!=null?x.a:x.got))} กับ ${esc(String(x.b!=null?x.b:x.want))}</li>`).join("");
    out.innerHTML=r.equivalent ? `<b style="color:var(--ok,#16a34a)">✓ ทำงานเหมือนกัน</b> <span class="muted">(${esc(r.method||"")})</span>`
      : `<b style="color:var(--err,#dc2626)">✗ ไม่เหมือนกัน</b> ${esc(r.reason||"")}${(r.port_differences||[]).map(x=>`<div class="muted">• ${esc(x)}</div>`).join("")}${d?`<ul>${d}</ul>`:""}`; };
}});
{
  const last=[...document.querySelectorAll('#menu [data-gen]')].pop();
  if(last && !document.querySelector('#menu [data-gen="equiv"]')){
    last.insertAdjacentHTML("afterend", `<button class="gen-mi" data-gen="equiv" title="ตรวจว่าวงจรสองแผ่นทำงานเหมือนกันไหม"><span class="gi">⚖</span>เทียบวงจรสองแผ่น…</button>`);
    document.querySelector('#menu [data-gen="equiv"]').addEventListener("click", ()=>runGenerator("equiv"));
  }
}
