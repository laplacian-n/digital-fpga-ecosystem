/* =========================================================================
   3. GUIDING NEW USERS
   ========================================================================= */

/* ---------- 3a. pin map saved WITH the sheet + the board's real pins ----------
   sch.pinmap = {portName: target}. Targets: sw:N pb:N clk | led:N seg:a..g seg:dp an:N buzzer.
   The sim board's SIM_PINMAP is seeded from it and every change in "เลือกขา" is written back,
   so the choice survives reloads, lives in the project file, and a lab template can pre-fill it. */
const BOARD_PINS = (()=>{
  const p={clk:"H11", buzzer:"B14"};
  for(let i=0;i<16;i++){ p["sw:"+i]=SIM_SW_PINS[15-i]; p["led:"+i]=SIM_LED_PINS[15-i]; }
  ["J13","L13","J14","J11","J12"].forEach((pin,i)=>p["pb:"+i]=pin);                 // top bottom left right center
  ["H4","H3","H2","H1"].forEach((pin,i)=>p["an:"+i]=pin);                            // digit select 0 = rightmost
  Object.entries({a:"L3",b:"P4",c:"P2",d:"M3",e:"M1",f:"J4",g:"K4",dp:"J2"}).forEach(([s,pin])=>p["seg:"+s]=pin);
  return p;
})();
function pinTargetLabel(t){
  if(!t) return "—";
  if(t==="clk") return "นาฬิกา 50 MHz (H11)";
  const [k,v]=t.split(":"), pin=BOARD_PINS[t]||"?";
  return ({sw:"SW",led:"LED",pb:"ปุ่ม",seg:"7SEG",an:"หลัก"}[k]||t)+" "+(v!=null?v:"")+" ("+pin+")";
}
/* ports that only ever mean one thing on this board */
function autoSpecialTarget(name, dir){
  const n=String(name).toLowerCase();
  if(dir==="in" && /^(clk|clock|clk_?50m?)$/.test(n)) return "clk";
  let m;
  if(dir==="out" && (m=n.match(/^(?:an|dig|digit)_?([0-3])$/))) return "an:"+m[1];
  if(dir==="out" && /^(dp|seg_?dp)$/.test(n)) return "seg:dp";
  return null;
}
function sheetPorts(sch){
  sch=sch||activeSch(); if(!sch) return [];
  return (sch.components||[]).filter(c=>c.type==="IN"||c.type==="OUT").sort((a,b)=>a.y-b.y)
    .map(c=>({name:(c.params&&c.params.name)||c.id, dir:c.type==="IN"?"in":"out", cid:c.id}));
}
{
  const _def=simDefaultPinmap;
  simDefaultPinmap=function(tt){
    const pm=_def.apply(this, arguments), own=(activeSch()||{}).pinmap||{};
    tt.inputs.forEach(n=>{ const t=pmGet(own,n); if(t&&t.indexOf("sw:")===0) pm.inMap[n]=+t.slice(3); });
    tt.outputs.forEach(n=>{ const t=pmGet(own,n)||autoSpecialTarget(n,"out"); if(t&&(t.indexOf("led:")===0||/^seg:[a-g]$/.test(t)||/^an:[0-3]$/.test(t)||t==="buzzer")) pm.outMap[n]=t; });
    return pm;
  };
  const _pick=renderPinPicker;
  renderPinPicker=function(tt){
    const r=_pick.apply(this, arguments);
    const host=$("#simPinPicker"), sch=activeSch(); if(!host||!sch) return r;
    host.querySelectorAll("select[data-pmk]").forEach(s=>s.addEventListener("change",()=>{
      const n=s.dataset.pm; sch.pinmap=sch.pinmap||{};
      sch.pinmap[n]= s.dataset.pmk==="in" ? "sw:"+s.value : s.value;
      snapshot(); uxStepperSoon();
    }));
    // mark rows the user hasn't confirmed yet, and offer a one-click confirm
    const own=sch.pinmap||{};
    host.querySelectorAll("select[data-pmk]").forEach(s=>{ const tr=s.closest("tr"); if(tr) tr.classList.toggle("ux-unconf", !own[s.dataset.pm]); });
    const det=host.querySelector("details"); if(det && !det.querySelector(".ux-confirm")){
      const bar=document.createElement("div"); bar.className="ux-confirm";
      bar.innerHTML='<button class="btn2" type="button">✓ ยืนยันขาตามนี้ทั้งหมด</button><span class="muted">แถวสีส้ม = ยังเป็นค่าอัตโนมัติ ยังไม่ได้ยืนยัน</span>';
      bar.querySelector("button").onclick=()=>{
        sch.pinmap=sch.pinmap||{};
        tt.inputs.forEach(n=>sch.pinmap[n]="sw:"+SIM_PINMAP.inMap[n]);
        tt.outputs.forEach(n=>sch.pinmap[n]=SIM_PINMAP.outMap[n]);
        snapshot(); renderPinPicker(tt); uxStepperSoon(); toast("บันทึกการเลือกขาไว้กับแผ่นนี้แล้ว","ok");
      };
      det.appendChild(bar);
    }
    if(UX.highlightPins){ const miss=UX.highlightPins; UX.highlightPins=null;
      let first=null; host.querySelectorAll("select[data-pmk]").forEach(s=>{ if(miss.includes(s.dataset.pm)){ const tr=s.closest("tr"); tr.classList.add("ux-flash"); first=first||tr; } });
      if(first) first.scrollIntoView({block:"center", behavior:"smooth"}); }
    return r;
  };
}
/* resolve a port to a board pin: sheet's own choice → sim page choice → name rule → order */
function uxPinFor(name, dir, k){
  const own=(activeSch()||{}).pinmap||{};
  let t=pmGet(own,name);
  if(!t && SIM_PINMAP){ if(dir==="in" && SIM_PINMAP.inMap[name]!=null) t="sw:"+SIM_PINMAP.inMap[name];
    else if(dir==="out" && SIM_PINMAP.outMap[name]) t=SIM_PINMAP.outMap[name]; }
  t=t||autoSpecialTarget(name, dir)||(dir==="in"?"sw:"+k:"led:"+k);
  return {target:t, pin:BOARD_PINS[t]||"?"};
}
function uxXdcBody(ins, outs){
  let x="";
  const put=(n,p)=>{ x+=`set_property -dict {PACKAGE_PIN ${p.pin} IOSTANDARD LVCMOS33} [get_ports ${n}]   ## ${pinTargetLabel(p.target)}\n`; };
  ins.forEach((n,k)=>{ const p=uxPinFor(n,"in",k); put(n,p);
    if(p.target==="clk") x+=`create_clock -period 20.000 -name sys_clk [get_ports ${n}]\n`; });
  x+="\n";
  let led=0; outs.forEach(n=>{ const p=uxPinFor(n,"out",led); if(p.target.indexOf("led:")===0) led++; put(n,p); });
  return x;
}
function uxUploadRows(ins, outs){
  let led=0;
  return ins.map((n,k)=>`<tr><td style="text-align:left">${esc(n)}</td><td>IN</td><td style="text-align:left">${esc(pinTargetLabel(uxPinFor(n,"in",k).target))}</td></tr>`).join("")
       + outs.map(n=>{ const p=uxPinFor(n,"out",led); if(p.target.indexOf("led:")===0) led++;
           return `<tr><td style="text-align:left">${esc(n)}</td><td>OUT</td><td style="text-align:left">${esc(pinTargetLabel(p.target))}</td></tr>`; }).join("");
}

