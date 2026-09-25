# แผนแม่บท — Digital Design AI Ecosystem
### เอกสารหลัก (อ่านไฟล์นี้ก่อน แล้วค่อยเจาะ 00–05)

> เป้าหมายสุดท้าย: ระบบเดียวที่พางานดิจิทัลตั้งแต่ *โจทย์ → ลงบอร์ด* โดยมี AI ท้องถิ่นช่วยลงมือทำทุกขั้น
> บนบอร์ดเดียว **EDGE Spartan‑7 (XC7S15)** — ให้ผู้ใช้รู้สึกเหมือนใช้เครื่องมือชิ้นเดียว
> อัปเดตล่าสุด: 2026‑09‑16 · สถานะ: จบการศึกษา source + วางดีไซน์ (เฟส 0) กำลังจะเริ่มสร้าง (เฟส 1)

---

## 1. เราจะทำอะไร (What)

รวมเครื่องมือ 3 ตัวที่มีอยู่ให้เป็น **ecosystem เดียว**:

| ตัวเดิม | หน้าที่ | บทบาทในระบบใหม่ |
|---|---|---|
| `schematic&bus2vhdl.html` | วาดวงจร gate‑level → VHDL | **view หลัก** + เพิ่ม **Sim** (ยังไม่มี) |
| `topdown-schematic.html` | วาด block diagram แบบ top‑down | **view สถาปัตย์** (ขั้นออกแบบ) |
| `FPGA_Builder` (Python) | VHDL → .bit → ลงบอร์ด | **โตเป็น Hub/backend ของทุกอย่าง** |

โดยมี **AI ท้องถิ่น** (โมเดล ≤6GB บน RTX 4050, fine‑tune บน 5060ti) เป็นผู้ช่วยที่ *ลงมือทำจริง* ตลอดเส้นทาง ไม่ใช่แค่ถามตอบ

## 2. ผลลัพธ์ที่คาดหวัง (Expected Outcome)

เมื่อเสร็จ ผู้ใช้ควรทำสิ่งนี้ได้ในระบบเดียว:

1. **บอกโจทย์เป็นภาษาคน** → AI ถามกลับจนได้ข้อกำหนดชัด แล้ว *เสนอสถาปัตยกรรม*
2. **AI วาดวงจรให้** — วางผังสวย เดินสายเรียบร้อย โดยผู้ใช้ไม่ต้องจัดเอง (AI ไม่เดาพิกัด, เครื่องคิด layout ให้ — ดู `05`)
3. **กด Sim แล้วรู้ทันทีว่าถูกไหม** — มี waveform, มี known‑good vector, ต้องผ่านก่อนลงบอร์ด
4. **ได้ VHDL อัตโนมัติ** และ **ลงบอร์ดได้ในคลิกเดียว** (build ผ่าน Vivado → program XC7S15)
5. **แจ้งปัญหาแล้ว AI ซ่อมให้ตรงจุด** — AI บอกได้ว่าพลาดที่ *ขั้นไหน* ของ pipeline, ขออนุญาตก่อนแก้, แก้เฉพาะส่วนที่เกี่ยว (ไม่ rewrite ทั้งไฟล์), ผู้ใช้เห็นทุกชั้นและ debug เองได้ง่าย

**ตัวชี้วัดความสำเร็จ (Success Criteria):**
- โมเดลเล็กวาดวงจรที่ *ผ่าน ERC + Sim (เทียบ oracle)* ได้อย่างสม่ำเสมอ โดยผู้ใช้แทบไม่ต้องแก้ layout
- **"SIM ผ่าน" = output ตรง oracle ที่สืบจาก spec ทุก vector** และ **JS‑sim ตรง GHDL บิตต่อบิต** (co‑sim) — ไม่ใช่แค่ "ไม่ error"
- ไม่มีเคส "AI แก้ testbench ให้ตัวเองผ่าน" — oracle ถูก freeze แก้ไม่ได้ (ดู `06`)
- ไม่มีเคส "AI เขียนใหม่ทั้งไฟล์แล้วพัง" — ทุกการแก้เป็น targeted + ผ่าน validator
- "ผ่านแล้ว" ไม่โกหก — แก้ต้นทางแล้ว stage ถัดไปเป็น `stale` อัตโนมัติ (hash‑chain)
- pipeline เดินครบ *โจทย์ → บอร์ด* ได้จริงบนเครื่องเดียว offline
- ระบบทน: timeout/cancel ได้, ผิดแล้วไม่แครช, บอก error ที่เข้าใจได้ และกู้ต่อได้

## 3. เราจะทำยังไง (How — แนวทางแกน)

**ก. Python เป็น Hub เดียว** — UI/action ทุกอย่างวิ่งผ่าน backend ตัวนี้ (มันรัน Vivado/LLM/process ได้ ต่างจาก HTML) *[ทำไม: FastAPI]*

