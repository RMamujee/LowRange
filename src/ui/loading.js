// LowRange loading / title screen.
// A small pixel-art scene (drawn procedurally at ~400x225 and integer-scaled) where a tiny 4x4 crawls
// along a dirt trail as the progress bar. Usage:
//   const loader = createLoadingScreen();
//   loader.setStage('Grading the trails');   // marks earlier stages done
//   loader.setProgress(0.3);                 // optional finer progress inside a stage
//   await loader.finish();                   // waits for "press any key", then dissolves away
import { drawText, eachPixel, measure, wrap, FONT_H } from './pixelfont.js';
import './loading.css';

export const STAGES = [
  { label: 'Waking the physics', to: 0.2 },
  { label: 'Grading the trails', to: 0.45 },
  { label: 'Planting trees', to: 0.7 },
  { label: 'Fuelling up', to: 1 },
];

const TIPS = [
  'Air down with T for grip on rock.',
  'Lock the diffs before the ledge, not on it.',
  '4-Low, first gear, feather the throttle.',
  'Backspace repairs you where you stand.',
  'Scroll the mouse wheel to shift.',
  'Hold Shift for a gentle crawl throttle.',
  'Put the tyres on the rocks, not between them.',
  'Climb straight. Sideways is how rigs roll.',
  'Stalled? Tap I to fire the engine back up.',
];

// ---------------------------------------------------------------- palette
const C = {
  sky0: '#8fbfd4', sky1: '#b9d6cc', sky2: '#ebe0ae', sky3: '#f7cf86', sky4: '#f2b25e',
  sun: '#fff5d2', sunRing: '#fde4a4',
  cloud: '#fff4dc', cloudMid: '#fbe1b0', cloudShade: '#efc07e',
  mtn: '#a3b9c6', mtnLit: '#c8d2cc', mtnHaze: '#dccfa6', snow: '#f6eed8',
  far: '#b4b77a', farRim: '#cfc88e', mid: '#86a552', midDark: '#6d9247',
  g0: '#1c3320', g1: '#2d5a2b', g2: '#3f7a33', g3: '#5e9b39', g4: '#8cc04b', g5: '#bad65c',
  b0: '#2b1910', b1: '#55321e', b2: '#7d4b27', b3: '#a86c38', b4: '#cf9757',
  d0: '#9b6127', d1: '#c48633', d2: '#dfa443', d3: '#efc163', d4: '#f8dc90',
  r0: '#463e3b', r1: '#776c64', r2: '#a39887', r3: '#cdc1aa',
  paper: '#f4e5b9', paperShade: '#e0c68d', paperEdge: '#b4915a', ink: '#3a2414', inkSoft: '#8a6a44', tick: '#b23c2c',
  pink: '#f28cab', white: '#fff3da', red: '#df4f3b', yellow: '#ffd75a', flag: '#d8483a',
  paint: '#f8e8b8', paintShade: '#dfae5e',
};
const T = { // truck sprite colours
  o: '#1d1b26', b: '#3463ad', h: '#4f86d0', l: '#8fbbef', d: '#24467f',
  w: '#cfe7ee', g: '#6e9ab4', m: '#a39b8e', M: '#4b4646', y: '#ffe48c', r: '#d24a3a',
  k: '#1f1b1b', K: '#3d3636', c: '#c8462e', C: '#8e2e22',
};

// rear at the left, front at the right; axle line is sprite row AXLE_ROW
const TRUCK = [
  '..........cc..........................',
  '...ooooooocCoooooooooooo..............',
  '...o.....o.....o.....o.o..............',
  '..olllllllllllllllllllllo.............',
  '.ohhhhhhhhhhhhhhhhhhhhhhho............',
  '.ohwwwwwgohwwwwwgohwwwwwwgo...........',
  '.ohwwwwggohwwwwggohwwwwwgggo..........',
  '.ohwwwgggohwwwgggohwwwwgggggo.........',
  'kohbbbbbbbbbbbbbbbbbbbbbbbbbbhllllllo..',
  'kobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbyo.',
  'korbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbmo',
  'kordbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbdmo',
  '.odd.......dddddddddddddddd.......ddmmo',
  '.oo.........oooooooooooooo.........ooo.',
  '............MMMMMMMMMMMMMM.............',
];
const REAR_COL = 7, FRONT_COL = 30, AXLE_ROW = 17, WHEEL_R = 6;
// cut the wheel arches out of the body and trim them with a dark flare
const TRUCK_PX = TRUCK.map((r) => r.padEnd(39, '.').split(''));
for (let y = 0; y < TRUCK_PX.length; y++) for (let x = 0; x < 39; x++) {
  const d = Math.min(Math.hypot(x - REAR_COL, y - AXLE_ROW), Math.hypot(x - FRONT_COL, y - AXLE_ROW));
  if (d < WHEEL_R + 0.8) TRUCK_PX[y][x] = '.';
  else if (d < WHEEL_R + 1.9 && TRUCK_PX[y][x] !== '.' && y > 8) TRUCK_PX[y][x] = 'o';
}

// ---------------------------------------------------------------- helpers
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
function hash(x, y, s = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rgba = (hex) => { const n = parseInt(hex.slice(1), 16); return (255 << 24 | (n & 255) << 16 | (n >> 8 & 255) << 8 | n >> 16) >>> 0; };
const U = Object.fromEntries(Object.entries(C).map(([k, v]) => [k, rgba(v)]));

// A pixel buffer backed by ImageData; set() ignores out-of-range writes.
class Buf {
  constructor(w, h) { this.w = w; this.h = h; this.img = new ImageData(w, h); this.p = new Uint32Array(this.img.data.buffer); }
  set(x, y, c) { x |= 0; y |= 0; if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.p[y * this.w + x] = c; }
  get(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.p[y * this.w + x] : 0; }
  rect(x, y, w, h, c) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c); }
  canvas() { const cv = document.createElement('canvas'); cv.width = this.w; cv.height = this.h; cv.getContext('2d').putImageData(this.img, 0, 0); return cv; }
}

