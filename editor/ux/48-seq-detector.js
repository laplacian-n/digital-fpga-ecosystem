/* ===== 48. Sequence detectors read from the request — no model in between ======================
   Two training rounds on the 4B model left FSM requests at 0–1 of 10: every one of them was a
   sequence detector ("ตรวจจับ 1011 แบบ Mealy ซ้อนทับได้ อินพุต x เอาต์พุต z"), which says exactly
   what the circuit must do. So code reads it (like 34 does for equations): the pattern, Moore / Mealy,
   overlapping or not, the input / output / sheet names → the diagram (each state = the longest prefix
   of the pattern seen so far, KMP) → build_fsm (which checks circuit = diagram) → the circuit is run
   on a random stream against a sliding-window detector written separately from the diagram (Moore
   shows a hit one clock later). Unsaid choices get the lab defaults, named in the answer: Moore,
   overlapping. A request that asks for more (pins, connect it…) goes on to the model with it built. */
const SQD_WORD=/ตรวจจับ|จับลำดับ|ลำดับบิต|ลำดับ|รหัส|sequence|detector|detect|pattern/i;
const SQD_NOT=/ตัวนับ|counter|นับขึ้น|นับลง|หารความถี่|divider|shift|เลื่อนบิต|รีจิสเตอร์|register/i;
const SQD_KEYWORDS=new Set(["moore","mealy","fsm","state","machine","sequence","detector","overlap","overlapping","non",
  "nonoverlap","non_overlap","pattern","bit","bits","input","output","sheet","lab","clk","clock","rst","reset","the","a","an","when","on","in","with","and","to"]);
