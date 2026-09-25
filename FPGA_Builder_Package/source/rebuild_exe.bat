@echo off
REM สร้าง FPGA_Builder.exe ใหม่จาก source (สำหรับผู้พัฒนา)
REM ต้องมี Python + pip install pyinstaller
cd /d "%~dp0"
python -m pip install --quiet pyinstaller
python -m PyInstaller --noconfirm --onefile --windowed --name FPGA_Builder ^
  --distpath "%~dp0.." --workpath "%TEMP%\fpgabuild" --specpath "%TEMP%\fpgabuild" ^
  fpga_builder.py
echo.
echo เสร็จ - ได้ FPGA_Builder.exe ในโฟลเดอร์หลัก
pause
