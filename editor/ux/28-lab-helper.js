/* ===== 28. Lab helper: the lab sheet as a checklist, one step at a time (Tools ▸ ผู้ช่วยทำแลป) =====
   The course's lab sheets ship with the app (ai/rag/labs: every item's question, sub-tasks, and a
   worked solution). Pick a lab → each item becomes a card: its sub-tasks as a checklist (kept with
   the project), "ให้เอเจนต์ช่วยข้อนี้" (the question goes to the chat's agent), "ตั้งเป็นข้อกำหนด"
   (when the solution gives equations: the active sheet's acceptance test), and the worked solution
   folded away as a hint. A beginner follows it down the page. */
const LABH = { labs:null };
async function labhLoad(){
  if(LABH.labs) return LABH.labs;
  if(!/^https?:/.test(location.protocol)) throw new Error("ใบแลปมากับโปรแกรม FPGA Ecosystem — เปิด editor ผ่านโปรแกรม");
  const j=await (await fetch("/api/rag/labs")).json(); if(!j.ok) throw new Error(j.error||"โหลดใบแลปไม่ได้");
  LABH.labs=j.labs.filter(l=>l.items&&l.items.length); return LABH.labs;
}
/* equations a solution states ("invalid = W·X + W·Y", "f = a' + b·d") → a formula, or null. All or
   nothing: one statement that is not a plain equation (c_{i+1} = …, BCD_invalid(SW[7:4])) and the
   item gets no button rather than a spec that checks only part of it. */
