# RAG extraction spec (shared by all Sonnet-5 extraction agents)

Goal: turn the course PDFs into a clean, structured RAG corpus for the local AI.
Two sources: **content/** (Tocci lecture slides -> concepts) and **labAssignment/**
(lab worksheets -> questions + WORKED SOLUTIONS). Solutions must be CORRECT.

Design constraints (from `_ecosystem_docs`): chunk **by topic/section boundary**
(not fixed-size), attach rich **metadata** for filtering, and prefer
**verified** items. Where a lab answer is a circuit, ALSO emit it as Intent-JSON
so it doubles as a golden design for the drawing engine.

## Inputs (already prepared - do NOT re-run pypdf yourself)
- `ai/rag/_raw/<name>.txt` - cleaned per-page text, boilerplate stripped,
  with `===== PAGE n =====` markers. Work from this.
- `ai/rag/_raw/manifest.json` - per PDF: `pages`, `image_pages` (pages with
  little/no text = diagrams/K-maps/circuits/waveforms), `chars_per_page`.
- The original PDF (e.g. `content/Ch_4.pdf`). For any page listed in
  `image_pages`, or when the text is clearly missing a figure you need, **Read
  that PDF page with the vision-capable Read tool** (`Read` supports `pages`)
  and describe/transcribe the figure. Do not hallucinate figures.

## Known text artifacts (Thai PDFs)
Thai vowels/tone marks are sometimes split with a space ("ส าหรับ" = "สำหรับ",
"ท างาน" = "ทำงาน"). Read through it; normalize in your output. If a passage is
too garbled to trust, fall back to Read-vision on that page.

## Output location & format
Write **UTF-8 JSON**, one file per PDF:
- content -> `ai/rag/content/<stem>.json`
- labs    -> `ai/rag/labs/<stem>.json`
Keep Thai text in Thai; keep math/logic in ASCII (e.g. `z = A(C + B)`,
`f = Sigma m(2,3,4)`), use `'` for NOT, `+` OR, `*` or juxtaposition AND, `^` XOR.

### content schema (array of topic chunks)
```json
{
  "source": "Ch_4.pdf", "group": "content", "chapter": "4",
  "title": "Combinational Logic Circuits",
  "chunks": [
    {
      "id": "ch4-4-3-algebraic-simplification",
      "section": "4-3", "topic": "Algebraic Simplification",
      "type": "concept|definition|method|example|theorem|table",
      "summary": "1-2 sentence gist for retrieval",
      "text": "clean, self-contained explanation reconstructed from the slides",
      "keywords": ["boolean algebra","factoring","simplification"],
      "pages": [8,9],
      "needs_figure": true,
      "figure_note": "if needs_figure: what the figure shows (from Read-vision)",
      "related_labs": ["Lab3"]
    }
  ]
}
```

### lab schema (array of items = questions with solutions)
```json
{
  "source": "Lab3-2569.pdf", "group": "labs", "lab": "3",
  "title": "การลดรูปสมการบูลีน (Boolean Simplification)",
  "objectives": ["..."],
  "items": [
    {
      "id": "lab3-1",
      "question": "verbatim task incl. the GIVEN, e.g. f(a,b,c,d)=Sigma m(2,3,4,10,12,13,15)+Sigma d(...)",
      "params": "note any parameterization (e.g. don't-cares from student ID); pick a concrete example set and STATE it",
      "subtasks": ["1.1 write truth table","1.2 K-map","1.3 minimal SOP","1.4 draw circuit"],
      "topic": "kmap|boolean-simplification|truth-table|combinational-design|flipflop|counter|mux|logic-gates|fpga|logisim|...",
      "solution": {
        "steps": "worked solution (Thai or English), show the reasoning",
        "truth_table": "optional ASCII table",
        "kmap": "optional ASCII K-map + groupings",
        "final_expression": "z = ...",
        "intent_json": null,
        "notes": "assumptions"
      },
      "verify": "how you checked it (e.g. 'enumerated all 16 rows, SOP matches minterms')",
      "related_content": ["ch4-4-3-algebraic-simplification"]
    }
  ]
}
```
`intent_json`: when the answer is a gate circuit, fill it with the Intent-JSON
schema (see `ai/prompts/intent_system.md`): `{module, components:[{id,type,name?}],
nets:[{from,to}]}`, types `IN OUT AND OR XOR NAND NOR XNOR NOT BUF`, no x/y. This
makes the solved circuit a golden design too.

## Correctness bar (labs)
- For any combinational answer, **verify by enumeration** (write a tiny Python
  check that builds the truth table from the given minterms/expression and
  confirms your simplified expression matches on every row). Put the result in
  `verify`. A wrong solution is worse than none.
- If a task depends on unavailable data (student ID, board-specific pins), solve
  a clearly-stated concrete instance and say so in `params`/`notes`.
- Don't invent lab steps that aren't there; procedural/Logisim steps can be
  summarized rather than "solved".

## Rules
- Read ONLY your assigned PDFs. Write ONLY under `ai/rag/content|labs/`.
- Do NOT touch `schematic&bus2vhdl.html`, the editor, or anything outside `ai/rag/`.
- Valid JSON (`json.load` must parse). One file per PDF. Report a 1-line summary
  per file (counts) when done.
```
