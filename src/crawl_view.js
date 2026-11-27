// The Gauntlet's dressing (src/maps/crawl.js): a numbered gate and signpost at every stage,
// trail and track marker posts, the trailhead and summit signs, the ford's water sheet, and the
// loose stones and logs of the early stages as physical props (src/physics_props.js).
// Plays the role world_view.buildMarkers plays for the Trail Park.
import * as THREE from 'three';
import { MAP, ROADS, TRAILS, COURSES, DIFF, SIZE, RES, GRID, MAT, heightAt, visualHeightAt, pathPoint } from './terrain.js';
import { instance, pebbleTemplate, logTemplate } from './art/props.js';
import { assetPartsVariants } from './art/assets.js';
import { adoptDressing } from './physics_props.js';
import { fitFace, signpost, bannerBoard, faceYaw } from './art/signs.js';

const CAP = 0xffb340, CAP_DONE = 0x3ddc6a;

// sign faces: src/art/signs.js (pixel-font text, dark ink on parchment, sized around the words)
const SIGN_M = 0.05;   // signposts: metres per sign pixel (title caps 0.35 m)
const BANNER_M = 0.045; // stage gate banners: stage number caps 0.95 m (read from 60 m), title caps 0.32 m

// gate arch across the trail at s: a two-faced banner resting on posts that stop at its lower
// edge (so they never cross the letters), lamp caps on top
function gateArch(s, width, diff, faceOpts, t = TRAILS[0]) {
  const p = pathPoint(t, s);
  const g = new THREE.Group();
  g.position.set(p.x, heightAt(p.x, p.z), p.z);
  g.rotation.y = Math.atan2(p.tx, p.tz);
  const col = diff === 'green' || diff === 'blue' ? DIFF[diff].hex : 0x2b2b2b;
  const mat = new THREE.MeshStandardMaterial({ color: col, flatShading: true });
  const hw = width / 2 + 1.0;
  const face = fitFace({ frame: 2, ...faceOpts }, { m: BANNER_M, minW: hw * 2 + 0.4, maxW: hw * 2 + 2.4 });
  const y0 = 2.6;
  const caps = [];
  for (const sx of [-hw, hw]) {
    // posts reach down to the ground on their own side (the tread can be cambered)
    const gy = heightAt(p.x - p.tz * -sx, p.z + p.tx * -sx) - g.position.y;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, y0 + 0.4 - gy, 0.25), mat);
    post.position.set(sx, (y0 + 0.4 + gy) / 2 - 0.4, 0); post.castShadow = true; g.add(post);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.4), new THREE.MeshStandardMaterial({ color: CAP, emissive: 0x553300 }));
    cap.position.set(sx, y0 + face.h + 0.15, 0); g.add(cap); caps.push(cap);
  }
  const banner = bannerBoard(face);
  banner.position.y = y0 + face.h / 2;
  g.add(banner);
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
    // the stage number big (a stage is picked out from far down the course), the name beside it
    const label = DIFF[st.diff].label.toUpperCase();
    const gt = gateArch(st.gateS, st.width, st.diff, last
      ? { title: 'SUMMIT', sub: 'FINISH · THE GAUNTLET' }
      : { title: st.name, sub: st.n === 1 ? `START · ${label}` : label, diff: st.diff, num: st.n, numScale: 3, maxTitleW: 56 });
    root.add(gt);
    // signpost on the left, before the gate (so its post never hides it), toed in to the driver
    const face = fitFace(last ? { title: 'SUMMIT', sub: 'You made it' } : { title: st.name, sub: `${DIFF[st.diff].label} · ${st.len.toFixed(0)} m`, diff: st.diff, num: st.n, maxTitleW: 56 }, { m: SIGN_M });
    const p = pathPoint(t, st.s0 - 1), side = -(st.width / 2 + 1.0 + face.w / 2);
    const sx = p.x - p.tz * side, sz = p.z + p.tx * side;
    root.add(signpost(sx, sz, faceYaw([-p.tx, -p.tz], sx, sz, p.x, p.z, 0.2), face));
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
    root.add(signpost(x, z, Math.atan2(tx, tz) + Math.PI * 0.75, fitFace({ title: `TO STAGE ${st.n}`, sub: st.name, diff: st.diff }, { m: 0.04 }), { lift: 0.8 }));
  }
  // ---- trailhead + summit ----
  const TH = MAP.TRAILHEAD, p0 = pathPoint(t, 0);
  root.add(signpost(TH.x + 2, TH.z - TH.r + 2, 0, fitFace({ title: 'THE GAUNTLET', sub: `${STAGES.length} stages · ${t.length.toFixed(0)} m · climbs ${(t.pts.at(-1).h - p0.h).toFixed(0)} m` }, { m: 0.06 })));
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

  const view = gatesView(gates);
  // the side courses (src/maps/crawl_courses.js): views[0] is The Gauntlet, then one per course
  view.views = [view, ...COURSES.map((C) => buildCourseView(scene, C))];
  return view;
}

// gate caps: amber, green once that stage / section has been driven
function gatesView(gates) {
  return {
    gates,
    setDone(n, done = true) { for (const c of gates[n - 1]?.userData.caps || []) { c.material.color.set(done ? CAP_DONE : CAP); c.material.emissive.set(done ? 0x0a4418 : 0x553300); } },
    resetAll() { for (let n = 1; n <= gates.length; n++) this.setDone(n, false); },
  };
}

// course width at arc length s (the slab face widens and narrows again)
const widthOf = (C, s) => C.pts[Math.max(0, Math.min(C.pts.length - 1, Math.round(s / 0.5)))].w;

