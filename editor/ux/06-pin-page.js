/* =========================================================================
   6. PIN PAGE FROM THE ENTITY PORTS (works for every sheet)
   The old picker was built from the truth table, so a top sheet with flip-flops,
   sub-blocks or bus ports (no truth table) showed nothing to pick. This one lists
   every port of the sheet's VHDL entity — buses split into bits — and every pin the
   board has, independent of whether the sheet can be simulated.
   ========================================================================= */
const PIN_IN_TARGETS  = [...Array.from({length:16},(_,i)=>"sw:"+i), ...Array.from({length:5},(_,i)=>"pb:"+i), "clk"];
const PIN_OUT_TARGETS = [...Array.from({length:16},(_,i)=>"led:"+i), ..."abcdefg".split("").map(s=>"seg:"+s), "seg:dp",
                         ...Array.from({length:4},(_,i)=>"an:"+i), "buzzer"];
const PB_NAMES = ["บน","ล่าง","ซ้าย","ขวา","กลาง"];
function pinOptLabel(t){
  const pin=BOARD_PINS[t]||"?", [k,v]=t.split(":");
  if(t==="clk") return `นาฬิกา 50 MHz · ${pin}`;
  if(k==="sw") return `SW ${v} · ${pin}`;
  if(k==="pb") return `ปุ่ม${PB_NAMES[+v]||v} · ${pin}`;
  if(k==="led") return `LED ${v} · ${pin}`;
  if(k==="seg") return `7-seg ${v==="dp"?"จุด (dp)":v} · ${pin}`;
  if(k==="an") return `เลือกหลัก ${v} · ${pin}`;
  if(t==="buzzer") return `Buzzer · ${pin}`;
  return t;
}
/* every bit the entity exposes: {key, port, bit, dir, vhdl} · key = "a" or "d[3]" (what sch.pinmap stores) */
function uxPortBits(sch){
  sch=sch||activeSch(); if(!sch) return [];
  const out=[];
  // inputs first, then outputs, each in natural name order (q2 before q10) — easy to scan
  schPortList(sch).slice().sort((a,b)=>(a.dir===b.dir?0:a.dir==="in"?-1:1)||natCmp(a.id,b.id)).forEach(p=>{
    const w=p.width||1;
    if(w===1) out.push({key:p.id, port:p.id, bit:null, dir:p.dir, vhdl:p.id, width:1});
    else for(let i=w-1;i>=0;i--) out.push({key:`${p.id}[${i}]`, port:p.id, bit:i, dir:p.dir, vhdl:`${p.id}[${i}]`, width:w});
  });
  return out;
}
/* sensible first guess for one bit, given what's already taken */
function uxGuessTarget(b, used){
  const n=b.port.toLowerCase(), free=t=>!used.has(t)&&t;
  let t=null;
  if(b.dir==="in"){
    if(/^(clk|clock|clk_?50m?|sys_?clk)$/.test(n)) t="clk";
    else if(/^(rst|reset|btn|pb|key)/.test(n)){ for(let i=4;i>=0&&!t;i--) t=free("pb:"+i); }
  } else {
    let m;
    // bus on the 7-seg: top bit = a (the board's own Seven_Segment[7]=A … [0]=DP convention)
    if(/^(seg|seven|sseg|hex)/.test(n) && b.bit!=null){ const L=["a","b","c","d","e","f","g","dp"][b.width-1-b.bit]; t=(L&&b.width<=8)?free("seg:"+L):null; }
    else if((m=n.match(/^seg_?([a-g]|dp)$/))||(m=n.match(/^([a-g]|dp)$/))) t=free("seg:"+m[1]);
    else if(/^(an|dig|digit|com)/.test(n)){ if(b.bit!=null) t=free("an:"+b.bit); else { const d=n.match(/(\d)$/); t=free("an:"+(d?d[1]:"0")); } }
    else if(/^(buz|beep)/.test(n)) t=free("buzzer");
  }
  if(!t){ const pool=b.dir==="in"?PIN_IN_TARGETS.filter(x=>x.startsWith("sw:")):PIN_OUT_TARGETS.filter(x=>x.startsWith("led:"));
    // a bus lands on consecutive switches/LEDs with its bit 0 on the lowest free one
    t=pool.find(x=>!used.has(x))||null; }
  return t;
}
function uxAutoPins(sch, onlyMissing){
  uxNormPinmap(sch);
  const bits=uxPortBits(sch), keep=new Set(bits.map(b=>b.key));
  const own={}; if(onlyMissing) Object.entries(sch.pinmap||{}).forEach(([k,v])=>{ if(keep.has(k)) own[k]=v; });   // ports that no longer exist free their pins
  const used=new Set(Object.values(own));
  // buses low bit first so d[0] gets SW0, d[1] SW1 …
  bits.slice().sort((a,b)=>(a.port===b.port?(a.bit||0)-(b.bit||0):0)).forEach(b=>{
    if(own[b.key]) return; const t=uxGuessTarget(b, used); if(t){ own[b.key]=t; used.add(t); } });
  sch.pinmap=own;
}
/* keep the sim board (scalar ports on SW/LED/7-seg) in step with the sheet's map */
function uxSyncSimPinmap(){
  if(!SIM_PINMAP || !UX.lastTT) return;
  const own=(activeSch()||{}).pinmap||{}, tt=UX.lastTT;
  tt.inputs.forEach(n=>{ const t=pmGet(own,n); if(t&&t.startsWith("sw:")) SIM_PINMAP.inMap[n]=+t.slice(3); });
  tt.outputs.forEach(n=>{ const t=pmGet(own,n); if(t&&(t.startsWith("led:")||/^seg:[a-g]$/.test(t)||t==="buzzer")) SIM_PINMAP.outMap[n]=t; });
  if(SIM_REDRAW) try{ SIM_REDRAW(); }catch(_){}
}
function uxRenderPinPage(){
  const host=$("#simPinPicker"), sch=activeSch(); if(!host||!sch) return;
  uxNormPinmap(sch);
  const bits=uxPortBits(sch), own=sch.pinmap||{};
  const top=state.project.schematics[state.project.topId];
  const count={}; bits.forEach(b=>{ const t=own[b.key]; if(t) count[t]=(count[t]||0)+1; });
  const opt=(list,cur)=>'<option value="">— ไม่ต่อขา —</option>'+list.map(t=>`<option value="${t}" ${t===cur?"selected":""}>${esc(pinOptLabel(t))}${count[t]&&t!==cur?" (ใช้แล้ว)":""}</option>`).join("");
  const busOpt=(dir,w)=>{   // one choice fills the whole bus with consecutive pins
    const pool=dir==="in"?["sw"]:["led"], o=[];
    pool.forEach(k=>{ for(let s=0;s+w<=16;s+=(w<=4?4:8)) o.push(`<option value="${k}:${s}">${k==="sw"?"SW":"LED"} ${s+w-1}…${s}</option>`); });
    if(dir==="out"&&(w===7||w===8)){ o.push(`<option value="seg-a">7-seg a…g${w===8?",dp":""} (บิตบนสุด = a)</option>`); o.push(`<option value="seg-g">7-seg ${w===8?"dp,":""}g…a (บิต 0 = a)</option>`); }
    if(dir==="out"&&w===4) o.push('<option value="an">เลือกหลัก 3…0</option>');
    return '<option value="">ตั้งทั้งบัส…</option>'+o.join("");
  };
  let rows="", lastPort=null;
  bits.forEach(b=>{
    if(b.bit!=null && b.port!==lastPort){
      rows+=`<tr class="pp-bus"><td colspan="2"><b>${esc(b.port)}</b> <span class="muted">${b.dir==="in"?"in":"out"} ${b.width} บิต</span></td><td><select data-bus="${escA(b.port)}" data-dir="${b.dir}" data-w="${b.width}">${busOpt(b.dir,b.width)}</select></td></tr>`;
    }
    lastPort=b.port;
    const cur=own[b.key]||"", dup=cur&&count[cur]>1;
    rows+=`<tr class="${cur?"":"ux-unconf"} ${dup?"pp-dup":""}" data-key="${escA(b.key)}"><td class="${b.bit!=null?"pp-bit":""}">${esc(b.bit!=null?`${b.port}(${b.bit})`:b.port)}</td>`
      +`<td><span class="pp-dir ${b.dir}">${b.dir==="in"?"IN":"OUT"}</span></td>`
      +`<td><select data-pk="${escA(b.key)}">${opt(b.dir==="in"?PIN_IN_TARGETS:PIN_OUT_TARGETS, cur)}</select>${dup?' <span class="pp-warn">ขาซ้ำ</span>':""}</td></tr>`;
  });
  const done=bits.filter(b=>own[b.key]).length, dups=Object.values(count).filter(n=>n>1).length;
  host.innerHTML=`<div class="pinpage">
    <div class="pp-head">
      <div><b>เลือกขา — แผ่น “${esc(sch.name)}”</b> <span class="muted">${bits.length} ขา · เลือกแล้ว ${done}${dups?` · <span class="pp-warn">ขาซ้ำ ${dups}</span>`:""}</span></div>
      <span style="flex:1"></span>
      ${top&&top.id!==sch.id?`<button class="btn2" data-pp="top">ไปแผ่น top “${esc(top.name)}”</button>`:""}
      <button class="btn2" data-pp="auto" title="เติมเฉพาะขาที่ยังไม่ได้เลือก">✨ จัดขาที่เหลืออัตโนมัติ</button>
      <button class="btn2" data-pp="reset" title="ล้างแล้วจัดใหม่ทั้งหมด">↺ จัดใหม่ทั้งหมด</button>
      <button class="btn2" data-pp="clear">ล้าง</button>
    </div>
    ${!bits.length?`<div class="sim-note">แผ่นนี้ยังไม่มี INPUT/OUTPUT — ขาของ entity มาจากบล็อก INPUT/OUTPUT บนแผ่น${top&&top.id!==sch.id?" หรือไปที่แผ่น top":""}</div>`:
    `<div class="pp-wrap"><table class="pintbl pp-t"><tr><th>ขาใน VHDL</th><th>ทิศ</th><th>ขาบนบอร์ด</th></tr>${rows}</table></div>`}
    <div class="muted" style="font-size:11.5px;margin-top:6px">บันทึกกับแผ่นนี้ทันที · ไฟล์ .xdc ตอน “ลงบอร์ด” ใช้ขาตามนี้ · บัสเลือกทีละบิตหรือใช้ “ตั้งทั้งบัส”</div>
  </div>`;
  const commit=()=>{ snapshot(); uxSyncSimPinmap(); uxRenderPinPage(); uxStepperSoon(); };
  host.querySelectorAll("select[data-pk]").forEach(s=>s.onchange=()=>{
    sch.pinmap=sch.pinmap||{}; if(s.value) sch.pinmap[s.dataset.pk]=s.value; else delete sch.pinmap[s.dataset.pk]; commit(); });
  host.querySelectorAll("select[data-bus]").forEach(s=>s.onchange=()=>{
    const port=s.dataset.bus, w=+s.dataset.w, v=s.value; if(!v) return;
    sch.pinmap=sch.pinmap||{};
    for(let i=0;i<w;i++){ let t;
      if(v==="seg-a"||v==="seg-g"){ const L=["a","b","c","d","e","f","g","dp"]; t="seg:"+(v==="seg-a"?L[w-1-i]:L[i]); }
      else if(v==="an") t="an:"+i;
      else { const [k,s0]=v.split(":"); t=k+":"+(+s0+i); }
      sch.pinmap[`${port}[${i}]`]=t; }
    commit(); });
  host.querySelectorAll("[data-pp]").forEach(b=>b.onclick=()=>{
    const a=b.dataset.pp;
    if(a==="top"){ openSchTab(top.id); renderAll(); runSim(); uxRenderPinPage(); return; }
    if(a==="auto") uxAutoPins(sch, true);
    else if(a==="reset") uxAutoPins(sch, false);
    else if(a==="clear") sch.pinmap={};
    commit();
  });
  if(UX.highlightPins){ const miss=UX.highlightPins; let first=null;
    // the sim re-renders this page right after it opens — keep the highlight alive a moment
    clearTimeout(UX._hlT); UX._hlT=setTimeout(()=>{ UX.highlightPins=null; }, 2500);
    host.querySelectorAll("tr[data-key]").forEach(tr=>{ if(miss.includes(tr.dataset.key)){ tr.classList.add("ux-flash"); first=first||tr; } });
    if(first) first.scrollIntoView({block:"center", behavior:"smooth"}); }
}
{
  // the sim still calls renderPinPicker(tt) for combinational sheets — draw ours instead
  renderPinPicker=function(tt){ UX.lastTT=tt; uxSyncSimPinmap(); uxRenderPinPage(); };
  const _show=showSimPage;
  showSimPage=function(tab){ const r=_show.apply(this, arguments);
    if(tab==="board"||tab==="pins"){ const sch=activeSch();
      const bits=sch?uxPortBits(sch):[];
      if(bits.length && !bits.some(b=>pmGet(sch.pinmap||{},b.key))){ uxAutoPins(sch, true); snapshot(); }   // nothing mapped yet: a starting guess to edit
      uxRenderPinPage(); }
    return r; };
}
/* pins resolved per BIT, for the .xdc and the upload dialog */
function uxPinTarget(b, sch){
  const own=(sch||activeSch()||{}).pinmap||{};
  return pmGet(own,b.key) || (b.bit==null ? autoSpecialTarget(b.port, b.dir) : null);
}
uxXdcBody=function(){
  const sch=activeSch(); let x="", clk=false; const miss=[];
  const bits=uxPortBits(sch);
  ["in","out"].forEach(dir=>{
    bits.filter(b=>b.dir===dir).forEach(b=>{ const t=uxPinTarget(b, sch), port=b.bit==null?b.port:`{${b.vhdl}}`;
      if(!t){ miss.push(b.key); x+=`## ${b.key}: ยังไม่ได้เลือกขา (หน้า “เลือกขา”)\n`; return; }
      // the label on its OWN line: XDC is Tcl, where `#` starts a comment only at the start of a
      // command — "[get_ports x]   ## SW 0" hands "##", "SW", "0" to set_property as arguments,
      // the command fails and Vivado ends with every port unconstrained (NSTD-1 / UCIO-1)
      x+=`## ${pinTargetLabel(t)}\nset_property -dict {PACKAGE_PIN ${BOARD_PINS[t]||"?"} IOSTANDARD LVCMOS33} [get_ports ${port}]\n`;
      if(t==="clk" && !clk){ clk=true; x+=`create_clock -period 20.000 -name sys_clk [get_ports ${port}]\n`; } });
    x+="\n"; });
  UX.xdcMissing=miss;
  return x;
};
uxUploadRows=function(){
  const sch=activeSch();
  return uxPortBits(sch).map(b=>{ const t=uxPinTarget(b, sch);
    return `<tr><td style="text-align:left">${esc(b.bit==null?b.port:`${b.port}(${b.bit})`)}</td><td>${b.dir==="in"?"IN":"OUT"}</td><td style="text-align:left;${t?"":"color:var(--warn)"}">${t?esc(pinTargetLabel(t)):"ยังไม่ได้เลือก"}</td></tr>`; }).join("");
};
/* stepper counts bits too */
sheetPorts=function(sch){ return uxPortBits(sch).map(b=>({name:b.key, dir:b.dir})); };
{
  const _dlg=openUploadDialog;
  openUploadDialog=function(){ const r=_dlg.apply(this, arguments);
    const miss=UX.xdcMissing||[], dlg=[...document.querySelectorAll(".modal-bg")].pop(), body=dlg&&dlg.querySelector(".modal-body");
    if(body && miss.length){
      body.insertAdjacentHTML("afterbegin", `<div class="ux-need">⚠ ยังไม่ได้เลือกขา ${miss.length} ขา (${esc(miss.slice(0,6).join(", "))}${miss.length>6?" …":""}) — ในไฟล์ .xdc จะเป็นคอมเมนต์ไว้ Vivado จะ error ตอน build <button class="btn2" type="button" data-pp-go>ไปเลือกขา</button></div>`);
      const go=body.querySelector("[data-pp-go]"); if(go) go.onclick=()=>{ dlg.remove(); UX.highlightPins=miss; setStage("pins"); };
    }
    return r; };
}

