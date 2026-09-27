/* =========================================================================
   8. CLAUDE BRIDGE (MCP)
   The MCP server (launcher/mcp_server.py) sends operations through the launcher
   (POST /api/mcp/call → this page long-polls /api/mcp/poll). Every operation runs
   HERE, with the editor's own engine — the same placer, router, checker, simulator
   and VHDL generator the user has — so what Claude builds is exactly what the user
   sees, live, and every change is one Ctrl+Z / a timeline checkpoint.
   Only a page served by the launcher connects (same origin); a page opened from
   disk never does.
   ========================================================================= */
const MCPB = { on:false, busy:false, client:"ed"+Math.random().toString(36).slice(2,9), events:[], seq:0,
               lastCheckpoint:0, calls:0, lastOp:"", byClaude:false };
const MCP_OPS = {};
class McpError extends Error { constructor(msg, hint){ super(msg); this.hint=hint; } }
const mcpFail = (msg, hint) => { throw new McpError(msg, hint); };

/* ---------- references: "g3", "a" (IN/OUT name), "U1" (label), "g3.i0", "U1.q" ---------- */
function mcpSheet(ref){
  if(ref==null || ref==="") return activeSch() || mcpFail("no sheet is open");
  const P=state.project.schematics, low=String(ref).toLowerCase();
  const s = P[ref] || Object.values(P).find(x=>String(x.name).toLowerCase()===low);
  return s || mcpFail(`sheet '${ref}' not found`, "sheets: "+Object.values(P).map(x=>x.name).join(", "));
}
/* run against a sheet: it becomes the active tab so the user watches the change */
function mcpUse(ref){ const s=mcpSheet(ref); if(state.activeId!==s.id){ openSchTab(s.id); } return s; }
function mcpComp(sch, ref){
  const c=findCompRef(sch, ref);
  if(c) return c;
  const names=sch.components.filter(x=>x.type!=="JUNCTION").slice(0,40).map(mcpName);
  mcpFail(`component '${ref}' not found on sheet '${sch.name}'`, "use an id, an IN/OUT name or a label: "+names.join(", "));
}
function mcpName(c){ return (c.type==="IN"||c.type==="OUT") ? ((c.params&&c.params.name)||c.id) : (c.label||c.id); }
/* "U1.q" → {c, p}. A bare component means its only/first output (as a source) or first free input (as a sink). */
function mcpPin(sch, ref, role){
  ref=String(ref||"").trim(); if(!ref) mcpFail("empty pin reference");
  let c=findCompRef(sch, ref), pid=null;
  if(!c){ const i=ref.lastIndexOf("."); if(i>0){ c=findCompRef(sch, ref.slice(0,i)); pid=ref.slice(i+1); } }
  if(!c) mcpComp(sch, ref.split(".")[0]);
  const ports=getPorts(c);
  if(pid==null){
    if(role==="any"){ if(ports.length!==1) mcpFail(`${mcpName(c)} has several pins — name one`, "pins: "+ports.map(x=>mcpName(c)+"."+x.id).join(", ")); pid=ports[0].id; }
    else if(role==="source"){ const o=ports.filter(p=>p.dir==="out"); if(!o.length) mcpFail(`${mcpName(c)} has no output pin`); pid=o[0].id; }
    else { const ins=ports.filter(p=>p.dir==="in"); if(!ins.length) mcpFail(`${mcpName(c)} has no input pin`);
      const used=new Set(sch.wires.filter(w=>w.to.cid===c.id).map(w=>w.to.pid));
      const free=ins.find(p=>!used.has(p.id)); if(!free) mcpFail(`every input of ${mcpName(c)} is already connected`, "name the pin: "+ins.map(p=>mcpName(c)+"."+p.id).join(", ")); pid=free.id; }
  }
  const p=ports.find(x=>x.id===pid);
  if(!p) mcpFail(`pin '${pid}' does not exist on ${mcpName(c)} (${c.type})`, "pins: "+ports.map(x=>`${x.id}(${x.dir})`).join(", "));
  return {c, p};
}

/* ---------- describing the design compactly (what Claude reads) ---------- */
function mcpTrimParams(c){ const p=Object.assign({}, c.params||{}); delete p.fixed; delete p.endpoint; return p; }
function mcpCompInfo(sch, c, detail){
  const sz=getSize(c), ports=getPorts(c);
  const o={ id:c.id, type:String(c.type).startsWith("SCH:") ? "block:"+((state.project.schematics[c.type.slice(4)]||{}).name||c.type) : c.type, name:mcpName(c) };
  if(c.type==="IN"||c.type==="OUT") o.width=(c.params&&c.params.width)||1;
  if(c.label && !(c.type==="IN"||c.type==="OUT")) o.label=c.label;
  if(detail!=="brief"){
    o.x=c.x; o.y=c.y; o.w=sz.w; o.h=sz.h; if(c.rot) o.rot=c.rot;
    const pr=mcpTrimParams(c); delete pr.name; delete pr.width; if(Object.keys(pr).length) o.params=pr;
    o.pins=ports.map(p=>{ const pp=portPos(c,p.id)||{};
      const conn=sch.wires.some(w=>(w.to.cid===c.id&&w.to.pid===p.id)||(w.from.cid===c.id&&w.from.pid===p.id));
      return Object.assign({id:p.id, dir:p.dir}, (p.width||1)>1?{width:p.width}:{}, {x:pp.x, y:pp.y, connected:conn}); });
  }
  return o;
}
/* nets through junctions: one driver pin, its sinks, the net name if any */
function mcpNets(sch){
  const seen=new Set(), nets=[];
  const ref=(cid,pid)=>{ const c=comp(cid,sch); return c ? mcpName(c)+"."+pid : cid+"."+pid; };
  (sch.wires||[]).forEach(w=>{
    if(seen.has(w.id)) return;
    const ids=[...netWires(sch, w)]; ids.forEach(id=>seen.add(id));   // netWires returns a Set
    const ws=ids.map(id=>sch.wires.find(x=>x.id===id)).filter(Boolean);
    let drv=null; try{ drv=netDriverPort(sch, w); }catch(_){}
    const sinks=new Set(), drivers=new Set();
    ws.forEach(x=>[x.from,x.to].forEach(ep=>{ const c=comp(ep.cid,sch); if(!c||c.type==="JUNCTION"||c.type==="BUSTAP") return;
      const p=getPorts(c).find(q=>q.id===ep.pid); if(!p) return;
      (p.dir==="out"?drivers:sinks).add(ref(ep.cid,ep.pid)); }));
    const name=(ws.find(x=>x.name)||{}).name||"";
    const n={ driver: drv?ref(drv.cid,drv.pid):null, sinks:[...sinks] };
    if(name) n.name=name;
    if(drivers.size>1) n.problem="multiple drivers: "+[...drivers].join(", ");
    else if(!drv) n.problem="no driver";
    nets.push(n);
  });
  return nets;
}
function mcpSheetInfo(sch, detail){
  const comps=sch.components.filter(c=>c.type!=="JUNCTION");
  const out={ sheet:sch.name, id:sch.id, top:sch.id===state.project.topId, locked:!!sch.locked,
    ports: sheetPorts(sch).length ? schPortList(sch).map(p=>({name:p.id, dir:p.dir, width:p.width})) : [],
    components: comps.map(c=>mcpCompInfo(sch,c,detail)),
    nets: mcpNets(sch) };
  if(sch.pinmap && Object.keys(sch.pinmap).length) out.pinmap=sch.pinmap;
  return out;
}
function mcpLayoutMetrics(sch){
  const m={}; try{ m.overlap_same_net=netSelfOverlaps(sch).length; m.overlap_other_net=netCollinearOverlaps(sch).length;
    m.wire_through_part=wireBodyCrossings(sch).length; m.wire_through_pin=wirePinCrossings(sch).length; }catch(_){}
  try{ m.score=Math.round(uxLayoutScore(sch)); }catch(_){}
  const cs=sch.components.filter(c=>c.type!=="JUNCTION");
  if(cs.length){ const xs=cs.map(c=>c.x), ys=cs.map(c=>c.y), xe=cs.map(c=>c.x+getSize(c).w), ye=cs.map(c=>c.y+getSize(c).h);
    m.bbox={x:Math.min(...xs), y:Math.min(...ys), w:Math.max(...xe)-Math.min(...xs), h:Math.max(...ye)-Math.min(...ys)}; }
  // parts sitting on top of each other
  let ov=0; for(let i=0;i<cs.length;i++) for(let j=i+1;j<cs.length;j++){ const a=cs[i], b=cs[j], A=getSize(a), B=getSize(b);
    if(a.x<b.x+B.w && b.x<a.x+A.w && a.y<b.y+B.h && b.y<a.y+A.h) ov++; }
  m.parts_overlapping=ov;
  m.clean = !m.overlap_same_net && !m.overlap_other_net && !m.wire_through_part && !m.wire_through_pin && !ov;
  return m;
}
function mcpIssues(sch){
  const all=uxQuietIssues().filter(i=>!sch || !i.schId || i.schId===sch.id);
  return all.map(i=>{ const c=i.cid&&sch?comp(i.cid,sch):null; const o={level:i.lvl==="err"?"error":i.lvl==="warn"?"warning":"info", message:i.msg};
    if(i.ref) o.sheet=i.ref; if(c) o.component=mcpName(c); const fix=issueFix(i.msg); if(fix) o.fix=fix; return o; });
}

