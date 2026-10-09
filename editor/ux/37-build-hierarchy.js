/* ===== 37. build_hierarchy: a top sheet from a block list, wired in one go ===========================
   Testing the in-app AI on lab 6: the 4B model split the system into the right blocks, then fired
   connect after connect and ended with 2 wires in 10 minutes. Laying out a topology is what it does
   well; wiring bit by bit is not. So one call takes the whole plan —
     blocks:  [{name:"cnt", part:"bcd_counter_multi", params:{format:"00-99"}}, {name:"cmp", sheet:"compare"}]
     inputs:  ["clk", "btn", "sw[7:0]"]          outputs: ["err", "seg[6:0]"]
     connect: [["clk","cnt.clk"], ["cnt.ones","cmp.a_lo"], ["sw[3:0]","cmp.b_lo"], ["cmp.gt","err"], ["1","cnt.en"]]
   — expands every bus reference to bits (cnt.ones = ones0..ones3 on a per-bit block, sw[3:0], x[2]),
   checks widths / directions / double drivers BEFORE anything is drawn, joins the obvious rest by name
   (auto: a block's clk ← INPUT clk), draws it as one intent (placement + routing by the editor), turns
   the declared buses back into bus ports, and reports what is still open. One undo step; nothing is
   left behind when it fails (part sheets it made for the call are removed again). */
