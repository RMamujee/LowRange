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
// Rated trails as BeamNG-style crawl corridors. Each trail is a narrow, road-like tread (`width`,
// the transit between features, and what the start / finish gates span) that opens into wide
// crux areas (`cruxes`): at = start (m along the trail), len, w = corridor width there (eased in
// and out over CRUX_EASE m). Inside a crux the ground carries LANES side by side, each its own line
// of a clearly different difficulty: [name, lat] (lat = the line's offset, m, + = right of travel;
// lanes split the corridor at the midpoints between their lines, the outer ones run to the edge).
// The trail's rating is that of its easiest complete route: the transit and every crux's `easy`
// lane; `hard` and `extreme` lanes are optional. Features per crux (all by lane):
//   ledges  { at: [u...], depth, rise: { lane: [m...] } }  up-and-down slab steps across the lane
//   garden  { lane: { every, size, top, clear, crawl, crawlTop, notch, notchTop, overs } } boulder
//           field: rocks keep `clear` m either side of the lane's meandering line (easy lanes leave
//           3 m+ between big rocks), `crawl` = chance of a low crawl-over rock in the wheel tracks,
//           `notch` = chance of a V-notch on the line, `overs` = packed rounded crawl-over boulders
//   camber  { lane, deg, from, to }  an off-camber shelf: the lane tilts, high side to the outer edge
//   holes   { lane, depth, every }   cross-axle holes under alternate wheel tracks
//   kickers { lane, top, every }     low rocks under the uphill wheels
//   notches { lane, top, every }     V-notches on the line
//   bog     { lane: sink factor }    (Bog Run) mud depth by lane: shallow long way, deep short way
//   meander { lane: [amp, wavelength] } the lane's line weaves through its garden
// Everything stays in map data (trail.cruxes with absolute s0 / s1 and lane bands; ledge rocks carry
// `crux` tags), so recovery points and tests can read the features without the grid.
const CRUX_EASE = 9;
const TRAIL_DEFS = [
  { name: 'Pinyon Two-Track', diff: 'green', pts: [[-20, 13], [-36, 17], [-60, 25], [-80, 50], [-90, 80], [-70, 105], [-62, 122]],
    cruxes: [
      // two short optional side features beside the two-track; the two-track itself stays green
      { name: 'Rock Step', at: 38, len: 14, w: 11, lanes: [['easy', 0], ['hard', 3.9]],
        ledges: { at: [3, 9.5], depth: 2.6, rise: { hard: [0.26, 0.32] } } },
      { name: 'Boulder Pocket', at: 102, len: 16, w: 11, lanes: [['hard', -3.9], ['easy', 0]],
        garden: { hard: { every: 2.2, overs: [0.28, 0.36], size: [0.7, 1.0] } } },
    ] },
  { name: 'Granite Steps', diff: 'blue', pts: [[40, 131], [42, 112], [30, 94], [26, 72], [38, 52], [60, 40], [84, 40], [100, 52], [104, 72], [120, 78], [132, 62], [146, 50]],
    cruxes: [
      { name: 'The Stairs', at: 28, len: 32, w: 17, lanes: [['easy', -5.4], ['hard', 0], ['extreme', 5.4]],
        ledges: { at: [4, 15, 26], depth: 3.4, rise: { easy: [0.24, 0.28, 0.3], hard: [0.38, 0.42, 0.45], extreme: [0.55, 0.6, 0.64] } } },
      { name: 'Slab Shelf', at: 72, len: 26, w: 15, lanes: [['hard', -4], ['easy', 3.6]],
        camber: { lane: 'hard', deg: 15, from: 3, to: 23 }, kickers: { lane: 'hard', top: 0.24, every: 5 },
        garden: { easy: { every: 4.5, size: [0.5, 0.9], top: 0.5, clear: 1.8, crawl: 0.25, crawlTop: 0.22 } } },
      { name: 'Granite Garden', at: 110, len: 34, w: 18, lanes: [['easy', -6], ['hard', 0], ['extreme', 6]],
        meander: { easy: [1.1, 26], hard: [0.8, 18] },
        garden: {
          easy: { every: 2.6, size: [0.55, 1.1], top: 0.6, clear: 1.7, crawl: 0.3, crawlTop: 0.24 },
          hard: { every: 2.4, size: [0.6, 1.25], top: 0.65, clear: 1.2, crawl: 0.6, crawlTop: 0.4, notch: 0.15, notchTop: 0.45 },
          extreme: { every: 1.7, overs: [0.48, 0.6], size: [0.9, 1.3] } } },
      { name: 'Top Step', at: 206, len: 12, w: 13, lanes: [['hard', -3.4], ['easy', 3.4]],
        ledges: { at: [4], depth: 3.4, rise: { easy: [0.3], hard: [0.5] } } },
    ] },
  { name: 'Bog Run', diff: 'blue', pts: [[-148, 20], [-128, 26], [-106, 22], [-88, 10], [-76, -8], [-74, -28], [-86, -44], [-104, -52], [-120, -65]], mud: [0.14, 0.86], mudSink: 0.56, width: 7.5, maxGrade: 0.1,
    cruxes: [
      // the bog bends left: the shallow, firmer line swings round the outside (the long way), the
      // direct line through the middle is the deep, rutted one, a softer pit hugs the inside
      { name: 'The Bog', at: 28, len: 112, w: 19, lanes: [['extreme', -6.2], ['hard', 0], ['easy', 5.6]],
        bog: { extreme: 1.45, hard: 1, easy: 0.42 } },
    ] },
  { name: 'Boulder Alley', diff: 'black', pts: [[96, -96], [84, -86], [76, -68], [62, -56], [42, -50], [24, -58], [16, -76], [24, -94], [14, -110], [-2, -108], [-10, -118], [-8, -133]],
    cruxes: [
      { name: 'The Alley', at: 27, len: 27, w: 18, lanes: [['easy', -5.6], ['hard', 0], ['extreme', 5.8]],
        meander: { easy: [1.0, 24], hard: [0.7, 16] },
        garden: {
          easy: { every: 2.4, size: [0.7, 1.4], top: 0.75, clear: 1.6, crawl: 0.45, crawlTop: 0.3 },
          hard: { every: 2.2, size: [0.8, 1.6], top: 0.8, clear: 1.15, crawl: 0.7, crawlTop: 0.42, notch: 0.2, notchTop: 0.5 },
          extreme: { every: 1.6, overs: [0.52, 0.64], size: [1.0, 1.4] } } },
      { name: 'Ledge Band', at: 68, len: 26, w: 16, lanes: [['extreme', -5], ['hard', 0], ['easy', 5]],
        ledges: { at: [4, 16], depth: 3.4, rise: { easy: [0.32, 0.36], hard: [0.5, 0.55], extreme: [0.65, 0.7] } } },
      { name: 'Off-Camber Shelf', at: 101, len: 18, w: 14, lanes: [['easy', -3.6], ['hard', 3.8]],
        camber: { lane: 'hard', deg: 20, from: 2, to: 16 }, kickers: { lane: 'hard', top: 0.26, every: 5 },
        holes: { lane: 'easy', depth: 0.22, every: 4.4 } },
      { name: 'V-Notch Run', at: 138, len: 10, w: 12, lanes: [['hard', -2.8], ['easy', 3.2]],
        notches: { lane: 'hard', top: 0.55, every: 5.5 },
        garden: { easy: { every: 2.8, size: [0.7, 1.3], top: 0.7, clear: 1.6, crawl: 0.4, crawlTop: 0.3 } } },
      { name: 'Exit Steps', at: 176, len: 12, w: 12, lanes: [['easy', -3.5], ['hard', 3.5]],
        ledges: { at: [4], depth: 3.4, rise: { easy: [0.36], hard: [0.56] } } },
    ] },
  { name: 'Widowmaker Falls', diff: 'dblack', pts: [[-68, -121], [-54, -108], [-58, -90], [-70, -74], [-60, -56], [-42, -50], [-36, -66], [-22, -58], [-16, -40], [0, -30], [20, -24]],
    cruxes: [
      { name: 'The Falls', at: 29, len: 18, w: 15, lanes: [['easy', -4.8], ['hard', 0], ['extreme', 4.8]],
        ledges: { at: [2, 13], depth: 3.2, rise: { easy: [0.42, 0.44], hard: [0.55, 0.6], extreme: [0.68, 0.74] } } },
      { name: 'Boulder Choke', at: 69, len: 18, w: 15, lanes: [['extreme', -4.9], ['hard', 0], ['easy', 4.7]],
        meander: { easy: [0.7, 16], hard: [0.5, 12] },
        garden: {
          easy: { every: 2.2, size: [0.85, 1.7], top: 0.8, clear: 1.5, crawl: 0.6, crawlTop: 0.4 },
          hard: { every: 2.0, size: [0.9, 1.8], top: 0.85, clear: 1.05, crawl: 0.8, crawlTop: 0.48, notch: 0.2, notchTop: 0.58 },
          extreme: { every: 1.5, overs: [0.6, 0.7], size: [1.1, 1.5] } } },
      { name: 'The Widowmaker', at: 157, len: 18, w: 15, lanes: [['easy', -4.4], ['hard', 0.4], ['extreme', 5.0]],
        ledges: { at: [2, 13], depth: 3.4, rise: { easy: [0.44, 0.46], hard: [0.6, 0.62], extreme: [0.72, 0.76] } } },
    ] },
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


// the cruxes' own ground (heightfield): off-camber shelves and cross-axle holes, by lane
function cruxGround(t, s, lat) {
  let dh = 0;
  for (const c of t.cruxes) {
    if (s < c.s0 - 1 || s > c.s1 + 1) continue;
    const u = s - c.s0;
    if (c.camber) {
      const cb = c.camber, ln = c.lane(cb.lane), first = ln === c.lanes[0];
      const inner = first ? ln.hi : ln.lo, sg = first ? -1 : 1;
      const along = smooth(cb.from, cb.from + 5, u) * smooth(cb.to, cb.to - 5, u);
      dh += clamp((lat - inner) * sg, 0, 6.5) * Math.tan((cb.deg * Math.PI) / 180) * along;
    }
    if (c.holes) {
      const ho = c.holes, line = t.laneLat(c, ho.lane, s);
      for (let k = 0, q = 4; q < c.len - 4; k++, q += ho.every) dh -= ho.depth * bump(Math.hypot(u - q, lat - line - (k % 2 ? 0.85 : -0.85)), 1.0);
    }
  }
  return dh;
}
// 0 from just before a crux's ledge band to just past it, 1 elsewhere
function ledgeFade(t, s) {
  let f = 1;
  for (const c of t.cruxes) if (c.ledges && s > c.s0 - 3 && s < c.s1 + 3) for (const u of c.ledges.at) {
    const a = c.s0 + u, b = a + c.ledges.depth;
    f = Math.min(f, 1 - smooth(a - 2.8, a - 1.8, s) * smooth(b + 1.6, b + 0.6, s));
  }
  return f;
}
// mud depth factor by lane across a wide bog (1 on the middle line; eased between lanes)
function bogFactor(t, s, lat) {
  const c = t.cruxes.find((q) => q.bog && s > q.s0 - CRUX_EASE && s < q.s1 + CRUX_EASE);
  if (!c) return 1;
  const L = c.lanes, f = (ln) => c.bog[ln.name] ?? 1;
  let v = f(L[0]);
  for (let i = 1; i < L.length; i++) v = lerp(v, f(L[i]), smooth(L[i - 1].lat + 2, L[i].lat - 2, lat));
  return lerp(1, v, smooth(c.s0 - CRUX_EASE, c.s0, s) * smooth(c.s1 + CRUX_EASE, c.s1, s));
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
  // The pinned ends stay pinned: the forward pass never moves the last point and the backward
  // pass never moves the first, so the grade limit reshapes the approach to each junction instead
  // of lifting the trail's end off the road (which left 3-5 m drops at three far ends). Repeated
  // until the profile settles inside the limit from both ends.
  const n = hs.length;
  const r0 = pin ? nearestRoadHeight(pts[0].x, pts[0].z) : 0, r1 = pin ? nearestRoadHeight(pts.at(-1).x, pts.at(-1).z) : 0;
  for (let pass = 0; pass < 12; pass++) {
    if (pin) { hs[0] = r0; hs[n - 1] = r1; }
    for (let i = 1; i < (pin ? n - 1 : n); i++) { const ds = pts[i].s - pts[i - 1].s; hs[i] = clamp(hs[i], hs[i - 1] - maxG * ds, hs[i - 1] + maxG * ds); }
    for (let i = n - 2; i >= (pin ? 1 : 0); i--) { const ds = pts[i + 1].s - pts[i].s; hs[i] = clamp(hs[i], hs[i + 1] - maxG * ds, hs[i + 1] + maxG * ds); }
  }
  if (pin) {
    const h0 = hs[0], h1 = hs[hs.length - 1], L = pts[pts.length - 1].s;
    hs = hs.map((h, i) => { const s = pts[i].s; return lerp(h1, lerp(h0, h, smooth(0, 15, s)), smooth(0, 15, L - s)); });
    // that easing can steepen the last metres past the limit: clamp again, ends still pinned
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 1; i < n - 1; i++) { const ds = pts[i].s - pts[i - 1].s; hs[i] = clamp(hs[i], hs[i - 1] - maxG * ds, hs[i - 1] + maxG * ds); }
      for (let i = n - 2; i >= 1; i--) { const ds = pts[i + 1].s - pts[i].s; hs[i] = clamp(hs[i], hs[i + 1] - maxG * ds, hs[i + 1] + maxG * ds); }
    }
  }
  pts.forEach((p, i) => { p.h = hs[i]; });
  const width = def.width ?? (isRoad ? 8 : def.diff === 'green' ? 5.5 : def.diff === 'blue' ? 5.5 : 5.2);
  const path = { ...def, kind, pts, length: s, width, shoulder: isRoad ? 6 : 3.5 };
  if (!isRoad) corridor(path);
  return path;
}

