// The Gauntlet: a physics and driving test course. The truck spawns at the foot of ONE long
// rock-crawling trail that climbs a mountainside in three switchback legs and gets steadily
// harder, stage by stage, from a gentle two-track to the Waterfall, then tops out on a summit
// pad. A graded bypass track runs alongside with a spur into every stage gate, so a stage can
// be skipped, retried or escaped. Everything is seeded: the same course every load.
// Three separate side courses share the map (Broken Slab, Camber Ridge, Cobble Gully): they live in
// src/maps/crawl_courses.js and are added after The Gauntlet is baked, without touching it.
//
// Tuning lives in STAGE_DEFS below. Climbing limits for the 0.455-0.51 m radius crawler tyres
// (test/ledgegrade.mjs and the Trail Park notes): about 0.6 m steps on up to 25% grade, 0.45 m
// at 35%; the Rally Sedan's sills clear about 0.25 m. Steps here are step-ups (a flat-topped
// slab with the ground filled in behind it), so a staircase really climbs and no pit forms
// between two steps.
import { MAT, MUD_SINK, fbm, ridged, clamp, smooth, lerp, rng, catmull, arcLength, pathPoint, makeGrid, rockKit, lumps, potholes } from './common.js';
import { buildCourses, sculptCourses, courseRocks, nearCourses } from './crawl_courses.js'; // the side courses

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
// Wide stages (BeamNG-style crawl areas): a stage pinches to a gate-wide tread at each gate and opens
// up in between (`widths`: [[u, w], ...], eased); its lanes run side by side through the wide part,
// each a line of a clearly different difficulty: lanes [[name, lat], ...] (lat = the line's offset,
// m, + = right of travel; lanes split the stage at the midpoints between their lines). The stage's
// rating is its easiest line's; `hard` and `extreme` are optional. Lines blend back to the centre at
// the gates (laneZone [u0, u1], default [9, len - 6]); obstacle blocks give per-lane values as
// { easy, hard, extreme } where they differ by line.
export const STAGE_DEFS = [
  { name: 'Warm-up', diff: 'green', blurb: 'Rocky two-track. Any rig, 2WD is fine.',
    path: [['s', 22], ['a', -11, 50], ['a', 11, 50], ['s', 16.8]], width: 6, grade: 0, rough: 0.05, mat: 'dirt',
    dips: { every: 14, depth: 0.22, len: 7 }, stones: { every: 3.4, size: [0.2, 0.4], top: 0.1 } },
  { name: 'Articulation', diff: 'blue', blurb: 'Cross-axle humps and frame twisters: small ones on the left, big ones on the right.',
    path: [['s', 66]], widths: [[0, 7], [8, 7], [14, 16], [57, 16], [63, 7]], grade: 0.03, rough: 0.04, mat: 'dirt',
    lanes: [['easy', -5], ['hard', 0], ['extreme', 5]],
    moguls: { from: 14, to: 38, every: 3.0, r: 1.35, lat: 0.85, h: { easy: [0.16, 0.24], hard: [0.28, 0.44], extreme: [0.42, 0.54] } },
    twisters: { from: 42, to: 56, every: 6.5, w: 1.5, angle: 40, depth: { easy: [0.14, 0.2], hard: [0.3, 0.4], extreme: [0.44, 0.52] } } },
  { name: 'Ledges I', diff: 'blue', blurb: 'A staircase of ledges, flat between: low on the left, tall on the right.',
    path: [['s', 62]], widths: [[0, 7], [6, 7], [11, 15], [55, 15], [60, 7]], grade: 0.03, rough: 0.04, mat: 'rock',
    lanes: [['easy', -4.6], ['hard', 0], ['extreme', 4.6]],
    steps: { depth: 3.4, lanes: {
      easy: { at: [11, 20, 29, 38, 47], rise: [0.16, 0.18, 0.2, 0.22, 0.24] },
      hard: { at: [11, 23, 35, 47], rise: [0.22, 0.24, 0.26, 0.28] },
      extreme: { at: [14, 30, 46], rise: [0.3, 0.33, 0.37] } } } },
  { name: 'Side-slope', diff: 'blue', blurb: 'A long off-camber traverse that keeps tilting. The uphill line leans least.',
    path: [['s', 36], ['a', 90, 25]], widths: [[0, 7], [6, 7], [12, 15], [62, 15], [70, 8]], grade: 0.02, rough: 0.05, mat: 'rock',
    lanes: [['easy', -4.5], ['hard', 0], ['extreme', 4.5]], laneZone: [10, 66],
    // per lane: tilt from deg[0] to deg[1] (left side up); kickers under the uphill wheels
    camber: { from: 7, full: 50, to: 66, deg: { easy: [5, 12], hard: [8, 20], extreme: [12, 25] }, bumps: { hard: 0.12, extreme: 0.2 } } },
  { name: 'Boulder Garden I', diff: 'blue', blurb: 'Medium boulders with three lines through them; the gatekeeper ledges are lowest on the left.',
    path: [['s', 22], ['a', 90, 25], ['s', 8]], widths: [[0, 7], [6, 7], [11, 15], [62, 15], [67, 7]], grade: 0.05, rough: 0.12, mat: 'rock',
    lanes: [['easy', -4.8], ['hard', 0], ['extreme', 4.8]],
    garden: {
      easy: { every: 3.2, size: [0.5, 1.0], top: 0.55, clear: 1.7, crawl: 0.3, crawlTop: 0.24 },
      hard: { every: 3.0, size: [0.55, 1.15], top: 0.6, clear: 1.5, crawl: 0.6, crawlTop: 0.3 },
      extreme: { every: 1.8, overs: [0.42, 0.52], size: [0.9, 1.2] } },
    gatekeepers: { at: [13, 45], top: { easy: 0.3, hard: 0.45, extreme: 0.6 }, depth: 3.4 } }, // full-width rock ledges: the first test of tyre size
  { name: 'The Climb', diff: 'black', blurb: 'Slab at 20, 28 then 35 degrees, then loose gravel. Smooth slab on the left, rock ribs up the middle, ledges on the right.',
    path: [['s', 82]], widths: [[0, 7], [6, 7], [10, 14], [74, 14], [79, 7]], rough: 0.025, mat: 'rock',
    grades: [[0, 0.03], [8, Math.tan(20 / 57.2958)], [17, Math.tan(28 / 57.2958)], [26, Math.tan(35 / 57.2958)], [34, 0.3], [38, 0.2], [50, 0.04]],
    gravel: [37, 52], lanes: [['easy', -4.2], ['hard', 0], ['extreme', 4.2]],
    ribs: { lane: 'hard', from: 8, to: 38, every: 1.3, proud: 0.12 },        // rows of rock across the hard line: they hang the axles up
    ledges: { lane: 'extreme', at: [19, 28], rise: [0.38, 0.42], depth: 3.2 } },
  { name: 'Ledges II', diff: 'black', blurb: 'Tall ledges, first on the flat, then on a climb: 0.3 m on the left to 0.6 m on the right.',
    path: [['s', 70]], widths: [[0, 7], [6, 7], [11, 15], [63, 15], [68, 7]], rough: 0.04, mat: 'rock',
    grades: [[0, 0.04], [44, 0.12], [64, 0.04]], lanes: [['easy', -4.6], ['hard', 0], ['extreme', 4.6]],
    steps: { depth: 3.6, lanes: {
      easy: { at: [10, 19, 28, 37, 47, 56], rise: [0.28, 0.3, 0.32, 0.33, 0.28, 0.3] },
      hard: { at: [10, 22, 34, 50], rise: [0.45, 0.5, 0.5, 0.5] },
      extreme: { at: [13, 31, 49], rise: [0.62, 0.66, 0.67] } } } },
  { name: 'Bog & Ford', diff: 'blue', blurb: 'Soft bog, then a ford. Shallow on the left, deep on the right; keep your momentum.',
    path: [['s', 62]], widths: [[0, 7], [5, 9], [9, 17], [57, 17], [61, 8]], grade: 0, rough: 0.05, mat: 'dirt',
    lanes: [['easy', -5.5], ['hard', 0], ['extreme', 5.5]], laneZone: [8, 57],
    bog: { from: 8, to: 34, sink: 0.42, lanes: { easy: 0.5, hard: 1, extreme: 1.4 } }, ford: { from: 40, to: 57, depth: 0.72, lanes: { easy: 0.45, hard: 0.72, extreme: 0.95 }, water: 0.5 } },
  { name: 'Notches & Squeezes', diff: 'black', blurb: 'Ride the rock faces through V-notches; then pick a squeeze: wide on the left, tight on the right.',
    path: [['a', -90, 25], ['s', 25], ['a', -90, 25]], widths: [[0, 7], [6, 8], [37, 8], [42, 14], [62, 14], [67, 8], [103, 7]], grade: 0.05, rough: 0.14, mat: 'rock',
    lanes: [['easy', -4.8], ['hard', 0], ['extreme', 4.8]], laneZone: [43, 61],
    notches: { every: 6.5, top: [0.42, 0.55], size: [1.1, 1.4], lanes: ['hard', 'extreme'] }, squeezes: { at: [46, 52, 58], gap: { easy: 2.9, hard: 2.45, extreme: 2.2 } },
    garden: {
      all: { every: 3.4, size: [0.7, 1.4], top: 0.7, clear: 1.35 },
      easy: { every: 3.4, size: [0.7, 1.4], top: 0.7, clear: 1.6 }, hard: { every: 3.4, size: [0.7, 1.4], top: 0.7, clear: 1.35 }, extreme: { every: 3.0, size: [0.8, 1.5], top: 0.75, clear: 1.15 } } },
  { name: 'Boulder Garden II', diff: 'dblack', blurb: 'Big boulders, tight lines, crawl-overs in the wheel tracks. The left line is the least tight.',
    path: [['s', 57]], widths: [[0, 7], [6, 7], [11, 16], [51, 16], [55, 7]], grade: 0.06, rough: 0.2, mat: 'rock',
    lanes: [['easy', -5], ['hard', 0], ['extreme', 5]],
    garden: {
      easy: { every: 2.6, size: [0.8, 1.6], top: 0.7, clear: 1.55, crawl: 0.55, crawlTop: 0.32 },
      hard: { every: 2.5, size: [0.85, 1.9], top: 0.75, clear: 1.4, crawl: 0.7, crawlTop: 0.38, notch: 0.15, notchTop: 0.5 },
      extreme: { every: 1.6, overs: [0.52, 0.62], size: [1.0, 1.4] } } },
  { name: 'The Waterfall', diff: 'dblack', blurb: 'Stacked big ledges on a steep pitch. The hardest thing out here: eight 0.4 m steps on the left, five 0.6 m ones on the right.',
    path: [['s', 48]], widths: [[0, 7], [5, 7], [8, 14], [41, 14], [46, 7]], rough: 0.03, mat: 'rock',
    grades: [[0, 0.04], [7, 0.28], [38, 0.04]], lanes: [['easy', -4.2], ['hard', 0], ['extreme', 4.2]], laneZone: [8, 42],
    steps: { depth: 2.9, tilt: 0.035, lanes: {
      easy: { at: [9, 12.4, 15.8, 19.2, 22.6, 26, 29.4, 32.8], rise: [0.36, 0.38, 0.39, 0.39, 0.4, 0.38, 0.39, 0.37] },
      hard: { at: [9, 13.5, 18, 22.5, 27, 31.5], rise: [0.54, 0.56, 0.58, 0.58, 0.58, 0.58] },
      extreme: { at: [9, 14.6, 20.2, 25.8, 31.4], rise: [0.64, 0.66, 0.69, 0.69, 0.7] } } } },
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
// a per-lane value: a number or array is the same for every lane; { easy, hard, extreme } by lane
// (a lane without its own falls back to the next easier one); k picks from an array
export const perLane = (v, name, k) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) v = v[name] ?? (name === 'extreme' ? v.hard : undefined) ?? v.easy ?? v.hard;
  return Array.isArray(v) && k !== undefined ? v[k] : v;
};
// stage width at stage-local u (the widths table, eased between its rows); lanes as bands
const widthOf = (st, u) => {
  if (!st.widths) return st.width;
  const W = st.widths; let w = W[0][1];
  for (let k = 1; k < W.length; k++) if (u >= W[k - 1][0]) w = lerp(W[k - 1][1], W[k][1], smooth(W[k - 1][0], W[k][0], u));
  return w;
};
for (const st of STAGES) {
  if (st.widths) st.width = Math.max(...st.widths.map((q) => q[1])); // (st.width: the widest the stage gets)
  st.zone = st.laneZone ?? [9, st.len - 6];
  const L = [...(st.lanes || [])].sort((a, b) => a[1] - b[1]);
  st.bands = L.map(([name, lat], k) => ({ name, lat, lo: k ? (L[k - 1][1] + lat) / 2 : -Infinity, hi: k < L.length - 1 ? (L[k + 1][1] + lat) / 2 : Infinity }));
  st.lane = (n) => st.bands.find((b) => b.name === n) || null;
  // staircases: each lane climbs its own stairs (`steps.lanes`), all to the same height: many low
  // steps on the easy line, few tall ones on the extreme line (rises scaled to the easy line's
  // total). steps.easy drives the trail's height profile; steps.at lists every lane's steps (fades)
  if (st.steps) {
    const sp = st.steps;
    sp.byLane = sp.lanes ?? { _: { at: sp.at, rise: sp.rise } };
    const E = sp.byLane.easy ?? sp.byLane._, total = E.rise.reduce((a, b) => a + b, 0);
    for (const L of Object.values(sp.byLane)) { const t = L.rise.reduce((a, b) => a + b, 0); L.rise = L.rise.map((r) => (r * total) / t); }
    sp.easy = E;
    sp.at = [...new Set(Object.values(sp.byLane).flatMap((L) => L.at))].sort((a, b) => a - b);
  }
  // how far the lanes have opened at u (0 at the gates, 1 through the stage's lane zone)
  st.open = (u) => (st.bands.length ? smooth(st.zone[0] - 6, st.zone[0], u) * smooth(st.zone[1] + 5, st.zone[1], u) : 0);
  // a lane's line at u (falls back to the next easier lane where a stage lacks it)
  st.lineLat = (name, u) => { const b = st.lane(name) || (name === 'extreme' && st.lane('hard')) || st.lane('easy'); return b ? b.lat * st.open(u) : 0; };
}

