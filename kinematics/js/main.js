// main.js — scene bootstrap, app state, interaction, render loop
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createResolutionGovernor, createContactShadow } from './perf.js';
import { Chain } from './chain.js';
import { GaitEngine } from './gait.js';
import { RigBinding } from './binding.js';
import { setModelZUp } from './loader.js';
import { LIMITS } from './octorig.js';
import { initUI } from './ui.js';

const CHAIN_COLORS = [0xf2a33c, 0x53d5e6, 0xe561a8, 0x46c98c, 0xb08cff, 0xe5484d];

const App = {
  scene: null, camera: null, renderer: null,
  orbit: null, tcontrols: null,
  chains: [],
  activeChain: null,
  selectedJoint: null, // { chain, index } | null
  models: [],
  mode: 'solve',       // 'solve' | 'build'
  collisionOpts: { models: true, self: true, floor: true },
  ui: null,
  fps: 0,
};
window.__IK_APP = App; // console handle for debugging

const BG = 0x0d0f12;

// --- scene -----------------------------------------------------------------

function initScene() {
  const viewport = document.getElementById('viewport');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  App.govern = createResolutionGovernor(renderer); // owns the pixel ratio
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  viewport.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 22, 55);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 200);
  camera.position.set(6.5, 4.5, 7.5);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 1.6, 0);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.maxPolarAngle = Math.PI * 0.52;
  orbit.minDistance = 1;
  orbit.maxDistance = 40;

  // The printed parts are dark, low-metalness PBR. Without an environment to
  // sample they render as a flat silhouette, so a prefiltered room probe carries
  // the ambient term and the three directional lights only have to carve shape.
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  // Near-neutral rig: a warm key against a cooler sky and rim. Above about 1.2
  // on the key the chassis blows out to white.
  scene.add(new THREE.HemisphereLight(0xb4bcc4, 0x1a1410, 0.24));
  for (const [color, intensity, x, y, z] of [
    [0xfff2dd, 1.15, 6, 10, 4],    // key
    [0xd2d8de, 0.28, -5, 3, 8],    // fill
    [0xc8d2da, 0.45, -8, 4, -6],   // rim
  ]) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(x, y, z);
    scene.add(light);
  }

  // Two grids: metre squares over a finer 200 mm mesh, for a sense of scale.
  const grid = new THREE.GridHelper(30, 30, 0x2c333d, 0x1b2028);
  grid.material.transparent = true;
  grid.material.opacity = 0.8;
  scene.add(grid);
  const gridFine = new THREE.GridHelper(30, 150, 0x161b21, 0x14181e);
  gridFine.position.y = -0.002;
  scene.add(gridFine);

  const axes = new THREE.AxesHelper(0.8);
  axes.position.y = 0.001;
  scene.add(axes);

  // grounds the robot without a shadow-map pass over a 12 MB mesh
  App.contactShadow = createContactShadow(THREE, { size: 3.2, opacity: 0.3 });
  App.contactShadow.visible = false;
  scene.add(App.contactShadow);

  // transform gizmo
  const tcontrols = new TransformControls(camera, renderer.domElement);
  tcontrols.size = 0.75;
  tcontrols.addEventListener('dragging-changed', e => {
    orbit.enabled = !e.value;
    // the gizmo clears `dragging` before our pointerup fires, which would make
    // the release read as a click (deselecting / placing a stray joint)
    if (!e.value) App.gizmoReleasedAt = performance.now();
  });
  tcontrols.addEventListener('objectChange', onGizmoChange);
  scene.add(tcontrols);

  // Anything that can change what the viewport shows re-arms the render loop.
  // The document-level listeners cover every panel control in one place, which
  // beats threading an invalidate() call through each handler.
  orbit.addEventListener('change', invalidate);
  for (const type of ['pointerdown', 'pointermove', 'wheel', 'input', 'change', 'keydown']) {
    document.addEventListener(type, invalidate, { passive: true, capture: true });
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    // dragging a window edge fires this continuously, and each call reallocates
    // the drawing buffer
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      invalidate();
    }, 80);
  });

  Object.assign(App, { scene, camera, renderer, orbit, tcontrols });
}

// --- framing ---------------------------------------------------------------

/**
 * The part of the window no panel is covering, in CSS pixels. The chrome is
 * fixed-position over a full-bleed canvas, so a model centred in the window is
 * not centred in the space the user can actually see.
 */
