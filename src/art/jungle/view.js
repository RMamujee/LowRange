// Coralume Island's view (src/maps/jungle.js): main.js calls these instead of the Trail Park's
// world_view builders when the jungle map is loaded.
//   buildTerrain(scene, camera)  the ground in 128 m chunks with two levels of detail (the island is
//                                 1 km across: one 1 m mesh would be 2 M triangles every frame), the
//                                 sea, the creek and Ember Falls; widens the view distance
//   buildDressing(trees)          jungle trees (instanced near, merged far), undergrowth that thins
//                                 with distance, loose stones; density follows the graphics preset
//   buildMarkers(scene)           trail gates, markers and signposts, junction and place signs,
//                                 bridges, the dock, guard rails, huts, lookout, lighthouse, road paint
//   update(camera, t, car, dt)    level of detail, water animation, and deep-water recovery: returns
//                                 a pose on the nearest road when the truck has been in deep sea
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MAP, SIZE, RES, GRID, MAT, ROADS, TRAILS, DIFF, heightAt, visualHeightAt, pathPoint } from '../../terrain.js';
import { terrainMaterial, softenTerrainNormals, visualSurface } from '../../gfx/terrain_look.js';
import { cullBeyond } from '../../gfx/pipeline.js';
import { getSettings } from '../../settings.js';
import { instance, pebbleTemplate, rng } from '../props.js';
import { fitFace, signpost, bannerBoard, faceYaw, signMaterial } from '../signs.js';
import { baseVertexHeight } from '../../fx/mud_view.js';
import * as P from './plants.js';
import { buildSea, buildCreek, WATER_TIME } from './water.js';
import { buildStructures } from './structures.js';

const quality = () => getSettings().quality;
const DENSITY = { low: 0.45, medium: 0.7, high: 1 };
const LOD_SCALE = { low: 0.6, medium: 0.8, high: 1 };
// casters: instanced chunks that cast shadows; only the ones near the camera are drawn into the
// shadow map (it covers about 28 m round the truck), each chunk would otherwise be drawn whole
const chunks = { terrain: [], trees: [], casters: [] };

// ---------------------------------------------------------------- terrain
const TCH = 128, HI_DIST = 170;
function chunkGeometry(i0, j0, step) {
  const n = TCH / step, N1 = RES + 1, pos = [], idx = [];
  const at = (a, b) => { const ix = Math.min(RES, i0 + a * step), iz = Math.min(RES, j0 + b * step); return [-SIZE / 2 + ix, baseVertexHeight(GRID, N1, ix, iz), -SIZE / 2 + iz]; }; // (inside a bog: the firm floor, fx/mud_view.js draws the mud)
  for (let a = 0; a <= n; a++) for (let b = 0; b <= n; b++) pos.push(...at(a, b));
  const V = (a, b) => a * (n + 1) + b;
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) idx.push(V(a, b), V(a, b + 1), V(a + 1, b), V(a + 1, b), V(a, b + 1), V(a + 1, b + 1));
  // skirts hang 3 m down from every edge, hiding the cracks where a fine chunk meets a coarse one
  const edge = (list) => {
    const base = pos.length / 3;
    list.forEach(([a, b]) => { const [x, y, z] = at(a, b); pos.push(x, y - 3, z); });
    for (let k = 0; k < list.length - 1; k++) {
      const t0 = V(...list[k]), t1 = V(...list[k + 1]), b0 = base + k, b1 = base + k + 1;
      idx.push(t0, b0, t1, t1, b0, b1, t0, t1, b0, t1, b1, b0);
    }
  };
  const r = [...Array(n + 1).keys()];
  edge(r.map((b) => [0, b])); edge(r.map((b) => [n, b])); edge(r.map((a) => [a, 0])); edge(r.map((a) => [a, n]));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