/* ---------- 3b. lab templates: ports named + pins mapped from the start ---------- */
const LAB_TEMPLATES = [
  {id:"gate2", lab:"แลป 1", title:"ลอจิกเกต 2 อินพุต", desc:"a, b → y · ทดลอง AND/OR/XOR…",
   ins:[["a","sw:0"],["b","sw:1"]], outs:[["y","led:0"]]},
  {id:"gate3", lab:"แลป 1", title:"วงจร 3 อินพุต", desc:"a, b, c → x, y",
   ins:[["a","sw:0"],["b","sw:1"],["c","sw:2"]], outs:[["x","led:0"],["y","led:1"]]},
  {id:"walk", lab:"แลป 2", title:"สัญญาณไฟข้ามถนน", desc:"P C R E S → Walk, Caution",
   ins:[["P","sw:4"],["C","sw:3"],["R","sw:2"],["E","sw:1"],["S","sw:0"]], outs:[["Walk","led:0"],["Caution","led:1"]]},
  {id:"f4", lab:"แลป 3", title:"ลดรูปสมการ 4 ตัวแปร", desc:"a b c d → f · ใช้คู่กับตารางความจริง/K-map",
   ins:[["a","sw:3"],["b","sw:2"],["c","sw:1"],["d","sw:0"]], outs:[["f","led:0"]], after:"tt"},
  {id:"hex7", lab:"แลป 4-1", title:"HEX → 7-Segment", desc:"D3..D0 → a–g (active-low) + เปิดหลักขวาสุด",
   ins:[["D3","sw:3"],["D2","sw:2"],["D1","sw:1"],["D0","sw:0"]],
   outs:[["a","seg:a"],["b","seg:b"],["c","seg:c"],["d","seg:d"],["e","seg:e"],["f","seg:f"],["g","seg:g"],["an0","an:0"]],
   tie:{an0:"GND"}, note:"an0 ต่อ GND ไว้ให้หลักขวาสุดติด — ถ้าจอไม่ติด ลองเปลี่ยนเป็น VCC"},
  {id:"fa", lab:"แลป 4-2", title:"Full Adder (FA1)", desc:"A, B, Cin → S, Cout",
   ins:[["A","sw:2"],["B","sw:1"],["Cin","sw:0"]], outs:[["S","led:0"],["Cout","led:1"]]},
  {id:"cnt8", lab:"แลป 5", title:"ตัวนับ 0–7 (flip-flop)", desc:"clk → Q2 Q1 Q0 บน LED",
   ins:[["clk","clk"]], outs:[["Q2","led:2"],["Q1","led:1"],["Q0","led:0"]],
   note:"clk บนบอร์ดคือ 50 MHz — ต้องมีวงจรหารความถี่ก่อน (ใช้ “ตัวนับ mod-N” ในเมนู Tools ต่อกันเป็นทอด)"},
];
function buildTemplateSheet(sch, T){
  const G=typeof GRID==="number"?GRID:11, sn=v=>Math.round(v/G)*G;
  sch.components=[]; sch.wires=[]; sch.pinmap={};
  const mk=(type, x, y, params)=>{ const c={id:uid("c"), type, x:sn(x), y:sn(y), params, label:""}; sch.components.push(c); return c; };
  T.ins.forEach(([n,t],i)=>{ mk("IN", 88, 110+i*66, {name:n, width:1}); sch.pinmap[sanId(n)]=t; });
  T.outs.forEach(([n,t],i)=>{
    const o=mk("OUT", 660, 110+i*66, {name:n, width:1}); sch.pinmap[sanId(n)]=t;
    const tie=T.tie&&T.tie[n];
    if(tie){ const s=mk(tie, 540, 110+i*66, JSON.parse(JSON.stringify((TYPES[tie]&&TYPES[tie].defaultParams)||{})));
      const sp=(getPorts(s).find(p=>p.dir==="out")||{}).id||"o", op=(getPorts(o).find(p=>p.dir==="in")||{}).id||"i";
      sch.wires.push({id:uid("w"), from:{cid:s.id,pid:sp}, to:{cid:o.id,pid:op}, width:1}); }
  });
  try{ if(sch.wires.length) autoRouteSheet(sch); }catch(_){}
}
function startLabTemplate(id){
  const T=LAB_TEMPLATES.find(x=>x.id===id); if(!T) return;
  const p=addProject("lab"+((T.lab.match(/[0-9-]+/)||[""])[0]).replace("-","_")+"_"+T.id);
  const sch=p.schematics[p.topId]; sch.name=uniqueSchName(sanId(T.id)||"top", sch.id);
  buildTemplateSheet(sch, T);
  openSchTab(sch.id); snapshot(); renderAll(); try{ zoomFit(); }catch(_){}
  toast(`เริ่ม ${T.lab}: ${T.title} — พอร์ตและขาบอร์ดตั้งไว้ให้แล้ว วาดวงจรตรงกลางได้เลย`,"ok",5000);
  if(T.note) setTimeout(()=>toast("ℹ "+T.note,"info",7000), 600);
  if(T.after==="tt") setTimeout(()=>openTruthTableTool({inputs:T.ins.map(x=>x[0]), outputs:T.outs.map(x=>x[0]),
    rows:{[T.outs[0][0]]:Array(1<<T.ins.length).fill("0")}, module:"f"}), 400);
  uxStepperSoon();
}

