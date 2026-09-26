"""
board.py - build a .bit and load it onto the board, run by the launcher for the editor's
"ลงบอร์ด" page (so the student never leaves Schematic Studio).

It does what FPGA Builder's Vivado path does, without its Tk window:
  * writes <top>.vhd, <top>.xdc and build.tcl (same Tcl as FPGA Builder, incl. the
    CLOCK_DEDICATED_ROUTE fix for clocks on switch/button pins) into a build folder;
  * runs Vivado in batch mode and streams its output;
  * loads the .bit with openFPGALoader: SRAM (-m, fast, lost at power-off) or SPI flash
    (-f -B spiOverJtag_<part>.bit, permanent).
One job at a time; the editor polls status(). Error explanations (Thai) and the .bit header
reader come from fpga_builder.py when it can be imported.

Vivado cannot build in a path with spaces (its Tcl splits on them), and the workspace lives in
"Documents/FPGA Ecosystem", so builds go to a space-free folder and the .bit is copied back into
the project folder afterwards.
"""
from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

IS_WIN = os.name == "nt"
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# EDGE Spartan-7 board (the course board)
BOARD = {"label": "EDGE Spartan-7 (XC7S15)", "part": "xc7s15", "pkg": "ftgb196", "speed": "-1",
         "clk_period_ns": "20"}
CABLES = ["ft2232", "digilent", "digilent_hs2", "digilent_hs3", "ft232", "ft231X", "ft4232"]

CTX = {"root": Path("."), "install": Path("."), "config_dir": Path("."), "detect_vivado": lambda: "",
       "cfg": lambda: {}}


def init(root: Path, install: Path, config_dir: Path, detect_vivado, cfg):
    CTX.update(root=Path(root), install=Path(install), config_dir=Path(config_dir),
               detect_vivado=detect_vivado, cfg=cfg)


def _fb():
    """fpga_builder.py (error hints, .bit header, bundled tool paths) - optional."""
    try:
        src = CTX["root"] / "FPGA_Builder_Package" / "source"
        if str(src) not in sys.path:
            sys.path.insert(0, str(src))
        import fpga_builder  # noqa: E402
        return fpga_builder
    except Exception:
        return None


def _first(paths):
    for p in paths:
        if p and Path(p).is_file():
            return str(p)
    return ""


def find_vivado() -> str:
    f = CTX["cfg"]().get("features", {})
    fb = _fb()
    return _first([f.get("vivado"), fb.find_vivado() if fb else "", CTX["detect_vivado"]()])


def find_ofl() -> str:
    f = CTX["cfg"]().get("features", {})
    exe = "openFPGALoader.exe" if IS_WIN else "openFPGALoader"
    return _first([f.get("openfpgaloader"),
                   CTX["install"] / "tools" / "openFPGALoader" / exe,
                   CTX["root"] / "FPGA_Builder_Package" / "tools" / "openFPGALoader" / exe,
                   shutil.which("openFPGALoader") or "",
                   r"C:\msys64\mingw64\bin\openFPGALoader.exe" if IS_WIN else ""])


def tools() -> dict:
    return {"vivado": find_vivado(), "openfpgaloader": find_ofl(), "board": BOARD["label"],
            "cables": CABLES}


def safe_id(s: str, fallback="design") -> str:
    s = re.sub(r"[^A-Za-z0-9_]", "_", str(s or "")).strip("_")
    if not s or not s[0].isalpha():
        s = "d_" + s if s else fallback
    return s[:48]


def build_root() -> Path:
    """a folder Vivado can live with: no spaces, ASCII only"""
    cands = [CTX["config_dir"] / "build"]
    if IS_WIN:
        cands += [Path(os.environ.get("LOCALAPPDATA", "")) / "FPGAEcosystem" / "build",
                  Path(os.environ.get("PUBLIC", r"C:\Users\Public")) / "FPGAEcosystem" / "build",
                  Path(r"C:\FPGAEcosystem\build")]
    for c in cands:
        s = str(c)
        if c and " " not in s and s.isascii():
            return c
    return cands[-1]


