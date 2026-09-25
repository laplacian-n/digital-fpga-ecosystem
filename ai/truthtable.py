"""
truthtable.py — DETERMINISTIC minterm/truth-table -> minimized SOP -> Intent-JSON.
When the user states the function as a set of minterms (Σm) with optional don't-cares
(Σd), we minimize with Quine-McCluskey (+ essential-PI/greedy cover) and synthesize the
gate netlist by construction — 100% correct, no LLM. Closes the truth-table long tail
(prime detector, BCD-invalid, 7-seg segment, custom minterm specs).

parse(spec) -> {n, names, outputs:{name:(minterms, dontcares)}} | None
build(parsed) -> (intent, eqs)
"""
from __future__ import annotations
import re

VARNAMES = ["a", "b", "c", "d", "e", "f", "g", "h"]     # a = MSB (bit weight n-1)


# ---- Quine-McCluskey ------------------------------------------------------
def _primes(n: int, terms: set) -> set:
    """Prime implicants over `terms` (minterms + don't-cares). Implicant = (value, dash)
    where a set bit in `dash` marks a '-' position; value bits under dash are 0."""
    current = {(t, 0) for t in terms}
    primes = set()
    while current:
        nxt, used = set(), set()
        cur = list(current)
        for i in range(len(cur)):
            for j in range(i + 1, len(cur)):
                (v1, d1), (v2, d2) = cur[i], cur[j]
                if d1 != d2:
                    continue
                diff = v1 ^ v2
                if diff and (diff & (diff - 1)) == 0:      # differ in exactly one care bit
                    nd = d1 | diff
                    nxt.add(((v1 & ~nd), nd))
                    used.add((v1, d1)); used.add((v2, d2))
        for imp in current:
            if imp not in used:
                primes.add(imp)
        current = nxt
    return primes


def _cover(primes: set, ones: set) -> set:
    """Pick prime implicants covering all ONES (essential-PI first, then greedy)."""
    covers = {p: {m for m in ones if (m & ~p[1]) == p[0]} for p in primes}
    chosen, remaining = set(), set(ones)
    while remaining:
        essential = None
        for m in remaining:
            cov = [p for p in primes if m in covers[p]]
            if len(cov) == 1:
                essential = cov[0]; break
        if essential:
            chosen.add(essential); remaining -= covers[essential]; continue
        best = max(primes, key=lambda p: len(covers[p] & remaining))
        if not (covers[best] & remaining):
            break
        chosen.add(best); remaining -= covers[best]
    return chosen


def minimize_sop(n: int, minterms, dontcares=(), names=None) -> str:
    """Minimal sum-of-products string (course notation ' * +) for the given minterms."""
    names = (names or VARNAMES)[:n]
    ones = set(int(m) for m in minterms if 0 <= int(m) < 2 ** n)
    dc = set(int(m) for m in dontcares if 0 <= int(m) < 2 ** n)
    if not ones:
        return "0"
    if len(ones) == 2 ** n:
        return "1"
    primes = _primes(n, ones | dc)
    chosen = _cover(primes, ones)

    def term(val, dash):
        lits = []
        for i in range(n):
            bit = 1 << (n - 1 - i)          # variable i (names[i]) is weight n-1-i; a = MSB
            if not (dash & bit):
                lits.append(names[i] if (val & bit) else names[i] + "'")
        return "*".join(lits) if lits else "1"

    return " + ".join(sorted(term(v, d) for (v, d) in chosen)) or "0"


# ---- spec parsing ---------------------------------------------------------
_NVAR = re.compile(r"(\d+)\s*(?:-?\s*variable|-?\s*var\b|ตัวแปร|-?\s*input|-?\s*bit|บิต)", re.I)
_MSUM = re.compile(r"(?:Σ\s*m|sum\s*of\s*minterms?|minterms?|มินเทอม)\s*[\(:]?\s*([\d]+(?:[ ,]+\d+)*)", re.I)
_DSUM = re.compile(r"(?:Σ\s*d|don'?t[\s-]*care[s]?|dontcare[s]?|\bdc\b|ไม่สนใจ)\s*[\(:]?\s*([\d ,]+)", re.I)
# NAME = Σm(...) form
_NAMED = re.compile(r"([A-Za-z_]\w*)\s*=\s*(?:Σ\s*m|sum\s*of\s*minterms?|minterms?)\s*[\(:]\s*([\d ,]*)\)?", re.I)   # empty list = always 0
# "00 -> 0001" rows: input bits, arrow/colon/equals, output bits (either side is 0/1 only)
_MAPROW = re.compile(r"(?<![\w.])([01]{1,8})\s*(?:->|=>|→|:|=)\s*([01]{1,16})(?![\w.])")
_NUMS = re.compile(r"\d+")


