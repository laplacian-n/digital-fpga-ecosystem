"""
synth_vivado.py - synthesize (and optionally implement -> bitstream) a verified
design on the REAL Xilinx toolchain (bundled vivado_min), for the EDGE Spartan-7
(xc7s15ftgb196-1). This confirms the AI-emitted VHDL is not just simulatable but
SYNTHESIZABLE on the target, and can produce a .bit for the board.

Vivado's .bat mangles under cmd.exe when its install path contains non-ASCII
(the project lives under a Thai "เอกสาร" path), so we launch it via PowerShell
Start-Process (Unicode-safe) and keep the work dir ASCII.

modes: "synth" (fast: synth_design + utilization) | "bit" (full impl + bitstream).
Returns {ok, mode, utilization, bitstream, log, errors}.

STATUS (2026-09-18): `vivado -version` runs via PowerShell, but `-mode batch`
synthesis in THIS bundled vivado_min aborts with a Windows Authenticode error
(0x800B0100 TRUST_E_NOSIGNATURE) before running the tcl. That's an environment/
bundle signing issue, not a code issue. So this module is EXPERIMENTAL. The
reliable path to a bitstream is the turnkey package the pipeline already emits
(<name>.vhd + .xdc + _build.tcl) handed to the working **FPGA_Builder** app.
"""
from __future__ import annotations
import json
import re
import subprocess
import tempfile
from pathlib import Path

from gen_vhdl import generate_vhdl, _san
from gen_xdc import generate_xdc

import os
# Vivado install path. IMPORTANT: Vivado synth cannot read its own data files
# (scripts/rt/data/XILINX.lib) when installed under a non-ASCII path — this bundle
# lives under a Thai "เอกสาร" folder, so synth fails (short-path/junction do NOT
# help; Vivado resolves the physical Unicode path). Fix: relocate vivado_min to an
# ASCII path and point VIVADO_BIN at it, e.g. set VIVADO_BIN=C:\vivado_min\...\vivado.bat
# Default points at the ASCII-relocated copy (C:\vivado_min) which synthesizes
# correctly; falls back to env VIVADO_BIN. The original bundle under the Thai
# path CANNOT synth (Vivado can't read its own data files there).
_ASCII_VIVADO = r"C:\vivado_min\bin\vivado.bat"
VIVADO = Path(os.environ.get("VIVADO_BIN",
              _ASCII_VIVADO if Path(_ASCII_VIVADO).exists() else
              r"C:\Users\dinuc\OneDrive\เอกสาร\digital\FPGA_Builder_Package"
              r"\tools\vivado_min\2025.2\Vivado\bin\vivado.bat"))
LICENSE = Path(os.environ.get("XILINX_LIC",
               r"C:\Users\dinuc\OneDrive\เอกสาร\digital\FPGA_Builder_Package\Xilinx.lic"))
PART = "xc7s15ftgb196-1"


def _tcl(top: str, has_xdc: bool, mode: str) -> str:
    t = [f"read_vhdl dut.vhd"]
    if has_xdc:
        t.append("read_xdc design.xdc")
    t.append(f"synth_design -top {top} -part {PART}")
    t.append("report_utilization -file util.rpt")
    if mode == "bit":
        t += ["opt_design", "place_design", "route_design",
              "report_timing_summary -file timing.rpt",
              f"write_bitstream -force {top}.bit"]
    t.append('puts "VIVADO_DONE_OK"')
    return "\n".join(t) + "\n"


def _short(path: Path) -> str:
    """Windows 8.3 short path (all-ASCII) — Vivado's synth subprocess fails to
    launch from a non-ASCII (Thai) install path, surfacing as a bogus Authenticode
    error; the short path avoids it."""
    import ctypes
    from ctypes import wintypes
    buf = ctypes.create_unicode_buffer(600)
    n = ctypes.windll.kernel32.GetShortPathNameW(str(path), buf, 600)
    return buf.value if n else str(path)


def _run_ps(workdir: Path, timeout: float):
    # PowerShell Start-Process + 8.3 short paths (cmd.exe/Thai path breaks Vivado).
    viv = _short(VIVADO)
    lic = _short(LICENSE)
    ps = (f"$env:XILINXD_LICENSE_FILE='{lic}';"
          f"$p=Start-Process -FilePath '{viv}' "
          f"-ArgumentList '-mode','batch','-source','build.tcl','-nojournal','-log','vivado.log' "
          f"-WorkingDirectory '{workdir}' -NoNewWindow -Wait -PassThru "
          f"-RedirectStandardOutput '{workdir}\\out.txt' -RedirectStandardError '{workdir}\\err.txt';"
          f"exit $p.ExitCode")
    return subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                          capture_output=True, text=True, timeout=timeout)


def synth(intent: dict, entity: str | None = None, mode: str = "synth",
          with_xdc: bool = True, timeout: float = 900.0, keep: bool = False) -> dict:
    if not VIVADO.exists():
        return {"ok": False, "error": f"vivado not found at {VIVADO}"}
    top = _san(entity or intent.get("module") or "ai_design")
    work = Path(tempfile.mkdtemp(prefix="viv_"))          # ASCII temp path
    (work / "dut.vhd").write_text(generate_vhdl(intent, entity=top), encoding="utf-8")
    has_xdc = False
    if with_xdc:
        try:
            xr = generate_xdc(intent)
            (work / "design.xdc").write_text(xr["xdc"], encoding="utf-8")
            has_xdc = True
        except Exception:
            has_xdc = False
    (work / "build.tcl").write_text(_tcl(top, has_xdc, mode), encoding="utf-8")
    try:
        _run_ps(work, timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "vivado timeout", "work": str(work)}
    log = ""
    for fn in ("out.txt", "vivado.log"):
        p = work / fn
        if p.exists():
            log += p.read_text(encoding="utf-8", errors="replace")
    ok = "VIVADO_DONE_OK" in log
    errors = re.findall(r"^ERROR:.*$", log, re.M)[:10]
    util = _parse_util(work / "util.rpt")
    bit = work / f"{top}.bit"
    res = {"ok": ok and not errors, "mode": mode, "part": PART,
           "utilization": util, "errors": errors,
           "bitstream": str(bit) if bit.exists() else None,
           "log_tail": log[-1500:] if (not ok or errors) else None, "work": str(work)}
    if not keep and res["ok"] and mode != "bit":
        import shutil
        shutil.rmtree(work, ignore_errors=True)
        res["work"] = None
    return res


def _parse_util(path: Path) -> dict:
    if not path.exists():
        return {}
    txt = path.read_text(encoding="utf-8", errors="replace")
    out = {}
    for key, pat in (("LUT", r"Slice LUTs\*?\s*\|\s*(\d+)"),
                     ("FF", r"(?:Slice|Register).*Flip Flop.*?\|\s*(\d+)"),
                     ("FF2", r"\|\s*Register as Flip Flop\s*\|\s*(\d+)"),
                     ("IO", r"Bonded IOB\s*\|\s*(\d+)")):
        m = re.search(pat, txt)
        if m:
            out[key] = int(m.group(1))
    if "FF2" in out:
        out.setdefault("FF", out.pop("FF2"))
    return out


if __name__ == "__main__":
    import sys
    intent = json.load(open(sys.argv[1], encoding="utf-8"))
    mode = sys.argv[2] if len(sys.argv) > 2 else "synth"
    r = synth(intent, mode=mode, keep=True)
    print(json.dumps({k: v for k, v in r.items() if k != "log_tail"}, ensure_ascii=False, indent=2))
    if r.get("log_tail"):
        print("---- log ----\n" + r["log_tail"])
