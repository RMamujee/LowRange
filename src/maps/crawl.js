// The Gauntlet: a physics and driving test course. The truck spawns at the foot of ONE long
// rock-crawling trail that climbs a mountainside in three switchback legs and gets steadily
// harder, stage by stage, from a gentle two-track to the Waterfall, then tops out on a summit
// pad. A graded bypass track runs alongside with a spur into every stage gate, so a stage can
// be skipped, retried or escaped. Everything is seeded: the same course every load.
//
// Tuning lives in STAGE_DEFS below. Climbing limits for the 0.455-0.51 m radius crawler tyres
// (test/ledgegrade.mjs and the Trail Park notes): about 0.6 m steps on up to 25% grade, 0.45 m
// at 35%; the Rally Sedan's sills clear about 0.25 m. Steps here are step-ups (a flat-topped
// slab with the ground filled in behind it), so a staircase really climbs and no pit forms
// between two steps.
import { MAT, MUD_SINK, fbm, ridged, clamp, smooth, lerp, rng, catmull, arcLength, pathPoint, makeGrid, rockKit, lumps, potholes } from './common.js';

export const ID = 'crawl';
export const NAME = 'The Gauntlet';
export const KIND = 'trails';
export const SIZE = 400;
export const RES = 400;

// ---------------------------------------------------------------- stage table
// One row per stage, in driving order. Geometry: `path` is turtle ops from the stage gate on:
// ['s', len] straight, ['a', deg, radius] arc (deg > 0 turns left). Tread: `grade` (rise/run,
// or `grades`: [[u, grade], ...] breakpoints, u = metres past the stage start; changes are
// eased over ~4 m), `rough` fbm amplitude of the tread (m), `width` (m), `mat` surface.
// Obstacle blocks (all distances u in metres from the stage start; the first 7 m are a clear
// gate apron):
//   steps:    step-ups across the full width: at [u...], rise [m...], depth (m, longer than a
//             wheelbase on the flat stages), tilt: low side alternates (m per m of width).
//             On a staircase the Cruiser walks 0.6 m up to a 28% tread grade but not even
//             0.4 m at 33% (test/stairgrade.mjs): the Waterfall sits right at that knee
//   gatekeepers: full-width up-and-down rock ledges (park-style), top (m)
//   moguls:   rounded humps under alternate wheel tracks, spaced about a wheelbase so the rig
//             sits cross-axled: one front and the opposite rear wheel up
//   twisters: diagonal ditches across the track, so the wheels drop one at a time
//   camber:   off-camber traverse, tilt ramps from deg[0] to deg[1] (left side up)
//   garden:   boulder garden: rocks crowd a meandering clear lane (half width `lane`), low
//             crawl rocks sit in the wheel tracks, `notch` = chance of a V-notch per step
//   notches / squeezes: V-notches (tyres ride two sloping rock faces) and tight rock gates
//   bog / ford: soft mud (sink m) and a water crossing (bowl depth, water depth)
export const STAGE_DEFS = [
  { name: 'Warm-up', diff: 'green', blurb: 'Rocky two-track. Any rig, 2WD is fine.',
    path: [['s', 22], ['a', -11, 50], ['a', 11, 50], ['s', 28.8]], width: 6, grade: 0, rough: 0.05, mat: 'dirt',
    dips: { every: 14, depth: 0.22, len: 7 }, stones: { every: 3.4, size: [0.2, 0.4], top: 0.1 } },
  { name: 'Articulation', diff: 'blue', blurb: 'Cross-axle humps and frame twisters: open diffs spin, lockers walk.',
    path: [['s', 60]], width: 6, grade: 0.03, rough: 0.04, mat: 'dirt',
    moguls: { from: 9, to: 35, every: 3.0, h: [0.28, 0.44], r: 1.35, lat: 0.85 },
    twisters: { from: 39, to: 55, every: 6.5, depth: [0.3, 0.4], w: 1.5, angle: 40 } },
  { name: 'Ledges I', diff: 'blue', blurb: 'A staircase of low ledges, flat between.',
    path: [['s', 56]], width: 5.6, grade: 0.03, rough: 0.04, mat: 'rock',
    steps: { at: [10, 19, 28, 37, 46], rise: [0.2, 0.22, 0.25, 0.28, 0.3], depth: 3.4 } },
  { name: 'Side-slope', diff: 'blue', blurb: 'A long off-camber traverse that keeps tilting.',
    path: [['s', 36], ['a', 90, 25]], width: 5.8, grade: 0.02, rough: 0.05, mat: 'rock',
    camber: { from: 7, full: 50, to: 66, deg: [8, 20], bumps: 0.12 } }, // 20 deg + a kicker keeps roll near 25 deg
  { name: 'Boulder Garden I', diff: 'blue', blurb: 'Medium boulders. There is an obvious line.',
    path: [['s', 22], ['a', 90, 25], ['s', 8]], width: 5.6, grade: 0.05, rough: 0.12, mat: 'rock',
    garden: { every: 3.0, size: [0.55, 1.15], top: 0.6, lane: 1.5, crawl: 0.6, crawlTop: 0.3, notch: 0 },
    gatekeepers: { at: [13, 45], top: 0.55, depth: 3.4 } }, // full-width rock ledges: the first test of tyre size
  { name: 'The Climb', diff: 'black', blurb: 'Slab at 20, 28 then 35 degrees, then loose gravel. Low range, easy throttle.',
    path: [['s', 90]], width: 5.6, rough: 0.025, mat: 'rock',
    grades: [[0, 0.03], [8, Math.tan(20 / 57.2958)], [17, Math.tan(28 / 57.2958)], [26, Math.tan(35 / 57.2958)], [34, 0.3], [38, 0.2], [58, 0.04]],
    gravel: [37, 60] },
  { name: 'Ledges II', diff: 'black', blurb: 'Tall ledges, 0.4 to 0.55 m: first on the flat, then on a climb.',
    path: [['s', 62]], width: 5.6, rough: 0.04, mat: 'rock',
    grades: [[0, 0.04], [39, 0.12], [58, 0.04]],
    steps: { at: [9, 17.5, 26, 34.5, 44, 52.5], rise: [0.4, 0.45, 0.5, 0.55, 0.4, 0.45], depth: 3.6 } },
  { name: 'Bog & Ford', diff: 'blue', blurb: 'Soft bog, then a ford. Keep your momentum.',
    path: [['s', 62]], width: 6.4, grade: 0, rough: 0.05, mat: 'dirt',
    bog: { from: 8, to: 34, sink: 0.42, width: 7.6 }, ford: { from: 40, to: 57, depth: 0.72, water: 0.5 } },
  { name: 'Notches & Squeezes', diff: 'black', blurb: 'Ride the rock faces through V-notches; thread the squeezes.',
    path: [['a', -90, 25], ['s', 25], ['a', -90, 25]], width: 5.6, grade: 0.05, rough: 0.14, mat: 'rock',
    notches: { every: 6.5, top: [0.42, 0.55], size: [1.1, 1.4] }, squeezes: { at: [45, 52, 59], gap: 2.45 },
    garden: { every: 3.4, size: [0.7, 1.4], top: 0.7, lane: 1.35, crawl: 0, crawlTop: 0, notch: 0 } },
  { name: 'Boulder Garden II', diff: 'dblack', blurb: 'Big boulders, tight lines, crawl-overs in the wheel tracks.',
    path: [['s', 65]], width: 5.4, grade: 0.06, rough: 0.2, mat: 'rock',
    garden: { every: 2.5, size: [0.85, 1.9], top: 0.75, lane: 1.4, crawl: 0.7, crawlTop: 0.38, notch: 0.15, notchTop: 0.5 } },
  { name: 'The Waterfall', diff: 'dblack', blurb: 'Stacked big ledges on a steep pitch. The hardest thing out here.',
    path: [['s', 40]], width: 5.6, rough: 0.03, mat: 'rock',
    grades: [[0, 0.04], [7, 0.28], [31, 0.04]],
    steps: { at: [9, 12.4, 15.8, 19.2, 22.6, 26], rise: [0.5, 0.52, 0.55, 0.55, 0.58, 0.52], depth: 2.9, tilt: 0.035 } },
  { name: 'Summit', diff: 'green', blurb: 'You made it. Enjoy the view.',
    path: [['s', 30]], width: 8, grade: 0, rough: 0.02, mat: 'gravel', summit: true },
];

