#!/usr/bin/env python3
"""The teacher: stands in for llama-server while run.js drives the app's real agent loop.

The launcher starts it exactly like llama-server (`-m <model> --host … --port …`), and the editor's
agent mode talks to it through /api/llm/chat — so the conversation it sees (system prompt, tool
schemas, tool results, the app's own nudges) is byte for byte what a real model sees. It answers
from the task's known meaning (gen_*.py), never from a model: every word of the training data is
written by this program.

When a run ends (it answers without a tool call) it writes the whole conversation to
$FE_TEACHER_DIR/raw/<task id>.json. Tasks are looked up by the user's message in
$FE_TEACHER_DIR/tasks.jsonl.
"""
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

DIR = os.environ.get("FE_TEACHER_DIR") or os.path.dirname(os.path.abspath(sys.argv[0]))
TASKS = {}
try:
    with open(os.path.join(DIR, "tasks.jsonl"), encoding="utf-8") as f:
        for line in f:
            if line.strip():
                t = json.loads(line)
                TASKS[t["message"]] = t
except FileNotFoundError:
    pass
os.makedirs(os.path.join(DIR, "raw"), exist_ok=True)

JOIN_WORD = {"and": "และ", "or": "หรือ"}


# ---- nl_logic: a described function → spec + build from the same equations ----------------------
def logic_sheet(t):
    return t["use_sheet"]


def logic_plan(t):
    """The reasoning for the first turn: phrase → expression, then the equation."""
    lines = []
    for o in t.get("outputs") or [t]:
        lines.append(f"{o['out']}: โจทย์บอกว่าเป็น {'0' if o['negated'] else '1'} เมื่อไร แปลทีละเงื่อนไข:")
        lines += [f"- “{p}” → {e}" for p, e in o["readings"]]
        lines.append(f"เงื่อนไขเชื่อมด้วย “{JOIN_WORD[o['top']]}” → {'&' if o['top'] == 'and' else '|'}")
        if o["negated"]:
            lines.append(f"โจทย์บอกตอนที่ {o['out']} เป็น 0 → กลับค่าทั้งก้อนด้วย ~( … )")
    lines.append("สมการ: " + t["formula"])
    lines.append(f"ตั้ง spec จากคำขอก่อน แล้วสร้างจากสมการเดียวกันบนแผ่น {logic_sheet(t)}")
    return "\n".join(lines)


def logic_build(t, mistake=None):
    args = {"sheet": logic_sheet(t), "formula": t["formula"]}
    if mistake == "extra_field":
        args["description"] = t["message"][:60]
    elif mistake == "no_lhs":
        args["formula"] = "; ".join(e.split("=", 1)[1].strip() for e in t["formula"].split(";"))
    elif mistake == "thai_ops":
        args["formula"] = t["formula"].replace(" & ", " และ ", 1) if " & " in t["formula"] else t["formula"].replace(" | ", " หรือ ", 1)
    return ("build_circuit", args)


def logic_first(t):
    return [("set_spec", {"sheet": logic_sheet(t), "formula": t["formula"]}), logic_build(t, t.get("mistake"))]


FIX_WHY = {
    "extra_field": "build_circuit ไม่มีช่อง description — ตัดออก ส่งแค่ sheet กับ formula",
    "no_lhs": "formula ต้องเป็นสมการ ‘ชื่อขาออก = นิพจน์’ — ใส่ชื่อขาออกนำหน้า",
    "thai_ops": "ในสมการต้องใช้ตัวดำเนินการ & | ^ ~ ไม่ใช่คำไทย — เปลี่ยน ‘และ’ เป็น & / ‘หรือ’ เป็น |",
}


def logic_answer(t, results):
    s = logic_sheet(t)
    build = next((r for n, r in reversed(results) if n == "build_circuit" and isinstance(r, dict)), {}) or {}
    eqs = build.get("equations") or {}
    sc = build.get("spec_check") or {}
    lines = [f"สร้างวงจรบนแผ่น {s} แล้ว", "อ่านโจทย์เป็นสมการ: " + t["formula"]]
    outs = t.get("outputs") or [t]
    for o in outs:
        if len(outs) > 1:
            lines.append(f"{o['out']}:")
        lines += [f"- “{p}” → {e}" for p, e in o["readings"]]
        if o["negated"]:
            lines.append(f"- โจทย์บอกตอนที่ {o['out']} เป็น 0 จึงกลับค่าทั้งหมด")
    got = [f"{o['out']} = {eqs[o['out']]}" for o in outs if eqs.get(o["out"])]
    if got:
        lines.append("วงจรที่ได้หลังลดรูป: " + "; ".join(got))
    if sc.get("pass") is True:
        lines.append(f"ตรวจกับข้อกำหนดที่ตั้งจากคำขอ: ผ่านครบ {sc.get('checked') or ''}".rstrip())
    lines.append("ถ้าโจทย์ตั้งใจต่างจากสมการข้างบน บอกได้เลย จะแก้ให้")
    return "\n".join(lines)


