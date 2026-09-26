/* =========================================================================
   4. SAY WHERE IT'S WRONG, NOT JUST THAT IT'S WRONG
   ========================================================================= */

/* ---------- shared hover tooltip ---------- */
const UXTIP = { el:null, t:null, key:null };
function uxTipShow(html, x, y, key){
  if(!UXTIP.el){ UXTIP.el=document.createElement("div"); UXTIP.el.className="ux-tip"; document.body.appendChild(UXTIP.el); }
  if(UXTIP.key!==key){ UXTIP.el.innerHTML=html; UXTIP.key=key; }
  const e=UXTIP.el; e.style.display="block";
  const w=e.offsetWidth, h=e.offsetHeight;
  e.style.left=Math.min(innerWidth-w-8, x+16)+"px";
  e.style.top=(y+18+h>innerHeight ? y-h-12 : y+18)+"px";
}
function uxTipHide(){ clearTimeout(UXTIP.t); UXTIP.key=null; if(UXTIP.el) UXTIP.el.style.display="none"; }

/* ---------- 4a. problems drawn on the sheet ---------- */
const MARK = { on: uxLS("schstudio.marks")!=="0", pins:[], multi:[], comps:new Map() };
/* plain-Thai "what it means + what to do" for each kind of issue */
function issueFix(msg){
  const m=String(msg);
  if(/ยังไม่ได้ต่อสาย/.test(m) && /OUTPUT/.test(m)) return "ลากสายจากขาเอาต์พุตของเกตมาที่ OUTPUT นี้ — ถ้าไม่ต่อ Vivado จะให้ค่า 0 ตลอด";
  if(/ยังไม่ได้ต่อสาย/.test(m)) return "ขาอินพุตที่ลอยไว้ไม่มีค่าที่แน่นอน ต่อสายเข้ามา หรือถ้าตั้งใจให้เป็นค่าคงที่ ให้ต่อกับ GND (0) หรือ VCC (1)";
  if(/ไม่ได้ต่อไปไหน/.test(m)) return "INPUT นี้ไม่ได้ใช้ ลากสายจากขาของมันไปเข้าเกต หรือถ้าไม่ต้องการก็ลบทิ้ง";
  if(/multi-driver|สายเข้าซ้อน/.test(m)) return "มีเอาต์พุตสองตัวต่อเข้าขาเดียวกัน = สัญญาณชนกัน ลบสายเส้นใดเส้นหนึ่ง หรือใช้เกต (OR/AND) รวมสองสัญญาณก่อน";
  if(/ปลายลอย|ปลายสายลอย/.test(m)) return "สายเส้นนี้ไม่มีต้นทาง ลากปลายสายที่ลอยไปต่อกับขาเอาต์พุตของอะไรสักอย่าง";
  if(/ชื่อซ้ำ|ซ้ำกัน/.test(m)) return "เปลี่ยนชื่อพอร์ตให้ไม่ซ้ำกัน (เลือกแล้วแก้ใน Inspector)";
  if(/ความกว้างบัส/.test(m)) return "บัสสองฝั่งกว้างไม่เท่ากัน ใช้ Bus Tap ดึงเฉพาะบิตที่ต้องการ หรือแก้ความกว้างให้ตรงกัน";
  if(/combinational loop|ป้อนกลับ/.test(m)) return "สัญญาณวนกลับมาเข้าตัวเองโดยไม่ผ่าน flip-flop — วงจรจะแกว่ง/ค้าง ตัดวงนี้ หรือใส่ D-FF คั่น";
  if(/clk.*ค่าคงที่/.test(m)) return "นาฬิกาต้องเปลี่ยนค่าได้ ต่อขา clk กับ INPUT clk หรือ Q ของ flip-flop ตัวก่อนหน้า";
  if(/clk.*ยังไม่ได้ต่อ/.test(m)) return "flip-flop ต้องมีนาฬิกา ต่อขา clk กับ INPUT ชื่อ clk (หรือเอาต์พุตของวงจรหารความถี่)";
  if(/gated clock/.test(m)) return "นาฬิกาที่ผ่านเกตอาจมี glitch ทำให้นับเกิน ถ้าเป็นไปได้ให้ใช้ clk ตรง แล้วคุมด้วยขา enable/D แทน";
  if(/Bus Tap/.test(m)) return "ตรวจเลขบิตของ Bus Tap ให้อยู่ในช่วงของบัส";
  return "";
}
function uxCollectMarks(){
  const sch=activeSch(); MARK.pins=[]; MARK.multi=[]; MARK.comps=new Map();
  if(!sch) return;
  // floating input pins (the most common one) — exact pin position, not just the part
  (sch.components||[]).forEach(c=>{
    if(c.type==="JUNCTION"||c.type==="BUSTAP"||c.type==="OUT"||c.type==="GND") return;
    getPorts(c).filter(p=>p.dir==="in").forEach(p=>{
      if(!sch.wires.some(w=>w.to.cid===c.id&&w.to.pid===p.id))
        MARK.pins.push({cid:c.id, pid:p.id, lvl:"warn", msg:`${compDisplay(c)} ขา '${p.id}' ยังไม่ได้ต่อสาย`});
    });
  });
  // multi-driver: every wire into a pin that has more than one
  const into=new Map(); sch.wires.forEach(w=>{ const k=w.to.cid+"|"+w.to.pid; (into.get(k)||into.set(k,[]).get(k)).push(w.id); });
  into.forEach((ids,k)=>{ if(ids.length>1){ const [cid,pid]=k.split("|"); const c=comp(cid,sch);
    MARK.multi.push({wids:ids, cid, msg:`${c?compDisplay(c):cid} ขา '${pid}' มีสายเข้าซ้อนกัน ${ids.length} เส้น (multi-driver)`}); } });
  // everything else the checker found, pinned to its component
  (UX.step?[...UX.step.errs,...UX.step.warns]:[]).forEach(i=>{
    if(!i.cid || i.schId!==sch.id) return;
    if(/ขา '.*' ยังไม่ได้ต่อสาย|multi-driver|สายเข้าซ้อน/.test(i.msg)) return;   // drawn precisely above
    const a=MARK.comps.get(i.cid)||[]; a.push(i); MARK.comps.set(i.cid,a);
  });
}
function uxDrawMarks(){
  if(!MARK.on) return;
  const sch=activeSch(), world=canvas.firstChild; if(!sch||!world) return;
  const layer=el("g",{class:"ux-marks"});
  MARK.multi.forEach((m,k)=>m.wids.forEach(wid=>{
    const g=canvas.querySelector(`.wire-group[data-wid="${wid}"] path.wire`); if(!g) return;
    const p=el("path",{d:g.getAttribute("d"), class:"ux-mw", "data-mk":"m"+k});
    layer.appendChild(p);
  }));
  MARK.pins.forEach((m,k)=>{ const c=comp(m.cid,sch); if(!c) return; const pp=portPos(c,m.pid); if(!pp) return;
    layer.appendChild(el("circle",{cx:pp.x, cy:pp.y, r:4.2, class:"ux-mp", "data-mk":"p"+k})); });
  MARK.comps.forEach((list,cid)=>{ const c=comp(cid,sch); if(!c) return; const sz=getSize(c);
    const err=list.some(i=>i.lvl==="err");
    const g=el("g",{class:"ux-mc "+(err?"err":"warn"), "data-mk":"c"+cid, transform:`translate(${c.x+sz.w-2},${c.y-4})`});
    g.appendChild(el("circle",{r:7}));
    const t=el("text",{"text-anchor":"middle", y:3.6}); t.textContent=list.length>1?String(list.length):"!"; g.appendChild(t);
    layer.appendChild(g); });
  world.appendChild(layer);
}
function uxMarkHtml(key){
  let items=[];
  if(key[0]==="p"){ const m=MARK.pins[+key.slice(1)]; if(m) items=[m]; }
  else if(key[0]==="m"){ const m=MARK.multi[+key.slice(1)]; if(m) items=[{lvl:"err",msg:m.msg}]; }
  else if(key[0]==="c"){ items=MARK.comps.get(key.slice(1))||[]; }
  return items.map(i=>{ const fix=issueFix(i.msg);
    return `<div class="ux-tip-i ${i.lvl==="err"?"err":"warn"}"><b>${i.lvl==="err"?"✕ ต้องแก้":"⚠ ควรดู"}</b> ${esc(i.msg)}${fix?`<div class="ux-tip-fix">วิธีแก้: ${esc(fix)}</div>`:""}</div>`; }).join("");
}
{
  const _render=render;
  render=function(){ const r=_render.apply(this, arguments); try{ uxDrawMarks(); }catch(e){ console.warn("marks",e); } return r; };
  const _step=uxRenderStepper;
  uxRenderStepper=function(){ const r=_step.apply(this, arguments); uxCollectMarks(); render(); return r; };
}
document.addEventListener("click", ev=>{
  const a=ev.target.closest && ev.target.closest("[data-act]"); if(!a) return;
  if(a.dataset.act==="toggle-marks"){ MARK.on=!MARK.on; uxLS("schstudio.marks", MARK.on?"1":"0"); render();
    toast(MARK.on?"แสดงปัญหาบนผัง: เปิด":"แสดงปัญหาบนผัง: ปิด","ok",1600); }
});

