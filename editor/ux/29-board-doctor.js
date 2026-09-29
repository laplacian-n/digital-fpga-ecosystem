/* ===== 29. Board doctor: what will go wrong on the real board, before a 1-minute Vivado build =====
   The mistakes that only show on the board, where a beginner cannot see why: a port without a
   pin, two ports on one pin, an input on an LED, segments written active-high for this common-
   anode display (every digit shows inverted), no digit enabled, a clock from a bouncing push
   button, a counter on the raw 50 MHz clock (too fast to see). Plus "เทียบกับบอร์ด": flip the
   mapped switches and see the LEDs and digits the design will light (combinational sheets).
   Button on the ลงบอร์ด page and on the pin summary; MCP board_check. */
const BDOC = {};
/* one bit's value out of mcpEvalOuts (number for 1-bit, MSB-first string for a bus) */
function bdocBit(outs, name, bit){
  const v=outs[name]; if(v==null||v==="undriven") return null;
  if(bit==null) return typeof v==="string" ? (v.slice(-1)==="1"?1:0) : (+v?1:0);
  const s=String(v); return s[s.length-1-bit]==="1"?1:0;
}
function bdocOutName(sch, port){
  const c=sch.components.find(x=>x.type==="OUT" && sanId(x.params.name)===port) || sch.components.find(x=>x.type==="OUT" && String(x.params.name).toLowerCase()===String(port).toLowerCase());
  return c ? c.params.name : port;
}
function bdocInName(sch, port){
  const c=sch.components.find(x=>x.type==="IN" && sanId(x.params.name)===port) || sch.components.find(x=>x.type==="IN" && String(x.params.name).toLowerCase()===String(port).toLowerCase());
  return c ? c.params.name : port;
}
/* the input combinations the checks look at: all of them up to 10 bits, else 256 random ones */
function bdocVectors(sch){
  const ins=sch.components.filter(c=>c.type==="IN").map(c=>({name:c.params.name, w:probeWidth(c,"o")||1}));
  const bits=ins.reduce((s,i)=>s+i.w,0), n=bits<=10 ? 1<<bits : 256, out=[];
  for(let r=0;r<n;r++){ let k=bits<=10 ? r : Math.floor(Math.random()*2**Math.min(bits,30)); const v={};
    ins.slice().reverse().forEach(i=>{ const m=2**i.w; v[i.name]=String(k%m); k=Math.floor(k/m); }); out.push(v); }
  return out;
}
function boardDoctor(sch){
  sch=sch||brdSheet(); const F=[];
  const add=(lvl,title,why,fix,act)=>F.push({lvl,title,why,fix:fix||"",act:act||null});
  const bits=uxPortBits(sch).map(b=>Object.assign({t:uxPinTarget(b, sch)}, b));
  if(!bits.length){ add("err","แผ่นนี้ไม่มี INPUT / OUTPUT","บอร์ดคุยกับวงจรผ่านขาเข้า/ออกเท่านั้น","วาง INPUT (สวิตช์/ปุ่ม) และ OUTPUT (LED/7-seg)"); return F; }
  // --- pins ---
  const miss=bits.filter(b=>!b.t);
  if(miss.length) add("err",`ยังไม่ได้เลือกขา ${miss.length} ขา: ${miss.slice(0,6).map(b=>b.key).join(", ")}${miss.length>6?" …":""}`,
    "Vivado ต้องรู้ว่าทุกขาของวงจรต่อกับอะไรบนบอร์ด ไม่งั้น build ไม่ผ่าน","ไปหน้าเลือกขา แล้วกด “เดาขาให้” หรือเลือกเอง","pins");
  const byT={}; bits.filter(b=>b.t).forEach(b=>(byT[b.t]=byT[b.t]||[]).push(b.key));
  Object.entries(byT).filter(([,ks])=>ks.length>1).forEach(([t,ks])=>
    add("err",`${ks.join(" กับ ")} ใช้ขาเดียวกัน (${pinTargetLabel(t)})`,"ขาจริงหนึ่งขาต่อได้กับสัญญาณเดียว — Vivado จะ error","เปลี่ยนขาของตัวใดตัวหนึ่ง","pins"));
  bits.filter(b=>b.t).forEach(b=>{ const k=b.t.split(":")[0];
    if(b.dir==="in" && ["led","seg","an","buzzer"].includes(k)) add("err",`INPUT ${b.key} ต่อกับ ${pinTargetLabel(b.t)}`,"LED / 7-seg เป็นของที่บอร์ด “แสดง” — รับค่าจากมันไม่ได้","ให้ INPUT ใช้สวิตช์ (SW) หรือปุ่ม","pins");
    if(b.dir==="out" && ["sw","pb","clk"].includes(k)) add("err",`OUTPUT ${b.key} ต่อกับ ${pinTargetLabel(b.t)}`,"สวิตช์/ปุ่ม/นาฬิกาเป็นของที่ “ส่งค่าเข้า” วงจร — ส่งออกไปไม่ได้","ให้ OUTPUT ใช้ LED หรือ 7-seg","pins"); });
  // --- the circuit itself (its own errors make the board meaningless too) ---
  try{ explainSim(sch).filter(x=>x.lvl==="err").slice(0,4).forEach(x=>add("err","วงจร: "+x.title, x.why, x.fix, "sim")); }catch(_){}
  let flat=null; try{ flat=flattenSchematic(sch).sch; }catch(_){}
  if(!flat) return F;
  const st=probeStruct(flat), ffs=flat.components.filter(c=>PROBE_SEQ[c.type]);
  const segs=bits.filter(b=>b.dir==="out" && /^seg:[a-g]$/.test(b.t||"")), ans=bits.filter(b=>b.dir==="out" && /^an:\d$/.test(b.t||""));
  const leds=bits.filter(b=>b.dir==="out" && /^led:/.test(b.t||""));
  // --- 7-segment: polarity and digit select ---
  if(segs.length && !ans.length) add("warn","ใช้ 7-seg แต่ไม่ได้กำหนดขาเลือกหลัก (an0–an3)",
    "จอ 4 หลักบนบอร์ดเปิดทีละหลักด้วยขา an (active-low: 0 = ติด) — ถ้าไม่ได้ขับไว้ หลักอาจไม่ติดเลย",
    "เพิ่ม OUTPUT ชื่อ an0 ต่อกับ GND (เปิดหลักขวาสุด) แล้วเลือกขาเป็น “หลัก 0”");
  if(!ffs.length && (segs.length || ans.length)){
    let hi=0, lo=0, anOff=0, n=0;
    const vecs=bdocVectors(sch);
    vecs.forEach(v=>{ let outs; try{ outs=mcpEvalOuts(sch, flat, st, v); }catch(_){ return; } n++;
      if(segs.length>=7){ const pat="abcdefg".split("").map(s=>{ const b=segs.find(x=>x.t==="seg:"+s); return b?bdocBit(outs, bdocOutName(sch,b.port), b.bit):null; });
        if(!pat.includes(null)){ const on=pat.join(""), off=pat.map(x=>1-x).join("");
          for(let d=0; d<10; d++){ const want="abcdefg".split("").map(s=>SEG7[s][d]).join("");
            if(on===want) hi++; if(off===want) lo++; } } }
      if(ans.length && ans.every(b=>bdocBit(outs, bdocOutName(sch,b.port), b.bit)===1)) anOff++; });
    if(hi>=2 && hi>lo) add("err","7-seg เขียนแบบ active-high แต่จอบนบอร์ดเป็น common-anode (active-low)",
      `ในตารางของวงจรนี้ ${hi} แถวออกมาเป็นรูปตัวเลขเมื่อ “1 = ติด” — บนบอร์ด 0 คือติด ตัวเลขจึงจะกลับด้าน (ส่วนที่ควรดับกลับติด)`,
      "ใช้ชิ้นส่วน BCD → 7-segment แบบ active-low หรือใส่ NOT ที่ขา a–g ทุกขา","seg");
    if(n && anOff===n) add("err","ขาเลือกหลัก (an) เป็น 1 ตลอด — ทุกหลักดับ",
      "an เป็น active-low: 1 = ปิดหลักนั้น","ต่อ an ของหลักที่ต้องการให้ติดกับ GND");
  }
  // --- clocks ---
  const clkIns=new Set(); try{ const m=probeModel(flat, st);
    ffs.forEach(c=>{ const s=m.source(c.id,"clk"); if(s&&s.type==="IN") clkIns.add(s.cid); }); }catch(_){}
  clkIns.forEach(cid=>{ const c=sch.components.find(x=>x.id===cid); if(!c) return;
    const b=bits.find(x=>x.port===sanId(c.params.name)&&x.bit==null)||{}, t=b.t||"";
    if(/^pb:/.test(t)) add("warn",`นาฬิกา ${c.params.name} มาจากปุ่มกด`,
      "หน้าสัมผัสปุ่มเด้ง (bounce) — กดหนึ่งครั้งอาจได้ขอบขาขึ้นหลายสิบครั้ง ตัวนับจะกระโดดข้ามหลายค่า",
      "ใช้นาฬิกา 50 MHz + ตัวหารความถี่ แล้วใช้ปุ่มเป็น enable ผ่านชิ้นส่วน Debounce (แท็บ Modules ▸ ชิ้นส่วน)");
    else if(/^sw:/.test(t)) add("info",`นาฬิกา ${c.params.name} มาจากสวิตช์เลื่อน`,
      "ใช้ทดสอบทีละ clock ได้ แต่สวิตช์ก็เด้งได้บ้าง ถ้านับข้ามบางครั้งเป็นเพราะเรื่องนี้","");
    else if(t==="clk" && ffs.length<20 && (leds.length||segs.length)) add("warn",`วงจรใช้นาฬิกา 50 MHz ตรงๆ (มี flip-flop ${ffs.length} ตัว)`,
      "ค่าเปลี่ยน 50 ล้านครั้งต่อวินาที — ตาเห็น LED ติดสลัวๆ ค้าง ไม่เห็นการนับ",
      "ถ้าอยากเห็นการนับ ใส่ตัวหารความถี่ (เช่น ÷50000000 = 1 Hz) ระหว่าง clk กับวงจร — แท็บ Modules ▸ ชิ้นส่วน ▸ หารความถี่");
  });
  if(BRD.tools){ if(!BRD.tools.vivado) add("info","ยังไม่พบ Vivado","สร้าง .bit ไม่ได้จนกว่าจะติดตั้ง/ตั้งที่อยู่ของ Vivado","หน้า Home ▸ เริ่มต้นใช้งาน");
    if(!BRD.tools.openfpgaloader) add("info","ยังไม่พบ openFPGALoader","โหลดลงบอร์ดไม่ได้","ติดตั้งโปรแกรมรุ่นเต็ม (มี openFPGALoader มาด้วย)"); }
  return F;
}

