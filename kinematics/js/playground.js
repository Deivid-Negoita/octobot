// playground.js — Foot-support-driven, servo-aware locomotion for Octopod.
//
// Geometry-true + terrain-aware chassis + cooperative + MAX-STABILITY height.
// The body's resting height is owned by the system: a throttled scan picks the
// body root.y that MINIMISES the worst per-joint utilisation across every planted
// foot (most servo slack = most stable), penalising any height that strands a
// foot; that setpoint is exponentially smoothed so the spring chases a gliding
// value (no 8 Hz step-chase oscillation), and a hard anti-dangle ceiling of
// supportHeight + MAX_RISE makes the "stretched-leg float" impossible. Q/E is a
// MOMENTARY nudge on top (springs to 0, like the arrow keys' lean). The chassis
// has the same terrain awareness the feet do: its measured world box is tested
// against every block each frame and the highest slab the belly overlaps sets a
// hard clearance floor the body can never drop below (rides UP, no clip). A per-
// leg "walled" test re-steps a foot whose hip has been carried over a ledge onto
// the ledge top, so a wall becomes a step. Walking eases off when feet are
// floating/saturated so the robot stops marching into a void. A cooperative
// rescue layer handles feet that float over a void; a baseline-referenced self-
// collision guard keeps the legs out of each other. Orbit camera tracks via a
// top-of-frame snapshot; POV camera is mounted by measuring the chassis plate;
// telemetry is a living heat gauge (red danger / teal assist / gold climb).
//
// TURN-IN-PLACE POLISH (build T2). Pressing R + A/D next to a block used to ball
// the legs up: the tetrapod march swung four feet to body-relative homes while the
// body rotated, so they landed stale and the planted legs folded (SAT 8). Now (a)
// the march runs only while actually translating, so a pure turn pivots the body
// over planted feet; (b) the repair branch polls during a turn and ratchets one
// wound leg at a time to its current-heading home; (c) a turn-safe filter never
// steps a foot UP onto a higher surface while turning, so the robot can't climb or
// fold into the block just by rotating; (d) the walled detector is suppressed on a
// pure turn (a lateral hip sweep over an edge is not a real climb), while walking
// climbs and idle straddle-finishes still auto-climb. The look-ahead belly that
// lifts the body on the approach to a step is kept (LOOK = 0.55) and now fires in
// ANY travel direction — forward, backward, or strafe — not just straight ahead.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadOctobot, LIMITS } from './octorig.js';
import { createBoot } from './boot.js';
import { applyRobotFinish } from './materials.js';
import { createResolutionGovernor } from './perf.js';

const $ = id => document.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = THREE.MathUtils.clamp;

const LIM_DEG_Y = THREE.MathUtils.radToDeg(LIMITS.yaw) * 0.92;
const LIM_DEG_S = THREE.MathUtils.radToDeg(LIMITS.shoulder) * 0.92;
const LIM_DEG_K = THREE.MathUtils.radToDeg(LIMITS.knee) * 0.92;
const notSat = leg => { const a = leg.angles; return Math.abs(a.yaw) < LIM_DEG_Y && Math.abs(a.shoulder) < LIM_DEG_S && Math.abs(a.knee) < LIM_DEG_K; };
// Per-frame locomotion diagnostics are how the gait was tuned, so they stay in
// the build — behind a flag, because a visitor should not open the console to
// a wall of state dumps. Add ?debug to the URL to switch them back on.
const DEBUG = new URLSearchParams(location.search).has('debug');

// ---------------------------------------------------------------- scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
// the governor owns the pixel ratio from here
const govern = createResolutionGovernor(renderer);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
$('viewport').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);
scene.fog = new THREE.Fog(0x0b0d10, 22, 55);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(2.8, 2.0, 3.4);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0.35, 0);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.maxPolarAngle = Math.PI * 0.52;
orbit.minDistance = 0.8;
orbit.maxDistance = 30;

// A prefiltered room probe, same as the workbench: the printed parts are
// near-black PBR and read as a flat silhouette without an environment to sample.
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

// The probe supplies the ambient term, so the direct lights only have to carve
// shape. Pushing them harder flattens the chassis into a white sheet.
scene.add(new THREE.HemisphereLight(0x8fa3bf, 0x1a1410, 0.22));
const key = new THREE.DirectionalLight(0xfff2dd, 1.15);
key.position.set(6, 10, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xbcd0e8, 0.28);
fill.position.set(-5, 3, 8);
scene.add(fill);
const rim = new THREE.DirectionalLight(0x53d5e6, 0.6);
rim.position.set(-8, 4, -6);
scene.add(rim);

const grid = new THREE.GridHelper(40, 40, 0x2a323e, 0x1a2028);
grid.material.transparent = true;
grid.material.opacity = 0.85;
scene.add(grid);
const gridFine = new THREE.GridHelper(40, 200, 0x141a21, 0x12171d);
gridFine.position.y = -0.002;
scene.add(gridFine);

function makeRadialShadowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 3, 64, 64, 64);
  grd.addColorStop(0.0, 'rgba(0,0,0,0.95)');
  grd.addColorStop(0.45, 'rgba(0,0,0,0.45)');
  grd.addColorStop(1.0, 'rgba(0,0,0,0.0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
const bodyShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(1.9, 1.9),
  new THREE.MeshBasicMaterial({ map: makeRadialShadowTexture(), transparent: true, opacity: 0.32, depthWrite: false })
);
bodyShadow.rotation.x = -Math.PI / 2;
bodyShadow.position.y = 0.012;
bodyShadow.renderOrder = -1;
scene.add(bodyShadow);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- collision helpers
function pointInBlock(x, y, z) {
  for (const b of blocks) {
    const p = b.mesh.position;
    const halfW = b.w / 2, halfH = b.h / 2, halfL = b.l / 2;
    if (Math.abs(x - p.x) <= halfW && Math.abs(y - p.y) <= halfH && Math.abs(z - p.z) <= halfL) return true;
  }
  return false;
}
function footInBlock(x, y, z) {
  for (const b of blocks) {
    const p = b.mesh.position;
    const halfW = b.w / 2, halfH = b.h / 2, halfL = b.l / 2;
    const topY = p.y + halfH, bottomY = p.y - halfH;
    if (Math.abs(x - p.x) <= halfW && y < topY - 0.001 && y > bottomY + 0.001 && Math.abs(z - p.z) <= halfL) return true;
  }
  return false;
}
function boxHitsBlock(center, halfSize) {
  for (const b of blocks) {
    const p = b.mesh.position;
    const bHalf = { x: b.w / 2, y: b.h / 2, z: b.l / 2 };
    if (Math.abs(center.x - p.x) <= halfSize.x + bHalf.x &&
        Math.abs(center.y - p.y) <= halfSize.y + bHalf.y &&
        Math.abs(center.z - p.z) <= halfSize.z + bHalf.z) return true;
  }
  return false;
}
function heightAt(x, z) {
  let h = 0;
  for (const b of blocks) {
    const p = b.mesh.position;
    if (Math.abs(x - p.x) <= b.w / 2 && Math.abs(z - p.z) <= b.l / 2) h = Math.max(h, p.y + b.h / 2);
  }
  return h;
}
function heightAtFootprintDense(cx, cz, quat, halfW = 0.55, halfL = 0.55, step = 0.18) {
  const offsets = [];
  for (let x = -halfW; x <= halfW; x += step)
    for (let z = -halfL; z <= halfL; z += step) offsets.push([x, z]);
  for (let z = -halfL - step; z > -halfL - 0.5; z -= step)
    for (let x = -halfW * 0.7; x <= halfW * 0.7; x += step) offsets.push([x, z]);
  let maxH = heightAt(cx, cz);
  const temp = new THREE.Vector3();
  for (const [dx, dz] of offsets) {
    temp.set(dx, 0, dz).applyQuaternion(quat);
    maxH = Math.max(maxH, heightAt(cx + temp.x, cz + temp.z));
  }
  return maxH;
}

// ---------------------------------------------------------------- terrain blocks
const blocks = [];
const blockGeo = new THREE.BoxGeometry(1, 1, 1);
const blockMat = new THREE.MeshStandardMaterial({ color: 0x3e4a5a, roughness: 0.7, metalness: 0.1 });
const blockSelMat = blockMat.clone();
blockSelMat.emissive.setHex(0xf2a33c);
blockSelMat.emissiveIntensity = 0.25;
let selectedBlock = null;

function spawnBlock(w, h, l, pos) {
  const mesh = new THREE.Mesh(blockGeo, blockMat.clone());
  mesh.scale.set(w, h, l);
  mesh.position.set(pos.x, h / 2, pos.z);
  scene.add(mesh);
  const b = { mesh, w, h, l };
  blocks.push(b);
  selectBlock(b);
  return b;
}
function selectBlock(b) {
  if (selectedBlock) selectedBlock.mesh.material = blockMat.clone();
  selectedBlock = b;
  if (b) {
    b.mesh.material = blockSelMat.clone();
    $('inp-bw').value = b.w; $('inp-bh').value = b.h; $('inp-bl').value = b.l;
    syncBlockLabels();
  }
  $('btn-del-block').disabled = !b;
}
function resizeSelected() {
  if (!selectedBlock) return;
  const b = selectedBlock;
  b.w = parseFloat($('inp-bw').value);
  b.h = parseFloat($('inp-bh').value);
  b.l = parseFloat($('inp-bl').value);
  b.mesh.scale.set(b.w, b.h, b.l);
  b.mesh.position.y = b.h / 2;
}
function syncBlockLabels() {
  $('val-bw').textContent = parseFloat($('inp-bw').value).toFixed(2);
  $('val-bh').textContent = parseFloat($('inp-bh').value).toFixed(2);
  $('val-bl').textContent = parseFloat($('inp-bl').value).toFixed(2);
}
['inp-bw', 'inp-bh', 'inp-bl'].forEach(id => $(id).addEventListener('input', () => { syncBlockLabels(); resizeSelected(); }));
syncBlockLabels();

