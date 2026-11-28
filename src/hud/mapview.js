// Pixel maps: terrain baked from the ground the world actually shows (terrain_look.js visualSurface, in
// the map's own MAT_INFO colours, calmed towards the parchment so paths and labels stand out), stepped
// hill shading and sparse contour lines, tree dots, roads / trails / race track stamped as hard pixels;
// the player-centred minimap; the expandable big map with pan / zoom, click-to-place waypoints, a legend,
// labels that dodge each other; and the per-map waypoint store.
//
// Legibility rules (docs/HANDOFF.md, "HUD and map legibility"):
// - every word is body text (ui/pixelfont.js at 1x, mixed case) on a solid parchment plate with an ink rim,
//   never straight on the terrain; the 3x5 numerals face only for digits in gate boxes and flags
// - difficulty is shape + colour: circle (easy, green), square (moderate, blue), diamond (hard, black),
//   two diamonds (extreme, black), repeated along every trail line, not only at its ends
// - labels are placed by priority and skip spots taken by the player, waypoints, gates and other labels;
//   detail follows the zoom (spawn signposts and course names from zoom 1 up)
// - the player is a cream arrow with an ink outline and a light halo: it reads on grass, dirt, rock and roads
import { SIZE, RES, GRID, MAT, MAT_INFO, DIFF, ROADS, TRAILS, COURSES, TRAILHEAD, TRACK, CHECKPOINTS, pathPoint } from '../terrain.js';
import { visualSurface } from '../gfx/terrain_look.js';
import { BIGMAP, BIGMAP_SIZE } from './layout.js';
import { P, mk, rect, px, board, paper, inset, shape, tiny, sign, text, measure, fitText, wrapText, nice, LINE, bayer, clamp, diffSym, tick, fmtT, fmtLap, rotSprite, spriteFrom } from './px.js';

// ------------------------------------------------------------------ terrain bake
// Four-tone ramp (highlight, base, shade, deep) from a surface's MAT_INFO colour: desaturated a little and
// pulled 18% towards the parchment so the big areas sit back (ART_STYLE comfort rule), shades hue-shifted warm.
const PAPER_RGB = [0xf4 / 255, 0xe5 / 255, 0xb9 / 255];
function rampOf(c) {
  const lum = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
  const base = c.map((v, i) => { const d = v + (lum - v) * 0.15; return d + (PAPER_RGB[i] - d) * 0.18; });
  const hi = base.map((v, i) => v + ([1, 0.97, 0.86][i] - v) * 0.2);
  const sh = base.map((v, i) => v * [0.87, 0.83, 0.86][i]);
  const dp = base.map((v, i) => v * [0.74, 0.68, 0.72][i]);
  const u = (a) => { const [r, g, b] = a.map((v) => clamp(Math.round(v * 255), 0, 255)); return (255 << 24 | b << 16 | g << 8 | r) >>> 0; };
  return [hi, base, sh, dp].map(u);
}
const LEAF = ['#7cc843', '#4fa032', '#2f7d2c', '#1f5a27'];
const N1 = RES + 1, CELL = SIZE / RES;
const gi = (x, z) => { const ix = clamp(Math.floor((x + SIZE / 2) / CELL), 0, RES), iz = clamp(Math.floor((z + SIZE / 2) / CELL), 0, RES); return ix * N1 + iz; };
const hAt = (x, z) => GRID.h[gi(x, z)];
// Spawn list labels arrive in caps ('PINYON TWO-TRACK', '7 LEDGES II'): put the map's own spelling of
// every trail / course / stage name back, title-case what is left; tags in sentence case ('Far end').
let KNOWN = null;
function nameCase(s) {
  if (!KNOWN) KNOWN = [...TRAILS.flatMap((t) => [t.name, ...(t.stages || []).map((q) => q.name)]), ...COURSES.flatMap((C) => [C.name, ...C.stages.map((q) => q.name)])].filter(Boolean).sort((a, b) => b.length - a.length);
  let out = String(s);
  for (const n of KNOWN) out = out.split(n.toUpperCase()).join(n);
  return out.replace(/\b([A-Z])([A-Z]+)\b/g, (w, a, b) => (/^(II|III|IV|CP)$/.test(w) ? w : a + b.toLowerCase()));
}
const sentence = (s) => (/[a-z]/.test(s) ? String(s) : String(s).charAt(0) + String(s).slice(1).toLowerCase());
const DIFF_CORE = (diff) => (diff === 'green' ? P.green : diff === 'blue' ? P.blue : P.m1);
const ROAD_FILL = '#f4dfa8', ROAD_RIM = P.w2;

