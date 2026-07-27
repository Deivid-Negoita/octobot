// chain.js — KinematicChain: joints, bone visuals, target marker, solving
import * as THREE from 'three';
import { solveFABRIK, solveCCD, solveHingeChain, enforceJointLimits } from './solver.js';
import { checkCollisions, bonesFromFlags } from './collision.js';

let chainCounter = 0;

const JOINT_RADIUS = 0.09;
const jointGeo = new THREE.SphereGeometry(JOINT_RADIUS, 20, 16);
const rootGeo = new THREE.SphereGeometry(JOINT_RADIUS * 1.35, 20, 16);
// Blender-ish bone: tapered 4-sided pyramid, unit length along +Y, base at origin
const boneGeo = new THREE.CylinderGeometry(0.02, 0.075, 1, 4, 1);
boneGeo.translate(0, 0.5, 0);
boneGeo.rotateY(Math.PI / 4);

const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();

export const HINGE_AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/** Effective hinge axis of a joint: custom vector (auto-rig) or preset. */
function axisOf(j) {
  return j.axisVec ?? HINGE_AXES[j.hingeAxis] ?? HINGE_AXES.y;
}

function makeTargetMarker(color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color });
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.09), mat);
  g.add(core);
  const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
  const s = 0.3;
  const pts = [
    new THREE.Vector3(-s, 0, 0), new THREE.Vector3(s, 0, 0),
    new THREE.Vector3(0, -s, 0), new THREE.Vector3(0, s, 0),
    new THREE.Vector3(0, 0, -s), new THREE.Vector3(0, 0, s),
  ];
  const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
  g.add(new THREE.LineSegments(lineGeo, lineMat));
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.19, 0.008, 8, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 })
  );
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  return g;
}

