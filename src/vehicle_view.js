// Low-poly vehicle visuals that follow the physics bodies, including
// animated suspension links, springs and shocks so you can watch the axles articulate.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js';
import { vehicleNode } from './art/assets.js';

// No environment map in the scene, so keep metalness low or parts render near-black.
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.7, ...o });
const box = (w, h, l, mat, x = 0, y = 0, z = 0) => {
  const seg = (x) => (x > 0.5 ? 3 : x > 0.25 ? 2 : 1);
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l, seg(w), seg(h), seg(l)), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m;
};
const UP = new THREE.Vector3(0, 1, 0);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

function tube(a, b, r, mat) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 6), mat);
  placeBetween(m, a, b); m.castShadow = true; return m;
}
function placeBetween(mesh, a, b) {
  const d = new THREE.Vector3().subVectors(b, a);
  const L = d.length();
  mesh.position.copy(a).addScaledVector(d, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, d.normalize());
  mesh.scale.set(1, Math.max(L, 1e-3), 1);
}

// Shared materials for lights so the view can make brake lights glow.
function lightMats() {
  return {
    head: std(0xfff4d0, { emissive: 0xfff0c0, emissiveIntensity: 0.6, roughness: 0.2 }),
    tail: std(0x7a0c0c, { emissive: 0xff1a1a, emissiveIntensity: 0.15, roughness: 0.3 }),
    amber: std(0xffa020, { emissive: 0x804000, emissiveIntensity: 0.4 }),
  };
}

function cyl(r, len, mat, axis = 'y', segs = 8) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, segs), mat);
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  m.castShadow = true; return m;
}
function at(m, x, y, z) { m.position.set(x, y, z); return m; }

// a sloped panel: a box whose top is tilted (used for hoods, windscreens)
function wedge(w, h, l, mat, x, y, z, rx) { const b = box(w, h, l, mat, x, y, z); b.rotation.x = rx; return b; }

// a thin panel spanning (z1,y1)->(z2,y2) in the side view, pushed `off` along its outward normal
function slab(z1, y1, z2, y2, w, t, mat, x = 0, off = 0) {
  const dz = z2 - z1, dy = y2 - y1, L = Math.hypot(dz, dy);
  const m = box(w, t, L, mat, x, (y1 + y2) / 2 + (dz / L) * off, (z1 + z2) / 2 - (dy / L) * off);
  m.rotation.x = Math.atan2(-dy, dz);
  return m;
}

// ---------- side-profile body panels ----------
// A body panel drawn as a side silhouette [[z, y], ...] (chassis frame, -Z forward) and
// extruded across the width. Tessellated so dents have vertices to push around.
const TESS = new TessellateModifier(0.32, 5);
// `round` > 0 bevels the extrusion so the panel's outer edges are rounded (toy-like) while
// the silhouette stays inside the given outline (bevelOffset pulls the bevel back in).
function profile(pts, w, mat, x = 0, dentable = true, round = 0) {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(-z, y)));
  const r = Math.min(round, w * 0.3);
  let geo = r > 0
    ? new THREE.ExtrudeGeometry(shape, { depth: w - 2 * r, bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelOffset: -r, bevelSegments: 3, curveSegments: 1 })
    : new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, r > 0 ? -(w - 2 * r) / 2 : -w / 2); geo.rotateY(Math.PI / 2);
  if (dentable) geo = TESS.modify(geo);
  const m = new THREE.Mesh(geo, mat);
  m.position.x = x; m.castShadow = true; m.receiveShadow = true;
  return m;
}
// points along a wheel-arch circle above the cut line yCut, front edge to rear edge
function arcPts(a, r, yCut, n = 9) {
  const s = Math.asin(THREE.MathUtils.clamp((yCut - a.yc) / r, -1, 1));
  const out = [];
  for (let k = 0; k <= n; k++) { const p = s + ((Math.PI - 2 * s) * k) / n; out.push([a.z - r * Math.cos(p), a.yc + r * Math.sin(p)]); }
  return out;
}
// bottom edge of a panel from zA to zB at height y, with the given wheel arches cut out
function bottom(zA, zB, y, arches) {
  const pts = [[zA, y]];
  for (const a of arches) pts.push(...arcPts(a, a.r, y));
  pts.push([zB, y]);
  return pts;
}
// an arch flare: a band following the wheel opening
function flare(a, t, yCut, w, x, mat, round = 0) {
  const r = a.r - 0.015;
  return profile([...arcPts(a, r + t, yCut), ...arcPts(a, r, yCut).reverse()], w, mat, x, false, round);
}
// wheel arch openings for a body: centred a little above the axle so full bump still clears
const arches = (spec, gap, lift) => [-1, 1].map((s) => ({ z: (s * spec.wheelbase) / 2, yc: spec.axleY + lift, r: spec.tire.radius + gap }));

function spareTire(spec, mat, x, y, z, rot = 'z') {
  const r = spec.tire.radius * 0.97, w = spec.tire.width * 0.9;
  const g = new THREE.Group();
  const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 16), std(0x2c2c2e, { roughness: 0.95 }));
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.58, r * 0.58, w * 1.02, 10), mat);
  g.add(t, rim);
  if (rot === 'z') g.rotation.x = Math.PI / 2; else g.rotation.z = Math.PI / 2;
  g.position.set(x, y, z);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

function driver(x, y, z) {
  const g = new THREE.Group();
  const suit = std(0x2a4a6a), skin = std(0xd9a27a), helmet = std(0xf2f2f2, { roughness: 0.3 });
  g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.28), suit), 0, 0.25, 0));
  g.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), helmet), 0, 0.64, -0.02));
  g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.04), std(0x111111)), 0, 0.64, -0.16));
  for (const sx of [-1, 1]) { const arm = box(0.1, 0.1, 0.42, suit, sx * 0.2, 0.36, -0.18); arm.rotation.x = 0.4; g.add(arm); g.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), skin), sx * 0.17, 0.28, -0.38)); }
  g.position.set(x, y, z);
  return g;
}

function steeringWheel(x, y, z, tilt) {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.02, 5, 14), std(0x151515));
  g.add(ring, at(cyl(0.02, 0.32, std(0x151515), 'y', 5), 0, 0, 0));
  g.rotation.x = tilt;
  g.position.set(x, y, z);
  return g;
}

// ---------- road-going rigs ----------
// Chunky, toy-like versions of the concept art: rounded (bevelled) shell panels, oversized
// lamps, bumpers and cargo. All panels stay inside each rig's physics envelope.
const RND = 0.09; // shell edge rounding radius

// round lamp: bezel ring with an emissive lens, facing -Z (or +Z with dir = 1)
function roundLamp(r, lens, bezel, x, y, z, dir = -1) {
  const g = new THREE.Group();
  g.add(at(cyl(r * 1.22, 0.07, bezel, 'z', 14), 0, 0, 0));
  g.add(at(cyl(r, 0.04, lens, 'z', 14), 0, 0, dir * 0.035));
  g.position.set(x, y, z);
  return g;
}
// red jerry can standing upright, long side along Z
function jerryCan(mat, cap, x, y, z) {
  const g = new THREE.Group();
  g.add(box(0.16, 0.4, 0.3, mat, 0, 0.2, 0));
  g.add(box(0.17, 0.03, 0.2, mat, 0, 0.13, 0), box(0.17, 0.03, 0.2, mat, 0, 0.27, 0)); // pressed ribs
  g.add(box(0.05, 0.05, 0.16, cap, 0, 0.42, 0.02)); // handle
  g.add(at(cyl(0.03, 0.06, cap, 'y', 6), 0, 0.42, -0.11));
  g.position.set(x, y, z);
  return g;
}