// Fills a shape given by inside(x,y) -> shade|null, then draws a 1px outline around it.
// shade() returns a palette uint; the outline uses `ol`.
function shape(buf, x0, y0, x1, y1, inside, ol) {
  const w = x1 - x0 + 1, h = y1 - y0 + 1, m = new Uint8Array((w + 2) * (h + 2)), cols = new Uint32Array(w * h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const c = inside(x, y);
    if (c) { m[(y - y0 + 1) * (w + 2) + (x - x0 + 1)] = 1; cols[(y - y0) * w + (x - x0)] = c; }
  }
  for (let y = y0 - 1; y <= y1 + 1; y++) for (let x = x0 - 1; x <= x1 + 1; x++) {
    const i = (y - y0 + 1) * (w + 2) + (x - x0 + 1);
    const at = (dx, dy) => { const xx = x - x0 + 1 + dx, yy = y - y0 + 1 + dy; return xx >= 0 && yy >= 0 && xx < w + 2 && yy < h + 2 ? m[yy * (w + 2) + xx] : 0; };
    const inS = x >= x0 && x <= x1 && y >= y0 && y <= y1 && m[i];
    if (inS) buf.set(x, y, cols[(y - y0) * w + (x - x0)]);
    else if (ol && (at(1, 0) || at(-1, 0) || at(0, 1) || at(0, -1))) buf.set(x, y, ol);
  }
}

// quantise a 0..1 light value (+ dither) into a ramp of palette entries
function ramp(list, v, x, y) {
  const n = list.length, f = clamp(v, 0, 0.999) * n, i = Math.floor(f);
  return list[clamp(f - i > bayer(x, y) ? i + 1 : i, 0, n - 1)];
}

// ---------------------------------------------------------------- scenery pieces
const LEAF = [U.g1, U.g2, U.g3, U.g4];
function roundTree(buf, cx, base, r, seed) {
  const R = rng(seed);
  const trunkH = Math.round(r * 0.95), tw = Math.max(3, Math.round(r * 0.32));
  // trunk with a little root flare
  shape(buf, cx - tw - 2, base - trunkH - 2, cx + tw + 2, base, (x, y) => {
    const t = (y - (base - trunkH)) / trunkH, half = tw / 2 + (t > 0.75 ? (t - 0.75) * 8 : 0);
    if (Math.abs(x - cx + 0.5) > half) return 0;
    const lx = (x - cx + half) / (2 * half);
    return lx < 0.35 ? U.b3 : lx < 0.75 ? U.b2 : U.b1;
  }, U.b0);
  const cy = base - trunkH - r * 0.55;
  const blobs = [[0, 0, r], [-r * 0.62, r * 0.28, r * 0.72], [r * 0.64, r * 0.3, r * 0.7], [-r * 0.2, -r * 0.55, r * 0.66], [r * 0.35, -r * 0.4, r * 0.6]];
  for (const b of blobs) { b[0] += (R() - 0.5) * r * 0.2; b[1] += (R() - 0.5) * r * 0.2; }
  shape(buf, Math.floor(cx - r * 1.5), Math.floor(cy - r * 1.3), Math.ceil(cx + r * 1.5), Math.ceil(cy + r * 1.1), (x, y) => {
    let best = -1, nx = 0, ny = 0;
    for (const [bx, by, br] of blobs) {
      const dx = (x - cx - bx) / br, dy = (y - cy - by) / br, d = dx * dx + dy * dy;
      if (d < 1) { const nz = Math.sqrt(1 - d); if (nz > best) { best = nz; nx = dx; ny = dy; } }
    }
    if (best < 0) return 0;
    // clumpy leaf texture: light per 2x2 cell, lit from the upper left
    const cell = hash(x >> 1, y >> 1, seed) - 0.5;
    const v = 0.5 - nx * 0.38 - ny * 0.48 + best * 0.12 + cell * 0.32;
    if (v > 0.86 && hash(x, y, seed + 7) > 0.55) return U.g5;
    return ramp(LEAF, v, x, y);
  }, U.g0);
}

function pine(buf, cx, base, h, seed) {
  const tw = 2;
  shape(buf, cx - tw, base - 5, cx + tw - 1, base, (x) => (x - cx < -1 ? U.b3 : x - cx < 1 ? U.b2 : U.b1), U.b0);
  const top = base - h, w = h * 0.36, tiers = Math.max(3, Math.round(h / 9));
  shape(buf, Math.floor(cx - w - 2), top, Math.ceil(cx + w + 2), base - 4, (x, y) => {
    const t = (y - top) / (h - 4);                       // 0 top .. 1 bottom
    const k = t * tiers, tierT = k - Math.floor(k);      // position within the tier
    const half = (0.18 + 0.82 * t) * w * (0.55 + 0.45 * tierT) + (hash(y, 3, seed) - 0.5) * 1.4;
    const dx = x - cx + 0.5;
    if (Math.abs(dx) > half) return 0;
    const side = dx / Math.max(half, 1);
    const v = 0.55 - side * 0.35 - (tierT > 0.8 ? 0.18 : 0) + (hash(x >> 1, y, seed) - 0.5) * 0.25;
    return ramp(LEAF, v, x, y);
  }, U.g0);
}

function bush(buf, cx, base, r, seed, flowers = true) {
  const R = rng(seed);
  const blobs = [[0, 0, r], [-r * 0.8, r * 0.25, r * 0.7], [r * 0.8, r * 0.2, r * 0.75]];
  const cy = base - r * 0.8;
  shape(buf, Math.floor(cx - r * 1.6), Math.floor(cy - r - 1), Math.ceil(cx + r * 1.6), base, (x, y) => {
    if (y > base) return 0;
    let best = -1, nx = 0, ny = 0;
    for (const [bx, by, br] of blobs) {
      const dx = (x - cx - bx) / br, dy = (y - cy - by) / br, d = dx * dx + dy * dy;
      if (d < 1) { const nz = Math.sqrt(1 - d); if (nz > best) { best = nz; nx = dx; ny = dy; } }
    }
    if (best < 0) return 0;
    const v = 0.5 - nx * 0.3 - ny * 0.5 + (hash(x >> 1, y >> 1, seed) - 0.5) * 0.3;
    return ramp(LEAF, v, x, y);
  }, U.g0);
  if (flowers) for (let i = 0; i < r * 1.2; i++) {
    const a = R() * Math.PI * 2, d = R() * r * 0.9, fx = Math.round(cx + Math.cos(a) * d * 1.3), fy = Math.round(cy + Math.sin(a) * d * 0.8);
    const col = R() < 0.6 ? U.pink : U.white;
    buf.set(fx, fy, col); if (R() < 0.5) buf.set(fx + 1, fy, col);
  }
}

