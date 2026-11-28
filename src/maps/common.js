// Shared map building blocks: noise, surface materials, spline paths, the baked 1 m
// heightfield grid, the convex-rock kit and the Rapier terrain colliders.
// No three.js here so maps can be built headless in Node for physics tests.

export const MAT = { GRASS: 0, DIRT: 1, ROCK: 2, MUD: 3, SAND: 4, GRAVEL: 5, ROAD: 6, TARMAC: 7, WATER: 8, WOOD: 9 };
export const MAT_INFO = [
  // mu: tyre friction, rr: rolling resistance (x wheel load), drag: viscous drag through the medium
  // color: sRGB 0..1 for the HUD, minimap and dust; the base tone of each ground ramp (src/gfx/palette.js)
  { name: 'Grass',  mu: 0.72, rr: 0.020, drag: 0,   color: [0.45, 0.64, 0.28] },
  { name: 'Dirt',   mu: 0.85, rr: 0.020, drag: 0,   color: [0.79, 0.59, 0.34] },
  { name: 'Rock',   mu: 1.10, rr: 0.010, drag: 0,   color: [0.58, 0.53, 0.46] },
  { name: 'Mud',    mu: 0.42, rr: 0.120, drag: 260, color: [0.48, 0.31, 0.17] },
  { name: 'Sand',   mu: 0.62, rr: 0.080, drag: 60,  color: [0.93, 0.80, 0.49] },
  { name: 'Gravel', mu: 0.68, rr: 0.030, drag: 0,   color: [0.66, 0.58, 0.46] },
  { name: 'Road',   mu: 0.80, rr: 0.015, drag: 0,   color: [0.82, 0.67, 0.43] },
  { name: 'Tarmac', mu: 0.95, rr: 0.012, drag: 0,   color: [0.31, 0.29, 0.26] },
  { name: 'Water',  mu: 0.60, rr: 0.050, drag: 90,  color: [0.36, 0.69, 0.80] },
  // not a ground surface: loose logs and stumps (src/physics_props.js); bark is a bit slippery
  { name: 'Wood',   mu: 0.60, rr: 0.015, drag: 0,   color: [0.55, 0.38, 0.22] },
];
export const MUD_SINK = 0.38;
export const DIFF = {
  green:  { label: 'Easy',      color: '#3fae4f', hex: 0x3fae4f },
  blue:   { label: 'Moderate',  color: '#2f7fd8', hex: 0x2f7fd8 },
  black:  { label: 'Hard',      color: '#1a1a1a', hex: 0x1a1a1a },
  dblack: { label: 'Extreme',   color: '#000000', hex: 0x000000 },
};

// ---------- noise ----------
function hash(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return (a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz) * 2 - 1;
}
export function fbm(x, z, oct = 4) {
  let s = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += vnoise(x * f, z * f) * amp; norm += amp; amp *= 0.5; f *= 2.03; }
  return s / norm;
}
export function ridged(x, z, oct = 4) {
  let s = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += (1 - Math.abs(vnoise(x * f + i * 17, z * f - i * 9))) ** 2 * amp; norm += amp; amp *= 0.5; f *= 2.1; }
  return s / norm;
}
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- micro-relief ----------
// Physical bumps baked into the 1 m heightfield. The grid holds nothing much finer than ~2 m,
// so these are the rolling part of the relief; sub-metre bumps are embedded rock colliders
// (rockKit.embedded). All deterministic.
// rounded humps and hollows 1.5-4 m across: standard deviation amp/2, peaks about 1.5 amp
export const lumps = (x, z, amp) => amp * 1.6 * fbm(x * 0.29 + 11.3, z * 0.29 - 7.1, 2);
// sparse potholes: on a `cell` m lattice each cell holds one with chance `prob`, `rad` m in radius
// (scaled 0.7-1.3), up to `depth` deep with a soft rim; returns a height offset (<= 0)
export function potholes(x, z, cell, prob, depth, rad, seed = 0) {
  const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
  let dh = 0;
  for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
    if (hash(i * 7 + seed, j * 13 - seed) > prob) continue;
    const px = (i + 0.2 + 0.6 * hash(i + 101 + seed, j - 37)) * cell, pz = (j + 0.2 + 0.6 * hash(i - 53, j + 211 + seed)) * cell;
    const r = rad * (0.7 + 0.6 * hash(i + 17, j + 29 + seed)), d = Math.hypot(x - px, z - pz);
    if (d < r) dh = Math.min(dh, -depth * (0.6 + 0.4 * hash(i - 9, j + 3 + seed)) * (1 - (d / r) ** 2) ** 2);
  }
  return dh;
}
export const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;

