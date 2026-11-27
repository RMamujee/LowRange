// Side-slope tip-over angle per rig, measured from the physics rather than guessed. Each run
// builds a real tilted rock plane (normal gravity, so the tyre model sees a real slope), sets the
// truck down across it, uphill side on its right, and then:
//   static: parked on the brakes for 4 s: do the uphill wheels lift, does it roll over?
//   drive:  crawls 14 m along the slope at walking pace over a low rock ridge under the uphill
//           wheels (`kick` m, as an off-camber line with rocks under the high side): max roll
//           relative to gravity, tip-over, how far it slid down
// The crawl courses' off-camber sections (src/maps/crawl_courses.js) are tuned against these.
// usage: node test/tipangle.mjs [ids=lc70,taco,wrx] [angles=24,28,32,36,40,44] [kick=0.3]
import RAPIER from '@dimforge/rapier3d-compat';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H = 1 / 200;
const ids = (process.argv[2] || 'lc70,taco,wrx').split(',');
const angles = (process.argv[3] || '24,28,32,36,40,44').split(',').map(Number);
const KICK = +(process.argv[4] ?? 0.3);

// slope rising to +x by `deg`; the truck faces -z (yaw 0)
function run(spec, deg, drive) {
  const a = (deg * Math.PI) / 180, q = { x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) };
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
  const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(40, 1, 40).setTranslation(Math.sin(a), -Math.cos(a), 0).setRotation(q).setFriction(1).setCollisionGroups(GROUP_WORLD));
  const rockHandles = new Set([ground.handle]); // rock grip, like a slab
  if (drive && KICK > 0) {
    // a low rounded ridge in the slope plane along the uphill wheel track, from z = -3 to -16
    const pts = [];
    for (const z of [-3, -16]) for (const [x, y] of [[-0.6, -0.05], [-0.3, KICK * 0.8], [0, KICK], [0.3, KICK * 0.8], [0.6, -0.05]]) pts.push(x, y, z);
    for (const z of [-1.6, -17.4]) pts.push(0, -0.05, z);
    const ux = spec.track / 2; // across the slope, in the plane
    const c = world.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(pts)).setTranslation(ux * Math.cos(a), ux * Math.sin(a), 0).setRotation(q).setFriction(1).setCollisionGroups(GROUP_WORLD));
    rockHandles.add(c.handle);
  }
  const y0 = spec.tire.radius - spec.axleY + 0.05;
  const car = new Vehicle(RAPIER, world, spec, { ground, rockHandles }, { x: -Math.sin(a) * y0, y: Math.cos(a) * y0, z: 0 }, 0);
  // roll the fresh truck onto the slope (uphill = its right)
  const qr = { x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) };
  for (const b of car.allBodies) {
    const p = b.translation();
    b.setTranslation({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a), z: p.z }, true);
    const r = b.rotation();
    b.setRotation({ w: qr.w * r.w - qr.z * r.z, x: qr.w * r.x - qr.z * r.y, y: qr.w * r.y + qr.z * r.x, z: qr.w * r.z + qr.z * r.w }, true);
  }
  car.airedDown = true; const d = car.dt; d.range = spec.ranges.low ? 'low' : 'high'; d.fourWD = true; d.gear = 0;
  d.lockF = !!spec.lockers.front; d.lockR = !!spec.lockers.rear;
  const inp = { throttle: 0, brake: 1, steer: 0, handbrake: true };
  const tilt = () => { const r = car.attitude().roll; return Math.abs(r) * 57.3; }; // roll relative to gravity
  const x0 = car.chassis.translation().x;
  const upIdx = car.wheels.map((w, i) => [i, w.translation().x]).filter(([, x]) => x > x0).map(([i]) => i);
  let maxTilt = 0, lifted = false;
  const watch = () => {
    maxTilt = Math.max(maxTilt, tilt());
    if (upIdx.every((i) => !car.wheelState[i].grounded)) lifted = true;
    return car.upsideDown() || tilt() > 70;
  };
  for (let i = 0; i < 300; i++) { car.step(inp, H); if (i > 100 && watch()) return { tip: true, maxTilt }; }
  if (!drive) {
    lifted = false;
    for (let i = 0; i < 4 / H; i++) { car.step(inp, H); if (watch()) return { tip: true, maxTilt }; }
    return { tip: false, maxTilt, lifted, slid: x0 - car.chassis.translation().x };
  }
  inp.brake = 0; inp.handbrake = false; d.gear = 1; lifted = false; maxTilt = 0;
  for (let i = 0; i < 30 / H; i++) {
    if (i % 20 === 0) {
      const v = car.speed(), { heading } = car.attitude();
      inp.throttle = v < 0.5 ? Math.min(0.8, inp.throttle + 0.02) : v > 1.0 ? Math.max(0, inp.throttle - 0.03) : inp.throttle;
      inp.steer = Math.max(-1, Math.min(1, -heading * 2)); // hold the line along the slope
    }
    car.step(inp, H);
    if (watch()) return { tip: true, maxTilt };
    if (car.chassis.translation().z < -18) break;
  }
  return { tip: false, maxTilt, lifted, slid: x0 - car.chassis.translation().x };
}

console.log(`side slope (deg): parked [tilt vs gravity, LIFT = both uphill wheels off] | driving 14 m over a ${KICK} m ridge under the uphill wheels`);
for (const id of ids) {
  const spec = ALL_VEHICLES.find((v) => v.id === id);
  const s = [], dr = [];
  for (const a of angles) {
    const r = run(spec, a, false); s.push(`${a}:${r.tip ? 'TIP' : `${r.maxTilt.toFixed(0)}${r.lifted ? ' LIFT' : ''}${Math.abs(r.slid) > 0.5 ? ` slid ${r.slid.toFixed(1)}` : ''}`}`);
    const k = run(spec, a, true); dr.push(`${a}:${k.tip ? 'TIP' : `${k.maxTilt.toFixed(0)}${k.lifted ? ' LIFT' : ''}${Math.abs(k.slid) > 0.5 ? ` slid ${k.slid.toFixed(1)}` : ''}`}`);
  }
  console.log(`${id.padEnd(5)} parked  ${s.join('  ')}`);
  console.log(`${''.padEnd(5)} driving ${dr.join('  ')}`);
}
