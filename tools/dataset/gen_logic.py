#!/usr/bin/env python3
"""Category 1 — a Thai request that DESCRIBES a combinational function (no equation written out)
→ the equation the agent must read from it.

Every task is made by this program from a random structure, so its meaning is known exactly:
the truth table below is computed from the structure, the Thai text is rendered from the same
structure, and the app checks the circuit the agent builds against the table (run.js).

  python3 tools/dataset/gen_logic.py --n 2000 --seed 1 > tasks.jsonl

One JSON object per line:
  id, cat, split ("train" | "eval" — eval rows use phrasings and frames train never sees),
  message (what the user types), sheet, out, inputs, formula (the reading, our operators),
  readings ([phrase, expression] per clause — the teacher's explanation), ones (rows where out = 1,
  first input = MSB), negated (the request says when out is 0).
"""
import argparse
import hashlib
import json
import random
import re
import sys

# ---- clauses: (kind, arity) → Thai phrasings and the expression they mean ------------------------
# {u} {v} are variable names. Phrasings tagged "E" are held out for the eval split.
CLAUSES = {
    "one": (1, "{u}", [
        ("{u} เป็น 1", ""), ("{u} มีค่าเป็น 1", ""), ("{u} เป็นลอจิก 1", ""), ("{u} ถูกกด", "btn"), ("{u} เปิดอยู่", "sw"),
        ("{u} ได้ค่า 1", "E"), ("{u} เป็น high", "E")]),
    "zero": (1, "~{u}", [
        ("{u} เป็น 0", ""), ("{u} มีค่าเป็น 0", ""), ("ไม่ {u}", "last"), ("{u} ไม่เป็น 1", ""), ("{u} ปิดอยู่", "sw"),
        ("{u} ไม่ถูกกด", "btn"), ("{u} ได้ค่า 0", "E"), ("{u} เป็น low", "E")]),
    "eq": (2, "({u} xnor {v})", [
        ("{u} กับ {v} เท่ากัน", ""), ("{u} มีค่าเท่ากับ {v}", ""), ("{u} และ {v} มีค่าเหมือนกัน", "noand"),
        ("{u} กับ {v} เป็นค่าเดียวกัน", ""), ("{u} กับ {v} ตรงกัน", "E")]),
    "ne": (2, "({u} ^ {v})", [
        ("{u} กับ {v} ต่างกัน", ""), ("{u} ไม่เท่ากับ {v}", ""), ("{u} กับ {v} มีค่าไม่เหมือนกัน", ""),
        ("{u} หรือ {v} ตัวใดตัวหนึ่งเป็น 1 แต่ไม่ใช่ทั้งคู่", "noor"), ("{u} กับ {v} ไม่ตรงกัน", "E")]),
    "both": (2, "({u} & {v})", [
        ("{u} และ {v} เป็น 1 ทั้งคู่", "noand"), ("ทั้ง {u} และ {v} เป็น 1", ""), ("{u} กับ {v} เป็น 1 พร้อมกัน", ""),
        ("{u} และ {v} เป็น 1 ทั้งสองตัว", "E")]),
    "either": (2, "({u} | {v})", [
        ("{u} หรือ {v} เป็น 1", "noor"), ("อย่างน้อยหนึ่งใน {u} กับ {v} เป็น 1", ""), ("{u} กับ {v} มีตัวใดตัวหนึ่งเป็น 1 ก็ได้", ""),
        ("มี 1 อย่างน้อยหนึ่งตัวใน {u} กับ {v}", "E")]),
    "none": (2, "({u} nor {v})", [
        ("{u} และ {v} เป็น 0 ทั้งคู่", "noand"), ("ทั้ง {u} และ {v} ไม่เป็น 1", ""), ("{u} กับ {v} เป็น 0 พร้อมกัน", ""),
        ("ไม่มีตัวไหนใน {u} กับ {v} เป็น 1", "E")]),
    "notboth": (2, "({u} nand {v})", [
        ("{u} และ {v} ไม่เป็น 1 พร้อมกัน", "noand"), ("{u} กับ {v} ไม่ได้เป็น 1 ทั้งคู่", ""),
        ("ไม่ใช่กรณีที่ {u} และ {v} เป็น 1 ทั้งคู่", ""), ("{u} กับ {v} ห้ามเป็น 1 พร้อมกัน", "E")]),
}
# joining clauses: AND / OR, two or three of them
AND_JOIN = [("{a} และ {b}", "{a}, {b} และ {c}", ""), ("{a} แต่ {b}", "{a} และ {b} แต่ {c}", ""),
            ("{a} โดยที่ {b}", "{a} โดยที่ {b} และ {c}", ""), ("{a} พร้อมกับ {b}", "{a}, {b} พร้อมกับ {c}", "E")]
