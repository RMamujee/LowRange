// The cluster's pixel instruments: analog dials, the H-pattern stick shifter, the transfer-case lever,
// locker rocker switches, the parking-brake lever, pedal bars and the lamp/button strip.
// Each draws itself into a low-res 2D context at (x, y); stateful ones animate between updates.
import { P, mk, rect, px, plate, inset, shape, ball, line, tiny, text, measure, clamp, spriteFrom, rotSprite } from './px.js';

const WOOD_KNOB = [P.w5, P.w4, P.w3, P.w1];
const WOOD_KNOB_LIFT = [P.cream, P.w5, P.w4, P.w2];
const RED_KNOB = [P.redHi, P.red, P.redDark, P.redDeep];
const HUB = [P.m6, P.m5, P.m4, P.m2];

// ------------------------------------------------------------------ analog dial
// A 55px round gauge: wooden bezel, parchment face, ink ticks + numerals, red zone, red pixel needle.
export class Dial {
  constructor(size = 55) { this.size = size; this.v = 0; this.face = null; }

  // max: full scale; major: numbered tick step; minor: small tick step; div: numeral divisor; red: red zone start
  configure({ max, major, minor, div = 1, red = null, title = '', sub = '' }) {
    Object.assign(this, { max, major, minor, div, red, title, sub });
    const S = this.size, c = S / 2, R = S / 2, f = mk(S, S), g = f.g;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - c, dy = y + 0.5 - c, d = Math.hypot(dx, dy);
      if (d > R) continue;
      const lit = -(dx + dy) / Math.max(1, d);
      let col;
      if (d > R - 1) col = P.ol;
      else if (d > R - 4) col = lit > 0.45 ? P.w5 : lit > -0.1 ? P.w4 : lit > -0.6 ? P.w3 : P.w2;
      else if (d > R - 5) col = P.ol;
      else if (d > R - 6.2 && lit > -0.2) col = P.paperShade;
      else col = P.paper;
      px(g, x, y, col);
    }
    const ang = (v) => this.angle(v);
    if (red != null) {
      const a0 = ang(red), a1 = ang(max);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const dx = x + 0.5 - c, dy = y + 0.5 - c, d = Math.hypot(dx, dy);
        if (d < R - 10 || d > R - 6) continue;
        let a = Math.atan2(dy, dx); while (a < a0) a += Math.PI * 2;
        if (a <= a1) px(g, x, y, d < R - 9 ? P.redDark : P.red);
      }
    }
    for (let v = 0; v <= max + 1e-6; v += minor) {
      const a = ang(v), isMaj = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      const r0 = isMaj ? R - 11 : R - 8.5, r1 = R - 6;
      line(g, c - 0.5 + Math.cos(a) * r0, c - 0.5 + Math.sin(a) * r0, c - 0.5 + Math.cos(a) * r1, c - 0.5 + Math.sin(a) * r1, isMaj ? P.ink : P.inkSoft);
    }
    const rn = R - 15.5;
    for (let v = 0; v <= max + 1e-6; v += major) {
      const a = ang(v), label = String(Math.round(v / div));
      if (label.length > 2 && v + major > max + 1e-6 && title) continue; // the last wide numeral would sit on the title
      tiny(g, label, Math.round(c - 0.5 + Math.cos(a) * rn) + 1, Math.round(c - 0.5 + Math.sin(a) * rn) - 2, red != null && v >= red ? P.redDark : P.ink, { align: 'center' });
    }
    if (title) tiny(g, title, Math.round(c), Math.round(c) + 4, P.text2, { align: 'center' });
    if (sub) tiny(g, sub, Math.round(c) + 15, Math.round(c) + 18, P.text2, { align: 'left' });
    this.face = f.cv;
  }

  angle(v) { const A0 = Math.PI * 0.75, SW = Math.PI * 1.5; return A0 + clamp(v / this.max, 0, 1.02) * SW; }

  draw(g, x, y, value, digital, dt, warn = false) {
    const k = 1 - Math.exp(-dt * 18);
    this.v += (value - this.v) * k;
    g.drawImage(this.face, x, y);
    const S = this.size, c = S / 2 - 0.5, R = S / 2;
    // digital readout window
    const dw = 21, dx = x + Math.round(c - dw / 2) + 1, dy = y + Math.round(c) + 11;
    inset(g, dx, dy, dw, 8, P.m0);
    tiny(g, digital, dx + dw - 3, dy + 2, warn ? P.redHi : P.amber, { align: 'right' });
    // needle: dark shadow, then a red blade, a little tail and the hub
    const a = this.angle(this.v), ca = Math.cos(a), sa = Math.sin(a), tip = R - 7;
    const cx = x + c, cy = y + c;
    line(g, cx + 1, cy + 1, cx + ca * tip + 1, cy + sa * tip + 1, P.ol);
    line(g, cx - ca * 4, cy - sa * 4, cx + ca * tip, cy + sa * tip, P.red);
    line(g, cx + (Math.abs(sa) > 0.7 ? 1 : 0), cy + (Math.abs(sa) > 0.7 ? 0 : 1), cx + ca * tip * 0.55 + (Math.abs(sa) > 0.7 ? 1 : 0), cy + sa * tip * 0.55 + (Math.abs(sa) > 0.7 ? 0 : 1), P.redDark);
    px(g, Math.round(cx + ca * tip), Math.round(cy + sa * tip), P.redHi);
    ball(g, cx + 0.5, cy + 0.5, 2.6, HUB);
  }
}

