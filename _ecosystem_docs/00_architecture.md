# 00 — สถาปัตยกรรมหลัก (Master Plan)

> เอกสารนี้คือ "north star" ของโปรเจค — แนวทางภาพรวมที่ตกลงกับผู้ใช้เมื่อ 2026-09-16
> รายละเอียดเชิงลึกของแต่ละโปรแกรมอยู่ใน `01_*`, `02_*`, `03_*`, `04_*` (เขียนโดย Sonnet 5 ทำงานขนาน)

---

## 1. เป้าหมาย (หนึ่งประโยค)

รวม 3 เครื่องมือให้เป็น **ecosystem เดียว** ที่พา flow งานดิจิทัลตั้งแต่ *โจทย์ → ออกแบบ → วาด → sim → VHDL → ลงบอร์ด* โดยมี **local AI** ช่วยลงมือทำทุกขั้น บนบอร์ดเดียวคือ **EDGE Spartan‑7 (XC7S15, ftgb196, Vivado)**

## 2. ปรัชญา (ข้อบังคับที่กำหนดทุกการตัดสินใจ)

1. โปรแกรมน้อยที่สุด — ให้ดีคือรู้สึกเหมือนใช้ตัวเดียว
2. AI ไม่ใช่แค่ถามตอบ แต่ **ลงมือทำ/แก้/แนะนำ** ได้ทั้ง pipeline
3. ระบบต้อง **ทน ไม่บัค ไม่แครช**
4. สมมติว่า AI ตัวเล็ก **ผิดพลาดง่าย** → ระบบต้องรัดกุมและ scaffold AI อย่างหนัก

## 3. สถาปัตยกรรมเป้าหมาย

```
                        ┌─────────────────────────────────────────────┐
                        │            PYTHON HUB  (backend เดียว)        │
                        │   โตจาก fpga_builder.py — เป็นศูนย์กลางทุกอย่าง │
                        │                                              │
   Browser UI  ◄──HTTP──┤  • Static/UI server (เสิร์ฟ 2 view)          │
   (เว็บเดียว 2 โหมด)     │  • Project store   (data model กลาง + ไฟล์)   │
   ┌──────────────┐     │  • Module library + RAG index               │
   │ Top‑Down view│     │  • Pipeline engine + Guardrails (สถานะ+สิทธิ์)│
   │ Gate view    │◄────┤  • AI orchestrator  ──► OpenAI‑compat endpoint│──► llama.cpp / Ollama
   │ AI chat panel│     │  • Sim service      ──► JS‑sim result / GHDL  │──► GHDL
   │ Pipeline HUD │     │  • Build service    ──► Vivado → .bit         │──► vivado_min
   └──────────────┘     │  • Program service  ──► openFPGALoader        │──► บอร์ด (ft2232)
                        └─────────────────────────────────────────────┘
```

**หลักการ:** UI ทุกอย่าง action ทุกอย่าง วิ่งผ่าน Hub ตัวเดียว. HTML ไม่ทำงานหนักเอง (มันรัน Vivado/LLM/process ไม่ได้) — มันเป็นแค่ view + ส่งคำสั่งไป Hub.

## 4. Pipeline (แกนของ ecosystem + จุดที่ AI ทำงาน)

```
[0] SPEC        กำหนดโจทย์ + ข้อบังคับ   ── AI ถามจนได้ข้อสรุป (Q&A gate)
      │
[1] DESIGN      สถาปัตยกรรม/แตกโมดูล      ── topdown view · AI เสนอ block/layer
      │
[2] DRAW        วาดวงจร gate‑level        ── gate view · AI ออก topology เท่านั้น →
      │            ELK layout+router คิดพิกัด/สายเอง · ERC เช็คทันที (ดู 05)
      │            (สองทาง: วาด→โค้ด, โค้ด→วาด — ทดลองว่าทางไหนดีสุด)
[3] SIM ★        ตรวจความถูกต้อง           ── JS‑sim (ใน loop) + GHDL (ก่อน build) · ต้องผ่านก่อนไป [4]
      │            gate บังคับ: ห้ามลงบอร์ดถ้าไม่ผ่าน sim
[4] VHDL        แปลงเป็นโค้ด               ── generateVHDL (มีอยู่แล้ว) · AI ตรวจ/ปรับ
      │
[5] BOARD       ลงบอร์ด                   ── Vivado build → .bit → program (มีอยู่แล้วใน fpga_builder)
```

