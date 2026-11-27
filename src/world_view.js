// Low-poly rendering of the active map: terrain, rocks, trees and the minimap, plus the
// trail park's road/trail markers, signposts and start/finish gates. The race track's
// dressing lives in race_view.js.
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SIZE, RES, MAT, MAT_INFO, GRID, fbm, heightAt, visualHeightAt, materialAt, ROADS, TRAILS, DIFF, TRAILHEAD, TRACK, CHECKPOINTS, pathPoint, MAP_NAME } from './terrain.js';
import { buildSetDressing, gridClearance } from './art/dressing.js';
import { terrainMaterial, rockMaterial, shapeRockGeometry, softenTerrainNormals, visualSurface } from './gfx/terrain_look.js';
import { BACKDROP } from './gfx/palette.js';
import { cullBeyond } from './gfx/pipeline.js';
import { fitFace, signpost, bannerBoard, faceYaw, signMaterial } from './art/signs.js';
import { baseVertexHeight } from './fx/mud_view.js'; // [tyre fx]
const NROADS = ROADS.length;

export function buildTerrainMesh() {
  const n = RES, N1 = n + 1;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, n, n);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const ix = Math.round((x + SIZE / 2) / (SIZE / n)), iz = Math.round((z + SIZE / 2) / (SIZE / n));
    const g = ix * N1 + iz;
    pos.setY(i, baseVertexHeight(GRID, N1, ix, iz)); // [tyre fx] inside the bogs: the firm floor (fx/mud_view.js draws the mud)
    const m = GRID.mat[g];
    const base = MAT_INFO[m].color;
    let v = 0.86 + fbm(x * 0.35, z * 0.35, 2) * 0.12 + (Math.random() - 0.5) * 0.05;
    if (m === MAT.ROAD || m === MAT.TARMAC) v =0.92 + fbm(x * 0.6, z * 0.6, 2) * 0.06; // smoother graded surface
    if (GRID.path[g] >= NROADS && m !== MAT.MUD) v *= 0.8; // worn, darker trail tread
    c.setRGB(base[0] * v, base[1] * v, base[2] * v);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  softenTerrainNormals(geo, { GRID, RES, SIZE, MAT });
  // pixel-art ground (src/gfx/terrain_look.js): GRID.mat on the paths, a calm visual surface off
  // them, softened normals so the toon bands follow the hills; the vertex colours above are kept
  // for anything that reads them
  const mesh = new THREE.Mesh(geo, terrainMaterial({ GRID, RES, SIZE, NROADS, MAT }));
  mesh.receiveShadow = true;
  return mesh;
}

// Distant ranges beyond the map edge: three rings of soft mountain silhouettes, flat colours that
// step from hill green towards the sky, nearest to farthest (no lighting, no fog, no outlines),
// so the horizon reads as painted layers of hills behind hills with clean value steps.
export function buildBackdrop() {
  const g = new THREE.Group(); g.name = 'backdrop';
  const LAYERS = [
    { r: SIZE * 0.78, top: 38, amp: 34, f: 2.2, seed: 3, col: BACKDROP[0] },
    { r: SIZE * 1.08, top: 62, amp: 42, f: 1.7, seed: 11, col: BACKDROP[1] },
    { r: SIZE * 1.45, top: 92, amp: 50, f: 1.3, seed: 23, col: BACKDROP[2] },
  ];
  const SEG = 240;
  for (const L of LAYERS) {
    const pos = [];
    const prof = (i) => {
      const a = (i / SEG) * Math.PI * 2, cx = Math.cos(a) * L.f, cz = Math.sin(a) * L.f;
      const n = fbm(cx + L.seed, cz - L.seed, 3) * 0.7 + (1 - Math.abs(fbm(cx * 2.3 - L.seed, cz * 2.3, 2))) * 0.3;
      return [Math.cos(a) * L.r, L.top + n * L.amp, Math.sin(a) * L.r];
    };
    for (let i = 0; i < SEG; i++) {
      const [x0, y0, z0] = prof(i), [x1, y1, z1] = prof(i + 1);
      pos.push(x0, -40, z0, x1, -40, z1, x1, y1, z1, x0, -40, z0, x1, y1, z1, x0, y0, z0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: L.col, fog: false, side: THREE.DoubleSide }));
    m.frustumCulled = false;
    g.add(m);
  }
  return g;
}

