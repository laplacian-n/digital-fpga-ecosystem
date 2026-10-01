# Sources and licences

- **Program-generated rows** (`cat` = nl_logic, nl_fsm, nl_fix, nl_compose, nl_pins, qa): written by `tools/dataset/*.py`
  through the app's agent loop and checked by the app; same licence as this repository.
- **general_thai**: a filtered subset of [airesearch/wangchanx-seed-free-synthetic-instruct-thai-120k](https://huggingface.co/datasets/airesearch/wangchanx-seed-free-synthetic-instruct-thai-120k) — MIT licence.
- **general_tools**: a converted subset of [NousResearch/hermes-function-calling-v1](https://huggingface.co/datasets/NousResearch/hermes-function-calling-v1) — Apache-2.0.

Rebuild: see `tools/dataset/README.md`. `manifest.json` lists counts, the mix, token lengths and what was dropped.
