// Trail park: rugged hills everywhere, with a graded road network and difficulty-rated
// rock-crawling trails carved through it. Heights and materials are baked once onto the
// 1 m physics grid so physics, visuals and lookups agree exactly.
import { MAT, MUD_SINK, fbm, ridged, clamp, smooth, lerp, rng, catmull, pathPoint, makeGrid, rockKit, lumps, potholes } from './common.js';

export const ID = 'park';
export const NAME = 'Trail Park';
export const KIND = 'trails';
export const SIZE = 400;          // metres, square world centred on origin
export const RES = 400;           // heightfield cells per side (1 m cells)

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
  { name: 'Bog Run', diff: 'blue', pts: [[-148, 20], [-120, 15], [-95, 0], [-80, -20], [-95, -45], [-120, -65]], mud: [0.12, 0.88], mudSink: 0.5, width: 7.5, maxGrade: 0.1 },
  { name: 'Boulder Alley', diff: 'black', pts: [[96, -96], [80, -70], [72, -50], [56, -45], [40, -60], [30, -85], [10, -110], [-8, -133]] },
  { name: 'Widowmaker Falls', diff: 'dblack', pts: [[-68, -121], [-55, -95], [-40, -75], [-30, -55], [-25, -35], [-5, -32], [20, -24]] },
];

// Ground relief on the rated trails by difficulty (the terms are those of maps/crawl.js RELIEF:
// heightfield lumps / ruts / potholes, embedded rock hulls in the tread, rubble beside it).
// Green stays gentle enough for the low Rally Sedan: nothing there stands over ~0.15 m.
const RELIEF = {
  green:  { lumps: 0.05, ruts: 0.05, holes: [9, 0.25, 0.08, 1.0], embed: { every: 3.2, size: [0.3, 0.6], proud: [0.05, 0.12] }, rubble: 5 },
  blue:   { lumps: 0.1, ruts: 0.08, holes: [8, 0.3, 0.12, 1.0], embed: { every: 2.0, size: [0.35, 0.8], proud: [0.07, 0.18] }, rubble: 3.5 },
  black:  { lumps: 0.13, ruts: 0, holes: [7, 0.3, 0.14, 1.0], embed: { every: 1.4, size: [0.4, 1.0], proud: [0.1, 0.25] }, rubble: 2.5 },
  dblack: { lumps: 0.15, ruts: 0, holes: [7, 0.35, 0.15, 1.0], embed: { every: 1.2, size: [0.45, 1.1], proud: [0.12, 0.28] }, rubble: 2.2 },
};
const MUD_RUTS = 0.14; // churned wheel ruts in Bog Run (m)
const bump = (d, r) => (d >= r ? 0 : (1 - (d / r) ** 2) ** 2);


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