function boulder(buf, cx, base, w, h, seed) {
  shape(buf, cx - w, base - h - 1, cx + w, base, (x, y) => {
    const dx = (x - cx) / w, top = base - h * Math.pow(Math.max(0, 1 - dx * dx), 0.55) + (hash(x, 1, seed) > 0.8 ? 1 : 0);
    if (y < top) return 0;
    const v = 0.55 - dx * 0.4 - ((y - top) / Math.max(h, 1)) * 0.3 + (hash(x >> 1, y >> 1, seed) - 0.5) * 0.2;
    if (hash(x, y, seed + 3) > 0.97) return U.r1;
    return ramp([U.r1, U.r2, U.r3], v, x, y);
  }, U.r0);
}

function cloudSprite(w, h, seed) {
  const R = rng(seed), buf = new Buf(w + 2, h + 2), blobs = [];
  const n = 3 + Math.floor(R() * 3);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n, r = h * (0.45 + 0.55 * Math.sin(t * Math.PI)) * (0.75 + R() * 0.3);
    blobs.push([1 + w * t, h + 1 - r * 0.7, r]);
  }
  for (let y = 0; y < h + 2; y++) for (let x = 0; x < w + 2; x++) {
    if (y > h) continue; // flat bottom
    let inside = false, top = 1;
    for (const [bx, by, r] of blobs) { const dx = x - bx, dy = y - by; if (dx * dx + dy * dy < r * r) { inside = true; top = Math.min(top, (y - (by - r)) / (2 * r)); } }
    if (!inside) continue;
    const v = (h - y) / h;
    buf.set(x, y, v > 0.55 ? U.cloud : v > 0.25 ? (bayer(x, y) < (v - 0.25) / 0.3 ? U.cloud : U.cloudMid) : (bayer(x, y) < v / 0.25 ? U.cloudMid : U.cloudShade));
  }
  return buf.canvas();
}

function plank(buf, x, y, w, h) {
  buf.rect(x - 1, y - 1, w + 2, h + 2, U.b0);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const seam = Math.floor(h / 2);
    let c = U.b2;
    if (j === 0 || j === seam + 1) c = U.b3;
    else if (j === seam) c = U.b0;
    else if (j === h - 1 || j === seam - 1) c = U.b1;
    else if (hash(i >> 3, j, 11) > 0.8 && hash(i, j, 12) > 0.3) c = U.b1;       // grain streaks
    else if (hash(i >> 2, j, 13) > 0.9) c = U.b3;
    buf.set(x + i, y + j, c);
  }
  // knots and nails
  for (const [kx, ky] of [[Math.floor(w * 0.18), Math.floor(h * 0.7)], [Math.floor(w * 0.83), Math.floor(h * 0.25)]]) { buf.set(x + kx, y + ky, U.b1); buf.set(x + kx + 1, y + ky, U.b0); buf.set(x + kx, y + ky + 1, U.b1); }
  for (const [nx, ny] of [[3, 2], [w - 4, 2], [3, h - 3], [w - 4, h - 3]]) { buf.set(x + nx, y + ny, U.r3); buf.set(x + nx + 1, y + ny + 1, U.r0); }
}

function paperSheet(buf, x, y, w, h, seed) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const edge = i === 0 || j === 0 || i === w - 1 || j === h - 1;
    let c = edge ? U.paperEdge : U.paper;
    if (!edge && (i === w - 2 || j === h - 2)) c = U.paperShade;
    if (!edge && hash(i, j, seed) > 0.985) c = U.paperShade;
    buf.set(x + i, y + j, c);
  }
  buf.set(x + w, y + 1, U.b0); for (let j = 1; j <= h; j++) buf.set(x + w, y + j, U.b1); for (let i = 1; i <= w; i++) buf.set(x + i, y + h, U.b1);
  // dog-eared corner + pin
  buf.set(x + w - 1, y + h - 1, U.paperShade); buf.set(x + w - 1, y + h - 2, U.paperEdge); buf.set(x + w - 2, y + h - 1, U.paperEdge);
  const px = x + (w >> 1);
  buf.set(px, y + 1, U.red); buf.set(px + 1, y + 1, U.red); buf.set(px, y + 2, U.red); buf.set(px + 1, y + 2, U.tick);
}

function rope(buf, x, y0, y1) {
  for (let y = y0; y <= y1; y++) { const a = ((y >> 1) & 1); buf.set(x, y, a ? U.b4 : U.b2); buf.set(x + 1, y, a ? U.b2 : U.b4); buf.set(x - 1, y, U.b0); buf.set(x + 2, y, U.b0); }
}

