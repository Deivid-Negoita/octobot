# Bill of materials

Generated from the KiCad project by `hardware/tools/gen_bom.py` — placements and
packages from `octobot-controller.kicad_pcb`, manufacturer part numbers from
`octobot-controller.kicad_sch`. Do not edit by hand:

```bash
python hardware/tools/gen_bom.py --write   # regenerate this file and the README
python hardware/tools/gen_bom.py --check   # confirm it matches the fab export
```

`--check` compares this table against
`hardware/fabrication/octobot-controller-bom.csv`, the BOM inside the
fabrication package the board house was sent. The two agree line for line and
designator for designator.

Distributor part numbers are not tracked in the project files, so an assembly
house needs those added at order time.

---

| Qty | Value | Manufacturer part | Package | Ref | Function |
|---:|---|---|---|---|---|
| 2 | `PCA9685PW/Q900_118` | NXP | SOP65P640X110-28N | U1–U2 | 16-channel 12-bit PWM generator. 12 channels used each, at 0x40 and 0x41. |
| 1 | `ATmega32U4-M` | Microchip | QFN-44-1EP_7x7mm_P0.5mm_EP5.2x5.2mm | U3 | Host MCU. Native USB, 16 MHz crystal, I2C master. |
| 1 | `AVR-ISP` | — | AVR-ISP | U4 | ISP header on D14/D15/D16 and RESET. |
| 1 | `SY8303AIC` | Silergy | SOT65P280X110-8N | IC1 | Synchronous buck. VIN down to the 5.0 V logic rail set by R11/R12. |
| 3 | `LED` | — | LED_0201_0603Metric | D1, D3–D4 | Power, RX and TX indicators. |
| 1 | `4,7 uH` | Wurth Elektronik 7447713047 | 7447714220 | L1 | Buck output inductor. |
| 1 | `Crystal_GND24` | — | CRYSTAL-SMD-5X3.2-4PAD | Y1 | MCU clock, loaded by C1/C3. |
| 1 | `HPZR-C10X` | Nexperia | HPZRC10X | D5 | 10 V regulator diode. Clamps the pass FET gate. |
| 1 | `RQ3E075ATTB` | ROHM Semiconductor | RQ3E075ATTB | Q1 | P-channel MOSFET. Reverse-polarity pass element on the input. |
| 28 | `Conn_01x03_Pin` | — | PinHeader_1x03_P2.54mm_Vertical | J2–J8, J10–J14, J17–J30, J32–J33 | 24 servo headers (GND / rail / signal), 2 rail feeds (J29/J30), 2 analog headers (J32/J33). |
| 4 | `1x2` | — | PinHeader_1x02_P2.54mm_Vertical | J9, J16, J31, J34 | Input power (J9), 5 V taps (J16/J34), I2C breakout (J31). |
| 1 | `47346-0001` | Molex | MOLEX_47346-0001 | J1 | USB micro-B receptacle. Programming and 5 V input. |
| 1 | `Conn_01x04_Pin` | — | PinHeader_1x04_P2.54mm_Vertical | J15 | HC-12 radio header: 5 V, GND, D8, D9. |
| 2 | `TL3365AF180QG` | E-Switch | SW_TL3365AF180QG | S1–S2 | Reset (S1) and user button on D12 (S2). |
| 1 | `DS04-254-2-03BK-SMT` | CUI Devices | DS04254203BKSMT | S3 | 3-position DIP switch on D14/D15/D16. |
| 24 | `220 Ohm` | — | R_0603_1608Metric | R31–R54 | Series resistor on each servo signal line. |
| 20 | `10K` | — | R_0603_1608Metric | R1, R5, R8, R10, R14, R16–R30 | PWM address and OE straps, I2C pull-ups, buck enable. |
| 2 | `1K` | — | R_0402_1005Metric | R7, R9 | LED series resistors. |
| 2 | `22 Ohm` | — | R_0603_1608Metric | R2–R3 | USB D+/D- series termination. |
| 1 | `100K` | — | R_1206_3216Metric | R15 | Pass FET gate pull-down. |
| 1 | `100K Ohm` | — | R_0805_2012Metric | R13 | Buck switching-frequency set resistor. |
| 1 | `10KOhm` | — | R_0603_1608Metric | R4 | RESET pull-up. |
| 1 | `110K Ohm` | — | R_0805_2012Metric | R11 | Buck feedback divider, upper leg. |
| 1 | `15K Ohm` | — | R_0805_2012Metric | R12 | Buck feedback divider, lower leg. |
| 1 | `1KOhm` | — | R_0603_1608Metric | R6 | LED series resistor. |
| 6 | `10uF` | — | C_0805_2012Metric | C4–C5, C18–C19, C22–C23 | Rail decoupling. |
| 2 | `0,1uF` | — | C_0603_1608Metric | C17, C21 | Decoupling. |
| 2 | `18pF` | — | C_0603_1608Metric | C1, C3 | Crystal load capacitors. |
| 2 | `1uF` | — | C_0805_2012Metric | C2, C8 | USB UCAP and buck input decoupling. |
| 2 | `875075161013` | Wurth Elektronik | CAPAE1030X1240N | C6, C9 | Aluminium electrolytic. Bulk storage, one per servo rail. |
| 1 | `0.1uF` | — | C_0805_2012Metric | C7 | AREF decoupling. |
| 1 | `10nF` | — | C_1206_3216Metric | C20 | Buck bootstrap. |
| 1 | `12 pF` | — | C_1206_3216Metric | C16 | Buck feedback feed-forward. |

**120 placements over 33 lines — 87 SMT, 33 through-hole.**
