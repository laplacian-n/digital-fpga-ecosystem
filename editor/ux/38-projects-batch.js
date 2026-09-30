/* ===== 38. Projects kept in step with the folders, and edits in one transaction ======================
   Testing over MCP: there was no way to delete or rename a project, so the files were edited by hand —
   and the editor still held the deleted "test" in its own workspace, so new_project answered test_2,
   test_3 … A project opened from a renamed folder also kept the old name written inside the file.
     - delete_project / rename_project act on the editor's workspace AND the folder (deleted folders go
       to Projects/.trash, not erased);
     - rescan_projects compares the two and (prune) drops editor-only projects that hold nothing;
     - new_project takes the name back from an empty editor-only project instead of numbering it;
     - open_project names the project after its folder;
     - export_project / import_project move a project as JSON text;
     - batch runs several edits as ONE undo step, and undoes them all when one fails. */
function prjByName(name){
  const low=String(name||"").trim().toLowerCase();
  return Object.values(state.projects||{}).find(p=>String(p.name||"").toLowerCase()===low) || null;
}
const prjParts=p=>Object.values(p.schematics||{}).reduce((n,s)=>n+(s.components||[]).filter(c=>c.type!=="JUNCTION").length, 0);
async function prjDisk(){
  if(!/^https?:/.test(location.protocol)) return null;
  try{ const j=await (await fetch("/api/projects")).json(); return j.ok ? j.projects : null; }catch(_){ return null; }
}
/* drop a project from the editor's workspace without asking (the one on screen → another, or a blank one) */
function prjDropFromEditor(p){
  if(Object.keys(state.projects).length===1){ const blank=addProject("project", {activate:false}); state.activeProjectId=null; switchProject(blank.id); }
  delete state.projects[p.id];
  if(p.id===state.activeProjectId){ state.activeProjectId=null; switchProject(Object.keys(state.projects)[0]); }
  renderAll();
}
MCP_OPS.delete_project = async a=>{
  const name=String(a.name||"").trim(); if(!name) mcpFail("name is required");
  const p=prjByName(name), disk=await prjDisk(), onDisk=disk && disk.find(d=>d.name.toLowerCase()===name.toLowerCase());
  if(!p && !onDisk) mcpFail(`no project '${name}' in the editor or the workspace folder`, "rescan_projects lists both");
  const out={name};
  if(p){ mcpBeforeChange("ลบโปรเจกต์ "+p.name); prjDropFromEditor(p); out.removed_from_editor=true; }
  if(onDisk && a.files!==false){ const r=await aiagPost("/api/projects/delete", {name:onDisk.name}); if(!r.ok) mcpFail(r.error||"could not delete the folder");
    out.folder_moved_to=r.trashed; out.note="the folder is in Projects/.trash — move it back to restore it"; }
  else if(onDisk) out.folder_kept=onDisk.name;
  return Object.assign(out, {active_project:state.project.name});
};
MCP_OPS.rename_project = async a=>{
  const name=String(a.name||"").trim(), to=sanId(String(a.to||"").trim());
  if(!name || !to) mcpFail("name and to are required");
  const p=prjByName(name), disk=await prjDisk(), onDisk=disk && disk.find(d=>d.name.toLowerCase()===name.toLowerCase());
  if(!p && !onDisk) mcpFail(`no project '${name}'`, "rescan_projects lists them");
  const clash=prjByName(to); if(clash && clash!==p) mcpFail(`the editor already has a project '${clash.name}'`, "delete_project it first, or pick another name");
  const out={from:name, to};
  if(onDisk){ const r=await aiagPost("/api/projects/rename", {name:onDisk.name, to}); if(!r.ok) mcpFail(r.error||"could not rename the folder"); out.folder=r.name; }
  if(p){ mcpBeforeChange("เปลี่ยนชื่อโปรเจกต์"); p.name=to; if(p.id===state.activeProjectId){ const b=$("#projectName"); if(b) b.value=to; } mcpCommit(null); out.in_editor=p.name; }
  return out;
};
MCP_OPS.rescan_projects = async a=>{
  const disk=await prjDisk(); if(!disk) mcpFail("the workspace folder is only reachable in the app");
  const ed=Object.values(state.projects);
  const onDisk=new Set(disk.map(d=>d.name.toLowerCase()));
  const only=ed.filter(p=>!onDisk.has(String(p.name).toLowerCase()));
  const pruned=[];
  if(a.prune) only.filter(p=>!prjParts(p) && p.id!==state.activeProjectId).forEach(p=>{ prjDropFromEditor(p); pruned.push(p.name); });
  return {folder_projects:disk.map(d=>Object.assign({name:d.name, path:d.main}, d.name_mismatch?{name_inside_file:d.project_name}:{})),
    editor_projects:Object.values(state.projects).map(p=>({name:p.name, parts:prjParts(p), active:p.id===state.activeProjectId||undefined,
      saved_in_folder:onDisk.has(String(p.name).toLowerCase())})),
    only_in_editor:only.filter(p=>!pruned.includes(p.name)).map(p=>p.name), pruned,
    note:"prune:true drops editor-only projects with no parts (the one on screen stays); a folder whose file holds another name is renamed on open"};
};
/* new_project: an empty project the editor still remembers (deleted from disk) gives its name back */
{
  const _np=MCP_OPS.new_project;
  MCP_OPS.new_project=async a=>{
    const old=prjByName(a.name);
    if(old && !prjParts(old)){ const disk=await prjDisk();
      if(disk && !disk.some(d=>d.name.toLowerCase()===String(old.name).toLowerCase())) prjDropFromEditor(old); }
    return _np(a);
  };
}
/* open_project: the folder's name is the project's name */
{
  const _op=MCP_OPS.open_project;
  MCP_OPS.open_project=async a=>{
    const r=await _op(a), folder=String(a.path||"").split(/[\\/]/)[0];
    if(folder && sanId(folder)!==state.project.name){ const was=state.project.name; state.project.name=sanId(folder);
      const b=$("#projectName"); if(b) b.value=state.project.name; renderAll();
      return Object.assign(MCP_OPS.status(), {renamed_from:was, note:`the file said '${was}'; the project is named after its folder '${folder}' (save_project writes it)`}); }
    return r;
  };
}
MCP_OPS.export_project = a=>{
  const p=a.name ? prjByName(a.name) : state.project; if(!p) mcpFail(`no project '${a.name}' in the editor`);
  if(p.id!==state.activeProjectId) switchProject(p.id);
  const json=uxProjectOnlyJson(serialize());
  return {name:p.name, bytes:json.length, json};
};
MCP_OPS.import_project = async a=>{
  let text=a.json; if(text && typeof text==="object") text=JSON.stringify(text);
  if(!text) mcpFail("json is required: the .schproj.json text (export_project gives it)");
  let o; try{ o=JSON.parse(text); }catch(e){ mcpFail("json does not parse: "+e.message); }
  if(!o.project && !o.workspace) mcpFail("this is not a Schematic Studio project (no project / workspace)");
  if(a.name){ const nm=sanId(a.name); if(o.project) o.project.name=nm; Object.values((o.workspace||{}).projects||{}).forEach(p=>{ if(p) p.name=nm; }); text=JSON.stringify(o); }
  await uxTimelineAdd("ก่อน Claude นำเข้าโปรเจกต์", true);
  UX.expectFileLoad=true; deserialize(uxProjectFromFile(text, a.name||""));
  const out=MCP_OPS.status();
  if(a.save) out.saved=(await MCP_OPS.save_project({})).saved;
  return out;
};

