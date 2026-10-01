#!/usr/bin/env python3
"""Category qa_mode: what the chat's ถาม-ตอบ mode should know — concept questions answered in Thai.

  OR_KEY=… python3 tools/dataset/gen_qamode.py --out RUN_DIR [--per-chunk 4] [--workers 8] [--limit N]

Unlike the agent categories (written by programs), these answers are prose, so an OPEN-WEIGHT model
writes them (writer: Qwen3.5-397B-A17B, Apache-2.0 — its outputs may be used for training) and a second
open models of two other families judge them (DeepSeek V4 Pro and GLM-5.3; only their scores are kept, none of their
text). Code does the rest:
  1. for each course note (ai/rag: content, board, vhdl_ref, lab) the writer proposes student questions;
  2. each question is retrieved for exactly as the app does (Q&A mode: BM25 top 3, chat_server.ask_messages)
     and the writer answers from THAT prompt — the training row is the app's prompt, not the writer's;
  3. code filters (Thai, length, no Chinese / <think> / markdown headings, board facts not contradicted),
     then both judges score correctness / relevance / Thai / brevity; a row is kept only when both give correct = 5,
     every other score ≥ 4 and list no error. One note in ten is held out: its questions become eval tasks (eval_qamode.py).
Results are cached per note in RUN_DIR/cache, so a rerun continues where it stopped.
The key is read from the environment (OR_KEY) and never written anywhere.
"""
import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "ai"), str(ROOT / "ai" / "rag")]
import chat_server  # noqa: E402
import retriever  # noqa: E402

WRITER = "qwen/qwen3.5-397b-a17b"
JUDGES = ["deepseek/deepseek-v4-pro", "z-ai/glm-5.3"]   # two model families; a row needs both
# GLM-5.3 refuses requests with reasoning off (HTTP 400): it thinks briefly, so it needs room for that too
REASONING = {"z-ai/glm-5.3": ({"effort": "low"}, 2500)}
API = "https://openrouter.ai/api/v1/chat/completions"
# what the editor wraps a Q&A question in (the core's aiAsk, empty sheet, no earlier turns)
EDITOR_HEAD = "คุณคือผู้ช่วยออกแบบวงจรดิจิทัลในโปรแกรม Schematic Studio ตอบเป็นภาษาไทยสั้นๆ ตรงประเด็น"
PER_GROUP = {"content": 1.0, "board": 0.75, "vhdl_ref": 0.75, "lab": 0.75}   # × --per-chunk

Q_PROMPT = """You help build a Thai teaching assistant for a university course on digital logic (gates, Boolean algebra, K-maps, \
combinational blocks, flip-flops, counters, state machines, VHDL) taught with the EDGE Spartan-7 FPGA board.

Below is one note from the course material. Write {n} different questions that a Thai student might type into the \
assistant's chat about the topic of this note. Requirements:
- Thai as students really type it: short, casual, English technical terms kept (flip-flop, K-map, mux, clock…), some with \
  small typos or no spaces is fine; at most one question in English.
- Vary the kind: {kinds}.
- Each must be answerable correctly from standard digital-logic knowledge (the note may help). No question about page \
  numbers, figure numbers or the document itself. No request to draw/build a circuit.
- Each question stands alone: the student has shown nothing else — never "this circuit", "วงจรนี้", "แบบนี้", \
  "ตรงที่บอกว่า", "แล้ว…" pointing at earlier text, and never quote the note.
- Do not copy sentences from the note.

Return only JSON: {{"questions": [{{"q": "...", "kind": "..."}}]}}

NOTE ({source} · {topic}):
{text}"""
KINDS = ["คืออะไร / definition", "ทำไม / why it works or why it is needed", "compare two things", "how to do it step by step",
         "a small worked example with numbers", "a common misunderstanding to correct", "when to use it in a lab or on the board"]