$('btn-spawn').addEventListener('click', () => {
  const pos = body.pos.clone().add(V(0, 0, -1.9));
  const blockHalf = { x: parseFloat($('inp-bw').value) / 2, y: parseFloat($('inp-bh').value) / 2, z: parseFloat($('inp-bl').value) / 2 };
  const blockCenter = V(pos.x, blockHalf.y, pos.z);
  if (boxHitsBlock(blockCenter, blockHalf)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      pos.z -= 0.5;
      blockCenter.set(pos.x, blockHalf.y, pos.z);
      if (!boxHitsBlock(blockCenter, blockHalf)) break;
    }
  }
  spawnBlock(parseFloat($('inp-bw').value), parseFloat($('inp-bh').value), parseFloat($('inp-bl').value), pos);
});
$('btn-del-block').addEventListener('click', () => {
  if (!selectedBlock) return;
  scene.remove(selectedBlock.mesh);
  blocks.splice(blocks.indexOf(selectedBlock), 1);
  selectBlock(null);
});

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let dragging = null;
renderer.domElement.addEventListener('pointerdown', e => {
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(blocks.map(b => b.mesh), false);
  if (hits.length) {
    const b = blocks.find(x => x.mesh === hits[0].object);
    selectBlock(b);
    const gp = V();
    raycaster.ray.intersectPlane(groundPlane, gp);
    dragging = { block: b, offset: gp.clone().sub(b.mesh.position).setY(0), startY: b.mesh.position.y };
    orbit.enabled = false;
  }
});
renderer.domElement.addEventListener('pointermove', e => {
  if (!dragging) return;
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const gp = V();
  if (raycaster.ray.intersectPlane(groundPlane, gp)) {
    dragging.block.mesh.position.x = gp.x - dragging.offset.x;
    dragging.block.mesh.position.z = gp.z - dragging.offset.z;
    dragging.block.mesh.position.y = dragging.startY;
  }
});
window.addEventListener('pointerup', () => { dragging = null; orbit.enabled = true; });
window.addEventListener('keydown', e => {
  if (e.code !== 'Escape') return;
  e.preventDefault();
  dragging = null; orbit.enabled = true; selectBlock(null);
});

// ---------------------------------------------------------------- input
const keys = {};
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code.startsWith('Arrow')) e.preventDefault();
  if (!e.repeat) {
    if (e.code === 'KeyR') { turnMode = !turnMode; updateModeUI(); }
    if (e.code === 'KeyY') { povMode = !povMode; updateModeUI(); }
    if (e.code === 'KeyP') togglePanels();
  }
  keys[e.code] = true;
});

// the panels sit over the course on a laptop screen — P clears the view
function togglePanels() {
  const hidden = $('left-panel').classList.toggle('collapsed');
  $('right-panel').classList.toggle('collapsed', hidden);
  const btn = $('btn-panels');
  btn.setAttribute('aria-expanded', String(!hidden));
  btn.classList.toggle('on', hidden);
}
$('btn-panels').addEventListener('click', togglePanels);
window.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
function updateModeUI() {
  const md = $('t-mode'); if (md) md.textContent = turnMode ? 'A/D: TURN' : 'A/D: STRAFE';
  const cm = $('t-cam'); if (cm) cm.textContent = povMode ? 'POV' : 'ORBIT';
}

// ---------------------------------------------------------------- robot & gait
const UP = V(0, 1, 0);
const body = {
  pos: V(0, 0, 0), heightOffset: 0, vel: V(), heading: 0,
  terrainQuat: new THREE.Quaternion(), manualPitch: 0, manualRoll: 0,
  quat: new THREE.Quaternion(), quatInv: new THREE.Quaternion(), heightVel: 0,
};
const MAX_TILT = 0.30, MANUAL_TILT = 0.2, TURN_RATE = 0.45;
const LEG_MAP = [4, 3, 1, 2, 5, 6, 8, 7];
const REACH_PLAN = 0.90;

let PLATE_CENTER_Y = 0.30, PLATE_BOTTOM_Y = 0.10, PLATE_TOP_Y = 0.50;
let PLATE_HALF_X = 0.55, PLATE_HALF_Z = 0.55;
let FLOOR_ROOT_Y = -0.07;
const plateSamples = [];   // root-local chassis samples for the tilt-aware belly clearance
const _bcS = V();          // scratch for bodyClearFloor()
let g_bandLo = -0.10, g_bandHi = 0.35;     // boot-measured comfortable root.y band (fallback)
let g_envLoLive = NaN, g_envHiLive = NaN;  // live notSat band (RNG readout only)
let g_autoTarget = 0;                      // smoothed MAX-STABILITY body root.y (the height we aim for)
const MAX_RISE = 0.30;                     // body can't ride more than this above the support plane (anti-dangle)
let envT = 0;
let g_bodyBlockTop = NaN;
const BODY_RADIUS = 0.42;

const baseClear = [], baseYaw = [], curClear = [], curYaw = [], legDanger = [];

let g_strand = [];
const coop = { pos: V(), valid: false, strand: [], reachAtCoop: [], t: 0 };
const COOP_HZ = 8;

const _tq = new THREE.Quaternion();
const _qHead = new THREE.Quaternion();
const _qMan = new THREE.Quaternion();
const _eMan = new THREE.Euler();
const _tv = V();
const _camD = V();
const _fwd = V(), _right = V();
const _savePos = V();
const _sz = V();
const _hipW = V();
const _upB = V();                          // scratch for the HUD tilt readout (NOT fed into control)
const _d1 = V(), _d2 = V(), _r = V(), _c1 = V(), _c2 = V();
const _h1 = new THREE.Vector2(), _h2 = new THREE.Vector2(), _hp = new THREE.Vector2(), _hd = new THREE.Vector2();

let turnMode = false, povMode = false;
const GAIT = { cycle: 1.15, lift: 0.13, speed: 0.42, heightRange: [-0.30, 0.30], heightRate: 0.55 };
const HEIGHT_CMD_RANGE = 0.18;
let assertClock = 0;

let rig = null;
const legState = [];
let legRing = [];
let gaitPhase = 0, lastGroup = -1, repositionCooldown = 0;
let speedScale = 1.0;
let supportRecoveryActive = false;

const g_diag = { unstable: false, soft: false, sat: 0, vel: 0, float: 0, danger: 0, col: 0, tilt: 0, yawMax: 0,
                 strand: 0, walled: 0, blk: NaN, coop: false, climb: false,
                 feasible: true, planted: 8, comIn: true, area: 0, lo: NaN, hi: NaN,
                 cmd: false, state: 'BOOT' };
let debugCounter = 0;

function initLegs() {
  legState.length = 0;
  const order = rig.legs.map((leg, i) => ({ leg, i, ang: Math.atan2(leg.footRest.z, leg.footRest.x) }))
    .sort((a, b) => a.ang - b.ang);
  legRing = order.map(o => o.i);
  const n = order.length;
  order.forEach((o, k) => {
    legState[o.i] = {
      planted: o.leg.footRest.clone(),
      home: o.leg.footRest.clone().multiplyScalar(0.92),
      swing: null, group: k % 2, noHold: 0, distress: 0, saturated: false, danger: false, assist: false,
      walled: false, _climb: V(), _climbGap: 0,
      _nb: [order[(k - 1 + n) % n].i, order[(k + 1) % n].i],
      _sw: V(), _kw: V(), _fw: V(), _curTarget: V(), _float: 0, _wantRing: V(),
    };
    legDanger[o.i] = 0;
    baseClear[o.i] = Infinity; baseYaw[o.i] = 0;
    curClear[o.i] = Infinity; curYaw[o.i] = 0;
  });
}

function measureChassisPlate() {
  const legGroups = new Set();
  for (const l of rig.legs) { legGroups.add(l.hip); legGroups.add(l.shoulder); legGroups.add(l.knee); }
  const isLegMesh = (o) => { let p = o; while (p) { if (legGroups.has(p)) return true; p = p.parent; } return false; };
  const box = new THREE.Box3(), tmp = new THREE.Box3();
  let any = false;
  rig.root.updateMatrixWorld(true);
  rig.root.traverse(o => {
    if (!o.isMesh || isLegMesh(o)) return;
    tmp.setFromObject(o);
    if (tmp.isEmpty()) return;
    if (!any) { box.copy(tmp); any = true; } else box.union(tmp);
  });
  if (!any) return;
  const c = box.getCenter(V());
  const s = box.getSize(_sz);
  PLATE_CENTER_Y = c.y; PLATE_BOTTOM_Y = box.min.y; PLATE_TOP_Y = box.max.y;
  PLATE_HALF_X = s.x * 0.5 * 1.05; PLATE_HALF_Z = s.z * 0.5 * 1.05;
  FLOOR_ROOT_Y = -PLATE_BOTTOM_Y + 0.03;
  // Belly-clearance samples in root-local space. Rotated by the FULL body.quat each
  // frame, so a plate corner that tilts down over a block corner is caught — the
  // level-box test in computeBodyBlockTop assumes the plate is flat and misses it.
  // 5x5 on the belly plane covers the star's corners/edges/hub; 3x3 at mid-thickness
  // catches a corner poking up into the plate body.
  const hx = s.x * 0.5, hz = s.z * 0.5, yB = PLATE_BOTTOM_Y, yM = (PLATE_BOTTOM_Y + PLATE_TOP_Y) * 0.5;
  plateSamples.length = 0;
  for (let gx = -1; gx <= 1.001; gx += 0.5)
    for (let gz = -1; gz <= 1.001; gz += 0.5)
      plateSamples.push(V(c.x + gx * hx, yB, c.z + gz * hz));
  for (let gx = -1; gx <= 1.001; gx += 1)
    for (let gz = -1; gz <= 1.001; gz += 1)
      plateSamples.push(V(c.x + gx * hx, yM, c.z + gz * hz));
}

function calibratePOV() {
  const legGroups = new Set();
  for (const l of rig.legs) { legGroups.add(l.hip); legGroups.add(l.shoulder); legGroups.add(l.knee); }
  const isLegMesh = (o) => { let p = o; while (p) { if (legGroups.has(p)) return true; p = p.parent; } return false; };
  const box = new THREE.Box3(), tmp = new THREE.Box3();
  let any = false;
  rig.root.updateMatrixWorld(true);
  rig.root.traverse(o => {
    if (!o.isMesh || isLegMesh(o)) return;
    tmp.setFromObject(o);
    if (tmp.isEmpty()) return;
    if (!any) { box.copy(tmp); any = true; } else box.union(tmp);
  });
  if (!any) { povCam.position.set(0, 0.30, -0.45); povCam.rotation.set(-0.14, 0, 0); return; }
  const c = box.getCenter(V());
  const s = box.getSize(_sz);
  povCam.position.set(0, c.y + s.y * 0.02, box.min.z - 0.03);
  povCam.rotation.set(-0.14, 0, 0);
  povCam.updateProjectionMatrix();
}