function clearViewRect() {
  const W = window.innerWidth, H = window.innerHeight;
  const shown = id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('collapsed') ? el.getBoundingClientRect() : null;
  };
  let x = 0, right = W, y = 0, bottom = H;
  const left = shown('sidebar');
  if (left) x = left.right + 12;
  const rightCol = shown('sidebar-right');
  if (rightCol) right = rightCol.left - 12;
  const bar = document.getElementById('topbar')?.getBoundingClientRect();
  if (bar) y = bar.bottom;
  const foot = document.getElementById('telemetry')?.getBoundingClientRect();
  if (foot) bottom = foot.top;

  const w = right - x, h = bottom - y;
  // a small window leaves nothing usable free — frame against the whole viewport
  return (w < 240 || h < 240) ? { x: 0, y: 0, w: W, h: H } : { x, y, w, h };
}

/**
 * Half-extent of the geometry under `roots` along each of `axes`, measured from
 * `centre`. Vertices are sampled rather than read in full: this runs on every
 * re-frame, and a few dozen points per mesh place the silhouette to well inside
 * the framing margin.
 */
function extentsAlong(roots, centre, axes) {
  const out = axes.map(() => 0);
  const v = new THREE.Vector3();
  for (const root of roots) {
    if (!root) continue;
    root.updateMatrixWorld(true);
    root.traverse(o => {
      const pos = o.isMesh && o.geometry?.attributes?.position;
      if (!pos) return;
      const stride = Math.max(1, Math.floor(pos.count / 48));
      for (let i = 0; i < pos.count; i += stride) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).sub(centre);
        for (let a = 0; a < axes.length; a++) {
          out[a] = Math.max(out[a], Math.abs(v.dot(axes[a])));
        }
      }
    });
  }
  return out;
}

/**
 * Point the camera at `objects` and pull back far enough to hold all of them
 * inside the clear view rect. The rig comes from CAD, so its size is only known
 * once the GLB has parsed; a hardcoded start pose leaves the robot small and
 * off-centre.
 */
export function frameModel(objects, { padding = 1.08 } = {}) {
  const { camera, orbit } = App;
  const roots = (Array.isArray(objects) ? objects : [objects]).filter(Boolean);
  const box = new THREE.Box3();
  for (const o of roots) box.union(new THREE.Box3().setFromObject(o));
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const view = clearViewRect();
  const W = window.innerWidth, H = window.innerHeight;

  // full-frame half-angles, then the same angles narrowed to the clear rect
  const halfV = THREE.MathUtils.degToRad(camera.fov) / 2;
  const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
  const fitV = Math.atan(Math.tan(halfV) * view.h / H);
  const fitH = Math.atan(Math.tan(halfH) * view.w / W);

  // Fit the geometry itself. The octobot is a wide flat disc, so both its bounding
  // sphere and its bounding box stick out well past anything the camera sees, and
  // fitting either leaves the robot small in the middle of an empty frame.
  const dir = new THREE.Vector3(0.62, 0.42, 0.66).normalize();
  const basis = new THREE.Matrix4().lookAt(_fv.copy(center).add(dir), center, camera.up);
  const bx = new THREE.Vector3().setFromMatrixColumn(basis, 0);
  const by = new THREE.Vector3().setFromMatrixColumn(basis, 1);
  const ex = extentsAlong(roots, center, [bx, by, dir]);
  const dist = (Math.max(ex[0] / Math.tan(fitH), ex[1] / Math.tan(fitV)) + ex[2]) * padding;

  orbit.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, dist);
  orbit.update();               // aims the camera, so its basis is now valid
  camera.updateMatrixWorld();

  // Move the camera sideways until the model sits at the centre of the clear rect
  // rather than the centre of the window. Shifting the camera and its target
  // together displaces the subject by the same amount in the opposite direction.
  const ndcX = (view.x + view.w / 2) / W * 2 - 1;
  const ndcY = 1 - (view.y + view.h / 2) / H * 2;
  const camBasis = camera.matrixWorld.elements;
  const shift = new THREE.Vector3(camBasis[0], camBasis[1], camBasis[2])
    .multiplyScalar(-ndcX * Math.tan(halfH) * dist)
    .addScaledVector(new THREE.Vector3(camBasis[4], camBasis[5], camBasis[6]),
                     -ndcY * Math.tan(halfV) * dist);
  orbit.target.add(shift);
  camera.position.add(shift);

  camera.near = Math.max(0.01, dist / 200);
  camera.far = dist * 12;
  camera.updateProjectionMatrix();
  orbit.update();
  invalidate();
}

// --- gizmo / modes ---------------------------------------------------------