/* ---------- 3c. welcome screen ---------- */
const EXAMPLES = [
  {name:"Half adder", desc:"XOR + AND", run:()=>uxDrawGenerated(ttToIntent(["a","b"],["sum","cout"],{sum:["0","1","1","0"],cout:["0","0","0","1"]},"half_adder").intent,"half adder")},
  {name:"Full adder", desc:"3 อินพุต", run:()=>uxDrawGenerated(ttToIntent(["a","b","cin"],["s","cout"],{s:"01101001".split(""),cout:"00010111".split("")},"full_adder").intent,"full adder")},
  {name:"BCD → 7-seg", desc:"ลดรูปด้วย K-map", run:()=>{ const P=seg7Preset(false); uxDrawGenerated(ttToIntent(P.inputs,P.outputs,P.rows,P.module).intent,"BCD → 7-seg"); }},
  {name:"ตัวนับ mod-10", desc:"synchronous 0–9", run:()=>{ const r=fsmCounterIntent([0,1,2,3,4,5,6,7,8,9]); r.module="mod10"; uxDrawGenerated(r,"ตัวนับ mod-10"); }},
  {name:"Ripple counter 4 บิต", desc:"D-FF ต่อเป็นทอด", run:()=>{ const b=seqBuildIntent("counter 4 bit"); uxDrawGenerated(b.intent,b.title); }},
];
function openWelcome(view){
  view=view||"home";
  const tpl=LAB_TEMPLATES.map(T=>`<button class="wl-card" data-tpl="${T.id}"><span class="wl-lab">${esc(T.lab)}</span><b>${esc(T.title)}</b><span>${esc(T.desc)}</span></button>`).join("");
  const ex=EXAMPLES.map((e,i)=>`<button class="wl-card" data-ex="${i}"><b>${esc(e.name)}</b><span>${esc(e.desc)}</span></button>`).join("");
  const m=uxModal("ยินดีต้อนรับสู่ Schematic Studio", `
    <div class="wl-view ${view==="home"?"on":""}" data-v="home">
      <p class="muted" style="margin:0 0 12px">วาดวงจร → เลือกขา → จำลอง → ลงบอร์ด EDGE Spartan-7 · เริ่มจากตรงไหนดี?</p>
      <div class="wl-main">
        <button class="wl-big" data-go="labs"><span class="wl-ico">🧪</span><b>เริ่มแลปใหม่</b><span>เลือกเทมเพลตแลป — ตั้งชื่อขาและแมพขาบอร์ดไว้ให้แล้ว</span></button>
        <button class="wl-big" data-go="open"><span class="wl-ico">📂</span><b>เปิดไฟล์</b><span>ไฟล์ .schproj.json ที่บันทึกไว้</span></button>
        <button class="wl-big" data-go="examples"><span class="wl-ico">💡</span><b>ดูตัวอย่าง</b><span>วงจรสำเร็จรูป เปิดดูแล้วลองจำลอง</span></button>
      </div>
      <div class="wl-foot"><button class="btn" data-go="blank">เริ่มแผ่นว่าง</button><button class="btn" data-go="tour">▶ ทัวร์ 1 นาที</button>
        <span style="flex:1"></span><label class="muted"><input type="checkbox" id="wlHide"> ไม่ต้องแสดงตอนเปิดโปรแกรม</label></div>
    </div>
    <div class="wl-view ${view==="labs"?"on":""}" data-v="labs">
      <button class="btn btn-ghost" data-go="home">← กลับ</button>
      <div class="wl-grid">${tpl}</div>
      <p class="muted" style="font-size:11.5px">ขาสวิตช์ใช้หมายเลข sw[0]–sw[15] ของบอร์ด (sw[0] = ขวาสุด) — เปลี่ยนได้ที่หน้า “เลือกขา”</p>
    </div>
    <div class="wl-view ${view==="examples"?"on":""}" data-v="examples">
      <button class="btn btn-ghost" data-go="home">← กลับ</button>
      <div class="wl-grid">${ex}</div>
    </div>`, {width:720});
  const show=v=>m.querySelectorAll(".wl-view").forEach(x=>x.classList.toggle("on", x.dataset.v===v));
  const hide=m.querySelector("#wlHide"); hide.checked=uxLS("schstudio.welcomeHidden")==="1";
  hide.onchange=()=>uxLS("schstudio.welcomeHidden", hide.checked?"1":null);
  m.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>{
    const g=b.dataset.go;
    if(g==="labs"||g==="examples"||g==="home") return show(g);
    m.close();
    if(g==="open") openProjectFromFile();
    else if(g==="blank"){ const p=addProject("project"); toast(`สร้างโปรเจกต์ "${p.name}" แล้ว — เปิดแท็บ Components เพื่อวางเกต`,"ok",3600); }
    else if(g==="tour") startTour();
  });
  m.querySelectorAll("[data-tpl]").forEach(b=>b.onclick=()=>{ m.close(); startLabTemplate(b.dataset.tpl); });
  m.querySelectorAll("[data-ex]").forEach(b=>b.onclick=()=>{ m.close(); EXAMPLES[+b.dataset.ex].run(); });
}

