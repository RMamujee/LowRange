// Slow-speed abuse must not damage anything: each rig at walking pace (4-Low where it has it, 1st
// high otherwise) drops off a 0.6 m ledge one wheel first, climbs a tyre-radius ledge at full
// throttle, wedges a front tyre into a rock notch at full throttle, and rolls over a rock in 1st
// high at ~8 km/h. Logs the per-wheel damage inputs (windowed load in g, wheel closing speed, gated
// load) and asserts no suspension / tyre / body / engine damage and no lost wheels.
// usage: node test/slowcrawl.mjs [ids=taco,lc70,wrx]
import RAPIER from '@dimforge/rapier3d-compat';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H = 1 / 200;
const ids = (process.argv[2] || 'taco,lc70,wrx').split(',');
let fails = 0;
const yq = (a) => ({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) });

function scene(spec, build, startY = 0) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
  const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUP_WORLD));
  const rockHandles = new Set();
  const rock = (desc, x, y, z, rot) => { const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z).setRotation(rot || yq(0))); const c = world.createCollider(desc.setFriction(1).setCollisionGroups(GROUP_WORLD), b); rockHandles.add(c.handle); return c; };
  build(rock);
  const car = new Vehicle(RAPIER, world, spec, { ground, rockHandles }, { x: 0, y: startY + spec.tire.radius - spec.axleY + 0.1, z: 0 }, 0);
  const d = car.dt; d.autoClutch = true; d.range = spec.ranges.low ? 'low' : 'high'; d.fourWD = true; d.gear = 1;
  if (spec.lockers.front) d.lockF = true; if (spec.lockers.rear) d.lockR = true;
  const peak = [0, 1, 2, 3].map(() => ({ filt: 0, vc: 0, gi: 0 }));
  car.wheelLog = (i, x) => { const p = peak[i]; p.filt = Math.max(p.filt, x.filt); p.vc = Math.max(p.vc, x.vc); p.gi = Math.max(p.gi, x.gi); };
  return { world, car, peak };
}
function drive(s, secs, thr, vmax) {
  let vtop = 0;
  for (let i = 0; i < secs / H; i++) {
    const v = Math.abs(s.car.speed());
    vtop = Math.max(vtop, v);
    s.car.step({ throttle: v > vmax ? 0 : thr, brake: v > vmax * 1.3 ? 0.3 : 0, steer: 0 }, H);
  }
  return vtop;
}
function judge(name, s, vtop) {
  const c = s.car, h = c.health;
  const ok = h.susp.every((x) => x > 0.99) && h.tire.every((x) => x > 0.99) && h.body > 0.99 && h.engine > 0.99 && c.broken.every((b) => !b);
  if (!ok) fails++;
  const p = c.chassis.translation();
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(30)} top ${(vtop * 3.6).toFixed(1)} km/h, z ${p.z.toFixed(1)} | susp ${h.susp.map((x) => x.toFixed(2)).join('/')} tyre ${h.tire.map((x) => x.toFixed(2)).join('/')} body ${h.body.toFixed(2)} broken ${c.broken.filter(Boolean).length} | per wheel peak load ${s.peak.map((q) => q.filt.toFixed(0)).join('/')} g, closing ${s.peak.map((q) => q.vc.toFixed(1)).join('/')} m/s, gated ${s.peak.map((q) => q.gi.toFixed(0)).join('/')} g`);
}

for (const id of ids) {
  const spec = VEHICLES.find((v) => v.id === id);
  console.log(`== ${spec.name}`);
  const R = spec.tire.radius;
  // A: off a 0.6 m ledge, skewed 25 degrees so the front-left wheel goes over first
  {
    const s = scene(spec, (rock) => rock(RAPIER.ColliderDesc.cuboid(4, 0.3, 4), 0.6, 0.3, 0.3, yq(0.44)), 0.6);
    judge('0.6 m ledge drop, one wheel', s, drive(s, 12, 0.5, 1.4));
  }
  // B: up a tyre-radius ledge at full throttle (wheel hop and bounce)
  {
    const s = scene(spec, (rock) => rock(RAPIER.ColliderDesc.cuboid(4, R * 0.5, 2), 0, R * 0.5, -6, yq(0.15)));
    judge(`climb a ${R.toFixed(2)} m ledge, full throttle`, s, drive(s, 14, 1, 2.5));
  }
  // C: front-left tyre driven into a V notch between two boulders, full throttle for 8 s
  {
    const s = scene(spec, (rock) => {
      // two low boulders (0.5 m) angled into a V right in front of the tyre: the nose clears them
      const x = -spec.track / 2, z = -spec.wheelbase / 2 - R - 1.4;
      rock(RAPIER.ColliderDesc.cuboid(0.35, 0.25, 0.35), x - 0.42, 0.25, z, yq(0.7));
      rock(RAPIER.ColliderDesc.cuboid(0.35, 0.25, 0.35), x + 0.42, 0.25, z, yq(-0.7));
    });
    judge('tyre wedged in a notch, WOT', s, drive(s, 10, 1, 3));
  }
  // D: 1st high, ~8 km/h, a 0.35 m rock under one wheel
  {
    const s = scene(spec, (rock) => rock(RAPIER.ColliderDesc.ball(0.5), -spec.track / 2, -0.15, -8));
    s.car.dt.range = 'high';
    judge('rock under a wheel, 8 km/h', s, drive(s, 8, 0.7, 2.3));
  }
  // E: loose stones (dynamic, light) under all wheels at walking pace
  {
    const s = scene(spec, () => {});
    for (let k = 0; k < 14; k++) {
      const b = s.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(((k % 4) - 1.5) * 0.5, 0.15, -4 - k * 0.6));
      s.world.createCollider(RAPIER.ColliderDesc.ball(0.12 + (k % 3) * 0.04).setDensity(2600).setFriction(0.8).setCollisionGroups(GROUP_WORLD), b);
    }
    judge('loose stones, walking pace', s, drive(s, 14, 0.6, 1.4));
  }
}
console.log(fails ? `${fails} slow-speed case(s) took damage` : 'no damage at slow speed');
process.exitCode = fails ? 1 : 0;
