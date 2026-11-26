// Set dressing for a map: trees (on the physics tree list), bushes, flowering bushes, grass
// tufts, pebbles, logs, stumps, split-rail fences and wooden arrow signs. Map-agnostic: the
// caller passes a context describing the terrain, so any map module can reuse it.
//
// ctx = {
//   size,                         // world size (m), square, centred on the origin
//   heightAt(x, z),               // visual ground height
//   matAt(x, z),                  // material index (terrain.js MAT)
//   clear(x, z, margin),          // true when (x, z) is at least `margin` m off every drivable path
//   paths: [{ kind, width, pts: [{x, z}] }],   // roads + trails (for along-path scatter / fences)
//   trailhead: { x, z, r } | null,
//   trees: [{ x, y, z, s }],      // trees that already have physics colliders
// }
import * as THREE from 'three';
import { rng, hash } from './props.js';
import {
  instance, variants, roundTreeTemplate, pineTemplate, bushTemplate, logTemplate, stumpTemplate,
  pebbleTemplate, fencePostTemplate, fenceRailTemplate, tuftTemplate,
} from './props.js';
import { assetPartsVariants } from './assets.js';

const GRASS = 0, DIRT = 1, GRAVEL = 5;

// ctx.clear for a terrain baked like terrain.js GRID: `path` holds a path id (>= 0) on every
// cell of a drivable path ((res+1)^2 cells, ix-major); the trailhead lot counts as a path too
export function gridClearance({ size, res, path }, trailhead) {
  const N1 = res + 1, c = size / res;
  return (x, z, margin) => {
    if (trailhead && Math.hypot(x - trailhead.x, z - trailhead.z) < trailhead.r + margin) return false;
    const m = Math.ceil(margin / c), cx = Math.round((x + size / 2) / c), cz = Math.round((z + size / 2) / c);
    for (let dx = -m; dx <= m; dx++) for (let dz = -m; dz <= m; dz++) {
      if (dx * dx + dz * dz > (m + 0.5) * (m + 0.5)) continue;
      const ix = cx + dx, iz = cz + dz;
      if (ix >= 0 && iz >= 0 && ix <= res && iz <= res && path[ix * N1 + iz] >= 0) return false;
    }
    return true;
  };
}