/* ---------- change bookkeeping: one undo step per call, a checkpoint per burst ---------- */
function mcpBeforeChange(label){
  if(Date.now()-MCPB.lastCheckpoint > 90000){ MCPB.lastCheckpoint=Date.now(); try{ uxTimelineAdd("ก่อน Claude แก้ ("+label+")", true); }catch(_){} }
}
function mcpCommit(sch, opts){
  opts=opts||{};
  if(opts.route && sch){ try{ normalizePortFanout(sch); }catch(_){} }
  if(opts.routeWires && sch && !sch.locked){ try{ healLayout(sch, scopeOf(sch,{wires:opts.routeWires})); }catch(_){} }
  MCPB.byClaude=true; try{ snapshot(); } finally { MCPB.byClaude=false; }
  renderAll();
}
/* default spot by role: INPUTs stack in a left column, OUTPUTs in a right column, logic in between */
function mcpFreeSpot(sch, w, h, type){
  const cs=sch.components.filter(c=>c.type!=="JUNCTION");
  if(!cs.length) return {x:snap(type==="OUT"?660:type==="IN"?88:330), y:snap(110)};
  const col=t=>cs.filter(c=>c.type===t), minX=Math.min(...cs.map(c=>c.x)), maxX=Math.max(...cs.map(c=>c.x+getSize(c).w));
  const below=list=>list.length?Math.max(...list.map(c=>c.y+getSize(c).h))+22:Math.min(...cs.map(c=>c.y));
  if(type==="IN"){ const ins=col("IN"); return {x:snap(ins.length?ins[0].x:minX-176), y:snap(below(ins))}; }
  if(type==="OUT"){ const outs=col("OUT"); return {x:snap(outs.length?outs[0].x:maxX+176), y:snap(below(outs))}; }
  const mid=cs.filter(c=>c.type!=="IN"&&c.type!=="OUT");
  const x0=col("IN").length?Math.max(...col("IN").map(c=>c.x+getSize(c).w))+110:minX;
  return {x:snap(mid.length?Math.max(...mid.map(c=>c.x+getSize(c).w))+88:x0), y:snap(Math.min(...cs.map(c=>c.y)))};
}
function mcpActivity(text){
  MCPB.lastOp=text;
  const el=$("#mcpChip"); if(el){ el.classList.add("busy"); el.title="Claude: "+text; clearTimeout(mcpActivity._t);
    mcpActivity._t=setTimeout(()=>el.classList.remove("busy"), 1500); }
}

/* =================== operations =================== */
MCP_OPS.status = ()=>({
  editor:"Schematic Studio", project:state.project.name, active_sheet:(activeSch()||{}).name||null,
  top_sheet:(state.project.schematics[state.project.topId]||{}).name||null,
  sheets:Object.values(state.project.schematics).map(s=>({name:s.name, id:s.id, top:s.id===state.project.topId,
    parts:s.components.filter(c=>c.type!=="JUNCTION").length, wires:s.wires.length})),
  projects_in_workspace:Object.values(state.projects).map(p=>p.name),
  unsaved_changes:!!UX.dirty, can_undo:state.history.idx>0,
});
MCP_OPS.list_component_types = ()=>Object.entries(TYPES).filter(([,t])=>!["wire","custom","sch"].includes(t.category)).map(([k,t])=>{
  const p=JSON.parse(JSON.stringify(t.defaultParams||{}));
  let pins=[]; try{ pins=t.ports(p).map(q=>q.id+"("+q.dir+((q.width||1)>1?","+q.width+"b":"")+")"); }catch(_){}
  // every setting with its allowed values, so Claude knows e.g. that a MUX has a bit width
  const help=(t.paramSchema||[]).map(s=>s.key+": "+s.label+(s.options?" (one of "+s.options.join("/")+")":s.type==="int"?" ("+(s.min!=null?s.min:"")+".."+(s.max!=null?s.max:"")+")":""));
  return {type:k, label:t.label, category:t.category, params:p, param_help:help, pins};
});
MCP_OPS.get_sheet = a=>mcpSheetInfo(mcpSheet(a.sheet), a.detail||"full");
MCP_OPS.get_netlist = a=>{ const s=mcpSheet(a.sheet); return {sheet:s.name, nets:mcpNets(s)}; };
MCP_OPS.open_sheet = a=>{ const s=mcpUse(a.sheet); try{ zoomFit(); }catch(_){} return {active_sheet:s.name}; };
MCP_OPS.new_sheet = a=>{
  const name=String(a.name||"").trim()||"sheet"; const id=uid("sch");
  state.project.schematics[id]=blankSchematic(id, uniqueSchName(name, id));
  if(a.make_top) state.project.topId=id;
  openSchTab(id); mcpCommit(null);
  return {sheet:state.project.schematics[id].name, id, top:state.project.topId===id};
};
MCP_OPS.set_top_sheet = a=>{ const s=mcpSheet(a.sheet); state.project.topId=s.id; mcpCommit(null); return {top_sheet:s.name}; };
MCP_OPS.rename_sheet = a=>{ const s=mcpSheet(a.sheet); s.name=uniqueSchName(a.name, s.id); mcpCommit(null); return {sheet:s.name}; };

