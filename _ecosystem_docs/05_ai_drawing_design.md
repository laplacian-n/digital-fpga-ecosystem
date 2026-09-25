# 05 — ทำให้ AI "วาดวงจร" ได้สวยและเชื่อถือได้

> ปัญหา: LLM (โดยเฉพาะตัวเล็ก) กำหนด `x,y` และลาก polyline สายเองไม่เก่ง → วางทับกัน สายพันกัน
> ทางออก: **แยก logical ออกจาก geometric** — AI ทำแค่ topology, เครื่องคิด geometry

---

## 1. หลักการแกน: AI = topology, Engine = geometry

```
AI ออก:  "มี component อะไรบ้าง + ขาไหนต่อขาไหน + hint เชิงความหมาย"
         (ไม่มี x,y, ไม่มี pts ของสายเลย)
   │
   ▼
Layout Engine (deterministic):  คำนวณ x,y  →  จัด layer  →  ลดการไขว้
   │
   ▼
Auto-Router (deterministic):    เดินสาย orthogonal (Manhattan) + รวม junction
   │
   ▼
ออกเป็น native schema ของ editor (component มี x,y ; wire มี autoPts)  →  import เข้า editor
```

LLM เก่งเรื่อง "ความสัมพันธ์" (a.out → b.in) ไม่เก่งเรื่อง "พิกัด" → เราเอางานที่มันเก่งมาให้มันทำอย่างเดียว ที่เหลือให้อัลกอริทึมที่ถูกต้องเสมอทำ

## 2. สิ่งที่ AI ออก (Intent schema — บังคับด้วย GBNF grammar)

```jsonc
{
  "components": [
    { "id": "u1", "type": "AND2", "params": {}, "role": "logic",
      "group": "stage1", "label": "g1" },
    { "id": "clk", "type": "IN", "params": {"name":"clk"}, "role": "clock" },
    { "id": "y",   "type": "OUT", "params": {"name":"y"}, "role": "output" }
  ],
  "nets": [                         // ← netlist ล้วน ไม่มีพิกัด/เส้น
    { "from": "clk.p", "to": "u1.in0" },
    { "from": "u1.out", "to": "y.p", "kind": "signal" }
  ],
  "hints": {                        // ← ทางเลือก คุมทิศแบบ "ความหมาย" ไม่ใช่พิกัด
    "feedback": ["reg.q -> u1.in1"],// สายย้อนกลับ → router อ้อมให้สวย
    "rows": [["a","b"],["sum"]],    // อยากให้ a,b อยู่แถวเดียวกัน
    "sideOverride": {"rst":"bottom"}
  }
}
```

จุดสำคัญ:
- **ไม่มี `x`,`y`,`pts` ในไวยากรณ์ที่ AI ออกได้เลย** → ตัดโหมดพังที่ยากสุดทิ้งตั้งแต่ต้น
- `role` (`input|output|clock|reset|logic`) ให้ engine ตรึงตำแหน่งด้าน (clock ล่างซ้าย, output ขวา ฯลฯ)
- `group` → รวมเป็นก้อน (compound node) วางใกล้กัน
- ทั้งหมดผ่าน **validate-then-apply** (แบบ `save_design`/ERC): ถ้า net ชี้ขาที่ไม่มีจริง → reject พร้อม hint ให้ AI แก้ ไม่วาดของพัง

## 3. Layout Engine — เลือก **ELK** (Eclipse Layout Kernel, `elkjs`)

ทำไม ELK:
- **Layered algorithm (Sugiyama)** = วงจร combinational ไหลซ้าย→ขวาสวยโดยธรรมชาติ
- **Port constraints** — บังคับได้ว่า gate input อยู่ซ้าย output อยู่ขวา (ตรงกับสัญลักษณ์วงจร)
- **Orthogonal edge routing** ในตัว — เดินสากมุมฉาก หลบ node รวมช่องเดินสาย
- รันเป็น **JS ล้วน** ในเบราว์เซอร์ (ตรงกับ editor ที่เป็น HTML) — bundle ไว้ใน Hub ใช้ offline
- รองรับ **hierarchy** (compound node) — ตรงกับ `SCH:` instance / topdown block

ขั้นตอน engine:
1. **จัด layer**: longest-path จาก input; input ซ้ายสุด, output ขวาสุด
2. **จัดลำดับใน layer**: barycenter/median heuristic ลดการไขว้สาย
3. **ตรึงด้านพอร์ต**: gate `in*` ซ้าย, `out` ขวา ตาม `role`
4. **snap เข้ากริด** ของ editor (`GRID=11`, `snap()`) → เป๊ะสะอาด
5. **route สาย** orthogonal → เติมลง `wire.autoPts`, จุดร่วม → JUNCTION

