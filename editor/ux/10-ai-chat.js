/* ===== 10. AI chat: questions about the drawing =========================================
   "นี่วงจรอะไร" used to fall through to the build pipeline and come back REJECTED. A question
   about the sheet is now answered in the editor, without a model: simulate it, recognise the
   usual lab circuits (gates, adders, mux, decoder, comparator, 7-seg, counters, registers), or
   give the minimised equation of every output. Free-form questions still go to the model;
   when no model is running the reply says where to start one (Settings ▸ โมเดล AI). */
function uxTTcols(tt){
  const n=tt.inputs.length, cols=tt.outputs.map(()=>Array(1<<n).fill("0"));
  tt.rows.forEach(([ins,outs])=>{ const r=ins.reduce((a,v)=>a*2+(+v?1:0),0); outs.forEach((v,k)=>cols[k][r]=+v?"1":"0"); });
  return cols.map(c=>c.join(""));
}
/* value of input i (first input = MSB) in row r */
const uxBit=(r,i,n)=>(r>>(n-1-i))&1;
function uxRecognize(tt){
  const n=tt.inputs.length, m=tt.outputs.length, cols=uxTTcols(tt), N=1<<n;
  const fn=f=>{ let s=""; for(let r=0;r<N;r++) s+=f(r)?"1":"0"; return s; };
  const has=c=>cols.includes(c);
  const G2={"0001":"AND","0111":"OR","0110":"XOR","1110":"NAND","1000":"NOR","1001":"XNOR"};
  if(n===1&&m===1) return cols[0]==="10"?"NOT (กลับค่า)":cols[0]==="01"?"บัฟเฟอร์ (ส่งค่าผ่าน)":"";
  if(n===2&&m===1&&G2[cols[0]]) return "เกต "+G2[cols[0]];
  if(n===2&&m===2&&has("0110")&&has("0001")) return "Half Adder (ตัวบวกครึ่ง) — sum = a XOR b, carry = a AND b";
  if(n===2&&m===2&&has("0110")&&(has("0100")||has("0010"))) return "Half Subtractor (ตัวลบครึ่ง) — diff = a XOR b, borrow";
  const par=fn(r=>{ let p=0; for(let i=0;i<n;i++) p^=uxBit(r,i,n); return p; });
  const maj=fn(r=>{ let c=0; for(let i=0;i<n;i++) c+=uxBit(r,i,n); return c>=2; });
  if(n===3&&m===2&&has(par)&&has(maj)) return "Full Adder (ตัวบวกเต็ม) — sum = a⊕b⊕cin, cout = ค่าส่วนใหญ่ของ 3 อินพุต";
  if(m===1&&n>=3&&cols[0]===par) return `วงจรตรวจ parity ${n} บิต (XOR ทุกอินพุต — ได้ 1 เมื่อจำนวน 1 เป็นเลขคี่)`;
  if(m===1&&n===3&&cols[0]===maj) return "วงจรเสียงข้างมาก (majority) 3 อินพุต";
  // multiplexer: k select lines + 2^k data lines, out = data[sel] for some choice of lines
  for(let k=1;k<=3;k++){ if(m!==1 || n!==k+(1<<k)) continue;
    const perms=(a,s)=>{ if(!a.length) return [s]; return a.flatMap((x,i)=>perms(a.slice(0,i).concat(a.slice(i+1)), s.concat([x]))); };
    const idx=[...Array(n).keys()];
    const choose=(arr,kk)=>kk===0?[[]]:arr.flatMap((x,i)=>choose(arr.slice(i+1),kk-1).map(c=>[x].concat(c)));
    for(const sel of choose(idx,k)) for(const sp of perms(sel,[])){ const data=idx.filter(i=>!sel.includes(i));
      if(cols[0]===fn(r=>{ let s=0; sp.forEach(i=>s=s*2+uxBit(r,i,n)); return uxBit(r,data[s],n); }))
        return `Multiplexer ${1<<k}:1 — เลือกส่ง ${data.map(i=>tt.inputs[i]).join("/")} ออกตามขาเลือก ${sp.map(i=>tt.inputs[i]).join(",")}`;
      for(const dp of perms(data,[])) if(cols[0]===fn(r=>{ let s=0; sp.forEach(i=>s=s*2+uxBit(r,i,n)); return uxBit(r,dp[s],n); }))
        return `Multiplexer ${1<<k}:1 — เลือกอินพุตข้อมูลออกตามขาเลือก ${sp.map(i=>tt.inputs[i]).join(",")}`; } }
  // decoder: every output is 1 in exactly one row, all different rows
  if(m===N && n<=4){ const one=cols.map(c=>c.indexOf("1")); if(cols.every((c,k)=>c.split("1").length===2) && new Set(one).size===m) return `Decoder ${n}→${m} (ตัวถอดรหัส — เปิดเอาต์พุตทีละขาตามเลขอินพุต)`; }
  if(m===N && n<=4){ const one=cols.map(c=>c.indexOf("0")); if(cols.every(c=>c.split("0").length===2) && new Set(one).size===m) return `Decoder ${n}→${m} แบบ active-low`; }
  // comparator A vs B (first half vs second half of the inputs)
  if(n%2===0 && n<=8){ const h=n/2, A=r=>r>>h, B=r=>r&((1<<h)-1);
    const eq=fn(r=>A(r)===B(r)), gt=fn(r=>A(r)>B(r)), lt=fn(r=>A(r)<B(r));
    const hits=[eq,gt,lt].filter(has).length;
    if(hits>=1 && cols.every(c=>c===eq||c===gt||c===lt)) return `ตัวเปรียบเทียบ ${h} บิต (${tt.inputs.slice(0,h).join("")} กับ ${tt.inputs.slice(h).join("")}: `+[has(eq)&&"เท่ากัน",has(gt)&&"มากกว่า",has(lt)&&"น้อยกว่า"].filter(Boolean).join(" / ")+")"; }
  if(typeof simDetectSeg==="function" && simDetectSeg(tt.outputs)) return `ตัวถอดรหัส 7-segment (${n} บิตเข้า → ขา a–g)`;
  return "";
}
function uxEquations(tt){
  const n=tt.inputs.length; if(n>6) return [];
  const cols=uxTTcols(tt), rows={}; tt.outputs.forEach((o,k)=>rows[o]=cols[k].split(""));
  try{ const r=ttToIntent(tt.inputs, tt.outputs, rows, "q"); return r.error?[]:tt.outputs.map(o=>`${o} = ${r.exprs[o]}`); }catch(_){ return []; }
}
function uxPartsSummary(sch){
  const cnt={}; (sch.components||[]).forEach(c=>{ if(["IN","OUT","JUNCTION"].includes(c.type)) return;
    const sub=/^(SCH|CUSTOM):/.test(String(c.type))&&typeof subSchOf==="function"?subSchOf(c):null;
    const t=sub?("บล็อก "+sub.name):((TYPES[c.type]&&TYPES[c.type].label)||c.type); cnt[t]=(cnt[t]||0)+1; });
  return Object.entries(cnt).map(([t,k])=>k>1?`${t} ×${k}`:t).join(", ");
}
function uxDescribeSheet(sch){
  const nm=c=>(c.params&&c.params.name)||c.id;
  const ins=sch.components.filter(c=>c.type==="IN").map(nm), outs=sch.components.filter(c=>c.type==="OUT").map(nm);
  let h=`<span class="ac-badge v">แผ่น ${esc(sch.name)}</span><br>`;
  const hasFF=flattenSchematic(sch).sch.components.some(c=>PROBE_SEQ[c.type]);
  if(hasFF){
    let j=null; try{ j=clientSeqSim(sch, 16); }catch(_){}
    const sq=j&&j.ok&&j.sequence;
    let what="วงจรที่ทำงานตาม clock (sequential)";
    if(sq){
      const ord=sq.outputs.map((o,i)=>({o,i})).sort((a,b)=>natCmp(a.o,b.o));     // q0 = LSB
      const val=r=>ord.reduce((a,x,p)=>a+(r[3][x.i]<<p),0);
      const vals=sq.rows.map(val);
      if(!sq.inputs.length && new Set(vals).size>2){
        let p=vals.slice(1).indexOf(vals[0])+1; if(p<=0) p=vals.length;
        what=`ตัวนับ ${new Set(vals.slice(0,p)).size} สถานะ — ${vals.slice(0,Math.min(p,12)).join(" → ")}${p<=12?" → วนซ้ำ":" …"}`;
      } else if(sq.inputs.length){
        const ids=sq.inputIds||[]; let reg=false;
        try{ const hi={}; ids.forEach(id=>hi[id]=1); const j1=clientSeqSim(sch, 3, {hold:hi});
          reg=j1.ok && j1.sequence.rows[0][3].every(v=>!v) && j1.sequence.rows[1][3].length===sq.outputs.length && j1.sequence.rows[1][3].every(v=>v===1); }catch(_){}
        if(reg && sq.inputs.length===sq.outputs.length) what=`Register ${sq.outputs.length} บิต — เก็บค่า ${sq.inputs.join(", ")} ไว้ที่ ${sq.outputs.join(", ")} ทุกขอบขาขึ้นของ clock`;
      }
    }
    h+=`<b>${esc(what)}</b><br><span class="ac-hint">flip-flop ${sq?sq.dffs.length:"?"} ตัว · อินพุต ${esc(ins.join(", ")||"—")} · เอาต์พุต ${esc(outs.join(", ")||"—")}</span>`;
    h+=`<div class="ac-hint" style="margin-top:6px">ลองดูการทำงานได้ที่ปุ่ม <b>จำลอง</b> — กดสวิตช์แล้ว “ก้าว 1 clock”</div>`;
    return h;
  }
  const j=clientCombSim(sch);
  if(!j.ok || !j.truth_table){ return h+`ยังจำลองวงจรนี้ไม่ได้: ${esc(j.reason||"ต่อสายไม่ครบ")}<br><span class="ac-hint">ประกอบด้วย ${esc(uxPartsSummary(sch)||"—")}</span>`; }
  const tt=j.truth_table, name=uxRecognize(tt), eqs=uxEquations(tt);
  h+=name?`<b>${esc(name)}</b><br>`:`<b>วงจร combinational ${tt.inputs.length} อินพุต → ${tt.outputs.length} เอาต์พุต</b><br>`;
  h+=`<span class="ac-hint">อินพุต ${esc(tt.inputs.join(", "))} · เอาต์พุต ${esc(tt.outputs.join(", "))} · ใช้ ${esc(uxPartsSummary(sch)||"—")}</span>`;
  if(eqs.length) h+=`<div style="margin-top:6px">${eqs.slice(0,8).map(e=>`<code>${esc(e)}</code>`).join("<br>")}${eqs.length>8?"<br>…":""}</div>`;
  if(tt.inputs.length<=4) h+=aiTruthTableHtml(tt);
  return h;
}
function uxAboutSheet(msg){
  return /(วงจร|แผ่น|circuit)\s*(นี้|นี่)|นี่(คือ)?(วงจร|อะไร)|วงจรอะไร|ทำหน้าที่|ทำงานยังไง|ทำอะไรได้|what (is|does) (this|it)|what circuit/i.test(msg);
}
{
  const _q=aiLooksLikeQuestion;
  aiLooksLikeQuestion=function(msg){
    if(_q(msg)) return true;
    if(/[=]|minterms?|Σ/i.test(msg)) return false;
    return uxAboutSheet(msg) || /(อะไร|หรือเปล่า|รึเปล่า|\bwhat\b|\bwhich\b)/i.test(msg);
  };
  const _ask=aiAsk;
  aiAsk=async function(msg){
    const sch=activeSch();
    if(uxAboutSheet(msg) && sch && (sch.components||[]).some(c=>c.type!=="JUNCTION")){
      try{ aiAppend("ai", uxDescribeSheet(sch), {html:true}); return; }catch(e){ console.warn("describe", e); }
    }
    if(!(aiSmalltalk(msg)||aiFaq(msg))){
      const j=await aiHealth();
      if(j && !j.llm_up){
        const app=/^https?:/.test(location.protocol);
        aiAppend("ai", "คำถามแบบอิสระต้องใช้โมเดล AI · "+(app
          ? "เปิดได้ในโปรแกรม: หน้าหลัก ▸ <b>ตั้งค่า</b> ▸ <b>โมเดล AI ในเครื่อง</b> — กดดาวน์โหลดแล้ว “เริ่มโมเดล” ได้เลย"
          : "รัน llama.cpp ที่ 127.0.0.1:8080")
          +"<br><span class=\"ac-hint\">ที่ใช้ได้เลยโดยไม่ต้องมีโมเดล: “นี่วงจรอะไร”, สมการ เช่น <code>y = a xor b</code>, ชื่อวงจร เช่น full adder, /sim</span>", {html:true});
        return;
      }
    }
    return _ask.apply(this, arguments);
  };
}
