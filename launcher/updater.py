"""
updater.py - "is there a newer FPGA Ecosystem?" and "install it".

Releases are the GitHub Releases of the repo (built by .github/workflows/build-windows.yml
from a vX.Y.Z tag). The check asks the GitHub API for the latest release, compares its tag
with the running VERSION and picks the Setup.exe asset. Installing downloads that Setup.exe
and runs it silently; Inno Setup replaces the program files (projects in Documents and
settings in %APPDATA% are not touched) and starts the new version.

Pure stdlib. The API base is configurable so tests can point it at a local stub.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request

DEFAULT_API = "https://api.github.com"


def parse_version(v: str) -> tuple:
    """'v0.10.2' -> (0, 10, 2); anything unparsable -> ()."""
    m = re.match(r"^\s*v?(\d+(?:\.\d+)*)", str(v or ""))
    return tuple(int(x) for x in m.group(1).split(".")) if m else ()


def is_newer(latest: str, current: str) -> bool:
    a, b = parse_version(latest), parse_version(current)
    if not a or not b:
        return False
    n = max(len(a), len(b))
    return a + (0,) * (n - len(a)) > b + (0,) * (n - len(b))


def check(repo: str, current: str, api: str = DEFAULT_API, timeout: float = 6.0) -> dict:
    """-> {ok, available, current, latest, notes, url (release page), asset (Setup.exe url), asset_name}
       or {ok: False, error} (offline, private repo, no release yet …)."""
    url = f"{api.rstrip('/')}/repos/{repo}/releases/latest"
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json",
                                               "User-Agent": "FPGA-Ecosystem-updater"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            rel = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"ok": False, "error": "ยังไม่มี release ให้ดาวน์โหลด (หรือ repo เป็น private)"}
        return {"ok": False, "error": f"GitHub ตอบ {e.code}"}
    except Exception as e:  # offline, DNS, proxy …
        return {"ok": False, "error": f"เช็กอัปเดตไม่ได้ ({type(e).__name__})"}
    tag = rel.get("tag_name") or ""
    assets = rel.get("assets") or []
    setup = next((a for a in assets if re.search(r"Setup.*\.exe$", a.get("name", ""), re.I)), None)
    portable = next((a for a in assets if a.get("name", "").lower().endswith(".zip")), None)
    return {
        "ok": True,
        "current": current,
        "latest": tag.lstrip("v"),
        "available": is_newer(tag, current),
        "notes": (rel.get("body") or "")[:4000],
        "url": rel.get("html_url") or f"https://github.com/{repo}/releases/latest",
        "asset": setup and setup.get("browser_download_url"),
        "asset_name": setup and setup.get("name"),
        "portable": portable and portable.get("browser_download_url"),
        "published": rel.get("published_at"),
    }


class Installer:
    """Download Setup.exe in the background; progress is polled by the Home page."""

    def __init__(self):
        self.state = {"phase": "idle", "done": 0, "total": 0, "error": ""}
        self._lock = threading.Lock()

    def _set(self, **kw):
        with self._lock:
            self.state.update(kw)

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self.state)

    def start(self, asset_url: str, name: str, on_ready) -> bool:
        if self.state["phase"] in ("downloading", "installing"):
            return False
        self._set(phase="downloading", done=0, total=0, error="")
        threading.Thread(target=self._run, args=(asset_url, name, on_ready), daemon=True).start()
        return True

    def _run(self, asset_url, name, on_ready):
        dest = os.path.join(tempfile.gettempdir(), os.path.basename(name or "FPGAEcosystem-Setup.exe"))
        try:
            req = urllib.request.Request(asset_url, headers={"User-Agent": "FPGA-Ecosystem-updater"})
            with urllib.request.urlopen(req, timeout=30) as r, open(dest + ".part", "wb") as f:
                self._set(total=int(r.headers.get("Content-Length") or 0))
                while True:
                    chunk = r.read(256 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    self._set(done=self.state["done"] + len(chunk))
            os.replace(dest + ".part", dest)
        except Exception as e:
            self._set(phase="error", error=f"ดาวน์โหลดไม่สำเร็จ: {e}")
            return
        self._set(phase="installing")
        on_ready(dest)


def run_setup(path: str) -> None:
    """Silent in-place upgrade. The installer closes nothing we still need (the launcher
    exits right after this) and relaunches the app when it is done (installer.iss [Run])."""
    subprocess.Popen([path, "/SILENT", "/SP-", "/SUPPRESSMSGBOXES", "/NORESTART"],
                     creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
