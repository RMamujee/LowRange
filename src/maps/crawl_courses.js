// The Gauntlet's side courses: three separate, timed rock-crawling courses on the same map
// (src/maps/crawl.js), each with its own start and finish gates, numbered sections, a graded
// access track from the trailhead / summit / bypass, and its own bests per rig.
//
//   Broken Slab   (blue)    a wide, broken slab face north of the summit: pick your line, from
//                           low ledges on the left to tall ones and boulders on the right
//   Camber Ridge  (black)   an off-camber traverse south of the trailhead that leans from 6 to
//                           30 degrees, with a rock rib to straddle, cross-axle holes and kickers
//                           under the uphill wheels (tuned against test/tipangle.mjs)
//   Cobble Gully  (dblack)  a boulder-choked gully east of the summit: drop in, crawl down a
//                           cobble run and a steep chute on engine braking, cross a creek bed of
//                           packed boulders, climb out over boulder steps
//
// Everything here is applied AFTER The Gauntlet is baked and never touches it: the course ground
// is sculpted into the finished heightfield with a guard band round every Gauntlet path cell
// (sculptCourses), the access tracks are ordinary roads in the bake, and the course rocks come
// from their own random streams (courseRocks). `node test/crawlcheck.mjs` numbers stay the same.
//
// Course data (one row per section, in driving order) mirrors STAGE_DEFS: `path` turtle ops
// (['s', len] straight, ['a', deg, radius] arc, deg > 0 turns left), `grades` [[u, grade], ...]
// (eased over ~4 m), `width` or `widths` [[u, w], ...], `mat` surface. The first 6 m after each
// gate and the last 6.5 m before the next are a level, rock-free bench (gates, spawn points).
// Ground shaping (heightfield): camber { deg: [from, to], in, full, out } (right side up),
//   gully { wall } banks either side, lumps, holes [cell, chance, depth, radius], axleHoles
//   (cross-axle holes under alternate wheels), cracks (diagonal ditches across the width).
// Rocks (fixed convex hulls, src/maps/common.js rockKit): ledges (bands of slab steps, rise per
//   lateral segment), boulders (scattered, keeping the named lines clear of tall ones), cobbles
//   (packed rounded boulders you drive ON), kickers (low rocks under one wheel track), ribs (a
//   narrow rock spine along the centre to straddle), embed (low embedded rocks), walls (big
//   boulders lining the banks).
import { MAT, fbm, clamp, smooth, lerp, rng, pathPoint, rockKit, lumps, potholes } from './common.js';

const DS = 0.5;
export const BENCH_IN = 6, BENCH_OUT = 6.5;  // rock-free, level metres after / before each gate
const SKIRT = 2.5, BLEND = 14;                // sculpt: full shaping to hw + skirt, then blend out
const GUARD = [4, 10];                        // metres from any Gauntlet path cell: untouched, then eased in
export const RESTORE = { keep: 10, ease: 4 };  // ...and everything within keep m put back as baked, eased over ease m
const TRACK_GRADE = 0.17;                     // access tracks re-graded to meet The Gauntlet's ground
const TRACK_SHOULDER = 5;                     // a track blends into the ground over this many m past its edge
// Banks: after the tracks and courses are shaped, no ground near them may stand steeper than
// BANK_SLOPE above or below any track or course tread (a cut or a fill is banked out at that slope,
// as far as it takes). 0.5 is 27 degrees, under the side slope every rig tips at (38-42 degrees,
// test/tipangle.mjs), so a truck that slides off a fill can drive back or press Y, not tumble.
const BANK_SLOPE = 0.5;
const bump = (d, r) => (d >= r ? 0 : (1 - (d / r) ** 2) ** 2);
const tanD = (d) => Math.tan((d * Math.PI) / 180);

