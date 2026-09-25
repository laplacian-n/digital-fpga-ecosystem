
##/ This file is a general .xdc for the EDGE Spartan 7 FPGA board
##/ To use it in a project:
## - comment the lines corresponding to unused pins
## - rename the used ports (in each line, after get_ports) according to the top level signal names in the project

#$ Clock signal
set_property -dict { PACKAGE_PIN H11    IOSTANDARD LVCMOS33 } [get_ports { clk }];

#$ Switches
set_property -dict { PACKAGE_PIN K11    IOSTANDARD LVCMOS33 } [get_ports { sw[0] }];#LSB
set_property -dict { PACKAGE_PIN M11    IOSTANDARD LVCMOS33 } [get_ports { sw[1] }];
set_property -dict { PACKAGE_PIN N14    IOSTANDARD LVCMOS33 } [get_ports { sw[2] }];
set_property -dict { PACKAGE_PIN P12    IOSTANDARD LVCMOS33 } [get_ports { sw[3] }];
set_property -dict { PACKAGE_PIN N10    IOSTANDARD LVCMOS33 } [get_ports { sw[4] }];
set_property -dict { PACKAGE_PIN P10    IOSTANDARD LVCMOS33 } [get_ports { sw[5] }];
set_property -dict { PACKAGE_PIN M10    IOSTANDARD LVCMOS33 } [get_ports { sw[6] }];
set_property -dict { PACKAGE_PIN N4    IOSTANDARD LVCMOS33 } [get_ports { sw[7] }];

set_property -dict { PACKAGE_PIN L2    IOSTANDARD LVCMOS33 } [get_ports { sw[8] }];
set_property -dict { PACKAGE_PIN P3    IOSTANDARD LVCMOS33 } [get_ports { sw[9] }];
set_property -dict { PACKAGE_PIN N1    IOSTANDARD LVCMOS33 } [get_ports { sw[10] }];
set_property -dict { PACKAGE_PIN M2    IOSTANDARD LVCMOS33 } [get_ports { sw[11] }];
set_property -dict { PACKAGE_PIN L1    IOSTANDARD LVCMOS33 } [get_ports { sw[12] }];
set_property -dict { PACKAGE_PIN J3    IOSTANDARD LVCMOS33 } [get_ports { sw[13] }];
set_property -dict { PACKAGE_PIN K3    IOSTANDARD LVCMOS33 } [get_ports { sw[14] }];
set_property -dict { PACKAGE_PIN J1    IOSTANDARD LVCMOS33 } [get_ports { sw[15] }];#MSB

#$ LEDs
set_property -dict { PACKAGE_PIN K12    IOSTANDARD LVCMOS33 } [get_ports { led[0] }];#LSB
set_property -dict { PACKAGE_PIN M12    IOSTANDARD LVCMOS33 } [get_ports { led[1] }];
set_property -dict { PACKAGE_PIN M14    IOSTANDARD LVCMOS33 } [get_ports { led[2] }];
set_property -dict { PACKAGE_PIN P13    IOSTANDARD LVCMOS33 } [get_ports { led[3] }];
set_property -dict { PACKAGE_PIN N11    IOSTANDARD LVCMOS33 } [get_ports { led[4] }];
set_property -dict { PACKAGE_PIN P11    IOSTANDARD LVCMOS33 } [get_ports { led[5] }];
set_property -dict { PACKAGE_PIN L5    IOSTANDARD LVCMOS33 } [get_ports { led[6] }];
set_property -dict { PACKAGE_PIN M4    IOSTANDARD LVCMOS33 } [get_ports { led[7] }];
set_property -dict { PACKAGE_PIN J4    IOSTANDARD LVCMOS33 } [get_ports { led[8] }];
set_property -dict { PACKAGE_PIN L3    IOSTANDARD LVCMOS33 } [get_ports { led[9] }];
set_property -dict { PACKAGE_PIN P4	   IOSTANDARD LVCMOS33 } [get_ports { led[10] }];
set_property -dict { PACKAGE_PIN K4    IOSTANDARD LVCMOS33 } [get_ports { led[11] }];
set_property -dict { PACKAGE_PIN P2    IOSTANDARD LVCMOS33 } [get_ports { led[12] }];
set_property -dict { PACKAGE_PIN J2    IOSTANDARD LVCMOS33 } [get_ports { led[13] }];
set_property -dict { PACKAGE_PIN M3    IOSTANDARD LVCMOS33 } [get_ports { led[14] }];
set_property -dict { PACKAGE_PIN M1    IOSTANDARD LVCMOS33 } [get_ports { led[15] }];#MSB