// ------------------------------------------------------------------ H-pattern shifter
// Gear layout per box: columns of [top, bottom] slots (-1 = reverse). The neutral rail runs across the middle.
export function gateLayout(n) {
  const cols = [];
  for (let gr = 1; gr <= n; gr += 2) cols.push([gr, gr + 1 <= n ? gr + 1 : null]);
  if (n % 2 === 1) cols[cols.length - 1][1] = -1;       // 5-speed: R under 5
  else if (n >= 6) cols.unshift([-1, null]);            // 6-speed: R up and left of 1
  else cols.push([null, -1]);                           // 4-speed: R down and right
  return cols;
}

export class Shifter {
  constructor() { this.W = 52; this.H = 52; this.kx = 0; this.ky = 0; this.path = []; this.gear = null; this.shake = 0; }
  configure(n) {
    this.cols = gateLayout(n);
    const nc = this.cols.length, sp = nc >= 4 ? 11 : 13;
    this.colX = this.cols.map((_, i) => Math.round(this.W / 2 + (i - (nc - 1) / 2) * sp));
    this.yT = 14; this.yN = 26; this.yB = 38;
    // neutral rests in the column holding 3rd (or the middle one)
    let ni = this.cols.findIndex((c) => c[0] === 3);
    if (ni < 0) ni = Math.floor((nc - 1) / 2);
    this.nX = this.colX[ni];
    this.gear = 0; this.kx = this.nX; this.ky = this.yN; this.path = [];
  }
  slotOf(gear) {
    if (gear === 0) return [this.nX, this.yN];
    for (let i = 0; i < this.cols.length; i++) {
      if (this.cols[i][0] === gear) return [this.colX[i], this.yT];
      if (this.cols[i][1] === gear) return [this.colX[i], this.yB];
    }
    return [this.nX, this.yN];
  }
  setGear(gear) {
    if (gear === this.gear) return;
    this.gear = gear;
    const [tx, ty] = this.slotOf(gear);
    // out of the current slot to the neutral rail, across, then into the new slot
    this.path = [[Math.round(this.kx), this.yN], [tx, this.yN], [tx, ty]];
  }
  nudge() { this.shake = 0.3; }
  update(dt) {
    let step = dt * 150;
    while (step > 0 && this.path.length) {
      const [tx, ty] = this.path[0], dx = tx - this.kx, dy = ty - this.ky, d = Math.hypot(dx, dy);
      if (d <= step) { this.kx = tx; this.ky = ty; step -= d; this.path.shift(); }
      else { this.kx += (dx / d) * step; this.ky += (dy / d) * step; step = 0; }
    }
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt);
  }
  // gear under a click at plate-local (lx, ly), or null
  hit(lx, ly) {
    let best = null, bd = 8;
    const cand = [[0, this.nX, this.yN]];
    this.cols.forEach((c, i) => { if (c[0] !== null) cand.push([c[0], this.colX[i], this.yT - 3]); if (c[1] !== null) cand.push([c[1], this.colX[i], this.yB + 3]); });
    for (const [gr, x, y] of cand) { const d = Math.hypot(lx - x, ly - y); if (d < bd) { bd = d; best = gr; } }
    return best;
  }
  draw(g, x, y, { clutchIn = false } = {}) {
    plate(g, x, y, this.W, this.H);
    // the gate: dark channels with a lit lower lip
    const chan = (x0, y0, w, h) => { rect(g, x + x0, y + y0, w, h, P.m0); rect(g, x + x0, y + y0 + h, w, 1, P.m5); };
    chan(this.colX[0] - 1, this.yN - 1, this.colX[this.colX.length - 1] - this.colX[0] + 3, 3);
    this.cols.forEach((c, i) => {
      const cx = this.colX[i] - 1;
      if (c[0] !== null) chan(cx, this.yT - 2, 3, this.yN - this.yT + 2);
      if (c[1] !== null) chan(cx, this.yN, 3, this.yB - this.yN + 2);
    });
    // slot numbers: current gear in amber
    const lab = (gr) => (gr === -1 ? 'R' : String(gr));
    this.cols.forEach((c, i) => {
      const lx = x + this.colX[i] + 1;
      if (c[0] !== null) tiny(g, lab(c[0]), lx, y + this.yT - 11, c[0] === this.gear ? P.amber : c[0] === -1 ? P.redHi : P.m6, { align: 'center', shadow: P.ol });
      if (c[1] !== null) tiny(g, lab(c[1]), lx, y + this.yB + 7,c[1] === this.gear ? P.amber : c[1] === -1 ? P.redHi : P.m6, { align: 'center', shadow: P.ol });
    });
    tiny(g, 'N', x + this.W - 5, y + this.yN - 2, this.gear === 0 ? P.amber : P.m5, { align: 'right', shadow: P.ol });
    // the stick: shadow, short shaft stub, then the wooden knob (lifts and brightens with the clutch in)
    const sh = this.shake > 0 ? Math.round(Math.sin(this.shake * 90)) : 0;
    const kx = x + Math.round(this.kx) + 0.5 + sh, ky = y + Math.round(this.ky) + 0.5 - (clutchIn ? 1 : 0);
    const so = clutchIn ? 3 : 2;
    ball(g, kx + so - 1, ky + so, 4, [P.ol, P.ol, P.ol, P.ol], null);
    rect(g, Math.round(kx) - 1, Math.round(ky) + 2, 2, 3, P.m2);
    ball(g, kx, ky, 4.2, clutchIn ? WOOD_KNOB_LIFT : WOOD_KNOB);
  }
}

