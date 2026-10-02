/* ===== 41. The board doctor fixes what it can, and lab pin presets ==================================
   The doctor (29) found segments written active-high for the common-anode display and a 7-seg with no
   digit enabled, then only said what to do. Now each of those has "🔧 แก้ให้" (and MCP board_check
   {fix:true}): a NOT in front of every a–g OUTPUT, an OUTPUT an0 driven by GND on "หลัก 0", and the pins
   guessed for ports that have none. One undo step each, through MCP apply.
   pin_preset {lab} maps ports by their role the way the lab sheet wires the board — lab 6: SW7–4 = tens
   of yy, SW3–0 = ones, the centre button = start/stop, LED0 = error; lab 7 / 8: SW15–0 = four BCD
   digits — plus a–g / an / clk; what it cannot place is left for auto_pins. */
function bfixSegOuts(sch){
  return uxPortBits(sch).map(b=>Object.assign({t:uxPinTarget(b, sch)}, b)).filter(b=>b.dir==="out" && /^seg:[a-g]$/.test(b.t||""));
}
/* the fixes: {id, label, run(sch) → what was done} */
const BFIX={
  seg:{label:"ใส่ NOT ที่ขา a–g", run:sch=>{
    const segs=bfixSegOuts(sch), steps=[], done=[];
    segs.forEach(b=>{ const o=sch.components.find(c=>c.type==="OUT" && sanId(c.params.name)===b.port);
      if(!o || (o.params.width||1)>1) return;                         // a bus OUTPUT: one bit cannot be inverted here
      const w=sch.wires.find(x=>x.to.cid===o.id); if(!w) return;
      let d=null; try{ d=netDriverPort(sch, w); }catch(_){} const dc=d&&comp(d.cid, sch); if(!dc) return;
      const nm="inv_"+sanId(o.params.name), drv=mcpName(dc)+"."+d.pid;
      steps.push({op:"disconnect", from:drv, to:o.params.name}, {op:"add_component", type:"NOT", name:nm},
        {op:"connect", from:drv, to:nm}, {op:"connect", from:nm, to:o.params.name});
      done.push(o.params.name); });
    if(!steps.length) mcpFail("no single-bit a–g OUTPUT with a driver to invert", "for a bus OUTPUT use the BCD → 7-segment part with active_low");
    MCP_OPS.apply({sheet:sch.name, steps});
    return "กลับค่า "+done.join(", ")+" ด้วย NOT (active-low)"; }},
  an:{label:"เพิ่ม an0 ต่อ GND", run:sch=>{
    const nm=sch.components.some(c=>(c.type==="IN"||c.type==="OUT") && String(c.params.name).toLowerCase()==="an0") ? "an0_on" : "an0";
    MCP_OPS.apply({sheet:sch.name, steps:[{op:"add_component", type:"OUT", name:nm}, {op:"add_component", type:"GND", name:"gnd_"+nm}, {op:"connect", from:"gnd_"+nm, to:nm}]});
    sch.pinmap=Object.assign({}, sch.pinmap||{}, {[sanId(nm)]:"an:0"}); mcpCommit(sch);
    return `เพิ่ม OUTPUT ${nm} = 0 ที่ขา “หลัก 0” (เปิดหลักขวาสุด)`; }},
  pins:{label:"เดาขาให้", run:sch=>{ const r=MCP_OPS.auto_pins({sheet:sch.name}); return "เลือกขาให้แล้ว"+(r.missing&&r.missing.length?` (ยังเหลือ ${r.missing.join(", ")})`:""); }},
};
/* which finding each fix answers */
function bfixOf(f){
  if(/active-high/.test(f.title)) return "seg";
  if(/ไม่ได้กำหนดขาเลือกหลัก/.test(f.title)) return "an";
  if(/ยังไม่ได้เลือกขา/.test(f.title)) return "pins";
  return null;
}
{
  const _bd=boardDoctor;
  boardDoctor=function(){ const F=_bd.apply(this, arguments); F.forEach(f=>{ const k=bfixOf(f); if(k) f.fixable=k; }); return F; };
  const _open=openBoardDoctor;
  openBoardDoctor=function(){
    const F=_open.apply(this, arguments), m=[...document.querySelectorAll(".modal-bg")].pop(); if(!m) return F;
    m.querySelectorAll(".bd-f").forEach((el,i)=>{ const f=F[i]; if(!f || !f.fixable) return;
      const b=document.createElement("button"); b.className="btn"; b.textContent="🔧 "+BFIX[f.fixable].label; b.style.marginTop="6px";
      b.onclick=()=>{ const sch=brdSheet(); try{ const said=BFIX[f.fixable].run(sch); toast("แก้แล้ว: "+said, "ok", 5000); }catch(e){ toast("แก้ไม่ได้: "+e.message, "warn", 6000); return; }
        if(typeof m.close==="function") m.close(); else m.remove(); try{ brdRefresh(); }catch(_){} openBoardDoctor(); };
      el.appendChild(b); });
    return F;
  };
}
{
  const _bc=MCP_OPS.board_check;
  MCP_OPS.board_check=a=>{
    if(!a.fix) { const r=_bc(a); const F=boardDoctor(a.sheet?mcpSheet(a.sheet):brdSheet()); r.fixable=F.filter(f=>f.fixable).map(f=>({title:f.title, fix:f.fixable})); return r; }
    const sch=a.sheet ? mcpSheet(a.sheet) : brdSheet(), fixed=[], failed=[];
    ["pins","seg","an"].forEach(k=>{ if(!boardDoctor(sch).some(f=>f.fixable===k)) return;
      try{ fixed.push(BFIX[k].run(sch)); }catch(e){ failed.push(k+": "+e.message); } });
    const r=_bc({sheet:sch.name});
    return Object.assign(r, {fixed, failed:failed.length?failed:undefined});
  };
}

