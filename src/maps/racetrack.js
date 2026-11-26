// Race track: a ~1.3 km short-course off-road circuit. Wide graded dirt with gravel
// patches and a tarmac start/finish straight, banked turns, whoops, a tabletop, a
// step-up, a rock garden and a water splash. Edges are marked with posts, cones, tyre
// walls and concrete barriers (the walls and barriers have colliders).
import { MAT, fbm, clamp, smooth, lerp, rng, catmull, arcLength, pathPoint, makeGrid, rockKit, lumps, potholes } from './common.js';

export const ID = 'race';
export const NAME = 'Race Track';
export const KIND = 'race';
export const SIZE = 400;
export const RES = 400;

const WIDTH = 12, SHOULDER = 7;
const HW = WIDTH / 2;

function baseHeight(x, z) {
  let h = fbm(x * 0.007 + 3, z * 0.007 - 7, 3) * 7 + fbm(x * 0.03, z * 0.03, 2) * 1.0 + fbm(x * 0.15, z * 0.15, 2) * 0.15;
  const edge = Math.max(Math.abs(x), Math.abs(z));
  h += smooth(172, 198, edge) * 22; // hills ringing the venue
  return h;
}

// ---------- centreline ----------
const CTRL = [[-80, 128], [0, 132], [80, 128], [140, 105], [162, 45], [135, 0], [85, 5], [45, -25], [60, -75], [115, -95], [155, -130],
  [120, -162], [40, -155], [-20, -110], [-75, -140], [-140, -125], [-162, -60], [-118, -15], [-150, 40], [-140, 105]];
const pts = catmull(CTRL, 2, true);
const L = arcLength(pts);
const NP = pts.length - 1; // last point duplicates the first
const wrap = (s) => ((s % L) + L) % L;

// Feature layout along the lap (metres from the line where the spline starts).
export const START_S = 30; // start / finish line
const F = {
  tarmac: [L - 25, 150],
  gravel: [[225, 330], [595, 680], [1000, 1080]],
  whoops: [505, 565],
  table: { up: 690, lip: 701, end: 713, down: 726, H: 1.5 },
  rocks: [838, 876],
  step: { up: 893, lip: 902, dip: 904.5, face: 908, top: 930, down: 960, kick: 1.1, low: 0.75, H: 1.6 },
  splash: [762, 798, 0.6],
};
const inR = (s, [a, b]) => (a < b ? s >= a && s <= b : s >= a || s <= b);

// height of the built features above the graded profile, sampled at 0.5 m and softened
function featureRaw(s) {
  const t = F.table;
  if (s >= t.up && s < t.lip) { const u = (s - t.up) / (t.lip - t.up); return t.H * u * u; } // kicker: steepest at the lip
  if (s >= t.lip && s < t.end) return t.H;
  if (s >= t.end && s < t.down) { const u = (s - t.end) / (t.down - t.end); return t.H * (1 - smooth(0, 1, u) * 0.35 - u * 0.65); } // long landing ramp
  const p = F.step;
  if (s >= p.up && s < p.lip) { const u = (s - p.up) / (p.lip - p.up); return p.kick * u * u; }
  if (s >= p.lip && s < p.dip) return lerp(p.kick, p.low, smooth(p.lip, p.dip, s));
  if (s >= p.dip && s < p.face) return lerp(p.low, p.H, smooth(p.dip, p.face, s)); // drivable face if you come up short
  if (s >= p.face && s < p.top) return p.H;
  if (s >= p.top && s < p.down) return p.H * (1 - smooth(p.top, p.down, s));
  const [w0, w1] = F.whoops;
  if (s >= w0 && s < w1) { const env = smooth(w0, w0 + 6, s) * smooth(w1, w1 - 6, s); return 0.2 * env * (0.5 - 0.5 * Math.cos((2 * Math.PI * (s - w0)) / 8)); }
  const [a0, a1, depth] = F.splash;
  if (s >= a0 && s < a1) return -depth * (0.5 - 0.5 * Math.cos((2 * Math.PI * (s - a0)) / (a1 - a0)));
  return 0;
}
const FSTEP = 0.5, FN = Math.ceil(L / FSTEP) + 1;
const FEAT = new Float32Array(FN);
{
  const raw = Array.from({ length: FN }, (_, i) => featureRaw(i * FSTEP));
  // light smoothing (±0.75 m) rounds the kinks but keeps the lips sharp enough to launch
  for (let i = 0; i < FN; i++) { let a = 0; for (let k = -1; k <= 1; k++) a += raw[clamp(i + k, 0, FN - 1)]; FEAT[i] = a / 3; }
}
const feature = (s) => { const f = wrap(s) / FSTEP, i = Math.floor(f), t = f - i; return lerp(FEAT[Math.min(i, FN - 1)], FEAT[Math.min(i + 1, FN - 1)], t); };
export const WATER_Y = []; // filled below: [{ s0, s1, y }]

