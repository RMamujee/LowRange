// Sunfall Basin: an open desert free-roam map. A wide basin ringed by a red rimrock escarpment:
// a dune sea (the Saffron Sea) fills the north-east, a white dry lake (Bonewhite Flat) the west,
// two mesas with a canyon between them the south-east, a slickrock dome (the Whaleback) the
// south-west. Fast dirt tracks link them all; four rated rock crawls and a marked dune route
// are timed through gates like the Trail Park's trails.
//
// The grid is 2 m (1200 m square, 600 cells): dunes, mesas and tracks are broad shapes, and the
// sub-metre crawl relief is rock hulls (rockKit), not heightfield, so the coarser grid keeps the
// terrain mesh and heightfield affordable for a map nine times the Trail Park's area.
//
// Deep sand: the dunes export a sand depth field (sandDepthAt, 0..1) that src/deepsand.js uses
// for sinkage, bogging and airing down. Other maps have no depth field, so their sand (and
// everything else) drives exactly as before.
import { MAT, MAT_INFO, fbm, ridged, clamp, smooth, lerp, rng, catmull, arcLength, pathPoint, makeGrid, rockKit, lumps, potholes } from './common.js';
import { RAMP, BACKDROP, SKY_BANDS } from '../gfx/palette.js';

export const ID = 'desert';
export const NAME = 'Sunfall Basin';
export const KIND = 'trails';
export const SIZE = 1200;          // metres, square, centred on the origin
export const RES = 600;            // 2 m cells

// ---------------------------------------------------------------- look
// The desert's own ground ramps, applied when this module loads (only one map loads per page, and
// the ground tiles are generated on first render, after this). A red-rock desert: apricot dunes,
// grey-brown desert floor, red sandstone slickrock and a pale bone-white dry lake, each a step
// calmer than the Trail Park's golden ochre so the big bright sand areas don't glare.
export const RAMPS = {
  sand:    [0xe6b78e, 0xd6a078, 0xbc855f, 0x936447], // dunes: apricot, calm (base S .44, V .84)
  dirt:    [0xcfb193, 0xbb9a7b, 0x9d7e62, 0x785f4a], // desert floor and tracks: grey-brown
  gravel:  [0xc2ab93, 0xa38c75, 0x84705d, 0x645446],
  rock:    [0xcf9a7e, 0xb47d63, 0x91604c, 0x6b473a], // red sandstone slab and cliffs
  boulder: [0xa48a80, 0x84695f, 0x664f49, 0x4a3834], // varnished boulders, darker than the slab
  road:    [0xddd0bb, 0xcbbca4, 0xae9f88, 0x8b7d6a], // dry lake clay: bone, low saturation
  grass:   [0xb7ab84, 0x9f9470, 0x827a5c, 0x625c48], // (scrub soil, should anything show it)
};
const MAT_COLORS = { [MAT.SAND]: [0.84, 0.63, 0.47], [MAT.DIRT]: [0.73, 0.6, 0.48], [MAT.ROCK]: [0.71, 0.49, 0.39], [MAT.ROAD]: [0.8, 0.74, 0.64], [MAT.GRAVEL]: [0.64, 0.55, 0.46] };
Object.assign(RAMP, RAMPS);
for (const [m, c] of Object.entries(MAT_COLORS)) MAT_INFO[m].color = c;
// distant ranges: mauve and dusty blue rimrock silhouettes instead of green hills
BACKDROP.splice(0, 3, 0xa8725a, 0xb99a92, 0xbdb6bf);
// a warmer, paler horizon haze stepping up into the same soft blue (the pixel pipeline's sky bands)
SKY_BANDS.splice(0, SKY_BANDS.length, 0xe6d6bf, 0xdcdccd, 0xbfd8e0, 0x9fcfe8, 0x86c0e6);
// the view (src/desert/view.js) reads these: fog range and colour (= the sky's horizon band),
// camera reach, a warm sun and sky light with a red-earth bounce
export const ATMOS = { fog: [240, 1150], haze: 0xe6d6bf, far: 2600, sun: 0xffe9cc, sunK: 1.0, sky: 0xfff0dc, bounce: 0x6e4e3c };

// ---------------------------------------------------------------- landforms
const PI = Math.PI;
const S2 = SIZE / 2;
// distance to the map edge as a rounded square (corners come in a little)
const edgeDist = (x, z) => Math.max(Math.abs(x), Math.abs(z)) * 0.72 + Math.hypot(x, z) * 0.28 * 0.98;
// gentle basin floor, rising onto the alluvial fans below the rim
function basin(x, z) {
  return 3.2 * fbm(x * 0.0032 + 1.7, z * 0.0032 - 2.2, 3) + 1.1 * fbm(x * 0.011 + 5, z * 0.011, 2) + 9 * smooth(320, 560, edgeDist(x, z));
}
// the rimrock escarpment all round: a cliff band you can't drive up, so there is no invisible wall
// and no way off the edge of the world
function rim(x, z) {
  const a = Math.atan2(z, x), e = edgeDist(x, z);
  const line = 562 + 16 * fbm(Math.cos(a) * 3 + 11, Math.sin(a) * 3 - 4, 3);
  return 8 * smooth(line - 70, line - 12, e) + 52 * smooth(line - 10, line + 8, e) + 30 * smooth(S2 - 22, S2 - 4, Math.max(Math.abs(x), Math.abs(z)));
}

// ---- dry lake (Bonewhite Flat) ----
export const PLAYA = { x: -300, z: -40, rx: 165, rz: 108, rot: 0.35, y: -2.6 };
function playaQ(x, z) {
  const c = Math.cos(PLAYA.rot), s = Math.sin(PLAYA.rot), dx = x - PLAYA.x, dz = z - PLAYA.z;
  const u = (dx * c + dz * s) / PLAYA.rx, v = (-dx * s + dz * c) / PLAYA.rz;
  return Math.hypot(u, v) + 0.06 * fbm(x * 0.02, z * 0.02, 2);
}

// ---- dune sea (the Saffron Sea) ----
export const ERG = { x: 300, z: -315, rx: 300, rz: 265 };
const WIND = [Math.cos(0.22), Math.sin(0.22)]; // the wind blows towards +x, a little south: slip faces face east
export const SLIP = 0.62;                      // slip faces stand at the angle of repose, about 32°
const LAM = 118;                               // crest spacing (m)
function ergMask(x, z) {
  const q = Math.hypot((x - ERG.x) / ERG.rx, (z - ERG.z) / ERG.rz) + 0.16 * fbm(x * 0.006 + 7, z * 0.006 - 3, 3);
  return smooth(1.0, 0.62, q);
}
// Transverse dune ridges across the wind, crests snaking (barchanoid): each period is a long,
// gently concave windward face up to a sharp brink, a straight slip face at the angle of repose,
// and a short flat corridor before the next ridge. Crest height varies along every ridge (peaks
// and saddles) and per ridge; the mask shrinks the ridges to a sand sheet at the edges of the sea.
// Returns the height above the floor and the slope class (0 corridor, 1 windward, 2 slip).
const duneOut = { h: 0, part: 0, H: 0, f: 0, Lw: 0 };
function dune(x, z) {
  const m = ergMask(x, z);
  duneOut.h = 0; duneOut.part = 0; duneOut.H = 0;
  if (m <= 0) return duneOut;
  const a = x * WIND[0] + z * WIND[1], c = -x * WIND[1] + z * WIND[0];
  // crest height: peaks and saddles along every ridge, slowly changing downwind
  const H = clamp(8 + 22 * fbm(c * 0.0125 + 3, a * 0.0045 - 1, 3), 0, 18) * (0.3 + 0.7 * m) * smooth(0, 0.35, m);
  // sinuous crests; where a ridge stands tall its crest sits further upwind, so the low parts
  // trail downwind as horns: chains of crescents (barchanoid ridges), not straight walls
  const u = a + 1.1 * H + 18 * Math.sin(c * 0.011 + 1.4 * fbm(c * 0.003 + 4, a * 0.0025, 2)) + 11 * Math.sin(c * 0.029 + 2 + 2 * fbm(a * 0.004, c * 0.004 + 9, 2)) + 10 * fbm(x * 0.007 + 3, z * 0.007 - 5, 3);
  const k = Math.floor(u / LAM), f = u - k * LAM;
  const slip = H / SLIP, Lw = LAM - slip - 5;
  let h = 0, part = 0;
  if (f < Lw) { const t = f / Lw; h = H * (0.68 * t + 0.32 * t * t); part = 1; }
  else if (f < Lw + slip) { h = H - SLIP * (f - Lw); part = 2; }
  duneOut.h = h + 1.6 * m; duneOut.part = part; duneOut.H = H; duneOut.f = f; duneOut.Lw = Lw;
  return duneOut;
}
// the practice dune by the dune road: one smooth isolated dune with a straight 15° windward face
// (the reference face for the sand tests and a place to learn before the sea)
export const PRACTICE = { x: 170, z: 42, dir: [Math.cos(0.22), Math.sin(0.22)], len: 48, grade: 0.27, width: 36 };
// deep sand under the practice dune and its apron (0..1)
function practiceSand(x, z) {
  const P = PRACTICE, dx = x - P.x, dz = z - P.z;
  const a = dx * P.dir[0] + dz * P.dir[1], c = -dx * P.dir[1] + dz * P.dir[0];
  return smooth(-22, -12, a) * smooth(P.len + 46, P.len + 30, a) * smooth(P.width / 2 + 44, P.width / 2 + 30, Math.abs(c));
}
function practice(x, z) {
  const P = PRACTICE, dx = x - P.x, dz = z - P.z;
  const a = dx * P.dir[0] + dz * P.dir[1], c = -dx * P.dir[1] + dz * P.dir[0];
  if (a < -8 || a > P.len + 40 || Math.abs(c) > P.width / 2 + 42) return 0;
  const top = P.len * P.grade;
  // straight face across the middle 36 m, then the flanks fall away and trail downwind as horns
  const ac = Math.abs(c), side = smooth(P.width / 2 + 40, P.width / 2, ac), horn = 14 * smooth(P.width / 2, P.width / 2 + 40, ac);
  const aa = a - horn;
  let h = 0;
  if (aa < P.len) h = P.grade * Math.max(0, aa);                                  // windward face
  else if (aa < P.len + 4) h = top - (aa - P.len) * 0.05;                         // crest
  else h = Math.max(0, top - 0.2 - (aa - P.len - 4) * SLIP);                      // slip face
  return h * side * smooth(-8, 0, a);
}