// ---------------------------------------------------------------- the screen
export function createLoadingScreen({ title = 'LowRange' } = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const root = document.createElement('div');
  root.id = 'lr-load';
  root.setAttribute('role', 'progressbar');
  root.setAttribute('aria-valuemin', '0'); root.setAttribute('aria-valuemax', '100');
  const sr = document.createElement('div'); sr.className = 'sr'; sr.setAttribute('aria-live', 'polite');
  const cv = document.createElement('canvas');
  root.append(cv, sr);
  document.body.appendChild(root);
  const ctx = cv.getContext('2d');

  let W = 0, H = 0, L = null; // logical size + layout/baked layers
  const st = {
    stage: 0, from: 0, target: 0, stageT: 0, shown: 0, done: false, ready: false, failed: null,
    tip: Math.floor(Math.random() * TIPS.length), tipT: 0, t: 0,
    rearY: 0, rearV: 0, frontY: 0, frontV: 0, roll: 0, dust: [], dustT: 0, dissolve: -1,
  };

  // ------------------------------------------------ layout + static bake
  function build() {
    const dpr = devicePixelRatio || 1, vw = innerWidth * dpr, vh = innerHeight * dpr;
    const s = Math.max(1, Math.min(Math.floor(vh / 190), Math.floor(vw / 330)));
    W = Math.ceil(vw / s); H = Math.ceil(vh / s);
    cv.width = W; cv.height = H;
    cv.style.width = `${(W * s) / dpr}px`; cv.style.height = `${(H * s) / dpr}px`;
    cv.style.left = `${Math.floor((vw - W * s) / 2) / dpr}px`; cv.style.top = `${Math.floor((vh - H * s) / 2) / dpr}px`;
    ctx.imageSmoothingEnabled = false;

    const horizon = Math.round(H * 0.43), fence = Math.round(H * 0.575), trailY = Math.round(H * 0.645);
    const boardTop = Math.round(H * 0.715), boardBot = H - 4;
    const tx0 = 22, tx1 = W - 34;
    const R = rng(1234);

    // trail surface (where tyres touch) with two rocks to climb
    const rocks = [{ f: 0.3, w: 9, h: 5 }, { f: 0.63, w: 12, h: 7 }].map((r) => ({ ...r, x: Math.round(lerp(tx0, tx1, r.f)) }));
    const ground = (x) => trailY + Math.round(1.6 * Math.sin(x * 0.021 + 0.5) + 0.9 * Math.sin(x * 0.067 + 2));
    const bump = (x) => { let b = 0; for (const r of rocks) { const dx = (x - r.x) / r.w; if (Math.abs(dx) < 1) b = Math.max(b, r.h * Math.pow(1 - dx * dx, 0.55)); } return b; };
    const surface = (x) => ground(x) - bump(x);

    // sky
    const sky = new Buf(W, horizon + 12);
    const stops = [[0, U.sky0], [0.3, U.sky1], [0.55, U.sky2], [0.78, U.sky3], [1.0, U.sky4]];
    const sunX = Math.round(W * 0.24), sunY = horizon - 18, sunR = 13;
    for (let y = 0; y < sky.h; y++) {
      const t = y / horizon; let i = 0;
      while (i < stops.length - 2 && t >= stops[i + 1][0]) i++;
      const local = clamp((t - stops[i][0]) / (stops[i + 1][0] - stops[i][0]), 0, 1), f = clamp((local - 0.55) / 0.45, 0, 1);
      for (let x = 0; x < W; x++) {
        let c = bayer(x, y) < f ? stops[i + 1][1] : stops[i][1];
        const d = Math.hypot(x - sunX, (y - sunY) * 1.0);
        if (d < sunR) c = U.sun;
        else if (d < sunR + 1.5) c = U.sunRing;
        else if (d < sunR + 10 && bayer(x, y) < 0.55 * (1 - (d - sunR) / 10)) c = U.sunRing;
        sky.p[y * W + x] = c;
      }
    }

    // distant blue mountains, lit from the sun side, hazing into the horizon glow
    const PW = W + 24;
    const mtn = new Buf(PW, H);
    const peaks = [];
    for (let x = -30; x < PW + 30; x += 34 + Math.floor(R() * 30)) peaks.push({ x, y: horizon - 30 - Math.floor(R() * 20), s: 0.55 + R() * 0.35 });
    for (let x = 0; x < PW; x++) {
      let top = Infinity, pk = null;
      for (const p of peaks) { const t = p.y + Math.abs(x - p.x) * p.s; if (t < top) { top = t; pk = p; } }
      top = Math.round(top + (hash(x >> 1, 0, 31) > 0.7 ? 1 : 0));
      for (let y = top; y < horizon + 4; y++) {
        const lit = (x - pk.x) < (y - pk.y) * 0.35 - 1;
        let c = lit ? U.mtnLit : U.mtn;
        if (y - pk.y < 5 + hash(x, 0, 32) * 3 && pk.y < horizon - 38) c = lit ? U.snow : U.mtnLit;
        const haze = Math.floor(clamp((y - (horizon - 24)) / 24, 0, 1) * 4) / 4;   // stepped haze bands
        if (bayer(x, y) < haze) c = U.mtnHaze;
        mtn.set(x, y, c);
      }
    }

    // far hills (a little wider than the screen for parallax)
    const far = new Buf(PW, H);
    for (let x = 0; x < PW; x++) {
      const top = Math.round(horizon - 9 - 7 * Math.sin(x * 0.012 + 1.3) - 4 * Math.sin(x * 0.031 + 0.2) - 2 * Math.sin(x * 0.09));
      const topN = Math.round(horizon - 9 - 7 * Math.sin((x + 1) * 0.012 + 1.3) - 4 * Math.sin((x + 1) * 0.031 + 0.2) - 2 * Math.sin((x + 1) * 0.09));
      for (let y = top; y < horizon + 30; y++) far.set(x, y, y <= top + (topN > top ? 1 : 0) ? U.farRim : (y < top + 4 && bayer(x, y) < 0.3 ? U.farRim : U.far));
    }
    // mid hills with a pine line
    const mid = new Buf(PW, H);
    const midTop = (x) => Math.round(horizon + 3 - 5 * Math.sin(x * 0.017 + 4) - 3 * Math.sin(x * 0.047 + 1));
    for (let x = 0; x < PW; x++) for (let y = midTop(x); y < fence + 6; y++) mid.set(x, y, y === midTop(x) ? U.mid : (bayer(x, y) < 0.18 ? U.midDark : U.mid));
    for (let x = 4; x < PW; x += 5 + Math.floor(R() * 7)) {
      if (R() < 0.25) continue;
      const h = 6 + Math.floor(R() * 8), base = midTop(x) + 2;
      for (let j = 0; j < h; j++) { const half = Math.floor((j / h) * h * 0.32 + 0.5); for (let i = -half; i <= half; i++) mid.set(x + i, base - h + j, i < 0 ? U.midDark : (bayer(x + i, j) < 0.5 ? U.g2 : U.midDark)); }
    }

    // near layer: meadow, trees, fence, trail, foreground, board, title
    const near = new Buf(W, H);
    const meadowTop = horizon + 8;
    for (let y = meadowTop; y < H; y++) for (let x = 0; x < W; x++) {
      if (y < midTop(x + 12) + 6) continue;
      const depth = (y - meadowTop) / (H - meadowTop);
      let c = depth < 0.12 && bayer(x, y) < 0.5 - depth * 4 ? U.mid : U.g3;
      const hsh = hash(x, y, 5);
      if (hsh < 0.05) c = U.g4; else if (hsh > 0.95) c = U.g2;
      if (depth > 0.6 && bayer(x, y) < (depth - 0.6) * 1.2) c = U.g2;
      near.p[y * W + x] = c;
    }
    // grass tufts
    for (let i = 0; i < W * 0.35; i++) { const x = Math.floor(R() * W), y = Math.floor(lerp(fence, H, R())); near.set(x, y, U.g4); near.set(x, y - 1, U.g4); near.set(x - 1, y, U.g2); near.set(x + 1, y - 1, U.g5); }

    // background trees (frame the scene; leave the middle open-ish)
    const treesSpec = [
      ['pine', 0.03, 46, -6], ['round', 0.11, 15, -4], ['pine', 0.2, 30, -9], ['round', 0.3, 10, -10], ['pine', 0.38, 22, -11],
      ['round', 0.62, 11, -10], ['pine', 0.7, 26, -10], ['round', 0.8, 15, -5], ['pine', 0.9, 40, -7], ['round', 0.99, 16, -3],
    ];
    const order = treesSpec.map((t, i) => ({ t, i })).sort((a, b) => a.t[3] - b.t[3]);
    for (const { t: [kind, fx, size, dy], i } of order) {
      const cx = Math.round(fx * W), base = fence + dy;
      if (kind === 'pine') pine(near, cx, base, size, 40 + i); else roundTree(near, cx, base, size, 80 + i);
    }
    for (const [fx, r] of [[0.16, 5], [0.46, 4], [0.55, 5], [0.85, 6]]) bush(near, Math.round(fx * W), fence - 1, r, Math.round(fx * 999));

    // fence
    const railY = [fence - 10, fence - 5];
    for (const ry of railY) for (let x = 0; x < W; x++) {
      near.set(x, ry - 1, U.b0); near.set(x, ry, (hash(x >> 2, ry, 2) > 0.85) ? U.b4 : U.b3); near.set(x, ry + 1, U.b2); near.set(x, ry + 2, U.b0);
    }
    for (let x = 6; x < W; x += 22 + Math.floor(R() * 4)) {
      const top = fence - 14 - Math.floor(R() * 2);
      for (let y = top; y <= fence; y++) { near.set(x - 1, y, U.b0); near.set(x, y, U.b3); near.set(x + 1, y, U.b2); near.set(x + 2, y, U.b1); near.set(x + 3, y, U.b0); }
      near.rect(x - 1, top - 1, 5, 1, U.b0); near.set(x, top, U.b4); near.set(x + 1, top, U.b3);
      near.set(x - 1, fence + 1, U.g2); near.set(x + 3, fence + 1, U.g2); near.set(x - 2, fence, U.g4);
    }
    // flowers in the strip between fence and trail
    for (let i = 0; i < W * 0.12; i++) {
      const x = Math.floor(R() * W), y = Math.floor(lerp(fence + 3, trailY - 9, R()));
      const col = [U.pink, U.white, U.yellow, U.red][Math.floor(R() * 4)];
      near.set(x, y + 1, U.g2); near.set(x, y, col);
    }

    // the trail: a dirt band whose far edge sits ~8px above the tyre line
    for (let x = 0; x < W; x++) {
      const g = ground(x), top = g - 8 + Math.round(Math.sin(x * 0.11) * 0.8), bot = g + 6 + Math.round(Math.sin(x * 0.07 + 2) * 1.2);
      for (let y = top; y <= bot; y++) {
        let c = U.d2;
        const h = hash(x, y, 9);
        if (y === top || y === bot) c = U.d1;
        else if (y === top + 1) c = U.d0;
        else if (y === g - 1 || y === g + 3) c = bayer(x, y) < 0.6 ? U.d1 : U.d2; // tyre ruts
        else if (h > 0.93) c = U.d3; else if (h < 0.05) c = U.d1;
        else if (y > g + 3 && bayer(x, y) < 0.15) c = U.d1;
        if (y < g - 3 && hash(x >> 1, y, 3) > 0.92) c = U.d4;
        near.set(x, y, c);
      }
      // grass lip over both edges
      if (hash(x, 1, 4) > 0.55) near.set(x, top, U.g3);
      if (hash(x, 2, 4) > 0.7) { near.set(x, top + 1, U.g2); }
      if (hash(x, 3, 4) > 0.5) near.set(x, bot, U.g3);
      if (hash(x, 5, 4) > 0.75) { near.set(x, bot - 1, U.g4); }
      // pebbles
      if (hash(x, 6, 4) > 0.96) { const py = g + 1 + Math.floor(hash(x, 7, 4) * 4); near.set(x, py, U.r2); near.set(x + 1, py, U.r1); }
    }
    // rocks that the truck climbs (their tops match bump())
    for (const r of rocks) {
      shape(near, r.x - r.w, ground(r.x) - r.h - 1, r.x + r.w, ground(r.x) + 2, (x, y) => {
        const b = bump(x); if (b < 0.8 || y < ground(x) - Math.round(b) || y > ground(x) + 1) return 0;
        const dx = (x - r.x) / r.w, v = 0.6 - dx * 0.45 - ((y - ground(x) + b) / r.h) * 0.25 + (hash(x >> 1, y >> 1, r.x) - 0.5) * 0.2;
        return ramp([U.r1, U.r2, U.r3], v, x, y);
      }, U.r0);
      near.set(r.x + r.w - 1, ground(r.x + r.w) + 1, U.d0); near.set(r.x - r.w + 1, ground(r.x - r.w) + 1, U.d0);
    }
    // stage marker posts along the far edge of the trail (pennants are drawn live)
    const posts = STAGES.slice(0, -1).map((s) => { const x = Math.round(lerp(tx0, tx1, s.to)) + 6; return { x, base: ground(x) - 8 }; });
    for (const p of posts) { for (let y = p.base - 12; y <= p.base; y++) { near.set(p.x - 1, y, U.b0); near.set(p.x, y, U.b3); near.set(p.x + 1, y, U.b1); near.set(p.x + 2, y, U.b0); } near.rect(p.x - 1, p.base - 13, 4, 1, U.b0); }
    // "Garage" sign at the end of the trail
    {
      const sx = tx1 + 10, sb = ground(sx) - 8, label = 'Garage', lw = measure(label) + 8;
      for (let y = sb - 16; y <= sb; y++) { near.set(sx - 1, y, U.b0); near.set(sx, y, U.b3); near.set(sx + 1, y, U.b2); near.set(sx + 2, y, U.b0); }
      const ax = Math.min(sx - 8, W - lw - 8), ay = sb - 26;
      plankArrow(near, ax, ay, lw, 12);
      eachPixel(label, ax + 4, ay + 2, 1, (x, y) => { near.set(x + 1, y + 1, U.b0); near.set(x, y, U.paint); });
    }
    // decor boulders + bushes by the trail
    boulder(near, Math.round(W * 0.06), ground(Math.round(W * 0.06)) + 10, 6, 6, 3);
    boulder(near, Math.round(W * 0.5), trailY - 10, 4, 3, 4);
    boulder(near, Math.round(W * 0.92), trailY + 12, 7, 7, 5);

    // foreground: bushes and flowers at the edges, the board in the middle
    const bw = Math.min(W - 24, 304), bx = Math.round((W - bw) / 2);
    bush(near, 8, H - 2, 12, 71); bush(near, bx - 4, H - 1, 9, 72); bush(near, W - 10, H - 1, 13, 73); bush(near, bx + bw + 6, H - 3, 8, 74);
    for (let i = 0; i < W * 0.25; i++) {
      const x = Math.floor(R() * W), y = Math.floor(lerp(trailY + 10, H - 2, R()));
      if (x > bx - 6 && x < bx + bw + 6 && y > boardTop - 4) continue;
      const col = [U.pink, U.white, U.yellow, U.pink][Math.floor(R() * 4)];
      near.set(x, y + 1, U.g1); near.set(x, y, col); near.set(x - 1, y, col); near.set(x + 1, y, col); near.set(x, y - 1, col); near.set(x, y, U.yellow);
    }
    // notice board on two posts
    for (const px of [bx + 16, bx + bw - 20]) for (let y = boardTop; y < H; y++) { near.set(px - 1, y, U.b0); near.set(px, y, U.b3); near.set(px + 1, y, U.b2); near.set(px + 2, y, U.b1); near.set(px + 3, y, U.b0); }
    plank(near, bx, boardTop, bw, boardBot - boardTop);
    const lw = 118, pad = 5;
    const lp = { x: bx + pad, y: boardTop + 4, w: lw, h: boardBot - boardTop - 8 };
    const rp = { x: bx + pad * 2 + lw, y: boardTop + 4, w: bw - lw - pad * 3, h: boardBot - boardTop - 8 };
    paperSheet(near, lp.x, lp.y, lp.w, lp.h, 1);
    paperSheet(near, rp.x, rp.y, rp.w, rp.h, 2);

    // hanging title plank
    const ts = 3, tw = measure(title) * ts, pw = tw + 26, ph = FONT_H * ts + 12, px = Math.round((W - pw) / 2), py = Math.max(6, Math.round(H * 0.045));
    rope(near, px + 16, 0, py); rope(near, px + pw - 18, 0, py);
    plank(near, px, py, pw, ph);
    const tx = px + 13, ty = py + 5;
    const lit = new Set();
    eachPixel(title, 0, 0, 1, (x, y) => lit.add(x + ',' + y));
    // carved shadow, then painted letters with a darker lower lip per pixel row
    eachPixel(title, tx, ty, ts, (x, y) => { near.rect(x - 1, y - 1, ts + 2, ts + 2, U.b0); });
    eachPixel(title, tx, ty, ts, (x, y) => { near.rect(x + 1, y + 2, ts, ts, U.b0); });
    eachPixel(title, 0, 0, 1, (gx, gy) => {
      const x = tx + gx * ts, y = ty + gy * ts;
      near.rect(x, y, ts, ts, U.paint);
      if (!lit.has(gx + ',' + (gy + 1))) near.rect(x, y + ts - 1, ts, 1, U.paintShade);
      if (!lit.has(gx + ',' + (gy - 1)) && hash(gx, gy, 8) > 0.5) near.set(x + 1, y, U.white);
    });

    // live elements: clouds + birds
    const clouds = [[44, 10, 0.08, 0.12, 1], [30, 8, 0.32, 0.22, 2], [58, 12, 0.62, 0.08, 3], [26, 7, 0.86, 0.26, 4]].map(([w, h, fx, fy, s]) => ({
      img: cloudSprite(w, h, s), x: fx * (W + 80) - 40, y: Math.round(fy * horizon), v: 1.2 + s * 0.35,
    }));

    L = { horizon, fence, trailY, tx0, tx1, rocks, ground, surface, posts, lp, rp, bx, bw, boardTop, titleBottom: py + ph,
      sky: sky.canvas(), mtn: mtn.canvas(), far: far.canvas(), mid: mid.canvas(), near: near.canvas(), clouds };
    if (!st.t) { const x = truckX(); st.rearY = wheelY(x - (FRONT_COL - REAR_COL) / 2 - 0.5); st.frontY = wheelY(x + (FRONT_COL - REAR_COL) / 2); }
  }

  function plankArrow(buf, x, y, w, h) {
    plank(buf, x, y, w, h);
    for (let j = 0; j < h; j++) { const d = Math.min(j, h - 1 - j); for (let i = 0; i <= d && i < 5; i++) buf.set(x + w + i, y + j, i === d ? U.b0 : U.b2); }
  }

  const truckX = () => lerp(L.tx0, L.tx1, st.shown);
  // tyre centre height under x: the highest point of the surface under the tyre footprint
  function wheelY(x) {
    let top = Infinity;
    for (let dx = -3; dx <= 3; dx++) { const s = L.surface(Math.round(x + dx)) + Math.abs(dx) * 0.55; top = Math.min(top, s); }
    return top - WHEEL_R;
  }

  // ------------------------------------------------ live drawing
  const WHEEL_SPRITES = [];
  function wheelSprite(phase) {
    const k = Math.round(phase * 8) & 7;
    if (WHEEL_SPRITES[k]) return WHEEL_SPRITES[k];
    const n = WHEEL_R * 2 + 3, s = new Buf(n, n), c = WHEEL_R + 1, rot = (k / 8) * (Math.PI / 2), R = WHEEL_R;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const dx = x - c, dy = y - c, d = Math.hypot(dx, dy), a = Math.atan2(dy, dx) - rot;
      if (d > R + 0.7) continue;
      let col;
      if (d > R - 0.6) col = Math.sin(a * 7) > 0.1 ? rgba(T.k) : rgba(T.K);            // lugs
      else if (d > R - 2.6) col = (dx + dy < -3) ? rgba(T.K) : rgba(T.k);
      else if (d > R - 3.5) col = rgba(T.M);
      else if (d > 1) col = Math.cos(a * 2.5) > 0.3 ? rgba('#5b5552') : (dx + dy < 0 ? rgba(C.r3) : rgba(T.m));
      else col = rgba(T.M);
      s.set(x, y, col);
    }
    return (WHEEL_SPRITES[k] = s.canvas());
  }
  const bodyCols = (() => {
    const w = TRUCK_PX[0].length, cols = [];
    for (let x = 0; x < w; x++) {
      const cvs = document.createElement('canvas'); cvs.width = 1; cvs.height = TRUCK_PX.length;
      const g = cvs.getContext('2d');
      TRUCK_PX.forEach((row, y) => { const ch = row[x]; if (ch !== '.') { g.fillStyle = T[ch]; g.fillRect(0, y, 1, 1); } });
      cols.push(cvs);
    }
    return cols;
  })();

  function drawTruck(dt) {
    const x = truckX(), half = (FRONT_COL - REAR_COL) / 2;
    const rx = x - half, fx = x + half, ry = wheelY(rx), fy = wheelY(fx);
    // suspension: each axle's body mount chases its wheel through a soft, under-damped spring
    if (reduced) { st.rearY = ry; st.frontY = fy; } else {
      for (const [k, wy] of [['rear', ry], ['front', fy]]) {
        const y = st[k + 'Y'], v = st[k + 'V'];
        const a = 320 * (wy - y) - 13 * v;
        st[k + 'V'] = v + a * dt; st[k + 'Y'] = y + st[k + 'V'] * dt;
      }
    }
    const idle = !reduced && !st.ready && Math.sin(st.t * 37) > 0.6 ? 1 : 0;   // engine shake at idle
    const left = Math.round(x - half - REAR_COL);
    const rw = wheelSprite(st.roll), fw = wheelSprite(st.roll + 0.37);
    // frame, shocks and wheels
    const mountR = (c) => Math.round(lerp(st.rearY, st.frontY, (c - REAR_COL) / (FRONT_COL - REAR_COL))) - AXLE_ROW;
    for (const [wx, wy] of [[rx, ry], [fx, fy]]) {
      const col = Math.round(wx) - left + 2, top = mountR(col) + 13 + 1;
      ctx.fillStyle = T.M; ctx.fillRect(left + col, top, 1, Math.max(0, Math.round(wy) - top));
      ctx.fillStyle = C.r2; ctx.fillRect(left + col + 1, top, 1, Math.max(0, Math.round(wy) - top - 2));
    }
    ctx.drawImage(rw, Math.round(rx) - WHEEL_R - 1, Math.round(ry) - WHEEL_R - 1);
    ctx.drawImage(fw, Math.round(fx) - WHEEL_R - 1, Math.round(fy) - WHEEL_R - 1);
    for (let c = 0; c < bodyCols.length; c++) ctx.drawImage(bodyCols[c], left + c, mountR(c) - idle);
  }

  function drawDust(dt, moving) {
    if (!reduced && moving) {
      st.dustT -= dt;
      if (st.dustT <= 0) {
        st.dustT = 0.06;
        const x = truckX() - (FRONT_COL - REAR_COL) / 2 - 5;
        st.dust.push({ x, y: wheelY(x) + WHEEL_R - 1, vx: -8 - Math.random() * 10, vy: -6 - Math.random() * 6, life: 0, max: 0.7 + Math.random() * 0.5, r: 1 + Math.random() * 1.6 });
      }
    }
    for (const p of st.dust) { p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 4 * dt; p.vx *= 1 - dt * 1.5; p.r += dt * 2.2; }
    st.dust = st.dust.filter((p) => p.life < p.max);
    for (const p of st.dust) {
      const k = p.life / p.max, r = p.r, cx = Math.round(p.x), cy = Math.round(p.y);
      for (let y = -Math.ceil(r); y <= Math.ceil(r); y++) for (let x = -Math.ceil(r); x <= Math.ceil(r); x++) {
        if (x * x + y * y > r * r || bayer(cx + x, cy + y) < k) continue;
        ctx.fillStyle = y < 0 ? C.d4 : C.d3; ctx.fillRect(cx + x, cy + y, 1, 1);
      }
    }
  }

  function drawPennants() {
    L.posts.forEach((p, i) => {
      const up = st.stage > i || st.done, wave = !reduced && up && Math.sin(st.t * 6 + i) > 0 ? 1 : 0;
      const y = up ? p.base - 12 : p.base - 4;
      ctx.fillStyle = up ? C.flag : C.inkSoft;
      for (let j = 0; j < 4; j++) { const len = up ? 6 - j - (j === 1 ? wave : 0) : 2; ctx.fillRect(p.x + 3, y + j, len, 1); }
      if (up) { ctx.fillStyle = '#ff8a6a'; ctx.fillRect(p.x + 3, y, 3, 1); }
    });
  }

  function drawBoard() {
    const { lp, rp } = L;
    const pct = Math.round(st.shown * 100);
    // progress checklist
    const header = st.failed ? 'Stuck!' : st.done ? 'Ready to roll' : `Loading ${pct}%`;
    drawText(ctx, header, lp.x + 6, lp.y + 3, C.ink);
    ctx.fillStyle = C.inkSoft; for (let x = lp.x + 6; x < lp.x + lp.w - 6; x += 2) ctx.fillRect(x, lp.y + 12, 1, 1);
    STAGES.forEach((s, i) => {
      const y = lp.y + 15 + i * 9, done = st.done || i < st.stage, cur = !done && i === st.stage;
      const bx = lp.x + 6;
      ctx.fillStyle = C.ink; ctx.fillRect(bx, y + 1, 5, 1); ctx.fillRect(bx, y + 5, 5, 1); ctx.fillRect(bx, y + 1, 1, 5); ctx.fillRect(bx + 4, y + 1, 1, 5);
      if (done) { ctx.fillStyle = C.tick; for (const [dx, dy] of [[1, 3], [2, 4], [3, 3], [4, 2], [5, 1], [6, 0]]) ctx.fillRect(bx + dx, y + dy, 1, 1); }
      if (cur && (reduced || Math.floor(st.t * 2.5) % 2 === 0)) { ctx.fillStyle = C.ink; ctx.fillRect(bx + 2, y + 3, 1, 1); }
      let label = s.label;
      if (cur && !st.failed) label += '.'.repeat(reduced ? 3 : 1 + (Math.floor(st.t * 3) % 3));
      drawText(ctx, label, bx + 9, y, done ? C.inkSoft : C.ink);
    });
    // tip (or the error, if loading failed)
    const tx = rp.x + 7, maxW = rp.w - 14;
    drawText(ctx, st.failed ? 'Something broke' : 'Trail tip', tx, rp.y + 3, C.tick);
    ctx.fillStyle = C.inkSoft; for (let x = tx; x < rp.x + rp.w - 7; x += 2) ctx.fillRect(x, rp.y + 12, 1, 1);
    const text = st.failed || TIPS[st.tip];
    let lines = wrap(text, maxW);
    for (let w = maxW - 4; w > maxW * 0.5; w -= 4) { const t = wrap(text, w); if (t.length > lines.length) break; lines = t; }  // even out ragged lines
    lines = lines.slice(0, 4);
    const reveal = reduced ? 1 : clamp(st.tipT / 0.35, 0, 1);
    ctx.save(); ctx.beginPath(); ctx.rect(tx - 1, rp.y + 14, (maxW + 2) * reveal, rp.h - 16); ctx.clip();
    lines.forEach((ln, i) => drawText(ctx, ln, tx, rp.y + 15 + i * 10, C.ink));
    ctx.restore();
    // tip pager dots
    for (let i = 0; i < TIPS.length; i++) { ctx.fillStyle = i === st.tip ? C.ink : C.paperEdge; ctx.fillRect(rp.x + rp.w - 8 - (TIPS.length - i) * 3, rp.y + rp.h - 5, 2, 1); }
  }

  function drawPrompt() {
    if (!st.ready || st.dissolve >= 0) return;
    if (!reduced && (st.t * 1.4) % 1 > 0.7) return;
    const msg = coarse ? 'Tap to start' : 'Press any key', s = 2, w = measure(msg) * s;
    const x = Math.round((W - w) / 2), y = L.titleBottom + 8;
    drawText(ctx, msg, x, y, C.paint, { scale: s, outline: C.b0, shadow: C.b0 });
  }

  let last = performance.now(), raf = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    st.t += dt; st.tipT += dt; st.stageT += dt;
    if (st.tipT > 6 && !st.failed) { st.tipT = 0; st.tip = (st.tip + 1) % TIPS.length; }
    // creep forward inside a stage so the truck keeps crawling during long async waits, never past the stage end
    const stageEnd = STAGES[Math.min(st.stage, STAGES.length - 1)].to;
    const goal = st.done ? 1 : Math.max(st.target, lerp(st.from, stageEnd - 0.03, 1 - Math.exp(-st.stageT / 2.5)));
    const before = st.shown;
    st.shown = Math.min(goal, st.shown + dt * (0.22 + 1.6 * Math.max(0, goal - st.shown)));
    const moved = (st.shown - before) * (L.tx1 - L.tx0);
    st.roll -= moved / (WHEEL_R * Math.PI * 0.5) * 0.25;
    if (st.done && st.shown >= 0.999 && !st.ready) becomeReady();

    ctx.drawImage(L.sky, 0, 0);
    for (const c of L.clouds) {
      if (!reduced) c.x += c.v * dt;
      if (c.x > W + 10) c.x = -c.img.width - 10;
      ctx.drawImage(c.img, Math.round(c.x), c.y);
    }
    // two little birds
    if (!reduced) for (let i = 0; i < 2; i++) {
      const bxp = ((st.t * (7 + i * 2) + i * 140) % (W + 40)) - 20, byp = Math.round(L.horizon * (0.3 + i * 0.12) + Math.sin(st.t * 0.8 + i) * 3), f = Math.floor(st.t * 5 + i) % 2;
      ctx.fillStyle = C.b1; const X = Math.round(bxp);
      ctx.fillRect(X, byp, 1, 1); ctx.fillRect(X - 1, byp - 1 + f, 1, 1); ctx.fillRect(X + 1, byp - 1 + f, 1, 1); ctx.fillRect(X - 2, byp - f, 1, 1); ctx.fillRect(X + 2, byp - f, 1, 1);
    }
    ctx.drawImage(L.mtn, -Math.round(st.shown * 3) - 4, 0);
    ctx.drawImage(L.far, -Math.round(st.shown * 7) - 4, 0);
    ctx.drawImage(L.mid, -Math.round(st.shown * 14) - 4, 0);
    ctx.drawImage(L.near, 0, 0);
    drawPennants();
    drawDust(dt, moved > 0.01);
    drawTruck(dt);
    drawBoard();
    drawPrompt();
    if (st.dissolve >= 0) dissolveStep(dt);
    if (root.isConnected) raf = requestAnimationFrame(frame);
  }

  // ------------------------------------------------ finish: gate + transition
  let resolveFinish = null;
  const finished = new Promise((r) => { resolveFinish = r; });
  // automated browsers (tests) skip the gate and the drive-in unless the URL has ?loader
  const skipGate = navigator.webdriver && !/[?&]loader\b/.test(location.search);

  function becomeReady() {
    st.ready = true;
    sr.textContent = coarse ? 'Loaded. Tap to start.' : 'Loaded. Press any key to start.';
    root.setAttribute('aria-valuenow', '100');
    root.classList.add('ready');
  }
  function start() { if (st.ready && st.dissolve < 0) { st.dissolve = 0; root.style.background = 'transparent'; } }
  function onKey(e) {
    if (!root.isConnected) return;
    // swallow input while the screen is up so the menu underneath doesn't react
    e.stopImmediatePropagation();
    if (e.type === 'keydown') { if (e.key !== 'Tab') e.preventDefault(); if (!e.repeat) start(); }
  }
  addEventListener('keydown', onKey, true);
  addEventListener('keyup', onKey, true);
  root.addEventListener('pointerdown', start);

  // ordered pixel dissolve in 4x4 blocks, or a short fade when reduced motion is on
  const DUR = reduced ? 0.25 : 0.7;
  function dissolveStep(dt) {
    st.dissolve += dt;
    const k = st.dissolve / DUR;
    if (k >= 1) { close(); return; }
    if (reduced) { root.style.opacity = String(1 - k); return; }
    ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = '#000';
    const B = 4;
    for (let by = 0; by < H / B; by++) for (let bx = 0; bx < W / B; bx++) {
      const t = 0.55 * bayer(bx, by) + 0.45 * hash(bx, by, 21);
      if (t < k) ctx.fillRect(bx * B, by * B, B, B);
    }
    ctx.restore();
  }
  function close() {
    cancelAnimationFrame(raf);
    removeEventListener('keydown', onKey, true);
    removeEventListener('keyup', onKey, true);
    removeEventListener('resize', build);
    root.remove();
    resolveFinish();
  }

  addEventListener('resize', build);
  build();
  raf = requestAnimationFrame(frame);

  function setStage(label) {
    const i = STAGES.findIndex((s) => s.label === label);
    if (i < 0 || i < st.stage) return;
    if (i > st.stage) { st.stage = i; st.from = i ? STAGES[i - 1].to : 0; st.stageT = 0; st.target = Math.max(st.target, st.from); }
    sr.textContent = `${label}…`;
    root.setAttribute('aria-valuenow', String(Math.round(st.target * 100)));
  }
  return {
    setStage,
    setProgress(f) { st.target = Math.max(st.target, clamp(f, 0, 1)); },
    fail(err) { st.failed = String(err && err.message || err).slice(0, 120); st.tipT = 0; },
    // marks everything loaded; resolves once the player has pressed a key and the screen has dissolved
    finish() { st.done = true; st.stage = STAGES.length; st.target = 1; if (skipGate) close(); return finished; },
  };
}