export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- paths ----------
// Catmull-Rom through hand-placed control points. `closed` wraps the ends into a loop.
export function catmull(pts, step, closed = false) {
  const out = [];
  const n = pts.length;
  const P = closed ? (i) => pts[((i % n) + n) % n] : (i) => pts[clamp(i, 0, n - 1)];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(2, Math.ceil(segLen / step));
    for (let k = 0; k < m; k++) {
      const t = k / m, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0[0], p1[0], p2[0], p3[0]), z: f(p0[1], p1[1], p2[1], p3[1]) });
    }
  }
  const last = closed ? pts[0] : pts[n - 1];
  out.push({ x: last[0], z: last[1] });
  return out;
}
// cumulative arc length into p.s; returns total length
export function arcLength(pts) {
  let s = 0;
  pts.forEach((p, i) => { if (i) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z); p.s = s; });
  return s;
}

// Path sampling: position, height and unit tangent at arc length s.
export function pathPoint(path, s) {
  const pts = path.pts;
  let i = 1;
  while (i < pts.length - 1 && pts[i].s < s) i++;
  const a = pts[i - 1], b = pts[i];
  const t = clamp((s - a.s) / Math.max(1e-6, b.s - a.s), 0, 1);
  const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t);
  const tx = b.x - a.x, tz = b.z - a.z, L = Math.hypot(tx, tz) || 1;
  return { x, z, h: lerp(a.h, b.h, t), tx: tx / L, tz: tz / L };
}

// ---------- baked grid ----------
// Heights (physics), visual heights (mud sits lower under the tyres than it looks),
// surface material and path id per 1 m grid vertex.
export function makeGrid(SIZE, RES) {
  const N1 = RES + 1, CELL = SIZE / RES;
  // tone: 0-255 darkening of the shown ground (wheel ruts, wet mud), read by gfx/terrain_look.js
  const GRID = { h: new Float32Array(N1 * N1), vis: new Float32Array(N1 * N1), mat: new Uint8Array(N1 * N1), path: new Int16Array(N1 * N1).fill(-1), tone: new Uint8Array(N1 * N1) };
  const sample = (arr, x, z) => {
    const fx = clamp((x + SIZE / 2) / CELL, 0, RES - 1e-6), fz = clamp((z + SIZE / 2) / CELL, 0, RES - 1e-6);
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const a = arr[ix * N1 + iz], b = arr[(ix + 1) * N1 + iz], c = arr[ix * N1 + iz + 1], d = arr[(ix + 1) * N1 + iz + 1];
    return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
  };
  return {
    SIZE, RES, N1, CELL, GRID,
    heightAt: (x, z) => sample(GRID.h, x, z),
    visualHeightAt: (x, z) => sample(GRID.vis, x, z),
    materialAt(x, z) {
      const ix = clamp(Math.round((x + SIZE / 2) / CELL), 0, RES), iz = clamp(Math.round((z + SIZE / 2) / CELL), 0, RES);
      return GRID.mat[ix * N1 + iz];
    },
  };
}

