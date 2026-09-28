/* ===== 15. Synchronous JK-FF counter / clock divider, from "count to N" =====================
   The lab's hand-drawn divider (clk_in → 4 JK-FFs on one clock → clk_out): each J and K comes
   from the JK excitation table and a K-map, e.g. mod 10 gives the textbook
     J0=K0=1 · J1=Q0·Q3' K1=Q0 · J2=K2=Q0·Q1 · J3=Q0·Q1·Q2 K3=Q0      clk_out = Q3
   Excitation, per bit i and state s in the sequence:
     Q_i=0 → J = next_i, K = don't care        Q_i=1 → K = not next_i, J = don't care
   States outside the sequence are don't care. Identical terms share one AND gate and a J that
   equals its K shares the net (as drawn in the lab); a constant 1 is one VCC. The equations are
   checked on every state of the sequence before anything is drawn. */
function jkCounterIntent(seq, opts){
  opts=opts||{};
  seq=seq.filter((v,i)=>seq.indexOf(v)===i);
  if(seq.length<2) return {error:"ต้องนับอย่างน้อย 2 สถานะ"};
  const maxv=Math.max(...seq), n=Math.max(1, maxv.toString(2).length);
  if(n>6) return {error:"นับได้สูงสุด 64 สถานะ (6 flip-flop)"};
  const next={}; seq.forEach((s,i)=>next[s]=seq[(i+1)%seq.length]);
  const inSeq=new Set(seq), unused=[]; for(let s=0;s<(1<<n);s++) if(!inSeq.has(s)) unused.push(s);
  const J=[], K=[];
  for(let i=0;i<n;i++){
    const jOnes=[], jDc=unused.slice(), kOnes=[], kDc=unused.slice();
    seq.forEach(s=>{ const q=(s>>i)&1, nx=(next[s]>>i)&1;
      if(!q){ if(nx) jOnes.push(s); kDc.push(s); }
      else  { if(!nx) kOnes.push(s); jDc.push(s); } });
    J.push(qmMinimize(jOnes, jDc, n)); K.push(qmMinimize(kOnes, kDc, n));
  }
  // check: Q+ = J·Q' + K'·Q must give next[s] for every state in the sequence
  const ev=(r,s)=> r.const1?1 : r.const0?0 : (r.terms.some(L=>L.every(l=>((s>>l.v)&1)===(l.neg?0:1)))?1:0);
  for(const s of seq){ let nx=0; for(let i=0;i<n;i++){ const q=(s>>i)&1, j=ev(J[i],s), k=ev(K[i],s); nx|=((j&&!q)||(!k&&q)?1:0)<<i; }
    if(nx!==next[s]) return {error:"สังเคราะห์ผิดที่สถานะ "+s}; }
  const clkName=opts.clk||"clk_in";
  const comps=[{id:"clk",type:"IN",name:clkName}], nets=[];
  for(let i=0;i<n;i++){ comps.push({id:"ff"+i,type:"JKFF"}); nets.push({from:"clk",to:"ff"+i+".clk"}); }
  const lit=l=>"ff"+l.v+(l.neg?".qn":".q");
  let vcc=null, gnd=null; const andOf=new Map(), orOf=new Map(); let gc=0;
  const termSrc=L=>{ if(L.length===1) return lit(L[0]);
    const key=L.map(l=>l.v+(l.neg?"'":"")).sort().join("·");
    if(andOf.has(key)) return andOf.get(key);
    const a="a"+(gc++); comps.push({id:a,type:"AND"}); L.forEach(l=>nets.push({from:lit(l),to:a})); andOf.set(key,a); return a; };
  const srcOf=r=>{
    if(r.const1){ if(!vcc){ vcc="vcc"; comps.push({id:vcc,type:"VCC"}); } return vcc; }
    if(r.const0){ if(!gnd){ gnd="gnd"; comps.push({id:gnd,type:"GND"}); } return gnd; }
    const outs=r.terms.map(termSrc); if(outs.length===1) return outs[0];
    const key=outs.slice().sort().join("+"); if(orOf.has(key)) return orOf.get(key);
    const o="o"+(gc++); comps.push({id:o,type:"OR"}); outs.forEach(t=>nets.push({from:t,to:o})); orOf.set(key,o); return o; };
  const eqs=[];
  const txt=r=>r.const1?"1":r.const0?"0":r.terms.map(L=>L.map(l=>"Q"+l.v+(l.neg?"'":"")).join("·")).join(" + ");
  for(let i=0;i<n;i++){ nets.push({from:srcOf(J[i]),to:"ff"+i+".j"}); nets.push({from:srcOf(K[i]),to:"ff"+i+".k"});
    eqs.push(`J${i}=${txt(J[i])} K${i}=${txt(K[i])}`); }
  if(opts.outputs==="q"){ for(let i=n-1;i>=0;i--){ comps.push({id:"q"+i,type:"OUT",name:"q"+i}); nets.push({from:"ff"+i+".q",to:"q"+i}); } }
  else { comps.push({id:"out",type:"OUT",name:opts.out||"clk_out"}); nets.push({from:"ff"+(n-1)+".q",to:"out"}); }
  return {module:"jkcount", components:comps, nets, equations:eqs, bits:n};
}
GENERATORS.splice(GENERATORS.findIndex(g=>g.id==="mod")+1, 0,
  {id:"jkmod", icon:"÷", name:"ตัวนับ/หารความถี่ JK-FF", desc:"synchronous JK-FF นับ 0 … N−1 · clk_in → clk_out (บิตสูงสุด) แบบในแลป", run:async()=>{
    const v=await uxAsk("ตัวนับ / หารความถี่ด้วย JK-FF",[
      {label:"นับถึง (N)",type:"number",value:10,min:2,max:64,hint:"นับ 0 … N−1 แล้ววน · 10 = หารความถี่ 10"},
      {label:"ขาออก",value:"clk_out",hint:"ชื่อขาออก = บิตสูงสุด (หารความถี่) · พิมพ์ q เพื่อได้ q0…qN ทุกบิต"}]);
    if(!v) return;
    const N=Math.max(2,Math.min(64,v[0]|0)), out=String(v[1]||"clk_out").trim()||"clk_out";
    const r=jkCounterIntent(Array.from({length:N},(_,i)=>i), out==="q"?{outputs:"q"}:{out:sanId(out)});
    if(r.error){ toast("สร้างไม่ได้: "+r.error,"err"); return; }
    r.module="jkmod"+N;
    const dr=uxDrawGenerated(r, "ตัวนับ JK-FF mod-"+N);
    if(dr){ jkLayout(dr.sch, r.bits); snapshot(); renderAll(); try{ zoomFit(); }catch(_){} toast(r.equations.join(" · "),"info",8000); } }});
{ // the Tools menu was filled before this file loaded: add the new entry next to "mod-N"
  const b=document.querySelector('#menu [data-gen="mod"]');
  if(b && !document.querySelector('#menu [data-gen="jkmod"]')){
    const g=GENERATORS.find(x=>x.id==="jkmod");
    b.insertAdjacentHTML("afterend", `<button class="gen-mi" data-gen="jkmod" title="${escA(g.desc)}"><span class="gi">${g.icon}</span>${g.name}…</button>`);
    document.querySelector('#menu [data-gen="jkmod"]').addEventListener("click",()=>runGenerator("jkmod"));
  }
}
/* Place it like the lab sheet, then let the wire router (12-wire-tidy) draw every net:
   the flip-flops in ONE column, MSB on top (clk_out beside it), each gate just left of the
   flip-flop it feeds with its output level with that J/K pin, VCC above, clk_in at the bottom. */
