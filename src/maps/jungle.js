// Coralume Island: a jungle-covered volcanic island in open sea. A paved coast road rings it and a
// paved mountain road switchbacks up to a summit viewpoint under the crater rim; graded dirt roads,
// a ridge track and a narrow two-track cut through the jungle; four rated crawls (cliff shelf,
// riverbed, basalt boulder field, a rock staircase to the rim); sand beaches and a bay with a
// dock. The sea is the map's edge: shallow surf drives, deep water recovers the truck to shore.
import { MAT, fbm, ridged, clamp, smooth, lerp, rng, catmull, arcLength, pathPoint, makeGrid, rockKit, lumps, potholes } from './common.js';

export const ID = 'jungle';
export const NAME = 'Coralume Island';
export const KIND = 'trails';
export const SIZE = 1024;
export const RES = 1024;
export const SEA = { y: 0 };

// ---------------------------------------------------------------- landform
const TAU = Math.PI * 2;
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const bell = (d, w) => (Math.abs(d) >= w ? 0 : (1 - (d / w) ** 2) ** 2);
const cosBell = (d, w) => (Math.abs(d) >= w ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * d) / w));
export const PEAK = { x: 30, z: -60 };       // centre of the crater
const RIDGE = { x1: -300, z1: 120 };          // the south-west ridge runs from the peak to here
const BAY_TH = 1.72;                          // Crescent Bay, south-south-west
// coastline radius by bearing (th = atan2(z, x): east 0, south +pi/2), tabulated
const NA = 2048, COAST = new Float32Array(NA), BEACH = new Float32Array(NA), CLIFF = new Float32Array(NA);
for (let i = 0; i < NA; i++) {
  const th = (i / NA) * TAU - Math.PI, c = Math.cos(th), s = Math.sin(th);
  let r = 392 + 24 * fbm(c * 1.3 + 4.1, s * 1.3 - 2.7, 3) + 9 * fbm(c * 4.2 + 9, s * 4.2 + 1, 2);
  r -= 88 * cosBell(wrapA(th - BAY_TH), 0.5) ** 0.8; // Crescent Bay
  r += 48 * bell(wrapA(th + 0.62), 0.2);      // Lava Point (north-east)
  r -= 26 * bell(wrapA(th - 2.85), 0.16);     // West Cove
  COAST[i] = r;
  // sand: the bay, the east beach and the west cove; cliffs: the north and north-west
  BEACH[i] = Math.max(smooth(0.6, 0.42, Math.abs(wrapA(th - BAY_TH))), smooth(0.46, 0.3, Math.abs(wrapA(th - 0.22))), smooth(0.24, 0.12, Math.abs(wrapA(th - 2.85))));
  CLIFF[i] = smooth(1.0, 0.55, Math.abs(wrapA(th + 1.75))) * (1 - BEACH[i]);
}
const tab = (T, th) => { const f = ((th + Math.PI) / TAU) * NA, i = Math.floor(f), t = f - i; return lerp(T[((i % NA) + NA) % NA], T[(((i + 1) % NA) + NA) % NA], t); };
export const coastR = (th) => tab(COAST, th);
export const beachW = (th) => tab(BEACH, th);
export const cliffW = (th) => tab(CLIFF, th);
// inland distance from the coastline (negative out to sea), measured along the radius
export function inland(x, z) { return coastR(Math.atan2(z, x)) - Math.hypot(x, z); }

function baseHeight(x, z) {
  const th = Math.atan2(z, x), c = coastR(th) - Math.hypot(x, z);
  const beach = beachW(th), cliff = cliffW(th);
  if (c < 0) {
    // sea floor: a wide shallow shelf off the beaches (drivable surf), a quick drop off the rocks
    const d = -c;
    return -0.12 - lerp(3.2 * smooth(0, 10, d), 1.25 * smooth(0, 34, d), beach) - 6 * smooth(26, 110, d) - 4 * smooth(110, 200, d);
  }
  // coastal strip: a beach ramp, or a cliff wall
  const cc = Math.min(c, 160);
  const ramp = -0.12 + Math.min(cc, 60) * lerp(0.07, 0.045, beach) + Math.max(0, cc - 60) * 0.02;
  const wall = -0.12 + (19 + 8 * fbm(x * 0.02, z * 0.02, 2)) * smooth(0, 15, c) * (1 - smooth(70, 200, c)) + cc * 0.03; // a cliff-top rim, not a plateau
  let h = lerp(ramp, wall, cliff);
  // the volcano: a concave cone with a crater rim, spurs and gullies running off it
  const rp = Math.hypot(x - PEAK.x, z - PEAK.z), ap = Math.atan2(z - PEAK.z, x - PEAK.x);
  const cone = 142 * Math.exp(-((rp / 200) ** 1.5)) * (1 - 0.7 * smooth(170, 320, rp));
  const crater = 27 * bell(rp, 38) - 6 * bell(rp - 33, 13);
  const spurs = (fbm(Math.cos(ap) * 2.6 + rp * 0.003, Math.sin(ap) * 2.6 - rp * 0.002, 3)) * 16 * smooth(35, 90, rp) * (1 - smooth(200, 330, rp));
  // the south-west ridge, a long spur the Ridge Track follows down to West Cove
  const rx = RIDGE.x1 - PEAK.x, rz = RIDGE.z1 - PEAK.z, rl = Math.hypot(rx, rz);
  const rt = clamp(((x - PEAK.x) * rx + (z - PEAK.z) * rz) / (rl * rl), 0, 1);
  const rdd = Math.hypot(x - PEAK.x - rx * rt, z - PEAK.z - rz * rt);
  const ridge = 12 * cosBell(rdd, 70) * smooth(0.45, 0.6, rt) * (1 - smooth(0.8, 1, rt));
  // rolling jungle hills (domain turned so the value-noise lattice doesn't show)
  const u = x * 0.8 + z * 0.6, v = -x * 0.6 + z * 0.8;
  const hills = (ridged(u * 0.0055 + 3.3, v * 0.0055 - 1.7, 4) * 30 - 10) * smooth(30, 160, c) * (0.45 + 0.55 * smooth(80, 220, rp)) * smooth(55, 120, rp); // (the cone keeps a clean top)
  const land = cone - crater + spurs + ridge + hills + fbm(u * 0.025, v * 0.025, 3) * 3.5 + fbm(u * 0.1, v * 0.1, 2) * 0.6;
  h += Math.max(0, land) * smooth(4, 120, c) * (1 - 0.6 * beach * (1 - smooth(20, 70, c)));
  return h;
}

// ---------------------------------------------------------------- Ember Creek
// A cascading mountain creek on the east flank: an upper creek, Ember Falls (an 8 m drop into a
// pool), then a steep rocky lower creek down to Sunrise Beach. bed: valley floor height along the
// creek; water: the surface of the low-flow channel cut into the floor.
const RIVER_CTRL = [[190, -134], [210, -120], [228, -106], [241, -95], [253, -85], [266, -71], [280, -53], [292, -33], [304, -11], [316, 11], [330, 31], [346, 46], [364, 56], [394, 62]];
export const RIVER = { pts: catmull(RIVER_CTRL, 2), bedW: 6, chanW: 2.4, chanD: 0.5, depth: 0.42 };
{
  const P = RIVER.pts, L = arcLength(P);
  RIVER.length = L;
  let fi = 0, fd = 1e9; // the falls: the point nearest the lip control point
  P.forEach((p, i) => { const d = Math.hypot(p.x - 241, p.z + 95); if (d < fd) { fd = d; fi = i; } });
  RIVER.fallsS = P[fi].s;
  const raw = P.map((p) => baseHeight(p.x, p.z));
  const sm = raw.map((_, i) => { let a = 0, n = 0; for (let k = -6; k <= 6; k++) { a += raw[clamp(i + k, 0, raw.length - 1)]; n++; } return a / n; });
  // lower creek: an even pitch from under the falls to the beach, never above the landform
  const top = Math.min(sm[fi] - 3, sm[0] - 4), pool = top - 8;
  const sEst = L - 46;
  let hb = sm[0] - 4;
  P.forEach((p, i) => {
    if (p.s <= RIVER.fallsS) hb = Math.min(lerp(sm[0] - 4, top, p.s / RIVER.fallsS), sm[i] - 2.5);
    else if (p.s < sEst) hb = Math.min(hb, lerp(pool, 0.35, (p.s - RIVER.fallsS) / (sEst - RIVER.fallsS)), sm[i] - 1.6);
    else hb = Math.min(hb, lerp(0.35, -1.4, smooth(sEst, L - 4, p.s)));
    p.h = hb;
    p.w = hb - RIVER.chanD + RIVER.depth; // water surface in the channel
  });
  RIVER.falls = { ...pathPoint({ pts: P }, RIVER.fallsS), top: P[fi].h, bottom: P[fi + 1].h };
}
const riverAt = (s) => pathPoint({ pts: RIVER.pts }, s);
// the plunge pool under the falls: a bowl in the creek floor
export const POOL = (() => { const p = riverAt(RIVER.fallsS + 8); return { x: p.x, z: p.z, r: 8.5, depth: 1.2, s: RIVER.fallsS + 8, w: p.h - RIVER.chanD + RIVER.depth }; })();

// valley walls at distance d from the creek, relative to its floor (the channel is cut later)
function valleyWall(d, x, z) {
  const bed = RIVER.bedW;
  return d < bed ? 0.1 * fbm(x * 0.3, z * 0.3, 2) : 0.62 * (d - bed) + 0.006 * (d - bed) ** 2;
}
const channelCut = (d) => RIVER.chanD * bell(d, RIVER.chanW);
// nearest point of the creek (brute force: path profiles and props only, the bake uses bins)
function riverNearest(x, z) {
  let best = 1e9, bs = 0;
  const P = RIVER.pts;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / L2, 0, 1), d = Math.hypot(x - a.x - ex * t, z - a.z - ez * t);
    if (d < best) { best = d; bs = lerp(a.s, b.s, t); }
  }
  return { d: best, s: bs };
}
function groundHeight(x, z) {
  let h = baseHeight(x, z);
  const r = riverNearest(x, z);
  if (r.d < 48) h = Math.min(h, riverAt(r.s).h + valleyWall(r.d, x, z));
  return h;
}