// Ground relief per stage, same order as STAGE_DEFS (merged into each row as `relief`):
// BeamNG-style lumpy crawl ground that escalates with the stage.
//   lumps  rounded humps and hollows 1.5-4 m across baked into the heightfield (m; sd lumps/2)
//   ruts   wheel-track ruts along the trail (m deep), dirt stages
//   holes  potholes: [lattice m, chance per lattice cell, depth m, radius m]
//   embed  embedded rocks: low, rounded, FIXED hulls sunk into the tread (the 1 m heightfield
//          can't hold sub-metre bumps), mostly in the wheel tracks: one per `every` m, `size` m
//          across, crown `proud` m above the ground; `tops` = how many on each step slab
//   rubble embedded rocks on the ground beside the tread, one per `rubble` m
// Relief fades out just before every step face and gatekeeper, so the designed step heights hold.
const RELIEF = [
  /* 1 Warm-up      */ { lumps: 0.1, ruts: 0.07, holes: [8, 0.35, 0.13, 1.1], embed: { every: 2.2, size: [0.45, 0.9], proud: [0.06, 0.13] }, rubble: 3 },
  /* 2 Articulation */ { lumps: 0.07, ruts: 0.06, holes: [9, 0.25, 0.12, 1.0], embed: { every: 2.2, size: [0.3, 0.75], proud: [0.07, 0.16] }, rubble: 3 },
  /* 3 Ledges I     */ { lumps: 0.13, holes: [8, 0.3, 0.13, 1.0], embed: { every: 1.4, size: [0.35, 0.85], proud: [0.09, 0.22], tops: 1 }, rubble: 2.5 },
  /* 4 Side-slope   */ { lumps: 0.14, holes: [8, 0.3, 0.14, 1.0], embed: { every: 1.4, size: [0.35, 0.9], proud: [0.1, 0.24] }, rubble: 2.5 },
  /* 5 Garden I     */ { lumps: 0.15, holes: [7, 0.3, 0.15, 1.1], embed: { every: 1.4, size: [0.4, 1.0], proud: [0.1, 0.22] }, rubble: 2 },
  /* 6 The Climb    */ { lumps: 0.07, embed: { every: 2.0, size: [0.35, 0.8], proud: [0.06, 0.16] }, rubble: 2.5 },
  /* 7 Ledges II    */ { lumps: 0.15, holes: [7, 0.3, 0.14, 1.0], embed: { every: 1.4, size: [0.4, 1.0], proud: [0.1, 0.24], tops: 2 }, rubble: 2 },
  /* 8 Bog & Ford   */ { lumps: 0.08, ruts: 0.08, embed: { every: 2.5, size: [0.3, 0.7], proud: [0.06, 0.14] }, rubble: 3 },
  /* 9 Notches      */ { lumps: 0.2, holes: [6, 0.35, 0.17, 1.0], embed: { every: 1.2, size: [0.4, 1.1], proud: [0.12, 0.28] }, rubble: 2 },
  /* 10 Garden II   */ { lumps: 0.22, holes: [6, 0.4, 0.2, 1.1], embed: { every: 0.85, size: [0.5, 1.2], proud: [0.14, 0.3] }, rubble: 1.8 },
  /* 11 Waterfall   */ { lumps: 0.05, embed: { every: 3, size: [0.35, 0.8], proud: [0.08, 0.16] }, rubble: 2 },
  /* 12 Summit      */ { lumps: 0.04 },
];
STAGE_DEFS.forEach((d, i) => { d.relief = RELIEF[i]; });
// the bog's churned wheel ruts (m), on top of its soft, uneven floor
STAGE_DEFS[7].bog.ruts = 0.14;

const START = { x: -120, z: 110 };   // where the trail leaves the spawn pad, heading east
const H0 = 2;                        // spawn pad height
const DS = 0.5;                      // trail sample spacing (m)
const ROAD_OFFSET = 12;              // bypass track: metres to the right of the trail
const ROAD_MAX_GRADE = 0.25;         // a steep 4x4 track, not a highway
const APRON = 7;                     // clear metres after each stage gate
export const TRAILHEAD = { x: -136, z: 110, r: 12 };
export const SPAWN = { x: -139, z: 110, yaw: -Math.PI / 2 }; // facing east, down the approach

