"""
legacy_live.py - lets the retired offline MCP servers (schematic_mcp.py, topdown/topdown_mcp.py)
see what is really on screen.

Those servers only know the JSON files they wrote themselves. A student who rearranged the
circuit in the editor asked Claude "is it still right?" and Claude, still wired to the old
server, answered from the stale file ("ข้อมูลที่อ่านได้ตรงกับที่ผมเซฟไว้ทุกอย่าง"). When the FPGA
Ecosystem app is running, these helpers read the LIVE sheet through the launcher's relay (the
same path the fpga-ecosystem server uses), and every answer says the old server is retired.
Nothing is started: if the app is not running, the old behaviour stays.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

RETIRED = ("NOTE: this offline server is retired — it only sees files it saved itself, not what the "
           "user has on screen. Use the 'fpga-ecosystem' MCP server instead (FPGA Ecosystem ▸ Settings ▸ "
           "Claude / MCP ▸ set up Claude Desktop; the Home page can also remove this old one). "
           "Always trust the LIVE editor state over saved files.")


def _app():
    sys.path.insert(0, str(Path(__file__).resolve().parent / "launcher"))
    try:
        import mcp_server  # type: ignore
    except Exception:
        return None
    app = mcp_server.APP
    base, token = app._read_runtime()
    if not base or not app._alive(base, token):
        return None                       # not running: never start it from here
    app.base, app.token = base, token
    return app


def live(op: str, args: dict | None = None, timeout: int = 20):
    """Result of an editor op on the running app, or None when the app is not running."""
    app = _app()
    if not app:
        return None
    try:
        reply = app.call(op, args or {}, timeout)
    except Exception:
        return None
    return reply.get("result") if reply.get("ok") else None


def live_sheets() -> str | None:
    """The sheets open in the editor right now, as text for the model (None if not running)."""
    res = live("status")
    if res is None:
        return None
    return json.dumps(res, ensure_ascii=False, indent=1)


def live_sheet(name: str | None) -> str | None:
    """A sheet as it is on screen now; `name` may be a saved design name — tried as a sheet name first."""
    res = live("get_sheet", {"sheet": name} if name else {})
    if res is None and name:
        res = live("get_sheet", {})
    if res is None:
        return None
    return json.dumps(res, ensure_ascii=False, indent=1)


SAVE_REFUSED = ("NOT SAVED. The FPGA Ecosystem app is running with the user's circuit open, and saving a file here "
                "then syncing it would REPLACE their sheet — including the placement and wiring they arranged by hand. "
                "Edit the open sheet live instead with the 'fpga-ecosystem' MCP server (add_component / connect / "
                "disconnect / update_component / apply): the user watches every change appear. If that server is not "
                "connected, ask the user to set it up: FPGA Ecosystem ▸ Home ▸ Claude / MCP ▸ 'ติดตั้งให้ Claude Desktop', "
                "then restart Claude Desktop.")


def running() -> bool:
    return _app() is not None