# --------------------------------------------------------------------------
# the one running job
# --------------------------------------------------------------------------
class Job:
    def __init__(self):
        self.lock = threading.Lock()
        self.reset("idle")

    def reset(self, kind):
        self.kind, self.state, self.lines, self.hint, self.result = kind, "idle", [], "", {}
        self.proc, self.started, self.ended, self.cancel = None, time.time(), 0.0, False

    def log(self, s):
        for ln in str(s).splitlines() or [""]:
            self.lines.append(ln)
        if len(self.lines) > 5000:
            del self.lines[:1000]

    def busy(self):
        return self.state == "running"


JOB = Job()


def status(since: int = 0) -> dict:
    j = JOB
    since = max(0, min(int(since or 0), len(j.lines)))
    return {"kind": j.kind, "state": j.state, "lines": j.lines[since:], "next": len(j.lines),
            "hint": j.hint, "result": j.result,
            "elapsed": round((j.ended or time.time()) - j.started, 1) if j.kind != "idle" else 0}


def _clean_env(extra_path: str = "") -> dict:
    """The frozen launcher bundles its own Tcl/Tk (for FPGA Builder). Vivado must not see it:
    PyInstaller exports TCL_LIBRARY/TK_LIBRARY and prepends its folder to PATH, and Vivado's
    Tcl 8.6.13 then dies with a version conflict. Hand Vivado a clean environment."""
    env = dict(os.environ)
    for k in ("TCL_LIBRARY", "TK_LIBRARY", "TCLLIBPATH", "TIX_LIBRARY", "PYTHONHOME", "PYTHONPATH"):
        env.pop(k, None)
    mei = getattr(sys, "_MEIPASS", None)
    parts = [p for p in env.get("PATH", "").split(os.pathsep)
             if p and not (mei and os.path.normcase(p).startswith(os.path.normcase(mei)))]
    if extra_path:
        parts.insert(0, extra_path)
    env["PATH"] = os.pathsep.join(parts)
    return env


def _run(kind, cmd, cwd, on_ok=None, scan_log=None, env=None, ok_check=None):
    def worker():
        j = JOB
        try:
            j.log("$ " + " ".join(cmd))
            j.proc = subprocess.Popen(cmd, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                      stdin=subprocess.DEVNULL, env=env or _clean_env(),
                                      text=True, encoding="utf-8", errors="replace",
                                      creationflags=_NO_WINDOW)
            for line in j.proc.stdout:
                j.log(line.rstrip("\n"))
            rc = j.proc.wait()
            ok = rc == 0 and (ok_check() if ok_check else True)
            if j.cancel:
                j.state = "stopped"
                j.log("หยุดแล้ว")
            elif ok:
                if on_ok:
                    on_ok()
                j.state = "ok"
            else:
                j.state = "error"
                text = "\n".join(j.lines)
                try:
                    if scan_log and Path(scan_log).is_file():
                        text = Path(scan_log).read_text(encoding="utf-8", errors="replace")
                except OSError:
                    pass
                j.hint = explain(text, kind)
                j.log(f"ล้มเหลว (exit {rc})")
        except FileNotFoundError as e:
            j.state = "error"
            j.log(f"เรียกโปรแกรมไม่ได้: {e}")
        except Exception as e:  # noqa: BLE001
            j.state = "error"
            j.log(f"ข้อผิดพลาด: {type(e).__name__}: {e}")
        finally:
            j.ended = time.time()
            j.proc = None
    threading.Thread(target=worker, daemon=True).start()


def explain(text: str, kind: str) -> str:
    fb = _fb()
    if fb and kind == "build":
        try:
            h = fb.FPGABuilder._build_error_hint(None, text)
            if h:
                return h
        except Exception:
            pass
    low = (text or "").lower()
    if kind != "build" and ("unable to open ftdi" in low or "usb_open" in low or "jtag init failed" in low
                            or "no cable found" in low or "libusb" in low):
        return ("เปิดบอร์ดไม่ได้ — เช็คว่าเสียบสาย USB แล้ว และไดรเวอร์เป็น WinUSB "
                "(ครั้งแรกใช้ปุ่ม “ตั้งไดรเวอร์” ใน FPGA Builder แบบเดิม หรือโปรแกรม Zadig)")
    if kind == "build" and "unconstrained" in low:
        return "มีขาที่ยังไม่ได้เลือกพิน — กลับไปหน้า “เลือกขา” แล้วเลือกให้ครบทุกขา"
    return ""


