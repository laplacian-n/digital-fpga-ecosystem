/* shim.js - injected by the FPGA Ecosystem launcher into the editor pages.
   The editors stay plain single-file HTML (they still work opened from disk);
   this only adds app behaviour when they are served by the launcher:
     - downloads (save project, export VHDL/XDC, components ...) go into the
       project's folder in the workspace instead of the browser's Downloads;
     - ?open=<project>/<file> loads a project from the workspace on start;
     - the AI chat points at this same server (no /endpoint needed);
     - a heartbeat keeps the launcher alive while a window is open. */
(function(){
  "use strict";
  if (window.__feShim) return;
  window.__feShim = true;

  var saveToWorkspace = true;
  fetch("/api/config").then(function(r){ return r.json(); })
    .then(function(c){ saveToWorkspace = c.save_to_workspace !== false; }).catch(function(){});

  // AI chat -> this server (ai/chat_server routes are mounted here)
  try { localStorage.setItem("schstudio.aiUrl", location.origin); } catch(_){}

  function ping(){ fetch("/api/ping", {cache:"no-store"}).catch(function(){}); }
  if (window === window.top) { ping(); setInterval(ping, 15000); }

  function note(msg, kind){
    try { if (typeof window.toast === "function") return window.toast(msg, kind || "ok", 3600); } catch(_){}
    var d = document.createElement("div");
    d.textContent = msg;
    d.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:99999;padding:10px 14px;" +
      "border-radius:8px;font:13px system-ui,sans-serif;color:#fff;max-width:60vw;" +
      "background:" + (kind === "err" ? "#b3261e" : "#1f6f43") + ";box-shadow:0 4px 16px #0005";
    document.body.appendChild(d);
    setTimeout(function(){ d.remove(); }, 3600);
  }

  function projectName(){
    var docs = [document];
    try { if (window.parent !== window) docs.push(window.parent.document); } catch(_){}
    for (var i = 0; i < docs.length; i++) {
      var el = docs[i].querySelector("#projectName");
      if (el && el.value) return el.value;
    }
    return "untitled";
  }

  // keep blobs reachable: the editor revokes the object URL right after a.click()
  var blobs = new Map();
  var createURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function(obj){
    var u = createURL(obj);
    if (obj instanceof Blob) {
      blobs.set(u, obj);
      setTimeout(function(){ blobs.delete(u); }, 120000);
    }
    return u;
  };

  function isFileDownload(a){
    var href = a.getAttribute("href") || "";
    return a.hasAttribute("download") && (href.indexOf("blob:") === 0 || href.indexOf("data:") === 0);
  }

  function saveToProject(a, fallback){
    // the editor stamps names (20260925093012foo.vhd) so Downloads never collide;
    // in a project folder a save should replace the previous copy instead
    var href = a.href, name = (a.getAttribute("download") || "file").replace(/^\d{14}/, "") || "file";
    var b = blobs.get(href);
    var data = b ? Promise.resolve(b) : fetch(href).then(function(r){ return r.blob(); });
    var proj = projectName();
    data.then(function(blob){
      // a project file saved into a project folder holds that project only (not the whole workspace)
      if (/\.schproj\.json$/i.test(name) && typeof window.uxProjectOnlyJson === "function")
        return blob.text().then(function(t){ return new Blob([window.uxProjectOnlyJson(t)], {type: "application/json"}); });
      return blob;
    }).then(function(blob){
      return fetch("/api/files/save?project=" + encodeURIComponent(proj) +
                   "&name=" + encodeURIComponent(name), {method:"POST", body: blob});
    }).then(function(r){ return r.json(); }).then(function(j){
      if (!j.ok) throw new Error(j.error || "save failed");
      note("บันทึกลงโฟลเดอร์โปรเจกต์: " + j.project + "/" + j.name, "ok");
    }).catch(function(e){
      note("บันทึกลง workspace ไม่ได้ (" + e.message + ") — ดาวน์โหลดแทน", "err");
      fallback();
    });
  }

  var nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function(){
    var a = this;
    if (saveToWorkspace && isFileDownload(a)) {
      return saveToProject(a, function(){ nativeClick.call(a); });
    }
    return nativeClick.call(a);
  };
  // links the user clicks directly (attached to the DOM)
  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest && e.target.closest("a[download]");
    if (!a || !saveToWorkspace || !isFileDownload(a) || a.__feNative) return;
    e.preventDefault();
    saveToProject(a, function(){ a.__feNative = true; nativeClick.call(a); a.__feNative = false; });
  }, true);

  // ?open=<project>/<file>.schproj.json  -> load from the workspace
  var open = new URLSearchParams(location.search).get("open");
  if (open) {
    window.addEventListener("load", function(){
      setTimeout(function(){
        fetch("/api/files/read?path=" + encodeURIComponent(open))
          .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
          .then(function(txt){
            if (typeof window.deserialize !== "function") throw new Error("editor not ready");
            // a file from before 1.1.1 may hold several projects: load the one this folder is for
            if (typeof window.uxProjectFromFile === "function") txt = window.uxProjectFromFile(txt, open.split(/[\\/]/)[0]);
            window.deserialize(txt);
            note("เปิดโปรเจกต์ " + open, "ok");
          })
          .catch(function(e){ note("เปิดโปรเจกต์ไม่ได้: " + e.message, "err"); });
      }, 50);
    });
  }

  // ?new=<name>  -> a new project with that name (Home's "สร้าง", or an empty project folder's
  // "เปิด"), saved once right away so its file sits in the workspace folder of the same name
  var fresh = new URLSearchParams(location.search).get("new");
  if (fresh) {
    window.addEventListener("load", function(){
      setTimeout(function(){
        try {
          if (typeof window.addProject !== "function") throw new Error("editor not ready");
          // already in the editor (restored from last time)? use it, don't make "lab6_2"
          var st = window.state, p = null;
          if (st && st.projects) for (var k in st.projects) if (st.projects[k].name === fresh) p = st.projects[k];
          if (p) window.switchProject(p.id); else p = window.addProject(fresh);
          var pn = document.getElementById("projectName"); if (pn) pn.value = p.name;
          if (typeof window.saveProjectToFile === "function") window.saveProjectToFile();
          note("สร้างโปรเจกต์ " + p.name + " แล้ว — เริ่มวาดได้เลย (บันทึกลงโฟลเดอร์ " + p.name + ")", "ok");
        } catch (e) { note("สร้างโปรเจกต์ไม่ได้: " + e.message, "err"); }
      }, 50);
    });
  }

  document.title = document.title + " — FPGA Ecosystem";
})();
