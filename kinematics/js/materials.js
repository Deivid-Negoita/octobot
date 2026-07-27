// materials.js — the robot's surface finish.
//
// The CAD export carries whatever colours Fusion assigned, which came out as a
// flat near-white plastic. The printed parts are actually dark grey. Remapping
// them here instead of in CAD keeps the .glb a plain geometry export, so the
// look can change without re-exporting 12 MB.
import * as THREE from 'three';

// Where the darkest and lightest source materials end up. The gap between them
// is what keeps servos, brackets and chassis readable as separate parts.
const DARK = new THREE.Color(0x23272c);
const LIGHT = new THREE.Color(0x71787f);

const luminance = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * Give every mesh under `root` a dark metallic finish.
 *
 * Each source material keeps its position in the light-to-dark ordering, so the
 * result reads as one machine in one material rather than a flat silhouette.
 * Materials are shared between meshes in a GLB, so each one is touched once.
 */
export function applyRobotFinish(root) {
  const done = new Set();
  root.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;
    const list = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of list) {
      if (done.has(mat.uuid) || !mat.color) continue;
      done.add(mat.uuid);

      const lum = luminance(mat.color);
      const t = THREE.MathUtils.smoothstep(lum, 0.04, 0.85);
      mat.color.copy(DARK).lerp(LIGHT, t);

      // Guard the PBR fields: a GLB can carry an unlit material.
      if ('metalness' in mat) mat.metalness = 0.68;
      if ('roughness' in mat) mat.roughness = 0.3 + 0.25 * (1 - t);
      if ('envMapIntensity' in mat) mat.envMapIntensity = 1.2;
      mat.needsUpdate = true;
    }
  });
}
