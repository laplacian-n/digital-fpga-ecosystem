/* ===== 12. Wire tidy: re-route from the connection list, never from the old picture =====
   "จัดต่อก็วุ่นวายมาพันยุ่งเหยิง จะลบลากใหม่ก็จำไม่ได้ว่าอันไหนต่ออันไหน จัดอยู่ดีๆสายก็เด้งไปที่อื่น"
   The editor already knows every connection; what gets messy is only the PATH each wire takes.
   Everything here keeps the connectivity exactly and redraws paths:
     wtTidySheet(sch)          every net on the sheet, parts stay where they are
     wtTidyNet(sch, wire)      the one net that wire belongs to
     wtAfterMove(sch, comps)   after a part is moved: ONLY the branches that hang off it (and
                               any wire it now sits on) — every other wire stays put
   One router serves all three (the Top-Down engine's rules, on this editor's pin geometry):
     * a net is ONE tree: each loose end is A*-routed to the part of the net already drawn,
       and a dot is placed where it joins (never branching off at a pin);
     * hard rules: no body, no foreign pin, never along another net's run, never a corner or
       a pass through another net's corner / dot / end;
     * costs: a bend 34, a crossing 28, running right next to another net 5 per grid;
     * if the strict search finds nothing, a relaxed one (rules become big penalties); if even
       that fails the wire is drawn plain — a connection is never dropped. */
const WT = { BEND: 34, CROSS: 28, NEAR: 5, DIRS: [[1,0],[0,1],[-1,0],[0,-1]] };

function wtIsJ(sch, cid){ const c = comp(cid, sch); return !!c && c.type==="JUNCTION"; }
function wtReal(sch){ return sch.components.filter(c=>c.type!=="JUNCTION"); }
/* the drawn corner list of a wire, rounded */
function wtPoly(sch, w){
  const p = drawnPoints(sch, w);
  return p ? p.map(q=>({x:Math.round(q.x), y:Math.round(q.y)})) : null;
}
/* direction a wire leaves a pin in: away from the middle of the part (as globalRoute) */
function wtExit(c, pp){
  const b = compBBox(c), dx = pp.x-(b.x+b.w/2), dy = pp.y-(b.y+b.h/2);
  return Math.abs(dx)>=Math.abs(dy) ? (dx>=0?0:2) : (dy>=0?1:3);
}
/* wire id → net key, for every net on the sheet (walks through dots, either direction) */
function wtNetKeys(sch){
  const key = new Map(); let n = 0;
  sch.wires.forEach(w=>{ if(key.has(w.id)) return; const k = "n"+(n++); netWires(sch, w).forEach(id=>key.set(id, k)); });
  return key;
}

