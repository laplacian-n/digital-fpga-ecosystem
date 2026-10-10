/* ===== 53. Top-Down sheets drawn like the lab hand drawings ======================================
   The exact 1:1 transfer (schematicToTopdownExact) copied the gate editor's own picture: wherever that
   picture was crowded the Top-Down page was too (bent wires, names on top of other boxes, D-FF labels
   on each other, ports inside the frame), and the squash to Top-Down's gate size moved pins off the
   wires. The lab sheets look different: blocks in columns by signal flow, the name above each box,
   inputs as bare names left of a dashed frame and outputs right of it, buses as one line with a
   slash and the width ("4 /"), an inverted gate input as a bubble. So a sheet is now REDRAWN for paper:
     1. the netlist is read from the sheet (junctions joined, unconnected pins dropped);
     2. a NOT that only feeds one gate input becomes the bubble on that input;
     3. numbered pins / ports that carry the same bits to the same place become one bus
        (u0..u3 → u0..u3 is drawn as u[3:0] — sw0..sw7 split over two blocks as sw[3:0] and sw[7:4];
        sa..sg as s[a:g]) — the circuit itself is not changed, only how it is drawn;
     4. parts go in columns by logic depth (feedback ignored), rows ordered to cut crossings, each
        part moved so the wire from what drives it runs straight;
     5. the wires are routed by THIS editor's router (12-wire-tidy) on a scratch sheet whose parts
        have exactly the Top-Down symbols' pin positions, so every wire ends on its pin;
     6. the result goes to Top-Down as an exact sheet with its own frame (paper:true).
   Anything this cannot draw (routing that would join the wrong pins) falls back to the 1:1 transfer. */
const TDP = { G: 11, LEAD: 10, PITCH: 22, BAND: 22, GAP: 22, PORT: 33 };
const TDP_GATES = {AND:"and", OR:"or", NAND:"nand", NOR:"nor", XOR:"xor", XNOR:"xnor", NOT:"not", BUF:"buf"};
const TDP_FF = {DFF:1, JKFF:1, TFF:1, SRFF:1};

/* a part only the router sees: a box whose pins sit where the Top-Down symbol's wires end */
{
  const _td = typeDef;
  typeDef = function(c){
    if(c && c.type==="TDNODE"){ const p = c.params; return {label:"", size:()=>({w:p.w, h:p.h}), ports:()=>p.pins}; }
    return _td.apply(this, arguments);
  };
}

/* the router guesses which way a wire leaves a pin from the middle of the part; on a tall block a pin
   near the top read as "leaves upward" and the wire stepped up and back into it. These pins say. */
{
  const _ex = wtExit;
  wtExit = function(c, pp){
    if(c && c.type==="TDNODE"){ const p = c.params.pins.find(q=>Math.abs(c.x+q.dx-pp.x)<0.5 && Math.abs(c.y+q.dy-pp.y)<0.5); if(p) return p.dx<=0 ? 2 : 0; }
    return _ex.apply(this, arguments);
  };
}

/* ---------- 1. the netlist, bit by bit ----------
   A wire carries every bit of its net; a bus tap joins bit (bit+i) of its bus to bit i of its thin
   side. So bits are the unit here: the drawing regroups them into buses in step 4, which is how a
   bus that is split over two blocks comes out as two buses instead of one tangle of taps. */
function tdpPinWidth(c, p, netW){
  if(c.type==="BUSTAP") return p.id==="d" ? netW : Math.max(1, +(c.params&&c.params.nbit)||1);
  if(c.type==="IN" || c.type==="OUT") return Math.max(1, +(c.params&&c.params.width)||1);
  return Math.max(1, +p.width||1);
}
function tdpNetlist(sch){
  const all = sch.components.filter(c=>c.type!=="JUNCTION"), byId = new Map(all.map(c=>[c.id, c]));
  const UF = ()=>{ const par = new Map(); const f = k=>{ if(!par.has(k)) par.set(k,k); while(par.get(k)!==k){ par.set(k, par.get(par.get(k))); k = par.get(k); } return k; };
    return {par, f, u:(a,b)=>{ a = f(a); b = f(b); if(a!==b) par.set(a, b); }}; };
  const P = UF(), key = ep=>byId.has(ep.cid) ? ep.cid+"."+ep.pid : "J:"+ep.cid;
  sch.wires.forEach(w=>P.u(key(w.from), key(w.to)));
  const pinOf = k=>{ const dot = k.lastIndexOf("."), c = byId.get(k.slice(0,dot)), p = c && getPort(c, k.slice(dot+1)); return p ? {c, p} : null; };
  const groups = new Map();
  [...P.par.keys()].forEach(k=>{ if(k.startsWith("J:") || !pinOf(k)) return; const r = P.f(k); (groups.get(r) || groups.set(r, []).get(r)).push(k); });
  const B = UF();
  groups.forEach((ks, r)=>{
    let W = 1; ks.forEach(k=>{ const {c, p} = pinOf(k); if(!(c.type==="BUSTAP" && p.id==="d")) W = Math.max(W, tdpPinWidth(c, p, 1)); });
    ks.forEach(k=>{ const {c, p} = pinOf(k), pw = tdpPinWidth(c, p, W); for(let b=0; b<pw && b<W; b++) B.u("N:"+r+"#"+b, k+"#"+b); });
  });
  all.filter(c=>c.type==="BUSTAP").forEach(c=>{ const b0 = +(c.params&&c.params.bit)||0, nb = Math.max(1, +(c.params&&c.params.nbit)||1);
    for(let i=0;i<nb;i++) B.u(c.id+".d#"+(b0+i), c.id+".y#"+i); });
  const nets = new Map();
  [...B.par.keys()].forEach(k=>{
    if(k.startsWith("N:")) return;
    const h = k.lastIndexOf("#"), x = pinOf(k.slice(0,h)); if(!x || x.c.type==="BUSTAP") return;
    const r = B.f(k), n = nets.get(r) || nets.set(r, {driver:null, sinks:[], width:1}).get(r);
    if(x.p.dir==="out"){ if(!n.driver) n.driver = k; } else n.sinks.push(k);
  });
  return {comps:all.filter(c=>c.type!=="BUSTAP"), byId, nets:[...nets.values()].filter(n=>n.driver && n.sinks.length)};
}

