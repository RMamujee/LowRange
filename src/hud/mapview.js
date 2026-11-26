// Pixel maps: terrain baked in the ART_STYLE ramps (stepped hill shading, contour lines, tree dots,
// roads / trails / race track stamped as hard pixels), the player-centred minimap, the expandable
// big map with pan / zoom and click-to-place waypoints, and the per-map waypoint store.
import { SIZE, RES, GRID, MAT, ROADS, TRAILS, TRAILHEAD, TRACK, CHECKPOINTS, pathPoint } from '../terrain.js';
import { P, mk, rect, px, board, paper, inset, shape, tiny, tinyMeasure, sign, bayer, clamp, diffSym, tick, fmtT, fmtLap, rotSprite, spriteFrom } from './px.js';

// ------------------------------------------------------------------ terrain bake
const RAMPS = {
  [MAT.GRASS]: ['#8fd14a', '#5fae36', '#3f8a2e', '#2a6628'],
  [MAT.DIRT]: ['#f2c25a', '#e0a440', '#c4832e', '#9a5f24'],
  [MAT.ROCK]: ['#b7aa98', '#948775', '#73685c', '#544b45'],
  [MAT.MUD]: ['#9a6a3e', '#7a4f2b', '#5e3b20', '#432a17'],
  [MAT.SAND]: ['#fbe6a8', '#eecd7d', '#d9b060', '#b98f45'],
  [MAT.GRAVEL]: ['#c9bba2', '#a8947a', '#8a7a62', '#6a5c4a'],
  [MAT.ROAD]: ['#f6d58a', '#e8b85e', '#cf9a45', '#a87632'],
  [MAT.TARMAC]: ['#6a645c', '#4f4a44', '#3c3833', '#2a2724'],
  [MAT.WATER]: ['#a8dcec', '#5fb0cc', '#3f8aac', '#2a6688'],
};
const LEAF = ['#7cc843', '#4fa032', '#2f7d2c', '#1f5a27'];
const hexU = (h) => { const n = parseInt(h.slice(1), 16); return (255 << 24 | (n & 255) << 16 | (n >> 8 & 255) << 8 | n >> 16) >>> 0; };
const RAMPS_U = Object.fromEntries(Object.entries(RAMPS).map(([k, r]) => [k, r.map(hexU)]));
const N1 = RES + 1, CELL = SIZE / RES;
const gi = (x, z) => { const ix = clamp(Math.floor((x + SIZE / 2) / CELL), 0, RES), iz = clamp(Math.floor((z + SIZE / 2) / CELL), 0, RES); return ix * N1 + iz; };
const hAt = (x, z) => GRID.h[gi(x, z)];