// ---------- rocks ----------
// Each rock is a convex point cloud shared by physics and visuals. The kit's helpers draw
// from the given random stream, so a map's rock layout is reproducible from its seed.
export function rockKit(R, heightAt) {
  const rocks = [];
  // maxTop: cap on how far the rock stands above the ground (keeps in-trail obstacles climbable)
  const shape = (size, flat = 1, embed = 0.35, maxTop = Infinity) => {
    const pts = [];
    const n = 14 + Math.floor(R() * 8);
    const sx = size * (0.7 + R() * 0.6), sz = size * (0.7 + R() * 0.6);
    const sy = Math.min(size * flat * (0.55 + R() * 0.45), maxTop / (1.95 - embed));
    for (let i = 0; i < n; i++) {
      const u = R() * 2 - 1, th = R() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      const k = 0.75 + R() * 0.25;
      pts.push(Math.cos(th) * r * sx * k, u * sy * k, Math.sin(th) * r * sz * k);
    }
    return { pts, sy, embed, rotY: R() * Math.PI * 2 };
  };
  // follow: tilt the rock to the ground's slope, so a wide, flat rock on a steep pitch doesn't
  // stand proud of the ground as a shelf on its downhill side
  const put = (r, x, z, follow = false) => {
    if (follow) {
      const gx = (heightAt(x + 1.5, z) - heightAt(x - 1.5, z)) / 3, gz = (heightAt(x, z + 1.5) - heightAt(x, z - 1.5)) / 3;
      const c = Math.cos(r.rotY), s = Math.sin(r.rotY);
      for (let i = 0; i < r.pts.length; i += 3) { const px = r.pts[i], pz = r.pts[i + 2]; r.pts[i + 1] += gx * (px * c + pz * s) + gz * (-px * s + pz * c); }
    }
    rocks.push({ x, y: heightAt(x, z) + r.sy * (1 - r.embed) - 0.05, z, rotY: r.rotY, pts: r.pts });
  };
  const boulder = (x, z, size, flat, embed, maxTop) => put(shape(size, flat, embed, maxTop), x, z);
  // how far a shape reaches from its centre along world direction (dx, dz), after its yaw
  const reach = (r, dx, dz) => {
    const c = Math.cos(r.rotY), s = Math.sin(r.rotY);
    let m = 0;
    for (let i = 0; i < r.pts.length; i += 3) { const px = r.pts[i], pz = r.pts[i + 2]; m = Math.max(m, (px * c + pz * s) * dx + (-px * s + pz * c) * dz); }
    return m;
  };
  // flat-topped ledge slab across the trail, top at `top` above the local ground
  // side: optional cross slope (rise per m to the slab's +x side) to follow instead of measuring the
  // ground at its ends (a slab that reaches past a corridor's edge would tilt to the bank there)
  const ledge = (x, z, rotY, width, depth, top, side = null) => {
    const pts = [];
    const hw = width / 2, hd = depth / 2, H = top + 0.6;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      pts.push(sx * hw * (0.85 + R() * 0.15), H / 2 - R() * 0.05, sz * hd * (0.8 + R() * 0.2));
      pts.push(sx * hw * (0.95 + R() * 0.1), -H / 2, sz * (hd + H * (0.6 + R() * 0.2))); // chamfered, weathered faces
    }
    for (let i = 0; i < 4; i++) pts.push((R() * 2 - 1) * hw * 0.8, H / 2 + R() * 0.04, (R() * 2 - 1) * hd * 0.7);
    // follow the ground's grade and camber, so the step is the same height from either side
    const fx = Math.sin(rotY), fz = Math.cos(rotY), lx = Math.cos(rotY), lz = -Math.sin(rotY);
    const gAlong = (heightAt(x + fx * hd, z + fz * hd) - heightAt(x - fx * hd, z - fz * hd)) / (2 * hd);
    const gSide = side ?? (heightAt(x + lx * hw, z + lz * hw) - heightAt(x - lx * hw, z - lz * hw)) / (2 * hw);
    for (let i = 0; i < pts.length; i += 3) pts[i + 1] += gSide * pts[i] + gAlong * pts[i + 2];
    rocks.push({ x, y: heightAt(x, z) + H / 2 - 0.6, z, rotY, pts, ledge: true });
  };
  // Embedded rock: a low, rounded dome of rock sunk into the ground, `across` m wide where it
  // meets the ground and its crown `proud` m above it. The hull is the top of an ellipsoid (the
  // ground cuts it at 70% of its half-height) with a flat base buried about `proud` deep, tilted
  // to the ground's slope: crawl-over relief in the wheel tracks, smooth enough to roll onto.
  // ground: optional { y, gx, gz } surface height and slope to sit on instead of the heightfield
  // (e.g. the top of a step slab)
  const embedded = (x, z, across, proud, ground = null) => {
    const pts = [];
    const e = 0.75 + R() * 0.5, ax = across * 0.7 * e, az = (across * 0.7) / e, ay = proud / 0.3;
    for (const v of [0.4, 0.58, 0.72, 0.84, 0.93]) {
      const rr = Math.sqrt(1 - v * v), n = v > 0.9 ? 6 : 8, a0 = R() * 6.28;
      for (let k = 0; k < n; k++) {
        const a = a0 + (k / n) * Math.PI * 2 + (R() - 0.5) * 0.5, j = 0.9 + R() * 0.16;
        pts.push(Math.cos(a) * rr * ax * j, (v - 0.7) * ay * (0.97 + R() * 0.06), Math.sin(a) * rr * az * j);
      }
    }
    pts.push((R() - 0.5) * ax * 0.2, proud * (0.94 + R() * 0.06), (R() - 0.5) * az * 0.2);
    const r = { pts, sy: 0, embed: 0, rotY: R() * Math.PI * 2 };
    const g = across * 0.5 + 0.3, c = Math.cos(r.rotY), s = Math.sin(r.rotY);
    const gx = ground ? ground.gx : (heightAt(x + g, z) - heightAt(x - g, z)) / (2 * g);
    const gz = ground ? ground.gz : (heightAt(x, z + g) - heightAt(x, z - g)) / (2 * g);
    for (let i = 0; i < pts.length; i += 3) { const px = pts[i], pz = pts[i + 2]; pts[i + 1] += gx * (px * c + pz * s) + gz * (-px * s + pz * c); }
    rocks.push({ x, y: ground ? ground.y : heightAt(x, z), z, rotY: r.rotY, pts, embed: true, proud });
  };
  return { rocks, shape, put, boulder, reach, ledge, embedded };
}

