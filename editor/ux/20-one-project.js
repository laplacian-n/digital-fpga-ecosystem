/* ===== 20. A project folder holds ONE project =================================================
   The editor keeps several projects open at once (the Projects tree), and serialize() writes that
   whole workspace. Saved into a project's folder in the app, lab6_counter.schproj.json carried
   lab5_2 and lab5_3 too — and opening lab6 from Home brought them all back. In the app:
     - a .schproj.json saved into a project folder holds only the project it is saved as;
     - opening a project from Home (?open=) loads only that project — from an older file that
       still holds several, the one named like its folder (else the one that was active).
   Opened from disk the editor is unchanged (File ▸ Save keeps the whole workspace). */
function uxProjectOnlyJson(text){
  let o; try{ o=JSON.parse(text); }catch(_){ return text; }
  if(!o || !o.workspace || !o.project) return text;
  const pid=o.workspace.activeId, p=(o.workspace.projects||{})[pid] || o.project;
  return JSON.stringify({version:2, workspace:{projects:{[pid||p.id||"p1"]:p}, activeId:pid||p.id||"p1"},
    project:o.project, activeId:o.activeId, openTabs:o.openTabs}, null, 2);
}
function uxProjectFromFile(text, folder){
  let o; try{ o=JSON.parse(text); }catch(_){ return text; }
  const W=o && o.workspace && o.workspace.projects;
  if(!W || Object.keys(W).length<2) return text;
  const want=String(folder||"").toLowerCase(), all=Object.values(W);
  const p=all.find(x=>x && String(x.name||"").toLowerCase()===want)
       || all.find(x=>x && sanId(String(x.name||"")).toLowerCase()===sanId(want).toLowerCase())
       || W[o.workspace.activeId] || o.project;
  return JSON.stringify({version:1, project:p, activeId:p.activeId, openTabs:p.openTabs});
}
MCP_OPS.save_project = async a=>{
  state.project.name=sanId($("#projectName").value||state.project.name||"project");
  const p=await mcpSaveFile(state.project.name, state.project.name+".schproj.json", uxProjectOnlyJson(serialize()));
  uxMarkSaved(); return {saved:p};
};
MCP_OPS.open_project = async a=>{
  const r=await fetch("/api/files/read?path="+encodeURIComponent(a.path)); if(!r.ok) mcpFail(`cannot read '${a.path}' (HTTP ${r.status})`, "list_projects shows the paths");
  UX.expectFileLoad=true; deserialize(uxProjectFromFile(await r.text(), String(a.path).split(/[\\/]/)[0])); return MCP_OPS.status();
};