/* ---------- the grid: every GRID line plus every pin / wire corner coordinate ---------- */
function wtGrid(sch){
  const G = GRID, reals = wtReal(sch);
  const keepX = new Set(), keepY = new Set();
  let x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity;
  const grow = (x,y)=>{ x0=Math.min(x0,x); y0=Math.min(y0,y); x1=Math.max(x1,x); y1=Math.max(y1,y); };
  reals.forEach(c=>{ const b = compBBox(c); grow(b.x,b.y); grow(b.x+b.w,b.y+b.h);
    getPorts(c).forEach(p=>{ const q = portPos(c,p.id); if(q){ keepX.add(Math.round(q.x)); keepY.add(Math.round(q.y)); } }); });
  sch.wires.forEach(w=>{ const pl = wtPoly(sch,w); if(pl) pl.forEach(q=>{ keepX.add(q.x); keepY.add(q.y); grow(q.x,q.y); }); });
  sch.components.forEach(c=>{ if(c.type!=="JUNCTION") return; const q = portPos(c,"j"); keepX.add(Math.round(q.x)); keepY.add(Math.round(q.y)); });
  if(!isFinite(x0)) return null;
  const PAD = 8*G;
  x0 = Math.floor((x0-PAD)/G)*G; y0 = Math.floor((y0-PAD)/G)*G; x1 = Math.ceil((x1+PAD)/G)*G; y1 = Math.ceil((y1+PAD)/G)*G;
  const kx = [...keepX], ky = [...keepY];
  const xsS = new Set(kx), ysS = new Set(ky);
  // a plain grid line hugging a pin row (closer than half a grid) would read as touching it
  for(let x=x0; x<=x1; x+=G) if(!kx.some(k=>k!==x && Math.abs(k-x)<G/2)) xsS.add(x);
  for(let y=y0; y<=y1; y+=G) if(!ky.some(k=>k!==y && Math.abs(k-y)<G/2)) ysS.add(y);
  const xs = [...xsS].sort((a,b)=>a-b), ys = [...ysS].sort((a,b)=>a-b);
  const NX = xs.length, NY = ys.length, N = NX*NY;
  if(N > 600000) return null;
  const xi = new Map(xs.map((v,i)=>[v,i])), yi = new Map(ys.map((v,i)=>[v,i]));
  const g = { xs, ys, NX, NY, N, xi, yi,
    id: (i,j)=>j*NX+i,
    at: (x,y)=>{ const i = xi.get(Math.round(x)), j = yi.get(Math.round(y)); return (i==null||j==null) ? -1 : j*NX+i; },
    near: (x,y)=>{ const i = wtNearest(xs,x), j = wtNearest(ys,y); return j*NX+i; },
    blocked: new Uint8Array(N),
    pin: new Map(),                 // cell → "cid pid"
    hOwn: new Array(N).fill(null),  // edge (i,j)→(i+1,j) → net key
    vOwn: new Array(N).fill(null),  // edge (i,j)→(i,j+1)
    pOwn: new Array(N).fill(null),  // point on a net
    pHard: new Array(N).fill(null)  // a corner / end / dot of a net
  };
  // bodies: everything inside a part's box, its edge included (its pins sit on that edge)
  reals.forEach(c=>{ const b = compBBox(c);
    const i0 = wtLo(xs, b.x), i1 = wtHi(xs, b.x+b.w), j0 = wtLo(ys, b.y), j1 = wtHi(ys, b.y+b.h);
    for(let j=j0;j<=j1;j++) for(let i=i0;i<=i1;i++) g.blocked[g.id(i,j)] = 1;
    getPorts(c).forEach(p=>{ const q = portPos(c,p.id); if(!q) return; const k = g.at(q.x,q.y); if(k>=0) g.pin.set(k, c.id+" "+p.id); });
  });
  return g;
}
function wtNearest(a, v){ let lo=0, hi=a.length-1; while(lo<hi){ const m=(lo+hi)>>1; if(a[m]<v) lo=m+1; else hi=m; }
  return (lo>0 && Math.abs(a[lo-1]-v)<=Math.abs(a[lo]-v)) ? lo-1 : lo; }
function wtLo(a, v){ let i = wtNearest(a, v); if(a[i] < v-0.5 && i<a.length-1) i++; return i; }
function wtHi(a, v){ let i = wtNearest(a, v); if(a[i] > v+0.5 && i>0) i--; return i; }

/* grid cells a polyline passes through, in order */
function wtCells(g, pl){
  const out = [];
  for(let a=1;a<pl.length;a++){
    const i0 = wtNearest(g.xs,pl[a-1].x), j0 = wtNearest(g.ys,pl[a-1].y), i1 = wtNearest(g.xs,pl[a].x), j1 = wtNearest(g.ys,pl[a].y);
    if(j0===j1){ const s = Math.sign(i1-i0)||1; for(let i=i0; i!==i1+s; i+=s) out.push(g.id(i,j0)); }
    else if(i0===i1){ const s = Math.sign(j1-j0)||1; for(let j=j0; j!==j1+s; j+=s) out.push(g.id(i0,j)); }
    else { out.push(g.id(i0,j0), g.id(i1,j1)); }       // a diagonal (never drawn by us) — mark its ends
  }
  return out.filter((k,n)=>n===0 || k!==out[n-1]);
}
/* record a net's path on the grid: its runs, its points, and its corners/ends as hard */
function wtClaim(g, key, cells){
  for(let a=0;a<cells.length;a++){
    const k = cells[a]; g.pOwn[k] = g.pOwn[k] || key;
    if(a===0 || a===cells.length-1) g.pHard[k] = g.pHard[k] || key;
    else { const p = cells[a-1], n = cells[a+1]; if(((p%g.NX)===(k%g.NX)) !== ((n%g.NX)===(k%g.NX))) g.pHard[k] = g.pHard[k] || key; }
    if(a){ const p = cells[a-1], pi = p%g.NX, pj = (p/g.NX)|0, i = k%g.NX, j = (k/g.NX)|0;
      if(pj===j) g.hOwn[g.id(Math.min(pi,i),j)] = key; else if(pi===i) g.vOwn[g.id(i,Math.min(pj,j))] = key; }
  }
}

/* A* from `sources` ([{k, d}] — d = the only way out of a pin, or -1 for any) to a cell
   `goal(k)` accepts. Returns the cell path source … goal, or null. */