// ---- mesas, buttes and canyons ----
// mesas: plateau with a cliff band (two strata ledges), a talus apron below
export const MESAS = [
  { name: 'Redwall Mesa', x: 320, z: 395, r: 145, top: 34, seed: 1 },
  { name: 'Anvil Mesa', x: 330, z: 112, r: 72, top: 27, seed: 2 },
  { name: 'Needle Butte', x: -150, z: 310, r: 17, top: 36, seed: 3 },
  { name: 'Chimney Butte', x: 520, z: 450, r: 26, top: 30, seed: 4 },
  { name: 'Sentinel Butte', x: -470, z: -300, r: 22, top: 26, seed: 5 },
  { name: 'Twin Buttes', x: 70, z: 520, r: 20, top: 24, seed: 6 },
  { name: 'Twin Buttes', x: 115, z: 545, r: 16, top: 29, seed: 7 },
];
function mesa(x, z, M) {
  const dx = x - M.x, dz = z - M.z;
  if (Math.abs(dx) > M.r * 1.7 || Math.abs(dz) > M.r * 1.7) return 0;
  // broad lobes and re-entrants, a little finer irregularity on the big ones
  const d = Math.hypot(dx, dz) / M.r + 0.16 * fbm(x * (1.7 / M.r) + M.seed * 13, z * (1.7 / M.r) - M.seed * 7, 2)
    + 0.035 * fbm(x * (6 / M.r) - M.seed * 5, z * (6 / M.r) + M.seed * 3, 2) * Math.min(1, M.r / 60);
  const band = M.r > 40 ? 0.12 : 0.3; // relative width of the cliff band
  // two strata: a lower bench at 40% and the caprock; each a steep step
  const t = smooth(1.0, 1.0 - band * 0.45, d) * 0.4 + smooth(1.0 - band * 0.5, 1.0 - band, d) * 0.6;
  const talus = smooth(1.45, 1.0, d) * 0.16;
  return M.top * Math.max(t, talus);
}
// canyons: cut a floor (rising linearly from f0 to f1 above the basin) with steep walls into
// whatever stands there. halfW: floor half-width; wall: wall slope (rise / run)
const CANYON_DEFS = [
  // Knucklebone Canyon: a narrow slot through Anvil Mesa (the black crawl)
  { name: 'Knucklebone Canyon', pts: [[324, 208], [330, 190], [324, 150], [340, 110], [328, 70], [338, 30], [330, -2]], halfW: 5.5, wall: 3.2, f0: 0, f1: 0 },
  // the Redwall ravine: a gully climbing into the mesa from the west, floor rising to the top (the staircase)
  { name: 'Redwall Ravine', pts: [[150, 429], [170, 425], [198, 414], [225, 400], [250, 392], [272, 388]], halfW: 6.5, wall: 2.6, f0: 0.3, f1: 33.5 },
];
const CANYONS = CANYON_DEFS.map((c) => {
  const pts = catmull(c.pts, 2); const L = arcLength(pts);
  return { ...c, pts, length: L };
});
// Distance fields to polylines (washes, canyons), stamped once onto the grid vertices and read
// back bilinearly: baseHeight runs for every vertex and every path point, so it must not loop
// over hundreds of segments each time.
const FN1 = RES + 1, FCELL = SIZE / RES;
function distanceField(lines, reach) {
  const d = new Float32Array(FN1 * FN1).fill(1e4), s = new Float32Array(FN1 * FN1), id = new Int8Array(FN1 * FN1).fill(-1);
  lines.forEach((ln, li) => {
    const pts = ln.pts, r = reach(ln);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
      const ix0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - r + S2) / FCELL)), ix1 = Math.min(RES, Math.ceil((Math.max(a.x, b.x) + r + S2) / FCELL));
      const iz0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - r + S2) / FCELL)), iz1 = Math.min(RES, Math.ceil((Math.max(a.z, b.z) + r + S2) / FCELL));
      for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
        const x = -S2 + ix * FCELL, z = -S2 + iz * FCELL, k = ix * FN1 + iz;
        const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / L2, 0, 1), dd = Math.hypot(x - a.x - ex * t, z - a.z - ez * t);
        if (dd < d[k]) { d[k] = dd; s[k] = lerp(a.s, b.s, t); id[k] = li; }
      }
    }
  });
  // sample: bilinear distance / arc length, nearest-vertex line id
  const out = { d: 1e4, s: 0, id: -1 };
  return (x, z) => {
    const fx = clamp((x + S2) / FCELL, 0, RES - 1e-6), fz = clamp((z + S2) / FCELL, 0, RES - 1e-6);
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz, k = ix * FN1 + iz;
    const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
    out.d = d[k] * w00 + d[k + FN1] * w10 + d[k + 1] * w01 + d[k + FN1 + 1] * w11;
    out.s = s[k] * w00 + s[k + FN1] * w10 + s[k + 1] * w01 + s[k + FN1 + 1] * w11;
    out.id = id[Math.round(fx) * FN1 + Math.round(fz)];
    return out;
  };
}
const canyonField = distanceField(CANYONS, (c) => c.halfW + 40);

// ---- slickrock dome (the Whaleback) ----
export const DOME = { x: -285, z: 330, ra: 105, rb: 62, rot: -0.55, H: 21 };
function dome(x, z) {
  const c = Math.cos(DOME.rot), s = Math.sin(DOME.rot), dx = x - DOME.x, dz = z - DOME.z;
  const u = (dx * c + dz * s) / DOME.ra, v = (-dx * s + dz * c) / DOME.rb, q2 = u * u + v * v;
  if (q2 >= 1.3) return 0;
  // a smooth whaleback with gentle swells and shallow bowls (slickrock potholes) on it
  const body = q2 < 1 ? DOME.H * Math.pow(1 - q2, 1.35) : 0;
  const swell = (1.6 * fbm(x * 0.03 + 2, z * 0.03 - 1, 2) + 0.5 * fbm(x * 0.09, z * 0.09, 2)) * smooth(1.1, 0.5, q2);
  return body + swell;
}
const domeQ = (x, z) => { const c = Math.cos(DOME.rot), s = Math.sin(DOME.rot), dx = x - DOME.x, dz = z - DOME.z; const u = (dx * c + dz * s) / DOME.ra, v = (-dx * s + dz * c) / DOME.rb; return Math.hypot(u, v); };

