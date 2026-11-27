// Man-made touches on Coralume Island, drawn on the box colliders src/maps/jungle.js puts in PROPS
// (so what you see is what you hit): timber bridge decks with rails, the Palm Cove dock, steel
// guard rails on Ember Pass and the cliff-top coast road, stilt huts, the summit lookout and the
// Lava Point lighthouse; plus painted lines on the asphalt (no colliders, they sit on the road).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MAP, ROADS, visualHeightAt, pathPoint } from '../../terrain.js';

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9, ...extra });
const PLANK = mat(0x9a6a3e), PLANK_DARK = mat(0x6e4a2a), STEEL = mat(0xb9bcb4), POST = mat(0x6b5a44);
const THATCH = mat(0xc8a25c), HUT_WALL = mat(0xd8c49a), WHITE = mat(0xefeee6), RED = mat(0xc84a3c);
// a box mesh matching a PROPS box
function boxMesh(b, material, grow = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(b.hx * 2 + grow, b.hy * 2, b.hz * 2 + grow), material);
  m.position.set(b.x, b.y, b.z); m.rotation.y = b.rotY; m.castShadow = true; m.receiveShadow = true;
  return m;
}

export function buildStructures() {
  const g = new THREE.Group(); g.name = 'structures';
  const D = MAP.DECOR;
  // bridges and the dock: plank decks (alternate tones read as boards), rails, posts down to the water
  const posts = [], decks = [], decksB = []; // planks merged, two alternating tones
  for (const b of MAP.PROPS) {
    if (b.kind === 'deck') { const geo = new THREE.BoxGeometry(b.hx * 2, b.hy * 2, b.hz * 2); geo.rotateY(b.rotY); geo.translate(b.x, b.y, b.z); ((decks.length + decksB.length) % 2 ? decks : decksB).push(geo); }
    else if (b.kind === 'kerb') g.add(boxMesh(b, PLANK_DARK));
    else if (b.kind === 'rail' && Math.abs(b.hy - 0.55) < 0.01) g.add(boxMesh(b, PLANK_DARK)); // bridge rails
    if (b.kind === 'deck') {
      // pilings under each deck plank's corners, down to the bed
      const c = Math.cos(b.rotY), s = Math.sin(b.rotY);
      for (const sx of [-1, 1]) {
        const lx = sx * (b.hx - 0.3), x = b.x + c * lx, z = b.z - s * lx;
        const bed = visualHeightAt(x, z), top = b.y - b.hy;
        if (top - bed > 0.4) { const p = new THREE.BoxGeometry(0.28, top - bed + 0.3, 0.28); p.translate(x, (top + bed) / 2 - 0.1, z); posts.push(p); }
      }
    }
  }
  for (const [list, m] of [[decks, PLANK], [decksB, PLANK_DARK]]) if (list.length) { const mesh = new THREE.Mesh(mergeGeometries(list), m); mesh.castShadow = mesh.receiveShadow = true; g.add(mesh); }
  if (posts.length) { const m = new THREE.Mesh(mergeGeometries(posts), POST); m.castShadow = true; g.add(m); }
  // guard rails: a steel beam on its box, posts every 2 m
  const beams = [], rposts = [];
  for (const b of MAP.PROPS) {
    if (b.kind !== 'rail' || Math.abs(b.hy - 0.32) > 0.01) continue;
    const beam = new THREE.BoxGeometry(0.1, 0.32, b.hz * 2); beam.rotateY(b.rotY); beam.translate(b.x, b.y + 0.12, b.z); beams.push(beam);
    const p = new THREE.BoxGeometry(0.12, 0.85, 0.12); p.translate(b.x, b.y - 0.2, b.z); rposts.push(p);
  }
  if (beams.length) { const m = new THREE.Mesh(mergeGeometries(beams), STEEL); m.castShadow = true; g.add(m); const q = new THREE.Mesh(mergeGeometries(rposts), POST); q.castShadow = true; g.add(q); }
  // stilt huts: plank box on short legs, a steep thatched roof
  for (const h of D.huts) {
    const hut = new THREE.Group(); hut.position.set(h.x, h.y, h.z); hut.rotation.y = h.yaw;
    const body = new THREE.Mesh(new THREE.BoxGeometry(h.w, 2.2, h.d), HUT_WALL); body.position.y = 1.7; body.castShadow = true; hut.add(body);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.6, 0.06), PLANK_DARK); door.position.set(0, 1.5, h.d / 2 + 0.03); hut.add(door);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.2, 0.22), POST); l.position.set(sx * (h.w / 2 - 0.2), 0.4, sz * (h.d / 2 - 0.2)); hut.add(l); }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.hypot(h.w, h.d) / 2 + 0.6, 2.4, 4), THATCH);
    roof.position.y = 4.0; roof.rotation.y = Math.PI / 4; roof.castShadow = true; hut.add(roof);
    hut.userData.camBlock = true; // (src/cam_clear.js keeps the camera out of it)
    g.add(hut);
  }
  // summit lookout: an open timber shelter
  if (D.lookout) {
    const L = D.lookout, o = new THREE.Group(); o.position.set(L.x, L.y, L.z); o.rotation.y = L.yaw;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.6, 0.2), POST); p.position.set(sx * 1.4, 1.3, sz * 1.4); p.castShadow = true; o.add(p); }
    o.userData.camBlock = true;
    const bench = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.6), PLANK); bench.position.set(0, 0.5, -1.0); o.add(bench);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.6, 1.3, 4), THATCH); roof.position.y = 3.2; roof.rotation.y = Math.PI / 4; roof.castShadow = true; o.add(roof);
    g.add(o);
  }
  // Lava Point light: a white tower with red bands and a lamp room
  if (D.lighthouse) {
    const L = D.lighthouse, o = new THREE.Group(); o.position.set(L.x, L.y, L.z);
    for (let k = 0; k < 4; k++) { const seg = new THREE.Mesh(new THREE.CylinderGeometry(1.45 - (k + 1) * 0.12, 1.45 - k * 0.12, 2, 8), k % 2 ? RED : WHITE); seg.position.y = 1 + k * 2; seg.castShadow = true; o.add(seg); }
    o.userData.camBlock = true;
    const room = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 1.1, 8), mat(0xfff2c0, { emissive: 0x806a20 })); room.position.y = 8.55; o.add(room);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(1.05, 0.9, 8), RED); cap.position.y = 9.55; cap.castShadow = true; o.add(cap);
    g.add(o);
  }
  g.add(roadPaint());
  return g;
}

