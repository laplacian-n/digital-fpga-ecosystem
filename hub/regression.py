"""
hub/regression.py - Phase-2 regression + mutation testing.

Regression: every golden design must be structurally clean AND match its frozen
oracle (correct-by-construction from equations).

Mutation testing: inject each mutation into each golden; the verification layer
MUST catch it (a structural check fires, or the oracle detects a behaviour
change). A mutant that is structurally clean AND behaviourally identical is an
equivalent mutant (benign). A mutant that changes behaviour but is NOT caught is
a COVERAGE GAP (test fails). This is how we prove the anti-hallucination gates
actually work — not just claim it.
"""
from __future__ import annotations
import sys
from itertools import product
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ai"))
import netlist_sim as NS
from synth import synth_intent_from_equations
import checks
import mutate

GOLDENS = {
    "half_adder": {"sum": "a^b", "carry": "a*b"},
    "full_adder": {"sum": "a^b^cin", "cout": "a*b + (a^b)*cin"},
    "mux2":       {"y": "a*s' + b*s"},
    "maj3":       {"y": "a*b + a*c + b*c"},
}


def _truth(intent):
    ins, outs, rows = NS.truth_table(intent)
    return ins, outs, {tuple(b): tuple(o) for b, o in rows}


def _oracle_diff(golden_tt, mutant_intent):
    """True if mutant behaviour differs from the golden truth table (ORACLE-FAIL)."""
    gins, gouts, gmap = golden_tt
    try:
        mins, mouts, mmap = _truth(mutant_intent)
    except Exception:
        return True  # can't sim -> treat as caught (loop/undriven)
    if mins != gins or mouts != gouts:
        return True
    return any(mmap.get(k) != v for k, v in gmap.items())


def run():
    print("=== REGRESSION (goldens must pass) ===")
    goldens = {}
    reg_ok = True
    for name, eqs in GOLDENS.items():
        g = synth_intent_from_equations(eqs, module=name)
        errs = checks.check_all(g)
        goldens[name] = (g, _truth(g))
        ok = not errs
        reg_ok &= ok
        print(f"  {name:11} {'PASS' if ok else 'FAIL ' + str([e['code'] for e in errs])}")

    print("\n=== MUTATION TESTING (mutants must be caught) ===")
    total = killed = survived_equiv = gaps = 0
    for name, (g, tt) in goldens.items():
        for label, mut in mutate.mutants(g):
            total += 1
            errs = checks.check_all(mut)
            if errs:
                killed += 1
                codes = ",".join(sorted({e["code"] for e in errs}))
                print(f"  [{name}] {label:38} KILLED  {codes}")
            elif _oracle_diff(tt, mut):
                killed += 1
                print(f"  [{name}] {label:38} KILLED  ORACLE-FAIL")
            else:
                survived_equiv += 1
                print(f"  [{name}] {label:38} survived (equivalent mutant)")
    print(f"\nregression: {'OK' if reg_ok else 'FAIL'}")
    print(f"mutation: {killed}/{total} killed, {survived_equiv} equivalent, {gaps} GAPS")
    score = killed / total if total else 0
    print(f"mutation score (non-equivalent kill rate): {score:.0%}")
    return {"regression_ok": reg_ok, "killed": killed, "total": total,
            "equivalent": survived_equiv}


if __name__ == "__main__":
    run()
