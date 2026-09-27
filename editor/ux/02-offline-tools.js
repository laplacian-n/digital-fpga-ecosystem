/* =========================================================================
   2. WORKS WITHOUT THE PYTHON BACKEND
   ========================================================================= */

/* ---------- 2a. combinational truth table in the browser ----------
   Same evaluator as probe mode (probeModel over the flattened sheet). Returns the
   backend's /sim shape so the board page and chat render it unchanged.
   {ok:false, fallback:true} = something this engine can't evaluate (bus ports,
   encoder/decoder/comparator blocks) → the caller may still try the backend. */
const CLIENT_SIM_MAX_IN = 12;
function clientCombSim(sch){
  let flat; try{ flat=flattenSchematic(sch); }catch(e){ return {ok:false, fallback:true, reason:"ยกวงจรไม่ได้: "+e.message}; }
  const fs=flat.sch;
  const nm=c=>(c.params&&c.params.name)||c.label||c.id;
  const ins=sch.components.filter(c=>c.type==="IN"), outs=sch.components.filter(c=>c.type==="OUT");
  if(!outs.length) return {ok:false, reason:"ยังไม่มี OUTPUT บนแผ่น — วาง OUTPUT แล้วต่อสายจากวงจรเข้าไป"};
  const known=t=>PROBE_GATES[t]||PROBE_SEQ[t]||["IN","OUT","CONST","VCC","GND","MUX","DEMUX","COMP","COMPM","ENC","DEC","JUNCTION","BUSTAP"].includes(t);
  const odd=[...new Set(fs.components.filter(c=>!known(c.type)).map(c=>c.type))];
  if(odd.length) return {ok:false, fallback:true, reason:"มีบล็อกที่ตัวจำลองในเบราว์เซอร์ยังไม่รองรับ: "+odd.join(", ")};
  /* a bus port is its bits, MSB first — swt(3:0) → swt[3] … swt[0], the same names the pin map
     uses. (Multi-bit ports used to be sent to the Python backend, which cannot express bus
     taps and answered "ERC failed".) */
  const cols=cs=>{ const L=[]; cs.forEach(c=>{ const w=probeWidth(c, c.type==="IN"?"o":"i");
    if(w<=1) L.push({c, bit:null, name:nm(c)}); else for(let b=w-1;b>=0;b--) L.push({c, bit:b, name:nm(c)+"["+b+"]"}); }); return L; };
  const inC=cols(ins), outC=cols(outs);
  if(inC.length>CLIENT_SIM_MAX_IN) return {ok:false, reason:"อินพุตรวม "+inC.length+" บิต = "+(2**inC.length)+" แถว มากเกินไป (สูงสุด "+CLIENT_SIM_MAX_IN+" บิต)"};
  const saved=Object.assign({}, PROBE_VALS);
  const st=probeStruct(fs), rows=[], floating=new Set();
  try{
    for(let r=0;r<(1<<inC.length);r++){
      const bits=inC.map((x,i)=>(r>>(inC.length-1-i))&1);          // first input = MSB (same as the backend)
      ins.forEach(c=>{ PROBE_VALS[c.id]=0; });
      inC.forEach((x,i)=>{ if(x.bit==null) PROBE_VALS[x.c.id]=bits[i]; else PROBE_VALS[x.c.id]=(PROBE_VALS[x.c.id]|(bits[i]<<x.bit))>>>0; });
      const m=probeModel(fs, st), got=new Map();
      outs.forEach(c=>got.set(c.id, m.inVal(c.id,"i")));
      const o=outC.map(x=>{ const v=got.get(x.c.id); if(v==null){ floating.add(nm(x.c)); return 0; } return x.bit==null ? (v?1:0) : ((v>>>x.bit)&1); });
      rows.push([bits, o]);
    }
  } finally {
    Object.keys(PROBE_VALS).forEach(k=>delete PROBE_VALS[k]); Object.assign(PROBE_VALS, saved);
  }
  return {ok:true, sequential:false, client:true,
    note: floating.size ? ("เอาต์พุตที่ไม่มีอะไรขับ (ถือเป็น 0): "+[...floating].join(", ")+" — ตรวจว่าต่อสายครบ") : "",
    truth_table:{inputs:inC.map(x=>x.name), outputs:outC.map(x=>x.name), rows}};
}
/* one entry point for every "simulate this sheet" button: browser first, backend only
   for what the browser can't do. Throws {backend:true} if that backend isn't running. */