export function buildTerrain(scene, camera) {
  // the island is big and the summit high: see further, haze a little later
  scene.fog.near = 190; scene.fog.far = 860;
  camera.far = 1500; camera.updateProjectionMatrix();
  const root = new THREE.Group(); root.name = 'terrain';
  // jungle floor: the calm visual surface (gfx/terrain_look.js) shows bare earth in big patches,
  // which reads as dry scrub here; under the forest keep it green, earth only on the steeper banks
  const vs = visualSurface({ GRID, RES, SIZE, MAT }), N1 = RES + 1;
  for (let ix = 1; ix < RES; ix++) for (let iz = 1; iz < RES; iz++) {
    const i = ix * N1 + iz;
    if (vs.mat[i] !== MAT.DIRT || vs.dist[i] <= 1.5) continue;
    const sl = Math.hypot(GRID.h[i + N1] - GRID.h[i - N1], GRID.h[i + 1] - GRID.h[i - 1]) / 2;
    if (sl < 0.55) vs.mat[i] = MAT.GRASS;
  }
  const mat = terrainMaterial({ GRID, RES, SIZE, NROADS: ROADS.length, MAT });
  for (let i = 0; i < RES; i += TCH) for (let j = 0; j < RES; j += TCH) {
    // chunks that are all deep sea floor only ever need the coarse mesh
    let top = -Infinity;
    for (let a = 0; a <= TCH; a += 8) for (let b = 0; b <= TCH; b += 8) top = Math.max(top, GRID.vis[Math.min(RES, i + a) * (RES + 1) + Math.min(RES, j + b)]);
    const lo = new THREE.Mesh(chunkGeometry(i, j, 4), mat), hi = top > -3 ? new THREE.Mesh(chunkGeometry(i, j, 1), mat) : null;
    for (const m of [lo, hi]) if (m) { m.receiveShadow = true; root.add(m); }
    if (hi) hi.visible = false;
    chunks.terrain.push({ hi, lo, x0: -SIZE / 2 + i, z0: -SIZE / 2 + j, x1: -SIZE / 2 + i + TCH, z1: -SIZE / 2 + j + TCH });
  }
  // softened shading normals (gfx/terrain_look.js), computed once over every chunk's vertices
  // together: the softening blurs the whole heightfield, so once per chunk would cost seconds
  const meshes = root.children.filter((m) => m.isMesh), n = meshes.reduce((a, m) => a + m.geometry.attributes.position.count, 0);
  const all = new THREE.BufferGeometry(), pos = new Float32Array(n * 3);
  let o = 0;
  for (const m of meshes) { pos.set(m.geometry.attributes.position.array, o); o += m.geometry.attributes.position.array.length; }
  all.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  all.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  softenTerrainNormals(all, { GRID, RES, SIZE, MAT });
  o = 0;
  for (const m of meshes) { const a = m.geometry.attributes.normal.array; a.set(all.attributes.normal.array.subarray(o, o + a.length)); o += a.length; m.geometry.attributes.normal.needsUpdate = true; }
  root.add(buildSea(), buildCreek());
  return root;
}
const rectDist = (c, p) => Math.hypot(Math.max(c.x0 - p.x, 0, p.x - c.x1), Math.max(c.z0 - p.z, 0, p.z - c.z1));

