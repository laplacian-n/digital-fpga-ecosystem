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
    # fine-tuned on this app's own agent / Q&A conversations (tools/dataset, train_lora.py): same tools, same
    # system prompt. Not hosted yet ("url" empty): the file is added with "นำเข้าไฟล์ .gguf" (import_model)
    {"id": "qwen3.5-4b-sft1", "name": "Qwen3.5 4B · ฝึกกับแอปนี้ (SFT1)", "size_gb": 3.5, "agent": True, "trained": True,
     "note": "ฝึกต่อจาก Qwen3.5 4B ด้วยบทสนทนาของเอเจนต์และถาม-ตอบในแอปนี้ · การ์ดจอ 4–6 GB",
     "file": "qwen3.5-4B-SFT1.gguf", "url": ""},
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
# -np 1: one chat at a time (the default is 4 slots, each with its own buffers);
# --cache-ram 1024: llama-server keeps old prompts in system RAM to reuse them, 8 GB by default —
# with the agent's long, growing prompts that filled a 24 GB laptop to 100 % (1.1.0 / 1.1.1).
DEFAULT_ARGS = "-c 65536 --jinja -fa on -ctk q8_0 -ctv q8_0 -np 1 --cache-ram 1024"
OLD_DEFAULT_ARGS = ("-c 8192 --jinja -ngl 999", "-c 65536 --jinja -fa on -ctk q8_0 -ctv q8_0")

# semantic search over the course notes (RAG): a small embedding model on its own llama-server,
# CPU-only (-ngl 0) so the GPU stays with the chat model. Kept in models/embed/ so it is never
# mistaken for a chat model.
EMBED = {"id": "qwen3-embedding-0.6b", "name": "Qwen3-Embedding 0.6B", "size_gb": 0.64,
         "note": "ค้นเนื้อหาวิชาแบบความหมาย (RAG) · ไทย/อังกฤษ · ใช้ CPU ไม่แย่งการ์ดจอ",
         "file": "Qwen3-Embedding-0.6B-Q8_0.gguf",
         "url": HF + "/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf"}
EMBED_PORT = {"port": 0}          # a free port picked at start (a fixed one could be taken by anything)
# -t / -tb 4: indexing the notes (once) must not take every core from the editor and the chat model
EMBED_ARGS = "--embedding --pooling last -ngl 0 -c 4096 -b 4096 -ub 4096 -np 1 --cache-ram 0 -t 4 -tb 4"

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


def embed_path() -> Path:
    return models_dir() / "embed" / EMBED["file"]


def download_model(model_id: str) -> dict:
    m = next((x for x in CATALOG + [EMBED] if x["id"] == model_id), None)
    if not m:
        return {"ok": False, "error": "ไม่รู้จักโมเดลนี้"}
    if not m.get("url"):
        return {"ok": False, "error": "โมเดลนี้ไม่มีให้ดาวน์โหลด — ใช้ “นำเข้าไฟล์ .gguf” กับไฟล์ที่มีอยู่"}

    def job():
        dst = embed_path() if m is EMBED else models_dir() / m["file"]
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.exists():
            _fetch(m["url"], dst)
        DL.s["path"] = str(dst)
    return _run(m["id"], job)


def import_model(src: str) -> dict:
    """Copy a .gguf the user already has (e.g. a fine-tuned model) into models/, with the download's progress
    bar. A file named like a catalog entry (any case) takes that entry's name, so it shows as installed."""
    src = str(src or "").strip().strip('"').strip("'")
    p = Path(os.path.expandvars(os.path.expanduser(src))) if src else None
    if not p or not p.is_file():
        return {"ok": False, "error": "ไม่พบไฟล์: " + (src or "(ว่าง)")}
    if p.suffix.lower() != ".gguf":
        return {"ok": False, "error": "ต้องเป็นไฟล์ .gguf"}
    with open(p, "rb") as f:
        if f.read(4) != b"GGUF":
            return {"ok": False, "error": "ไฟล์นี้ไม่ใช่ GGUF (หัวไฟล์ไม่ตรง)"}
    m = next((x for x in CATALOG if x["file"].lower() == p.name.lower()), None)
    dst = models_dir() / (m["file"] if m else p.name)
    try:
        if dst.resolve() == p.resolve():
            return {"ok": True, "path": str(dst), "already": True}
    except OSError:
        pass
    size = p.stat().st_size
    if dst.is_file() and dst.stat().st_size == size:
        return {"ok": True, "path": str(dst), "already": True}

    def job():
        dst.parent.mkdir(parents=True, exist_ok=True)
        part = dst.with_name(dst.name + ".part")
        DL.s.update(total=size, done=0)
        with open(p, "rb") as fi, open(part, "wb") as fo:
            while True:
                if DL.cancel:
                    raise RuntimeError("ยกเลิกแล้ว")
                b = fi.read(8 << 20)
                if not b:
                    break
                fo.write(b)
                DL.s["done"] += len(b)
        part.replace(dst)
        DL.s["path"] = str(dst)
    r = _run((m or {}).get("id") or p.name, job)
    return dict(r, path=str(dst)) if r.get("ok") else r


