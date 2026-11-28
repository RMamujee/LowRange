// Vehicle physics: chassis + two solid axles on rigid bodies and joints.
//
//   chassis --prismatic(Y, spring)--> slider --revolute(Z, roll spring)--> axle
//   axle --revolute(Y, steering motor)--> knuckle --revolute(X, free)--> wheel
//
// The axle is a real rigid body, so one wheel climbing a rock lifts/tilts the whole axle
// (articulation), the diff pumpkin can hang up on rocks, and drive torque reacts through
// the axle housing. Wheel spin is coupled to the Drivetrain each substep.

import { Drivetrain } from './drivetrain.js';
import { MAT, MAT_INFO, materialAt, GROUP_VEHICLE, sandDepthAt } from './terrain.js';
import { CrashModel } from './damage/crash.js';
import { MUD, mudDamping } from './mud.js'; // [mud]
import { DeepSand } from './deepsand.js'; // [deep sand] dunes on maps with a sand depth field (the desert)
import { TyrePressure, mix } from './tyres/pressure.js'; // [tyre pressure] live pressure (CTIS) and its effects

const G = 9.81;
const WHEEL_G = 13; // windowed wheel load (in static corner loads) above which suspension bends
const WHEEL_V0 = 3.0, WHEEL_V1 = 5.0; // wheel closing speed (m/s): no wheel damage below V0, full above V1
// Standing tyres (postPhysics): a patch slower than STICK_V (m/s, ground and tread speed) holds
// its spot: HOLD_BETA of the slide since it stopped is taken back per step (at most HOLD_MAX m),
// and its grip rows get a little compliance, HOLD_CFM (m/s per N·s), like the tread's.
const STICK_V = 0.04, HOLD_BETA = 0.1, HOLD_MAX = 0.05, HOLD_CFM = 1e-4;

// ---- tiny vector/quaternion helpers (plain objects, no three.js) ----
const v = (x, y, z) => ({ x, y, z });
const add = (a, b) => v(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => v(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a, s) => v(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a) => Math.hypot(a.x, a.y, a.z);
export function qrot(q, p) {
  const { x, y, z, w } = q;
  const ix = w * p.x + y * p.z - z * p.y, iy = w * p.y + z * p.x - x * p.z;
  const iz = w * p.z + x * p.y - y * p.x, iw = -x * p.x - y * p.y - z * p.z;
  return v(ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x);
}
const qconj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const qmul = (a, b) => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const qyaw = (a) => ({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) });

export class Vehicle {
  constructor(RAPIER, world, spec, terrain, pos, yaw = 0) {
    this.R = RAPIER; this.world = world; this.spec = spec; this.terrain = terrain;
    this.tyre = new TyrePressure(spec); // [tyre pressure] starts at road pressure (main.js sets the drive's start)
    this.rearSteerOn = false;
    this.steer = 0;
    // Damage: 1 = healthy, 0 = destroyed. Big impacts wear these down.
    this.health = { tire: [1, 1, 1, 1], susp: [1, 1, 1, 1], engine: 1, body: 1 };
    this.broken = [false, false, false, false];
    this.dents = [];          // manual dents for the view: { p (chassis-local), n (local, into the body), amount }
    this.damageEvents = [];   // short messages for the HUD
    this.GROUP_VEHICLE = GROUP_VEHICLE;
    // crash model (src/damage/crash.js): impact energy, the body's deformation cage, mechanical damage
    this.crash = new CrashModel(this);
    this.deepSand = sandDepthAt ? new DeepSand(this, sandDepthAt) : null; // [deep sand] null on maps without dunes: no change there
    const t = spec.tire;
    this.wheelI = t.mass * t.radius * t.radius * 0.7;
    this.dt = new Drivetrain(spec, this.wheelI);
    this.build(pos, yaw);
    this.wheelState = [0, 1, 2, 3].map(() => ({ grounded: false, mat: MAT.DIRT, hitDist: 0, spin: 0, angle: 0, depth: 0 }));
    // tread compound (garage build): [mu, rr] multipliers per surface, keyed by MAT name
    this.treadMul = [];
    for (const [name, i] of Object.entries(MAT)) this.treadMul[i] = (t.grip && t.grip[name]) || [1, 1];
  }