function bakeBase(ppm, trees) {
  const n = Math.round(SIZE * ppm), f = mk(n, n), img = f.g.createImageData(n, n), u = new Uint32Array(img.data.buffer);
  const step = 1 / ppm, cont = ppm >= 1 ? 5 : 10;
  // the surface the world shows off the paths (calm grass / dirt / outcrops), the gameplay grid on them
  let shown = null;
  try { if (GRID.vis) shown = visualSurface({ GRID, RES, SIZE, MAT }).mat; } catch { shown = null; }
  const ramps = {};
  const rampFor = (m) => ramps[m] || (ramps[m] = rampOf((MAT_INFO[m] || MAT_INFO[MAT.DIRT]).color));
  for (let py = 0; py < n; py++) for (let pxx = 0; pxx < n; pxx++) {
    const x = -SIZE / 2 + (pxx + 0.5) * step, z = -SIZE / 2 + (py + 0.5) * step;
    const g = gi(x, z), m = shown ? shown[g] : GRID.mat[g], h = GRID.h[g];
    const e = Math.max(step, CELL);
    const dx = hAt(x + e, z) - hAt(x - e, z), dz = hAt(x, z + e) - hAt(x, z - e);
    // light from the upper left (north-west): mostly highlight / base / shade, a light dither only at band edges
    let v = 0.45 + (dx + dz) * 0.9 / e * 0.22;
    if (m === MAT.WATER) v = 0.4;
    let idx = clamp(Math.floor(v * 2.6 + bayer(pxx, py) * 0.3 + 0.05), 0, 2);
    // contour lines, one tone down (every 5 m from zoom 1 up, 10 m below)
    const c0 = Math.floor(h / cont), cr = Math.floor(hAt(x + step, z) / cont), cd = Math.floor(hAt(x, z + step) / cont);
    if ((c0 !== cr || c0 !== cd) && m !== MAT.WATER && m !== MAT.ROAD && m !== MAT.TARMAC) idx = Math.min(3, idx + 1);
    u[py * n + pxx] = rampFor(m)[idx];
  }
  f.g.putImageData(img, 0, 0);
  const g = f.g, P2 = (w) => (w + SIZE / 2) * ppm;
  // trees: small canopies (a dot when zoomed out)
  for (const t of trees || []) {
    const cx = Math.floor(P2(t.x)), cz = Math.floor(P2(t.z));
    if (ppm < 1) { px(g, cx, cz, LEAF[2]); continue; }
    const r = ppm >= 2 ? 2 : 1;
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { if (i * i + j * j > r * r + 1) continue; px(g, cx + i, cz + j, i + j < 0 ? LEAF[1] : LEAF[2]); }
    px(g, cx + r, cz + r + 1, LEAF[3]);
  }
  // paths as stamped squares: rim, then fill
  // (w: pixels, or a function of the path point for a crawl corridor whose width varies)
  const stamp = (path, w, col) => {
    const pts = path.pts;
    g.fillStyle = col;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], L = Math.hypot(b.x - a.x, b.z - a.z) * ppm, k = Math.max(1, Math.ceil(L * 2));
      const wa = typeof w === 'function' ? w(a) : w, wb = typeof w === 'function' ? w(b) : w;
      for (let s = 0; s <= k; s++) { const t = s / k, X = P2(a.x + (b.x - a.x) * t), Z = P2(a.z + (b.z - a.z) * t), ww = wa + (wb - wa) * t, half = ww / 2; g.fillRect(Math.round(X - half), Math.round(Z - half), Math.max(1, Math.round(ww)), Math.max(1, Math.round(ww))); }
    }
  };
  if (TRACK) {
    const w = TRACK.width * ppm;
    stamp(TRACK, w + 2 * Math.max(1, ppm), P.ol); stamp(TRACK, w, '#d9c7a6'); stamp(TRACK, Math.max(1, w * 0.25), '#e8d8b8');
    const c0 = CHECKPOINTS[0], hw = TRACK.width / 2 + 2;
    for (let k = -hw; k <= hw; k += 0.5 / ppm) { const X = P2(c0.x + c0.tz * k), Z = P2(c0.z - c0.tx * k); px(g, Math.round(X), Math.round(Z), ((Math.round(k * ppm) & 1) ? P.cream : P.ol)); }
  }
  // roads: cream with a wooden-brown rim (paved roads where a map has them: dark asphalt, pale centre line) [jungle]
  for (const r of ROADS) { const w = Math.max(3, (r.width || 8) * ppm * 0.7); stamp(r, w + 2, ROAD_RIM); stamp(r, w, r.surface === 'paved' ? '#5a554e' : ROAD_FILL); if (r.surface === 'paved' && w >= 4) stamp(r, 1, '#e0b84a'); }
  // trails: an ink rim, a cream band, then the difficulty colour (at least 2 px of colour at any zoom)
  for (const t of TRAILS) {
    // a crawl corridor (t.corridor) is stamped as wide as it really is where it opens up (capped)
    const w = t.corridor ? (p) => Math.max(2, Math.min(p.w ?? t.width, 20) * ppm * 0.55) : Math.max(2, (t.width || 5) * ppm * 0.55);
    const plus = (d) => (typeof w === 'function' ? (p) => w(p) + d : w + d);
    stamp(t, plus(4), P.ol); stamp(t, plus(2), P.cream);
    // [crawl] a staged trail is stamped stage by stage in each stage's colour
    if (t.stages) for (const st of t.stages) stamp({ pts: t.pts.filter((p) => p.s >= st.s0 - 0.5 && p.s <= st.s1 + 0.5) }, w, DIFF_CORE(st.diff));
    else stamp(t, w, DIFF_CORE(t.diff));
    // and its easy line, a pale thread through the wide parts
    if (t.corridor && t.lineAt && ppm >= 1) {
      const pts = [];
      for (let s = 0; s <= t.length; s += 1) { const p = pathPoint(t, s), L = t.lineAt('easy', s); pts.push({ x: p.x - p.tz * L, z: p.z + p.tx * L }); }
      stamp({ pts }, 1, P.cream);
    }
  }
  // [crawl] the Gauntlet's side courses, section by section, as wide as they really are (the slab face)
  for (const C of COURSES) {
    const secs = C.stages.map((st) => [{ pts: C.pts.filter((p) => p.s >= st.s0 - 0.5 && p.s <= st.s1 + 0.5) }, Math.max(2, Math.min(st.width, 12) * ppm * 0.55), st.diff]);
    for (const [q, w] of secs) stamp(q, w + 4, P.ol);
    for (const [q, w] of secs) stamp(q, w + 2, P.cream);
    for (const [q, w, d] of secs) stamp(q, w, DIFF_CORE(d));
  }
  return f.cv;
}

// ------------------------------------------------------------------ waypoints (persist per map)
export class Waypoints {
  constructor(mapId, max = 3) {
    this.key = `lowrange.waypoints.${mapId}`; this.max = max; this.list = [];
    // stored points are untrusted: drop junk and anything off the map (x = 1e9 showed "1414213738 M")
    try { const v = JSON.parse(localStorage.getItem(this.key) || '[]'); if (Array.isArray(v)) this.list = v.filter((p) => p && typeof p.x === 'number' && typeof p.z === 'number' && Math.abs(p.x) <= SIZE / 2 && Math.abs(p.z) <= SIZE / 2).map((p) => ({ x: p.x, z: p.z })).slice(0, max); } catch { /* unreadable: start empty */ }
    this.onChange = null;
  }
  save() { try { localStorage.setItem(this.key, JSON.stringify(this.list)); } catch { /* storage blocked: session only */ } this.onChange?.(this.list); }
  get active() { return this.list[0] || null; }
  add(x, z) { const full = this.list.length >= this.max; if (full) this.list.pop(); this.list.push({ x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 }); this.save(); return full; }
  nearest(x, z, r) { let bi = -1, bd = r; this.list.forEach((p, i) => { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; bi = i; } }); return bi; }
  remove(i) { if (i >= 0) { this.list.splice(i, 1); this.save(); } }
  clear() { this.list = []; this.save(); }
}

// ------------------------------------------------------------------ sprites
// The player: a red arrowhead (lit left half), ink outline, then a 1 px cream halo so the outline
// still reads on dark rock and black trails; red stands off every ground colour the maps use.
function arrowSprite(size) {
  const f = mk(size + 2, size + 2), c = (size + 1) / 2;
  shape(f.g, 2, 2, size - 1, size - 1, (x, y) => {
    const dx = x - c, t = (y - 2) / (size - 4);          // 0 tip .. 1 tail
    if (t < 0 || t > 1) return null;
    const half = t * (size - 4) * 0.5, notch = t > 0.7 && Math.abs(dx) < (t - 0.7) * (size - 4) * 0.95;
    if (Math.abs(dx) > half + 0.2 || notch) return null;
    return dx < -0.4 ? P.redHi : P.red;
  });
  // halo: every empty pixel next to the outline
  const d = f.g.getImageData(0, 0, f.w, f.h).data, on = (x, y) => x >= 0 && y >= 0 && x < f.w && y < f.h && d[(y * f.w + x) * 4 + 3] > 127;
  f.g.fillStyle = 'rgba(255,246,207,0.9)';
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) if (!on(x, y) && (on(x + 1, y) || on(x - 1, y) || on(x, y + 1) || on(x, y - 1))) f.g.fillRect(x, y, 1, 1);
  return spriteFrom(f.cv);
}
let ARROW_S = null, ARROW_L = null;
function arrows() { if (!ARROW_S) { ARROW_S = arrowSprite(13); ARROW_L = arrowSprite(17); } }

