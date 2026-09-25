# 10 — Golden Designs Corpus (Regression + Oracle)

> คลังงานอ้างอิงที่ *ถูกต้องพิสูจน์แล้ว* ใช้เป็น (1) regression suite วัดว่าแก้ prompt/โมเดล/generator แล้วดีขึ้นหรือแย่ลง
> (2) seed ของ **verified module library** (ทุกตัวมี oracle ติดมา → verified‑library‑first) (3) ชุดสอน/ตัวอย่าง
> สร้างโดย Claude ผ่าน MCP (บูตแรก) แล้วต่อไปโดย local AI · ดู `06` §15 (coverage), §19 (mutation), §22 (DoD)

---

## 1. รูปแบบแต่ละ design (schema ของ entry)

```jsonc
{
  "id": "half_adder",
  "tier": 0,
  "tags": ["combinational", "arith"],
  "spec": "ผลบวก 1 บิต: sum = a XOR b, carry = a AND b",   // ภาษาคน (ต้นทางของ oracle)
  "interface": {
    "in":  [{"name":"a","w":1}, {"name":"b","w":1}],
    "out": [{"name":"sum","w":1}, {"name":"carry","w":1}]
  },
  "oracle": {                                    // ← สืบจาก spec, freeze, hash (ดู 06 §1,§14)
    "type": "truthtable",                        // truthtable | sequence | property
    "vectors": [                                 // combinational: ครบถ้า in ≤ ~12 บิต
      {"in":{"a":0,"b":0}, "out":{"sum":0,"carry":0}},
      {"in":{"a":0,"b":1}, "out":{"sum":1,"carry":0}},
      {"in":{"a":1,"b":0}, "out":{"sum":1,"carry":0}},
      {"in":{"a":1,"b":1}, "out":{"sum":0,"carry":1}}
    ],
    "coverage": "exhaustive"                      // exhaustive | directed+random(seed=N) | property
  },
  "artifacts": {                                 // เติมเมื่อผ่าน pipeline จริง
    "schematic": "designs/half_adder.schproj.json",
    "vhdl_ref": "golden/half_adder.vhd",         // VHDL อ้างอิงที่ผ่าน co‑sim แล้ว
    "sim_trace": "golden/half_adder.trace.json"
  },
  "board_demo": null                             // ถ้าสาธิตบนบอร์ด: map port→pin (รอ board data)
}
```

**Oracle type ตามชนิดงาน:**
- **truthtable** — combinational, in ≤ ~12 บิต → ครบทุก vector
- **sequence** — sequential/FSM → ลำดับ `(clock, reset, in) → expected out` ต่อรอบ + reset sequence บังคับ (ดู `06` §13)
- **property** — assertion (one‑hot, counter ไม่ข้ามค่า, 7‑seg active‑LOW ฯลฯ) + directed corners + constrained‑random(seed) เมื่อ vector ครบไม่ไหว

## 2. รายการคลัง (28 ตัว + negative)

### Tier 0 — Combinational พื้นฐาน (oracle = truthtable ครบ)
| id | spec ย่อ | in→out |
|---|---|---|
| `half_adder` | sum=a⊕b, carry=a·b | 2→2 |
| `full_adder` | +cin | 3→2 |
| `mux2_1` | เลือก 1 จาก 2 | 3→1 |
| `mux4_1` | เลือก 1 จาก 4 (sel 2b) | 6→1 |
| `demux1_4` | กระจาย 1→4 | 3→4 |
| `decoder2_4` | 2b→one‑hot 4 | 2→4 |
| `encoder4_2` | priority encoder | 4→2(+valid) |
| `comparator_4bit` | eq/gt/lt | 8→3 |
| `seven_seg_decoder` | BCD→7seg **active‑LOW** (common‑anode EDGE) | 4→7 |
| `parity_gen_4bit` | even/odd parity | 4→1 |