export function buildRocks(rocks) {
  const geos = [];
  for (const r of rocks) {
    const pts = [];
    for (let i = 0; i < r.pts.length; i += 3) pts.push(new THREE.Vector3(r.pts[i], r.pts[i + 1], r.pts[i + 2]));
    let g;
    try { g = new ConvexGeometry(pts); } catch { continue; }
    g.rotateY(r.rotY);
    g.translate(r.x, r.y, r.z);
    // same hull, pixel-art skin: welded smooth normals + lit-top/dark-base tone (src/gfx/terrain_look.js)
    geos.push(shapeRockGeometry(g, r.ledge, geos.length));
  }
  const mesh = new THREE.Mesh(mergeGeometries(geos), rockMaterial());
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

// trees (on their physics colliders) plus all the decorative set dressing (src/art/dressing.js);
// bushes and tufts follow the surface the ground shows, so green slopes get the bushes
export function buildTrees(trees) {
  const root = buildSetDressing({
    size: SIZE, heightAt: visualHeightAt, matAt: visualSurface({ GRID, RES, SIZE, MAT }).materialAt, trees,
    clear: gridClearance({ size: SIZE, res: RES, path: GRID.path }, TRAILHEAD),
    paths: [...ROADS, ...TRAILS], trailhead: TRAILHEAD,
  });
  calmDistantDetail(root);
  return root;
}

// Eye comfort at a distance (see gfx/toon.js fadePatch, gfx/pipeline.js cullBeyond): small
// scatter (tufts, flowers, stones, bushes) thins out with distance, each kind by its size, so
// nothing is drawn once it would be only two or three pixels big (sub-pixel things only crawl);
// chunks past the far end are skipped outright.
const SCATTER = new Set(['tufts', 'flowers', 'stones', 'bushes']);
function calmDistantDetail(root) {
  const clones = new Map();
  root.traverse((o) => {
    if (!o.isInstancedMesh || !o.parent || !SCATTER.has(o.parent.name)) return;
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    const S = 2 * o.geometry.boundingSphere.radius; // size in metres (instances are scaled about 0.7 to 1.4)
    const fade = [90 * S, 150 * S];
    // (the glTF props share one atlas material: each size gets its own copy)
    const key = `${o.material.uuid}|${S.toFixed(2)}`;
    if (!clones.has(key)) { const m = o.material.clone(); m.userData.fade = fade; clones.set(key, m); }
    o.material = clones.get(key);
    cullBeyond(o, fade[1]);
  });
}

// difficulty symbol drawn on a 2D canvas
function drawDiffSymbol(ctx, diff, x, y, r) {
  ctx.fillStyle = DIFF[diff].color;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = r * 0.12;
  const diamond = (cx) => { ctx.beginPath(); ctx.moveTo(cx, y - r); ctx.lineTo(cx + r, y); ctx.lineTo(cx, y + r); ctx.lineTo(cx - r, y); ctx.closePath(); ctx.fill(); ctx.stroke(); };
  if (diff === 'green') { ctx.beginPath(); ctx.arc(x, y, r * 0.85, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  else if (diff === 'blue') { ctx.fillRect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6); ctx.strokeRect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6); }
  else if (diff === 'black') diamond(x);
  else { diamond(x - r * 0.75); diamond(x + r * 0.75); }
}

// Sign faces (src/art/signs.js): pixel-font text, dark ink on parchment, sized around the words.
const SIGN_M = 0.05;   // trail signposts: metres per sign pixel (title caps 0.35 m)
const BANNER_M = 0.07; // gate banners (title caps 0.49 m)

// start / finish arch across a trail: a two-faced banner with the trail's name, resting on the
// posts (which stop at its lower edge, so they never cross the letters from either side)
function gate(path, atEnd) {
  const p = pathPoint(path, atEnd ? path.length - 3 : 3);
  const g = new THREE.Group();
  g.position.set(p.x, heightAt(p.x, p.z), p.z);
  g.rotation.y = Math.atan2(p.tx, p.tz);
  const col = DIFF[path.diff].hex === 0x000000 || DIFF[path.diff].hex === 0x1a1a1a ? 0x2b2b2b : DIFF[path.diff].hex;
  const mat = new THREE.MeshStandardMaterial({ color: col, flatShading: true });
  const hw = path.width / 2 + 0.9;
  // one big line; the banner may overhang the posts a little rather than shrink the letters
  // a run starts at whichever gate you drive in through, so every gate reads START from outside the
  // trail and FINISH from inside it (the far end used to greet its spawn point with FINISH)
  const fit = (sub) => fitFace({ title: path.name, sub, diff: path.diff, frame: 2 }, { m: BANNER_M, minW: hw * 2 + 0.4, maxW: hw * 2 + 2.4 });
  const face = fit('START'), back = fit('FINISH');
  const y0 = 2.7; // banner's lower edge
  for (const sx of [-hw, hw]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, y0 + 0.4, 0.25), mat);
    post.position.set(sx, (y0 - 0.4) / 2, 0); post.castShadow = true; g.add(post);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.4), new THREE.MeshStandardMaterial({ color: 0xffb340, emissive: 0x553300 }));
    cap.position.set(sx, y0 + face.h + 0.15, 0); g.add(cap);
  }
  const banner = bannerBoard(face);
  // the group's +z points along the trail: into it at the start, out of it at the far end; the
  // +z plane is seen from the side +z points to
  const inside = banner.children.find((o) => o.isMesh && o.geometry.type === 'PlaneGeometry' && (o.position.z > 0) === !atEnd);
  inside.material = signMaterial(back.texture);
  banner.userData.material.name = 'gate-start'; inside.material.name = 'gate-finish'; // for test/browser-qa.mjs
  banner.position.y = y0 + face.h / 2;
  g.add(banner);
  return g;
}