STYLE = """

แนวการตอบ (สำหรับผู้เขียนคำตอบ):
- ถูกต้องตามหลักวิชาก่อนอย่างอื่น ถ้าบันทึกที่แนบมาไม่เกี่ยวหรือขัดกับหลักวิชา ให้ตอบตามหลักวิชาที่ถูกต้อง
- ตอบตรงคำถามในประโยคแรก แล้วอธิบายเหตุผลหรือยกตัวอย่างสั้นๆ ยาวราว 3–8 ประโยค หรือรายการสั้นๆ ไม่เกิน 6 ข้อ
- ภาษาไทยที่อ่านง่ายแบบอาจารย์อธิบายนักศึกษา คงศัพท์อังกฤษทางเทคนิคไว้
- ข้อความธรรมดาล้วน: ไม่ใช้ ** ตัวหนา, # หัวข้อ, ตาราง, $ สูตร LaTeX หรือ ``` — โค้ด VHDL สั้นๆ เขียนเป็นบรรทัดธรรมดาได้ สูตรเขียนแบบ y = a'b + ab'
- ไม่อ้างถึง "บันทึก" "เอกสาร" หรือเลขหน้า ไม่ขึ้นต้นด้วยการทวนคำถาม ไม่ปิดท้ายด้วยการชวนถามต่อ
- พูดถึงโหมด 'วาดวงจร' เฉพาะเมื่อคำถามขอให้วาด/สร้างวงจรจริงๆ และบอกแค่ให้สลับโหมด — ห้ามบอกว่าต้องพิมพ์คำไหน
- ใช้คำว่า "เสมอ" "แน่นอน" "ทุกกรณี" เฉพาะเมื่อจริงทุกกรณี ถ้าขึ้นกับแบบวงจร (เช่น ripple vs synchronous) ให้บอกว่าขึ้นกับอะไร
- ศัพท์: A − B → A = ตัวตั้ง, B = ตัวลบ; บอร์ดในวิชาเป็น I/O 3.3 V แต่ไอซี 74LS บนชุดทดลองใช้ 5 V
- ตัวเลข การคำนวณ และตารางค่าความจริงต้องคิดให้ถูกทุกตัว ถ้าไม่แน่ใจรายละเอียดเฉพาะของบอร์ดหรือแลป ให้ตอบเฉพาะส่วนที่แน่ใจ"""

J_PROMPT = """You are checking answers written for Thai university students in a digital logic course (EDGE Spartan-7 board: \
3.3 V I/O, 50 MHz clock on H11, 4-digit common-anode 7-segment with active-low a..g/dp/an, push buttons active-high, \
16 switches, 16 LEDs active-high, pb[0..4] = top, bottom, left, right, center button).

QUESTION:
{q}

SOURCE NOTE the question was written from (course textbook — its definitions are the course's):
{src}

COURSE NOTES the assistant was given (may be irrelevant or partial):
{notes}

ANSWER:
{a}

Score 1-5 each:
- correct: every technical statement is true (5 = no error at all; any wrong fact, wrong number, wrong truth value or \
  wrong board fact = 2 or less)
- relevant: answers what was asked, first sentence addresses it; suggesting the app's drawing mode when the student did not ask \
  to draw a circuit counts against this
- thai: natural, clear Thai a student understands (technical English terms are fine; a word from any other language, \
  stray symbols or typos = 3 or less)
- concise: no padding, no repetition, not missing the key point
Be strict. In "errors" list every factual error, every over-generalization stated as always true ("always", "เสมอ", \
"แน่นอน") that is false for common cases, every statement about what to type in the app or what the app can do, and \
anything that answers a different question, and any definition that contradicts the SOURCE NOTE (empty list if none). Return only JSON:
{{"correct": n, "relevant": n, "thai": n, "concise": n, "errors": ["..."]}}"""


class OR:
    def __init__(self, key):
        self.key, self.lock, self.spent = key, threading.Lock(), {"calls": 0, "in": 0, "out": 0, "fail": 0, "usd": 0.0}

    def chat(self, model, messages, temperature=0.7, max_tokens=900, tries=4):
        reasoning, room = REASONING.get(model, ({"enabled": False}, 0))
        body = json.dumps({"model": model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens + room,
                           "reasoning": reasoning}).encode()
        for k in range(tries):
            try:
                req = urllib.request.Request(API, data=body, headers={"Authorization": "Bearer " + self.key,
                                                                      "Content-Type": "application/json",
                                                                      "X-Title": "digital-fpga-ecosystem dataset"})
                with urllib.request.urlopen(req, timeout=180) as r:
                    d = json.loads(r.read().decode())
                u = d.get("usage") or {}
                with self.lock:
                    self.spent["calls"] += 1
                    self.spent["in"] += u.get("prompt_tokens", 0)
                    self.spent["out"] += u.get("completion_tokens", 0)
                    self.spent["usd"] = round(self.spent["usd"] + float(u.get("cost") or 0), 4)
                txt = d["choices"][0]["message"].get("content") or ""
                return re.sub(r"<think>.*?</think>", "", txt, flags=re.S).strip()
            except urllib.error.HTTPError as e:
                with self.lock:
                    self.spent["fail"] += 1
                if 400 <= e.code < 500 and e.code != 429:      # the request itself is wrong: retrying will not help
                    print(f"{model}: HTTP {e.code} {e.read()[:200]!r}", file=sys.stderr, flush=True)
                    return None
                time.sleep(2 * 2 ** k)
            except Exception:
                with self.lock:
                    self.spent["fail"] += 1
                time.sleep(2 * 2 ** k)
        return None


