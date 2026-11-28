// Tyre pressure: an on-board central tyre inflation system (CTIS) and what the pressure does to
// the tyre. Headless (no DOM, no three.js), so the physics tests drive it in Node.
//
// One live pressure for all four tyres (psi). It moves towards a target at a believable rate:
// deflating through the valves about 2 psi/s, inflating from the on-board compressor about
// 1 psi/s. Keys and HUD buttons either hold (keep going while held, stop where released) or tap
// (go to the next stop: min, crawl, trail, road, max). It works at any speed.
//
// Effects, all one continuous function of pressure, so nothing switches on or off:
//  - airFraction f(psi): how much of "aired down" the tyre is, from its footprint. A tyre's contact
//    patch carries the load at roughly the inflation pressure, so the patch area goes as 1 / psi;
//    f = (1/psi - 1/road) / (1/crawl - 1/road): 0 at road pressure, 1 at crawl pressure (10 psi),
//    above 1 below that. The older on / off "aired down" model (src/vehicle.js tyreGrip, src/mud.js
//    footprint, src/deepsand.js sinkage) is exactly f = 0 (aired up) and f = 1 (aired down), and
//    every one of its numbers is now mix(up, down, f) between those two ends.
//  - deflection: the loaded radius drops by DEFL * R * f * (load / static load)^0.8 (filtered), so
//    the truck sits lower and the tyre is a softer spring in series with the suspension. Drawn on
//    the wheels (src/tyres/tyre_view.js flattens the patch, bulges the sidewall and draws the truck
//    that much lower); the physics tyre (src/vehicle.js shrinks the wheel collider) takes the part
//    below crawl pressure only (PHYS_DEFL_FROM), so the tuned crawl-pressure tyre is unchanged.
//  - costs at speed (nothing below SPEED_GATE[0] km/h, so crawling is untouched): extra rolling
//    resistance (heat build-up in a flexing carcass), a softer, laggier tyre sideways (lower
//    cornering stiffness: lateral compliance on the grip rows, slower steering response), heat
//    when driven faster than the pressure is good for, and below the bead pressure a hard corner
//    or side hit can unseat a bead: a flat, fixed by the repair key.
import { MAT } from '../maps/common.js';
import { DEEP } from '../deepsand.js';

export const PSI_DEFAULT = { min: 8, crawl: 10, trail: 18, road: 32, max: 36, bead: 14, defl: 0.06 };
export const RATE = { down: 2, up: 1 };          // psi per second
export const SPEED_GATE = [40, 70];               // km/h: speed costs fade in between these (a crawl, and the run-ups of test/ledgeclimb.mjs, which peak at 30-34 km/h, stay under them)
export const TAP_S = 0.3;                         // a press shorter than this is a tap (next stop)
const RR_SPEED = 0.012;                            // extra rolling resistance at f = 1, 70 km/h (x load)
const LAT_COMPLIANCE = 8e-6;                       // extra sideways compliance at f = 1 (rad per N)
const STEER_LAG = 0.3;                             // steering rate lost at f = 1, full speed gate
const LOAD_TAU = 0.08;                             // s: load filter for the deflection
// The physics tyre shrinks only for the part of the air fraction past this (1 = below crawl
// pressure). The old aired-down tyre (f = 1) climbed ledges as a rigid tyre at full radius with
// more grip, and the ledge limits (test/ledgeclimb.mjs) and trail times are tuned on it: with the
// whole deflection in the physics (0 here) the Cruiser's square run-up limit drops 0.65 -> 0.60 m
// and the Rally Sedan's square ledges 0.25 -> 0.20 m. Above crawl pressure the deflection is drawn
// (the truck is drawn that much lower, src/tyres/tyre_view.js); below it the physics takes the rest.
export const PHYS_DEFL_FROM = 1;

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// a * (1 - f) + b * f: exactly a at f = 0 and exactly b at f = 1 (bit-identical to the old ends)
export const mix = (a, b, f) => a * (1 - f) + b * f;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export function psiSpec(spec) { return { ...PSI_DEFAULT, ...((spec && spec.tire && spec.tire.psi) || {}) }; }
export function airFraction(psi, P) { return (1 / psi - 1 / P.road) / (1 / P.crawl - 1 / P.road); }
// preset stops, low to high (no duplicates)
export function stops(P) { return [...new Set([P.min, P.crawl, P.trail, P.road, P.max])].sort((a, b) => a - b); }
export function zone(psi, P) { return psi < (P.crawl + P.trail) / 2 ? 'CRAWL' : psi < (P.trail + P.road) / 2 ? 'TRAIL' : 'ROAD'; }
// speed the pressure is good for (km/h); above it the tyre heats and the HUD warns
export function safeKmh(psi) { return 12 + 2.6 * psi; }
export const speedGate = (kmh) => smooth(SPEED_GATE[0], SPEED_GATE[1], kmh);

