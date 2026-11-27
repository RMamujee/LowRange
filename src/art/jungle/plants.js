// Tropical plants for Coralume Island (src/maps/jungle.js), built procedurally in the src/art style:
// low-poly, chunky, flat-shaded, vertex-coloured in short tone ramps (sunlit tops, darker
// undersides), so the toon pass, the world-space pixel detail (toon.js detailPatch) and the
// outlines treat them like the rest of the dressing. Each template is a list of parts
// { geometry, material, castShadow } like src/art/props.js; `lo` variants are the far LOD.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng, hash, propMaterial } from '../props.js';

// ---------- palette (calmer than the meadow greens: deep, slightly blue jungle greens) ----------
export const JUNGLE = {
  canopy: [0x76b648, 0x4f9438, 0x357a33, 0x22592b],
  canopyB: [0x8ab84a, 0x60983a, 0x437c33, 0x2c5e2c], // a yellower crown for variety
  frond: [0x8cc055, 0x67a43f, 0x468a35, 0x2f6a2c],
  fern: [0x6fb44a, 0x4f973a, 0x357a31, 0x245c2a],
  banana: [0x9ccc58, 0x7ab447, 0x5a983b, 0x3e7832],
  bark: [0x9c7a52, 0x7a5c3c, 0x5c432c, 0x3e2d1e],
  palmBark: [0xb8996a, 0x957a52, 0x735c3e, 0x51402c],
  vine: [0x4f8a36, 0x3a7030, 0x2a5626],
  coconut: 0x6b4f2e,
  flowers: [0xe85a4c, 0xf28bb0, 0xffd95a, 0xfff2e6],
};
const C = new THREE.Color();
const tone = (hex, k) => [Math.min(1, ((hex >> 16) & 255) / 255 * k), Math.min(1, ((hex >> 8) & 255) / 255 * k), Math.min(1, (hex & 255) / 255 * k)];
const pick = (arr, t) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))];
const clamp01 = (v) => Math.max(0, Math.min(1, v));
// non-indexed geometry with per-vertex colours from fn(x, y, z, face)
function paint(geo, fn) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const v = fn(p.getX(i), p.getY(i), p.getZ(i), Math.floor(i / 3));
    if (typeof v === 'number') C.setHex(v); else C.setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace);
    col[i * 3] = C.r; col[i * 3 + 1] = C.g; col[i * 3 + 2] = C.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
  g.clearGroups();
  return g;
}
// a leaf strip from `base` along a drooping arc: n segments, width profile w(t), as triangles
function leafStrip(len, width, droop, n, lift = 0.5, fold = 0.12) {
  const pos = [];
  const at = (t) => {
    const x = t * len, y = Math.sin(t * Math.PI * 0.55) * lift * len - droop * t * t * len;
    return [x, y];
  };
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const [x0, y0] = at(t0), [x1, y1] = at(t1);
    const w0 = width * Math.sin(Math.PI * Math.min(1, t0 * 1.1 + 0.08)) * (1 - t0 * 0.35), w1 = width * Math.sin(Math.PI * Math.min(1, t1 * 1.1 + 0.08)) * (1 - t1 * 0.35);
    // a slight V fold along the midrib so the leaf catches light on two facets
    const f0 = fold * w0, f1 = fold * w1;
    pos.push(x0, y0, 0, x1, y1, 0, x0, y0 - f0, w0 / 2, x1, y1, 0, x1, y1 - f1, w1 / 2, x0, y0 - f0, w0 / 2);
    pos.push(x0, y0, 0, x0, y0 - f0, -w0 / 2, x1, y1, 0, x1, y1, 0, x0, y0 - f0, -w0 / 2, x1, y1 - f1, -w1 / 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}
const solid = () => propMaterial();
// double-sided leaf materials of our own (the shared dressing_grass material is the tufts', which
// main.js takes off the depth buffer for the no-outline layer)
const MATS = {};
const leafy = (kind = 'leaf') => MATS[kind] || (MATS[kind] = Object.assign(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, side: THREE.DoubleSide }), { name: 'jungle_' + kind }));