#$ Push Button
set_property -dict {PACKAGE_PIN J13 IOSTANDARD LVCMOS33 PULLDOWN true} [get_ports {pb[0]}]; #Button-top
set_property -dict {PACKAGE_PIN L13 IOSTANDARD LVCMOS33 PULLDOWN true} [get_ports {pb[1]}]; #Button-bottom
set_property -dict {PACKAGE_PIN J14 IOSTANDARD LVCMOS33 PULLDOWN true} [get_ports {pb[2]}]; #Button-left
set_property -dict {PACKAGE_PIN J11 IOSTANDARD LVCMOS33 PULLDOWN true} [get_ports {pb[3]}]; #Button-right
set_property -dict {PACKAGE_PIN J12 IOSTANDARD LVCMOS33 PULLDOWN true} [get_ports {pb[4]}]; #Button-center

#$ 7-segment display
set_property -dict { PACKAGE_PIN H4    IOSTANDARD LVCMOS33 } [get_ports {digit[0]}]; #LSB
set_property -dict { PACKAGE_PIN H3    IOSTANDARD LVCMOS33 } [get_ports {digit[1]}];
set_property -dict { PACKAGE_PIN H2    IOSTANDARD LVCMOS33 } [get_ports {digit[2]}];
set_property -dict { PACKAGE_PIN H1    IOSTANDARD LVCMOS33 } [get_ports {digit[3]}]; #MSB

set_property -dict { PACKAGE_PIN L3    IOSTANDARD LVCMOS33 } [get_ports {Seven_Segment[7]}];#A
set_property -dict { PACKAGE_PIN P4    IOSTANDARD LVCMOS33 } [get_ports {Seven_Segment[6]}];#B
set_property -dict { PACKAGE_PIN P2    IOSTANDARD LVCMOS33 } [get_ports {Seven_Segment[5]}];#C
set_property -dict { PACKAGE_PIN M3    IOSTANDARD LVCMOS33 } [get_ports {Seven_Segment[4]}];#D
set_property -dict { PACKAGE_PIN M1    IOSTANDARD LVCMOS33 } [get_ports {Seven_Segment[3]}];#E
set_property -dict { PACKAGE_PIN J4    IOSTANDARD LVCMOS33 } [get_ports {Seven_Segment[2]}];#F
set_property -dict { PACKAGE_PIN K4    IOSTANDARD LVCMOS33 } [get_ports {Seven_Segment[1]}];#G
set_property -dict { PACKAGE_PIN J2    IOSTANDARD LVCMOS33 } [get_ports {Seven_Segment[0]}];#DP

#$ 2x16 LCD
set_property -dict { PACKAGE_PIN M4 IOSTANDARD LVCMOS33 } [get_ports {data[0]}];
set_property -dict { PACKAGE_PIN L5 IOSTANDARD LVCMOS33 } [get_ports {data[1]}];
set_property -dict { PACKAGE_PIN P11 IOSTANDARD LVCMOS33 } [get_ports {data[2]}];
set_property -dict { PACKAGE_PIN N11 IOSTANDARD LVCMOS33 } [get_ports {data[3]}];
set_property -dict { PACKAGE_PIN P13 IOSTANDARD LVCMOS33 } [get_ports {data[4]}];
set_property -dict { PACKAGE_PIN M14 IOSTANDARD LVCMOS33 } [get_ports {data[5]}];
set_property -dict { PACKAGE_PIN M12 IOSTANDARD LVCMOS33 } [get_ports {data[6]}];
set_property -dict { PACKAGE_PIN K12 IOSTANDARD LVCMOS33 } [get_ports {data[7]}];
set_property -dict { PACKAGE_PIN P5 IOSTANDARD LVCMOS33 } [get_ports {lcd_e}];
set_property -dict { PACKAGE_PIN M5 IOSTANDARD LVCMOS33 } [get_ports {lcd_rs}];
#*  LCD R/W pin is connected to ground by default.No need to assign LCD R/W Pin.

#$ SPI TFT 1.8 inch
set_property -dict { PACKAGE_PIN N11 IOSTANDARD LVCMOS33 } [get_ports {tft_sck}];
set_property -dict { PACKAGE_PIN P13 IOSTANDARD LVCMOS33 } [get_ports {tft_sdi}];
set_property -dict { PACKAGE_PIN M14 IOSTANDARD LVCMOS33 } [get_ports {tft_dc}];
set_property -dict { PACKAGE_PIN M12 IOSTANDARD LVCMOS33 } [get_ports {tft_reset}];
set_property -dict { PACKAGE_PIN K12 IOSTANDARD LVCMOS33 } [get_ports {tft_cs}];

