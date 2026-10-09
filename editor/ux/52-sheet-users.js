/* ===== 52. Which sheets use the one on screen ==================================================
   Click a sheet in the project tree: every other sheet that places it as a block gets a faint red dot in
   front of its name (tooltip: what it is used as), so a change to its ports is seen to reach them. */
function sheetUsers(sch){
  if(!sch) return [];
  return Object.entries(state.project.schematics).filter(([id,s])=>s!==sch && (s.components||[]).some(c=>c.type==="SCH:"+sch.id))
    .map(([id,s])=>({id, name:s.name, n:s.components.filter(c=>c.type==="SCH:"+sch.id).length}));
}
{
  const _tree=renderProjectTree;
  renderProjectTree=function(){ const r=_tree.apply(this, arguments);
    try{ const cur=activeSch(), users=new Map(sheetUsers(cur).map(u=>[u.id,u]));
      document.querySelectorAll(`#projectPane .tree-item.sch[data-open][data-prj="${state.activeProjectId}"]`).forEach(el=>{
        const u=users.get(el.dataset.open); if(!u || el.querySelector(".su-dot")) return;
        const d=document.createElement("span"); d.className="su-dot";
        d.title=`ใช้แผ่น ${cur.name} เป็นบล็อก${u.n>1?` (${u.n} ตัว)`:""}`;
        el.prepend(d); }); }catch(e){ console.warn("sheet users", e); }
    return r; };
}
