/* ===== 47. What a small model gets almost right is taken as meant ==================================
   From the baseline eval of Qwen3.5-4B (60 held-out tasks, 45 % passed): a quarter of its tool calls
   failed, mostly on details the app can read without guessing —
     - build_circuit / build_part answered "could not draw: [object Object]" (the error objects were
       never turned into text, so the model could not see what was wrong — 30 calls);
     - build_fsm got the diagram object as a JSON *string* (every FSM task failed from there), and
       conditions written "a=0" / "a=1";
     - intent component types "input" / "OUTPUT" / "Input" for IN / OUT;
     - set_pins targets "LED:14", "led[3]", "SW3", "led 3" for led:14 / sw:3 — and the hint pointed at a
       tool (board_pins) the agent does not have;
     - truth_table / set_spec `ones` as a bare list when there is one output;
     - generator {kind:"adder"} and add_component type "adder" for a library part.
   Each is read as what it plainly means; anything else still fails with a hint the agent can act on. */

/* ---- error objects → readable text ---- */
{
  const _d=aiDrawIntent;
  aiDrawIntent=function(intent, opts){
    intent=agrNormIntent(intent);
    const r=_d.call(this, intent, opts);
    if(r && !r.ok && Array.isArray(r.errors)) r.errors=r.errors.map(e=>e && typeof e==="object" ? [e.msg||e.message||e.code, e.hint].filter(Boolean).join(" — ") : e);
    return r;
  };
}
/* "input" / "Output" / "INPUT" / "and" → IN / OUT / AND; IN / OUT without a name are named by their id */
function agrNormIntent(it){
  if(!it || typeof it!=="object" || !Array.isArray(it.components)) return it;
  const ALIAS={INPUT:"IN", INPUTS:"IN", OUTPUT:"OUT", OUTPUTS:"OUT", INPORT:"IN", OUTPORT:"OUT", INV:"NOT", INVERTER:"NOT", BUFFER:"BUF"};
  return Object.assign({}, it, {components:it.components.map(c=>{
    if(!c || typeof c.type!=="string" || /^block:/i.test(c.type)) return c;
    let T=c.type.trim().toUpperCase(); T=ALIAS[T]||T;
    const o=Object.assign({}, c, {type:(typeof TYPES!=="undefined" && TYPES[T]) ? T : c.type});
    if((o.type==="IN"||o.type==="OUT") && !o.name) o.name=o.id;
    return o; })});
}

