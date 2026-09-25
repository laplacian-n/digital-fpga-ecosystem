# 06 — ความถูกต้อง (Oracle) และความทนทาน (Robustness)

> เกิดจากรีวิวแผนแม่บท (2026‑09‑16). แกนของเอกสารนี้ตอบคำถามเดียว:
> **"อะไรคือความจริงที่ใช้ตัดสินว่างานถูก?"** — คำตอบ: *oracle ที่สืบจาก spec และแก้ไม่ได้*
> ระบบเดิมมี **validator (ERC)** แต่ขาด **oracle** — เอกสารนี้เติมส่วนที่ขาด

---

## 1. Oracle Chain — สายโซ่ความจริง (สำคัญที่สุด)

ปัญหา failure mode อันดับ 1 ของ agentic loop: **AI แก้ testbench ให้ผ่าน แทนแก้วงจร**
ทางกัน: testbench ต้องสืบจาก spec และ **freeze (immutable)** ตั้งแต่ต้น

```
[SPEC] ── AI แปลง spec → oracle ──►  ORACLE ARTIFACT  (truth table / property assertions / vectors)
                                     • hash + freeze → AI แก้ไม่ได้อีก
                                     • เก็บเป็น spec_hash อ้างอิงทุก stage ถัดไป
   │
   ▼
[DRAW] ── JS‑sim รันวงจรที่วาด ── เทียบกับ ORACLE ──►  pass/fail
   │
   ▼
[VHDL] ── GHDL รัน VHDL ที่ gen ── เทียบกับ ORACLE เดิม ──►  pass/fail
   │                                        │
   └────────► CO‑SIM EQUIVALENCE ◄──────────┘
              JS‑sim waveform  ==  GHDL waveform  (บิตต่อบิต ทุก vector)
              ไม่ตรง = generator เพี้ยน → BLOCK ไม่ให้ไป BOARD
   │
   ▼
[BOARD]  ← เข้าได้เมื่อ: oracle ผ่านทั้งสองฝั่ง + co‑sim ตรง เท่านั้น
```

**นิยาม "SIM ผ่าน" (ชัดเจน):** ไม่ใช่ "ไม่ error" แต่คือ *output ตรง oracle ทุก test vector* และ *JS‑sim ตรง GHDL*

**Oracle มีได้หลายระดับ (เลือกตามงาน):**
- **Combinational:** truth table เต็ม (ถ้า input ≤ ~12 บิต) หรือชุด vector สุ่ม+ขอบเขต
- **Sequential/FSM:** ลำดับ input→expected‑output ตามรอบ clock + reset behavior
- **Property:** assertion (เช่น "one‑hot เสมอ", "counter ไม่ข้ามค่า", "7‑seg active‑LOW")
- AI *เสนอ* oracle, **ผู้ใช้ยืนยัน/แก้ก่อน freeze** (human‑in‑the‑loop ตรงจุดที่สำคัญสุด) — หลัง freeze แล้ว AI แตะไม่ได้

## 2. Content‑Hash Chaining — invalidation อัตโนมัติ

ทุก artifact ในทุก stage เก็บ hash ของ *input ต้นทาง*:

```
spec      → spec_hash
oracle    → {spec_hash, oracle_hash}          (ผูกกับ spec)
topdown   → {spec_hash, design_hash}
gate      → {design_hash, gate_hash}
sim_pass  → {gate_hash, oracle_hash, result}  ← ผูกกับ gate+oracle ที่ใช้ทดสอบ
vhdl      → {gate_hash, vhdl_hash}
bit       → {vhdl_hash, pin_hash, bit_hash}
```

กฎ: **ถ้า input_hash ปัจจุบัน ≠ hash ที่ stage เก็บไว้ → stage นั้นและทุก stage ถัดไป = `stale` อัตโนมัติ**
- แก้ Gate หลัง SIM ผ่าน → SIM กลับเป็น `stale` ทันที ไม่ค้าง `passed`
- เปลี่ยน spec → oracle ต้อง regenerate (เพราะ oracle_hash ผูก spec_hash)
- ทำให้ "ผ่านแล้ว" เชื่อถือได้เสมอ — ไม่มีสถานะโกหก

## 3. Pipeline State + Confidence Gate

แต่ละ stage: `pending → running → (passed | failed | stale)`
AI เดินตามลำดับ โดดข้ามไม่ได้ **และ**:

| เงื่อนไข | การตัดสิน |
|---|---|
| validator ผ่านรอบแรก + ERC 0 error + oracle ผ่าน | **auto‑continue** (ไม่รบกวนผู้ใช้) |
| retry ≥ 2 ครั้ง | **บังคับ human approve** |
| แตะ pin / clock / reset / PROM write | **บังคับ human approve** (irreversible/ฟิสิกส์) |
| co‑sim mismatch | **หยุด + รายงาน** (bug ใน generator, ไม่ใช่ให้ AI เดาต่อ) |

→ ผู้ใช้ไม่ต้องกดยืนยันทุกขั้น (กันล้าจนเลิกอ่าน) แต่จุดเสี่ยงบังคับให้ดู

## 4. Retry Policy — ไม่วนลูปตาย

- **max 3 retries/stage**
- แต่ละรอบต้องส่ง **error‑diff** เข้า context (สิ่งที่เปลี่ยน/ยังพัง) ไม่ใช่ error เดิมซ้ำ ๆ
- รอบ 3 ยังพัง → **escalate**: (ก) ขึ้น model ใหญ่ผ่าน escape hatch [ถ้าผู้ใช้เปิด] หรือ (ข) ถามมนุษย์ พร้อมสรุป *"ลองอะไรไปแล้วบ้าง + พังตรงไหน"*
- ทุก retry log ลง trace (ดูข้อ 7)

## 5. Semantic Validator ก่อน ERC เต็ม (กันโมเดลเล็กพังเงียบ)

Constrained JSON (GBNF) การันตีแค่ *รูปแบบ* ไม่ใช่ *ความหมาย* → เพิ่มด่านกลางที่ **ระดับ topology (ก่อน layout)** โดย **reuse subset ของ gate ERC**:
- port width match (บัสกว้างไม่เท่าปลายทาง)
- floating net / undriven input
- multiple driver บน net เดียว
- combinational loop
- clock/async‑control legality

ผิดที่ชั้นนี้ → reject‑with‑hint กลับให้ AI แก้ *ก่อน* เสียเวลา layout/VHDL
*(gate `runSynthesis` มี ~30 rules อยู่แล้ว — สกัดชุดที่ตรวจได้จาก netlist ล้วนมาใช้)*

## 6. Job Manager — Timeout / Cancel / Resource (in‑process, ไม่พึ่ง broker)

Vivado synth 10–40 นาที, GHDL อาจ loop ไม่จบ → subprocess ตรง ๆ ใน FastAPI จะ block + kill ไม่ได้

ออกแบบ (เบา เหมาะ single‑user offline — **ไม่ใช้ Celery/Redis**):
- async job manager ใน process เดียว (asyncio) — คิวงานหนัก (build/sim) ทีละ/จำกัด concurrency
- แต่ละ job รัน subprocess ใน **process group ของตัวเอง** → cancel = kill ทั้ง tree จริง
- **hard timeout ต่อ stage** (เช่น synth 10 นาที, ghdl 60 วิ) เกิน → kill + fail อย่างสุภาพ
- `POST /jobs/{id}/cancel`, `GET /jobs/{id}` (status/progress/log tail)
- **resource feedback:** หลัง synth ดึง utilization (LUT/FF/BRAM/DSP) + WNS กลับมาแสดง — XC7S15 มีจำกัด (≈8,000 LUT6 / 2,000 slice) เตือนตั้งแต่ DESIGN ถ้าจะเปลือง

## 7. Observability — Trace ทุก AI call (ลง SQLite)

เก็บทุกครั้งที่เรียก AI: `{ts, stage, prompt, grammar, raw_output, validation_result, retry_count, tokens, latency, accepted?}`
- หน้า **timeline viewer** ดูย้อนหลัง → debug เร็วขึ้นสิบเท่า
- เป็น **dataset สำหรับ fine‑tune ฟรี** (คู่ prompt→output ที่ผ่าน/ไม่ผ่าน)
- provenance: ทุก artifact ฝัง `manifest.json` = {spec_hash, model, prompt_version, oracle_hash, ts}

## 8. Workspace Manager — งาน build แยกกัน สะอาด GC ได้