// ---------------------------------------------------------------- dressing
const KINDS = {
  palm: { hi: [0, 1].map((v) => P.palmTemplate(v)), lo: [0, 1].map((v) => P.palmLo(v)) },
  broad: { hi: [0, 1, 2].map((v) => P.broadleafTemplate(v)), lo: [0, 1, 2].map((v) => P.broadleafLo(v)) },
  giant: { hi: [P.broadleafTemplate(0, true)], lo: [P.broadleafLo(0, true)] },
};
const TREE_CH = 96, TREE_HI = 170;
export function buildDressing(trees) {
  const root = new THREE.Group(); root.name = 'dressing';
  const dens = DENSITY[quality()] ?? 1;
  const vs = visualSurface({ GRID, RES, SIZE, MAT });
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  // ---- trees: per 96 m chunk, instanced templates near, one merged mesh far ----
  const bins = new Map();
  trees.forEach((t, i) => {
    const k = `${Math.floor(t.x / TREE_CH)},${Math.floor(t.z / TREE_CH)}`;
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push({ ...t, v: i, ry: ((i * 2654435761) % 6283) / 1000 });
  });
  const treeRoot = new THREE.Group(); treeRoot.name = 'trees_jungle';
  for (const [key, list] of bins) {
    const [cx, cz] = key.split(',').map(Number);
    const hi = new THREE.Group(), loGeos = [];
    for (const kind of Object.keys(KINDS)) {
      const K = KINDS[kind];
      K.hi.forEach((tpl, v) => {
        const items = list.filter((t) => t.kind === kind && t.v % K.hi.length === v).map((t) => ({ x: t.x, y: t.y - 0.15, z: t.z, ry: t.ry, s: t.s }));
        if (!items.length) return;
        hi.add(instance(tpl, items, { chunk: 1e6, name: 'trees_' + kind }));
        for (const it of items) {
          _q.setFromEuler(_e.set(0, it.ry, 0));
          _m.compose(_p.set(it.x, it.y, it.z), _q, _s.set(it.s, it.s, it.s));
          loGeos.push(K.lo[v].clone().applyMatrix4(_m));
        }
      });
    }
    const lo = new THREE.Mesh(mergeGeometries(loGeos), P.palmTemplate(0)[0].material);
    lo.castShadow = false; lo.receiveShadow = true;
    hi.visible = false;
    treeRoot.add(hi, lo);
    chunks.trees.push({ hi, lo, x0: cx * TREE_CH, z0: cz * TREE_CH, x1: (cx + 1) * TREE_CH, z1: (cz + 1) * TREE_CH });
  }
  root.add(treeRoot);

  // ---- undergrowth: sampled half near the paths (where the camera is) and half anywhere inland ----
  const R = rng(5150);
  const paths = [...ROADS, ...TRAILS];
  const clear = MAP.clearOfPaths;
  const soft = (x, z) => { const m = vs.materialAt(x, z); return m === MAT.GRASS || m === MAT.DIRT; };
  const sample = (n, margin, ok, nearFrac, maxOff) => {
    const out = [];
    for (let tries = 0; out.length < n && tries < n * 14; tries++) {
      let x, z;
      if (R() < nearFrac) {
        const p = paths[Math.floor(R() * paths.length)], i = Math.floor(R() * (p.pts.length - 1)), a = p.pts[i], b = p.pts[i + 1];
        const L = Math.hypot(b.x - a.x, b.z - a.z) || 1, off = (R() < 0.5 ? -1 : 1) * (p.width / 2 + margin + R() * maxOff);
        x = a.x - ((b.z - a.z) / L) * off; z = a.z + ((b.x - a.x) / L) * off;
      } else { x = (R() * 2 - 1) * 410; z = (R() * 2 - 1) * 410; }
      if (MAP.inland(x, z) < 6 || heightAt(x, z) < 0.6 || !ok(x, z) || !clear(x, z, margin)) continue;
      out.push({ x, z });
    }
    return out;
  };
  const scatter = (name, templates, pts, scale, fade, opts = {}) => {
    const per = templates.map(() => []);
    pts.forEach((p, i) => per[i % templates.length].push({ x: p.x, y: visualHeightAt(p.x, p.z) - 0.05, z: p.z, ry: R() * 6.283, s: scale[0] + R() * (scale[1] - scale[0]), color: opts.tint ? opts.tint[i % opts.tint.length] : undefined }));
    const g = new THREE.Group(); g.name = name;
    templates.forEach((tpl, v) => {
      const grp = instance(tpl, per[v], { chunk: 100, name, shadows: opts.shadows !== false });
      grp.traverse((o) => {
        if (!o.isInstancedMesh) return;
        const key = o.material.uuid + name;
        o.material = (scatter.mats[key] ||= Object.assign(o.material.clone(), { userData: { ...o.material.userData, fade } }));
        cullBeyond(o, fade[1]);
      });
      g.add(...grp.children);
    });
    root.add(g);
  };
  scatter.mats = {};
  const tint = [0xffffff, 0xe8f4d8, 0xf4f0d0, 0xdcecd0];
  scatter('ferns', [0, 1].map((v) => P.fernTemplate(v)), sample(Math.round(9000 * dens), 1.2, soft, 0.5, 16), [0.8, 1.5], [120, 190], { tint, shadows: false });
  scatter('bushes', [0, 1].map((v) => P.shrubTemplate(v)), sample(Math.round(2600 * dens), 1.8, soft, 0.6, 12), [0.8, 1.6], [170, 260], { tint });
  scatter('bananas', [0].map((v) => P.bananaTemplate(v)), sample(Math.round(1300 * dens), 2.2, (x, z) => soft(x, z) && MAP.inland(x, z) < 160, 0.55, 14), [0.8, 1.3], [170, 260]);
  scatter('hibiscus', [0, 1].map((v) => P.shrubTemplate(v, true)), sample(Math.round(500 * dens), 2.0, soft, 0.7, 8), [0.7, 1.1], [120, 190]);
  scatter('tufts', [0].map((v) => P.groundPlantTemplate(v)), sample(Math.round(7000 * dens), 0.7, soft, 0.75, 10), [0.8, 1.5], [55, 95], { tint, shadows: false });
  // ---- small loose stones (physical props, src/physics_props.js) on the crawls and the dirt verges ----
  const stones = [], proc = [0, 1, 2].map((v) => pebbleTemplate(v));
  for (const t of TRAILS) for (let s = 10; s < t.length - 8; s += 6 + R() * 7) {
    const p = pathPoint(t, s), lat = (R() < 0.5 ? -1 : 1) * t.width / 2 * (0.35 + R() * 0.6), x = p.x - p.tz * lat, z = p.z + p.tx * lat;
    if (MAP.materialAt(x, z) === MAT.WATER) continue;
    stones.push({ x, y: visualHeightAt(x, z) - 0.03, z, ry: R() * 6.28, s: (0.16 + R() * 0.18) / 0.7, color: 0x9a948c });
  }
  const sg = new THREE.Group(); sg.name = 'stones';
  proc.forEach((tpl, v) => sg.add(...instance(tpl, stones.filter((_, i) => i % 3 === v), { name: 'stones' }).children));
  root.add(sg);
  root.traverse((o) => { if (o.isInstancedMesh && o.castShadow) { if (!o.boundingSphere) o.computeBoundingSphere(); chunks.casters.push(o); } });
  return root;
}

