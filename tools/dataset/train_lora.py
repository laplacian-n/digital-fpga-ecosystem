#!/usr/bin/env python3
"""QLoRA fine-tune of Qwen3.5-4B on tools/dataset/data — on one 16 GB GPU, without system RAM by default.

  # 0. once: the HF weights (the .gguf the app runs cannot be trained) + packages
  pip install "torch>=2.7" --index-url https://download.pytorch.org/whl/cu128      # RTX 50xx needs CUDA 12.8+
  pip install "transformers>=4.57" peft bitsandbytes accelerate safetensors
  pip install flash-linear-attention causal-conv1d      # kernels for the 24 linear-attention layers (else slow)
  huggingface-cli download Qwen/Qwen3.5-4B --local-dir ~/models/Qwen3.5-4B

  # 1. check the data as the model will see it (no GPU, no torch needed)
  python3 tools/dataset/train_lora.py --model ~/models/Qwen3.5-4B --dry-run

  # 2. pilot: the longest conversations, a few steps — peak VRAM, speed, time for the whole run
  python3 tools/dataset/train_lora.py --model ~/models/Qwen3.5-4B --pilot
  #    out of memory → --max-len 10240 or --offload (activations to system RAM: ~10–20 % slower)

  # 3. train, merge, convert to .gguf for llama-server / the app
  python3 tools/dataset/train_lora.py --model ~/models/Qwen3.5-4B --out runs/lora1 \
          --merge --gguf ~/llama.cpp

What is trained: every assistant turn the app's agent / Q&A mode would generate — tool calls and answers.
Not trained (context only): system prompt, tool schemas, user turns, tool results, the editor's greeting before
the first request, a planned mistake (`"train": false`), and the empty <think></think> the prompt supplies.
Logits are computed only at the trained positions (a 12k-token conversation × 248k vocabulary would need ~12 GB).
"""
import argparse
import gzip
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
# LoRA on the language model only — not the vision tower, not the MTP head; linear-attention and
# full-attention projections + MLP (in_proj_a / in_proj_b are tiny gates: left as they are)
TARGET = (r".*language_model\.layers\.\d+\.(self_attn\.(q_proj|k_proj|v_proj|o_proj)"
          r"|linear_attn\.(in_proj_qkv|in_proj_z|out_proj)|mlp\.(gate_proj|up_proj|down_proj))")
ASSIST = re.compile(r"<\|im_start\|>assistant\n(?:<think>\n\n</think>\n\n)?(.*?<\|im_end\|>)", re.S)


# ---------------------------------------------------------------- data
def load_rows(paths):
    rows = []
    for p in paths:
        op = gzip.open if str(p).endswith(".gz") else open
        with op(p, "rt", encoding="utf-8") as f:
            rows += [json.loads(l) for l in f if l.strip()]
    return rows


def chat_messages(r):
    """The row as the chat template wants it: tool-call arguments as objects (llama-server parses them the
    same way before rendering), no "train" key."""
    out = []
    for m in r["messages"]:
        m = {k: v for k, v in m.items() if k != "train"}
        if m.get("tool_calls"):
            calls = []
            for c in m["tool_calls"]:
                fn = dict(c["function"])
                if isinstance(fn.get("arguments"), str):
                    try:
                        fn["arguments"] = json.loads(fn["arguments"] or "{}")
                    except ValueError:
                        fn["arguments"] = {"_raw": fn["arguments"]}
                calls.append(dict(c, function=fn))
            m["tool_calls"] = calls
        out.append(m)
    return out


def encode(tok, r, app_tools, max_len):
    """→ (input_ids, labels) or (None, why). Labels are the token ids of trained assistant turns, else -100."""
    tools = app_tools if r.get("tools_ref") == "app" else r.get("tools")
    msgs = chat_messages(r)
    text = tok.apply_chat_template(msgs, tools=tools or None, tokenize=False, enable_thinking=False)
    first_user = next((i for i, m in enumerate(r["messages"]) if m["role"] == "user"), 0)
    assistants = [i for i, m in enumerate(r["messages"]) if m["role"] == "assistant"]
    spans = list(ASSIST.finditer(text))
    if len(spans) != len(assistants):
        return None, f"template gave {len(spans)} assistant turns for {len(assistants)}"
    keep = [(s.start(1), s.end(1)) for s, i in zip(spans, assistants)
            if i > first_user and r["messages"][i].get("train", True)]
    if not keep:
        return None, "nothing to train on"
    enc = tok(text, add_special_tokens=False, return_offsets_mapping=True)
    ids, offs = enc["input_ids"], enc["offset_mapping"]
    if len(ids) > max_len:
        return None, "longer than --max-len"
    labels, k = [-100] * len(ids), 0
    for t, (a, b) in enumerate(offs):
        while k < len(keep) and a >= keep[k][1]:
            k += 1
        if k < len(keep) and a >= keep[k][0] and b <= keep[k][1] and b > a:
            labels[t] = ids[t]
    if not any(x != -100 for x in labels):
        return None, "no trained tokens"
    return (ids, labels), None


