// Procedural set-dressing props (trees, bushes, logs, stumps, fences, grass tufts, stones) as
// instancing templates, plus the instancer that scatters them in spatial chunks so frustum
// culling works. Plain geometry with vertex colours and flat-shaded standard materials: the
// game's art skin patches materials in place, so no textures or outlines are added here.
// A template is a list of parts {geometry, material}; glTF assets (assets.js) produce the
// same shape, so they drop in unchanged.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { assetPartsVariants } from './assets.js';

// ---------- deterministic randomness ----------
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function hash(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------- geometry helpers ----------
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const C = new THREE.Color();
// non-indexed copy with a per-vertex colour. fn(x, y, z, face) -> 0xRRGGBB or [r, g, b];
// `face` is the triangle index, so callers can colour whole facets (chunky pixel-art look)
function prep(geo, fn) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const v = fn ? fn(p.getX(i), p.getY(i), p.getZ(i), Math.floor(i / 3)) : 0xffffff;
    if (typeof v === 'number') C.setHex(v); else C.setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace);
    col[i * 3] = C.r; col[i * 3 + 1] = C.g; col[i * 3 + 2] = C.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!g.attributes.normal) g.computeVertexNormals();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
  g.clearGroups();
  return g;
}
// hex colour scaled by k (sRGB components), as an [r, g, b] triple
const tone = (hex, k) => [Math.min(1, ((hex >> 16) & 255) / 255 * k), Math.min(1, ((hex >> 8) & 255) / 255 * k), Math.min(1, (hex & 255) / 255 * k)];
const pickHex = (arr, t) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))];

// ---------- palette (warm, saturated, after the reference concept art) ----------
const BARK = 0x7a4e2c, BARK_DARK = 0x5a3820, WOOD = 0x9a6a3e, RINGS = 0xd9a868;
const LEAF = [0x3f8a2a, 0x4c9a30, 0x5aaa36, 0x6ab83e];
const PINE = [0x2a6e3a, 0x327c40, 0x3b8a46];
const FLOWERS = [0xf29bbf, 0xfff2ee, 0xf7b8d0];

// ---------- materials (shared, flat-shaded, coloured by vertex colours) ----------
const M = {};
export function propMaterial(kind = 'solid') {
  if (!M[kind]) {
    M[kind] = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, side: kind === 'grass' ? THREE.DoubleSide : THREE.FrontSide });
    M[kind].name = 'dressing_' + kind;
  }
  return M[kind];
}

// ---------- templates ----------
// Round deciduous tree, ~5.6 m tall at scale 1: thick flared trunk, chunky clustered canopy.
export function roundTreeTemplate(variant = 0) {
  const R = rng(100 + variant);
  const trunk = [];
  const t = new THREE.CylinderGeometry(0.2, 0.3, 3.0, 7); t.translate(0, 1.2, 0); trunk.push(t);
  const flare = new THREE.CylinderGeometry(0.3, 0.46, 0.5, 7); flare.translate(0, -0.05, 0); trunk.push(flare);
  for (const s of [-1, 1]) { // two stubby limbs into the canopy
    const b = new THREE.CylinderGeometry(0.08, 0.13, 1.1, 5); b.rotateZ(s * 0.75); b.translate(s * 0.38, 2.5, 0); trunk.push(b);
  }
  const trunkGeo = mergeGeometries(trunk.map((g) => prep(g, (x, y, z, f) => tone(hash(f, 1, variant) < 0.25 ? BARK_DARK : BARK, 0.75 + 0.3 * clamp01(y / 2.5)))));
  const blobs = [];
  const n = 7 + (variant % 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + R() * 0.5, top = i === 0;
    const r = top ? 1.25 : 0.95 + R() * 0.35;
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.translate(top ? 0 : Math.cos(a) * 1.15, top ? 4.55 : 3.5 + R() * 0.7, top ? 0 : Math.sin(a) * 1.15);
    blobs.push(g);
  }
  { const g = new THREE.IcosahedronGeometry(1.35, 1); g.translate(0, 3.9, 0); blobs.push(g); }
  const hue = [1, 1.06, 0.94][variant % 3];
  const canopy = mergeGeometries(blobs.map((g, bi) => prep(g, (x, y, z, f) => {
    const k = (0.62 + 0.45 * clamp01((y - 2.6) / 2.8)) * hue; // darker underneath, sunlit crown
    return tone(pickHex(LEAF, hash(f, bi, 11 + variant)), k);
  })));
  return [{ geometry: mergeGeometries([trunkGeo, canopy]), material: propMaterial(), castShadow: true }];
}