// ---------------------------------------------------------------- roads and trails
// A path: Catmull-Rom through control points, heights from the ground (smoothed, grade-limited),
// with fixed stretches (the path or pad each end joins: pads are flat across their core) eased in.
//   surface: 'paved' (asphalt), 'dirt' (graded jungle road), 'track' (rough two-track), 'sand'
//   fords: arc lengths where a road dips through the creek; mud: [[from, to]] fractions of length
//   steps: [{ s, rise, depth }] step-ups on a crawl (rock slabs; the ramp hides under the slab)
function profileFrom(pts, raw, win, maxG, fixed, closed) {
  const n = raw.length, isFix = (i) => !Number.isNaN(fixed[i]);
  const at = (i) => (closed ? raw[((i % (n - 1)) + (n - 1)) % (n - 1)] : raw[clamp(i, 0, n - 1)]);
  let hs = raw.map((_, i) => { let a = 0, c = 0; for (let k = -win; k <= win; k++) { a += at(i + k); c++; } return a / c; });
  const clampPasses = (passes) => {
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < n; i++) if (isFix(i)) hs[i] = fixed[i];
      for (let i = 1; i < n; i++) if (!isFix(i)) { const ds = pts[i].s - pts[i - 1].s; hs[i] = clamp(hs[i], hs[i - 1] - maxG * ds, hs[i - 1] + maxG * ds); }
      for (let i = n - 2; i >= 0; i--) if (!isFix(i)) { const ds = pts[i + 1].s - pts[i].s; hs[i] = clamp(hs[i], hs[i + 1] - maxG * ds, hs[i + 1] + maxG * ds); }
      if (closed) { const m = (hs[0] + hs[n - 1]) / 2; hs[0] = hs[n - 1] = m; }
    }
  };
  clampPasses(14);
  if (fixed.some((v) => !Number.isNaN(v))) {
    // ease into every fixed stretch (pinned ends, pads) over 15 m, then clamp the grade again
    const near = hs.map((_, i) => { let best = null; for (let j = 0; j < n; j++) if (isFix(j)) { const d = Math.abs(pts[j].s - pts[i].s); if (!best || d < best.d) best = { d, h: fixed[j] }; } return best; });
    hs = hs.map((h, i) => lerp(near[i].h, h, smooth(0, 15, near[i].d)));
    clampPasses(8);
  }
  return hs;
}

const BUILT = []; // paths built so far (junction pins look these up)
function nearestOnPaths(x, z) {
  let best = null;
  for (const p of BUILT) for (const q of p.pts) { const d = Math.hypot(q.x - x, q.z - z); if (!best || d < best.d) best = { d, h: q.h, path: p }; }
  return best;
}
const TRAIL_GRADE = { green: 0.22, blue: 0.3, black: 0.34, dblack: 0.36 };
function buildPath(def) {
  const isRoad = def.kind === 'road';
  let pts = catmull(def.pts, isRoad ? 2 : 1, !!def.closed);
  if (!isRoad) {
    // a crawl starts / ends at the edge of the road it leaves, not on its centre line (its gates
    // stand 3 m in from each end and must not span the road)
    const onRoad = (q) => BUILT.some((r) => r.kind === 'road' && r.pts.some((t) => Math.hypot(t.x - q.x, t.z - q.z) < r.width / 2 + 0.8));
    while (pts.length > 4 && onRoad(pts[1])) pts.shift();
    while (pts.length > 4 && onRoad(pts.at(-2))) pts.pop();
  }
  const L = arcLength(pts);
  const raw = pts.map((p) => groundHeight(p.x, p.z));
  const fixed = new Float32Array(pts.length).fill(NaN);
  if (!def.closed) for (const end of [0, 1]) {
    const p = end ? pts.at(-1) : pts[0], want = end ? def.end : def.start;
    if (typeof want === 'number') fixed[end ? pts.length - 1 : 0] = want;
    else if (want && want.pad) pts.forEach((q, i) => { if (Math.hypot(q.x - want.pad.x, q.z - want.pad.z) < want.pad.r + 1) fixed[i] = want.pad.h; });
    else if (want !== 'free') {
      // joined to another path: every point still on the host's tread takes the host's height there,
      // so the host keeps its own profile through the junction (no hump in the main road)
      const j = nearestOnPaths(p.x, p.z);
      if (j && j.d < 14) {
        fixed[end ? pts.length - 1 : 0] = j.h;
        for (let k = 0; k < pts.length; k++) {
          const i = end ? pts.length - 1 - k : k, q = nearestOnPaths(pts[i].x, pts[i].z);
          if (!q || q.path !== j.path || q.d > j.path.width / 2 + 1.5) break;
          fixed[i] = q.h;
        }
      }
    }
  }
  const maxG = def.maxGrade ?? (isRoad ? (def.surface === 'paved' ? 0.1 : 0.16) : TRAIL_GRADE[def.diff]);
  const win = def.win ?? (isRoad ? (def.surface === 'paved' ? 12 : 8) : 8);
  let hs = profileFrom(pts, raw, win, maxG, fixed, !!def.closed);
  if (def.minH !== undefined) hs = hs.map((h, i) => (Number.isNaN(fixed[i]) ? Math.max(h, def.minH) : h)); // (kept above the sea)
  // fords: the road dips to the creek floor, grade-limited approaches either side ('auto': where
  // the road passes closest to the creek)
  if (def.fords === 'auto') { let b = null; for (const q of pts) { const d = riverNearest(q.x, q.z).d; if (!b || d < b.d) b = { d, s: q.s }; } def = { ...def, fords: [b.s] }; }
  for (const sF of def.fords || []) {
    const q = pathPoint({ pts }, sF), r = riverAt(riverNearest(q.x, q.z).s), hf = r.h - 0.02;
    hs = hs.map((h, i) => { const d = Math.max(0, Math.abs(pts[i].s - sF) - 5.5); return Math.min(h, hf + d * 0.095); });
  }
  // step-ups: the smooth part climbs less, each step adds its rise over its slab
  if (def.steps) {
    const total = def.steps.reduce((a, st) => a + st.rise, 0);
    hs = hs.map((h, i) => {
      const s = pts[i].s;
      let up = 0;
      for (const st of def.steps) up += st.rise * clamp((s - st.s) / st.depth, 0, 1);
      return h - total * smooth(def.steps[0].s - 10, def.steps.at(-1).s + def.steps.at(-1).depth + 10, s) + up;
    });
  }
  pts.forEach((p, i) => { p.h = hs[i]; });
  const width = def.width ?? (isRoad ? ({ paved: 7.5, dirt: 6, track: 4.4, sand: 6 })[def.surface] : 5.4);
  const path = { ...def, kind: def.kind, pts, length: L, width, shoulder: def.shoulder ?? (isRoad ? (def.surface === 'paved' ? 7 : 5) : 3.5), bridges: [] };
  BUILT.push(path);
  return path;
}

// --- the coast road: a loop a little inland of the shore, on the cliff tops in the north
function coastCtrl() {
  const out = [], N = 44;
  for (let i = 0; i < N; i++) {
    const th = -Math.PI + (i / N) * TAU;
    let rs = 0; for (let k = -6; k <= 6; k++) rs += coastR(th + k * 0.06);
    rs /= 13;
    const cl = cliffW(th), r = Math.min(rs - lerp(64, 44, cl), coastR(th) - lerp(42, 30, cl));
    out.push([Math.cos(th) * r, Math.sin(th) * r]);
  }
  return out;
}
const COAST_ROAD = buildPath({ name: 'Coast Road', kind: 'road', surface: 'paved', closed: true, pts: coastCtrl(), width: 8, maxGrade: 0.085, win: 14 });

// the coast road point nearest a bearing (from the island centre), with its inland normal
function coastAt(th) {
  let best = null;
  for (const p of COAST_ROAD.pts) { const d = Math.abs(wrapA(Math.atan2(p.z, p.x) - th)); if (!best || d < best.d) best = { d, p }; }
  const q = pathPoint(COAST_ROAD, best.p.s), r = Math.hypot(q.x, q.z);
  let nx = -q.tz, nz = q.tx;
  if (nx * q.x + nz * q.z > 0) { nx = -nx; nz = -nz; } // point inland
  return { ...q, s: best.p.s, nx, nz, r };
}
const polar = (rp, ap) => [PEAK.x + Math.cos(ap) * rp, PEAK.z + Math.sin(ap) * rp];
const shore = (th, inset) => { const r = coastR(th) - inset; return [Math.cos(th) * r, Math.sin(th) * r]; };
const fromCoast = (th) => { const q = coastAt(th); return [q.x, q.z]; };

