/* ===== 17. Bus ports for generated circuits: yu0..yu3 → yu[3:0] ===============================
   A generator / truth table / intent gives one INPUT or OUTPUT per bit (q0, q1, q2, q3), so
   a parent sheet had to wire yu0..yu3, t0..t3 one by one. busifyPorts turns every numbered
   group into ONE bus port, as the lab draws it:
     IN  yu (4 bits) ─┬─▷ bit 0 ─ (what yu0 fed)        (split taps)
                      ├─▷ bit 1 ─ …
     (what q0 was fed) ─◁ bit 0 ─┬─ OUT q (4 bits)      (merge taps)
   Each tap goes exactly where the old port's pin was, so the circuit's placement stays as the
   generator drew it; only the new bus nets are routed (12-wire-tidy). Bit i = the number in the
   name. Groups need ≥2 members numbered 0..n−1 with no gap, one direction, and a free name. */
function busGroups(sch, which){
  const want = which===true || which==null ? null : new Set([].concat(which).map(x=>String(x).toLowerCase()));
  const groups = new Map();
  sch.components.filter(c=>c.type==="IN"||c.type==="OUT").forEach(c=>{
    const m = /^(.*?[A-Za-z])_?(\d+)$/.exec(String(c.params.name||"")); if(!m || (c.params.width||1)>1) return;
    const key = c.type+":"+m[1];
    if(!groups.has(key)) groups.set(key, {dir:c.type, name:m[1], bits:[]});
    groups.get(key).bits.push({c, i:+m[2]});
  });
  return [...groups.values()].filter(g=>{
    if(want && !want.has(g.name.toLowerCase())) return false;
    if(g.bits.length<2) return false;
    g.bits.sort((a,b)=>a.i-b.i);
    if(!g.bits.every((b,k)=>b.i===k)) return false;                     // q0..q(n−1), no gap, no repeat
    return !sch.components.some(c=>(c.type==="IN"||c.type==="OUT") && String(c.params.name).toLowerCase()===g.name.toLowerCase());
  });
}
/* all or nothing: a group half turned into taps (the old ports gone, the bus port not yet there) left a
   "ghost" bus in lab 7 — undriven, unlisted, its pins still in the pin map */
