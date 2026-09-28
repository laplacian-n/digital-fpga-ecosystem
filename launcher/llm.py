"""
llm.py - the local AI model, managed from Settings (no scripts, no terminal).

  * download llama.cpp (llama-server) from its GitHub releases: GPU build (Vulkan: NVIDIA, AMD
    and Intel, no CUDA install) or CPU-only; the zip is unpacked into the app's data folder;
  * download a model (.gguf) from a short catalog (Qwen3.5 9B/4B, Typhoon 2.5, Qwen2.5-Coder), resumable;
  * start / stop llama-server and report its state: stopped · loading · ready · crashed,
    with the tail of its log.
Files live in the per-machine data folder (%LOCALAPPDATA%\\FPGA Ecosystem on Windows) - models
are GBs and must not roam with the profile. One download at a time; the page polls status().
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import urlparse

IS_WIN = os.name == "nt"
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
EXE = "llama-server.exe" if IS_WIN else "llama-server"
LLAMA_REPO = "ggml-org/llama.cpp"
LLAMA_PINNED = "b11016"     # used when the GitHub API can't be reached (rate limit, proxy)

HF = "https://huggingface.co"
CATALOG = [
    # Qwen3.5: 3 of every 4 layers are Gated DeltaNet (fixed-size state), so a long context costs
    # a quarter of the usual KV cache; thinks before answering and calls tools (the agent mode)
    {"id": "qwen3.5-9b", "name": "Qwen3.5 9B", "size_gb": 5.7, "agent": True,
     "note": "แนะนำ · เอเจนต์ทำงานผ่านเครื่องมือ (MCP) ได้ดีสุด · การ์ดจอ 6 GB+ (ล้นไป RAM ได้)",
     "file": "Qwen3.5-9B-Q4_K_M.gguf",
     "url": HF + "/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf"},
    {"id": "qwen3.5-4b", "name": "Qwen3.5 4B", "size_gb": 3.5, "agent": True,
     "note": "เร็วกว่า · อยู่บนการ์ดจอ 4–6 GB ได้ทั้งตัว · เก่งน้อยกว่า 9B",
     "file": "Qwen3.5-4B-Q6_K.gguf",
     "url": HF + "/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q6_K.gguf"},
    {"id": "typhoon2.5-4b", "name": "Typhoon 2.5 (Qwen3 4B)", "size_gb": 2.5, "agent": True,
     "note": "ภาษาไทยดีสุด (SCB 10X) · เรียกเครื่องมือได้ · context 256K",
     "file": "typhoon2.5-qwen3-4b-q4_k_m.gguf",
     "url": HF + "/typhoon-ai/typhoon2.5-qwen3-4b-gguf/resolve/main/typhoon2.5-qwen3-4b-q4_k_m.gguf"},
    {"id": "qwen2.5-coder-7b", "name": "Qwen2.5-Coder 7B (เดิม)", "size_gb": 4.7,
     "note": "รุ่นเดิม · วาดวงจรแบบรอบเดียว (โหมดวาดวงจร) · ไม่ถนัดทำงานหลายขั้น",
     "file": "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
     "url": HF + "/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf"},
    {"id": "qwen2.5-coder-3b", "name": "Qwen2.5-Coder 3B (เดิม)", "size_gb": 2.1,
     "note": "รุ่นเดิม · เล็ก · เครื่องไม่มีการ์ดจอ",
     "file": "qwen2.5-coder-3b-instruct-q4_k_m.gguf",
     "url": HF + "/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf"},
]

# llama-server's own --fit (on by default) places as many layers on the GPU as fit and the rest
# in system RAM — so -ngl is left UNSET (a fixed -ngl 999 turned that off and ran out of VRAM).
# --jinja = the model's chat template, which carries tool calls; the KV cache is kept at 8 bit.
DEFAULT_ARGS = "-c 65536 --jinja -fa on -ctk q8_0 -ctv q8_0"
OLD_DEFAULT_ARGS = ("-c 8192 --jinja -ngl 999",)

CTX = {"data": Path("."), "log": Path("llama-server.log")}


def init(data_dir: Path, log_file: Path):
    CTX["data"], CTX["log"] = Path(data_dir), Path(log_file)


def data_dir() -> Path:
    return CTX["data"]


def models_dir() -> Path:
    return data_dir() / "models"


def llama_dir() -> Path:
    return data_dir() / "llama"


def find_server() -> str:
    d = llama_dir()
    if d.is_dir():
        hits = sorted(d.rglob(EXE), key=lambda p: p.stat().st_mtime, reverse=True)
        if hits:
            return str(hits[0])
    return ""


def installed_models() -> list:
    d = models_dir()
    return sorted(str(p) for p in d.glob("*.gguf")) if d.is_dir() else []


# --------------------------------------------------------------------------
# downloads (one at a time)
# --------------------------------------------------------------------------
class Download:
    def __init__(self):
        self.lock = threading.Lock()
        self.s = {"phase": "idle", "what": "", "done": 0, "total": 0, "error": "", "path": ""}
        self.cancel = False

    def snapshot(self):
        return dict(self.s)

    def busy(self):
        return self.s["phase"] in ("downloading", "extracting")


DL = Download()


def _get(url: str, headers=None, timeout=30):
    req = urllib.request.Request(url, headers=dict({"User-Agent": "fpga-ecosystem"}, **(headers or {})))
    return urllib.request.urlopen(req, timeout=timeout)


def _fetch(url: str, dst: Path):
    """stream to dst.part (resumes a previous partial download), then rename"""
    part = dst.with_name(dst.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    r = _get(url, {"Range": f"bytes={have}-"} if have else None, timeout=60)
    if have and r.status != 206:           # server ignored the range: start over
        have = 0
    total = int(r.headers.get("Content-Length") or 0) + have
    DL.s.update(total=total, done=have)
    with open(part, "ab" if have else "wb") as f:
        while True:
            if DL.cancel:
                raise RuntimeError("ยกเลิกแล้ว")
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
            DL.s["done"] += len(b)
    if total and part.stat().st_size < total:
        raise RuntimeError("ดาวน์โหลดไม่ครบ — กดอีกครั้งเพื่อโหลดต่อ")
    part.replace(dst)


def _llama_asset(variant: str):
    """pick the release asset for this machine: (url, name)"""
    if IS_WIN:
        pats = [r"bin-win-vulkan-x64\.zip$", r"bin-win-cpu-x64\.zip$"] if variant == "gpu" else [r"bin-win-cpu-x64\.zip$"]
    elif sys.platform == "darwin":
        pats = [r"bin-macos-arm64\.(zip|tar\.gz)$", r"bin-macos-x64\.(zip|tar\.gz)$"]
    else:
        pats = ([r"bin-ubuntu-vulkan-x64\.(zip|tar\.gz)$"] if variant == "gpu" else []) + [r"bin-ubuntu-x64\.(zip|tar\.gz)$"]
    try:
        with _get(f"https://api.github.com/repos/{LLAMA_REPO}/releases/latest", {"Accept": "application/vnd.github+json"}) as r:
            rel = json.loads(r.read().decode("utf-8"))
        assets = rel.get("assets") or []
        for p in pats:
            for a in assets:
                if re.search(p, a.get("name", "")):
                    return a["browser_download_url"], a["name"]
    except Exception:
        pass
    # offline from the API: a known release, Windows/Linux names follow the same scheme
    tag = LLAMA_PINNED
    if IS_WIN:
        name = f"llama-{tag}-bin-win-{'vulkan' if variant == 'gpu' else 'cpu'}-x64.zip"
    elif sys.platform == "darwin":
        name = f"llama-{tag}-bin-macos-arm64.zip"
    else:
        name = f"llama-{tag}-bin-ubuntu-{'vulkan-' if variant == 'gpu' else ''}x64.zip"
    return f"https://github.com/{LLAMA_REPO}/releases/download/{tag}/{name}", name


def _extract(archive: Path, dest: Path):
    dest.mkdir(parents=True, exist_ok=True)
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            for m in z.infolist():
                p = (dest / m.filename).resolve()
                if not str(p).startswith(str(dest.resolve())):
                    continue                      # no ../ escapes
                z.extract(m, dest)
    else:
        with tarfile.open(archive) as t:
            safe = [m for m in t.getmembers() if str((dest / m.name).resolve()).startswith(str(dest.resolve()))]
            t.extractall(dest, members=safe)
    if not IS_WIN:
        for p in dest.rglob("*"):
            if p.is_file() and (p.name.startswith("llama-") or p.suffix in (".so", ".dylib")):
                p.chmod(p.stat().st_mode | 0o111)


def _run(what: str, job):
    def worker():
        try:
            job()
            DL.s.update(phase="done")
        except Exception as e:  # noqa: BLE001
            DL.s.update(phase="error", error=str(e) or type(e).__name__)
    with DL.lock:
        if DL.busy():
            return {"ok": False, "error": "กำลังดาวน์โหลดอย่างอื่นอยู่"}
        DL.cancel = False
        DL.s = {"phase": "downloading", "what": what, "done": 0, "total": 0, "error": "", "path": ""}
    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True}


def download_llama(variant: str = "gpu") -> dict:
    def job():
        url, name = _llama_asset(variant)
        llama_dir().mkdir(parents=True, exist_ok=True)
        arc = llama_dir() / name
        if not arc.exists():
            _fetch(url, arc)
        DL.s["phase"] = "extracting"
        dest = llama_dir() / re.sub(r"\.(zip|tar\.gz)$", "", name)
        _extract(arc, dest)
        try:
            arc.unlink()
        except OSError:
            pass
        srv = find_server()
        if not srv:
            raise RuntimeError(f"แตกไฟล์แล้วแต่ไม่พบ {EXE}")
        DL.s["path"] = srv
    return _run("llama", job)


def download_model(model_id: str) -> dict:
    m = next((x for x in CATALOG if x["id"] == model_id), None)
    if not m:
        return {"ok": False, "error": "ไม่รู้จักโมเดลนี้"}

    def job():
        models_dir().mkdir(parents=True, exist_ok=True)
        dst = models_dir() / m["file"]
        if not dst.exists():
            _fetch(m["url"], dst)
        DL.s["path"] = str(dst)
    return _run(m["id"], job)


def cancel_download() -> dict:
    DL.cancel = True
    return {"ok": True}


# --------------------------------------------------------------------------
# the server
# --------------------------------------------------------------------------
PROC = None
STARTED = {"model": "", "port": 0, "t": 0.0}


def running() -> bool:
    return PROC is not None and PROC.poll() is None


def start(server: str, model: str, endpoint: str, args: str) -> dict:
    global PROC
    if running():
        stop()
    if not (server and Path(server).is_file()):
        return {"ok": False, "error": "ยังไม่มี llama.cpp — กด “ดาวน์โหลด llama.cpp” ก่อน"}
    if not (model and Path(model).is_file()):
        return {"ok": False, "error": "ยังไม่ได้เลือกโมเดล (.gguf)"}
    port = urlparse(endpoint or "").port or 8080
    cmd = [server, "-m", model, "--host", "127.0.0.1", "--port", str(port)] + (args or "").split()
    CTX["log"].parent.mkdir(parents=True, exist_ok=True)
    log = open(CTX["log"], "wb")
    if os.name == "nt" and getattr(sys, "frozen", False):   # see board.release_dll_dir
        try:
            import ctypes
            ctypes.windll.kernel32.SetDllDirectoryW(None)
        except Exception:
            pass
    PROC = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            cwd=str(Path(server).parent), creationflags=_NO_WINDOW)
    STARTED.update(model=model, port=port, t=time.time())
    return {"ok": True}


def stop() -> dict:
    global PROC
    if PROC is not None:
        try:
            PROC.terminate()
            PROC.wait(timeout=5)
        except Exception:
            try:
                PROC.kill()
            except Exception:
                pass
    PROC = None
    return {"ok": True}


def health(endpoint: str) -> str:
    """ready | loading | down"""
    u = urlparse(endpoint or "http://127.0.0.1:8080")
    try:
        with urllib.request.urlopen(f"{u.scheme}://{u.hostname}:{u.port or 80}/health", timeout=0.8) as r:
            return "ready" if r.status == 200 else "loading"
    except urllib.error.HTTPError as e:
        return "loading" if e.code == 503 else "down"
    except Exception:
        return "down"


def log_tail(n: int = 25) -> str:
    try:
        with open(CTX["log"], "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 8000))
            return "\n".join(f.read().decode("utf-8", "replace").splitlines()[-n:])
    except OSError:
        return ""


def state(endpoint: str) -> str:
    """stopped | loading | ready | crashed | external (answering, but not ours)"""
    h = health(endpoint)
    if running():
        return "ready" if h == "ready" else "loading"
    if PROC is not None and PROC.poll() is not None:
        return "crashed"
    return "external" if h == "ready" else "stopped"


def status(endpoint: str, server: str, model: str) -> dict:
    inst = set(installed_models())
    return {"state": state(endpoint), "server": server, "model": model, "models": sorted(inst),
            "catalog": [dict(m, installed=str(models_dir() / m["file"]) in inst,
                             path=str(models_dir() / m["file"])) for m in CATALOG],
            "download": DL.snapshot(), "log": log_tail(), "data_dir": str(data_dir()),
            "since": round(time.time() - STARTED["t"]) if running() else 0}