export const COURSE_DEFS = [
  {
    id: 'slab', name: 'Broken Slab', diff: 'blue', unit: 'Section',
    blurb: 'A wide, broken slab face. Pick your line: low ledges on the left, tall ones and boulders on the right.',
    start: { x: -16, z: -158, deg: 180 }, h0: 41,
    sections: [
      { name: 'The Toe', diff: 'blue', blurb: 'Swing round onto the foot of the face.',
        path: [['s', 9], ['a', 90, 9], ['s', 8]], width: 8, grades: [[0, 0], [9, -0.1], [19, 0]], rough: 0.03, mat: 'rock',
        lumps: 0.05, embed: { every: 2.2, size: [0.35, 0.8], proud: [0.06, 0.12] } },
      { name: 'The Face', diff: 'blue', blurb: 'Ledges, cracks and boulders. Easy on the left, hard on the right: pick a line and stay off the boulders.',
        path: [['s', 64]], widths: [[0, 8], [10, 22], [55, 22], [64, 9]], rough: 0.03, mat: 'rock',
        grades: [[0, 0.02], [7, 0.17], [12, 0.26], [19, 0.32], [48, 0.32], [53, 0.18], [57, 0.02]],
        lumps: 0.08,
        // ledge bands across the face: [lat0, lat1, rise] (lat + = right of travel)
        ledges: { at: [15, 21.5, 28, 34.5, 41, 47.5], segs: [
          [[-10.5, -5.2, 0.2], [-4.8, 1.2, 0.32], [1.6, 7.4, 0.42]],
          [[-10.5, -5.2, 0.22], [-4.8, 1.2, 0.38], [1.6, 7.4, 0.46]],
          [[-10.5, -5.2, 0.25], [-4.8, 1.2, 0.42], [1.6, 7.4, 0.5]],
          [[-10.5, -5.2, 0.22], [-4.8, 1.2, 0.36], [1.6, 7.4, 0.46]],
          [[-10.5, -5.2, 0.28], [-4.8, 1.2, 0.45], [1.6, 7.4, 0.52]],
          [[-10.5, -5.2, 0.25], [-4.8, 1.2, 0.4], [1.6, 7.4, 0.48]],
        ] },
        lines: [[-7.8, 'EASY'], [-1.8, 'HARD'], [4.5, 'EXTREME']],
        cracks: { at: [18.3, 37.8], angle: 28, depth: 0.22, w: 0.9 },
        // tall boulders keep off the three lines (lat, half width); low ones may sit anywhere
        boulders: { from: 9, to: 56, every: 1.7, size: [0.55, 1.5], top: [0.3, 0.85], lanes: [[-7.8, 1.5], [-1.8, 1.3], [4.5, 1.15]], low: 0.3 },
        pile: { from: 12, to: 52, lat: [7.9, 10.4], every: 2.1, size: [1.0, 1.9], top: [0.6, 1.1] },
        embed: { every: 0.9, size: [0.35, 0.9], proud: [0.07, 0.16] } },
      { name: 'Top', diff: 'green', blurb: 'The top of the slab.', finish: true,
        path: [['s', 15]], width: 9, grades: [[0, 0.02]], rough: 0.02, mat: 'gravel', lumps: 0.03 },
    ],
    // access: summit pad -> the course start; exit: the finish -> the summit pad
    roads: [
      { name: 'Slab Track', from: { pad: 'summit', x: 2, z: -50 }, ctrl: [[6, -66], [10, -92], [8, -118], [2, -142], [-6, -158]], to: 'start', width: 5 },
      // (both leave the summit by the Slab Track: the pad's edge is too steep to the east and north for its own mouth)
      { name: 'Slab Exit', from: 'finish', lead: false, ctrl: [[-29, -65.5], [-16, -67]], to: { road: 'Slab Track', near: [6, -67] }, width: 5 },
    ],
  },
  {
    id: 'camber', name: 'Camber Ridge', diff: 'black', unit: 'Section',
    blurb: 'An off-camber traverse that leans further and further. Three lines: the low one leans least. Slow, and keep the low side low.',
    start: { x: -108, z: 155, deg: 0 }, h0: 5,
    blend: 6, // (a shorter blend into the hillside than the others: the bypass runs 25 m north)
    // lanes: easy on the low (left) side, where the hill leans least, extreme high on the right with
    // the most lean and the kickers; per lane camber { deg: { lane: [from, to] } }
    sections: [
      { name: 'Lean-in', diff: 'blue', blurb: 'The hill starts to lean: 4 degrees on the low line, 22 up on the high one.',
        path: [['s', 56]], widths: [[0, 7], [6, 7], [11, 13], [47, 13], [52, 7]], grades: [[0, 0], [8, 0.03], [48, 0.0]], rough: 0.03, mat: 'rock',
        lanes: [['easy', -4.2], ['hard', 0], ['extreme', 4.2]],
        camber: { deg: { easy: [4, 10], hard: [6, 18], extreme: [10, 22] }, in: 3, full: 44, out: BENCH_OUT }, lumps: 0.05,
        kickers: { from: 13, to: 46, every: 6.5, top: [0.16, 0.22], lanes: ['hard', 'extreme'] }, embed: { every: 2.4, size: [0.35, 0.8], proud: [0.06, 0.12] } },
      { name: 'Rib Walk', diff: 'black', blurb: 'Straddle the rib on a 20 degree lean, or take the low bench at 12; holes drop one wheel at a time.',
        path: [['s', 20], ['a', -10, 80], ['s', 26]], widths: [[0, 7], [6, 7], [11, 13], [51, 13], [56, 7]], grades: [[0, 0.02], [52, 0.0]], rough: 0.03, mat: 'rock',
        lanes: [['easy', -4.2], ['hard', 0], ['extreme', 4.2]],
        camber: { deg: { easy: [11, 13], hard: [19, 21], extreme: [23, 25] }, in: 3, full: 14, out: BENCH_OUT }, lumps: 0.06,
        ribs: { from: 10, to: 50, len: 2.9, gap: 0.9, top: 0.14, w: 0.6, lane: 'hard' },
        axleHoles: { from: 11, to: 49, every: 4.6, depth: 0.3, r: 1.05, lat: 0.85, lanes: ['hard', 'extreme'] } },
      { name: 'Knife Edge', diff: 'black', blurb: 'The lean peaks near 30 degrees up high with rocks under the high side; the low line holds at 20. Creep.',
        path: [['s', 18], ['a', 18, 70], ['s', 26]], widths: [[0, 7], [6, 7], [11, 13], [57, 13], [62, 7]], grades: [[0, 0.0], [24, 0.03], [56, 0.0]], rough: 0.03, mat: 'rock',
        lanes: [['easy', -4.2], ['hard', 0], ['extreme', 4.2]],
        camber: { deg: { easy: [16, 20], hard: [23, 28], extreme: [26, 30] }, in: 3, full: 38, out: BENCH_OUT }, lumps: 0.05,
        kickers: { from: 11, to: 56, every: 5.5, top: [0.22, 0.3], lat: [0.85, -0.85], lanes: ['hard', 'extreme'] } },
      { name: 'Finish', diff: 'green', blurb: 'Level ground again.', finish: true,
        path: [['s', 16]], width: 7, grades: [[0, 0]], rough: 0.02, mat: 'gravel', lumps: 0.03 },
    ],
    roads: [
      { name: 'Camber Track', from: { pad: 'trailhead', x: -134, z: 122 }, ctrl: [[-130, 135], [-124, 147], [-116, 154.4]], to: 'start', width: 5 },
      { name: 'Camber Exit', from: 'finish', ctrl: [[104, 152]], to: { road: 0, near: [112, 124], out: 24 }, width: 5 }, // ends short of the bypass's blend: The Gauntlet's cells stay as baked
    ],
  },
  {
    id: 'gully', name: 'Cobble Gully', diff: 'dblack', unit: 'Section',
    blurb: 'Down a gully full of boulders on engine braking, across a creek bed of cobbles, and out again. Smaller cobbles on the left, the biggest on the right.',
    start: { x: 28, z: -54, deg: -22 }, h0: 54,
    // lanes: per lane cobble size and how tightly they pack (cobbles { lanes: { lane: { top, size, fill } } })
    sections: [
      { name: 'Drop-in', diff: 'black', blurb: 'Over the lip and down a 35% boulder slope. First gear low range, off the brakes.',
        path: [['s', 40]], widths: [[0, 7], [6, 7], [11, 12], [31, 12], [35, 7]], grades: [[0, 0], [8, -0.35], [27, -0.04], [29, 0]], rough: 0.04, mat: 'rock',
        gully: { wall: 1.0 }, lumps: 0.06, lanes: [['easy', -3.8], ['hard', 0], ['extreme', 3.8]],
        cobbles: { from: 11, to: 27, dx: 1.25, dz: 1.5, size: [0.65, 1.05], top: [0.24, 0.4], fill: 0.62,
          lanes: { easy: { top: [0.18, 0.28], size: [0.55, 0.85], fill: 0.45 }, extreme: { top: [0.38, 0.52], size: [0.8, 1.2], fill: 0.78 } } }, walls: { every: 3.2, size: [1.2, 2.0] } },
      { name: 'Cobble Run', diff: 'black', blurb: 'A long run of rounded boulders. Put the tyres on top of them.',
        path: [['s', 12], ['a', 60, 32]], widths: [[0, 7], [6, 7], [11, 12.5], [37, 12.5], [41, 7]], grades: [[0, 0], [7, -0.2], [35, -0.03], [37, 0]], rough: 0.04, mat: 'rock',
        gully: { wall: 1.4 }, lumps: 0.06, lanes: [['easy', -4], ['hard', 0], ['extreme', 4]],
        cobbles: { from: 11, to: 35, dx: 1.2, dz: 1.35, size: [0.7, 1.15], top: [0.3, 0.48], fill: 0.75,
          lanes: { easy: { top: [0.2, 0.32], size: [0.6, 0.9], fill: 0.5 }, extreme: { top: [0.42, 0.56], size: [0.85, 1.25], fill: 0.85 } } }, walls: { every: 3, size: [1.3, 2.2] } },
      { name: 'The Chute', diff: 'dblack', blurb: 'Steep and narrow, big boulders all the way down. Creep it.',
        path: [['s', 38]], widths: [[0, 7], [6, 7], [11, 11.5], [29, 11.5], [33, 7]], grades: [[0, 0], [8, -0.42], [27, -0.04], [29, 0]], rough: 0.04, mat: 'rock',
        gully: { wall: 2.2 }, lumps: 0.05, lanes: [['easy', -3.7], ['hard', 0], ['extreme', 3.7]],
        cobbles: { from: 11, to: 28, dx: 1.35, dz: 1.55, size: [0.9, 1.4], top: [0.38, 0.58], fill: 0.72,
          lanes: { easy: { top: [0.26, 0.38], size: [0.7, 1.0], fill: 0.55 }, extreme: { top: [0.5, 0.62], size: [1.0, 1.45], fill: 0.82 } } }, walls: { every: 2.6, size: [1.5, 2.4] } },
      { name: 'Creek Bed', diff: 'black', blurb: 'A dry creek bed packed with boulders. No dirt to drive on.',
        path: [['s', 8], ['a', 90, 26], ['s', 12]], widths: [[0, 7], [6, 7], [11, 13], [58, 13], [62, 7]], grades: [[0, 0], [7, -0.12], [56, -0.03], [58, 0]], rough: 0.04, mat: 'gravel',
        gully: { wall: 1.6 }, lumps: 0.1, holes: [3, 0.45, 0.22, 0.9], lanes: [['easy', -4.2], ['hard', 0], ['extreme', 4.2]],
        cobbles: { from: 11, to: 57, dx: 1.15, dz: 1.3, size: [0.65, 1.15], top: [0.32, 0.52], fill: 0.8,
          lanes: { easy: { top: [0.22, 0.34], size: [0.55, 0.9], fill: 0.55 }, extreme: { top: [0.45, 0.6], size: [0.85, 1.25], fill: 0.88 } } }, walls: { every: 3, size: [1.2, 2.2] } },
      { name: 'Climb-out', diff: 'black', blurb: 'Back up over boulder steps at 30%.',
        path: [['s', 10], ['a', 20, 34], ['s', 12]], widths: [[0, 7], [6, 7], [11, 12], [30, 12], [34, 7]], grades: [[0, 0], [7, 0.3], [30, 0.03], [33, 0]], rough: 0.04, mat: 'rock',
        gully: { wall: 1.0 }, lumps: 0.05, lanes: [['easy', -3.8], ['hard', 0], ['extreme', 3.8]],
        cobbles: { from: 11, to: 30, dx: 1.3, dz: 1.5, size: [0.9, 1.4], top: [0.44, 0.62], fill: 0.7,
          lanes: { easy: { top: [0.26, 0.38], size: [0.7, 1.0], fill: 0.5 }, extreme: { top: [0.52, 0.64], size: [1.0, 1.45], fill: 0.8 } } }, walls: { every: 3.4, size: [1.1, 1.8] } },
      { name: 'Finish', diff: 'green', blurb: 'Out of the gully.', finish: true,
        path: [['s', 16]], width: 7, grades: [[0, 0]], rough: 0.02, mat: 'gravel', lumps: 0.03 },
    ],
    roads: [
      { name: 'Gully Track', from: { road: 'Slab Track', near: [8, -77] }, ctrl: [[19, -66]], to: 'start', width: 5 },
      { name: 'Gully Exit', from: 'finish', ctrl: [[60, -150], [36, -150]], to: { road: 'Slab Track', near: [10, -140] }, width: 5 },
    ],
  },
];

