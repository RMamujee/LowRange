// HUD layout maths, pure (no DOM): which whole-number scale the pixel boards use and where they sit,
// so nothing leaves the window and nothing overlaps at any window size. hud.js feeds it the window and
// the board sizes; test/hudlayout.mjs checks it across a matrix of window sizes.
//
// Boards (sizes in HUD pixels, positions in CSS px, MARGIN from the window edges):
//   cluster  bottom-left            engine  on the cluster's left end, 3 HUD px above it
//   chassis  bottom-right ('side'), or beside the engine board above the cluster ('stacked'), or hidden
//   mini     top-right (minimap + guidance plaque)
//   tyre     beside the engine board, on the cluster (optional)
//   winch    above the chassis board, or bottom-right when the chassis board is hidden (optional)
// The scale starts from the height rule the HUD always used (at least 2, one step per 400 device px of
// height), then drops while the boards don't fit, down to 1. At each scale the optional boards are tried
// first (winch + tyre, then tyre only, then neither), so they never cost the others their scale or
// spot. If even scale 1 doesn't fit, boards are hidden, least important first: chassis, then minimap
// (the M key and MAP button still open the map), then the engine board. Toasts and the big centre messages are placed by fitToast() / fitBig().

import { measure, wrap } from '../ui/pixelfont.js';

export const MARGIN = 10, GAP = 4;
export const BOARDS = { cluster: [283, 77], engine: [136, 46], chassis: [216, 62], mini: [120, 166], tyre: [120, 46], winch: [112, 46] };
const ENGINE_LIFT = 3;
// The big map board (mapview.js BigMap): title row, viewport VW x VH beside the SB-wide sidebar, legend strip LEG tall.
export const BIGMAP = { mx: 6, my: 21, VW: 290, VH: 200, SB: 140, LEG: 13 };
export const BIGMAP_SIZE = [BIGMAP.mx + BIGMAP.VW + 4 + BIGMAP.SB + 6, BIGMAP.my + BIGMAP.VH + 3 + BIGMAP.LEG + 5];
// [tyre pressure] the tyre board sits beside the engine board, on the cluster (3 HUD px from each). Every
// mode below is tried with it first and then without it, so where it doesn't fit the other boards get
// exactly the scale and spots they had before it existed (the cluster's psi lamp still shows the pressure).
// [winch] The winch board sits above the chassis board on the right (3 HUD px above it), or in the
// bottom-right corner when the chassis board is hidden. It is tried first with the tyre board and
// dropped before it, so it never costs any other board its scale or spot either.
const withTyre = (set) => set.flatMap((m) => (m.engine ? [{ ...m, tyre: true, winch: true }, { ...m, tyre: true }, m] : [m]));
// the widest / tallest big message (main.js: race lap time at letter scale 5, WRONG WAY at 3)
export const BIG_MAX = [Math.max(measure('WRONG WAY') * 3, measure('10:23.4') * 5) + 8, 9 * 5 + 8];

const MODES = [
  [{ chassis: 'side', engine: true, mini: true }, { chassis: 'stacked', engine: true, mini: true }],
  [{ chassis: 'hidden', engine: true, mini: true }],
  [{ chassis: 'hidden', engine: true, mini: false }],
  [{ chassis: 'hidden', engine: false, mini: false }],
].map(withTyre);

export const overlaps = (a, b, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

function build(W, H, dpr, scale, mode, B) {
  const u = scale / dpr, r = (x, y, w, h) => ({ x, y, w: w * u, h: h * u });
  const [cw, ch] = B.cluster, [ew, eh] = B.engine, [sw, sh] = B.chassis, [mw, mh] = B.mini;
  const lift = (ch + ENGINE_LIFT) * u; // bottom offset of the row above the cluster
  const rects = { cluster: r(MARGIN, H - MARGIN - ch * u, cw, ch) };
  if (mode.engine) rects.engine = r(MARGIN, H - MARGIN - lift - eh * u, ew, eh);
  if (mode.tyre) { const [tw, th] = B.tyre; rects.tyre = r(MARGIN + (ew + ENGINE_LIFT) * u, H - MARGIN - lift - th * u, tw, th); } // [tyre pressure]
  if (mode.chassis === 'side') rects.chassis = r(W - MARGIN - sw * u, H - MARGIN - sh * u, sw, sh);
  else if (mode.chassis === 'stacked') rects.chassis = r(W - MARGIN - sw * u, H - MARGIN - lift - sh * u, sw, sh);
  if (mode.winch) { const [ww, wh] = B.winch, ch = rects.chassis; rects.winch = r(W - MARGIN - ww * u, ch ? ch.y - (ENGINE_LIFT + wh) * u : H - MARGIN - wh * u, ww, wh); } // [winch]
  if (mode.mini) rects.mini = r(W - MARGIN - mw * u, MARGIN, mw, mh);
  return { W, H, dpr, scale, u, ...mode, chassisBottom: mode.chassis === 'stacked' ? MARGIN + lift : MARGIN, rects };
}

function boardsFit(L) {
  const names = Object.keys(L.rects);
  for (const n of names) { const q = L.rects[n]; if (q.x < MARGIN - 1e-6 || q.y < MARGIN - 1e-6 || q.x + q.w > L.W - MARGIN + 1e-6 || q.y + q.h > L.H - MARGIN + 1e-6) return false; }
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const pair = [names[i], names[j]];
    const onCluster = (pair.includes('cluster') && (pair.includes('engine') || pair.includes('tyre') || (pair.includes('chassis') && L.chassis === 'stacked'))) // sits 3 HUD px above it by design
      || (pair.includes('engine') && pair.includes('tyre')) // [tyre pressure] 3 HUD px beside the engine board
      || (pair.includes('winch') && pair.includes('chassis')); // [winch] 3 HUD px above the chassis board
    if (overlaps(L.rects[names[i]], L.rects[names[j]], onCluster ? 0 : GAP)) return false;
  }
  return true;
}

