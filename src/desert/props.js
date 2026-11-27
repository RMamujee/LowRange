// Procedural desert props for Sunfall Basin, in the src/art/props.js style: a template is a list
// of parts { geometry, material, castShadow }, vertex-coloured (facets picked from small ramps for
// the chunky pixel-art look) on the shared flat-shaded dressing material. No brand names or logos.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { propMaterial, rng, hash } from '../art/props.js';
import { fitFace, signpost, faceYaw } from '../art/signs.js';
import { MAP, ROADS, TRAILS, pathPoint } from '../terrain.js';

const C = new THREE.Color();
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const tone = (hex, k) => [Math.min(1, ((hex >> 16) & 255) / 255 * k), Math.min(1, ((hex >> 8) & 255) / 255 * k), Math.min(1, (hex & 255) / 255 * k)];
function prep(geo, fn) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const v = fn(p.getX(i), p.getY(i), p.getZ(i), Math.floor(i / 3));
    if (typeof v === 'number') C.setHex(v); else C.setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace);
    col[i * 3] = C.r; col[i * 3 + 1] = C.g; col[i * 3 + 2] = C.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('normal'); g.computeVertexNormals();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
  g.clearGroups();
  return g;
}
const part = (geos, castShadow = true) => ({ geometry: mergeGeometries(geos), material: propMaterial(), castShadow });

// palettes (calm, a step under the vehicles)
const CACTUS = [0x8aa463, 0x6f8c4e, 0x58733f, 0x445a32];
const YUCCA_LEAF = [0x9aa86a, 0x7d8c52, 0x63703f];
const BARK = [0x9a8470, 0x7c6858, 0x5e4e42];
const DEAD = [0xb4a594, 0x938472, 0x726454];
const SHRUB = [[0x9aa070, 0x7f865a, 0x666c48], [0xa89c6a, 0x8a7f55, 0x6c6444], [0x8f9b78, 0x75805f, 0x5c654b]];
const WOOD = 0x9a7452, WOOD_DARK = 0x6e5038, TIN = 0xa9a49a, TIN_DARK = 0x7f7a72, RUST = 0xa0603e, PAINT = 0xd9cdb4;

// ---- column cactus: a ribbed trunk (radius matches its 0.22 m x s collider) with 0-3 arms ----
function cactus(variant) {
  const R = rng(1200 + variant), geos = [];
  const ribbed = (g) => prep(g, (x, y, z, f) => tone(CACTUS[f % 2 ? 1 : 2], 0.82 + 0.25 * clamp01(y / 4)));
  const trunkH = 3.2 + variant * 0.35;
  const t = new THREE.CylinderGeometry(0.22, 0.25, trunkH, 8, 3); t.translate(0, trunkH / 2, 0); geos.push(ribbed(t));
  const cap = new THREE.SphereGeometry(0.22, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2); cap.translate(0, trunkH, 0); geos.push(ribbed(cap));
  const arms = [0, 1, 2, 3][variant % 4];
  for (let k = 0; k < arms; k++) {
    const a = (k / Math.max(1, arms)) * Math.PI * 2 + R() * 0.8, y0 = 1.2 + R() * 1.0, out = 0.55 + R() * 0.2, up = 0.8 + R() * 0.9;
    const elbow = new THREE.CylinderGeometry(0.15, 0.15, out, 6); elbow.rotateZ(Math.PI / 2); elbow.translate(out / 2, y0, 0);
    const rise = new THREE.CylinderGeometry(0.15, 0.16, up, 7); rise.translate(out, y0 + up / 2, 0);
    const tip = new THREE.SphereGeometry(0.15, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2); tip.translate(out, y0 + up, 0);
    for (const g of [elbow, rise, tip]) { g.rotateY(a); geos.push(ribbed(g)); }
  }
  return [part(geos)];
}
export const cactusTemplates = () => [0, 1, 2, 3].map(cactus);

