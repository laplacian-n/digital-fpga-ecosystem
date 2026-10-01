#!/usr/bin/env python3
"""Measure a model on the held-out Q&A-mode questions (gen_qamode.py → eval_qamode.jsonl).

  OR_KEY=… python3 tools/dataset/eval_qamode.py --tasks RUN_DIR/eval_qamode.jsonl \
      [--endpoint http://127.0.0.1:8080/v1/chat/completions] [--out qamode_eval.jsonl] [--workers 2]
  (a hosted model for comparison: --endpoint https://openrouter.ai/api/v1/chat/completions --model qwen/qwen3.5-9b
   --bearer-env OR_KEY)

Each question goes to the model under test exactly as the app sends it (Q&A mode: same notes, same system
prompt, temperature 0.3, 512 tokens, thinking off). Both judges grade the answer with the reference answer in
view; a question passes when both say correct ≥ 4 and relevant ≥ 4. Prints the pass rate per kind of question.
"""
import argparse
import collections
import concurrent.futures as cf
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_qamode as g  # noqa: E402

G_PROMPT = """You grade answers for Thai university students in a digital logic course (EDGE Spartan-7 board: 3.3 V I/O, \
50 MHz clock on H11, 4-digit common-anode 7-segment with active-low a..g/dp/an, push buttons active-high, \
pb[0..4] = top, bottom, left, right, center).

QUESTION:
{q}

REFERENCE ANSWER (checked correct; the answer may say it differently):
{ref}

ANSWER TO GRADE:
{a}

Score 1-5: correct (every technical statement true; any wrong fact = 2 or less), relevant (answers what was asked), \
thai (clear Thai a student understands). Return only JSON: {{"correct": n, "relevant": n, "thai": n, "errors": ["..."]}}"""


def ask_model(endpoint, model, messages, bearer=None):
    body = json.dumps({"model": model, "messages": messages, "temperature": 0.3, "max_tokens": 512,
                       "chat_template_kwargs": {"enable_thinking": False}, "reasoning": {"enabled": False}}).encode()
    h = {"Content-Type": "application/json"}
    if bearer:
        h["Authorization"] = "Bearer " + bearer
    req = urllib.request.Request(endpoint, data=body, headers=h)
    with urllib.request.urlopen(req, timeout=300) as r:
        d = json.loads(r.read().decode())
    return re.sub(r"<think>.*?</think>", "", d["choices"][0]["message"].get("content") or "", flags=re.S).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", required=True)
    ap.add_argument("--endpoint", default="http://127.0.0.1:8080/v1/chat/completions")
    ap.add_argument("--model", default="local")
    ap.add_argument("--out", default="qamode_eval.jsonl")
    ap.add_argument("--workers", type=int, default=2, help="parallel requests to the model under test")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--bearer-env", default="", help="env var holding a key for --endpoint (a hosted model, e.g. OR_KEY)")
    a = ap.parse_args()
    key = os.environ.get("OR_KEY", "").strip()
    if not key:
        sys.exit("OR_KEY is not set (the judges run on OpenRouter)")
    api, r = g.OR(key), g.retriever.Retriever()
    op = __import__("gzip").open if a.tasks.endswith(".gz") else open
    tasks = [json.loads(l) for l in op(a.tasks, "rt", encoding="utf-8") if l.strip()]
    if a.limit:
        tasks = tasks[:a.limit]

    def one(t):
        msgs = g.chat_server.ask_messages(g.payload(t["message"]), g.retrieve(r, t["message"]))
        try:
            ans = ask_model(a.endpoint, a.model, msgs, os.environ.get(a.bearer_env) if a.bearer_env else None)
        except Exception as e:
            return dict(t, answer=None, error=str(e), passed=False)
        grades = {}
        for jm in g.JUDGES:
            grades[jm] = g.first_json(api.chat(jm, [{"role": "user", "content": G_PROMPT.format(
                q=t["message"], ref=t["reference"], a=ans)}], temperature=0.0, max_tokens=600))
        ok = all(isinstance(j, dict) and int(j.get("correct", 0)) >= 4 and int(j.get("relevant", 0)) >= 4 for j in grades.values())
        return dict(t, answer=ans, grades=grades, passed=ok, markdown=bool(re.search(r"\*\*|^#|```", ans, flags=re.M)))

    res = []
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for i, x in enumerate(ex.map(one, tasks), 1):
            res.append(x)
            if i % 10 == 0:
                print(f"[{i}/{len(tasks)}] passed {sum(y['passed'] for y in res)}", file=sys.stderr, flush=True)
    with open(a.out, "w", encoding="utf-8") as f:
        for x in res:
            f.write(json.dumps(x, ensure_ascii=False) + "\n")
    by = collections.defaultdict(lambda: [0, 0])
    for x in res:
        k = (x.get("kind") or "?").split("/")[0].strip()[:30]
        by[k][0] += x["passed"]
        by[k][1] += 1
    n = len(res)
    p = sum(x["passed"] for x in res)
    print(f"Q&A mode: {p}/{n} passed ({100 * p / max(1, n):.1f} %), markdown in {sum(x.get('markdown', False) for x in res)} answers")
    for k, (pp, nn) in sorted(by.items(), key=lambda kv: -kv[1][1]):
        print(f"  {k:32s} {pp}/{nn}")


if __name__ == "__main__":
    main()
