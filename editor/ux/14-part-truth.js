/* ===== 14. A part's truth table, one click from the Inspector ==============================
   "ทำให้กดดูตารางความจริงได้": select a part (COMPM4, a MUX, a decoder, a gate, a sub-sheet
   block…) and "📋 ตารางความจริง" shows what it does. The part is copied onto a scratch sheet
   with an INPUT on every input pin and an OUTPUT on every output pin, and run through the same
   browser simulator the sim page uses — so the table is exactly how the design will simulate.
   Flip-flops have no truth table (their output depends on the clock and what they hold). */
const PART_TT_MAX_BITS = 10;          // 1024 rows is still readable in a scroll box
function partTruthTable(c){
  if(!c || c.type==="JUNCTION" || c.type==="IN" || c.type==="OUT") return {ok:false, reason:"เลือกชิ้นส่วนที่มีขาเข้าและขาออก"};
  if(PROBE_SEQ[c.type]) return {ok:false, reason:"flip-flop ไม่มีตารางความจริงแบบวงจรผสม — ค่าออกขึ้นกับ clock และค่าที่เก็บไว้ ดูได้ในหน้า จำลอง (ไทม์มิง)"};
  let ports=[]; try{ ports=getPorts(c); }catch(_){}
  // a numbered group reads as a number: A3 A2 A1 A0, then B3 … B0 (MSB first, like the rows)
  const msbFirst=L=>{ const key=p=>String(p.label||p.id), m=p=>/^(.*?)(\d+)$/.exec(key(p));
    const order=[]; L.forEach(p=>{ const g=m(p)?m(p)[1]:key(p); if(!order.includes(g)) order.push(g); });
    return L.slice().sort((a,b)=>{ const ga=m(a)?m(a)[1]:key(a), gb=m(b)?m(b)[1]:key(b);
      if(ga!==gb) return order.indexOf(ga)-order.indexOf(gb);
      return (m(b)?+m(b)[2]:0)-(m(a)?+m(a)[2]:0); }); };
  const ins=msbFirst(ports.filter(p=>p.dir==="in")), outs=msbFirst(ports.filter(p=>p.dir==="out"));
  if(!ins.length || !outs.length) return {ok:false, reason:"ชิ้นส่วนนี้ไม่มีขาเข้าหรือขาออก"};
  const bits=ins.reduce((n,p)=>n+Math.max(1,p.width||1),0);
  if(bits>PART_TT_MAX_BITS) return {ok:false, reason:`ขาเข้ารวม ${bits} บิต = ${2**bits} แถว มากเกินกว่าจะแสดงเป็นตาราง (สูงสุด ${PART_TT_MAX_BITS} บิต) — ลองใช้โหมดตรวจค่า 🔬 ป้อนค่าทีละชุดแทน`};
  const pinName=p=>String(p.label||p.id).replace(/\(.*\)$/,"");
  const scratch={id:"__tt", name:"__tt", components:[], wires:[]};
  const part=JSON.parse(JSON.stringify(c)); part.id="__ttp"; part.x=400; part.y=200; scratch.components.push(part);
  ins.forEach((p,k)=>{ const id="__tti"+k; scratch.components.push({id, type:"IN", x:100, y:100+k*44, label:"", params:{name:pinName(p), width:Math.max(1,p.width||1)}});
    scratch.wires.push({id:"__ttw"+id, from:{cid:id, pid:"o"}, to:{cid:part.id, pid:p.id}, name:""}); });
  outs.forEach((p,k)=>{ const id="__tto"+k; scratch.components.push({id, type:"OUT", x:700, y:100+k*44, label:"", params:{name:pinName(p), width:Math.max(1,p.width||1)}});
    scratch.wires.push({id:"__ttw"+id, from:{cid:part.id, pid:p.id}, to:{cid:id, pid:"i"}, name:""}); });
  const r=clientCombSim(scratch);
  if(!r.ok) return {ok:false, reason:r.reason||"จำลองชิ้นส่วนนี้ไม่ได้"};
  return {ok:true, table:r.truth_table};
}
function partTruthShow(c){
  const r=partTruthTable(c), name=(c.label||compDisplay(c));
  if(!r.ok){ toast(r.reason, "warn", 5000); return; }
  const T=r.table;
  const head=`<tr>${T.inputs.map(n=>`<th class="in">${esc(n)}</th>`).join("")}<th class="sep"></th>${T.outputs.map(n=>`<th class="out">${esc(n)}</th>`).join("")}</tr>`;
  const body=T.rows.map(([a,b])=>`<tr>${a.map(v=>`<td class="${v?"one":""}">${v}</td>`).join("")}<td class="sep"></td>${b.map(v=>`<td class="o ${v?"one":""}">${v}</td>`).join("")}</tr>`).join("");
  uxModal(`📋 ตารางความจริง — ${esc(name)}`,
    `<div class="muted" style="margin-bottom:6px">${T.rows.length} แถว · อินพุตตัวแรกเป็นบิตสูงสุด (MSB) · คำนวณด้วยตัวจำลองเดียวกับหน้า จำลอง</div>
     <div class="part-tt"><table>${head}${body}</table></div>`, {width:Math.min(900, 120+(T.inputs.length+T.outputs.length)*46)});
}
{
  const _insp = renderInspector;
  renderInspector = function(){
    const r = _insp.apply(this, arguments);
    try{
      const sch=activeSch(); if(!sch) return r;
      const sel=sch.components.filter(c=>state.selection.has(c.id));
      if(sel.length!==1) return r;
      const c=sel[0];
      if(c.type==="JUNCTION"||c.type==="IN"||c.type==="OUT"||c.type==="VCC"||c.type==="GND"||c.type==="CONST"||c.type==="BUSTAP") return r;
      const del=document.querySelector('#inspectorPane [data-act="delete-sel"]'); if(!del) return r;
      const row=document.createElement("div"); row.className="row";
      row.innerHTML=`<label>ตารางความจริง</label><button class="btn" id="iTruth" title="ดูว่าชิ้นส่วนนี้ให้ค่าออกอะไร ในทุกกรณีของขาเข้า">📋 ดูตารางความจริง</button>`;
      del.closest(".row").before(row);
      row.querySelector("#iTruth").onclick=()=>partTruthShow(c);
    }catch(e){ console.warn("truth table", e); }
    return r;
  };
}