// ---- dry washes: shallow sandy channels from the rim to the dry lake ----
const WASH_DEFS = [
  { name: 'Arroyo Seco', pts: [[-60, 590], [-95, 480], [-150, 400], [-205, 250], [-215, 150], [-245, 60]], w: 9, depth: 1.8 },
  { name: 'Canyon Wash', pts: [[590, 236], [470, 232], [400, 226], [330, 228], [250, 230], [170, 196], [90, 150], [10, 110], [-90, 70], [-180, 30]], w: 8, depth: 1.5 },
  { name: 'North Wash', pts: [[-120, -590], [-150, -470], [-200, -340], [-250, -230], [-275, -150]], w: 7, depth: 1.4 },
];
const WASHES = WASH_DEFS.map((w) => { const pts = catmull(w.pts, 3); arcLength(pts); return { ...w, pts }; });
const washField = distanceField(WASHES, (w) => w.w + 10);

// Raw landscape before the tracks are graded into it. Also reports the natural surface.
const BH = { sand: 0, dunePart: 0, wash: 0, canyon: 0, rock: 0 };
function baseHeight(x, z) {
  let h = basin(x, z);
  BH.sand = 0; BH.dunePart = 0; BH.wash = 0; BH.canyon = 0; BH.rock = 0;
  // dry lake: dead flat, a soft shoreline
  const pq = playaQ(x, z);
  h = lerp(h, PLAYA.y, smooth(1.25, 0.98, pq));
  // washes cut first so dunes and mesas override them
  {
    const n = washField(x, z), w = WASHES[n.id];
    if (w && n.d < w.w + 8) {
      h -= w.depth * smooth(w.w + 8, w.w * 0.6, n.d) * smooth(0, 40, n.s);
      if (n.d < w.w) BH.wash = smooth(w.w, w.w * 0.5, n.d);
    }
  }
  // dunes
  const d = dune(x, z);
  if (d.h > 0) { h += d.h; BH.sand = ergMask(x, z); BH.dunePart = d.part; }
  const pr = practice(x, z), ps = practiceSand(x, z);
  if (pr > 0) h = Math.max(h, basin(x, z) + pr);
  if (ps > 0) BH.sand = Math.max(BH.sand, ps);
  // mesas and buttes (on top of whatever is below)
  let mt = 0;
  for (const M of MESAS) mt = Math.max(mt, mesa(x, z, M));
  h += mt;
  // slickrock dome
  const dm = dome(x, z);
  if (dm > 0) { h += dm; BH.rock = Math.max(BH.rock, smooth(1.05, 0.92, domeQ(x, z))); }
  // canyons
  {
    const n = canyonField(x, z), C = CANYONS[n.id];
    if (C && n.d < C.halfW + 40) {
      const floor = basin(x, z) + lerp(C.f0, C.f1, clamp(n.s / C.length, 0, 1));
      const lim = floor + Math.max(0, n.d - C.halfW) * C.wall;
      // the cut fades out past the ends (the ravine head opens onto the mesa top)
      const endFade = smooth(-6, 4, n.s) * smooth(C.length + 8, C.length - 2, n.s);
      if (lim < h) { h = lerp(h, lim, endFade); if (n.d < C.halfW + 1) BH.canyon = endFade; }
    }
  }
  h += rim(x, z);
  return h;
}

// ---------------------------------------------------------------- paths
export const TRAILHEAD = { x: -60, z: 172, r: 24 };
// Graded desert tracks (dirt with gravel patches). `whoops`/`washboard`: [s0, s1] ranges in metres.
const ROAD_DEFS = [
  { name: 'Basin Loop', closed: true, width: 9, pts: [
    [-60, 172], [5, 105], [25, 5], [-30, -100], [-130, -190], [-265, -232], [-405, -205], [-505, -105], [-520, 40], [-485, 185],
    [-430, 290], [-395, 415], [-290, 470], [-150, 482], [-20, 445], [80, 452], [122, 420], [140, 330], [115, 232], [40, 195],
  ], washboard: [[260, 700], [1300, 1700]], whoops: [[2030, 2160]] },
  { name: 'Lakebed Road', width: 9, pts: [[-60, 172], [-135, 140], [-205, 75], [-255, 10], [-300, -40], [-400, -86], [-505, -105]], washboard: [[30, 200]] },
  { name: 'North Track', width: 8.5, pts: [[-405, -205], [-415, -310], [-370, -392], [-250, -432], [-110, -408], [-55, -300], [-30, -100]], washboard: [[300, 560]], whoops: [[700, 790]] },
  { name: 'Dune Road', width: 9, pts: [[25, 5], [90, -38], [190, -58], [300, -50], [400, -70], [480, -130]], whoops: [[150, 230]] },
  { name: 'Canyon Road', width: 9, pts: [[115, 232], [190, 224], [250, 222], [310, 220], [370, 222], [440, 228], [500, 200], [520, 100], [505, -10], [480, -130]] },
  { name: 'Saffron Spur', width: 8, pts: [[90, -38], [92, -76], [95, -110]] },
];
// Rated trails. kind 'crawl': graded corridor with rocks (rockKit); kind 'dunes': not graded at
// all, it follows the sand (marker posts, gates and the timer only).
const TRAIL_DEFS = [
  { name: 'Saffron Sea Crossing', diff: 'blue', kind: 'dunes', width: 10,
    waypoints: [[95, -112], [148, -185], [268, -277], [399, -318], [468, -170]] },
  { name: 'Coyote Wash', diff: 'green', width: 5.6, maxGrade: 0.2,
    pts: [[-140, 150], [-175, 200], [-200, 260], [-218, 330], [-236, 400], [-245, 468]] },
  { name: 'Whaleback Slickrock', diff: 'blue', width: 6, maxGrade: 0.42, follow: 0.7,
    pts: [[-420, 300], [-380, 330], [-330, 352], [-290, 345], [-250, 318], [-215, 300], [-185, 312], [-170, 345], [-176, 410], [-185, 478]] },
  { name: 'Knucklebone Canyon', diff: 'black', width: 5.2, maxGrade: 0.3,
    pts: [[318, 222], [330, 190], [324, 150], [340, 110], [328, 70], [338, 30], [330, -10], [316, -52]] },
  { name: 'Redwall Stairway', diff: 'dblack', width: 5.4, maxGrade: 0.34, steps: { seed: 77, from: 20, to: 14, every: 9.5, rise: [0.45, 0.62], depth: 3.4 },
    pts: [[114, 428], [140, 431], [170, 425], [198, 414], [225, 400], [250, 392], [272, 388], [292, 380]] },
];