// ---------------------------------------------------------------- geometry
// Each course becomes a path like The Gauntlet's trail: pts { x, z, s, h, g, w } every 0.5 m,
// `stages` (its sections, with s0 / s1 / len / gateS / gate) and a stageAt(s).
function buildPath(def) {
  let x = def.start.x, z = def.start.z, th = (def.start.deg * Math.PI) / 180, s = 0;
  const pts = [{ x, z, s: 0 }];
  const push = (step) => { x += Math.cos(th) * step; z -= Math.sin(th) * step; s += step; pts.push({ x, z, s }); };
  const stages = [];
  for (const sec of def.sections) {
    const s0 = s;
    for (const op of sec.path) {
      if (op[0] === 's') { const n = Math.round(op[1] / DS); for (let i = 0; i < n; i++) push(op[1] / n); }
      else {
        const a = (op[1] * Math.PI) / 180, L = Math.abs(a) * op[2], n = Math.round(L / DS), da = a / n;
        for (let i = 0; i < n; i++) { th += da / 2; push(L / n); th += da / 2; }
      }
    }
    const maxW = sec.widths ? Math.max(...sec.widths.map((q) => q[1])) : sec.width;
    const st = { ...sec, width: maxW, n: stages.length + 1, s0, s1: s, len: s - s0, gateS: s0 + 3 };
    // lanes (as on The Gauntlet's wide stages): bands split at the midpoints between the lines, open
    // between the benches, closed back to the centre line at the gates
    const L = [...(sec.lanes || [])].sort((a, b) => a[1] - b[1]);
    st.bands = L.map(([name, lat], k) => ({ name, lat, lo: k ? (L[k - 1][1] + lat) / 2 : -Infinity, hi: k < L.length - 1 ? (L[k + 1][1] + lat) / 2 : Infinity }));
    st.lane = (nm) => st.bands.find((b) => b.name === nm) || null;
    st.open = (u) => (st.bands.length ? smooth(BENCH_IN + 1, BENCH_IN + 6, u) * smooth(st.len - BENCH_OUT - 1, st.len - BENCH_OUT - 5, u) : 0);
    st.lineLat = (nm, u) => { const b = st.lane(nm) || (nm === 'extreme' && st.lane('hard')) || st.lane('easy'); return b ? b.lat * st.open(u) : 0; };
    stages.push(st);
  }
  const len = s;
  const stageIdx = (q) => { let i = 0; while (i < stages.length - 1 && q >= stages[i + 1].s0) i++; return i; };
  const stageAt = (q) => stages[stageIdx(clamp(q, 0, len))];
  // eased grade (+-2 m moving average) and width (+-3 m)
  const N = pts.length, raw = new Float32Array(N), wr = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const st = stageAt(pts[i].s), u = pts[i].s - st.s0;
    let g = 0; if (st.grades) for (const [u0, gg] of st.grades) if (u >= u0) g = gg;
    raw[i] = g;
    if (st.widths) { const W = st.widths; let w = W[0][1]; for (let k = 1; k < W.length; k++) if (u >= W[k - 1][0]) w = lerp(W[k - 1][1], W[k][1], clamp((u - W[k - 1][0]) / (W[k][0] - W[k - 1][0]), 0, 1)); wr[i] = w; }
    else wr[i] = st.width;
  }
  let h = def.h0;
  for (let i = 0; i < N; i++) {
    let a = 0, n = 0, wa = 0, wn = 0;
    for (let k = -4; k <= 4; k++) { a += raw[clamp(i + k, 0, N - 1)]; n++; }
    for (let k = -6; k <= 6; k++) { wa += wr[clamp(i + k, 0, N - 1)]; wn++; }
    pts[i].g = a / n;
    if (i) h += pts[i].g * DS;
    pts[i].h = h; pts[i].w = wa / wn;
  }
  const C = { id: def.id, name: def.name, diff: def.diff, blurb: def.blurb, unit: def.unit, kind: 'course', pts, length: len, width: Math.max(...stages.map((q) => q.width)), shoulder: SKIRT, stages, stageAt, oneWay: true, blend: def.blend };
  // marked lines where sections have lanes ([[s, lat], ...] every metre; easy = the rated route)
  if (stages.some((q) => q.bands.length)) {
    C.lines = {};
    for (const nm of ['easy', 'hard', 'extreme']) { const out = []; for (let q = 0; q <= len + 1e-6; q += 1) { const st = stageAt(q); out.push([q, st.lineLat(nm, q - st.s0)]); } C.lines[nm] = out; }
    C.lineAt = (nm, q) => { const L = C.lines[nm] || C.lines.easy, f = clamp(q, 0, L.length - 1), i = Math.min(L.length - 2, Math.floor(f)); return lerp(L[i][1], L[i + 1][1], f - i); };
  }
  stages.forEach((st) => { const p = pathPoint(C, st.gateS); st.gate = { x: p.x, z: p.z, h: p.h, tx: p.tx, tz: p.tz }; st.course = def.id; });
  return C;
}

// width of the course at arc length s
const widthAt = (C, s) => { const P = C.pts, i = clamp(Math.round(s / DS), 0, P.length - 1); return P[i].w; };

