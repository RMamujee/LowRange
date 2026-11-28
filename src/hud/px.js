// Shared pixel-art kit for the HUD: palette (the loading screen's wood + parchment, ART_STYLE ramps),
// low-res canvases, boards, parchment, insets, discs, Bresenham lines and nearest-neighbour sprite rotation.
// Everything is drawn 1:1 into small canvases that CSS blows up by a whole number (see hud.css).
import { drawText, measure, wrap, FONT_H } from '../ui/pixelfont.js';
import { tiny, tinyMeasure, TINY_H } from './tinyfont.js';
export { drawText, measure, wrap, FONT_H, tiny, tinyMeasure, TINY_H };

export const P = {
  ol: '#2a1a14',
  w0: '#2b1910', w1: '#55321e', w2: '#7d4b27', w3: '#a86c38', w4: '#cf9757', w5: '#e6b77a',
  paper: '#f4e5b9', paperShade: '#e0c68d', paperEdge: '#b4915a', ink: '#3a2414', inkSoft: '#8a6a44',
  paint: '#f8e8b8', paintShade: '#dfae5e', cream: '#fff6cf',
  m0: '#161412', m1: '#24211e', m2: '#33302c', m3: '#4a4640', m4: '#776c64', m5: '#a39887', m6: '#cdc1aa',
  red: '#d8483a', redHi: '#ff8a6a', redDark: '#8e2e22', redDeep: '#5a1c16',
  amber: '#ffb347', amberHi: '#ffe08a', amberDark: '#b9862a', gold: '#ffd866',
  green: '#5fae36', greenHi: '#8fd14a', greenDark: '#2a6628', greenDeep: '#1f3d1c',
  blue: '#4f7fe8', blueHi: '#9cc0ff', blueDark: '#2140a0',
  warnFace: '#f2b09a',
  // text on parchment (#f4e5b9), WCAG contrast in brackets; inkSoft / paperEdge stay for lines and rims only
  text: '#3a2414',      // body ink (11.6:1)
  text2: '#5e3f24',     // secondary text, hints, units (7.6:1; 5.7:1 on paperShade)
  textWarn: '#8e2e22',  // warnings, the live run, the selection (6.5:1)
  textGood: '#2a6628',  // done / completed (5.5:1)
  textHot: '#7a4a10',   // caution, e.g. HOT (6.0:1)
  btn: '#cf9757', btnHi: '#e6b77a', btnLo: '#8a5a30', // wooden key face: ink on it 5.7:1
};

// Type scale (game pixels; every board is blown up by a whole number, never resampled):
//   display  the bitmap face (ui/pixelfont.js) at 2x or more, or 1x with a painted outline: titles, big messages
//   body     the bitmap face at 1x, mixed case, 7 px caps / 5 px x-height, 10 px line pitch: every word on the HUD and maps
//   numerals the 3x5 face (tinyfont.js), digits and one- or two-letter marks only: dial numbers, gear slots, gate numbers
//            (plus the stamped instrument marks RPM, KM/H and PARK, where body text has no room)
// Minimum body size on screen: 7 game px x HUD scale (>= 2 at any window over about 800 x 500) = 14 device px.
export const LINE = 10;

// Body text with alignment; returns the width drawn.
export function text(g, s, x, y, col, { align = 'left', shadow = null, outline = null } = {}) {
  s = String(s);
  const w = measure(s), x0 = align === 'center' ? x - Math.floor(w / 2) : align === 'right' ? x - w : x;
  drawText(g, s, Math.round(x0), Math.round(y), col, { shadow, outline });
  return w;
}
// Shorten a string with a trailing '.' until it fits maxW (body face).
export function fitText(s, maxW) {
  s = String(s);
  if (measure(s) <= maxW) return s;
  while (s.length > 2 && measure(s.trimEnd() + '.') > maxW) s = s.slice(0, -1);
  return s.trimEnd() + '.';
}
// Greedy word wrap for the body face (same as pixelfont's wrap, re-exported for the HUD).
export const wrapText = (s, maxW) => wrap(String(s), maxW);
// Title case for names stored in caps elsewhere ('BOG RUN' -> 'Bog Run'); leaves mixed-case input alone.
export const nice = (s) => (/[a-z]/.test(s) ? String(s) : String(s).toLowerCase().replace(/(^|[\s/(&])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Ii|Iii|Iv)\b/g, (m) => m.toUpperCase()));

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const bayer = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
export function hash(x, y, s = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function mk(w, h) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
  return { cv, g, w, h };
}
export const rect = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
export const px = (g, x, y, c) => { g.fillStyle = c; g.fillRect(x, y, 1, 1); };