// The dune route is found, not drawn: between hand-picked waypoints (the dune entry, a brink on
// each of three dunes, the far side) an A* search over a 3 m lattice of the raw sand surface picks
// a line a rig can drive: never steeper than 17° uphill, down a slip face only head-on (up to 34°),
// little side slope, preferring gentle going. So whatever the dune shapes are, the marked route is
// drivable, and it still climbs and drops off every dune it is sent over.
const ROUTE_LIMITS = { up: 0.3, down: 0.68, side: 0.24, step: 3 };
function duneRoute(wps) {
  const S = ROUTE_LIMITS.step, out = [];
  for (let w = 1; w < wps.length; w++) {
    const [ax, az] = wps[w - 1], [bx, bz] = wps[w];
    const x0 = Math.min(ax, bx) - 60, z0 = Math.min(az, bz) - 60, nx = Math.ceil((Math.max(ax, bx) + 60 - x0) / S), nz = Math.ceil((Math.max(az, bz) + 60 - z0) / S);
    const hgt = new Float32Array((nx + 1) * (nz + 1));
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) hgt[i * (nz + 1) + j] = baseHeight(x0 + i * S, z0 + j * S);
    const H_ = (i, j) => hgt[clamp(i, 0, nx) * (nz + 1) + clamp(j, 0, nz)];
    const id = (i, j) => i * (nz + 1) + j;
    const si = Math.round((ax - x0) / S), sj = Math.round((az - z0) / S), ti = Math.round((bx - x0) / S), tj = Math.round((bz - z0) / S);
    const g = new Float32Array((nx + 1) * (nz + 1)).fill(Infinity), from = new Int32Array((nx + 1) * (nz + 1)).fill(-1);
    const open = [[0, si, sj]]; g[id(si, sj)] = 0;
    const moves = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [1, 2], [-1, 2], [-2, 1], [-2, -1], [-1, -2], [1, -2], [2, -1]];
    const pop = () => { let b = 0; for (let k = 1; k < open.length; k++) if (open[k][0] < open[b][0]) b = k; const r = open[b]; open[b] = open[open.length - 1]; open.pop(); return r; };
    let found = false;
    while (open.length) {
      const [, i, j] = pop();
      if (i === ti && j === tj) { found = true; break; }
      const g0 = g[id(i, j)];
      for (const [di, dj] of moves) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a > nx || b > nz) continue;
        const L = Math.hypot(di, dj) * S, ga = (H_(a, b) - H_(i, j)) / L;
        if (ga > ROUTE_LIMITS.up || ga < -ROUTE_LIMITS.down) continue;
        // side slope at the midpoint, across the move
        const mi = (i + a) / 2, mj = (j + b) / 2, gx = (H_(Math.round(mi + 1), Math.round(mj)) - H_(Math.round(mi - 1), Math.round(mj))) / (2 * S), gz = (H_(Math.round(mi), Math.round(mj + 1)) - H_(Math.round(mi), Math.round(mj - 1))) / (2 * S);
        const ux = di / Math.hypot(di, dj), uz = dj / Math.hypot(di, dj), side = Math.abs(-gx * uz + gz * ux);
        if (side > ROUTE_LIMITS.side * (ga < -0.36 ? 0.5 : 1)) continue; // head-on down a slip face
        const c = g0 + L * (1 + 1.5 * Math.max(0, ga) + 0.6 * Math.max(0, -ga - 0.3) + 1.2 * side);
        if (c < g[id(a, b)]) { g[id(a, b)] = c; from[id(a, b)] = id(i, j); open.push([c + Math.hypot(a - ti, b - tj) * S, a, b]); }
      }
    }
    if (!found) throw new Error(`dune route: no drivable line from ${wps[w - 1]} to ${wps[w]}`);
    const seg = [];
    for (let k = id(ti, tj); k >= 0; k = from[k]) seg.push([x0 + Math.floor(k / (nz + 1)) * S, z0 + (k % (nz + 1)) * S]);
    seg.reverse();
    // keep every third node as a control point (and both ends)
    for (let k = w > 1 ? 1 : 0; k < seg.length; k++) if (k % 3 === 0 || k === seg.length - 1) out.push(seg[k]);
  }
  return out;
}

function buildPath(def, kind, prior) {
  const isRoad = kind === 'road';
  const closed = !!def.closed;
  if (def.waypoints) def = { ...def, pts: duneRoute(def.waypoints) };
  const pts = catmull(def.pts, 2, closed);
  const L = arcLength(pts);
  const n = pts.length;
  const raw = pts.map((p) => baseHeight(p.x, p.z));
  const width = def.width ?? 5.5;
  if (def.kind === 'dunes') {
    pts.forEach((p, i) => { p.h = raw[i]; });
    return { ...def, kind, pts, length: L, width, shoulder: 0, graded: false };
  }
  const win = isRoad ? 10 : def.follow ? 2 : 4;
  const at = (i) => (closed ? raw[((i % n) + n) % n] : raw[clamp(i, 0, n - 1)]);
  let hs = raw.map((_, i) => { let a = 0; for (let k = -win; k <= win; k++) a += at(i + k); return a / (2 * win + 1); });
  if (def.follow) hs = hs.map((h, i) => lerp(h, raw[i], def.follow));
  const maxG = def.maxGrade ?? (isRoad ? 0.11 : 0.3);
  // ends pinned to the path they meet (earlier paths), so junctions have no step
  const pinAt = (x, z) => {
    let best = 12, h = null;
    for (const q of prior) for (const p of q.pts) { const d = Math.hypot(p.x - x, p.z - z); if (d < best) { best = d; h = p.h; } }
    if (Math.hypot(x - TRAILHEAD.x, z - TRAILHEAD.z) < TRAILHEAD.r + 6) h = TRAILHEAD.y;
    return h;
  };
  if (closed) {
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 1; i <= n; i++) { const j = i % n, k = i - 1, ds = 2; hs[j] = clamp(hs[j], hs[k] - maxG * ds, hs[k] + maxG * ds); }
      for (let i = n - 2; i >= -1; i--) { const j = (i + n) % n, k = (i + 1) % n, ds = 2; hs[j] = clamp(hs[j], hs[k] - maxG * ds, hs[k] + maxG * ds); }
    }
    // the trailhead lot is level
    pts.forEach((p, i) => { const w = smooth(TRAILHEAD.r + 40, TRAILHEAD.r, Math.hypot(p.x - TRAILHEAD.x, p.z - TRAILHEAD.z)); hs[i] = lerp(hs[i], TRAILHEAD.y, w); });
  } else {
    const r0 = pinAt(pts[0].x, pts[0].z), r1 = pinAt(pts[n - 1].x, pts[n - 1].z);
    const p0 = r0 !== null, p1 = r1 !== null;
    for (let pass = 0; pass < 14; pass++) {
      if (p0) hs[0] = r0; if (p1) hs[n - 1] = r1;
      for (let i = 1; i < (p1 ? n - 1 : n); i++) { const ds = pts[i].s - pts[i - 1].s; hs[i] = clamp(hs[i], hs[i - 1] - maxG * ds, hs[i - 1] + maxG * ds); }
      for (let i = n - 2; i >= (p0 ? 1 : 0); i--) { const ds = pts[i + 1].s - pts[i].s; hs[i] = clamp(hs[i], hs[i + 1] - maxG * ds, hs[i + 1] + maxG * ds); }
    }
    if (p0 || p1) {
      const h0 = hs[0], h1 = hs[n - 1];
      hs = hs.map((h, i) => { const s = pts[i].s; let v = h; if (p0) v = lerp(h0, v, smooth(0, 14, s)); if (p1) v = lerp(h1, v, smooth(0, 14, L - s)); return v; });
      for (let pass = 0; pass < 6; pass++) {
        for (let i = 1; i < n - 1; i++) { const ds = pts[i].s - pts[i - 1].s; hs[i] = clamp(hs[i], hs[i - 1] - maxG * ds, hs[i - 1] + maxG * ds); }
        for (let i = n - 2; i >= 1; i--) { const ds = pts[i + 1].s - pts[i].s; hs[i] = clamp(hs[i], hs[i + 1] - maxG * ds, hs[i + 1] + maxG * ds); }
      }
    }
  }
  // Step-ups (the Redwall Stairway): part of the climb is taken out of the tread and put back as
  // rock steps, each a ramp `depth` long hidden under its slab (generateRocks puts a flat-topped
  // slab on it, its face at the foot), so the treads between are gentler and a staircase really
  // climbs. Each rise is capped for the tread grade it sits on (stepCap, as on the Trail Park).
  let steps = null;
  if (def.steps) {
    const R = rng(def.steps.seed), sp = def.steps;
    const idx = (s) => { let i = 0; while (i < n - 1 && pts[i].s < s) i++; return i; };
    const g0 = (s) => { const a = idx(s - 3), b = idx(s + 4); return Math.abs(hs[b] - hs[a]) / Math.max(1, pts[b].s - pts[a].s); };
    steps = [];
    for (let s = sp.from; s < L - sp.to; s += sp.every * (0.85 + R() * 0.3)) steps.push({ s, rise: Math.min(lerp(sp.rise[0], sp.rise[1], R()), stepCap(Math.max(0, g0(s) - 0.08))), depth: sp.depth });
    const Rtot = steps.reduce((a, q) => a + q.rise, 0), sA = steps[0].s, sB = steps.at(-1).s + sp.depth;
    hs = hs.map((h, i) => {
      const s = pts[i].s;
      let cum = 0; for (const q of steps) cum += q.rise * clamp((s - q.s) / q.depth, 0, 1);
      return h - Rtot * clamp((s - sA) / (sB - sA), 0, 1) + cum;
    });
  }
  pts.forEach((p, i) => { p.h = hs[i]; p.g = 0; });
  for (let i = 1; i < n; i++) pts[i].g = (pts[i].h - pts[i - 1].h) / Math.max(1e-6, pts[i].s - pts[i - 1].s);
  // the tread grade without the step ramps (for the slabs' tops)
  if (steps) for (let i = 1; i < n; i++) { const s = pts[i].s; const onStep = steps.find((q) => s > q.s - 0.5 && s <= q.s + q.depth + 2.5); if (onStep) pts[i].g = pts[i - 1].g; }
  return { ...def, kind, pts, length: L, width, shoulder: isRoad ? 7 : 4, graded: true, steps };
}
// tallest step a skilled driver can still walk a 0.45-0.5 m tyre up at this grade (the Trail
// Park's table, from test/ledgegrade.mjs: the Cruiser walks 0.7 m on the flat, 0.6 at 20%, 0.5 at
// 30%, 0.3 at 38%)
function stepCap(g) { return g < 0.2 ? 0.65 : g < 0.3 ? lerp(0.65, 0.48, (g - 0.2) / 0.1) : g < 0.38 ? lerp(0.48, 0.26, (g - 0.3) / 0.08) : 0.22; }