const BH_CONST={"0":"GND","gnd":"GND","low":"GND","1":"VCC","vcc":"VCC","high":"VCC"};
/* "sw[7:0]" | "clk" | {name, width} → {name, width} */
function bhPortDecl(d){
  if(d && typeof d==="object") return {name:String(d.name||"").trim(), width:Math.max(1, +d.width||1)};
  const m=/^\s*([A-Za-z_]\w*)\s*(?:\[\s*(\d+)\s*(?::\s*(\d+)\s*)?\])?\s*$/.exec(String(d||""));
  if(!m) mcpFail(`'${d}' is not a port: write clk, or sw[7:0] for a bus`);
  const w=m[2]!=null ? (m[3]!=null ? Math.abs(+m[2]-+m[3])+1 : +m[2]+1) : 1;
  return {name:m[1], width:w};
}
/* a sheet's ports grouped into buses: per-bit pins ones0..ones3 → {ones:{width:4, bits:["ones0",…]}} */
function bhPinGroups(sub){
  const G={}, ports=schPortList(sub);
  ports.forEach(p=>{ const e={id:p.id, dir:p.dir, width:p.width||1};
    G[p.id.toLowerCase()]={name:p.id, dir:p.dir, width:e.width, bits:e.width>1?null:[p.id]}; });
  // numbered 1-bit pins also form a group (unless a pin already has that name)
  const num={}; ports.filter(p=>(p.width||1)===1).forEach(p=>{ const m=/^(.*?[A-Za-z_])_?(\d+)$/.exec(p.id); if(!m) return;
    const k=m[1].toLowerCase(); (num[k]=num[k]||{name:m[1], dir:p.dir, list:[]}).list.push({i:+m[2], id:p.id, dir:p.dir}); });
  Object.entries(num).forEach(([k,g])=>{ if(G[k]) return; g.list.sort((a,b)=>a.i-b.i);
    if(g.list.every((x,j)=>x.i===j && x.dir===g.dir)) G[k]={name:g.name, dir:g.dir, width:g.list.length, bits:g.list.map(x=>x.id)}; });
  return G;
}
MCP_OPS.build_hierarchy = async a=>{
  const P=state.project.schematics;
  const blocks=Array.isArray(a.blocks)?a.blocks:[]; if(!blocks.length) mcpFail("blocks is required", 'e.g. blocks:[{name:"cnt", part:"bcd_counter_multi"}, {name:"cmp", sheet:"compare"}]');
  const ins=(a.inputs||[]).map(bhPortDecl), outs=(a.outputs||[]).map(bhPortDecl);
  const topName=String(a.sheet||a.name||"top").trim();
  const tgt=Object.values(P).find(s=>String(s.name).toLowerCase()===topName.toLowerCase());
  if(tgt && tgt.components.some(c=>c.type!=="JUNCTION") && !a.replace) mcpFail(`sheet '${tgt.name}' already has parts`, "replace:true rebuilds it (one undo brings it back), or give a new sheet name");
  const had=new Set(Object.keys(P)), fail=(m,h)=>{ Object.keys(P).forEach(id=>{ if(!had.has(id)) delete P[id]; }); mcpFail(m,h); };
  const names=new Set();
  [...ins, ...outs].forEach(p=>{ const k=p.name.toLowerCase(); if(!p.name) mcpFail("a port without a name");
    if(names.has(k)) mcpFail(`port '${p.name}' is declared twice`); names.add(k);
    if(p.width>1 && /\d$/.test(p.name)) mcpFail(`bus '${p.name}' ends with a digit — its bits would be ambiguous`, "e.g. d_in[3:0] instead of d1[3:0]"); });
  mcpBeforeChange("ประกอบแผ่น "+topName);
  // 1. the blocks: an existing sheet, or a verified part drawn once for the project
  const B={};
  for(let b of blocks){
    // an existing sheet given where a part goes (part:"div5", part:"sheet:div5", block:"div5") is that sheet
    const strip=v=>String(v).replace(/^\s*(sheet|block|sch|module)\s*:\s*/i,"").trim();
    if(!b.sheet && !b.part && b.block) b=Object.assign({}, b, {sheet:strip(b.block)});
    if(b.part && !PARTS[b.part]){ const want=strip(b.part).toLowerCase(), ex=Object.values(P).find(s=>String(s.name).toLowerCase()===want);
      if(ex){ b=Object.assign({}, b, {sheet:ex.name}); delete b.part; } }
    const nm=sanId(String(b.name||b.id||"").trim()); if(!nm) fail("every block needs a name", 'e.g. {name:"cnt", part:"bcd_counter_multi"}');
    if(B[nm.toLowerCase()] || names.has(nm.toLowerCase())) fail(`name '${nm}' is used twice (blocks and ports need different names)`);
    let sub=null;
    if(b.part){ if(!PARTS[b.part]) fail(`unknown part '${b.part}'`, "list_parts shows them — an existing sheet goes in sheet:'<name>' (sheets: "+Object.values(P).map(s=>s.name).join(", ")+")");
      try{ partCheckArgs(b.part, b.params||{}); }catch(e){ fail(`block ${nm}: ${e.message}`, e.hint); }
      try{ const sn=ptSub(b.part, Object.assign({}, b.params||{})); sub=Object.values(P).find(s=>s.name===sn); }
      catch(e){ fail(`block ${nm}: ${e.message}`, e.hint); } }
    else if(b.sheet || b.module){ const want=String(b.sheet||b.module).toLowerCase(); sub=Object.values(P).find(s=>String(s.name).toLowerCase()===want);
      if(!sub) fail(`block ${nm}: no sheet '${b.sheet||b.module}'`, "sheets: "+Object.values(P).map(s=>s.name).join(", ")+" — or give part:<kind>"); }
    else fail(`block ${nm}: give sheet:<sheet name> or part:<kind>`);
    if(tgt && sub.id===tgt.id) fail(`block ${nm} would place the sheet inside itself`);
    B[nm.toLowerCase()]={name:nm, sub, pins:bhPinGroups(sub)};
  }
  // 2. references → bits (LSB first): {src:true, ref} for what drives, {sink:true, key} for what is driven
  const IN_=Object.fromEntries(ins.map(p=>[p.name.toLowerCase(), p])), OUT_=Object.fromEntries(outs.map(p=>[p.name.toLowerCase(), p]));
  const bitName=(p,i)=>p.width>1 ? p.name+i : p.name;
  const slice=(w, lo, hi, what)=>{ if(hi==null) hi=lo; if(lo==null){ lo=0; hi=w-1; }
    const L=Math.min(lo,hi), H=Math.max(lo,hi); if(H>=w) fail(`${what}: bit ${H} is past its width ${w}`);
    const r=[]; for(let i=L;i<=H;i++) r.push(i); return r; };
  const expand=raw=>{
    const s=String(raw).trim(), low=s.toLowerCase();
    if(BH_CONST[low]) return {kind:"const", type:BH_CONST[low]};
    const m=/^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?(?:\[\s*(\d+)\s*(?::\s*(\d+)\s*)?\])?$/.exec(s);
    if(!m) fail(`'${raw}' is not a signal`, "a port (clk, sw[3:0], sw[5]), a block pin (cnt.q, cnt.ones[2]) or 0 / 1");
    const hi=m[3]!=null?+m[3]:null, lo=m[4]!=null?+m[4]:hi;
    if(m[2]==null){
      const p=IN_[low.replace(/\[.*$/,"")] || OUT_[low.replace(/\[.*$/,"")];
      if(!p) fail(`'${m[1]}' is neither a declared port nor a block`, "inputs: "+ins.map(x=>x.name).join(", ")+" · outputs: "+outs.map(x=>x.name).join(", ")+" · blocks: "+Object.values(B).map(x=>x.name).join(", "));
      const isIn=!!IN_[m[1].toLowerCase()];
      return {kind:isIn?"src":"sink", label:s, bits:slice(p.width, lo, hi, s).map(i=>isIn ? {ref:"i_"+bitName(p,i)} : {key:"o:"+bitName(p,i), out:bitName(p,i)})};
    }
    const bk=B[m[1].toLowerCase()]; if(!bk) fail(`no block '${m[1]}'`, "blocks: "+Object.values(B).map(x=>x.name).join(", "));
    const g=bk.pins[m[2].toLowerCase()];
    if(!g) fail(`block ${bk.name} (${bk.sub.name}) has no pin '${m[2]}'`, "its pins: "+Object.values(bk.pins).filter(x=>x.bits).map(x=>x.dir+" "+x.name+(x.width>1?`[${x.width-1}:0]`:"")).join(", "));
    // a block's BUS pin (a module built with bus:true): its bits are wired through bus taps after drawing
    if(!g.bits) return {kind:g.dir==="in"?"sink":"src", label:s, bits:slice(g.width, lo, hi, s).map(i=>{ const r=`${bk.name}.${g.name}[${i}]`;
      return g.dir==="in" ? {key:r, blk:bk.name, bus:true} : {ref:r, bus:true}; })};
    return {kind:g.dir==="in"?"sink":"src", label:s, bits:slice(g.width, lo, hi, s).map(i=>g.dir==="in" ? {key:bk.name+"."+g.bits[i], blk:bk.name, pin:g.bits[i]} : {ref:bk.name+"."+g.bits[i]})};
  };
  const drive={}, how={};                       // sink key → source ref (or {c:"GND"})
  const join=(src, sink, why)=>{ sink.bits.forEach((k,i)=>{ const s=src.kind==="const" ? {c:src.type} : src.bits[i];
      if(drive[k.key]) fail(`${sink.label}${sink.bits.length>1?` bit ${i}`:""} is driven twice (${how[k.key]} and ${why})`);
      drive[k.key]=s; how[k.key]=why; }); };
  // also written as text: "clk_in -> d5.clk_in", "d5.clk_out → d10.clk_in, d10.en", several split by ; or new lines
  const conns=[].concat(a.connect||a.connections||[]).flatMap(c=>typeof c!=="string" ? [c] :
    c.split(/[;\n]+/).map(x=>x.trim()).filter(Boolean).map(x=>x.split(/\s*(?:->|=>|→|>)\s*/).flatMap(y=>y.split(/\s*,\s*/)).filter(Boolean)));
  conns.forEach((c,ci)=>{
    const list=Array.isArray(c) ? c : (c && c.from!=null ? [c.from].concat(c.to) : null);
    if(!list || list.length<2) fail(`connect[${ci}] must be [from, to, …]`);
    const E=list.map(expand), srcs=E.filter(e=>e.kind==="src"||e.kind==="const"), sinks=E.filter(e=>e.kind==="sink");
    if(srcs.length!==1) fail(`connect[${ci}] ${JSON.stringify(list)}: needs exactly one driver (an input, a block output or 0/1), has ${srcs.length}`,
      srcs.length ? "two outputs cannot be joined" : "an output port or a block input only receives");
    sinks.forEach(k=>{ if(srcs[0].kind!=="const" && srcs[0].bits.length!==k.bits.length)
      fail(`connect[${ci}]: ${srcs[0].label} is ${srcs[0].bits.length} bit(s) but ${k.label} is ${k.bits.length}`, "take a slice, e.g. sw[3:0] or cnt.ones[2]");
      join(srcs[0], k, srcs[0].label+" → "+k.label); });
  });
  // 3. the obvious rest, by name: a block's clk ← INPUT clk, OUTPUT err ← the one block output named err
  const auto=[];
  if(a.auto!==false){
    Object.values(B).forEach(bk=>Object.values(bk.pins).filter(g=>g.dir==="in" && g.bits).forEach(g=>{
      const p=IN_[g.name.toLowerCase()]; if(!p || p.width!==g.width) return;
      if(g.bits.some(b=>drive[bk.name+"."+b])) return;
      join(expand(p.name), expand(bk.name+"."+g.name), "auto (same name)"); auto.push(`${p.name} → ${bk.name}.${g.name}`); }));
    outs.forEach(p=>{ if(Array.from({length:p.width},(_,i)=>drive["o:"+bitName(p,i)]).some(Boolean)) return;
      const hits=Object.values(B).flatMap(bk=>Object.values(bk.pins).filter(g=>g.dir==="out" && g.bits && g.name.toLowerCase()===p.name.toLowerCase() && g.width===p.width).map(g=>bk.name+"."+g.name));
      if(hits.length===1){ join(expand(hits[0]), expand(p.name), "auto (same name)"); auto.push(`${hits[0]} → ${p.name}`); } });
  }
  // 4. the intent: one IN per input bit, the blocks, one OUT per output bit
  const t=ptIntent(sanId(topName));
  ins.forEach(p=>{ for(let i=0;i<p.width;i++) t.IN(bitName(p,i)); });
  Object.values(B).forEach(bk=>t.components.push({id:bk.name, type:"block:"+bk.sub.name}));
  const srcRef=s=>s.c ? t.X(s.c) : s.ref;
  const viaTaps=[];                             // [from, to] that touch a block's bus pin: connect after drawing
  Object.entries(drive).forEach(([k,s])=>{ if(k.startsWith("o:")) return;
    if(s.bus || /\[\d+\]$/.test(k)) viaTaps.push([srcRef(s), k]); else t.W(srcRef(s), k); });
  const undriven=[];
  outs.forEach(p=>{ for(let i=0;i<p.width;i++){ const bn=bitName(p,i), s=drive["o:"+bn];
    if(s && s.bus){ t.components.push({id:"o_"+bn, type:"OUT", name:bn}); viaTaps.push([s.ref, "o_"+bn]); }
    else if(s) t.OUT(bn, srcRef(s)); else { t.components.push({id:"o_"+bn, type:"OUT", name:bn}); undriven.push(bn); } } });
  const it={module:t.module, components:t.components, nets:t.nets};
  const v=validateIntent(it);
  if(!v.ok) fail("could not assemble: "+v.errors.slice(0,4).map(e=>e.msg).join("; "));
  const dr=aiDrawIntent(it);
  if(!dr||!dr.ok) fail("could not draw it: "+((dr&&(dr.error||(dr.errors||[]).map(e=>e.msg||e).join("; ")))||"?"));
  let sch=dr.sch;
  sch.components.forEach(c=>{ if(B[String(c.id).toLowerCase()]) c.label=B[String(c.id).toLowerCase()].name; });
  sch.portOrder={in:ins.flatMap(p=>Array.from({length:p.width},(_,i)=>bitName(p,p.width-1-i))), out:outs.flatMap(p=>Array.from({length:p.width},(_,i)=>bitName(p,p.width-1-i)))};
  const buses=[...ins, ...outs].filter(p=>p.width>1).map(p=>p.name), warnings=[], tapOf={};
  if(buses.length && a.bus!==false){ try{ busifyPorts(sch, buses).forEach(m=>(m.taps||[]).forEach(([c,t])=>tapOf[c]=t)); }
    catch(e){ warnings.push(`bus ports ${buses.join(", ")} stay as single bits (${buses.map(b=>b+"0…").join(", ")}): ${e.message}`); } }
  // bits of block BUS pins: a merge / split tap per bit (21), joined to the port's own tap when it became a bus
  if(viaTaps.length){
    const ref=r=>tapOf[r] ? tapOf[r]+".y" : r;
    try{ const was=MCPB.inBatch; MCPB.inBatch=true;
      try{ MCP_OPS.connect({sheet:sch.name, connections:viaTaps.map(([f,t])=>[ref(f), ref(t)])}); } finally{ MCPB.inBatch=was; } }
    catch(e){ delete P[sch.id]; fail(`could not wire the bus pins: ${e.message}`, e.hint); } }
  // every declared port is on the sheet — as a bus port, or as all its bits — before this says "done"
  const portsOn=new Map(sch.components.filter(c=>c.type==="IN"||c.type==="OUT").map(c=>[String(c.params.name).toLowerCase(), c]));
  const missing=[...ins.map(p=>[p,"IN"]), ...outs.map(p=>[p,"OUT"])].filter(([p,T])=>{
    const bus=portsOn.get(p.name.toLowerCase());
    if(bus && bus.type===T && (bus.params.width||1)===p.width) return false;
    return !Array.from({length:p.width},(_,i)=>portsOn.get(bitName(p,i).toLowerCase())).every(c=>c && c.type===T); }).map(([p])=>p.name);
  if(missing.length){ delete P[sch.id]; fail(`ports ${missing.join(", ")} did not come out on the sheet — nothing was changed`, "report this; meanwhile declare them as single bits (an0, an1, …)"); }
  if(tgt){
    // a sheet other sheets use as a block keeps its ports, or their wires would come loose
    const par=typeof busParents==="function" ? busParents(tgt) : [];
    if(par.length){ const sig=x=>schPortList(x).map(p=>p.dir+":"+String(p.id).toLowerCase()+":"+(p.width||1)).sort().join(" ");
      if(sig(tgt)!==sig(sch)){ delete P[sch.id]; fail(`'${tgt.name}' is used as a block in ${par.join(", ")} — its ports would change (now ${schPortList(tgt).map(p=>p.id).join(", ")}; the plan gives ${schPortList(sch).map(p=>p.id).join(", ")}) — nothing was changed`,
        "declare exactly the same inputs / outputs (names and widths) so the sheets using it stay wired"); } }
    tgt.components=sch.components; tgt.wires=sch.wires; tgt.portOrder=sch.portOrder;
    ["verified","builtFrom","fsm"].forEach(k=>delete tgt[k]); delete P[sch.id]; state.openTabs=(state.openTabs||[]).filter(i=>i!==sch.id); sch=tgt; }
  else sch.name=uniqueSchName(topName, sch.id);
  if(a.pins && typeof a.pins==="object") sch.pinmap=Object.assign({}, sch.pinmap||{}, a.pins);
  if(a.top) state.project.topId=sch.id;
  openSchTab(sch.id); mcpActivity("ประกอบ "+sch.name+" จาก "+blocks.length+" บล็อก"); mcpCommit(sch); try{ zoomFit(); }catch(_){}
  // 5. what is still open
  const open=[]; Object.values(B).forEach(bk=>Object.values(bk.pins).filter(g=>g.dir==="in").forEach(g=>{
    if(!g.bits){ const miss=Array.from({length:g.width},(_,i)=>i).filter(i=>!drive[`${bk.name}.${g.name}[${i}]`]);
      if(miss.length) open.push(`${bk.name}.${g.name}`+(miss.length<g.width?` (bits ${miss.join(",")})`:"")); return; }
    const miss=g.bits.filter(b=>!drive[bk.name+"."+b]); if(miss.length) open.push(`${bk.name}.${g.name}`+(g.width>1&&miss.length<g.width?` (bits ${miss.map(b=>g.bits.indexOf(b)).join(",")})`:"")); }));
  let chk=null; try{ const c=MCP_OPS.check({sheet:sch.name}); chk={errors:c.errors, warnings:c.warnings}; }catch(_){}
  return {sheet:sch.name, blocks:Object.values(B).map(bk=>({name:bk.name, sheet:bk.sub.name, verified:sheetVerified(bk.sub)})),
    connected_bits:Object.keys(drive).length, auto_connected:auto, unconnected_block_inputs:open, undriven_outputs:undriven, check:chk,
    ...(warnings.length?{warnings}:{}),
    note:open.length||undriven.length ? "draw the rest with another build_hierarchy {replace:true} (whole plan) or connect" : "every block input and output is wired"};
};