// ---------------------------------------------------------------- trail geometry
const pts = [{ x: START.x, z: START.z, s: 0 }];
export const STAGES = [];
{
  let x = START.x, z = START.z, th = 0, s = 0; // th: heading, counter-clockwise from east (north = -z)
  const push = (step) => { x += Math.cos(th) * step; z -= Math.sin(th) * step; s += step; pts.push({ x, z, s }); };
  for (const def of STAGE_DEFS) {
    const s0 = s;
    for (const op of def.path) {
      if (op[0] === 's') { const n = Math.round(op[1] / DS); for (let i = 0; i < n; i++) push(op[1] / n); }
      else {
        const a = (op[1] * Math.PI) / 180, L = Math.abs(a) * op[2], n = Math.round(L / DS), da = a / n;
        for (let i = 0; i < n; i++) { th += da / 2; push(L / n); th += da / 2; }
      }
    }
    STAGES.push({ ...def, n: STAGES.length + 1, s0, s1: s, len: s - s0, gateS: s0 + 3 });
  }
}
const LEN = pts.at(-1).s;
const stageIndexAt = (s) => { let i = 0; while (i < STAGES.length - 1 && s >= STAGES[i + 1].s0) i++; return i; };
export const stageAt = (s) => STAGES[stageIndexAt(clamp(s, 0, LEN))];

// height profile: eased grade + step-up ramps (hidden under each step's slab)
{
  const N = pts.length;
  const raw = new Float32Array(N), widthRaw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const st = STAGES[stageIndexAt(pts[i].s)], u = pts[i].s - st.s0;
    let g = st.grade ?? 0;
    if (st.grades) for (const [u0, gg] of st.grades) if (u >= u0) g = gg;
    raw[i] = g; widthRaw[i] = st.bog && u > st.bog.from - 3 && u < st.bog.to + 3 ? st.bog.width : st.width;
  }
  const W = 4; // ±2 m moving average: grade changes become ~4 m vertical curves
  let h = H0;
  for (let i = 0; i < N; i++) {
    let a = 0, n = 0, wa = 0;
    for (let k = -W; k <= W; k++) { const j = clamp(i + k, 0, N - 1); a += raw[j]; n++; }
    for (let k = -6; k <= 6; k++) wa += widthRaw[clamp(i + k, 0, N - 1)];
    pts[i].g = a / n; // tread grade, without the step-ups
    if (i) {
      h += (a / n) * DS;
      const st = STAGES[stageIndexAt(pts[i].s)], u = pts[i].s - st.s0;
      if (st.steps) st.steps.at.forEach((at, k) => { if (u > at && u <= at + st.steps.depth + 1e-6) h += (st.steps.rise[k] * DS) / st.steps.depth; });
    }
    pts[i].h = h; pts[i].w = wa / 13;
  }
}

export const TRAILS = [{
  name: 'The Gauntlet', diff: 'dblack', kind: 'trail', pts, length: LEN, width: 5.6, shoulder: 3.5,
  stages: STAGES, oneWay: true,
}];
const TRAIL = TRAILS[0];
const SUMMIT_PT = pathPoint(TRAIL, LEN - 13);
export const SUMMIT = { x: SUMMIT_PT.x, z: SUMMIT_PT.z, r: 14, h: pts.at(-1).h };
STAGES.forEach((st) => { const p = pathPoint(TRAIL, st.gateS); st.gate = { x: p.x, z: p.z, h: p.h, tx: p.tx, tz: p.tz }; });

// ---------------------------------------------------------------- bypass track + spurs
// The track runs ROAD_OFFSET m to the right of the trail (the outside of the first hairpin,
// the inside of the second), from the spawn pad to the summit pad; a short spur leaves it for
// every stage gate from 2 to 11 and joins the trail just before the gate.
const right = (p) => ({ x: -p.tz, z: p.tx }); // right-hand normal of the trail tangent
function makeRoad(name, ctrl, hs, width) {
  const P = catmull(ctrl.map((c) => [c.x, c.z]), 2);
  arcLength(P);
  // heights: interpolate the control heights along the curve, then limit the grade
  const cs = [0]; for (let i = 1; i < ctrl.length; i++) cs.push(cs[i - 1] + Math.hypot(ctrl[i].x - ctrl[i - 1].x, ctrl[i].z - ctrl[i - 1].z));
  const k = P.at(-1).s / cs.at(-1);
  let j = 0;
  for (const p of P) { const c = p.s / k; while (j < cs.length - 2 && cs[j + 1] < c) j++; p.h = lerp(hs[j], hs[j + 1], clamp((c - cs[j]) / (cs[j + 1] - cs[j]), 0, 1)); }
  return { name, kind: 'road', pts: P, length: P.at(-1).s, width, shoulder: 5 };
}
export const ROADS = [];
{
  const ctrl = [{ x: TRAILHEAD.x, z: TRAILHEAD.z }], hs = [H0], ss = [-16];
  for (let s = 14; s < LEN - 24; s += 8) { const p = pathPoint(TRAIL, s), n = right(p); ctrl.push({ x: p.x + n.x * ROAD_OFFSET, z: p.z + n.z * ROAD_OFFSET }); hs.push(p.h); ss.push(s); }
  ctrl.push({ x: SUMMIT.x + right(SUMMIT_PT).x * 4, z: SUMMIT.z + right(SUMMIT_PT).z * 4 }); hs.push(SUMMIT.h); ss.push(LEN - 13);
  // smooth, then grade-limit the control heights (8 m apart)
  let sm = hs.map((_, i) => { let a = 0, n = 0; for (let q = -2; q <= 2; q++) { const v = hs[clamp(i + q, 0, hs.length - 1)]; a += v; n++; } return a / n; });
  sm[0] = H0; sm[sm.length - 1] = SUMMIT.h;
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < sm.length; i++) { const d = Math.hypot(ctrl[i].x - ctrl[i - 1].x, ctrl[i].z - ctrl[i - 1].z); sm[i] = clamp(sm[i], sm[i - 1] - ROAD_MAX_GRADE * d, sm[i - 1] + ROAD_MAX_GRADE * d); }
    for (let i = sm.length - 2; i >= 0; i--) { const d = Math.hypot(ctrl[i + 1].x - ctrl[i].x, ctrl[i + 1].z - ctrl[i].z); sm[i] = clamp(sm[i], sm[i + 1] - ROAD_MAX_GRADE * d, sm[i + 1] + ROAD_MAX_GRADE * d); }
  }
  const road = makeRoad('Bypass Track', ctrl, sm, 6.5);
  road.trailS = ss; road.ctrlH = sm;
  ROADS.push(road);
  // spurs: road at (gate - 19) -> half way -> trail at (gate - 3)
  const roadHAt = (s) => { let i = 1; while (i < ss.length - 1 && ss[i] < s) i++; return lerp(sm[i - 1], sm[i], clamp((s - ss[i - 1]) / (ss[i] - ss[i - 1]), 0, 1)); };
  for (const st of STAGES.slice(1, -1)) {
    const a = pathPoint(TRAIL, st.s0 - 19), b = pathPoint(TRAIL, st.s0 - 10), c = pathPoint(TRAIL, st.s0 - 2);
    const na = right(a), nb = right(b);
    const ctl = [{ x: a.x + na.x * ROAD_OFFSET, z: a.z + na.z * ROAD_OFFSET }, { x: b.x + nb.x * ROAD_OFFSET * 0.55, z: b.z + nb.z * ROAD_OFFSET * 0.55 }, { x: c.x, z: c.z }];
    const h0 = roadHAt(st.s0 - 19), h2 = c.h;
    ROADS.push(makeRoad(`Spur ${st.n}`, ctl, [h0, lerp(h0, h2, 0.5), h2], 5));
    st.spur = ROADS.length - 1;
  }
}
const PATHS = [...ROADS, ...TRAILS];