// ---- yucca tree: a shaggy forked trunk topped by spiky leaf tufts ----
function yucca(variant) {
  const R = rng(1300 + variant), trunk = [], leaves = [];
  const t = new THREE.CylinderGeometry(0.18, 0.24, 1.9, 6); t.translate(0, 0.95, 0); trunk.push(t);
  const n = 2 + (variant % 2);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + R(), lean = 0.45 + R() * 0.3, L = 1.1 + R() * 0.8;
    const b = new THREE.CylinderGeometry(0.11, 0.15, L, 5); b.translate(0, L / 2, 0); b.rotateZ(lean); b.rotateY(a); b.translate(0, 1.8, 0);
    trunk.push(b);
    const tx = -Math.sin(lean) * L * Math.cos(a), tz = Math.sin(lean) * L * Math.sin(a), ty = 1.8 + Math.cos(lean) * L;
    for (let j = 0; j < 9; j++) { // a ball of spikes
      const s = new THREE.ConeGeometry(0.05, 0.55, 3); s.translate(0, 0.27, 0);
      s.rotateZ(Math.PI * 0.5 * (0.2 + R() * 1.4) * (R() < 0.5 ? -1 : 1)); s.rotateY(R() * 6.28); s.translate(tx, ty, tz);
      leaves.push(s);
    }
  }
  return [
    part(trunk.map((g) => prep(g, (x, y, z, f) => tone(BARK[f % 3], 0.8 + 0.2 * clamp01(y / 3))))),
    part(leaves.map((g, i) => prep(g, () => tone(YUCCA_LEAF[i % 3], 1)))),
  ];
}
export const yuccaTemplates = () => [0, 1, 2].map(yucca);

// ---- dead snag: a bleached, twisted trunk with a few bare limbs ----
function snag(variant) {
  const R = rng(1400 + variant), geos = [];
  const t = new THREE.CylinderGeometry(0.12, 0.22, 2.4, 6); t.rotateZ(0.08); t.translate(0, 1.2, 0); geos.push(t);
  for (let k = 0; k < 4; k++) {
    const L = 0.8 + R() * 1.0, b = new THREE.CylinderGeometry(0.04, 0.08, L, 4);
    b.translate(0, L / 2, 0); b.rotateZ(0.6 + R() * 0.6); b.rotateY(R() * 6.28); b.translate(0, 1.2 + R() * 1.1, 0); geos.push(b);
  }
  return [part(geos.map((g) => prep(g, (x, y, z, f) => tone(DEAD[f % 3], 0.85 + 0.15 * clamp01(y / 3)))))];
}
export const snagTemplates = () => [0, 1].map(snag);

// ---- small plants ----
export function shrubTemplate(variant) { // creosote / sage: a few low grey-green blobs, about 0.8 m
  const R = rng(1500 + variant), pal = SHRUB[variant % 3], geos = [];
  const n = 3 + (variant % 2);
  for (let i = 0; i < n; i++) {
    const r = 0.26 + R() * 0.16, a = (i / n) * Math.PI * 2;
    const g = new THREE.IcosahedronGeometry(r, 0); g.scale(1, 0.75, 1);
    g.translate(i ? Math.cos(a) * 0.3 : 0, r * 0.6 + (i ? 0 : 0.12), i ? Math.sin(a) * 0.3 : 0);
    geos.push(prep(g, (x, y, z, f) => tone(pal[hash(f, i, variant) < 0.4 ? 0 : hash(f, i, 7) < 0.6 ? 1 : 2], 0.78 + 0.35 * clamp01(y / 0.7))));
  }
  return [part(geos)];
}
export function barrelTemplate(variant) { // barrel cactus with a small flower crown
  const g = new THREE.CylinderGeometry(0.24, 0.28, 0.55, 9, 2); g.translate(0, 0.25, 0);
  const top = new THREE.SphereGeometry(0.24, 9, 3, 0, Math.PI * 2, 0, Math.PI / 2); top.translate(0, 0.52, 0);
  const fl = new THREE.OctahedronGeometry(0.08, 0); fl.translate(0, 0.74, 0);
  const flower = variant ? 0xf0c050 : 0xe88a7a;
  return [part([prep(g, (x, y, z, f) => tone(CACTUS[f % 2 ? 1 : 2], 0.85 + 0.3 * clamp01(y / 0.6))), prep(top, (x, y, z, f) => tone(CACTUS[f % 2 ? 0 : 1], 1)), prep(fl, () => flower)])];
}
export function tumbleweedTemplate() { // a round, wiry dry bush
  const R = rng(1600), geos = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.IcosahedronGeometry(0.42 - i * 0.08, 1); g.scale(1, 0.82, 1);
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) { const s = 0.85 + R() * 0.3; p.setXYZ(k, p.getX(k) * s, p.getY(k) * s + 0.36, p.getZ(k) * s); }
    geos.push(prep(g, (x, y, z, f) => tone([0xc2a37a, 0xa88a62, 0x8a704f][(f + i) % 3], 0.85 + 0.2 * clamp01(y / 0.8))));
  }
  return [part(geos)];
}
export function sandGrassTemplate() { // a sparse fan of pale straw blades
  const R = rng(1700), blades = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + R() * 0.5, lean = 0.12 + R() * 0.15, h = 0.3 + R() * 0.25, w = 0.04, cx = Math.cos(a), cz = Math.sin(a);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-w * cz, 0, w * cx, w * cz, 0, -w * cx, cx * lean, h, cz * lean], 3));
    blades.push(prep(g, (x, y) => (y > 0.15 ? 0xd8c890 : y > 0.01 ? 0xb8a670 : 0x8c7c52)));
  }
  const geo = mergeGeometries(blades), nn = geo.attributes.normal;
  for (let i = 0; i < nn.count; i++) nn.setXYZ(i, 0, 1, 0);
  return [{ geometry: geo, material: propMaterial('grass'), castShadow: false }];
}

