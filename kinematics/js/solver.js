// solver.js — pure IK solvers operating on arrays of THREE.Vector3 (mutated in place)
import * as THREE from 'three';

const _dir = new THREE.Vector3();
const _toEE = new THREE.Vector3();
const _toT = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _hAxis = new THREE.Vector3();
const _hRef = new THREE.Vector3();
const _hPrev = new THREE.Vector3();
const _hCross = new THREE.Vector3();
const _hQ = new THREE.Quaternion();

/**
 * Clamp `dir` so its angle to `ref` does not exceed maxDeg. Returns dir (mutated).
 */
function clampDirection(dir, ref, maxDeg) {
  if (maxDeg >= 179.9) return dir;
  const max = THREE.MathUtils.degToRad(maxDeg);
  const angle = ref.angleTo(dir);
  if (angle <= max) return dir;
  _axis.crossVectors(ref, dir);
  if (_axis.lengthSq() < 1e-12) {
    // dir is anti-parallel to ref — pick any perpendicular axis
    _axis.set(1, 0, 0).cross(ref);
    if (_axis.lengthSq() < 1e-12) _axis.set(0, 0, 1).cross(ref);
  }
  _axis.normalize();
  dir.copy(ref).applyAxisAngle(_axis, max).normalize();
  return dir;
}

const _Q = new THREE.Quaternion();

const _hFull = new THREE.Vector3();
const _hProj = new THREE.Vector3();

/**
 * Constrain `dir` (mutated) to a hinge joint using the accumulated parent frame
 * Q (serial-FK propagation): the joint's axis and rest direction are the
 * rest-pose world vectors rotated by every parent joint's rotation. Measures the
 * signed sweep, clamps it to ±range/2, rebuilds the bone at that angle, and
 * folds the joint's own rotation into Q. Returns dir.
 *
 * The projection onto the hinge plane is for MEASURING the angle only. Rebuilding
 * the bone from the projected rest direction — which is what this used to do —
 * flattens every bone onto its hinge plane, so at angle 0 the bone does not
 * return to its rest direction. On the octobot the hip yaws about vertical while
 * the coxa rises, so the coxa got squashed flat the first time anything solved:
 * the whole leg lurched off the pose the CAD was authored in and the parts
 * appeared to tear away from their servos. A revolute joint sweeps its rest
 * direction around the axis on a cone, keeping its angle to that axis.
 */
function applyHingeFK(dir, c, Q) {
  _hAxis.copy(c.axis).applyQuaternion(Q).normalize();
  _hFull.copy(c.restDir).applyQuaternion(Q);            // true carried rest direction
  _hRef.copy(_hFull).addScaledVector(_hAxis, -_hFull.dot(_hAxis));
  // rest direction parallel to the axis = pure twist joint; no positional constraint
  if (_hRef.lengthSq() < 1e-10) return dir;
  _hRef.normalize();
  _hProj.copy(dir).addScaledVector(_hAxis, -dir.dot(_hAxis));
  let angle = 0;
  if (_hProj.lengthSq() > 1e-10) {
    _hProj.normalize();
    angle = Math.atan2(_hCross.crossVectors(_hRef, _hProj).dot(_hAxis), _hRef.dot(_hProj));
  }
  if (c.range < 359.9) {
    const half = THREE.MathUtils.degToRad(c.range / 2);
    angle = THREE.MathUtils.clamp(angle, -half, half);
  }
  dir.copy(_hFull).applyAxisAngle(_hAxis, angle).normalize();
  _hQ.setFromAxisAngle(_hAxis, angle);
  Q.premultiply(_hQ);
  return dir;
}

const _upFallback = new THREE.Vector3(0, 1, 0);

/**
 * Project a pose onto the configuration space the joints can actually reach.
 *
 * Walks the chain root → tip and rebuilds every child position by forward
 * kinematics: each joint's outgoing direction is measured in its FK-propagated
 * frame, flattened onto its hinge plane, clamped to the joint's sweep, and the
 * bone is re-placed at its exact rest length. Any pose in, a legal pose out.
 *
 * This is what makes an impossible articulation impossible. A solver that
 * drifted out of a hinge plane, or a restart seed that laid the chain out in a
 * straight line ignoring the joints entirely, cannot survive it — and because
 * positions are rebuilt from the clamped angles, the servo angle readout is
 * exactly the pose on screen.
 */