ทุก stage มี **สถานะ** (pending/running/passed/failed) ที่ user เห็นเป็น HUD และ AI ต้องเดินตามลำดับ — ดูข้อ 6.

## 5. กลยุทธ์ Data Model กลาง (เริ่มจากตรงนี้ก่อน)

> ⚠️ **ปรับตามรีวิวรอบ 2:** envelope เป็น *ภาชนะ* แต่ **semantic core = Canonical IR** (ดู `08_canonical_ir.md`)
> ล็อก: **gate netlist = source of truth เดียว, top‑down = projection, VHDL/JS‑sim จาก IR** · แยก **semantic_hash / presentation_hash**

ปัญหา: ตอนนี้มี **3 data model แยกกัน** (gate schematic / topdown node / fpga_builder config). ต้องมี schema กลางที่เชื่อมทั้งหมด โดย **ไม่รื้อของเดิมทิ้ง** (ของเดิมทำงานได้ดีและลึก)

แนวทาง:
- **Project envelope กลาง** (JSON) = { meta, spec, topdown{...}, gate{...}, vhdl{...}, pins{...}, sim{...}, pipeline_state{...} } — ห่อของเดิมไว้ ไม่แปลงรูปของเดิม
- ของเดิมแต่ละตัวยังคง native format ของมัน — Hub ทำหน้าที่ **map/refine** ระหว่างชั้น (topdown block → gate sheet)
- **Module library** = คลังชิ้นส่วนที่ทั้ง topdown/gate/VHDL อ้างถึงด้วย id เดียวกัน พร้อม: สัญลักษณ์วาด, พอร์ต, VHDL template, testbench/known‑good vector สำหรับ sim
- ยึด pattern ที่มีอยู่แล้วเป็นแม่แบบ: `topdown_mcp.save_design()` (validate + reject‑with‑hint) และ `runSynthesis()` (ERC rule) — ทั้งคู่คือด่านกัน AI พังที่ควรนำมาใช้ซ้ำ

### รูปแบบ native ของแต่ละตัว (ยืนยันจาก doc 01–04)

**Gate editor** — localStorage `schstudio.autosave.v2` (ทุก 4s), ไฟล์ `.schproj.json`:
```
{ version:2, workspace:{projects:{pid:Project}, activeId}, project, activeId, openTabs }
Project = { id, name, topId, schematics:{schId:Sheet}, customs:{name:CustomComponent} }
Sheet   = { id, name, components:[Component], wires:[Wire] }
Component = { id, type, x, y, params, label?, rot?, mirror? }
          type = TYPES key | "SCH:<schId>" (instance sheet) | "CUSTOM:<name>"
Wire    = { id, from:{cid,pid}, to:{cid,pid}, name?, pts?, autoPts? }  // width ไม่เก็บ — derive ตอนอ่าน
```
- id มาจาก `uid()` global counter เดียว; `sanId()` = sanitizer ชื่อ VHDL
- net name อยู่ที่ `wire.name` (ไม่มี type NETNAME แยก)
- SCH instance ดึงพอร์ตสดจาก IN/OUT ของ child sheet ผ่าน `schPortList()`