function wtSearch(g, key, sources, goal, relax){
  const {NX, NY, N, xs, ys} = g, D = WT.DIRS;
  const S = N*4, gC = new Float64Array(S).fill(Infinity), from = new Int32Array(S).fill(-1);
  const heap = [];
  const push = (f,st)=>{ heap.push([f,st]); let c=heap.length-1; while(c){ const p=(c-1)>>1; if(heap[p][0]<=heap[c][0]) break; [heap[p],heap[c]]=[heap[c],heap[p]]; c=p; } };
  const pop = ()=>{ const top=heap[0], last=heap.pop(); if(heap.length){ heap[0]=last; let c=0; for(;;){ const l=2*c+1, r=l+1; let m=c; if(l<heap.length&&heap[l][0]<heap[m][0]) m=l; if(r<heap.length&&heap[r][0]<heap[m][0]) m=r; if(m===c) break; [heap[m],heap[c]]=[heap[c],heap[m]]; c=m; } } return top; };
  const fixedDir = new Map();
  sources.forEach(s=>{ if(s.d>=0) fixedDir.set(s.k, s.d);
    (s.d>=0 ? [s.d] : [0,1,2,3]).forEach(d=>{ const st = s.k*4+d; if(gC[st]>0){ gC[st]=0; push(0, st); } }); });
  const near = (i, j, horiz)=>{
    let c = 0;
    for(const dd of [-1,1]){
      if(horiz){ const jj=j+dd; if(jj<0||jj>=NY||Math.abs(ys[jj]-ys[j])>GRID+0.5) continue; const o=g.hOwn[g.id(i,jj)]; if(o&&o!==key) c++; }
      else { const ii=i+dd; if(ii<0||ii>=NX||Math.abs(xs[ii]-xs[i])>GRID+0.5) continue; const o=g.vOwn[g.id(ii,j)]; if(o&&o!==key) c++; }
    }
    return c;
  };
  let iter = 0;
  while(heap.length){
    if(++iter > 400000) break;
    const [, st] = pop(); const k = (st/4)|0, d = st%4, gc = gC[st];
    if(from[st]>=0 || !fixedDir.has(k) || true){ /* keep going */ }
    if(goal(k) && !sources.some(s=>s.k===k)){
      const path = []; for(let s=st; s>=0; s=from[s]) path.push((s/4)|0);
      return path.reverse().filter((c,n,a)=>n===0 || c!==a[n-1]);
    }
    const i = k%NX, j = (k/NX)|0;
    for(let nd=0; nd<4; nd++){
      if(nd===((d+2)%4)) continue;                            // no U-turn
      if(fixedDir.has(k) && gC[st]===0 && nd!==fixedDir.get(k)) continue;   // leave a pin along its lead
      const ni = i+D[nd][0], nj = j+D[nd][1];
      if(ni<0||nj<0||ni>=NX||nj>=NY) continue;
      const nk = g.id(ni,nj), isGoal = goal(nk);
      const len = Math.abs(xs[ni]-xs[i]) + Math.abs(ys[nj]-ys[j]);
      let cost = len;
      if(nd!==d && gc>0){
        if(g.pOwn[k] && g.pOwn[k]!==key){ if(!relax) continue; cost += 400; }   // a corner on another net reads as a join
        cost += WT.BEND;
      }
      const pk = g.pin.get(nk);
      if(g.blocked[nk] && !(isGoal && pk)){ if(!relax) continue; cost += 600; }
      const horiz = nj===j, eo = horiz ? g.hOwn[g.id(Math.min(i,ni),j)] : g.vOwn[g.id(i,Math.min(j,nj))];
      if(eo && eo!==key){ if(!relax) continue; cost += 300; }            // never along another net
      const po = g.pOwn[nk];
      if(po && po!==key){
        if(g.pHard[nk] && g.pHard[nk]!==key){ if(!relax) continue; cost += 300; }
        cost += WT.CROSS;
      }
      cost += WT.NEAR * near(horiz?Math.min(i,ni):i, horiz?j:Math.min(j,nj), horiz) * len / GRID;
      const ns = nk*4+nd, ng = gc+cost;
      if(ng < gC[ns]){ gC[ns]=ng; from[ns]=st; push(ng, ns); }
    }
  }
  return null;
}

/* ---------- the endpoints of a new wire ---------- */
/* what sits at grid cell k on net `key`: a pin, an existing dot, or a point on one of the
   net's wires (a new dot is put there, splitting that wire) */
