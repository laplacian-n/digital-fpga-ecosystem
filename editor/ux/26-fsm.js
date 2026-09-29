/* ===== 26. State machines from a state diagram (Tools ▸ ออกแบบ FSM, MCP build_fsm) ===============
   The labs that stop beginners are FSMs (traffic light, sequence detector, vending machine): the
   diagram → state table → encoding → K-maps → flip-flops step. Here the user writes the diagram as
   a few lines (or sees it drawn as they type), and the app does the rest — binary encoding with the
   reset state = 0 (the flip-flops' power-up value), next-state and output logic minimised per bit
   (unused codes go back to reset, so it can never lock up), D flip-flops — then runs the circuit
   clock by clock against the diagram itself before handing it over. The diagram stays on the sheet
   (sch.fsm) and becomes its acceptance test.

     inputs: x              outputs: z             (Moore: outputs per state)
     state S0: z=0          S0 -> S1 when x        S0 -> S0 when ~x
     state S1: z=0          S1 -> S2 when x        S1 -> S0 else
     state S2: z=1          S2 -> S2 when x        S2 -> S0 else
     reset S0
   Mealy: an output on the arrow — "S1 -> S2 when x / z=1". Conditions: & | ^ ~ ( ), "else" = none of the above. */
function fsmParse(src){
  if(src && typeof src==="object") return fsmNormalize(src);
  const M={inputs:[], outputs:[], states:[], transitions:[], reset:null, clock:"clk"};
  String(src||"").split(/\n|;/).map(l=>l.replace(/#.*$/,"").trim()).filter(Boolean).forEach((l,ln)=>{
    let m;
    if((m=/^inputs?\s*[:=]\s*(.*)$/i.exec(l))) M.inputs=m[1].split(/[\s,]+/).filter(Boolean);
    else if((m=/^outputs?\s*[:=]\s*(.*)$/i.exec(l))) M.outputs=m[1].split(/[\s,]+/).filter(Boolean);
    else if((m=/^clock\s*[:=]\s*(\w+)$/i.exec(l))) M.clock=m[1];
    else if((m=/^reset\s*[:=]?\s*(\w+)$/i.exec(l))) M.reset=m[1];
    else if((m=/^state\s+(\w+)\s*[:]?\s*(.*)$/i.exec(l))) M.states.push({name:m[1], out:fsmAssigns(m[2])});
    else if((m=/^(\w+)\s*-+>\s*(\w+)\s*(?:(?:when|if|on|:)\s*([^/]*?)|(else|otherwise))?\s*(?:\/\s*(.*))?$/i.exec(l)))
      M.transitions.push({from:m[1], to:m[2], when:(m[3]||m[4]||"").trim()||"1", out:m[5]?fsmAssigns(m[5]):null});
    else throw new Error(`บรรทัด ${ln+1} อ่านไม่ออก: "${l}"`);
  });
  return fsmNormalize(M);
}
function fsmAssigns(t){ const o={}; String(t||"").split(/[\s,]+/).filter(Boolean).forEach(p=>{ const m=/^(\w+)\s*=\s*([01])$/.exec(p); if(m) o[m[1]]=+m[2]; }); return o; }
function fsmNormalize(M){
  M={inputs:(M.inputs||[]).slice(), outputs:(M.outputs||[]).slice(), states:(M.states||[]).map(s=>typeof s==="string"?{name:s,out:{}}:{name:s.name, out:Object.assign({}, s.out||s.outputs||{})}),
     transitions:(M.transitions||[]).map(t=>({from:t.from, to:t.to, when:String(t.when==null?"1":t.when).trim()||"1", out:t.out?Object.assign({},t.out):null})),
     reset:M.reset, clock:M.clock||"clk"};
  // states named only in arrows count too
  M.transitions.forEach(t=>[t.from,t.to].forEach(n=>{ if(!M.states.some(s=>s.name===n)) M.states.push({name:n, out:{}}); }));
  if(!M.states.length) throw new Error("ยังไม่มี state");
  if(!M.reset) M.reset=M.states[0].name;
  if(!M.states.some(s=>s.name===M.reset)) throw new Error(`reset ${M.reset} ไม่ใช่ state`);
  // the reset state first → code 0
  M.states.sort((a,b)=>(a.name===M.reset?-1:b.name===M.reset?1:0));
  M.mealy=M.transitions.some(t=>t.out && Object.keys(t.out).length);
  const bad=[...M.inputs, ...M.outputs].find(n=>!/^[A-Za-z_]\w*$/.test(n)); if(bad) throw new Error(`ชื่อขาไม่ถูก: ${bad}`);
  if(M.inputs.some(n=>M.outputs.includes(n))) throw new Error("ชื่อขาเข้าและขาออกซ้ำกัน");
  const k=Math.max(1, Math.ceil(Math.log2(M.states.length)));
  if(k+M.inputs.length>10) throw new Error(`state ${M.states.length} ตัว + ขาเข้า ${M.inputs.length} ขา มากเกินไป (บิต state + ขาเข้า ≤ 10)`);
  M.bits=k;
  M.transitions.forEach(t=>{ if(t.when.toLowerCase()!=="else"){ try{ fxParse(fxTokens(t.when), false); }catch(e){ throw new Error(`เงื่อนไข "${t.when}" (${t.from} → ${t.to}): ${e.message}`); } } });
  return M;
}
/* the diagram's own meaning: from state s with inputs v → {to, out} */
function fsmStep(M, s, v){
  const env=Object.assign({}, v);
  const from=M.transitions.filter(t=>t.from===s);
  let hit=from.find(t=>t.when.toLowerCase()!=="else" && fxEval(fxParse(fxTokens(t.when), false), env, false));
  if(!hit) hit=from.find(t=>t.when.toLowerCase()==="else");
  const st=M.states.find(x=>x.name===s);
  const out={}; M.outputs.forEach(o=>out[o]=(st.out[o]||0));
  if(M.mealy) M.outputs.forEach(o=>out[o]=(hit&&hit.out&&hit.out[o]!=null)?hit.out[o]:(st.out[o]||0));
  return {to:hit?hit.to:s, out};                        // no arrow matches: stay
}
/* → intent: D flip-flops + minimised next-state / output logic */
function fsmIntent(M, opts){
  opts=opts||{};
  const k=M.bits, ni=M.inputs.length, nv=k+ni, code=n=>M.states.findIndex(s=>s.name===n);
  // variable v (qm: bit v of the row index): state bits are the high ones, inputs the low ones
  const rowOf=(sc, iv)=>(sc<<ni)|iv;
  const C=[{id:"clk", type:"IN", name:M.clock}], N=[];
  M.inputs.forEach(n=>C.push({id:"in_"+n, type:"IN", name:n}));
  for(let i=0;i<k;i++){ C.push({id:"ff"+i, type:"DFF"}); N.push({from:"clk", to:"ff"+i+".clk"}); }
  let g=0; const inv={};
  const lit=l=>{ if(l.v>=ni){ const b=l.v-ni; return "ff"+b+(l.neg?".qn":".q"); }
    const nm=M.inputs[ni-1-l.v]; if(!l.neg) return "in_"+nm;
    if(!inv[nm]){ inv[nm]="n_"+nm; C.push({id:inv[nm], type:"NOT"}); N.push({from:"in_"+nm, to:inv[nm]}); } return inv[nm]; };
  const tree=(type, ins)=>{ while(ins.length>8){ const nx=[]; for(let i=0;i<ins.length;i+=8){ const p=ins.slice(i,i+8); if(p.length===1){ nx.push(p[0]); continue; }
      const t=type.toLowerCase()+"_"+(g++); C.push({id:t,type}); p.forEach(s=>N.push({from:s,to:t})); nx.push(t); } ins=nx; } return ins; };
  const andCache=new Map();
  const sop=(ones, dcs)=>{ const r=qmMinimize(ones, dcs, nv);
    if(r.const0){ const id="gnd"+(g++); C.push({id, type:"GND"}); return id; }
    if(r.const1){ const id="vcc"+(g++); C.push({id, type:"VCC"}); return id; }
    const terms=r.terms.map(t=>{ if(t.length===1) return lit(t[0]);
      const key=t.map(l=>l.v+(l.neg?"n":"p")).sort().join(","); if(andCache.has(key)) return andCache.get(key);
      const ins=tree("AND", t.map(lit)), a="and_"+(g++); C.push({id:a, type:"AND"}); ins.forEach(s=>N.push({from:s, to:a})); andCache.set(key,a); return a; });
    const top=terms.length>1?tree("OR", terms):terms; if(top.length===1) return top[0];
    const o="or_"+(g++); C.push({id:o, type:"OR"}); top.forEach(s=>N.push({from:s, to:o})); return o; };
  const valid=new Set(M.states.map((_,i)=>i));
  // next state: unused codes → reset (0): never stuck in a state that is not on the diagram
  for(let b=0;b<k;b++){ const ones=[];
    for(let sc=0;sc<(1<<k);sc++) for(let iv=0;iv<(1<<ni);iv++){
      let nx=0; if(valid.has(sc)){ const v={}; M.inputs.forEach((n,j)=>v[n]=(iv>>(ni-1-j))&1); nx=code(fsmStep(M, M.states[sc].name, v).to); }
      if((nx>>b)&1) ones.push(rowOf(sc,iv)); }
    N.push({from:sop(ones, []), to:"ff"+b+".d"}); }
  // outputs: Moore = state only (inputs don't care), Mealy = state + inputs; unused codes don't care
  M.outputs.forEach(o=>{ const ones=[], dcs=[];
    for(let sc=0;sc<(1<<k);sc++) for(let iv=0;iv<(1<<ni);iv++){ const r=rowOf(sc,iv);
      if(!valid.has(sc)){ dcs.push(r); continue; }
      const v={}; M.inputs.forEach((n,j)=>v[n]=(iv>>(ni-1-j))&1);
      if(fsmStep(M, M.states[sc].name, v).out[o]) ones.push(r); }
    const id="out_"+o; C.push({id, type:"OUT", name:o}); N.push({from:sop(ones, dcs), to:id}); });
  if(opts.state_out!==false) for(let b=k-1;b>=0;b--){ const id="st_"+b; C.push({id, type:"OUT", name:"state"+b}); N.push({from:"ff"+b+".q", to:id}); }
  return {module:sanId(opts.name||"fsm"), components:C, nets:N};
}
/* the diagram run next to the circuit: a pseudo-random input walk, outputs (and the state) compared per clock */
function fsmVerify(sch, M, cycles){
  cycles=cycles||Math.min(200, 24*M.states.length*Math.max(1,1<<M.inputs.length));
  let seed=7; const rnd=()=>{ seed=(Math.imul(seed,1103515245)+12345)>>>0; return seed>>>16; };
  const ins=sch.components.filter(c=>c.type==="IN"), byName=n=>ins.find(c=>c.params.name===n);
  const drive=[]; for(let i=0;i<cycles;i++){ const v={}; M.inputs.forEach(n=>v[n]=rnd()&1); drive.push(v); }
  const j=clientSeqSim(sch, cycles, {holdAt:i=>{ const o={}; Object.entries(drive[i]).forEach(([n,x])=>{ const c=byName(n); if(c) o[c.id]=x; }); return o; }});
  if(!j.ok) return {pass:false, reason:j.reason};
  const sq=j.sequence, col=n=>sq.outputs.indexOf(n);
  let s=M.reset;
  for(let i=0;i<sq.rows.length;i++){
    const r=fsmStep(M, s, drive[i]), row=sq.rows[i];
    for(const o of M.outputs){ const got=row[3][col(o)]; if(got!==r.out[o]) return {pass:false, mismatch:{cycle:i, state:s, inputs:drive[i], output:o, want:r.out[o], got}}; }
    if(col("state0")>=0){ let code=0; for(let b=0;b<M.bits;b++) code|=(row[3][col("state"+b)]?1:0)<<b;
      if(code!==M.states.findIndex(x=>x.name===s)) return {pass:false, mismatch:{cycle:i, want_state:s, got_code:code}}; }
    s=r.to;
  }
  return {pass:true, method:`${sq.rows.length} clock อินพุตสุ่ม เทียบกับ state diagram`};
}
function fsmBuild(src, a){
  a=a||{};
  const M=fsmParse(src);
  const it=fsmIntent(M, {name:a.name||a.sheet||"fsm", state_out:a.state_out});
  const dr=aiDrawIntent(it);
  if(!dr||!dr.ok) throw new Error("วาดไม่ได้: "+((dr&&(dr.error||(dr.errors||[]).map(e=>e.msg||e).join("; ")))||"?"));
  const sch=dr.sch;
  sch.portOrder={in:[M.clock, ...M.inputs], out:[...M.outputs, ...Array.from({length:M.bits},(_,b)=>"state"+(M.bits-1-b))]};
  const v=fsmVerify(sch, M);
  if(!v.pass){ delete state.project.schematics[sch.id]; state.openTabs=(state.openTabs||[]).filter(i=>i!==sch.id); renderAll();
    throw new Error("ตรวจวงจรเทียบกับ diagram ไม่ผ่าน (บั๊กของตัวสร้าง): "+JSON.stringify(v.mismatch||v.reason)); }
  sch.fsm={src:typeof src==="string"?src:JSON.stringify(src), model:M};
  sheetVerifyStamp(sch, "fsm — "+v.method);
  const enc=M.states.map((s,i)=>({state:s.name, code:i.toString(2).padStart(M.bits,"0")}));
  return {sch, M, verify:v, encoding:enc};
}

