// loader.js — model import (GLB/GLTF, OBJ, STL, STEP), normalization, registry
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { fetchArrayBuffer } from './boot.js';

let modelCounter = 0;

const clayMat = new THREE.MeshStandardMaterial({
  color: 0x9aa4b2, roughness: 0.55, metalness: 0.15,
});

/**
 * Re-fit a model: base sitting on y=0, centered, largest dimension ~3 units.
 * Called on load and whenever the up-axis rotation changes.
 */
export function fitModel(model) {
  const { group, _inner: inner, _rot: rot } = model;
  // measure with clean transforms (group may carry user scale / attach pose)
  const savedPos = group.position.clone();
  const savedQuat = group.quaternion.clone();
  const savedScale = group.scale.clone();
  group.position.set(0, 0, 0);
  group.quaternion.identity();
  group.scale.setScalar(1);
  rot.position.set(0, 0, 0);
  inner.scale.setScalar(1);
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(rot);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  rot.position.set(-center.x, -box.min.y, -center.z);
  inner.scale.setScalar(3 / maxDim);
  group.position.copy(savedPos);
  group.quaternion.copy(savedQuat);
  group.scale.copy(savedScale);
  group.updateMatrixWorld(true);
}

/** Toggle CAD Z-up correction (rotate -90° about X so Z-up data stands upright). */
export function setModelZUp(model, on) {
  model.zUp = on;
  model._rot.rotation.x = on ? -Math.PI / 2 : 0;
  fitModel(model);
}

function normalizeAndWrap(object3d, name, zUp = false) {
  // group (user scale, attach transform) > inner (normalize scale) > rot (up-axis) > object
  const rot = new THREE.Group();
  rot.add(object3d);
  const inner = new THREE.Group();
  inner.add(rot);
  const group = new THREE.Group();
  group.add(inner);

  const meshes = [];
  group.traverse(o => {
    if (o.isMesh) {
      // clone materials so per-model opacity/wireframe edits don't leak
      if (Array.isArray(o.material)) o.material = o.material.map(m => m.clone());
      else if (o.material) o.material = o.material.clone();
      o.castShadow = false;
      o.receiveShadow = false;
      meshes.push(o);
    }
  });

  const model = {
    id: ++modelCounter,
    name: name.length > 26 ? name.slice(0, 24) + '…' : name,
    group, meshes,
    _rot: rot, _inner: inner,
    zUp: false,
    visible: true,
    collidable: true, // acts as an obstacle for the collision guard
    wireframe: false,
    opacity: 1,
    userScale: 1,
    attachedTo: null, // { chain, index } | null
  };
  setModelZUp(model, zUp);
  return model;
}

function eachMaterial(model, fn) {
  for (const m of model.meshes) {
    if (Array.isArray(m.material)) m.material.forEach(fn);
    else if (m.material) fn(m.material);
  }
}

export function setModelOpacity(model, opacity) {
  model.opacity = opacity;
  eachMaterial(model, mat => {
    mat.transparent = opacity < 1;
    mat.opacity = opacity;
    mat.depthWrite = opacity >= 0.6;
    mat.needsUpdate = true;
  });
}

export function setModelWireframe(model, on) {
  model.wireframe = on;
  eachMaterial(model, mat => { if ('wireframe' in mat) mat.wireframe = on; });
}

// ---------------------------------------------------------------- STEP (occt-import-js, lazy wasm)

const OCCT_BASE = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/';
let _occtPromise = null;

function getOcct() {
  if (!_occtPromise) {
    _occtPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = OCCT_BASE + 'occt-import-js.js';
      s.onload = () => {
        window.occtimportjs({ locateFile: f => OCCT_BASE + f }).then(resolve, reject);
      };
      s.onerror = () => reject(new Error('could not load STEP converter (CDN unreachable?)'));
      document.head.appendChild(s);
    });
    _occtPromise.catch(() => { _occtPromise = null; }); // allow retry after a failure
  }
  return _occtPromise;
}

function groupFromOcct(result) {
  const group = new THREE.Group();
  for (const m of result.meshes) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.attributes.position.array), 3));
    if (m.attributes.normal) {
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(m.attributes.normal.array), 3));
    }
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(m.index.array), 1));
    if (!m.attributes.normal) geo.computeVertexNormals();
    const mat = clayMat.clone();
    if (m.color) mat.color.setRGB(m.color[0], m.color[1], m.color[2]);
    group.add(new THREE.Mesh(geo, mat));
  }
  return group;
}

// ---------------------------------------------------------------- parsing

/** Parse a model file from an ArrayBuffer. Returns a Promise<model>. */
async function parseModel(name, buffer) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'glb' || ext === 'gltf') {
    const data = ext === 'glb' ? buffer : new TextDecoder().decode(buffer);
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(data, '', res, rej));
    return normalizeAndWrap(gltf.scene, name);
  }
  if (ext === 'obj') {
    const obj = new OBJLoader().parse(new TextDecoder().decode(buffer));
    obj.traverse(o => { if (o.isMesh) o.material = clayMat.clone(); });
    return normalizeAndWrap(obj, name);
  }
  if (ext === 'stl') {
    const geo = new STLLoader().parse(buffer);
    geo.computeVertexNormals();
    return normalizeAndWrap(new THREE.Mesh(geo, clayMat.clone()), name);
  }
  if (ext === 'step' || ext === 'stp') {
    const occt = await getOcct();
    const result = occt.ReadStepFile(new Uint8Array(buffer), null);
    if (!result || !result.success || !result.meshes?.length) {
      throw new Error('STEP conversion produced no meshes');
    }
    // CAD files are Z-up; stand them upright in the Y-up scene
    return normalizeAndWrap(groupFromOcct(result), name, true);
  }
  throw new Error('unsupported format .' + ext + ' — use GLB, GLTF, OBJ, STL or STEP');
}

/** Load a FileList / array of Files. Calls onModel(model) per success, onError(name, err) per failure. */
export function loadFiles(files, onModel, onError) {
  for (const file of files) {
    file.arrayBuffer()
      .then(buf => parseModel(file.name, buf))
      .then(onModel)
      .catch(err => onError(file.name, err?.message ? err : new Error(String(err))));
  }
}

/**
 * Load a model from a same-origin URL (e.g. models/octobot.glb).
 * `onProgress(loaded, total)` fires as the bytes arrive; the mesh is large
 * enough that the boot overlay needs it to show a real bar.
 */
export function loadFromURL(url, onModel, onError, onProgress) {
  const name = decodeURIComponent(url.split('/').pop());
  fetchArrayBuffer(url, onProgress)
    .then(buf => parseModel(name, buf))
    .then(onModel)
    .catch(err => onError(name, err?.message ? err : new Error(String(err))));
}