def build(tok, args):
    files = [DATA / "train.jsonl.gz"] + ([DATA / "train_extra.jsonl.gz"] if args.extra else [])
    rows = load_rows(files)
    app_tools = json.load(open(DATA / "tools_app.json", encoding="utf-8"))
    data, why = [], {}
    for r in rows:
        x, w = encode(tok, r, app_tools, args.max_len)
        if x is None:
            why[w] = why.get(w, 0) + 1
        else:
            data.append((r["cat"], *x))
    return data, why


def report_data(data, why, tok=None, show=0):
    import collections
    by = collections.defaultdict(list)
    for cat, ids, lab in data:
        by[cat].append((len(ids), sum(x != -100 for x in lab)))
    print(f"{len(data)} conversations kept; dropped: {why or 'none'}")
    print(f"{'category':16s} {'rows':>5s} {'tokens median':>14s} {'max':>6s} {'trained/row':>12s}")
    for c, v in sorted(by.items(), key=lambda kv: -len(kv[1])):
        L = sorted(x[0] for x in v)
        print(f"{c:16s} {len(v):5d} {L[len(L) // 2]:14d} {L[-1]:6d} {sum(x[1] for x in v) / len(v):12.0f}")
    tot = sum(len(i) for _, i, _ in data)
    tr = sum(sum(x != -100 for x in l) for _, _, l in data)
    print(f"all: {tot} tokens, {tr} trained ({100 * tr / max(1, tot):.1f} %)")
    if tok and show:
        cat, ids, lab = random.Random(1).choice(data)
        print(f"\n--- what is trained in one {cat} row (between ⟦ ⟧) ---")
        out, on = [], False
        for t, l in zip(ids, lab):
            if (l != -100) != on:
                out.append("⟦" if not on else "⟧")
                on = not on
            out.append(tok.decode([t]))
        print("".join(out)[-show:])