def stop() -> dict:
    j = JOB
    if not j.busy() or not j.proc:
        return {"ok": False, "error": "ไม่มีงานที่กำลังทำ"}
    j.cancel = True
    try:
        if IS_WIN:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(j.proc.pid)], capture_output=True,
                           creationflags=_NO_WINDOW)
        else:
            j.proc.kill()
    except Exception:
        pass
    return {"ok": True}


def _start(kind) -> str | None:
    with JOB.lock:
        if JOB.busy():
            return "กำลังทำงานอื่นอยู่ — รอให้เสร็จ หรือกดหยุดก่อน"
        JOB.reset(kind)
        JOB.state = "running"
    return None


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------
def write_tcl(bdir: Path, top: str, vhd_files, part: str) -> Path:
    tcl = bdir / "build.tcl"
    lines = ["catch {config_webtalk -install off}"]
    lines += ['read_vhdl "{}"'.format(str(Path(v).resolve()).replace("\\", "/")) for v in vhd_files]
    lines += [f'read_xdc "{top}.xdc"',
              f"synth_design -top {top} -part {part} -directive RuntimeOptimized",
              # a clock on a switch/button pin: demote the placer's dedicated-route error (see fpga_builder)
              "catch {",
              "  foreach bc [get_cells -quiet -hier -filter {REF_NAME =~ BUFG*}] {",
              "    set n [get_nets -quiet -of_objects [get_pins -quiet $bc/I]]",
              "    if {[llength $n]} { set_property CLOCK_DEDICATED_ROUTE FALSE $n }",
              "  }",
              "}",
              "place_design -directive Quick", "route_design -directive Quick",
              f'write_bitstream -force "{top}.bit"']
    tcl.write_text("\n".join(lines) + "\n", encoding="mbcs" if IS_WIN else "utf-8", errors="replace")
    return tcl


def xdc_with_config(xdc: str, top_vhdl: str, clk_port: str = "") -> str:
    out = xdc.rstrip() + "\n"
    if clk_port and "create_clock" not in xdc:
        out += f"\ncreate_clock -name sys_clk -period {BOARD['clk_period_ns']} [get_ports {{{clk_port}}}]\n"
    if "CONFIG_VOLTAGE" not in xdc:
        out += "set_property CFGBVS VCCO [current_design]\nset_property CONFIG_VOLTAGE 3.3 [current_design]\n"
    return out


def start_build(project: str, top: str, vhdl: str, xdc: str, clk_port: str = "",
                project_dir: Path | None = None) -> dict:
    top = safe_id(top)
    viv = find_vivado()
    if not viv:
        return {"ok": False, "error": "ไม่พบ Vivado — ติดตั้ง Vivado (ML Standard ฟรี) แล้วตั้งค่า path ในหน้า ตั้งค่า"}
    if " " in viv and IS_WIN:
        return {"ok": False, "error": f"path ของ Vivado มีช่องว่าง ({viv}) — Vivado จะ build ไม่ผ่าน ย้ายไปโฟลเดอร์ที่ไม่มีช่องว่าง"}
    err = _start("build")
    if err:
        return {"ok": False, "error": err}
    bdir = build_root() / safe_id(project, top)
    bdir.mkdir(parents=True, exist_ok=True)
    vf = bdir / f"{top}.vhd"
    vf.write_text(vhdl, encoding="utf-8")
    (bdir / f"{top}.xdc").write_text(xdc_with_config(xdc, vhdl, clk_port), encoding="utf-8")
    part = BOARD["part"] + BOARD["pkg"] + BOARD["speed"]
    write_tcl(bdir, top, [vf], part)
    bit = bdir / f"{top}.bit"
    t0 = time.time()
    try:
        if bit.exists():
            bit.unlink()
    except OSError:
        pass
    JOB.log(f"บอร์ด: {BOARD['label']} · ชิป {part}")
    JOB.log(f"โฟลเดอร์ build: {bdir}")
    JOB.log("เริ่ม build ด้วย Vivado (ปกติราว 1 นาที) …")

    def done():
        JOB.result = {"bit": str(bit), "top": top}
        if project_dir:
            try:
                project_dir.mkdir(parents=True, exist_ok=True)
                dst = project_dir / f"{top}.bit"
                shutil.copy2(bit, dst)
                JOB.result["saved"] = str(dst)
            except OSError as e:
                JOB.log(f"คัดลอก .bit เข้าโฟลเดอร์โปรเจกต์ไม่ได้: {e}")
        JOB.log(f"สำเร็จ! ได้ไฟล์ {top}.bit")
    cmd = (["cmd", "/c", "call", viv] if IS_WIN else [viv]) + \
          ["-mode", "batch", "-source", "build.tcl", "-nojournal", "-log", "vivado_build.log"]
    _run("build", cmd, bdir, on_ok=done, scan_log=bdir / "vivado_build.log",
         ok_check=lambda: bit.is_file() and bit.stat().st_mtime >= t0 - 1)
    return {"ok": True, "dir": str(bdir)}


