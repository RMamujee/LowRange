// [tyre pressure] The tyre board, beside the engine board above the cluster: live pressure in big
// numerals, a strip from the rig's lowest to highest pressure with CRAWL / TRAIL / ROAD zones, the
// needle and the target it is heading for, arrows while deflating / inflating, a status lamp
// (VENT while the valves are open, COMP while the compressor runs, HOT, FLAT) and AIR- / AIR+
// buttons (tap: next stop, as the [ and ] keys). Drawn with the shared board / paper / text
// helpers (px.js), so it follows the HUD's look. Pure drawing: hud.js owns the canvas and clicks.
import { P, rect, px, board, paper, tiny, tinyMeasure, drawText, measure } from './px.js';
import { drawLamp } from './instruments.js';
import { zone, safeKmh } from '../tyres/pressure.js';
// (its size, BOARDS.tyre, and its spot live in layout.js with the other boards)

// the zone colours on the strip: crawl amber, trail green, road plain
const BAND = { CRAWL: [P.amber, P.amber, P.amberDark], TRAIL: [P.greenHi, P.green, P.greenDark], ROAD: [P.paperShade, P.paperShade, P.paperEdge] };

// small solid arrow, 5 wide x 3 tall, pointing down (dir < 0) or up
function arrow(g, x, y, dir, c) {
  for (let r = 0; r < 3; r++) { const w = dir < 0 ? 5 - 2 * r : 1 + 2 * r; rect(g, x + (5 - w) / 2, y + r, w, 1, c); }
}

// What the board shows, as one string: it is redrawn only when this changes.
export function tyreSig(car, clock) {
  const T = car.tyre, blink = Math.floor(clock * 4) % 2;
  const flat = car.health.tire.some((v, i) => v < 0.35 && !car.broken[i]);
  const fast = T.kmh > safeKmh(T.psi) + 3;
  return `${T.psi.toFixed(1)}|${T.target.toFixed(1)}|${T.inflating ? 'u' : T.deflating ? 'd' : '-'}|${(T.moving || fast || flat || T.heat > 0.7) ? blink : ''}|${fast}|${flat}|${T.heat > 0.7}`;
}

// Draws the board into g (w x h); returns the click regions [{ x, y, w, h, act }].
export function drawTyreGauge(g, w, h, car, clock) {
  const T = car.tyre, Pp = T.P, blink = Math.floor(clock * 4) % 2 === 1;
  const hits = [];
  board(g, 0, 0, w, h, { seed: 17 });
  paper(g, 4, 4, w - 8, 19, 18);
  // big numerals + PSI
  const num = String(Math.round(T.psi));
  drawText(g, num, 7, 6, P.ink);
  const nx = 7 + measure(num) + 2;
  tiny(g, 'PSI', nx, 11, P.inkSoft);
  // arrows while the pressure moves (blinking), pointing the way it goes
  if (T.moving && blink) arrow(g, nx + 1, 6, T.deflating ? -1 : 1, T.deflating ? P.amberDark : P.greenDark);
  // the strip: min .. max, zones at the midpoints between the stops
  const xs = 34, xe = w - 9, span = xe - xs, lo = Pp.min, hi = Pp.max;
  const at = (p) => xs + Math.round(((p - lo) / (hi - lo)) * span);
  for (let x = xs; x <= xe; x++) {
    const band = BAND[zone(lo + ((x - xs) / span) * (hi - lo), Pp)];
    for (let k = 0; k < 3; k++) px(g, x, 7 + k, band[k]);
  }
  rect(g, xs, 10, span + 1, 1, P.inkSoft);
  for (const s of [Pp.crawl, Pp.trail, Pp.road]) rect(g, at(s), 11, 1, 2, P.ink); // the stops
  if (T.moving) { const tx = at(T.target); rect(g, tx - 1, 5, 3, 1, P.ink); px(g, tx, 6, P.ink); } // where it is heading
  const nxp = at(T.psi);
  rect(g, nxp + 1, 6, 1, 6, P.ol); rect(g, nxp, 5, 1, 7, P.red); px(g, nxp, 5, P.redHi);
  // the zone in words, or a warning
  const fast = T.kmh > safeKmh(T.psi) + 3;
  const flat = car.health.tire.some((v, i) => v < 0.35 && !car.broken[i]);
  const z = zone(T.psi, Pp);
  if (flat) { if (blink) tiny(g, 'FLAT TYRE', xs, 15, P.red); }
  else if (fast) { if (blink) tiny(g, `TOO FAST ${Math.round(safeKmh(T.psi) / 5) * 5}`, xs, 15, P.red); }
  else tiny(g, z, xs, 15, z === 'CRAWL' ? P.amberDark : z === 'TRAIL' ? P.greenDark : P.inkSoft);
  // bottom row: status lamp, then AIR- / AIR+
  const st = flat ? ['FLAT', 'warn'] : T.heat > 0.7 ? ['HOT', blink ? 'warn' : 'on'] : T.inflating ? ['COMP', blink ? 'on' : null] : T.deflating ? ['VENT', 'on'] : ['CTIS', null];
  drawLamp(g, 5, 26, st[0], st[1]);
  let bx = w - 5 - (tinyMeasure('AIR-') + 7) - 2 - (tinyMeasure('AIR+') + 7);
  for (const [label, act, dir] of [['AIR-', 'airDown', -1], ['AIR+', 'airUp', 1]]) {
    const on = (dir < 0 && T.deflating) || (dir > 0 && T.inflating);
    const bw = drawLamp(g, bx, 26, label, on ? 'on' : null, 'button');
    hits.push({ x: bx, y: 26, w: bw, h: 10, act });
    bx += bw + 2;
  }
  return hits;
}
