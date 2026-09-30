/* ===== 42. Simulation you can debug with: numbers, a waveform, and the nets inside a block ==========
   From testing over MCP: a 4-bit adder's table came back as "000000000 → 00000", a counter as the bit
   string "100" per clock (q0 first — easy to misread), and probe only saw the top sheet's nets, so a
   wrong wire inside a block could not be found. Now
     - simulate adds `table` / `values`: every port as ONE number (a bus a[3:0], or a numbered group
       q0..q2), and for flip-flop sheets a text `waveform` (1-bit: ▁▔, buses: their values per clock);
     - probe {inside:"u"} (or a path "u/v") gives every net INSIDE that block, computed in the context
       of the whole circuit, named as that sheet names them. */
/* names → ports: "a[2]" → a bit 2, "q1" (with q0..qn-1 all present) → q bit 1, anything else itself */
function sdGroups(names){
  const G={}, add=(base,bit,i)=>{ const k=base.toLowerCase(); (G[k]=G[k]||{name:base, bits:[]}).bits.push({bit, i}); };
  const num={}; names.forEach((n,i)=>{ const m=/^(.*?[A-Za-z_])_?(\d+)$/.exec(n); if(m) (num[m[1].toLowerCase()]=num[m[1].toLowerCase()]||[]).push(+m[2]); });
  names.forEach((n,i)=>{ const b=/^(.*)\[(\d+)\]$/.exec(n); if(b) return add(b[1], +b[2], i);
    const m=/^(.*?[A-Za-z_])_?(\d+)$/.exec(n), L=m&&num[m[1].toLowerCase()];
    if(m && L.length>=2 && L.slice().sort((x,y)=>x-y).every((v,k)=>v===k) && !names.some(x=>x.toLowerCase()===m[1].toLowerCase())) return add(m[1], +m[2], i);
    add(n, 0, i); });
  return Object.values(G);
}
const sdVal=(g, bitAt)=>g.bits.reduce((v,b)=>{ const x=bitAt(b.i); return x==null||isNaN(x) ? NaN : v+(+x?2**b.bit:0); }, 0);
const sdWide=G=>G.some(g=>g.bits.length>1);
/* a text waveform: one line per port; 1-bit ▁▔, wider ones their value in each clock's cell */
function sdWaveform(rowsVals, G){
  const w=Math.max(2, ...G.filter(g=>g.bits.length>1).map(g=>String(2**g.bits.length-1).length+1));
  const pad=Math.max(...G.map(g=>g.name.length));
  const lines=[" ".repeat(pad)+" │"+rowsVals.map((_,i)=>String(i%100).padStart(w)).join("")];
  G.forEach(g=>{ const one=g.bits.length===1;
    lines.push(g.name.padEnd(pad)+" │"+rowsVals.map(v=>{ const x=v[g.name]; if(x==null||isNaN(x)) return "?".padStart(w);
      return one ? (x?"▔":"▁").repeat(w) : String(x).padStart(w); }).join("")); });
  return lines;
}
{
  const _sim=MCP_OPS.simulate;
  MCP_OPS.simulate=a=>{
    const r=_sim(a);
    try{
      if(r.kind==="sequential"){
        const outs=r.columns.outputs, ins=r.columns.inputs, G=sdGroups(outs);
        const vals=r.rows.map(row=>{ const o={};
          const bitAt = typeof row.outputs==="string" ? (i=>+row.outputs[i]) : (i=>{ const v=row.outputs[outs[i]]; return typeof v==="string" ? parseInt(v,2) : +v; });
          G.forEach(g=>{ o[g.name] = g.bits.length===1 && typeof row.outputs!=="string" ? bitAt(g.bits[0].i) : sdVal(g, bitAt); });
          // inputs, when each is one character of the string (1-bit inputs)
          if(typeof row.inputs==="string" && row.inputs.length===ins.length) sdGroups(ins).forEach(g=>{ o[g.name]=sdVal(g, i=>+row.inputs[i]); });
          return o; });
        r.values=vals.slice(0, 256);
        const Gin=typeof (r.rows[0]||{}).inputs==="string" && r.rows[0].inputs.length===ins.length ? sdGroups(ins) : [];
        r.waveform=sdWaveform(vals.slice(0, 64), [...Gin, ...G]);
        r.note=(r.note?r.note+" · ":"")+"values = every port as one number per clock (q0..qn → q); waveform = the same, drawn";
      } else if(r.mode==="vectors"){
        r.rows.forEach(x=>{ x.values=Object.fromEntries(Object.entries(x.outputs).map(([k,v])=>[k, v&&typeof v==="object"?v.value:typeof v==="string"&&/^[01]+$/.test(v)?parseInt(v,2):v])); });
        const Gi=sdGroups(Object.keys((r.rows[0]||{}).values||{})); if(sdWide(Gi)) r.rows.forEach(x=>Object.assign(x.values, Object.fromEntries(Gi.filter(g=>g.bits.length>1).map(g=>[g.name, sdVal(g, i=>x.values[Object.keys(x.values)[i]])]))));
      } else if(r.kind==="combinational" && r.inputs){
        const GI=sdGroups(r.inputs), GO=sdGroups(r.outputs);
        if(sdWide(GI) || sdWide(GO)){
          r.table=r.rows.slice(0, 1024).map(s=>{ const [i,o]=s.split(" → "), row={};
            GI.forEach(g=>row[g.name]=sdVal(g, k=>+i[k])); GO.forEach(g=>row[g.name]=sdVal(g, k=>+o[k])); return row; });
          r.note=(r.note?r.note+" · ":"")+"table = every port as one number"+(r.rows.length>1024?" (first 1024 rows)":"");
        }
      }
    }catch(e){ console.warn("sim values", e); }
    return r;
  };
}
/* ---- probe: the nets inside a block ---- */
{
  const _probe=MCP_OPS.probe;
  MCP_OPS.probe=a=>{
    if(!a.inside) return _probe(a);
    const top=mcpSheet(a.sheet);
    // walk the path: u/v = block v inside the sheet of block u
    let sch=top, prefix="", path=[];
    for(const part of String(a.inside).split(/[\/.]/).filter(Boolean)){
      const c=findCompRef(sch, part); const sub=c && subSchOf(c);
      if(!sub) mcpFail(`no block '${part}' on ${sch.name}`, "blocks: "+sch.components.filter(x=>subSchOf(x)).map(x=>mcpName(x)).join(", "));
      prefix+=c.id+"__"; path.push(mcpName(c)); sch=sub; }
    const fs=flattenSchematic(top).sch, saved=Object.assign({}, PROBE_VALS);
    try{
      Object.keys(PROBE_VALS).forEach(k=>delete PROBE_VALS[k]);
      Object.entries(a.inputs||{}).forEach(([n,v])=>{ const c=top.components.find(x=>x.type==="IN"&&String(x.params.name).toLowerCase()===String(n).toLowerCase()); if(!c) mcpFail(`no INPUT '${n}'`); PROBE_VALS[c.id]=mcpProbeVal(c, v); });
      const m=probeModel(fs, probeStruct(fs));
      // a pin's value in the flat circuit: a block's output lives on its inner OUTPUT (a BUF)
      const valOf=(cid, pid, S, pre)=>{ const c=comp(cid, S); if(!c) return null;
        const sub=subSchOf(c);
        if(sub){ const pp=schPortList(sub).find(q=>q.id===pid && q.dir==="out"); if(!pp) return null; try{ return m.outVal(pre+cid+"__"+pp.cid, "o", new Set()); }catch(_){ return null; } }
        try{ return m.outVal(pre+cid, pid, new Set()); }catch(_){ return null; } };
      const nets=mcpNets(sch).map(n=>{ if(!n.driver) return Object.assign({value:"undriven"}, n);
        const k=n.driver.lastIndexOf("."), c=findCompRef(sch, n.driver.slice(0,k)), v=c ? valOf(c.id, n.driver.slice(k+1), sch, prefix) : null;
        return Object.assign({value:v==null?"unknown":v}, n); });
      const ports=schPortList(sch).map(p=>{ const c=comp(p.cid, sch); let v=null;
        try{ v=m.outVal(prefix+p.cid, "o", new Set()); }catch(_){}               // flattened, an inner IN / OUT is a BUF
        return {name:p.id, dir:p.dir, value:v==null?"unknown":v}; });
      return {sheet:top.name, inside:path.join("/"), inner_sheet:sch.name, inputs:a.inputs||{}, ports, nets,
        note:"nets of the block's own sheet, with this block's inputs from the whole circuit"};
    } finally { Object.keys(PROBE_VALS).forEach(k=>delete PROBE_VALS[k]); Object.assign(PROBE_VALS, saved); }
  };
}
/* the sim page's table: one column per bit (each is a switch / LED) — plus each bus as a number */
function sdBusCols(){
  const tbl=document.querySelector("#simBoardTable table"), tt=typeof SIM_LAST_TT!=="undefined" ? SIM_LAST_TT : null;
  if(!tbl || !tt || tbl.dataset.busCols) return;
  const GI=sdGroups(tt.inputs).filter(g=>g.bits.length>1), GO=sdGroups(tt.outputs).filter(g=>g.bits.length>1);
  if(!GI.length && !GO.length) return;
  tbl.dataset.busCols="1";
  const n=tt.inputs.length, rows=[...tbl.rows];
  const G=[...GI.map(g=>({g, off:0, out:false})), ...GO.map(g=>({g, off:n, out:true}))];
  G.forEach(({g,out})=>{ const th=document.createElement("th"); th.className="bus-num"+(out?" out":"");
    th.innerHTML=`${esc(g.name)}<span class="bp">${out?"OUT":"IN"} · เลข</span>`; th.title=`${g.name} ${g.bits.length} บิตเป็นเลขฐานสิบ`; rows[0].appendChild(th); });
  rows.slice(1).forEach(tr=>{ const cells=[...tr.cells];
    G.forEach(({g,off,out})=>{ const td=document.createElement("td"); td.className="bus-num";
      const v=sdVal(g, i=>+((cells[off+i]||{}).textContent)); td.textContent=isNaN(v)?"?":String(v); if(out) td.style.color="var(--ok)"; tr.appendChild(td); }); });
}
{
  const host=document.querySelector("#simBoardTable");
  if(host) new MutationObserver(()=>{ try{ sdBusCols(); }catch(_){} }).observe(host, {childList:true});
}
