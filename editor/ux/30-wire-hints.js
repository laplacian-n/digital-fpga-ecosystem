/* ===== 30. Wiring hints: "cout of FA0 goes to cin of FA1" (Inspector 💡, dashed lines, MCP suggest_wires) =====
   A beginner who has placed four full adders knows they must be chained but not which pin goes
   where. The sheet already says most of it: blocks of one kind in a row pass carry-like signals
   along (x_out → x_in, cout → cin, bout → bin), a block's input named like a sheet INPUT takes
   it (clk, rst, en — and a2 or bit 2 of bus a for the block labelled …2), a sheet OUTPUT named
   like a block output (or its bit / index) takes that. Only pins that are still unconnected get
   a hint, each with a reason in Thai; one click wires it (through MCP connect, so undo works). */
function whLinked(sch, cid, pid){ return sch.wires.some(w=>(w.to.cid===cid&&w.to.pid===pid)||(w.from.cid===cid&&w.from.pid===pid)); }
function whIdx(c){ const m=/(\d+)$/.exec(c.label||""); return m ? +m[1] : null; }
function whStem(pid, kind){ const m=new RegExp("^(.*?)_?"+kind+"$","i").exec(pid); return m && m[1] ? m[1].toLowerCase() : null; }
function wireHints(sch){
  sch=sch||activeSch(); if(!sch) return [];
  const H=[], taken=new Set(), key=(c,p)=>c.id+"|"+p;
  const push=(src, dst, dstC, dstP, why, kind)=>{ if(taken.has(key(dstC,dstP))) return; taken.add(key(dstC,dstP)); H.push({from:src, to:dst, why, kind, cid:dstC.id, pid:dstP}); };
  const parts=sch.components.filter(c=>!["JUNCTION","BUSTAP","IN","OUT","VCC","GND","CONST"].includes(c.type));
  const ins=sch.components.filter(c=>c.type==="IN"), outs=sch.components.filter(c=>c.type==="OUT");
  const nm=c=>String((c.params&&c.params.name)||"").toLowerCase();
  const free=(c,p)=>p.dir==="in" && !whLinked(sch, c.id, p.id);
  const W=p=>p.width||1;
  // 1. a chain: blocks of one kind in order (label index, else left→right, top→bottom)
  const groups={}; parts.forEach(c=>(groups[c.type]=groups[c.type]||[]).push(c));
  Object.values(groups).filter(g=>g.length>1).forEach(g=>{
    const ord=g.every(c=>whIdx(c)!=null) ? g.slice().sort((a,b)=>whIdx(a)-whIdx(b)) : g.slice().sort((a,b)=>(a.x-b.x)||(a.y-b.y));
    const P=getPorts(ord[0]), pairs=[];
    P.filter(o=>o.dir==="out").forEach(o=>{ const s=whStem(o.id,"out")||whStem(o.id,"o");
      const i=s && P.find(x=>x.dir==="in" && (whStem(x.id,"in")===s || whStem(x.id,"i")===s) && W(x)===W(o)); if(i) pairs.push([o,i]); });
    for(let k=0;k+1<ord.length;k++) pairs.forEach(([o,i])=>{ const A=ord[k], B=ord[k+1];
      if(free(B,i) && !sch.wires.some(w=>w.from.cid===A.id&&w.from.pid===o.id))
        push(`${mcpName(A)}.${o.id}`, `${mcpName(B)}.${i.id}`, B, i.id, `ต่อเป็นทอด: ${o.id} ของ ${mcpName(A)} ส่งต่อไปเข้า ${i.id} ของ ${mcpName(B)} (ตัวถัดไป)`, "chain"); });
  });
  // 2. a block input named like a sheet INPUT (or bit k of it / name+k, for the block labelled …k)
  parts.forEach(c=>getPorts(c).filter(p=>free(c,p) && !taken.has(key(c,p.id))).forEach(p=>{
    const id=p.id.toLowerCase(), k=whIdx(c), alias=id==="clk"?["clk","clock"]:[id];
    // one sheet INPUT to several blocks' pin of that name only for signals every block shares
    const many=parts.filter(x=>x!==c && getPorts(x).some(q=>q.id.toLowerCase()===id && free(x,q) && !taken.has(key(x,q.id)))).length>0;
    const shared=/^(clk|clock|rst|reset|clr|clear|en|enable|ce|load|ld|sub|mode|sel|s|dir|up)$/.test(id);
    let s=(!many||shared||k==null) && ins.find(x=>alias.includes(nm(x)) && W(getPorts(x)[0])===W(p));
    if(s) return push(`${mcpName(s)}`, `${mcpName(c)}.${p.id}`, c, p.id, `ชื่อตรงกัน: INPUT ${mcpName(s)} → ขา ${p.id} ของ ${mcpName(c)}`, "name");
    if(k==null || W(p)!==1) return;
    s=ins.find(x=>[id+k, id+"_"+k].includes(nm(x)) && W(getPorts(x)[0])===1);
    if(s) return push(`${mcpName(s)}`, `${mcpName(c)}.${p.id}`, c, p.id, `บิตที่ ${k}: INPUT ${mcpName(s)} → ขา ${p.id} ของ ${mcpName(c)}`, "bit");
    s=ins.find(x=>nm(x)===id && W(getPorts(x)[0])>1 && W(getPorts(x)[0])>k);
    if(s) push(`${mcpName(s)}.o[${k}]`, `${mcpName(c)}.${p.id}`, c, p.id, `บิตที่ ${k} ของบัส ${mcpName(s)} → ขา ${p.id} ของ ${mcpName(c)}`, "bus");
  }));
  // 3. a sheet OUTPUT named like a block output (unique), or name+k / bit k of a bus OUTPUT
  outs.forEach(o=>{ const n=nm(o), w=W(getPorts(o)[0]);
    if(whLinked(sch, o.id, "i")) return;
    const hits=parts.flatMap(c=>getPorts(c).filter(p=>p.dir==="out"&&p.id.toLowerCase()===n&&W(p)===w).map(p=>({c,p})))
      .filter(({c,p})=>!sch.wires.some(x=>x.from.cid===c.id&&x.from.pid===p.id) && !H.some(h=>h.from===`${mcpName(c)}.${p.id}`));   // a carry already passed on is not the answer
    if(hits.length===1) return push(`${mcpName(hits[0].c)}.${hits[0].p.id}`, `${mcpName(o)}`, o, "i", `ชื่อตรงกัน: ${hits[0].p.id} ของ ${mcpName(hits[0].c)} → OUTPUT ${mcpName(o)}`, "name");
    const m=/^(.*?)_?(\d+)$/.exec(n);
    if(m && w===1){ const c=parts.find(x=>whIdx(x)===+m[2] && getPorts(x).some(p=>p.dir==="out"&&p.id.toLowerCase()===m[1]&&W(p)===1));
      if(c) return push(`${mcpName(c)}.${getPorts(c).find(p=>p.dir==="out"&&p.id.toLowerCase()===m[1]).id}`, `${mcpName(o)}`, o, "i", `บิตที่ ${m[2]}: ${m[1]} ของ ${mcpName(c)} → OUTPUT ${mcpName(o)}`, "bit"); }
    if(w>1 && !sch.wires.some(x=>x.to.cid===o.id)){          // bus OUTPUT: bit k from the block labelled …k
      parts.forEach(c=>{ const k=whIdx(c), p=getPorts(c).find(p=>p.dir==="out"&&p.id.toLowerCase()===n&&W(p)===1);
        if(k!=null && k<w && p && !sch.wires.some(x=>x.from.cid===c.id&&x.from.pid===p.id))
          H.push({from:`${mcpName(c)}.${p.id}`, to:`${mcpName(o)}.i[${k}]`, why:`บิตที่ ${k} ของบัส ${mcpName(o)} ← ${p.id} ของ ${mcpName(c)}`, kind:"bus", cid:o.id, pid:"i"}); });
    }
  });
  return H;
}
function whApply(hints){
  if(!hints.length) return {connected:[]};
  const r=MCP_OPS.connect({connections:hints.map(h=>[h.from, h.to])});
  try{ renderAll(); }catch(_){}
  return r;
}
/* the Inspector: hints for the selected part, or for the whole sheet when nothing is selected */
{
  const _insp=renderInspector;
  renderInspector=function(){ const r=_insp.apply(this, arguments);
    try{ const sch=activeSch(), pane=$("#inspectorPane"); if(!sch||!pane) return r;
      const sel=[...state.selection]; if(sel.length>1) return r;
      let H=wireHints(sch); if(sel.length) H=H.filter(h=>h.cid===sel[0] || h.from.split(".")[0]===mcpName(comp(sel[0],sch)||{id:sel[0]}));
      if(!H.length) return r;
      const box=document.createElement("div"); box.className="wh-box";
      box.innerHTML=`<div class="wh-h">💡 แนะนำการต่อสาย <span class="muted">(${H.length})</span></div>
        <div class="wh-list">${H.slice(0,12).map((h,i)=>`<div class="wh-i"><div><code>${esc(h.from)}</code> → <code>${esc(h.to)}</code><div class="muted">${esc(h.why)}</div></div><button class="btn2" data-wh="${i}">ต่อ</button></div>`).join("")}</div>
        ${H.length>1?`<button class="btn" data-wh="all">ต่อทั้งหมด ${H.length} เส้น</button>`:""}`;
      pane.appendChild(box);
      box.addEventListener("click", e=>{ const b=e.target.closest("[data-wh]"); if(!b) return;
        try{ const x=whApply(b.dataset.wh==="all"?H:[H[+b.dataset.wh]]); toast("ต่อแล้ว: "+x.connected.join(", "), "ok", 4000); }
        catch(err){ toast("ต่อไม่ได้: "+err.message, "warn", 6000); } });
    }catch(e){ console.warn("wire hints", e); }
    return r; };
  // dashed guide lines for the selected part's hints
  const _render=render;
  render=function(){ const r=_render.apply(this, arguments);
    try{ const sch=activeSch(), world=canvas.firstChild; if(!sch||!world||state.selection.size!==1) return r;
      const id=[...state.selection][0], c0=comp(id,sch); if(!c0) return r;
      const H=wireHints(sch).filter(h=>h.cid===id || h.from.split(".")[0]===mcpName(c0)); if(!H.length) return r;
      const layer=el("g",{class:"wh-ghost"});
      const pos=ref=>{ const b=ref.replace(/\[\d+\]$/,""), i=b.lastIndexOf("."), c=findCompRef(sch, i>0?b.slice(0,i):b) || findCompRef(sch,b);
        if(!c) return null; const p=i>0&&getPort(c,b.slice(i+1)) ? b.slice(i+1) : (getPorts(c)[0]||{}).id; return portPos(c,p); };
      H.forEach(h=>{ const a=pos(h.from), b=pos(h.to); if(!a||!b) return;
        layer.appendChild(el("path",{d:`M${a.x},${a.y} C${a.x+40},${a.y} ${b.x-40},${b.y} ${b.x},${b.y}`, class:"wh-line"})); });
      world.appendChild(layer);
    }catch(_){}
    return r; };
}
MCP_OPS.suggest_wires = a=>{
  const sch=mcpUse(a.sheet), H=wireHints(sch);
  if(a.apply && H.length){ const r=whApply(H); return {applied:r.connected, count:H.length}; }
  return {sheet:sch.name, hints:H.map(h=>({from:h.from, to:h.to, why:h.why})),
    note:H.length?"connect them with connect {connections:[[from,to],…]} or suggest_wires {apply:true}":"no unconnected pin has an obvious partner"};
};