def first_json(t):
    if not t:
        return None
    t = re.sub(r"^```(?:json)?|```$", "", t.strip(), flags=re.M)
    m = re.search(r"\{.*\}", t, flags=re.S)
    try:
        return json.loads(m.group(0)) if m else None
    except Exception:
        return None


def retrieve(r, q):
    """The app's Q&A retrieval (launcher rag_search, keyword mode) — same hits, same fields."""
    out = []
    for h in r.search(chat_server.ask_query(q), k=chat_server.ASK_NOTES_K, hybrid=False, prefer_verified=False):
        rec = r.docs[r.id2row[h["id"]]]
        out.append({"title": rec.get("title", ""), "group": rec["group"], "source": rec.get("source", ""),
                    "topic": rec.get("topic") or "", "text": (rec.get("text") or "")[:1500]})
    return out


def payload(q):
    return f"{EDITOR_HEAD}\n\n[คำถาม/คำสั่งล่าสุด]\n{q}"


BAD = [  # board facts the answers must not contradict (from _ASK_SYS) — a cheap check before the judge
    (re.compile(r"(I/?O|แรงดัน|ไฟเลี้ยง)[^\n]{0,30}\b5\s*V", re.I), "5 V I/O"),
    (re.compile(r"common[ -]?cathode", re.I), "common cathode display"),
]


Q_CONTEXT = re.compile(r"(วงจรนี้|แบบนี้|อันนี้|ตัวนี้|ตรงที่บอก|ที่บอกว่า|ในโน้ต|ในเอกสาร|ในตาราง(นี้|ข้างบน)|ข้างบน|ข้อนี้|^แล้ว|^แล้วก็|\bthis (circuit|note|table)\b)", re.I)


DRAW_ASK = re.compile(r"(วาด|สร้างวงจร|ออกแบบวงจร|ทำวงจร|ต่อวงจร|\bdraw\b|\bbuild\b)", re.I)


def strip_draw_hint(q, a):
    """'…สลับไปโหมด วาดวงจร…' tacked on when the student did not ask for a circuit: the sentence goes."""
    if DRAW_ASK.search(q) or "วาดวงจร" not in a:
        return a
    parts = re.split(r"(?<=[\n])|(?<=\s)(?=หาก|ถ้า)", a)
    keep = [p for p in parts if "วาดวงจร" not in p]
    out = "".join(keep).strip()
    return re.sub(r"^(อย่างไรก็ตาม|แต่|และ|ส่วน)\s*,?\s*", "", out).strip()


def code_check(a):
    if not a:
        return "empty"
    if re.search(r"[一-鿿぀-ヿ]", a):
        return "Chinese/Japanese text"
    if re.search(r"[\u0400-\u04ff\u0600-\u06ff\u0900-\u097f\uac00-\ud7af]", a):
        return "another script (Cyrillic / Arabic / Devanagari / Korean)"
    if re.search(r"([\u0e31\u0e34-\u0e3a\u0e47-\u0e4e])\1|[\u0e48-\u0e4b]{2}", a):
        return "Thai typo (a mark written twice)"
    if re.search(r"[\u0e00-\u0e7f][_][A-Za-z]|[\u0e00-\u0e7f]-[A-Za-z]+-[\u0e00-\u0e7f]", a):
        return "stray _ / - glued to a word"
    if a[0] in ",.;:)":
        return "starts mid-sentence"
    if "<think>" in a or re.search(r"^#{1,6}\s", a, flags=re.M) or re.search(r"^\|.*\|$", a, flags=re.M):
        return "think tag / heading / table"
    if "**" in a or "```" in a or re.search(r"\$[^$\n]+\$", a):
        return "markdown (the chat shows plain text)"
    thai = len(re.findall(r"[฀-๿]", a))
    if thai < 0.35 * len(re.sub(r"\s", "", a)):
        return "not mostly Thai"
    if not 60 <= len(a) <= 1600:
        return f"length {len(a)}"
    if re.search(r"(ตาม|ใน|จาก)(บันทึก|เอกสาร)(ที่แนบ|นี้)?|หน้า(ที่)?\s*\d+|((?<!ขีด)ด้านบน|(?<!ขีด)ข้างบน|ข้างต้น|ที่แนบมา)", a):
        return "cites the notes"
    for rx, why in BAD:
        if rx.search(a) and "ไม่ใช่" not in a:
            return why
    return None


