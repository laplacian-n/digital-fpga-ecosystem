"""
intent_client.py — turn a natural-language circuit spec into a validated
Intent-JSON topology, using a local LLM behind an OpenAI-compatible endpoint.

Design (locked, see memory project-architecture-decisions §2):
  - Engine-agnostic: talks to any OpenAI-compatible /v1/chat/completions
    (llama.cpp `llama-server`, or Ollama, or llama-cpp-python's server).
  - Grammar-constrained decoding (GBNF) is the strongest anti-hallucination
    lever for a small model — passed as the `grammar` extra field, which
    llama.cpp honours. Falls back gracefully if the engine ignores it.
  - validate -> retry loop: reuses intent_validate.validate_intent (mirror of
    the editor's ERC) and feeds the error hints back to the model.

No third-party deps: uses only stdlib urllib so it runs before any pip install.
The produced intent is handed to the editor's drawIntent()/autoRouteSheet()
(geometry is 100% deterministic there — this file never emits x/y/pts).
"""
from __future__ import annotations
import json
import os
import re
import urllib.request
import urllib.error
from pathlib import Path

from intent_validate import validate_intent, hints_for_retry

HERE = Path(__file__).resolve().parent
GRAMMAR_PATH = HERE / "grammar" / "intent.gbnf"
SYSTEM_PROMPT_PATH = HERE / "prompts" / "intent_system.md"

# RAG retriever is optional — only used if the index has been built.
_RETRIEVER = None
def _get_retriever():
    global _RETRIEVER
    if _RETRIEVER is None:
        try:
            import sys
            sys.path.insert(0, str(HERE / "rag"))
            from retriever import Retriever  # type: ignore
            _RETRIEVER = Retriever()
        except Exception:
            _RETRIEVER = False        # mark "unavailable" so we don't retry
    return _RETRIEVER or None


def retrieve_context(query: str, k: int = 6, *, prefer_vhdl: bool = False) -> str:
    """Verified-library-first context for a circuit request (empty if no index).
    prefer_vhdl=True (the VHDL->schematic codegen path) strongly prefers the curated,
    schematic-ready VHDL exemplars (group 'vhdl_ref'); otherwise labs/golden intents stay top."""
    r = _get_retriever()
    if not r:
        return ""
    from retriever import format_context  # type: ignore
    # vhdl_ref = engine-verified, schematic-ready VHDL. Default: modest (below golden labs 1.2)
    # so the intent path still gets labs first. VHDL path: crank it above everything.
    gb = ({"vhdl_ref": 2.2, "vhdl": 1.1, "lab": 1.0, "content": 0.9} if prefer_vhdl
          else {"lab": 1.2, "vhdl_ref": 1.15, "content": 1.0, "vhdl": 0.9})
    hits = r.search(query, k=k, prefer_verified=True, group_boost=gb)
    return format_context(hits, max_chars=3500)


def retrieve_exemplar(query: str) -> dict | None:
    """Find the most similar VERIFIED design that carries an intent_json (a golden
    lab item) — a worked example to few-shot the model with (verified-library-first).
    Returns {question, intent_json} or None."""
    # 1) precise textbook exemplar library (correct-by-construction, keyword-matched) —
    #    an IRRELEVANT exemplar misleads the model, so we want a real topical match first.
    try:
        from exemplars import find as _ex_find
        ex = _ex_find(query)
        if ex:
            return ex
    except Exception:
        pass
    # 2) curated lab corpus, but only when the hit actually shares a word with the query
    #    (the retriever otherwise returns the nearest intent-carrying lab regardless of topic).
    r = _get_retriever()
    if r:
        qtok = set(re.findall(r"[a-z]{3,}", query.lower())) | set(_THAI_TOK(query))
        for h in r.search(query, k=6, group="lab", prefer_verified=True):
            sol = (h.get("payload") or {}).get("solution") or {}
            ij = sol.get("intent_json")
            cand = ij if (isinstance(ij, dict) and "components" in ij) else (
                next((v for v in ij.values() if isinstance(v, dict) and "components" in v), None)
                if isinstance(ij, dict) else None)
            if not cand:
                continue
            title = (str((h.get("payload") or {}).get("question", "")) + " " +
                     str(h.get("topic", "")) + " " + str(h.get("title", ""))).lower()
            ttok = set(re.findall(r"[a-z]{3,}", title)) | set(_THAI_TOK(title))
            if qtok & ttok:                         # topical overlap -> relevant enough
                return {"question": (h.get("payload") or {}).get("question", ""), "intent_json": cand}
    return None


