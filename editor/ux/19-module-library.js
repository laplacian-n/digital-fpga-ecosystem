/* ===== 19. The module library (Modules tab) over MCP — and modules that keep their sub-blocks ===
   "เพิ่มโมดูลผ่าน mcp ได้ไหม": Claude (and the local agent) can list, save, place, open and delete
   modules in the cross-project library the Modules tab shows (state.modules, localStorage).
   A module used to be ONE sheet: a counter built from a mod10 block lost that block on the way
   into the library (its SCH: type pointed at a sheet that was not stored). A module now carries
   `deps`, every sheet it uses as a block (recursively), and they come back together. */
function moduleDeps(sch){
  const P=state.project.schematics, seen=new Set([sch.id]), out=[];
  const walk=s=>(s.components||[]).forEach(c=>{
    if(typeof c.type!=="string" || c.type.indexOf("SCH:")!==0) return;
    const sub=P[c.type.slice(4)]; if(!sub || seen.has(sub.id)) return;
    seen.add(sub.id); out.push(JSON.parse(JSON.stringify(sub))); walk(sub); });
  walk(sch);
  return out;
}
function moduleSave(sch, name, desc, replaceId){
  loadModules();
  const id=replaceId || ("mod_"+Date.now().toString(36)+Math.random().toString(36).slice(2,5));
  state.modules[id]={ id, name:String(name).trim(), desc:String(desc||"").trim(), ts:Date.now(),
    schematic:JSON.parse(JSON.stringify(sch)), deps:moduleDeps(sch) };
  saveModules(); try{ renderModulesPane(); }catch(_){}
  return state.modules[id];
}
function moduleFind(ref){
  loadModules(); const all=Object.values(state.modules||{}), low=String(ref||"").trim().toLowerCase();
  return (state.modules||{})[ref] || all.find(m=>m.name.toLowerCase()===low) || null;
}
/* the module's sheet (+ its blocks) brought into the project; returns the added top sheet */
function moduleAdopt(m, keepLink){
  const copy=JSON.parse(JSON.stringify(m.schematic)); if(keepLink) copy.moduleId=m.id;
  const added=adoptSchematics([copy, ...JSON.parse(JSON.stringify(m.deps||[]))]);
  if(!added.length) return null;
  if(keepLink) added[0].moduleId=m.id;
  return added[0];
}
// the Modules tab itself: save with the blocks, bring them back with it
moduleImportCurrent=function(){
  const sch=activeSch(); if(!sch||!((sch.components||[]).length)){ toast("แผ่นปัจจุบันยังไม่มีวงจร","warn"); return; }
  const name=prompt("ชื่อโมดูล:", sch.name||"module"); if(name===null||!name.trim()) return;
  const desc=prompt("คำอธิบายสั้นๆ (ไม่ใส่ก็ได้):","")||"";
  const m=moduleSave(sch, name, desc);
  toast("เก็บโมดูล “"+m.name+"” เข้าคลังแล้ว"+(m.deps.length?` (รวมบล็อกย่อย ${m.deps.length} แผ่น)`:""),"ok");
};
moduleAdoptInto=function(id){
  loadModules(); const m=(state.modules||{})[id]; if(!m) return null;
  const existing=Object.values(state.project.schematics).find(s=>s.moduleId===id);
  if(existing) return existing.id;
  const s=moduleAdopt(m, true); return s ? s.id : null;
};
moduleOpen=function(id){
  loadModules(); const m=(state.modules||{})[id]; if(!m) return;
  const s=moduleAdopt(m, false); if(!s) return;
  openSchTab(s.id); snapshot(); renderAll();
  toast("เปิดโมดูล “"+m.name+"” เป็นแผ่นใหม่เพื่อแก้ไข","ok");
};

/* ---------- MCP ---------- */
function mcpModuleInfo(m){
  let ports=[]; try{ ports=schPortList(m.schematic).map(p=>({name:p.id, dir:p.dir, width:p.width})); }catch(_){}
  return {id:m.id, name:m.name, description:m.desc||"", ports, parts:(m.schematic.components||[]).filter(c=>c.type!=="JUNCTION").length,
    blocks:(m.deps||[]).map(d=>d.name), saved:new Date(m.ts||0).toISOString()};
}
function mcpModule(ref){
  const m=moduleFind(ref); if(m) return m;
  mcpFail(`module '${ref}' is not in the library`, "modules: "+(Object.values(state.modules||{}).map(x=>x.name).join(", ")||"(empty — save_module first)"));
}
MCP_OPS.list_modules = a=>{
  loadModules();
  const q=String(a.query||"").trim();
  const mods=Object.values(state.modules||{}).sort((x,y)=>(y.ts||0)-(x.ts||0)).filter(m=>!q || moduleMatch(m,q));
  return {count:mods.length, modules:mods.map(mcpModuleInfo),
    note:"the library is shared by every project in this editor (browser storage of the app)"};
};
MCP_OPS.save_module = a=>{
  const sch=mcpSheet(a.sheet);
  if(!sch.components.filter(c=>c.type!=="JUNCTION").length) mcpFail(`sheet '${sch.name}' is empty`);
  const name=String(a.name||sch.name).trim(); if(!name) mcpFail("name is required");
  const same=moduleFind(name);
  if(same && !a.replace) mcpFail(`a module named '${same.name}' is already in the library`, "replace:true overwrites it, or choose another name");
  const m=moduleSave(sch, name, a.description||"", same?same.id:null);
  mcpActivity("เก็บโมดูล "+m.name);
  try{ toast("Claude เก็บโมดูล “"+m.name+"” เข้าคลัง","ok",3000); }catch(_){}
  return Object.assign({saved:true, replaced:!!same}, mcpModuleInfo(m));
};
MCP_OPS.use_module = a=>{
  const m=mcpModule(a.module), target=mcpUse(a.sheet);
  const sid=moduleAdoptInto(m.id); if(!sid) mcpFail("could not bring the module into the project");
  const sub=state.project.schematics[sid];
  const why=subBlockBlockedWhy(sid, target.id); if(why) mcpFail(why);
  mcpUse(target.id);
  const r=MCP_OPS.add_component({sheet:target.name, type:"block:"+sub.name, name:a.name, x:a.x, y:a.y});
  return Object.assign({module:m.name, sheet_in_project:sub.name}, r);
};
MCP_OPS.open_module = a=>{
  const m=mcpModule(a.module); mcpBeforeChange("เปิดโมดูล");
  const s=moduleAdopt(m, false); if(!s) mcpFail("could not open the module");
  openSchTab(s.id); mcpCommit(s); try{ zoomFit(); }catch(_){}
  return {module:m.name, opened_as:s.name, blocks_added:(m.deps||[]).length};
};
MCP_OPS.delete_module = a=>{
  const m=mcpModule(a.module);
  delete state.modules[m.id]; saveModules(); try{ renderModulesPane(); }catch(_){}
  mcpActivity("ลบโมดูล "+m.name);
  return {deleted:m.name, note:"sheets already brought into projects stay as they are"};
};
