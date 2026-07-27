# The control board

One 4-layer board drives all 24 servos of the octobot. The KiCad 7 project is in
[`hardware/`](../hardware/).

| File | What it is |
|---|---|
| `octobot-controller.kicad_sch` | Schematic. Flat, single sheet. |
| `octobot-controller.kicad_pcb` | Layout. 120 footprints across 4 copper layers. |
| `octobot-controller.step` | 3D export of the assembled board. |
| `fabrication/` | Gerbers, BOM and placement file. **Stale — see below.** |

---

## Architecture

The servo count drives the whole design. Eight legs with three joints each need
24 independent PWM channels, and an ATmega32U4 has nowhere near that many
hardware timers. So the MCU generates no servo pulses at all. It sends I²C
commands to two dedicated PWM controllers, which hold their outputs between
updates.

```
 battery ──▶ P-FET ──▶ SY8303 buck ──┬──▶ servo rail ──▶ 28 × 3-pin headers
 reverse-polarity          5 V        │
      protection                      └──▶ ATmega32U4 ──I²C──▶ PCA9685 #1 ─▶ 12 ch
                                                          └──▶ PCA9685 #2 ─▶ 12 ch
```

### Microcontroller

**ATmega32U4-M** in TQFP-44, clocked by a 16 MHz crystal. The part has native
USB, so the board enumerates directly without a separate USB-to-serial bridge.
An AVR-ISP header is on the board for flashing a bootloader or recovering a
bricked chip.

### Servo drive

**Two PCA9685PW** 16-channel, 12-bit PWM controllers on I²C. Each drives 12
servo channels in this design, which totals 24 and leaves 8 spare channels for
sensors or lighting. The schematic names these nets `Servo_Multiplexer1_1…12`
and `Servo_Multiplexer2_1…12`.

The 12-bit resolution matters for a walker. At a 50 Hz servo frame it resolves
the pulse width finely enough that a leg holds a commanded angle without visible
stepping. A software PWM on a shared timer does not.

### Power

An **SY8303AIC** synchronous buck regulator produces the servo rail from the
battery. The worst case the rail must survive is 24 servos stalling at once, so
the regulator is sized for that peak and not for the average draw.

An **RQ3E075ATTB** P-channel MOSFET sits in the input path for reverse-polarity
protection. Connecting the battery backwards does nothing instead of destroying
the board.

### Interface

- 28 × 3-pin servo headers (signal, V+, GND)
- DIP switch (`DS04-254-2-03BK-SMT`) for boot-time configuration
- Two tactile buttons (`TL3365AF180QG`)
- Trimmer potentiometer
- Molex power connector (`47346-0001`)
- Status LEDs

---

## Fabrication files are out of date

`hardware/fabrication/` was exported on **2023-06-28**. The schematic and layout
were last changed on **2026-07-26**. The exports do not describe the current
board.

The two revisions are not close. The 2023 export lists an nRF24L01 radio, an SMA
antenna connector, two TLE9201SG motor drivers and a USB Mini-B socket. None of
those parts are in the current schematic, and the current PCA9685 servo drivers
are not in that export.

Re-export before ordering:

1. Open `octobot-controller.kicad_pcb` in KiCad 7.
2. **File → Fabrication Outputs → Gerbers** into `fabrication/gerbers/`.
3. **File → Fabrication Outputs → Drill Files** into the same folder.
4. **Tools → Generate BOM** and **File → Fabrication Outputs → Component Placement**.

The old exports are kept in the repository because they record what was actually
manufactured in 2023, which is useful history. They are not a build target.

---

## Opening the project

Install KiCad 7 or newer, then open `hardware/octobot-controller.kicad_pro`.
The project has no external symbol or footprint libraries, so nothing else needs
installing.

`hardware/board-backups/` holds KiCad's automatic backup archives and is
excluded from git.
