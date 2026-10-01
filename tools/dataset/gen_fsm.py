#!/usr/bin/env python3
"""Category: sequence detectors (lab FSMs) — a Thai request → state diagram + an acceptance test.

  python3 tools/dataset/gen_fsm.py --n 600 --seed 2 > fsm_tasks.jsonl

The diagram is built by code (KMP: each state = the longest prefix of the pattern seen so far),
for Moore or Mealy, overlapping or not, and checked here against a direct reference detector on
random streams. The acceptance test the teacher sets (a clock-by-clock sequence) comes from the
reference detector, not from the diagram — so the app's check of the built circuit is independent.

Clock convention of the app's simulator (measured): Moore z at clock i = after the inputs before i;
Mealy z at clock i = including the input of clock i.
"""
import argparse
import hashlib
import json
import random
import sys

FRAMES = [
    ("ออกแบบวงจรตรวจจับลำดับบิต {p} จากอินพุต {x} {ov} ให้ {z} เป็น 1 เมื่อเจอ แบบ {kind}", ""),
    ("ช่วยทำ sequence detector หา {p} {ov} ใช้ FSM แบบ {kind} อินพุต {x} เอาต์พุต {z}", ""),
    ("อยากได้ FSM แบบ {kind} ที่ {z} = 1 เมื่ออินพุต {x} เข้ามาเป็น {p} ตามลำดับ {ov}", ""),
    ("สร้างวงจรตรวจจับรหัส {p} ({kind}, {ov}) อินพุตชื่อ {x} เอาต์พุตชื่อ {z}", ""),
    ("ทำ state machine แบบ {kind} ตรวจจับ {p} บนสายอินพุต {x} {ov} ผลออกที่ {z}", "E"),
    ("ออกแบบ {kind} machine ที่จับลำดับ {p} ใน {x} ได้ {ov} แล้วให้ {z} ติด", "E"),
]
OVERLAP = {True: [("ซ้อนทับกันได้", ""), ("แบบ overlap", ""), ("นับแบบซ้อนกันได้", ""), ("ให้ลำดับซ้อนกันได้", "E")],
           False: [("ไม่ซ้อนทับ", ""), ("แบบ non-overlap", ""), ("เจอแล้วเริ่มนับใหม่", ""), ("ห้ามใช้บิตซ้ำ", "E")]}
KIND = {"moore": ["Moore", "มัวร์"], "mealy": ["Mealy", "มีลี่"]}
NAMES = [("x", "z"), ("din", "found"), ("x", "y"), ("in_bit", "detect"), ("a", "match"), ("s", "hit")]
SHEET_TAILS = [" ลงแผ่น {s}", " บนแผ่น {s}", " ตั้งชื่อแผ่นว่า {s}"]


def pick(rng, items, split):
    return rng.choice([x for x in items if split == "eval" or x[1] != "E"])


def kmp_next(p, k, b, overlap):
    """State after seeing bit b in state k (k = how much of p matches). A full match is k = len(p)."""
    n = len(p)
    if k == n:
        if not overlap:
            k = 0                 # start over: none of the matched bits can be reused
        else:
            k = longest_border(p, n)
    s = p[:k] + b
    for L in range(min(len(s), n), -1, -1):
        if s.endswith(p[:L]):
            return L
    return 0


def longest_border(p, n):
    for L in range(n - 1, 0, -1):
        if p[:n].endswith(p[:L]):
            return L
    return 0


def reference(p, bits, overlap):
    """1 at each position where the pattern ends (no reuse of matched bits when not overlapping)."""
    out, last_end = [], -1
    for i in range(len(bits)):
        hit = i + 1 >= len(p) and "".join(bits[i + 1 - len(p):i + 1]) == p
        if hit and not overlap and i - len(p) < last_end:
            hit = False
        if hit:
            last_end = i
        out.append(1 if hit else 0)
    return out


