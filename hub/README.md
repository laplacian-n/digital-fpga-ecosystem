# `hub/` — Foundation (Phase 0.5): semantic core + durable state

ฐานที่ "ทน" ตามแผนเฟส 0.5 (Foundation ก่อน AI) — ของที่เดิมทำเป็น Python function
ลอย ๆ ใน `ai/` ตอนนี้มี **semantic core เดียว + สถานะที่ทน + hash chain** รองรับ

## ไฟล์
| ไฟล์ | บทบาท | สเปค |
|---|---|---|
| `ir.py` | **Canonical IR** — gate netlist = source of truth; canonical JSON; **semantic_hash** (topology) vs **presentation_hash** (layout); stable UID + revision; typed transactional patch (expected_revision + precondition → apply/rollback) | doc 08 |
| `errors.py` | **Error taxonomy** — `{code,class,message,refs,evidence}`; class = transient/deterministic/policy/resource; retry & confidence-gate helpers | doc 07 |
| `store.py` | **Durable store (SQLite)** — designs/revisions/artifacts(immutable)/pipeline_state(evidence)/jobs(durable)/trace; **hash-chain staleness** | doc 06 |
| `demo_foundation.py` | test พิสูจน์ hash-chain (move≠stale, semantic-edit=stale, precond guard) | — |

## คุณสมบัติหลัก (พิสูจน์แล้วใน demo)
- **เฉพาะ semantic change ที่ invalidate downstream** — ขยับ node เปลี่ยนแค่ presentation_hash → sim/vhdl/synth ไม่ stale; แก้ topology → stale ทั้งสาย (hash chain)
- **evidence-based state** — แต่ละ stage เก็บ status + input_hash (semantic_hash ตอนรัน) + evidence; stale = input_hash ≠ semantic_hash ปัจจุบัน
- **immutable artifacts** — ผลแต่ละ stage tag ด้วย semantic_hash ที่สร้างมา
- **durable jobs** — job record อยู่ข้ามการ restart; `reap_orphans()` มาร์ค running→orphaned (JOB-ORPHANED)
- **revisions** — เก็บ IR ทุก revision (rollback/compare — เฟส 5)
- **typed patch** — แก้บน IR ไม่ใช่ text; optimistic lock ด้วย expected_revision

## รัน
```
cd hub && py -3.10 demo_foundation.py     # พิสูจน์ hash-chain semantics
py -3.10 ir.py <intent.json>              # ดู semantic/presentation hash
```

## ยังเหลือใน Phase 0.5 / ถัดไป
- รวม `ai/pipeline.py` ให้บันทึกผ่าน Store นี้ (แต่ละ stage → record_stage + put_artifact) = จุดเริ่ม **Python HUB จริง**
- worker isolation + kill-tree เต็มรูป (ตอนนี้ subprocess timeout ใน synth/cosim ครอบบางส่วน)
- co-sim semantics contract, threat model (doc), Board Profile (มีใน `ai/board`)
- ต่อ top-down เป็น projection over IR (เฟส 5), mapping native gate JSON ↔ IR (ไม่ rewrite editor)
