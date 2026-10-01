# Training data for the in-app agent (Qwen3.5 4B)

Every word of the agent-mode training data is written **by these programs**, not by a model, and every
conversation is checked **by the app** against an answer known in advance. The conversations come from
the app's **real agent loop**: same system prompt, same tool schemas, same tool results, same nudges as
the model sees in use.

```
gen_*.py ──tasks.jsonl──▶ run.js ──▶ private app (launcher/app.py, own home folder)
  (task + known answer)        │        editor page (Playwright) ── agent mode ── /api/llm/chat
                               │                                                   │
                               │                       teacher.py (stands in for llama-server,
                               │                       answers from the task's known answer)
                               ▼
         every circuit checked OUTSIDE the conversation (truth table / 64-clock stream /
         pin map / function of the composed block / the number a question asks for)
                               ▼
     train.jsonl (only conversations that passed and are well-formed)  ──▶ build_dataset.py ──▶ data/
```

## Categories

| cat | generator | what the model learns | checked by |
|---|---|---|---|
| `nl_logic` | `gen_logic.py` | Thai description of a function (no equation written) → equation → `set_spec` + `build_circuit`; 1–2 outputs; 20 % with a planned slip (unknown field, no `out =`, Thai words in the formula) that the app rejects and the next turn fixes | truth table of the drawn circuit vs the task's |
| `nl_fsm` | `gen_fsm.py` | sequence detector (pattern, Moore/Mealy, overlap or not) → state meanings → `set_spec` (a clock sequence from a reference detector) + `build_fsm` | a 64-clock random stream the conversation never used |
| `nl_fix` | `gen_fix.py` | a wrong circuit is on the sheet (one realistic slip) + what it should do → spec from the request → read the mismatching rows → rebuild | truth table |
| `nl_compose` | `gen_compose.py` | "make Y from N × X" (ripple adders, 2N-bit adder from two N-bit, mux 4:1 / 8:1) → ONE `build_hierarchy` with every wire | the function (`compare_sheets`, or 400 random sums when too wide) |
| `nl_pins` | `gen_pins.py` | switches / buttons / LEDs named in Thai → `set_pins` → check | the sheet's pin map |
| `qa` | `gen_qa.py` | a question answered directly (no tool): bases, two's complement, BCD, Gray, rows, flip-flops for mod-m, 50 MHz dividers, EDGE 7-seg (active-low), K-map minimum SOP | no tool call; the answer computed here |
| `qa_mode` | `gen_qamode.py` | the chat's **ถาม-ตอบ** mode: concept questions about the course (from every RAG note: chapters, board, VHDL, labs) answered in Thai, plus `gen_qa.py`'s computed questions — in the exact prompt Q&A mode sends (`chat_server.ask_messages`: system prompt + 3 retrieved notes + the editor's wrapping) | prose: written by an **open-weight** model (Qwen3.5-397B-A17B, Apache-2.0, via OpenRouter), kept only when two judges of other families (DeepSeek V4 Pro, GLM-5.3) both find it fully correct, plus code filters (Thai, no markdown, board facts, no "this circuit" questions); computed rows: the program's answer |
| `general_thai` | `online.py` | keeps Thai fluency: airesearch/wangchanx-seed-free-synthetic-instruct-thai-120k (MIT), rating ≥ 8.2, grounded rows first, garbled / creative-style rows filtered | filters (see the file) |
| `general_tools` | `online.py` | keeps general tool calling: NousResearch/hermes-function-calling-v1 (Apache-2.0), converted to OpenAI `tool_calls` | structure check |

Each generator holds back an **eval split** (10 %) that uses phrasings / frames the train split never
sees. Those tasks are never trained on — `run.js --eval-model` replays them against a real model.

## Running it

```bash
npm install                                   # Playwright (as for the tests)
python3 tools/dataset/gen_logic.py --n 3000 --seed 1 > tasks_logic.jsonl      # same for gen_fsm / gen_fix / …
node tools/dataset/run.js --tasks tasks_logic.jsonl --out runs/logic           # ~2–12 s per task
pip install pyarrow && python3 tools/dataset/online.py --cache /tmp/hf --out runs/online
python3 tools/dataset/gen_qa.py --n 1500 --seed 31 > qa_for_qamode.jsonl
OR_KEY=… python3 tools/dataset/gen_qamode.py --out runs/qamode --per-chunk 8 --computed qa_for_qamode.jsonl
python3 tools/dataset/build_dataset.py --runs runs/* --online runs/online --tasks tasks_*.jsonl \
        --out tools/dataset/data --tokenizer qwen3.5-4b/tokenizer.json
python3 tools/dataset/export_hf.py tools/dataset/data/train.jsonl.gz train_hf.jsonl [--tools-subset 6]
```

## Training (QLoRA, one 16 GB GPU)

`train_lora.py` fine-tunes Qwen3.5-4B (the HF weights, not the .gguf) on `data/` — see its header for the install
lines. `--dry-run` shows what is trained (assistant turns only; schemas, tool results, the greeting, planned
mistakes and the prompt's empty `<think></think>` are context), `--pilot` measures peak VRAM and speed on the
longest conversations, then a full run saves the adapter and, with `--merge --gguf ~/llama.cpp`, writes a Q6_K
.gguf to measure with the commands below. System RAM is not used unless `--offload` (activations, ~10–20 % slower).
Every conversation fits 12,288 tokens; 3.4 % of the tokens are trained (the 8.3k-token tool schemas repeat in every
agent row).

## Measuring a model (before / after training)

```bash
node tools/dataset/run.js --eval-model D:/models/Qwen3.5-4B-Q6_K.gguf --llama D:/llama/llama-server.exe \
     --tasks tools/dataset/data/eval_tasks.jsonl.gz --out eval_base --per-cat 25 --budget 300
```
A private copy of the app (its own home folder — your projects, settings and module library are not
touched) runs the agent with that model; `eval_base/eval_report.md` gives the pass rate per category and
`eval_runs.jsonl` every answer and step. Escalation to a bigger model is off.

Q&A mode (answers graded by the two judges against the reference; needs `OR_KEY`):
```bash
llama-server -m Qwen3.5-4B-Q6_K.gguf --jinja --port 8080 &
OR_KEY=… python3 tools/dataset/eval_qamode.py --tasks tools/dataset/data/eval_qamode.jsonl.gz --out qamode_base.jsonl
```

## Format

`data/train.jsonl.gz` — one conversation per line:
```json
{"id": "logic-train-00012", "cat": "nl_logic", "tools_ref": "app",
 "messages": [{"role": "system", …}, {"role": "assistant", "content": "สวัสดีครับ …"},   ← editor greeting (history)
              {"role": "user", "content": "ออกแบบวงจร …"},
              {"role": "assistant", "content": "", "reasoning_content": "แปลทีละเงื่อนไข …", "tool_calls": [ … ]},
              {"role": "tool", "tool_call_id": "call_0_0", "content": "{…}"}, …,
              {"role": "assistant", "content": "สร้างวงจรบนแผ่น …"}],
 "meta": {"train_from": 3, "mistake": null, "steps": ["set_spec", "build_circuit"], …}}
```
- `tools_ref: "app"` → the tool schemas are `data/tools_app.json` (`export_hf.py` inlines them).
- Train on assistant turns from `meta.train_from` on. An assistant message with `"train": false` is a
  planned mistake kept as context (the app's error and the fix are the lesson) — mask it
  (axolotl: `message_field_training: train`; `export_hf.py` also writes `weight: 0`).
- `reasoning_content` is the model's thinking for that turn (Qwen3.5 `<think>`); in use the app sends it
  back in later requests as `(my plan) …` inside the content.
- Tokens (Qwen3.5-4B tokenizer): an app conversation is ~10–11k tokens, of which ~8.3k are the 40 tool
  schemas — `--tools-subset 6` cuts that to ~3–4k (≈3× faster training, slightly less faithful).

## Adding a category

A generator writes tasks (with `split`, `use_sheet`, and whatever its check needs); `teacher.py` gets an
entry in `CATS` (`plan` → reasoning, `first` → the first calls, optional `then` / `dynamic` second step,
`answer`); `run.js` gets a branch in `checkInPage`. Review samples, fix the program (never the rows),
and only then run it long.