// ---------------------------------------------------------------- ground shape
// fade of the micro-relief in front of / over a ledge band, so the designed step heights hold
function ledgeFade(st, u) {
  let f = 1;
  if (st.ledges) for (const a of st.ledges.at) f = Math.min(f, 1 - smooth(a - 2.4, a - 1.4, u) * smooth(a + 3.6, a + 2.8, u));
  return f;
}
// height offset of the course ground at section-local u and lateral lat (+ = right of travel)
// relative to the centreline height; also used outside the tread (|lat| > hw) for the skirt
function shape(st, u, lat, hw, x, z) {
  let dh = 0;
  const ends = smooth(1, 6, u) * smooth(1, 6, st.len - u); // level benches at both ends
  const lf = ledgeFade(st, u) * ends;
  dh += fbm(x * 0.45, z * 0.45, 2) * (st.rough || 0) * lf;
  if (st.camber) {
    const c = st.camber, f = smooth(c.in, c.in + 6, u) * smooth(st.len - c.out, st.len - c.out - 6, u), full = smooth(c.in, c.full, u);
    const L = clamp(lat, -(hw + 7), hw + 7); // the hill plane carries on past the tread
    if (Array.isArray(c.deg)) dh += L * tanD(lerp(c.deg[0], c.deg[1], full)) * f;
    else {
      // each lane leans its own amount (right side up), the heights joined across the lanes; past the
      // outer lanes the hill carries on at their lean
      const k = st.open(u), B = st.bands, tanAt = (l) => { let v = tanD(lerp(c.deg[B[0].name][0], c.deg[B[0].name][1], full)); for (let i = 1; i < B.length; i++) { const e = B[i].lo * k; v = lerp(v, tanD(lerp(c.deg[B[i].name][0], c.deg[B[i].name][1], full)), smooth(e - 1.5, e + 1.5, l)); } return v; };
      const n = Math.max(1, Math.ceil(Math.abs(L) / 0.25)), step = L / n;
      let acc = 0; for (let i = 0; i < n; i++) acc += tanAt((i + 0.5) * step) * step;
      dh += acc * f;
    }
  }
  if (st.gully) dh += st.gully.wall * smooth(hw - 0.2, hw + 3.5, Math.abs(lat)) * (0.35 + 0.65 * ends);
  if (st.lumps) dh += lumps(x, z, st.lumps) * lf;
  if (st.holes) dh += potholes(x, z, st.holes[0], st.holes[1], st.holes[2], st.holes[3], 77) * lf;
  if (st.axleHoles && Math.abs(lat) < hw) {
    const a = st.axleHoles;
    for (const o of a.lanes ? a.lanes.map((nm) => st.lineLat(nm, u)) : [0])
      for (let k = 0, c = a.from; c <= a.to; k++, c += a.every) dh -= a.depth * bump(Math.hypot(u - c, lat - o - (k % 2 ? 1 : -1) * a.lat), a.r);
  }
  if (st.cracks && Math.abs(lat) < hw + 1) {
    const k = st.cracks, an = (k.angle * Math.PI) / 180;
    k.at.forEach((c, i) => { const d = Math.abs((u - c) * Math.cos(an) - (i % 2 ? 1 : -1) * lat * Math.sin(an)); dh -= k.depth * bump(d, k.w); });
  }
  return dh;
}
// ground height of course C at arc length s, lateral lat (world x, z for the noise)
export function courseGround(C, s, lat, x, z) {
  const st = C.stageAt(s), p = pathPoint(C, s);
  return p.h + shape(st, s - st.s0, lat, widthAt(C, s) / 2, x, z);
}

// ---------------------------------------------------------------- build
// ctx: { makeRoad, baseHeight, roads (the map's road list so far), pads: { summit, trailhead } }
export function buildCourses(ctx) {
  const courses = COURSE_DEFS.map(buildPath);
  const roads = [];
  const findRoad = (ref) => (typeof ref === 'number' ? ctx.roads[ref] : [...ctx.roads, ...roads].find((r) => r.name === ref));
  // a junction on an existing road near (x, z): its nearest point, moved `out` m off its centre
  // away from The Gauntlet's trail side (the bypass runs on the trail's right, so: to its right)
  const junction = (ref, near, out) => {
    const r = findRoad(ref);
    let bi = 0, bd = Infinity;
    r.pts.forEach((p, i) => { const d = (p.x - near[0]) ** 2 + (p.z - near[1]) ** 2; if (d < bd) { bd = d; bi = i; } });
    const p = pathPoint(r, r.pts[bi].s), sd = ref === 0 ? 1 : 0;
    return { x: p.x - p.tz * out * sd, z: p.z + p.tx * out * sd, h: p.h, join: sd ? null : { road: r, s: r.pts[bi].s } };
  };
  courses.forEach((C, ci) => {
    const def = COURSE_DEFS[ci];
    const a = C.pts[0], b = C.pts[C.pts.length - 1], ta = pathPoint(C, 0), tb = pathPoint(C, C.length);
    for (const rd of def.roads) {
      const end = (e, which) => {
        if (e === 'start') return { x: a.x, z: a.z, h: a.h, lead: { x: a.x - ta.tx * 6, z: a.z - ta.tz * 6 } };
        if (e === 'finish') return { x: b.x, z: b.z, h: b.h, lead: rd.lead === false ? null : { x: b.x + tb.tx * 6, z: b.z + tb.tz * 6 } };
        if (e.pad) return { x: e.x, z: e.z, h: ctx.pads[e.pad].h };
        if (e.road !== undefined) return junction(e.road, e.near, e.out ?? 3.5);
        throw new Error('bad road end');
      };
      const A = end(rd.from, 'from'), B = end(rd.to, 'to');
      // control points: the start, a lead-out in line with a course end (so the track meets the
      // gate straight on), the listed points, the lead-in, the end
      const pts = [[A.x, A.z]];
      if (A.lead) pts.push([A.lead.x, A.lead.z]);
      pts.push(...rd.ctrl);
      if (B.lead) pts.push([B.lead.x, B.lead.z]);
      pts.push([B.x, B.z]);
      const ctrl = pts.map(([x, z]) => ({ x, z }));
      // heights: the natural ground, smoothed, pinned at both ends (and level over a course lead),
      // then limited to ROAD_MAX grade from both ends
      const d = [0]; for (let i = 1; i < ctrl.length; i++) d.push(d[i - 1] + Math.hypot(ctrl[i].x - ctrl[i - 1].x, ctrl[i].z - ctrl[i - 1].z));
      let hs = ctrl.map((c) => ctx.baseHeight(c.x, c.z));
      hs = hs.map((_, i) => { let s = 0, n = 0; for (let q = -1; q <= 1; q++) { s += hs[clamp(i + q, 0, hs.length - 1)]; n++; } return s / n; });
      const pin = new Map([[0, A.h], [ctrl.length - 1, B.h]]);
      if (A.lead) pin.set(1, A.h);
      if (B.lead) pin.set(ctrl.length - 2, B.h);
      for (const [i, v] of pin) hs[i] = v;
      const G = 0.22;
      for (let pass = 0; pass < 6; pass++) {
        for (let i = 1; i < hs.length; i++) if (!pin.has(i)) hs[i] = clamp(hs[i], hs[i - 1] - G * (d[i] - d[i - 1]), hs[i - 1] + G * (d[i] - d[i - 1]));
        for (let i = hs.length - 2; i >= 0; i--) if (!pin.has(i)) hs[i] = clamp(hs[i], hs[i + 1] - G * (d[i + 1] - d[i]), hs[i + 1] + G * (d[i + 1] - d[i]));
      }
      const road = ctx.makeRoad(rd.name, ctrl, hs, rd.width);
      road.course = def.id; road.access = rd.to === 'start' ? 'in' : 'out';
      road.joinFrom = A.join || null; road.joinTo = B.join || null; // tees into another track there
      road.courseH = road.access === 'in' ? B.h : A.h;                // the course end's height
      roads.push(road);
    }
  });
  return { courses, roads };
}