// ---------- crawl corridors ----------
// Per trail point: w (corridor width), sh (edge fade into the natural ground), xs (cross slope the
// corridor follows: the natural fall of the hillside, limited by difficulty, so a wide corridor
// doesn't stand in a cut or on a fill). Cruxes get absolute s0 / s1 and lane bands { name, lat,
// lo, hi }; the trail gets its marked lines (easy / hard / extreme, [[s, lat], ...] every metre:
// the easy line is the rated route and the autopilot's) and lineAt(name, s).
const XS_MAX = { green: 0.04, blue: 0.09, black: 0.14, dblack: 0.16 };
function corridor(t) {
  const P = t.pts, base = t.width;
  t.corridor = true;
  t.cruxes = (t.cruxes || []).map((c, ci) => {
    const s0 = c.at, s1 = c.at + c.len, L = [...c.lanes].sort((a, b) => a[1] - b[1]);
    const lanes = L.map(([name, lat], k) => ({
      name, lat,
      lo: k ? (L[k - 1][1] + lat) / 2 : -c.w / 2 - 1.5,
      hi: k < L.length - 1 ? (L[k + 1][1] + lat) / 2 : c.w / 2 + 1.5,
    }));
    return { ...c, index: ci, s0, s1, lanes, lane: (n) => lanes.find((q) => q.name === n) || null };
  });
  const k = (c, s, e = CRUX_EASE) => smooth(c.s0 - e, c.s0 - 1, s) * smooth(c.s1 + e, c.s1 + 1, s);
  for (const p of P) {
    let w = base;
    for (const c of t.cruxes) w = Math.max(w, lerp(base, c.w, k(c, p.s)));
    p.w = w; p.sh = 3.5 + 0.35 * Math.max(0, w / 2 - 3);
  }
  // natural cross slope, smoothed along the trail and limited (bogs stay level)
  const raw = P.map((p, i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / L, nz = (b.x - a.x) / L, r = p.w / 2 + 3;
    return (baseHeight(p.x + nx * r, p.z + nz * r) - baseHeight(p.x - nx * r, p.z - nz * r)) / (2 * r);
  });
  const lim = XS_MAX[t.diff] ?? 0.08;
  P.forEach((p, i) => {
    let a = 0, n = 0; for (let q = -6; q <= 6; q++) { a += raw[clamp(i + q, 0, P.length - 1)]; n++; }
    const f = p.s / t.length, mud = t.mud && f > t.mud[0] - 0.04 && f < t.mud[1] + 0.04 ? 1 : 0;
    p.xs = clamp(a / n, -lim, lim) * smooth(0, 14, Math.min(p.s, t.length - p.s)) * (1 - mud);
  });
  // a lane's line: its lat, weaving through a garden where the crux says so
  const laneLat = (c, ln, s) => {
    const m = c.meander?.[ln.name];
    return m ? ln.lat + m[0] * Math.sin(((s - c.s0) / m[1]) * Math.PI * 2 + c.index * 1.7) * smooth(0, 6, Math.min(s - c.s0, c.s1 - s)) : ln.lat;
  };
  t.laneLat = (c, name, s) => { const ln = c.lane(name); return ln ? laneLat(c, ln, s) : null; };
  const pick = (c, name) => c.lane(name) || (name === 'extreme' && c.lane('hard')) || c.lane('easy');
  t.lines = {};
  for (const name of ['easy', 'hard', 'extreme']) {
    const out = [];
    for (let s = 0; s <= t.length + 1e-6; s += 1) {
      let lat = 0;
      for (const c of t.cruxes) { const kk = k(c, s, CRUX_EASE - 1); if (kk > 0) lat = lerp(lat, laneLat(c, pick(c, name), clamp(s, c.s0, c.s1)), kk); }
      out.push([s, lat]);
    }
    t.lines[name] = out;
  }
  t.lineAt = (name, s) => { const L = t.lines[name] || t.lines.easy, f = clamp(s, 0, L.length - 1), i = Math.min(L.length - 2, Math.floor(f)); return lerp(L[i][1], L[i + 1][1], f - i); };
  t.cruxAt = (s) => t.cruxes.find((c) => s >= c.s0 && s <= c.s1) || null;
}
// the corridor's cross slope at arc length s
const xsAt = (t, s) => { const P = t.pts; let i = 1; while (i < P.length - 1 && P[i].s < s) i++; return lerp(P[i - 1].xs, P[i].xs, clamp((s - P[i - 1].s) / Math.max(1e-6, P[i].s - P[i - 1].s), 0, 1)); };
// corridor width at arc length s (pts carry w every ~2 m)
export const widthAt = (t, s) => {
  const P = t.pts;
  if (P[0].w === undefined) return t.width;
  let i = 1; while (i < P.length - 1 && P[i].s < s) i++;
  const a = P[i - 1], b = P[i];
  return lerp(a.w, b.w, clamp((s - a.s) / Math.max(1e-6, b.s - a.s), 0, 1));
};

