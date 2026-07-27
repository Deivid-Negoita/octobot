# Kinematics workbench

Browser rig and IK solver for the octobot. Plain ES modules, Three.js 0.160 from
a CDN, no build step and nothing to install.

## Run it

ES modules cannot load over `file://`, so serve the folder:

```bash
cd tools
python serve.py          # or start.bat on Windows
```

Then open <http://localhost:8123>. An internet connection is needed for the
Three.js CDN and the fonts.

## Pages

- **`index.html`** — the workbench. The CAD model rigs itself into eight legs on
  startup. Inspect and constrain joints, drag the target to solve IK, run a gait,
  export the rig as JSON.
- **`playground.html`** — the locomotion sandbox. Drive with `W A S D` over
  terrain blocks you spawn and drag.

Press `H` in the workbench for the key map. Add `?debug` to the playground URL
for per-frame locomotion diagnostics in the console.

## Layout

```
css/     console.css holds the shared chrome; the other two are per page
js/      modules — see docs/kinematics.md for what each one does
models/  octobot.glb, the mesh the pages load (~12 MB)
tools/   serve.py, verify.py, shots.py, start.bat
```

## Development

```bash
cd tools
python serve.py &
python verify.py         # both pages in Chromium, fails on any console error
python shots.py          # regenerate the README screenshots
```

Both scripts need Playwright: `pip install playwright && playwright install chromium`.

The full write-up of the solvers, the collision guard and the gait model is in
[`../docs/kinematics.md`](../docs/kinematics.md).