// ---------------------------------------------------------------- sculpt
// Shape the course ground into the baked grid. g: { GRID, SIZE, RES, N1, CELL }, guarded(id): the
// path ids that belong to The Gauntlet (trail, bypass, spurs); trailId0: first path id for the
// courses (course k gets trailId0 + k; any id >= the road count reads as trail tread in the views);
// accessIds: path ids of the access tracks (kept as graded road unless inside a course tread).
export function sculptCourses(courses, roads, g, G0, guarded, accessId0, trailId0) {
  const { GRID, SIZE, RES, N1, CELL } = g;
  const accessIds = roads.map((_, k) => accessId0 + k);
  // distance (m) from the nearest Gauntlet path cell (as baked): two-pass chamfer transform
  const D = new Float32Array(N1 * N1).fill(1e9);
  for (let i = 0; i < D.length; i++) if (G0.path[i] >= 0 && guarded(G0.path[i])) D[i] = 0;
  const R2 = Math.SQRT2 * CELL;
  for (let ix = 0; ix <= RES; ix++) for (let iz = 0; iz <= RES; iz++) {
    const i = ix * N1 + iz; let v = D[i];
    if (ix) { v = Math.min(v, D[i - N1] + CELL); if (iz) v = Math.min(v, D[i - N1 - 1] + R2); if (iz < RES) v = Math.min(v, D[i - N1 + 1] + R2); }
    if (iz) v = Math.min(v, D[i - 1] + CELL);
    D[i] = v;
  }
  for (let ix = RES; ix >= 0; ix--) for (let iz = RES; iz >= 0; iz--) {
    const i = ix * N1 + iz; let v = D[i];
    if (ix < RES) { v = Math.min(v, D[i + N1] + CELL); if (iz) v = Math.min(v, D[i + N1 - 1] + R2); if (iz < RES) v = Math.min(v, D[i + N1 + 1] + R2); }
    if (iz < RES) v = Math.min(v, D[i + 1] + CELL);
    D[i] = v;
  }
  const isAccess = new Set(accessIds);
  // Where a track runs inside The Gauntlet's protected band (put back as baked below), it has to sit
  // on that ground: pin its height there to the ground as baked, keep the metres at a course end at
  // the course's height, and re-grade the rest between the pins (both ways, a few passes)
  const g0At = (x, z) => {
    const fx = clamp((x + SIZE / 2) / CELL, 0, RES - 1e-6), fz = clamp((z + SIZE / 2) / CELL, 0, RES - 1e-6), ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    return lerp(lerp(G0.h[ix * N1 + iz], G0.h[(ix + 1) * N1 + iz], tx), lerp(G0.h[ix * N1 + iz + 1], G0.h[(ix + 1) * N1 + iz + 1], tx), tz);
  };
  const dAt = (x, z) => D[clamp(Math.round((x + SIZE / 2) / CELL), 0, RES) * N1 + clamp(Math.round((z + SIZE / 2) / CELL), 0, RES)];
  for (const r of roads) {
    const P = r.pts, pin = P.map((p) => {
      if (dAt(p.x, p.z) < RESTORE.keep + 0.5) return g0At(p.x, p.z);
      if ((r.access === 'in' && p.s > r.length - 6.5) || (r.access === 'out' && p.s < 6.5)) return r.courseH; // level with the course
      // where it tees into another track: that track's height there (already re-graded: tracks go in order)
      for (const j of [r.joinFrom, r.joinTo]) if (j && Math.abs(p.s - (j === r.joinFrom ? 0 : r.length)) < 7) {
        let bq = j.road.pts[0], bd = Infinity; // (the joined track's height level with this point: it may be on a grade)
        for (const q of j.road.pts) { const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2; if (d < bd) { bd = d; bq = q; } }
        return bq.h;
      }
      return null;
    });
    if (!pin.some((v) => v !== null)) continue;
    P.forEach((p, i) => { if (pin[i] !== null) p.h = pin[i]; });
    for (let pass = 0; pass < 8; pass++) {
      for (let i = 1; i < P.length; i++) if (pin[i] === null) { const d = P[i].s - P[i - 1].s; P[i].h = clamp(P[i].h, P[i - 1].h - TRACK_GRADE * d, P[i - 1].h + TRACK_GRADE * d); }
      for (let i = P.length - 2; i >= 0; i--) if (pin[i] === null) { const d = P[i + 1].s - P[i].s; P[i].h = clamp(P[i].h, P[i + 1].h - TRACK_GRADE * d, P[i + 1].h + TRACK_GRADE * d); }
    }
  }
  // the access tracks, graded like the bake grades the bypass: crown, gentle lumps, the odd pothole,
  // blended into the ground over 5 m past the edge
  // carved: a track's tread (meets The Gauntlet's ground at the keep edge: no easing there); roadW: how
  // much a track's shoulder owns each cell (a later track or a course keeps off it)
  const carved = new Uint8Array(N1 * N1), roadW = new Float32Array(N1 * N1);
  roads.forEach((r, ri) => {
    const P = r.pts, hw = r.width / 2, reach = hw + TRACK_SHOULDER + 1;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of P) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    const ia = clamp(Math.floor((x0 - reach + SIZE / 2) / CELL), 0, RES), ib = clamp(Math.ceil((x1 + reach + SIZE / 2) / CELL), 0, RES);
    const ja = clamp(Math.floor((z0 - reach + SIZE / 2) / CELL), 0, RES), jb = clamp(Math.ceil((z1 + reach + SIZE / 2) / CELL), 0, RES);
    for (let ix = ia; ix <= ib; ix++) for (let iz = ja; iz <= jb; iz++) {
      const x = -SIZE / 2 + ix * CELL, z = -SIZE / 2 + iz * CELL, idx = ix * N1 + iz;
      let bd = Infinity, bh = 0;
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i], ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
        const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / L2, 0, 1), dd = Math.hypot(x - (a.x + ex * t), z - (a.z + ez * t));
        if (dd < bd) { bd = dd; bh = lerp(a.h, b.h, t); }
      }
      const own = 1 - smooth(hw, hw + TRACK_SHOULDER, bd);
      if (own <= 0) continue;
      // an earlier track's bank keeps what it owns (only this track's own tread overrides it)
      const prior = roadW[idx], w = bd < hw + 0.5 ? own : own * (1 - prior);
      roadW[idx] = Math.max(prior, own);
      if (w <= 0) continue;
      const surf = bh - (Math.min(1, bd / hw) ** 2) * 0.1 + lumps(x, z, 0.04) + potholes(x, z, 9, 0.3, 0.08, 1.2, 7);
      if (isAccess.has(GRID.path[idx]) && GRID.path[idx] !== accessId0 + ri) continue; // a tee never reshapes the track it joins
      GRID.h[idx] = lerp(GRID.h[idx], surf, w); GRID.vis[idx] = GRID.h[idx]; if (bd < hw + 1) carved[idx] = 1;
      if (bd < hw + 0.5) { GRID.mat[idx] = MAT.ROAD; GRID.path[idx] = accessId0 + ri; GRID.tone[idx] = 0; }
      else if (w > 0.3 && GRID.mat[idx] === MAT.GRASS) GRID.mat[idx] = MAT.DIRT;
    }
  });
  courses.forEach((C, ci) => {
    const P = C.pts, blend = C.blend ?? BLEND, reach = C.width / 2 + SKIRT + blend + 2;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of P) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    const ia = clamp(Math.floor((x0 - reach + SIZE / 2) / CELL), 1, RES - 1), ib = clamp(Math.ceil((x1 + reach + SIZE / 2) / CELL), 1, RES - 1);
    const ja = clamp(Math.floor((z0 - reach + SIZE / 2) / CELL), 1, RES - 1), jb = clamp(Math.ceil((z1 + reach + SIZE / 2) / CELL), 1, RES - 1);
    const cid = trailId0 + ci;
    // coarse index of the polyline for the nearest-point search
    const B = 8, bins = new Map(), key = (bx, bz) => bx * 4096 + bz;
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i];
      const bxa = Math.floor((Math.min(a.x, b.x) - reach) / B), bxb = Math.floor((Math.max(a.x, b.x) + reach) / B);
      const bza = Math.floor((Math.min(a.z, b.z) - reach) / B), bzb = Math.floor((Math.max(a.z, b.z) + reach) / B);
      for (let bx = bxa; bx <= bxb; bx++) for (let bz = bza; bz <= bzb; bz++) { const k = key(bx + 1000, bz + 1000); if (!bins.has(k)) bins.set(k, []); bins.get(k).push(i); }
    }
    const touched = [];
    for (let ix = ia; ix <= ib; ix++) for (let iz = ja; iz <= jb; iz++) {
      const x = -SIZE / 2 + ix * CELL, z = -SIZE / 2 + iz * CELL, idx = ix * N1 + iz;
      const list = bins.get(key(Math.floor(x / B) + 1000, Math.floor(z / B) + 1000));
      if (!list) continue;
      let bd = Infinity, bs = 0, blat = 0;
      for (const i of list) {
        const a = P[i - 1], b = P[i], ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
        const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / L2, 0, 1);
        const dd = Math.hypot(x - (a.x + ex * t), z - (a.z + ez * t));
        if (dd < bd) { bd = dd; bs = lerp(a.s, b.s, t); blat = ((x - a.x) * -ez + (z - a.z) * ex) / Math.sqrt(L2); }
      }
      // past either end of the course the ground is the access track's business
      if (bs <= 0.01 || bs >= C.length - 0.01) { if (bd > widthAt(C, bs) / 2 + 0.5) continue; }
      const hw = widthAt(C, bs) / 2, core = hw + SKIRT;
      let w = 1 - smooth(core, core + blend, bd);
      if (w <= 0) continue;
      const S = courseGround(C, bs, blat, x, z);
      w *= smooth(GUARD[0], GUARD[1], D[idx]);                         // keep clear of The Gauntlet
      if (bd >= core) w *= 1 - roadW[idx];                             // and off the tracks' own banks (the course's tread and skirt are its own)
      if (GRID.path[idx] >= 0 && isAccess.has(GRID.path[idx]) && bd > hw) continue; // keep the track graded
      if (w <= 0) continue;
      GRID.h[idx] = lerp(GRID.h[idx], S, w);
      GRID.vis[idx] = GRID.h[idx];
      GRID.tone[idx] = 0;
      const st = C.stageAt(bs), n = fbm(x * 0.08 + 9, z * 0.08 - 4, 3);
      if (bd < hw + 0.5) {
        GRID.mat[idx] = st.mat === 'gravel' ? (n > 0.35 ? MAT.ROCK : MAT.GRAVEL) : n > 0.45 ? MAT.DIRT : n > 0.3 ? MAT.GRAVEL : MAT.ROCK;
        GRID.path[idx] = cid;
      } else if (bd < core) {
        GRID.mat[idx] = n > 0.2 ? MAT.GRAVEL : MAT.ROCK;  // scree skirt
        GRID.path[idx] = cid;                              // (set dressing keeps off it)
      } else if (w > 0.15) touched.push(idx);
    }
    // the blended margin: bare rock on cliffs, scree on steep ground, as the rest of the map
    for (const idx of touched) {
      if (GRID.path[idx] >= 0 || GRID.mat[idx] === MAT.WATER) continue;
      const slope = Math.hypot(GRID.h[idx + N1] - GRID.h[idx - N1], GRID.h[idx + 1] - GRID.h[idx - 1]) / (2 * CELL);
      const ix = Math.floor(idx / N1), iz = idx % N1, n = fbm((-SIZE / 2 + ix * CELL) * 0.08 + 9, (-SIZE / 2 + iz * CELL) * 0.08 - 4, 3);
      if (slope > 0.85) GRID.mat[idx] = MAT.ROCK;
      else if (slope > 0.55) GRID.mat[idx] = n > -0.1 ? MAT.ROCK : MAT.GRAVEL;
    }
  });
  // Banks: every track and course tread cell bounds the ground round it to within BANK_SLOPE per
  // metre of its own height (lo / hi envelopes, propagated by a two-pass chamfer sweep); ground
  // within 16 m of a tread outside the envelope is cut or filled to it, and nothing there falls away from a neighbour faster than BANK_SLOPE either. Treads and The Gauntlet's protected ground stay.
  {
    const isTread = (i) => GRID.path[i] >= accessId0 && !guarded(GRID.path[i]);
    const lo = new Float32Array(N1 * N1).fill(-1e9), hi = new Float32Array(N1 * N1).fill(1e9);
    for (let i = 0; i < lo.length; i++) if (isTread(i)) { lo[i] = hi[i] = GRID.h[i]; }
    const a = BANK_SLOPE * CELL, b = BANK_SLOPE * CELL * Math.SQRT2;
    const relax = (i, j, c) => { if (lo[j] - c > lo[i]) lo[i] = lo[j] - c; if (hi[j] + c < hi[i]) hi[i] = hi[j] + c; };
    for (let ix = 0; ix <= RES; ix++) for (let iz = 0; iz <= RES; iz++) {
      const i = ix * N1 + iz;
      if (ix) { relax(i, i - N1, a); if (iz) relax(i, i - N1 - 1, b); if (iz < RES) relax(i, i - N1 + 1, b); }
      if (iz) relax(i, i - 1, a);
    }
    for (let ix = RES; ix >= 0; ix--) for (let iz = RES; iz >= 0; iz--) {
      const i = ix * N1 + iz;
      if (ix < RES) { relax(i, i + N1, a); if (iz) relax(i, i + N1 - 1, b); if (iz < RES) relax(i, i + N1 + 1, b); }
      if (iz < RES) relax(i, i + 1, a);
    }
    // (the 16 m band: distance from the nearest tread)
    const dist = new Float32Array(N1 * N1).fill(1e9);
    for (let i = 0; i < dist.length; i++) if (isTread(i)) dist[i] = 0;
    const dr = (i, j, c) => { if (dist[j] + c < dist[i]) dist[i] = dist[j] + c; };
    for (let ix = 0; ix <= RES; ix++) for (let iz = 0; iz <= RES; iz++) { const i = ix * N1 + iz; if (ix) { dr(i, i - N1, 1); if (iz) dr(i, i - N1 - 1, 1.414); if (iz < RES) dr(i, i - N1 + 1, 1.414); } if (iz) dr(i, i - 1, 1); }
    for (let ix = RES; ix >= 0; ix--) for (let iz = RES; iz >= 0; iz--) { const i = ix * N1 + iz; if (ix < RES) { dr(i, i + N1, 1); if (iz) dr(i, i + N1 - 1, 1.414); if (iz < RES) dr(i, i + N1 + 1, 1.414); } if (iz < RES) dr(i, i + 1, 1); }
    const free = (i) => dist[i] > 0 && dist[i] * CELL <= 16 && D[i] >= RESTORE.keep + RESTORE.ease;
    for (let i = 0; i < lo.length; i++) {
      if (!free(i) || (lo[i] <= GRID.h[i] && GRID.h[i] <= hi[i])) continue;
      const h = lo[i] > hi[i] ? (lo[i] + hi[i]) / 2 : clamp(GRID.h[i], lo[i], hi[i]);
      GRID.vis[i] += h - GRID.h[i]; GRID.h[i] = h;
      if (GRID.mat[i] === MAT.GRASS) GRID.mat[i] = MAT.DIRT; // a fresh bank
    }
    // no drop steeper than BANK_SLOPE between neighbours (fill only: a drop's low side is raised)
    const H = GRID.h, fill = (i, j, c) => { if (H[j] - c > H[i]) { GRID.vis[i] += H[j] - c - H[i]; H[i] = H[j] - c; if (GRID.mat[i] === MAT.GRASS) GRID.mat[i] = MAT.DIRT; } };
    for (let pass = 0; pass < 2; pass++) {
      for (let ix = 1; ix < RES; ix++) for (let iz = 1; iz < RES; iz++) { const i = ix * N1 + iz; if (!free(i)) continue; fill(i, i - N1, a); fill(i, i - N1 - 1, b); fill(i, i - N1 + 1, b); fill(i, i - 1, a); }
      for (let ix = RES - 1; ix > 0; ix--) for (let iz = RES - 1; iz > 0; iz--) { const i = ix * N1 + iz; if (!free(i)) continue; fill(i, i + N1, a); fill(i, i + N1 - 1, b); fill(i, i + N1 + 1, b); fill(i, i + 1, a); }
    }
  }
  // The Gauntlet's surroundings exactly as baked: everything within KEEP m of one of its path cells
  // comes back from the snapshot, heights eased back in over the next EASE m
  const KEEP = RESTORE.keep, EASE = RESTORE.ease;
  for (let i = 0; i < D.length; i++) {
    if (D[i] < KEEP) { GRID.h[i] = G0.h[i]; GRID.vis[i] = G0.vis[i]; GRID.mat[i] = G0.mat[i]; GRID.path[i] = G0.path[i]; GRID.tone[i] = G0.tone[i]; }
    else if (D[i] < KEEP + EASE && GRID.h[i] !== G0.h[i] && !carved[i]) {
      const k = smooth(KEEP, KEEP + EASE, D[i]);
      GRID.h[i] = lerp(G0.h[i], GRID.h[i], k); GRID.vis[i] = lerp(G0.vis[i], GRID.vis[i], k);
    }
  }
  return D;
}

