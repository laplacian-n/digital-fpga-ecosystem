#!/usr/bin/env python3
"""Put the runs together: validate every row, dedupe, keep eval tasks out, mix, write the dataset.

  python3 tools/dataset/build_dataset.py --runs RUN_DIR [RUN_DIR …] --online ONLINE_DIR --out tools/dataset/data

Each RUN_DIR is a run.js output (train.jsonl, eval.jsonl, tools.json). Writes into --out:
  train.jsonl.gz   {id, cat, source, messages, tools_ref|tools, meta}  — one conversation per line
  eval_tasks.jsonl.gz  held-out tasks with their answers (never in train) — run.js --eval-model replays them
  tools_app.json   the app's tool schemas (rows with tools_ref:"app" use these — run export_hf.py to inline)
  manifest.json    counts, the mix, checks run, sources and licences
A row's assistant message with "train": false is context only (a planned mistake) — mask it from the loss.
"""
import argparse
import collections
import gzip
import hashlib
import json
import os
import random

MIX = {   # share of the final train set per category (taken up to what exists)
    "nl_logic": 0.28, "nl_fsm": 0.12, "nl_fix": 0.10, "nl_compose": 0.07, "nl_pins": 0.07, "qa": 0.12,
    "general_thai": 0.17, "general_tools": 0.07,
}


def problems(r):
    """Why a row is not a valid chat-with-tools conversation (empty list = fine)."""
    out, msgs = [], r.get("messages") or []
    if not msgs:
        return ["no messages"]
    last = msgs[-1]
    if last.get("role") != "assistant" or not ((last.get("content") or "").strip() or last.get("tool_calls")):
        out.append("does not end with an assistant turn")   # a final tool call alone is fine (a single-call example)
    for i, m in enumerate(msgs):
        role = m.get("role")
        if role not in ("system", "user", "assistant", "tool"):
            out.append(f"bad role {role} at {i}")
        if role == "assistant" and m.get("tool_calls"):
            ids = []
            for c in m["tool_calls"]:
                try:
                    json.loads(c["function"]["arguments"])
                except Exception:
                    out.append(f"tool arguments not JSON at {i}")
                ids.append(c.get("id"))
            nxt = msgs[i + 1:i + 1 + len(ids)]
            if i == len(msgs) - 1:
                continue                                    # ends on the call: a single-call example
            if len(nxt) != len(ids) or any(n.get("role") != "tool" or n.get("tool_call_id") != k for n, k in zip(nxt, ids)):
                out.append(f"tool results out of order after {i}")
        if role == "assistant" and not m.get("tool_calls") and not (m.get("content") or "").strip() and i != 0:
            out.append(f"empty assistant turn at {i}")
        if role == "assistant" and "(teacher)" in (m.get("content") or ""):
            out.append("teacher placeholder text")
    if not any(m.get("role") == "assistant" and m.get("train", True) for m in msgs):
        out.append("nothing to train on")
    return out