export function buildMarkers(scene) {
  const postG = new THREE.BoxGeometry(0.12, 1.1, 0.12);
  // road edge posts: white with a red reflector
  const roadPts = [];
  for (const r of ROADS) for (let s = 4; s < r.length; s += 18) {
    const p = pathPoint(r, s);
    for (const side of [-1, 1]) {
      const off = (r.width / 2 + 0.8) * side;
      const x = p.x - p.tz * off, z = p.z + p.tx * off;
      if (Math.hypot(x - TRAILHEAD.x, z - TRAILHEAD.z) < TRAILHEAD.r + 3) continue;
      roadPts.push([x, heightAt(x, z), z]);
    }
  }
  const white = new THREE.InstancedMesh(postG, new THREE.MeshStandardMaterial({ color: 0xf2f2ee }), roadPts.length);
  const refl = new THREE.InstancedMesh(new THREE.BoxGeometry(0.13, 0.16, 0.13), new THREE.MeshStandardMaterial({ color: 0xff3b2f, emissive: 0x661008 }), roadPts.length);
  const m = new THREE.Matrix4();
  roadPts.forEach(([x, y, z], i) => { m.makeTranslation(x, y + 0.55, z); white.setMatrixAt(i, m); m.makeTranslation(x, y + 0.95, z); refl.setMatrixAt(i, m); });
  white.castShadow = true;
  scene.add(white, refl);
  // trail markers: posts topped with the difficulty colour, alternating sides
  for (const t of TRAILS) {
    const pts = [];
    let side = 1;
    for (let s = 8; s < t.length - 5; s += 11) {
      const p = pathPoint(t, s);
      const off = (t.width / 2 + 0.9) * side; side = -side;
      const x = p.x - p.tz * off, z = p.z + p.tx * off;
      pts.push([x, heightAt(x, z), z]);
    }
    const posts = new THREE.InstancedMesh(postG, new THREE.MeshStandardMaterial({ color: 0x6b5a44 }), pts.length);
    const topCol = t.diff === 'green' || t.diff === 'blue' ? DIFF[t.diff].hex : 0x111111;
    const tops = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.25, 0.2), new THREE.MeshStandardMaterial({ color: topCol, emissive: t.diff === 'blue' ? 0x0a2040 : t.diff === 'green' ? 0x0a300f : 0x000000 }), pts.length);
    pts.forEach(([x, y, z], i) => { m.makeTranslation(x, y + 0.55, z); posts.setMatrixAt(i, m); m.makeTranslation(x, y + 1.2, z); tops.setMatrixAt(i, m); });
    scene.add(posts, tops);
  }
  // signposts + gates at both trail ends
  const gates = [];
  for (const t of TRAILS) {
    for (const atEnd of [false, true]) {
      // the signpost stands just outside the gate's post and a step in front of it (behind the
      // gate it was hidden by the post from the approach), toed in a little towards the trail
      const p = pathPoint(t, atEnd ? t.length - 1.5 : 1.5);
      const face = fitFace({ title: t.name, sub: `${DIFF[t.diff].label} · ${(t.length).toFixed(0)} m`, diff: t.diff, maxTitleW: 60 }, { m: SIGN_M });
      const side = t.width / 2 + 0.9 + 0.6 + face.w / 2;
      const sx = p.x - p.tz * side, sz = p.z + p.tx * side;
      const dir = atEnd ? [p.tx, p.tz] : [-p.tx, -p.tz];
      scene.add(signpost(sx, sz, faceYaw(dir, sx, sz, p.x, p.z, 0.2), face));
      const gt = gate(t, atEnd); scene.add(gt); gates.push(gt);
    }
  }
  // trailhead sign
  scene.add(signpost(TRAILHEAD.x + 6, TRAILHEAD.z - 10, Math.PI * 0.85, fitFace({ title: 'LOW RANGE', sub: `${MAP_NAME} · Trailhead` }, { m: 0.06 })));
  return gates;
}