// graded profile: smoothed terrain, grade-limited, wrapped around the loop
{
  const raw = pts.slice(0, NP).map((p) => baseHeight(p.x, p.z));
  const win = 18;
  let hs = raw.map((_, i) => { let a = 0; for (let k = -win; k <= win; k++) a += raw[(i + k + NP) % NP]; return a / (2 * win + 1); });
  const maxG = 0.07;
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i <= NP; i++) { const j = i % NP, k = i - 1, ds = 2; hs[j] = clamp(hs[j], hs[k] - maxG * ds, hs[k] + maxG * ds); }
    for (let i = NP - 2; i >= -1; i--) { const j = (i + NP) % NP, k = (i + 1) % NP, ds = 2; hs[j] = clamp(hs[j], hs[k] - maxG * ds, hs[k] + maxG * ds); }
  }
  // the splash sits in a level dip so the water lies flat across it
  const [a0, a1] = F.splash, wet = (s) => smooth(a0 - 16, a0 - 3, s) * smooth(a1 + 16, a1 + 3, s);
  let lvl = 0, nl = 0; pts.forEach((p, i) => { if (p.s > a0 - 10 && p.s < a1 + 10) { lvl += hs[i % NP]; nl++; } }); lvl /= nl;
  pts.forEach((p, i) => { p.base = lerp(hs[i % NP], lvl, wet(p.s)); });
  // curvature (rad/m) over ±8 m, then a smoothed bank slope: the outside of a bend rides higher
  const head = (i) => { const a = pts[(i + NP) % NP], b = pts[(i + 1 + NP) % NP]; return Math.atan2(b.x - a.x, b.z - a.z); };
  const curv = pts.slice(0, NP).map((_, i) => { let d = head(i + 4) - head(i - 4); d = Math.atan2(Math.sin(d), Math.cos(d)); return d / 16; });
  const bank = curv.map((_, i) => { let a = 0; for (let k = -6; k <= 6; k++) a += curv[(i + k + NP) % NP]; return clamp((a / 13) * 9, -0.24, 0.24); });
  pts.forEach((p, i) => { p.k = curv[i % NP]; p.bank = bank[i % NP] * (1 - wet(p.s)); p.h = p.base + feature(p.s); });
  WATER_Y.push({ s0: a0, s1: a1, y: lvl - F.splash[2] * 0.42 });
}

export const TRACK = { name: 'Dust Bowl Circuit', kind: 'track', closed: true, pts, length: L, width: WIDTH, shoulder: SHOULDER, features: F };
export const ROADS = [];
export const TRAILS = [];

// at s along the lap: position, tangent, bank, curvature
export function trackFrame(s) {
  const p = pathPoint(TRACK, wrap(s));
  const i = clamp(Math.round(wrap(s) / 2), 0, NP - 1);
  return { ...p, bank: pts[i].bank, k: pts[i].k };
}

// ordered checkpoints; index 0 is the start / finish line
export const CHECKPOINTS = [START_S, 250, 470, 650, 815, 985, 1140].map((s, i) => {
  const p = trackFrame(s);
  return { i, s, x: p.x, z: p.z, tx: p.tx, tz: p.tz, hw: HW + 1.5 };
});

// spectator pad outside the start straight, flattened for the grandstand
const SPECT = { x0: -70, x1: 70, z0: 140, z1: 168 };
const PADDOCK = { x: 10, z: 92, r: 26 }; // infield paddock

// ---------- baked grid ----------
const grid = makeGrid(SIZE, RES);
const { N1, CELL } = grid;
export const { GRID, heightAt, visualHeightAt, materialAt } = grid;
const sS = trackFrame(START_S - 13);
export const SPAWN = { x: sS.x, z: sS.z, yaw: Math.atan2(-sS.tx, -sS.tz) };

