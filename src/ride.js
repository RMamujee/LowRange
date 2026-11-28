// [ride] Suspension force model: spring, progressive lossy bump stop, soft droop strap and a
// two-slope (digressive) damper with separate bump and rebound curves. Pure maths, no Rapier:
// src/vehicle.js turns the result into the suspension joints' motor settings every step
// (target, stiffness, damping), so Rapier integrates it implicitly. An implicit spring-damper
// is stable at any rate, so a stiff bump stop or firm rebound damping can't blow up the way an
// explicit force could.
//
// Spec fields (src/specs.js, `susp`), per rig:
//   freq    ride frequency of the front axle (Hz), tyre included (the classic "ride rate" number)
//   freqR   ride frequency of the rear axle (Hz); a little above the front for a flat ride
//   zeta    damping ratio in bump at low shaft speed (body control)
//   zetaR   damping ratio in rebound at low shaft speed (1.5-3 x bump on real dampers)
//   knee    shaft speed (m/s) where the damper curve flattens (digressive valving)
//   hiB/hiR slope above the knee as a share of the low-speed slope, bump / rebound
//   rollDamp roll damping of a solid axle relative to its two dampers at spring spacing
// and on `tire`:
//   rate    vertical rate of one tyre at road pressure (N/m). The tyre collider itself is rigid
//           (Rapier), so the tyre's compliance lives here, in series with the suspension: the
//           ride rate the joint carries and the bump stop's rate as it nears the tyre's rate.
//           Scale it (e.g. tyre pressure) and the ride, sag and bump-stop hits follow.
// Missing fields fall back to RIDE (so parked or older specs still build).

export const G = 9.81;

export const RIDE = {
  freqR: 1.07,     // rear / front ride frequency when a spec gives no freqR
  zetaR: 1.8,      // rebound / bump damping when a spec gives no zetaR
  knee: 0.25,      // m/s
  hiB: 0.5, hiR: 0.5,
  rollDamp: 1.1,   // (1.4 before, on a symmetric damper: the bump + rebound pair now carries more)
  tyreRate: 250e3, // N/m per tyre
  // bump stop: engages over the last bsFrac of bump travel; its rate rises linearly with
  // engagement to bsRate x the ride rate (in series with the tyres) at the hard stop. Unloading,
  // it gives back only (1 - bsLoss) of its force (rubber / hydraulic hysteresis), and while it
  // is being compressed it adds bsDamp x the low-speed bump damping at full engagement.
  bsFrac: 0.4, bsRate: 8, bsLoss: 0.5, bsDamp: 8, bsRebound: 4,
  // the last `wall` metres before the joint's hard limit: the stop fully crushed (rubber solid,
  // tyre flat on its rim), rising to wallRate x the ride rate with wallDamp x the bump damping.
  // It brings the axle to the limit at walking speed: Rapier's hard joint limit, hit fast, pushes
  // the joint back out of its overlap and hands energy back (the "bounce off the stops").
  wall: 0.015, wallRate: 200, wallDamp: 25,
  // droop: a strap / rebound stop over the last strap metres of droop, rising to strapRate x
  // the ride rate at full droop, with strapDamp x the rebound damping, so topping out is soft
  strap: 0.03, strapRate: 6, strapDamp: 1,
};

const val = (x, d) => (Number.isFinite(x) ? x : d);

// Per-axle suspension constants. `share` = how many joints carry the axle (1 solid, 2 independent);
// everything returned is per joint.
export function rideAxle(spec, a, share = 1) {
  const s = spec.susp, t = spec.tire;
  const m = spec.chassis.mass / 2;                         // sprung mass on this axle
  const f = a === 0 ? s.freq : val(s.freqR, s.freq * RIDE.freqR);
  const kRide = m * (2 * Math.PI * f) ** 2;                // axle ride rate (spring and tyres in series)
  const kT = 2 * val(t.rate, RIDE.tyreRate);               // the axle's two tyres
  const kS = (kRide * kT) / Math.max(1, kT - kRide);       // spring alone (wheel rate)
  const crit = 2 * Math.sqrt(kRide * m);
  const zB = s.zeta, zR = val(s.zetaR, s.zeta * RIDE.zetaR);
  const L = Math.max(0.01, RIDE.bsFrac * s.bump);
  const Ls = Math.max(0.01, Math.min(RIDE.strap, s.droop * 0.4));
  const j = 1 / share;
  return {
    f, m: m * j, k: kRide * j, kS: kS * j, kT: kT * j, sag: (m * G) / kRide,
    cB: zB * crit * j, cR: zR * crit * j,
    knee: val(s.knee, RIDE.knee), hiB: val(s.hiB, RIDE.hiB), hiR: val(s.hiR, RIDE.hiR),
    bump: s.bump, droop: s.droop,
    L, a: (RIDE.bsRate * kRide * j) / L,                   // bump-stop rate slope (N/m per m of engagement)
    aW: (RIDE.wallRate * kRide * j) / RIDE.wall,
    Ls, aS: (RIDE.strapRate * kRide * j) / Ls,
  };
}