async function uxSimSheet(sch, intent, cycles){
  const hasFF=flattenSchematic(sch).sch.components.some(c=>PROBE_SEQ[c.type]);
  if(hasFF) return clientSeqSim(sch, cycles||8);
  const j=clientCombSim(sch);
  if(j.ok || !j.fallback) return j;
  try{
    const r=await fetch(aiEndpoint()+"/sim",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({intent:intent||schematicToIntent(sch).intent, cycles:cycles||8})});
    return await r.json();
  }catch(e){ const err=new Error(j.reason); err.backend=true; err.why=j.reason; throw err; }
}

/* ---------- 2d. "this needs the backend" — say what to do, not just that it failed ---------- */
const BACKEND_CMD = "python ai/chat_server.py";
function uxBackendHelpHtml(what, why){
  return `<div class="ux-need">
    <div class="ux-need-h">⚙️ ${escA(what||"ฟีเจอร์นี้")} ต้องใช้ตัวช่วยฝั่ง Python (backend)</div>
    ${why?`<div class="ux-need-why">${escA(why)}</div>`:""}
    <ol>
      <li>ถ้าใช้โปรแกรม <b>FPGA Ecosystem</b> — เปิดผ่านโปรแกรมนั้น แล้วเปิดฟีเจอร์ AI ในหน้าตั้งค่า (มี backend ในตัว)</li>
      <li>หรือเปิด Terminal ที่โฟลเดอร์โปรเจกต์ แล้วรัน
        <span class="ux-cmd"><code>${BACKEND_CMD}</code><button type="button" class="ux-copy" data-copy="${escA(BACKEND_CMD)}">คัดลอก</button></span></li>
    </ol>
    <div class="ux-need-ok">ใช้ได้โดยไม่ต้องมี backend: จำลองวงจร (หน้า "จำลอง"), ตารางความจริง / K-map และตัวสร้างวงจรในเมนู Tools</div>
  </div>`;
}
document.addEventListener("click", ev=>{
  const b=ev.target.closest && ev.target.closest("[data-copy]"); if(!b) return;
  const t=b.dataset.copy;
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(
    ()=>{ const o=b.textContent; b.textContent="คัดลอกแล้ว ✓"; setTimeout(()=>b.textContent=o,1500); },
    ()=>{ prompt("คัดลอกคำสั่งนี้:", t); });
});
{
  const _aiAppend=aiAppend;
  aiAppend=function(role, content, opts){
    if(role==="ai" && !(opts&&opts.html) && /ต่อ backend ไม่ได้/.test(String(content)))
      return _aiAppend.call(this, role, uxBackendHelpHtml("คำสั่งนี้"), {html:true});
    return _aiAppend.apply(this, arguments);
  };
  // the chat's status dot tooltip: point at the fix too
  const _health=aiHealth;
  aiHealth=async function(){ const r=await _health.apply(this, arguments);
    const dot=$("#acDot"); if(dot && !r) dot.title="ไม่มี backend — วาดจากสมการ/ตาราง/ชื่อวงจรมาตรฐานได้ในเครื่อง · AI แบบพิมพ์อิสระต้องรัน "+BACKEND_CMD;
    return r; };
}