// height profile: eased grade + step-up ramps (hidden under each step's slab). Where lanes step up by
// different heights, the ground behind rises by the easy lane's step; a taller lane's slab stands
// that much proud of the ground behind it too.
{
  const N = pts.length;
  const raw = new Float32Array(N), widthRaw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const st = STAGES[stageIndexAt(pts[i].s)], u = pts[i].s - st.s0;
    let g = st.grade ?? 0;
    if (st.grades) for (const [u0, gg] of st.grades) if (u >= u0) g = gg;
    raw[i] = g; widthRaw[i] = widthOf(st, u);
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
      if (st.steps) st.steps.easy.at.forEach((at, k) => { if (u > at && u <= at + st.steps.depth + 1e-6) h += (st.steps.easy.rise[k] * DS) / st.steps.depth; });
    }
    pts[i].h = h; pts[i].w = wa / 13;
  }
}

export const TRAILS = [{
  name: 'The Gauntlet', diff: 'dblack', kind: 'trail', pts, length: LEN, width: 5.6, shoulder: 3.5,
  stages: STAGES, oneWay: true, corridor: true,
}];
const TRAIL = TRAILS[0];
// the marked lines (easy / hard / extreme: [[s, lat], ...] every metre; the easy line is the rated
// route and the autopilot's) and lineAt(name, s)
TRAIL.lines = {};
for (const name of ['easy', 'hard', 'extreme']) {
  const out = [];
  for (let s = 0; s <= LEN + 1e-6; s += 1) { const st = stageAt(s); out.push([s, st.lineLat(name, s - st.s0)]); }
  TRAIL.lines[name] = out;
}
TRAIL.lineAt = (name, s) => { const L = TRAIL.lines[name] || TRAIL.lines.easy, f = clamp(s, 0, L.length - 1), i = Math.min(L.length - 2, Math.floor(f)); return lerp(L[i][1], L[i + 1][1], f - i); };
const SUMMIT_PT = pathPoint(TRAIL, LEN - 13);
export const SUMMIT = { x: SUMMIT_PT.x, z: SUMMIT_PT.z, r: 14, h: pts.at(-1).h };
STAGES.forEach((st) => { const p = pathPoint(TRAIL, st.gateS); st.gate = { x: p.x, z: p.z, h: p.h, tx: p.tx, tz: p.tz, w: widthOf(st, 3) }; });
// trail width at arc length s
const hwAt = (s) => { const i = clamp(Math.round(s / DS), 0, pts.length - 1); return pts[i].w / 2; };

