# AI system — complete stack (model → RAG → pipeline → gencode → anti-hallucination)

> เป้าหมาย: NL spec → วงจรที่ **พิสูจน์แล้วว่าถูก** → VHDL สังเคราะห์ได้ โดย LLM
> ทำแค่ topology; ทุก geometry/logic/code ที่เชื่อถือได้มาจาก engine deterministic

## ชิ้นส่วน (ทั้งหมดอยู่ใน `ai/`)
| ไฟล์ | บทบาท |
|---|---|
| `llama/llama-server.exe` + `models/*.gguf` | **model** — Qwen2.5-Coder 3B/7B ผ่าน llama.cpp (OpenAI-compatible) |
| `grammar/intent.gbnf` | **GBNF** บังคับ output เป็น Intent-JSON (ตัด x/y/pts ระดับ token) |
| `rag/` (`build_index.py`,`retriever.py`,`index.jsonl`) | **RAG** — BM25 + metadata + verified-first (9,224 recs) |
| `intent_validate.py` | **ERC gate** — มิเรอร์ `validateIntent()` ของ editor |
| `netlist_sim.py` | **simulator** — Intent → truth table (ground truth ของ logic) |
| `boolexpr.py` | **oracle-from-spec** — parse boolean equations → truth table (unit-tested vs sympy) |
| `gen_vhdl.py` | **gencode** — Intent → VHDL สังเคราะห์ได้ แบบ deterministic |
| `cosim.py` + `tools/ghdl/` | **co-sim** — GHDL 6.0 คอมไพล์+จำลอง VHDL เทียบ netlist_sim บิตต่อบิต |
| `gen_xdc.py` + `board/board_profile.json` | **constraints** — map พอร์ต→ขาบอร์ด EDGE Spartan-7 ออก .xdc |
| `push_to_editor.py` | **AI→editor bridge** — โหลด gate editor headless, `drawIntent` (router จริงทำ geometry) → เซฟ .schproj.json + guarantees |
| `synth_vivado.py` | Vivado synth/impl→.bit (ต้อง C:\vivado_min ASCII) |
| `intent_client.py` | คุย LLM + GBNF + RAG + validate→retry |
| `pipeline.py` | **orchestrator** — บังคับสเตจ-gate + oracle + รวม evidence |

## Pipeline ที่บังคับเป็นสเตจ (แต่ละสเตจต้องผ่านถึงไปต่อ)
```
spec ─▶ [1 retrieve] RAG (verified-library-first)
     ─▶ [2 generate] ถ้า spec มีสมการ → SYNTH ตรง (ถูก 100%); ไม่งั้น LLM + GBNF → Intent-JSON
     ─▶ [3 validate] ERC (validateIntent)                GATE — ผิด→reject
     ─▶ [4 simulate] netlist → truth table               GATE — ต้อง sim ได้ (ไม่ลอย/ไม่วน)
     ─▶ [5 verify]   equivalence กับ oracle                GATE — ไม่ตรง→reject
                     (oracle: explicit > golden ในคลัง > สมการที่สกัดจาก spec เอง)
     ─▶ [6 codegen]  Intent → VHDL (deterministic) + XDC pin map + _build.tcl
     ─▶ [6b cosim]   GHDL คอมไพล์+จำลอง VHDL เทียบ netlist_sim บิตต่อบิต  GATE (codegen self-check)
     ─▶ [6b2 draw]   (use_editor) push intent → gate editor headless → router จริงวาด → .schproj.json (guarantees 0)
     ─▶ [6c synth]   (use_synth) Vivado จริง (C:\vivado_min): synth→impl→**.bit** สำหรับ xc7s15
     ─▶ [7 gate]     status = VERIFIED | VALID_UNVERIFIED | REJECTED  (+ evidence ทุกสเตจ)
         out/: <name>.vhd + .xdc + _build.tcl + .bit  →  โปรแกรมลงบอร์ด (FPGA_Builder/openFPGALoader)
```

## ระบบกันหลอน (ซ้อนหลายชั้น)
1. **GBNF** — โครงสร้างผิดเป็นไปไม่ได้ตั้งแต่ decode
2. **ERC** (`validate_intent`) — net ชี้ขาไม่มีจริง / gate ไม่มี input ฯลฯ → reject + hint
3. **RAG verified-first** — ป้อนสมการ/โครงที่ตรวจแล้วเป็นบริบท (ลดการเดา logic)
4. **Simulation** — ไม่เชื่อคำอ้างของโมเดล วัด truth table จริงจาก netlist
5. **Oracle/equivalence** — เทียบกับ oracle-from-spec หรือ golden ในคลัง → จับ logic หลอน
6. **Retry** — ป้อน error กลับให้แก้เฉพาะจุด (targeted)
7. **Deterministic codegen** — LLM ไม่เคยเขียน VHDL เอง → โค้ดหลอนไม่ได้
8. **Co-sim (GHDL)** — จำลอง VHDL ที่ออกมาบน simulator จริง เทียบ netlist_sim บิตต่อบิต
   (วิธี verify อิสระตัวที่ 2 — จับบั๊ก codegen ถ้ามี)

