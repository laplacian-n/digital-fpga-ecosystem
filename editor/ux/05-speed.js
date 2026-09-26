/* =========================================================================
   5. FASTER EVERYDAY WORK
   ========================================================================= */
function uxBusy(){   // a dialog / tour / palette owns the keyboard
  return !!document.querySelector(".modal-bg, .tour-ov, .cmdk-bg") || (typeof manualOpen==="function" && manualOpen());
}
function uxTyping(){ const a=document.activeElement; return a && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable); }
function uxViewCenter(){ const r=canvas.getBoundingClientRect(); return {x:(r.width/2-state.view.x)/state.view.k, y:(r.height/2-state.view.y)/state.view.k}; }
let UX_MOUSE_IN=false;
canvas.addEventListener("mouseenter",()=>UX_MOUSE_IN=true);
canvas.addEventListener("mouseleave",()=>UX_MOUSE_IN=false);
/* place a part centred under the mouse (or mid-view when the mouse is elsewhere) */
function uxPlace(type){
  const at=UX_MOUSE_IN?state.mouse:uxViewCenter();
  const td=TYPES[type]; let w=60,h=40; try{ const s=td.size(td.defaultParams||{}); w=s.w; h=s.h; }catch(_){}
  const id=addComp(type, at.x-w/2, at.y-h/2);
  if(id && type!=="IN" && type!=="OUT") setTool("select", true);
  return id;
}