// ---------------------------------------------------------------- base landscape
// A coarse grid (8 m) interpolates the course heights by inverse distance, so the mountainside
// carries the switchbacks; hills and ridges grow away from the paths.
const CG = 8, CN = SIZE / CG + 1;
const coarseH = new Float32Array(CN * CN), coarseD = new Float32Array(CN * CN);
{
  const samples = [];
  for (let s = 0; s <= LEN; s += 3) { const p = pathPoint(TRAIL, s); samples.push([p.x, p.z, p.h]); }
  for (const p of ROADS[0].pts.filter((_, i) => i % 2 === 0)) samples.push([p.x, p.z, p.h]);
  samples.push([TRAILHEAD.x, TRAILHEAD.z, H0], [SUMMIT.x, SUMMIT.z, SUMMIT.h]);
  for (let i = 0; i < CN; i++) for (let j = 0; j < CN; j++) {
    const x = -SIZE / 2 + i * CG, z = -SIZE / 2 + j * CG;
    let num = 0, den = 0, dmin = Infinity;
    for (const [sx, sz, sh] of samples) { const d2 = (sx - x) ** 2 + (sz - z) ** 2, w = 1 / (d2 + 36) ** 1.5; num += sh * w; den += w; if (d2 < dmin) dmin = d2; }
    coarseH[i * CN + j] = num / den; coarseD[i * CN + j] = Math.sqrt(dmin);
  }
}
const coarse = (arr, x, z) => {
  const fx = clamp((x + SIZE / 2) / CG, 0, CN - 1 - 1e-6), fz = clamp((z + SIZE / 2) / CG, 0, CN - 1 - 1e-6);
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  return lerp(lerp(arr[i * CN + j], arr[(i + 1) * CN + j], tx), lerp(arr[i * CN + j + 1], arr[(i + 1) * CN + j + 1], tx), tz);
};
function baseHeight(x, z) {
  const d = coarse(coarseD, x, z);
  let h = coarse(coarseH, x, z);
  h += smooth(25, 95, d) * (ridged(x * 0.009 + 3, z * 0.009 - 5, 4) * 30 - 7);
  h += fbm(x * 0.03, z * 0.03, 3) * 3.2 * smooth(6, 30, d) + fbm(x * 0.12, z * 0.12, 2) * 0.6;
  h += smooth(150, 198, Math.max(Math.abs(x), Math.abs(z))) * 30;
  return h;
}

// ---------------------------------------------------------------- tread shaping per stage
const bump = (d, r) => (d >= r ? 0 : (1 - (d / r) ** 2) ** 2);
// 0 where relief must not change a designed step: from 1.6 m in front of a step face over its
// slab, and round the gatekeeper ledges; 1 elsewhere
function reliefFade(st, u) {
  let f = 1;
  if (st.steps) for (const at of st.steps.at) f = Math.min(f, 1 - smooth(at - 2.6, at - 1.6, u) * smooth(at + st.steps.depth + 1.2, at + st.steps.depth + 0.4, u));
  if (st.gatekeepers) for (const at of st.gatekeepers.at) { const h = st.gatekeepers.depth / 2; f = Math.min(f, 1 - smooth(at - h - 2.6, at - h - 1.6, u) * smooth(at + h + 2.6, at + h + 1.6, u)); }
  return f;
}
// the stage's micro-relief at stage-local u / lateral lat (see RELIEF)
function relief(st, u, lat, hw, x, z) {
  const r = st.relief, f = reliefFade(st, u);
  if (!r || f <= 0) return 0;
  let dh = lumps(x, z, r.lumps || 0);
  const inBog = st.bog && u > st.bog.from - 2 && u < st.bog.to + 2;
  if (r.ruts && !inBog) { // two wheel-track ruts, deeper in places
    const k = 0.65 + 0.7 * fbm(x * 0.11 - 4, z * 0.11 + 8, 2);
    dh -= r.ruts * k * (bump(Math.abs(lat - 0.82), 0.62) + bump(Math.abs(lat + 0.82), 0.62)) * (1 - smooth(hw - 0.6, hw + 0.4, Math.abs(lat)));
  }
  if (r.holes) dh += potholes(x, z, r.holes[0], r.holes[1], r.holes[2], r.holes[3], st.n * 31);
  return dh * f;
}
// height offset of the trail surface at stage-local u and lateral lat (m, + = right of travel)
function tread(st, u, lat, hw, x, z) {
  let dh = 0;
  const ends = smooth(0, 6, u) * smooth(0, 4, st.len - u);
  dh += fbm(x * 0.45, z * 0.45, 2) * st.rough * ends;
  if (st.dips) { const k = Math.round(u / st.dips.every); const c = k * st.dips.every; if (k > 0 && c < st.len - 6) dh -= st.dips.depth * bump(Math.abs(u - c), st.dips.len / 2); }
  if (st.moguls) {
    const m = st.moguls;
    for (let k = 0, c = m.from; c <= m.to; k++, c += m.every) {
      const hh = lerp(m.h[0], m.h[1], (c - m.from) / (m.to - m.from)), side = k % 2 ? 1 : -1;
      dh += hh * bump(Math.hypot(u - c, lat - side * m.lat), m.r);
    }
  }
  if (st.twisters && Math.abs(lat) < hw + 0.6) {
    const t = st.twisters, a = (t.angle * Math.PI) / 180;
    for (let k = 0, c = t.from; c <= t.to; k++, c += t.every) {
      const dep = lerp(t.depth[0], t.depth[1], (c - t.from) / Math.max(1, t.to - t.from)), dir = k % 2 ? 1 : -1;
      const dist = Math.abs((u - c) * Math.cos(a) - dir * lat * Math.sin(a));
      dh -= dep * bump(dist, t.w) * (1 - smooth(hw - 0.4, hw + 0.6, Math.abs(lat)));
    }
  }
  if (st.camber) {
    const c = st.camber, f = smooth(c.from, c.from + 6, u) * smooth(c.to, c.to - 6, u);
    const deg = lerp(c.deg[0], c.deg[1], smooth(c.from, c.full, u));
    dh -= clamp(lat, -hw - 0.5, hw + 0.5) * Math.tan((deg * Math.PI) / 180) * f; // left (uphill) side up
    // kicker bumps under the uphill wheels
    if (c.bumps) for (let q = c.from + 9; q < c.to - 6; q += 7) dh += c.bumps * f * bump(Math.hypot(u - q, lat + 0.8), 1.1);
  }
  dh += relief(st, u, lat, hw, x, z) * ends;
  if (st.ford) {
    const f = st.ford, mid = (f.from + f.to) / 2, half = (f.to - f.from) / 2;
    const along = Math.abs(u - mid) < half ? 0.5 + 0.5 * Math.cos((Math.PI * (u - mid)) / half) : 0;
    dh -= f.depth * along * (1 - smooth(hw - 0.6, hw + 1.6, Math.abs(lat)));
  }
  return dh;
}