function nearestOnTrack(x, z, bins, nb, B) {
  const bin = bins[Math.floor((x + SIZE / 2) / B) * nb + Math.floor((z + SIZE / 2) / B)] || [];
  let best = null;
  for (const i of bin) {
    const a = pts[i - 1], b = pts[i];
    const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / L2, 0, 1);
    const px = a.x + ex * t, pz = a.z + ez * t;
    const d = Math.hypot(x - px, z - pz);
    if (best && d >= best.d) continue;
    const Ls = Math.sqrt(L2);
    best = { d, lat: ((x - a.x) * -ez + (z - a.z) * ex) / Ls, s: lerp(a.s, b.s, t), base: lerp(a.base, b.base, t), bank: lerp(a.bank, b.bank, t) };
  }
  return best;
}

// 0..1: braking zone strength at s, the ~30 m before a bend tighter than ~45 m radius (and not
// in the bend itself), where braking bumps form
const BRAKE = new Float32Array(NP);
for (let i = 0; i < NP; i++) {
  let m = 0;
  for (let q = 3; q <= 17; q++) m = Math.max(m, Math.abs(pts[(i + q) % NP].k)); // 6-34 m ahead (2 m spacing)
  BRAKE[i] = smooth(1 / 75, 1 / 45, m) * (1 - smooth(1 / 90, 1 / 55, Math.abs(pts[i].k)));
}
const brakeBumps = (s) => BRAKE[clamp(Math.round((wrap(s) / L) * NP), 0, NP - 1)];

function bake() {
  const B = 16, nb = Math.ceil(SIZE / B);
  const bins = Array.from({ length: nb * nb }, () => []);
  const reach = HW + SHOULDER + 3;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const x0 = Math.floor((Math.min(a.x, b.x) - reach + SIZE / 2) / B), x1 = Math.floor((Math.max(a.x, b.x) + reach + SIZE / 2) / B);
    const z0 = Math.floor((Math.min(a.z, b.z) - reach + SIZE / 2) / B), z1 = Math.floor((Math.max(a.z, b.z) + reach + SIZE / 2) / B);
    for (let bx = Math.max(0, x0); bx <= Math.min(nb - 1, x1); bx++) for (let bz = Math.max(0, z0); bz <= Math.min(nb - 1, z1); bz++) bins[bx * nb + bz].push(i);
  }
  const water = WATER_Y[0];
  for (let ix = 0; ix <= RES; ix++) {
    const x = -SIZE / 2 + ix * CELL;
    for (let iz = 0; iz <= RES; iz++) {
      const z = -SIZE / 2 + iz * CELL;
      const idx = ix * N1 + iz;
      let h = baseHeight(x, z), vis = null; // vis: shown height where it differs (mud sinks in)
      const n = fbm(x * 0.08 + 9, z * 0.08 - 4, 3);
      let mat = n > 0.15 ? MAT.DIRT : MAT.GRASS;
      if (Math.max(Math.abs(x), Math.abs(z)) > 178) mat = n > 0 ? MAT.ROCK : MAT.GRAVEL;
      // flat pads for the grandstand and the paddock, at the height of the nearby track
      const dx = Math.max(SPECT.x0 - x, 0, x - SPECT.x1), dz = Math.max(SPECT.z0 - z, 0, z - SPECT.z1);
      const wS = 1 - smooth(0, 10, Math.hypot(dx, dz));
      if (wS > 0) { h = lerp(h, pathPoint(TRACK, START_S + 30).h + 0.15, wS); if (wS > 0.6) mat = n > 0.3 ? MAT.DIRT : MAT.GRASS; }
      const dP = Math.hypot(x - PADDOCK.x, z - PADDOCK.z), wP = 1 - smooth(PADDOCK.r, PADDOCK.r + 12, dP);
      if (wP > 0) { h = lerp(h, pathPoint(TRACK, 80).h + 0.1, wP); if (wP > 0.7) mat = MAT.GRAVEL; }
      const c = nearestOnTrack(x, z, bins, nb, B);
      if (c && c.d < HW + SHOULDER) {
        // the outside berm keeps rising past the track edge, then the shoulder eases back
        const lat = clamp(c.lat, -HW - 2.5, HW + 2.5);
        let surf = c.base + feature(c.s) + lat * c.bank;
        surf -= Math.min(1, c.d / HW) ** 2 * 0.08; // crown for drainage
        surf += fbm(x * 0.3, z * 0.3, 2) * 0.05;
        // rally-stage character off the tarmac and the built features: a washboard on the
        // straights, braking bumps into the bends, soft lumps and the odd shallow pothole
        const graded = !inR(c.s, F.tarmac) && Math.abs(feature(c.s)) < 0.02 && !(c.s > F.rocks[0] - 4 && c.s < F.rocks[1] + 4);
        if (graded) {
          const ease = smooth(HW + 1, HW - 1, c.d);
          surf += (brakeBumps(c.s) * 0.035 * Math.sin(c.s * 1.96) + 0.018 * (1 - smooth(0.02, 0.1, Math.abs(c.bank))) * Math.sin(c.s * 2.24)) * ease;
          surf += lumps(x, z, 0.025) + potholes(x, z, 11, 0.25, 0.07, 1.2, 5) * ease;
        }
        const inRocks = c.s > F.rocks[0] && c.s < F.rocks[1];
        if (inRocks) surf += fbm(x * 0.5, z * 0.5, 2) * 0.08 * smooth(F.rocks[0], F.rocks[0] + 4, c.s) * smooth(F.rocks[1], F.rocks[1] - 4, c.s);
        // tabletop and step-up sides fall away steeply instead of fanning out into the field
        const side = Math.max(0, feature(c.s));
        const sh = side > 0.2 ? 2.5 + side * 1.2 : SHOULDER;
        const w = 1 - smooth(HW, HW + Math.min(SHOULDER, sh), c.d);
        h = lerp(h, surf, w);
        if (c.d < HW + 0.4) {
          const tn = fbm(c.s * 0.05, c.lat * 0.08 + 3, 2);
          // a firmer swept line (dirt) runs through the bends towards the inside; off it the
          // surface is loose gravel marbles, a little less grip
          const lineLat = -clamp(c.bank * 8, -1, 1) * (HW - 3), offLine = Math.abs(c.lat - lineLat) > 3.2;
          mat = inR(c.s, F.tarmac) ? MAT.TARMAC : F.gravel.some((g) => inR(c.s, g)) ? (tn > 0.45 ? MAT.DIRT : MAT.GRAVEL) : offLine && tn > 0.05 ? MAT.GRAVEL : MAT.DIRT;
          if (inRocks) mat = MAT.ROCK;
          // the splash's surrounds churn to mud along the track edges (the line stays firm)
          if (water && c.s > water.s0 - 12 && c.s < water.s1 + 12 && c.d > HW - 2.6 && !inRocks) {
            const ruts = 0.05 * (0.6 + 0.8 * clamp(fbm(x * 0.2, z * 0.2, 2) + 0.5, 0, 1));
            mat = MAT.MUD; h -= 0.06 + ruts; vis = h + 0.06 + ruts * 0.4; GRID.tone[idx] = Math.min(255, Math.round(120 + ruts * 1500));
          }
          GRID.path[idx] = 0; // worn, darker racing surface
        } else if (c.d < HW + 1.6 && !inR(c.s, F.tarmac)) mat = MAT.GRAVEL; // loose verge, then the field
        if (water && c.s > water.s0 && c.s < water.s1 && h < water.y && c.d < HW + 3) mat = MAT.WATER;
      }
      GRID.h[idx] = h; GRID.vis[idx] = vis ?? h; GRID.mat[idx] = mat;
    }
  }
}
bake();