/* ---- pin presets per lab ---- */
const LAB_PIN_PRESETS={
  "6":{title:"แลป 6 ตัวนับ 00–yy", rules:[
    {re:/tens|yy_?t|_hi$/i, dir:"in", t:i=>"sw:"+(4+i)}, {re:/ones|units?|yy_?[ou]|_lo$/i, dir:"in", t:i=>"sw:"+i},
    {re:/btn|start|stop|^ss$|run|toggle/i, dir:"in", t:()=>"pb:4"}, {re:/err/i, dir:"out", t:()=>"led:0"},
    {re:/^(running|run_led|led_run)$/i, dir:"out", t:()=>"led:1"}]},
  "7":{title:"แลป 7 ตัวจับเวลา mm.ss", rules:[
    {re:/min_?hi|min_?tens|m_?hi|^mt$/i, dir:"in", t:i=>"sw:"+(12+i)}, {re:/min_?lo|min_?ones|m_?lo|^mo$/i, dir:"in", t:i=>"sw:"+(8+i)},
    {re:/sec_?hi|sec_?tens|s_?hi|^st$/i, dir:"in", t:i=>"sw:"+(4+i)}, {re:/sec_?lo|sec_?ones|s_?lo|^so$/i, dir:"in", t:i=>"sw:"+i},
    // the lab 7 sheet: SET = J14 (pb 2, left), START/STOP = J13 (pb 0, top), RESET = J12 (pb 4, centre),
    // the start time on SW[15:0], LED error = K12 (led 0), LED time-up = M12 (led 1)
    {re:/^(set|load|set_?btn|btn_?set)$/i, dir:"in", t:()=>"pb:2"}, {re:/clr|clear|reset|rst/i, dir:"in", t:()=>"pb:4"},
    {re:/start|stop|btn|^ss$|run|toggle/i, dir:"in", t:()=>"pb:0"},
    {re:/^(sw|sws|switch(es)?|time_?in|t_?in|preset|din|start_?time)$/i, dir:"in", t:i=>"sw:"+i},
    {re:/err/i, dir:"out", t:()=>"led:0"}, {re:/time_?up|timeup|t_?up|done|zero|finish/i, dir:"out", t:()=>"led:1"}]},
  "8":{title:"แลป 8 ตัวเลข 4 หลักจาก SW15–0", rules:[
    {re:/thousands|d3|dig3/i, dir:"in", t:i=>"sw:"+(12+i)}, {re:/hundreds|d2|dig2/i, dir:"in", t:i=>"sw:"+(8+i)},
    {re:/tens|d1|dig1/i, dir:"in", t:i=>"sw:"+(4+i)}, {re:/ones|units?|d0|dig0/i, dir:"in", t:i=>"sw:"+i}]},
};
const PIN_COMMON=[{re:/^(seg_?)?([a-g])$/i, dir:"out", t:(i,m)=>"seg:"+m[2].toLowerCase()}, {re:/^(an|dig|digit)_?([0-3])?$/i, dir:"out", t:(i,m)=>"an:"+(m[2]!=null?m[2]:i)},
  {re:/^(dp|seg_?dp)$/i, dir:"out", t:()=>"seg:dp"}, {re:/^(clk|clock|clk50m?)$/i, dir:"in", t:()=>"clk"}];
function pinPreset(sch, lab){
  const P=LAB_PIN_PRESETS[String(lab).replace(/\D/g,"")]; if(!P) mcpFail(`no pin preset for lab '${lab}'`, "presets: "+Object.keys(LAB_PIN_PRESETS).map(k=>"lab "+k).join(", ")+" — auto_pins guesses any design");
  const pm=Object.assign({}, sch.pinmap||{}), set=[], left=[], used=new Set();
  uxPortBits(sch).forEach(b=>{
    // the port's base name and this bit's index: a bus bit, or the number at the end of a per-bit port
    let base=b.port, i=b.bit; if(i==null){ const m=/^(.*?[A-Za-z_])_?(\d+)$/.exec(b.port); if(m && !/^(an|dig|digit)$/i.test(m[1])){ base=m[1]; i=+m[2]; } else i=0; }
    const rule=[...P.rules, ...PIN_COMMON].find(r=>r.dir===b.dir && r.re.test(base));
    if(!rule){ left.push(b.key); return; }
    const t=rule.t(i, rule.re.exec(base)); if(used.has(t)){ left.push(b.key+" (ขา "+t+" ถูกใช้แล้ว)"); return; }
    used.add(t); pm[b.key]=t; set.push(`${b.key} → ${t}`); });
  return {pm, set, left, title:P.title};
}
MCP_OPS.pin_preset = a=>{
  const sch=mcpUse(a.sheet); const r=pinPreset(sch, a.lab);
  if(a.apply!==false){ mcpBeforeChange("ขาตามแลป"); sch.pinmap=r.pm; mcpCommit(sch); }
  return {sheet:sch.name, preset:r.title, assigned:r.set, not_placed:r.left,
    note:r.left.length?"auto_pins guesses the rest (or set_pins)":"every port has a pin — board_check to confirm"};
};
