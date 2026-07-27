// collision.js — pose collision checks: bones vs obstacle models, self, floor
//
// Every contact gets a stable string flag ("m3:b1", "floor:b2", "self:0:2").
// The chain keeps the flag set of its last accepted pose as a baseline, so
// contacts that existed when the rig was built (joints placed inside the model
// being rigged) don't block — only NEW contacts do.
import * as THREE from 'three';

const SEG_EPS = 0.045;   // skip this much of a segment at each end (joints often sit on surfaces)
const SELF_RADIUS = 0.1; // min clearance between non-adjacent bones (bone visual thickness)
const FLOOR_Y = -0.02;   // tolerance below ground plane

const _ray = new THREE.Raycaster();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _r = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();

/** Closest distance between segments p1q1 and p2q2 (Ericson, RTCD 5.1.9). */
function segSegDistance(p1, q1, p2, q2) {
  _d1.subVectors(q1, p1);
  _d2.subVectors(q2, p2);
  _r.subVectors(p1, p2);
  const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
  const EPS = 1e-10;
  let s, t;
  if (a <= EPS && e <= EPS) return p1.distanceTo(p2);
  if (a <= EPS) {
    s = 0;
    t = THREE.MathUtils.clamp(f / e, 0, 1);
  } else {
    const c = _d1.dot(_r);
    if (e <= EPS) {
      t = 0;
      s = THREE.MathUtils.clamp(-c / a, 0, 1);
    } else {
      const b = _d1.dot(_d2);
      const denom = a * e - b * b;
      s = denom > EPS ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  _c1.copy(p1).addScaledVector(_d1, s);
  _c2.copy(p2).addScaledVector(_d2, t);
  return _c1.distanceTo(_c2);
}

/**
 * Check a chain pose for collisions.
 * Returns { flags: Set<string>, labels: Map<flag, string> }.
 * opts: { models: bool, self: bool, floor: bool }
 */
export function checkCollisions(chain, models, opts, ctx = null) {
  const flags = new Set();
  const labels = new Map();
  const pts = chain.joints.map(j => j.pos);
  const n = pts.length;
  if (n < 2) return { flags, labels };

  if (opts.models) {
    for (const m of models) {
      if (!m.collidable || !m.visible || m.attachedTo) continue;
      for (let i = 0; i < n - 1; i++) {
        const len = pts[i].distanceTo(pts[i + 1]);
        if (len < SEG_EPS * 2.5) continue;
        _dir.subVectors(pts[i + 1], pts[i]).normalize();
        _origin.copy(pts[i]).addScaledVector(_dir, SEG_EPS);
        _ray.set(_origin, _dir);
        _ray.near = 0;
        _ray.far = len - SEG_EPS * 2;
        if (_ray.intersectObjects(m.meshes, false).length) {
          const f = `m${m.id}:b${i}`;
          flags.add(f);
          labels.set(f, m.name);
        }
      }
    }
  }

  if (opts.floor) {
    for (let i = 0; i < n - 1; i++) {
      if (Math.min(pts[i].y, pts[i + 1].y) < FLOOR_Y) {
        const f = `floor:b${i}`;
        flags.add(f);
        labels.set(f, 'floor');
      }
    }
  }

  if (opts.self) {
    // Bone radii come from the parts actually bound to each bone, so the guard
    // measures the same solid the user sees. Falls back to the old fixed radius
    // for a chain with no mesh on it.
    const rad = i => chain.boneRadii?.[i] ?? SELF_RADIUS;

    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 2; j < n - 1; j++) {
        if (segSegDistance(pts[i], pts[i + 1], pts[j], pts[j + 1]) < rad(i) + rad(j)) {
          const f = `self:${i}:${j}`;
          flags.add(f);
          labels.set(f, 'self');
        }
      }
    }

    // SELF used to mean "this leg against itself" and nothing else, which for a
    // 3-bone leg is one pair of non-adjacent bones. The body and the other seven
    // legs were invisible to it — and the octobot mesh is marked non-collidable
    // once it is bound (it IS the rig), so the MODELS pass skipped them too.
    // Nothing anywhere stopped a leg from swinging straight through the chassis
    // or through its neighbour, which is what made poses look impossible while
    // every joint sat inside its limits.

    // ...against the chassis: the body plate as a box, in model-local space so
    // it follows the robot when the gait carries it around.
    if (ctx?.chassis) {
      const { box, inv } = ctx.chassis;
      for (let i = 0; i < n - 1; i++) {
        _p1.copy(pts[i]).applyMatrix4(inv);
        _p2.copy(pts[i + 1]).applyMatrix4(inv);
        // grow the box by the bone's own radius instead of fattening the segment
        _box.copy(box).expandByScalar(rad(i));
        if (segHitsBox(_p1, _p2, _box)) {
          const f = `chassis:b${i}`;
          flags.add(f);
          labels.set(f, 'chassis');
        }
      }
    }

    // ...and against every other leg
    if (ctx?.chains) {
      for (const other of ctx.chains) {
        if (other === chain || !other.visible) continue;
        const op = other.joints.map(j => j.pos);
        for (let i = 0; i < n - 1; i++) {
          for (let j = 0; j < op.length - 1; j++) {
            const clearance = rad(i) + (other.boneRadii?.[j] ?? SELF_RADIUS);
            if (segSegDistance(pts[i], pts[i + 1], op[j], op[j + 1]) < clearance) {
              const f = `leg${other.id}:b${i}`;
              flags.add(f);
              labels.set(f, other.name);
            }
          }
        }
      }
    }
  }

  return { flags, labels };
}

const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _box = new THREE.Box3();

/** Segment vs axis-aligned Box3 (slab method), both in the same space. */
function segHitsBox(a, b, box) {
  let tmin = 0, tmax = 1;
  for (const ax of ['x', 'y', 'z']) {
    const d = b[ax] - a[ax], lo = box.min[ax], hi = box.max[ax];
    if (Math.abs(d) < 1e-9) { if (a[ax] < lo || a[ax] > hi) return false; continue; }
    let t1 = (lo - a[ax]) / d, t2 = (hi - a[ax]) / d;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

/** Extract the bone indices referenced by a set of collision flags. */
export function bonesFromFlags(flags) {
  const bones = new Set();
  for (const f of flags) {
    const self = f.match(/^self:(\d+):(\d+)$/);
    if (self) { bones.add(+self[1]); bones.add(+self[2]); continue; }
    const b = f.match(/:b(\d+)$/);
    if (b) bones.add(+b[1]);
  }
  return bones;
}
