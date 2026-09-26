/* ===== 9. ลงบอร์ด inside the editor ======================================================
   Under the desktop app the last pipeline step is a page of its own: check the pins, build the
   .bit with Vivado and load it onto the board (the launcher runs Vivado / openFPGALoader, see
   launcher/board.py) — no second program, no copying files around. Opened from disk (no app)
   the step keeps the old dialog that downloads .vhd + .xdc.
   Also: ?view=topdown / ?view=board open that view on start (the launcher's Home buttons). */
const BRD = {tools:null, since:0, timer:null, top:"", sheet:null};

async function brdTools(){
  if(!/^https?:/.test(location.protocol)) return null;
  try{ const r=await fetch("/api/board/tools"); if(!r.ok) return null; return await r.json(); }catch(_){ return null; }
}
function brdProject(){ return sanId(($("#projectName")||{}).value||state.project.name||"design")||"design"; }
/* the design that goes on the board: the top sheet (VHDL is generated from it) */
function brdSheet(){ return state.project.schematics[state.project.topId] || activeSch(); }
function brdDesign(){
  const sch=brdSheet(); if(!sch) return null;
  if(state.activeId!==sch.id){ try{ openSchTab(sch.id); renderAll(); }catch(_){} }
  const pb=uxPortBits(sch);                             // nothing mapped yet: the pin page's starting guess
  if(pb.length && !pb.some(b=>pmGet(sch.pinmap||{},b.key))){ uxAutoPins(sch, true); snapshot(); }
  const all=generateAllVhdl(), names=Object.keys(all);
  const top=names.find(n=>n.toLowerCase()===sanId(sch.name).toLowerCase()) || names[names.length-1] || sanId(sch.name);
  const body=uxXdcBody();
  const bits=uxPortBits(sch).map(b=>({key:b.key, dir:b.dir, t:uxPinTarget(b, sch)}));
  return {sch, top, vhdl:bundleAll(all)+layoutStamp(), xdc:"## EDGE Spartan-7 (XC7S15 FTGB196) — Schematic Studio\n\n"+body,
          missing:(UX.xdcMissing||[]).slice(), bits,
          warns:names.flatMap(n=>((all[n]&&all[n].warns)||[]).map(w=>n+": "+w))};
}

function brdEnsurePage(){
  let pg=$("#boardPage"); if(pg) return pg;
  pg=document.createElement("div"); pg.id="boardPage"; pg.className="sim-page brd-page";
  pg.innerHTML=`<div class="sim-top">
      <button class="btn2" data-brd="close">← กลับไปวาดวงจร</button>
      <b>ลงบอร์ด</b><span class="muted" id="brdSheet"></span><span class="grow"></span>
      <span class="muted" id="brdTools"></span>
    </div>
    <div class="brd-body">
      <div class="brd-col">
        <section class="brd-card"><h3><span class="brd-n">1</span> ขาบนบอร์ด <span class="muted" id="brdPinSum"></span>
          <button class="btn2" data-brd="pins">แก้ขา</button></h3>
          <div class="brd-pins" id="brdPins"></div><div id="brdWarn"></div></section>
        <section class="brd-card"><h3><span class="brd-n">2</span> สร้างไฟล์ .bit <span class="muted">Vivado · ราว 1 นาที</span></h3>
          <div class="brd-row"><button class="btn btn-primary" data-brd="build">⚙ สร้าง .bit</button>
            <span class="muted" id="brdBit"></span></div></section>
        <section class="brd-card"><h3><span class="brd-n">3</span> โหลดลงบอร์ด <span class="muted">เสียบสาย USB ของบอร์ดก่อน</span></h3>
          <div class="brd-row">
            <button class="btn btn-primary" data-brd="sram" title="เร็ว · หายเมื่อถอดปลั๊ก — ใช้ตอนทดสอบ">▶ โหลดลงบอร์ด (ชั่วคราว)</button>
            <button class="btn" data-brd="flash" title="ช้ากว่า · อยู่ถาวรแม้ถอดปลั๊ก — เขียนซ้ำได้จำกัด">💾 เขียนถาวร (Flash)</button>
            <button class="btn" data-brd="detect">ตรวจหาบอร์ด</button>
          </div>
          <details class="brd-adv"><summary>ตั้งค่าเพิ่ม</summary>
            <label class="muted">สาย (cable) <select id="brdCable"></select></label>
            <div class="brd-row" style="margin-top:8px">
              <button class="btn2" data-brd="files">บันทึก .vhd + .xdc ลงโฟลเดอร์โปรเจกต์</button>
              <button class="btn2" data-brd="legacy">เปิด FPGA Builder แบบเดิม</button></div>
          </details></section>
      </div>
      <div class="brd-logcol">
        <div class="brd-status" id="brdStatus">พร้อม</div>
        <div class="brd-hint" id="brdHint" hidden></div>
        <pre class="brd-log" id="brdLog"></pre>
      </div>
    </div>`;
  document.body.appendChild(pg);
  pg.addEventListener("click", e=>{ const b=e.target.closest("[data-brd]"); if(!b) return; brdAct(b.dataset.brd); });
  return pg;
}
function brdShow(on){ const pg=brdEnsurePage(); pg.classList.toggle("show", on); if(!on){ clearInterval(BRD.timer); BRD.timer=null; setStage("draw", true); } }

