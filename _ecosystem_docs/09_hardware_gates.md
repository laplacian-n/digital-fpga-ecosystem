# 09 — Validation Ladder, Post‑Synth & Board Safety

> จากรีวิวรอบ 2: "SIM ผ่าน ≠ ฮาร์ดแวร์ทำงาน" · ห้ามรวมทุกอย่างใต้คำว่า "ผ่าน SIM"
> ต้องมี gate หลัง synthesis และ **safety interlock ทางกายภาพ** ก่อนลงบอร์ด

---

## 1. Validation Ladder — สถานะแยกตามระดับ (ไม่ใช่ pass/fail เดียว)

| # | ระดับ | ผูกกับ stage | hard‑fail? |
|---|---|---|---|
| 1 | Schema valid | ทุก edit | ✔ |
| 2 | Semantic/ERC valid | DRAW | ✔ |
| 3 | Reference simulation (เทียบ oracle) | SIM | ✔ |
| 4 | JS↔GHDL equivalence (co‑sim) | SIM/VHDL | ✔ |
| 5 | VHDL analysis/elaboration | VHDL | ✔ |
| 6 | Synthesis passed | POST‑SYNTH | ✔ |
| 7 | Implementation (place/route) | BOARD‑prep | ✔ |
| 8 | Timing met (WNS ≥ 0) | POST‑SYNTH | ✔ |
| 9 | DRC passed | BOARD‑prep | ✔ |
| 10 | Bitstream ↔ board profile match | PROGRAM | ✔ (policy) |
| 11 | Programming approved (human) | PROGRAM | ✔ (human) |
| 12 | Hardware smoke test | POST‑BOARD | ○ (แนะนำ) |

แต่ละระดับมี **error code** ของตัวเอง (ดู `07`) และเก็บเป็น evidence ใน stage_run (ดู `06`)

## 2. Stage 4.5 — POST‑SYNTH Gate (เพิ่มใน pipeline)

หลัง synth ต้อง **triage รายงาน Vivado** ไม่ใช่ดูแค่ exit code:

- **latch inference** (`SYNTH-LATCH`) = **fail ทันที** (พังจริงบนบอร์ด แต่ sim ผ่าน — อันตรายเงียบ)
- **unconnected port / logic ถูก optimize ทิ้ง** (`SYNTH-UNCONNECTED`) = fail
- **black box / missing module** (`SYNTH-BLACKBOX`) = fail
- **multi‑driver ที่ synth เจอ** (`SYNTH-MULTIDRIVER`) = fail
- **WNS < 0** (`TIMING-WNS-NEG`) = fail (ทำงานผิดที่ความถี่จริง)
- **utilization เกินเกณฑ์** (`IMPL-UTIL-OVER`) = fail/เตือน

**ดึง resource + timing กลับมาแสดงตั้งแต่ DESIGN**: XC7S15 มีจำกัด — ประมาณ **8,000 LUT6 / 2,000 slice / 12,800 FF** + BRAM/DSP น้อย → ถ้าออกแบบเปลืองควรรู้ก่อน implement ล้ม *(ตัวเลขยืนยันกับ datasheet ตอน implement)*

## 3. Board Profile — artifact มี version + hash

ข้อมูลบอร์ดเป็น artifact ที่ freeze/hash (ทุก bitstream ผูกกับ profile ที่ build):

```
board_profile (EDGE Spartan‑7)
- part / package            : xc7s15 / ftgb196
- speed grade               : -1
- toolchain                 : Vivado
- pin_map                   : {SWx, LEDx, PBx, DIPx, 7SEG a..g, CLK} → pin/LOC
- io_bank_voltage           : per‑bank
- iostandard                : LVCMOS33
- clock source / frequency  : (osc pin, MHz)
- reset polarity            : (active high/low)
- pull up/down              : per‑pin ถ้ามี
- reserved pins             : (ห้ามใช้)
- programming interface     : ft2232 / JTAG · spiOverJtag bitfile
- max supported clocks
- board revision
```

> ✅ **ได้ข้อมูลจริงแล้ว** → `board_edge_spartan7.md` (ดึงจาก `fpga_builder.py` `_PIN_DESC_EDGE`)
> EDGE Spartan‑7: `xc7s15`/`ftgb196`/`-1`/Vivado · **clock = pin `H11` OSC 50MHz** (signal `clk`, period 20ns)
> · 16 slide switch · 5 push button · 16 LED (8 ตัว = 7‑seg segment, 8 ตัว = LCD data) · 4 seven‑seg digit‑enable
> · **reserved: SW1 = reset button, SW3 = power‑select** (ห้ามใช้) · IOSTANDARD LVCMOS33
> · program: openFPGALoader `ft2232`, bridge `spiOverJtag_xc7s15ftgb196.bit`, SRAM `-m` / Flash `-f -B` (M25P80)
> · หมายเหตุ: pin ในคู่มือ `อ่านก่อนใช้งาน.txt` (P66/P82/P123…) เป็นของ **Apex Spartan‑6** ไม่ใช่ EDGE

## 4. Programming Gate (safety interlock ก่อนเขียนบอร์ด)

ก่อน program ต้องผ่านทั้งหมด:
1. **device ID ตรง** กับ board_profile (`BOARD-ID-MISMATCH` = หยุด)
2. **bitstream metadata** (part/pkg) ตรง profile
3. ไม่มี pin ชน / ใช้ reserved pin / IOSTANDARD ผิด bank (`BOARD-*`)
4. **human confirm บังคับ** สำหรับ **flash/PROM write** (เขียนถาวร จำนวนครั้งจำกัด) — Normal/SRAM อนุญาตง่ายกว่า
5. lock ทรัพยากรบอร์ด (1 job ต่อบอร์ด/สาย ต่อครั้ง)

## 5. Hardware Correctness Validators (นอกเหนือ ERC)

เพิ่มชุดตรวจที่ ERC เดิมไม่ครอบ (บางส่วนทำที่ IR, บางส่วนอ่านจากรายงาน synth):
- clock‑domain crossing (CDC) / reset‑domain crossing (RDC)
- unsynchronized asynchronous input · button debounce (แนะนำ template)
- latch inference · combinational loop · unconstrained clock/path
- width truncation · signed/unsigned conversion เงียบ
- multiple clock drivers · unconnected output / floating input
- utilization over · negative slack

หลายตัวมีรูปเป็น **template ในคลังโมดูล** (debouncer, 2‑FF synchronizer, clock divider) → verified‑library‑first แก้ได้ตั้งแต่ยังไม่ generate

---

### สรุป
"ถูกทางตรรกะ" (oracle/co‑sim) กับ "ทำงานบนฮาร์ดแวร์จริง" (post‑synth/timing/board) เป็น**คนละชั้น** — ต้องมี gate ทั้งสอง และชั้นบอร์ดคือ **safety** ไม่ใช่แค่คุณภาพ (ผิดแล้วเสียหายฟิสิกส์ได้)