def _THAI_TOK(s):
    """Thai char 3-grams (crude relevance overlap for Thai queries/titles)."""
    import re as _re
    out = []
    for run in _re.findall(r"[฀-๿]+", s or ""):
        out += [run[i:i + 3] for i in range(max(1, len(run) - 2))]
    return out

# Endpoint is swappable via env so the hub can point at any engine.
DEFAULT_ENDPOINT = os.environ.get("AI_ENDPOINT", "http://127.0.0.1:8080/v1/chat/completions")
DEFAULT_MODEL = os.environ.get("AI_MODEL", "local")   # llama-server ignores the name


def _load(path: Path, fallback: str = "") -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return fallback


def _extract_json(text: str) -> dict | None:
    """Pull the first balanced {...} object out of the model's reply."""
    start = text.find("{")
    if start < 0:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except json.JSONDecodeError:
                        return None
    return None


def one_system_message(messages: list) -> list:
    """Qwen3.5's chat template refuses a second system message ("System message must be at the
    beginning" -> HTTP 500), and the RAG paths add the library context as one. Fold every system
    message into the first, keeping a trailing /no_think switch last."""
    if not messages:
        return messages
    sys_parts = [m.get("content") or "" for m in messages if m.get("role") == "system"]
    if not sys_parts or (len(sys_parts) == 1 and messages[0].get("role") == "system"):
        return messages
    tail = ""
    first = sys_parts[0]
    if first.rstrip().endswith("/no_think"):
        first, tail = first.rstrip()[:-len("/no_think")].rstrip(), "\n/no_think"
    merged = "\n\n".join([first] + sys_parts[1:]) + tail
    return [{"role": "system", "content": merged}] + [m for m in messages if m.get("role") != "system"]