async function openBoardPage(){
  const t=await brdTools();
  if(!t) return false;                                  // no app: caller falls back to the download dialog
  BRD.tools=t; brdEnsurePage();
  const cab=$("#brdCable"); if(cab && !cab.options.length) cab.innerHTML=(t.cables||["ft2232"]).map(c=>`<option>${esc(c)}</option>`).join("");
  $("#brdTools").innerHTML=(t.vivado?'<span class="ok">● Vivado</span>':'<span class="bad">● ไม่พบ Vivado</span>')+" · "
    +(t.openfpgaloader?'<span class="ok">● openFPGALoader</span>':'<span class="bad">● ไม่พบ openFPGALoader</span>');
  brdRefresh(); brdShow(true); setStage("upload", true);
  brdPoll(true);
  return true;
}
function brdRefresh(){
  const d=brdDesign(); if(!d) return;
  BRD.top=d.top; $("#brdSheet").textContent="แผ่น "+d.sch.name+" · entity "+d.top;
  const ok=d.bits.filter(b=>b.t).length;
  $("#brdPinSum").textContent=`${ok}/${d.bits.length} ขา`;
  $("#brdPins").innerHTML=d.bits.length?d.bits.map(b=>`<div class="brd-pin ${b.t?"":"miss"}"><b>${esc(b.key)}</b><span>${b.dir==="in"?"IN":"OUT"}</span><em>${b.t?esc(pinTargetLabel(b.t)):"ยังไม่ได้เลือก"}</em></div>`).join(""):'<div class="muted">วงจรนี้ยังไม่มี INPUT / OUTPUT</div>';
  $("#brdWarn").innerHTML=(d.missing.length?`<div class="ux-need">⚠ ยังไม่ได้เลือกขา ${d.missing.length} ขา — Vivado จะ build ไม่ผ่าน <button class="btn2" data-brd="pins">ไปเลือกขา</button></div>`:"")
    +(d.warns.length?`<div class="brd-w">${d.warns.slice(0,4).map(w=>"⚠ "+esc(w)).join("<br>")}</div>`:"");
  try{ uxRenderStepper(); }catch(_){}                    // pins may have just been guessed
  const hasBit=BRD.lastBit&&BRD.lastBit.top===d.top;
  $("#brdBit").textContent=hasBit?("ได้ "+d.top+".bit แล้ว"):"";
}
async function brdPost(path, body){
  try{ const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})}); return await r.json(); }
  catch(e){ return {ok:false, error:e.message}; }
}
async function brdAct(a){
  if(a==="close") return brdShow(false);
  if(a==="pins"){ brdShow(false); UX.highlightPins=(UX.xdcMissing||[]).slice(); setStage("pins"); return; }
  const d=brdDesign(); if(!d) return;
  const proj=brdProject(), cable=($("#brdCable")||{}).value||"ft2232";
  let r;
  if(a==="build"){
    if(d.missing.length && !confirm(`ยังไม่ได้เลือกขา ${d.missing.length} ขา (${d.missing.slice(0,5).join(", ")}) — Vivado จะ error\nbuild ต่อไหม?`)) return;
    brdLog(true); r=await brdPost("/api/board/build",{project:proj, top:d.top, vhdl:d.vhdl, xdc:d.xdc});
  } else if(a==="sram"||a==="flash"){
    if(a==="flash" && !confirm("เขียนลง Flash — วงจรจะอยู่ถาวรแม้ถอดปลั๊ก แต่ Flash เขียนซ้ำได้จำนวนจำกัด\nแนะนำให้ทดสอบด้วย “โหลดลงบอร์ด (ชั่วคราว)” ก่อน · เขียนเลยไหม?")) return;
    brdLog(true); r=await brdPost("/api/board/program",{project:proj, top:d.top, mode:a, cable});
  } else if(a==="detect"){ brdLog(true); r=await brdPost("/api/board/detect",{cable}); }
  else if(a==="stop"){ r=await brdPost("/api/board/stop",{}); }
  else if(a==="files"){
    try{ const x=await MCP_OPS.export_files({what:["vhdl","xdc","project"]}); toast("บันทึกแล้ว: "+(x.vhdl||""),"ok",4000); }catch(e){ toast("บันทึกไม่ได้: "+e.message,"warn"); } return;
  } else if(a==="legacy"){
    try{ await MCP_OPS.export_files({what:["vhdl","xdc"]}); }catch(_){}
    r=await brdPost("/api/fpga_builder",{}); if(r&&r.ok) toast("เปิด FPGA Builder แล้ว — ไฟล์ .vhd/.xdc อยู่ในโฟลเดอร์โปรเจกต์","ok",4500); else toast((r&&r.error)||"เปิดไม่ได้","warn"); return;
  }
  if(r && !r.ok){ $("#brdStatus").className="brd-status bad"; $("#brdStatus").textContent=r.error||"ทำไม่ได้"; return; }
  brdPoll(false);
}
function brdLog(clear){ if(clear){ $("#brdLog").textContent=""; BRD.since=0; $("#brdHint").hidden=true; } }
function brdPoll(once){
  clearInterval(BRD.timer); BRD.timer=null;
  const tick=async()=>{
    let s; try{ s=await (await fetch("/api/board/status?since="+BRD.since)).json(); }catch(_){ return; }
    if(s.lines && s.lines.length){ const lg=$("#brdLog"); lg.textContent+=s.lines.join("\n")+"\n"; lg.scrollTop=lg.scrollHeight; }
    BRD.since=s.next||0;
    const st=$("#brdStatus"), what={build:"สร้าง .bit",program:"โหลดลงบอร์ด",detect:"ตรวจหาบอร์ด"}[s.kind]||"";
    const running=s.state==="running";
    st.className="brd-status "+({ok:"ok",error:"bad",stopped:"bad",running:"run"}[s.state]||"");
    st.innerHTML=running?`⏳ กำลัง${what}… ${Math.round(s.elapsed||0)} วิ <button class="btn2" data-brd="stop">หยุด</button>`
      : s.state==="ok"?`✓ ${what}สำเร็จ`+(s.result&&s.result.saved?` · เก็บไว้ที่ ${esc(s.result.saved)}`:"")
      : s.state==="error"?`✗ ${what}ไม่สำเร็จ`: s.state==="stopped"?"หยุดแล้ว":"พร้อม";
    const h=$("#brdHint"); if(s.hint){ h.hidden=false; h.textContent=s.hint; } else if(running) h.hidden=true;
    if(s.kind==="build" && s.state==="ok" && s.result){ BRD.lastBit=s.result; const b=$("#brdBit"); if(b) b.textContent="ได้ "+s.result.top+".bit แล้ว → ขั้นที่ 3"; }
    $$("#boardPage [data-brd=build],#boardPage [data-brd=sram],#boardPage [data-brd=flash],#boardPage [data-brd=detect]").forEach(b=>b.disabled=running);
    if(!running && BRD.timer){ clearInterval(BRD.timer); BRD.timer=null; }
  };
  tick(); if(!once) BRD.timer=setInterval(tick, 700);
}
{
  const _up=pipelineUpload;
  pipelineUpload=async function(){ if(await openBoardPage()) return; return _up.apply(this, arguments); };
  document.addEventListener("keydown", e=>{ if(e.key==="Escape" && $("#boardPage.show")) brdShow(false); });
}
/* ?view=topdown | board — the launcher's Home buttons open straight into that view */
(function(){
  const v=new URLSearchParams(location.search).get("view"); if(!v) return;
  setTimeout(()=>{ document.querySelectorAll(".modal-bg").forEach(m=>m.remove());
    if(v==="topdown") openTopdownWithSheet();
    else if(v==="board") setStage("upload"); }, 900);
})();
