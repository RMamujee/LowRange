// Pixel-art kit for the menu, garage and settings screens. Everything is drawn 1:1 into tiny canvases
// with the HUD's palette (hud/px.js) and handed to CSS as data URLs (wood and paper tiles, 9-slice frames,
// checkboxes, the hanging LowRange sign). CSS scales them by --p: a whole number of device pixels per
// art pixel, picked from the window size, so the menu matches the HUD and loading screen pixel for pixel.
import { P, hash, diffSym } from '../hud/px.js';
import { eachPixel, measure, FONT_H } from '../ui/pixelfont.js';

const canvas = (w, h) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.imageSmoothingEnabled = false; return { cv, g }; };
const dot = (g, x, y, c) => { g.fillStyle = c; g.fillRect(x, y, 1, 1); };
const fill = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
const url = (cv) => `url(${cv.toDataURL()})`;

// ---------------------------------------------------------------- tiles
// wall of planks (tiles both ways): lit top row, dark seam, sparse grain, staggered butt joints
function woodTile(seed = 5, dark = false) {
  const W = 96, PH = 10, N = 4, { cv, g } = canvas(W, PH * N);
  const R = dark ? [P.w0, P.w0, P.w1, P.w2] : [P.w0, P.w1, P.w2, P.w3];   // seam, shade, base, lit
  for (let j = 0; j < PH * N; j++) {
    const k = j % PH, plank = Math.floor(j / PH);
    for (let i = 0; i < W; i++) {
      let c = R[2];
      if (k === PH - 1) c = R[0];
      else if (k === 0) c = R[3];
      else if (k === PH - 2) c = R[1];
      else if (hash(i >> 3, j, seed) > 0.8 && hash(i, j, seed + 1) > 0.35) c = R[1];
      else if (hash(i >> 2, j, seed + 2) > 0.94) c = R[3];
      dot(g, i, j, c);
    }
    // a butt joint per plank, staggered
    const jx = (plank * 37 + 20) % W;
    if (k !== PH - 1) { dot(g, jx, j, R[0]); dot(g, (jx + 1) % W, j, R[3]); }
  }
  // a couple of knots
  for (const [kx, ky] of [[14, 4], [70, 24], [44, 35]]) { dot(g, kx, ky, R[1]); dot(g, kx + 1, ky, R[0]); dot(g, kx, ky + 1, R[1]); dot(g, kx + 1, ky + 1, R[1]); }
  return { cv, w: W, h: PH * N };
}

// parchment: flat paper with a very sparse fleck (kept faint so text never sits on texture)
function paperTile(seed = 9) {
  const W = 48, { cv, g } = canvas(W, W);
  fill(g, 0, 0, W, W, P.paper);
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) if (hash(i, j, seed) > 0.992) dot(g, i, j, '#ecd9a6');
  return { cv, w: W, h: W };
}

// ---------------------------------------------------------------- 9-slice frames
// ring(d, side) -> colour for the pixel d rings in from the edge on side 't' | 'l' | 'b' | 'r' (null = clear)
function frame(S, ring, corner) {
  const N = S * 3, { cv, g } = canvas(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dl = x, dt = y, dr = N - 1 - x, db = N - 1 - y, d = Math.min(dl, dt, dr, db);
    if (d >= S) continue;
    // which side owns this pixel: the nearest edge, top/left win ties on the lit diagonal
    let side = d === dt ? 't' : d === dl ? 'l' : d === db ? 'b' : 'r';
    if (d === dt && d === dr) side = dt + dr < N ? 't' : 'r';
    if (d === db && d === dl) side = 'l';
    const c = ring(d, side);
    if (c) dot(g, x, y, c);
  }
  corner?.(g, N);
  return { cv, s: S };
}

const nail = (g, x, y) => { dot(g, x, y, P.m6); dot(g, x + 1, y, P.m4); dot(g, x, y + 1, P.m4); dot(g, x + 1, y + 1, P.w0); };