// ---------- coconut palm: ~9 m at s = 1, a leaning ringed trunk and a crown of drooping fronds ----------
export function palmTemplate(v = 0) {
  const R = rng(700 + v), lean = 0.18 + R() * 0.16, H = 8.2 + R() * 1.2, segs = 7;
  const trunk = [];
  let x = 0, y = 0;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const r0 = 0.24 - t0 * 0.08, r1 = 0.24 - t1 * 0.08, h = H / segs;
    const c = new THREE.CylinderGeometry(r1, r0, h * 1.02, 7, 1, true);
    const bend = lean * (t0 + t1) * 0.5 * 1.6;
    c.rotateZ(-bend);
    const nx = x + Math.sin(bend) * h, ny = y + Math.cos(bend) * h;
    c.translate((x + nx) / 2, (y + ny) / 2, 0);
    trunk.push(paint(c, (px, py, pz, f) => tone(pick(JUNGLE.palmBark, f % 4 === 0 ? 0.8 : hash(f, i, v) * 0.5), 0.85 + 0.25 * (i % 2))));
    x = nx; y = ny;
  }
  const top = [x, y];
  const fronds = [];
  const n = 8 + (v % 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + R() * 0.3, len = 3.6 + R() * 0.9;
    const g = leafStrip(len, 0.95, 0.75 + R() * 0.3, 5, 0.32, 0.18);
    g.rotateZ(-0.05 - R() * 0.2);
    g.rotateY(a);
    g.translate(top[0], top[1] - 0.1, 0);
    fronds.push(paint(g, (px, py, pz, f) => tone(pick(JUNGLE.frond, hash(f, i, 31 + v) * 0.55 + (py > top[1] - 0.4 ? 0 : 0.45)), 1)));
  }
  const nuts = [];
  for (let i = 0; i < 4; i++) {
    const a = i * 1.7, g = new THREE.IcosahedronGeometry(0.17, 0);
    g.translate(top[0] + Math.cos(a) * 0.28, top[1] - 0.35, Math.sin(a) * 0.28);
    nuts.push(paint(g, () => tone(JUNGLE.coconut, 1)));
  }
  return [
    { geometry: mergeGeometries([...trunk, ...nuts]), material: solid(), castShadow: true },
    { geometry: mergeGeometries(fronds), material: leafy(), castShadow: true },
  ];
}
export function palmLo(v = 0) {
  const R = rng(700 + v), lean = 0.18 + R() * 0.16, H = 8.2 + R() * 1.2;
  const tip = [Math.sin(lean * 1.6) * H * 0.55, H * 0.97];
  const t = new THREE.CylinderGeometry(0.14, 0.24, H, 4, 1);
  t.translate(0, H / 2, 0);
  const pos = t.attributes.position;
  for (let i = 0; i < pos.count; i++) { const k = pos.getY(i) / H; pos.setX(i, pos.getX(i) + tip[0] * k * k); }
  const crown = new THREE.OctahedronGeometry(1, 0);
  crown.scale(3.2, 0.9, 3.2); crown.translate(tip[0], tip[1] - 0.4, 0);
  return mergeGeometries([paint(t, () => tone(JUNGLE.palmBark[1], 1)), paint(crown, (x, y, z, f) => tone(JUNGLE.frond[y > tip[1] - 0.4 ? 1 : 2], 1))]);
}