// ---------------------------------------------------------------- bypass track + spurs
// The track runs ROAD_OFFSET m to the right of the trail (the outside of the first hairpin,
// the inside of the second), further out where a stage opens up (the corridor's half width + 9 m),
// from the spawn pad to the summit pad; a short spur leaves it for every stage gate from 2 to 11
// and joins the trail just before the gate.
const right = (p) => ({ x: -p.tz, z: p.tx }); // right-hand normal of the trail tangent
const offAt = (s) => { let m = 0; for (let q = -10; q <= 10; q += 2) m = Math.max(m, hwAt(s + q)); return Math.max(ROAD_OFFSET, m + 9.25); };
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
  for (let s = 14; s < LEN - 24; s += 8) { const p = pathPoint(TRAIL, s), n = right(p), o = offAt(s); ctrl.push({ x: p.x + n.x * o, z: p.z + n.z * o }); hs.push(p.h); ss.push(s); }
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
    const oa = offAt(st.s0 - 19), ob = Math.max(ROAD_OFFSET * 0.55, hwAt(st.s0 - 10) + 2.5);
    const ctl = [{ x: a.x + na.x * oa, z: a.z + na.z * oa }, { x: b.x + nb.x * ob, z: b.z + nb.z * ob }, { x: c.x, z: c.z }];
    const h0 = roadHAt(st.s0 - 19), h2 = c.h;
    ROADS.push(makeRoad(`Spur ${st.n}`, ctl, [h0, lerp(h0, h2, 0.5), h2], 5));
    st.spur = ROADS.length - 1;
  }
}
const G_ROADS = ROADS.slice();      // The Gauntlet's own roads (bypass + spurs), before the courses' tracks
const PATHS = [...ROADS, ...TRAILS]; // The Gauntlet's paths (rock / tree placement keys on these)

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

// ---------------------------------------------------------------- side courses (src/maps/crawl_courses.js)
// Broken Slab, Camber Ridge and Cobble Gully: separate timed courses with their access tracks.
// The Gauntlet is baked exactly as without them; then its grid is snapshotted, the tracks are
// carved and the courses sculpted, and everything within 10 m of a Gauntlet path cell is put back
// from the snapshot (eased over 4 m more). The Gauntlet's rocks and trees are generated on the
// snapshot and only filtered where the courses changed the ground, so they stay where they were.
// LOWRANGE_NO_COURSES=1 (Node) builds the map without them, for test/coursecheck.mjs's comparison.
const WITH_COURSES = !globalThis.process?.env?.LOWRANGE_NO_COURSES;
const COURSE_BUILD = WITH_COURSES ? buildCourses({ makeRoad, baseHeight, roads: ROADS, pads: { summit: SUMMIT, trailhead: { h: H0 } } }) : { courses: [], roads: [] };
export const COURSES = COURSE_BUILD.courses;
export const ACCESS = COURSE_BUILD.roads;
const BAKE_PATHS = PATHS; // The Gauntlet's own bake; the tracks join ROADS after it