MCP_OPS.add_component = a=>{
  const sch=mcpUse(a.sheet);
  let type=String(a.type||"").trim();
  if(/^block:/i.test(type)){ const sub=mcpSheet(type.slice(6)); type="SCH:"+sub.id;
    const why=subBlockBlockedWhy(sub.id, sch.id); if(why) mcpFail(why); }
  else { type=type.toUpperCase(); if(!TYPES[type]) mcpFail(`unknown component type '${a.type}'`, "call list_component_types; blocks are 'block:<sheet name>'"); }
  mcpBeforeChange("เพิ่ม "+type);
  const td=type.startsWith("SCH:")?schTypeDef(state.project.schematics[type.slice(4)]):TYPES[type];
  const params=type.startsWith("SCH:")?{}:Object.assign(JSON.parse(JSON.stringify(td.defaultParams||{})), a.params||{});
  let sz={w:60,h:40}; try{ sz=td.size(params); }catch(_){}
  const at=(a.x!=null&&a.y!=null)?{x:snap(a.x), y:snap(a.y)}:mcpFreeSpot(sch, sz.w, sz.h, type);
  if(a.x==null) MCPB.placedFree=true;
  const c={id:uid("c"), type, x:at.x, y:at.y, params, label:""};
  // a name Claude will refer to later must be exactly the one it asked for — never silently "sum_1"
  const want=(a.label||a.name) ? String(a.label||a.name).trim() : "";
  if(want){ const clash=sch.components.find(x=>mcpName(x).toLowerCase()===(type==="IN"||type==="OUT"?sanId(want):want).toLowerCase());
    if(clash) mcpFail(`'${want}' is already used by ${clash.type} ${clash.id} on sheet '${sch.name}'`, "use that part, delete it first, or choose another name"); }
  if(type==="IN"||type==="OUT"){ c.params.name=_uniquePortName(sch, type, sanId(want||(type==="IN"?"in":"out"))); c.params.width=Math.max(1, +(a.width||c.params.width||1)); }
  else if(want) c.label=uniqueLabel(sch, want);
  if(a.rot) c.rot=((+a.rot%360)+360)%360;
  sch.components.push(c);
  if(a.x==null) uxNudgeFree(sch, c);
  mcpActivity("เพิ่ม "+type+" "+mcpName(c));
  mcpCommit(sch);
  return mcpCompInfo(sch, c, "full");
};
MCP_OPS.connect = a=>{
  const sch=mcpUse(a.sheet);
  const pairs=a.connections || [[a.from, a.to]];
  if(!pairs.length) mcpFail("nothing to connect");
  mcpBeforeChange("ต่อสาย");
  const before=new Set(sch.wires.map(w=>w.id)), made=[];
  pairs.forEach(([f,t])=>{
    const A=mcpPin(sch, f, "source"), B=mcpPin(sch, t, "sink");
    if(A.p.dir!=="out" && A.c.type!=="JUNCTION") mcpFail(`'${f}' is an input — a wire must start at an output`, "swap from/to?");
    if(B.p.dir!=="in") mcpFail(`'${t}' is an output — a wire must end at an input`);
    if(sch.wires.some(w=>w.to.cid===B.c.id&&w.to.pid===B.p.id)) mcpFail(`${mcpName(B.c)}.${B.p.id} is already driven`, "disconnect it first, or pick another pin");
    const w={id:uid("w"), from:{cid:A.c.id,pid:A.p.id}, to:{cid:B.c.id,pid:B.p.id}, name:a.net_name||""};
    sch.wires.push(w); made.push(`${mcpName(A.c)}.${A.p.id} → ${mcpName(B.c)}.${B.p.id}`);
  });
  mcpActivity("ต่อสาย "+made.join(", "));
  try{ normalizePortFanout(sch); }catch(_){}
  mcpCommit(sch, {routeWires: sch.wires.filter(w=>!before.has(w.id))});
  return {connected:made, layout:mcpLayoutMetrics(sch)};
};
MCP_OPS.disconnect = a=>{
  const sch=mcpUse(a.sheet); mcpBeforeChange("ตัดสาย");
  let gone=[];
  if(a.pin){ const {c,p}=mcpPin(sch, a.pin, "any");
    const hit=sch.wires.filter(w=>(w.to.cid===c.id&&w.to.pid===p.id)||(w.from.cid===c.id&&w.from.pid===p.id));
    if(!hit.length) mcpFail(`${a.pin} has no wire`);
    const ids=new Set(); hit.forEach(w=>netWires(sch,w).forEach(id=>{ const x=sch.wires.find(y=>y.id===id);
      if(x && ((x.to.cid===c.id&&x.to.pid===p.id)||(x.from.cid===c.id&&x.from.pid===p.id))) ids.add(id); }));
    sch.wires=sch.wires.filter(w=>!ids.has(w.id)); gone=[...ids];
  } else if(a.from && a.to){
    const A=mcpPin(sch,a.from,"source"), B=mcpPin(sch,a.to,"any");
    const w=sch.wires.find(x=>x.to.cid===B.c.id&&x.to.pid===B.p.id);
    if(!w) mcpFail(`${a.to} is not connected`);
    let drv=null; try{ drv=netDriverPort(sch,w); }catch(_){}
    if(!drv || drv.cid!==A.c.id || drv.pid!==A.p.id) mcpFail(`${a.to} is not driven by ${a.from}`);
    sch.wires=sch.wires.filter(x=>x!==w); gone=[w.id];
  } else mcpFail("give 'pin' (drop everything on that pin) or 'from' + 'to'");
  try{ healJunctions(sch); }catch(_){}
  mcpActivity("ตัดสาย"); mcpCommit(sch);
  return {removed_wires:gone.length};
};
MCP_OPS.delete = a=>{
  const sch=mcpUse(a.sheet); const refs=a.refs||[a.ref];
  const cs=refs.map(r=>mcpComp(sch,r)); mcpBeforeChange("ลบ");
  const ids=new Set(cs.map(c=>c.id));
  sch.components=sch.components.filter(c=>!ids.has(c.id));
  sch.wires=sch.wires.filter(w=>!ids.has(w.from.cid)&&!ids.has(w.to.cid));
  try{ healJunctions(sch); }catch(_){}
  mcpActivity("ลบ "+cs.map(mcpName).join(", ")); mcpCommit(sch);
  return {deleted:cs.map(mcpName)};
};
MCP_OPS.update_component = a=>{
  const sch=mcpUse(a.sheet), c=mcpComp(sch, a.ref); mcpBeforeChange("แก้ "+mcpName(c));
  const ch=[];
  if(a.name!=null){ if(c.type==="IN"||c.type==="OUT"){ c.params.name=_uniquePortName(sch,c.type,sanId(a.name),c); } else c.label=uniqueLabel(sch,a.name,c); ch.push("name"); }
  if(a.params){ const keep=getPorts(c).map(p=>p.id).join(); Object.assign(c.params=c.params||{}, a.params); ch.push("params");
    if(getPorts(c).map(p=>p.id).join()!==keep) _pruneDeadWires(sch); }
  if(a.type){ const nt=String(a.type).toUpperCase(); if(!EDIT_GATES.has(nt)||!EDIT_GATES.has(c.type)) mcpFail("type can only change between basic gates (AND OR XOR NAND NOR XNOR NOT BUF)"); c.type=nt; ch.push("type"); }
  if(a.x!=null||a.y!=null){ if(layoutLocked(sch)) mcpFail("sheet layout is locked", "unlock it (lock_layout false) first"); if(a.x!=null) c.x=snap(a.x); if(a.y!=null) c.y=snap(a.y); ch.push("position"); }
  if(a.rot!=null){ c.rot=((+a.rot%360)+360)%360; ch.push("rotation"); }
  mcpActivity("แก้ "+mcpName(c));
  mcpCommit(sch, (ch.includes("position")||ch.includes("rotation"))?{routeWires:sch.wires.filter(w=>w.from.cid===c.id||w.to.cid===c.id)}:{});
  return Object.assign({changed:ch}, mcpCompInfo(sch, c, "full"));
};
/* batch: all-or-nothing unless keep_going */
MCP_OPS.apply = a=>{
  const sch0=mcpUse(a.sheet), before=JSON.stringify({c:sch0.components, w:sch0.wires, pm:sch0.pinmap});
  const results=[]; const allow=new Set(["add_component","connect","disconnect","delete","update_component","set_pins"]);
  MCPB.inBatch=true; MCPB.placedFree=false;
  try{
    (a.steps||[]).forEach((st,i)=>{ const op=st.op; if(!allow.has(op)) mcpFail(`step ${i+1}: '${op}' can't be batched`, "allowed: "+[...allow].join(", "));
      try{ results.push({step:i+1, op, ok:true, result:MCP_OPS[op](Object.assign({sheet:sch0.name}, st))}); }
      catch(e){ if(!a.keep_going){ throw new McpError(`step ${i+1} (${op}) failed: ${e.message}`, e.hint); } results.push({step:i+1, op, ok:false, error:e.message}); } });
  }catch(e){ const b=JSON.parse(before); sch0.components=b.c; sch0.wires=b.w; if(b.pm) sch0.pinmap=b.pm; else delete sch0.pinmap; renderAll(); throw new McpError(e.message+" — nothing was changed", e.hint); }
  finally{ MCPB.inBatch=false; }
  // parts placed without coordinates: let the editor's placer arrange the whole sheet once
  let laidOut=false;
  if(MCPB.placedFree && a.layout!=="keep" && !sch0.locked){ try{ autoRouteSheet(sch0); laidOut=true; }catch(_){} mcpCommit(sch0); try{ zoomFit(); }catch(_){} }
  return {steps:results, auto_layout:laidOut, layout:mcpLayoutMetrics(sch0)};
};

