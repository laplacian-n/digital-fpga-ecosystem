/* ===== 44. A bigger model takes over when the small one is stuck ====================================
   The 4B model answers routine requests in seconds but loops on a multi-block system; the 9B was
   installed and never used. When a run stops making progress (18: stall / time budget) and a bigger
   agent model is installed, the app restarts llama-server with it, the SAME conversation continues
   (tools, sheets and the plan so far), and the small model comes back when the run is over — the
   next routine request is fast again. Off: localStorage schstudio.agentEscalate = "0", or
   ai_chat {escalate:false}. */
const AIAG_ESC = { on:(()=>{ try{ return localStorage.getItem("schstudio.agentEscalate")!=="0"; }catch(_){ return true; } })() };
async function aiagModelStatus(){ try{ return await (await fetch("/api/llm/status")).json(); }catch(_){ return null; } }
/* the installed agent model bigger than the one running, or null */
function aiagBigger(st){
  if(!st || !st.catalog) return null;
  const base=p=>String(p||"").split(/[\\/]/).pop().toLowerCase();
  const cur=st.catalog.find(m=>base(m.path)===base(st.model));
  const up=st.catalog.filter(m=>m.agent && m.installed && (!cur || m.size_gb>cur.size_gb)).sort((a,b)=>b.size_gb-a.size_gb)[0];
  return up && (!cur || up.id!==cur.id) ? {from:cur||{id:base(st.model), path:st.model, name:base(st.model)}, to:up} : null;
}
/* switch to the bigger model and wait until it answers; {from,to} or null */
async function aiagEscalate(run, live){
  if(!AIAG_ESC.on || run.noEscalate || run.escalated || !/^https?:/.test(location.protocol)) return null;
  const st=await aiagModelStatus(), b=aiagBigger(st); if(!b) return null;
  live && live(`โมเดล ${b.from.name} ติดอยู่ — สลับไป ${b.to.name}…`);
  aiagLine(`<div class="ag-step"><span class="ag-tool">⇪ สลับโมเดล</span><div class="ag-res">${esc(b.from.name)} ไม่คืบหน้า — ให้ ${esc(b.to.name)} ทำต่อจากเดิม (เปลี่ยนกลับเมื่อจบงาน)</div></div>`, "step");
  const r=await aiagPost("/api/llm/start", {model:b.to.path}); if(!r || r.ok===false) return null;
  const until=Date.now()+180000;
  while(Date.now()<until && !run.cancel){ const s=await aiagModelStatus(); if(s && s.state==="ready") break; if(s && s.state==="crashed") return null;
    await new Promise(res=>setTimeout(res, 800)); }
  run.escalated={from:b.from.id, to:b.to.id, back:b.from.path};
  run.steps.push({kind:"escalate", text:`${b.from.id} → ${b.to.id}`});
  return run.escalated;
}
/* after the run: the small model again (not awaited — the answer is already shown) */
function aiagDeescalate(run){
  if(!run.escalated || !run.escalated.back) return;
  aiagPost("/api/llm/start", {model:run.escalated.back}).catch(()=>{});
}
