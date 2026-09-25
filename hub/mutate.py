"""
hub/mutate.py - mutation operators for mutation testing. Each returns (label,
mutated_intent) or None if it can't apply. A mutation that CHANGES behavior or
structure must be caught by the checks/oracle (else it's a coverage gap).
"""
from __future__ import annotations
import copy

_ALT = {"AND": "OR", "OR": "AND", "XOR": "XNOR", "XNOR": "XOR",
        "NAND": "AND", "NOR": "OR", "NOT": "BUF", "BUF": "NOT"}


def flip_gate(intent):
    for c in intent["components"]:
        if c["type"] in _ALT:
            m = copy.deepcopy(intent)
            for cc in m["components"]:
                if cc["id"] == c["id"]:
                    cc["type"] = _ALT[c["type"]]
                    return (f"flip_gate {c['id']} {c['type']}->{cc['type']}", m)
    return None


def swap_connection(intent):
    drivers = [c["id"] for c in intent["components"]
               if c["type"] not in ("OUT",)]
    for i, n in enumerate(intent.get("nets", [])):
        alt = [d for d in drivers if d != n["from"] and d != n["to"]]
        if alt:
            m = copy.deepcopy(intent)
            m["nets"][i]["from"] = alt[0]
            return (f"swap_conn net[{i}] from {n['from']}->{alt[0]}", m)
    return None


def multi_driver(intent):
    # add a 2nd driver into an existing sink pin -> SEM-005
    drivers = [c["id"] for c in intent["components"] if c["type"] not in ("OUT",)]
    for n in intent.get("nets", []):
        alt = [d for d in drivers if d != n["from"]]
        if alt:
            m = copy.deepcopy(intent)
            m["nets"].append({"from": alt[0], "to": n["to"]})
            return (f"multi_driver +{alt[0]}->{n['to']}", m)
    return None


def drop_net(intent):
    if intent.get("nets"):
        m = copy.deepcopy(intent)
        dropped = m["nets"].pop()
        return (f"drop_net {dropped['from']}->{dropped['to']}", m)
    return None


def make_loop(intent):
    # feed a gate's own output back to one of its inputs -> comb loop (SEM-006)
    gates = [c["id"] for c in intent["components"]
             if c["type"] in ("AND", "OR", "XOR", "NAND", "NOR", "XNOR")]
    if gates:
        g = gates[-1]
        m = copy.deepcopy(intent)
        m["nets"].append({"from": g, "to": g})
        return (f"make_loop {g}->{g}", m)
    return None


ALL = [flip_gate, swap_connection, multi_driver, drop_net, make_loop]


def mutants(intent):
    out = []
    for op in ALL:
        r = op(intent)
        if r:
            out.append(r)
    return out
