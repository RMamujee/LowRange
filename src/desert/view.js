// Sunfall Basin (src/maps/desert.js): the desert's own set dressing, landmarks, signs, sky and
// light, and the sand tyre marks. main.js builds it instead of the generic dressing
// (src/art/dressing.js, whose meadow trees, flowering bushes and grass tufts don't belong here).
//
// Everything is procedural low-poly in the src/art style: vertex-coloured, flat-shaded standard
// materials (toon bands, outlines and the pixel detail come from the renderer), instanced in
// spatial chunks so frustum culling works. Plants with colliders sit on the map's tree list
// (generateTrees); everything else is visual only and kept out of every driving line.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MAP, SIZE, RES, GRID, MAT, ROADS, TRAILS, TRAILHEAD, heightAt, visualHeightAt, materialAt, pathPoint } from '../terrain.js';
import { rng, instance, pebbleTemplate } from '../art/props.js';
import { gridClearance } from '../art/dressing.js';
import { fitFace, signpost, faceYaw } from '../art/signs.js';
import { cullBeyond } from '../gfx/pipeline.js';
import { SandMarks } from './sandmarks.js';
import * as P from './props.js';

// Map view hooks (main.js calls those a map's view module has): buildDressing(trees, { scene,
// camera, sun }) returns the 'dressing' root (it also sets the sky, haze and light and shades
// the dunes on the terrain mesh already in the scene); update(camera, t, car, dt) each frame.
let view = null;
export function buildDressing(trees, { scene, camera, sun }) { view = buildDesertView({ scene, camera, trees, sun }); return view.dressing; }
export function update(camera, t, car, dt) { view?.update(car, dt); }
// clear(): a fresh attempt (fresh start, trail restart, spawn-point teleport; main.js calls it
// beside the mud reset, not on a repair in place): the old sand tyre marks go
export function clear() { view?.clearMarks(); }

