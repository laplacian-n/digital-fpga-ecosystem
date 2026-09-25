# Auto-Router / Auto-Placer — สถานะงานและคู่มือส่งต่อ (Handoff)

> เอกสารนี้เขียนไว้ให้ AI เซสชันอื่นอ่านแล้วทำงานต่อร่วมกันได้ทันที
> อัปเดตล่าสุด: 2026-09-17
> ไฟล์ที่แก้: `schematic&bus2vhdl.html` (gate-level schematic editor + VHDL generator)
> โฟลเดอร์โปรเจกต์: `C:\Users\dinuc\OneDrive\เอกสาร\digital`

---

## 0. TL;DR — งานอยู่ตรงไหน

Auto-router ของ gate schematic editor ถึงระดับ **"งานชั้นครู" (master-level)** แล้ว —
เจ้าของงาน (ผู้ใช้) ยืนยันด้วยตาเองกับวงจร `full_adder`

**ผ่านการทดสอบ 4 วงจร** (guarantees = 0 ทุกตัว, ไม่มี regression):

| วงจร | ทดสอบอะไร | ผล (perpendicular crossings ที่เหลือ) |
|---|---|---|
| `half_adder` | พื้นฐาน | 1 |
| `full_adder` | หลายชั้น + fanout — **ยืนยันว่าเป็นงานชั้นครู** | 4 |
| `mux2` | NOT + fanout | 0 |
| `maj3` | **3-input gate + fanout** (เพิ่งแก้ fan-in ไขว้ 5→3) | 3 |

> หมายเหตุ: crossing แบบ **ตัดตั้งฉาก (perpendicular)** คือของที่ยอมรับได้และหลีกเลี่ยงไม่ได้ ไม่ใช่บั๊ก
> ที่ต้องเป็น 0 เสมอคือ 4 "guarantees" ด้านล่าง

**ขั้นถัดไปที่ยังไม่เริ่ม:** ทดสอบวงจรที่ยากขึ้น (2-bit adder, 7-seg decoder) **หรือ** ปิดจ๊อบ router
แล้วขยับไป pipeline ถัดไป (sim / AI drawing / golden corpus / Python hub) — ผู้ใช้บอกว่า "โอเคสวยเริ่มงานอื่นต่อ"
ก่อนขอ doc นี้ ดังนั้นแนวโน้มคือ **จะเริ่มงานส่วนอื่นของ ecosystem** ไม่ใช่ขัด router ต่อ

---

## 1. ภาพใหญ่ของโปรเจกต์ (ทำไม router ถึงสำคัญ)

เป้าหมาย ecosystem: รวมเครื่องมือ 3 ตัวเป็น pipeline เดียวขับด้วย AI ผ่าน Python hub
สำหรับสอน digital design / FPGA (บอร์ด EDGE Spartan-7 XC7S15)

หลักการวาดวงจรด้วย AI (สำคัญมาก — เป็นแกนของทั้งระบบ):
> **LLM ออกแค่ topology (มี gate อะไร ต่อสายไปไหน) — engine ที่เป็น deterministic คำนวณ geometry (พิกัด/เส้น) เอง**

`autoRouteSheet` ในไฟล์นี้ = engine deterministic ตัวนั้น (เวอร์ชัน JS ในเบราว์เซอร์)
มันคือ proof-of-concept ว่า "ให้ AI บอกแค่ net list แล้ววาดออกมาสวยระดับครูได้จริง"
รายละเอียด ecosystem เต็ม ๆ อยู่ใน memory files (ดูหัวข้อ 8)

---

## 2. เปิด/ทดสอบยังไง

- ไฟล์เป็น HTML standalone เปิดในเบราว์เซอร์ได้เลย ไม่ต้อง build
- editor มีปุ่ม Auto-route; ฟังก์ชันหลักคือ `autoRouteSheet(activeSch())`
- โหลดดีไซน์: ไฟล์ `.schproj.json` ในโฟลเดอร์ `designs_gate/`
- **ผู้ใช้ hard-refresh ทุกครั้งที่ทดสอบ** และดูด้วยตาเสมอ → อย่าเชื่อ metric อย่างเดียว ต้องดูรูปด้วย

### Headless test harness (สร้างไว้แล้วใน scratchpad)
ทดสอบอัตโนมัติด้วย Chrome/Edge headless — inject script ที่ deserialize ดีไซน์ แล้วเรียก
`autoRouteSheet` แล้ว dump geometry / วัด metric ออกมาเป็น text
- `build_dump.js` — สร้างหน้าเทสต์ที่ dump net segments + self-overlaps (ใช้ debug เส้น)
- `build_detect.js` — overlay เส้น magenta ทับ overlap ที่ตรวจเจอ + screenshot
- รันด้วย: `node build_dump.js <out.html> <designName>` แล้วเปิด out.html ด้วย headless
  `--dump-dom` / `--screenshot` / `--virtual-time-budget=3000`