  build(pos, yaw) {
    const { R, world, spec } = this;
    const q = qyaw(yaw);
    const place = (local) => add(pos, qrot(q, local));
    const M = spec.chassis.mass, [cw, ch, cl] = spec.chassis.size;
    const rot = q;

    // chassis
    const cb = world.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z).setRotation(rot)
      .setAdditionalMassProperties(M, v(0, spec.chassis.comY, 0),
        v(M / 12 * ((ch * 2.4) ** 2 + cl ** 2) * 0.8, M / 12 * (cw ** 2 + cl ** 2) * 0.8, M / 12 * ((ch * 2.4) ** 2 + cw ** 2) * 0.8),
        { x: 0, y: 0, z: 0, w: 1 })
      .setLinearDamping(0.02).setAngularDamping(0.05).setCanSleep(false));
    const boxes = []; // remembered for the crash model (crushed ends / roof shrink these)
    const box = (hx, hy, hz, ox, oy, oz, fr = 0.5, name = '') => {
      const col = world.createCollider(
        R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(ox, oy, oz).setDensity(0).setFriction(fr)
          .setCollisionGroups(GROUP_VEHICLE), cb);
      boxes.push({ col, hx, hy, hz, ox, oy, oz, cur: { hy, hz }, name });
      return col;
    };
    const ends = spec.chassis.ends;
    if (!ends) box(cw * 0.42, ch / 2, cl / 2, 0, 0, 0, 0.5, 'frame'); // frame rails / skid plate, bumper to bumper
    else {
      // Ends shaped after the model's underside (spec.chassis.ends, chassis-local). The full-width
      // frame / skid box stops `frame` m past each axle, behind the tyres' leading edge; ahead of
      // it: a pan (rails, crossmember, skid plate) and the bumper, its centre section at the
      // model's bumper height and, where given, its outer wings set higher. A box the full width
      // of the truck out to the bumper used to sit lower and further out than the bumper you see
      // and stuck out ahead of the tyres at the corners, so on a ledge taken at an angle the
      // corner of the box met the rock before the tyre did.
      // Every piece reaches up to the frame box's top; distances run outward from the axle.
      const zf = -spec.wheelbase / 2, zr = spec.wheelbase / 2, top = ch / 2;
      box(cw * 0.42, ch / 2, (zr - zf) / 2 + ends.frame, 0, 0, (zf + zr) / 2, 0.5, 'frame');
      const slab = (x0, x1, yb, d0, d1, sgn, name) => {
        const za = (sgn < 0 ? zf : zr) + sgn * d0, zb = (sgn < 0 ? zf : zr) + sgn * d1;
        const hy = (top - yb) / 2, oy = (top + yb) / 2, hz = Math.abs(zb - za) / 2, oz = (za + zb) / 2;
        if (x0 <= 0) box(x1, hy, hz, 0, oy, oz, 0.5, name);
        else for (const sx of [-1, 1]) box((x1 - x0) / 2, hy, hz, sx * (x0 + x1) / 2, oy, oz, 0.5, name + (sx < 0 ? 'L' : 'R'));
      };
      for (const [sgn, e, end] of [[-1, ends.front, 'front'], [1, ends.rear, 'rear']]) {
        if (!e) continue;
        if (e.pan) { const [hx, y, d1] = e.pan; slab(0, hx, y, ends.frame, d1, sgn, end + 'Pan'); }
        const [bx, by, b0, b1] = e.bumper;
        slab(0, bx, by, b0, b1, sgn, end + 'Bumper');
        if (e.wings) { const [wx, wy, w0, w1] = e.wings; slab(bx, wx, wy, w0, w1, sgn, end + 'Wing'); }
      }
    }
    // body shell: cab / cage, so rollovers land on the roof
    if (spec.body === 'buggy') box(cw * 0.5, 0.55, 0.95, 0, ch / 2 + 0.55, 0.1, 0.4);
    if (spec.body === 'pickup') { box(cw * 0.5, 0.5, 0.95, 0, ch / 2 + 0.5, -0.35, 0.4); box(cw * 0.5, 0.22, cl * 0.2, 0, ch / 2 + 0.22, cl * 0.3, 0.4); }
    if (spec.body === 'taco') { box(cw * 0.5, 0.48, 0.95, 0, ch / 2 + 0.48, -0.25, 0.4, 'cab'); box(cw * 0.5, 0.3, cl * 0.17, 0, ch / 2 + 0.2, -cl * 0.33, 0.4, 'hood'); box(cw * 0.5, 0.25, cl * 0.17, 0, ch / 2 + 0.25, cl * 0.3, 0.4, 'bed'); }
    if (spec.body === 'lc70') { box(cw * 0.5, 0.62, 1.55, 0, ch / 2 + 0.62, 0.55, 0.4, 'cab'); box(cw * 0.48, 0.3, 0.6, 0, ch / 2 + 0.3, -cl * 0.36, 0.4, 'hood'); }
    if (spec.body === 'wrx') {
      box(cw * 0.5, 0.3, cl * 0.48, 0, ch / 2 + 0.2, 0, 0.4); box(cw * 0.44, 0.28, 1.15, 0, ch / 2 + 0.62, 0.15, 0.4);
      // The sedan's underside hangs below the frame box (0.39 m up). In the model
      // (public/models/vehicles/wrx.glb) the floor pan is 0.25 m off the ground from bumper to
      // bumper, the sills 0.30 m between the arches and the front bumper 0.26-0.29 m, 0.4-0.7 m
      // ahead of the front tyres. Without these boxes the physics cleared 0.14 m more than the
      // car you see, so its belly and bumper never met a ledge and it walked 0.45 m ones.
      // (The 0.19 m splitter lip under the bumper is flexible trim: it scrapes, it doesn't
      // hold the car up, so it has no box.)
      // Chassis-local, so a lift or bigger tyres raise them with the body.
      const f = spec.chassis.floor; // floor pan underside (0.25 m up on the stock car)
      const under = (hx, yb, hz, oz) => box(hx, (-ch / 2 - yb) / 2, hz, 0, (-ch / 2 + yb) / 2, oz);
      under(0.5, f, 2.22, -0.08);         // floor pan, inside the wheels, bumper to bumper
      under(0.8, f + 0.05, 0.8, 0);       // sills, between the wheel arches
      under(0.78, f + 0.02, 0.25, -2.05); // front bumper
    }
    if (spec.body === 'truck') { box(cw * 0.5, 0.65, 0.9, 0, ch / 2 + 0.65, -cl * 0.35, 0.4); box(cw * 0.5, 0.55, cl * 0.3, 0, ch / 2 + 0.55, cl * 0.17, 0.4); }
    this.chassis = cb;
    this.chassisI = v(M / 12 * ((ch * 2.4) ** 2 + cl ** 2) * 0.8 * 1.15, M / 12 * (cw ** 2 + cl ** 2) * 0.8 * 1.15, M / 12 * ((ch * 2.4) ** 2 + cw ** 2) * 0.8 * 1.15);

    const sprung = M / 2;
    const s = spec.susp;
    const omega = 2 * Math.PI * s.freq;
    const k = sprung * omega * omega;
    const c = 2 * s.zeta * Math.sqrt(k * sprung);
    const sag = (sprung * G) / k;
    const sp2 = (s.springSpacing / 2) ** 2;
    this.suspK = k; this.sag = sag; this.suspKC = { k, c, sp2 };

    this.axles = [];
    this.knuckles = [];
    this.wheels = [];
    this.wheelColliders = [];
    this.wheelJoints = [];
    this.steerJoints = [];
    const t = spec.tire;
    const ident = { x: 0, y: 0, z: 0, w: 1 };
    const makeWheel = (kn, kp) => {
      const wm = t.mass;
      const Ispin = wm * t.radius * t.radius * 0.7;
      const Iside = wm * (3 * t.radius ** 2 + t.width ** 2) / 12;
      const wb = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(kp.x, kp.y, kp.z).setRotation(rot)
        .setAdditionalMassProperties(wm, v(0, 0, 0), v(Ispin, Iside, Iside), ident)
        .setCanSleep(false).setAngularDamping(0));
      const border = Math.min(0.09, t.width * 0.3);
      const col = world.createCollider(R.ColliderDesc.roundCylinder(t.width / 2 - border, t.radius - border, border)
        .setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
        .setDensity(0).setFriction(0).setFrictionCombineRule(R.CoefficientCombineRule.Min)
        .setRestitution(0).setCollisionGroups(GROUP_VEHICLE)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0), wb);
      const wj = world.createImpulseJoint(R.JointData.revolute(v(0, 0, 0), v(0, 0, 0), v(1, 0, 0)), kn, wb, true);
      this.wheels.push(wb); this.wheelColliders.push(col); this.wheelJoints.push(wj);
    };
    const makeKnuckle = (parent, anchor, kp) => {
      const kn = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(kp.x, kp.y, kp.z).setRotation(rot)
        .setAdditionalMassProperties(25, v(0, 0, 0), v(3, 3, 3), ident).setCanSleep(false));
      const kj = R.JointData.revolute(anchor, v(0, 0, 0), v(0, 1, 0));
      kj.limitsEnabled = true; kj.limits = [-spec.steer.max - 0.15, spec.steer.max + 0.15];
      const kjoint = world.createImpulseJoint(kj, parent, kn, true);
      kjoint.configureMotorModel(R.MotorModel.ForceBased);
      kjoint.configureMotorPosition(0, 60000 * (M / 2000), 3000 * (M / 2000));
      this.steerJoints.push(kjoint);
      this.knuckles.push(kn);
      return kn;
    };
    const ind = spec.independent || [false, false];
    for (let a = 0; a < 2; a++) {
      const z = a === 0 ? -spec.wheelbase / 2 : spec.wheelbase / 2;
      const local = v(0, spec.axleY, z);
      const p = place(local);
      const am = spec.axleMass;
      if (ind[a]) {
        // Independent: each wheel carrier slides on its own spring (a stand-in for a
        // double-wishbone's near-vertical wheel path); an anti-roll bar couples them.
        const carriers = [], pjoints = [];
        for (let sIdx = 0; sIdx < 2; sIdx++) {
          const x = (sIdx === 0 ? -1 : 1) * spec.track / 2;
          const anchor = add(local, v(x, 0, 0));
          const cp = place(anchor);
          const carrier = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(cp.x, cp.y, cp.z).setRotation(rot)
            .setAdditionalMassProperties(am * 0.35, v(0, 0, 0), v(am * 0.05, am * 0.05, am * 0.05), ident).setCanSleep(false));
          const pj = R.JointData.prismatic(anchor, v(0, 0, 0), v(0, 1, 0));
          pj.limitsEnabled = true; pj.limits = [-s.droop, s.bump];
          const pjoint = world.createImpulseJoint(pj, cb, carrier, true);
          pjoint.configureMotorModel(R.MotorModel.ForceBased);
          pjoint.configureMotorPosition(-sag, k / 2, c / 2);
          // lower control arm / CV boot that can drag on rocks
          world.createCollider(R.ColliderDesc.ball(t.radius * 0.16).setTranslation(-Math.sign(x) * 0.35, -0.08, 0)
            .setDensity(0).setFriction(0.5).setCollisionGroups(GROUP_VEHICLE), carrier);
          carriers.push(carrier); pjoints.push(pjoint);
          const kn = makeKnuckle(carrier, v(0, 0, 0), cp);
          makeWheel(kn, cp);
        }
        // the diff sits on the chassis with independent suspension
        world.createCollider(R.ColliderDesc.ball(t.radius * 0.3).setTranslation(0.1, spec.axleY + 0.06, z)
          .setDensity(0).setFriction(0.5).setCollisionGroups(GROUP_VEHICLE), cb);
        this.axles.push({ independent: true, carriers, pjoints, localZ: z, body: null });
        continue;
      }
      const slider = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(rot)
        .setAdditionalMassProperties(am * 0.15, v(0, 0, 0), v(am * 0.15, am * 0.15, am * 0.15), ident).setCanSleep(false));
      const pj = R.JointData.prismatic(local, v(0, 0, 0), v(0, 1, 0));
      pj.limitsEnabled = true; pj.limits = [-s.droop, s.bump];
      const pjoint = world.createImpulseJoint(pj, cb, slider, true);
      pjoint.configureMotorModel(R.MotorModel.ForceBased);
      pjoint.configureMotorPosition(-sag, k, c);
      const axle = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(rot)
        .setAdditionalMassProperties(am, v(0, 0, 0), v(am * 0.15, am * spec.track ** 2 / 12, am * spec.track ** 2 / 12), ident)
        .setCanSleep(false));
      const rj = R.JointData.revolute(v(0, 0, 0), v(0, 0, 0), v(0, 0, 1));
      rj.limitsEnabled = true; rj.limits = [-s.articulation, s.articulation];
      const rjoint = world.createImpulseJoint(rj, slider, axle, true);
      rjoint.configureMotorModel(R.MotorModel.ForceBased);
      rjoint.configureMotorPosition(0, k * sp2, c * sp2 * 1.4);
      // diff pumpkin + axle tube colliders (these hang up on rocks, as they should)
      const pumpR = t.radius * 0.32;
      world.createCollider(R.ColliderDesc.ball(pumpR).setTranslation(0.12, -0.02, 0).setDensity(0).setFriction(0.5)
        .setCollisionGroups(GROUP_VEHICLE).setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(M * G * 3), axle);
      world.createCollider(R.ColliderDesc.capsule(spec.track * 0.33, pumpR * 0.38).setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
        .setDensity(0).setFriction(0.5).setCollisionGroups(GROUP_VEHICLE), axle);
      this.axles.push({ body: axle, slider, pjoint, rjoint, localZ: z });
      for (let sIdx = 0; sIdx < 2; sIdx++) {
        const x = (sIdx === 0 ? -1 : 1) * spec.track / 2;
        const kl = v(x, 0, 0);
        const kp = place(add(local, kl));
        makeWheel(makeKnuckle(axle, kl, kp), kp);
      }
    }
    this.grace = 1.5; // no damage while a fresh spawn / recovery settles
    this.hold = null; // standing tyres' anchors (postPhysics): none after a rebuild
    this.tyreR = [t.radius, t.radius, t.radius, t.radius]; // [tyre pressure] loaded radius per wheel (colliders start round)
    this.deepSand?.sink.fill(0); // [deep sand] a rebuilt (repaired) truck is not dug in
    this.wheelHandles = this.wheelColliders.map((c) => c.handle);
    this.bodyHandles = [];
    this.partOf = new Map(); // damage collider handle -> { part: 'body' | 'axle0' | 'axle1', body }
    for (let k2 = 0; k2 < cb.numColliders(); k2++) {
      const col = cb.collider(k2);
      col.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS);
      col.setContactForceEventThreshold(M * G * 1.5);
      this.bodyHandles.push(col.handle);
      this.partOf.set(col.handle, { part: 'body', body: cb });
    }
    this.axles.forEach((ax, a) => {
      if (!ax.body) return;
      for (let k2 = 0; k2 < ax.body.numColliders(); k2++) {
        const h2 = ax.body.collider(k2).handle;
        this.bodyHandles.push(h2);
        this.partOf.set(h2, { part: 'axle' + a, body: ax.body });
      }
    });
    this.events = this.events || new R.EventQueue(true);
    this.allBodies = [cb, ...this.axles.flatMap((a) => (a.independent ? a.carriers : [a.slider, a.body])), ...this.knuckles, ...this.wheels];
    this.damageBodies = [cb, ...this.axles.map((a) => a.body).filter(Boolean)];
    this.wheelF = [0, 0, 0, 0]; // low-passed wheel contact force (N), for wheel damage
    this.wheelV = [0, 0, 0, 0]; // closing speed of each wheel's latest contacts (m/s), held ~60 ms
    this.wheelPre = [null, null, null, null]; // pre-step wheel velocities
    // the cab box is the tallest body box (it carries the roof)
    let cab = null;
    for (const b of boxes.slice(1)) if (!cab || b.oy + b.hy > cab.oy + cab.hy) cab = b;
    if (cab) cab.cab = true;
    this.crash.onBuild(boxes);
    // a wheel torn off earlier stays off after a recovery; bent springs keep their sag
    if (this.broken) this.broken.forEach((b, i) => { if (b) { world.removeImpulseJoint(this.wheelJoints[i], true); } });
    this.sagSig = null;
    this.applySag();
    this.syncDriveline();
  }

  // Badly bent springs / arms (health under 0.8): that corner sits lower (spring target raised),
  // a solid axle leans. Light damage changes nothing (the handling stays exactly as it was).
  applySag() {
    const { k, c, sp2 } = this.suspKC, h = this.health.susp;
    const bent = (i) => Math.max(0, 0.8 - h[i]) / 0.8;
    const sig = this.axles.map((ax, a) => bent(a * 2).toFixed(3) + bent(a * 2 + 1).toFixed(3)).join();
    if (sig === this.sagSig) return; // nothing changed: no joint calls
    this.sagSig = sig;
    this.axles.forEach((ax, a) => {
      const bl = bent(a * 2), br = bent(a * 2 + 1);
      if (ax.independent) {
        ax.pjoints.forEach((pj, s) => pj.configureMotorPosition(-this.sag + 0.12 * (s ? br : bl), k / 2, c / 2));
      } else {
        ax.pjoint.configureMotorPosition(-this.sag + 0.06 * (bl + br), k, c);
        ax.rjoint.configureMotorPosition(0.1 * (bl - br), k * sp2, c * sp2 * 1.4);
      }
    });
  }

  // which wheels the drivetrain can drive: torn off, or behind a snapped driveshaft / smashed diff
  syncDriveline() {
    const lost = this.crash.mech.driveLost;
    this.dt.broken = this.broken.map((b, i) => b || lost[i >> 1]);
  }

  setEngineHealth(v, cause) {
    const h = this.health, before = h.engine;
    h.engine = Math.max(0, Math.min(h.engine, v));
    if (before >= 0.5 && h.engine < 0.5) this.damageEvents.push(cause === 'oil' ? 'Engine starved of oil: losing power' : cause === 'heat' ? 'Engine cooking: losing power' : 'Engine damaged: losing power');
    if (h.engine <= 0.08 && !this.dt.dead) {
      this.dt.dead = true; this.dt.running = false;
      this.damageEvents.push(cause === 'oil' ? 'Engine seized: no oil' : cause === 'heat' ? 'Engine seized: overheated' : 'Engine destroyed');
    }
    this.dt.powerScale = this.crash.powerScale();
  }

  // Full repair in place (no new bodies for the view): health, wheels back on, body cage, parts.
  repair() {
    const p = this.chassis.translation(), { heading } = this.attitude();
    this.health = { tire: [1, 1, 1, 1], susp: [1, 1, 1, 1], engine: 1, body: 1 };
    this.broken = [false, false, false, false];
    this.dents.length = 0;
    this.crash.repair();
    this.dt.dead = false; this.dt.powerScale = 1;
    this.reset({ x: p.x, y: p.y + 0.6, z: p.z }, heading);
  }

  // One physics substep for the whole vehicle.
  step(input, h) {
    this.prePhysics(input, h);
    this.world.step(this.events);
    this.postPhysics(input, h);
  }

  destroy() {
    for (const b of this.allBodies) this.world.removeRigidBody(b);
    this.crash.removeDebris(); // torn-off parts lying around go with the truck
  }

  // Rebuild at a new pose, keeping drivetrain state.
  reset(pos, yaw) {
    this.destroy();
    this.build(pos, yaw);
  }

  // [tyre pressure] the old on / off switch, kept for tests and callers: true = crawl pressure
  // (exactly the old aired-down tyre), false = road pressure (exactly the old aired-up one).
  // Reads true while the tyres are at or heading below the trail stop.
  get airedDown() { return this.tyre.target < this.tyre.P.trail; }
  set airedDown(v) { this.tyre.set(v ? this.tyre.P.crawl : this.tyre.P.road); }

  // [tyre pressure] the wheel colliders follow the loaded radius (a softer, lower tyre aired down)
  applyTyreRadius() {
    const t = this.spec.tire, d = this.tyre.deflPhys;
    for (let i = 0; i < 4; i++) {
      const r = t.radius - d[i];
      if (Math.abs(r - this.tyreR[i]) < 0.001) continue;
      const border = Math.min(0.09, t.width * 0.3);
      this.wheelColliders[i].setRadius(r - border);
      this.tyreR[i] = d[i] > 0 ? r : t.radius;
    }
  }

  get mass() {
    const s = this.spec;
    return s.chassis.mass + 2 * s.axleMass * 1.15 + 4 * (s.tire.mass + 25);
  }

  speed() {
    const lv = this.chassis.linvel();
    const fwd = qrot(this.chassis.rotation(), v(0, 0, -1));
    return dot(lv, fwd);
  }

  // Called before each world.step.
  prePhysics(input, h) {
    const { spec, R, world } = this;
    // [tyre pressure] valves / compressor, loaded radius, speed costs for this step
    if (this.tyre.step(h, this)) this.tyreArrived = true;
    this.applyTyreRadius();
    // steering (rate limited, slower at speed)
    const kmh = Math.abs(this.speed()) * 3.6;
    const maxSteer = spec.steer.max * (1 - Math.min(0.55, kmh / 90));
    const target = input.steer * maxSteer;
    const rate = spec.steer.rate * h * this.tyre.steerMul; // [tyre pressure] soft tyres answer the wheel more slowly at speed
    this.steer += Math.max(-rate, Math.min(rate, target - this.steer));
    const d = this.steer;
    // Ackermann geometry
    const wb = spec.wheelbase, tw = spec.track;
    let inner = d, outer = d;
    if (Math.abs(d) > 1e-4) {
      const Rr = wb / Math.tan(Math.abs(d));
      inner = Math.sign(d) * Math.atan(wb / (Rr - tw / 2));
      outer = Math.sign(d) * Math.atan(wb / (Rr + tw / 2));
    }
    const left = d > 0 ? inner : outer, right = d > 0 ? outer : inner;
    const M = spec.chassis.mass;
    const ks = 60000 * (M / 2000), cs = 3000 * (M / 2000);
    const rs = this.rearSteerOn ? -1 : 0;
    const targets = [left, right, rs * right, rs * left];
    for (let i = 0; i < 4; i++) {
      // bent tie rod / arm: toe out, front wheels only (toe-out at the rear caused snap oversteer)
      const bend = i < 2 ? (1 - this.health.susp[i]) * 0.16 * (i % 2 ? -1 : 1) : 0;
      this.steerJoints[i].configureMotorPosition(targets[i] + (this.health.susp[i] < 0.75 ? bend : 0), ks, cs);
    }
    // anti-roll bars on independent axles
    const arb = spec.susp.arb || 0;
    if (arb) {
      const comp = this.compression();
      const cq0 = this.chassis.rotation(), up0 = qrot(cq0, v(0, 1, 0));
      this.axles.forEach((ax, a) => {
        if (!ax.independent) return;
        const F = arb * (comp[a * 2] - comp[a * 2 + 1]) * h;
        ax.carriers[0].applyImpulse(scale(up0, -F), true);
        ax.carriers[1].applyImpulse(scale(up0, F), true);
        this.chassis.applyImpulseAtPoint(scale(up0, F), ax.carriers[0].translation(), true);
        this.chassis.applyImpulseAtPoint(scale(up0, -F), ax.carriers[1].translation(), true);
      });
    }

    // terrain under each wheel: friction, sink, drag
    const t = spec.tire;
    const ray = new R.Ray(v(0, 0, 0), v(0, -1, 0));
    for (let i = 0; i < 4; i++) {
      const wbody = this.wheels[i];
      const p = wbody.translation();
      ray.origin = p;
      const hit = world.castRay(ray, t.radius + 0.35, true, undefined, 0xffff0001);
      const ws = this.wheelState[i];
      let mat = MAT.DIRT, grounded = false;
      if (hit) {
        const hp = ray.pointAt(hit.timeOfImpact);
        grounded = hit.timeOfImpact < t.radius + 0.06;
        mat = this.matOf(hit.collider, hp);
        ws.hitDist = hit.timeOfImpact;
      }
      ws.grounded = grounded || !!ws.contact; ws.mat = mat;
      const info = MAT_INFO[mat];
      // [deep sand] sinkage and motion resistance on dune sand; scales the viscous drag below
      const deep = this.deepSand ? this.deepSand.wheel(i, mat, p, wbody.linvel(), ws, grounded, qrot(this.chassis.rotation(), v(0, 0, -1)), h) : 1;
      // viscous drag through mud / sand ([mud] bog mud is handled by mudPre below)
      if (grounded && info.drag > 0 && !(this.terrain.mud && mat === MAT.MUD)) {
        const lv = wbody.linvel();
        const k = info.drag * deep * (t.width / 0.35) * h;
        this.chassis.applyImpulseAtPoint(v(-lv.x * k, -lv.y * k * 0.3, -lv.z * k), p, true);
      }
    }

    if (this.terrain.mud) { this.mudPre(h); this.mudBelly(h); } // [mud]

    // aero drag
    const lv = this.chassis.linvel();
    const sp = Math.hypot(lv.x, lv.y, lv.z);
    const [cw, ch] = spec.chassis.size;
    const dragK = 0.5 * 1.2 * 0.9 * cw * (ch + 1.2) * sp * h;
    this.chassis.applyImpulse(v(-lv.x * dragK, -lv.y * dragK, -lv.z * dragK), true);
    // a bent driveshaft shakes the truck a little at speed (kept subtle on purpose)
    const ds = this.crash.mech.driveshaft;
    for (let a = 0; a < 2; a++) {
      if (ds[a] >= 0.6 || this.crash.mech.driveLost[a]) continue;
      const sw = (this.dt.w && this.dt.w[a === 0 ? 2 : 1]) || 0; // driveshaft speed (rad/s)
      this.shaftAngle = (this.shaftAngle || 0) + sw * h;
      const amp = (0.6 - ds[a]) * Math.min(1, Math.abs(sw) / 60) * this.spec.chassis.mass * 0.004 * h * 60;
      this.chassis.applyTorqueImpulse(qrot(this.chassis.rotation(), v(Math.sin(this.shaftAngle) * amp, 0, 0)), true);
    }
    if (this.grace <= 0) {
      this.crash.snapshot(this.damageBodies); // pre-step velocities for impact energy
      for (let i = 0; i < 4; i++) this.wheelPre[i] = this.wheels[i].linvel();
    }
  }

  wheelAxis(i) { return qrot(this.knuckles[i].rotation(), v(1, 0, 0)); }
  // forward-positive spin of wheel i relative to its knuckle (rad/s)
  wheelSpin(i) {
    return -dot(sub(this.wheels[i].angvel(), this.knuckles[i].angvel()), this.wheelAxis(i));
  }

  matOf(collider, p) {
    if (this.terrain.rockHandles.has(collider.handle)) return MAT.ROCK;
    const prop = this.terrain.propInfo && this.terrain.propInfo.get(collider.handle); // loose rocks / logs (physics_props.js)
    if (prop) return prop.mat;
    if (collider.handle === this.terrain.ground.handle) return materialAt(p.x, p.z);
    return MAT.DIRT;
  }

  tyreGrip(mat, slipping) {
    const info = MAT_INFO[mat];
    const tm = this.treadMul[mat];
    let mu = info.mu * tm[0], rr = info.rr * tm[1];
    // [tyre pressure] one continuous function of pressure: f = 0 at road pressure (no change), 1 at
    // crawl pressure (exactly the old aired-down numbers), more below. A longer, wider patch that
    // wraps rock edges grips rock better and floats on sand; it costs rolling drag on hard ground.
    const f = this.tyre.f;
    if (f !== 0) {
      if (mat === MAT.ROCK) mu *= mix(1, 1.15, f);
      else if (mat === MAT.SAND) { mu *= mix(1, 1.12, f); rr *= Math.max(0.2, mix(1, 0.55, f)); }
      else if (mat === MAT.MUD) mu *= mix(1, 1.06, f);
      else rr *= mix(1, 1.25, f);
    }
    if (this.tyre.rrSpeed) rr += this.tyre.rrSpeed; // [tyre pressure] a flexing carcass heats up at speed
    // a spinning tyre grips less than a rolling one (static vs sliding friction)
    if (slipping) mu *= mat === MAT.ROCK ? 0.8 : 0.88;
    return { mu, rr };
  }

  // Called after each world.step. The physics engine has resolved the tyre contacts'
  // normal forces (tyre friction is zero there); here tyre grip, drivetrain and brakes
  // are solved together and the resulting impulses applied.
  postPhysics(input, h) {
    const { world, spec } = this;
    const t = spec.tire;
    const cq = this.chassis.rotation();
    const inv = qconj(cq);
    const up = qrot(cq, v(0, 1, 0));
    const com = add(this.chassis.translation(), qrot(cq, v(0, spec.chassis.comY, 0)));
    const unsprung = spec.axleMass * 0.5 + t.mass + 25;

    // 1. tyre contact patches, from the contact-force events of the step just taken
    // (normal force per wheel/obstacle pair; tyre friction is zero inside the engine)
    const patches = [];
    const byWheel = [[], [], [], []];
    const hits = [];
    this.events.drainContactForceEvents((ev) => {
      const h1 = ev.collider1(), h2 = ev.collider2();
      let i = this.wheelHandles.indexOf(h1), other = h2, sign = -1;
      if (i < 0) { i = this.wheelHandles.indexOf(h2); other = h1; sign = 1; }
      if (i < 0) {
        const mine = this.partOf.has(h1) ? h1 : this.partOf.has(h2) ? h2 : null;
        if (mine !== null && this.grace <= 0) hits.push({ mine, other: mine === h1 ? h2 : h1, F: scale(ev.totalForce(), mine === h1 ? -1 : 1) });
        return;
      }
      if (this.broken[i]) return;
      const F = ev.totalForce();
      byWheel[i].push({ F: scale(F, sign), other: world.getCollider(other) });
    });
    const axes = [], spins = [], loads = [0, 0, 0, 0], rrs = [0, 0, 0, 0], slips = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const ax = this.wheelAxis(i);
      axes.push(ax);
      spins.push(this.wheelSpin(i));
      this.wheelState[i].contact = false;
      const c = this.wheels[i].translation();
      const lv = this.wheels[i].linvel(), kv = this.knuckles[i].angvel();
      for (const ev of byWheel[i]) {
        const len0 = len(ev.F);
        if (len0 < 1) continue;
        const n = scale(ev.F, 1 / len0); // contact normal, pointing from the ground into the tyre
        // contact point on the tyre surface where its normal is -n
        const radial = sub(n, scale(ax, dot(ax, n)));
        const rl = len(radial);
        const p = rl > 0.35
          ? sub(c, scale(radial, (this.tyreR[i] * 0.97) / rl)) // [tyre pressure] loaded radius
          : sub(c, scale(ax, Math.sign(dot(ax, n)) * t.width * 0.5));
        const r = sub(p, c);
        const d0 = scale(cross(ax, r), -1);
        const d1 = sub(d0, scale(n, dot(n, d0)));
        let k = len(d1), d;
        if (k > 0.3 * t.radius) d = scale(d1, 1 / k);
        else { // sidewall contact: not driven, plain friction
          const fw = qrot(cq, v(0, 0, -1));
          const f1 = sub(fw, scale(n, dot(n, fw)));
          d = scale(f1, 1 / Math.max(1e-6, len(f1))); k = 0;
        }
        const e = cross(n, d);
        const vp = add(lv, cross(kv, r));
        // a loose prop under the tyre (physics_props.js): see step 2
        const ob = ev.other.parent();
        const dyn = ob && ob.isDynamic() && this.terrain.propInfo && this.terrain.propInfo.get(ev.other.handle);
        patches.push({ wheel: i, p, n, d, e, k, vp, N: len0, mat: this.matOf(ev.other, p), ob: dyn ? ob : null, prop: dyn || null, oh: ev.other.handle }); // oh: what it stands on (static-hold anchor key)
        this.wheelState[i].contact = true;
      }
    }

    if (this.terrain.mud) this.mudPatches(patches, axes); // [mud] tyres held up by soft mud grip on it too

    // body / axle contacts -> impact energy, deformation, mechanical damage (src/damage/crash.js)
    for (const hit of hits) {
      const po = this.partOf.get(hit.mine);
      this.crash.contact(po.part, po.body, world.getCollider(hit.mine), world.getCollider(hit.other), hit.F, h);
    }
    if (this.grace <= 0) this.crash.endStep(h);

    // Hard hits on a wheel bend the suspension and can cut the tyre. Measured on the contact
    // force low-passed over ~25 ms (the impulse of a short window): a one-substep bump-stop
    // spike on whoops is not an 80 g hit, a 5 m landing still is. Side loads (along the axle:
    // sliding sideways into a rock, a tree) bend arms and wheels far more easily than radial ones.
    const Wst = (this.mass * G) / 4;
    this.grace -= h;
    // Gate: big contact forces at low closing speed are not impacts. A tyre wedged between
    // two rocks with the drivetrain pushing, a wheel resting on its bump stop or travel limit
    // under the truck's weight, a held loose stone: all can show 20-80 g of contact force with
    // the wheel barely moving into the obstacle. Damage needs the wheel to have been closing on
    // the contact at real speed: none below WHEEL_V0 (3 m/s, 11 km/h: a 0.45 m free fall; a
    // ledge drop at crawl pace stays well under it), full weight from WHEEL_V1 (5 m/s).
    for (let i = 0; i < 4 && this.grace <= 0; i++) {
      if (this.broken[i]) continue;
      let F = 0, Fl = 0, rock = false, vc = 0;
      const ax = this.wheelAxis(i), pre = this.wheelPre[i], post = this.wheels[i].linvel();
      // the sprung mass above this corner: the light wheel stops at first touch, the hard hit
      // comes when the body lands on it through the bump stop, at the body's speed
      const cs = this.crash.pre && this.crash.pre.get(this.chassis.handle), wp = this.wheels[i].translation();
      const chv = cs ? add(cs.lv, cross(cs.av, sub(wp, cs.c))) : null;
      for (const ev of byWheel[i]) {
        const f = len(ev.F); F += f; Fl += Math.abs(dot(ev.F, ax));
        if (this.terrain.rockHandles.has(ev.other.handle)) rock = true;
        if (f > 1 && pre) { // closing speed along the contact push, relative to the obstacle
          const n = scale(ev.F, 1 / f), ob = ev.other.parent();
          let cv = Math.max(-(dot(pre, n) + dot(post, n)) / 2, chv ? -dot(chv, n) : 0);
          if (ob && ob.isDynamic()) cv += dot(ob.linvel(), n);
          vc = Math.max(vc, cv);
        }
      }
      const wf = this.wheelF, k = Math.min(1, h / 0.025);
      wf[i] += (F + Fl * 1.5 - wf[i]) * k;
      const wv = this.wheelV;
      wv[i] = Math.max(vc, wv[i] * Math.exp(-h / 0.06));
      const gate = Math.min(1, Math.max(0, (wv[i] - WHEEL_V0) / (WHEEL_V1 - WHEEL_V0)));
      const gi = (wf[i] / Wst) * gate;
      if (gi > WHEEL_G) {
        const violent = gi > WHEEL_G + 14 && wv[i] > 6.5; // only a genuinely violent hit takes a wheel off
        this.damageWheel(i, (gi - WHEEL_G) * 0.0045, rock && gi > WHEEL_G + 6 && wv[i] > 5 ? (gi - WHEEL_G - 6) * 0.006 : 0, violent);
      }
      if (gi > WHEEL_G + 8) this.crash.archPunch(i, (gi - WHEEL_G - 8) * 0.0012);
      if (gi > (this.peakG ? this.peakG[i] : 0)) (this.peakG ||= [0, 0, 0, 0])[i] = gi;
      if (this.wheelLog) this.wheelLog(i, { F: F / Wst, filt: wf[i] / Wst, vc, wv: wv[i], gate, gi });
    }
    // 2. grip rows. Extra DOFs: chassis linear velocity (world, 3), chassis angular
    // velocity (body frame, 3), and each wheel's unsprung velocity along the suspension
    // axis (4). Horizontal tyre force pushes the whole truck (and pitches/rolls it);
    // the part along the suspension axis only moves the axle against its spring.
    const Ib = this.chassisI;
    const extra = { I: [this.mass, this.mass, this.mass, Ib.x, Ib.y, Ib.z, unsprung, unsprung, unsprung, unsprung], rows: [] };
    const rowFor = (pt, dir, v0, cap) => {
      const dh = sub(dir, scale(up, dot(dir, up)));
      const tq = qrot(inv, cross(sub(pt.p, com), dh));
      const pairs = [7, dh.x, 8, dh.y, 9, dh.z, 10, tq.x, 11, tq.y, 12, tq.z, 13 + pt.wheel, dot(dir, up)];
      if (dir === pt.d && pt.k) pairs.push(3 + pt.wheel, pt.k);
      if (pt.pr) { // the prop's surface velocity at the patch moves the other way
        const b = pt.pr.base, tp = qrot(pt.pr.inv, cross(sub(pt.p, pt.pr.com), dir));
        pairs.push(b, -dir.x, b + 1, -dir.y, b + 2, -dir.z, b + 3, -tp.x, b + 4, -tp.y, b + 5, -tp.z);
      }
      const row = { pairs, v0, lo: -cap, hi: cap };
      extra.rows.push(row);
      return row;
    };
    for (let k = patches.length - 1; k >= 0; k--) if (this.broken[patches[k].wheel]) patches.splice(k, 1);
    // Loose props under a tyre (physics_props.js). Two modes per prop:
    //  - loose (rolling, sliding, kicked, airborne): it joins the solve as a body of 6 DOFs
    //    (linear in world axes, angular in its principal frame), so a grip row's effective
    //    mass includes the prop's mass and inertia at the contact point: a pebble can't react
    //    like the planet, and the solve can't over-correct against it. Slip is measured
    //    relative to its surface, and it gets the equal and opposite impulse at the patch, so
    //    tyres spit stones back and logs roll under a climbing tyre. Ground-hold rows predict
    //    what the ground will do to it next step (not applied: the engine's contacts do that):
    //    friction at its resting point (mu x load), its footprint against tipping (load x
    //    arm; a log has almost none about its long axis, so it rolls) and twisting.
    //  - held: once it has rested with the tyres on it standing still (not rolling, not
    //    spinning) for 0.1 s, i.e. a parked or held truck pins it, it is treated as static
    //    ground and the reaction goes straight into the ground, until the tyres on it roll or
    //    spin again for 0.1 s, or their total force on it (normal + grip) beats mu_ground x
    //    its pressed-down load for 50 ms. (The single-point ground model can't match the
    //    engine's multi-point contact under a parked tyre; solved as a body there, a pinned
    //    stone rattles.)
    const props = [];
    for (const pt of patches) {
      if (!pt.ob) continue;
      let pr = props.find((q) => q.body === pt.ob);
      if (!pr) props.push(pr = { body: pt.ob, info: pt.prop, load: pt.ob.mass() * G, anchors: [] });
      pr.load += Math.max(0, pt.n.y) * pt.N; // the tyre pressing the prop into the ground
      pt.pr0 = pr;
      // the tyre standing still on it (neither rolling nor spinning): it must be pinned
      if (len(pt.vp) > 0.15 || Math.abs(dot(pt.vp, pt.d) + pt.k * spins[pt.wheel]) > 0.15) pr.moving = true;
    }
    for (const pr of props) {
      const c = pr.body.collider(0);
      world.contactPairsWith(c, (o) => {
        if (pr.rest || o.collisionGroups() === GROUP_VEHICLE) return;
        world.contactPair(c, o, (mf) => { if (mf.numContacts() > 0) pr.rest = true; });
      });
      if (!pr.rest) pr.info.held = false;
      pr.held = !!pr.info.held;
      if (pr.held) continue;
      const b = pr.body, m = b.mass(), ip = b.principalInertia();
      pr.base = 7 + extra.I.length; pr.com = b.worldCom();
      pr.inv = qconj(qmul(b.rotation(), b.principalInertiaLocalFrame()));
      extra.I.push(m, m, m, Math.max(1e-3, ip.x), Math.max(1e-3, ip.y), Math.max(1e-3, ip.z));
      if (!pr.rest) continue;
      const q = pr.info.lowest(), rq = sub(q, pr.com), wv = b.angvel(), vq = b.velocityAtPoint(q), k = pr.base;
      for (const ax of [v(1, 0, 0), v(0, 0, 1)]) {
        const tl = qrot(pr.inv, cross(rq, ax)), capF = 0.8 * pr.load * h;
        const row = { pairs: [k, ax.x, k + 1, ax.y, k + 2, ax.z, k + 3, tl.x, k + 4, tl.y, k + 5, tl.z], v0: dot(vq, ax), lo: -capF, hi: capF };
        extra.rows.push(row); pr.anchors.push(row);
        const ta = qrot(pr.inv, ax), capT = pr.load * pr.info.arm(ax) * h;
        const rowT = { pairs: [k + 3, ta.x, k + 4, ta.y, k + 5, ta.z], v0: dot(wv, ax), lo: -capT, hi: capT };
        extra.rows.push(rowT); pr.anchors.push(rowT);
      }
      const ty = qrot(pr.inv, v(0, 1, 0)), capY = 0.8 * pr.load * pr.info.arm(v(0, 1, 0)) * h;
      extra.rows.push({ pairs: [k + 3, ty.x, k + 4, ty.y, k + 5, ty.z], v0: wv.y, lo: -capY, hi: capY });
    }
    for (const pt of patches) if (pt.pr0 && !pt.pr0.held) { pt.pr = pt.pr0; pt.vp = sub(pt.vp, pt.ob.velocityAtPoint(pt.p)); }
    // Standing tyres hold their spot (static friction). Without this a braked truck slid
    // 1-2 cm/s down a few degrees of slope with its wheels locked, for two reasons:
    //  - the engine's step applies gravity and moves the truck before these grip rows run (tyre
    //    friction is zero in the engine), so rows that only cancel the slip they find always
    //    leave g·sin(slope)·h per step of creep;
    //  - four stiff patches over-constrain the rigid chassis: the solve has internal "squeeze"
    //    modes (left against right, front against rear) that cost nothing, so millimetre
    //    mismatches in the slip measured on the separately jointed wheel bodies drove them to
    //    the full mu x N budget, flipping every step (a chatter that walked the truck).
    // So a patch standing on fixed ground measures its slip on the chassis (one rigid motion,
    // no mismatches), its rows get a tread-like compliance (the squeeze modes stay near zero),
    // it also cancels the velocity gravity is about to add, and it takes back a share of how far
    // that point of the truck has slid since it stopped. All out of the same mu x N budget: a
    // slope too steep or slippery still slides (the patch then moves too fast to count as
    // standing and forgets its anchor). Rolling and spinning tyres are unchanged.
    const gw = world.gravity, hold = new Map(), held0 = this.hold || new Map();
    for (const pt of patches) {
      const s = spins[pt.wheel];
      const slipL = dot(pt.vp, pt.d) + pt.k * s;
      const slipLat = dot(pt.vp, pt.e);
      let { mu, rr } = this.tyreGrip(pt.mat, Math.hypot(slipL, slipLat) > 1.0);
      const ds = this.deepSand && this.deepSand.grip(pt.wheel, pt.mat); // [deep sand] null off dune sand
      if (ds) mu *= ds.mu;
      if (this.health.tire[pt.wheel] < 0.35) { mu *= 0.6; rr *= 3; } // flat tyre
      pt.mu = mu;
      pt.cap = mu * pt.N * h;
      let vL = slipL, vA = slipLat;
      // (standing: ignoring the downslope gravity kick the engine's step just added, 1-2 cm/s on a slope)
      const gt = sub(gw, scale(pt.n, dot(gw, pt.n)));
      if (!pt.pr0 && len(sub(pt.vp, scale(gt, h))) < STICK_V && Math.abs(pt.k * s) < STICK_V) {
        const vc = this.chassis.velocityAtPoint(pt.p);
        // anchor key: wheel + what it stands on (`oh`, the other collider's handle). A patch type
        // without one is keyed by its place in this step's list, so two never share an anchor
        const key = pt.wheel + ':' + (pt.oh ?? 'n' + patches.indexOf(pt)), cp = this.chassis.translation();
        const ang = this.wheelState[pt.wheel].angle;
        const a = held0.get(key) || { w: pt.p, lp: qrot(inv, sub(pt.p, cp)), ang }; // anchor: where it stopped
        hold.set(key, a);
        const off = sub(add(cp, qrot(cq, a.lp)), a.w); // how far that bit of the truck has moved since
        // slide = that movement, less what the tyre rolled (a free wheel may roll, not slide)
        const eL = Math.max(-HOLD_MAX, Math.min(HOLD_MAX, dot(off, pt.d) + pt.k * (ang - a.ang)));
        const eA = Math.max(-HOLD_MAX, Math.min(HOLD_MAX, dot(off, pt.e)));
        vL = dot(vc, pt.d) + pt.k * s + dot(gw, pt.d) * h + (HOLD_BETA * eL) / h;
        vA = dot(vc, pt.e) + dot(gw, pt.e) * h + (HOLD_BETA * eA) / h;
        pt.held = true;
      }
      pt.rowL = rowFor(pt, pt.d, vL, pt.cap);
      slips[pt.wheel] = Math.max(slips[pt.wheel], Math.hypot(slipL, slipLat));
      pt.rowA = rowFor(pt, pt.e, vA, ds ? pt.cap * ds.lat : pt.cap); // [deep sand] weaker sideways on dune sand (a held tyre too: past this it slides and the hold lets go)
      if (pt.held || ds) pt.rowL.cfm = pt.rowA.cfm = HOLD_CFM; // [deep sand] soft sand is compliant too: no stiff squeeze modes eating the grip while a tyre slides
      loads[pt.wheel] += pt.N;
      rrs[pt.wheel] = Math.max(rrs[pt.wheel], rr);
    }

    // [tyre pressure] soft tyres at speed give sideways (lower cornering stiffness): compliance on the
    // sideways rows of rolling tyres (0 below the speed gate; standing tyres keep their own)
    if (this.tyre.latCfm) for (const pt of patches) if (!pt.rowA.cfm) pt.rowA.cfm = this.tyre.latCfm;

    // 3. brakes + rolling resistance (N·m capacity per wheel)
    const drag = this.crash.mech.wheelDrag; // a fender crushed onto the tyre rubs it
    // Parking brake / handbrake: a drum on the driveline ahead of the transfer case, acting on
    // the rear wheels (and, through a locked transfer case or centre coupling, the front). Its
    // torque reaches the wheels through the range and axle ratios, as the engine's does, so
    // low range multiplies both. Sized to hold the engine's full torque in first gear with a
    // 10% margin, and never weaker than the old 1.5 x brakeT per rear wheel in high range
    // (which it still is for the Pickup; the Cruiser's and Sedan's grew to match their engines).
    // It used to be 1.5 x brakeT in every range, so first in 4-Low drove through it as if it
    // was off.
    const parkT = Math.max(1.1 * spec.engine.peakT * spec.gears[0], (3 * spec.brakeT) / spec.final); // N·m at the drum
    const park = input.handbrake ? (parkT * (spec.ranges[this.dt.range] ?? 1) * spec.final) / 2 : 0;
    const brakes = [0, 1, 2, 3].map((i) => {
      let b = input.brake * spec.brakeT + rrs[i] * loads[i] * t.radius + drag[i];
      if (i >= 2) b += park;
      return b;
    });

    // 4. one exact solve: engine + clutch + gears + diffs + brakes + tyre grip
    this.winch?.addRow(extra, com, inv, h); // [winch] the winch line joins the solve as one more row (src/winch/winch.js); stowed: nothing
    this.dt.brakePedal = input.brake;
    const driveImp = this.dt.step(h, input.throttle, spins, brakes, extra);
    this.winch?.applyRow(h); // [winch]

    // 5. apply tyre forces (friction circle), wheel spin, and axle reactions
    for (const pt of patches) {
      let L = pt.rowL.imp, A = pt.rowA.imp;
      const mag = Math.hypot(L, A);
      if (mag > pt.cap && mag > 0) { L *= pt.cap / mag; A *= pt.cap / mag; }
      const P = add(scale(pt.d, L), scale(pt.e, A));
      const Pu = scale(up, dot(P, up));
      this.wheels[pt.wheel].applyImpulse(Pu, true);
      this.chassis.applyImpulseAtPoint(sub(P, Pu), pt.p, true);
      if (pt.pr) pt.ob.applyImpulseAtPoint(scale(P, -1), pt.p, true); // equal and opposite on a loose prop
      else if (pt.pr0) { // held: sum what the tyre puts on it (force), for the hold check below
        const R = pt.pr0.R ||= v(0, 0, 0), F = add(scale(pt.n, pt.N), scale(P, 1 / h));
        R.x -= F.x; R.y -= F.y; R.z -= F.z;
      }
      pt.imp = L; pt.lat = A;
    }
    for (const pr of props) {
      const inf = pr.info;
      if (pr.held) { // can the ground still hold it?
        const R = pr.R || v(0, 0, 0);
        inf.over = Math.hypot(R.x, R.z) > 0.8 * 1.15 * (pr.body.mass() * G + Math.max(0, -R.y)) ? (inf.over || 0) + 1 : 0;
        inf.movT = pr.moving ? (inf.movT || 0) + h : 0;
        if (inf.over >= 10) { // overloaded for 50 ms: breaks loose, and takes this step's push
          inf.held = false; inf.holdT = 0;
          for (const pt of patches) if (pt.pr0 === pr) pt.ob.applyImpulseAtPoint(scale(add(scale(pt.d, pt.imp), scale(pt.e, pt.lat)), -1), pt.p, true);
        } else if (inf.movT >= 0.1) { inf.held = false; inf.holdT = 0; } // driven on again
      } else { // resting under a standing tyre for 0.1 s: held
        inf.holdT = pr.rest && !pr.moving ? (inf.holdT || 0) + h : 0;
        if (inf.holdT >= 0.1) { // pinned: drop the jiggle left over from being solved as loose
          inf.held = true; inf.over = 0;
          pr.body.setLinvel(v(0, 0, 0), true); pr.body.setAngvel(v(0, 0, 0), true);
        }
      }
    }
    for (let i = 0; i < 4; i++) {
      if (this.broken[i]) { this.wheelState[i].grounded = false; continue; }
      const dS = spins[i] - this.wheelSpin(i);
      const wv = this.wheels[i].angvel();
      this.wheels[i].setAngvel(add(wv, scale(axes[i], -dS)), true);
      // Driveline / brake torque on the wheel reacts on the axle housing, which is held
      // in pitch by the links, so it ends up in the chassis (axle wrap / brake dive).
      // Applied there directly: the light axle bodies can't pass big torque impulses
      // through their joints within one step.
      // Link geometry (anti-squat / anti-dive) cancels most of it; ~40% reaches the body.
      this.chassis.applyTorqueImpulse(scale(axes[i], driveImp[i] * 0.4), true);
      const ws = this.wheelState[i];
      ws.spin = spins[i];
      ws.load = loads[i];
      ws.slip = slips[i];
      ws.angle += spins[i] * h;
    }
    this.patches = patches;
    this.hold = hold;
    // [tyre pressure] a bead unseated by a hard corner / side hit on very soft tyres: a flat (repair fixes it)
    for (const i of this.tyre.post(this, patches, h)) {
      this.health.tire[i] = Math.min(this.health.tire[i], 0.3);
      this.damageEvents.push(`Bead popped: ${TyrePressure.NAMES[i]} tyre is flat. Backspace repairs`);
    }
    if (this.terrain.mud) this.mudWork(h, patches); // [mud] ruts, digging, churn
    // engine torque reaction rolls the chassis
    const fwd = qrot(cq, v(0, 0, -1));
    this.chassis.applyTorqueImpulse(scale(fwd, -this.dt.engineTorque * h * 0.8), true);
  }

  // ---------------------------------------------------------------- [mud] soft mud
  // Bog mud (src/mud.js) between the shown mud surface and the firm floor the physics engine
  // collides with. Each tyre in it is held up by the mud's bearing force at its sinkage (applied
  // to the wheel, like a ground contact), pays compaction resistance and viscous drag for it
  // (on the chassis at the tyre's lowest point, against the tyre's motion), grips through a
  // contact patch carrying that force (mudPatches), and works the mud: ruts, churn, digging when
  // it spins (mudWork). The belly and solid-axle diffs drag through it once the truck sinks
  // that far (mudBelly). Everything outside the bogs is untouched.
  mudPre(h) {
    const { spec } = this, t = spec.tire, mud = this.terrain.mud;
    const Wst = (this.mass * G) / 4;
    this.mudState ||= [0, 1, 2, 3].map(() => ({ N: 0, z: 0 }));
    for (let i = 0; i < 4; i++) {
      const st = this.mudState[i], ws = this.wheelState[i];
      st.N = 0; ws.sink = 0;
      if (this.broken[i]) continue;
      const w = this.wheels[i], c = w.translation(), ax = this.wheelAxis(i);
      // the tyre's lowest point: straight down, square to the axle
      let dx = ax.x * ax.y, dy = ax.y * ax.y - 1, dz = ax.z * ax.y;
      const dl = Math.hypot(dx, dy, dz);
      if (dl < 0.35) continue; // on its side
      dx /= dl; dy /= dl; dz /= dl;
      const r = this.tyreR[i]; // [tyre pressure] loaded radius; the footprint follows the live pressure (f)
      const bx = c.x + dx * r, by = c.y + dy * r, bz = c.z + dz * r;
      mud.tyre(bx, bz, by, t.radius, t.width, this.tyre.f, st);
      if (st.F <= 0) continue;
      const lv = w.linvel();
      const N = Math.max(0, Math.min(6 * Wst, st.F - mudDamping(st.A, t.mass, h) * lv.y));
      w.applyImpulse(v(0, N * h, 0), true);
      st.N = N; st.x = bx; st.zz = bz; st.y = by;
      ws.sink = st.z; ws.grounded = true; ws.mat = MAT.MUD;
      // compaction resistance + viscous drag against the tyre's motion over the ground
      const sp = Math.hypot(lv.x, lv.z);
      if (sp > 1e-4) {
        // the tyre model already charges the surface's rolling resistance (MAT_INFO mud rr) on
        // this load: compaction only adds what it costs beyond that (total: max(rr N, plough + floor N))
        const rr0 = MAT_INFO[MAT.MUD].rr * this.treadMul[MAT.MUD][1];
        const plough = Math.max(0, st.plough - (rr0 - MUD.RR_FLOOR) * N);
        const R = plough * (sp / (sp + 0.15)) + st.visc * sp;
        this.chassis.applyImpulseAtPoint(v((-lv.x / sp) * R * h, 0, (-lv.z / sp) * R * h), v(bx, by, bz), true);
      }
    }
  }

  // Belly and diffs in the mud: points on the frame's underside (and under each solid axle's
  // diff) that sink below the mud's bearing surface are held up by it (taking weight off the
  // tyres: high-centred) and drag through it.
  mudBelly(h) {
    const { spec } = this, mud = this.terrain.mud;
    const [cw, ch, cl] = spec.chassis.size;
    const q = this.chassis.rotation(), c0 = this.chassis.translation();
    const s = this._mudS ||= {};
    const pts = this._mudPts ||= [];
    pts.length = 0;
    const aBelly = (cw * 0.6 * cl * 0.8) / 6;
    // the underside: the frame box's bottom, or the floor pan where the spec gives a lower one
    // (spec.chassis.floor, chassis-local: a low car's floor sits well under its frame box)
    const yb = Math.min(-ch / 2, spec.chassis.floor ?? -ch / 2);
    for (const sx of [-0.3, 0.3]) for (const sz of [-0.35, 0, 0.35]) pts.push([this.chassis, add(c0, qrot(q, v(sx * cw, yb, sz * cl))), aBelly]);
    // the nose: a low front bumper ploughs into the mud ahead of the front wheels
    pts.push([this.chassis, add(c0, qrot(q, v(0, yb + 0.06, -cl * 0.48))), cw * 0.6 * 0.25]);
    for (const ax of this.axles) if (!ax.independent && ax.body) { const p = ax.body.translation(); pts.push([ax.body, v(p.x, p.y - spec.tire.radius * 0.53, p.z), 0.12]); }
    for (const [body, p, area] of pts) {
      mud.sample(p.x, p.z, s);
      if (s.m < 0.01) continue;
      const pz = this.terrain.mud.grid.visualHeightAt(p.x, p.z) - s.e + s.berm - p.y;
      if (pz <= 0) continue;
      const vp = body.velocityAtPoint(p);
      const Fv = Math.max(0, (MUD.BELLY_K * s.m * Math.min(pz, 0.5) * area) / (1 + s.w) - MUD.DAMP * area * vp.y);
      const sp = Math.hypot(vp.x, vp.z);
      const Fh = (MUD.BELLY_MU * Fv + MUD.VISC * 4 * area * sp) * (sp / (sp + 0.15));
      const k = sp > 1e-4 ? (Fh * h) / sp : 0;
      body.applyImpulseAtPoint(v(-vp.x * k, Fv * h, -vp.z * k), p, true);
    }
  }

  // contact patches for tyres the mud holds up: same geometry as an engine contact, with the
  // mud's bearing force as the normal load (grip and rolling resistance follow from it)
  mudPatches(patches, axes) {
    const t = this.spec.tire, n = v(0, 1, 0);
    for (let i = 0; i < 4; i++) {
      const st = this.mudState && this.mudState[i];
      if (!st || st.N <= 0 || this.broken[i]) continue;
      const ax = axes[i], c = this.wheels[i].translation();
      const radial = sub(n, scale(ax, dot(ax, n))), rl = len(radial);
      if (rl < 0.35) continue;
      const p = sub(c, scale(radial, (t.radius * 0.97) / rl)), r = sub(p, c);
      const d0 = scale(cross(ax, r), -1), d1 = sub(d0, scale(n, dot(n, d0))), k = len(d1);
      if (k < 1e-6) continue;
      const d = scale(d1, 1 / k);
      // patch velocity in the contact plane only: the wheel bobbing on the soft mud is not slip
      // (and must not stop a standing tyre counting as standing for the static hold)
      const vp0 = add(this.wheels[i].linvel(), cross(this.knuckles[i].angvel(), r)), vp = sub(vp0, scale(n, dot(vp0, n)));
      patches.push({ wheel: i, p, n, d, e: cross(n, d), k, vp, N: st.N, mat: MAT.MUD, ob: null, prop: null, mud: true, oh: 'mud' }); // oh: a stable id for per-patch state
      this.wheelState[i].contact = true;
    }
  }

  // after the solve: each tyre in the mud presses its rut, churns it, and digs when it spins
  mudWork(h, patches) {
    const mud = this.terrain.mud;
    mud.clock += h;
    for (const pt of patches) {
      if (!pt.mud) continue;
      const st = this.mudState[pt.wheel], dl = Math.hypot(pt.d.x, pt.d.z);
      if (dl < 1e-3) continue;
      const roll = dot(pt.vp, pt.d), slip = this.wheelState[pt.wheel].slip;
      mud.work(st.x, st.zz, pt.d.x / dl, pt.d.z / dl, st.bw, st.L, st.z, roll, slip, h);
    }
  }

  // violent: this hit may take the wheel off. Without it a wrecked corner stops at 'bent wheel'
  // (wobbling, still attached): accumulated small hits never snap a wheel on their own.
  damageWheel(i, susp, tire, violent = false) {
    const h = this.health;
    if (this.spec.armour) susp *= this.spec.armour.wheel; // skid plates guard steering / arms
    const names = ['front-left', 'front-right', 'rear-left', 'rear-right'];
    if (tire > 0 && h.tire[i] > 0) {
      const before = h.tire[i];
      h.tire[i] = Math.max(0, h.tire[i] - tire);
      if (before >= 0.35 && h.tire[i] < 0.35) this.damageEvents.push(`Flat tyre: ${names[i]}`);
    }
    if (susp > 0) {
      const before = h.susp[i];
      h.susp[i] = Math.max(violent ? 0 : Math.min(h.susp[i], 0.05), h.susp[i] - susp);
      if (before >= 0.75 && h.susp[i] < 0.75) this.damageEvents.push(`Bent suspension: ${names[i]}`);
      // below 0.35 the hub / wheel itself is bent: it wobbles (view), then fails
      const bend = Math.max(0, 1 - h.susp[i] / 0.35);
      if (bend > 0 && this.crash.mech.bend[i] === 0) this.damageEvents.push(`Bent wheel: ${names[i]} is wobbling`);
      this.crash.mech.bend[i] = Math.max(this.crash.mech.bend[i], bend);
      if (h.susp[i] <= 0 && !this.broken[i]) this.breakWheel(i);
      this.applySag();
    }
  }

  breakWheel(i) {
    const names = ['front-left', 'front-right', 'rear-left', 'rear-right'];
    this.broken[i] = true;
    this.health.susp[i] = 0;
    this.world.removeImpulseJoint(this.wheelJoints[i], true);
    this.syncDriveline();
    this.damageEvents.push(`Snapped! The ${names[i]} wheel tore off`);
  }

  // Suspension compression per wheel (m, + = compressed) relative to ride height.
  compression() {
    const cq = this.chassis.rotation(), cp = this.chassis.translation();
    const inv = qconj(cq);
    return this.wheels.map((w, i) => {
      const lp = qrot(inv, sub(w.translation(), cp));
      return lp.y - this.spec.axleY;
    });
  }

  attitude() {
    const q = this.chassis.rotation();
    const fwd = qrot(q, v(0, 0, -1)), right = qrot(q, v(1, 0, 0));
    const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
    const roll = Math.asin(Math.max(-1, Math.min(1, -right.y)));
    const heading = Math.atan2(-fwd.x, -fwd.z);
    return { pitch, roll, heading };
  }

  upsideDown() {
    const up = qrot(this.chassis.rotation(), v(0, 1, 0));
    return up.y < 0.2;
  }
}

export { qmul, qyaw };
