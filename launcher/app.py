"""
app.py - FPGA Ecosystem launcher: one program that runs everything.

Double-click (FPGAEcosystem.exe, or `python launcher/app.py`) and it:
  * starts ONE local server (127.0.0.1:8770) that serves the editors AND the
    Python backend (AI chat / netlist sim, i.e. ai/chat_server.py) - no separate
    "run python ..." step, no pip install (the backend is pure stdlib);
  * opens the Home window (projects + settings) as a chromeless app window
    (Edge/Chrome --app), from which Schematic Studio / Top-Down / FPGA Builder
    open as their own windows;
  * keeps every project in one folder (default: Documents/FPGA Ecosystem/Projects).
    Downloads inside the editors (save project, export VHDL/XDC, ...) are written
    into that project's folder instead of the browser's Downloads;
  * feature switches (AI chat, LLM, backend sim, GHDL cosim, FPGA build) live in
    Settings and are stored in the user's config (config.json), not in the repo.

It quits by itself ~2 minutes after the last window closes.

CLI:  app.py [--no-open] [--port N] [--fpga-builder]
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

APP_NAME = "FPGA Ecosystem"
APP_ID = "fpga-ecosystem"
VERSION = "2.2.0"

FROZEN = getattr(sys, "frozen", False)
# ROOT = where the bundled content lives (repo root in dev, _MEIPASS when frozen)
ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
INSTALL_DIR = Path(sys.executable).parent if FROZEN else ROOT
WEB = ROOT / "launcher" / "web"
EDITOR_HTML = ROOT / "schematic&bus2vhdl.html"
IS_WIN = os.name == "nt"


# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------
def _config_dir() -> Path:
    if IS_WIN:
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        return base / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / APP_ID


def _documents_dir() -> Path:
    if IS_WIN:
        try:  # the real "Documents" (may be redirected to OneDrive)
            import ctypes
            from ctypes import wintypes
            buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
            ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf)  # CSIDL_PERSONAL
            if buf.value:
                return Path(buf.value)
        except Exception:
            pass
    d = Path.home() / "Documents"
    return d if d.exists() else Path.home()


def _data_dir() -> Path:
    """per-machine data (models are GBs: never in the roaming profile)"""
    if IS_WIN:
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / APP_ID


CONFIG_DIR = _config_dir()
DATA_DIR = _data_dir()
CONFIG_FILE = CONFIG_DIR / "config.json"

DEFAULTS = {
    "workspace": str(_documents_dir() / APP_NAME),
    "port": 8770,                 # the editor's AI chat defaults to 127.0.0.1:8770
    "save_to_workspace": True,    # route editor downloads into the project folder
    "setup_done": False,          # the first-run "เริ่มต้นใช้งาน" checklist was dismissed
    "update": {
        "auto_check": True,       # look for a newer release when Home opens (at most every 12 h)
        "repo": "laplacian-n/digital-fpga-ecosystem",
        "api": "https://api.github.com",
        "skip": "",               # a version the user chose to skip
        "last_check": 0,
        "last_result": {},
    },
    "features": {
        "ai": True,               # AI chat panel backend (equations/truth tables work offline)
        "sim": True,              # backend netlist simulation (POST /sim)
        "llm": "off",             # off | endpoint | local
        "llm_endpoint": "http://127.0.0.1:8080/v1/chat/completions",
        "llama_server": "",       # path to llama-server(.exe) for llm=local
        "llama_model": "",        # path to a .gguf for llm=local
        "llama_args": "",         # blank = llm.DEFAULT_ARGS (context 64K, tool calls, layers fitted to the GPU)
        "cosim": False,           # GHDL co-simulation check
        "ghdl": "",               # path to ghdl(.exe); blank = auto-detect
        "fpga": True,             # FPGA Builder (VHDL -> .bit -> board)
        "vivado": "",             # path to vivado(.bat); blank = auto-detect
        "openfpgaloader": "",     # path to openFPGALoader(.exe); blank = bundled / PATH
    },
}


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(base.get(k), dict) and base[k]:
            out[k] = _merge(base[k], v)
        elif isinstance(v, dict) and base.get(k) == {}:
            out[k] = v                      # free-form dict (e.g. a cached update result)
        elif k in base:
            out[k] = v
    return out


def load_config() -> dict:
    try:
        return _merge(DEFAULTS, json.loads(CONFIG_FILE.read_text("utf-8")))
    except Exception:
        return json.loads(json.dumps(DEFAULTS))


def save_config(cfg: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(CONFIG_FILE)


CFG = load_config()


def projects_dir() -> Path:
    p = Path(CFG["workspace"]).expanduser() / "Projects"
    p.mkdir(parents=True, exist_ok=True)
    return p


# --------------------------------------------------------------------------
# tool detection
# --------------------------------------------------------------------------
def _first(paths) -> str:
    for p in paths:
        if p and Path(p).is_file():
            return str(p)
    return ""


def detect_ghdl() -> str:
    exe = "ghdl.exe" if IS_WIN else "ghdl"
    return _first([CFG["features"].get("ghdl"),
                   ROOT / "ai" / "tools" / "ghdl" / "bin" / exe,
                   INSTALL_DIR / "tools" / "ghdl" / "bin" / exe,
                   shutil.which("ghdl")])


def detect_vivado() -> str:
    cands = [CFG["features"].get("vivado"), os.environ.get("VIVADO_BIN")]
    if IS_WIN:
        for pat in (r"C:\AMD\Vivado\*\bin\vivado.bat", r"C:\Xilinx\Vivado\*\bin\vivado.bat",
                    r"C:\AMD\*\Vivado\bin\vivado.bat", r"C:\Xilinx\*\Vivado\bin\vivado.bat",
                    str(INSTALL_DIR / "tools" / "vivado_min" / "*" / "Vivado" / "bin" / "vivado.bat")):
            cands += sorted(glob.glob(pat), reverse=True)   # newest version first
        cands.append(r"C:\vivado_min\bin\vivado.bat")
    else:
        cands += sorted(glob.glob("/tools/Xilinx/Vivado/*/bin/vivado"), reverse=True)
        cands.append(shutil.which("vivado"))
    return _first(cands)


def detect_llama() -> tuple[str, str]:
    exe = "llama-server.exe" if IS_WIN else "llama-server"
    server = _first([CFG["features"].get("llama_server"), llm.find_server(),
                     ROOT / "ai" / "llama" / exe, INSTALL_DIR / "llama" / exe,
                     shutil.which("llama-server")])
    model = CFG["features"].get("llama_model") or ""
    if not Path(model).is_file():
        ggufs = (llm.installed_models() + sorted(glob.glob(str(ROOT / "ai" / "models" / "*.gguf"))
                 + glob.glob(str(INSTALL_DIR / "models" / "*.gguf"))))
        model = ggufs[0] if ggufs else ""
    return server, model


def find_browser() -> str:
    """Edge ships with every Windows 10/11, so --app windows work out of the box."""
    if os.environ.get("FE_BROWSER") and Path(os.environ["FE_BROWSER"]).is_file():
        return os.environ["FE_BROWSER"]
    if IS_WIN:
        pf = [os.environ.get(k) for k in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA")]
        rel = [r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe"]
        return _first([Path(b) / r for r in rel for b in pf if b])
    if sys.platform == "darwin":
        return _first(["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                       "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                       "/Applications/Chromium.app/Contents/MacOS/Chromium"])
    return _first([shutil.which(n) for n in ("microsoft-edge", "google-chrome",
                                             "chromium", "chromium-browser")])


# --------------------------------------------------------------------------
# backend (ai/chat_server.py) - imported in-process, gated by feature switches
# --------------------------------------------------------------------------
def _setup_backend_env():
    f = CFG["features"]
    if f.get("llm") in ("endpoint", "local") and f.get("llm_endpoint"):
        os.environ["AI_ENDPOINT"] = f["llm_endpoint"]
    elif f.get("llm") == "off":
        # point at a closed port so the chat reports "LLM off" instead of hanging
        os.environ["AI_ENDPOINT"] = "http://127.0.0.1:9/v1/chat/completions"
    viv = detect_vivado()
    if viv:
        os.environ["VIVADO_BIN"] = viv
    sys.path.insert(0, str(ROOT / "ai"))


BACKEND = None          # chat_server module, or None
BACKEND_ERROR = ""


def load_backend():
    global BACKEND, BACKEND_ERROR
    _setup_backend_env()
    try:
        import chat_server  # noqa: E402  (needs sys.path set above)
        BACKEND = chat_server
        # Q&A mode answers with the course notes (keyword search only: a question must not wait
        # for the embedding server)
        chat_server.ASK_NOTES = lambda q: (rag_search(q, k=chat_server.ASK_NOTES_K, semantic=False) or {}).get("hits") or []
        ghdl = detect_ghdl()
        if ghdl:
            try:
                import cosim
                cosim.GHDL = Path(ghdl)
            except Exception:
                pass
    except Exception as e:
        BACKEND_ERROR = f"{type(e).__name__}: {e}"
        traceback.print_exc()


import llm  # noqa: E402  local model: download llama.cpp + a .gguf, start/stop (Settings ▸ โมเดล AI)
llm.init(DATA_DIR, CONFIG_DIR / "llama-server.log")


def start_llama(force: bool = False) -> dict:
    f = CFG["features"]
    if f.get("llm") != "local" and not force:
        return {"ok": False, "error": "llm is not local"}
    server, model = detect_llama()
    if not (server and model):
        return {"ok": False, "error": "ยังไม่มี llama.cpp หรือไฟล์โมเดล"}
    args = (f.get("llama_args") or "").strip()
    if not args or args in llm.OLD_DEFAULT_ARGS:      # the old fixed -ngl 999 / 8K context
        args = llm.DEFAULT_ARGS
    return llm.start(server, model, f.get("llm_endpoint"), args)


def set_llm_endpoint(ep: str) -> None:
    """point the in-process backend at the model now (no restart): intent_client reads its
    endpoint from AI_ENDPOINT at import and bakes it into keyword defaults"""
    os.environ["AI_ENDPOINT"] = ep
    ic = sys.modules.get("intent_client")
    if not ic:
        return
    prev, ic.DEFAULT_ENDPOINT = ic.DEFAULT_ENDPOINT, ep
    for fn in list(vars(ic).values()):
        if not callable(fn):
            continue
        d = getattr(fn, "__defaults__", None)
        if d:
            fn.__defaults__ = tuple(ep if x == prev else x for x in d)
        kw = getattr(fn, "__kwdefaults__", None)
        if kw:
            for k, v in kw.items():
                if v == prev:
                    kw[k] = ep


_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def llm_chat(req: dict) -> dict:
    """The editor's agent → the local model (OpenAI chat/completions, tools included). Proxied so the
    page needs no CORS from llama-server, and so the endpoint in Settings is the one used."""
    ep = os.environ.get("AI_ENDPOINT") or CFG["features"]["llm_endpoint"]
    body = {k: v for k, v in req.items() if k in ("messages", "tools", "tool_choice", "temperature", "top_p",
                                                    "top_k", "max_tokens", "stop", "chat_template_kwargs",
                                                    "parallel_tool_calls")}
    body.setdefault("temperature", 0.6)
    if isinstance(body.get("messages"), list):      # one system message, first (Qwen3.5's template)
        sysm = [m for m in body["messages"] if m.get("role") == "system"]
        if len(sysm) > 1 or (sysm and body["messages"][0].get("role") != "system"):
            body["messages"] = [{"role": "system", "content": "\n\n".join(m.get("content") or "" for m in sysm)}] + \
                [m for m in body["messages"] if m.get("role") != "system"]
    t0 = time.time()
    restarted = False
    for attempt in (0, 1):
        try:
            r = urllib.request.Request(ep, data=json.dumps(body).encode("utf-8"), method="POST",
                                       headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(r, timeout=600) as resp:
                out = json.loads(resp.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as e:
            return {"ok": False, "error": f"model server: HTTP {e.code} {e.read()[:300].decode('utf-8', 'replace')}"}
        except Exception as e:
            # our own llama-server died mid-run (WinError 10054 — out of memory, a driver reset):
            # start it again and repeat THIS request once, so the agent's run carries on
            # (the process may still be exiting when its connection drops: give it a moment to show)
            dead = lambda: not llm.running() or llm.health(ep) == "down"
            if attempt == 0 and CFG["features"].get("llm") == "local":
                for _ in range(30):
                    if dead():
                        break
                    time.sleep(0.1)
            if attempt == 0 and CFG["features"].get("llm") == "local" and dead():
                if llm_restart():
                    restarted = True
                    continue
            return {"ok": False, "error": f"the model is not reachable at {ep}: {e}",
                    "hint": "start it in Settings ▸ โมเดล AI", "log_tail": llm.log_tail(12)}
    out["ok"] = True
    out["elapsed_s"] = round(time.time() - t0, 2)
    if restarted:
        out["restarted"] = True
    return out


def llm_restart(wait: float = 180) -> bool:
    """Start the local model again and wait until it answers."""
    if not start_llama().get("ok"):
        return False
    end = time.time() + wait
    while time.time() < end:
        st = llm.state(CFG["features"]["llm_endpoint"])
        if st == "ready":
            return True
        if st == "crashed":
            return False
        time.sleep(1)
    return False


# RAG over the course material in ai/rag (chapters, lab sheets with solutions, board pinout,
# checked VHDL): the index is not in git (it used to be missing from every installer too), so it
# is built on first use from the sources that ship with the app, and searched with BM25.
_RAG = {"r": None, "err": ""}
_RAG_LOCK = threading.Lock()


def rag_retriever():
    with _RAG_LOCK:
        if _RAG["r"] is None and not _RAG["err"]:
            try:
                rag = ROOT / "ai" / "rag"
                if str(rag) not in sys.path:
                    sys.path.insert(0, str(rag))
                import retriever as _rtv
                # also when a source is newer than the index (a corrected lab solution must not keep
                # reaching the agent from an old index)
                newest = max((f.stat().st_mtime for f in rag.rglob("*") if f.is_file() and f.suffix in (".json", ".md", ".txt", ".vhd")
                              and f.name != _rtv.INDEX.name and "emb" not in f.name), default=0)
                if not _rtv.INDEX.exists() or newest > _rtv.INDEX.stat().st_mtime:
                    import build_index as _bi
                    try:
                        _bi.main()
                    except Exception:
                        if not _rtv.INDEX.exists():     # a read-only install keeps the index it shipped with
                            raise
                _RAG["r"] = _rtv.Retriever()
            except Exception as e:
                _RAG["err"] = f"{type(e).__name__}: {e}"
        return _RAG["r"]


# semantic side (hybrid): document vectors from the embedding model, computed once per index and
# cached in the data folder; a query is embedded with the instruction Qwen3-Embedding expects
RAG_Q_INSTRUCT = "Instruct: Given a question about a digital logic course, retrieve the course notes that answer it\nQuery: "
_EMB = {"vecs": None, "key": "", "err": "", "busy": False, "done": 0, "total": 0}
_EMB_LOCK = threading.Lock()


def rag_vectors(r):
    """(doc vectors | None, why not). Starts the embedding server when the model is installed."""
    if not llm.embed_path().is_file():
        return None, "no embedding model (Settings ▸ โมเดล AI ▸ ค้นแบบความหมาย)"
    import hashlib
    key = hashlib.sha1(("\n".join(d["id"] for d in r.docs) + llm.EMBED["file"]).encode()).hexdigest()[:16]
    if _EMB["key"] == key and _EMB["vecs"] is not None:
        return _EMB["vecs"], ""
    cache = DATA_DIR / f"rag-emb-{key}.json"
    try:
        vecs = json.loads(cache.read_text("utf-8"))
        if len(vecs) != len(r.docs):
            raise ValueError("stale")
        _EMB.update(vecs=vecs, key=key)
        return vecs, ""
    except Exception:
        pass
    # not indexed yet: embedding every document is a minute or more of CPU. It used to happen INSIDE
    # the first search — the agent's first turn waited on it and the whole machine crawled. Now it
    # runs in the background and keyword search answers meanwhile.
    with _EMB_LOCK:
        if not _EMB["busy"]:
            _EMB.update(busy=True, done=0, total=len(r.docs), err="")
            threading.Thread(target=_rag_index, args=(r, key, cache), daemon=True).start()
    return None, (f"semantic index being built in the background ({_EMB['done']}/{_EMB['total']})"
                  + (f" — last error: {_EMB['err']}" if _EMB["err"] else "") + "; keyword search meanwhile")


def _embed_ready(wait: float) -> bool:
    """Start the embedding server if needed and wait (≤ wait s) until it answers."""
    server, _ = detect_llama()
    if not llm.embed_running() and not llm.start_embed(server).get("ok"):
        return False
    base = llm.embed_endpoint().rsplit("/v1/", 1)[0]
    end = time.time() + wait
    while time.time() < end:
        try:
            with urllib.request.urlopen(base + "/health", timeout=1) as h:
                if h.status == 200:
                    return True
        except Exception:
            pass
        if not llm.embed_running():
            return False
        time.sleep(0.3)
    return False


def _rag_index(r, key, cache):
    try:
        if not _embed_ready(300):
            raise RuntimeError("the embedding server did not start (see llama-embed.log)")
        vecs = []
        texts = [((d.get("title") or "") + "\n" + (d.get("text") or ""))[:2000] for d in r.docs]
        for i in range(0, len(texts), 16):
            vecs += llm.embed(texts[i:i + 16], timeout=600)
            _EMB["done"] = len(vecs)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(vecs), "utf-8")
        _EMB.update(vecs=vecs, key=key)
    except Exception as e:
        _EMB["err"] = f"{type(e).__name__}: {e}"
    finally:
        _EMB["busy"] = False


def rag_search(query: str, k: int = 5, group: str = "", semantic: bool = True) -> dict:
    r = rag_retriever()
    if r is None:
        return {"ok": False, "error": "course notes (RAG) unavailable: " + _RAG["err"]}
    k = max(1, min(12, int(k or 5)))
    bm = r.search(query or "", k=50, group=group or None, hybrid=False)
    ranks = {}                                  # doc row -> [bm25 rank, cosine rank]
    for i, h in enumerate(bm):
        ranks[r.id2row[h["id"]]] = [i, None]
    mode, why = "bm25", ""
    if semantic:
        try:
            vecs, why = rag_vectors(r)
            if vecs and not _embed_ready(20):          # (after an app restart the cached vectors are there, the server not yet)
                vecs, why = None, "embedding model still loading — keyword search this time"
            if vecs:
                qv = llm.embed([RAG_Q_INSTRUCT + (query or "")])[0]
                sims = sorted(((sum(a * b for a, b in zip(qv, v)), i) for i, v in enumerate(vecs)
                               if not group or r.docs[i]["group"] == group), reverse=True)[:50]
                for j, (_, i) in enumerate(sims):
                    ranks.setdefault(i, [None, None])[1] = j
                mode = "hybrid"
        except Exception as e:
            why = f"semantic search failed: {e}"
    # reciprocal rank fusion (as ai/rag/retriever.py does with fastembed)
    fused = sorted(((sum(1.0 / (60 + x) for x in rk if x is not None), i) for i, rk in ranks.items()), reverse=True)[:k]
    out = []
    for _, i in fused:
        rec = r.docs[i]
        out.append({"title": rec.get("title", ""), "group": rec["group"], "source": rec.get("source", ""),
                    "topic": rec.get("topic") or "", "text": (rec.get("text") or "")[:1500]})
    res = {"ok": True, "query": query, "records": r.N, "mode": mode, "hits": out}
    if why and mode == "bm25":
        res["semantic"] = why
    return res


def agent_log(rec: dict) -> dict:
    """Every agent run, one JSON line per run: material for examples (RAG) and for finding what goes wrong."""
    d = CONFIG_DIR / "agent-runs"
    d.mkdir(parents=True, exist_ok=True)
    f = d / time.strftime("%Y-%m.jsonl")
    with open(f, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(dict(rec, t=time.time()), ensure_ascii=False) + "\n")
    return {"ok": True, "file": str(f)}


def llm_up() -> bool:
    try:
        u = urlparse(os.environ.get("AI_ENDPOINT") or CFG["features"]["llm_endpoint"])
        with socket.create_connection((u.hostname or "127.0.0.1", u.port or 80), timeout=0.4):
            return True
    except Exception:
        return False


# --------------------------------------------------------------------------
# windows
# --------------------------------------------------------------------------
PAGES = {
    "home": "/",
    "studio": "/studio.html",
    # Top-Down and the board build live inside Schematic Studio (one program, the circuit follows)
    "topdown": "/studio.html?view=topdown",
    "board": "/studio.html?view=board",
}


def base_url() -> str:
    return f"http://127.0.0.1:{SERVER_PORT}"


def open_window(page: str = "home", query: str = "") -> None:
    path = PAGES.get(page, "/")
    url = base_url() + path + ((("&" if "?" in path else "?") + query) if query else "")
    browser = find_browser()
    if browser:
        prof = CONFIG_DIR / "browser"
        prof.mkdir(parents=True, exist_ok=True)
        size = "1100,760" if page == "home" else "1440,900"
        subprocess.Popen([browser, f"--app={url}", f"--user-data-dir={prof}",
                          "--no-first-run", "--no-default-browser-check",
                          f"--window-size={size}"], creationflags=_NO_WINDOW)
    else:
        webbrowser.open(url)


def launch_fpga_builder() -> None:
    if FROZEN:
        cmd = [sys.executable, "--fpga-builder"]
    else:
        cmd = [sys.executable, str(ROOT / "FPGA_Builder_Package" / "source" / "fpga_builder.py")]
    subprocess.Popen(cmd, cwd=str(INSTALL_DIR))


def reveal(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if IS_WIN:
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


# --------------------------------------------------------------------------
# workspace files
# --------------------------------------------------------------------------
_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')


def safe_name(s: str, fallback: str = "untitled") -> str:
    s = _BAD.sub("_", (s or "").strip()).strip(". ")
    return s[:120] or fallback


def inside(base: Path, rel: str) -> Path:
    p = (base / rel).resolve()
    if base.resolve() not in (p, *p.parents):
        raise ValueError("path outside workspace")
    return p


def _project_name_in(f: Path) -> str:
    """the project name written inside a .schproj.json (the active project of an older multi-project file)"""
    try:
        o = json.loads(f.read_text(encoding="utf-8"))
        return str((o.get("project") or {}).get("name") or "")
    except Exception:
        return ""


def list_projects() -> list:
    out = []
    for d in projects_dir().iterdir():
        if not d.is_dir() or d.name.startswith("."):          # .trash holds deleted projects
            continue
        files = sorted((f for f in d.iterdir() if f.is_file()),
                       key=lambda f: f.stat().st_mtime, reverse=True)
        main = next((f for f in files if f.name.endswith(".schproj.json")), None)
        mtime = max([d.stat().st_mtime] + [f.stat().st_mtime for f in files])
        inner = _project_name_in(main) if main else ""
        out.append({"name": d.name, "mtime": mtime,
                    "main": f"{d.name}/{main.name}" if main else None,
                    "project_name": inner or None,
                    "name_mismatch": bool(inner and inner != d.name) or None,
                    "files": [{"name": f.name, "size": f.stat().st_size} for f in files[:50]]})
    out.sort(key=lambda p: p["mtime"], reverse=True)
    return out


def _pdf_browsers() -> list:
    """Edge first (every Windows has it), then Chrome, then whatever find_browser gives"""
    out = [find_browser()]
    if IS_WIN:
        pf = [os.environ.get(k) for k in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA")]
        for rel in (r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe"):
            out += [str(Path(b) / rel) for b in pf if b and (Path(b) / rel).is_file()]
    seen, res = set(), []
    for b in out:
        if b and b.lower() not in seen and Path(b).is_file():
            seen.add(b.lower())
            res.append(b)
    return res


def html_to_pdf(html: Path) -> dict:
    """print a report page to PDF with the browser the app already uses (headless Edge / Chrome).
    It prints in a plain temp folder and copies the result: the project folder can be under OneDrive
    with a Thai name (C:\\Users\\…\\OneDrive\\เอกสาร), and the Edge launcher may hand the job to another
    process and return before the file is written — so the file is waited for, not assumed."""
    browsers = _pdf_browsers()
    if not browsers:
        return {"ok": False, "error": "ไม่พบ Edge / Chrome สำหรับพิมพ์ PDF — เปิดรายงาน .html แล้วกดพิมพ์เป็น PDF เองได้"}
    import tempfile
    pdf = html.with_suffix(".pdf")
    work = Path(tempfile.mkdtemp(prefix="fe_pdf_"))
    errors = []
    try:
        src = work / "report.html"
        shutil.copyfile(html, src)                        # the report is one self-contained file
        for n, br in enumerate(browsers):
            out = work / f"report{n}.pdf"
            args = [br, "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
                    "--no-pdf-header-footer", f"--user-data-dir={work / f'prof{n}'}", f"--print-to-pdf={out}", src.as_uri()]
            # Linux: as root, or where the distro blocks its sandbox (Ubuntu 23.10+), Chromium exits at once
            # without this — it only renders our own report file
            if not IS_WIN and sys.platform != "darwin":
                args.insert(1, "--no-sandbox")
            try:
                p = subprocess.run(args, timeout=120, capture_output=True, **({"creationflags": 0x08000000} if IS_WIN else {}))
            except Exception as e:
                errors.append(f"{Path(br).name}: {e}")
                continue
            # wait for the file to appear and stop growing
            last, stable, end = -1, 0, time.time() + 60
            while time.time() < end:
                size = out.stat().st_size if out.is_file() else -1
                stable = stable + 1 if size == last and size > 500 else 0
                if stable >= 3:
                    break
                last = size
                time.sleep(0.5)
            if out.is_file() and out.stat().st_size > 500:
                try:
                    pdf.unlink()
                except OSError:
                    pass
                shutil.copyfile(out, pdf)
                return {"ok": True, "path": str(pdf), "size": pdf.stat().st_size, "browser": Path(br).name}
            tail = (p.stderr or b"").decode("utf-8", "replace").strip().splitlines()[-2:]
            errors.append(f"{Path(br).name} (exit {p.returncode})" + (": " + " | ".join(tail) if tail else ""))
        return {"ok": False, "error": "เบราว์เซอร์ไม่ได้สร้างไฟล์ PDF — " + " ; ".join(errors)}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def delete_project(name: str) -> dict:
    """move a project folder to Projects/.trash/<name>-<time> (recoverable, not erased)"""
    d = inside(projects_dir(), safe_name(name))
    if not name or not d.is_dir():
        return {"ok": False, "error": f"no project folder '{name}'"}
    trash = projects_dir() / ".trash"
    trash.mkdir(exist_ok=True)
    dest = trash / f"{d.name}-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.move(str(d), str(dest))
    return {"ok": True, "trashed": str(dest)}


def rename_project(name: str, to: str) -> dict:
    """rename a project folder, its <name>.schproj.json and the project name written inside it"""
    src = inside(projects_dir(), safe_name(name))
    to = safe_name(to)
    dst = inside(projects_dir(), to)
    if not name or not src.is_dir():
        return {"ok": False, "error": f"no project folder '{name}'"}
    if not to:
        return {"ok": False, "error": "the new name is empty"}
    if dst.exists() and dst.resolve() != src.resolve():
        return {"ok": False, "error": f"a project folder '{to}' already exists"}
    tmp = src.with_name(src.name + ".renaming")               # case-only renames on Windows
    src.rename(tmp)
    tmp.rename(dst)
    for f in dst.glob("*.schproj.json"):
        try:
            o = json.loads(f.read_text(encoding="utf-8"))
            for p in [o.get("project")] + list(((o.get("workspace") or {}).get("projects") or {}).values()):
                if isinstance(p, dict) and p.get("name") in (name, src.name):
                    p["name"] = to
            f.write_text(json.dumps(o, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
        if f.name == f"{src.name}.schproj.json":
            f.rename(dst / f"{to}.schproj.json")
    return {"ok": True, "name": to}


def status() -> dict:
    server, model = detect_llama()
    try:
        import tkinter  # noqa: F401
        tk_ok = True
    except Exception:
        tk_ok = False
    return {
        "app": APP_ID, "version": VERSION, "frozen": FROZEN,
        "workspace": CFG["workspace"], "projects_dir": str(projects_dir()),
        "config_file": str(CONFIG_FILE),
        "backend": BACKEND is not None, "backend_error": BACKEND_ERROR,
        "llm_up": llm_up(), "llm_endpoint": os.environ.get("AI_ENDPOINT", ""),
        "llama_server": server, "llama_model": model,
        "ghdl": detect_ghdl(), "vivado": detect_vivado(),
        "fpga_builder": tk_ok, "browser": find_browser(),
        "features": CFG["features"], "save_to_workspace": CFG["save_to_workspace"],
    }


def setup_check() -> dict:
    """what the first-run checklist shows: each tool the build → board path needs"""
    viv = detect_vivado()
    ofl = board.find_ofl()
    server, model = detect_llama()
    return {
        "os": "windows" if IS_WIN else sys.platform, "setup_done": bool(CFG.get("setup_done")),
        "vivado": {"path": viv, "spaces": bool(viv and IS_WIN and " " in viv)},
        "openfpgaloader": {"path": ofl, "bridge": board.find_bridge(ofl) if ofl else ""},
        "driver": board.usb_driver(), "zadig": board.find_zadig(),
        "llm": {"mode": CFG["features"].get("llm"), "up": llm_up(), "server": server, "model": model},
        "fpga_enabled": bool(CFG["features"].get("fpga")),
    }


# --------------------------------------------------------------------------
# updates (GitHub Releases) — see updater.py
# --------------------------------------------------------------------------
import updater  # noqa: E402  (launcher/ is on sys.path: script dir / bundled module)
import board    # noqa: E402  build .bit + load onto the board, for the editor's "ลงบอร์ด" page
board.init(ROOT, INSTALL_DIR, CONFIG_DIR, lambda: detect_vivado(), lambda: CFG)

INSTALLER = updater.Installer()
UPDATE_EVERY = 12 * 3600


def update_check(force: bool = False) -> dict:
    u = CFG["update"]
    if not force and not u.get("auto_check", True):
        return {"ok": True, "available": False, "disabled": True, "current": VERSION}
    fresh = time.time() - float(u.get("last_check") or 0) < UPDATE_EVERY
    if not force and fresh and u.get("last_result"):
        res = dict(u["last_result"])
    else:
        res = updater.check(u.get("repo") or DEFAULTS["update"]["repo"], VERSION, u.get("api") or updater.DEFAULT_API)
        if res.get("ok"):
            u["last_check"], u["last_result"] = time.time(), res
            save_config(CFG)
    # re-evaluate against THIS version (a cached result may predate an update)
    if res.get("ok"):
        res["current"] = VERSION
        res["available"] = updater.is_newer(res.get("latest", ""), VERSION)
        res["skipped"] = bool(res["available"] and u.get("skip") == res.get("latest"))
    res["can_install"] = bool(FROZEN and IS_WIN and res.get("asset"))
    return res


def update_install() -> dict:
    res = update_check()
    if not res.get("ok") or not res.get("available"):
        return {"ok": False, "error": res.get("error") or "ใช้เวอร์ชันล่าสุดอยู่แล้ว"}
    if not res.get("can_install"):
        # running from source / not Windows: send the user to the release page
        return {"ok": False, "manual": True, "url": res.get("url")}

    def ready(path):
        updater.run_setup(path)
        threading.Thread(target=lambda: (time.sleep(1.0), shutdown()), daemon=True).start()

    INSTALLER.start(res["asset"], res.get("asset_name") or "FPGAEcosystem-Setup.exe", ready)
    return {"ok": True, "started": True}



# --------------------------------------------------------------------------
# Claude (MCP) relay: mcp_server.py → POST /api/mcp/call → queued for the editor page,
# which long-polls /api/mcp/poll, runs the operation with its own engine and posts
# /api/mcp/result. The MCP side proves itself with a token from runtime.json (only the
# local user can read it); the page side must be same-origin.
# --------------------------------------------------------------------------
import secrets  # noqa: E402

MCP_TOKEN = secrets.token_hex(24)
RUNTIME_FILE = CONFIG_DIR / "runtime.json"


class McpRelay:
    """One editor page runs one operation at a time, in its only (JS) thread: a heavy one (a
    full auto_layout of a big sheet) freezes it until it is done. So the relay remembers what
    the page is running: a busy page still counts as open (it cannot poll while it works — it
    used to look closed, and the next call tried to open another window and hung), and a call
    queued behind a long job waits a little, then answers "busy with <op>" instead of hanging."""
    BUSY_WAIT = 15.0

    def __init__(self):
        self.cv = threading.Condition()
        self.jobs = {}          # client -> [job]
        self.seen = {}          # client -> last poll time
        self.running = {}       # client -> (job id, op, started)
        self.waiting = set()    # job ids a caller is still waiting for
        self.replies = {}       # job id -> reply
        self.n = 0
        self.opened_at = 0.0

    # an editor busy with a long synchronous job (drawing a whole lab: ~30 s) does not poll meanwhile —
    # it is busy, not gone: taking it for closed opened a SECOND Studio window, which answered with an
    # empty history (ai_chat_status "none") and doubled the memory in use
    def live_client(self, within=150.0):
        now = time.time()
        live = [(t, c) for c, t in self.seen.items() if now - t < within or c in self.running]
        return max(live)[1] if live else None

    def poll(self, client, wait=20.0):
        end = time.time() + wait
        with self.cv:
            self.seen[client] = time.time()
            self.running.pop(client, None)      # polling again = the previous job is over
            self.cv.notify_all()
            while True:
                q = self.jobs.get(client)
                if q:
                    job = q.pop(0)
                    self.running[client] = (job["id"], job["op"], time.time())
                    return job
                left = end - time.time()
                if left <= 0:
                    return None
                # no "seen" refresh while waiting: a page that was closed or reloaded mid-poll must
                # not look alive (and newest) — its jobs went nowhere while the new page sat idle
                self.cv.wait(min(left, 5.0))

    def result(self, reply):
        with self.cv:
            jid = str(reply.get("id"))
            for c, r in list(self.running.items()):
                if r[0] == jid:
                    del self.running[c]
            if jid in self.waiting:             # nobody waits for a late answer any more: drop it
                self.replies[jid] = reply
            self.cv.notify_all()

    def forget(self, client):
        with self.cv:
            self.seen.pop(client, None)
            self.running.pop(client, None)
            self.cv.notify_all()

    def busy(self, client):
        r = self.running.get(client)
        return (r[1], time.time() - r[2]) if r else None

    def call(self, op, args, timeout=60.0):
        with self.cv:
            client = self.live_client()
        if client is None:
            # nobody has the editor open: open it (once in a while) and wait for it to connect —
            # unless one was there in the last 5 minutes (then it is only busy: wait for it)
            with self.cv:
                recent = any(time.time() - t < 300 for t in self.seen.values())
            if recent:
                end = time.time() + 45
                with self.cv:
                    while client is None and time.time() < end:
                        self.cv.wait(1.0)
                        client = self.live_client(within=330)
                if client is None:
                    return {"ok": False, "error": "the editor has not answered for a while — it is busy with a long job",
                            "hint": "wait a little and call again (a whole lab takes ~30 s to draw)"}
            elif time.time() - self.opened_at > 20:
                self.opened_at = time.time()
                try:
                    open_window("studio")
                except Exception:
                    pass
            end = time.time() + 25
            with self.cv:
                while client is None and time.time() < end:
                    self.cv.wait(1.0)
                    client = self.live_client()
            if client is None:
                return {"ok": False, "error": "Schematic Studio is not open and could not be opened",
                        "hint": "open FPGA Ecosystem and click Schematic Studio, then retry"}
        with self.cv:
            self.n += 1
            jid = f"j{self.n}"
            self.jobs.setdefault(client, []).append({"id": jid, "op": op, "args": args or {}})
            self.waiting.add(jid)
            self.cv.notify_all()
            start = time.time()
            end = start + timeout
            try:
                while jid not in self.replies:
                    now = time.time()
                    b = self.busy(client)
                    queued = any(j["id"] == jid for j in self.jobs.get(client, []))
                    # still queued behind another op that has run a while: say so instead of hanging
                    if queued and b and b[1] > self.BUSY_WAIT and now - start > self.BUSY_WAIT:
                        self.jobs[client] = [j for j in self.jobs.get(client, []) if j["id"] != jid]
                        return {"ok": False, "error": f"the editor is still busy with '{b[0]}' ({int(b[1])} s so far) — "
                                                      f"'{op}' was not run",
                                "hint": "wait a little and call again (ai_chat_status / ai_chat_stop run beside it). "
                                        "If this lasts minutes, the page itself is stuck in that op"}
                    left = end - now
                    if left <= 0:
                        if queued:      # drop it if the page never picked it up
                            self.jobs[client] = [j for j in self.jobs.get(client, []) if j["id"] != jid]
                            return {"ok": False, "error": f"the editor did not pick up '{op}' within {int(timeout)} s",
                                    "hint": "is the Schematic Studio window frozen or showing a dialog?"}
                        return {"ok": False, "error": f"'{op}' is still running in the editor after {int(timeout)} s",
                                "hint": "it finishes on its own — call status in a moment to see the result"}
                    self.cv.wait(min(left, 1.0))
                return self.replies.pop(jid)
            finally:
                self.waiting.discard(jid)
                self.replies.pop(jid, None)


RELAY = McpRelay()


def write_runtime():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = RUNTIME_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"port": SERVER_PORT, "pid": os.getpid(), "token": MCP_TOKEN,
                               "version": VERSION}), "utf-8")
    try:
        os.chmod(tmp, 0o600)
    except Exception:
        pass
    tmp.replace(RUNTIME_FILE)


def claude_desktop_config_path() -> Path:
    if IS_WIN:
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "Claude" / "claude_desktop_config.json"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "Claude" / "claude_desktop_config.json"


def mcp_command() -> dict:
    """How Claude should start our MCP server on this machine."""
    if FROZEN:
        console = INSTALL_DIR / ("FPGAEcosystem-MCP.exe" if IS_WIN else "FPGAEcosystem-MCP")
        if console.exists():
            return {"command": str(console), "args": []}
        return {"command": sys.executable, "args": ["--mcp"]}
    return {"command": sys.executable, "args": [str(Path(__file__).resolve().parent / "mcp_server.py")]}


def install_claude_desktop() -> dict:
    f = claude_desktop_config_path()
    cfg = {}
    if f.exists():
        try:
            cfg = json.loads(f.read_text("utf-8") or "{}")
        except Exception:
            return {"ok": False, "error": f"อ่าน {f} ไม่ได้ (JSON เสีย) — แก้ไฟล์หรือเพิ่มเองจากข้อความด้านล่าง"}
        shutil.copyfile(f, f.with_suffix(".json.bak"))
    cfg.setdefault("mcpServers", {})["fpga-ecosystem"] = mcp_command()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
    return {"ok": True, "path": str(f)}

def mcp_app(action: str, args: dict) -> dict:
    """What Claude can ask the app itself (no editor window needed): who/what/which version
    this is, whether an update is out, whether the board toolchain is ready; and open Home."""
    if action in ("about", "check_update"):
        up = update_check(force=(action == "check_update"))
        upd = {"current": VERSION, "checked": bool(up.get("ok"))}
        if up.get("ok"):
            upd.update(available=bool(up.get("available")), latest=up.get("latest"),
                       notes=(up.get("notes") or "")[:1500], page=up.get("url"),
                       how="the user clicks 'อัปเดตเลย' on Home (open_home) — projects and settings are kept")
        else:
            upd["error"] = up.get("error") or ("update check is off in Settings" if up.get("disabled") else "")
        if action == "check_update":
            return {"ok": True, "update": upd}
        sc = setup_check()
        drv = sc["driver"].get("state")
        return {"ok": True,
                "app": {"name": APP_NAME, "version": VERSION, "installed": FROZEN,
                        "install_dir": str(INSTALL_DIR), "platform": sys.platform},
                "update": upd,
                "workspace": {"folder": CFG["workspace"], "projects": str(projects_dir()),
                              "count": len(list_projects())},
                "editor_open": RELAY.live_client() is not None,
                "board": {"name": board.BOARD["label"],
                          "vivado": sc["vivado"]["path"] or None,
                          "vivado_ok": bool(sc["vivado"]["path"]) and not sc["vivado"]["spaces"],
                          "openfpgaloader": sc["openfpgaloader"]["path"] or None,
                          "flash_bridge": bool(sc["openfpgaloader"].get("bridge")),
                          "usb_driver": drv, "build_enabled": sc["fpga_enabled"]},
                "ai_model": {"mode": sc["llm"]["mode"], "running": sc["llm"]["up"]},
                "views": ["Schematic Studio (gate editor)", "simulation page", "ลงบอร์ด (build .bit + program)",
                          "Top-Down (block diagrams for the lab report)", "Home (projects, settings, updates)"]}
    if action == "open_home":
        tab = str(args.get("tab") or "home")
        if tab not in ("home", "setup", "settings"):
            return {"ok": False, "error": f"unknown tab '{tab}'", "hint": "home | setup | settings"}
        open_window("home", "tab=" + tab)
        return {"ok": True, "opened": tab}
    return {"ok": False, "error": f"unknown action '{action}'"}


_LEGACY_MCP = ("topdown_mcp", "schematic_mcp", "top-down-schematic")


def legacy_mcp() -> list:
    """Older offline servers still set up in Claude Desktop (topdown_mcp.py / schematic_mcp.py).
    Claude reaches for them and writes a Top-Down JSON to import by hand, skipping the
    schematic → simulate → approve order the live server enforces."""
    f = claude_desktop_config_path()
    try:
        servers = json.loads(f.read_text("utf-8") or "{}").get("mcpServers") or {}
    except Exception:
        return []
    out = []
    for name, spec in servers.items():
        blob = (name + " " + json.dumps(spec)).lower()
        if name != "fpga-ecosystem" and any(k in blob for k in _LEGACY_MCP):
            out.append(name)
    return out


def remove_legacy_mcp() -> dict:
    f = claude_desktop_config_path()
    names = legacy_mcp()
    if not names:
        return {"ok": True, "removed": []}
    try:
        cfg = json.loads(f.read_text("utf-8") or "{}")
    except Exception:
        return {"ok": False, "error": f"อ่าน {f} ไม่ได้"}
    shutil.copyfile(f, f.with_suffix(".json.bak"))
    for n in names:
        cfg.get("mcpServers", {}).pop(n, None)
    f.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
    return {"ok": True, "removed": names, "backup": str(f.with_suffix(".json.bak"))}


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
LAST_PING = time.time()
SHIM = b""
_SHIM_TAG = b"</body>"
_CTYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
           ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
           ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
           ".ico": "image/x-icon"}
_BACKEND_ROUTES = {"/chat": "ai", "/chat_stream": "ai", "/ask": "ai", "/sim": "sim"}


def _backend_base():
    return BACKEND.Handler if BACKEND is not None else BaseHTTPRequestHandler


def make_handler():
    Base = _backend_base()

    class H(Base):
        server_version = "FPGAEcosystem/" + VERSION

        def log_message(self, fmt, *args):
            pass

        # ---- helpers (independent of chat_server's) ----
        def _out(self, code, body, ctype="application/json; charset=utf-8", cache=False):
            if not isinstance(body, (bytes, bytearray)):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "max-age=300" if cache else "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self) -> dict:      # chat_server's body reader + cosim switch
            data = super()._read_json()
            if isinstance(data, dict) and not CFG["features"].get("cosim"):
                data["cosim"] = False
            return data

        def _body(self) -> bytes:
            n = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(n) if n else b""

        def _static(self, path: str):
            if path in ("/", "/index.html", "/home.html"):
                f = WEB / "home.html"
            elif path in ("/studio.html", "/schematic&bus2vhdl.html"):
                f = EDITOR_HTML
            elif path == "/favicon.ico":
                f = WEB / "icon-192.png"
            elif path.startswith("/launcher/"):
                f = inside(WEB, path[len("/launcher/"):])
            elif path.startswith("/topdown/") or path.startswith("/designs_gate/"):
                f = inside(ROOT, path.lstrip("/"))
            else:
                return False
            if not f.is_file():
                self._out(404, {"ok": False, "error": "not found"})
                return True
            data = f.read_bytes()
            ctype = _CTYPES.get(f.suffix.lower(), "application/octet-stream")
            if f.suffix.lower() == ".html" and f.parent != WEB:
                i = data.rfind(_SHIM_TAG)       # inject the workspace/app shim
                data = (data[:i] + SHIM + data[i:]) if i >= 0 else data + SHIM
            self._out(200, data, ctype)
            return True

        # ---- routing ----
        def do_GET(self):
            u = urlparse(self.path)
            path, q = u.path, parse_qs(u.query)
            try:
                if path.startswith("/api/"):
                    return self._api_get(path, q)
                if self._static(path):
                    return
            except ValueError as e:
                return self._out(403, {"ok": False, "error": str(e)})
            if BACKEND is not None:          # /health, /latest.json
                return super().do_GET()
            self._out(404, {"ok": False, "error": "not found"})

        def do_POST(self):
            u = urlparse(self.path)
            path, q = u.path, parse_qs(u.query)
            try:
                if path.startswith("/api/"):
                    return self._api_post(path, q)
            except ValueError as e:
                return self._out(403, {"ok": False, "error": str(e)})
            feat = _BACKEND_ROUTES.get(path)
            if feat and not CFG["features"].get(feat):
                return self._out(200, {"ok": False, "status": "REJECTED", "evidence": [],
                                       "reason": f"ฟีเจอร์ '{feat}' ปิดอยู่ (เปิดได้ที่หน้า Settings)"})
            if BACKEND is not None:
                return super().do_POST()
            self._out(503, {"ok": False, "error": "backend not available: " + BACKEND_ERROR})

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def _same_origin(self) -> bool:
            """Browser requests must come from our own pages (not some other website);
            non-browser clients (the MCP server, curl, tests) send no Origin."""
            o = self.headers.get("Origin")
            return not o or o in (base_url(), f"http://localhost:{SERVER_PORT}")

        def _mcp_authorized(self) -> bool:
            return secrets.compare_digest(self.headers.get("X-FE-Token", ""), MCP_TOKEN)

        # ---- /api ----
        def _api_get(self, path, q):
            global LAST_PING
            if path == "/api/mcp/poll":
                if not self._same_origin():
                    return self._out(403, {"ok": False, "error": "forbidden"})
                LAST_PING = time.time()
                job = RELAY.poll((q.get("client") or ["page"])[0])
                if job is None:
                    self.send_response(204); self.send_header("Cache-Control", "no-store"); self.end_headers()
                    return
                return self._out(200, job)
            if path == "/api/mcp/status":
                if not self._mcp_authorized():
                    return self._out(401, {"ok": False, "error": "bad token"})
                return self._out(200, {"ok": True, "editor_connected": RELAY.live_client() is not None,
                                       "version": VERSION})
            if path == "/api/mcp/app":
                if not self._mcp_authorized():
                    return self._out(401, {"ok": False, "error": "bad token"})
                return self._out(200, mcp_app((q.get("action") or ["about"])[0],
                                              {k: v[0] for k, v in q.items() if k != "action"}))
            if path == "/api/mcp/setup":
                return self._out(200, {"command": mcp_command(), "desktop_config": str(claude_desktop_config_path()),
                                       "legacy": legacy_mcp()})
            if path == "/api/ping":
                LAST_PING = time.time()
                return self._out(200, {"ok": True})
            if path == "/api/info":
                return self._out(200, {"app": APP_ID, "version": VERSION})
            if path == "/api/status":
                return self._out(200, status())
            if path == "/api/config":
                return self._out(200, CFG)
            if path == "/api/projects":
                return self._out(200, {"ok": True, "dir": str(projects_dir()),
                                       "projects": list_projects()})
            if path == "/api/update/check":
                return self._out(200, update_check(force=(q.get("force") or ["0"])[0] == "1"))
            if path == "/api/update/progress":
                return self._out(200, dict(INSTALLER.snapshot(), log=updater.setup_log_path()))
            if path == "/api/rag/labs":             # the lab sheets (ai/rag/labs/*.json) for the lab helper
                labs = []
                for f in sorted((ROOT / "ai" / "rag" / "labs").glob("*.json")):
                    try:
                        d = json.loads(f.read_text("utf-8"))
                        labs.append({"lab": d.get("lab") or f.stem, "title": d.get("title", ""), "objectives": d.get("objectives") or [],
                                     "items": [{k: it.get(k) for k in ("id", "question", "subtasks", "topic", "solution")}
                                               for it in d.get("items") or []]})
                    except Exception:
                        pass
                return self._out(200, {"ok": True, "labs": labs})
            if path == "/api/rag/search":
                return self._out(200, rag_search((q.get("q") or [""])[0], int((q.get("k") or ["5"])[0] or 5),
                                                 (q.get("group") or [""])[0]))
            if path == "/api/llm/status":
                server, model = detect_llama()
                return self._out(200, dict(llm.status(CFG["features"]["llm_endpoint"], server, model),
                                           mode=CFG["features"].get("llm"), backend_up=llm_up()))
            if path == "/api/setup/check":
                return self._out(200, setup_check())
            if path == "/api/board/status":
                return self._out(200, board.status(int((q.get("since") or ["0"])[0] or 0)))
            if path == "/api/board/tools":
                t = board.tools()
                t["enabled"] = bool(CFG["features"].get("fpga"))
                return self._out(200, t)
            if path == "/api/files/read":
                f = inside(projects_dir(), (q.get("path") or [""])[0])
                if not f.is_file():
                    return self._out(404, {"ok": False, "error": "not found"})
                return self._out(200, f.read_bytes(), "application/octet-stream")
            return self._out(404, {"ok": False, "error": "unknown api"})

        def _api_post(self, path, q):
            global LAST_PING
            if path == "/api/mcp/call":
                if not self._mcp_authorized():
                    return self._out(401, {"ok": False, "error": "bad token"})
                LAST_PING = time.time()
                req = json.loads(self._body() or b"{}")
                return self._out(200, RELAY.call(str(req.get("op") or ""), req.get("args") or {},
                                                 float(req.get("timeout") or 60)))
            if not self._same_origin():
                return self._out(403, {"ok": False, "error": "forbidden (cross-origin)"})
            if path == "/api/mcp/result":
                RELAY.result(json.loads(self._body() or b"{}"))
                return self._out(200, {"ok": True})
            if path == "/api/mcp/bye":                   # the editor page is closing: forget it now
                RELAY.forget((q.get("client") or [""])[0])
                return self._out(200, {"ok": True})
            if path == "/api/mcp/install_desktop":
                return self._out(200, install_claude_desktop())
            if path == "/api/mcp/remove_legacy":
                return self._out(200, remove_legacy_mcp())
            if path == "/api/files/save":
                proj = safe_name((q.get("project") or [""])[0])
                name = safe_name(Path((q.get("name") or ["file"])[0]).name, "file")
                d = inside(projects_dir(), proj)
                d.mkdir(parents=True, exist_ok=True)
                f = d / name
                f.write_bytes(self._body())
                return self._out(200, {"ok": True, "path": str(f), "project": proj, "name": name})
            data = json.loads(self._body() or b"{}")
            if path == "/api/open":
                open_window(data.get("page", "home"), data.get("query", ""))
                return self._out(200, {"ok": True})
            if path == "/api/open_project":
                rel = data.get("path") or ""
                inside(projects_dir(), rel)
                open_window("studio", "open=" + quote(rel))
                return self._out(200, {"ok": True})
            if path.startswith("/api/llm/"):
                if path == "/api/llm/download":
                    if data.get("what") == "llama":
                        return self._out(200, llm.download_llama(data.get("variant") or "gpu"))
                    return self._out(200, llm.download_model(str(data.get("id") or "")))
                if path == "/api/llm/cancel":
                    return self._out(200, llm.cancel_download())
                if path == "/api/llm/stop":
                    return self._out(200, llm.stop())
                if path == "/api/llm/start":
                    f = CFG["features"]
                    if data.get("model"):
                        f["llama_model"] = str(data["model"])
                    srv = llm.find_server()
                    if srv and not Path(f.get("llama_server") or "").is_file():
                        f["llama_server"] = ""          # auto-detect finds the downloaded one
                    f["llm"] = "local"
                    f["ai"] = True
                    save_config(CFG)
                    set_llm_endpoint(f["llm_endpoint"])
                    return self._out(200, start_llama(force=True))
                if path == "/api/llm/chat":
                    return self._out(200, llm_chat(data))
                return self._out(404, {"ok": False, "error": "unknown api"})
            if path.startswith("/api/agent/"):
                import mcp_server as MS         # tool schemas + argument checks, shared with the MCP server
                if path == "/api/agent/tools":
                    return self._out(200, {"ok": True, "tools": MS.openai_tools(data.get("names") or None)})
                if path == "/api/agent/normalize":
                    name = str(data.get("name") or "")
                    if name not in MS.TOOL_MAP:
                        return self._out(200, {"ok": False, "error": f"unknown tool '{name}'"})
                    args, err = MS.normalize_args(name, data.get("args") or {})
                    return self._out(200, {"ok": not err, "args": args, "error": err})
                if path == "/api/agent/log":
                    return self._out(200, agent_log(data))
                return self._out(404, {"ok": False, "error": "unknown api"})
            if path.startswith("/api/board/"):
                if not CFG["features"].get("fpga"):
                    return self._out(200, {"ok": False, "error": "ฟีเจอร์ “สร้าง .bit / ลงบอร์ด” ปิดอยู่ — เปิดได้ที่หน้า ตั้งค่า"})
                proj = safe_name(data.get("project") or "design")
                if path == "/api/board/build":
                    return self._out(200, board.start_build(proj, data.get("top") or proj, data.get("vhdl") or "",
                                                            data.get("xdc") or "", data.get("clk") or "",
                                                            inside(projects_dir(), proj)))
                if path == "/api/board/program":
                    return self._out(200, board.start_program(proj, data.get("top") or proj,
                                                              data.get("mode") or "sram", data.get("cable") or "ft2232",
                                                              inside(projects_dir(), proj)))
                if path == "/api/board/bit":
                    return self._out(200, board.bit_status(proj, data.get("top") or proj, data.get("vhdl") or "",
                                                           data.get("xdc") or "", inside(projects_dir(), proj)))
                if path == "/api/board/detect":
                    return self._out(200, board.start_detect(data.get("cable") or "ft2232"))
                if path == "/api/board/stop":
                    return self._out(200, board.stop())
                return self._out(404, {"ok": False, "error": "unknown api"})
            if path == "/api/setup/done":
                CFG["setup_done"] = bool(data.get("done", True))
                save_config(CFG)
                return self._out(200, {"ok": True})
            if path == "/api/setup/zadig":
                return self._out(200, board.open_zadig())
            if path == "/api/fpga_builder":
                if not CFG["features"].get("fpga"):
                    return self._out(200, {"ok": False, "error": "FPGA build ปิดอยู่"})
                launch_fpga_builder()
                return self._out(200, {"ok": True})
            if path == "/api/reveal":
                rel = data.get("path") or ""
                reveal(inside(projects_dir(), rel) if rel else projects_dir())
                return self._out(200, {"ok": True})
            if path == "/api/report/pdf":
                return self._out(200, html_to_pdf(inside(projects_dir(), str(data.get("path") or ""))))
            if path == "/api/projects/delete":
                return self._out(200, delete_project(str(data.get("name") or "")))
            if path == "/api/projects/rename":
                return self._out(200, rename_project(str(data.get("name") or ""), str(data.get("to") or "")))
            if path == "/api/projects/new":
                name = safe_name(data.get("name") or "")
                d = inside(projects_dir(), name)
                if d.exists():
                    return self._out(200, {"ok": False, "error": "มีโปรเจกต์ชื่อนี้แล้ว"})
                d.mkdir(parents=True)
                return self._out(200, {"ok": True, "name": name})
            if path == "/api/config":
                new = _merge(CFG, data)
                new["workspace"] = str(Path(new["workspace"]).expanduser())
                save_config(new)
                CFG.clear()
                CFG.update(new)
                return self._out(200, {"ok": True, "restart": True})
            if path == "/api/update/skip":
                CFG["update"]["skip"] = str(data.get("version") or "")
                save_config(CFG)
                return self._out(200, {"ok": True})
            if path == "/api/update/install":
                return self._out(200, update_install())
            if path == "/api/restart":
                self._out(200, {"ok": True})
                threading.Thread(target=restart, daemon=True).start()
                return
            if path == "/api/quit":
                self._out(200, {"ok": True})
                threading.Thread(target=lambda: (time.sleep(0.3), shutdown()), daemon=True).start()
                return
            return self._out(404, {"ok": False, "error": "unknown api"})

    return H


# --------------------------------------------------------------------------
# lifecycle
# --------------------------------------------------------------------------
SERVER_PORT = 8770
HTTPD = None
IDLE_SECONDS = 120


def _is_ours(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/info", timeout=0.8) as r:
            return json.loads(r.read()).get("app") == APP_ID
    except Exception:
        return False


def _bind(port: int, wait: float = 0.0):
    deadline = time.time() + wait
    while True:
        try:
            return ThreadingHTTPServer(("127.0.0.1", port), make_handler())
        except OSError:
            if time.time() >= deadline:
                return None
            time.sleep(0.3)


def shutdown():
    try:
        llm.stop()
        llm.stop_embed()
    except Exception:
        pass
    if HTTPD is not None:
        threading.Thread(target=HTTPD.shutdown, daemon=True).start()
    time.sleep(0.5)
    os._exit(0)


def restart():
    time.sleep(0.3)
    args = [sys.executable] + ([] if FROZEN else [str(Path(__file__).resolve())])
    subprocess.Popen(args + ["--no-open", "--wait-port", "--port", str(SERVER_PORT)],
                     cwd=str(INSTALL_DIR))
    shutdown()


def _watchdog():
    while True:
        time.sleep(10)
        if time.time() - LAST_PING > IDLE_SECONDS:
            shutdown()


def run_fpga_builder():
    src = ROOT / "FPGA_Builder_Package" / "source"
    sys.path.insert(0, str(src))
    import fpga_builder
    fpga_builder.FPGABuilder().mainloop()


def main(argv=None):
    global SERVER_PORT, HTTPD, SHIM, LAST_PING
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--fpga-builder" in argv:
        return run_fpga_builder()
    if "--mcp" in argv:                       # Claude starts us as an MCP server (stdio)
        import mcp_server
        return mcp_server.main()
    port = int(argv[argv.index("--port") + 1]) if "--port" in argv else int(CFG.get("port") or 8770)
    no_open = "--no-open" in argv

    # single instance: a second double-click just opens another Home window
    if not ("--wait-port" in argv) and _is_ours(port):
        urllib.request.urlopen(urllib.request.Request(
            f"http://127.0.0.1:{port}/api/open", data=b'{"page":"home"}',
            headers={"Content-Type": "application/json"}), timeout=2)
        return

    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if sys.stdout is None or sys.stderr is None:   # windowed exe: no console -> log file
        log = open(CONFIG_DIR / "app.log", "w", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or log
        sys.stderr = sys.stderr or log
    projects_dir()
    load_backend()
    SHIM = b'\n<script src="/launcher/shim.js"></script>\n'

    HTTPD = _bind(port, wait=8.0 if "--wait-port" in argv else 0.0)
    if HTTPD is None:          # port taken by something else - take any free port
        HTTPD = _bind(0)
    SERVER_PORT = HTTPD.server_address[1]
    write_runtime()
    # a model server from our llama folder running now was left by an earlier run (closed by the updater,
    # a crash): it holds RAM / VRAM for nothing — stop it before anything else
    if not start_llama().get("ok"):                  # (a start stops them itself)
        threading.Thread(target=llm.stop_strays, daemon=True).start()
    LAST_PING = time.time()
    threading.Thread(target=_watchdog, daemon=True).start()
    print(f"{APP_NAME} {VERSION} on {base_url()}  (backend: "
          f"{'ok' if BACKEND else 'OFF - ' + BACKEND_ERROR})")
    print(f"projects: {projects_dir()}")
    if "--after-update" in argv:
        # the Home window that started the update reloads itself once we answer; open a
        # window only if it doesn't come back (the user closed it), so there aren't two
        t0 = LAST_PING
        threading.Thread(target=lambda: (time.sleep(8), LAST_PING <= t0 and open_window("home")),
                         daemon=True).start()
    elif not no_open:
        open_window("home")
    try:
        HTTPD.serve_forever()
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