const NAMES = ['front-left', 'front-right', 'rear-left', 'rear-right'];

export class TyrePressure {
  constructor(spec, psi) {
    this.P = psiSpec(spec);
    this.R = spec.tire.radius;
    this.psi = clamp(psi ?? this.P.road, this.P.min, this.P.max);
    this.target = this.psi;
    this.hold = 0; this.holdT = 0; this.pressPsi = this.psi;
    this.heat = 0;                       // 0 = cool; 1 = hot (bead stress starts building)
    this.bead = [0, 0, 0, 0];            // per tyre: 1 = the bead lets go
    this.sideF = [0, 0, 0, 0];           // low-passed sideways contact force per tyre (N)
    this.loadF = [0, 0, 0, 0];           // low-passed load per tyre (N), for the deflection
    this.defl = [0, 0, 0, 0];            // deflection per tyre (m), radius lost under load (drawn)
    this.deflPhys = [0, 0, 0, 0];        // the part of it the physics tyre takes (m)
    this.kmh = 0; this.gate = 0;
    this.rrSpeed = 0;                    // extra rolling resistance (x load), added in tyreGrip
    this.latCfm = 0;                     // compliance on the sideways grip rows
    this.steerMul = 1;
    // the little state object audio reads (src/audio.js is another agent's): never replaced
    this.state = { psi: this.psi, inflating: false, deflating: false, target: this.target };
    this._calc();
  }

  _calc() { this.f = airFraction(this.psi, this.P); }

  // a rebuilt truck (repair, restart, spawn point) keeps the driver's pressure, any change in
  // progress and the audio state object (the same object, so a reader holding it keeps working)
  carry(o) {
    this.psi = clamp(o.psi, this.P.min, this.P.max); this.target = clamp(o.target, this.P.min, this.P.max);
    this.hold = o.hold; this.holdT = o.holdT; this.pressPsi = o.pressPsi; this.heat = o.heat;
    this.state = o.state; this._calc(); this._state();
  }

  // instant (a start, the garage, a test): no ramp
  set(psi) { this.psi = this.target = clamp(psi, this.P.min, this.P.max); this.hold = 0; this._calc(); this._state(); }
  setTarget(psi) { this.target = clamp(psi, this.P.min, this.P.max); this.hold = 0; this._state(); }
  // next stop from p in direction dir (-1 down, +1 up), past a small dead band
  nextStop(p, dir) {
    const s = stops(this.P);
    if (dir < 0) { for (let k = s.length - 1; k >= 0; k--) if (s[k] < p - 0.5) return s[k]; return this.P.min; }
    for (const v of s) if (v > p + 0.5) return v;
    return this.P.max;
  }
  // tap: from where it is heading if it is already going that way (tap tap = two stops)
  tap(dir) {
    const moving = Math.sign(this.target - this.psi) === dir && Math.abs(this.target - this.psi) > 0.05;
    this.setTarget(this.nextStop(moving ? this.target : this.psi, dir));
    return this.target;
  }
  // T: crawl <-> road
  toggle() { this.setTarget(this.target >= this.P.trail ? this.P.crawl : this.P.road); return this.target; }
  // key held down / let go (dir -1 deflate, +1 inflate)
  press(dir) { this.hold = dir; this.holdT = 0; this.pressPsi = this.psi; this.target = dir < 0 ? this.P.min : this.P.max; this._state(); }
  release(dir) {
    if (this.hold !== dir) return null;
    this.hold = 0;
    if (this.holdT < TAP_S) this.target = this.nextStop(this.pressPsi, dir); // a tap
    else this.target = this.psi;                                             // held: stop here
    this._state();
    return this.target;
  }
  get moving() { return Math.abs(this.target - this.psi) > 1e-6; }
  get inflating() { return this.target > this.psi + 1e-6; }
  get deflating() { return this.target < this.psi - 1e-6; }
  _state() { const s = this.state; s.psi = this.psi; s.target = this.target; s.inflating = this.inflating; s.deflating = this.deflating; }