def diagram(p, overlap, kind, x, z):
    n = len(p)
    lines = [f"inputs: {x}", f"outputs: {z}"]
    states = range(n + 1) if kind == "moore" else range(n)
    name = lambda k: f"S{k}"
    meaning = {}
    for k in states:
        meaning[name(k)] = "ยังไม่เจอส่วนต้นของลำดับ" if k == 0 else (f"เจอครบ {p}" if k == n else f"เจอ {p[:k]}")
        lines.append(f"state {name(k)}: {z}={1 if k == n else 0}" if kind == "moore" else f"state {name(k)}")
    trans = []
    for k in states:
        for b in "10":
            j = kmp_next(p, k, b, overlap)
            cond = x if b == "1" else f"~{x}"
            if kind == "mealy" and j == n:      # Mealy: the output is on the arrow; the full match is not a state
                j2 = longest_border(p, n) if overlap else 0
                trans.append((name(k), name(j2), cond, 1))
            else:
                trans.append((name(k), name(j), cond, 0))
    for f, t, c, o in trans:
        lines.append(f"{f} -> {t} when {c}" + (f" / {z}=1" if o else ""))
    lines.append("reset S0")
    return "\n".join(lines), meaning, trans


def run_diagram(trans, kind, p, bits):
    """Simulate the diagram text's transitions (as the app will) in the app's clock convention."""
    n = len(p)
    T = {(f, c): (t, o) for f, t, c, o in trans}
    st, out = "S0", []
    for b in bits:
        cond_hit = [c for (f, c) in T if f == st and ((c.startswith("~") and b == "0") or (not c.startswith("~") and b == "1"))][0]
        t, o = T[(st, cond_hit)]
        if kind == "moore":
            out.append(1 if st == f"S{n}" else 0)        # the state before this clock
        else:
            out.append(o)
        st = t
    return out


def stream(rng, p, L):
    """A random stream with the pattern planted a few times (once overlapping itself when it can)."""
    bits = [rng.choice("01") for _ in range(L)]
    for _ in range(2):
        i = rng.randrange(0, L - len(p))
        bits[i:i + len(p)] = list(p)
    b = longest_border(p, len(p))
    if b and rng.random() < 0.7:
        i = rng.randrange(0, L - (2 * len(p) - b))
        seq = p + p[b:]
        bits[i:i + len(seq)] = list(seq)
    return bits


def make(rng, split, k):
    n = rng.choice([3, 3, 4, 4, 4, 5])
    p = "".join(rng.choice("01") for _ in range(n))
    if len(set(p)) == 1 and rng.random() < 0.7:
        return None
    overlap = rng.random() < 0.55
    kind = rng.choice(["moore", "mealy"])
    x, z = rng.choice(NAMES)
    text, meaning, trans = diagram(p, overlap, kind, x, z)
    bits = stream(rng, p, rng.choice([16, 20, 24]))
    ref = reference(p, bits, overlap)
    want = ref if kind == "mealy" else [0] + ref[:-1]          # Moore shows it one clock later
    got = run_diagram(trans, kind, p, bits)
    if got != want:
        raise SystemExit(f"diagram ≠ reference for {p} {kind} overlap={overlap}: {got} vs {want}")
    frame = pick(rng, FRAMES, split)[0]
    msg = frame.format(p=p, x=x, z=z, ov=pick(rng, OVERLAP[overlap], split)[0], kind=rng.choice(KIND[kind]))
    sheet = None
    if rng.random() < 0.4:
        sheet = rng.choice([f"det{p}", f"seq_{p}", "fsm1", f"q{rng.randint(1, 9)}", f"lab7_{k % 5}"])
        msg += rng.choice(SHEET_TAILS).format(s=sheet)
    vbits = [rng.choice("01") for _ in range(64)]                # a longer stream, checked outside the conversation
    vref = reference(p, vbits, overlap)
    return {"id": f"fsm-{split}-{k:05d}", "cat": "nl_fsm", "split": split, "message": msg, "sheet": sheet,
            "use_sheet": sheet or f"det_{p}",
            "verify": {"inputs": [{x: int(b)} for b in vbits], "expect": {z: vref if kind == "mealy" else [0] + vref[:-1]}},
            "pattern": p, "overlap": overlap, "kind": kind, "x": x, "z": z, "fsm": text, "meaning": meaning,
            "test": {"inputs": [{x: int(b)} for b in bits], "expect": {z: want}}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=600)
    ap.add_argument("--seed", type=int, default=2)
    ap.add_argument("--eval", type=float, default=0.1)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    seen, k = set(), 0
    while k < a.n:
        split = "eval" if rng.random() < a.eval else "train"
        t = make(rng, split, k)
        if not t:
            continue
        h = hashlib.sha1(t["message"].encode()).hexdigest()
        if h in seen:
            continue
        seen.add(h)
        sys.stdout.write(json.dumps(t, ensure_ascii=False) + "\n")
        k += 1


if __name__ == "__main__":
    main()