**ข. Canonical IR เป็น semantic core + envelope เป็นภาชนะ** *(ดู `08`)* — ไม่ rewrite editor (ของดี ลึก: ERC 30 ข้อ + VHDL gen) แต่ Hub มี **IR กลาง** ที่เป็นความจริงเชิงความหมาย: **gate netlist = source of truth เดียว, top‑down = projection ที่ compile ลงมา, VHDL/JS‑sim generate จาก IR** — ล็อกตอนนี้เพื่อกันกับดัก bidirectional‑sync ("รวมเป็นหนึ่ง" ที่ประสบการณ์ใช้งาน ไม่ใช่รื้อข้างใน)

**ค. AI ออกแค่ topology เครื่องคิด geometry** — LLM บอกแค่ "อะไรต่อกับอะไร", ELK layout + auto‑router คิดตำแหน่ง+เดินสาย → โมเดลเล็กก็วาดสวยเพราะไม่ต้องเดาพิกัด (ดู `05`)

**ง. AI ถูก scaffold หนักเพื่อกัน hallucinate:**
- pipeline บังคับลำดับ (โดดข้ามไม่ได้)
- constrained JSON output (GBNF) — output ตรง schema เป๊ะ
- **semantic validator** (subset ของ ERC) ที่ระดับ topology *ก่อน* layout — จับ width/floating/loop เร็ว
- validate‑then‑apply (แบบ `save_design`/ERC) — ผิดคืน hint ให้แก้ ไม่บันทึกของพัง
- targeted edit เท่านั้น · locate‑then‑ask · **retry policy (max 3 + error‑diff + escalate)** · human‑in‑the‑loop แบบมีเงื่อนไข (confidence gate)
- RAG: chunk ตาม module boundary + metadata filter + rerank (ห้าม pure vector) ป้อน context แทนให้ AI เดา

**จ. ความถูกต้องมี oracle ไม่ใช่แค่ validator** *(หัวใจ — ดู `06`)*
- **oracle จาก spec + freeze (immutable)** — AI แก้ testbench ให้ตัวเองผ่านไม่ได้
- **co‑sim equivalence**: JS‑sim (ตอนวาด) ต้องตรง GHDL (ตอน VHDL) บิตต่อบิต ก่อนลงบอร์ด
- **content‑hash chaining**: แก้ต้นทาง → ทุก stage ถัดไป `stale` อัตโนมัติ, "ผ่านแล้ว" ไม่โกหก
- **observability**: trace ทุก AI call ลง SQLite (debug + dataset fine‑tune) · provenance manifest ทุก artifact

**ฉ. AI engine สลับได้** — คุยผ่าน OpenAI‑compatible endpoint, เริ่ม llama.cpp (ได้ GBNF) fallback Ollama · model‑tiering ขึ้น API ใหญ่ = escape hatch ที่ตั้งค่าได้ (ไม่ใช่ default เพราะโจทย์ offline)

**ช. ความทนทานเป็นระบบ** — job manager (timeout/cancel ต่อ stage, kill process‑tree; in‑process ไม่พึ่ง Redis/Celery) · workspace manager (`C:\FPGA\ws\<job_id>` + GC) · security (allowlist exe, ห้าม `shell=True`, bind 127.0.0.1)

## 4. Pipeline (เส้นทางงาน)

```
[0] SPEC → [1] DESIGN → [2] DRAW → [3] SIM ★ → [4] VHDL → [5] BOARD
  โจทย์      สถาปัตย์     วาดวงจร    ตรวจถูก     โค้ด       ลงบอร์ด
             (topdown)   (gate)    (บังคับผ่าน)  (auto)    (XC7S15)
```
ทุกขั้นมีสถานะ (pending/running/passed/failed) ที่ผู้ใช้เห็น และ AI ต้องเดินตามลำดับ · วาด↔โค้ด ทำได้สองทาง (ทดลองว่าทางไหนดีสุด) แต่ **ก่อนลงบอร์ดต้องผ่าน Sim เสมอ**

## 5. แผนเป็นเฟส (Roadmap)

> ปรับลำดับตามรีวิว 2 รอบ (2026‑09‑16): **ฐานความถูกต้อง (IR + pipeline/state + isolation + oracle semantics) มาก่อน AI**
> และมี **walking skeleton (deterministic ไม่มี AI) ก่อน** เพื่อเจอ integration pain ตั้งแต่ต้น — AI เลื่อนไป Phase 3

