// Winch physics: a one-sided line between the fairlead on the chassis and an anchor.
//
// The line is a soft, one-sided constraint row that joins the drivetrain's exact boxed solve
// (Drivetrain.step, through the `extra.rows` that Vehicle.postPhysics builds for the tyre grip), so
// winch, tyre grip, brakes and engine are solved together and never fight each other. The row acts
// on the chassis only (its linear and angular DOFs, like the grip rows), at the fairlead, so a pull
// pitches and yaws the truck as a real one does. Nothing is applied to the light axle or wheel bodies.
//
//   C = d - L          d: fairlead to anchor along the line (over one crest, see below), L: line out
//   C <= 0             slack: zero force (the row is skipped once C < -SLACK_SKIP)
//   taut               a spring-damper (soft constraint: frequency FREQ, damping ratio ZETA, scaled to
//                      the truck's mass), impulse in [0, rated pull x h]: a line only pulls
//   winching in        L shrinks at the line speed (slower under load); at the rated pull the drum
//                      stalls (L stops shrinking, the spring holds at the cap), it never snaps in v1
//   paying out         L grows at PAYOUT m/s, the truck may roll back that fast
//   holding            L fixed (the drum brake), capped at the rated pull too
// L is never allowed to sit further inside d than the cap can hold (d - L <= cap / k), so a stall or an
// overload never winds up stretch that would be released as a jerk later.
//
// Ground in the way: the line may bend over ONE crest (the highest point of ground or rock that pokes
// through the straight line), which then acts as a fixed pulley: d = |F - P| + |P - A| and the force on
// the truck points from the fairlead to the crest. An anchor whose line would also cut the ground
// after that bend (or that is behind a tree, rock or prop) is refused when picking (src/winch/anchors.js).
//
// Stowed (no anchor): no row at all, so the physics is bit-identical to a truck without a winch.
// No three.js and no DOM: Node tests drive it.

export const WINCH = {
  FREQ: 2.5,          // Hz, line + mount stiffness against the whole truck's mass
  ZETA: 1.0,          // damping ratio of the line
  SLACK_SKIP: 0.5,    // m of slack beyond which the row is left out altogether
  HOOK_SLACK: 0.3,    // m of slack left when hooking up
  MIN_LINE: 1.2,      // m: the hook stops this far out (it can't be wound into the fairlead)
  SPEED_FREE: 0.75,   // m/s line speed with no load (45 m/min: a game-friendly few times real)
  SPEED_RATED: 0.15,  // m/s at the rated pull (9 m/min)
  PAYOUT: 0.6,        // m/s powered pay-out
  LAYER_MIN: 0.7,     // pull with the drum full, as a share of the first-layer (rated) pull
  STALL_T: 0.25,      // s at the cap with the drum stopped before the state reads STALLED
  CREST_EVERY: 4,     // physics steps between crest (pivot) updates
  USE_LOAD: 0.02,     // tension share of the cap that counts as "winch used" (assisted runs)
};

// The rig's winch from its spec (src/specs.js `winch`), or null. pull: first-layer rated pull as a
// multiple of the truck's weight; line: metres of line; fairlead: chassis-local [x, y, z] (m).
export function winchSpec(spec, mass) {
  const w = spec.winch;
  if (!w) return null;
  const f = w.fairlead ?? [0, 0, -spec.chassis.size[2] / 2 - 0.1];
  const k = w.speed ?? 1;
  return {
    kind: w.kind ?? 'winch', line: w.line ?? 28, pull: (w.pull ?? 1.5) * mass * 9.81,
    fl: { x: f[0], y: f[1], z: f[2] },
    speedFree: WINCH.SPEED_FREE * k, speedRated: WINCH.SPEED_RATED * k, payout: WINCH.PAYOUT * k,
  };
}

// What audio (or anything else) can read without touching the physics: updated every physics step by
// the active truck's winch. running: the motor turns (in or out); load: tension / rated pull (0-1);
// direction: 1 winching in, -1 paying out, 0 stopped.
export const WINCH_AUDIO = { running: false, load: 0, direction: 0 };

// ---- small vector helpers (plain objects)
const v3 = (x, y, z) => ({ x, y, z });
const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const scale = (a, s) => v3(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a) => Math.hypot(a.x, a.y, a.z);
export function qrot(q, p) {
  const { x, y, z, w } = q;
  const ix = w * p.x + y * p.z - z * p.y, iy = w * p.y + z * p.x - x * p.z;
  const iz = w * p.z + x * p.y - y * p.x, iw = -x * p.x - y * p.y - z * p.z;
  return v3(ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x);
}
const qconj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

