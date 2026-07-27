// gait.js — multi-leg walking: coordinated foot targets + body translation
//
// Each leg cycles through stance (foot pinned to the ground while the body
// passes over it) and swing (foot lifts and reaches forward). With the body
// advancing at v = stride / (duty * cycleTime), stance feet are stationary
// in world space — i.e. actual walking, not moonwalking.
import * as THREE from 'three';

const _v = new THREE.Vector3();

export const GAITS = {
  tetrapod: { label: 'TETRAPOD (2×4)', duty: 0.5 },
  wave:     { label: 'WAVE (ripple)',  duty: 0.75 },
};

export class GaitEngine {
  constructor() {
    this.active = false;
    this.gait = 'tetrapod';
    this.cycleTime = 2.0;   // seconds per full cycle
    this.stride = 0.45;     // step length (world units)
    this.lift = 0.2;        // swing arc height
    this.dir = new THREE.Vector3(0, 0, -1); // walk direction (−Z = the octopod's front)
    this.t = 0;
    this.travel = 0;
    this.legs = [];         // { chain, home, root0, phase }
    this.model = null;      // body model that translates with the walk
    this._modelBase = null;
    this._snapshot = null;
  }

  /** Begin walking. chains: legs (root = hip, EE = foot). model: optional body mesh. */
  start(chains, model) {
    let legs = chains.filter(c => c.joints.length >= 2 && c.visible);
    if (legs.length < 2) return false;
    // all legs must share a joint count — mixed-length chains break the gait math
    const n = legs[0].joints.length;
    legs = legs.filter(c => c.joints.length === n);
    if (legs.length < 2) return false;

    // snapshot full state for stop()
    this._snapshot = {
      chains: legs.map(c => ({
        chain: c,
        joints: c.joints.map(j => j.pos.clone()),
        target: c.target.clone(),
      })),
      modelPos: model ? model.group.position.clone() : null,
    };

    // body center = average hip position (for phase assignment around the ring)
    const center = new THREE.Vector3();
    for (const c of legs) center.add(c.joints[0].pos);
    center.divideScalar(legs.length);

    // sort legs by angle around the body so phase patterns alternate cleanly
    const sorted = legs.map(c => ({
      chain: c,
      angle: Math.atan2(c.joints[0].pos.z - center.z, c.joints[0].pos.x - center.x),
    })).sort((a, b) => a.angle - b.angle);

    this.legs = sorted.map((s, i) => {
      // tuck the foot's home slightly toward the hip so stride extremes stay
      // inside the leg's reachable envelope (rest pose = max natural extension)
      const root = s.chain.joints[0].pos;
      const home = s.chain.endEffector.clone();
      home.x += (root.x - home.x) * 0.1;
      home.z += (root.z - home.z) * 0.1;
      return {
        chain: s.chain,
        home,
        root0: root.clone(),
        phase: this.gait === 'wave' ? i / sorted.length : (i % 2) * 0.5,
      };
    });

    this.model = model ?? null;
    this._modelBase = model ? model.group.position.clone() : null;
    this.t = 0;
    this.travel = 0;
    this.active = true;
    return true;
  }

  stop() {
    // how far the restore is about to move the body (lets the camera compensate)
    const restoreDelta = new THREE.Vector3();
    if (this._snapshot?.modelPos && this.model) {
      restoreDelta.subVectors(this._snapshot.modelPos, this.model.group.position);
    }
    if (this._snapshot) {
      for (const s of this._snapshot.chains) {
        s.chain.joints.forEach((j, i) => j.pos.copy(s.joints[i]));
        s.chain.target.copy(s.target);
        s.chain.targetGroup.position.copy(s.target);
        s.chain.recomputeLengths(); // also resets the collision baseline
        s.chain.updateVisuals();
      }
      if (this.model && this._snapshot.modelPos) {
        this.model.group.position.copy(this._snapshot.modelPos);
      }
    }
    const wasActive = this.active;
    this.active = false;
    this.legs = [];
    this.model = null;
    this._snapshot = null;
    if (wasActive) this.onStop?.(restoreDelta);
  }

  update(dt) {
    if (!this.active) return;
    const duty = GAITS[this.gait]?.duty ?? 0.5;
    const T = this.cycleTime;
    const v = this.stride / (duty * T); // body speed that pins stance feet
    const step = v * dt;

    this.t += dt;
    this.travel += step;

    // wrap so the walk stays on the grid: teleport everything back
    if (this.travel > 8) {
      this.travel -= 16;
      _v.copy(this.dir).multiplyScalar(-16);
      for (const leg of this.legs) {
        for (const j of leg.chain.joints) j.pos.add(_v);
      }
      if (this.model) this.model.group.position.add(_v);
    }

    for (const leg of this.legs) {
      const c = leg.chain;
      // carry the whole leg with the body, then pin the root exactly
      _v.copy(this.dir).multiplyScalar(step);
      for (const j of c.joints) j.pos.add(_v);
      c.joints[0].pos.copy(leg.root0).addScaledVector(this.dir, this.travel);

      // foot target from the gait cycle
      const phi = ((this.t / T) + leg.phase) % 1;
      let xRel, yRel;
      if (phi < duty) {
        const s = phi / duty;                 // stance: sweep back under the body
        xRel = this.stride * (0.5 - s);
        yRel = 0;
      } else {
        const s = (phi - duty) / (1 - duty);  // swing: arc forward
        xRel = this.stride * (s - 0.5);
        yRel = this.lift * Math.sin(Math.PI * s);
      }
      c.target.copy(leg.home)
        .addScaledVector(this.dir, this.travel + xRel)
        .add(_v.set(0, yRel, 0));
      c.targetGroup.position.copy(c.target);
      c.solve(); // no collision ctx: the gait drives feet to the floor by design
    }

    if (this.model && this._modelBase) {
      this.model.group.position.copy(this._modelBase).addScaledVector(this.dir, this.travel);
    }
  }
}
