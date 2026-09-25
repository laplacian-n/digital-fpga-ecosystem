# -*- coding: utf-8 -*-
"""
eval_rag.py - retrieval regression + BM25-vs-hybrid comparison. Queries are
deliberately paraphrased / Thai (BM25's weak spot) to show the semantic side's
recall gain. hit@k = an expected doc-id substring appears in the top-k.
Run:  py -3.10 eval_rag.py
"""
from __future__ import annotations
from retriever import Retriever

# (query, [expected id-substrings], group|None, note)
QUERIES = [
    ("how long must data be stable before the clock edge", ["ch5-5-11", "timing"], "content", "EN paraphrase of setup time"),
    ("slow down the clock signal by dividing it", ["frequency-division", "ch5-5-18", "ch7-7-1"], "content", "EN paraphrase freq divider"),
    ("represent negative numbers and subtract in binary", ["2s-complement", "ch6-6-15", "ch6-6-3"], "content", "EN paraphrase 2's comp"),
    ("finite state machine mealy vs moore", ["ch7-7-14", "state-machines"], "content", "EN FSM"),
    ("วงจรลดรูปสมการบูลีน คาร์นอฟ", ["lab3-1"], "lab", "TH k-map lab"),
    ("เครื่องสถานะจำกัด", ["ch7-7-14", "state-machines"], "content", "TH FSM"),
    ("ปุ่มกดบนบอร์ด", ["board-pb"], "board", "TH push button"),
    ("ตัวถอดรหัสเจ็ดส่วน", ["7-segment", "seven", "7seg", "lab5", "lab4"], None, "TH 7-seg"),
    ("adder that chains carry between bits", ["adder", "ch6"], None, "EN ripple adder"),
    ("โจทย์ออกแบบวงจรบวกลบ 8 บิต", ["lab4"], "lab", "TH 8-bit add/sub lab"),
]


def hit(hits, expected):
    ids = " ".join(h["id"] + " " + h.get("title", "") for h in hits).lower()
    return any(e.lower() in ids for e in expected)


def run():
    r = Retriever()
    has_emb = r.emb is not None
    print(f"embeddings loaded: {has_emb}  (hybrid vs BM25-only)\n")
    bm_hits = hy_hits = 0
    print(f"{'query':44} {'BM25':5} {'HYBRID':6}  note")
    for q, exp, grp, note in QUERIES:
        bm = hit(r.search(q, k=3, group=grp, hybrid=False), exp)
        hy = hit(r.search(q, k=3, group=grp, hybrid=True), exp)
        bm_hits += bm; hy_hits += hy
        print(f"{q[:44]:44} {'  ✓' if bm else '  .'}   {'  ✓' if hy else '  .'}    {note}")
    n = len(QUERIES)
    print(f"\nhit@3  BM25-only: {bm_hits}/{n} ({bm_hits/n:.0%})   "
          f"HYBRID: {hy_hits}/{n} ({hy_hits/n:.0%})")
    return {"bm25": bm_hits, "hybrid": hy_hits, "n": n}


if __name__ == "__main__":
    run()
