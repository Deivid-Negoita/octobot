# Controller board

A 124 × 23 mm four-layer board that drives 24 servos from a single MCU. It sits
along the spine of the chassis with twelve servo headers down each long edge, so
each leg's cable run is short.

Everything below is read from `hardware/octobot-controller.kicad_sch` and
`hardware/octobot-controller.kicad_pcb`. The files under
`hardware/fabrication/` are exported from that same layout, and
`python hardware/tools/gen_bom.py --check` compares the two designator by
designator.

| | |
|---|---|
| Outline | 124 × 23 mm, 1.6 mm, four copper layers |
| MCU | ATmega32U4 (QFN-44), 16 MHz crystal, native USB |
| PWM | 2 × NXP PCA9685, 12-bit, I2C |
| Servo channels | 24, on two independently supplied power rails |
| Input | 2-pin header, reverse-polarity protected, buck to 5 V |
| Radio | HC-12 module on a 4-pin header |
| Routing | 851 track segments, 97 vias, 3 copper zones |

---

## Power

Input arrives on `J9`. `Q1`, a ROHM RQ3E075ATTB P-channel MOSFET, passes it to
the `VIN` rail. `R15` (100 K) pulls the gate down, and `D5`, a Nexperia
HPZR-C10X 10 V regulator diode, clamps it. That pair blocks reverse polarity and
keeps the gate inside its rating on a higher-voltage pack.

`IC1`, a Silergy SY8303 synchronous buck, steps `VIN` down to the logic rail
through `L1` (4.7 µH). The feedback divider `R11`/`R12` (110 K / 15 K) against
the part's 0.6 V reference sets the output to 5.0 V. `R13` sets the switching
frequency, `R14` ties `EN` high off `VIN`, and `C20` is the bootstrap.

The 5 V rail supplies the MCU, both PWM expanders, the radio header, the ISP
header, the two analog sensor headers, and the `J16`/`J34` taps.

### Servo rails are separate

`VCC_SERVOBLOCK_1` and `VCC_SERVOBLOCK_2` never touch the 5 V logic rail. Each
is fed only through pin 2 of its rail header, `J29` for rail 1 and `J30` for
rail 2. Each also carries a Würth 875075161013 aluminium electrolytic (`C6`,
`C9`) for the stall-current transients that twelve servos produce.

Those headers are wired GND / rail / `VIN`, which gives two options per rail:

- Jumper pin 2 to pin 3 to run that block of servos straight off the input pack.
- Leave the jumper off and feed pin 2 from a separate BEC.

Two independently fed rails keep one leg group's current spikes out of the
other, and keep both out of the logic supply.

### Which servo voltage

Feed both servo rails at 6.0 V. The MG996R is rated 9.4 kgf·cm at 4.8 V and
11 kgf·cm at 6.0 V, which is 0.92 and 1.08 N·m.

The OmniLink team ran the gait in their simulator at both points. The results
are theirs, not measured on the robot:

| Servo torque | 1.08 N·m (6.0 V) | 0.92 N·m (4.8 V) |
|---|---|---|
| Flat-ground travel lost | 2.8 % | 4.3 % |
| Margin over the collapse point | 1.8× | 1.5× |

Both voltages walk. Sweeping the torque down, the gait stops working between
0.35 and 0.42 N·m on flat ground and between 0.50 and 0.60 N·m climbing a 48 mm
block, so the block sets the limit.

Their run assumed a 3.0 kg robot, because the BOM covers only the electronics
and the STEP solids are not watertight. By their extrapolation, the block gait
runs out of margin near 5.4 kg at 6 V or 4.6 kg at 4.8 V. **Weigh the assembled
robot.** That one figure would change these margins more than any other input.

## Servo channels

24 three-pin headers, each wired GND / rail / signal:

| Rail | Headers | PWM device |
|---|---|---|
| `VCC_SERVOBLOCK_1` | `J2`–`J8`, `J10`–`J14` | `U1` at 0x40 |
| `VCC_SERVOBLOCK_2` | `J17`–`J28` | `U2` at 0x41 |

Every signal line runs through a 220 Ω series resistor (`R31`–`R54`) between the
PCA9685 output and the header pin. The resistor damps the reflections a long,
unshielded servo lead produces. It also limits the current into the servo's
input on a fault.

`U1` takes the base address with `A0`–`A5` pulled to ground through 10 K. `U2`
ties `A0` to 5 V for 0x41. Each device drives channels 0 to 11, so channels 12 to
15 are left unconnected — 8 spare channels for a future revision. `OE` on both is
pulled low through 10 K so outputs are enabled at power-up.

## Interfaces

| Header | Pins | Purpose |
|---|---|---|
| `J1` | Molex 47346-0001 | USB micro-B. Programming, and 5 V in when bench-powered. |
| `J15` | 5 V, GND, `D8`, `D9` | HC-12 radio module. `D8`/`D9` carry the serial pair. |
| `J31` | `D2`, `D3` | I2C breakout, the same bus the PWM expanders sit on. |
| `J32`, `J33` | GND, 5 V, `A0` / `A1` | Analog sensor headers. |
| `J16`, `J34` | GND, 5 V | 5 V taps. |
| `U4` | 6-pin AVR ISP | `RESET`, `D14`/MISO, `D15`/SCK, `D16`/MOSI. |

The MCU can be programmed over USB through the bootloader or over ISP at `U4`.
`S3`, a three-position DIP switch, shares `D14`/`D15`/`D16` with the ISP header,
so open it before programming through `U4`.

I2C runs on `D2` (SDA) and `D3` (SCL) with 10 K pull-ups to 5 V.

## Controls and indicators

| Part | Function |
|---|---|
| `S1` | Reset. Tactile, on `RESET` with a 10 K pull-up (`R4`). |
| `S2` | User button on `D12`, 10 K pull-down (`R8`). |
| `S3` | 3-position DIP switch on `D14`/`D15`/`D16`. |
| `D1` | Power. Straight off 5 V through `R7`. |
| `D3`, `D4` | Serial activity, driven from `D17` and `PD5`. |

## Bill of materials

[bom.md](bom.md) — generated from the project files, 120 placements over 33
lines. Regenerate with `python hardware/tools/gen_bom.py --write`.
