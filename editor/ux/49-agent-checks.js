/* ===== 49. What the agent checked, said plainly ==================================================
   From testing the fine-tuned 4B (SFT1) on lab 7: asked "ถ้า sec>59 ไฟ error ติดมั้ย", it called check_spec
   on a sheet with no spec, read back "pass undefined" and answered as if it had tested; it also said
   "พร้อมลงบอร์ด" without running board_check. So:
     - check_spec on a sheet with no spec answers pass:null + NO SPEC + what to call instead (probe), and the
       step in the chat says so;
     - probe takes a numbered INPUT group as one number (lab7's sw0..sw15 → sw:0x1260), like a bus;
     - an answer that talks about the board, from a run that never ran board_check, gets the board doctor's
       own verdict appended (the app checks; the model does not get to sound sure). */
{
  const _cs=MCP_OPS.check_spec;
  const none=s=>({sheet:s.name, spec:null, pass:null, checked:false,
    note:`NO SPEC on sheet '${s.name}' — nothing was checked. To test given input values (e.g. "if sw = … is led_error on?") `+
      "call probe {inputs:{…}} and read the outputs (a numbered group like sw0..sw15 or a bus takes one number); "+
      "for clocked behaviour call simulate. set_spec first if you want an acceptance test."});
  MCP_OPS.check_spec=a=>{
    if(a.all_sheets){ const r=_cs(a); if(!r.sheets.length) return {sheets:[], pass:null, checked:false, note:"NO SPEC on any sheet — nothing was checked"}; return r; }
    const s=mcpSheet(a.sheet); if(!s.spec) return none(s);
    return _cs(a);
  };
  const _sum=aiagSummary;
  aiagSummary=function(tool, r){
    if(tool==="check_spec" && r && r.checked===false) return "NO SPEC — nothing was checked (to test given inputs: probe)";
    return _sum.apply(this, arguments);
  };
}

/* ---- probe: a numbered INPUT group (sw0..sw15, a_0..a_3) as one number ---- */
function acNumber(v, w){
  if(typeof v==="number") return v;
  const t=String(v).trim().replace(/_/g,"");
  if(/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2),16);
  if(/^0b[01]+$/i.test(t)) return parseInt(t.slice(2),2);
  if(/^[01]+$/.test(t) && t.length===w) return parseInt(t,2);
  if(/^\d+$/.test(t)) return parseInt(t,10);
  return NaN;
}
function acSplitGroups(sch, inputs){
  if(!inputs || typeof inputs!=="object") return inputs;
  const ins=sch.components.filter(c=>c.type==="IN"), has=n=>ins.some(c=>String(c.params.name).toLowerCase()===String(n).toLowerCase());
  const out={};
  Object.entries(inputs).forEach(([n,v])=>{
    if(has(n)){ out[n]=v; return; }
    const bits=[]; ins.forEach(c=>{ const m=/^(.*?)_?(\d+)$/.exec(String(c.params.name)); if(m && m[1].toLowerCase()===String(n).toLowerCase() && (c.params.width||1)===1) bits[+m[2]]=c.params.name; });
    if(bits.length<2 || bits.some(b=>!b)){ out[n]=v; return; }                 // not a group: the core says "no INPUT"
    const x=acNumber(v, bits.length);
    if(isNaN(x)) mcpFail(`'${n}' is the group ${bits[0]}..${bits[bits.length-1]}: give one number`, `e.g. ${n}: 4704, "0x1260" or "0b${"0".repeat(bits.length)}"`);
    bits.forEach((b,i)=>{ out[b]=(x>>i)&1; });
  });
  return out;
}
{
  const _probe=MCP_OPS.probe;
  MCP_OPS.probe=a=>{ const sch=mcpSheet(a.sheet); return _probe(Object.assign({}, a, {inputs:acSplitGroups(sch, a.inputs)})); };
}

/* ---- an answer about the board from a run that never ran board_check ---- */
function aiagBoardVerdict(run){
  if(!run.final || !/บอร์ด|board|\.bit|ลงชิป|fpga/i.test(run.final)) return "";
  if((run.steps||[]).some(s=>s.tool==="board_check" && s.ok)) return "";
  const sch=activeSch(); if(!sch || !sch.components.some(c=>c.type==="IN"||c.type==="OUT")) return "";
  let F; try{ F=boardDoctor(sch); }catch(_){ return ""; }
  const err=F.filter(f=>f.lvl==="err"), warn=F.filter(f=>f.lvl!=="err");
  return `\n\n🩺 โปรแกรมตรวจการลงบอร์ดให้ (แผ่น ${sch.name}): `+
    (err.length ? `ยังไม่พร้อม — พบปัญหา ${err.length} ข้อ: ${err.slice(0,3).map(f=>f.title).join(" · ")}` : "ไม่พบปัญหา")+
    (warn.length ? ` (ข้อควรดู ${warn.length} ข้อ)` : "")+" — ดูรายละเอียดที่หน้า ลงบอร์ด ▸ 🩺";
}
{
  const _v=aiagVerdict;
  aiagVerdict=function(run){ let s=_v.apply(this, arguments); try{ s+=aiagBoardVerdict(run); }catch(e){ console.warn("board verdict", e); } return s; };
}
