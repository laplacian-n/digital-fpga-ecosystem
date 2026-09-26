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

เครื่องมือที่แถมไปในชุด (`dist\FPGAEcosystem\tools\`)
- **openFPGALoader** (Apache-2.0) สำหรับโหลด .bit ลงบอร์ด ถ้ามี `FPGA_Builder_Package\tools\openFPGALoader\` จะใช้ตัวนั้น ไม่มีจะติดตั้งแพ็กเกจ MSYS2 `mingw-w64-ucrt-x86_64-openFPGALoader` (runner ของ GitHub มี MSYS2 ที่ `C:\msys64`) แล้วคัดลอก exe + DLL ที่ต้องใช้ + `spiOverJtag_xc7s15ftgb196.bit` (สำหรับเขียน Flash) บน CI ถ้าหาไม่ได้ build จะล้ม
- **Zadig** (GPLv3) สำหรับเปลี่ยนไดรเวอร์บอร์ดเป็น WinUSB ดาวน์โหลดตอน build (ถ้าโหลดไม่ได้ก็ข้าม)
- `ai\tools\ghdl\` สำหรับ co-simulation ถ้าวางไว้ก่อน build

## หน้า “เริ่มต้นใช้งาน”
เปิดเองตอนเริ่มโปรแกรมจนกว่าจะกด “เสร็จแล้ว” (`setup_done` ใน config) ตรวจ Vivado, openFPGALoader, ไดรเวอร์ USB ของบอร์ด (Windows: ดูว่า FT2232 interface 0 ใช้ WinUSB หรือยัง ผ่าน `Win32_PnPEntity`) และโมเดล AI (ไม่บังคับ) แต่ละข้อมีปุ่มแก้ (ดาวน์โหลด / ระบุ path / เปิด Zadig / ทดสอบกับบอร์ดด้วย `openFPGALoader --detect`) API: `GET /api/setup/check`, `POST /api/setup/done`, `POST /api/setup/zadig`

## สิ่งที่แจกไปด้วยไม่ได้หรือไม่ได้แจก
- **Vivado** เป็นลิขสิทธิ์ของ AMD และมีขนาดประมาณ 15 GB ให้ผู้ใช้ติดตั้ง Vivado ML Standard (ฟรี) เอง โปรแกรมจะหาเจอเองใน `C:\AMD\Vivado\*` และ `C:\Xilinx\Vivado\*` หรือกำหนด path ในหน้าตั้งค่า
- **โมเดล LLM** มีขนาดหลาย GB จึงไม่แถมในตัวติดตั้ง ผู้ใช้กดดาวน์โหลดเองได้ในหน้าตั้งค่า ▸ **โมเดล AI ในเครื่อง** (ดาวน์โหลด llama.cpp แบบใช้การ์ดจอ/CPU แล้วเลือกโมเดล Qwen2.5-Coder 1.5B / 3B / 7B แล้วกด "เริ่มโมเดล") ไฟล์เก็บใน `%LOCALAPPDATA%\FPGA Ecosystem` (`launcher/llm.py`) หรือจะชี้ไปที่ llama-server / .gguf ที่มีอยู่แล้วก็ได้ ถ้าไม่มีโมเดล AI chat ก็ยังทำงานกับสมการ ตารางความจริง วงจรมาตรฐาน และตอบ "นี่วงจรอะไร" ได้
- `ai/rag/_raw`, `ai/rag/content` (ข้อความจากเอกสารวิชา) ไม่ได้ใส่ในตัวติดตั้ง

## ลงบอร์ดจากในตัววาด
ขั้น "ลงบอร์ด" ใน Schematic Studio เป็นหน้าในโปรแกรมเอง: ตรวจขา → สร้าง .bit (Vivado batch) → โหลดลงบอร์ด (openFPGALoader ชั่วคราว/ถาวร) พร้อม log และคำอธิบาย error ภาษาไทย ตัวรันอยู่ที่ `launcher/board.py` (ใช้ Tcl และคำอธิบาย error ชุดเดียวกับ FPGA Builder) build ในโฟลเดอร์ที่ไม่มีช่องว่าง แล้วคัดลอก .bit กลับเข้าโฟลเดอร์โปรเจกต์ FPGA Builder แบบเดิมยังเปิดได้จาก "ตั้งค่าเพิ่ม" ในหน้านั้น

## ไอคอน
ต้นฉบับคือ `launcher/web/icon.svg` ส่วน `launcher/icon.ico` (exe + ตัวติดตั้ง) และ `launcher/web/icon-*.png` (หน้าต่าง) สร้างจากไฟล์นั้น ถ้าแก้ไอคอนให้ render ใหม่ทุกขนาด (16–256 px) แล้วแทนที่ไฟล์ทั้งหมด ในหน้า editor/Top-Down ไอคอนฝังเป็น data URI ใน `<link rel="icon">`

## อัปเดตโปรแกรม
- เวลาเปิดหน้า Home โปรแกรมจะเช็ก GitHub Releases ของ repo (ไม่เกินทุก 12 ชั่วโมง) ถ้ามีเวอร์ชันใหม่จะขึ้นแถบ "มีเวอร์ชันใหม่" ให้เลือกได้ว่า "อัปเดตเลย", ดู "มีอะไรใหม่" หรือ "ข้ามเวอร์ชันนี้"
- "อัปเดตเลย" (ตัวติดตั้งบน Windows) จะดาวน์โหลด Setup.exe มาติดตั้งทับแบบเงียบ แล้วเปิดโปรแกรมเวอร์ชันใหม่ให้เอง โปรเจกต์ใน Documents และการตั้งค่าใน %APPDATA% ไม่หาย ถ้ารันจากซอร์สหรือไม่ใช่ Windows จะพาไปหน้าดาวน์โหลดแทน
- ปิดการเช็กอัตโนมัติ หรือกดเช็กเองได้ที่หน้าตั้งค่า ▸ อัปเดตโปรแกรม
- **repo ต้องเป็น public** โปรแกรมบนเครื่องคนอื่นถึงจะเห็น release ได้ (ถ้าเป็น private จะขึ้นว่า "ยังไม่มี release") หรือเปลี่ยนไปใช้ repo อื่นสำหรับแจกได้ที่ `update.repo` ใน config.json

### ออกเวอร์ชันใหม่
1. แก้ `VERSION` ใน `launcher/app.py` เช่น `0.2.0` แล้ว commit
2. `git tag v0.2.0 && git push origin v0.2.0`
3. GitHub Actions จะสร้าง Setup.exe กับ zip แล้วแนบไว้ใน Release (ถ้า tag กับ VERSION ไม่ตรงกัน build จะหยุดพร้อมบอกสาเหตุ) เครื่องที่ติดตั้งไว้จะเห็นอัปเดตตอนเปิดโปรแกรมครั้งถัดไป