// ---------------------------------------------------------------- line geometry
// Surface height under (x, z): the highest fixed ground or rock below `top` (a ray straight down,
// vehicles and loose props ignored). Returns -Infinity where nothing is hit.
export function surfaceProbe(R, world) {
  const ray = new R.Ray(v3(0, 0, 0), v3(0, -1, 0));
  const flags = R.QueryFilterFlags.EXCLUDE_DYNAMIC;
  return (x, z, top, depth = 12) => {
    ray.origin = v3(x, top, z);
    const hit = world.castRay(ray, depth, true, flags, 0xffff0001);
    return hit ? top - hit.timeOfImpact : -Infinity;
  };
}

// The line from F to A over at most one crest. ignore(x, z): true near the anchor itself (its own
// collider is not "in the way"). Returns { P (pivot or null), d (line length), n (unit pull direction at
// the fairlead), clear (false if the line cuts the surface even after the bend) }.
export function lineGeometry(F, A, probe, ignore = () => false, tol = 0.05) {
  const D = sub(A, F), L = len(D);
  const N = Math.max(4, Math.min(90, Math.ceil(L / 0.3)));
  const samples = [];
  let best = null, bestEx = 0.02;
  for (let i = 1; i < N; i++) {
    const t = i / N, x = F.x + D.x * t, z = F.z + D.z * t, y = F.y + D.y * t;
    if (Math.hypot(x - F.x, z - F.z) < 0.6 || ignore(x, z)) continue; // the truck's own nose and the anchor
    const s = probe(x, z, Math.max(F.y, A.y) + 4);
    samples.push({ t, x, z, s });
    if (s - y > bestEx) { bestEx = s - y; best = { x, y: s + 0.03, z, t }; }
  }
  if (!best) return { P: null, d: L, n: scale(D, 1 / Math.max(L, 1e-6)), clear: true };
  const P = v3(best.x, best.y, best.z), d1 = len(sub(P, F)), d2 = len(sub(A, P));
  // after the bend: both legs must clear the surface
  let clear = true;
  for (const q of samples) {
    const y = q.t < best.t ? F.y + (P.y - F.y) * (q.t / best.t) : P.y + (A.y - P.y) * ((q.t - best.t) / (1 - best.t));
    if (q.s - y > tol + 0.03) { clear = false; break; }
  }
  return { P, d: d1 + d2, n: scale(sub(P, F), 1 / Math.max(d1, 1e-6)), clear };
}

// ---------------------------------------------------------------- the winch on one truck
export class Winch {
  // car: a Vehicle; probe: surfaceProbe(...) for the crest
  constructor(car, probe) {
    this.car = car; this.probe = probe;
    this.ws = winchSpec(car.spec, car.mass);
    this.anchor = null;      // { x, y, z, kind, r, ... } world attach point
    this.L = 0;              // line out (m) while hooked
    this.cmd = 0;            // 1 in, -1 out, 0 hold
    this.powered = true;     // engine running (set by the controller each frame)
    this.T = 0;              // line tension last step (N)
    this.load = 0;           // T / current cap
    this.stallT = 0;
    this.used = false;       // tension above USE_LOAD since the controller last looked
    this.row = null;
    this.geo = null; this.pivotAge = 0;
    this.taut = false;
    this.peakT = 0;
  }

  get hooked() { return !!this.anchor; }
  // chassis-local fairlead -> world
  fairlead() { const c = this.car.chassis, q = c.rotation(), p = c.translation(); return add(p, qrot(q, this.ws.fl)); }
  // rated pull on the current drum layer (first layer = all line out = rated)
  cap() { const ws = this.ws; return ws.pull * (WINCH.LAYER_MIN + (1 - WINCH.LAYER_MIN) * Math.min(1, this.L / ws.line)); }
  get state() {
    if (!this.anchor) return 'STOWED';
    if (this.stallT >= WINCH.STALL_T) return 'STALLED';
    if (this.cmd > 0 && this.powered) return 'PULLING';
    if (this.cmd < 0 && this.powered) return 'PAYING OUT';
    return 'HOOKED';
  }

  // the anchor's own collider (trunk, rock) is not "in the way" of its line
  ignoreNear(A) { const c = A.anchor ?? A, r = (A.r ?? 0.3) + 0.35; return (x, z) => Math.hypot(x - c.x, z - c.z) < r; }