function onGizmoChange() {
  const obj = App.tcontrols.object;
  if (!obj) return;
  if (obj.userData?.kind === 'joint') {
    const { chain, index } = obj.userData;
    chain.setJointPos(index, obj.position);
    chain.snapTargetToEE();
    App.ui?.softRefreshJoints();
  } else {
    // target marker moved
    const chain = App.chains.find(c => c.targetGroup === obj);
    if (chain) {
      chain.target.copy(obj.position);
      chain.targetDirty = true;
    }
  }
}

export function setMode(mode) {
  App.mode = mode;
  App.tcontrols.detach();
  if (mode === 'solve') {
    if (App.activeChain && App.activeChain.joints.length >= 2) {
      App.activeChain.snapTargetToEE();
      App.tcontrols.attach(App.activeChain.targetGroup);
    }
  } else if (mode === 'build') {
    if (App.selectedJoint) {
      App.tcontrols.attach(App.selectedJoint.chain.joints[App.selectedJoint.index].mesh);
    }
  }
  App.ui?.onModeChanged();
}

export function setActiveChain(chain) {
  App.activeChain = chain;
  selectJoint(null);
  if (App.mode === 'solve') setMode('solve'); // re-attach gizmo to new target
  App.ui?.refreshAll();
}

export function selectJoint(sel) {
  if (App.selectedJoint) App.selectedJoint.chain.setSelectedJoint(-1);
  App.selectedJoint = sel;
  if (sel) {
    sel.chain.setSelectedJoint(sel.index);
    if (App.activeChain !== sel.chain) {
      App.activeChain = sel.chain;
    }
    if (App.mode === 'build') {
      App.tcontrols.attach(sel.chain.joints[sel.index].mesh);
    }
  } else if (App.mode === 'build') {
    App.tcontrols.detach();
  }
  App.ui?.refreshAll();
}

/** Legs are only ever created by the octobot auto-rig, never by hand. */
function deleteChain(chain) {
  const i = App.chains.indexOf(chain);
  if (i === -1) return;
  // stop anything still driving this chain, or it dereferences a disposed chain
  if (App.gait?.active && App.gait.legs.some(l => l.chain === chain)) App.gait.stop();
  if (App.binding.links.some(l => l.chain === chain)) App.binding.clear();
  if (App.selectedJoint?.chain === chain) App.selectedJoint = null;
  if (App.tcontrols.object && (App.tcontrols.object.userData?.chain === chain || App.tcontrols.object === chain.targetGroup)) {
    App.tcontrols.detach();
  }
  for (const m of App.models) if (m.attachedTo?.chain === chain) m.attachedTo = null;
  chain.dispose();
  App.chains.splice(i, 1);
  if (App.activeChain === chain) App.activeChain = App.chains[App.chains.length - 1] ?? null;
  if (App.mode === 'solve') setMode('solve');
  App.ui?.refreshAll();
}

// --- gait auto-rig ---------------------------------------------------------

/**
 * Find the 8 (or however many) feet of a loaded walker model by clustering
 * vertices that touch the ground plane. Returns world-space foot centroids.
 */
function detectFeet(model) {
  model.group.updateMatrixWorld(true);
  const contacts = [];
  for (const mesh of model.meshes) {
    const pos = mesh.geometry.attributes.position;
    const stride = Math.max(1, Math.floor(pos.count / 20000)); // sample big meshes
    for (let i = 0; i < pos.count; i += stride) {
      _fv.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (_fv.y < 0.07) contacts.push(_fv.clone());
    }
  }
  // greedy XZ clustering
  const clusters = [];
  for (const p of contacts) {
    let best = null, bestD = 0.34;
    for (const cl of clusters) {
      const d = Math.hypot(p.x - cl.c.x, p.z - cl.c.z);
      if (d < bestD) { best = cl; bestD = d; }
    }
    if (best) {
      best.n++;
      best.c.lerp(p, 1 / best.n);
    } else {
      clusters.push({ c: p.clone(), n: 1 });
    }
  }
  clusters.sort((a, b) => b.n - a.n);
  return clusters.slice(0, 8).filter(cl => cl.n >= 3).map(cl => new THREE.Vector3(cl.c.x, 0, cl.c.z));
}

const _fv = new THREE.Vector3();

/**
 * Rig the octobot model: one hip-yaw → shoulder → knee → foot chain per
 * detected foot, then bind the mesh parts to the bones. Only runs for the
 * octobot (name match + 6..8 feet on the floor). Returns result or null.
 */
