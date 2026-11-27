// Deep sand: dune driving as its own skill. Only active on a map that exports a sand depth field
// (terrain.js sandDepthAt: Sunfall Basin's dunes, src/maps/desert.js). Everywhere else, and on
// sand without depth (beaches, the race track), the plain Sand row of MAT_INFO applies exactly as
// before: Vehicle only creates this when the field exists, and every hook is a no-op at depth 0.
//
// What it adds on top of the Sand surface, scaled by the local depth D (0..1):
//  - sinkage per wheel: a static share from the wheel's load (a hard, aired-up tyre sinks about
//    twice as deep as an aired-down one), less at speed (the tyre runs up on the sand), more and
//    more while the tyre spins (it digs itself in), recovering slowly as it rolls out;
//  - motion resistance from that sinkage: a force on the truck at the wheel against its rolling
//    direction, proportional to the wheel load (Coulomb-like, so momentum carries over a crest
//    where the viscous Sand drag would bleed it off; that drag is scaled down here);
//  - grip: less than on a sand sheet, much less aired up and when dug in; sideways grip weaker
//    still, so a side-slope on soft sand slides.
// A parked tyre keeps vehicle.js's static hold on dune sand too, but inside the reduced sideways
// cap: across the 15° face the sand holds a parked truck; on a slope too steep for that cap (the
// 32° slip face) the tyre slides, stops counting as standing, and the hold lets go by itself.
// The net effect, measured by test/sand.mjs on the Practice Dune's 15° face: aired down a rig
// walks up from a standstill; aired up it bogs on the face from rest and only makes the top with
// a run-up; floor it and spin, and it digs in.
import { MAT } from './maps/common.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const DEEP = {
  sinkFull: 0.1, sinkAired: 0.045,   // static sinkage at full depth and normal load (m)
  digFull: 0.13, digAired: 0.05,     // extra sinkage a spinning tyre digs (m)
  digSlip: [1.5, 6.0],               // slip speeds (m/s) over which the digging builds up
  digRate: [0.02, 0.012, 0.08],      // how fast it digs: m/s, plus per m/s of slip, at most
  planeV: 4,                         // speed (m/s) at which the static sinkage has halved
  resFull: 0.11, resAired: 0.06,     // motion resistance of the sand itself (x wheel load)
  resSink: 1.0,                      // plus this much per metre of sinkage
  muFull: 0.25, muAired: 0.08,       // grip lost at full depth
  muSink: 1.5,                       // and per metre of sinkage
  latFull: 0.15, latAired: 0.1,      // sideways grip lost at full depth
  drag: 0.7,                         // share of the viscous Sand drag removed at full depth
};

export class DeepSand {
  constructor(car, depthAt) {
    this.car = car; this.depthAt = depthAt;
    this.D = [0, 0, 0, 0]; this.sink = [0, 0, 0, 0];
  }
  // Pre-physics, per wheel (vehicle.js terrain loop): updates sinkage, pushes back on the truck,
  // returns the factor for the plain viscous Sand drag.
  wheel(i, mat, p, lv, ws, grounded, fwd, h) {
    const D = mat === MAT.SAND && grounded ? this.depthAt(p.x, p.z) : 0;
    if (!Number.isFinite(this.sink[i])) this.sink[i] = 0;
    if (!(D > 0) || !Number.isFinite(lv.x + lv.z)) { this.D[i] = 0; this.sink[i] = Math.max(0, this.sink[i] - 0.1 * h); return 1; } // (also a NaN position or velocity: no sand)
    this.D[i] = D;
    const car = this.car, aired = car.airedDown, K = DEEP;
    const Wst = (car.mass * 9.81) / 4, N = ws.load > 0 ? ws.load : Wst;
    // rolling direction: the truck's heading, flattened
    const fl = Math.hypot(fwd.x, fwd.z) || 1, fx = fwd.x / fl, fz = fwd.z / fl;
    // digging comes from wheelspin (the tread turning faster than the ground passes under it), not
    // from a tyre sliding sideways: a sideways slide plows across the surface instead
    const vRoll = lv.x * fx + lv.z * fz, v = Math.abs(vRoll), spinSlip = Math.abs((ws.spin || 0) * car.spec.tire.radius - vRoll), slip = Number.isFinite(spinSlip) ? spinSlip : 0;
    const target = D * (aired ? K.sinkAired : K.sinkFull) * Math.sqrt(clamp(N / Wst, 0, 2)) / (1 + v / K.planeV)
      + D * (aired ? K.digAired : K.digFull) * clamp((slip - K.digSlip[0]) / (K.digSlip[1] - K.digSlip[0]), 0, 1);
    const rate = target > this.sink[i] ? Math.min(K.digRate[2], K.digRate[0] + K.digRate[1] * slip) : 0.03 + 0.05 * v;
    this.sink[i] += clamp(target - this.sink[i], -rate * h, rate * h);
    const c = D * (aired ? K.resAired : K.resFull) + this.sink[i] * K.resSink;
    const F = c * N * Math.tanh(vRoll / 0.4) * h;
    car.chassis.applyImpulseAtPoint({ x: -fx * F, y: 0, z: -fz * F }, p, true);
    return 1 - K.drag * D;
  }
  // Grip multipliers for a contact patch on wheel i (null off deep sand): { mu, lat }
  grip(i, mat) {
    const D = this.D[i];
    if (mat !== MAT.SAND || !(D > 0)) return null;
    const aired = this.car.airedDown, K = DEEP;
    // sinkage costs traction (a dug-in tyre spins in its hole) but not sideways hold: a sunk tyre
    // has sand banked against its side, so the sideways cap leaves the sinkage loss out
    const sinkF = clamp(1 - this.sink[i] * K.muSink, 0.5, 1);
    const mu = (1 - D * (aired ? K.muAired : K.muFull)) * sinkF;
    return { mu, lat: (1 - D * (aired ? K.latAired : K.latFull)) / sinkF };
  }
}
