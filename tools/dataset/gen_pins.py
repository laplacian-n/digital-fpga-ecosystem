#!/usr/bin/env python3
"""Category: put a circuit on the EDGE board — a Thai request naming switches / buttons / LEDs → set_pins.

  python3 tools/dataset/gen_pins.py --n 400 --seed 3 > pins_tasks.jsonl

Each task first draws a small circuit (setup, done by run.js before the conversation: set_spec +
build_circuit, so the sheet is on screen and verified), then the user asks for the pins. The map the
request means is known here; run.js compares it with the sheet's pinmap afterwards.
Board targets (BOARD_PINS in the editor): sw:0-15, led:0-15, pb:0-4 (top bottom left right center).
"""
import argparse
import json
import random
import sys

PB = ["บน", "ล่าง", "ซ้าย", "ขวา", "กลาง"]
PB_EN = ["top", "bottom", "left", "right", "center"]
IN_SETS = [["a", "b", "c"], ["a", "b", "c", "d"], ["x", "y"], ["p", "q", "r"], ["s1", "s0"], ["en", "d0", "d1"]]
OUT_SETS = [["z"], ["f"], ["led_out"], ["y1", "y0"], ["hit"], ["sum", "carry"]]


def sw_text(rng, i):
    return rng.choice([f"SW{i}", f"สวิตช์ {i}", f"sw{i}", f"สวิตช์ตัวที่ {i}"])


def led_text(rng, i):
    return rng.choice([f"LED{i}", f"ไฟ LED {i}", f"led{i}", f"หลอด LED ดวงที่ {i}"])


def pb_text(rng, i):
    return rng.choice([f"ปุ่ม{PB[i]}", f"ปุ่มกด{PB[i]}", f"ปุ่ม {PB_EN[i]}"])


def formula_for(rng, ins, outs):
    ops = [" & ", " | ", " ^ "]
    eqs = []
    for j, o in enumerate(outs):
        # the first output reads every input, so each one is a port of the sheet (pins need the port)
        k = rng.sample(ins, len(ins)) if j == 0 else rng.sample(ins, min(len(ins), rng.choice([2, 3])))
        e = k[0]
        for v in k[1:]:
            e = f"({e}{rng.choice(ops)}{'~' if rng.random() < 0.3 else ''}{v})"
        eqs.append(f"{o} = {e}")
    return "; ".join(eqs)


def make(rng, split, k):
    ins = rng.choice(IN_SETS)[:]
    outs = rng.choice(OUT_SETS)[:]
    if set(ins) & set(outs):
        return None
    formula = formula_for(rng, ins, outs)
    sheet = rng.choice(["logic1", "lab3", f"ex{rng.randint(1, 20)}", "my_circuit", "test_board"])
    style = rng.choice(["each", "range", "buttons", "each"])
    mapping, parts = {}, []
    if style == "range" and len(ins) >= 2:
        s0 = rng.randint(0, 16 - len(ins))
        for i, v in enumerate(ins):
            mapping[v] = f"sw:{s0 + i}"
        parts.append(f"ใช้สวิตช์ {s0}–{s0 + len(ins) - 1} เป็น {' '.join(ins)} ตามลำดับ")
    elif style == "buttons" and len(ins) <= 5:
        bs = rng.sample(range(5), len(ins))
        for v, b in zip(ins, bs):
            mapping[v] = f"pb:{b}"
        parts.append(", ".join(f"{v} มาจาก{pb_text(rng, b)}" for v, b in zip(ins, bs)))
    else:
        sws = rng.sample(range(16), len(ins))
        for v, s in zip(ins, sws):
            mapping[v] = f"sw:{s}"
        parts.append(", ".join(f"{v} ต่อกับ {sw_text(rng, s)}" for v, s in zip(ins, sws)))
    leds = rng.sample(range(16), len(outs))
    for o, l in zip(outs, leds):
        mapping[o] = f"led:{l}"
    parts.append(" และ ".join(f"{o} แสดงที่ {led_text(rng, l)}" for o, l in zip(outs, leds)))
    frame = rng.choice(["ช่วยต่อขาลงบอร์ดให้หน่อย: {p}", "ต่อขาแผ่น {s} ลงบอร์ด EDGE: {p}", "จะเอาวงจรนี้ลงบอร์ด {p}",
                        "ตั้งขาบอร์ดให้วงจรบนแผ่น {s} โดย {p}"])
    msg = frame.format(p=" แล้ว ".join(parts), s=sheet)
    return {"id": f"pins-{split}-{k:05d}", "cat": "nl_pins", "split": split, "message": msg, "use_sheet": sheet,
            "setup": [["set_spec", {"sheet": sheet, "formula": formula}], ["build_circuit", {"sheet": sheet, "formula": formula}]],
            "formula": formula, "map": mapping, "ins": ins, "outs": outs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=400)
    ap.add_argument("--seed", type=int, default=3)
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