// waypoint flag: pole + pennant (red = active, parchment = queued), number in the flag (numerals face)
export function flagPin(g, x, y, n, active) {
  rect(g, x, y - 11, 1, 12, P.ol); rect(g, x - 1, y, 3, 1, P.ol);
  shape(g, x + 1, y - 11, x + 9, y - 4, (qx, qy) => {
    const dy = qy - (y - 11), dx = qx - (x + 1);
    if (dy > 6 || dx > 7 - Math.abs(dy - 3) * 0.5) return null;
    return active ? (dy < 1 ? P.redHi : P.red) : (dy < 1 ? P.cream : P.paper);
  });
  tiny(g, String(n), x + 4, y - 10, active ? P.cream : P.ink, { align: 'center' });
}

// [spawns] spawn point marker: a little wooden signpost with a "P" board; the post's foot is the spot
export function spawnPin(g, x, y, hot) {
  rect(g, x - 1, y, 3, 1, P.ol);                       // foot
  rect(g, x, y - 5, 1, 5, P.ol);                       // post
  rect(g, x - 4, y - 13, 9, 8, P.ol);                  // board
  rect(g, x - 3, y - 12, 7, 6, hot ? P.amber : P.w2);
  rect(g, x - 3, y - 12, 7, 1, hot ? P.amberHi : P.w4);
  rect(g, x - 3, y - 7, 7, 1, hot ? P.amberDark : P.w1);
  tiny(g, 'P', x - 1, y - 12, hot ? P.ink : P.cream);
}
// [spawns] zoomed out: a 5 x 5 wooden peg, so 27 signposts don't bury the course
function spawnPeg(g, x, y) { rect(g, x - 2, y - 2, 5, 5, P.ol); rect(g, x - 1, y - 1, 3, 3, P.w3); px(g, x - 1, y - 1, P.w5); }
// small "P" board for list rows (7 x 7)
function spawnIcon(g, x, y, hot) {
  rect(g, x, y, 7, 7, P.ol); rect(g, x + 1, y + 1, 5, 5, hot ? P.amber : P.w2); rect(g, x + 1, y + 1, 5, 1, hot ? P.amberHi : P.w4);
  rect(g, x + 2, y + 2, 1, 4, P.cream); rect(g, x + 3, y + 2, 2, 1, P.cream); rect(g, x + 4, y + 3, 1, 1, P.cream); rect(g, x + 3, y + 4, 2, 1, P.cream);
}
// numbered gate / checkpoint box (9 x 9, numerals face); fill says next (amber) / done (green) / ahead (parchment)
function gateBox(g, x, y, label, fill) { rect(g, x - 4, y - 4, 9, 9, P.ol); rect(g, x - 3, y - 3, 7, 7, fill); tiny(g, label, x + 1, y - 2, P.ink, { align: 'center' }); }
// wooden key with body text; returns its width (KEY_H tall)
const KEY_H = 13;
function woodButton(g, x, y, label, hot) {
  const bw = measure(label) + 9;
  rect(g, x, y, bw, KEY_H, P.ol); rect(g, x + 1, y + 1, bw - 2, KEY_H - 2, hot ? P.amber : P.btn);
  rect(g, x + 1, y + 1, bw - 2, 1, hot ? P.amberHi : P.btnHi); rect(g, x + 1, y + KEY_H - 2, bw - 2, 1, hot ? P.amberDark : P.btnLo);
  text(g, label, x + 5, y + 3, P.ol);
  return bw;
}
// parchment plate with body text (ink rim, 12 px tall), centred on x; returns its width
const TAG_H = 12;
const tagW = (s, padL = 0) => measure(s) + 7 + padL;
function labelBox(g, s, x, y, col, padL = 0) {
  const w = tagW(s, padL), x0 = Math.round(x - w / 2);
  rect(g, x0, y, w, TAG_H, P.ol); rect(g, x0 + 1, y + 1, w - 2, TAG_H - 2, P.paper); rect(g, x0 + 1, y + TAG_H - 2, w - 2, 1, P.paperShade);
  text(g, s, x0 + 4 + padL, y + 2, col);
  return w;
}

// Taken rectangles, so markers and labels can dodge each other.
class Placer {
  constructor() { this.r = []; }
  hit(x, y, w, h, pad = 1) { return this.r.some((q) => x < q[0] + q[2] + pad && q[0] < x + w + pad && y < q[1] + q[3] + pad && q[1] < y + h + pad); }
  add(x, y, w, h) { this.r.push([x, y, w, h]); }
}

// Difficulty symbols repeated along each trail / course line, `gap` view px apart, anchored to the path
// (so they don't crawl while panning). V: world -> view; inside(x, y): on screen; R: Placer or null.
function trailSymbols(g, V, inside, z, gap, R) {
  const along = (path, diffAt) => {
    const step = gap / z;
    for (let s = step / 2; s < path.length - 4; s += step) {
      const p = pathPoint(path, s), [x, y] = V(p.x, p.z), diff = diffAt(s), w = diff === 'dblack' ? 15 : 9;
      if (!inside(x, y)) continue;
      if (R && R.hit(x - Math.floor(w / 2), y - 4, w, 9, 0)) continue;
      diffSym(g, diff, x, y);
      R?.add(x - Math.floor(w / 2), y - 4, w, 9);
    }
  };
  const stageDiff = (stages, fallback) => (s) => (stages.find((q) => s >= q.s0 && s <= q.s1) || stages[stages.length - 1] || { diff: fallback }).diff;
  for (const t of TRAILS) along(t, t.stages ? stageDiff(t.stages, t.diff) : () => t.diff);
  for (const C of COURSES) along(C, stageDiff(C.stages, C.diff));
}

// ------------------------------------------------------------------ minimap (player-centred, north up)
export class MapBases {
  constructor(trees) { this.trees = trees; this.b = {}; }
  get(ppm) { return this.b[ppm] || (this.b[ppm] = bakeBase(ppm, this.trees)); }
}

export function drawMinimap(g, x, y, S, { bases, p, heading, waypoints, raceCp, t }) {
  arrows();
  const ppm = 0.5, base = bases.get(ppm);
  rect(g, x, y, S, S, '#c89a48');
  const sx = Math.round((p.x + SIZE / 2) * ppm - S / 2), sy = Math.round((p.z + SIZE / 2) * ppm - S / 2);
  g.save(); g.beginPath(); g.rect(x, y, S, S); g.clip();
  g.drawImage(base, sx, sy, S, S, x, y, S, S);
  const toV = (wx, wz) => [Math.round(x + (wx + SIZE / 2) * ppm - sx), Math.round(y + (wz + SIZE / 2) * ppm - sy)];
  // difficulty symbols along the trails (clear of the player in the middle)
  const R = new Placer(); R.add(x + S / 2 - 8, y + S / 2 - 8, 17, 17);
  trailSymbols(g, toV, (vx, vy) => vx >= x + 3 && vx < x + S - 3 && vy >= y + 3 && vy < y + S - 3, ppm, 60, R);
  if (raceCp) { const [cx, cy] = toV(raceCp.x, raceCp.z); for (let a = 0; a < 28; a++) { const r = 6; const qx = Math.round(cx + Math.cos(a / 28 * 6.283) * r), qy = Math.round(cy + Math.sin(a / 28 * 6.283) * r); px(g, qx + 1, qy + 1, P.ol); px(g, qx, qy, (Math.floor(t * 4) & 1) ? P.amber : P.amberHi); } }
  // waypoints: pins inside, edge pips outside
  waypoints.forEach((w, i) => {
    let [wx, wy] = toV(w.x, w.z);
    const inside = wx >= x + 3 && wx < x + S - 3 && wy >= y + 12 && wy < y + S - 2;
    if (inside) flagPin(g, wx, wy, i + 1, i === 0);
    else {
      const cx = x + S / 2, cy = y + S / 2, dx = wx - cx, dy = wy - cy, k = (S / 2 - 4) / Math.max(Math.abs(dx), Math.abs(dy));
      wx = cx + dx * k; wy = cy + dy * k;
      rect(g, Math.round(wx) - 3, Math.round(wy) - 3, 7, 7, P.ol); rect(g, Math.round(wx) - 2, Math.round(wy) - 2, 5, 5, i === 0 ? P.red : P.paper);
    }
  });
  g.restore();
  rotSprite(g, ARROW_S, x + S / 2, y + S / 2, -heading);
}