// Minimap: hill-shaded terrain with roads and trails drawn on top.
export function buildMinimapBase(size = 220) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const N1 = RES + 1;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const ix = Math.min(RES - 1, Math.floor((px / size) * RES)), iz = Math.min(RES - 1, Math.floor((py / size) * RES));
    const g = ix * N1 + iz;
    const dh = (GRID.h[g + N1] - GRID.h[g]) - (GRID.h[g + 1] - GRID.h[g]);
    const shade = Math.max(0.35, Math.min(1.2, 0.85 + dh * 0.35));
    const c = MAT_INFO[GRID.mat[g]].color;
    const o = (py * size + px) * 4;
    img.data[o] = c[0] * 255 * shade; img.data[o + 1] = c[1] * 255 * shade; img.data[o + 2] = c[2] * 255 * shade; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const toPx = (x) => ((x + SIZE / 2) / SIZE) * size;
  const stroke = (path, color, w) => {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.beginPath();
    path.pts.forEach((p, i) => (i ? ctx.lineTo(toPx(p.x), toPx(p.z)) : ctx.moveTo(toPx(p.x), toPx(p.z))));
    ctx.stroke();
  };
  for (const r of ROADS) { stroke(r, 'rgba(0,0,0,.5)', 5); stroke(r, '#f4ead2', 3); }
  for (const t of TRAILS) { stroke(t, '#fff', 4); stroke(t, t.diff === 'dblack' || t.diff === 'black' ? '#111' : DIFF[t.diff].color, 2.5); }
  for (const t of TRAILS) { const p = t.pts[0]; drawDiffSymbol(ctx, t.diff, toPx(p.x), toPx(p.z), 5); }
  if (TRAILHEAD) { ctx.fillStyle = '#ffb340'; ctx.beginPath(); ctx.arc(toPx(TRAILHEAD.x), toPx(TRAILHEAD.z), 5, 0, Math.PI * 2); ctx.fill(); }
  if (TRACK) {
    stroke(TRACK, 'rgba(0,0,0,.55)', 8); stroke(TRACK, '#d9c7a6', 5);
    // start / finish line and numbered checkpoints
    const c0 = CHECKPOINTS[0], hw = TRACK.width / 2 + 3;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath();
    ctx.moveTo(toPx(c0.x + c0.tz * hw), toPx(c0.z - c0.tx * hw)); ctx.lineTo(toPx(c0.x - c0.tz * hw), toPx(c0.z + c0.tx * hw)); ctx.stroke();
    ctx.font = 'bold 9px Bahnschrift, Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of CHECKPOINTS.slice(1)) {
      ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.beginPath(); ctx.arc(toPx(c.x), toPx(c.z), 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(String(c.i), toPx(c.x), toPx(c.z) + 0.5);
    }
  }
  return { canvas: cv, toPx };
}

export function setGateDone(g) {
  g.traverse((o) => { if (o.material && o.material.emissive && o.geometry.type === 'BoxGeometry' && o.material.color.getHex() === 0xffb340) { o.material.color.set(0x3ddc6a); o.material.emissive.set(0x0a4418); } });
}
