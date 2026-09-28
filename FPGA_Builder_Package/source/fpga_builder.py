# -*- coding: utf-8 -*-
"""
fpga_builder.py  -  GUI สำหรับแปลง VHDL -> .bit (Spartan-6 xc6slx9) ด้วย Xilinx ISE 14.7

ฟีเจอร์:
  - เลือกไฟล์ VHDL (หลายไฟล์ได้) และเลือก top entity
  - เลือกชิป: part / speed grade / package
  - ตารางกำหนด pin (signal, LOC, IOSTANDARD, ตัวเลือกเสริม)  + import ขาจาก VHDL อัตโนมัติ
  - กด "Build .bit" รัน flow: XST -> NGDBuild -> MAP -> PAR -> BitGen
  - กด "Program FPGA" โหลด .bit ลงบอร์ดผ่าน iMPACT (JTAG)
  - ดูข้อมูล header ของไฟล์ .bit (ชื่อดีไซน์ / ชิป / วันเวลา)
  - หน้าต่าง Log แสดง output ของเครื่องมือแบบเรียลไทม์

ต้องมี Xilinx ISE 14.7 ติดตั้งอยู่ (มี xst, ngdbuild, map, par, bitgen, impact)
รัน:  python fpga_builder.py
"""

import os
import re
import sys
import json
import time
import glob
import queue
import shutil
import struct
import threading
import subprocess
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext

# ----------------------------------------------------------------------------
# ค่าตั้งต้น
# ----------------------------------------------------------------------------
# โฟลเดอร์โปรเจกต์: ถ้าเป็น .exe (PyInstaller) ใช้โฟลเดอร์ที่วาง exe,
# ถ้ารันเป็น .py ใช้โฟลเดอร์ของสคริปต์ (กัน config/build หายไปอยู่ temp)
if getattr(sys, "frozen", False):
    PROJECT_DIR = os.path.dirname(sys.executable)
else:
    PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

PARTS      = ["xc6slx9", "xc6slx4", "xc6slx16", "xc6slx25", "xc6slx45",
              "xc7s15", "xc7s25", "xc7s50"]
SPEEDS     = ["-1", "-2", "-3"]
PACKAGES   = ["tqg144", "csg324", "ftg256", "csg225", "ftgb196", "csga225"]
IOSTANDARDS = ["LVCMOS33", "LVCMOS25", "LVCMOS18", "LVCMOS15", "LVTTL",
               "LVDS_25", "SSTL18_II", "PCI33_3"]

# ----------------------------------------------------------------------------
# โปรไฟล์บอร์ด: pin map + ชิป ของแต่ละบอร์ดที่รองรับ
# ----------------------------------------------------------------------------
# บอร์ดที่ 1: Apex FPGA Surveyor-6 XC6SLX9 (จาก Lab0 Pin List)
_PIN_DESC_APEX = {
    # Slide switches
    "P66": "SW0", "P62": "SW1", "P61": "SW2", "P59": "SW3",
    "P58": "SW4", "P57": "SW5", "P56": "SW6", "P55": "SW7/PB6",
    # LED (2-state)
    "P82": "L0", "P81": "L1", "P80": "L2", "P79": "L3",
    "P78": "L4", "P75": "L5", "P74": "L6", "P67": "L7",
    # Logic monitor (3-state LED)
    "P95": "MN0", "P94": "MN1", "P93": "MN2", "P92": "MN3",
    "P88": "MN4", "P87": "MN5", "P85": "MN6", "P84": "MN7",
    # 7-segment
    "P41": "SEG_A", "P40": "SEG_B", "P35": "SEG_C", "P34": "SEG_D",
    "P32": "SEG_E", "P29": "SEG_F", "P27": "SEG_G", "P26": "SEG_P",
    "P44": "COMMON0", "P43": "COMMON1", "P33": "COMMON2", "P30": "COMMON3",
    # DIP switch (ใช้ขาร่วมกับ K6)
    "P112": "DIP1/K6", "P111": "DIP2/K6", "P105": "DIP3/K6", "P104": "DIP4/K6",
    "P102": "DIP5/K6", "P101": "DIP6/K6", "P100": "DIP7/K6", "P99": "DIP8/K6",
    # Push buttons
    "P45": "PB1", "P46": "PB2", "P47": "PB3", "P48": "PB4",
    "P51": "PB5", "P50": "VRCLK",
    # Clock / serial / buzzer
    "P123": "OSC 20MHz", "P98": "TX", "P97": "RX", "P83": "BUZZER",
    # Flash PROM
    "P64": "FLASH_MOSI", "P65": "FLASH_MISO", "P38": "FLASH_CS", "P70": "FLASH_CCLK",
    # Expansion connectors
    "P5": "K1", "P7": "K1", "P9": "K1", "P11": "K1", "P14": "K1", "P16": "K1", "P21": "K1", "P23": "K1",
    "P6": "K2", "P8": "K2", "P10": "K2", "P12": "K2", "P15": "K2", "P17": "K2", "P22": "K2", "P24": "K2",
    "P124": "K3", "P127": "K3", "P132": "K3", "P134": "K3", "P138": "K3", "P140": "K3", "P142": "K3", "P1": "K3",
    "P126": "K4", "P131": "K4", "P133": "K4", "P137": "K4", "P139": "K4", "P141": "K4", "P143": "K4", "P2": "K4",
    "P114": "K5", "P115": "K5", "P116": "K5", "P117": "K5", "P118": "K5", "P119": "K5", "P120": "K5", "P121": "K5",
}
# บอร์ดที่ 2: EDGE Spartan-7 XC7S15-FTGB196 (จาก XDC ทางการของ allaboutfpga)
# หมายเหตุ: LED บางดวงใช้ขาร่วมกับ 7-Segment / LCD data (ใช้ทีละอย่าง)
_PIN_DESC_EDGE = {
    # ตามคู่มือ EDGE Spartan 7 (User Manual) - ชื่ออุปกรณ์ใช้ตามที่พิมพ์บนบอร์ดจริง
    # หมายเหตุ: SW1 = ปุ่ม Reset FPGA, SW3 = สวิตช์เลือกแหล่งไฟ (ไม่ใช่ I/O)
    # Clock 50 MHz
    "H11": "OSC 50MHz",
    # Slide switch 16 ตัว (เลขบนบอร์ดข้ามช่วงที่เป็นปุ่มกด)
    "K11": "SW2", "M11": "SW4", "N14": "SW5", "P12": "SW6",
    "N10": "SW7", "P10": "SW8", "M10": "SW9", "N4": "SW10",
    "L2": "SW11", "P3": "SW12", "N1": "SW13", "M2": "SW15",
    "L1": "SW17", "J3": "SW19", "K3": "SW21", "J1": "SW22",
    # Push button 5 ตัว (ปกติ=0 กดแล้ว=1)
    "J14": "SW14 ปุ่มกด", "J13": "SW16 ปุ่มกด", "J12": "SW18 ปุ่มกด",
    "J11": "SW20 ปุ่มกด", "L13": "SW23 ปุ่มกด",
    # LED 16 ดวง (บนบอร์ดพิมพ์ D2..D17 - D1 คือไฟ DONE) เปิดใช้ต้องมี jumper
    # J4/J9 ที่ตำแหน่ง GND; แถวแรกร่วมขา LCD data, แถวสองร่วมขา 7-segment
    "K12": "LED D2/LCD_D7", "M12": "LED D3/LCD_D6", "M14": "LED D4/LCD_D5",
    "P13": "LED D5/LCD_D4", "N11": "LED D6/LCD_D3", "P11": "LED D7/LCD_D2",
    "L5": "LED D8/LCD_D1", "M4": "LED D9/LCD_D0",
    "L3": "LED D10/SEG_A", "P4": "LED D11/SEG_B", "P2": "LED D12/SEG_C",
    "M3": "LED D13/SEG_D", "M1": "LED D14/SEG_E", "J4": "LED D15/SEG_F",
    "K4": "LED D16/SEG_G", "J2": "LED D17/SEG_DP",
    # 7-segment digit enable (active low, common anode)
    "H4": "DIGIT1", "H3": "DIGIT2", "H2": "DIGIT3", "H1": "DIGIT4",
    # LCD control (R/W ต่อ GND ถาวร)
    "P5": "LCD_EN", "M5": "LCD_RS",
    # Buzzer / UART / WiFi / Bluetooth (TXD/RXD = ฝั่งโมดูล ตามคู่มือ)
    "B14": "BUZZER", "F2": "UART_TXD", "G1": "UART_RXD",
    "A12": "WIFI_TXD", "A10": "WIFI_RXD", "F3": "BT_TXD", "D4": "BT_RXD",
    # Audio / PS2
    "A13": "AUDIO_L", "B13": "AUDIO_R", "E11": "PS2_CLOCK", "C12": "PS2_DATA",
    # SPI ADC (MCP3208: CH6=LDR, CH7=LM35) / DAC (MCP4921)
    "D1": "ADC_SCK", "F4": "ADC_CS", "G4": "ADC_DIN", "C1": "ADC_DOUT",
    "F1": "DAC_SCK", "D2": "DAC_CS", "E2": "DAC_DIN",
    # VGA 12-bit
    "C4": "VGA_HSYNC", "E4": "VGA_VSYNC",
    "B6": "VGA_RED0", "D3": "VGA_RED1", "C3": "VGA_RED2", "A4": "VGA_RED3",
    "A3": "VGA_GRN0", "B3": "VGA_GRN1", "A2": "VGA_GRN2", "B5": "VGA_GRN3",
    "A5": "VGA_BLU0", "B2": "VGA_BLU1", "B1": "VGA_BLU2", "C5": "VGA_BLU3",
    # Expansion J5 / กล้อง OV7670 (จาก XDC ทางการของบอร์ด - ตาราง J5 ใน
    # คู่มือยังเป็นเลขพินของรุ่น Spartan-6 เดิม ใช้กับชิปนี้ไม่ได้)
    "L14": "J5/CAM_SIOC", "M13": "J5/CAM_SIOD", "H14": "J5/CAM_VS", "H13": "J5/CAM_HREF",
    "F11": "J5/CAM_PCLK", "G11": "J5/CAM_XCLK", "C14": "J5/CAM_D7", "D14": "J5/CAM_D6",
    "E13": "J5/CAM_D5", "F13": "J5/CAM_D4", "F14": "J5/CAM_D3", "G14": "J5/CAM_D2",
    "D13": "J5/CAM_D1", "D12": "J5/CAM_D0", "E12": "J5/CAM_RST", "F12": "J5/CAM_PWDN",
    # TFT (J14 connector) ร่วมขากับ LED D2-D6: CS=K12 RST=M12 A0=M14 SDA=P13 SCK=N11
}


def _pin_sort_key(p):
    """เรียงพินทั้งแบบ P123 (Spartan-6) และแบบ grid H11/K12 (Spartan-7)"""
    m = re.match(r"([A-Z]+)(\d+)$", p)
    return (m.group(1), int(m.group(2))) if m else (p, 0)


# โปรไฟล์บอร์ดทั้งหมด  (tool: ใช้ ISE หรือ Vivado ในการ build)
BOARDS = {
    "apex": {
        "label": "Apex Surveyor-6 (Spartan-6 XC6SLX9)",
        "part": "xc6slx9", "speed": "-2", "pkg": "tqg144",
        "pins": _PIN_DESC_APEX,
        "clk": "OSC", "period": "50",      # OSC 20MHz = 50ns
        "tool": "ise",
    },
    "edge": {
        "label": "EDGE Spartan-7 (XC7S15) - build ด้วย Vivado",
        "part": "xc7s15", "speed": "-1", "pkg": "ftgb196",
        "pins": _PIN_DESC_EDGE,
        "clk": "clk", "period": "20",       # OSC 50MHz = 20ns
        "tool": "vivado",
    },
}


def find_vivado():
    """หา vivado.bat อัตโนมัติ: ตัว minimal ที่ bundle มา (tools\vivado_min) ก่อน
    แล้วค่อยหาตัวติดตั้งเต็มจาก path ที่พบบ่อย (เอาเวอร์ชันล่าสุด)"""
    import glob
    bundled = glob.glob(os.path.join(PROJECT_DIR, "tools", "vivado_min", "*", "Vivado", "bin", "vivado.bat"))
    if bundled:
        return sorted(bundled)[-1]
    cands = []
    for pat in (r"D:\vivado_min\*\Vivado\bin\vivado.bat",
                r"D:\Vivado\*\Vivado\bin\vivado.bat",
                r"C:\Vivado\*\Vivado\bin\vivado.bat",
                r"C:\Xilinx\Vivado\*\bin\vivado.bat",
                r"D:\Xilinx\Vivado\*\bin\vivado.bat"):
        cands += glob.glob(pat)
    return sorted(cands)[-1] if cands else ""


def make_pin_list(desc):
    """สร้างรายการ dropdown จาก pin desc เช่น 'K12  (LED0/LCD_D7)'"""
    return ["{}  ({})".format(p, desc[p]) for p in sorted(desc, key=_pin_sort_key)]


def pin_only(val):
    """'P62  (SW1)' หรือ 'K12  (LED0)' -> เอาเฉพาะชื่อพิน"""
    m = re.match(r"\s*([A-Z]{1,2}\d{1,3})\b", (val or "").strip(), re.I)
    return m.group(1).upper() if m else (val or "").strip()

# ISE: ใช้ minimal ISE ที่ bundle มา (tools\ise_min) ก่อน ถ้าไม่มีใช้ตัวติดตั้งเต็ม
_bundled_ise = os.path.join(PROJECT_DIR, "tools", "ise_min", "settings64.bat")
DEFAULT_ISE_SETTINGS = _bundled_ise if os.path.exists(_bundled_ise) else r"C:\Xilinx\14.7\ISE_DS\settings64.bat"
# license: ใช้ Xilinx.lic ที่ bundle ในโฟลเดอร์ ถ้ามี
_bundled_lic = os.path.join(PROJECT_DIR, "Xilinx.lic")
DEFAULT_LICENSE = _bundled_lic if os.path.exists(_bundled_lic) else r"C:\Xilinx\Xilinx.lic"

# openFPGALoader (โหลด .bit ลงบอร์ดโดยไม่ต้องใช้ ISE/iMPACT)
# ถ้ามีตัว bundle มากับโปรแกรม (tools\openFPGALoader\) ใช้ตัวนั้นก่อน
_bundled_ofl = os.path.join(PROJECT_DIR, "tools", "openFPGALoader", "openFPGALoader.exe")
DEFAULT_OFL = _bundled_ofl if os.path.exists(_bundled_ofl) else r"C:\msys64\mingw64\bin\openFPGALoader.exe"
# สายที่พบบ่อยกับบอร์ด Spartan-6 (FT2232/Digilent). ถ้าไม่แน่ใจลอง ft2232 ก่อน
OFL_CABLES = ["ft2232", "digilent", "digilent_hs2", "digilent_hs3", "ft232",
              "ft231X", "ft4232", "bus_blaster", "jlink", "cmsisdap", "dirtyJtag"]

CONFIG_FILE = os.path.join(PROJECT_DIR, "fpga_builder.json")


# ----------------------------------------------------------------------------
# ฟังก์ชันช่วย
# ----------------------------------------------------------------------------
def parse_bit_header(path):
    """อ่าน header ของไฟล์ .bit (Xilinx) -> dict {design, part, date, time}"""
    info = {}
    try:
        with open(path, "rb") as f:
            data = f.read(512)
        # ข้าม magic 13 ไบต์แรก แล้วไล่ field 'a'..'e'
        i = 13
        keys = {0x61: "design", 0x62: "part", 0x63: "date", 0x64: "time"}
        while i < len(data):
            tag = data[i]
            if tag == 0x65:  # 'e' = ความยาว bitstream (4 ไบต์) แล้วจบ header
                length = struct.unpack(">I", data[i+1:i+5])[0]
                info["bitstream_bytes"] = length
                break
            if tag in keys:
                ln = struct.unpack(">H", data[i+1:i+3])[0]
                val = data[i+3:i+3+ln].rstrip(b"\x00").decode("ascii", "replace")
                info[keys[tag]] = val
                i += 3 + ln
            else:
                i += 1
    except Exception as e:
        info["error"] = str(e)
    return info


def path_for_tool(target, start):
    """คืน relative path ถ้าอยู่ไดรฟ์เดียวกัน, ไม่งั้นคืน absolute path
    (กัน error 'path is on mount D:, start on mount C:' เมื่อไฟล์อยู่คนละไดรฟ์)
    ผลลัพธ์ใช้ / เสมอ เพื่อให้ ISE tool อ่านได้"""
    try:
        p = os.path.relpath(target, start)
    except ValueError:
        p = os.path.abspath(target)
    return p.replace("\\", "/")


def _ports_from_body(body):
    """แยก port จาก body ของ entity (ส่วนหลัง 'is' ถึง 'end') -> list ชื่อ signal
    (กระจาย bus เช่น led(3 downto 0) เป็น led[0]..led[3])"""
    ports = []
    pm = re.search(r"port\s*\((.*)\)\s*;", body, re.IGNORECASE | re.DOTALL)
    if not pm:
        return ports
    decl = pm.group(1)
    for line in re.split(r";", decl):
        line = line.strip()
        if not line:
            continue
        mm = re.match(r"([\w\s,]+):\s*(in|out|inout)\s+(.*)", line,
                      re.IGNORECASE | re.DOTALL)
        if not mm:
            continue
        names = [n.strip() for n in mm.group(1).split(",") if n.strip()]
        typ = mm.group(3)
        rng = re.search(r"\(\s*(\d+)\s+downto\s+(\d+)\s*\)", typ, re.IGNORECASE)
        for nm in names:
            if rng:
                hi, lo = int(rng.group(1)), int(rng.group(2))
                for b in range(lo, hi + 1):
                    ports.append(f"{nm}[{b}]")
            else:
                ports.append(nm)
    return ports


def _read_all(files):
    text = ""
    for f in files:
        try:
            with open(f, "r", encoding="utf-8", errors="replace") as fh:
                text += "\n" + fh.read()
        except Exception:
            pass
    return re.sub(r"--.*", "", text)   # ตัด comment


def parse_vhdl_ports(vhdl_path):
    """ดึงชื่อ port จาก entity แรกในไฟล์ (คงไว้เพื่อความเข้ากันได้)"""
    text = _read_all([vhdl_path])
    m = re.search(r"\bentity\s+\w+\s+is\b(.*?)\bend\b", text, re.IGNORECASE | re.DOTALL)
    return _ports_from_body(m.group(1)) if m else []


def analyze_vhdl(files):
    """วิเคราะห์ไฟล์ VHDL -> (top_entity, clock_name, ports_ของ_top)
    top = entity ที่ไม่ถูก entity อื่นเรียกใช้เป็น component/instantiation"""
    text = _read_all(files)
    # เก็บทุก entity: {lowername: (ชื่อจริง, ports)}
    entities = {}
    order = []
    for m in re.finditer(r"\bentity\s+(\w+)\s+is\b(.*?)\bend\b", text, re.IGNORECASE | re.DOTALL):
        name, body = m.group(1), m.group(2)
        entities[name.lower()] = (name, _ports_from_body(body))
        order.append(name.lower())
    if not entities:
        return (None, None, [])
    # หา entity ที่ถูกใช้เป็น component/instantiation (ไม่ใช่ top)
    used = set()
    for m in re.finditer(r"\bcomponent\s+(\w+)", text, re.IGNORECASE):
        used.add(m.group(1).lower())
    for m in re.finditer(r":\s*entity\s+\w+\.(\w+)", text, re.IGNORECASE):  # label : entity work.NAME
        used.add(m.group(1).lower())
    for m in re.finditer(r":\s*(\w+)\s+port\s+map", text, re.IGNORECASE):   # label : NAME port map
        used.add(m.group(1).lower())
    # top = ตัวที่ไม่ถูกใช้ (ถ้ามีหลายตัวเอาตัวท้ายสุดที่นิยาม, ถ้าไม่มีเอา entity ท้ายไฟล์)
    tops = [k for k in order if k not in used]
    top_key = tops[-1] if tops else order[-1]
    top_name, top_ports = entities[top_key]
    # เดา clock จาก port ของ top
    clk = None
    clk_names = ("clk", "clock", "osc", "ck", "clkin", "clk_in", "mclk",
                 "sysclk", "clk50", "clk_50", "clk100", "gclk")
    for p in top_ports:
        base = re.sub(r"\[\d+\]$", "", p).lower()
        if base in clk_names or "clk" in base or "clock" in base:
            clk = p
            break
    return (top_name, clk, top_ports)


