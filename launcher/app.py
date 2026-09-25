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
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

APP_NAME = "FPGA Ecosystem"
APP_ID = "fpga-ecosystem"
VERSION = "0.1.0"

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


CONFIG_DIR = _config_dir()
CONFIG_FILE = CONFIG_DIR / "config.json"

DEFAULTS = {
    "workspace": str(_documents_dir() / APP_NAME),
    "port": 8770,                 # the editor's AI chat defaults to 127.0.0.1:8770
    "save_to_workspace": True,    # route editor downloads into the project folder
    "features": {
        "ai": True,               # AI chat panel backend (equations/truth tables work offline)
        "sim": True,              # backend netlist simulation (POST /sim)
        "llm": "off",             # off | endpoint | local
        "llm_endpoint": "http://127.0.0.1:8080/v1/chat/completions",
        "llama_server": "",       # path to llama-server(.exe) for llm=local
        "llama_model": "",        # path to a .gguf for llm=local
        "llama_args": "-c 8192 --jinja -ngl 999",
        "cosim": False,           # GHDL co-simulation check
        "ghdl": "",               # path to ghdl(.exe); blank = auto-detect
        "fpga": True,             # FPGA Builder (VHDL -> .bit -> board)
        "vivado": "",             # path to vivado(.bat); blank = auto-detect
    },
}


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            out[k] = _merge(base[k], v)
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
    server = _first([CFG["features"].get("llama_server"),
                     ROOT / "ai" / "llama" / exe, INSTALL_DIR / "llama" / exe,
                     shutil.which("llama-server")])
    model = CFG["features"].get("llama_model") or ""
    if not Path(model).is_file():
        ggufs = sorted(glob.glob(str(ROOT / "ai" / "models" / "*.gguf"))
                       + glob.glob(str(INSTALL_DIR / "models" / "*.gguf")))
        model = ggufs[0] if ggufs else ""
    return server, model


def find_browser() -> str:
    """Edge ships with every Windows 10/11, so --app windows work out of the box."""
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


LLAMA_PROC = None


def start_llama():
    global LLAMA_PROC
    f = CFG["features"]
    if f.get("llm") != "local":
        return
    server, model = detect_llama()
    if not (server and model):
        return
    port = urlparse(f.get("llm_endpoint") or "").port or 8080
    args = [server, "-m", model, "--host", "127.0.0.1", "--port", str(port)]
    args += (f.get("llama_args") or "").split()
    log = open(CONFIG_DIR / "llama-server.log", "ab")
    LLAMA_PROC = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT,
                                  creationflags=_NO_WINDOW)


_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


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
    "topdown": "/topdown/topdown-schematic.html",
}


def base_url() -> str:
    return f"http://127.0.0.1:{SERVER_PORT}"


def open_window(page: str = "home", query: str = "") -> None:
    url = base_url() + PAGES.get(page, "/") + (("?" + query) if query else "")
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


def list_projects() -> list:
    out = []
    for d in projects_dir().iterdir():
        if not d.is_dir():
            continue
        files = sorted((f for f in d.iterdir() if f.is_file()),
                       key=lambda f: f.stat().st_mtime, reverse=True)
        main = next((f for f in files if f.name.endswith(".schproj.json")), None)
        mtime = max([d.stat().st_mtime] + [f.stat().st_mtime for f in files])
        out.append({"name": d.name, "mtime": mtime,
                    "main": f"{d.name}/{main.name}" if main else None,
                    "files": [{"name": f.name, "size": f.stat().st_size} for f in files[:50]]})
    out.sort(key=lambda p: p["mtime"], reverse=True)
    return out


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

        # ---- /api ----
        def _api_get(self, path, q):
            global LAST_PING
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
            if path == "/api/files/read":
                f = inside(projects_dir(), (q.get("path") or [""])[0])
                if not f.is_file():
                    return self._out(404, {"ok": False, "error": "not found"})
                return self._out(200, f.read_bytes(), "application/octet-stream")
            return self._out(404, {"ok": False, "error": "unknown api"})

        def _api_post(self, path, q):
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
            if path == "/api/fpga_builder":
                if not CFG["features"].get("fpga"):
                    return self._out(200, {"ok": False, "error": "FPGA build ปิดอยู่"})
                launch_fpga_builder()
                return self._out(200, {"ok": True})
            if path == "/api/reveal":
                rel = data.get("path") or ""
                reveal(inside(projects_dir(), rel) if rel else projects_dir())
                return self._out(200, {"ok": True})
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
    if LLAMA_PROC is not None:
        try:
            LLAMA_PROC.terminate()
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
    start_llama()
    LAST_PING = time.time()
    threading.Thread(target=_watchdog, daemon=True).start()
    print(f"{APP_NAME} {VERSION} on {base_url()}  (backend: "
          f"{'ok' if BACKEND else 'OFF - ' + BACKEND_ERROR})")
    print(f"projects: {projects_dir()}")
    if not no_open:
        open_window("home")
    try:
        HTTPD.serve_forever()
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