export function buildSetDressing(ctx) {
  const root = new THREE.Group(); root.name = 'dressing';
  const R = rng(9001);
  const lim = ctx.size / 2 - 24;
  const H = (x, z) => ctx.heightAt(x, z);
  const soft = (m) => m === GRASS || m === DIRT;
  // random points: half uniformly over the map, half hugging the paths (where the camera is)
  const sample = (n, margin, okMat, nearFrac = 0.5, maxOff = 16) => {
    const out = [];
    const along = ctx.paths.filter((p) => p.pts.length > 1);
    for (let tries = 0; out.length < n && tries < n * 12; tries++) {
      let x, z;
      if (R() < nearFrac && along.length) {
        const p = along[Math.floor(R() * along.length)], i = Math.floor(R() * (p.pts.length - 1));
        const a = p.pts[i], b = p.pts[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const off = (R() < 0.5 ? -1 : 1) * (p.width / 2 + margin + R() * maxOff);
        x = a.x - ((b.z - a.z) / L) * off; z = a.z + ((b.x - a.x) / L) * off;
      } else { x = (R() * 2 - 1) * lim; z = (R() * 2 - 1) * lim; }
      if (Math.abs(x) > lim || Math.abs(z) > lim) continue;
      if (!okMat(ctx.matAt(x, z)) || !ctx.clear(x, z, margin)) continue;
      out.push({ x, z });
    }
    return out;
  };

  // ---- trees: round deciduous + layered pines, on the collider positions ----
  // (asset names and conventions: docs/MODELING_SPEC.md; glTF props are used at authored size)
  const roundA = assetPartsVariants('tree_round'), pineA = assetPartsVariants('tree_pine');
  const roundV = roundA || [0, 1, 2].map((v) => roundTreeTemplate(v));
  const pineV = pineA || [0, 1].map((v) => pineTemplate(v));
  const roundItems = roundV.map(() => []), pineItems = pineV.map(() => []);
  ctx.trees.forEach((t, i) => {
    const h = hash(i, 7, 1);
    const pine = h < 0.42 + Math.max(0, Math.min(0.3, (t.y - 6) * 0.02));
    const it = { x: t.x, y: t.y - 0.12, z: t.z, ry: hash(i, 3, 2) * Math.PI * 2, s: t.s };
    if (pine) pineItems[i % pineV.length].push({ ...it, s: pineA ? t.s : t.s * 0.95 });
    else roundItems[i % roundV.length].push({ ...it, s: roundA ? t.s : t.s * 0.9 });
  });
  roundV.forEach((tpl, v) => root.add(instance(tpl, roundItems[v], { name: 'trees_round' })));
  pineV.forEach((tpl, v) => root.add(instance(tpl, pineItems[v], { name: 'trees_pine' })));

  // ---- bushes ----
  const bushV = variants('bush', 3, (v) => bushTemplate(false, v));
  const flowerV = variants('bush_flower', 2, (v) => bushTemplate(true, v));
  const bushPts = sample(560, 2.2, soft, 0.6, 14);
  bushPts.forEach((p, i) => {
    const flowering = i % 5 < 2;
    const list = flowering ? flowerV : bushV;
    const tpl = list[i % list.length];
    (tpl.items ||= []).push({ x: p.x, y: H(p.x, p.z) - 0.05, z: p.z, ry: R() * 6.28, s: 0.8 + R() * 0.7, color: flowering ? 0xffffff : [0xffffff, 0xe8ffd8, 0xfff4d0][i % 3] });
  });
  for (const tpl of [...bushV, ...flowerV]) root.add(instance(tpl, tpl.items || [], { name: 'bushes' }));

  // ---- grass tufts (plain + flowering) ----
  // grass_tuft.glb (0.2-0.4 m) replaces the plain sprite tufts; the flowering ones stay procedural
  const tuftA = assetPartsVariants('grass_tuft');
  const tuftV = tuftA || [tuftTemplate(false)], ftuft = tuftTemplate(true);
  const tufts = tuftV.map(() => []), ftufts = [];
  sample(9000, 0.8, (m) => m === GRASS || m === DIRT || m === GRAVEL, 0.65, 18).forEach((p, i) => {
    const m = ctx.matAt(p.x, p.z);
    const it = { x: p.x, y: H(p.x, p.z) - 0.03, z: p.z, ry: R() * 6.28, s: 0.7 + R() * 0.7 };
    if (m === GRASS && R() < 0.2) ftufts.push(it);
    else { it.color = m === GRASS ? 0xffffff : m === DIRT ? 0xe8f0a0 : 0xd8d8a0; if (tuftA) it.s *= 1.2; tufts[i % tuftV.length].push(it); }
  });
  tuftV.forEach((tpl, v) => root.add(instance(tpl, tufts[v], { shadows: false, name: 'tufts' })));
  root.add(instance(ftuft, ftufts, { shadows: false, name: 'flowers' }));

  // ---- decorative stones: rock_small / rock_medium / rock_large.glb, else procedural ----
  const small = assetPartsVariants('rock_small'), medium = assetPartsVariants('rock_medium'), large = assetPartsVariants('rock_large');
  const proc = [0, 1, 2].map((v) => pebbleTemplate(v));
  const stoneTpls = [], stoneItems = [];
  const add = (tpl, it) => { let k = stoneTpls.indexOf(tpl); if (k < 0) { k = stoneTpls.push(tpl) - 1; stoneItems.push([]); } stoneItems[k].push(it); };
  sample(700, 1.0, () => true, 0.6, 10).forEach((p, i) => {
    const r = R(), base = { x: p.x, y: H(p.x, p.z) - 0.04, z: p.z, ry: R() * 6.28, color: [0xffffff, 0xf2e6d0, 0xe0d8cc][i % 3] };
    const size = r < 0.85 ? 'small' : r < 0.97 ? 'medium' : 'large';
    const set = { small, medium, large }[size];
    if (set) add(set[i % set.length], { ...base, s: 0.75 + R() * 0.5 });
    else add(proc[i % 3], { ...base, s: size === 'small' ? 0.4 + R() * 0.6 : size === 'medium' ? 1.4 + R() * 0.6 : 2.6 + R() * 0.8 }); // procedural is 0.7 m wide at s=1
  });
  stoneTpls.forEach((tpl, k) => root.add(instance(tpl, stoneItems[k], { name: 'stones' })));

  // ---- logs + stumps ----
  const logA = assetPartsVariants('log');
  const logV = logA || [logTemplate()], stumpV = variants('stump', 1, stumpTemplate);
  const logs = logV.map(() => []), stumps = stumpV.map(() => []);
  sample(70, 4, soft, 0.5, 14).forEach((p, i) => {
    // the procedural log is unit length along X (stretched); a glTF log is used at its authored ~3 m
    logs[i % logV.length].push({ x: p.x, y: H(p.x, p.z) - 0.06, z: p.z, ry: R() * 6.28, sx: logA ? 1 : 2.2 + R() * 1.6, s: 0.85 + R() * 0.4 });
  });
  sample(90, 3, soft, 0.5, 14).forEach((p, i) => stumps[i % stumpV.length].push({ x: p.x, y: H(p.x, p.z) - 0.05, z: p.z, ry: R() * 6.28, s: 0.7 + R() * 0.6 }));
  logV.forEach((tpl, v) => root.add(instance(tpl, logs[v], { name: 'logs' })));
  stumpV.forEach((tpl, v) => root.add(instance(tpl, stumps[v], { name: 'stumps' })));

  // ---- split-rail fences near the trailhead ----
  root.add(buildFences(ctx));
  // ---- wooden arrow signs at the trailhead ----
  if (ctx.trailhead) root.add(arrowSigns(ctx));
  return root;
}

function buildFences(ctx) {
  const postT = fencePostTemplate(), railT = fenceRailTemplate();
  // fence_segment.glb: 2.0 m along X, origin at the base of its left post, chained end to end
  const fenceAsset = assetPartsVariants('fence_segment'), SPAN = fenceAsset ? 2.0 : 2.5;
  const posts = [], rails = [], sections = [];
  const th = ctx.trailhead;
  const runs = []; // polylines of candidate post positions
  for (const p of ctx.paths.filter((q) => q.kind === 'road')) {
    // measure along the road from the trailhead outwards
    let s = 0;
    for (const side of [-1, 1]) {
      const run = [];
      s = 0;
      for (let i = 1; i < p.pts.length && s < 110; i++) {
        const a = p.pts[i - 1], b = p.pts[i], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        s += L;
        if (th && Math.hypot(a.x - th.x, a.z - th.z) < th.r + 6) continue;
        const off = side * (p.width / 2 + 1.9);
        run.push({ x: a.x - ((b.z - a.z) / L) * off, z: a.z + ((b.x - a.x) / L) * off });
      }
      runs.push(run);
    }
  }
  if (th) { // a fence ring round the trailhead lot, with gaps wherever a road or trail leaves
    const run = [];
    for (let a = 0; a <= Math.PI * 2 + 1e-6; a += 2.5 / (th.r + 5)) run.push({ x: th.x + Math.cos(a) * (th.r + 5), z: th.z + Math.sin(a) * (th.r + 5) });
    runs.push(run);
  }
  for (const run of runs) {
    // resample to the post spacing
    const pts = run.length ? [run[0]] : [];
    let need = SPAN;
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1], b = run[i], L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L > 6) { pts.push(null, b); need = SPAN; continue; } // gap in the run (skipped near the lot)
      let t = 0;
      while (L - t * L >= need) { t += need / L; pts.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }); need = SPAN; }
      need -= L - t * L;
    }
    let prev = null;
    for (const q of pts) {
      const ok = q && ctx.clear(q.x, q.z, 1.4) && ctx.matAt(q.x, q.z) !== 3;
      const y = ok ? ctx.heightAt(q.x, q.z) : 0;
      const cur = ok ? { x: q.x, y, z: q.z } : null;
      if (cur) posts.push({ x: cur.x, y: cur.y - 0.1, z: cur.z, ry: 0 });
      if (cur && prev) {
        const dx = cur.x - prev.x, dz = cur.z - prev.z, dy = cur.y - prev.y, L = Math.hypot(dx, dz);
        if (L < 3.6 && Math.abs(dy) < 1.4) {
          const ry = -Math.atan2(dz, dx), rz = Math.atan2(dy, L), len = Math.hypot(L, dy);
          if (fenceAsset) sections.push({ x: prev.x, y: prev.y - 0.05, z: prev.z, ry, rz, sx: len / 2.0 });
          else for (const h of [0.45, 0.9]) rails.push({ x: (cur.x + prev.x) / 2, y: (cur.y + prev.y) / 2 + h - 0.1, z: (cur.z + prev.z) / 2, ry, rz, sx: len + 0.25 });
        }
      }
      prev = cur;
    }
  }
  const g = new THREE.Group(); g.name = 'fences';
  if (fenceAsset) fenceAsset.forEach((tpl, v) => g.add(instance(tpl, sections.filter((_, i) => i % fenceAsset.length === v))));
  else { g.add(instance(postT, posts)); g.add(instance(railT, rails)); }
  return g;
}