# ---- nl_fsm: a sequence detector → acceptance test from the reference + the diagram -----------------
def fsm_sheet(t):
    return t["use_sheet"]


def fsm_plan(t):
    p, n, x, z = t["pattern"], len(t["pattern"]), t["x"], t["z"]
    lines = [f"ตรวจจับ {p} ({n} บิต) แบบ {'Moore' if t['kind'] == 'moore' else 'Mealy'}, "
             f"{'ซ้อนทับได้' if t['overlap'] else 'ไม่ซ้อนทับ (เจอแล้วเริ่ม S0 ใหม่)'}",
             "แต่ละ state = ส่วนต้นของลำดับที่เจอมาแล้ว:"]
    lines += [f"- {k}: {v}" for k, v in t["meaning"].items()]
    if t["kind"] == "moore":
        lines.append(f"Moore: {z}=1 เฉพาะใน S{n} (เห็นผลหลัง clock ที่บิตสุดท้ายเข้า)")
    else:
        lines.append(f"Mealy: {z}=1 บนลูกศรที่บิตสุดท้ายเข้ามาตอนอยู่ S{n-1} (ใน clock เดียวกัน)")
    lines.append("เมื่อบิตไม่ตรง ย้ายไป state ของส่วนต้นที่ยาวที่สุดที่ยังตรงอยู่")
    xs = "".join(str(v[x]) for v in t["test"]["inputs"])
    lines.append(f"ข้อกำหนดตรวจ: ป้อน {x} = {xs} แล้ว {z} ต้องเป็น {''.join(map(str, t['test']['expect'][z]))}")
    return "\n".join(lines)


def fsm_first(t):
    s = fsm_sheet(t)
    return [("set_spec", {"sheet": s, "sequence": t["test"]}), ("build_fsm", {"sheet": s, "fsm": t["fsm"]})]


def fsm_answer(t, results):
    s = fsm_sheet(t)
    b = next((r for n, r in reversed(results) if n == "build_fsm" and isinstance(r, dict)), {}) or {}
    sc = b.get("spec_check") or {}
    lines = [f"สร้างวงจรตรวจจับ {t['pattern']} แบบ {'Moore' if t['kind'] == 'moore' else 'Mealy'} บนแผ่น {s} แล้ว "
             f"({'ซ้อนทับได้' if t['overlap'] else 'ไม่ซ้อนทับ'})", "state:"]
    lines += [f"- {k}: {v}" for k, v in t["meaning"].items()]
    enc = b.get("encoding")
    if isinstance(enc, list) and enc:
        lines.append("รหัส state: " + ", ".join(f"{e.get('state')}={e.get('code')}" for e in enc if isinstance(e, dict)))
    if b.get("flip_flops"):
        lines.append(f"ใช้ D flip-flop {b['flip_flops']} ตัว")
    if sc.get("pass") is True:
        lines.append(f"ตรวจกับลำดับทดสอบที่ตั้งจากโจทย์: ผ่านครบ {sc.get('checked') or ''}".rstrip())
    return "\n".join(lines)


# ---- nl_pins: switches / buttons / LEDs named in the request → set_pins, then check the sheet ------
PB_NAME = ["บน", "ล่าง", "ซ้าย", "ขวา", "กลาง"]


def pin_label(v):
    k, _, i = v.partition(":")
    return {"sw": f"SW{i}", "led": f"LED{i}", "pb": f"ปุ่ม{PB_NAME[int(i)] if i.isdigit() and int(i) < 5 else i}"}.get(k, v)


def pins_plan(t):
    lines = ["ขาที่โจทย์ระบุ → เป้าหมายบนบอร์ด (set_pins ใช้รูปแบบ sw:N / led:N / pb:N):"]
    lines += [f"- {k} → {pin_label(v)} = \"{v}\"" for k, v in t["map"].items()]
    lines.append(f"ตั้งทั้งหมดในครั้งเดียวบนแผ่น {t['use_sheet']} แล้วตรวจว่าวงจรยังผ่านข้อกำหนดและขาไม่ซ้ำกัน")
    return "\n".join(lines)


