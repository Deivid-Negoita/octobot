// perf.js — hold a usable frame rate on hardware that is not this laptop.
//
// The chassis mesh is dense and the scene is fill-rate bound, so the cheapest
// thing to give up under load is resolution. An integrated GPU at devicePixelRatio
// 2 renders four times the pixels of one at 1, which is usually the whole
// difference between 20 fps and 60.

const UP = 1 / 90;    // faster than this, spend pixels   (~90 fps)
const DOWN = 1 / 48;  // slower than this, save pixels    (~48 fps)

/**
 * Watch frame time and move the renderer's pixel ratio to match.
 *
 * Call the returned function once per frame with the frame delta in seconds.
 * It settles within about a second of a sustained change and then stops
 * adjusting, so it will not oscillate while the gait runs.
 */
export function createResolutionGovernor(renderer, opts = {}) {
  const ceiling = opts.max ?? Math.min(window.devicePixelRatio || 1, 2);
  const floor = opts.min ?? 0.7;
  const settleFrames = opts.settleFrames ?? 45;

  let scale = ceiling;
  let avg = 1 / 60;
  let held = 0;

  renderer.setPixelRatio(scale);

  return function sample(dt) {
    // ignore a stalled tab or a one-off hitch, which would trigger a false drop
    if (dt <= 0 || dt > 0.5) return scale;
    avg += (dt - avg) * 0.1;

    held++;
    if (held < settleFrames) return scale;

    let next = scale;
    if (avg > DOWN) next = Math.max(floor, scale - 0.25);
    else if (avg < UP) next = Math.min(ceiling, scale + 0.25);

    if (next !== scale) {
      scale = next;
      renderer.setPixelRatio(scale);
      renderer.setSize(window.innerWidth, window.innerHeight);
      held = 0;
    } else {
      held = settleFrames; // stay armed without letting the counter run away
    }
    return scale;
  };
}

/**
 * A soft round shadow that sits under the robot and follows it.
 *
 * A real shadow map costs a second render pass of a 12 MB mesh every frame.
 * This is a single textured quad, and at this camera distance it reads the same.
 */
export function createContactShadow(THREE, { size = 2.4, opacity = 0.34 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 3, 64, 64, 64);
  grd.addColorStop(0.0, 'rgba(0,0,0,0.95)');
  grd.addColorStop(0.45, 'rgba(0,0,0,0.45)');
  grd.addColorStop(1.0, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(c),
      transparent: true,
      opacity,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.012;
  mesh.renderOrder = -1;
  return mesh;
}