export function maybeRigOctobot(model) {
  if (!model || !/octo/i.test(model.name)) return null;
  App.binding.clear(); // restore mesh to rest pose before measuring it
  let feet = detectFeet(model);
  // a CAD export lying on its side has no feet on the floor — stand it up
  if (feet.length < 6 && !model.zUp) {
    setModelZUp(model, true);
    feet = detectFeet(model);
    if (feet.length < 6) setModelZUp(model, false);
  }
  if (feet.length < 6) return null; // e.g. the single-leg model — leave unrigged

  const center = new THREE.Vector3();
  const box = new THREE.Box3().setFromObject(model.group);
  box.getCenter(center);

  // Pivots come from the CAD occurrences. Each leg has three servos, and the
  // joint axis runs through the servo shaft rather than the body centre. The
  // shaft is where the servo's bounding box overlaps the link it drives
  // (art_1/2/3), because that link wraps the shaft and bearing coaxially.
  let occRoot = model._rot;
  while (occRoot.children.length === 1) occRoot = occRoot.children[0];
  const servos = [];   // { center, box, node }
  const arts = [[], [], []]; // art_1 / art_2 / art_3: { center, box, node }
  const others = [];   // remaining occurrences: { center, node }
  for (const node of occRoot.children) {
    const name = node.name ?? '';
    const isServo = /servo/i.test(name);
    const artM = name.match(/art_([123])/i);
    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) continue;
    const entry = { center: box.getCenter(new THREE.Vector3()), box, node };
    if (isServo) servos.push(entry);
    else if (artM) arts[+artM[1] - 1].push(entry);
    else others.push(entry);
  }
  const _isect = new THREE.Box3();
  // joint pivot = center of the servo∩link overlap (the shaft/bearing region)
  const shaftPivot = (servo, artList, legAng, angOfFn) => {
    let best = null, bestA = Infinity;
    for (const a of artList) {
      const d = Math.abs(THREE.MathUtils.euclideanModulo(angOfFn(a.center) - legAng + Math.PI, Math.PI * 2) - Math.PI);
      if (d < bestA) { bestA = d; best = a; }
    }
    if (best && bestA < 0.33) {
      _isect.copy(servo.box).intersect(best.box);
      if (!_isect.isEmpty()) return _isect.getCenter(new THREE.Vector3());
    }
    return servo.center.clone();
  };
  const angOf = p => Math.atan2(p.z - center.z, p.x - center.x);
  const angDiff = (a, b) => Math.abs(THREE.MathUtils.euclideanModulo(a - b + Math.PI, Math.PI * 2) - Math.PI);
  const radialOf = p => Math.hypot(p.x - center.x, p.z - center.z);

  App.gait.stop();
  for (const c of [...App.chains]) deleteChain(c);

  // Two servo mounting styles on this robot:
  //   hip — inverted, the horn is anchored to the chassis, so the servo body and
  //     its casing rotate on the spot with the coxa.
  //   shoulder and knee — conventional, the servo is bolted to the link before
  //     the joint and only the part on the horn rotates.
  const nodeAssign = new Map(); // node → { group: 'body'|boneIndex, d }
  const claim = (node, group, d) => {
    const prev = nodeAssign.get(node);
    if (!prev || d < prev.d) nodeAssign.set(node, { group, d });
  };
  // servo horn sub-meshes that bind to a different bone than their servo body
  const servoHeadNodes = [];

  feet.forEach(foot => {
    const fAng = angOf(foot);
    // this leg's servos: same bearing as the foot, sorted hip → knee by radius
    const legServos = servos
      .filter(s => angDiff(angOf(s.center), fAng) < 0.28)
      .sort((a, b) => radialOf(a.center) - radialOf(b.center));
    if (legServos.length < 3) return; // can't place this leg reliably

    const chain = new Chain(App.scene, CHAIN_COLORS[App.chains.length % CHAIN_COLORS.length]);
    chain.setVisualScale(0.45); // keep the mesh readable — slim bones
    App.chains.push(chain);
    // pivots on the actual shaft/bearing axes: servo ∩ driven link
    const mount = shaftPivot(legServos[0], arts[0], fAng, angOf);
    const shoulder = shaftPivot(legServos[1], arts[1], fAng, angOf);
    const knee = shaftPivot(legServos[2], arts[2], fAng, angOf);
    // Every part follows the link it is screwed to, which is the link its mesh
    // overlaps most. That covers both mount styles without a special case: the
    // hip servo body overlaps the coxa and turns with it, the knee servo body
    // overlaps the femur and stays put as the tibia bends.
    const legArts = arts.map(list => {
      let best = null, bestA = 0.33;
      for (const a of list) {
        const d = angDiff(angOf(a.center), fAng);
        if (d < bestA) { bestA = d; best = a; }
      }
      return best ? { ...best, bearingErr: bestA } : null;
    });
    // Claim the coxa, femur and tibia for this leg explicitly. A bare bone index
    // would leave binding.js to resolve the leg from its bearing heuristic, and a
    // miss there sends the link to a neighbouring leg while its servo, claimed
    // exactly, stays behind. Scoring by bearing error means the closer leg keeps
    // a link both reach for.
    legArts.forEach((a, i) => {
      if (a) claim(a.node, { chain, bone: i }, -1e6 + a.bearingErr);
    });
    const overlapVol = (a, b) => {
      const x = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
      const y = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
      const z = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
      return (x > 0 && y > 0 && z > 0) ? x * y * z : 0;
    };
    // best articulation bone by mesh overlap; returns -1 if no meaningful overlap
    const overlapBone = box => {
      let bestVol = 0, bestIdx = -1;
      legArts.forEach((a, k) => {
        if (!a) return;
        const v = overlapVol(box, a.box);
        if (v > bestVol) { bestVol = v; bestIdx = k; }
      });
      const s = box.max.clone().sub(box.min);
      const ownVol = Math.max(s.x * s.y * s.z, 1e-9);
      return (bestIdx >= 0 && bestVol > 0.12 * ownVol) ? { bone: bestIdx, vol: bestVol } : null;
    };

    // A part that overlaps no link clearly — a casing boss sitting right on a
    // joint axis — falls back to the nearest pivot, so it spins in place there
    // instead of being left behind.
    const pivots = [[mount, 0], [shoulder, 1], [knee, 2]];
    const bindMovable = o => {
      const ob = overlapBone(o.box);
      if (ob) { claim(o.node, { chain, bone: ob.bone }, -ob.vol); return; }
      let bd = 0.28, bg = -1;
      for (const [pivot, grp] of pivots) {
        const d = o.center.distanceTo(pivot);
        if (d < bd) { bd = d; bg = grp; }
      }
      if (bg >= 0) claim(o.node, { chain, bone: bg }, bd);
    };
    // A servo body straddles its own joint, so box overlap cannot place it. Each
    // servo is two meshes sitting on opposite sides of the joint, and the pairing
    // is known from the assembly, so map it explicitly. -Infinity outranks any
    // overlap or pivot claim.
    //   hip:      body → coxa,  head → chassis
    //   shoulder: body → femur, head → coxa   (head stays as the femur swings)
    //   knee:     body → femur, head → tibia  (body stays as the tibia bends)
    const servoParentBone = [0, 1, 1];
    const servoHeadBone = ['body', 0, 2];
    const _b3 = new THREE.Vector3();
    const meshVolume = m => {
      const b = new THREE.Box3().setFromObject(m);
      if (b.isEmpty()) return 0;
      const s = b.getSize(_b3);
      return s.x * s.y * s.z;
    };
    legServos.forEach((sv, i) => {
      if (i >= 3) { bindMovable(sv); return; }
      claim(sv.node, { chain, bone: servoParentBone[i] }, -Infinity);
      // split the horn out: largest sub-mesh is the body, the rest are heads
      const kids = [];
      sv.node.traverse(o => { if (o.isMesh) kids.push(o); });
      if (kids.length < 2) return;
      kids.sort((a, b) => meshVolume(b) - meshVolume(a));
      for (let k = 1; k < kids.length; k++) {
        servoHeadNodes.push(kids[k]);
        const hb = servoHeadBone[i];
        // 'body' is binding.js's literal chassis marker, so pass it through as-is
        claim(kids[k], hb === 'body' ? 'body' : { chain, bone: hb }, -Infinity);
      }
    });
    // Yokes and brackets fall out of the same overlap rule: a fixed casing
    // overlaps the parent link, a driven bracket overlaps the child.
    for (const o of others) bindMovable(o);
    chain.addJoint(mount);
    chain.addJoint(shoulder);
    chain.addJoint(knee);
    chain.addJoint(foot.clone());
    // hinge axes: hip yaws about vertical; shoulder/knee pitch about the
    // horizontal axis perpendicular to the leg's radial plane
    const out = _fv.set(foot.x - center.x, 0, foot.z - center.z).normalize();
    const pitchAxis = new THREE.Vector3(0, 1, 0).cross(out).normalize();
    // Sweeps are the real servo travel, from octorig's LIMITS so the workbench
    // and the playground cannot disagree. Each limit is a ± angle about the rest
    // pose, so the sweep is twice it.
    const deg = THREE.MathUtils.radToDeg;
    const setup = [
      { axis: new THREE.Vector3(0, 1, 0), range: 2 * deg(LIMITS.yaw) },      // hip yaw servo
      { axis: pitchAxis.clone(), range: 2 * deg(LIMITS.shoulder) },          // shoulder pitch servo
      { axis: pitchAxis.clone(), range: 2 * deg(LIMITS.knee) },              // knee pitch servo
    ];
    setup.forEach((s, i) => {
      const j = chain.joints[i];
      j.type = 'hinge';
      j.hingePreset = 'hcustom';
      j.hingeRange = s.range;
      j.axisVec = s.axis;
    });
    chain.iterations = 32;
  });
  if (App.chains.length < 6) {
    // couldn't identify enough legs from the CAD — bail out cleanly
    for (const c of [...App.chains]) deleteChain(c);
    return null;
  }
  App.chains.forEach((c, i) => { c.name = 'LEG-' + (i + 1); });
  // scale the gait to the actual leg size
  const avgLen = App.chains.reduce((a, c) => a + c.totalLength, 0) / App.chains.length;
  App.gait.stride = +(avgLen * 0.32).toFixed(2);
  App.gait.lift = +(avgLen * 0.16).toFixed(2);
  App.ui?.syncGaitInputs?.();
  App.activeChain = App.chains[0] ?? null;
  App.selectedJoint = null;
  // Placement order: an exact claim from the pass above, then the link name, then
  // binding.js's geometric nearest-bone rule for anything left.
  const octobotAssigner = (name, centroid, legIdx, chain, bearingErr, gate, node) => {
    const a = nodeAssign.get(node);
    if (a) return a.group;
    const m = name.match(/art_([123])/i);
    if (m) return +m[1] - 1; // coxa / femur / tibia links
    return null;
  };
  const bound = App.binding.bind(model, App.chains, App.scene, octobotAssigner, servoHeadNodes);
  buildChassisBox(model);
  measureBoneRadii();
  setMode('solve');
  setRigVisible(false); // the mesh is the visualisation; the skeleton is a debug view
  App.ui?.refreshAll();
  return { legs: feet.length, bound };
}