// Lifted mid-size double-cab pickup: rounded cab, hood bulge, black flares over chunky
// all-terrains, steel bumper with round yellow driving lamps, bed roll bar carrying a light
// bar, an upright spare, red jerry cans and gear bags.
function buildTaco(g, S, spec, M) {
  const { paint, dark, black, glass, steel, chrome, trim, rimMat, L } = M;
  const [cw] = spec.chassis.size, R = spec.tire.radius;
  const yB = spec.axleY + 0.15; // rocker line
  const A = arches(spec, 0.07, 0.07);
  const F = -2.62, gw = cw * 0.9;
  const fog = std(0xffd040, { emissive: 0xffb020, emissiveIntensity: 0.7, roughness: 0.2 });
  // front clip + cab, below the beltline
  S.add(profile([...bottom(F + 0.14, 0.93, yB, [A[0]]), [0.93, 0.64], [-1.1, 0.66], [-2.4, 0.6], [-2.6, 0.5], [F - 0.03, 0.1], [F + 0.03, -0.1]], cw, paint, 0, true, RND));
  // greenhouse (narrower: tumblehome) + glass
  S.add(profile([[-1.1, 0.64], [-0.45, 1.17], [0.84, 1.19], [0.93, 1.11], [0.93, 0.64]], gw, paint, 0, true, RND));
  S.add(profile([[-0.98, 0.72], [-0.49, 1.1], [-0.02, 1.11], [-0.02, 0.72]], gw + 0.02, glass, 0, false));
  S.add(profile([[0.07, 0.72], [0.07, 1.11], [0.66, 1.12], [0.84, 0.98], [0.84, 0.72]], gw + 0.02, glass, 0, false));
  g.add(slab(-1.07, 0.67, -0.47, 1.15, gw - 0.12, 0.02, glass, 0, 0.012)); // raked windscreen
  g.add(box(gw - 0.16, 0.34, 0.02, glass, 0, 0.92, 0.935));
  // hood bulge + scoop
  g.add(slab(-2.35, 0.6, -1.25, 0.66, cw * 0.5, 0.05, paint, 0, 0.02));
  g.add(box(cw * 0.32, 0.07, 0.36, paint, 0, 0.68, -1.75), box(cw * 0.28, 0.05, 0.03, black, 0, 0.68, -1.94));
  // bed: separate side walls so it is open, wheel tubs, tailgate
  const b0 = 1.0, b1 = 2.64, bt = 0.66;
  for (const sx of [-1, 1]) {
    S.add(profile([...bottom(b0, b1, yB, [A[1]]), [b1, bt], [b0, bt]], 0.1, paint, sx * (cw / 2 - 0.05), true, 0.03));
    g.add(box(0.12, 0.04, b1 - b0, black, sx * (cw / 2 - 0.05), bt + 0.02, (b0 + b1) / 2)); // bed rail caps
    g.add(box(0.24, 0.2, 1.0, dark, sx * (cw / 2 - 0.19), 0.2, spec.wheelbase / 2)); // wheel tubs
    g.add(box(0.07, 0.34, 0.12, L.tail, sx * (cw / 2 - 0.01), 0.42, b1 - 0.07)); // tail lamps
  }
  g.add(box(cw, bt - yB, 0.08, paint, 0, (bt + yB) / 2, b0 + 0.04));
  g.add(box(cw - 0.02, bt - yB - 0.1, 0.08, paint, 0, (bt + yB + 0.1) / 2, b1 - 0.04)); // tailgate
  g.add(box(0.36, 0.05, 0.03, black, 0, 0.52, b1 + 0.0)); // tailgate handle
  g.add(box(cw - 0.14, 0.04, b1 - b0 - 0.1, dark, 0, 0.1, (b0 + b1) / 2)); // bed floor
  // roll bar behind the cab with a light bar on top
  const rbY = 1.2, rbZ = b0 + 0.22, rbX = cw / 2 - 0.12;
  for (const sx of [-1, 1]) {
    g.add(tube(V(sx * rbX, bt, rbZ), V(sx * rbX, rbY, rbZ), 0.045, black));
    g.add(tube(V(sx * rbX, bt, rbZ + 0.6), V(sx * rbX, rbY - 0.02, rbZ), 0.035, black)); // braces
  }
  g.add(tube(V(-rbX, rbY, rbZ), V(rbX, rbY, rbZ), 0.045, black));
  g.add(box(1.1, 0.1, 0.1, black, 0, rbY + 0.04, rbZ - 0.02));
  for (let i = -4; i <= 4; i++) g.add(box(0.1, 0.06, 0.03, L.head, i * 0.12, rbY + 0.04, rbZ - 0.08));
  // cargo: upright spare tyre, two red jerry cans, gear bags
  g.add(spareTire(spec, rimMat, cw * 0.18, 0.12 + R * 0.97, rbZ + 0.35, 'z'));
  const can = std(0xc8321e, { roughness: 0.5 }), cap = std(0x2a2b2e, { roughness: 0.8 });
  g.add(jerryCan(can, cap, -cw * 0.3, 0.12, rbZ + 0.3), jerryCan(can, cap, -cw * 0.3 + 0.2, 0.12, rbZ + 0.3));
  const bag = std(0x3c3f38, { roughness: 0.9 }), bag2 = std(0x5a4a36, { roughness: 0.9 });
  g.add(box(0.55, 0.3, 0.4, bag, -cw * 0.18, 0.27, b1 - 0.55), box(0.4, 0.24, 0.3, bag2, cw * 0.22, 0.24, b1 - 0.35));
  // flares, sliders, mirrors, door seams + handles
  for (const sx of [-1, 1]) {
    for (const a of A) S.add(flare(a, 0.13, yB - 0.03, 0.18, sx * (cw / 2 + 0.04), black, 0.04));
    g.add(box(0.14, 0.08, 2.05, black, sx * (cw / 2 + 0.05), yB - 0.02, 0)); // rock sliders
    g.add(box(0.08, 0.17, 0.24, black, sx * (gw / 2 + 0.16), 0.8, -0.92)); // mirrors
    g.add(box(0.14, 0.04, 0.06, black, sx * (gw / 2 + 0.07), 0.74, -0.92));
    for (const z of [-1.05, 0.03, 0.9]) g.add(box(0.012, 0.8, 0.015, black, sx * (cw / 2 + 0.003), (0.64 + yB) / 2 + 0.04, z));
    for (const z of [-0.18, 0.72]) g.add(box(0.03, 0.04, 0.14, black, sx * (cw / 2 + 0.01), 0.5, z));
  }
  // nose: dark grille, wide lamps with amber corners, steel bumper with round yellow lamps
  g.add(box(cw * 0.56, 0.32, 0.06, black, 0, 0.3, F + 0.0));
  for (const y of [0.22, 0.34]) g.add(box(cw * 0.52, 0.03, 0.03, trim, 0, y, F - 0.04));
  for (const sx of [-1, 1]) {
    g.add(box(0.36, 0.16, 0.06, trim, sx * (cw / 2 - 0.24), 0.36, F + 0.06));
    g.add(box(0.24, 0.12, 0.04, L.head, sx * (cw / 2 - 0.27), 0.36, F + 0.02));
    g.add(box(0.1, 0.12, 0.05, L.amber, sx * (cw / 2 - 0.08), 0.36, F + 0.08));
  }
  g.add(box(cw * 1.04, 0.3, 0.3, trim, 0, -0.06, F - 0.06)); // steel bumper
  g.add(box(cw * 0.6, 0.08, 0.06, black, 0, 0.12, F - 0.15)); // bumper top hoop
  for (const sx of [-1, 1]) {
    g.add(tube(V(sx * cw * 0.3, 0.1, F - 0.15), V(sx * cw * 0.28, 0.42, F - 0.12), 0.035, black)); // grille guard uprights
    g.add(roundLamp(0.1, fog, black, sx * 0.34, 0.02, F - 0.24));
    g.add(box(0.1, 0.06, 0.04, L.amber, sx * (cw / 2 - 0.02), -0.08, F - 0.22));
  }
  g.add(tube(V(-cw * 0.28, 0.42, F - 0.12), V(cw * 0.28, 0.42, F - 0.12), 0.035, black));
  g.add(box(cw * 1.0, 0.24, 0.22, trim, 0, -0.06, b1 + 0.1)); // rear bumper
  g.add(box(0.1, 0.1, 0.25, steel, 0, -0.12, b1 + 0.24)); // hitch
  g.add(at(cyl(0.045, 0.5, chrome, 'z'), cw * 0.32, -0.2, b1 - 0.1)); // exhaust
}

