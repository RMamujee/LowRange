// Sunfall Basin autopilot (the crawls run in test/trails.mjs: MAP=desert node test/trails.mjs ...).
//   tracks: every graded desert track end to end (the Basin Loop one full lap) in high range at
//           speed, speed set by the bends ahead and eased over crests, with a simple automatic box
//   dunes:  the Saffron Sea Crossing with dune technique: aired down, high range, momentum up the
//           windward faces, ease off before a brink so the rig doesn't launch off the slip face,
//           straight down the slip face on the brakes, feather the throttle when the tyres spin; if
//           it bogs on a face it backs down 25 m and has another go with a longer run-up
// Reports time, average speed, airtime, retries, resets and damage per rig.
// usage: node test/desert.mjs [tracks|dunes|all] [rigs=lc70,taco,wrx] [airedDown=1]
process.env.MAP = 'desert';
const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
const T = await import('../src/terrain.js');
const { ALL_VEHICLES } = await import('../src/specs.js');
const { Vehicle } = await import('../src/vehicle.js');
await RAPIER.init();
const H = 1 / 200;
const what = process.argv[2] || 'all';
const rigs = (process.argv[3] || 'lc70,taco,wrx').split(',');
const aired = (process.argv[4] ?? '1') === '1';
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
const terrain = T.buildTerrainPhysics(RAPIER, world, T.generateRocks(), T.generateTrees());
const health = (c) => `tyres ${c.health.tire.map((x) => x.toFixed(2)).join('/')} susp ${c.health.susp.map((x) => x.toFixed(2)).join('/')} body ${c.health.body.toFixed(2)}${c.broken.some(Boolean) ? ' BROKEN' : ''}`;
const wrap = (p, s) => (p.closed ? ((s % p.length) + p.length) % p.length : Math.max(0, Math.min(p.length, s)));
const at = (p, s) => T.pathPoint(p, wrap(p, s));
let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

function heading(p, s, d = 5) { const a = at(p, s - d), b = at(p, s + d); return Math.atan2(b.x - a.x, b.z - a.z); }
function curv(p, s) { let d = heading(p, s + 5) - heading(p, s - 5); d = Math.atan2(Math.sin(d), Math.cos(d)); return Math.abs(d) / 10; }

