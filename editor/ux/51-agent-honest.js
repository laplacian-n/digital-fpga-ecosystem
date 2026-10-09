/* ===== 51. The agent's answer, kept honest ====================================================
   From the div25 rewiring run with SFT1 (200 s, 7 model calls): build_hierarchy succeeded, then the model
   answered in words only. The app nudged "not verified yet" twice and "not checked against the request"
   once — each answered with more words and no call, ~30 s apiece — and the last answer read
   "ตรวจกับข้อกำหนดจากคำขอ: ผ่านครบ 1,000 จาก 1,000行 … (หารความถี่เข้าด้วย 50)": no check had run, the
   sheet is ÷25, and a Chinese character sat in the Thai. The ⚠ banner (49) only covered runs with no
   tool at all. So:
     - a nudge the model answers with no call is not repeated: the app runs `check` (and `check_spec` when
       the sheet has a spec) itself and says plainly what was and was not checked (aiagUnansweredFinish);
     - an answer that claims a pass with no real check after the last change gets a ⚠ in front
       (aiagClaimGuard) — counting simulate / probe / verify_truth_table / compare_sheets / check_spec
       (not NO SPEC, not pass:null);
     - Chinese / Japanese / Korean characters are taken out of a Thai answer (aiagScrubLang). */
const AH_CHECKS = new Set(["simulate","probe","verify_truth_table","check_spec","compare_sheets","derive_spec"]);
const AH_CLAIM = /ตรวจ(สอบ)?\s*(แล้ว\s*)?(ก็\s*)?ผ่าน|ผ่าน\s*(ครบ|ทุก|หมด)|ผ่าน\s*[\d,]+\s*(จาก|\/)\s*[\d,]+|[\d,]+\s*(จาก|\/)\s*[\d,]+\s*(แถว|กรณี|ขั้น|clock|รอบ)|จำลอง(แล้ว)?\s*(ก็\s*)?(ถูก|ตรง|ผ่าน|ได้ผลถูก)|ถูกต้อง\s*(ทุก|ครบ)|ตรง\s*(ทุก|ครบ)|ยืนยันแล้ว|\b(verified|all tests? pass|passed|passes)\b/i;
const AH_CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿ｦ-ﾟ]/g;

/* a real check after the last change (a check the run's own table answered does not count) */
function aiagCheckedAfterEdit(run){
  const st=(run.steps||[]).filter(s=>s.kind==="tool" && s.ok);
  let lastEdit=-1; st.forEach((s,i)=>{ if(AIAG_EDIT_OPS.has(s.tool) || /^build_/.test(s.tool)) lastEdit=i; });
  return st.slice(lastEdit+1).some(s=>AH_CHECKS.has(s.tool) && !/^NO SPEC/.test(s.summary||"")
    && !/"pass":null|"checked":false|"independent":false|"pending":true/.test(s.result||""));
}
function aiagClaimGuard(run, final){
  const t=String(final||"");
  if(run.verified || !AH_CLAIM.test(t) || aiagCheckedAfterEdit(run) || /^⚠/.test(t)) return t;
  run.steps.push({kind:"nudge", text:"the answer claims a pass, but nothing checked the circuit after the last change — flagged"});
  return "⚠ คำตอบด้านล่างบอกว่าตรวจผ่าน แต่หลังการแก้ครั้งล่าสุดไม่มีขั้นตอนไหนตรวจวงจรจริง (ไม่มี simulate / probe / check_spec / verify_truth_table) — ตัวเลขผลตรวจในข้อความจึงเชื่อไม่ได้\n\n"+t;
}
function aiagScrubLang(run, text){
  const t=String(text||""); if(!/[฀-๿]/.test(t)) return t;      // only a Thai answer
  const n=(t.match(AH_CJK)||[]).length; if(!n) return t;
  run.steps.push({kind:"nudge", text:`${n} Chinese/Japanese/Korean character(s) removed from the Thai answer`});
  return t.replace(AH_CJK, "").replace(/[ \t]{2,}/g, " ");
}
/* the model was nudged and answered with words again: stop here, check what the app can check itself */
async function aiagUnansweredFinish(run, content, needCheck, needSim){
  const sheets=[...new Set([...needCheck, ...needSim, ...(run.verified?[]:run.touched||[])])]
    .filter(n=>Object.values(state.project.schematics).some(s=>s.name===n));
  run.steps.push({kind:"nudge", text:"the nudge got no tool call — not repeated; the app ran its own check"+(sheets.length?" on "+sheets.join(", "):"")});
  const lines=[];
  for(const n of sheets){
    const s=Object.values(state.project.schematics).find(x=>x.name===n);
    try{ const c=MCP_OPS.check({sheet:n});
      const st={kind:"tool", tool:"check", args:{sheet:n}, ok:true, by_app:true, summary:`by the app: ${c.errors} error(s), ${c.warnings} warning(s)`};
      run.steps.push(st); aiagLine(aiagStepHtml(st), "step");
      let line=`แผ่น ${n}: ตรวจการต่อสาย error ${c.errors} · warning ${c.warnings}`+(c.errors?" — "+c.issues.filter(i=>i.level==="error").slice(0,3).map(i=>i.msg||i.message||i.text||"").filter(Boolean).join("; "):"");
      if(s && s.spec && typeof MCP_OPS.check_spec==="function"){ const k=MCP_OPS.check_spec({sheet:n});
        run.steps.push({kind:"tool", tool:"check_spec", args:{sheet:n}, ok:true, by_app:true, summary:"by the app: "+(k.pass===true?"pass":k.pass===false?"FAIL":"not checked"),
          result:aiagClip(JSON.stringify(k), 600)});
        line+=k.pass===true ? " · ✓ ผ่านข้อกำหนดของแผ่น" : k.pass===false ? " · ✗ ไม่ผ่านข้อกำหนดของแผ่น" : ""; }
      lines.push(line); }catch(e){ lines.push(`แผ่น ${n}: ตรวจไม่ได้ (${e.message||e})`); }
  }
  const said=String(content||"").trim();
  return "⚠ เอเจนต์สร้าง/แก้วงจรแล้ว แต่ไม่ได้เรียกเครื่องมือตรวจเอง (เตือนไปแล้วก็ยังไม่เรียก — หยุดแทนการวนเตือนต่อ)\n"+
    (lines.length ? "แอปตรวจให้เอง:\n"+lines.join("\n")+"\n" : "")+
    "ยังไม่มีการจำลองว่าวงจรทำงานตรงตามที่ขอ — เปิดหน้าจำลองดูเอง หรือสั่งใหม่ว่า \"จำลองแผ่น "+(sheets[0]||"…")+"\""+
    (said ? "\n\nข้อความจากโมเดล (ยังไม่ได้ตรวจ):\n"+said : "");
}