// ------------------------------------------------------------------ the big map
// Board: title row (title, tabs, zoom), the map viewport (VW x VH) beside the parchment sidebar (SB wide),
// and the legend strip under both.
export class BigMap {
  constructor({ bases, waypoints, isRace, mapName, spawns = [] }) {
    Object.assign(this, { bases, waypoints, isRace, mapName, spawns });
    Object.assign(this, BIGMAP); [this.W, this.H] = BIGMAP_SIZE;
    this.zooms = SIZE > 600 ? [0.25, 0.5, 1, 2, 4] : [0.5, 1, 2, 4]; this.zi = 0; this.cx = 0; this.cz = 0; // (a big map starts zoomed out to fit) [jungle]
    this.hits = [];
    // [spawns] sidebar tab ('info' | 'spawn'), list selection / hover / scroll, the confirm prompt
    this.tab = 'info'; this.sel = -1; this.hover = -1; this.rowHover = -1; this.scroll = 0; this.prompt = -1; this.lastId = null;
    this.markerHits = []; this.promptHits = []; this.promptBox = null; this.list = null;
  }
  // [spawns] keep the selected row inside the scrolled list
  revealSel() {
    const L = this.list; if (!L || this.sel < 0) return;
    const row = L.rows.find((r) => r.i === this.sel); if (!row) return;
    if (row.y - L.top < this.scroll) this.scroll = row.y - L.top - (row.first ? L.headH : 0);
    if (row.y + L.rowH - L.top > this.scroll + L.h) this.scroll = row.y + L.rowH - L.top - L.h;
    this.scroll = clamp(this.scroll, 0, Math.max(0, L.content - L.h));
  }
  scrollBy(d) { const L = this.list; if (L) this.scroll = clamp(this.scroll + d, 0, Math.max(0, L.content - L.h)); }
  get z() { return this.zooms[this.zi]; }
  get zoomLabel() { const z = this.z; return z < 1 ? `1/${Math.round(1 / z)}x` : `${z}x`; }
  centreOn(x, z) { this.cx = x; this.cz = z; }
  // view <-> world for the current frame (base pixel aligned)
  frame() {
    const z = this.z, bppm = Math.min(2, z), base = this.bases.get(bppm), k = z / bppm;
    const sx = Math.round((this.cx - this.VW / 2 / z + SIZE / 2) * bppm), sy = Math.round((this.cz - this.VH / 2 / z + SIZE / 2) * bppm);
    const left = sx / bppm - SIZE / 2, top = sy / bppm - SIZE / 2;
    return { z, bppm, base, k, sx, sy, left, top };
  }
  toView(f, wx, wz) { return [this.mx + (wx - f.left) * f.z, this.my + (wz - f.top) * f.z]; }
  toWorld(vx, vy) { const f = this.frame(); return [f.left + (vx - this.mx) / f.z, f.top + (vy - this.my) / f.z]; }
  inView(vx, vy) { return vx >= this.mx && vy >= this.my && vx < this.mx + this.VW && vy < this.my + this.VH; }
  zoomAt(vx, vy, dir) {
    const [wx, wz] = this.toWorld(vx, vy), zi = clamp(this.zi + dir, 0, this.zooms.length - 1);
    if (zi === this.zi) return;
    this.zi = zi;
    const z = this.z;
    this.cx = wx - (vx - this.mx - this.VW / 2) / z; this.cz = wz - (vy - this.my - this.VH / 2) / z;
    this.clampView();
  }
  pan(dvx, dvy) { this.cx -= dvx / this.z; this.cz -= dvy / this.z; this.clampView(); }
  clampView() { const m = SIZE / 2 + 20; this.cx = clamp(this.cx, -m, m); this.cz = clamp(this.cz, -m, m); }