def pins_answer(t, results):
    bc = next((r for n, r in reversed(results) if n == "board_check" and isinstance(r, dict)), {}) or {}
    sc = next((r for n, r in reversed(results) if n == "check_spec" and isinstance(r, dict)), {}) or {}
    lines = [f"ตั้งขาบอร์ดของแผ่น {t['use_sheet']} แล้ว:"]
    lines += [f"- {k} → {pin_label(v)}" for k, v in t["map"].items()]
    if sc.get("pass") is True:
        lines.append(f"วงจรยังผ่านข้อกำหนดเดิมครบ {sc.get('checked') or ''}".rstrip())
    probs = bc.get("problems") or bc.get("issues") or []
    if isinstance(probs, list) and probs:
        lines.append("หมอบอร์ดเตือน: " + "; ".join(str(p.get("message") if isinstance(p, dict) else p) for p in probs[:3]))
    else:
        lines.append("ทุกขามีขาบนบอร์ดแล้วและไม่ซ้ำกัน — ไปหน้า ลงบอร์ด เพื่อ build ได้เลย")
    return "\n".join(lines)


# ---- nl_fix: a wrong circuit on the sheet → spec from the request, read the mismatches, rebuild ------
def mism_lines(r, k=3):
    res = r.get("result") if isinstance(r.get("result"), dict) else r
    out, names = [], res.get("inputs") or []
    for m in (res.get("mismatches") or [])[:k]:
        if isinstance(m, dict):
            bits = str(m.get("inputs", ""))
            where = " ".join(f"{n}={b}" for n, b in zip(names, bits)) if len(names) == len(bits) else bits
            out.append(f"- {where} → ควรได้ {m.get('output', '')}={m.get('want')} แต่ได้ {m.get('got')}")
    return out, res.get("total_mismatches"), res.get("pass")


def fix_plan(t):
    lines = [f"โจทย์บอกว่า {t['out']} เป็น 1 เมื่อไร แปลทีละเงื่อนไข:"]
    lines += [f"- “{p}” → {e}" for p, e in t["readings"]]
    lines.append(f"เงื่อนไขเชื่อมด้วย “{JOIN_WORD[t['top']]}” → {'&' if t['top'] == 'and' else '|'}")
    lines.append("สมการที่ถูก: " + t["formula"])
    lines.append(f"ตั้งเป็น spec ของแผ่น {t['use_sheet']} ก่อน แล้วดูว่าวงจรที่มีอยู่ผิดกี่แถว แถวไหน")
    return "\n".join(lines)


def fix_then(t, results):
    r = next((r for n, r in reversed(results) if n == "set_spec" and isinstance(r, dict)), {}) or {}
    ml, total, ok = mism_lines(r)
    if ok is not False:
        return None
    why = [f"วงจรเดิมไม่ตรงโจทย์ {total} จาก {t['rows']} แถว เช่น", *ml,
           f"สร้างใหม่จากสมการที่ถูกบนแผ่นเดิม (replace:true) — spec ตั้งไว้แล้วจะตรวจให้เอง"]
    return {"content": "", "reasoning_content": "\n".join(why),
            "tool_calls": [("build_circuit", {"sheet": t["use_sheet"], "formula": t["formula"], "replace": True})]}


def fix_answer(t, results):
    r = next((r for n, r in results if n == "set_spec" and isinstance(r, dict)), {}) or {}
    ml, total, _ = mism_lines(r)
    b = next((r for n, r in reversed(results) if n == "build_circuit" and isinstance(r, dict)), {}) or {}
    sc, eqs = b.get("spec_check") or {}, b.get("equations") or {}
    lines = [f"วงจรเดิมบนแผ่น {t['use_sheet']} ให้ผลผิด {total} จาก {t['rows']} แถว เช่น", *ml,
             "สมการที่โจทย์ต้องการ: " + t["formula"]]
    lines += [f"- “{p}” → {e}" for p, e in t["readings"]]
    lines.append("แก้โดยสร้างวงจรใหม่บนแผ่นเดิมจากสมการนี้" + (f" (ลดรูปแล้ว {t['out']} = {eqs[t['out']]})" if eqs.get(t["out"]) else ""))
    if sc.get("pass") is True:
        lines.append(f"ตอนนี้ตรวจกับข้อกำหนดจากโจทย์ผ่านครบ {sc.get('checked') or ''}".rstrip())
    return "\n".join(lines)