export function buildDesertView({ scene, camera, trees, sun }) {
  const A = MAP.ATMOS;
  // ---- sky, haze and light: warm, a long clear view ----
  if (scene.fog) { scene.fog.near = A.fog[0]; scene.fog.far = A.fog[1]; scene.fog.color.set(A.haze); }
  camera.far = A.far; camera.updateProjectionMatrix();
  if (sun) { sun.color.set(A.sun); sun.intensity *= A.sunK; }
  scene.traverse((o) => { if (o.isHemisphereLight) { o.color.set(A.sky); o.groundColor.set(A.bounce); } });

  sharpenDuneShading(scene);

  const root = new THREE.Group(); root.name = 'dressing';
  const R = rng(7070);
  const lim = SIZE / 2 - 30;
  const clearGrid = gridClearance({ size: SIZE, res: RES, path: GRID.path }, TRAILHEAD);
  // clear of graded paths (grid) and of the dune route (not on the grid: it follows the sand)
  const dunePaths = TRAILS.filter((t) => !t.graded);
  const clear = (x, z, m) => {
    if (!clearGrid(x, z, m)) return false;
    for (const t of dunePaths) for (let i = 0; i < t.pts.length; i += 3) if (Math.abs(t.pts[i].x - x) < t.width / 2 + m && Math.abs(t.pts[i].z - z) < t.width / 2 + m && Math.hypot(t.pts[i].x - x, t.pts[i].z - z) < t.width / 2 + m) return false;
    return true;
  };
  const H = (x, z) => visualHeightAt(x, z);
  const slope = (x, z) => Math.hypot(heightAt(x + 1.5, z) - heightAt(x - 1.5, z), heightAt(x, z + 1.5) - heightAt(x, z - 1.5)) / 3;
  const scatter = (n, test, tries = 12) => {
    const out = [];
    for (let k = 0; k < n * tries && out.length < n; k++) {
      const x = (R() * 2 - 1) * lim, z = (R() * 2 - 1) * lim;
      if (test(x, z)) out.push({ x, z });
    }
    return out;
  };
  const floor = (m) => m === MAT.DIRT || m === MAT.GRAVEL;

  // ---- big plants on their colliders ----
  const kinds = { cactus: P.cactusTemplates(), yucca: P.yuccaTemplates(), snag: P.snagTemplates() };
  const byKind = { cactus: kinds.cactus.map(() => []), yucca: kinds.yucca.map(() => []), snag: kinds.snag.map(() => []) };
  trees.forEach((t, i) => { const L = byKind[t.kind] || byKind.cactus; L[i % L.length].push({ x: t.x, y: t.y - 0.1, z: t.z, ry: R() * 6.28, s: t.s }); });
  for (const k of Object.keys(kinds)) kinds[k].forEach((tpl, v) => root.add(instance(tpl, byKind[k][v], { name: 'plants' })));

  // ---- small plants: dry shrubs, barrel cacti, tumbleweed bushes, sand grass on the dune edges ----
  const shrubV = [0, 1, 2].map((v) => P.shrubTemplate(v)), barrelV = [P.barrelTemplate(0), P.barrelTemplate(1)], weedV = [P.tumbleweedTemplate()];
  const shrubs = shrubV.map(() => []), barrels = barrelV.map(() => []), weeds = [[]], grass = [];
  scatter(2400, (x, z) => floor(materialAt(x, z)) && slope(x, z) < 0.45 && clear(x, z, 1.6)).forEach((p, i) => {
    const it = { x: p.x, y: H(p.x, p.z) - 0.05, z: p.z, ry: R() * 6.28, s: 0.6 + R() * 0.8 };
    const r = R();
    if (r < 0.12) barrels[i % 2].push({ ...it, s: 0.7 + R() * 0.6 });
    else if (r < 0.24) weeds[0].push({ ...it, s: 0.6 + R() * 0.6 });
    else shrubs[i % 3].push(it);
  });
  // tufts of dry grass where the sand thins out (edges of the sea, washes): not on the deep dunes
  scatter(900, (x, z) => materialAt(x, z) === MAT.SAND && (MAP.sandDepthAt(x, z) < 0.45) && slope(x, z) < 0.3 && clear(x, z, 1.2)).forEach((p) => grass.push({ x: p.x, y: H(p.x, p.z) - 0.04, z: p.z, ry: R() * 6.28, s: 0.7 + R() * 0.7 }));
  shrubV.forEach((tpl, v) => root.add(instance(tpl, shrubs[v], { name: 'bushes' })));
  barrelV.forEach((tpl, v) => root.add(instance(tpl, barrels[v], { name: 'bushes' })));
  root.add(instance(weedV[0], weeds[0], { name: 'bushes' }));
  root.add(instance(P.sandGrassTemplate(), grass, { name: 'tufts', shadows: false }));

  // ---- stones: small loose ones (physics props) near the tracks, a few bigger fixed ones ----
  const stoneV = [0, 1, 2].map((v) => pebbleTemplate(v)), stones = stoneV.map(() => []);
  const along = [...ROADS, ...TRAILS.filter((t) => t.graded)];
  for (let k = 0; k < 900; k++) {
    const p = along[Math.floor(R() * along.length)], s = R() * p.length, q = pathPoint(p, s);
    const lat = (R() < 0.5 ? -1 : 1) * (p.width / 2 + 0.8 + R() * 8), x = q.x - q.tz * lat, z = q.z + q.tx * lat;
    if (!floor(materialAt(x, z)) || !clear(x, z, 0.6)) continue;
    stones[k % 3].push({ x, y: H(x, z) - 0.04, z, ry: R() * 6.28, s: (0.16 + R() * 0.18) / 0.7, color: [0xffffff, 0xf2e2d0, 0xe0d0c4][k % 3] });
  }
  stoneV.forEach((tpl, v) => root.add(instance(tpl, stones[v], { name: 'stones' })));

  // ---- the camp and old fuel stop (Sunfall Station) and other man-made touches ----
  root.add(P.camp(TRAILHEAD, { heightAt: H, clear }));
  root.add(P.roadSigns({ heightAt: H, clear }));
  root.add(P.landmarkSigns({ heightAt: H }));

  calmDistant(root);

  // ---- sand tyre marks ----
  const marks = new SandMarks(scene);
  return {
    dressing: root,
    update(car, dt) { marks.update(car, dt); },
    clearMarks() { marks.clear(); },
  };
}

