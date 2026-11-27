// Single step-up ledge, per rig: the tallest one each rig climbs, at crawl pace and with a run-up.
// The ledge is a flat-topped slab across the track, 4 m deep (longer than any wheelbase, so the
// whole rig has to get up onto it), either square (vertical face) or chamfered like the trail
// ledges in src/maps/common.js (the face leans back 0.7 m per metre of height). Each rig drives
// as it comes: its own lockers, 4WD, low range where it has one. Crawl: throttle governed to
// 0.6-1.6 m/s, as in test/ledgegrade.mjs. Run-up: 1st gear high range, held at about 4 m/s
// (14 km/h) into the face, more throttle if it stalls against it. "Clear" = the rear axle is on
// top of the slab. Prints every height tried and the tallest cleared (with no lower failure).
// usage: node test/ledgeclimb.mjs [ids=lc70,taco,wrx] [shapes=square,chamfer] [modes=crawl,speed] [heights comma]
//        LEDGE_ASSERT=1 also checks the expected limits (exit 1 on a miss)
import RAPIER from '@dimforge/rapier3d-compat';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H = 1 / 200;
const ids = (process.argv[2] || 'lc70,taco,wrx').split(',');
const shapes = (process.argv[3] || 'square,chamfer').split(',');
const modes = (process.argv[4] || 'crawl,speed').split(',');
const heights = (process.argv[5] || '0.2,0.25,0.3,0.35,0.4,0.45,0.5,0.55,0.6,0.65,0.7,0.75').split(',').map(Number);

function run(spec, shape, mode, top) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
  const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUP_WORLD));
  const rockHandles = new Set([ground.handle]); // rock ground too, as on the Gauntlet's ledge stages
  const face = mode === 'speed' ? -16 : -6, hw = 4, depth = 4, Hh = top + 0.6, pts = [];
  // slab from z = face (lip) back to face - depth, base buried 0.6 m; chamfer leans both faces back
  const lean = shape === 'chamfer' ? 0.7 : 0;
  for (const sx of [-1, 1]) for (const [zt, zb] of [[0, Hh * lean], [-depth, -depth - Hh * lean]]) { pts.push(sx * hw, top, zt); pts.push(sx * hw, -0.6, zb); }
  // the chamfered face starts at ground level 0.6 * 0.7 = 0.42 m ahead of the lip
  const c = world.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(pts)).setTranslation(0, 0, face).setFriction(1).setCollisionGroups(GROUP_WORLD));
  rockHandles.add(c.handle);
  const car = new Vehicle(RAPIER, world, spec, { ground, rockHandles }, { x: 0, y: spec.tire.radius - spec.axleY + 0.05, z: 0 }, 0);
  car.airedDown = true; car.grace = 1e9; // damage off: this measures climbing, not crash tolerance
  const d = car.dt; d.fourWD = true; d.lockF = !!spec.lockers.front; d.lockR = !!spec.lockers.rear; d.gear = 1;
  d.range = mode === 'crawl' && spec.ranges.low ? 'low' : 'high';
  const inp = { throttle: 0, brake: 1, steer: 0 };
  for (let i = 0; i < 200; i++) car.step(inp, H);
  inp.brake = 0;
  const lo = mode === 'crawl' ? 0.6 : 3.6, hi = mode === 'crawl' ? 1.6 : 4.4, cap = mode === 'crawl' ? 0.6 : 1;
  let ok = false, stuck = 0, flip = false;
  const secs = mode === 'crawl' ? 30 : 20;
  for (let i = 0; i < secs / H; i++) {
    if (i % 20 === 0) {
      const v = car.speed();
      inp.throttle = v < lo ? Math.min(cap, inp.throttle + (mode === 'crawl' ? 0.02 : 0.08)) : v > hi ? Math.max(0.05, inp.throttle - 0.05) : inp.throttle;
      stuck = v < 0.05 ? stuck + 20 * H : 0;
      if (car.upsideDown()) { flip = true; break; }
      if (stuck > 6) break;
    }
    car.step(inp, H);
    if (car.chassis.translation().z < face - spec.wheelbase / 2 - 0.6 && car.wheels[3].translation().y > top + spec.tire.radius * 0.8) { ok = true; break; }
  }
  // 'front': stopped before the front axle got over the lip; 'rear': the rear end hung up
  const zc = car.chassis.translation().z;
  world.free();
  return ok ? 'ok' : flip ? 'FLIP' : zc > face + spec.wheelbase / 2 ? 'front' : 'rear';
}

const results = {};
for (const id of ids) {
  const spec = ALL_VEHICLES.find((v) => v.id === id);
  for (const shape of shapes) for (const mode of modes) {
    const row = [];
    let best = 0, failed = false;
    for (const top of heights) {
      const r = run(spec, shape, mode, top);
      row.push(`${top}:${r}`);
      if (r === 'ok' && !failed) best = top; else if (r !== 'ok') failed = true;
    }
    results[`${id}/${shape}/${mode}`] = best;
    console.log(`${id.padEnd(5)} ${shape.padEnd(7)} ${mode.padEnd(5)} max ${best.toFixed(2)} m (${(best / spec.tire.radius).toFixed(2)} R)  ${row.join(' ')}`);
  }
}
if (process.env.LEDGE_ASSERT) {
  // expected limits (m): [min, max] tallest single ledge cleared. The Rally Sedan's floor pan
  // and bumper sit 0.25-0.27 m up, so it stops at about its tyre radius (0.33 m); the crawlers
  // keep what they had before its underside was modelled (lc70 0.45 / 0.6 square, 0.7 / 0.75
  // chamfered; taco 0.3 / 0.35 square, 0.6 chamfered; crawl / run-up)
  const expect = {
    'wrx/square/crawl': [0.2, 0.35], 'wrx/chamfer/crawl': [0.2, 0.35], 'wrx/square/speed': [0.2, 0.35], 'wrx/chamfer/speed': [0.2, 0.35],
    'lc70/square/crawl': [0.45, 9], 'lc70/chamfer/crawl': [0.65, 9], 'lc70/square/speed': [0.55, 9], 'lc70/chamfer/speed': [0.7, 9],
    'taco/square/crawl': [0.3, 9], 'taco/chamfer/crawl': [0.55, 9], 'taco/square/speed': [0.3, 9], 'taco/chamfer/speed': [0.55, 9],
  };
  let fail = 0;
  for (const [k, [a, b]] of Object.entries(expect)) {
    if (!(k in results)) continue;
    if (results[k] < a || results[k] > b) { fail++; console.log(`FAIL ${k}: ${results[k]} m, expected ${a}-${b} m`); }
  }
  console.log(fail ? `${fail} limit(s) missed` : 'ledge limits ok');
  process.exit(fail ? 1 : 0);
}
