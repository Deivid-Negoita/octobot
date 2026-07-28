// materials.js — the robot's surface finish.
//
// The CAD export carries Fusion's appearance colours, which come out as a flat
// near-white plastic; the printed parts are dark grey. Remapping here rather than
// in CAD keeps the .glb a plain geometry export, so the finish can change without
// re-exporting 12 MB.
import * as THREE from 'three';

// The darkest and lightest printed materials. The gap between them is what keeps
// servos, brackets and chassis readable as separate parts, and both are neutral
// so they take their cast from the lights instead of carrying one of their own.
const DARK = new THREE.Color(0x1c1c1c);
const LIGHT = new THREE.Color(0x4a4a4a);

// Machined aluminium, a touch warm so the hardware separates from the printed
// grey rather than reading as a lighter plastic.
const METAL = new THREE.Color(0xa9a7a2);

const luminance = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

// Fusion writes a metal appearance's measured F0 as its base colour: bright, and
// close to neutral. Nothing printed on this robot is anywhere near that, so the
// exported colour alone tells a machined part from a plastic one.
const isMetal = c =>
  luminance(c) > 0.8 && Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) < 0.06;

/**
 * Give every mesh under `root` its real finish: dark printed plastic for the
 * structure, metal for the hardware. Printed parts keep their place in the
 * light-to-dark ordering, so the result reads as one machine.
 *
 * A GLB shares materials between meshes, so each material is touched once.
 */
export function applyRobotFinish(root) {
  const done = new Set();
  root.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;
    const list = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of list) {
      if (done.has(mat.uuid) || !mat.color) continue;
      done.add(mat.uuid);

      const src = mat.color.clone();

      // Guard the PBR fields throughout: a GLB can carry an unlit material.
      if (isMetal(src)) {
        mat.color.copy(METAL);
        if ('metalness' in mat) mat.metalness = 1;
        if ('roughness' in mat) mat.roughness = 0.28;
        if ('envMapIntensity' in mat) mat.envMapIntensity = 1;
      } else {
        const t = THREE.MathUtils.smoothstep(luminance(src), 0.04, 0.85);
        mat.color.copy(DARK).lerp(LIGHT, t);
        // Printed plastic is a dielectric. Anything in the middle of the metalness
        // range has no physical meaning and renders as painted metal.
        if ('metalness' in mat) mat.metalness = 0.04;
        // Layer lines scatter, so printed parts are matte end to end.
        if ('roughness' in mat) mat.roughness = 0.5 + 0.2 * (1 - t);
        if ('envMapIntensity' in mat) mat.envMapIntensity = 0.9;
      }
      mat.needsUpdate = true;
    }
  });
}