// thick wooden board frame with nails in the corners
const woodFrame = () => frame(6, (d, s) => {
  const lit = s === 't' || s === 'l';
  return [P.ol, lit ? P.w4 : P.w1, lit ? P.w3 : P.w2, lit ? P.w3 : P.w2, lit ? P.w2 : P.w1, P.w0][d];
}, (g, N) => { nail(g, 2, 2); nail(g, N - 4, 2); nail(g, 2, N - 4); nail(g, N - 4, N - 4); });

// thin wooden frame (small signs, tabs)
const plankFrame = () => frame(3, (d, s) => {
  const lit = s === 't' || s === 'l';
  return [P.ol, lit ? P.w4 : P.w1, lit ? P.w3 : P.w2][d];
});

// parchment card: brown edge, clipped corners, shaded bottom/right inner rim
const paperFrame = () => frame(3, (d, s) => [P.inkSoft, P.paper, s === 'b' || s === 'r' ? P.paperShade : P.paper][d],
  (g, N) => { for (const [x, y] of [[0, 0], [N - 1, 0], [0, N - 1], [N - 1, N - 1]]) g.clearRect(x, y, 1, 1); dot(g, 1, 1, P.inkSoft); dot(g, N - 2, 1, P.inkSoft); dot(g, 1, N - 2, P.inkSoft); dot(g, N - 2, N - 2, P.inkSoft); });

// selected card: a gold double rim
const selFrame = () => frame(4, (d, s) => [P.ol, s === 'b' || s === 'r' ? P.amberDark : P.gold, P.amber, P.ol][d],
  (g, N) => { for (const [x, y] of [[0, 0], [N - 1, 0], [0, N - 1], [N - 1, N - 1]]) g.clearRect(x, y, 1, 1); });

// sunken dark well (3D preview, bars)
const wellFrame = () => frame(3, (d, s) => {
  const top = s === 't' || s === 'l';
  return [P.ol, top ? P.w0 : P.w4, top ? P.m1 : P.m2][d];
});

// ---------------------------------------------------------------- small sprites
// 9x9 checkbox: sunken paper box, ink tick when on
function checkbox(on) {
  const { cv, g } = canvas(9, 9);
  fill(g, 0, 0, 9, 9, P.ol);
  fill(g, 1, 1, 7, 7, '#fff8de');
  fill(g, 1, 1, 7, 1, P.paperShade); fill(g, 1, 1, 1, 7, P.paperShade);
  if (on) for (const [x, y] of [[2, 4], [2, 5], [3, 5], [3, 6], [4, 6], [4, 5], [5, 4], [5, 5], [6, 3], [6, 4], [7, 2], [7, 3]]) dot(g, x, y, P.greenDark);
  return cv;
}

// pointing hand-ish arrow for the focused button (7x7)
function cursor() {
  const { cv, g } = canvas(7, 9);
  const rows = ['#......', '##.....', '#a#....', '#aa#...', '#aaa#..', '#aa#...', '#a#....', '##.....', '#......'];
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === '#') dot(g, x, y, P.ol); else if (c === 'a') dot(g, x, y, P.gold); }));
  return cv;
}

// two-strand rope, 4 px wide, tiles vertically
function rope() {
  const { cv, g } = canvas(4, 4);
  for (let y = 0; y < 4; y++) {
    const a = (y >> 1) & 1;
    fill(g, 0, y, 4, 1, P.w0);
    dot(g, 1, y, a ? P.w4 : P.w2); dot(g, 2, y, a ? P.w2 : P.w4);
  }
  return cv;
}

// difficulty symbol, 11x11
function diffIcon(d) { const { cv, g } = canvas(d === 'dblack' ? 15 : 9, 11); diffSym(g, d, d === 'dblack' ? 7 : 4, 5); return cv; }

