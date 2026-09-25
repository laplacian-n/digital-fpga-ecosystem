"""
embed_index.py - build a local semantic embedding index for the teaching/reference
chunks (content + lab + board) to complement BM25 (hybrid retrieval). VHDL code
(8,974) stays BM25-only: keyword/entity match beats embeddings for raw code and
embedding 9k code blobs is wasteful.

Model: paraphrase-multilingual-MiniLM-L12-v2 (Thai + English, dim 384, ~120MB) so
Thai lab queries actually match. Saves emb.npz (ids, vectors float32, l2-normalized).
Run:  py -3.10 embed_index.py     (re-run after build_index.py changes the corpus)
"""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
INDEX = HERE / "index.jsonl"
OUT = HERE / "emb.npz"
MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
GROUPS = {"content", "lab", "board"}      # semantic side; vhdl stays BM25-only


def _text(rec: dict) -> str:
    return (rec.get("title", "") + " . " + rec.get("text", ""))[:512]


def build():
    from fastembed import TextEmbedding
    recs = [json.loads(l) for l in open(INDEX, encoding="utf-8")]
    sub = [r for r in recs if r["group"] in GROUPS]
    ids = [r["id"] for r in sub]
    texts = [_text(r) for r in sub]
    model = TextEmbedding(MODEL)
    vecs = np.array(list(model.embed(texts)), dtype=np.float32)
    vecs /= (np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-9)
    np.savez(OUT, ids=np.array(ids), vecs=vecs)
    print(f"embedded {len(ids)} docs (groups={sorted(GROUPS)}), dim={vecs.shape[1]} -> {OUT}")


if __name__ == "__main__":
    build()