*(ถ้าไม่อยากพึ่ง ELK ทั้งหมด: editor มี relayout/heal อยู่แล้ว ใช้ ELK คิดตำแหหน่ง node แล้วให้ router เดิมของ editor เดินสายก็ได้ — ทดลองเทียบคุณภาพ)*

## 4. Template-based placement (สำหรับงานละเอียดอ่อน / โครงที่รู้จัก)

โครงสร้างที่พบบ่อย (counter, FSM, 7-seg decoder, register file, comparator) เก็บเป็น **template ที่ layout สวยไว้แล้ว** ในคลังโมดูล
- AI แค่ **เลือก template + ใส่ param** (เช่น counter N-bit) → ได้ผังสวยทันที ไม่ต้อง layout ใหม่
- งานใหญ่ = AI วาง **บล็อกเทมเพลต** เป็นชิ้น ๆ, engine เดินสาย **ระหว่างบล็อก** → ลดภาระ layout ลงมาก
- นี่คือ "template สำหรับงานละเอียดอ่อน" ในสเปคของคุณ — และเป็นตัวกัน hallucinate ชั้นดี (โครงมาจากของจริงที่ผ่านการตรวจแล้ว)

## 5. Refine loop — แยก "topology ผิด" ออกจาก "layout ยังไม่สวย"

```
AI → topology → validate → ELK layout → render
                                  │
                                  ├─ layout ไม่สวย? (วัดด้วย metric: จำนวนไขว้,
                                  │   ทับ, ความยาวสาย, aspect) → ELK รันใหม่ด้วย
                                  │   พารามิเตอร์อื่น  ← *เครื่องแก้เอง ไม่รบกวน AI*
                                  │
                                  └─ topology ผิด? (เจอจาก ERC/sim) → ป้อน error
                                      กลับให้ AI แก้เฉพาะ net/component ที่เกี่ยว
                                      *(targeted edit — ไม่ rewrite ทั้งผัง)*
```

- **AI ไม่ยุ่งกับความสวย** — ความสวยเป็นงานของ engine + metric ล้วน
- AI กลับมาทำงานเฉพาะเมื่อ **ตรรกะผิด** (ERC/sim บอก) เท่านั้น

## 6. เคารพงานที่ผู้ใช้/AI แก้มือ (lock layout)

editor มี `lock-layout` อยู่แล้ว — ใช้หลักนี้:
- ครั้งแรก engine วางให้ทั้งหมด
- ผู้ใช้ขยับ/ล็อกบางส่วนได้
- รอบถัดไปที่ AI แก้ **topology**, engine จัดใหม่เฉพาะส่วนที่ **ไม่ถูกล็อก** → ของที่ผู้ใช้ตั้งใจวางไม่โดนรื้อ (สอดคล้อง targeted-edit)

## 7. ต่างกันเล็กน้อยระหว่าง 2 editor

| | Topdown (บล็อก) | Gate (implementable) |
|---|---|---|
| node | ใหญ่ น้อย | เล็ก เยอะ |
| layout | ELK layered, node ใหญ่ | ELK layered + port constraint + orthogonal |
| ความยาก | ง่ายกว่า | ยากกว่า (สายเยอะ/บัส) |
| bus | advisory | ต้อง route บัส /n + bustap |

ทั้งคู่ใช้ engine ตัวเดียวกัน ต่างที่พารามิเตอร์ (ขนาด node, spacing, port constraint)

## 8. สรุปเป็นกฎ 5 ข้อ (สำหรับ implement)

1. ไวยากรณ์ที่ AI ออก **ห้ามมี** `x`,`y`,`pts` — มีแค่ component + net + hint เชิงความหมาย
2. ตำแหน่ง = **ELK layered**; สาย = **orthogonal auto-router**; ทุกอย่าง snap กริด editor
3. โครงที่รู้จัก = **template สวยสำเร็จ**; AI แค่เลือก+ใส่ param แล้ววางเป็นบล็อก
4. ความสวยวัดด้วย **metric + engine แก้เอง**; AI แก้เฉพาะเมื่อ **ตรรกะผิด** (targeted)
5. เคารพ **lock-layout**; รอบใหม่จัดเฉพาะส่วนไม่ล็อก

> ผลลัพธ์: โมเดลเล็กก็วาดสวยได้สม่ำเสมอ เพราะมันไม่เคยต้องเดาพิกัดเลย
