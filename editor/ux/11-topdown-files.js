/* ===== 11. A Top-Down file opened in Schematic Studio ======================================
   A Top-Down project ({meta, sheets:[{title, nodes, wires}]}) and a Schematic Studio project
   ({project:{schematics}}) are both .json, and students keep them in the same folder. Opening
   the Top-Down one here used to fail with "โหลดไม่สำเร็จ: Invalid file". Every way in (File ▸
   Open, the Home project list, MCP open_project) goes through deserialize(), so it is caught
   there: the sheets go to the Top-Down view, ADDED to what is already there (nothing lost),
   drawn exactly as saved. */
function uxIsTopdownProject(o){
  return !!(o && typeof o==="object" && !o.project && !o.workspace && Array.isArray(o.sheets)
            && o.sheets.length && o.sheets.every(s=>s && typeof s==="object" && Array.isArray(s.nodes)));
}
{
  const _deserialize = deserialize;
  deserialize = function(json){
    let o=null; try{ o = typeof json==="string" ? JSON.parse(json) : json; }catch(_){}
    if(uxIsTopdownProject(o)){
      sendToTopdown({type:"td:loadProject", project:o});
      toast(`ไฟล์นี้เป็นผัง Top-Down (${o.sheets.length} แผ่น) — เปิดในหน้า Top-Down ให้แล้ว`, "ok", 4500);
      return;
    }
    return _deserialize.apply(this, arguments);
  };
}
