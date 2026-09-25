# FPGA Board Reference — EDGE Spartan-7 (primary) and Apex Spartan-6

Extracted verbatim from `FPGA_Builder_Package/source/fpga_builder.py` (all `file:line`
refs below are against that file, ~2126 lines). This GUI (Thai strings, English
identifiers) drives VHDL -> .bit for two student boards; the `BOARDS` dict at
`fpga_builder.py:141-156` is the single source of truth for both. Nothing here is
invented — every pin/value is copied from the source.

---

## 1. EDGE Spartan-7 (xc7s15 / ftgb196) — PRIMARY TARGET

### 1.1 Chip / toolchain (`fpga_builder.py:149-155`)

```python
"edge": {
    "label": "EDGE Spartan-7 (XC7S15) - build ด้วย Vivado",
    "part": "xc7s15", "speed": "-1", "pkg": "ftgb196",
    "pins": _PIN_DESC_EDGE,
    "clk": "clk", "period": "20",       # OSC 50MHz = 20ns
    "tool": "vivado",
},
```

- **Part**: `xc7s15` — **Package**: `ftgb196` — **Speed grade**: `-1`
- Full device string used for Vivado `synth_design -part`: `xc7s15ftgb196-1`
  (built at `fpga_builder.py:981`, format `part+pkg+speed`; note the *general*
  helper `_device_string()` at `fpga_builder.py:903-904` instead concatenates
  `part+speed-pkg` i.e. `xc7s15-1-ftgb196` — that variant is only used for the
  ISE `.xst -p` line, not for Vivado, so it doesn't apply to EDGE builds)
- **Toolchain**: Vivado (`tool: "vivado"`), driven via a generated `build.tcl`
  batch script (`_write_vivado_files`, `fpga_builder.py:951-1013` and beyond)
- Vivado is invoked in batch/no-GUI mode; `config_webtalk -install off` is
  disabled to avoid phone-home stalls (`fpga_builder.py:988`)
- Vivado is located by `find_vivado()` (`fpga_builder.py:159-173`), preferring a
  bundled minimal install at `tools\vivado_min\*\Vivado\bin\vivado.bat`, falling
  back to common full-install paths (`D:\Vivado`, `C:\Xilinx\Vivado`, etc.)

### 1.2 Complete EDGE pin map (`_PIN_DESC_EDGE`, `fpga_builder.py:86-131`)

Source comments (translated): pin numbering follows the printed board silkscreen
which skips the numbers used by pushbuttons; **SW1 = the board's own FPGA reset
button** and **SW3 = power-source-select switch** — neither is a usable I/O pin
and neither appears in this table (see §1.5, "reserved pins"). LEDs D2–D17 need
jumpers J4/J9 set to GND to be enabled; the first LED row shares pins with LCD
data lines, the second row shares pins with 7-segment segments.

| Pin (LOC) | Signal name (exact, as in source) | Category |
|---|---|---|
| H11 | OSC 50MHz | Clock |
| K11 | SW2 | Slide Switch |
| M11 | SW4 | Slide Switch |
| N14 | SW5 | Slide Switch |
| P12 | SW6 | Slide Switch |
| N10 | SW7 | Slide Switch |
| P10 | SW8 | Slide Switch |
| M10 | SW9 | Slide Switch |
| N4 | SW10 | Slide Switch |
| L2 | SW11 | Slide Switch |
| P3 | SW12 | Slide Switch |
| N1 | SW13 | Slide Switch |
| M2 | SW15 | Slide Switch |
| L1 | SW17 | Slide Switch |
| J3 | SW19 | Slide Switch |
| K3 | SW21 | Slide Switch |
| J1 | SW22 | Slide Switch |
| J14 | SW14 ปุ่มกด (pushbutton) | Push Button |
| J13 | SW16 ปุ่มกด (pushbutton) | Push Button |
| J12 | SW18 ปุ่มกด (pushbutton) | Push Button |
| J11 | SW20 ปุ่มกด (pushbutton) | Push Button |
| L13 | SW23 ปุ่มกด (pushbutton) | Push Button |
| K12 | LED D2/LCD_D7 | LED (shared w/ LCD data) |
| M12 | LED D3/LCD_D6 | LED (shared w/ LCD data) |
| M14 | LED D4/LCD_D5 | LED (shared w/ LCD data) |
| P13 | LED D5/LCD_D4 | LED (shared w/ LCD data) |
| N11 | LED D6/LCD_D3 | LED (shared w/ LCD data) |
| P11 | LED D7/LCD_D2 | LED (shared w/ LCD data) |
| L5 | LED D8/LCD_D1 | LED (shared w/ LCD data) |
| M4 | LED D9/LCD_D0 | LED (shared w/ LCD data) |
| L3 | LED D10/SEG_A | LED (shared w/ 7-Seg) |
| P4 | LED D11/SEG_B | LED (shared w/ 7-Seg) |
| P2 | LED D12/SEG_C | LED (shared w/ 7-Seg) |
| M3 | LED D13/SEG_D | LED (shared w/ 7-Seg) |
| M1 | LED D14/SEG_E | LED (shared w/ 7-Seg) |
| J4 | LED D15/SEG_F | LED (shared w/ 7-Seg) |
| K4 | LED D16/SEG_G | LED (shared w/ 7-Seg) |
| J2 | LED D17/SEG_DP | LED (shared w/ 7-Seg) |
| H4 | DIGIT1 | 7-Segment (digit enable, active-low, common anode) |
| H3 | DIGIT2 | 7-Segment (digit enable, active-low, common anode) |
| H2 | DIGIT3 | 7-Segment (digit enable, active-low, common anode) |
| H1 | DIGIT4 | 7-Segment (digit enable, active-low, common anode) |
| P5 | LCD_EN | LCD control (R/W tied permanently to GND, not brought out) |
| M5 | LCD_RS | LCD control |
| B14 | BUZZER | Buzzer |
| F2 | UART_TXD | UART |
| G1 | UART_RXD | UART |
| A12 | WIFI_TXD | WiFi (module side TXD/RXD naming per manual) |
| A10 | WIFI_RXD | WiFi |
| F3 | BT_TXD | Bluetooth |
| D4 | BT_RXD | Bluetooth |
| A13 | AUDIO_L | Audio |
| B13 | AUDIO_R | Audio |
| E11 | PS2_CLOCK | PS2 |
| C12 | PS2_DATA | PS2 |
| D1 | ADC_SCK | ADC (SPI, MCP3208; CH6=LDR, CH7=LM35) |
| F4 | ADC_CS | ADC |
| G4 | ADC_DIN | ADC |
| C1 | ADC_DOUT | ADC |
| F1 | DAC_SCK | DAC (SPI, MCP4921) |
| D2 | DAC_CS | DAC |
| E2 | DAC_DIN | DAC |
| C4 | VGA_HSYNC | VGA |
| E4 | VGA_VSYNC | VGA |
| B6 | VGA_RED0 | VGA (12-bit, 4 bits/channel) |
| D3 | VGA_RED1 | VGA |
| C3 | VGA_RED2 | VGA |
| A4 | VGA_RED3 | VGA |
| A3 | VGA_GRN0 | VGA |
| B3 | VGA_GRN1 | VGA |
| A2 | VGA_GRN2 | VGA |
| B5 | VGA_GRN3 | VGA |
| A5 | VGA_BLU0 | VGA |
| B2 | VGA_BLU1 | VGA |
| B1 | VGA_BLU2 | VGA |
| C5 | VGA_BLU3 | VGA |
| L14 | J5/CAM_SIOC | Camera (OV7670, expansion J5) |
| M13 | J5/CAM_SIOD | Camera |
| H14 | J5/CAM_VS | Camera |
| H13 | J5/CAM_HREF | Camera |
| F11 | J5/CAM_PCLK | Camera |
| G11 | J5/CAM_XCLK | Camera |
| C14 | J5/CAM_D7 | Camera |
| D14 | J5/CAM_D6 | Camera |
| E13 | J5/CAM_D5 | Camera |
| F13 | J5/CAM_D4 | Camera |
| F14 | J5/CAM_D3 | Camera |
| G14 | J5/CAM_D2 | Camera |
| D13 | J5/CAM_D1 | Camera |
| D12 | J5/CAM_D0 | Camera |
| E12 | J5/CAM_RST | Camera |
| F12 | J5/CAM_PWDN | Camera |

Source note (`fpga_builder.py:124-126`): the OV7670 camera J5 pins above come
from the board's official XDC. The printed manual's own J5 pin table is
explicitly flagged in a source comment as being for the *old Spartan-6* board
revision and is **not valid for this chip** — use the table above instead.

Also noted at `fpga_builder.py:130`: the TFT header on connector J14 reuses
LED pins D2–D6: `CS=K12 RST=M12 A0=M14 SDA=P13 SCK=N11` (same physical pins as
the LED/LCD-data row — one function at a time).

**Counts for EDGE**: 16 slide switches, 5 push buttons, 16 LEDs (8 of which
double as 7-seg segments a–g+dp, 8 of which double as LCD data lines), 4
7-segment digit-enable lines (+ the 8 shared segment lines), 1 clock pin.

### 1.3 IOSTANDARD

- Single IOSTANDARD used throughout: **LVCMOS33**, both as the pin-table default
  (`_add_pin_row(..., io="LVCMOS33", ...)`, `fpga_builder.py:753`) and as the
  fallback when generating XDC (`io = ... or "LVCMOS33"`, `fpga_builder.py:963`).
  Per-row IOSTANDARD is user-editable in the GUI (dropdown sourced from the
  `IOSTANDARDS` list at `fpga_builder.py:46-47`: `LVCMOS33, LVCMOS25, LVCMOS18,
  LVCMOS15, LVTTL, LVDS_25, SSTL18_II, PCI33_3`) but the manual states "LVCMOS33
  ทั้งหมด" (all pins LVCMOS33) and nothing in the source overrides that per bank.
- No per-bank voltage table is present in the source. Two global bitstream
  properties are emitted for every EDGE/Vivado build
  (`fpga_builder.py:978-979`):
  ```tcl
  set_property CFGBVS VCCO [current_design]
  set_property CONFIG_VOLTAGE 3.3 [current_design]
  ```
  These configure the FPGA's own configuration-bank voltage (3.3 V, VCCO-referenced)
  so an unused config pin doesn't trip a DRC — this is a Vivado bitstream-safety
  setting, not per-IO-bank standard data.

### 1.4 Clock

- **Pin**: `H11`, labeled `OSC 50MHz` in the pin table (`fpga_builder.py:90`).
- **Frequency**: 50 MHz. The board profile encodes this as a period, not a
  frequency: `"period": "20"` ns (`fpga_builder.py:153`, comment confirms
  `# OSC 50MHz = 20ns`). 1/20 ns = 50 MHz.
- **Expected VHDL clock signal name**: `"clk": "clk"` (`fpga_builder.py:153`) —
  this is the default value placed in the "clock name" field when the EDGE
  board is selected (`apply_board`, `fpga_builder.py:730`); it is also
  auto-detected from the VHDL top entity's own port names via `analyze_vhdl()`
  (`fpga_builder.py:292-326`, clock-name heuristics at line 319-320: `clk,
  clock, osc, ck, clkin, clk_in, mclk, sysclk, clk50, clk_50, clk100, gclk`, or
  any port containing `clk`/`clock`).
- **XDC clock constraint generated** (`fpga_builder.py:975-976`), only emitted
  if the clock signal name is actually present among the pin-table signals:
  ```tcl
  create_clock -name sys_clk -period 20 [get_ports {clk}]
  ```
- **Clock-pin placement rescue**: if a user routes a clock signal through a
  non-clock-capable pin (e.g. clocking manually off a pushbutton/switch), Vivado
  would normally error with `[Place 30-574]`/`[Place 30-99]` ("IO Clock Placer
  failed"). The generated `build.tcl` walks every `BUFG` cell in the netlist and
  demotes that DRC to a warning automatically (`fpga_builder.py:1001-1013`,
  comment: "ต้องไล่จากตัว BUFG จริงในเน็ตลิสต์ ไม่ใช่เดาชื่อ" — must be found from
  real BUFG cells in the netlist, not guessed by name), so student designs that
  self-clock off a button still build.

### 1.5 Reset / reserved pins

- No dedicated user-reset pin is defined in `_PIN_DESC_EDGE` — it is deliberately
  **excluded** from the pin table:
  - **SW1** = the board's physical FPGA reset button (resets/reconfigures the
    FPGA itself) — comment at `fpga_builder.py:88`: `SW1 = ปุ่ม Reset FPGA`.
    It is not wired to user fabric and cannot be assigned to a VHDL port.
  - **SW3** = power-source-select switch (external vs USB power), also not an
    I/O — comment: `SW3 = สวิตช์เลือกแหล่งไฟ (ไม่ใช่ I/O)`.
  - Because the on-board switch numbering (`SW0..SW23`) skips the pushbutton
    positions, the visible switch list in the pin table jumps `SW2, SW4, SW5,
    SW6, SW7, SW8, SW9, SW10, SW11, SW12, SW13, SW15, SW17, SW19, SW21, SW22`
    (16 switches) — `SW1, SW3` (reset/power-select, excluded above) and
    `SW14/16/18/20/23` (routed instead as the 5 pushbuttons) are the "missing"
    numbers.
- LCD `R/W` line is permanently tied to GND on the board and is not broken out
  as a controllable pin (`fpga_builder.py:109`).
- Pushbuttons are active-high per source comment: "ปกติ=0 กดแล้ว=1" (normally 0,
  pressed = 1) (`fpga_builder.py:96`).

### 1.6 Programming details

- **Loader tool**: `openFPGALoader.exe`, bundled at
  `tools\openFPGALoader\openFPGALoader.exe`, resolved by `_resolve_ofl()`
  (`fpga_builder.py:1227-1255`); MSYS2-built fallback path is
  `C:\msys64\mingw64\bin\openFPGALoader.exe` (`fpga_builder.py:196`).
- **Cable**: default `ft2232` (`self.var_cable = tk.StringVar(value="ft2232")`,
  `fpga_builder.py:599`; also the saved-config default at `fpga_builder.py:2093`).
  Full selectable cable list (`OFL_CABLES`, `fpga_builder.py:198-199`):
  `ft2232, digilent, digilent_hs2, digilent_hs3, ft232, ft231X, ft4232,
  bus_blaster, jlink, cmsisdap, dirtyJtag`.
  The packaged manual additionally notes (for Zadig/WinUSB driver setup) that the
  EDGE Spartan-7 board enumerates as **"Digilent USB Device (Interface 0)"**
  (Spartan-6 enumerates as "Dual RS232-HS") — both are FT2232-family JTAG
  bridges, hence the shared `ft2232` cable default.
- **Detect command**: `"<ofl>" -c <cable> --detect` (`fpga_builder.py:1171`).
- **SRAM (volatile) load** — "Normal Rom (Fast - Temporary)":
  ```
  "<ofl>" -c <cable> -m "<bit>"
  ```
  (`fpga_builder.py:1318`; `-m` = load into SRAM, lost on power-off.)
- **Flash/PROM (permanent) write** — "PROM Rom (Slow - Permanent)":
  ```
  "<ofl>" -c <cable> -f -B "<spiOverJtag_bridge.bit>" "<bit>"
  ```
  (`fpga_builder.py:1332`; `-f` = write to SPI flash, `-B` = explicit
  spiOverJtag bridge bitstream, required because the default bridge path baked
  into the openFPGALoader build only resolves inside an MSYS2 tree.)
  Manual (`อ่านก่อนใช้งาน.txt:106`) names the actual flash chip: **M25P80** SPI
  PROM.
- **spiOverJtag bridge filename** (`_find_spioverjtag`, `fpga_builder.py:1174-1187`):
  ```python
  name = f"spiOverJtag_{self.var_part.get()}{self.var_pkg.get()}.bit"
  ```
  For EDGE this evaluates to **`spiOverJtag_xc7s15ftgb196.bit`**. Search order:
  next to the chosen `openFPGALoader.exe`, then
  `tools\openFPGALoader\spiOverJtag_xc7s15ftgb196.bit` (the bundled location),
  then `<ofl_dir>\..\share\openFPGALoader\...` (MSYS2 share layout).
- **Part/board-bitstream mismatch guard** (`fpga_builder.py:1268-1286`): before
  programming, the tool reads the `.bit` file header (`parse_bit_header`,
  `fpga_builder.py:207-231`, which parses the Xilinx bitstream header fields
  `design/part/date/time/bitstream_bytes`) and compares the embedded part
  string (e.g. `7s15ftgb196`) against the currently selected board's part, to
  stop a Spartan-6 bitstream from being sent to the Spartan-7 board (or vice
  versa).
- PATH is temporarily prefixed with the openFPGALoader directory before
  invoking flash-write, because that build calls `cygpath` internally
  (`fpga_builder.py:1335-1338`).

### 1.7 How the pin dropdown is generated (reproducible logic)

```python
def _pin_sort_key(p):
    """เรียงพินทั้งแบบ P123 (Spartan-6) และแบบ grid H11/K12 (Spartan-7)"""
    m = re.match(r"([A-Z]+)(\d+)$", p)
    return (m.group(1), int(m.group(2))) if m else (p, 0)

def make_pin_list(desc):
    """สร้างรายการ dropdown จาก pin desc เช่น 'K12  (LED0/LCD_D7)'"""
    return ["{}  ({})".format(p, desc[p]) for p in sorted(desc, key=_pin_sort_key)]

def pin_only(val):
    """'P62  (SW1)' หรือ 'K12  (LED0)' -> เอาเฉพาะชื่อพิน"""
    m = re.match(r"\s*([A-Z]{1,2}\d{1,3})\b", (val or "").strip(), re.I)
    return m.group(1).upper() if m else (val or "").strip()
```
(`fpga_builder.py:134-137, 176-178, 181-184`)

- `BOARDS[board_key]["pins"]` is a flat `dict[pin_str] -> signal_desc_str`
  (`_PIN_DESC_EDGE` or `_PIN_DESC_APEX`).
- `make_pin_list(desc)` sorts the pin keys with `_pin_sort_key` (splits a pin
  like `K12` into `("K", 12)` so it sorts alphabetically by letter-prefix then
  numerically, which works for both the Spartan-6 `P###` style and the
  Spartan-7 grid `A1..P14` style) and formats each as
  `"{pin}  ({signal_desc})"`, e.g. `"A3  (VGA_GRN0)"`, `"B14  (BUZZER)"`,
  `"C12  (PS2_DATA)"` — exactly the dropdown format described in the task.
- This list is what's fed into the pin-editing combobox in the GUI
  (`vals = make_pin_list(self.board["pins"])`, `fpga_builder.py:837`), and
  `_pin_label(pin)` (`fpga_builder.py:706-710`) reconstructs the same
  `"PIN  (desc)"` label from a bare pin string for redisplay.
- When a value is read back out of the combobox, `pin_only(val)` strips the
  `"  (desc)"` suffix with a regex anchored on 1–2 letters + 1–3 digits,
  returning just the bare pin (`"A3"`, `"K12"`, `"P66"`, etc.) for use in the
  generated `.xdc`/`.ucf`.
- **To reproduce this list programmatically** for the EDGE board: take
  `_PIN_DESC_EDGE` (§1.2 table above), sort keys by `(letter_prefix,
  numeric_part)`, and render `f"{pin}  ({signal})"` for each.
- Switching boards (`apply_board`, `fpga_builder.py:719-750`) also **clears any
  previously-entered LOC values** in the pin-assignment table when the board
  actually changes, specifically because the two boards' pin-naming schemes
  collide (e.g. both have a pin literally named `P1`/`P14` etc. at physically
  different meanings) — comment at `fpga_builder.py:732-734` warns that
  silently keeping old LOCs across a board switch could build successfully
  with the *wrong* pin.

---

## 2. Apex Spartan-6 (xc6slx9 / tqg144) — secondary board, for comparison

### 2.1 Chip / toolchain (`fpga_builder.py:142-148`)

```python
"apex": {
    "label": "Apex Surveyor-6 (Spartan-6 XC6SLX9)",
    "part": "xc6slx9", "speed": "-2", "pkg": "tqg144",
    "pins": _PIN_DESC_APEX,
    "clk": "OSC", "period": "50",      # OSC 20MHz = 50ns
    "tool": "ise",
},
```
- **Part**: `xc6slx9` — **Package**: `tqg144` — **Speed**: `-2` — **Toolchain**: ISE 14.7
  (bundled at `tools\ise_min\settings64.bat`, `fpga_builder.py:187-188`)
- Device string for ISE `.xst -p`: `xc6slx9-2-tqg144` (`_device_string()`,
  `fpga_builder.py:903-904`)

### 2.2 Complete Apex pin map (`_PIN_DESC_APEX`, `fpga_builder.py:53-83`)

Source: "จาก Lab0 Pin List" (from the course's Lab0 pin list document).

| Pin (LOC) | Signal name | Category |
|---|---|---|
| P123 | OSC 20MHz | Clock |
| P66 | SW0 | Slide Switch |
| P62 | SW1 | Slide Switch |
| P61 | SW2 | Slide Switch |
| P59 | SW3 | Slide Switch |
| P58 | SW4 | Slide Switch |
| P57 | SW5 | Slide Switch |
| P56 | SW6 | Slide Switch |
| P55 | SW7/PB6 | Slide Switch (shared with a pushbutton function) |
| P82 | L0 | LED (2-state) |
| P81 | L1 | LED |
| P80 | L2 | LED |
| P79 | L3 | LED |
| P78 | L4 | LED |
| P75 | L5 | LED |
| P74 | L6 | LED |
| P67 | L7 | LED |
| P95 | MN0 | Logic monitor (3-state LED) |
| P94 | MN1 | Logic monitor |
| P93 | MN2 | Logic monitor |
| P92 | MN3 | Logic monitor |
| P88 | MN4 | Logic monitor |
| P87 | MN5 | Logic monitor |
| P85 | MN6 | Logic monitor |
| P84 | MN7 | Logic monitor |
| P41 | SEG_A | 7-Segment |
| P40 | SEG_B | 7-Segment |
| P35 | SEG_C | 7-Segment |
| P34 | SEG_D | 7-Segment |
| P32 | SEG_E | 7-Segment |
| P29 | SEG_F | 7-Segment |
| P27 | SEG_G | 7-Segment |
| P26 | SEG_P | 7-Segment (decimal point) |
| P44 | COMMON0 | 7-Segment (digit-select common) |
| P43 | COMMON1 | 7-Segment |
| P33 | COMMON2 | 7-Segment |
| P30 | COMMON3 | 7-Segment |
| P112 | DIP1/K6 | DIP switch (pin shared with expansion K6) |
| P111 | DIP2/K6 | DIP switch |
| P105 | DIP3/K6 | DIP switch |
| P104 | DIP4/K6 | DIP switch |
| P102 | DIP5/K6 | DIP switch |
| P101 | DIP6/K6 | DIP switch |
| P100 | DIP7/K6 | DIP switch |
| P99 | DIP8/K6 | DIP switch |
| P45 | PB1 | Push Button |
| P46 | PB2 | Push Button |
| P47 | PB3 | Push Button |
| P48 | PB4 | Push Button |
| P51 | PB5 | Push Button |
| P50 | VRCLK | other (variable-rate clock / debounced clock input) |
| P98 | TX | UART |
| P97 | RX | UART |
| P83 | BUZZER | Buzzer |
| P64 | FLASH_MOSI | Flash PROM (on-board config flash SPI) |
| P65 | FLASH_MISO | Flash PROM |
| P38 | FLASH_CS | Flash PROM |
| P70 | FLASH_CCLK | Flash PROM |
| P5,P7,P9,P11,P14,P16,P21,P23 | K1 | Expansion connector K1 (8 pins) |
| P6,P8,P10,P12,P15,P17,P22,P24 | K2 | Expansion connector K2 (8 pins) |
| P124,P127,P132,P134,P138,P140,P142,P1 | K3 | Expansion connector K3 (8 pins) |
| P126,P131,P133,P137,P139,P141,P143,P2 | K4 | Expansion connector K4 (8 pins) |
| P114,P115,P116,P117,P118,P119,P120,P121 | K5 | Expansion connector K5 (8 pins) |

**Counts for Apex**: 8 slide switches (1 dual-use as PB6), 8 LEDs, 8 logic-monitor
3-state LEDs, 5 dedicated pushbuttons (+1 shared on SW7), 8 DIP switch lines,
7-segment: 8 segment lines (a–g+dp) + 4 common/digit-select lines, 1 clock pin,
4 flash-PROM SPI pins, 5 expansion headers (K1–K5, 8 pins each = 40 expansion pins).

### 2.3 IOSTANDARD

Same as EDGE: default **LVCMOS33** for every row (`fpga_builder.py:753, 963`);
per-row override available from the same `IOSTANDARDS` list. Manual confirms:
"พินสำคัญบนบอร์ด (LVCMOS33 ทั้งหมด)" — all key board pins are LVCMOS33
(`อ่านก่อนใช้งาน.txt:111`).

### 2.4 Clock

- **Pin**: `P123`, labeled `OSC 20MHz`.
- **Frequency**: 20 MHz → period `50` ns (`"period": "50"`, `fpga_builder.py:146`,
  comment confirms `# OSC 20MHz = 50ns`).
- **Expected VHDL clock signal name**: `"clk": "OSC"` (`fpga_builder.py:146`) —
  i.e. the Apex profile expects the top-level port to literally be named `OSC`
  (unlike EDGE's `clk`).
- UCF timing constraint generated the same way as XDC (`fpga_builder.py:945-947`):
  ```
  NET "OSC" TNM_NET = "OSC";
  TIMESPEC TS_OSC = PERIOD "OSC" 50 ns HIGH 50%;
  ```

### 2.5 Reset / reserved

No dedicated reset pin appears in `_PIN_DESC_APEX`. `P55` is dual-purpose
(`SW7/PB6`) per the pin description string itself — a design cannot use it as
both a switch and a button simultaneously. No jumpers or reserved-pin comments
are documented for this board in the source (contrast with EDGE's SW1/SW3
callouts).

### 2.6 Programming details

Identical mechanism to EDGE (same `openFPGALoader`/cable/SRAM-vs-flash code
path, §1.6) — the board only changes `part`/`pkg` substitution:
- spiOverJtag bridge filename: **`spiOverJtag_xc6slx9tqg144.bit`**
- Manual notes the Zadig driver enumerates as **"Dual RS232-HS"** for this
  board (vs "Digilent USB Device" for EDGE), still under the FT2232 family,
  same default `ft2232` cable setting.
- ISE-specific note: Apex is also programmable the traditional way via iMPACT
  over JTAG per the file's module docstring (`fpga_builder.py:10`), though the
  GUI's "Program FPGA" button path documented in code is the openFPGALoader
  route described above.

### 2.7 Pin dropdown generation

Identical function (`make_pin_list`, §1.7) applied to `_PIN_DESC_APEX` instead.
Because Apex pin names are plain `P<digits>` (matched by `_pin_sort_key`'s
regex as `("P", N)`), the dropdown sorts purely numerically by the digit
portion, e.g. `P1, P2, P5, P6, P7, ... P143`.

---

## 3. Discrepancy: packaged manual (`อ่านก่อนใช้งาน.txt`) vs. source pin data

The manual's pin table, `พินสำคัญบนบอร์ด (LVCMOS33 ทั้งหมด)` at lines 110–118:

```
Slide Switch : SW0=P66 SW1=P62 SW2=P61 SW3=P59 SW4=P58 SW5=P57 SW6=P56 SW7=P55
LED          : L0=P82 L1=P81 L2=P80 L3=P79 L4=P78 L5=P75 L6=P74 L7=P67
Push Button  : PB1=P45 PB2=P46 PB3=P47 PB4=P48 PB5=P51
DIP Switch   : DIP1=P112 ... DIP8=P99
7-Segment    : a=P41 b=P40 c=P35 d=P34 e=P32 f=P29 g=P27
Clock (OSC)  : P123 (20 MHz)
```

**Confirmed: this table is the Apex (Spartan-6, xc6slx9) pinout, not EDGE.**
Every single value (`SW0=P66` ... `Clock P123, 20 MHz`) matches
`_PIN_DESC_APEX` (`fpga_builder.py:53-83`) and the Apex board profile's clock
period (`fpga_builder.py:146`, `20MHz = 50ns`) exactly, character for character.

The manual covers both boards in its setup instructions (§1–5 of the manual
discuss both Apex/ISE and EDGE/Vivado build flows interchangeably), but its
"important pins" quick-reference section **only reproduces the Apex/Spartan-6
`P###`-style numbering** and never lists the EDGE grid-style pins (`A3`,
`B14`, `H11`, etc.) anywhere. A student following only the manual's pin table
while targeting the EDGE board would be using the wrong pinout entirely — the
EDGE board's real pin data only exists in `_PIN_DESC_EDGE` inside
`fpga_builder.py` (§1.2 above) and must be sourced from there (or from the
in-app dropdown, which is populated from the same dict, §1.7).

This is consistent with the task's framing: EDGE (`ftgb196`, a Spartan-7
FTGB196 BGA package) pins are alphanumeric grid coordinates (`A1`–`P14` style),
structurally incompatible with the Apex/Spartan-6 `TQG144` QFP package's
sequential `P1`–`P144` numbering — the two schemes cannot be cross-applied, and
`apply_board()` in the source (`fpga_builder.py:732-734`) explicitly defends
against exactly this mistake by clearing pin assignments on board switch.