// ---- built things ----
const box = (w, h, d, x, y, z, col, ry = 0) => { const g = new THREE.BoxGeometry(w, h, d); g.rotateY(ry); g.translate(x, y, z); return prep(g, (px, py, pz, f) => tone(col, f % 4 < 2 ? 1.05 : 0.88)); };
function meshOf(geos) { const m = new THREE.Mesh(mergeGeometries(geos), propMaterial()); m.castShadow = true; m.receiveShadow = true; return m; }

// The camp (Sunfall Station): an old fuel stop at the trailhead lot. Its solid pieces stand on the
// map's box colliders (MAP.PROPS kind 'camp-*'), so what you see is what you hit; the fence and
// the canopy roof are visual only and stand clear of the lot and the roads.
export function camp(th, { heightAt, clear }) {
  const g = new THREE.Group(); g.name = 'camp';
  for (const b of MAP.PROPS) {
    if (!b.kind.startsWith('camp-')) continue;
    const o = new THREE.Group(); o.position.set(b.x, b.y - b.hy, b.z); o.rotation.y = b.rotY;
    const W = b.hx * 2, Hh = b.hy * 2, D = b.hz * 2;
    if (b.kind === 'camp-shack') {
      const geos = [box(W, Hh, D, 0, Hh / 2, 0, PAINT)];
      // corrugated tin roof sloping back, door, two windows, a porch post or two
      const roof = new THREE.BoxGeometry(W + 0.6, 0.12, D + 1.4); roof.rotateX(0.14); roof.translate(0, Hh + 0.25, 0.3);
      geos.push(prep(roof, (x, y, z, f) => tone(Math.floor((x + 10) * 2.5) % 2 ? TIN : TIN_DARK, 1)));
      geos.push(box(0.9, 1.9, 0.06, -W * 0.2, 0.95, -D / 2 - 0.03, WOOD_DARK));
      for (const sx of [0.15, 0.35]) geos.push(box(0.8, 0.6, 0.06, W * sx, 1.45, -D / 2 - 0.03, 0x4f6470));
      geos.push(box(W + 0.1, 0.25, 0.1, 0, Hh - 0.3, -D / 2 - 0.05, RUST)); // a faded fascia board (no lettering)
      o.add(meshOf(geos));
    } else if (b.kind === 'camp-pump') {
      o.add(meshOf([box(W, Hh * 0.85, D, 0, Hh * 0.42, 0, 0xc0583c), box(W * 0.8, Hh * 0.18, D * 1.02, 0, Hh * 0.9, 0, PAINT), box(W * 0.5, 0.25, 0.04, 0, Hh * 0.62, -D / 2 - 0.02, 0x3e3a36)]));
    } else if (b.kind === 'camp-post') {
      o.add(meshOf([box(W, 3.6, D, 0, 1.8, 0, WOOD)]));
    } else if (b.kind === 'camp-tank') {
      // water tank on a timber stand: four legs, cross braces, a riveted steel drum
      const geos = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) geos.push(box(0.22, 4.0, 0.22, sx * (b.hx - 0.15), 2.0, sz * (b.hz - 0.15), WOOD_DARK));
      for (const sz of [-1, 1]) { const br = new THREE.BoxGeometry(0.1, 0.1, 2.9); br.rotateZ(0.9); br.rotateY(Math.PI / 2); br.translate(0, 1.6, sz * (b.hz - 0.15)); geos.push(prep(br, () => tone(WOOD, 0.9))); }
      geos.push(box(W + 0.4, 0.18, D + 0.4, 0, 4.05, 0, WOOD));
      const drum = new THREE.CylinderGeometry(1.35, 1.35, 2.2, 12); drum.translate(0, 5.25, 0);
      geos.push(prep(drum, (x, y, z, f) => tone(f % 3 ? 0x9a9690 : 0x86827c, 0.85 + 0.2 * clamp01((y - 4) / 2.5))));
      const lid = new THREE.ConeGeometry(1.42, 0.5, 12); lid.translate(0, 6.6, 0); geos.push(prep(lid, () => tone(TIN, 1.05)));
      o.add(meshOf(geos));
    } else if (b.kind === 'camp-trailer') {
      // an old, faded travel trailer on blocks
      const geos = [box(W, Hh - 0.5, D, 0, 0.5 + (Hh - 0.5) / 2, 0, 0xd8d0bc), box(W + 0.04, 0.3, D + 0.04, 0, 1.3, 0, 0x5e8a9a)];
      for (const sz of [-1, 1]) geos.push(box(0.4, 0.5, 0.4, 0, 0.25, sz * D * 0.3, 0x8a7a68));
      geos.push(box(0.04, 0.6, 1.0, -W / 2 - 0.02, 1.7, 0.4, 0x4f6470));
      o.add(meshOf(geos));
    }
    o.userData.camBlock = true; // (src/cam_clear.js keeps the camera out of it)
    g.add(o);
  }
  // canopy roof over the pumps, on the camp-post colliders
  const posts = MAP.PROPS.filter((b) => b.kind === 'camp-post');
  if (posts.length) {
    const cx = posts.reduce((a, b) => a + b.x, 0) / posts.length, cz = posts.reduce((a, b) => a + b.z, 0) / posts.length;
    const y = Math.max(...posts.map((b) => b.y - b.hy)) + 3.6;
    const rf = new THREE.BoxGeometry(6.6, 0.18, 4.4); rf.rotateY(posts[0].rotY); rf.translate(cx, y, cz);
    const roof = new THREE.Mesh(prep(rf, (x, yy, z, f) => tone(f % 4 < 2 ? TIN : TIN_DARK, 1)), propMaterial()); roof.castShadow = true; roof.userData.camBlock = true;
    g.add(roof);
  }
  // a weathered rail fence along the south of the lot (visual, clear of the roads)
  const posts2 = [], rails = [];
  let prev = null;
  for (let a = 0.2; a <= Math.PI - 0.2; a += 2.6 / (th.r + 14)) {
    const x = th.x + Math.cos(a) * (th.r + 14), z = th.z + Math.sin(a) * (th.r + 14);
    const ok = clear(x, z, 1.4);
    const cur = ok ? { x, y: heightAt(x, z), z } : null;
    if (cur) posts2.push(box(0.16, 1.2, 0.16, cur.x, cur.y + 0.5, cur.z, WOOD_DARK));
    if (cur && prev) {
      const dx = cur.x - prev.x, dz = cur.z - prev.z, L = Math.hypot(dx, dz);
      for (const hh of [0.45, 0.9]) { const r = new THREE.BoxGeometry(L + 0.2, 0.1, 0.06); r.rotateZ(Math.atan2(cur.y - prev.y, L)); r.rotateY(-Math.atan2(dz, dx)); r.translate((cur.x + prev.x) / 2, (cur.y + prev.y) / 2 + hh, (cur.z + prev.z) / 2); rails.push(prep(r, () => tone(WOOD, 0.95))); }
    }
    prev = cur;
  }
  if (posts2.length) g.add(meshOf([...posts2, ...rails]));
  return g;
}

