// Rear lamps on the vehicle view: brake / tail lamps and reverse (backup) lamps.
//
// The reverse lamps are small white lenses added in code to whichever body the view shows (the
// glTF Body or the procedural fallback), placed from that body's own rear lamp clusters: every
// island of a lamp material (TailLight, amber Lamp) at the rear corners is found, grouped per
// side, and the lens goes where REVERSE (below) says relative to that cluster, then onto the body
// surface found by casting rays at it from behind. So the lamps follow the model; nothing here
// knows a rig's coordinates. The .glb files are not touched.
//
// Lenses are meshes in view.body with a material named 'ReverseLamp', so the crash damage view
// (src/damage/body_view.js) treats them like every other lamp: they dent with the body and go dark
// when broken. They opt out of the outline pass (outline id 0): a lens a few game pixels big at
// Chunky 4x would otherwise be all outline.
//
// Light: the lens face glows, plus one soft spot light (no shadows) from the tail pointing down
// behind the truck. Under the toon ramp it only lifts the ground's band, so it shows as a stepped
// pool in shade and is invisible on sunlit ground. It is always in the scene (intensity 0 when off),
// so switching it never changes the scene's light count (no shader recompiles).
import * as THREE from 'three';

// Where each body style carries its reverse lamps, relative to the rear lamp cluster on each side.
// A spec may override with spec.lamps.reverse. Fractions are of the cluster's width / height.
//   band:  across the cluster, between y fractions [y0, y1] (pickup: the white middle band)
//   inner: the inboard end of the cluster, x fraction w of its width (sedan boot-lid lamps)
//   below: under the cluster, h metres tall (wagon: the white section under red and amber)
export const REVERSE = {
  taco: { at: 'band', y0: 0.38, y1: 0.6 },
  wrx: { at: 'inner', w: 0.3, y0: 0.12, y1: 0.88 },
  lc70: { at: 'below', h: 0.09, gap: 0.006 },
  default: { at: 'below', h: 0.08, gap: 0.006 },
};

const LENS_T = 0.012;           // lens thickness
const LENS_OFF = 0.004;         // gap from the surface behind it (no z-fighting at any distance)
const REVERSE_ON = 1.5, TAIL_ON = 1.6, TAIL_IDLE = 0.15;
const POOL = { intensity: 16, distance: 7, angle: 0.8, penumbra: 0.7, reach: 3.2 };

const isLampMat = (m) => m && /lamp|light/i.test(m.name || '') && !/glass/i.test(m.name) && m.name !== 'ReverseLamp';

// Lamp islands (connected triangles, welded by position) of every visible lamp mesh, in body space.
function lampIslands(body) {
  const out = [];
  body.updateMatrixWorld(true);
  const inv = body.matrixWorld.clone().invert();
  body.traverse((o) => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    for (let p = o; p && p !== body; p = p.parent) if (!p.visible) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (!mats.some(isLampMat)) return;
    const m = o.matrixWorld.clone().premultiply(inv);
    const g = o.geometry, pos = g.attributes.position, idx = g.index;
    const n = pos.count, key = new Map(), wid = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
      let w = key.get(k); if (w === undefined) { w = key.size; key.set(k, w); } wid[i] = w;
    }
    const par = Int32Array.from({ length: key.size }, (_, i) => i);
    const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    const tc = idx ? idx.count : n;
    // only triangles drawn with a lamp material (a multi-material mesh keeps its groups)
    const groups = g.groups.length ? g.groups : [{ start: 0, count: tc, materialIndex: 0 }];
    const used = new Uint8Array(n);
    for (const gr of groups) {
      if (!isLampMat(mats[gr.materialIndex ?? 0] ?? mats[0])) continue;
      for (let t = gr.start; t < gr.start + gr.count; t += 3) {
        const a = idx ? idx.getX(t) : t;
        used[a] = 1;
        for (let k = 1; k < 3; k++) { const b = idx ? idx.getX(t + k) : t + k; used[b] = 1; const ra = find(wid[a]), rb = find(wid[b]); if (ra !== rb) par[rb] = ra; }
      }
    }
    const boxes = new Map(), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      if (!used[i]) continue;
      const r = find(wid[i]);
      let b = boxes.get(r); if (!b) boxes.set(r, (b = new THREE.Box3()));
      b.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m));
    }
    out.push(...boxes.values());
  });
  return out;
}

