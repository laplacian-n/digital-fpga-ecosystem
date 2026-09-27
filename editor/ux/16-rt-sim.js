/* ===== 16. Real-time board simulation: the 50 MHz clock, for real ============================
   "ปรับปรุง sim หน่อย มันดูจะใช้จริงในสถานการณ์ที่ clk ซับซ้อนไม่ได้เลย": lab 6 divides the board's
   50 MHz clock through a ripple chain (mod10 ×5 → mod5 ×2 …) down to 20 Hz. Stepping one clock
   at a time, each step re-solving the whole sheet, the counter needed millions of clicks to move.

   RTSIM is a second engine for exactly that: the flattened sheet compiled to nets + evaluators,
   run EVENT-DRIVEN — only what changes is re-evaluated, a flip-flop only looks at its inputs on
   its own clock edge, ripple clocks (a Q feeding the next clk) settle in delta steps. Semantics
   match the probe model (the stepped sim); values are bit vectors, unknown = 0.
   The board page drives it frame by frame at a chosen fraction of real time, and paints what a
   person would SEE: every LED and 7-seg segment is averaged over the frame, so a multiplexed
   2-digit display shows both digits steadily instead of flickering between them. */
const RT = { sim:null, on:false, raf:0, speed:0.01, t0:0, cyc:0, err:"" };