/* ---- batch: several edits, one undo step, all or nothing ---- */
const BATCH_NOT=new Set(["batch","ai_chat","ai_chat_status","ai_chat_stop","ai_model","open_project","import_project","new_project","delete_project",
  "rename_project","board_build","board_program","board_status","save_project","export_files","screenshot","restore_checkpoint","undo","redo"]);
MCP_OPS.batch = async a=>{
  const ops=Array.isArray(a.ops)?a.ops:[]; if(!ops.length) mcpFail("ops is required: [{tool, args}, …]");
  if(ops.length>50) mcpFail("at most 50 ops in one batch");
  ops.forEach((o,i)=>{ if(!o || !MCP_OPS[o.tool]) mcpFail(`ops[${i}]: unknown tool '${o&&o.tool}'`);
    if(BATCH_NOT.has(o.tool)) mcpFail(`ops[${i}]: ${o.tool} cannot run inside a batch`); });
  mcpBeforeChange("batch "+ops.length+" คำสั่ง");
  snapshot();
  const H=state.history, mark=H.stack[H.idx], results=[];
  const back=()=>{ const i=H.stack.lastIndexOf(mark); if(i<0) return false; H.stack=H.stack.slice(0, i+1); H.idx=i; restore(mark); return true; };
  for(let i=0;i<ops.length;i++){
    try{ const r=await MCP_OPS[ops[i].tool](ops[i].args||{}); results.push({tool:ops[i].tool, ok:true, result:r}); }
    catch(e){
      const undone=a.atomic!==false && back();
      return {ok:false, failed_at:i, tool:ops[i].tool, error:e.message, hint:e.hint, rolled_back:undone, done:results.length,
        results:a.atomic===false?results:undefined, note:undone?"nothing of this batch was kept — fix ops["+i+"] and send it again":"the ops before it were kept"};
    }
  }
  // one undo step for the whole batch
  const i0=H.stack.lastIndexOf(mark);
  if(i0>=0 && H.idx>i0+1){ const last=H.stack[H.idx]; H.stack=H.stack.slice(0, i0+1).concat([last]); H.idx=i0+1; }
  try{ renderAll(); }catch(_){}
  return {ok:true, done:results.length, results:results.map(r=>({tool:r.tool, result:r.result})), undo:"one undo step undoes the whole batch"};
};