| เฟส | ทำอะไร | สถานะ |
|---|---|---|
| **0** | อ่าน source + วางดีไซน์ (doc 00–09) | ✅ เสร็จ |
| **0.5** | **Foundation (ไม่มี AI):** Canonical IR v1 + schema (ดู `08`) · pipeline state machine + **evidence‑based state** + hash chain (canonical + env + semantic/presentation) · immutable artifact store · **worker isolation + durable job store + timeout/cancel/kill‑tree** (ดู `06`) · Board Profile (ดู `09`) · error taxonomy v1 (ดู `07`) · co‑sim semantics contract · observability (SQLite trace) · threat model | ⏳ ถัดไป |
| **1** | **Walking skeleton (deterministic, ไม่มี AI):** ลาก half‑adder→counter ผ่าน **ทั้ง pipeline จนติดบอร์ด**: create→ERC→JS‑sim→VHDL→GHDL(co‑sim)→synth→**POST‑SYNTH gate**→program(human) · พิสูจน์ pipeline/artifact/stale/gates ก่อนแตะ AI | ○ |
| **2** | **Oracle & verification:** reference model · frozen oracle + **amendment protocol** · co‑sim trace+contract · regression suite (golden + oracle) · **mutation testing** · verified‑library seeding | ○ |
| **3** | **AI‑assisted:** topology‑only generation + **ELK drawing** (ดู `05`) · **typed semantic patch** · semantic validator · error‑class + retry + confidence gate · RAG (verified‑library‑first) · trace/eval + determinism | ○ |
| **4** | **Implementation & board safety:** timing/DRC/resource gates · board lock · bitstream identity · programming approval · hardware smoke test · resource feedback | ○ |
| **5** | top‑down เป็น **projection over IR** + refinement · provenance/stale viewer · rollback/compare revision | ○ |
| **6** | ทดลองจริง + ขยาย regression/mutation/property/fuzz · **training/hardening doc (living, กัน model collapse)** | ○ ต่อเนื่อง |

*(วนกลับไปมาได้ · regression + training doc + observability ทำสะสมตั้งแต่ Phase 0.5 · ทุก Phase มี **DoD เป็นตัวเลข** — ดู `06` §22)*

## 6. ปรัชญา (หลักที่กำหนดทุกการตัดสินใจ)

1. โปรแกรมน้อยที่สุด — ให้รู้สึกเหมือนใช้ตัวเดียว
2. AI ลงมือทำ/แก้/แนะนำ ได้ทั้ง pipeline ไม่ใช่แค่แชท
3. ระบบต้องทน ไม่บัค ไม่แครช
4. สมมติ AI ตัวเล็กผิดง่าย → ระบบต้องรัดกุมและ scaffold AI สุดกำลัง

## 7. ข้อควรจำ / กับดัก

- **Path:** Vivado build ล้มถ้า path มีช่องว่าง/ไทย → Hub ต้อง copy งานไป work dir สะอาด (เช่น `C:\FPGA`) ก่อน build (โปรเจคอยู่ใน OneDrive path ไทย)
- **EDGE board พร้อมแล้ว** ใน `BOARDS["edge"]` (xc7s15/ftgb196/Vivado) — เหลือเติม pin table
- **ไม่รื้อของเก่า:** ERC 30 ข้อ (gate) + MCP validation (topdown) = ของดี reuse
- gate editor **ไม่มี Sim** ต้องสร้างใหม่ทั้งหมด

## 8. สารบัญเอกสาร

| ไฟล์ | เนื้อหา |
|---|---|
| **README.md** (ไฟล์นี้) | แผนแม่บท: วิสัยทัศน์ → how → ผลลัพธ์ → roadmap |
| `00_architecture.md` | สถาปัตยกรรมเชิงเทคนิค + data model กลาง + native shapes |
| `01_schematic_datamodel.md` | gate editor: data model + คลัง component + serialize |
| `02_schematic_vhdl_netlist.md` | gate editor: netlist + VHDL gen + ERC 30 ข้อ + import |
| `03_topdown.md` | topdown: data model + Sync/MCP bridge + เทียบ gate |
| `04_fpga_builder.md` | Python builder: Vivado flow + แผนแยก headless API |
| `05_ai_drawing_design.md` | ★ ทำให้ AI วาดสวย: topology‑only + ELK + template |
| `06_correctness_and_robustness.md` | ★★ oracle + co‑sim contract + hash‑chain + jobs/retry/security + DoD (รีวิว 1+2) |
| `07_error_codes.md` | error taxonomy คงที่ (`DOMAIN-NNN`) + retry class — key ของ retry/regression/gate |
| `08_canonical_ir.md` | ★★ Canonical IR = semantic core · gate=truth, topdown=projection · semantic/presentation hash |
| `09_hardware_gates.md` | ★ validation ladder + POST‑SYNTH gate + Board Profile + programming safety interlock |
| `10_golden_designs.md` | คลัง regression 28 designs + negative cases + oracle format (สร้างผ่าน MCP) |
| `board_edge_spartan7.md` | ข้อมูลบอร์ด EDGE Spartan‑7 จริง (pin map/clock/IOSTANDARD — ดึงจาก fpga_builder.py) |
| `gate_integration_points.md` | จุดต่อ MCP เข้า gate HTML (loader shape + วิธีเพิ่มปุ่ม Sync) |