def preferred_model(paths: list) -> str:
    """The model to use when none is set: catalog order (the fine-tuned one first), then anything else."""
    order = {m["file"].lower(): i for i, m in enumerate(CATALOG)}
    return min(paths, key=lambda q: (order.get(Path(q).name.lower(), len(order)), q)) if paths else ""


def cancel_download() -> dict:
    DL.cancel = True
    return {"ok": True}


# --------------------------------------------------------------------------
# the server
# --------------------------------------------------------------------------
PROC = None
STARTED = {"model": "", "port": 0, "t": 0.0}


EPROC = None


# ---- no orphaned model servers ------------------------------------------------------------------
# A llama-server outlived the app whenever the app was closed hard (the updater installing a new
# version, a crash, Task Manager): the next start could not see it and started another, and each one
# kept its model + context in RAM — a 24 GB laptop filled up. Now (1) on Windows every server is put
# in a Job Object that kills it when the app goes, and (2) before a start, any llama-server running
# from our own llama folder that is not ours is stopped.
_JOB = {"h": None}


def _bind_to_app(proc) -> None:
    """Windows: the process dies with the app (a Job Object with KILL_ON_JOB_CLOSE)"""
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32
        if _JOB["h"] is None:
            class IOC(ctypes.Structure):
                _fields_ = [(n, ctypes.c_ulonglong) for n in ("r", "w", "o", "rt", "wt", "ot")]

            class BASIC(ctypes.Structure):
                _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                            ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                            ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                            ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

            class EXT(ctypes.Structure):
                _fields_ = [("Basic", BASIC), ("Io", IOC), ("ProcessMemoryLimit", ctypes.c_size_t),
                            ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                            ("PeakJobMemoryUsed", ctypes.c_size_t)]
            k32.CreateJobObjectW.restype = wintypes.HANDLE
            h = k32.CreateJobObjectW(None, None)
            info = EXT()
            info.Basic.LimitFlags = 0x2000                       # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            k32.SetInformationJobObject(wintypes.HANDLE(h), 9, ctypes.byref(info), ctypes.sizeof(info))
            _JOB["h"] = h
        k32.AssignProcessToJobObject(wintypes.HANDLE(_JOB["h"]), wintypes.HANDLE(int(proc._handle)))
    except Exception:
        pass


_PCACHE = {"t": 0.0, "v": []}


def llama_processes(fresh: bool = False) -> list:
    """every llama-server running on this machine: [{pid, mb, path, ours}] (ours = started by this app now);
    cached 15 s — Home polls the status often and a process scan on Windows takes about a second"""
    if not fresh and time.time() - _PCACHE["t"] < 15:
        return _PCACHE["v"]
    mine = {p.pid for p in (PROC, EPROC) if p is not None and p.poll() is None}
    out = []
    if os.name == "nt":
        try:
            ps = ("Get-CimInstance Win32_Process -Filter \"name='llama-server.exe'\" | "
                  "Select-Object ProcessId,ExecutablePath,WorkingSetSize | ConvertTo-Json -Compress")
            r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, timeout=15, creationflags=_NO_WINDOW)
            data = json.loads(r.stdout.decode("utf-8", "replace") or "[]")
            for d in ([data] if isinstance(data, dict) else data or []):
                out.append({"pid": int(d.get("ProcessId") or 0), "path": d.get("ExecutablePath") or "",
                            "mb": round(int(d.get("WorkingSetSize") or 0) / 2**20)})
        except Exception:
            pass
    else:
        for d in Path("/proc").glob("[0-9]*"):
            try:
                args = (d / "cmdline").read_bytes().split(b"\0")
                prog = next((a.decode("utf-8", "replace") for a in args[:2] if Path(a.decode("utf-8", "replace")).name.startswith("llama-server")), None)
                if not prog:
                    continue
                rss = next((int(x.split()[1]) for x in (d / "status").read_text().splitlines() if x.startswith("VmRSS:")), 0)
                out.append({"pid": int(d.name), "path": prog, "mb": round(rss / 1024)})
            except Exception:
                continue
    for p in out:
        p["ours"] = p["pid"] in mine
    _PCACHE.update(t=time.time(), v=out)
    return out