// 70-series-style wagon: boxy, upright, rounded edges; flat slatted grille between round lamps,
// amber corners, black flares, steel bumper, black roof-rack basket, barn doors with spare.
function buildLC70(g, S, spec, M) {
  const { paint, black, glass, steel, chrome, trim, rimMat, L } = M;
  const [cw] = spec.chassis.size;
  const yB = spec.axleY + 0.12;
  const A = arches(spec, 0.07, 0.08);
  const F = -2.45, Bk = 2.42, gw = cw * 0.94, cowl = -0.95;
  S.add(profile([...bottom(F + 0.06, Bk, yB, A), [Bk, 0.66], [-1.0, 0.68], [F + 0.06, 0.64], [F, 0.58], [F, -0.12]], cw, paint, 0, true, RND));
  S.add(profile([[cowl, 0.66], [cowl + 0.14, 1.22], [Bk - 0.06, 1.24], [Bk - 0.02, 0.66]], gw, paint, 0, true, RND));
  for (const [z0, z1] of [[-0.8, -0.06], [0.04, 0.8], [0.92, 1.6], [1.68, 2.26]]) {
    S.add(profile([[z0 + (z0 < -0.5 ? 0.04 : 0), 0.74], [z0 + (z0 < -0.5 ? 0.12 : 0), 1.14], [z1, 1.14], [z1, 0.74]], gw + 0.02, glass, 0, false));
  }
  g.add(slab(cowl + 0.03, 0.7, cowl + 0.15, 1.17, gw - 0.14, 0.02, glass, 0, 0.012)); // upright windscreen
  for (const sx of [-1, 1]) g.add(box(gw * 0.4, 0.38, 0.02, glass, sx * gw * 0.24, 0.95, Bk + 0.005)); // barn door glass
  g.add(box(0.02, 1.0, 0.03, black, -0.12, 0.6, Bk + 0.01)); // 60/40 split
  for (const sx of [-1, 1]) g.add(box(0.03, 0.04, 3.3, black, sx * (gw / 2 - 0.01), 1.24, 0.75)); // drip rails
  // hood: raised centre panel and seams
  g.add(box(cw * 0.5, 0.04, 1.4, paint, 0, 0.69, -1.7));
  for (const sx of [-1, 1]) g.add(box(0.015, 0.012, 1.45, black, sx * cw * 0.28, 0.675, -1.7));
  // flares, steps, mirrors, handles, tail lamps
  for (const sx of [-1, 1]) {
    for (const a of A) S.add(flare(a, 0.13, yB - 0.03, 0.17, sx * (cw / 2 + 0.04), black, 0.04));
    g.add(box(0.16, 0.06, 1.5, black, sx * (cw / 2 + 0.05), yB - 0.02, 0)); // side steps
    g.add(box(0.03, 0.17, 0.22, black, sx * (gw / 2 + 0.2), 0.9, -0.72)); // square mirrors
    g.add(box(0.2, 0.03, 0.03, black, sx * (gw / 2 + 0.1), 0.82, -0.72));
    for (const z of [-0.85, -0.03, 0.85]) g.add(box(0.012, 0.85, 0.015, black, sx * (cw / 2 + 0.003), (0.66 + yB) / 2 + 0.06, z));
    for (const z of [-0.2, 0.62]) g.add(box(0.03, 0.04, 0.14, black, sx * (cw / 2 + 0.01), 0.58, z));
    g.add(box(0.03, 0.18, 0.24, paint, sx * (cw / 2 + 0.005), 0.5, 1.9)); // fuel flap
    g.add(box(0.06, 0.3, 0.14, L.tail, sx * (cw / 2 - 0.08), 0.3, Bk + 0.02)); // tail lamps
    g.add(box(0.06, 0.08, 0.14, L.amber, sx * (cw / 2 - 0.08), 0.1, Bk + 0.02));
  }
  // face: flat black grille with horizontal slats between round lamps in square bezels
  g.add(box(cw * 0.48, 0.34, 0.05, black, 0, 0.36, F - 0.02));
  for (const y of [0.25, 0.32, 0.39, 0.46]) g.add(box(cw * 0.44, 0.025, 0.03, trim, 0, y, F - 0.05));
  g.add(box(cw * 0.5, 0.035, 0.04, steel, 0, 0.545, F - 0.03)); // grille top strip
  for (const sx of [-1, 1]) {
    g.add(box(0.28, 0.28, 0.04, black, sx * (cw / 2 - 0.3), 0.38, F - 0.02));
    g.add(roundLamp(0.095, L.head, steel, sx * (cw / 2 - 0.3), 0.38, F - 0.03));
    g.add(box(0.1, 0.22, 0.06, L.amber, sx * (cw / 2 - 0.08), 0.38, F - 0.01)); // amber corners
  }
  // roof-rack basket: perimeter rails on legs, crossbars, wind deflector
  const rx = gw / 2 - 0.04, rz0 = -0.6, rz1 = 2.1, ry = 1.4;
  for (const sx of [-1, 1]) {
    g.add(tube(V(sx * rx, ry, rz0), V(sx * rx, ry, rz1), 0.03, black));
    g.add(tube(V(sx * rx, ry - 0.1, rz0 + 0.05), V(sx * rx, ry - 0.1, rz1 - 0.05), 0.022, black));
    for (const z of [rz0 + 0.1, 0.75, rz1 - 0.1]) g.add(box(0.06, 0.18, 0.08, black, sx * rx, 1.3, z)); // legs
  }
  for (const z of [rz0, rz1]) g.add(tube(V(-rx, ry, z), V(rx, ry, z), 0.03, black));
  for (let i = 1; i < 7; i++) g.add(box(gw - 0.1, 0.025, 0.04, black, 0, ry - 0.1, rz0 + (i * (rz1 - rz0)) / 7));
  g.add(box(gw - 0.06, 0.1, 0.04, black, 0, ry + 0.05, rz0 - 0.02)); // wind deflector
  // spare on the barn door, steel bumpers
  g.add(spareTire(spec, rimMat, 0.3, 0.62, Bk + 0.18, 'z'));
  g.add(box(cw * 1.02, 0.26, 0.24, trim, 0, -0.06, F - 0.08));
  for (const sx of [-1, 1]) g.add(box(0.12, 0.05, 0.04, L.amber, sx * (cw / 2 - 0.15), -0.06, F - 0.21));
  g.add(box(cw * 1.0, 0.22, 0.18, trim, 0, -0.1, Bk + 0.08));
  g.add(at(cyl(0.04, 0.5, chrome, 'z'), -cw * 0.3, -0.25, Bk - 0.15));
}

// Rounded early-2000s rally sedan: low nose, big bonnet scoop, blistered arches, tall rear
// wing, two big round driving lamps, gold wheels and an original gold swoosh livery.
function buildWRX(g, S, spec, M) {
  const { paint, black, glass, steel, L } = M;
  const [cw] = spec.chassis.size, ay = spec.axleY, wb = spec.wheelbase, R = spec.tire.radius;
  const yB = ay + 0.04;
  const A = arches(spec, 0.065, 0.045);
  const F = -2.2, Bk = 2.2, gw = cw * 0.84;
  const gold = std(0xd8b040, { roughness: 0.5 });
  const lamp = std(0xfff6dc, { emissive: 0xfff0c0, emissiveIntensity: 0.7, roughness: 0.2 });
  S.add(profile([...bottom(F + 0.08, Bk - 0.06, yB, A), [Bk, -0.1], [Bk + 0.02, 0.22], [Bk - 0.05, 0.38], [1.55, 0.41], [-1.05, 0.38], [-1.9, 0.26], [F, 0.12], [F - 0.02, -0.1]], cw, paint, 0, true, RND));
  S.add(profile([[-1.05, 0.36], [-0.3, 0.84], [0.7, 0.86], [1.55, 0.39]], gw, paint, 0, true, 0.12));
  S.add(profile([[-0.9, 0.44], [-0.32, 0.79], [0.12, 0.8], [0.12, 0.44]], gw + 0.02, glass, 0, false));
  S.add(profile([[0.2, 0.44], [0.2, 0.8], [0.66, 0.81], [1.12, 0.5], [1.12, 0.44]], gw + 0.02, glass, 0, false));
  g.add(slab(-1.02, 0.41, -0.32, 0.83, gw - 0.14, 0.02, glass, 0, 0.012));
  g.add(slab(0.74, 0.84, 1.5, 0.44, gw - 0.16, 0.02, glass, 0, 0.012));
  // blistered arches in body colour
  for (const sx of [-1, 1]) {
    for (const a of A) S.add(flare(a, 0.08, yB - 0.04, 0.18, sx * (cw / 2 + 0.02), paint, 0.05));
    g.add(box(0.06, 0.08, 1.7, black, sx * (cw / 2 + 0.01), yB + 0.01, 0)); // side skirts
    g.add(box(0.06, 0.11, 0.18, paint, sx * (gw / 2 + 0.14), 0.47, -0.82)); // mirrors
    g.add(box(0.1, 0.03, 0.05, black, sx * (gw / 2 + 0.07), 0.44, -0.84));
    g.add(box(0.012, 0.6, 0.015, black, sx * (cw / 2 + 0.003), 0.08, 0.16)); // door seam
    for (const z of [-0.3, 0.55]) g.add(box(0.025, 0.035, 0.12, black, sx * (cw / 2 + 0.008), 0.3, z)); // handles
    g.add(box(0.3, 0.12, 0.05, L.tail, sx * (cw / 2 - 0.2), 0.27, Bk + 0.0)); // tail lamps
    // livery: a gold crescent swoosh sweeping back along the doors, three trailing dots
    const sw = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.3, 18, 1, Math.PI * 0.55, Math.PI * 0.95), gold);
    sw.rotation.y = sx * Math.PI / 2;
    sw.position.set(sx * (cw / 2 + 0.012), 0.08, -0.05); g.add(sw);
    const tail = box(0.012, 0.045, 1.1, gold, sx * (cw / 2 + 0.012), 0.3, 0.52); tail.rotation.x = -0.12; g.add(tail);
    for (const [z, y, s] of [[0.2, 0.08, 0.07], [0.38, 0.13, 0.055], [0.53, 0.17, 0.045]]) {
      const d = box(0.012, s, s, gold, sx * (cw / 2 + 0.012), y, z); d.rotation.x = Math.PI / 4; g.add(d);
    }
    // mud flaps behind each wheel
    for (const z of [-wb / 2, wb / 2]) g.add(box(0.2, 0.3, 0.02, black, sx * (spec.track / 2), ay - 0.12, z + R + 0.09));
  }
  // big bonnet scoop
  g.add(wedge(0.56, 0.1, 0.5, paint, 0, 0.36, -1.55, 0.14));
  g.add(box(0.46, 0.06, 0.02, black, 0, 0.37, -1.8));
  // nose: swept lamps, small grille, wide intake, two big round driving lamps
  for (const sx of [-1, 1]) { const h = box(0.4, 0.11, 0.08, L.head, sx * (cw / 2 - 0.26), 0.17, F + 0.06); h.rotation.y = -sx * 0.3; h.rotation.z = sx * 0.08; g.add(h); }
  g.add(box(cw * 0.32, 0.1, 0.05, black, 0, 0.1, F - 0.02));
  g.add(box(cw * 0.62, 0.13, 0.05, black, 0, -0.1, F - 0.01));
  for (const sx of [-1, 1]) {
    g.add(roundLamp(0.11, lamp, black, sx * 0.48, -0.06, F - 0.06));
    g.add(box(0.14, 0.06, 0.05, black, sx * (cw / 2 - 0.12), -0.14, F + 0.01)); // fog vents
  }
  g.add(box(cw * 0.9, 0.04, 0.12, black, 0, -0.2, F + 0.02)); // front lip
  // tall rear wing on pylons with endplates
  for (const sx of [-0.55, 0.55]) { const p = box(0.06, 0.3, 0.18, paint, sx, 0.52, Bk - 0.24); p.rotation.x = -0.25; g.add(p); }
  g.add(wedge(cw * 0.9, 0.05, 0.34, paint, 0, 0.68, Bk - 0.16, -0.12));
  for (const sx of [-1, 1]) g.add(box(0.04, 0.16, 0.38, paint, sx * cw * 0.45, 0.7, Bk - 0.16));
  g.add(box(cw * 0.7, 0.04, 1.1, steel, 0, -0.2, F + 0.8)); // sump guard
  for (const sx of [-1, 1]) g.add(at(cyl(0.05, 0.3, steel, 'z'), sx * cw * 0.28, -0.17, Bk));
}