// Effective damping coefficient (N·s/m) of a two-slope damper at shaft speed v (+ = bump),
// for a damper whose low-speed coefficients are cB / cR. F(v) = c v up to the knee, then the
// slope drops to hi x c: firm at body-motion speeds, softer on sharp hits.
export function damperC(p, v, cB = p.cB, cR = p.cR) {
  const bump = v > 0, hi = bump ? p.hiB : p.hiR, av = Math.abs(v);
  // bump and rebound blend over the first V0 of shaft speed, so a joint at rest doesn't flip its
  // damping every step (the valve's bleed: real dampers don't switch at exactly zero either)
  const V0 = 0.02, s = Math.min(1, av / V0), c = 0.5 * (cB + cR) + (bump ? 0.5 : -0.5) * (cB - cR) * s;
  if (av <= p.knee) return c;
  return (c * (p.knee + hi * (av - p.knee))) / av;
}

// Damper force at shaft speed v (N, opposing the motion; + = resisting bump)
export const damperF = (p, v) => damperC(p, v) * v;

// Bump stop in series with the tyres: rate a·d (d = engagement) against the tyres' kT
// gives k(d) = a d kT / (a d + kT), force = ∫ k = kT d - kT²/a · ln(1 + a d / kT).
export function bumpStop(p, d) {
  if (d <= 0) return { F: 0, k: 0 };
  const x = (p.a * d) / p.kT;
  return { F: p.kT * d - ((p.kT * p.kT) / p.a) * Math.log1p(x), k: (p.a * d * p.kT) / (p.a * d + p.kT) };
}

// Motor settings for one suspension joint at position x (m, + = compressed, 0 = static ride
// height) moving at v (m/s, + = compressing). c = damping coefficient from the damper(s) on it
// (damperC), off = static offset of the spring's seat (a bent spring sits lower).
// Returns { target, K, C }: the joint motor force is K (target - x) - C v, which is the full
// non-linear force linearised about x.
export function rideMotor(p, x, v, c, off = 0) {
  let F = p.k * (off - p.sag - x), K = p.k, C = c;
  // bump stop
  const d = x - (p.bump - p.L);
  if (d > 0) {
    const bs = bumpStop(p, d);
    const ext = Math.min(1, Math.max(0, -v / 0.05));            // unloading: hysteresis
    const s = 1 - RIDE.bsLoss * ext;
    F -= bs.F * s; K += bs.k * s;
    const comp = Math.min(1, Math.max(0, v / 0.05));
    C += RIDE.bsDamp * p.cB * Math.sqrt(Math.min(1, d / p.L)) * comp;
    C += RIDE.bsRebound * p.cR * Math.min(1, d / p.L) * ext; // position-sensitive rebound: leaving the stop is held back
    const dw = x - (p.bump - RIDE.wall);
    if (dw > 0) { F -= 0.5 * p.aW * dw * dw * s; K += p.aW * dw * s; C += RIDE.wallDamp * p.cB * Math.min(1, dw / RIDE.wall) * comp; }
  }
  // droop strap
  const e = (p.Ls - p.droop) - x;
  if (e > 0) {
    F += 0.5 * p.aS * e * e; K += p.aS * e;
    C += RIDE.strapDamp * p.cR * Math.min(1, e / p.Ls);
  }
  return { target: x + F / K, K, C };
}

// Spring + stop potential energy at x (J) on the loading curve, for energy checks in tests.
export function rideEnergy(p, x, off = 0) {
  const x0 = off - p.sag;
  let E = 0.5 * p.k * (x - x0) ** 2;
  const d = x - (p.bump - p.L);
  if (d > 0) { // ∫ F_bs dd
    const kT = p.kT, a = p.a, u = (a * d) / kT;
    E += 0.5 * kT * d * d - (kT * kT / a) * (((1 + u) * Math.log1p(u) - u) * kT / a);
    const dw = x - (p.bump - RIDE.wall);
    if (dw > 0) E += (p.aW * dw ** 3) / 6;
  }
  const e = (p.Ls - p.droop) - x;
  if (e > 0) E += (p.aS * e ** 3) / 6;
  return E;
}