- **ข้อควรระวัง path:** Write tool เขียนที่ scratchpad; Bash เห็น `/tmp` คนละที่ → ใช้ absolute path เต็มเสมอ
   path โปรเจกต์มีภาษาไทย + `&` ในชื่อไฟล์ → node `-e`/sed มัก escape พัง ให้เขียนเป็นไฟล์ `.js` แล้วรันแทน

### วัด metric ในหน้า (เรียกใน console ได้)
```js
const s = activeSch();
netSelfOverlaps(s).length      // ต้อง 0
netCollinearOverlaps(s).length // ต้อง 0
wireBodyCrossings(s).length    // ต้อง 0
wirePinCrossings(s).length     // ต้อง 0
// perpendicular crossings ของต่างเน็ต = ยอมรับได้ ไม่มี detector บังคับให้ 0
```

---

## 3. สถาปัตยกรรม Router (pipeline จริง)

ทุกอย่างอยู่ในไฟล์เดียว เลขบรรทัดอ้างอิง ณ วันที่เขียน (อาจขยับเมื่อแก้เพิ่ม — ให้ใช้ Grep ชื่อฟังก์ชันยืนยัน)

### รูปแบบ comb router
สาย 1 เน็ต = driver → **spine (เส้นตั้ง ที่ x = `Xj`)** → taps แยกไปหา sink แต่ละตัว
- junction (จุดต่อ) วางที่แถวของ tap
- `Xj = snap(minSX - off)` = วาง spine **ใกล้ sink** (ไม่ใช่ใกล้ driver) เพื่อให้ trunk วิ่งตามแถว
  driver ที่มักโล่ง แล้วค่อยยกขึ้นใกล้ปลายทาง → ลด crossing (เคยลดจาก 12→5)

### ลำดับใน `autoRouteSheet` (บรรทัด ~4484)
```
autoPlaceSheet(sch)          // จัดตำแหน่ง component เป็นคอลัมน์ตามชั้น logic
uncrossGateInputs(sch)       // พลิกขา gate สลับที่ (commutative) ให้ feed ไม่ไขว้
const runRoute = () => { ... }   // closure: วาดสายใหม่ทั้งหมดจาก net list ปัจจุบัน
runRoute()                   // ── ROUND 1: place(เสร็จ) + route
for (pass 0..3) {            // ── ROUND 2 step1: ยืดเส้น + พลิกซ้ำ
   s = straightenByRenderedBends(sch)
   f = uncrossGateInputs(sch)
   if(!s && !f) break
   runRoute()
}
{ ... band-based Y-compress ... }  // ── ROUND 2 step2: บีบแกน Y เป็น "แถบ (band)"
sch.locked = true
```

### `runRoute()` ทำอะไรบ้าง (ตามลำดับ)
เป็น closure ที่ **re-derive net จากสายปัจจุบัน** ทุกครั้ง (`netDriverPort` ไล่ผ่าน junction, sink ข้าม endpoint
ที่เป็น junction) → เรียกซ้ำได้หลัง component ขยับ นี่คือหัวใจของ measure-driven placement
1. build comb: gather nets → ลบสายเก่า → stagger spine columns (net ที่ driver คอลัมน์เดียวกันไม่ใช้ x เดียว) → วาง junction/taps/สาย
2. `healJunctions` — จัดจุดต่อ
3. `resolveSelfOverlaps` — เน็ตเดียวกันทับตัวเอง → ย้ายจุดไป branch point จริง (dot ที่ branch, ไม่ทับตัวเอง)
4. `avoidBodies` — เลี่ยง body แบบ shift ขา (เลือกด้านใกล้ปลายทางก่อน)
5. `resolveBodyCrossings` — A* maze อ้อม body สำหรับเคสที่ shift ไม่พอ
6. `nestGateFanins` — จัดลำดับ riser ของ fan-in ฝั่งเดียวกันให้ซ้อนกันไม่ไขว้ (แก้ maj3)
7. `separateWireOverlaps` — ดันสายต่างเน็ตที่ทับแนวเดียวกันไปคนละ track
8. loop เคลียร์ collinear overlap ที่เหลือ (ปลด pts ที่ freeze แล้ว re-separate)