export function enforceJointLimits(points, lengths, constraints) {
  if (!constraints) return points;
  _Q.identity();
  for (let i = 0; i < points.length - 1; i++) {
    const c = constraints[i];
    _dir.subVectors(points[i + 1], points[i]);
    if (_dir.lengthSq() < 1e-12) _dir.copy(c?.restDir ?? _upFallback);
    _dir.normalize();
    if (c && c.type === 'hinge' && c.axis) {
      applyHingeFK(_dir, c, _Q); // flattens onto the hinge plane, clamps, folds into _Q
    } else if (c) {
      if (c.type === 'ball' && c.maxBend < 179.9 && i >= 1) {
        _hPrev.subVectors(points[i], points[i - 1]);
        if (_hPrev.lengthSq() > 1e-12) clampDirection(_dir, _hPrev.normalize(), c.maxBend);
      }
      if (c.restDir) {
        _hRef.copy(c.restDir).applyQuaternion(_Q);
        _hQ.setFromUnitVectors(_hRef, _dir);
        _Q.premultiply(_hQ);
      }
    }
    points[i + 1].copy(points[i]).addScaledVector(_dir, lengths[i]);
  }
  return points;
}

/**
 * FABRIK (Forward And Backward Reaching Inverse Kinematics).
 * points      — array of Vector3, mutated in place
 * lengths     — segment rest lengths, lengths[i] = |points[i+1] - points[i]|
 * target      — Vector3 goal for the end effector
 * opts        — { iterations, tolerance, constraints }
 * constraints — per-joint array (index j constrains the segment leaving joint j):
 *               { type:'ball', maxBend, restDir } | { type:'hinge', axis, range, restDir }
 *               axis/restDir are rest-pose world vectors; the forward pass
 *               carries them by serial-FK frame propagation.
 */
export function solveFABRIK(points, lengths, target, opts = {}) {
  const iterations = opts.iterations ?? 16;
  const tolerance = opts.tolerance ?? 0.002;
  const constraints = opts.constraints ?? null;
  const n = points.length;
  if (n < 2) return { iterations: 0, error: 0 };

  const root = points[0].clone();
  const totalLen = lengths.reduce((a, b) => a + b, 0);
  const hasActiveConstraint = constraints?.some(c =>
    c && (c.type === 'hinge' ? !!c.axis : c.maxBend < 179.9));

  // Target out of reach — stretch straight toward it (only valid unconstrained)
  if (!hasActiveConstraint && root.distanceTo(target) >= totalLen) {
    _dir.subVectors(target, root).normalize();
    for (let i = 1; i < n; i++) {
      points[i].copy(points[i - 1]).addScaledVector(_dir, lengths[i - 1]);
    }
    return { iterations: 1, error: points[n - 1].distanceTo(target) };
  }

  let err = Infinity;
  let iter = 0;
  for (iter = 0; iter < iterations; iter++) {
    // Backward pass: pin end effector to target, walk to root
    points[n - 1].copy(target);
    for (let i = n - 2; i >= 0; i--) {
      _dir.subVectors(points[i], points[i + 1]);
      if (_dir.lengthSq() < 1e-12) _dir.set(0, 1, 0); else _dir.normalize();
      points[i].copy(points[i + 1]).addScaledVector(_dir, lengths[i]);
    }
    // Forward pass: pin root, walk to end effector. Constraints are applied
    // with a cumulative frame Q so every joint's axis follows its parents.
    points[0].copy(root);
    _Q.identity();
    for (let i = 1; i < n; i++) {
      _dir.subVectors(points[i], points[i - 1]);
      if (_dir.lengthSq() < 1e-12) _dir.set(0, 1, 0); else _dir.normalize();
      const c = constraints ? constraints[i - 1] : null;
      if (c) {
        if (c.type === 'hinge' && c.axis) {
          applyHingeFK(_dir, c, _Q);
        } else {
          if (c.type === 'ball' && i >= 2) {
            const ref = _toEE.subVectors(points[i - 1], points[i - 2]).normalize();
            clampDirection(_dir, ref, c.maxBend);
          }
          // propagate the frame by the shortest arc from carried rest to actual
          if (c.restDir) {
            _hRef.copy(c.restDir).applyQuaternion(_Q);
            _hQ.setFromUnitVectors(_hRef, _dir);
            _Q.premultiply(_hQ);
          }
        }
      }
      points[i].copy(points[i - 1]).addScaledVector(_dir, lengths[i - 1]);
    }
    err = points[n - 1].distanceTo(target);
    if (err < tolerance) { iter++; break; }
  }
  return { iterations: iter, error: err };
}