function busifyPorts(sch, which){
  const keep = JSON.stringify({c:sch.components, w:sch.wires, o:sch.portOrder||null});
  try{ return busifyPortsRaw(sch, which); }
  catch(e){ const k = JSON.parse(keep); sch.components = k.c; sch.wires = k.w; if(k.o) sch.portOrder = k.o; else delete sch.portOrder; throw e; }
}
function busifyPortsRaw(sch, which){
  const made = [];
  busGroups(sch, which).forEach(g=>{
    const n = g.bits.length, isIn = g.dir==="IN", taps = [];
    g.bits.forEach(({c, i})=>{
      const pin = portPos(c, isIn ? "o" : "i");
      const t = {id:uid("c"), type:"BUSTAP", label:"", x:0, y:0,
        params:{bit:i, nbit:1, mode:isIn?"split":"merge", dir:isIn?"right":"left"}};
      // the tap's bit pin lands where the old port's pin was: nothing else has to move
      const yp = TYPES.BUSTAP.ports(t.params).find(p=>p.id==="y");
      t.x = snap(pin.x - yp.dx); t.y = snap(pin.y - yp.dy);
      sch.components.push(t); taps.push(t);
      sch.wires.forEach(w=>{
        if(isIn && w.from.cid===c.id){ w.from = {cid:t.id, pid:"y"}; delete w.pts; }
        if(!isIn && w.to.cid===c.id){ w.to = {cid:t.id, pid:"y"}; delete w.pts; }
      });
    });
    const gone = new Set(g.bits.map(b=>b.c.id));
    sch.components = sch.components.filter(c=>!gone.has(c.id));
    // the bus port beside the column of taps, level with its middle
    const port = {id:uid("c"), type:g.dir, label:"", x:0, y:0, params:{name:_uniquePortName(sch, g.dir, sanId(g.name)), width:n}};
    const sz = getSize(port), ys = taps.map(t=>t.y), mid = (Math.min(...ys)+Math.max(...ys))/2;
    port.x = snap(isIn ? Math.min(...taps.map(t=>t.x)) - GRID*8 - sz.w : Math.max(...taps.map(t=>t.x)) + GRID*11);
    port.y = snap(mid + 11 - sz.h/2);
    sch.components.push(port);
    if(isIn) taps.forEach(t=>sch.wires.push({id:uid("w"), from:{cid:port.id, pid:"o"}, to:{cid:t.id, pid:"d"}, name:""}));
    else {                                           // taps write INTO the bus: a dot drives nothing, the taps do
      const J = {id:uid("c"), type:"JUNCTION", label:"", x:snap(port.x - GRID*4) - 6, y:snap(portPos(port,"i").y) - 6, params:{}};
      sch.components.push(J);
      sch.wires.push({id:uid("w"), from:{cid:J.id, pid:"j"}, to:{cid:port.id, pid:"i"}, name:""});
      taps.forEach(t=>sch.wires.push({id:uid("w"), from:{cid:J.id, pid:"j"}, to:{cid:t.id, pid:"d"}, name:""}));
    }
    if(sch.portOrder){ const k = isIn ? "in" : "out", L = sch.portOrder[k];
      if(L){ const low = new Set(g.bits.map(b=>String(b.c.params.name).toLowerCase())), at = L.findIndex(x=>low.has(String(x).toLowerCase()));
        sch.portOrder[k] = L.filter(x=>!low.has(String(x).toLowerCase())); sch.portOrder[k].splice(Math.max(0,at), 0, port.params.name); } }
    made.push({port:port.params.name, dir:isIn?"in":"out", width:n, bits:g.bits.map(b=>b.c.params.name)});
  });
  if(made.length){
    try{ normalizePortFanout(sch); }catch(_){}
    try{ wtTidySheet(sch); }catch(e){ console.warn("bus ports: tidy", e); }
    // a merge bus has no driver pin, so the router may start a wire AT the OUTPUT's input or a
    // tap's bus pin; turn those round (a wire always leaves from a dot or an output)
    sch.wires.forEach(w=>{ const c = comp(w.from.cid, sch); if(!c || c.type==="JUNCTION") return;
      const p = getPort(c, w.from.pid); if(!p || p.dir!=="in") return;
      const f = w.from; w.from = w.to; w.to = f; if(w.pts) w.pts.reverse(); });
  }
  return made;
}
/* the sheets that place `sch` as a block: its pins would change under their wires */
function busParents(sch){
  return Object.values(state.project.schematics).filter(s=>s!==sch && s.components.some(c=>c.type==="SCH:"+sch.id)).map(s=>s.name);
}
/* Tools ▸ "รวมขาเป็นบัส" on the sheet on screen */
function busPortsOnSheet(sch, which){
  sch = sch || activeSch(); if(!sch) return {error:"ไม่มีแผ่นที่เปิดอยู่"};
  const par = busParents(sch);
  if(par.length) return {error:`แผ่นนี้ถูกใช้เป็นบล็อกใน ${par.join(", ")} — ขาเปลี่ยนแล้วสายในแผ่นนั้นจะหลุด`};
  if(!busGroups(sch, which).length) return {error:"ไม่มีกลุ่มขาที่ชื่อเรียงเลข 0,1,2… (เช่น q0 q1 q2 q3)"};
  const was = sch.locked; sch.locked = false;
  const made = busifyPorts(sch, which);
  sch.locked = was;
  return {made};
}
GENERATORS.push({id:"busports", icon:"⫼", name:"รวมขาเป็นบัส (q0…q3 → q)", desc:"ขา INPUT/OUTPUT ที่ชื่อเรียงเลข รวมเป็นขาบัสขาเดียวพร้อม bus tap — แผ่นย่อยจะมีขาเดียวแทน 4 ขา", run:()=>{
  const r = busPortsOnSheet(activeSch(), true);
  if(r.error){ toast(r.error, "warn", 5000); return; }
  snapshot(); renderAll();
  toast("รวมเป็นบัสแล้ว: "+r.made.map(m=>`${m.port}[${m.width-1}:0]`).join(", "), "ok", 4000); }});
{
  const last = [...document.querySelectorAll('#menu [data-gen]')].pop();
  if(last && !document.querySelector('#menu [data-gen="busports"]')){
    const g = GENERATORS.find(x=>x.id==="busports");
    last.insertAdjacentHTML("afterend", `<button class="gen-mi" data-gen="busports" title="${escA(g.desc)}"><span class="gi">${g.icon}</span>${g.name}</button>`);
    document.querySelector('#menu [data-gen="busports"]').addEventListener("click", ()=>runGenerator("busports"));
  }
}