/* ---------- a picture of the diagram (circle layout, arrows with conditions) ---------- */
function fsmSvg(M){
  const n=M.states.length, R=Math.max(90, 34*n), cx=R+100, cy=R+95, r=26;     // room for self-loops and their labels
  const pos={}; M.states.forEach((s,i)=>{ const a=-Math.PI/2+2*Math.PI*i/n; pos[s.name]={x:cx+R*Math.cos(a), y:cy+R*Math.sin(a)}; });
  let g=`<defs><marker id="fsmA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>`;
  const lab=t=>esc((t.when==="1"?"":t.when)+(t.out&&Object.keys(t.out).length?" / "+Object.entries(t.out).map(([k,v])=>k+"="+v).join(","):""));
  M.transitions.forEach(t=>{ const A=pos[t.from], B=pos[t.to];
    if(t.from===t.to){ const dx=A.x-cx, dy=A.y-cy, L=Math.hypot(dx,dy)||1, ux=dx/L, uy=dy/L, px=A.x+ux*r, py=A.y+uy*r;
      g+=`<path d="M${px-uy*10},${py+ux*10} C${px+ux*46-uy*30},${py+uy*46+ux*30} ${px+ux*46+uy*30},${py+uy*46-ux*30} ${px+uy*10},${py-ux*10}" fill="none" stroke="currentColor" marker-end="url(#fsmA)"/>
        <text x="${A.x+ux*(r+52)}" y="${A.y+uy*(r+52)+4}" text-anchor="middle" font-size="11" fill="currentColor">${lab(t)}</text>`; return; }
    const dx=B.x-A.x, dy=B.y-A.y, L=Math.hypot(dx,dy), ux=dx/L, uy=dy/L, nx=-uy*14, ny=ux*14;
    const x1=A.x+ux*r+nx*0.4, y1=A.y+uy*r+ny*0.4, x2=B.x-ux*r+nx*0.4, y2=B.y-uy*r+ny*0.4, mx=(x1+x2)/2+nx, my=(y1+y2)/2+ny;
    g+=`<path d="M${x1},${y1} Q${mx+nx},${my+ny} ${x2},${y2}" fill="none" stroke="currentColor" marker-end="url(#fsmA)"/>
      <text x="${mx+nx*1.3}" y="${my+ny*1.3+4}" text-anchor="middle" font-size="11" fill="currentColor">${lab(t)}</text>`; });
  M.states.forEach(s=>{ const p=pos[s.name], outs=Object.entries(s.out).map(([k,v])=>k+"="+v).join(",");
    g+=`<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="var(--bg-1,#fff)" stroke="currentColor" stroke-width="${s.name===M.reset?2.6:1.4}"/>
      <text x="${p.x}" y="${p.y+(outs?-2:4)}" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">${esc(s.name)}</text>
      ${outs?`<text x="${p.x}" y="${p.y+12}" text-anchor="middle" font-size="9.5" fill="currentColor">${esc(outs)}</text>`:""}`; });
  return `<svg viewBox="0 0 ${2*cx} ${2*cy}" width="100%" style="max-height:340px;color:var(--ink,#223)">${g}</svg>`;
}
function fsmTableHtml(M){
  const combos=1<<M.inputs.length;
  const head=`<tr><th>state</th>${Array.from({length:combos},(_,iv)=>`<th>${M.inputs.length?M.inputs.map((n,j)=>n+"="+((iv>>(M.inputs.length-1-j))&1)).join(" "):"next"}</th>`).join("")}${M.mealy?"":M.outputs.map(o=>`<th>${esc(o)}</th>`).join("")}</tr>`;
  const rows=M.states.map((s,sc)=>`<tr><td><b>${esc(s.name)}</b> <span class="muted">${sc.toString(2).padStart(M.bits,"0")}</span></td>${Array.from({length:combos},(_,iv)=>{ const v={}; M.inputs.forEach((n,j)=>v[n]=(iv>>(M.inputs.length-1-j))&1);
      const r=fsmStep(M, s.name, v); return `<td>${esc(r.to)}${M.mealy?" / "+M.outputs.map(o=>r.out[o]).join(""):""}</td>`; }).join("")}${M.mealy?"":M.outputs.map(o=>`<td>${s.out[o]||0}</td>`).join("")}</tr>`).join("");
  return `<table class="fsm-t">${head}${rows}</table>`;
}
const FSM_EXAMPLE=`# ตัวตรวจลำดับ 11 (Moore): z = 1 เมื่อ x เป็น 1 สองครั้งติดกัน
inputs: x
outputs: z
state S0: z=0
state S1: z=0
state S2: z=1
S0 -> S1 when x
S0 -> S0 else
S1 -> S2 when x
S1 -> S0 else
S2 -> S2 when x
S2 -> S0 else
reset S0`;
function openFsmTool(preset){
  const m=uxModal("ออกแบบ FSM (state machine)", `
    <div class="fsm-wrap"><div class="fsm-l"><textarea id="fsmSrc" spellcheck="false" rows="16">${esc(preset||FSM_EXAMPLE)}</textarea>
      <div class="muted" style="font-size:11px;line-height:1.5">inputs / outputs · <b>state</b> ชื่อ: ขาออก=ค่า (Moore) · <b>A -&gt; B when</b> เงื่อนไข (&amp; | ^ ~ , else) · Mealy: <b>A -&gt; B when x / z=1</b> · <b>reset</b> state เริ่มต้น</div>
      <label class="pt-f" style="margin-top:6px">ชื่อแผ่น <input id="fsmSheet" value="fsm" spellcheck="false" style="width:120px"></label>
      <label class="pt-f"><input type="checkbox" id="fsmState" checked> มีขาออก state (ดูบน LED ได้)</label></div>
      <div class="fsm-r"><div id="fsmPic"></div><div id="fsmTab"></div><div id="fsmMsg" class="muted"></div></div></div>`,
    {width:980, foot:`<button class="btn btn-primary" id="fsmGo">สร้างวงจร + ตรวจเทียบกับ diagram</button>`});
  const upd=()=>{ try{ const M=fsmParse(m.querySelector("#fsmSrc").value);
      m.querySelector("#fsmPic").innerHTML=fsmSvg(M); m.querySelector("#fsmTab").innerHTML=fsmTableHtml(M);
      m.querySelector("#fsmMsg").textContent=`${M.states.length} state → ${M.bits} flip-flop · ${M.mealy?"Mealy":"Moore"}`; m.querySelector("#fsmMsg").classList.remove("bad"); return M; }
    catch(e){ m.querySelector("#fsmMsg").textContent="✗ "+e.message; m.querySelector("#fsmMsg").classList.add("bad"); return null; } };
  m.querySelector("#fsmSrc").addEventListener("input", upd); upd();
  m.querySelector("#fsmGo").onclick=()=>{ if(!upd()) return;
    try{ const r=fsmBuild(m.querySelector("#fsmSrc").value, {sheet:m.querySelector("#fsmSheet").value.trim()||"fsm", state_out:m.querySelector("#fsmState").checked});
      const want=sanId(m.querySelector("#fsmSheet").value.trim()||"fsm"); r.sch.name=uniqueSchName(want, r.sch.id);
      m.close(); openSchTab(r.sch.id); snapshot(); renderAll(); try{ zoomFit(); }catch(_){}
      toast(`สร้าง FSM ${r.M.states.length} state แล้ว — ตรวจแล้วถูกต้อง: ${r.verify.method}`,"ok",5000); }
    catch(e){ m.querySelector("#fsmMsg").textContent="✗ "+e.message; } };
}
GENERATORS.push({id:"fsm", icon:"◎", name:"ออกแบบ FSM (state diagram)", desc:"เขียน state + ลูกศร → วงจร D-FF ที่ตรวจเทียบกับ diagram แล้ว", run:()=>openFsmTool((activeSch()&&activeSch().fsm&&activeSch().fsm.src)||null)});
{
  const last=[...document.querySelectorAll('#menu [data-gen]')].pop();
  if(last && !document.querySelector('#menu [data-gen="fsm"]')){
    last.insertAdjacentHTML("afterend", `<button class="gen-mi" data-gen="fsm" title="เขียน state + ลูกศร → วงจรที่ตรวจแล้ว"><span class="gi">◎</span>ออกแบบ FSM (state diagram)…</button>`);
    document.querySelector('#menu [data-gen="fsm"]').addEventListener("click", ()=>runGenerator("fsm"));
  }
}
/* the diagram is the sheet's acceptance test too */
{
  const _check=specCheck;
  specCheck=function(sch){ const r=_check.apply(this, arguments);
    if(r || !sch || !sch.fsm) return r;
    try{ const v=fsmVerify(sch, sch.fsm.model); return {pass:v.pass, checked:v.method||"", reason:v.reason, mismatches:v.mismatch?[v.mismatch]:[], total_mismatches:v.pass?0:1}; }
    catch(e){ return {pass:false, reason:String(e.message||e)}; } };
}