### แผนที่ฟังก์ชัน (ชื่อ → บรรทัด → หน้าที่)
| ฟังก์ชัน | บรรทัด | หน้าที่ |
|---|---|---|
| `wireRoute` | 3451 | คำนวณ route ของสาย 1 เส้น (geometry ที่วาดจริง) |
| `routeParts` | 3552 | แตก route เป็น segment h/v |
| `healJunctions` | 1906 | จัดตำแหน่ง/แกน junction |
| `separateWireOverlaps` | 3914 | ดันสายต่างเน็ต collinear ไปคนละ track |
| `healLayout` | 4227 | path ตอน locked (realtime): heal + resolveSelfOverlaps + separate + resolveBodyCrossings |
| `autoPlaceSheet` | 4261 | จัดวาง component (COLX = 12*GRID) |
| **`autoRouteSheet`** | **4484** | **entry point หลัก — ทั้ง pipeline** |
| `wireSegments` | 4650 | segment ที่ render จริง (ผ่าน routeParts∘wireRoute) — **detector ทุกตัวใช้อันนี้** |
| `netSelfOverlaps` | 4663 | detector: เน็ตเดียวกันทับตัวเอง |
| `netCollinearOverlaps` | 4685 | detector: ต่างเน็ต collinear ทับกัน |
| `straightenByRenderedBends` | 4788 | ROUND2: ขยับ component ให้ feed ตรง (bottom-up) |
| `uncrossGateInputs` | 4822 | พลิกขา gate สลับที่เมื่อ feed ไขว้ |
| `nestGateFanins` | 4856 | จัด riser fan-in ฝั่งเดียวกันไม่ให้ไขว้ |
| `resolveSelfOverlaps` | 4917 | ย้าย dot ไป branch จริง / align riser |
| `wireBodyCrossings` | 4970 | detector: สายผ่านใต้ body (INS=3) |
| `makeBodyMaze` | 4999 | A* maze module (BEND=16, block body+ทุก pin cell, stub 2·GRID ออกจาก pin) |
| `resolveBodyCrossings` | 5048 | re-maze สายที่ผ่าน body |
| `wirePinCrossings` | 5077 | detector: สายผ่านขา component ที่ไม่ได้ต่อ |
| `netDriverPort` | 5213 | ไล่หา driver จริงผ่าน junction (ใช้ทั่ว pipeline) |

---

## 4. 4 Guarantees ที่ต้องเป็น 0 เสมอ (สัญญาของ router)

1. **body-crossings** (`wireBodyCrossings`) — สายห้ามผ่านใต้/ทับตัว component เด็ดขาด
2. **pin-crossings** (`wirePinCrossings`) — เน็ตห้ามวิ่งผ่านขา component ที่มันไม่ได้ต่อ
3. **self-overlaps** (`netSelfOverlaps`) — เน็ตเดียวกันห้ามทับตัวเอง; dot ต้องอยู่ที่ branch จริง
4. **different-net collinear overlaps** (`netCollinearOverlaps`) — ต่างเน็ตห้ามทับ**แนวเดียวกัน**

**อนุญาต:** ตัดตั้งฉาก (perpendicular crossing) ของต่างเน็ต — เป็นเรื่องปกติของ schematic

**สำคัญ:** detector ทุกตัวใช้ **geometry ที่ render จริง** (`routeParts(wireRoute(...))`) ไม่ใช่เส้นตรงในอุดมคติ
เพราะเคยพลาดมาแล้ว — ตอนใช้เส้นตรงในอุดมคติ detector คืน 0 overlap ทั้งที่จอมีเส้นทับเต็ม

---

## 5. ⚠️ บทเรียน/กับดัก — อ่านก่อนแตะโค้ด (ห้ามพลาดซ้ำ)

1. **ห้ามใส่ crossing-penalty กลับเข้า cost function** — เคยลองทั้ง hard-rank (5000) และ soft (80)
   **ทั้งคู่ทำให้สายวิ่งอ้อมยาวเป็นลูป** ผู้ใช้ปฏิเสธอย่างแรง วิธีที่ถูกคือแก้ตรงจุด
   (spine-near-sinks, nestGateFanins) ไม่ใช่ลงโทษ crossing แบบรวม ๆ

2. **ห้ามใช้ PAVA / isotonic regression ทำ Y-compress** — เคยลอง ผู้ใช้บอก "อาการหนักมาก"
   (layout สูงเกิน + เพิ่ม crossing) วิธีที่ใช้จริงคือ **band-based greedy compress** (ดัน band ขึ้นทีละแถบ)

3. **อย่าเถียงว่าผู้ใช้ "มองผิด"** — ผู้ใช้ hard-refresh + ดูด้วยตาทุกครั้ง เห็นปัญหาจริงเสมอ
   ถ้าเขาบอกว่าแย่ลง = แย่ลงจริง ให้ revert แล้วหาสาเหตุ อย่า assume ว่าเขาอ่านผิด

