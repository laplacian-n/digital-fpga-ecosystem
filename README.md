# Digital FPGA Ecosystem

ชุดเครื่องมือสอน/ทำแลปวงจรดิจิทัลบนบอร์ด **EDGE Spartan-7 (XC7S15)** — วาดวงจร → จำลอง → เลือกขา → ลงบอร์ด
พร้อมผังบล็อก Top-Down สำหรับทำรายงาน และ AI ช่วยวาด (LLM ออกแค่ topology, เครื่องคำนวณ geometry เอง)

## ส่วนประกอบ

| โฟลเดอร์ / ไฟล์ | คืออะไร |
|---|---|
| `schematic&bus2vhdl.html` | **Schematic Studio** — ตัววาดวงจรเกต (ไฟล์เดียว เปิดใน browser ได้เลย): sub-block/ลำดับชั้น, auto-router, จำลอง (combinational + sequential/ripple/JK-FF, วิเคราะห์ clock divider), เลือกขาบอร์ด, สร้าง VHDL/XDC, AI chat, คลังโมดูล |
| `topdown/` | **Top-Down** — ผังบล็อก layered สำหรับรายงาน A4 / PDF / พล็อตเตอร์ G-code (เปิดจากโปรแกรมหลัก: Tools ▸ Top-Down) + `topdown_mcp.py` |
| `ai/` | ฝั่ง AI: intent validator, netlist sim, VHDL/XDC codegen, cosim, synth ผ่าน Vivado, `chat_server.py` (:8770), RAG retriever — ดู `ai/README.md`, `ai/PIPELINE.md` |
| `hub/` | Foundation: canonical IR, semantic/presentation hash, durable SQLite store — ดู `hub/README.md` |
| `FPGA_Builder_Package/source/` | ซอร์สของ FPGA Builder (VHDL → .bit → โหลดลงบอร์ด) — ดู `อ่านก่อนใช้งาน.txt` |
| `designs_gate/` | ชุดวงจรตัวอย่าง/golden (`*.schproj.json`) |
| `_ecosystem_docs/` | เอกสารสถาปัตยกรรม, data model, router, board pinout |
| `launcher/mcp_server.py` | **MCP server ให้ Claude ทำงานใน Schematic Studio**: อ่าน วาง ต่อสาย จัดวาง ตรวจ จำลอง เลือกขา ส่งออก VHDL/XDC วิธีเชื่อมต่อดูที่ [`docs/MCP.md`](docs/MCP.md) (ตั้งค่า ▸ เชื่อมกับ Claude) |
| `schematic_mcp.py`, `mcp_config.reference.json` | MCP server รุ่นเก่า (เขียนไฟล์ JSON แล้วกด Sync) + ตัวอย่าง config |
| `launcher/` | **โปรแกรมรวม**: เปิดตัวเดียว ได้ทั้งตัววาด, Top-Down, backend AI/sim, FPGA Builder, หน้าตั้งค่า และที่เก็บโปรเจกต์ พร้อมสคริปต์ build ตัวติดตั้ง Windows |
| `sketch-handoff/` | ไฟล์ส่งต่องานออกแบบ UI |

## เริ่มใช้งาน

**สำหรับผู้ใช้ทั่วไป** ให้โหลด `FPGAEcosystem-Setup-x.y.z.exe` จากหน้า Releases แล้วติดตั้ง (ไม่ต้องใช้สิทธิ์ admin และไม่ต้องลง Python) หรือจะโหลด zip แบบ portable มาแตกไฟล์ก็ได้ จากนั้นเปิด **FPGA Ecosystem** ใช้งานได้เลย มีหน้าตั้งค่าให้เลือกฟีเจอร์ (AI / sim / FPGA build) และเก็บโปรเจกต์ไว้ที่ `Documents\FPGA Ecosystem\Projects` ดูรายละเอียดที่ [`launcher/README.md`](launcher/README.md)

**สำหรับนักพัฒนา** รัน `python launcher/app.py` จะได้โปรแกรมเดียวกัน หรือใช้แต่ละส่วนแยกกันแบบเดิมตามนี้

1. เปิด `schematic&bus2vhdl.html` ใน Chrome/Edge — ใช้งานได้ทันที (ไม่ต้องติดตั้ง)
2. (ถ้าจะใช้ AI / backend sim) `python ai/chat_server.py` แล้วตั้ง endpoint ใน AI chat ด้วย `/endpoint http://127.0.0.1:8770`
3. (ถ้าจะ build .bit) ใช้ FPGA Builder หรือ `ai/synth_vivado.py` — ต้องมี Vivado (ดูด้านล่าง)

## สิ่งที่ไม่ได้อยู่ใน repo (ดู `.gitignore`)

| ส่วน | ขนาด | วิธีได้คืน |
|---|---|---|
| `ai/models/*.gguf`, `ai/llama/` | ~47 GB | `ai/setup_llama.ps1` (โหลด llama.cpp CUDA + โมเดล Qwen) |
| `FPGA_Builder_Package/tools/` (Vivado/ISE ขั้นต่ำ) + `Xilinx.lic` | ~14 GB | ติดตั้ง Vivado 2025.2 / ISE เอง — มีลิขสิทธิ์ของ Xilinx แจกจ่ายต่อไม่ได้ |
| `ai/tools/ghdl` | ~96 MB | ติดตั้ง GHDL (mingw64) |
| `ai/datasets/vhdl` | ~50 MB | dataset VHDL จาก GitHub (dedup) — โหลดใหม่ |
| `ai/rag/index.jsonl`, `emb.npz` | ~65 MB | `python ai/rag/build_index.py` แล้ว `python ai/rag/embed_index.py` |
| `content/`, `labAssignment/`, `mywork/` | — | เอกสารวิชา/ใบงาน/งานแลปจริง — เก็บไว้ในเครื่องเท่านั้น |
| `ai/out/`, `*.bit` | — | ไฟล์ที่ pipeline สร้างขึ้น |