// ---------------------------------------------------------------- pads (flat lots)
// h: the lot's level; blend: metres over which the ground eases back to the landform
export const PADS = [];
const VQ = coastAt(1.62);
export const VILLAGE = { name: 'Palm Cove', x: VQ.x + VQ.nx * 25, z: VQ.z + VQ.nz * 25, r: 20, h: VQ.h, blend: 22, mat: 'paved' };
PADS.push(VILLAGE);
// the summit viewpoint lot, high on the south-west flank under the crater rim
const SL = polar(78, 2.1);
export const SUMMIT_LOT = { name: 'Summit Viewpoint', x: SL[0], z: SL[1], r: 15, h: baseHeight(SL[0], SL[1]), blend: 9, mat: 'paved' };
PADS.push(SUMMIT_LOT);
// the crater rim: a small gravel pad on the crest where the Ember Stairs top out
const RP = polar(35, -2.86);
export const RIM = { name: 'Crater Rim', x: RP[0], z: RP[1], r: 9, h: baseHeight(RP[0], RP[1]) + 0.4, blend: 7, mat: 'gravel' };
PADS.push(RIM);
// Lava Point: the lighthouse lot at the tip of the old lava flow
const LP = shore(-0.6, 34);
export const LIGHTHOUSE = { name: 'Lava Point Light', x: LP[0], z: LP[1], r: 11, h: 0, blend: 9, mat: 'gravel' };
{ // a terrace at the lane's reach: no steeper than 14% down from the coast road
  const q = coastAt(-0.58);
  LIGHTHOUSE.h = Math.max(baseHeight(LP[0], LP[1]), q.h - 0.14 * (Math.hypot(q.x - LP[0], q.z - LP[1]) - LIGHTHOUSE.r));
}
PADS.push(LIGHTHOUSE);
// Ridge Lookout: a gravel turnout on the crest of the south-west ridge
const RL = [30 - 0.878 * 262, -60 + 0.479 * 262];
export const RIDGE_LOOKOUT = { name: 'Ridge Lookout', x: RL[0], z: RL[1], r: 10, h: baseHeight(RL[0], RL[1]), blend: 9, mat: 'gravel' };
PADS.push(RIDGE_LOOKOUT);

// --- Ember Pass Road: paved, from the coast road by Palm Cove up the south flank in hairpins
const MS = coastAt(1.47);
// control points as [radius, bearing] round the peak: a long climb east, a long traverse west,
// back east under the summit, and a last leg to the lot (legs fanning out between hairpins)
const MTN_PTS = [
  [304, 1.5], [286, 1.33], [270, 1.14], [258, 0.96], [250, 0.82], [244, 0.72],                                         // hairpin 1
  [228, 0.8], [222, 1.02], [214, 1.28], [206, 1.54], [198, 1.8], [190, 2.06], [182, 2.32], [174, 2.56], [166, 2.76], [158, 2.9], // hairpin 2 (on the ridge)
  [144, 2.84], [138, 2.62], [134, 2.4], [128, 2.16], [123, 1.9], [118, 1.62], [113, 1.34], [108, 1.1], [104, 0.86], [100, 0.66], [95, 0.56], // hairpin 3
  [85, 0.66], [85, 0.86], [85, 1.06], [84, 1.32], [83, 1.58], [82, 1.82],
];
const MOUNTAIN = buildPath({
  name: 'Ember Pass Road', kind: 'road', surface: 'paved', width: 7.5, maxGrade: 0.11, win: 6, shoulder: 20, start: MS.h, end: { pad: SUMMIT_LOT },
  pts: [[MS.x, MS.z], ...MTN_PTS.map(([r, a]) => polar(r, a)), [SUMMIT_LOT.x, SUMMIT_LOT.z]],
});
// --- Plantation Road: graded dirt from the coast road at Lava Point, past Ember Falls (a ford
// just below the pool) and up through the jungle to the mountain road's first hairpin
const PL0 = coastAt(-0.66);
const PLANTATION = buildPath({
  name: 'Plantation Road', kind: 'road', surface: 'dirt', width: 6, maxGrade: 0.18, win: 5, shoulder: 8,
  pts: [[PL0.x, PL0.z], [272, -184], [268, -160], [268, -134], [270, -108], [270, -84], [272, -62], [266, -36], [266, -10], [258, 14], [247, 38], [241, 62], [236, 84], polar(250, 0.8)],
  mud: [[0.22, 0.29], [0.76, 0.83]], fords: 'auto',
});
// --- Lighthouse Lane: a short gravelled lane out to the lighthouse on Lava Point
const LL0 = coastAt(-0.58);
const LIGHT_LANE = buildPath({ name: 'Lighthouse Lane', kind: 'road', surface: 'dirt', width: 5.5, pts: [[LL0.x, LL0.z], [(LL0.x + LIGHTHOUSE.x) / 2 + 4, (LL0.z + LIGHTHOUSE.z) / 2 - 6], [LIGHTHOUSE.x, LIGHTHOUSE.z]], end: { pad: LIGHTHOUSE } });
// --- Fern Gully: a narrow two-track along the north-east flank to the north coast road
const FG1 = coastAt(-1.08);
const FERN = buildPath({
  name: 'Fern Gully Track', kind: 'road', surface: 'track', maxGrade: 0.22, win: 4, shoulder: 7,
  pts: [[268, -170], [254, -194], [238, -218], [222, -240], [204, -258], [186, -272], [172, -286], [FG1.x, FG1.z]],
  mud: [[0.3, 0.36]],
});
// --- Ridge Track: dirt, from the coast road at West Cove up the nose of the south-west ridge to a
// lookout over the cove and the bay
const RT1 = coastAt(2.62);
const RIDGE_TRACK = buildPath({
  name: 'Ridge Track', kind: 'road', surface: 'dirt', maxGrade: 0.18, win: 5, start: RT1.h, end: { pad: RIDGE_LOOKOUT },
  pts: [[RT1.x, RT1.z], [-266, 150], [-240, 150], [-232, 130], [-252, 114], [-246, 94], [-222, 84], [RIDGE_LOOKOUT.x, RIDGE_LOOKOUT.z]],
});
// --- beaches: sand tracks along Crescent Bay and Sunrise Beach, and the accesses down to them
const bayPts = [];
for (let th = BAY_TH - 0.42; th <= BAY_TH + 0.34; th += 0.06) bayPts.push(shore(th, 15));
const BAY_BEACH = buildPath({ name: 'Crescent Beach', kind: 'road', surface: 'sand', width: 7, maxGrade: 0.12, win: 6, pts: bayPts, start: 'free', end: 'free', shoulder: 4 });
const BA0 = coastAt(1.72);
const BAY_ACCESS = buildPath({ name: 'Beach Access', kind: 'road', surface: 'sand', width: 6, maxGrade: 0.16, pts: [[BA0.x, BA0.z], shore(1.74, 26)], end: 'free' });
const sunPts = [];
for (let th = -0.16; th <= 0.56; th += 0.05) sunPts.push(shore(th, 14));
const SUN_BEACH = buildPath({ name: 'Sunrise Beach', kind: 'road', surface: 'sand', width: 7, maxGrade: 0.12, win: 6, pts: sunPts, start: 'free', end: 'free', shoulder: 4 });
const SA0 = coastAt(0.43);
const SUN_ACCESS = buildPath({ name: 'Sunrise Access', kind: 'road', surface: 'sand', width: 6, maxGrade: 0.16, pts: [[SA0.x, SA0.z], shore(0.42, 22)], end: 'free' });
const WC0 = coastAt(2.86);
const COVE_ACCESS = buildPath({ name: 'West Cove Access', kind: 'road', surface: 'sand', width: 6, maxGrade: 0.16, pts: [[WC0.x, WC0.z], shore(2.86, 14)], end: 'free' });

export const ROADS = [COAST_ROAD, MOUNTAIN, PLANTATION, LIGHT_LANE, FERN, RIDGE_TRACK, BAY_BEACH, BAY_ACCESS, SUN_BEACH, SUN_ACCESS, COVE_ACCESS];

// ---------------------------------------------------------------- crawls
// Cliffside Ledge (green): a shelf cut into the north sea cliffs, below the coast road
const ledgePts = [fromCoast(-2.34)];
for (let th = -2.27; th <= -1.42; th += 0.07) ledgePts.push(shore(th, 11 + 3 * Math.sin(th * 9)));
{ const q = coastAt(-1.36); ledgePts.push([q.x - q.nx * 13, q.z - q.nz * 13], [q.x, q.z]); } // (meets the road square on)
// Riverbed Run (blue): up the rocky lower creek from the coast road bridge to the Plantation ford
function riverbedPts() {
  // from the coast road just upstream of its bridge (the deck is too low to drive under) down
  // into the creek bed, then up it to the Plantation ford
  let x = null; for (const q of COAST_ROAD.pts) { const d = riverNearest(q.x, q.z); if (!x || d.d < x.d) x = { d: d.d, s: q.s, rs: d.s }; }
  const fallsP = riverAt(RIVER.fallsS), c0 = [pathPoint(COAST_ROAD, x.s - 52), pathPoint(COAST_ROAD, x.s + 52)]
    .sort((a, b) => Math.hypot(a.x - fallsP.x, a.z - fallsP.z) - Math.hypot(b.x - fallsP.x, b.z - fallsP.z))[0];
  const out = [[c0.x, c0.z]], cs = x.rs + 2, mid = riverAt(x.rs - 8);
  out.push([(c0.x + mid.x) / 2, (c0.z + mid.z) / 2]);
  // it climbs out of the bed onto the ford's approach on the near bank (a dry, gentle spot)
  const fs = PLANTATION.fords[0], ends = [pathPoint(PLANTATION, fs - 15), pathPoint(PLANTATION, fs + 15)];
  const fordS = riverNearest(...ends.map((e) => [e.x, e.z])[0]).s;
  let k = 0;
  for (let s = cs - 22; s > fordS + 6; s -= 10, k++) {
    const p = riverAt(s), off = (k % 2 ? 1 : -1) * 4.4 * smooth(0, 10, cs - 22 - s); // (weaving across the bed, over the channel)
    out.push([p.x - p.tz * off, p.z + p.tx * off]);
  }
  // ... through the Plantation ford, on up the bed to the plunge pool under Ember Falls, and out up
  // the bank onto Plantation Road north of the ford
  const fordRS = riverNearest(...(() => { const q = pathPoint(PLANTATION, fs); return [q.x, q.z]; })()).s;
  for (const [s, off] of [[fordRS + 4, 1.5], [fordRS - 6, -1.5], [POOL.s + 3, 4]]) { const p = riverAt(s); out.push([p.x - p.tz * off, p.z + p.tx * off]); }
  const ex = [pathPoint(PLANTATION, fs - 35), pathPoint(PLANTATION, fs + 35)]
    .sort((a, b) => Math.hypot(a.x - POOL.x, a.z - POOL.z) - Math.hypot(b.x - POOL.x, b.z - POOL.z))[0];
  out.push([(POOL.x + ex.x) / 2 + 2, (POOL.z + ex.z) / 2], [ex.x, ex.z]);
  return out;
}
// Basalt Garden (black): round the jagged shore of Lava Point to the lighthouse
const BG0 = coastAt(-0.42);
// Ember Stairs (double black): a spiral rock staircase from the summit lot to the crater rim
const STAIR_PTS = [[SUMMIT_LOT.x, SUMMIT_LOT.z], polar(77, 2.4), polar(72, 2.66), polar(66, 2.9), polar(59, 3.12), polar(52, -2.95), polar(45, -2.82), [RIM.x, RIM.z]];
export const TRAILS = [
  buildPath({ name: 'Cliffside Ledge', kind: 'trail', diff: 'green', pts: ledgePts, width: 5.8, camber: 0.05, mat: 'dirt' }),
  buildPath({ name: 'Riverbed Run', kind: 'trail', diff: 'blue', pts: riverbedPts(), width: 5.4, mat: 'river', win: 2, maxGrade: 0.26 }),
  buildPath({ name: 'Basalt Garden', kind: 'trail', diff: 'black', width: 5.4, mat: 'basalt',
    pts: [[BG0.x, BG0.z], [332, -154], [350, -172], [364, -196], [370, -222], [362, -244], [348, -254], [LIGHTHOUSE.x, LIGHTHOUSE.z]], end: { pad: LIGHTHOUSE }, minH: 2.2, maxGrade: 0.27 }),
  buildPath({ name: 'Ember Stairs', kind: 'trail', diff: 'dblack', width: 5.6, mat: 'rock', pts: STAIR_PTS, start: { pad: SUMMIT_LOT }, end: { pad: RIM }, win: 4, maxGrade: 0.3,
    steps: [24, 31, 38, 52, 59, 66, 80, 86.5, 93].map((s, k) => ({ s, rise: [0.32, 0.36, 0.4, 0.4, 0.42, 0.44, 0.44, 0.45, 0.45][k], depth: 3.0 })) }),
];
const PATHS = [...ROADS, ...TRAILS];