MCP_OPS.build_circuit = a=>{
  mcpBeforeChange("สร้างวงจร");
  let intent=null, title="";
  if(a.truth_table){ const t=a.truth_table; const rows={};
    (t.outputs||[]).forEach(o=>{ const col=t.columns&&t.columns[o]; if(typeof col!=="string") mcpFail(`truth_table.columns.${o} must be a string of 0/1/x, one char per row`);
      if(col.length!==(1<<t.inputs.length)) mcpFail(`truth_table.columns.${o} has ${col.length} chars, expected ${1<<t.inputs.length} (2^inputs, first input = MSB)`);
      rows[o]=col.toLowerCase().split(""); });
    const r=ttToIntent(t.inputs, t.outputs, rows, a.name||"logic"); if(r.error) mcpFail(r.error); intent=r.intent; title="truth table";
    if(a.into==="current" && uxCanFillSheet({inputs:t.inputs, outputs:t.outputs})){ uxFillSheet(activeSch(), intent); return {sheet:activeSch().name, into:"current", equations:r.exprs, layout:mcpLayoutMetrics(activeSch())}; }
    const dr=aiDrawIntent(intent); if(!dr||!dr.ok) mcpFail("could not draw: "+((dr&&(dr.error||(dr.errors||[]).join("; ")))||"?"));
    return {sheet:dr.sch.name, into:"new", equations:r.exprs, layout:mcpLayoutMetrics(dr.sch)};
  }
  if(a.generator){ const g=a.generator, n=+g.n||0;
    if(g.kind==="mod_counter"){ if(n<2||n>64) mcpFail("mod_counter n must be 2..64"); intent=fsmCounterIntent(Array.from({length:n},(_,i)=>i)); intent.module=a.name||("mod"+n); title="mod-"+n; }
    else if(g.kind==="sequence_counter"){ const seq=(g.sequence||[]).map(Number); if(seq.length<2) mcpFail("sequence_counter needs sequence: [≥2 numbers 0..63]"); intent=fsmCounterIntent(seq); if(!intent||intent.error) mcpFail((intent&&intent.error)||"sequence too large"); intent.module=a.name||"seqcount"; title="sequence "+seq.join("→"); }
    else if(g.kind==="ripple_counter"||g.kind==="shift_register"||g.kind==="register"){ const b=seqBuildIntent(({ripple_counter:"counter ",shift_register:"shift register ",register:"register "})[g.kind]+(n||4)+" bit"); intent=b.intent; if(a.name) intent.module=a.name; title=b.title; }
    else if(g.kind==="jk_counter"){ if(n<2||n>64) mcpFail("jk_counter n must be 2..64"); const r=jkCounterIntent(Array.from({length:n},(_,i)=>i), g.output==="q"?{outputs:"q"}:{out:sanId(g.output||"clk_out"), clk:sanId(g.clk||"clk_in")});
      if(r.error) mcpFail(r.error); intent=r; intent.module=a.name||("jkmod"+n); title="JK-FF mod-"+n; }
    else if(g.kind==="bcd_7seg"){ const P=seg7Preset(!!g.active_low); intent=ttToIntent(P.inputs,P.outputs,P.rows,a.name||P.module).intent; title="BCD→7seg"; }
    else mcpFail(`unknown generator '${g.kind}'`, "mod_counter, jk_counter, sequence_counter, ripple_counter, shift_register, register, bcd_7seg");
  }
  if(a.intent){ intent=a.intent; title="intent"; }
  if(!intent) mcpFail("give one of: truth_table, generator, intent");
  const dr=aiDrawIntent(intent);
  if(!dr||!dr.ok) mcpFail("could not draw: "+((dr&&(dr.error||(dr.errors||[]).join("; ")))||"?"), "intent = {module, components:[{id,type,name?}], nets:[{from:'id.pin', to:'id.pin'}]}");
  if(a.generator && a.generator.kind==="jk_counter" && typeof jkLayout==="function"){ jkLayout(dr.sch, intent.bits); snapshot(); renderAll(); }
  mcpActivity("สร้าง "+title);
  return {sheet:dr.sch.name, into:"new", parts:dr.sch.components.filter(c=>c.type!=="JUNCTION").length, layout:mcpLayoutMetrics(dr.sch)};
};

MCP_OPS.auto_layout = a=>{
  const sch=mcpUse(a.sheet); mcpBeforeChange("จัดวาง");
  if(a.mode==="wires_only"){ healLayout(sch, null, true); } else { autoRouteSheet(sch); }
  if(a.lock) sch.locked=true;
  mcpActivity("จัดวางอัตโนมัติ"); mcpCommit(sch); try{ zoomFit(); }catch(_){}
  return {sheet:sch.name, layout:mcpLayoutMetrics(sch)};
};
MCP_OPS.lock_layout = a=>{ const sch=mcpUse(a.sheet); sch.locked=a.locked!==false; mcpCommit(sch); return {sheet:sch.name, locked:sch.locked}; };
MCP_OPS.layout_report = a=>{ const sch=mcpSheet(a.sheet); return Object.assign({sheet:sch.name}, mcpLayoutMetrics(sch)); };

MCP_OPS.check = a=>{
  const sch=a.all_sheets?null:mcpSheet(a.sheet);
  const issues=mcpIssues(sch);
  return {sheet:sch?sch.name:"(all)", errors:issues.filter(i=>i.level==="error").length, warnings:issues.filter(i=>i.level==="warning").length,
    ok:!issues.some(i=>i.level==="error"), issues};
};
MCP_OPS.explain_simulation = a=>{ const sch=mcpSheet(a.sheet);
  return {sheet:sch.name, findings:explainSim(sch).map(f=>({level:f.lvl, title:f.title, why:f.why, fix:f.fix, component:f.cid&&comp(f.cid,sch)?mcpName(comp(f.cid,sch)):undefined}))}; };
MCP_OPS.simulate = a=>{
  const sch=mcpSheet(a.sheet);
  const hasFF=flattenSchematic(sch).sch.components.some(c=>PROBE_SEQ[c.type]);
  if(hasFF){
    const hold={}; Object.entries(a.inputs||{}).forEach(([n,v])=>{ const c=sch.components.find(x=>x.type==="IN"&&String(x.params.name).toLowerCase()===String(n).toLowerCase()); if(!c) mcpFail(`no INPUT '${n}'`); hold[c.id]=+v?1:0; });
    const j=clientSeqSim(sch, Math.max(1,Math.min(256,+a.cycles||16)), {hold});
    if(!j.ok) mcpFail(j.reason||"cannot simulate");
    const sq=j.sequence;
    return {sheet:sch.name, kind:"sequential", note:j.note||undefined, clocks_pulsed:"every INPUT that drives a flip-flop clock", held_inputs:a.inputs||{},
      columns:{inputs:sq.inputs, state:sq.dffs, outputs:sq.outputs},
      rows:sq.rows.map(r=>({cycle:r[0], inputs:r[1].join(""), state:r[2].join(""), outputs:r[3].join("")}))};
  }
  const j=clientCombSim(sch);
  if(!j.ok) mcpFail(j.reason||"cannot simulate");
  const tt=j.truth_table;
  return {sheet:sch.name, kind:"combinational", note:j.note||undefined, inputs:tt.inputs, outputs:tt.outputs, bit_order:"first input is the MSB of the row index",
    rows:tt.rows.map(([i,o])=>i.join("")+" → "+o.join("")),
    columns:Object.fromEntries(tt.outputs.map((o,k)=>[o, tt.rows.map(r=>r[1][k]).join("")]))};
};
MCP_OPS.verify_truth_table = a=>{
  const sim=MCP_OPS.simulate({sheet:a.sheet}); if(sim.kind!=="combinational") mcpFail("verify_truth_table is for combinational sheets — use simulate for sequential ones");
  const exp=a.expected||{}, mism=[];
  Object.entries(exp).forEach(([o,col])=>{ const got=sim.columns[o] ?? sim.columns[Object.keys(sim.columns).find(k=>k.toLowerCase()===o.toLowerCase())];
    if(got==null){ mism.push({output:o, error:"no such output"}); return; }
    String(col).toLowerCase().split("").forEach((ch,r)=>{ if(ch!=="x" && ch!==String(got[r])) mism.push({output:o, row:r, inputs:r.toString(2).padStart(sim.inputs.length,"0"), expected:ch, got:got[r]}); });
  });
  return {sheet:sim.sheet, pass:!mism.length, checked_outputs:Object.keys(exp), mismatches:mism.slice(0,64), inputs:sim.inputs};
};
/* an input value for probe: a bus takes its whole value — 5 (a number), "0101" (a string of
   0/1 is binary), "0b0101", "0x5" or "9"; a 1-bit input is 0/1. (Every value used to be squashed to 0/1,
   so a=0101 on a 4-bit bus probed as a=1.) */