/**
 * Serial-FK frame propagation up to (not including) joint `upTo`, measured
 * from current positions. Writes the cumulative rotation into Qout.
 */
function frameUpTo(points, constraints, upTo, Qout) {
  Qout.identity();
  for (let k = 0; k < upTo; k++) {
    const c = constraints[k];
    if (!c || !c.restDir) continue;
    _dir.subVectors(points[k + 1], points[k]);
    if (_dir.lengthSq() < 1e-12) continue;
    _dir.normalize();
    if (c.type === 'hinge' && c.axis) {
      _hAxis.copy(c.axis).applyQuaternion(Qout);
      _hRef.copy(c.restDir).applyQuaternion(Qout);
      _hRef.addScaledVector(_hAxis, -_hRef.dot(_hAxis));
      _hPrev.copy(_dir).addScaledVector(_hAxis, -_dir.dot(_hAxis));
      if (_hRef.lengthSq() > 1e-10 && _hPrev.lengthSq() > 1e-10) {
        _hRef.normalize();
        _hPrev.normalize();
        const th = Math.atan2(_hCross.crossVectors(_hRef, _hPrev).dot(_hAxis), _hRef.dot(_hPrev));
        _hQ.setFromAxisAngle(_hAxis, th);
        Qout.premultiply(_hQ);
      }
    } else {
      _hRef.copy(c.restDir).applyQuaternion(Qout);
      _hQ.setFromUnitVectors(_hRef, _dir);
      Qout.premultiply(_hQ);
    }
  }
  return Qout;
}

/**
 * Constrained CCD for serial revolute (hinge) chains. Each hinge rotates about
 * its FK-propagated world axis by the angle that best aligns the end effector
 * with the target, clamped to the joint's range. Ball joints fall back to the
 * classic CCD swing. This is the reliable solver for yaw+pitch robot legs,
 * where projection-based FABRIK stalls.
 */
