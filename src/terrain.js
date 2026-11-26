// Trail-park terrain: rugged hills everywhere, with a graded road network and
// difficulty-rated rock-crawling trails carved through it. Heights and materials are
// baked once onto the 1 m physics grid so physics, visuals and lookups agree exactly.
// No three.js here so it can run headless in Node for physics tests.

export const SIZE = 400;          // metres, square world centred on origin
export const RES = 400;           // heightfield cells per side (1 m cells)

export const MAT = { GRASS: 0, DIRT: 1, ROCK: 2, MUD: 3, SAND: 4, GRAVEL: 5, ROAD: 6 };
export const MAT_INFO = [
  // mu: tyre friction, rr: rolling resistance (x wheel load), drag: viscous drag through the medium
  { name: 'Grass',  mu: 0.72, rr: 0.020, drag: 0,   color: [0.42, 0.50, 0.25] },
  { name: 'Dirt',   mu: 0.85, rr: 0.020, drag: 0,   color: [0.55, 0.42, 0.29] },
  { name: 'Rock',   mu: 1.10, rr: 0.010, drag: 0,   color: [0.56, 0.54, 0.51] },
  { name: 'Mud',    mu: 0.42, rr: 0.120, drag: 260, color: [0.27, 0.20, 0.14] },
  { name: 'Sand',   mu: 0.62, rr: 0.080, drag: 60,  color: [0.84, 0.74, 0.52] },
  { name: 'Gravel', mu: 0.68, rr: 0.030, drag: 0,   color: [0.60, 0.57, 0.53] },
  { name: 'Road',   mu: 0.80, rr: 0.015, drag: 0,   color: [0.74, 0.66, 0.52] },
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
function ridged(x, z, oct = 4) {
  let s = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += (1 - Math.abs(vnoise(x * f + i * 17, z * f - i * 9))) ** 2 * amp; norm += amp; amp *= 0.5; f *= 2.1; }
  return s / norm;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Raw rugged landscape before carving.
function baseHeight(x, z) {
  let h = ridged(x * 0.008 + 5, z * 0.008 - 3, 4) * 34 - 10;
  h += fbm(x * 0.03, z * 0.03, 3) * 4 + fbm(x * 0.12, z * 0.12, 2) * 0.8;
  const edge = Math.max(Math.abs(x), Math.abs(z));
  h += smooth(160, 198, edge) * 30;
  return h;
}

// ---------- paths ----------
// Control points are hand-placed; they get smoothed into splines.
export const TRAILHEAD = { x: 0, z: 0, r: 22 };
const ROAD_DEFS = [
  { name: 'Ridge Road', pts: [[0, 0], [30, -20], [70, -30], [115, -15], [150, 30], [140, 85], [95, 120], [40, 130], [-20, 115], [-70, 125], [-125, 100], [-150, 45], [-145, -20], [-120, -80], [-70, -120], [-10, -135], [45, -125], [90, -100], [115, -15]] },
  { name: 'Spur Road', pts: [[0, 0], [-25, 30], [-40, 70], [-20, 115]] },
];
const TRAIL_DEFS = [
  { name: 'Pinyon Two-Track', diff: 'green', pts: [[-20, 13], [-36, 17], [-60, 25], [-80, 50], [-90, 80], [-70, 105], [-62, 122]] },
  { name: 'Granite Steps', diff: 'blue', pts: [[40, 131], [55, 100], [70, 80], [100, 70], [125, 60], [146, 50]] },
  { name: 'Bog Run', diff: 'blue', pts: [[-148, 20], [-120, 15], [-95, 0], [-80, -20], [-95, -45], [-120, -65]], mud: [0.2, 0.8], width: 7.5, maxGrade: 0.1 },
  { name: 'Boulder Alley', diff: 'black', pts: [[96, -96], [80, -70], [72, -50], [56, -45], [40, -60], [30, -85], [10, -110], [-8, -133]] },
  { name: 'Widowmaker Falls', diff: 'dblack', pts: [[-68, -121], [-55, -95], [-40, -75], [-30, -55], [-25, -35], [-5, -32], [20, -24]] },
];

function catmull(pts, step) {
  const out = [];
  const P = (i) => pts[clamp(i, 0, pts.length - 1)];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(2, Math.ceil(segLen / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0[0], p1[0], p2[0], p3[0]), z: f(p0[1], p1[1], p2[1], p3[1]) });
    }
  }
  const last = pts[pts.length - 1];
  out.push({ x: last[0], z: last[1] });
  return out;
}