TRAILHEAD.y = basin(TRAILHEAD.x, TRAILHEAD.z) + 0.2;
export const ROADS = [];
for (const d of ROAD_DEFS) ROADS.push(buildPath(d, 'road', ROADS));
export const TRAILS = [];
for (const d of TRAIL_DEFS) TRAILS.push(buildPath(d, 'trail', ROADS));
const PATHS = [...ROADS, ...TRAILS];
const GRADED = PATHS.filter((p) => p.graded);

// ---------------------------------------------------------------- baked grid
const grid = makeGrid(SIZE, RES);
const { N1, CELL } = grid;
export const { GRID, heightAt, visualHeightAt, materialAt } = grid;
// what the ground shows off the paths (read by gfx/terrain_look.js visualSurface): desert floor,
// gravel pavement, rock on the slickrock, cliffs and outcrops; 255 = let the default decide
GRID.look = new Uint8Array(N1 * N1).fill(255);
// sand depth 0..1 per grid vertex (deep in the dunes, a dusting in the washes); deepsand.js
const SAND_DEPTH = new Uint8Array(N1 * N1);
export function sandDepthAt(x, z) {
  const fx = clamp((x + S2) / CELL, 0, RES - 1e-6), fz = clamp((z + S2) / CELL, 0, RES - 1e-6);
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const a = SAND_DEPTH[ix * N1 + iz], b = SAND_DEPTH[(ix + 1) * N1 + iz], c = SAND_DEPTH[ix * N1 + iz + 1], d = SAND_DEPTH[(ix + 1) * N1 + iz + 1];
  return (a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz) / 255;
}
const sp = TRAILS[0]; // the dune route (start at the trail's first point)
export const SPAWN = (() => { const yaw = Math.atan2(-(5 - TRAILHEAD.x), -(105 - TRAILHEAD.z)); return { x: TRAILHEAD.x + 4, z: TRAILHEAD.z - 4, yaw }; })();

const bump = (d, r) => (d >= r ? 0 : (1 - (d / r) ** 2) ** 2);
const RELIEF = {
  green:  { lumps: 0.05, holes: [10, 0.25, 0.08, 1.2] },
  blue:   { lumps: 0.08, holes: [9, 0.3, 0.1, 1.2] },
  black:  { lumps: 0.12, holes: [8, 0.3, 0.13, 1.1] },
  dblack: { lumps: 0.12, holes: [8, 0.3, 0.13, 1.1] },
};
function inRanges(s, ranges) { return ranges && ranges.some(([a, b]) => s >= a && s <= b); }
function rangeEase(s, ranges, e = 15) { let w = 0; for (const [a, b] of ranges || []) w = Math.max(w, smooth(a, a + e, s) * smooth(b, b - e, s)); return w; }

