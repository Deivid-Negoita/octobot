// octorig.js — loads the octobot GLB and builds a mechanically-true rig:
// a real transform HIERARCHY (chassis → hip → shoulder → knee) so parts can
// never detach, with exact closed-form IK per leg (yaw + 2-link planar).
//
// Servo split (validated against the physical build):
//   hip:      servo body + casing rotate with the coxa (inverted mount),
//             servo head stays on the chassis
//   shoulder: servo body rides the femur, head stays seated in the coxa bearing
//   knee:     servo body stays on the femur, head rotates with the tibia
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fetchArrayBuffer } from './boot.js';

const UP = new THREE.Vector3(0, 1, 0);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/**
 * Joint limits (radians from the rest pose). These are the ranges the physical
 * linkage can sweep without the brackets fouling — not the servo's full travel.
 *
 * They were widened to ±90° at one point, and that is what produced the folded,
 * curled leg poses: around obstacles 43–55% of frames had a joint past 60°, with
 * both shoulder and knee pinned at the ±90° stop. Measured side by side, the
 * tighter values cost nothing and fix it — identical climb heights (0.22 / 0.43),
 * walking distance within 3%, and strictly better everywhere else:
 *
 *            frames past 60°   clip frames   deepest penetration
 *   ±90°         43-55%         0.3 / 2.4%      37 / 153 mm
 *   these          0%           0.0 / 1.2%       7 /  61 mm
 */
export const LIMITS = { yaw: 0.55, shoulder: Math.PI / 2, knee: Math.PI / 2 };
const clamp = THREE.MathUtils.clamp;
const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));
const angDiff = (a, b) => Math.abs(THREE.MathUtils.euclideanModulo(a - b + Math.PI, Math.PI * 2) - Math.PI);

async function loadGLB(url, onProgress) {
  const buf = await fetchArrayBuffer(url, onProgress);
  return new Promise((ok, err) => new GLTFLoader().parse(buf, '', ok, err));
}

function worldBox(o) { return new THREE.Box3().setFromObject(o); }

function overlapVol(a, b) {
  const x = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const y = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
  const z = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
  return (x > 0 && y > 0 && z > 0) ? x * y * z : 0;
}

/** Cluster ground-contact vertices into foot positions. */
function detectFeet(root) {
  root.updateMatrixWorld(true);
  // cluster radius scales with the model so smaller walkers don't merge feet
  const span = worldBox(root).getSize(V());
  const clusterR = Math.max(0.08, Math.max(span.x, span.z) * 0.11);
  const v = V();
  const contacts = [];
  root.traverse(m => {
    if (!m.isMesh) return;
    const pos = m.geometry.attributes.position;
    const stride = Math.max(1, Math.floor(pos.count / 20000));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (v.y < 0.07) contacts.push(v.clone());
    }
  });
  const clusters = [];
  for (const p of contacts) {
    let best = null, bd = clusterR;
    for (const cl of clusters) {
      const d = Math.hypot(p.x - cl.c.x, p.z - cl.c.z);
      if (d < bd) { bd = d; best = cl; }
    }
    if (best) { best.n++; best.c.lerp(p, 1 / best.n); }
    else clusters.push({ c: p.clone(), n: 1 });
  }
  clusters.sort((a, b) => b.n - a.n);
  return clusters.slice(0, 8).filter(c => c.n >= 3).map(c => V(c.c.x, 0, c.c.z));
}