function sqdNext(p, k, b, overlap){
  const n=p.length;
  if(k===n) k = overlap ? sqdBorder(p) : 0;
  const s=p.slice(0,k)+b;
  for(let L=Math.min(s.length,n); L>=0; L--) if(s.endsWith(p.slice(0,L))) return L;
  return 0;
}
function sqdBorder(p){ for(let L=p.length-1; L>0; L--) if(p.endsWith(p.slice(0,L))) return L; return 0; }
/* the reference: 1 where the pattern ends (with no reuse of matched bits when not overlapping) */
function sqdReference(p, bits, overlap){
  const out=[]; let last=-1;
  bits.forEach((_,i)=>{ let hit = i+1>=p.length && bits.slice(i+1-p.length, i+1).join("")===p;
    if(hit && !overlap && i-p.length<last) hit=false;
    if(hit) last=i; out.push(hit?1:0); });
  return out;
}
function sqdDiagram(d){
  const {pattern:p, overlap, mealy, x, z}=d, n=p.length, L=[`inputs: ${x}`, `outputs: ${z}`];
  const states=[...Array(mealy?n:n+1).keys()];
  states.forEach(k=>L.push(mealy ? `state S${k}` : `state S${k}: ${z}=${k===n?1:0}`));
  states.forEach(k=>["1","0"].forEach(b=>{
    let j=sqdNext(p, k, b, overlap), hit=false;
    if(mealy && j===n){ hit=true; j = overlap ? sqdBorder(p) : 0; }
    L.push(`S${k} -> S${j} when ${b==="1"?x:"~"+x}`+(hit?` / ${z}=1`:""));
  }));
  L.push("reset S0");
  return L.join("\n");
}
/* {pattern, mealy, overlap, x, z, sheet, said:{kind, overlap}} or null */
function sqdParse(msg){
  const t=String(msg||"");
  if(!SQD_WORD.test(t) || SQD_NOT.test(t)) return null;
  if(typeof aiLooksLikeQuestion==="function" && aiLooksLikeQuestion(t) && !/(ทำ|สร้าง|ออกแบบ|อยากได้|ช่วย|build|make|design)/i.test(t)) return null;
  const pats=[...new Set([...t.matchAll(/(?<![A-Za-z0-9_])([01]{3,8})(?![A-Za-z0-9_])/g)].map(m=>m[1]))];
  if(pats.length!==1) return null;
  const pattern=pats[0];
  const isMealy=/mealy|มีลี่|มีลีย์|เมลี่/i.test(t), isMoore=/moore|มัวร์|มัวร์/i.test(t);
  if(isMealy && isMoore) return null;
  const non=/ไม่ซ้อน|ไม่ทับ|non[-_ ]?overlap|ห้ามใช้บิตซ้ำ|ไม่ใช้บิตซ้ำ|เริ่มนับใหม่|เริ่มใหม่/i.test(t);
  const ov=!non && /ซ้อน|ทับ|overlap/i.test(t);
  const sheet=aioSheetName(t);
  // names: words the request uses as signals (not keywords, not the sheet)
  const id="([A-Za-z_][A-Za-z0-9_]*)";
  const after=res=>{ for(const re of res) for(const m of t.matchAll(re))
    if(!SQD_KEYWORDS.has(m[1].toLowerCase()) && m[1]!==sheet && m[1]!==pattern) return m[1]; return null; };
  let x=after([new RegExp("(?:อินพุต|ขาเข้า|สายอินพุต|input)\\s*(?:ชื่อ\\s*)?"+id,"gi"), new RegExp("(?:จาก|ใน|บน)\\s*(?:สาย\\s*)?"+id+"(?=\\s|$|[ ,.])","gi")]);
  let z=after([new RegExp("(?:เอาต์พุต|เอาท์พุต|ขาออก|output|ผลออกที่|ออกที่)\\s*(?:ชื่อ\\s*)?"+id,"gi"),
    new RegExp("(?:ให้\\s*)?"+id+"\\s*(?:=\\s*1|เป็น\\s*1|ติด)","gi")]);
  if(x && z && x.toLowerCase()===z.toLowerCase()) return null;
  return {pattern, mealy:isMealy, overlap:non?false:true, x:x||"x", z:z||"z", sheet,
    said:{kind:isMealy||isMoore, overlap:non||ov, x:!!x, z:!!z}};
}
/* the circuit against the reference on a random stream (with the pattern planted, also overlapping) */
function sqdCheck(sch, d){
  const p=d.pattern, bits=[]; for(let i=0;i<64;i++) bits.push(Math.random()<0.5?"0":"1");
  [5, 30].forEach(i=>p.split("").forEach((b,k)=>bits[i+k]=b));
  const B=sqdBorder(p); if(B){ (p+p.slice(B)).split("").forEach((b,k)=>bits[44+k]=b); }
  const ref=sqdReference(p, bits, d.overlap), want=d.mealy ? ref : [0, ...ref.slice(0,-1)];
  const ins=sch.components.filter(c=>c.type==="IN"), xin=ins.find(c=>String(c.params.name).toLowerCase()===d.x.toLowerCase());
  if(!xin) return {ok:false, why:"no input "+d.x};
  const holdAt=i=>({[xin.id]:+bits[i]||0});
  const j=clientSeqSim(sch, bits.length, {holdAt, hold:holdAt(0)}); if(!j.ok) return {ok:false, why:j.reason};
  const sq=j.sequence, k=sq.outputs.findIndex(o=>String(o).toLowerCase()===d.z.toLowerCase());
  if(k<0) return {ok:false, why:"no output "+d.z};
  const bad=[]; want.forEach((w,i)=>{ const row=sq.rows[i], got=row[4]?row[4][k]:row[3][k]; if(+got!==w) bad.push(i); });
  return {ok:!bad.length, clocks:bits.length, bad, why:bad.length?`${d.z} differs at clocks ${bad.slice(0,8).join(",")}`:""};
}
async function sqdBuild(msg, call){
  const d=sqdParse(msg); if(!d) return null;
  const fsm=sqdDiagram(d), args={fsm, name:d.sheet||"det_"+d.pattern};
  if(d.sheet){ args.sheet=d.sheet; const s=aifSheetByName(d.sheet); if(s && s.components.some(c=>c.type!=="JUNCTION")) args.replace=true; }
  const r=await call("build_fsm", args);
  if(!r.ok) return {error:r.error, d};
  const sch=aifSheetByName(r.result.sheet), c=sqdCheck(sch, d);
  if(c.ok) sheetVerifyStamp(sch, `request read by the app (no model): detect ${d.pattern}, ${d.mealy?"Mealy":"Moore"}, ${d.overlap?"overlapping":"non-overlapping"}`);
  const kind=d.mealy?"Mealy":"Moore", ovs=d.overlap?"ซ้อนทับได้":"ไม่ซ้อนทับ";
  const assumed=[!d.said.kind && "แบบ Moore", !d.said.overlap && "ซ้อนทับได้", !d.said.x && `อินพุต ${d.x}`, !d.said.z && `เอาต์พุต ${d.z}`].filter(Boolean);
  return {sheet:sch.name, d, check:c, states:r.result.states, ffs:r.result.flip_flops,
    final:`สร้างวงจรตรวจจับลำดับ ${d.pattern} แบบ ${kind} (${ovs}) ลงแผ่น ${sch.name} — โปรแกรมอ่านจากคำขอเองโดยตรง ไม่ผ่านการตีความของโมเดล\n`+
      `${r.result.states} สถานะ · D flip-flop ${r.result.flip_flops} ตัว · อินพุต ${d.x} · เอาต์พุต ${d.z}`+
      (d.mealy?` (Mealy: ${d.z} เป็น 1 ในสัญญาณนาฬิกาเดียวกับบิตสุดท้าย)`:` (Moore: ${d.z} เป็น 1 หลังขอบนาฬิกาที่รับบิตสุดท้าย)`)+"\n"+
      (c.ok ? `✓ จำลอง ${c.clocks} สัญญาณนาฬิกา ตรงกับตัวตรวจจับอ้างอิงทุกจังหวะ` : `⚠ จำลองแล้วไม่ตรง: ${c.why}`)+
      (assumed.length?`\nคำขอไม่ได้ระบุ จึงใช้ค่าปกติ: ${assumed.join(", ")} — บอกได้ถ้าต้องการแบบอื่น`:"")+
      "\nแผนภาพสถานะอยู่ในเครื่องมือ ▸ ออกแบบ FSM"};
}