// ---------------------------------------------------------------- baked grid
const grid = makeGrid(SIZE, RES);
const { N1, CELL } = grid;
export const { GRID, heightAt, visualHeightAt, materialAt } = grid;
export const WATER = { y: 0, stage: 8 }; // ford surface height, set in bake()

function bake() {
  const B = 16, nb = Math.ceil(SIZE / B);
  const bins = Array.from({ length: nb * nb }, () => []);
  PATHS.forEach((p, pi) => {
    for (let i = 1; i < p.pts.length; i++) {
      const a = p.pts[i - 1], b = p.pts[i];
      const reach = Math.max(a.w ?? p.width, p.width) / 2 + p.shoulder + 1;
      const x0 = Math.floor((Math.min(a.x, b.x) - reach + SIZE / 2) / B), x1 = Math.floor((Math.max(a.x, b.x) + reach + SIZE / 2) / B);
      const z0 = Math.floor((Math.min(a.z, b.z) - reach + SIZE / 2) / B), z1 = Math.floor((Math.max(a.z, b.z) + reach + SIZE / 2) / B);
      for (let bx = Math.max(0, x0); bx <= Math.min(nb - 1, x1); bx++) for (let bz = Math.max(0, z0); bz <= Math.min(nb - 1, z1); bz++) bins[bx * nb + bz].push([pi, i]);
    }
  });
  const ford = STAGES.find((s) => s.ford);
  WATER.y = pathPoint(TRAIL, ford.s0 + (ford.ford.from + ford.ford.to) / 2).h - ford.ford.depth + ford.ford.water;
  const isPad = new Uint8Array(N1 * N1);
  for (let ix = 0; ix <= RES; ix++) {
    const x = -SIZE / 2 + ix * CELL;
    for (let iz = 0; iz <= RES; iz++) {
      const z = -SIZE / 2 + iz * CELL;
      const idx = ix * N1 + iz;
      let h = baseHeight(x, z) + lumps(x, z, 0.14); // rolling bumps all over the open ground
      const n = fbm(x * 0.08 + 9, z * 0.08 - 4, 3);
      // spawn pad and summit pad: flat, graded gravel
      const wTH = 1 - smooth(TRAILHEAD.r, TRAILHEAD.r + 10, Math.hypot(x - TRAILHEAD.x, z - TRAILHEAD.z));
      h = lerp(h, H0 + fbm(x * 0.2, z * 0.2, 2) * 0.06, wTH);
      const wSU = 1 - smooth(SUMMIT.r, SUMMIT.r + 9, Math.hypot(x - SUMMIT.x, z - SUMMIT.z));
      h = lerp(h, SUMMIT.h + fbm(x * 0.2, z * 0.2, 2) * 0.05, wSU);
      const bin = bins[Math.floor((x + SIZE / 2) / B) * nb + Math.floor((z + SIZE / 2) / B)] || [];
      const perPath = new Map();
      for (const [pi, i] of bin) {
        const p = PATHS[pi], a = p.pts[i - 1], b = p.pts[i];
        const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
        const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / L2, 0, 1);
        const d = Math.hypot(x - (a.x + ex * t), z - (a.z + ez * t));
        const hw = (a.w !== undefined ? lerp(a.w, b.w, t) : p.width) / 2;
        if (d > hw + p.shoulder) continue;
        const prev = perPath.get(pi);
        if (!prev || d < prev.d) {
          const lat = ((x - a.x) * -ez + (z - a.z) * ex) / Math.sqrt(L2);
          perPath.set(pi, { d, pi, hw, lat, s: lerp(a.s, b.s, t), ph: lerp(a.h, b.h, t), score: d - (p.kind === 'road' ? 1.5 : 0) });
        }
      }
      let best = null;
      for (const c of perPath.values()) if (!best || c.score < best.score) best = c;
      let mat = n > 0.1 ? MAT.DIRT : MAT.GRASS, pathId = -1, sink = 0, water = false, vRut = 0;
      if (best) {
        let num = 0, den = 0, W = 0;
        for (const c of perPath.values()) {
          const q = PATHS[c.pi];
          const w = 1 - smooth(c.hw, c.hw + q.shoulder, c.d);
          if (w <= 0) continue;
          let surf = c.ph;
          // crown; graded, but not billiard-flat: gentle lumps and the odd shallow pothole
          if (q.kind === 'road') surf += -(Math.min(1, c.d / c.hw) ** 2) * 0.1 + lumps(x, z, 0.04) + potholes(x, z, 9, 0.3, 0.08, 1.2, 7);
          else { const st = stageAt(c.s); surf += tread(st, c.s - st.s0, c.lat, c.hw, x, z); }
          const ww = w * w * (q.kind === 'road' ? 2 : 1);
          num += surf * ww; den += ww; W = Math.max(W, w);
        }
        if (den > 0) h = lerp(h, num / den, W);
        const p = PATHS[best.pi];
        if (best.d < best.hw + 0.5) {
          pathId = best.pi;
          if (p.kind === 'road') mat = MAT.ROAD;
          else {
            const st = stageAt(best.s), u = best.s - st.s0;
            mat = st.mat === 'rock' ? (n > 0.42 ? MAT.DIRT : MAT.ROCK) : st.mat === 'gravel' ? MAT.GRAVEL : n > 0.3 ? MAT.GRAVEL : MAT.DIRT;
            if (st.camber && u > st.len * 0.55) mat = n > 0.35 ? MAT.GRAVEL : MAT.DIRT; // grip drops off on the second half
            if (st.gravel && u > st.gravel[0] && u < st.gravel[1]) mat = MAT.GRAVEL;
            // worn wheel ruts on the dirt stages show as darker tread
            if (st.relief?.ruts) GRID.tone[idx] = Math.round(clamp((bump(Math.abs(best.lat - 0.82), 0.62) + bump(Math.abs(best.lat + 0.82), 0.62)) * 0.55, 0, 1) * 255 * reliefFade(st, u));
            if (st.bog && u > st.bog.from && u < st.bog.to) {
              // uneven bog floor: soft holes and firmer humps under a flat-looking surface
              const ease = smooth(st.bog.from, st.bog.from + 3, u) * smooth(st.bog.to, st.bog.to - 3, u);
              const depth = st.bog.sink * (1 + 0.4 * fbm(x * 0.16 + 3, z * 0.16 - 7, 2)) * ease;
              mat = MAT.MUD; sink = depth * smooth(best.hw + 0.5, best.hw - 1, best.d); h -= sink;
              // churned wheel ruts along the bog: grooves you can see (they lower the shown
              // surface too), deeper and softer in places, a firmer crown between them
              if (st.bog.ruts) {
                const k = 0.6 + 0.8 * clamp(fbm(x * 0.13 + 1, z * 0.13 + 5, 2) + 0.5, 0, 1);
                const ruts = bump(Math.abs(best.lat - 0.85), 0.7) + bump(Math.abs(best.lat + 0.85), 0.7);
                h -= st.bog.ruts * k * ease * ruts - 0.04 * ease * bump(Math.abs(best.lat), 0.6);
                vRut = st.bog.ruts * k * ease * ruts * 0.4; // (the rest of the groove is hidden, like the sink)
                GRID.tone[idx] = Math.round(clamp(ruts * k * 0.8, 0, 1) * 255);
              }
            }
            if (st.ford && u > st.ford.from - 2 && u < st.ford.to + 2) water = true;
          }
        } else if (W > 0.3 && mat === MAT.GRASS) mat = MAT.DIRT;
        if (!water && p.kind === 'trail') { const st = stageAt(best.s), u = best.s - st.s0; if (st.ford && u > st.ford.from - 2 && u < st.ford.to + 2 && best.d < best.hw + 3) water = true; }
      }
      if (wTH > 0.5 || wSU > 0.6) { mat = wSU > 0.6 ? MAT.GRAVEL : MAT.ROAD; isPad[idx] = 1; }
      if (water && h < WATER.y) mat = MAT.WATER;
      GRID.h[idx] = h; GRID.vis[idx] = h + sink + vRut; GRID.mat[idx] = mat; GRID.path[idx] = pathId;
    }
  }
  // off the paths the surface follows the slope: bare rock on cliffs, scree on steep ground
  for (let ix = 1; ix < RES; ix++) for (let iz = 1; iz < RES; iz++) {
    const idx = ix * N1 + iz;
    if (GRID.path[idx] >= 0 || isPad[idx] || GRID.mat[idx] === MAT.WATER) continue;
    const slope = Math.hypot(GRID.h[idx + N1] - GRID.h[idx - N1], GRID.h[idx + 1] - GRID.h[idx - 1]) / (2 * CELL);
    const x = -SIZE / 2 + ix * CELL, z = -SIZE / 2 + iz * CELL, n = fbm(x * 0.08 + 9, z * 0.08 - 4, 3);
    if (slope > 0.85) GRID.mat[idx] = MAT.ROCK;
    else if (slope > 0.55) GRID.mat[idx] = n > -0.1 ? MAT.ROCK : MAT.GRAVEL;
    if (Math.max(Math.abs(x), Math.abs(z)) > 172) GRID.mat[idx] = n > 0 ? MAT.ROCK : MAT.GRAVEL;
  }
}
bake();