// ---------------------------------------------------------------- bridges
// Where a road crosses the creek above its floor, a deck carries it (box colliders in PROPS) and the
// bake leaves the creek under it.
for (const r of ROADS) {
  if (r.surface === 'sand' || r.fords) continue;
  let run = null;
  for (const q of r.pts) {
    const rn = riverNearest(q.x, q.z);
    const low = rn.d < 16 && groundHeight(q.x, q.z) < q.h - 0.6;
    if (low && !run) run = { s0: q.s, s1: q.s };
    else if (low) run.s1 = q.s;
    else if (run) { r.bridges.push({ s0: run.s0 - 3, s1: run.s1 + 3 }); run = null; }
  }
}
const onBridge = (p, s) => p.bridges.some((b) => s > b.s0 && s < b.s1);

// superelevation on the paved roads: the outside of a bend is raised (up to 6%), eased along
for (const p of PATHS) {
  const P = p.pts, n = P.length;
  P.forEach((q, i) => {
    if (p.surface !== 'paved') { q.bank = 0; return; }
    const a = P[Math.max(0, i - 4)], b = P[Math.min(n - 1, i + 4)], c0 = P[Math.max(0, i - 1)], c1 = P[Math.min(n - 1, i + 1)];
    let d = Math.atan2(b.x - q.x, b.z - q.z) - Math.atan2(q.x - a.x, q.z - a.z);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const k = d / Math.max(1, (b.s - a.s) / 2);
    q.bank = clamp(k * 6, -0.06, 0.06) * (c0 && c1 ? 1 : 0);
  });
  // level across bridge decks (a box deck has no camber) and eased back in over 15 m either side
  for (const q of P) for (const b of p.bridges || []) q.bank *= 1 - smooth(b.s0 - 18, b.s0 - 3, q.s) * smooth(b.s1 + 18, b.s1 + 3, q.s);
  for (let pass = 0; pass < 3; pass++) for (let i = 1; i < n - 1; i++) P[i].bank = (P[i - 1].bank + 2 * P[i].bank + P[i + 1].bank) / 4;
}

// ---------------------------------------------------------------- baked grid
const grid = makeGrid(SIZE, RES);
const { N1, CELL } = grid;
export const { GRID, heightAt, visualHeightAt, materialAt } = grid;

// ground relief on the crawls by difficulty (the terms of maps/trailpark.js RELIEF)
const RELIEF = {
  green:  { lumps: 0.05, ruts: 0.05, holes: [9, 0.25, 0.08, 1.0], embed: { every: 3.2, size: [0.3, 0.6], proud: [0.05, 0.12] }, rubble: 5 },
  blue:   { lumps: 0.1, ruts: 0, holes: [8, 0.3, 0.12, 1.0], embed: { every: 1.8, size: [0.35, 0.85], proud: [0.07, 0.18] }, rubble: 2.5 },
  black:  { lumps: 0.13, ruts: 0, holes: [7, 0.3, 0.14, 1.0], embed: { every: 1.4, size: [0.4, 1.0], proud: [0.1, 0.25] }, rubble: 2.2 },
  dblack: { lumps: 0.1, ruts: 0, holes: [7, 0.3, 0.12, 1.0], embed: { every: 1.6, size: [0.4, 1.0], proud: [0.1, 0.22] }, rubble: 2.2 },
};
const bump = (d, r) => (d >= r ? 0 : (1 - (d / r) ** 2) ** 2);
const MUD_SINK_J = 0.3, MUD_RUTS = 0.06; // (old ruts baked into the floor; src/mud.js adds the live ones)
// basalt: the old lava flow round Lava Point (dark rock, boulder fields)
export const BASALT = { x: 330, z: -215, r: 120 };
const inBasalt = (x, z) => Math.hypot(x - BASALT.x, z - BASALT.z) < BASALT.r - 12 * fbm(x * 0.03, z * 0.03, 2);