def _post(endpoint: str, payload: dict, timeout: float) -> dict:
    if isinstance(payload.get("messages"), list):
        payload = dict(payload, messages=one_system_message(payload["messages"]))
    # Qwen3.5 thinks by default: a call that did not ask for it spent its whole max_tokens reasoning and
    # came back with no answer (build mode "สร้าง VHDL ไม่ได้" on a plain full adder). Off unless asked.
    payload.setdefault("chat_template_kwargs", {"enable_thinking": False})
    req = urllib.request.Request(
        endpoint, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def derive_equations(spec: str, in_names: list, out_names: list, *,
                     endpoint: str = DEFAULT_ENDPOINT, model: str = DEFAULT_MODEL,
                     temperature: float = 0.0, timeout: float = 120.0) -> dict:
    """Independently derive per-output boolean equations from the spec (a DIFFERENT
    representation than the gate netlist) so the pipeline can cross-check the
    generated circuit even when the spec has no explicit equations. Returns
    {out_name: expr_str} using notation ' =NOT, * =AND, + =OR, ^ =XOR. Does NOT
    see the generated intent (keeps the derivation independent)."""
    sys_p = ("You are a digital-logic expert. Given a circuit description, output the "
             "minimal boolean equation for EACH output, as ONE JSON object mapping "
             "output name -> expression. Use ONLY these inputs: " + ", ".join(in_names) +
             ". Outputs: " + ", ".join(out_names) + ". Notation: ' = NOT (postfix), "
             "* = AND, + = OR, ^ = XOR, parentheses allowed. Output JSON only, no prose. "
             'Example: {"sum":"a^b^cin","cout":"a*b + (a^b)*cin"}\n/no_think')
    payload = {"model": model, "temperature": temperature, "max_tokens": 1536,
               "chat_template_kwargs": {"enable_thinking": False},
               "messages": [{"role": "system", "content": sys_p},
                            {"role": "user", "content": spec}]}
    try:
        data = _post(endpoint, payload, timeout)
    except Exception:
        return {}
    raw = (data.get("choices", [{}])[0].get("message", {}) or {}).get("content", "")
    obj = _extract_json(raw)
    if not isinstance(obj, dict):
        return {}
    return {k: str(v) for k, v in obj.items() if k in out_names and isinstance(v, str)}


_VHDL_SYS = (
    "You are a digital-logic designer. Write SYNTHESIZABLE, GATE-LEVEL VHDL for the "
    "requested circuit. A downstream tool converts your VHDL DIRECTLY into a gate "
    "schematic, so follow these rules exactly:\n"
    "- Dataflow style: assign every output and intermediate signal a boolean expression.\n"
    "- Use ONLY operators: and, or, not, xor, nand, nor, xnor, and parentheses.\n"
    "- FORBIDDEN: arithmetic (+ - * /), unsigned/signed, std_logic_vector math, loops, "
    "generate, variables, and processes for combinational logic.\n"
    "- Sequential logic: one process with rising_edge(clk) driving a signal (a D-FF). "
    "A multiplexer may use with/select or when/else.\n"
    "- Every port is std_logic (scalar). Expand buses to individual bits: inputs a0,a1,... "
    "b0,b1,... outputs s0,s1,... (LSB = index 0). Declare intermediate signals for shared terms.\n"
    "- Output ONLY VHDL (library/use/entity/architecture). No prose, no markdown fences.")


def _extract_vhdl(raw: str) -> str:
    """Pull the VHDL body out of a model reply (strip fences/prose)."""
    t = re.sub(r"<think>.*?(</think>|$)", "", raw or "", flags=re.S)      # a reasoning block left in the reply
    if "```" in t:                              # take the first fenced block
        import re as _re
        m = _re.search(r"```(?:vhdl|VHDL)?\s*(.*?)```", t, _re.S)
        if m:
            t = m.group(1)
    low = t.lower()
    i = low.find("library ")
    if i < 0:
        i = low.find("entity ")
    if i > 0:
        t = t[i:]
    return t.strip()


_RESTATE_SYS = (
    "You translate a student's digital-logic request (often in Thai, sometimes pasted from a lab sheet "
    "with broken characters) into a precise ENGLISH hardware specification for a VHDL generator.\n"
    "Output ONLY the specification, in this shape:\n"
    "Module: <name>\nInputs: <name>[<width>] ... \nOutputs: <name>[<width>] ...\n"
    "Behaviour: <1-4 short sentences; say whether it is combinational or clocked>\n"
    "Rules: keep every signal name exactly as the student wrote it (SW, yy, clk ...), keep given bit "
    "ranges (SW[7:4]); if something is ambiguous choose the usual classroom meaning; no VHDL, no prose.")
_THAI = re.compile(r"[\u0E00-\u0E7F]")


def needs_restate(spec: str) -> bool:
    return bool(_THAI.search(spec or ""))


def restate_spec(spec: str, *, endpoint: str = DEFAULT_ENDPOINT, model: str = DEFAULT_MODEL,
                 timeout: float = 90.0) -> dict:
    """Thai request -> short English spec. Coder models (Qwen2.5-Coder) follow an English
    spec far better than Thai text; the student sees the restatement, so a misunderstanding
    shows before they trust the circuit. Returns {ok, spec, raw}."""
    payload = {"model": model, "temperature": 0.1, "max_tokens": 320, "stream": False,
               "messages": [{"role": "system", "content": _RESTATE_SYS},
                            {"role": "user", "content": spec}]}
    try:
        data = _post(endpoint, payload, timeout)
    except Exception as e:
        return {"ok": False, "spec": "", "raw": "", "error": str(e)[:120]}
    raw = (data.get("choices", [{}])[0].get("message", {}) or {}).get("content", "") or ""
    raw = re.sub(r"(?s)<think>.*?</think>", "", raw).strip().strip("`").strip()
    ok = bool(raw) and not needs_restate(raw) and len(raw) < 2000
    return {"ok": ok, "spec": raw if ok else "", "raw": raw}


def generate_vhdl_from_spec(spec: str, *, endpoint: str = DEFAULT_ENDPOINT,
                            model: str = DEFAULT_MODEL, temperature: float = 0.2,
                            timeout: float = 180.0, use_rag: bool = False,
                            feedback: list | None = None) -> dict:
    """NL spec -> gate-level dataflow VHDL via the LLM (NO grammar; far fewer tokens than
    Intent-JSON, so much faster + more natural for a coder model). The editor's
    parseVhdl/buildSchematicFromVhdl then turns it into the schematic. Returns
    {ok, vhdl, raw}."""
    messages = [{"role": "system", "content": _VHDL_SYS}]
    if use_rag:
        ctx = retrieve_context(spec, prefer_vhdl=True)
        if ctx:
            messages.append({"role": "system", "content": "Reference (verified library):\n" + ctx})
    messages.append({"role": "user", "content": spec})
    for fb in (feedback or []):
        messages.append({"role": "user", "content": fb})
    payload = {"model": model, "messages": messages, "temperature": temperature,
               "max_tokens": 2000, "stream": False}
    try:
        data = _post(endpoint, payload, timeout)
    except Exception as e:
        return {"ok": False, "vhdl": "", "raw": "", "error": str(e)[:120]}
    raw = (data.get("choices", [{}])[0].get("message", {}) or {}).get("content", "")
    vhdl = _extract_vhdl(raw)
    ok = bool(vhdl) and "entity" in vhdl.lower() and "architecture" in vhdl.lower()
    return {"ok": ok, "vhdl": vhdl, "raw": raw}


def generate_equations(spec: str, *, endpoint: str = DEFAULT_ENDPOINT, model: str = DEFAULT_MODEL,
                       use_rag: bool = True, temperature: float = 0.1, timeout: float = 300.0,
                       feedback: list | None = None, think: bool = False, verbose: bool = True) -> dict:
    """Equation-FIRST generation: ask the model for boolean equations (its most
    compact, least-hallucination-prone output) + the port list, in ONE JSON. The hub
    then synthesizes the gate netlist deterministically (correct by construction).
    Returns {module, inputs:[...], outputs:{name:expr}} (+registers/next if sequential).
    think=True lets a Qwen3 model reason (chain-of-thought) first — ~10-40x slower but
    much better on hard decomposition (comparator/subtractor/…); we strip <think> and
    give a big token budget so the JSON after it isn't truncated. Used on RETRY escalation."""
    sys_p = ("You are a digital-logic expert. Design a circuit for the user's description "
             "and output JSON ONLY (no prose):\n"
             '{"module":"name","inputs":["a","b",...],"outputs":{"out":"expr",...}}\n'
             "Notation: ' = NOT (postfix), * or space = AND, + = OR, ^ = XOR, () allowed. "
             "Give ONE boolean expression per output, using ONLY the input names you list. "
             'Example: {"module":"full_adder","inputs":["a","b","cin"],'
             '"outputs":{"sum":"a^b^cin","cout":"a*b+(a^b)*cin"}}\n'
             "IF the circuit needs MEMORY/STATE (counter, register, FSM, sequential — clock "
             "is implicit), ALSO include \"registers\":[\"q1\",\"q0\",...] and "
             "\"next\":{\"q1\":\"expr\",...} where next[r] is the value latched into r on the "
             "clock edge (expressions may use register names AND inputs). Outputs are then "
             "functions of registers/inputs. Example (2-bit up counter, enable en): "
             '{"module":"counter2","inputs":["en"],"registers":["q1","q0"],'
             '"next":{"q1":"q1^(q0*en)","q0":"q0^en"},"outputs":{"c1":"q1","c0":"q0"}}. '
             "Omit registers/next for purely combinational circuits.")
    if not think:
        sys_p += "\n/no_think"       # Qwen3 switch: skip chain-of-thought (fast, first pass)
    messages = [{"role": "system", "content": sys_p}]
    if use_rag:
        ctx = retrieve_context(spec)
        if ctx:
            messages.append({"role": "system",
                             "content": "อ้างอิงคลังที่ตรวจแล้ว (verified-library-first):\n" + ctx})
        ex = retrieve_exemplar(spec)
        eq_ex = (ex or {}).get("intent_json", {}).get("equations") if ex else None
        if eq_ex:
            messages.append({"role": "user",
                             "content": "ตัวอย่างสมการที่ถูกต้อง (worked example, อย่าลอกตรง ๆ "
                                        "ถ้าโจทย์ต่างกัน):\n" + json.dumps(eq_ex, ensure_ascii=False)})
            if verbose:
                print(f"[equations] exemplar: {ex['question']}")
    messages.append({"role": "user", "content": spec})
    for fb in (feedback or []):
        messages.append({"role": "user", "content": fb})
    # thinking OFF: tight budget, no CoT. thinking ON: big budget so the JSON after
    # </think> isn't truncated (the reasoning eats a lot of tokens).
    payload = {"model": model, "messages": messages, "temperature": temperature,
               "max_tokens": 6144 if think else 1536, "stream": False,
               "chat_template_kwargs": {"enable_thinking": bool(think)}}
    try:
        data = _post(endpoint, payload, timeout)
    except Exception as ex:
        if verbose:
            print(f"[equations] endpoint error: {ex}")
        return {}
    raw = (data.get("choices", [{}])[0].get("message", {}) or {}).get("content", "")
    raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.S)   # drop CoT, keep the JSON
    obj = _extract_json(raw)
    if not isinstance(obj, dict) or not isinstance(obj.get("outputs"), dict):
        return {}
    outs = {str(k): str(v) for k, v in obj["outputs"].items() if isinstance(v, str) and v.strip()}
    ins = obj.get("inputs") if isinstance(obj.get("inputs"), list) else None
    res = {"module": obj.get("module"), "inputs": ins, "outputs": outs}
    # sequential extras (phase 2): registers + next-state equations
    regs = obj.get("registers")
    nxt = obj.get("next")
    if isinstance(regs, list) and regs and isinstance(nxt, dict) and nxt:
        res["registers"] = [str(r) for r in regs]
        res["next"] = {str(k): str(v) for k, v in nxt.items() if isinstance(v, str) and v.strip()}
    if verbose and outs:
        seqtag = " +seq" if res.get("next") else ""
        print(f"[equations] {obj.get('module','?')} outputs={list(outs)}{seqtag}")
    return res if outs else {}


