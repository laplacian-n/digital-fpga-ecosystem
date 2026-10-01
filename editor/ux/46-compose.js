/* ===== 46. "Make Y out of N × X": a composition is built from blocks, not taken from the library ====
   Found while generating training data: partFromMessage read "เอาตัวบวก 4 บิต 2 ตัวมาต่อเป็นตัวบวก 8 บิต"
   as a 4-bit adder, "ต่อ mux 2:1 สามตัวเป็น mux 4:1" as a 2:1 mux and "ต่อ full adder แบบ ripple carry
   2 ตัว" as one full adder — and the agent's fast path / build mode drew that part at once. The user
   asked for the structure (a lab exercise in cascading blocks), and the size was wrong as well.
   Now a request that names how many blocks to use is a composition:
     - the target (the words after "เป็น", "ตัวบวก 8 บิต") is what partFromMessage reads — so the oracle
       (36) derives the right acceptance test;
     - nothing is built before the model: the agent wires the blocks with build_hierarchy (the prompt
       says so), build mode leaves it to the model. */
const COMPOSE_N = "(?:\\d+|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด)";
function composeTarget(msg){
  const t=String(msg||"");
  const many=new RegExp(COMPOSE_N+"\\s*ตัว").test(t) || /\b(?:two|three|four|eight|\d+)\s+(?:full|half|mux|adders?|blocks?)/i.test(t);
  const build=/(ต่อ|ใช้|จาก|ประกอบ|cascade|ripple|\bfrom\b|\busing\b)/i.test(t);
  if(!many || !build) return null;
  // "… ต่อเป็น Y", "… into Y" — or "ประกอบ / สร้าง Y จาก X N ตัว", "Y from N X"
  // "… ต่อเป็น Y", "… N ตัวสร้าง / ทำ Y", "… into Y" — or "ประกอบ / สร้าง Y จาก X N ตัว", "Y from N X";
  // a sheet named at the end ("ลงแผ่น lab6") is not part of Y
  const u=t.replace(/\s*(?:ลง|บน|ใส่ใน|ไว้ใน|ใน)?\s*(?:ตั้งชื่อ)?\s*(?:แผ่น|ชีต|ชีท|sheet)\s*(?:ชื่อ|ว่า)?\s*[`"'“]?[A-Za-z_]\w*[`"'”]?\s*$/i, "");
  const m=/(?:มา)?(?:ต่อ)?(?:กัน)?เป็น\s*(.+)$/.exec(u) || /ตัว\s*(?:มา)?(?:สร้าง|ทำ|ประกอบ)(?:เป็น)?\s*(.+)$/.exec(u)
       || /\b(?:into|to make|as)\s+(?:an?\s+)?(.+)$/i.exec(u)
       || /^(?:ช่วย)?(?:ประกอบ|สร้าง|ทำ|ออกแบบ)\s*(.+?)\s*(?:จาก|โดยใช้|ด้วย)/.exec(u) || /^(?:build|make)\s+(?:an?\s+)?(.+?)\s+(?:from|using|out of)\b/i.exec(u);
  return {target: m ? m[1].trim() : null};
}
{
  const _pfm=partFromMessage;
  partFromMessage=function(msg){
    const c=composeTarget(msg);
    if(!c) return _pfm.apply(this, arguments);
    if(!c.target) return null;                     // "ต่อ full adder 2 ตัว": no target named — the model decides
    const r=_pfm.call(this, c.target);
    return r ? Object.assign({}, r, {simple:false, compose:true}) : null;
  };
  const _fast=aiagFastPath;
  aiagFastPath=async function(msg, run){
    const c=composeTarget(msg);
    if(c) return {note:"\n\n(system) This request asks for a structure made of blocks"+(c.target?` (the result: ${c.target})`:"")
      +": place each block as a library part in ONE build_hierarchy call (blocks + top ports + connections by name) — do not build_part the whole thing."};
    return _fast.apply(this, arguments);
  };
}