function calibrateStance() {
  const qx = body.pos.x, qz = body.pos.z;
  body.pos.set(qx, 0, qz);
  body.quat.identity(); body.quatInv.identity(); body.terrainQuat.identity();
  body.manualPitch = 0; body.manualRoll = 0; body.heightOffset = 0; body.heightVel = 0;
  rig.root.position.copy(body.pos); rig.root.quaternion.copy(body.quat);
  rig.root.updateMatrixWorld(true);
  const restTargets = rig.legs.map(l => V(qx + l.footRest.x, 0, qz + l.footRest.z));
  for (let i = 0; i < rig.legs.length; i++) rig.solveLeg(rig.legs[i], restTargets[i]);
  rig.root.updateMatrixWorld(true);
  for (let i = 0; i < rig.legs.length; i++) {
    const fw = rig.footWorld(rig.legs[i]);
    legState[i].planted.set(fw.x, fw.y, fw.z);
    legState[i].home.set(rig.legs[i].footRest.x * 0.92, rig.legs[i].footRest.y * 0.92, rig.legs[i].footRest.z * 0.92);
  }
  const limY = THREE.MathUtils.radToDeg(LIMITS.yaw) * 0.95;
  const limS = THREE.MathUtils.radToDeg(LIMITS.shoulder) * 0.95;
  const limK = THREE.MathUtils.radToDeg(LIMITS.knee) * 0.95;
  const okAt = (h) => {
    rig.root.position.set(qx, h, qz); rig.root.updateMatrixWorld(true);
    for (let i = 0; i < rig.legs.length; i++) {
      rig.solveLeg(rig.legs[i], restTargets[i]);
      if (Math.abs(rig.footWorld(rig.legs[i]).y) > 0.025) return false;
      const a = rig.legs[i].angles;
      if (Math.abs(a.yaw) > limY || Math.abs(a.shoulder) > limS || Math.abs(a.knee) > limK) return false;
    }
    return true;
  };
  let hi = 0; for (let h = 0.02; h <= 0.7; h += 0.02) { if (okAt(h)) hi = h; else break; }
  let loLeg = 0; for (let h = -0.02; h >= -0.5; h -= 0.02) { if (okAt(h)) loLeg = h; else break; }
  g_bandHi = Math.max(hi, 0.10);
  g_bandLo = Math.max(loLeg, FLOOR_ROOT_Y);
  rig.root.position.set(qx, 0, qz); rig.root.updateMatrixWorld(true);
  for (let i = 0; i < rig.legs.length; i++) rig.solveLeg(rig.legs[i], restTargets[i]);
  rig.root.updateMatrixWorld(true);
  computeClearances(baseClear, baseYaw);
  g_autoTarget = 0;            // rest shape = root.y 0 = the max-stability pose on flat ground
  orbit.target.set(qx, PLATE_CENTER_Y, qz);
}

function computeBodyBlockTop() {
  if (!blocks.length) return NaN;
  const ch = Math.abs(Math.cos(body.heading)), sh = Math.abs(Math.sin(body.heading));
  const wx = PLATE_HALF_X * ch + PLATE_HALF_Z * sh;
  const wz = PLATE_HALF_X * sh + PLATE_HALF_Z * ch;
  const x0 = body.pos.x - wx, x1 = body.pos.x + wx;
  const z0 = body.pos.z - wz, z1 = body.pos.z + wz;
  const y0 = body.pos.y + PLATE_BOTTOM_Y, y1 = body.pos.y + PLATE_TOP_Y;
  let top = NaN;
  for (const b of blocks) {
    const p = b.mesh.position;
    const bx0 = p.x - b.w / 2, bx1 = p.x + b.w / 2;
    const bz0 = p.z - b.l / 2, bz1 = p.z + b.l / 2;
    const by0 = p.y - b.h / 2, by1 = p.y + b.h / 2;
    if (x1 < bx0 || x0 > bx1 || z1 < bz0 || z0 > bz1 || y1 < by0 || y0 > by1) continue;
        if (!isFinite(top) || by1 > top) top = by1;
  }
  return top;
}

// ORIENTATION-AWARE plate-vs-block clearance (corner-clip fix). computeBodyBlockTop
// models the chassis as a LEVEL axis-box, so when the body tilts over a block corner
// a dipped corner of the star plate punches ~10 cm into the slab while the level test
// still reports clearance — and a rake against the vertical corner edge (contact XZ
// just outside the top face) gets no lift at all. Here we rotate real plate samples
// by the full body quaternion, expand each block by a horizontal proximity pad so the
// body lifts *before* a plate corner reaches the face ("too close"), and demand the
// lowest over-block sample stay BELLY_MARGIN above the top. Returns the minimum
// body.pos.y that satisfies every block, or -Infinity when nothing is near. On flat
// ground and level riding this matches the old ~6 cm gap; it only adds height when a
// tilted / approaching corner actually needs it.
const BELLY_PROXIMITY = 0.06;   // horizontal pad (m): pre-lift as a plate corner nears a face
const BELLY_MARGIN    = 0.06;   // vertical gap (m) kept between the lowest plate point and any top
function bodyClearFloor() {
  if (!blocks.length || !plateSamples.length) return -Infinity;
  let need = -Infinity;
  for (const b of blocks) {
    const p = b.mesh.position;
    const px0 = p.x - b.w / 2 - BELLY_PROXIMITY, px1 = p.x + b.w / 2 + BELLY_PROXIMITY;
    const pz0 = p.z - b.l / 2 - BELLY_PROXIMITY, pz1 = p.z + b.l / 2 + BELLY_PROXIMITY;
    const top = p.y + b.h / 2;
    let lowOver = Infinity, anyOver = false;
    for (const q of plateSamples) {
      _bcS.copy(q).applyQuaternion(body.quat);          // root-local plate point -> body-rotated offset
      const wx = body.pos.x + _bcS.x, wz = body.pos.z + _bcS.z;
      if (wx < px0 || wx > px1 || wz < pz0 || wz > pz1) continue;
      if (_bcS.y < lowOver) lowOver = _bcS.y;            // lowest plate point (rel. to body.pos) over this block
      anyOver = true;
    }
    if (!anyOver) continue;
    const req = top + BELLY_MARGIN - lowOver;            // body.pos.y that puts that lowest point at top + MARGIN
    if (req > need) need = req;
  }
  return need;
}

function segSeg(a0, a1, b0, b1) {
  _d1.subVectors(a1, a0); _d2.subVectors(b1, b0); _r.subVectors(a0, b0);
  const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
  const EPS = 1e-10;
  let s, t;
  if (a <= EPS && e <= EPS) return a0.distanceTo(b0);
  if (a <= EPS) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = _d1.dot(_r);
    if (e <= EPS) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = _d1.dot(_d2);
      const den = a * e - b * b;
      s = den > EPS ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  _c1.copy(a0).addScaledVector(_d1, s);
  _c2.copy(b0).addScaledVector(_d2, t);
  return _c1.distanceTo(_c2);
}
function segBodyClearance(a0, a1) {
  const yLo = body.pos.y + PLATE_BOTTOM_Y, yHi = body.pos.y + PLATE_TOP_Y;
  const y0 = a0.y, y1 = a1.y;
  let t0 = 0, t1 = 1;
  if (y1 > y0) { if (y0 > yHi || y1 < yLo) return 1.0; t0 = Math.max(0, (yLo - y0) / (y1 - y0)); t1 = Math.min(1, (yHi - y0) / (y1 - y0)); }
  else if (y1 < y0) { if (y1 > yHi || y0 < yLo) return 1.0; t0 = Math.max(0, (yHi - y0) / (y1 - y0)); t1 = Math.min(1, (yLo - y0) / (y1 - y0)); }
  else { if (y0 < yLo || y0 > yHi) return 1.0; }
  const ax = a0.x + (a1.x - a0.x) * t0, az = a0.z + (a1.z - a0.z) * t0;
  const bx = a0.x + (a1.x - a0.x) * t1, bz = a0.z + (a1.z - a0.z) * t1;
  _h1.set(ax, az); _h2.set(bx, bz); _hp.set(body.pos.x, body.pos.z);
  _hd.subVectors(_h2, _h1); const len2 = _hd.lengthSq();
  const t = len2 > 1e-10 ? clamp(_hp.clone().sub(_h1).dot(_hd) / len2, 0, 1) : 0;
  const hx = _h1.x + _hd.x * t, hz = _h1.y + _hd.y * t;
  return Math.hypot(hx - _hp.x, hz - _hp.y) - BODY_RADIUS;
}
function computeClearances(outClear, outYaw) {
  for (let i = 0; i < legState.length; i++) {
    const st = legState[i], leg = rig.legs[i];
    leg.shoulder.getWorldPosition(st._sw);
    leg.knee.getWorldPosition(st._kw);
    st._fw.copy(rig.footWorld(leg));
  }
  for (let i = 0; i < legState.length; i++) {
    const A = legState[i];
    const segsA = [[A._sw, A._kw], [A._kw, A._fw]];
    let clr = Infinity;
    for (const ni of A._nb) {
      const B = legState[ni];
      const segsB = [[B._sw, B._kw], [B._kw, B._fw]];
      for (const sa of segsA) for (const sb of segsB) {
        const d = segSeg(sa[0], sa[1], sb[0], sb[1]);
        if (d < clr) clr = d;
      }
    }
    for (const sa of segsA) { const bc = segBodyClearance(sa[0], sa[1]); if (bc < clr) clr = bc; }
    outClear[i] = clr;
    outYaw[i] = Math.abs(rig.legs[i].angles.yaw);
  }
}

function reachableSurfaceTarget(i, atPos) {
  const st = legState[i], leg = rig.legs[i];
  _savePos.copy(rig.root.position);
  rig.root.position.copy(atPos); rig.root.updateMatrixWorld(true);
  const want = atPos.clone().add(_tv.copy(st.home).applyQuaternion(body.quat));
  want.y = heightAt(want.x, want.z);
  let best = null, bestD = Infinity;
  const test = (c) => {
    rig.solveLeg(leg, c);
    const f = rig.footWorld(leg);
    const fl = f.y - heightAt(f.x, f.z);
    if (fl < 0.04 && notSat(leg)) {
      const d = Math.hypot(c.x - want.x, c.z - want.z) + Math.abs(c.y - want.y);
      if (d < bestD) { bestD = d; best = c.clone(); }
    }
  };
  test(st.planted.clone());
  test(want.clone());
  for (const ox of [-0.14, -0.07, 0, 0.07, 0.14])
    for (const oz of [-0.14, -0.07, 0, 0.07, 0.14]) {
      if (ox === 0 && oz === 0) continue;
      const c = V(want.x + ox, 0, want.z + oz); c.y = heightAt(c.x, c.z); test(c);
    }
  rig.root.position.copy(_savePos); rig.root.updateMatrixWorld(true);
  rig.solveLeg(leg, st._curTarget);
  rig.root.updateMatrixWorld(true);
  return best || st.planted.clone();
}