// ------------------------------------------------------------------ transfer-case lever
export class TransferLever {
  constructor() { this.W = 24; this.H = 52; this.y = 26; this.pos = '4H'; }
  static Y = { '2H': 12, '4H': 26, '4L': 40 };
  update(dt, pos) { this.pos = pos; const ty = TransferLever.Y[pos]; this.y += clamp(ty - this.y, -dt * 90, dt * 90); }
  hit(lx, ly) { let best = null, bd = 9; for (const [k, yy] of Object.entries(TransferLever.Y)) { const d = Math.abs(ly - yy); if (d < bd && lx >= 0 && lx < this.W) { bd = d; best = k; } } return best; }
  draw(g, x, y, { has2H = true, has4L = true } = {}) {
    plate(g, x, y, this.W, this.H, { screws: false });
    const sx = x + 16;
    rect(g, sx - 1, y + 10, 3, 33, P.m0); rect(g, sx - 1, y + 43, 3, 1, P.m5);
    for (const [k, yy] of Object.entries(TransferLever.Y)) {
      const ok = (k !== '2H' || has2H) && (k !== '4L' || has4L), cur = k === this.pos;
      rect(g, sx - 3, y + yy, 2, 1, P.m1); // detent notch
      tiny(g, k, x + 3, y + yy - 2, cur ? P.amber : ok ? P.m6 : P.m4, { shadow: P.ol });
      if (!ok) rect(g, x + 2, y + yy, 9, 1, P.redDark);
    }
    ball(g, sx + 1.5, y + this.y + 2.5, 3.2, [P.ol, P.ol, P.ol, P.ol], null);
    ball(g, sx + 0.5, y + this.y + 0.5, 3.4, RED_KNOB);
  }
}