// Layered pine, ~7 m tall at scale 1.
export function pineTemplate(variant = 0) {
  const trunk = new THREE.CylinderGeometry(0.14, 0.26, 2.2, 6); trunk.translate(0, 0.8, 0);
  const tiers = [];
  const N = 4 + (variant % 2);
  for (let i = 0; i < N; i++) {
    const f = i / (N - 1);
    const r = 1.9 - f * 1.3, h = 2.1 - f * 0.6, y = 1.4 + i * (5.2 / N) + h / 2;
    const c = new THREE.ConeGeometry(r, h, 8, 1); c.rotateY(i * 0.4); c.translate(0, y, 0);
    tiers.push(prep(c, (x, yy, z, fc) => tone(pickHex(PINE, hash(fc, i, 21 + variant)), 0.62 + 0.5 * clamp01((yy - (y - h / 2)) / h))));
  }
  return [
    { geometry: mergeGeometries([prep(trunk, (x, y) => tone(BARK, 0.7 + 0.3 * clamp01(y / 2))), ...tiers]), material: propMaterial(), castShadow: true },
  ];
}

// Bush: a few leafy blobs; the flowering variant has pink/white facets scattered over it.
export function bushTemplate(flowers = false, variant = 0) {
  const R = rng(300 + variant + (flowers ? 50 : 0));
  const blobs = [];
  const n = 3 + (variant % 3);
  for (let i = 0; i < n; i++) {
    const r = 0.45 + R() * 0.25, a = (i / n) * Math.PI * 2;
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.scale(1, 0.85, 1);
    g.translate(i ? Math.cos(a) * 0.45 : 0, r * 0.7 + (i ? 0 : 0.2), i ? Math.sin(a) * 0.45 : 0);
    blobs.push(g);
  }
  const geo = mergeGeometries(blobs.map((g, bi) => prep(g, (x, y, z, f) => {
    const h = hash(f, bi, 31 + variant);
    if (flowers && y > 0.35 && h < 0.16) return pickHex(FLOWERS, h / 0.16);
    return tone(pickHex(LEAF, h), 0.62 + 0.45 * clamp01(y / 1.1));
  })));
  return [{ geometry: geo, material: propMaterial(), castShadow: true }];
}

