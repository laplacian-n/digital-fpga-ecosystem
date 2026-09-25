@echo off
"C:\Users\dinuc\OneDrive\??????\digital\FPGA_Builder_Package\tools\openFPGALoader\openFPGALoader.exe" -c ft2232 --detect
if errorlevel 1 exit /b 1