function bake() {
  const B = 8, nb = Math.ceil(SIZE / B);
  const bins = Array.from({ length: nb * nb }, () => []);
  const binSeg = (pts, reach, id) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const x0 = Math.floor((Math.min(a.x, b.x) - reach + SIZE / 2) / B), x1 = Math.floor((Math.max(a.x, b.x) + reach + SIZE / 2) / B);
      const z0 = Math.floor((Math.min(a.z, b.z) - reach + SIZE / 2) / B), z1 = Math.floor((Math.max(a.z, b.z) + reach + SIZE / 2) / B);
      for (let bx = Math.max(0, x0); bx <= Math.min(nb - 1, x1); bx++) for (let bz = Math.max(0, z0); bz <= Math.min(nb - 1, z1); bz++) bins[bx * nb + bz].push(id, i);
    }
  };
  PATHS.forEach((p, pi) => binSeg(p.pts, p.width / 2 + p.shoulder + 1, pi));
  binSeg(RIVER.pts, 48, -1);
  // nearest segment of every path in reach of the vertex (flat arrays: no per-vertex allocation)
  const NP = PATHS.length, stamp = new Int32Array(NP).fill(-1), touched = [];
  const cD = new Float64Array(NP), cLat = new Float64Array(NP), cS = new Float64Array(NP), cH = new Float64Array(NP), cBank = new Float64Array(NP);
  let vid = 0;
  for (let ix = 0; ix <= RES; ix++) {
    const x = -SIZE / 2 + ix * CELL;
    for (let iz = 0; iz <= RES; iz++) {
      const z = -SIZE / 2 + iz * CELL, idx = ix * N1 + iz;
      const th = Math.atan2(z, x), c = coastR(th) - Math.hypot(x, z), beach = beachW(th);
      let h = baseHeight(x, z) + lumps(x, z, 0.12) * smooth(10, 40, c) * (1 - 0.7 * beach);
      const bin = bins[Math.floor((x + SIZE / 2) / B) * nb + Math.floor((z + SIZE / 2) / B)] || [];
      // the creek valley
      let rd = 1e9, rs = 0;
      for (let k = 0; k < bin.length; k += 2) {
        if (bin[k] !== -1) continue;
        const P = RIVER.pts, i = bin[k + 1], a = P[i - 1], b = P[i], ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
        const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / L2, 0, 1), d = Math.hypot(x - a.x - ex * t, z - a.z - ez * t);
        if (d < rd) { rd = d; rs = lerp(a.s, b.s, t); }
      }
      const rv = rd < 48 ? riverAt(rs) : null;
      if (rv) h = Math.min(h, rv.h + valleyWall(rd, x, z));
      let mat = h < SEA.y + 0.02 ? MAT.WATER : beach > 0.3 && c < 42 && h < 2.6 ? MAT.SAND : MAT.GRASS;
      let tone = 0;
      // pads
      let padCore = false;
      for (const p of PADS) {
        const d = Math.hypot(x - p.x, z - p.z);
        if (d > p.r + p.blend) continue;
        h = lerp(h, p.h + fbm(x * 0.2, z * 0.2, 2) * 0.04, 1 - smooth(p.r, p.r + p.blend, d));
        if (d < p.r + 1) { padCore = true; mat = p.mat === 'paved' ? MAT.TARMAC : MAT.GRAVEL; }
      }
      // paths
      vid++; touched.length = 0;
      for (let k = 0; k < bin.length; k += 2) {
        const pi = bin[k];
        if (pi < 0) continue;
        const p = PATHS[pi], i = bin[k + 1], a = p.pts[i - 1], b = p.pts[i];
        const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
        let t = ((x - a.x) * ex + (z - a.z) * ez) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = x - a.x - ex * t, dz = z - a.z - ez * t, d = Math.sqrt(dx * dx + dz * dz);
        if (d > p.width / 2 + p.shoulder) continue;
        if (stamp[pi] !== vid) { stamp[pi] = vid; cD[pi] = Infinity; touched.push(pi); }
        if (d < cD[pi]) {
          cD[pi] = d; cLat[pi] = ((x - a.x) * -ez + (z - a.z) * ex) / Math.sqrt(L2);
          cS[pi] = a.s + (b.s - a.s) * t; cH[pi] = a.h + (b.h - a.h) * t; cBank[pi] = a.bank + (b.bank - a.bank) * t;
        }
      }
      let best = null;
      for (const pi of touched) { const score = cD[pi] - (PATHS[pi].kind === 'road' ? 1.5 : 0); if (!best || score < best.score) best = { d: cD[pi], pi, lat: cLat[pi], s: cS[pi], ph: cH[pi], score }; }
      let pathId = -1, sink = 0, vRut = 0;
      if (best) {
        let num = 0, den = 0, W = 0, under = Infinity;
        for (const pi of touched) {
          const cc = { d: cD[pi], pi, lat: cLat[pi], s: cS[pi], ph: cH[pi], bank: cBank[pi] };
          const q = PATHS[cc.pi], qhw = q.width / 2;
          // the creek stays under a bridge deck, and nothing under it may reach up to the planks
          if (q.bridges.length && onBridge(q, cc.s)) { if (cc.d < qhw + 0.8) under = Math.min(under, cc.ph - 0.3); continue; }
          const w = 1 - smooth(qhw, qhw + q.shoulder, cc.d);
          if (w <= 0) continue;
          let surf = cc.ph;
          const lat = clamp(cc.lat, -qhw - 0.5, qhw + 0.5);
          // under a muddy dip the firm floor is smooth (the shared mud field, src/mud.js, makes the ruts)
          const calm = q.mud ? 1 - Math.max(...q.mud.map(([a, b]) => smooth(a - 0.03, a, cc.s / q.length) * smooth(b + 0.03, b, cc.s / q.length))) : 1;
          if (q.kind === 'road') {
            if (q.surface === 'paved') {
              surf -= Math.min(1, cc.d / qhw) ** 2 * 0.07 - lat * cc.bank;     // crown, superelevation
              surf += lumps(x, z, 0.008);
            } else if (q.surface === 'dirt') {
              surf -= Math.min(1, cc.d / qhw) ** 2 * 0.1;
              surf += (0.018 * Math.sin(cc.s * 2.24) * (0.6 + 0.8 * fbm(x * 0.05, z * 0.05, 2)) + lumps(x, z, 0.04) + potholes(x, z, 10, 0.32, 0.09, 1.2, cc.pi * 7)) * calm;
              surf -= 0.05 * (bump(Math.abs(cc.lat - 0.85), 0.6) + bump(Math.abs(cc.lat + 0.85), 0.6)) * calm;
            } else if (q.surface === 'track') {
              surf += (lumps(x, z, 0.07) + potholes(x, z, 8, 0.35, 0.11, 1.0, cc.pi * 7) + 0.05 * bump(Math.abs(cc.lat), 0.5)) * calm;
              surf -= calm * 0.11 * (0.7 + 0.6 * fbm(x * 0.11 - 4, z * 0.11 + 8, 2)) * (bump(Math.abs(cc.lat - 0.85), 0.6) + bump(Math.abs(cc.lat + 0.85), 0.6));
            } else surf += lumps(x, z, 0.025); // sand
          } else {
            const ends = smooth(0, 12, Math.min(cc.s, q.length - cc.s)), rl = RELIEF[q.diff];
            const rough = { green: 0.14, blue: 0.22, black: 0.28, dblack: 0.16 }[q.diff];
            surf += fbm(x * 0.45, z * 0.45, 2) * rough * ends + lumps(x, z, rl.lumps) * ends;
            if (rl.ruts) surf -= rl.ruts * (0.65 + 0.7 * fbm(x * 0.11 - 4, z * 0.11 + 8, 2)) * (bump(Math.abs(cc.lat - 0.82), 0.62) + bump(Math.abs(cc.lat + 0.82), 0.62)) * ends;
            surf += potholes(x, z, rl.holes[0], rl.holes[1], rl.holes[2], rl.holes[3], cc.pi * 17) * ends;
            if (q.camber) surf += lat * q.camber * Math.sin(cc.s * 0.05) * ends;
            if (q.diff === 'black') surf += lat * 0.15 * Math.sin(cc.s * 0.045) * ends;
          }
          const ww = w * w * (q.kind === 'road' ? 2 : 1);
          num += surf * ww; den += ww; W = Math.max(W, w);
        }
        if (den > 0) h = lerp(h, num / den, padCore ? 0 : W);
        h = Math.min(h, under);
        const p = PATHS[best.pi], hw = p.width / 2;
        if (best.d < hw + 0.5 && !padCore) {
          pathId = best.pi;
          const n = fbm(x * 0.08 + 9, z * 0.08 - 4, 3), f = best.s / p.length;
          const bridged = p.bridges.length && onBridge(p, best.s);
          if (bridged) { /* the deck is a collider; the ground below keeps its creek look */ }
          else if (p.surface === 'paved') mat = Math.abs(best.lat) < hw - 0.45 ? MAT.TARMAC : MAT.GRAVEL;
          else if (p.surface === 'sand') mat = MAT.SAND;
          else if (p.kind === 'road') {
            mat = p.surface === 'track' && Math.abs(best.lat) < 0.42 ? MAT.GRASS : n > 0.32 ? MAT.GRAVEL : MAT.DIRT;
            // wet jungle earth: a step darker all over, the wheel ruts darker again
            tone = Math.round(clamp(0.3 + (bump(Math.abs(best.lat - 0.85), 0.6) + bump(Math.abs(best.lat + 0.85), 0.6)) * (p.surface === 'track' ? 0.6 : 0.35), 0, 1) * 255);
            if (p.mud && p.mud.some(([a, b]) => f > a && f < b)) {
              const [a, b] = p.mud.find(([a, b]) => f > a && f < b);
              const ease = smooth(a, a + 0.02, f) * smooth(b, b - 0.02, f);
              const depth = MUD_SINK_J * (1 + 0.15 * fbm(x * 0.16 + 3, z * 0.16 - 7, 2)) * ease;
              mat = MAT.MUD; sink = depth * smooth(hw + 0.5, hw - 1, best.d); h -= sink;
              const k = 0.6 + 0.8 * clamp(fbm(x * 0.13 + 1, z * 0.13 + 5, 2) + 0.5, 0, 1);
              const ruts = bump(Math.abs(best.lat - 0.85), 0.7) + bump(Math.abs(best.lat + 0.85), 0.7);
              h -= MUD_RUTS * k * ease * ruts;
              vRut = MUD_RUTS * k * ease * ruts * 0.4;
              tone = Math.round(clamp(0.35 + ruts * k * 0.6, 0, 1) * 255 * ease);
            }
          } else {
            const ends = smooth(0, 12, Math.min(best.s, p.length - best.s));
            if (p.mat === 'dirt') mat = n > 0.3 ? MAT.GRAVEL : MAT.DIRT;
            else if (p.mat === 'river') mat = n > 0.4 ? MAT.GRAVEL : MAT.ROCK;
            else if (p.mat === 'basalt') { mat = n > 0.45 ? MAT.GRAVEL : MAT.ROCK; tone = Math.round(150 * ends); }
            else mat = n > 0.4 ? MAT.GRAVEL : MAT.ROCK;
            if (RELIEF[p.diff].ruts) tone = Math.max(tone, Math.round(clamp((bump(Math.abs(best.lat - 0.82), 0.62) + bump(Math.abs(best.lat + 0.82), 0.62)) * 0.55, 0, 1) * 255 * ends));
          }
        }
      }
      // the low-flow channel cuts through everything, fords and crawl treads included; the pool
      let water = -1e9;
      if (rv) {
        // (on a crawl tread the channel is a shallow dip cut into the tread itself, never a trench)
        if (rd < RIVER.chanW) h = Math.min(h, pathId >= ROADS.length ? h - 0.45 * channelCut(rd) : rv.h - channelCut(rd));
        if (rd < RIVER.chanW + 1.2) water = rv.w;
        if (rd < RIVER.bedW && mat === MAT.GRASS) mat = rd < 4 ? MAT.GRAVEL : MAT.ROCK;
      }
      const dp = Math.hypot(x - POOL.x, z - POOL.z);
      if (dp < POOL.r + 2) { h = Math.min(h, riverAt(POOL.s).h - POOL.depth * cosBell(dp, POOL.r)); if (dp < POOL.r) water = Math.max(water, POOL.w); }
      if (water > h) { mat = MAT.WATER; tone = 0; }
      else if (h < SEA.y + 0.02) { mat = MAT.WATER; tone = 0; }
      else if (mat === MAT.SAND && h < 0.42 && c < 60) tone = Math.max(tone, Math.round(200 * smooth(0.42, 0.12, h))); // wet sand at the waterline
      GRID.h[idx] = h; GRID.vis[idx] = h + sink + vRut; GRID.mat[idx] = mat; GRID.path[idx] = pathId; GRID.tone[idx] = tone;
    }
  }
  // off the paths the ground follows the slope: bare rock on cliffs and the lava flow, scree, earth
  for (let ix = 1; ix < RES; ix++) for (let iz = 1; iz < RES; iz++) {
    const idx = ix * N1 + iz, m = GRID.mat[idx];
    if (GRID.path[idx] >= 0 || (m !== MAT.GRASS && m !== MAT.DIRT && m !== MAT.SAND)) continue;
    const slope = Math.hypot(GRID.h[idx + N1] - GRID.h[idx - N1], GRID.h[idx + 1] - GRID.h[idx - 1]) / (2 * CELL);
    const x = -SIZE / 2 + ix * CELL, z = -SIZE / 2 + iz * CELL, n = fbm(x * 0.08 + 9, z * 0.08 - 4, 3);
    if (slope > 0.9) GRID.mat[idx] = MAT.ROCK;
    else if (m === MAT.SAND) continue;
    else if (slope > 0.6) GRID.mat[idx] = n > -0.1 ? MAT.ROCK : MAT.DIRT;
    else if (inBasalt(x, z) && GRID.h[idx] > 0.5) { GRID.mat[idx] = n > -0.2 ? MAT.ROCK : MAT.GRAVEL; GRID.tone[idx] = 150; }
    else if (n > 0.22) GRID.mat[idx] = MAT.DIRT;
  }
}
bake();