/* ---------- 2b. truth table / K-map → circuit (Quine–McCluskey, no backend) ---------- */
const GRAY=[[0],[0,1],[0,1,3,2]];
/* rows: {out: ["0"|"1"|"x", …]} indexed by row r, first input = MSB */
function ttToIntent(inputs, outputs, rows, module){
  const n=inputs.length, C=[], N=[], used=new Set();
  const inId=i=>"in_"+i, notId=i=>"n_"+i;
  inputs.forEach((nm,i)=>C.push({id:inId(i), type:"IN", name:nm}));
  const lit=l=>{ const i=n-1-l.v; if(!l.neg) return inId(i); used.add(i); return notId(i); };  // qm var k = bit k (LSB)
  const andCache=new Map(); let g=0; const exprs={};
  const litTxt=l=>inputs[n-1-l.v]+(l.neg?"'":"");
  outputs.forEach((on,oi)=>{
    const col=rows[on]||[], ones=[], dcs=[];
    col.forEach((v,r)=>{ if(v==="1") ones.push(r); else if(v==="x") dcs.push(r); });
    const res=qmMinimize(ones, dcs, n), oid="out_"+oi;
    C.push({id:oid, type:"OUT", name:on});
    if(res.const0){ C.push({id:"gnd_"+oi,type:"GND"}); N.push({from:"gnd_"+oi,to:oid}); exprs[on]="0"; return; }
    if(res.const1){ C.push({id:"vcc_"+oi,type:"VCC"}); N.push({from:"vcc_"+oi,to:oid}); exprs[on]="1"; return; }
    exprs[on]=res.terms.map(t=>t.slice().sort((x,y)=>y.v-x.v).map(litTxt).join("·")).join(" + ");   // in input order
    const srcs=res.terms.map(t=>{
      if(t.length===1) return lit(t[0]);
      const key=t.map(l=>l.v+(l.neg?"n":"p")).sort().join(",");
      if(andCache.has(key)) return andCache.get(key);               // shared product term (7-seg!)
      const a="and_"+(g++); C.push({id:a,type:"AND"}); t.forEach(l=>N.push({from:lit(l),to:a})); andCache.set(key,a); return a;
    });
    if(srcs.length===1) N.push({from:srcs[0], to:oid});
    else { const o="or_"+oi; C.push({id:o,type:"OR"}); srcs.forEach(s=>N.push({from:s,to:o})); N.push({from:o,to:oid}); }
  });
  used.forEach(i=>{ C.push({id:notId(i),type:"NOT"}); N.push({from:inId(i),to:notId(i)}); });
  // self-check: the minimised SOP must match every cared-for row
  for(const on of outputs){ const col=rows[on]||[];
    for(let r=0;r<(1<<n);r++){ if(col[r]!=="0" && col[r]!=="1") continue;
      const ex=exprs[on]; let v;
      if(ex==="0") v=0; else if(ex==="1") v=1;
      else v=ex.split(" + ").some(term=>term.split("·").every(tok=>{ const neg=tok.endsWith("'"), name=neg?tok.slice(0,-1):tok, i=inputs.indexOf(name);
        const bit=(r>>(n-1-i))&1; return neg?bit===0:bit===1; }))?1:0;
      if(String(v)!==col[r]) return {error:`ตรวจไม่ผ่านที่ ${on} แถว ${r}`}; } }
  return {intent:{module:sanId(module||"truth_table")||"truth_table", components:C, nets:N}, exprs};
}
const SEG7 = { // BCD 0-9 → a..g (active-high), 10-15 don't care
  a:"1011011111", b:"1111100111", c:"1101111111", d:"1011011011", e:"1010001010", f:"1000111011", g:"0011111011" };