function jkLayout(sch, n){
  const G=GRID, by=id=>sch.components.find(c=>c.id===id), sz=c=>getSize(c);
  const X_FF=G*50, X_G=G*30, X_OR=G*38, Y0=G*14, ROW=G*14;
  for(let i=0;i<n;i++){ const f=by("ff"+i); if(f){ f.x=X_FF; f.y=Y0+(n-1-i)*ROW; } }
  // where each gate's output goes: the FF pin it feeds (through an OR if there is one)
  const feeds=cid=>sch.wires.filter(w=>w.from.cid===cid).map(w=>w.to);
  const pinY=(cid,pid)=>{ const c=by(cid); const p=c&&portPos(c,pid); return p?p.y:null; };
  const target=cid=>{ for(const t of feeds(cid)){ const c=by(t.cid); if(!c) continue;
      if(c.type==="JKFF") return pinY(t.cid,t.pid);
      if(c.type==="OR"){ const y=target(c.id); if(y!=null) return y; }
      if(c.type==="JUNCTION"){ const y=target(c.id); if(y!=null) return y; } } return null; };
  const used=[];                                              // occupied y-ranges per column
  const free=(x,y,h)=>!used.some(u=>u.x===x && y<u.y+u.h+G && u.y<y+h+G);
  const put=(c,x,yOut)=>{ c.x=x; c.y=0; const o=portPos(c,"o")||{y:sz(c).h/2}; let y=snap(yOut-o.y);
    for(let k=0;k<60 && !free(x,y,sz(c).h);k++) y+=G;
    c.y=y; used.push({x,y,h:sz(c).h}); };
  sch.components.filter(c=>c.type==="OR").forEach(c=>{ const y=target(c.id); put(c, X_OR, y!=null?y:Y0); });
  sch.components.filter(c=>c.type==="AND").sort((a,b)=>(target(a.id)||0)-(target(b.id)||0))
    .forEach(c=>{ const y=target(c.id), toOr=feeds(c.id).some(t=>{ const d=by(t.cid); return d&&d.type==="OR"; });
      put(c, toOr?X_G-G*8:X_G, y!=null?y:Y0); });
  const vcc=by("vcc"); if(vcc){ vcc.x=X_OR+G*4; vcc.y=Y0-G*7; }
  const gnd=by("gnd"); if(gnd){ gnd.x=X_OR+G*6; gnd.y=Y0-G*7; }
  const clk=by("clk"); const f0=by("ff0");
  if(clk && f0){ clk.x=G*4; clk.y=snap(f0.y+sz(f0).h+G*3); }
  const top=by("ff"+(n-1)), out=by("out");
  if(out && top){ const q=portPos(top,"q"); out.x=X_FF+G*18; out.y=0; const pi=portPos(out,"i"); out.y=snap(q.y-pi.y); }
  for(let i=0;i<n;i++){ const o=by("q"+i), f=by("ff"+i); if(o&&f){ const q=portPos(f,"q"); o.x=X_FF+G*18; o.y=0; const pi=portPos(o,"i"); o.y=snap(q.y-pi.y); } }
  try{ wtTidySheet(sch); }catch(e){ console.warn("jk layout", e); }
  sch.locked=true;                                            // keep the drawing as placed
}
/* ===== Divide a clock by ANY N (50 MHz → 20 Hz = ÷2 500 000), one sheet ==========================
   The K-map counters above stop at 64 states, so a real divider had to be chained by hand
   (÷50·50·40·25). This is the textbook synchronous binary counter with a synchronous clear:
     D_i = (Q_i ⊕ Q_0·…·Q_{i−1}) · ¬TC        TC = AND of the Q bits that are 1 in M−1
   (the counter first reaches those bits all 1 AT M−1, so TC is exactly "count = M−1").
   N even: count mod N/2 and toggle clk_out on TC → a 50 % square wave at f/N.
   N odd:  count mod N, clk_out = the counter's MSB (period N clocks, not 50 %). */