#$ Buzzer
set_property -dict { PACKAGE_PIN B14 IOSTANDARD LVCMOS33 } [get_ports {Buzzer}];

#$ SPI ADC
set_property -dict { PACKAGE_PIN D1 IOSTANDARD LVCMOS33 } [get_ports {SCK}];
set_property -dict { PACKAGE_PIN F4 IOSTANDARD LVCMOS33 } [get_ports {CS}];
set_property -dict { PACKAGE_PIN G4 IOSTANDARD LVCMOS33 } [get_ports {DIN}];
set_property -dict { PACKAGE_PIN C1 IOSTANDARD LVCMOS33 } [get_ports {DOUT}];

#$ SPI DAC
set_property -dict { PACKAGE_PIN F1 IOSTANDARD LVCMOS33 } [get_ports {SCK}];
set_property -dict { PACKAGE_PIN D2 IOSTANDARD LVCMOS33 } [get_ports {CS}];
set_property -dict { PACKAGE_PIN E2 IOSTANDARD LVCMOS33 } [get_ports {MOSI}];

#$ USB UART
set_property -dict { PACKAGE_PIN F2 IOSTANDARD LVCMOS33 } [get_ports {usb_uart_txd}];
set_property -dict { PACKAGE_PIN G1 IOSTANDARD LVCMOS33 } [get_ports {usb_uart_rxd}];

#$ WiFi
set_property -dict { PACKAGE_PIN A12 IOSTANDARD LVCMOS33 } [get_ports { wifi_txd }];
set_property -dict { PACKAGE_PIN A10 IOSTANDARD LVCMOS33 } [get_ports { wifi_rxd }];

#$ Bluetooth
set_property -dict { PACKAGE_PIN F3 IOSTANDARD LVCMOS33 } [get_ports { Bluetooth_txd }];
set_property -dict { PACKAGE_PIN D4 IOSTANDARD LVCMOS33 } [get_ports { Bluetooth_rxd }];

#$ Audio Jack
set_property -dict { PACKAGE_PIN A13  IOSTANDARD LVCMOS33 } [get_ports { Audio_L }];
set_property -dict { PACKAGE_PIN B13  IOSTANDARD LVCMOS33 } [get_ports { Audio_R }];

#$ USB PS2
set_property -dict { PACKAGE_PIN E11  IOSTANDARD LVCMOS33 } [get_ports { PS2_CLK }];
set_property -dict { PACKAGE_PIN C12  IOSTANDARD LVCMOS33 } [get_ports { PS2_DATA }];

#$ VGA 12-bit
set_property -dict { PACKAGE_PIN C4 IOSTANDARD LVCMOS33 } [get_ports {vga_hsync}];
set_property -dict { PACKAGE_PIN E4 IOSTANDARD LVCMOS33 } [get_ports {vga_vsync}];
set_property -dict { PACKAGE_PIN B6 IOSTANDARD LVCMOS33 } [get_ports {vga_r[0]}];
set_property -dict { PACKAGE_PIN D3 IOSTANDARD LVCMOS33 } [get_ports {vga_r[1]}];
set_property -dict { PACKAGE_PIN C3 IOSTANDARD LVCMOS33 } [get_ports {vga_r[2]}];
set_property -dict { PACKAGE_PIN A4 IOSTANDARD LVCMOS33 } [get_ports {vga_r[3]}];
set_property -dict { PACKAGE_PIN A3 IOSTANDARD LVCMOS33 } [get_ports {vga_g[0]}];
set_property -dict { PACKAGE_PIN B3 IOSTANDARD LVCMOS33 } [get_ports {vga_g[1]}];
set_property -dict { PACKAGE_PIN A2 IOSTANDARD LVCMOS33 } [get_ports {vga_g[2]}];
set_property -dict { PACKAGE_PIN B5 IOSTANDARD LVCMOS33 } [get_ports {vga_g[3]}];
set_property -dict { PACKAGE_PIN A5 IOSTANDARD LVCMOS33 } [get_ports {vga_b[0]}];
set_property -dict { PACKAGE_PIN B2 IOSTANDARD LVCMOS33 } [get_ports {vga_b[1]}];
set_property -dict { PACKAGE_PIN B1 IOSTANDARD LVCMOS33 } [get_ports {vga_b[2]}];
set_property -dict { PACKAGE_PIN C5 IOSTANDARD LVCMOS33 } [get_ports {vga_b[3]}];

