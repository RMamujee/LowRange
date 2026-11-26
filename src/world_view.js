// Low-poly rendering of the active map: terrain, rocks, trees and the minimap, plus the
// trail park's road/trail markers, signposts and start/finish gates. The race track's
// dressing lives in race_view.js.
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SIZE, RES, MAT, MAT_INFO, GRID, fbm, heightAt, visualHeightAt, materialAt, ROADS, TRAILS, DIFF, TRAILHEAD, TRACK, CHECKPOINTS, pathPoint } from './terrain.js';
import { buildSetDressing, gridClearance } from './art/dressing.js';
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
    pos.setY(i, GRID.vis[g]);
    const m = GRID.mat[g];
    const base = MAT_INFO[m].color;
    let v = 0.86 + fbm(x * 0.35, z * 0.35, 2) * 0.12 + (Math.random() - 0.5) * 0.05;
    if (m === MAT.ROAD || m === MAT.TARMAC) v =0.92 + fbm(x * 0.6, z * 0.6, 2) * 0.06; // smoother graded surface
    if (GRID.path[g] >= NROADS && m !== MAT.MUD) v *= 0.8; // worn, darker trail tread
    c.setRGB(base[0] * v, base[1] * v, base[2] * v);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }));
  mesh.receiveShadow = true;
  return mesh;
}

export function buildRocks(rocks) {
  const geos = [];
  const col = new THREE.Color();
  for (const r of rocks) {
    const pts = [];
    for (let i = 0; i < r.pts.length; i += 3) pts.push(new THREE.Vector3(r.pts[i], r.pts[i + 1], r.pts[i + 2]));
    let g;
    try { g = new ConvexGeometry(pts); } catch { continue; }
    g.rotateY(r.rotY);
    g.translate(r.x, r.y, r.z);
    const shade = r.ledge ? 0.5 + Math.random() * 0.08 : 0.42 + Math.random() * 0.16;
    col.setRGB(shade * 1.04, shade, shade * 0.93);
    const cols = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < cols.length; i += 3) { cols[i] = col.r; cols[i + 1] = col.g; cols[i + 2] = col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geos.push(g);
  }
  const mesh = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 }));
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

// trees (on their physics colliders) plus all the decorative set dressing (src/art/dressing.js)
export function buildTrees(trees) {
  return buildSetDressing({
    size: SIZE, heightAt: visualHeightAt, matAt: materialAt, trees,
    clear: gridClearance({ size: SIZE, res: RES, path: GRID.path }, TRAILHEAD),
    paths: [...ROADS, ...TRAILS], trailhead: TRAILHEAD,
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

function signTexture(lines, diff, w = 512, h = 256) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#5b3d22'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#6d4a2a'; for (let y = 0; y < h; y += 32) ctx.fillRect(0, y, w, 3);
  ctx.strokeStyle = '#e8d8b0'; ctx.lineWidth = 8; ctx.strokeRect(10, 10, w - 20, h - 20);
  ctx.fillStyle = '#f3e6c4'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const x0 = diff ? w / 2 + 40 : w / 2;
  ctx.font = `bold ${lines[0].length > 16 ? 46 : 56}px Bahnschrift, Segoe UI, sans-serif`;
  ctx.fillText(lines[0], x0, h * 0.4);
  ctx.font = '34px Bahnschrift, Segoe UI, sans-serif';
  if (lines[1]) ctx.fillText(lines[1], x0, h * 0.72);
  if (diff) drawDiffSymbol(ctx, diff, 80, h / 2, 46);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function signpost(x, z, faceYaw, lines, diff) {
  const g = new THREE.Group();
  const y = heightAt(x, z);
  g.position.set(x, y, z);
  g.rotation.y = faceYaw;
  const wood = new THREE.MeshStandardMaterial({ color: 0x4a3420, flatShading: true });
  for (const sx of [-1.15, 1.15]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.6, 0.16), wood); p.position.set(sx, 1.3, 0); p.castShadow = true; g.add(p); }
  const board = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.3, 0.08), [wood, wood, wood, wood, new THREE.MeshStandardMaterial({ map: signTexture(lines, diff) }), wood]);
  board.position.y = 1.9; board.castShadow = true;
  g.add(board);
  return g;
}

// start / finish arch across a trail
function gate(path, atEnd) {
  const p = pathPoint(path, atEnd ? path.length - 3 : 3);
  const g = new THREE.Group();
  g.position.set(p.x, heightAt(p.x, p.z), p.z);
  g.rotation.y = Math.atan2(p.tx, p.tz);
  const col = DIFF[path.diff].hex === 0x000000 || DIFF[path.diff].hex === 0x1a1a1a ? 0x2b2b2b : DIFF[path.diff].hex;
  const mat = new THREE.MeshStandardMaterial({ color: col, flatShading: true });
  const hw = path.width / 2 + 0.9;
  for (const sx of [-hw, hw]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3.6, 0.25), mat);
    post.position.set(sx, 1.8, 0); post.castShadow = true; g.add(post);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.4), new THREE.MeshStandardMaterial({ color: 0xffb340, emissive: 0x553300 }));
    cap.position.set(sx, 3.7, 0); g.add(cap);
  }
  const bannerTex = signTexture([path.name, atEnd ? 'FINISH' : 'START'], path.diff, 768, 160);
  // two single-sided faces so the text reads correctly from both directions
  for (const ry of [0, Math.PI]) {
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, 0.9), new THREE.MeshStandardMaterial({ map: bannerTex }));
    banner.position.y = 3.1; banner.rotation.y = ry;
    g.add(banner);
  }
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
      const p = pathPoint(t, atEnd ? t.length - 6 : 6);
      const side = t.width / 2 + 2.6;
      const sx = p.x - p.tz * side, sz = p.z + p.tx * side;
      const yaw = Math.atan2(p.tx, p.tz) + (atEnd ? 0 : Math.PI);
      scene.add(signpost(sx, sz, yaw, [t.name, `${DIFF[t.diff].label} · ${(t.length).toFixed(0)} m`], t.diff));
      const gt = gate(t, atEnd); scene.add(gt); gates.push(gt);
    }
  }
  // trailhead sign
  scene.add(signpost(TRAILHEAD.x + 6, TRAILHEAD.z - 10, Math.PI * 0.85, ['LOW RANGE', 'Trail Park · Trailhead']));
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