function rtCompile(sch){
  const fs = flattenSchematic(sch).sch;
  const comps = fs.components.filter(c=>c.type!=="JUNCTION");
  // ---- nets: union the two ends of every wire (a dot is one pin, so its wires join)
  const par = new Map(), find = k=>{ let r=k; while(par.get(r)!==r) r=par.get(r); let x=k; while(par.get(x)!==r){ const n=par.get(x); par.set(x,r); x=n; } return r; };
  const add = k=>{ if(!par.has(k)) par.set(k,k); };
  const pk = (cid,pid)=>cid+"|"+pid;
  fs.wires.forEach(w=>{ const a=pk(w.from.cid,w.from.pid), b=pk(w.to.cid,w.to.pid); add(a); add(b); const ra=find(a), rb=find(b); if(ra!==rb) par.set(ra,rb); });
  // a BUF (every sub-block boundary becomes one when the sheet is flattened) is the same net on
  // both sides — merging them saves an event per boundary per clock edge
  const aliased = new Set();
  comps.forEach(c=>{ if(c.type!=="BUF") return; let ps=[]; try{ ps=getPorts(c); }catch(_){}
    const i=ps.find(p=>p.dir==="in"), o=ps.find(p=>p.dir==="out"); if(!i||!o||(i.width||1)!==(o.width||1)) return;
    const a=pk(c.id,i.id), b=pk(c.id,o.id); add(a); add(b); const ra=find(a), rb=find(b); if(ra!==rb) par.set(ra,rb); aliased.add(c.id); });
  const netId = new Map(); let N = 0;
  const net = (cid,pid)=>{ const k=pk(cid,pid); add(k); const r=find(k); if(!netId.has(r)) netId.set(r, N++); return netId.get(r); };
  const portsOf = c=>{ try{ return getPorts(c); }catch(_){ return []; } };
  comps.forEach(c=>portsOf(c).forEach(p=>net(c.id,p.id)));   // every pin gets a net (unwired → its own)
  const val = new Int32Array(N + 1);
  const fan = Array.from({length:N+1}, ()=>[]);             // net → evaluators reading it
  const clkFan = Array.from({length:N+1}, ()=>[]);          // net → flip-flops clocked by it
  const evals = [], ffs = [], merges = new Map();
  const mask = w=>w>=32 ? -1 : ((1<<w)-1);
  const width = (c,pid)=>{ const p=portsOf(c).find(q=>q.id===pid); return Math.max(1, (p&&p.width)||1); };
  const nameOf = c=>(c.params&&c.params.name)||c.label||c.id;
  const ins = [], outs = [];
  // helper: an evaluator reads `reads` nets and writes through set()
  const E = (reads, fn)=>{ const e={fn, q:false}; evals.push(e); reads.forEach(n=>fan[n].push(e)); return e; };
  comps.forEach(c=>{
    const T = c.type, P = c.params||{}, n = pid=>net(c.id,pid);
    const inP = portsOf(c).filter(p=>p.dir==="in").map(p=>p.id), outP = portsOf(c).filter(p=>p.dir==="out").map(p=>p.id);
    if(aliased.has(c.id)) return;                               // a plain wire now
    if(T==="IN"){ ins.push({c, net:n("o"), name:nameOf(c), w:width(c,"o")}); return; }
    if(T==="OUT"){ outs.push({c, net:n("i"), name:nameOf(c), w:width(c,"i")}); return; }
    if(T==="VCC"){ E([], set=>set(n("o"), -1 & mask(width(c,"o")))); return; }
    if(T==="GND"){ E([], set=>set(n("o"), 0)); return; }
    if(T==="CONST"){ const v = (typeof constVal==="function") ? constVal(c) : constBit(c); E([], set=>set(n("o"), v)); return; }
    if(PROBE_GATES[T]){
      const I = inP.map(n), o = n("o"), m = mask(width(c,"o"));
      const f = { AND:(a,b)=>a&b, OR:(a,b)=>a|b, XOR:(a,b)=>a^b, NAND:(a,b)=>a&b, NOR:(a,b)=>a|b, XNOR:(a,b)=>a^b }[T];
      const inv = T==="NAND"||T==="NOR"||T==="XNOR";
      if(T==="NOT") E(I, set=>set(o, (~val[I[0]]) & m));
      else if(T==="BUF") E(I, set=>set(o, val[I[0]] & m));
      else E(I, set=>{ let a=val[I[0]]; for(let k=1;k<I.length;k++) a=f(a,val[I[k]]); set(o, (inv?~a:a) & m); });
      return;
    }
    if(T==="MUX"){ const nIn=P.inputs||2, sb=Math.ceil(Math.log2(nIn)), D=[], S=[];
      for(let k=0;k<nIn;k++) D.push(n("d"+k)); for(let k=0;k<sb;k++) S.push(n("s"+k)); const y=n("y");
      E(D.concat(S), set=>{ let s=0; for(let k=0;k<sb;k++) if(val[S[k]]) s|=1<<k; set(y, s<nIn ? val[D[s]] : 0); }); return; }
    if(T==="DEMUX"){ const nO=P.outputs||2, sb=Math.ceil(Math.log2(nO)), S=[], Y=[]; const d=n("d");
      for(let k=0;k<sb;k++) S.push(n("s"+k)); for(let k=0;k<nO;k++) Y.push(n("y"+k));
      E([d].concat(S), set=>{ let s=0; for(let k=0;k<sb;k++) if(val[S[k]]) s|=1<<k; for(let k=0;k<nO;k++) set(Y[k], k===s && val[d] ? 1 : 0); }); return; }
    if(T==="COMP" || T==="COMPM"){ const w=Math.max(1,P.width||2), bus=cmpIsBus(P);
      const A = bus ? [n("a")] : Array.from({length:w},(_,k)=>n("a"+k)), B = bus ? [n("b")] : Array.from({length:w},(_,k)=>n("b"+k));
      const rd = L=>{ if(bus) return val[L[0]]>>>0; let v=0; for(let k=0;k<L.length;k++) if(val[L[k]]) v|=1<<k; return v>>>0; };
      if(T==="COMP"){ const eq=n("eq"); E(A.concat(B), set=>set(eq, rd(A)===rd(B)?1:0)); }
      else { const gt=n("gt"), lt=n("lt"); E(A.concat(B), set=>{ const a=rd(A), b=rd(B); set(gt, a>b?1:0); set(lt, a<b?1:0); }); }
      return; }
    if(T==="ENC"){ const nI=P.inputs||4, ow=Math.ceil(Math.log2(nI)), I=[], Y=[];
      for(let k=0;k<nI;k++) I.push(n("i"+k)); for(let b=0;b<ow;b++) Y.push(n("y"+b));
      E(I, set=>{ let k=-1; for(let i=nI-1;i>=0;i--) if(val[I[i]]){ k=i; break; } for(let b=0;b<ow;b++) set(Y[b], k<0?0:((k>>b)&1)); }); return; }
    if(T==="DEC"){ const nO=P.outputs||4, iw=Math.ceil(Math.log2(nO)), A=[], Y=[]; const en=n("en");
      for(let k=0;k<iw;k++) A.push(n("a"+k)); for(let k=0;k<nO;k++) Y.push(n("y"+k));
      E(A.concat([en]), set=>{ let a=0; for(let k=0;k<iw;k++) if(val[A[k]]) a|=1<<k; for(let k=0;k<nO;k++) set(Y[k], val[en] && k===a ? 1 : 0); }); return; }
    if(T==="BUSTAP"){ const b=P.bit||0, m=mask(Math.max(1,P.nbit||1)), d=n("d"), y=n("y");
      if(P.mode==="merge"){ (merges.get(d) || merges.set(d, []).get(d)).push({y, b, m}); }
      else E([d], set=>set(y, (val[d]>>>b) & m));
      return; }
    if(PROBE_SEQ[T]){
      const f = { c, T, st:0, last:0, edge:P.edge==="falling"?0:1, clk:n("clk"),
        d:T==="DFF"?n("d"):-1, t:T==="TFF"?n("t"):-1, j:T==="JKFF"?n("j"):-1, k:T==="JKFF"?n("k"):-1,
        s:T==="SRFF"?n("s"):-1, r:T==="SRFF"?n("r"):-1,
        rst:P.reset?n("rst"):-1, pre:P.preset?n("pre"):-1, q:n("q"), qn:outP.includes("qn")?n("qn"):-1 };
      ffs.push(f); clkFan[f.clk].push(f);
      // async clear / preset act at once, whatever the clock does
      if(f.rst>=0 || f.pre>=0) E([f.rst, f.pre].filter(x=>x>=0), set=>{ const w = (f.rst>=0&&val[f.rst]) ? 0 : (f.pre>=0&&val[f.pre]) ? 1 : null;
        if(w!=null && f.st!==w){ f.st=w; set(f.q, w); if(f.qn>=0) set(f.qn, w?0:1); } });
      return;
    }
    // anything else (an unknown block) drives nothing
  });
  merges.forEach((taps, bus)=>E(taps.map(t=>t.y), set=>{ let v=0; taps.forEach(t=>{ v |= (val[t.y] & t.m) << t.b; }); set(bus, v); }));
  // ---- the event loop (hot: no allocation per clock)
  const Q = new Array(evals.length + 16); let qn = 0;       // queue of evaluators, flag e.q = queued
  const T = new Int32Array(N + 1); let tn = 0; const tIn = new Uint8Array(N + 1);   // clock nets touched
  const EDG = new Array(ffs.length + 1), NXT = new Int8Array(ffs.length + 1);
  const clkFanA = clkFan.map(L=>L.length ? L : null);
  let events = 0;
  const set = (nn, v)=>{ if(val[nn]===v) return; val[nn]=v; events++;
    const L=fan[nn]; for(let i=0;i<L.length;i++){ const e=L[i]; if(!e.q){ e.q=true; Q[qn++]=e; if(qn>=Q.length) Q.length=qn*2; } }
    if(clkFanA[nn] && !tIn[nn]){ tIn[nn]=1; T[tn++]=nn; } };
  const settle = ()=>{
    for(let round=0; round<200; round++){
      let guard=0;
      for(let h=0; h<qn; h++){ const e=Q[h]; e.q=false; e.fn(set); if(++guard>200000) throw new Error("วงจรแกว่งไม่หยุด (combinational loop) — ตรวจสายวนกลับที่ไม่ผ่าน flip-flop"); }
      qn=0;
      if(!tn) return;
      let ne=0;
      for(let t=0;t<tn;t++){ const nn=T[t]; tIn[nn]=0; const L=clkFanA[nn];
        for(let i=0;i<L.length;i++){ const f=L[i], now=val[f.clk]?1:0; if(now!==f.last){ f.last=now; if(now===f.edge) EDG[ne++]=f; } } }
      tn=0;
      if(!ne) return;
      for(let i=0;i<ne;i++){ const f=EDG[i], q=f.st; let nx=q;
        if((f.rst>=0&&val[f.rst]) || (f.pre>=0&&val[f.pre])) nx=q;             // async wins over the clock
        else if(f.T==="JKFF"){ const j=val[f.j]!==0, k=val[f.k]!==0; nx = j&&k ? 1-q : (j?1:(k?0:q)); }
        else if(f.T==="DFF") nx = val[f.d]?1:0;
        else if(f.T==="TFF") nx = val[f.t]?1-q:q;
        else if(f.T==="SRFF"){ const s=val[f.s]!==0, r=val[f.r]!==0; nx = s&&!r?1:(!s&&r?0:q); }
        NXT[i]=nx; }
      for(let i=0;i<ne;i++){ const f=EDG[i], nx=NXT[i]; if(nx!==f.st){ f.st=nx; set(f.q, nx); if(f.qn>=0) set(f.qn, nx?0:1); } }
    }
  };
  const queue = { push(e){ Q[qn++]=e; } };
  // power-on: every FF at 0 (qn 1), every evaluator once
  ffs.forEach(f=>{ if(f.qn>=0) set(f.qn, 1); });
  evals.forEach(e=>{ if(!e.q){ e.q=true; queue.push(e); } });   // (Q grows as needed above)
  settle();
  ffs.forEach(f=>{ f.last=val[f.clk]?1:0; });
  // the board clock: the INPUT mapped to "clk" (pin page), else one simply named clk
  const own = sch.pinmap||{}, tgt = x=>(typeof pmGet==="function"?pmGet(own,x.name):own[x.name]) || (typeof autoSpecialTarget==="function"?autoSpecialTarget(x.name,"in"):null);
  const clkIn = ins.find(x=>tgt(x)==="clk") || null;
  return {
    ins, outs, ffs, nets:N, val, clk:clkIn,
    get events(){ return events; },
    setIn(i, v){ set(i.net, v|0); settle(); },
    out(o){ return val[o.net]; },
    /* n full board clocks (rising then falling edge each); calls sample() about every `every`
       clocks — at JITTERED points: a fixed stride locks onto the phase of a multiplexed display
       (sample every 5000 clocks, digit select toggling every 5000 → one digit is never seen) */
    run(n, every, sample){
      if(!clkIn) return;
      const c=clkIn.net; let left = every ? 1 + Math.floor(Math.random()*every) : -1;
      for(let i=0;i<n;i++){ set(c,1); settle(); set(c,0); settle();
        if(sample && --left===0){ sample(); left = 1 + Math.floor(every*(0.5+Math.random())); } }
    }
  };
}

