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
window.__IK_APP = App; // debugging hooks
window.__THREE = THREE;

// ---------------------------------------------------------------- scene

function initScene() {
  const viewport = document.getElementById('viewport');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  // the governor owns the pixel ratio from here
  App.govern = createResolutionGovernor(renderer);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  viewport.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d10);
  scene.fog = new THREE.Fog(0x0b0d10, 22, 55);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 200);
  camera.position.set(6.5, 4.5, 7.5);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 1.6, 0);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.maxPolarAngle = Math.PI * 0.52;
  orbit.minDistance = 1;
  orbit.maxDistance = 40;

  // Lighting. The printed parts are near-black PBR, so directional light alone
  // leaves the whole robot a silhouette — the metal has nothing to reflect.
  // A prefiltered room probe gives every surface an environment to sample, which
  // is what makes the edges and the servo horns read at all.
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

  // floor grids
  const grid = new THREE.GridHelper(30, 30, 0x2a323e, 0x1a2028);
  grid.material.transparent = true;
  grid.material.opacity = 0.85;
  scene.add(grid);
  const gridFine = new THREE.GridHelper(30, 150, 0x141a21, 0x12171d);
  gridFine.position.y = -0.002;
  scene.add(gridFine);

  // origin axes (short)
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

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    // dragging a window edge fires this continuously, and each call reallocates
    // the drawing buffer
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    }, 80);
  });

  Object.assign(App, { scene, camera, renderer, orbit, tcontrols });
}

// ---------------------------------------------------------------- framing

/**
 * Point the camera at `object` and pull back far enough to hold all of it.
 * The rig is built from CAD, so its size is only known after the GLB parses —
 * a hardcoded start pose leaves the robot small and off-centre. Called once,
 * from the load handler.
 *
 * `leftBias` shifts the subject right in screen space to clear the sidebar.
 */
export function frameModel(object, { padding = 1.45, leftBias = 0.16 } = {}) {
  const { camera, orbit } = App;
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // distance that fits the bounding sphere in the *narrower* of the two FOVs
  const radius = size.length() / 2;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * padding;

  // keep the existing three-quarter view direction, just re-seat it
  const dir = new THREE.Vector3(0.62, 0.42, 0.66).normalize();
  orbit.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, dist);

  // slide the target sideways so the sidebar does not cover the subject
  if (leftBias) {
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    const shift = right.multiplyScalar(-radius * leftBias * 2);
    orbit.target.add(shift);
    camera.position.add(shift);
  }

  camera.near = Math.max(0.01, dist / 200);
  camera.far = dist * 12;
  camera.updateProjectionMatrix();
  orbit.update();
}

// ---------------------------------------------------------------- gizmo / modes

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

// ---------------------------------------------------------------- gait auto-rig

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

  // real articulation pivots come from the CAD occurrences: each leg has three
  // servos, and each servo's SHAFT (not its body center) is where the joint
  // axis runs — through the horn on one side and the bearing casing on the
  // other. The shaft is located as the overlap between the servo's box and the
  // link it drives (art_1/2/3), which wraps the shaft/bearing coaxially.
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

  // Servo mounting:
  //  - HIP: inverted "double-head" trick — the horn is anchored to the chassis,
  //    so the servo BODY rotates on the spot together with its casing and both
  //    articulation attachment points (one on the head, one riding the bearing).
  //    Everything at the hip except the chassis bracket moves with the coxa.
  //  - SHOULDER / KNEE: conventional — servo + casing bolted to the link BEFORE
  //    the joint; only the articulation on the horn rotates.
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
    // Ground truth for every part: it rigidly follows the articulation link it
    // is SCREWED to, i.e. the one its mesh overlaps most. This handles all mount
    // styles automatically — the hip servo body overlaps the coxa (inverted
    // "double-head" trick, so it spins with the coxa), while the knee servo body
    // overlaps the femur (conventional mount, so it stays put as the tibia bends).
    const legArts = arts.map(list => {
      let best = null, bestA = 0.33;
      for (const a of list) {
        const d = angDiff(angOf(a.center), fAng);
        if (d < bestA) { bestA = d; best = a; }
      }
      return best ? { ...best, bearingErr: bestA } : null;
    });
    // Claim the coxa / femur / tibia for THIS leg, exactly like every servo and
    // bracket already is. Without this they were the one part class left with no
    // exact claim: the assigner matched them by name and returned a bare bone
    // index, and binding.js resolves a bare index against whichever leg its
    // bearing heuristic picked. When that guess missed, the whole articulation
    // link jumped to a neighbouring leg while its servo — exactly claimed —
    // stayed behind. That is the part visibly detaching from the servo.
    // The score is the bearing error, so if two legs both reach for the same
    // link the closer one keeps it.
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

    // Bind every movable part — servo bodies, their casing/second-head
    // sub-pieces, and yokes — by the link it's SCREWED to (max mesh overlap).
    // A part that overlaps nothing clearly (a casing boss sitting right on a
    // joint axis) falls back to the nearest joint pivot, so it stays at that
    // axis and spins in place like a servo head instead of being left behind.
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
    // Servo bodies (with their nested casing sub-parts) follow the double-head
    // mount: the body is carried by the articulation it drives, while its heads
    // sit ON the joint axis so they only spin in place, never translate away.
    //   hip → coxa (drives the coxa, spins in place on the yaw axis)
    //   shoulder → femur (drives the femur, rotates with it)
    //   knee → femur (drives the tibia, so it STAYS as the knee bends)
    // Bbox overlap is unreliable here (a servo body straddles its joint), so
    // these use an explicit map; -Infinity outranks any overlap/pivot claim.
    // Each servo is two meshes: the BODY and a small HORN/head. They sit on
    // OPPOSITE sides of the joint — the body is carried by one link while the
    // head is anchored across the joint, staying seated in its bearing.
    //   hip:      body→coxa,  head→chassis
    //   shoulder: body→femur, head→coxa   (head stays fixed as the femur swings)
    //   knee:     body→femur, head→tibia  (body stays as the tibia swings)
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
        // 'body' must be passed through as the literal chassis marker — wrapping
        // it in { bone } makes binding.js run Math.min('body', n) → NaN
        claim(kids[k], hb === 'body' ? 'body' : { chain, bone: hb }, -Infinity);
      }
    });
    // Yokes / brackets bind by their screwed connection (overlap): a fixed
    // casing overlaps the parent link, a driven bracket overlaps the child.
    for (const o of others) bindMovable(o);
    chain.addJoint(mount);
    chain.addJoint(shoulder);
    chain.addJoint(knee);
    chain.addJoint(foot.clone());
    // hinge axes: hip yaws about vertical; shoulder/knee pitch about the
    // horizontal axis perpendicular to the leg's radial plane
    const out = _fv.set(foot.x - center.x, 0, foot.z - center.z).normalize();
    const pitchAxis = new THREE.Vector3(0, 1, 0).cross(out).normalize();
    // Sweeps come from the real servo travel (octorig's LIMITS, one source of
    // truth with the playground): each limit is a ±angle about the rest pose, so
    // the total sweep is twice it. Hand-picked wider numbers used to live here,
    // which let the workbench bend legs further than the hardware ever could.
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
  // octobot part placement: articulation links by name; servos + casings by
  // identified occurrence to the PARENT side of their joint; everything else
  // keeps the geometric nearest-bone rule.
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
  // the mesh is the visualization now — hide the colored rig skeleton by default
  setRigVisible(false);
  App.ui?.refreshAll();
  return { legs: feet.length, bound };
}