// ------------------------------------------------------------------ locker rocker switches
export function drawLockers(g, x, y, { front, rear, hasF, hasR }) {
  const W = 24, H = 52;
  plate(g, x, y, W, H, { screws: false });
  text(g, 'Lock', x + W / 2 + 1, y + 2, P.m6, { align: 'center', shadow: P.ol });
  const rocker = (ry, on, has, label) => {
    const rx = x + 5;
    rect(g, rx, ry, 14, 19, P.ol); rect(g, rx + 1, ry + 1, 12, 17, P.m0);
    if (!has) { // blanking plug
      rect(g, rx + 2, ry + 2, 10, 15, P.m2); px(g, rx + 6, ry + 8, P.m5); px(g, rx + 7, ry + 9, P.m1);
      tiny(g, label, rx + 7, ry + 12, P.m4, { align: 'center' });
      return;
    }
    // the raised half is lit; the pressed half sinks into shadow
    const top = on ? [P.m6, P.m5] : [P.m3, P.m2], bot = on ? [P.m3, P.m2] : [P.m6, P.m5];
    rect(g, rx + 2, ry + 2, 10, 8, top[1]); rect(g, rx + 2, ry + 2, 10, 1, top[0]);
    rect(g, rx + 2, ry + 10, 10, 7, bot[1]); rect(g, rx + 2, ry + 16, 10, 1, P.m1);
    rect(g, rx + 2, ry + 9 + (on ? 1 : 0), 10, 1, P.m1);
    // indicator lens
    rect(g, rx + 4, ry + 3 + (on ? 0 : 1), 6, 3, on ? P.amber : P.m1);
    if (on) { rect(g, rx + 4, ry + 3, 3, 1, P.amberHi); }
    tiny(g, label, rx + 7, ry + 11 + (on ? 1 : 0), P.ink, { align: 'center' });
  };
  rocker(y + 10, front, hasF, 'F');
  rocker(y + 31, rear, hasR, 'R');
  return { f: [5, 10, 14, 19], r: [5, 31, 14, 19] };
}