/* ---------- "เทียบกับบอร์ด": the mapped switches → the LEDs and digits this design lights ---------- */
function bdocSegSvg(on){   // on = [a..g] true = lit
  const S={a:"M8 4h24",b:"M34 6v24",c:"M34 34v24",d:"M8 60h24",e:"M6 34v24",f:"M6 6v24",g:"M8 32h24"};
  return `<svg viewBox="0 0 40 64" width="34" height="54">${"abcdefg".split("").map((s,i)=>`<path d="${S[s]}" stroke="${on[i]?"#ff3b30":"rgba(128,128,128,.18)"}" stroke-width="5" stroke-linecap="round"/>`).join("")}</svg>`;
}
function bdocPreviewHtml(sch){
  const flat=flattenSchematic(sch).sch;
  if(flat.components.some(c=>PROBE_SEQ[c.type])) return `<p class="muted">วงจรนี้มี flip-flop — ใช้ “⚡ เล่นเวลาจริง (50 MHz)” ในหน้าจำลอง จะเห็นเหมือนบอร์ดจริง รวมถึงความเร็ว</p><button class="btn2" data-bd="sim">ไปหน้าจำลอง</button>`;
  const bits=uxPortBits(sch).map(b=>Object.assign({t:uxPinTarget(b, sch)}, b));
  const ins=bits.filter(b=>b.dir==="in" && /^(sw|pb):/.test(b.t||""));
  if(!ins.length && !bits.some(b=>b.dir==="out"&&b.t)) return `<p class="muted">เลือกขาก่อน แล้วค่อยเทียบ</p>`;
  BDOC.vals=BDOC.vals||{};
  const outs=(()=>{ const v={}; sch.components.filter(c=>c.type==="IN").forEach(c=>{ const w=probeWidth(c,"o")||1; let n=0;
      bits.filter(b=>b.dir==="in"&&b.port===sanId(c.params.name)).forEach(b=>{ if(BDOC.vals[b.key]) n+=2**(b.bit==null?0:b.bit); }); v[c.params.name]=String(n); });
    try{ return mcpEvalOuts(sch, flat, probeStruct(flat), v); }catch(_){ return {}; } })();
  const val=b=>bdocBit(outs, bdocOutName(sch,b.port), b.bit);
  const sw=ins.map(b=>`<label class="bd-sw ${BDOC.vals[b.key]?"on":""}"><input type="checkbox" data-bdin="${esc(b.key)}" ${BDOC.vals[b.key]?"checked":""}><span>${esc(pinTargetLabel(b.t).split(" (")[0])}</span><b>${esc(b.key)}</b></label>`).join("");
  const leds=bits.filter(b=>b.dir==="out"&&/^led:/.test(b.t||"")).sort((x,y)=>+y.t.slice(4)-+x.t.slice(4));
  const ledHtml=leds.map(b=>`<span class="bd-led ${val(b)===1?"on":""}" title="${esc(b.key)}"><i></i>${esc(b.key)}</span>`).join("");
  const segs=bits.filter(b=>b.dir==="out"&&/^seg:[a-g]$/.test(b.t||"")), ans=bits.filter(b=>b.dir==="out"&&/^an:\d$/.test(b.t||""));
  let segHtml="";
  if(segs.length){
    const lit="abcdefg".split("").map(s=>{ const b=segs.find(x=>x.t==="seg:"+s); return b ? val(b)===0 : false; });   // active-low
    const digitOn=d=>{ if(!ans.length) return d===0; const b=ans.find(x=>x.t==="an:"+d); return b ? val(b)===0 : false; };
    segHtml=`<div class="bd-segs">${[3,2,1,0].map(d=>`<div class="bd-dig">${bdocSegSvg(digitOn(d)?lit:[])}</div>`).join("")}</div>`
      +(ans.length?"":`<div class="muted">ไม่ได้ขับขา an — ภาพนี้สมมติว่าหลักขวาสุดติด</div>`);
  }
  return `<div class="bd-row"><div class="muted">สวิตช์/ปุ่มที่ใช้ (คลิกเพื่อสลับ)</div><div class="bd-sws">${sw||'<span class="muted">—</span>'}</div></div>
    ${ledHtml?`<div class="bd-row"><div class="muted">LED</div><div class="bd-leds">${ledHtml}</div></div>`:""}
    ${segHtml?`<div class="bd-row"><div class="muted">7-segment (0 = ติด ตามบอร์ดจริง)</div>${segHtml}</div>`:""}`;
}
function openBoardDoctor(){
  const sch=brdSheet(), F=boardDoctor(sch);
  const icon={err:"⛔",warn:"⚠",info:"ℹ"}, errs=F.filter(f=>f.lvl==="err").length;
  const m=uxModal("🩺 ตรวจก่อนลงบอร์ด — "+esc(sch.name), `
    <div class="bd-sum ${errs?"bad":F.length?"warn":"ok"}">${errs?`พบ ${errs} เรื่องที่ต้องแก้ก่อน build`:F.length?"ไม่มีเรื่องร้ายแรง — ลองอ่านข้อสังเกตด้านล่าง":"✓ ไม่พบปัญหา — สร้าง .bit ได้เลย"}</div>
    <div class="bd-list">${F.map(f=>`<div class="bd-f ${f.lvl}"><div class="bd-t">${icon[f.lvl]} ${esc(f.title)}</div><div class="muted">${esc(f.why)}</div>
      ${f.fix?`<div class="bd-fix">→ ${esc(f.fix)}${f.act==="pins"?' <button class="btn2" data-bd="pins">ไปเลือกขา</button>':f.act==="sim"?' <button class="btn2" data-bd="sim">ไปหน้าจำลอง</button>':""}</div>`:""}</div>`).join("")}</div>
    <h3 class="bd-h">เทียบกับบอร์ด</h3><div id="bdPrev"></div>`, {width:760});
  const draw=()=>{ const el=m.querySelector("#bdPrev"); try{ el.innerHTML=bdocPreviewHtml(sch); }catch(e){ el.innerHTML=`<p class="muted">${esc(e.message)}</p>`; } };
  m.addEventListener("change", e=>{ const cb=e.target.closest("[data-bdin]"); if(!cb) return; BDOC.vals[cb.dataset.bdin]=cb.checked; draw(); });
  m.addEventListener("click", e=>{ const b=e.target.closest("[data-bd]"); if(!b) return; m.close();
    if(b.dataset.bd==="pins") brdAct("pins"); else if(b.dataset.bd==="sim"){ brdShow(false); setStage("sim"); } });
  draw();
  return F;
}
/* on the ลงบอร์ด page: a button in step 1, and a one-line verdict under the pins */
{
  const _ref=brdRefresh;
  brdRefresh=function(){
    const r=_ref.apply(this, arguments);
    const h=$("#boardPage .brd-card h3 [data-brd=pins]");
    if(h && !h.parentNode.querySelector("[data-brd=doctor]")) h.insertAdjacentHTML("afterend", ' <button class="btn2" data-brd="doctor" title="หาเรื่องที่จะพังบนบอร์ดจริง ก่อนเสียเวลา build">🩺 ตรวจก่อนลงบอร์ด</button>');
    try{ const F=boardDoctor(brdSheet()), e=F.filter(f=>f.lvl==="err").length, w=F.filter(f=>f.lvl==="warn").length, el=$("#brdWarn");
      if(el && (e||w)) el.insertAdjacentHTML("afterbegin", `<div class="bd-line ${e?"bad":"warn"}">🩺 ${e?`พบ ${e} เรื่องที่จะพังบนบอร์ด`:""}${e&&w?" · ":""}${w?`ข้อควรระวัง ${w} เรื่อง`:""} <button class="btn2" data-brd="doctor">ดู</button></div>`); }catch(_){}
    return r;
  };
  const _act=brdAct;
  brdAct=function(a){ if(a==="doctor") return openBoardDoctor(); return _act.apply(this, arguments); };
}
MCP_OPS.board_check = a=>{
  const sch=a.sheet ? mcpSheet(a.sheet) : brdSheet();
  const F=boardDoctor(sch);
  return {sheet:sch.name, errors:F.filter(f=>f.lvl==="err").length, findings:F.map(f=>({level:f.lvl, title:f.title, why:f.why, fix:f.fix}))};
};