// ---------------------------------------------------------------- the LowRange sign
// The loading screen's hanging plank (ropes, two planks with a seam, nails), letters carved and painted.
export function drawSign(title = 'LowRange', ts = 3, ropeH = 8) {
  const tw = measure(title) * ts, pw = tw + 26, ph = FONT_H * ts + 10;
  const { cv, g } = canvas(pw + 2, ropeH + ph + 2);
  const x = 1, y = ropeH;
  // ropes
  for (const rx of [14, pw - 16]) for (let yy = 0; yy < ropeH + 2; yy++) { const a = (yy >> 1) & 1; fill(g, rx - 1, yy, 4, 1, P.w0); dot(g, rx, yy, a ? P.w4 : P.w2); dot(g, rx + 1, yy, a ? P.w2 : P.w4); }
  // plank
  fill(g, x - 1, y - 1, pw + 2, ph + 2, P.w0);
  const seam = Math.floor(ph / 2);
  for (let j = 0; j < ph; j++) {
    let row = P.w2;
    if (j === 0 || j === seam + 1) row = P.w3; else if (j === seam) row = P.w0; else if (j === ph - 1 || j === seam - 1) row = P.w1;
    fill(g, x, y + j, pw, 1, row);
    if (row !== P.w2) continue;
    for (let i = 0; i < pw; i++) {
      if (hash(i >> 3, j, 11) > 0.8 && hash(i, j, 12) > 0.3) dot(g, x + i, y + j, P.w1);
      else if (hash(i >> 2, j, 13) > 0.9) dot(g, x + i, y + j, P.w3);
    }
  }
  for (const [nx, ny] of [[3, 2], [pw - 4, 2], [3, ph - 3], [pw - 4, ph - 3]]) { dot(g, x + nx, y + ny, P.m6); dot(g, x + nx + 1, y + ny + 1, P.m2); }
  // letters: carved edge + shadow, then paint with a shaded bottom row
  const lx = x + 13, ly = y + 4, lit = new Set();
  eachPixel(title, 0, 0, 1, (gx, gy) => lit.add(gx + ',' + gy));
  g.fillStyle = P.w0;
  eachPixel(title, lx, ly, ts, (px, py) => g.fillRect(px - 1, py - 1, ts + 2, ts + 2));
  eachPixel(title, lx, ly, ts, (px, py) => g.fillRect(px + 1, py + 2, ts, ts));
  eachPixel(title, 0, 0, 1, (gx, gy) => {
    const px = lx + gx * ts, py = ly + gy * ts;
    fill(g, px, py, ts, ts, P.paint);
    if (!lit.has(gx + ',' + (gy + 1))) fill(g, px, py + ts - 1, ts, 1, P.paintShade);
    if (!lit.has(gx + ',' + (gy - 1)) && hash(gx, gy, 8) > 0.5) dot(g, px + 1, py, P.cream);
  });
  return cv;
}

// ---------------------------------------------------------------- scale + CSS variables
// whole device pixels per art pixel: the menu is laid out on a 640 x 360 art-pixel canvas
export function pixelScale() {
  const dpr = devicePixelRatio || 1;
  const k = Math.max(1, Math.min(Math.floor((innerHeight * dpr) / 352), Math.floor((innerWidth * dpr) / 620)));
  return { k, p: k / dpr };
}

let installed = false;
export function installMenuArt(root = document.documentElement) {
  const set = (k, v) => root.style.setProperty(k, v);
  const apply = () => { const { p, k } = pixelScale(); set('--p', `${p}px`); root.dataset.px = String(k); };
  apply();
  if (installed) return;
  installed = true;
  addEventListener('resize', apply);
  const wood = woodTile(5), dark = woodTile(17, true), paper = paperTile();
  set('--tex-wood', url(wood.cv)); set('--tex-wood-w', wood.w); set('--tex-wood-h', wood.h);
  set('--tex-wood-dark', url(dark.cv));
  set('--tex-paper', url(paper.cv)); set('--tex-paper-w', paper.w);
  set('--frame-wood', url(woodFrame().cv));
  set('--frame-plank', url(plankFrame().cv));
  set('--frame-paper', url(paperFrame().cv));
  set('--frame-sel', url(selFrame().cv));
  set('--frame-well', url(wellFrame().cv));
  set('--img-check-off', url(checkbox(false)));
  set('--img-check-on', url(checkbox(true)));
  set('--img-cursor', url(cursor()));
  set('--img-rope', url(rope()));
  for (const d of ['green', 'blue', 'black', 'dblack']) set(`--img-diff-${d}`, url(diffIcon(d)));
}