- build ในdir แยกต่อ job: `C:\FPGA\ws\<job_id>\` (ASCII, ไม่มีช่องว่าง — กัน Vivado ล้ม)
- copy source เข้า, ดึง artifact (.bit/.log/report) ออกกลับ project, แล้ว **auto‑GC ตาม TTL** (ไม่ค้างเต็มดิสก์)
- **ไม่ symlink‑back** (เครื่องเดียว copy‑in/out พอ ลดจุดพัง)
- optimistic lock (ETag/revision) กัน 2 tab แก้โปรเจกต์เดียวชนกัน

## 9. Security (Hub รัน subprocess ตาม input — ต้องกัน RCE)

- **allowlist executable** (vivado.bat / ghdl / openFPGALoader เท่านั้น) — path มาจาก config ไม่ใช่จาก AI/HTTP
- **ห้าม `shell=True`** — ส่ง arg เป็น list เสมอ
- sanitize ทุก path (กัน traversal) — เหมือน `_Bridge` ของ topdown ที่เช็ค `.resolve().parent`
- **bind `127.0.0.1` เป็น default** (เปิด LAN เฉพาะเมื่อผู้ใช้สั่ง)
- AI ไม่มีสิทธิ์รันคำสั่งระบบ — ทำได้แค่เรียก tool ที่กำหนดผ่าน validated schema

## 10. Regression Suite — วัดว่า "ดีขึ้นจริงไหม" (Phase 1 ไม่ใช่ Phase 6)

ชุด **golden designs 20–30 ตัว** ไล่ระดับ: half‑adder → mux/decoder → comparator → counter+7‑seg → FSM (vending) → ALU 4‑bit
- แต่ละตัวมี: spec, oracle (frozen), expected netlist/waveform
- รัน **ทุกครั้งที่แก้ prompt/เปลี่ยนโมเดล/แก้ generator** → จับ regression ทันที
- นี่คือเครื่องมือเดียวที่ตอบได้ว่า fine‑tune แล้วดีขึ้นจริงหรือแย่ลง

## 11. ผลต่อ Roadmap (สลับลำดับตามรีวิว)

- **SIM + Oracle ขึ้นมาขนานกับ Phase 1** — เพราะ SIM คือ oracle ของทั้งระบบ ถ้ายังไม่มี AI orchestrator ใน Phase 4 จะไม่มีอะไรวัดผล
- **Regression suite + Observability = Phase 1** (รากฐานการวัด)
- **Training/hardening doc = living document** เขียนสะสมตลอดทาง ไม่ใช่มาเขียนตอนจบ

---

### สรุป: ลำดับความสำคัญของความถูกต้อง
1. **Oracle จาก spec + freeze** (ข้อ 1) — ถ้ามีข้อเดียว เอาข้อนี้
2. **Co‑sim equivalence** (ข้อ 1) — กัน generator เพี้ยนลงบอร์ด
3. **Hash‑chain invalidation** (ข้อ 2) — "ผ่านแล้ว" ต้องไม่โกหก
4. ที่เหลือ (retry/gate/validator/job/trace/security) = engineering ที่ทำให้ 1–3 ทำงานได้จริงและทน

---

# ภาคผนวก (รีวิวรอบ 2 — Opus5 + Sol, 2026‑09‑16)

## 12. แยก Co‑sim gate ออกจาก Oracle gate (common‑mode failure)

JS‑sim กับ GHDL สร้างจาก IR เดียวกัน → ถ้า **ดีไซน์** ผิด ทั้งคู่ผิดเหมือนกันและ "ตรงกัน" → หลอกตัวเอง
ต้องเป็น **2 gate แยก คนละ error code:**
- **Oracle gate** (เทียบกับ expected จาก spec) = จับบั๊กของ *ดีไซน์* → `ORACLE-FAIL`
- **Co‑sim equivalence gate** (JS‑sim เทียบ GHDL) = จับบั๊กของ *VHDL generator เท่านั้น* → `COSIM-*`
- ทั้งสองต้องผ่านคนละเหตุผล ห้ามยุบเป็น "SIM ผ่าน" ก้อนเดียว

## 13. Co‑sim Comparison Contract (แก้ "บิตต่อบิตทุก vector" ที่พังจริง)

GHDL = 9‑value (`U/X/Z/W/L/H/-`) + delta cycle; JS‑sim = 2‑state zero‑delay → เทียบดิบ = mismatch ทุกครั้ง
สัญญาเปรียบเทียบ:
- **เทียบที่ strobe point เท่านั้น** (หลัง clock edge + settle, ไม่ใช่ระหว่าง delta) — combinational glitch ไม่นับ
- **reset sequence บังคับ** ก่อนเริ่มเก็บผล (กัน cycle 0 = `U` ฝั่ง VHDL)
- **นโยบาย metavalue:** `X`/`U` ฝั่ง VHDL ที่ strobe = **mismatch เสมอ** (ไม่ใช่ don't‑care — ของจริงมันคือบั๊ก)
- **บัสกว้าง: ใช้ BigInt / bit‑vector library** ไม่ใช่ JS Number/bitwise (จำกัด signed 32‑bit)
- **canonical trace tuple:** `(strobe_index, signal_uid, logic_value, width)` → normalize ก่อนเทียบ
- signed/unsigned + overflow: นิยาม semantics กลางให้ตรงกันทั้งสองฝั่ง (JS‑sim ต้องเลียน VHDL ไม่ใช่ JS)

## 14. Oracle Amendment Protocol (immutable → deadlock ถ้า spec ผิด)

"แก้ไม่ได้" ผิด — "แก้ได้แต่ทิ้งร่องรอย และ AI แก้เองไม่ได้" ถูก:
- แก้ oracle ได้เฉพาะ **มนุษย์อนุมัติ** → bump `oracle_version` + บันทึกเหตุผลลง trace
- **invalidate ทุก stage ที่เคยผ่านด้วย oracle เวอร์ชันเก่า** อัตโนมัติ
- AI ทำได้แค่ *เสนอ* amendment (`ORACLE-AMEND-REQUIRED`, class policy) ห้ามแก้เอง

## 15. Coverage Strategy (truth table ระเบิด)

exhaustive ไม่ไหวเกิน ~16 บิต input / FSM+datapath:
- **directed corner cases** (carry chain, overflow, reset ระหว่างทำงาน, boundary)
- **constrained‑random** ด้วย **seed ที่บันทึก** (reproducible)
- **coverage threshold ขั้นต่ำ** เป็นเกณฑ์ผ่าน (ไม่ใช่ exhaustive อย่างเดียว)
- คู่กับ **mutation score** (ข้อ 19) เพื่อรู้ว่า vector ชุดนี้ "จับบั๊กได้จริงไหม"

## 16. Evidence‑based State (แทน "passed" ลอย ๆ)

แต่ละ stage เก็บ record:
```
stage_run { stage, input_digest, dependency_digest, environment_digest,
            toolchain_version, command_profile, started/finished,
            result, validation_evidence, artifact_digest, reviewer/approval }