function seg7Preset(activeLow){
  const rows={};
  for(const s of "abcdefg"){ rows[s]=[]; for(let r=0;r<16;r++){ const v=r<10?SEG7[s][r]:"x"; rows[s].push(v==="x"?"x":(activeLow?(v==="1"?"0":"1"):v)); } }
  return {inputs:["b3","b2","b1","b0"], outputs:"abcdefg".split(""), rows, module:activeLow?"bcd_7seg_al":"bcd_7seg"};
}
function openTruthTableTool(preset){
  const T=preset?JSON.parse(JSON.stringify(preset)):{inputs:["a","b"], outputs:["y"], rows:{y:["0","0","0","0"]}, module:"my_logic"};
  let view="table", kOut=T.outputs[0];
  const m=uxModal("▦ สร้างวงจรจากตารางความจริง / K-map", `
    <div class="tt-cfg">
      <label>อินพุต <input id="ttIns" spellcheck="false" title="คั่นด้วยจุลภาค สูงสุด 6 ตัว"></label>
      <label>เอาต์พุต <input id="ttOuts" spellcheck="false" title="คั่นด้วยจุลภาค สูงสุด 8 ตัว"></label>
      <label>ชื่อวงจร <input id="ttMod" spellcheck="false"></label>
    </div>
    <div class="tt-bar">
      <div class="seg-tabs"><button data-ttv="table" class="on">ตาราง</button><button data-ttv="kmap">K-map</button></div>
      <span class="muted">คลิกช่องเอาต์พุตเพื่อสลับ 0 → 1 → X (don't care)</span>
      <span style="flex:1"></span>
      <button class="btn" data-ttfill="0">ทั้งหมด 0</button><button class="btn" data-ttfill="1">ทั้งหมด 1</button>
      <button class="btn" id="ttFromSheet" title="ใช้ชื่อ INPUT/OUTPUT ของแผ่นที่เปิดอยู่">ใช้พอร์ตจากแผ่นนี้</button>
    </div>
    <div id="ttGrid" class="tt-grid"></div>
    <div id="ttExpr" class="tt-expr"></div>`,
    {width:760, foot:'<span id="ttMsg" class="muted" style="margin-right:auto"></span><button class="btn" id="ttCancel">ยกเลิก</button><button class="btn btn-primary" id="ttBuild">สร้างวงจร</button>'});
  const $m=s=>m.querySelector(s);
  $m("#ttIns").value=T.inputs.join(", "); $m("#ttOuts").value=T.outputs.join(", "); $m("#ttMod").value=T.module||"";
  const n=()=>T.inputs.length;
  function normalize(){
    const rc=1<<n();
    T.outputs.forEach(o=>{ const col=T.rows[o]||[]; T.rows[o]=Array.from({length:rc},(_,r)=>col[r]||"0"); });
    if(!T.outputs.includes(kOut)) kOut=T.outputs[0];
  }
  const parseNames=(s,max)=>[...new Set(String(s).split(/[,\s]+/).map(x=>sanId(x.trim())).filter(Boolean))].slice(0,max);
  function cell(o,r){ const v=T.rows[o][r]; return `<button class="tt-c v${v}" data-o="${escA(o)}" data-r="${r}">${v==="x"?"X":v}</button>`; }
  function draw(){
    normalize();
    const g=$m("#ttGrid");
    if(view==="table"){
      let h='<table class="tt-t"><tr><th class="rn">#</th>'+T.inputs.map(x=>`<th>${escA(x)}</th>`).join("")+'<th class="sp"></th>'+T.outputs.map(x=>`<th class="o">${escA(x)}</th>`).join("")+'</tr>';
      for(let r=0;r<(1<<n());r++){
        h+=`<tr><td class="rn">${r}</td>`+T.inputs.map((_,i)=>`<td>${(r>>(n()-1-i))&1}</td>`).join("")+'<td class="sp"></td>'+T.outputs.map(o=>`<td>${cell(o,r)}</td>`).join("")+'</tr>';
      }
      g.innerHTML=h+'</table>';
    } else {
      if(n()<2||n()>4){ g.innerHTML='<div class="muted" style="padding:12px">K-map ใช้กับอินพุต 2–4 ตัว (ตอนนี้ '+n()+' ตัว) — ใช้แท็บ “ตาราง” แทน</div>'; }
      else {
        const rb=n()>>1, cb=n()-rb, rg=GRAY[rb], cg=GRAY[cb];
        const rn=T.inputs.slice(0,rb).join(""), cn=T.inputs.slice(rb).join("");
        const lbl=(v,bits)=>v.toString(2).padStart(bits,"0");
        let h=`<div class="tt-kbar">เอาต์พุต <select id="ttKOut">${T.outputs.map(o=>`<option ${o===kOut?"selected":""}>${escA(o)}</option>`).join("")}</select></div>`;
        h+=`<table class="tt-k"><tr><th class="corner">${escA(rn)}＼${escA(cn)}</th>`+cg.map(c=>`<th>${lbl(c,cb)}</th>`).join("")+'</tr>';
        rg.forEach(rv=>{ h+=`<tr><th>${lbl(rv,rb)}</th>`+cg.map(cv=>{ const r=(rv<<cb)|cv; return `<td>${cell(kOut,r)}<span class="mi">${r}</span></td>`; }).join("")+'</tr>'; });
        g.innerHTML=h+'</table>';
        const ks=g.querySelector("#ttKOut"); if(ks) ks.onchange=()=>{ kOut=ks.value; draw(); };
      }
    }
    g.querySelectorAll(".tt-c").forEach(b=>b.onclick=()=>{ const o=b.dataset.o, r=+b.dataset.r, v=T.rows[o][r];
      T.rows[o][r]= v==="0"?"1": v==="1"?"x":"0"; draw(); });
    const res=ttToIntent(T.inputs, T.outputs, T.rows, T.module);
    $m("#ttExpr").innerHTML= res.error ? `<span style="color:var(--err)">${escA(res.error)}</span>`
      : '<div class="muted" style="margin-bottom:4px">สมการที่ลดรูปแล้ว (Quine–McCluskey):</div>'+T.outputs.map(o=>`<div><b>${escA(o)}</b> = ${escA(res.exprs[o])}</div>`).join("");
    const gates=res.intent?res.intent.components.filter(c=>!["IN","OUT"].includes(c.type)).length:0;
    $m("#ttMsg").textContent=res.intent?`${gates} เกต`:"";
  }
  $m("#ttIns").onchange=()=>{ const v=parseNames($m("#ttIns").value,6); if(v.length){ T.inputs=v; } $m("#ttIns").value=T.inputs.join(", "); draw(); };
  $m("#ttOuts").onchange=()=>{ const v=parseNames($m("#ttOuts").value,8); if(v.length){ T.outputs=v; } $m("#ttOuts").value=T.outputs.join(", "); draw(); };
  $m("#ttMod").onchange=()=>{ T.module=sanId($m("#ttMod").value)||"my_logic"; };
  m.querySelectorAll("[data-ttv]").forEach(b=>b.onclick=()=>{ view=b.dataset.ttv; m.querySelectorAll("[data-ttv]").forEach(x=>x.classList.toggle("on",x===b)); draw(); });
  m.querySelectorAll("[data-ttfill]").forEach(b=>b.onclick=()=>{ const v=b.dataset.ttfill;
    const outs=view==="kmap"?[kOut]:T.outputs; outs.forEach(o=>T.rows[o]=T.rows[o].map(()=>v)); draw(); });
  $m("#ttCancel").onclick=()=>m.close();
  const here=uxSheetPortsForTT();
  if(!here) $m("#ttFromSheet").style.display="none";
  else $m("#ttFromSheet").onclick=()=>{ T.inputs=here.inputs.slice(0,6); T.outputs=here.outputs.slice(0,8);
    $m("#ttIns").value=T.inputs.join(", "); $m("#ttOuts").value=T.outputs.join(", "); draw(); };
  const updBuild=()=>{ const f=uxCanFillSheet(T); $m("#ttBuild").textContent=f?"สร้างลงแผ่นนี้":"สร้างวงจร (แผ่นใหม่)";
    $m("#ttBuild").title=f?"พอร์ตตรงกับแผ่นที่เปิดอยู่ — วาดลงแผ่นนี้ ขาบอร์ดที่เลือกไว้ยังอยู่":"สร้างเป็นแผ่นใหม่"; };
  m.addEventListener("change", updBuild); m.addEventListener("click", ()=>setTimeout(updBuild,0));
  $m("#ttBuild").onclick=()=>{
    T.module=sanId($m("#ttMod").value)||"my_logic";
    const res=ttToIntent(T.inputs, T.outputs, T.rows, T.module);
    if(res.error){ toast(res.error,"err"); return; }
    if(uxCanFillSheet(T)){ uxFillSheet(activeSch(), res.intent); m.close();
      toast(`วาดลงแผ่น "${activeSch().name}" แล้ว — ${T.outputs.map(o=>o+" = "+res.exprs[o]).join(" · ")}`,"ok",5200); return; }
    const dr=aiDrawIntent(res.intent);
    if(!dr||!dr.ok){ toast("วาดไม่ได้: "+((dr&&(dr.error||(dr.errors||[]).join(", ")))||"?"),"err",4000); return; }
    m.close();
    toast(`สร้าง "${dr.sch.name}" แล้ว — ${T.outputs.map(o=>o+" = "+res.exprs[o]).join(" · ")}`,"ok",5200);
  };
  draw(); updBuild();
}

