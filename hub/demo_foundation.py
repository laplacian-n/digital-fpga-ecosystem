# -*- coding: utf-8 -*-
"""Prove the Phase-0.5 foundation: Canonical IR + semantic/presentation hash +
durable store + evidence-based pipeline state with a HASH CHAIN.

Key property demonstrated:
  - moving a node (presentation change) does NOT stale sim/vhdl/synth
  - a semantic edit (typed patch) DOES stale them (hash chain)
"""
import copy
import json
import tempfile
from pathlib import Path

import ir as IR
from store import Store, STAGES
import errors

FA = {"module": "full_adder", "components": [
    {"id": "a", "type": "IN", "name": "a", "x": 80, "y": 100},
    {"id": "b", "type": "IN", "name": "b", "x": 80, "y": 200},
    {"id": "cin", "type": "IN", "name": "cin", "x": 80, "y": 300},
    {"id": "x1", "type": "XOR", "x": 260, "y": 120}, {"id": "x2", "type": "XOR", "x": 440, "y": 140},
    {"id": "a1", "type": "AND", "x": 260, "y": 260}, {"id": "a2", "type": "AND", "x": 440, "y": 300},
    {"id": "o1", "type": "OR", "x": 620, "y": 280},
    {"id": "sum", "type": "OUT", "name": "sum", "x": 820, "y": 140},
    {"id": "cout", "type": "OUT", "name": "cout", "x": 820, "y": 280}],
    "nets": [{"from": "a", "to": "x1"}, {"from": "b", "to": "x1"}, {"from": "x1", "to": "x2"},
             {"from": "cin", "to": "x2"}, {"from": "a", "to": "a1"}, {"from": "b", "to": "a1"},
             {"from": "x1", "to": "a2"}, {"from": "cin", "to": "a2"}, {"from": "a1", "to": "o1"},
             {"from": "a2", "to": "o1"}, {"from": "x2", "to": "sum"}, {"from": "o1", "to": "cout"}]}


def show(st, uid, label):
    s = st.stage_state(uid)
    d = st.get_design(uid)
    print(f"\n[{label}] rev={d['revision']} sem={d['semantic_hash'][:10]} pres={d['presentation_hash'][:10]}")
    print("  " + " | ".join(f"{k}:{v['status']}" for k, v in s.items() if k in
          ("sim", "vhdl", "cosim", "synth")))


db = Path(tempfile.mkdtemp()) / "hub.db"
st = Store(db)
uid = "fa1"

# 1) save design, record downstream stages as passed
ir = IR.intent_to_ir(FA, provenance={"by": "pipeline", "gen": "synth-from-eq"})
st.save_design(ir, uid)
for stg in ("design", "sim", "vhdl", "cosim", "synth"):
    st.record_stage(uid, stg, "passed", evidence={"note": stg + " ok"})
show(st, uid, "after full pipeline pass")

# 2) PRESENTATION change: move node 'x1' 40px. semantic same -> stages stay FRESH
ir2 = copy.deepcopy(st.get_design(uid)["ir"])
ir2["presentation"]["x1"] = {"x": 300, "y": 160}
before = IR.semantic_hash(ir2)
st.save_design(ir2, uid)
show(st, uid, "after MOVING a node (presentation)")
assert IR.semantic_hash(ir2) == st.get_design(uid)["semantic_hash"] == before
assert all(not st.stage_state(uid)[s]["stale"] for s in ("sim", "vhdl", "synth")), "move must NOT stale!"
print("  -> OK: layout move did NOT invalidate sim/vhdl/synth")

# 3) SEMANTIC edit via typed transactional patch (bump revision) -> stages STALE
cur = st.get_design(uid)["ir"]
patch = {"operation": "set_param", "target_uid": "o1", "key": "inputs", "value": 3,
         "expected_revision": cur["revision"],
         "old_value_hash": IR._sha(IR.canonical(next(c for c in cur["components"]
                                   if c["uid"] == "o1").get("params") or {}))}
ir3 = IR.apply_patch(cur, patch)
st.save_design(ir3, uid)
show(st, uid, "after SEMANTIC patch (set_param o1.inputs=3)")
assert all(st.stage_state(uid)[s]["stale"] for s in ("sim", "vhdl", "synth")), "semantic edit MUST stale!"
print("  -> OK: semantic edit invalidated sim/vhdl/synth (hash chain)")

# 4) precondition guard: a stale patch (wrong expected_revision) is rejected
try:
    IR.apply_patch(st.get_design(uid)["ir"], {"operation": "rename", "target_uid": "a",
                   "value": "aa", "expected_revision": 999})
    print("  !! precond NOT enforced");
except IR.PatchError as e:
    print(f"  -> OK: stale patch rejected [{e.code}] (class={errors.classify(e.code)})")

print("\nrevisions:", [r["revision"] for r in st.list_revisions(uid)])
print("trace tail:", [t["event"] for t in st.recent_trace(6)])
print("\nFOUNDATION OK")
