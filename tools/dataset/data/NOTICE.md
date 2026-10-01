# Sources and licences

- **Program-generated rows** (`cat` = nl_logic, nl_fsm, nl_fix, nl_compose, nl_pins, qa): written by `tools/dataset/*.py`
  through the app's agent loop and checked by the app; same licence as this repository.
- **qa_mode** (the chat's ถาม-ตอบ mode): concept answers written by the open-weight model
  [Qwen3.5-397B-A17B](https://huggingface.co/Qwen) (Apache-2.0) via OpenRouter from the app's own Q&A prompt and course notes,
  kept only when two judges of other model families (DeepSeek V4 Pro, GLM-5.3 — scores only, none of their text) found
  them fully correct against the source note, plus code filters (`tools/dataset/gen_qamode.py`); rows with
  `meta.kind = computed` are `gen_qa.py` questions with the program's answer.
- **general_thai**: a filtered subset of [airesearch/wangchanx-seed-free-synthetic-instruct-thai-120k](https://huggingface.co/datasets/airesearch/wangchanx-seed-free-synthetic-instruct-thai-120k) — MIT licence.
- **general_tools**: a converted subset of [NousResearch/hermes-function-calling-v1](https://huggingface.co/datasets/NousResearch/hermes-function-calling-v1) — Apache-2.0.

Rebuild: see `tools/dataset/README.md`. `manifest.json` lists counts, the mix, token lengths and what was dropped.