function mcpProbeVal(c, v){
  const w=probeWidth(c,"o"), m=probeMask(w);
  if(w<=1) return (+v || v===true || /^(1|true|high|h)$/i.test(String(v))) ? 1 : 0;
  if(typeof v==="number") return (v>>>0)&m;
  const t=String(v).trim().replace(/_/g,"");
  let n;
  if(/^0b[01]+$/i.test(t)) n=parseInt(t.slice(2),2);
  else if(/^0x[0-9a-f]+$/i.test(t)) n=parseInt(t.slice(2),16);
  else if(/^[01]{2,}$/.test(t)) n=parseInt(t,2);            // "0101" is binary — how the lab writes values
  else if(/^\d+$/.test(t)) n=parseInt(t,10);
  else mcpFail(`value '${v}' for bus INPUT '${c.params.name}' (${w} bits) — use a number (5), binary as wide as the bus ("${"0".repeat(w-1)}1"), "0b…" or "0x…"`);
  return (n>>>0)&m;
}
MCP_OPS.probe = a=>{
  const sch=mcpSheet(a.sheet), fs=flattenSchematic(sch).sch, saved=Object.assign({},PROBE_VALS);
  try{
    Object.keys(PROBE_VALS).forEach(k=>delete PROBE_VALS[k]);
    Object.entries(a.inputs||{}).forEach(([n,v])=>{ const c=sch.components.find(x=>x.type==="IN"&&String(x.params.name).toLowerCase()===String(n).toLowerCase()); if(!c) mcpFail(`no INPUT '${n}'`); PROBE_VALS[c.id]=mcpProbeVal(c, v); });
    const m=probeModel(fs, probeStruct(fs));
    const outs={}; sch.components.filter(c=>c.type==="OUT").forEach(c=>{ const v=m.inVal(c.id,"i"), w=probeWidth(c,"i");
      outs[c.params.name]=v==null?"undriven":(w>1?{value:v, bin:v.toString(2).padStart(w,"0")}:v); });
    const nets=mcpNets(sch).map(n=>{ if(!n.driver) return Object.assign({value:"undriven"},n);
      const [cn,pid]=[n.driver.slice(0,n.driver.lastIndexOf(".")), n.driver.slice(n.driver.lastIndexOf(".")+1)];
      const c=findCompRef(sch,cn); let v=null; try{ v=c?m.outVal(c.id,pid,new Set()):null; }catch(_){}
      return Object.assign({value:v==null?"unknown":v}, n); });
    return {sheet:sch.name, inputs:a.inputs||{}, outputs:outs, nets};
  } finally { Object.keys(PROBE_VALS).forEach(k=>delete PROBE_VALS[k]); Object.assign(PROBE_VALS, saved); }
};

MCP_OPS.board_pins = ()=>({ board:"EDGE Spartan-7 XC7S15 (FTGB196)",
  inputs:PIN_IN_TARGETS.map(t=>({target:t, pin:BOARD_PINS[t], label:pinOptLabel(t)})),
  outputs:PIN_OUT_TARGETS.map(t=>({target:t, pin:BOARD_PINS[t], label:pinOptLabel(t)})),
  notes:"7-seg segments are active-low on this board (common anode); an:N selects digit N (0 = rightmost). clk is the 50 MHz oscillator." });
MCP_OPS.get_pins = a=>{ const sch=mcpSheet(a.sheet); uxNormPinmap(sch);
  const rows=uxPortBits(sch).map(b=>{ const t=uxPinTarget(b,sch); return {port:b.key, dir:b.dir, target:t||null, pin:t?BOARD_PINS[t]:null}; });
  const used={}; rows.forEach(r=>{ if(r.target) (used[r.target]=used[r.target]||[]).push(r.port); });
  return {sheet:sch.name, pins:rows, unassigned:rows.filter(r=>!r.target).map(r=>r.port), conflicts:Object.entries(used).filter(([,v])=>v.length>1).map(([t,v])=>({target:t, ports:v}))}; };
MCP_OPS.set_pins = a=>{
  const sch=mcpUse(a.sheet), bits=uxPortBits(sch), keys=new Map(bits.map(b=>[b.key.toLowerCase(), b]));
  mcpBeforeChange("เลือกขา"); sch.pinmap=sch.pinmap||{}; const done=[];
  Object.entries(a.map||{}).forEach(([port,t])=>{ const b=keys.get(String(port).toLowerCase()); if(!b) mcpFail(`no port bit '${port}'`, "ports: "+bits.map(x=>x.key).join(", "));
    if(t===null||t===""){ delete sch.pinmap[b.key]; done.push(b.key+" → —"); return; }
    const ok=(b.dir==="in"?PIN_IN_TARGETS:PIN_OUT_TARGETS).includes(t); if(!ok) mcpFail(`'${t}' is not a valid ${b.dir==="in"?"input":"output"} target for ${b.key}`, "call board_pins");
    sch.pinmap[b.key]=t; done.push(b.key+" → "+t); });
  mcpActivity("เลือกขา"); if(!MCPB.inBatch) mcpCommit(sch);
  return Object.assign({set:done}, MCP_OPS.get_pins({sheet:sch.name}));
};
MCP_OPS.auto_pins = a=>{ const sch=mcpUse(a.sheet); mcpBeforeChange("จัดขาอัตโนมัติ"); uxAutoPins(sch, a.mode!=="all"); mcpCommit(sch); return MCP_OPS.get_pins({sheet:sch.name}); };
MCP_OPS.get_xdc = a=>{ const sch=mcpUse(a.sheet); const body=uxXdcBody();
  return {sheet:sch.name, missing:UX.xdcMissing||[], xdc:"## EDGE Spartan-7 (XC7S15 FTGB196) — Schematic Studio\n\n"+body}; };
MCP_OPS.get_vhdl = a=>{
  const all=generateAllVhdl(); const names=Object.keys(all);
  const code=e=>typeof e==="string"?e:(e&&e.code)||"";
  if(a.entity){ const k=names.find(n=>n.toLowerCase()===String(a.entity).toLowerCase());
    if(!k){ const s=Object.values(state.project.schematics).find(x=>x.name.toLowerCase()===String(a.entity).toLowerCase()); if(s) return {entity:s.name, note:"not used by the top sheet", vhdl:generateSchVhdl(s)}; mcpFail(`no entity '${a.entity}'`, "entities: "+names.join(", ")); }
    return {entity:k, warnings:(all[k]&&all[k].warns)||[], vhdl:code(all[k])}; }
  return {top:(state.project.schematics[state.project.topId]||{}).name, entities:names, vhdl:bundleAll(all)};
};

async function mcpSaveFile(project, name, text){
  const r=await fetch("/api/files/save?project="+encodeURIComponent(project)+"&name="+encodeURIComponent(name), {method:"POST", body:text});
  const j=await r.json(); if(!j.ok) mcpFail(j.error||"save failed"); return j.path;
}
MCP_OPS.save_project = async a=>{
  state.project.name=sanId($("#projectName").value||state.project.name||"project");
  const p=await mcpSaveFile(state.project.name, state.project.name+".schproj.json", serialize());
  uxMarkSaved(); return {saved:p};
};
MCP_OPS.export_files = async a=>{
  const what=a.what||["vhdl","xdc"], proj=sanId($("#projectName").value||state.project.name||"project"), out={};
  if(what.includes("project")) out.project=(await MCP_OPS.save_project({})).saved;
  if(what.includes("vhdl")){ const v=MCP_OPS.get_vhdl({}); out.vhdl=await mcpSaveFile(proj, proj+".vhd", v.vhdl+layoutStamp()); }
  if(what.includes("xdc")){ const x=MCP_OPS.get_xdc({sheet:a.sheet||(state.project.schematics[state.project.topId]||{}).name}); out.xdc=await mcpSaveFile(proj, proj+".xdc", x.xdc); if(x.missing.length) out.warning="unassigned pins: "+x.missing.join(", "); }
  return out;
};
MCP_OPS.open_project = async a=>{
  const r=await fetch("/api/files/read?path="+encodeURIComponent(a.path)); if(!r.ok) mcpFail(`cannot read '${a.path}' (HTTP ${r.status})`, "list_projects shows the paths");
  UX.expectFileLoad=true; deserialize(await r.text()); return MCP_OPS.status();
};

MCP_OPS.undo = ()=>{ undo(); return {can_undo:state.history.idx>0, active_sheet:(activeSch()||{}).name}; };
MCP_OPS.redo = ()=>{ redo(); return {can_redo:state.history.idx<state.history.stack.length-1}; };
MCP_OPS.checkpoint = async a=>{ await uxTimelineAdd(a.label||"จุดที่ Claude เก็บไว้", true); return {saved:true}; };
MCP_OPS.list_checkpoints = async ()=>({checkpoints:(await tlList()).slice(0,30).map(x=>({id:x.id, time:new Date(x.t).toISOString(), label:x.reason, project:x.name, parts:x.counts.c}))});
MCP_OPS.restore_checkpoint = async a=>{ const rec=await tlGet(+a.id); if(!rec) mcpFail(`no checkpoint ${a.id}`);
  await uxTimelineAdd("ก่อน Claude ย้อนเวลา", true); UX.restoring=true; try{ deserialize(rec.data); } finally { UX.restoring=false; } return MCP_OPS.status(); };

