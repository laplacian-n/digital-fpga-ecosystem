# 11 — Orthogonal Wire Router (จัดเส้นใหม่)

> ผู้ใช้เห็นปัญหาจาก full_adder: เส้นหักเกินจำเป็น, เส้นคนละเส้นวิ่งทับกันเป็นเส้นเดียว, เส้นเฉียด/ลอดใต้ component
> นี่คือ auto-router ใน pipeline DRAW (ดู `05` — AI ออก topology, engine เดินสาย) เอกสารนี้คือดีไซน์อัลกอริทึม

---

## 1. ข้อบังคับ (จากผู้ใช้ — hard constraints)

1. **เส้นอยากตรง** — ถ้าสองเส้นจะหักทั้งคู่ ให้เส้นหนึ่ง "ตรง" อีกเส้นหักแทน (ลด bend รวม, ให้เส้นหลักตรง)
2. **คนละเส้นห้ามทับกัน** (ทับ = วิ่ง collinear ซ้อนแนวเดียวกัน) — **การไขว้ตั้งฉาก (cross) อนุญาต** (ปกติของ schematic)
3. **เส้นห้ามทับ/ลอดใต้ component เด็ดขาด**

Soft: สั้น, สมมาตร, สวย (ตามดุลยพินิจ)

## 2. โมเดลปัญหา

- **Obstacle** = กล่อง bbox ของทุก component (จาก `getSize`+`x,y`+rot/mirror) ขยายขอบ margin ~1 grid → ห้าม A* เดินผ่าน (ข้อ 3)
- **Terminal** = port (ตำแหน่งจาก `portPos`) + **ทิศออกบังคับ**: input ออกซ้าย, output ออกขวา (ตาม `port.dir`+orientation) → เส้นออกจากขาตั้งฉากกับตัว component เสมอ (ไม่วิ่งเลียดตัว)
- **Net** = 1 source (driver) + N sink (จาก `netDriverPort`/`netWires`)
- **Grid** = แลตทิซ pitch = `GRID`(11) หรือ pitch เดินสายที่เลือก ครอบพื้นที่ชีต + margin ตัด cell ที่เป็น obstacle

## 3. อัลกอริทึมหลัก — maze routing (A*) + track discipline

**ต่อ net (source → แต่ละ sink):**
1. **Port stub บังคับ**: เริ่ม/จบด้วยก้านสั้นตรงออกจากขา (ตามทิศ) ก่อนเข้ากริด → ขาสะอาด
2. **A* บนกริด**: cost = `ระยะ + BEND_PENALTY·จำนวนหัก`
   - **BEND_PENALTY สูง** → เส้นอยากตรง (ข้อ 1)
   - **cell ที่เป็น obstacle = บล็อก** (ข้อ 3)
   - **edge-usage (ข้อ 2)**: เมื่อ net หนึ่งใช้ segment แนวนอนบนแถว Y ช่วง x1..x2 → mark unit-edge เหล่านั้นว่า "ใช้แนวนอนแล้ว"; net อื่นที่จะเดิน **แนวเดียวกันทับ** ถือว่าบล็อก (ต้องเลี่ยงไป track อื่น) — แต่ **เดินตัดผ่านตั้งฉากได้** (ไม่บล็อก cross) → กัน collinear overlap แต่ยอมให้ไขว้
3. **Fan-out เป็น rectilinear tree**: sink แรก = trunk, sink ถัดไปแตกกิ่งจาก trunk ที่จุด tap → เกิด **JUNCTION** ที่จุดแตก (โมเดล editor มี JUNCTION อยู่แล้ว)

## 4. ลำดับ & การทำให้ตรง (ข้อ 1 เชิงรุก)

- **ลำดับ net**: เดินเส้น "หลัก/ยาว/trunk" ก่อน → มันได้ track ตรง, เส้นสั้นทีหลังเป็นฝ่ายหลบ/หัก (ตรงกับ "ให้เส้นหนึ่งตรง อีกเส้นหัก")
- **Straighten post-pass**: หลังเดินครบ ไล่ทุก net ถ้า bend ไหนถอดได้โดยไม่ทำให้ทับ (edge ว่าง) → ถอดให้ตรง
- **Track assignment ในช่อง (channel)**: segment ขนานในช่องเดียวกันกระจายคนละ track (offset ทีละ pitch) → ไม่ทับ (ข้อ 2) และเป็นระเบียบ

## 5. Integration กับ editor (ไม่พังของเดิม)

- คำนวณ path ต่อ wire → เขียนลง `wire.autoPts` (จุดภายใน, absolute canvas coords ตามที่ renderer ใช้) แล้ว re-render
- **ทำงานเป็น pass เดี่ยว** เรียกจากปุ่ม (enhance ปุ่ม ↻ relayout เดิม หรือปุ่มใหม่ "Auto-route") — ไม่ไปยุ่ง net/junction/bus logic เดิม
- หลังจัดเสร็จ **ตั้ง lock-layout** (มีปุ่ม 🔓 อยู่แล้ว) → editor ไม่ re-route ทับผลลัพธ์ (ตรงหลัก "respect lock" ใน `05`)
- reposition JUNCTION ไปยังจุด tap ที่ router คำนวณ (ให้ tree สวย)

## 6. แผนสร้าง & ทดสอบ

1. แมพ internals การเรนเดอร์สาย/จุด/bbox/lock ของ editor (Sonnet agent) → รู้ hook แน่นอน
2. เขียน router เป็นฟังก์ชัน self-contained ใน editor JS
3. ทดสอบวนภาพกับ full_adder → เช็ค 3 ข้อบังคับ (ไม่ทับ component, ไม่ collinear overlap, เส้นตรงสุด) → ปรับ BEND_PENALTY/pitch/margin
4. ทดสอบกับดีไซน์ fan-out เยอะ (เช่น mux, decoder) และบัส
5. ผูกเข้า pipeline: ทุกครั้งที่ Sync/สร้างจาก MCP → เรียก auto-route อัตโนมัติ (option) แล้ว lock

## 7. เผื่ออนาคต
ถ้า custom router ยังไม่พอกับงานใหญ่ ค่อยพิจารณา ELK/libavoid (orthogonal connector routing) — แต่เริ่มด้วย custom เพราะคุมได้ + ไฟล์ self-contained (ปรัชญา "โปรแกรมน้อยสุด")