  draw(g, st) {
    arrows();
    const { W, H, VW, VH, mx, my, SB } = this;
    this.hits = [];
    board(g, 0, 0, W, H, { seed: 9 });
    // title plank: map name (painted, outlined), then from the right: close, zoom, tabs
    sign(g, nice(this.mapName || 'Map') + ' map', 8, 6, P.paint, P.ol);
    const ty = 4, closeX = W - 6 - KEY_H;
    rect(g, closeX, ty, KEY_H, KEY_H, P.ol); rect(g, closeX + 1, ty + 1, KEY_H - 2, KEY_H - 2, P.btn); rect(g, closeX + 1, ty + 1, KEY_H - 2, 1, P.btnHi); rect(g, closeX + 1, ty + KEY_H - 2, KEY_H - 2, 1, P.btnLo);
    text(g, 'X', closeX + 7, ty + 3, P.ol, { align: 'center' });
    this.hits.push({ x: closeX, y: ty, w: KEY_H, h: KEY_H, act: 'close' });
    const zl = `Zoom ${this.zoomLabel}`, zlw = measure(zl);
    text(g, zl, closeX - 6, ty + 3, P.paint, { align: 'right', outline: P.ol });
    const zx = closeX - 8 - zlw - 2 * (KEY_H + 1) - 4;
    for (const [lab, d, ox] of [['-', -1, 0], ['+', 1, KEY_H + 1]]) {
      rect(g, zx + ox, ty, KEY_H, KEY_H, P.ol); rect(g, zx + ox + 1, ty + 1, KEY_H - 2, KEY_H - 2, P.btn); rect(g, zx + ox + 1, ty + 1, KEY_H - 2, 1, P.btnHi); rect(g, zx + ox + 1, ty + KEY_H - 2, KEY_H - 2, 1, P.btnLo);
      text(g, lab, zx + ox + 7, ty + 3, P.ol, { align: 'center' });
      this.hits.push({ x: zx + ox, y: ty, w: KEY_H, h: KEY_H, act: d > 0 ? 'zin' : 'zout' });
    }
    // [spawns] sidebar tabs: map info / spawn point list
    if (this.spawns.length) {
      let tx = zx - 8;
      for (const [lab, tab] of [['Spawn points', 'spawn'], ['Info', 'info']]) {
        const bw = measure(lab) + 9; tx -= bw;
        woodButton(g, tx, ty, lab, this.tab === tab);
        this.hits.push({ x: tx, y: ty, w: bw, h: KEY_H, act: 'tab', tab });
        tx -= 3;
      }
    }
    // map viewport
    inset(g, mx - 1, my - 1, VW + 2, VH + 2, '#c89a48');
    const f = this.frame();
    g.save(); g.beginPath(); g.rect(mx, my, VW, VH); g.clip();
    for (let j = 0; j < VH; j += 4) for (let i = 0; i < VW; i += 4) if (((i + j) >> 2) & 1) rect(g, mx + i, my + j, 4, 4, '#c0913f');
    g.drawImage(f.base, f.sx, f.sy, VW / f.k, VH / f.k, mx, my, VW, VH);
    const V = (wx, wz) => this.toView(f, wx, wz).map(Math.round);
    const onMap = (x, y) => x >= mx - 8 && x <= mx + VW + 8 && y >= my - 8 && y <= my + VH + 16;
    const R = new Placer();
    // 1. always shown, reserved first: the player, the waypoints
    const [ppx, ppy] = V(st.p.x, st.p.z);
    R.add(ppx - 10, ppy - 10, 21, 21);
    const wps = this.waypoints.list.map((w) => V(w.x, w.z));
    wps.forEach(([wx, wy]) => R.add(wx - 1, wy - 11, 11, 12));
    // 2. spawn points: signposts from zoom 1 up, small wooden pegs when zoomed out (lit ones are always
    //    signposts); a peg's click target is as big as a signpost's, so clicking where the board would be works
    this.markerHits = [];
    const hot = (i) => i === this.hover || i === this.prompt || (this.tab === 'spawn' && i === this.sel);
    const fullPins = f.z >= 1;
    const pins = [];
    if (this.spawns.length) {
      const order = this.spawns.map((_, i) => i).sort((a, b) => (hot(a) ? 1 : 0) - (hot(b) ? 1 : 0)); // lit ones on top
      for (const i of order) {
        const sp = this.spawns[i], [sx, sy] = V(sp.x, sp.z);
        if (sx < mx - 6 || sx > mx + VW + 6 || sy < my - 2 || sy > my + VH + 14) continue;
        const full = fullPins || hot(i);
        pins.push([sx, sy, i, full]);
        this.markerHits.push({ x: sx - 5, y: sy - 14, w: 11, h: full ? 16 : 19, i });
      }
    }
    // 3. gates: numbered stage gates and course gates (F = finish); the next one always, others where they fit
    const gates = [];
    TRAILS.forEach((t) => {
      if (!t.stages) return;
      const cur = st.crawl ? st.crawl.stage : 0;
      for (const q of t.stages) gates.push({ q, label: String(q.n), next: q.n === cur + 1, done: q.n <= cur });
    });
    for (const C of COURSES) {
      const cs = st.crawl?.course && st.crawl.course.id === C.id ? st.crawl.course : null, cur = cs ? cs.stage : 0;
      for (const q of C.stages) gates.push({ q, label: q.n === C.stages.length ? 'F' : String(q.n), next: !!cs && q.n === cur + 1, done: !!cs && q.n <= cur, course: true });
    }
    gates.sort((a, b) => (b.next ? 2 : 0) + (b.course ? 0 : 1) - ((a.next ? 2 : 0) + (a.course ? 0 : 1)));
    const drawGates = [];
    for (const G of gates) {
      const [gx, gy] = V(G.q.gate.x, G.q.gate.z);
      if (!onMap(gx, gy)) continue;
      if (!G.next && R.hit(gx - 4, gy - 4, 9, 9, 0)) continue;
      R.add(gx - 4, gy - 4, 9, 9); drawGates.push([gx, gy, G]);
    }
    // trail-end symbols of the park-style trails
    const ends = [];
    TRAILS.forEach((t) => { if (t.stages) return; for (const end of [3, t.length - 3]) { const e = pathPoint(t, end), [ex, ey] = V(e.x, e.z), w = t.diff === 'dblack' ? 15 : 9; ends.push([ex, ey, t.diff]); R.add(ex - Math.floor(w / 2), ey - 4, w, 9); } });
    if (this.isRace && CHECKPOINTS.length) CHECKPOINTS.forEach((c, i) => { if (!i) return; const [cx, cy] = V(c.x, c.z); R.add(cx - 4, cy - 4, 9, 9); });
    if (TRAILHEAD) { const [hx, hy] = V(TRAILHEAD.x, TRAILHEAD.z); R.add(hx - 3, hy - 3, 7, 7); }
    for (const [sx, sy, , full] of pins) if (full) R.add(sx - 4, sy - 13, 9, 14); else R.add(sx - 2, sy - 2, 5, 5);
    // the scale bar plate (bottom left) and the hovered / selected spawn point's name tag
    const meters = f.z >= 2 ? 25 : f.z >= 1 ? 50 : f.z >= 0.5 ? 100 : 200, bl = Math.round(meters * f.z), sl = `${meters} m`, slw = measure(sl);
    R.add(mx + 3, my + VH - 15, bl + slw + 14, 13);
    let hoverTag = null;
    {
      const ni = this.hover >= 0 ? this.hover : this.prompt < 0 && this.tab === 'spawn' ? this.sel : -1;
      if (ni >= 0 && this.spawns[ni]) {
        const sp = this.spawns[ni], [sx, sy] = V(sp.x, sp.z), nm = nice(sp.name), w = tagW(nm);
        hoverTag = [nm, clamp(sx, mx + w / 2 + 2, mx + VW - w / 2 - 2), sy - 28 < my + 1 ? sy + 4 : sy - 28];
        R.add(Math.round(hoverTag[1] - w / 2), hoverTag[2], w, TAG_H);
      }
    }
    // 4. labels, by priority: trails (always), the trailhead and course names (zoom 1 up), START
    const labels = [];
    const place = (s, ax, ay, col, { must = false, padL = 0, tickMark = false } = {}) => {
      const w = tagW(s, padL), cands = [[0, -17], [0, 7], [-(w / 2 + 8), -6], [w / 2 + 8, -6], [0, -29], [0, 19], [-(w / 2 + 8), -18], [w / 2 + 8, -18], [0, -41], [0, 31]];
      let pick = null;
      for (const [dx, dy] of cands) {
        const x0 = clamp(Math.round(ax + dx - w / 2), mx + 1, mx + VW - w - 1), y0 = clamp(Math.round(ay + dy), my + 1, my + VH - TAG_H - 1);
        if (!R.hit(x0, y0, w, TAG_H, 1)) { pick = [x0, y0]; break; }
      }
      if (!pick && must) pick = [clamp(Math.round(ax - w / 2), mx + 1, mx + VW - w - 1), clamp(Math.round(ay - 17), my + 1, my + VH - TAG_H - 1)];
      if (!pick) return;
      R.add(pick[0], pick[1], w, TAG_H);
      labels.push([s, pick[0] + w / 2, pick[1], col, padL, tickMark]);
    };
    const runningCourse = st.crawl?.course?.running ? st.crawl.course.id : null;
    // a trail's label anchor: its middle, or (when the middle is off the view) the visible point nearest to it
    const anchorOf = (t) => {
      const mid = t.length / 2, step = Math.max(1, 8 / f.z);
      let best = null, bd = Infinity, last = -Infinity;
      for (const p of t.pts) { // (one pass over the path's own points, about every 8 view px)
        const s = p.s ?? 0;
        if (s - last < step) continue;
        last = s;
        const [x, y] = V(p.x, p.z);
        if (x < mx + 6 || x > mx + VW - 6 || y < my + 6 || y > my + VH - 6) continue;
        if (Math.abs(s - mid) < bd) { bd = Math.abs(s - mid); best = [x, y]; }
      }
      return best;
    };
    const trailLabel = (t, i) => {
      const s = st.trails[i], act = st.active && st.active.trail === i && !st.active.course; // [crawl] (not a side course's run)
      const a = anchorOf(t);
      if (!a) return;
      const [lx, ly] = a;
      let label = nice(t.name);
      if (act) label += ' ' + fmtT(st.active.t);
      else if (s.done) label += ' ' + fmtT(s.best);
      place(label, lx, ly, act ? P.textWarn : P.text, { must: true, padL: s.done && !act ? 8 : 0, tickMark: s.done && !act });
    };
    // the running trail first, so it gets the best spot
    TRAILS.forEach((t, i) => { if (st.active && st.active.trail === i) trailLabel(t, i); });
    TRAILS.forEach((t, i) => { if (!(st.active && st.active.trail === i)) trailLabel(t, i); });
    if (TRAILHEAD && f.z >= 1 && hoverTag?.[0] !== nice(TRAILHEAD.name || 'Trailhead')) { const [hx, hy] = V(TRAILHEAD.x, TRAILHEAD.z); place(nice(TRAILHEAD.name || 'Trailhead'), hx, hy, P.text); } // (not twice when its spawn point is named)
    // [crawl] side course names (zoom 1 up: at 1/2 a course is too short for a label to clear its gates); the running one shows its clock
    if (f.z >= 1) COURSES.forEach((C) => {
      const big = C.stages.reduce((a, q) => (q.len > a.len ? q : a)), m = pathPoint(C, big.s0 + big.len / 2), [lx, ly] = V(m.x, m.z), cs = st.crawl?.course;
      if (!onMap(lx, ly)) return;
      const run = runningCourse === C.id;
      place(nice(C.name) + (run ? ' ' + fmtT(cs.t) : ''), lx, ly, run ? P.textWarn : P.text, { must: run });
    });
    if (this.isRace && CHECKPOINTS.length) { const c0 = CHECKPOINTS[0], [sx, sy] = V(c0.x, c0.z); place('Start', sx, sy, P.text, { must: true }); }
    // 5. difficulty symbols along the lines, where nothing else is
    trailSymbols(g, V, (x, y) => x >= mx + 4 && x < mx + VW - 4 && y >= my + 4 && y < my + VH - 4, f.z, 70, R);
    // draw, bottom to top: trailhead, pins, trail ends, checkpoints, gates, labels, waypoints, player
    if (TRAILHEAD) { const [hx, hy] = V(TRAILHEAD.x, TRAILHEAD.z); rect(g, hx - 3, hy - 3, 7, 7, P.ol); rect(g, hx - 2, hy - 2, 5, 5, P.amber); px(g, hx - 2, hy - 2, P.amberHi); }
    for (const [sx, sy, i, full] of pins) if (full) spawnPin(g, sx, sy, hot(i)); else spawnPeg(g, sx, sy);
    for (const [ex, ey, diff] of ends) diffSym(g, diff, ex, ey);
    if (this.isRace && CHECKPOINTS.length) CHECKPOINTS.forEach((c, i) => { if (!i) return; const [cx, cy] = V(c.x, c.z); gateBox(g, cx, cy, String(i), st.race && st.race.next === i ? P.amber : P.paper); });
    for (const [gx, gy, G] of drawGates) gateBox(g, gx, gy, G.label, G.next ? P.amber : G.done ? P.greenHi : P.paper);
    for (const [s, cx, y0, col, padL, tickMark] of labels) { const w = labelBox(g, s, cx, y0, col, padL); if (tickMark) tick(g, Math.round(cx - w / 2) + 3, y0 + 3); }
    this.waypoints.list.forEach((w, i) => { const [wx, wy] = wps[i]; flagPin(g, wx, wy, i + 1, i === 0); });
    if (hoverTag) labelBox(g, hoverTag[0], hoverTag[1], hoverTag[2], P.text);
    rotSprite(g, ARROW_L, ppx, ppy, -st.heading);
    g.restore();
    // scale bar, on its own small plate
    rect(g, mx + 3, my + VH - 15, bl + slw + 14, 13, P.ol); rect(g, mx + 4, my + VH - 14, bl + slw + 12, 11, P.paper);
    rect(g, mx + 6, my + VH - 10, bl + 2, 5, P.ol); rect(g, mx + 7, my + VH - 9, bl, 3, P.paper); rect(g, mx + 7, my + VH - 9, Math.floor(bl / 2), 3, P.ink);
    text(g, sl, mx + 11 + bl, my + VH - 13, P.text);
    this.drawLegend(g);
    // sidebar
    const sx0 = mx + VW + 4, sy0 = my - 1, sw = SB, sh = VH + 2;
    paper(g, sx0, sy0, sw, sh, 7);
    let y = sy0 + 4;
    const head = (txt) => { text(g, txt, sx0 + 5, y, P.textWarn); for (let i = sx0 + 5; i < sx0 + sw - 5; i += 2) px(g, i, y + 10, P.inkSoft); y += 13; };
    if (this.tab === 'spawn' && this.spawns.length) { this.drawSpawnList(g, sx0, sy0, sw, sh); this.drawPrompt(g, f); return; } // [spawns]
    this.list = null;
    const SYM_X = (d) => sx0 + (d === 'dblack' ? 11 : 9), NAME_X = sx0 + 20;
    const stageRows = (rows, c, finishLast) => {
      rows.forEach((q, k) => {
        const cur = q.n === c.stage, split = c.splits[k], best = c.bestSplits[k], last = finishLast && q.n === rows.length;
        diffSym(g, q.diff, SYM_X(q.diff), y + 3);
        const right = last ? '' : split != null ? fmtT(split) : best != null ? fmtT(best) : '';
        const rw = right ? text(g, right, sx0 + sw - 5, y, split != null ? P.text : P.text2, { align: 'right' }) : 0;
        const label = last ? 'Finish' : `${q.n} ${nice(q.name)}`;
        text(g, fitText(label, sx0 + sw - 5 - rw - 4 - NAME_X), NAME_X, y, cur ? P.textWarn : split != null ? P.textGood : P.text);
        y += LINE;
      });
      y += 1;
      text(g, c.running ? 'Run' : 'Best', sx0 + 5, y, P.text); text(g, c.running ? fmtT(c.t) : c.best != null ? fmtT(c.best) : '-:--', sx0 + sw - 5, y, c.running ? P.textWarn : P.text2, { align: 'right' }); y += LINE + 3;
    };
    if (!this.isRace && st.crawl?.course) {
      // [crawl] a side course in focus: its sections, splits (or best splits) and run / best
      const c = st.crawl.course;
      head(nice(c.name));
      stageRows(c.sections, c, true);
    } else if (!this.isRace && TRAILS.length === 1 && TRAILS[0].stages) {
      // [crawl] stage list: symbol, number + name, this run's split (or the rig's best split)
      head('Stages');
      stageRows(TRAILS[0].stages, st.crawl || { stage: 0, splits: [], bestSplits: [] }, false);
    } else if (!this.isRace) {
      head('Trails');
      TRAILS.forEach((t, i) => {
        const s = st.trails[i], act = st.active && st.active.trail === i;
        diffSym(g, t.diff, SYM_X(t.diff), y + 3);
        const right = act ? fmtT(st.active.t) : s.done ? fmtT(s.best) : '';
        const rw = right ? text(g, right, sx0 + sw - 5, y, act ? P.textWarn : P.text2, { align: 'right' }) : 0;
        if (s.done && !act) tick(g, sx0 + sw - 6 - rw - 7, y + 1);
        text(g, fitText(nice(t.name), sx0 + sw - 5 - rw - (s.done && !act ? 12 : 4) - NAME_X), NAME_X, y, act ? P.textWarn : s.done ? P.textGood : P.text);
        this.hits.push({ x: sx0 + 2, y: y - 1, w: sw - 4, h: LINE, act: 'trail', i });
        y += LINE;
      });
      y += 2;
      const done = st.trails.filter((s) => s.done).length;
      text(g, `Done ${done}/${TRAILS.length}`, sx0 + 5, y, P.text); text(g, fmtT(st.time), sx0 + sw - 5, y, P.text2, { align: 'right' }); y += LINE;
      text(g, `Driven ${(st.dist / 1000).toFixed(2)} km`, sx0 + 5, y, P.text); y += LINE + 3;
    } else {
      head('Race');
      const r = st.race;
      const row = (a, b, col = P.text) => { text(g, a, sx0 + 5, y, P.text2); text(g, b, sx0 + sw - 5, y, col, { align: 'right' }); y += LINE; };
      row('Lap', r && r.lap ? String(r.lap) : '-');
      row('Current', r && r.started ? fmtLap(r.lapTime) : '-');
      row('Last', fmtLap(r && r.last));
      row('Best', fmtLap(r && r.best), P.textWarn);
      row('Next CP', r ? (r.next ? `${r.next}/${CHECKPOINTS.length - 1}` : 'Finish') : '-');
      y += 3;
    }
    const wl = this.waypoints.list.length, wpTitle = `Waypoints ${wl}/${this.waypoints.max}`;
    if (y + 13 + Math.max(1, wl) * LINE + (wl ? KEY_H + 4 : 0) <= sy0 + sh - 3) {
      head(wpTitle);
      if (!wl) { text(g, 'Click the map to set one', sx0 + 5, y, P.text2); y += LINE; }
      this.waypoints.list.forEach((w, i) => {
        const d = Math.hypot(w.x - st.p.x, w.z - st.p.z);
        rect(g, sx0 + 5, y + 1, 7, 7, P.ol); rect(g, sx0 + 6, y + 2, 5, 5, i === 0 ? P.red : P.paper);
        text(g, `${i + 1}${i === 0 ? ' (active)' : ''}`, sx0 + 16, y, P.text); text(g, `${Math.round(d)} m`, sx0 + sw - 5, y, P.text2, { align: 'right' });
        y += LINE;
      });
      if (wl) {
        const bw = woodButton(g, sx0 + 5, y + 1, 'Clear all', false);
        this.hits.push({ x: sx0 + 5, y: y + 1, w: bw, h: KEY_H, act: 'clear' });
        y += KEY_H + 4;
      }
    } else {
      // no room for a row per waypoint (the Gauntlet's 12 stages): title and CLEAR ALL on one row
      // (the minimap plaque still gives the distance to the active one)
      text(g, wpTitle, sx0 + 5, y + 3, P.textWarn);
      if (wl) { const bw = measure('Clear all') + 9, bx = sx0 + sw - 5 - bw; woodButton(g, bx, y, 'Clear all', false); this.hits.push({ x: bx, y, w: bw, h: KEY_H, act: 'clear' }); }
      y += KEY_H + 3;
    }
    // hints at the bottom of the sidebar (only the ones that fit under the content: the Gauntlet's
    // 12 stages + waypoints reach the bottom)
    const allHints = [['Click', 'set waypoint'], ['Right-click', 'remove'], ['Drag', 'pan'], ['Wheel', 'zoom'], ['M / Esc', 'close']];
    const hints = allHints.slice(Math.max(0, allHints.length - Math.floor((sy0 + sh - 4 - y) / LINE)));
    let hy = sy0 + sh - 4 - hints.length * LINE;
    this.hintsTop = hy; // for tests
    for (const [k, v] of hints) { text(g, k, sx0 + 5, hy, P.textWarn); text(g, v, sx0 + sw - 5, hy, P.text2, { align: 'right' }); hy += LINE; }
    this.drawPrompt(g, f); // [spawns]
  }