def generate_intent(spec: str, *, endpoint: str = DEFAULT_ENDPOINT,
                    model: str = DEFAULT_MODEL, use_grammar: bool = True,
                    use_rag: bool = True, max_retries: int = 3, temperature: float = 0.1,
                    timeout: float = 180.0, feedback: list | None = None,
                    verbose: bool = True) -> dict:
    """
    spec : natural-language description of the circuit.
    Returns {'ok', 'intent', 'validation', 'attempts', 'raw'} — 'intent' is the
    last parsed object (may be None if the model returned no JSON).
    use_rag: prepend verified-library-first reference (labs/content/vhdl) as context.
    """
    system = _load(SYSTEM_PROMPT_PATH, "You output ONLY Intent-JSON topology. No prose.")
    grammar = _load(GRAMMAR_PATH) if use_grammar else ""
    messages = [{"role": "system", "content": system}]
    if use_rag:
        ctx = retrieve_context(spec)
        if ctx:
            messages.append({"role": "system",
                             "content": "อ้างอิงจากคลังที่ตรวจแล้ว (verified-library-first) — "
                                        "ใช้เป็นแนวทางการแตก gate ที่ถูกต้อง อย่าลอก x/y:\n" + ctx})
            if verbose:
                print(f"[rag] added {len(ctx)} chars of context")
        ex = retrieve_exemplar(spec)
        if ex:
            messages.append({"role": "user",
                             "content": "ตัวอย่างวงจรที่ผ่านการตรวจแล้ว (worked example) — "
                                        "ใช้เป็นแบบการแตก gate/ต่อ net ที่ถูกต้อง (อย่าลอกมาตรง ๆ "
                                        "ถ้าโจทย์ต่างกัน):\n" + json.dumps(ex["intent_json"], ensure_ascii=False)})
            if verbose:
                print(f"[rag] added exemplar ({ex['intent_json'].get('module','?')})")
    messages.append({"role": "user", "content": spec})
    for fb in (feedback or []):
        messages.append({"role": "user", "content": fb})

    last = {"ok": False, "intent": None, "validation": None, "attempts": 0, "raw": ""}
    for attempt in range(1, max_retries + 1):
        payload: dict = {"model": model, "messages": messages,
                         "temperature": temperature, "max_tokens": 2048, "stream": False}
        if grammar:
            payload["grammar"] = grammar          # llama.cpp extra field
        try:
            data = _post(endpoint, payload, timeout)
        except urllib.error.HTTPError as ex:
            # server answered but rejected the request (e.g. 400 bad grammar) —
            # surface its actual message instead of a misleading "unreachable"
            try:
                body = ex.read().decode("utf-8", "replace")[:300]
            except Exception:
                body = ""
            return {**last, "attempts": attempt,
                    "validation": {"ok": False,
                                   "errors": [{"code": "ENDPOINT_HTTP_ERROR",
                                               "msg": f"HTTP {ex.code} จาก {endpoint}: {body}",
                                               "hint": "เช็ค payload/grammar หรือ log ของ llama-server"}],
                                   "warns": []}}
        except (urllib.error.URLError, TimeoutError) as ex:
            return {**last, "attempts": attempt,
                    "validation": {"ok": False,
                                   "errors": [{"code": "ENDPOINT_UNREACHABLE",
                                               "msg": f"เรียก {endpoint} ไม่ได้: {ex}",
                                               "hint": "สตาร์ท llama-server ก่อน (ดู ai/README.md)"}],
                                   "warns": []}}

        raw = (data.get("choices", [{}])[0].get("message", {}) or {}).get("content", "")
        intent = _extract_json(raw)
        result = validate_intent(intent) if intent is not None else {
            "ok": False, "warns": [],
            "errors": [{"code": "NO_JSON", "msg": "โมเดลไม่ได้ส่ง JSON",
                        "hint": "ตอบเป็น Intent-JSON object เท่านั้น"}]}
        last = {"ok": result["ok"], "intent": intent, "validation": result,
                "attempts": attempt, "raw": raw}
        if verbose:
            print(f"[attempt {attempt}] ok={result['ok']} "
                  f"errors={len(result['errors'])} warns={len(result['warns'])}")
        if result["ok"]:
            return last

        # feed the exact ERC hints back for a targeted fix (not a full redraw)
        messages.append({"role": "assistant", "content": raw})
        messages.append({"role": "user",
                         "content": "แก้เฉพาะจุดที่ผิดต่อไปนี้ แล้วส่ง Intent-JSON ใหม่ทั้งก้อน:\n"
                                    + hints_for_retry(result)})
    return last


if __name__ == "__main__":
    import sys
    spec = " ".join(sys.argv[1:]) or (
        "full adder: inputs a, b, cin; outputs sum, cout. "
        "sum = a xor b xor cin; cout = majority(a,b,cin).")
    out = generate_intent(spec)
    print(json.dumps(out["intent"], ensure_ascii=False, indent=2) if out["intent"]
          else "(no intent)")
    if not out["ok"] and out["validation"]:
        print("\nVALIDATION:\n" + hints_for_retry(out["validation"]))
    sys.exit(0 if out["ok"] else 1)
