// The Gauntlet's dressing (src/maps/crawl.js): a numbered gate and signpost at every stage,
// trail and track marker posts, the trailhead and summit signs, the ford's water sheet, and the
// loose stones and logs of the early stages as physical props (src/physics_props.js).
// Plays the role world_view.buildMarkers plays for the Trail Park.
import * as THREE from 'three';
import { MAP, ROADS, TRAILS, DIFF, SIZE, RES, GRID, MAT, heightAt, visualHeightAt, pathPoint } from './terrain.js';
import { instance, pebbleTemplate, logTemplate } from './art/props.js';
import { assetPartsVariants } from './art/assets.js';
import { adoptDressing } from './physics_props.js';

const CAP = 0xffb340, CAP_DONE = 0x3ddc6a;

function drawDiffSymbol(ctx, diff, x, y, r) {
  ctx.fillStyle = DIFF[diff].color;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = r * 0.12;
  const diamond = (cx) => { ctx.beginPath(); ctx.moveTo(cx, y - r); ctx.lineTo(cx + r, y); ctx.lineTo(cx, y + r); ctx.lineTo(cx - r, y); ctx.closePath(); ctx.fill(); ctx.stroke(); };
  if (diff === 'green') { ctx.beginPath(); ctx.arc(x, y, r * 0.85, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  else if (diff === 'blue') { ctx.fillRect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6); ctx.strokeRect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6); }
  else if (diff === 'black') diamond(x);
  else { diamond(x - r * 0.75); diamond(x + r * 0.75); }
}

// wooden board texture: big number on the left (optional), difficulty symbol, two lines of text
function signTexture(lines, { diff, num, w = 512, h = 256, scale = 1 } = {}) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#5b3d22'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#6d4a2a'; for (let y = 0; y < h; y += 32) ctx.fillRect(0, y, w, 3);
  ctx.strokeStyle = '#e8d8b0'; ctx.lineWidth = 8; ctx.strokeRect(10, 10, w - 20, h - 20);
  ctx.fillStyle = '#f3e6c4'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let x0 = w / 2;
  if (num !== undefined) {
    ctx.font = `bold ${Math.round(h * 0.62)}px Bahnschrift, Segoe UI, sans-serif`;
    ctx.fillText(String(num), h * 0.42, h * 0.52);
    x0 += h * 0.32;
  }
  if (diff) { drawDiffSymbol(ctx, diff, num !== undefined ? h * 0.9 : 80, h / 2, h * 0.16); x0 += num !== undefined ? h * 0.2 : 40; }
  ctx.fillStyle = '#f3e6c4';
  ctx.font = `bold ${Math.round(h * scale * (lines[0].length > 16 ? 0.18 : 0.22))}px Bahnschrift, Segoe UI, sans-serif`;
  ctx.fillText(lines[0], x0, h * (lines[1] ? 0.38 : 0.52));
  ctx.font = `${Math.round(h * scale * 0.13)}px Bahnschrift, Segoe UI, sans-serif`;
  if (lines[1]) ctx.fillText(lines[1], x0, h * 0.7);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const wood = () => new THREE.MeshStandardMaterial({ color: 0x4a3420, flatShading: true });
function signpost(x, z, faceYaw, tex, w = 2.6, hgt = 1.3) {
  const g = new THREE.Group();
  g.position.set(x, heightAt(x, z), z);
  g.rotation.y = faceYaw;
  const m = wood();
  for (const sx of [-w / 2 + 0.15, w / 2 - 0.15]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.3 + hgt, 0.16), m); p.position.set(sx, (1.3 + hgt) / 2, 0); p.castShadow = true; g.add(p); }
  const board = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, 0.08), [m, m, m, m, new THREE.MeshStandardMaterial({ map: tex }), m]);
  board.position.y = 1.25 + hgt / 2; board.castShadow = true;
  g.add(board);
  return g;
}

// gate arch across the trail at s, banner on both faces
function gateArch(s, width, diff, tex) {
  const t = TRAILS[0], p = pathPoint(t, s);
  const g = new THREE.Group();
  g.position.set(p.x, heightAt(p.x, p.z), p.z);
  g.rotation.y = Math.atan2(p.tx, p.tz);
  const col = diff === 'green' || diff === 'blue' ? DIFF[diff].hex : 0x2b2b2b;
  const mat = new THREE.MeshStandardMaterial({ color: col, flatShading: true });
  const hw = width / 2 + 1.0;
  const caps = [];
  for (const sx of [-hw, hw]) {
    // posts reach down to the ground on their own side (the tread can be cambered)
    const gy = heightAt(p.x - p.tz * -sx, p.z + p.tx * -sx) - g.position.y;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3.6 - gy, 0.25), mat);
    post.position.set(sx, 1.8 + gy / 2, 0); post.castShadow = true; g.add(post);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.4), new THREE.MeshStandardMaterial({ color: CAP, emissive: 0x553300 }));
    cap.position.set(sx, 3.7, 0); g.add(cap); caps.push(cap);
  }
  for (const ry of [0, Math.PI]) {
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, 0.95), new THREE.MeshStandardMaterial({ map: tex }));
    banner.position.y = 3.1; banner.rotation.y = ry;
    g.add(banner);
  }
  g.userData.caps = caps;
  return g;
}

