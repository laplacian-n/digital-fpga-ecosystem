#!/usr/bin/env python3
"""The dataset as a trainer reads it: tools inlined per row, masked turns marked, optional chat text.

  python3 tools/dataset/export_hf.py tools/dataset/data/train.jsonl.gz train_hf.jsonl
  python3 tools/dataset/export_hf.py tools/dataset/data/train.jsonl.gz train_text.jsonl --render Qwen/Qwen3.5-4B

Default: one JSON per line {messages, tools} (TRL SFTTrainer / most chat-SFT tools take this), with
`train: false` on an assistant message turned into the field `weight: 0` (TRL ≥0.20 / axolotl style).
--render: also apply the model's chat template (needs `transformers`) and write {"text": …}.
--drop-masked: leave out rows that have a masked turn (if your trainer cannot mask single turns).
"""
import argparse
import gzip
import json
import os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--tools", default=os.path.join(os.path.dirname(__file__), "data", "tools_app.json"))
    ap.add_argument("--render", default=None, help="a HF model id / path whose chat template renders the text")
    ap.add_argument("--drop-masked", action="store_true")
    ap.add_argument("--tools-subset", type=int, default=0,
                    help="keep only the tools a conversation uses + this many others (random) — the app's 40 schemas are "
                         "~8.3k tokens of every 10k-token row; trimming trains ~3x faster, at the cost of not matching the "
                         "full list the app sends at inference (default 0 = all, faithful)")
    a = ap.parse_args()
    app_tools = json.load(open(a.tools, encoding="utf-8"))
    import random
    rng = random.Random(3)
    tok = None
    if a.render:
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(a.render)
    op = gzip.open if a.src.endswith(".gz") else open
    n = 0
    with op(a.src, "rt", encoding="utf-8") as f, open(a.dst, "w", encoding="utf-8") as out:
        for line in f:
            r = json.loads(line)
            masked = any(m.get("train") is False for m in r["messages"])
            if masked and a.drop_masked:
                continue
            tools = app_tools if r.get("tools_ref") == "app" else r.get("tools")
            if tools and a.tools_subset:
                used = {c["function"]["name"] for m in r["messages"] for c in m.get("tool_calls") or []}
                others = [t for t in tools if t["function"]["name"] not in used]
                rng.shuffle(others)
                keep = used | {t["function"]["name"] for t in others[:a.tools_subset]}
                tools = [t for t in tools if t["function"]["name"] in keep]      # in the app's order
            msgs = []
            for i, m in enumerate(r["messages"]):
                m = dict(m)
                if m.pop("train", True) is False:
                    m["weight"] = 0
                if r.get("meta", {}).get("train_from") and i < r["meta"]["train_from"] and m["role"] == "assistant":
                    m["weight"] = 0                      # chat history before the request (the editor's greeting)
                msgs.append(m)
            row = {"messages": msgs}
            if tools:
                row["tools"] = tools
            if tok:
                row = {"text": tok.apply_chat_template(msgs, tools=tools, tokenize=False)}
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1
    print(f"wrote {n} rows to {a.dst}")


if __name__ == "__main__":
    main()
