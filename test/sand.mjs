// Deep sand (src/deepsand.js) on Sunfall Basin's Practice Dune: a straight 15° (27%) windward face
// of deep sand, 13 m tall, with a flat apron of deep sand along its toe. For each rig, aired down
// and aired up:
//   standing start: from rest on the sand at the toe in first, throttle fed in and eased off
//                   whenever the tyres spin up
//   run-up:         from rest 75 m back on the firm desert floor, flat out at the face
//   bog:            from rest on the flat apron along the toe, 12 s pedal down: in low-range
//                   first (all the torque, the tyres just spin) vs in high second (pedal down,
//                   or fed in and eased off a spinning tyre: the better of the two)
// and asserts the dune-driving rules for the Cruiser and the Pickup: aired down walks up the face
// from a standstill; aired up it bogs on the face from rest but makes the top with a run-up;
// spinning the tyres in deep sand digs them in: deeper and less far than the taller gear.
// Parked across the fall line (every rig, aired up and down): flat sand and the 15° face hold to
// the millimetre over 30 s, a ~22° face holds aired down and slides aired up, the 32° slip face
// slides away (see the parked section below for why).
// usage: node test/sand.mjs [rigs=lc70,taco,wrx]   (PARK_ONLY=1: just the parked cases)
process.env.MAP = 'desert';
const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
const T = await import('../src/terrain.js');
const D = await import('../src/maps/desert.js');
const S = await import('../src/spawns.js');
const { PRACTICE } = D;
const { ALL_VEHICLES } = await import('../src/specs.js');
const { Vehicle } = await import('../src/vehicle.js');
await RAPIER.init();
const H = 1 / 200;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
const terrain = T.buildTerrainPhysics(RAPIER, world, T.generateRocks(), T.generateTrees());
const P = PRACTICE, [dx, dz] = P.dir, top = P.len * P.grade;
const at = (a, c = 0) => ({ x: P.x + dx * a - dz * c, z: P.z + dz * a + dx * c });
const frame = (p) => ({ a: (p.x - P.x) * dx + (p.z - P.z) * dz, c: -(p.x - P.x) * dz + (p.z - P.z) * dx });
// a ~22° face of deep sand for the mid parking case: the first spot on a fixed search lattice over
// the dune sea where a plane fitted under a truck's footprint (across the fall line) is 21-23°
// and smooth (src/spawns.js checkSpot), the sand fully deep
const MID22 = (() => {
  const { checkSpot, FOOT } = S;
  for (let k = 0; k < 20000; k++) {
    const x = D.ERG.x + ((k * 7919) % 401 - 200) * 1.25, z = D.ERG.z + ((k * 104729) % 361 - 180) * 1.25;
    if (T.materialAt(x, z) !== T.MAT.SAND || T.sandDepthAt(x, z) < 0.95) continue;
    const e = 1.5, gx = (T.heightAt(x + e, z) - T.heightAt(x - e, z)) / (2 * e), gz = (T.heightAt(x, z + e) - T.heightAt(x, z - e)) / (2 * e), g = Math.hypot(gx, gz);
    if (g < 0.37 || g > 0.43) continue;
    const yaw = Math.atan2(gz / g, -gx / g), r = checkSpot(x, z, yaw, [], FOOT, { grade: Infinity, rough: 0.06 });
    if (r.ok && r.grade > 0.385 && r.grade < 0.425) return { x, z, deg: Math.atan(r.grade) * 57.3 };
  }
  throw new Error('no ~22° deep-sand face found');
})();
let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