function bake() {
  const B = 24, nb = Math.ceil(SIZE / B);
  const bins = Array.from({ length: nb * nb }, () => []);
  GRADED.forEach((p) => {
    const pi = PATHS.indexOf(p);
    for (let i = 1; i < p.pts.length; i++) {
      const a = p.pts[i - 1], b = p.pts[i];
      const reach = p.width / 2 + p.shoulder + 1;
      const x0 = Math.floor((Math.min(a.x, b.x) - reach + S2) / B), x1 = Math.floor((Math.max(a.x, b.x) + reach + S2) / B);
      const z0 = Math.floor((Math.min(a.z, b.z) - reach + S2) / B), z1 = Math.floor((Math.max(a.z, b.z) + reach + S2) / B);
      for (let bx = Math.max(0, x0); bx <= Math.min(nb - 1, x1); bx++) for (let bz = Math.max(0, z0); bz <= Math.min(nb - 1, z1); bz++) bins[bx * nb + bz].push([pi, i]);
    }
  });
  const perPath = new Map();
  // the raw landscape once per vertex, with its natural-surface flags
  const n1 = N1 * N1, BASE = new Float32Array(n1), FS = new Float32Array(n1), FW = new Float32Array(n1), FR = new Float32Array(n1), FC = new Float32Array(n1);
  for (let ix = 0; ix <= RES; ix++) for (let iz = 0; iz <= RES; iz++) {
    const k = ix * N1 + iz;
    BASE[k] = baseHeight(-S2 + ix * CELL, -S2 + iz * CELL); FS[k] = BH.sand; FW[k] = BH.wash; FR[k] = BH.rock; FC[k] = BH.canyon;
  }
  const B_ = (ix, iz) => BASE[clamp(ix, 0, RES) * N1 + clamp(iz, 0, RES)];
  for (let ix = 0; ix <= RES; ix++) {
    const x = -S2 + ix * CELL;
    for (let iz = 0; iz <= RES; iz++) {
      const z = -S2 + iz * CELL;
      const idx = ix * N1 + iz;
      let h = BASE[idx];
      const sand = FS[idx], wash = FW[idx], rockQ = FR[idx], canyon = FC[idx];
      h += lumps(x, z, sand > 0.2 ? 0.02 : 0.1) * (1 - rockQ);
      // trailhead lot: level
      const dTH = Math.hypot(x - TRAILHEAD.x, z - TRAILHEAD.z), wTH = 1 - smooth(TRAILHEAD.r, TRAILHEAD.r + 16, dTH);
      h = lerp(h, TRAILHEAD.y + fbm(x * 0.2, z * 0.2, 2) * 0.05, wTH);
      // natural surface
      const slope = Math.hypot(B_(ix + 1, iz) - B_(ix - 1, iz), B_(ix, iz + 1) - B_(ix, iz - 1)) / (4 * CELL / 2);
      const nz = fbm(x * 0.02 + 9, z * 0.02 - 4, 3), nfine = fbm(x * 0.09 - 2, z * 0.09 + 6, 2);
      let mat, look = 255, depth = 0;
      if (sand > 0.12 && slope < 1.0) { mat = MAT.SAND; depth = clamp((sand - 0.12) * 1.6, 0, 1); }
      else if (rockQ > 0.5 || slope > 0.85) { mat = MAT.ROCK; look = MAT.ROCK; }
      else if (playaQ(x, z) < 1.02) { mat = MAT.ROAD; }
      else if (wash > 0.3) { mat = MAT.SAND; depth = 0.25 * wash; }
      else if (slope > 0.5) { mat = nz > -0.1 ? MAT.ROCK : MAT.GRAVEL; look = nz > -0.1 ? MAT.ROCK : MAT.GRAVEL; }
      else { mat = nz + nfine * 0.3 > 0.18 ? MAT.GRAVEL : MAT.DIRT; look = mat; }
      if (canyon > 0.5 && mat !== MAT.ROCK) { mat = MAT.GRAVEL; look = MAT.GRAVEL; }
      // nearest graded path(s)
      perPath.clear();
      const bin = bins[Math.floor((x + S2) / B) * nb + Math.floor((z + S2) / B)] || [];
      for (const [pi, i] of bin) {
        const p = PATHS[pi], a = p.pts[i - 1], b = p.pts[i];
        const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
        const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / L2, 0, 1);
        const d = Math.hypot(x - (a.x + ex * t), z - (a.z + ez * t));
        if (d > p.width / 2 + p.shoulder) continue;
        const prev = perPath.get(pi);
        if (!prev || d < prev.d) {
          const Ls = Math.sqrt(L2);
          perPath.set(pi, { d, pi, lat: ((x - a.x) * -ez + (z - a.z) * ex) / Ls, s: lerp(a.s, b.s, t), ph: lerp(a.h, b.h, t), score: d - (p.kind === 'road' ? 1.5 : 0) });
        }
      }
      let best = null;
      for (const c of perPath.values()) if (!best || c.score < best.score) best = c;
      let pathId = -1;
      if (best) {
        let num = 0, den = 0, W = 0;
        for (const c of perPath.values()) {
          const q = PATHS[c.pi], qhw = q.width / 2;
          const w = 1 - smooth(qhw, qhw + q.shoulder, c.d);
          if (w <= 0) continue;
          let surf = c.ph;
          if (q.kind === 'road') {
            surf -= Math.min(1, c.d / qhw) ** 2 * 0.1; // crown
            const ease = q.closed ? 1 : smooth(0, 10, Math.min(c.s, q.length - c.s));
            // washboard on the long straights: a ~4.6 m corrugation the 2 m grid samples unevenly
            surf += 0.035 * Math.sin(c.s * 1.37) * rangeEase(c.s, q.washboard) * ease;
            // whoops: rounded humps about 9 m apart
            surf += 0.26 * (0.5 - 0.5 * Math.cos((2 * PI * c.s) / 9.5)) * rangeEase(c.s, q.whoops, 12) * ease;
            surf += lumps(x, z, 0.025) + potholes(x, z, 14, 0.25, 0.08, 1.4, 3) * ease;
          } else {
            // (no relief in front of or under a step: the step height must be what it says)
            const ends = smooth(0, 10, Math.min(c.s, q.length - c.s)) * (q.steps && q.steps.some((st) => c.s > st.s - 2.5 && c.s < st.s + st.depth + 1.2) ? 0 : 1), rl = RELIEF[q.diff];
            surf += lumps(x, z, rl.lumps) * ends + potholes(x, z, rl.holes[0], rl.holes[1], rl.holes[2], rl.holes[3], c.pi * 17) * ends;
          }
          const ww = w * w * (q.kind === 'road' ? 2 : 1);
          num += surf * ww; den += ww; W = Math.max(W, w);
        }
        if (den > 0) h = lerp(h, num / den, W);
        const p = PATHS[best.pi], hw = p.width / 2;
        if (best.d < hw + 0.5) {
          pathId = best.pi; depth = 0;
          if (p.kind === 'road') {
            const onPlaya = playaQ(x, z) < 1.0;
            mat = onPlaya || nfine <= 0.3 ? MAT.ROAD : MAT.GRAVEL; // graded tracks: pale compacted clay with loose gravel patches
            if (canyon > 0.3) mat = MAT.GRAVEL;
          } else {
            const tn = fbm(x * 0.15 + 3, z * 0.15, 2);
            mat = p.diff === 'green' ? (tn > 0.15 ? MAT.GRAVEL : MAT.DIRT)
              : p.diff === 'blue' ? (p.follow ? (tn > 0.45 ? MAT.GRAVEL : MAT.ROCK) : (tn > 0.2 ? MAT.DIRT : MAT.ROCK))
              : (tn > 0.4 ? MAT.GRAVEL : MAT.ROCK);
          }
        } else if (W > 0.3 && (mat === MAT.SAND)) { depth *= 1 - W; }
      }
      if (wTH > 0.5) { mat = MAT.GRAVEL; depth = 0; look = MAT.GRAVEL; }
      GRID.h[idx] = h; GRID.vis[idx] = h; GRID.mat[idx] = mat; GRID.path[idx] = pathId; GRID.look[idx] = look;
      SAND_DEPTH[idx] = Math.round(clamp(mat === MAT.SAND ? depth : 0, 0, 1) * 255);
    }
  }
}
bake();
// Dune readability (GRID.tone, read by gfx/terrain_look.js as one or two calm steps darker): the
// hollows between the dunes half a step darker. The view shades the sand by its real slope and
// the sun (src/desert/view.js sharpenDuneShading): lit windward faces, shaded slip faces, lighter
// crests, so a crest and the slip face beyond it read from the chase camera and from afar.
{
  const n1 = N1 * N1, src = GRID.h, tmp = new Float32Array(n1), avg = new Float32Array(n1), r = 8;
  for (let ix = 0; ix <= RES; ix++) for (let iz = 0; iz <= RES; iz++) { let s = 0; for (let k = -r; k <= r; k++) s += src[ix * N1 + clamp(iz + k, 0, RES)]; tmp[ix * N1 + iz] = s / (2 * r + 1); }
  for (let ix = 0; ix <= RES; ix++) for (let iz = 0; iz <= RES; iz++) { let s = 0; for (let k = -r; k <= r; k++) s += tmp[clamp(ix + k, 0, RES) * N1 + iz]; avg[ix * N1 + iz] = s / (2 * r + 1); }
  for (let ix = 1; ix < RES; ix++) for (let iz = 1; iz < RES; iz++) {
    const k = ix * N1 + iz;
    if (GRID.mat[k] !== MAT.SAND || GRID.path[k] >= 0) continue;
    const g = Math.hypot(src[k + N1] - src[k - N1], src[k + 1] - src[k - 1]) / (4 * CELL / 2);
    const hollow = avg[k] - src[k];
    GRID.tone[k] = g < 0.3 && hollow > 0.8 ? 70 : 0;
  }
}

// ---------------------------------------------------------------- named places (spawns.js PLACES)
// { id, name, note, x, z, yaw } (spawns.js nudges each a few metres if needed); sign: where the
// place's signpost stands (src/desert/props.js landmarkSigns)
const placeAt = (x, z, tx, tz) => ({ x, z, yaw: Math.atan2(-(tx - x), -(tz - z)) });
export const PLACES = [
  { id: 'bonewhite-flat', name: 'Bonewhite Flat', note: 'The dry lake: hard, flat and fast', ...placeAt(-320, -105, -440, -60), sign: [-282, -22], signSub: 'Dry lake' },
  { id: 'saffron-sea', name: 'Saffron Sea: dune entry', note: 'Air down (T) before the sand. Momentum and smooth throttle', ...placeAt(82, -98, 140, -170) },
  { id: 'practice-dune', name: 'Practice Dune', note: 'One 15° dune face to learn on: try it aired up and aired down', x: PRACTICE.x - 30 * PRACTICE.dir[0], z: PRACTICE.z - 30 * PRACTICE.dir[1], yaw: Math.atan2(-PRACTICE.dir[0], -PRACTICE.dir[1]),
    sign: [PRACTICE.x - 14 * PRACTICE.dir[0] + 26 * PRACTICE.dir[1], PRACTICE.z - 14 * PRACTICE.dir[1] - 26 * PRACTICE.dir[0]], signSub: '15° face · air down' },
  { id: 'saffron-deep', name: 'Saffron Sea: deep sand', note: 'In among the big dunes. Aired down?', ...placeAt(323.7, -339.2, 420, -330) },
  { id: 'canyon-gap', name: 'Canyon Gap', note: 'The canyon road between the mesas', ...placeAt(250, 222, 330, 220) },
  { id: 'eagle-point', name: 'Eagle Point', note: 'Viewpoint on Redwall Mesa, top of the Stairway', ...placeAt(218, 352, 100, 300), sign: [212, 344], signSub: 'Redwall Mesa' },
];

// ---------------------------------------------------------------- camp props (box colliders)
// Sunfall Station, the old fuel stop on the south side of the trailhead lot, clear of the roads.
// { kind, x, y, z, hx, hy, hz, rotY }: box centre and half extents (src/desert/props.js draws them)
export const PROPS = [];
{
  const put = (kind, x, z, hx, hy, hz, rotY = 0) => PROPS.push({ kind, x, y: heightAt(x, z) + hy - 0.05, z, hx, hy, hz, rotY });
  put('camp-shack', -70, 201, 3.2, 1.6, 2.3, 0.12);
  for (const [dx, dz] of [[-3, -2], [3, -2], [-3, 2], [3, 2]]) put('camp-post', -48 + dx, 203 + dz, 0.12, 1.8, 0.12);
  put('camp-pump', -49.5, 203, 0.35, 0.8, 0.25); put('camp-pump', -46.5, 203, 0.35, 0.8, 0.25);
  put('camp-tank', -91, 191, 1.3, 3.4, 1.3);
  put('camp-trailer', -93, 207, 1.2, 1.45, 3.3, 0.5);
}
// road signs at the junctions (src/desert/props.js roadSigns): road, s (m, negative from the end)
export const SIGNS = [
  { road: 'Lakebed Road', s: 34, title: 'Bonewhite Flat', sub: 'Dry lake' },
  { road: 'Dune Road', s: 22, title: 'Saffron Sea', sub: 'Dunes · Practice dune' },
  { road: 'Saffron Spur', s: 10, title: 'Dune entry', sub: 'Air down before the sand' },
  { road: 'Canyon Road', s: 18, title: 'Canyon Road', sub: 'Anvil and Redwall mesas' },
  { road: 'Basin Loop', s: 36, title: 'Basin Loop', sub: 'Round the basin' },
  { road: 'Basin Loop', s: -40, title: 'Sunfall Station', sub: 'Camp · Fuel', side: -1 },
];

