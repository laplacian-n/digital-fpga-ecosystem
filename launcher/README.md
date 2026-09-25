# launcher — FPGA Ecosystem เป็นโปรแกรมเดียว

`app.py` รวมทุกอย่างไว้ในโปรแกรมเดียว ผู้ใช้ไม่ต้องรัน Python หรือติดตั้ง lib เอง

- **เซิร์ฟเวอร์ตัวเดียว** ที่ `127.0.0.1:8770` เสิร์ฟหน้า Schematic Studio / Top-Down และรัน backend (`ai/chat_server.py`: AI chat, `/sim`) อยู่ใน process เดียวกัน ส่วน AI chat ในตัววาดชี้มาที่เซิร์ฟเวอร์นี้ให้เอง
- **หน้าต่าง Home** มีรายการโปรเจกต์กับหน้าตั้งค่า ส่วนโปรแกรมย่อยแต่ละตัวเปิดเป็นหน้าต่างแยกของตัวเอง (ใช้ Edge/Chrome `--app` ซึ่ง Windows 10/11 มี Edge อยู่แล้ว)
- **ที่เก็บโปรเจกต์** อยู่ที่ `Documents\FPGA Ecosystem\Projects\<ชื่อโปรเจกต์>\` เวลากดบันทึก/ส่งออกในตัววาด ไฟล์จะลงโฟลเดอร์นี้แทน Downloads (ใช้ `web/shim.js` ที่ inject ตอนเสิร์ฟ ตัวไฟล์ HTML เองไม่ได้แก้)
- **ตั้งค่าฟีเจอร์** (AI / LLM / sim / GHDL / FPGA build / workspace) เก็บใน `%APPDATA%\FPGA Ecosystem\config.json`
- โปรแกรมจะปิดตัวเองประมาณ 2 นาทีหลังปิดหน้าต่างสุดท้าย หรือกด "ปิดโปรแกรม" ในหน้าตั้งค่า

## รันตอนพัฒนา

```
python launcher/app.py            # เปิดหน้าต่าง Home
python launcher/app.py --no-open  # รันแค่เซิร์ฟเวอร์ แล้วเปิด http://127.0.0.1:8770 เอง
```

## สร้างไฟล์แจก (Windows)

```
powershell -ExecutionPolicy Bypass -File launcher\build_windows.ps1
```

จะได้ไฟล์เหล่านี้
- `dist\FPGAEcosystem\` เป็นโฟลเดอร์ portable ที่ zip ไปแจกได้เลย
- `dist\FPGAEcosystem-Setup-<ver>.exe` เป็นตัวติดตั้งที่มีหน้าให้เลือกฟีเจอร์ (ต้องมี Inno Setup 6)

อีกทางหนึ่งคือ push tag เช่น `git tag v0.1.0 && git push origin v0.1.0` แล้ว GitHub Actions (`.github/workflows/build-windows.yml`) จะ build และแนบไฟล์ไว้ใน Releases ให้เอง

ถ้าต้องการแถมเครื่องมือไปในชุด ให้วางไว้ก่อน build
- `FPGA_Builder_Package\tools\openFPGALoader\` สำหรับโหลด .bit ลงบอร์ด
- `ai\tools\ghdl\` สำหรับ co-simulation

## สิ่งที่แจกไปด้วยไม่ได้หรือไม่ได้แจก
- **Vivado** เป็นลิขสิทธิ์ของ AMD และมีขนาดประมาณ 15 GB ให้ผู้ใช้ติดตั้ง Vivado ML Standard (ฟรี) เอง โปรแกรมจะหาเจอเองใน `C:\AMD\Vivado\*` และ `C:\Xilinx\Vivado\*` หรือกำหนด path ในหน้าตั้งค่า
- **โมเดล LLM** มีขนาดหลาย GB ให้ตั้งค่าในหน้าตั้งค่าเป็น "ต่อเซิร์ฟเวอร์" หรือ "รันในเครื่อง" (ชี้ไปที่ llama-server กับไฟล์ .gguf) ถ้าไม่มีโมเดล AI chat ก็ยังทำงานกับสมการ ตารางความจริง และวงจรมาตรฐานได้
- `ai/rag/_raw`, `ai/rag/content` (ข้อความจากเอกสารวิชา) ไม่ได้ใส่ในตัวติดตั้ง