export function solveCCDConstrained(points, lengths, target, opts = {}) {
  const iterations = opts.iterations ?? 16;
  const tolerance = opts.tolerance ?? 0.002;
  const constraints = opts.constraints ?? [];
  const n = points.length;
  if (n < 2) return { iterations: 0, error: 0 };

  let err = Infinity;
  let iter = 0;
  for (iter = 0; iter < iterations; iter++) {
    for (let i = n - 2; i >= 0; i--) {
      const c = constraints[i];
      const ee = points[n - 1];
      if (c && c.type === 'hinge' && c.axis) {
        frameUpTo(points, constraints, i, _Q);
        _hAxis.copy(c.axis).applyQuaternion(_Q).normalize();
        // current joint angle (for range clamping)
        _hRef.copy(c.restDir).applyQuaternion(_Q);
        _hRef.addScaledVector(_hAxis, -_hRef.dot(_hAxis));
        _dir.subVectors(points[i + 1], points[i]);
        _dir.addScaledVector(_hAxis, -_dir.dot(_hAxis));
        let thCur = 0;
        if (_hRef.lengthSq() > 1e-10 && _dir.lengthSq() > 1e-10) {
          _hRef.normalize(); _dir.normalize();
          thCur = Math.atan2(_hCross.crossVectors(_hRef, _dir).dot(_hAxis), _hRef.dot(_dir));
        }
        // best rotation about the axis to bring EE toward the target
        _toEE.subVectors(ee, points[i]);
        _toEE.addScaledVector(_hAxis, -_toEE.dot(_hAxis));
        _toT.subVectors(target, points[i]);
        _toT.addScaledVector(_hAxis, -_toT.dot(_hAxis));
        if (_toEE.lengthSq() < 1e-10 || _toT.lengthSq() < 1e-10) continue;
        _toEE.normalize(); _toT.normalize();
        let delta = Math.atan2(_hCross.crossVectors(_toEE, _toT).dot(_hAxis), _toEE.dot(_toT));
        if (c.range < 359.9) {
          const half = THREE.MathUtils.degToRad(c.range / 2);
          delta = THREE.MathUtils.clamp(thCur + delta, -half, half) - thCur;
        }
        if (Math.abs(delta) < 1e-7) continue;
        _hQ.setFromAxisAngle(_hAxis, delta);
        for (let j = i + 1; j < n; j++) {
          points[j].sub(points[i]).applyQuaternion(_hQ).add(points[i]);
        }
      } else {
        _toEE.subVectors(ee, points[i]);
        _toT.subVectors(target, points[i]);
        if (_toEE.lengthSq() < 1e-12 || _toT.lengthSq() < 1e-12) continue;
        _q.setFromUnitVectors(_toEE.normalize(), _toT.normalize());
        for (let j = i + 1; j < n; j++) {
          points[j].sub(points[i]).applyQuaternion(_q).add(points[i]);
        }
        if (c && c.type === 'ball' && c.maxBend < 179.9 && i >= 1) {
          // re-clamp the outgoing segment against the previous one
          _dir.subVectors(points[i + 1], points[i]).normalize();
          const ref = _hPrev.subVectors(points[i], points[i - 1]).normalize();
          const before = _dir.clone();
          clampDirection(_dir, ref, c.maxBend);
          if (before.angleTo(_dir) > 1e-7) {
            _hQ.setFromUnitVectors(before, _dir);
            for (let j = i + 1; j < n; j++) {
              points[j].sub(points[i]).applyQuaternion(_hQ).add(points[i]);
            }
          }
        }
      }
    }
    err = points[n - 1].distanceTo(target);
    if (err < tolerance) { iter++; break; }
  }
  return { iterations: iter, error: err };
}

/**
 * CCD in JOINT SPACE for a pure hinge chain (the octobot's yaw → pitch → pitch
 * leg). The state is the servo angle array, not the joint positions: every
 * iteration clamps each angle to its sweep and rebuilds the whole chain by
 * forward kinematics from the rest pose.
 *
 * That inversion is the point. Position-space CCD nudges points around and
 * hopes they stay on their hinge planes — they drift off, and clamping a drifted
 * pose afterwards throws away real accuracy. Here an illegal pose is simply not
 * representable, so the solver converges *inside* the mechanism's workspace and
 * the residual error is the honest "this is as close as the servos get".
 */
