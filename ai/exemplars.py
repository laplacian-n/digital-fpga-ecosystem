"""
exemplars.py — a small library of VERIFIED worked examples generated from the
DETERMINISTIC builders (textbook-correct by construction, exhaustively checked —
NOT model guesses). Used to few-shot the LLM on the long tail: `retrieve_exemplar`
falls back here when the curated lab corpus (rag/labs/) has no hit.

This does NOT touch the curated golden corpus (that stays human-approved, one design
at a time). These are reference circuits the engine itself can regenerate anytime.
"""
from __future__ import annotations

import parametric as P
from synth import synth_intent_from_equations


def _eq(eqs, module):
    it = synth_intent_from_equations(eqs, module=module)
    it["equations"] = eqs
    return it


# (title, keywords, intent_json-with-equations)
def _build():
    return [
        ("full adder", ["adder", "full adder", "sum", "carry", "cout", "cin"],
         _eq({"sum": "a^b^cin", "cout": "a*b+(a^b)*cin"}, "full_adder")),
        ("half adder", ["half adder", "sum", "carry"],
         _eq({"sum": "a^b", "carry": "a*b"}, "half_adder")),
        ("2-bit equality/magnitude comparator", ["comparator", "compare", "equal", "greater", "less", "magnitude", "eq", "gt", "lt"],
         P.nbit_comparator(2)),
        ("4-to-1 multiplexer", ["mux", "multiplexer", "select", "selector"],
         P.nbit_mux(4)),
        ("2-to-4 decoder", ["decoder", "minterm", "demultiplexer", "demux"],
         P.decoder(2)),
        ("4-input priority encoder", ["priority", "encoder", "index", "highest"],
         P.priority_encoder(4)),
        ("2-bit multiplier", ["multiplier", "multiply", "product"],
         P.nbit_multiplier(2)),
        ("2-to-1 mux (boolean form)", ["mux", "2 to 1", "select"],
         _eq({"y": "(d0*s')+(d1*s)"}, "mux2")),
    ]


_EX = None


def _lib():
    global _EX
    if _EX is None:
        try:
            _EX = _build()
        except Exception:
            _EX = []
    return _EX


def find(query: str):
    """Best keyword-overlap exemplar for a query, or None. Returns {question, intent_json}.
    Single-word keywords match whole TOKENS (so short ones like 'lt' don't hit inside
    'mu-lt-iplexer'); multi-word keywords match as a phrase substring."""
    import re
    q = (query or "").lower()
    toks = set(re.findall(r"[a-z0-9]+", q))
    best, best_score = None, 0
    for title, kws, intent in _lib():
        score = 0
        for k in kws:
            if (" " in k or "-" in k):
                score += 1 if k in q else 0
            else:
                score += 1 if k in toks else 0
        if score > best_score:
            best_score, best = score, (title, intent)
    if best and best_score > 0:
        return {"question": best[0], "intent_json": best[1]}
    return None


if __name__ == "__main__":
    import json
    for t, kws, it in _lib():
        print(f"{t:40} comps={len(it['components'])} eqs={it.get('equations') and list(it['equations'])}")