/* ---------- MCP ---------- */
MCP_OPS.build_fsm = a=>{
  if(!a.fsm) mcpFail("fsm is required", "text: 'inputs: x\\noutputs: z\\nstate S0: z=0\\n…\\nS0 -> S1 when x\\nreset S0', or {inputs, outputs, states:[{name, out}], transitions:[{from,to,when,out?}], reset}");
  const P=state.project.schematics, want=a.sheet?String(a.sheet).trim():"";
  const tgt=want?Object.values(P).find(s=>String(s.name).toLowerCase()===want.toLowerCase()):null;
  if(tgt && tgt.components.some(c=>c.type!=="JUNCTION")) mcpFail(`sheet '${tgt.name}' already has parts`, "give a new sheet name");
  mcpBeforeChange("สร้าง FSM");
  let r; try{ r=fsmBuild(a.fsm, {sheet:want||a.name, name:a.name, state_out:a.state_out}); }catch(e){ mcpFail(e.message); }
  let sch=r.sch;
  if(tgt){ ["components","wires","portOrder","fsm","verified"].forEach(k=>{ if(sch[k]!=null) tgt[k]=sch[k]; }); delete P[sch.id];
    state.openTabs=(state.openTabs||[]).filter(i=>i!==sch.id); sch=tgt; sheetVerifyStamp(sch, sch.verified.how); }
  else if(want) sch.name=uniqueSchName(want, sch.id);
  openSchTab(sch.id); mcpActivity("สร้าง FSM"); mcpCommit(sch); try{ zoomFit(); }catch(_){}
  return {sheet:sch.name, kind:r.M.mealy?"mealy":"moore", states:r.M.states.length, flip_flops:r.M.bits, encoding:r.encoding,
    ports:schPortList(sch).map(p=>({name:p.id, dir:p.dir, width:p.width})), verified:{pass:true, method:r.verify.method},
    note:"the diagram is kept on the sheet (Tools ▸ ออกแบบ FSM re-opens it) and is its acceptance test"};
};
