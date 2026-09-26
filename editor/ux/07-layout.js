/* =========================================================================
   7. TIDIER GENERATED DRAWINGS
   ========================================================================= */
/* Ports in the order they were declared. The placer orders the IN / OUT columns to
   minimise crossings, which on a generated sheet scrambles them (b, cin, a · a, e, g, f …)
   and reads badly. A sheet that carries sch.portOrder gets its IN and OUT columns put
   back in that order (same slots, same column), then the router runs as usual. */
{
  // (the placer itself honours sch.portOrder — see autoPlaceSheet)
  // every drawn intent remembers its declared port order
  const _draw=drawIntent;
  drawIntent=function(intent, opts){
    const ord={in:[],out:[]};
    (intent&&intent.components||[]).forEach(c=>{ if(c.type==="IN") ord.in.push(sanId(c.name||c.id)); else if(c.type==="OUT") ord.out.push(sanId(c.name||c.id)); });
    const sort=intent&&intent._outNatural; if(sort) ord.out.sort(natCmp);
    // stash on the intent so the sheet gets it before its first route
    let A;
    UX.pendingPortOrder=ord;
    try{ A=_draw.apply(this, arguments); } finally { UX.pendingPortOrder=null; }
    if(!A||!A.ok||(opts&&opts.noRoute)||ord.in.length+ord.out.length<3) return A;
    const numbered=ord.out.length>1 && ord.out.every(n=>/^[a-z_]+\d+$/i.test(n)) && new Set(ord.out.map(n=>n.replace(/\d+$/,""))).size===1;
    if(numbered) return A;   // q0..qN become a block's pins: keep them in order, no second try
    // a pinned order can cost a lot on a dense sheet — draw it free as well, keep the ordered one
    // unless it is clearly worse (longer wiring / taller / more crossings)
    let B; try{ B=_draw.apply(this, arguments); }catch(_){ B=null; }
    if(!B||!B.ok) return A;
    const sa=uxLayoutScore(A.sch), sb=uxLayoutScore(B.sch);
    const keepA = sa <= sb*1.12;   // q0..qN end up as a block's pins: order matters more there
    const win=keepA?A:B, lose=keepA?B:A, name=A.sch.name;
    delete state.project.schematics[lose.id];
    win.sch.name=name; if(!keepA) delete win.sch.portOrder;
    return win;
  };
  const _blank=blankSchematic;
  blankSchematic=function(id, name){ const s=_blank.apply(this, arguments); if(UX.pendingPortOrder) s.portOrder=UX.pendingPortOrder; return s; };
}
function natCmp(a,b){ return String(a).localeCompare(String(b), undefined, {numeric:true}); }

/* lower = tidier: Manhattan wire length + crossings between different nets + sheet height */
function uxLayoutScore(sch){
  const segs=[]; let len=0;
  (sch.wires||[]).forEach(w=>{
    const a=comp(w.from.cid,sch), b=comp(w.to.cid,sch); if(!a||!b) return;
    const pa=portPos(a,w.from.pid)||{x:a.x+6,y:a.y+6}, pb=portPos(b,w.to.pid)||{x:b.x+6,y:b.y+6};
    const pts=[pa, ...(w.pts||[]), pb];
    for(let i=1;i<pts.length;i++){ const p=pts[i-1], q=pts[i]; len+=Math.abs(p.x-q.x)+Math.abs(p.y-q.y); segs.push({p,q,w}); }
  });
  let net={}; try{ (sch.wires||[]).forEach(w=>{ if(net[w.id]) return; const ids=netWires(sch,w); ids.forEach(id=>net[id]=w.id); }); }catch(_){}
  let cross=0;
  const H=segs.filter(s=>s.p.y===s.q.y&&s.p.x!==s.q.x), V=segs.filter(s=>s.p.x===s.q.x&&s.p.y!==s.q.y);
  H.forEach(h=>{ const x0=Math.min(h.p.x,h.q.x), x1=Math.max(h.p.x,h.q.x);
    V.forEach(v=>{ if(net[v.w.id]&&net[v.w.id]===net[h.w.id]) return; const y0=Math.min(v.p.y,v.q.y), y1=Math.max(v.p.y,v.q.y);
      if(v.p.x>x0&&v.p.x<x1&&h.p.y>y0&&h.p.y<y1) cross++; }); });
  const ys=(sch.components||[]).map(c=>c.y), hgt=ys.length?Math.max(...ys)-Math.min(...ys):0;
  return len + cross*60 + hgt*2;
}
