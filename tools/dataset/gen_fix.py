#!/usr/bin/env python3
"""Category: a circuit on the sheet is wrong — the user says what it should do; find out and fix it.

  python3 tools/dataset/gen_fix.py --n 500 --seed 5 > fix_tasks.jsonl

Setup (run.js, before the conversation) draws the circuit from a formula with ONE realistic slip
(a negation dropped, = read as ≠, both-and-or mixed up, NAND read as AND …) on a named sheet. The
user describes the intended function in Thai. The teacher sets the spec from the request, reads
which rows disagree, and rebuilds the sheet from the right equations; run.js checks the result
against the known table.
"""
import argparse
import json
import random
import re
import sys

sys.path.insert(0, __import__("os").path.dirname(__file__))
from gen_logic import VARSETS, OUTS, condition, ones_of   # noqa: E402

FRAMES = [
    ("วงจรบนแผ่น {s} ควรให้ {out} เป็น 1 เมื่อ {cond} แต่ลองจำลองแล้วผลไม่ตรง ช่วยตรวจแล้วแก้ให้หน่อย", ""),
    ("ช่วยดูแผ่น {s} หน่อย {out} ต้องเป็น 1 เมื่อ {cond} แต่ตอนนี้บางกรณีออกผิด", ""),
    ("แผ่น {s} ที่ทำไว้ผิดตรงไหน โจทย์คือ {out} = 1 เมื่อ {cond}", ""),
    ("ตรวจวงจรในแผ่น {s} ให้หน่อยว่าตรงกับโจทย์ไหม ({out} เป็น 1 เมื่อ {cond}) ถ้าไม่ตรงก็แก้ให้ด้วย", ""),
    ("ทำแลปแล้วไฟ {out} ไม่ติดตามที่ควร: ต้องติดเมื่อ {cond} วงจรอยู่แผ่น {s} ช่วยแก้ที", "E"),
]
SLIPS = [
    ("drop_not", r"~(\w+)", lambda m: m.group(1)),                       # forgot an inverter
    ("add_not", r"(?<![~\w])(\w+)(?=\s*[&|)]|\s*$)", lambda m: "~" + m.group(1)),
    ("eq_as_ne", r" xnor ", lambda m: " ^ "),
    ("ne_as_eq", r" \^ ", lambda m: " xnor "),
    ("nand_as_and", r" nand ", lambda m: " & "),
    ("nor_as_or", r" nor ", lambda m: " | "),
    ("and_as_or", r" & ", lambda m: " | "),
    ("or_as_and", r" \| ", lambda m: " & "),
]


def slip(rng, rhs):
    opts = [(n, p, f) for n, p, f in SLIPS if re.search(p, rhs)]
    rng.shuffle(opts)
    for name, pat, f in opts:
        hits = list(re.finditer(pat, rhs))
        m = rng.choice(hits)
        wrong = rhs[:m.start()] + f(m) + rhs[m.end():]
        if wrong != rhs:
            return name, wrong
    return None, None


def make(rng, split, k):
    names, flavour = rng.choice(VARSETS)
    names = names[:rng.choice([3, 3, 4])]
    out = rng.choice(OUTS)
    c = condition(rng, split, names, flavour)
    if not c:
        return None
    cond, rhs, readings, top, used = c
    name, wrong = slip(rng, rhs)
    if not wrong:
        return None
    ones, bad = ones_of(rhs, False, used), ones_of(wrong, False, used)
    if ones == bad or not ones or len(ones) == 1 << len(used) or not bad or len(bad) == 1 << len(used):
        return None
    sheet = rng.choice([f"lab_{out}", "logic1", f"ex{rng.randint(1, 20)}", "my_circuit", f"q{rng.randint(1, 9)}"])
    frame = rng.choice([f for f in FRAMES if split == "eval" or f[1] != "E"])[0]
    msg = frame.format(s=sheet, out=out, cond=cond)
    formula, wrong_f = f"{out} = {rhs}", f"{out} = {wrong}"
    return {"id": f"fix-{split}-{k:05d}", "cat": "nl_fix", "split": split, "message": msg, "use_sheet": sheet,
            "setup": [["build_circuit", {"sheet": sheet, "formula": wrong_f, "inputs": used}]],
            "formula": formula, "wrong": wrong_f, "slip": name, "inputs": used,
            "outputs": [{"out": out, "inputs": used, "ones": ones, "readings": readings, "top": top, "negated": False}],
            "out": out, "ones": ones, "readings": readings, "top": top, "negated": False,
            "rows_wrong": len(set(ones) ^ set(bad)), "rows": 1 << len(used)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=500)
    ap.add_argument("--seed", type=int, default=5)
    ap.add_argument("--eval", type=float, default=0.1)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    seen, k = set(), 0
    while k < a.n:
        split = "eval" if rng.random() < a.eval else "train"
        t = make(rng, split, k)
        if not t or t["message"] in seen:
            continue
        seen.add(t["message"])
        sys.stdout.write(json.dumps(t, ensure_ascii=False) + "\n")
        k += 1


if __name__ == "__main__":
    main()