/* ---------- 2c. circuit generators, visible in the Components tab ---------- */
function uxAsk(title, fields, okText){
  return new Promise(resolve=>{
    const m=uxModal(title, fields.map((f,i)=>`<div class="row"><label>${f.label}</label>
        <input data-i="${i}" type="${f.type||"text"}" value="${escA(f.value)}" ${f.min!=null?`min="${f.min}"`:""} ${f.max!=null?`max="${f.max}"`:""} spellcheck="false"></div>
        ${f.hint?`<div class="muted" style="margin:-4px 0 10px 140px;font-size:11.5px">${f.hint}</div>`:""}`).join(""),
      {width:460, foot:`<button class="btn" id="uaNo">ยกเลิก</button><button class="btn btn-primary" id="uaOk">${okText||"สร้าง"}</button>`,
       onClose:()=>resolve(null)});
    const ok=()=>{ resolve(fields.map((f,i)=>{ const v=m.querySelector(`[data-i="${i}"]`).value; return f.type==="number"?+v:v; })); m.close(); };
    m.querySelector("#uaOk").onclick=ok;
    m.querySelector("#uaNo").onclick=()=>m.close();
    m.querySelectorAll("input").forEach(inp=>inp.addEventListener("keydown",e=>{ if(e.key==="Enter") ok(); }));
    setTimeout(()=>{ const f=m.querySelector("input"); if(f){ f.focus(); f.select(); } }, 30);
  });
}
function uxDrawGenerated(intent, title){
  const dr=aiDrawIntent(intent);
  if(!dr||!dr.ok){ toast("สร้างไม่ได้: "+((dr&&(dr.error||(dr.errors||[]).join(", ")))||"?"),"err",4000); return null; }
  const ff=dr.sch.components.filter(c=>PROBE_SEQ[c.type]).length;
  toast(`สร้าง ${title} ในแผ่น "${dr.sch.name}" แล้ว`+(ff?` — ${ff} flip-flop`:"")+" · กด “จำลอง” เพื่อดูการทำงาน","ok",4200);
  return dr;
}
const GENERATORS = [
  {id:"tt", icon:"▦", name:"ตารางความจริง / K-map", desc:"กรอกตาราง → ลดรูป → ได้วงจรเกต", run:()=>openTruthTableTool()},
  {id:"cnt", icon:"↻", name:"ตัวนับ N บิต", desc:"ripple counter นับขึ้น 0 … 2ᴺ−1", run:async()=>{
    const v=await uxAsk("ตัวนับ N บิต (ripple)",[{label:"จำนวนบิต",type:"number",value:4,min:1,max:16}]); if(!v) return;
    const b=seqBuildIntent("counter "+Math.max(1,Math.min(16,v[0]|0))+" bit"); if(b) uxDrawGenerated(b.intent, b.title); }},
  {id:"mod", icon:"⟳", name:"ตัวนับ mod-N", desc:"synchronous นับ 0 … N−1 แล้ววน", run:async()=>{
    const v=await uxAsk("ตัวนับ mod-N",[{label:"N (2–64)",type:"number",value:10,min:2,max:64,hint:"เช่น 10 = นับ 0–9, 6 = นับ 0–5"}]); if(!v) return;
    const N=Math.max(2,Math.min(64,v[0]|0)); const r=fsmCounterIntent(Array.from({length:N},(_,i)=>i));
    if(!r||r.error){ toast("สร้างไม่ได้: "+((r&&r.error)||"N ใหญ่เกิน"),"err"); return; }
    r.module="mod"+N; uxDrawGenerated(r, "ตัวนับ mod-"+N); }},
  {id:"seq", icon:"⤳", name:"ลำดับนับเอง", desc:"เช่น 0 2 5 7 3 — วนตามลำดับ", run:async()=>{
    const v=await uxAsk("ตัวนับตามลำดับที่กำหนด",[{label:"ลำดับ",value:"0 2 5 7 3",hint:"ตัวเลข 0–63 คั่นด้วยช่องว่าง ไม่ซ้ำกัน · สถานะที่ไม่อยู่ในลำดับเป็น don't care"}]); if(!v) return;
    const seq=(String(v[0]).match(/\d+/g)||[]).map(Number);
    if(seq.length<2){ toast("ใส่อย่างน้อย 2 ค่า","warn"); return; }
    const r=fsmCounterIntent(seq);
    if(!r||r.error){ toast("สร้างไม่ได้: "+((r&&r.error)||"ค่าสูงสุด 63"),"err"); return; }
    uxDrawGenerated(r, "ตัวนับลำดับ "+seq.join("→")); }},
  {id:"shift", icon:"⇉", name:"Shift register", desc:"เลื่อนบิตเข้า sin ทีละ clock", run:async()=>{
    const v=await uxAsk("Shift register",[{label:"จำนวนบิต",type:"number",value:4,min:2,max:16}]); if(!v) return;
    const b=seqBuildIntent("shift register "+(v[0]|0)); if(b) uxDrawGenerated(b.intent, b.title); }},
  {id:"reg", icon:"▤", name:"Register N บิต", desc:"เก็บ d0…dN ทุกขอบ clock", run:async()=>{
    const v=await uxAsk("Register",[{label:"จำนวนบิต",type:"number",value:4,min:2,max:16}]); if(!v) return;
    const b=seqBuildIntent("register "+(v[0]|0)+" bit"); if(b) uxDrawGenerated(b.intent, b.title); }},
];
function runGenerator(id){ const g=GENERATORS.find(x=>x.id===id); if(g) g.run(); }
/* generators live in the Tools menu (and Ctrl+K), after the editor's own tools */
(function(){
  const dd=document.querySelector('#menu .mi > button[data-menu="tools"]'); const box=dd&&dd.parentElement.querySelector(".dd");
  if(!box || box.querySelector(".gen-mi")) return;
  const h='<hr><div class="dd-head">ตัวสร้างวงจร <span>— ไม่ต้องใช้ AI</span></div>'+GENERATORS.map(x=>
    `<button class="gen-mi" data-gen="${x.id}" title="${escA(x.desc)}"><span class="gi">${x.icon}</span>${x.name}…</button>`).join("");
  box.insertAdjacentHTML("beforeend", h);
  box.querySelectorAll("[data-gen]").forEach(b=>b.addEventListener("click",()=>runGenerator(b.dataset.gen)));
})();