function wtEndAt(sch, g, k, netIds){
  const pk = g.pin.get(k);
  const x = g.xs[k%g.NX], y = g.ys[(k/g.NX)|0];
  if(pk){ const s = pk.indexOf(" "); return {cid:pk.slice(0,s), pid:pk.slice(s+1)}; }
  const dot = sch.components.find(c=>{ if(c.type!=="JUNCTION") return false; const q = portPos(c,"j");
    return Math.abs(q.x-x)<1 && Math.abs(q.y-y)<1 && sch.wires.some(w=>netIds.has(w.id) && (w.from.cid===c.id||w.to.cid===c.id)); });
  if(dot) return {cid:dot.id, pid:"j"};
  const host = sch.wires.find(w=>{ if(!netIds.has(w.id)) return false; const pl = wtPoly(sch,w); return pl && splitPolyAt(pl, {x,y}); });
  if(!host) return null;
  const j = { id: uid("c"), type:"JUNCTION", x: x-6, y: y-6, params:{ fixed:true } };
  sch.components.push(j);
  const before = new Set(sch.wires.map(w=>w.id));
  splitWireThroughJunction(host, j, sch);
  netIds.delete(host.id);
  sch.wires.forEach(w=>{ if(!before.has(w.id)) netIds.add(w.id); });
  return {cid:j.id, pid:"j"};
}
function wtPortDir(sch, ep){ const c = comp(ep.cid, sch); if(!c || c.type==="JUNCTION") return null; const p = getPort(c, ep.pid); return p ? p.dir : null; }
/* corner points of a cell path, ends excluded */
function wtCorners(g, path){
  const P = path.map(k=>({x:g.xs[k%g.NX], y:g.ys[(k/g.NX)|0]}));
  const out = [];
  for(let a=1;a<P.length-1;a++){ const p=P[a-1], q=P[a], r=P[a+1]; if(!((p.x===q.x&&q.x===r.x)||(p.y===q.y&&q.y===r.y))) out.push(q); }
  return out;
}