/* ---------- 2. the parts as drawn on paper (a W-bit pin is W one-bit pins until step 4) ---------- */
function tdpElements(sch, NL){
  const els = new Map(), pinOwner = new Map(), used = new Set();
  NL.nets.forEach(n=>{ used.add(n.driver); n.sinks.forEach(s=>used.add(s)); });
  const sub = c=>typeof subSchOf==="function" ? subSchOf(c) : null;
  // a sub-sheet input that clocks a flip-flop inside is a clock pin (the wedge), whatever its name
  const clockIns = s=>{ const out = new Set(); if(!s) return out;
    try{ const N = tdpNetlist(s), cidOf = k=>k.slice(0, k.lastIndexOf("."));
      N.nets.forEach(n=>{ const c = N.byId.get(cidOf(n.driver)); if(!c || c.type!=="IN") return;
        if(n.sinks.some(k=>{ const cc = N.byId.get(cidOf(k)); return cc && TDP_FF[cc.type] && /\.clk#/.test(k); })) out.add(sanId(c.params.name)); }); }catch(_){}
    return out; };
  const bits = (id, p, w, name, extra)=>Array.from({length:w}, (_, b)=>{ const k = id+"."+p.id+"#"+b; pinOwner.set(k, id);
    return Object.assign({key:k, name:w>1 ? name+"["+b+"]" : name, width:1}, extra||{}); });
  for(const c of NL.comps){
    const ports = getPorts(c), id = c.id;
    if(c.type==="IN" || c.type==="OUT"){
      const w = tdpPinWidth(c, ports[0], 1), nm = sanId(c.params.name||id);
      bits(id, ports[0], w, nm).forEach((pp, b)=>{ const eid = w>1 ? id+"#"+b : id; pinOwner.set(pp.key, eid);
        els.set(eid, {id:eid, kind:c.type==="IN"?"in":"out", name:pp.name, width:1, pins:[pp]}); });
    } else if(c.type==="VCC" || c.type==="GND" || c.type==="CONST"){
      const p = ports.find(q=>q.dir==="out"); if(!p) continue;
      const v = c.type==="GND" ? "0" : c.type==="VCC" ? "1" : String((c.params&&c.params.value)!=null ? c.params.value : 0);
      els.set(id, {id, kind:"const", value:"'"+v+"'", pins:bits(id, p, 1, "")});   // written '1' as on the sheets
    } else if(TDP_GATES[c.type]){
      const ins = ports.filter(p=>p.dir==="in").sort((a,b)=>a.dy-b.dy), out = ports.find(p=>p.dir==="out");
      els.set(id, {id, kind:"gate", gate:TDP_GATES[c.type], L:ins.flatMap(p=>bits(id, p, 1, "")), R:out?bits(id, out, 1, ""):[], inv:ins.map(()=>false)});
    } else {
      const s = sub(c), clk = clockIns(s), ff = !!TDP_FF[c.type];
      const keep = p=>!ff || used.has(id+"."+p.id+"#0") || /^(d|j|k|t|s|r|clk|q)$/.test(p.id);
      const side = d=>ports.filter(p=>p.dir===d && keep(p)).sort((a,b)=>(a.dy-b.dy)||(a.dx-b.dx));
      const label = s ? s.name : c.type==="MUX" ? "MUX "+((c.params&&c.params.inputs)||2)+":1" : (TYPES[c.type]&&TYPES[c.type].label) || String(c.type).replace(/^SCH:|^CUSTOM:/,"");
      const mk = p=>{ const nm = String(p.label||p.id), isClk = /^clk$/i.test(p.id) || clk.has(sanId(nm)) || /^clk$/i.test(nm);
        return bits(id, p, Math.max(1, +p.width||1), nm.replace(/\[.*\]$/, ""), {clk:isClk, inv:isClk && ff && !!c.params && c.params.edge==="falling"}); };
      els.set(id, {id, kind:"block", label, ref:/^(SCH|CUSTOM):/.test(String(c.type)) ? c.type : null, L:side("in").flatMap(mk), R:side("out").flatMap(mk)});
    }
  }
  const nets = NL.nets.map(n=>({driver:n.driver, sinks:n.sinks.slice(), width:1}))
    .filter(n=>pinOwner.has(n.driver) && (n.sinks = n.sinks.filter(s=>pinOwner.has(s))).length);
  return {els, pinOwner, nets};
}

/* ---------- 3. a NOT feeding one gate input → the bubble on that input ---------- */
function tdpBubbles(M){
  for(const g of [...M.els.values()]){
    if(g.kind!=="gate" || g.gate!=="not" || !g.R.length) continue;
    const out = M.nets.find(n=>n.driver===g.R[0].key), inn = M.nets.find(n=>n.sinks.includes(g.L[0].key));
    if(!out || !inn || out.sinks.length!==1 || out.width>1) continue;
    const t = M.els.get(M.pinOwner.get(out.sinks[0]));
    if(!t || t.kind!=="gate" || /^(not|buf)$/.test(t.gate)) continue;
    const i = t.L.findIndex(p=>p.key===out.sinks[0]); if(i<0 || t.inv[i]) continue;
    t.inv[i] = true;
    inn.sinks = inn.sinks.filter(s=>s!==g.L[0].key).concat([out.sinks[0]]);
    M.nets = M.nets.filter(n=>n!==out && (n!==inn || n.sinks.length));
    M.els.delete(g.id);
  }
}

/* ---------- 4. numbered pins that carry the same bits to the same place → one bus ---------- */
function tdpBuses(M){
  // groups: pins of one side of one part (ports: all inputs / all outputs) named prefix+index
  const groups = new Map(), at = new Map();
  const parse = nm=>{ let m = /^(.+)\[(\d+)\]$/.exec(nm); if(m) return {pre:m[1], i:+m[2], letter:false, br:true};
    m = /^(.*?[A-Za-z_])(\d+)$/.exec(nm); if(m) return {pre:m[1], i:+m[2], letter:false};
    m = /^(.*?[A-Za-z_0-9])_?([a-g])$/.exec(nm); return m ? {pre:m[1], i:m[2].charCodeAt(0)-97, letter:true} : null; };
  const addGroup = (owner, side, list)=>{
    const by = new Map();
    list.forEach(p=>{ if((p.width||1)!==1) return; const q = parse(p.name); if(!q) return;
      const k = owner+"|"+side+"|"+q.pre+"|"+q.letter+"|"+!!q.br; (by.get(k) || by.set(k, {pre:q.pre, letter:q.letter, m:[]}).get(k)).m.push({p, i:q.i}); });
    by.forEach((g, k)=>{
      g.m.sort((a,b)=>a.i-b.i);
      // maximal runs of consecutive indexes; letters must start at a and reach at least c
      let run = [];
      const flush = ()=>{ if(run.length>=2 && (!g.letter || (run[0].i===0 && run.length>=3))){
          const id = k+"|"+run[0].i; groups.set(id, {id, owner, side, pre:g.pre, letter:g.letter, m:run.slice()});
          run.forEach((x,pos)=>at.set(x.p.key, {g:id, pos})); } run = []; };
      g.m.forEach(x=>{ if(run.length && x.i!==run[run.length-1].i+1) flush(); run.push(x); }); flush();
    });
  };
  const ins = [], outs = [];
  M.els.forEach(e=>{ if(e.kind==="in") ins.push(e.pins[0]); else if(e.kind==="out") outs.push(e.pins[0]);
    else if(e.kind==="block"){ addGroup(e.id, "L", e.L); addGroup(e.id, "R", e.R); } });
  addGroup("IN", "P", ins); addGroup("OUT", "P", outs);
  const netOf = new Map(M.nets.map(n=>[n.driver, n]));
  const ranges = new Map();                       // group id → [[lo, hi]] positions merged into a bus
  const addRange = (gid, lo, hi)=>(ranges.get(gid) || ranges.set(gid, []).get(gid)).push([lo, hi]);
  const busNets = [], gone = new Set();
  groups.forEach(G=>{
    if(G.owner==="OUT" || G.side==="L") return;   // runs start on the driving side
    const sig = G.m.map((x, k)=>{ const n = netOf.get(x.p.key); if(!n || n.width>1) return null;
      const parts = []; for(const s of n.sinks){ const a = at.get(s); if(!a) return null; parts.push(a.g+"@"+(a.pos-k)); }
      return parts.sort().join(","); });
    for(let k=0; k<G.m.length; ){
      let e = k; while(e+1<G.m.length && sig[k]!==null && sig[e+1]===sig[k]) e++;
      if(sig[k]!==null && e>k){
        addRange(G.id, k, e);
        const sinks = sig[k].split(",").map(t=>{ const [gid, off] = t.split("@"); addRange(gid, k+(+off), e+(+off)); return gid+"#"+(k+(+off))+"-"+(e+(+off)); });
        busNets.push({driver:G.id+"#"+k+"-"+e, sinks, width:e-k+1});
        for(let j=k; j<=e; j++){ gone.add(netOf.get(G.m[j].p.key)); }
      }
      k = e+1;
    }
  });
  if(!busNets.length) return;
  // the bus pins: a merged range becomes one pin where its first member was
  const name = (G, lo, hi)=>{ const ix = j=>G.m[j].i;
    return G.letter ? G.pre+"["+String.fromCharCode(97+ix(lo))+":"+String.fromCharCode(97+ix(hi))+"]" : G.pre+"["+ix(hi)+":"+ix(lo)+"]"; };
  const busPin = new Map();                         // member pin key → {key, name, width, first}
  ranges.forEach((list, gid)=>{ const G = groups.get(gid);
    list.forEach(([lo, hi])=>{ const k = gid+"#"+lo+"-"+hi, first = G.m[lo].p;
      const bp = {key:k, name:name(G, lo, hi), width:hi-lo+1, clk:false, inv:false};
      for(let j=lo; j<=hi; j++) busPin.set(G.m[j].p.key, {bp, first:j===lo}); }); });
  M.nets = M.nets.filter(n=>!gone.has(n)).concat(busNets);
  M.els.forEach(e=>{
    if(e.kind==="block") ["L","R"].forEach(s=>{ e[s] = e[s].flatMap(p=>{ const b = busPin.get(p.key); if(!b) return [p]; if(!b.first) return [];
      M.pinOwner.set(b.bp.key, e.id); return [b.bp]; }); });
  });
  // ports: the bits of one bus become one port where the first bit was
  [...M.els.values()].filter(e=>e.kind==="in" || e.kind==="out").forEach(e=>{
    const b = busPin.get(e.pins[0].key); if(!b) return;
    if(!b.first){ M.els.delete(e.id); return; }
    const nm = b.bp.name; e.name = nm; e.width = b.bp.width; e.pins = [b.bp]; M.pinOwner.set(b.bp.key, e.id);
  });
}

/* ---------- 5. sizes, columns, rows ---------- */
function tdpSize(e){
  const {PITCH, G} = TDP;
  if(e.kind==="block"){
    const rows = Math.max(e.L.length, e.R.length, 1), CW = 7;
    const lead = p=>p.clk ? 14 : 6;
    let need = Math.max(88, String(e.label).length*CW + 30);
    for(let i=0;i<rows;i++){ const l = e.L[i], r = e.R[i];
      need = Math.max(need, (l ? lead(l)+l.name.length*CW : 0) + (r ? r.name.length*CW+6 : 0) + 14); }
    e.w = Math.ceil(need/G)*G; e.h = PITCH*(rows+1);
    e.offL = e.L.map((_,i)=>PITCH*(i+1)); e.offR = e.R.map((_,i)=>PITCH*(i+1));
    e.ext = {x0:-TDP.LEAD, x1:e.w+TDP.LEAD, y0:-TDP.BAND, y1:e.h};     // what it occupies, incl. leads + name
  } else if(e.kind==="gate"){
    const n = Math.max(1, e.L.length), one = n===1;
    e.h = one ? 22 : PITCH*n; e.w = one ? 33 : 44;
    e.offL = e.L.map((_,i)=>one ? 11 : PITCH*i+11); e.offR = [e.h/2];
    e.inLead = e.inv.some(Boolean) ? 16 : 8;
    const bub = /^(nand|nor|xnor|not)$/.test(e.gate);
    e.outX = e.w + (bub ? 9 : 0) + 8;
    e.ext = {x0:-e.inLead, x1:e.outX, y0:0, y1:e.h};
  } else if(e.kind==="const"){ e.ext = {x0:-33, x1:16, y0:-5, y1:17}; }
}
/* where a pin's wire ends, in sheet coordinates */
function tdpPinXY(e, key){
  if(e.kind==="in" || e.kind==="out") return {x:e.x, y:e.y};
  if(e.kind==="const") return {x:e.x+16, y:e.y+6};
  let i = e.L.findIndex(p=>p.key===key);
  if(i>=0) return {x:e.x+(e.kind==="block" ? -TDP.LEAD : -e.inLead), y:e.y+e.offL[i]};
  i = e.R.findIndex(p=>p.key===key);
  if(i>=0) return {x:e.x+(e.kind==="block" ? e.w+TDP.LEAD : e.outX), y:e.y+e.offR[i]};
  return null;
}
function tdpLayout(M, spread){
  const {G, GAP} = TDP, snap11 = v=>Math.round(v/G)*G;
  const els = [...M.els.values()];
  els.forEach(tdpSize);
  const parts = els.filter(e=>e.kind==="block" || e.kind==="gate");
  const owner = k=>M.els.get(M.pinOwner.get(k));
  // edges between parts, feedback broken by a DFS from the inputs' side
  const succ = new Map(parts.map(e=>[e.id, new Set()])), pred = new Map(parts.map(e=>[e.id, new Set()]));
  M.nets.forEach(n=>{ const a = owner(n.driver); if(!a || !succ.has(a.id)) return;
    n.sinks.forEach(s=>{ const b = owner(s); if(b && pred.has(b.id) && b!==a){ succ.get(a.id).add(b.id); pred.get(b.id).add(a.id); } }); });
  const fedByIn = e=>M.nets.some(n=>{ const a = owner(n.driver); return a && (a.kind==="in" || a.kind==="const") && n.sinks.some(s=>M.pinOwner.get(s)===e.id); });
  const state = new Map(), back = new Set(), order = [];
  const visit = id=>{ state.set(id, 1);
    for(const t of succ.get(id)){ if(state.get(t)===1) back.add(id+">"+t); else if(!state.has(t)) visit(t); }
    state.set(id, 2); order.push(id); };
  parts.filter(fedByIn).concat(parts).forEach(e=>{ if(!state.has(e.id)) visit(e.id); });
  const rank = new Map();
  order.slice().reverse().forEach(id=>{ let r = 1;
    pred.get(id).forEach(p=>{ if(!back.has(p+">"+id) && rank.has(p)) r = Math.max(r, rank.get(p)+1); }); rank.set(id, r); });
  // longest path from the inputs, re-done in topological order (the DFS order above is one)
  for(let pass=0; pass<parts.length; pass++){ let ch = false;
    parts.forEach(e=>pred.get(e.id).forEach(p=>{ if(back.has(p+">"+e.id)) return; const r = rank.get(p)+1; if(r>rank.get(e.id)){ rank.set(e.id, r); ch = true; } }));
    if(!ch) break; }
  const maxR = Math.max(1, ...parts.map(e=>rank.get(e.id)));
  const cols = []; for(let r=1; r<=maxR; r++) cols.push(parts.filter(e=>rank.get(e.id)===r));
  // rows: barycentre sweeps (each part by the mean row of what it connects to)
  const pos = new Map(); cols.forEach(c=>c.forEach((e,i)=>pos.set(e.id, i/(c.length||1))));
  for(let s=0; s<6; s++){
    const seq = s%2 ? cols.slice().reverse() : cols;
    seq.forEach(c=>{ c.forEach(e=>{ const nb = [...(s%2 ? succ : pred).get(e.id)].filter(id=>pos.has(id));
        e.bc = nb.length ? nb.reduce((a,id)=>a+pos.get(id), 0)/nb.length : pos.get(e.id); });
      c.sort((a,b)=>a.bc-b.bc); c.forEach((e,i)=>pos.set(e.id, i/(c.length||1))); });
  }
  // columns: x by width; the channel after a column grows with the nets that turn in it (a net that
  // starts in the column before it or ends in the column after it), not with every net passing by
  const colOf = e=>e && rank.has(e.id) ? rank.get(e.id) : (e && e.kind==="out" ? maxR+1 : 0);
  const turning = r=>M.nets.filter(n=>{ const ra = colOf(owner(n.driver)), rb = n.sinks.map(s=>colOf(owner(s)));
    return (ra===r && rb.some(x=>x>r)) || (ra<=r && rb.some(x=>x===r+1)); }).length;
  const chan = r=>snap11((33 + G*Math.min(16, turning(r)))*spread);
  const widthOf = c=>Math.max(0, ...c.map(e=>-e.ext.x0)) + Math.max(0, ...c.map(e=>e.ext.x1));
  // y inside a band: stacked, then each part slid so its first driven input lines up with what
  // drives it (only a driver in the same band: across bands a row means nothing)
  const top = e=>e.y+e.ext.y0, bot = e=>e.y+e.ext.y1;
  const placeY = (band, first)=>{
    band.forEach(c=>{ let y = 0; c.forEach(e=>{ e.y = snap11(y - e.ext.y0); y = bot(e)+GAP*2; }); });
    for(let it=0; it<2; it++) band.forEach((c, bi)=>{
      c.forEach(e=>{ e.want = e.y;
        for(let i=0;i<e.L.length;i++){
          const n = M.nets.find(q=>q.sinks.includes(e.L[i].key)); if(!n) continue;
          const d = owner(n.driver), rd = colOf(d); if(!d || !rank.has(d.id) || rd<first || rd>=first+bi) continue;
          const p = tdpPinXY(d, n.driver); e.want = p.y - e.offL[i]; break; } });
      let prev = -Infinity;
      c.forEach(e=>{ e.y = snap11(Math.max(e.want, prev - e.ext.y0)); prev = bot(e) + GAP; });
    });
    const t = Math.min(...band.flat().map(top)); band.flat().forEach(e=>{ e.y -= snap11(t); });
    return Math.max(...band.flat().map(bot));
  };
  // a long chain is folded into bands (rows) so the sheet comes out near A4's shape, as the lab
  // sheets do (Mod20m: four blocks, then the rest on a row below)
  const inX = 0, totalW = cols.reduce((a,c,i)=>a+widthOf(c)+chan(i+1), chan(0));
  const oneH = placeY(cols, 1);
  // only a chain too long for one row of the page is folded (four flip-flops in a row fit; Mod20m's eight do not)
  let nb = 1; if(cols.length>=4 && totalW>1300 && totalW/Math.max(oneH, 1) > 2.2)
    nb = Math.min(3, Math.max(2, Math.round(Math.sqrt(totalW/oneH/1.45)), Math.ceil(totalW/1500)));
  const bands = []; { const per = totalW/nb; let cur = [], acc = 0;
    cols.forEach((c, i)=>{ const w = widthOf(c)+chan(i+1); if(cur.length && acc+w/2>per && bands.length<nb-1){ bands.push(cur); cur = []; acc = 0; } cur.push(c); acc += w; });
    bands.push(cur); }
  let yOff = 0, xMax = 0, firstCol = 1;
  bands.forEach(band=>{
    const h = placeY(band, firstCol);
    let x = inX + chan(firstCol-1);
    band.forEach((c, i)=>{ const x0 = Math.max(0, ...c.map(e=>-e.ext.x0));
      c.forEach(e=>{ e.x = snap11(x + x0); e.y += yOff; });
      x += widthOf(c) + chan(firstCol+i); });
    xMax = Math.max(xMax, x); yOff += h + snap11(66*spread); firstCol += band.length;
  });
  const outX = snap11(xMax);
  // ports: each on the row of the pin it feeds / comes from, in order, at least a pitch apart
  const portRow = (e, side)=>{ const n = side==="in" ? M.nets.find(q=>q.driver===e.pins[0].key) : M.nets.find(q=>q.sinks.includes(e.pins[0].key));
    if(!n) return null;
    if(side==="in"){ let best = null; n.sinks.forEach(s=>{ const o = owner(s); if(!o || !rank.has(o.id)) return; const p = tdpPinXY(o, s);
        if(!best || rank.get(o.id)<best.r || (rank.get(o.id)===best.r && p.y<best.y)) best = {r:rank.get(o.id), y:p.y}; }); return best ? best.y : null; }
    const d = owner(n.driver); return d && rank.has(d.id) ? tdpPinXY(d, n.driver).y : null; };
  // where the wire meets the part on the far end: ports that want the same row are stacked so their
  // wires do not cross — an output from the part nearest the port keeps the row (its wire is straight),
  // the others drop below it in turn (q3 straight on, q2 … q0 below, like the lab sheets)
  const farX = (e, side)=>{ const n = side==="in" ? M.nets.find(q=>q.driver===e.pins[0].key) : M.nets.find(q=>q.sinks.includes(e.pins[0].key)); if(!n) return 0;
    if(side==="out"){ const d = owner(n.driver); return d && rank.has(d.id) ? tdpPinXY(d, n.driver).x : 0; }
    return Math.min(...n.sinks.map(s=>{ const o = owner(s); return o && rank.has(o.id) ? tdpPinXY(o, s).x : 1e9; })); };
  const place = (list, side, X)=>{
    list.forEach((e, i)=>{ e.want = portRow(e, side); e.ord = i; e.far = farX(e, side); });
    const near = (a,b)=>side==="out" ? b.far-a.far : a.far-b.far;
    const known = list.filter(e=>e.want!=null).sort((a,b)=>a.want-b.want || near(a,b) || a.ord-b.ord), rest = list.filter(e=>e.want==null);
    let prev = -Infinity;
    known.concat(rest).forEach(e=>{ e.x = X; e.y = snap11(Math.max(e.want!=null ? e.want : prev+TDP.PITCH, prev+TDP.PITCH)); prev = e.y; });
  };
  place(els.filter(e=>e.kind==="in"), "in", inX);
  place(els.filter(e=>e.kind==="out"), "out", outX);
  // constants: just left of the pin they hold
  els.filter(e=>e.kind==="const").forEach(e=>{ const n = M.nets.find(q=>q.driver===e.pins[0].key); const s = n && owner(n.sinks[0]);
    const p = s && tdpPinXY(s, n.sinks[0]); e.x = p ? p.x-33-16 : inX+33; e.y = p ? p.y-6 : 0; });
  return {inX, outX, parts};
}

/* ---------- 6. route with this editor's router, on parts shaped like the Top-Down symbols ---------- */
function tdpRoute(M){
  const T = {id:"tdp_scratch", name:"tdp_scratch", components:[], wires:[]}, cmap = new Map();
  const node = (e, x, y, w, h, pins)=>{ const c = {id:"t_"+e.id, type:"TDNODE", x, y, label:"", params:{w, h, pins}}; T.components.push(c); cmap.set(e.id, c); };
  M.els.forEach(e=>{
    if(e.kind==="block"){ const W = e.w+2*TDP.LEAD, H = e.h+TDP.BAND;
      node(e, e.x-TDP.LEAD, e.y-TDP.BAND, W, H, [...e.L.map((p,i)=>({id:p.key, dir:"in", dx:0, dy:TDP.BAND+e.offL[i]})),
        ...e.R.map((p,i)=>({id:p.key, dir:"out", dx:W, dy:TDP.BAND+e.offR[i]}))]); }
    else if(e.kind==="gate"){ const W = e.inLead+e.outX;
      node(e, e.x-e.inLead, e.y, W, e.h, [...e.L.map((p,i)=>({id:p.key, dir:"in", dx:0, dy:e.offL[i]})), ...e.R.map(p=>({id:p.key, dir:"out", dx:W, dy:e.h/2}))]); }
    else if(e.kind==="in") node(e, e.x-TDP.PORT, e.y-11, TDP.PORT, 22, [{id:e.pins[0].key, dir:"out", dx:TDP.PORT, dy:11}]);
    else if(e.kind==="out") node(e, e.x, e.y-11, TDP.PORT, 22, [{id:e.pins[0].key, dir:"in", dx:0, dy:11}]);
    else if(e.kind==="const") node(e, e.x-33, e.y-5, 49, 22, [{id:e.pins[0].key, dir:"out", dx:49, dy:11}]);
  });
  const ep = k=>{ const c = cmap.get(M.pinOwner.get(k)); return c ? {cid:c.id, pid:k} : null; };
  let jn = 0;
  M.nets.forEach(n=>{ const a = ep(n.driver); if(!a) return; const S = n.sinks.map(ep).filter(Boolean); if(!S.length) return;
    if(S.length===1){ T.wires.push({id:"tw"+(jn++), from:a, to:S[0], width:n.width}); return; }
    // one dot glues the branches into one net; the router lays the tree out itself
    const p = portPos(comp(a.cid, T), a.pid), J = {id:"tj"+(jn++), type:"JUNCTION", x:p.x+16, y:p.y-6, params:{}, label:""};
    T.components.push(J);
    T.wires.push({id:"tw"+(jn++), from:a, to:{cid:J.id, pid:"j"}, width:n.width});
    S.forEach(s=>T.wires.push({id:"tw"+(jn++), from:{cid:J.id, pid:"j"}, to:s, width:n.width}));
  });
  const r = wtReroute(T, new Set(T.wires.map(w=>w.id))) || {};
  return {T, cmap, relaxed:r.relaxed||0, plain:r.plain||0};
}
/* which pins each routed net joins — must equal the netlist */
function tdpJoined(T){
  const par = new Map(), f = k=>{ if(!par.has(k)) par.set(k,k); while(par.get(k)!==k){ par.set(k, par.get(par.get(k))); k = par.get(k); } return k; };
  const isJ = cid=>{ const c = comp(cid, T); return c && c.type==="JUNCTION"; };
  const key = e=>isJ(e.cid) ? "J:"+e.cid : e.pid;
  T.wires.forEach(w=>{ const a = f(key(w.from)), b = f(key(w.to)); if(a!==b) par.set(a, b); });
  const g = new Map(); [...par.keys()].forEach(k=>{ if(k.startsWith("J:")) return; const r = f(k); (g.get(r) || g.set(r, []).get(r)).push(k); });
  return [...g.values()].map(v=>v.sort().join(",")).sort().join("|");
}

/* runs two different nets share (a relaxed route can lay one along another — it reads as joined) */
function tdpShared(T){
  const nk = wtNetKeys(T), H = [], V = [];
  T.wires.forEach(w=>{ const p = drawnPoints(T, w) || [];
    for(let i=1;i<p.length;i++){ const a = p[i-1], b = p[i], n = nk.get(w.id);
      if(Math.abs(a.y-b.y)<0.5) H.push({n, c:a.y, lo:Math.min(a.x,b.x), hi:Math.max(a.x,b.x)});
      else if(Math.abs(a.x-b.x)<0.5) V.push({n, c:a.x, lo:Math.min(a.y,b.y), hi:Math.max(a.y,b.y)}); } });
  let k = 0;
  [H, V].forEach(L=>{ L.sort((a,b)=>a.c-b.c);
    for(let i=0;i<L.length;i++) for(let j=i+1;j<L.length && Math.abs(L[j].c-L[i].c)<0.5;j++)
      if(L[i].n!==L[j].n && Math.min(L[i].hi, L[j].hi)-Math.max(L[i].lo, L[j].lo)>2) k++; });
  return k;
}

/* ---------- 7. the Top-Down sheet ---------- */
function tdpSheet(sch, M, R, L){
  const nodes = [], wires = [], pinId = new Map();
  M.els.forEach(e=>{
    if(e.kind==="block"){
      e.L.forEach((p,i)=>pinId.set(p.key, "L"+i)); e.R.forEach((p,i)=>pinId.set(p.key, "R"+i));
      const pn = p=>Object.assign({name:p.name}, p.inv ? {inv:true} : {}, p.clk ? {clk:true} : {});
      nodes.push({id:e.id, type:"block", x:e.x, y:e.y, minW:e.w, minH:e.h, label:e.label, pinsL:e.L.map(pn), pinsR:e.R.map(pn), pinsB:[], pinsT:[],
        pinOff:{L:e.offL, R:e.offR, B:[], T:[]}, ref:e.ref});
    } else if(e.kind==="gate"){
      e.L.forEach((p,i)=>pinId.set(p.key, "in"+i)); e.R.forEach(p=>pinId.set(p.key, "out"));
      nodes.push({id:e.id, type:"gate", gate:e.gate, x:e.x, y:e.y, w:e.w, h:e.h, inputs:Math.max(1, e.L.length), label:"",
        invIn:e.inv.slice(), inY:e.offL.slice(), inLead:e.inLead});
    } else if(e.kind==="in" || e.kind==="out"){
      pinId.set(e.pins[0].key, "p");
      nodes.push({id:e.id, type:"port", x:e.x, y:e.y, name:e.name, side:e.kind==="in" ? "left" : "right", bus:e.width>1 ? e.width : 0});
    } else if(e.kind==="const"){ pinId.set(e.pins[0].key, "p"); nodes.push({id:e.id, type:"const", x:e.x, y:e.y, value:e.value}); }
  });
  // each sink gets a wire that follows the routed tree from the driver (Top-Down puts the dots back)
  const T = R.T, owner = new Map(); R.cmap.forEach((c, id)=>owner.set(c.id, id));
  const width = new Map(M.nets.map(n=>[n.driver, n.width]));
  const key = e=>{ const c = comp(e.cid, T); return c && c.type==="JUNCTION" ? "J:"+e.cid : e.pid; };
  const adj = new Map(), add = (k, e)=>(adj.get(k) || adj.set(k, []).get(k)).push(e);
  T.wires.forEach(w=>{ const pts = drawnPoints(T, w); if(!pts) return; const a = key(w.from), b = key(w.to);
    add(a, {to:b, pts}); add(b, {to:a, pts:pts.slice().reverse()}); });
  M.nets.forEach(n=>{
    const prev = new Map([[n.driver, null]]), q = [n.driver];
    while(q.length){ const k = q.shift(); (adj.get(k)||[]).forEach(e=>{ if(prev.has(e.to)) return; prev.set(e.to, {from:k, pts:e.pts}); if(e.to.startsWith("J:")) q.push(e.to); }); }
    n.sinks.forEach(s=>{ if(!prev.has(s)) return;
      const chain = []; for(let cur=s; prev.get(cur); cur=prev.get(cur).from) chain.unshift(prev.get(cur).pts);
      const line = []; chain.forEach(pts=>pts.forEach(p=>{ const l = line[line.length-1]; if(!l || l.x!==p.x || l.y!==p.y) line.push(p); }));
      wires.push({from:{node:M.pinOwner.get(n.driver), pin:pinId.get(n.driver)}, to:{node:M.pinOwner.get(s), pin:pinId.get(s)},
        bus:n.width>1 ? n.width : 0, exact:true, pts:line.slice(1,-1).map(p=>[Math.round(p.x), Math.round(p.y)])}); });
  });
  // the frame: just inside the ports (their tails cross it), room above for the module name
  let y0 = Infinity, y1 = -Infinity;
  M.els.forEach(e=>{ const t = e.ext ? e.y+e.ext.y0 : e.y-11, b = e.ext ? e.y+e.ext.y1 : e.y+11; y0 = Math.min(y0, t); y1 = Math.max(y1, b); });
  wires.forEach(w=>w.pts.forEach(p=>{ y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }));
  const fx = L.inX-14, fw = (L.outX+14)-fx, fy = y0-44, fh = y1-y0+44+33;
  // move everything to a comfortable origin
  const ox = 120-fx, oy = 130-fy;
  nodes.forEach(n=>{ n.x += ox; n.y += oy; }); wires.forEach(w=>{ w.pts = w.pts.map(p=>[p[0]+ox, p[1]+oy]); });
  return {id:uid("tds"), src:sch.id, title:tdpTitle(sch), module:sanId(sch.name)||"Module", exact:true, paper:true,
          frame:{x:120, y:130, w:fw, h:fh}, nodes, wires};
}

/* "2nd Layer (counter2)": how deep the sheet sits under the project's top sheet, as the lab sheets title it */
function tdpTitle(sch){
  const P = state.project, top = P && P.schematics[P.topId], ord = n=>n+(n%10===1&&n%100!==11?"st":n%10===2&&n%100!==12?"nd":n%10===3&&n%100!==13?"rd":"th");
  if(!top) return sch.name;
  const depth = new Map([[top.id, 1]]), q = [top];
  while(q.length){ const s = q.shift(); (s.components||[]).forEach(c=>{ const sub = subSchOf(c); if(sub && !depth.has(sub.id)){ depth.set(sub.id, depth.get(s.id)+1); q.push(sub); } }); }
  return depth.has(sch.id) ? ord(depth.get(sch.id))+" Layer ("+sch.name+")" : sch.name;
}
/* the whole pipeline; null when this sheet cannot be drawn this way */
function tdPaperSheet(sch){
  if(!sch || !(sch.components||[]).length) return null;
  const NL = tdpNetlist(sch);
  let best = null;
  for(const spread of [1, 1.5, 2.2]){
    const M = tdpElements(sch, NL);
    if(![...M.els.values()].some(e=>e.kind==="block" || e.kind==="gate")) return null;
    tdpBubbles(M); tdpBuses(M);
    const L = tdpLayout(M, spread), R = tdpRoute(M);
    // the drawing must join exactly the pins the netlist joins
    const want = M.nets.map(n=>[n.driver, ...n.sinks].sort().join(",")).sort().join("|");
    if(tdpJoined(R.T)!==want) continue;           // a wire it could not lay: more room next time
    // the best of the tries: never two nets on one line, then the fewest wires laid plain / relaxed
    const shared = tdpShared(R.T), score = shared*1000 + R.plain*10 + R.relaxed;
    if(!best || score<best.score) best = {M, R, L, score};
    if(!shared && !R.plain) break;                 // a relaxed route is still clean; another try costs seconds on a big sheet
  }
  if(!best){ console.warn("topdown paper: routed nets differ — 1:1 transfer used"); return null; }
  return tdpSheet(sch, best.M, best.R, best.L);
}
{
  const _tds = schematicToTopdownSheet;
  schematicToTopdownSheet = function(sch){
    try{ const s = tdPaperSheet(sch); if(s) return s; }catch(e){ console.warn("topdown paper", e); }
    return _tds.apply(this, arguments);
  };
}