def stop_strays() -> list:
    """stop every llama-server from OUR llama folder that this app did not start (left by an earlier run)"""
    base = str(llama_dir().resolve()).lower()
    gone = []
    for p in llama_processes(fresh=True):
        if p["ours"] or not p["path"] or not str(Path(p["path"]).resolve()).lower().startswith(base):
            continue
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/PID", str(p["pid"])], capture_output=True, timeout=10, creationflags=_NO_WINDOW)
            else:
                os.kill(p["pid"], 9)
            gone.append(p)
        except Exception:
            pass
    _PCACHE["t"] = 0                                     # the list changed
    return gone


def embed_running() -> bool:
    return EPROC is not None and EPROC.poll() is None


def embed_endpoint() -> str:
    return f"http://127.0.0.1:{EMBED_PORT['port']}/v1/embeddings"


def start_embed(server: str) -> dict:
    """The embedding server (idempotent). Returns once it is started, not once it is ready."""
    global EPROC
    if embed_running():
        return {"ok": True}
    if not (server and Path(server).is_file()):
        return {"ok": False, "error": "no llama.cpp"}
    if not embed_path().is_file():
        return {"ok": False, "error": "no embedding model"}
    import socket
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        EMBED_PORT["port"] = so.getsockname()[1]
    log = open(CTX["log"].with_name("llama-embed.log"), "wb")
    EPROC = subprocess.Popen([server, "-m", str(embed_path()), "--host", "127.0.0.1", "--port", str(EMBED_PORT["port"])]
                             + EMBED_ARGS.split(), stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             cwd=str(Path(server).parent), creationflags=_NO_WINDOW)
    _bind_to_app(EPROC)
    return {"ok": True}


def stop_embed() -> dict:
    global EPROC
    if EPROC is not None:
        try:
            EPROC.terminate()
            EPROC.wait(timeout=5)
        except Exception:
            try:
                EPROC.kill()
            except Exception:
                pass
    EPROC = None
    return {"ok": True}


def embed(texts: list, timeout: float = 120) -> list:
    """Unit vectors for texts, from the embedding server."""
    body = json.dumps({"input": texts, "model": "embed"}).encode("utf-8")
    req = urllib.request.Request(embed_endpoint(), data=body, method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8"))["data"]
    out = []
    for d in sorted(data, key=lambda x: x.get("index", 0)):
        v = d["embedding"]
        if v and isinstance(v[0], list):          # some builds return one vector per token
            v = v[-1]
        n = sum(x * x for x in v) ** 0.5 or 1.0
        out.append([x / n for x in v])
    return out


STRAYS = {"stopped": []}


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
    STRAYS["stopped"] = stop_strays()            # left behind by an earlier run of the app: they hold RAM / VRAM
    PROC = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            cwd=str(Path(server).parent), creationflags=_NO_WINDOW)
    _bind_to_app(PROC)
    _PCACHE["t"] = 0
    STARTED.update(model=model, port=port, t=time.time())
    return {"ok": True, "stopped_leftovers": len(STRAYS["stopped"])}


def stop() -> dict:
    """Stop the chat model, and the embedding server with it (หยุด = the AI stops using memory)."""
    global PROC
    stop_embed()
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
            "embed": dict(EMBED, installed=embed_path().is_file(), path=str(embed_path()), running=embed_running()),
            "since": round(time.time() - STARTED["t"]) if running() else 0,
            "processes": llama_processes(), "leftovers_stopped": STRAYS["stopped"]}
