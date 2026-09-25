"""
build_index.py - flatten the RAG corpus (content chunks + lab items + external
VHDL dataset) into one searchable index: ai/rag/index.jsonl

Each line = one record:
  {id, group, source, title, topic, text, meta:{...}, payload:{...}}
- text  = the field we run BM25 over (concatenated searchable strings)
- meta  = filter/boost fields (chapter, lab, section, verified, has_intent, ...)
- payload = the original chunk/item/code kept for the answer

Design (per _ecosystem_docs): keyword/BM25 retrieval + metadata filter +
verified-library-first, NOT pure vector. Re-runnable.
"""
from __future__ import annotations
import csv
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONTENT, LABS = HERE / "content", HERE / "labs"
VHDL = HERE.parent / "datasets" / "vhdl"   # ai/datasets/vhdl (sibling of rag/)
OUT = HERE / "index.jsonl"
csv.field_size_limit(10_000_000)


def _s(*parts) -> str:
    out = []
    for p in parts:
        if p is None:
            continue
        if isinstance(p, (list, tuple)):
            out.append(" ".join(str(x) for x in p))
        else:
            out.append(str(p))
    return "  ".join(out)


def records():
    # ---- content chunks ----
    for f in sorted(CONTENT.glob("*.json")):
        d = json.load(open(f, encoding="utf-8"))
        if isinstance(d, list):
            d = d[0] if d and isinstance(d[0], dict) else {"chunks": d}
        chapter = d.get("chapter")
        for c in d.get("chunks", []):
            yield {
                "id": c.get("id") or f"{f.stem}-{c.get('section','')}",
                "group": "content", "source": d.get("source", f.name),
                "title": d.get("title", ""), "topic": c.get("topic", ""),
                "text": _s(c.get("topic"), c.get("summary"), c.get("text"),
                           c.get("keywords"), c.get("section"), d.get("title")),
                "meta": {"chapter": chapter, "section": c.get("section"),
                         "type": c.get("type"), "pages": c.get("pages"),
                         "needs_figure": bool(c.get("needs_figure")),
                         "related_labs": c.get("related_labs", [])},
                "payload": c}
    # ---- lab items (verified-first: mark verified / golden) ----
    for f in sorted(LABS.glob("*.json")):
        d = json.load(open(f, encoding="utf-8"))
        items = d.get("items", []) if isinstance(d, dict) else d
        for it in items:
            sol = it.get("solution") or {}
            ij = sol.get("intent_json")
            has_intent = bool(ij) and (isinstance(ij, dict))
            yield {
                "id": it.get("id") or f"{f.stem}-item",
                "group": "lab", "source": d.get("source", f.name),
                "title": d.get("title", ""), "topic": it.get("topic", ""),
                "text": _s(it.get("question"), it.get("topic"), it.get("subtasks"),
                           sol.get("steps"), sol.get("final_expression"), d.get("title")),
                "meta": {"lab": d.get("lab"), "verified": bool(it.get("verify")),
                         "has_intent": has_intent, "golden": has_intent,
                         "related_content": it.get("related_content", [])},
                "payload": it}
    # ---- external VHDL dataset (optional; present after download) ----
    yield from _vhdl_records()
    # ---- curated schematic-ready VHDL exemplars (engine-generated + textbook sequential) ----
    yield from _vhdl_ref_records()
    # ---- board profile (EDGE Spartan-7 pin map) ----
    yield from _board_records()


def _vhdl_ref_records():
    try:
        import vhdl_exemplars
    except Exception as e:            # engine modules missing → skip, don't break the build
        print("  (skip vhdl_ref:", e, ")")
        return
    yield from vhdl_exemplars.records()