// Dunes: the shared terrain normals are softened (calm toon bands over hills), which on sand blurs
// a crest and its slip face into one gentle swell. On the sand the shading normals are taken from
// the real surface instead (one cell each way, a light 3-tap smooth along the slope only), so the
// sunlit windward face, the brink and the slip face turned away from the sun fall into different
// toon bands. Geometry is untouched (collider = visual); blended over a cell at the sand's edge.
function sharpenDuneShading(scene) {
  let mesh = null;
  scene.traverse((o) => { if (o.isMesh && o.material?.name === 'pixel_terrain') mesh = o; });
  if (!mesh) return;
  const N1 = RES + 1, cell = SIZE / RES, H = GRID.vis;
  const at = (ix, iz) => H[Math.min(RES, Math.max(0, ix)) * N1 + Math.min(RES, Math.max(0, iz))];
  const sandAt = (ix, iz) => GRID.mat[Math.min(RES, Math.max(0, ix)) * N1 + Math.min(RES, Math.max(0, iz))] === MAT.SAND;
  const pos = mesh.geometry.attributes.position, nrm = mesh.geometry.attributes.normal, v = new THREE.Vector3(), w = new THREE.Vector3();
  // painted dune light, as vertex colours (1 = the ground as it is; the rest of the map stays white):
  // the sand's real slope against the sun and its height over the ground round about, in six calm steps, crests a touch lighter. The sun's
  // direction is main.js SUN_DIR.
  const L = new THREE.Vector3(-0.45, 0.8, 0.35).normalize();
  const col = new Float32Array(pos.count * 3).fill(1);
  const STEPS = [0.8, 0.9, 0.96, 1.03, 1.1, 1.16];
  for (let i = 0; i < pos.count; i++) {
    const ix = Math.round((pos.getX(i) + SIZE / 2) / cell), iz = Math.round((pos.getZ(i) + SIZE / 2) / cell);
    if (!sandAt(ix, iz)) continue;
    {
      // true normal over ±1 cell, its light against a flat patch's, and the height over the
      // ground round about (crest or hollow)
      const n = w.set(at(ix - 1, iz) - at(ix + 1, iz), 2 * cell, at(ix, iz - 1) - at(ix, iz + 1)).normalize();
      const d = n.dot(L) - L.y, h = at(ix, iz);
      const ring = (at(ix + 6, iz) + at(ix - 6, iz) + at(ix, iz + 6) + at(ix, iz - 6) + at(ix + 4, iz + 4) + at(ix - 4, iz - 4) + at(ix + 4, iz - 4) + at(ix - 4, iz + 4)) / 8;
      let f = 1 + 1.4 * d + Math.max(-0.08, Math.min(0.1, (h - ring) * 0.05));
      f = STEPS.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a));
      // eased in over a cell at the sand's edge (flat sand sheets and washes come out at 1 anyway)
      let ke = 0; for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (sandAt(ix + a, iz + b)) ke++;
      f = 1 + (f - 1) * (ke / 4);
      col[i * 3] = f; col[i * 3 + 1] = f * (f < 1 ? 0.97 : 1); col[i * 3 + 2] = f * (f < 1 ? 0.95 : 1); // shade leans warm-violet
    }
    // share of sand round the vertex: full sharpening inside the sand, a blend at its edge
    let k = 0; for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (sandAt(ix + a, iz + b)) k++;
    const dx = (at(ix - 1, iz) - at(ix + 1, iz)) * 0.75 + (at(ix - 1, iz - 1) - at(ix + 1, iz - 1) + at(ix - 1, iz + 1) - at(ix + 1, iz + 1)) * 0.125;
    const dz = (at(ix, iz - 1) - at(ix, iz + 1)) * 0.75 + (at(ix - 1, iz - 1) - at(ix - 1, iz + 1) + at(ix + 1, iz - 1) - at(ix + 1, iz + 1)) * 0.125;
    v.set(dx, 2 * cell, dz).normalize();
    w.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).lerp(v, (k + 1) / 5).normalize();
    nrm.setXYZ(i, w.x, w.y, w.z);
  }
  nrm.needsUpdate = true;
  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  mesh.material.vertexColors = true;
  mesh.material.needsUpdate = true;
}

// Small scatter fades out and is culled with distance by its size (as world_view.js does for the
// Trail Park's scatter), so far fields of shrubs never turn into crawling single pixels.
function calmDistant(root) {
  const clones = new Map();
  root.traverse((o) => {
    if (!o.isInstancedMesh || !o.parent || !['bushes', 'tufts', 'stones'].includes(o.parent.name)) return;
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    const S = 2 * o.geometry.boundingSphere.radius, fade = [90 * S, 150 * S];
    const key = `${o.material.uuid}|${S.toFixed(2)}`;
    if (!clones.has(key)) { const m = o.material.clone(); m.userData.fade = fade; clones.set(key, m); }
    o.material = clones.get(key);
    cullBeyond(o, fade[1]);
  });
}