function nearestRoadHeight(x, z) {
  let best = Infinity, h = 1;
  for (const r of ROADS) for (const p of r.pts) { const d = Math.hypot(p.x - x, p.z - z); if (d < best) { best = d; h = p.h; } }
  if (Math.hypot(x - TRAILHEAD.x, z - TRAILHEAD.z) < TRAILHEAD.r + 4) return 1;
  return h;
}

function buildPath(def, kind) {
  const isRoad = kind === 'road';
  const pts = catmull(def.pts, 2);
  let s = 0;
  pts.forEach((p, i) => { if (i) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z); p.s = s; });
  // height profile: smoothed terrain, grade-limited
  const raw = pts.map((p) => baseHeight(p.x, p.z));
  const win = isRoad ? 14 : 5;
  let hs = raw.map((_, i) => { let a = 0, n = 0; for (let k = -win; k <= win; k++) { const j = clamp(i + k, 0, raw.length - 1); a += raw[j]; n++; } return a / n; });
  const near = (x, z, r) => Math.hypot(x - TRAILHEAD.x, z - TRAILHEAD.z) < r;
  hs = hs.map((h, i) => (near(pts[i].x, pts[i].z, TRAILHEAD.r + 6) ? lerp(h, 1, 0.9) : h));
  const maxG = def.maxGrade ?? (isRoad ? 0.13 : def.diff === 'dblack' ? 0.38 : def.diff === 'black' ? 0.34 : def.diff === 'blue' ? 0.35 : 0.25);
  // trails start and end exactly on the road surface, so junctions have no step
  const pin = !isRoad;
  for (let pass = 0; pass < 3; pass++) {
    if (pin) { hs[0] = nearestRoadHeight(pts[0].x, pts[0].z); hs[hs.length - 1] = nearestRoadHeight(pts.at(-1).x, pts.at(-1).z); }
    for (let i = 1; i < hs.length; i++) { const ds = pts[i].s - pts[i - 1].s; hs[i] = clamp(hs[i], hs[i - 1] - maxG * ds, hs[i - 1] + maxG * ds); }
    for (let i = hs.length - 2; i >= 0; i--) { const ds = pts[i + 1].s - pts[i].s; hs[i] = clamp(hs[i], hs[i + 1] - maxG * ds, hs[i + 1] + maxG * ds); }
  }
  if (pin) {
    const h0 = hs[0], h1 = hs[hs.length - 1], L = pts[pts.length - 1].s;
    hs = hs.map((h, i) => { const s = pts[i].s; return lerp(h1, lerp(h0, h, smooth(0, 15, s)), smooth(0, 15, L - s)); });
  }
  pts.forEach((p, i) => { p.h = hs[i]; });
  const width = def.width ?? (isRoad ? 8 : def.diff === 'green' ? 5.5 : def.diff === 'blue' ? 5 : 5.2);
  return { ...def, kind, pts, length: s, width, shoulder: isRoad ? 6 : 3.5 };
}

export const ROADS = [];
ROAD_DEFS.forEach((d) => ROADS.push(buildPath(d, 'road')));
export const TRAILS = TRAIL_DEFS.map((d) => buildPath(d, 'trail'));
const PATHS = [...ROADS, ...TRAILS];

// Path sampling helpers
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
const N1 = RES + 1;
const CELL = SIZE / RES;
export const GRID = { h: new Float32Array(N1 * N1), vis: new Float32Array(N1 * N1), mat: new Uint8Array(N1 * N1), path: new Int16Array(N1 * N1) };