def judge(api, row, q, a, hits, rec):
    """Both judges, the second only when the first passes; sets row["drop"] on a fail. A judge that does not
    answer (network, credits) raises — the note is then not cached and is tried again on the next run."""
    notes = chat_server.ask_notes_block(hits) or "(none)"
    src = re.sub(r"\s+", " ", rec.get("text") or "")[:2000]
    row["judge"] = {}
    for jm in JUDGES:
        raw = api.chat(jm, [{"role": "user", "content": J_PROMPT.format(q=q, notes=notes, a=a, src=src)}], temperature=0.0, max_tokens=800)
        if raw is None:
            raise RuntimeError(f"{jm} did not answer")
        j = first_json(raw)
        row["judge"][jm] = j
        try:
            sc = [int(j[k]) for k in ("correct", "relevant", "thai", "concise")]
        except Exception:
            row["drop"] = f"judge {jm}: no scores"
            return
        errs = [e for e in (j.get("errors") or []) if str(e).strip()]
        if sc[0] < 5 or min(sc) < 4 or errs:
            row["drop"] = f"judge {jm}: {sc} {errs[:2]}"
            return
    row["src_seen"] = True


def do_chunk(api, r, rec, n, held):
    raw = api.chat(WRITER, [{"role": "user", "content": Q_PROMPT.format(
        n=n, kinds=", ".join(random.Random(rec["id"]).sample(KINDS, min(len(KINDS), n + 1))), source=rec.get("source", ""),
        topic=rec.get("topic") or rec.get("title", ""), text=(rec.get("text") or "")[:2500])}], temperature=0.9, max_tokens=900)
    if raw is None:
        raise RuntimeError("writer did not answer")
    qs = first_json(raw)
    qs = [x for x in ((qs or {}).get("questions") or []) if isinstance(x, dict) and isinstance(x.get("q"), str)]
    out = []
    for x in qs[:n]:
        q = re.sub(r"\s+", " ", x["q"]).strip()
        if not 4 <= len(q) <= 200 or Q_CONTEXT.search(q):   # points at something the student never showed
            continue
        hits = retrieve(r, q)
        msgs = chat_server.ask_messages(payload(q), hits)
        wmsgs = [{"role": "system", "content": chat_server._ASK_SYS + STYLE}, msgs[1]]
        a = api.chat(WRITER, wmsgs, temperature=0.4, max_tokens=700)
        if a is None:
            raise RuntimeError("writer did not answer")
        a = strip_draw_hint(q, (a or "").strip()).strip()
        why = code_check(a)
        row = {"q": q, "kind": x.get("kind", ""), "a": a, "chunk": rec["id"], "hits": [h["source"] + " · " + h["topic"] for h in hits],
               "held": held}
        if why:
            row["drop"] = "code: " + why
            out.append(row)
            continue
        judge(api, row, q, a, hits, rec)
        row["messages"] = msgs + [{"role": "assistant", "content": a}]
        out.append(row)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--per-chunk", type=int, default=4)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0, help="only this many notes (a trial run)")
    ap.add_argument("--groups", default="content,board,vhdl_ref,lab")
    ap.add_argument("--seed", type=int, default=21)
    ap.add_argument("--computed", default=None, help="gen_qa.py tasks: their questions + program answers in the Q&A-mode prompt (no model)")
    ap.add_argument("--computed-only", action="store_true", help="only the --computed rows (no OpenRouter calls)")
    ap.add_argument("--cached-only", action="store_true", help="write out what the cache holds (no OpenRouter calls)")
    ap.add_argument("--recheck", action="store_true", help="judge again, with the source note in view, kept rows judged without it")
    ap.add_argument("--max-usd", type=float, default=0, help="stop starting new notes once this run has spent this much")
    a = ap.parse_args()
    key = os.environ.get("OR_KEY", "").strip()
    if not key and not (a.computed_only or a.cached_only):
        sys.exit("OR_KEY is not set")
    api, r = OR(key), retriever.Retriever()
    out, cache = Path(a.out), Path(a.out) / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    groups = a.groups.split(",")
    recs = [d for d in r.docs if d["group"] in groups and len((d.get("text") or "").strip()) > 120]
    random.Random(a.seed).shuffle(recs)
    if a.limit:
        recs = recs[:a.limit]
    if a.computed_only:
        recs = []
    if a.cached_only and not a.recheck:
        recs = [d for d in recs if (cache / (hashlib.sha1(d["id"].encode()).hexdigest()[:16] + ".json")).exists()]

    def held(rec):  # one note in ten: its questions are eval tasks only
        return int(hashlib.sha1(rec["id"].encode()).hexdigest(), 16) % 10 == 0

    def over():
        return a.max_usd and api.spent["usd"] >= a.max_usd

    def job(rec):
        f = cache / (hashlib.sha1(rec["id"].encode()).hexdigest()[:16] + ".json")
        if f.exists():
            rows = json.loads(f.read_text(encoding="utf-8"))
            todo = [x for x in rows if a.recheck and "drop" not in x and not x.get("src_seen")]
            if todo and not over():
                try:
                    for x in todo:
                        judge(api, x, x["q"], x["a"], retrieve(r, x["q"]), rec)
                except Exception as e:
                    print(f"recheck stopped: {e}", file=sys.stderr, flush=True)
                    return rows                          # not saved: tried again next time
                f.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
            return rows
        if a.cached_only or over():
            return []
        n = max(1, round(a.per_chunk * PER_GROUP.get(rec["group"], 1.0)))
        try:
            rows = do_chunk(api, r, rec, n, held(rec))
        except Exception as e:
            print(f"note {rec['id']} not finished: {e}", file=sys.stderr, flush=True)
            return []
        f.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        return rows

    rows, t0 = [], time.time()
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for i, res in enumerate(ex.map(job, recs), 1):
            rows += res
            if i % 10 == 0 or i == len(recs):
                kept = sum(1 for x in rows if "drop" not in x)
                print(f"[{i}/{len(recs)}] questions {len(rows)} kept {kept}  {api.spent}  {time.time() - t0:.0f}s", file=sys.stderr, flush=True)
    seen, train, ev, dropped = set(), [], [], {}
    for x in rows:
        k = re.sub(r"\W+", "", x["q"].lower())
        if k in seen:
            dropped["duplicate question"] = dropped.get("duplicate question", 0) + 1
            continue
        seen.add(k)
        if "drop" not in x and code_check(x["a"]):      # filters added after a note was cached apply too
            x["drop"] = "code: " + code_check(x["a"])
        if "drop" in x:
            key_ = x["drop"].split(":")[0] + ": " + (x["drop"].split(":", 1)[1].split("[")[0].strip() if x["drop"].startswith("code") else "score < 4 or error")
            dropped[key_] = dropped.get(key_, 0) + 1
            continue
        if x["held"]:
            ev.append({"id": "qamode-eval-%05d" % len(ev), "cat": "qa_mode", "split": "eval", "message": x["q"], "kind": x["kind"],
                       "reference": x["a"], "chunk": x["chunk"]})
        else:
            train.append({"id": "qamode-%05d" % len(train), "cat": "qa_mode",
                          "source": f"open model {WRITER} (Apache-2.0) via OpenRouter, judged by {' + '.join(JUDGES)}, filtered by code",
                          "tools_ref": None, "messages": x["messages"],
                          "meta": {"kind": x["kind"], "chunk": x["chunk"], "judge": x["judge"]}})
    if a.computed:   # numbers worked out by gen_qa.py — the answer is the program's
        for t in (json.loads(l) for l in open(a.computed, encoding="utf-8") if l.strip()):
            k = re.sub(r"\W+", "", t["message"].lower())
            if k in seen:
                continue
            seen.add(k)
            if t.get("split") == "eval":
                ev.append({"id": "qamode-eval-%05d" % len(ev), "cat": "qa_mode", "split": "eval", "message": t["message"],
                           "kind": "computed", "reference": t["answer"], "check": t.get("check")})
            else:
                msgs = chat_server.ask_messages(payload(t["message"]), retrieve(r, t["message"]))
                train.append({"id": "qamode-%05d" % len(train), "cat": "qa_mode", "source": "program (tools/dataset/gen_qa.py) in the Q&A-mode prompt",
                              "tools_ref": None, "messages": msgs + [{"role": "assistant", "content": t["answer"]}],
                              "meta": {"kind": "computed", "task": t["id"]}})
    with open(out / "train.jsonl", "w", encoding="utf-8") as f:
        for t in train:
            f.write(json.dumps(t, ensure_ascii=False) + "\n")
    with open(out / "eval_qamode.jsonl", "w", encoding="utf-8") as f:
        for t in ev:
            f.write(json.dumps(t, ensure_ascii=False) + "\n")
    rep = {"notes": len(recs), "questions": len(rows), "train": len(train), "eval": len(ev), "dropped": dropped, "api": api.spent}
    (out / "report.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(rep, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