OR_JOIN = [("{a} หรือ {b}", "{a}, {b} หรือ {c}", ""), ("{a} หรือไม่ก็ {b}", "{a}, {b} หรือไม่ก็ {c}", ""),
           ("{a} หรือเมื่อ {b}", "{a}, เมื่อ {b} หรือเมื่อ {c}", "E")]
# the whole request: {out} {ins} {cond}; "neg" frames say when the output is 0
FRAMES = [
    ("ออกแบบวงจรที่มีอินพุต {ins} และเอาต์พุต {out} โดย {out} เป็น 1 เมื่อ {cond}", "", False),
    ("อยากได้วงจรที่ {out} เป็น 1 ก็ต่อเมื่อ {cond}", "", False),
    ("ทำวงจรให้ {out} ติดเมื่อ {cond} นอกนั้นให้ดับ", "", False),
    ("{out} ต้องเป็น 1 เฉพาะตอนที่ {cond} ช่วยสร้างวงจรนี้หน่อย", "", False),
    ("สร้างวงจรลอจิก อินพุต {ins} ให้ {out} = 1 เมื่อ {cond} กรณีอื่น {out} = 0", "", False),
    ("ช่วยออกแบบวงจร: {out} เป็น 0 เมื่อ {cond} นอกจากนั้นเป็น 1", "", True),
    ("ให้ {out} ดับเมื่อ {cond} และติดในกรณีอื่นทั้งหมด", "", True),
    ("วงจรนี้ {out} จะเป็น 1 ได้ก็ต่อเมื่อ {cond} เท่านั้น", "E", False),
    ("ต้องการวงจรที่ {out} เป็น 0 เฉพาะตอน {cond}", "E", True),
]
SHEET_TAILS = [" ลงแผ่น {s}", " บนแผ่น {s}", " ใส่ในชีต {s}", " ตั้งชื่อแผ่นว่า {s}"]
# variable sets: (names, flavour) — a flavour lets "เปิดอยู่" go with switches only
VARSETS = [(["a", "b", "c", "d"], ""), (["p", "q", "r", "s"], ""), (["x1", "x2", "x3", "x4"], ""),
           (["sw0", "sw1", "sw2", "sw3"], "sw"), (["btn0", "btn1", "btn2", "btn3"], "btn"), (["A", "B", "C", "D"], "")]
# not "out" / "in": VHDL keywords — the app renames such a port, and the answer would name a port that is not there
OUTS = ["z", "y", "f", "led", "result", "alarm", "match", "ok", "valid"]


BP = {"|": 1, "nor": 1, "^": 2, "xnor": 2, "&": 3, "nand": 3}
TOK = re.compile(r"\s*(xnor|nand|nor|[A-Za-z_]\w*|[~&|^()])")