/* ---------- 4c. hover: a gate's truth table · probe: a wire's value and where it comes from ---------- */
function gateTableHtml(c){
  const ins=getPorts(c).filter(p=>p.dir==="in"), n=ins.length, T=c.type;
  if(PROBE_GATES[T] && n>=1 && n<=4){
    const head=ins.map((_,i)=>String.fromCharCode(97+i));
    let h=`<table class="ux-gt"><tr>${head.map(x=>`<th>${x}</th>`).join("")}<th class="o">y</th></tr>`;
    for(let r=0;r<(1<<n);r++){ const bits=head.map((_,i)=>(r>>(n-1-i))&1); const y=probeGateOp(T,bits);
      h+=`<tr>${bits.map(b=>`<td>${b}</td>`).join("")}<td class="o v${y}">${y}</td></tr>`; }
    const say={AND:"เป็น 1 เมื่อทุกอินพุตเป็น 1",OR:"เป็น 1 เมื่อมีอินพุตใดเป็น 1",NOT:"กลับค่า",BUF:"ส่งค่าผ่าน",
      NAND:"AND แล้วกลับค่า",NOR:"OR แล้วกลับค่า",XOR:"เป็น 1 เมื่อจำนวน 1 เป็นคี่",XNOR:"เป็น 1 เมื่อจำนวน 1 เป็นคู่"}[T]||"";
    return `<div class="ux-tip-h">${T} ${n} อินพุต</div><div class="muted" style="margin-bottom:4px">${say}</div>${h}</table>`;
  }
  const FT={DFF:[["↑ clk","Q ← D"],["ไม่มีขอบ","Q คงเดิม"]],
    TFF:[["↑ clk, T=0","คงเดิม"],["↑ clk, T=1","กลับค่า"]],
    JKFF:[["J=0 K=0","คงเดิม"],["J=0 K=1","Q=0"],["J=1 K=0","Q=1"],["J=1 K=1","กลับค่า"]],
    SRFF:[["S=0 R=0","คงเดิม"],["S=0 R=1","Q=0"],["S=1 R=0","Q=1"],["S=1 R=1","ห้ามใช้"]]}[T];
  if(FT){ const edge=(c.params&&c.params.edge==="falling")?"ขอบขาลง ↓":"ขอบขาขึ้น ↑";
    return `<div class="ux-tip-h">${T} · ทำงานที่${edge}</div><table class="ux-gt">${FT.map(([a,b])=>`<tr><td style="text-align:left">${a}</td><td class="o" style="text-align:left">${b}</td></tr>`).join("")}</table>`
      +((c.params&&(c.params.reset||c.params.preset))?`<div class="muted" style="margin-top:4px">rst/pre ทำงานทันที ไม่รอ clock</div>`:""); }
  if(T==="MUX"){ const n2=(c.params&&c.params.inputs)||2; return `<div class="ux-tip-h">MUX ${n2}:1</div><div class="muted">y = d[s] — ขา s เลือกว่าจะส่งอินพุตตัวไหนออก</div>`; }
  return "";
}
function probeWireHtml(wid){
  const sch=activeSch(); let flat, m;
  try{ flat=flattenSchematic(sch).sch; m=probeModel(flat, probeStruct(flat)); }catch(_){ return ""; }
  const w=flat.wires.find(x=>x.id===wid); if(!w) return "";
  const d=m.netDriver(w); if(!d) return `<div class="ux-tip-h">สายนี้ไม่มีตัวขับ</div><div class="muted">ค่าไม่แน่นอน — ต่อปลายสายเข้ากับขาเอาต์พุต</div>`;
  const v=m.outVal(d.cid,d.pid,new Set());
  const src=flat.components.find(c=>c.id===d.cid);
  const top=comp(d.cid.split("__")[0], sch);
  const who=src ? (src.type==="IN"||src.type==="OUT" ? `${src.type==="IN"?"INPUT":"OUTPUT"} '${(src.params&&src.params.name)||src.id}'`
    : (d.cid.includes("__")&&top ? `${compDisplay(top)} (ข้างใน)` : compDisplay(src))) : d.cid;
  let why="";
  if(src && (PROBE_GATES[src.type]||src.type==="MUX")){
    const ins=m.inPortsOf(src).map(p=>`${p.id}=${(x=>x==null?"?":x)(m.inVal(src.id,p.id))}`);
    why=`<div class="muted">เพราะ ${src.type} ได้ ${ins.join(", ")}</div>`;
  } else if(src && PROBE_SEQ[src.type]) why=`<div class="muted">ค่าที่ flip-flop เก็บไว้ (เปลี่ยนเมื่อมีขอบ clock)</div>`;
  return `<div class="ux-tip-h">ค่า = <span class="ux-v v${v}">${v==null?"?":v}</span></div><div>มาจาก ${esc(who)} ขา ${esc(d.pid)}</div>${why}`;
}
canvas.addEventListener("mousemove", ev=>{
  if(state.drag||state.pan||state.wireDrag||state.pendingWire){ uxTipHide(); return; }
  const mk=ev.target.closest && ev.target.closest("[data-mk]");
  if(mk){ clearTimeout(UXTIP.t); const k=mk.dataset.mk; uxTipShow(uxMarkHtml(k), ev.clientX, ev.clientY, "mk"+k); return; }
  // the pin dots let clicks through (so the pin can still be wired) — find them by distance
  if(MARK.on && MARK.pins.length){ const w=svgPoint(ev), sch=activeSch(); let best=-1, bd=8/Math.max(.4,state.view.k);
    MARK.pins.forEach((m,k)=>{ const c=comp(m.cid,sch); const pp=c&&portPos(c,m.pid); if(!pp) return; const d=Math.hypot(pp.x-w.x,pp.y-w.y); if(d<bd){ bd=d; best=k; } });
    if(best>=0){ clearTimeout(UXTIP.t); uxTipShow(uxMarkHtml("p"+best), ev.clientX, ev.clientY, "mkp"+best); return; } }
  const wg=ev.target.closest && ev.target.closest(".wire-group[data-wid]");
  const nd=!wg && ev.target.closest && ev.target.closest(".node[data-cid]");
  const key=wg?"w"+wg.dataset.wid : nd?"n"+nd.dataset.cid : null;
  if(!key){ uxTipHide(); return; }
  if(UXTIP.key===key){ uxTipShow(null, ev.clientX, ev.clientY, key); return; }
  clearTimeout(UXTIP.t); if(UXTIP.el) UXTIP.el.style.display="none"; UXTIP.key=null;
  const x=ev.clientX, y=ev.clientY;
  UXTIP.t=setTimeout(()=>{
    let html="";
    if(wg) html=PROBE ? probeWireHtml(wg.dataset.wid) : (typeof wtNetHtml==="function" ? wtNetHtml(wg.dataset.wid) : "");
    else { const c=comp(nd.dataset.cid); if(c) html=gateTableHtml(c); }
    if(html) uxTipShow(html, x, y, key);
  }, wg?(PROBE?120:350):450);
});
canvas.addEventListener("mouseleave", uxTipHide);
canvas.addEventListener("mousedown", uxTipHide);