def first_user(r):
    return next((m.get("content") or "" for m in r["messages"] if m.get("role") == "user" and not str(m.get("content")).startswith("(system)")), "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="+", required=True)
    ap.add_argument("--online", default=None)
    ap.add_argument("--tasks", nargs="*", default=[], help="the task files (gen_*.py output): their eval split becomes eval_tasks")
    ap.add_argument("--out", default="tools/dataset/data")
    ap.add_argument("--max-chars", type=int, default=60000, help="drop a conversation longer than this")
    ap.add_argument("--total", type=int, default=0, help="final train size (0 = as many as the mix allows)")
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--tokenizer", default=None, help="a tokenizer.json (e.g. Qwen3.5-4B's) — adds real token counts to the manifest")
    a = ap.parse_args()
    rng = random.Random(a.seed)
    os.makedirs(a.out, exist_ok=True)
    rows, evals, tools, dropped = [], [], None, collections.Counter()
    for d in a.runs:
        for name in ("train.jsonl",):
            p = os.path.join(d, name)
            if os.path.exists(p):
                for line in open(p, encoding="utf-8"):
                    if line.strip():
                        r = json.loads(line)
                        r["source"] = "program (tools/dataset, checked by the app)"
                        r["tools_ref"] = "app"
                        rows.append(r)
        p = os.path.join(d, "tools.json")
        if os.path.exists(p) and tools is None:
            tools = json.load(open(p, encoding="utf-8"))
    if a.online:
        for name in ("general_thai.jsonl", "general_tools.jsonl"):
            p = os.path.join(a.online, name)
            if os.path.exists(p):
                rows += [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]
    for p in a.tasks:
        evals += [t for t in (json.loads(l) for l in open(p, encoding="utf-8") if l.strip()) if t.get("split") == "eval"]
    # eval tasks: unique, and never a training conversation
    ev, seen_ev = [], set()
    for e in evals:
        if e["message"] not in seen_ev:
            seen_ev.add(e["message"])
            ev.append(e)
    clean, seen = [], set()
    for r in rows:
        why = problems(r)
        if why:
            dropped["invalid: " + why[0].split(" at ")[0]] += 1
            continue
        u = first_user(r)
        if u in seen_ev:
            dropped["same request as an eval task"] += 1
            continue
        h = hashlib.sha1((r["cat"] + "\0" + u).encode()).hexdigest()
        if h in seen:
            dropped["duplicate request"] += 1
            continue
        if sum(len(json.dumps(m, ensure_ascii=False)) for m in r["messages"]) > a.max_chars:
            dropped["too long"] += 1
            continue
        seen.add(h)
        clean.append(r)
    by = collections.defaultdict(list)
    for r in clean:
        by[r["cat"]].append(r)
    for v in by.values():
        rng.shuffle(v)
    # the mix: the scarcest category (relative to its share) sets the size, unless --total asks for less
    cats = [c for c in MIX if by.get(c)]
    share = sum(MIX[c] for c in cats)
    cap = min(len(by[c]) / (MIX[c] / share) for c in cats)
    total = int(min(a.total or cap, cap))
    pick = []
    for c in cats:
        k = max(1, round(total * MIX[c] / share))
        pick += by[c][:k]
    # categories bigger than their share keep the rest for a second, larger mix (train_all)
    rest = [r for c in by for r in by[c] if r not in pick]
    rng.shuffle(pick)
    with gzip.open(os.path.join(a.out, "train.jsonl.gz"), "wt", encoding="utf-8") as f:
        for r in pick:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with gzip.open(os.path.join(a.out, "train_extra.jsonl.gz"), "wt", encoding="utf-8") as f:
        for r in rest:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with gzip.open(os.path.join(a.out, "eval_tasks.jsonl.gz"), "wt", encoding="utf-8") as f:
        for e in ev:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    if tools:
        json.dump(tools, open(os.path.join(a.out, "tools_app.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    chars = [sum(len(m.get("content") or "") + len(m.get("reasoning_content") or "") + sum(len(c["function"]["arguments"]) for c in m.get("tool_calls") or [])
                 for m in r["messages"]) for r in pick]
    tok_stats = None
    if a.tokenizer:
        from tokenizers import Tokenizer
        tk = Tokenizer.from_file(a.tokenizer)
        tools_n = len(tk.encode(json.dumps(tools, ensure_ascii=False)).ids) if tools else 0
        per_cat = collections.defaultdict(list)
        for r in pick:
            body = "".join((m.get("content") or "") + (m.get("reasoning_content") or "")
                           + "".join(c["function"]["name"] + c["function"]["arguments"] for c in m.get("tool_calls") or []) for m in r["messages"])
            n = len(tk.encode(body).ids) + 6 * len(r["messages"])          # + the template's role markers
            n += tools_n if r.get("tools_ref") == "app" else (len(tk.encode(json.dumps(r.get("tools"), ensure_ascii=False)).ids) if r.get("tools") else 0)
            per_cat[r["cat"]].append(n)
        q = lambda v, f: sorted(v)[min(len(v) - 1, int(len(v) * f))]
        allv = [x for v in per_cat.values() for x in v]
        tok_stats = {"app_tool_schemas": tools_n, "all": {"median": q(allv, .5), "p95": q(allv, .95), "max": max(allv), "total": sum(allv)},
                     "by_category": {c: {"median": q(v, .5), "max": max(v)} for c, v in per_cat.items()}}
    man = {
        "train": len(pick), "train_extra": len(rest), "eval_tasks": len(ev),
        "train_by_category": dict(collections.Counter(r["cat"] for r in pick)),
        "extra_by_category": dict(collections.Counter(r["cat"] for r in rest)),
        "eval_by_category": dict(collections.Counter(e["cat"] for e in ev)),
        "available_by_category": {c: len(v) for c, v in by.items()},
        "mix_target": MIX, "dropped": dict(dropped),
        "chars_per_conversation": {"median": sorted(chars)[len(chars) // 2] if chars else 0, "max": max(chars) if chars else 0},
        "tokens": tok_stats,
        "with_masked_mistake": sum(1 for r in pick if any(m.get("train") is False for m in r["messages"])),
        "sources": {
            "program": "tools/dataset/gen_*.py → teacher.py through the app's real agent loop (run.js); every circuit checked against the task's known answer outside the conversation; no model wrote any of it",
            "general_thai": "airesearch/wangchanx-seed-free-synthetic-instruct-thai-120k (MIT) — filtered by tools/dataset/online.py",
            "general_tools": "NousResearch/hermes-function-calling-v1 (Apache-2.0) — converted by tools/dataset/online.py",
        },
    }
    json.dump(man, open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(man, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
