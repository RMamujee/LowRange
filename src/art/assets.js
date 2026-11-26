// Optional glTF art assets, following docs/MODELING_SPEC.md. Any .glb dropped under
// public/models/ (props) or public/models/vehicles/ (vehicles) replaces its procedural
// stand-in; anything missing silently falls back to procedural art.
//
// The file list comes from the 'virtual:lowrange-models' module (a tiny Vite plugin in
// vite.config.js that lists public/models), so nothing is fetched that doesn't exist and
// no 404s reach the console.
import * as THREE from 'three';

const ASSETS = new Map(); // name (path under models/ without .glb, e.g. 'tree_round_a', 'vehicles/wrx') -> THREE.Group

export async function loadArtAssets(base = './models/') {
  if (typeof document === 'undefined') return ASSETS;
  let files = [];
  try { files = (await import('virtual:lowrange-models')).default || []; } catch { return ASSETS; }
  if (!files.length) return ASSETS;
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  await Promise.all(files.map(async (file) => {
    try {
      const gltf = await loader.loadAsync(base + file);
      ASSETS.set(file.replace(/\.glb$/i, ''), gltf.scene);
    } catch (e) { console.warn(`[assets] ${file} failed to load, using procedural art:`, e?.message || e); }
  }));
  return ASSETS;
}

export const getAsset = (name) => ASSETS.get(name) || null;
// every variant of a prop: 'tree_round' matches tree_round.glb and tree_round_a/_b/_c.glb
export const assetVariants = (name) => [...ASSETS.keys()].filter((k) => k === name || new RegExp(`^${name}_[a-z]$`).test(k)).sort();

// keep imported textures crisp: pixel art wants nearest-neighbour magnification
export function prepAssetMaterial(m) {
  if (!m || m.userData.pixelPrepped) return m;
  for (const k of ['map', 'emissiveMap']) {
    const t = m[k];
    if (t) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestMipmapLinearFilter; t.needsUpdate = true; }
  }
  m.userData.pixelPrepped = true;
  return m;
}

// Flatten one prop asset into instancing parts {geometry, material}, node transforms baked
// in, so the asset's origin (base centre on the ground) is the instance pivot.
export function assetParts(name) {
  const root = getAsset(name);
  if (!root) return null;
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const material = prepAssetMaterial(Array.isArray(o.material) ? o.material[0] : o.material);
    parts.push({ geometry, material, castShadow: true });
  });
  return parts.length ? parts : null;
}
// parts for every variant of a prop, or null when there are none
export function assetPartsVariants(name) {
  const v = assetVariants(name).map(assetParts).filter(Boolean);
  return v.length ? v : null;
}

// A named node of a vehicle asset (Body, Wheel, AxleFront, AxleRear, Hub), deep-cloned with its
// own geometries (so dents on one truck don't touch another) and its transform reset to the pivot.
export function vehicleNode(id, nodeName) {
  const root = getAsset('vehicles/' + id);
  const node = root && root.getObjectByName(nodeName);
  if (!node) return null;
  const c = node.clone(true);
  c.position.set(0, 0, 0);
  c.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry = o.geometry.clone();
    o.material = Array.isArray(o.material) ? o.material.map(prepAssetMaterial) : prepAssetMaterial(o.material);
    o.castShadow = o.receiveShadow = true;
  });
  return c;
}

// Load at import time (browser only), so world and vehicle builders can use assets synchronously.
await loadArtAssets();
