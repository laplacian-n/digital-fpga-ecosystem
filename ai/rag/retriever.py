"""
retriever.py - keyword/BM25 retrieval over ai/rag/index.jsonl with metadata
filtering and a verified-library-first rerank. NOT pure vector (per the design
in _ecosystem_docs: BM25/keyword + metadata + rerank, prefer verified items).

Pure stdlib (no numpy / rank_bm25). Okapi BM25 built in memory once.

CLI:  py -3.10 retriever.py "full adder carry" --group lab --k 5
API:  Retriever().search(query, k=8, group=None, topic=None, prefer_verified=True)
      format_context(hits) -> str  (ready to prepend to an LLM prompt)
"""
from __future__ import annotations
import json
import math
import re
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
INDEX = HERE / "index.jsonl"

_WORD = re.compile(r"[a-z0-9_]+")
_THAI = re.compile(r"[฀-๿]+")


def tokenize(text: str) -> list[str]:
    """ASCII word tokens + Thai character 3-grams (crude but works for BM25)."""
    t = (text or "").lower()
    toks = _WORD.findall(t)
    for w in list(toks):                      # also index underscore-split parts
        if "_" in w:
            toks.extend(p for p in w.split("_") if p)
    for run in _THAI.findall(t):
        if len(run) <= 3:
            toks.append(run)
        else:
            toks.extend(run[i:i + 3] for i in range(len(run) - 2))
    return toks


# How a question is asked, not what it is about: "latch กับ flip-flop ต่างกันยังไง" used to rank lab
# records first on the 3-grams of ต่างกัน / ยังไง (Q&A mode retrieves with the student's question).
_TH_ASK = re.compile(r"(ต่างกัน|แตกต่าง|ยังไง|อย่างไร|ยังงี้|คืออะไร|อะไร|ทำไม|เพราะอะไร|หรือเปล่า|รึเปล่า|ไหม|มั้ย|"
                     r"ได้ไหม|ช่วย|หน่อย|อธิบาย|บอก|ครับ|ค่ะ|คะ|นะ|เหรอ|หรอ|กับ|และ|ของ|ที่|คือ|เป็น|ใช้|ทำ|ให้|"
                     r"เมื่อไร|เมื่อไหร่|กี่|เท่าไร|เท่าไหร่|แบบไหน|ตัวไหน|อันไหน|ควร|ต้อง|จะ|แล้ว|บ้าง|"
                     r"ขอ|ยกตัวอย่าง|ตัวอย่าง|สั้นๆ|สั้น ๆ|ง่ายๆ|ให้ดู|งงมาก|งง|ทีละขั้น|ขั้นตอน)")
_EN_ASK = {"what", "why", "how", "is", "are", "the", "a", "an", "of", "and", "or", "vs", "between", "difference",
           "do", "does", "can", "to", "in", "for", "with", "which", "when", "step", "by", "example",
           "please", "explain", "me", "i", "it", "this"}


def tokenize_query(text: str) -> list[str]:
    """Query tokens: question words dropped (a query that is only question words keeps them); when the
    query has technical English words, Thai 3-grams count less — a 10-letter Thai word gives 8 of them."""
    t = (text or "").lower()
    words = [w for w in _WORD.findall(t) if w not in _EN_ASK]
    thai = _TH_ASK.sub(" ", t)
    toks = tokenize(" ".join(words) + " " + " ".join(_THAI.findall(thai)))
    return toks or tokenize(text)


