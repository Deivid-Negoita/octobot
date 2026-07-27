# Octobot

An eight-legged walking robot with 24 servos, built end to end. The chassis and
legs are CAD. A custom ATmega32U4 board drives every servo. A browser workbench
rigs the CAD model and solves its inverse kinematics.

![The IK workbench with the octobot rigged into eight legs](docs/images/workbench.png)

The robot carries environmental-monitoring, 3D-scanning and speleological
payloads. Those payloads need the legs to place feet accurately on uneven
ground, which a fixed gait cannot do. The kinematics workbench in this
repository exists to solve that.

---

## What is here

| Folder | Contents |
|---|---|
| [`kinematics/`](kinematics/) | Browser workbench and locomotion sandbox. Three.js, no build step. |
| [`hardware/`](hardware/) | KiCad 7 project for the 24-channel servo control board. |
| [`mechanical/`](mechanical/) | STEP exports of the chassis and a single leg. |
| [`docs/`](docs/) | [Hardware notes](docs/hardware.md) and [kinematics notes](docs/kinematics.md). |

The embedded firmware lives in a separate repository and is not included here.

---

## Run the kinematics workbench

The workbench is a static site, so it also runs on GitHub Pages straight from
this repository. `.github/workflows/pages.yml` publishes `kinematics/` on every
push to `main`. Enable it once under **Settings → Pages → Source → GitHub
Actions**, and the workbench is then live at
`https://<your-github-username>.github.io/octobot/`.

To run it locally instead: the pages load ES modules, so they need an HTTP
server. Opening `index.html` from the filesystem gives you a blank screen and a
CORS error in the console.

```bash
cd kinematics/tools
python serve.py          # or double-click start.bat on Windows
```

Open <http://localhost:8123>. The chassis mesh is about 12 MB, so the first load
takes a few seconds. A progress bar reports the download.

Two pages share the model:

**`index.html` — IK workbench.** The CAD model rigs itself on startup. The
loader finds the feet from the mesh geometry, then builds a hip-yaw →
shoulder-pitch → knee-pitch chain per leg on the real servo shaft axes. It binds
every servo, bracket and casing to the link it is screwed to. You get eight
chains named `LEG-1` to `LEG-8`. Drag the cyan target and that leg solves toward
it in real time while the servo angles update. Press `Space` to run a gait.

**`playground.html` — locomotion sandbox.** Drive the robot with `W A S D` over
terrain blocks you spawn and drag. The feet land on the block surface or the
ground by analytic sampling, and the body rides at the average support height.
Live servo angles for all 24 joints stream into the telemetry panel.

| Key | Action |
|---|---|
| `1` / `2` | JOINTS / SOLVE mode (workbench) |
| `Space` | start or stop walking (workbench) |
| `H` | open the help card (workbench) |
| `P` | show or hide the panels (both pages) |
| `W A S D` | walk (playground) |
| `Q` / `E` | lower or raise the body (playground) |
| `Y` | toggle the onboard camera view (playground) |

![Driving the octobot over a spawned terrain block](docs/images/playground.png)

Read [`docs/kinematics.md`](docs/kinematics.md) for the solver, the collision
guard and the gait model.

---

## The control board

One board drives all 24 servos. An **ATmega32U4** talks over I²C to **two
PCA9685** 16-channel PWM drivers, which gives 32 channels for the 24 servos and
leaves headroom for sensors. An **SY8303** synchronous buck regulator supplies
the servo rail from the battery, and a P-channel MOSFET on the input protects
against reverse polarity. The board is a 4-layer design with 28 three-pin servo
headers, an AVR-ISP header, a DIP switch and two tactile buttons.

Building 24 servo channels from discrete drivers would have cost more and taken
more board area than the two PCA9685s do.

> [!WARNING]
> The exported fabrication files in `hardware/fabrication/` date from June 2023
> and describe an **earlier revision of the board** with a different component
> set. The schematic and PCB in `hardware/` are current. Re-export the gerbers,
> BOM and placement file from KiCad before ordering anything.

Read [`docs/hardware.md`](docs/hardware.md) for the full component breakdown.

---

## Mechanical

`mechanical/` holds STEP exports of the assembled chassis and of a single leg.
Every part is 3D printed. The chassis was modelled in Autodesk Fusion 360, and
`kinematics/models/octobot.glb` is the mesh export the web app loads.

STEP files are text and compress to roughly 15% of their size, so the repository
carries the zips and ignores the loose exports. The chassis is 52 MB unpacked
and 7.7 MB zipped. Unzip before opening in CAD:

```bash
cd mechanical
unzip octobot-chassis.step.zip
```

---

## Tooling

`kinematics/tools/` holds the development scripts:

```bash
python serve.py          # static server with caching disabled
python verify.py         # drive both pages in Chromium, fail on any console error
python shots.py          # regenerate the README screenshots
```

`verify.py` and `shots.py` need Playwright:

```bash
pip install playwright && playwright install chromium
```

`verify.py` boots each page and asserts that the rig produced eight legs. It
then exercises the help modal, toggles the panels, runs the gait, spawns a
terrain block and walks the robot. It exits non-zero if the browser logged an
error.

---

## Built with

Three.js 0.160 loaded from a CDN, plain ES modules, no bundler and no
dependencies to install. KiCad 7 for the board. Autodesk Fusion 360 for the
mechanics.

## License

MIT — see [LICENSE](LICENSE).