/* ---- build_fsm: a JSON string of the diagram object; "x=1" / "x=0" / "x==1" in a condition ---- */
{
  const _p=fsmParse;
  fsmParse=function(src){
    if(typeof src==="string" && /^\s*\{/.test(src)){
      try{ src=JSON.parse(src); }
      catch(_){ try{ src=JSON.parse(src.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')); }catch(_){} }   // {inputs: […]} — keys unquoted
    }
    if(src && typeof src==="object" && Array.isArray(src.states)){
      // a state's output written "out": 1 / "out": "hit=1" — taken for the one output (it used to be dropped,
      // so a Moore detector could never say 1)
      const outs=Array.isArray(src.outputs) ? src.outputs : (typeof src.outputs==="string" ? src.outputs.split(/[\s,]+/).filter(Boolean) : []);
      src=Object.assign({}, src, {states:src.states.map(st=>{
        if(!st || typeof st!=="object") return st;
        let o=st.out!=null ? st.out : st.outputs;
        if(typeof o==="number" || typeof o==="boolean"){ if(outs.length===1) o={[outs[0]]:+o}; }
        else if(typeof o==="string") o=fsmAssigns(o.replace(/\s*=\s*/g, "="));
        return Object.assign({}, st, {out:o}); })});
    }
    if(typeof src==="string") src=src.split(/\n|;/).map(agrFsmLine).join("\n");
    else if(src && typeof src==="object" && Array.isArray(src.transitions))
      src=Object.assign({}, src, {transitions:src.transitions.map(t=>t && typeof t.when==="string" ? Object.assign({}, t, {when:agrFsmCond(t.when)}) : t)});
    return _p.call(this, src);
  };
}
function agrFsmCond(c){ return String(c).replace(/\b([A-Za-z_]\w*)\s*==?\s*1\b/g, "$1").replace(/\b([A-Za-z_]\w*)\s*==?\s*0\b/g, "~$1"); }
function agrFsmLine(l){
  const m=/^(\s*\w+\s*-+>\s*\w+\s*(?:when|if|on|:)\s*)([^/]*)(\/.*)?$/i.exec(l);   // only the condition, never "/ z=1"
  return m ? m[1]+agrFsmCond(m[2])+(m[3]||"") : l;
}

/* ---- set_pins: the target spellings people and models use ---- */
function agrPinTarget(t){
  if(typeof t!=="string") return t;
  const s=t.trim().toLowerCase().replace(/\s+/g, "");
  if(/^(clk|clock|clk50|clk_50m|50mhz)$/.test(s)) return "clk";
  let m=/^(sw|switch|สวิตช์|led|pb|btn|button|ปุ่ม|an|digit|หลัก)[:_\-\[(]?(\d+)[\])]?$/.exec(s);
  if(m) return ({switch:"sw", "สวิตช์":"sw", btn:"pb", button:"pb", "ปุ่ม":"pb", digit:"an", "หลัก":"an"}[m[1]]||m[1])+":"+(+m[2]);
  m=/^(?:seg|7seg|segment)[:_\-\[(]?([a-g]|dp)[\])]?$/.exec(s);
  if(m) return "seg:"+m[1];
  return t;
}
{
  const _sp=MCP_OPS.set_pins;
  MCP_OPS.set_pins=a=>{
    const map={}; Object.entries((a&&a.map)||{}).forEach(([k,v])=>{ map[k]=agrPinTarget(v); });
    try{ return _sp(Object.assign({}, a, {map})); }
    catch(e){
      if(/is not a valid (input|output) target/.test(String(e.message)))
        mcpFail(e.message, "targets: inputs sw:0–sw:15, pb:0–pb:4 (top bottom left right center), clk · outputs led:0–led:15, seg:a–seg:g, seg:dp, an:0–an:3 — e.g. {\"a\":\"sw:0\", \"y\":\"led:3\"}");
      throw e;
    }
  };
}

/* ---- ones as a bare list (one output); a library part asked for as a generator / component type ---- */
function agrOnes(t, outs){
  if(!t || !Array.isArray(t.ones)) return t;
  const o=(Array.isArray(t.outputs) && t.outputs.length===1) ? t.outputs[0] : (outs && outs.length===1 ? outs[0] : null);
  if(!o) mcpFail("ones as a list needs the one output's name", 'write ones:{y:[1,5,9]} (the rows where y is 1), or add outputs:["y"]');
  return Object.assign({}, t, {ones:{[o]:t.ones}, outputs:t.outputs||[o]});
}
{
  const _bc=MCP_OPS.build_circuit;
  MCP_OPS.build_circuit=async a=>{
    a=Object.assign({}, a);
    if(a.truth_table) a.truth_table=agrOnes(a.truth_table);
    const g=a.generator, kind=g && String(g.kind||"");
    if(kind && typeof PARTS==="object" && PARTS[kind] && !["clock_divider","jk_counter","mod_counter","shift_register","register"].includes(kind)){
      const args=Object.assign({}, g, {kind}); if(a.sheet||a.name) args.sheet=a.sheet||a.name; if(a.replace) args.replace=true;
      const r=await MCP_OPS.build_part(args);
      return Object.assign({}, r, {note:(r.note?r.note+" · ":"")+`'${kind}' is a library part — built with build_part (next time call build_part {kind:'${kind}'} directly)`});
    }
    return _bc(a);
  };
  const _ss=MCP_OPS.set_spec;
  MCP_OPS.set_spec=a=>{
    a=Object.assign({}, a);
    if(a.table && Array.isArray(a.table.ones)){
      let outs=null; try{ const s=a.sheet && aifSheetByName(a.sheet); if(s) outs=s.components.filter(c=>c.type==="OUT").map(c=>c.params.name); }catch(_){}
      a.table=agrOnes(a.table, outs);
    }
    return _ss(a);
  };
  const _ac=MCP_OPS.add_component;
  MCP_OPS.add_component=a=>{
    const k=a && String(a.type||"").toLowerCase();
    if(k && typeof PARTS==="object" && PARTS[k])
      mcpFail(`'${a.type}' is a library part, not a gate`, `build_part {kind:'${k}', sheet:'<new sheet>'} makes it (checked), then add_component {type:'block:<that sheet>'} places it — or use build_hierarchy with blocks:[{name, part:'${k}'}]`);
    return _ac(a);
  };
}