MCP_OPS.focus = a=>{ const sch=mcpUse(a.sheet); const c=mcpComp(sch, a.ref); focusComp(sch.id, c.id); return {focused:mcpName(c)}; };
MCP_OPS.notify_user = a=>{ toast("Claude: "+String(a.message||"").slice(0,300), a.level==="warn"?"warn":"info", 6000); return {shown:true}; };
MCP_OPS.get_events = a=>{ const since=+a.since||0; return {events:MCPB.events.filter(e=>e.seq>since).slice(-100), latest:MCPB.seq}; };

/* screenshot: the sheet as a PNG, colours resolved (CSS variables don't survive rasterising) */
MCP_OPS.screenshot = a=>new Promise((resolve, reject)=>{
  try{
    const sch=mcpUse(a.sheet); if(a.fit!==false) zoomFit(); render();
    const src=$("#canvas"), box=src.getBoundingClientRect();
    const clone=src.cloneNode(true);
    const all=[src, ...src.querySelectorAll("*")], cl=[clone, ...clone.querySelectorAll("*")];
    all.forEach((el,i)=>{ const cs=getComputedStyle(el), d=cl[i];
      ["fill","stroke","stroke-width","stroke-dasharray","opacity","font-size","font-weight","font-family"].forEach(k=>{ const v=cs.getPropertyValue(k); if(v) d.style.setProperty(k, v); }); });
    clone.setAttribute("width", box.width); clone.setAttribute("height", box.height);
    clone.setAttribute("xmlns","http://www.w3.org/2000/svg");
    const bg=getComputedStyle(document.body).getPropertyValue("--sheet-a")||"#fff";
    clone.insertBefore(Object.assign(document.createElementNS("http://www.w3.org/2000/svg","rect"),{}), clone.firstChild);
    const r0=clone.firstChild; r0.setAttribute("width","100%"); r0.setAttribute("height","100%"); r0.setAttribute("fill", bg.trim()||"#fff");
    clone.querySelectorAll(".ux-marks").forEach(n=>{ if(a.show_problems===false) n.remove(); });
    // crop to the drawing (+ margin) instead of the whole canvas
    let cb={x:0,y:0,width:box.width,height:box.height};
    try{ const bb=src.firstChild.getBoundingClientRect(); const pad=28;
      if(bb.width>0 && bb.height>0) cb={x:Math.max(0,bb.left-box.left-pad), y:Math.max(0,bb.top-box.top-pad), width:Math.min(box.width,bb.width+2*pad), height:Math.min(box.height,bb.height+2*pad)}; }catch(_){}
    const url="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(new XMLSerializer().serializeToString(clone));
    const img=new Image(); img.onload=()=>{ const k=Math.min(2, 1600/cb.width, 1600/cb.height); const cv=document.createElement("canvas");
      cv.width=Math.round(cb.width*k); cv.height=Math.round(cb.height*k); const g=cv.getContext("2d"); g.scale(k,k);
      g.fillStyle=(bg.trim()||"#fff"); g.fillRect(0,0,cb.width,cb.height); g.drawImage(img,-cb.x,-cb.y);
      resolve({sheet:sch.name, width:cv.width, height:cv.height, image_png_base64:cv.toDataURL("image/png").split(",")[1]}); };
    img.onerror=()=>reject(new McpError("could not render the sheet image")); img.src=url;
  }catch(e){ reject(e); }
});

/* ---------- event log: what the user did (so Claude can follow along) ---------- */
function mcpEvent(kind, data){ MCPB.events.push(Object.assign({seq:++MCPB.seq, time:new Date().toISOString(), kind}, data)); if(MCPB.events.length>300) MCPB.events.splice(0, MCPB.events.length-300); }
{
  const _snap=snapshot;
  snapshot=function(){ const r=_snap.apply(this, arguments);
    if(!MCPB.byClaude && !MCPB.busy){ const s=activeSch(); if(s) mcpEvent("user_edit", {sheet:s.name, parts:s.components.filter(c=>c.type!=="JUNCTION").length, wires:s.wires.length}); }
    return r; };
  const _step=uxRenderStepper;
  let lastErr=-1;
  uxRenderStepper=function(){ const r=_step.apply(this, arguments);
    if(UX.step && UX.step.errs.length!==lastErr){ lastErr=UX.step.errs.length; mcpEvent("issues_changed", {sheet:UX.step.sch.name, errors:UX.step.errs.length, warnings:UX.step.warns.length}); }
    return r; };
}

/* ---------- projects ---------- */
MCP_OPS.new_project = a=>{
  const name=String(a.name||"").trim(); if(!name) mcpFail("name is required");
  mcpBeforeChange("โปรเจกต์ใหม่");
  const p=addProject(name); state.view={x:0,y:0,k:1};
  const pn=$("#projectName"); if(pn) pn.value=p.name;
  mcpCommit(null); try{ zoomFit(); }catch(_){}
  mcpActivity("โปรเจกต์ใหม่ "+p.name);
  return Object.assign({created:p.name, renamed: p.name!==sanId(name) ? "a project with that name exists — used "+p.name : undefined}, MCP_OPS.status());
};

/* ---------- the real board: the ลงบอร์ด page's own build / program, driven by Claude ----------
   A Vivado build takes minutes, longer than an MCP client waits for one call, so board_build /
   board_program start the job and board_status follows it (≤40 s per call). The page opens so
   the user watches the same log. Writing the Flash (permanent) stays a click of the user's. */
async function mcpBoardPage(){ try{ if(!$("#boardPage.show")) await openBoardPage(); }catch(_){} }
/* which sheet goes on the board: `sheet` if given (a sub-circuit can be tested on its own),
   else the one the board page already has, else top */
function mcpBoardSheet(a){ if(a && a.sheet){ BRD.sheetId=mcpUse(a.sheet).id; } else if(!BRD.sheetId) BRD.sheetId=state.project.topId; }   // mcpUse opens it, so the page picks the same one
MCP_OPS.board_build = async (a)=>{
  if(typeof brdDesign!=="function" || !/^https?:/.test(location.protocol)) mcpFail("building needs the FPGA Ecosystem app (the editor was opened from disk)");
  mcpBoardSheet(a);
  const d=brdDesign(); if(!d) mcpFail("no top sheet");
  if(d.missing.length) mcpFail(`${d.missing.length} port(s) have no board pin: ${d.missing.slice(0,8).join(", ")}`, "get_pins, then set_pins or auto_pins");
  await mcpBoardPage();
  const r=await brdPost("/api/board/build",{project:brdProject(), top:d.top, vhdl:d.vhdl, xdc:d.xdc});
  if(!r||!r.ok) mcpFail((r&&r.error)||"could not start the build");
  try{ brdLog(true); brdPoll(false); }catch(_){}
  mcpActivity("สร้าง .bit");
  return {started:"build", top:d.top, folder:r.dir, next:"call board_status until state is not 'running' (Vivado takes ~1-3 min)"};
};
MCP_OPS.board_program = async a=>{
  if(typeof brdDesign!=="function" || !/^https?:/.test(location.protocol)) mcpFail("programming needs the FPGA Ecosystem app");
  const mode=a.mode||"sram", cable=a.cable||"ft2232";
  mcpBoardSheet(a);
  await mcpBoardPage();
  let r;
  if(mode==="detect") r=await brdPost("/api/board/detect",{cable});
  else { const d=brdDesign(); r=await brdPost("/api/board/program",{project:brdProject(), top:d.top, mode:"sram", cable}); }
  if(!r||!r.ok) mcpFail((r&&r.error)||"could not start", "board_status shows the log; about → board shows what is installed");
  try{ brdLog(true); brdPoll(false); }catch(_){}
  mcpActivity(mode==="detect"?"ตรวจหาบอร์ด":"โหลดลงบอร์ด");
  return {started:mode, next:"call board_status"};
};
MCP_OPS.board_status = async a=>{
  const until=Date.now()+1000*Math.max(1, Math.min(40, +a.wait||40));
  let s;
  for(;;){ s=await (await fetch("/api/board/status")).json(); if(s.state!=="running" || Date.now()>until) break;
    await new Promise(r=>setTimeout(r, 700)); }
  const out={job:s.kind, state:s.state, seconds:s.elapsed, log_tail:(s.lines||[]).slice(-25).join("\n")};
  if(s.hint) out.explain=s.hint;
  if(s.result&&Object.keys(s.result).length) out.result=s.result;
  if(s.state==="running") out.next="still running — call board_status again";
  try{ const d=brdDesign(); const b=await brdPost("/api/board/bit",{project:brdProject(), top:d.top, vhdl:d.vhdl, xdc:d.xdc});
    if(b&&b.ok) out.bit=b.exists?{path:b.path, matches_circuit:b.current}:null; }catch(_){}
  return out;
};