function buildBody(spec) {
  const g = new THREE.Group();
  const L = lightMats();
  g.userData.lights = L;
  const paint = std(spec.color, { roughness: 0.45, metalness: 0.1 });
  const dark = std(0x3a3c40, { roughness: 0.85 });
  const black = std(0x2a2b2e, { roughness: 0.8 });
  const trim = std(0x34363a, { roughness: 0.6 });
  const glass = std(0x26323e, { roughness: 0.12, metalness: 0.2 });
  const steel = std(0x9a9ea4, { metalness: 0.3, roughness: 0.4 });
  const chrome = std(0xd0d3d8, { metalness: 0.4, roughness: 0.25 });
  const rimMat = std(spec.rimColor ?? RIM[spec.body] ?? 0x9aa0a6, { metalness: 0.3, roughness: 0.4 });
  if (spec.body === 'taco' || spec.body === 'lc70' || spec.body === 'wrx') {
    const S = new THREE.Group(); // extruded shell panels (a group so rig views can hide them)
    g.add(S); g.userData.shell = S;
    ({ taco: buildTaco, lc70: buildLC70, wrx: buildWRX })[spec.body](g, S, spec, { paint, dark, black, glass, steel, chrome, trim, rimMat, L });
    return g;
  }
  const [cw, ch, cl] = spec.chassis.size;
  const y0 = ch / 2;
  const fz = -cl / 2; // front of the truck (-Z is forward)
  g.add(box(cw * 0.7, 0.05, cl * 0.45, steel, 0, -ch * 0.46, -0.1)); // skid plate

  if (spec.body === 'buggy') {
    const hw = cw * 0.5, top = y0 + 1.1;
    const P = [V(-hw, y0, -0.95), V(hw, y0, -0.95), V(-hw, y0, 1.15), V(hw, y0, 1.15),
      V(-hw * 0.78, top, -0.3), V(hw * 0.78, top, -0.3), V(-hw * 0.78, top, 0.95), V(hw * 0.78, top, 0.95)];
    const cage = [[0, 4], [1, 5], [2, 6], [3, 7], [4, 5], [6, 7], [4, 6], [5, 7], [0, 1], [2, 3], [0, 2], [1, 3], [4, 7], [0, 6]];
    for (const [a, b] of cage) g.add(tube(P[a], P[b], 0.035, paint));
    const nose = [V(-hw * 0.55, y0 - 0.05, fz + 0.05), V(hw * 0.55, y0 - 0.05, fz + 0.05), V(-hw * 0.55, y0 + 0.4, fz + 0.4), V(hw * 0.55, y0 + 0.4, fz + 0.4)];
    g.add(tube(P[0], nose[0], 0.03, paint), tube(P[1], nose[1], 0.03, paint), tube(nose[0], nose[1], 0.03, paint), tube(nose[2], nose[3], 0.03, paint),
      tube(nose[0], nose[2], 0.03, paint), tube(nose[1], nose[3], 0.03, paint), tube(P[4], nose[2], 0.03, paint), tube(P[5], nose[3], 0.03, paint));
    const tail = [V(-hw * 0.6, y0 + 0.1, cl / 2 - 0.05), V(hw * 0.6, y0 + 0.1, cl / 2 - 0.05)];
    g.add(tube(P[2], tail[0], 0.03, paint), tube(P[3], tail[1], 0.03, paint), tube(tail[0], tail[1], 0.03, paint), tube(P[6], tail[0], 0.03, paint), tube(P[7], tail[1], 0.03, paint));
    g.add(box(cw * 0.92, 0.05, 2.05, dark, 0, y0, 0.1)); // floor pan
    g.add(box(0.03, 0.5, 1.6, std(0x4a525a), -hw, y0 + 0.3, 0.1), box(0.03, 0.5, 1.6, std(0x4a525a), hw, y0 + 0.3, 0.1)); // side panels
    for (const sx of [-0.3, 0.3]) {
      g.add(box(0.46, 0.1, 0.5, std(0x9a1d1d), sx, y0 + 0.12, 0.35)); // seat base
      const back = box(0.46, 0.7, 0.1, std(0x9a1d1d), sx, y0 + 0.5, 0.62); back.rotation.x = -0.15; g.add(back);
    }
    g.add(driver(-0.3, y0 + 0.12, 0.42));
    g.add(steeringWheel(-0.3, y0 + 0.65, -0.08, -0.9));
    g.add(box(0.5, 0.42, 0.65, steel, 0, y0 + 0.22, fz + 0.75)); // engine
    g.add(box(0.14, 0.1, 0.6, chrome, -0.2, y0 + 0.47, fz + 0.75), box(0.14, 0.1, 0.6, chrome, 0.2, y0 + 0.47, fz + 0.75));
    g.add(at(cyl(0.16, 0.08, chrome), 0, y0 + 0.6, fz + 0.75));
    g.add(box(cw * 0.75, 0.25, 0.12, black, 0, y0 + 0.1, fz + 0.1)); // radiator
    for (const sx of [-0.35, 0.35]) g.add(at(cyl(0.08, 0.08, L.head, 'z'), sx, y0 + 0.42, fz + 0.36));
    g.add(box(1.0, 0.09, 0.08, black, 0, top + 0.06, -0.33));
    for (let i = -3; i <= 3; i++) g.add(box(0.11, 0.06, 0.03, L.head, i * 0.14, top + 0.06, -0.38));
    for (const sx of [-0.45, 0.45]) g.add(box(0.12, 0.08, 0.04, L.tail, sx * hw * 1.2, y0 + 0.15, cl / 2 - 0.02));
    g.add(spareTire(spec, rimMat, 0, y0 + 0.62, cl / 2 + 0.05, 'z'));
    g.add(box(0.55, 0.3, 0.35, std(0x3a3a3a), 0, y0 + 0.2, cl * 0.38)); // fuel cell
    g.add(box(0.5, 0.18, 0.2, black, 0, y0 - 0.02, fz - 0.05)); // winch
    g.add(at(cyl(0.04, 0.9, chrome, 'z'), 0.35, y0 + 0.2, cl * 0.2));
  } else {
    const cabZ = fz + 1.05, R = spec.tire.radius, ay = spec.axleY;
    // cab-over expedition truck
    g.add(box(cw, 1.4, 1.8, paint, 0, y0 + 0.8, cabZ));
    g.add(wedge(cw * 0.92, 0.7, 0.06, glass, 0, y0 + 1.15, cabZ - 0.92, -0.12));
    for (const sx of [-1, 1]) {
      g.add(box(0.04, 0.55, 1.0, glass, sx * (cw / 2 + 0.005), y0 + 1.15, cabZ - 0.2));
      g.add(box(0.06, 0.4, 0.05, black, sx * (cw / 2 + 0.28), y0 + 1.1, cabZ - 0.85)); // mirror
      g.add(box(0.24, 0.04, 0.04, black, sx * (cw / 2 + 0.14), y0 + 1.3, cabZ - 0.85)); // mirror arm
      g.add(box(0.5, 0.06, 0.25, steel, sx * (cw / 2 - 0.2), y0 + 0.05, cabZ - 0.2)); // step
    }
    g.add(box(cw * 0.9, 0.5, 0.06, black, 0, y0 + 0.45, cabZ - 0.92)); // grille
    for (let i = -4; i <= 4; i++) g.add(box(cw * 0.86, 0.03, 0.02, steel, 0, y0 + 0.3 + i * 0.04 + 0.15, cabZ - 0.955));
    for (const sx of [-1, 1]) { g.add(at(cyl(0.12, 0.08, L.head, 'z'), sx * (cw / 2 - 0.25), y0 + 0.4, cabZ - 0.93)); g.add(box(0.12, 0.08, 0.05, L.amber, sx * (cw / 2 - 0.08), y0 + 0.62, cabZ - 0.93)); }
    g.add(box(cw * 1.0, 0.08, 1.7, black, 0, y0 + 1.55, cabZ)); // roof rack
    for (let i = -3; i <= 3; i++) g.add(box(0.15, 0.1, 0.06, L.head, i * 0.25, y0 + 1.62, cabZ - 0.85));
    g.add(steeringWheel(-0.5, y0 + 0.95, cabZ - 0.55, -0.6));
    g.add(driver(-0.5, y0 + 0.45, cabZ - 0.1));
    const sn = cyl(0.08, 1.7, black); sn.position.set(cw / 2 + 0.08, y0 + 1.25, cabZ - 0.75); g.add(sn); // snorkel
    g.add(at(cyl(0.11, 0.18, black, 'z'), cw / 2 + 0.08, y0 + 2.08, cabZ - 0.83));
    // camper box with windows, door, ladder, roof cargo
    const boxZ = cabZ + 0.9 + cl * 0.29, boxL = cl * 0.56;
    g.add(box(cw * 1.04, 1.6, boxL, std(0xe2dccb, { roughness: 0.6 }), 0, y0 + 0.95, boxZ));
    for (const sx of [-1, 1]) for (const z of [-0.3, 0.25]) g.add(box(0.03, 0.4, 0.7, glass, sx * (cw * 0.52 + 0.01), y0 + 1.2, boxZ + z * boxL));
    g.add(box(0.6, 1.2, 0.04, std(0xbdb6a2), 0.3, y0 + 0.8, boxZ + boxL / 2 + 0.02));
    for (let i = 0; i < 6; i++) g.add(box(0.4, 0.04, 0.04, steel, -0.5, y0 + 0.3 + i * 0.25, boxZ + boxL / 2 + 0.08));
    g.add(box(0.5, 0.45, 0.5, std(0x8a7a5a), -0.4, y0 + 1.98, boxZ + 0.6), box(1.0, 0.12, 0.6, std(0x445544), 0.3, y0 + 1.82, boxZ - 0.3));
    g.add(spareTire(spec, rimMat, 0, y0 + 1.0, boxZ + boxL / 2 + 0.25 + spec.tire.width * 0.4, 'z'));
    for (const sx of [-1, 1]) g.add(box(0.2, 0.12, 0.05, L.tail, sx * (cw / 2 - 0.15), y0 + 0.1, boxZ + boxL / 2 + 0.03));
    g.add(box(cw * 1.08, 0.3, 0.28, black, 0, y0 - 0.02, cabZ - 1.05)); // bumper
    g.add(box(0.6, 0.24, 0.24, std(0x404040), 0, y0 - 0.02, cabZ - 1.22));
    for (const sx of [-1, 1]) g.add(box(0.15, 0.4, 0.3, std(0x3c3c3c), sx * (cw * 0.42), -0.25, 0.1)); // tanks
    // mudguards over the big tyres (front ones tucked under the cab)
    const S = new THREE.Group(); g.add(S); g.userData.shell = S;
    for (const a of arches(spec, 0.1, 0.06)) for (const sx of [-1, 1]) {
      S.add(flare(a, 0.05, a.yc + (a.r) * 0.15, spec.tire.width + 0.14, sx * spec.track / 2, black));
      g.add(box(0.06, 0.06, 0.06, black, sx * (spec.track / 2 - spec.tire.width / 2 - 0.1), ay + R + 0.12, a.z)); // stay
    }
  }
  return g;
}