// Road signs at the junctions: plank signposts in the shared sign style (src/art/signs.js) naming
// where each track goes.
export function roadSigns({ heightAt, clear }) {
  const g = new THREE.Group(); g.name = 'road-signs';
  for (const sg of MAP.SIGNS ?? []) {
    const road = ROADS.find((r) => r.name === sg.road) || TRAILS.find((r) => r.name === sg.road);
    if (!road) continue;
    const p = pathPoint(road, sg.s < 0 ? road.length + sg.s : sg.s);
    const face = fitFace({ title: sg.title, sub: sg.sub }, { m: 0.05 });
    const side = sg.side ?? 1, off = road.width / 2 + 1.6 + face.w / 2;
    const x = p.x - p.tz * off * side, z = p.z + p.tx * off * side;
    if (!clear(x, z, 0.4)) continue;
    const dir = sg.facing === 'back' ? [p.tx, p.tz] : [-p.tx, -p.tz];
    g.add(signpost(x, z, faceYaw(dir, x, z, p.x, p.z, 0.25), face));
  }
  return g;
}

// Signs at the named places (the dry lake shore, the practice dune, Eagle Point, the dune entry).
export function landmarkSigns({ heightAt }) {
  const g = new THREE.Group(); g.name = 'place-signs';
  for (const pl of MAP.PLACES) {
    if (!pl.sign) continue;
    const [x, z] = pl.sign;
    const face = fitFace({ title: pl.name.split(':')[0], sub: pl.signSub ?? '' }, { m: 0.055 });
    const p = pl;
    g.add(signpost(x, z, Math.atan2(p.x - x, p.z - z), face));
  }
  return g;
}