export function solveHingeChain(points, lengths, target, opts = {}) {
  const cons = opts.constraints;
  const iterations = opts.iterations ?? 16;
  const tolerance = opts.tolerance ?? 0.002;
  const n = points.length;
  const m = n - 1;
  if (m < 1 || !cons) return { iterations: 0, error: 0 };

  const half = [], axes = [], frames = [];
  for (let i = 0; i < m; i++) {
    const c = cons[i];
    half.push(c.range < 359.9 ? THREE.MathUtils.degToRad(c.range / 2) : Math.PI);
    axes.push(new THREE.Vector3());
    frames.push(new THREE.Quaternion());
  }

  // seed from the pose on screen so dragging the target feels continuous
  const th = [];
  {
    const Q = new THREE.Quaternion();
    for (let i = 0; i < m; i++) {
      const c = cons[i];
      _hAxis.copy(c.axis).applyQuaternion(Q).normalize();
      _hRef.copy(c.restDir).applyQuaternion(Q);
      _hRef.addScaledVector(_hAxis, -_hRef.dot(_hAxis));
      _dir.subVectors(points[i + 1], points[i]);
      _dir.addScaledVector(_hAxis, -_dir.dot(_hAxis));
      let t = 0;
      if (_hRef.lengthSq() > 1e-10 && _dir.lengthSq() > 1e-10) {
        _hRef.normalize(); _dir.normalize();
        t = Math.atan2(_hCross.crossVectors(_hRef, _dir).dot(_hAxis), _hRef.dot(_dir));
      }
      th.push(THREE.MathUtils.clamp(t, -half[i], half[i]));
      _hQ.setFromAxisAngle(_hAxis, th[i]);
      Q.premultiply(_hQ);
    }
  }

  const fk = () => {
    _Q.identity();
    for (let i = 0; i < m; i++) {
      const c = cons[i];
      axes[i].copy(c.axis).applyQuaternion(_Q).normalize();
      // rotate the FULL carried rest direction about the axis — projecting it
      // onto the hinge plane first would flatten the bone and break the rest pose
      _hRef.copy(c.restDir).applyQuaternion(_Q).applyAxisAngle(axes[i], th[i]).normalize();
      points[i + 1].copy(points[i]).addScaledVector(_hRef, lengths[i]);
      _hQ.setFromAxisAngle(axes[i], th[i]);
      _Q.premultiply(_hQ);
      frames[i].copy(_Q);
    }
  };

  fk();
  let err = points[n - 1].distanceTo(target);
  let iter = 0;
  for (iter = 0; iter < iterations && err > tolerance; iter++) {
    for (let i = m - 1; i >= 0; i--) {
      _toEE.subVectors(points[n - 1], points[i]);
      _toEE.addScaledVector(axes[i], -_toEE.dot(axes[i]));
      _toT.subVectors(target, points[i]);
      _toT.addScaledVector(axes[i], -_toT.dot(axes[i]));
      if (_toEE.lengthSq() < 1e-10 || _toT.lengthSq() < 1e-10) continue;
      _toEE.normalize(); _toT.normalize();
      const delta = Math.atan2(_hCross.crossVectors(_toEE, _toT).dot(axes[i]), _toEE.dot(_toT));
      const next = THREE.MathUtils.clamp(th[i] + delta, -half[i], half[i]);
      if (Math.abs(next - th[i]) < 1e-9) continue;
      th[i] = next;
      fk();
    }
    err = points[n - 1].distanceTo(target);
  }
  return { iterations: iter, error: err };
}

/**
 * CCD (Cyclic Coordinate Descent). Rotates sub-chains about each joint to
 * align the end effector with the target. Root stays fixed; lengths preserved.
 */
export function solveCCD(points, lengths, target, opts = {}) {
  const iterations = opts.iterations ?? 16;
  const tolerance = opts.tolerance ?? 0.002;
  const n = points.length;
  if (n < 2) return { iterations: 0, error: 0 };

  let err = Infinity;
  let iter = 0;
  for (iter = 0; iter < iterations; iter++) {
    for (let i = n - 2; i >= 0; i--) {
      _toEE.subVectors(points[n - 1], points[i]);
      _toT.subVectors(target, points[i]);
      if (_toEE.lengthSq() < 1e-12 || _toT.lengthSq() < 1e-12) continue;
      _q.setFromUnitVectors(_toEE.normalize(), _toT.normalize());
      for (let j = i + 1; j < n; j++) {
        points[j].sub(points[i]).applyQuaternion(_q).add(points[i]);
      }
    }
    err = points[n - 1].distanceTo(target);
    if (err < tolerance) { iter++; break; }
  }
  return { iterations: iter, error: err };
}

/** Interior bend angle at joint i (degrees): 0 = straight, positive = bent. */
export function bendAngleAt(points, i) {
  if (i <= 0 || i >= points.length - 1) return 0;
  const a = _toEE.subVectors(points[i], points[i - 1]).normalize();
  const b = _toT.subVectors(points[i + 1], points[i]).normalize();
  return THREE.MathUtils.radToDeg(a.angleTo(b));
}
