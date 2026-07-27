// binding.js — rigid-binds a model's assembly occurrences to rig bones.
//
// Each top-level occurrence (a CAD sub-assembly: a leg link, a servo, a
// bracket) is assigned by centroid either to the nearest bone segment or to
// the body. Bound occurrences are reparented into per-bone groups that follow
// the solved bones every frame, so the actual robot parts articulate.
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _b = new THREE.Vector3();
const _ab = new THREE.Vector3();

function segDistance(p, a, b, tMin, tMax) {
  _ab.subVectors(b, a);
  const len2 = _ab.lengthSq();
  let t = len2 > 1e-12 ? _v.subVectors(p, a).dot(_ab) / len2 : 0;
  t = THREE.MathUtils.clamp(t, tMin, tMax);
  return _v.copy(a).addScaledVector(_ab, t).distanceTo(p);
}

export class RigBinding {
  constructor() {
    this.links = [];    // { chain, index, group, restPos, restDir }
    this.model = null;
    this.scene = null;
    this._restore = []; // { obj, parent } original parentage
  }

  get active() { return this.links.length > 0; }

  /**
   * Bind model occurrences to the chains' bones.
   * assigner: optional (name, centroid, legIdx, chain, bearingErr, gate) →
   *   'body' | boneIndex | null — model-specific placement (null = geometric).
   * Returns { legs, body } counts, or null if nothing could be bound.
   */
  bind(model, chains, scene, assigner = null, extraNodes = []) {
    this.clear();
    if (!model || !chains.length) return null;
    model.group.updateMatrixWorld(true);

    // assembly root = deepest single-child descent from the rotation node
    let rootNode = model._rot;
    while (rootNode.children.length === 1) rootNode = rootNode.children[0];
    // extraNodes are sub-meshes (e.g. a servo horn nested inside its servo)
    // that must bind to a different bone than their parent occurrence; they
    // come last so the parent is reparented before the child is pulled out.
    const occurrences = [...rootNode.children, ...extraNodes];
    if (occurrences.length < 2) return null;

    const bones = [];
    const boneByChainIdx = new Map();
    chains.forEach((c, ci) => {
      for (let i = 0; i < c.joints.length - 1; i++) {
        const bn = { chain: c, index: i, a: c.joints[i].pos, b: c.joints[i + 1].pos };
        bones.push(bn);
        boneByChainIdx.set(ci + ':' + i, bn);
      }
    });
    if (!bones.length) return null;

    // per-leg reference: bearing from the FOOT (far radius — insensitive to the
    // hip servo's lateral mounting offset), radius from the hip. The hip "ring"
    // is usually not circular, so each occurrence is tested against ITS OWN
    // nearest leg, not a ring average.
    const center = new THREE.Vector3();
    for (const c of chains) center.add(c.joints[0].pos);
    center.divideScalar(chains.length);
    const hips = chains.map(c => {
      const hp = c.joints[0].pos;
      const ee = c.joints[c.joints.length - 1].pos;
      return {
        r: Math.hypot(hp.x - center.x, hp.z - center.z),
        ang: Math.atan2(ee.z - center.z, ee.x - center.x),
      };
    });
    const angDiff = (a, b) => Math.abs(THREE.MathUtils.euclideanModulo(a - b + Math.PI, Math.PI * 2) - Math.PI);
    // gate at just under half the angular spacing between legs
    const bearingGate = Math.min(0.33, (Math.PI / Math.max(chains.length, 2)) * 0.9);

    const linkForBone = new Map();
    const box = new THREE.Box3();
    const counts = { legs: 0, body: 0 };

    for (const node of occurrences) {
      box.setFromObject(node);
      if (box.isEmpty()) { counts.body++; continue; }
      const centroid = box.getCenter(new THREE.Vector3());
      const cRad = Math.hypot(centroid.x - center.x, centroid.z - center.z);
      const cAng = Math.atan2(centroid.z - center.z, centroid.x - center.x);
      let hip = hips[0], hipIdx = 0, bestA = Infinity;
      hips.forEach((h, hi) => {
        const d = angDiff(h.ang, cAng);
        if (d < bestA) { bestA = d; hip = h; hipIdx = hi; }
      });

      let best = null, bestD = Infinity;
      // model-specific assignment first (exact CAD knowledge)
      const assigned = assigner
        ? assigner(node.name ?? '', centroid, hipIdx, chains[hipIdx], bestA, bearingGate, node)
        : null;
      if (assigned === 'body') {
        // explicitly chassis-fixed
      } else if (assigned && typeof assigned === 'object' && assigned.chain) {
        // exact chain + bone (rig-time knowledge — immune to bearing ambiguity)
        const ci = chains.indexOf(assigned.chain);
        if (ci >= 0) {
          const boneIdx = Math.min(assigned.bone, chains[ci].joints.length - 2);
          best = boneByChainIdx.get(ci + ':' + boneIdx) ?? null;
          bestD = 0;
        }
      } else if (typeof assigned === 'number') {
        const boneIdx = Math.min(assigned, chains[hipIdx].joints.length - 2);
        best = boneByChainIdx.get(hipIdx + ':' + boneIdx) ?? null;
        bestD = 0;
      } else {
        // leg zone = radially outward of that hip AND roughly on the leg's bearing
        // (parts between legs — cameras, edge sensors — belong to the body)
        const isLegZone = cRad > hip.r * 0.8 && bestA < bearingGate;
        if (isLegZone) {
          for (const bn of bones) {
            const d = segDistance(centroid, bn.a, bn.b, 0, 0.97);
            if (d < bestD) { bestD = d; best = bn; }
          }
        }
      }

      if (best && bestD < 0.8) {
        let link = linkForBone.get(best);
        if (!link) {
          const g = new THREE.Group();
          g.position.copy(best.a);
          scene.add(g);
          g.updateMatrixWorld(true);
          link = {
            chain: best.chain, index: best.index, group: g,
            restPos: best.a.clone(),
            restDir: _b.subVectors(best.b, best.a).normalize().clone(),
          };
          linkForBone.set(best, link);
          this.links.push(link);
        }
        this._restore.push({ obj: node, parent: node.parent });
        link.group.attach(node); // keeps world transform
        counts.legs++;
      } else {
        counts.body++;
      }
    }

    if (!this.links.length) return null;
    this.model = model;
    this.scene = scene;
    this._wasCollidable = model.collidable;
    model.collidable = false; // the robot is the rig now, not an obstacle
    return counts;
  }

  /** Follow the solved bones (call once per frame after solving). */
  update() {
    if (!this.links.length) return;
    // bone frames are exact rest→current rotations (serial-FK, matches the solver)
    const cache = new Map();
    for (const l of this.links) {
      const a = l.chain.joints[l.index]?.pos;
      if (!a) continue;
      let frames = cache.get(l.chain);
      if (!frames) { frames = l.chain.boneFrames(); cache.set(l.chain, frames); }
      const q = frames.quats[l.index];
      if (!q) continue;
      l.group.quaternion.copy(q);
      l.group.position.copy(a);
    }
  }

  /** Undo everything: put occurrences back at rest under their original parents. */
  clear() {
    for (const l of this.links) {
      l.group.position.copy(l.restPos);
      l.group.quaternion.identity();
      l.group.updateMatrixWorld(true);
    }
    for (const r of this._restore) r.parent.attach(r.obj);
    for (const l of this.links) this.scene?.remove(l.group);
    if (this.model) this.model.collidable = this._wasCollidable ?? true;
    this.links = [];
    this._restore = [];
    this.model = null;
    this.scene = null;
  }
}