/* ---------- the lab workflow: schematic → simulate → the USER approves → Top-Down ----------
   Claude shows its summary in a card in the editor and the user answers there (อนุมัติ / ขอแก้).
   The approval is tied to the circuit as it was when approved (a fingerprint of every sheet's
   parts, params and wiring — not positions): make_topdown refuses anything else, so a design
   changed after approval has to be approved again. request_approval returns at once and
   approval_status waits ≤40 s per call, because MCP clients give up on a single long call. */
MCPB.approval={state:"none"};
function mcpDesignHash(){
  const P=state.project, out=[P.topId||""];
  Object.keys(P.schematics).sort().forEach(id=>{ const s=P.schematics[id];
    out.push(id+":"+s.name);
    s.components.filter(c=>c.type!=="JUNCTION").map(c=>c.id+"|"+c.type+"|"+(c.label||"")+"|"+JSON.stringify(c.params||{})).sort().forEach(x=>out.push(x));
    // wiring as connectivity: junctions collapse into nets, so re-routing does not count as a change
    try{ const seen=new Set(); s.wires.forEach(w=>{ if(seen.has(w.id)) return; const ids=[...netWires(s,w)]; ids.forEach(i=>seen.add(i));
      const ends=new Set(); ids.forEach(i=>{ const x=s.wires.find(q=>q.id===i); if(!x) return;
        [x.from,x.to].forEach(e=>{ const c=comp(e.cid,s); if(c&&c.type!=="JUNCTION") ends.add(e.cid+"."+e.pid); }); });
      out.push("net:"+[...ends].sort().join(",")); }); }catch(_){ s.wires.forEach(w=>out.push(w.from.cid+"."+w.from.pid+">"+w.to.cid+"."+w.to.pid)); }
  });
  const str=out.join("\n"); let h=2166136261>>>0;
  for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619)>>>0; }
  return h.toString(16)+"-"+str.length;
}
function mcpApprovalCard(summary){
  let el=$("#mcpApproval"); if(el) el.remove();
  el=document.createElement("div"); el.id="mcpApproval"; el.className="mcp-approval";
  el.innerHTML=`<div class="mcp-ap-h"><span class="dot"></span>Claude ขออนุมัติวงจร <span class="muted">${esc(state.project.name||"")}</span></div>
    <div class="mcp-ap-body">${esc(summary).replace(/\n/g,"<br>")}</div>
    <div class="muted" style="font-size:12px">ดูวงจรและผลจำลองในหน้าจอก่อน — อนุมัติแล้ว Claude จะทำ Top-Down จากวงจรนี้</div>
    <textarea id="mcpApNote" rows="2" placeholder="ถ้าจะให้แก้ บอกตรงนี้ว่าแก้อะไร"></textarea>
    <div class="mcp-ap-row"><button class="btn" data-ap="changes">✎ ขอแก้</button><span class="grow"></span>
      <button class="btn btn-primary" data-ap="approve">✓ อนุมัติ — ทำ Top-Down ต่อ</button></div>`;
  document.body.appendChild(el);
  el.addEventListener("click", e=>{ const b=e.target.closest("[data-ap]"); if(!b) return;
    const note=($("#mcpApNote")||{}).value||"";
    if(b.dataset.ap==="changes" && !note.trim()){ $("#mcpApNote").focus(); toast("พิมพ์สิ่งที่อยากให้แก้ก่อน แล้วกด ขอแก้ อีกครั้ง","warn"); return; }
    MCPB.approval = b.dataset.ap==="approve"
      ? {state:"approved", hash:mcpDesignHash(), comment:note.trim(), at:Date.now()}
      : {state:"changes", comment:note.trim(), at:Date.now()};
    el.remove(); mcpEvent("approval", {state:MCPB.approval.state, comment:MCPB.approval.comment||""});
    toast(MCPB.approval.state==="approved"?"อนุมัติแล้ว — Claude จะทำ Top-Down ต่อ":"ส่งให้ Claude แก้แล้ว","ok",3000);
  });
}
MCP_OPS.request_approval = a=>{
  const summary=String(a.summary||"").trim(); if(!summary) mcpFail("summary is required: what you built and what the simulation showed");
  MCPB.approval={state:"waiting", asked:Date.now()};
  mcpApprovalCard(summary); mcpActivity("รออนุมัติ");
  return {status:"waiting", next:"call approval_status (it waits for the user's click) until it is no longer 'waiting'"};
};
MCP_OPS.approval_status = async a=>{
  const until=Date.now()+1000*Math.max(1, Math.min(40, +a.wait||40));
  while(MCPB.approval.state==="waiting" && Date.now()<until) await new Promise(r=>setTimeout(r, 300));
  const ap=MCPB.approval, out={status:ap.state};
  if(ap.comment) out.comment=ap.comment;
  if(ap.state==="approved") out.design_unchanged = ap.hash===mcpDesignHash();
  if(ap.state==="waiting") out.next="still waiting for the user — call approval_status again";
  if(ap.state==="changes") out.next="make the changes the user asked for, simulate again, then request_approval again";
  if(ap.state==="none") out.next="nothing asked yet — call request_approval with a summary first";
  return out;
};
/* the approved design → Top-Down: the top sheet, then every sheet it uses as a block, as layers */
MCP_OPS.make_topdown = a=>{
  const ap=MCPB.approval;
  if(ap.state!=="approved") mcpFail("the user has not approved the design yet", "simulate/verify, then request_approval and wait for approval_status 'approved'");
  if(ap.hash!==mcpDesignHash()) mcpFail("the circuit changed after the user approved it", "request_approval again for the changed circuit");
  const P=state.project, top=a.sheet ? mcpSheet(a.sheet) : (P.schematics[P.topId]||activeSch());
  const order=[], seen=new Set();
  const walk=(s,d)=>{ if(!s||seen.has(s.id)) return; seen.add(s.id); order.push({s,d});
    s.components.forEach(c=>{ const sub=subSchOf(c); if(sub) walk(sub,d+1); }); };
  walk(top,0);
  const ord=n=>n+(n%10===1&&n%100!==11?"st":n%10===2&&n%100!==12?"nd":n%10===3&&n%100!==13?"rd":"th");
  const sheets=order.map(({s,d})=>{ const t=schematicToTopdownSheet(s); t.title=ord(d+1)+" Layer ("+s.name+")"; t.module=s.name; return t; });
  sendToTopdown({type:"td:loadSheets", sheets});
  mcpActivity("ทำ Top-Down");
  return {sheets:sheets.map(t=>t.title), note:"shown in the Top-Down view (Tools ▸ Top-Down); the user can print / export from there"};
};

/* ---------- you see what Claude does, as it does it ----------
   Every call already redraws the page; what hid it was WHERE: parts landed off-screen, or on
   the canvas under the sim / board / Top-Down page. So around each call: note the sheet, and
   afterwards bring the canvas forward, bring the change into view (only when it is not in view
   already, so the drawing does not jump on every call) and make the changed parts glow. */
function mcpSheetState(){
  const sch=activeSch(); if(!sch) return null;
  const m=new Map(); sch.components.forEach(c=>{ if(c.type!=="JUNCTION") m.set(c.id, c.x+","+c.y+","+c.type+","+(c.rot||0)+","+JSON.stringify(c.params||{})); });
  return {id:sch.id, m, c:new Set(sch.components.map(c=>c.id)), w:new Set(sch.wires.map(w=>w.id)),
          sheets:new Set(Object.keys(state.project.schematics||{}))};
}
/* "ค่อยๆโผล่มา": a call that adds many things at once (apply, build_circuit, a generator) is
   committed in one go, but drawn in: parts appear one by one left to right, then the wires,
   each dot with its first wire. Purely visual — the sheet is already complete, so the next
   call (or a save) never waits on it; a new call shows whatever is still hidden at once. */
