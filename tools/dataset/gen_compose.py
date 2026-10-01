#!/usr/bin/env python3
"""Category: build a bigger block out of library parts — ONE build_hierarchy call with every wire.

  python3 tools/dataset/gen_compose.py --n 300 --seed 6 > compose_tasks.jsonl

Ripple adders from full adders, a 2N-bit adder from two N-bit adders, mux 4:1 from three 2:1, mux 8:1
from two 4:1 + one 2:1. The plan (blocks, top ports, every connection) is written by code; the app
reads the target (the words after "เป็น") as a library part and checks the result against that part's
reference model; run.js compares the sheet with the function once more (compare_sheets).
Top ports are named like the library part's (a, b, cin → s, cout; d, s → y) so the check can match them.
"""
import argparse
import json
import random
import sys

NUM = {2: "สอง", 3: "สาม", 4: "สี่", 8: "แปด"}


def n_txt(rng, n):
    return rng.choice([str(n), NUM.get(n, str(n))])


def ripple(rng, split):
    n = rng.choice([2, 3, 4])
    msg = rng.choice([
        "ต่อ full adder {k} ตัวเป็นตัวบวก {n} บิต",
        "ใช้ full adder {k} ตัวต่อกันเป็นวงจรบวกเลข {n} บิต (มี carry in)",
        "ประกอบ full adder {k} ตัวแบบ ripple carry ให้เป็นตัวบวก {n} บิต",
        "อยากเห็นโครงสร้างตัวบวก: เอา full adder {k} ตัวมาต่อเป็นตัวบวก {n} บิต",
    ]).format(k=n_txt(rng, n), n=n)
    blocks = [{"name": f"fa{i}", "part": "full_adder"} for i in range(n)]
    conn = [["cin", "fa0.cin"], [f"fa{n - 1}.cout", "cout"]]
    for i in range(n):
        conn += [[f"a[{i}]", f"fa{i}.a"], [f"b[{i}]", f"fa{i}.b"], [f"fa{i}.sum", f"s[{i}]"]]
        if i:
            conn.append([f"fa{i - 1}.cout", f"fa{i}.cin"])
    plan = {"inputs": [f"a[{n - 1}:0]", f"b[{n - 1}:0]", "cin"], "outputs": [f"s[{n - 1}:0]", "cout"], "blocks": blocks, "connect": conn}
    why = [f"ตัวบวก {n} บิตแบบ ripple carry = full adder {n} ตัวเรียงกัน: บิต i บวก a[i] + b[i] + carry จากบิตก่อนหน้า",
           "fa0 รับ cin จากภายนอก, fa(i-1).cout → fa(i).cin, ผลรวม fa(i).sum → s[i], carry ตัวสุดท้าย → cout",
           f"ตั้งชื่อขาบนสุดเหมือนตัวบวกในคลัง (a, b, cin → s, cout) แล้วต่อทั้งหมดใน build_hierarchy ครั้งเดียว"]
    return msg, f"add{n}", plan, why, "{cout,s} = a + b + cin", n


def wide_adder(rng, split):
    n = rng.choice([2, 3, 4])
    w = 2 * n
    msg = rng.choice(["เอาตัวบวก {n} บิต {k} ตัวมาต่อเป็นตัวบวก {w} บิต", "ใช้ตัวบวก {n} บิต {k} ตัวต่อกันเป็นตัวบวก {w} บิต",
                      "ต่อ adder {n} บิต {k} ตัวให้เป็น adder {w} บิต"]).format(n=n, k=n_txt(rng, 2), w=w)
    blocks = [{"name": "lo", "part": "adder", "params": {"n": n}}, {"name": "hi", "part": "adder", "params": {"n": n}}]
    conn = [[f"a[{n - 1}:0]", "lo.a"], [f"b[{n - 1}:0]", "lo.b"], ["cin", "lo.cin"], ["lo.s", f"s[{n - 1}:0]"],
            [f"a[{w - 1}:{n}]", "hi.a"], [f"b[{w - 1}:{n}]", "hi.b"], ["lo.cout", "hi.cin"], ["hi.s", f"s[{w - 1}:{n}]"], ["hi.cout", "cout"]]
    plan = {"inputs": [f"a[{w - 1}:0]", f"b[{w - 1}:0]", "cin"], "outputs": [f"s[{w - 1}:0]", "cout"], "blocks": blocks, "connect": conn}
    why = [f"ตัวบวก {w} บิต = ตัวบวก {n} บิต 2 ตัว: lo บวกบิต {n - 1}..0, hi บวกบิต {w - 1}..{n}",
           "carry ออกของ lo → carry เข้าของ hi, cin ภายนอก → lo.cin, hi.cout → cout",
           "ต่อบัสเป็นช่วง (a[{0}:0] → lo.a, a[{1}:{2}] → hi.a) ทั้งหมดใน build_hierarchy ครั้งเดียว".format(n - 1, w - 1, n)]
    return msg, f"add{w}", plan, why, "{cout,s} = a + b + cin", w