// near a course (inside its tread, skirt and a margin) or one of its access tracks?
export function nearCourses(courses, roads, x, z, margin) {
  for (const C of courses) for (let i = 0; i < C.pts.length; i += 4) { const p = C.pts[i]; if (Math.hypot(p.x - x, p.z - z) < p.w / 2 + SKIRT + margin) return true; }
  for (const r of roads) for (let i = 0; i < r.pts.length; i += 2) if (Math.hypot(r.pts[i].x - x, r.pts[i].z - z) < r.width / 2 + margin) return true;
  return false;
}

// ---------------------------------------------------------------- rocks
// All fixed colliders that match what is drawn (convex hulls, src/maps/common.js). Each course has
// its own random streams. Rocks that matter to the numbers carry tags: `cstep` on ledge pieces,
// `cobble` / `kicker` / `rib` on the crawl-over rocks (test/coursecheck.mjs).
export function courseRocks(courses, heightAt) {
  const out = [];
  courses.forEach((C, ci) => {
    const R = rng(9100 + ci * 17), K = rockKit(R, heightAt), E = rockKit(rng(9200 + ci * 17), heightAt), R2 = rng(9300 + ci * 17);
    const { rocks, shape: rshape, put, reach } = K;
    const at = (s, lat) => { const p = pathPoint(C, s); return { p, x: p.x - p.tz * lat, z: p.z + p.tx * lat, nx: -p.tz, nz: p.tx }; };
    const tag = (o) => Object.assign(rocks[rocks.length - 1], o);
    for (const st of C.stages) {
      const u0 = BENCH_IN, u1 = st.len - BENCH_OUT, rocky = u1 > u0 && !st.finish;
      // corridor edge rocks (both sides), clear of the gate posts and the benches' spawn footprints
      if (!st.walls) for (let u = 5; u < st.len - 1; u += 3.4 + R() * 2.6) {
        const s = st.s0 + u, hw = widthAt(C, s) / 2, sd = R() < 0.5 ? -1 : 1;
        if (Math.abs(u - 3) < 2) continue;
        const r = rshape(0.5 + R() * 0.8, 0.8), q = at(s, 0);
        const c = sd * (hw + 0.4 + reach(r, -q.nx * sd, -q.nz * sd) * (0.9 + R() * 0.3));
        put(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true);
      }
      // gully banks lined with big boulders
      if (st.walls) for (let u = 4.5; u < st.len - 0.5; u += st.walls.every * (0.7 + R() * 0.6)) {
        const s = st.s0 + u, hw = widthAt(C, s) / 2;
        for (const sd of [-1, 1]) {
          if (R() < 0.15) continue;
          const r = rshape(lerp(st.walls.size[0], st.walls.size[1], R()), 0.85, 0.4), q = at(s, 0);
          const c = sd * (hw + 0.45 + reach(r, -q.nx * sd, -q.nz * sd) * (0.85 + R() * 0.2));
          put(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true);
        }
      }
      if (!rocky) continue;
      // slab ledge bands: per lateral segment, a step that stands `rise` proud of the slope below
      // and runs back into it as a bench (pieces of up to 3.4 m, small gaps between)
      if (st.ledges) st.ledges.at.forEach((u, k) => {
        for (const [l0, l1, rise] of st.ledges.segs[k]) {
          // irregular pieces (1.4-3.4 m), each a little skewed, so a band reads as broken rock
          const cuts = [l0];
          while (l1 - cuts.at(-1) > 3.4) cuts.push(cuts.at(-1) + 1.4 + R() * Math.min(2, l1 - cuts.at(-1) - 2.8));
          cuts.push(l1);
          for (let j = 0; j + 1 < cuts.length; j++) {
            const la = cuts[j] + 0.1 + R() * 0.12, lb = cuts[j + 1] - 0.1 - R() * 0.12, lm = (la + lb) / 2;
            const rr = rise * (0.96 + R() * 0.08);
            out.push(ledgePiece(C, st.s0 + u + (R() - 0.5) * 0.5, la, lb, rr, R, heightAt));
            out.at(-1).cstep = { course: C.id, stage: st.n, u, lat: lm, rise: rr };
          }
        }
      });
      // tall boulders off the lines, low ones anywhere; none on a ledge face
      if (st.boulders) {
        const b = st.boulders;
        for (let u = Math.max(u0, b.from); u < Math.min(u1, b.to); u += b.every * (0.6 + R() * 0.8)) {
          const s = st.s0 + u, hw = widthAt(C, s) / 2, lat = (R() * 2 - 1) * (hw - 0.8);
          const top = lerp(b.top[0], b.top[1], R() ** 1.4), size = lerp(b.size[0], b.size[1], R());
          const r = rshape(size, 0.85, 0.35, top);
          const rad = Math.max(reach(r, 1, 0), reach(r, -1, 0), reach(r, 0, 1), reach(r, 0, -1));
          if (top > b.low && b.lanes.some(([lc, half]) => Math.abs(lat - lc) < half + rad)) continue;
          if (st.ledges && st.ledges.at.some((a) => u > a - 1.2 - rad && u < a + 0.6 + rad)) continue;
          const q = at(s, lat); put(r, q.x, q.z, true);
        }
      }
      if (st.pile) {
        const b = st.pile;
        for (let u = b.from; u < b.to; u += b.every * (0.7 + R() * 0.6)) {
          const lat = lerp(b.lat[0], b.lat[1], R()), q = at(st.s0 + u, lat);
          put(rshape(lerp(b.size[0], b.size[1], R()), 0.9, 0.4, lerp(b.top[0], b.top[1], R())), q.x, q.z, true);
        }
      }
      // cobbles: rounded boulders packed across the tread on a jittered grid; tyres drive on them
      if (st.cobbles) {
        const c = st.cobbles;
        for (let u = Math.max(u0, c.from); u < Math.min(u1, c.to); u += c.dz) {
          const s = st.s0 + u, hw = widthAt(C, s) / 2, row = Math.round(u / c.dz);
          for (let lat = -hw + 0.5 + (row % 2) * c.dx * 0.5; lat < hw - 0.4; lat += c.dx) {
            // (where the section has lanes: that lane's cobble size, height and packing)
            // (before the lanes have opened, across the whole width: the easy lane's)
            const b = !st.bands.length ? null : st.open(u) > 0.5 ? st.bands.find((bb) => lat >= bb.lo * st.open(u) && lat < bb.hi * st.open(u)) : st.lane('easy');
            const cl = { ...c, ...(b && c.lanes?.[b.name]) };
            if (R() > cl.fill) continue;
            const q = at(s + (R() - 0.5) * c.dz * 0.4, lat + (R() - 0.5) * c.dx * 0.35);
            const r = rshape(lerp(cl.size[0], cl.size[1], R()) * 0.85, 0.95, 0.55, lerp(cl.top[0], cl.top[1], R())); // rounder: smaller and sunk deeper
            put(r, q.x, q.z, true); tag({ cobble: { course: C.id, stage: st.n } });
          }
        }
      }
      // kickers: low, rounded rocks under one wheel track (lat + = right, the camber's high side)
      if (st.kickers) {
        const kk = st.kickers;
        let k = 0;
        for (let u = Math.max(u0, kk.from); u < Math.min(u1, kk.to); u += kk.every * (0.85 + R() * 0.3), k++) {
          // under each listed lane's wheel track (+0.85 = its high side), or the centre line's
          for (const o of kk.lanes ? kk.lanes.map((nm) => st.lineLat(nm, u)) : [0]) {
            const lat = o + (kk.lat ?? [0.85])[k % (kk.lat ?? [0.85]).length] + (R() - 0.5) * 0.2, q = at(st.s0 + u, lat);
            const r = rshape(0.75 + R() * 0.35, 0.7, 0.45, lerp(kk.top[0], kk.top[1], R()));
            put(r, q.x, q.z, true); tag({ kicker: { course: C.id, stage: st.n } });
          }
        }
      }
      // a rock spine along the centre, in pieces, to straddle
      if (st.ribs) {
        const rb = st.ribs;
        // pieces of uneven length and crest, each a little skewed, so it reads as a broken spine
        for (let u = Math.max(u0, rb.from), L = rb.len; u + L < Math.min(u1, rb.to) + 0.5; u += L + rb.gap * (0.7 + R() * 0.6), L = rb.len * (0.7 + R() * 0.6)) {
          const piece = ribPiece(C, st.s0 + u, L, rb.w * (0.9 + R() * 0.2), rb.top * (0.85 + R() * 0.15), R, heightAt, rb.lane ? st.lineLat(rb.lane, u + L / 2) : 0);
          piece.rotY += (R() - 0.5) * 0.24;
          out.push(piece);
          out.at(-1).rib = { course: C.id, stage: st.n };
        }
      }
      // low embedded rocks in the tread (own stream)
      if (st.embed) {
        const e = st.embed;
        for (let u = u0; u < u1; u += e.every * (0.6 + R2() * 0.8)) {
          if (st.ledges && st.ledges.at.some((a) => u > a - 1.6 && u < a + 3.2)) continue;
          const s = st.s0 + u, hw = widthAt(C, s) / 2;
          const lat = R2() < 0.6 ? (R2() < 0.5 ? -1 : 1) * (0.8 + (R2() - 0.5) * 0.6) : (R2() * 2 - 1) * (hw - 0.4);
          const q = at(s, lat), k = R2();
          E.embedded(q.x, q.z, lerp(e.size[0], e.size[1], k), lerp(e.proud[0], e.proud[1], 0.3 * R2() + 0.7 * k));
        }
      }
    }
    out.push(...rocks, ...E.rocks);
  });
  return out;
}