function cooperativeSolve() {
  const plantedIdx = [];
  legState.forEach((st, i) => { if (!st.swing) plantedIdx.push(i); });
  if (g_strand.length === 0 || plantedIdx.length < 3) {
    coop.valid = false; coop.strand = [];
    for (let i = 0; i < legState.length; i++) legState[i].assist = false;
    return;
  }
  const save = _savePos.clone();
  const base = body.pos;
  const supY = plantedIdx.reduce((s, i) => s + legState[i].planted.y, 0) / plantedIdx.length;
  const yLo = Math.max(g_bandLo + supY, base.y - 0.28);
  const yHi = Math.min(g_bandHi + supY, base.y + 0.28);
  let bestPos = base.clone(), bestCost = Infinity;
  const offs = [-0.12, -0.06, 0, 0.06, 0.12];
  for (let s = 0; s < 4; s++) {
    const y = yLo + (yHi - yLo) * (s / 3);
    for (const dx of offs) for (const dz of offs) {
      rig.root.position.set(base.x + dx, y, base.z + dz); rig.root.updateMatrixWorld(true);
      let cost = 0;
      for (const i of g_strand) {
        const leg = rig.legs[i];
        rig.solveLeg(leg, legState[i].planted);
        const f = rig.footWorld(leg);
        cost += Math.max(0, f.y - heightAt(f.x, f.z));
      }
      cost += (Math.abs(dx) + Math.abs(dz)) * 0.25 + Math.abs(y - base.y) * 0.25;
      if (cost < bestCost) { bestCost = cost; bestPos.set(base.x + dx, y, base.z + dz); }
    }
  }
  rig.root.position.copy(bestPos); rig.root.updateMatrixWorld(true);
  const reach = [], newStrand = [];
  for (const i of plantedIdx) {
    const leg = rig.legs[i];
    rig.solveLeg(leg, legState[i].planted);
    const f = rig.footWorld(leg);
    const fl = f.y - heightAt(f.x, f.z);
    const ok = fl < 0.04 && notSat(leg);
    reach[i] = ok;
    if (!ok && !legState[i].swing) newStrand.push(i);
  }
  coop.pos.copy(bestPos); coop.valid = true; coop.strand = newStrand; coop.reachAtCoop = reach;
  for (let i = 0; i < legState.length; i++)
    legState[i].assist = newStrand.length > 0 && !g_strand.includes(i) && !legState[i].swing && reach[i] === false;
  rig.root.position.copy(save); rig.root.updateMatrixWorld(true);
  for (let i = 0; i < legState.length; i++) rig.solveLeg(rig.legs[i], legState[i]._curTarget);
  rig.root.updateMatrixWorld(true);
}

function swingArc(from, to, t) {
  const p = from.clone().lerp(to, t);
  const peak = Math.max(from.y, to.y) + GAIT.lift;
  const base = from.y + (to.y - from.y) * t;
  p.y = base + (peak - base) * Math.sin(Math.PI * t);
  return p;
}

function reachOK(leg, bodyPos, p, margin = REACH_PLAN) {
  _tv.set(p.x - bodyPos.x, p.y - bodyPos.y, p.z - bodyPos.z).applyQuaternion(body.quatInv);
  const dx = _tv.x - leg.P_hip.x, dy = _tv.y - leg.P_hip.y, dz = _tv.z - leg.P_hip.z;
  const dr = dx * leg.e_r.x + dz * leg.e_r.z, dt = dx * leg.e_t.x + dz * leg.e_t.z;
  const rho = Math.hypot(dr, dt);
  if (rho <= Math.abs(leg.lat) + 1e-4) return false;
  const th0 = Math.atan2(dt, dr) - Math.asin(clamp(leg.lat / rho, -1, 1));
  if (Math.abs(th0) > LIMITS.yaw * 0.95) return false;
  const rEff = Math.sqrt(rho * rho - leg.lat * leg.lat);
  const pr = rEff - leg.s_r, py = dy - leg.s_y;
  const D = Math.hypot(pr, py);
  if (D > (leg.L1 + leg.L2) * margin) return false;
  if (D < Math.abs(leg.L1 - leg.L2) * 1.10 + 0.01) return false;
  const base = Math.atan2(py, pr);
  const off = Math.acos(clamp((leg.L1 * leg.L1 + D * D - leg.L2 * leg.L2) / (2 * leg.L1 * D), -1, 1));
  const c1 = base + off, c2 = base - off;
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const a1 = Math.abs(wrap(c1 - leg.a1_rest)) <= Math.abs(wrap(c2 - leg.a1_rest)) ? c1 : c2;
  const a2 = Math.atan2(py - leg.L1 * Math.sin(a1), pr - leg.L1 * Math.cos(a1)) - a1;
  if (Math.abs(wrap(a1 - leg.a1_rest)) > LIMITS.shoulder * 0.95) return false;
  if (Math.abs(wrap(wrap(a2) - leg.a2_rest)) > LIMITS.knee * 0.95) return false;
  return true;
}

function adjustFoothold(i, from, want, bodyAtLand) {
  const leg = rig.legs[i];
  const c = V();
  let best = null, bestScore = Infinity;
  const isOnBlock = (x, y, z) => {
    for (const b of blocks) {
      const p = b.mesh.position;
      const halfW = b.w / 2, halfH = b.h / 2, halfL = b.l / 2;
      if (Math.abs(x - p.x) <= halfW && Math.abs(z - p.z) <= halfL) {
        if (Math.abs(y - (p.y + halfH)) < 0.03) return true;
      }
    }
    return false;
  };
  const consider = (pos) => {
    if (footInBlock(pos.x, pos.y, pos.z)) return false;
    if (!reachOK(leg, bodyAtLand, pos, REACH_PLAN)) return false;
    let score = pos.distanceTo(want);
    const onB = isOnBlock(pos.x, pos.y, pos.z), wantB = isOnBlock(want.x, want.y, want.z);
    if (onB && wantB) score -= 0.20; else if (onB && !wantB) score -= 0.10; else if (!onB && wantB) score += 0.20;
    if (score < bestScore) { bestScore = score; best = pos.clone(); }
    return true;
  };
  for (let s = 12; s >= 0; s--) {
    c.copy(from).lerp(want, s / 12); c.y = heightAt(c.x, c.z);
    if (consider(c)) break;
  }
  if (best) return best;
  const restR = Math.hypot(leg.footRest.x - leg.P_hip.x, leg.footRest.z - leg.P_hip.z);
  const hipW = _tv.copy(leg.P_hip).applyQuaternion(body.quat);
  const hx = bodyAtLand.x + hipW.x, hz = bodyAtLand.z + hipW.z;
  const erW = V().copy(leg.e_r).applyQuaternion(body.quat);
  const baseAng = Math.atan2(erW.z, erW.x);
  for (const rf of [0.95, 0.85, 0.75, 0.65, 0.55, 1.05])
    for (const da of [0, 0.18, -0.18, 0.34, -0.34, 0.48, -0.48]) {
      const a = baseAng + da, r = restR * rf;
      c.set(hx + Math.cos(a) * r, 0, hz + Math.sin(a) * r); c.y = heightAt(c.x, c.z);
      consider(c);
    }
  return best;
}

function startSwing(i, dur, futureBody, wantOverride) {
  const st = legState[i];
  if (st.swing) return;
  const bodyAtLand = futureBody || body.pos.clone().add(body.vel.clone().multiplyScalar(dur * 0.5));
  if (bodyAtLand.y < g_bandLo + 0.05) bodyAtLand.y = g_bandLo + 0.10;
  const want = wantOverride
    ? wantOverride.clone()
    : bodyAtLand.clone().add(_tv.copy(st.home).applyQuaternion(body.quat));
  want.y = heightAt(want.x, want.z);
  if (footInBlock(want.x, want.y, want.z)) want.y = heightAt(want.x, want.z) + 0.05;
  let to;
  if (wantOverride) to = adjustFoothold(i, st.planted, wantOverride, bodyAtLand) || wantOverride;
  else if (st._float > 0.05 && coop.valid) to = reachableSurfaceTarget(i, bodyAtLand);
  else to = adjustFoothold(i, st.planted, want, bodyAtLand) || want;
  st.noHold = 0;
  st.swing = { t: 0, dur, from: st.planted.clone(), to };
}

