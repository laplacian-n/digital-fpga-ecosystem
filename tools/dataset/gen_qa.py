#!/usr/bin/env python3
"""Category: questions the agent answers directly (no tool call) — every answer computed here.

  python3 tools/dataset/gen_qa.py --n 800 --seed 4 > qa_tasks.jsonl

Number bases, two's complement, BCD, Gray code, truth-table rows, flip-flops for a counter, clock
dividers on the EDGE 50 MHz clock, the EDGE common-anode 7-segment (active-low), and minimising a
function given as minterms (exact minimum sum of products, by search). The agent's prompt says a
question that needs no change is answered directly in Thai; these teach that, and teach the numbers.
"""
import argparse
import itertools
import json
import math
import random
import sys

SEG = {0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg",
       10: "abcefg", 11: "cdefg", 12: "adef", 13: "bcdeg", 14: "adefg", 15: "aefg"}


def grp(s, n=4):
    s = s.zfill((len(s) + n - 1) // n * n)
    return " ".join(s[i:i + n] for i in range(0, len(s), n))


def q_base(rng):
    v = rng.randint(5, 255)
    kind = rng.choice(["b2d", "d2b", "d2h", "h2b", "b2h"])
    b = format(v, "b")
    if kind == "b2d":
        terms = [f"{int(c)}×2^{len(b) - 1 - i}" for i, c in enumerate(b) if c == "1"]
        q = rng.choice([f"เลขฐานสอง {grp(b)} มีค่าเท่าไรในฐานสิบ", f"{b}₂ เป็นฐานสิบได้เท่าไร", f"แปลง {b} (ฐาน 2) เป็นฐาน 10 หน่อย"])
        a = f"{grp(b)}₂ = {' + '.join(terms)} = {v}"
    elif kind == "d2b":
        q = rng.choice([f"เลข {v} ฐานสิบเขียนเป็นฐานสองยังไง", f"แปลง {v} เป็นเลขฐานสอง 8 บิต", f"{v} ในฐาน 2 คืออะไร"])
        steps, x = [], v
        while x:
            steps.append(f"{x} ÷ 2 = {x // 2} เศษ {x % 2}")
            x //= 2
        a = "หารด้วย 2 ไปเรื่อย ๆ แล้วอ่านเศษจากล่างขึ้นบน:\n" + "\n".join(steps) + f"\nได้ {v} = {grp(format(v, '08b'))}₂"
    elif kind == "d2h":
        q = rng.choice([f"{v} ฐานสิบเป็นฐานสิบหกเท่าไร", f"แปลง {v} เป็น hex"])
        a = f"{v} = {v // 16}×16 + {v % 16} → {v:X}₁₆ (0x{v:02X})  ·  ฐานสอง {grp(format(v, '08b'))}"
    elif kind == "h2b":
        q = rng.choice([f"0x{v:02X} เป็นเลขฐานสองอะไร", f"เลขฐานสิบหก {v:X} แปลงเป็นฐานสองให้หน่อย"])
        a = "แปลงทีละหลัก hex → 4 บิต: " + ", ".join(f"{c} = {int(c, 16):04b}" for c in f"{v:02X}") + f"\nได้ {grp(format(v, '08b'))}₂ (= {v} ฐานสิบ)"
    else:
        q = rng.choice([f"{grp(format(v, '08b'))} ฐานสองเป็นฐานสิบหกเท่าไร", f"แปลง {format(v, '08b')}₂ เป็น hex"])
        a = "แบ่งทีละ 4 บิตจากขวา: " + ", ".join(f"{format(v, '08b')[i:i + 4]} = {int(format(v, '08b')[i:i + 4], 2):X}" for i in (0, 4)) + f"\nได้ 0x{v:02X} (= {v} ฐานสิบ)"
    return q, a


def q_twos(rng):
    n = rng.choice([4, 8, 8])
    lo, hi = -(1 << (n - 1)), (1 << (n - 1)) - 1
    v = rng.randint(lo, -1)
    code = format(v & ((1 << n) - 1), f"0{n}b")
    if rng.random() < 0.5:
        q = rng.choice([f"{v} แบบ 2's complement {n} บิตเขียนยังไง", f"เขียน {v} เป็นเลขฐานสองแบบมีเครื่องหมาย {n} บิต (two's complement)"])
        pos = format(-v, f"0{n}b")
        inv = "".join("1" if c == "0" else "0" for c in pos)
        a = f"เริ่มจาก +{-v} = {grp(pos)} → กลับทุกบิต = {grp(inv)} → บวก 1 = {grp(code)}\nดังนั้น {v} = {grp(code)} ({n} บิต, ช่วงที่แทนได้ {lo} ถึง {hi})"
    else:
        q = rng.choice([f"{grp(code)} ถ้าเป็นเลขมีเครื่องหมาย {n} บิตแบบ 2's complement มีค่าเท่าไร", f"เลข signed {n} บิต {code} คือเท่าไรในฐานสิบ"])
        a = f"บิตซ้ายสุดเป็น 1 จึงเป็นลบ: ค่า = {int(code, 2)} − 2^{n} = {int(code, 2)} − {1 << n} = {v}"
    return q, a


def q_codes(rng):
    kind = rng.choice(["bcd", "gray", "gray2"])
    if kind == "bcd":
        v = rng.randint(10, 99)
        q = rng.choice([f"{v} เขียนเป็นรหัส BCD ยังไง", f"รหัส BCD ของ {v} คืออะไร"])
        a = f"BCD แปลงทีละหลักฐานสิบเป็น 4 บิต: {v // 10} = {v // 10:04b}, {v % 10} = {v % 10:04b}\nได้ {v // 10:04b} {v % 10:04b} (ต่างจากฐานสอง {v} = {grp(format(v, '08b'))})"
    elif kind == "gray":
        n = rng.choice([3, 4])
        v = rng.randint(1, (1 << n) - 1)
        g = v ^ (v >> 1)
        q = rng.choice([f"เลข {v} ในรหัสเกรย์ {n} บิตคืออะไร", f"แปลง {v} เป็น Gray code {n} บิต"])
        a = f"{v} = {v:0{n}b}₂ → Gray = b XOR (b >> 1) = {v:0{n}b} XOR {v >> 1:0{n}b} = {g:0{n}b}"
    else:
        n = 3
        seq = [format(i ^ (i >> 1), "03b") for i in range(8)]
        q = rng.choice(["รหัสเกรย์ 3 บิตเรียงจาก 0 ถึง 7 มีอะไรบ้าง", "ขอลำดับ Gray code 3 บิตหน่อย"])
        a = "Gray code 3 บิต (ค่าที่อยู่ติดกันต่างกันแค่บิตเดียว): " + " → ".join(seq)
    return q, a


def q_count(rng):
    kind = rng.choice(["rows", "ff", "div", "div2"])
    if kind == "rows":
        n = rng.randint(2, 8)
        q = rng.choice([f"วงจรที่มีอินพุต {n} ตัว ตารางความจริงมีกี่แถว", f"{n} อินพุตต้องเขียนตารางความจริงกี่แถว"])
        a = f"แต่ละอินพุตเป็นได้ 2 ค่า: 2^{n} = {1 << n} แถว"
    elif kind == "ff":
        m = rng.choice([6, 10, 12, 16, 24, 60, 100, 1000])
        k = math.ceil(math.log2(m))
        q = rng.choice([f"ตัวนับ mod {m} (นับ 0 ถึง {m - 1}) ต้องใช้ flip-flop อย่างน้อยกี่ตัว", f"นับ 0–{m - 1} ใช้ D flip-flop กี่ตัว"])
        a = f"ต้องแทนได้ {m} ค่า: 2^{k - 1} = {1 << (k - 1)} < {m} ≤ 2^{k} = {1 << k} จึงใช้อย่างน้อย {k} ตัว"
    else:
        f = rng.choice([1, 2, 5, 10, 100, 1000])
        n = 50_000_000 // f
        if kind == "div":
            q = rng.choice([f"จาก clock 50 MHz บนบอร์ด อยากได้ {f} Hz ต้องหารด้วยเท่าไร", f"หาร 50 MHz ให้เหลือ {f} Hz ต้องนับถึงเท่าไร"])
        else:
            q = f"ทำไฟกะพริบ {f} ครั้งต่อวินาทีจาก clock 50 MHz ต้องใช้ตัวนับกี่บิต"
        bits = math.ceil(math.log2(n))
        hb = math.ceil(math.log2(n // 2))
        a = (f"50 MHz ÷ {f} Hz = {n:,} → หารความถี่ด้วย {n:,}\n"
             f"- แบบนับ 0 ถึง {n - 1:,} แล้วเริ่มใหม่ (pulse กว้าง 1 clock): ตัวนับ {bits} บิต\n"
             f"- แบบสลับ 0/1 ทุก {n // 2:,} clock (duty 50 %): นับ 0 ถึง {n // 2 - 1:,} ใช้ {hb} บิต")
    return q, a


def q_seg(rng):
    d = rng.randint(0, 9) if rng.random() < 0.8 else rng.randint(10, 15)
    on = SEG[d]
    bits = "".join("0" if s in on else "1" for s in "abcdefg")
    name = f"{d}" if d < 10 else f"{d:X}"
    q = rng.choice([f"จะให้ 7-seg บนบอร์ด EDGE แสดงเลข {name} ต้องส่ง a-g เป็นอะไร", f"แสดง {name} บน 7 segment ของบอร์ดต้องให้ขา a ถึง g เป็นค่าอะไร"])
    a = (f"เลข {name} ใช้ส่วน {', '.join(on)} ติด\nบอร์ด EDGE เป็น common anode (active-low: 0 = ติด) จึงส่ง "
         f"a b c d e f g = {' '.join(bits)}\nและเลือกหลักด้วย an ของหลักนั้น = 0 (หลักอื่น = 1)")
    return q, a


def min_sop(ones, n, names):
    """Exact minimum sum of products (fewest terms, then fewest literals) by search — n ≤ 4."""
    cubes = []
    for pat in itertools.product("01-", repeat=n):
        cov = [m for m in range(1 << n) if all(p == "-" or int(p) == (m >> (n - 1 - i)) & 1 for i, p in enumerate(pat))]
        if all(m in ones for m in cov):
            cubes.append(("".join(pat), set(cov)))
    primes = [c for c in cubes if not any(c[1] < d[1] for d in cubes)]
    best = None
    for k in range(1, len(primes) + 1):
        for combo in itertools.combinations(primes, k):
            if set().union(*(c[1] for c in combo)) >= set(ones):
                lits = sum(sum(ch != "-" for ch in c[0]) for c in combo)
                if best is None or lits < best[0]:
                    best = (lits, combo)
        if best:
            break
    terms = []
    for pat, cov in best[1]:
        t = "".join(names[i] + ("'" if ch == "0" else "") for i, ch in enumerate(pat) if ch != "-")
        terms.append((t or "1", sorted(cov)))
    return terms


def q_kmap(rng):
    n = rng.choice([3, 3, 4])
    names = "abcd"[:n]
    ones = sorted(rng.sample(range(1 << n), rng.randint(2, (1 << n) - 2)))
    terms = min_sop(set(ones), n, names)
    q = rng.choice([f"ลดรูป f({','.join(names)}) = Σm({', '.join(map(str, ones))}) ให้หน่อย",
                    f"หาสมการที่ลดรูปแล้วของ f({','.join(names)}) = Σm({','.join(map(str, ones))})"])
    a = ("จัดกลุ่ม 1 ใน K-map (" + names[0] + " = MSB):\n" + "\n".join(f"- {t}: คลุม m{', m'.join(map(str, cov))}" for t, cov in terms)
         + f"\nf = {' + '.join(t for t, _ in terms)}")
    return q, a, {"ones": ones, "n": n}


GENS = [(q_base, 3), (q_twos, 2), (q_codes, 2), (q_count, 3), (q_seg, 1), (q_kmap, 3)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=800)
    ap.add_argument("--seed", type=int, default=4)
    ap.add_argument("--eval", type=float, default=0.1)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    pool = [g for g, w in GENS for _ in range(w)]
    seen, k = set(), 0
    while k < a.n:
        r = rng.choice(pool)(rng)
        q, ans = r[0], r[1]
        if q in seen:
            continue
        seen.add(q)
        split = "eval" if rng.random() < a.eval else "train"
        t = {"id": f"qa-{split}-{k:05d}", "cat": "qa", "split": split, "message": q, "answer": ans, "use_sheet": None}
        if len(r) > 2:
            t["check"] = r[2]
        sys.stdout.write(json.dumps(t, ensure_ascii=False) + "\n")
        k += 1


if __name__ == "__main__":
    main()
