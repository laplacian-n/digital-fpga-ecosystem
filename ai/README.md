# `ai/` — ฝั่ง AI ของ ecosystem (local model → topology → เครื่องวาดเอง)

> เตรียมโดย session ผู้ช่วย ขณะที่เจ้าของงานแก้ router ใน`schematic&bus2vhdl.html`
> ยังไม่ได้ดาวน์โหลดโมเดล/รันไทม์ — รอเลือกโมเดลก่อน (ดูข้อ "ขั้นถัดไป")

หลักการ (ตาม memory `project-ai-drawing-approach`): **LLM ออกแค่ topology
เท่านั้น — ไม่มี x/y/pts** แล้ว `autoRouteSheet` (deterministic) คำนวณ geometry
เอง นี่คือฝั่งที่ป้อน "Intent-JSON" ให้ตัววาดที่นายทำอยู่

## ไฟล์ในนี้
| ไฟล์ | หน้าที่ |
|---|---|
| `grammar/intent.gbnf` | GBNF บังคับ decode ให้ออกมาเป็น Intent-JSON เป๊ะ (ตัด x/y/pts ทิ้งตั้งแต่ระดับ token) |
| `prompts/intent_system.md` | system prompt สอน schema + กติกา + few-shot (half/full adder) |
| `intent_validate.py` | มิเรอร์ `validateIntent()` ใน editor แบบเป๊ะ (code/hint เดียวกัน) — ใช้เป็น ERC gate ฝั่ง hub |
| `intent_client.py` | คุยกับ endpoint OpenAI-compatible + grammar + loop validate→retry (stdlib ล้วน ไม่ต้อง pip) |
| `setup_llama.ps1` | โหลด llama.cpp (CUDA) + โมเดล GGUF แล้วบอกคำสั่งสตาร์ท server |

## สถาปัตยกรรมที่ยึด (locked)
- **engine-agnostic ผ่าน OpenAI-compatible endpoint** — เริ่มที่ **llama.cpp**
  (เพราะ GBNF grammar = อาวุธกัน hallucinate ที่แรงสุดสำหรับโมเดลเล็ก),
  fallback Ollama ได้ถ้าจำเป็น สลับด้วย env `AI_ENDPOINT`
- **validate-then-apply** — ทุก intent ต้องผ่าน `validate_intent` ก่อนถึงจะส่งเข้า
  `drawIntent`/`autoRouteSheet` ใน editor; error มี code+hint ป้อนกลับให้โมเดลแก้เอง

## เครื่องนี้
RTX 4050 Laptop **VRAM 6GB** · Python 3.10.5 · ดิสก์ว่าง ~413GB · ยังไม่มี
ollama/llama.cpp/โมเดล (fine-tune ทีหลังบน 5060ti 16GB)

## flow เต็ม (เมื่อโมเดลพร้อม)
```
NL spec ──> intent_client.generate_intent()
              ├─ system prompt + GBNF grammar ─> llama-server (/v1/chat/completions)
              ├─ _extract_json ─> validate_intent()  ── ไม่ผ่าน ─> ป้อน hint กลับ (retry ≤3)
              └─ ผ่าน ─> Intent-JSON  ──(ส่งเข้า editor)──> drawIntent ─> autoRouteSheet ─> รูปชั้นครู
```

## สถานะ (ทดสอบจริงแล้ว 2026-09-17)
- ✅ โหลดครบ: `llama/llama-server.exe` (b11016 CUDA 12.4 + cudart), `models/` มี 3B (2.0GB) + 7B (4.4GB)
- ✅ server รันบน GPU: 3B `-ngl 999` ลง VRAM ครบ (~2.1GB, โหลด ~4s); 7B `-ngl 20` (~3.4GB, ที่เหลือบน CPU)
- ✅ GBNF + client + validate→retry ทำงาน end-to-end: NL → Intent-JSON ที่ผ่าน validate ok=True
- ⚠️ **ผลสำคัญ:** GBNF การันตีแค่ **โครงสร้าง** — ทั้ง 3B และ 7B ยัง **เดา boolean logic ผิด**
  จาก prose ในช็อตเดียว (เช่น sum ต่อผิด gate, มี gate ห้อยลอย) → ต้องมีชั้นตรวจ logic
  (sim-oracle เทียบ truth table) มาขับ retry หรือใช้ template สำหรับโครงที่รู้จัก
- 🐞 เจอกับดัก llama.cpp GBNF (แก้แล้วในไฟล์): (1) `\` ติดกับ `]` ใน char class parse พัง →
  ใช้ string เป็น identifier-safe แทน (2) alternation ห้ามขึ้นบรรทัดใหม่ด้วย `|` → รวมบรรทัดเดียว

### คำสั่งสตาร์ท (ยืนยันแล้ว)
```
cd ai\llama
.\llama-server.exe -m ..\models\qwen2.5-coder-3b-instruct-q4_k_m.gguf --port 8080 --host 127.0.0.1 -ngl 999 -c 4096
# 7B: เปลี่ยนไฟล์เป็น ...7b... แล้วใช้ -ngl 20
cd ..  &&  py -3.10 intent_client.py "full adder a b cin -> sum, cout"
```

## ขั้นถัดไป
1. **ชั้น correctness** (สำคัญสุด): intent → sim เทียบ truth table/oracle → ป้อน "logic ผิดตรงไหน"
   กลับให้โมเดลแก้ (targeted) หรือ reject — ดู `_ecosystem_docs/06_correctness_and_robustness.md`
2. ปรับ prompt/few-shot: ป้อนสมการ gate-level หรือ K-map/truth-table แทน prose เพื่อลดการเดา logic
3. ต่อ `intent_client` → editor: bridge (HTTP/MCP แบบ `topdown_mcp.py`) push intent เข้า `drawIntent` แล้ว route
4. golden intent corpus (อนุมัติทีละดีไซน์) + GBNF v2 (DFF/MUX: pin d/clk/q, s/d0/y)
5. ต่อ pipeline: intent → VHDL (`buildSchematicFromVhdl` มีแล้ว) → sim → FPGA_Builder
6. (ช่องโหว่ validate) ทั้ง `validateIntent` (editor) และ mirror นี้ยัง **ไม่จับ** OUT/ขา gate ที่มี
   หลาย driver หรือ gate output ที่ห้อยลอย — ควรเพิ่มกฎ MULTI_DRIVER/DANGLING (แตะ editor ตอนว่าง)