def _board_records():
    prof_path = HERE.parent / "board" / "board_profile.json"
    if not prof_path.exists():
        return
    prof = json.load(open(prof_path, encoding="utf-8"))
    sig, groups = prof["signals"], prof["groups"]
    # a summary chunk
    yield {"id": "board-overview", "group": "board", "source": "board/edge_spartan7.xdc",
           "title": "EDGE Spartan-7 board overview", "topic": "board|fpga|pinout",
           "text": _s("EDGE Spartan-7 development board", prof.get("part"),
                      "clock 50 MHz on pin", prof["clock"]["pin"],
                      "peripherals:", list(groups.keys()),
                      "7-segment is common-anode active-LOW; digit select active-HIGH"),
           "meta": {"part": prof.get("part"), "clock_pin": prof["clock"]["pin"],
                    "clock_hz": prof["clock"]["freq_hz"]},
           "payload": {"part": prof.get("part"), "clock": prof["clock"],
                       "groups": {g: len(v) for g, v in groups.items()}}}
    # one chunk per peripheral group with its pin table
    for g, ports in groups.items():
        pins = [(p, sig[p]["pin"], sig[p]["iostandard"], sig[p].get("note", "")) for p in ports]
        yield {"id": f"board-{g}", "group": "board", "source": "board/edge_spartan7.xdc",
               "title": f"EDGE Spartan-7 {g} pins", "topic": "board|pinout|" + g,
               "text": _s("board peripheral", g, "signals/pins:",
                          [f"{p}={pin}({io}){' '+nt if nt else ''}" for p, pin, io, nt in pins]),
               "meta": {"group_name": g, "count": len(ports),
                        "pins": {p: sig[p]["pin"] for p in ports}},
               "payload": {"ports": [{"port": p, "pin": sig[p]["pin"],
                                      "iostandard": sig[p]["iostandard"],
                                      "note": sig[p].get("note", "")} for p in ports]}}


def _looks_vhdl(t: str) -> bool:
    t = t.lower()
    return ("architecture" in t) or ("library ieee" in t) or ("entity " in t and "is" in t)


def _strip_instruction(t: str) -> str:
    # rows look like "translate the following VHDL to verilog\n\n<code>"
    parts = t.split("\n\n", 1)
    if len(parts) == 2 and len(parts[0]) < 120 and "translate" in parts[0].lower():
        return parts[1]
    return t


def _vhdl_records():
    # rtl-llm/vhdl_github_deduplicated : list of {prompt, chosen} VHDL<->Verilog
    # translation pairs. Extract the VHDL side; keep the Verilog side as a paired
    # reference (bonus for a VHDL->Verilog / codegen library).
    j = VHDL / "vhdl_github_deduplicated.json"
    if j.exists():
        try:
            data = json.load(open(j, encoding="utf-8"))
        except Exception:
            data = []
        for i, r in enumerate(data if isinstance(data, list) else []):
            if not isinstance(r, dict):
                continue
            a = _strip_instruction(r.get("prompt", "") or "")
            b = r.get("chosen", "") or ""
            if _looks_vhdl(a):
                vhdl, verilog = a, b
            elif _looks_vhdl(b):
                vhdl, verilog = b, a
            else:
                continue
            ents = _vhdl_entities(vhdl)
            yield {"id": f"vhdl-gh-{i}", "group": "vhdl",
                   "source": "rtl-llm/vhdl_github_deduplicated",
                   "title": ", ".join(ents[:3]), "topic": "vhdl-code",
                   "text": _s(ents, vhdl[:1500]),
                   "meta": {"entities": ents, "lines": vhdl.count(chr(10)) + 1,
                            "license": "mit", "has_verilog_pair": bool(verilog)},
                   "payload": {"code": vhdl, "verilog": verilog}}
    # NOKHAB-Lab/LLM_4_VHDL : CSVs (instruct + eval)
    for name, kind in (("LLM4VHDL_dataset_5k.csv", "instruct"), ("LLM4VHDL_eval_100.csv", "eval")):
        p = VHDL / name
        if not p.exists():
            continue
        with open(p, encoding="utf-8", newline="") as fh:
            for i, row in enumerate(csv.DictReader(fh)):
                txt = " ".join(str(v) for v in row.values() if v)
                yield {"id": f"vhdl-{kind}-{i}", "group": "vhdl", "source": f"NOKHAB-Lab/LLM_4_VHDL:{kind}",
                       "title": (row.get("prompt") or row.get("instruction") or row.get("task") or "")[:80],
                       "topic": f"vhdl-{kind}", "text": txt[:2000],
                       "meta": {"license": "mit", "kind": kind}, "payload": row}


def _vhdl_entities(code: str):
    import re
    return re.findall(r"(?:entity|architecture)\s+([A-Za-z_]\w*)", code, re.I)


def main():
    n = 0
    by = {}
    with open(OUT, "w", encoding="utf-8") as w:
        for rec in records():
            w.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
            by[rec["group"]] = by.get(rec["group"], 0) + 1
    print("wrote", OUT, "records:", n, by)


if __name__ == "__main__":
    main()