/* ---------- 4b. "why doesn't the sim do what I expect?" ---------- */
function explainSim(sch){
  sch=sch||activeSch(); const F=[];   // {lvl, title, why, fix, cid}
  if(!sch||!(sch.components||[]).some(c=>c.type!=="JUNCTION")) return [{lvl:"info",title:"แผ่นนี้ยังว่าง",why:"ยังไม่มีวงจรให้จำลอง",fix:"วางเกตจากแท็บ Components หรือเริ่มจากเทมเพลตแลป"}];
  let flat; try{ flat=flattenSchematic(sch); }catch(e){ return [{lvl:"err",title:"อ่านวงจรไม่ได้",why:e.message,fix:""}]; }
  const fs=flat.sch, nm=c=>(c.params&&c.params.name)||c.label||c.id, top=id=>comp(String(id).split("__")[0],sch)||null;
  flat.warns.forEach(w=>F.push({lvl:"warn",title:"บางบล็อกจำลองไม่ได้",why:w,fix:"บล็อกที่ข้ามไปจะให้เอาต์พุตเป็น 0 — ตรวจว่าวงจรย่อยมี INPUT/OUTPUT ครบ"}));
  const ffs=fs.components.filter(c=>PROBE_SEQ[c.type]);
  const m=probeModel(fs, probeStruct(fs));
  const outs=sch.components.filter(c=>c.type==="OUT"), ins=sch.components.filter(c=>c.type==="IN");
  if(!outs.length) F.push({lvl:"err",title:"ไม่มี OUTPUT",why:"ตัวจำลองดูผลที่ OUTPUT เท่านั้น",fix:"วาง OUTPUT แล้วต่อสายจากสัญญาณที่อยากดู"});
  // wiring faults on this sheet come first: they make every later result meaningless
  const into=new Map(); sch.wires.forEach(w=>{ const k=w.to.cid+"|"+w.to.pid; into.set(k,(into.get(k)||0)+1); });
  into.forEach((n,k)=>{ if(n<2) return; const [cid,pid]=k.split("|"), c=comp(cid,sch); if(!c||c.type==="JUNCTION") return;
    F.push({lvl:"err",title:`${compDisplay(c)} ขา '${pid}' มีสัญญาณเข้า ${n} ทาง (multi-driver)`,why:"สองเอาต์พุตชนกันบนสายเดียว ค่าที่ได้ไม่แน่นอน ตัวจำลองจึงให้ผลที่ไม่ตรงกับที่คิด",fix:issueFix("multi-driver"),cid}); });
  const floating=[];
  (sch.components||[]).forEach(c=>{ if(!(PROBE_GATES[c.type]||c.type==="MUX"||PROBE_SEQ[c.type])) return;
    getPorts(c).filter(p=>p.dir==="in"&&p.id!=="clk").forEach(p=>{ if(!sch.wires.some(w=>w.to.cid===c.id&&w.to.pid===p.id)) floating.push({c,p}); }); });
  floating.slice(0,3).forEach(({c,p})=>F.push({lvl:"warn",title:`${compDisplay(c)} ขา '${p.id}' ลอย`,why:"ขาที่ไม่ได้ต่อไม่มีค่า เอาต์พุตของเกตนี้จึงไม่แน่นอน (ตัวจำลองถือเป็น 0)",fix:issueFix("ยังไม่ได้ต่อสาย"),cid:c.id}));
  if(floating.length>3) F.push({lvl:"warn",title:`ยังมีขาลอยอีก ${floating.length-3} ขา`,why:"ดูจุดสีแดงบนผัง",fix:""});
  outs.forEach(o=>{ const w=sch.wires.find(x=>x.to.cid===o.id); if(!w) F.push({lvl:"err",title:`OUTPUT '${nm(o)}' ไม่ได้ต่อสาย`,why:"จึงเป็น 0 ตลอดทุกแถว",fix:"ลากสายจากเกตมาเข้า OUTPUT นี้",cid:o.id}); });
  // clocks
  const clocks=new Set();
  ffs.forEach(c=>{
    const s=m.source(c.id,"clk"), T=top(c.id), where=T?compDisplay(T)+(c.id.includes("__")?" (ข้างใน)":""):c.id;
    if(!s) F.push({lvl:"err",title:`${where}: ขา clk ไม่มีสัญญาณ`,why:"flip-flop ที่ไม่มีขอบนาฬิกาจะไม่เปลี่ยนสถานะเลย",fix:"ต่อขา clk กับ INPUT ชื่อ clk (หรือ Q ของ flip-flop ตัวก่อน ถ้าเป็นตัวนับแบบ ripple)",cid:T&&T.id});
    else if(["VCC","GND","CONST"].includes(s.type)) F.push({lvl:"err",title:`${where}: clk ต่อกับค่าคงที่ (${s.type})`,why:"ค่าคงที่ไม่มีขอบขึ้น/ลง flip-flop จึงไม่ทำงาน",fix:"ต่อ clk กับ INPUT clk",cid:T&&T.id});
    else if(PROBE_GATES[s.type]&&s.type!=="BUF") F.push({lvl:"warn",title:`${where}: clk ผ่านเกต ${s.type} (gated clock)`,why:"เมื่ออินพุตอื่นของเกตเป็นค่าที่บล็อก นาฬิกาจะหยุด และบนบอร์ดจริงอาจมี glitch ทำให้นับเกิน",fix:"ต่อ clk ตรงเข้าขา clk แล้วใช้สัญญาณควบคุมกับขา D/T/J/K หรือ enable แทน",cid:T&&T.id});
    else if(s.type==="IN") clocks.add(s.cid);
  });
  // resets that never let go (inputs are 0 in the sim; a VCC / inverted input keeps it active)
  const zero=Object.assign({},PROBE_VALS); Object.keys(PROBE_VALS).forEach(k=>delete PROBE_VALS[k]);
  try{
    const m0=probeModel(fs, probeStruct(fs));
    ffs.forEach(c=>{ const p=c.params||{}, T=top(c.id), where=T?compDisplay(T):c.id;
      if(p.reset && m0.inVal(c.id,"rst")===1) F.push({lvl:"err",title:`${where}: reset ค้างอยู่ที่ 1`,why:"ขณะจำลอง INPUT ทุกตัวเริ่มที่ 0 แต่ขา rst ยังเป็น 1 (ต่อ VCC หรือผ่าน NOT) flip-flop จึงถูกล้างเป็น 0 ตลอด",fix:"ให้ rst เป็น 1 เฉพาะตอนต้องการล้าง — ต่อกับ INPUT/ปุ่ม หรือวงจรตรวจค่าที่ต้องการรีเซ็ต",cid:T&&T.id});
      if(p.preset && m0.inVal(c.id,"pre")===1) F.push({lvl:"err",title:`${where}: preset ค้างอยู่ที่ 1`,why:"flip-flop ถูกตั้งเป็น 1 ตลอด ไม่สนนาฬิกา",fix:"ให้ pre เป็น 0 ตามปกติ",cid:T&&T.id});
      if(c.type==="DFF"){ const s=m0.source(c.id,"d"); if(s&&["VCC","GND"].includes(s.type)) F.push({lvl:"warn",title:`${where}: D ต่อค่าคงที่ ${s.type}`,why:"Q จะเป็นค่านั้นตลอดหลัง clock แรก",fix:"ถ้าต้องการให้สลับค่า ต่อ D กับ Q' (qn)",cid:T&&T.id}); }
      if(c.type==="JKFF"){ const j=m0.inVal(c.id,"j"), k=m0.inVal(c.id,"k"); if(j===0&&k===0) F.push({lvl:"warn",title:`${where}: J=K=0 ตลอด`,why:"JK-FF ที่ J=K=0 จะคงค่าเดิม ไม่นับ",fix:"ตัวนับแบบ toggle ให้ต่อ J และ K กับ VCC",cid:T&&T.id}); }
      if(c.type==="TFF"){ if(m0.inVal(c.id,"t")===0) F.push({lvl:"warn",title:`${where}: T=0 ตลอด`,why:"T-FF จะไม่กลับค่า",fix:"ต่อ T กับ VCC เพื่อให้กลับค่าทุก clock",cid:T&&T.id}); }
    });
  } finally { Object.keys(PROBE_VALS).forEach(k=>delete PROBE_VALS[k]); Object.assign(PROBE_VALS, zero); }
  // run it and look at the result
  if(ffs.length){
    if(!clocks.size && !F.some(f=>/clk/.test(f.title))) F.push({lvl:"warn",title:"หา INPUT ที่เป็นนาฬิกาไม่เจอ",why:"ตัวจำลองจะกด clock ให้เฉพาะ INPUT ที่ต่อเข้าขา clk ของ flip-flop",fix:"ตั้งชื่อ INPUT ว่า clk แล้วต่อเข้าขา clk"});
    try{
      const j=clientSeqSim(sch, 16);
      if(j.ok && j.sequence.rows.length>1){
        const st=j.sequence.rows.map(r=>r[2].join(""));
        if(st.every(x=>x===st[0])) F.push({lvl:"err",title:"flip-flop ไม่เปลี่ยนสถานะเลยใน 16 clock",why:"มักเกิดจาก clk ไม่ถึง, reset ค้าง หรือ D/J/K/T ต่อค่าที่ทำให้คงเดิม (ดูรายการด้านบน)",fix:"เปิดโหมดตรวจค่า 🔬 แล้วคลิก clk ดูว่าค่าเดินถึงขาไหน"});
        else { const outsCh=j.sequence.outputs.filter((o,k)=>new Set(j.sequence.rows.map(r=>r[3][k])).size>1);
          if(j.sequence.outputs.length && !outsCh.length) F.push({lvl:"warn",title:"flip-flop เปลี่ยนค่า แต่ OUTPUT ไม่เปลี่ยน",why:"สถานะภายในเดินอยู่ แต่ OUTPUT ไม่ได้ต่อกับ Q ที่เปลี่ยน",fix:"ต่อ OUTPUT กับขา Q ของ flip-flop"}); }
      }
    }catch(_){}
    let div=null; try{ div=analyzeDividerChain(sch); }catch(_){}
    if(div){ let total=1; try{ total=divChainFreqs(div).total||1; }catch(_){}
      F.push({lvl:"info",title:"วงจรนี้มีตัวหารความถี่ต่อกันเป็นทอด",why:`นาฬิกาถูกหารหลายชั้น${total>1?` (รวมราว ÷${total.toLocaleString()})`:""} การจำลองทีละ clock จึงต้องเดินเป็นล้านรอบกว่าจอจะเปลี่ยน ดูเหมือนค้าง`,
        fix:"ใช้แผงคำนวณความถี่ในหน้า จำลอง (แสดงความถี่แต่ละชั้น) หรือทดสอบบล็อกนับแต่ละตัวแยกกัน"}); }
  } else if(outs.length && ins.length){
    const j=clientCombSim(sch);
    if(j.ok){ const tt=j.truth_table;
      tt.outputs.forEach((o,k)=>{ const vals=new Set(tt.rows.map(r=>r[1][k]));
        if(vals.size===1) F.push({lvl:"warn",title:`OUTPUT '${o}' เป็น ${[...vals][0]} ทุกแถว`,why:"ไม่ว่าอินพุตเป็นอะไร ผลเท่าเดิม — มักเกิดจากสายไม่ครบหรือต่อผิดขา",fix:"เปิดโหมดตรวจค่า 🔬 แล้วลองสลับ INPUT ดูว่าค่าไปหยุดที่ไหน",cid:(outs.find(c=>nm(c)===o)||{}).id}); });
      const unused=tt.inputs.filter((n,i)=>tt.rows.every(([b,o])=>{ const r2=tt.rows.find(([b2])=>b2.every((x,t)=>t===i?x!==b[i]:x===b[t])); return !r2 || r2[1].join("")===o.join(""); }));
      unused.forEach(n=>F.push({lvl:"info",title:`INPUT '${n}' ไม่มีผลต่อ OUTPUT เลย`,why:"สลับค่า INPUT นี้แล้วผลไม่เปลี่ยนในทุกแถว",fix:"ถ้าไม่ได้ตั้งใจ ตรวจสายจาก INPUT นี้",cid:(ins.find(c=>nm(c)===n)||{}).id}));
      if(j.note) F.push({lvl:"warn",title:"มีเอาต์พุตที่ไม่มีอะไรขับ",why:j.note,fix:""});
    } else if(j.reason) F.push({lvl:"info",title:"จำลองในเบราว์เซอร์ไม่ได้",why:j.reason,fix:""});
  }
  try{ combinationalLoops(sch).forEach(cyc=>F.push({lvl:"err",title:"สัญญาณวนกลับโดยไม่ผ่าน flip-flop",why:"ผลของวงจรจะไม่นิ่ง ตัวจำลองอาจให้ค่าที่ไม่ตรงกับบอร์ด",fix:issueFix("combinational loop"),cid:cyc[0]})); }catch(_){}
  if(!F.length) F.push({lvl:"ok",title:"ไม่พบสาเหตุที่ชัดเจน",why:"วงจรต่อครบและจำลองได้ตามโครงสร้างที่วาด — ถ้าผลยังไม่ตรงที่คิด ให้เทียบตารางความจริงกับที่ออกแบบทีละแถว",fix:"ลองใช้ ตารางความจริง / K-map สร้างวงจรจากผลที่ต้องการ แล้วเทียบกัน"});
  const rank={err:0,warn:1,info:2,ok:3}; return F.sort((a,b)=>rank[a.lvl]-rank[b.lvl]);
}
function openExplainSim(){
  const sch=activeSch(), list=explainSim(sch);
  const ico={err:"✕",warn:"⚠",info:"ℹ",ok:"✓"};
  const m=uxModal("🩺 ทำไมผลจำลองไม่เป็นอย่างที่คิด?", `<p class="muted" style="margin:0 0 10px">ตรวจแผ่น “${esc(sch?sch.name:"")}” — เรียงจากเรื่องที่น่าจะเป็นสาเหตุมากที่สุด</p>`
    +list.map((f,i)=>`<div class="ex-i ${f.lvl}"><span class="ex-ico">${ico[f.lvl]}</span><div class="ex-b"><b>${esc(f.title)}</b>
      ${f.why?`<div>${esc(f.why)}</div>`:""}${f.fix?`<div class="ex-fix">ลองแก้: ${esc(f.fix)}</div>`:""}</div>
      ${f.cid&&sch?`<button class="btn" data-exgo="${i}">ไปที่จุดนี้</button>`:""}</div>`).join(""), {width:640});
  m.querySelectorAll("[data-exgo]").forEach(b=>b.onclick=()=>{ const f=list[+b.dataset.exgo]; m.close(); hideSimPage(); setStage("draw",true); focusComp(sch.id, f.cid); });
}
/* entry points: sim page button, chat /why, and the chat noticing the question */
{
  const top=$("#simPage .sim-top");
  if(top && !top.querySelector("[data-act=explain-sim]")){
    const b=document.createElement("button"); b.className="btn2"; b.dataset.act="explain-sim"; b.textContent="🩺 ทำไมผลไม่ตรง?";
    b.title="ตรวจหาสาเหตุที่ผลจำลองไม่เป็นอย่างที่คิด (clock, reset, สายขาด, ตัวหารความถี่…)";
    top.insertBefore(b, top.querySelector(".grow"));
  }
  const _send=aiSend;
  aiSend=async function(){
    const t=$("#acInput"), msg=((t&&t.value)||"").trim();
    const why=/^\/(why|ทำไม)\b/i.test(msg) || (/(sim|จำลอง|clk|clock|นาฬิกา|นับ|counter)/i.test(msg) && /(ไม่ได้|ไม่ทำงาน|ไม่นับ|ไม่เปลี่ยน|ไม่ขึ้น|ไม่ติด|ทำไม|ผิด|ค้าง)/.test(msg));
    if(!why) return _send.apply(this, arguments);
    aiAppend("user", msg); t.value="";
    const list=explainSim(activeSch()).slice(0,6);
    const ico={err:"✕",warn:"⚠",info:"ℹ",ok:"✓"};
    aiAppend("ai", '<span class="ac-badge v">ตรวจแผ่นนี้</span><br>'+list.map(f=>`<div style="margin-top:6px">${ico[f.lvl]} <b>${esc(f.title)}</b><br><span class="ac-hint">${esc(f.why)}${f.fix?" — "+esc(f.fix):""}</span></div>`).join("")
      +'<div class="ac-hint" style="margin-top:6px">ดูรายละเอียดและกดไปยังจุดนั้นได้ที่หน้า จำลอง ▸ 🩺</div>', {html:true});
  };
}
document.addEventListener("click", ev=>{
  const a=ev.target.closest && ev.target.closest("[data-act]"); if(!a) return;
  if(a.dataset.act==="explain-sim") openExplainSim();
});