function mcpRevealFlush(){
  const R=MCPB.reveal; if(!R) return;
  clearTimeout(R.t); MCPB.reveal=null;
  document.querySelectorAll(".mcp-hide").forEach(e=>e.classList.remove("mcp-hide"));
}
function mcpRevealApply(){
  const R=MCPB.reveal; if(!R) return;
  R.hidden.forEach(id=>{ const el=document.querySelector('.node[data-cid="'+id+'"],.wire-group[data-wid="'+id+'"]'); if(el) el.classList.add("mcp-hide"); });
}
function mcpReveal(sch, pre){
  mcpRevealFlush();
  if(!pre || !pre.c) return;
  if(pre.id!==sch.id){
    if(pre.sheets.has(sch.id)) return;                        // just switched to a sheet that was there
    pre={id:sch.id, c:new Set(), w:new Set()};                // a brand-new sheet: all of it draws in
  }
  const parts=sch.components.filter(c=>c.type!=="JUNCTION" && !pre.c.has(c.id)).sort((a,b)=>(a.x-b.x)||(a.y-b.y));
  const dots=new Set(sch.components.filter(c=>c.type==="JUNCTION" && !pre.c.has(c.id)).map(c=>c.id));
  const minX=w=>{ const a=comp(w.from.cid,sch), b=comp(w.to.cid,sch); return Math.min(a?a.x:0, b?b.x:0); };
  const wires=sch.wires.filter(w=>!pre.w.has(w.id)).sort((a,b)=>minX(a)-minX(b));
  if(parts.length+wires.length<4) return;                     // one or two things: the glow says enough
  const steps=[]; parts.forEach(c=>steps.push([c.id]));
  wires.forEach(w=>{ const st=[w.id]; [w.from.cid,w.to.cid].forEach(id=>{ if(dots.has(id)){ st.push(id); dots.delete(id); } }); steps.push(st); });
  if(dots.size) steps.push([...dots]);
  const dt=Math.max(35, Math.min(160, 2600/steps.length));    // the whole drawing-in stays under ~3 s
  const R=MCPB.reveal={hidden:new Set(steps.flat()), t:null};
  mcpRevealApply();
  let i=0;
  const tick=()=>{ if(MCPB.reveal!==R) return;
    steps[i++].forEach(id=>{ R.hidden.delete(id); const el=document.querySelector('.node[data-cid="'+id+'"],.wire-group[data-wid="'+id+'"]'); if(el) el.classList.remove("mcp-hide"); });
    if(i<steps.length) R.t=setTimeout(tick, dt); else MCPB.reveal=null; };
  R.t=setTimeout(tick, 60);
}
function mcpShowChange(pre){
  const sch=activeSch(); if(!sch) return;
  const changed=new Set();
  sch.components.forEach(c=>{ if(c.type==="JUNCTION") return;
    const k=c.x+","+c.y+","+c.type+","+(c.rot||0)+","+JSON.stringify(c.params||{});
    if(!pre || pre.id!==sch.id || pre.m.get(c.id)!==k) changed.add(c.id); });
  sch.wires.forEach(w=>{ if(!pre || pre.id!==sch.id || !pre.w.has(w.id)){ changed.add(w.from.cid); changed.add(w.to.cid); } });
  const newSheet = !pre || pre.id!==sch.id;
  if(!changed.size && !newSheet) return;                  // a read-only call: leave the view alone
  // the canvas has to be the thing on screen
  try{ if($("#simPage.show")) hideSimPage(); }catch(_){}
  try{ if($("#boardPage.show")) brdShow(false); }catch(_){}
  try{ const tv=$("#topdownView"); if(tv && tv.style.display!=="none" && tv.style.display!=="") closeTopdown(); }catch(_){}
  // in view? (world rectangle of the canvas vs the changed parts)
  const cs=sch.components.filter(c=>changed.has(c.id));
  if(cs.length){
    const r=canvas.getBoundingClientRect();
    const outOf=()=>{ const v=state.view, vx1=-v.x/v.k, vy1=-v.y/v.k, vx2=(r.width-v.x)/v.k, vy2=(r.height-v.y)/v.k;
      return cs.some(c=>{ const z=getSize(c); return c.x<vx1+10||c.y<vy1+10||c.x+z.w>vx2-10||c.y+z.h>vy2-10; }); };
    if(outOf()||newSheet){ try{ zoomFit(); }catch(_){} }
    // a sheet too big to fit at the smallest zoom: centre the view on what changed instead
    if(outOf() && r.width>0){
      const x1=Math.min(...cs.map(c=>c.x)), y1=Math.min(...cs.map(c=>c.y)),
            x2=Math.max(...cs.map(c=>c.x+getSize(c).w)), y2=Math.max(...cs.map(c=>c.y+getSize(c).h));
      const v=state.view; v.x=r.width/2-(x1+x2)/2*v.k; v.y=r.height/2-(y1+y2)/2*v.k; render();
    }
  }
  mcpReveal(sch, pre);
  // glow on what changed, for a moment
  // (kept in MCPB.flash so a re-render inside that moment — which rebuilds every node — keeps it)
  MCPB.flash={ids:new Set(cs.map(c=>c.id)), until:Date.now()+1800};
  requestAnimationFrame(()=>{ cs.forEach(c=>{ const el=document.querySelector('.node[data-cid="'+c.id+'"]'); if(el){ el.classList.remove("mcp-flash"); void el.getBoundingClientRect(); el.classList.add("mcp-flash"); } });
    clearTimeout(mcpShowChange._t); mcpShowChange._t=setTimeout(()=>{ MCPB.flash=null; document.querySelectorAll(".mcp-flash").forEach(e=>e.classList.remove("mcp-flash")); }, 1800); });
}
{
  const _render=render;
  render=function(){ const r=_render.apply(this, arguments);
    const f=MCPB.flash; if(f && Date.now()<f.until) f.ids.forEach(id=>{ const el=document.querySelector('.node[data-cid="'+id+'"]'); if(el) el.classList.add("mcp-flash"); });
    mcpRevealApply();
    return r; };
}

/* ---------- transport: long-poll the launcher ---------- */
async function mcpLoop(){
  let fails=0;
  while(MCPB.on){
    let job=null;
    try{
      const r=await fetch("/api/mcp/poll?client="+MCPB.client, {cache:"no-store"});
      if(r.status===204){ fails=0; continue; }
      if(!r.ok) throw new Error("HTTP "+r.status);
      job=await r.json(); fails=0;
    }catch(_){ fails++; mcpSetChip(false); await new Promise(res=>setTimeout(res, Math.min(10000, 1000*fails))); continue; }
    mcpSetChip(true);
    if(!job||!job.id) continue;
    let reply;
    MCPB.busy=true; MCPB.calls++;
    mcpRevealFlush();
    const pre=mcpSheetState();
    try{
      const fn=MCP_OPS[job.op]; if(!fn) throw new McpError(`unknown operation '${job.op}'`);
      const result=await fn(job.args||{});
      reply={id:job.id, ok:true, result};
      try{ mcpShowChange(pre); }catch(e){ console.warn("mcp view", e); }
      try{ uxRefreshPages(); }catch(_){}               // a pin / board page on screen shows the new state
    }catch(e){
      reply={id:job.id, ok:false, error:String(e&&e.message||e), hint:e&&e.hint||undefined};
      if(!(e instanceof McpError)) console.warn("mcp op failed", job.op, e);
    }finally{ MCPB.busy=false; }
    try{ await fetch("/api/mcp/result", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(reply)}); }catch(_){}
  }
}
function mcpSetChip(up){ const el=$("#mcpChip"); if(!el) return; el.hidden=false; el.classList.toggle("up", !!up);
  el.title = up ? "เชื่อมกับ Claude แล้ว — Claude อ่าน/แก้แผ่นนี้ได้ (ทุกการแก้กด Ctrl+Z ย้อนได้)" : "รอการเชื่อมต่อจาก Claude…"; }
(function mcpStart(){
  if(!/^https?:$/.test(location.protocol) || window!==window.top) return;   // only a page served by the launcher
  fetch("/api/info",{cache:"no-store"}).then(r=>r.json()).then(j=>{
    if(j.app!=="fpga-ecosystem") return;
    const chip=document.createElement("span"); chip.id="mcpChip"; chip.className="mcp-chip"; chip.hidden=true; chip.innerHTML='<span class="dot"></span>Claude';
    const save=$("#saveChip"); if(save) save.parentNode.insertBefore(chip, save);
    MCPB.on=true; mcpLoop();
  }).catch(()=>{});
})();