// ---------- props: barriers, tyre walls (colliders), posts and cones (visual) ----------
// Box props have colliders: { kind, x, y, z, hx, hy, hz, rotY }
export const PROPS = [];
export const DECOR = { posts: [], cones: [], gantry: null, spect: SPECT, paddock: PADDOCK, water: WATER_Y[0] };
{
  const lap = (s0, s1, step, fn) => { for (let s = s0; s < s1; s += step) fn(wrap(s)); };
  const put = (kind, s, lat, hx, hy, hz, extraYaw = 0) => {
    const p = trackFrame(s);
    const x = p.x - p.tz * lat, z = p.z + p.tx * lat;
    const yaw = Math.atan2(p.tx, p.tz) + extraYaw;
    PROPS.push({ kind, x, y: heightAt(x, z) + hy - 0.05, z, hx, hy, hz, rotY: yaw });
  };
  const nearStart = (s) => Math.abs(wrap(s - START_S + L / 2) - L / 2) < 6;
  // concrete barriers line both sides of the tarmac straight (gap at the gantry legs)
  lap(F.tarmac[0], L + F.tarmac[1], 3.2, (s) => { if (nearStart(s)) return; for (const sd of [-1, 1]) put('barrier', s, sd * (HW + 2.4), 0.3, 0.45, 1.55); });
  // tyre walls on the outside of the tighter bends; cones mark the inside apex
  lap(0, L, 2.2, (s) => {
    if (inR(s, F.tarmac)) return;
    const f = trackFrame(s), k = f.k;
    const featureHere = Math.abs(feature(s)) > 0.05;
    if (Math.abs(k) > 1 / 48 && !featureHere) put('tyres', s, Math.sign(k) * (HW + 3.2), 0.5, 0.42, 1.05);
    if (Math.abs(k) > 1 / 38 && Math.round(s / 2.2) % 3 === 0) {
      const lat = -Math.sign(k) * (HW + 0.7), x = f.x - f.tz * lat, z = f.z + f.tx * lat;
      DECOR.cones.push([x, heightAt(x, z), z]);
    }
  });
  // marker posts both sides on the rest of the lap
  lap(0, L, 12, (s) => {
    if (inR(s, F.tarmac)) return;
    const f = trackFrame(s);
    for (const sd of [-1, 1]) {
      if (Math.abs(f.k) > 1 / 48 && Math.sign(f.k) === sd) continue; // tyre wall there already
      const lat = sd * (HW + 1.6), x = f.x - f.tz * lat, z = f.z + f.tx * lat;
      DECOR.posts.push([x, heightAt(x, z), z, sd]);
    }
  });
  // start / finish gantry legs
  for (const sd of [-1, 1]) put('gantry', START_S, sd * (HW + 1.6), 0.45, 3.4, 0.45);
  const g = trackFrame(START_S);
  DECOR.gantry = { x: g.x, z: g.z, y: pathPoint(TRACK, START_S).h, yaw: Math.atan2(g.tx, g.tz), span: HW + 1.6 };
  // grandstand blocks along the spectator pad, behind the barriers
  for (let x = SPECT.x0 + 12; x <= SPECT.x1 - 12; x += 30) PROPS.push({ kind: 'stand', x, y: heightAt(x, 158) + 1.6, z: 158, hx: 12, hy: 1.6, hz: 5, rotY: 0 });
  // catch fence between the barriers and the crowd
  for (let x = SPECT.x0; x < SPECT.x1; x += 6) PROPS.push({ kind: 'fence', x: x + 3, y: heightAt(x + 3, 146) + 1.1, z: 146, hx: 3, hy: 1.1, hz: 0.06, rotY: 0 });
}