def last_bit(project: str, top: str) -> Path | None:
    b = build_root() / safe_id(project, safe_id(top)) / f"{safe_id(top)}.bit"
    return b if b.is_file() else None


def bit_info(path: Path) -> dict:
    fb = _fb()
    try:
        return fb.parse_bit_header(str(path)) if fb else {}
    except Exception:
        return {}


def start_program(project: str, top: str, mode: str = "sram", cable: str = "ft2232") -> dict:
    ofl = find_ofl()
    if not ofl:
        return {"ok": False, "error": "ไม่พบ openFPGALoader (โปรแกรมโหลด .bit ลงบอร์ด) — ติดตั้งชุดเต็มหรือวางไว้ที่ tools\\openFPGALoader"}
    bit = last_bit(project, top)
    if not bit:
        return {"ok": False, "error": "ยังไม่มีไฟล์ .bit — กด “สร้าง .bit” ก่อน"}
    info = bit_info(bit)
    part = (info.get("part") or "").lower()
    if part and not part.startswith(BOARD["part"].replace("xc", "")):
        return {"ok": False, "error": f"ไฟล์ .bit นี้สร้างให้ชิป xc{part} ไม่ใช่ {BOARD['part']} — build ใหม่ก่อน"}
    cable = cable if cable in CABLES else "ft2232"
    if mode == "flash":
        name = f"spiOverJtag_{BOARD['part']}{BOARD['pkg']}.bit"
        d = Path(ofl).parent
        bridge = _first([d / name, CTX["install"] / "tools" / "openFPGALoader" / name,
                         d.parent / "share" / "openFPGALoader" / name])
        if not bridge:
            return {"ok": False, "error": f"เขียนถาวรต้องมีไฟล์ {name} วางไว้ข้าง openFPGALoader"}
        cmd = [ofl, "-c", cable, "-f", "-B", bridge.replace("\\", "/"), str(bit)]
        done = "เขียนลง Flash สำเร็จ — วงจรอยู่ถาวรแม้ถอดปลั๊ก"
    else:
        cmd = [ofl, "-c", cable, "-m", str(bit)]
        done = "โหลดลงบอร์ดสำเร็จ — ลองกดสวิตช์บนบอร์ดได้เลย (หายเมื่อถอดปลั๊ก)"
    err = _start("program")
    if err:
        return {"ok": False, "error": err}
    JOB.log(("เขียน Flash (ถาวร): " if mode == "flash" else "โหลดลง FPGA (ชั่วคราว): ") + str(bit))
    # openFPGALoader from MSYS2 calls cygpath (bundled next to it) when writing flash
    _run("program", cmd, Path(ofl).parent, on_ok=lambda: JOB.log(done),
         env=_clean_env(str(Path(ofl).parent)))
    return {"ok": True}


def start_detect(cable: str = "ft2232") -> dict:
    ofl = find_ofl()
    if not ofl:
        return {"ok": False, "error": "ไม่พบ openFPGALoader"}
    err = _start("detect")
    if err:
        return {"ok": False, "error": err}
    _run("detect", [ofl, "-c", cable if cable in CABLES else "ft2232", "--detect"], Path(ofl).parent,
         on_ok=lambda: JOB.log("เจอบอร์ดแล้ว ✓"), env=_clean_env(str(Path(ofl).parent)))
    return {"ok": True}