# ---------------------------------------------------------------- training
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="HF folder (or hub id) of Qwen/Qwen3.5-4B")
    ap.add_argument("--out", default="runs/lora")
    ap.add_argument("--max-len", type=int, default=12288)
    ap.add_argument("--extra", action="store_true", help="also train on train_extra.jsonl.gz (larger, less balanced mix)")
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--alpha", type=int, default=32)
    ap.add_argument("--accum", type=int, default=16, help="conversations per optimizer step")
    ap.add_argument("--val", type=int, default=64, help="conversations held out for a validation loss")
    ap.add_argument("--eval-every", type=int, default=50, help="optimizer steps")
    ap.add_argument("--save-every", type=int, default=100, help="optimizer steps")
    ap.add_argument("--offload", action="store_true", help="keep activations in system RAM (longer context, ~10–20 %% slower)")
    ap.add_argument("--pilot", action="store_true", help="a few steps on the longest conversations: VRAM, speed, estimate; then stop")
    ap.add_argument("--dry-run", action="store_true", help="tokenize and report only (no GPU)")
    ap.add_argument("--resume", default=None, help="an adapter folder saved by this script (continues from its step)")
    ap.add_argument("--merge", action="store_true", help="after training: merge the adapter into bf16 weights (out/merged)")
    ap.add_argument("--gguf", default=None, help="llama.cpp folder: convert out/merged to .gguf and quantize (Q6_K)")
    ap.add_argument("--quant", default="Q6_K")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    random.seed(args.seed)
    out = Path(args.out)

    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.model)
    data, why = build(tok, args)
    report_data(data, why, tok, show=1500 if args.dry_run else 0)
    if args.dry_run:
        return

    import torch
    import torch.nn.functional as F
    from transformers import AutoModelForImageTextToText, BitsAndBytesConfig
    from peft import LoraConfig, get_peft_model, PeftModel

    assert torch.cuda.is_available(), "no CUDA GPU"
    torch.manual_seed(args.seed)
    q = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                           bnb_4bit_compute_dtype=torch.bfloat16, llm_int8_skip_modules=["visual", "mtp", "lm_head"])
    model = AutoModelForImageTextToText.from_pretrained(args.model, quantization_config=q, dtype=torch.bfloat16,
                                                        device_map={"": 0}, attn_implementation="sdpa")
    model.config.use_cache = False
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.enable_input_require_grads()
    step0 = 0
    if args.resume:
        model = PeftModel.from_pretrained(model, args.resume, is_trainable=True)
        step0 = json.load(open(Path(args.resume) / "trainer_state.json")).get("step", 0)
    else:
        model = get_peft_model(model, LoraConfig(r=args.rank, lora_alpha=args.alpha, lora_dropout=0.05,
                                                 target_modules=TARGET, task_type="CAUSAL_LM"))
    model.print_trainable_parameters()
    lm_head = model.get_output_embeddings()
    picked = {}

    def only_trained_positions(_m, inp):          # logits only where a label is (see the docstring)
        return (inp[0][:, picked["pos"], :],)
    lm_head.register_forward_pre_hook(only_trained_positions)

    def loss_of(ids, lab):
        x = torch.tensor([ids], device="cuda")
        y = torch.tensor(lab[1:], device="cuda")
        pos = (y != -100).nonzero().squeeze(1)       # position t predicts token t+1
        picked["pos"] = pos
        ctx = torch.autograd.graph.save_on_cpu(pin_memory=True) if args.offload else _null()
        with ctx, torch.autocast("cuda", dtype=torch.bfloat16):
            logits = model(input_ids=x, attention_mask=torch.ones_like(x), use_cache=False).logits
        return F.cross_entropy(logits[0].float(), y[pos], reduction="sum"), len(pos)

    params = [p for p in model.parameters() if p.requires_grad]
    try:
        import bitsandbytes as bnb
        opt = bnb.optim.PagedAdamW8bit(params, lr=args.lr, weight_decay=0.0)
    except Exception:
        opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.0)

    if args.pilot:
        longest = sorted(data, key=lambda d: -len(d[1]))[:6]
        torch.cuda.reset_peak_memory_stats()
        t0, ntok = None, 0
        for i, (_, ids, lab) in enumerate(longest):
            if i == 1:
                torch.cuda.synchronize()
                t0, ntok = time.time(), 0
            try:
                loss, n = loss_of(ids, lab)
                (loss / max(1, n)).backward()
            except torch.cuda.OutOfMemoryError:
                print(f"OUT OF MEMORY at {len(ids)} tokens — try --offload, or --max-len {len(ids) - 2048}")
                return
            ntok += len(ids)
        opt.step()
        opt.zero_grad(set_to_none=True)
        torch.cuda.synchronize()
        dt = time.time() - t0
        tps = ntok / dt
        tot = sum(len(i) for _, i, _ in data) * args.epochs
        gb = torch.cuda.max_memory_allocated() / 2**30
        print(f"\nPILOT  longest {len(longest[0][1])} tokens  peak VRAM {gb:.1f} GB "
              f"(reserved {torch.cuda.max_memory_reserved() / 2**30:.1f} of {torch.cuda.get_device_properties(0).total_memory / 2**30:.1f} GB)  "
              f"{tps:.0f} tokens/s  offload={'on' if args.offload else 'off'}")
        print(f"       whole run ({args.epochs:g} epochs, {len(data)} conversations): about {tot / tps / 3600:.1f} h")
        return

    random.shuffle(data)
    val, train = data[:args.val], data[args.val:]
    steps = math.ceil(len(train) * args.epochs / args.accum)
    warm = max(1, int(0.03 * steps))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / steps))))
    for _ in range(step0):
        sched.step()
    out.mkdir(parents=True, exist_ok=True)
    log = open(out / "train_log.jsonl", "a", encoding="utf-8")

    def validate():
        model.eval()
        s = n = 0
        with torch.no_grad():
            for _, ids, lab in val:
                l, k = loss_of(ids, lab)
                s, n = s + l.item(), n + k
        model.train()
        return s / max(1, n)

    def save(tag):
        d = out / tag
        model.save_pretrained(d)
        json.dump({"step": step, "args": vars(args)}, open(d / "trainer_state.json", "w"), indent=1)

    order = [train[i % len(train)] for i in range(int(len(train) * args.epochs))]
    random.shuffle(order)
    model.train()
    step, t0 = step0, time.time()
    print(f"{len(train)} train / {len(val)} val conversations, {steps} optimizer steps of {args.accum}; val loss before: {validate():.4f}")
    for b in range(step0 * args.accum, len(order), args.accum):
        batch = order[b:b + args.accum]
        n_all = sum(sum(x != -100 for x in lab[1:]) for _, _, lab in batch)
        tot = 0.0
        for _, ids, lab in batch:
            loss, _ = loss_of(ids, lab)
            (loss / n_all).backward()               # mean over every trained token of the step
            tot += loss.item()
        torch.nn.utils.clip_grad_norm_(params, 1.0)
        opt.step()
        sched.step()
        opt.zero_grad(set_to_none=True)
        step += 1
        rec = {"step": step, "loss": round(tot / n_all, 4), "lr": sched.get_last_lr()[0],
               "elapsed_min": round((time.time() - t0) / 60, 1), "vram_gb": round(torch.cuda.max_memory_allocated() / 2**30, 1)}
        if step % args.eval_every == 0 or step == steps:
            rec["val_loss"] = round(validate(), 4)
        if step % args.save_every == 0:
            save(f"step{step}")
        log.write(json.dumps(rec) + "\n")
        log.flush()
        eta = (time.time() - t0) / max(1, step - step0) * (steps - step) / 3600
        print(f"step {step}/{steps}  loss {rec['loss']:.4f}" + (f"  val {rec['val_loss']:.4f}" if "val_loss" in rec else "")
              + f"  {rec['vram_gb']} GB  ETA {eta:.1f} h", flush=True)
    save("adapter")
    print(f"adapter → {out / 'adapter'}")
    del model, opt
    torch.cuda.empty_cache()
    if args.merge or args.gguf:
        merge_and_convert(args, out)