# ---- nl_compose: N × part → one build_hierarchy with every wire --------------------------------------
def compose_plan(t):
    p = t["plan"]
    par = lambda b: "(" + ", ".join(f"{k}={v}" for k, v in b["params"].items()) + ")" if b.get("params") else ""
    lines = list(t["why"]) + ["บล็อก: " + ", ".join(f"{b['name']}={b['part']}{par(b)}" for b in p["blocks"]),
                              f"ขาบนสุด: เข้า {', '.join(p['inputs'])} · ออก {', '.join(p['outputs'])}"]
    return "\n".join(lines)


def compose_answer(t, results):
    b = next((r for n, r in reversed(results) if n == "build_hierarchy" and isinstance(r, dict)), {}) or {}
    sc = b.get("spec_check") or {}
    p = t["plan"]
    lines = [f"ต่อเป็นวงจรบนแผ่น {t['use_sheet']} แล้ว ด้วย " + ", ".join(f"{x['name']} ({x['part']}{' n=' + str(x['params']['n']) if x.get('params') else ''})" for x in p["blocks"])]
    lines += [f"- {w}" for w in t["why"][:2]]
    lines.append(f"ขาเข้า {', '.join(p['inputs'])} · ขาออก {', '.join(p['outputs'])} · ต่อสายทั้งหมด {len(p['connect'])} จุดในครั้งเดียว")
    if sc.get("pass") is True:
        lines.append(f"ตรวจเทียบกับโมเดลอ้างอิงของชิ้นส่วนที่โจทย์ต้องการ: ผ่าน ({sc.get('checked') or ''})".replace(" ()", ""))
    return "\n".join(lines)


CATS = {
    "nl_logic": {"sheet": logic_sheet, "plan": logic_plan, "first": logic_first, "answer": logic_answer,
                 "fix": lambda t: [logic_build(t)]},
    "nl_fsm": {"sheet": fsm_sheet, "plan": fsm_plan, "first": fsm_first, "answer": fsm_answer},
    "nl_pins": {"sheet": lambda t: t["use_sheet"], "plan": pins_plan,
                "first": lambda t: [("set_pins", {"sheet": t["use_sheet"], "map": t["map"]})],
                "then": lambda t: [("check", {"sheet": t["use_sheet"]}), ("check_spec", {"sheet": t["use_sheet"]}),
                                   ("board_check", {"sheet": t["use_sheet"]})],
                "answer": pins_answer},
    "nl_fix": {"sheet": lambda t: t["use_sheet"], "plan": fix_plan,
               "first": lambda t: [("set_spec", {"sheet": t["use_sheet"], "formula": t["formula"]})],
               "dynamic": fix_then, "answer": fix_answer},
    "nl_compose": {"sheet": lambda t: t["use_sheet"], "plan": compose_plan,
                   "first": lambda t: [("build_hierarchy", t["plan"])], "answer": compose_answer},
    "qa": {"direct": True, "sheet": lambda t: None, "answer": lambda t, r: t["answer"]},
}


# ---- the conversation ---------------------------------------------------------------------------
def tool_results(msgs):
    """(tool name, parsed result or the error text) for every tool answer so far, in order."""
    names = {}
    for m in msgs:
        for c in m.get("tool_calls") or []:
            names[c.get("id")] = c["function"]["name"]
    out = []
    for m in msgs:
        if m.get("role") == "tool":
            txt = m.get("content") or ""
            try:
                val = json.loads(txt)
            except Exception:
                val = txt
            out.append((names.get(m.get("tool_call_id"), "?"), val))
    return out


def after_ask(msgs):
    """The messages after the user's request (the chat history before it — the editor's greeting —
    is not this run's)."""
    for i, m in enumerate(msgs):
        if m.get("role") == "user" and not str(m.get("content")).startswith("(system)"):
            return msgs[i + 1:]
    return msgs