// One piece of a slab ledge band: front face `rise` above the slope at its lip, a bench that
// runs back level-ish until it meets the slope, chamfered weathered ends. Local frame: +z along
// the course, +x across (lat), origin on the ground at the lip's centre.
function ledgePiece(C, s, la, lb, rise, R, heightAt) {
  const p = pathPoint(C, s), lm = (la + lb) / 2, half = (lb - la) / 2;
  const x = p.x - p.tz * lm, z = p.z + p.tx * lm;
  const g = Math.max(0.12, (pathPoint(C, s + 1.5).h - pathPoint(C, s - 1.5).h) / 3);
  const gTop = g * 0.25, depth = rise / (g - gTop);
  const pts = [], zf = -(rise + 0.35) * 0.55;
  // the lip: a ragged edge of 5 points across, the ends rounded down into the slope
  for (let k = 0; k <= 4; k++) {
    const f = -1 + k / 2, end = Math.abs(f) > 0.99;
    const xx = f * half * (end ? 0.82 + R() * 0.08 : 1), drop = end ? rise * (0.25 + R() * 0.2) : R() * 0.03;
    const zz = (R() - 0.5) * 0.22;
    pts.push(xx, rise - drop + gTop * zz, zz);
    pts.push(xx * (end ? 0.9 : 1), rise - drop * 0.6 + gTop * (zz + 0.12), zz + 0.12);
  }
  for (const sx of [-1, 1]) {
    pts.push(sx * (half + 0.12), -0.05, 0.1);                                          // the ends meet the ground
    pts.push(sx * (half + 0.15), g * zf - 0.35, zf);                                   // the face's foot, buried
    pts.push(sx * half * (0.75 + R() * 0.12), rise + gTop * depth * 0.55, depth * (0.5 + R() * 0.15)); // the bench
    pts.push(sx * (half + 0.1), g * (depth + 0.3) - 0.35, depth + 0.3);                // back, buried
  }
  for (let i = 0; i < 4; i++) { const zz = 0.3 + R() * depth * 0.6; pts.push((R() * 2 - 1) * half * 0.7, rise + gTop * zz + R() * 0.02, zz); }
  // each piece a little skewed to the band; the lip sits on the ground at its centre
  return { x, y: heightAt(x, z), z, rotY: Math.atan2(p.tx, p.tz) + (R() - 0.5) * 0.22, pts, ledge: true };
}

