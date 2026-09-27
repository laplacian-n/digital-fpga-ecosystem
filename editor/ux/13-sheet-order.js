/* ===== 13. Drag sheets to reorder them in the project tree ================================
   "ทำให้เลื่อนวางไอ่ตัวพวกนี้ได้ด้วย": the sheets of a project are listed in the order they were
   made, so a lab's sub-circuits ended up scattered (top in the middle, bcd_dec at the bottom).
   Grab a sheet and drop it above / below another one of the SAME project. The order is simply the
   order of the keys of `schematics` — rewritten in place, so every reference to that object stays
   valid and the order is saved with the project. Ctrl+Z undoes it. */
function sheetReorder(pid, dragId, targetId, after){
  const pr = state.projects[pid]; if(!pr || !pr.schematics) return false;
  const S = pr.schematics, keys = Object.keys(S);
  if(dragId===targetId || !S[dragId] || !S[targetId]) return false;
  const rest = keys.filter(k=>k!==dragId);
  rest.splice(rest.indexOf(targetId) + (after ? 1 : 0), 0, dragId);
  if(rest.join("\n")===keys.join("\n")) return false;
  const vals = rest.map(k=>S[k]);
  keys.forEach(k=>{ delete S[k]; });
  rest.forEach((k,i)=>{ S[k] = vals[i]; });
  return true;
}
const SHEETDRAG = { id:null, pid:null };
{
  const _tree = renderProjectTree;
  renderProjectTree = function(){
    const r = _tree.apply(this, arguments);
    document.querySelectorAll('#projectPane .tree-item.sch[data-open]').forEach(el=>{
      el.draggable = true;
      el.title = el.title || "ลากเพื่อเลื่อนลำดับ";
    });
    return r;
  };
  const pane = document.getElementById("projectPane");
  const clear = ()=>pane.querySelectorAll(".sd-before,.sd-after,.sd-drag").forEach(e=>e.classList.remove("sd-before","sd-after","sd-drag"));
  const target = ev=>{ const el = ev.target.closest && ev.target.closest(".tree-item.sch[data-open]");
    return (el && SHEETDRAG.id && el.dataset.prj===SHEETDRAG.pid && el.dataset.open!==SHEETDRAG.id) ? el : null; };
  const below = (el, ev)=>{ const b = el.getBoundingClientRect(); return ev.clientY > b.top + b.height/2; };
  pane.addEventListener("dragstart", ev=>{
    const el = ev.target.closest && ev.target.closest(".tree-item.sch[data-open]"); if(!el) return;
    SHEETDRAG.id = el.dataset.open; SHEETDRAG.pid = el.dataset.prj;
    el.classList.add("sd-drag");
    try{ ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", SHEETDRAG.id); }catch(_){}
  });
  pane.addEventListener("dragover", ev=>{
    const el = target(ev); if(!el) return;
    ev.preventDefault();
    try{ ev.dataTransfer.dropEffect = "move"; }catch(_){}
    pane.querySelectorAll(".sd-before,.sd-after").forEach(e=>e.classList.remove("sd-before","sd-after"));
    el.classList.add(below(el, ev) ? "sd-after" : "sd-before");
  });
  pane.addEventListener("drop", ev=>{
    const el = target(ev); if(!el) return;
    ev.preventDefault();
    const ok = sheetReorder(SHEETDRAG.pid, SHEETDRAG.id, el.dataset.open, below(el, ev));
    SHEETDRAG.id = SHEETDRAG.pid = null; clear();
    if(ok){ snapshot(); renderAll(); }
  });
  pane.addEventListener("dragend", ()=>{ SHEETDRAG.id = SHEETDRAG.pid = null; clear(); });
}
try{ renderProjectTree(); }catch(_){}   // the tree drawn before this layer loaded