  // One physics substep: the valves / compressor, and the per-step numbers the tyre model reads.
  // car: the Vehicle (speed, loads). Returns true on the step the pressure arrives at its target.
  step(h, car) {
    let arrived = false;
    if (this.hold) this.holdT += h;
    if (this.psi !== this.target) {
      const d = this.target - this.psi, r = (d < 0 ? RATE.down : RATE.up) * h;
      if (Math.abs(d) <= r) { this.psi = this.target; arrived = !this.hold; } else this.psi += Math.sign(d) * r;
      this._calc();
    }
    this._state();
    const kmh = car ? Math.abs(car.speed()) * 3.6 : 0;
    this.kmh = kmh; this.gate = speedGate(kmh);
    const fp = Math.max(0, this.f);
    // speed costs: zero below the gate (and at road pressure or harder), so crawling is untouched
    this.rrSpeed = this.gate > 0 && fp > 0 ? RR_SPEED * fp * this.gate * (kmh / SPEED_GATE[1]) : 0;
    // lateral compliance: slip velocity = cfm x impulse; a tyre of cornering compliance c (rad/N)
    // at speed V slips c F V sideways, and the impulse of one step is F h, so cfm = c V / h
    this.latCfm = this.gate > 0 && fp > 0 ? (LAT_COMPLIANCE * fp * this.gate * (kmh / 3.6)) / h : 0;
    this.steerMul = this.gate > 0 && fp > 0 ? 1 - STEER_LAG * Math.min(1, fp) * this.gate : 1;
    // heat: driving faster than the pressure is good for warms the carcass; it cools off slowly
    const over = kmh - safeKmh(this.psi);
    this.heat = over > 0 ? Math.min(1.5, this.heat + (over / safeKmh(this.psi)) * 0.25 * h) : Math.max(0, this.heat - 0.04 * h);
    if (car) this._deflect(h, car);
    return arrived;
  }

  // loaded radius per tyre: deflection grows as the tyre softens and with its load. defl is the
  // whole deflection (drawn); deflPhys the part the physics tyre takes (see PHYS_DEFL_FROM).
  _deflect(h, car) {
    const fp = Math.max(0, this.f), fq = Math.max(0, this.f - PHYS_DEFL_FROM), Wst = (car.mass * 9.81) / 4, k = Math.min(1, h / LOAD_TAU);
    for (let i = 0; i < 4; i++) {
      const ws = car.wheelState[i], N = ws && ws.load > 0 ? ws.load : 0;
      this.loadF[i] += (N - this.loadF[i]) * k;
      const s = fp > 0 ? this.P.defl * this.R * Math.pow(clamp(this.loadF[i] / Wst, 0.3, 2.5), 0.8) : 0;
      this.defl[i] = s * fp;
      this.deflPhys[i] = s * fq;
    }
  }

  // After the tyre solve: bead stress from hard cornering (sideways force against load at speed)
  // and from side hits, below the bead pressure. Returns the wheels whose bead just let go.
  post(car, patches, h) {
    const out = [];
    const P = this.P, soft = clamp((P.bead - this.psi) / (P.bead - 6), 0, 1), Wst = (car.mass * 9.81) / 4;
    const k = Math.min(1, h / 0.025);
    const side = [0, 0, 0, 0], lat = [0, 0, 0, 0], N = [0, 0, 0, 0];
    for (const pt of patches) {
      const ax = car.wheelAxis(pt.wheel);
      side[pt.wheel] += Math.abs(pt.n.x * ax.x + pt.n.y * ax.y + pt.n.z * ax.z) * pt.N; // push along the axle: into the sidewall
      lat[pt.wheel] += Math.abs(pt.lat || 0) / h; N[pt.wheel] += pt.N;
    }
    for (let i = 0; i < 4; i++) {
      this.sideF[i] += (side[i] - this.sideF[i]) * k;
      if (soft <= 0 || car.grace > 0 || car.broken[i] || car.health.tire[i] < 0.35) { this.bead[i] = Math.max(0, this.bead[i] - 0.5 * h); continue; }
      const g = smooth(40, 55, this.kmh);
      const u = N[i] > 1 ? lat[i] / N[i] : 0;                      // sideways force / load
      let rate = 2.5 * soft * Math.max(0, u - 0.4) * g;            // hard cornering on soft tyres (sideways force over 0.4 x load)
      if (this.heat > 1) rate += (this.heat - 1) * soft * 0.5;     // a hot, soft carcass
      this.bead[i] = rate > 0 ? this.bead[i] + rate * h : Math.max(0, this.bead[i] - 0.5 * h);
      if (g > 0 && soft * (this.sideF[i] / Wst) > 2.2) this.bead[i] = 1; // a hard side hit at speed
      if (this.bead[i] >= 1) { this.bead[i] = 0; out.push(i); }
    }
    return out;
  }
}
TyrePressure.NAMES = NAMES;