/**
 * Give every bone the thickness of the parts bound to it.
 *
 * The collision guard tests bone segments, which are infinitely thin lines down
 * the middle of each link, while a coxa or femur is really a wide bracket and
 * servo cluster. Without a radius, a pose can bury parts in the chassis while the
 * bone line itself passes through open air.
 *
 * A mid percentile rather than the maximum: these clusters have outlying mounting
 * ears that would inflate the link into a sphere and make every pose a collision.
 */
function measureBoneRadii(pct = 0.55) {
  const v = new THREE.Vector3();
  for (const c of App.chains) c.boneRadii = new Array(Math.max(c.joints.length - 1, 0)).fill(0);
  for (const l of App.binding.links) {
    const a = l.chain.joints[l.index]?.pos, b = l.chain.joints[l.index + 1]?.pos;
    if (!a || !b) continue;
    l.group.updateMatrixWorld(true);
    const ds = [];
    l.group.traverse(o => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      const pos = o.geometry.attributes.position;
      const stride = Math.max(1, Math.floor(pos.count / 300));
      for (let i = 0; i < pos.count; i += stride) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        ds.push(pointSegDist(v, a, b));
      }
    });
    if (!ds.length) continue;
    ds.sort((x, y) => x - y);
    l.chain.boneRadii[l.index] = ds[Math.min(ds.length - 1, Math.floor(ds.length * pct))];
  }
}