// ------------------------------------------------------------------ parking brake lever
export class ParkLever {
  constructor() { this.W = 28; this.H = 52; this.a = 0; }
  update(dt, up) { const t = up ? 1 : 0; this.a += clamp(t - this.a, -dt * 6, dt * 6); }
  draw(g, x, y, { park, held }) {
    plate(g, x, y, this.W, this.H, { screws: false });
    // (P) lamp
    const lx = x + 20, ly = y + 7, on = park, amber = !park && held;
    shape(g, lx - 5, ly - 5, lx + 5, ly + 5, (qx, qy) => {
      const d = Math.hypot(qx + 0.5 - lx - 0.5, qy + 0.5 - ly - 0.5);
      if (d > 4.6) return null;
      if (on) return d > 3.6 ? P.redDark : P.red;
      if (amber) return d > 3.6 ? P.amberDark : P.amber;
      return d > 3.6 ? P.m1 : P.m2;
    });
    tiny(g, 'P', lx + 1, ly - 2, on ? P.cream : amber ? P.ol : P.m4, { align: 'center' });
    if (on) { px(g, lx - 6, ly, P.red); px(g, lx - 6, ly + 1, P.red); px(g, lx + 7, ly, P.red); px(g, lx + 7, ly + 1, P.red); }
    // the lever, pivoting at the lower left: grip with ridges, shaft, release button
    const pxv = x + 6.5, pyv = y + 40.5, L = 21;
    const ang = -(0.12 + this.a * 0.78);
    const c = Math.cos(ang), s = Math.sin(ang);
    rect(g, x + 2, y + 42, 12, 4, P.m1); rect(g, x + 2, y + 42, 12, 1, P.m4);
    shape(g, x + 1, y + 10, x + this.W - 2, y + 46, (qx, qy) => {
      const dx = qx + 0.5 - pxv, dy = qy + 0.5 - pyv, u = dx * c + dy * s, v = -dx * s + dy * c;
      if (u < -1 || u > L) return null;
      const hw = u > L - 9 ? 2.3 : 1.4;
      if (Math.abs(v) > hw) return null;
      if (u > L - 1.6) return P.m6;
      if (u > L - 9) return (Math.floor(u) % 2 === 0) ? P.m2 : (v < 0 ? P.m3 : P.m1);
      return v < -0.4 ? P.m6 : v < 0.6 ? P.m5 : P.m4;
    });
    ball(g, pxv, pyv, 2.6, HUB);
    tiny(g, 'PARK', x + this.W / 2 + 1, y + 47 - 1, park ? P.redHi : P.m6, { align: 'center', shadow: P.ol }); // a stamped mark under the lever (no room for body text above the plate's rim)
  }
}

// ------------------------------------------------------------------ pedal bars
export function drawPedals(g, x, y, { t, b, c }) {
  const bars = [[t, P.greenHi, P.green, 'T'], [b, P.redHi, P.red, 'B'], [c, P.blueHi, P.blue, 'C']];
  bars.forEach(([v, hi, base, lab], i) => {
    const bx = x + i * 6;
    inset(g, bx, y, 5, 44, P.m0);
    const lit = Math.round(clamp(v, 0, 1) * 10 + (v > 0.02 ? 0.49 : 0));
    for (let k = 0; k < 10; k++) {
      const sy = y + 42 - k * 4 - 3;
      rect(g, bx + 1, sy, 3, 3, k < lit ? (k === lit - 1 ? hi : base) : P.m2);
    }
    tiny(g, lab, bx + 3, y + 46, P.paint, { align: 'center', shadow: P.ol });
  });
}

// ------------------------------------------------------------------ lamps + buttons
// kind: 'lamp' (inset, lights up) or 'button' (raised wooden key). state: null | 'on' | 'good' | 'warn'
// Labels are body text (7 px caps); the key / lamp is LAMP_H tall. Contrast: ink on the wooden key 5.7:1,
// on amber 9.4:1, on green 9.1:1; cream on the red warning lamp 7.5:1; an unlit lamp's label (m5 on m1) 5.6:1.
export const LAMP_H = 12;
export const lampWidth = (label) => measure(label) + 7;
export function drawLamp(g, x, y, label, state, kind = 'lamp') {
  const w = lampWidth(label), h = LAMP_H;
  if (kind === 'button') {
    rect(g, x, y, w, h, P.ol);
    rect(g, x + 1, y + 1, w - 2, h - 2, state ? P.amber : P.btn);
    rect(g, x + 1, y + 1, w - 2, 1, state ? P.amberHi : P.btnHi); rect(g, x + 1, y + h - 2, w - 2, 1, state ? P.amberDark : P.btnLo);
    text(g, label, x + 4, y + 2, P.ol);
    return w;
  }
  const fill = state === 'on' ? P.amber : state === 'good' ? P.greenHi : state === 'warn' ? P.redDark : P.m1;
  inset(g, x, y, w, h, fill);
  if (state) rect(g, x + 1, y + 1, w - 2, 1, state === 'warn' ? P.red : state === 'good' ? '#c4ec8a' : P.amberHi);
  text(g, label, x + 4, y + 2, state === 'warn' ? P.cream : state ? P.ol : P.m5);
  return w;
}

