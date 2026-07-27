# The control board

One 4-layer board drives all 24 servos of the octobot. The KiCad project is in
[`hardware/`](../hardware/).

| File | What it is |
|---|---|
| `octobot-controller.kicad_sch` | Schematic. Flat, single sheet. |
| `octobot-controller.kicad_pcb` | Layout. 120 placements across 4 copper layers. |
| `octobot-controller.step.zip` | 3D export of the assembled board. |
| `fabrication/` | Gerbers, BOM and placement file from 2023. **Stale — see below.** |

The parts list is in [`bom.md`](bom.md). It is generated from the layout rather
than typed out, so it cannot drift from the board.

---

## Architecture

The servo count drives the whole design. Eight legs with three joints each need
24 independent PWM channels. An ATmega32U4 has nowhere near that many hardware
timers, so the MCU generates no servo pulses at all. It sends I²C commands to
two dedicated PWM controllers, which hold their outputs between updates.

```
 battery ─▶ Q1 P-FET ─▶ SY8303 buck ─┬─▶ VCC_SERVOBLOCK_1 ─▶ J2–J14   12 servos
            reverse-polarity         ├─▶ VCC_SERVOBLOCK_2 ─▶ J17–J28  12 servos
            protection               │
                                     └─▶ ATmega32U4 ─I²C─┬─▶ PCA9685 U1 ─▶ 12 ch
                                              │          └─▶ PCA9685 U2 ─▶ 12 ch
                                              └── D8 / D9 ─▶ J15 ─▶ HC-12 radio
```

### Microcontroller

**ATmega32U4-M** in a QFN-44 package, clocked by a 16 MHz crystal (Y1). The part
has native USB, so the board enumerates over the Molex 47346-0001 micro-USB
receptacle (J1) without a separate USB-to-serial bridge. An AVR-ISP header (U4)
is on the board for flashing a bootloader or recovering a bricked chip.

### Servo drive

**Two PCA9685PW** 16-channel, 12-bit PWM controllers on I²C (U1 and U2). Each
drives 12 servo channels in this design, which totals 24 and leaves 8 spare
channels. The schematic names these nets `Servo_Multiplexer1_1…12` and
`Servo_Multiplexer2_1…12`.

The 12-bit resolution matters for a walker. At a 50 Hz servo frame it resolves
the pulse width finely enough that a leg holds a commanded angle without visible
stepping. A software PWM on a shared timer does not.

The 24 servo headers are split across two power rails, `VCC_SERVOBLOCK_1` and
`VCC_SERVOBLOCK_2`, with 12 headers on each. Splitting the rails keeps the
inrush of one group of legs from browning out the other. Each rail has its own
power-injection header, J29 and J30. Heavy servo current can therefore be fed
straight to the rail instead of through the regulator trace.

### Radio

**J15** is a 4-pin header carrying 5V, GND, D8 and D9. An **HC-12** module plugs
in here. D8 and D9 are the serial pair, so the link runs on a software UART and
leaves the hardware USART free. The module is not populated on the board, which
means an antenna can be sited away from the servo wiring.

### Power

An **SY8303AIC** synchronous buck regulator produces the servo rail from the
battery. The worst case the rail must survive is 24 servos stalling at once. The
regulator is sized for that peak and not for the average draw.

An **RQ3E075ATTB** P-channel MOSFET (Q1) sits in the input path for
reverse-polarity protection. Connecting the battery backwards does nothing
instead of destroying the board.

There is no separate 3.3 V regulator. The whole board runs at 5 V.

### Interface

- 24 × 3-pin servo headers, 12 per power rail
- 2 × 3-pin power-injection headers, one per rail (J29, J30)
- 2 × 3-pin sensor headers on A0 and A1 (J32, J33)
- DIP switch `DS04-254-2-03BK-SMT` (S3) for boot-time configuration
- Two tactile buttons `TL3365AF180QG` (S1, S2)
- Three status LEDs (D1, D3, D4)

---

## Fabrication files are out of date

`hardware/fabrication/` was exported on **2023-06-28**. The schematic and layout
were last changed on **2026-07-26**. The exports do not describe the current
board.

The two revisions are far apart. The 2023 export lists an nRF24L01 radio, an SMA
antenna connector, two TLE9201SG motor drivers, a REG1117-3.3 regulator and a
USB Mini-B socket. None of those parts are on the current board. The PCA9685
servo drivers that the current board is built around do not appear in that
export at all.

Re-export before ordering:

1. Open `octobot-controller.kicad_pcb` in KiCad.
2. **File → Fabrication Outputs → Gerbers** into `fabrication/gerbers/`.
3. **File → Fabrication Outputs → Drill Files** into the same folder.
4. **Tools → Generate BOM** and **File → Fabrication Outputs → Component Placement**.

The old exports stay in the repository because they record what was actually
manufactured in 2023. They are history, not a build target.

---

## Opening the project

Install KiCad 7 or newer, then open `hardware/octobot-controller.kicad_pro`.
The project has no external symbol or footprint libraries, so nothing else needs
installing.

`hardware/board-backups/` holds KiCad's automatic backup archives and is
excluded from git.
