// Synthetic: chamfered ledge (like terrain.js ledge()) on a grade, simulated by tilting gravity.
// usage: node test/ledgegrade.mjs <ids> <grades comma> <heights comma (m)>
import RAPIER from '@dimforge/rapier3d-compat';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H = 1 / 200;
const ids = (process.argv[2] || 'lc70,taco,wrx').split(',');
const grades = (process.argv[3] || '0,0.2,0.35,0.5').split(',').map(Number);
const heights = (process.argv[4] || '0.3,0.4,0.5,0.6').split(',').map(Number);
for (const id of ids) {
  const spec = ALL_VEHICLES.find((v) => v.id === id);
  for (const g of grades) {
    const res = [];
    for (const top of heights) {
      const a = Math.atan(g);
      const world = new RAPIER.World({ x: 0, y: -9.81 * Math.cos(a), z: 9.81 * Math.sin(a) }); world.timestep = H; world.numSolverIterations = 8;
      const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUP_WORLD));
      const rockHandles = new Set();
      // ledge slab: top `top` above ground, depth 2, chamfered faces like terrain.js
      const hw = 4, hd = 1, Hh = top + 0.6, pts = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) { pts.push(sx * hw, Hh / 2, sz * hd); pts.push(sx * hw, -Hh / 2, sz * (hd + Hh * 0.7)); }
      const c = world.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(pts)).setTranslation(0, Hh / 2 - 0.6, -6).setFriction(1).setCollisionGroups(GROUP_WORLD));
      rockHandles.add(c.handle);
      const car = new Vehicle(RAPIER, world, spec, { ground, rockHandles }, { x: 0, y: spec.tire.radius - spec.axleY + 0.05, z: 0 }, 0);
      car.airedDown = true; const d = car.dt; d.range = spec.ranges.low ? 'low' : 'high'; d.gear = 1; d.lockF = spec.lockers.front; d.lockR = true;
      const inp = { throttle: 0, brake: 1, steer: 0 };
      for (let i = 0; i < 200; i++) car.step(inp, H);
      inp.brake = 0;
      let ok = false;
      for (let i = 0; i < 30 / H; i++) {
        if (i % 20 === 0) { const v = car.speed(); inp.throttle = v < 0.6 ? Math.min(0.6, inp.throttle + 0.02) : v > 1.6 ? Math.max(0.05, inp.throttle - 0.05) : inp.throttle; }
        car.step(inp, H);
        if (car.chassis.translation().z < -6 - hd - spec.wheelbase - 1) { ok = true; break; }
      }
      res.push(`${top}:${ok ? 'OK' : 'x'}`);
      world.free();
    }
    console.log(id.padEnd(5), 'grade', g.toFixed(2), res.join(' '));
  }
}