function nearTrack(x, z, margin) {
  for (let i = 0; i < NP; i += 2) if (Math.hypot(pts[i].x - x, pts[i].z - z) < HW + margin) return true;
  return false;
}
const inPads = (x, z, m) => (x > SPECT.x0 - m && x < SPECT.x1 + m && z > SPECT.z0 - m && z < SPECT.z1 + m) || Math.hypot(x - PADDOCK.x, z - PADDOCK.z) < PADDOCK.r + m;

// ---------- rocks ----------
export function generateRocks() {
  const R = rng(2024);
  const { rocks, shape, put, boulder } = rockKit(R, heightAt);
  // rock garden: low, embedded slabs across the whole width, a rough but fast section
  for (let s = F.rocks[0] + 3; s < F.rocks[1] - 3; s += 2.2 + R() * 1.6) {
    const p = trackFrame(s);
    for (let k = 0; k < 2; k++) {
      const lat = (R() * 2 - 1) * (HW - 0.8);
      const r = shape(0.6 + R() * 0.5, 0.4, 0.55, 0.14);
      put(r, p.x - p.tz * lat, p.z + p.tx * lat, true);
    }
  }
  // feature boulders lining the rock garden
  for (let s = F.rocks[0]; s < F.rocks[1]; s += 4) {
    const p = trackFrame(s);
    for (const sd of [-1, 1]) { const lat = sd * (HW + 1.2 + R() * 1.5); boulder(p.x - p.tz * lat, p.z + p.tx * lat, 0.8 + R() * 0.9, 0.8); }
  }
  // scattered boulders around the venue, kept well off the track and pads
  for (let i = 0; i < 160; i++) {
    const x = (R() * 2 - 1) * 180, z = (R() * 2 - 1) * 180;
    if (nearTrack(x, z, 14) || inPads(x, z, 6)) continue;
    boulder(x, z, 0.5 + Math.pow(R(), 2) * 2.2, 0.8);
  }
  return rocks;
}

export function generateTrees() {
  const R = rng(777);
  const trees = [];
  for (let i = 0; i < 3000 && trees.length < 260; i++) {
    const x = (R() * 2 - 1) * 182, z = (R() * 2 - 1) * 182;
    const m = materialAt(x, z);
    if (m !== MAT.GRASS && m !== MAT.DIRT) continue;
    if (nearTrack(x, z, 18) || inPads(x, z, 8)) continue;
    trees.push({ x, z, y: heightAt(x, z), s: 0.7 + R() * 0.8 });
  }
  return trees;
}