```
"ผ่าน" ต้องมีหลักฐาน + reproducible input digest เสมอ (เกณฑ์ production ใน `README`/DoD)

## 17. Hash ให้ครบ (canonical + env + dependency)

```
H = SHA256( canonical(inputs) + dependency_digests + schema_ver
            + config + toolchain_versions + board_profile_hash )
```
- **canonicalization บังคับ** (ดู `08` §4) — sorted keys, fixed float
- **`env_hash`**: GHDL/Vivado version + model + prompt_version → อัปเกรด tool แล้ว `passed` เก่าต้อง stale
- ใช้ **semantic_hash** (ไม่ใช่รวม presentation) เป็นตัว invalidate (ดู `08` §5)

## 18. Control Plane / Execution Plane แยก + Durable Jobs

- **ไม่รัน GHDL/Vivado/programmer ใน process เดียวกับ API** — แยกเป็น **worker process** (multiprocessing/subprocess) บนเครื่องเดียว (ยัง**ไม่พึ่ง broker/Postgres** — SQLite พอ)
- ชั้น: API/Project · Pipeline Engine · **Durable Job Store (SQLite, persist state)** · Worker · Artifact Store (immutable) · Validation Service · AI Orchestrator (เสนอ patch เท่านั้น)
- **recovery:** ตอน startup อ่าน job ค้าง → resume หรือ mark‑orphaned (`JOB-ORPHANED`)
- **Windows kill:** `terminate()` ไม่ฆ่า child ของ Vivado → ใช้ **psutil kill process‑tree / Job Object** จริง
- **GPU semaphore:** inference ทีละ 1 (4050 6GB — ซ้อน = OOM), คิว inference **แยกจาก** Vivado/GHDL
- **quota:** CPU/RAM/disk/output‑size ต่อ job · จำกัดขนาด waveform/log · cancel แบบ idempotent · lock บอร์ด/Vivado license
- **global budget ต่อ job** (เวลา + token) — retry 3×6 stage×escalate กินหลาย ชม./แสน token ได้ → เกิน = fail อย่างมีศักดิ์ศรี + สรุปที่ลองไปแล้ว (`JOB-BUDGET-EXCEEDED`)

## 19. Retry Taxonomy + Mutation Testing

- retry จำแนกตาม **class ใน `07`** (transient→auto, deterministic→ส่งแก้พร้อม error‑diff, policy→หยุด, resource→escalate)
- รอบใหม่ต้อง **ต่างจากเดิมอย่างมีสาระ** (patch‑similarity check; เหมือนเดิม = `AI-PATCH-NODIFF` หยุด)
- **Mutation testing = KPI ของ "ตัวตรวจ":** ฉีดบั๊กจงใจ (สลับสาย, ลด bit‑width, ถอด reset, สร้าง comb‑loop) แล้ววัดว่า ERC/semantic/oracle **จับได้กี่ %** — golden ที่ถูกอย่างเดียวพิสูจน์ได้แค่ไม่ false‑positive

## 20. Verified‑Library‑First (lever ใหญ่สุดของโมเดล 6GB)

- RAG ตั้งเป้าให้ AI **เลือกโมดูลที่ผ่าน oracle แล้ว** ก่อนเสมอ แล้วค่อย generate เมื่อไม่มีของให้ใช้
- **ทุกโมดูลในคลังต้องมี oracle ของตัวเองติดมา** → ความแม่นกระโดดโดยไม่พึ่งโมเดลใหญ่
- RAG: chunk ตาม module boundary + metadata filter (bit‑width/family) + rerank (ห้าม pure vector)

## 21. AI Security & Path Security (ทำให้ชัด)

- AI: อ่านเฉพาะ artifact ที่ stage อนุญาต · ส่งได้แค่ **typed patch ตาม schema** · **ห้ามส่ง shell** · **ห้ามแก้ oracle/board/pin/clock ที่ freeze โดยไม่ approve** · **ห้าม set `passed`** · ทุก call ผูก model_ver+prompt_ver+input_hash
- **tool output / ข้อความใน project = untrusted input** (กัน prompt injection) — ไม่เชื่อคำสั่งที่ฝังมาในผลลัพธ์
- Path: **resolve canonical แล้วตรวจว่าอยู่ใต้ workspace root**, ปฏิเสธ `../`/absolute/symlink/zip‑slip, ระวัง TOCTOU, ห้ามเขียนทับ job อื่น
- exec: allowlist executable (path จาก config ไม่ใช่จาก AI/HTTP) · `shell=False` + argument validation + environment allowlist

## 22. Determinism ในการวัดผล + Definition of Done (ตัวเลข)

- บันทึกทุก call: `temperature, seed, model_hash, prompt_version` + วัด `retry_count / wall_time / tokens` (ไม่ใช่แค่ pass/fail) — ไม่งั้นรัน regression 2 ครั้งได้คนละผล
- **fine‑tune กัน model collapse:** hold‑out benchmark ที่**ไม่เคยเข้า training** + subset ที่มนุษย์ label; วัดบน benchmark แช่แข็งเท่านั้น
- **DoD ทุก Phase เป็นตัวเลข** เช่น "Phase AI ผ่านเมื่อ **≥70% ของ 30 golden designs ถึง SIM‑passed โดยมนุษย์ไม่ต้องแก้ netlist**" — ไม่มีตัวเลข = บอกไม่ได้ว่าดีขึ้น

## 23. ขอบเขต (สิ่งที่จงใจ *ไม่* ทำ — ตามบริบท single‑user/offline)

ไม่รับกรอบ SaaS multi‑tenant: **ไม่มี** authZ ระหว่างผู้ใช้, audit/retention เชิงองค์กร, PostgreSQL, backup/restore เป็น security boundary, full sandbox/container
- workspace isolation มีไว้เพื่อ **ความถูกต้อง** (job ไม่ชนกัน) ไม่ใช่กั้นผู้ใช้ที่ไม่ไว้ใจ
- RCE จริงเฉพาะเปิด LAN → **bind 127.0.0.1 + allowlist + no‑shell + path‑canonical** ครอบ threat จริงแล้ว
- redaction: แค่ไม่ log API key ของ escape‑hatch ก็พอ (ข้อมูลอื่นเป็นของผู้ใช้เอง)
- ทบทวนใหม่ได้ถ้าวันหนึ่งกลายเป็น multi‑user จริง