// ---------------------------------------------------------------- tread shaping per stage
const bump = (d, r) => (d >= r ? 0 : (1 - (d / r) ** 2) ** 2);
// 0 where relief must not change a designed step: from 1.6 m in front of a step face over its
// slab, and round the gatekeeper ledges and the Climb's ledges; 1 elsewhere
function reliefFade(st, u) {
  let f = 1;
  if (st.steps) for (const at of st.steps.at) f = Math.min(f, 1 - smooth(at - 2.6, at - 1.6, u) * smooth(at + st.steps.depth + 1.2, at + st.steps.depth + 0.4, u));
  if (st.gatekeepers) for (const at of st.gatekeepers.at) { const h = st.gatekeepers.depth / 2; f = Math.min(f, 1 - smooth(at - h - 2.6, at - h - 1.6, u) * smooth(at + h + 2.6, at + h + 1.6, u)); }
  if (st.ledges) for (const at of st.ledges.at) f = Math.min(f, 1 - smooth(at - 2.6, at - 1.6, u) * smooth(at + st.ledges.depth + 2.6, at + st.ledges.depth + 1.6, u));
  return f;
}
// the stage's micro-relief at stage-local u / lateral lat (see RELIEF)
function relief(st, u, lat, hw, x, z) {
  const r = st.relief, f = reliefFade(st, u);
  if (!r || f <= 0) return 0;
  let dh = lumps(x, z, r.lumps || 0);
  const inBog = st.bog && u > st.bog.from - 2 && u < st.bog.to + 2;
  if (r.ruts && !inBog) { // two wheel-track ruts along the easy line, deeper in places
    const k = 0.65 + 0.7 * fbm(x * 0.11 - 4, z * 0.11 + 8, 2), o = st.lineLat('easy', u);
    dh -= r.ruts * k * (bump(Math.abs(lat - o - 0.82), 0.62) + bump(Math.abs(lat - o + 0.82), 0.62)) * (1 - smooth(hw - 0.6, hw + 0.4, Math.abs(lat)));
  }
  if (r.holes) dh += potholes(x, z, r.holes[0], r.holes[1], r.holes[2], r.holes[3], st.n * 31);
  return dh * f;
}
// a lane's band at lat, scaled to how far the lanes have opened at u; per-lane values blend across
// the band edges over `blend` m
const laneMix = (st, u, lat, val, blend = 1) => {
  const B = st.bands, k = st.open(u);
  let v = val(B[0]);
  for (let i = 1; i < B.length; i++) { const e = B[i].lo * k; v = lerp(v, val(B[i]), smooth(e - blend, e + blend, lat)); }
  return v;
};
// height offset of the trail surface at stage-local u and lateral lat (m, + = right of travel)
function tread(st, u, lat, hw, x, z) {
  let dh = 0;
  const ends = smooth(0, 6, u) * smooth(0, 4, st.len - u);
  dh += fbm(x * 0.45, z * 0.45, 2) * st.rough * ends;
  if (st.dips) { const k = Math.round(u / st.dips.every); const c = k * st.dips.every; if (k > 0 && c < st.len - 6) dh -= st.dips.depth * bump(Math.abs(u - c), st.dips.len / 2); }
  if (st.moguls) {
    // rounded humps under alternate wheel tracks of each lane's line, a wheelbase apart
    const m = st.moguls, B = st.bands.length ? st.bands : [{ name: 'hard', lat: 0 }];
    for (const b of B) {
      const H = perLane(m.h, b.name), line = st.bands.length ? st.lineLat(b.name, u) : 0;
      for (let k = 0, c = m.from; c <= m.to; k++, c += m.every) {
        const hh = lerp(H[0], H[1], (c - m.from) / (m.to - m.from)), side = k % 2 ? 1 : -1;
        dh += hh * bump(Math.hypot(u - c, lat - line - side * m.lat), m.r);
      }
    }
  }
  if (st.twisters && Math.abs(lat) < hw + 0.6) {
    // diagonal ditches across each lane, so the wheels drop one at a time
    const t = st.twisters, a = (t.angle * Math.PI) / 180, B = st.bands.length ? st.bands : [{ name: 'hard', lat: 0, lo: -Infinity, hi: Infinity }];
    for (const b of B) {
      const D = perLane(t.depth, b.name), line = st.bands.length ? st.lineLat(b.name, u) : 0, k0 = st.open(u);
      const lo = Math.max(Number.isFinite(b.lo) ? b.lo * k0 : -hw, -hw), hi = Math.min(Number.isFinite(b.hi) ? b.hi * k0 : hw, hw), half = (hi - lo) / 2, mid = (hi + lo) / 2;
      const inBand = 1 - smooth(half - 0.4, half + 0.4, Math.abs(lat - mid));
      if (inBand <= 0) continue;
      for (let k = 0, c = t.from; c <= t.to; k++, c += t.every) {
        const dep = lerp(D[0], D[1], (c - t.from) / Math.max(1, t.to - t.from)), dir = k % 2 ? 1 : -1;
        const dist = Math.abs((u - c) * Math.cos(a) - dir * (lat - line) * Math.sin(a));
        dh -= dep * bump(dist, t.w) * inBand;
      }
    }
  }
  if (st.camber) {
    // off-camber, left side up: each lane leans its own amount, the heights joined across the lanes
    const c = st.camber, f = smooth(c.from, c.from + 6, u) * smooth(c.to, c.to - 6, u), full = smooth(c.from, c.full, u);
    const slope = (l) => { const d = typeof c.deg === 'object' && !Array.isArray(c.deg) ? null : c.deg; return st.bands.length && !d ? laneMix(st, u, l, (b) => Math.tan((lerp(c.deg[b.name][0], c.deg[b.name][1], full) * Math.PI) / 180), 1.5) : Math.tan((lerp(d[0], d[1], full) * Math.PI) / 180); };
    const L = clamp(lat, -hw - 0.5, hw + 0.5), n = Math.max(1, Math.ceil(Math.abs(L) / 0.25)), step = L / n;
    let acc = 0; for (let i = 0; i < n; i++) acc += slope((i + 0.5) * step) * step;
    dh -= acc * f;
    // kicker bumps under each lane's uphill wheels
    if (c.bumps) for (const b of st.bands.length ? st.bands : [{ name: 'hard' }]) {
      const kb = typeof c.bumps === 'number' ? c.bumps : c.bumps[b.name];
      if (!kb) continue;
      const line = st.bands.length ? st.lineLat(b.name, u) : 0;
      for (let q = c.from + 9; q < c.to - 6; q += 7) dh += kb * f * bump(Math.hypot(u - q, lat - line + 0.8), 1.1);
    }
  }
  // each lane's own staircase (the boulders dividing the lanes stand over the seams)
  if (st.steps && st.bands.length) dh += laneMix(st, u, lat, (b) => stairOffset(st, b.name, u), 0.5);
  dh += relief(st, u, lat, hw, x, z) * ends;
  if (st.ford) {
    // the ford's bowl: deeper or shallower by lane
    const f = st.ford, mid = (f.from + f.to) / 2, half = (f.to - f.from) / 2;
    const along = Math.abs(u - mid) < half ? 0.5 + 0.5 * Math.cos((Math.PI * (u - mid)) / half) : 0;
    const depth = f.lanes && st.bands.length ? laneMix(st, u, lat, (b) => f.lanes[b.name] ?? f.depth, 1.5) : f.depth;
    dh -= depth * along * (1 - smooth(hw - 0.6, hw + 1.6, Math.abs(lat)));
  }
  return dh;
}
// how far a lane's own staircase stands above (or below) the easy line's at u: the fill behind each
// of its steps, ramped in under the slab (0 again once both have climbed the full height)
function stairOffset(st, name, u) {
  const sp = st.steps, L = sp?.byLane[name];
  if (!L || L === sp.easy) return 0;
  const fill = (S) => S.at.reduce((a, at, k) => a + S.rise[k] * clamp((u - at) / sp.depth, 0, 1), 0);
  return fill(L) - fill(sp.easy);
}
// the bog's depth factor by lane (1 on the middle line)
const bogFactor = (st, u, lat) => (st.bog.lanes && st.bands.length ? laneMix(st, u, lat, (b) => st.bog.lanes[b.name] ?? 1, 2) : 1);

