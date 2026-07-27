# Bill of materials

**Generated from `hardware/octobot-controller.kicad_pcb` by
`hardware/tools/gen_bom.py`. Do not edit by hand.**

The CSVs in `hardware/fabrication/` were exported in 2023 and describe an
earlier board. This table is read from the current layout, so it stays
correct as the board changes. Regenerate it with:

```bash
python hardware/tools/gen_bom.py --write
```

LCSC part numbers are not tracked in the layout, so the fab house needs a
populated CSV before assembly. Export that from KiCad at order time.

---

| Qty | Value | Footprint | Designators |
|---:|---|---|---|
| 28 | `Conn_01x03_Pin` | PinHeader_1x03_P2.54mm_Vertical | J2, J3, J4, J5, J6, J7, J8, J10, J11, J12, J13, J14, J17, J18, J19, J20, J21, J22, J23,... |
| 4 | `1x2` | PinHeader_1x02_P2.54mm_Vertical | J9, J16, J31, J34 |
| 3 | `LED` | LED_0201_0603Metric | D1, D3, D4 |
| 2 | `PCA9685PW/Q900_118` | SOP65P640X110-28N | U1, U2 |
| 2 | `TL3365AF180QG` | SW_TL3365AF180QG | S1, S2 |
| 1 | `4,7 uH` | 7447714220 | L1 |
| 1 | `47346-0001` | MOLEX_47346-0001 | J1 |
| 1 | `ATmega32U4-M` | QFN-44-1EP_7x7mm_P0.5mm_EP5.2x5.2mm | U3 |
| 1 | `AVR-ISP` | AVR-ISP | U4 |
| 1 | `Conn_01x04_Pin` | PinHeader_1x04_P2.54mm_Vertical | J15 |
| 1 | `Crystal_GND24` | CRYSTAL-SMD-5X3.2-4PAD | Y1 |
| 1 | `DS04-254-2-03BK-SMT` | DS04254203BKSMT | S3 |
| 1 | `HPZR-C10X` | HPZRC10X | D5 |
| 1 | `RQ3E075ATTB` | RQ3E075ATTB | Q1 |
| 1 | `SY8303AIC` | SOT65P280X110-8N | IC1 |
| 6 | `10uF` | C_0805_2012Metric | C4, C5, C18, C19, C22, C23 |
| 2 | `0,1uF` | C_0603_1608Metric | C17, C21 |
| 2 | `18pF` | C_0603_1608Metric | C1, C3 |
| 2 | `1uF` | C_0805_2012Metric | C2, C8 |
| 2 | `875075161013` | CAPAE1030X1240N | C6, C9 |
| 1 | `0.1uF` | C_0805_2012Metric | C7 |
| 1 | `10nF` | C_1206_3216Metric | C20 |
| 1 | `12 pF` | C_1206_3216Metric | C16 |
| 24 | `220 Ohm` | R_0603_1608Metric | R31, R32, R33, R34, R35, R36, R37, R38, R39, R40, R41, R42, R43, R44, R45, R46, R47, R4... |
| 20 | `10K` | R_0603_1608Metric | R1, R5, R8, R10, R14, R16, R17, R18, R19, R20, R21, R22, R23, R24, R25, R26, R27, R28, ... |
| 2 | `1K` | R_0402_1005Metric | R7, R9 |
| 2 | `22 Ohm` | R_0603_1608Metric | R2, R3 |
| 1 | `100K` | R_1206_3216Metric | R15 |
| 1 | `100K Ohm` | R_0805_2012Metric | R13 |
| 1 | `10KOhm` | R_0603_1608Metric | R4 |
| 1 | `110K Ohm` | R_0805_2012Metric | R11 |
| 1 | `15K Ohm` | R_0805_2012Metric | R12 |
| 1 | `1KOhm` | R_0603_1608Metric | R6 |

**120 placements, 33 distinct lines.**