**Topdown editor** — ไฟล์/`designs/*.json` + `latest.json`:
```
{ meta:{projectName,studentId,studentName,section,page}, sheets:[Sheet] }
Sheet = { title, module, frame:{x,y,w,h}, nodes:[Node], wires:[Wire] }
Node  = flat { id, type:block|gate|mux|port|const, x, y, ...ตาม type }
        block: label, pinsL/R/B/T[]   gate: gate,inputs   mux: label
        port: name,side,bus            const: value
Wire  = { from:{node,pin}, to:{node,pin}, bus:0|n }
```
- pin id คำนวณจากกล่อง+side (ไม่ authored): block L0/R0/B0/T0, gate in0/out, mux d0/d1/sel/out, port/const `p`
- width เป็น advisory (จากชื่อ `Name[3:0]` หรือ `wire.bus`) — ต่างจาก gate ที่เป็น numeric จริง
- `fromLoose()` = loader ยืดหยุ่น (HTML), `_validate_sheet()` = strict + เช็คทุก wire endpoint (MCP)

**FPGA_Builder** — `fpga_builder.json`:
```
{ board, part, pkg, speed, top, clk, period, cable, vhdl:[], pins:[], ise, vivado, ofl }
```
- `BOARDS["edge"]` = xc7s15/ftgb196/-1/Vivado **พร้อมแล้ว** (เหลือเติม pin table ของบอร์ด EDGE)
- build: `vivado -mode batch -source build.tcl` (ผ่าน Task Scheduler — artifact ของ .exe)

### สายโซ่ refinement (สรุปความต่างที่ต้องข้าม)
```
topdown block (opaque, pin นามธรรม, width=ข้อความ)
   │  ← ขั้น refinement จริง (ไม่ lossless)
gate component/sheet (typed, param, width numeric, netlist จริง)
   │  ← generateVHDL (มีอยู่แล้ว) + layout stamp base64 ใน comment (round-trip ได้)
VHDL entity
   │
FPGA_Builder (pin map → .bit → board)
```

## 6. Scaffolding กัน AI ตัวเล็ก hallucinate (หัวใจของความทนทาน)

| เทคนิค | ทำอะไร |
|---|---|
| **Pipeline state machine** | AI ทำได้เฉพาะ action ที่ stage ปัจจุบันอนุญาต โดดข้ามไม่ได้ |
| **Constrained decoding (GBNF)** | บังคับ output ของ AI ให้เป็น JSON ตรง schema เป๊ะ (จุดแข็งของ llama.cpp) |
| **Validate‑then‑apply** | ทุก output ผ่าน validator (แบบ save_design/ERC) ถ้าไม่ผ่าน → คืน error ให้ AI แก้ ไม่บันทึกของพัง |
| **Targeted edit เท่านั้น** | AI แก้เฉพาะ node/บรรทัดที่เกี่ยว ห้าม rewrite ทั้งไฟล์ (diff‑based/patch‑based) |
| **Locate‑then‑ask** | user แจ้งปัญหา → AI วินิจฉัยว่าอยู่ stage ไหน → แจ้ง + ขออนุญาตก่อนแก้ |
| **Sim gate** | ห้ามผ่านไป build ถ้า sim ไม่ผ่าน — ความถูกต้องถูกบังคับด้วยเครื่อง ไม่ใช่ความเชื่อของ AI |
| **Feedback/debug loop** | error จาก ERC/sim/Vivado ป้อนกลับเข้า AI อัตโนมัติเป็นรอบ ๆ โดย user เห็นทุกชั้น |
| **Human‑in‑the‑loop** | ทุก action ที่แก้ไฟล์/ลงบอร์ด มีจุดให้ user ยืนยัน/มองเห็น |
| **RAG** | คลังโค้ด + คลังโมดูล + คู่มือ ป้อน context ที่ถูกต้องแทนให้ AI เดา (chunk‑by‑module + rerank) |
| **Oracle จาก spec (freeze)** ★ | testbench สืบจาก spec + freeze — AI แก้ข้อสอบให้ตัวเองผ่านไม่ได้ (ดู `06`) |
| **Co‑sim equivalence** ★ | JS‑sim (ตอนวาด) ต้องตรง GHDL (ตอน VHDL) บิตต่อบิต ก่อนลงบอร์ด |
| **Content‑hash chaining** ★ | แก้ต้นทาง → stage ถัดไป `stale` อัตโนมัติ "ผ่านแล้ว" ไม่โกหก |
| **Retry policy + confidence gate** | max 3 + error‑diff + escalate · human approve เฉพาะจุดเสี่ยง (กันล้า) |
| **Observability + provenance** | trace ทุก AI call ลง SQLite (debug + fine‑tune data) · manifest ทุก artifact |
| **Job/timeout/cancel + security** | in‑process job manager (ไม่พึ่ง broker) · allowlist exe · bind 127.0.0.1 |