function computeSupportPolygon() {
  const planted = legState.filter(s => !s.swing).map(s => ({ x: s.planted.x, z: s.planted.z }));
  if (planted.length < 3) return null;
  const sorted = planted.slice().sort((a, b) => a.x - b.x || a.z - b.z);
  const lower = [];
  for (const p of sorted) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (const p of sorted.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : null;
}
function cross(o, a, b) { return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x); }
function pointInPolygon(px, pz, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z, xj = polygon[j].x, zj = polygon[j].z;
    if (((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function polygonArea(poly) {
  let area = 0;
  for (let i = 0; i < poly.length; i++) { const j = (i + 1) % poly.length; area += poly[i].x * poly[j].z - poly[j].x * poly[i].z; }
  return Math.abs(area) / 2;
}
function predictBody(dt) { return body.pos.clone().add(body.vel.clone().multiplyScalar(dt)); }

// ---------------------------------------------------------------- main gait update
function updateGait(dt) {
  const prevBodyPos = _camD.copy(body.pos).clone();
  // last frame's float/saturation drive this frame's walk-caution (no ordering cycle)
  const prevFloat = g_diag.float, prevSat = g_diag.sat;
  const caution = clamp(Math.max(prevFloat - 0.05, 0) * 3 + (prevSat >= 6 ? 0.4 : 0), 0, 0.8);

  // 1. INPUT
  let turning = 0;
  if (turnMode) turning = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);
  if (turning) body.heading += turning * TURN_RATE * dt;
  _fwd.set(0, 0, -1).applyAxisAngle(UP, body.heading);
  _right.set(1, 0, 0).applyAxisAngle(UP, body.heading);
  const fwdIn = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  const strIn = turnMode ? 0 : (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  const dir = _tv.set(0, 0, 0).addScaledVector(_fwd, fwdIn).addScaledVector(_right, strIn);
  const translating = dir.lengthSq() > 0;
  if (translating) dir.normalize().multiplyScalar(GAIT.speed);
  body.vel.copy(dir);

  // Q/E is a MOMENTARY nudge that springs back to 0 on release (same easing as
  // the arrow keys' lean). The body's resting height is owned by the max-
  // stability system (§9 / §16) — there is no stored manual value, so a bad
  // height can never linger.
  const heightCmd = ((keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0)) * HEIGHT_CMD_RANGE;
  const kh = Math.min(1, dt * 6);
  body.heightOffset += (heightCmd - body.heightOffset) * kh;
  if (Math.abs(body.heightOffset) < 1e-4) body.heightOffset = 0;

  const pitchTarget = ((keys.ArrowDown ? 1 : 0) - (keys.ArrowUp ? 1 : 0)) * MANUAL_TILT;
  const rollTarget = ((keys.ArrowLeft ? 1 : 0) - (keys.ArrowRight ? 1 : 0)) * MANUAL_TILT;
  const kt = Math.min(1, dt * 6);
  body.manualPitch += (pitchTarget - body.manualPitch) * kt;
  body.manualRoll += (rollTarget - body.manualRoll) * kt;

  // 2. TERRAIN AHEAD
  const futureBodyPos = predictBody(0.4);
  const futureTerrainH = heightAtFootprintDense(futureBodyPos.x, futureBodyPos.z, body.quat);
  const currentTerrainH = heightAtFootprintDense(body.pos.x, body.pos.z, body.quat);
  const terrainH = Math.max(currentTerrainH, futureTerrainH * 0.5 + currentTerrainH * 0.5);

  // 3. UPDATE FEET
  legState.forEach((st, i) => {
    if (st.swing) {
      st.swing.t += dt / st.swing.dur;
      if (st.swing.t >= 1) {
        st.planted.copy(st.swing.to);
        st.planted.y = heightAt(st.planted.x, st.planted.z);
        if (footInBlock(st.planted.x, st.planted.y, st.planted.z)) st.planted.y = heightAt(st.planted.x, st.planted.z) + 0.02;
        st.swing = null;
      }
    } else {
      st.planted.y = heightAt(st.planted.x, st.planted.z);
    }
  });

  // 4. SUPPORT
  const plantedLegs = [];
  legState.forEach((st, i) => { if (!st.swing) plantedLegs.push({ ...st, index: i }); });
  const plantedCount = plantedLegs.length;
  const anySwing = legState.some(s => s.swing);
  const supportPoly = computeSupportPolygon();
  let comInside = false, polyArea = 0;
  if (supportPoly) { polyArea = polygonArea(supportPoly); comInside = pointInPolygon(body.pos.x, body.pos.z, supportPoly); }
  const supportY = plantedCount ? plantedLegs.reduce((s, st) => s + st.planted.y, 0) / plantedCount : 0;

  // 5/6. HARD stop only on genuine loss of support; CAUTION eases the walk when
  // the previous frame had floating / saturated legs, so the robot stops marching
  // into a void and gives its feet time to re-plant (kills the edge flail loop).
  const unstable = plantedCount < 3;
  supportRecoveryActive = unstable;
  if (unstable) { speedScale = Math.max(0.0, speedScale - dt * 5); body.vel.set(0, 0, 0); }
  else speedScale = Math.min(1.0, speedScale + dt * 3);
  speedScale = Math.min(speedScale, 1.0 - caution);

  // 7. HORIZONTAL MOVE (user)
  const currentSpeed = body.vel.length() * speedScale;
  if (currentSpeed > 0.001) {
    const moveDir = body.vel.clone().normalize();
    body.pos.x += moveDir.x * currentSpeed * dt;
    body.pos.z += moveDir.z * currentSpeed * dt;
  }

  // 7b. COOPERATIVE CREEP — ease toward the rescue pose horizontally while idle
  if (coop.valid && g_strand.length > 0 && !translating && !unstable) {
    const supportNow = plantedCount - g_strand.length;
    if (supportNow >= 4) {
      const dx = coop.pos.x - body.pos.x, dz = coop.pos.z - body.pos.z;
      const m = Math.hypot(dx, dz);
      if (m > 0.01) { const step = Math.min(m, 0.6 * dt); body.pos.x += dx / m * step; body.pos.z += dz / m * step; }
    }
  }

  // 8. ORIENTATION
  const supportPositions = plantedLegs.map(st => st.planted);
  if (supportPositions.length >= 3) {
    const c = V(); supportPositions.forEach(p => c.add(p)); c.divideScalar(supportPositions.length);
    const ring = supportPositions.slice().sort((a, b) => Math.atan2(a.z - c.z, a.x - c.x) - Math.atan2(b.z - c.z, b.x - c.x));
    const n = V();
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      n.x += (p.y - q.y) * (p.z + q.z); n.y += (p.z - q.z) * (p.x + q.x); n.z += (p.x - q.x) * (p.y + q.y);
    }
    if (n.lengthSq() > 1e-9) {
      n.normalize(); if (n.y < 0) n.negate();
      const ang = Math.acos(clamp(n.dot(UP), -1, 1));
      if (ang > MAX_TILT) n.copy(UP).lerp(n, MAX_TILT / ang).normalize();
      _tq.setFromUnitVectors(UP, n);
      body.terrainQuat.slerp(_tq, Math.min(1, dt * 4.0));
    }
  }
  _qHead.setFromAxisAngle(UP, body.heading);
  _qMan.setFromEuler(_eMan.set(body.manualPitch, 0, body.manualRoll, 'XYZ'));
  body.quat.copy(body.terrainQuat).multiply(_qHead).multiply(_qMan);
  body.quatInv.copy(body.quat).invert();
  // HUD tilt readout only — measured from the actual body, never fed back into control.
  _upB.set(0, 1, 0).applyQuaternion(body.quat);
  g_diag.tilt = THREE.MathUtils.radToDeg(Math.acos(clamp(_upB.y, -1, 1)));

  // 9. BODY HEIGHT — the resting height is the MAX-STABILITY pose: the body
  // root.y that minimises the worst per-joint utilisation across every planted
  // leg (most servo slack = most stable), computed in §16 and exponentially
  // smoothed into g_autoTarget so the body glides instead of chasing a 8 Hz
  // stepping setpoint (the step-chase was the visible clip/fix oscillation, and
  // the old "top of the reach band" rule picked the most EXTENDED, saturated
  // pose and made the chassis dangle at H~0.95). Q/E adds a momentary nudge that
  // springs to 0. A hard ceiling of supportY + MAX_RISE stops any dangle; the
  // belly clearance floor stops any clip. The spring is critically-ish damped so
  // it eases into the setpoint with no overshoot.
  const autoBase = isFinite(g_autoTarget) ? g_autoTarget : supportY;
  const preferred = autoBase + body.heightOffset;
  g_bodyBlockTop = computeBodyBlockTop();
    let clearFloor = Math.max(
    isFinite(g_bodyBlockTop) ? (g_bodyBlockTop - PLATE_BOTTOM_Y + 0.06) : -Infinity,
    bodyClearFloor(),   // tilt-aware + proximity: lift when a (tilted) plate corner nears / clips a block corner
  );
  // LOOK-AHEAD BELLY (climb-onset clip fix). Moving into a *climbable* step in ANY
  // direction — forward, backward, or strafe — raise the body *before* the plate is
  // actually over it, so the leading legs' first swing meets the edge from bridging
  // height instead of raking the face for a stride at ground height. The look-ahead
  // point is projected along the actual travel direction (body.vel), not just the
  // heading, so backing or strafing into a step lifts exactly like walking forward.
  // Gated on translating + a mountable ahead step, so idle-in-front-of-a-wall and
  // unclimbable walls don't pre-crouch, and a pure turn (translating false) never
  // triggers it.
  if (translating && body.vel.lengthSq() > 1e-6) {
    const LOOK = 0.55;
    const travelDir = _tv.copy(body.vel).normalize();
    const lx = body.pos.x + travelDir.x * LOOK, lz = body.pos.z + travelDir.z * LOOK;
    const aheadTop = heightAtFootprintDense(lx, lz, body.quat);
    if (aheadTop - supportY <= 0.55) {                 // 0.55 ≈ climbable step ceiling
      const aheadClear = aheadTop - PLATE_BOTTOM_Y + 0.06;
      if (aheadClear > clearFloor) clearFloor = aheadClear;
    }
  }
  const floorRoot = Math.max(FLOOR_ROOT_Y, clearFloor);
  const ceilRoot = supportY + MAX_RISE;
  let targetY;
  if (coop.valid && g_strand.length > 0) targetY = clamp(coop.pos.y, floorRoot, ceilRoot + 0.15);
  else targetY = clamp(preferred, floorRoot, Math.max(floorRoot, ceilRoot));
  const stiffness = 26.0, damping = 0.86;
  const error = targetY - body.pos.y;
  body.heightVel += error * stiffness * dt;
  body.heightVel *= (1 - (1 - damping) * dt * 12);
  body.pos.y += body.heightVel * dt;
  body.pos.y = clamp(body.pos.y, FLOOR_ROOT_Y, 1.4);
  const atCeil = body.pos.y > ceilRoot - 0.02;
  const atFloor = body.pos.y < floorRoot + 0.02;
  const pinned = Math.abs(body.heightOffset) > 0.02 && (atCeil || atFloor);   // Q/E pushing against a wall

  // 10. CAMERA + APPLY + IK  (+ stranded set, per-leg float, walled detection)
  _camD.copy(body.pos).sub(prevBodyPos);
  if (_camD.lengthSq() > 1e-10) { camera.position.add(_camD); orbit.target.add(_camD); }

  rig.root.position.copy(body.pos);
  rig.root.quaternion.copy(body.quat);
  rig.root.updateMatrixWorld(true);

  let saturationCount = 0, maxFloat = 0, yawMax = 0, walledCount = 0;
  g_strand.length = 0;
  legState.forEach((st, i) => {
    const target = st.swing ? swingArc(st.swing.from, st.swing.to, Math.min(st.swing.t, 1)) : st.planted;
    if (st.swing && footInBlock(target.x, target.y, target.z)) target.y = heightAt(target.x, target.z) + 0.02;
    st._curTarget.copy(target);
    rig.solveLeg(rig.legs[i], target);
    const a = rig.legs[i].angles;
    const sat = Math.abs(a.yaw) > LIMITS.yaw * 0.95 || Math.abs(a.shoulder) > LIMITS.shoulder * 0.95 || Math.abs(a.knee) > LIMITS.knee * 0.95;
    st.saturated = sat; if (sat) saturationCount++;
    yawMax = Math.max(yawMax, Math.abs(a.yaw));
    if (!st.swing) {
      const f = rig.footWorld(rig.legs[i]);
      const fl = f.y - heightAt(f.x, f.z);
      st._float = fl;
      maxFloat = Math.max(maxFloat, Math.abs(fl));
      if (fl > 0.05) g_strand.push(i);
    } else st._float = 0;
  });
  rig.root.updateMatrixWorld(true);

  // self-collision vs baseline
  computeClearances(curClear, curYaw);
  let dangerCount = 0;
  for (let i = 0; i < legState.length; i++) {
    const c = curClear[i], b = baseClear[i];
    const clearBad = isFinite(b) && c < b * 0.5 && c < b - 0.03;
    const yawBad = curYaw[i] > Math.max(baseYaw[i] + 40, 65);
    const hit = clearBad || yawBad;
    legDanger[i] = hit ? 1 : 0;
    legState[i].danger = hit;
    if (hit) dangerCount++;
  }

  // walled detection: hip carried over a ledge the foot hasn't followed yet.
  // Reset every frame; run only when NOT doing a pure turn (i.e. while walking or
  // idle). A pure in-place turn sweeps a hip laterally over a block edge without
  // the body advancing — the foot is still correctly placed, so "climbing" there
  // would step the robot onto the slab just by turning. Walking climbs and idle
  // straddle-finishes still auto-climb exactly as before.
  for (let i = 0; i < legState.length; i++) { legState[i].walled = false; legState[i]._climbGap = 0; }
  if (translating || turning === 0) for (let i = 0; i < legState.length; i++) {
    const st = legState[i];
    if (st.swing || st._float > 0.05) continue;
    rig.legs[i].hip.getWorldPosition(_hipW);
    const topUnderHip = heightAt(_hipW.x, _hipW.z);
    if (topUnderHip > st.planted.y + 0.12) {
      st.walled = true; walledCount++;
      st._climbGap = topUnderHip - st.planted.y;
      const homeW = body.pos.clone().add(_tv.copy(st.home).applyQuaternion(body.quat));
      let cx = homeW.x, cz = homeW.z;
      if (heightAt(cx, cz) < topUnderHip - 0.05) { cx = _hipW.x; cz = _hipW.z; }
      st._climb.set(cx, heightAt(cx, cz), cz);
    }
  }

  const sh = heightAt(body.pos.x, body.pos.z);
  bodyShadow.position.set(body.pos.x, sh + 0.012, body.pos.z);
  const lift = clamp(body.pos.y - sh, -0.2, 0.8);
  bodyShadow.scale.setScalar(1 + Math.max(0, lift) * 0.7);
  const riding = isFinite(g_bodyBlockTop);
  bodyShadow.material.color.setHex(riding ? 0x3a2410 : 0x000000);
  bodyShadow.material.opacity = clamp((riding ? 0.40 : 0.34) - Math.max(0, lift) * 0.22, 0.06, 0.40);

  const straddle = isFinite(g_bodyBlockTop) && plantedLegs.some(st => st.planted.y < g_bodyBlockTop - 0.10);
  const needRepair = maxFloat > 0.04 || dangerCount > 0 || pinned || walledCount > 0 || straddle;
  const needsSoftRecovery = saturationCount > 0 || maxFloat > 0.04 || polyArea < 0.01 || !comInside;

  // 11. GAIT / CLIMB / COOPERATIVE REPOSITION
  if (!unstable) {
    const moving = body.vel.lengthSq() > 0.0001 || turning !== 0;
    // The tetrapod march runs ONLY while actually translating. A pure in-place
    // turn (R + A/D) used to swing four feet to body-relative homes while the body
    // rotated, so they landed stale and the planted legs folded into the ball-up.
    // With the march gated off, a turn pivots the body over planted feet and the
    // repair branch below ratchets any wound leg one at a time.
    if (translating && plantedCount >= 4) {
      gaitPhase += dt / GAIT.cycle;
      const group = Math.floor(gaitPhase * 2) % 2;
      if (group !== lastGroup) {
        lastGroup = group;
        const dur = GAIT.cycle * 0.5 * 0.8;
        legState.forEach((st, i) => { if (st.group === group && !st.swing) startSwing(i, dur, futureBodyPos); });
        repositionCooldown = 0.2;
      }
    } else if (!anySwing && repositionCooldown <= 0 && plantedCount >= 4 && (needRepair || saturationCount > 0 || turning !== 0)) {
      let cand = -1, candTarget = null, dur = 0.30, cd = 0.30;

      if (walledCount > 0) {                                   // 1 — CLIMB the ledge
        let best = -1, bestGap = -1;
        for (let i = 0; i < legState.length; i++) {
          const st = legState[i];
          if (st.walled && !st.swing && st._climbGap > bestGap) { bestGap = st._climbGap; best = i; }
        }
        if (best >= 0) { cand = best; candTarget = legState[best]._climb; cd = 0.15; }
      }
      if (cand < 0 && dangerCount > 0) {                       // 2 — untwist (guard)
        for (let i = 0; i < legState.length; i++) {
          if (legDanger[i] && !legState[i].swing) {
            cand = i;
            candTarget = body.pos.clone().add(_tv.copy(legState[i].home).applyQuaternion(body.quat));
            candTarget.y = heightAt(candTarget.x, candTarget.z);
            cd = 0.15; break;
          }
        }
      }
      if (cand < 0 && maxFloat > 0.04) {                       // 3 — rescue a floating foot
        let best = -1, bestF = -1;
        for (let i = 0; i < legState.length; i++) {
          const st = legState[i];
          if (!st.swing && st._float > bestF) { bestF = st._float; best = i; }
        }
        if (best >= 0) {
          const t = reachableSurfaceTarget(best, coop.valid ? coop.pos : body.pos);
          // skip a degenerate "re-step" to where the foot already is (a pointless hop)
          if (t.distanceTo(legState[best].planted) > 0.03) { cand = best; candTarget = t; cd = 0.15; }
        }
      }
      if (cand < 0 && pinned) {                                // 4 — ring tidy at a Q/E wall
        const ceilingLimited = atCeil;
        const floorLimited = atFloor;
        const ringScale = ceilingLimited ? 0.78 : (floorLimited ? 1.08 : 0.92);
        let worst = -1, worstScore = 0.04;
        legState.forEach((st, i) => {
          if (st.swing) return;
          const want = body.pos.clone().add(_tv.copy(rig.legs[i].footRest).multiplyScalar(ringScale).applyQuaternion(body.quat));
          want.y = heightAt(want.x, want.z);
          const d = Math.hypot(st.planted.x - want.x, st.planted.z - want.z) + Math.abs(st.planted.y - want.y);
          const f = Math.abs(rig.footWorld(rig.legs[i]).y - st.planted.y);
          const score = d + f * 6 + (st.saturated ? 0.3 : 0);
          if (score > worstScore) { worstScore = score; worst = i; st._wantRing.copy(want); }
        });
        if (worst >= 0) { cand = worst; candTarget = legState[worst]._wantRing; dur = 0.28; cd = 0.30; }
      }

      // TURN-SAFE: a pure in-place turn must never step a foot UP onto a higher
      // surface — that reads as the robot climbing (or folding into) the block just
      // by rotating. Unwinding a wound leg on level ground (target ≈ foot height) is
      // still allowed; only step-ups are suppressed. (Inside this else-if the body
      // is never translating, so `turning !== 0` here means a pure turn.)
      if (cand >= 0 && candTarget && turning !== 0 && candTarget.y > legState[cand].planted.y + 0.06) {
        cand = -1; candTarget = null;
      }

      if (cand >= 0 && candTarget) { startSwing(cand, dur, futureBodyPos, candTarget); repositionCooldown = cd; }
      else repositionCooldown = 0.25;
    }
  }

  // 12. DISTRESS
  legState.forEach((st, i) => {
    if (st.swing) { st.distress = 0; return; }
    if (st.noHold > 0) { st.noHold -= dt; return; }
    const err = rig.footWorld(rig.legs[i]).distanceTo(st.planted);
    if (err > 0.03) { st.distress = (st.distress || 0) + dt; if (st.distress > 0.10) { st.distress = 0; startSwing(i, 0.2, futureBodyPos); } }
    else st.distress = 0;
  });

  // 13. ASSERTIONS (rate-limited)
  assertClock -= dt;
  const assertLog = (m) => { if (assertClock <= 0) { console.warn('[assert] ' + m); assertClock = 1.0; } };
  if (plantedCount < 3 && !supportRecoveryActive) { assertLog('planted < 3 && recovery == false'); supportRecoveryActive = true; }
  if (polyArea === 0 && comInside) assertLog('area == 0 && COM inside == true');

  // 14. DIAGNOSTICS
  g_diag.unstable = unstable;
  g_diag.soft = needsSoftRecovery && !unstable && dangerCount === 0;
  g_diag.sat = saturationCount;
  g_diag.vel = currentSpeed;
  g_diag.float = maxFloat;
  g_diag.danger = dangerCount;
  g_diag.col = dangerCount;            // no link-vs-block pass now; COL mirrors the self-guard count
  g_diag.yawMax = yawMax;
  g_diag.strand = g_strand.length;
  g_diag.walled = walledCount;
  g_diag.blk = g_bodyBlockTop;
  g_diag.climb = walledCount > 0;
  g_diag.coop = coop.valid && g_strand.length > 0;
  g_diag.feasible = maxFloat < 0.04 && dangerCount === 0;
  g_diag.planted = plantedCount;
  g_diag.comIn = comInside;
  g_diag.area = polyArea;
  g_diag.lo = isFinite(g_envLoLive) ? g_envLoLive : (g_bandLo + supportY);
  g_diag.hi = isFinite(g_envHiLive) ? g_envHiLive : (g_bandHi + supportY);
  g_diag.cmd = !!(keys.KeyQ || keys.KeyE);
  g_diag.state = unstable ? 'HOLD'
    : dangerCount > 0 ? 'GUARD'
    : (walledCount > 0 && currentSpeed < 0.01) ? 'CLIMB'
    : (g_diag.coop && currentSpeed < 0.01) ? 'COOP'
    : currentSpeed > 0.01 ? 'WALK'
    : needsSoftRecovery ? 'SETTLE' : 'IDLE';

  // 15. COOPERATIVE OPTIMIZER (throttled)
  coop.t -= dt;
  if (coop.t <= 0) { coop.t = 1 / COOP_HZ; cooperativeSolve(); }

  // 16. MAX-STABILITY HEIGHT SCAN (throttled, save/restore). For each candidate
  // body height, solve every planted leg to its (fixed) planted world target and
  // measure the worst per-joint utilisation fraction plus any foot float; the
  // height with the LEAST worst-fraction (most slack, feet still planted) is the
  // most stable pose — that is what the body rests at. This is robust to whatever
  // LIMITS are loaded (60° or 90°): it always finds the most relaxed height, and
  // it can never pick a stretched/saturated extreme (which is what the old "top
  // of band" rule did, causing the dangle). The result is exponentially smoothed
  // into g_autoTarget so the 60 Hz spring chases a gliding setpoint, not the 8 Hz
  // raw scan (the raw step was the clip/fix oscillation). The notSat band is kept
  // only as the RNG readout.
  envT -= dt;
  if (envT <= 0) {
    envT = 1 / COOP_HZ;
    const pl = [];
    legState.forEach((st, i) => { if (!st.swing) pl.push({ planted: st.planted, index: i }); });
    if (pl.length >= 3) {
      const sx = body.pos.x, sz = body.pos.z, sy = body.pos.y;
      rig.root.quaternion.copy(body.quat);
      const supY = pl.reduce((s, st) => s + st.planted.y, 0) / pl.length;
      const lo0 = Math.max(FLOOR_ROOT_Y, supY - 0.35), hi0 = Math.min(1.2, supY + 0.55);
      const N = 16;
      let bestH = supY, bestCost = Infinity, lo = null, hi = null;
      for (let s = 0; s < N; s++) {
        const h = lo0 + (hi0 - lo0) * (s / (N - 1));
        rig.root.position.set(sx, h, sz); rig.root.updateMatrixWorld(true);
        let worstFrac = 0, totFloat = 0, allOk = true;
        for (const st of pl) {
          const leg = rig.legs[st.index];
          rig.solveLeg(leg, st.planted);
          const f = rig.footWorld(leg);
          const fl = Math.max(0, f.y - heightAt(f.x, f.z));
          totFloat += fl;
          const a = leg.angles;
          const frac = Math.max(Math.abs(a.yaw) / LIM_DEG_Y, Math.abs(a.shoulder) / LIM_DEG_S, Math.abs(a.knee) / LIM_DEG_K);
          if (frac > worstFrac) worstFrac = frac;
          if (fl > 0.03 || frac > 0.92) allOk = false;
        }
        const cost = worstFrac + totFloat * 4 + Math.abs(h - supY) * 0.04; // most slack, feet planted, near natural
        if (cost < bestCost) { bestCost = cost; bestH = h; }
        if (allOk) { if (lo === null) lo = h; hi = h; }
      }
      g_envLoLive = lo; g_envHiLive = hi;
      // smooth the setpoint (rate-limited too, so a single big scan jump can't
      // step the spring into an overshoot)
      if (!isFinite(g_autoTarget)) g_autoTarget = bestH;
      else g_autoTarget += clamp((bestH - g_autoTarget) * Math.min(1, dt * 3 * COOP_HZ), -0.2, 0.2);
      rig.root.position.set(sx, sy, sz); rig.root.updateMatrixWorld(true);
      for (let i = 0; i < legState.length; i++) rig.solveLeg(rig.legs[i], legState[i]._curTarget);
      rig.root.updateMatrixWorld(true);
    } else { g_envLoLive = NaN; g_envHiLive = NaN; }
  }

  debugCounter += dt;
  if (DEBUG && debugCounter > 0.5) {
    debugCounter = 0;
    console.log(`[DEBUG] state=${g_diag.state} planted=${plantedCount} sat=${saturationCount} danger=${dangerCount} strand=${g_strand.length} walled=${walledCount} blk=${isFinite(g_bodyBlockTop)?g_bodyBlockTop.toFixed(2):'--'} yawMax=${yawMax.toFixed(1)} float=${maxFloat.toFixed(3)} rootY=${body.pos.y.toFixed(3)} plateH=${(body.pos.y + PLATE_CENTER_Y).toFixed(3)} auto=${g_autoTarget.toFixed(2)} pref=${preferred.toFixed(2)} floor=${floorRoot.toFixed(2)} ceil=${ceilRoot.toFixed(2)} band=${g_diag.lo.toFixed(2)}..${g_diag.hi.toFixed(2)} off=${body.heightOffset.toFixed(2)} caution=${caution.toFixed(2)} speed=${currentSpeed.toFixed(2)}`);
  }
}

// ---------------------------------------------------------------- UI panels
function buildContactPanel() {
  const servoTable = $('servo-rows');
  if (!servoTable) return;
  const parent = servoTable.closest('.panel-body') || servoTable.parentElement;
  const wrap = document.createElement('div');
  wrap.className = 'contact-panel';
  wrap.innerHTML = `
    <div class="subhead">LEG CONTACT <span class="dim">planted</span></div>
    <table id="contact-table">
      <tbody id="contact-rows"></tbody>
    </table>`;
  parent.appendChild(wrap);
  const tbody = $('contact-rows');
  for (let i = 0; i < 8; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="lg">LEG-${LEG_MAP[i]}</td><td id="lc${i}">0</td>`;
    tbody.appendChild(tr);
  }
}
function updateContactPanel() {
  if (!rig || !rig.legs) return;
  for (let i = 0; i < rig.legs.length && i < 8; i++) {
    const actual = rig.footWorld(rig.legs[i]);
    const contact = (actual.y - heightAt(actual.x, actual.z)) < 0.04 ? 1 : 0;
    const el = $(`lc${i}`);
    if (el) {
      el.textContent = contact;
      el.style.color = contact ? '#46c98c' : '#e5484d';
      el.classList.toggle('stranded', g_strand.includes(i));
    }
  }
}
function buildTelemetry() {
  const tbody = $('servo-rows'); tbody.innerHTML = '';
  rig.legs.forEach((leg, i) => {
    const tr = document.createElement('tr');
    tr.id = 'srow' + i; tr.className = 'srow';
    tr.innerHTML = `<td class="lg" id="lg${i}">${leg.name}</td><td id="a${i}0"></td><td id="a${i}1"></td><td id="a${i}2"></td>`;
    tbody.appendChild(tr);
  });
}
let telemetryTimer = 0;
function updateTelemetry(dt) {
  telemetryTimer += dt; if (telemetryTimer < 0.1) return; telemetryTimer = 0;
  const LD = [
    THREE.MathUtils.radToDeg(LIMITS.yaw),
    THREE.MathUtils.radToDeg(LIMITS.shoulder),
    THREE.MathUtils.radToDeg(LIMITS.knee),
  ];
  rig.legs.forEach((leg, i) => {
    const f = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '°';
    const vals = [leg.angles.yaw, leg.angles.shoulder, leg.angles.knee];
    const cells = [$('a' + i + '0'), $('a' + i + '1'), $('a' + i + '2')];
    const danger = !!legDanger[i];
    const assist = !!legState[i].assist;
    const walled = !!legState[i].walled;
    let heat = 0;
    for (let k = 0; k < 3; k++) {
      cells[k].textContent = f(vals[k]);
      const fr = Math.abs(vals[k]) / LD[k];
      if (fr > heat) heat = fr;
      if (danger) {
        cells[k].style.color = k === 0 ? '#ff5d5d' : '#ff9a9a';
        cells[k].style.textShadow = '0 0 9px rgba(229,72,77,.7)';
      } else if (fr > 0.95) { cells[k].style.color = '#ff7a7a'; cells[k].style.textShadow = '0 0 8px rgba(229,72,77,.55)'; }
      else if (fr > 0.80) { cells[k].style.color = '#f2a33c'; cells[k].style.textShadow = '0 0 7px rgba(242,163,60,.4)'; }
      else { cells[k].style.color = ''; cells[k].style.textShadow = ''; }
    }
    const row = $('srow' + i);
    if (row) {
      if (danger) {
        row.style.backgroundColor = 'rgba(229,72,77,.22)';
        row.style.borderLeftColor = 'rgba(229,72,77,1)';
        row.style.boxShadow = 'inset 2px 0 12px -2px rgba(229,72,77,.9)';
      } else if (walled) {
        row.style.backgroundColor = 'rgba(255,194,77,.15)';
        row.style.borderLeftColor = 'rgba(255,194,77,.95)';
        row.style.boxShadow = 'inset 2px 0 11px -3px rgba(255,194,77,.85)';
      } else if (assist) {
        row.style.backgroundColor = 'rgba(83,213,230,.15)';
        row.style.borderLeftColor = 'rgba(83,213,230,.95)';
        row.style.boxShadow = 'inset 2px 0 11px -3px rgba(83,213,230,.8)';
      } else if (heat > 0.75) {
        const a = ((heat - 0.75) / 0.25) * 0.16;
        const rgb = heat > 0.95 ? '229,72,77' : '242,163,60';
        row.style.backgroundColor = `rgba(${rgb},${a})`;
        row.style.borderLeftColor = `rgba(${rgb},.9)`;
        row.style.boxShadow = `inset 2px 0 9px -3px rgba(${rgb},.8)`;
      } else {
        row.style.backgroundColor = '';
        row.style.borderLeftColor = 'transparent';
        row.style.boxShadow = '';
      }
    }
    const lg = $('lg' + i);
    if (lg) lg.style.color = danger ? '#ff9a9a' : (walled ? '#ffd27a' : (assist ? '#7fe3ef' : ''));
  });
  $('t-body').textContent = `${body.pos.x.toFixed(2)} ${(body.pos.y + PLATE_CENTER_Y).toFixed(2)} ${body.pos.z.toFixed(2)}`;
  $('t-height').textContent = (body.heightOffset >= 0 ? '+' : '') + body.heightOffset.toFixed(2);
  $('t-blocks').textContent = blocks.length;
  updateContactPanel();
  updateStatusHUD();
}

// ---------------------------------------------------------------- ambient + STATUS HUD
let hudEls = null;
function buildStatusHUD() {
  document.getElementById('octo-hud')?.remove();
  document.getElementById('octo-vignette')?.remove();
  const style = document.createElement('style');
  style.textContent = `
    @keyframes octo-pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.3; transform:scale(.65); } }
    @keyframes octo-cmd { 0%,100% { text-shadow:0 0 0 transparent; } 50% { text-shadow:0 0 9px rgba(242,163,60,.75); } }
    @keyframes octo-glow { 0%,100% { text-shadow:0 0 0 transparent; } 50% { text-shadow:0 0 9px currentColor; } }
    @keyframes octo-strand { 0%,100% { opacity:1; } 50% { opacity:.3; } }
    @keyframes octo-climb { 0%,100% { transform:translateY(0); opacity:1; } 50% { transform:translateY(-2px); opacity:.55; } }
    @keyframes octo-alarm { 0%,100% { box-shadow:0 0 10px currentColor; } 50% { box-shadow:0 0 18px currentColor, 0 0 4px #fff; } }
    #octo-vignette { position:fixed; inset:0; z-index:5; pointer-events:none;
      background:radial-gradient(120% 90% at 50% 38%, transparent 52%, rgba(0,0,0,.42) 100%);
      mix-blend-mode:multiply; }
    #octo-vignette::after { content:''; position:absolute; inset:0;
      background:repeating-linear-gradient(0deg, rgba(255,255,255,.012) 0 1px, transparent 1px 3px); opacity:.5; }
    #octo-hud { position:fixed; left:50%; bottom:46px; transform:translateX(-50%);
      display:flex; gap:15px; align-items:center; padding:8px 16px; z-index:50;
      background:linear-gradient(180deg, rgba(18,22,28,.92), rgba(11,13,16,.92));
      border:1px solid #232b35; border-top:2px solid #f2a33c; border-radius:3px;
      font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; letter-spacing:.6px;
      color:#8fa3bf; pointer-events:none; backdrop-filter:blur(6px);
      box-shadow:0 12px 40px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.03);
      transition:border-top-color .25s ease; }
    #octo-hud.alarm { border-top-color:#e5484d; }
    #octo-hud.riding { border-top-color:#ffc24d; }
    #octo-hud .dot { width:8px; height:8px; border-radius:50%; background:#53d5e6;
      box-shadow:0 0 10px currentColor; animation:octo-pulse 1.1s ease-in-out infinite; }
    #octo-hud .dot.alarm { animation:octo-alarm .45s ease-in-out infinite; }
    #octo-hud .dot.climb { animation:octo-climb .6s ease-in-out infinite; }
    #octo-hud b { color:#d7dee7; font-weight:700; transition:color .2s ease; }
    #octo-hud b.glow { animation:octo-glow .7s ease-in-out infinite; }
    #octo-hud .k { color:#566273; }
    #octo-hud .state { color:#f2a33c; min-width:56px; font-weight:800; letter-spacing:1px; }
    #octo-hud .sep { width:1px; height:14px; background:#232b35; }
    #octo-hud b.cmd { color:#f2a33c; animation:octo-cmd .5s ease-in-out infinite; }
    #contact-rows td.stranded { animation:octo-strand .7s ease-in-out infinite; }
    .srow { transition: background-color .3s ease, border-left-color .3s ease, box-shadow .3s ease;
            border-left:2px solid transparent; }
    .srow td { transition: color .2s ease, text-shadow .2s ease; }
  `;
  document.head.appendChild(style);
  const vig = document.createElement('div'); vig.id = 'octo-vignette'; document.body.appendChild(vig);
  const hud = document.createElement('div'); hud.id = 'octo-hud';
  hud.innerHTML = `
    <span class="dot" id="hud-dot"></span>
    <span class="state" id="hud-state">BOOT</span>
    <span class="sep"></span>
    <span><span class="k">COL</span> <b id="hud-col">0</b></span>
    <span><span class="k">STRAND</span> <b id="hud-strand">0</b></span>
    <span><span class="k">WALL</span> <b id="hud-walled">0</b></span>
    <span><span class="k">BLK</span> <b id="hud-blk">--</b></span>
    <span><span class="k">TILT</span> <b id="hud-tilt">0°</b></span>
    <span><span class="k">SAT</span> <b id="hud-sat">0</b></span>
    <span><span class="k">FEET</span> <b id="hud-feet">8</b></span>
    <span><span class="k">V</span> <b id="hud-vel">0.00</b></span>
    <span><span class="k">H</span> <b id="hud-h">0.30</b></span>
    <span><span class="k">FLT</span> <b id="hud-flt">0.00</b></span>
    <span><span class="k">RNG</span> <b id="hud-rng">--</b></span>`;
  document.body.appendChild(hud);
  hudEls = {
    wrap: hud, dot: hud.querySelector('#hud-dot'), state: hud.querySelector('#hud-state'),
    col: hud.querySelector('#hud-col'), strand: hud.querySelector('#hud-strand'),
    walled: hud.querySelector('#hud-walled'), blk: hud.querySelector('#hud-blk'),
    tilt: hud.querySelector('#hud-tilt'), sat: hud.querySelector('#hud-sat'),
    feet: hud.querySelector('#hud-feet'), vel: hud.querySelector('#hud-vel'),
    h: hud.querySelector('#hud-h'), flt: hud.querySelector('#hud-flt'), rng: hud.querySelector('#hud-rng'),
  };
}
function updateStatusHUD() {
  if (!hudEls) return;
  const d = g_diag;
  const alarm = d.danger > 0 || d.unstable;
  const climbing = d.state === 'CLIMB';
  const coopActive = d.coop && d.vel < 0.01;
  const riding = isFinite(d.blk);
  let col = '#53d5e6';
  if (d.unstable) col = '#e5484d';
  else if (d.danger > 0) col = '#e5484d';
  else if (climbing) col = '#ffc24d';
  else if (coopActive) col = '#53d5e6';
  else if (d.state === 'WALK') col = '#46c98c';
  else if (d.soft) col = '#f2a33c';
  hudEls.dot.style.color = col; hudEls.dot.style.background = col;
  hudEls.dot.classList.toggle('alarm', alarm);
  hudEls.dot.classList.toggle('climb', climbing && !alarm);
  hudEls.wrap.classList.toggle('alarm', alarm);
  hudEls.wrap.classList.toggle('riding', riding && !alarm);
  hudEls.state.textContent = d.state; hudEls.state.style.color = col;
  hudEls.col.textContent = d.col;
  hudEls.col.style.color = d.col > 0 ? (d.danger > 0 ? '#ff7a7a' : '#ffb454') : '#46c98c';
  hudEls.col.classList.toggle('glow', d.col > 0);
  hudEls.strand.textContent = d.strand;
  hudEls.strand.style.color = d.strand > 0 ? '#53d5e6' : '#566273';
  hudEls.strand.classList.toggle('glow', d.strand > 0);
  hudEls.walled.textContent = d.walled;
  hudEls.walled.style.color = d.walled > 0 ? '#ffc24d' : '#566273';
  hudEls.walled.classList.toggle('glow', d.walled > 0);
  if (riding) { hudEls.blk.textContent = d.blk.toFixed(2); hudEls.blk.style.color = '#ffb454'; }
  else { hudEls.blk.textContent = '--'; hudEls.blk.style.color = '#566273'; }
  hudEls.tilt.textContent = d.tilt.toFixed(0) + '°';
  hudEls.tilt.style.color = d.tilt > 12 ? '#ffb454' : (d.tilt > 3 ? '#8fa3bf' : '#566273');
  hudEls.sat.textContent = d.sat; hudEls.sat.style.color = d.sat > 0 ? '#f2a33c' : '#46c98c';
  hudEls.feet.textContent = d.planted; hudEls.feet.style.color = d.planted < 4 ? '#e5484d' : '#d7dee7';
  hudEls.vel.textContent = d.vel.toFixed(2);
  hudEls.h.textContent = (body.pos.y + PLATE_CENTER_Y).toFixed(2);
  hudEls.h.classList.toggle('cmd', !!d.cmd);
  hudEls.flt.textContent = d.float.toFixed(2); hudEls.flt.style.color = d.float > 0.04 ? '#e5484d' : '#8fa3bf';
  if (isFinite(d.lo) && isFinite(d.hi)) {
    hudEls.rng.textContent = `${(d.lo + PLATE_CENTER_Y).toFixed(2)}·${(d.hi + PLATE_CENTER_Y).toFixed(2)}`;
    hudEls.rng.style.color = pinned_now() ? '#f2a33c' : '#8fa3bf';
  } else {
    hudEls.rng.textContent = '--';
    hudEls.rng.style.color = '#e5484d';
  }
}
// RNG glows amber only while Q/E is pushing the body against its ceiling/floor
function pinned_now() {
  const supY = g_diag.planted ? (g_diag.lo + g_diag.hi) * 0.5 - PLATE_CENTER_Y : 0;
  return Math.abs(body.heightOffset) > 0.02 &&
    (body.pos.y > supY + MAX_RISE - 0.02 || body.pos.y < FLOOR_ROOT_Y + 0.02);
}

// ---------------------------------------------------------------- POV camera
const povCam = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.02, 200);
window.addEventListener('resize', () => { povCam.aspect = window.innerWidth / window.innerHeight; povCam.updateProjectionMatrix(); });

// ---------------------------------------------------------------- boot + loop
const clock = new THREE.Clock();

// --- boot hardening (presentation-only; does not touch locomotion) -----------
// Startup runs a chain of calibration steps. A warn step can fail and still
// leave a drivable robot, so only the mesh load and the leg build are fatal.
const boot = createBoot();
function bootWarn(step, err) { console.warn('[boot-warn] ' + step, err); }

let _gaitErr = false, _telErr = false;
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (rig) {
    try { updateGait(dt); }
    catch (err) { if (!_gaitErr) { _gaitErr = true; console.error('[gait] throwing every frame — gait frozen, render continues. Fix the logged error:', err); } }
    try { updateTelemetry(dt); }
    catch (err) { if (!_telErr) { _telErr = true; console.error('[telemetry] throwing — HUD frozen, render continues:', err); } }
  }
  orbit.update();
  govern(dt);
  renderer.render(scene, povMode ? povCam : camera);
}

(async () => {
  try {
    rig = await loadOctobot('models/octobot.glb', scene, (loaded, total) => {
      boot.progress(loaded, total);
      if (total && loaded >= total) boot.stage('PARSING MESH');
    });
  } catch (err) {
    boot.fail('loadOctobot("models/octobot.glb")', err);
    return;
  }
  boot.stage('BUILDING RIG');
  applyRobotFinish(rig.root);   // the rig only — the ground shadow keeps its own material
  if (DEBUG) {
    console.log('[octorig] joint limits, deg:',
      LIM_DEG_Y.toFixed(1), LIM_DEG_S.toFixed(1), LIM_DEG_K.toFixed(1));
  }
  try { initLegs(); } catch (err) { boot.fail('initLegs', err); return; }
  boot.stage('CALIBRATING STANCE');
  try { measureChassisPlate(); } catch (err) { bootWarn('measureChassisPlate', err); }
  try { calibratePOV(); } catch (err) { bootWarn('calibratePOV', err); }
  try { calibrateStance(); } catch (err) { bootWarn('calibrateStance', err); }
  try { coop.pos.copy(body.pos); } catch (err) { bootWarn('coop init', err); }
  try { rig.root.add(povCam); } catch (err) { bootWarn('povCam attach', err); }
  try { legState.forEach((st, i) => { st._curTarget.copy(st.planted); rig.solveLeg(rig.legs[i], st.planted); }); }
  catch (err) { bootWarn('initial IK solve', err); }
  try { buildTelemetry(); } catch (err) { bootWarn('buildTelemetry', err); }
  try { buildContactPanel(); } catch (err) { bootWarn('buildContactPanel', err); }
  try { buildStatusHUD(); } catch (err) { bootWarn('buildStatusHUD', err); }
  try { updateModeUI(); } catch (err) { bootWarn('updateModeUI', err); }
  boot.done();
  window.__PG = {
    rig, body, legState, blocks, heightAt, heightAtFootprintDense, boxHitsBlock, pointInBlock, keys, updateGait, updateTelemetry,
    spawnBlock, scene, camera, povCam, orbit, renderer, THREE, g_diag, legDanger, baseClear, coop,
    LIMITS, bodyBlockTop: () => g_bodyBlockTop, env: () => ({ lo: g_envLoLive, hi: g_envHiLive }), autoTarget: () => g_autoTarget,
    PLATE: () => ({ c: PLATE_CENTER_Y, hx: PLATE_HALF_X, hz: PLATE_HALF_Z, lo: g_bandLo, hi: g_bandHi, floor: FLOOR_ROOT_Y }),
    recalibrate: () => { measureChassisPlate(); calibrateStance(); },
    recalibratePOV: calibratePOV,
    getModes: () => ({ turnMode, povMode }),
  };
})();

tick();