function onAnyPath(x, z, margin) {
  for (const p of PATHS) for (let i = 0; i < p.pts.length; i += 4) {
    if (Math.hypot(p.pts[i].x - x, p.pts[i].z - z) < (p.pts[i].w ?? p.width) / 2 + margin) return true;
  }
  return Math.hypot(x - TRAILHEAD.x, z - TRAILHEAD.z) < TRAILHEAD.r + margin || Math.hypot(x - SUMMIT.x, z - SUMMIT.z) < SUMMIT.r + margin;
}

// ---------------------------------------------------------------- rocks
// Step-up slab across the trail at stage-local u: its front face stands `rise` above the
// tread, its top is flush with the ground filled in behind it. Local frame: +z along the
// trail, +x across, origin on the tread at the front edge. tilt lowers one side of the lip.
function stepSlab(st, u, rise, depth, R, tilt = 0) {
  const p = pathPoint(TRAIL, st.s0 + u);
  const tp = TRAIL.pts, s = st.s0 + u;
  let lo = 0, hi = tp.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tp[m].s < s) lo = m; else hi = m; }
  const g = tp[lo].g; // tread grade (the profile without step ramps)
  const hwS = st.width / 2 + 2.1, pts = [];
  const zf = -(rise + 0.35) * 0.62;
  for (const sx of [-1, 1]) {
    for (const zt of [0, 0.06]) pts.push(sx * hwS * (0.93 + R() * 0.07), rise + R() * 0.02 + tilt * sx * hwS + g * zt, zt + R() * 0.06);
    pts.push(sx * hwS, g * zf - 0.35, zf);
    pts.push(sx * hwS * (0.95 + R() * 0.05), rise + g * (depth + 0.2) + 0.02, depth + 0.2);
    pts.push(sx * hwS, rise + g * (depth + 0.7) - 0.45, depth + 0.7);
  }
  for (let i = 0; i < 5; i++) { const zz = 0.4 + R() * (depth - 0.4); pts.push((R() * 2 - 1) * hwS * 0.8, rise + g * zz + 0.01 + R() * 0.02, zz); }
  return { x: p.x, y: p.h, z: p.z, rotY: Math.atan2(p.tx, p.tz), pts, ledge: true, step: { stage: st.n, u, rise, grade: g, depth } };
}