// ---------- baked grid ----------
const grid = makeGrid(SIZE, RES);
const { N1, CELL } = grid;
export const { GRID, heightAt, visualHeightAt, materialAt } = grid;
export const SPAWN = { x: 0, z: 0, yaw: -Math.PI * 0.31 };

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
      let h = baseHeight(x, z) + lumps(x, z, 0.14); // rolling bumps all over the open ground
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
      let pathId = -1, sink = 0, vRut = 0;
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
          if (q.kind === 'road') {
            surf -= Math.min(1, c.d / qhw) ** 2 * 0.12; // crown
            // graded, not billiard-flat: a gentle washboard along the road (about 2.8 m, the
            // 1 m grid samples it into an uneven corrugation), soft lumps and shallow potholes
            surf += 0.022 * Math.sin(c.s * 2.24) * (0.6 + 0.4 * fbm(x * 0.05, z * 0.05, 2) * 2) + lumps(x, z, 0.03) + potholes(x, z, 10, 0.3, 0.08, 1.2, 3);
          } else {
            // rough tread, eased in away from the trail ends
            const ends = smooth(0, 12, Math.min(c.s, q.length - c.s));
            const rough = { green: 0.15, blue: 0.26, black: 0.28, dblack: 0.32 }[q.diff];
            // steep pitches get smoother rock: small steps on a 35% grade act like ledges
            const steep = q.diff === 'black' || q.diff === 'dblack' ? 1 - 0.6 * smooth(0.15, 0.35, Math.abs(c.g)) : 1;
            surf += fbm(x * 0.45, z * 0.45, 2) * rough * steep * ends;
            // micro-relief by difficulty (RELIEF): rolling lumps, wheel-track ruts, potholes
            const rl = RELIEF[q.diff], inMud = q.mud && c.s / q.length > q.mud[0] - 0.02 && c.s / q.length < q.mud[1] + 0.02;
            surf += lumps(x, z, rl.lumps) * steep * ends;
            if (rl.ruts && !inMud) surf -= rl.ruts * (0.65 + 0.7 * fbm(x * 0.11 - 4, z * 0.11 + 8, 2)) * (bump(Math.abs(c.lat - 0.82), 0.62) + bump(Math.abs(c.lat + 0.82), 0.62)) * ends;
            surf += potholes(x, z, rl.holes[0], rl.holes[1], rl.holes[2], rl.holes[3], c.pi * 17) * ends;
            const camber = { green: 0, blue: q.mud ? 0 : 0.07, black: 0.16, dblack: 0.17 }[q.diff];
            if (camber) surf += clamp(c.lat, -qhw - 0.5, qhw + 0.5) * camber * Math.sin(c.s * 0.045) * ends; // off-camber
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
            if (p.mud && f > p.mud[0] && f < p.mud[1]) {
              // the bog's floor is uneven: soft holes and firmer humps under a flat-looking surface
              const depth = (p.mudSink ?? MUD_SINK) * (1 + 0.4 * fbm(x * 0.16 + 3, z * 0.16 - 7, 2));
              mat = MAT.MUD; sink = depth * smooth(hw + 0.5, hw - 1, best.d); h -= sink;
              // churned wheel ruts along the bog: grooves you can see (60% of their depth shows),
              // deeper and softer in places, a firmer crown between them
              const ease = smooth(p.mud[0], p.mud[0] + 0.04, f) * smooth(p.mud[1], p.mud[1] - 0.04, f);
              const k = 0.6 + 0.8 * clamp(fbm(x * 0.13 + 1, z * 0.13 + 5, 2) + 0.5, 0, 1);
              const ruts = bump(Math.abs(best.lat - 0.85), 0.7) + bump(Math.abs(best.lat + 0.85), 0.7);
              h -= MUD_RUTS * k * ease * ruts - 0.04 * ease * bump(Math.abs(best.lat), 0.6);
              vRut = MUD_RUTS * k * ease * ruts * 0.4;
              GRID.tone[idx] = Math.round(clamp(ruts * k * 0.8 * ease, 0, 1) * 255);
            }
            else {
              mat = p.diff === 'green' ? (n > 0.3 ? MAT.GRAVEL : MAT.DIRT) : (n > (p.diff === 'blue' ? 0.15 : 0.35) ? MAT.DIRT : MAT.ROCK); // hard trails are mostly bare rock
              // worn wheel ruts show as darker tread
              if (RELIEF[p.diff].ruts) GRID.tone[idx] = Math.round(clamp((bump(Math.abs(best.lat - 0.82), 0.62) + bump(Math.abs(best.lat + 0.82), 0.62)) * 0.55, 0, 1) * 255 * smooth(0, 12, Math.min(best.s, p.length - best.s)));
            }
          }
        } else if (w > 0.3 && mat === MAT.GRASS) mat = MAT.DIRT;
      }
      if (wTH > 0.5) mat = MAT.ROAD;
      GRID.h[idx] = h; GRID.vis[idx] = h + sink + vRut; GRID.mat[idx] = mat; GRID.path[idx] = pathId;
    }
  }
}
bake();

function onAnyPath(x, z, margin) {
  for (const p of PATHS) for (let i = 0; i < p.pts.length; i += 2) {
    if (Math.hypot(p.pts[i].x - x, p.pts[i].z - z) < p.width / 2 + margin) return true;
  }
  return Math.hypot(x - TRAILHEAD.x, z - TRAILHEAD.z) < TRAILHEAD.r + margin;
}