def ev(expr, env):
    """Evaluate our operator syntax with the app's precedence: | nor < ^ xnor < & nand < ~ (prefix)."""
    toks, i = [], 0
    while i < len(expr):
        m = TOK.match(expr, i)
        if not m:
            if expr[i].isspace():
                i += 1
                continue
            raise ValueError(f"bad character {expr[i]!r} in {expr!r}")
        toks.append(m.group(1))
        i = m.end()
    pos = [0]

    def unary():
        t = toks[pos[0]]
        pos[0] += 1
        if t == "~":
            return 1 - unary()
        if t == "(":
            v = expr_(0)
            if toks[pos[0]] != ")":
                raise ValueError("missing )")
            pos[0] += 1
            return v
        return int(env[t])

    def expr_(minbp):
        left = unary()
        while pos[0] < len(toks) and toks[pos[0]] in BP and BP[toks[pos[0]]] > minbp:
            op = toks[pos[0]]
            pos[0] += 1
            right = expr_(BP[op])
            left = {"|": left | right, "nor": 1 - (left | right), "^": left ^ right, "xnor": 1 - (left ^ right),
                    "&": left & right, "nand": 1 - (left & right)}[op]
        return left
    v = expr_(0)
    if pos[0] != len(toks):
        raise ValueError(f"trailing {toks[pos[0]:]} in {expr!r}")
    return bool(v)


def pick(rng, items, split, flavour="", tag=1):
    """A phrasing for this split: eval may use everything, train never sees the E ones."""
    ok = [x for x in items if (split == "eval" or x[tag] != "E") and x[tag] in ("", "E", "noor", "noand", "last", flavour)]
    return rng.choice(ok)


def condition(rng, split, names, flavour):
    """One output's condition over (some of) `names`: (Thai text, expression, [phrase, expr]…, top, used)."""
    top_or = rng.random() < 0.35
    # clauses that use each input at most once and cover all of them
    pool = names[:]
    rng.shuffle(pool)
    clauses = []
    while pool:
        two = len(pool) >= 2 and (rng.random() < 0.6 or len(clauses) >= 2)
        if len(pool) == 3 and not clauses and rng.random() < 0.5:
            two = True
        kinds = [c for c, v in CLAUSES.items() if v[0] == (2 if two else 1)]
        kind = rng.choice(kinds)
        ar, ex, ph = CLAUSES[kind]
        vs = [pool.pop() for _ in range(ar)]
        clauses.append((kind, vs))
        if len(clauses) == 3:
            break
    if len(clauses) == 1:                      # a single clause is too easy
        return None
    used = sorted({v for _, vs in clauses for v in vs}, key=names.index)
    parts = []
    for i, (kind, vs) in enumerate(clauses):
        ar, ex, ph = CLAUSES[kind]
        # no "หรือ" inside an OR of clauses, no bare "u และ v …" inside an AND of clauses (where does it
        # end?), and "ไม่ u" only last: "ไม่ a และ b …" could negate the whole rest
        cands = [p for p in ph if not (top_or and p[1] == "noor") and not (not top_or and p[1] == "noand")
                 and not (p[1] == "last" and (i != len(clauses) - 1 or top_or))]
        phrase = pick(rng, cands, split, flavour)[0]
        fill = {"u": vs[0], "v": vs[1] if ar == 2 else ""}
        parts.append((phrase.format(**fill), ex.format(**fill)))
    join = pick(rng, OR_JOIN if top_or else AND_JOIN, split, tag=2)
    tpl = join[0] if len(parts) == 2 else join[1]
    cond = tpl.format(a=parts[0][0], b=parts[1][0], c=parts[2][0] if len(parts) > 2 else "")
    rhs = (" | " if top_or else " & ").join(e for _, e in parts)
    return cond, rhs, [[p, e] for p, e in parts], "or" if top_or else "and", used


def ones_of(rhs, neg, inputs):
    ones = []
    for r in range(1 << len(inputs)):
        env = {v: (r >> (len(inputs) - 1 - i)) & 1 for i, v in enumerate(inputs)}
        if ev(rhs, env) != neg:
            ones.append(r)
    return ones