// One rear lamp cluster per side: the union of the lamp islands at the rear corners.
export function rearClusters(body, width) {
  const isl = lampIslands(body);
  if (!isl.length) return [];
  const rearZ = Math.max(...isl.map((b) => b.max.z));
  const c = new THREE.Vector3();
  const sides = [-1, 1].map((s) => {
    const box = new THREE.Box3();
    for (const b of isl) {
      b.getCenter(c);
      if (b.max.z < rearZ - 0.3 || c.x * s < width * 0.22) continue; // not at the rear corners (a cab-top brake lamp, the front)
      box.union(b);
    }
    return box.isEmpty() ? null : { side: s, box };
  });
  return sides.filter(Boolean);
}

// The lens rectangle (body space, x / y extents) for a cluster.
function lensRect(cl, st) {
  const { min, max } = cl.box, w = max.x - min.x, h = max.y - min.y;
  if (st.at === 'band') return { x0: min.x + w * 0.08, x1: max.x - w * 0.08, y0: min.y + h * st.y0, y1: min.y + h * st.y1 };
  if (st.at === 'inner') {
    const inner = cl.side > 0 ? min.x : max.x, ww = w * st.w;
    return { x0: Math.min(inner, inner + cl.side * ww), x1: Math.max(inner, inner + cl.side * ww), y0: min.y + h * st.y0, y1: min.y + h * st.y1 };
  }
  const top = min.y - st.gap;
  return { x0: min.x + w * 0.08, x1: max.x - w * 0.08, y0: top - st.h, y1: top };
}

// 'below': the first flat stretch under the cluster with room for the lens. Scans down the
// cluster's centre line from behind in 1 cm steps; a step in depth (a bumper standing proud of the
// panel above it) starts a new stretch, so a lens never hangs off the edge of one.
function belowRect(r, targets, zFrom) {
  const ray = new THREE.Raycaster(), dir = new THREE.Vector3(0, 0, -1), o = new THREE.Vector3();
  const xs = [r.x0 + 0.1 * (r.x1 - r.x0), (r.x0 + r.x1) / 2, r.x1 - 0.1 * (r.x1 - r.x0)];
  const h = r.y1 - r.y0;
  let runTop = null, lastZ = null;
  for (let y = r.y1; y > r.y1 - 0.45; y -= 0.01) {
    // depth across the lens width: all three hits within 1.5 cm of each other, or it is no seat
    let zMin = Infinity, zMax = -Infinity;
    for (const x of xs) {
      ray.set(o.set(x, y, zFrom), dir);
      const hit = ray.intersectObjects(targets, false)[0];
      const z = hit ? hit.point.z : -Infinity;
      zMin = Math.min(zMin, z); zMax = Math.max(zMax, z);
    }
    const flat = zMax - zMin < 0.015 && zMin > -Infinity;
    if (!flat) runTop = null;
    else if (runTop === null || Math.abs(zMax - lastZ) > 0.015) runTop = y === r.y1 ? y : y - 0.01; // a new stretch (keep 1 cm off its top edge)
    lastZ = zMax;
    if (runTop !== null && runTop - y >= h) return { ...r, y1: runTop, y0: runTop - h };
  }
  return r;
}

// Put a lens on the body surface behind the rectangle: rays from behind at its centre and
// corners; the lens plane faces the centre hit's normal, just proud of the rearmost hit.
function placeLens(body, targets, r, zFrom) {
  const ray = new THREE.Raycaster();
  const dir = new THREE.Vector3(0, 0, -1);
  const pts = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]];
  let normal = null, front = -Infinity, centre = null;
  for (const [u, v] of pts) {
    const o = new THREE.Vector3(r.x0 + (r.x1 - r.x0) * u, r.y0 + (r.y1 - r.y0) * v, zFrom);
    ray.set(o, dir);
    const hit = ray.intersectObjects(targets, false)[0];
    if (!hit) continue;
    if (!centre) {
      centre = hit.point.clone();
      normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 0, 1);
      if (normal.z < 0.5) normal.set(0, 0, 1);
    }
    front = Math.max(front, hit.point.z);
  }
  if (!centre) return null;
  // the plane through the rearmost hit, along the normal; centred over the rectangle
  const c = new THREE.Vector3((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, front);
  c.addScaledVector(normal, LENS_T / 2 + LENS_OFF);
  return { centre: c, normal };
}

