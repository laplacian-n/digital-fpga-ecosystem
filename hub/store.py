"""
hub/store.py - durable foundation store (SQLite). Holds the semantic core + an
evidence-based pipeline state with a HASH CHAIN so downstream artifacts go stale
automatically when (and only when) the design's semantic_hash changes.

Tables:
  designs        current design per uid (IR + semantic/presentation hash + revision)
  revisions      immutable IR history (rollback / compare — doc Phase 5)
  artifacts      immutable outputs (sim/vhdl/cosim/draw/xdc/synth/bit), each TAGGED
                 with the semantic_hash it was built from  -> staleness = tag != now
  pipeline_state evidence per stage (status + input_hash + evidence + ts)
  jobs           durable job records (status/timeout/error) — survives restart
  trace          append-only observability log

Only a SEMANTIC change invalidates downstream; a pure layout move changes
presentation_hash but leaves every stage fresh.
"""
from __future__ import annotations
import json
import sqlite3
import time
from pathlib import Path

from ir import semantic_hash, presentation_hash

STAGES = ["design", "sim", "vhdl", "cosim", "draw", "xdc", "synth", "bit"]
# which prior stage's hash a stage depends on (all downstream key on semantic_hash)
_SCHEMA = """
CREATE TABLE IF NOT EXISTS designs(
  uid TEXT PRIMARY KEY, module TEXT, revision INTEGER,
  ir_json TEXT, semantic_hash TEXT, presentation_hash TEXT,
  provenance_json TEXT, updated_ts REAL);
CREATE TABLE IF NOT EXISTS revisions(
  design_uid TEXT, revision INTEGER, ir_json TEXT,
  semantic_hash TEXT, presentation_hash TEXT, ts REAL,
  PRIMARY KEY(design_uid, revision));
CREATE TABLE IF NOT EXISTS artifacts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, design_uid TEXT, kind TEXT,
  semantic_hash TEXT, data_json TEXT, path TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS pipeline_state(
  design_uid TEXT, stage TEXT, status TEXT, input_hash TEXT,
  evidence_json TEXT, ts REAL, PRIMARY KEY(design_uid, stage));
CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, design_uid TEXT,
  status TEXT, started_ts REAL, ended_ts REAL, error_json TEXT, result_json TEXT);
CREATE TABLE IF NOT EXISTS trace(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, design_uid TEXT,
  event TEXT, data_json TEXT);
"""