// 1px outline box (no fill)
export function box(g, x, y, w, h, c) { rect(g, x, y, w, 1, c); rect(g, x, y + h - 1, w, 1, c); rect(g, x, y, 1, h, c); rect(g, x + w - 1, y, 1, h, c); }

// Wooden board: dark outline, lit top edge, horizontal planks with seams, grain and nail heads.
export function board(g, x, y, w, h, { seed = 1, plankH = 9, nails = true } = {}) {
  rect(g, x, y, w, h, P.ol);
  for (let j = 1; j < h - 1; j++) {
    const k = (j - 1) % plankH, seam = k === plankH - 1 && j < h - 3;
    for (let i = 1; i < w - 1; i++) {
      let c = P.w2;
      if (seam) c = P.w0;
      else if (k === 0) c = P.w3;
      else if (k === plankH - 2) c = P.w1;
      else if (hash(i >> 3, j, seed) > 0.82 && hash(i, j, seed + 1) > 0.35) c = P.w1;
      else if (hash(i >> 2, j, seed + 2) > 0.93) c = P.w3;
      g.fillStyle = c; g.fillRect(x + i, y + j, 1, 1);
    }
  }
  // bevel: light top/left rim, dark bottom/right rim
  rect(g, x + 1, y + 1, w - 2, 1, P.w4); rect(g, x + 1, y + 1, 1, h - 2, P.w3);
  rect(g, x + 1, y + h - 2, w - 2, 1, P.w1); rect(g, x + w - 2, y + 1, 1, h - 2, P.w1);
  if (nails) for (const [nx, ny] of [[3, 3], [w - 5, 3], [3, h - 5], [w - 5, h - 5]]) { px(g, x + nx, y + ny, P.m6); px(g, x + nx + 1, y + ny, P.m4); px(g, x + nx, y + ny + 1, P.m4); px(g, x + nx + 1, y + ny + 1, P.w0); }
}

// Parchment card with a darker edge and a soft inner shade along the bottom/right.
export function paper(g, x, y, w, h, seed = 3) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const edge = i === 0 || j === 0 || i === w - 1 || j === h - 1;
    let c = edge ? P.paperEdge : P.paper;
    if (!edge && (i === w - 2 || j === h - 2)) c = P.paperShade;
    else if (!edge && hash(i, j, seed) > 0.985) c = P.paperShade;
    g.fillStyle = c; g.fillRect(x + i, y + j, 1, 1);
  }
  px(g, x, y, P.w1); px(g, x + w - 1, y, P.w1); px(g, x, y + h - 1, P.w1); px(g, x + w - 1, y + h - 1, P.w1);
}

// Sunken panel (dark top/left lip, light bottom/right lip) with a flat fill.
export function inset(g, x, y, w, h, fill = P.m1) {
  rect(g, x, y, w, h, fill);
  rect(g, x, y, w, 1, P.ol); rect(g, x, y, 1, h, P.ol);
  rect(g, x + 1, y + h - 1, w - 1, 1, P.w4); rect(g, x + w - 1, y + 1, 1, h - 1, P.w4);
}

// Brushed metal plate with bevel and corner screws.
export function plate(g, x, y, w, h, { screws = true } = {}) {
  rect(g, x, y, w, h, P.ol);
  for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
    let c = P.m3;
    if (hash(i >> 2, j, 77) > 0.9) c = P.m4;
    g.fillStyle = c; g.fillRect(x + i, y + j, 1, 1);
  }
  rect(g, x + 1, y + 1, w - 2, 1, P.m5); rect(g, x + 1, y + 1, 1, h - 2, P.m4);
  rect(g, x + 1, y + h - 2, w - 2, 1, P.m2); rect(g, x + w - 2, y + 1, 1, h - 2, P.m2);
  if (screws) for (const [sx, sy] of [[3, 3], [w - 5, 3], [3, h - 5], [w - 5, h - 5]]) { px(g, x + sx, y + sy, P.m6); px(g, x + sx + 1, y + sy, P.m2); px(g, x + sx, y + sy + 1, P.m2); px(g, x + sx + 1, y + sy + 1, P.m1); }
}

