/* td-engine.js — Top-Down layout + router, modelled on the hand-drawn lab sheets.

   What the sheets do (see docs/TOPDOWN.md for the full write-up):
     * signal flows left → right in COLUMNS by logic depth; a long chain WRAPS into a
       second row that starts again at the left (Mod20m: 4 blocks, then 3 + the JK-FF);
     * a block is lined up so the wire from the block that feeds it runs DEAD STRAIGHT
       (Q → CLK along one row, D0/D1 of Counter → Display side by side);
     * several consumers of one source stack in the same column, left edges aligned
       (Display over Compare);
     * inputs are bare names OUTSIDE the dashed frame on the left, outputs on the
       right, each on the row of the pin it feeds / comes from;
     * a net with several sinks is ONE tree: a spine in a channel with T-joins (dots)
       dropping into each pin — never a separate wire per sink, never through a body;
     * different nets keep a track apart; a loop back (Buzzer → AND) goes round below.

   Two passes, both pure functions of the sheet:
     TDE.layout(s)  places nodes + frame (and calls TDE.route)
     TDE.route(s)   routes every engine-owned wire on a track grid (A* per net, nets
                    grown as trees) and stores the drawn corners in w.pts (w.exact).
   It reads the page's own pin geometry (pins/pinPos/approachDir/recalc/TS), so what
   it routes to is exactly what the renderer draws. */