// ---------- rocks ----------
export function generateRocks() {
  const R = rng(1337);
  const { rocks, shape, put, boulder, reach, ledge } = rockKit(R, heightAt);

  // Black / double-black layout. A clear lane (a bit wider than the widest track) meanders
  // through the corridor so there is always a line; boulders crowd its edges, low crawl rocks
  // sit where the tyres go, V-notches straddle it and ledges span it. Step heights shrink on
  // steep pitches: a rigid tyre that walks up a 0.6 m step on the flat can't on a 40% grade.
  const grade = (t, s) => { let g = 0; for (let q = -3; q < 3; q += 0.5) g = Math.max(g, Math.abs(pathPoint(t, s + q + 0.5).h - pathPoint(t, s + q).h) / 0.5); return g; };
  // tallest step a skilled driver can still walk a 0.45-0.5 m tyre up at this grade
  // (test/ledgegrade.mjs: the Cruiser walks 0.7 m on the flat, 0.6 at 20%, 0.5 at 30%, 0.3 at 38%)
  const stepCap = (g) => (g < 0.2 ? 0.65 : g < 0.3 ? lerp(0.65, 0.48, (g - 0.2) / 0.1) : g < 0.38 ? lerp(0.48, 0.26, (g - 0.3) / 0.08) : 0.22);
  const hardTrail = (t, spec) => {
    const hw = t.width / 2, laneHalf = spec.lane, amp = hw - laneHalf - 0.1, ph = R() * Math.PI * 2;
    // on bends the lane swings to the inside and widens (long rigs cut the corner), and the
    // meander fades out so the lane doesn't wander and turn at the same time
    const curv = (s) => { const a = pathPoint(t, s - 5), b = pathPoint(t, s + 5); const d = Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz); return Math.atan2(Math.sin(d), Math.cos(d)) / 10; };
    const lane = (s) => {
      const k = curv(s), bend = Math.min(1, Math.abs(k) * 16);
      const lc = amp * Math.sin(s * (Math.PI * 2 / 60) + ph) * (1 - bend) + clamp(-k * 18, -0.9, 0.9);
      return { lc: lc * smooth(6, 20, Math.min(s, t.length - s)), lh: laneHalf + 0.5 * bend };
    };
    let side = 1, nextLedge = 14;
    for (let s = 10; s < t.length - 8; s += spec.every * (0.7 + R() * 0.6)) {
      const p = pathPoint(t, s);
      const nx = -p.tz, nz = p.tx; // lateral
      const g = grade(t, s), { lc, lh } = lane(s);
      const cap = stepCap(g) + lerp(spec.cap[0], spec.cap[1], smooth(0.1, 0.25, g)); // per-trail nudge: [flat, steep]
      if (s > nextLedge) {
        const top = Math.min(lerp(spec.ledgeH[0], spec.ledgeH[1], R()), cap);
        const depth = 3.2 + R() * 1.2; // deeper than a wheelbase, so a step can't high-centre the frame
        // wider than the corridor and its shoulders, so the step can't be driven around
        if (top >= 0.2) { ledge(p.x, p.z, Math.atan2(p.tx, p.tz), t.width + 2.4, depth, top); s += depth / 2 + 1.5; }
        // the flat between two ledges must be longer than a rig, or tall steps form a pit the
        // bumper noses into coming off one ledge and can't climb out of onto the next
        nextLedge = s + Math.max(7.5, spec.ledgeEvery * (0.75 + R() * 0.5));
        continue;
      }
      if (R() < 0.18) {
        // V-notch: two low, sloping rocks either side of the lane centre whose flanks sit
        // under the tyres, so you ride up them while the diff and frame thread the gap
        const sz = 1.1 + R() * 0.35, top = Math.min(spec.notchTop, cap);
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
      if (R() < spec.crawl) {
        const r = shape(0.35 + R() * 0.3, 0.8, 0.35, Math.min(spec.crawlTop, cap));
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
      // green rocks stay under the Rally Sedan's 0.25 m sills; its ledges are curb-sized
      green:  { every: 7,   min: 0.25, max: 0.7, ledgeEvery: 28, ledgeH: [0.1, 0.17], ledgeD: [3, 1], notch: false, top: 0.2 },
      blue:   { every: 3.6, min: 0.45, max: 1.15, ledgeEvery: 11, ledgeH: [0.48, 0.62], ledgeD: [3.4, 1], notch: false, top: 0.55 },
      black:  { every: 2.6, min: 0.7,  max: 1.7, ledgeEvery: 8,  ledgeH: [0.5, 0.68], notch: true, top: 0.7, lane: 1.4, cap: [0, 0], notchTop: 0.5, crawl: 0.65, crawlTop: 0.38 },
      dblack: { every: 2.3, min: 0.85, max: 2.0, ledgeEvery: 4, ledgeH: [0.55, 0.74], notch: true, top: 0.8, lane: 1.3, cap: [0.05, 0.05], notchTop: 0.6, crawl: 0.8, crawlTop: 0.45 },
    }[t.diff];
    const hw = t.width / 2;
    if (t.diff === 'black' || t.diff === 'dblack') { hardTrail(t, spec); continue; }
    let side = 1, nextLedge = spec.ledgeEvery ? 12 : Infinity;
    for (let s = 10; s < t.length - 8; s += spec.every * (0.7 + R() * 0.6)) {
      const p = pathPoint(t, s);
      const nx = -p.tz, nz = p.tx; // lateral
      if (t.mud) { const f = s / t.length; if (f > t.mud[0] - 0.03 && f < t.mud[1] + 0.03) continue; }
      if (s > nextLedge) {
        // deeper than a wheelbase, so a step can't hang the frame; lower on steep pitches
        const depth = spec.ledgeD[0] + R() * spec.ledgeD[1];
        const top = Math.min(lerp(spec.ledgeH[0], spec.ledgeH[1], R()), stepCap(grade(t, s)));
        ledge(p.x, p.z, Math.atan2(p.tx, p.tz), t.width + 1.2, depth, top);
        nextLedge = s + spec.ledgeEvery * (0.75 + R() * 0.5);
        s += depth / 2 + 1.5;
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

  // ---- ground relief: embedded rocks in the trail tread (mostly the wheel tracks) and rock
  // rubble beside it, by difficulty (RELIEF); own random stream, so the layout above holds ----
  const E = rockKit(rng(4711), heightAt), R2 = rng(4712);
  const ledges = rocks.filter((r) => r.ledge);
  for (const t of TRAILS) {
    const rl = RELIEF[t.diff], e = rl.embed, hw = t.width / 2;
    const mud = (s) => t.mud && s / t.length > t.mud[0] - 0.03 && s / t.length < t.mud[1] + 0.03;
    const nearLedge = (x, z) => ledges.some((r) => Math.hypot(r.x - x, r.z - z) < 4.2);
    for (let s = 8; s < t.length - 6; s += e.every * (0.6 + R2() * 0.8)) {
      if (mud(s)) continue;
      const p = pathPoint(t, s), lat = R2() < 0.7 ? (R2() < 0.5 ? -1 : 1) * (0.8 + (R2() - 0.5) * 0.6) : (R2() * 2 - 1) * (hw - 0.4);
      const x = p.x - p.tz * lat, z = p.z + p.tx * lat;
      if (nearLedge(x, z)) continue;
      const k = R2();
      E.embedded(x, z, lerp(e.size[0], e.size[1], k), lerp(e.proud[0], e.proud[1], 0.3 * R2() + 0.7 * k));
    }
    for (let s = 6; s < t.length - 4; s += rl.rubble * (0.6 + R2() * 0.8)) {
      if (mud(s)) continue;
      const p = pathPoint(t, s), lat = (R2() < 0.5 ? -1 : 1) * (hw + 0.7 + R2() * 3.2);
      const x = p.x - p.tz * lat, z = p.z + p.tx * lat;
      if (onAnyPath(x, z, 0.5)) continue;
      E.embedded(x, z, 0.4 + R2() * 0.7, 0.08 + R2() * 0.17);
    }
  }
  for (const r of E.rocks) rocks.push(r);
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