function bake() {
  // spatial hash of path segments
  const B = 16, nb = Math.ceil(SIZE / B);
  const bins = Array.from({ length: nb * nb }, () => []);
  PATHS.forEach((p, pi) => {
    for (let i = 1; i < p.pts.length; i++) {
      const a = p.pts[i - 1], b = p.pts[i];
      const reach = p.width / 2 + p.shoulder + 1;
      const x0 = Math.floor((Math.min(a.x, b.x) - reach + SIZE / 2) / B), x1 = Math.floor((Math.max(a.x, b.x) + reach + SIZE / 2) / B);
      const z0 = Math.floor((Math.min(a.z, b.z) - reach + SIZE / 2) / B), z1 = Math.floor((Math.max(a.z, b.z) + reach + SIZE / 2) / B);
      for (let bx = Math.max(0, x0); bx <= Math.min(nb - 1, x1); bx++) for (let bz = Math.max(0, z0); bz <= Math.min(nb - 1, z1); bz++) bins[bx * nb + bz].push([pi, i]);
    }
  });
  for (let ix = 0; ix <= RES; ix++) {
    const x = -SIZE / 2 + ix * CELL;
    for (let iz = 0; iz <= RES; iz++) {
      const z = -SIZE / 2 + iz * CELL;
      const idx = ix * N1 + iz;
      let h = baseHeight(x, z);
      // trailhead parking lot
      const dTH = Math.hypot(x - TRAILHEAD.x, z - TRAILHEAD.z);
      const wTH = 1 - smooth(TRAILHEAD.r, TRAILHEAD.r + 10, dTH);
      h = lerp(h, 1 + fbm(x * 0.2, z * 0.2, 2) * 0.08, wTH);
      // nearest path
      const bin = bins[Math.floor((x + SIZE / 2) / B) * nb + Math.floor((z + SIZE / 2) / B)] || [];
      let best = null;
      const perPath = new Map(); // nearest segment of every path in reach
      for (const [pi, i] of bin) {
        const p = PATHS[pi], a = p.pts[i - 1], b = p.pts[i];
        const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
        const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / L2, 0, 1);
        const px = a.x + ex * t, pz = a.z + ez * t;
        const d = Math.hypot(x - px, z - pz);
        const reach = p.width / 2 + p.shoulder;
        if (d > reach) continue;
        const prev = perPath.get(pi);
        if (!prev || d < prev.d) {
          const L = Math.sqrt(L2);
          const lat = ((x - a.x) * -ez + (z - a.z) * ex) / L;
          perPath.set(pi, { d, pi, lat, s: lerp(a.s, b.s, t), ph: lerp(a.h, b.h, t), g: (b.h - a.h) / Math.max(1e-6, b.s - a.s), score: d - (p.kind === 'road' ? 1.5 : 0) });
        }
      }
      for (const c of perPath.values()) if (!best || c.score < best.score) best = c; // roads win the surface type
      let mat;
      const slope = Math.hypot(baseHeight(x + 1, z) - baseHeight(x - 1, z), baseHeight(x, z + 1) - baseHeight(x, z - 1)) / 2;
      const n = fbm(x * 0.08 + 9, z * 0.08 - 4, 3);
      mat = slope > 0.75 ? MAT.ROCK : slope > 0.45 ? (n > -0.1 ? MAT.ROCK : MAT.GRAVEL) : n > 0.1 ? MAT.DIRT : MAT.GRASS;
      if (Math.max(Math.abs(x), Math.abs(z)) > 170) mat = n > 0 ? MAT.ROCK : MAT.GRAVEL;
      let pathId = -1, sink = 0;
      if (best) {
        const p = PATHS[best.pi];
        const hw = p.width / 2;
        // blend every path in reach, weighted by how far inside it we are, so road/trail
        // junctions meet smoothly instead of forming a hump or ditch
        let num = 0, den = 0, W = 0;
        for (const c of perPath.values()) {
          const q = PATHS[c.pi], qhw = q.width / 2;
          const w = 1 - smooth(qhw, qhw + q.shoulder, c.d);
          if (w <= 0) continue;
          let surf = c.ph;
          if (q.kind === 'road') surf -= Math.min(1, c.d / qhw) ** 2 * 0.12; // crown
          else {
            // rough tread, eased in away from the trail ends
            const ends = smooth(0, 12, Math.min(c.s, q.length - c.s));
            const rough = { green: 0.12, blue: 0.22, black: 0.24, dblack: 0.28 }[q.diff];
            // steep pitches get smoother rock: small steps on a 35% grade act like ledges
            const steep = q.diff === 'black' || q.diff === 'dblack' ? 1 - 0.6 * smooth(0.15, 0.35, Math.abs(c.g)) : 1;
            surf += fbm(x * 0.45, z * 0.45, 2) * rough * steep * ends;
            if (q.diff === 'black' || q.diff === 'dblack') surf += clamp(c.lat, -qhw - 0.5, qhw + 0.5) * 0.13 * Math.sin(c.s * 0.045) * ends; // off-camber
          }
          const ww = w * w * (q.kind === 'road' ? 2 : 1);
          num += surf * ww; den += ww; W = Math.max(W, w);
        }
        if (den > 0) h = lerp(h, num / den, W);
        const w = W;
        if (best.d < hw + 0.5) {
          pathId = best.pi;
          if (p.kind === 'road') mat = MAT.ROAD;
          else {
            const f = best.s / p.length;
            if (p.mud && f > p.mud[0] && f < p.mud[1]) { mat = MAT.MUD; sink = MUD_SINK * smooth(hw + 0.5, hw - 1, best.d); h -= sink; }
            else mat = p.diff === 'green' ? (n > 0.3 ? MAT.GRAVEL : MAT.DIRT) : (n > (p.diff === 'blue' ? 0.15 : 0.35) ? MAT.DIRT : MAT.ROCK); // hard trails are mostly bare rock
          }
        } else if (w > 0.3 && mat === MAT.GRASS) mat = MAT.DIRT;
      }
      if (wTH > 0.5) mat = MAT.ROAD;
      GRID.h[idx] = h; GRID.vis[idx] = h + sink; GRID.mat[idx] = mat; GRID.path[idx] = pathId;
    }
  }
}
bake();

