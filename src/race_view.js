// Low-poly dressing for the race track: barriers, tyre walls, marker posts, cones,
// checkpoint arches, the start / finish gantry with countdown lights, grandstands and
// crowd, the paddock, painted lines and the water splash.
import * as THREE from 'three';
import { GRID, RES, SIZE, MAT, heightAt, visualHeightAt, TRACK, CHECKPOINTS, PROPS, MAP, rng } from './terrain.js';

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, ...extra });

function labelTexture(text, { w = 512, h = 128, bg = '#f2efe6', fg = '#1b1b1b', check = false } = {}) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  if (check) { const q = h / 4; for (let x = 0; x < w; x += q) for (let y = 0; y < h; y += q) if (((x + y) / q) % 2 === 0) { ctx.fillStyle = '#111'; ctx.fillRect(x, y, q, q); } ctx.fillStyle = 'rgba(242,239,230,.92)'; ctx.fillRect(w * 0.16, h * 0.14, w * 0.68, h * 0.72); }
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(h * 0.5)}px Bahnschrift, Segoe UI, sans-serif`;
  ctx.fillText(text, w / 2, h * 0.53);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}

// a quad strip lying on the ground across the track at arc length s (painted line)
function groundStrip(s, depth, mat) {
  const f = MAP.trackFrame(s), hw = TRACK.width / 2 + 0.3;
  const geo = new THREE.PlaneGeometry(hw * 2, depth, 16, 1);
  geo.rotateX(-Math.PI / 2);
  const yaw = Math.atan2(f.tx, f.tz);
  geo.rotateY(yaw);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) { const x = pos.getX(i) + f.x, z = pos.getZ(i) + f.z; pos.setXYZ(i, x, visualHeightAt(x, z) + 0.04, z); }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat); m.receiveShadow = true;
  return m;
}

const matrix = new THREE.Matrix4(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(1, 1, 1), vec = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
const place = (mesh, i, x, y, z, yaw = 0, s = 1) => { quat.setFromAxisAngle(yAxis, yaw); scl.setScalar(s); matrix.compose(vec.set(x, y, z), quat, scl); mesh.setMatrixAt(i, matrix); };

function crowd(scene, spots) {
  const R = rng(99);
  const body = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.8, 0.3), std(0xffffff), spots.length);
  const head = new THREE.InstancedMesh(new THREE.BoxGeometry(0.24, 0.26, 0.24), std(0xffffff), spots.length);
  const shirts = [0xc23b22, 0x2f6fb5, 0xf2c94c, 0x3b8f4a, 0xeeeeee, 0x222222, 0xe07b39, 0x7b4fa8];
  const skins = [0xe0b48e, 0xc08a5e, 0x8d5a3b, 0xf0c8a4];
  const col = new THREE.Color();
  spots.forEach(([x, y, z, yaw], i) => {
    const s = 0.9 + R() * 0.2;
    place(body, i, x, y + 0.4 * s, z, yaw, s); place(head, i, x, y + 0.95 * s, z, yaw, s);
    body.setColorAt(i, col.set(shirts[Math.floor(R() * shirts.length)])); head.setColorAt(i, col.set(skins[Math.floor(R() * skins.length)]));
  });
  body.castShadow = true;
  scene.add(body, head);
}

export function buildRaceDressing(scene) {
  const R = rng(5150);
  const D = MAP.DECOR;
  // ---- props with colliders ----
  const barriers = PROPS.filter((p) => p.kind === 'barrier');
  const bar = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.9, 3.1), std(0xb9b4aa), barriers.length);
  const stripe = new THREE.InstancedMesh(new THREE.BoxGeometry(0.62, 0.18, 3.12), std(0xc0392b), barriers.length);
  barriers.forEach((b, i) => { place(bar, i, b.x, b.y, b.z, b.rotY); place(stripe, i, b.x, b.y + 0.22, b.z, b.rotY); });
  bar.castShadow = bar.receiveShadow = true;
  scene.add(bar, stripe);

  const walls = PROPS.filter((p) => p.kind === 'tyres');
  const tyreGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.28, 10);
  const tyres = new THREE.InstancedMesh(tyreGeo, std(0x1c1c1c, { roughness: 0.95 }), walls.length * 6);
  const white = [];
  let n = 0;
  walls.forEach((w, wi) => {
    const fx = Math.sin(w.rotY), fz = Math.cos(w.rotY);
    for (const a of [-0.5, 0.5]) for (let k = 0; k < 3; k++) {
      const x = w.x + fx * a * 1.02, z = w.z + fz * a * 1.02, y = w.y - w.hy + 0.14 + k * 0.28;
      if (k === 2 && wi % 2 === 0) { white.push([x, y, z]); continue; }
      place(tyres, n++, x, y, z, R() * 3);
    }
  });
  tyres.count = n; tyres.castShadow = true;
  const whites = new THREE.InstancedMesh(tyreGeo, std(0xeeeeea), white.length);
  white.forEach(([x, y, z], i) => place(whites, i, x, y, z));
  scene.add(tyres, whites);

  // ---- marker posts (red / white alternating tops) and apex cones ----
  const postGeo = new THREE.BoxGeometry(0.12, 1.1, 0.12);
  const posts = new THREE.InstancedMesh(postGeo, std(0xf2f2ee), D.posts.length);
  const tops = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 0.22, 0.14), std(0xffffff, { emissive: 0x220000 }), D.posts.length);
  const col = new THREE.Color();
  D.posts.forEach(([x, y, z], i) => { place(posts, i, x, y + 0.55, z); place(tops, i, x, y + 0.98, z); tops.setColorAt(i, col.set(i % 4 < 2 ? 0xd8321f : 0xf2f2ee)); });
  posts.castShadow = true;
  scene.add(posts, tops);
  const cones = new THREE.InstancedMesh(new THREE.ConeGeometry(0.22, 0.7, 8), std(0xff6a13, { emissive: 0x401000 }), D.cones.length);
  D.cones.forEach(([x, y, z], i) => place(cones, i, x, y + 0.35, z));
  cones.castShadow = true;
  scene.add(cones);

  // ---- painted start line + grid boxes ----
  const checkTex = labelTexture('', { w: 512, h: 64, check: true });
  checkTex.wrapS = THREE.RepeatWrapping; checkTex.repeat.set(1, 1);
  const lineMat = new THREE.MeshStandardMaterial({ map: checkTex, polygonOffset: true, polygonOffsetFactor: -2, roughness: 0.9 });
  const cpS = CHECKPOINTS[0].s;
  scene.add(groundStrip(cpS, 1.4, lineMat));
  const paint = new THREE.MeshStandardMaterial({ color: 0xeeeeea, polygonOffset: true, polygonOffsetFactor: -2, roughness: 0.9 });
  for (const back of [13, 23]) scene.add(groundStrip(cpS - back + 2.6, 0.3, paint));

  // ---- start / finish gantry with countdown lights ----
  const G = D.gantry;
  const gantry = new THREE.Group();
  gantry.position.set(G.x, G.y, G.z); gantry.rotation.y = G.yaw;
  const steel = std(0x3a3d42, { metalness: 0.3 });
  for (const sd of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.9, 6.8, 0.9), steel);
    leg.position.set(sd * G.span, 3.4, 0); leg.castShadow = true; gantry.add(leg);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(G.span * 2 + 0.9, 1.6, 0.7), steel);
  beam.position.y = 6.4; beam.castShadow = true; gantry.add(beam);
  const banner = labelTexture('START · FINISH', { w: 1024, h: 128, check: true });
  for (const ry of [0, Math.PI]) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(G.span * 2 - 0.6, 1.3), new THREE.MeshStandardMaterial({ map: banner }));
    b.position.set(0, 6.4, ry ? -0.36 : 0.36); b.rotation.y = ry; gantry.add(b);
  }
  const lights = [];
  for (let i = 0; i < 5; i++) {
    for (const zz of [0.42, -0.42]) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.12), new THREE.MeshStandardMaterial({ color: 0x220a08, emissive: 0x000000 }));
      l.position.set((i - 2) * 0.8, 7.65, zz); gantry.add(l); lights.push({ mesh: l, i });
    }
  }
  const lightBox = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.8, 0.7), steel);
  lightBox.position.y = 7.65; gantry.add(lightBox);
  scene.add(gantry);
  // n: 0 = all dark, 1..5 = that many red, 'go' = all green
  const setLights = (n) => lights.forEach(({ mesh, i }) => {
    const on = n === 'go' || i < n;
    const c = n === 'go' ? 0x2bff5a : 0xff2a14;
    mesh.material.color.set(on ? c : 0x220a08); mesh.material.emissive.set(on ? c : 0x000000);
    mesh.material.emissiveIntensity = on ? 1.6 : 0;
  });

  // ---- checkpoint arches (numbered; the next one glows amber) ----
  const arches = CHECKPOINTS.map((c, i) => {
    if (i === 0) return null;
    const g = new THREE.Group();
    g.position.set(c.x, heightAt(c.x, c.z), c.z); g.rotation.y = Math.atan2(c.tx, c.tz);
    const span = TRACK.width / 2 + 3.2;
    const m = std(0xf2f2ee);
    for (const sd of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.22, 4.6, 0.22), m);
      const gy = heightAt(c.x - c.tz * sd * span, c.z + c.tx * sd * span) - g.position.y;
      pole.position.set(sd * span, 2.3 + gy, 0); pole.castShadow = true; g.add(pole);
    }
    const tex = labelTexture(`CHECKPOINT ${i}`, { w: 1024, h: 128, bg: '#1d1d1d', fg: '#f2efe6' });
    const bmat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0x000000, side: THREE.DoubleSide });
    const b = new THREE.Mesh(new THREE.PlaneGeometry(span * 2, 0.9), bmat);
    b.position.y = 4.3; g.add(b);
    scene.add(g);
    return bmat;
  });
  const setNextCp = (next) => arches.forEach((m, i) => { if (!m) return; const on = i === next; m.color.set(on ? 0xffc060 : 0xffffff); m.emissive.set(on ? 0x6a3c00 : 0x000000); });

  // ---- grandstands + crowd ----
  const spots = [];
  for (const st of PROPS.filter((p) => p.kind === 'stand')) {
    const g = new THREE.Group(); g.position.set(st.x, st.y - st.hy, st.z);
    const steps = 4;
    for (let k = 0; k < steps; k++) {
      const h = 0.8 * (k + 1), d = (st.hz * 2) / steps;
      const box = new THREE.Mesh(new THREE.BoxGeometry(st.hx * 2, h, d), std(k % 2 ? 0x8a8f96 : 0x9da2a8));
      box.position.set(0, h / 2, -st.hz + d * (k + 0.5)); box.castShadow = box.receiveShadow = true; g.add(box);
      for (let x = -st.hx + 0.6; x < st.hx - 0.4; x += 0.7 + R() * 0.5) if (R() < 0.8) spots.push([st.x + x, st.y - st.hy + h, st.z - st.hz + d * (k + 0.5), Math.PI + (R() - 0.5) * 0.4]);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(st.hx * 2 + 1, 0.2, st.hz * 2 + 1.5), std(0xc23b22));
    roof.position.set(0, 5.6, 0.3); roof.rotation.x = -0.08; roof.castShadow = true; g.add(roof);
    for (const sx of [-st.hx, st.hx]) for (const sz of [st.hz]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.2, 5.6, 0.2), std(0x55585c)); p.position.set(sx, 2.8, sz); g.add(p); }
    scene.add(g);
  }
  // catch fence
  const fences = PROPS.filter((p) => p.kind === 'fence');
  const mesh = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
  for (const f of fences) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(f.hx * 2, f.hy * 2), mesh);
    panel.position.set(f.x, f.y, f.z); scene.add(panel);
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.1, f.hy * 2 + 0.2, 0.1), std(0x55585c));
    pole.position.set(f.x - f.hx, f.y + 0.1, f.z); scene.add(pole);
  }
  // standing crowd along the fence, and small groups at the jumps and the splash
  for (let x = D.spect.x0 + 2; x < D.spect.x1 - 2; x += 0.9 + R() * 1.2) if (R() < 0.6) { const z = 147.5 + R() * 2.5; spots.push([x, heightAt(x, z), z, Math.PI + (R() - 0.5) * 0.6]); }
  const F = TRACK.features;
  for (const s of [F.table.lip + 4, F.step.face + 4, (F.splash[0] + F.splash[1]) / 2, F.whoops[0] + 25]) {
    const f = MAP.trackFrame(s);
    const sd = f.k > 0 ? -1 : 1; // watch from the inside of the bend, away from run-off
    for (let k = 0; k < 14; k++) {
      const lat = sd * (TRACK.width / 2 + 13 + R() * 4), along = (R() - 0.5) * 16;
      const x = f.x - f.tz * lat + f.tx * along, z = f.z + f.tx * lat + f.tz * along;
      spots.push([x, heightAt(x, z), z, Math.atan2(-(f.x - x), -(f.z - z)) + Math.PI]);
    }
    // a bit of tape on posts in front of them
    const tape = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 18), std(0xffd21f, { emissive: 0x332800 }));
    const lat = sd * (TRACK.width / 2 + 10), x = f.x - f.tz * lat, z = f.z + f.tx * lat;
    tape.position.set(x, heightAt(x, z) + 0.9, z); tape.rotation.y = Math.atan2(f.tx, f.tz); scene.add(tape);
  }
  crowd(scene, spots);

  // ---- paddock: tents, trailers, flags ----
  const P = D.paddock;
  const tentCols = [0xf2efe6, 0x2f6fb5, 0xc23b22, 0xf2c94c];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.4, r = P.r * (0.45 + R() * 0.35);
    const x = P.x + Math.cos(a) * r, z = P.z + Math.sin(a) * r, y = heightAt(x, z);
    const tent = new THREE.Mesh(new THREE.ConeGeometry(3.2, 2.2, 4), std(tentCols[i % 4]));
    tent.position.set(x, y + 3.1, z); tent.rotation.y = Math.PI / 4; tent.castShadow = true; scene.add(tent);
    for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2, 0.1), std(0x777777)); p.position.set(x + dx, y + 1, z + dz); scene.add(p); }
  }
  for (let i = 0; i < 4; i++) {
    const x = P.x - 14 + i * 9, z = P.z - 4, y = heightAt(x, z);
    const tr = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.8, 8), std([0xdadada, 0x2b2b2b, 0x9e2a1e, 0x1f4fa8][i]));
    tr.position.set(x, y + 1.7, z); tr.castShadow = true; scene.add(tr);
  }
  const flagCols = [0xc23b22, 0xf2c94c, 0x2f6fb5, 0xf2efe6];
  for (let x = D.spect.x0; x <= D.spect.x1; x += 20) {
    const z = D.spect.z1 - 1, y = heightAt(x, z);
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.12, 8, 0.12), std(0x888888)); pole.position.set(x, y + 4, z); scene.add(pole);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.2, 2), std(flagCols[(x / 20 + 4) & 3])); flag.position.set(x, y + 7.3, z + 1); scene.add(flag);
  }

  // ---- water splash: a flat sheet over the flooded cells ----
  const W = D.water;
  if (W) {
    const N1 = RES + 1, CELL = SIZE / RES, verts = [];
    for (let ix = 0; ix < RES; ix++) for (let iz = 0; iz < RES; iz++) {
      const g = ix * N1 + iz;
      if (GRID.mat[g] !== MAT.WATER && GRID.mat[g + N1] !== MAT.WATER && GRID.mat[g + 1] !== MAT.WATER && GRID.mat[g + N1 + 1] !== MAT.WATER) continue;
      const x0 = -SIZE / 2 + ix * CELL, z0 = -SIZE / 2 + iz * CELL, x1 = x0 + CELL, z1 = z0 + CELL, y = W.y;
      verts.push(x0, y, z0, x0, y, z1, x1, y, z0, x1, y, z0, x0, y, z1, x1, y, z1);
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3)); geo.computeVertexNormals();
    const water = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x4a6f78, transparent: true, opacity: 0.72, roughness: 0.15, metalness: 0.1, depthWrite: false }));
    scene.add(water);
  }

  // ---- venue sign ----
  const sp = MAP.trackFrame(CHECKPOINTS[0].s - 30);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(7, 1.6, 0.15), [steel, steel, steel, steel, new THREE.MeshStandardMaterial({ map: labelTexture(TRACK.name.toUpperCase(), { w: 1024, h: 160, bg: '#1d1d1d', fg: '#ffb340' }) }), steel]);
  const lat = -(TRACK.width / 2 + 6), sx = sp.x - sp.tz * lat, sz = sp.z + sp.tx * lat;
  sign.position.set(sx, heightAt(sx, sz) + 3.2, sz); sign.rotation.y = Math.atan2(-sp.tz, sp.tx); sign.castShadow = true;
  scene.add(sign);
  for (const sd of [-3, 3]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3.2, 0.2), steel); p.position.set(sx + Math.cos(sign.rotation.y) * sd, heightAt(sx, sz) + 1.6, sz - Math.sin(sign.rotation.y) * sd); scene.add(p); }

  return { setLights, setNextCp };
}