/* ---------- the core: delete some wires, then reconnect every net they belonged to ---------- */
function wtReroute(sch, delIds, opts){
  opts = opts || {};
  if(!sch || !delIds.size) return {nets:0, relaxed:0, plain:0};
  const netKey = wtNetKeys(sch);
  const affected = new Set([...delIds].map(id=>netKey.get(id)).filter(Boolean));
  // what each affected net must still join: its real pins and its deliberate free ends
  const nets = new Map();
  affected.forEach(k=>nets.set(k, {key:k, terms:new Map(), width:0, name:"", ids:new Set()}));
  sch.wires.forEach(w=>{
    const n = nets.get(netKey.get(w.id)); if(!n) return;
    n.ids.add(w.id);
    if(w.width && w.width>n.width) n.width = w.width;
    if(w.name && !n.name) n.name = w.name;
    [w.from, w.to].forEach(ep=>{ const c = comp(ep.cid, sch); if(!c) return;
      if(c.type!=="JUNCTION" || (c.params && c.params.endpoint)) n.terms.set(ep.cid+" "+ep.pid, {cid:ep.cid, pid:ep.pid}); });
  });
  // 1. delete, then prune the stubs that now lead nowhere (a dot left with one wire)
  const keptName = new Set();
  sch.wires = sch.wires.filter(w=>{ if(!delIds.has(w.id)) return true; nets.get(netKey.get(w.id)).ids.delete(w.id); return false; });
  for(let again=true; again; ){
    again = false;
    for(const j of sch.components){
      if(j.type!=="JUNCTION" || (j.params && j.params.endpoint)) continue;
      const ws = sch.wires.filter(w=>w.from.cid===j.id || w.to.cid===j.id);
      if(ws.length>1) continue;
      if(ws.length===1){ const n = nets.get(netKey.get(ws[0].id)); if(!n) continue; n.ids.delete(ws[0].id); }
      sch.wires = sch.wires.filter(w=>!ws.includes(w));
      sch.components = sch.components.filter(c=>c!==j);
      again = true; break;
    }
  }
  nets.forEach(n=>sch.wires.forEach(w=>{ if(n.ids.has(w.id) && w.name) keptName.add(n.key); }));
  // 2. the grid, with every wire that is left claimed by its net
  const g = wtGrid(sch);
  if(!g) return {nets:0, relaxed:0, plain:0};
  sch.wires.forEach(w=>{ const pl = wtPoly(sch,w); if(pl) wtClaim(g, netKey.get(w.id)||w.id, wtCells(g, pl)); });
  // 3. nets in order: two-pin nets first, then by size; big fan-outs last (as Top-Down)
  const order = [...nets.values()].filter(n=>n.terms.size>=2).sort((a,b)=>(a.terms.size-b.terms.size));
  let relaxed = 0, plain = 0;
  for(const n of order){
    // fragments: groups of the net already joined by the wires that are left
    const par = new Map(), find = x=>{ while(par.get(x)!==x){ par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
    const add = x=>{ if(!par.has(x)) par.set(x,x); };
    const uni = (a,b)=>{ add(a); add(b); const ra=find(a), rb=find(b); if(ra!==rb) par.set(ra,rb); };
    const epKey = ep=>wtIsJ(sch, ep.cid) ? ep.cid : ep.cid+" "+ep.pid;
    n.terms.forEach((t,tk)=>add(epKey(t)));
    sch.wires.forEach(w=>{ if(n.ids.has(w.id)) uni(epKey(w.from), epKey(w.to)); });
    const frag = new Map();   // root → {cells:Set, terms:[], pinOnly}
    const fragOf = r=>frag.get(r) || frag.set(r, {cells:new Set(), pins:new Set(), size:0}).get(r);
    n.terms.forEach((t,tk)=>{ const f = fragOf(find(epKey(t))); const c = wtIsJ(sch,t.cid) ? comp(t.cid,sch) : null;
      const q = c ? portPos(c,"j") : portPos(comp(t.cid,sch), t.pid); if(!q) return;
      const k = g.at(q.x,q.y); if(k<0) return; f.cells.add(k); if(!c) f.pins.add(k); f.size++; });
    sch.wires.forEach(w=>{ if(!n.ids.has(w.id)) return; const f = fragOf(find(epKey(w.from))); const pl = wtPoly(sch,w);
      if(pl) wtCells(g, pl).forEach(k=>f.cells.add(k)); f.size += 2; });
    const frags = [...frag.values()].filter(f=>f.cells.size);
    if(frags.length<2) continue;
    // grow from the fragment holding the driver (an output pin), else the biggest one
    const drives = f=>[...f.pins].some(k=>{ const pk = g.pin.get(k); const s = pk.indexOf(" "); return wtPortDir(sch, {cid:pk.slice(0,s), pid:pk.slice(s+1)})==="out"; });
    frags.sort((a,b)=>(drives(b)-drives(a)) || (b.size-a.size));
    const main = frags.shift();
    const cx = k=>g.xs[k%g.NX], cy = k=>g.ys[(k/g.NX)|0];
    const dist = f=>{ let best = Infinity; f.cells.forEach(a=>main.cells.forEach(b=>{ const d = Math.abs(cx(a)-cx(b))+Math.abs(cy(a)-cy(b)); if(d<best) best = d; })); return best; };
    while(frags.length){
      frags.sort((a,b)=>dist(a)-dist(b));
      const f = frags.shift();
      // never branch off at a pin: a pin is an end only while it is its fragment's only cell
      const src = [...f.cells].filter(k=>!(f.pins.has(k) && f.cells.size>1))
        .map(k=>{ const pk = g.pin.get(k); if(!pk || !f.pins.has(k)) return {k, d:-1};
          const s = pk.indexOf(" "), c = comp(pk.slice(0,s), sch); return {k, d:wtExit(c, portPos(c, pk.slice(s+1)))}; });
      const goal = k=>main.cells.has(k) && !(main.pins.has(k) && main.cells.size>1);
      src.forEach(s=>{ if(g.pin.has(s.k)) g.blocked[s.k] = 0; });
      let path = wtSearch(g, n.key, src, goal, false);
      if(!path){ path = wtSearch(g, n.key, src, goal, true); if(path) relaxed++; }
      src.forEach(s=>{ if(g.pin.has(s.k)) g.blocked[s.k] = 1; });
      let A, B;
      if(path){
        A = wtEndAt(sch, g, path[0], n.ids); B = wtEndAt(sch, g, path[path.length-1], n.ids);
      }
      if(!path || !A || !B){
        // nothing routable: join the two nearest points with a plain wire, connection first
        plain++;
        let best = null;
        f.cells.forEach(a=>main.cells.forEach(b=>{ if(f.pins.has(a)&&f.cells.size>1) return; if(main.pins.has(b)&&main.cells.size>1) return;
          const d = Math.abs(cx(a)-cx(b))+Math.abs(cy(a)-cy(b)); if(!best || d<best.d) best = {a,b,d}; }));
        if(!best) continue;
        A = wtEndAt(sch, g, best.a, n.ids); B = wtEndAt(sch, g, best.b, n.ids); path = null;
        if(!A || !B) continue;
      }
      // the driver's side is `from`; between two dots healJunctions orients it
      let from = A, to = B, flipped = false;
      if(wtPortDir(sch,A)==="in" || wtPortDir(sch,B)==="out") { from = B; to = A; flipped = true; }
      const w = { id: uid("w"), from, to, name: "" };
      if(n.width>1) w.width = n.width;
      if(n.name && !keptName.has(n.key)){ w.name = n.name; keptName.add(n.key); }
      if(path){ const pts = wtCorners(g, path); if(flipped) pts.reverse(); if(pts.length) w.pts = pts; }
      sch.wires.push(w); n.ids.add(w.id);
      const cells = path || [];
      if(path) wtClaim(g, n.key, cells);
      cells.forEach(k=>main.cells.add(k)); f.cells.forEach(k=>main.cells.add(k)); f.pins.forEach(k=>main.pins.add(k));
      main.size += f.size + 2;
    }
  }
  healJunctions(sch);
  return {nets:order.length, relaxed, plain};
}

/* ---------- the three ways in ---------- */
function wtTidySheet(sch){
  sch = sch || activeSch(); if(!sch) return null;
  return wtReroute(sch, new Set(sch.wires.map(w=>w.id)));
}
function wtTidyNet(sch, w){
  sch = sch || activeSch(); if(!sch || !w) return null;
  return wtReroute(sch, new Set(netWires(sch, w)));
}
/* After parts moved: re-route only the wires hanging off them (one end on a moved part or
   dot) plus any other wire the moved part now sits on or pins over. Returns false when it
   did not handle the move (locked sheet, only dots dragged) so the caller heals as before. */
function wtAfterMove(sch, comps){
  sch = sch || activeSch();
  if(!sch || !comps || !comps.length || layoutLocked(sch)) return false;
  if(comps.every(c=>c.type==="JUNCTION")) return false;           // a dot dragged by hand is the user's
  const moved = new Set(comps.map(c=>c.id));
  const del = new Set();
  sch.wires.forEach(w=>{ if(moved.has(w.from.cid) !== moved.has(w.to.cid)) del.add(w.id); });
  wireBodyCrossings(sch).forEach(x=>{ if(moved.has(x.cid)) del.add(x.wid); });
  wirePinCrossings(sch).forEach(x=>{ if(moved.has(x.cid)) del.add(x.wid); });
  if(!del.size) return true;
  wtReroute(sch, del);
  return true;
}

/* ---------- 🧹 the toolbar button: the selected wire's net, or the whole sheet ---------- */
function wtTidyCommand(){
  const sch = activeSch(); if(!sch) return;
  const w = sch.wires.find(x=>state.selection && state.selection.has(x.id));
  const r = w ? wtTidyNet(sch, w) : wtTidySheet(sch);
  if(!r) return;
  state.selection = new Set();
  snapshot(); renderAll();
  toast((w ? "เก็บกวาดเน็ตนี้แล้ว" : `เก็บกวาดสายทั้งแผ่นแล้ว (${r.nets} เน็ต)`)
    + (r.plain ? ` — มี ${r.plain} เส้นที่หาทางสวยไม่ได้ เลยลากตรงไว้ ลองขยับชิ้นส่วนให้ห่างขึ้น` : " — การต่อเหมือนเดิมทุกเส้น")
    + " · Ctrl+Z ย้อนได้", r.plain ? "warn" : "ok", 4000);
}

/* ---------- 🧲 ratsnest mode (KiCad footprint placement) ----------
   The wires are hidden; every net is drawn as thin straight lines in its own colour between
   the pins it joins (shortest spanning tree), so parts can be dragged into a sensible order by
   eye. Nothing is re-routed while it is on. "จัดสายให้" then routes the whole sheet. */
const RN = { on:false, sid:null, bar:null };
function wtRatsNets(sch){
  const out = [], seen = new Set();
  sch.wires.forEach(w0=>{
    if(seen.has(w0.id)) return;
    const ids = netWires(sch, w0); ids.forEach(id=>seen.add(id));
    const pts = new Map();
    ids.forEach(id=>{ const w = sch.wires.find(x=>x.id===id); if(!w) return;
      [w.from, w.to].forEach(ep=>{ const c = comp(ep.cid, sch); if(!c) return;
        if(c.type==="JUNCTION" && !(c.params && c.params.endpoint)) return;
        const q = c.type==="JUNCTION" ? portPos(c,"j") : portPos(c, ep.pid); if(q) pts.set(ep.cid+" "+ep.pid, {x:q.x, y:q.y}); }); });
    const P = [...pts.values()];
    if(P.length < 2) return;
    // Prim: the shortest set of straight lines joining every pin of the net
    const inT = [P[0]], rest = P.slice(1), lines = [];
    while(rest.length){
      let best = null;
      inT.forEach(a=>rest.forEach((b,i)=>{ const d = Math.hypot(a.x-b.x, a.y-b.y); if(!best || d<best.d) best = {a, b, i, d}; }));
      lines.push([best.a, best.b]); inT.push(best.b); rest.splice(best.i, 1);
    }
    out.push({pts:P, lines, bus:ids.size && sch.wires.some(w=>ids.has(w.id) && (w.width||1)>1)});
  });
  return out;
}
function wtRatsToggle(on){
  const sch = activeSch(); if(!sch) return;
  RN.on = on==null ? !RN.on : !!on;
  RN.sid = RN.on ? state.activeId : null;
  if(RN.on) toast("🧲 โหมดจัดวาง — ลากชิ้นส่วนไปวางให้เส้นสีสั้นและไม่ไขว้กัน แล้วกด “จัดสายให้”", "info", 4500);
  render();
}
function wtRatsBar(){
  if(RN.bar) return RN.bar;
  const host = canvas.parentElement; if(!host) return null;
  const b = document.createElement("div");
  b.id = "wtRatsBar"; b.className = "wt-rats-bar";
  b.innerHTML = `<span>🧲 <b>โหมดจัดวาง</b> — ลากชิ้นส่วนให้เส้นสีสั้นและไขว้กันน้อยที่สุด <span class="muted" id="wtRatsInfo"></span></span>
    <button class="wt-go" id="wtRatsGo">✓ จัดสายให้</button><button id="wtRatsOff">ออก (ไม่จัด)</button>`;
  host.appendChild(b);
  b.querySelector("#wtRatsGo").onclick = ()=>{
    const s = activeSch(); RN.on = false;
    const r = wtTidySheet(s); snapshot(); renderAll();
    if(r) toast(`จัดสายแล้ว ${r.nets} เน็ต — การต่อเหมือนเดิมทุกเส้น`
      + (r.plain ? ` (มี ${r.plain} เส้นที่หาทางสวยไม่ได้ เลยลากตรงไว้)` : "") + " · Ctrl+Z ย้อนได้", r.plain ? "warn" : "ok", 4000);
  };
  b.querySelector("#wtRatsOff").onclick = ()=>wtRatsToggle(false);
  return RN.bar = b;
}
function wtCrossCount(nets){
  let n = 0; const L = []; nets.forEach((net,i)=>net.lines.forEach(l=>L.push([i, l])));
  const cr = (p1,p2,p3,p4)=>{ const d = (a,b,c)=>(c.x-a.x)*(b.y-a.y)-(c.y-a.y)*(b.x-a.x);
    const d1=d(p3,p4,p1), d2=d(p3,p4,p2), d3=d(p1,p2,p3), d4=d(p1,p2,p4); return d1*d2<0 && d3*d4<0; };
  for(let a=0;a<L.length;a++) for(let b=a+1;b<L.length;b++) if(L[a][0]!==L[b][0] && cr(L[a][1][0],L[a][1][1],L[b][1][0],L[b][1][1])) n++;
  return n;
}
function wtAfterRender(){
  const sch = activeSch();
  if(RN.on && RN.sid!==state.activeId){ RN.on = false; }
  canvas.classList.toggle("wt-rats", RN.on);
  const bar = wtRatsBar(); if(bar) bar.hidden = !RN.on;
  const root = [...canvas.children].reverse().find(g=>g.tagName==="g" && (g.getAttribute("transform")||"").startsWith("translate"));
  if(RN.on && sch && root){
    root.querySelectorAll(".node[data-cid]").forEach(g=>{ const c = comp(g.getAttribute("data-cid"), sch); if(c && c.type==="JUNCTION") g.classList.add("wt-j"); });
    const nets = wtRatsNets(sch), k = state.view.k || 1;
    const layer = el("g", {class:"wt-rats-layer", "pointer-events":"none"});
    nets.forEach((net,i)=>{
      const col = `hsl(${(i*137.508)%360},72%,${i%2?42:50}%)`;
      net.lines.forEach(([a,b])=>layer.appendChild(el("line", {x1:a.x, y1:a.y, x2:b.x, y2:b.y, stroke:col,
        "stroke-width": (net.bus?2.6:1.6)/Math.min(1.5,Math.max(.6,k)), "stroke-opacity":.9})));
      net.pts.forEach(p=>layer.appendChild(el("circle", {cx:p.x, cy:p.y, r:3, fill:col})));
    });
    root.appendChild(layer);
    const info = document.getElementById("wtRatsInfo");
    if(info) info.textContent = `· ${nets.length} เน็ต · เส้นไขว้ ${wtCrossCount(nets)} จุด`;
  }
  wtDebugFix(sch);
}
{
  const _render = render;
  render = function(){ const r = _render.apply(this, arguments); try{ wtAfterRender(); }catch(e){ console.warn("wire tidy", e); } return r; };
}
/* nothing re-routes while placing by eye */
{
  const _after = wtAfterMove;
  wtAfterMove = function(sch, comps){ if(RN.on) return true; return _after.apply(this, arguments); };
}

/* ---------- 🐞 debug panel: a fix button for what it counts ---------- */
function wtDebugFix(sch){
  const box = document.getElementById("dbgFix"); if(!box) return;
  if(!DBG.on || !sch){ box.innerHTML = ""; return; }
  const bad = new Set();
  netSelfOverlaps(sch).forEach(o=>{ bad.add(o.a); bad.add(o.b); });
  netCollinearOverlaps(sch).forEach(o=>{ bad.add(o.a); bad.add(o.b); });
  wireBodyCrossings(sch).forEach(o=>bad.add(o.wid));
  wirePinCrossings(sch).forEach(o=>bad.add(o.wid));
  const key = bad.size+"|"+sch.wires.length;
  if(box.dataset.k===key) return;
  box.dataset.k = key;
  box.innerHTML = (bad.size ? `<button id="dbgFixBad">🧹 แก้เน็ตที่มีปัญหา</button>` : "")
    + `<button id="dbgFixAll">🧹 เก็บกวาดทั้งแผ่น</button>`;
  const fb = box.querySelector("#dbgFixBad");
  if(fb) fb.onclick = ()=>{
    const s = activeSch(), del = new Set();
    bad.forEach(id=>{ const w = s.wires.find(x=>x.id===id); if(w) netWires(s, w).forEach(x=>del.add(x)); });
    const r = wtReroute(s, del); snapshot(); renderAll();
    toast(`เก็บกวาด ${r.nets} เน็ตที่มีปัญหาแล้ว — การต่อเหมือนเดิม · Ctrl+Z ย้อนได้`, "ok", 3500);
  };
  box.querySelector("#dbgFixAll").onclick = ()=>{ state.selection = new Set(); wtTidyCommand(); };
}

/* ---------- point at a wire: the rest dims, and a note says what the net joins ---------- */
function wtPinName(c, pid){
  const p = getPort(c, pid) || {};
  const ins = getPorts(c).filter(q=>q.dir==="in");
  if(/^i\d+$/.test(pid) && ins.length>1 && !["MUX","DEMUX","ENC","DEC"].includes(c.type)) return "ขา "+(ins.findIndex(q=>q.id===pid)+1);
  return String(p.label || pid).toUpperCase();
}
function wtPartName(c){
  if(c.type==="IN" || c.type==="OUT") return `${c.type==="IN"?"INPUT":"OUTPUT"} '${(c.params&&c.params.name)||"?"}'`;
  return c.label || compDisplay(c);
}
function wtNetHtml(wid){
  const sch = activeSch(); const w = sch && sch.wires.find(x=>x.id===wid); if(!w) return "";
  const ids = netWires(sch, w), ends = new Map();
  ids.forEach(id=>{ const x = sch.wires.find(y=>y.id===id); if(!x) return;
    [x.from, x.to].forEach(ep=>{ const c = comp(ep.cid, sch); if(c && c.type!=="JUNCTION") ends.set(ep.cid+" "+ep.pid, {c, pid:ep.pid}); }); });
  const d = netDriverPort(sch, w);
  const all = [...ends.values()];
  const src = all.find(e=>d && e.c.id===d.cid && e.pid===d.pid);
  const sinks = all.filter(e=>e!==src);
  const nm = e=>esc(e.c.type==="IN"||e.c.type==="OUT" ? wtPartName(e.c) : wtPartName(e.c)+" · "+wtPinName(e.c, e.pid));
  return `<div class="ux-tip-h">${w.name ? "สาย "+esc(w.name) : "สายเส้นนี้"} ต่อ ${all.length} ขา</div>`
    + (src ? `<div>จาก <b>${nm(src)}</b></div>` : `<div class="muted">ไม่มีตัวขับ</div>`)
    + (sinks.length ? `<div>ไปที่ ${sinks.map(e=>"<b>"+nm(e)+"</b>").join(", ")}</div>` : "")
    + `<div class="muted" style="margin-top:3px">เลือกสายแล้วกด 🧹 = เก็บกวาดเฉพาะเน็ตนี้</div>`;
}
canvas.addEventListener("mouseover", ev=>{
  const hit = ev.target.closest && ev.target.closest(".wire-hit");
  canvas.classList.toggle("wt-focus", !!hit && !state.drag && !state.wireDrag && !state.pan);
});
canvas.addEventListener("mouseleave", ()=>canvas.classList.remove("wt-focus"));
