// Angled ledge approach: what meets a square ledge first, the leading front tyre or the body?
// Each rig creeps (4-Low, ~0.4 m/s) on flat ground into a square-faced slab whose face is turned
// `yaw` degrees from square-on, so one front tyre leads, the way a ledge is taken at an angle.
// Logged: the first vehicle collider to touch the slab (a tyre, or a chassis box by name /
// an axle). The static numbers (approach / departure angle, front overhang) come from the
// collision boxes at ride height.
// Asserts, per rig, that the leading tyre touches first for every yaw in 0-45 degrees and every
// ledge up to the rig's limit for that yaw (EXPECT below: the bumper's height head-on, its raised
// wings at 45 degrees), and that a head-on hit into a wall still stops the truck.
// usage: node test/approach.mjs [ids=lc70,taco] [yaws=0,15,30,45] [heights]
import RAPIER from '@dimforge/rapier3d-compat';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H = 1 / 200;
const ids = (process.argv[2] || 'lc70,taco').split(',');
const yaws = (process.argv[3] || '0,15,30,45').split(',').map(Number);
const heights = (process.argv[4] || '0.4,0.5,0.55,0.58,0.62,0.66,0.7,0.75,0.8').split(',').map(Number);
// tallest square ledge (m) the leading tyre must meet first, per yaw (degrees)
const EXPECT = {
  lc70: { 0: 0.55, 15: 0.55, 30: 0.55, 45: 0.7 },
  taco: { 0: 0.5, 15: 0.5, 30: 0.58, 45: 0.7 },
};

function setup(spec) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
  const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(100, 1, 100).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUP_WORLD));
  const rockHandles = new Set([ground.handle]);
  const car = new Vehicle(RAPIER, world, spec, { ground, rockHandles }, { x: 0, y: spec.tire.radius - spec.axleY + 0.03, z: 0 }, 0);
  car.airedDown = false; car.grace = 1e9;
  const d = car.dt; d.fourWD = true; d.lockF = !!spec.lockers.front; d.lockR = !!spec.lockers.rear; d.gear = 1; d.range = spec.ranges.low ? 'low' : 'high';
  const inp = { throttle: 0, brake: 1, steer: 0 };
  for (let i = 0; i < 200; i++) car.step(inp, H); // settle
  return { world, car, rockHandles, inp };
}
const partName = (car, h) => {
  const w = car.wheelHandles.indexOf(h);
  if (w >= 0) return 'tyre' + ['FL', 'FR', 'RL', 'RR'][w];
  const b = (car.crash.boxes || []).find((x) => x.col.handle === h);
  if (b) return (b.name || 'box').replace(/^front(.)/, (m, c) => c.toLowerCase());
  const p = car.partOf.get(h);
  return p ? p.part : 'other';
};
const touching = (world, a, b) => { let t = false; world.contactPair(a, b, (m) => { for (let j = 0; j < m.numContacts(); j++) if (m.contactDist(j) < 0.002) t = true; }); return t; };

// one run: the slab's face turned by `yaw` (right front tyre leads), `top` high, the leading tyre 0.25 m short of it
function firstContact(spec, yaw, top) {
  const s = setup(spec), { world, car, inp } = s;
  const a = (yaw * Math.PI) / 180, m = { x: Math.sin(a), z: -Math.cos(a) }; // the slab's inward normal (truck frame = world here)
  const c0 = car.chassis.translation();
  const R = spec.tire.radius, tx = spec.track / 2 + spec.tire.width / 2, zf = c0.z - spec.wheelbase / 2;
  const lead = tx * Math.sin(a) + (-zf + R) * Math.cos(a) + c0.x * m.x; // the leading tyre's reach along m
  const c = lead + 0.25, hz = 3;
  const slab = world.createCollider(RAPIER.ColliderDesc.cuboid(8, top / 2, hz)
    .setTranslation(m.x * (c + hz), top / 2, m.z * (c + hz)).setRotation({ x: 0, y: Math.sin(-a / 2), z: 0, w: Math.cos(-a / 2) })
    .setFriction(1).setCollisionGroups(GROUP_WORLD));
  s.rockHandles.add(slab.handle);
  inp.brake = 0;
  const mine = [...car.wheelHandles, ...car.bodyHandles];
  let first = null;
  for (let i = 0; i < 8 / H && !first; i++) {
    if (i % 10 === 0) { const v = car.speed(); inp.throttle = v < 0.3 ? Math.min(0.5, inp.throttle + 0.02) : v > 0.5 ? Math.max(0, inp.throttle - 0.04) : inp.throttle; }
    car.step(inp, H);
    for (const h of mine) if (touching(world, world.getCollider(h), slab)) { first = first ? first + '+' + partName(car, h) : partName(car, h); }
  }
  world.free();
  return first || 'none';
}

// head-on into a tall wall at 3 m/s: the truck must stop against it (bumper contact, no pass-through)
function headOn(spec) {
  const s = setup(spec), { world, car, inp } = s;
  const zWall = -spec.wheelbase / 2 - 1.2 - 6;
  const wall = world.createCollider(RAPIER.ColliderDesc.cuboid(6, 1.5, 0.5).setTranslation(0, 1.5, zWall - 0.5).setCollisionGroups(GROUP_WORLD));
  s.rockHandles.add(wall.handle);
  car.chassis.setLinvel({ x: 0, y: 0, z: -3 }, true); for (const b of car.allBodies) b.setLinvel({ x: 0, y: 0, z: -3 }, true);
  inp.brake = 0; inp.throttle = 0.4; car.dt.range = 'high';
  let hit = '', minZ = 1e9;
  for (let i = 0; i < 4 / H; i++) {
    car.step(inp, H);
    for (const h of car.bodyHandles) if (!hit && touching(world, world.getCollider(h), wall)) hit = partName(car, h);
    minZ = Math.min(minZ, car.chassis.translation().z);
  }
  const front = minZ - spec.wheelbase / 2 - spec.chassis.ends.front.bumper[3]; // furthest the bumper's face got
  const r = { hit, overlap: zWall - front, v: Math.abs(car.speed()) };
  world.free();
  return r;
}

let fail = 0;
for (const id of ids) {
  const spec = ALL_VEHICLES.find((v) => v.id === id);
  console.log(`${id}: first contact with a square ledge (rows: yaw to the ledge; cols: ledge height, m)`);
  console.log('  yaw  ' + heights.map((h) => String(h).padEnd(20)).join(''));
  for (const yaw of yaws) {
    const row = heights.map((top) => {
      const f = firstContact(spec, yaw, top);
      const want = EXPECT[id]?.[yaw];
      if (want !== undefined && top <= want + 1e-9 && !f.split('+').every((p) => /^tyreF[LR]$/.test(p))) { fail++; console.log(`  FAIL ${id} yaw ${yaw} ledge ${top} m: first contact ${f}, expected a front tyre up to ${want} m`); }
      return f.padEnd(20);
    });
    console.log(`  ${String(yaw).padStart(3)}  ${row.join('')}`);
  }
  if (spec.chassis.ends) {
    const r = headOn(spec);
    const ok = r.hit && r.v < 0.5 && r.overlap < 0.15;
    if (!ok) fail++;
    console.log(`  head-on into a wall at 3 m/s: first body contact ${r.hit || 'none'}, bumper face past the wall ${r.overlap.toFixed(2)} m, speed after ${r.v.toFixed(2)} m/s ${ok ? 'ok' : 'FAIL'}`);
  }
}
console.log(fail ? `${fail} check(s) failed` : 'approach checks ok');
process.exit(fail ? 1 : 0);