// Painted lines on the paved roads: white edge lines and a dashed yellow centre line, as thin
// strips laid on the shown ground (pulled forward in depth so they never fight the asphalt)
function roadPaint() {
  const white = [], yellow = [];
  const strip = (road, lat, w, s0, s1, out) => {
    const pos = [];
    for (let s = s0; s < s1 - 0.01; s += 1) {
      const a = pathPoint(road, s), b = pathPoint(road, Math.min(s1, s + 1));
      const pa = [a.x - a.tz * (lat - w / 2), a.z + a.tx * (lat - w / 2)], pb = [a.x - a.tz * (lat + w / 2), a.z + a.tx * (lat + w / 2)];
      const qa = [b.x - b.tz * (lat - w / 2), b.z + b.tx * (lat - w / 2)], qb = [b.x - b.tz * (lat + w / 2), b.z + b.tx * (lat + w / 2)];
      const y = (p) => visualHeightAt(p[0], p[1]) + 0.03;
      // (wound to face up)
      pos.push(pa[0], y(pa), pa[1], pb[0], y(pb), pb[1], qa[0], y(qa), qa[1], pb[0], y(pb), pb[1], qb[0], y(qb), qb[1], qa[0], y(qa), qa[1]);
    }
    if (pos.length) { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.push(geo); }
  };
  for (const r of ROADS) {
    if (r.surface !== 'paved') continue;
    const hw = r.width / 2, skip = (s) => r.bridges.some((b) => s > b.s0 - 1 && s < b.s1 + 1) || MAP.PADS.some((p) => { const q = pathPoint(r, s); return Math.hypot(q.x - p.x, q.z - p.z) < p.r + 2; });
    // runs between bridges / lots
    let run0 = null;
    const L = r.closed ? r.length - 1 : r.length;
    for (let s = 1; s <= L; s += 1) {
      const bad = skip(s) || s >= L;
      if (!bad && run0 === null) run0 = s;
      if ((bad || s >= L) && run0 !== null) {
        for (const sd of [-1, 1]) strip(r, sd * (hw - 0.35), 0.16, run0, s, white);
        for (let d = run0 + 1; d < s - 3; d += 9) strip(r, 0, 0.14, d, d + 3, yellow);
        run0 = null;
      }
    }
  }
  const g = new THREE.Group(); g.name = 'paint';
  const mk = (geos, color) => {
    if (!geos.length) return;
    const geo = mergeGeometries(geos); geo.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    m.userData.outlineId = 1; // part of the ground: no outline round the stripes
    const mesh = new THREE.Mesh(geo, m); mesh.receiveShadow = true; g.add(mesh);
  };
  mk(white, 0xe8e4d8); mk(yellow, 0xe0b84a);
  return g;
}