function sampleGrid(arr, x, z) {
  const fx = clamp((x + SIZE / 2) / CELL, 0, RES - 1e-6), fz = clamp((z + SIZE / 2) / CELL, 0, RES - 1e-6);
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const a = arr[ix * N1 + iz], b = arr[(ix + 1) * N1 + iz], c = arr[ix * N1 + iz + 1], d = arr[(ix + 1) * N1 + iz + 1];
  return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
}
export const heightAt = (x, z) => sampleGrid(GRID.h, x, z);
export const visualHeightAt = (x, z) => sampleGrid(GRID.vis, x, z);
export function materialAt(x, z) {
  const ix = clamp(Math.round((x + SIZE / 2) / CELL), 0, RES), iz = clamp(Math.round((z + SIZE / 2) / CELL), 0, RES);
  return GRID.mat[ix * N1 + iz];
}
function onAnyPath(x, z, margin) {
  for (const p of PATHS) for (let i = 0; i < p.pts.length; i += 2) {
    if (Math.hypot(p.pts[i].x - x, p.pts[i].z - z) < p.width / 2 + margin) return true;
  }
  return Math.hypot(x - TRAILHEAD.x, z - TRAILHEAD.z) < TRAILHEAD.r + margin;
}

// ---------- rocks ----------
// Each rock is a convex point cloud shared by physics and visuals.
export function generateRocks() {
  const R = rng(1337);
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
  const ledge = (x, z, rotY, width, depth, top) => {
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
    const gSide = (heightAt(x + lx * hw, z + lz * hw) - heightAt(x - lx * hw, z - lz * hw)) / (2 * hw);
    for (let i = 0; i < pts.length; i += 3) pts[i + 1] += gSide * pts[i] + gAlong * pts[i + 2];
    rocks.push({ x, y: heightAt(x, z) + H / 2 - 0.6, z, rotY, pts, ledge: true });
  };

  // Black / double-black layout. A clear lane (a bit wider than the widest track) meanders
  // through the corridor so there is always a line; boulders crowd its edges, low crawl rocks
  // sit where the tyres go, V-notches straddle it and ledges span it. Step heights shrink on
  // steep pitches: a rigid tyre that walks up a 0.6 m step on the flat can't on a 40% grade.
  const hardTrail = (t, spec) => {
    const hw = t.width / 2, laneHalf = 1.4, amp = hw - laneHalf - 0.1, ph = R() * Math.PI * 2;
    const dbl = t.diff === 'dblack';
    // on bends the lane swings to the inside and widens (long rigs cut the corner), and the
    // meander fades out so the lane doesn't wander and turn at the same time
    const curv = (s) => { const a = pathPoint(t, s - 5), b = pathPoint(t, s + 5); const d = Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz); return Math.atan2(Math.sin(d), Math.cos(d)) / 10; };
    const lane = (s) => {
      const k = curv(s), bend = Math.min(1, Math.abs(k) * 16);
      const lc = amp * Math.sin(s * (Math.PI * 2 / 60) + ph) * (1 - bend) + clamp(-k * 18, -0.9, 0.9);
      return { lc: lc * smooth(6, 20, Math.min(s, t.length - s)), lh: laneHalf + 0.5 * bend };
    };
    const grade = (s) => { let g = 0; for (let q = -3; q < 3; q += 0.5) g = Math.max(g, Math.abs(pathPoint(t, s + q + 0.5).h - pathPoint(t, s + q).h) / 0.5); return g; };
    // tallest step a skilled driver can still walk a 0.45-0.5 m tyre up at this grade
    const stepCap = (g) => (g < 0.2 ? 0.65 : g < 0.3 ? lerp(0.65, 0.48, (g - 0.2) / 0.1) : g < 0.38 ? lerp(0.48, 0.26, (g - 0.3) / 0.08) : 0.22);
    let side = 1, nextLedge = 14;
    for (let s = 10; s < t.length - 8; s += spec.every * (0.7 + R() * 0.6)) {
      const p = pathPoint(t, s);
      const nx = -p.tz, nz = p.tx; // lateral
      const { lc, lh } = lane(s), cap = stepCap(grade(s));
      if (s > nextLedge) {
        const top = Math.min(lerp(spec.ledgeH[0], spec.ledgeH[1], R()), cap);
        const depth = 3.2 + R() * 1.2; // deeper than a wheelbase, so a step can't high-centre the frame
        if (top >= 0.2) { ledge(p.x, p.z, Math.atan2(p.tx, p.tz), t.width + 1.2, depth, top); s += depth / 2 + 1.5; }
        nextLedge = s + spec.ledgeEvery * (0.75 + R() * 0.5);
        continue;
      }
      if (R() < 0.18) {
        // V-notch: two low, sloping rocks either side of the lane centre whose flanks sit
        // under the tyres, so you ride up them while the diff and frame thread the gap
        const sz = 1.1 + R() * 0.35, top = Math.min(dbl ? 0.55 : 0.45, cap);
        for (const sd of [1, -1]) {
          const r = shape(sz, 0.55, 0.3, top);
          const c = lc + sd * (0.5 + reach(r, -nx * sd, -nz * sd));
          put(r, p.x + nx * c, p.z + nz * c, true);
        }
        s += 1.5;
        continue;
      }
      // boulders crowd the lane edge, alternating sides; the lane itself stays open
      {
        const r = shape(spec.min + Math.pow(R(), 1.5) * (spec.max - spec.min), 0.85, 0.35, spec.top);
        const c = lc + side * (lh + reach(r, -nx * side, -nz * side));
        put(r, p.x + nx * c, p.z + nz * c, true);
        side = -side;
      }
      // crawl rocks in the tyre tracks: small and low enough to climb, not to high-centre on
      if (R() < (dbl ? 0.65 : 0.55)) {
        const r = shape(0.35 + R() * 0.25, 0.8, 0.35, Math.min(dbl ? 0.38 : 0.32, cap));
        const c = lc + (R() < 0.5 ? -1 : 1) * (0.75 + R() * 0.25);
        put(r, p.x + nx * c, p.z + nz * c, true);
      }
      // trail-edge rocks that make the corridor read clearly, kept out of the lane
      if (R() < 0.6) {
        const sd = R() < 0.5 ? -1 : 1, r = shape(0.5 + R() * 0.9, 0.8);
        const edge = Math.max(hw - 0.1, sd * lc + lh + 0.05);
        const c = sd * (edge + reach(r, -nx * sd, -nz * sd) * (0.9 + R() * 0.3));
        put(r, p.x + nx * c, p.z + nz * c, true);
      }
    }
  };

  for (const t of TRAILS) {
    const spec = {
      green:  { every: 9,   min: 0.25, max: 0.6, ledgeEvery: 0,  ledgeH: [0, 0], notch: false, top: 0.22 },
      blue:   { every: 4.5, min: 0.4,  max: 1.0, ledgeEvery: 22, ledgeH: [0.18, 0.32], notch: false, top: 0.42 },
      black:  { every: 3,   min: 0.6,  max: 1.5, ledgeEvery: 11, ledgeH: [0.3, 0.48], notch: true, top: 0.6 },
      dblack: { every: 2.6, min: 0.8,  max: 1.9, ledgeEvery: 5.5, ledgeH: [0.42, 0.62], notch: true, top: 0.75 },
    }[t.diff];
    const hw = t.width / 2;
    if (t.diff === 'black' || t.diff === 'dblack') { hardTrail(t, spec); continue; }
    let side = 1, nextLedge = spec.ledgeEvery ? 12 : Infinity;
    for (let s = 10; s < t.length - 8; s += spec.every * (0.7 + R() * 0.6)) {
      const p = pathPoint(t, s);
      const nx = -p.tz, nz = p.tx; // lateral
      if (t.mud) { const f = s / t.length; if (f > t.mud[0] - 0.03 && f < t.mud[1] + 0.03) continue; }
      if (s > nextLedge) {
        ledge(p.x, p.z, Math.atan2(p.tx, p.tz), t.width + 1.2, 1.4 + R() * 1.2, lerp(spec.ledgeH[0], spec.ledgeH[1], R()));
        nextLedge = s + spec.ledgeEvery * (0.75 + R() * 0.5);
        s += 2.5;
        continue;
      }
      if (spec.notch && R() < 0.18) {
        // V-notch: two low, sloping rocks whose inner edges sit inside the track,
        // so you ride the tyres up their flanks and the chassis threads the gap
        const sz = 1.3 + R() * 0.5, c = 0.75 + sz * 0.75;
        boulder(p.x + nx * c, p.z + nz * c, sz, 0.55, 0.3, spec.top * 1.1);
        boulder(p.x - nx * c, p.z - nz * c, sz, 0.55, 0.3, spec.top * 1.1);
        continue;
      }
      // obstacles alternate sides so there is always a line to pick
      const off = side * (0.9 + R() * (hw - 0.9)); // keep the centre (under the diffs) clear on easier trails
      side = -side;
      boulder(p.x + nx * off, p.z + nz * off, spec.min + Math.pow(R(), 1.5) * (spec.max - spec.min), t.diff === 'green' ? 0.6 : 0.85, 0.35, spec.top);
      // trail-edge rocks that make the corridor read clearly
      if (R() < 0.6) { const e = (R() < 0.5 ? -1 : 1) * (hw + 0.6 + R()); boulder(p.x + nx * e, p.z + nz * e, 0.5 + R() * 0.9, 0.8); }
    }
  }
  // scattered boulders off the paths
  for (let i = 0; i < 260; i++) {
    const x = (R() * 2 - 1) * 175, z = (R() * 2 - 1) * 175;
    if (onAnyPath(x, z, 3)) continue;
    boulder(x, z, 0.5 + Math.pow(R(), 2) * 2.4, 0.8);
  }
  return rocks;
}

export function generateTrees() {
  const R = rng(4242);
  const trees = [];
  for (let i = 0; i < 4000 && trees.length < 420; i++) {
    const x = (R() * 2 - 1) * 178, z = (R() * 2 - 1) * 178;
    const m = materialAt(x, z);
    if (m !== MAT.GRASS && m !== MAT.DIRT) continue;
    if (onAnyPath(x, z, 4)) continue;
    trees.push({ x, z, y: heightAt(x, z), s: 0.7 + R() * 0.8 });
  }
  return trees;
}

// ---------- physics ----------
export const GROUP_WORLD = (0x0001 << 16) | 0xffff;
export const GROUP_VEHICLE = (0x0002 << 16) | 0x0001; // vehicle parts only collide with the world

export function buildTerrainPhysics(RAPIER, world, rocks, trees) {
  const ground = world.createCollider(
    RAPIER.ColliderDesc.heightfield(RES, RES, GRID.h, { x: SIZE, y: 1, z: SIZE })
      .setFriction(1.0).setCollisionGroups(GROUP_WORLD)
  );
  const rockHandles = new Set();
  for (const r of rocks) {
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
  return { ground, rockHandles };
}
