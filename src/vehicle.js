// Vehicle physics: chassis + two solid axles on rigid bodies and joints.
//
//   chassis --prismatic(Y, spring)--> slider --revolute(Z, roll spring)--> axle
//   axle --revolute(Y, steering motor)--> knuckle --revolute(X, free)--> wheel
//
// The axle is a real rigid body, so one wheel climbing a rock lifts/tilts the whole axle
// (articulation), the diff pumpkin can hang up on rocks, and drive torque reacts through
// the axle housing. Wheel spin is coupled to the Drivetrain each substep.

import { Drivetrain } from './drivetrain.js';
import { MAT, MAT_INFO, materialAt, GROUP_VEHICLE } from './terrain.js';

const G = 9.81;

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
    this.airedDown = false;
    this.rearSteerOn = false;
    this.steer = 0;
    // Damage: 1 = healthy, 0 = destroyed. Big impacts wear these down.
    this.health = { tire: [1, 1, 1, 1], susp: [1, 1, 1, 1], engine: 1, body: 1 };
    this.broken = [false, false, false, false];
    this.dents = [];          // queued for the view: { p (chassis-local), n (local), amount }
    this.damageEvents = [];   // short messages for the HUD
    this.build(pos, yaw);
    const t = spec.tire;
    this.wheelI = t.mass * t.radius * t.radius * 0.7;
    this.dt = new Drivetrain(spec, this.wheelI);
    this.wheelState = [0, 1, 2, 3].map(() => ({ grounded: false, mat: MAT.DIRT, hitDist: 0, spin: 0, angle: 0, depth: 0 }));
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
    const box = (hx, hy, hz, ox, oy, oz, fr = 0.5) => world.createCollider(
      R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(ox, oy, oz).setDensity(0).setFriction(fr)
        .setCollisionGroups(GROUP_VEHICLE), cb);
    // frame rails / skid plate
    box(cw * 0.42, ch / 2, cl / 2, 0, 0, 0);
    // body shell: cab / cage, so rollovers land on the roof
    if (spec.body === 'buggy') box(cw * 0.5, 0.55, 0.95, 0, ch / 2 + 0.55, 0.1, 0.4);
    if (spec.body === 'pickup') { box(cw * 0.5, 0.5, 0.95, 0, ch / 2 + 0.5, -0.35, 0.4); box(cw * 0.5, 0.22, cl * 0.2, 0, ch / 2 + 0.22, cl * 0.3, 0.4); }
    if (spec.body === 'taco') { box(cw * 0.5, 0.48, 0.95, 0, ch / 2 + 0.48, -0.25, 0.4); box(cw * 0.5, 0.3, cl * 0.17, 0, ch / 2 + 0.2, -cl * 0.33, 0.4); box(cw * 0.5, 0.25, cl * 0.17, 0, ch / 2 + 0.25, cl * 0.3, 0.4); }
    if (spec.body === 'lc70') { box(cw * 0.5, 0.62, 1.55, 0, ch / 2 + 0.62, 0.55, 0.4); box(cw * 0.48, 0.3, 0.6, 0, ch / 2 + 0.3, -cl * 0.36, 0.4); }
    if (spec.body === 'wrx') { box(cw * 0.5, 0.3, cl * 0.48, 0, ch / 2 + 0.2, 0, 0.4); box(cw * 0.44, 0.28, 1.15, 0, ch / 2 + 0.62, 0.15, 0.4); }
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
    this.suspK = k; this.sag = sag;

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
    this.wheelHandles = this.wheelColliders.map((c) => c.handle);
    this.bodyHandles = [];
    for (let k2 = 0; k2 < cb.numColliders(); k2++) {
      const col = cb.collider(k2);
      col.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS);
      col.setContactForceEventThreshold(M * G * 3);
      this.bodyHandles.push(col.handle);
    }
    for (const ax of this.axles) if (ax.body) for (let k2 = 0; k2 < ax.body.numColliders(); k2++) this.bodyHandles.push(ax.body.collider(k2).handle);
    this.events = this.events || new R.EventQueue(true);
    this.allBodies = [cb, ...this.axles.flatMap((a) => (a.independent ? a.carriers : [a.slider, a.body])), ...this.knuckles, ...this.wheels];
    // a wheel torn off earlier stays off after a recovery
    if (this.broken) this.broken.forEach((b, i) => { if (b) { world.removeImpulseJoint(this.wheelJoints[i], true); } });
  }

  // One physics substep for the whole vehicle.
  step(input, h) {
    this.prePhysics(input, h);
    this.world.step(this.events);
    this.postPhysics(input, h);
  }

  destroy() {
    for (const b of this.allBodies) this.world.removeRigidBody(b);
  }

  // Rebuild at a new pose, keeping drivetrain state.
  reset(pos, yaw) {
    this.destroy();
    this.build(pos, yaw);
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
    // steering (rate limited, slower at speed)
    const kmh = Math.abs(this.speed()) * 3.6;
    const maxSteer = spec.steer.max * (1 - Math.min(0.55, kmh / 90));
    const target = input.steer * maxSteer;
    const rate = spec.steer.rate * h;
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
      const bend = (1 - this.health.susp[i]) * 0.16 * (i % 2 ? -1 : 1); // bent tie rod / arm: toe out
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
      // viscous drag through mud / sand
      if (grounded && info.drag > 0) {
        const lv = wbody.linvel();
        const k = info.drag * (t.width / 0.35) * h;
        this.chassis.applyImpulseAtPoint(v(-lv.x * k, -lv.y * k * 0.3, -lv.z * k), p, true);
      }
    }

    // aero drag
    const lv = this.chassis.linvel();
    const sp = Math.hypot(lv.x, lv.y, lv.z);
    const [cw, ch] = spec.chassis.size;
    const dragK = 0.5 * 1.2 * 0.9 * cw * (ch + 1.2) * sp * h;
    this.chassis.applyImpulse(v(-lv.x * dragK, -lv.y * dragK, -lv.z * dragK), true);
  }

  wheelAxis(i) { return qrot(this.knuckles[i].rotation(), v(1, 0, 0)); }
  // forward-positive spin of wheel i relative to its knuckle (rad/s)
  wheelSpin(i) {
    return -dot(sub(this.wheels[i].angvel(), this.knuckles[i].angvel()), this.wheelAxis(i));
  }

  matOf(collider, p) {
    if (this.terrain.rockHandles.has(collider.handle)) return MAT.ROCK;
    if (collider.handle === this.terrain.ground.handle) return materialAt(p.x, p.z);
    return MAT.DIRT;
  }

  tyreGrip(mat, slipping) {
    const info = MAT_INFO[mat];
    let mu = info.mu, rr = info.rr;
    if (this.airedDown) {
      if (mat === MAT.ROCK) mu *= 1.15;
      else if (mat === MAT.SAND) { mu *= 1.12; rr *= 0.55; }
      else if (mat === MAT.MUD) mu *= 1.06;
      else rr *= 1.25;
    }
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
    this.events.drainContactForceEvents((ev) => {
      const h1 = ev.collider1(), h2 = ev.collider2();
      let i = this.wheelHandles.indexOf(h1), other = h2, sign = -1;
      if (i < 0) { i = this.wheelHandles.indexOf(h2); other = h1; sign = 1; }
      if (i < 0) {
        const mine = this.bodyHandles.includes(h1) ? h1 : this.bodyHandles.includes(h2) ? h2 : null;
        if (mine !== null) this.bodyImpact(scale(ev.totalForce(), mine === h1 ? -1 : 1), ev.totalForceMagnitude());
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
          ? sub(c, scale(radial, (t.radius * 0.97) / rl))
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
        patches.push({ wheel: i, p, n, d, e, k, vp, N: len0, mat: this.matOf(ev.other, p) });
        this.wheelState[i].contact = true;
      }
    }

    // hard hits on a wheel bend the suspension and can cut the tyre
    const Wst = (this.mass * G) / 4;
    this.grace -= h;
    for (let i = 0; i < 4 && this.grace <= 0; i++) {
      if (this.broken[i]) continue;
      let F = 0, rock = false;
      for (const ev of byWheel[i]) { F += len(ev.F); if (this.terrain.rockHandles.has(ev.other.handle)) rock = true; }
      const gi = F / Wst;
      if (gi > 18) this.damageWheel(i, (gi - 18) * 0.0035, rock && gi > 24 ? (gi - 24) * 0.005 : 0);
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
      const row = { pairs, v0, lo: -cap, hi: cap };
      extra.rows.push(row);
      return row;
    };
    for (let k = patches.length - 1; k >= 0; k--) if (this.broken[patches[k].wheel]) patches.splice(k, 1);
    for (const pt of patches) {
      const s = spins[pt.wheel];
      const slipL = dot(pt.vp, pt.d) + pt.k * s;
      const slipLat = dot(pt.vp, pt.e);
      let { mu, rr } = this.tyreGrip(pt.mat, Math.hypot(slipL, slipLat) > 1.0);
      if (this.health.tire[pt.wheel] < 0.35) { mu *= 0.6; rr *= 3; } // flat tyre
      pt.mu = mu;
      pt.cap = mu * pt.N * h;
      pt.rowL = rowFor(pt, pt.d, slipL, pt.cap);
      slips[pt.wheel] = Math.max(slips[pt.wheel], Math.hypot(slipL, slipLat));
      pt.rowA = rowFor(pt, pt.e, slipLat, pt.cap);
      loads[pt.wheel] += pt.N;
      rrs[pt.wheel] = Math.max(rrs[pt.wheel], rr);
    }

    // 3. brakes + rolling resistance (N·m capacity per wheel)
    const brakes = [0, 1, 2, 3].map((i) => {
      let b = input.brake * spec.brakeT + rrs[i] * loads[i] * t.radius;
      if (input.handbrake && i >= 2) b += spec.brakeT * 1.5;
      return b;
    });

    // 4. one exact solve: engine + clutch + gears + diffs + brakes + tyre grip
    this.dt.brakePedal = input.brake;
    const driveImp = this.dt.step(h, input.throttle, spins, brakes, extra);

    // 5. apply tyre forces (friction circle), wheel spin, and axle reactions
    for (const pt of patches) {
      let L = pt.rowL.imp, A = pt.rowA.imp;
      const mag = Math.hypot(L, A);
      if (mag > pt.cap && mag > 0) { L *= pt.cap / mag; A *= pt.cap / mag; }
      const P = add(scale(pt.d, L), scale(pt.e, A));
      const Pu = scale(up, dot(P, up));
      this.wheels[pt.wheel].applyImpulse(Pu, true);
      this.chassis.applyImpulseAtPoint(sub(P, Pu), pt.p, true);
      pt.imp = L; pt.lat = A;
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
    // engine torque reaction rolls the chassis
    const fwd = qrot(cq, v(0, 0, -1));
    this.chassis.applyTorqueImpulse(scale(fwd, -this.dt.engineTorque * h * 0.8), true);
  }

  damageWheel(i, susp, tire) {
    const h = this.health;
    const names = ['front-left', 'front-right', 'rear-left', 'rear-right'];
    if (tire > 0 && h.tire[i] > 0) {
      const before = h.tire[i];
      h.tire[i] = Math.max(0, h.tire[i] - tire);
      if (before >= 0.35 && h.tire[i] < 0.35) this.damageEvents.push(`Flat tyre: ${names[i]}`);
    }
    if (susp > 0) {
      const before = h.susp[i];
      h.susp[i] = Math.max(0, h.susp[i] - susp);
      if (before >= 0.75 && h.susp[i] < 0.75) this.damageEvents.push(`Bent suspension: ${names[i]}`);
      if (h.susp[i] <= 0 && !this.broken[i]) this.breakWheel(i);
    }
  }

  breakWheel(i) {
    const names = ['front-left', 'front-right', 'rear-left', 'rear-right'];
    this.broken[i] = true;
    this.health.susp[i] = 0;
    this.world.removeImpulseJoint(this.wheelJoints[i], true);
    this.dt.broken = this.broken;
    this.damageEvents.push(`Snapped! The ${names[i]} wheel tore off`);
  }

  // f: force on the chassis (world), mag: its magnitude
  bodyImpact(f, mag) {
    const M = this.mass;
    const g = mag / (M * G);
    if (g < 8 || this.grace > 0) return;
    const amt = (g - 8) * 0.0025;
    const cq = this.chassis.rotation();
    const n = qrot(qconj(cq), scale(f, 1 / Math.max(1e-6, mag))); // push direction, chassis-local
    const [cw, ch, cl] = this.spec.chassis.size;
    // dent where the hit came from: the body surface opposite the push direction
    const p = v(-n.x * cw * 0.5, -n.y * (ch * 0.5 + 0.4) + 0.4, -n.z * cl * 0.5);
    this.dents.push({ p, n, amount: Math.min(0.12, amt * 1.5) });
    const h = this.health;
    h.body = Math.max(0, h.body - amt * 0.5);
    if (n.z > 0.5) { // hit from the front: radiator / engine
      const before = h.engine;
      h.engine = Math.max(0, h.engine - amt * 0.5);
      if (before >= 0.5 && h.engine < 0.5) this.damageEvents.push('Engine damaged: losing power');
      if (h.engine <= 0.08 && !this.dt.dead) { this.dt.dead = true; this.dt.running = false; this.damageEvents.push('Engine destroyed'); }
    }
    this.dt.powerScale = 0.3 + 0.7 * h.engine;
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