4. **Measure-driven ต้องวัดจากของที่ render จริง** — ขยับ component/band → `runRoute()` → เก็บไว้ก็ต่อเมื่อ
   bends ไม่เพิ่ม **และ** guarantees สะอาด ไม่งั้น revert. "straight feed" วัดจาก `drvY ≈ pinY`
   (`netDriverPort` หา driver จริง) ไม่ใช่ "tap เป็น 1 segment" (เคยพลาด missed riser ของ cin)

5. **X-compression** ทำด้วยการลด `COLX` (18→12 GRID) ตรง ๆ — การทำ measure-driven per-column
   ไม่เวิร์ก (มันสู้กับ comb spine, revert ทุก step) `GRID = 11`

6. **หน่วยระยะ:** เส้นตั้งห่างกัน 1 หน่วย; component ห่างกัน/ห่างเส้น 2 หน่วย (1 หน่วย = GRID = 11px)

7. **golden corpus per-design approval** — สร้าง golden ทีละดีไซน์ รอผู้ใช้อนุมัติก่อนทำตัวถัดไป
   (ดู memory `feedback_golden_per_design_approval`)

---

## 6. ดีไซน์ทดสอบ (`designs_gate/`)

- `half_adder.schproj.json` — พื้นฐาน
- `full_adder.schproj.json` — **golden ที่ยืนยันแล้วว่าชั้นครู**
- `mux2.schproj.json` (สร้างเซสชันนี้) — a,b,sel IN; inv NOT(sel); aa AND(a,inv); ab AND(b,sel); orr OR; out OUT — เทส NOT + fanout
- `maj3.schproj.json` (สร้างเซสชันนี้) — a,b,c IN; ab/bc/ca AND (แต่ละ input fan ไป 2 ตัว); orr OR (3 input); out OUT — เทส 3-input gate + fanout

ยังไม่ได้ตัดสินใจว่าจะรับ mux2/maj3 เข้า golden corpus หรือยัง (ต้องขออนุมัติทีละตัวตามกฎ)

---

## 7. งานที่ทำเสร็จเซสชันนี้ (changelog ย่อ)

- self-overlap: dot ไป branch จริง + ทำงาน **realtime** ตอนลากสายเอง (`healLayout` locked path)
- body-crossing: A* maze + stub ออกจาก pin (เดิม maze คืน null เพราะ pin ฝังใน margin)
- pin-crossing detector
- spine ใกล้ sink (crossings 12→5)
- พลิกขา gate เมื่อ feed ไขว้ (`uncrossGateInputs` ใช้ `netDriverPort` + เรียกซ้ำใน round-2)
- ROUND2 straighten (bends 11→6, cin ยิงตรงเข้า XOR)
- band-based Y-compress (รวม input a/b/cin ในแถบด้วย)
- X-compress (COLX 18→12, กว้างลด ~31%)
- **`nestGateFanins`** (ล่าสุด) — maj3 fan-in ไขว้ที่ OR: 5→3 crossings

---

## 8. Memory / เอกสารอื่นที่ควรอ่าน

อยู่ที่ `C:\Users\dinuc\.claude\projects\C--Users-dinuc-OneDrive--------digital\memory\`
- `project_ai_drawing_approach.md` — **ละเอียดสุด** เรื่อง router + คำเตือนทั้งหมด (LLM→topology, engine→geometry)
- `project_fpga_ecosystem.md` — รวม 3 tools เป็น Python hub pipeline
- `project_architecture_decisions.md` — Python hub, engine-agnostic AI (llama.cpp), sim ทั้ง JS+GHDL
- `project_correctness_robustness.md` — oracle-from-spec, co-sim equivalence, hash-chain
- `project_mcp_tooling.md` — เชื่อม Claude กับ editor ผ่าน MCP
- `feedback_golden_per_design_approval.md`, `feedback_reviews_into_docs.md` — วิธีทำงานร่วม

---

## 9. ขั้นถัดไป (เลือกได้ — รอผู้ใช้ชี้)

**A. ทดสอบ router ต่อ:** 2-bit adder (หลายชั้น + fanout เยอะ), 7-seg decoder (fan-in กว้าง)
**B. ปิด router → ขยับ pipeline:** เริ่ม sim (JS+GHDL) / AI drawing (LLM emit topology จริง) /
   canonical IR / Python hub ที่ต่อทุกอย่างเข้าด้วยกัน
**C. รับ mux2/maj3 เข้า golden corpus** (ขออนุมัติทีละตัว)

> ผู้ใช้พิมพ์ "โอเคสวยเริ่มงานอื่นต่อ" ก่อนขอ doc → มีแนวโน้มไปทาง **B** (เริ่มส่วนอื่นของ ecosystem)
> แต่ยังไม่ระบุชัดว่าส่วนไหน — **ถามก่อนเริ่ม** อย่าเดา