/* pin maps are keyed by the VHDL port name (sanId: lower case). Older files and the first
   lab templates used the name as typed ("P", "Walk") — read those too, and migrate on sight. */
function pmGet(own, name){
  if(!own||name==null) return undefined;
  if(own[name]) return own[name];
  const k=sanId(String(name).replace(/\[(\d+)\]$/,"")) + (String(name).match(/\[\d+\]$/)||[""])[0];
  if(own[k]) return own[k];
  const low=String(name).toLowerCase(); const hit=Object.keys(own).find(x=>x.toLowerCase()===low);
  return hit?own[hit]:undefined;
}
function uxNormPinmap(sch){
  const own=sch&&sch.pinmap; if(!own) return;
  uxPortBits(sch).forEach(b=>{ if(own[b.key]) return; const v=pmGet(own,b.key); if(v){
    Object.keys(own).forEach(x=>{ if(x!==b.key && x.toLowerCase()===b.key.toLowerCase()) delete own[x]; }); own[b.key]=v; } });
}
/* Whatever changes the pins from OUTSIDE the page (Claude over MCP, Undo/Redo) must show on it:
   the page used to be drawn once, so it kept listing the old pins while the sheet held the new
   ones ("หน้าจัดพินไม่ซิงค์อัตโนมัติ"). The board page's pin summary follows the same way. */
function uxRefreshPages(){
  try{ if(document.querySelector("#simPage.show.sv-pins")){ uxSyncSimPinmap(); uxRenderPinPage(); } }catch(e){ console.warn("pin page", e); }
  try{ if(document.querySelector("#boardPage.show") && typeof brdRefresh==="function") brdRefresh(); }catch(e){ console.warn("board page", e); }
}
{
  const _undo=undo, _redo=redo;
  undo=function(){ const r=_undo.apply(this, arguments); uxRefreshPages(); return r; };
  redo=function(){ const r=_redo.apply(this, arguments); uxRefreshPages(); return r; };
}