  // The legend strip under the map: difficulty symbols with their names, then the markers this map uses.
  drawLegend(g) {
    const { mx, my, VH, W } = this, y = my + VH + 3, x0 = mx - 1, x1 = W - 6;
    paper(g, x0, y, x1 - x0, this.LEG, 19);
    const items = [];
    if (this.isRace) items.push(['gate', 'Checkpoint'], ['start', 'Start']);
    else {
      const used = new Set([...TRAILS.flatMap((t) => (t.stages ? t.stages.map((q) => q.diff) : [t.diff])), ...COURSES.flatMap((C) => C.stages.map((q) => q.diff))]);
      for (const d of ['green', 'blue', 'black', 'dblack']) if (used.has(d)) items.push(['diff', DIFF[d]?.label || d, d]);
      const paved = ROADS.some((r) => r.surface === 'paved'), dirt = ROADS.some((r) => r.surface !== 'paved');
      if (paved) items.push(['paved', 'Paved']);
      if (dirt) items.push(['road', paved ? 'Track' : 'Road']);
      if (TRAILS.some((t) => t.stages) || COURSES.length) items.push(['gate', 'Gate']);
    }
    items.push(['you', 'You'], ['flag', 'Waypoint']);
    if (this.spawns.length) items.push(['spawn', 'Spawn']);
    const iconW = (it) => (it[0] === 'diff' ? (it[2] === 'dblack' ? 15 : 9) : it[0] === 'road' || it[0] === 'paved' ? 12 : it[0] === 'flag' ? 11 : 9);
    const total = items.reduce((a, it) => a + iconW(it) + 3 + measure(it[1]), 0);
    const gap = Math.max(4, Math.min(12, Math.floor((x1 - x0 - 8 - total) / Math.max(1, items.length - 1))));
    let x = x0 + 5;
    const cy = y + 6;
    for (const it of items) {
      const [kind, label, d] = it, iw = iconW(it);
      if (x + iw + 3 + measure(label) > x1 - 3) break;
      const ix = x + Math.floor(iw / 2);
      if (kind === 'diff') diffSym(g, d, ix, cy);
      else if (kind === 'road') { rect(g, x, cy - 3, 12, 7, ROAD_RIM); rect(g, x, cy - 2, 12, 5, ROAD_FILL); }
      else if (kind === 'paved') { rect(g, x, cy - 3, 12, 7, ROAD_RIM); rect(g, x, cy - 2, 12, 5, '#5a554e'); rect(g, x + 1, cy, 10, 1, '#e0b84a'); }
      else if (kind === 'gate') { rect(g, ix - 4, cy - 4, 9, 9, P.ol); rect(g, ix - 3, cy - 3, 7, 7, P.amber); tiny(g, '1', ix + 1, cy - 2, P.ink, { align: 'center' }); }
      else if (kind === 'start') { for (let k = 0; k < 9; k++) px(g, x + k, cy, k & 1 ? P.cream : P.ol); rect(g, x, cy - 3, 9, 1, P.ol); rect(g, x, cy + 3, 9, 1, P.ol); }
      else if (kind === 'you') rotSprite(g, ARROW_S, ix, cy, 0);
      else if (kind === 'flag') flagPin(g, x + 1, cy + 5, 1, true);
      else if (kind === 'spawn') spawnIcon(g, ix - 3, cy - 3, false);
      text(g, label, x + iw + 3, y + 3, P.text);
      x += iw + 3 + measure(label) + gap;
    }
  }