/* ---------- 5b. single-letter placement ---------- */
const PLACE_KEYS = {
  KeyA:["AND","NAND"], KeyO:["OR","NOR"], KeyX:["XOR","XNOR"], KeyN:["NOT","BUF"],
  KeyI:["IN",null], KeyQ:["OUT",null], KeyD:["DFF",null], KeyC:["CONST",null],
};
window.addEventListener("keydown", ev=>{
  if(uxTyping()) return;
  const ctl=ev.ctrlKey||ev.metaKey;
  if(ctl && (ev.code==="KeyK" || (ev.key||"").toLowerCase()==="k")){ ev.preventDefault(); ev.stopImmediatePropagation(); openCmdK(); return; }
  if(ctl||ev.altKey||uxBusy()) return;
  if(ev.code==="Slash" && ev.shiftKey){ ev.preventDefault(); ev.stopImmediatePropagation(); openShortcutHelp(); return; }
  // the ISE-style tools that used N and I move to Shift+N / Shift+I
  if(ev.shiftKey && ev.code==="KeyN"){ ev.preventDefault(); ev.stopImmediatePropagation(); setTool("netname"); return; }
  if(ev.shiftKey && ev.code==="KeyI"){ ev.preventDefault(); ev.stopImmediatePropagation(); setTool("iomarker"); return; }
  const pk=PLACE_KEYS[ev.code]; if(!pk) return;
  if(state.pendingWire) return;                       // keys mean nothing mid-wire
  const type=ev.shiftKey?pk[1]:pk[0]; if(!type||!TYPES[type]) return;
  ev.preventDefault(); ev.stopImmediatePropagation();
  uxPlace(type);
}, true);
function openShortcutHelp(){
  const rows=[["A / Shift+A","AND / NAND"],["O / Shift+O","OR / NOR"],["X / Shift+X","XOR / XNOR"],["N / Shift+N","NOT / เครื่องมือตั้งชื่อสาย"],
    ["I / Shift+I","INPUT / เครื่องมือ I/O marker"],["Q","OUTPUT"],["D","D flip-flop"],["C","ค่าคงที่ (CONST)"],["W","เครื่องมือสาย"],["B","Bus tap"],["R / M","หมุน / กลับด้าน"],
    ["Ctrl+K","ค้นหาคำสั่ง"],["Ctrl+S","บันทึก"],["Ctrl+Z / Ctrl+Y","ย้อน / ทำซ้ำ"],["F7","ตรวจวงจร"],["Home","ย่อให้พอดีจอ"],["?","หน้านี้"]];
  uxModal("⌨ คีย์ลัด", `<p class="muted" style="margin:0 0 8px">ตัวอักษรจะวางชิ้นส่วนตรงตำแหน่งเมาส์</p><table class="kbd-t">${rows.map(([k,v])=>`<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join("")}</table>`,{width:460});
}

/* ---------- 5c. drag out of a free pin → a named INPUT/OUTPUT ---------- */
const PINDRAG = { from:null };
canvas.addEventListener("mousedown", ev=>{
  PINDRAG.from=null;
  const pg=ev.target.closest && ev.target.closest(".port"); if(!pg || ev.button!==0) return;
  if(state.tool!=="select" && state.tool!=="wire") return;
  setTimeout(()=>{   // after the editor's own handler has started the wire
    const pw=state.pendingWire; if(!pw||pw.onWire) return;
    PINDRAG.from={cid:pw.cid, pid:pw.pid, x:ev.clientX, y:ev.clientY};
  },0);
}, true);
function uxNameForPin(sch, c, p, dir){
  const taken=new Set(sch.components.filter(x=>x.type==="IN"||x.type==="OUT").map(x=>(x.params&&x.params.name)||""));
  const generic=/^(i\d*|o\d*|y|a|b|d\d*|q|qn|in\d*|out\d*)$/i.test(p.id) && !String(c.type).startsWith("SCH:") && !String(c.type).startsWith("CUSTOM:");
  let base = generic ? null : sanId(p.label||p.id);
  if(PROBE_SEQ[c.type] && p.id==="clk") base="clk";
  if(!base){
    if(dir==="IN"){ for(let i=0;i<26;i++){ const n=String.fromCharCode(97+i); if(!taken.has(n)) return n; } base="in"; }
    else base="y";
  }
  if(!taken.has(base)) return base;
  // taken (the same pin on another copy): prefix the block's label → mod10_2_q1, not q11
  const pre=sanId(c.label||"");
  let n=pre?`${pre}_${base}`:`${base}_2`, k=2; const root=n;
  while(taken.has(n)) n=`${root}_${k++}`;
  return n;
}
canvas.addEventListener("mouseup", ev=>{
  const f=PINDRAG.from; PINDRAG.from=null;
  if(!f || ev.button!==0) return;
  const pw=state.pendingWire; if(!pw || pw.cid!==f.cid || pw.pid!==f.pid || (pw.pts&&pw.pts.length)) return;
  if(Math.hypot(ev.clientX-f.x, ev.clientY-f.y)<28) return;             // a click, not a drag
  if(ev.target.closest && ev.target.closest(".node,.port,.wire-group")) return;   // landed on something
  const sch=activeSch(), c=comp(f.cid, sch); if(!c) return;
  const p=getPort(c, f.pid); if(!p || (p.width||1)>1) return;
  if(sch.wires.some(w=>(w.to.cid===c.id&&w.to.pid===p.id)||(w.from.cid===c.id&&w.from.pid===p.id))) return;   // only free pins
  const dir=p.dir==="in"?"IN":"OUT";
  const at=svgPoint(ev);
  const nm=uxNameForPin(sch, c, p, dir);
  const io={id:uid("c"), type:dir, x:0, y:0, params:{name:nm, width:1}, label:""};
  const ip=getPorts(io)[0];
  io.x=snap(at.x-ip.dx); io.y=snap(at.y-ip.dy);
  uxNudgeFree(sch, io);
  sch.components.push(io);
  const w = dir==="IN" ? {id:uid("w"), from:{cid:io.id,pid:ip.id}, to:{cid:c.id,pid:p.id}, name:""}
                       : {id:uid("w"), from:{cid:c.id,pid:p.id}, to:{cid:io.id,pid:ip.id}, name:""};
  sch.wires.push(w);
  state.pendingWire=null; state.selection=new Set([io.id]);
  try{ healLayout(sch, scopeOf(sch,{wires:[w]})); }catch(_){}
  snapshot(); render(); renderInspector(); uxStepperSoon();
  toast(`สร้าง ${dir==="IN"?"INPUT":"OUTPUT"} '${nm}' ต่อกับขา ${p.id} แล้ว — ดับเบิลคลิกเพื่อเปลี่ยนชื่อ`,"ok",2600);
  ev.stopPropagation();
}, true);

/* ---------- 5d. place N copies in a row, optionally chained ---------- */
function arrayTypeOptions(){
  const o=[];
  Object.values(state.project.schematics).forEach(s=>{ if(s.id!==state.activeId) o.push({v:"SCH:"+s.id, t:"บล็อก: "+s.name}); });
  Object.keys(state.project.customs||{}).forEach(n=>o.push({v:"CUSTOM:"+n, t:"คอมโพเนนต์: "+n}));
  ["DFF","JKFF","TFF","SRFF","AND","OR","XOR","NOT","MUX"].forEach(t=>{ if(TYPES[t]) o.push({v:t, t:TYPES[t].label}); });
  return o;
}
function uxTypePorts(type){
  const probe={id:"_probe", type, x:0, y:0, params:{}};
  if(TYPES[type]) probe.params=JSON.parse(JSON.stringify(TYPES[type].defaultParams||{}));
  try{ return getPorts(probe); }catch(_){ return []; }
}
function openArrayPlace(preset){
  const opts=arrayTypeOptions();
  if(!opts.length){ toast("ยังไม่มีบล็อกให้วางซ้ำ","warn"); return; }
  const sel=(preset&&preset.type)||(opts.find(o=>o.v.startsWith("SCH:"))||opts[0]).v;
  const m=uxModal("▦ วางซ้ำเป็นชุด", `
    <div class="row"><label>ชิ้นที่จะวาง</label><select id="arType">${opts.map(o=>`<option value="${escA(o.v)}" ${o.v===sel?"selected":""}>${esc(o.t)}</option>`).join("")}</select></div>
    <div class="row"><label>จำนวน</label><input id="arN" type="number" min="2" max="16" value="${(preset&&preset.n)||4}"></div>
    <div class="row"><label>เรียง</label><select id="arDir"><option value="h">แนวนอน (ซ้าย → ขวา)</option><option value="v">แนวตั้ง (บน → ล่าง)</option></select></div>
    <div class="row"><label>ต่อเป็นทอด</label><span class="ar-chain"><select id="arFrom"></select> <span class="muted">ของตัวที่ k →</span> <select id="arTo"></select> <span class="muted">ของตัวที่ k+1</span></span></div>
    <div class="row"><label>ขาที่ต่อร่วมกัน</label><div id="arShared" class="ar-shared"></div></div>
    <div class="muted" style="font-size:11.5px;margin-left:140px">เช่น mod_10 × 4: ต่อทอดจาก carry/clk_out → clk ของหลักถัดไป · ขาที่ติ๊ก = สร้าง INPUT หนึ่งตัวต่อเข้าทุกชิ้น (เช่น rst)</div>`,
    {width:600, foot:'<button class="btn" id="arNo">ยกเลิก</button><button class="btn btn-primary" id="arOk">วาง</button>'});
  const $m=s=>m.querySelector(s);
  function fill(){
    const ports=uxTypePorts($m("#arType").value), outs=ports.filter(p=>p.dir==="out"), ins=ports.filter(p=>p.dir==="in");
    const pickOut=outs.find(p=>/carry|co|tc|clk_?out|cout|rco|q\d*$|^q$/i.test(p.id)) , pickIn=ins.find(p=>/clk|clock|cin|en/i.test(p.id));
    $m("#arFrom").innerHTML='<option value="">— ไม่ต่อ —</option>'+outs.map(p=>`<option ${pickOut===p?"selected":""}>${escA(p.id)}</option>`).join("");
    $m("#arTo").innerHTML='<option value="">—</option>'+ins.map(p=>`<option ${pickIn===p?"selected":""}>${escA(p.id)}</option>`).join("");
    $m("#arShared").innerHTML=ins.map(p=>`<label><input type="checkbox" value="${escA(p.id)}" ${/^(rst|reset|clr|en)$/i.test(p.id)?"checked":""}> ${esc(p.id)}</label>`).join("")||'<span class="muted">—</span>';
  }
  $m("#arType").onchange=fill; fill();
  $m("#arNo").onclick=()=>m.close();
  $m("#arOk").onclick=()=>{
    const type=$m("#arType").value, n=Math.max(2,Math.min(16,+$m("#arN").value||4)), dir=$m("#arDir").value;
    const chain=[$m("#arFrom").value,$m("#arTo").value], shared=[...m.querySelectorAll("#arShared input:checked")].map(x=>x.value);
    m.close(); arrayPlace(type, n, dir, chain[0]&&chain[1]?chain:null, shared);
  };
}
function arrayPlace(type, n, dir, chain, shared){
  const sch=activeSch(); if(!sch) return;
  const start=UX_MOUSE_IN?state.mouse:uxViewCenter();
  const before=new Set(sch.wires.map(w=>w.id)), made=[];
  let sz={w:80,h:60};
  for(let k=0;k<n;k++){
    const id=addComp(type, start.x, start.y); if(!id) return;
    const c=comp(id, sch); if(k===0) sz=getSize(c);
    const gapX=sz.w+264, gapY=sz.h+110;     // room between copies for I/O markers and labels
    c.x=snap(start.x-(dir==="h"?((n-1)*gapX)/2:0)+(dir==="h"?k*gapX:0));
    c.y=snap(start.y+(dir==="v"?k*gapY:0));
    const base=String(type).startsWith("SCH:") ? (state.project.schematics[type.slice(4)]||{}).name : (TYPES[type]?TYPES[type].label:String(type).split(":").pop());
    c.label=uniqueLabel(sch, sanId(base||"u")+"_"+(k+1), c);
    made.push(c);
  }
  if(chain) for(let k=0;k<n-1;k++) sch.wires.push({id:uid("w"), from:{cid:made[k].id,pid:chain[0]}, to:{cid:made[k+1].id,pid:chain[1]}, name:""});
  (shared||[]).forEach((pid,si)=>{
    const p0=getPort(made[0],pid); if(!p0) return;
    const taken=new Set(sch.components.filter(x=>x.type==="IN").map(x=>x.params.name));
    let nm=sanId(pid), q=1; while(taken.has(nm)) nm=sanId(pid)+(q++);
    const io={id:uid("c"), type:"IN", x:snap(made[0].x-160), y:snap(made[0].y+sz.h+44+si*44), params:{name:nm,width:1}, label:""};
    sch.components.push(io);
    made.forEach(c=>{ if(chain && pid===chain[1] && c!==made[0]) return;   // chained pin is taken by the cascade
      sch.wires.push({id:uid("w"), from:{cid:io.id,pid:"o"}, to:{cid:c.id,pid}, name:""}); });
  });
  try{ normalizePortFanout(sch); }catch(_){}
  const fresh=sch.wires.filter(w=>!before.has(w.id));
  try{ healLayout(sch, scopeOf(sch,{wires:fresh})); }catch(_){}
  state.selection=new Set(made.map(c=>c.id));
  snapshot(); renderAll();
  toast(`วาง ${n} ชิ้น${chain?` ต่อทอด ${chain[0]} → ${chain[1]}`:""}${shared&&shared.length?` · ขาร่วม: ${shared.join(", ")}`:""}`,"ok",3200);
}

/* ---------- 5a. Ctrl+K: search every command, Thai or English ---------- */
const CMD_WORDS = {   // extra words people actually type
  "auto-route":"จัดสาย จัดเส้น route auto wire", "relayout":"จัดสายใหม่", "export-vhdl":"ส่งออก vhdl export vhd โค้ด",
  "export-all":"ส่งออก vhdl ทั้งหมด export all", "save-project":"บันทึก save เซฟ", "open-project":"เปิด open ไฟล์",
  "new-project":"ใหม่ new project โปรเจกต์", "synth":"ตรวจ check synthesis error", "undo":"ย้อน undo", "redo":"ทำซ้ำ redo",
  "probe":"ตรวจค่า probe 01 ค่า", "net-color":"สี color net", "topdown-open":"top-down ผังบล็อก block", "import-vhdl":"นำเข้า import vhdl",
  "zoom-fit":"พอดีจอ fit zoom", "ai-chat":"ai แชต chat ผู้ช่วย", "history-open":"ประวัติ history ย้อนเวลา restore",
  "clear-sch":"ล้าง clear", "welcome-open":"ต้อนรับ welcome เทมเพลต template แลป lab", "tour-start":"ทัวร์ tour สอน", "toggle-marks":"ปัญหา marker issue",
  "explain-sim":"ทำไม why sim จำลอง ไม่ได้", "open-manual":"คู่มือ manual help ช่วย",
};
function cmdkCommands(){
  const L=[], seen=new Set();
  const add=(label, hint, run, words)=>{ const k=label+"|"+hint; if(seen.has(k)) return; seen.add(k); L.push({label, hint, run, hay:(label+" "+hint+" "+(words||"")).toLowerCase()}); };
  document.querySelectorAll("#menu .dd button[data-act], .topbar > button[data-act], #canvasToolbar button[data-act]").forEach(b=>{
    const act=b.dataset.act; if(act==="theme") return;
    const kbd=b.querySelector(".kbd"); const label=(b.childNodes[0]&&b.childNodes[0].textContent||b.textContent).trim()||b.title;
    const inBar=b.closest("#canvasToolbar"), shown=inBar ? ((b.title||"").split("—")[0].trim()||label) : label.replace(/…$/,"");
    add(shown, kbd?kbd.textContent:(inBar?"แถบเครื่องมือ":"คำสั่ง"), ()=>b.click(), (CMD_WORDS[act]||"")+" "+act+" "+(b.title||""));
  });
  document.querySelectorAll("#canvasToolbar button[data-tool]").forEach(b=>add("เครื่องมือ: "+(b.title||b.dataset.tool).split("—")[0].trim(), "เครื่องมือ", ()=>setTool(b.dataset.tool), b.dataset.tool+" "+(b.title||"")));
  [["draw","วาด"],["pins","เลือกขา pin mapping"],["sim","จำลอง sim simulate"],["upload","ลงบอร์ด upload xdc board"]].forEach(([s,w])=>add("ไปขั้น: "+w.split(" ")[0], "ขั้นตอน", ()=>setStage(s), w));
  const keyOf={}; Object.entries(PLACE_KEYS).forEach(([code,[a,b]])=>{ keyOf[a]=code.slice(3); if(b) keyOf[b]="Shift+"+code.slice(3); });
  Object.keys(TYPES).forEach(t=>{ const td=TYPES[t]; if(!td||["wire","custom","sch"].includes(td.category)) return;
    add("วาง "+td.label, keyOf[t]||"ชิ้นส่วน", ()=>uxPlace(t), t+" "+td.category+" วาง place gate เกต"); });
  Object.values(state.project.schematics).forEach(s=>{ if(s.id!==state.activeId) add("วางบล็อก "+s.name, "บล็อก", ()=>uxPlace("SCH:"+s.id), "block sub schematic"); });
  GENERATORS.forEach(g=>add(g.name, "ตัวสร้างวงจร", g.run, g.desc+" generator สร้าง"));
  LAB_TEMPLATES.forEach(T=>add("เทมเพลต "+T.lab+": "+T.title, "เทมเพลตแลป", ()=>startLabTemplate(T.id), "template lab "+T.desc));
  EXAMPLES.forEach(e=>add("ตัวอย่าง: "+e.name, "ตัวอย่าง", e.run, "example "+e.desc));
  add("วางซ้ำเป็นชุด…", "จัดวาง", ()=>openArrayPlace(), "array repeat ซ้ำ ชุด cascade ทอด mod");
  add("ทำไมผลจำลองไม่เป็นอย่างที่คิด?", "ผู้ช่วย", ()=>openExplainSim(), CMD_WORDS["explain-sim"]);
  add("คีย์ลัดทั้งหมด", "?", ()=>openShortcutHelp(), "shortcut keyboard คีย์");
  Object.values(state.project.schematics).forEach(s=>add("เปิดแผ่น "+s.name, "แผ่น", ()=>openSchTab(s.id), "sheet tab open"));
  return L;
}
function openCmdK(){
  if(document.querySelector(".cmdk-bg")) return;
  const cmds=cmdkCommands();
  const bg=document.createElement("div"); bg.className="cmdk-bg";
  bg.innerHTML='<div class="cmdk"><input class="cmdk-in" placeholder="พิมพ์คำสั่ง เช่น and, จัดสาย, ส่งออก vhdl, mod 10…" spellcheck="false"><div class="cmdk-list"></div><div class="cmdk-foot muted">↑↓ เลือก · Enter ทำ · Esc ปิด</div></div>';
  document.body.appendChild(bg);
  const inp=bg.querySelector(".cmdk-in"), list=bg.querySelector(".cmdk-list");
  let hits=[], idx=0;
  const close=()=>bg.remove();
  function search(){
    const q=inp.value.toLowerCase().trim(), toks=q.split(/\s+/).filter(Boolean);
    hits=(toks.length?cmds.filter(c=>toks.every(t=>c.hay.includes(t))):cmds.slice())
      .map(c=>({c, s:(c.label.toLowerCase().startsWith(q)?0:c.label.toLowerCase().includes(q)?1:2)+c.label.length/1000}))
      .sort((a,b)=>a.s-b.s).slice(0,14).map(x=>x.c);
    idx=0; draw();
  }
  function draw(){
    list.innerHTML=hits.length?hits.map((c,i)=>`<div class="cmdk-i ${i===idx?"on":""}" data-i="${i}"><span>${esc(c.label)}</span><span class="cmdk-h">${esc(c.hint)}</span></div>`).join("")
      :'<div class="muted" style="padding:12px">ไม่พบคำสั่ง</div>';
    list.querySelectorAll(".cmdk-i").forEach(e=>{ e.onmousemove=()=>{ if(idx!==+e.dataset.i){ idx=+e.dataset.i; draw(); } }; e.onclick=()=>run(); });
    const on=list.querySelector(".on"); if(on) on.scrollIntoView({block:"nearest"});
  }
  function run(){ const c=hits[idx]; close(); if(c) setTimeout(()=>{ try{ c.run(); }catch(e){ toast("ทำคำสั่งไม่ได้: "+e.message,"err"); } }, 0); }
  inp.addEventListener("input", search);
  inp.addEventListener("keydown", e=>{
    if(e.key==="ArrowDown"){ idx=Math.min(hits.length-1, idx+1); draw(); e.preventDefault(); }
    else if(e.key==="ArrowUp"){ idx=Math.max(0, idx-1); draw(); e.preventDefault(); }
    else if(e.key==="Enter"){ run(); e.preventDefault(); }
    else if(e.key==="Escape"){ close(); e.preventDefault(); }
    e.stopPropagation();
  });
  bg.addEventListener("mousedown", e=>{ if(e.target===bg) close(); });
  search(); inp.focus();
}
document.addEventListener("click", ev=>{
  const a=ev.target.closest && ev.target.closest("[data-act]"); if(!a) return;
  if(a.dataset.act==="cmdk") openCmdK();
  else if(a.dataset.act==="array-place") openArrayPlace();
  else if(a.dataset.act==="shortcuts") openShortcutHelp();
});
/* the toolbar tooltips still said N / I for the old tools */
{
  const nn=document.querySelector('#canvasToolbar [data-tool="netname"]'); if(nn) nn.title=nn.title.replace("(N)","(Shift+N)");
  const io=document.querySelector('#canvasToolbar [data-tool="iomarker"]'); if(io) io.title=io.title.replace("(I)","(Shift+I)");
  if(typeof TOOL_INFO==="object"){ Object.values(TOOL_INFO).forEach(t=>{ if(t&&typeof t.hint==="string") t.hint=t.hint.replace(/\(N\)/g,"(Shift+N)").replace(/\(I\)/g,"(Shift+I)"); }); }
}

/* move a new part off anything it would sit on: try small vertical steps, then to the side */
function uxNudgeFree(sch, nc){
  const G=typeof GRID==="number"?GRID:11, M=G;
  const box=c=>{ const z=getSize(c); return {x0:c.x-M, y0:c.y-M, x1:c.x+z.w+M, y1:c.y+z.h+M}; };
  // existing wire segments too — a marker dropped on a passing wire reads as connected to it
  const segs=[]; (sch.wires||[]).forEach(w=>{ const a=comp(w.from.cid,sch), b=comp(w.to.cid,sch); if(!a||!b) return;
    const pa=portPos(a,w.from.pid), pb=portPos(b,w.to.pid); if(!pa||!pb) return;
    const pts=[pa,...(w.pts||[]),pb]; for(let i=1;i<pts.length;i++) segs.push([pts[i-1],pts[i]]); });
  const segHit=a=>segs.some(([p,q])=>{ const x0=Math.min(p.x,q.x), x1=Math.max(p.x,q.x), y0=Math.min(p.y,q.y), y1=Math.max(p.y,q.y);
    return x0<a.x1-M && x1>a.x0+M && y0<a.y1-M && y1>a.y0+M; });
  const hit=()=>{ const a=box(nc); return segHit(a) || (sch.components||[]).some(o=>o!==nc && o.type!=="JUNCTION" && (()=>{ const b=box(o); return a.x0<b.x1&&a.x1>b.x0&&a.y0<b.y1&&a.y1>b.y0; })()); };
  if(!hit()) return;
  const x0=nc.x, y0=nc.y;
  // stay on the pin's row first (a straight wire), moving away from the part: OUT → right, IN → left
  const away=nc.type==="IN"?-1:1;
  for(let k=1;k<=3;k++){ nc.y=y0; nc.x=x0+away*k*3*G; if(!hit()) return; }   // a little only — never past the next part
  for(let k=1;k<=12;k++){ for(const d of [k,-k]){ nc.x=x0; nc.y=y0+d*4*G; if(!hit()) return; } }
  nc.x=x0; nc.y=y0;
}