// ---------- broadleaf rainforest tree: ~12 m at s = 1, buttressed trunk, a wide layered crown ----------
// giant: an emergent (~16 m), broader crown, hanging vines
export function broadleafTemplate(v = 0, giant = false) {
  const R = rng(800 + v + (giant ? 50 : 0)), H = giant ? 9.5 : 4.6 + R() * 1.4, rT = 0.22;
  const trunk = [];
  const t = new THREE.CylinderGeometry(rT * 0.75, rT, H, 7, 2); t.translate(0, H / 2, 0); trunk.push(t);
  // buttress roots: thin fins flaring out at the foot
  const fins = giant ? 5 : 3;
  for (let i = 0; i < fins; i++) {
    const a = (i / fins) * Math.PI * 2 + R(), L = giant ? 1.5 : 0.9, Hh = giant ? 2.4 : 1.3;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, Hh, 0, L, 0, 0.06, L, 0, -0.06, 0, Hh, 0, 0, 0, -0.12, L, 0, -0.06, 0, Hh, 0, L, 0, 0.06, 0, 0, 0.12], 3));
    g.rotateY(a); trunk.push(g);
  }
  // two limbs up into the crown
  for (const s of [-1, 1]) { const b = new THREE.CylinderGeometry(0.07, 0.12, 2.6, 5); b.rotateZ(s * 0.7); b.translate(s * 0.75, H - 0.6, 0); trunk.push(b); }
  const trunkGeo = mergeGeometries(trunk.map((g, gi) => paint(g, (x, y, z, f) => tone(pick(JUNGLE.bark, hash(f, gi, v) < 0.3 ? 0.6 : 0.2), 0.75 + 0.3 * clamp01(y / H)))));
  // crown: flattened clusters, the top layer sunlit and the underside deep
  const blobs = [], ramp = v % 3 === 2 ? JUNGLE.canopyB : JUNGLE.canopy;
  const spread = giant ? 4.8 : 3.3, nb = giant ? 10 : 8;
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * Math.PI * 2 + R() * 0.6, d = i === 0 ? 0 : spread * (0.55 + R() * 0.35);
    const r = (giant ? 2.5 : 2.0) * (0.85 + R() * 0.35), low = i > 0 && i % 2 === 0; // alternate blobs hang lower: a deep, layered crown
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.scale(1.2, 0.7, 1.2);
    g.translate(Math.cos(a) * d, H + (low ? -0.9 : 0.5) + R() * (giant ? 1.6 : 1.1) + (i === 0 ? 1.4 : 0), Math.sin(a) * d);
    blobs.push(g);
  }
  const y0 = H - 2.2, y1 = H + (giant ? 4.4 : 3.6);
  const canopy = mergeGeometries(blobs.map((g, bi) => paint(g, (x, y, z, f) => {
    const k = clamp01((y - y0) / (y1 - y0));
    return tone(pick(ramp, (1 - k) * 0.8 + hash(f, bi, 11 + v) * 0.25), 0.9 + 0.12 * k);
  })));
  const parts = [{ geometry: mergeGeometries([trunkGeo, canopy]), material: solid(), castShadow: true }];
  if (giant) {
    // vines hanging from the crown edge
    const vines = [];
    for (let i = 0; i < 7; i++) {
      const a = R() * Math.PI * 2, d = spread * (0.4 + R() * 0.5), len = 3 + R() * 4, w = 0.09;
      const g = new THREE.PlaneGeometry(w, len, 1, 3);
      g.translate(Math.cos(a) * d, H + 0.2 - len / 2, Math.sin(a) * d);
      g.rotateY(0); vines.push(paint(g, (x, y) => tone(pick(JUNGLE.vine, clamp01((H - y) / 7)), 1)));
    }
    parts.push({ geometry: mergeGeometries(vines), material: leafy(), castShadow: false });
  }
  return parts;
}
export function broadleafLo(v = 0, giant = false) {
  const R = rng(800 + v + (giant ? 50 : 0)), H = giant ? 9.5 : 4.6 + R() * 1.4;
  const t = new THREE.CylinderGeometry(0.16, 0.22, H, 4); t.translate(0, H / 2, 0);
  const ramp = v % 3 === 2 ? JUNGLE.canopyB : JUNGLE.canopy, spread = giant ? 4.8 : 3.3;
  const c = new THREE.IcosahedronGeometry(1, 0); c.scale(spread * 1.45, giant ? 2.8 : 2.4, spread * 1.45); c.translate(0, H + (giant ? 1.6 : 1.0), 0);
  return mergeGeometries([paint(t, () => tone(JUNGLE.bark[1], 0.9)), paint(c, (x, y) => tone(ramp[y > H + 1.2 ? 1 : 2], 1))]);
}

