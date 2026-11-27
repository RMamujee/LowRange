// Parking brake against the engine: each rig on flat rock, parking brake on, first gear (4-Low
// where it has one, as a fresh truck starts), throttle held for 4 s. It must hold at part
// throttle; at full throttle it may only be dragged along slowly; the engine must keep running
// (no stall with the auto-clutch); with the brake off the same throttle drives away.
// usage: node test/parkbrake.mjs [ids=lc70,taco,wrx]
import RAPIER from '@dimforge/rapier3d-compat';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H = 1 / 200;
const ids = (process.argv[2] || 'lc70,taco,wrx').split(',');

function run(spec, thr, park) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
  const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUP_WORLD));
  const car = new Vehicle(RAPIER, world, spec, { ground: { handle: -1 }, rockHandles: new Set([ground.handle]) }, { x: 0, y: spec.tire.radius - spec.axleY + 0.05, z: 0 }, 0);
  const d = car.dt;
  if (spec.ranges.low) { d.range = 'low'; d.fourWD = true; }
  d.gear = 0;
  const inp = { throttle: 0, brake: 0, steer: 0, handbrake: park };
  for (let i = 0; i < 1 / H; i++) car.step(inp, H);
  d.gear = 1;
  const p0 = { ...car.chassis.translation() };
  inp.throttle = thr;
  let vmax = 0, stalled = false;
  for (let i = 0; i < 4 / H; i++) { car.step(inp, H); vmax = Math.max(vmax, Math.abs(car.speed())); if (!d.running) stalled = true; }
  const p = car.chassis.translation(), dist = Math.hypot(p.x - p0.x, p.z - p0.z);
  world.free();
  return { dist, kmh: vmax * 3.6, stalled };
}

let fail = 0;
const bad = (m) => { fail++; console.log('  FAIL ' + m); };
for (const id of ids) {
  const spec = ALL_VEHICLES.find((v) => v.id === id), out = [];
  for (const thr of [0.3, 0.6, 1]) {
    const r = run(spec, thr, true);
    out.push(`thr ${thr}: ${r.dist.toFixed(2)} m, ${r.kmh.toFixed(1)} km/h${r.stalled ? ' STALL' : ''}`);
    if (r.stalled) bad(`${id} stalled against the parking brake at ${thr} throttle`);
    if (thr < 1 && r.dist > 0.05) bad(`${id} parking brake let it move ${r.dist.toFixed(2)} m at ${thr} throttle`);
    if (thr === 1 && (r.dist > 1.5 || r.kmh > 4)) bad(`${id} drove through the parking brake at full throttle: ${r.dist.toFixed(2)} m, ${r.kmh.toFixed(1)} km/h`);
  }
  const free = run(spec, 0.6, false);
  out.push(`brake off, thr 0.6: ${free.dist.toFixed(1)} m`);
  if (free.dist < 2) bad(`${id} with the brake off only moved ${free.dist.toFixed(2)} m`);
  console.log(id.padEnd(5), `park brake, 1st${spec.ranges.low ? ' low' : ''}:`, out.join(' | '));
}
console.log(fail ? `${fail} parking brake problem(s)` : 'parking brake: all checks passed');
process.exit(fail ? 1 : 0);