// Swap in public/models/vehicles/<id>.glb (docs/MODELING_SPEC.md) when it exists: visuals only.
// Body replaces the procedural body (and becomes the dentable shell), Wheel replaces each wheel
// (mirrored on the left), AxleFront/AxleRear and Hub ride on the procedural rig (see constructor).
// Physics and the procedural suspension links are unchanged.
function useVehicleAsset(view, spec) {
  const body = vehicleNode(spec.id, 'Body');
  if (!body) return;
  for (const c of [...view.body.children]) { c.visible = false; c.traverse((o) => { o.userData.noDent = true; }); }
  body.traverse((o) => {
    if (!o.isMesh) return;
    o.userData.dentable = true;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m.name === 'TailLight') view.tailMats.push(m);
  });
  view.body.add(body);
  const wheel = vehicleNode(spec.id, 'Wheel');
  if (wheel) {
    // garage tyre sizes: stretch the modelled tyre to the physics tyre
    const { tyre_radius: r0, tyre_width: w0 } = wheel.userData;
    const sr = r0 ? spec.tire.radius / r0 : 1, sw = w0 ? spec.tire.width / w0 : 1;
    if (spec.rimColor != null) tintWheelRim(wheel, spec.rimColor, r0 || spec.tire.radius);
    view.assetWheel = true;
    view.wheels.forEach((w, i) => {
      w.children.forEach((c) => { c.visible = false; });
      // clone from the pristine node: cloning after mirroring wheel 0 copied its flipped scale,
      // so FR/RR came out mirrored (bare inner face outwards) and RL un-mirrored
      const m = wheel.clone(true);
      m.scale.set(i % 2 === 0 ? -sw : sw, sr, sr); // modelled as the right wheel: mirror for the left side
      m.userData.wheelAsset = true;
      w.add(m);
    });
  }
  view.assetAxles = ['AxleFront', 'AxleRear'].map((n) => vehicleNode(spec.id, n));
  view.assetHub = vehicleNode(spec.id, 'Hub');
}

// Garage rim colour on a glTF wheel (one textured mesh). Its rim faces move into a child mesh
// whose texture is the wheel texture recoloured to `color`, keeping the light/dark detail; the
// tyre keeps the original material. Rim faces: everything inside 0.55 R, plus faces further out
// whose texel colour never appears on the tread/outer sidewall (bright rim lips).
function tintWheelRim(wheel, color, R) {
  if (typeof document === 'undefined') return;
  const meshes = [];
  wheel.traverse((o) => { if (o.isMesh && o.geometry.index && o.geometry.attributes.uv && o.material.map?.image) meshes.push(o); });
  for (const mesh of meshes) {
    const g = mesh.geometry, mat = mesh.material, img = mat.map.image;
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    const data = cx.getImageData(0, 0, cv.width, cv.height);
    const px = data.data;
    const pos = g.attributes.position, uv = g.attributes.uv, idx = g.index;
    const faces = [];
    for (let f = 0; f < idx.count; f += 3) {
      let r = 0, u = 0, v = 0;
      for (let k = 0; k < 3; k++) { const i = idx.getX(f + k); r += Math.hypot(pos.getY(i), pos.getZ(i)); u += uv.getX(i); v += uv.getY(i); }
      const tx = THREE.MathUtils.clamp(Math.floor((u / 3) * cv.width), 0, cv.width - 1);
      const ty = THREE.MathUtils.clamp(Math.floor((mat.map.flipY ? 1 - v / 3 : v / 3) * cv.height), 0, cv.height - 1);
      const o = (ty * cv.width + tx) * 4;
      faces.push({ f, r: r / 3 / R, key: (px[o] >> 4) << 8 | (px[o + 1] >> 4) << 4 | (px[o + 2] >> 4), lum: (0.3 * px[o] + 0.59 * px[o + 1] + 0.11 * px[o + 2]) / 255 });
    }
    const tyreKeys = new Set(faces.filter((t) => t.r >= 0.85).map((t) => t.key));
    const rim = [], tyre = [];
    let lref = 0;
    for (const t of faces) {
      const isRim = t.r < 0.55 || (t.r < 0.85 && !tyreKeys.has(t.key));
      for (let k = 0; k < 3; k++) (isRim ? rim : tyre).push(idx.getX(t.f + k));
      if (isRim) lref += t.lum;
    }
    if (!rim.length) continue;
    lref = Math.max(0.04, lref / (rim.length / 3));
    const c = new THREE.Color(color); // sRGB components, like the texture bytes
    for (let o = 0; o < px.length; o += 4) {
      const k = THREE.MathUtils.clamp((0.3 * px[o] + 0.59 * px[o + 1] + 0.11 * px[o + 2]) / 255 / lref, 0.45, 1.4);
      px[o] = Math.min(255, c.r * 255 * k); px[o + 1] = Math.min(255, c.g * 255 * k); px[o + 2] = Math.min(255, c.b * 255 * k);
    }
    cx.putImageData(data, 0, 0);
    const map = new THREE.CanvasTexture(cv);
    for (const k of ['flipY', 'colorSpace', 'wrapS', 'wrapT', 'magFilter', 'minFilter']) map[k] = mat.map[k];
    const rimMat = mat.clone();
    rimMat.name = mat.name + '_rim'; rimMat.map = map;
    const sub = (list) => { const s = new THREE.BufferGeometry(); for (const [n, a] of Object.entries(g.attributes)) s.setAttribute(n, a); s.setIndex(list); return s; };
    mesh.geometry = sub(tyre);
    const rm = new THREE.Mesh(sub(rim), rimMat);
    rm.name = 'WheelRim'; rm.castShadow = rm.receiveShadow = true;
    mesh.add(rm);
  }
}

const RIM = { taco: 0x8f7550, lc70: 0x6a6e74, wrx: 0xc9a43a, buggy: 0x3c3e42, truck: 0x6d6d4a };

function buildWheel(spec) {
  const t = spec.tire;
  const g = new THREE.Group();
  const rubber = std(0x3a3a3d, { roughness: 0.95 });
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(t.radius * 0.92, t.radius * 0.92, t.width, 20), rubber);
  tire.rotation.z = Math.PI / 2; tire.castShadow = true;
  // tread lugs, wrapping slightly onto the shoulders
  const lugs = [];
  // garage tread: mud-terrains get fewer, chunkier lugs; rock compound sits in between
  const lug = ({ mt: [0.72, 1.35], rock: [0.85, 1.15] }[t.tread] || [1, 1]).slice();
  if (spec.body === 'taco' || spec.body === 'lc70') lug[1] *= 1.3; // chunky all-terrain lugs
  const n = Math.round((spec.body === 'wrx' ? 22 : 18) * lug[0]);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    for (const side of [-1, 1]) {
      const l = new THREE.BoxGeometry(t.width * 0.5, t.radius * 0.09 * lug[1], t.radius * 0.2 * lug[1]);
      l.translate(side * t.width * 0.26, t.radius * 0.955, (i % 2 ? 0.03 : -0.03) * side);
      l.rotateX(a + (side > 0 ? 0.08 : 0));
      lugs.push(l);
    }
  }
  const lugMesh = new THREE.Mesh(mergeGeometries(lugs), rubber);
  lugMesh.castShadow = true;
  const rimMat = std(spec.rimColor ?? RIM[spec.body] ?? 0x9aa0a6, { metalness: 0.3, roughness: 0.4 });
  const rimR = t.radius * (spec.body === 'wrx' ? 0.62 : 0.56);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(rimR, rimR, t.width * 1.02, 12), rimMat);
  rim.rotation.z = Math.PI / 2;
  g.add(tire, lugMesh, rim);
  if (spec.body !== 'wrx' && spec.body !== 'lc70') {
    const ring = std(spec.body === 'buggy' ? 0xc03020 : 0x2a2a2a);
    for (const s of [-1, 1]) { const bl = new THREE.Mesh(new THREE.TorusGeometry(rimR, 0.028, 5, 14), ring); bl.rotation.y = Math.PI / 2; bl.position.x = s * t.width * 0.52; g.add(bl); }
  }
  // spokes (dark, so rotation is visible) + hub cap
  // rally wheel: dark barrel with six thick spokes in the rim colour
  if (spec.body === 'wrx') rim.material = std(0x2e3034, { roughness: 0.6 });
  const spokeMat = spec.body === 'wrx' ? rimMat : std(0x2e3034, { roughness: 0.6 });
  const ns = spec.body === 'wrx' ? 3 : 6;
  for (const side of [-1, 1]) {
    for (let i = 0; i < ns; i++) {
      const s = box(0.025, rimR * 1.85, rimR * (spec.body === 'wrx' ? 0.28 : 0.2), spokeMat, side * t.width * 0.515, 0, 0);
      s.rotation.x = (i / ns) * Math.PI; g.add(s);
    }
    g.add(at(cyl(rimR * 0.25, 0.04, rimMat, 'x', 8), side * t.width * 0.53, 0, 0));
  }
  return g;
}