# --- Thai friendly-hint table for common ISE/Vivado student build errors ---
# auto-verified by workflow (38 agents) against real logs; specific-first order.
# each entry = (regex searched in the failed-build log, plain-Thai explanation).
_ERROR_HINTS = [
    # [vivado] synth_8_9493_ambiguous_operator (p1)
    ('\\[Synth 8-9493\\].*definitions of operator',
     'Vivado เจอ operator (เช่น "=") ที่มีหลายนิยาม เลยเลือกไม่ถูก (error [Synth 8-9493]) มักเกิดจาก 2 สาเหตุ: (1) ใน use clause เปิดทั้ง ieee.std_logic_unsigned หรือ ieee.std_logic_arith พร้อมกับ ieee.numeric_std — สอง library นี้ให้นิยาม operator ทับกัน หรือ (2) เอาสัญญาณชนิด std_logic_vector/unsigned/signed ไปเทียบกับเลขจำนวนเต็มเปล่า ๆ เช่น count = 0. วิธีแก้: ดูเลขบรรทัดที่ Vivado พิมพ์ในวงเล็บท้ายบรรทัด [..vhd:บรรทัด] (ในตัวอย่างคือ 220-231) แล้วไปที่บรรทัดนั้น ทำ 2 อย่าง: ลบ use ieee.std_logic_unsigned/std_logic_arith ออก ให้เหลือ use ieee.numeric_std.all อันเดียว และเทียบกับ vector literal เช่น count = "0000" หรือแปลงเป็นตัวเลขก่อน เช่น to_integer(unsigned(count)) = 0.'),
    # [both] synth_multiple_numeric_libs (p2)
    ('(?i)use\\s+ieee\\.std_logic_(unsigned|arith)|std_logic_arith',
     'โค้ด VHDL กำลัง use ไลบรารีตัวเลขเก่า (std_logic_unsigned หรือ std_logic_arith) ถ้าเปิดพร้อมกับ ieee.numeric_std.all จะทำให้ operator เช่น "=", "+", "<" กำกวม (ambiguous) เพราะมีนิยามซ้ำจากสองไลบรารี จน synth ไม่ผ่าน วิธีแก้: เลือกใช้แค่ ieee.numeric_std.all อย่างเดียว ลบบรรทัด use ieee.std_logic_unsigned / use ieee.std_logic_arith ออก แล้วประกาศสัญญาณเป็น unsigned/signed (หรือแปลงด้วย unsigned()/signed()) และใช้ to_integer(...) เมื่อต้องเทียบหรือบวกเลขกับค่า integer.'),
    # [vivado] synth_8_1031_not_declared (p3)
    ('\\[Synth 8-1031\\]|is not declared|cannot resolve',
     'Vivado ไม่รู้จักชื่อสัญญาณ/พอร์ต/ตัวแปรที่ใช้ ("is not declared" / [Synth 8-1031]) สาเหตุที่พบบ่อย: พิมพ์ชื่อผิด, ลืมประกาศ signal, หรือลืมใส่พอร์ตใน entity/module. วิธีแก้ VHDL: ดูเลขบรรทัดและชื่อที่แจ้ง แล้วประกาศ signal ก่อน begin (ระหว่าง "architecture ... is" กับ "begin") หรือแก้ตัวสะกดให้ตรงกับที่ประกาศไว้ (VHDL ไม่สนตัวพิมพ์เล็ก/ใหญ่ แต่สะกดต้องตรง). วิธีแก้ Verilog: ประกาศ wire/reg หรือเพิ่มพอร์ตใน module header (Verilog สนตัวพิมพ์เล็ก/ใหญ่). ถ้าเป็นชนิดข้อมูลที่ไม่รู้จัก ให้ตรวจว่าใส่ library/use (เช่น use IEEE.NUMERIC_STD.all;) ครบหรือยัง.'),
    # [both] synth_width_type_mismatch (p4)
    ('(?i)width mismatch|expression has \\d+ elements|does not match|\\[Synth 8-509\\]|\\[Synth 8-690\\]',
     'ชนิด (type) หรือความกว้างบิตของสองฝั่งไม่ตรงกัน เช่น เอา vector 8 บิตไป assign ให้ signal 4 บิต หรือเอา std_logic_vector ไปรวม/เปรียบเทียบกับ integer วิธีแก้: ดูบรรทัดและชื่อ signal ที่ Vivado แจ้ง (เช่น [Synth 8-690] จะบอกว่า target มีกี่บิต source มีกี่บิต) แล้วทำให้ทั้งสองฝั่งกว้างเท่ากันและเป็นชนิดเดียวกัน — VHDL ใช้ resize(a, n), to_integer(), std_logic_vector(), to_unsigned() ช่วยแปลง; Verilog ตรวจให้ความกว้าง [N:0] ของ wire/reg ตรงกัน.'),
    # [both] synth_aggregate_literal_ambiguous (p5)
    ('(?i)aggregate|cannot determine.*type|ambiguous.*(literal|expression)|\\[Synth 8-27\\]',
     'ค่าคงที่แบบ aggregate หรือ literal เช่น (others => \'0\'), \'0\', หรือ "00" กำกวมจน Vivado เดาชนิด (type) ไม่ออก มักขึ้นข้อความทำนอง "cannot determine ... type" หรือ "ambiguous ...". วิธีแก้: 1) ใช้ (others => \'0\') เฉพาะในบริบทที่รู้ชนิดปลายทางชัด เช่นตอน assign ให้ signal ที่ประกาศชนิดไว้แล้ว 2) ถ้ายังกำกวม ให้ระบุชนิดตรง ๆ ด้วย qualified expression เช่น std_logic_vector\'("0000") หรือ unsigned\'(...) 3) เทียบ vector กับ vector เสมอ อย่าเทียบ vector กับตัวเลขเปล่า เช่นเขียน sig = "0000" แทน sig = 0'),
    # [vivado] vivado-top-module-not-found (p5)
    ('\\[Synth 8-6157\\]|[Tt]op[- ]?module\\b.{0,60}\\bnot found|[Cc]ould not find (a |the )?top(-level)?( module)?|Top module not found',
     'Vivado หา Top module ไม่เจอ เพราะชื่อ Top ที่ตั้งไว้ในโปรเจกต์ไม่ตรงกับชื่อ module/entity บนสุดของโค้ด ให้เปิดไฟล์หลักดูบรรทัด module <ชื่อ> (Verilog) หรือ entity <ชื่อ> (VHDL) แล้วตั้งค่า Top ในโปรเจกต์ให้สะกดตรงกันเป๊ะ (ตัวพิมพ์ใหญ่/เล็กต้องตรงด้วย) หรือถ้าไฟล์ยังไม่ถูกเพิ่มเข้าโปรเจกต์ ให้ Add Sources ก่อน จากนั้นสั่ง Run Synthesis ใหม่'),
    # [vivado] vivado-module-not-found (p7)
    ("\\[Synth 8-285\\]|failed to find (the )?module|[Cc]annot find (the )?(module|instantiated) '?[\\w$]+",
     "มี module ที่ถูกเรียกใช้ (instantiate) แต่ Vivado หาไฟล์นิยามของมันไม่เจอ (Synth 8-285) มักเกิดจาก 1) พิมพ์ชื่อ module ผิดหรือตัวพิมพ์เล็ก/ใหญ่ไม่ตรงกับตอนประกาศ 2) ยังไม่ได้เพิ่มไฟล์ .v/.vhd ของ module นั้นเข้าโปรเจกต์ วิธีแก้: ดูชื่อ module ที่อยู่ในเครื่องหมาย ' ' ในข้อความ error แล้วตรวจให้ตรงกับตอน module ... ที่ประกาศไว้ และเพิ่มไฟล์ต้นทางที่ขาดเข้าไปใน Sources จากนั้นสั่ง synth ใหม่"),
    # [vivado] vivado-rtl-elaboration-failed (p9)
    ('\\[Synth 8-6156\\]|failed synthesizing module|RTL [Ee]laboration failed|[Ss]ynthesis failed',
     'ขั้นตอน RTL Elaboration ล้มเหลว หมายความว่า Vivado แปลงโค้ด HDL ให้เป็นวงจรไม่สำเร็จ บรรทัดนี้เป็นแค่ผลลัพธ์ปลายทาง (บทสรุปว่าล้มเหลว) ไม่ใช่ต้นเหตุจริง ต้นเหตุจริงคือ ERROR บรรทัดแรกสุดก่อนหน้านี้ ให้เลื่อนขึ้นไปหา ERROR ตัวบนสุดที่มีรหัส [Synth 8-xxxx] และตำแหน่ง [ไฟล์:บรรทัด] เช่น [D:/proj/src/top.v:12] แล้วเปิดไฟล์ไปแก้ที่บรรทัดนั้นก่อน เมื่อแก้ต้นเหตุได้แล้ว error RTL Elaboration failed นี้จะหายไปเอง'),
    # [vivado] place_clock_dedicated_route (p8)
    # ต้องมี "ERROR:" นำหน้า 30-574 เท่านั้น! หลังเราปลดกฎอัตโนมัติ Vivado จะพิมพ์
    # "WARNING: [Place 30-574] ... normally an ERROR but CLOCK_DEDICATED_ROUTE is FALSE"
    # ใน log ของ build ที่ "สำเร็จ" ด้วย - ถ้าจับ warning ด้วย เวลา build ล้มเพราะเรื่องอื่น
    # (เช่นลืมกำหนดขา) กฎนี้ priority สูงกว่าจะไปแย่งขึ้นคำอธิบายผิดเรื่อง
    ('ERROR: \\[Place 30-574\\]|\\[Place 30-99\\]|IO Clock Placer failed',
     'Vivado วาง clock ไม่ได้ ([Place 30-574]/[Place 30-99] "IO Clock Placer failed") เพราะสัญญาณ clock อยู่บนขาที่ "ไม่ใช่ขา clock" (เช่น ปุ่มกด/สวิตช์ ที่ใช้กด clock เอง). ปกติโปรแกรมจะปลดกฎนี้ให้อัตโนมัติทุก BUFG อยู่แล้ว (build ผ่านได้) - ถ้ายังเจอ error นี้ แปลว่าเป็นกรณีพิเศษที่ปลดอัตโนมัติไม่ครอบคลุม ให้ทำอย่างใดอย่างหนึ่ง: (1) ย้าย clock ไปขา clock จริงของบอร์ด (clock-capable pin) หรือ (2) แจ้งอาจารย์/TA พร้อมส่งไฟล์ในโฟลเดอร์ build มาให้ดู. หมายเหตุ: ถ้าใช้ปุ่มกดเป็น clock จริง ๆ ควรมีวงจร debounce ไม่งั้นกด 1 ครั้งอาจนับหลายครั้ง.'),
    # [vivado] drc_lutlp1_comb_loop (p10)
    ('\\[DRC LUTLP-1\\]',
     'มีวงจรลูปแบบ combinatorial: สัญญาณเอาต์พุตถูกป้อนกลับมาเป็นอินพุตของตัวเองโดยไม่ผ่านรีจิสเตอร์/ฟลิปฟลอปที่มี clock (asynchronous feedback) จึงเกิด race condition และ Vivado จะหยุดไม่สร้างไฟล์ bitstream. วิธีแก้: (1) ตรวจตรรกะวงจรไม่ให้เอาต์พุตวนกลับมาเป็นอินพุตของตัวเอง เช่น กรณีเขียน VHDL/Verilog แล้วเผลอให้สัญญาณ combinational อ้างถึงตัวเอง หรือ latch โดยไม่ตั้งใจ. (2) ถ้าตั้งใจให้วงจรมีสถานะ (state) ให้ใส่ flip-flop/register ที่ขับด้วย clock คั่นก่อนป้อนกลับ. ดูชื่อ cell/net ในบรรทัด error (เช่น a_OBUF_inst_i_2) เพื่อไล่หาจุดที่ลูปเกิดขึ้น. (การใส่ constraint set_property ALLOW_COMBINATORIAL_LOOPS TRUE เป็นการข้ามการตรวจเท่านั้น ไม่ควรใช้เว้นแต่เข้าใจวงจรดีแล้ว).'),
    # [vivado] env_space_in_path (p10)
    ('(Too many positional options|Failed to read library)',
     "ปัญหานี้เป็นเรื่องการติดตั้ง/สภาพแวดล้อม ไม่ใช่โค้ด VHDL ของนักศึกษา สาเหตุคือมี 'ช่องว่าง' (เว้นวรรค) หรือตัวอักษรภาษาไทยอยู่ในเส้นทางโฟลเดอร์ (path) ที่เก็บโปรแกรมหรือโปรเจกต์ ทำให้ Vivado ตีความคำสั่งผิดและอ่านไลบรารีหรือไฟล์ไม่ได้ (เช่น path เป็น C:/Users/Smart City/project ที่มีเว้นวรรคในคำว่า 'Smart City') วิธีแก้: (1) ปิด Vivado ก่อน (2) ย้ายทั้งโฟลเดอร์โปรเจกต์และตัวโปรแกรมไปไว้ในเส้นทางที่ไม่มีเว้นวรรคและไม่มีภาษาไทย เช่น C:\\\\fpga\\\\project (3) เปิดโปรเจกต์จากตำแหน่งใหม่แล้ว build ใหม่อีกครั้ง"),
    # [ise] ise-ucf-loc-invalid-pin (p10)
    ('ERROR:Place:\\d+.*(?:LOC constraint|is invalid|does not exist|No such site|is not a valid)',
     'ตำแหน่งขา (LOC) ในไฟล์ .ucf ไม่ถูกต้อง หรือขานี้ไม่มีอยู่จริงบนชิป Spartan-6 (xc6slx9) ให้ดูในข้อความ error ว่าขาไหนผิด เช่น LOC=Z99 แล้วเปิดตารางขาในแท็บ 2 เพื่อแก้รหัสขานั้นให้เป็นเลขขาที่มีจริง (เช่น P56, P58) ตาม datasheet ของ xc6slx9 หรือคู่มือบอร์ดของคุณ จากนั้น build ใหม่'),
    # [ise] ise-ucf-net-not-found (p10)
    ('NET "[^"]+" not found',
     'ชื่อสัญญาณ (NET) ที่กำหนดขาในไฟล์ .ucf ไม่ตรงกับชื่อพอร์ตในโค้ด HDL ระบบเลยหาไม่เจอ วิธีแก้: เปิดแท็บ constraints (tab 2) แล้วดูชื่อ NET ในวงเล็บของ error (เช่น NET "clk") จากนั้นเทียบกับชื่อขา input/output ใน entity/module ของคุณ ให้สะกดตรงกันเป๊ะๆ ทั้งตัวพิมพ์เล็ก/ใหญ่ เช่น clk, led, sw ถ้าเป็นขาแบบ bus เช่น led[0] ต้องเขียนชื่อและ index ให้ตรงกับที่ประกาศใน HDL ด้วย แก้แล้วบันทึกและ build ใหม่อีกครั้ง'),
    # [ise] ise_xst_not_declared (p10)
    ('ERROR:HDLCompiler:\\d+ - \\".*?\\" Line \\d+[:.].*?\\bis not declared',
     'XST (ISE) เจอชื่อสัญญาณ/พอร์ต/ตัวแปรที่ยังไม่ได้ประกาศ มักเกิดจากพิมพ์ชื่อผิด (เช่น ledd แทน led) หรือลืมประกาศ วิธีแก้: เปิดไฟล์ .vhd/.v ที่บรรทัด (Line) ที่ระบุ แล้วตรวจชื่อในเครื่องหมาย <...> ให้สะกดตรงกับที่ประกาศไว้ใน entity/port หรือ signal ใน architecture ถ้ายังไม่ได้ประกาศให้เพิ่มบรรทัด signal ชื่อนั้น : ประเภท; ก่อนใช้งาน (VHDL ต้องประกาศก่อน begin) แล้วบันทึกและ build ใหม่'),
    # [ise] ise_xst_syntax_error (p10)
    ('ERROR:HDLCompiler:\\d+ - ".*?" Line \\d+[:.].*?(?:[Ss]yntax error|parse error)',
     'พบข้อผิดพลาดไวยากรณ์ (syntax error) ของโค้ด VHDL/Verilog ที่บรรทัดที่ ISE แจ้ง สาเหตุที่พบบ่อยคือ ลืมใส่เซมิโคลอน ; ท้ายบรรทัดก่อนหน้า, สะกดคีย์เวิร์ดผิด เช่น begin/end/then/is/entity/architecture, หรือวงเล็บ ( ) เปิด-ปิดไม่ครบ. วิธีแก้: ดูข้อความ near "..." เพื่อรู้ตำแหน่งใกล้เคียง แล้วตรวจบรรทัดที่แจ้ง และบรรทัดเหนือมัน 1 บรรทัด จากนั้นเติม ; หรือแก้คำที่พิมพ์ผิดให้ถูกต้อง.'),
    # [vivado] vivado-syntax-error-8-2212 (p10)
    ('\\[Synth 8-2212\\]|syntax error near',
     'Vivado พบข้อผิดพลาดทางไวยากรณ์ (syntax error) โดยจะบอกข้อความที่อยู่หลังคำว่า "near" และตำแหน่งไฟล์:บรรทัดในวงเล็บเหลี่ยม เช่น [D:/proj/src/top.v:24] สาเหตุที่พบบ่อยที่สุดคือ ลืมใส่เครื่องหมาย ; ท้ายบรรทัด "ก่อนหน้า" บรรทัดที่แจ้ง หรือพิมพ์คีย์เวิร์ดผิด (เช่น assign, begin, module) วิธีแก้: เปิดไฟล์ตามพาธในวงเล็บ ไปที่บรรทัดที่ระบุ แล้วตรวจบรรทัดนั้นและบรรทัดก่อนหน้า เติม ; ที่ขาดไป หรือแก้คำที่สะกดผิดให้ถูก แล้วบิลด์ใหม่'),
    # [ise] ise_xst_type_mismatch (p15)
    ('ERROR:HDLCompiler:\\d+ - ".*?" Line \\d+[:.].*?(?:Expression has \\d+ element|can not have such operands|[Tt]ype error|type .*? is not compatible|no matching|does not match)',
     "ชนิดหรือขนาดข้อมูลสองฝั่งไม่ตรงกัน เช่น จับคู่ std_logic กับ std_logic_vector, ขนาดบัสไม่เท่ากัน (เอา 4 bit ไปใส่ช่อง 8 bit), integer ปนกับ std_logic หรือเรียก function/subprogram ด้วยชนิดพารามิเตอร์ที่ไม่ตรง (no matching). เปิดไฟล์และบรรทัดที่ระบุในข้อความ แล้วทำให้สองฝั่งของเครื่องหมาย <= (หรือการต่อสาย/พอร์ต) มีชนิดและจำนวนบิตเท่ากัน: ปรับความกว้างของ signal/port ให้ตรงกัน, ใช้ (others => '0') เติมบิตที่ขาด, หรือใช้ conv_std_logic_vector / resize / to_integer เพื่อแปลงชนิดก่อนนำมาเปรียบเทียบหรือกำหนดค่า."),
    # [vivado] vivado-syntax-near-fallback (p15)
    ('\\[Synth 8-(2715|1766|27)\\]|unexpected token|near text|near "[^"]*"',
     'Vivado เจอสัญลักษณ์ที่ไม่คาดคิดในโค้ด (syntax error / unexpected token / near text) มักเกิดจาก: วงเล็บ begin...end ไม่ครบคู่, วงเล็บ () หรือ [] เปิด-ปิดไม่ครบ, ลืมใส่ ; ท้ายคำสั่ง, หรือพิมพ์ตัวอักษร/คีย์เวิร์ดเกินมา วิธีแก้: ดูเลขบรรทัดและชื่อไฟล์ที่อยู่ในวงเล็บ [ ] ท้าย error (เช่น fsm.v:57) แล้วเปิดไฟล์ไปที่บรรทัดนั้น ตรวจว่าวงเล็บและ begin...end จับคู่ครบ และปิดท้ายคำสั่งด้วย ; ให้ถูกต้อง โดยมักต้องดูบรรทัดก่อนหน้าที่ระบุด้วย เพราะจุดผิดจริงอาจอยู่บรรทัดก่อนหน้า'),
    # [vivado] drc_mdrv_multiple_drivers (p20)
    ('\\[DRC MDRV',
     'พบ error [DRC MDRV] = สัญญาณ (net) เส้นเดียวกันถูกขับค่า (driven) จากหลายแหล่งพร้อมกัน จึงเกิดค่าชนกัน. ในข้อความ error Vivado จะบอกชื่อ net ที่มีปัญหา ให้ค้นหาชื่อนั้นในโค้ด. สาเหตุที่พบบ่อย: (1) assign สัญญาณตัวเดียวกันในหลาย always/process หรือหลายบรรทัด assign, (2) ต่อ output ของหลาย instance เข้าที่ net เดียวกัน, (3) ใช้ inout/tri-state ผิด. วิธีแก้: ทำให้แต่ละ net มีตัวขับเพียงแหล่งเดียว โดยรวม logic ให้อยู่ใน block เดียว หรือใช้ mux/if-else เลือกค่าแทนการขับซ้อนกัน.'),
    # [vivado] drc_nstd1_unspecified_iostandard (p20)
    ('\\[DRC NSTD-1\\]',
     'มี port (ขา I/O) ที่ยังไม่ได้ระบุ IOSTANDARD (มาตรฐานแรงดันไฟของขา I/O) จึงทำให้ build ไม่ผ่าน (DRC NSTD-1). วิธีแก้: ไปที่แท็บ 2 แล้วกำหนดให้ครบทุก port ทั้ง IOSTANDARD (เช่น LVCMOS33) และ LOC (ตำแหน่งขาบนบอร์ด) — ข้อผิดพลาดนี้มักมาคู่กับ UCIO-1 ที่แปลว่ายังไม่ได้กำหนด LOC ด้วย. เมื่อกำหนดครบทุกขาแล้วจึงกด build ใหม่.'),
    # [vivado] drc_ucio1_unconstrained_port (p20)
    ('\\[DRC UCIO-1\\]',
     'มีขาสัญญาณ (port) ในดีไซน์ที่ยังไม่ได้กำหนดว่าต่อกับขา (pin) ไหนของบอร์ด Vivado จึงหยุดและไม่สร้างไฟล์ bitstream วิธีแก้: ไปที่แท็บ 2 (Constraints/XDC) แล้วเพิ่มบรรทัด set_property PACKAGE_PIN <ชื่อขาบนบอร์ด> [get_ports <ชื่อ port>] และกำหนด IOSTANDARD ให้ครบทุก port ที่ใช้งาน (ดูรายชื่อ port ที่ยังขาดได้จาก log) จากนั้นสั่ง build ใหม่'),
    # [vivado] env_license_failure (p20)
    ('(No such feature exists|cannot connect to license server|Licensing error|ERROR:\\s*\\[Common 17-\\d+\\].*[Ll]icense|Feature.*not (found|available).*license)',
     'เป็นปัญหาเรื่องไลเซนส์/ลิขสิทธิ์ของ Vivado ไม่ใช่ความผิดของโค้ด VHDL สาเหตุคือยังไม่ได้ตั้งค่าไฟล์ license หรือเลือกชิป (part) ที่ต้องมีไลเซนส์แบบเสียเงิน วิธีแก้: 1) เปลี่ยนไปใช้ part ฟรีระดับ WebPACK เช่นตระกูล Spartan-7/Artix-7 ตัวเล็ก 2) ถ้าจำเป็นต้องใช้ part นี้จริง ให้แจ้งผู้ดูแลตั้งค่าตัวแปร XILINXD_LICENSE_FILE หรือ LM_LICENSE_FILE ให้ชี้ไปที่ license server/ไฟล์ .lic ที่ถูกต้อง แล้วจึงสั่ง build ใหม่'),
    # [both] env_part_not_found (p20)
    ("(part '?[\\w-]+'? is not available|Could not find part|No parts? (matched|found)|part.*is not supported)",
     'ปัญหา: โปรแกรมหาปาร์ท/ชิป FPGA ที่ระบุไม่เจอ หรือ toolchain ไม่รองรับปาร์ทนั้น\n\nข้อควรรู้: บอร์ด Spartan-6 (เช่น xc6slx9) ไม่รองรับใน Vivado ต้องใช้ ISE เท่านั้น ส่วน Vivado รองรับเฉพาะชิปรุ่นใหม่ (7-series ขึ้นไป)\n\nวิธีแก้:\n1. ถ้าเป็นบอร์ด Spartan-6 (xc6slx9) ให้สั่ง build ด้วย ISE ไม่ใช่ Vivado\n2. ตรวจสอบว่าพิมพ์ชื่อปาร์ทถูกต้อง (เช่น xc6slx9-2tqg144) และตรงกับ toolchain ที่เลือก\n3. ตรวจว่าติดตั้งชุดรองรับอุปกรณ์ (device support) ของชิปรุ่นนั้นครบแล้ว'),
    # [ise] ise-iob-loc-conflict (p20)
    ('ERROR:(?:Place|Pack):\\d+.*(?:same site|already (?:used|occupied)|two or more|conflict)',
     'มีสัญญาณตั้งแต่สองตัวขึ้นไปถูกกำหนดให้ใช้ขา (LOC) เดียวกัน จึงวางลง IOB ไม่ได้ วิธีแก้: เปิดไฟล์ .ucf ในแท็บ 2 มองหาบรรทัดที่ขึ้นต้นด้วย NET ... LOC = "Pxx"; แล้วหาเลขขา (เช่น P56) ที่ปรากฏซ้ำมากกว่าหนึ่งบรรทัด จากนั้นแก้ให้แต่ละสัญญาณใช้เลขขาคนละขากัน (ดูเลขขาที่ถูกต้องได้จากคู่มือบอร์ด/ผังขา) แล้วบันทึกและ build ใหม่'),
    # [ise] ise-ngdbuild-no-driver (p20)
    ('ERROR:NgdBuild:\\d+.*(?:has no driver|no driver|non-buffer primitives|has no load)',
     'พบสัญญาณที่ไม่มีตัวขับ (no driver) หรือขา input ต่อตรงเข้า logic โดยไม่ผ่านบัฟเฟอร์ (non-buffer primitives) มักเกิดจากลืมต่อสาย ลืมประกาศ/ขับค่าให้ signal ใน HDL หรือสะกดชื่อพอร์ต/สัญญาณผิดจนไม่ตรงกัน วิธีแก้: 1) ตรวจว่าทุก net มีตัวขับครบ (มีการ assign ค่าให้) 2) ตรวจการเชื่อมต่อพอร์ตของ instance ให้ครบทุกเส้น 3) เช็คชื่อสัญญาณใน HDL กับไฟล์ constraint (UCF) ให้ตรงกัน'),
    # [ise] ise_xst_top_not_found (p20)
    ('(?i)ERROR:Xst:\\d+ - .*?(?:can ?not find|could not find|unable to find).*?top|No entity named \\S+ in (?:library )?work',
     "XST หา top entity ตามชื่อที่ตั้งไว้ไม่เจอ สาเหตุที่พบบ่อยคือช่อง 'Top entity' (หรือ Top Module) ในแท็บ 1 สะกดไม่ตรงกับชื่อ entity/module บนสุดในไฟล์ดีไซน์ วิธีแก้: เปิดไฟล์ HDL ดูชื่อที่อยู่หลังคำว่า entity (ถ้าเป็น VHDL) หรือ module (ถ้าเป็น Verilog) แล้วพิมพ์ชื่อในช่อง Top entity ให้ตรงกันแบบเป๊ะ ๆ (Verilog ตัวพิมพ์เล็ก/ใหญ่มีผล ต้องตรงทุกตัว ส่วน VHDL ไม่แยกเล็ก/ใหญ่แต่แนะนำให้พิมพ์ให้ตรงไว้ก่อน) หรือจะลบชื่อในช่องนี้ทิ้งให้ว่างเพื่อให้เครื่องมือเลือก top ให้อัตโนมัติก็ได้ จากนั้นกด Build ใหม่"),
    # [both] env_out_of_memory (p30)
    ('(out of memory|std::bad_alloc|cannot allocate memory|not enough memory|insufficient memory|Abnormal program termination.*[Mm]emory)',
     'หน่วยความจำ (RAM) ไม่พอระหว่างขั้นตอน synthesis หรือ place-and-route ปัญหานี้ไม่ใช่ความผิดของโค้ด HDL ของคุณ วิธีแก้: (1) ปิดโปรแกรมอื่นที่กินแรม เช่น เบราว์เซอร์ที่เปิดหลายแท็บ (2) เพิ่ม virtual memory / paging file ของ Windows (3) ใช้เครื่องมือเวอร์ชัน 64-bit ถ้ายังใช้ 32-bit อยู่ (4) ถ้ายังไม่พอ ให้เพิ่ม RAM หรือย้ายไปรันบนเครื่องที่แรมมากกว่านี้ แล้วลอง build ใหม่'),
    # [vivado] env_tcl_conflict (p30)
    ('(version conflict for package "?Tcl"?|can\'t find package Tcl|wrong version of Tcl|Tcl_Init.*fail)',
     'ปัญหาเวอร์ชัน Tcl ขัดแย้งกัน หรือหาแพ็กเกจ Tcl ไม่เจอ มักเกิดเพราะในเครื่องมี Tcl ตัวอื่นติดตั้งอยู่ (เช่นมากับ Git, Python หรือโปรแกรมอื่น) แล้วตัวแปรแวดล้อมชี้ไปที่ Tcl ตัวผิด วิธีแก้: 1) ปิด Vivado ให้หมดก่อน 2) ล้างค่าตัวแปรแวดล้อม TCL_LIBRARY และ TCLLIBPATH (ตั้งเป็นค่าว่างหรือลบทิ้ง) 3) เปิด Vivado ใหม่ผ่านสคริปต์/ไอคอนที่มากับชุดติดตั้งนี้เท่านั้น อย่าเปิดจาก Command Prompt ที่เคยตั้งค่า Tcl ของโปรแกรมอื่นไว้'),
    # [ise] ise-par-unrouted (p30)
    ('(?:Number of (?:Signals Not Completely Routed|unrouted (?:signals|nets))\\s*:\\s*[1-9]|design did not route|Unroutable)',
     'ขั้นตอน PAR (Place and Route) เดินสายไม่ครบ มีสัญญาณที่ยังต่อไม่เสร็จ (unrouted) วิธีแก้: 1) ตรวจไฟล์ constraint (.ucf) ว่าไม่มีการกำหนดขา (LOC) ซ้ำหรือชนกัน และขาที่ระบุมีอยู่จริงบนชิป xc6slx9 2) ตรวจว่า timing constraint ไม่เข้มเกินไป 3) ถ้าวงจรใหญ่เกินทรัพยากรชิป (LUT/logic เต็ม) ให้ลดขนาดวงจรลง จากนั้นรัน Synthesize, Map และ PAR ใหม่ทั้งหมด'),
    # [ise] ise_xst_compile_generic (p40)
    ('ERROR:HDLCompiler:\\d+ - \\".*?\\" Line \\d+[:.]',
     'XST หยุดตอนคอมไพล์ VHDL/Verilog เพราะเจอข้อผิดพลาดที่ระบุชื่อไฟล์และเลขบรรทัด (Line) ในข้อความ ERROR. วิธีแก้: (1) เปิดไฟล์ตามพาธในเครื่องหมายคำพูด ไปที่บรรทัดที่แจ้ง (2) อ่านข้อความหลังเลขบรรทัดว่าเป็นเรื่องอะไร เช่น syntax error, is not bound (หา component/ไฟล์ไม่เจอ), หรือหาไลบรารีไม่พบ แล้วแก้เฉพาะจุดนั้น (3) เปิดไฟล์ .syr ในโฟลเดอร์ build แล้วไล่หา ERROR ตัวแรกสุด (ตัวบนสุด) เพราะมักเป็นต้นเหตุจริง ส่วน error ที่ตามมามักเป็นผลลูกโซ่. คอมไพล์ใหม่จนไม่มี ERROR ก่อนจึงจะไปขั้น synthesis/map/par ต่อได้.'),
    # [vivado] drc_bitgen_not_run (p90)
    ('Error\\(s\\) found during DRC\\. Bitgen not run|write_bitstream failed',
     'การสร้างไฟล์ .bit ถูกยกเลิก เพราะมี error จากขั้นตอน DRC (Design Rule Check) ก่อนหน้า ทำให้ Bitgen ไม่ทำงาน. วิธีแก้: เลื่อนขึ้นไปดู log ด้านบน หาบรรทัดที่ขึ้นต้นด้วย "ERROR: [DRC ...]" (เช่น [DRC NSTD-1], [DRC UCIO-1]) ซึ่งมักเป็นปัญหาเรื่อง I/O standard หรือ constraint ของขา pin ที่ยังไม่ได้กำหนด. แก้ที่ไฟล์ constraint (.xdc) ตาม error นั้นให้ครบก่อน แล้วจึงสั่ง build ใหม่อีกครั้ง.'),
    # [ise] ise-number-of-errors (p90)
    ('Number of errors\\s*:\\s*[1-9]\\d*',
     'การ implement/build ด้วย ISE เจอ error ทั้งหมด N จุด (บรรทัด "Number of errors" เป็นแค่ตัวสรุปยอดรวม ไม่ได้บอกสาเหตุ) ให้เลื่อนขึ้นไปหาบรรทัดที่ขึ้นต้นด้วย "ERROR:" ตัวแรกในล็อก แล้วอ่านสาเหตุจากบรรทัดนั้นก่อน เพราะ error แรกมักเป็นต้นตอที่ทำให้เกิด error ตัวอื่นตามมา แก้ทีละจุดจากบนลงล่าง แล้ว rerun ใหม่จนยอด error เหลือ 0'),
]


