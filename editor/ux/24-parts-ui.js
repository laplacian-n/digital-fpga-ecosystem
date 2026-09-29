/* ===== 24. The part library in the Modules tab ===================================================
   The checked parts (22-parts.js) were reachable only through Claude / the local agent. The
   Modules tab now opens with them, grouped, above the user's own modules: click one → a small form
   (size, bus, options, the ports it will have) → "วางเป็นบล็อก" on the sheet on screen, or
   "เปิดเป็นแผ่นใหม่". The user's modules below carry a badge: ✓ ตรวจแล้ว / ยังไม่ได้ตรวจ. */
const PARTS_UI = { open:{} };
function partsMatches(q){
  const t=String(q||"").trim().toLowerCase();
  return Object.entries(PARTS).filter(([k,P])=>!t || t.split(/\s+/).every(w=>(k+" "+P.label+" "+P.desc+" "+P.group).toLowerCase().includes(w)));
}
function partsSectionHtml(){
  const q=(state.modSearch||"").trim(), hits=partsMatches(q);
  if(!hits.length) return "";
  const groups={}; hits.forEach(([k,P])=>(groups[P.group]=groups[P.group]||[]).push([k,P]));
  const open=g=>q || PARTS_UI.open[g];
  return `<div class="pt-sec"><div class="pt-h">ชิ้นส่วนสำเร็จรูป <span class="pt-ok">✓ ตรวจทุกครั้งที่สร้าง</span></div>`+
    Object.entries(groups).map(([g,L])=>`<div class="pt-grp ${open(g)?"open":""}"><button class="pt-gh" data-ptgrp="${esc(g)}">${open(g)?"▾":"▸"} ${esc(g)} <span class="muted">${L.length}</span></button>
      <div class="pt-list">${L.map(([k,P])=>`<button class="pt-item" data-part="${k}" title="${esc(P.desc)}"><b>${esc(P.label)}</b><small>${esc(P.desc)}</small></button>`).join("")}</div></div>`).join("")+
    `</div><div class="pt-h pt-mine">โมดูลของฉัน</div>`;
}
{
  const _cards=moduleCardsHtml;
  moduleCardsHtml=function(){
    let h=_cards.apply(this, arguments);
    // the verified badge on the user's own modules
    loadModules();
    Object.values(state.modules||{}).forEach(m=>{
      const badge=m.verified && !/^not verified/.test(m.verified) ? `<span class="pt-badge ok" title="${esc(m.verified)}">✓ ตรวจแล้ว</span>` : `<span class="pt-badge" title="ยังไม่ได้ตรวจเทียบกับข้อกำหนด">ยังไม่ได้ตรวจ</span>`;
      h=h.replace(`<div class="mod-name" title="${esc(m.name)}">${esc(m.name)}</div>`, `<div class="mod-name" title="${esc(m.name)}">${esc(m.name)} ${badge}</div>`);
    });
    return partsSectionHtml()+h;
  };
  const _pane=renderModulesPane;
  renderModulesPane=function(){ const r=_pane.apply(this, arguments);
    const si=$("#modSearch"); if(si) si.placeholder="🔍 ค้นหาชิ้นส่วน / โมดูล (ชื่อ / คำอธิบาย / ชื่อขา)";
    return r; };
  document.addEventListener("click", ev=>{
    const g=ev.target.closest && ev.target.closest("[data-ptgrp]");
    if(g){ const k=g.dataset.ptgrp; PARTS_UI.open[k]=!PARTS_UI.open[k]; renderModCards(); return; }
    const it=ev.target.closest && ev.target.closest("[data-part]");
    if(it) partDialog(it.dataset.part);
  });
  try{ renderModulesPane(); }catch(_){}
}
/* the form: parameters, ports preview, place / open */
function partDialog(kind){
  const P=PARTS[kind]; if(!P) return;
  const params=P.params||{};
  const field=(k,s)=>{
    const lab={n:"ขนาด (N)", cin:"มีขา cin", en:"มีขา enable", odd:"parity คี่", active_low:"active-low (บอร์ด EDGE)", output:"ขาออก"}[k]||k;
    if(s.bool) return `<label class="pt-f"><input type="checkbox" data-pp="${k}" ${s.def?"checked":""}> ${lab}</label>`;
    if(s.options) return `<label class="pt-f">${lab} <select data-pp="${k}">${s.options.map(o=>`<option ${o===s.def?"selected":""}>${o}</option>`).join("")}</select></label>`;
    return `<label class="pt-f">${lab} <input type="number" data-pp="${k}" value="${s.def}" min="${s.min}" max="${s.max}" style="width:${s.max>1e6?120:70}px"> <span class="muted">${s.min}–${s.max}</span></label>`;
  };
  const m=uxModal(esc(P.label), `
    <div class="muted" style="margin-bottom:8px">${esc(P.desc)}</div>
    <div class="pt-form">${Object.entries(params).map(([k,s])=>field(k,s)).join("")}
      <label class="pt-f"><input type="checkbox" data-pp="bus"> ขาแบบบัส (a3..a0 → a[3:0])</label>
      <label class="pt-f">ชื่อแผ่น <input type="text" data-pp="sheet" placeholder="ไม่ใส่ = ตั้งให้" spellcheck="false" style="width:140px"></label></div>
    <div class="pt-ports" id="ptPorts"></div>
    <div class="muted" style="font-size:11.5px;margin-top:8px">สร้างแล้วระบบจำลองเทียบกับโมเดลอ้างอิงให้ทุกครั้ง — ถ้าไม่ตรงจะไม่วาดออกมา</div>`,
    {width:480, foot:`<button class="btn" id="ptOpen">เปิดเป็นแผ่นใหม่</button><button class="btn btn-primary" id="ptPlace">วางเป็นบล็อกบนแผ่นนี้</button>`});
  const read=()=>{ const a={kind};
    m.querySelectorAll("[data-pp]").forEach(e=>{ const k=e.dataset.pp;
      if(e.type==="checkbox") a[k]=e.checked; else if(e.type==="number") a[k]=+e.value; else if(e.value.trim()) a[k]=e.value.trim(); });
    if(!a.sheet) delete a.sheet; return a; };
  const preview=()=>{ const el=m.querySelector("#ptPorts"); try{ const a=read(); const p=partParams(kind, a); const pp=P.ports(p);
      const fmt=o=>Object.entries(o).filter(([,w])=>w>0).map(([b,w])=>w>1?(a.bus?`${b}[${w-1}:0]`:`${b}${w-1}..${b}0`):b).join(", ");
      el.innerHTML=`<b>ขาเข้า</b> ${esc(fmt(pp.in))}<br><b>ขาออก</b> ${esc(fmt(pp.out))}`; el.classList.remove("bad"); return true; }
    catch(e){ el.textContent=e.message; el.classList.add("bad"); return false; } };
  m.addEventListener("input", preview); preview();
  const go=async place=>{ if(!preview()) return;
    const back=activeSch(), a=read();
    // a big part (ALU, a 4-digit counter) takes seconds to draw and check: say so, and let it paint first
    m.querySelectorAll(".modal-foot button").forEach(b=>b.disabled=true);
    const el=m.querySelector("#ptPorts"); if(el) el.insertAdjacentHTML("afterend", '<div class="muted pt-busy">⏳ กำลังสร้างและตรวจเทียบโมเดลอ้างอิง… ชิ้นใหญ่ใช้เวลาหลายวินาที</div>');
    await new Promise(r=>setTimeout(r, 60));
    try{
      const r=MCP_OPS.build_part(a);
      m.close();
      if(place && back && back.id!==(Object.values(state.project.schematics).find(s=>s.name===r.sheet)||{}).id){
        openSchTab(back.id);
        const sub=Object.values(state.project.schematics).find(s=>s.name===r.sheet);
        const why=subBlockBlockedWhy(sub.id, back.id);
        if(why){ toast(why,"warn",4000); return; }
        MCP_OPS.add_component({sheet:back.name, type:"block:"+sub.name});     // a free spot beside the drawing, not on top of it
        try{ const b=activeSch().components.filter(c=>c.type==="SCH:"+sub.id).pop(); if(b) focusComp(back.id, b.id); }catch(_){}
        toast(`วาง ${P.label} (${r.sheet}) เป็นบล็อกแล้ว — ตรวจแล้วถูกต้อง: ${r.verified.method}`,"ok",4500);
      } else toast(`สร้าง ${P.label} ในแผ่น ${r.sheet} แล้ว — ตรวจแล้วถูกต้อง: ${r.verified.method}`,"ok",4500);
    }catch(e){ toast("สร้างไม่ได้: "+e.message+(e.hint?" — "+e.hint:""),"err",6000);
      m.querySelectorAll(".modal-foot button").forEach(b=>b.disabled=false); m.querySelectorAll(".pt-busy").forEach(x=>x.remove()); }
  };
  m.querySelector("#ptPlace").onclick=()=>go(true);
  m.querySelector("#ptOpen").onclick=()=>go(false);
}