function labhFormula(sol){
  if(!sol) return null;
  const txt=[sol.final_expression, sol.expression, sol.equations].flat().filter(Boolean).join("\n")
    .replace(/\s*\(\s*[^\x00-\x7f][^\n]*/g, "");          // "(สมการของเซกเมนต์ …)" notes
  if(!txt.trim()) return null;
  const parts=txt.split(/\n|;|,(?=\s*\w+\s*=)/).map(s=>s.trim()).filter(Boolean);
  if(!parts.length || parts.some(s=>!/^\w+\s*=\s*[\w\s'*+^()~&|·∙•⊕!]+$/.test(s))) return null;
  const eqs=parts.map(s=>s.replace(/\s+/g," "));                       // fxParse reads x', ·, ⊕, + as OR
  const outs=eqs.map(e=>e.split("=")[0].trim());
  try{ const t=formulaTable(eqs.join("; "));
    if(t.inputs.some(i=>outs.includes(i))) return null;               // a JK excitation (Q on both sides)
    return eqs.join("; "); }catch(_){ return null; }
}
function labhProgress(){ return state.project.labProgress=state.project.labProgress||{}; }
async function openLabHelper(){
  let labs; try{ labs=await labhLoad(); }catch(e){ toast(e.message,"warn",5000); return; }
  const cur=state.project.labProgress&&state.project.labProgress._lab;
  if(LABH.modal && LABH.modal.isConnected) LABH.modal.close();
  const m=LABH.modal=uxModal("ผู้ช่วยทำแลป (จากใบงาน)", `
    <div class="lh-top"><select id="lhLab">${labs.map(l=>`<option value="${esc(l.lab)}" ${l.lab===cur?"selected":""}>${esc(l.lab)} — ${esc(l.title)}</option>`).join("")}</select>
      <span id="lhProg" class="muted"></span></div>
    <div id="lhBody" class="lh-body"></div>`, {width:860});
  const draw=()=>{
    const lab=labs.find(l=>l.lab===m.querySelector("#lhLab").value)||labs[0], P=labhProgress(); P._lab=lab.lab;
    let total=0, done=0;
    m.querySelector("#lhBody").innerHTML=(lab.objectives&&lab.objectives.length?`<div class="muted" style="margin-bottom:8px">จุดประสงค์: ${lab.objectives.map(esc).join(" · ")}</div>`:"")+
      lab.items.map(it=>{ const st=P[it.id]||[], subs=it.subtasks&&it.subtasks.length?it.subtasks:[it.question];
        total+=subs.length; done+=subs.filter((_,i)=>st[i]).length;
        const f=labhFormula(it.solution), sol=it.solution;
        return `<div class="lh-card" data-item="${esc(it.id)}"><div class="lh-q"><b>${esc(it.id)}</b> ${esc(it.question)}</div>
          <div class="lh-subs">${subs.map((s,i)=>`<label><input type="checkbox" data-sub="${i}" ${st[i]?"checked":""}> ${esc(s)}</label>`).join("")}</div>
          <div class="lh-acts"><button class="btn" data-lh="agent">🤖 ให้เอเจนต์ช่วยข้อนี้</button>
            <button class="btn" data-lh="ask">💬 ถามเรื่องข้อนี้</button>
            ${f?`<button class="btn" data-lh="spec" data-f="${esc(f)}" title="${esc(f)}">✓ ตั้งเป็นข้อกำหนดของแผ่นนี้</button>`:""}</div>
          ${sol?`<details class="lh-sol"><summary>ดูแนวคิด / เฉลย (ลองทำเองก่อน)</summary><pre>${esc([sol.steps, sol.truth_table, sol.final_expression].filter(Boolean).join("\n\n"))}</pre></details>`:""}</div>`; }).join("");
    m.querySelector("#lhProg").textContent=`ทำแล้ว ${done}/${total} ขั้น`;
  };
  m.querySelector("#lhLab").onchange=()=>{ draw(); snapshot(); };
  m.addEventListener("change", e=>{ const cb=e.target.closest("[data-sub]"); if(!cb) return;
    const id=cb.closest("[data-item]").dataset.item, P=labhProgress(); (P[id]=P[id]||[])[+cb.dataset.sub]=cb.checked; snapshot(); draw(); });
  m.addEventListener("click", e=>{ const b=e.target.closest("[data-lh]"); if(!b) return;
    const lab=labs.find(l=>l.lab===m.querySelector("#lhLab").value), it=lab.items.find(x=>x.id===b.closest("[data-item]").dataset.item);
    if(b.dataset.lh==="spec"){ const sch=activeSch();
      try{ const r=MCP_OPS.set_spec({sheet:sch.name, formula:b.dataset.f}); renderAll();
        toast(`ตั้งข้อกำหนดของแผ่น ${sch.name} จากข้อ ${it.id} แล้ว — ${r.result&&r.result.pass?"วงจรผ่าน ✓":"ยังไม่ผ่าน ✗ (ทำต่อจนเป็น ✓)"}`, r.result&&r.result.pass?"ok":"warn", 6000); }
      catch(err){ toast("ตั้งไม่ได้: "+err.message, "warn", 6000); } return; }
    // to the chat: the agent does it, or the Q&A mode explains it
    m.close(); if(!AICHAT.open) toggleAiChat();
    aiSetMode(b.dataset.lh==="agent"?"agent":"qa");
    const t=$("#acInput");
    t.value = b.dataset.lh==="agent"
      ? `ทำข้อ ${it.id} ของใบแลป: ${it.question}${it.subtasks&&it.subtasks.length?"\nขั้นตอน: "+it.subtasks.join(" / "):""}`
      : `อธิบายข้อ ${it.id} ของใบแลปให้หน่อย ต้องเริ่มจากอะไร: ${it.question}`;
    t.focus(); toast("ใส่คำสั่งในแชทให้แล้ว — แก้ได้ก่อนกดส่ง","info",4000);
  });
  draw();
}
GENERATORS.push({id:"labhelper", icon:"🧭", name:"ผู้ช่วยทำแลป (จากใบงาน)", desc:"ใบแลปเป็นเช็กลิสต์ทีละขั้น + ให้เอเจนต์ช่วย + ตั้งข้อกำหนด + ดูเฉลย", run:()=>openLabHelper()});
{
  const last=[...document.querySelectorAll('#menu [data-gen]')].pop();
  if(last && !document.querySelector('#menu [data-gen="labhelper"]')){
    last.insertAdjacentHTML("afterend", `<button class="gen-mi" data-gen="labhelper" title="ใบแลปเป็นเช็กลิสต์ทีละขั้น"><span class="gi">🧭</span>ผู้ช่วยทำแลป (จากใบงาน)…</button>`);
    document.querySelector('#menu [data-gen="labhelper"]').addEventListener("click", ()=>runGenerator("labhelper"));
  }
}
