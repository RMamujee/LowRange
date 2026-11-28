// [tyre pressure] The tyre board, beside the engine board above the cluster: live pressure in display
// numerals (the bitmap face at 2x) with its unit, a strip from the rig's lowest to highest pressure
// with crawl / trail / road zones, the needle and the target it is heading for, the zone (or a
// warning) and the target in body text, a status lamp (Vent while the valves are open, Comp while the
// compressor runs, Hot, Flat, else CTIS) and Air- / Air+ keys (tap: next stop, as the [ and ] keys).
// Drawn with the shared board / paper / text helpers and colours (px.js, the HUD legibility rules:
// body text 7 px caps, text colours at 4.5:1 or better on parchment). Pure drawing: hud.js owns the
// canvas and clicks. Its size, BOARDS.tyre, and its spot live in layout.js with the other boards.
import { P, rect, px, board, paper, text, drawText, measure } from './px.js';
import { drawLamp, lampWidth, LAMP_H } from './instruments.js';
import { zone, safeKmh } from '../tyres/pressure.js';

// the zone colours on the strip: crawl amber, trail green, road plain
const BAND = { CRAWL: [P.amber, P.amber, P.amberDark], TRAIL: [P.greenHi, P.green, P.greenDark], ROAD: [P.paperShade, P.paperShade, P.paperShade] };
const ZONE = { CRAWL: ['Crawl', P.textHot], TRAIL: ['Trail', P.textGood], ROAD: ['Road', P.text2] };
export const STRIP_X = 44; // the strip starts right of the widest numerals ("36" at 2x) and their unit
const LY = 31; // the lamp / key row, as on the engine board

// small solid arrow, 5 wide x 3 tall, pointing down (dir < 0) or up
function arrow(g, x, y, dir, c) {
  for (let r = 0; r < 3; r++) { const w = dir < 0 ? 5 - 2 * r : 1 + 2 * r; rect(g, x + (5 - w) / 2, y + r, w, 1, c); }
}

const isFlat = (car) => car.health.tire.some((v, i) => v < 0.35 && !car.broken[i]);
const isFast = (T) => T.kmh > safeKmh(T.psi) + 3;

// What the board shows, as one string: it is redrawn only when this changes.
export function tyreSig(car, clock) {
  const T = car.tyre, blink = Math.floor(clock * 4) % 2;
  const flat = isFlat(car), fast = isFast(T);
  return `${T.psi.toFixed(1)}|${T.target.toFixed(1)}|${T.inflating ? 'u' : T.deflating ? 'd' : '-'}|${(T.moving || fast || flat || T.heat > 0.7) ? blink : ''}|${fast}|${flat}|${T.heat > 0.7}`;
}

// Draws the board into g (w x h); returns the click regions [{ x, y, w, h, act }].
export function drawTyreGauge(g, w, h, car, clock) {
  const T = car.tyre, Pp = T.P, blink = Math.floor(clock * 4) % 2 === 1;
  const hits = [];
  board(g, 0, 0, w, h, { seed: 17 });
  paper(g, 4, 4, w - 8, 25, 18);
  // display numerals + unit, baselines level (caps 14 px at 2x, from y 7 to 21)
  const num = String(Math.round(T.psi));
  drawText(g, num, 7, 7, P.text, { scale: 2 });
  const ux = 7 + measure(num) * 2 + 2;
  text(g, 'psi', ux, 14, P.text2);
  // arrow over the unit while the pressure moves (blinking), pointing the way it goes
  if (T.moving && blink) arrow(g, ux + 3, 8, T.deflating ? -1 : 1, T.deflating ? P.textHot : P.textGood);
  // the strip: min .. max, zones at the midpoints between the stops
  const xs = STRIP_X, xe = w - 9, span = xe - xs, lo = Pp.min, hi = Pp.max;
  const at = (p) => xs + Math.round(((p - lo) / (hi - lo)) * span);
  for (let x = xs; x <= xe; x++) {
    const band = BAND[zone(lo + ((x - xs) / span) * (hi - lo), Pp)];
    for (let k = 0; k < 3; k++) px(g, x, 8 + k, band[k]);
  }
  rect(g, xs, 11, span + 1, 1, P.inkSoft);
  for (const s of [Pp.crawl, Pp.trail, Pp.road]) rect(g, at(s), 12, 1, 2, P.ink); // the stops
  if (T.moving) { const tx = at(T.target); rect(g, tx - 1, 5, 3, 1, P.ink); px(g, tx, 6, P.ink); } // where it is heading
  const nxp = at(T.psi);
  rect(g, nxp + 1, 7, 1, 6, P.ol); rect(g, nxp, 6, 1, 7, P.red); px(g, nxp, 6, P.redHi);
  // second line: the zone in words, or a warning; the target while it moves
  const fast = isFast(T), flat = isFlat(car);
  if (flat) { if (blink) text(g, 'Flat tyre', xs, 17, P.textWarn); }
  else if (fast) { if (blink) text(g, `Too fast ${Math.round(safeKmh(T.psi) / 5) * 5}`, xs, 17, P.textWarn); }
  else {
    const [zw, zc] = ZONE[zone(T.psi, Pp)];
    text(g, zw, xs, 17, zc);
    if (T.moving) text(g, `to ${Math.round(T.target)}`, w - 9, 17, P.text2, { align: 'right' });
  }
  // bottom row: status lamp, then Air- / Air+ keys at the right
  const st = flat ? ['Flat', 'warn'] : T.heat > 0.7 ? ['Hot', blink ? 'warn' : 'on'] : T.inflating ? ['Comp', blink ? 'on' : null] : T.deflating ? ['Vent', 'on'] : ['CTIS', null];
  drawLamp(g, 5, LY, st[0], st[1]);
  let bx = w - 5 - lampWidth('Air-') - 2 - lampWidth('Air+');
  for (const [label, act, dir] of [['Air-', 'airDown', -1], ['Air+', 'airUp', 1]]) {
    const on = (dir < 0 && T.deflating) || (dir > 0 && T.inflating);
    const bw = drawLamp(g, bx, LY, label, on ? 'on' : null, 'button');
    hits.push({ x: bx, y: LY, w: bw, h: LAMP_H, act });
    bx += bw + 2;
  }
  return hits;
}