// Fill a shape given by inside(x, y) -> colour | null, then outline it with `ol` (4-neighbour).
export function shape(g, x0, y0, x1, y1, inside, ol = P.ol) {
  const w = x1 - x0 + 1, h = y1 - y0 + 1, m = new Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = inside(x0 + x, y0 + y);
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? m[y * w + x] : null);
  for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++) {
    const c = at(x, y);
    if (c) { g.fillStyle = c; g.fillRect(x0 + x, y0 + y, 1, 1); }
    else if (ol && (at(x + 1, y) || at(x - 1, y) || at(x, y + 1) || at(x, y - 1))) { g.fillStyle = ol; g.fillRect(x0 + x, y0 + y, 1, 1); }
  }
}

// A shaded ball (knobs, lamps): lit from the upper left.
export function ball(g, cx, cy, r, ramp, ol = P.ol) {
  shape(g, Math.floor(cx - r - 1), Math.floor(cy - r - 1), Math.ceil(cx + r + 1), Math.ceil(cy + r + 1), (x, y) => {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.hypot(dx, dy) / r;
    if (d > 1) return null;
    const v = 0.55 - (dx + dy) / r * 0.35 + (1 - d) * 0.25;
    return v > 0.85 ? ramp[0] : v > 0.58 ? ramp[1] : v > 0.35 ? ramp[2] : ramp[3];
  }, ol);
}

export function line(g, x0, y0, x1, y1, c) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  g.fillStyle = c;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    g.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// Sprite = { w, h, data: Uint32-ish array of css colours or null }. Built from a canvas.
export function spriteFrom(cv) {
  const g = cv.getContext('2d'), d = g.getImageData(0, 0, cv.width, cv.height).data, cols = [];
  for (let i = 0; i < cv.width * cv.height; i++) cols.push(d[i * 4 + 3] > 127 ? `rgb(${d[i * 4]},${d[i * 4 + 1]},${d[i * 4 + 2]})` : null);
  return { w: cv.width, h: cv.height, cols };
}
// Nearest-neighbour rotation of a sprite around its centre onto (cx, cy).
export function rotSprite(g, s, cx, cy, ang) {
  const c = Math.cos(ang), sn = Math.sin(ang), R = Math.ceil(Math.hypot(s.w, s.h) / 2) + 1;
  const hx = s.w / 2, hy = s.h / 2;
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
    const fx = x + 0.5, fy = y + 0.5;
    const u = Math.floor(fx * c + fy * sn + hx), v = Math.floor(-fx * sn + fy * c + hy);
    if (u < 0 || v < 0 || u >= s.w || v >= s.h) continue;
    const col = s.cols[v * s.w + u];
    if (col) { g.fillStyle = col; g.fillRect(Math.round(cx) + x, Math.round(cy) + y, 1, 1); }
  }
}

// Text helpers with the loading-screen font: painted letters with a dark outline.
export function sign(g, text, x, y, color = P.paint, outline = P.ol, scale = 1) { drawText(g, text, x, y, color, { scale, outline, shadow: outline }); }

export const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
export const fmtLap = (t) => (t == null ? '-:--.-' : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`);

// Difficulty symbols, pixel style: green circle, blue square, black diamond, double black.
export function diffSym(g, diff, cx, cy) {
  const col = diff === 'green' ? P.green : diff === 'blue' ? P.blue : P.m1;
  const rim = P.cream;
  const dia = (ox) => { for (let y = -3; y <= 3; y++) { const hw = 3 - Math.abs(y); for (let x = -hw - 1; x <= hw + 1; x++) px(g, cx + ox + x, cy + y, Math.abs(x) > hw ? rim : col); } px(g, cx + ox, cy - 4, rim); px(g, cx + ox, cy + 4, rim); };
  if (diff === 'green') { for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) { const d = x * x + y * y; if (d <= 12) px(g, cx + x, cy + y, d > 6 ? rim : col); } }
  else if (diff === 'blue') { rect(g, cx - 3, cy - 3, 7, 7, rim); rect(g, cx - 2, cy - 2, 5, 5, col); }
  else if (diff === 'black') dia(0);
  else { dia(-3); dia(3); }
}

// Little tick mark (completion) in green.
export function tick(g, x, y, c = P.green) { for (const [dx, dy] of [[0, 2], [1, 3], [2, 2], [3, 1], [4, 0]]) { px(g, x + dx, y + dy, c); px(g, x + dx, y + dy + 1, P.greenDark); } }
