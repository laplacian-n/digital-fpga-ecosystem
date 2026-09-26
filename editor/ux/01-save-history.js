/* =========================================================================
   UX LAYER — added on top of the editor without rewriting it. It wraps a few
   global functions (snapshot, saveProjectToFile, deserialize, …) and adds its
   own UI. Everything here reads the same `state` the editor uses.
   ========================================================================= */
const UX = { savedHash:null, curHash:null, dirty:false, expectFileLoad:false, restoring:false };
const escA = s => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
function uxHash(str){ let h=2166136261>>>0; for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619)>>>0; } return h.toString(36)+":"+str.length; }
function uxLS(k, v){ try{ if(v===undefined) return localStorage.getItem(k); if(v===null) localStorage.removeItem(k); else localStorage.setItem(k, v); }catch(_){ return null; } }
function uxModal(title, bodyHtml, opts){
  opts=opts||{};
  const m=document.createElement("div"); m.className="modal-bg";
  m.innerHTML=`<div class="modal" style="${opts.width?`width:${opts.width}px`:""}"><h2>${title}<button class="close" title="ปิด">×</button></h2>
    <div class="modal-body">${bodyHtml}</div>${opts.foot?`<div class="modal-foot">${opts.foot}</div>`:""}</div>`;
  const close=()=>{ m.remove(); document.removeEventListener("keydown",onKey,true); if(opts.onClose) opts.onClose(); };
  const onKey=e=>{ if(e.key==="Escape"){ e.stopPropagation(); close(); } };
  m.addEventListener("mousedown",e=>{ if(e.target===m && !opts.sticky) close(); });
  m.querySelector(".close").onclick=close;
  document.addEventListener("keydown",onKey,true);
  document.body.appendChild(m);
  m.close=close;
  return m;
}

/* ---------- 1a. saved / unsaved tracking ---------- */
function uxWorkHash(){ try{ return uxHash(serialize()); }catch(_){ return null; } }
function uxMarkSaved(){
  UX.savedHash=UX.curHash=uxWorkHash();
  uxLS("schstudio.savedHash", UX.savedHash);
  uxLS("schstudio.savedAt", String(Date.now()));
  uxSetDirty(false);
}
function uxSetDirty(d){
  UX.dirty=d;
  const chip=$("#saveChip"); if(!chip) return;
  const at=+uxLS("schstudio.savedAt")||0;
  const empty=!uxHasWork();
  chip.classList.toggle("dirty", d && !empty);
  chip.classList.toggle("clean", !d || empty);
  if(d && !empty){ chip.innerHTML='<span class="dot"></span>ยังไม่บันทึก'; chip.title="งานล่าสุดอยู่แค่ในเบราว์เซอร์ (autosave) — กดเพื่อบันทึกเป็นไฟล์ (Ctrl+S)"; }
  else if(at){ const t=new Date(at); chip.innerHTML='<span class="dot"></span>บันทึกแล้ว '+t.toLocaleTimeString("th-TH",{hour:"2-digit",minute:"2-digit"}); chip.title="บันทึกเป็นไฟล์ล่าสุด "+t.toLocaleString("th-TH"); }
  else { chip.innerHTML='<span class="dot"></span>ไม่มีงานค้าง'; chip.title="ยังไม่มีงานที่ต้องบันทึก"; }
}
/* the editor opens on a demo half adder — that alone is not "work" worth a warning */
function uxHasWork(){
  try{ return Object.values(state.projects||{}).some(p=>Object.values(p.schematics||{}).some(s=>(s.components||[]).length)); }catch(_){ return true; }
}
let _uxDirtyT=null;
function uxCheckDirty(){
  clearTimeout(_uxDirtyT);
  _uxDirtyT=setTimeout(()=>{ UX.curHash=uxWorkHash(); uxSetDirty(UX.curHash!==UX.savedHash); }, 600);
}
{
  const _snapshot=snapshot;
  snapshot=function(){ const r=_snapshot.apply(this, arguments); uxCheckDirty(); return r; };
  const _undo=undo, _redo=redo;
  undo=function(){ const r=_undo.apply(this, arguments); uxCheckDirty(); return r; };
  redo=function(){ const r=_redo.apply(this, arguments); uxCheckDirty(); return r; };
  const _save=saveProjectToFile;
  saveProjectToFile=function(){ const r=_save.apply(this, arguments); uxMarkSaved(); uxTimelineAdd("บันทึกเป็นไฟล์", true); return r; };
  const _open=openProjectFromFile;
  openProjectFromFile=function(){ UX.expectFileLoad=true; return _open.apply(this, arguments); };
  const _deser=deserialize;
  deserialize=function(json){
    // opening a file replaces what is on screen — keep a way back first
    if(!UX.restoring && uxHasWork()) uxTimelineAdd("ก่อนเปิดไฟล์/โปรเจกต์อื่น", true);
    const r=_deser.apply(this, arguments);
    if(UX.expectFileLoad){ UX.expectFileLoad=false; uxMarkSaved(); } else uxCheckDirty();
    return r;
  };
  $("#projectName").addEventListener("change", uxCheckDirty);
}
window.addEventListener("beforeunload", e=>{
  if(UX.dirty && uxHasWork()){ e.preventDefault(); e.returnValue=""; return ""; }
});