// Coilover / shock: spring (helix stretched to length) around a shock body + shaft.
class Coilover {
  constructor(parent, springMat, bodyMat, shaftMat, r = 0.07, spring = true) {
    this.g = new THREE.Group();
    if (spring) {
      const pts = [];
      const turns = 7, segs = turns * 10;
      for (let i = 0; i <= segs; i++) { const a = (i / segs) * turns * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, i / segs - 0.5, Math.sin(a) * r)); }
      this.spring = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), segs, r * 0.17, 5), springMat);
      this.spring.castShadow = true;
      this.g.add(this.spring);
    }
    const br = spring ? r * 0.62 : r;
    this.body = new THREE.Mesh(new THREE.CylinderGeometry(br, br, 1, 8), bodyMat);
    this.shaft = new THREE.Mesh(new THREE.CylinderGeometry(br * 0.4, br * 0.4, 1, 6), shaftMat);
    const capR = spring ? r * 1.25 : br * 1.3;
    this.capT = new THREE.Mesh(new THREE.CylinderGeometry(capR, capR, 0.03, 10), bodyMat);
    this.capB = this.capT.clone();
    this.eyeT = new THREE.Mesh(new THREE.SphereGeometry(br * 0.9, 6, 4), bodyMat);
    this.eyeB = this.eyeT.clone();
    for (const m of [this.body, this.shaft]) m.castShadow = true;
    this.g.add(this.body, this.shaft, this.capT, this.capB, this.eyeT, this.eyeB);
    parent.add(this.g);
  }
  // a = top mount (chassis), b = bottom mount (axle / arm / knuckle), world space
  update(a, b) {
    const d = new THREE.Vector3().subVectors(a, b);
    const L = Math.max(0.05, d.length());
    this.g.position.copy(b);
    this.g.quaternion.setFromUnitVectors(UP, d.normalize());
    const bodyL = Math.min(0.34, L * 0.55);
    this.body.scale.y = bodyL; this.body.position.y = bodyL / 2;
    this.shaft.scale.y = Math.max(0.02, L - bodyL); this.shaft.position.y = bodyL + (L - bodyL) / 2;
    if (this.spring) { this.spring.scale.y = L * 0.8; this.spring.position.y = L * 0.52; }
    this.capB.position.y = this.spring ? L * 0.12 : bodyL; this.capT.position.y = this.spring ? L * 0.92 : L;
    this.eyeT.position.y = L;
  }
  set visible(v) { this.g.visible = v; }
}

// a link bar with rod ends
class Link {
  constructor(parent, mat, r = 0.032, endMat) {
    this.bar = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 7), mat);
    this.e1 = new THREE.Mesh(new THREE.SphereGeometry(r * 1.6, 7, 5), endMat || mat);
    this.e2 = this.e1.clone();
    this.bar.castShadow = true;
    parent.add(this.bar, this.e1, this.e2);
  }
  update(a, b) { placeBetween(this.bar, a, b); this.e1.position.copy(a); this.e2.position.copy(b); }
  set visible(v) { this.bar.visible = this.e1.visible = this.e2.visible = v; }
}

// Leaf spring pack: fixed front eye on a frame hanger, centre clamped under the axle,
// rear eye on a swinging shackle. Main leaf bends in two segments per half, with
// shorter leaves stacked under the centre.
const LEAF_GEO = new THREE.BoxGeometry(1, 1, 1);
class LeafPack {
  constructor(parent, mat, shackleMat, w = 0.07) {
    this.w = w;
    this.segs = [];
    for (let i = 0; i < 4 + 4; i++) { const m = new THREE.Mesh(LEAF_GEO, mat); m.castShadow = true; parent.add(m); this.segs.push(m); }
    this.shackle = new Link(parent, shackleMat, 0.022);
    this.p = Array.from({ length: 6 }, () => new THREE.Vector3());
  }
  seg(m, a, b, t) { placeBetween(m, a, b); m.scale.set(this.w, m.scale.y, t); }
  // F front eye, C centre (under axle), E rear eye, S shackle top (all world)
  update(F, C, E, S, down) {
    const [m1, m2, a, b, c] = this.p;
    m1.lerpVectors(F, C, 0.5).addScaledVector(down, 0.025);
    m2.lerpVectors(C, E, 0.5).addScaledVector(down, 0.025);
    this.seg(this.segs[0], F, m1, 0.03); this.seg(this.segs[1], m1, C, 0.03);
    this.seg(this.segs[2], C, m2, 0.03); this.seg(this.segs[3], m2, E, 0.03);
    for (let k = 0; k < 2; k++) {
      const off = 0.03 * (k + 1), f = 0.66 - k * 0.24;
      a.lerpVectors(C, m1, f).addScaledVector(down, off * 0.6); b.copy(C).addScaledVector(down, off);
      c.lerpVectors(C, m2, f).addScaledVector(down, off * 0.6);
      this.seg(this.segs[4 + k * 2], a, b, 0.026); this.seg(this.segs[5 + k * 2], b, c, 0.026);
    }
    this.shackle.update(S, E);
  }
  set visible(v) { this.segs.forEach((m) => { m.visible = v; }); this.shackle.visible = v; }
}