def mux_formula(k, bits):
    terms = []
    for v in range(k):
        lits = [("" if (v >> j) & 1 else "~") + f"s[{j}]" for j in reversed(range(bits))]
        terms.append("&".join(lits + [f"d[{v}]"]))
    return "y = " + " | ".join(terms)


def mux4(rng, split):
    msg = rng.choice(["ต่อ mux 2:1 {k} ตัวเป็น mux 4:1", "ใช้ mux 2 ต่อ 1 จำนวน {k} ตัวสร้าง mux 4:1", "ประกอบ mux 4:1 จาก mux 2:1 {k} ตัว"]).format(k=n_txt(rng, 3))
    blocks = [{"name": f"m{i}", "part": "mux", "params": {"n": 2}} for i in range(3)]
    conn = [["d[1:0]", "m0.d"], ["s[0]", "m0.s"], ["d[3:2]", "m1.d"], ["s[0]", "m1.s"],
            ["m0.y", "m2.d[0]"], ["m1.y", "m2.d[1]"], ["s[1]", "m2.s"], ["m2.y", "y"]]
    plan = {"inputs": ["d[3:0]", "s[1:0]"], "outputs": ["y"], "blocks": blocks, "connect": conn}
    why = ["mux 4:1 = 2 ชั้น: ชั้นแรก m0 เลือก d0/d1, m1 เลือก d2/d3 ด้วย s[0] เหมือนกัน",
           "ชั้นที่สอง m2 เลือกระหว่างผลของ m0 กับ m1 ด้วย s[1] → y", "ชื่อขาเหมือน mux ในคลัง (d, s → y)"]
    return msg, "mux4", plan, why, mux_formula(4, 2), 4


def mux8(rng, split):
    msg = rng.choice(["ต่อ mux 4:1 {k} ตัวกับ mux 2:1 อีกตัวเป็น mux 8:1", "ใช้ mux 4:1 {k} ตัวและ mux 2:1 หนึ่งตัวทำ mux 8:1"]).format(k=n_txt(rng, 2))
    blocks = [{"name": "m0", "part": "mux", "params": {"n": 4}}, {"name": "m1", "part": "mux", "params": {"n": 4}},
              {"name": "m2", "part": "mux", "params": {"n": 2}}]
    conn = [["d[3:0]", "m0.d"], ["s[1:0]", "m0.s"], ["d[7:4]", "m1.d"], ["s[1:0]", "m1.s"],
            ["m0.y", "m2.d[0]"], ["m1.y", "m2.d[1]"], ["s[2]", "m2.s"], ["m2.y", "y"]]
    plan = {"inputs": ["d[7:0]", "s[2:0]"], "outputs": ["y"], "blocks": blocks, "connect": conn}
    why = ["mux 8:1: m0 เลือกใน d3..d0, m1 เลือกใน d7..d4 ด้วย s[1:0] เดียวกัน",
           "m2 (2:1) เลือกระหว่าง m0.y กับ m1.y ด้วย s[2] → y", "ชื่อขาเหมือน mux ในคลัง (d, s → y)"]
    return msg, "mux8", plan, why, mux_formula(8, 3), 8


KINDS = [(ripple, 4), (wide_adder, 3), (mux4, 2), (mux8, 1)]


def make(rng, split, k):
    gen = rng.choice([g for g, w in KINDS for _ in range(w)])
    msg, sheet, plan, why, formula, size = gen(rng, split)
    if rng.random() < 0.4:
        sheet = rng.choice([sheet + "_top", "top2", f"lab{rng.randint(2, 9)}", "my_" + sheet])
        msg += rng.choice([" ลงแผ่น {s}", " บนแผ่น {s}", " ตั้งชื่อแผ่น {s}"]).format(s=sheet)
    plan = dict({"sheet": sheet}, **plan)
    t = {"id": f"compose-{split}-{k:05d}", "cat": "nl_compose", "split": split, "message": msg, "use_sheet": sheet,
         "plan": plan, "why": why, "check_formula": formula, "kind": gen.__name__}
    # the slip the 4B baseline made: a block pin by the wrong name (full adder s for sum, adder sum for s) —
    # the app's error lists the real pins; the next turn uses them
    if split == "train" and gen.__name__ in ("ripple", "wide_adder") and rng.random() < 0.3:
        t["mistake"] = "pin_name"
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--seed", type=int, default=6)
    ap.add_argument("--eval", type=float, default=0.1)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    seen, k = set(), 0
    tries = 0
    while k < a.n and tries < a.n * 50:
        tries += 1
        split = "eval" if rng.random() < a.eval else "train"
        t = make(rng, split, k)
        if t["message"] in seen:
            continue
        seen.add(t["message"])
        sys.stdout.write(json.dumps(t, ensure_ascii=False) + "\n")
        k += 1


if __name__ == "__main__":
    main()