(function(){
"use strict";
const G = 10;                 // track pitch = the sheet's snap grid
const LABEL_H = 20;           // block name above the box
const BODY_PAD = 8;           // keep wires this far off a body (pin leads are 10 long)

const isInPort  = n => n.type==='port' && n.side!=='right';
const isOutPort = n => n.type==='port' && n.side==='right';
const isCore    = n => n.type==='block' || n.type==='gate' || n.type==='mux';
const netKey    = w => w.from.node+'.'+w.from.pin;
const snapG     = v => Math.round(v/G)*G;

/* where a wire meets a pin — the tip of a block's lead, the pin itself otherwise
   (mirrors endPoint() in the page, but for any sheet, not only the active one) */
function tip(s, ref){
  const n = s.nodes.find(m=>m.id===ref.node); if(!n) return null;
  const p = pinPos(n, ref.pin); if(!p) return null;
  const L = leadOf(n); if(!L) return {x:p.x, y:p.y, n, p};
  const d = dirOf(p.side);
  return {x:p.x+d[0]*L, y:p.y+d[1]*L, n, p};
}
/* how far a pin's drawn lead sticks out past the pin point (the wire meets its end) */
const leadOf = n => n.type==='block' ? PIN_LEAD : n.type==='mux' ? 8 : 0;
/* the direction a wire leaves this end in, going away from the part */
function outDir(s, ref){
  const n = s.nodes.find(m=>m.id===ref.node); const p = n && pinPos(n, ref.pin);
  if(!p) return [1,0];
  const d = dirOf(p.side);
  return (n.type==='port'||n.type==='netlabel') ? [-d[0],-d[1]] : d;
}
/* the drawn body of a part (no pin leads), plus the name above a block */
function body(n){
  if(n.type==='block') return {x1:n.x, y1:n.y-LABEL_H, x2:n.x+n.w, y2:n.y+n.h};
  if(n.type==='mux')   return {x1:n.x, y1:n.y-4, x2:n.x+n.w, y2:n.y+n.h};
  if(n.type==='gate'){
    const bub = /^(nand|nor|xnor|not)$/.test(n.gate) ? 9 : 0, xr = /^(xor|xnor)$/.test(n.gate) ? 7 : 0;
    return {x1:n.x-xr, y1:n.y, x2:n.x+n.w+bub, y2:n.y+n.h};
  }
  if(n.type==='const'){ const t = String(n.value||'').length*7+6; return {x1:n.x-t, y1:n.y-4, x2:n.x+12, y2:n.y+14}; }
  return null;
}

/* ============================ placement ============================ */
function layout(s, opts){
  opts = opts || {};
  const nodes = s.nodes; if(!nodes.length) return null;
  nodes.forEach(n=>{ if(n.type==='block') recalc(n); });
  const byId = new Map(nodes.map(n=>[n.id,n]));
  const core = nodes.filter(isCore);
  const coreSet = new Set(core.map(n=>n.id));
  const ins = nodes.filter(isInPort), outs = nodes.filter(isOutPort);
  const consts = nodes.filter(n=>n.type==='const');

  // --- core graph (only part → part edges decide the columns)
  const succ = new Map(core.map(n=>[n.id,[]])), pred = new Map(core.map(n=>[n.id,[]]));
  s.wires.forEach(w=>{ const a=w.from.node, b=w.to.node;
    if(coreSet.has(a)&&coreSet.has(b)&&a!==b){ succ.get(a).push({w,to:b}); pred.get(b).push({w,from:a}); } });
  // a loop is broken at the edge that points BACK in a depth-first walk started from
  // the parts the inputs feed (Button → AND → Counter → … → Compare → AND is the back edge)
  const fedByInput = id => s.wires.some(w=>w.to.node===id && byId.get(w.from.node) && isInPort(byId.get(w.from.node)));
  const order = core.slice().sort((a,b)=>(fedByInput(b.id)-fedByInput(a.id)) || (core.indexOf(a)-core.indexOf(b)));
  const back = new Set(), state = new Map();
  const dfs = id => { state.set(id,1);
    for(const e of succ.get(id)){ const st=state.get(e.to);
      if(st===1) back.add(e.w.id); else if(!st) dfs(e.to); }
    state.set(id,2); };
  order.forEach(n=>{ if(!state.get(n.id)) dfs(n.id); });
  // longest path over forward edges = column
  const col = new Map();
  const colOf = id => { if(col.has(id)) return col.get(id); col.set(id,0); let c=0;
    for(const e of pred.get(id)) if(!back.has(e.w.id)) c=Math.max(c,colOf(e.from)+1);
    col.set(id,c); return c; };
  core.forEach(n=>colOf(n.id));
  const K = core.length ? Math.max(...core.map(n=>col.get(n.id)))+1 : 0;
  const cols = []; for(let c=0;c<K;c++) cols.push([]);
  order.forEach(n=>cols[col.get(n.id)].push(n));
  cols.forEach(c=>c.sort((a,b)=>core.indexOf(a)-core.indexOf(b)));

  // --- how many tracks each channel will need (so the router has room)
  const wide = 1 + (opts.widen||0)*0.6;
  const netsOf = new Map(); s.wires.forEach(w=>{ const k=netKey(w); (netsOf.get(k)||netsOf.set(k,[]).get(k)).push(w); });
  const colW = cols.map(c=>Math.max(40,...c.map(n=>body(n).x2-body(n).x1)));
  // wrap into rows when one row would not fit the paper (~800 units of parts at 0.3 mm)
  const MAXW = opts.maxW || 900;
  const gapGuess = c => 60 + 18*Math.min(4, (cols[c]||[]).length);
  let rows = 1;
  for(; rows<4; rows++){
    const per = Math.ceil(K/rows); let worst = 0;
    for(let r=0;r<rows;r++){ let W=0; for(let c=r*per;c<Math.min(K,(r+1)*per);c++) W+=colW[c]+gapGuess(c); worst=Math.max(worst,W); }
    if(worst<=MAXW) break;
  }
  const per = Math.max(1, Math.ceil(K/rows));
  const bandOf = c => Math.floor(c/per);

  // channel k before column c = nets that have to turn in it
  const pinY = (ref) => { const t = tip(s,ref); return t ? t.y : 0; };
  const chanBefore = new Array(K+1).fill(0), chanAfterBand = new Array(rows).fill(0);
  const busIn = new Array(K+1).fill(false);
  for(const [k,ws] of netsOf){
    const src = byId.get(ws[0].from.node); if(!src) continue;
    const sc = coreSet.has(src.id) ? col.get(src.id) : -1;
    const seen = new Set();
    for(const w of ws){
      const dn = byId.get(w.to.node); if(!dn) continue;
      if(isOutPort(dn)){ chanAfterBand[bandOf(Math.max(0,sc))]++; continue; }
      if(!coreSet.has(dn.id)) continue;
      const dc = col.get(dn.id);
      const b0 = coreSet.has(src.id) ? bandOf(sc) : -1, b1 = bandOf(dc);
      let c = (b0===b1 && sc<dc) ? sc+1 : b1*per;           // channel just left of the region the net enters
      if(back.has(w.id)) c = dc - (dc%per);                 // a loop turns at the left of its row
      if(!seen.has(c)){ seen.add(c); chanBefore[c]++; }
      if(w.bus) busIn[c] = true;
      if(b0!==b1 && b0>=0) chanAfterBand[b0]++;
    }
  }
  consts.forEach(k=>{ const w = s.wires.find(x=>x.from.node===k.id); const dn = w && byId.get(w.to.node);
    if(dn && coreSet.has(dn.id)) chanBefore[col.get(dn.id)] += 3; });

  // --- rows: columns left → right, each part lined up with what feeds it
  const pos = new Map();                                    // id → {x,y}
  let bandTop = 0; const bandBox = [];
  for(let r=0;r<rows;r++){
    const c0 = r*per, c1 = Math.min(K, (r+1)*per);
    let x = 0;
    const leftCh = Math.round((40 + 18*chanBefore[c0])*wide);
    x = leftCh;
    let minY = Infinity, maxY = -Infinity;
    for(let c=c0;c<c1;c++){
      if(c>c0) x += Math.round((50 + 18*chanBefore[c] + (busIn[c]?40:0))*wide);
      x = snapG(x);
      const placed = [];
      const want = cols[c].map(n=>{
        // the strongest wire in from an already-placed part in THIS row sets the row
        let best=null, bestN=-1, bestPin=1e9;
        const cnt = new Map();
        pred.get(n.id).forEach(e=>{ if(!back.has(e.w.id)&&pos.has(e.from)&&bandOf(col.get(e.from))===r) cnt.set(e.from,(cnt.get(e.from)||0)+1); });
        pred.get(n.id).forEach(e=>{
          if(back.has(e.w.id)||!pos.has(e.from)||bandOf(col.get(e.from))!==r) return;
          const p = byId.get(e.from), pp = pinPos(p, e.w.from.pin), mp = pinPos(n, e.w.to.pin);
          if(!pp||!mp||mp.side!=='left') return;
          const idx = (n.pinsL||[]).length ? +String(e.w.to.pin).replace(/\D/g,'')||0 : 0;
          const nn = cnt.get(e.from);
          if(nn>bestN || (nn===bestN && idx<bestPin)){ bestN=nn; bestPin=idx;
            best = pos.get(e.from).y + (pp.y - p.y) - (mp.y - n.y); }
        });
        return {n, y: best};
      });
      // keep the column's own order for parts nothing lines up, sort the rest by row
      want.sort((a,b)=>(a.y==null?1e9:a.y)-(b.y==null?1e9:b.y));
      let floor = -Infinity;
      want.forEach(({n,y})=>{
        const bb = body(n), top = n.y - bb.y1;             // label height above n.y
        let ny = (y==null) ? (floor===-Infinity ? top : floor + 40 + top) : y;
        if(floor!==-Infinity) ny = Math.max(ny, floor + 40 + top);
        pos.set(n.id, {x: x + (n.type==='gate' && /^(xor|xnor)$/.test(n.gate) ? 7 : 0), y: ny});
        const bot = ny + (bb.y2 - n.y);
        floor = bot; minY = Math.min(minY, ny - top); maxY = Math.max(maxY, bot);
        placed.push(n);
      });
      x += colW[c];
    }
    // shift the row so it starts at bandTop
    const dy = bandTop - (isFinite(minY)?minY:0);
    for(let c=c0;c<c1;c++) cols[c].forEach(n=>{ const p=pos.get(n.id); p.y+=dy; });
    const rightCh = Math.round((40 + 18*chanAfterBand[r])*wide);
    bandBox.push({top:bandTop, bot:(isFinite(maxY)?maxY:0)+dy, right:x+rightCh, leftCh});
    bandTop = (isFinite(maxY)?maxY:0) + dy + Math.round((60 + 18*chanAfterBand[r])*wide);
  }
  // apply, on the grid
  // x on the grid; y exactly where alignment put it (pins are on a 22 pitch, not the grid)
  core.forEach(n=>{ const p = pos.get(n.id); n.x = snapG(p.x); n.y = Math.round(p.y); });

  // --- frame around the parts; ports on it, consts next to what they feed
  const W = Math.max(...bandBox.map(b=>b.right), 200);
  const loops = s.wires.filter(w=>back.has(w.id)).length;
  const frameTop = -60, frameBot = bandBox[bandBox.length-1].bot + Math.round((40 + 18*loops)*wide);
  const f = {x:-10, y:frameTop, w:W+10, h:frameBot-frameTop};

  consts.forEach(k=>{
    const ws = s.wires.filter(w=>w.from.node===k.id).map(w=>tip(s,w.to)).filter(Boolean).sort((a,b)=>a.y-b.y);
    if(!ws.length) return;
    // the constant sits a little left of the first pin it feeds, on its row
    k.x = snapG(ws[0].x - 40 - 16); k.y = ws[0].y - 6;
  });
  const placePorts = (list, xAt, sideSrc) => {
    const want = list.map(p=>{
      const ends = s.wires.filter(w=>sideSrc ? w.from.node===p.id : w.to.node===p.id)
                          .map(w=>tip(s, sideSrc ? w.to : w.from)).filter(Boolean);
      // an input lines up with its FIRST (left-most, then top-most) pin; an output with its source
      ends.sort((a,b)=>(a.x-b.x)||(a.y-b.y));
      return {p, y: ends.length ? ends[0].y : null, end: ends[0]};
    });
    // the row from the frame to the pin must not run into another part; if it does,
    // take the nearest clear row and let the wire step once, next to the pin
    // keep the pins' own top-to-bottom order (D0 above D1), whatever row each one ends up on
    want.forEach(o=>{ o.order = o.y==null ? 1e9 : o.y; });
    want.forEach(o=>{ if(o.y==null||!o.end) return;
      const lo=Math.min(xAt,o.end.x), hi=Math.max(xAt,o.end.x);
      const hits = yy => core.some(n=>{ const b=body(n); return n!==o.end.n&&yy>b.y1-BODY_PAD&&yy<b.y2+BODY_PAD&&hi>b.x1&&lo<b.x2; });
      if(hits(o.y)) for(let d=G; d<400; d+=G){ if(!hits(o.y+d)){ o.y+=d; break; } if(!hits(o.y-d)){ o.y-=d; break; } } });
    want.sort((a,b)=>a.order-b.order);
    let last = -Infinity;
    want.forEach(({p,y})=>{ let ny = (y==null) ? last+40 : y;
      if(ny < last+16) ny = last+16; p.x = xAt; p.y = ny; last = ny; });
  };
  placePorts(ins, f.x+10, true);
  placePorts(outs, f.x+f.w-10, false);
  // the frame must hold every port row too
  const ys = nodes.filter(n=>n.type==='port').map(n=>n.y);
  if(ys.length){ const lo=Math.min(...ys)-30, hi=Math.max(...ys)+30;
    if(lo<f.y){ f.h+=f.y-lo; f.y=lo; } if(hi>f.y+f.h) f.h=hi-f.y; }

  // --- move everything to the sheet's usual spot
  const OX = 160 - f.x, OY = 170 - f.y;
  nodes.forEach(n=>{ if(isCore(n)||n.type==='port'||n.type==='const'){ n.x=Math.round(n.x+OX); n.y=Math.round(n.y+OY); } });
  s.frame = {x:f.x+OX, y:f.y+OY, w:f.w, h:f.h};
  s.wires.forEach(w=>{ w.auto = true; delete w.mx; delete w.my; });
  const r = route(s);
  // crowded channels → spread the columns and try again (at most twice)
  if(r.relaxed && (opts.widen||0) < 2) return layout(s, Object.assign({}, opts, {widen:(opts.widen||0)+1}));
  return {cols:K, bands:rows, relaxed:r.relaxed};
}

/* ============================ routing ============================ */
function route(s){
  const f = s.frame;
  const wires = s.wires.filter(w=>w.auto || !(Array.isArray(w.pts)&&w.pts.length));
  const fixed = s.wires.filter(w=>!wires.includes(w));
  const nets = new Map();
  wires.forEach(w=>{ const k=netKey(w); (nets.get(k)||nets.set(k,[]).get(k)).push(w); });

  // ---- track lines: every pin tip, plus the grid (minus lines that would crowd a pin row)
  const xsSet = new Set(), ysSet = new Set(), keepX=[], keepY=[];
  const ends = [];
  s.wires.forEach(w=>[w.from,w.to].forEach(r=>{ const t=tip(s,r); if(t){ ends.push(t); keepX.push(Math.round(t.x)); keepY.push(Math.round(t.y)); } }));
  s.nodes.forEach(n=>pins(n).forEach(p=>{ const L=leadOf(n); if(!L) return; const d=dirOf(p.side); keepX.push(Math.round(p.x+d[0]*L)); keepY.push(Math.round(p.y+d[1]*L)); }));
  keepX.forEach(v=>xsSet.add(v)); keepY.forEach(v=>ysSet.add(v));
  const X0 = f.x+5, X1 = f.x+f.w-5, Y0 = f.y+5, Y1 = f.y+f.h-5;
  for(let x=Math.ceil(X0/G)*G; x<=X1; x+=G) if(!keepX.some(k=>Math.abs(k-x)<5&&k!==x)) xsSet.add(x);
  for(let y=Math.ceil(Y0/G)*G; y<=Y1; y+=G) if(!keepY.some(k=>Math.abs(k-y)<5&&k!==y)) ysSet.add(y);
  const xs = [...xsSet].sort((a,b)=>a-b), ys = [...ysSet].sort((a,b)=>a-b);
  const NX = xs.length, NY = ys.length, N = NX*NY;
  const xi = new Map(xs.map((v,i)=>[v,i])), yi = new Map(ys.map((v,i)=>[v,i]));
  const id = (i,j)=>j*NX+i;

  // ---- obstacles: bodies (+pad), pin leads, and anything outside the frame
  const blocked = new Uint8Array(N);
  const boxes = s.nodes.map(body).filter(Boolean);
  for(let j=0;j<NY;j++) for(let i=0;i<NX;i++){
    const x=xs[i], y=ys[j];
    if(x<X0||x>X1||y<Y0||y>Y1){ blocked[id(i,j)]=1; continue; }
    for(const b of boxes) if(x>b.x1-BODY_PAD&&x<b.x2+BODY_PAD&&y>b.y1-BODY_PAD&&y<b.y2+BODY_PAD){ blocked[id(i,j)]=1; break; }
  }
  // a pin tip is never blocked (the body pad covers the lead, not its end)
  const tipOwner = new Map();                               // point id → net key using it
  const pinTips = new Set();
  s.nodes.forEach(n=>pins(n).forEach(p=>{
    const d = dirOf(p.side), L = leadOf(n);
    const tx = Math.round(p.x+d[0]*L), ty = Math.round(p.y+d[1]*L);
    // the lead itself (body edge → tip) is part of the symbol: nothing may cross it,
    // or a passing wire reads as connected to that pin
    // behind the tip, opposite to where the wire leaves: into a part, but OUT past a port's tail
    const od = (n.type==='port'||n.type==='netlabel') ? [-d[0],-d[1]] : d;
    const bx = tx - od[0]*16, by = ty - od[1]*16;
    for(let j=0;j<NY;j++) for(let i=0;i<NX;i++){
      const x=xs[i], y=ys[j];
      if(d[1]===0 ? (Math.abs(y-ty)<0.5 && x>Math.min(bx,tx)-0.5 && x<Math.max(bx,tx)+0.5 && Math.abs(x-tx)>0.5)
                  : (Math.abs(x-tx)<0.5 && y>Math.min(by,ty)-0.5 && y<Math.max(by,ty)+0.5 && Math.abs(y-ty)>0.5)) blocked[id(i,j)]=1;
    }
    if(xi.has(tx)&&yi.has(ty)){ const k=id(xi.get(tx),yi.get(ty)); blocked[k]=0; pinTips.add(k); }
  }));
  // ---- occupancy by other nets
  const hOwn = new Array(N).fill(null);   // edge (i,j)→(i+1,j)
  const vOwn = new Array(N).fill(null);   // edge (i,j)→(i,j+1)
  const pOwn = new Array(N).fill(null);   // point used by a net
  const pHard= new Array(N).fill(null);   // point is a corner / end / junction of a net
  const net2 = new Map();                 // key → tree {parent: Map}
  const claimPath = (key, pts) => {       // pts: [[i,j],...] grid path
    for(let a=0;a<pts.length;a++){
      const [i,j]=pts[a], k=id(i,j); pOwn[k]=pOwn[k]||key;
      if(a===0||a===pts.length-1) pHard[k]=key;
      else { const [pi,pj]=pts[a-1],[ni,nj]=pts[a+1]; if((pi===i)!==(ni===i)) pHard[k]=key; }
      if(a){ const [pi,pj]=pts[a-1];
        if(pj===j) hOwn[id(Math.min(pi,i),j)]=key; else vOwn[id(i,Math.min(pj,j))]=key; }
    }
  };
  // hand-drawn wires stay as the user drew them — they are obstacles here
  fixed.forEach(w=>{ const r = routeThrough(w); if(!r) return;
    const k = netKey(w), gp = [];
    for(let a=1;a<r.pts.length;a++){
      const [x0,y0]=r.pts[a-1],[x1,y1]=r.pts[a];
      const i0=nearest(xs,x0), j0=nearest(ys,y0), i1=nearest(xs,x1), j1=nearest(ys,y1);
      const seg=[]; if(j0===j1) for(let i=i0;i!==i1+Math.sign(i1-i0||1);i+=Math.sign(i1-i0||1)) seg.push([i,j0]);
      else for(let j=j0;j!==j1+Math.sign(j1-j0||1);j+=Math.sign(j1-j0||1)) seg.push([i0,j]);
      claimPath(k, seg);
    } });

  const DIRS = [[1,0],[0,1],[-1,0],[0,-1]];
  const dIdx = d => d[0]===1?0:d[1]===1?1:d[0]===-1?2:3;
  const BEND = 34, CROSS = 28, NEAR = 3;
  const near = (key, i, j, horiz) => {      // another net's parallel run on a track < 9 away
    let c=0;
    if(horiz){ for(const dj of [-1,1]){ const jj=j+dj; if(jj<0||jj>=NY||Math.abs(ys[jj]-ys[j])>=9) continue;
        const o=hOwn[id(i,jj)]; if(o&&o!==key) c++; } }
    else { for(const di of [-1,1]){ const ii=i+di; if(ii<0||ii>=NX||Math.abs(xs[ii]-xs[i])>=9) continue;
        const o=vOwn[id(ii,j)]; if(o&&o!==key) c++; } }
    return c;
  };

  /* A* from a sink back to the net's tree. `goal(k,dir)` accepts the end state. */
  function search(key, start, startDir, goal, relax){
    const S = N*4, gC = new Float64Array(S).fill(Infinity), from = new Int32Array(S).fill(-1);
    const heap = []; const push=(f,st)=>{ heap.push([f,st]); let c=heap.length-1; while(c){ const p=(c-1)>>1; if(heap[p][0]<=heap[c][0]) break; [heap[p],heap[c]]=[heap[c],heap[p]]; c=p; } };
    const pop=()=>{ const top=heap[0], last=heap.pop(); if(heap.length){ heap[0]=last; let c=0; for(;;){ let l=2*c+1,r=l+1,m=c; if(l<heap.length&&heap[l][0]<heap[m][0]) m=l; if(r<heap.length&&heap[r][0]<heap[m][0]) m=r; if(m===c) break; [heap[m],heap[c]]=[heap[c],heap[m]]; c=m; } } return top; };
    const st0 = start*4+startDir; gC[st0]=0; push(0,st0);
    while(heap.length){
      const [fc,st] = pop(); const k = (st/4)|0, d = st%4, g = gC[st];
      if(fc>g+1e6) continue;
      if(k!==start && goal(k,d)) return {st, from};
      const i = k%NX, j = (k/NX)|0;
      for(let nd=0;nd<4;nd++){
        if(nd===((d+2)%4)) continue;                       // no U-turn
        const [dx,dy] = DIRS[nd], ni=i+dx, nj=j+dy;
        if(ni<0||nj<0||ni>=NX||nj>=NY) continue;
        const nk = id(ni,nj);
        let cost = Math.abs(xs[ni]-xs[i]) + Math.abs(ys[nj]-ys[j]);
        if(nd!==d){
          // a corner may not sit on another net's line — it would read as a join
          if(pOwn[k]&&pOwn[k]!==key){ if(!relax) continue; cost+=400; }
          if(k===start && !relax) continue;               // leave a pin along its lead
          cost += BEND;
        }
        if(blocked[nk] && !goal(nk,nd)){ if(!relax) continue; cost += 600; }
        const horiz = dy===0, eo = horiz ? hOwn[id(Math.min(i,ni),j)] : vOwn[id(i,Math.min(j,nj))];
        if(eo && eo!==key){ if(!relax) continue; cost += 300; }  // never share a run with another net
        const po = pOwn[nk];
        if(po && po!==key){
          if(pHard[nk] && pHard[nk]!==key){ if(!relax) continue; cost += 300; }
          if(pinTips.has(nk) && !goal(nk,nd)){ if(!relax) continue; cost += 300; }
          cost += CROSS;
        } else if(pinTips.has(nk) && !goal(nk,nd)){ if(!relax) continue; cost+=300; }
        cost += NEAR*near(key, horiz?Math.min(i,ni):i, horiz?j:Math.min(j,nj), horiz)*(Math.abs(xs[ni]-xs[i])+Math.abs(ys[nj]-ys[j]))/G;
        const ns = nk*4+nd, ng = g+cost;
        if(ng < gC[ns]){ gC[ns]=ng; from[ns]=st; push(ng, ns); }
      }
    }
    return null;
  }
  const unwind = (res) => { const out=[]; for(let st=res.st; st>=0; st=res.from[st]) out.push((st/4)|0); return out; };  // goal … start

  // ---- order: straight 2-pin nets first, then by size; big fan-outs last
  const info = [...nets.entries()].map(([k,ws])=>{
    const a = tip(s, ws[0].from); const bs = ws.map(w=>tip(s,w.to)).filter(Boolean);
    const span = bs.reduce((m,b)=>m+Math.abs(b.x-a.x)+Math.abs(b.y-a.y),0);
    const straight = ws.length===1 && bs[0] && Math.abs(bs[0].y-a.y)<1;
    return {k, ws, a, span, straight};
  }).filter(o=>o.a);
  info.sort((p,q)=>(q.straight-p.straight)||(p.ws.length-q.ws.length)||(p.span-q.span));

  let relaxed = 0;
  const gpt = t => (xi.has(Math.round(t.x))&&yi.has(Math.round(t.y))) ? id(xi.get(Math.round(t.x)), yi.get(Math.round(t.y))) : -1;
  for(const it of info){
    const src = gpt(it.a); if(src<0) continue;
    const sd = outDir(s, it.ws[0].from);
    const tree = new Map([[src, -1]]);                     // point → parent (toward source)
    const treeHard = new Set([src]);
    const sinks = it.ws.map(w=>({w, t:tip(s,w.to)})).filter(o=>o.t)
                       .sort((p,q)=>(Math.abs(p.t.x-it.a.x)+Math.abs(p.t.y-it.a.y))-(Math.abs(q.t.x-it.a.x)+Math.abs(q.t.y-it.a.y)));
    const into = dIdx([-sd[0],-sd[1]]);                   // arriving at the source against its lead
    for(const sk of sinks){
      const st = gpt(sk.t); if(st<0) continue;
      if(tree.has(st)) continue;
      const od = dIdx(outDir(s, sk.w.to));
      const goal = (k,d) => tree.has(k) && (k!==src || d===into) && !(k!==src && treeHard.has(k) && pinTips.has(k));
      let res = search(it.k, st, od, goal, false);
      if(!res){ res = search(it.k, st, od, goal, true); relaxed++; }
      if(!res) continue;
      const path = unwind(res);                             // [join, …, sink]
      const join = path[0];
      for(let a=1;a<path.length;a++) tree.set(path[a], path[a-1]);
      path.forEach(p=>{ if(!tree.has(p)) tree.set(p, -1); });
      const gp = path.map(k=>[k%NX,(k/NX)|0]);
      claimPath(it.k, gp);
      treeHard.add(join); treeHard.add(path[path.length-1]);   // never branch off at a pin
    }
    net2.set(it.k, tree);
    // each wire = its sink walked back to the source through the tree
    for(const sk of sinks){
      let k = gpt(sk.t); const seq = [];
      const guard = new Set();
      while(k>=0 && !guard.has(k)){ guard.add(k); seq.push([xs[k%NX], ys[(k/NX)|0]]); k = tree.has(k) ? tree.get(k) : -1; }
      seq.reverse();                                        // source … sink
      const pts = [];
      seq.forEach(p=>{ const n=pts.length;
        if(n>=2){ const a=pts[n-2], b=pts[n-1];
          if((a[0]===b[0]&&b[0]===p[0])||(a[1]===b[1]&&b[1]===p[1])){ pts[n-1]=p; return; } }
        pts.push(p); });
      sk.w.pts = pts.slice(1,-1);
      sk.w.exact = true; sk.w.auto = true;
    }
  }
  return {relaxed};
}
function nearest(arr, v){ let b=0,bd=Infinity; arr.forEach((a,i)=>{ const d=Math.abs(a-v); if(d<bd){bd=d;b=i;} }); return b; }

window.TDE = {layout, route};
})();
