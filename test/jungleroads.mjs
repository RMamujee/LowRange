// Coralume Island road autopilot: drives every paved road, dirt road, two-track and beach track of
// src/maps/jungle.js end to end with each rig, in high range with a simple automatic gearbox, at a
// speed set by the surface and the bends ahead. Reports per road: done or where it stopped, time,
// average speed, worst roll, flips and the times it had to be put back on the road (a reset after
// 10 s without progress). Exits non-zero if any rig fails to finish a road.
// usage: node test/jungleroads.mjs [ids=lc70,taco,wrx] [road name filter]
process.env.MAP = 'jungle';
const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
const T = await import('../src/terrain.js');
const { ALL_VEHICLES } = await import('../src/specs.js');
const { Vehicle } = await import('../src/vehicle.js');
await RAPIER.init();
const H = 1 / 200;
const ids = (process.argv[2] || 'lc70,taco,wrx').split(',');
const filter = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
const rocks = T.generateRocks();
const terrain = T.buildTerrainPhysics(RAPIER, world, rocks, T.generateTrees(rocks));
const VMAX = { paved: 20, dirt: 12, track: 7, sand: 9 }; // m/s
let failed = 0;
const curv = (r, s) => { const a = T.pathPoint(r, s - 4), b = T.pathPoint(r, s + 4); let d = Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz); d = Math.atan2(Math.sin(d), Math.cos(d)); return Math.abs(d) / 8; };
for (const id of ids) {
  const spec = ALL_VEHICLES.find((v) => v.id === id), res = [];
  for (const r of T.ROADS.filter((q) => !filter || filter.test(q.name))) {
    const L = r.closed ? r.length - 2 : r.length - 4;
    const p0 = T.pathPoint(r, 4);
    const car = new Vehicle(RAPIER, world, spec, terrain, { x: p0.x, y: T.heightAt(p0.x, p0.z) + spec.tire.radius - spec.axleY + 0.4, z: p0.z }, Math.atan2(-p0.tx, -p0.tz));
    const d = car.dt; d.range = 'high'; d.fourWD = true; d.autoClutch = true; d.gear = 1;
    if (r.surface === 'sand') car.airedDown = true;
    const inp = { throttle: 0, brake: 0, steer: 0 };
    let s = 4, best = 4, t = 0, flips = 0, resets = 0, lastBest = 4, lastT = 0, roll = 0, rollAt = 0;
    const vmax = VMAX[r.surface] * (id === 'wrx' && r.surface === 'paved' ? 1.2 : 1);
    for (let i = 0; i < (L / 3 + 60) / H; i++) {
      t += H;
      if (i % 10 === 0) {
        const p = car.chassis.translation();
        let bs = s, bd = 1e9; for (let q = Math.max(0, s - 6); q < Math.min(r.length, s + 15); q += 0.5) { const f = T.pathPoint(r, q); const dd = Math.hypot(f.x - p.x, f.z - p.z); if (dd < bd) { bd = dd; bs = q; } }
        s = bs; best = Math.max(best, s);
        const v = car.speed();
        const look = T.pathPoint(r, Math.min(r.length, s + 5 + Math.abs(v) * 0.6));
        const { heading, roll: rl } = car.attitude(); if (Math.abs(rl) > roll) { roll = Math.abs(rl); rollAt = s; }
        let err = Math.atan2(-(look.x - p.x), -(look.z - p.z)) - heading; err = Math.atan2(Math.sin(err), Math.cos(err));
        inp.steer = Math.max(-1, Math.min(1, err * 2.5));
        let k = 0; for (let q = s; q < Math.min(r.length, s + 10 + v * 2); q += 3) k = Math.max(k, curv(r, q));
        const vt = Math.min(vmax, Math.sqrt(4.5 / Math.max(1e-3, k)));
        inp.throttle = v < vt - 1 ? 1 : v < vt ? 0.4 : 0; inp.brake = v > vt + 2 ? 0.6 : 0;
        const rpm = d.rpm, e = spec.engine;
        if (rpm > e.redline * 0.9 && d.gear < spec.gears.length) d.gear++;
        else if (rpm < e.peakRpm * 0.45 && d.gear > 1) d.gear--;
        if (car.upsideDown()) { flips++; const f = T.pathPoint(r, s); car.reset({ x: f.x, y: T.heightAt(f.x, f.z) + 2, z: f.z }, Math.atan2(-f.tx, -f.tz)); d.gear = 1; }
        if (best > lastBest + 2) { lastBest = best; lastT = t; }
        if (t - lastT > 10) { resets++; lastT = t; const f = T.pathPoint(r, Math.min(L, best + 8)); car.reset({ x: f.x, y: T.heightAt(f.x, f.z) + 1, z: f.z }, Math.atan2(-f.tx, -f.tz)); s = best + 8; d.gear = 1; }
        if (s >= L) break;
      }
      car.step(inp, H);
    }
    const done = s >= L && !resets;
    if (!done) failed++;
    res.push(`${r.name}: ${done ? 'done' : `STOPPED ${best.toFixed(0)}/${r.length.toFixed(0)}`} ${t.toFixed(0)}s ${((best / t) * 3.6).toFixed(0)}km/h roll${(roll * 57.3).toFixed(0)}@${rollAt.toFixed(0)}${flips ? ' flips:' + flips : ''}${resets ? ' resets:' + resets : ''}`);
    car.destroy();
  }
  console.log(`${id.padEnd(5)} ${res.join(' | ')}`);
}
console.log(failed ? `${failed} road run(s) FAILED` : 'every road driven end to end');
process.exit(failed ? 1 : 0);
