# Kinematics

The workbench answers one question for the physical robot:

> **Given a foot position, what angle does each of the three servos in that leg
> need?**

That is the inverse kinematics problem. The browser is a convenient place to
solve it because the CAD model already contains the geometry.

Two pages share the model and take different approaches to it.

---

## Auto-rigging

Nothing is rigged by hand. `index.html` loads `models/octobot.glb` and derives
the skeleton from the mesh.

**1. Find the feet.** `detectFeet` samples every mesh vertex that sits within
0.07 units of the ground plane. It then clusters those contacts in XZ with a
radius that scales to the model. The eight largest clusters are the feet.
Sampling is strided so a 12 MB mesh stays fast.

**2. Build a chain per foot.** Each foot gets a hip-yaw → shoulder-pitch →
knee-pitch chain. The joint pivots come from the servo geometry rather than from
a guess. The pivot is the centre of the servo **head** mesh, because the horn
sits exactly on the shaft axis. Anchoring there makes the servo body rotate
around its own head, so head and body stay coaxial through the full sweep.
Bounding-box overlap is only the fallback for a servo with no separate head.

**3. Bind the parts.** `binding.js` assigns every top-level CAD occurrence to a
bone by centroid distance. The `art_1/2/3` links go to their exact bones by CAD
name. Servos, casings and brackets go to the link they are screwed to, chosen by
maximum mesh overlap. Chassis and electronics ride with the body.

The bound occurrences are reparented into per-bone groups that follow the solved
bones every frame. The real printed parts articulate, rather than a stick figure.

---

## Solvers

`solver.js` implements two, selectable at runtime.

**FABRIK** (Forward And Backward Reaching Inverse Kinematics) is the default. It
walks the chain backward from the target to the root, then forward from the root
to the target. It repeats that pass until the end effector is within tolerance.
FABRIK converges in few iterations. It is also the only solver here that honours
joint constraints.

**CCD** (Cyclic Coordinate Descent) rotates one joint at a time to point the end
effector at the target, iterating down the chain. It is included for comparison.
CCD ignores the constraints, which is exactly why the workbench shows both:
switching to CCD makes the value of the constraint pass obvious.

### Constraints

Two joint types:

- **Ball with cone limit.** The outgoing bone direction is clamped so its angle
  to the previous segment never exceeds a set maximum.
- **Hinge.** A single-axis servo joint. The auto-rig gives each joint a custom
  axis in the leg frame, taken from the real servo shaft. Picking X, Y or Z in
  the inspector overrides that. The sweep is centred on the rest pose, which is
  what a servo horn mounted at its midpoint actually does.

The physical joint limits are in `octorig.js`:

```js
export const LIMITS = { yaw: 0.55, shoulder: Math.PI / 2, knee: Math.PI / 2 };
```

These are the ranges the linkage sweeps before the brackets foul, not the
servo's full travel. Widening the yaw limit to ±90° was tried and measured. It
put 43% to 55% of frames past 60°, with shoulder and knee pinned at the stop,
and produced folded, curled leg poses. The tighter values cost nothing
measurable — identical climb heights, walking distance within 3% — and cut the
deepest mesh penetration from 153 mm to 61 mm.

---

## Collision guard

A pose that drives a bone through the chassis, through another bone of the same
leg, or below the floor is **rejected**. The leg freezes at its last accepted
pose, the offending bones and the target turn red, and STATUS reads `COLLISION`.

The interesting part is the baseline. The rig places joints inside the model it
is rigging, so a naive check reports a collision on the very first frame and
never recovers. Instead every contact gets a stable flag — `m3:b1`, `floor:b2`,
`self:0:2` — and the chain keeps the flag set of its last accepted pose. Only a
**new** flag blocks. Contacts that already existed when a pose was accepted are
treated as intentional. Toggling a guard re-baselines from the current pose.

Bone-to-bone distance uses the standard closest-point-between-segments routine
(Ericson, *Real-Time Collision Detection* 5.1.9). Segment ends are trimmed by
0.045 units because joints legitimately sit on surfaces.

---

## Gait

`gait.js` cycles each leg through **stance** and **swing**. During stance the
foot is pinned to a world position while the body passes over it. During swing
the foot lifts along an arc and reaches forward.

The body advances at:

```
v = stride / (duty × cycleTime)
```

That speed is what makes stance feet stationary in world space. Get it wrong and
the robot moonwalks — the legs cycle but the feet skate. Measured drift with the
correct speed is under 2 mm per step.

Two patterns:

| Pattern | Duty | Behaviour |
|---|---|---|
| Tetrapod | 0.5 | Two alternating groups of four |
| Wave | 0.75 | A ripple around the body |

The playground uses closed-form IK instead of an iterative solver: yaw plus a
two-link planar solution per leg. Parts cannot detach and the solve is exact.
Hinge signs are calibrated at load by probing each servo. The sign depends on
how the servo is mounted, and the CAD does not record that.

---

## Export

**EXPORT** downloads the rig as JSON: legs, joints, hinge axes, limits, solver
settings and the current servo angles. That file is the handoff to the firmware
on the real controller.

---

## Source map

| File | Responsibility |
|---|---|
| `js/main.js` | Scene, app state, interaction, render loop, auto-rig |
| `js/chain.js` | `KinematicChain` — joints, bone visuals, target, solve calls |
| `js/solver.js` | FABRIK, CCD, hinge chains, constraint enforcement |
| `js/collision.js` | Bone/model, self and floor checks with flag baselining |
| `js/binding.js` | Binds CAD occurrences to rig bones |
| `js/gait.js` | Stance/swing cycling and body translation |
| `js/octorig.js` | Playground rig: true transform hierarchy, closed-form IK |
| `js/playground.js` | Playground scene, driving, terrain, telemetry |
| `js/loader.js` | GLB/GLTF/OBJ/STL/STEP import and normalization |
| `js/boot.js` | Startup overlay and progress-reporting fetch |
| `js/ui.js` | Panels, lists, telemetry, export |