/* ---------- the board page: ⚡ real time ---------- */
function rtAvailable(sch){ try{ const s=rtCompile(sch); return s.clk ? s : null; }catch(_){ return null; } }
function rtStop(){ RT.on=false; cancelAnimationFrame(RT.raf); RT.raf=0; const b=document.querySelector('[data-act="rt-toggle"]'); if(b) b.textContent="⚡ เล่นเวลาจริง (50 MHz)"; }
function rtStart(){
  const S=SIM_SEQ, sch=S && (S.run || (typeof activeSch==="function" && activeSch())); if(!sch) return;
  let sim; try{ sim=rtCompile(sch); }catch(e){ toast("จำลองเวลาจริงไม่ได้: "+e.message,"warn"); return; }
  if(!sim.clk){ toast("ไม่มี INPUT ที่ต่อกับนาฬิกาบอร์ด (เลือกขา clk = 50 MHz ก่อน)","warn",4500); return; }
  if(S && S.playing) seqPlay();
  RT.sim=sim; RT.on=true; RT.cyc=0; RT.err=""; RT.perSec=0;
  // the switches as they are now
  const board=rtBoardMap(sch, sim);
  board.ins.forEach(b=>{ if(b.sw!=null) sim.setIn(b.i, SIM_SW[b.sw]||0); else if(b.bits&&b.bits.length) sim.setIn(b.i, rtBusVal(b)); });
  RT.board=board;
  const btn=document.querySelector('[data-act="rt-toggle"]'); if(btn) btn.textContent="⏸ หยุดเวลาจริง";
  let last=performance.now(), budget=20000;                        // clocks per frame, tuned to ~12 ms of work
  const frame=()=>{
    if(!RT.on) return;
    const now=performance.now(), dt=Math.min(100, now-last); last=now;
    const want = RT.speed>=1 ? Infinity : Math.round(50e6*RT.speed*dt/1000);   // clocks the chosen speed asks for
    const n = Math.max(1, Math.min(want, budget));
    const samples=64, every=Math.max(1, Math.floor(n/samples));
    const acc=rtAccStart(board);
    const t0=performance.now();
    try{ sim.run(n, every, ()=>rtAccSample(acc, board, sim)); }
    catch(e){ RT.err=e.message; rtStop(); toast("จำลองหยุด: "+e.message,"err",6000); return; }
    const took=performance.now()-t0;
    budget = Math.max(200, Math.min(2e6, Math.round(budget * (took>0 ? 12/took : 2))));  // keep a frame near 12 ms
    RT.cyc += n; RT.perSec = RT.perSec*0.9 + (n/(dt/1000||0.016))*0.1;
    rtPaint(acc, board, sim);
    RT.raf=requestAnimationFrame(frame);
  };
  RT.raf=requestAnimationFrame(frame);
}
/* which board part each port lands on (same pin map the stepped sim uses) */
function rtBoardMap(sch, sim){
  const own=sch.pinmap||{}, pm=n=>(typeof pmGet==="function"?pmGet(own,n):own[n])||autoSpecialTarget(n,"in")||"";
  const pmo=n=>(typeof pmGet==="function"?pmGet(own,n):own[n])||autoSpecialTarget(n,"out")||"";
  const S=SIM_SEQ||{};
  const ins=sim.ins.filter(i=>i!==sim.clk).map(i=>{
    if(i.w>1){                                               // a bus: each bit has its own switch (swt[0] → SW 0 …)
      const bits=[]; for(let b=0;b<i.w;b++){ const t=(typeof pmGet==="function"?pmGet(own,i.name+"["+b+"]"):own[i.name+"["+b+"]"])||""; if(t.startsWith("sw:")) bits.push({b, sw:+t.slice(3)}); }
      return {i, name:i.name, sw:null, pb:null, bits};
    }
    const t=pm(i.name); const k=(S.inputs||[]).indexOf(i.name);
    return {i, name:i.name, sw: t.startsWith("sw:") ? +t.slice(3) : (!t && k>=0&&S.swOf ? S.swOf[k] : null), pb: t.startsWith("pb:") ? +t.slice(3) : null}; });
  const outs=sim.outs.map(o=>{ const t=pmo(o.name); const k=(S.outputs||[]).indexOf(o.name);
    return {o, name:o.name, t, led: t.startsWith("led:") ? +t.slice(4) : (!t && k>=0 && S.ledOf ? S.ledOf[k] : null)}; });
  return {ins, outs, segs:outs.filter(x=>/^seg:[a-g]$/.test(x.t)), ans:outs.filter(x=>/^an:[0-3]$/.test(x.t))};
}
function rtAccStart(board){ return {n:0, led:new Float32Array(16), seg:Array.from({length:4},()=>new Float32Array(7)), outs:new Float32Array(board.outs.length)}; }
function rtAccSample(acc, board, sim){
  acc.n++;
  board.outs.forEach((x,k)=>{ const v=sim.out(x.o); if(v) acc.outs[k]++; if(x.led!=null && v) acc.led[x.led]++; });
  if(board.segs.length){
    // digits lit now: an:N is active-low (0 = on), 0 = rightmost; none mapped → the rightmost digit
    const digits = board.ans.length ? board.ans.filter(x=>!sim.out(x.o)).map(x=>3-(+x.t.slice(3))) : [3];
    board.segs.forEach(x=>{ if(!sim.out(x.o)){ const s="abcdefg".indexOf(x.t.slice(4)); digits.forEach(d=>acc.seg[d][s]++); } });   // segments active-low
  }
}
function rtPaint(acc, board, sim){
  const n=Math.max(1, acc.n), lit=f=>f/n;
  document.querySelectorAll('#simPcb .ledDot').forEach(d=>{ const b=lit(acc.led[+d.dataset.led]||0);
    d.style.background = b>0.02 ? `rgba(34,34,34,${0.25+0.75*b})` : '#fff'; d.style.boxShadow = b>0.02 ? `0 0 ${3+6*b}px ${1+2*b}px rgba(0,0,0,${0.35*b})` : 'none'; });
  if(board.segs.length) for(let d=0; d<4; d++) for(let s=0; s<7; s++){
    const el=document.querySelector('#simPcb .seg[data-seg="'+d+'-'+s+'"]'); if(!el) continue;
    const b=lit(acc.seg[d][s]);
    // persistence of vision: a digit lit a fraction of the time still reads as lit, just dimmer
    el.style.background = b>0.02 ? `rgba(0,0,0,${Math.min(1, 0.35+1.3*b)})` : '#d5d5d0';
    el.style.boxShadow = b>0.15 ? '0 0 5px 1px rgba(0,0,0,.5)' : 'none';
  }
  const secs=RT.cyc/50e6, fmt=x=>x>=1?x.toFixed(2)+" s":(x*1000).toFixed(1)+" ms";
  const ratio=RT.perSec/50e6;
  const vb=$("#simValbar");
  if(vb) vb.innerHTML=`<b style="color:var(--accent)">⚡ เวลาจริง</b> บนบอร์ดผ่านไป <b>${fmt(secs)}</b> (${Math.round(RT.cyc).toLocaleString()} clock)`
    +` · ความเร็ว ${ratio>=0.95?"เท่าของจริง":"1/"+Math.max(1,Math.round(1/Math.max(ratio,1e-9))).toLocaleString()+" ของจริง"}`
    +` &nbsp; <b style="color:#2f81f7">OUT</b> `+board.outs.map((x,k)=>esc(x.name)+'='+(acc.outs[k]/n>0.5?1:(acc.outs[k]?"~":0))).join(' ')
    +`<span class="muted"> · ~ = สลับไปมาเร็วกว่าที่ตาเห็น</span>`;
}
function rtBusVal(b){ let v=0; b.bits.forEach(x=>{ if(SIM_SW[x.sw]) v|=1<<x.b; }); return v; }
function rtInput(kind, idx, v){
  if(!RT.on || !RT.board) return false;
  let hit=false;
  RT.board.ins.forEach(b=>{
    if(kind==="sw" && b.bits && b.bits.some(x=>x.sw===idx)){ RT.sim.setIn(b.i, rtBusVal(b)); hit=true; }
    else if(kind==="sw" ? b.sw===idx : b.pb===idx){ RT.sim.setIn(b.i, v); hit=true; } });
  return hit;
}
/* hook into the stepped board: a "⚡ เล่นเวลาจริง" button next to the clock controls whenever the
   sheet takes the board's 50 MHz clock; switches and buttons act live while it runs */
{
  const _wire = wireSimBoardSeq;
  wireSimBoardSeq = function(j, opts){
    rtStop();
    const r = _wire.apply(this, arguments);
    try{
      const S=SIM_SEQ, sch=S && S.run, ctl=document.querySelector("#simBoardMsg .seq-ctrl");
      if(sch && ctl && rtAvailable(sch)){
        ctl.insertAdjacentHTML("beforeend", `<span class="rt-ctl"><button class="btn2 rt-go" data-act="rt-toggle">⚡ เล่นเวลาจริง (50 MHz)</button>
          <label class="muted">ช้ากว่าจริง <select id="rtSpeed"><option value="1">เร็วสุดเท่าที่ทำได้</option><option value="0.1">1/10</option><option value="0.01" selected>1/100</option><option value="0.001">1/1,000</option><option value="0.0001">1/10,000</option></select></label></span>`);
        const sp=document.getElementById("rtSpeed"); RT.speed=+sp.value; sp.onchange=()=>{ RT.speed=+sp.value; };
      }
    }catch(e){ console.warn("rt", e); }
    return r;
  };
  document.addEventListener("click", e=>{ const b=e.target.closest && e.target.closest('[data-act="rt-toggle"]'); if(!b) return;
    e.stopPropagation(); if(RT.on) rtStop(); else rtStart(); }, true);
  // switches: flipped live in real time (the stepped handler still keeps its own history)
  document.addEventListener("click", e=>{ const u=e.target.closest && e.target.closest('#simPcb .swUnit'); if(!u || !RT.on) return;
    const sw=+u.dataset.sw; const v=SIM_SW[sw]?0:1; SIM_SW[sw]=v;
    const th=u.querySelector('.swThumb'); if(th){ th.style.top=v?'1px':'12px'; th.style.background=v?'#222':'#aaa'; }
    rtInput("sw", sw, v); e.stopPropagation(); }, true);
  // push buttons: held while the mouse is down (board order: top, left, centre, right, bottom)
  const PB_OF_DOM=[0,2,4,3,1];
  document.addEventListener("mousedown", e=>{ const p=e.target.closest && e.target.closest('#simPcb .pbtn'); if(!p || !RT.on) return;
    const k=[...document.querySelectorAll('#simPcb .pbtn')].indexOf(p); if(k<0||k>4) return;
    if(rtInput("pb", PB_OF_DOM[k], 1)){ p.style.background="#ffd"; const up=()=>{ rtInput("pb", PB_OF_DOM[k], 0); p.style.background="#fff"; document.removeEventListener("mouseup", up, true); }; document.addEventListener("mouseup", up, true); } }, true);
  const _hide = typeof hideSimPage==="function" ? hideSimPage : null;
  if(_hide) hideSimPage = function(){ rtStop(); return _hide.apply(this, arguments); };
}
