/* ===== 50. Synchronous counters / dividers drawn like the lab sheet =============================
   The clock divider (15: dividerIntent) and the D-FF mod-N counter (fsmCounterIntent) came out as one
   long left-to-right row — hard to read and to tidy. They are now drawn like the JK counter (jkLayout):
   the flip-flops in one column on the right, bit 0 at the BOTTOM up to the last bit at the top (the
   divider's clk_out toggle above them), and every gate in a column to the left, level with the pin it
   feeds — gates that feed a flip-flop directly next to it, the ones feeding those one column further
   out, and so on. clk_in bottom-left, each OUTPUT level with the Q it shows. Then the wires are routed
   once (12-wire-tidy) and the sheet is locked as placed, like the JK counter. */
const FFS_TYPES={DFF:1, JKFF:1, TFF:1, SRFF:1};
const FFS_CLOCK_PINS=new Set(["clk","c","ck"]);
/* which pins are joined (junctions passed through): the drawing may move, this may not */
function ffsNetSig(sch){
  const par=new Map(), f=k=>{ if(!par.has(k)) par.set(k,k); while(par.get(k)!==k){ par.set(k, par.get(par.get(k))); k=par.get(k); } return k; };
  sch.wires.forEach(w=>{ const a=f(w.from.cid+":"+w.from.pid), b=f(w.to.cid+":"+w.to.pid); if(a!==b) par.set(a,b); });
  const J=new Set(sch.components.filter(c=>c.type==="JUNCTION").map(c=>c.id)), nets=new Map();
  [...par.keys()].forEach(k=>{ if(J.has(k.split(":")[0])) return; const r=f(k); (nets.get(r)||nets.set(r,[]).get(r)).push(k); });
  return [...nets.values()].map(v=>v.sort().join(",")).sort().join("|");
}
function ffStackLayout(sch){
  const G=GRID, comps=sch.components, by=id=>comps.find(c=>c.id===id), sz=c=>getSize(c);
  if(comps.filter(c=>FFS_TYPES[c.type]).length<2) return false;
  const sig0=ffsNetSig(sch), saved=JSON.stringify({components:sch.components, wires:sch.wires});
  // nets: every pin → its net; a net's driver = the pin on it that is an output
  const parent=new Map(), key=(cid,pid)=>cid+"\u0001"+pid;
  const find=k=>{ while(parent.get(k)!==k){ parent.set(k, parent.get(parent.get(k))); k=parent.get(k); } return k; };
  const add=k=>{ if(!parent.has(k)) parent.set(k,k); };
  const union=(a,b)=>{ add(a); add(b); const ra=find(a), rb=find(b); if(ra!==rb) parent.set(ra, rb); };
  sch.wires.forEach(w=>union(key(w.from.cid,w.from.pid), key(w.to.cid,w.to.pid)));
  comps.filter(c=>c.type==="JUNCTION").forEach(j=>add(key(j.id,"j")));
  const driver=new Map();
  for(const k of parent.keys()){ const [cid,pid]=k.split("\u0001"), c=by(cid); if(!c || c.type==="JUNCTION") continue;
    const p=getPort(c,pid); if(p && p.dir==="out") driver.set(find(k), c); }
  const drv=(cid,pid)=>parent.has(key(cid,pid)) ? driver.get(find(key(cid,pid)))||null : null;
  const inPins=c=>(TYPES[c.type].ports(c.params||{})||[]).filter(p=>p.dir==="in").map(p=>p.id);
  const isLogic=c=>c && !FFS_TYPES[c.type] && !["IN","OUT","JUNCTION","VCC","GND"].includes(c.type);
  // the flip-flops, bottom to top by bit: the number of the OUTPUT its q shows (q0, q1 …), else ff0, ff1 …,
  // then any other (the divider's toggle "tq")
  const bitOf=new Map();
  comps.filter(c=>c.type==="OUT").forEach(o=>{ const d=drv(o.id,"i"), m=/(\d+)$/.exec(String(o.params&&o.params.name||o.name||""));
    if(d && FFS_TYPES[d.type] && m && !bitOf.has(d.id)) bitOf.set(d.id, +m[1]); });
  const rank=c=>{ if(bitOf.has(c.id)) return bitOf.get(c.id); const m=/^ff(\d+)$/.exec(c.id); return m ? +m[1] : 1e6; };
  const ffs=comps.filter(c=>FFS_TYPES[c.type]).sort((a,b)=>rank(a)-rank(b) || String(a.id).localeCompare(String(b.id)));
  // place the flip-flops
  const ffH=Math.max(...ffs.map(f=>sz(f).h)), ROW=snap(Math.max(G*12, ffH+G*6));
  const X_FF=G*60, Y0=G*10, top=ffs.length-1;
  ffs.forEach((f,i)=>{ f.x=X_FF; f.y=Y0+(top-i)*ROW; });
  // walk back from each flip-flop's data pins, nearest first: depth 0 feeds a flip-flop, depth k feeds depth k−1
  const info=new Map(), queue=[];
  ffs.forEach(f=>inPins(f).filter(p=>!FFS_CLOCK_PINS.has(p)).forEach(pid=>{ const d=drv(f.id,pid);
    if(isLogic(d) && !info.has(d.id)){ info.set(d.id,{depth:0, cons:f, pin:pid}); queue.push(d); }
    else if(d && (d.type==="VCC"||d.type==="GND") && !info.has(d.id)) info.set(d.id,{depth:0, cons:f, pin:pid, rail:true}); }));
  for(let q=0;q<queue.length;q++){ const g=queue[q], dg=info.get(g.id).depth;
    inPins(g).forEach(pid=>{ const d=drv(g.id,pid); if(isLogic(d) && !info.has(d.id)){ info.set(d.id,{depth:dg+1, cons:g, pin:pid}); queue.push(d); } }); }
  // columns from the flip-flops leftwards, widened for the widest gate
  const maxDepth=Math.max(0, ...[...info.values()].map(v=>v.depth));
  const colW=snap(Math.max(G*10, ...comps.filter(isLogic).map(c=>sz(c).w+G*5)));
  const colX=d=>X_FF-colW*(d+1);
  const used=[];
  const free=(x,y,h)=>!used.some(u=>u.x===x && y<u.y+u.h+G && u.y<y+h+G);
  // a part's vertical extent from its pins too: a 4-input AND's pins reach past its box (its i3 sat on the
  // i0 of the gate below and the router joined the two nets — the m=10 down counter's en shorted to q0n)
  const span=c=>{ const y0=c.y, ys=[0, sz(c).h, ...getPorts(c).map(p=>(portPos(c,p.id)||{y:y0}).y-y0)];
    return {lo:Math.min(...ys), hi:Math.max(...ys)}; };
  const putAt=(c,x,wantY)=>{ c.x=x; c.y=0; const o=portPos(c,"o")||{y:sz(c).h/2}, e=span(c); let y=snap(wantY-o.y), k=0;
    for(;k<80 && !free(x,y+e.lo,e.hi-e.lo);k++) y+=(k%2?1:-1)*G*(k+1);      // nearest free slot, up or down
    if(!free(x,y+e.lo,e.hi-e.lo))                                          // a full column: below its last part
      y=snap(Math.max(...used.filter(u=>u.x===x).map(u=>u.y+u.h))+G*2-e.lo);
    c.y=y; used.push({x,y:y+e.lo,h:e.hi-e.lo}); };
  ffs.forEach(f=>{ const e=span(f); used.push({x:X_FF, y:f.y+e.lo, h:e.hi-e.lo}); });
  for(let d=0; d<=maxDepth; d++)
    queue.filter(g=>info.get(g.id).depth===d)
      .sort((a,b)=>portPos(info.get(a.id).cons, info.get(a.id).pin).y-portPos(info.get(b.id).cons, info.get(b.id).pin).y)
      .forEach(g=>{ const v=info.get(g.id); putAt(g, colX(d), portPos(v.cons, v.pin).y); });
  // constants beside the pin they hold
  comps.filter(c=>(c.type==="VCC"||c.type==="GND") && info.get(c.id)).forEach(c=>{ const v=info.get(c.id), p=portPos(v.cons, v.pin);
    c.x=X_FF-G*6; c.y=snap(p.y-(c.type==="VCC"?G*4:-G)); });
  // logic that only feeds OUTPUTs (a counter's tc): columns right of the flip-flops, the gate an OUTPUT
  // reads nearest the OUTPUT, below bit 0
  const ffW=Math.max(...ffs.map(f=>sz(f).w)), right=new Map(), rq=[];
  comps.filter(c=>c.type==="OUT").forEach(o=>{ const d=drv(o.id,"i"); if(isLogic(d) && !info.has(d.id) && !right.has(d.id)){ right.set(d.id,0); rq.push(d); } });
  for(let q=0;q<rq.length;q++){ const g=rq[q], dg=right.get(g.id);
    inPins(g).forEach(pid=>{ const d=drv(g.id,pid); if(isLogic(d) && !info.has(d.id) && !right.has(d.id)){ right.set(d.id, dg+1); rq.push(d); } }); }
  const rDepth=right.size ? Math.max(...right.values()) : -1, X_R=snap(X_FF+ffW+G*6);
  for(let d=rDepth, k=0; d>=0; d--, k++){ let y=ffs[0].y+ffH+G*3;
    rq.filter(g=>right.get(g.id)===d).forEach(g=>{ const x=X_R+k*colW; g.x=x; g.y=0; const o=portPos(g,"o"); putAt(g, x, y+(o?o.y:sz(g).h/2)); y=g.y+sz(g).h+G*3; }); }
  const X_OUT=right.size ? X_R+(rDepth+1)*colW+G*2 : X_FF+G*18;
  // logic that feeds no flip-flop and no OUTPUT (rare): a column of its own, below
  let yLoose=Y0+(top+1)*ROW;
  const loose=comps.filter(c=>isLogic(c) && !info.has(c.id) && !right.has(c.id));
  loose.forEach(c=>{ c.x=colX(maxDepth+1); c.y=yLoose; yLoose+=sz(c).h+G*2; });
  // ports: INPUTs bottom-left (the clock under bit 0), OUTPUTs right, level with what drives them
  const ins=comps.filter(c=>c.type==="IN"), xIn=colX(maxDepth+(loose.length?2:1))-G*4;
  ins.forEach((c,k)=>{ c.x=xIn; c.y=snap(ffs[0].y+ffH+G*3+k*G*4); });
  comps.filter(c=>c.type==="OUT").forEach(c=>{ const d=drv(c.id,"i"); let y=null;
    if(d){ const pid=FFS_TYPES[d.type] ? "q" : "o", p=portPos(d,pid); if(p) y=p.y; }
    c.x=X_OUT; c.y=0; const pi=portPos(c,"i"); c.y=snap((y!=null?y:Y0)-pi.y); });
  try{ normalizePortFanout(sch); }catch(_){}
  try{ wtTidySheet(sch); }catch(e){ console.warn("ff stack layout", e); }
  // never at the price of a wrong circuit: if the routed sheet joins pins differently, put it back as drawn
  if(ffsNetSig(sch)!==sig0){ console.warn("ff stack layout changed the nets — drawn the usual way");
    const o=JSON.parse(saved); sch.components=o.components; sch.wires=o.wires; return false; }
  sch.locked=true;                                            // keep the drawing as placed (as the JK counter)
  return true;
}
/* the generators mark their intents; drawIntent places them (one route, after placing) */
{
  // the library's counters (counter_digit: clk/en/clr → q, tc; the ripple binary counter) and Tools ▸ ตัวนับ
  ["counter_digit","binary_counter"].forEach(k=>{ const P=typeof PARTS!=="undefined" && PARTS[k]; if(!P) return; const _b=P.build;
    P.build=function(){ const r=_b.apply(this, arguments); if(r && !r.error) r.layout="ffstack"; return r; }; });
  const _seq=seqBuildIntent;
  seqBuildIntent=function(msg){ const r=_seq.apply(this, arguments);
    if(r && r.intent && /^counter/.test(String(r.intent.module||""))) r.intent.layout="ffstack"; return r; };
  const _div=dividerIntent;
  dividerIntent=function(){ const r=_div.apply(this, arguments); if(r && !r.error) r.layout="ffstack"; return r; };
  const _cnt=fsmCounterIntent;
  fsmCounterIntent=function(){ const r=_cnt.apply(this, arguments); if(r && !r.error) r.layout="ffstack"; return r; };
  const _draw=drawIntent;
  drawIntent=function(intent, opts){
    if(!intent || intent.layout!=="ffstack" || (opts&&opts.noRoute)) return _draw.apply(this, arguments);
    const r=_draw.call(this, intent, Object.assign({}, opts||{}, {noRoute:true}));
    if(r && r.ok){ try{ if(!ffStackLayout(r.sch)) autoRouteSheet(r.sch); }catch(e){ console.warn("ff stack", e); try{ autoRouteSheet(r.sch); }catch(_){} } }
    return r;
  };
}
