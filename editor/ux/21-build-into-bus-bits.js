/* ===== 21. build_circuit into a named sheet; connect to ONE bit of a bus pin =====================
   From a test of the local agent: asked for "a full adder on sheet fa", it made an empty sheet
   fa, then build_circuit drew the circuit on a new sheet full_adder — and it checked the empty fa,
   so a wrong carry went unnoticed. build_circuit now takes `sheet`: a new name becomes that
   sheet, an existing EMPTY sheet is filled (a sheet with parts is refused, not overwritten).
   And a 4-bit MUX input or a bus OUTPUT could only be wired as a whole; a pin reference may now
   carry a bit index — "y.i[2]", "m.d0[1]", "s.o[3]" — and the bus tap it needs is placed for you
   (a merge tap onto the bus a sink pin reads, a split tap off the bus a source pin drives). */
{
  const _build=MCP_OPS.build_circuit;
  MCP_OPS.build_circuit=async a=>{
    if(!a.sheet) return _build(a);
    const P=state.project.schematics, want=String(a.sheet).trim();
    const tgt=Object.values(P).find(s=>String(s.name).toLowerCase()===want.toLowerCase());
    if(tgt && tgt.components.some(c=>c.type!=="JUNCTION"))
      mcpFail(`sheet '${tgt.name}' already has parts`, "build_circuit draws a whole new circuit: give a new sheet name, or change that sheet with add_component / connect / apply");
    const before=new Set(Object.keys(P));
    const r=await _build(Object.assign({}, a, {sheet:undefined, into:"new"}));
    const nid=Object.keys(P).find(id=>!before.has(id));
    if(!nid) return r;
    const ns=P[nid];
    let dest=ns;
    if(tgt){                                   // fill the empty sheet the user named, drop the new one
      tgt.components=ns.components; tgt.wires=ns.wires;
      ["portOrder","locked"].forEach(k=>{ if(ns[k]!=null) tgt[k]=ns[k]; });
      delete P[nid];
      state.openTabs=(state.openTabs||[]).filter(id=>id!==nid);
      dest=tgt;
    } else ns.name=uniqueSchName(want, ns.id);
    openSchTab(dest.id); mcpCommit(dest); try{ zoomFit(); }catch(_){}
    return Object.assign({}, r, {sheet:dest.name, into:tgt?"filled":"new"});
  };
}

/* "comp.pin[3]" → {base:"comp.pin", bit:3} */
function mcpBitRef(ref){ const m=/^(.*)\[(\d+)\]$/.exec(String(ref||"").trim()); return m ? {base:m[1], bit:+m[2]} : null; }
function mcpBusPin(sch, base, dir){
  let c=findCompRef(sch, base), p=null;
  if(c){ const ps=getPorts(c).filter(x=>x.dir===dir); if(ps.length!==1) mcpFail(`${mcpName(c)} has several ${dir==="in"?"inputs":"outputs"} — name the pin`, "pins: "+ps.map(x=>mcpName(c)+"."+x.id).join(", ")); p=ps[0]; }
  else ({c, p}=mcpPin(sch, base, "any"));
  if(p.dir!==dir) mcpFail(`${mcpName(c)}.${p.id} is an ${p.dir==="in"?"input":"output"}`);
  if((p.width||1)<2) mcpFail(`${mcpName(c)}.${p.id} is 1 bit — drop the [index]`);
  return {c, p, w:p.width};
}
function mcpAddTap(sch, x, y, bit, mode){
  const t={id:uid("c"), type:"BUSTAP", label:"", x:snap(x), y:snap(y), params:{bit, nbit:1, mode, dir:mode==="merge"?"left":"right"}};
  sch.components.push(t); return t;
}
{
  const _connect=MCP_OPS.connect;
  MCP_OPS.connect=a=>{
    const pairs=a.connections || [[a.from, a.to]];
    if(!pairs.some(([f,t])=>mcpBitRef(f)||mcpBitRef(t))) return _connect(a);
    const sch=mcpUse(a.sheet); mcpBeforeChange("ต่อสายบิตในบัส");
    const made=[], mine=[];
    const W=(fc,fp,tc,tp)=>{ const w={id:uid("w"), from:{cid:fc,pid:fp}, to:{cid:tc,pid:tp}, name:""}; sch.wires.push(w); mine.push(w); return w; };
    const plain=pairs.map(([f,t])=>{
      let src=f, dst=t;
      const fb=mcpBitRef(f), tb=mcpBitRef(t);
      if(fb){                                  // one bit OFF a bus: a split tap on the source's net
        const {c,p,w}=mcpBusPin(sch, fb.base, "out");
        if(fb.bit>=w) mcpFail(`${fb.base} has bits 0..${w-1}`);
        const at=portPos(c, p.id);
        const tap=mcpAddTap(sch, at.x+GRID*4, at.y-11+GRID*2*(fb.bit+1), fb.bit, "split");
        W(c.id, p.id, tap.id, "d"); src=tap.id+".y"; made.push(`${f} (tap)`);
      }
      if(tb){                                  // one bit INTO a bus: a merge tap on the bus the pin reads
        const {c,p,w}=mcpBusPin(sch, tb.base, "in");
        if(tb.bit>=w) mcpFail(`${tb.base} has bits 0..${w-1}`);
        const on=sch.wires.find(x=>x.to.cid===c.id && x.to.pid===p.id);
        let J=null;
        if(on){
          const d=mcpDriver(sch, on);
          if(d){ const dc=comp(d.cid,sch); mcpFail(`${mcpName(c)}.${p.id} is driven as a whole bus by ${dc?mcpName(dc):d.cid}.${d.pid}`, "disconnect it first to wire it bit by bit"); }
          const jc=comp(on.from.cid, sch); if(jc && jc.type==="JUNCTION") J=jc;
          // the bit must not be written twice
          const taken=[...netWires(sch,on)].map(id=>sch.wires.find(x=>x.id===id)).filter(Boolean)
            .map(x=>comp(x.to.cid,sch)).find(x=>x && x.type==="BUSTAP" && (x.params||{}).mode==="merge" && (x.params.bit??0)===tb.bit);
          if(taken) mcpFail(`bit ${tb.bit} of ${mcpName(c)}.${p.id} is already wired`);
        }
        const at=portPos(c, p.id);
        if(!J){
          if(on) sch.wires=sch.wires.filter(x=>x!==on);
          J={id:uid("c"), type:"JUNCTION", label:"", x:snap(at.x-GRID*4)-6, y:snap(at.y)-6, params:{}};
          sch.components.push(J); W(J.id, "j", c.id, p.id);
        }
        const tap=mcpAddTap(sch, at.x-GRID*8, at.y-11-GRID*2*(tb.bit+1), tb.bit, "merge");
        W(J.id, "j", tap.id, "d"); dst=tap.id+".y"; made.push(`${t} (tap)`);
      }
      return [src, dst];
    });
    const r=_connect(Object.assign({}, a, {sheet:sch.name, connections:plain, from:undefined, to:undefined}));
    if(!sch.locked && mine.length){ try{ healLayout(sch, scopeOf(sch,{wires:mine})); }catch(_){} mcpCommit(sch); }
    return Object.assign(r, {bus_bits:made});
  };
}