# ----------------------------------------------------------------------------
# แอปหลัก
# ----------------------------------------------------------------------------
class FPGABuilder(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("FPGA Builder  -  VHDL → .bit  (Spartan-6 xc6slx9)")
        # ปรับให้ "พอดีจอ": โน้ตบุ๊คจอเล็ก หรือ Windows ตั้ง Display scaling 125-150%
        # จะทำให้จอที่ใช้งานได้จริง (logical) เล็กลง หน้าต่าง 980x720 + minsize 820x600
        # เดิมจึงสูงเกินจอ -> log/ปุ่มด้านล่างหลุดออกนอกจอ กดไม่ได้ (Tkinter เลื่อนทั้ง
        # หน้าต่างไม่ได้ และ minsize ที่สูงกว่าจอ ทำให้ย่อให้พอดีก็ไม่ได้). แก้: จำกัด
        # ขนาดเริ่มต้น + minsize ไม่ให้เกินพื้นที่จอที่มองเห็นจริง
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        w = min(980, sw - 40)
        h = min(720, sh - 90)          # เผื่อ title bar + taskbar
        self.geometry(f"{w}x{h}+10+10")
        self.minsize(min(680, w), min(360, h))

        self.vhdl_files = []          # list of paths
        self.log_queue = queue.Queue()
        self.proc = None
        self._editor = None          # widget แก้ไขเซลล์ปัจจุบัน (มีได้ทีละ 1)
        self._editor_commit = None   # ฟังก์ชันบันทึกค่า editor ปัจจุบัน
        self.board_key = "apex"      # บอร์ดปัจจุบัน (apex / edge)

        self._build_ui()
        self._load_config()
        self.after(100, self._drain_log)
        # Vivado ไม่รองรับ path ที่มีช่องว่าง (Tcl ภายในของมัน split ตรงช่องว่าง:
        # "Too many positional options" / "Failed to read library" / synth ล้ม)
        # เจอจริงจากนักศึกษาแตกไฟล์ไว้ที่ "C:\FPGA Builder V6\" - เตือนตั้งแต่เปิด
        if " " in PROJECT_DIR:
            self.after(600, lambda: (
                self.log("[!] ชื่อโฟลเดอร์โปรแกรมมีช่องว่าง - บอร์ด Spartan-7 (Vivado) จะ build ไม่ได้"),
                messagebox.showwarning(
                    "ชื่อโฟลเดอร์มีช่องว่าง",
                    "โฟลเดอร์ที่วางโปรแกรมมี 'ช่องว่าง' ในชื่อ:\n"
                    f"{PROJECT_DIR}\n\n"
                    "Vivado (บอร์ด EDGE Spartan-7) ไม่รองรับ path ที่มีช่องว่าง\n"
                    "จะ build ไม่สำเร็จ (synth_design failed)\n\n"
                    "วิธีแก้: ปิดโปรแกรม แล้วเปลี่ยนชื่อ/ย้ายโฟลเดอร์ไม่ให้มีช่องว่าง\n"
                    "เช่น  C:\\FPGA_Builder  (ใช้ _ แทนช่องว่าง ห้ามภาษาไทย)")))

    # ---------------- UI ----------------
    def _build_ui(self):
        # หมายเหตุลำดับ pack: ต้อง pack แถบปุ่ม + Log (side="bottom") "ก่อน" Notebook
        # เพราะ pack ให้พื้นที่ตามลำดับที่ pack - ตัวแรกได้ก่อน. ถ้า pack Notebook ก่อน
        # มันจะกินพื้นที่จนปุ่ม/log (ที่ pack ทีหลัง) ถูกตัดตอนจอเตี้ย. pack ล่างก่อน
        # -> ปุ่ม/log จองที่ล่างไว้ แล้ว Notebook (expand) เป็นตัวยอมย่อ
        nb = ttk.Notebook(self)

        self.tab_proj = ttk.Frame(nb)
        self.tab_pins = ttk.Frame(nb)
        self.tab_bit  = ttk.Frame(nb)
        nb.add(self.tab_proj, text="1. โปรเจกต์ & ชิป")
        nb.add(self.tab_pins, text="2. กำหนด Pin")
        nb.add(self.tab_bit,  text="3. ดูข้อมูล .bit")

        self._build_tab_project()
        self._build_tab_pins()
        self._build_tab_bit()

        # แถบปุ่มล่าง - ปัก side="bottom" ให้ติดขอบล่างหน้าต่างเสมอ (สำคัญสุด: ปุ่ม
        # Build/Program/หยุด ต้องกดได้ตลอด) แล้ว Log อยู่เหนือมัน ส่วน Notebook (บน)
        # เป็นตัวที่ยอมย่อเมื่อหน้าต่างเตี้ย -> ปุ่ม+log ไม่หลุดจอ
        bar = ttk.Frame(self)
        bar.pack(side="bottom", fill="x", padx=6)
        self.btn_build = ttk.Button(bar, text="▶ Build .bit", command=self.on_build)
        self.btn_build.pack(side="left", padx=3, pady=3)
        self.btn_ofl = ttk.Button(bar, text="⬇ Program (โหลดลงบอร์ด)", command=self.on_program_ofl)
        self.btn_ofl.pack(side="left", padx=3, pady=3)
        self.btn_stop = ttk.Button(bar, text="■ หยุด", command=self.on_stop)
        self.btn_stop.pack(side="left", padx=3)
        # เก็บ .bit ที่ build เสร็จไปไว้ที่อื่น (ส่งงาน/สำรองไว้หลายเวอร์ชัน) - ไฟล์ใน
        # build/ ถูกเขียนทับทุกครั้งที่ Build ใหม่ ถ้าไม่เซฟไว้ก็หายไปเลย
        self.btn_save = ttk.Button(bar, text="💾 บันทึก .bit", command=self.on_save_bit)
        self.btn_save.pack(side="left", padx=3)
        self._busy = False           # มี flow รันอยู่ (กันกดปุ่มซ้อนจนไฟล์/โปรเซสตีกัน)
        self._cancel = False         # ผู้ใช้สั่งหยุด (ให้ _wait_build เลิกรอ)
        self._sched_active = False   # Vivado build ผ่าน Task Scheduler กำลังรัน
        self._busy_gen = 0           # รุ่นของงานปัจจุบัน - เพิ่มทุกครั้งที่เริ่ม/หยุด
                                     # ใช้เมิน 'done' ของ worker ตัวที่ตกรุ่น (ถูกสั่ง
                                     # หยุดหรือมีงานใหม่มาแทน) กันมันรีเซ็ต UI ผิดจังหวะ
        ttk.Button(bar, text="ล้าง Log", command=lambda: self.log_box.delete("1.0", "end")).pack(side="left", padx=3)
        self.status = ttk.Label(bar, text="พร้อม", foreground="gray")
        self.status.pack(side="right", padx=8)

        # Log - ปักไว้เหนือแถบปุ่ม (side="bottom" ซ้อนขึ้นมาจากล่าง) height เล็กลงเป็น
        # 8 เพื่อไม่แย่งพื้นที่บนจอเตี้ย (ยังขยายได้ด้วย expand + มี scrollbar ในตัว)
        lf = ttk.LabelFrame(self, text="Log")
        lf.pack(side="bottom", fill="both", expand=True, padx=6, pady=4)
        self.log_box = scrolledtext.ScrolledText(lf, height=8, bg="#111", fg="#ddd",
                                                 insertbackground="#ddd", font=("Consolas", 9))
        self.log_box.pack(fill="both", expand=True)

        # pack Notebook เป็นตัวสุดท้าย (side="top", expand) -> เป็นตัวที่ยอมย่อเมื่อจอเตี้ย
        # ส่วนแถบปุ่ม+Log ที่ pack ไปก่อนหน้าจะติดขอบล่างเสมอ กดได้/เห็นได้ตลอด
        nb.pack(side="top", fill="both", expand=True, padx=6, pady=6)

    def _build_tab_project(self):
        f = self.tab_proj
        # เครื่องมือ build (ISE สำหรับ Spartan-6 / Vivado สำหรับ Spartan-7)
        r = ttk.LabelFrame(f, text="เครื่องมือ build  (ISE = Spartan-6, Vivado = Spartan-7)")
        r.pack(fill="x", padx=8, pady=6)
        ttk.Label(r, text="ISE settings64.bat:").grid(row=0, column=0, sticky="w", padx=4, pady=4)
        self.var_ise = tk.StringVar(value=DEFAULT_ISE_SETTINGS)
        ttk.Entry(r, textvariable=self.var_ise, width=64).grid(row=0, column=1, padx=4, sticky="we")
        ttk.Button(r, text="...", width=3, command=self._pick_ise).grid(row=0, column=2, padx=4)
        ttk.Label(r, text="Vivado vivado.bat:").grid(row=1, column=0, sticky="w", padx=4, pady=4)
        self.var_vivado = tk.StringVar(value=find_vivado())
        ttk.Entry(r, textvariable=self.var_vivado, width=64).grid(row=1, column=1, padx=4, sticky="we")
        ttk.Button(r, text="...", width=3, command=self._pick_vivado).grid(row=1, column=2, padx=4)
        r.columnconfigure(1, weight=1)

        # VHDL files
        vf = ttk.LabelFrame(f, text="ไฟล์ VHDL (source)")
        vf.pack(fill="both", expand=True, padx=8, pady=6)
        self.lst_vhdl = tk.Listbox(vf, height=6)
        self.lst_vhdl.pack(side="left", fill="both", expand=True, padx=4, pady=4)
        vb = ttk.Frame(vf); vb.pack(side="left", fill="y", padx=4)
        ttk.Button(vb, text="เพิ่มไฟล์...", command=self._add_vhdl).pack(fill="x", pady=2)
        ttk.Button(vb, text="ลบที่เลือก", command=self._del_vhdl).pack(fill="x", pady=2)
        ttk.Button(vb, text="↑ ขึ้น", command=lambda: self._move_vhdl(-1)).pack(fill="x", pady=2)
        ttk.Button(vb, text="↓ ลง", command=lambda: self._move_vhdl(1)).pack(fill="x", pady=2)

        # เลือกบอร์ด
        bf = ttk.LabelFrame(f, text="บอร์ด FPGA")
        bf.pack(fill="x", padx=8, pady=6)
        ttk.Label(bf, text="รุ่นบอร์ด:").grid(row=0, column=0, sticky="e", padx=4, pady=4)
        self.var_board = tk.StringVar(value=BOARDS["apex"]["label"])
        cb_board = ttk.Combobox(bf, textvariable=self.var_board, state="readonly", width=45,
                                values=[BOARDS[k]["label"] for k in BOARDS])
        cb_board.grid(row=0, column=1, padx=4, sticky="w")
        cb_board.bind("<<ComboboxSelected>>", self._on_board_change)
        self.lbl_board_note = ttk.Label(bf, text="", foreground="#b06000")
        self.lbl_board_note.grid(row=1, column=0, columnspan=2, sticky="w", padx=8)
        bf.columnconfigure(1, weight=1)

        # device + top
        d = ttk.LabelFrame(f, text="ชิป & Top entity")
        d.pack(fill="x", padx=8, pady=6)
        ttk.Label(d, text="Part:").grid(row=0, column=0, sticky="e", padx=4, pady=4)
        self.var_part = tk.StringVar(value="xc6slx9")
        ttk.Combobox(d, textvariable=self.var_part, values=PARTS, width=12).grid(row=0, column=1, padx=4)
        ttk.Label(d, text="Speed:").grid(row=0, column=2, sticky="e", padx=4)
        self.var_speed = tk.StringVar(value="-2")
        ttk.Combobox(d, textvariable=self.var_speed, values=SPEEDS, width=5).grid(row=0, column=3, padx=4)
        ttk.Label(d, text="Package:").grid(row=0, column=4, sticky="e", padx=4)
        self.var_pkg = tk.StringVar(value="tqg144")
        ttk.Combobox(d, textvariable=self.var_pkg, values=PACKAGES, width=10).grid(row=0, column=5, padx=4)
        ttk.Label(d, text="Top entity:").grid(row=1, column=0, sticky="e", padx=4, pady=4)
        self.var_top = tk.StringVar(value="top")
        ttk.Entry(d, textvariable=self.var_top, width=14).grid(row=1, column=1, padx=4, sticky="w")
        ttk.Label(d, text="(ชื่อต้องตรงกับ entity บนสุดในดีไซน์)").grid(row=1, column=2, columnspan=4, sticky="w")

        # openFPGALoader (โหลด .bit โดยไม่ต้องใช้ ISE)
        o = ttk.LabelFrame(f, text="โหลดลงบอร์ดแบบไม่ใช้ ISE  (openFPGALoader)")
        o.pack(fill="x", padx=8, pady=6)
        ttk.Label(o, text="openFPGALoader.exe:").grid(row=0, column=0, sticky="e", padx=4, pady=4)
        self.var_ofl = tk.StringVar(value=DEFAULT_OFL)
        ttk.Entry(o, textvariable=self.var_ofl, width=52).grid(row=0, column=1, padx=4, sticky="we")
        ttk.Button(o, text="...", width=3, command=self._pick_ofl).grid(row=0, column=2, padx=2)
        ttk.Label(o, text="สาย JTAG (cable):").grid(row=1, column=0, sticky="e", padx=4, pady=4)
        self.var_cable = tk.StringVar(value="ft2232")
        ttk.Combobox(o, textvariable=self.var_cable, values=OFL_CABLES, width=16).grid(row=1, column=1, sticky="w", padx=4)
        self.btn_detect = ttk.Button(o, text="ตรวจหาสาย/ชิป (detect)", command=self.on_ofl_detect)
        self.btn_detect.grid(row=1, column=1, padx=4, sticky="e")
        self.btn_driver = ttk.Button(o, text="ตั้งไดรเวอร์ USB (แก้ detect ไม่เจอ / สลับบอร์ด)",
                                     command=self._driver_help)
        self.btn_driver.grid(row=2, column=1, padx=4, pady=(0, 4), sticky="w")
        o.columnconfigure(1, weight=1)

        ttk.Label(f, text="เมื่อกรอกครบ ไปแท็บ 2 เพื่อกำหนด pin แล้วกด Build .bit ด้านล่าง",
                  foreground="gray").pack(anchor="w", padx=10, pady=4)

    def _build_tab_pins(self):
        f = self.tab_pins
        top = ttk.Frame(f); top.pack(fill="x", padx=8, pady=6)
        ttk.Button(top, text="↻ ดึงขาจาก VHDL", command=self._import_ports).pack(side="left", padx=3)
        ttk.Button(top, text="+ เพิ่มแถว", command=lambda: self._add_pin_row()).pack(side="left", padx=3)
        ttk.Button(top, text="- ลบแถวที่เลือก", command=self._del_pin_row).pack(side="left", padx=3)
        ttk.Label(top, text="Clock period (ns):").pack(side="left", padx=(20, 2))
        self.var_period = tk.StringVar(value="20")
        ttk.Entry(top, textvariable=self.var_period, width=6).pack(side="left")
        ttk.Label(top, text="ชื่อสัญญาณ clock:").pack(side="left", padx=(10, 2))
        self.var_clkname = tk.StringVar(value="clk")
        ttk.Entry(top, textvariable=self.var_clkname, width=10).pack(side="left")

        cols = ("signal", "loc", "io", "extra")
        # ใส่ scrollbar แนวตั้งให้ตาราง pin: วงจรที่มี port เยอะ (หรือจอเตี้ยจน
        # notebook ย่อ) จะได้เลื่อนดูขาที่อยู่ล่าง ๆ ได้
        tf = ttk.Frame(f)
        tf.pack(fill="both", expand=True, padx=8, pady=4)
        self.tree = ttk.Treeview(tf, columns=cols, show="headings", height=12, selectmode="extended")
        for c, t, w in (("signal", "Signal (port)", 200), ("loc", "Pin / LOC", 110),
                        ("io", "IOSTANDARD", 130), ("extra", "Extra (เช่น PULLUP | DRIVE=8)", 260)):
            self.tree.heading(c, text=t)
            self.tree.column(c, width=w)
        tsb = ttk.Scrollbar(tf, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=tsb.set)
        tsb.pack(side="right", fill="y")
        self.tree.pack(side="left", fill="both", expand=True)
        self.tree.bind("<ButtonRelease-1>", self._edit_cell)   # คลิกครั้งเดียวเพื่อแก้ไข

        ttk.Label(f, text="คลิกที่ช่องเพื่อแก้ไข • ช่อง Pin/LOC เลือกพินจาก dropdown (โชว์ชื่อฟังก์ชันในวงเล็บ) • IOSTANDARD ต้องตรงแรงดัน bank",
                  foreground="gray").pack(anchor="w", padx=10)

    def _build_tab_bit(self):
        f = self.tab_bit
        top = ttk.Frame(f); top.pack(fill="x", padx=8, pady=8)
        ttk.Button(top, text="เปิดไฟล์ .bit...", command=self._open_bit_info).pack(side="left")
        self.var_bitpath = tk.StringVar()
        ttk.Entry(top, textvariable=self.var_bitpath, width=70).pack(side="left", padx=6)
        self.bit_info = scrolledtext.ScrolledText(f, height=18, font=("Consolas", 10))
        self.bit_info.pack(fill="both", expand=True, padx=8, pady=6)

    # ---------------- ตัวจัดการไฟล์ VHDL ----------------
    def _pick_ise(self):
        p = filedialog.askopenfilename(title="เลือก settings64.bat ของ ISE",
                                       filetypes=[("Batch", "*.bat"), ("All", "*.*")])
        if p:
            self.var_ise.set(p)

    def _pick_vivado(self):
        p = filedialog.askopenfilename(title="เลือก vivado.bat (ใน Vivado\\<เวอร์ชัน>\\bin)",
                                       filetypes=[("Batch", "*.bat"), ("All", "*.*")])
        if p:
            self.var_vivado.set(p)

    def _add_vhdl(self):
        ps = filedialog.askopenfilenames(title="เลือกไฟล์ VHDL",
                                         filetypes=[("VHDL", "*.vhd *.vhdl *.txt"), ("All", "*.*")])
        for p in ps:
            if p not in self.vhdl_files:
                self.vhdl_files.append(p)
        self._refresh_vhdl()
        # เดา Top entity + clock จากไฟล์ทันทีที่เพิ่ม
        if self.vhdl_files:
            top, clk, _ = analyze_vhdl(self.vhdl_files)
            if top:
                self.var_top.set(top)
                self.var_clkname.set(clk or "")
                self.log(f"auto: Top={top}" + (f", clock={clk}" if clk else ", ไม่มี clock"))

    def _del_vhdl(self):
        sel = list(self.lst_vhdl.curselection())
        for i in reversed(sel):
            del self.vhdl_files[i]
        self._refresh_vhdl()

    def _move_vhdl(self, d):
        sel = self.lst_vhdl.curselection()
        if not sel:
            return
        i = sel[0]; j = i + d
        if 0 <= j < len(self.vhdl_files):
            self.vhdl_files[i], self.vhdl_files[j] = self.vhdl_files[j], self.vhdl_files[i]
            self._refresh_vhdl()
            self.lst_vhdl.selection_set(j)

    def _refresh_vhdl(self):
        self.lst_vhdl.delete(0, "end")
        for p in self.vhdl_files:
            self.lst_vhdl.insert("end", p)

    # ---------------- บอร์ด ----------------
    @property
    def board(self):
        return BOARDS[self.board_key]

    def _pin_label(self, pin):
        """'K12' -> 'K12  (LED0/LCD_D7)' ตาม pin desc ของบอร์ดปัจจุบัน"""
        pin = (pin or "").strip().upper()
        d = self.board["pins"].get(pin)
        return f"{pin}  ({d})" if d else pin

    def _on_board_change(self, _e=None):
        label = self.var_board.get()
        for k, b in BOARDS.items():
            if b["label"] == label:
                self.apply_board(k)
                return

    def apply_board(self, key):
        """สลับโปรไฟล์บอร์ด: ตั้งชิป + clock + รายการพินใน dropdown"""
        if key not in BOARDS:
            key = "apex"
        changed = getattr(self, "board_key", None) != key
        self.board_key = key
        b = BOARDS[key]
        self.var_board.set(b["label"])
        self.var_part.set(b["part"])
        self.var_speed.set(b["speed"])
        self.var_pkg.set(b["pkg"])
        self.var_clkname.set(b["clk"])
        self.var_period.set(b["period"])
        # พินสองบอร์ดใช้คนละระบบชื่อ (Apex=P123..., EDGE=grid H11...) และชื่อ P1-P14
        # มีอยู่ทั้งคู่แต่คนละตำแหน่งจริง -> ถ้าไม่ล้าง LOC เดิมตอนสลับบอร์ด อาจ build
        # ผ่านแต่ขาผิดเงียบ ๆ (หรือ build พังด้วยพินที่ไม่มีในชิป)
        if changed and hasattr(self, "tree"):
            cleared = 0
            for it in self.tree.get_children():
                if self.tree.set(it, "loc").strip():
                    self.tree.set(it, "loc", "")
                    cleared += 1
            if cleared:
                self.log(f"สลับบอร์ด: ล้างค่า Pin/LOC เดิม {cleared} แถว "
                         "(พินคนละบอร์ดใช้แทนกันไม่ได้) - เลือกพินใหม่ในแท็บ 2")
        if b["tool"] == "vivado":
            self.lbl_board_note.config(
                text="บอร์ดนี้ build ด้วย Vivado (ตั้ง path vivado.bat ด้านบน) - "
                     "XDC สร้างให้อัตโนมัติจากตาราง pin")
        else:
            self.lbl_board_note.config(text="")
        self.log(f"เลือกบอร์ด: {b['label']}  (ชิป {b['part']}{b['speed']}-{b['pkg']})")

    # ---------------- ตาราง pin ----------------
    def _add_pin_row(self, signal="", loc="", io="LVCMOS33", extra=""):
        self._close_editor()
        self.tree.insert("", "end", values=(signal, loc, io, extra))

    def _del_pin_row(self):
        self._close_editor(commit=False)        # ปิด editor ที่ลอยอยู่ก่อนลบ
        for it in self.tree.selection():
            self.tree.delete(it)

    def _import_ports(self):
        if not self.vhdl_files:
            messagebox.showwarning("ยังไม่มีไฟล์", "เพิ่มไฟล์ VHDL ในแท็บ 1 ก่อน")
            return
        # วิเคราะห์หา top entity + clock + ports ของ top อัตโนมัติ
        top, clk, ports = analyze_vhdl(self.vhdl_files)
        if top:
            self.var_top.set(top)
            self.log(f"ตรวจพบ Top entity: {top}")
        if clk:
            self.var_clkname.set(clk)
            self.log(f"ตรวจพบสัญญาณ clock: {clk}")
        else:
            # ไม่มี clock ในดีไซน์ -> ล้างช่อง clock เพื่อไม่ให้สร้าง timing constraint เกิน
            self.var_clkname.set("")
        if not ports:
            # parse ไม่ได้ - อย่าล้างตารางของผู้ใช้ทิ้ง
            messagebox.showinfo("ผลลัพธ์", "parse entity ไม่ได้ - ตรวจไฟล์ VHDL")
            return
        # ล้างตารางเดิมก่อนแล้วใส่ตาม port ของดีไซน์ปัจจุบัน (เรียงตาม VHDL)
        # - signal ชื่อเดิมยังเก็บค่า Pin/IOSTANDARD/Extra ที่เคยตั้งไว้
        # - signal ที่ไม่มีในดีไซน์แล้วถูกลบทิ้ง (ไม่ค้างเป็นขยะในตาราง)
        self._close_editor(commit=False)
        old = {self.tree.set(it, "signal").strip():
               (self.tree.set(it, "loc"), self.tree.set(it, "io"),
                self.tree.set(it, "extra"))
               for it in self.tree.get_children()}
        for it in self.tree.get_children():
            self.tree.delete(it)
        kept = 0
        for p in ports:
            loc, io, extra = old.get(p, ("", "LVCMOS33", ""))
            if p in old:
                kept += 1
            self._add_pin_row(p, loc, io or "LVCMOS33", extra)
        removed = len([s for s in old if s and s not in ports])
        self.log(f"ดึงขาจาก VHDL (top={top}): {len(ports)} สัญญาณ "
                 f"(คงค่า pin เดิม {kept}, ลบที่ไม่ใช้แล้ว {removed})")

    def _close_editor(self, commit=True):
        """ปิด editor ที่เปิดอยู่ (บันทึกค่า ถ้า commit=True) แล้วทำลาย widget
        กันปัญหา combobox ลอยค้างตอนเปิดหลายอัน/ลบแถว"""
        ed, fn = self._editor, self._editor_commit
        self._editor, self._editor_commit = None, None   # เคลียร์ก่อน กัน re-entry
        if commit and fn:
            try:
                fn()
            except Exception:
                pass
        if ed is not None:
            try:
                ed.destroy()
            except Exception:
                pass

    def _edit_cell(self, event):
        if self.tree.identify_region(event.x, event.y) != "cell":
            self._close_editor()                # คลิกหัวตาราง/ที่ว่าง -> ปิด editor
            return
        item = self.tree.identify_row(event.y)
        col = self.tree.identify_column(event.x)
        if not item or not col:
            return
        cidx = int(col[1:]) - 1
        if not (0 <= cidx <= 3):
            return
        colname = ("signal", "loc", "io", "extra")[cidx]
        bbox = self.tree.bbox(item, col)
        if not bbox:                            # เซลล์ที่มองไม่เห็น (เลื่อนพ้นจอ)
            return
        x, y, w, h = bbox
        cur = self.tree.set(item, colname)
        self._close_editor()                    # ปิดตัวเก่าก่อนเสมอ (มี editor เดียว)

        if colname in ("loc", "io"):
            vals = make_pin_list(self.board["pins"]) if colname == "loc" else IOSTANDARDS
            cb = ttk.Combobox(self.tree, values=vals, height=20)
            cb.set(cur)
            cb.place(x=x, y=y, width=max(w, 180 if colname == "loc" else w), height=h)
            self._editor = cb
            if colname == "loc":
                # เก็บเป็น label พร้อมวงเล็บ เช่น "P62  (SW1)" (build ดึงเฉพาะ P62)
                self._editor_commit = lambda: (self.tree.exists(item) and
                                               self.tree.set(item, colname, self._pin_label(pin_only(cb.get()))))
            else:
                self._editor_commit = lambda: (self.tree.exists(item) and
                                               self.tree.set(item, colname, cb.get()))
            cb.bind("<Return>", lambda e: self._close_editor())
            cb.bind("<<ComboboxSelected>>", lambda e: self._close_editor())
            cb.bind("<FocusOut>", lambda e: self._close_editor())
            cb.bind("<Escape>", lambda e: self._close_editor(commit=False))
            cb.focus_set()
            # เปิดรายการ dropdown อัตโนมัติ (deferred) -> คลิกเดียวเห็นรายการเลย
            def _open_list():
                try:
                    if cb.winfo_exists():
                        cb.tk.call("ttk::combobox::Post", cb)
                except Exception:
                    pass
            cb.after(1, _open_list)
        else:
            ent = ttk.Entry(self.tree)
            ent.insert(0, cur)
            ent.place(x=x, y=y, width=w, height=h)
            self._editor = ent
            self._editor_commit = lambda: (self.tree.exists(item) and
                                           self.tree.set(item, colname, ent.get()))
            ent.bind("<Return>", lambda e: self._close_editor())
            ent.bind("<FocusOut>", lambda e: self._close_editor())
            ent.bind("<Escape>", lambda e: self._close_editor(commit=False))
            ent.focus_set()

    # ---------------- ดูข้อมูล .bit ----------------
    def _open_bit_info(self):
        p = filedialog.askopenfilename(title="เลือกไฟล์ .bit",
                                       filetypes=[("Bitstream", "*.bit"), ("All", "*.*")])
        if not p:
            return
        self.var_bitpath.set(p)
        self.show_bit_info(p)

    def show_bit_info(self, p):
        info = parse_bit_header(p)
        size = os.path.getsize(p) if os.path.exists(p) else 0
        design = info.get("design", "-").split(";")[0]   # ตัด ;UserID=... ออก
        lines = [
            f"ไฟล์      : {p}",
            f"ขนาดไฟล์   : {size:,} bytes",
            "-" * 50,
            f"ชื่อดีไซน์  : {design}",
            f"ชิป (part) : xc{info.get('part', '-')}",
            f"วันที่ build: {info.get('date', '-')}",
            f"เวลา build : {info.get('time', '-')}",
            f"bitstream  : {info.get('bitstream_bytes', '-')} bytes",
        ]
        if "error" in info:
            lines.append(f"error: {info['error']}")
        self.bit_info.delete("1.0", "end")
        self.bit_info.insert("end", "\n".join(lines))

    # ---------------- generate ไฟล์ build ----------------
    def _device_string(self):
        return f"{self.var_part.get()}{self.var_speed.get()}-{self.var_pkg.get()}"

    def _write_build_files(self, bdir):
        top = self.var_top.get().strip()
        # .prj/.xst มี path ไฟล์ VHDL - เครื่องมือ ISE อ่านแบบ ANSI (ไทย=874)
        # จึงเขียนด้วย mbcs ให้ path ภาษาไทยไม่เพี้ยน
        with open(os.path.join(bdir, f"{top}.prj"), "w", encoding="mbcs", errors="replace") as f:
            for vf in self.vhdl_files:
                rel = path_for_tool(vf, bdir)
                f.write(f'vhdl work "{rel}"\n')
        # .xst
        with open(os.path.join(bdir, f"{top}.xst"), "w", encoding="mbcs", errors="replace") as f:
            f.write("run\n")
            f.write(f"-ifn {top}.prj\n-ifmt mixed\n-ofn {top}.ngc\n-ofmt NGC\n")
            f.write(f"-p {self._device_string()}\n-top {top}\n")
            f.write("-opt_mode Speed\n-opt_level 1\n-keep_hierarchy no\n-iobuf yes\n")
        # .ucf (ISE อ่านแบบ ANSI - เขียน mbcs กันชื่อ path/สัญญาณที่ไม่ใช่ ASCII)
        ucf = os.path.join(bdir, f"{top}.ucf")
        with open(ucf, "w", encoding="mbcs", errors="replace") as f:
            f.write("# auto-generated by fpga_builder.py\n")
            clk = self.var_clkname.get().strip()
            signals = set()
            for it in self.tree.get_children():
                sig = self.tree.set(it, "signal").strip()
                loc = pin_only(self.tree.set(it, "loc"))   # ดึงเฉพาะเลขพิน (ตัดวงเล็บออก)
                io  = self.tree.set(it, "io").strip()
                extra = self.tree.set(it, "extra").strip()
                if sig:
                    signals.add(sig)
                if not sig or not loc:
                    continue
                line = f'NET "{sig}" LOC = "{loc}"'
                if io:
                    line += f" | IOSTANDARD = {io}"
                if extra:
                    line += f" | {extra}"
                f.write(line + ";\n")
            # timing constraint สำหรับ clock - ใส่เฉพาะเมื่อสัญญาณ clock มีอยู่ในตาราง
            # pin จริง (กัน ngdbuild error ConstraintSystem กับวงจร combinational ที่
            # ไม่มีขา clock เช่นเดียวกับฝั่ง Vivado)
            per = self.var_period.get().strip()
            if clk and per and clk in signals:
                f.write(f'\nNET "{clk}" TNM_NET = "{clk}";\n')
                f.write(f'TIMESPEC TS_{clk} = PERIOD "{clk}" {per} ns HIGH 50%;\n')
        return ucf

    # ---------------- รัน build ----------------
    def _write_vivado_files(self, bdir):
        """สร้าง <top>.xdc (จากตาราง pin) + build.tcl สำหรับ Vivado batch mode"""
        top = self.var_top.get().strip()
        # ---- XDC ----
        xdc = os.path.join(bdir, f"{top}.xdc")
        clk = self.var_clkname.get().strip()
        per = self.var_period.get().strip()
        with open(xdc, "w", encoding="utf-8") as f:
            f.write("# auto-generated by fpga_builder.py\n")
            for it in self.tree.get_children():
                sig = self.tree.set(it, "signal").strip()
                loc = pin_only(self.tree.set(it, "loc"))
                io = self.tree.set(it, "io").strip() or "LVCMOS33"
                extra = self.tree.set(it, "extra").strip()   # เช่น "PULLDOWN true"
                if not sig or not loc:
                    continue
                d = f"PACKAGE_PIN {loc} IOSTANDARD {io}"
                if extra:
                    d += f" {extra}"
                f.write("set_property -dict {{ {} }} [get_ports {{{}}}]\n".format(d, sig))
            # ใส่ clock constraint เฉพาะเมื่อสัญญาณ clock มีอยู่ในตาราง pin จริง
            # (กัน error create_clock กับ port ที่ไม่มีในดีไซน์ เช่นวงจร combinational)
            signals = {self.tree.set(it, "signal").strip()
                       for it in self.tree.get_children()}
            if clk and per and clk in signals:
                f.write(f"\ncreate_clock -name sys_clk -period {per} [get_ports {{{clk}}}]\n")
            # กัน error พินที่ไม่ได้ใช้/ไม่มี config voltage
            f.write("set_property CFGBVS VCCO [current_design]\n")
            f.write("set_property CONFIG_VOLTAGE 3.3 [current_design]\n")
        # ---- build.tcl ----
        part = f"{self.var_part.get()}{self.var_pkg.get()}{self.var_speed.get()}"
        tcl = os.path.join(bdir, "build.tcl")
        # build.tcl มี path ไฟล์ VHDL - Tcl 8.6 ของ Vivado ใช้ system encoding
        # (ไทย=cp874) เขียน mbcs กัน path ภาษาไทยเพี้ยน
        with open(tcl, "w", encoding="mbcs", errors="replace") as f:
            # ปิด webtalk (Vivado phone-home ตอน write_bitstream) - บนเครื่องที่เน็ต
            # ช้า/ไม่มีเน็ต บางทีค้างรอ timeout; catch กัน error ถ้าเวอร์ชันไม่รู้จักคำสั่ง
            f.write("catch {config_webtalk -install off}\n")
            for vf in self.vhdl_files:
                f.write('read_vhdl "{}"\n'.format(os.path.abspath(vf).replace("\\", "/")))
            f.write(f'read_xdc "{top}.xdc"\n')
            # directive แบบเร็ว + ตัด opt_design: งานนักศึกษาเล็กมาก ผล timing/พื้นที่
            # ไม่ต่างกัน แต่ลดเวลา build ~15-30% (วัดจริง 50s -> 42s). เวลาที่เหลือ ~40s
            # เป็นต้นทุนคงที่ของ Vivado (synth ~25s + startup + โหลดข้อมูลชิป + bitstream)
            # ที่ลดไม่ได้ - เกิด "ทุกครั้ง" ไม่ใช่แค่ครั้งแรก (วัดจริง warm build 43s คงที่)
            f.write(f"synth_design -top {top} -part {part} -directive RuntimeOptimized\n")
            # clock อยู่บนขาที่ไม่ใช่ขา clock (เช่นปุ่มกด/สวิตช์ - พบบ่อยในแล็บที่กด clock
            # เอง) -> placer error [Place 30-574]/[Place 30-99] แล้ว build ล้ม. demote เป็น
            # warning ให้ build ผ่าน (ความถี่ระดับกดปุ่มไม่มีปัญหา timing)
            #
            # วิธีหา net ต้อง "ไล่จากตัว BUFG จริงในเน็ตลิสต์" ไม่ใช่เดาชื่อ:
            #   เดิมเขียน get_nets {<ชื่อ clock>_IBUF} -> พังถ้า (ก) ชื่อ port ไม่ตรงกับช่อง
            #   "ชื่อสัญญาณ clock" (เช่น port ชื่อ clock แต่ช่องเป็น clk) หรือ (ข) ช่องนั้น
            #   ว่าง/ไม่มีใน table -> ไม่เขียนบรรทัดนี้เลย -> build ล้มทั้งที่เวอร์ชันก่อนผ่าน
            #   (ยืนยันด้วยการ reproduce: port ชื่อ clock + ช่องเป็น clk -> Place 30-99)
            # ตอนนี้วนทุก BUFG แล้วปลดกฎที่ "ขา I" ของมัน -> ครอบทุกชื่อ ทุกกรณี
            # (ตรวจจากเน็ตลิสต์จริง: REF_NAME =~ BUFG* เจอ <clk>_IBUF_BUFG_inst,
            #  ขา I ต่อกับ net <clk>_IBUF; อย่าใช้ PRIMITIVE_TYPE - ตอน synth ยังว่าง)
            # ต้องอยู่หลัง synth_design เพราะเน็ตลิสต์เพิ่งเกิดตอนนั้น; catch กันพลาดทั้งบล็อก
            f.write("catch {\n"
                    "  foreach bc [get_cells -quiet -hier -filter {REF_NAME =~ BUFG*}] {\n"
                    "    set n [get_nets -quiet -of_objects [get_pins -quiet $bc/I]]\n"
                    "    if {[llength $n]} { set_property CLOCK_DEDICATED_ROUTE FALSE $n }\n"
                    "  }\n"
                    "}\n")
            f.write("place_design -directive Quick\nroute_design -directive Quick\n")
            f.write(f'write_bitstream -force "{top}.bit"\n')
        return tcl

    def on_build(self):
        self._close_editor()                    # commit ค่าพินที่กำลังแก้อยู่ก่อน
        if not self.vhdl_files:
            messagebox.showwarning("ยังไม่มีไฟล์", "เพิ่มไฟล์ VHDL ในแท็บ 1 ก่อน")
            return
        rows = [it for it in self.tree.get_children()
                if self.tree.set(it, "signal").strip() and self.tree.set(it, "loc").strip()]
        if not rows:
            if not messagebox.askyesno("ไม่มี pin", "ยังไม่ได้กำหนด LOC ให้ pin เลย\nต้องการ build ต่อหรือไม่?"):
                return
        # ทุกขาของ top entity ต้องมีพิน ไม่งั้น Vivado/ISE จะล้มที่ DRC ตอนท้าย
        # (unconstrained port -> "DRC UCIO-1/NSTD-1 ... Problem ports: x" งง ๆ)
        # -> เตือนชื่อขาที่ขาดพินตั้งแต่ต้น จะได้ไม่รอ build เสียเวลาแล้วพัง
        missing = [self.tree.set(it, "signal").strip()
                   for it in self.tree.get_children()
                   if self.tree.set(it, "signal").strip()
                   and not pin_only(self.tree.set(it, "loc")).strip()]
        if missing:
            messagebox.showwarning(
                "ยังกำหนดพินไม่ครบ",
                "ขาต่อไปนี้ยังไม่ได้เลือก Pin/LOC:\n\n"
                "     " + ", ".join(missing) + "\n\n"
                "ทุกขาของวงจรต้องมีพิน ไม่งั้น Build จะล้มเหลว\n"
                "(Vivado/ISE จะขึ้น error 'Unconstrained port')\n\n"
                "กลับไปแท็บ '2. กำหนด Pin' เลือกพินให้ครบทุกขาก่อน แล้วกด Build ใหม่")
            return
        self._save_config()
        top = self.var_top.get().strip()
        bdir = os.path.join(PROJECT_DIR, "build")
        os.makedirs(bdir, exist_ok=True)

        if self.board["tool"] == "vivado":
            # ---------- Vivado (Spartan-7) ----------
            vivado = self.var_vivado.get().strip()
            if not (vivado and os.path.exists(vivado)):
                messagebox.showerror("ไม่พบ Vivado",
                                     "ตั้ง path vivado.bat ในแท็บ 1 ก่อน\n"
                                     "(เช่น D:\\Vivado\\2025.2\\Vivado\\bin\\vivado.bat)")
                return
            # Vivado พังกับ path มีช่องว่าง (Tcl ภายใน split ตรงช่องว่าง แม้เรา quote
            # ให้ครบก็ช่วยไม่ได้) - บล็อกก่อน build เสียเวลาฟรีแล้วพังงง ๆ
            if " " in os.path.abspath(vivado) or " " in os.path.abspath(bdir):
                messagebox.showerror(
                    "ชื่อโฟลเดอร์มีช่องว่าง - Vivado ไม่รองรับ",
                    "path ของ Vivado หรือโฟลเดอร์โปรแกรมมี 'ช่องว่าง' ในชื่อ:\n"
                    f"{vivado}\n\n"
                    "Vivado จะ build ล้มเหลว (synth_design failed)\n\n"
                    "วิธีแก้: ปิดโปรแกรม แล้วเปลี่ยนชื่อ/ย้ายโฟลเดอร์ไม่ให้มีช่องว่าง\n"
                    "เช่น  C:\\FPGA_Builder  (ใช้ _ แทนช่องว่าง)")
                return
            try:
                self._write_vivado_files(bdir)
            except Exception as e:
                messagebox.showerror("เขียนไฟล์ไม่สำเร็จ", str(e))
                return
            cmds = [f'call "{vivado}" -mode batch -source build.tcl -nojournal -log vivado_build.log']
            self.log("เริ่ม build ด้วย Vivado (ปกติ ~1 นาที ทุกครั้ง - Vivado มีต้นทุนคงที่ "
                     "~40 วิ; ถ้าใช้แบตเตอรี่/RAM น้อย/วงจรใหญ่จะนานกว่านั้น เสียบชาร์จช่วยได้มาก)...")
            # isolate=True: รัน Vivado ผ่าน Task Scheduler เป็น process อิสระ ไม่ให้ Tcl
            # 8.6.15 ของ .exe (PyInstaller) ไป shadow Tcl 8.6.13 ของ Vivado จน crash
            # และรอไฟล์ .bit จริงถูกเขียนก่อนตัดสินว่าสำเร็จ (กันโปรแกรม .bit ตัวเก่า)
            self._run_flow(bdir, cmds, done_msg=f"สำเร็จ! ได้ไฟล์ build/{top}.bit (Vivado)",
                           use_ise=False, isolate=True,
                           expect_out=os.path.join(bdir, f"{top}.bit"),
                           progress_log=os.path.join(bdir, "vivado_build.log"),
                           on_done=lambda: self._after_build(os.path.join(bdir, f"{top}.bit")))
            return

        # ---------- ISE (Spartan-6) ----------
        try:
            self._write_build_files(bdir)
        except Exception as e:
            messagebox.showerror("เขียนไฟล์ไม่สำเร็จ", str(e))
            return

        dev = self._device_string()
        # คำสั่งทั้ง flow ต่อกันด้วย && ใน cmd
        cmds = [
            f'set "XILINXD_LICENSE_FILE={DEFAULT_LICENSE}"',   # ใช้ license ที่ bundle มา
            f'xst -intstyle ise -ifn "{top}.xst" -ofn "{top}.syr"',
            f'ngdbuild -intstyle ise -aul -dd _ngo -nt timestamp -uc "{top}.ucf" -p {dev} "{top}.ngc" "{top}.ngd"',
            f'map -intstyle ise -p {dev} -w -ol high -t 1 -xt 0 -r 4 -mt off -ir off -pr off -lc off -power off -o "{top}_map.ncd" "{top}.ngd" "{top}.pcf"',
            f'par -intstyle ise -w -ol high -mt off "{top}_map.ncd" "{top}.ncd" "{top}.pcf"',
            f'bitgen -intstyle ise -w -g Binary:no -g CRC:Enable -g StartupClk:Cclk "{top}.ncd" "{top}.bit" "{top}.pcf"',
        ]
        self._run_flow(bdir, cmds, done_msg=f"สำเร็จ! ได้ไฟล์ build/{top}.bit",
                       on_done=lambda: self._after_build(os.path.join(bdir, f"{top}.bit")))

    def _after_build(self, bitpath):
        if os.path.exists(bitpath):
            self.var_bitpath.set(bitpath)
            self.show_bit_info(bitpath)

    # ---------------- openFPGALoader ----------------
    def _pick_ofl(self):
        p = filedialog.askopenfilename(title="เลือก openFPGALoader.exe",
                                       filetypes=[("EXE", "*.exe"), ("All", "*.*")])
        if p:
            self.var_ofl.set(p)

    def _resolve_bit(self):
        """หา .bit ที่จะใช้: ที่เลือกไว้ในแท็บ 3 ก่อน ไม่งั้น build/<top>.bit"""
        if self.var_bitpath.get() and os.path.exists(self.var_bitpath.get()):
            return self.var_bitpath.get()
        cand = os.path.join(PROJECT_DIR, "build", f"{self.var_top.get().strip()}.bit")
        return cand if os.path.exists(cand) else None

    def on_save_bit(self):
        """บันทึกไฟล์ .bit ที่ build เสร็จแล้วไปเก็บที่อื่น (Save As)
        เหตุผล: build/<top>.bit ถูกเขียนทับทุกครั้งที่กด Build ใหม่ นักศึกษาที่อยาก
        เก็บผลของแต่ละแล็บ/ส่งงาน ต้องก๊อปออกไปเอง ปุ่มนี้ทำให้ง่ายและกันเลือกผิดไฟล์"""
        bit = self._resolve_bit()
        if not bit:
            messagebox.showwarning(
                "ยังไม่มีไฟล์ .bit",
                "ยังไม่พบไฟล์ .bit ที่จะบันทึก\n\n"
                "ให้กด '▶ Build .bit' ให้ขึ้น 'สำเร็จ!' สีเขียวก่อน\n"
                "(หรือเลือกไฟล์ .bit เองในแท็บ '3. ดูข้อมูล .bit')")
            return
        info = parse_bit_header(bit) or {}
        # ตั้งชื่อ default มี วัน-เวลา ต่อท้าย -> เซฟหลายรอบไม่ทับกันเอง
        stamp = time.strftime("%Y%m%d_%H%M")
        base = os.path.splitext(os.path.basename(bit))[0]
        dest = filedialog.asksaveasfilename(
            title="บันทึกไฟล์ .bit ไปที่...",
            defaultextension=".bit",
            initialfile=f"{base}_{stamp}.bit",
            filetypes=[("Bitstream", "*.bit"), ("ทุกไฟล์", "*.*")])
        if not dest:
            return
        if os.path.normcase(os.path.abspath(dest)) == os.path.normcase(os.path.abspath(bit)):
            messagebox.showinfo("ไฟล์เดิม", "เลือกตำแหน่งเดิมกับไฟล์ต้นทาง - ไม่ต้องบันทึกซ้ำ")
            return
        try:
            shutil.copy2(bit, dest)          # copy2 = เก็บเวลาแก้ไขเดิมไว้ด้วย
        except Exception as e:
            messagebox.showerror("บันทึกไม่สำเร็จ", f"คัดลอกไฟล์ไม่ได้:\n{e}")
            return
        detail = ""
        if info.get("design") or info.get("date"):
            detail = "\n\n(design: {}  {} {})".format(info.get("design", "?"),
                                                      info.get("date", ""), info.get("time", ""))
        self.log(f"บันทึก .bit แล้ว: {dest}")
        self.status.config(text="บันทึก .bit แล้ว", foreground="green")
        messagebox.showinfo("บันทึกแล้ว", f"บันทึกไฟล์ .bit เรียบร้อย:\n{dest}{detail}")

    def on_ofl_detect(self):
        ofl = self._resolve_ofl()
        if not ofl:
            return
        cable = self.var_cable.get().strip()
        self._run_flow(PROJECT_DIR, [f'"{ofl}" -c {cable} --detect'],
                       done_msg="detect เสร็จ (ดูผลด้านบน)", use_ise=False)

    def _find_spioverjtag(self, ofl):
        """หาไฟล์ spiOverJtag (.bit เท่านั้น) สำหรับเขียน Flash
        เช็ค: ข้าง exe ที่เลือก -> โฟลเดอร์ bundle ของโปรแกรม -> share/ ของ msys2"""
        name = f"spiOverJtag_{self.var_part.get()}{self.var_pkg.get()}.bit"
        cands = [
            os.path.join(os.path.dirname(ofl), name),
            os.path.join(PROJECT_DIR, "tools", "openFPGALoader", name),
            os.path.join(os.path.dirname(ofl), "..", "share", "openFPGALoader", name),
        ]
        for c in cands:
            if os.path.exists(c):
                # ใช้ / กัน quoting เพี้ยนใน batch
                return os.path.abspath(c).replace("\\", "/")
        return None

    def _ask_flash_mode(self):
        """dialog เลือกรูปแบบการโปรแกรม (เหมือนเครื่องมือของวิชา):
        'sram' = Normal Rom (เร็ว-ชั่วคราว), 'flash' = PROM Rom (ช้า-ถาวร), None = ยกเลิก"""
        dlg = tk.Toplevel(self)
        dlg.title("Type of Flash")
        dlg.resizable(False, False)
        dlg.grab_set()
        choice = {"v": None}

        ttk.Label(dlg, text="เลือกรูปแบบการโปรแกรม FPGA",
                  font=("Segoe UI", 11, "bold")).pack(padx=16, pady=(14, 8))

        def pick(v):
            choice["v"] = v
            dlg.destroy()

        b1 = tk.Button(dlg, anchor="w", justify="left", command=lambda: pick("sram"),
                       text="1)  Normal Rom  (Fast - Temporary)\n"
                            "     โหลดเร็ว ลง SRAM - โปรแกรมจะหายเมื่อถอดปลั๊ก/ปิดไฟ")
        b1.pack(fill="x", padx=16, pady=4, ipady=4)
        b2 = tk.Button(dlg, anchor="w", justify="left", command=lambda: pick("flash"),
                       text="2)  PROM Rom  (Slow - Permanent)\n"
                            "     เขียนลง Flash PROM - โปรแกรมอยู่ถาวรแม้ถอดปลั๊ก")
        b2.pack(fill="x", padx=16, pady=4, ipady=4)

        ttk.Label(dlg, foreground="red", justify="left",
                  text="คำเตือน: PROM เขียนซ้ำได้จำนวนจำกัด ให้ใช้อย่างคุ้มค่า\n"
                       "ใช้ Normal Rom ตอนทดสอบ แล้วค่อยเขียน PROM เมื่อวงจรเสร็จ").pack(padx=16, pady=(6, 8))
        ttk.Button(dlg, text="ยกเลิก", command=dlg.destroy).pack(pady=(0, 12))

        # จัดกลางจอ
        dlg.update_idletasks()
        x = self.winfo_x() + (self.winfo_width() - dlg.winfo_width()) // 2
        y = self.winfo_y() + (self.winfo_height() - dlg.winfo_height()) // 2
        dlg.geometry(f"+{max(x,0)}+{max(y,0)}")
        self.wait_window(dlg)
        return choice["v"]

    def _resolve_ofl(self, quiet=False):
        """หา openFPGALoader.exe ที่ใช้ได้จริง + ซ่อมค่าที่ตั้งไว้อัตโนมัติ (คืน None ถ้าไม่มีจริง)

        ทำไมต้องมี: ไฟล์ config (fpga_builder.json) เก็บ path แบบเต็มของ "เครื่องที่เคยใช้"
        ถ้า config ติดไปกับแพ็กเกจ/ก๊อปข้ามเครื่อง path นั้นจะไม่มีบนเครื่องนักศึกษา แล้ว
        เด้ง "ไม่พบไฟล์: C:\\msys64\\mingw64\\bin\\openFPGALoader.exe" ซึ่งนักศึกษาไม่รู้จัก
        และไม่รู้ว่าต้องทำอะไร ทั้งที่ตัวจริง bundle มาให้แล้วใน tools\\openFPGALoader
        -> ให้ไปหยิบตัวที่มีจริงมาใช้เองเงียบ ๆ ก่อน ค่อยเตือนถ้าไม่มีจริง ๆ"""
        cur = self.var_ofl.get().strip()
        if cur and os.path.exists(cur):
            return cur
        for c in (_bundled_ofl,
                  os.path.join(PROJECT_DIR, "openFPGALoader.exe"),
                  shutil.which("openFPGALoader.exe") or "",
                  DEFAULT_OFL):
            if c and os.path.exists(c):
                self.var_ofl.set(c)
                self.log(f"ตั้ง openFPGALoader ให้อัตโนมัติ: {c}")
                return c
        if not quiet:
            messagebox.showwarning(
                "ไม่พบ openFPGALoader",
                "ไม่พบโปรแกรม openFPGALoader.exe (ตัวที่ใช้โหลด .bit ลงบอร์ด)\n\n"
                "ปกติไฟล์นี้มาพร้อมชุดโปรแกรมอยู่แล้วที่:\n"
                f"{_bundled_ofl}\n\n"
                "ถ้าไม่มีไฟล์นี้ แปลว่า 'แตกไฟล์ zip ไม่ครบ' (มักเกิดจากชื่อ path ยาวเกิน)\n"
                "วิธีแก้: แตกไฟล์ zip ใหม่ด้วย 7-Zip ไว้ที่ path สั้น ๆ เช่น C:\\FPGA\n"
                "(ห้ามมีช่องว่างและภาษาไทยในชื่อโฟลเดอร์)")
        return None

    def on_program_ofl(self):
        ofl = self._resolve_ofl()
        if not ofl:
            return
        bit = self._resolve_bit()
        if not bit:
            bit = filedialog.askopenfilename(title="เลือกไฟล์ .bit ที่จะโหลด",
                                             filetypes=[("Bitstream", "*.bit"), ("All", "*.*")])
            if not bit:
                return
            self.var_bitpath.set(bit)
        # กันพลาด: เช็คว่า .bit ตรงกับชิปของบอร์ดที่เลือก (เช่น เอา bit ของ
        # Spartan-6 ไปโหลดลง Spartan-7 -> FPGA ไม่ config, STARTUP=0)
        info = parse_bit_header(bit)
        bit_part = (info.get("part") or "").lower()          # เช่น "6slx9tqg144", "7s15ftgb196"
        sel_core = self.var_part.get().lower().replace("xc", "")        # "7s15" / "6slx9"
        # header = <ชื่อชิป><package> จึงต้องขึ้นต้นด้วยชื่อชิปแล้วตามด้วยตัวอักษร
        # (package) - เทียบแบบ substring เฉย ๆ จะทำให้ "6slx4" หลงนับ "6slx45..."
        # ของชิปคนละเบอร์เป็นตัวเดียวกัน
        nxt = bit_part[len(sel_core):len(sel_core) + 1]
        part_ok = bit_part.startswith(sel_core) and not nxt.isdigit()
        if bit_part and not part_ok:
            if not messagebox.askyesno(
                    "ชิปไม่ตรงกัน!",
                    f"ไฟล์ .bit นี้สร้างสำหรับชิป: xc{bit_part}\n"
                    f"แต่บอร์ดที่เลือกใช้ชิป: {self.var_part.get()}{self.var_pkg.get()}\n\n"
                    "โหลดไปก็ไม่ทำงาน (FPGA จะไม่ config)\n"
                    "ต้อง Build ใหม่สำหรับบอร์ดนี้ก่อน\n\n"
                    "ยืนยันจะฝืนโหลดต่อหรือไม่?"):
                return
        # กัน .bit เก่า: ถ้าไฟล์ constraint (.xdc/.ucf) ใหม่กว่า .bit แปลว่าแก้ pin
        # แล้ว build ครั้งหลังยังไม่สำเร็จ -> .bit ยังเป็นตัวเดิม (pin เดิม)
        # ใช้เฉพาะกับ .bit ของโปรเจกต์นี้เอง - ไฟล์ .bit ที่ผู้ใช้เลือกจากที่อื่น
        # ไม่ได้เกิดจาก constraint ชุดนี้ เทียบเวลากันไม่มีความหมาย
        try:
            top = self.var_top.get().strip()
            proj_bit = os.path.join(PROJECT_DIR, "build", f"{top}.bit")
            cons = os.path.join(PROJECT_DIR, "build",
                                f"{top}.xdc" if self.board["tool"] == "vivado"
                                else f"{top}.ucf")
            same = os.path.normcase(os.path.abspath(bit)) == os.path.normcase(proj_bit)
            if (same and os.path.exists(cons) and os.path.exists(bit)
                    and os.path.getmtime(cons) > os.path.getmtime(bit) + 2):
                import datetime
                bt = datetime.datetime.fromtimestamp(os.path.getmtime(bit))
                if not messagebox.askyesno(
                        "ไฟล์ .bit เป็นตัวเก่า!",
                        f".bit ที่จะโหลดสร้างเมื่อ {bt:%d/%m %H:%M} "
                        "ซึ่งเก่ากว่าการแก้ pin/ตั้งค่าล่าสุด\n\n"
                        "แปลว่าการ Build ครั้งหลังยัง 'ไม่สำเร็จ' — โหลดตอนนี้จะได้ pin เดิม\n\n"
                        "แนะนำ: กด Build .bit ใหม่ รอจนขึ้น 'สำเร็จ!' สีเขียวก่อน\n\n"
                        "ยืนยันจะฝืนโหลดด้วย .bit ตัวเก่าต่อหรือไม่?"):
                    return
        except Exception:
            pass
        mode = self._ask_flash_mode()
        if mode is None:
            return
        cable = self.var_cable.get().strip()
        if mode == "sram":
            # -m = โหลดเข้า SRAM (volatile)
            pre = []
            cmd = f'"{ofl}" -c {cable} -m "{bit}"'
            done = "โหลดลง FPGA สำเร็จ (Normal Rom: SRAM - หายเมื่อปิดไฟ)"
            self.log(f"โหลด SRAM: {bit}  (cable={cable})")
        else:
            # -f = เขียนลง SPI Flash (ถาวร), -B = ระบุ spiOverJtag bitstream เอง
            # (ต้องส่ง -B เสมอ เพราะ path default ที่ compile มาใช้ไม่ได้นอก msys2)
            bridge = self._find_spioverjtag(ofl)
            if not bridge:
                messagebox.showerror(
                    "ไม่พบไฟล์ spiOverJtag",
                    "การเขียน PROM ต้องมีไฟล์ spiOverJtag_"
                    f"{self.var_part.get()}{self.var_pkg.get()}.bit\n"
                    "วางไว้ข้าง openFPGALoader.exe (โฟลเดอร์ tools\\openFPGALoader)")
                return
            # openFPGALoader (MSYS2) ส่ง path ผ่าน cygpath — ช่องว่างใน path (เช่น "FPGA Ecosystem")
            # ทำให้ "Error: fail to open" ทั้งที่ไฟล์มีอยู่: ทำงานจากโฟลเดอร์ของ bridge แล้วส่งแค่ชื่อไฟล์
            bdir = os.path.dirname(os.path.abspath(bridge))
            pre = [f'pushd "{bdir}"']
            cmd = f'"{ofl}" -c {cable} -f -B "{os.path.basename(bridge)}" "{os.path.abspath(bit)}"'
            done = "เขียนลง PROM Flash สำเร็จ (ถาวร - อยู่แม้ถอดปลั๊ก)"
            self.log(f"เขียน PROM Flash: {bit}  (cable={cable})")
        # openFPGALoader (build จาก MSYS2) เรียก cygpath ตอนเขียน flash -
        # เติมโฟลเดอร์ openFPGALoader (ที่ bundle cygpath ไว้) เข้า PATH กัน error
        ofldir = os.path.dirname(os.path.abspath(ofl))
        setpath = f'set "PATH={ofldir};%PATH%"'
        self._run_flow(PROJECT_DIR, [setpath] + pre + [cmd], done_msg=done, use_ise=False)

    def _action_buttons(self):
        return [b for b in (getattr(self, n, None) for n in
                            ("btn_build", "btn_ofl", "btn_detect", "btn_driver",
                             "btn_save")) if b]   # ปิด save ระหว่าง build ด้วย
                                                  # (กันคัดลอก .bit ที่เขียนค้างครึ่งไฟล์)

    def _kill_tree(self, pid):
        """ฆ่า process ทั้ง tree - terminate() เฉย ๆ ฆ่าแค่ cmd แม่ ลูกอย่าง
        xst/par/openFPGALoader จะรันต่อและเขียนไฟล์ใน build/ ต่อได้"""
        NW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           creationflags=NW, capture_output=True, timeout=15)
        except Exception:
            try:
                self.proc.terminate()
            except Exception:
                pass

    def _kill_sched_build(self):
        """ฆ่า process ค้างของ Vivado build: (1) process tree ที่อ้าง _task_* ของเรา
        (2) **ตัว vivado/loader/java ที่รันจาก tools\\vivado_min** ซึ่ง detach จาก cmd
        แล้วเลยไม่โดนฆ่าตาม _task_ (เป็นเหตุให้ orphan ค้าง lock/license ทำ build ใหม่
        hang - java idle 156MB). schtasks /delete ลบแค่นิยาม task ไม่ได้ฆ่า instance"""
        NW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        task = os.path.join(PROJECT_DIR, "build", "_task_")
        vmin = os.path.join(PROJECT_DIR, "tools", "vivado_min")
        ps = (
            "$t=[regex]::Escape('" + task.replace("'", "''") + "');"
            "$v=[regex]::Escape('" + vmin.replace("'", "''") + "');"
            "function KT($id){ Get-CimInstance Win32_Process -Filter \"ParentProcessId=$id\" "
            "| ForEach-Object { KT $_.ProcessId }; "
            "Stop-Process -Id $id -Force -ErrorAction SilentlyContinue };"
            "Get-CimInstance Win32_Process | Where-Object { "
            "($_.CommandLine -and ($_.CommandLine -match $t -or $_.CommandLine -match $v)) "
            "-or ($_.ExecutablePath -and $_.ExecutablePath -match $v) } "
            "| ForEach-Object { KT $_.ProcessId }"
        )
        try:
            subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           creationflags=NW, capture_output=True, timeout=30)
        except Exception:
            pass

    def _clean_vivado_locks(self, cwd):
        """ลบ .Xil ค้างในโฟลเดอร์ build (lock ของ build ก่อนที่ถูกฆ่า/ค้าง)
        หมายเหตุ: ไม่ยุ่งกับ .tcl_store_lock ใน APPDATA - การลบมันอาจทำ Vivado
        rebuild tcl store แล้ว hang ตอน init"""
        try:
            shutil.rmtree(os.path.join(cwd, ".Xil"), ignore_errors=True)
        except Exception:
            pass

    def on_stop(self):
        """หยุดงานที่กำลังรัน และ 'ปลดล็อก' UI ให้เริ่มใหม่ได้เสมอ

        เดิม: ถ้า worker ค้างในจังหวะที่ยังไม่ทันตั้ง _sched_active (เช่น schtasks
        ค้างไม่ตอบสนอง) กดหยุดจะขึ้น '(ไม่มีงานที่กำลังรันอยู่)' แต่ _busy ยัง True
        อยู่ -> สถานะค้าง 'กำลังทำงาน' กด Build ใหม่ก็ไม่ได้ตลอดกาล
        ตอนนี้: ถ้ากำลัง busy อยู่ กดหยุดจะรีเซ็ตสถานะให้กลับมาเริ่มใหม่ได้เสมอ
        และเลื่อน 'รุ่นงาน' (_busy_gen) เพื่อให้ worker ตัวที่ค้างอยู่ตกรุ่น -
        ผลลัพธ์/‘done’ ของมันจะถูกเมิน ไม่มากวนงานใหม่"""
        if not self._busy:
            self.log("(ไม่มีงานที่กำลังรันอยู่)")
            return
        self._cancel = True          # ให้ _wait_build ที่ยังรออยู่เลิกรอทันที
        self._busy_gen += 1          # worker เดิมตกรุ่น: 'done' ของมันจะถูกเมิน
        self.log("** ผู้ใช้สั่งหยุด - ยกเลิกงานและปลดล็อกให้เริ่มใหม่ **")
        # ฆ่า Vivado/task ที่อาจยังค้าง (ครอบทั้งงานผ่าน Task Scheduler และ orphan)
        threading.Thread(target=self._kill_sched_build, daemon=True).start()
        if self.proc and self.proc.poll() is None:
            try:
                self._kill_tree(self.proc.pid)
            except Exception:
                pass
        # ปลดล็อก UI ทันที ไม่รอ worker (ตัวที่ค้างอาจไม่คืน 'done' อีกนาน/ตลอดไป)
        self._busy = False
        self._sched_active = False
        for b in self._action_buttons():
            b.config(state="normal")
        self.status.config(text="หยุดแล้ว - พร้อมเริ่มใหม่", foreground="red")

    def _run_flow(self, cwd, cmds, done_msg="", on_done=None, use_ise=True,
                  expect_out=None, progress_log=None, isolate=False):
        # กันรันซ้อน: สอง flow พร้อมกันจะเขียน _run.bat ทับกันกลางคัน, แย่ง
        # self.proc (ปุ่มหยุดชี้ผิดตัว) และ 'done' ของตัวที่จบก่อนปลดล็อกปุ่ม
        # ทั้งที่อีกตัวยังรันอยู่
        if self._busy:
            messagebox.showwarning("กำลังทำงานอยู่",
                                   "มีงานกำลังรันอยู่ รอให้เสร็จ หรือกด '■ หยุด' ก่อน")
            return
        self._busy = True
        self._cancel = False
        self._busy_gen += 1
        gen = self._busy_gen
        ise = self.var_ise.get().strip()
        if use_ise and not (ise and os.path.exists(ise)):
            self.log(f"[เตือน] ไม่พบ settings64.bat: {ise}")
            self.log("        ถ้าเครื่องมือ ISE อยู่ใน PATH แล้วจะรันต่อได้")

        for b in self._action_buttons():
            b.config(state="disabled")
        self.status.config(text="กำลังทำงาน...", foreground="orange")

        def worker():
            try:
                self.log_queue.put(("log", "=" * 60))
                self.log_queue.put(("log", f"cwd: {cwd}"))
                bat = os.path.join(cwd, "_run.bat")
                # cmd.exe อ่าน .bat ด้วย codepage ANSI/OEM ของเครื่อง (ไทย=874)
                # ไม่ใช่ utf-8 - เขียนด้วย mbcs เพื่อให้ path ภาษาไทยไม่เพี้ยน
                with open(bat, "w", encoding="mbcs", errors="replace") as f:
                    f.write("@echo off\r\n")
                    if use_ise and ise and os.path.exists(ise):
                        f.write(f'call "{ise}"\r\n')
                    for c in cmds:
                        f.write(c + "\r\n")
                        f.write("if errorlevel 1 exit /b 1\r\n")
                start_ts = time.time()
                ise_out = []          # เก็บ stdout ของ ISE ไว้สแกนหาสาเหตุตอนล้มเหลว

                if isolate:
                    # .exe (windowed + Tkinter) โหลด Tcl 8.6.15 ของ PyInstaller เข้า
                    # process ทำให้ Vivado (ที่ต้องใช้ Tcl 8.6.13 ของตัวเอง) เจอ
                    # "version conflict" แล้ว crash ทันที (build ไม่เกิด แต่ cmd คืน
                    # rc=0 -> โปรแกรมนึกว่าสำเร็จ). แก้โดยรัน build ผ่าน Windows Task
                    # Scheduler ให้เป็น process อิสระ (svchost spawn, ไม่สืบทอด DLL
                    # ของ .exe) Vivado จึงโหลด Tcl ของตัวเองถูกต้อง
                    ok = self._run_via_scheduler(cwd, bat, expect_out, progress_log,
                                                 start_ts, gen)
                    rc = 0 if ok else 1
                else:
                    usb_err = False
                    self.proc = subprocess.Popen(
                        ["cmd", "/c", bat], cwd=cwd,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        universal_newlines=True, encoding="utf-8", errors="replace",
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                    for line in self.proc.stdout:
                        ln = line.rstrip("\n")
                        self.log_queue.put(("log", ln))
                        ise_out.append(ln)
                        low = ln.lower()
                        if ("usb_open" in low or "unable to open ftdi" in low
                                or "jtag init failed" in low or "no cable found" in low
                                or "unable to open" in low and "ftdi" in low):
                            usb_err = True
                    self.proc.wait()
                    rc = self.proc.returncode
                    if rc != 0 and usb_err:
                        # เปิดบอร์ดไม่ได้ (ไดรเวอร์ไม่ใช่ WinUSB) -> เด้งตัวช่วยตั้งไดรเวอร์
                        self.log_queue.put(("usbfix", None))

                if self._busy_gen != gen:
                    # งานนี้ถูกสั่งหยุด/มีงานใหม่มาแทนแล้ว - เงียบไว้ อย่าไปเปลี่ยน
                    # สถานะทับ (on_stop ตั้ง 'หยุดแล้ว' ไว้ให้แล้ว)
                    pass
                elif rc == 0:
                    self.log_queue.put(("ok", done_msg or "เสร็จ"))
                    if on_done:
                        self.log_queue.put(("call", on_done))
                else:
                    # สแกน log หา "สาเหตุ" แล้วอธิบายเป็นภาษาไทยให้เข้าใจง่าย
                    # (Vivado -> อ่านไฟล์ log เต็ม; ISE -> stdout ที่เก็บไว้ + *.syr/*.par)
                    scan = ""
                    try:
                        if progress_log and os.path.exists(progress_log):
                            with open(progress_log, "r", encoding="utf-8",
                                      errors="replace") as f:
                                scan = f.read()
                        else:
                            scan = "\n".join(ise_out)
                            for rp in (glob.glob(os.path.join(cwd, "*.syr"))
                                       + glob.glob(os.path.join(cwd, "*.par"))):
                                try:
                                    with open(rp, "r", errors="replace") as f:
                                        scan += "\n" + f.read()
                                except OSError:
                                    pass
                    except Exception:
                        pass
                    hint = self._build_error_hint(scan)
                    if hint:
                        self.log_queue.put(("hint", hint))
                    self.log_queue.put(("err", f"ล้มเหลว (exit {rc}) - ดู log/ไฟล์ *.syr *.par ในโฟลเดอร์ build"))
            except Exception as e:
                if self._busy_gen == gen:
                    self.log_queue.put(("err", f"ข้อผิดพลาด: {e}"))
            finally:
                self.log_queue.put(("done", gen))

        threading.Thread(target=worker, daemon=True).start()

    def _run_via_scheduler(self, cwd, bat, expect_out, progress_log, start_ts, gen=None):
        """รัน build ผ่าน Windows Task Scheduler เพื่อให้เป็น process อิสระจาก .exe
        (กัน Tcl 8.6.15 ของ PyInstaller ไป shadow Tcl 8.6.13 ของ Vivado) แล้วรอผล
        จริงจาก log/ไฟล์ .bit  คืน True เมื่อได้ไฟล์ผล"""
        NW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        tn = "FPGA_Builder_VivadoBuild"

        # เก็บ mtime เดิมของไฟล์ผล/log ก่อน launch - ของ "ใหม่จริง" ต้อง mtime
        # มากกว่านี้เท่านั้น (กันนับ .bit/log ของรอบก่อนเป็นผลของรอบนี้ เวลาผู้ใช้
        # กด Build ซ้ำติด ๆ กัน)
        def _mt(p):
            try:
                return os.path.getmtime(p)
            except OSError:
                return -1.0
        pre_bit, pre_log = _mt(expect_out), _mt(progress_log)

        # ฆ่า Vivado/orphan เก่าที่อาจค้าง (เช่น build ก่อนหน้ายังไม่ปล่อย license/lock
        # หรือปิดแอปกลาง build) + ลบ lock ค้าง - กัน Vivado ตัวใหม่ hang idle ตอน
        # startup (อาการ java 156MB นิ่ง ไม่เขียน log) หรือสองตัวแย่ง build dir เดียวกัน
        self._kill_sched_build()
        self._clean_vivado_locks(cwd)
        time.sleep(1.0)          # ให้ OS ปล่อย handle/lock ของตัวที่เพิ่งฆ่า

        taskbat = os.path.join(cwd, "_task_run.bat")
        # cmd/wscript อ่านไฟล์แบบ ANSI/OEM (ไทย=874) ไม่ใช่ utf-8
        with open(taskbat, "w", encoding="mbcs", errors="replace") as f:
            f.write("@echo off\r\n")
            f.write(f'cd /d "{cwd}"\r\n')       # Task Scheduler เริ่มที่ System32
            f.write(f'call "{bat}"\r\n')
        # VBScript launcher: รัน batch แบบซ่อนหน้าต่าง cmd (window style 0) + รอจนจบ
        # (wscript.exe ไม่มี console -> ไม่เห็นหน้าต่างใด ๆ เด้งขึ้นมา)
        vbs = os.path.join(cwd, "_task_hidden.vbs")
        with open(vbs, "w", encoding="mbcs", errors="replace") as f:
            f.write('CreateObject("WScript.Shell").Run '
                    'Chr(34) & "{}" & Chr(34), 0, True\r\n'.format(taskbat))

        class _SchTimeout:       # ผลสำรองเมื่อ schtasks ค้างจนหมดเวลา
            returncode = 1
            stdout = ""
            stderr = "schtasks ไม่ตอบสนอง (หมดเวลา) - Task Scheduler service อาจมีปัญหา"
        def sch(args):
            # ต้องมี timeout เสมอ: บนเครื่องที่ Task Scheduler service ค้าง/เพี้ยน
            # schtasks.exe จะบล็อกรอ RPC ไม่คืนค่า -> worker ค้างตั้งแต่ยังไม่เริ่ม
            # build (สถานะค้าง 'กำลังทำงาน' กดหยุดก็ไม่เจอ process กด Build ใหม่ไม่ได้)
            try:
                return subprocess.run(["schtasks"] + args, creationflags=NW,
                                      capture_output=True, text=True,
                                      encoding="utf-8", errors="replace", timeout=60)
            except subprocess.TimeoutExpired:
                return _SchTimeout()

        sch(["/delete", "/tn", tn, "/f"])       # เผื่อนิยาม task ค้างจากรอบก่อน
        r = sch(["/create", "/tn", tn,
                 "/tr", f'wscript.exe //B //Nologo "{vbs}"',
                 "/sc", "once", "/st", "00:00", "/f"])
        # **สำคัญ: schtasks สร้าง task ที่ default "ห้ามรันตอนใช้แบตเตอรี่" +
        # "หยุดถ้าเปลี่ยนมาใช้แบต" -> โน้ตบุ๊คที่ถอดปลั๊กจะ build ไม่ออก (task ค้างคิว)
        # ต้องตั้งให้รันบนแบตได้ ไม่งั้นนักศึกษาที่ไม่ได้เสียบชาร์จจะเจอ build ค้าง
        if r.returncode == 0:
            subprocess.run(["powershell", "-NoProfile", "-Command",
                            f"Set-ScheduledTask -TaskName '{tn}' -Settings "
                            "(New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries "
                            "-DontStopIfGoingOnBatteries "
                            "-ExecutionTimeLimit ([TimeSpan]::FromHours(2)))"],
                           creationflags=NW, capture_output=True, timeout=30)
        launched = False
        direct_rc = None
        if r.returncode == 0:
            rr = sch(["/run", "/tn", tn])
            if rr.returncode == 0:
                launched = True
                self.log_queue.put(("log", "กำลัง build ด้วย Vivado (รอสักครู่ ~1-3 นาที "
                                           "อย่าเพิ่งกด Program จนกว่าจะขึ้น 'สำเร็จ!' สีเขียว)..."))
            else:
                self.log_queue.put(("log", "[X] สั่งรัน task ไม่สำเร็จ: "
                                    + (rr.stderr or rr.stdout or "").strip()))
        else:
            self.log_queue.put(("log", "[X] สร้าง scheduled task ไม่สำเร็จ: "
                                + (r.stderr or r.stdout or "").strip()))

        # ถ้าถูกสั่งหยุด/มีงานใหม่มาแทนระหว่างตั้งค่า task (เช่น schtasks เพิ่งค้าง
        # จนหมดเวลา 60s ไปแล้วผู้ใช้กดหยุด/Build ใหม่) - ยกเลิก ไม่รันสำรอง ไม่รอผล
        # และไม่ไปฆ่า Vivado ของงานใหม่
        superseded = gen is not None and self._busy_gen != gen
        if not launched and not superseded:
            # fallback: รันตรง (อาจเจอ Tcl conflict บนบางเครื่อง แต่ดีกว่าไม่รัน)
            self.log_queue.put(("log", "ลองรันแบบปกติแทน..."))
            try:
                p = subprocess.Popen(["cmd", "/c", bat], cwd=cwd, creationflags=NW,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     stdin=subprocess.DEVNULL)
                p.wait()
                direct_rc = p.returncode
            except Exception:
                direct_rc = -1

        self._sched_active = True
        try:
            if superseded:
                ok = False
            else:
                ok = self._wait_build(expect_out, progress_log, start_ts,
                                      pre_bit, pre_log, direct_rc, gen=gen)
        finally:
            self._sched_active = False
            sch(["/delete", "/tn", tn, "/f"])   # เก็บกวาดนิยาม task
        # แจ้งล้มเหลว/หยุดไปแล้ว - ฆ่า Vivado ที่อาจยังรันอยู่ ไม่ให้แอบเขียน .bit
        # ทีหลังทั้งที่ GUI บอกว่าล้มเหลว (แต่ถ้าตกรุ่นแล้ว อย่าไปฆ่าของงานใหม่)
        if not ok and (gen is None or self._busy_gen == gen):
            self._kill_sched_build()
        return ok

    def _wait_build(self, expect_out, progress_log, start,
                    pre_bit=-1.0, pre_log=-1.0, direct_rc=None, timeout=900, gen=None):
        """รอผล build จริง (Vivado เป็น process แยก) เกณฑ์ตัดสิน:
        - สำเร็จ: log ตัวใหม่มีบรรทัด 'write_bitstream completed successfully'
          และไฟล์ .bit ถูกเขียนใหม่ (mtime > ของเดิม) - แค่ไฟล์โผล่ยังไม่พอ เพราะ
          write_bitstream สร้างไฟล์ก่อนแล้วทยอยเขียน อาจจับได้ตอนเขียนครึ่งเดียว
        - ล้มเหลว: log ใหม่จบ (Exiting Vivado) โดยไม่มี marker/ไฟล์ผล, ไม่เริ่ม
          ใน 240s, เกินเวลา หรือผู้ใช้กดหยุด"""
        deadline = time.time() + timeout
        pos = 0
        completed = False

        def fresh_bit():
            try:
                return (os.path.exists(expect_out)
                        and os.path.getmtime(expect_out) > pre_bit)
            except OSError:
                return False

        def log_is_new():
            try:
                return (progress_log and os.path.exists(progress_log)
                        and os.path.getmtime(progress_log) > pre_log)
            except OSError:
                return False

        while time.time() < deadline:
            if self._cancel or (gen is not None and self._busy_gen != gen):
                self.log_queue.put(("log", "[X] หยุดโดยผู้ใช้"))
                return False
            if log_is_new():
                try:
                    with open(progress_log, "r", encoding="utf-8", errors="replace") as f:
                        f.seek(0, 2)
                        size = f.tell()
                        if size < pos:          # Vivado สร้างไฟล์ log ใหม่ - อ่านจากต้น
                            pos = 0
                        f.seek(pos)
                        chunk = f.read()
                        pos = f.tell()
                    for ln in chunk.splitlines():
                        if ln.strip():
                            self.log_queue.put(("log", ln))
                    if "write_bitstream completed successfully" in chunk:
                        completed = True
                except OSError:
                    pass
                if completed and fresh_bit():
                    return True
                # Vivado จบแล้ว: อ่าน tail ตัดสิน (marker อาจโดนตัดกลาง chunk)
                try:
                    with open(progress_log, "r", encoding="utf-8", errors="replace") as f:
                        f.seek(0, 2)
                        f.seek(max(0, f.tell() - 6000))
                        tail = f.read()
                    if "write_bitstream completed successfully" in tail:
                        completed = True
                    if "Exiting Vivado" in tail:
                        return completed and fresh_bit()
                except OSError:
                    pass
            else:
                # fallback รันตรง: process จบไปแล้วแต่ log ไม่เกิดเลย = crash
                # ตั้งแต่เริ่ม (เช่น Tcl conflict) - ไม่ต้องรอครบ 240s
                if direct_rc is not None and time.time() - start > 12:
                    self.log_queue.put(("log", "[X] Vivado จบทันทีโดยไม่มี log "
                                               "(อาจติดปัญหา Tcl/environment)"))
                    return False
                if time.time() - start > 240:
                    self.log_queue.put(("log",
                        "[X] Vivado ไม่เริ่มทำงาน (ไม่มี log ใหม่)\n"
                        "    สาเหตุที่พบบ่อย: **โน้ตบุ๊คใช้แบตเตอรี่อยู่** - Windows บล็อก\n"
                        "    ไม่ให้ Task รันตอนใช้แบต -> **เสียบสายชาร์จ แล้วกด Build ใหม่**\n"
                        "    (ถ้าเสียบชาร์จแล้วยังไม่ได้ ให้รีสตาร์ทเครื่องแล้วลองอีกครั้ง)"))
                    return False
            time.sleep(1.0)
        ok = completed and fresh_bit()
        if not ok:
            self.log_queue.put(("log", "[X] เกินเวลารอ build (timeout)"))
        return ok

    # ---------------- log + config ----------------
    def log(self, msg):
        self.log_box.insert("end", msg + "\n")
        self.log_box.see("end")

    def _build_error_hint(self, text):
        """สแกน log ตอน build ล้มเหลว แล้วคืนคำอธิบายภาษาไทยเข้าใจง่าย (หรือ None)
        เด็ก ๆ จะได้รู้ว่าผิดตรงไหน/แก้ยังไง แทนที่จะเห็นแต่ error อังกฤษของ Xilinx
        (ตาราง _ERROR_HINTS ตรวจสอบด้วย workflow เทียบ log จริงแล้วว่าเด้งถูกตัว
        และไม่ false-positive กับ build ที่สำเร็จ)"""
        if not text:
            return None
        hint = None
        for rgx, msg in _ERROR_HINTS:      # เรียงเฉพาะเจาะจงก่อน - ตัวแรกที่ match ชนะ
            try:
                if re.search(rgx, text):
                    hint = msg
                    break
            except re.error:
                continue
        if hint is None:
            return None
        # ดึงเลขบรรทัดของ "ไฟล์นักศึกษา" จากบรรทัด ERROR เท่านั้น (ข้าม INFO ที่ชี้ไป
        # ไฟล์ไลบรารีมาตรฐาน เช่น standard.vhd/std_1164.vhd ซึ่งไม่ใช่โค้ดของเขา)
        libs = ("standard.vhd", "std_1164.vhd", "numeric_std.vhd",
                "std_logic_arith.vhd", "std_logic_unsigned.vhd",
                "std_logic_signed.vhd", "textio.vhd", "vcomponents.vhd")
        nums = []
        for ln in text.splitlines():
            if "ERROR" not in ln:
                continue
            hits = re.findall(r'([^\s\[\]"\']+\.vhdl?):(\d+)', ln, re.I)   # Vivado file.vhd:NN
            if hits:
                for path, num in hits:
                    if not path.lower().endswith(libs):
                        nums.append(int(num))
            else:
                nums += [int(n) for n in re.findall(r'\bLine (\d+)', ln)]  # ISE "file" Line NN
        if nums:
            uniq = sorted(set(nums))[:15]
            shown = ", ".join(str(n) for n in uniq)
            hint += "\n   → จุดที่ต้องแก้อยู่ราว ๆ บรรทัด " + shown + " ในไฟล์โค้ดของคุณ"
        return hint

    def _drain_log(self):
        try:
            while True:
                kind, payload = self.log_queue.get_nowait()
                if kind == "log":
                    self.log(payload)
                elif kind == "ok":
                    self.log("✔ " + payload)
                    self.status.config(text=payload, foreground="green")
                elif kind == "err":
                    self.log("[X] " + payload)
                    self.status.config(text="ล้มเหลว", foreground="red")
                elif kind == "hint":
                    # คำอธิบาย error ภาษาไทย - โชว์เด่น ๆ ใน log + เด้ง popup
                    # ให้เห็นแน่ ๆ (นักศึกษามักไม่อ่าน log อังกฤษยาว ๆ)
                    self.log("─" * 56)
                    self.log("💡 " + payload)
                    self.log("─" * 56)
                    messagebox.showwarning("build ไม่สำเร็จ - สาเหตุที่น่าจะเป็น", payload)
                elif kind == "call":
                    try:
                        payload()
                    except Exception:
                        pass
                elif kind == "usbfix":
                    self._driver_help()
                elif kind == "done":
                    # เมิน 'done' ของ worker ที่ตกรุ่น (ถูกสั่งหยุด/มีงานใหม่มาแทนไปแล้ว)
                    # ไม่งั้นมันจะปลดล็อก/รีเซ็ตสถานะทับงานปัจจุบันผิดจังหวะ
                    if payload is None or payload == self._busy_gen:
                        self._busy = False
                        self._sched_active = False
                        for b in self._action_buttons():
                            b.config(state="normal")
        except queue.Empty:
            pass
        self.after(120, self._drain_log)

    # ---------------- ตัวช่วยตั้งไดรเวอร์ USB (FT2232 -> WinUSB) ----------------
    def _driver_paths(self):
        zadig = os.path.join(PROJECT_DIR, "tools", "zadig.exe")
        inf = os.path.join(PROJECT_DIR, "tools", "ft2232_winusb",
                           "dual_rs232-hs_(interface_0).inf")
        return zadig, inf

    def _driver_help(self):
        """เด้งเมื่อ openFPGALoader เปิดบอร์ดไม่ได้ (ไดรเวอร์ interface 0 ไม่ใช่ WinUSB)
        มักเกิดเมื่อสลับบอร์ด/เสียบพอร์ต USB ใหม่ บนเครื่องที่มีไดรเวอร์ FTDI อยู่
        (วิธีที่ได้ผลจริงคือ Zadig เพราะ force ทับ FTDI ได้ - pnputil ทับไม่ได้)"""
        zadig, inf = self._driver_paths()
        NW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

        dlg = tk.Toplevel(self)
        dlg.title("ตั้งไดรเวอร์ USB สำหรับ JTAG")
        dlg.resizable(False, False)
        dlg.grab_set()
        ttk.Label(dlg, text="เปิดบอร์ดไม่ได้ (unable to open ftdi device)",
                  font=("Segoe UI", 11, "bold"), foreground="red").pack(padx=16, pady=(14, 6))
        ttk.Label(dlg, justify="left", text=(
            "บอร์ดนี้ยังไม่ได้ตั้งไดรเวอร์ JTAG (Interface 0) เป็น WinUSB\n"
            "จึงเปิดผ่าน openFPGALoader ไม่ได้\n\n"
            "ทำไมสลับบอร์ดแล้วต้องตั้งใหม่: ไดรเวอร์ผูกกับ FT2232 แต่ละตัว\n"
            "(serial ต่างกัน)/แต่ละพอร์ต USB → ตั้ง WinUSB 'ครั้งเดียวต่อบอร์ด'\n"
            "แล้วมันจะจำไว้ (เสียบพอร์ตเดิมไม่ต้องตั้งซ้ำ)")
        ).pack(padx=16, pady=(0, 10))

        def do_auto():
            self._driver_auto_install(dlg)

        def do_zadig():
            if not os.path.exists(zadig):
                messagebox.showwarning("ไม่พบ Zadig", f"ไม่พบไฟล์:\n{zadig}")
                return
            try:
                subprocess.Popen([zadig], creationflags=NW)
            except Exception as e:
                messagebox.showerror("เปิด Zadig ไม่ได้", str(e))
                return
            messagebox.showinfo(
                "วิธีตั้งไดรเวอร์ใน Zadig",
                "ในหน้าต่าง Zadig ที่เพิ่งเปิด:\n\n"
                "1) เมนู Options → ติ๊ก 'List All Devices'\n"
                "2) ช่องบนสุด เลือกอุปกรณ์ที่ลงท้าย '(Interface 0)'\n"
                "     ⚠️ ต้องเป็น Interface 0 เท่านั้น (อย่าเลือก Interface 1)\n"
                "3) ช่องไดรเวอร์ (ลูกศรขวา) เลือก 'WinUSB'\n"
                "4) กดปุ่ม 'Replace Driver' รอจนเสร็จ\n"
                "5) ปิด Zadig → กด 'ตรวจหาสาย/ชิป (detect)' อีกครั้ง")
            dlg.destroy()

        tk.Button(dlg, command=do_auto, font=("Segoe UI", 10, "bold"),
                  text="ติดตั้งไดรเวอร์อัตโนมัติ  (แนะนำ - จะขอสิทธิ์ admin)"
                  ).pack(fill="x", padx=16, pady=(4, 2), ipady=6)
        tk.Button(dlg, command=do_zadig,
                  text="หรือ เปิด Zadig ตั้งเอง  (Interface 0 → WinUSB)"
                  ).pack(fill="x", padx=16, pady=(0, 4), ipady=3)
        ttk.Label(dlg, foreground="gray", justify="left", text=(
            "ถ้ายังเปิดไม่ได้หลังตั้ง WinUSB แล้ว ให้เช็ค:\n"
            "• ปิด serial monitor / โปรแกรมที่เปิดพอร์ต COM ของบอร์ดอยู่\n"
            "• อย่าเปิด openFPGALoader ค้างหลายตัว (ปิดตัวเก่าก่อน)")
        ).pack(padx=16, pady=(6, 8))
        ttk.Button(dlg, text="ปิด", command=dlg.destroy).pack(pady=(0, 12))

        dlg.update_idletasks()
        x = self.winfo_x() + (self.winfo_width() - dlg.winfo_width()) // 2
        y = self.winfo_y() + (self.winfo_height() - dlg.winfo_height()) // 2
        dlg.geometry(f"+{max(x,0)}+{max(y,0)}")

    def _driver_auto_install(self, dlg=None):
        """ติดตั้ง WinUSB ให้ FT2232 Interface 0 อัตโนมัติ (force ทับ FTDIBUS แบบ
        เดียวกับ Zadig: pnputil /add-driver เข้า store แล้วเรียก Windows API
        UpdateDriverForPlugAndPlayDevices พร้อม INSTALLFLAG_FORCE) ต้องยกระดับ admin.
        hardware id USB\\VID_0403&PID_6010&MI_00 ครอบคลุม FT2232 ทุกบอร์ด"""
        zadig, inf = self._driver_paths()
        if not os.path.exists(inf):
            messagebox.showwarning("ไม่พบไฟล์ไดรเวอร์",
                                   f"ไม่พบ:\n{inf}\nลองใช้ Zadig แทน")
            return
        if self._busy:
            messagebox.showwarning("กำลังทำงานอยู่",
                                   "มีงานกำลังรันอยู่ รอให้เสร็จก่อนค่อยตั้งไดรเวอร์")
            return
        NW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        # ไฟล์ .cat (catalog เซ็นด้วย cert self-signed ของ libwdi) อยู่ข้าง ๆ inf
        import glob as _glob
        cats = _glob.glob(os.path.join(os.path.dirname(inf), "*.cat"))
        cat = cats[0] if cats else ""
        ps1 = os.path.join(PROJECT_DIR, "_winusb_install.ps1")
        resf = os.path.join(PROJECT_DIR, "_winusb_result.txt")
        try:
            if os.path.exists(resf):
                os.remove(resf)
        except OSError:
            pass

        def psq(s):   # PowerShell single-quote literal (กัน $ expand + ช่องว่าง; escape ')
            return "'" + str(s).replace("'", "''") + "'"

        # ขั้นสำคัญที่ Zadig ทำแต่ pnputil ไม่ทำ: ติดตั้ง cert ของ libwdi เข้า
        # TrustedPublisher + Root ก่อน มิฉะนั้นเครื่องที่ไม่เคยรัน Zadig จะไม่ trust
        # catalog -> pnputil/UpdateDriver ล้มเงียบ (นักศึกษาเลยต้องใช้ Zadig เอง)
        lines = [
            '$ErrorActionPreference = "Continue"',
            f'$inf = {psq(inf)}',
            f'$cat = {psq(cat)}',
            f'$res = {psq(resf)}',
            '$log = @()',
            'if ($cat -and (Test-Path $cat)) {',
            '  try {',
            '    $c = (Get-AuthenticodeSignature $cat).SignerCertificate',
            '    if ($c) {',
            '      foreach ($st in @("TrustedPublisher","Root")) {',
            '        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($st,"LocalMachine")',
            '        $store.Open("ReadWrite"); $store.Add($c); $store.Close()',
            '      }',
            '      $log += "cert-ok"',
            '    } else { $log += "no-cert" }',
            '  } catch { $log += ("cert-err:" + $_.Exception.Message) }',
            '}',
            'try {',
            '  pnputil /add-driver "$inf" /install | Out-Null',
            '  Add-Type @"',
            'using System; using System.Runtime.InteropServices;',
            'public class Drv { [DllImport("newdev.dll",CharSet=CharSet.Unicode,SetLastError=true)]',
            ' public static extern bool UpdateDriverForPlugAndPlayDevices(IntPtr h,string i,string f,uint fl,out bool r); }',
            '"@',
            '  $rb = $false',
            '  $ok = [Drv]::UpdateDriverForPlugAndPlayDevices([IntPtr]::Zero,"USB\\VID_0403&PID_6010&MI_00",$inf,1,[ref]$rb)',
            '  # restart อุปกรณ์ FT2232 (composite) ให้ binding WinUSB มีผลทันที ผู้ใช้',
            '  # ไม่ต้องถอด-เสียบ USB เอง (UpdateDriver อาจตั้ง "ต้อง replug ก่อนมีผล"',
            '  # แล้วคืน true -> เดิมรายงานสำเร็จทั้งที่ device ยังเป็น FTDIBUS)',
            '  $parent = Get-PnpDevice -PresentOnly -EA SilentlyContinue | Where-Object { $_.InstanceId -match "VID_0403&PID_6010" -and $_.InstanceId -notmatch "MI_" } | Select-Object -First 1',
            '  if ($parent) {',
            '    Disable-PnpDevice -InstanceId $parent.InstanceId -Confirm:$false -EA SilentlyContinue',
            '    Start-Sleep -Milliseconds 1500',
            '    Enable-PnpDevice -InstanceId $parent.InstanceId -Confirm:$false -EA SilentlyContinue',
            '    Start-Sleep -Milliseconds 2500',
            '  }',
            '  # verify จริงว่า Interface 0 เป็น WinUSB แล้ว (อย่าเชื่อแค่ return code)',
            '  $svc = ""',
            '  $mi0 = Get-PnpDevice -PresentOnly -EA SilentlyContinue | Where-Object { $_.InstanceId -match "VID_0403&PID_6010&MI_00" } | Select-Object -First 1',
            '  if ($mi0) { $svc = (Get-PnpDeviceProperty -InstanceId $mi0.InstanceId -KeyName "DEVPKEY_Device_Service" -EA SilentlyContinue).Data }',
            '  if ($svc -eq "WinUSB") { Set-Content $res ("OK-WINUSB " + ($log -join ";")) }',
            '  elseif ($ok) { Set-Content $res ("OK-STORE svc=[" + $svc + "] " + ($log -join ";")) }',
            '  else { Set-Content $res ("FAIL " + [Runtime.InteropServices.Marshal]::GetLastWin32Error() + " " + ($log -join ";")) }',
            '} catch { Set-Content $res ("ERR " + $_.Exception.Message + " " + ($log -join ";")) }',
        ]
        ps = "\r\n".join(lines) + "\r\n"
        try:
            # utf-8-sig: PowerShell 5.1 อ่านไฟล์ BOM-less เป็น ANSI - ต้องมี BOM
            # ถึงจะอ่าน path ภาษาไทยใน $inf ได้ถูก
            with open(ps1, "w", encoding="utf-8-sig") as f:
                f.write(ps)
        except Exception as e:
            messagebox.showerror("ผิดพลาด", f"เขียนสคริปต์ไม่ได้: {e}")
            return
        if dlg is not None:
            try:
                dlg.destroy()
            except Exception:
                pass
        # ห้าม block Tk main thread (UAC อาจค้างเป็นนาที GUI จะขึ้น Not Responding
        # และข้อความแนะนำใน log ไม่ถูกวาด) -> รันใน thread แล้วรายงานผ่าน log_queue
        self._busy = True
        self._cancel = False
        self._busy_gen += 1
        gen = self._busy_gen
        for b in self._action_buttons():
            b.config(state="disabled")
        self.status.config(text="กำลังติดตั้งไดรเวอร์... (ดูหน้าต่างขอสิทธิ์ admin)",
                           foreground="orange")
        self.log("กำลังติดตั้งไดรเวอร์ WinUSB - คลิก Yes ที่หน้าต่างขอสิทธิ์ admin...")
        # -File ต้องครอบ quote เอง: Start-Process ต่อ -ArgumentList ด้วยช่องว่าง
        # โดยไม่ใส่ quote ให้ - path ที่มีช่องว่าง (เช่น 'New folder') จะขาดกลาง
        launch = ("Start-Process powershell -Verb RunAs -Wait -ArgumentList "
                  "'-NoProfile','-ExecutionPolicy','Bypass','-File','\"{}\"'").format(ps1)

        def worker():
            err = None
            try:
                subprocess.run(["powershell", "-NoProfile", "-Command", launch],
                               creationflags=NW, timeout=600)
            except Exception as e:
                err = e
            result = ""
            try:
                with open(resf, "r", encoding="utf-8", errors="replace") as f:
                    result = f.read().strip()
            except OSError:
                pass

            def report():
                if result.startswith("OK-WINUSB"):
                    # ยืนยันจริงว่า Interface 0 = WinUSB แล้ว
                    self.log("ติดตั้งไดรเวอร์ WinUSB สำเร็จ + ยืนยันแล้ว (Interface 0 = WinUSB)")
                    self.status.config(text="ตั้งไดรเวอร์สำเร็จ", foreground="green")
                    messagebox.showinfo("สำเร็จ",
                                        "ตั้งไดรเวอร์ WinUSB ให้ Interface 0 แล้ว ✓ (ยืนยันแล้ว)\n\n"
                                        "กด 'ตรวจหาสาย/ชิป (detect)' หรือ Program ได้เลย")
                elif result.startswith("OK-STORE"):
                    # ติดตั้งเข้าระบบสำเร็จ แต่ device ยังไม่สลับเป็น WinUSB
                    # (บอร์ดไม่ได้เสียบตอนติดตั้ง หรือ Windows ต้องการให้ replug)
                    # -> นี่คือเคส "ติดตั้งสำเร็จแต่ Program หาไม่เจอ"
                    self.log(f"ติดตั้งไดรเวอร์เข้าระบบแล้ว แต่บอร์ดยังไม่สลับเป็น WinUSB ({result})")
                    self.status.config(text="ติดตั้งแล้ว - ต้องถอด/เสียบ USB", foreground="orange")
                    messagebox.showwarning(
                        "ติดตั้งแล้ว - รบกวนถอด/เสียบสาย USB",
                        "ติดตั้งไดรเวอร์ WinUSB เข้าระบบแล้ว ✓\n"
                        "แต่บอร์ดยังไม่สลับมาใช้ WinUSB\n\n"
                        "ให้ทำตามนี้:\n"
                        "1) เช็คว่าบอร์ดเสียบสาย USB + เปิดไฟอยู่\n"
                        "2) ถอดสาย USB ของบอร์ดออก แล้วเสียบกลับ 1 ครั้ง\n"
                        "3) กด 'ตรวจหาสาย/ชิป (detect)' อีกครั้ง\n\n"
                        "(ครั้งต่อไปถ้าเสียบบอร์ดไว้ตอนกดติดตั้ง จะสลับให้อัตโนมัติ)")
                else:
                    detail = result or (f"{err}" if err else "(ไม่มีผล - อาจกด No ที่ UAC)")
                    self.log(f"ติดตั้งไดรเวอร์ไม่สำเร็จ: {detail}")
                    self.status.config(text="ตั้งไดรเวอร์ไม่สำเร็จ", foreground="red")
                    messagebox.showwarning("ยังไม่สำเร็จ",
                                           f"ผลลัพธ์: {detail}\n\n"
                                           "ลองกดใหม่ หรือใช้ปุ่ม Zadig ตั้งเอง")
                for p in (ps1, resf):
                    try:
                        os.remove(p)
                    except OSError:
                        pass

            self.log_queue.put(("call", report))
            self.log_queue.put(("done", gen))

        threading.Thread(target=worker, daemon=True).start()

    def _save_config(self):
        data = {
            "board": self.board_key,
            "ise": self.var_ise.get(),
            "vivado": self.var_vivado.get(),
            "ofl": self.var_ofl.get(), "cable": self.var_cable.get(),
            "vhdl": self.vhdl_files,
            "part": self.var_part.get(), "speed": self.var_speed.get(),
            "pkg": self.var_pkg.get(), "top": self.var_top.get(),
            "period": self.var_period.get(), "clk": self.var_clkname.get(),
            "pins": [[self.tree.set(it, c) for c in ("signal", "loc", "io", "extra")]
                     for it in self.tree.get_children()],
        }
        try:
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    def _load_config(self):
        if not os.path.exists(CONFIG_FILE):
            return
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return
        self.var_ise.set(data.get("ise", DEFAULT_ISE_SETTINGS))
        # ถ้ามี ISE ที่ bundle มาในชุด ให้ใช้ตัวนั้นเสมอ (เป็นตัวหลัก - กัน config เก่าชี้ C:\Xilinx)
        if os.path.exists(_bundled_ise):
            self.var_ise.set(_bundled_ise)
        self.var_vivado.set(data.get("vivado", find_vivado()))
        # เช่นเดียวกับ Vivado ที่ bundle มา (tools\vivado_min) - ใช้ก่อนตัวติดตั้งเต็ม
        import glob as _glob
        _bv = _glob.glob(os.path.join(PROJECT_DIR, "tools", "vivado_min", "*", "Vivado", "bin", "vivado.bat"))
        if _bv:
            self.var_vivado.set(sorted(_bv)[-1])
        self.var_ofl.set(data.get("ofl", DEFAULT_OFL))
        # เช่นเดียวกับ openFPGALoader ที่ bundle มา
        if os.path.exists(_bundled_ofl):
            self.var_ofl.set(_bundled_ofl)
        # ค่าที่เซฟไว้เป็น path เต็มของ "เครื่องที่เคยใช้" - ถ้าไฟล์ไม่มีจริงบนเครื่องนี้
        # (ก๊อปโฟลเดอร์ข้ามเครื่อง / config ติดมากับ zip / ย้ายที่วางโปรแกรม) อย่าเก็บ
        # path ตายไว้ ให้ค้นหาใหม่เอง ไม่งั้นนักศึกษาจะเจอ "ไม่พบไฟล์ <path เครื่องอื่น>"
        if not os.path.exists(self.var_ofl.get().strip()):
            self._resolve_ofl(quiet=True)
        if not os.path.exists(self.var_vivado.get().strip()):
            self.var_vivado.set(find_vivado())
        if not os.path.exists(self.var_ise.get().strip()):
            self.var_ise.set(DEFAULT_ISE_SETTINGS)
        self.var_cable.set(data.get("cable", "ft2232"))
        self.vhdl_files = [p for p in data.get("vhdl", []) if os.path.exists(p)]
        self._refresh_vhdl()
        self.apply_board(data.get("board", "apex"))   # ตั้งโปรไฟล์บอร์ดก่อน แล้วค่อย override ด้วยค่าที่เซฟไว้
        self.var_part.set(data.get("part", "xc6slx9"))
        self.var_speed.set(data.get("speed", "-2"))
        self.var_pkg.set(data.get("pkg", "tqg144"))
        self.var_top.set(data.get("top", "top"))
        self.var_period.set(data.get("period", "20"))
        self.var_clkname.set(data.get("clk", "clk"))
        for row in data.get("pins", []):
            self._add_pin_row(*(row + [""] * (4 - len(row)))[:4])

    def destroy(self):
        self._save_config()
        if getattr(self, "_sched_active", False):
            # ปิดแอปกลาง Vivado build: หยุด process ที่รันผ่าน Task Scheduler
            # ไม่ให้ค้างเป็น orphan แอบเขียน build/ ต่อหลังแอปปิด
            self._cancel = True
            try:
                self._kill_sched_build()
                subprocess.run(["schtasks", "/delete", "/tn",
                                "FPGA_Builder_VivadoBuild", "/f"],
                               creationflags=(subprocess.CREATE_NO_WINDOW
                                              if os.name == "nt" else 0),
                               capture_output=True, timeout=20)
            except Exception:
                pass
        super().destroy()


if __name__ == "__main__":
    app = FPGABuilder()
    app.mainloop()