const _psA = new THREE.Vector3();
function pointSegDist(p, a, b) {
  _psA.subVectors(b, a);
  const len2 = _psA.lengthSq();
  let t = len2 > 1e-12 ? _fv.subVectors(p, a).dot(_psA) / len2 : 0;
  t = THREE.MathUtils.clamp(t, 0, 1);
  return _fv.copy(a).addScaledVector(_psA, t).distanceTo(p);
}

// Fraction of the body plate's span kept as the collision box: the largest box no
// leg overlaps at the rest pose. A contact that exists at rest is absorbed into
// the guard's baseline, which would turn that bone into a permanent blind spot.
const CHASSIS_KEEP = { x: 0.72, y: 0.9, z: 0.42 };

/**
 * Box around everything that stayed with the body: the chassis plate and the
 * electronics on it, meaning the meshes binding did not pull into a leg group.
 * Held in model space so it rides along when the gait carries the robot.
 */
function buildChassisBox(model) {
  App.chassis = null;
  if (!model) return;
  const legGroups = new Set(App.binding.links.map(l => l.group));
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  model.group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.group.matrixWorld).invert();
  let seen = 0;
  for (const mesh of model.meshes) {
    let inLeg = false;
    for (let p = mesh; p; p = p.parent) if (legGroups.has(p)) { inLeg = true; break; }
    if (inLeg) continue;
    const pos = mesh.geometry.attributes.position;
    const stride = Math.max(1, Math.floor(pos.count / 400));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(inv);
      box.expandByPoint(v);
      seen++;
    }
  }
  if (seen < 8 || box.isEmpty()) return;
  // Keep the central core only. The plate is a star whose spokes reach out to the
  // hips, so its full box swallows each leg's tibia even at rest. Scale the span
  // rather than inset it: insetting both sides by a fraction of the full size
  // collapses the box once that fraction passes 0.5.
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  box.setFromCenterAndSize(c, new THREE.Vector3(
    s.x * CHASSIS_KEEP.x, s.y * CHASSIS_KEEP.y, s.z * CHASSIS_KEEP.z));
  App.chassis = { box, inv, model };
}