class Retriever:
    def __init__(self, index_path: Path = INDEX, k1: float = 1.5, b: float = 0.75):
        self.k1, self.b = k1, b
        self.docs: list[dict] = []
        self.tokens: list[list[str]] = []
        self.df: Counter = Counter()
        with open(index_path, encoding="utf-8") as fh:
            for line in fh:
                rec = json.loads(line)
                toks = tokenize(rec.get("text", ""))
                # index title/entities extra so exact names weigh more
                toks += tokenize(rec.get("title", "")) * 2
                self.docs.append(rec)
                self.tokens.append(toks)
                for w in set(toks):
                    self.df[w] += 1
        self.N = len(self.docs)
        self.avgdl = (sum(len(t) for t in self.tokens) / self.N) if self.N else 0.0
        self.idf = {w: math.log(1 + (self.N - n + 0.5) / (n + 0.5)) for w, n in self.df.items()}
        self.id2row = {rec["id"]: i for i, rec in enumerate(self.docs)}
        # optional semantic side (hybrid): emb.npz from embed_index.py
        self.emb_ids, self.emb, self._embedder = None, None, None
        try:
            import numpy as _np
            z = _np.load(INDEX.parent / "emb.npz", allow_pickle=True)
            self.emb_ids = [str(x) for x in z["ids"]]
            self.emb = z["vecs"]
            self._np = _np
        except Exception:
            pass

    def _embed_query(self, query: str):
        if self.emb is None:
            return None
        if self._embedder is None:
            try:
                from fastembed import TextEmbedding
                self._embedder = TextEmbedding(
                    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
            except Exception:
                self.emb = None
                return None
        v = self._np.array(next(iter(self._embedder.embed([query]))), dtype="float32")
        return v / (self._np.linalg.norm(v) + 1e-9)

    def _bm25(self, q_tokens: list[str], i: int) -> float:
        toks = self.tokens[i]
        if not toks:
            return 0.0
        tf = Counter(toks)
        dl = len(toks)
        s = 0.0
        for w in q_tokens:
            if w not in tf:
                continue
            idf = self.idf.get(w, 0.0)
            f = tf[w]
            s += idf * (f * (self.k1 + 1)) / (f + self.k1 * (1 - self.b + self.b * dl / self.avgdl))
        return s

    def _passes(self, rec, group, topic):
        if group and rec["group"] != group:
            return False
        if topic and topic not in (rec.get("topic") or ""):
            return False
        return True

    def _mult(self, rec, qset, prefer_verified, group_boost):
        meta = rec.get("meta", {})
        mult = 1.0
        if prefer_verified and rec["group"] == "lab":
            if meta.get("golden"):
                mult *= 1.25
            elif meta.get("verified"):
                mult *= 1.12
        if group_boost:
            mult *= group_boost.get(rec["group"], 1.0)
        if set(tokenize(rec.get("title", ""))) & qset:
            mult *= 1.15
        return mult

    def search(self, query: str, k: int = 8, *, group: str | None = None,
               topic: str | None = None, prefer_verified: bool = True,
               group_boost: dict | None = None, hybrid: bool = True,
               rrf_k: int = 60) -> list[dict]:
        """BM25 always; if embeddings are present and hybrid=True, fuse BM25 + cosine
        ranks via Reciprocal Rank Fusion (recall for paraphrase/Thai) while keeping
        metadata filter + verified-first rerank. BM25 stays the base (no pure vector)."""
        q = tokenize_query(query)
        qset = set(q)
        # BM25 ranked list
        bm = [(self._bm25(q, i), i) for i, rec in enumerate(self.docs)
              if self._passes(rec, group, topic) and self._bm25(q, i) > 0]
        bm.sort(reverse=True)
        rank = {}
        bm_score = {}
        for r, (sc, i) in enumerate(bm):
            rank[i] = [r, None]
            bm_score[i] = sc
        # cosine ranked list (embedded docs only)
        use_emb = hybrid and self.emb is not None
        qv = self._embed_query(query) if use_emb else None
        if qv is not None:
            sims = self.emb @ qv
            order = self._np.argsort(-sims)
            r = 0
            for j in order[:200]:
                rid = self.emb_ids[int(j)]
                i = self.id2row.get(rid)
                if i is None or not self._passes(self.docs[i], group, topic):
                    continue
                if i not in rank:
                    rank[i] = [None, None]
                rank[i][1] = r
                r += 1
        # fuse (RRF) + apply rerank multiplier
        fused = []
        for i, (rb, rc) in rank.items():
            rrf = (1.0 / (rrf_k + rb) if rb is not None else 0.0) + \
                  (1.0 / (rrf_k + rc) if rc is not None else 0.0)
            fused.append((rrf * self._mult(self.docs[i], qset, prefer_verified, group_boost),
                          bm_score.get(i, 0.0), i))
        fused.sort(reverse=True)
        out = []
        for score, base, i in fused[:k]:
            rec = self.docs[i]
            out.append({"score": round(score, 5), "bm25": round(base, 3),
                        "id": rec["id"], "group": rec["group"], "source": rec["source"],
                        "title": rec.get("title", ""), "topic": rec.get("topic", ""),
                        "meta": rec.get("meta", {}), "payload": rec.get("payload", {})})
        return out


def format_context(hits: list[dict], max_chars: int = 4000) -> str:
    """Render hits as compact context to prepend to an LLM prompt."""
    lines, used = [], 0
    for h in hits:
        p = h["payload"]
        if h["group"] == "content":
            body = p.get("summary") or p.get("text", "")
            block = f"[{h['group']}:{h['source']} {p.get('section','')}] {p.get('topic','')}: {body}"
        elif h["group"] == "lab":
            sol = p.get("solution") or {}
            block = (f"[lab {h['meta'].get('lab','')}] {p.get('topic','')} :: "
                     f"{p.get('question','')[:200]} => {sol.get('final_expression','')}")
        else:  # vhdl
            block = f"[vhdl {', '.join(h['meta'].get('entities',[])[:2])}]\n{p.get('code','')[:600]}"
        block = block.strip()
        if used + len(block) > max_chars:
            break
        lines.append(block)
        used += len(block)
    return "\n\n".join(lines)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="+")
    ap.add_argument("--k", type=int, default=6)
    ap.add_argument("--group", choices=["content", "lab", "vhdl", "board"])
    ap.add_argument("--topic")
    ap.add_argument("--context", action="store_true", help="print formatted context block")
    a = ap.parse_args()
    r = Retriever()
    hits = r.search(" ".join(a.query), k=a.k, group=a.group, topic=a.topic)
    if a.context:
        print(format_context(hits))
    else:
        for h in hits:
            print(f"{h['score']:7.3f} [{h['group']:7}] {h['id']:16} {h['title'][:60]}")