#$ CMOS Camera (J5 CONNECTOR)
set_property -dict { PACKAGE_PIN L14 IOSTANDARD LVCMOS33} [get_ports {ov7670_sioc}];
set_property -dict { PACKAGE_PIN M13 IOSTANDARD LVCMOS33} [get_ports {ov7670_siod}];
set_property -dict { PACKAGE_PIN H14 IOSTANDARD LVCMOS33} [get_ports {ov7670_vsync}];
set_property -dict { PACKAGE_PIN H13 IOSTANDARD LVCMOS33} [get_ports {ov7670_href}];
set_property -dict { PACKAGE_PIN F11 IOSTANDARD LVCMOS33} [get_ports {ov7670_pclk}];
set_property -dict { PACKAGE_PIN G11 IOSTANDARD LVCMOS33} [get_ports {ov7670_xclk}];
set_property -dict { PACKAGE_PIN C14 IOSTANDARD LVCMOS33} [get_ports {ov7670_data[7]}];
set_property -dict { PACKAGE_PIN D14 IOSTANDARD LVCMOS33} [get_ports {ov7670_data[6]}];
set_property -dict { PACKAGE_PIN E13 IOSTANDARD LVCMOS33} [get_ports {ov7670_data[5]}];
set_property -dict { PACKAGE_PIN F13 IOSTANDARD LVCMOS33} [get_ports {ov7670_data[4]}];
set_property -dict { PACKAGE_PIN F14 IOSTANDARD LVCMOS33} [get_ports {ov7670_data[3]}];
set_property -dict { PACKAGE_PIN G14 IOSTANDARD LVCMOS33} [get_ports {ov7670_data[2]}];
set_property -dict { PACKAGE_PIN D13 IOSTANDARD LVCMOS33} [get_ports {ov7670_data[1]}];
set_property -dict { PACKAGE_PIN D12 IOSTANDARD LVCMOS33} [get_ports {ov7670_data[0]}];
set_property -dict { PACKAGE_PIN E12 IOSTANDARD LVCMOS33} [get_ports {ov7670_reset}];
set_property -dict { PACKAGE_PIN F12 IOSTANDARD LVCMOS33} [get_ports {ov7670_pwdn}];

#$ 20 pin expansion connector (J5 CONNECTOR)
#* pin1 5V
#* pin2 NC
#* pin3 3V3
#* pin4 GND
set_property -dict { PACKAGE_PIN L14 IOSTANDARD LVCMOS33} [get_ports {pin5}];
set_property -dict { PACKAGE_PIN M13 IOSTANDARD LVCMOS33} [get_ports {pin6}];
set_property -dict { PACKAGE_PIN H14 IOSTANDARD LVCMOS33} [get_ports {pin7}];
set_property -dict { PACKAGE_PIN H13 IOSTANDARD LVCMOS33} [get_ports {pin8}}];
set_property -dict { PACKAGE_PIN F11 IOSTANDARD LVCMOS33} [get_ports {pin9}}];
set_property -dict { PACKAGE_PIN G11 IOSTANDARD LVCMOS33} [get_ports {pin10}];
set_property -dict { PACKAGE_PIN C14 IOSTANDARD LVCMOS33} [get_ports {pin11}];
set_property -dict { PACKAGE_PIN D14 IOSTANDARD LVCMOS33} [get_ports {pin12}];
set_property -dict { PACKAGE_PIN E13 IOSTANDARD LVCMOS33} [get_ports {pin13}];
set_property -dict { PACKAGE_PIN F13 IOSTANDARD LVCMOS33} [get_ports {pin14}];
set_property -dict { PACKAGE_PIN F14 IOSTANDARD LVCMOS33} [get_ports {pin15}];
set_property -dict { PACKAGE_PIN G14 IOSTANDARD LVCMOS33} [get_ports {pin16}];
set_property -dict { PACKAGE_PIN D13 IOSTANDARD LVCMOS33} [get_ports {pin17}];
set_property -dict { PACKAGE_PIN D12 IOSTANDARD LVCMOS33} [get_ports {pin18}];
set_property -dict { PACKAGE_PIN E12 IOSTANDARD LVCMOS33} [get_ports {pin19}];
set_property -dict { PACKAGE_PIN F12 IOSTANDARD LVCMOS33} [get_ports {pin20}];