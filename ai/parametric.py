"""
parametric.py - deterministic builders for PARAMETRIC circuits (N-bit families) that
don't fit a single fixed equation set. Emits Intent-JSON directly (topology only), so
the editor draws them and they need NO LLM. Verification uses SPOT-CHECKS (a handful of
input vectors) instead of a full 2^n truth table, which is infeasible past ~10 inputs.

Families (all correct-by-construction, no LLM):
  - N-bit ripple-carry ADDER. Per bit i (LSB=0):
      s_i   = a_i XOR b_i XOR c_i                          (two XORs)
      c_i+1 = (a_i AND b_i) OR ((a_i XOR b_i) AND c_i)     (two ANDs + OR)
    with c_0 = cin and cout = c_n.
  - N-bit SUBTRACTOR  A-B  via two's complement: feed ~b_i and force c_0 = 1
    (a VCC cell). d_i are the difference bits; bout = NOT c_n (1 => A<B).
  - N-bit ADDER/SUBTRACTOR (controlled): a `sub` line XORs each b_i and also
    drives c_0, so sub=0 adds, sub=1 subtracts. s_i sum bits, cout = c_n.
"""
from __future__ import annotations
import re
from netlist_sim import build_graph, eval_once

MAX_BITS = 16     # draw/perf sanity cap


def _cap(n: int):
    """Clamp bit-width to MAX_BITS for draw/perf; return (n, note|None)."""
    n = int(n)
    if n > MAX_BITS:
        return MAX_BITS, f"จำกัดที่ {MAX_BITS} บิต (ขอ {n}) เพื่อความเร็วในการวาด"
    return n, None


def nbit_adder(n: int, cin: bool = True) -> dict:
    n = max(1, int(n))
    comps, nets = [], []
    add = lambda **c: comps.append(c)
    for i in range(n):
        add(id=f"a{i}", type="IN", name=f"a{i}")
        add(id=f"b{i}", type="IN", name=f"b{i}")
    add(id="cin", type="IN", name="cin")
    for i in range(n):
        carry = "cin" if i == 0 else f"co_{i-1}"
        add(id=f"x1_{i}", type="XOR")           # a^b
        add(id=f"x2_{i}", type="XOR")           # (a^b)^c -> sum bit
        add(id=f"aa_{i}", type="AND")           # a&b
        add(id=f"ab_{i}", type="AND")           # (a^b)&c
        add(id=f"co_{i}", type="OR")            # carry out
        add(id=f"s{i}", type="OUT", name=f"s{i}")
        nets += [
            {"from": f"a{i}", "to": f"x1_{i}"}, {"from": f"b{i}", "to": f"x1_{i}"},
            {"from": f"x1_{i}", "to": f"x2_{i}"}, {"from": carry, "to": f"x2_{i}"},
            {"from": f"x2_{i}", "to": f"s{i}"},
            {"from": f"a{i}", "to": f"aa_{i}"}, {"from": f"b{i}", "to": f"aa_{i}"},
            {"from": f"x1_{i}", "to": f"ab_{i}"}, {"from": carry, "to": f"ab_{i}"},
            {"from": f"aa_{i}", "to": f"co_{i}"}, {"from": f"ab_{i}", "to": f"co_{i}"},
        ]
    add(id="cout", type="OUT", name="cout")
    nets.append({"from": f"co_{n-1}", "to": "cout"})
    return {"module": f"adder{n}", "components": comps, "nets": nets}