// Spot (top-left, CSS px) for a w x h box: its home (x0, y0) if that is clear, else the nearest clear
// spot (slid up / down past a board, or sideways next to one), clear of every visible board and of the
// extra rects in `avoid`, inside the window. null if there is none (with onlyHome: if home is taken).
export function placeBox(L, w, h, x0, y0, avoid = [], onlyHome = false) {
  const obs = [...Object.values(L.rects), ...avoid], e = 1e-3;
  const ok = (x, y) => x >= MARGIN - 1e-6 && y >= MARGIN - 1e-6 && x + w <= L.W - MARGIN + 1e-6 && y + h <= L.H - MARGIN + 1e-6 && obs.every((q) => !overlaps({ x, y, w, h }, q, GAP));
  if (onlyHome) return ok(x0, y0) ? { x: x0, y: y0 } : null;
  const xs = [x0, MARGIN, L.W - MARGIN - w, ...obs.flatMap((q) => [q.x + q.w + GAP + e, q.x - GAP - w - e])];
  const ys = [y0, MARGIN, L.H - MARGIN - h, ...obs.flatMap((q) => [q.y + q.h + GAP + e, q.y - GAP - h - e])];
  let best = null, bc = Infinity;
  for (const x of xs) for (const y of ys) {
    const c = Math.abs(x - x0) + Math.abs(y - y0);
    if (c < bc && ok(x, y)) { best = { x, y }; bc = c; }
  }
  return best;
}

// Homes from hud.css: toast centred across, top at 15% of the height; big message centred at (50%, 38%).
const toastHome = (L, w) => [(L.W - w) / 2, L.H * 0.15];
const bigHome = (L, w, h) => [(L.W - w) / 2, L.H * 0.38 - h / 2];

// Toast (text already cleaned): wrapped as wide as 300 HUD px allows, narrower (more lines) if that
// keeps it at home clear of the minimap, else at the nearest clear spot; clear of the rects in `avoid`
// (a big message that is showing) when possible. ok: false only when a rect in `avoid` is in the way
// (hud.js then holds the toast back until the big message is gone); with nothing to avoid a toast is
// always shown, at home if no spot is clear. w, h in HUD px; x, y and box in CSS px; moved when it is
// not at home.
export function fitToast(L, text, avoid = []) {
  const u = L.u;
  const size = (ww) => { const lines = wrap(text, ww); return { lines, w: Math.max(...lines.map(measure)) + 22, h: lines.length * 10 + 13 }; };
  const done = (b, p, ok) => ({ ...b, ...p, moved: p.x !== toastHome(L, b.w * u)[0] || p.y !== toastHome(L, b.w * u)[1], ok, box: { x: p.x, y: p.y, w: b.w * u, h: b.h * u } });
  for (const pass of [0, 1, 2]) { // at home; anywhere clear; anywhere clear of the boards only
    for (let ww = 300; ww >= 100; ww -= 10) {
      const b = size(ww), p = placeBox(L, b.w * u, b.h * u, ...toastHome(L, b.w * u), pass < 2 ? avoid : [], pass === 0);
      if (p) return done(b, p, pass < 2 || !avoid.length);
    }
  }
  const b = size(Math.max(100, Math.floor((L.W - 2 * MARGIN) / u) - 22)), [x, y] = toastHome(L, b.w * u);
  return done(b, { x, y }, !avoid.length);
}

// Big message drawn at letter scale sc0 (HUD px per font px): at home or the nearest spot clear of the
// boards, with smaller letters (down to 2) if no spot is clear.
export function fitBig(L, text, sc0) {
  const u = L.u;
  let sc = sc0, w, h, p;
  for (;;) {
    w = measure(text) * sc + 8; h = 9 * sc + 8;
    p = placeBox(L, w * u, h * u, ...bigHome(L, w * u, h * u));
    if (p || sc <= 2) break;
    sc--;
  }
  const [hx, hy] = bigHome(L, w * u, h * u), ok = !!p;
  if (!p) p = { x: hx, y: hy };
  return { sc, w, h, x: p.x, y: p.y, moved: p.x !== hx || p.y !== hy, ok, box: { x: p.x, y: p.y, w: w * u, h: h * u } };
}

// W, H: window in CSS px; centre: the largest big message [w, h] in HUD px, which must find a spot too.
export function hudLayout({ W, H, dpr = 1, boards = BOARDS, centre = null }) {
  const base = Math.max(2, Math.floor((H * dpr) / 400));
  for (const set of MODES) {
    for (let s = base; s >= 1; s--) {
      for (const mode of set) {
        const L = build(W, H, dpr, s, mode, boards);
        if (!boardsFit(L)) continue;
        if (centre && !placeBox(L, centre[0] * L.u, centre[1] * L.u, ...bigHome(L, centre[0] * L.u, centre[1] * L.u))) continue;
        return L;
      }
    }
  }
  return build(W, H, dpr, 1, MODES.at(-1)[0], boards); // only the cluster, even if the window is narrower than it
}

// Whole-number scale that fits a w x h modal board (big map, controls board) in the given share of the
// window; below 1 it goes fractional so the board still fits, if blurrier.
export function fitScale(W, H, dpr, w, h, fw = 0.94, fh = 0.9) {
  const f = Math.min((W * dpr * fw) / w, (H * dpr * fh) / h);
  return f >= 1 ? Math.floor(f) : f;
}