/* ---------- 3d. stepper that says what's missing ---------- */
function uxQuietIssues(){
  const keep={renderErrors, setRightTab, toast};
  renderErrors=()=>{}; setRightTab=()=>{}; toast=()=>{};
  try{ return runSynthesis()||[]; } catch(_){ return []; }
  finally{ renderErrors=keep.renderErrors; setRightTab=keep.setRightTab; toast=keep.toast; }
}
function sheetSig(sch){ try{ return uxHash(JSON.stringify({c:sch.components,w:sch.wires})); }catch(_){ return ""; } }
const UXSTEP = { simSig:{}, upSig:{} };
function uxStepState(){
  const sch=activeSch(); if(!sch) return null;
  const all=uxQuietIssues().filter(i=>!i.schId || i.schId===sch.id);
  const errs=all.filter(i=>i.lvl==="err"), warns=all.filter(i=>i.lvl==="warn");
  const ports=sheetPorts(sch), own=sch.pinmap||{};
  const conf=ports.filter(p=>pmGet(own,p.name)||autoSpecialTarget(p.name,p.dir));
  const miss=ports.filter(p=>!conf.includes(p));
  const sig=sheetSig(sch);
  const empty=!(sch.components||[]).some(c=>c.type!=="JUNCTION");
  return {sch, empty, errs, warns, ports, conf, miss, simOk:UXSTEP.simSig[sch.id]===sig, upOk:UXSTEP.upSig[sch.id]===sig};
}
function uxRenderStepper(){
  const s=uxStepState(); if(!s) return;
  const badge=(stage, cls, text, tip)=>{
    const b=document.querySelector(`#pipeline .step[data-stage="${stage}"]`); if(!b) return;
    let e=b.querySelector(".st-b"); if(!e){ e=document.createElement("span"); e.className="st-b"; b.appendChild(e); }
    e.className="st-b "+cls; e.textContent=text; b.dataset.uxTip=tip; b.title=tip;
  };
  const names=a=>a.slice(0,4).map(p=>p.name).join(", ")+(a.length>4?` +${a.length-4}`:"");
  if(s.empty) badge("draw","todo","•","ยังไม่มีวงจรบนแผ่นนี้ — วางเกตจากแท็บ Components หรือเริ่มจากเทมเพลตแลป");
  else if(s.errs.length) badge("draw","err",String(s.errs.length),`พบ ${s.errs.length} ปัญหาที่ต้องแก้ — คลิกเพื่อดู\n• `+s.errs.slice(0,4).map(i=>i.msg).join("\n• "));
  else if(s.warns.length) badge("draw","warn",String(s.warns.length),`ไม่มี error · คำเตือน ${s.warns.length} รายการ — คลิกเพื่อดู`);
  else badge("draw","ok","✓","วงจรผ่านการตรวจแล้ว");
  if(!s.ports.length) badge("pins","todo","0","ยังไม่มี INPUT/OUTPUT ให้เลือกขา");
  else if(s.miss.length) badge("pins","warn",`${s.conf.length}/${s.ports.length}`,`เลือกขา ${s.conf.length}/${s.ports.length} — ยังไม่ได้ยืนยัน: ${names(s.miss)} (คลิกเพื่อไปเลือก)`);
  else badge("pins","ok","✓",`เลือกขาครบ ${s.ports.length} ขา`);
  badge("sim", s.simOk?"ok":"todo", s.simOk?"✓":"•", s.simOk?"จำลองแล้ว หลังการแก้ล่าสุด":"ยังไม่ได้จำลองหลังแก้ล่าสุด");
  badge("upload", s.upOk?"ok":"todo", s.upOk?"✓":"•", s.upOk?"ดาวน์โหลดไฟล์ลงบอร์ดแล้ว":(s.errs.length?"ยังมีปัญหาในวงจร — แก้ก่อนลงบอร์ด":"พร้อมสร้างไฟล์ .vhd + .xdc"));
  UX.step=s;
}
let _uxStepT=null;
function uxStepperSoon(){ clearTimeout(_uxStepT); _uxStepT=setTimeout(()=>{ try{ uxRenderStepper(); }catch(e){ console.warn("stepper",e); } }, 350); }
{
  const _renderAll=renderAll;
  renderAll=function(){ const r=_renderAll.apply(this, arguments); uxStepperSoon(); return r; };
  const _runSim=runSim;
  runSim=async function(){ const r=await _runSim.apply(this, arguments); const sch=activeSch(); if(sch) UXSTEP.simSig[sch.id]=sheetSig(sch); uxStepperSoon(); return r; };
  const _upDlg=openUploadDialog;
  openUploadDialog=function(proj, ins, outs, onDownload){
    const sch=activeSch();
    const r=_upDlg.call(this, proj, ins, outs, ()=>{ onDownload(); if(sch){ UXSTEP.upSig[sch.id]=sheetSig(sch); uxStepperSoon(); } });
    // show the pins that will actually be written, not just the port order
    const dlg=[...document.querySelectorAll(".modal-bg")].pop();
    const tb=dlg&&dlg.querySelector("table"); if(tb){ const head=tb.querySelector("tr"); tb.innerHTML=""; tb.appendChild(head); tb.insertAdjacentHTML("beforeend", uxUploadRows(ins, outs)); }
    if(UX.step && UX.step.errs.length){ const body=dlg&&dlg.querySelector(".modal-body");
      if(body) body.insertAdjacentHTML("afterbegin", `<div class="ux-need" style="border-color:var(--err)">⚠ วงจรยังมี ${UX.step.errs.length} ปัญหา — Vivado อาจ build ไม่ผ่าน กด “Check” เพื่อดูรายการ</div>`); }
    return r;
  };
}
/* a click on the badge goes to the thing that's missing */
document.addEventListener("click", ev=>{
  const b=ev.target.closest && ev.target.closest("#pipeline .st-b"); if(!b) return;
  const stage=b.parentElement.dataset.stage, s=UX.step; if(!s) return;
  if(stage==="draw" && (s.errs.length||s.warns.length)){ ev.stopPropagation(); setStage("draw"); runSynthesis(); return; }
  if(stage==="pins" && s.miss.length){ UX.highlightPins=s.miss.map(p=>p.name); }
}, true);

