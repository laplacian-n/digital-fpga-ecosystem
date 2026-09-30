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
/* a timing diagram of the first clocks: 1-bit signals as high/low lines, buses as their value per clock */
function reportWaveSvg(sq, n){
  n=Math.min(n||16, sq.rows.length);
  const sig=[...sq.inputs.map((nm,k)=>({nm, v:r=>r[1][k]})), ...sq.outputs.map((nm,k)=>({nm, v:r=>(r[4]||r[3])[k]}))];
  const W=34, H=24, L=Math.max(40, 8*Math.max(...sig.map(s=>s.nm.length))+10), wid=L+W*n+10, hgt=H*(sig.length+1)+6;
  const one=s=>sq.rows.slice(0,n).every(r=>{ const x=+s.v(r); return x===0||x===1; });
  let g=`<text x="4" y="16" font-size="11" fill="#555">clock</text>`+Array.from({length:n},(_,i)=>`<text x="${L+W*i+W/2}" y="16" font-size="10" text-anchor="middle" fill="#555">${i}</text><line x1="${L+W*i}" y1="20" x2="${L+W*i}" y2="${hgt}" stroke="#eee"/>`).join("");
  sig.forEach((s,k)=>{ const y=H*(k+1)+4, hi=y+3, lo=y+H-5;
    g+=`<text x="4" y="${y+H/2+4}" font-size="12" font-family="monospace">${esc(s.nm)}</text>`;
    if(one(s)){ let d=""; sq.rows.slice(0,n).forEach((r,i)=>{ const yy=+s.v(r)?hi:lo; d+=(i?` L${L+W*i},${yy}`:`M${L},${yy}`)+` L${L+W*(i+1)},${yy}`; });
      g+=`<path d="${d}" fill="none" stroke="#1d4ed8" stroke-width="1.6"/>`; }
    else sq.rows.slice(0,n).forEach((r,i)=>{ const x=L+W*i; g+=`<path d="M${x+2},${(hi+lo)/2} L${x+5},${hi} L${x+W-5},${hi} L${x+W-2},${(hi+lo)/2} L${x+W-5},${lo} L${x+5},${lo} Z" fill="#f1f5f9" stroke="#1d4ed8"/><text x="${x+W/2}" y="${(hi+lo)/2+4}" font-size="10" text-anchor="middle">${esc(String(s.v(r)))}</text>`; });
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${wid}" height="${hgt}" viewBox="0 0 ${wid} ${hgt}" style="max-width:100%;background:#fff">${g}</svg>`;
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
        body+=`<h3>การทำงานทีละ clock (16 clock แรก)</h3>`+tbl(["clock", ...sq.inputs, ...sq.outputs], sq.rows.map(r=>[String(r[0]), ...r[1].map(String), ...(r[4]||r[3]).map(String)]));
        try{ body+=`<h3>ไทมิ่งไดอะแกรม</h3><div class="wave">${reportWaveSvg(sq, 16)}</div>`; }catch(_){} } }
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
  opts=opts||{};
  const html=reportHtml(opts), name=sanId(($("#projectName")||{}).value||state.project.name||"project");
  let saved=null, pdf=null, pdfError=null;
  if(/^https?:/.test(location.protocol)){ try{ saved=await mcpSaveFile(name, name+"_report.html", html); }catch(_){}
    // the PDF, printed by the app's own browser (Edge on Windows) — no print dialog for the student
    if(saved && opts.pdf!==false){ try{ const r=await aiagPost("/api/report/pdf", {path:name+"/"+name+"_report.html"}); if(r.ok) pdf=r.path; else pdfError=r.error; }catch(e){ pdfError=e.message; } } }
  return {html, saved, pdf, pdf_error:pdfError||undefined};
}
GENERATORS.push({id:"report", icon:"📄", name:"ทำรายงานแลป", desc:"รูปวงจรทุกชั้น, ตารางความจริง, สมการ, ผลทีละ clock, ขาบอร์ด, VHDL — พิมพ์เป็น PDF หรือเปิดใน Word", run:async()=>{
  const r=await makeReport({});
  const blob=new Blob([r.html], {type:"text/html"}), url=URL.createObjectURL(blob);
  const w=window.open(url, "_blank");
  if(!w){ const a=document.createElement("a"); a.href=url; a.download=sanId(state.project.name||"project")+"_report.html"; a.click(); }
  // Word opens an HTML file named .doc as a document
  const doc=new Blob(["﻿"+r.html.replace('<div class="bar">','<div class="bar" style="display:none">')], {type:"application/msword"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(doc); a.download=sanId(state.project.name||"project")+"_report.doc"; a.textContent="report.doc";
  toast(r.pdf?`บันทึกรายงานเป็น PDF แล้ว (${r.pdf})`:r.saved?`บันทึกรายงานลงโฟลเดอร์โปรเจกต์แล้ว (${r.saved})`+(r.pdf_error?` — PDF: ${r.pdf_error}`:""):"เปิดรายงานในแท็บใหม่แล้ว — พิมพ์เป็น PDF ได้จากปุ่มบนหน้า", "ok", 7000);
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
  const r=await makeReport({sheets, vhdl:a.vhdl, pdf:a.pdf});
  return {saved:r.saved||null, pdf:r.pdf||null, pdf_error:r.pdf_error, sheets:(sheets||reportSheets()).map(s=>s.name), size_kb:Math.round(r.html.length/1024),
    note:r.pdf?"the PDF is in the project folder next to the .html":r.saved?"the user opens the .html from the project folder and prints to PDF":"(not saved: the editor was opened from disk)"};
};