// one run. up: drive up the face along the line c = c0; across: along the toe (a = a0) towards +c.
function run(spec, { aired, a0, c0 = 0, across = false, throttle, gear2 = false, secs = 40 }) {
  const p0 = at(a0, c0), yaw = across ? Math.atan2(dz, -dx) : Math.atan2(-dx, -dz);
  const car = new Vehicle(RAPIER, world, spec, terrain, { x: p0.x, y: T.heightAt(p0.x, p0.z) + spec.tire.radius - spec.axleY + 0.3, z: p0.z }, yaw);
  car.airedDown = aired;
  const d = car.dt; d.autoClutch = true; d.fourWD = true; d.lockF = !!spec.lockers.front; d.lockR = !!spec.lockers.rear;
  // dune gearing: high range (low range only multiplies wheelspin); first up a face or for the
  // run-up, second pulling away on the flat (first's torque just spins the tyres there)
  const minGear = throttle === 'floor2' || gear2 ? 2 : 1;
  d.range = throttle === 'floor' && spec.ranges.low ? 'low' : 'high'; d.gear = minGear;
  const inp = { throttle: 0, brake: 0, steer: 0 };
  const h0 = T.heightAt(P.x, P.z);
  let best = 0, tTop = null, sinkMax = 0, slipT = 0;
  for (let i = 0; i < secs / H; i++) {
    const p = car.chassis.translation();
    if (i % 10 === 0) {
      const f = frame(p), { heading } = car.attitude();
      const lk = across ? at(a0, f.c + 12) : at(f.a + 12, c0);
      let err = Math.atan2(-(lk.x - p.x), -(lk.z - p.z)) - heading; err = Math.atan2(Math.sin(err), Math.cos(err));
      inp.steer = Math.max(-1, Math.min(1, err * 2.2));
      // 'smooth' feeds it in and eases off when the tyres spin (a driver feathering the throttle);
      // 'full' is flat out but still eases off a spinning tyre; 'floor' is pedal down no matter what
      const spin = Math.max(...car.wheelState.map((w) => w.slip || 0));
      if (throttle === 'floor' || throttle === 'floor2') inp.throttle = 1;
      else if (spin > 3) inp.throttle = Math.max(0.35, inp.throttle - 0.03);
      else inp.throttle = Math.min(throttle === 'smooth' ? 0.7 : 1, inp.throttle + 0.02);
      const e = spec.engine;
      if (d.rpm > e.redline * 0.88 && d.gear < 4) d.gear++;
      else if (d.rpm < e.peakRpm * 0.42 && d.gear > minGear) d.gear--;
      best = Math.max(best, across ? f.c - c0 : Math.min(top, p.y - spec.tire.radius - h0 + 0.45));
      if (!across && f.a > P.len + 1) { tTop = i * H; break; }
    }
    if (car.deepSand) sinkMax = Math.max(sinkMax, ...car.deepSand.sink);
    if (car.wheelState.some((w) => w.slip > 2)) slipT += H;
    car.step(inp, H);
  }
  const res = { best, tTop, sinkMax, slipT, flipped: car.upsideDown() };
  car.destroy();
  return res;
}