/* ---------- 1b. timeline: snapshots you can jump back to ---------- */
const TL = { db:null, lastHash:null, timer:null, MAX:60 };
function tlDb(){
  if(TL.db) return Promise.resolve(TL.db);
  return new Promise((res, rej)=>{
    let rq; try{ rq=indexedDB.open("schstudio-timeline", 1); }catch(e){ return rej(e); }
    rq.onupgradeneeded=()=>{ const db=rq.result; if(!db.objectStoreNames.contains("snaps")) db.createObjectStore("snaps",{keyPath:"id",autoIncrement:true}); };
    rq.onsuccess=()=>{ TL.db=rq.result; res(TL.db); };
    rq.onerror=()=>rej(rq.error);
  });
}
function tlTx(mode, fn){
  return tlDb().then(db=>new Promise((res, rej)=>{
    const tx=db.transaction("snaps", mode), st=tx.objectStore("snaps"); let out;
    Promise.resolve(fn(st, v=>{ out=v; })).catch(rej);
    tx.oncomplete=()=>res(out); tx.onerror=()=>rej(tx.error);
  }));
}
function tlCounts(){
  let c=0, w=0, s=0;
  Object.values(state.projects||{}).forEach(p=>Object.values(p.schematics||{}).forEach(sch=>{ s++; c+=(sch.components||[]).filter(x=>x.type!=="JUNCTION").length; w+=(sch.wires||[]).length; }));
  return {c, w, s};
}
/* force=true: a checkpoint before something drastic, taken even if nothing changed since the last one */
function uxTimelineAdd(reason, force){
  if(!uxHasWork()) return Promise.resolve();
  let data; try{ data=serialize(); }catch(_){ return Promise.resolve(); }
  const h=uxHash(data);
  if(!force && h===TL.lastHash) return Promise.resolve();
  if(force && h===TL.lastHash && reason===TL.lastReason) return Promise.resolve();
  TL.lastHash=h; TL.lastReason=reason;
  const rec={t:Date.now(), reason, name:(state.project&&state.project.name)||"", counts:tlCounts(), hash:h, data};
  return tlTx("readwrite", st=>{ st.add(rec); }).then(tlTrim).catch(e=>console.warn("timeline",e));
}
function tlList(){
  return tlTx("readonly", (st, done)=>new Promise(res=>{
    const out=[]; const cur=st.openCursor(null,"prev");
    cur.onsuccess=()=>{ const c=cur.result; if(!c){ done(out); return res(); }
      const v=c.value; out.push({id:v.id,t:v.t,reason:v.reason,name:v.name,counts:v.counts}); c.continue(); };
  }));
}
function tlGet(id){ return tlTx("readonly", (st, done)=>new Promise(res=>{ const r=st.get(id); r.onsuccess=()=>{ done(r.result); res(); }; })); }
function tlTrim(){
  return tlList().then(list=>{
    // keep every checkpoint of the last 2 hours, then at most MAX overall
    const old=list.filter((x,i)=>i>=TL.MAX || (i>=20 && Date.now()-x.t>7*864e5));
    if(!old.length) return;
    return tlTx("readwrite", st=>{ old.forEach(x=>st.delete(x.id)); });
  });
}
function tlStart(){
  clearInterval(TL.timer);
  TL.timer=setInterval(()=>uxTimelineAdd("อัตโนมัติทุก 5 นาที"), 5*60*1000);
  setTimeout(()=>uxTimelineAdd("เปิดโปรแกรม"), 3000);
}
/* checkpoint BEFORE the editor's own handler runs (capture phase) */
const TL_BEFORE = {
  "auto-route":"ก่อนจัดสายอัตโนมัติ", "relayout":"ก่อนจัดสายใหม่ทั้งแผ่น", "clear-sch":"ก่อนล้างแผ่น",
  "new-project":"ก่อนสร้างโปรเจกต์ใหม่", "import-vhdl":"ก่อนนำเข้า VHDL", "split-project":"ก่อนแยกโปรเจกต์",
  "ai-send":"ก่อนให้ AI วาด", "delete-sel":"ก่อนลบ",
};
document.addEventListener("click", ev=>{
  const a=ev.target.closest && ev.target.closest("[data-act]"); if(!a) return;
  const why=TL_BEFORE[a.dataset.act];
  if(why && (a.dataset.act!=="delete-sel" || state.selection.size>=5)) uxTimelineAdd(why, true);
}, true);
{
  const _drawIntent = typeof aiDrawIntent==="function" ? aiDrawIntent : null;
  if(_drawIntent) aiDrawIntent=function(){ uxTimelineAdd("ก่อนให้ AI วาด", true); return _drawIntent.apply(this, arguments); };
}
function tlFmt(t){
  const d=new Date(t), now=new Date();
  const hm=d.toLocaleTimeString("th-TH",{hour:"2-digit",minute:"2-digit"});
  if(d.toDateString()===now.toDateString()) return "วันนี้ "+hm;
  const y=new Date(now); y.setDate(now.getDate()-1);
  if(d.toDateString()===y.toDateString()) return "เมื่อวาน "+hm;
  return d.toLocaleDateString("th-TH",{day:"numeric",month:"short"})+" "+hm;
}
async function openTimeline(){
  await uxTimelineAdd("ตอนเปิดหน้าต่างประวัติ");
  let list=[]; try{ list=await tlList(); }catch(e){ toast("เปิดประวัติไม่ได้: "+e.message,"err"); return; }
  const rows=list.length ? list.map((x,i)=>`
      <div class="tl-row">
        <div class="tl-when">${tlFmt(x.t)}</div>
        <div class="tl-what"><b>${escA(x.reason)}</b><span>${escA(x.name)} · ${x.counts.s} แผ่น · ${x.counts.c} ชิ้น · ${x.counts.w} สาย</span></div>
        ${i===0?'<span class="tl-now">ล่าสุด</span>':`<button class="btn" data-tl="${x.id}">ย้อนไปจุดนี้</button>`}
      </div>`).join("")
    : '<div class="muted" style="padding:14px">ยังไม่มีประวัติ — จะเริ่มเก็บเมื่อมีวงจรบนแผ่น</div>';
  const m=uxModal("🕘 ประวัติย้อนเวลา",
    `<p class="muted" style="margin:0 0 10px">เก็บให้อัตโนมัติทุก 5 นาที และก่อนคำสั่งที่เปลี่ยนงานเยอะ (จัดสาย, ล้างแผ่น, เปิดไฟล์อื่น, AI วาด) · เก็บในเบราว์เซอร์นี้ ${TL.MAX} จุดล่าสุด · ย้อนแล้วกลับมาได้ เพราะจะเก็บจุดปัจจุบันไว้ก่อนเสมอ</p>
     <div class="tl-list">${rows}</div>`,
    {width:620, foot:'<button class="btn" id="tlSaveNow">เก็บจุดนี้ไว้ตอนนี้</button><button class="btn btn-primary" id="tlClose">ปิด</button>'});
  m.querySelector("#tlClose").onclick=()=>m.close();
  m.querySelector("#tlSaveNow").onclick=async()=>{ await uxTimelineAdd("เก็บเอง", true); m.close(); openTimeline(); };
  m.querySelectorAll("[data-tl]").forEach(b=>b.onclick=async()=>{
    const rec=await tlGet(+b.dataset.tl); if(!rec){ toast("ไม่พบจุดนี้แล้ว","err"); return; }
    await uxTimelineAdd("ก่อนย้อนเวลา", true);
    UX.restoring=true;
    try{ deserialize(rec.data); toast("ย้อนไปที่ "+tlFmt(rec.t)+" แล้ว — ถ้าไม่ใช่ เปิดประวัติแล้วเลือก “ก่อนย้อนเวลา”","ok",4200); }
    catch(e){ toast("ย้อนไม่ได้: "+e.message,"err"); }
    finally{ UX.restoring=false; }
    m.close();
  });
}
document.addEventListener("click", ev=>{
  const a=ev.target.closest && ev.target.closest("[data-act]"); if(!a) return;
  if(a.dataset.act==="history-open") openTimeline();
});

/* start: what is on screen now was restored from autosave — compare to the last file save */
UX.savedHash=uxLS("schstudio.savedHash");
if(new URLSearchParams(location.search).get("open")) UX.expectFileLoad=true;   // launcher opens a saved file
UX.curHash=uxWorkHash();
UX.hadSession=!!uxLS(AUTOSAVE_KEY);      // autosave only writes every 4 s, so this is last session's
if(!UX.savedHash){
  // never saved to a file: restored autosave = unsaved work; a fresh demo sheet = nothing yet
  if(!UX.hadSession) UX.savedHash=UX.curHash;
}
uxSetDirty(UX.curHash!==UX.savedHash);
tlStart();