export async function loadOctobot(url, scene, onProgress) {
  const gltf = await loadGLB(url, onProgress);
  const g = gltf.scene;
  g.rotation.x = -Math.PI / 2; // CAD Z-up → scene Y-up

  const wrap = new THREE.Group();
  wrap.add(g);
  const root = new THREE.Group(); // the chassis / body node — move this to move the robot
  root.name = 'octobot';
  root.add(wrap);
  scene.add(root);
  root.updateMatrixWorld(true);

  // normalize: largest dimension = 3 units, centered, base on y=0
  let box = worldBox(wrap);
  const size = box.getSize(V());
  wrap.scale.setScalar(3 / Math.max(size.x, size.y, size.z));
  root.updateMatrixWorld(true);
  box = worldBox(wrap);
  const bc = box.getCenter(V());
  wrap.position.set(-bc.x, -box.min.y, -bc.z);
  root.updateMatrixWorld(true);

  // assembly root = deepest single-child descent
  let occRoot = g;
  while (occRoot.children.length === 1) occRoot = occRoot.children[0];

  // collect occurrences (world boxes, post-normalization)
  const servos = [], arts = [[], [], []], others = [];
  for (const node of occRoot.children) {
    const name = node.name ?? '';
    const b = worldBox(node);
    if (b.isEmpty()) continue;
    const entry = { node, box: b, center: b.getCenter(V()) };
    const artM = name.match(/art_([123])/i);
    if (/servo/i.test(name)) servos.push(entry);
    else if (artM) arts[+artM[1] - 1].push(entry);
    else others.push(entry);
  }

  const feet = detectFeet(root);
  if (feet.length < 6) throw new Error('octobot feet not found (' + feet.length + ')');
  const center = worldBox(root).getCenter(V());
  const angOf = p => Math.atan2(p.z - center.z, p.x - center.x);
  const radOf = p => Math.hypot(p.x - center.x, p.z - center.z);

  // ---------------------------------------------------------------- legs
  const legs = [];
  const claims = new Map(); // occurrence node → { targetNode, score }
  const claim = (node, targetNode, score) => {
    const prev = claims.get(node);
    if (!prev || score < prev.score) claims.set(node, { targetNode, score });
  };
  const meshVol = m => {
    const b = worldBox(m);
    if (b.isEmpty()) return 0;
    const s = b.getSize(V());
    return s.x * s.y * s.z;
  };

  for (const foot of feet) {
    const fAng = angOf(foot);
    const legServos = servos
      .filter(s => angDiff(angOf(s.center), fAng) < 0.28)
      .sort((a, b) => radOf(a.center) - radOf(b.center));
    if (legServos.length < 3) continue;
    const legArts = arts.map(list => {
      let best = null, ba = 0.33;
      for (const a of list) {
        const d = angDiff(angOf(a.center), fAng);
        if (d < ba) { ba = d; best = a; }
      }
      return best;
    });
    // split each servo occurrence into BODY (largest mesh) + HEADS (the rest)
    const servoKids = legServos.slice(0, 3).map(sv => {
      const kids = [];
      sv.node.traverse(o => { if (o.isMesh) kids.push(o); });
      kids.sort((a, b) => meshVol(b) - meshVol(a));
      return kids;
    });

    // Joint pivot = the servo HEAD's centre. The horn / printed second head sits
    // exactly on the shaft axis, so anchoring the joint there makes the servo
    // body rotate AROUND its head rather than orbiting an offset point — the
    // head and the body stay coaxial through the whole sweep. A bounding-box
    // overlap centre is only a fallback for servos with no separate head mesh.
    const pivotOf = (i, art) => {
      const head = servoKids[i] && servoKids[i][1];
      if (head) {
        const hb = worldBox(head);
        if (!hb.isEmpty()) return hb.getCenter(V());
      }
      const sv = legServos[i];
      if (art) {
        const ib = sv.box.clone().intersect(art.box);
        if (!ib.isEmpty()) return ib.getCenter(V());
      }
      return sv.center.clone();
    };
    const P_hip = pivotOf(0, legArts[0]);
    const P_sh = pivotOf(1, legArts[1]);
    const P_kn = pivotOf(2, legArts[2]);

    // hierarchy nodes (root-local == world at rest)
    const hip = new THREE.Group(); hip.position.copy(P_hip); root.add(hip);
    const shoulder = new THREE.Group(); shoulder.position.copy(P_sh).sub(P_hip); hip.add(shoulder);
    const knee = new THREE.Group(); knee.position.copy(P_kn).sub(P_sh); shoulder.add(knee);

    // leg frame at rest
    const e_r = V(foot.x - center.x, 0, foot.z - center.z).normalize();
    const e_t = V().crossVectors(UP, e_r).normalize(); // lateral / pitch axis
    const dec = (a, b) => { const d = V().subVectors(a, b); return { r: d.dot(e_r), y: d.y, t: d.dot(e_t) }; };
    const dSh = dec(P_sh, P_hip), dKn = dec(P_kn, P_sh), dFt = dec(foot, P_kn);
    const L1 = Math.hypot(dKn.r, dKn.y);
    const L2 = Math.hypot(dFt.r, dFt.y);
    const a1_rest = Math.atan2(dKn.y, dKn.r);
    const a2_rest = wrapPi(Math.atan2(dFt.y, dFt.r) - a1_rest);
    const lat = dSh.t + dKn.t + dFt.t;

    const leg = {
      name: 'LEG-' + (legs.length + 1),
      hip, shoulder, knee,
      P_hip: P_hip.clone(), e_r, e_t,
      s_r: dSh.r, s_y: dSh.y,
      L1, L2, a1_rest, a2_rest, lat,
      footRest: foot.clone(),
      footLocal: null, // set after meshes are attached (knee frame)
      s0: 1, s1: 1, s2: 1,
      _lastA1: a1_rest,
      angles: { yaw: 0, shoulder: 0, knee: 0 }, // degrees, for telemetry
      _servoNodes: legServos, _artNodes: legArts,
    };
    legs.push(leg);

    // ---- claim meshes for this leg
    // Each servo splits into a BODY (largest sub-mesh) and its HEAD(s). The two
    // sit on opposite sides of the joint, which is what makes the body spin on
    // the spot while the head stays seated in its bearing:
    //   J0 hip      inverted double-head — body turns with the coxa,  head on chassis
    //   J1 shoulder inverted double-head — body turns with the femur, heads on coxa
    //   J2 knee     conventional         — body fixed on the femur,   head turns with tibia
    // Brackets/casings bolted to a servo body follow that body's link.
    const servoBodyTarget = [hip, shoulder, shoulder];
    const servoHeadTarget = [root, hip, knee];
    servoKids.forEach((kids, i) => {
      if (kids[0]) claim(kids[0], servoBodyTarget[i], -Infinity);
      for (let k = 1; k < kids.length; k++) claim(kids[k], servoHeadTarget[i], -Infinity);
    });
    // articulation links
    const artTarget = [hip, shoulder, knee];
    legArts.forEach((a, i) => { if (a) claim(a.node, artTarget[i], -Infinity); });
    // Brackets / yokes (separate Component occurrences — the servo's own heads
    // are sub-meshes handled above). Each is SCREWED to an articulation link and
    // must move with it: e.g. the knee yoke (Component18x) wraps the horn and is
    // bolted to the tibia, so it has to follow the tibia to the foot — binding it
    // to the servo body's link (femur) leaves it dangling at the knee pivot.
    // So: articulation overlap wins; only parts that touch NO articulation fall
    // back to the servo body, then to the nearest pivot.
    for (const o of others) {
      if (angDiff(angOf(o.center), fAng) > 0.45) continue;
      const s = o.box.getSize(V());
      const own = Math.max(s.x * s.y * s.z, 1e-9);
      // 1. which articulation link is it screwed to?
      let bv = 0, bi = -1;
      legArts.forEach((a, k) => {
        if (!a) return;
        const vv = overlapVol(o.box, a.box);
        if (vv > bv) { bv = vv; bi = k; }
      });
      if (bi >= 0 && bv > 0.08 * own) { claim(o.node, artTarget[bi], -1e6 - bv); continue; }
      // 2. no articulation contact — maybe it's a servo casing/mount
      let sv = 0, si = -1;
      legServos.slice(0, 3).forEach((q, k) => {
        const vv = overlapVol(o.box, q.box);
        if (vv > sv) { sv = vv; si = k; }
      });
      if (si >= 0 && sv > 0.05 * own) {
        claim(o.node, servoBodyTarget[si], -sv);
      } else {
        const pivots = [[P_hip, hip], [P_sh, shoulder], [P_kn, knee]];
        for (const [p, t] of pivots) {
          const d = o.center.distanceTo(p);
          if (d < 0.28) claim(o.node, t, d);
        }
      }
    }
  }
  if (legs.length < 6) throw new Error('only ' + legs.length + ' legs rigged');

  // ---------------------------------------------------------------- attach
  root.updateMatrixWorld(true);
  for (const [node, { targetNode }] of claims) targetNode.attach(node);
  root.updateMatrixWorld(true);
  for (const leg of legs) {
    leg.footLocal = leg.knee.worldToLocal(leg.footRest.clone());
  }

  // ---------------------------------------------------------------- calibrate hinge signs
  // probe each pivot with a small rotation and measure which way it swings
  const chassisLocal = p => root.worldToLocal(p.clone());
  const footWorld = leg => leg.knee.localToWorld(leg.footLocal.clone());
  const kneeWorld = leg => leg.knee.getWorldPosition(V());
  const shWorld = leg => leg.shoulder.getWorldPosition(V());

  for (const leg of legs) {
    const bearing = () => {
      const d = chassisLocal(footWorld(leg)).sub(leg.P_hip);
      return Math.atan2(d.dot(leg.e_t), d.dot(leg.e_r));
    };
    const a1m = () => {
      const d = chassisLocal(kneeWorld(leg)).sub(chassisLocal(shWorld(leg)));
      return Math.atan2(d.y, d.dot(leg.e_r));
    };
    const a2m = () => {
      const d = chassisLocal(footWorld(leg)).sub(chassisLocal(kneeWorld(leg)));
      return wrapPi(Math.atan2(d.y, d.dot(leg.e_r)) - a1m());
    };
    const probe = (pivot, axis, fn) => {
      const before = fn();
      pivot.quaternion.setFromAxisAngle(axis, 0.1);
      root.updateMatrixWorld(true);
      const after = fn();
      pivot.quaternion.identity();
      root.updateMatrixWorld(true);
      return Math.sign(wrapPi(after - before)) || 1;
    };
    leg.s0 = probe(leg.hip, UP, bearing);
    leg.s1 = probe(leg.shoulder, leg.e_t, a1m);
    leg.s2 = probe(leg.knee, leg.e_t, a2m);
  }

  // ---------------------------------------------------------------- joint stops
  // Per-leg, per-direction stops. They are plain servo travel here: sweeping the
  // knee through its whole ±90° and testing the tibia against the femur (raycast
  // containment, ground truth) shows the count of tibia points inside femur
  // material stays flat — those two links never actually foul each other on this
  // CAD, so there is no mechanical stop tighter than the servo's own to find.
  //
  // What DOES limit a leg is the chassis and its neighbours, and that is
  // pose-dependent, not a fixed per-joint angle — it is enforced as a collision
  // check rather than folded into these numbers. The asymmetric [lo, hi] form is
  // kept because it is what the rest of the code reads.
  for (const leg of legs) {
    leg.limYaw = [-LIMITS.yaw, LIMITS.yaw];
    leg.limShoulder = [-LIMITS.shoulder, LIMITS.shoulder];
    leg.limKnee = [-LIMITS.knee, LIMITS.knee];
  }

  // ---------------------------------------------------------------- API
  /**
   * Exact IK: place this leg's foot at targetWorld (best effort within reach).
   * Sets the three pivot rotations; returns joint angles in radians.
   */
  function solveLeg(leg, targetWorld) {
    const d = chassisLocal(targetWorld).sub(leg.P_hip);
    const dr = d.dot(leg.e_r), dt = d.dot(leg.e_t), dy = d.y;
    const rho = Math.max(Math.hypot(dr, dt), 1e-6);
    const th0 = Math.atan2(dt, dr) - Math.asin(clamp(leg.lat / rho, -1, 1));
    const rEff = Math.sqrt(Math.max(rho * rho - leg.lat * leg.lat, 1e-8));
    let pr = rEff - leg.s_r, py = dy - leg.s_y;
    let D = Math.hypot(pr, py);
    const Dc = clamp(D, Math.abs(leg.L1 - leg.L2) + 1e-4, leg.L1 + leg.L2 - 1e-4);
    if (D !== Dc) { const f = Dc / Math.max(D, 1e-9); pr *= f; py *= f; D = Dc; }
    const base = Math.atan2(py, pr);
    const off = Math.acos(clamp((leg.L1 * leg.L1 + D * D - leg.L2 * leg.L2) / (2 * leg.L1 * D), -1, 1));
    const c1 = base + off, c2 = base - off;
    // the physical knee only assembles one way — always take the rest-side branch
    const a1 = Math.abs(wrapPi(c1 - leg.a1_rest)) <= Math.abs(wrapPi(c2 - leg.a1_rest)) ? c1 : c2;
    const a2 = Math.atan2(py - leg.L1 * Math.sin(a1), pr - leg.L1 * Math.cos(a1)) - a1;
    let th1 = wrapPi(a1 - leg.a1_rest);
    let th2 = wrapPi(wrapPi(a2) - leg.a2_rest);
    // Measured mechanical stops (asymmetric): the tighter of servo travel and
    // where the links actually touch. Falls back to the symmetric servo range
    // if calibration could not sample this joint.
    const lY = leg.limYaw ?? [-LIMITS.yaw, LIMITS.yaw];
    const lS = leg.limShoulder ?? [-LIMITS.shoulder, LIMITS.shoulder];
    const lK = leg.limKnee ?? [-LIMITS.knee, LIMITS.knee];
    const th0c = clamp(th0, lY[0], lY[1]);
    th1 = clamp(th1, lS[0], lS[1]);
    // *** consistency fix *** the knee was solved from the UN-clamped shoulder, so
    // when the shoulder hit its limit the knee kept pointing where the geometry no
    // longer is → the lower leg whipped into a folded / body-clipping "impossible"
    // pose. Recompute the knee from the ACTUAL (clamped) shoulder so the two-link
    // chain stays self-consistent. When the shoulder is NOT clamped, a1c == a1 and
    // this reproduces the original a2 exactly (flat-ground walk is unchanged).
    const a1c = leg.a1_rest + th1;
    const a2c = Math.atan2(py - leg.L1 * Math.sin(a1c), pr - leg.L1 * Math.cos(a1c)) - a1c;
    th2 = wrapPi(wrapPi(a2c) - leg.a2_rest);
    th2 = clamp(th2, lK[0], lK[1]);
    leg.hip.quaternion.setFromAxisAngle(UP, leg.s0 * th0c);
    leg.shoulder.quaternion.setFromAxisAngle(leg.e_t, leg.s1 * th1);
    leg.knee.quaternion.setFromAxisAngle(leg.e_t, leg.s2 * th2);
    const deg = THREE.MathUtils.radToDeg;
    leg.angles = { yaw: deg(th0c), shoulder: deg(th1), knee: deg(th2) };
    return { th0: th0c, th1, th2 };
  }

  return { root, legs, solveLeg, footWorld, center: center.clone() };
}
