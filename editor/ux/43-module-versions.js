/* ===== 43. Modules with versions: placed copies can be updated, and you can see where one is used ====
   save_module made a copy; changing the module later left every copy already placed as it was, with
   no way to tell which were old. Now a module has a version (saving over it = +1), a placed copy
   remembers the version it came from, and
     - update_module (and the Modules tab's "อัปเดต" button) brings the outdated copies in this project
       (or every open project) up to date in place — same sheet, so parents keep their blocks; port
       changes are reported;
     - where_used lists every copy in the open projects and the sheets that place it;
     - use_module also takes a part kind from the library (bcd_counter_multi, seg7_mux4 …): the
       standard lab modules are there without saving them first. */
{
  const _save=moduleSave;
  moduleSave=function(sch, name, desc, replaceId){
    loadModules(); const prev=replaceId && state.modules[replaceId] ? (state.modules[replaceId].version||1) : 0;
    const m=_save.apply(this, arguments); m.version=prev+1; saveModules(); try{ renderModulesPane(); }catch(_){}
    return m;
  };
  const _adopt=moduleAdopt;
  moduleAdopt=function(m, keepLink){ const s=_adopt.apply(this, arguments); if(s && keepLink) s.moduleVersion=m.version||1; return s; };
}
/* every copy of module m in the open projects */
function moduleInstances(m){
  const out=[];
  Object.values(state.projects||{}).forEach(p=>Object.values(p.schematics||{}).forEach(s=>{ if(s.moduleId!==m.id) return;
    const usedIn=Object.values(p.schematics).filter(x=>(x.components||[]).some(c=>c.type==="SCH:"+s.id)).map(x=>x.name);
    out.push({project:p.name, projectId:p.id, sheet:s.name, sheetId:s.id, version:s.moduleVersion||1, outdated:(s.moduleVersion||1)<(m.version||1), placed_in:usedIn}); }));
  return out;
}
/* bring one placed copy up to date, in place */
function moduleUpdateSheet(m, s){
  const before=schPortList(s).map(p=>p.dir+" "+p.id+(p.width>1?`[${p.width-1}:0]`:""));
  const fresh=_moduleFresh(m);
  s.components=fresh.components; s.wires=fresh.wires;
  ["portOrder","verified","spec","specResult","pinmap"].forEach(k=>{ if(fresh[k]!=null) s[k]=fresh[k]; else delete s[k]; });
  s.moduleVersion=m.version||1;
  const after=schPortList(s).map(p=>p.dir+" "+p.id+(p.width>1?`[${p.width-1}:0]`:""));
  return {sheet:s.name, added_ports:after.filter(x=>!before.includes(x)), removed_ports:before.filter(x=>!after.includes(x))};
}
/* the module's sheet as it is now, its blocks adopted into this project (then the extra top sheet dropped) */
function _moduleFresh(m){
  const s=moduleAdopt(m, false), copy={components:s.components, wires:s.wires, portOrder:s.portOrder, verified:s.verified, spec:s.spec, pinmap:s.pinmap};
  delete state.project.schematics[s.id]; state.openTabs=(state.openTabs||[]).filter(i=>i!==s.id);
  return copy;
}
MCP_OPS.where_used = a=>{
  const m=mcpModule(a.module), L=moduleInstances(m);
  return {module:m.name, version:m.version||1, copies:L.map(x=>({project:x.project, sheet:x.sheet, version:x.version, outdated:x.outdated||undefined, placed_in:x.placed_in})),
    note:"projects open in the editor only — a project saved on disk and not open is not searched"};
};
MCP_OPS.update_module = a=>{
  const m=mcpModule(a.module), L=moduleInstances(m).filter(x=>x.outdated && (a.all_projects || x.projectId===state.activeProjectId));
  if(!L.length) return {module:m.name, version:m.version||1, updated:[], note:"every copy "+(a.all_projects?"":"in this project ")+"is up to date"};
  mcpBeforeChange("อัปเดตโมดูล "+m.name);
  const here=state.activeProjectId, done=[];
  L.forEach(x=>{ if(x.projectId!==state.activeProjectId) switchProject(x.projectId);
    done.push(Object.assign({project:x.project, from:x.version, to:m.version||1}, moduleUpdateSheet(m, state.project.schematics[x.sheetId]))); });
  if(state.activeProjectId!==here) switchProject(here);
  mcpCommit(activeSch());
  return {module:m.name, version:m.version||1, updated:done,
    note:done.some(d=>d.added_ports.length||d.removed_ports.length) ? "ports changed — check the sheets that place it (check / suggest_wires)" : "same ports: the parents need no change"};
};
/* use_module: a part kind works too (the standard lab modules) */
{
  const _use=MCP_OPS.use_module;
  MCP_OPS.use_module=a=>{
    if(!moduleFind(a.module) && PARTS[a.module]){
      const target=mcpUse(a.sheet); mcpBeforeChange("วาง "+a.module);
      const sn=ptSub(a.module, a.params||{}), sub=Object.values(state.project.schematics).find(s=>s.name===sn);
      const why=subBlockBlockedWhy(sub.id, target.id); if(why) mcpFail(why);
      mcpUse(target.id);
      const r=MCP_OPS.add_component({sheet:target.name, type:"block:"+sub.name, name:a.name, x:a.x, y:a.y});
      return Object.assign({part:a.module, sheet_in_project:sub.name, verified:sheetVerified(sub)}, r);
    }
    return _use(a);
  };
  const _list=MCP_OPS.list_modules;
  MCP_OPS.list_modules=a=>{ const r=_list(a);
    r.modules.forEach(x=>{ const m=moduleFind(x.id); x.version=m.version||1; const L=moduleInstances(m);
      if(L.length) x.copies_in_open_projects=L.length; if(L.some(i=>i.outdated)) x.outdated_copies=L.filter(i=>i.outdated).length; });
    r.standard_parts="use_module also takes a part kind (list_parts): "+Object.keys(PARTS).slice(0, 12).join(", ")+" …";
    return r; };
}
/* the Modules tab: version, and "อัปเดต" when this project holds an older copy */
{
  const _cards=moduleCardsHtml;
  moduleCardsHtml=function(){
    let h=_cards.apply(this, arguments);
    Object.values(state.modules||{}).forEach(m=>{
      const old=moduleInstances(m).filter(x=>x.outdated && x.projectId===state.activeProjectId).length;
      const tag=`<span class="pt-badge" title="เวอร์ชันของโมดูลในคลัง">v${m.version||1}</span>`+(old?` <button class="btn2 mod-upd" data-modupd="${esc(m.id)}" title="แผ่นในโปรเจกต์นี้ยังเป็นเวอร์ชันเก่า">อัปเดต ${old}</button>`:"");
      h=h.replace(new RegExp(`(<div class="mod-name" title="${esc(m.name).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}">[^<]*)`), `$1 ${tag}`);
    });
    return h;
  };
  document.addEventListener("click", ev=>{
    const b=ev.target.closest && ev.target.closest("[data-modupd]"); if(!b) return; ev.stopPropagation();
    try{ const r=MCP_OPS.update_module({module:b.dataset.modupd}); toast(`อัปเดตโมดูล ${r.module} เป็น v${r.version} แล้ว (${r.updated.length} แผ่น)`, "ok", 5000); renderModulesPane(); }
    catch(e){ toast("อัปเดตไม่ได้: "+e.message, "warn", 6000); }
  }, true);
}