export class Chain {
  constructor(scene, color) {
    this.id = ++chainCounter;
    this.name = 'CHAIN-' + String(this.id).padStart(2, '0');
    this.color = color;
    this.scene = scene;
    this.visible = true;

    // { pos, mesh, type:'ball'|'hinge', maxBend, hingeAxis:'x'|'y'|'z', hingeRange, hingePreset }
    this.joints = [];
    this.lengths = [];  // rest lengths between consecutive joints
    this.restDirs = []; // segment directions at the rest (build) pose — hinge reference frame
    this.boneMeshes = [];
    this.selectedIndex = -1;

    this.solver = 'fabrik';
    this.iterations = 16;
    this.tolerance = 0.002;
    this.visualScale = 1; // shrinks joint spheres / bone thickness / target marker

    this.target = new THREE.Vector3();
    this.targetDirty = false;
    this.lastStats = { iterations: 0, error: 0, ms: 0 };

    // collision guard state
    this.status = 'ok';        // 'ok' | 'reach' | 'collision'
    this.collision = null;     // { bones: Set<int>, reasons: Set<string> } when blocked
    this.safeFlags = null;     // contact flags of the last accepted pose (baseline)
    this.lastSafePose = null;  // Vector3[] of the last accepted pose

    this.group = new THREE.Group();
    scene.add(this.group);

    this.targetGroup = makeTargetMarker(0x53d5e6);
    this.targetGroup.visible = false;
    scene.add(this.targetGroup);
    this._targetMats = [];
    this.targetGroup.traverse(o => { if (o.material) this._targetMats.push(o.material); });

    this.jointMat = new THREE.MeshStandardMaterial({
      color, roughness: 0.35, metalness: 0.3,
      emissive: color, emissiveIntensity: 0.25,
    });
    this.boneMat = new THREE.MeshStandardMaterial({
      color, roughness: 0.5, metalness: 0.25,
      emissive: color, emissiveIntensity: 0.12,
      transparent: true, opacity: 0.92,
    });
    this.selMat = this.jointMat.clone();
    this.selMat.emissiveIntensity = 0.9;
    this.boneErrMat = new THREE.MeshStandardMaterial({
      color: 0xe5484d, roughness: 0.5, metalness: 0.25,
      emissive: 0xe5484d, emissiveIntensity: 0.55,
      transparent: true, opacity: 0.95,
    });

    // hinge axis indicator (shown on the selected joint when it's a hinge)
    this.axisIndicator = new THREE.Group();
    const axMat = new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9 });
    const axGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, -0.55), new THREE.Vector3(0, 0, 0.55),
    ]);
    this.axisIndicator.add(new THREE.Line(axGeo, axMat));
    this.axisIndicator.add(new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.007, 6, 40), // sweep plane (normal = axis)
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.5 })
    ));
    this.axisIndicator.visible = false;
    this.group.add(this.axisIndicator);
  }

  get points() { return this.joints.map(j => j.pos); }
  get endEffector() { return this.joints.length ? this.joints[this.joints.length - 1].pos : null; }
  get totalLength() { return this.lengths.reduce((a, b) => a + b, 0); }

  /** Scale down the rig visuals so a detailed mesh stays readable. */
  setVisualScale(s) {
    this.visualScale = s;
    for (const j of this.joints) j.mesh.scale.setScalar(s);
    this.targetGroup.scale.setScalar(Math.max(s, 0.5));
    this.updateVisuals();
  }

  addJoint(pos) {
    const mesh = new THREE.Mesh(this.joints.length === 0 ? rootGeo : jointGeo, this.jointMat);
    mesh.scale.setScalar(this.visualScale);
    mesh.position.copy(pos);
    mesh.userData = { kind: 'joint', chain: this, index: this.joints.length };
    this.group.add(mesh);
    this.joints.push({
      pos: pos.clone(), mesh,
      type: 'ball', maxBend: 180,
      hingeAxis: 'y', hingeRange: 180, hingePreset: 'h180',
    });
    this.recomputeLengths();
    this.rebuildBones();
    this.snapTargetToEE();
    return this.joints.length - 1;
  }

  removeJoint(index) {
    if (index < 0 || index >= this.joints.length) return;
    const j = this.joints[index];
    this.group.remove(j.mesh);
    this.joints.splice(index, 1);
    this.joints.forEach((jt, i) => { jt.mesh.userData.index = i; });
    this.recomputeLengths();
    this.rebuildBones();
    this.snapTargetToEE();
  }

  setJointPos(index, pos) {
    const j = this.joints[index];
    if (!j) return;
    j.pos.copy(pos);
    j.mesh.position.copy(pos);
    this.recomputeLengths();
    this.updateVisuals();
  }

  recomputeLengths() {
    this.lengths = [];
    this.restDirs = [];
    for (let i = 0; i < this.joints.length - 1; i++) {
      this.lengths.push(Math.max(1e-4, this.joints[i].pos.distanceTo(this.joints[i + 1].pos)));
      this.restDirs.push(new THREE.Vector3()
        .subVectors(this.joints[i + 1].pos, this.joints[i].pos).normalize());
    }
    this.resetSafety();
  }

  /** Per-joint solver constraints; index j constrains the segment leaving joint j. */
  _buildConstraints() {
    const cons = [];
    for (let i = 0; i < this.joints.length - 1; i++) {
      const j = this.joints[i];
      if (j.type === 'hinge') {
        cons.push({
          type: 'hinge',
          axis: axisOf(j),
          range: j.hingeRange,
          restDir: this.restDirs[i],
        });
      } else {
        cons.push({ type: 'ball', maxBend: j.maxBend, restDir: this.restDirs[i] });
      }
    }
    return cons;
  }

  /**
   * Cumulative bone frames measured from the current pose via serial-FK
   * propagation (matching the solver). Returns { quats, thetas }:
   * quats[i] rotates rest-world into the frame of bone i; thetas[i] is the
   * signed joint rotation in radians (hinge sweep, or 0-ish for ball twist).
   */
  boneFrames() {
    const quats = [], thetas = [];
    const Q = new THREE.Quaternion();
    const dir = new THREE.Vector3(), axis = new THREE.Vector3();
    const ref = new THREE.Vector3(), proj = new THREE.Vector3(), cross = new THREE.Vector3();
    const dq = new THREE.Quaternion();
    for (let i = 0; i < this.joints.length - 1; i++) {
      const j = this.joints[i];
      dir.subVectors(this.joints[i + 1].pos, this.joints[i].pos);
      if (dir.lengthSq() < 1e-12) { quats.push(Q.clone()); thetas.push(0); continue; }
      dir.normalize();
      let theta = 0;
      if (j.type === 'hinge') {
        axis.copy(axisOf(j)).applyQuaternion(Q);
        ref.copy(this.restDirs[i]).applyQuaternion(Q);
        ref.addScaledVector(axis, -ref.dot(axis));
        proj.copy(dir).addScaledVector(axis, -dir.dot(axis));
        if (ref.lengthSq() > 1e-10 && proj.lengthSq() > 1e-10) {
          ref.normalize();
          proj.normalize();
          theta = Math.atan2(cross.crossVectors(ref, proj).dot(axis), ref.dot(proj));
          dq.setFromAxisAngle(axis, theta);
          Q.premultiply(dq);
        }
      } else {
        ref.copy(this.restDirs[i]).applyQuaternion(Q);
        dq.setFromUnitVectors(ref, dir);
        Q.premultiply(dq);
      }
      quats.push(Q.clone());
      thetas.push(theta);
    }
    return { quats, thetas };
  }

  /** Current world direction of a joint's hinge axis (rest axis carried by parent joints). */
  _currentHingeAxis(index, out) {
    out.copy(axisOf(this.joints[index]));
    if (index > 0) {
      const { quats } = this.boneFrames();
      if (quats[index - 1]) out.applyQuaternion(quats[index - 1]);
    }
    return out;
  }

  /**
   * Signed rotation of a hinge joint's outgoing bone around its axis,
   * measured from the rest (build) pose — i.e. the servo angle, in degrees.
   */
  signedHingeAngle(index) {
    const j = this.joints[index];
    if (!j || index >= this.joints.length - 1 || j.type !== 'hinge') return 0;
    const { thetas } = this.boneFrames();
    return THREE.MathUtils.radToDeg(thetas[index] ?? 0);
  }

  _updateAxisIndicator() {
    const i = this.selectedIndex;
    const show = i >= 0 && i < this.joints.length - 1 && this.joints[i]?.type === 'hinge';
    this.axisIndicator.visible = show;
    if (!show) return;
    this._currentHingeAxis(i, _v2);
    this.axisIndicator.position.copy(this.joints[i].pos);
    this.axisIndicator.quaternion.setFromUnitVectors(_zAxis, _v2);
  }

  /** Forget the collision baseline — the next solved pose is accepted as-is. */
  resetSafety() {
    this.safeFlags = null;
    this.lastSafePose = null;
    this.collision = null;
    if (this.status === 'collision') this.status = 'ok';
    this.setTargetBlocked(false);
  }

  setTargetBlocked(blocked) {
    const col = blocked ? 0xe5484d : 0x53d5e6;
    for (const m of this._targetMats) m.color.setHex(col);
  }

  rebuildBones() {
    for (const b of this.boneMeshes) this.group.remove(b);
    this.boneMeshes = [];
    for (let i = 0; i < this.joints.length - 1; i++) {
      const m = new THREE.Mesh(boneGeo, this.boneMat);
      m.userData = { kind: 'bone', chain: this, index: i };
      this.group.add(m);
      this.boneMeshes.push(m);
    }
    this.updateVisuals();
  }

  updateVisuals() {
    for (const j of this.joints) j.mesh.position.copy(j.pos);
    const badBones = this.status === 'collision' ? this.collision?.bones : null;
    for (let i = 0; i < this.boneMeshes.length; i++) {
      const a = this.joints[i].pos, b = this.joints[i + 1].pos;
      const m = this.boneMeshes[i];
      m.material = badBones && badBones.has(i) ? this.boneErrMat : this.boneMat;
      _dir.subVectors(b, a);
      const len = _dir.length();
      m.position.copy(a);
      m.scale.set(this.visualScale, Math.max(len, 1e-4), this.visualScale);
      if (len > 1e-6) {
        _q.setFromUnitVectors(_up, _dir.normalize());
        m.quaternion.copy(_q);
      }
    }
    this._updateAxisIndicator();
  }

  snapTargetToEE() {
    if (this.joints.length >= 2) {
      this.target.copy(this.endEffector);
      this.targetGroup.position.copy(this.target);
      this.targetGroup.visible = this.visible;
      // request a solve so telemetry/status are populated without waiting for
      // the user to nudge the target
      this.targetDirty = true;
    } else {
      this.targetGroup.visible = false;
    }
  }

  /**
   * Solve toward this.target. ctx = { models, opts: {models,self,floor} } enables
   * the collision guard: a pose introducing NEW contacts (vs the last accepted
   * pose) is rejected and the chain freezes at its last safe pose.
   */
  solve(ctx) {
    if (this.joints.length < 2) return;
    const pts = this.points;
    const t0 = performance.now();
    const opts = { iterations: this.iterations, tolerance: this.tolerance };
    // Constraints are always built, whatever the ALGORITHM setting says. They
    // describe the mechanism, not the search: picking CCD chooses an
    // unconstrained *search*, but the pose it lands on is still a pose the
    // servos have to be able to hold.
    opts.constraints = this._buildConstraints();
    // An all-hinge chain is a servo mechanism (every octobot leg is), so it goes
    // through the joint-space solver — projection-based FABRIK stalls on
    // yaw→pitch serial joints, and position-space CCD drifts off the hinge planes.
    const allHinge = opts.constraints.length > 0 && opts.constraints.every(c => c?.type === 'hinge' && c.axis);
    const hasHinge = opts.constraints.some(c => c?.type === 'hinge');
    // Every pose the chain is allowed to keep is projected onto the joints'
    // actual configuration space first. Without this the restart seeds below
    // (which lay the chain out ignoring the joints) and any solver drift out of
    // a hinge plane could be accepted as-is, giving articulations the real
    // servos cannot physically produce.
    const legalize = () => {
      if (opts.constraints) enforceJointLimits(pts, this.lengths, opts.constraints);
      return pts[pts.length - 1].distanceTo(this.target);
    };
    const run = () => {
      // the joint-space solver is already legal by construction — legalize() is
      // a no-op on its output and only earns its keep on the other two paths
      if (allHinge) return solveHingeChain(pts, this.lengths, this.target, opts);
      const r = this.solver === 'ccd'
        ? solveCCD(pts, this.lengths, this.target, opts)
        : solveFABRIK(pts, this.lengths, this.target, opts);
      return { iterations: r.iterations, error: legalize() };
    };

    let res = run();

    // Best-effort restarts: a distance-reachable target the first solve missed
    // (local minimum) gets two more attempts from canonical poses; keep the best.
    const root = this.joints[0].pos;
    const reachable = root.distanceTo(this.target) <= this.totalLength + 1e-6;
    if (reachable && res.error > this.tolerance) {
      let best = { error: res.error, iterations: res.iterations, pose: pts.map(p => p.clone()) };
      const attempt = init => {
        init();
        legalize(); // the seed itself has to be a pose the mechanism can hold
        const r = run();
        if (r.error < best.error) {
          best = { error: r.error, iterations: r.iterations, pose: pts.map(p => p.clone()) };
        }
      };
      // 1. from the rest (build) pose
      attempt(() => {
        for (let i = 1; i < pts.length; i++) {
          pts[i].copy(pts[i - 1]).addScaledVector(this.restDirs[i - 1], this.lengths[i - 1]);
        }
      });
      // 2. from a straight line aimed at the target
      if (best.error > this.tolerance) {
        attempt(() => {
          _dir.subVectors(this.target, root);
          if (_dir.lengthSq() < 1e-10) _dir.copy(this.restDirs[0]); else _dir.normalize();
          for (let i = 1; i < pts.length; i++) {
            pts[i].copy(pts[i - 1]).addScaledVector(_dir, this.lengths[i - 1]);
          }
        });
      }
      pts.forEach((p, i) => p.copy(best.pose[i]));
      res = best;
    }

    // A hinge chain's reach is limited by its sweeps, not by its total length:
    // a target inside the length envelope can still be unreachable, and the
    // solver settling short of it is the joints hitting their stops.
    let status = 'ok';
    if (this.joints[0].pos.distanceTo(this.target) > this.totalLength + 1e-6) status = 'reach';
    else if (hasHinge && res.error > Math.max(this.tolerance * 20, 0.01)) status = 'reach';

    const guard = ctx && (ctx.opts.models || ctx.opts.self || ctx.opts.floor);
    if (guard) {
      const { flags, labels } = checkCollisions(this, ctx.models, ctx.opts, ctx);
      if (this.safeFlags === null) {
        // first pose after a rig edit — accept as baseline (existing contacts are intentional)
        this.safeFlags = flags;
        this.lastSafePose = pts.map(p => p.clone());
        this.collision = null;
      } else {
        const offending = [...flags].filter(f => !this.safeFlags.has(f));
        if (offending.length) {
          status = 'collision';
          this.collision = {
            bones: bonesFromFlags(offending),
            reasons: new Set(offending.map(f => labels.get(f))),
          };
          if (this.lastSafePose && this.lastSafePose.length === this.joints.length) {
            this.joints.forEach((j, i) => j.pos.copy(this.lastSafePose[i]));
          }
        } else {
          this.safeFlags = flags;
          this.lastSafePose = pts.map(p => p.clone());
          this.collision = null;
        }
      }
    } else {
      this.collision = null;
    }

    this.status = status;
    this.setTargetBlocked(status === 'collision');
    this.lastStats = {
      iterations: res.iterations,
      error: this.endEffector.distanceTo(this.target),
      ms: performance.now() - t0,
    };
    this.updateVisuals();
  }

  setSelectedJoint(index) {
    this.selectedIndex = index;
    this.joints.forEach((j, i) => { j.mesh.material = i === index ? this.selMat : this.jointMat; });
    this._updateAxisIndicator();
  }

  setVisible(v) {
    this.visible = v;
    this.group.visible = v;
    this.targetGroup.visible = v && this.joints.length >= 2;
  }

  dispose() {
    this.scene.remove(this.group);
    this.scene.remove(this.targetGroup);
    this.jointMat.dispose();
    this.boneMat.dispose();
    this.selMat.dispose();
    this.boneErrMat.dispose();
  }

  toJSON() {
    return {
      name: this.name,
      color: this.color,
      solver: this.solver,
      iterations: this.iterations,
      tolerance: this.tolerance,
      joints: this.joints.map(j => ({
        p: j.pos.toArray(),
        type: j.type, maxBend: j.maxBend,
        hingeAxis: j.hingeAxis, hingeRange: j.hingeRange, hingePreset: j.hingePreset,
        ...(j.axisVec ? { axisVec: j.axisVec.toArray() } : {}),
      })),
      target: this.target.toArray(),
    };
  }

  static fromJSON(scene, data) {
    const c = new Chain(scene, data.color ?? 0xf2a33c);
    c.name = data.name ?? c.name;
    c.solver = data.solver ?? 'fabrik';
    c.iterations = data.iterations ?? 16;
    c.tolerance = data.tolerance ?? 0.002;
    for (const j of data.joints ?? []) {
      const idx = c.addJoint(new THREE.Vector3().fromArray(j.p));
      const joint = c.joints[idx];
      joint.maxBend = j.maxBend ?? 180;
      joint.type = j.type === 'hinge' ? 'hinge' : 'ball';
      joint.hingeAxis = ['x', 'y', 'z'].includes(j.hingeAxis) ? j.hingeAxis : 'y';
      joint.hingeRange = j.hingeRange ?? 180;
      joint.hingePreset = j.hingePreset ?? 'h180';
      if (Array.isArray(j.axisVec)) {
        joint.axisVec = new THREE.Vector3().fromArray(j.axisVec).normalize();
      }
    }
    if (data.target && c.joints.length >= 2) {
      c.target.fromArray(data.target);
      c.targetGroup.position.copy(c.target);
      c.targetDirty = true;
    }
    return c;
  }
}