// a low, narrow, rounded rock spine `len` m long along the course centre
function ribPiece(C, s, len, w, top, R, heightAt, lat = 0) {
  const pc = pathPoint(C, s + len / 2), pm = { ...pc, x: pc.x - pc.tz * lat, z: pc.z + pc.tx * lat }, pts = [];
  const g = (pathPoint(C, s + len).h - pathPoint(C, s).h) / len;
  // cross-section levels: [height, half width]: a buried foot, the flanks, a rounded crest
  const levels = [[-0.3, w * 0.58], [top * 0.45, w * 0.5], [top * 0.85, w * 0.32], [top, 0.04]];
  for (const zz of [-0.5, -0.38, -0.15, 0.15, 0.38, 0.5]) {
    const endK = (Math.abs(zz) > 0.45 ? 0.35 : 1) * (0.82 + R() * 0.18); // the ends dip into the ground; a lumpy crest
    for (const [yy, hwl] of levels) for (const sx of [-1, 1]) {
      pts.push(sx * hwl * (yy < 0 ? 1 : endK + (1 - endK) * 0.5) * (0.85 + R() * 0.25), (yy < 0 ? yy : yy * endK) + g * zz * len, zz * len * (0.97 + R() * 0.04));
    }
  }
  // the camber tilts the ground across the spine: follow it (local +x is the course's left)
  const lx = -pm.tz, lz = pm.tx, side = (heightAt(pm.x + lx * 0.6, pm.z + lz * 0.6) - heightAt(pm.x - lx * 0.6, pm.z - lz * 0.6)) / 1.2;
  for (let i = 0; i < pts.length; i += 3) pts[i + 1] -= side * pts[i];
  return { x: pm.x, y: heightAt(pm.x, pm.z), z: pm.z, rotY: Math.atan2(pm.tx, pm.tz), pts };
}