// Fallen log lying along +X, unit length at scale 1 (instances stretch X), radius 0.3.
export function logTemplate() {
  const side = new THREE.CylinderGeometry(0.3, 0.3, 1, 8, 1, true); side.rotateZ(Math.PI / 2); side.translate(0, 0.26, 0);
  const caps = [];
  for (const s of [-1, 1]) { const c = new THREE.CircleGeometry(0.3, 8); c.rotateY(s * Math.PI / 2); c.translate(s * 0.5, 0.26, 0); caps.push(prep(c, () => RINGS)); }
  return [{ geometry: mergeGeometries([prep(side, (x, y, z, f) => tone(f % 3 ? BARK : BARK_DARK, 0.72 + 0.35 * clamp01(y / 0.55))), ...caps]), material: propMaterial(), castShadow: true }];
}
export function stumpTemplate() {
  const side = new THREE.CylinderGeometry(0.32, 0.42, 0.6, 8, 1, true); side.translate(0, 0.15, 0);
  const top = new THREE.CircleGeometry(0.32, 8); top.rotateX(-Math.PI / 2); top.translate(0, 0.45, 0);
  return [{ geometry: mergeGeometries([prep(side, (x, y, z, f) => tone(f % 3 ? BARK : BARK_DARK, 0.7 + 0.35 * clamp01((y + 0.15) / 0.6))), prep(top, () => RINGS)]), material: propMaterial(), castShadow: true }];
}
// small decorative stones (no colliders): light tops, darker bases
export function pebbleTemplate(variant = 0) {
  const R = rng(500 + variant);
  const g = new THREE.IcosahedronGeometry(0.35, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (0.9 + R() * 0.2), Math.max(-0.05, p.getY(i)) * 0.75, p.getZ(i) * (0.9 + R() * 0.2));
  g.computeVertexNormals();
  return [{ geometry: prep(g, (x, y) => tone(0xa69682, y > 0.15 ? 1.12 : 0.8)), material: propMaterial(), castShadow: false }];
}
// fence post (1.3 m) and a unit rail along +X (instances stretch X)
export function fencePostTemplate() {
  const g = new THREE.BoxGeometry(0.2, 1.3, 0.2); g.translate(0, 0.5, 0);
  const cap = new THREE.BoxGeometry(0.24, 0.06, 0.24); cap.translate(0, 1.17, 0);
  return [{ geometry: mergeGeometries([prep(g, (x, y) => tone(WOOD, 0.75 + 0.3 * clamp01(y))), prep(cap, () => tone(WOOD, 1.1))]), material: propMaterial(), castShadow: true }];
}
export function fenceRailTemplate() {
  const g = new THREE.BoxGeometry(1, 0.14, 0.08);
  return [{ geometry: prep(g, (x, y) => tone(WOOD, y > 0 ? 1.05 : 0.85)), material: propMaterial(), castShadow: true }];
}
// grass tuft: a fan of thin blades, dark at the root and bright at the tip; the flowering
// variant tops a few blades with a pink/white/yellow head
export function tuftTemplate(flowers = false) {
  const R = rng(flowers ? 61 : 60);
  const blades = [];
  const n = flowers ? 5 : 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + R() * 0.6, lean = 0.08 + R() * 0.12, h = 0.22 + R() * 0.2, w = 0.045;
    const g = new THREE.BufferGeometry();
    const cx = Math.cos(a), cz = Math.sin(a);
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      -w * cz, 0, w * cx, w * cz, 0, -w * cx, cx * lean, h, cz * lean,
    ], 3));
    g.computeVertexNormals();
    blades.push(prep(g, (x, y) => (y > 0.1 ? 0x8ccc52 : y > 0.01 ? 0x5ea436 : 0x3e7a26)));
    if (flowers && i < 3) {
      const f = new THREE.OctahedronGeometry(0.045, 0); f.translate(cx * lean, h, cz * lean);
      const col = pickHex([0xf29bbf, 0xfff4f0, 0xffd84a], R());
      blades.push(prep(f, () => col));
    }
  }
  const geo = mergeGeometries(blades);
  // up-facing normals so the blades light like the ground they grow from
  const nn = geo.attributes.normal;
  for (let i = 0; i < nn.count; i++) nn.setXYZ(i, 0, 1, 0);
  return [{ geometry: geo, material: propMaterial('grass'), castShadow: false }];
}

// ---------- instancing ----------
// variants of a prop: every glTF variant (name.glb, name_a.glb, ...) if any exist, else n procedural ones
export function variants(name, n, make) { return assetPartsVariants(name) || Array.from({ length: n }, (_, i) => make(i)); }

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Euler();
const _c = new THREE.Color();
// items: [{x, y, z, ry, s, sx?, sy?, sz?, rx?, rz?, color?}]; returns a Group of InstancedMeshes,
// one per template part per spatial chunk
export function instance(template, items, { chunk = 100, name = 'props', shadows = true } = {}) {
  const group = new THREE.Group(); group.name = name;
  if (!items.length) return group;
  const bins = new Map();
  for (const it of items) {
    const k = `${Math.floor(it.x / chunk)},${Math.floor(it.z / chunk)}`;
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(it);
  }
  for (const list of bins.values()) {
    for (const part of template) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, list.length);
      list.forEach((it, i) => {
        _q.setFromEuler(_e.set(it.rx || 0, it.ry || 0, it.rz || 0));
        const s = it.s ?? 1;
        _m.compose(_p.set(it.x, it.y, it.z), _q, _s.set(s * (it.sx ?? 1), s * (it.sy ?? 1), s * (it.sz ?? 1)));
        im.setMatrixAt(i, _m);
        if (it.color !== undefined) im.setColorAt(i, _c.set(it.color));
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = shadows && part.castShadow !== false;
      im.receiveShadow = true;
      group.add(im);
    }
  }
  return group;
}