// ---- advice: warnings and hints for the HUD / toasts (pure; main.js shows them)
// Returns at most one message per call: { kind, text } or null.
export class TyreAdvisor {
  constructor() { this.warnT = 0; this.stuckT = 0; this.hintT = 0; }
  update(car, input, dt) {
    const T = car.tyre, P = T.P;
    this.warnT -= dt; this.hintT -= dt;
    const kmh = T.kmh, safe = safeKmh(T.psi);
    if (kmh > safe + 3 && this.warnT <= 0) {
      this.warnT = 6;
      return { kind: 'warn', text: `Soft tyres: ${Math.round(T.psi)} psi is good for about ${Math.round(safe / 5) * 5} km/h. Slow down or air up (])` };
    }
    // stuck in sand or mud at road pressure: wheels spinning, going nowhere
    let soft = 0;
    for (const ws of car.wheelState) if (ws.grounded && (ws.mat === MAT.SAND || ws.mat === MAT.MUD) && (ws.slip || 0) > 1) soft++;
    const stuck = T.psi >= (P.trail + P.road) / 2 && soft >= 2 && kmh < 3 && input.throttle > 0.4;
    this.stuckT = stuck ? this.stuckT + dt : 0;
    if (this.stuckT > 2 && this.hintT <= 0) {
      this.hintT = 20; this.stuckT = 0;
      return { kind: 'hint', text: `Stuck? Air down ([ or T): at ${Math.round(T.psi)} psi the tyres dig in. Lower pressure floats on ${car.wheelState.some((w) => w.mat === MAT.MUD) ? 'mud' : 'sand'}` };
    }
    return null;
  }
}

// What a pressure does, as numbers for the garage / HUD readout (relative to road pressure).
export function effects(psi, P) {
  const f = airFraction(psi, P), fp = Math.max(0, f);
  return {
    f,
    rockGrip: mix(1, 1.15, f),                  // mu on rock (src/vehicle.js tyreGrip)
    sandGrip: mix(1, 1.12, f),
    float: DEEP.sinkFull / Math.max(0.005, mix(DEEP.sinkFull, DEEP.sinkAired, f)), // deep-sand sinkage, road / this
    drag: mix(1, 1.25, f),                      // rolling resistance on hard ground
    dragFast: mix(1, 1.25, f) + (RR_SPEED * fp) / 0.015, // ... at 70 km/h on a graded road (rr 0.015)
    steer: 1 - STEER_LAG * Math.min(1, fp),     // steering response at speed
    safeKmh: safeKmh(psi),
    zone: zone(psi, P),
  };
}

// ---- persistence: the live pressure per rig (survives restarts and reloads)
const KEY = 'lowrange.tyres.v1';
const store = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };
function readAll() {
  const ls = store(); if (!ls) return {};
  try { const a = JSON.parse(ls.getItem(KEY) || '{}'); return a && typeof a === 'object' && !Array.isArray(a) ? a : {}; } catch { return {}; }
}
export function loadLivePsi(id) { const v = readAll()[id]; return Number.isFinite(v) ? v : null; }
export function saveLivePsi(id, psi) {
  const ls = store(); if (!ls) return;
  const all = readAll();
  if (psi === null || psi === undefined) delete all[id]; else all[id] = Math.round(psi * 10) / 10;
  try { ls.setItem(KEY, JSON.stringify(all)); } catch { /* storage full / disabled: this session only */ }
}
// the pressure a rig starts a drive at: the live value if one was saved, else the garage default
export function startPsi(spec) {
  const P = psiSpec(spec), live = loadLivePsi(spec.id);
  return clamp(live ?? spec.tire.psiStart ?? P.road, P.min, P.max);
}
