# 08 — Canonical IR & การล็อกโมเดลข้อมูล

> จากรีวิวรอบ 2 (Opus5 + Sol, 2026‑09‑16): envelope‑wrapping อย่างเดียว → **semantic drift**
> (gate editor กับ VHDL generator ตีความข้อมูลดิบคนละทาง) ต้องมี **semantic core เดียว**
> เอกสารนี้ *ปรับ* แนวคิด envelope ใน `00` ไม่ใช่ล้ม — envelope ยังเป็น *ภาชนะ* แต่ **IR เป็นความหมาย**

---

## 1. การตัดสินใจที่ต้องล็อกตอนนี้ (ก่อนเขียนโค้ด)

**Gate‑level netlist = source of truth เพียงหนึ่งเดียว**
- **Top‑down = projection/view** ที่ compile *ลงมา* หา IR (แก้ top‑down → recompile → gate) ไม่ใช่สองฝั่งเท่ากัน
- **VHDL, JS‑sim model, ผัง gate = generate จาก IR** ทั้งหมด
- เหตุผล: bidirectional sync คือส่วนที่พังง่ายสุดในระบบแบบนี้ ถ้าไม่ล็อกว่าใครคือความจริง จะต้องรื้อตอน Phase 5 แน่นอน

> หมายเหตุ: ยัง**ไม่ rewrite editor** — gate editor มี component/wire model ที่ *เกือบเป็น IR ระดับ gate อยู่แล้ว* (ERC ทำงานบนมันได้) Hub แค่ทำ mapping ระหว่าง native format ↔ IR ให้เป็นทางการ

## 2. IR ต้องระบุอะไร (ขั้นต่ำ)

- **Module/entity + hierarchy** (instance tree)
- **Port**: direction, width, **signedness**, type (`std_logic`/`std_logic_vector`/…)
- **Net** + ความสัมพันธ์ **driver/load** (ใครขับ ใครอ่าน)
- **Clock domain / reset domain** (async vs sync, polarity)
- **Constant / expression / parameter**
- **Provenance**: object นี้มาจาก user / AI / generator (ตัวไหน เวอร์ชันไหน)
- **Stable object UID** แยกจาก **revision ID** (UID คงที่ตลอดชีวิต object, revision เปลี่ยนเมื่อแก้)
- **Requirement → block → net → VHDL mapping** (ตามรอยได้ว่าอะไรมาจาก spec ข้อไหน)
- **Unsupported construct / information‑loss marker** (ตรงไหนแปลงแล้วเสียข้อมูล ต้องบันทึก ไม่ใช่กลืนเงียบ)

## 3. Transformation = ฟังก์ชันชัดเจน (ห้ามตีความซ้ำซ้อน)

```
Top‑down model  ──►  Canonical IR          (projection compile‑down)
Canonical IR    ──►  Gate view             (render/layout — ELK, ดู 05)
Canonical IR    ──►  VHDL AST  ──►  VHDL source
Canonical IR    ──►  JS‑sim model
VHDL source     ──►  Canonical IR          (import — subset, mark information‑loss)
```

กฎ: **ไม่มีสองเส้นทางที่แปลงความหมายเดียวกันด้วย logic ต่างกัน** ทุกอย่างผ่าน IR เป็นศูนย์กลาง

## 4. Canonical JSON (บังคับ — เพื่อ hash เสถียร)

ปัญหา: JSON key order / float format ต่างนิดเดียว → hash เปลี่ยน → invalidate มั่ว
กติกา canonical form (ใช้ทุกที่ที่ hash):
- **sorted keys**
- **fixed float repr** (หรือเลี่ยง float ในข้อมูล semantic — ใช้ int/rational)
- ไม่มี whitespace ที่ไม่จำเป็น · UTF‑8 · array order มีความหมายเสมอ (ไม่ sort)

## 5. แยก Semantic Hash / Presentation Hash ★

```
semantic_hash      = hash(IR: modules, ports, nets, drivers, params ...)   ← ตรรกะ
presentation_hash  = hash(x, y, layout, ผัง, สี ...)                        ← หน้าตา
```
- **เฉพาะ `semantic_hash` ที่เปลี่ยน → invalidate downstream** (SIM/VHDL/bit)
- ขยับ node 1 พิกเซลใน DRAW → `presentation_hash` เปลี่ยน แต่ `semantic_hash` เท่าเดิม → **SIM ไม่ stale** (ไม่งั้นจะกวนใจจนใช้ไม่ได้)

## 6. Targeted Edit = Transactional Semantic Patch (บน IR ไม่ใช่ตำแหน่งข้อความ)

การแก้แบบอิงตำแหน่ง text เปราะ → แก้บน IR ด้วย typed operation:

```json
{
  "operation": "replace_connection",
  "target_uid": "net_104",
  "expected_revision": 18,
  "old_value_hash": "…",
  "new_source_uid": "gate_22.out"
}
```

ขั้นตอน (transactional):
1. ตรวจ schema → 2. ตรวจ `expected_revision` + precondition (`old_value_hash` ตรง) →
3. apply ใน **temporary revision** → 4. semantic validator → 5. รัน test ที่ได้รับผลกระทบ →
6. แสดง **diff** → 7. commit หรือ rollback

- ทุก patch ผูก `expected_revision` → กัน 2 tab/AI แก้ชนกัน (optimistic lock)
- **อนุญาต controlled refactor** ได้ (ไม่ใช่ห้าม rewrite เด็ดขาด) — เพราะห้ามตลอดจะเกิด *patch accumulation* แล้วโครงเสื่อม แต่ refactor ต้องผ่าน validator+test ชุดเดิมและ diff ให้ผู้ใช้เห็น

## 7. ความสัมพันธ์กับ envelope (ปรับ `00` §5)

- **Envelope** = ภาชนะเก็บ { IR, native gate JSON, native topdown JSON, presentation, pipeline_state, provenance } ในโปรเจกต์เดียว
- **IR** = ความจริงเชิงความหมาย ที่ทุก stage อ้าง
- native format ของ editor ยังอยู่ (ไม่ rewrite) แต่ถือเป็น **derived/editable view** ที่ต้อง reconcile กับ IR ผ่าน mapping ใน §3
- เมื่อ native ↔ IR ไม่ตรง (เช่น import VHDL ที่มี construct ไม่รองรับ) → บันทึก information‑loss marker + แจ้งผู้ใช้ ไม่กลืนเงียบ

---

### สรุป: ทำไมต้องมี IR
ถ้าฐานข้อมูลกลางไม่มีความหมายที่ชัดและเป็นหนึ่งเดียว การเพิ่ม AI จะแค่ทำให้ความผิดพลาด *เกิดเร็วและซับซ้อนขึ้น* — IR คือสิ่งที่ทำให้ oracle/co‑sim/hash‑chain/targeted‑edit ทั้งหมด *อ้างอิงของสิ่งเดียวกัน* ได้จริง
