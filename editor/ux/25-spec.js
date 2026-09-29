/* ===== 25. Acceptance tests: what a sheet MUST do, checked on every change =======================
   "ให้คนพื้นฐานน้อยทำงานเกินตัวได้": the user says what the circuit must do — a formula, a table, or
   a clock-by-clock sequence — and the sheet shows ✓ / ✗ from then on, re-checked after every edit
   (the project tree and the Inspector). It is also the independent yardstick an AI needs: a spec
   written from the requirement, not from the circuit. A passing spec stamps the sheet verified
   (22-parts: sheetVerifyStamp), so a hand-drawn or sequential sheet can be saved as a module too.
   sch.spec = {kind:"formula", text} | {kind:"table", cols:{out:"01x…"}}
            | {kind:"sequence", cycles, inputs:[{name:v}…] (per cycle, optional), expect:{out:[v|"x"…]}}
   A result is cached on the sheet (sch.specResult) for the badges. */
function specCheck(sch){
  const sp=sch && sch.spec; if(!sp) return null;
  try{
    if(sp.kind==="formula" || sp.kind==="table"){
      const sim=clientCombSim(sch);
      if(!sim.ok) return {pass:false, reason:sim.reason||"จำลองไม่ได้"};
      const tt=sim.truth_table;
      const cols = sp.kind==="formula" ? formulaTable(sp.text, tt.inputs).cols : sp.cols;
      const bad=[];
      Object.entries(cols).forEach(([o,col])=>{ const k=tt.outputs.findIndex(x=>x.toLowerCase()===o.toLowerCase());
        if(k<0){ bad.push({output:o, reason:"ไม่มีขาออกนี้"}); return; }
        String(col).toLowerCase().split("").forEach((ch,r)=>{ if(ch==="x"||!tt.rows[r]) return; const got=tt.rows[r][1][k];
          if(String(got)!==ch) bad.push({output:o, row:r, inputs:tt.rows[r][0].join(""), want:+ch, got}); }); });
      return {pass:!bad.length, checked:`${tt.rows.length} แถว`, mismatches:bad.slice(0,16), total_mismatches:bad.length, inputs:tt.inputs};
    }
    if(sp.kind==="sequence"){
      const ins=sch.components.filter(c=>c.type==="IN"), byName=n=>ins.find(c=>String(c.params.name).toLowerCase()===String(n).toLowerCase());
      const holdAt=i=>{ const v=(sp.inputs||[])[i]||(sp.inputs||[])[(sp.inputs||[]).length-1]||{}, o={};
        Object.entries(v).forEach(([n,val])=>{ const c=byName(n); if(c) o[c.id]=typeof val==="string"?mcpProbeVal(c,val):+val; }); return o; };
      const cycles=Math.max(1, Math.min(512, sp.cycles || Math.max(...Object.values(sp.expect||{}).map(a=>a.length), 1)));
      const j=clientSeqSim(sch, cycles, {holdAt, hold:holdAt(0)});
      if(!j.ok) return {pass:false, reason:j.reason||"จำลองไม่ได้"};
      const sq=j.sequence, bad=[];
      Object.entries(sp.expect||{}).forEach(([o,L])=>{ const k=sq.outputs.findIndex(x=>x.toLowerCase()===o.toLowerCase());
        if(k<0){ bad.push({output:o, reason:"ไม่มีขาออกนี้"}); return; }
        L.forEach((w,i)=>{ if(w==="x"||w==null||!sq.rows[i]) return; const row=sq.rows[i], got=row[4]?row[4][k]:row[3][k];
          const want=typeof w==="string" ? parseInt(w, /^[01]+$/.test(w)&&w.length>1?2:10) : +w;
          if(got!==want) bad.push({output:o, cycle:i, want, got}); }); });
      return {pass:!bad.length, checked:`${cycles} clock`, mismatches:bad.slice(0,16), total_mismatches:bad.length};
    }
    return {pass:false, reason:"ข้อกำหนดไม่รู้จักชนิด "+sp.kind};
  }catch(e){ return {pass:false, reason:String(e&&e.message||e)}; }
}
/* run it, remember the result, stamp the sheet when it passes */
function specRun(sch){
  const r=specCheck(sch); if(!r){ delete sch.specResult; return null; }
  sch.specResult={pass:r.pass, at:Date.now(), hash:sheetHash(sch), summary:r.pass?`✓ ผ่าน (${r.checked})`:`✗ ${r.reason||("ไม่ตรง "+r.total_mismatches+" จุด")}`};
  if(r.pass){ const how="spec "+(sch.spec.kind==="formula"?sch.spec.text:sch.spec.kind)+" — "+r.checked;
    if(!sheetVerified(sch) || !String(sch.verified.how).startsWith("part")) sheetVerifyStamp(sch, how); }
  return r;
}
/* re-check after edits (debounced); only sheets whose connectivity changed since their last check */
{
  let t=null;
  const again=()=>{ clearTimeout(t); t=setTimeout(()=>{ let changed=false;
    Object.values(state.project.schematics).forEach(s=>{ if(!s.spec) return;
      if(s.specResult && s.specResult.hash===sheetHash(s)) return;
      specRun(s); changed=true; });
    if(changed){ try{ renderProjectTree(); }catch(_){} try{ if(!state.selection.size) renderInspector(); }catch(_){} } }, 700); };
  const _snap=snapshot; snapshot=function(){ const r=_snap.apply(this, arguments); again(); return r; };
  const _undo=undo; undo=function(){ const r=_undo.apply(this, arguments); again(); return r; };
  const _redo=redo; redo=function(){ const r=_redo.apply(this, arguments); again(); return r; };
  // badges in the project tree
  const _tree=renderProjectTree;
  renderProjectTree=function(){ const r=_tree.apply(this, arguments);
    document.querySelectorAll('#projectPane .tree-item.sch[data-open]').forEach(el=>{
      const s=state.project.schematics[el.dataset.open]; if(!s || !s.specResult || el.querySelector(".spec-b")) return;
      const b=document.createElement("span"); b.className="spec-b "+(s.specResult.pass?"ok":"bad"); b.textContent=s.specResult.pass?"✓":"✗";
      b.title="ข้อกำหนด: "+s.specResult.summary; el.appendChild(b); });
    return r; };
  // the Inspector with nothing selected: the sheet's spec
  const _insp=renderInspector;
  renderInspector=function(){ const r=_insp.apply(this, arguments);
    try{ if(state.selection.size) return r; const sch=activeSch(), pane=$("#inspectorPane"); if(!sch||!pane) return r;
      const box=document.createElement("div"); box.className="spec-box";
      const sr=sch.spec && sch.specResult;
      box.innerHTML=`<div class="spec-h">ข้อกำหนดของแผ่นนี้ (acceptance test)</div>
        ${sch.spec ? `<div class="spec-s ${sr&&sr.pass?"ok":"bad"}">${esc(sr?sr.summary:"ยังไม่ได้ตรวจ")}</div>
          <div class="muted spec-d">${esc(specDescribe(sch.spec))}</div>`
          : `<div class="muted spec-d">บอกว่าวงจรนี้ต้องทำอะไร แล้วระบบจะตรวจให้ทุกครั้งที่แก้ — เช่น สมการ, ตารางความจริง หรือค่าที่ต้องได้ทีละ clock</div>`}
        <div class="spec-a"><button class="btn" id="specEdit">${sch.spec?"แก้ข้อกำหนด":"＋ ตั้งข้อกำหนด"}</button>
          ${sch.spec?`<button class="btn" id="specRun">ตรวจตอนนี้</button><button class="btn" id="specDel" title="ลบข้อกำหนด">🗑</button>`:""}</div>`;
      pane.appendChild(box);
      box.querySelector("#specEdit").onclick=()=>specDialog(sch);
      const rr=box.querySelector("#specRun"); if(rr) rr.onclick=()=>{ const x=specRun(sch); renderProjectTree(); renderInspector();
        if(x && !x.pass && x.mismatches&&x.mismatches.length) toast("ไม่ตรง: "+x.mismatches.slice(0,3).map(m=>m.cycle!=null?`${m.output} clock ${m.cycle} ต้องได้ ${m.want} ได้ ${m.got}`:`${m.output} แถว ${m.inputs} ต้องได้ ${m.want} ได้ ${m.got}`).join(" · "),"warn",7000); };
      const rd=box.querySelector("#specDel"); if(rd) rd.onclick=()=>{ delete sch.spec; delete sch.specResult; snapshot(); renderAll(); };
    }catch(e){ console.warn("spec box", e); }
    return r; };
}
function specDescribe(sp){
  if(sp.kind==="formula") return "สมการ: "+sp.text;
  if(sp.kind==="table") return "ตาราง: "+Object.entries(sp.cols).map(([k,v])=>k+"="+v).join(", ");
  if(sp.kind==="sequence") return `ลำดับ ${sp.cycles||""} clock: `+Object.entries(sp.expect||{}).map(([k,v])=>k+" = "+v.slice(0,12).join(",")+(v.length>12?"…":"")).join(" · ");
  return "";
}
/* the form: formula / table / "what it does now" */
function specDialog(sch){
  const sp=sch.spec||{};
  const hasFF=flattenSchematic(sch).sch.components.some(c=>PROBE_SEQ[c.type]);
  const m=uxModal("ข้อกำหนดของแผ่น "+esc(sch.name), `
    <div class="seg-tabs" style="margin-bottom:8px"><button data-sk="formula" class="${sp.kind!=="sequence"&&sp.kind!=="table"?"on":""}">สมการ</button>
      <button data-sk="table" class="${sp.kind==="table"?"on":""}">ตารางความจริง</button><button data-sk="sequence" class="${sp.kind==="sequence"?"on":""}">ลำดับทีละ clock</button></div>
    <div data-sp="formula"><textarea id="spF" rows="3" style="width:100%" placeholder="sum = a ^ b ^ cin; cout = a&b | cin&(a^b)   หรือ   {cout,sum} = a + b + cin">${esc(sp.kind==="formula"?sp.text:"")}</textarea>
      <div class="muted" style="font-size:11.5px">& AND · | OR · ^ XOR · ~ NOT · {…} = ตัวเลขหลายบิต (บิตสูงก่อน) · ชื่อต้องตรงกับขา INPUT/OUTPUT</div></div>
    <div data-sp="table" hidden><textarea id="spT" rows="3" style="width:100%" placeholder="sum = 01101001&#10;cout = 00010111">${esc(sp.kind==="table"?Object.entries(sp.cols).map(([k,v])=>k+" = "+v).join("\n"):"")}</textarea>
      <div class="muted" style="font-size:11.5px">หนึ่งบรรทัดต่อขาออก · หนึ่งตัวอักษรต่อแถว (0/1/x) · ขาเข้าตัวแรกเป็นบิตสูงสุด</div></div>
    <div data-sp="sequence" hidden><textarea id="spS" rows="3" style="width:100%" placeholder="q = 0,1,2,3,4,5,0,1&#10;clk_out = 0,0,0,1,1,1,0">${esc(sp.kind==="sequence"?Object.entries(sp.expect).map(([k,v])=>k+" = "+v.join(",")).join("\n"):"")}</textarea>
      <div class="muted" style="font-size:11.5px">ค่าที่ต้องได้ก่อน clock แต่ละลูก (เริ่มจาก clock 0) · x = ไม่สนใจ · อินพุตอื่นค้างที่ 0</div></div>
    <div class="spec-a" style="margin-top:8px"><button class="btn" id="spNow" title="ใช้พฤติกรรมตอนนี้เป็นข้อกำหนด — กันแก้แล้วพังทีหลัง">ใช้สิ่งที่วงจรทำตอนนี้</button></div>
    <div id="spMsg" class="muted" style="margin-top:6px"></div>`,
    {width:560, foot:`<button class="btn btn-primary" id="spSave">บันทึกและตรวจ</button>`});
  let kind=sp.kind||(hasFF?"sequence":"formula");
  const show=k=>{ kind=k; m.querySelectorAll("[data-sk]").forEach(b=>b.classList.toggle("on", b.dataset.sk===k)); m.querySelectorAll("[data-sp]").forEach(d=>d.hidden=d.dataset.sp!==k); };
  show(kind);
  m.querySelectorAll("[data-sk]").forEach(b=>b.onclick=()=>show(b.dataset.sk));
  const lines=t=>t.split(/\n+/).map(l=>l.trim()).filter(Boolean).map(l=>{ const i=l.indexOf("="); return i<1?null:[l.slice(0,i).trim(), l.slice(i+1).trim()]; }).filter(Boolean);
  m.querySelector("#spNow").onclick=()=>{
    if(hasFF){ const j=clientSeqSim(sch, 16); if(!j.ok){ toast(j.reason,"warn"); return; }
      const sq=j.sequence; m.querySelector("#spS").value=sq.outputs.map((o,k)=>o+" = "+sq.rows.map(r=>r[4]?r[4][k]:r[3][k]).join(",")).join("\n"); show("sequence"); }
    else { const j=clientCombSim(sch); if(!j.ok){ toast(j.reason,"warn"); return; }
      const tt=j.truth_table; m.querySelector("#spT").value=tt.outputs.map((o,k)=>o+" = "+tt.rows.map(r=>r[1][k]).join("")).join("\n"); show("table"); }
    m.querySelector("#spMsg").textContent="ใส่พฤติกรรมตอนนี้แล้ว — ตรวจว่าตรงกับที่ต้องการก่อนบันทึก";
  };
  m.querySelector("#spSave").onclick=()=>{
    let spec;
    try{
      if(kind==="formula"){ const t=m.querySelector("#spF").value.trim(); if(!t) throw new Error("ใส่สมการก่อน"); spec={kind, text:t}; }
      else if(kind==="table"){ spec={kind, cols:Object.fromEntries(lines(m.querySelector("#spT").value))}; if(!Object.keys(spec.cols).length) throw new Error("ใส่ตารางก่อน"); }
      else { const ex=Object.fromEntries(lines(m.querySelector("#spS").value).map(([k,v])=>[k, v.split(/[,\s]+/).filter(Boolean).map(x=>x==="x"?"x":(/^[01]{2,}$/.test(x)?x:+x))]));
        if(!Object.keys(ex).length) throw new Error("ใส่ค่าที่ต้องได้ก่อน"); spec={kind, expect:ex, cycles:Math.max(...Object.values(ex).map(a=>a.length))}; }
      sch.spec=spec; delete sch.specResult;
      const r=specRun(sch);
      if(r && r.reason && !r.pass && !r.mismatches){ throw new Error(r.reason); }
      m.close(); snapshot(); renderAll();
      toast(r.pass?"ตั้งข้อกำหนดแล้ว — วงจรผ่าน ✓":"ตั้งข้อกำหนดแล้ว — วงจรยังไม่ผ่าน ✗ ("+r.total_mismatches+" จุด)", r.pass?"ok":"warn", 5000);
    }catch(e){ m.querySelector("#spMsg").textContent="✗ "+(e.message||e); }
  };
}