  // [spawns] the spawn point list: grouped (trailhead, trails by difficulty, stages, checkpoints),
  // scrollable, one row per point; rows are hit targets (act 'spawnrow')
  drawSpawnList(g, sx0, sy0, sw, sh) {
    const hints = [['Click / Enter', 'spawn'], ['Up / Down', 'select'], ['J / Esc', 'close']];
    const ROW = 11, HEAD = 12;
    let y = sy0 + 4;
    text(g, `Spawn points (${this.spawns.length})`, sx0 + 5, y, P.textWarn); for (let i = sx0 + 5; i < sx0 + sw - 5; i += 2) px(g, i, y + 10, P.inkSoft);
    y += 14;
    const top = y, bottom = sy0 + sh - 6 - hints.length * LINE, h = bottom - top;
    // layout (content coordinates)
    const rows = [];
    let cy = top, group = null;
    this.spawns.forEach((sp, i) => {
      const first = sp.group !== group;
      if (first) { group = sp.group; rows.push({ head: true, y: cy, group: sp.group, label: sp.groupLabel ? nice(sp.groupLabel) : sp.group.charAt(0).toUpperCase() + sp.group.slice(1) }); cy += HEAD; }
      rows.push({ i, y: cy, first }); cy += ROW;
    });
    const content = cy - top;
    this.list = { top, h, content, rows, rowH: ROW, headH: HEAD };
    this.scroll = clamp(this.scroll, 0, Math.max(0, content - h));
    g.save(); g.beginPath(); g.rect(sx0 + 1, top - 1, sw - 2, h + 1); g.clip();
    for (const r of rows) {
      const ry = r.y - this.scroll;
      if (ry + ROW < top || ry > bottom) continue;
      if (r.head) {
        const lw = text(g, r.label, sx0 + 5, ry, P.text2);
        for (let i = sx0 + 8 + lw; i < sx0 + sw - 7; i += 2) px(g, i, ry + 4, P.paperEdge);
        continue;
      }
      const sp = this.spawns[r.i], sel = r.i === this.sel, hov = r.i === this.rowHover;
      if (sel || hov) rect(g, sx0 + 2, ry - 1, sw - 7, ROW, sel ? P.paperShade : '#f0dcaa');
      if (sel) rect(g, sx0 + 2, ry - 1, 2, ROW, P.red);
      if (sp.kind === 'stage' || sp.kind === 'summit' || sp.kind === 'trail' || sp.kind === 'course') diffSym(g, sp.diff, sx0 + (sp.diff === 'dblack' ? 11 : 9), ry + 3);
      else if (sp.kind === 'checkpoint') gateBox(g, sx0 + 9, ry + 3, String(sp.cp), P.paper);
      else spawnIcon(g, sx0 + 6, ry, sel);
      const last = sp.id === this.lastId && !sp.default, tag = sp.tag ? sentence(sp.tag) : last ? 'Last' : '';
      const tw = tag ? text(g, tag, sx0 + sw - 7, ry, last ? P.textWarn : P.text2, { align: 'right' }) + 5 : 0;
      text(g, fitText(nameCase(sp.short || sp.name), sw - 27 - tw), sx0 + 20, ry, sel ? P.textWarn : P.text);
      if (last && sp.tag) rect(g, sx0 + 2, ry + 2, 2, 4, P.red); // last used, on a row whose tag is taken
      if (ry >= top - 2 && ry + ROW - 2 <= bottom + 1) this.hits.push({ x: sx0 + 2, y: ry - 1, w: sw - 7, h: ROW, act: 'spawnrow', i: r.i });
    }
    g.restore();
    // scrollbar
    if (content > h) {
      const th = Math.max(8, Math.round((h * h) / content)), ty = top + Math.round((this.scroll / (content - h)) * (h - th));
      rect(g, sx0 + sw - 4, top, 2, h, P.paperShade); rect(g, sx0 + sw - 4, ty, 2, th, P.inkSoft);
    }
    let hy = sy0 + sh - 4 - hints.length * LINE;
    for (const [k, v] of hints) { text(g, k, sx0 + 5, hy, P.textWarn); text(g, v, sx0 + sw - 5, hy, P.text2, { align: 'right' }); hy += LINE; }
  }