def respond(req):
    msgs = req.get("messages") or []
    if not req.get("tools"):                   # Q&A / build mode: not ours
        return {"content": "(teacher) no task"}
    ask = next((m.get("content") or "" for m in msgs if m.get("role") == "user"
                and not str(m.get("content")).startswith("(system)")), "")
    t = TASKS.get(ask)
    if not t:
        return {"content": "(teacher) unknown task"}
    C = CATS[t["cat"]]
    since = after_ask(msgs)
    done = tool_results(since)
    turns = sum(1 for m in since if m.get("role") == "assistant")
    last = msgs[-1] if msgs else {}
    errors = [r for _, r in done if isinstance(r, str) and r.startswith("ERROR")]
    if turns == 0:
        if C.get("direct"):                   # a question: answered without tools
            return {"content": C["answer"](t, []), "_final": True}
        return {"content": "", "reasoning_content": C["plan"](t), "tool_calls": C["first"](t)}
    # the planned mistake came back as an error: read it, correct the call (once)
    if errors and t.get("mistake") and len(errors) == 1 and turns == 1:
        err = errors[0].splitlines()[0][:160]
        return {"content": "", "reasoning_content": f"{err}\n→ {FIX_WHY[t['mistake']]}", "tool_calls": C["fix"](t)}
    if errors and not (t.get("mistake") and len(errors) == 1):
        return {"content": "(teacher) FAILED: a tool returned an error: " + errors[-1][:200], "_fail": True}
    # a second step that depends on what came back (fix: rebuild after reading the mismatches), once
    if C.get("dynamic") and turns == 1:
        d = C["dynamic"](t, done)
        if d is None:
            return {"content": "(teacher) FAILED: the circuit was not wrong", "_fail": True}
        return d
    # a fixed second step (pins: check the sheet after changing it), once
    if C.get("then") and turns == 1:
        return {"content": "", "tool_calls": C["then"](t)}
    nudge = last.get("role") == "user" and str(last.get("content", "")).startswith("(system)")
    if nudge and "did not verify" in last["content"] and turns < 4:
        s = C["sheet"](t)
        return {"content": "", "tool_calls": [("check", {"sheet": s}), ("simulate", {"sheet": s})]}
    if turns > 5:
        return {"content": "(teacher) FAILED: too many turns", "_fail": True}
    return {"content": C["answer"](t, done), "_final": True}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _j(self, o):
        b = json.dumps(o, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        self._j({"status": "ok"})

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path.startswith("/v1/embeddings"):
            return self._j({"error": "no embeddings"})
        try:
            r = respond(req)
        except Exception as e:                   # never hang the run: answer, and mark it failed
            r = {"content": f"(teacher) FAILED: {type(e).__name__}: {e}", "_fail": True}
        msgs = req.get("messages") or []
        n = sum(1 for m in msgs if m.get("role") == "tool")
        calls = [{"id": f"call_{n}_{i}", "type": "function",
                  "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}
                 for i, (name, args) in enumerate(r.get("tool_calls") or [])]
        msg = {"role": "assistant", "content": r.get("content", "")}
        if r.get("reasoning_content"):
            msg["reasoning_content"] = r["reasoning_content"]
        if calls:
            msg["tool_calls"] = calls
        # the teacher's own turns, kept per task (the app rewrites the first one's content later)
        ask = next((m.get("content") or "" for m in msgs if m.get("role") == "user"
                    and not str(m.get("content")).startswith("(system)")), "")
        t = TASKS.get(ask)
        if t:
            path = os.path.join(DIR, "raw", re.sub(r"[^\w.-]", "_", t["id"]) + ".json")
            prev = {}
            if os.path.exists(path) and any(m.get("role") == "assistant" for m in after_ask(msgs)):
                with open(path, encoding="utf-8") as f:
                    prev = json.load(f)
            turns = prev.get("turns", []) + [msg]
            rec = {"id": t["id"], "turns": turns, "done": bool(r.get("_final") or r.get("_fail")),
                   "failed": bool(r.get("_fail")), "requests": prev.get("requests", 0) + 1}
            if rec["done"]:
                rec["messages"] = msgs + [msg]
                rec["tools"] = req.get("tools")
                rec["request_options"] = {k: v for k, v in req.items() if k not in ("messages", "tools")}
            with open(path, "w", encoding="utf-8") as f:
                json.dump(rec, f, ensure_ascii=False)
        self._j({"choices": [{"message": msg, "finish_reason": "tool_calls" if calls else "stop"}],
                 "usage": {"prompt_tokens": 0, "completion_tokens": 0}})


if __name__ == "__main__":
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8080
    HTTPServer(("127.0.0.1", port), H).serve_forever()
