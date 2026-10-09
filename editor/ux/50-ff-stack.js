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
function ffStackLayout(sch){
  const G=GRID, comps=sch.components, by=id=>comps.find(c=>c.id===id), sz=c=>getSize(c);
  // the flip-flops, bottom to top: ff0, ff1, … then any other (the divider's toggle "tq")
  const ffs=comps.filter(c=>FFS_TYPES[c.type]).sort((a,b)=>{
    const ia=/^ff(\d+)$/.exec(a.id), ib=/^ff(\d+)$/.exec(b.id);
    return (ia?+ia[1]:1e6)-(ib?+ib[1]:1e6) || String(a.id).localeCompare(String(b.id)); });
  if(ffs.length<2) return false;
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
  const putAt=(c,x,wantY)=>{ c.x=x; c.y=0; const o=portPos(c,"o")||{y:sz(c).h/2}; let y=snap(wantY-o.y), k=0;
    for(;k<80 && !free(x,y,sz(c).h);k++) y+=(k%2?1:-1)*G*(k+1);      // nearest free slot, up or down
    c.y=y; used.push({x,y,h:sz(c).h}); };
  ffs.forEach(f=>used.push({x:X_FF, y:f.y, h:sz(f).h}));
  for(let d=0; d<=maxDepth; d++)
    queue.filter(g=>info.get(g.id).depth===d)
      .sort((a,b)=>portPos(info.get(a.id).cons, info.get(a.id).pin).y-portPos(info.get(b.id).cons, info.get(b.id).pin).y)
      .forEach(g=>{ const v=info.get(g.id); putAt(g, colX(d), portPos(v.cons, v.pin).y); });
  // constants beside the pin they hold
  comps.filter(c=>(c.type==="VCC"||c.type==="GND") && info.get(c.id)).forEach(c=>{ const v=info.get(c.id), p=portPos(v.cons, v.pin);
    c.x=X_FF-G*6; c.y=snap(p.y-(c.type==="VCC"?G*4:-G)); });
  // logic that feeds no flip-flop (rare): a column of its own, below
  let yLoose=Y0+(top+1)*ROW;
  comps.filter(c=>isLogic(c) && !info.has(c.id)).forEach(c=>{ c.x=colX(maxDepth+1); c.y=yLoose; yLoose+=sz(c).h+G*2; });
  // ports: INPUTs bottom-left (the clock under bit 0), OUTPUTs right, level with what drives them
  const ins=comps.filter(c=>c.type==="IN"), xIn=colX(maxDepth+(comps.some(c=>isLogic(c)&&!info.has(c.id))?2:1))-G*4;
  ins.forEach((c,k)=>{ c.x=xIn; c.y=snap(ffs[0].y+ffH+G*3+k*G*4); });
  comps.filter(c=>c.type==="OUT").forEach(c=>{ const d=drv(c.id,"i"); let y=null;
    if(d){ const pid=FFS_TYPES[d.type] ? "q" : "o", p=portPos(d,pid); if(p) y=p.y; }
    c.x=X_FF+G*18; c.y=0; const pi=portPos(c,"i"); c.y=snap((y!=null?y:Y0)-pi.y); });
  try{ normalizePortFanout(sch); }catch(_){}
  try{ wtTidySheet(sch); }catch(e){ console.warn("ff stack layout", e); }
  sch.locked=true;                                            // keep the drawing as placed (as the JK counter)
  return true;
}
/* the two generators mark their intents; drawIntent places them (one route, after placing) */
{
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