function drive(spec, path, { dunes = false, secs = 600, s0 = 2 } = {}) {
  const p0 = at(path, s0);
  const car = new Vehicle(RAPIER, world, spec, terrain, { x: p0.x, y: T.heightAt(p0.x, p0.z) + spec.tire.radius - spec.axleY + 0.3, z: p0.z }, Math.atan2(-p0.tx, -p0.tz));
  const d = car.dt; d.autoClutch = true; d.range = 'high'; d.fourWD = true; d.gear = 1;
  if (dunes) { car.airedDown = aired; d.lockF = !!spec.lockers.front; d.lockR = !!spec.lockers.rear; }
  const inp = { throttle: 0, brake: 0, steer: 0 };
  const goal = path.closed ? path.length + s0 - 4 : path.length - 4;
  let s = s0, sRun = s0, t = 0, air = 0, maxAir = 0, resets = 0, retries = 0, stuck = 0, flips = 0, backing = 0, backTo = 0, maxV = 0, extra = 0;
  const vmax = dunes ? 13 : spec.id === 'wrx' ? 25 : 20;
  for (let i = 0; i < secs / H; i++) {
    t += H;
    const p = car.chassis.translation();
    if (i % 10 === 0) {
      // progress along the path (unwrapped arc length)
      let bs = sRun, bd = 1e9; for (let q = sRun - 8; q < sRun + 20; q += 0.5) { const f = at(path, q); const dd = Math.hypot(f.x - p.x, f.z - p.z); if (dd < bd) { bd = dd; bs = q; } }
      sRun = bs; s = Math.max(s, sRun);
      const v = car.speed(); maxV = Math.max(maxV, v);
      const look = at(path, sRun + (backing ? -6 : 5 + Math.abs(v) * 0.5));
      const att = car.attitude();
      let err = Math.atan2(-(look.x - p.x), -(look.z - p.z)) - att.heading; err = Math.atan2(Math.sin(err), Math.cos(err));
      if (backing) err = Math.atan2(Math.sin(err + Math.PI), Math.cos(err + Math.PI));
      inp.steer = Math.max(-1, Math.min(1, (backing ? -1 : 1) * err * 2.4));
      let vt = vmax;
      if (!dunes) {
        let k = 0; for (let q = sRun; q < sRun + 12 + v * 2.2; q += 3) k = Math.max(k, curv(path, q));
        vt = Math.min(vmax, Math.sqrt(5.0 / Math.max(1e-3, k)));
        // crests: the ground falling away ahead faster than the road climbs into it
        const hNow = T.heightAt(p.x, p.z), a1 = at(path, sRun + 8), a2 = at(path, sRun + 20);
        if (T.heightAt(a1.x, a1.z) - hNow > 0.6 && T.heightAt(a2.x, a2.z) < T.heightAt(a1.x, a1.z) - 1.0) vt = Math.min(vt, 13);
        // whoops (marked on the road): a sensible driver takes them at about 40 km/h
        const sw = wrap(path, sRun);
        if ((path.whoops || []).some(([a, b]) => sw > a - 10 - v * 1.5 && sw < b)) vt = Math.min(vt, 11);
      } else {
        // dune technique: read the next 30 m of the route
        const hNow = T.heightAt(p.x, p.z);
        let drop = 0, climb = 0;
        for (let q = 4; q <= 30; q += 2) { const f = at(path, sRun + q), dh = T.heightAt(f.x, f.z) - hNow; drop = Math.min(drop, dh / q); climb = Math.max(climb, dh / q); }
        const f6 = at(path, sRun + 6), g6 = (T.heightAt(f6.x, f6.z) - hNow) / 6;
        const onSlip = g6 < -0.35;                                   // going down a slip face
        // the next brink: where the route first tips down steeper than 17°; arrive there at a
        // walking pace (braking at about 2.5 m/s² on sand), so the rig rolls over, not off
        let db = Infinity;
        for (let q = 2; q <= 44; q += 2) { const a = at(path, sRun + q), b = at(path, sRun + q + 4); if ((T.heightAt(b.x, b.z) - T.heightAt(a.x, a.z)) / 4 < -0.3) { db = q; break; } }
        vt = onSlip ? 3.5 : Math.min(climb > 0.08 ? 13 : 9, Math.sqrt(3.5 ** 2 + 2 * 2.5 * Math.max(0, db - 3)));
      }
      if (backing) {
        inp.throttle = 0.6; inp.brake = 0; d.gear = -1;
        if (sRun <= backTo || backing > 9) { backing = 0; d.gear = 1; extra += 8; }
        else backing += 10 * H;
      } else {
        const spin = Math.max(...car.wheelState.map((w) => w.slip || 0));
        const want = v < vt - 1 ? 1 : v < vt ? 0.45 : 0;
        inp.throttle = spin > 3.5 ? Math.max(0.35, Math.min(want, inp.throttle - 0.05)) : want;
        inp.brake = v > vt + 1.5 ? Math.min(1, (v - vt) * 0.25) : 0;
        if (d.gear < 1) d.gear = 1;
        const e = spec.engine;
        if (d.rpm > e.redline * 0.88 && d.gear < spec.gears.length) d.gear++;
        else if (d.rpm < e.peakRpm * 0.42 && d.gear > 1) d.gear--;
      }
      if (car.upsideDown()) { flips++; const f = at(path, sRun); car.reset({ x: f.x, y: T.heightAt(f.x, f.z) + 2, z: f.z }, Math.atan2(-f.tx, -f.tz)); d.gear = 1; }
      // stuck: on the dunes, back down and retry with a run-up; on a track, a reset
      stuck = Math.abs(v) < 0.4 && !backing ? stuck + 10 * H : 0;
      if (stuck > 5) {
        stuck = 0;
        if (dunes && retries < 6) { retries++; backing = 0.01; backTo = sRun - 25 - extra; }
        else { resets++; const f = at(path, sRun + 6); car.reset({ x: f.x, y: T.heightAt(f.x, f.z) + 1, z: f.z }, Math.atan2(-f.tx, -f.tz)); d.gear = 1; sRun += 6; }
      }
      if (sRun >= goal) break;
    }
    car.step(inp, H);
    const grounded = car.wheelState.some((w) => w.grounded);
    air = grounded ? 0 : air + H; maxAir = Math.max(maxAir, air);
  }
  const res = { done: sRun >= goal, s: Math.min(sRun, goal), t, avg: Math.min(sRun, goal) / t, maxV, maxAir, resets, retries, flips, health: health(car), healthy: !car.broken.some(Boolean) && car.health.body > 0.6 };
  car.destroy();
  return res;
}

if (what === 'tracks' || what === 'all') {
  console.log('Tracks (high range, at speed)');
  for (const id of rigs) {
    const spec = ALL_VEHICLES.find((v) => v.id === id);
    for (const r of T.ROADS) {
      const res = drive(spec, r, { secs: r.length / 4 + 60 });
      console.log(`  ${id.padEnd(5)} ${r.name.padEnd(13)} ${res.done ? 'done' : 'STOPPED'} ${(res.s / 1000).toFixed(2)} km in ${res.t.toFixed(0)} s, avg ${(res.avg * 3.6).toFixed(0)} km/h, top ${(res.maxV * 3.6).toFixed(0)} km/h, airtime ${res.maxAir.toFixed(2)} s, resets ${res.resets}, flips ${res.flips}, ${res.health}`);
      check(res.done && res.resets === 0 && res.flips === 0 && res.healthy, `${id} drives ${r.name} end to end without help or damage`);
    }
  }
}
if (what === 'dunes' || what === 'all') {
  const route = T.TRAILS.find((t) => !t.graded);
  console.log(`${route.name} (${route.length.toFixed(0)} m), ${aired ? 'aired down' : 'aired up'}, high range`);
  for (const id of rigs) {
    const spec = ALL_VEHICLES.find((v) => v.id === id);
    const res = drive(spec, route, { dunes: true, secs: 420 });
    console.log(`  ${id.padEnd(5)} ${res.done ? 'done' : 'STOPPED'} at ${res.s.toFixed(0)}/${route.length.toFixed(0)} m in ${res.t.toFixed(0)} s, top ${(res.maxV * 3.6).toFixed(0)} km/h, airtime ${res.maxAir.toFixed(2)} s, retries ${res.retries}, resets ${res.resets}, flips ${res.flips}, ${res.health}`);
    if (aired && (id === 'lc70' || id === 'taco')) check(res.done && res.resets === 0 && res.flips === 0, `${id} completes the dune route aired down (retries allowed)`);
  }
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