// A couple of wooden fingerposts like the reference art: a post with plank arrows.
function arrowSigns(ctx) {
  const g = new THREE.Group();
  const th = ctx.trailhead;
  const asset = assetPartsVariants('signpost')?.[0]; // signpost.glb: board left blank, long axis along X
  const wood = new THREE.MeshStandardMaterial({ color: 0x9a6a3e, flatShading: true, roughness: 0.9 });
  // just outside the lot, inside the fence ring, wherever it's clear of the paths
  const r = th.r + 2.2, placed = [];
  for (let a = 0.3; a < Math.PI * 2 && placed.length < 3; a += 0.12) {
    const x = th.x + Math.cos(a) * r, z = th.z + Math.sin(a) * r;
    if (!ctx.clear(x, z, 1.5) || placed.some((b) => Math.abs(b - a) < 1.4)) continue;
    placed.push(a);
    const s = new THREE.Group();
    s.position.set(x, ctx.heightAt(x, z) - 0.05, z);
    s.rotation.y = -a + Math.PI / 2;
    if (asset) for (const p of asset) s.add(new THREE.Mesh(p.geometry, p.material));
    else {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.1, 0.16), wood); post.position.y = 1.0; s.add(post);
      for (const [y, dir, len] of [[1.75, 1, 1.0], [1.35, -1, 0.85]]) {
        const shape = new THREE.Shape();
        const h = 0.13;
        shape.moveTo(0, -h); shape.lineTo(len - 0.18, -h); shape.lineTo(len, 0); shape.lineTo(len - 0.18, h); shape.lineTo(0, h); shape.lineTo(0, -h);
        const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false });
        geo.translate(-0.05, 0, -0.03);
        if (dir < 0) geo.rotateY(Math.PI);
        const m = new THREE.Mesh(geo, wood); m.position.y = y; s.add(m);
      }
    }
    s.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.add(s);
  }
  return g;
}