/* ---------- 3e. five-stop tour ---------- */
const TOUR = [
  {sel:'[data-ltab="palette"]', pre:()=>{ const t=$('[data-ltab="palette"]'); if(t) t.click(); }, title:"1 · วางเกต",
   text:"แท็บ Components มีเกตและขา I/O (ตัวสร้างวงจรสำเร็จรูปอยู่ในเมนู Tools) — คลิกหรือลากลงแผ่น (หรือกด A = AND, O = OR, N = NOT, I = INPUT, Q = OUTPUT)"},
  {sel:'[data-tool="wire"]', title:"2 · ต่อสาย", text:"เลือกเครื่องมือสาย (W) แล้วคลิกขาหนึ่งไปอีกขา · ลากออกจากขาที่ยังว่างแล้วปล่อยในที่โล่ง จะได้ INPUT/OUTPUT ชื่อเดียวกับขาทันที"},
  {sel:'.step[data-stage="sim"]', title:"3 · จำลอง", text:"ดูตารางความจริง สลับสวิตช์บนบอร์ดจำลอง และดูไทม์มิ่งของวงจรที่มี clock — ไม่ต้องติดตั้งอะไรเพิ่ม"},
  {sel:'.step[data-stage="pins"]', title:"4 · เลือกขา", text:"ผูกแต่ละ INPUT/OUTPUT กับสวิตช์ LED หรือ 7-segment บนบอร์ด · ตัวเลขบนปุ่มบอกว่าเลือกครบกี่ขาแล้ว"},
  {sel:'.step[data-stage="upload"]', title:"5 · ลงบอร์ด", text:"สร้างไฟล์ .vhd + .xdc สำหรับ Vivado (หรือ FPGA Builder) — ขาตรงกับที่เลือกไว้"},
];
function startTour(){
  let i=0;
  const ov=document.createElement("div"); ov.className="tour-ov";
  ov.innerHTML='<div class="tour-hole"></div><div class="tour-tip"><div class="tour-h"></div><div class="tour-t"></div><div class="tour-f"><span class="tour-n muted"></span><span style="flex:1"></span><button class="btn" data-t="skip">ข้าม</button><button class="btn btn-primary" data-t="next">ถัดไป</button></div></div>';
  document.body.appendChild(ov);
  const hole=ov.querySelector(".tour-hole"), tip=ov.querySelector(".tour-tip");
  const end=()=>{ ov.remove(); window.removeEventListener("resize", place); document.removeEventListener("keydown", key, true); uxLS("schstudio.tourDone","1"); };
  const key=e=>{ if(e.key==="Escape"){ e.stopPropagation(); end(); } else if(e.key==="Enter"||e.key==="ArrowRight"){ e.stopPropagation(); next(); } };
  function place(){
    const s=TOUR[i], el=document.querySelector(s.sel); const r=el?el.getBoundingClientRect():{left:innerWidth/2,top:innerHeight/2,width:0,height:0};
    const pad=6; Object.assign(hole.style,{left:(r.left-pad)+"px",top:(r.top-pad)+"px",width:(r.width+pad*2)+"px",height:(r.height+pad*2)+"px"});
    const tw=320, below=r.top+r.height+14+170<innerHeight;
    tip.style.left=Math.max(12,Math.min(innerWidth-tw-12, r.left+r.width/2-tw/2))+"px";
    tip.style.top=(below? r.top+r.height+14 : Math.max(12, r.top-14-tip.offsetHeight))+"px";
  }
  function show(){ const s=TOUR[i]; if(s.pre) s.pre();
    tip.querySelector(".tour-h").textContent=s.title; tip.querySelector(".tour-t").textContent=s.text;
    tip.querySelector(".tour-n").textContent=(i+1)+" / "+TOUR.length;
    tip.querySelector('[data-t="next"]').textContent=i===TOUR.length-1?"เสร็จ":"ถัดไป";
    requestAnimationFrame(place); }
  function next(){ if(++i>=TOUR.length) end(); else show(); }
  tip.querySelector('[data-t="next"]').onclick=next;
  tip.querySelector('[data-t="skip"]').onclick=end;
  window.addEventListener("resize", place); document.addEventListener("keydown", key, true);
  show();
}
document.addEventListener("click", ev=>{
  const a=ev.target.closest && ev.target.closest("[data-act]"); if(!a) return;
  if(a.dataset.act==="welcome-open") openWelcome();
  else if(a.dataset.act==="tour-start") startTour();
});
/* first visit (no earlier session, not dismissed) → welcome */
if(!UX.hadSession && uxLS("schstudio.welcomeHidden")!=="1" && !new URLSearchParams(location.search).get("open"))
  setTimeout(()=>{ if(!document.querySelector(".modal-bg")) openWelcome(); }, 500);
uxStepperSoon();