/* ---------- MCP ---------- */
MCP_OPS.set_spec = a=>{
  const sch=mcpUse(a.sheet); let spec;
  if(a.formula!=null) spec={kind:"formula", text:Array.isArray(a.formula)?a.formula.join("; "):String(a.formula)};
  else if(a.table) spec={kind:"table", cols:a.table};
  else if(a.sequence){ const s=a.sequence; if(!s.expect) mcpFail("sequence needs expect: {output: [value per clock, …]}");
    spec={kind:"sequence", expect:s.expect, inputs:s.inputs, cycles:s.cycles||Math.max(...Object.values(s.expect).map(v=>v.length))}; }
  else mcpFail("give formula, table or sequence", 'e.g. formula:"sum = a^b^cin; cout = a&b | cin&(a^b)", sequence:{expect:{q:[0,1,2,3,4,5,0]}}');
  mcpBeforeChange("ตั้งข้อกำหนด");
  sch.spec=spec; delete sch.specResult;
  const r=specRun(sch);
  mcpCommit(sch);
  return {sheet:sch.name, spec, result:r, note:"checked again after every change; a passing spec marks the sheet verified"};
};
MCP_OPS.check_spec = a=>{
  const list=a.all_sheets ? Object.values(state.project.schematics).filter(s=>s.spec) : [mcpSheet(a.sheet)];
  const out=list.map(s=>{ if(!s.spec) return {sheet:s.name, spec:null, note:"no spec — set_spec first"};
    const r=specRun(s); return Object.assign({sheet:s.name, spec:specDescribe(s.spec)}, r); });
  try{ renderProjectTree(); }catch(_){}
  return a.all_sheets ? {sheets:out, pass:out.every(x=>x.pass)} : out[0];
};