function bakeBase(ppm, trees) {
  const n = Math.round(SIZE * ppm), f = mk(n, n), img = f.g.createImageData(n, n), u = new Uint32Array(img.data.buffer);
  const step = 1 / ppm, cont = ppm >= 1 ? 4 : 8;
  for (let py = 0; py < n; py++) for (let pxx = 0; pxx < n; pxx++) {
    const x = -SIZE / 2 + (pxx + 0.5) * step, z = -SIZE / 2 + (py + 0.5) * step;
    const g = gi(x, z), m = GRID.mat[g], h = GRID.h[g];
    const e = Math.max(step, CELL);
    const dx = hAt(x + e, z) - hAt(x - e, z), dz = hAt(x, z + e) - hAt(x, z - e);
    // light from the upper left (north-west)
    let v = 0.42 + (dx + dz) * 0.9 / e * 0.25;
    if (m === MAT.WATER) v = 0.35 + (bayer(pxx, py) > 0.8 ? -0.2 : 0);
    let idx = clamp(Math.floor(v * 3 + bayer(pxx, py) * 0.5 + 0.05), 0, 3);
    // contour lines
    const c0 = Math.floor(h / cont), cr = Math.floor(hAt(x + step, z) / cont), cd = Math.floor(hAt(x, z + step) / cont);
    if ((c0 !== cr || c0 !== cd) && m !== MAT.WATER && m !== MAT.ROAD) idx = Math.min(3, idx + 1);
    u[py * n + pxx] = (RAMPS_U[m] || RAMPS_U[MAT.DIRT])[idx];
  }
  f.g.putImageData(img, 0, 0);
  const g = f.g, P2 = (w) => (w + SIZE / 2) * ppm;
  // trees: tiny canopies
  for (const t of trees || []) {
    const cx = Math.floor(P2(t.x)), cz = Math.floor(P2(t.z));
    if (ppm < 1) { px(g, cx, cz, LEAF[2]); continue; }
    const r = ppm >= 2 ? 2 : 1;
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { if (i * i + j * j > r * r + 1) continue; px(g, cx + i, cz + j, i + j < 0 ? LEAF[0] : i + j > 0 ? LEAF[2] : LEAF[1]); }
    px(g, cx + r, cz + r + 1, LEAF[3]);
  }
  // paths as stamped squares: dark rim, then fill
  const stamp = (path, w, col) => {
    const pts = path.pts, half = w / 2;
    g.fillStyle = col;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], L = Math.hypot(b.x - a.x, b.z - a.z) * ppm, k = Math.max(1, Math.ceil(L * 2));
      for (let s = 0; s <= k; s++) { const t = s / k, X = P2(a.x + (b.x - a.x) * t), Z = P2(a.z + (b.z - a.z) * t); g.fillRect(Math.round(X - half), Math.round(Z - half), Math.max(1, Math.round(w)), Math.max(1, Math.round(w))); }
    }
  };
  if (TRACK) {
    const w = TRACK.width * ppm;
    stamp(TRACK, w + 2 * Math.max(1, ppm), P.ol); stamp(TRACK, w, '#d9c7a6'); stamp(TRACK, Math.max(1, w * 0.25), '#e8d8b8');
    const c0 = CHECKPOINTS[0], hw = TRACK.width / 2 + 2;
    for (let k = -hw; k <= hw; k += 0.5 / ppm) { const X = P2(c0.x + c0.tz * k), Z = P2(c0.z - c0.tx * k); px(g, Math.round(X), Math.round(Z), ((Math.round(k * ppm) & 1) ? P.cream : P.ol)); }
  }
  for (const r of ROADS) { const w = Math.max(2, (r.width || 8) * ppm * 0.7); stamp(r, w + 2, P.w2); stamp(r, w, '#f4dfa8'); }
  const coreOf = (diff) => (diff === 'green' ? P.green : diff === 'blue' ? P.blue : P.m1);
  for (const t of TRAILS) {
    const w = Math.max(1, (t.width || 5) * ppm * 0.55);
    stamp(t, w + 2, P.cream);
    // [crawl] a staged trail is stamped stage by stage in each stage's colour
    if (t.stages) for (const st of t.stages) stamp({ pts: t.pts.filter((p) => p.s >= st.s0 - 0.5 && p.s <= st.s1 + 0.5) }, w, coreOf(st.diff));
    else stamp(t, w, coreOf(t.diff));
  }
  return f.cv;
}

// ------------------------------------------------------------------ waypoints (persist per map)
export class Waypoints {
  constructor(mapId, max = 3) {
    this.key = `lowrange.waypoints.${mapId}`; this.max = max; this.list = [];
    try { const v = JSON.parse(localStorage.getItem(this.key) || '[]'); if (Array.isArray(v)) this.list = v.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z)).slice(0, max); } catch { /* unreadable: start empty */ }
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
function arrowSprite(size, fill, rim) {
  const f = mk(size, size), c = (size - 1) / 2;
  shape(f.g, 1, 1, size - 2, size - 2, (x, y) => {
    const dx = x - c, t = (y - 1) / (size - 3);         // 0 tip .. 1 tail
    if (t < 0 || t > 1) return null;
    const half = t * (size - 3) * 0.48, notch = t > 0.72 && Math.abs(dx) < (t - 0.72) * (size - 3) * 0.9;
    if (Math.abs(dx) > half + 0.2 || notch) return null;
    return dx < -0.4 ? rim : fill;
  });
  return spriteFrom(f.cv);
}
let ARROW_S = null, ARROW_L = null;
function arrows() { if (!ARROW_S) { ARROW_S = arrowSprite(11, P.amber, P.amberHi); ARROW_L = arrowSprite(15, P.amber, P.amberHi); } }