// ---------- physics ----------
export const GROUP_WORLD = (0x0001 << 16) | 0xffff;
export const GROUP_VEHICLE = (0x0002 << 16) | 0x0001; // vehicle parts only collide with the world

// Heightfield ground + convex rocks + tree trunks + box props (barriers, tyre walls).
// props: [{ x, y, z, hx, hy, hz, rotY }] box centre and half extents.
export function buildTerrainPhysics(RAPIER, world, grid, rocks, trees, props = []) {
  const { RES, SIZE, GRID } = grid;
  const ground = world.createCollider(
    RAPIER.ColliderDesc.heightfield(RES, RES, GRID.h, { x: SIZE, y: 1, z: SIZE })
      .setFriction(1.0).setCollisionGroups(GROUP_WORLD)
  );
  const rockHandles = new Set();
  let shared = null; // embedded rocks (hundreds of small hulls) share one fixed body
  for (const r of rocks) {
    if (r.embed) {
      const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(r.pts));
      if (!desc) continue;
      shared ||= world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      desc.setTranslation(r.x, r.y, r.z).setRotation({ x: 0, y: Math.sin(r.rotY / 2), z: 0, w: Math.cos(r.rotY / 2) });
      rockHandles.add(world.createCollider(desc.setFriction(1.0).setCollisionGroups(GROUP_WORLD), shared).handle);
      continue;
    }
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed()
      .setTranslation(r.x, r.y, r.z)
      .setRotation({ x: 0, y: Math.sin(r.rotY / 2), z: 0, w: Math.cos(r.rotY / 2) }));
    const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(r.pts));
    if (!desc) continue;
    const c = world.createCollider(desc.setFriction(1.0).setCollisionGroups(GROUP_WORLD), body);
    rockHandles.add(c.handle);
  }
  for (const t of trees) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(t.x, t.y + 1.5, t.z));
    world.createCollider(RAPIER.ColliderDesc.cylinder(1.5, 0.22 * t.s).setFriction(0.8).setCollisionGroups(GROUP_WORLD), body);
  }
  for (const b of props) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed()
      .setTranslation(b.x, b.y, b.z)
      .setRotation({ x: 0, y: Math.sin(b.rotY / 2), z: 0, w: Math.cos(b.rotY / 2) }));
    world.createCollider(RAPIER.ColliderDesc.cuboid(b.hx, b.hy, b.hz).setFriction(0.5).setRestitution(0.2).setCollisionGroups(GROUP_WORLD), body);
  }
  return { ground, rockHandles };
}