def nbit_subtractor(n: int) -> dict:
    """A - B (unsigned) by two's complement: adder chain on a_i and ~b_i with c_0 = 1.
    Outputs d0..d{n-1} (difference) and bout (borrow: 1 when A < B)."""
    n = max(1, int(n))
    comps, nets = [], []
    add = lambda **c: comps.append(c)
    for i in range(n):
        add(id=f"a{i}", type="IN", name=f"a{i}")
        add(id=f"b{i}", type="IN", name=f"b{i}")
    add(id="one", type="VCC")                    # c_0 = 1 (the +1 of two's complement)
    for i in range(n):
        carry = "one" if i == 0 else f"co_{i-1}"
        add(id=f"nb_{i}", type="NOT")            # ~b_i
        add(id=f"x1_{i}", type="XOR")            # a ^ ~b
        add(id=f"x2_{i}", type="XOR")            # (a^~b) ^ c  -> diff bit
        add(id=f"aa_{i}", type="AND")            # a & ~b
        add(id=f"ab_{i}", type="AND")            # (a^~b) & c
        add(id=f"co_{i}", type="OR")             # carry out
        add(id=f"d{i}", type="OUT", name=f"d{i}")
        nets += [
            {"from": f"b{i}", "to": f"nb_{i}"},
            {"from": f"a{i}", "to": f"x1_{i}"}, {"from": f"nb_{i}", "to": f"x1_{i}"},
            {"from": f"x1_{i}", "to": f"x2_{i}"}, {"from": carry, "to": f"x2_{i}"},
            {"from": f"x2_{i}", "to": f"d{i}"},
            {"from": f"a{i}", "to": f"aa_{i}"}, {"from": f"nb_{i}", "to": f"aa_{i}"},
            {"from": f"x1_{i}", "to": f"ab_{i}"}, {"from": carry, "to": f"ab_{i}"},
            {"from": f"aa_{i}", "to": f"co_{i}"}, {"from": f"ab_{i}", "to": f"co_{i}"},
        ]
    add(id="bnot", type="NOT")                   # borrow = NOT carry_n
    add(id="bout", type="OUT", name="bout")
    nets += [{"from": f"co_{n-1}", "to": "bnot"}, {"from": "bnot", "to": "bout"}]
    return {"module": f"sub{n}", "components": comps, "nets": nets}


def nbit_addsub(n: int) -> dict:
    """Controlled adder/subtractor: a `sub` line XORs each b_i and drives c_0, so
    sub=0 => A+B, sub=1 => A-B (two's complement). Outputs s0..s{n-1}, cout."""
    n = max(1, int(n))
    comps, nets = [], []
    add = lambda **c: comps.append(c)
    for i in range(n):
        add(id=f"a{i}", type="IN", name=f"a{i}")
        add(id=f"b{i}", type="IN", name=f"b{i}")
    add(id="sub", type="IN", name="sub")         # 0=add, 1=subtract; also feeds c_0
    for i in range(n):
        carry = "sub" if i == 0 else f"co_{i-1}"
        add(id=f"xb_{i}", type="XOR")            # b ^ sub
        add(id=f"x1_{i}", type="XOR")            # a ^ (b^sub)
        add(id=f"x2_{i}", type="XOR")            # sum bit
        add(id=f"aa_{i}", type="AND")
        add(id=f"ab_{i}", type="AND")
        add(id=f"co_{i}", type="OR")
        add(id=f"s{i}", type="OUT", name=f"s{i}")
        nets += [
            {"from": f"b{i}", "to": f"xb_{i}"}, {"from": "sub", "to": f"xb_{i}"},
            {"from": f"a{i}", "to": f"x1_{i}"}, {"from": f"xb_{i}", "to": f"x1_{i}"},
            {"from": f"x1_{i}", "to": f"x2_{i}"}, {"from": carry, "to": f"x2_{i}"},
            {"from": f"x2_{i}", "to": f"s{i}"},
            {"from": f"a{i}", "to": f"aa_{i}"}, {"from": f"xb_{i}", "to": f"aa_{i}"},
            {"from": f"x1_{i}", "to": f"ab_{i}"}, {"from": carry, "to": f"ab_{i}"},
            {"from": f"aa_{i}", "to": f"co_{i}"}, {"from": f"ab_{i}", "to": f"co_{i}"},
        ]
    add(id="cout", type="OUT", name="cout")
    nets.append({"from": f"co_{n-1}", "to": "cout"})
    return {"module": f"addsub{n}", "components": comps, "nets": nets}


def _attach(intent, eqs):
    """Tag an equation-built intent so gen_vhdl emits the readable 1-line-per-output form."""
    intent["equations"] = eqs
    return intent