/**
 * Everything the camera should frame. Binding reparents each leg's meshes out of
 * the model group and into its own bone group, so the model group on its own is
 * just the chassis.
 */
export function frameRig() {
  frameModel([App.models[0]?.group, ...App.binding.links.map(l => l.group)]);
}

/** Show/hide the colored rig bones + joints + targets (mesh stays put). */
export function setRigVisible(v) {
  App.rigVisible = v;
  for (const c of App.chains) {
    c.group.visible = v;
    c.targetGroup.visible = v && c.joints.length >= 2;
  }
  if (!v) App.tcontrols.detach();
  else if (App.mode === 'solve' && App.activeChain?.joints.length >= 2) {
    App.tcontrols.attach(App.activeChain.targetGroup);
  }
}

/** The model a walking gait should carry along: the biggest visible free model. */
export function gaitBodyModel() {
  return App.models.filter(m => m.visible && !m.attachedTo)
    .sort((a, b) => b.meshes.length - a.meshes.length)[0] ?? null;
}

/** Re-baseline every chain's collision guard (after toggling guard options or obstacles). */
export function rebaselineCollisions() {
  for (const c of App.chains) { c.resetSafety(); c.targetDirty = true; }
}

// --- picking ---------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
let downX = 0, downY = 0;

function initPicking() {
  const el = App.renderer.domElement;
  el.addEventListener('pointerdown', e => { downX = e.clientX; downY = e.clientY; });
  el.addEventListener('pointerup', e => {
    if (e.button !== 0) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return; // was a drag
    if (App.tcontrols.dragging) return;
    if (performance.now() - (App.gizmoReleasedAt ?? -1e9) < 250) return; // just let go of the gizmo
    handleClick(e);
  });
}

function castAt(e, objects) {
  pointerNDC.set(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );
  raycaster.setFromCamera(pointerNDC, App.camera);
  return raycaster.intersectObjects(objects, false);
}

function handleClick(e) {
  // 1. selecting joints
  const jointMeshes = [];
  for (const c of App.chains) if (c.visible) jointMeshes.push(...c.joints.map(j => j.mesh));
  const hits = castAt(e, jointMeshes);
  if (hits.length) {
    const ud = hits[0].object.userData;
    selectJoint({ chain: ud.chain, index: ud.index });
    return;
  }
  // 2. selecting a leg via its bones
  const boneMeshes = [];
  for (const c of App.chains) if (c.visible) boneMeshes.push(...c.boneMeshes);
  const bHits = castAt(e, boneMeshes);
  if (bHits.length) {
    setActiveChain(bHits[0].object.userData.chain);
    return;
  }
  // 3. empty click: deselect joint
  if (App.selectedJoint) selectJoint(null);
}

// --- attached models -------------------------------------------------------

const _mDir = new THREE.Vector3();
const _mUp = new THREE.Vector3(0, 1, 0);