// A side course in the Gauntlet's style: a gate arch and signpost at every section (the start gate
// names the course, the last one is the finish), marker posts in each section's colour, white edge
// posts along its access tracks and a "TO <COURSE>" sign where the way in leaves the road / pad.
function buildCourseView(scene, C) {
  const root = new THREE.Group(); root.name = `course-${C.id}`;
  const m4 = new THREE.Matrix4(), N = C.stages.length;
  const label = (d) => DIFF[d].label.toUpperCase();
  const gates = C.stages.map((st) => {
    const last = st.n === N, w = widthOf(C, st.gateS);
    const opts = last ? { title: 'FINISH', sub: C.name.toUpperCase() }
      : st.n === 1 ? { title: C.name, sub: `START · ${label(C.diff)}`, diff: C.diff, maxTitleW: 56 }
        : { title: st.name, sub: label(st.diff), diff: st.diff, num: st.n, numScale: 3, maxTitleW: 56 };
    const gt = gateArch(st.gateS, w, last ? 'green' : st.n === 1 ? C.diff : st.diff, opts, C);
    root.add(gt);
    const face = fitFace(last ? { title: 'FINISH', sub: C.name }
      : st.n === 1 ? { title: C.name, sub: `${DIFF[C.diff].label} · ${C.length.toFixed(0)} m`, diff: C.diff, maxTitleW: 56 }
        : { title: st.name, sub: `${DIFF[st.diff].label} · ${st.len.toFixed(0)} m`, diff: st.diff, num: st.n, maxTitleW: 56 }, { m: SIGN_M });
    const sp = Math.max(0.5, st.s0 - 1), p = pathPoint(C, sp), side = -(widthOf(C, sp) / 2 + 1.0 + face.w / 2);
    const sx = p.x - p.tz * side, sz = p.z + p.tx * side;
    root.add(signpost(sx, sz, faceYaw([-p.tx, -p.tz], sx, sz, p.x, p.z, 0.2), face));
    return gt;
  });
  // marker posts, alternating sides, topped with the section's colour (not on the benches by the gates)
  const byDiff = {};
  let side = 1;
  for (let s = 8; s < C.length - 4; s += 10) {
    const st = C.stageAt(s);
    if (st.finish || C.stages.some((q) => Math.abs(s - q.gateS) < 5)) continue;
    const p = pathPoint(C, s), off = (widthOf(C, s) / 2 + (st.walls ? 0.6 : 0.9)) * side; side = -side;
    if (st.walls) continue; // the gully's boulder banks mark it well enough
    const x = p.x - p.tz * off, z = p.z + p.tx * off;
    (byDiff[st.diff] ||= []).push([x, heightAt(x, z), z]);
  }
  const posts = Object.values(byDiff).flat();
  if (posts.length) {
    const postMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), new THREE.MeshStandardMaterial({ color: 0x6b5a44 }), posts.length);
    posts.forEach(([x, y, z], i) => { m4.makeTranslation(x, y + 0.55, z); postMesh.setMatrixAt(i, m4); });
    postMesh.castShadow = true; root.add(postMesh);
    for (const [diff, list] of Object.entries(byDiff)) {
      const col = diff === 'green' || diff === 'blue' ? DIFF[diff].hex : 0x111111;
      const tops = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.25, 0.2), new THREE.MeshStandardMaterial({ color: col, emissive: diff === 'blue' ? 0x0a2040 : diff === 'green' ? 0x0a300f : 0 }), list.length);
      list.forEach(([x, y, z], i) => { m4.makeTranslation(x, y + 1.2, z); tops.setMatrixAt(i, m4); });
      root.add(tops);
    }
  }
  // the access tracks: white edge posts with a red reflector, as on the bypass track
  const roadPts = [];
  for (const r of ROADS.filter((q) => q.course === C.id)) for (let s = 8; s < r.length - 6; s += 16) {
    const p = pathPoint(r, s);
    for (const sd of [-1, 1]) { const off = (r.width / 2 + 0.8) * sd, x = p.x - p.tz * off, z = p.z + p.tx * off; roadPts.push([x, heightAt(x, z), z]); }
  }
  if (roadPts.length) {
    const white = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), new THREE.MeshStandardMaterial({ color: 0xf2f2ee }), roadPts.length);
    const refl = new THREE.InstancedMesh(new THREE.BoxGeometry(0.13, 0.16, 0.13), new THREE.MeshStandardMaterial({ color: 0xff3b2f, emissive: 0x661008 }), roadPts.length);
    roadPts.forEach(([x, y, z], i) => { m4.makeTranslation(x, y + 0.55, z); white.setMatrixAt(i, m4); m4.makeTranslation(x, y + 0.95, z); refl.setMatrixAt(i, m4); });
    white.castShadow = true; root.add(white, refl);
  }
  // "TO <COURSE>" where the way in starts (beside it, facing the driver coming along)
  for (const r of ROADS.filter((q) => q.course === C.id && q.access === 'in')) {
    const a = r.pts[0], b = r.pts[Math.min(4, r.pts.length - 1)];
    const tx = b.x - a.x, tz = b.z - a.z, L = Math.hypot(tx, tz) || 1, off = r.width / 2 + 1.6, fwd = r.joinFrom ? 7 : 3; // (clear of a track it tees off)
    const x = a.x + (tz / L) * off + (tx / L) * fwd, z = a.z - (tx / L) * off + (tz / L) * fwd;
    root.add(signpost(x, z, Math.atan2(tx, tz) + Math.PI * 0.75, fitFace({ title: `TO ${C.name.toUpperCase()}`, sub: `${DIFF[C.diff].label} · ${C.length.toFixed(0)} m`, diff: C.diff }, { m: 0.04 }), { lift: 0.8 }));
  }
  scene.add(root);
  return gatesView(gates);
}