// ---------------------------------------------------------------- rocks
function onAnyPath(x, z, margin) {
  for (const p of PATHS) for (let i = 0; i < p.pts.length; i += 2) if (Math.hypot(p.pts[i].x - x, p.pts[i].z - z) < p.width / 2 + margin) return true;
  return Math.hypot(x - TRAILHEAD.x, z - TRAILHEAD.z) < TRAILHEAD.r + margin;
}
// The crawls' rock, by rating (the terms of the Trail Park's trails): boulders crowd the corridor
// edges (alternating sides, so there is always a line), up-and-down ledges span it, embedded
// low domes make the relief in the wheel tracks; the black slot adds a meandering lane with V-notches
// and crawl rocks in the tyre tracks; the double black is a staircase of step-up slabs. Every step
// height is capped for the grade it sits on (stepCap).
const CRAWL = {
  green:  { every: 7,   min: 0.25, max: 0.6, top: 0.18, ledgeEvery: 30, ledgeH: [0.1, 0.17], embed: { every: 3.4, size: [0.3, 0.6], proud: [0.05, 0.11] }, rubble: 5 },
  blue:   { every: 6,   min: 0.4,  max: 1.0, top: 0.4,  ledgeEvery: 24, ledgeH: [0.28, 0.42], embed: { every: 2.6, size: [0.35, 0.8], proud: [0.07, 0.16] }, rubble: 4 },
  black:  { every: 2.6, min: 0.7,  max: 1.6, top: 0.7,  ledgeEvery: 13, ledgeH: [0.45, 0.6], lane: 1.4, notch: 0.18, notchTop: 0.5, crawl: 0.6, crawlTop: 0.36, embed: { every: 1.6, size: [0.4, 0.9], proud: [0.1, 0.22] }, rubble: 2.5 },
  dblack: { every: 3.2, min: 0.8,  max: 1.8, top: 0.8,  embed: { every: 2.2, size: [0.4, 0.9], proud: [0.08, 0.18] }, rubble: 2.5 },
};
function crawlRocks(rocks, R) {
  const kit = rockKit(R, heightAt), { shape, put, reach, ledge } = kit;
  const out = []; // step slabs
  const grade = (t, s) => { let g = 0; for (let q = -3; q < 3; q += 0.5) g = Math.max(g, Math.abs(pathPoint(t, s + q + 0.5).h - pathPoint(t, s + q).h) / 0.5); return g; };
  const E = rockKit(rng(9300), heightAt);
  for (const t of TRAILS.filter((q) => q.graded)) {
    const sp = CRAWL[t.diff], hw = t.width / 2;
    const nearStep = (s, a = 2.6, b = 1.2) => t.steps && t.steps.some((st) => s > st.s - a && s < st.s + st.depth + b);
    const lane = (s) => (sp.lane ? (hw - sp.lane - 0.1) * Math.sin(s * (Math.PI * 2 / 55) + 1.3) * smooth(6, 20, Math.min(s, t.length - s)) : 0);
    // step-up slabs (the staircase): the face at the foot of each ramp, the top flush with the tread
    if (t.steps) for (const st of t.steps) {
      const p = pathPoint(t, st.s), hwS = hw + 2.1, pts = [];
      let lo = 0; while (lo < t.pts.length - 1 && t.pts[lo + 1].s < st.s) lo++;
      const g = t.pts[lo].g, zf = -(st.rise + 0.35) * 0.62;
      for (const sx of [-1, 1]) {
        for (const zt of [0, 0.06]) pts.push(sx * hwS * (0.93 + R() * 0.07), st.rise + R() * 0.02 + g * zt, zt + R() * 0.06);
        pts.push(sx * hwS, g * zf - 0.35, zf);
        pts.push(sx * hwS * (0.95 + R() * 0.05), st.rise + g * (st.depth + 0.2) + 0.02, st.depth + 0.2);
        pts.push(sx * hwS, st.rise + g * (st.depth + 0.7) - 0.45, st.depth + 0.7);
      }
      for (let i = 0; i < 5; i++) { const zz = 0.4 + R() * (st.depth - 0.4); pts.push((R() * 2 - 1) * hwS * 0.8, st.rise + g * zz + 0.01 + R() * 0.02, zz); }
      out.push({ x: p.x, y: p.h, z: p.z, rotY: Math.atan2(p.tx, p.tz), pts, ledge: true, step: { trail: t.name, s: st.s, rise: st.rise } });
      // big rocks lock the slab ends so the step can't be driven round
      for (const sd of [-1, 1]) { const r = shape(1.1 + R() * 0.4, 0.9), q = pathPoint(t, st.s + st.depth * 0.5); const c = sd * (hw + 2.1 + reach(r, q.tz * sd, -q.tx * sd) * 0.5); put(r, q.x - q.tz * c, q.z + q.tx * c, true); }
    }
    let side = 1, nextLedge = sp.ledgeEvery ? 14 : Infinity;
    for (let s = 10; s < t.length - 8; s += sp.every * (0.7 + R() * 0.6)) {
      if (nearStep(s, 4, 2.5)) continue;
      const p = pathPoint(t, s), nx = -p.tz, nz = p.tx, g = grade(t, s), lc = lane(s);
      if (s > nextLedge) {
        const top = Math.min(lerp(sp.ledgeH[0], sp.ledgeH[1], R()), stepCap(g));
        const depth = 3.2 + R() * 1.2;
        if (top >= 0.1) { ledge(p.x, p.z, Math.atan2(p.tx, p.tz), t.width + 2.4, depth, top); s += depth / 2 + 1.5; }
        nextLedge = s + Math.max(7.5, sp.ledgeEvery * (0.75 + R() * 0.5));
        continue;
      }
      if (sp.notch && R() < sp.notch) { // V-notch: two sloping rocks either side of the lane centre
        const sz = 1.1 + R() * 0.35, top = Math.min(sp.notchTop, stepCap(g));
        for (const sd of [1, -1]) { const r = shape(sz, 0.55, 0.3, top); const c = lc + sd * (0.5 + reach(r, -nx * sd, -nz * sd)); put(r, p.x + nx * c, p.z + nz * c, true); }
        s += 1.5; continue;
      }
      { // boulders crowd the corridor edge (the lane edge on the black), alternating sides
        const r = shape(sp.min + Math.pow(R(), 1.5) * (sp.max - sp.min), 0.85, 0.35, sp.top);
        const edge = sp.lane ? sp.lane + 0.0 : hw - 0.2;
        const c = lc + side * (edge + reach(r, -nx * side, -nz * side));
        put(r, p.x + nx * c, p.z + nz * c, true);
        side = -side;
      }
      if (sp.crawl && R() < sp.crawl) { const r = shape(0.35 + R() * 0.3, 0.8, 0.35, Math.min(sp.crawlTop, stepCap(g))); const c = lc + (R() < 0.5 ? -1 : 1) * (0.75 + R() * 0.25); put(r, p.x + nx * c, p.z + nz * c, true); }
      if (R() < 0.6) { const sd = R() < 0.5 ? -1 : 1, r = shape(0.5 + R() * 0.9, 0.8); const c = sd * (hw + 0.3 + reach(r, -nx * sd, -nz * sd) * (0.9 + R() * 0.3)); put(r, p.x + nx * c, p.z + nz * c, true); }
    }
    // embedded relief in the tread (mostly the wheel tracks) and rubble beside it
    const e = sp.embed;
    for (let s = 8; s < t.length - 6; s += e.every * (0.6 + R() * 0.8)) {
      if (nearStep(s, 3, 1.5)) continue;
      const p = pathPoint(t, s), lat = R() < 0.7 ? (R() < 0.5 ? -1 : 1) * (0.8 + (R() - 0.5) * 0.6) : (R() * 2 - 1) * (hw - 0.4);
      const x = p.x - p.tz * lat, z = p.z + p.tx * lat;
      if (out.concat(kit.rocks).some((r) => r.ledge && Math.hypot(r.x - x, r.z - z) < 4.2)) continue;
      const k = R(); E.embedded(x, z, lerp(e.size[0], e.size[1], k), lerp(e.proud[0], e.proud[1], 0.3 * R() + 0.7 * k));
    }
    for (let s = 6; s < t.length - 4; s += sp.rubble * (0.6 + R() * 0.8)) {
      const p = pathPoint(t, s), lat = (R() < 0.5 ? -1 : 1) * (hw + 0.7 + R() * 3.2), x = p.x - p.tz * lat, z = p.z + p.tx * lat;
      if (!onAnyPath(x, z, 0.5)) E.embedded(x, z, 0.4 + R() * 0.7, 0.08 + R() * 0.17);
    }
  }
  for (const r of [...out, ...kit.rocks, ...E.rocks]) rocks.push(r);
}
// Landmarks built of rock hulls (fixed colliders, drawn by the rock renderer, so what you see is
// what you hit): Keyhole Arch, a free-standing sandstone arch you can drive under, and the
// hoodoos of Goblin Row, stone pillars with wider caprocks.
export const LANDMARKS = { arch: { x: -170, z: -300, rotY: 0.5, span: 16, height: 13, thick: 3.2, depth: 4.2 }, hoodoos: { x: -300, z: -335, n: 9, r: 34 } };
function box(cx, cy, cz, hx, hy, hz, R, jag = 0.12) {
  const pts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push(cx + sx * hx * (1 - R() * jag), cy + sy * hy * (1 - R() * jag), cz + sz * hz * (1 - R() * jag));
  return pts;
}
function landmarkRocks(rocks, R) {
  const A = LANDMARKS.arch, g = heightAt(A.x, A.z), half = A.span / 2 + A.thick / 2;
  const piece = (lx, ly, pts) => { const c = Math.cos(A.rotY), s = Math.sin(A.rotY); rocks.push({ x: A.x + lx * c, y: g + ly, z: A.z - lx * s, rotY: A.rotY, pts, landmark: 'arch' }); };
  // two legs, sunk a metre into the ground, then the span as ten wedges round a flattened arc
  for (const sd of [-1, 1]) piece(sd * half, 0, box(0, (A.height - 4) / 2 - 1, 0, A.thick / 2 + 0.4, (A.height - 4) / 2 + 1, A.depth / 2 + 0.3, R));
  const N = 10, rise = 4.5, base = A.height - rise - 1.2;
  for (let k = 0; k < N; k++) {
    const a0 = Math.PI * (k / N), a1 = Math.PI * ((k + 1) / N), pts = [];
    for (const a of [a0, a1]) for (const rr of [0, A.thick]) {
      const ox = -Math.cos(a) * (half - A.thick / 2 + rr), oy = base + Math.sin(a) * (rise + rr * 0.6);
      for (const sz of [-1, 1]) pts.push(ox, oy + (rr ? 1.2 : 0), sz * A.depth / 2 * (0.9 + R() * 0.1));
    }
    piece(0, 0, pts);
  }
  // hoodoos: a tapering pillar and a caprock on top, sunk into a talus mound
  const Hh = LANDMARKS.hoodoos;
  for (let k = 0; k < Hh.n; k++) {
    const a = k * 2.399 + R() * 0.4, d = Hh.r * Math.sqrt((k + 0.5) / Hh.n), x = Hh.x + Math.cos(a) * d, z = Hh.z + Math.sin(a) * d;
    if (onAnyPath(x, z, 8)) continue;
    const h = 5 + R() * 6, r = 0.9 + R() * 0.6, y0 = heightAt(x, z) - 0.8, pts = [];
    for (let i = 0; i < 7; i++) { const t = (i / 7) * Math.PI * 2; for (const [yy, rr] of [[0, r * 1.5], [h * 0.5, r], [h, r * 0.75]]) pts.push(Math.cos(t) * rr * (0.85 + R() * 0.3), yy, Math.sin(t) * rr * (0.85 + R() * 0.3)); }
    rocks.push({ x, y: y0, z, rotY: R() * 6.28, pts, landmark: 'hoodoo' });
    const cap = [], cr = r * (1.5 + R() * 0.5), ch = 0.9 + R() * 0.7;
    for (let i = 0; i < 8; i++) { const t = (i / 8) * Math.PI * 2; for (const yy of [0, ch]) cap.push(Math.cos(t) * cr * (0.8 + R() * 0.3), yy * (0.9 + R() * 0.2), Math.sin(t) * cr * (0.8 + R() * 0.3)); }
    rocks.push({ x, y: y0 + h - 0.1, z, rotY: R() * 6.28, pts: cap, landmark: 'hoodoo' });
  }
}
export function generateRocks() {
  const R = rng(9100);
  const { rocks, boulder } = rockKit(R, heightAt);
  crawlRocks(rocks, rng(9200));
  landmarkRocks(rocks, rng(9400));
  // scattered boulders on the desert floor and under the cliffs (none on the sand or the lake)
  for (let i = 0, n = 0; i < 6000 && n < 520; i++) {
    const x = (R() * 2 - 1) * 540, z = (R() * 2 - 1) * 540;
    const m = materialAt(x, z);
    if (m === MAT.SAND || m === MAT.ROAD || onAnyPath(x, z, 4)) continue;
    const g = Math.hypot(heightAt(x + 2, z) - heightAt(x - 2, z), heightAt(x, z + 2) - heightAt(x, z - 2)) / 4;
    if (R() > (g > 0.3 ? 0.9 : 0.25)) continue;
    boulder(x, z, 0.5 + Math.pow(R(), 2) * (g > 0.3 ? 3.2 : 1.8), 0.75);
    n++;
  }
  return rocks;
}