export function generateRocks() {
  const R = rng(31337);
  const { rocks, shape, put, boulder, reach, ledge } = rockKit(R, heightAt);
  const at = (s, lat) => { const p = pathPoint(TRAIL, s); return { p, x: p.x - p.tz * lat, z: p.z + p.tx * lat, nx: -p.tz, nz: p.tx }; };
  // spur junctions (right side, the 20 m before each gate) stay free of edge rocks
  const nearSpur = (s, lat) => lat > 0 && STAGES.some((st) => st.spur !== undefined && s > st.s0 - 21 && s < st.s0 + 1);

  for (const st of STAGES) {
    const hw = st.width / 2;
    const u0 = APRON, u1 = st.len - 3;
    // trail-edge rocks that make the corridor read clearly, both sides
    for (let u = 6; u < st.len; u += 3.6 + R() * 2.4) { // (clear of the gate posts at u = 3)
      const sd = R() < 0.5 ? -1 : 1, s = st.s0 + u;
      if (nearSpur(s, sd) || st.summit) continue;
      if (st.bog && u > st.bog.from - 2 && u < st.bog.to + 2) continue;
      const r = shape(0.5 + R() * 0.9, 0.8), q = at(s, 0);
      const c = sd * (hw + 0.25 + reach(r, -q.nx * sd, -q.nz * sd) * (0.9 + R() * 0.3));
      put(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true);
    }
    if (st.stones) for (let u = u0; u < u1; u += st.stones.every * (0.7 + R() * 0.6)) {
      const lat = (R() * 2 - 1) * (hw - 0.4), q = at(st.s0 + u, lat);
      boulder(q.x, q.z, lerp(st.stones.size[0], st.stones.size[1], R()), 0.5, 0.45, st.stones.top);
    }
    if (st.steps) {
      const sp = st.steps;
      sp.at.forEach((u, k) => {
        rocks.push(stepSlab(st, u, sp.rise[k], sp.depth, R, sp.tilt ? (k % 2 ? 1 : -1) * sp.tilt : 0));
        // big rocks lock the slab ends so the step can't be driven around
        for (const sd of [-1, 1]) {
          const r = shape(1.1 + R() * 0.4, 0.9), q = at(st.s0 + u + sp.depth * 0.5, 0);
          const c = sd * (hw + 2.1 + reach(r, -q.nx * sd, -q.nz * sd) * 0.5);
          if (!nearSpur(st.s0 + u, sd)) put(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true);
        }
      });
    }
    if (st.gatekeepers) for (const u of st.gatekeepers.at) {
      const q = at(st.s0 + u, 0);
      ledge(q.p.x, q.p.z, Math.atan2(q.p.tx, q.p.tz), st.width + 2.4, st.gatekeepers.depth, st.gatekeepers.top);
      rocks.at(-1).gate = { stage: st.n, u, top: st.gatekeepers.top };
    }
    if (st.garden) garden(st, st.garden);
    if (st.notches) {
      for (let u = u0 + 2; u < u1 - 2; u += st.notches.every * (0.85 + R() * 0.3)) {
        if (st.squeezes && u > st.squeezes.at[0] - 4 && u < st.squeezes.at.at(-1) + 4) continue;
        const q = at(st.s0 + u, 0), sz = lerp(st.notches.size[0], st.notches.size[1], R()), top = lerp(st.notches.top[0], st.notches.top[1], R());
        for (const sd of [1, -1]) { const r = shape(sz, 0.55, 0.3, top); const c = sd * (0.5 + reach(r, -q.nx * sd, -q.nz * sd)); put(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true); }
      }
    }
    if (st.squeezes) for (const u of st.squeezes.at) {
      // a rock gate: two tall boulders, inner faces `gap` apart at their widest
      const q = at(st.s0 + u, 0);
      for (const sd of [1, -1]) { const r = shape(1.25 + R() * 0.3, 1.15, 0.25); const c = sd * (st.squeezes.gap / 2 + reach(r, -q.nx * sd, -q.nz * sd)); put(r, q.p.x + q.nx * c, q.p.z + q.nz * c); }
    }
  }

  // boulder garden (after the Trail Park's hard trails): a clear lane meanders through, boulders
  // crowd its edges, low crawl rocks sit in the wheel tracks
  function garden(st, spec) {
    const hw = st.width / 2, amp = Math.max(0, hw - spec.lane - 0.1), ph = R() * Math.PI * 2;
    const curv = (s) => { const a = pathPoint(TRAIL, s - 5), b = pathPoint(TRAIL, s + 5); const d = Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz); return Math.atan2(Math.sin(d), Math.cos(d)) / 10; };
    let side = 1;
    for (let u = APRON + 1; u < st.len - 4; u += spec.every * (0.7 + R() * 0.6)) {
      if (st.squeezes && u > st.squeezes.at[0] - 3 && u < st.squeezes.at.at(-1) + 3) continue;
      if (st.gatekeepers && st.gatekeepers.at.some((g) => Math.abs(u - g) < st.gatekeepers.depth / 2 + 1.5)) continue;
      const s = st.s0 + u, q = at(s, 0), k = curv(s), bend = Math.min(1, Math.abs(k) * 16);
      const lc = (amp * Math.sin(u * (Math.PI * 2 / 40) + ph) * (1 - bend) + clamp(-k * 18, -0.9, 0.9)) * smooth(6, 16, Math.min(u, st.len - u));
      const lh = spec.lane + 0.5 * bend;
      if (spec.notch && R() < spec.notch) {
        const sz = 1.1 + R() * 0.35;
        for (const sd of [1, -1]) { const r = shape(sz, 0.55, 0.3, spec.notchTop); const c = lc + sd * (0.5 + reach(r, -q.nx * sd, -q.nz * sd)); put(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true); }
        u += 1.5; continue;
      }
      { const r = shape(spec.size[0] + Math.pow(R(), 1.5) * (spec.size[1] - spec.size[0]), 0.85, 0.35, spec.top); const c = lc + side * (lh + reach(r, -q.nx * side, -q.nz * side)); put(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true); side = -side; }
      if (R() < spec.crawl) { const r = shape(0.35 + R() * 0.3, 0.8, 0.35, spec.crawlTop); const c = lc + (R() < 0.5 ? -1 : 1) * (0.75 + R() * 0.25); put(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true); }
    }
  }

  // scattered boulders off the paths
  for (let i = 0; i < 240; i++) {
    const x = (R() * 2 - 1) * 172, z = (R() * 2 - 1) * 172;
    if (onAnyPath(x, z, 3)) continue;
    boulder(x, z, 0.5 + Math.pow(R(), 2) * 2.4, 0.8);
  }

  // ---- ground relief: embedded rocks in the tread, on the step tops and beside the trail ----
  // (own random stream, so the obstacle layout above is unchanged by relief tuning)
  const E = rockKit(rng(4711), heightAt), R2 = rng(4712);
  for (const st of STAGES) {
    const rl = st.relief, hw = st.width / 2;
    if (!rl) continue;
    // keep step faces, slabs, gatekeepers, the bog, the ford and the squeezes as designed
    const blocked = (u) => (st.steps && st.steps.at.some((a) => u > a - 1.6 && u < a + st.steps.depth + 0.4))
      || (st.gatekeepers && st.gatekeepers.at.some((a) => Math.abs(u - a) < st.gatekeepers.depth / 2 + 1.6))
      || (st.bog && u > st.bog.from - 1 && u < st.bog.to + 1) || (st.ford && u > st.ford.from - 1 && u < st.ford.to + 1)
      || (st.squeezes && st.squeezes.at.some((a) => Math.abs(u - a) < 1.5));
    const e = rl.embed;
    if (e) {
      for (let u = APRON; u < st.len - 3; u += e.every * (0.6 + R2() * 0.8)) {
        if (blocked(u)) continue;
        // 70% in the wheel tracks (about 0.8 m either side of the centre), the rest anywhere
        const lat = R2() < 0.7 ? (R2() < 0.5 ? -1 : 1) * (0.8 + (R2() - 0.5) * 0.6) : (R2() * 2 - 1) * (hw - 0.4);
        const q = at(st.s0 + u, lat), k = R2(); // the bigger ones stand prouder
        E.embedded(q.x, q.z, lerp(e.size[0], e.size[1], k), lerp(e.proud[0], e.proud[1], 0.3 * R2() + 0.7 * k));
      }
      // uneven ledge tops: rocks sunk into each step slab, back from its lip
      if (e.tops && st.steps) st.steps.at.forEach((a, k) => {
        const p0 = pathPoint(TRAIL, st.s0 + a), g = (pathPoint(TRAIL, st.s0 + a - 1).h - pathPoint(TRAIL, st.s0 + a - 2).h);
        for (let n = 0; n < e.tops; n++) {
          const zz = 0.9 + R2() * (st.steps.depth - 1.5), lat = (R2() * 2 - 1) * (hw - 0.6), q = at(st.s0 + a + zz, lat);
          E.embedded(q.x, q.z, lerp(e.size[0], e.size[1], R2()), lerp(e.proud[0], e.proud[1], R2()) * 0.8,
            { y: p0.h + st.steps.rise[k] + g * zz, gx: g * p0.tx, gz: g * p0.tz });
        }
      });
    }
    // rock rubble on the ground either side of the tread: bumpy going for anyone leaving the line
    if (rl.rubble) for (let u = 4; u < st.len - 2; u += rl.rubble * (0.6 + R2() * 0.8)) {
      const sd = R2() < 0.5 ? -1 : 1, s = st.s0 + u;
      if (nearSpur(s, sd) || (st.bog && u > st.bog.from - 2 && u < st.bog.to + 2) || (st.ford && u > st.ford.from - 3 && u < st.ford.to + 3)) continue;
      const q = at(s, sd * (hw + 0.7 + R2() * 3.2));
      if (onRoad(q.x, q.z, 1.5)) continue;
      E.embedded(q.x, q.z, 0.4 + R2() * 0.7, 0.08 + R2() * 0.17);
    }
  }
  for (const r of E.rocks) rocks.push(r);
  return rocks;
}
// near the bypass track or a spur?
function onRoad(x, z, margin) {
  for (const p of ROADS) for (let i = 0; i < p.pts.length; i += 2) if (Math.hypot(p.pts[i].x - x, p.pts[i].z - z) < p.width / 2 + margin) return true;
  return false;
}