// ------------------------------------------------------------------ small truck sprites for the inclinometers
function truckSide() {
  const f = mk(28, 15), g = f.g;
  shape(g, 1, 1, 26, 13, (x, y) => {
    const wheel = [7, 21].some((wx) => Math.hypot(x + 0.5 - wx - 0.5, y + 0.5 - 11.5) < 3.6);
    if (wheel) { const hub = [7, 21].some((wx) => Math.hypot(x + 0.5 - wx - 0.5, y + 0.5 - 11.5) < 1.5); return hub ? P.m5 : P.m1; }
    if (y >= 6 && y <= 10 && x >= 1 && x <= 26) {
      if (x === 26 && y === 7) return P.amberHi;
      if (x === 1 && y === 7) return P.red;
      return y === 10 ? P.paperEdge : y === 6 ? P.cream : P.paper;
    }
    if (y >= 2 && y <= 5) { const front = 20 - (5 - y); if (x >= 8 && x <= front) { if (y >= 3 && x >= 10 && x <= front - 1 && x !== 15) return P.blue; return P.paper; } }
    if (y === 1 && x >= 9 && x <= 16) return P.m3; // roof rack
    return null;
  });
  return f.cv;
}
function truckRear() {
  const f = mk(22, 17), g = f.g;
  shape(g, 1, 1, 20, 15, (x, y) => {
    if ((x <= 4 || x >= 17) && y >= 10 && y <= 15) return x === 4 || x === 17 ? P.m2 : P.m1;
    if (y >= 6 && y <= 11 && x >= 2 && x <= 19) {
      if ((x === 3 || x === 18) && y >= 7 && y <= 8) return P.red;
      return y === 11 ? P.paperEdge : y === 6 ? P.cream : P.paper;
    }
    if (y >= 2 && y <= 5 && x >= 4 && x <= 17) { if (y >= 3 && x >= 6 && x <= 15) return P.blue; return P.paper; }
    if (y === 1 && x >= 6 && x <= 15) return P.m3;
    return null;
  });
  return f.cv;
}
let SIDE = null, REAR = null;

// Inclinometer: round framed dial with a truck silhouette tilting inside; warns in red past `warn` degrees.
export function drawIncl(g, x, y, deg, kind, warn, t) {
  if (!SIDE) { SIDE = spriteFrom(truckSide()); REAR = spriteFrom(truckRear()); }
  const S = 44, c = S / 2, R = S / 2, hot = Math.abs(deg) > warn, flash = hot && Math.floor(t * 4) % 2 === 0;
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const dx = i + 0.5 - c, dy = j + 0.5 - c, d = Math.hypot(dx, dy);
    if (d > R) continue;
    const lit = -(dx + dy) / Math.max(1, d);
    let col;
    if (d > R - 1) col = P.ol;
    else if (d > R - 4) col = hot && flash ? (lit > 0 ? P.redHi : P.red) : (lit > 0.45 ? P.w5 : lit > -0.1 ? P.w4 : lit > -0.6 ? P.w3 : P.w2);
    else if (d > R - 5) col = P.ol;
    else col = dy > 6 ? (hot ? '#e89a80' : P.paperShade) : (hot ? P.warnFace : P.paper);
    px(g, x + i, y + j, col);
  }
  // ground line + angle ticks every 15 degrees along the rim
  rect(g, x + 6, y + c + 6, S - 12, 1, P.paperEdge);
  for (const a of [-45, -30, -15, 0, 15, 30, 45]) {
    for (const side of [0, Math.PI]) {
      const r = a * Math.PI / 180 + side, r0 = R - 9, r1 = R - 6;
      line(g, x + c - 0.5 + Math.cos(r) * r0, y + c - 0.5 + Math.sin(r) * r0, x + c - 0.5 + Math.cos(r) * r1, y + c - 0.5 + Math.sin(r) * r1, Math.abs(a) >= 30 ? P.red : P.inkSoft);
    }
  }
  const ang = (kind === 'pitch' ? -deg : deg) * Math.PI / 180;
  rotSprite(g, kind === 'pitch' ? SIDE : REAR, x + c, y + c + 1, ang);
}
