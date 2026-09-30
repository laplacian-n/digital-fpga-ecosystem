/* ===== 45. Board pins on the drawing, and events you can wait for ====================================
   - Once a sheet has any board pin chosen, every INPUT / OUTPUT shows its pin under it on the canvas
     (SW3, LED0, 7SEG a, หลัก 1, CLK) — red when it has none yet or shares a pin with another port, so
     a conflict or a forgotten port is seen where it is drawn, not only on the pin page.
   - get_events {wait}: waits (≤40 s) for the next edit instead of returning nothing — an outside tool
     follows the user by calling it in a loop. */
function ptagShort(t){
  if(!t) return "";
  if(t==="clk") return "CLK 50M";
  const [k,v]=t.split(":");
  return ({sw:"SW", led:"LED", pb:"ปุ่ม", seg:"7SEG ", an:"หลัก "}[k]||k)+(v!=null?v:"");
}
function ptagInfo(sch){
  const bits=uxPortBits(sch).map(b=>Object.assign({t:uxPinTarget(b, sch)}, b));
  const count={}; bits.forEach(b=>{ if(b.t) count[b.t]=(count[b.t]||0)+1; });
  const by={}; bits.forEach(b=>(by[b.port]=by[b.port]||[]).push(b));
  return {by, count};
}
{
  const _render=render;
  render=function(){ const r=_render.apply(this, arguments);
    try{ const sch=activeSch(), world=canvas.firstChild;
      if(!sch || !world || !sch.pinmap || !Object.keys(sch.pinmap).length) return r;
      const {by, count}=ptagInfo(sch), layer=el("g",{class:"pin-tags"});
      sch.components.filter(c=>c.type==="IN"||c.type==="OUT").forEach(c=>{
        const L=by[sanId(c.params.name)] || by[c.params.name]; if(!L) return;
        const miss=L.filter(b=>!b.t), clash=L.filter(b=>b.t && count[b.t]>1);
        let txt;
        if(L.length===1) txt=L[0].t ? ptagShort(L[0].t) : "ยังไม่มีขา";
        else { const set=L.filter(b=>b.t); txt=set.length===L.length ? (()=>{ const k=new Set(set.map(b=>b.t.split(":")[0])); const v=set.map(b=>b.t.split(":")[1]);
            return k.size===1 && v.every(x=>/^\d+$/.test(x)) ? `${ptagShort(set[0].t.split(":")[0]+":").trim()}${v[0]}–${v[v.length-1]}` : `${set.length} ขา`; })()
          : `ยังไม่มีขา ${miss.length}/${L.length}`; }
        if(clash.length) txt+=" ⚠ ซ้ำ";
        const sz=getSize(c), t=el("text",{x:c.x+sz.w/2, y:c.y+sz.h+13, class:"pin-tag"+(miss.length||clash.length?" bad":""), "text-anchor":"middle"});
        t.textContent=txt;
        const tip=el("title",{}); tip.textContent=L.map(b=>`${b.key} → ${b.t?pinTargetLabel(b.t):"ยังไม่ได้เลือกขา"}${b.t&&count[b.t]>1?" (ใช้ร่วมกับขาอื่น)":""}`).join("\n");
        t.appendChild(tip); layer.appendChild(t); });
      world.appendChild(layer);
    }catch(_){}
    return r; };
}
{
  const _ev=MCP_OPS.get_events;
  MCP_OPS.get_events=async a=>{
    const since=+a.since||0, until=Date.now()+1000*Math.max(0, Math.min(40, +a.wait||0));
    let r=_ev(a);
    while(!r.events.length && Date.now()<until){ await new Promise(res=>setTimeout(res, 250)); r=_ev({since}); }
    return r;
  };
}