// ---------------------------------------------------------------- markers, signs, structures
const SIGN_M = 0.05, BANNER_M = 0.07;
function gate(path, atEnd) {
  const p = pathPoint(path, atEnd ? path.length - 3 : 3);
  const g = new THREE.Group();
  g.position.set(p.x, heightAt(p.x, p.z), p.z);
  g.rotation.y = Math.atan2(p.tx, p.tz);
  const col = path.diff === 'green' || path.diff === 'blue' ? DIFF[path.diff].hex : 0x2b2b2b;
  const mat = new THREE.MeshStandardMaterial({ color: col, flatShading: true });
  const hw = path.width / 2 + 0.9;
  // START from outside the trail, FINISH from inside it (as world_view.js gate)
  const fit = (sub) => fitFace({ title: path.name, sub, diff: path.diff, frame: 2 }, { m: BANNER_M, minW: hw * 2 + 0.4, maxW: hw * 2 + 2.4 });
  const face = fit('START'), back = fit('FINISH');
  const y0 = 2.7;
  for (const sx of [-hw, hw]) {
    const gy = heightAt(p.x - p.tz * -sx, p.z + p.tx * -sx) - g.position.y;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, y0 + 0.4 - gy, 0.25), mat);
    post.position.set(sx, (y0 + 0.4 + gy) / 2 - 0.4, 0); post.castShadow = true; g.add(post);
    // amber lamp caps: main.js / world_view setGateDone turns them green when the trail is done
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.4), new THREE.MeshStandardMaterial({ color: 0xffb340, emissive: 0x553300 }));
    cap.position.set(sx, y0 + face.h + 0.15, 0); g.add(cap);
  }
  const banner = bannerBoard(face);
  banner.position.y = y0 + face.h / 2;
  g.add(banner);
  const inside = banner.children.find((o) => o.isMesh && o.geometry.type === 'PlaneGeometry' && (o.position.z > 0) === !atEnd);
  inside.material = signMaterial(back.texture);
  banner.userData.material.name = 'gate-start'; inside.material.name = 'gate-finish';
  return g;
}
export function buildMarkers(scene) {
  const postG = new THREE.BoxGeometry(0.12, 1.1, 0.12), m4 = new THREE.Matrix4();
  // trail marker posts with the difficulty colour, alternating sides
  for (const t of TRAILS) {
    const pts = [];
    let side = 1;
    for (let s = 8; s < t.length - 5; s += 11) {
      const p = pathPoint(t, s), off = (t.width / 2 + 0.9) * side; side = -side;
      const x = p.x - p.tz * off, z = p.z + p.tx * off;
      if (MAP.materialAt(x, z) === MAT.WATER) continue;
      pts.push([x, heightAt(x, z), z]);
    }
    const posts = new THREE.InstancedMesh(postG, new THREE.MeshStandardMaterial({ color: 0x6b5a44 }), pts.length);
    const topCol = t.diff === 'green' || t.diff === 'blue' ? DIFF[t.diff].hex : 0x111111;
    const tops = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.25, 0.2), new THREE.MeshStandardMaterial({ color: topCol }), pts.length);
    pts.forEach(([x, y, z], i) => { m4.makeTranslation(x, y + 0.55, z); posts.setMatrixAt(i, m4); m4.makeTranslation(x, y + 1.2, z); tops.setMatrixAt(i, m4); });
    scene.add(posts, tops);
  }
  // gates + signposts at both trail ends (order: start0, end0, start1, end1, ... as main.js expects)
  const gates = [];
  for (const t of TRAILS) for (const atEnd of [false, true]) {
    const p = pathPoint(t, atEnd ? t.length - 1.5 : 1.5);
    const face = fitFace({ title: t.name, sub: `${DIFF[t.diff].label} · ${t.length.toFixed(0)} m`, diff: t.diff, maxTitleW: 60 }, { m: SIGN_M });
    const side = t.width / 2 + 0.9 + 0.6 + face.w / 2, sx = p.x - p.tz * side, sz = p.z + p.tx * side;
    const dir = atEnd ? [p.tx, p.tz] : [-p.tx, -p.tz];
    scene.add(signpost(sx, sz, faceYaw(dir, sx, sz, p.x, p.z, 0.2), face));
    const gt = gate(t, atEnd); scene.add(gt); gates.push(gt);
  }
  // road junction signs: where a road or crawl leaves another road, a board naming it
  const named = new Set();
  for (const r of [...ROADS, ...TRAILS]) {
    if (r.closed || r.surface === 'sand' && r.name !== 'Crescent Beach' && r.name !== 'Sunrise Beach') continue;
    for (const end of [0, 1]) {
      const q = end ? r.pts.at(-1) : r.pts[0], host = ROADS.find((h) => h !== r && h.pts.some((pt) => Math.hypot(pt.x - q.x, pt.z - q.z) < h.width / 2 + 2));
      if (!host || named.has(r.name + end) || r.kind === 'trail') continue;
      named.add(r.name + end);
      const p = pathPoint(r, end ? r.length - 9 : 9), side = r.width / 2 + 1.6, sx = p.x - p.tz * side, sz = p.z + p.tx * side;
      if (!MAP.clearOfPaths(sx, sz, 0.6)) continue;
      const face = fitFace({ title: r.name, sub: r.surface === 'paved' ? 'Paved' : r.surface === 'track' ? '4x4 track' : r.surface === 'sand' ? 'Beach' : 'Dirt road' }, { m: SIGN_M });
      scene.add(signpost(sx, sz, faceYaw(end ? [p.tx, p.tz] : [-p.tx, -p.tz], sx, sz, p.x, p.z, 0.25), face));
    }
  }
  // place signs
  const place = (x, z, yaw, title, sub) => scene.add(signpost(x, z, yaw, fitFace({ title, sub }, { m: 0.06 })));
  const V = MAP.VILLAGE, back = Math.atan2(-V.z, -V.x), vx = V.x + Math.cos(back) * (V.r - 1.5), vz = V.z + Math.sin(back) * (V.r - 1.5);
  place(vx, vz, Math.atan2(V.x - vx, V.z - vz), 'Palm Cove', 'Coralume Island');
  const S = MAP.SUMMIT_LOT; place(S.x + 6, S.z + 6, Math.atan2(S.x - MAP.PEAK.x, S.z - MAP.PEAK.z), 'Summit Viewpoint', `${S.h.toFixed(0)} m`);
  const Rm = MAP.RIM; place(Rm.x + 3, Rm.z + 3, Math.atan2(MAP.PEAK.x - Rm.x, MAP.PEAK.z - Rm.z) + Math.PI, 'Crater Rim', `${Rm.h.toFixed(0)} m`);
  scene.add(buildStructures());
  return gates;
}

// ---------------------------------------------------------------- per frame
let wet = 0, last = 0;
export function update(camera, t, car, dt = 1 / 60) {
  WATER_TIME.value = t;
  const p = camera.position, k = LOD_SCALE[quality()] ?? 1;
  for (const c of chunks.terrain) if (c.hi) { const near = rectDist(c, p) < HI_DIST * k; c.hi.visible = near; c.lo.visible = !near; }
  for (const c of chunks.trees) { const near = rectDist(c, p) < TREE_HI * k; c.hi.visible = near; c.lo.visible = !near; }
  for (const m of chunks.casters) m.castShadow = m.boundingSphere.center.distanceTo(p) - m.boundingSphere.radius < 40;
  // deep water: the sea is the edge of the map. Wading is fine; once the cab is under for a moment,
  // the truck is recovered to the nearest road, facing along it
  if (!car) return null;
  const q = car.chassis.translation(), depth = MAP.SEA.y - heightAt(q.x, q.z);
  wet = depth > 1.15 && q.y < MAP.SEA.y + 0.35 ? wet + dt : 0;
  if (wet < 1.0 || t - last < 2) return null;
  wet = 0; last = t;
  return MAP.towTarget(q.x, q.z); // (main.js places it like a spawn point)
}