def nbit_comparator(n: int) -> dict:
    """Unsigned N-bit magnitude comparator. inputs a{n-1..0}, b{...}; outputs eq,gt,lt.
    eq = AND of per-bit XNOR; gt/lt = standard MSB-first cascade (correct by construction)."""
    from synth import synth_intent_from_equations
    n = max(1, int(n))
    eq = "*".join(f"(a{i} xnor b{i})" for i in range(n))
    def cascade(hi_expr):
        terms = []
        for i in range(n - 1, -1, -1):
            higher = "*".join(f"(a{j} xnor b{j})" for j in range(n - 1, i, -1))
            t = hi_expr(i)
            terms.append(f"({higher})*{t}" if higher else t)
        return " + ".join(terms)
    gt = cascade(lambda i: f"(a{i}*b{i}')")     # a>b: first differing bit has a=1,b=0
    lt = cascade(lambda i: f"(a{i}'*b{i})")
    eqs = {"eq": eq, "gt": gt, "lt": lt}
    ins = [f"a{i}" for i in range(n)] + [f"b{i}" for i in range(n)]
    return _attach(synth_intent_from_equations(eqs, module=f"cmp{n}", inputs=ins), eqs)


def nbit_mux(N: int) -> dict:
    """N-to-1 multiplexer (N a power of 2). inputs d0..d{N-1} + select s{k-1..0} (s0=LSB);
    output y = the selected data input."""
    from synth import synth_intent_from_equations
    N = max(2, int(N))
    k = (N - 1).bit_length()
    terms = []
    for i in range(N):
        m = "*".join((f"s{j}" if (i >> j) & 1 else f"s{j}'") for j in range(k))
        terms.append(f"d{i}*({m})")
    eqs = {"y": " + ".join(terms)}
    ins = [f"d{i}" for i in range(N)] + [f"s{j}" for j in range(k)]
    return _attach(synth_intent_from_equations(eqs, module=f"mux{N}", inputs=ins), eqs)


def decoder(k: int) -> dict:
    """k-to-2^k line decoder. inputs a{k-1..0} (a0=LSB); outputs y0..y{2^k-1}, y_i = minterm i."""
    from synth import synth_intent_from_equations
    k = max(1, int(k))
    eqs = {}
    for i in range(2 ** k):
        eqs[f"y{i}"] = "*".join((f"a{j}" if (i >> j) & 1 else f"a{j}'") for j in range(k))
    ins = [f"a{j}" for j in range(k)]
    return _attach(synth_intent_from_equations(eqs, module=f"dec{k}to{2**k}", inputs=ins), eqs)


def priority_encoder(N: int) -> dict:
    """N-input priority encoder (r{N-1} highest). outputs v (any active) + index bits
    y{k-1..0} = binary index of the highest-priority active input. Correct by construction:
    y_m = OR over i (bit m set) of [ r_i AND (no higher input active) ]."""
    from synth import synth_intent_from_equations
    N = max(2, int(N))
    k = (N - 1).bit_length()
    eqs = {"v": "+".join(f"r{i}" for i in range(N))}
    for m in range(k):
        terms = []
        for i in range(N):
            if (i >> m) & 1:
                higher = "*".join(f"r{j}'" for j in range(i + 1, N))
                terms.append(f"(r{i}*{higher})" if higher else f"r{i}")
        eqs[f"y{m}"] = " + ".join(terms) if terms else "0"
    ins = [f"r{i}" for i in range(N)]
    return _attach(synth_intent_from_equations(eqs, module=f"prienc{N}", inputs=ins), eqs)


def nbit_multiplier(n: int) -> dict:
    """Unsigned N x N array multiplier -> 2N-bit product p0..p{2n-1}. Structural (partial
    products + ripple of full/half adders), correct by construction."""
    n = max(1, int(n))
    comps, nets, seen = [], [], set()
    def add(cid, typ, **ex):
        if cid not in seen:
            comps.append({"id": cid, "type": typ, **ex}); seen.add(cid)
        return cid
    for i in range(n):
        add(f"a{i}", "IN", name=f"a{i}"); add(f"b{i}", "IN", name=f"b{i}")
    add("gnd", "GND")
    ctr = [0]
    def g(t, *srcs):
        ctr[0] += 1; gid = f"_m{ctr[0]}"; add(gid, t)
        for s in srcs:
            nets.append({"from": s, "to": gid})
        return gid
    def ha(x, y):
        return g("XOR", x, y), g("AND", x, y)
    def fa(x, y, c):
        axb = g("XOR", x, y); s = g("XOR", axb, c)
        return s, g("OR", g("AND", x, y), g("AND", axb, c))
    pp = {(i, j): g("AND", f"a{i}", f"b{j}") for i in range(n) for j in range(n)}
    acc = [None] * (2 * n)
    for j in range(n):
        acc[j] = pp[(0, j)]
    for i in range(1, n):                         # add row i (weight i..i+n-1)
        carry = "gnd"
        for j in range(n):
            x, y = acc[i + j], pp[(i, j)]
            if x is None:
                s, carry = ha(y, carry)
            else:
                s, carry = fa(x, y, carry)
            acc[i + j] = s
        acc[i + n] = carry
    for kk in range(2 * n):
        drv = acc[kk] if acc[kk] is not None else "gnd"
        add(f"p{kk}", "OUT", name=f"p{kk}"); nets.append({"from": drv, "to": f"p{kk}"})
    return {"module": f"mult{n}", "components": comps, "nets": nets}