// The big plants have colliders (a trunk cylinder, buildTerrainPhysics): column cacti on the
// fans below the rim and around the camp, forked yucca trees on the north-west plain, dead snags
// along the washes. kind picks the model in src/desert/view.js. All kept well off every path.
export function generateTrees() {
  const R = rng(4300);
  const out = [];
  const ok = (x, z, margin) => {
    const m = materialAt(x, z);
    if (m === MAT.SAND || m === MAT.ROAD || m === MAT.ROCK || onAnyPath(x, z, margin)) return false;
    const g = Math.hypot(heightAt(x + 2, z) - heightAt(x - 2, z), heightAt(x, z + 2) - heightAt(x, z - 2)) / 4;
    return g < 0.25 && !out.some((t) => Math.abs(t.x - x) < 3 && Math.abs(t.z - z) < 3);
  };
  for (let i = 0; i < 9000 && out.length < 330; i++) {
    const x = (R() * 2 - 1) * 530, z = (R() * 2 - 1) * 530;
    if (!ok(x, z, 6)) continue;
    const fan = smooth(250, 480, edgeDist(x, z)), nw = smooth(0, -300, x) * smooth(150, -250, z);
    const wash = washField(x, z).d < 16 ? 1 : 0;
    const pick = R();
    if (wash && pick < 0.5) { out.push({ x, z, y: heightAt(x, z), s: 0.8 + R() * 0.5, kind: 'snag' }); continue; }
    if (pick < 0.25 + 0.45 * nw) { out.push({ x, z, y: heightAt(x, z), s: 0.9 + R() * 0.5, kind: 'yucca' }); continue; }
    if (pick < 0.35 + 0.6 * fan || R() < 0.25) out.push({ x, z, y: heightAt(x, z), s: 0.85 + R() * 0.55, kind: 'cactus' });
  }
  // each plant's own crown for the camera clearance (src/cam_clear.js; at scale 1): narrow cacti,
  // a yucca's spiky head, a snag's bare limbs, not the meadow trees' big round canopies
  const CANOPY = { cactus: { y1: 0.3, y2: 4.4, r1: 0.85 }, yucca: { y1: 1.7, y2: 3.8, r1: 1.6 }, snag: { y1: 1.0, y2: 3.3, r1: 1.3 } };
  for (const t of out) t.canopy = CANOPY[t.kind];
  return out;
}