### Tier 1 — Arithmetic (truthtable ถ้าไหว / directed+random ถ้าเกิน)
| id | spec ย่อ |
|---|---|
| `adder_4bit` | ripple‑carry, มี cout |
| `adder_8bit` | in 16 บิต → directed+random(seed) |
| `subtractor_4bit` | 2's complement |
| `alu_4bit` | op: add/sub/and/or (sel 2b) + flags (Z,C) |
| `multiplier_4bit` | 4×4→8 (in 8b, truthtable ยังไหว 256) |

### Tier 2 — Sequential (oracle = sequence, reset บังคับ)
| id | spec ย่อ |
|---|---|
| `d_ff` | D flip‑flop |
| `d_ff_clr` | + async clear |
| `t_ff` / `jk_ff` | toggle / JK |
| `register_4bit` | load enable |
| `shift_register_4bit` | SISO + PIPO |
| `counter_4bit_up` | นับขึ้น 0–15, มี reset |
| `counter_up_down` | ทิศเลือกได้ |
| `counter_mod10` | BCD 0–9 (wrap) |
| `clock_divider` | ⟨CLK 50MHz@H11⟩→ช้าลง (เช่น 50MHz→1Hz ÷50,000,000 ; →20Hz scan ÷2,500,000) |

### Tier 3 — FSM / integrated (oracle = sequence + property)
| id | spec ย่อ |
|---|---|
| `fsm_seq_detector_101` | ตรวจลำดับ "101" (overlap) |
| `traffic_light_fsm` | R→G→Y state |
| `vending_machine_fsm` | หยอดเหรียญ→ปล่อยของ + ทอน |
| `debouncer` | ปุ่มเด้ง → template (ดู `09` §5) |
| `synchronizer_2ff` | 2‑FF CDC → template |
| `counter_7seg_demo` | counter + seven_seg_decoder + clock_divider → **สาธิตบนบอร์ด** (รอ board data) |

### Negative cases — ต้องถูก "ปฏิเสธ" (สำหรับ mutation/validator KPI, ดู `06` §19)
| id | ต้องได้ error code (`07`) |
|---|---|
| `bad_multidriver` | `SEM-005` / `ERC-…` |
| `bad_width_mismatch` | `SEM-003` |
| `bad_floating_input` | `SEM-004` |
| `bad_comb_loop` | `SEM-006` |
| `bad_latch_infer` | `SYNTH-LATCH` (เจอตอน post‑synth) |
| `bad_unconnected_out` | `SYNTH-UNCONNECTED` |

## 3. หมวดสำหรับ test strategy (map เข้ารีวิวรอบ 2)
combinational · counter/register/FSM · signed arith+overflow · parameterized width · multi‑clock/reset · X/Z/uninitialized · **invalid‑must‑reject** · synth‑pass‑but‑timing‑fail · resource‑overflow · board‑constraint‑mismatch → รองรับ property‑based / mutation / differential (JS vs GHDL vs ref) / metamorphic testing

## 4. เกณฑ์คุณภาพของคลัง (DoD)
- ทุกตัว (ยกเว้น negative) ต้องผ่าน **ทั้ง pipeline** จนได้ `vhdl_ref` + `sim_trace` ที่ co‑sim ตรง
- ทุกตัวมี **oracle ที่ freeze+hash** และผ่าน **mutation test** (ฉีดบั๊กแล้ว oracle จับได้)
- negative ทุกตัวต้องถูกปฏิเสธด้วย error code ที่ถูกต้อง
- ตัวที่ board_demo ต้อง map pin ครบ + ผ่าน programming gate (`09` §4)

## 5. ลำดับสร้าง (bootstrap)
1. เริ่ม Tier 0 (`half_adder` เป็นตัวแรก = ตัวเดียวกับ walking skeleton) ผ่าน MCP → gate editor → ตรวจ ERC → gen VHDL
2. เก็บ schematic + spec + truthtable เป็น golden (VHDL_ref/sim_trace เติมเมื่อ sim/co‑sim พร้อม)
3. ไล่ Tier 1→3 · negative cases แทรกได้ทุกเมื่อ
4. ทุกตัวที่ verified → เข้า **module library** (verified‑library‑first, `06` §20)