  // hook up to an anchor (world attach point); the line is laid out with a little slack
  hook(anchor) {
    const F = this.fairlead();
    this.anchor = anchor; this.body = this.car.chassis;
    this.geo = lineGeometry(F, anchor, this.probe, this.ignoreNear(anchor));
    this.pivotAge = 0;
    this.L = Math.min(this.ws.line, this.geo.d + WINCH.HOOK_SLACK);
    this.cmd = 0; this.T = 0; this.load = 0; this.stallT = 0; this.taut = false; this.peakT = 0;
    return this.geo;
  }
  unhook() { this.anchor = null; this.geo = null; this.row = null; this.cmd = 0; this.T = 0; this.load = 0; this.stallT = 0; this.taut = false; }

  // ---- Vehicle.postPhysics hooks: add the line's row to the drivetrain solve, then apply its impulse
  addRow(extra, com, inv, h) {
    this.row = null;
    if (!this.anchor) { this.T = 0; this.load = 0; return; }
    if (this.car.chassis !== this.body) { this.unhook(); return; } // the truck was rebuilt in place: the line is let go
    const car = this.car, ws = this.ws, A = this.anchor, F = this.fairlead();
    if (++this.pivotAge >= WINCH.CREST_EVERY || !this.geo) { this.geo = lineGeometry(F, A, this.probe, this.ignoreNear(A)); this.pivotAge = 0; }
    const P = this.geo.P;
    const to = P ?? A, D = sub(to, F), d1 = len(D);
    const d = P ? d1 + len(sub(A, P)) : d1;
    const n = scale(D, 1 / Math.max(d1, 1e-6));
    const cap = this.cap();
    const run = this.powered ? this.cmd : 0;
    // line speed: slower as the load rises (the motor's torque-speed curve)
    const sIn = ws.speedFree + (ws.speedRated - ws.speedFree) * Math.min(1, this.load);
    const vt = run > 0 ? sIn : run < 0 ? -ws.payout : 0;
    // drum: wind in / pay out, then never further inside d than the cap can hold
    const M = car.mass, w = 2 * Math.PI * WINCH.FREQ, k = M * w * w, c = 2 * WINCH.ZETA * M * w;
    if (run > 0 && this.stallT <= 0) this.L = Math.max(WINCH.MIN_LINE, this.L - sIn * h);
    else if (run < 0) this.L = Math.min(ws.line, this.L + ws.payout * h);
    this.L = Math.max(this.L, d - (cap * 1.02) / k);
    if (this.L > ws.line) this.L = ws.line; // all the line is out: it is tied to the drum
    const C = d - this.L;
    this.taut = C > -0.01;
    if (C < -WINCH.SLACK_SKIP) { this.T = 0; this.load = 0; return; }
    // soft constraint (Catto): cfm gamma and the position bias; slack is speculative (rigid)
    const gamma = 1 / (h * (c + h * k)), beta = (h * k) / (c + h * k);
    const bias = C > 0 ? (beta * C) / h : C / h;
    const tq = qrot(inv, cross(sub(F, com), n));
    const vF = car.chassis.velocityAtPoint(F);
    const v0 = dot(vF, n) - vt - bias;
    // not pulling this step (the fairlead is already closing on the anchor faster than the line needs):
    // leave the row out rather than hand the solve a row it can only clamp at zero
    if (v0 >= 0) { this.T = 0; this.load = 0; return; }
    const pairs = [7, n.x, 8, n.y, 9, n.z, 10, tq.x, 11, tq.y, 12, tq.z];
    this.row = { pairs, v0, lo: 0, hi: cap * h, cfm: gamma, n, F, cap, vt };
    extra.rows.push(this.row);
  }

  applyRow(h) {
    const r = this.row;
    if (!r) { this.stallT = 0; this.publish(); return; }
    const imp = Math.max(0, Math.min(r.hi, r.imp ?? 0));
    if (imp > 0) this.car.chassis.applyImpulseAtPoint(scale(r.n, imp), r.F, true);
    this.T = imp / h; this.load = this.T / r.cap; this.peakT = Math.max(this.peakT, this.T);
    if (this.load > WINCH.USE_LOAD) this.used = true;
    // stall: at the cap while winching in (the drum stops turning until the load drops)
    const atCap = r.clamped && imp >= r.hi * 0.999;
    if (this.cmd > 0 && this.powered && atCap) this.stallT += h; else this.stallT = 0;
    this.row = null;
    this.publish();
  }

  publish() {
    const run = this.anchor && this.powered && this.cmd !== 0 && this.stallT < WINCH.STALL_T;
    WINCH_AUDIO.running = !!run; WINCH_AUDIO.load = Math.min(1, this.load); WINCH_AUDIO.direction = run ? this.cmd : 0;
  }
}

// Stowed / no truck: the motor is silent.
export function quietAudio() { WINCH_AUDIO.running = false; WINCH_AUDIO.load = 0; WINCH_AUDIO.direction = 0; }