MULTI = [
    ("ออกแบบวงจรอินพุต {ins} มีเอาต์พุต {o1} กับ {o2}: {o1} เป็น 1 เมื่อ {c1} ส่วน {o2} เป็น 1 เมื่อ {c2}", ""),
    ("ทำวงจร 2 เอาต์พุตจากอินพุต {ins}\n1) {o1} เป็น 1 เมื่อ {c1}\n2) {o2} เป็น 1 เมื่อ {c2}", ""),
    ("อยากได้วงจรที่ {o1} ติดเมื่อ {c1} ส่วน {o2} ติดเมื่อ {c2}", ""),
    ("วงจรมีอินพุต {ins} ให้ {o1} = 1 เมื่อ {c1} และให้ {o2} = 1 เมื่อ {c2}", "E"),
]
MISTAKES = ["extra_field", "no_lhs", "thai_ops"]


def make(rng, split, k):
    names, flavour = rng.choice(VARSETS)
    n_in = rng.choice([2, 3, 3, 4, 4, 4])
    names = names[:n_in]
    multi = n_in >= 3 and rng.random() < 0.2
    outs = rng.sample(OUTS, 2) if multi else [rng.choice(OUTS)]
    conds = []
    for _ in outs:
        sub = names if not conds else sorted(rng.sample(names, rng.choice(range(2, n_in + 1))), key=names.index)
        c = condition(rng, split, sub, flavour)
        if not c:
            return None
        conds.append(c)
    used = sorted({v for c in conds for v in c[4]}, key=names.index)
    if multi:
        frame = pick(rng, MULTI, split)[0]
        msg = frame.format(ins=", ".join(used), o1=outs[0], o2=outs[1], c1=conds[0][0], c2=conds[1][0])
        negs = [False, False]
    else:
        frame = pick(rng, FRAMES, split)
        msg = frame[0].format(out=outs[0], ins=", ".join(used), cond=conds[0][0])
        negs = [frame[2]]
    eqs, outputs = [], []
    for o, c, neg in zip(outs, conds, negs):
        eqs.append(f"{o} = ~({c[1]})" if neg else f"{o} = {c[1]}")
        ones = ones_of(c[1], neg, used)
        if not ones or len(ones) == 1 << len(used):  # constant: not a useful task
            return None
        outputs.append({"out": o, "inputs": used, "ones": ones, "readings": c[2], "top": c[3], "negated": neg})
    sheet = None
    if rng.random() < 0.4:
        sheet = rng.choice([f"{outs[0]}_logic", f"lab_{outs[0]}", f"q{rng.randint(1, 9)}", f"ex{rng.randint(1, 20)}", "logic1", "circuit_a"])
        msg += rng.choice(SHEET_TAILS).format(s=sheet)
    t = {"id": f"logic-{split}-{k:05d}", "cat": "nl_logic", "split": split, "message": msg, "sheet": sheet,
         "use_sheet": sheet or f"{outs[0]}_logic", "inputs": used, "formula": "; ".join(eqs), "outputs": outputs}
    t.update({k2: outputs[0][k2] for k2 in ("out", "ones", "readings", "top", "negated")})   # the single-output view
    if split == "train" and rng.random() < 0.2:          # the first build call has a typical slip; the error teaches the fix
        t["mistake"] = rng.choice(MISTAKES)
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--eval", type=float, default=0.1, help="share of eval tasks")
    a = ap.parse_args()
    rng = random.Random(a.seed)
    seen, k = set(), 0
    while k < a.n:
        split = "eval" if rng.random() < a.eval else "train"
        t = make(rng, split, k)
        if not t:
            continue
        key = hashlib.sha1(t["message"].encode()).hexdigest()
        if key in seen:
            continue
        seen.add(key)
        sys.stdout.write(json.dumps(t, ensure_ascii=False) + "\n")
        k += 1


if __name__ == "__main__":
    main()