/* the open sheet's ports, top to bottom, as the truth-table tool wants them */
function uxSheetPortsForTT(){
  const sch=activeSch(); if(!sch) return null;
  const by=t=>(sch.components||[]).filter(c=>c.type===t&&((c.params&&c.params.width)||1)===1).sort((a,b)=>a.y-b.y).map(c=>c.params.name);
  const i=by("IN"), o=by("OUT"); return (i.length&&o.length)?{inputs:i, outputs:o}:null;
}
/* a sheet that is only ports (a lab template) with the same names → draw the logic INTO it */
function uxCanFillSheet(T){
  const sch=activeSch(); if(!sch) return false;
  if((sch.components||[]).some(c=>!["IN","OUT","GND","VCC","CONST","JUNCTION"].includes(c.type))) return false;
  const low=a=>a.map(x=>String(x).toLowerCase()).sort().join(",");
  const h=uxSheetPortsForTT(); return !!h && low(h.inputs)===low(T.inputs) && low(h.outputs)===low(T.outputs);
}
function uxFillSheet(sch, intent){
  uxTimelineAdd("ก่อนวาดลงแผ่นจากตารางความจริง", true);
  const keep={}; (sch.components||[]).forEach(c=>{ if(c.type==="IN"||c.type==="OUT") keep[String(c.params.name).toLowerCase()]=c.params.name; });
  const order={in:(uxSheetPortsForTT()||{}).inputs||[], out:(uxSheetPortsForTT()||{}).outputs||[]};
  const built=buildSchematicFromIntent(intent);
  built.comps.forEach(c=>{ if((c.type==="IN"||c.type==="OUT") && keep[String(c.params.name).toLowerCase()]) c.params.name=keep[String(c.params.name).toLowerCase()]; });
  sch.components=built.comps; sch.wires=built.wires; sch.portOrder=order;   // pinmap stays: keyed by port name
  try{ normalizePortFanout(sch); autoRouteSheet(sch); }catch(e){ console.warn(e); }
  snapshot(); renderAll(); try{ zoomFit(); }catch(_){}
}