export class RearLamps {
  // view: the VehicleView (its body already final: glTF swapped in, before BodyDamage is built)
  constructor(view, spec) {
    this.view = view; this.v = view.v; this.spec = spec;
    const body = view.body;
    const L = body.userData.lights || (body.userData.lights = {});
    this.tailMats = view.tailMats; // glTF TailLight materials (the procedural one is L.tail)
    this.L = L;
    const mat = this.mat = new THREE.MeshStandardMaterial({ color: 0xc4c2bb, emissive: 0xfff2d8, emissiveIntensity: 0, roughness: 0.25, flatShading: true, name: 'ReverseLamp' });
    mat.userData.outlineId = 0; // no outline round a lens a few pixels big
    L.reverse = mat; // (src/fx/mud_coat.js keeps userData.lights materials shared: the view drives their glow)
    const width = spec.chassis.size[0];
    const st = { ...REVERSE.default, ...(REVERSE[spec.body] || {}), ...(spec.lamps?.reverse || {}) };
    const clusters = rearClusters(body, width);
    const targets = [];
    body.updateMatrixWorld(true);
    body.traverse((o) => {
      if (!o.isMesh) return;
      for (let p = o; p && p !== body; p = p.parent) if (!p.visible) return;
      targets.push(o);
    });
    this.lenses = [];
    const zFrom = Math.max(...clusters.map((c) => c.box.max.z), 0) + 2;
    for (const cl of clusters) {
      let r = lensRect(cl, st);
      if (st.at === 'below') r = belowRect(r, targets, zFrom);
      const at = placeLens(body, targets, r, zFrom);
      if (!at) continue;
      const lens = new THREE.Mesh(new THREE.BoxGeometry(r.x1 - r.x0, r.y1 - r.y0, LENS_T), mat);
      lens.name = 'ReverseLamp';
      lens.position.copy(at.centre);
      lens.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), at.normal);
      lens.userData.side = cl.side; lens.userData.size = [r.x1 - r.x0, r.y1 - r.y0];
      lens.castShadow = false; lens.receiveShadow = false;
      body.add(lens);
      this.lenses.push(lens);
    }
    // soft pool of light on the ground behind the truck (no shadow)
    const spot = this.spot = new THREE.SpotLight(0xfff0d6, 0, POOL.distance, POOL.angle, POOL.penumbra, 2);
    spot.castShadow = false;
    spot.name = 'ReversePool';
    if (this.lenses.length) {
      const y = this.lenses.reduce((a, l) => a + l.position.y, 0) / this.lenses.length;
      const z = Math.max(...this.lenses.map((l) => l.position.z)) + 0.08;
      spot.position.set(0, y, z);
      spot.target.position.set(0, spec.axleY - spec.tire.radius, z + POOL.reach);
    }
    body.add(spot, spot.target);
    this.on = { reverse: false, brake: false };
  }

  // Panes of the given materials as the crash damage view sees them: { total, intact }.
  panes(test) {
    let total = 0, intact = 0;
    const meshes = this.view.damage ? this.view.damage.meshes : [];
    for (const r of meshes) {
      if (!r.panes) continue;
      const m = Array.isArray(r.mesh.material) ? r.mesh.material[0] : r.mesh.material;
      if (!test(m)) continue;
      for (const p of r.panes) { total++; if (!p.state) intact++; }
    }
    return { total, intact };
  }

  // input: the driver's controls (null in the garage preview / menu: every lamp off)
  update(input) {
    const d = this.v.dt;
    const reverse = !!input && d.gear < 0 && d.running && !d.dead;
    const brake = !!input && (input.brake > 0.05 || !!input.handbrake);
    if (reverse !== this.on.reverse) {
      this.on.reverse = reverse;
      this.mat.emissiveIntensity = reverse ? REVERSE_ON : 0;
    }
    // the pool follows the lenses that are still whole
    let pool = 0;
    if (reverse && this.lenses.length) {
      const p = this.panes((m) => m === this.mat);
      pool = p.total ? p.intact / p.total : 1;
    }
    this.spot.intensity = POOL.intensity * pool;
    this.on.brake = brake;
    const k = brake ? TAIL_ON : TAIL_IDLE;
    if (this.L.tail) this.L.tail.emissiveIntensity = k;
    for (const m of this.tailMats) { if (m.emissive && m.emissive.getHex() === 0) m.emissive.set(0xff1a1a); m.emissiveIntensity = k; }
  }

  // What the lamps show now (tests, screenshots): lamps lit = commanded on and not broken.
  state() {
    const rev = this.panes((m) => m === this.mat);
    const tail = this.panes((m) => m && m.name === 'TailLight');
    return {
      reverse: this.on.reverse && rev.intact > 0, reverseLit: this.on.reverse ? rev.intact : 0, reverseLenses: this.lenses.length,
      brake: this.on.brake && tail.intact > 0, brakeLit: this.on.brake ? tail.intact : 0, tailPanes: tail.total,
      pool: +this.spot.intensity.toFixed(2),
    };
  }
}
