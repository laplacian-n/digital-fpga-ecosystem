/* ===== 39. Design rule checks the netlist needed ===================================================
   `check` caught floating inputs and combinational loops, but not: a net two outputs drive (drawn by
   hand through a junction — MCP connect refuses it, the canvas does not), an input pin fed from two
   nets, logic whose output goes nowhere (a gate the student forgot to wire on — its part of the
   circuit does nothing), an INPUT nothing reads, and a wire with no source. They join the same issue
   list, so check, the stepper badge and the Debug list all show them. */
const DRC_SRC=new Set(["IN","VCC","GND","CONST"]), DRC_SKIP=new Set(["JUNCTION","BUSTAP","OUT","TEXT","NOTE","LABEL"]);
function drcSheet(sch){
  const I=[], name=c=>compDisplay?compDisplay(c):(c.label||c.id), add=(lvl,msg,cid)=>I.push({lvl, msg, cid, schId:sch.id, ref:sch.name});
  const outUsed=new Set(sch.wires.map(w=>w.from.cid+"|"+w.from.pid));
  // several drivers on one net (through junctions)
  try{ const seen=new Set();
    sch.wires.forEach(w=>{ if(seen.has(w.id)) return; const ids=[...netWires(sch, w)]; ids.forEach(id=>seen.add(id));
      const drv=new Map();
      ids.map(id=>sch.wires.find(x=>x.id===id)).filter(Boolean).forEach(x=>[x.from,x.to].forEach(ep=>{ const c=comp(ep.cid,sch);
        if(!c||c.type==="JUNCTION"||c.type==="BUSTAP") return; const p=getPorts(c).find(q=>q.id===ep.pid); if(p&&p.dir==="out") drv.set(ep.cid+"|"+ep.pid, c); }));
      if(drv.size>1){ const L=[...drv.entries()].map(([k,c])=>name(c)+"."+k.split("|")[1]);
        add("err", `สายเส้นเดียวมีต้นทาง ${drv.size} ตัว (multi-driver): ${L.join(", ")} — สัญญาณชนกัน`, [...drv.values()][0].id); } });
  }catch(e){ console.warn("drc nets", e); }
  // one input pin fed from two nets
  const into={}; sch.wires.forEach(w=>{ const k=w.to.cid+"|"+w.to.pid; (into[k]=into[k]||new Set()).add(netKey(sch, w)); });
  Object.entries(into).forEach(([k,S])=>{ if(S.size<2) return; const [cid,pid]=k.split("|"), c=comp(cid,sch);
    if(!c || c.type==="JUNCTION" || c.type==="BUSTAP") return;
    add("err", `${name(c)} ขา '${pid}' รับสายจาก ${S.size} เส้นที่ต่างกัน (multi-driver)`, cid); });
  // a net something reads but nothing drives — e.g. an OUTPUT fed by bus taps whose bit side is open
  // (lab 7: "an" looked wired and check said 0/0, yet the VHDL had no driver for it)
  try{
    const netOf=new Map();                      // "cid|pid" → net key
    sch.wires.forEach(w=>{ const k=netKey(sch, w); [w.from, w.to].forEach(ep=>netOf.set(ep.cid+"|"+ep.pid, k)); });
    const ends=new Map();                       // net key → [{c, p}]
    sch.wires.forEach(w=>{ const k=netKey(sch, w); [w.from, w.to].forEach(ep=>{ const c=comp(ep.cid,sch); if(!c||c.type==="JUNCTION") return;
      const p=getPorts(c).find(q=>q.id===ep.pid); if(!p) return; const L=ends.get(k)||[]; if(!L.some(e=>e.c===c&&e.p.id===p.id)) L.push({c,p}); ends.set(k,L); }); });
    const memo=new Map();
    const driven=(k, seen)=>{ if(memo.has(k)) return memo.get(k); if(seen.has(k)) return false; seen.add(k);
      const ok=(ends.get(k)||[]).some(({c,p})=>{
        if(c.type==="BUSTAP"){                    // a tap passes on what reaches its other side: split d → y, merge y → d
          const merge=(c.params||{}).mode==="merge", outPin=merge?"d":"y", inPin=merge?"y":"d";
          if(p.id!==outPin) return false;
          const k2=netOf.get(c.id+"|"+inPin); return k2!=null && driven(k2, seen); }
        return p.dir==="out"; });
      memo.set(k, ok); return ok; };
    ends.forEach((L, k)=>{ if(driven(k, new Set())) return;
      L.filter(({c,p})=>p.dir==="in" && c.type!=="BUSTAP").forEach(({c,p})=>
        add("err", c.type==="OUT" ? `${name(c)} ต่อสายแล้ว แต่สายนั้นไม่มีอะไรขับ (ไม่มีต้นทาง) — ค่าจะเป็น 0 ตลอด`
                                  : `${name(c)} ขา '${p.id}' ต่อสายแล้ว แต่สายนั้นไม่มีอะไรขับ (ไม่มีต้นทาง)`, c.id)); });
  }catch(e){ console.warn("drc undriven", e); }
  // a pin kept for a port that is no longer on the sheet: it holds a board pin another port may need
  try{ const live=new Set(uxPortBits(sch).map(b=>b.key.toLowerCase()));
    const stale=Object.keys(sch.pinmap||{}).filter(k=>!live.has(k.toLowerCase()));
    if(stale.length) add("warn", `ขาบอร์ดของพอร์ตที่ไม่มีแล้ว: ${stale.map(k=>k+" → "+sch.pinmap[k]).join(", ")} — ลบด้วย set_pins {map:{"${stale[0]}": null}} หรือหน้า ลงบอร์ด`, null);
  }catch(_){}
  // logic that goes nowhere, INPUTs nothing reads
  sch.components.forEach(c=>{
    if(DRC_SKIP.has(c.type)) return;
    const outs=getPorts(c).filter(p=>p.dir==="out"); if(!outs.length) return;
    const used=outs.filter(p=>outUsed.has(c.id+"|"+p.id));
    if(c.type==="IN"){ if(!used.length) add("warn", `INPUT ${name(c)} ไม่ได้ต่อไปไหน (ไม่มีอะไรใช้ค่านี้)`, c.id); return; }
    if(DRC_SRC.has(c.type)) return;
    if(!used.length) add("warn", `เอาต์พุตของ ${name(c)} ไม่ได้ต่อไปไหน — ส่วนนี้ของวงจรไม่มีผลกับขาออก`, c.id);
  });
  return I;
}
/* the net a wire belongs to, as a stable key (its lowest wire id) */
function netKey(sch, w){ try{ return [...netWires(sch, w)].sort()[0]; }catch(_){ return w.id; } }
{
  const _q=uxQuietIssues;
  uxQuietIssues=function(){
    const base=_q.apply(this, arguments)||[];
    const extra=[]; Object.values(state.project.schematics).forEach(s=>{ try{ extra.push(...drcSheet(s)); }catch(_){} });
    // what the editor already says stays as it is: no second message for the same pin / part
    const dup=i=>base.some(b=>b.schId===i.schId && b.cid && b.cid===i.cid && (/ไม่มีต้นทาง/.test(i.msg) ? /ลอย|ไม่มีต้นทาง|ยังไม่ได้ต่อ/.test(b.msg)
      : /multi-driver|สายเข้าซ้อน/.test(b.msg)===/multi-driver/.test(i.msg)));
    return base.concat(extra.filter(i=>!dup(i)));
  };
  const _fix=issueFix;
  issueFix=function(m){
    if(/ต้นทาง \d+ ตัว|รับสายจาก \d+ เส้น/.test(m)) return _fix("multi-driver");
    if(/ไม่มีอะไรขับ/.test(m)) return "หาว่าสายเส้นนี้ควรมาจากเอาต์พุตไหน แล้วต่อจากขานั้น — ถ้าเป็นบัส ดูว่า bus tap ทุกบิตมีสายเข้า";
    if(/INPUT .* ไม่ได้ต่อไปไหน/.test(m)) return "ต่อ INPUT นี้เข้ากับเกตที่ควรใช้ค่านี้ หรือลบทิ้งถ้าไม่ได้ใช้";
    if(/ไม่ได้ต่อไปไหน/.test(m)) return "ต่อเอาต์พุตนี้ไปยังที่ที่ต้องใช้ (เกตถัดไปหรือ OUTPUT) หรือลบเกตนี้ถ้าไม่ต้องการ";
    return _fix.apply(this, arguments);
  };
}