export const ROADS = [];
ROAD_DEFS.forEach((d) => ROADS.push(buildPath(d, 'road')));
export const TRAILS = TRAIL_DEFS.map((d) => buildPath(d, 'trail'));
const PATHS = [...ROADS, ...TRAILS];

// ---------- baked grid ----------
const grid = makeGrid(SIZE, RES);
const { N1, CELL } = grid;
export const { GRID, heightAt, visualHeightAt, materialAt } = grid;
// facing down the spur road (ROADS[1]) towards the green Pinyon Two-Track's start gate and signpost;
// the loop road's heading (-0.31 pi) pointed a new player straight into Widowmaker Falls' far gate
export const SPAWN = { x: 0, z: 0, yaw: 2.4 };

function bake() {
  // spatial hash of path segments
  const B = 16, nb = Math.ceil(SIZE / B);
  const bins = Array.from({ length: nb * nb }, () => []);
  PATHS.forEach((p, pi) => {
    for (let i = 1; i < p.pts.length; i++) {
      const a = p.pts[i - 1], b = p.pts[i];
      const reach = Math.max(a.w ?? p.width, b.w ?? p.width) / 2 + Math.max(a.sh ?? p.shoulder, b.sh ?? p.shoulder) + 1;
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
        // (a crawl corridor's width, edge fade and cross slope vary along it)
        const hw = (a.w !== undefined ? lerp(a.w, b.w, t) : p.width) / 2, sh = a.sh !== undefined ? lerp(a.sh, b.sh, t) : p.shoulder;
        if (d > hw + sh) continue;
        const prev = perPath.get(pi);
        if (!prev || d < prev.d) {
          const L = Math.sqrt(L2);
          const lat = ((x - a.x) * -ez + (z - a.z) * ex) / L;
          perPath.set(pi, { d, pi, lat, hw, sh, xs: a.xs !== undefined ? lerp(a.xs, b.xs, t) : 0, s: lerp(a.s, b.s, t), ph: lerp(a.h, b.h, t), g: (b.h - a.h) / Math.max(1e-6, b.s - a.s), score: d - (p.kind === 'road' ? 1.5 : 0) });
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
        const hw = best.hw;
        // blend every path in reach, weighted by how far inside it we are, so road/trail
        // junctions meet smoothly instead of forming a hump or ditch
        let num = 0, den = 0, W = 0;
        for (const c of perPath.values()) {
          const q = PATHS[c.pi], qhw = c.hw;
          const w = 1 - smooth(qhw, qhw + c.sh, c.d);
          if (w <= 0) continue;
          let surf = c.ph;
          if (q.kind === 'road') {
            surf -= Math.min(1, c.d / qhw) ** 2 * 0.12; // crown
            // graded, not billiard-flat: a gentle washboard along the road (about 2.8 m, the
            // 1 m grid samples it into an uneven corrugation), soft lumps and shallow potholes
            surf += 0.022 * Math.sin(c.s * 2.24) * (0.6 + 0.4 * fbm(x * 0.05, z * 0.05, 2) * 2) + lumps(x, z, 0.03) + potholes(x, z, 10, 0.3, 0.08, 1.2, 3);
          } else {
            // rough tread, eased in away from the trail ends
            // (micro-relief fades out in front of and over a crux's ledge bands, so their steps hold)
            const ends = smooth(0, 12, Math.min(c.s, q.length - c.s)) * ledgeFade(q, c.s);
            const rough = { green: 0.15, blue: 0.26, black: 0.28, dblack: 0.32 }[q.diff];
            // steep pitches get smoother rock: small steps on a 35% grade act like ledges
            const steep = q.diff === 'black' || q.diff === 'dblack' ? 1 - 0.6 * smooth(0.15, 0.35, Math.abs(c.g)) : 1;
            surf += fbm(x * 0.45, z * 0.45, 2) * rough * steep * ends;
            // micro-relief by difficulty (RELIEF): rolling lumps, wheel-track ruts, potholes
            const rl = RELIEF[q.diff], inMud = q.mud && c.s / q.length > q.mud[0] - 0.02 && c.s / q.length < q.mud[1] + 0.02;
            surf += lumps(x, z, rl.lumps) * steep * ends;
            if (rl.ruts && !inMud) surf -= rl.ruts * (0.65 + 0.7 * fbm(x * 0.11 - 4, z * 0.11 + 8, 2)) * (bump(Math.abs(c.lat - 0.82), 0.62) + bump(Math.abs(c.lat + 0.82), 0.62)) * ends;
            surf += potholes(x, z, rl.holes[0], rl.holes[1], rl.holes[2], rl.holes[3], c.pi * 17) * ends;
            // the narrow tread's designed off-camber (wide corridors take the hillside's own fall
            // instead, plus their cruxes' shelves)
            const camber = { green: 0, blue: q.mud ? 0 : 0.07, black: 0.16, dblack: 0.17 }[q.diff], wide = smooth(q.width, q.width + 3, 2 * qhw);
            if (camber) surf += clamp(c.lat, -q.width / 2 - 0.5, q.width / 2 + 0.5) * camber * Math.sin(c.s * 0.045) * ends * (1 - wide);
            surf += clamp(c.lat, -qhw - c.sh, qhw + c.sh) * c.xs;
            surf += cruxGround(q, c.s, c.lat, x, z);
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
              // the bog's floor is uneven: soft holes and firmer humps under a flat-looking surface;
              // deeper or shallower by lane where the bog is wide (the centre keeps the base depth)
              const depth = (p.mudSink ?? MUD_SINK) * (1 + 0.4 * fbm(x * 0.16 + 3, z * 0.16 - 7, 2)) * bogFactor(p, best.s, best.lat);
              mat = MAT.MUD; sink = depth * smooth(hw + 0.5, hw - 1, best.d); h -= sink;
              // churned wheel ruts along the bog: grooves you can see (60% of their depth shows),
              // deeper and softer in places, a firmer crown between them; the shallow line carries
              // its own, fainter pair
              const ease = smooth(p.mud[0], p.mud[0] + 0.04, f) * smooth(p.mud[1], p.mud[1] - 0.04, f);
              const k = 0.6 + 0.8 * clamp(fbm(x * 0.13 + 1, z * 0.13 + 5, 2) + 0.5, 0, 1);
              const ruts = bump(Math.abs(best.lat - 0.85), 0.7) + bump(Math.abs(best.lat + 0.85), 0.7);
              const el = p.lineAt('easy', best.s), eRuts = Math.abs(el) > 2.5 ? 0.5 * (bump(Math.abs(best.lat - el - 0.85), 0.7) + bump(Math.abs(best.lat - el + 0.85), 0.7)) : 0;
              h -= MUD_RUTS * k * ease * (ruts + eRuts) - 0.04 * ease * bump(Math.abs(best.lat), 0.6);
              vRut = MUD_RUTS * k * ease * (ruts + eRuts) * 0.4;
              GRID.tone[idx] = Math.round(clamp((ruts + eRuts) * k * 0.8 * ease, 0, 1) * 255);
            }
            else {
              mat = p.diff === 'green' ? (n > 0.3 ? MAT.GRAVEL : MAT.DIRT) : (n > (p.diff === 'blue' ? 0.15 : 0.35) ? MAT.DIRT : MAT.ROCK); // hard trails are mostly bare rock
              // worn wheel ruts show as darker tread; through a crux the easy line is the worn one
              const el = p.lineAt('easy', best.s), wear = p.cruxes.reduce((m, c) => Math.max(m, smooth(c.s0 - 6, c.s0, best.s) * smooth(c.s1 + 6, c.s1, best.s)), 0);
              const tracks = (o) => bump(Math.abs(best.lat - o - 0.82), 0.62) + bump(Math.abs(best.lat - o + 0.82), 0.62);
              const rutTone = RELIEF[p.diff].ruts ? tracks(0) * 0.55 * (1 - wear) : 0;
              GRID.tone[idx] = Math.round(clamp(Math.max(rutTone, tracks(el) * 0.45 * wear), 0, 1) * 255 * smooth(0, 12, Math.min(best.s, p.length - best.s)));
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
    if (Math.hypot(p.pts[i].x - x, p.pts[i].z - z) < (p.pts[i].w ?? p.width) / 2 + margin) return true;
  }
  return Math.hypot(x - TRAILHEAD.x, z - TRAILHEAD.z) < TRAILHEAD.r + margin;
}

// ---------- rocks ----------
// Transit stretches stay road-like (rocks at the edges, the middle clear, nothing harder than the
// trail's easy line); the cruxes carry their lanes' features; boulders mark the corridor's edges.
// Rocks that matter carry tags: `ledge` + `crux` { trail, crux, lane, rise } on ledge pieces (with
// their half width / depth hw, hd), `crux` with `over` / `kicker` / `notch` on the crawl-over rocks.
const TRANSIT = {
  // green: the two-track keeps its centre clear; rocks stay under the Rally Sedan's 0.25 m sills,
  // its ledges are curb-sized
  green:  { every: 7, min: 0.25, max: 0.7, top: 0.2, flat: 0.6, clear: 0.9, ledgeEvery: 28, ledgeH: [0.1, 0.17] },
  blue:   { every: 5, min: 0.45, max: 1.0, top: 0.45, flat: 0.85, clear: 1.6 },
  black:  { every: 4.5, min: 0.6, max: 1.3, top: 0.55, flat: 0.85, clear: 1.5, crawl: 0.35, crawlTop: 0.3 },
  dblack: { every: 4, min: 0.7, max: 1.5, top: 0.6, flat: 0.85, clear: 1.45, crawl: 0.45, crawlTop: 0.36 },
};
export function generateRocks() {
  const R = rng(1337);
  const { rocks, shape, put, boulder, reach, ledge } = rockKit(R, heightAt);
  const tag = (o) => Object.assign(rocks[rocks.length - 1], o);
  const at = (t, s, lat) => { const p = pathPoint(t, s); return { p, x: p.x - p.tz * lat, z: p.z + p.tx * lat, nx: -p.tz, nz: p.tx }; };
  // Step heights shrink on steep pitches: a rigid tyre that walks up a 0.6 m step on the flat can't on a 40% grade.
  const grade = (t, s) => { let g = 0; for (let q = -3; q < 3; q += 0.5) g = Math.max(g, Math.abs(pathPoint(t, s + q + 0.5).h - pathPoint(t, s + q).h) / 0.5); return g; };
  // tallest step a skilled driver can still walk a 0.45-0.5 m tyre up at this grade
  // (test/ledgegrade.mjs: the Cruiser walks 0.7 m on the flat, 0.6 at 20%, 0.5 at 30%, 0.3 at 38%)
  const stepCap = (g) => (g < 0.2 ? 0.65 : g < 0.3 ? lerp(0.65, 0.48, (g - 0.2) / 0.1) : g < 0.38 ? lerp(0.48, 0.26, (g - 0.3) / 0.08) : 0.22);
  // harder lanes keep their margin over the easy one when the grade trims the steps
  const LANE_EXTRA = { easy: 0, hard: 0.08, extreme: 0.16 };
  // every trail rock remembers where along its trail it was placed (cur), so one that lands in
  // another trail's corridor, or in another part of its own trail that passes close by, is dropped
  let cur = null;
  const putO = (...a) => { put(...a); rocks[rocks.length - 1]._o = cur; };
  const ledgeO = (...a) => { ledge(...a); rocks[rocks.length - 1]._o = cur; };

  for (const t of TRAILS) {
    const spec = TRANSIT[t.diff], hwAt = (s) => widthAt(t, s) / 2;
    const inCrux = (s, m) => t.cruxes.some((c) => s > c.s0 - m && s < c.s1 + m);
    const mud = (s) => t.mud && s / t.length > t.mud[0] - 0.03 && s / t.length < t.mud[1] + 0.03;
    // ---- transit ----
    let side = 1, nextLedge = spec.ledgeEvery ? 12 : Infinity;
    for (let s = 10; s < t.length - 8; s += spec.every * (0.7 + R() * 0.6)) {
      if (mud(s) || inCrux(s, CRUX_EASE - 1)) continue;
      const q = at(t, s, 0), hw = hwAt(s);
      cur = [t, s];
      if (s > nextLedge) {
        // (green) a curb-sized step across the two-track, deeper than a wheelbase
        const depth = 3 + R(), top = lerp(spec.ledgeH[0], spec.ledgeH[1], R());
        ledgeO(q.p.x, q.p.z, Math.atan2(q.p.tx, q.p.tz), t.width + 1.2, depth, top);
        tag({ hw: (t.width + 1.2) / 2, hd: depth / 2 });
        nextLedge = s + spec.ledgeEvery * (0.75 + R() * 0.5);
        s += depth / 2 + 1.5;
        continue;
      }
      // a rock on alternate sides, the middle of the tread kept clear
      {
        const r = shape(spec.min + Math.pow(R(), 1.5) * (spec.max - spec.min), spec.flat, 0.35, spec.top);
        const c = side * (spec.clear + reach(r, -q.nx * side, -q.nz * side) + R() * Math.max(0, hw - spec.clear - 0.4));
        putO(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true);
        side = -side;
      }
      if (spec.crawl && R() < spec.crawl) {
        const r = shape(0.35 + R() * 0.3, 0.8, 0.35, spec.crawlTop), c = (R() < 0.5 ? -1 : 1) * (0.75 + R() * 0.25);
        putO(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true);
      }
    }
    // ---- cruxes ----
    for (const c of t.cruxes) {
      const ctag = (o) => tag({ crux: { trail: t.name, crux: c.index, name: c.name, ...o } });
      if (c.ledges) c.ledges.at.forEach((u, k) => {
        const L = c.ledges, s = c.s0 + u + L.depth / 2, q = at(t, s, 0), hw = hwAt(s), g = grade(t, s), rotY = Math.atan2(q.p.tx, q.p.tz);
        cur = [t, s];
        for (const ln of c.lanes) {
          const want = L.rise[ln.name]?.[k];
          if (!want) continue;
          const rise = Math.min(want, stepCap(g) + (LANE_EXTRA[ln.name] ?? 0));
          // the outer lanes run past the corridor's edge, so a band can't be driven round
          const lo = Math.max(ln.lo, -hw - 1.5), hi = Math.min(ln.hi, hw + 1.5), mid = (lo + hi) / 2, width = hi - lo + 0.4; // (neighbours overlap: no gap to wedge in)
          ledgeO(q.p.x + q.nx * mid, q.p.z + q.nz * mid, rotY, width, L.depth, rise, -xsAt(t, s)); // (tilted with the corridor, not the banks past it)
          tag({ hw: width / 2, hd: L.depth / 2 });
          ctag({ lane: ln.name, kind: 'ledge', u, rise, lat: mid });
        }
      });
      if (c.garden) for (const ln of c.lanes) {
        const sp = c.garden[ln.name];
        if (!sp) continue;
        for (let u = 2.5; u < c.len - 2; u += (sp.every ?? 2.4) * (0.7 + R() * 0.6)) {
          const s = c.s0 + u, q = at(t, s, 0), line = t.laneLat(c, ln.name, s), hw = hwAt(s);
          const lo = Math.max(ln.lo, -hw) + 0.2, hi = Math.min(ln.hi, hw) - 0.2;
          cur = [t, s];
          if (sp.overs) {
            // packed, rounded crawl-over boulders across the lane: you drive on them
            for (let lat = lo + 0.5 + R() * 0.5; lat < hi - 0.4; lat += 1.45 + R() * 0.55) {
              const r = shape(lerp(sp.size[0], sp.size[1], R()), 0.75, 0.5, lerp(sp.overs[0], sp.overs[1], R()));
              const p = at(t, s + (R() - 0.5) * 0.8, lat);
              putO(r, p.x, p.z, true); ctag({ lane: ln.name, kind: 'over' });
            }
            continue;
          }
          if (sp.notch && R() < sp.notch) {
            // V-notch: two low, sloping rocks either side of the line; the tyres ride their
            // flanks while the diffs thread the gap
            const sz = 1.1 + R() * 0.35;
            for (const sd of [1, -1]) {
              const r = shape(sz, 0.55, 0.3, sp.notchTop), cc = line + sd * (0.5 + reach(r, -q.nx * sd, -q.nz * sd));
              putO(r, q.p.x + q.nx * cc, q.p.z + q.nz * cc, true); ctag({ lane: ln.name, kind: 'notch' });
            }
            u += 1.5;
            continue;
          }
          // boulders either side of the line, outside its clear path and inside the lane
          for (const sd of [-1, 1]) {
            if (R() < 0.3) continue;
            const r = shape(sp.size[0] + Math.pow(R(), 1.5) * (sp.size[1] - sp.size[0]), 0.85, 0.35, sp.top);
            const cc = line + sd * (sp.clear + reach(r, -q.nx * sd, -q.nz * sd) + R() * 1.4);
            const outer = cc + sd * reach(r, q.nx * sd, q.nz * sd);
            if (sd > 0 ? outer > hi : outer < lo) continue;
            putO(r, q.p.x + q.nx * cc, q.p.z + q.nz * cc, true);
          }
          // a low crawl-over rock in a wheel track
          if (sp.crawl && R() < sp.crawl) {
            const r = shape(0.35 + R() * 0.3, 0.8, 0.35, sp.crawlTop), cc = line + (R() < 0.5 ? -1 : 1) * (0.75 + R() * 0.25);
            putO(r, q.p.x + q.nx * cc, q.p.z + q.nz * cc, true); ctag({ lane: ln.name, kind: 'crawl' });
          }
        }
      }
      if (c.kickers) {
        // low rocks under the uphill wheels of an off-camber shelf (its outer, high side)
        const kk = c.kickers, first = c.lane(kk.lane) === c.lanes[0];
        for (let u = 6; u < c.len - 4; u += kk.every * (0.85 + R() * 0.3)) {
          const s = c.s0 + u, lat = t.laneLat(c, kk.lane, s) + (first ? -0.85 : 0.85) + (R() - 0.5) * 0.2, p = at(t, s, lat);
          cur = [t, s];
          putO(shape(0.75 + R() * 0.35, 0.7, 0.45, kk.top * (0.85 + R() * 0.15)), p.x, p.z, true); ctag({ lane: kk.lane, kind: 'kicker' });
        }
      }
      if (c.notches) {
        const nn = c.notches;
        for (let u = 4; u < c.len - 3; u += nn.every * (0.85 + R() * 0.3)) {
          const s = c.s0 + u, q = at(t, s, 0), line = t.laneLat(c, nn.lane, s), sz = 1.1 + R() * 0.35;
          cur = [t, s];
          for (const sd of [1, -1]) {
            const r = shape(sz, 0.55, 0.3, nn.top * (0.9 + R() * 0.1)), cc = line + sd * (0.5 + reach(r, -q.nx * sd, -q.nz * sd));
            putO(r, q.p.x + q.nx * cc, q.p.z + q.nz * cc, true); ctag({ lane: nn.lane, kind: 'notch' });
          }
        }
      }
    }
    // ---- corridor edges: boulders just outside the drivable width mark it (not a wall) ----
    for (let s = 7; s < t.length - 6; s += (t.diff === 'green' ? 4.5 : 3.4) + R() * 3) {
      if (mud(s)) continue;
      const sd = R() < 0.5 ? -1 : 1, q = at(t, s, 0), hw = hwAt(s), r = shape(0.5 + R() * 0.9, 0.8);
      cur = [t, s];
      const c = sd * (hw + 0.4 + reach(r, -q.nx * sd, -q.nz * sd) * (0.9 + R() * 0.3));
      putO(r, q.p.x + q.nx * c, q.p.z + q.nz * c, true);
    }
  }
  for (let i = rocks.length - 1; i >= 0; i--) {
    const r = rocks[i], o = r._o;
    delete r._o;
    if (!o) continue;
    const [t0, s0] = o, rad = r.ledge ? 0 : 0.3;
    if (TRAILS.some((t) => t.pts.some((p) => (t !== t0 || Math.abs(p.s - s0) > 25) && Math.hypot(p.x - r.x, p.z - r.z) < p.w / 2 + rad))) rocks.splice(i, 1);
  }
  // scattered boulders off the paths
  for (let i = 0; i < 260; i++) {
    const x = (R() * 2 - 1) * 175, z = (R() * 2 - 1) * 175;
    if (onAnyPath(x, z, 3)) continue;
    boulder(x, z, 0.5 + Math.pow(R(), 2) * 2.4, 0.8);
  }

  // ---- ground relief: embedded rocks in the trail tread (half of them in the easy line's wheel
  // tracks) and rock rubble beside it, by difficulty (RELIEF); own random stream ----
  const E = rockKit(rng(4711), heightAt), R2 = rng(4712);
  const ledges = rocks.filter((r) => r.ledge);
  // in front of / on a ledge (its footprint grown by 1.8 m along, 1 m across): keep the steps as designed
  const nearLedge = (x, z) => ledges.some((r) => {
    const dx = x - r.x, dz = z - r.z; if (dx * dx + dz * dz > 100) return false;
    const c = Math.cos(r.rotY), s = Math.sin(r.rotY), px = dx * c - dz * s, pz = dx * s + dz * c;
    return Math.abs(px) < r.hw + 1 && Math.abs(pz) < r.hd + 1.8;
  });
  for (const t of TRAILS) {
    const rl = RELIEF[t.diff], e = rl.embed;
    const mud = (s) => t.mud && s / t.length > t.mud[0] - 0.03 && s / t.length < t.mud[1] + 0.03;
    for (let s = 8; s < t.length - 6; s += e.every * (0.6 + R2() * 0.8) * Math.sqrt(t.width / widthAt(t, s))) {
      if (mud(s)) continue;
      const p = pathPoint(t, s), hw = widthAt(t, s) / 2, el = t.lineAt('easy', s);
      const lat = R2() < 0.5 ? el + (R2() < 0.5 ? -1 : 1) * (0.8 + (R2() - 0.5) * 0.6) : (R2() * 2 - 1) * (hw - 0.4);
      const x = p.x - p.tz * lat, z = p.z + p.tx * lat;
      if (nearLedge(x, z)) continue;
      const k = R2();
      E.embedded(x, z, lerp(e.size[0], e.size[1], k), lerp(e.proud[0], e.proud[1], 0.3 * R2() + 0.7 * k));
    }
    for (let s = 6; s < t.length - 4; s += rl.rubble * (0.6 + R2() * 0.8)) {
      if (mud(s)) continue;
      const p = pathPoint(t, s), lat = (R2() < 0.5 ? -1 : 1) * (widthAt(t, s) / 2 + 0.7 + R2() * 3.2);
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