// ---------- undergrowth ----------
// fern: a rosette of arching fronds, ~1 m
export function fernTemplate(v = 0) {
  const R = rng(900 + v), n = 6, fronds = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + R() * 0.5, g = leafStrip(0.9 + R() * 0.35, 0.34, 1.0, 4, 0.9, 0.1);
    g.rotateY(a); fronds.push(paint(g, (x, y, z, f) => tone(pick(JUNGLE.fern, hash(f, i, v) * 0.5 + (y > 0.35 ? 0 : 0.4)), 1)));
  }
  return [{ geometry: mergeGeometries(fronds), material: leafy(), castShadow: false }];
}
// banana / big-leaf plant: a short stem and a few huge paddle leaves, ~2.4 m
export function bananaTemplate(v = 0) {
  const R = rng(950 + v), parts = [];
  const stem = new THREE.CylinderGeometry(0.1, 0.16, 1.6, 6); stem.translate(0, 0.8, 0);
  parts.push(paint(stem, (x, y) => tone(JUNGLE.banana[2], 0.8 + 0.2 * y)));
  const n = 5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + R() * 0.6, g = leafStrip(1.6 + R() * 0.4, 0.75, 0.6, 4, 0.55, 0.08);
    g.translate(0, 1.45, 0); g.rotateY(a);
    parts.push(paint(g, (x, y, z, f) => tone(pick(JUNGLE.banana, hash(f, i, v) * 0.4 + (y > 1.8 ? 0 : 0.45)), 1)));
  }
  return [{ geometry: mergeGeometries(parts), material: leafy(), castShadow: true }];
}
// jungle shrub: leafy blobs, optionally with hibiscus flowers
export function shrubTemplate(v = 0, flowers = false) {
  const R = rng(980 + v + (flowers ? 20 : 0)), blobs = [], n = 3 + (v % 2);
  for (let i = 0; i < n; i++) {
    const r = 0.5 + R() * 0.3, a = (i / n) * Math.PI * 2;
    const g = new THREE.IcosahedronGeometry(r, 1); g.scale(1, 0.8, 1);
    g.translate(i ? Math.cos(a) * 0.5 : 0, r * 0.7 + (i ? 0 : 0.25), i ? Math.sin(a) * 0.5 : 0);
    blobs.push(g);
  }
  const fl = flowers ? JUNGLE.flowers[v % 3] : 0;
  return [{ geometry: mergeGeometries(blobs.map((g, bi) => paint(g, (x, y, z, f) => {
    const h = hash(f, bi, 41 + v);
    if (flowers && y > 0.4 && h < 0.14) return tone(fl, 1);
    return tone(pick(JUNGLE.fern, (1 - clamp01(y / 1.2)) * 0.7 + h * 0.3), 1);
  }))), material: solid(), castShadow: true }];
}
// ground plant: a small clump of broad blades (the jungle floor's "tufts")
export function groundPlantTemplate(v = 0) {
  const R = rng(990 + v), blades = [], n = 5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + R() * 0.7, g = leafStrip(0.42 + R() * 0.2, 0.16, 0.6, 2, 1.1, 0.05);
    g.rotateY(a); blades.push(paint(g, (x, y) => tone(pick(JUNGLE.fern, y > 0.2 ? 0.1 : 0.6), 1)));
  }
  const geo = mergeGeometries(blades);
  const nn = geo.attributes.normal; for (let i = 0; i < nn.count; i++) nn.setXYZ(i, 0, 1, 0);
  return [{ geometry: geo, material: leafy('ground'), castShadow: false }];
}
