// Synthetic staircase: N step-ups (flat-topped, chamfered faces like crawl.js stepSlab) on a
// grade, simulated by tilting gravity. Finds how tall a staircase each rig really walks, which
// is what The Gauntlet's Waterfall is tuned against. Drives with test/crawl.mjs's autopilot
// throttle (more throttle the steeper it gets), each rig as it comes (own lockers, low range).
// usage: node test/stairgrade.mjs <ids> <grades comma> <rises comma (m)> [tread m=3.4] [steps=5]
import RAPIER from '@dimforge/rapier3d-compat';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H = 1 / 200;
const ids = (process.argv[2] || 'lc70,taco').split(',');
const grades = (process.argv[3] || '0.2,0.28').split(',').map(Number);
const rises = (process.argv[4] || '0.5,0.6,0.7').split(',').map(Number);
const tread = +(process.argv[5] || 3.4), N = +(process.argv[6] || 5);
for (const id of ids) {
  const spec = ALL_VEHICLES.find((v) => v.id === id);
  for (const g of grades) {
    const res = [];
    for (const rise of rises) {
      const a = Math.atan(g);
      const world = new RAPIER.World({ x: 0, y: -9.81 * Math.cos(a), z: 9.81 * Math.sin(a) }); world.timestep = H; world.numSolverIterations = 8;
      const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUP_WORLD));
      const rockHandles = new Set();
      const z0 = -8, hw = 4;
      for (let k = 0; k < N; k++) {
        // step k: face at z0 - k*tread (driving towards -z), top at (k+1)*rise, reaching back to the summit
        // the face drops from this step's top to 0.35 below the previous tread, as in stepSlab
        const top = (k + 1) * rise, zf = (rise + 0.35) * 0.62, pts = [];
        for (const sx of [-1, 1]) {
          pts.push(sx * hw, top, 0); pts.push(sx * hw, k * rise - 0.35, zf);
          pts.push(sx * hw, top, -(N - k) * tread - 4); pts.push(sx * hw, -0.3, -(N - k) * tread - 4);
        }
        const c = world.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(pts)).setTranslation(0, 0, z0 - k * tread).setFriction(1).setCollisionGroups(GROUP_WORLD));
        rockHandles.add(c.handle);
      }
      const car = new Vehicle(RAPIER, world, spec, { ground, rockHandles }, { x: 0, y: spec.tire.radius - spec.axleY + 0.05, z: 0 }, 0);
      car.airedDown = true; const d = car.dt; d.range = spec.ranges.low ? 'low' : 'high'; d.fourWD = true; d.gear = 1; d.lockF = !!spec.lockers.front; d.lockR = !!spec.lockers.rear;
      const inp = { throttle: 0, brake: 1, steer: 0 };
      for (let i = 0; i < 200; i++) car.step(inp, H);
      inp.brake = 0;
      let ok = false, t = 0;
      for (let i = 0; i < 150 / H; i++) {
        if (i % 20 === 0) {
          const v = car.speed(), floor = Math.min(0.7, 0.05 + Math.max(0, Math.sin(car.attitude().pitch + a)) * 0.7); // a: the grade, which tilted gravity hides from the attitude
          inp.throttle = v < 0 ? Math.min(1, inp.throttle + 0.05) : v < 0.3 ? Math.min(1, inp.throttle + 0.02) : v < 0.6 ? Math.min(0.75, inp.throttle + 0.02) : v > 1.2 ? Math.max(floor, inp.throttle - 0.03) : inp.throttle;
          if (car.upsideDown()) break;
        }
        car.step(inp, H);
        if (car.chassis.translation().z < z0 - N * tread - spec.wheelbase - 1) { ok = true; t = i * H; break; }
      }
      res.push(`${rise}:${ok ? 'OK ' + t.toFixed(0) + 's' : car.upsideDown() ? 'FLIP' : 'x@' + Math.max(0, Math.floor((z0 + 1 - car.chassis.translation().z + spec.wheelbase / 2) / tread))}`);
      world.free();
    }
    console.log(id.padEnd(5), 'grade', g.toFixed(2), 'tread', tread, res.join(' '));
  }
}