// clearance from every drivable path, on the baked grid (path ids), plus the pads
function clearOfPaths(x, z, margin) {
  for (const p of PADS) if (Math.hypot(x - p.x, z - p.z) < p.r + margin) return false;
  const m = Math.ceil(margin / CELL), cx = Math.round((x + SIZE / 2) / CELL), cz = Math.round((z + SIZE / 2) / CELL);
  for (let dx = -m; dx <= m; dx++) for (let dz = -m; dz <= m; dz++) {
    if (dx * dx + dz * dz > (m + 0.5) * (m + 0.5)) continue;
    const ix = cx + dx, iz = cz + dz;
    if (ix >= 0 && iz >= 0 && ix <= RES && iz <= RES && GRID.path[ix * N1 + iz] >= 0) return false;
  }
  return true;
}
export { clearOfPaths };
const slopeAt = (x, z) => Math.hypot(heightAt(x + 1, z) - heightAt(x - 1, z), heightAt(x, z + 1) - heightAt(x, z - 1)) / 2;

// ---------------------------------------------------------------- structures (box colliders)
// PROPS: box colliders { x, y, z, hx, hy, hz, rotY }; DECOR: what src/art/jungle/ draws on them
export const PROPS = [];
export const DECOR = { bridges: [], dock: null, rails: [], huts: [], lighthouse: null, lookout: null, signs: [] };
const box = (x, y, z, hx, hy, hz, rotY, kind) => { const b = { x, y, z, hx, hy, hz, rotY, kind }; PROPS.push(b); return b; };
// bridge decks: 3 m planks of deck following the road, rails either side
for (const r of ROADS) for (const br of r.bridges) {
  const segs = [];
  // 0.6 m planks over the stretch the bake leaves as creek and 1.5 m onto the road at each end (where the
  // ground is the road surface again), each plank's top on the road profile (3 cm under): no lip at the
  // ends, under 3 cm from plank to plank on the grade
  const e0 = br.s0 - 1.5, e1 = br.s1 + 1.5, n = Math.ceil((e1 - e0) / 0.6), step = (e1 - e0) / n;
  for (let k = 0, s = e0; k < n; k++, s += step) {
    const a = pathPoint(r, s), b = pathPoint(r, Math.min(r.length, s + step)), mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, my = (a.h + b.h) / 2 - 0.03;
    const yaw = Math.atan2(b.x - a.x, b.z - a.z), len = Math.hypot(b.x - a.x, b.z - a.z) / 2 + 0.01;
    segs.push(box(mx, my - 0.2, mz, r.width / 2 + 0.4, 0.2, len, yaw, 'deck'));
  }
  // rails: 3 m lengths along both edges
  for (let s = e0; s < e1 - 0.5; s += 3) {
    const a = pathPoint(r, s), b = pathPoint(r, Math.min(e1, s + 3)), mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, my = (a.h + b.h) / 2;
    const yaw = Math.atan2(b.x - a.x, b.z - a.z), len = Math.hypot(b.x - a.x, b.z - a.z) / 2 + 0.02;
    for (const sd of [-1, 1]) { const off = r.width / 2 + 0.3; box(mx - b.tz * off * sd, my + 0.55, mz + b.tx * off * sd, 0.09, 0.55, len, yaw, 'rail'); }
  }
  DECOR.bridges.push({ road: r.name, s0: br.s0, s1: br.s1, width: r.width, segs, paved: r.surface === 'paved' });
}
// Palm Cove dock: a timber pier from the beach out over the bay, drivable, with kerb rails
{
  const th = 1.67, r0 = coastR(th) - 10, r1 = coastR(th) + 40, dx = Math.cos(th), dz = Math.sin(th); // (seaward of the beach track)
  const x0 = dx * r0, z0 = dz * r0, y = Math.max(0.8, heightAt(x0, z0) + 0.3); // a 30 cm step up onto the planks
  const yaw = Math.atan2(dx, dz), w = 4.2, segs = [];
  for (let r = r0; r < r1; r += 4) {
    const mx = dx * (r + 2), mz = dz * (r + 2);
    segs.push(box(mx, y - 0.18, mz, w / 2, 0.18, 2.02, yaw, 'deck'));
    for (const sd of [-1, 1]) box(mx + dz * (w / 2 - 0.12) * sd, y + 0.12, mz - dx * (w / 2 - 0.12) * sd, 0.12, 0.12, 2.0, yaw, 'kerb');
  }
  box(dx * (r1 + 0.1), y + 0.35, dz * (r1 + 0.1), w / 2, 0.35, 0.15, yaw, 'kerb'); // end stop
  DECOR.dock = { x0, z0, x1: dx * r1, z1: dz * r1, y, w, yaw, segs };
}
// guard rails: on Ember Pass and the cliff-top coast road, wherever the outside drops away
for (const r of [MOUNTAIN, COAST_ROAD]) {
  for (const sd of [-1, 1]) {
    let run = [];
    const flush = () => { if (run.length > 3) DECOR.rails.push(run); run = []; };
    for (let s = 6; s < r.length - 6; s += 2) {
      const p = pathPoint(r, s), off = r.width / 2 + 0.9, nx = -p.tz * sd, nz = p.tx * sd;
      const x = p.x + nx * off, z = p.z + nz * off;
      const drop = p.h - heightAt(p.x + nx * (r.width / 2 + 5), p.z + nz * (r.width / 2 + 5));
      const steep = drop > (r === MOUNTAIN ? 2.2 : 4.5) && !onBridge(r, s) && !PADS.some((q) => Math.hypot(q.x - x, q.z - z) < q.r + 4);
      // keep junction mouths open: no rail across another path
      const mouth = steep && PATHS.some((q) => q !== r && q.pts.some((pt) => Math.hypot(pt.x - x, pt.z - z) < q.width / 2 + 3));
      if (steep && !mouth) run.push({ x, z, y: heightAt(x, z), s }); else flush();
    }
    flush();
  }
}
for (const run of DECOR.rails) for (let i = 1; i < run.length; i++) {
  const a = run[i - 1], b = run[i], len = Math.hypot(b.x - a.x, b.z - a.z) / 2;
  box((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.45, (a.z + b.z) / 2, 0.08, 0.32, len + 0.02, Math.atan2(b.x - a.x, b.z - a.z), 'rail');
}
// Palm Cove: a few stilt huts round the lot's back edge, a lookout at the summit, the lighthouse
{
  const V = VILLAGE, back = Math.atan2(-V.z, -V.x); // inland
  [-0.9, -0.35, 0.35, 0.9].forEach((da, i) => {
    const a = back + da, d = V.r - 4, x = V.x + Math.cos(a) * d, z = V.z + Math.sin(a) * d;
    const w = 4.6 + (i % 2), dpt = 4, yaw = -a + Math.PI / 2;
    const y = Math.min(heightAt(x, z), heightAt(x + 2, z), heightAt(x - 2, z), heightAt(x, z + 2), heightAt(x, z - 2));
    DECOR.huts.push({ x, z, y, yaw, w, d: dpt, kind: 'hut' });
    box(x, y + 1.6, z, w / 2, 1.6, dpt / 2, yaw, 'hut');
  });
  const L = SUMMIT_LOT, a = Math.atan2(L.z - PEAK.z, L.x - PEAK.x), lx = L.x + Math.cos(a) * (L.r - 2.5), lz = L.z + Math.sin(a) * (L.r - 2.5);
  DECOR.lookout = { x: lx, z: lz, y: L.h, yaw: -a + Math.PI / 2 };
  box(lx, L.h + 1.4, lz, 1.6, 1.4, 1.6, -a + Math.PI / 2, 'lookout');
  const H = LIGHTHOUSE, ha = Math.atan2(H.z, H.x), hx = H.x + Math.cos(ha) * (H.r - 3), hz = H.z + Math.sin(ha) * (H.r - 3);
  DECOR.lighthouse = { x: hx, z: hz, y: H.h };
  box(hx, H.h + 4, hz, 1.7, 4, 1.7, 0, 'lighthouse');
}

// ---------------------------------------------------------------- rocks
export function generateRocks() {
  const R = rng(9137);
  const { rocks, shape, put, boulder, reach, ledge } = rockKit(R, heightAt);
  const grade = (t, s) => { let g = 0; for (let q = -3; q < 3; q += 0.5) g = Math.max(g, Math.abs(pathPoint(t, s + q + 0.5).h - pathPoint(t, s + q).h) / 0.5); return g; };
  const stepCap = (g) => (g < 0.2 ? 0.65 : g < 0.3 ? lerp(0.65, 0.48, (g - 0.2) / 0.1) : g < 0.38 ? lerp(0.48, 0.26, (g - 0.3) / 0.08) : 0.22);
  const inWater = (x, z) => materialAt(x, z) === MAT.WATER;
  // scattered boulders keep their whole width (plus 0.6 m) off every road and crawl
  const offPath = (x, z, size, flat, embed) => { if (clearOfPaths(x, z, size * 1.3 + 0.6)) boulder(x, z, size, flat, embed); };
  for (const t of TRAILS) {
    const hw = t.width / 2;
    const stepAt = (s) => (t.steps || []).some((st) => s > st.s - 3 && s < st.s + st.depth + 2.5);
    if (t.steps) for (const st of t.steps) rocks.push(stepSlab(t, st, R));
    const spec = {
      green:  { every: 7, min: 0.25, max: 0.7, ledgeEvery: 30, ledgeH: [0.1, 0.17], top: 0.2 },
      blue:   { every: 4.4, min: 0.4, max: 0.95, ledgeEvery: 13, ledgeH: [0.24, 0.34], top: 0.36 },
      black:  { every: 2.6, min: 0.7, max: 1.6, ledgeEvery: 9, ledgeH: [0.45, 0.62], top: 0.7, lane: 1.4, notch: 0.18, notchTop: 0.5, crawl: 0.6, crawlTop: 0.36 },
      dblack: { every: 2.6, min: 0.75, max: 1.7, ledgeEvery: 1e9, ledgeH: [0, 0], top: 0.75, lane: 1.4, notch: 0.12, notchTop: 0.5, crawl: 0.55, crawlTop: 0.34 },
    }[t.diff];
    let side = 1, nextLedge = 14;
    for (let s = 10; s < t.length - 9; s += spec.every * (0.7 + R() * 0.6)) {
      if (stepAt(s)) continue;
      const p = pathPoint(t, s), nx = -p.tz, nz = p.tx, g = grade(t, s);
      if (s > nextLedge && spec.ledgeEvery < 1e8) {
        const top = Math.min(lerp(spec.ledgeH[0], spec.ledgeH[1], R()), stepCap(g)), depth = 3.2 + R() * 1.0;
        if (!inWater(p.x, p.z) && top >= 0.08) { ledge(p.x, p.z, Math.atan2(p.tx, p.tz), t.width + 1.6, depth, top); s += depth / 2 + 1.5; }
        nextLedge = s + Math.max(7.5, spec.ledgeEvery * (0.75 + R() * 0.5));
        continue;
      }
      if (spec.lane) {
        // hard crawls: a meandering clear lane, boulders crowding its edges, crawl rocks and notches in it
        const lc = (hw - spec.lane - 0.1) * Math.sin(s * (Math.PI * 2 / 50)) * smooth(6, 20, Math.min(s, t.length - s));
        if (R() < spec.notch) {
          const sz = 1.1 + R() * 0.35;
          for (const sd of [1, -1]) { const r = shape(sz, 0.55, 0.3, Math.min(spec.notchTop, stepCap(g))); const cpos = lc + sd * (0.5 + reach(r, -nx * sd, -nz * sd)); put(r, p.x + nx * cpos, p.z + nz * cpos, true); }
          s += 1.5; continue;
        }
        { const r = shape(spec.min + Math.pow(R(), 1.5) * (spec.max - spec.min), 0.85, 0.35, spec.top); const cpos = lc + side * (spec.lane + reach(r, -nx * side, -nz * side)); put(r, p.x + nx * cpos, p.z + nz * cpos, true); side = -side; }
        if (R() < spec.crawl) { const r = shape(0.35 + R() * 0.3, 0.8, 0.35, Math.min(spec.crawlTop, stepCap(g))); const cpos = lc + (R() < 0.5 ? -1 : 1) * (0.75 + R() * 0.25); put(r, p.x + nx * cpos, p.z + nz * cpos, true); }
      } else {
        const off = side * (0.9 + R() * (hw - 0.9)); side = -side;
        const x = p.x + nx * off, z = p.z + nz * off;
        if (!inWater(x, z)) boulder(x, z, spec.min + Math.pow(R(), 1.5) * (spec.max - spec.min), t.diff === 'green' ? 0.6 : 0.8, 0.35, spec.top);
      }
      // corridor edge rocks
      if (R() < 0.65) { const sd = R() < 0.5 ? -1 : 1, r = shape(0.5 + R() * 0.9, 0.8); const cpos = sd * (hw + 0.3 + reach(r, -nx * sd, -nz * sd) * (0.9 + R() * 0.3)); const x = p.x + nx * cpos, z = p.z + nz * cpos; if (clearOfPaths(x, z, 0.4) || inBasalt(x, z)) put(r, x, z, true); }
    }
  }
  // the creek: rounded boulders strewn along its floor and banks, clear of the crawl and fords
  for (let s = 6; s < RIVER.length - 30; s += 2.2) {
    const p = riverAt(s), lat = (R() * 2 - 1) * (RIVER.bedW + 3), x = p.x - p.tz * lat, z = p.z + p.tx * lat;
    if (!clearOfPaths(x, z, 1.2) || Math.hypot(x - POOL.x, z - POOL.z) < POOL.r || slopeAt(x, z) > 0.55) continue;
    offPath(x, z, 0.5 + Math.pow(R(), 1.6) * 1.6, 0.7, 0.4);
  }
  // the lava flow: jagged basalt boulders off the paths
  for (let i = 0; i < 520; i++) {
    const a = R() * TAU, d = Math.sqrt(R()) * BASALT.r, x = BASALT.x + Math.cos(a) * d, z = BASALT.z + Math.sin(a) * d;
    if (!inBasalt(x, z) || heightAt(x, z) < -0.6 || !clearOfPaths(x, z, 2.5) || slopeAt(x, z) > 0.5) continue;
    offPath(x, z, 0.6 + Math.pow(R(), 1.5) * 2.2, 0.75, 0.3);
  }
  // rocky ends of the beaches (tide pools) and sea stacks under the cliffs
  for (const [th0, th1, n] of [[BAY_TH - 0.62, BAY_TH - 0.48, 46], [BAY_TH + 0.44, BAY_TH + 0.58, 46], [-0.34, -0.2, 40], [0.56, 0.7, 40], [2.66, 2.72, 22], [3.0, 3.06, 22]]) {
    for (let i = 0; i < n; i++) {
      const th = lerp(th0, th1, R()), r = coastR(th) + (R() * 2 - 0.9) * 18, x = Math.cos(th) * r, z = Math.sin(th) * r;
      if (!clearOfPaths(x, z, 2) || slopeAt(x, z) > 0.5) continue;
      offPath(x, z, 0.5 + Math.pow(R(), 1.4) * 2.0, 0.65, 0.35);
    }
  }
  for (let i = 0; i < 60; i++) {
    const th = lerp(-2.6, -0.95, R()), r = coastR(th) + 6 + R() * 30, x = Math.cos(th) * r, z = Math.sin(th) * r;
    boulder(x, z, 1.5 + R() * 3.5, 1.1, 0.25);
  }
  // scattered jungle boulders
  for (let i = 0; i < 380; i++) {
    const x = (R() * 2 - 1) * 400, z = (R() * 2 - 1) * 400;
    if (inland(x, z) < 20 || !clearOfPaths(x, z, 3) || materialAt(x, z) === MAT.WATER || slopeAt(x, z) > 0.45) continue;
    offPath(x, z, 0.5 + Math.pow(R(), 2) * 2.2, 0.8);
  }

  // ---- ground relief: embedded rocks in the crawl treads and rubble beside them (own stream) ----
  const E = rockKit(rng(4711), heightAt), R2 = rng(4712);
  const ledges = rocks.filter((r) => r.ledge);
  for (const t of TRAILS) {
    const rl = RELIEF[t.diff], e = rl.embed, hw = t.width / 2;
    const nearLedge = (x, z) => ledges.some((r) => Math.hypot(r.x - x, r.z - z) < 4.2);
    for (let s = 8; s < t.length - 6; s += e.every * (0.6 + R2() * 0.8)) {
      const p = pathPoint(t, s), lat = R2() < 0.7 ? (R2() < 0.5 ? -1 : 1) * (0.8 + (R2() - 0.5) * 0.6) : (R2() * 2 - 1) * (hw - 0.4);
      const x = p.x - p.tz * lat, z = p.z + p.tx * lat;
      if (nearLedge(x, z) || inWater(x, z)) continue;
      const k = R2();
      E.embedded(x, z, lerp(e.size[0], e.size[1], k), lerp(e.proud[0], e.proud[1], 0.3 * R2() + 0.7 * k));
    }
    for (let s = 6; s < t.length - 4; s += rl.rubble * (0.6 + R2() * 0.8)) {
      const p = pathPoint(t, s), lat = (R2() < 0.5 ? -1 : 1) * (hw + 0.7 + R2() * 3.2);
      const x = p.x - p.tz * lat, z = p.z + p.tx * lat;
      if (!clearOfPaths(x, z, 0.5) || inWater(x, z)) continue;
      E.embedded(x, z, 0.4 + R2() * 0.7, 0.08 + R2() * 0.17);
    }
  }
  for (const r of E.rocks) rocks.push(r);
  return rocks;
}
// step-up slab across a crawl (after maps/crawl.js stepSlab): its front face stands `rise` above
// the tread, its top flush with the ground filled in behind it
function stepSlab(t, st, R) {
  const p = pathPoint(t, st.s), g = (pathPoint(t, st.s - 1).h - pathPoint(t, st.s - 3).h) / 2;
  const hwS = t.width / 2 + 2.1, pts = [], { rise, depth } = st;
  const zf = -(rise + 0.35) * 0.62;
  for (const sx of [-1, 1]) {
    for (const zt of [0, 0.06]) pts.push(sx * hwS * (0.93 + R() * 0.07), rise + R() * 0.02 + g * zt, zt + R() * 0.06);
    pts.push(sx * hwS, g * zf - 0.35, zf);
    pts.push(sx * hwS * (0.95 + R() * 0.05), rise + g * (depth + 0.2) + 0.02, depth + 0.2);
    pts.push(sx * hwS, rise + g * (depth + 0.7) - 0.45, depth + 0.7);
  }
  for (let i = 0; i < 5; i++) { const zz = 0.4 + R() * (depth - 0.4); pts.push((R() * 2 - 1) * hwS * 0.8, rise + g * zz + 0.01 + R() * 0.02, zz); }
  return { x: p.x, y: p.h, z: p.z, rotY: Math.atan2(p.tx, p.tz), pts, ledge: true, step: { trail: t.name, s: st.s, rise, grade: g, depth } };
}

// ---------------------------------------------------------------- trees
// Jungle: broadleaf canopy trees everywhere inland (thinner in clearings), coconut palms along the
// beaches and the coast. Each has a trunk collider (common.js); src/art/jungle/ draws them.
// canopy extents at scale 1 (src/art/jungle/plants.js), for the camera clearance (src/cam_clear.js):
// leaves from y1 to y2 above the foot, out to r1 from the trunk (a palm's crown leans off its foot)
const CANOPY = { palm: { y1: 6.6, y2: 10, r1: 4.6 }, broad: { y1: 3, y2: 9.6, r1: 5.2 }, giant: { y1: 7.2, y2: 15.6, r1: 7 } };
export function generateTrees() {
  const R = rng(4243), trees = [];
  const C = 6.5;
  for (let gx = -400; gx < 400; gx += C) for (let gz = -400; gz < 400; gz += C) {
    const x = gx + R() * C, z = gz + R() * C, r1 = R(), r2 = R(), r3 = R();
    const c = inland(x, z), h = heightAt(x, z);
    if (c < 4 || h < 0.7) continue;
    const m = materialAt(x, z);
    if (m === MAT.WATER || m === MAT.ROCK && r3 < 0.85) continue;
    if (slopeAt(x, z) > 0.85 || !clearOfPaths(x, z, 3.6)) continue;
    if (riverNearest(x, z).d < RIVER.bedW + 1.5 || Math.hypot(x - POOL.x, z - POOL.z) < POOL.r + 3) continue;
    const coastal = c < 55 + 25 * beachW(Math.atan2(z, x)) && h < 16;
    if (inBasalt(x, z) && r3 < 0.8) continue;
    // the summit stays open: grass, rock and scrub above the forest line, nothing round the crater
    const rp = Math.hypot(x - PEAK.x, z - PEAK.z);
    if (rp < 72 || h > 116 + 8 * r3) continue;
    const dens = fbm(x * 0.012 + 7, z * 0.012 - 3, 3); // clearings and thickets
    if (coastal) { if (r1 < 0.55 + dens * 0.3) trees.push({ x, z, y: h, s: 0.85 + r2 * 0.45, kind: 'palm', canopy: CANOPY.palm }); continue; }
    if (r1 > 0.62 + dens * 0.5) continue;
    const kind = r2 > 0.86 ? 'giant' : 'broad';
    trees.push({ x, z, y: h, s: 1.05 + r2 * 0.75, kind, canopy: CANOPY[kind] });
  }
  return trees;
}

// ---------------------------------------------------------------- named places (spawn points)
const flatS = (road, s0, span = 40) => {
  let best = null;
  for (let s = Math.max(6, s0 - span); s <= Math.min(road.length - 6, s0 + span); s += 1) {
    if (road.mud && road.mud.some(([m0, m1]) => s / road.length > m0 - 0.05 && s / road.length < m1 + 0.05)) continue;
    if ((road.fords || []).some((sf) => Math.abs(s - sf) < 14)) continue; // (not in the water)
    // footprint like src/spawns.js checkSpot: least-squares plane over 7 x 4 baked heights, grade + roughness
    const p = pathPoint(road, s), S = [];
    for (const u of [-3.5, -2.3, -1.2, 0, 1.2, 2.3, 3.5]) for (const v of [-1.35, -0.45, 0.45, 1.35]) S.push([u, v, heightAt(p.x + p.tx * u - p.tz * v, p.z + p.tz * u + p.tx * v)]);
    const c = S.reduce((q, t) => q + t[2], 0) / S.length;
    const gu = S.reduce((q, t) => q + t[0] * (t[2] - c), 0) / S.reduce((q, t) => q + t[0] * t[0], 0), gv = S.reduce((q, t) => q + t[1] * (t[2] - c), 0) / S.reduce((q, t) => q + t[1] * t[1], 0);
    const rough = Math.max(...S.map(([u, v, h]) => Math.abs(h - (c + gu * u + gv * v))));
    const g = Math.hypot(gu, gv) + Math.max(0, rough - 0.08) * 2 + Math.abs(s - s0) * 0.001;
    if (!best || g < best.g) best = { g, s };
  }
  return best ? best.s : s0;
};
const roadPose = (road, s, back = false) => { const p = pathPoint(road, s); return { x: p.x, z: p.z, yaw: Math.atan2(back ? p.tx : -p.tx, back ? p.tz : -p.tz) }; };
const facing = (x, z, tx, tz) => ({ x, z, yaw: Math.atan2(-(tx - x), -(tz - z)) });
const nearestS = (road, x, z) => { let b = null; for (const q of road.pts) { const d = Math.hypot(q.x - x, q.z - z); if (!b || d < b.d) b = { d, s: q.s }; } return b.s; };
export const PLACES = [
  { id: 'dock', name: 'Palm Cove Dock', note: 'The timber pier into Crescent Bay', ...facing(Math.cos(1.67) * (coastR(1.67) - 33), Math.sin(1.67) * (coastR(1.67) - 33), DECOR.dock.x1, DECOR.dock.z1) },
  { id: 'crescent-beach', name: 'Crescent Beach', note: 'Soft sand: air down (T) for grip', ...roadPose(BAY_BEACH, BAY_BEACH.length * 0.22) },
  { id: 'sunrise-beach', name: 'Sunrise Beach', note: 'Surf, sand and the creek mouth', ...roadPose(SUN_BEACH, SUN_BEACH.length * 0.75, true) },
  { id: 'west-cove', name: 'West Cove', note: 'A small sandy cove at the foot of the Ridge Track', ...roadPose(COVE_ACCESS, Math.max(4, COVE_ACCESS.length - 8)) },
  { id: 'summit', name: 'Summit Viewpoint', note: 'The top of Ember Pass Road', x: SUMMIT_LOT.x, z: SUMMIT_LOT.z, yaw: Math.atan2(SUMMIT_LOT.x - PEAK.x, SUMMIT_LOT.z - PEAK.z) },
  { id: 'rim', name: 'Crater Rim', note: 'The highest point on the island', x: RIM.x, z: RIM.z, yaw: Math.atan2(PEAK.x - RIM.x, PEAK.z - RIM.z) },
  { id: 'pass', name: 'Ember Pass Hairpins', note: 'Paved switchbacks: take the Rally Sedan', ...roadPose(MOUNTAIN, 330) },
  { id: 'falls', name: 'Ember Falls', note: 'The ford below the falls on Plantation Road', ...roadPose(PLANTATION, flatS(PLANTATION, nearestS(PLANTATION, POOL.x, POOL.z) - 22, 40)) },
  { id: 'ridge', name: 'Ridge Lookout', note: 'The end of the Ridge Track, over West Cove', x: RIDGE_LOOKOUT.x, z: RIDGE_LOOKOUT.z, yaw: Math.atan2(RIDGE_LOOKOUT.x - RT1.x, RIDGE_LOOKOUT.z - RT1.z) },
  { id: 'fern-gully', name: 'Fern Gully Track', note: 'The two-track leaves Plantation Road just ahead: narrow, rutted, steep', ...roadPose(PLANTATION, flatS(PLANTATION, nearestS(PLANTATION, FERN.pts[0].x, FERN.pts[0].z) - 14, 14)) }, // (on Plantation Road just before the track's mouth: the track itself is too steep to park on)
  { id: 'north-cliffs', name: 'North Cliffs', note: 'The coast road along the cliff tops', ...roadPose(COAST_ROAD, flatS(COAST_ROAD, nearestS(COAST_ROAD, 0, -340), 40)) },
  { id: 'plantation', name: 'Plantation Road', note: 'Graded dirt through the jungle, with a ford', ...roadPose(PLANTATION, flatS(PLANTATION, 40, 30)) },
  { id: 'lighthouse', name: 'Lava Point Light', note: 'The lighthouse on the old lava flow', x: LIGHTHOUSE.x, z: LIGHTHOUSE.z, yaw: Math.atan2(LIGHTHOUSE.x, LIGHTHOUSE.z) },
];
export const TRAILHEAD = VILLAGE;
export const SPAWN = { x: VILLAGE.x, z: VILLAGE.z, yaw: Math.atan2(VILLAGE.x - VQ.x, VILLAGE.z - VQ.z) }; // facing the coast road
export const groundAt = groundHeight;

// The surface a truck rests on at (x, z): the ground, or the top of a bridge or dock deck above it
// (src/terrain.js surfaceAt: main.js places recovered, restarted and teleported trucks with it).
const DECKS = PROPS.filter((b) => b.kind === 'deck');
export function surfaceAt(x, z) {
  let h = heightAt(x, z);
  for (const b of DECKS) {
    const dx = x - b.x, dz = z - b.z, c = Math.cos(b.rotY), s = Math.sin(b.rotY);
    if (Math.abs(dx * c - dz * s) <= b.hx && Math.abs(dx * s + dz * c) <= b.hz) h = Math.max(h, b.y + b.hy);
  }
  return h;
}
// Where the deep-sea tow puts the truck: the nearest point of a paved or dirt road that is on the
// ground (never on a bridge deck or near the dock), facing along the road; a spawn-point pose.
export function towTarget(x, z) {
  let best = null;
  for (const r of ROADS) {
    if (r.surface === 'sand') continue;
    for (const pt of r.pts) {
      if (r.bridges.some((b) => pt.s > b.s0 - 6 && pt.s < b.s1 + 6)) continue;
      if (surfaceAt(pt.x, pt.z) > heightAt(pt.x, pt.z) + 0.05 || Math.hypot(pt.x - DECOR.dock.x0, pt.z - DECOR.dock.z0) < 12) continue;
      const d = Math.hypot(pt.x - x, pt.z - z);
      if (!best || d < best.d) best = { d, r, s: pt.s };
    }
  }
  const p = pathPoint(best.r, best.s);
  return { id: 'tow', name: best.r.name, x: p.x, z: p.z, yaw: Math.atan2(-p.tx, -p.tz), note: `Too deep! Towed back to ${best.r.name}, repaired, parking brake on.` };
}