const rigs = (process.argv[2] || 'lc70,taco,wrx').split(',');
const fmt = (r) => (r.tTop !== null ? `TOP in ${r.tTop.toFixed(1)} s` : `stopped at ${r.best.toFixed(1)}/${top.toFixed(1)} m`) + ` (max sink ${(r.sinkMax * 100).toFixed(0)} cm, spinning ${r.slipT.toFixed(1)} s)`;
console.log(`Practice Dune: ${top.toFixed(1)} m on a ${(Math.atan(P.grade) * 57.3).toFixed(0)}° face, sand depth ${T.sandDepthAt(at(10).x, at(10).z).toFixed(2)}`);
for (const id of rigs) {
  const spec = ALL_VEHICLES.find((v) => v.id === id);
  console.log(spec.name);
  const R = {};
  if (!process.env.PARK_ONLY) { // (PARK_ONLY=1: only the parked cases, a few seconds)
  for (const aired of [true, false]) {
    const tag = aired ? 'aired down' : 'aired up  ';
    R[`stand${aired}`] = run(spec, { aired, a0: -3, throttle: 'full' });
    console.log(`  ${tag} standing start: ${fmt(R[`stand${aired}`])}`);
    R[`run${aired}`] = run(spec, { aired, a0: -75, throttle: 'full' });
    console.log(`  ${tag} run-up:         ${fmt(R[`run${aired}`])}`);
  }
  const bog = { aired: false, a0: -6, c0: -42, across: true, secs: 12 };
  // the spinning start against the better of two sensible ones in high second: pedal down
  // (the petrol pickup wants revs) or fed in and eased off a spinning tyre (the torquey diesel)
  const floor = run(spec, { ...bog, throttle: 'floor' });
  const s2 = [run(spec, { ...bog, throttle: 'floor2' }), run(spec, { ...bog, throttle: 'full', gear2: true })], smooth = s2[0].best >= s2[1].best ? s2[0] : s2[1];
  console.log(`  aired up on the flat apron, 12 s: ${spec.ranges.low ? 'low' : 'high'} first pedal down ${floor.best.toFixed(0)} m (sink ${(floor.sinkMax * 100).toFixed(0)} cm, spinning ${floor.slipT.toFixed(1)} s); high second ${s2[0].best.toFixed(0)} m pedal down, ${s2[1].best.toFixed(0)} m fed in (sink ${(smooth.sinkMax * 100).toFixed(0)} cm, spinning ${smooth.slipT.toFixed(1)} s)`);
  if (id === 'lc70' || id === 'taco') {
    check(R.standtrue.tTop !== null, `${id}: aired down climbs the face from a standstill`);
    check(R.standfalse.tTop === null, `${id}: aired up bogs on the face from a standstill`);
    check(R.runfalse.tTop !== null, `${id}: aired up makes the top with a run-up`);
    check(floor.sinkMax > smooth.sinkMax + 0.04 && floor.best < smooth.best, `${id}: spinning the tyres (low first, pedal down) digs in deeper and gets less far than high second`);
  }
  }
  // Parked (parking brake, neutral) across the fall line on deep sand, aired up and aired down.
  // The static tyre hold works on dune sand inside its sideways grip (about 0.62 x 0.75 x 0.85 =
  // 0.40 of the load aired up, 0.694 x 0.92 x 0.9 = 0.57 aired down; sinkage costs traction, not
  // sideways hold), so flat sand and the 15° face (needs tan 15° = 0.27) hold to the millimetre
  // over 30 s; a ~22° face (tan 22° = 0.40) sits right at the aired-up limit and inside the
  // aired-down one: it holds, at most a few cm of settling; the 32° slip face (0.62) is past both:
  // set down across it, a rig slides away.
  for (const aired of [false, true]) {
    const r = { flat: park(spec, aired, at(-6, 0)), f15: park(spec, aired, at(24, 0)), f22: park(spec, aired, MID22), f32: park(spec, aired, at(P.len + 12, 0), true) };
    const mm = (q) => `${(q.d * 1000).toFixed(1)} mm (${(q.last * 1000).toFixed(1)} in the last 10 s)`;
    console.log(`  parked ${aired ? 'aired down' : 'aired up  '}, 30 s: flat ${mm(r.flat)} | 15° ${mm(r.f15)} | ${MID22.deg.toFixed(0)}° ${mm(r.f22)} | 32° slip face: ended ${r.f32.down.toFixed(1)} m below where it was set down`);
    const tag = `${id} ${aired ? 'aired down' : 'aired up'}`;
    check(r.flat.d < 0.005, `${tag}: parked on flat deep sand it stays put`);
    check(r.f15.d < 0.005, `${tag}: parked across the 15° face it stays put`);
    check(r.f22.d < 0.2, `${tag}: parked across the ${MID22.deg.toFixed(0)}° face it holds (at the limit: a few cm of settling at most)`);
    check(r.f32.down > 3, `${tag}: set down across the 32° slip face it slides away (${r.f32.down.toFixed(1)} m)`);
  }
}
// Parked at a spot { x, z } across the local fall line, as a driver parks there: driven in along the
// contour at a crawl from 16 m back (dropping a level truck straight onto a slope tips it and sets
// it sliding sideways, which is a slide in progress, not parking), stopped on the brakes, then
// left in neutral on the parking brake. Returns how far it moves in the 30 s after a 3 s settle.
function park(spec, aired, s, drop = false) { // drop: set down on the spot instead (to see whether a slope can hold a truck at all)
  const e = 1.5, gx = (T.heightAt(s.x + e, s.z) - T.heightAt(s.x - e, s.z)) / (2 * e), gz = (T.heightAt(s.x, s.z + e) - T.heightAt(s.x, s.z - e)) / (2 * e);
  const g = Math.hypot(gx, gz) || 1, fx = -gz / g, fz = gx / g; // heading across the fall line
  const back = drop ? 0 : 16, x0 = s.x - fx * back, z0 = s.z - fz * back, yaw = Math.atan2(-fx, -fz), lift = S.liftFor({ x: x0, z: z0, yaw }, spec, 0.03);
  const car = new Vehicle(RAPIER, world, spec, terrain, { x: x0, y: T.heightAt(x0, z0) + spec.tire.radius - spec.axleY + lift, z: z0 }, yaw);
  car.airedDown = aired;
  const d = car.dt; d.autoClutch = true; d.fourWD = true; d.range = spec.ranges.low ? 'low' : 'high'; d.gear = 1;
  const drive = { throttle: 0.35, brake: 0, steer: 0, handbrake: false };
  for (let i = 0; i < (drop ? 0 : 12 / H); i++) {
    const p = car.chassis.translation();
    if ((p.x - x0) * fx + (p.z - z0) * fz > 15) break;
    if (i % 10 === 0) { // hold the contour: steer back up towards the line
      const { heading } = car.attitude(), lat = (p.x - s.x) * -fz + (p.z - s.z) * fx;
      let err = yaw - heading + Math.max(-0.4, Math.min(0.4, -lat * 0.1)); err = Math.atan2(Math.sin(err), Math.cos(err));
      drive.steer = Math.max(-1, Math.min(1, err * 2));
    }
    car.step(drive, H);
  }
  for (let i = 0; i < 2 / H; i++) car.step({ throttle: 0, brake: 1, steer: 0, handbrake: true }, H);
  d.gear = 0;
  const hold = { throttle: 0, brake: 0, steer: 0, handbrake: true };
  for (let i = 0; i < 3 / H; i++) car.step(hold, H);
  const p0 = { ...car.chassis.translation() };
  let p20 = null;
  for (let i = 0; i < 30 / H; i++) { car.step(hold, H); if (i === Math.round(20 / H)) p20 = { ...car.chassis.translation() }; }
  const p = car.chassis.translation(), res = { d: Math.hypot(p.x - p0.x, p.z - p0.z), last: Math.hypot(p.x - p20.x, p.z - p20.z), down: -((p.x - s.x) * gx + (p.z - s.z) * gz) / g }; // last: the final 10 s; down: how far below the spot it ended up (it slid off the face while parking or since)
  car.destroy();
  return res;
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