def merge_and_convert(args, out):
    import torch
    from transformers import AutoModelForImageTextToText
    from peft import PeftModel
    base = AutoModelForImageTextToText.from_pretrained(args.model, dtype=torch.bfloat16, device_map={"": "cpu"})
    merged = PeftModel.from_pretrained(base, out / "adapter").merge_and_unload()
    md = out / "merged"
    merged.save_pretrained(md, safe_serialization=True)
    src = Path(args.model)
    for f in ("tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "vocab.json", "merges.txt",
              "preprocessor_config.json", "video_preprocessor_config.json", "generation_config.json"):
        if (src / f).exists():
            shutil.copy(src / f, md / f)
    print(f"merged → {md}")
    if not args.gguf:
        return
    lc = Path(os.path.expanduser(args.gguf))
    f16 = out / "model-bf16.gguf"
    final = out / f"model-{args.quant}.gguf"
    subprocess.run([sys.executable, str(lc / "convert_hf_to_gguf.py"), str(md), "--outfile", str(f16), "--outtype", "bf16"], check=True)
    qbin = next((p for p in (lc / "build/bin/llama-quantize", lc / "llama-quantize", lc / "build/bin/Release/llama-quantize.exe") if p.exists()), None)
    if qbin is None:
        print(f"llama-quantize not found under {lc} — {f16} is ready, quantize it yourself")
        return
    subprocess.run([str(qbin), str(f16), str(final), args.quant], check=True)
    print(f"\n.gguf → {final}\nmeasure it (same tasks as the baseline):\n"
          f"  node tools/dataset/run.js --eval-model {final} --llama ~/llama.cpp/build/bin/llama-server \\\n"
          f"       --tasks tools/dataset/data/eval_tasks.jsonl.gz --out eval_lora --per-cat 10 --budget 300\n"
          f"  ~/llama.cpp/build/bin/llama-server -m {final} --jinja --port 8080 &\n"
          f"  OR_KEY=… python3 tools/dataset/eval_qamode.py --tasks tools/dataset/data/eval_qamode.jsonl.gz --out qamode_lora.jsonl")


class _null:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


if __name__ == "__main__":
    main()