function updateAttachedModels() {
  for (const m of App.models) {
    if (!m.attachedTo) continue;
    const { chain, index } = m.attachedTo;
    if (!App.chains.includes(chain) || index >= chain.joints.length) { m.attachedTo = null; continue; }
    const j = chain.joints[index];
    m.group.position.copy(j.pos);
    // orient along the incoming bone (or outgoing for the root)
    if (index > 0) _mDir.subVectors(j.pos, chain.joints[index - 1].pos);
    else if (chain.joints.length > 1) _mDir.subVectors(chain.joints[1].pos, j.pos);
    else _mDir.set(0, 1, 0);
    if (_mDir.lengthSq() > 1e-10) {
      m.group.quaternion.setFromUnitVectors(_mUp, _mDir.normalize());
    }
  }
}

// --- keyboard --------------------------------------------------------------

function initKeys() {
  window.addEventListener('keydown', e => {
    // Escape closes the help card even when a control has focus
    if (e.code === 'Escape' && App.ui?.helpOpen()) { App.ui.closeHelp(); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.code) {
      case 'Digit1': setMode('build'); break;
      case 'Digit2': setMode('solve'); break;
      case 'KeyH':
      case 'Slash': // '?' on most layouts
        e.preventDefault();
        App.ui?.toggleHelp();
        break;
      case 'KeyP':
        App.togglePanels?.();
        break;
      case 'KeyF':
        if (App.models[0]) frameRig(); // re-frame after orbiting somewhere unhelpful
        break;
      case 'Space':
        e.preventDefault();
        App.ui?.toggleWalk();
        break;
    }
  });
}

// --- loop ------------------------------------------------------------------

const clock = new THREE.Clock();
const _camDelta = new THREE.Vector3();
let fpsFrames = 0, fpsTimer = 0;

// Nothing moves in this scene unless the user or the gait moves it, so the loop
// only does work on frames that can look different. IDLE_PERIOD is a slow
// heartbeat: some drivers do not preserve the drawing buffer indefinitely, and
// one frame a second costs nothing.
const IDLE_PERIOD = 1;
let needsRender = true;
let idleFor = 0;

export function invalidate() { needsRender = true; }

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);

  // frames actually rendered per second — reads 0 while the loop is idle
  fpsTimer += dt;
  if (fpsTimer >= 0.5) {
    App.fps = Math.round(fpsFrames / fpsTimer);
    fpsFrames = 0; fpsTimer = 0;
  }

  idleFor += dt;
  if (!needsRender && !App.gait.active && idleFor < IDLE_PERIOD) {
    App.ui?.updateTelemetry(dt);
    return;
  }
  needsRender = false;
  idleFor = 0;

  App.orbit.update();

  // gait engine drives all leg chains + body; the camera follows the body
  if (App.gait.active) {
    App.gait.update(dt);
    const bodyPos = App.gait.model?.group.position;
    if (bodyPos) {
      if (App._followPos) {
        _camDelta.subVectors(bodyPos, App._followPos);
        App.camera.position.add(_camDelta);
        App.orbit.target.add(_camDelta);
      }
      (App._followPos ??= new THREE.Vector3()).copy(bodyPos);
    }
  } else {
    App._followPos = null;
  }

  // The chassis box is stored in model space. Its inverse only goes stale when
  // the gait carries the robot, so recompute it then and not on every frame.
  if (App.chassis && App.gait.active) {
    App.chassis.model.group.updateMatrixWorld(true);
    App.chassis.inv.copy(App.chassis.model.group.matrixWorld).invert();
  }
  const collisionCtx = {
    models: App.models, opts: App.collisionOpts,
    chassis: App.chassis, chains: App.chains,
  };
  for (const c of App.chains) {
    if (c.targetDirty) { c.solve(collisionCtx); c.targetDirty = false; }
  }

  updateAttachedModels();
  App.binding.update();

  fpsFrames++;
  App.ui?.updateTelemetry(dt);

  // keep the contact shadow under the body
  if (App.contactShadow?.visible && App.models[0]) {
    const g = App.models[0].group;
    App.contactShadow.position.x = g.position.x;
    App.contactShadow.position.z = g.position.z;
  }

  App.govern?.(dt);
  App.renderer.render(App.scene, App.camera);
}

// --- boot ------------------------------------------------------------------

initScene();
App.gait = new GaitEngine();
// when a walk stops, the body snaps back to its start — move the camera with it
App.gait.onStop = delta => {
  App.camera.position.add(delta);
  App.orbit.target.add(delta);
  App._followPos = null;
};
App.binding = new RigBinding();
initPicking();
initKeys();
App.ui = initUI(App);
setMode('solve');
App.ui.refreshAll();
tick();