// ---------------------------------------------------------------- baked grid
const grid = makeGrid(SIZE, RES);
const { N1, CELL } = grid;
export const { GRID, heightAt, visualHeightAt, materialAt } = grid;
export const WATER = { y: 0, stage: 8 }; // ford surface height, set in bake()

function bake() {
  const B = 16, nb = Math.ceil(SIZE / B);
  const bins = Array.from({ length: nb * nb }, () => []);
  BAKE_PATHS.forEach((p, pi) => {
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
        const p = BAKE_PATHS[pi], a = p.pts[i - 1], b = p.pts[i];
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
          const q = BAKE_PATHS[c.pi];
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
        const p = BAKE_PATHS[best.pi];
        if (best.d < best.hw + 0.5) {
          pathId = best.pi;
          if (p.kind === 'road') mat = MAT.ROAD;
          else {
            const st = stageAt(best.s), u = best.s - st.s0;
            mat = st.mat === 'rock' ? (n > 0.42 ? MAT.DIRT : MAT.ROCK) : st.mat === 'gravel' ? MAT.GRAVEL : n > 0.3 ? MAT.GRAVEL : MAT.DIRT;
            if (st.camber && u > st.len * 0.55) mat = n > 0.35 ? MAT.GRAVEL : MAT.DIRT; // grip drops off on the second half
            if (st.gravel && u > st.gravel[0] && u < st.gravel[1]) mat = MAT.GRAVEL;
            // worn wheel ruts on the dirt stages show as darker tread
            // (and through a wide stage the easy line is the worn one)
            { const o = st.lineLat('easy', u), tr = bump(Math.abs(best.lat - o - 0.82), 0.62) + bump(Math.abs(best.lat - o + 0.82), 0.62);
              if (st.relief?.ruts) GRID.tone[idx] = Math.round(clamp(tr * 0.55, 0, 1) * 255 * reliefFade(st, u));
              else if (st.bands.length) GRID.tone[idx] = Math.round(clamp(tr * 0.4 * st.open(u), 0, 1) * 255 * reliefFade(st, u)); }
            if (st.bog && u > st.bog.from && u < st.bog.to) {
              // uneven bog floor: soft holes and firmer humps under a flat-looking surface
              const ease = smooth(st.bog.from, st.bog.from + 3, u) * smooth(st.bog.to, st.bog.to - 3, u);
              const depth = st.bog.sink * (1 + 0.4 * fbm(x * 0.16 + 3, z * 0.16 - 7, 2)) * ease * bogFactor(st, u, best.lat);
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
// The Gauntlet as baked: what its rocks and trees are placed on, and what the courses restore near it
const G0 = makeGrid(SIZE, RES);
for (const k of ['h', 'vis', 'mat', 'path', 'tone']) G0.GRID[k].set(GRID[k]);
// the side courses: tracks join the road list (the trail's path id moves up past them, as the views
// expect road ids first), then tracks, course ground, and the Gauntlet's surroundings put back
if (WITH_COURSES) {
  const oldTrail = G_ROADS.length;
  for (const r of ACCESS) ROADS.push(r);
  const trailId = ROADS.length;
  for (const P of [GRID.path, G0.GRID.path]) for (let i = 0; i < P.length; i++) if (P[i] === oldTrail) P[i] = trailId;
  sculptCourses(COURSES, ACCESS, grid, G0.GRID, (id) => id < G_ROADS.length || id === trailId, G_ROADS.length, trailId + 1);
}
// where the courses changed the ground (cells), for filtering the Gauntlet's boulders and trees
const changedNear = (x, z, r) => {
  const i0 = clamp(Math.floor((x - r + SIZE / 2) / CELL), 0, RES), i1 = clamp(Math.ceil((x + r + SIZE / 2) / CELL), 0, RES);
  const j0 = clamp(Math.floor((z - r + SIZE / 2) / CELL), 0, RES), j1 = clamp(Math.ceil((z + r + SIZE / 2) / CELL), 0, RES);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = i * N1 + j; if (GRID.h[k] !== G0.GRID.h[k] || GRID.mat[k] !== G0.GRID.mat[k]) return true; }
  return false;
};
const reachOf = (r) => { let m = 0; for (let i = 0; i < r.pts.length; i += 3) m = Math.max(m, Math.hypot(r.pts[i], r.pts[i + 2])); return m; };

function onAnyPath(x, z, margin) {
  for (const p of PATHS) for (let i = 0; i < p.pts.length; i += 4) {
    if (Math.hypot(p.pts[i].x - x, p.pts[i].z - z) < (p.pts[i].w ?? p.width) / 2 + margin) return true;
  }
  return Math.hypot(x - TRAILHEAD.x, z - TRAILHEAD.z) < TRAILHEAD.r + margin || Math.hypot(x - SUMMIT.x, z - SUMMIT.z) < SUMMIT.r + margin;
}

/// ---------------------------------------------------------------- rocks
// Step-up slab across the trail at stage-local u: its front face stands `rise` above the
// tread, its top is flush with the ground filled in behind it. Local frame: +z along the
// trail, +x across (to the left of travel), origin on the tread at the front edge. tilt lowers one
// side of the lip. band: { lo, hi } (lat, + = right) when the slab spans one lane, not the width.
function stepSlab(st, u, rise, depth, R, tilt = 0, band = null) {
  const p = pathPoint(TRAIL, st.s0 + u);
  const tp = TRAIL.pts, s = st.s0 + u;
  let lo = 0, hi = tp.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tp[m].s < s) lo = m; else hi = m; }
  const g = tp[lo].g; // tread grade (the profile without step ramps)
  const hwS = hwAt(s + depth / 2) + 2.1, b0 = band ? Math.max(band.lo, -hwS) : -hwS, b1 = band ? Math.min(band.hi, hwS) : hwS;
  const cx = -(b0 + b1) / 2, half = (b1 - b0) / 2, pts = [];
  const zf = -(rise + 0.35) * 0.62;
  for (const sx of [-1, 1]) {
    for (const zt of [0, 0.06]) { const xx = cx + sx * half * (0.93 + R() * 0.07); pts.push(xx, rise + R() * 0.02 + tilt * (xx - cx) + g * zt, zt + R() * 0.06); }
    pts.push(cx + sx * half, g * zf - 0.35, zf);
    pts.push(cx + sx * half * (0.95 + R() * 0.05), rise + g * (depth + 0.2) + 0.02, depth + 0.2);
    pts.push(cx + sx * half, rise + g * (depth + 0.7) - 0.45, depth + 0.7);
  }
  for (let i = 0; i < 5; i++) { const zz = 0.4 + R() * (depth - 0.4); pts.push(cx + (R() * 2 - 1) * half * 0.8, rise + g * zz + 0.01 + R() * 0.02, zz); }
  // (the hull's origin moved to the middle of its own lane, so its footprint is its own)
  for (let i = 0; i < pts.length; i += 3) pts[i] -= cx;
  return { x: p.x + p.tz * cx, y: p.h + (band ? stairOffset(st, band.name, u) : 0), z: p.z - p.tx * cx, rotY: Math.atan2(p.tx, p.tz), pts, ledge: true, step: { stage: st.n, u, rise, grade: g, depth, lane: band?.name ?? null, lat: -cx } };
}

export function generateRocks() {
  const R = rng(31337);
  const { rocks, shape, put, boulder, reach, ledge } = rockKit(R, G0.heightAt); // (on The Gauntlet as baked)
  const at = (s, lat) => { const p = pathPoint(TRAIL, s); return { p, x: p.x - p.tz * lat, z: p.z + p.tx * lat, nx: -p.tz, nz: p.tx }; };
  // spur junctions (right side, the 20 m before each gate) stay free of edge rocks
  const nearSpur = (s, lat) => lat > 0 && STAGES.some((st) => st.spur !== undefined && s > st.s0 - 21 && s < st.s0 + 1);
  // obstacles inside the corridor keep off the bypass spurs that cut in to each gate
  const putIn = (r, x, z, follow) => { if (onRoad(x, z, 0.6)) return false; put(r, x, z, follow); return true; };
  const tag = (o) => Object.assign(rocks[rocks.length - 1], o);
  // the stage's lanes, or one lane down the middle where it has none
  const bandsOf = (st) => (st.bands.length ? st.bands : [{ name: null, lat: 0, lo: -Infinity, hi: Infinity }]);

  for (const st of STAGES) {
    const u0 = APRON, u1 = st.len - 3;
    // trail-edge rocks that make the corridor read clearly, both sides
    for (let u = 6; u < st.len; u += 3.6 + R() * 2.4) { // (clear of the gate posts at u = 3)
      const sd = R() < 0.5 ? -1 : 1, s = st.s0 + u;
      if (nearSpur(s, sd) || st.summit) continue;
      if (st.bog && u > st.bog.from - 2 && u < st.bog.to + 2) continue;
      const r = shape(0.5 + R() * 0.9, 0.8), q = at(s, 0);
      const c = sd * (hwAt(s) + 0.25 + reach(r, -q.nx * sd, -q.nz * sd) * (0.9 + R() * 0.3));
      put(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true);
    }
    if (st.stones) for (let u = u0; u < u1; u += st.stones.every * (0.7 + R() * 0.6)) {
      const lat = (R() * 2 - 1) * (hwAt(st.s0 + u) - 0.4), q = at(st.s0 + u, lat);
      boulder(q.x, q.z, lerp(st.stones.size[0], st.stones.size[1], R()), 0.5, 0.45, st.stones.top);
    }
    if (st.steps) {
      const sp = st.steps, B = bandsOf(st);
      B.forEach((b, bi) => {
        // each lane its own staircase: slabs side by side, every lane to the same height
        const L = (b.name && sp.byLane[b.name]) || sp.easy;
        L.at.forEach((u, k) => {
          const tilt = sp.tilt && (!b.name || b.name === 'easy') ? (k % 2 ? 1 : -1) * sp.tilt : 0; // (uneven lips on the easy staircase)
          rocks.push(stepSlab(st, u, L.rise[k], sp.depth, R, tilt, b.name ? { name: b.name, lo: b.lo - 0.1, hi: b.hi + 0.1 } : null));
          // big rocks lock the outer slab ends so the step can't be driven around
          for (const sd of [-1, 1]) {
            if ((sd < 0 && bi > 0) || (sd > 0 && bi < B.length - 1)) continue;
            const r = shape(1.1 + R() * 0.4, 0.9), q = at(st.s0 + u + sp.depth * 0.5, 0);
            const c = sd * (hwAt(st.s0 + u + sp.depth * 0.5) + 2.1 + reach(r, -q.nx * sd, -q.nz * sd) * 0.5);
            if (!nearSpur(st.s0 + u, sd)) put(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true);
          }
        });
      });
      // boulders along the seams between the lanes' staircases (their ground stands at different
      // heights between steps): you pick a staircase and climb it
      if (B.length > 1) for (let i = 1; i < B.length; i++) {
        for (let u = sp.at[0] - 1.5; u < sp.at.at(-1) + sp.depth + 1.5; u += 1.9 + R() * 0.6) {
          const q = at(st.s0 + u, B[i].lo), r = shape(0.75 + R() * 0.3, 0.9, 0.35, 0.7 + R() * 0.25);
          put(r, q.x, q.z, true); tag({ seam: { stage: st.n } });
        }
      }
    }
    // up-and-down rock ledges across the width (or one lane): the gatekeepers, the Climb's ledges
    const ledgeBand = (u, depth, top, b, tagAs) => {
      const s = st.s0 + u, q = at(s, 0), hw = hwAt(s) + 1.2, lo = Math.max(b.lo, -hw), hi = Math.min(b.hi, hw), mid = (lo + hi) / 2;
      ledge(q.p.x + q.nx * mid, q.p.z + q.nz * mid, Math.atan2(q.p.tx, q.p.tz), hi - lo + 0.4, depth, top);
      tag({ gate: { stage: st.n, u, top, lane: b.name ?? null, lat: mid }, ...tagAs });
    };
    if (st.gatekeepers) for (const u of st.gatekeepers.at) for (const b of bandsOf(st)) ledgeBand(u, st.gatekeepers.depth, perLane(st.gatekeepers.top, b.name ?? 'hard'), b, {});
    if (st.ledges) { const L = st.ledges, b = st.lane(L.lane); L.at.forEach((u, k) => ledgeBand(u + L.depth / 2, L.depth, L.rise[k], b, {})); }
    if (st.garden) garden(st, st.garden);
    if (st.notches) {
      for (let u = u0 + 2; u < u1 - 2; u += st.notches.every * (0.85 + R() * 0.3)) {
        if (st.squeezes && u > st.squeezes.at[0] - 4 && u < st.squeezes.at.at(-1) + 4) continue;
        const q = at(st.s0 + u, 0), sz = lerp(st.notches.size[0], st.notches.size[1], R()), top = lerp(st.notches.top[0], st.notches.top[1], R());
        // on the single tread everyone rides them; where the lanes are open, only the listed lanes do
        const lines = st.open(u) > 0.5 && st.notches.lanes ? st.notches.lanes.map((n) => st.lineLat(n, u)) : [0];
        for (const lc of lines) for (const sd of [1, -1]) { const r = shape(sz, 0.55, 0.3, top); const c = lc + sd * (0.5 + reach(r, -q.nx * sd, -q.nz * sd)); putIn(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true); }
      }
    }
    if (st.squeezes) for (const u of st.squeezes.at) {
      // a rock gate on each lane: tall boulders, inner faces `gap` apart at their widest; between two
      // lanes one boulder, sized to leave both gaps, serves as the post of each
      const q = at(st.s0 + u, 0), B = bandsOf(st);
      const gates = B.map((b) => { const lc = b.name ? st.lineLat(b.name, u) : 0, gap = perLane(st.squeezes.gap, b.name ?? 'hard'); return { b, lo: lc - gap / 2, hi: lc + gap / 2, gap }; });
      const place = (r, c, g) => { putIn(r, q.p.x + q.nx * c, q.p.z + q.nz * c); tag({ squeeze: { stage: st.n, u, lane: g.b.name ?? null, gap: g.gap } }); };
      { const g = gates[0], r = shape(1.25 + R() * 0.3, 1.15, 0.25); place(r, g.lo - reach(r, q.nx, q.nz), g); }
      { const g = gates.at(-1), r = shape(1.25 + R() * 0.3, 1.15, 0.25); place(r, g.hi + reach(r, -q.nx, -q.nz), g); }
      for (let i = 1; i < gates.length; i++) {
        const a = gates[i - 1], c = gates[i], mid = (a.hi + c.lo) / 2, span = c.lo - a.hi, r = shape(1.25 + R() * 0.3, 1.15, 0.25);
        const k = Math.min(1, (span / 2) / Math.max(reach(r, q.nx, q.nz), reach(r, -q.nx, -q.nz)));
        for (let j = 0; j < r.pts.length; j += 3) { r.pts[j] *= k; r.pts[j + 2] *= k; }
        place(r, mid, c);
      }
    }
  }

  // boulder garden (after the Trail Park's crawl corridors): through each lane a clear line weaves,
  // boulders crowd its edges, low crawl rocks sit in the wheel tracks (or, on an `overs` lane,
  // packed rounded crawl-over boulders cover it); before the lanes open, one line down the middle
  // with the stage's `all` (else easy) layout
  function garden(st, G) {
    const curv = (s) => { const a = pathPoint(TRAIL, s - 5), b = pathPoint(TRAIL, s + 5); const d = Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz); return Math.atan2(Math.sin(d), Math.cos(d)) / 10; };
    const lanes = st.bands.length ? st.bands : [{ name: 'all', lat: 0, lo: -Infinity, hi: Infinity }];
    const ph = R() * Math.PI * 2;
    for (const b of [{ name: '_single' }, ...lanes]) {
      const single = b.name === '_single', spec = single ? (G.all ?? G.easy) : G[b.name];
      if (!spec) continue;
      let side = 1;
      for (let u = APRON + 1; u < st.len - 4; u += (spec.every ?? 3) * (0.7 + R() * 0.6)) {
        const open = st.open(u);
        if (single ? open > 0.15 : open < 0.9) continue; // (nothing where the lines are still swinging out to their lanes)
        if (st.squeezes && u > st.squeezes.at[0] - 3 && u < st.squeezes.at.at(-1) + 3) continue;
        if (st.gatekeepers && st.gatekeepers.at.some((g) => Math.abs(u - g) < st.gatekeepers.depth / 2 + 1.5)) continue;
        const s = st.s0 + u, q = at(s, 0), k = curv(s), bend = Math.min(1, Math.abs(k) * 16), hw = hwAt(s);
        const line = single ? clamp(-k * 18, -0.9, 0.9) * smooth(6, 16, Math.min(u, st.len - u)) : st.lineLat(b.name, u) + 0.8 * Math.sin(u * (Math.PI * 2 / 22) + ph) * open;
        const lo = single ? -hw : Math.max(b.lo, -hw) + 0.2, hi = single ? hw : Math.min(b.hi, hw) - 0.2;
        if (spec.overs) {
          for (let lat = lo + 0.5 + R() * 0.5; lat < hi - 0.4; lat += 1.45 + R() * 0.55) {
            const r = shape(lerp(spec.size[0], spec.size[1], R()), 0.75, 0.5, lerp(spec.overs[0], spec.overs[1], R())), p = at(s + (R() - 0.5) * 0.8, lat);
            if (putIn(r, p.x, p.z, true)) tag({ over: { stage: st.n, lane: b.name } });
          }
          continue;
        }
        if (spec.notch && R() < spec.notch) {
          const sz = 1.1 + R() * 0.35;
          for (const sd of [1, -1]) { const r = shape(sz, 0.55, 0.3, spec.notchTop); const c = line + sd * (0.5 + reach(r, -q.nx * sd, -q.nz * sd)); putIn(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true); }
          u += 1.5; continue;
        }
        {
          const r = shape(spec.size[0] + Math.pow(R(), 1.5) * (spec.size[1] - spec.size[0]), 0.85, 0.35, spec.top);
          const c = line + side * (spec.clear + 0.5 * bend + reach(r, -q.nx * side, -q.nz * side) + (single ? 0 : R() * 1.2));
          const outer = c + side * reach(r, q.nx * side, q.nz * side);
          if (side > 0 ? outer <= hi + (single ? 3 : 0) : outer >= lo - (single ? 3 : 0)) putIn(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true);
          side = -side;
        }
        if (R() < (spec.crawl ?? 0)) { const r = shape(0.35 + R() * 0.3, 0.8, 0.35, spec.crawlTop); const c = line + (R() < 0.5 ? -1 : 1) * (0.75 + R() * 0.25); if (putIn(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true)) tag({ crawl: { stage: st.n, lane: b.name } }); }
      }
    }
  }

  // scattered boulders off the paths (then dropped where the side courses and their tracks run:
  // filtered afterwards, so the random stream and every other boulder stay as they were)
  const n0 = rocks.length;
  for (let i = 0; i < 240; i++) {
    const x = (R() * 2 - 1) * 172, z = (R() * 2 - 1) * 172;
    if (onAnyPath(x, z, 3)) continue;
    boulder(x, z, 0.5 + Math.pow(R(), 2) * 2.4, 0.8);
  }
  for (let i = rocks.length - 1; i >= n0; i--) { const r = rocks[i]; if (nearCourses(COURSES, ACCESS, r.x, r.z, 4.5) || changedNear(r.x, r.z, reachOf(r) + 1)) rocks.splice(i, 1); }

  // ---- ground relief: embedded rocks in the tread, on the step tops and beside the trail ----
  // (own random stream, so the obstacle layout above is unchanged by relief tuning)
  const E = rockKit(rng(4711), G0.heightAt), R2 = rng(4712);
  for (const st of STAGES) {
    const rl = st.relief;
    if (!rl) continue;
    // keep step faces, slabs, gatekeepers, ledges, the bog, the ford and the squeezes as designed
    const blocked = (u) => (st.steps && st.steps.at.some((a) => u > a - 1.6 && u < a + st.steps.depth + 0.4))
      || (st.gatekeepers && st.gatekeepers.at.some((a) => Math.abs(u - a) < st.gatekeepers.depth / 2 + 1.6))
      || (st.ledges && st.ledges.at.some((a) => u > a - 1.6 && u < a + st.ledges.depth + 1.6))
      || (st.bog && u > st.bog.from - 1 && u < st.bog.to + 1) || (st.ford && u > st.ford.from - 1 && u < st.ford.to + 1)
      || (st.squeezes && st.squeezes.at.some((a) => Math.abs(u - a) < 1.5));
    const e = rl.embed;
    if (e) {
      // (denser where the stage is wider, not one per metre of width)
      // (the last 8 m before the next gate stay clear: the next stage's spawn point waits there)
      for (let u = APRON; u < st.len - 8; u += e.every * (0.6 + R2() * 0.8) * Math.sqrt(5.6 / Math.max(5.6, hwAt(st.s0 + u) * 2))) {
        if (blocked(u)) continue;
        // half in the easy line's wheel tracks (about 0.8 m either side of it), the rest anywhere
        const hw = hwAt(st.s0 + u), o = st.lineLat('easy', u);
        const lat = R2() < 0.5 ? o + (R2() < 0.5 ? -1 : 1) * (0.8 + (R2() - 0.5) * 0.6) : (R2() * 2 - 1) * (hw - 0.4);
        const q = at(st.s0 + u, lat), k = R2(); // the bigger ones stand prouder
        E.embedded(q.x, q.z, lerp(e.size[0], e.size[1], k), lerp(e.proud[0], e.proud[1], 0.3 * R2() + 0.7 * k));
      }
      // uneven ledge tops: rocks sunk into each step slab, back from its lip (on that lane's slab)
      if (e.tops && st.steps) for (const b of bandsOf(st)) {
        const L = (b.name && st.steps.byLane[b.name]) || st.steps.easy;
        L.at.forEach((a, k) => {
          const p0 = pathPoint(TRAIL, st.s0 + a), g = (pathPoint(TRAIL, st.s0 + a - 1).h - pathPoint(TRAIL, st.s0 + a - 2).h), hw = hwAt(st.s0 + a);
          const lo = Math.max(b.lo, -hw) + 0.7, hi = Math.min(b.hi, hw) - 0.7;
          for (let n = 0; n < e.tops; n++) {
            const zz = 0.9 + R2() * (st.steps.depth - 1.5), lat = lerp(lo, hi, R2()), q = at(st.s0 + a + zz, lat);
            E.embedded(q.x, q.z, lerp(e.size[0], e.size[1], R2()), lerp(e.proud[0], e.proud[1], R2()) * 0.8,
              { y: p0.h + (b.name ? stairOffset(st, b.name, a) : 0) + L.rise[k] + g * zz, gx: g * p0.tx, gz: g * p0.tz });
          }
        });
      }
    }
    // the Climb's rock ribs: rows of low rock across the hard line on the steep slab
    if (st.ribs) {
      const rb = st.ribs;
      for (let u = rb.from; u < rb.to; u += rb.every * (0.85 + R2() * 0.3)) {
        const o = st.lineLat(rb.lane, u);
        for (let l = -1.5; l <= 1.5; l += 0.75) { const q = at(st.s0 + u, o + l + (R2() - 0.5) * 0.3); E.embedded(q.x, q.z, 0.55 + R2() * 0.25, rb.proud * (0.8 + R2() * 0.3)); E.rocks.at(-1).rib = { stage: st.n, lane: rb.lane }; }
      }
    }
    // rock rubble on the ground either side of the tread: bumpy going for anyone leaving the line
    if (rl.rubble) for (let u = 4; u < st.len - 2; u += rl.rubble * (0.6 + R2() * 0.8)) {
      const sd = R2() < 0.5 ? -1 : 1, s = st.s0 + u;
      if (nearSpur(s, sd) || (st.bog && u > st.bog.from - 2 && u < st.bog.to + 2) || (st.ford && u > st.ford.from - 3 && u < st.ford.to + 3)) continue;
      const q = at(s, sd * (hwAt(s) + 0.7 + R2() * 3.2));
      if (onRoad(q.x, q.z, 1.5)) continue;
      E.embedded(q.x, q.z, 0.4 + R2() * 0.7, 0.08 + R2() * 0.17);
    }
  }
  for (const r of E.rocks) rocks.push(r);
  // the side courses' rocks: ledges, cobbles, kickers, ribs, banks (own random streams)
  for (const r of courseRocks(COURSES, heightAt)) rocks.push(r);
  return rocks;
}
// near the bypass track or a spur?
function onRoad(x, z, margin) {
  for (const p of G_ROADS) for (let i = 0; i < p.pts.length; i += 2) if (Math.hypot(p.pts[i].x - x, p.pts[i].z - z) < p.width / 2 + margin) return true;
  return false;
}

export function generateTrees() {
  const R = rng(5151);
  const trees = [];
  for (let i = 0; i < 5000 && trees.length < 400; i++) {
    const x = (R() * 2 - 1) * 176, z = (R() * 2 - 1) * 176;
    const m = G0.materialAt(x, z); // The Gauntlet as baked, so the random stream is as it was
    if (m !== MAT.GRASS && m !== MAT.DIRT) continue;
    if (onAnyPath(x, z, 4.5)) continue;
    trees.push({ x, z, y: G0.heightAt(x, z), s: 0.7 + R() * 0.8 });
  }
  return trees.filter((t) => !nearCourses(COURSES, ACCESS, t.x, t.z, 5) && !changedNear(t.x, t.z, 1)); // none on the side courses, their tracks or ground they reshaped
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
      const lat = (R() * 2 - 1) * (hwAt(st.s0 + u) - 0.5), p = pathPoint(TRAIL, st.s0 + u);
      LOOSE.stones.push({ x: p.x - p.tz * lat, z: p.z + p.tx * lat, ry: R() * 6.28, s: 0.28 + R() * 0.14 });
    }
  }
}
