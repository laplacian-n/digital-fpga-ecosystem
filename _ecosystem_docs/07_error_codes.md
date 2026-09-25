# 07 — Error Code Taxonomy

> จากรีวิวรอบ 2: retry policy, regression assertion, confidence gate และ trace ต้องมี **key คงที่**
> ไม่งั้นจับ regression / ตัดสิน retry / วัดผล ไม่ได้ · รหัสคงที่รูปแบบ `DOMAIN-NNN`

---

## Retry class (ทุกรหัสต้องระบุคลาส)

| class | หมายความว่า | นโยบาย |
|---|---|---|
| **transient** | ชั่วคราว (license busy, I/O ชั่วคราว) | retry อัตโนมัติได้ (มี backoff) |
| **deterministic** | ผิดที่แก้ได้ (syntax, width) | ส่งกลับให้ AI/ผู้ใช้แก้ พร้อม error‑diff |
| **policy** | ต้องห้าม (path violation, prohibited cmd, แตะ oracle) | **ห้าม retry** — หยุด + แจ้ง |
| **resource** | timeout/memory/disk เกิน | ต้องปรับ limit หรือขออนุมัติ ไม่ retry ดิบ ๆ |

## Domains

| domain | ระดับ pipeline | ตัวอย่างรหัส (คลาส) |
|---|---|---|
| **SCHEMA** | รูปแบบ JSON/IR | `SCHEMA-001` malformed (det) · `SCHEMA-002` unknown field (det) |
| **SEM** | semantic ก่อน layout | `SEM-003` width‑mismatch (det) · `SEM-004` floating‑net (det) · `SEM-005` multi‑driver (det) · `SEM-006` comb‑loop (det) |
| **ERC** | gate ERC (~30 ข้อ) | `ERC-0xx` map 1:1 กับ rule ใน `runSynthesis` (det) |
| **COSIM** | JS‑sim vs GHDL | `COSIM-X-MISMATCH` (det) · `COSIM-STROBE-DIFF` (det) · `COSIM-RESET-DIFF` (det) |
| **ORACLE** | เทียบ oracle | `ORACLE-FAIL` output≠expected (det) · `ORACLE-STALE` (auto) · `ORACLE-AMEND-REQUIRED` (policy) |
| **SYNTH** | หลัง synthesis | `SYNTH-LATCH` (det) · `SYNTH-BLACKBOX` (det) · `SYNTH-UNCONNECTED` (det) · `SYNTH-MULTIDRIVER` (det) |
| **IMPL** | place/route | `IMPL-UNROUTED` (det) · `IMPL-UTIL-OVER` (resource) |
| **TIMING** | timing | `TIMING-WNS-NEG` (det) · `TIMING-UNCONSTRAINED` (det) |
| **DRC** | design‑rule | `DRC-xxx` (det) |
| **BOARD** | Board Profile / program | `BOARD-PIN-DUP` (det) · `BOARD-IOSTD-BAD` (det) · `BOARD-ID-MISMATCH` (policy) · `BOARD-RESERVED-PIN` (policy) |
| **JOB** | job manager | `JOB-TIMEOUT` (resource) · `JOB-CANCELLED` · `JOB-ORPHANED` (transient) · `JOB-BUDGET-EXCEEDED` (resource) |
| **SEC** | security | `SEC-PATH-TRAVERSAL` (policy) · `SEC-SYMLINK` (policy) · `SEC-CMD-NOT-ALLOWED` (policy) |
| **AI** | AI orchestrator | `AI-PATCH-NODIFF` patch ไม่ต่างจากเดิม (policy) · `AI-PATCH-PRECOND` revision/hash ไม่ตรง (det) · `AI-SET-PASSED-DENIED` (policy) · `AI-TOUCH-LOCKED` แตะ oracle/pin/clock (policy) |

## กติกาการใช้

- ทุก validation/gate/tool wrapper **คืน error object** `{code, class, message, refs:[uid...], evidence}` เสมอ (ไม่ใช่ string ลอย)
- **retry policy** อ่าน `class` เพื่อตัดสิน (det→ส่งแก้, policy→หยุด, transient→retry, resource→escalate)
- **regression / mutation test** assert ด้วย `code` (เช่น "ฉีดบั๊ก multi‑driver แล้วต้องได้ `SEM-005`")
- **confidence gate**: มี code ในกลุ่ม policy/board = บังคับ human เสมอ
- **AI‑PATCH‑NODIFF**: รอบ retry ต้องเช็ค patch‑similarity กับรอบก่อน ถ้าเหมือนเดิม = หยุด (กัน AI วนแก้แบบเดิม)

> รหัสเป็น append‑only: เพิ่มได้ ห้ามเปลี่ยนความหมายรหัสเดิม (regression/trace เก่าอ้างอยู่)