export function buildCrawlView(scene, looseProps) {
  const t = TRAILS[0], STAGES = MAP.STAGES;
  const root = new THREE.Group(); root.name = 'crawl';
  const m4 = new THREE.Matrix4();
  // ---- gates + signposts: one per stage; stage 1's is the start, the Summit's the finish ----
  const gates = STAGES.map((st) => {
    const last = st.n === STAGES.length;
    const title = last ? 'SUMMIT · FINISH' : `${st.n} · ${st.name.toUpperCase()}`;
    const sub = st.n === 1 ? 'START · THE GAUNTLET' : last ? 'THE GAUNTLET' : DIFF[st.diff].label.toUpperCase();
    const gt = gateArch(st.gateS, st.width, st.diff, signTexture([title, sub], { diff: last ? undefined : st.diff, w: 1024, h: 140, scale: 2.1 }));
    root.add(gt);
    // signpost on the left, facing the approaching driver
    const p = pathPoint(t, st.s0 - 1), side = -(st.width / 2 + 2.4);
    const sx = p.x - p.tz * side, sz = p.z + p.tx * side;
    const len = `${st.len.toFixed(0)} m`;
    root.add(signpost(sx, sz, Math.atan2(p.tx, p.tz) + Math.PI, signTexture([last ? 'SUMMIT' : st.name, last ? 'You made it' : `${DIFF[st.diff].label} · ${len}`], { diff: last ? undefined : st.diff, num: last ? undefined : st.n })));
    return gt;
  });
  // ---- trail marker posts, topped with each stage's colour ----
  const postG = new THREE.BoxGeometry(0.12, 1.1, 0.12), topG = new THREE.BoxGeometry(0.2, 0.25, 0.2);
  const byDiff = {};
  let side = 1;
  for (let s = 6; s < t.length - 4; s += 11) {
    const st = MAP.stageAt(s);
    if (st.summit || Math.abs(s - st.gateS) < 4) continue;
    const p = pathPoint(t, s), off = (st.width / 2 + 0.9) * side; side = -side;
    if (off > 0 && STAGES.some((q) => q.spur !== undefined && s > q.s0 - 22 && s < q.s0)) continue; // spur mouths
    const x = p.x - p.tz * off, z = p.z + p.tx * off;
    (byDiff[st.diff] ||= []).push([x, heightAt(x, z), z]);
  }
  const posts = Object.values(byDiff).flat();
  const postMesh = new THREE.InstancedMesh(postG, new THREE.MeshStandardMaterial({ color: 0x6b5a44 }), posts.length);
  posts.forEach(([x, y, z], i) => { m4.makeTranslation(x, y + 0.55, z); postMesh.setMatrixAt(i, m4); });
  postMesh.castShadow = true; root.add(postMesh);
  for (const [diff, list] of Object.entries(byDiff)) {
    const col = diff === 'green' || diff === 'blue' ? DIFF[diff].hex : 0x111111;
    const tops = new THREE.InstancedMesh(topG, new THREE.MeshStandardMaterial({ color: col, emissive: diff === 'blue' ? 0x0a2040 : diff === 'green' ? 0x0a300f : 0 }), list.length);
    list.forEach(([x, y, z], i) => { m4.makeTranslation(x, y + 1.2, z); tops.setMatrixAt(i, m4); });
    root.add(tops);
  }
  // ---- bypass track edge posts: white with a red reflector ----
  const road = ROADS[0], roadPts = [];
  for (let s = 10; s < road.length - 10; s += 18) {
    const p = pathPoint(road, s);
    for (const sd of [-1, 1]) {
      const off = (road.width / 2 + 0.8) * sd, x = p.x - p.tz * off, z = p.z + p.tx * off;
      // keep clear of the spurs leaving the track
      if (ROADS.slice(1).some((r) => Math.hypot(r.pts[0].x - x, r.pts[0].z - z) < 9)) continue;
      roadPts.push([x, heightAt(x, z), z]);
    }
  }
  const white = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), new THREE.MeshStandardMaterial({ color: 0xf2f2ee }), roadPts.length);
  const refl = new THREE.InstancedMesh(new THREE.BoxGeometry(0.13, 0.16, 0.13), new THREE.MeshStandardMaterial({ color: 0xff3b2f, emissive: 0x661008 }), roadPts.length);
  roadPts.forEach(([x, y, z], i) => { m4.makeTranslation(x, y + 0.55, z); white.setMatrixAt(i, m4); m4.makeTranslation(x, y + 0.95, z); refl.setMatrixAt(i, m4); });
  white.castShadow = true; root.add(white, refl);
  // spur signs where each spur leaves the track
  for (const st of STAGES) {
    if (st.spur === undefined) continue;
    const r = ROADS[st.spur], a = r.pts[0], b = r.pts[4];
    const tx = b.x - a.x, tz = b.z - a.z, L = Math.hypot(tx, tz) || 1, off = r.width / 2 + 1.6;
    const x = a.x + (tz / L) * off + (tx / L) * 3, z = a.z - (tx / L) * off + (tz / L) * 3;
    root.add(signpost(x, z, Math.atan2(tx, tz) + Math.PI * 0.75, signTexture([`TO STAGE ${st.n}`, st.name], { diff: st.diff }), 1.8, 0.8));
  }
  // ---- trailhead + summit ----
  const TH = MAP.TRAILHEAD, p0 = pathPoint(t, 0);
  root.add(signpost(TH.x + 2, TH.z - TH.r + 2, 0, signTexture(['THE GAUNTLET', `${STAGES.length} stages · ${t.length.toFixed(0)} m · climbs ${(t.pts.at(-1).h - p0.h).toFixed(0)} m`]), 3.4, 1.5));
  const SU = MAP.SUMMIT;
  {
    const x = SU.x + 3, z = SU.z - 5, y = heightAt(x, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 7, 6), new THREE.MeshStandardMaterial({ color: 0xd8d4c8 }));
    pole.position.set(x, y + 3.5, z); pole.castShadow = true; root.add(pole);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.1, 1.8), new THREE.MeshStandardMaterial({ color: CAP, emissive: 0x442200 }));
    flag.position.set(x, y + 6.35, z + 0.95); root.add(flag);
    // cairn
    const stoneM = new THREE.MeshStandardMaterial({ color: 0x9a8f80, flatShading: true });
    for (let k = 0; k < 5; k++) { const r = 0.55 - k * 0.09; const m = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), stoneM); m.position.set(x - 2.5, heightAt(x - 2.5, z) + 0.3 + k * 0.42, z + 0.4); m.rotation.y = k; m.castShadow = true; root.add(m); }
  }
  // ---- the ford: a flat water sheet over the flooded cells ----
  {
    const N1 = RES + 1, CELL = SIZE / RES, verts = [], y = MAP.WATER.y;
    for (let ix = 0; ix < RES; ix++) for (let iz = 0; iz < RES; iz++) {
      const g = ix * N1 + iz;
      if (GRID.mat[g] !== MAT.WATER && GRID.mat[g + N1] !== MAT.WATER && GRID.mat[g + 1] !== MAT.WATER && GRID.mat[g + N1 + 1] !== MAT.WATER) continue;
      const x0 = -SIZE / 2 + ix * CELL, z0 = -SIZE / 2 + iz * CELL, x1 = x0 + CELL, z1 = z0 + CELL;
      verts.push(x0, y, z0, x0, y, z1, x1, y, z0, x1, y, z0, x0, y, z1, x1, y, z1);
    }
    if (verts.length) {
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3)); geo.computeVertexNormals();
      root.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x4a6f78, transparent: true, opacity: 0.72, roughness: 0.15, metalness: 0.1, depthWrite: false })));
    }
  }
  scene.add(root);

  // ---- loose stones and logs on the early stages: physical props ----
  // named groups like src/art/dressing.js's, so adoptDressing() treats them the same way
  const loose = new THREE.Group(); loose.name = 'crawl-loose';
  const stoneSet = assetPartsVariants('rock_small'), logSet = assetPartsVariants('log');
  const stoneTpl = stoneSet ? stoneSet[0] : pebbleTemplate(1), logTpl = logSet ? logSet[0] : logTemplate();
  const H = (x, z) => visualHeightAt(x, z);
  loose.add(instance(stoneTpl, MAP.LOOSE.stones.map((q) => ({ x: q.x, y: H(q.x, q.z) - 0.04, z: q.z, ry: q.ry, s: stoneSet ? q.s * 1.6 : q.s })), { name: 'stones' }));
  loose.add(instance(logTpl, MAP.LOOSE.logs.map((q) => ({ x: q.x, y: H(q.x, q.z) - 0.06, z: q.z, ry: q.ry, sx: logSet ? 1 : q.sx, s: q.s })), { name: 'logs' }));
  scene.add(loose);
  if (looseProps) adoptDressing(loose, looseProps);

  return {
    gates,
    // light a stage's gate caps green once it has been driven
    setDone(n, done = true) { for (const c of gates[n - 1]?.userData.caps || []) { c.material.color.set(done ? CAP_DONE : CAP); c.material.emissive.set(done ? 0x0a4418 : 0x553300); } },
    resetAll() { for (let n = 1; n <= gates.length; n++) this.setDone(n, false); },
  };
}
