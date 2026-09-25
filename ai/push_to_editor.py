"""
push_to_editor.py - hand a VERIFIED Intent-JSON to the gate editor and let the
editor's OWN engine (drawIntent -> buildSchematicFromIntent -> autoRouteSheet, the
master-level router) compute the geometry, then capture the placed+routed project
as a native .schproj.json the editor can open (and the guarantee metrics).

This is the AI-pipeline -> drawing-program bridge. The LLM/pipeline only ever
emits topology; ALL x/y + wire routing come from the editor's deterministic
engine (the architecture's core rule). We drive the editor headless (Chrome) so
this runs without a human, writing designs_gate/<name>.schproj.json + latest.json
(the editor's "Sync" button / open-file loads it).
"""
from __future__ import annotations
import html as _html
import json
import re
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
EDITOR = PROJECT / "schematic&bus2vhdl.html"
DESIGNS = PROJECT / "designs_gate"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

_RUNNER = r"""
<script>
window.addEventListener('load', function(){
  var tries = 0;
  function dump(o){ var d=document.createElement('div'); d.id='__RESULT__';
    d.textContent = JSON.stringify(o); document.body.appendChild(d); }
  function metric(fn, s){ try{ return fn(s).length; }catch(e){ return -1; } }
  function go(){
    tries++;
    if((typeof drawIntent!=='function' || !window.state || !state.project) && tries < 200){
      return setTimeout(go, 50); }
    try{
      var r = drawIntent(window.__INTENT__);
      if(!r || !r.ok){ dump({ok:false, errors:(r&&r.errors)||['drawIntent failed']}); return; }
      if(typeof openSchTab==='function') openSchTab(r.id);
      if(typeof renderAll==='function') renderAll();
      try{ if(typeof zoomFit==='function') zoomFit(); }catch(e){}
      var s = state.project.schematics[r.id];
      var g = { self: metric(netSelfOverlaps,s), coll: metric(netCollinearOverlaps,s),
                body: metric(wireBodyCrossings,s), pin: metric(wirePinCrossings,s) };
      dump({ok:true, id:r.id, name:s.name, comps:s.components.length,
            wires:s.wires.length, guarantees:g, project: serialize()});
    }catch(e){ dump({ok:false, error:String(e), stack:String(e&&e.stack||'')}); }
  }
  go();
});
</script>
"""


def _extract(dom: str):
    m = re.search(r'<div id="__RESULT__">(.*?)</div>', dom, re.S)
    if not m:
        return None
    return json.loads(_html.unescape(m.group(1)))


def draw_intent(intent: dict, name: str | None = None, save: bool = True,
                timeout: float = 60.0) -> dict:
    if not EDITOR.exists():
        return {"ok": False, "error": f"editor not found: {EDITOR}"}
    html_src = EDITOR.read_text(encoding="utf-8")
    inject = ("<script>window.__INTENT__ = " + json.dumps(intent) + ";</script>\n" + _RUNNER)
    # inject before </body> (fall back to end of file)
    if "</body>" in html_src:
        page = html_src.replace("</body>", inject + "\n</body>", 1)
    else:
        page = html_src + inject
    tmp = Path(tempfile.mkdtemp(prefix="editor_")) / "editor.html"
    tmp.write_text(page, encoding="utf-8")
    url = tmp.as_uri()
    try:
        p = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
                            "--hide-scrollbars", "--virtual-time-budget=20000",
                            "--run-all-compositor-stages-before-draw", "--dump-dom", url],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "headless editor timeout"}
    res = _extract(p.stdout or "")
    if not res:
        return {"ok": False, "error": "no __RESULT__ in DOM (editor didn't run)",
                "stdout_tail": (p.stdout or "")[-400:], "stderr_tail": (p.stderr or "")[-400:]}
    if not res.get("ok"):
        return res
    out = {"ok": True, "id": res["id"], "name": res.get("name"),
           "comps": res["comps"], "wires": res["wires"], "guarantees": res["guarantees"]}
    if save and res.get("project"):
        DESIGNS.mkdir(parents=True, exist_ok=True)
        fn = (name or intent.get("module") or "ai_design")
        fn = re.sub(r"[^\w.-]+", "_", fn).strip("_") or "ai_design"
        path = DESIGNS / (fn + ".schproj.json")
        path.write_text(res["project"], encoding="utf-8")
        (DESIGNS / "latest.json").write_text(res["project"], encoding="utf-8")
        out["schproj"] = str(path)
        out["latest"] = str(DESIGNS / "latest.json")
    return out


if __name__ == "__main__":
    import sys
    intent = json.load(open(sys.argv[1], encoding="utf-8"))
    r = draw_intent(intent, name=sys.argv[2] if len(sys.argv) > 2 else None)
    print(json.dumps(r, ensure_ascii=False, indent=2))