// little flag pin: pole + pennant, number in the flag
export function flagPin(g, x, y, n, active) {
  rect(g, x, y - 10, 1, 11, P.ol); rect(g, x - 1, y, 3, 1, P.ol);
  shape(g, x + 1, y - 10, x + 9, y - 4, (qx, qy) => {
    const dy = qy - (y - 10), dx = qx - (x + 1);
    if (dy > 5 || dx > 7 - Math.abs(dy - 2.5) * 0.6) return null;
    return active ? (dy < 1 ? P.redHi : P.red) : (dy < 1 ? P.paint : P.paintShade);
  });
  tiny(g, String(n), x + 4, y - 9, active ? P.cream : P.ink, { align: 'center' });
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
  const toV = (wx, wz) => [x + (wx + SIZE / 2) * ppm - sx, y + (wz + SIZE / 2) * ppm - sy];
  if (raceCp) { const [cx, cy] = toV(raceCp.x, raceCp.z); for (let a = 0; a < 24; a++) { const r = 5; px(g, Math.round(cx + Math.cos(a / 24 * 6.283) * r), Math.round(cy + Math.sin(a / 24 * 6.283) * r), (Math.floor(t * 4) & 1) ? P.amber : P.amberHi); } }
  // waypoints: pins inside, edge pips outside
  waypoints.forEach((w, i) => {
    let [wx, wy] = toV(w.x, w.z);
    const inside = wx >= x + 3 && wx < x + S - 3 && wy >= y + 11 && wy < y + S - 2;
    if (inside) flagPin(g, Math.round(wx), Math.round(wy), i + 1, i === 0);
    else {
      const cx = x + S / 2, cy = y + S / 2, dx = wx - cx, dy = wy - cy, k = (S / 2 - 4) / Math.max(Math.abs(dx), Math.abs(dy));
      wx = cx + dx * k; wy = cy + dy * k;
      rect(g, Math.round(wx) - 2, Math.round(wy) - 2, 5, 5, P.ol); rect(g, Math.round(wx) - 1, Math.round(wy) - 1, 3, 3, i === 0 ? P.red : P.paint);
    }
  });
  g.restore();
  rotSprite(g, ARROW_S, x + S / 2, y + S / 2, -heading);
}