/* ---- the agent: before the model ---- */
{
  const _fp=aiagFastPath;
  aiagFastPath=async function(msg, run){
    let res=null;
    try{ res=await sqdBuild(msg, async (tool, args)=>{ const x=await aiagCall(tool, args);
      const st={kind:"tool", tool, args, ok:x.ok, fast_path:true, summary:x.ok?`sheet ${x.result.sheet} · built from the request, no model`:undefined, error:x.ok?undefined:x.error};
      run.steps.push(st); aiagLine(aiagStepHtml(st), "step"); return x; }); }catch(e){ console.warn("sequence detector", e); }
    if(!res) return _fp.apply(this, arguments);
    if(res.error) return {note:`(system) The request is a sequence detector (${res.d.pattern}); building it from the request failed: ${res.error}. Build it yourself with build_fsm.`};
    run.steps.push({kind:"tool", tool:"simulate", args:{sheet:res.sheet}, ok:res.check.ok, summary:res.check.ok?`${res.check.clocks} clocks match a reference detector`:res.check.why});
    if(!res.check.ok || AIO_MORE.test(msg))
      return {note:`(system) The app read the request itself and built the ${res.d.pattern} detector on sheet '${res.sheet}'`+
        (res.check.ok?" — it matches a reference detector on every clock, do not rebuild it. Do only the rest of the request.":`, but ${res.check.why} — fix it.`)};
    return {final:res.final};
  };
}