function dividerIntent(N, opts){
  opts=opts||{}; N=Math.floor(+N);
  if(!(N>=2) || N>2**31) return {error:"หารได้ 2 … 2³¹"};
  const even=N%2===0, M=even?N/2:N;
  const clk=opts.clk||"clk_in", out=opts.out||"clk_out";
  const comps=[{id:"clk",type:"IN",name:clk}], nets=[]; let g=0;
  const gate=(type, ins)=>{ const id=type.toLowerCase()+(g++); comps.push({id,type}); ins.forEach(s=>nets.push({from:s,to:id})); return id; };
  // an AND of any number of signals, as a tree of ≤8-input gates
  const andAll=L=>{ while(L.length>1){ const nx=[]; for(let i=0;i<L.length;i+=8){ const part=L.slice(i,i+8); nx.push(part.length===1?part[0]:gate("AND",part)); } L=nx; } return L[0]; };
  let n=0, tc=null;
  if(M>1){
    n=(M-1).toString(2).length;
    for(let i=0;i<n;i++){ comps.push({id:"ff"+i,type:"DFF"}); nets.push({from:"clk",to:"ff"+i+".clk"}); }
    const ones=[]; for(let i=0;i<n;i++) if(((M-1)>>>i)&1) ones.push("ff"+i+".q");
    tc=andAll(ones);
    const ntc=gate("NOT",[tc]);
    let carry=null;
    for(let i=0;i<n;i++){
      const q="ff"+i+".q";
      const x = i===0 ? "ff0.qn" : gate("XOR",[q, carry]);
      nets.push({from:gate("AND",[x, ntc]), to:"ff"+i+".d"});
      carry = i===0 ? q : gate("AND",[carry, q]);
    }
  }
  if(even){
    comps.push({id:"tq",type:"DFF"}); nets.push({from:"clk",to:"tq.clk"});
    nets.push({from: tc ? gate("XOR",["tq.q", tc]) : "tq.qn", to:"tq.d"});
    comps.push({id:"out",type:"OUT",name:out}); nets.push({from:"tq.q",to:"out"});
  } else {
    comps.push({id:"out",type:"OUT",name:out}); nets.push({from:"ff"+(n-1)+".q",to:"out"});
  }
  return {module:"div"+N, components:comps, nets, bits:n, modulus:M,
    note: even ? `นับ 0…${M-1} แล้วสลับ ${out} → ${out} = ${clk}/${N} (duty 50%)`
               : `นับ 0…${M-1}, ${out} = บิตสูงสุด → ${clk}/${N} (N คี่: duty ไม่ใช่ 50%)`};
}
GENERATORS.splice(GENERATORS.findIndex(g=>g.id==="jkmod")+1, 0,
  {id:"clkdiv", icon:"⏱", name:"หารความถี่ (N ใดก็ได้)", desc:"clk_in → clk_out = clk_in / N · เช่น 50 MHz → 20 Hz ใส่ 2500000", run:async()=>{
    const v=await uxAsk("หารความถี่ด้วย N",[
      {label:"หารด้วย (N)",type:"number",value:2500000,min:2,hint:"50 MHz → 1 Hz = 50000000 · → 20 Hz = 2500000"},
      {label:"ขาออก",value:"clk_out"}]);
    if(!v) return;
    const r=dividerIntent(v[0], {out:sanId(String(v[1]||"clk_out").trim()||"clk_out")});
    if(r.error){ toast("สร้างไม่ได้: "+r.error,"err"); return; }
    const dr=uxDrawGenerated(r, "หารความถี่ ÷"+r.module.slice(3));
    if(dr){ try{ zoomFit(); }catch(_){} toast(r.note,"info",8000); } }});
{
  const b=document.querySelector('#menu [data-gen="jkmod"]');
  if(b && !document.querySelector('#menu [data-gen="clkdiv"]')){
    const g=GENERATORS.find(x=>x.id==="clkdiv");
    b.insertAdjacentHTML("afterend", `<button class="gen-mi" data-gen="clkdiv" title="${escA(g.desc)}"><span class="gi">${g.icon}</span>${g.name}…</button>`);
    document.querySelector('#menu [data-gen="clkdiv"]').addEventListener("click",()=>runGenerator("clkdiv"));
  }
}