def _read(val, prefix, n):
    return sum((val[f"{prefix}{i}"] & 1) << i for i in range(n))


def spot_check(intent: dict, n: int, kind: str) -> dict:
    """Drive a handful of vectors and compare to the arithmetic truth for `kind`
    (adder|sub|addsub). Returns {ok, checked, rows, mismatches, cols}."""
    if kind == "adder":
        return spot_check_adder(intent, n)
    comps, fanin, _, _ = build_graph(intent)
    mask = (1 << n) - 1
    pairs = [(0, 0), (mask, 0), (0, mask), (mask, mask), (0xAA & mask, 0x55 & mask),
             (mask // 3, mask // 5), (1, 1), (mask, 1)]
    rows, mism = [], []
    if kind == "sub":
        cols = ["a", "b", "diff", "exp", "borrow"]
        for A, B in pairs:
            assign = {}
            for i in range(n):
                assign[f"a{i}"] = (A >> i) & 1
                assign[f"b{i}"] = (B >> i) & 1
            val = eval_once(comps, fanin, assign)
            got = _read(val, "d", n)
            exp = (A - B) & mask
            row = {"a": A, "b": B, "diff": got, "exp": exp, "borrow": val["bout"] & 1}
            rows.append(row)
            if got != exp or row["borrow"] != int(A < B):
                mism.append(row)
        return {"ok": not mism, "checked": len(rows), "rows": rows, "mismatches": mism, "cols": cols}
    if kind == "addsub":
        cols = ["a", "b", "sub", "out", "exp"]
        for A, B in pairs:
            for sub in (0, 1):
                assign = {"sub": sub}
                for i in range(n):
                    assign[f"a{i}"] = (A >> i) & 1
                    assign[f"b{i}"] = (B >> i) & 1
                val = eval_once(comps, fanin, assign)
                got = _read(val, "s", n) | (val["cout"] << n)
                exp = (A + B) if sub == 0 else (A + ((~B) & mask) + 1)
                row = {"a": A, "b": B, "sub": sub, "out": got, "exp": exp}
                rows.append(row)
                if got != exp:
                    mism.append(row)
        return {"ok": not mism, "checked": len(rows), "rows": rows, "mismatches": mism, "cols": cols}
    if kind == "comparator":
        cols = ["a", "b", "eq", "gt", "lt"]
        for A, B in pairs:
            assign = {}
            for i in range(n):
                assign[f"a{i}"] = (A >> i) & 1; assign[f"b{i}"] = (B >> i) & 1
            val = eval_once(comps, fanin, assign)
            got = (val["eq"], val["gt"], val["lt"])
            exp = (int(A == B), int(A > B), int(A < B))
            row = {"a": A, "b": B, "eq": got[0], "gt": got[1], "lt": got[2]}
            rows.append(row)
            if got != exp:
                mism.append({**row, "exp": exp})
        return {"ok": not mism, "checked": len(rows), "rows": rows, "mismatches": mism, "cols": cols}
    if kind == "multiplier":
        cols = ["a", "b", "prod", "exp"]
        for A, B in pairs:
            assign = {}
            for i in range(n):
                assign[f"a{i}"] = (A >> i) & 1; assign[f"b{i}"] = (B >> i) & 1
            val = eval_once(comps, fanin, assign)
            got = _read(val, "p", 2 * n)
            exp = (A & mask) * (B & mask)
            row = {"a": A, "b": B, "prod": got, "exp": exp}
            rows.append(row)
            if got != exp:
                mism.append(row)
        return {"ok": not mism, "checked": len(rows), "rows": rows, "mismatches": mism, "cols": cols}
    return {"ok": True, "checked": 0, "rows": [], "mismatches": [], "cols": []}


def spot_check_select(intent: dict, kind: str, param: int) -> dict:
    """Full-enumeration check for mux (N) and decoder (k) — their input space is small."""
    from itertools import product as _prod
    comps, fanin, ins, _ = build_graph(intent)
    if kind == "decoder":
        k = param; rows = []; mism = []
        for bits in _prod((0, 1), repeat=k):
            assign = {f"a{j}": bits[j] for j in range(k)}
            val = eval_once(comps, fanin, assign)
            v = sum(bits[j] << j for j in range(k))
            for i in range(2 ** k):
                if (val[f"y{i}"] & 1) != int(i == v):
                    mism.append({"in": v, "y": i})
            rows.append(v)
        return {"ok": not mism, "checked": 2 ** k, "rows": [], "mismatches": mism, "cols": []}
    if kind == "priority":
        N = param; k = (N - 1).bit_length(); mism = []
        for bits in _prod((0, 1), repeat=N):
            assign = {f"r{i}": bits[i] for i in range(N)}
            val = eval_once(comps, fanin, assign)
            hi = max((i for i in range(N) if bits[i]), default=None)
            exp_v = int(hi is not None)
            exp_idx = hi if hi is not None else 0
            if (val["v"] & 1) != exp_v:
                mism.append({"in": bits, "v": val["v"]})
            elif hi is not None:
                got_idx = sum((val[f"y{m}"] & 1) << m for m in range(k))
                if got_idx != exp_idx:
                    mism.append({"in": bits, "idx": got_idx, "exp": exp_idx})
        return {"ok": not mism, "checked": 2 ** N, "rows": [], "mismatches": mism, "cols": []}
    if kind == "mux":
        N = param; k = (N - 1).bit_length(); mism = []; checked = 0
        # test each select with two data patterns (all-distinct-ish): d_i = i&1, then d_i = (i+1)&1
        for pat in (lambda i: i & 1, lambda i: (i + 1) & 1):
            for sel in range(N):
                assign = {f"d{i}": pat(i) for i in range(N)}
                for j in range(k):
                    assign[f"s{j}"] = (sel >> j) & 1
                val = eval_once(comps, fanin, assign)
                checked += 1
                if (val["y"] & 1) != pat(sel):
                    mism.append({"sel": sel, "got": val["y"], "exp": pat(sel)})
        return {"ok": not mism, "checked": checked, "rows": [], "mismatches": mism, "cols": []}
    return {"ok": True, "checked": 0, "rows": [], "mismatches": [], "cols": []}


def spot_check_adder(intent: dict, n: int, samples=None) -> dict:
    """Drive a few (A,B,Cin) vectors, read s0..s{n-1}+cout, compare to A+B+Cin."""
    comps, fanin, _, _ = build_graph(intent)
    mask = (1 << n) - 1
    if samples is None:
        samples = [(0, 0, 0), (mask, 0, 0), (mask, 1, 0), (mask, mask, 1),
                   (0xAA & mask, 0x55 & mask, 0), ((mask // 3), (mask // 5), 1),
                   (1, 1, 0), (mask, mask, 0)]
    rows, mism = [], []
    for A, B, Cin in samples:
        assign = {}
        for i in range(n):
            assign[f"a{i}"] = (A >> i) & 1
            assign[f"b{i}"] = (B >> i) & 1
        assign["cin"] = Cin & 1
        val = eval_once(comps, fanin, assign)
        got = sum((val[f"s{i}"] & 1) << i for i in range(n)) | (val["cout"] << n)
        exp = (A & mask) + (B & mask) + (Cin & 1)
        rows.append({"a": A & mask, "b": B & mask, "cin": Cin & 1, "sum": got, "exp": exp})
        if got != exp:
            mism.append(rows[-1])
    return {"ok": not mism, "checked": len(rows), "rows": rows, "mismatches": mism,
            "cols": ["a", "b", "cin", "sum", "exp"]}


# recognize N-bit arithmetic families. Check ADD/SUB first (it contains both words),
# then plain subtractor, then adder. Thai: บวก=add, ลบ=subtract, บวกลบ=add/sub.
_ADDSUB = re.compile(r"(add.?sub|adder.?subtractor|บวกลบ|บวก/ลบ|บวก-ลบ|add and subtract)", re.I)
_SUB = re.compile(r"(subtract|subtractor|subtraction|ลบ|minus|difference|borrow)", re.I)
_ADDER = re.compile(r"(adder|บวก|added|addition|ripple)", re.I)
_CMP = re.compile(r"(comparator|compare|magnitude|เปรียบเทียบ|เทียบค่า|เทียบขนาด)", re.I)
_MUX = re.compile(r"(mux|multiplexer|มัลติเพล็กเซอร์|มัลติเพลกเซอร์|เลือกข้อมูล)", re.I)
_DEC = re.compile(r"(decoder|ถอดรหัส|ดีโคดเดอร์|ดีโค้ดเดอร์)", re.I)
_MUL = re.compile(r"(multiplier|multiply|ตัวคูณ|วงจรคูณ|คูณเลข)", re.I)
_ENC = re.compile(r"(priority encoder|priority-encoder|priority|encoder|เข้ารหัส|ตัวเข้ารหัส)", re.I)
_BITS = re.compile(r"(\d+)\s*(?:-?\s*bit|บิต|b\b)", re.I)
_TOFROM = re.compile(r"(\d+)\s*(?:-?\s*to\s*-?|x|:|ต่อ|เป็น)\s*(\d+)", re.I)


def _bits(message: str):
    mb = _BITS.search(message) or re.search(r"\b(\d{1,2})\b", message)
    n = int(mb.group(1)) if mb else None
    return n if (n and n >= 1) else None


def parse_request(message: str):
    """-> (kind, param, intent, note) or None. Deterministic parametric circuits only.
    `param` = bit-width (arith/comparator/multiplier), N (mux), or k (decoder)."""
    m = message.lower()
    tf = _TOFROM.search(message)
    # --- selection/structural families (distinct keywords; check before arith) ---
    if _MUX.search(m):
        N = int(tf.group(1)) if tf else _bits(message)      # "4-to-1" -> 4 data inputs
        if N and N >= 2:
            N = min(N, 16)
            return ("mux", N, nbit_mux(N), None if N <= 16 else "จำกัด 16-to-1")
    if _DEC.search(m):
        k = int(tf.group(1)) if tf else _bits(message)      # "3-to-8" -> k=3 inputs
        if k and k >= 1:
            k = min(k, 5)                                    # 2^5 = 32 outputs cap
            return ("decoder", k, decoder(k), None if k <= 5 else "จำกัด 5-to-32")
    if _ENC.search(m):
        N = int(tf.group(1)) if tf else _bits(message)       # "8-to-3 encoder" -> N=8
        if N and N >= 2:
            N = min(N, 16)
            return ("priority", N, priority_encoder(N), None)
    if _MUL.search(m):
        n = _bits(message)
        if n:
            n, note = _cap(min(n, 8))                        # n^2 gates -> cap 8
            return ("multiplier", n, nbit_multiplier(n), note)
    if _CMP.search(m):
        n = _bits(message)
        if n:
            n, note = _cap(min(n, 8))
            return ("comparator", n, nbit_comparator(n), note)
    # --- arithmetic families: ADD/SUB first, then sub, then adder ---
    if _ADDSUB.search(m):
        n = _bits(message)
        if n:
            n, note = _cap(n)
            return ("addsub", n, nbit_addsub(n), note)
    if _SUB.search(m):
        n = _bits(message)
        if n:
            n, note = _cap(n)
            return ("sub", n, nbit_subtractor(n), note)
    if _ADDER.search(m):
        n = _bits(message)
        if n:
            n, note = _cap(n)
            return ("adder", n, nbit_adder(n), note)
    return None


if __name__ == "__main__":
    import json, sys
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    it = nbit_adder(n)
    print("comps", len(it["components"]), "nets", len(it["nets"]))
    print(json.dumps(spot_check_adder(it, n)["ok"]))
