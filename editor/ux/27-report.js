/* ===== 27. Lab report, made from the work (Tools ▸ ทำรายงานแลป, MCP make_report) =================
   The part of a lab students spend most time on, from what the app already knows: every sheet of
   the design (top first, then its blocks) as a vector picture, its ports, its truth table and
   minimised equations (combinational) or its first clocks (sequential), its acceptance test, the
   board pin table and the VHDL. One HTML page: print it to PDF, or save the .doc Word opens. */
function reportSheetSvg(sch){
  // render the sheet on screen, then copy the drawing with its colours resolved (as screenshot does)
  const back=state.activeId;
  openSchTab(sch.id); try{ zoomFit(); }catch(_){} render();
  const src=$("#canvas"); if(!src) return "";
  const clone=src.cloneNode(true);
  const all=[src, ...src.querySelectorAll("*")], cl=[clone, ...clone.querySelectorAll("*")];
  all.forEach((el,i)=>{ const cs=getComputedStyle(el), d=cl[i]; if(!d||!d.style) return;
    ["fill","stroke","stroke-width","stroke-dasharray","opacity","font-size","font-weight","font-family"].forEach(k=>{ const v=cs.getPropertyValue(k); if(v) d.style.setProperty(k, v); }); });
  clone.querySelectorAll(".ux-marks,.mcp-flash,.grid-bg").forEach(n=>n.remove());
  let vb=null; try{ const g=src.firstChild, bb=g.getBBox(), t=(g.getAttribute("transform")||""), m=/translate\(([-\d.]+)[ ,]+([-\d.]+)\)\s*scale\(([-\d.]+)\)/.exec(t);
    if(m){ const tx=+m[1], ty=+m[2], k=+m[3]; vb=[tx+bb.x*k-20, ty+bb.y*k-20, bb.width*k+40, bb.height*k+40]; } }catch(_){}
  const box=src.getBoundingClientRect();
  clone.setAttribute("xmlns","http://www.w3.org/2000/svg");
  clone.setAttribute("viewBox", (vb||[0,0,box.width,box.height]).join(" "));
  clone.setAttribute("width","100%"); clone.removeAttribute("height"); clone.setAttribute("style","max-height:520px;background:#fff");
  if(back && back!==sch.id) openSchTab(back);
  return new XMLSerializer().serializeToString(clone);
}
function reportSheets(){
  const P=state.project, top=P.schematics[P.topId], out=[], seen=new Set();
  const walk=s=>{ if(!s||seen.has(s.id)) return; seen.add(s.id); out.push(s); s.components.forEach(c=>{ const sub=subSchOf(c); if(sub) walk(sub); }); };
  walk(top);
  Object.values(P.schematics).forEach(s=>{ if(!seen.has(s.id) && s.components.some(c=>c.type!=="JUNCTION")) out.push(s); });
  return out;
}
function reportHtml(opts){
  opts=opts||{};
  const P=state.project, name=($("#projectName")||{}).value||P.name||"project";
  const sheets=(opts.sheets||reportSheets());
  const esc2=esc, tbl=(head, rows)=>`<table><tr>${head.map(h=>`<th>${esc2(h)}</th>`).join("")}</tr>${rows.map(r=>`<tr>${r.map(c=>`<td>${esc2(c)}</td>`).join("")}</tr>`).join("")}</table>`;
  const sec=sheets.map((s,i)=>{
    let body="";
    const ports=schPortList(s);
    body+=`<h3>ขาเข้า/ขาออก</h3>`+tbl(["ขา","ทิศ","บิต"], ports.map(p=>[p.id, p.dir==="in"?"เข้า":"ออก", String(p.width)]));
    const hasFF=flattenSchematic(s).sch.components.some(c=>PROBE_SEQ[c.type]);
    if(!hasFF){ const j=clientCombSim(s);
      if(j.ok && j.truth_table.inputs.length<=6){ const tt=j.truth_table;
        body+=`<h3>ตารางความจริง</h3>`+tbl([...tt.inputs, ...tt.outputs], tt.rows.map(([a,b])=>[...a.map(String), ...b.map(String)]));
        const eq=uxEquations(tt); if(eq.length) body+=`<h3>สมการ (ลดรูปแล้ว)</h3><ul>${eq.map(e=>`<li><code>${esc2(e)}</code></li>`).join("")}</ul>`;
        const rec=uxRecognize(tt); if(rec) body+=`<p class="muted">วงจรนี้คือ: ${esc2(rec)}</p>`; }
      else if(j.ok) body+=`<p class="muted">อินพุต ${j.truth_table.inputs.length} บิต — ตารางความจริงยาวเกินกว่าจะใส่ในรายงาน</p>`; }
    else { const j=clientSeqSim(s, 16);
      if(j.ok){ const sq=j.sequence;
        body+=`<h3>การทำงานทีละ clock (16 clock แรก)</h3>`+tbl(["clock", ...sq.inputs, ...sq.outputs], sq.rows.map(r=>[String(r[0]), ...r[1].map(String), ...(r[4]||r[3]).map(String)])); } }
    if(s.fsm && s.fsm.model){ try{ body+=`<h3>State diagram</h3>${fsmSvg(s.fsm.model)}${fsmTableHtml(s.fsm.model)}`; }catch(_){} }
    if(s.spec){ const r=specCheck(s); body+=`<h3>ข้อกำหนด (acceptance test)</h3><p>${esc2(specDescribe(s.spec))} — <b>${r&&r.pass?"✓ ผ่าน":"✗ ไม่ผ่าน"}</b></p>`; }
    if(sheetVerified(s)) body+=`<p class="muted">ตรวจแล้ว: ${esc2(s.verified.how)}</p>`;
    const pm=s.pinmap&&Object.keys(s.pinmap).length ? s.pinmap : null;
    if(pm) body+=`<h3>ขาบนบอร์ด EDGE Spartan-7</h3>`+tbl(["สัญญาณ","ขาบอร์ด","package pin"], Object.entries(pm).map(([k,v])=>[k, String(v), (typeof BOARD_PINS==="object"&&BOARD_PINS[v])||""]));
    let pic=""; try{ pic=reportSheetSvg(s); }catch(e){ pic=`<p class="muted">(วาดรูปไม่ได้: ${esc2(e.message)})</p>`; }
    return `<section><h2>${i+1}. ${esc2(s.name)}${s.id===P.topId?" (top)":""}</h2><div class="pic">${pic}</div>${body}</section>`;
  }).join("");
  let vhdl=""; if(opts.vhdl!==false){ try{ vhdl=`<section><h2>VHDL</h2><pre>${esc(bundleAll(generateAllVhdl()))}</pre></section>`; }catch(_){} }
  const d=new Date();
  return `<!doctype html><html><head><meta charset="utf-8"><title>รายงาน ${esc(name)}</title>
<style>body{font-family:"Sarabun","TH Sarabun New","Leelawadee UI",sans-serif;max-width:900px;margin:24px auto;padding:0 18px;color:#111;line-height:1.5}
h1{font-size:24px;margin:0 0 4px}h2{font-size:19px;border-bottom:2px solid #333;padding-bottom:3px;margin-top:28px}h3{font-size:15px;margin:14px 0 4px}
table{border-collapse:collapse;margin:4px 0 8px;font-size:13px}th,td{border:1px solid #999;padding:2px 8px;text-align:center}th{background:#eee}
pre{font-size:11px;background:#f6f6f6;border:1px solid #ccc;padding:8px;white-space:pre-wrap}.muted{color:#555;font-size:13px}.pic svg{border:1px solid #ccc}
.meta td{text-align:left;border:none;padding:1px 10px 1px 0}[contenteditable]{background:#fffbe6;min-width:160px;display:inline-block}
.bar{position:sticky;top:0;background:#fff;padding:6px 0;border-bottom:1px solid #ddd;margin-bottom:10px}@media print{.bar{display:none}[contenteditable]{background:none}section{page-break-inside:avoid}}</style></head>
<body><div class="bar"><button onclick="print()">พิมพ์ / บันทึกเป็น PDF</button> <span class="muted">คลิกช่องสีเหลืองเพื่อกรอกชื่อ/รหัส ก่อนพิมพ์</span></div>
<h1>รายงานการทดลอง: ${esc(name)}</h1>
<table class="meta"><tr><td>ชื่อ-สกุล</td><td contenteditable="true">&nbsp;</td></tr><tr><td>รหัสนักศึกษา</td><td contenteditable="true">&nbsp;</td></tr>
<tr><td>วันที่</td><td>${d.toLocaleDateString("th-TH",{year:"numeric",month:"long",day:"numeric"})}</td></tr><tr><td>บอร์ด</td><td>EDGE Spartan-7 (XC7S15)</td></tr></table>
${sec}${vhdl}<p class="muted">สร้างโดย FPGA Ecosystem — Schematic Studio</p></body></html>`;
}
async function makeReport(opts){
  const html=reportHtml(opts), name=sanId(($("#projectName")||{}).value||state.project.name||"project");
  let saved=null;
  if(/^https?:/.test(location.protocol)){ try{ saved=await mcpSaveFile(name, name+"_report.html", html); }catch(_){} }
  return {html, saved};
}
GENERATORS.push({id:"report", icon:"📄", name:"ทำรายงานแลป", desc:"รูปวงจรทุกชั้น, ตารางความจริง, สมการ, ผลทีละ clock, ขาบอร์ด, VHDL — พิมพ์เป็น PDF หรือเปิดใน Word", run:async()=>{
  const r=await makeReport({});
  const blob=new Blob([r.html], {type:"text/html"}), url=URL.createObjectURL(blob);
  const w=window.open(url, "_blank");
  if(!w){ const a=document.createElement("a"); a.href=url; a.download=sanId(state.project.name||"project")+"_report.html"; a.click(); }
  // Word opens an HTML file named .doc as a document
  const doc=new Blob(["﻿"+r.html.replace('<div class="bar">','<div class="bar" style="display:none">')], {type:"application/msword"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(doc); a.download=sanId(state.project.name||"project")+"_report.doc"; a.textContent="report.doc";
  toast(r.saved?`บันทึกรายงานลงโฟลเดอร์โปรเจกต์แล้ว (${r.saved})`:"เปิดรายงานในแท็บใหม่แล้ว — พิมพ์เป็น PDF ได้จากปุ่มบนหน้า", "ok", 6000);
  setTimeout(()=>{ try{ a.click(); }catch(_){} }, 300);
}});
{
  const last=[...document.querySelectorAll('#menu [data-gen]')].pop();
  if(last && !document.querySelector('#menu [data-gen="report"]')){
    last.insertAdjacentHTML("afterend", `<button class="gen-mi" data-gen="report" title="รายงานแลปจากงานในโปรเจกต์นี้"><span class="gi">📄</span>ทำรายงานแลป…</button>`);
    document.querySelector('#menu [data-gen="report"]').addEventListener("click", ()=>runGenerator("report"));
  }
}
MCP_OPS.make_report = async a=>{
  const sheets=a.sheets&&a.sheets.length ? a.sheets.map(n=>mcpSheet(n)) : null;
  const r=await makeReport({sheets, vhdl:a.vhdl});
  return {saved:r.saved||null, sheets:(sheets||reportSheets()).map(s=>s.name), size_kb:Math.round(r.html.length/1024),
    note:r.saved?"the user opens it from the project folder and prints to PDF":"(not saved: the editor was opened from disk)"};
};