> รายละเอียดความถูกต้อง/ความทนทานทั้งหมดอยู่ใน `06_correctness_and_robustness.md` (แกน: "อะไรคือความจริงที่ตัดสินว่างานถูก")

## 7. AI runtime

- คุยผ่าน **OpenAI‑compatible endpoint** → สลับ engine ได้โดยไม่แก้โค้ดหลัก
- เริ่มด้วย **llama.cpp** (ได้ GBNF grammar‑constrained output) — fallback **Ollama**
- โมเดล ≤6GB บน 4050 laptop (runtime); fine‑tune ทีหลังบน 5060ti 16GB
- fine‑tune data ได้จาก: pipeline logs จริง + คลังโมดูล + คู่ (schematic JSON ↔ VHDL) ที่ระบบสร้างเองได้

## 8. แผนเป็นเฟส

> **แหล่งความจริงของ roadmap = `README.md` §5** (ปรับลำดับตามรีวิว 2026‑09‑16: SIM/oracle + regression + observability ขึ้นเป็นรากฐาน Phase 1) สรุปย่อ:

- **เฟส 0:** อ่าน source + วางดีไซน์ (doc 00–06) ✅
- **เฟส 1 (รากฐาน):** Python hub skeleton (envelope + store + เสิร์ฟ UI + bridge) · content‑hash pipeline/state · observability (SQLite trace) · regression harness
- **เฟส 1‑par (ขนาน):** Sim/Oracle — JS‑sim + spec→oracle(freeze) + testbench runner
- **เฟส 2:** headless `fpga_backend.py` + retarget XC7S15 + pin table · XDC validator · workspace+job manager · security
- **เฟส 3:** GHDL + co‑sim equivalence gate
- **เฟส 4:** AI orchestrator + semantic validator + retry/confidence gate + RAG + ELK drawing
- **เฟส 5:** เชื่อม topdown↔gate (refinement) + resource feedback
- **เฟส 6 (ต่อเนื่อง):** ทดลองจริง + ขยาย regression · training/hardening doc (living)

*(เฟสวนกลับไปมาได้ · regression + training doc ทำสะสมตั้งแต่ Phase 1)*

## 9. เรื่องต้องจำ / กับดัก

- **Path:** Vivado build ล้มถ้า path มีช่องว่าง/ภาษาไทย → build dir ต้องเป็น ASCII (เช่น `C:\FPGA`). โปรเจคอยู่ใน OneDrive path ไทย — hub ต้อง copy งานไป work dir สะอาดก่อน build
- **Retarget:** `fpga_builder.json` ยัง `part: xc6slx9` — ต้องเป็น xc7s15/ftgb196/Vivado
- **ไม่รื้อของเก่า:** gate ERC + topdown MCP validation คือของดี reuse ไม่ใช่เขียนใหม่
- **บอร์ดเดียว:** โฟกัส XC7S15 เท่านั้น (ตัด Spartan‑6 ออกจาก scope ได้เพื่อลดความซับซ้อน — ยืนยันกับผู้ใช้ก่อนตัดจริง)
