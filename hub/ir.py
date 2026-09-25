"""
hub/ir.py - Canonical IR: the ONE semantic core (doc 08). Gate-level netlist is
the source of truth; VHDL / sim / gate-view / top-down all derive from this.

Key guarantees:
- Canonical JSON (sorted keys, no float drift, compact) so hashes are stable.
- semantic_hash (topology: modules/ports/nets/drivers/params) vs presentation_hash
  (x/y/layout). ONLY a semantic_hash change invalidates downstream (sim/vhdl/bit);
  moving a node changes presentation_hash only.
- stable object UID (lifetime) separate from revision (bumps on semantic edit).
- typed transactional patch (expected_revision + precondition -> apply/rollback).

Intent-JSON (topology the AI emits) maps INTO this IR here; the IR is what the
store, hash-chain, oracle and co-sim all reference.
"""
from __future__ import annotations
import copy
import hashlib
import json

SOURCES = {"IN", "VCC", "GND", "CONST"}
SEQ = {"DFF"}


def canonical(obj) -> str:
    """Canonical JSON for hashing: sorted keys, compact, UTF-8, ints not floats.
    Array order is preserved (meaningful) — callers sort semantic lists first."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# Intent-JSON  ->  Canonical IR
# --------------------------------------------------------------------------- #
def _ref_id(s):
    return str(s or "").split(".", 1)[0]


def _ref_pin(s):
    s = str(s or "")
    return s.split(".", 1)[1] if "." in s else None


def intent_to_ir(intent: dict, *, provenance: dict | None = None, revision: int = 1) -> dict:
    """Build a Canonical IR from an Intent-JSON topology. A net = one driver + its
    loads (grouped by the driver), matching doc 08 'net + driver/load'."""
    comps = []
    for c in intent.get("components", []):
        comps.append({
            "uid": c["id"], "type": c["type"],
            "name": c.get("name"), "params": c.get("params") or {},
            "role": ("input" if c["type"] == "IN" else "output" if c["type"] == "OUT"
                     else "source" if c["type"] in SOURCES else
                     "seq" if c["type"] in SEQ else "logic"),
            "provenance": provenance or {"by": "unknown"},
        })
    # group intent edges (from -> to[.pin]) into nets keyed by the driver id
    by_driver: dict[str, dict] = {}
    for n in intent.get("nets", []):
        drv = _ref_id(n.get("from"))
        load_id = _ref_id(n.get("to"))
        pin = _ref_pin(n.get("to"))
        load = load_id + ("." + pin if pin else "")
        by_driver.setdefault(drv, {"driver": drv, "loads": [], "name": n.get("name")})
        by_driver[drv]["loads"].append(load)
    nets = []
    for i, drv in enumerate(sorted(by_driver)):
        net = by_driver[drv]
        nets.append({"uid": f"net_{drv}", "driver": drv,
                     "loads": sorted(net["loads"]), "name": net.get("name")})
    pres = {c["id"]: {"x": c.get("x", 0), "y": c.get("y", 0)}
            for c in intent.get("components", []) if "x" in c or "y" in c}
    return {"module": intent.get("module", "design"), "revision": revision,
            "components": comps, "nets": nets, "presentation": pres,
            "provenance": provenance or {"by": "unknown"}, "info_loss": []}


def ir_to_intent(ir: dict) -> dict:
    """IR back to Intent-JSON (topology) for the drawing/codegen engines."""
    comps = [{"id": c["uid"], "type": c["type"],
              **({"name": c["name"]} if c.get("name") else {}),
              **({"params": c["params"]} if c.get("params") else {})}
             for c in ir["components"]]
    nets = []
    for n in ir["nets"]:
        for load in n["loads"]:
            nets.append({"from": n["driver"], "to": load})
    return {"module": ir.get("module", "design"), "components": comps, "nets": nets}


# --------------------------------------------------------------------------- #
# Hashes: semantic (topology) vs presentation (layout)
# --------------------------------------------------------------------------- #
def semantic_view(ir: dict) -> dict:
    """The topology-only projection that semantic_hash covers (NO x/y/layout)."""
    comps = sorted(({"uid": c["uid"], "type": c["type"], "name": c.get("name"),
                     "params": c.get("params") or {}, "role": c.get("role")}
                    for c in ir["components"]), key=lambda c: c["uid"])
    nets = sorted(({"driver": n["driver"], "loads": sorted(n["loads"]),
                    "name": n.get("name")} for n in ir["nets"]),
                  key=lambda n: n["driver"])
    return {"module": ir.get("module", "design"), "components": comps, "nets": nets}


def semantic_hash(ir: dict) -> str:
    return _sha(canonical(semantic_view(ir)))


def presentation_hash(ir: dict) -> str:
    return _sha(canonical(ir.get("presentation", {})))


# --------------------------------------------------------------------------- #
# Typed transactional patch (doc 08 §6): apply on a temp copy, guard by
# expected_revision + precondition, then caller validates/commits or rolls back.
# --------------------------------------------------------------------------- #
class PatchError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


def apply_patch(ir: dict, patch: dict) -> dict:
    """Return a NEW ir with the patch applied (revision bumped). Raises PatchError
    (with a taxonomy code) on precondition failure. Semantic ops only."""
    exp = patch.get("expected_revision")
    if exp is not None and exp != ir.get("revision"):
        raise PatchError("AI-PATCH-PRECOND",
                         f"expected_revision {exp} != current {ir.get('revision')}")
    new = copy.deepcopy(ir)
    op = patch.get("operation")
    if op == "set_param":
        c = _find_comp(new, patch["target_uid"])
        _precond(patch, canonical(c.get("params") or {}))
        c.setdefault("params", {})[patch["key"]] = patch["value"]
    elif op == "replace_connection":
        n = _find_net(new, patch["target_uid"])
        _precond(patch, canonical({"driver": n["driver"], "loads": sorted(n["loads"])}))
        n["driver"] = patch["new_driver"]
    elif op == "rename":
        c = _find_comp(new, patch["target_uid"])
        c["name"] = patch["value"]
    else:
        raise PatchError("SCHEMA-002", f"unknown patch operation {op!r}")
    new["revision"] = ir.get("revision", 1) + 1
    return new


def _find_comp(ir, uid):
    for c in ir["components"]:
        if c["uid"] == uid:
            return c
    raise PatchError("AI-PATCH-PRECOND", f"component {uid!r} not found")


def _find_net(ir, uid):
    for n in ir["nets"]:
        if n["uid"] == uid:
            return n
    raise PatchError("AI-PATCH-PRECOND", f"net {uid!r} not found")


def _precond(patch, current_canonical):
    want = patch.get("old_value_hash")
    if want is not None and want != _sha(current_canonical):
        raise PatchError("AI-PATCH-PRECOND", "old_value_hash mismatch (stale edit)")


if __name__ == "__main__":
    import sys
    intent = json.load(open(sys.argv[1], encoding="utf-8"))
    ir = intent_to_ir(intent)
    print("module:", ir["module"], "comps:", len(ir["components"]), "nets:", len(ir["nets"]))
    print("semantic_hash:    ", semantic_hash(ir))
    print("presentation_hash:", presentation_hash(ir))