  // [spawns] parchment prompt over the map: "Spawn here?", the point's name and note, SPAWN / CANCEL
  drawPrompt(g, f) {
    this.promptHits = []; this.promptBox = null;
    const sp = this.spawns[this.prompt];
    if (!sp) return;
    const { mx, my, VW, VH } = this;
    const name = nice(sp.name), note = sp.note ? wrapText(sp.note, 170) : [];
    const w = Math.min(VW - 6, Math.max(measure(name), measure('Enter or click to confirm'), ...note.map(measure), 110) + 16);
    const h = 56 + note.length * LINE;
    const [vx, vy] = this.toView(f, sp.x, sp.z);
    let x = Math.round(vx - w / 2), y = Math.round(vy - 18 - h);
    if (y < my + 2) y = Math.round(vy + 6);
    x = clamp(x, mx + 2, mx + VW - w - 2); y = clamp(y, my + 2, my + VH - h - 2);
    rect(g, x + 2, y + 2, w, h, 'rgba(42,26,20,0.45)');   // drop shadow
    rect(g, x - 1, y - 1, w + 2, h + 2, P.ol);
    paper(g, x, y, w, h, 17);
    let ty = y + 5;
    text(g, 'Spawn here?', x + w / 2, ty, P.textWarn, { align: 'center' }); ty += LINE + 1;
    text(g, fitText(name, w - 10), x + w / 2, ty, P.text, { align: 'center' }); ty += LINE;
    for (const l of note) { text(g, l, x + w / 2, ty, P.text2, { align: 'center' }); ty += LINE; }
    ty += 2;
    const bw1 = measure('Spawn') + 9, bw2 = measure('Cancel') + 9, bx = Math.round(x + w / 2 - (bw1 + bw2 + 6) / 2);
    woodButton(g, bx, ty, 'Spawn', true); this.promptHits.push({ x: bx, y: ty, w: bw1, h: KEY_H, act: 'confirm' });
    woodButton(g, bx + bw1 + 6, ty, 'Cancel', false); this.promptHits.push({ x: bx + bw1 + 6, y: ty, w: bw2, h: KEY_H, act: 'cancel' });
    ty += KEY_H + 3;
    text(g, 'Enter or click to confirm', x + w / 2, ty, P.text2, { align: 'center' });
    this.promptBox = { x: x - 1, y: y - 1, w: w + 2, h: h + 2 };
  }
}