def _nums(s):
    return [int(x) for x in _NUMS.findall(s or "")]


def parse_mapping(spec: str):
    """Detect a row-by-row MAPPING table:  '00 -> 0001 / 01 -> 0010 / 10 -> 0100 / 11 -> 0000'
    (one row per line, or comma/semicolon separated). The left side is the input word, the
    right side the WHOLE output word — so several output bits come out of one table.
      inputs  a,b,c… with a = MSB of the left word;   outputs y{m-1}…y0 with y{m-1} = leftmost bit
      (a single output bit is just 'y'). Input words that are not listed are don't-cares.
    Returns the same shape as parse() (+ 'mapping': True) or None if it is not such a table."""
    if not spec:
        return None
    rows = _MAPROW.findall(spec)
    if len(rows) < 2:
        return None
    n, m = len(rows[0][0]), len(rows[0][1])
    if any(len(a) != n or len(b) != m for a, b in rows):
        return None                                   # ragged → not a clean table, leave it to the LLM
    seen = {}
    for a, b in rows:
        if a in seen and seen[a] != b:
            return None                               # same input, two answers → contradictory
        seen[a] = b
    if len(seen) < 2 or n > 8:
        return None
    names = ["y"] if m == 1 else ["y%d" % i for i in range(m)]
    outputs = {}
    for k, name in enumerate(names):                  # k = bit weight; names[k] = y_k
        ones = [int(a, 2) for a, b in seen.items() if b[m - 1 - k] == "1"]
        outputs[name] = (sorted(ones), [])
    dc = sorted(set(range(2 ** n)) - {int(a, 2) for a in seen})
    if dc:
        outputs = {k: (ones, dc) for k, (ones, _) in outputs.items()}
    return {"n": n, "names": VARNAMES[:n], "outputs": outputs, "mapping": True, "rows": len(seen)}


def parse(spec: str):
    """Detect a minterm/truth-table spec. Returns {n, names, outputs:{name:(ones,dc)}} or None."""
    if not spec:
        return None
    named = _NAMED.findall(spec)
    outputs = {}
    if named:
        for name, lst in named:
            outputs[name] = (_nums(lst), [])
    else:
        m = _MSUM.search(spec)
        if not m:
            return None
        outputs["f"] = (_nums(m.group(1)), [])
    # don't-cares (shared, applied to all if a single Σd present)
    dcm = _DSUM.search(spec)
    dc = _nums(dcm.group(1)) if dcm else []
    if dc:
        outputs = {k: (ones, dc) for k, (ones, _) in outputs.items()}
    # number of variables: explicit, else from the largest referenced index
    nv = _NVAR.search(spec)
    if nv:
        n = int(nv.group(1))
    else:
        mx = max((max(o) if o else 0) for o, d in outputs.values())
        mx = max([mx] + [max(d) if d else 0 for _, d in outputs.values()])
        n = max(1, (mx).bit_length())
    if n < 1 or n > 8:
        return None
    return {"n": n, "names": VARNAMES[:n], "outputs": outputs}


def build(parsed: dict):
    """parsed -> (intent, eqs) via minimize_sop + deterministic synth."""
    from synth import synth_intent_from_equations
    n, names = parsed["n"], parsed["names"]
    eqs = {name: minimize_sop(n, ones, dc, names) for name, (ones, dc) in parsed["outputs"].items()}
    intent = synth_intent_from_equations(eqs, module="tt_" + "_".join(eqs), inputs=names)
    intent["equations"] = eqs
    return intent, eqs


def verify(intent: dict, parsed: dict) -> dict:
    """Full-truth-table check the synth'd circuit matches the requested minterms exactly
    (don't-cares excluded from the check). Correct by construction, but we prove it."""
    from netlist_sim import build_graph, eval_once
    n, names = parsed["n"], parsed["names"]
    comps, fanin, _, _ = build_graph(intent)
    mism = []
    for m in range(2 ** n):
        assign = {names[i]: (m >> (n - 1 - i)) & 1 for i in range(n)}
        val = eval_once(comps, fanin, assign)
        for name, (ones, dc) in parsed["outputs"].items():
            if m in dc:
                continue
            exp = 1 if m in ones else 0
            if (val[name] & 1) != exp:
                mism.append({"in": m, "out": name, "got": val[name], "exp": exp})
    return {"ok": not mism, "checked": 2 ** n, "mismatches": mism[:8]}


if __name__ == "__main__":
    import json, sys
    p = parse(" ".join(sys.argv[1:]) or "3-variable f = Σm(2,3,5,7)")
    print("parsed:", p)
    if p:
        it, eqs = build(p)
        print("eqs:", eqs)
        print("verify:", verify(it, p)["ok"])