## ผลทดสอบ (2026-09-17)
- **offline** (golden/inline + oracle): full_adder → VERIFIED, half_adder → VERIFIED,
  full_adder ที่จงใจต่อผิด → **REJECTED ที่สเตจ verify** (จับหลอนได้ 4/8 แถวไม่ตรง)
- **end-to-end ผ่าน LLM (7B+RAG)**: NL "full adder..." → generate(1 attempt) → validate ok
  → simulate 8 แถว → verify oracle 8/8 → codegen → **VERIFIED** เขียน `out/full_adder.vhd`
  (โค้ด: sum=a⊕b⊕cin, cout=ab+(a⊕b)cin — ถูกต้อง สังเคราะห์ได้)

## วิธีรัน
```
# 1) start model
cd ai\llama
.\llama-server.exe -m ..\models\qwen2.5-coder-7b-instruct-q4_k_m.gguf --port 8080 --host 127.0.0.1 -ngl 20 -c 4096
# 2) full pipeline (NL -> verified VHDL)
cd ..  &&  set PYTHONUTF8=1
py -3.10 pipeline.py "full adder a b cin -> sum cout" --module full_adder --out out
# offline (ไม่ใช้ LLM): ป้อน intent ตรง ๆ
py -3.10 pipeline.py --intent some.intent.json --module foo --out out
```

## เทสต์ auto-oracle (2026-09-17)
- full adder & mux2 (ผ่านสมการใน spec, ไม่ต้องมี golden) → VERIFIED
- **วงจรใหม่ผ่าน LLM**: NL mux2 → generate → sim → auto-oracle จากสมการ spec 8/8 → VERIFIED `out/mux2_ai.vhd`
- mux ที่ต่อผิด → REJECTED (จับหลอนได้) · parser unit-tested เทียบ sympy ผ่านหมด

## co-sim (2026-09-18) — DONE
GHDL 6.0 mcode ลงที่ `ai/tools/ghdl/` (bundled vivado_min XSim ใช้ไม่ได้ — ตัด precompiled IEEE).
`cosim.py` gen DUT+TB → `ghdl -a/-e/-r` → เทียบ netlist_sim. full_adder/mux ผ่าน 8/8.
ต่อเข้า pipeline เป็นสเตจ 6b (default `use_cosim=True`; ถ้าไม่มี GHDL จะ skip ไม่ fail).
capstone: NL full adder → generate→validate→simulate→verify→codegen→**cosim** ทุกสเตจเขียว.

## sequential (DFF) — DONE (2026-09-18, Intent v2)
เพิ่ม `DFF` (rising-edge, ขา d + optional en/arst, out=q, clock เดียว implicit).
- `netlist_sim.simulate_sequential()` จำลองแบบมี feedback (q=state, คำนวณ comb, แล้วอัปเดต state ขอบขาขึ้น)
- `gen_vhdl` ออก clocked process + พอร์ต `clk`; `validate` เพิ่มกฎ DFF (ต้องมีขา d, ขาที่ใช้ได้ d/en/arst); GBNF เพิ่ม `DFF`
- `cosim` มี TB แบบมี clock + **ขับ input sequence** จำลองหลาย cycle เทียบลำดับ output; pipeline verify ด้วย `expect=[ลำดับ int/cycle]`, `input_seq=[{ในแต่ละ cycle}]`
- **วงจรมี input**: FSM (sequence detector "11"), counter ที่มี **async reset/enable ผ่าน IN port** — ครบสาย sim→codegen→cosim
- **co-sim จับบั๊กจริง**: netlist_sim เดิม model async reset แบบ sync; GHDL (async) ไม่ตรง → แก้ให้ async ถูก (2-pass: อ่าน control → apply reset ทันที → eval output) แล้วตรงกัน
- **เทสต์**: counter, detect11, counter+reset offline (VERIFIED+cosim) + counter **ผ่าน LLM** (NL→VERIFIED) → `out/counter2_ai.vhd`

## 2 โหมด generation + verify-retry + auto-oracle (2026-09-18)
- **synth จากสมการ** (`synth.py`): spec มีสมการ → สร้างวงจรตรงจาก AST (boolexpr) ถูก 100% ไม่ใช้ LLM.
  ทดสอบ: full adder, majority → VERIFIED + cosim.