class Store:
    def __init__(self, path: str | Path = None):
        self.path = str(path or (Path(__file__).resolve().parent / "hub.db"))
        self.db = sqlite3.connect(self.path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(_SCHEMA)
        self.db.commit()

    # ---- designs / revisions ------------------------------------------------
    def save_design(self, ir: dict, uid: str) -> dict:
        sh, ph = semantic_hash(ir), presentation_hash(ir)
        rev = ir.get("revision", 1)
        now = time.time()
        self.db.execute(
            "REPLACE INTO designs VALUES(?,?,?,?,?,?,?,?)",
            (uid, ir.get("module"), rev, json.dumps(ir, ensure_ascii=False),
             sh, ph, json.dumps(ir.get("provenance", {}), ensure_ascii=False), now))
        self.db.execute(
            "INSERT OR REPLACE INTO revisions VALUES(?,?,?,?,?,?)",
            (uid, rev, json.dumps(ir, ensure_ascii=False), sh, ph, now))
        self.db.commit()
        self.trace(uid, "design.saved", {"revision": rev, "semantic_hash": sh[:12]})
        return {"uid": uid, "revision": rev, "semantic_hash": sh, "presentation_hash": ph}

    def get_design(self, uid: str) -> dict | None:
        r = self.db.execute("SELECT * FROM designs WHERE uid=?", (uid,)).fetchone()
        if not r:
            return None
        return {"uid": r["uid"], "module": r["module"], "revision": r["revision"],
                "ir": json.loads(r["ir_json"]), "semantic_hash": r["semantic_hash"],
                "presentation_hash": r["presentation_hash"]}

    def list_revisions(self, uid: str) -> list[dict]:
        rows = self.db.execute(
            "SELECT revision, semantic_hash, presentation_hash, ts FROM revisions "
            "WHERE design_uid=? ORDER BY revision", (uid,)).fetchall()
        return [dict(r) for r in rows]

    # ---- pipeline state + evidence -----------------------------------------
    def record_stage(self, uid: str, stage: str, status: str,
                     evidence: dict | None = None, input_hash: str | None = None):
        d = self.get_design(uid)
        ih = input_hash or (d["semantic_hash"] if d else None)
        self.db.execute("REPLACE INTO pipeline_state VALUES(?,?,?,?,?,?)",
                        (uid, stage, status, ih,
                         json.dumps(evidence or {}, ensure_ascii=False), time.time()))
        self.db.commit()
        self.trace(uid, "stage." + stage, {"status": status, "input_hash": (ih or "")[:12]})

    def put_artifact(self, uid: str, kind: str, *, data: dict | None = None,
                     path: str | None = None) -> int:
        d = self.get_design(uid)
        cur = self.db.execute(
            "INSERT INTO artifacts(design_uid,kind,semantic_hash,data_json,path,ts) "
            "VALUES(?,?,?,?,?,?)",
            (uid, kind, d["semantic_hash"] if d else None,
             json.dumps(data or {}, ensure_ascii=False), path, time.time()))
        self.db.commit()
        return cur.lastrowid

    def stage_state(self, uid: str) -> dict:
        """Per-stage {status, input_hash, stale, fresh, ts} using the HASH CHAIN:
        a stage is STALE if the semantic_hash it ran at != the design's current one."""
        d = self.get_design(uid)
        now_sh = d["semantic_hash"] if d else None
        rows = {r["stage"]: r for r in self.db.execute(
            "SELECT * FROM pipeline_state WHERE design_uid=?", (uid,)).fetchall()}
        out = {}
        for st in STAGES:
            r = rows.get(st)
            if not r:
                out[st] = {"status": "pending", "stale": False}
            else:
                stale = (st != "design") and (r["input_hash"] != now_sh)
                out[st] = {"status": ("stale" if stale else r["status"]),
                           "stale": stale, "input_hash": (r["input_hash"] or "")[:12],
                           "evidence": json.loads(r["evidence_json"] or "{}")}
        return out

    # ---- jobs (durable) -----------------------------------------------------
    def create_job(self, kind: str, uid: str | None = None) -> int:
        cur = self.db.execute(
            "INSERT INTO jobs(kind,design_uid,status,started_ts) VALUES(?,?,?,?)",
            (kind, uid, "running", time.time()))
        self.db.commit()
        return cur.lastrowid

    def finish_job(self, jid: int, status: str, error: dict | None = None,
                   result: dict | None = None):
        self.db.execute(
            "UPDATE jobs SET status=?,ended_ts=?,error_json=?,result_json=? WHERE id=?",
            (status, time.time(), json.dumps(error) if error else None,
             json.dumps(result, ensure_ascii=False) if result else None, jid))
        self.db.commit()

    def reap_orphans(self):
        """On restart, any 'running' job is orphaned (JOB-ORPHANED, transient)."""
        n = self.db.execute("UPDATE jobs SET status='orphaned' WHERE status='running'").rowcount
        self.db.commit()
        return n

    # ---- trace --------------------------------------------------------------
    def trace(self, uid: str | None, event: str, data: dict | None = None):
        self.db.execute("INSERT INTO trace(ts,design_uid,event,data_json) VALUES(?,?,?,?)",
                        (time.time(), uid, event, json.dumps(data or {}, ensure_ascii=False)))
        self.db.commit()

    def recent_trace(self, limit: int = 20) -> list[dict]:
        rows = self.db.execute("SELECT ts,design_uid,event,data_json FROM trace "
                               "ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [{"ts": r["ts"], "uid": r["design_uid"], "event": r["event"],
                 "data": json.loads(r["data_json"])} for r in rows][::-1]

    def close(self):
        self.db.close()
