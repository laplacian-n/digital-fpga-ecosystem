/* ===== 31. "The board doesn't do what the sim did": questions → a cause, checked on THIS design =====
   After loading the .bit a beginner sees a dark board, an inverted digit or a counter that never
   moves, and has no way to tell which of ten causes it is. A few questions about what they see
   narrow it down; each answer is then checked against the design (pins, polarity, clock source,
   reset, a stale .bit, the sim's own findings) so the verdict names the pin or part to fix.
   ลงบอร์ด page ▸ "🔧 บอร์ดไม่ทำงานเหมือนที่จำลอง?", the board doctor, MCP board_troubleshoot. */
function bhFacts(sch){
  const bits=uxPortBits(sch).map(b=>Object.assign({t:uxPinTarget(b, sch)}, b));
  const of=re=>bits.filter(b=>re.test(b.t||""));
  const F={sch, bits, leds:of(/^led:/), segs:of(/^seg:[a-g]$/), ans:of(/^an:/), sws:of(/^sw:/), pbs:of(/^pb:/),
    unmapped:bits.filter(b=>!b.t), doctor:[], clock:null, resets:[], ffs:0, sim:[]};
  try{ F.doctor=boardDoctor(sch); }catch(_){}
  try{ F.sim=explainSim(sch).filter(x=>x.lvl==="err"); }catch(_){}
  try{ const fs=flattenSchematic(sch).sch, m=probeModel(fs, probeStruct(fs)), ff=fs.components.filter(c=>PROBE_SEQ[c.type]); F.ffs=ff.length;
    ff.forEach(c=>{ const s=m.source(c.id,"clk"); if(s&&s.type==="IN"&&!F.clock){ const ic=sch.components.find(x=>x.id===s.cid);
      if(ic){ const b=bits.find(x=>x.port===sanId(ic.params.name)&&x.bit==null); F.clock={name:ic.params.name, t:b&&b.t}; } } }); }catch(_){}
  F.resets=bits.filter(b=>b.dir==="in" && /^(rst|reset|clr|clear|n?rst_?n?)$/i.test(b.port));
  F.stale=typeof BRD==="object" && BRD.bit ? BRD.bit.current===false : null;
  return F;
}
const bhL=b=>`<b>${esc(b.key)}</b> → ${esc(pinTargetLabel(b.t))}`;
const BH_TREE={
  start:{q:"บอร์ดทำอะไรต่างไปจากที่จำลองไว้?", opts:[
    ["โหลดลงบอร์ดไม่สำเร็จ / หาบอร์ดไม่เจอ","load"], ["โหลดสำเร็จ แต่ไม่มีอะไรติดเลย","dark"],
    ["LED ติดผิดดวง หรือโยกสวิตช์แล้วผิดตัว","map"], ["7-segment แสดงผิด","seg"],
    ["ตัวนับไม่นับ / ค้าง / ติดสลัวๆ","count"], ["นับข้าม หรือกดทีเดียวขยับหลายค่า","bounce"],
    ["ทำงานตอนปล่อยปุ่ม แทนที่จะเป็นตอนกด","btninv"]]},
  dark:{q:"ลองโยกสวิตช์ที่วงจรใช้ — มี LED ดวงไหนเปลี่ยนบ้างไหม?", opts:[["มี แต่ไม่ใช่ดวงที่คิด","map"],["ไม่มีอะไรเปลี่ยนเลย","darkx"]]},
  seg:{q:"ส่วนที่ควรติดกลับดับ ส่วนที่ควรดับกลับติด (เหมือนภาพกลับสี) ใช่ไหม?", opts:[["ใช่ กลับสีทั้งตัว","segpol"],["ไม่ใช่","seg2"]]},
  seg2:{q:"ตัวเลขขึ้นผิดหลัก, ขึ้นทุกหลักพร้อมกัน หรือไม่มีหลักไหนติด?", opts:[["ใช่ เป็นเรื่องหลัก","segan"],["หลักถูก แต่รูปตัวเลขเพี้ยน","segmap"]]},
  count:{q:"LED ของตัวนับติดสลัวๆ ทุกดวงพร้อมกัน (ไม่เห็นกระพริบ) ใช่ไหม?", opts:[["ใช่ สลัวค้าง","fast"],["ไม่ใช่ ติดนิ่ง/ดับนิ่ง ไม่เปลี่ยน","stuck"]]},
};
function bhDiag(id, F){
  const ok=t=>`<li class="bh-ok">✓ ${t}</li>`, bad=t=>`<li class="bh-bad">⚠ ${t}</li>`, tip=t=>`<li>${t}</li>`;
  const doc=re=>F.doctor.filter(f=>re.test(f.title));
  const staleLine=F.stale===true?bad("ไฟล์ .bit ที่โหลดสร้างจากวงจรเวอร์ชันก่อน — วงจรตอนนี้เปลี่ยนไปแล้ว กด “สร้าง .bit” ใหม่แล้วโหลดอีกครั้ง"):F.stale===false?ok("ไฟล์ .bit ตรงกับวงจรตอนนี้"):"";
  const mapTable=(list,label)=>list.length?`<div class="bh-map"><div class="muted">${label}</div>${list.map(b=>`<div>${bhL(b)}</div>`).join("")}</div>`:"";
  const R={
    load:{title:"โหลดลงบอร์ดไม่สำเร็จ", checks:[], tips:[
      "เสียบสาย USB ที่ช่อง PROG/JTAG ของบอร์ด (ไม่ใช่ช่องจ่ายไฟอย่างเดียว) และเปิดสวิตช์ไฟบอร์ด",
      "กด “ตรวจหาบอร์ด” ในหน้าลงบอร์ด — ถ้าไม่เจอ ไปหน้า Home ▸ เริ่มต้นใช้งาน ▸ ไดรเวอร์ USB (Windows ต้องติดตั้งไดรเวอร์ด้วย Zadig ครั้งแรกครั้งเดียว)",
      "ปิดโปรแกรมอื่นที่อาจจับสายอยู่ (Vivado Hardware Manager, Adept)",
      "ลองเปลี่ยน “สาย (cable)” ในตั้งค่าเพิ่ม ถ้าบอร์ดใช้ชิปสายต่างรุ่น"]},
    darkx:{title:"โหลดสำเร็จ แต่บอร์ดไม่ตอบสนอง", checks:[
      staleLine,
      F.leds.length||F.segs.length ? ok(`มี OUTPUT ต่อกับ LED/7-seg ${F.leds.length+F.segs.length} ขา`) : bad("ไม่มี OUTPUT ต่อกับ LED หรือ 7-seg เลย — บอร์ดจึงไม่มีอะไรให้ดู"),
      F.sws.length||F.pbs.length ? ok(`มี INPUT ต่อกับสวิตช์/ปุ่ม ${F.sws.length+F.pbs.length} ขา`) : (F.bits.some(b=>b.dir==="in")?bad("INPUT ยังไม่ได้ต่อกับสวิตช์หรือปุ่ม"):""),
      F.unmapped.length ? bad(`ยังไม่ได้เลือกขา: ${F.unmapped.map(b=>esc(b.key)).join(", ")}`) : "",
      ...F.resets.map(b=>b.t&&/^sw:/.test(b.t) ? bad(`reset <b>${esc(b.key)}</b> อยู่ที่ ${esc(pinTargetLabel(b.t))} — ถ้าสวิตช์นี้โยกขึ้นอยู่ วงจรถูกล้างตลอด ลองโยกลง`) : ""),
      ...F.sim.slice(0,3).map(x=>bad("ในจำลองก็มีปัญหา: "+esc(x.title)))].filter(Boolean),
      tips:["กด “เทียบกับบอร์ด” ในหน้าตรวจก่อนลงบอร์ด ตั้งสวิตช์ให้ตรงกับบอร์ดจริง แล้วดูว่าควรเห็นอะไร",
        "ถ้าในภาพเทียบกับบอร์ดก็ดับ ปัญหาอยู่ที่วงจร ไม่ใช่บอร์ด — กลับไปดูในหน้าจำลอง"]},
    map:{title:"LED / สวิตช์ ผิดตัว", checks:[mapTable(F.sws.concat(F.pbs),"INPUT ของวงจรใช้:"), mapTable(F.leds,"OUTPUT ของวงจรไปที่:"), ...doc(/ใช้ขาเดียวกัน|ต่อกับ/).map(f=>bad(esc(f.title)))].filter(Boolean),
      tips:["บนบอร์ด SW 0 และ LED 0 อยู่ <b>ขวาสุด</b> ตัวเลขเพิ่มไปทางซ้าย (เหมือนบิต 0 = LSB)",
        "บัสเช่น q[3:0]: บิต 0 ควรอยู่ที่ LED 0 (ขวาสุด) — ถ้าเห็นลำดับกลับหัว แปลว่าเลือกขากลับด้าน",
        "แก้ในหน้าเลือกขา แล้วสร้าง .bit ใหม่"], pins:true},
    segpol:{title:"7-segment กลับสี", checks:[
      doc(/active-high/).length ? bad("วงจรนี้เขียน a–g แบบ active-high (1 = ติด) — แต่จอบนบอร์ดเป็น common-anode: 0 = ติด") : ok("ตารางของวงจรออกแบบ active-low แล้ว — ถ้ายังกลับสี ตรวจว่ามี NOT เกินมาที่ขา a–g ไหม")],
      tips:["ใช้ชิ้นส่วน “BCD → 7-segment” แบบ active-low (แท็บ Modules ▸ ชิ้นส่วน) หรือใส่ NOT ที่ขา a–g ทุกขา"]},
    segan:{title:"เรื่องหลักของ 7-segment", checks:[
      F.ans.length ? mapTable(F.ans,"ขาเลือกหลัก:") : bad("ไม่ได้ขับขาเลือกหลัก (an0–an3) — หลักจะติดตามค่าเริ่มต้นของบอร์ด ซึ่งอาจเป็นทุกหลักหรือไม่ติดเลย"),
      ...doc(/ทุกหลักดับ/).map(f=>bad(esc(f.title)))].filter(Boolean),
      tips:["an เป็น active-low: 0 = หลักนั้นติด, 1 = ดับ · an0 = หลักขวาสุด",
        "จะเปิดหลักเดียว: OUTPUT an0 ต่อ GND แล้ว an1–an3 ต่อ VCC",
        "จะแสดงหลายหลักพร้อมกันต้องสลับหลักเร็วๆ (time-multiplex) — ดูแลป 4 เรื่องการหารความถี่"], pins:true},
    segmap:{title:"รูปตัวเลขเพี้ยน", checks:[mapTable(F.segs,"ขา a–g ของวงจรไปที่:"), F.segs.length<7?bad(`ต่อขา a–g ไว้แค่ ${F.segs.length} ขา`):""].filter(Boolean),
      tips:["ตำแหน่งส่วน: a บน · b ขวาบน · c ขวาล่าง · d ล่าง · e ซ้ายล่าง · f ซ้ายบน · g กลาง",
        "ถ้าเลขบางตัวถูกบางตัวผิด มักเป็นเพราะเลือกขาสลับกัน 2 ขา หรือบิตอินพุตสลับ (b0 กับ b3)",
        "ใช้ “เทียบกับบอร์ด” ตั้งสวิตช์ให้เหมือนบอร์ด แล้วเทียบรูปทีละส่วน"], pins:true},
    fast:{title:"ติดสลัวค้าง = เปลี่ยนเร็วเกินตาเห็น", checks:[
      F.clock&&F.clock.t==="clk" ? bad(`นาฬิกา <b>${esc(F.clock.name)}</b> มาจาก 50 MHz ตรงๆ — ค่าเปลี่ยน 50 ล้านครั้งต่อวินาที`) : ok("นาฬิกาไม่ได้มาจาก 50 MHz ตรงๆ — ถ้ายังสลัว ตรวจว่าตัวหารความถี่หารพอไหม"),
      ok(`มี flip-flop ${F.ffs} ตัว`)],
      tips:["ใส่ตัวหารความถี่ระหว่าง clk กับวงจร: ÷50000000 = 1 Hz, ÷5000000 = 10 Hz (แท็บ Modules ▸ ชิ้นส่วน ▸ หารความถี่)",
        "ในหน้าจำลอง “⚡ เล่นเวลาจริง (50 MHz)” จะเห็นอาการเดียวกันก่อนลงบอร์ด"]},
    stuck:{title:"ตัวนับไม่เดิน", checks:[
      staleLine,
      !F.ffs ? bad("วงจรนี้ไม่มี flip-flop — จึงไม่มีอะไรนับ") : F.clock ? (F.clock.t ? ok(`นาฬิกา <b>${esc(F.clock.name)}</b> มาจาก ${esc(pinTargetLabel(F.clock.t))}`) : bad(`นาฬิกา <b>${esc(F.clock.name)}</b> ยังไม่ได้เลือกขา`)) : bad("หาไม่เจอว่า flip-flop รับนาฬิกาจาก INPUT ตัวไหน"),
      F.clock&&/^sw:/.test(F.clock.t||"") ? bad("นาฬิกามาจากสวิตช์เลื่อน — ต้องโยกขึ้น-ลงเองทีละครั้งถึงจะนับ 1 ค่า") : "",
      ...F.resets.map(b=>b.t ? bad(`reset <b>${esc(b.key)}</b> อยู่ที่ ${esc(pinTargetLabel(b.t))} — ถ้าค้างที่ 1 (สวิตช์โยกขึ้น) ตัวนับถูกล้างตลอด`) : bad(`reset ${esc(b.key)} ยังไม่ได้เลือกขา`)),
      ...F.sim.slice(0,3).map(x=>bad("ในจำลอง: "+esc(x.title)))].filter(Boolean),
      tips:["ตั้งทุกสวิตช์ลง (0) ก่อน แล้วค่อยลองทีละตัว",
        "ถ้าในหน้าจำลองก็ไม่นับ แก้ที่วงจรก่อน (ปุ่ม 🐞 Debug จะบอกว่าติดที่ไหน)"]},
    bounce:{title:"นับข้าม = หน้าสัมผัสเด้ง (bounce)", checks:[
      F.clock&&/^(pb|sw):/.test(F.clock.t||"") ? bad(`นาฬิกา <b>${esc(F.clock.name)}</b> มาจาก ${esc(pinTargetLabel(F.clock.t))} — กดหนึ่งครั้งหน้าสัมผัสเด้งหลายสิบครั้ง แต่ละครั้งเป็นขอบขาขึ้นใหม่`) : ok("นาฬิกาไม่ได้มาจากปุ่มโดยตรง — ถ้าปุ่มเป็น enable ก็ควรผ่าน debounce เหมือนกัน")],
      tips:["ใช้ clk 50 MHz + ตัวหาร (~100 Hz) เป็นนาฬิกาของชิ้นส่วน Debounce แล้วต่อ Edge detector ให้ได้ 1 พัลส์ต่อการกด 1 ครั้ง",
        "จากนั้นใช้พัลส์นั้นเป็น enable ของตัวนับ (ตัวนับยังใช้นาฬิกาเดียวกันทั้งวงจร)",
        "ทั้งสามอย่างอยู่ในแท็บ Modules ▸ ชิ้นส่วน"]},
    btninv:{title:"ปุ่มทำงานกลับด้าน", checks:[F.pbs.length?mapTable(F.pbs,"ปุ่มที่วงจรใช้:"):bad("วงจรนี้ไม่ได้ใช้ปุ่มกด")].filter(Boolean),
      tips:["ปุ่มบางแบบให้ 1 ตอนปล่อย และ 0 ตอนกด (active-low) — ใส่ NOT หลัง INPUT ของปุ่มนั้น",
        "ในหน้าจำลองจะเห็นเหมือนเดิมเพราะตัวจำลองถือว่ากด = 1 — ถ้าบอร์ดเป็นแบบนี้ ให้ทดสอบด้วยค่าที่กลับกัน"]},
  };
  return R[id];
}
function bhDiagHtml(d){
  return `<div class="bh-diag"><h3>${d.title}</h3>
    ${d.checks.length?`<div class="muted">ตรวจจากวงจรนี้แล้ว:</div><ul class="bh-checks">${d.checks.join("")}</ul>`:""}
    <div class="muted">ลองทำ:</div><ol class="bh-tips">${d.tips.map(t=>`<li>${t}</li>`).join("")}</ol>
    <div class="bh-acts">${d.pins?'<button class="btn2" data-bh="pins">ไปเลือกขา</button>':""}
      <button class="btn2" data-bh="compare">เทียบกับบอร์ด</button><button class="btn2" data-bh="sim">ไปหน้าจำลอง</button>
      <button class="btn2" data-bh="ask">💬 ถาม AI ต่อ</button></div></div>`;
}
function openBoardHelp(start){
  const sch=brdSheet(), F=bhFacts(sch), path=[start||"start"];
  const m=uxModal("🔧 บอร์ดไม่ทำงานเหมือนที่จำลอง — "+esc(sch.name), `<div id="bhBody"></div>`, {width:720});
  const draw=()=>{ const id=path[path.length-1], node=BH_TREE[id], body=m.querySelector("#bhBody");
    const back=path.length>1?'<button class="btn2 bh-back" data-bh="back">← ย้อน</button>':"";
    if(node) body.innerHTML=`${back}<div class="bh-q">${esc(node.q)}</div><div class="bh-opts">${node.opts.map(([t,go])=>`<button class="btn bh-o" data-go="${go}">${esc(t)}</button>`).join("")}</div>`;
    else body.innerHTML=back+bhDiagHtml(bhDiag(id, F)); };
  m.addEventListener("click", e=>{ const g=e.target.closest("[data-go]"); if(g){ path.push(g.dataset.go); draw(); return; }
    const b=e.target.closest("[data-bh]"); if(!b) return; const a=b.dataset.bh;
    if(a==="back"){ path.pop(); draw(); return; }
    m.close();
    if(a==="pins") brdAct("pins");
    else if(a==="compare") openBoardDoctor();
    else if(a==="sim"){ brdShow(false); setStage("sim"); }
    else if(a==="ask"){ const d=bhDiag(path[path.length-1], F); if(!AICHAT.open) toggleAiChat(); aiSetMode("qa");
      const t=$("#acInput"); t.value=`บอร์ดจริงมีอาการ: ${d.title} (แผ่น ${sch.name}) ต้องตรวจอะไรต่อ`; t.focus(); } });
  draw();
  return m;
}
/* entry points: the board page (next to ตรวจหาบอร์ด) and the doctor's dialog */
{
  const _ref=brdRefresh;
  brdRefresh=function(){ const r=_ref.apply(this, arguments);
    const d=$('#boardPage [data-brd="detect"]');
    if(d && !$('#boardPage [data-brd="help"]')) d.insertAdjacentHTML("afterend", ' <button class="btn" data-brd="help" title="ตอบคำถามสั้นๆ ว่าเห็นอะไรบนบอร์ด แล้วระบบหาสาเหตุจากวงจรนี้">🔧 บอร์ดไม่ทำงานเหมือนที่จำลอง?</button>');
    return r; };
  const _act=brdAct;
  brdAct=function(a){ if(a==="help") return openBoardHelp(); return _act.apply(this, arguments); };
  const _doc=openBoardDoctor;
  openBoardDoctor=function(){ const r=_doc.apply(this, arguments);
    const h=[...document.querySelectorAll(".modal-bg .bd-h")].pop();
    if(h) h.insertAdjacentHTML("beforebegin", '<div class="bd-help"><button class="btn2" data-bdh="1">🔧 ลงบอร์ดแล้วแต่ไม่ทำงานเหมือนที่จำลอง?</button></div>');
    const mb=h&&h.closest(".modal-bg"); if(mb) mb.querySelector("[data-bdh]").onclick=()=>{ mb.remove(); openBoardHelp(); };
    return r; };
}
MCP_OPS.board_troubleshoot = a=>{
  const sch=a.sheet ? mcpSheet(a.sheet) : brdSheet(), F=bhFacts(sch);
  const ids=["load","darkx","map","segpol","segan","segmap","fast","stuck","bounce","btninv"];
  if(!a.symptom) return {symptoms:ids, note:"load = cannot program · darkx = nothing reacts · map = wrong LED/switch · segpol = digit inverted · segan = wrong/all/no digit · segmap = digit shape wrong · fast = LEDs dim · stuck = counter does not move · bounce = skips counts · btninv = acts on release"};
  if(!ids.includes(a.symptom)) mcpFail(`unknown symptom '${a.symptom}'`, "one of: "+ids.join(", "));
  const d=bhDiag(a.symptom, F), txt=h=>String(h).replace(/<[^>]+>/g,"").replace(/&[a-z]+;/g," ").trim();
  return {sheet:sch.name, title:d.title, checked:d.checks.map(txt).filter(Boolean), try:d.tips.map(txt)};
};