- **NL ล้วน → LLM** + **verify-retry loop**: verify ไม่ผ่าน → ป้อน row ที่ผิดกลับ + เพิ่ม temperature แล้ว generate ใหม่ (สูงสุด max_retries).
- **auto-oracle 3 ทาง**: spec-equations > corpus-golden > **LLM-derived-equations** (call แยก, คนละ representation) → cross-check วงจรจาก NL ล้วนได้.
- พิสูจน์ fail-safe: 3-in majority (NL) ที่ 7B วาดผิด → oracle จับได้ทุกครั้ง → **REJECTED ไม่ปล่อยโค้ดผิด** (โมเดลเล็กแก้เคสนี้ไม่ได้ แต่ระบบไม่หลอนออกมา). ถ้าให้สมการมา → synth ถูกเป๊ะ.

## Board / constraints (2026-09-18)
- `board/edge_spartan7.xdc` (จากผู้ใช้) → `board/parse_xdc.py` → `board/board_profile.json`
  (part xc7s15ftgb196-1, clk H11 50MHz, sw16/led16/pb5/digit4/Seven_Segment8/LCD/VGA/ADC/DAC/UART...).
- `gen_xdc.py` auto-map: clk→H11, reset/btn→pb (pulldown), inputs→sw, outputs→led + clock constraint.
  pipeline ออก `.vhd` + `.xdc` คู่กันใน out/. ทดสอบ counter+reset → xdc ถูก (clk H11, rst pb[0] J13, q led).
- board เข้า RAG แล้ว (group `board`, 61 records: overview + ต่อ peripheral). retriever `--group board`.
- NOTE: 3 URL allaboutfpga โดน Cloudflare bot-check → ดึงอัตโนมัติไม่ได้ (ไม่ผ่าน bot-detection ตามข้อห้าม);
  ข้อมูล pin details ครอบคลุมด้วย .xdc แล้ว. ถ้าต้องการเนื้อหาหน้าเว็บ ให้ save เป็นไฟล์/PDF ใส่โปรเจกต์แล้วผม ingest ให้.

## Vivado synth → .bit WORKS (2026-09-18)
**แก้แล้ว**: ย้าย `vivado_min` → `C:\vivado_min` (ASCII) แล้ว Vivado อ่าน XILINX.lib ได้ synth ผ่าน.
- full_adder synth: LUT=1, IO=5 · counter2 **full impl → .bit จริง 538KB** (LUT=1, FF=2, IO=3)
- `synth_vivado.py` default ชี้ `C:\vivado_min` แล้ว (env `VIVADO_BIN`/`XILINX_LIC` override ได้); launch ผ่าน PowerShell Start-Process
- pipeline `use_synth=True, synth_mode="bit"` → ออก `.bit` ลง out/ ครบ **spec→board**
- (ต้นฉบับใต้ path ไทยยัง synth ไม่ได้ — ใช้ copy ที่ C:\ เท่านั้น)

## Build handoff → board (2026-09-18)
- pipeline ออก **package พร้อม build**: `<name>.vhd` + `.xdc` + `_build.tcl` (synth→impl→write_bitstream, part xc7s15ftgb196-1) ใน `out/`
- `synth_vivado.py` (ทดลอง): เรียก Vivado ผ่าน **PowerShell Start-Process + 8.3 short path** (cmd.exe พัง Thai path). ผ่าน signature/launch แล้ว **license xc7s15 ได้ (WebPACK)** แต่ synth **fail: "Failed to read library XILINX.lib"** เพราะ Vivado อ่าน data file ใต้ physical Thai path ไม่ได้ (codepage) — short path/junction ไม่ช่วย (resolve ไป physical เสมอ). **สรุป: Vivado synth รันไม่ได้เมื่อ install ใต้ path ที่ไม่ใช่ ASCII**. แก้: ย้าย `vivado_min` (11GB) ไป path ASCII แล้วตั้ง env `VIVADO_BIN`/`XILINX_LIC` (synth_vivado รองรับแล้ว)
- **ทางที่ใช้จริง**: ส่ง package ให้ **FPGA_Builder** (แอปที่มีอยู่ ทำ VHDL→.bit + โปรแกรมลงบอร์ดผ่าน JTAG ได้) — เป็น build stage ตามสถาปัตยกรรม pipeline `use_synth=True` เรียก synth_vivado ได้ (default ปิด)

## ยังขาด / ต่อยอด
- multi-bit bus/register (ตอนนี้ net เป็น 1 บิต), state-encoding อัตโนมัติสำหรับ FSM หลาย state
- แก้ Vivado signature (หรือใช้ Vivado เต็มนอก bundle) ให้ synth/bit อัตโนมัติในระบบ
- ต่อ Intent → editor (`drawIntent`) เป็น pipeline เต็ม spec→draw→sim→VHDL→xdc→(FPGA_Builder)→board
```
