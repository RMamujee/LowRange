// Parked on a slope: a braked truck within its tyres' grip must stay put (millimetres over a
// long wait, no jitter), and one past its grip must still slide. Slopes are simulated by
// tilting gravity (as in test/ledgegrade.mjs), nose uphill and side-on, on rock and dirt; mud
// at 30 degrees (mu 0.42, past what any tyre holds) must slide. Tolerance: 5 mm over the wait. Each rig, in neutral, with the
// parking brake, the foot brake, or both.
// usage: node test/slopehold.mjs [ids=lc70,taco,wrx] [secs=40]
import RAPIER from '@dimforge/rapier3d-compat';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD, MAT } from '../src/terrain.js';
await RAPIER.init();
const H = 1 / 200;
const ids = (process.argv[2] || 'lc70,taco,wrx').split(',');
const secs = +(process.argv[3] || 40);
const TOL = 0.005; // m over the whole wait

function run(spec, deg, side, mat, inp) {
  const a = deg / 57.2958, gx = side ? 9.81 * Math.sin(a) : 0, gz = side ? 0 : 9.81 * Math.sin(a);
  const world = new RAPIER.World({ x: gx, y: -9.81 * Math.cos(a), z: gz }); world.timestep = H; world.numSolverIterations = 8;
  const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUP_WORLD));
  const rockHandles = new Set(mat === MAT.ROCK ? [ground.handle] : []);
  const propInfo = new Map(mat === MAT.MUD ? [[ground.handle, { mat }]] : []);
  const car = new Vehicle(RAPIER, world, spec, { ground: { handle: -1 }, rockHandles, propInfo }, { x: 0, y: spec.tire.radius - spec.axleY + 0.05, z: 0 }, 0);
  car.dt.gear = 0;
  for (let i = 0; i < 3 / H; i++) car.step(inp, H); // settle
  const p0 = { ...car.chassis.translation() };
  // drift: the furthest the chassis wandered from where it settled, sampled every 0.1 s (so a
  // shuffle back and forth counts too). Velocities are no use here: right after an engine
  // step they include the gravity kick the tyre solve then takes back.
  let drift = 0;
  for (let i = 0; i < secs / H; i++) { car.step(inp, H); if (i % 20 === 0) { const p = car.chassis.translation(); drift = Math.max(drift, Math.hypot(p.x - p0.x, p.z - p0.z)); } }
  world.free();
  return { drift };
}

const brakes = [['park', { throttle: 0, brake: 0, steer: 0, handbrake: true }], ['foot', { throttle: 0, brake: 1, steer: 0, handbrake: false }], ['both', { throttle: 0, brake: 1, steer: 0, handbrake: true }]];
let fail = 0;
for (const id of ids) {
  const spec = ALL_VEHICLES.find((v) => v.id === id);
  const out = [];
  for (const [mat, name, degs] of [[MAT.ROCK, 'rock', [4, 8, 15, 22]], [MAT.DIRT, 'dirt', [4, 12]]]) {
    for (const deg of degs) for (const side of [false, true]) for (const [bn, inp] of brakes) {
      if (side && deg > 15) continue; // side-on past 15 deg is a rollover test, not a brake test
      if (bn !== 'park' && (deg > 8 || side)) continue; // park brake everywhere, foot / both on the shallow ones
      const r = run(spec, deg, side, mat, inp);
      if (r.drift > TOL) { fail++; console.log(`  FAIL ${id} ${name} ${deg} deg ${side ? 'side-on' : 'nose up'} ${bn}: moved ${(r.drift * 1000).toFixed(1)} mm`); }
      out.push(`${name}${deg}${side ? 's' : ''}/${bn} ${(r.drift * 1000).toFixed(1)}mm`);
    }
  }
  // past the grip: mud at 30 degrees must slide
  const m = run(spec, 30, false, MAT.MUD, brakes[2][1]);
  if (m.drift < 0.5) { fail++; console.log(`  FAIL ${id} mud 30 deg held (${m.drift.toFixed(2)} m): it should slide`); }
  out.push(`mud30 slides ${m.drift.toFixed(1)}m`);
  console.log(id.padEnd(5), `${secs} s:`, out.join(' | '));
}
console.log(fail ? `${fail} slope hold problem(s)` : 'slope hold: all checks passed');
process.exit(fail ? 1 : 0);
