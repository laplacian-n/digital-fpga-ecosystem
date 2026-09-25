"""
hub/checks.py - structural semantic checks that return TYPED taxonomy errors
(doc 07). These are the gates the mutation suite asserts against ("inject a
multi-driver -> must get SEM-005"). Works on an Intent-JSON topology.

  SEM-004 floating-net     : a gate/OUT input with no driver, or an undriven output
  SEM-005 multi-driver     : one sink pin driven by >1 distinct driver
  SEM-006 comb-loop        : combinational cycle not broken by a DFF
  SCHEMA-001/002           : (delegated to validate_intent for shape/type)
"""
from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ai"))
from errors import err
from intent_validate import (validate_intent, INTENT_GATES, INTENT_SOURCES,
                             INTENT_SEQ, _ref)
import netlist_sim as NS


def _sink_pin(to: str, comp_type: str, order_idx: int) -> str:
    r = _ref(to)
    if r["pin"]:
        return r["id"] + "." + r["pin"]
    if comp_type == "OUT":
        return r["id"] + ".i"
    return r["id"] + ".i" + str(order_idx)   # auto-index approximation


def check_multidriver(intent: dict) -> list[dict]:
    comps = {c["id"]: c for c in intent.get("components", [])}
    pin_drivers: dict[str, set] = {}
    idx: dict[str, int] = {}
    for n in intent.get("nets", []):
        drv = _ref(n.get("from"))["id"]
        t = _ref(n.get("to"))
        tc = comps.get(t["id"])
        if not tc:
            continue
        k = t["id"] + "." + (t["pin"] or ("i" if tc["type"] == "OUT" else "i" + str(idx.get(t["id"], 0))))
        if not t["pin"] and tc["type"] != "OUT":
            idx[t["id"]] = idx.get(t["id"], 0) + 1
        pin_drivers.setdefault(k, set()).add(drv)
    out = []
    for pin, drivers in pin_drivers.items():
        if len(drivers) > 1:
            out.append(err("SEM-005", f"pin {pin} driven by {len(drivers)} drivers: {sorted(drivers)}",
                           refs=[pin]))
    return out


def check_floating(intent: dict) -> list[dict]:
    comps = {c["id"]: c for c in intent.get("components", [])}
    in_count: dict[str, int] = {}
    driven = set()
    for n in intent.get("nets", []):
        t = _ref(n.get("to"))["id"]
        in_count[t] = in_count.get(t, 0) + 1
        driven.add(t)
    out = []
    for c in intent.get("components", []):
        t = c["type"]
        if t in INTENT_GATES and in_count.get(c["id"], 0) == 0:
            out.append(err("SEM-004", f"gate {c['id']} ({t}) has no driver (floating input)", refs=[c["id"]]))
        if t == "OUT" and c["id"] not in driven:
            out.append(err("SEM-004", f"output {c['id']} is undriven (floating)", refs=[c["id"]]))
    return out


def check_comb_loop(intent: dict) -> list[dict]:
    try:
        NS.truth_table(intent) if not NS.is_sequential(intent) else NS.simulate_sequential(intent, cycles=2)
        return []
    except Exception as e:
        msg = str(e)
        if "loop" in msg.lower():
            return [err("SEM-006", "combinational loop (not broken by a DFF): " + msg[:100])]
        return [err("SEM-004", "simulation could not resolve netlist: " + msg[:100])]


def check_all(intent: dict) -> list[dict]:
    """All structural gates, as typed errors. Empty list = structurally clean."""
    v = validate_intent(intent)
    errs = []
    for e in v["errors"]:
        # map the editor-mirror ERC codes into the taxonomy space where sensible
        code = {"GATE_NO_INPUT": "SEM-004", "DFF_NO_D": "SEM-004",
                "NET_FROM_MISSING": "SCHEMA-002", "NET_TO_MISSING": "SCHEMA-002",
                "BAD_TYPE": "SCHEMA-002", "DUP_ID": "SCHEMA-001",
                "BAD_ID": "SCHEMA-001"}.get(e["code"], "SCHEMA-002")
        errs.append(err(code, f"{e['code']}: {e['msg']}"))
    errs += check_multidriver(intent)
    errs += check_floating(intent)
    if not errs:                      # only try sim if shape is sane
        errs += check_comb_loop(intent)
    # de-dup by (code, first ref)
    seen, uniq = set(), []
    for e in errs:
        k = (e["code"], tuple(e["refs"]))
        if k not in seen:
            seen.add(k); uniq.append(e)
    return uniq


if __name__ == "__main__":
    import json
    intent = json.load(open(sys.argv[1], encoding="utf-8"))
    for e in check_all(intent):
        print(f"[{e['code']:11} {e['class']:13}] {e['message']}")
    print("clean" if not check_all(intent) else "")