/**
 * Give every bone the thickness of the parts bound to it.
 *
 * The collision guard works on bone segments, which are infinitely thin lines
 * running down the middle of each link. What the user actually sees is the
 * mesh, and a coxa or femur is a wide bracket-and-servo cluster — so a pose
 * could have parts visibly buried in the chassis while the bone line itself
 * passed cleanly through open air, and the guard saw nothing. Measuring each
 * bone's radius from its own bound geometry is what connects the two.
 *
 * A mid percentile, not the max: these clusters have outlying mounting ears
 * whose distance would inflate the whole link into a sphere and make every pose
 * a collision.
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

// Fraction of the body plate's span kept as the collision box. Tuned by
// measuring rest-pose intrusion: the largest box for which no bone of any of the
// 8 legs overlaps it while standing, so nothing gets baselined into a blind spot.
const CHASSIS_KEEP = { x: 0.72, y: 0.9, z: 0.42 };

/**
 * Box of everything that stayed with the body — the chassis plate and the
 * electronics on it, i.e. the meshes binding did NOT pull into a leg group.
 * Stored in model-local space so it rides along when the gait carries the robot.
 * Shrunk a little in XZ: the plate's outer edge is where the hip brackets bolt
 * on, and those legitimately sit right against it.
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
  // Keep only the central core. The plate is a star whose spokes reach out to
  // the hips, so its full box swallows each leg's tibia even at the rest pose —
  // and a contact present at rest is absorbed into the guard's baseline, turning
  // that bone into a permanent blind spot. CHASSIS_KEEP is the fraction of the
  // span retained (not an inset: shrinking both sides by a fraction of the full
  // size collapses the box once that fraction passes 0.5).
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  box.setFromCenterAndSize(c, new THREE.Vector3(
    s.x * CHASSIS_KEEP.x, s.y * CHASSIS_KEEP.y, s.z * CHASSIS_KEEP.z));
  App.chassis = { box, inv, model };
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

// ---------------------------------------------------------------- picking

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

// ---------------------------------------------------------------- attached models

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

// ---------------------------------------------------------------- keyboard

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
        // re-frame after the camera has been orbited somewhere unhelpful
        if (App.models[0]) frameModel(App.models[0].group);
        break;
      case 'Space':
        e.preventDefault();
        App.ui?.toggleWalk();
        break;
    }
  });
}

// ---------------------------------------------------------------- loop

const clock = new THREE.Clock();
const _camDelta = new THREE.Vector3();
let fpsAccum = 0, fpsFrames = 0, fpsTimer = 0;

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);

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

  // the chassis box lives in model space; refresh its inverse each frame so the
  // guard follows the robot while the gait carries it across the grid
  if (App.chassis) {
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

  // fps
  fpsAccum += dt; fpsFrames++;
  fpsTimer += dt;
  if (fpsTimer > 0.5) {
    App.fps = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0; fpsFrames = 0; fpsTimer = 0;
  }
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

// ---------------------------------------------------------------- boot

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