export function generateTrees() {
  const R = rng(5151);
  const trees = [];
  for (let i = 0; i < 5000 && trees.length < 400; i++) {
    const x = (R() * 2 - 1) * 176, z = (R() * 2 - 1) * 176;
    const m = materialAt(x, z);
    if (m !== MAT.GRASS && m !== MAT.DIRT) continue;
    if (onAnyPath(x, z, 4.5)) continue;
    trees.push({ x, z, y: heightAt(x, z), s: 0.7 + R() * 0.8 });
  }
  return trees;
}

// Small loose stones (about 0.2-0.38 m across) on the early stages; src/crawl_view.js makes them
// physical props (src/physics_props.js), so they roll and shift under the tyres. No logs on the
// course: logs only appear as fixed trail-crew edging off the tread (src/art/dressing.js).
// (s is the crawl_view scale: the procedural pebble is 0.7 m wide at s = 1, rock_small.glb gets
// s * 1.6 and is ~0.57 m wide at 1)
export const LOOSE = { stones: [], logs: [] };
{
  const R = rng(808);
  for (const [st, every] of [[STAGES[0], 5], [STAGES[1], 7], [STAGES[3], 8], [STAGES[4], 8]]) {
    for (let u = 9; u < st.len - 6; u += every * (0.7 + R() * 0.6)) {
      const lat = (R() * 2 - 1) * (st.width / 2 - 0.5), p = pathPoint(TRAIL, st.s0 + u);
      LOOSE.stones.push({ x: p.x - p.tz * lat, z: p.z + p.tx * lat, ry: R() * 6.28, s: 0.28 + R() * 0.14 });
    }
  }
}
