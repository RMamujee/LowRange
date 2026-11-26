// Race-track autopilot: drives laps in high range with speed set by the upcoming bends,
// runs the lap timer, and reports lap times, flips, top airtime and damage.
// usage: node test/race.mjs [ids] [laps] [speedScale]
process.env.MAP = 'race';
const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
const T = await import('../src/terrain.js');
const { ALL_VEHICLES } = await import('../src/specs.js');
const { Vehicle } = await import('../src/vehicle.js');
const { RaceLaps, fmtLap } = await import('../src/race.js');
const { trackFrame } = await import('../src/maps/racetrack.js');
await RAPIER.init();
const H = 1 / 200;
const ids = (process.argv[2] || 'lc70,taco,wrx').split(',');
const laps = +(process.argv[3] || 1);
const vScale = +(process.argv[4] || 1);
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
const terrain = T.buildTerrainPhysics(RAPIER, world, T.generateRocks(), T.generateTrees());
const L = T.TRACK.length;
const health = (c) => `tyre ${c.health.tire.map((x) => x.toFixed(2)).join('/')} susp ${c.health.susp.map((x) => x.toFixed(2)).join('/')} eng ${c.health.engine.toFixed(2)} body ${c.health.body.toFixed(2)} broken ${c.broken.filter(Boolean).length}`;
for (const id of ids) {
  const spec = ALL_VEHICLES.find((v) => v.id === id);
  const S = T.SPAWN;
  const car = new Vehicle(RAPIER, world, spec, terrain, { x: S.x, y: T.heightAt(S.x, S.z) + spec.tire.radius - spec.axleY + 0.2, z: S.z }, S.yaw);
  const d = car.dt; d.range = 'high'; d.fourWD = true; d.autoClutch = true; d.gear = 1;
  const race = new RaceLaps(T.TRACK, T.CHECKPOINTS, id + '-test');
  race.startCountdown(0.5);
  const inp = { throttle: 0, brake: 0, steer: 0 };
  let s = T.CHECKPOINTS[0].s - 13, flips = 0, air = 0, maxAir = 0, maxAirAt = 0, t = 0, resets = 0, stuckT = 0;
  const events = []; const dmg = new Map(); let hPrev = 0; const hsum = () => car.health.tire.reduce((a, b) => a + b) + car.health.susp.reduce((a, b) => a + b) + car.health.body + car.health.engine;
  const vmax = (spec.id === 'wrx' ? 24 : 19) * vScale;
  for (let i = 0; i < (240 * laps) / H; i++) {
    t += H;
    const p = car.chassis.translation();
    if (i % 10 === 0) {
      let bs = s, bd = 1e9; for (let q = s - 6; q < s + 15; q += 0.5) { const f = trackFrame(q); const dd = Math.hypot(f.x - p.x, f.z - p.z); if (dd < bd) { bd = dd; bs = q; } }
      s = bs;
      const v = car.speed();
      const look = trackFrame(s + 5 + Math.abs(v) * 0.6);
      const { heading } = car.attitude();
      let err = Math.atan2(-(look.x - p.x), -(look.z - p.z)) - heading; err = Math.atan2(Math.sin(err), Math.cos(err));
      inp.steer = Math.max(-1, Math.min(1, err * 2.5));
      let k = 0; for (let q = s; q < s + 10 + v * 2; q += 3) k = Math.max(k, Math.abs(trackFrame(q).k));
      const vt = Math.min(vmax, Math.sqrt(5.5 / Math.max(1e-3, k)));
      inp.throttle = v < vt - 1 ? 1 : v < vt ? 0.4 : 0; inp.brake = v > vt + 2 ? 0.6 : 0;
      // simple auto box
      const rpm = d.rpm, e = spec.engine;
      if (rpm > e.redline * 0.9 && d.gear < spec.gears.length) d.gear++;
      else if (rpm < e.peakRpm * 0.45 && d.gear > 1) d.gear--;
      if (car.upsideDown()) { flips++; events.push(`flip@${s.toFixed(0)}`); const f = trackFrame(s); car.reset({ x: f.x, y: T.heightAt(f.x, f.z) + 2, z: f.z }, Math.atan2(-f.tx, -f.tz)); race.teleported(); }
      stuckT = Math.abs(v) < 0.5 && race.racing ? stuckT + 10 * H : 0;
      if (stuckT > 6) { resets++; stuckT = 0; const r = race.poseForReset(); car.reset({ x: r.x, y: T.heightAt(r.x, r.z) + 1, z: r.z }, r.yaw); s = r.s; race.teleported(); d.gear = 1; }
    }
    car.step(race.holding ? { throttle: 0, brake: 1, steer: 0, handbrake: true } : inp, H);
    const grounded = car.wheelState.some((w) => w.grounded);
    air = grounded ? 0 : air + H; if (air > maxAir) { maxAir = air; maxAirAt = s; }
    for (const e of race.update(H, car.chassis.translation(), car.chassis.linvel())) {
      if (e.type === 'lap') events.push(`lap${e.lap} ${fmtLap(e.time)}`);
      if (e.type === 'missed' || e.type === 'wrongway') events.push(`${e.type}${e.cp ?? ''}@${s.toFixed(0)}`);
    }
    if (i % 20 === 0) { const hs = hsum(); if (hPrev && hs < hPrev - 1e-4) { const b = Math.round((((s % L) + L) % L) / 10) * 10; dmg.set(b, (dmg.get(b) || 0) + hPrev - hs); } hPrev = hs; }
    if (race.lap > laps) break;
  }
  console.log(`${id.padEnd(5)} ${events.join(' ') || 'no lap'} | t ${t.toFixed(0)}s lap${race.lap} next cp${race.next} s=${(((s % L) + L) % L).toFixed(0)} flips ${flips} resets ${resets} maxAir ${maxAir.toFixed(2)}s@${maxAirAt.toFixed(0)} | ${health(car)}`);
  if (process.env.DMG) console.log('   damage by s:', [...dmg].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([b, x]) => b + ':' + x.toFixed(2)).join(' '));
  car.destroy();
}