// ------------------------------------------------------------------ the big map
export class BigMap {
  constructor({ bases, waypoints, isRace, mapName }) {
    Object.assign(this, { bases, waypoints, isRace, mapName });
    this.VW = 300; this.VH = 200; this.SB = 116;
    this.W = 6 + this.VW + 4 + this.SB + 6; this.H = 6 + 14 + this.VH + 6;
    this.zooms = [0.5, 1, 2, 4]; this.zi = 0; this.cx = 0; this.cz = 0;
    this.mx = 6; this.my = 20; this.hits = [];
  }
  get z() { return this.zooms[this.zi]; }
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
    // title plank
    const title = (this.mapName || 'Map').toUpperCase() + ' MAP';
    sign(g, title, 8, 6, P.paint, P.ol);
    const closeX = W - 16;
    rect(g, closeX, 5, 11, 11, P.ol); rect(g, closeX + 1, 6, 9, 9, P.w3); rect(g, closeX + 1, 6, 9, 1, P.w5);
    tiny(g, 'X', closeX + 6, 8, P.ink, { align: 'center' });
    this.hits.push({ x: closeX, y: 5, w: 11, h: 11, act: 'close' });
    const zl = `ZOOM ${['1/2', '1', '2', '4'][this.zi]}X`;
    tiny(g, zl, closeX - 6, 8, P.paint, { align: 'right', shadow: P.ol });
    const zx = closeX - 8 - tinyMeasure(zl) - 24;
    for (const [lab, d, ox] of [['-', -1, 0], ['+', 1, 11]]) {
      rect(g, zx + ox, 5, 10, 11, P.ol); rect(g, zx + ox + 1, 6, 8, 9, P.w3); rect(g, zx + ox + 1, 6, 8, 1, P.w5);
      tiny(g, lab, zx + ox + 5, 8, P.ink, { align: 'center' });
      this.hits.push({ x: zx + ox, y: 5, w: 10, h: 11, act: d > 0 ? 'zin' : 'zout' });
    }
    // map viewport
    inset(g, mx - 1, my - 1, VW + 2, VH + 2, '#c89a48');
    const f = this.frame();
    g.save(); g.beginPath(); g.rect(mx, my, VW, VH); g.clip();
    for (let j = 0; j < VH; j += 4) for (let i = 0; i < VW; i += 4) if (((i + j) >> 2) & 1) rect(g, mx + i, my + j, 4, 4, '#c0913f');
    g.drawImage(f.base, f.sx, f.sy, VW / f.k, VH / f.k, mx, my, VW, VH);
    const V = (wx, wz) => this.toView(f, wx, wz).map(Math.round);
    // labels: trails (symbol, name, tick + best), trailhead, race checkpoints
    if (TRAILHEAD) { const [hx, hy] = V(TRAILHEAD.x, TRAILHEAD.z); rect(g, hx - 3, hy - 3, 7, 7, P.ol); rect(g, hx - 2, hy - 2, 5, 5, P.amber); px(g, hx - 2, hy - 2, P.amberHi); if (f.z >= 1) labelBox(g, 'TRAILHEAD', hx, hy + 6, P.ink); }
    const placed = [];
    TRAILS.forEach((t, i) => {
      const s = st.trails[i], act = st.active && st.active.trail === i;
      if (t.stages) { // [crawl] numbered stage gates, the next one highlighted
        const cur = st.crawl ? st.crawl.stage : 0;
        for (const q of t.stages) {
          const [gx, gy] = V(q.gate.x, q.gate.z), next = q.n === cur + 1, done = q.n <= cur;
          rect(g, gx - 4, gy - 4, 9, 9, P.ol); rect(g, gx - 3, gy - 3, 7, 7, next ? P.amber : done ? P.green : P.paper);
          tiny(g, String(q.n), gx + 1, gy - 2, P.ink, { align: 'center' });
        }
      } else for (const end of [3, t.length - 3]) { const e = pathPoint(t, end); const [ex, ey] = V(e.x, e.z); diffSym(g, t.diff, ex, ey); }
      const m = pathPoint(t, t.length / 2), [lx, ly] = V(m.x, m.z);
      let label = t.name.toUpperCase();
      if (act) label += ' ' + fmtT(st.active.t);
      else if (s.done) label += ' ' + fmtT(s.best);
      // first spot (above, below, further out) that doesn't overlap an earlier label
      const pad = s.done && !act ? 8 : 0, bw = tinyMeasure(label) + 6 + pad, bx = lx + (pad ? 4 : 0);
      let by = ly - 12;
      for (const dy of [-12, 5, -23, 16, -34, 27]) {
        const r = [bx - bw / 2, ly + dy, bw, 9];
        if (!placed.some((q) => r[0] < q[0] + q[2] + 2 && q[0] < r[0] + r[2] + 2 && r[1] < q[1] + q[3] + 1 && q[1] < r[1] + r[3] + 1)) { by = ly + dy; break; }
      }
      placed.push([bx - bw / 2, by, bw, 9]);
      const w = labelBox(g, label, bx, by, act ? P.redDark : P.ink, pad);
      if (pad) tick(g, bx - Math.floor(w / 2) + 2, by + 1);
    });
    if (this.isRace && CHECKPOINTS.length) {
      CHECKPOINTS.forEach((c, i) => {
        if (!i) return;
        const [cx, cy] = V(c.x, c.z), next = st.race && st.race.next === i;
        rect(g, cx - 4, cy - 4, 9, 9, P.ol); rect(g, cx - 3, cy - 3, 7, 7, next ? P.amber : P.paper);
        tiny(g, String(i), cx + 1, cy - 2, P.ink, { align: 'center' });
      });
      const c0 = CHECKPOINTS[0], [sx, sy] = V(c0.x, c0.z);
      labelBox(g, 'START', sx, sy + 8, P.ink);
    }
    this.waypoints.list.forEach((w, i) => { const [wx, wy] = V(w.x, w.z); flagPin(g, wx, wy, i + 1, i === 0); });
    // player
    const [ppx, ppy] = V(st.p.x, st.p.z);
    rotSprite(g, ARROW_L, ppx, ppy, -st.heading);
    g.restore();
    // scale bar
    const meters = f.z >= 2 ? 25 : f.z >= 1 ? 50 : 100, bl = Math.round(meters * f.z);
    rect(g, mx + 5, my + VH - 9, bl + 2, 5, P.ol); rect(g, mx + 6, my + VH - 8, bl, 3, P.paper); rect(g, mx + 6, my + VH - 8, Math.floor(bl / 2), 3, P.ink);
    tiny(g, `${meters} M`, mx + 10 + bl, my + VH - 10, P.paint, { shadow: P.ol });
    // sidebar
    const sx0 = mx + VW + 4, sy0 = my - 1, sw = SB, sh = VH + 2;
    paper(g, sx0, sy0, sw, sh, 7);
    let y = sy0 + 4;
    const head = (txt) => { tiny(g, txt, sx0 + 5, y, P.redDark); for (let i = sx0 + 5; i < sx0 + sw - 5; i += 2) px(g, i, y + 7, P.inkSoft); y += 10; };
    if (!this.isRace && TRAILS.length === 1 && TRAILS[0].stages) {
      // [crawl] stage list: symbol, number + name, this run's split (or the rig's best split)
      const c = st.crawl || { stage: 0, splits: [], bestSplits: [] };
      head('STAGES');
      TRAILS[0].stages.forEach((q, k) => {
        const cur = q.n === c.stage, split = c.splits[k], best = c.bestSplits[k];
        diffSym(g, q.diff, sx0 + (q.diff === 'dblack' ? 10 : 9), y + 2);
        let label = `${q.n} ${q.name.toUpperCase()}`; const maxW = sw - 46;
        while (tinyMeasure(label) > maxW && label.length > 3) label = label.slice(0, -1);
        tiny(g, label, sx0 + 18, y, cur ? P.redDark : split != null ? P.greenDark : P.ink);
        const right = split != null ? fmtT(split) : best != null ? fmtT(best) : '';
        if (right) tiny(g, right, sx0 + sw - 5, y, split != null ? P.ink : P.inkSoft, { align: 'right' });
        y += 9;
      });
      y += 1;
      tiny(g, c.running ? 'RUN' : 'BEST', sx0 + 5, y, P.ink); tiny(g, c.running ? fmtT(c.t) : c.best != null ? fmtT(c.best) : '-:--', sx0 + sw - 5, y, c.running ? P.redDark : P.inkSoft, { align: 'right' }); y += 10;
    } else if (!this.isRace) {
      head('TRAILS');
      TRAILS.forEach((t, i) => {
        const s = st.trails[i], act = st.active && st.active.trail === i;
        diffSym(g, t.diff, sx0 + (t.diff === 'dblack' ? 10 : 9), y + 2);
        const nm = t.name.toUpperCase(), maxW = sw - 44;
        let label = nm; while (tinyMeasure(label) > maxW && label.length > 3) label = label.slice(0, -1);
        if (label !== nm) label = label.slice(0, -1) + '.';
        tiny(g, label, sx0 + 18, y, act ? P.redDark : s.done ? P.greenDark : P.ink);
        const right = act ? fmtT(st.active.t) : s.done ? fmtT(s.best) : '';
        if (right) tiny(g, right, sx0 + sw - 5, y, act ? P.redDark : P.inkSoft, { align: 'right' });
        if (s.done && !act) tick(g, sx0 + sw - 6 - tinyMeasure(right) - 7, y - 1);
        this.hits.push({ x: sx0 + 2, y: y - 2, w: sw - 4, h: 9, act: 'trail', i });
        y += 10;
      });
      y += 2;
      const done = st.trails.filter((s) => s.done).length;
      tiny(g, `DONE ${done}/${TRAILS.length}`, sx0 + 5, y, P.ink); tiny(g, fmtT(st.time), sx0 + sw - 5, y, P.inkSoft, { align: 'right' }); y += 8;
      tiny(g, `DRIVEN ${(st.dist / 1000).toFixed(2)} KM`, sx0 + 5, y, P.ink); y += 12;
    } else {
      head('RACE');
      const r = st.race;
      const row = (a, b, col = P.ink) => { tiny(g, a, sx0 + 5, y, P.inkSoft); tiny(g, b, sx0 + sw - 5, y, col, { align: 'right' }); y += 8; };
      row('LAP', r && r.lap ? String(r.lap) : '-');
      row('CURRENT', r && r.started ? fmtLap(r.lapTime) : '-');
      row('LAST', fmtLap(r && r.last));
      row('BEST', fmtLap(r && r.best), P.redDark);
      row('NEXT CP', r ? (r.next ? `${r.next}/${CHECKPOINTS.length - 1}` : 'FINISH') : '-');
      y += 4;
    }
    head(`WAYPOINTS ${this.waypoints.list.length}/${this.waypoints.max}`);
    if (!this.waypoints.list.length) { tiny(g, 'NONE SET', sx0 + 5, y, P.inkSoft); y += 8; }
    this.waypoints.list.forEach((w, i) => {
      const d = Math.hypot(w.x - st.p.x, w.z - st.p.z);
      rect(g, sx0 + 5, y, 5, 5, i === 0 ? P.red : P.paintShade);
      tiny(g, `${i + 1}${i === 0 ? ' ACTIVE' : ''}`, sx0 + 13, y, P.ink); tiny(g, `${Math.round(d)} M`, sx0 + sw - 5, y, P.inkSoft, { align: 'right' });
      y += 8;
    });
    if (this.waypoints.list.length) {
      const bw = tinyMeasure('CLEAR ALL') + 8;
      rect(g, sx0 + 5, y, bw, 10, P.ol); rect(g, sx0 + 6, y + 1, bw - 2, 8, P.w3); rect(g, sx0 + 6, y + 1, bw - 2, 1, P.w5);
      tiny(g, 'CLEAR ALL', sx0 + 9, y + 3, P.ink);
      this.hits.push({ x: sx0 + 5, y, w: bw, h: 10, act: 'clear' });
      y += 13;
    }
    // hints at the bottom of the sidebar
    const hints = ['CLICK  SET WAYPOINT', 'RIGHT-CLICK  REMOVE', 'DRAG  PAN', 'WHEEL  ZOOM', 'M / ESC  CLOSE'];
    let hy = sy0 + sh - 5 - hints.length * 8;
    for (const h of hints) { const [k, v] = h.split('  '); tiny(g, k, sx0 + 5, hy, P.redDark); tiny(g, v, sx0 + sw - 5, hy, P.inkSoft, { align: 'right' }); hy += 8; }
  }
}

// parchment tag with tiny ink text, centred on x
function labelBox(g, text, x, y, col, padL = 0) {
  const w = tinyMeasure(text) + 6 + padL;
  const x0 = Math.round(x - w / 2);
  rect(g, x0, y, w, 9, P.ol); rect(g, x0 + 1, y + 1, w - 2, 7, P.paper); rect(g, x0 + 1, y + 7, w - 2, 1, P.paperShade);
  tiny(g, text, x0 + 3 + padL, y + 2, col);
  return w;
}