export class VehicleView {
  constructor(scene, vehicle) {
    this.scene = scene;
    this.v = vehicle;
    const spec = vehicle.spec;
    const R = spec.tire.radius, T = spec.tire.width, tw = spec.track, ay = spec.axleY, wb = spec.wheelbase;
    const [cw, ch, cl] = spec.chassis.size;
    this.root = new THREE.Group();
    scene.add(this.root);
    // a garage lift moves the axles down (spec.axleY); body panels keep their stock height
    this.body = buildBody(spec.bodyAxleY !== undefined ? { ...spec, axleY: spec.bodyAxleY } : spec);
    this.root.add(this.body);
    this.wheels = [0, 1, 2, 3].map(() => { const w = buildWheel(spec); this.root.add(w); return w; });
    this.tailMats = []; // brake-light materials from a glTF body (named TailLight)
    useVehicleAsset(this, spec);

    // under-truck materials are kept light and rough so they read in shadow
    const axleMat = std(0x5c6066, { roughness: 0.75 });
    const linkMat = std(0xa8acb2, { metalness: 0.25, roughness: 0.45 });
    const armMat = std(spec.body === 'wrx' ? 0x8a8e94 : 0x4a4e54, { roughness: 0.6 });
    const endMat = std(0x45474b, { roughness: 0.6 });
    const springMat = std({ wrx: 0xd4af37, lc70: 0x4a4c50, taco: 0xc8302a, buggy: 0xd23a2a, truck: 0xb8b020 }[spec.body] ?? 0xd23a2a, { metalness: 0.2, roughness: 0.45 });
    const shockBody = std({ buggy: 0x2b5fb3, taco: 0xd8b020, lc70: 0x3a6ab0, wrx: 0x2a2a2e, truck: 0xc8a020 }[spec.body] ?? 0x333333, { metalness: 0.2, roughness: 0.4 });
    const shaftMat = std(0xe6e6e6, { metalness: 0.4, roughness: 0.2 });
    const shaftDrive = std(0x55585e, { roughness: 0.6 });
    const leafMat = std(0x7a7e86, { roughness: 0.6 });
    this.ind = spec.independent || [false, false];
    const type = (a) => (this.ind[a] ? (spec.body === 'wrx' ? 'strut' : 'dwb')
      : spec.body === 'buggy' ? 'link4' : spec.body === 'lc70' && a === 0 ? 'radius' : 'leaf');

    // geometry derived from the spec so mounts sit on real frame hardware
    const G = this.geo = {};
    G.railX = Math.min(cw * 0.3, tw / 2 - T / 2 - 0.22);
    G.coilX = G.railX + 0.12;
    G.railY = -0.05; G.railBot = G.railY - 0.09;
    G.lowLen = Math.min(1.0, wb * 0.32);
    G.leafLen = Math.min(0.72, wb * 0.21);
    G.leafC = -R * 0.12 - 0.035; // leaf centre below the axle centre
    G.eyeY = ay + G.leafC + 0.12; // positive arch: eyes higher than the centre
    G.lpx = G.railX * 0.5; G.upx = G.railX * 0.85; // IFS inner pivots
    G.bj = T * 0.38; // ball joints, inboard of the wheel centre
    G.coilTopY = spec.body === 'buggy' ? ch / 2 + 0.2 : G.railY + 0.11;

    // static chassis hardware merged into one mesh (stays visible when body panels hide)
    const hw = [], hwMat = std(0x6c7077, { roughness: 0.8 });
    const hb = (w, h, l, x, y, z) => { const b = new THREE.BoxGeometry(w, h, l); b.translate(x, y, z); hw.push(b); };
    const hc = (r, len, x, y, z, axis = 'y') => { const c = new THREE.CylinderGeometry(r, r, len, 8); if (axis === 'x') c.rotateZ(Math.PI / 2); if (axis === 'z') c.rotateX(Math.PI / 2); c.translate(x, y, z); hw.push(c); };
    if (spec.body !== 'wrx') {
      // ladder frame: its own group (not dentable; rig views hide it along with the body)
      const fr = [];
      for (const sx of [-1, 1]) { const b = new THREE.BoxGeometry(0.1, 0.18, cl * 0.9); b.translate(sx * G.railX, G.railY, 0); fr.push(b); }
      for (const z of [-0.42, -0.15, 0.12, 0.4]) { const b = new THREE.BoxGeometry(G.railX * 2, 0.08, 0.08); b.translate(0, G.railY - 0.02, z * cl); fr.push(b); }
      const frame = new THREE.Group();
      const fm = new THREE.Mesh(mergeGeometries(fr), hwMat); fm.castShadow = fm.receiveShadow = true;
      frame.add(fm); this.body.add(frame);
    } else {
      for (const z of [-wb / 2, wb / 2]) hb(G.railX * 2 + 0.1, 0.08, 0.16, 0, ay + 0.12, z + 0.2); // subframes
    }
    hb(0.3, 0.25, 0.4, 0.05, -ch * 0.35, 0.05); // transfer case / centre diff
    this.tcase = V(0.05, -ch * 0.35, 0.05);

    // hubs: brake disc + caliper + knuckle casting, follow the knuckle (they steer, don't spin)
    this.hubs = [0, 1, 2, 3].map((i) => {
      const g = new THREE.Group();
      const side = i % 2 ? 1 : -1;
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.5, R * 0.5, 0.03, 14), std(0x9a9a9a, { metalness: 0.3, roughness: 0.4 }));
      disc.rotation.z = Math.PI / 2; disc.position.x = -side * T * 0.15;
      const cal = box(0.07, R * 0.3, R * 0.25, std(spec.body === 'wrx' ? 0xd42020 : 0xc0a840), -side * T * 0.15, R * 0.3, -R * 0.15);
      const cast = box(0.1, R * 0.95, 0.12, axleMat, -side * G.bj, 0, 0);
      const arm = box(0.06, 0.05, R * 0.4, axleMat, -side * (G.bj + 0.02), -R * 0.15, R * 0.2); // steering arm
      g.add(disc, cal, cast, arm);
      if (this.assetWheel) disc.visible = cal.visible = false; // the modelled wheel has its own rim centre
      this.root.add(g);
      return g;
    });

    // per-axle rigs
    this.rigs = [0, 1].map((a) => {
      const z = a === 0 ? -wb / 2 : wb / 2, dir = z < 0 ? 1 : -1;
      const rig = { a, type: type(a) };
      if (!this.ind[a]) {
        // solid axle housing with perches and brackets
        const g = new THREE.Group();
        const t = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.12, R * 0.12, tw * 0.9, 10), axleMat);
        t.rotation.z = Math.PI / 2; t.castShadow = true;
        const pump = new THREE.Mesh(new THREE.SphereGeometry(R * 0.32, 10, 8), axleMat);
        pump.position.x = 0.12; pump.scale.set(1, 1, 0.85); pump.castShadow = true;
        const cover = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.24, R * 0.24, 0.05, 10), std(0x8a8d92, { metalness: 0.3 }));
        cover.rotation.x = Math.PI / 2; cover.position.set(0.12, 0, -dir * R * 0.27);
        const yoke = cyl(R * 0.1, R * 0.2, axleMat, 'z', 8); yoke.position.set(0.12, 0.02, dir * R * 0.36);
        g.add(t, pump, cover, yoke);
        for (const sx of [-1, 1]) {
          if (rig.type === 'leaf') {
            g.add(box(0.11, 0.04, 0.2, axleMat, sx * G.railX, G.leafC + 0.03, 0)); // spring seat
            for (const dz of [-0.06, 0.06]) g.add(box(0.025, R * 0.3, 0.025, linkMat, sx * G.railX + 0.0, -0.01, dz)); // U-bolts
            g.add(box(0.05, 0.1, 0.08, axleMat, sx * (G.railX + 0.13), -0.06, 0)); // shock tab
          } else {
            g.add(at(cyl(R * 0.2, 0.03, axleMat), sx * G.coilX, R * 0.12, 0)); // coil perch
            g.add(box(0.06, 0.2, 0.12, axleMat, sx * (G.railX + 0.03), -0.04, 0)); // link brackets
          }
        }
        this.root.add(g);
        rig.axle = g;
        rig.drive = new Link(this.root, shaftDrive, 0.035, endMat);
        if (rig.type === 'leaf') {
          rig.leaf = [0, 1].map(() => new LeafPack(this.root, leafMat, linkMat, R * 0.17));
          rig.shock = [0, 1].map(() => new Coilover(this.root, springMat, shockBody, shaftMat, R * 0.09, false));
          for (const sx of [-1, 1]) {
            const hx = sx * G.railX;
            hb(0.08, G.railBot - G.eyeY + 0.05, 0.08, hx, (G.railBot + G.eyeY) / 2, z - G.leafLen); // front hanger
            hb(0.08, 0.06, 0.12, hx, G.railBot - 0.02, z + G.leafLen + 0.04); // shackle hanger
            hb(0.14, 0.06, 0.1, sx * (G.railX + 0.1), G.railY + 0.02, z + sx * 0.3); // shock mount
            hc(0.05, 0.09, hx, G.railBot - 0.045, z); // bump stop
          }
        } else {
          rig.lower = [0, 1].map(() => new Link(this.root, linkMat, 0.034, endMat));
          rig.upper = [0, 1].map(() => new Link(this.root, linkMat, 0.028, endMat));
          rig.coil = [0, 1].map(() => new Coilover(this.root, springMat, shockBody, shaftMat, R * 0.16));
          rig.track = new Link(this.root, linkMat, 0.026, endMat);
          const frameZ = z + dir * (rig.type === 'radius' ? 0.95 : G.lowLen);
          for (const sx of [-1, 1]) {
            const ly = ay + 0.0;
            hb(0.07, G.railBot - ly + 0.05, 0.1, sx * G.railX, (G.railBot + ly) / 2, frameZ); // link drop bracket
            if (spec.body !== 'buggy') hb(0.18, 0.04, 0.18, sx * G.coilX, G.coilTopY + 0.02, z + dir * 0.05); // coil bucket
            if (spec.body !== 'buggy') hb(0.1, 0.12, 0.1, sx * (G.railX + 0.07), G.coilTopY - 0.04, z + dir * 0.05);
            hc(0.05, 0.09, sx * G.railX, G.railBot - 0.045, z); // bump stop
            if (rig.type === 'link4') hb(0.08, 0.1, 0.08, sx * 0.2, G.railY - 0.1, z + dir * G.lowLen * 0.7); // upper link mounts
          }
          hb(0.08, 0.2, 0.08, -G.railX, G.railY - 0.12, z + dir * 0.12); // track bar mount
        }
      } else {
        rig.lowerA = [0, 1].map(() => [new Link(this.root, armMat, 0.032, endMat), new Link(this.root, armMat, 0.032, endMat)]);
        rig.cv = [0, 1].map(() => new Link(this.root, shaftDrive, 0.028, endMat));
        if (rig.type === 'dwb') {
          rig.upperA = [0, 1].map(() => [new Link(this.root, armMat, 0.026, endMat), new Link(this.root, armMat, 0.026, endMat)]);
          rig.coil = [0, 1].map(() => new Coilover(this.root, springMat, shockBody, shaftMat, R * 0.15));
        } else {
          rig.coil = [0, 1].map(() => new Coilover(this.root, springMat, shockBody, shaftMat, R * 0.17));
        }
        // diff, arm pivot brackets, spring towers
        hb(0.32, 0.26, 0.3, 0.08, ay + 0.06, z);
        rig.towerTop = [];
        for (const sx of [-1, 1]) {
          for (const dz of [-0.22, 0.22]) hb(0.1, 0.12, 0.06, sx * G.lpx, ay - R * 0.3, z + dz);
          if (rig.type === 'dwb') {
            for (const dz of [-0.16, 0.16]) hb(0.08, 0.1, 0.06, sx * G.upx, ay + R * 0.42, z + dz);
            hb(0.1, ay + R * 0.42 - G.railBot + 0.05, 0.4, sx * (G.upx - 0.04), (ay + R * 0.42 + G.railBot) / 2, z); // arm mount plate
            const bx = G.lpx + 0.6 * (tw / 2 - G.bj - G.lpx);
            const top = V(sx * (bx - 0.05), ay + R * 0.95, z);
            hb(0.2, 0.05, 0.2, top.x, top.y + 0.03, z); // coil tower
            rig.towerTop.push(top);
          } else {
            const top = V(sx * (tw / 2 - T / 2 - 0.16), ay + R + 0.12, z);
            hb(0.2, 0.05, 0.2, top.x, top.y + 0.03, z); // strut tower
            rig.towerTop.push(top);
          }
        }
        rig.drive = new Link(this.root, shaftDrive, 0.035, endMat);
      }
      return rig;
    });
    // steering: solid front = tie rod + drag link from a frame box; IFS = rack + two tie rods
    // glTF axle housings / hubs (visual swap only; links and springs stay procedural)
    this.rigs.forEach((rig, a) => {
      const m = this.assetAxles && this.assetAxles[a];
      if (m && rig.axle) { rig.axle.children.forEach((c) => { c.visible = false; }); rig.axle.add(m); }
    });
    if (this.assetHub) this.hubs.forEach((h, i) => {
      h.children.forEach((c) => { c.visible = false; });
      const m = this.assetHub.clone(true);
      if (i % 2 === 0) m.scale.x = -1;
      h.add(m);
    });
    const zf = -wb / 2;
    if (this.ind[0]) {
      hb(G.lpx * 2, 0.08, 0.08, 0, ay - R * 0.1, zf + R * 0.38); // rack
      this.tieRods = [0, 1].map(() => new Link(this.root, linkMat, 0.022, endMat));
    } else {
      this.tieRod = new Link(this.root, linkMat, 0.026, endMat);
      this.dragLink = new Link(this.root, linkMat, 0.024, endMat);
      hb(0.14, 0.16, 0.2, -(G.railX + 0.1), G.railY - 0.02, zf - 0.2); // steering box
    }
    const hwMesh = new THREE.Mesh(mergeGeometries(hw), hwMat);
    hwMesh.castShadow = true; hwMesh.receiveShadow = true;
    this.body.add(hwMesh);

    this.tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), down: new THREE.Vector3() };
    // geometry that dents: body boxes plus the extruded shell panels
    this.dentable = [];
    this.body.updateMatrix();
    this.body.traverse((o) => {
      if (!o.isMesh) return;
      const inShell = o.parent === this.body.userData.shell && o.geometry.attributes.position.count > 60;
      if (o.userData.noDent || !(inShell || o.userData.dentable || (o.geometry.type === 'BoxGeometry' && o.parent === this.body))) return;
      o.updateMatrix();
      const m = o.matrix.clone();
      for (let p = o.parent; p && p !== this.body; p = p.parent) { p.updateMatrix(); m.premultiply(p.matrix); }
      o.userData.toBody = m;
      this.dentable.push(o);
    });
    this.dentsApplied = 0;
    this.smoke = 0;
  }

  dispose() {
    this.scene.remove(this.root);
    this.root.traverse((o) => { if (o.geometry && o.geometry !== LEAF_GEO) o.geometry.dispose(); });
  }

  applyDent({ p, n, amount }) {
    const P = new THREE.Vector3(p.x, p.y, p.z), N = new THREE.Vector3(n.x, n.y, n.z);
    const radius = 0.55 + amount * 2;
    const inv = new THREE.Matrix4(), lin = new THREE.Matrix3();
    for (const m of this.dentable) {
      inv.copy(m.userData.toBody).invert();
      const lp = P.clone().applyMatrix4(inv);
      const ln = N.clone().applyMatrix3(lin.setFromMatrix4(inv));
      const pos = m.geometry.attributes.position;
      let touched = false;
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - lp.x, dy = pos.getY(i) - lp.y, dz = pos.getZ(i) - lp.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > radius) continue;
        const f = (1 - d / radius) ** 2 * amount;
        pos.setXYZ(i, pos.getX(i) + ln.x * f, pos.getY(i) + ln.y * f, pos.getZ(i) + ln.z * f);
        touched = true;
      }
      if (touched) { pos.needsUpdate = true; m.geometry.computeVertexNormals(); }
    }
  }

  update(input) {
    const v = this.v, spec = v.spec;
    const L = this.body.userData.lights;
    if (L && input) {
      const k = input.brake > 0.05 || input.handbrake ? 1.6 : 0.15;
      L.tail.emissiveIntensity = k;
      for (const m of this.tailMats) { if (m.emissive && m.emissive.getHex() === 0) m.emissive.set(0xff1a1a); m.emissiveIntensity = k; }
    }
    const copy = (obj, body) => {
      const p = body.translation(), q = body.rotation();
      obj.position.set(p.x, p.y, p.z); obj.quaternion.set(q.x, q.y, q.z, q.w);
    };
    copy(this.body, v.chassis);
    this.body.updateMatrixWorld();
    v.wheels.forEach((w, i) => {
      copy(this.wheels[i], w);
      // flat tyre sags
      const flat = v.health.tire[i] < 0.35 ? 0.9 : 1;
      this.wheels[i].scale.set(1, flat, flat);
      copy(this.hubs[i], v.knuckles[i]);
    });
    while (this.dentsApplied < v.dents.length) this.applyDent(v.dents[this.dentsApplied++]);

    const { a, b, c, d, down } = this.tmp;
    const W = (obj, x, y, z, out) => out.set(x, y, z).applyQuaternion(obj.quaternion).add(obj.position);
    const G = this.geo, R = spec.tire.radius, T = spec.tire.width, ay = spec.axleY;
    const B = this.body;
    down.set(0, -1, 0).applyQuaternion(B.quaternion);
    this.rigs.forEach((rig, ax) => {
      const z = v.axles[ax].localZ;
      const dir = z < 0 ? 1 : -1; // links run toward the middle of the truck
      if (rig.axle) {
        copy(rig.axle, v.axles[ax].body);
        const A = rig.axle;
        if (rig.type === 'leaf') {
          for (let k = 0; k < 2; k++) {
            const sx = k ? 1 : -1, x = sx * G.railX;
            const F = W(B, x, G.eyeY, z - G.leafLen, a).clone(), C = W(A, x, G.leafC, 0, b).clone();
            const E = W(B, x, G.eyeY, z + G.leafLen + 0.04, c).clone(), S = W(B, x, G.railBot - 0.04, z + G.leafLen + 0.04, d).clone();
            rig.leaf[k].update(F, C, E, S, down);
            // staggered shocks: one ahead of the axle, one behind
            rig.shock[k].update(W(B, sx * (G.railX + 0.1), G.railY - 0.02, z + sx * 0.3, a).clone(), W(A, sx * (G.railX + 0.13), -0.1, 0, b));
          }
        } else {
          const frameZ = z + dir * (rig.type === 'radius' ? 0.95 : G.lowLen);
          for (let k = 0; k < 2; k++) {
            const sx = k ? 1 : -1;
            const fp = W(B, sx * G.railX, ay, frameZ, a).clone();
            rig.lower[k].update(fp, W(A, sx * (G.railX + 0.03), -0.12, 0, b));
            if (rig.type === 'radius') rig.upper[k].update(fp, W(A, sx * (G.railX + 0.03), 0.07, 0, b));
            else rig.upper[k].update(W(B, sx * 0.2, G.railY - 0.14, z + dir * G.lowLen * 0.7, a).clone(), W(A, 0.12 + sx * 0.1, R * 0.3, 0, b));
            const topZ = spec.body === 'buggy' ? z + dir * 0.18 : z + dir * 0.05;
            rig.coil[k].update(W(B, sx * G.coilX, G.coilTopY, topZ, a).clone(), W(A, sx * G.coilX, R * 0.12 + 0.015, 0, b));
          }
          rig.track.update(W(B, -G.railX, G.railY - 0.2, z + dir * 0.12, a).clone(), W(A, G.coilX - 0.06, 0.06, dir * 0.12, b));
        }
        rig.drive.update(W(B, this.tcase.x, this.tcase.y, this.tcase.z - dir * 0.2, a).clone(), W(A, 0.12, 0.02, dir * R * 0.44, b));
      } else {
        // independent: A-arms from frame pivots to the knuckle, spring onto the lower arm (or strut on the knuckle), CV shaft
        for (let k = 0; k < 2; k++) {
          const sx = k ? 1 : -1, i = ax * 2 + k;
          const hub = this.hubs[i];
          const lbj = W(hub, -sx * G.bj, -R * 0.42, 0, d).clone();
          for (const [j, dz] of [[0, -0.22], [1, 0.22]]) rig.lowerA[k][j].update(W(B, sx * G.lpx, ay - R * 0.3, z + dz, a).clone(), lbj);
          if (rig.type === 'dwb') {
            const ubj = W(hub, -sx * G.bj, R * 0.42, 0, c).clone();
            for (const [j, dz] of [[0, -0.16], [1, 0.16]]) rig.upperA[k][j].update(W(B, sx * G.upx, ay + R * 0.42, z + dz, a).clone(), ubj);
            const piv = W(B, sx * G.lpx, ay - R * 0.3, z, a).clone();
            rig.coil[k].update(W(B, rig.towerTop[k].x, rig.towerTop[k].y, z, b).clone(), piv.lerp(lbj, 0.6).addScaledVector(down, -0.03));
          } else {
            rig.coil[k].update(W(B, rig.towerTop[k].x, rig.towerTop[k].y, z, b).clone(), W(hub, -sx * (T / 2 + 0.1), R * 0.15, 0, c));
          }
          rig.cv[k].update(W(B, sx * 0.2, ay + 0.06, z, a).clone(), W(hub, -sx * G.bj, 0, 0, b));
          [rig.cv[k], ...rig.lowerA[k], ...(rig.upperA ? rig.upperA[k] : [])].forEach((lk) => { lk.visible = !v.broken[i]; });
        }
        rig.drive.update(W(B, this.tcase.x, this.tcase.y, this.tcase.z - dir * 0.2, a).clone(), W(B, 0.08, ay + 0.06, z + dir * 0.15, b));
      }
    });
    // steering linkage on the front knuckles (arm points behind the axle)
    const kl = this.hubs[0], kr = this.hubs[1];
    const armL = W(kl, G.bj + 0.02, -R * 0.15, R * 0.38, a).clone(), armR = W(kr, -(G.bj + 0.02), -R * 0.15, R * 0.38, b).clone();
    if (this.tieRods) {
      const zf = -spec.wheelbase / 2;
      this.tieRods[0].update(W(B, -G.lpx, ay - R * 0.1, zf + R * 0.38, c).clone(), armL);
      this.tieRods[1].update(W(B, G.lpx, ay - R * 0.1, zf + R * 0.38, c).clone(), armR);
      this.tieRods[0].visible = !v.broken[0]; this.tieRods[1].visible = !v.broken[1];
    } else {
      this.tieRod.update(armL, armR);
      this.dragLink.update(W(B, -(G.railX + 0.1), G.railY - 0.1, -spec.wheelbase / 2 - 0.2, c).clone(), armL);
      this.tieRod.visible = this.dragLink.visible = !v.broken[0] && !v.broken[1];
    }
  }
}
