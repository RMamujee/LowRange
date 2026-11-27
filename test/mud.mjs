// Deformable mud (src/mud.js + the [mud] blocks in src/vehicle.js), on the Trail Park's Bog Run:
//  1. sinkage grows with load, shrinks when aired down, grows in churned mud (static numbers)
//  2. parked trucks: aired down sinks less, a heavier truck sinks more (simulated)
//  3. a spinning tyre digs and churns, a rolling one only presses a rut
//  4. ruts persist and get deeper with each pass
//  5. a locked 4-Low Cruiser driven steadily crosses the bog; an open-diff 2WD full-throttle attempt bogs
//  6. the mud's damping stays stable in the worst case (deepest dug mud, aired down, heaviest rig)
//  7. parked in the bog with the parking brake on, a truck settles and sits still (no creep, bounce
//     or endless sinking while the mud and the static hold both act on its tyres)
// The Rally Sedan's floor pan comes from src/specs.js (spec.chassis.floor); MUD_SEDAN_FLOOR only
// fills it in for a spec that has none.
//   node test/mud.mjs
process.env.MAP = 'park';
const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
const { generateRocks, generateTrees, buildTerrainPhysics, visualHeightAt, TRAILS, pathPoint } = await import('../src/terrain.js');
const { ALL_VEHICLES } = await import('../src/specs.js');
const { Vehicle } = await import('../src/vehicle.js');
const { staticSinkage, MudField, NODE, MUD, mudDamping } = await import('../src/mud.js');
await RAPIER.init();
const H = 1 / 200;
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const spec = (id, extra = 0) => {
  const s = structuredClone(ALL_VEHICLES.find((v) => v.id === id)); s.chassis.mass += extra;
  if (id === 'wrx' && process.env.MUD_SEDAN_FLOOR && s.chassis.floor === undefined) s.chassis.floor = +process.env.MUD_SEDAN_FLOOR;
  return s;
};
const bog = TRAILS.find((t) => t.name === 'Bog Run');
const [m0, m1] = bog.mud;
const rocks = generateRocks(), trees = generateTrees(rocks);
function newWorld() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
  return { world, terrain: buildTerrainPhysics(RAPIER, world, rocks, trees) };
}
const place = (W, sp, s, lat = 0) => {
  const p = pathPoint(bog, s), x = p.x - p.tz * lat, z = p.z + p.tx * lat;
  return new Vehicle(RAPIER, W.world, sp, W.terrain, { x, y: visualHeightAt(x, z) + sp.tire.radius - sp.axleY + 0.15, z }, Math.atan2(-p.tx, -p.tz));
};
const settle = (car, n = 700) => { for (let i = 0; i < n; i++) car.step({ throttle: 0, brake: 1, steer: 0 }, H); return car.wheelState.reduce((a, w) => a + w.sink, 0) / 4; };

// ---- 1. static numbers
{
  const z1 = staticSinkage(5000, 0.45, 0.3), z2 = staticSinkage(8000, 0.45, 0.3), za = staticSinkage(5000, 0.45, 0.3, true), zc = staticSinkage(5000, 0.45, 0.3, false, 1);
  check(z2 > z1 * 1.2, `static sinkage grows with load: 5 kN ${z1.toFixed(3)} m, 8 kN ${z2.toFixed(3)} m`);
  check(za < z1 * 0.9, `airing down sinks less: ${za.toFixed(3)} m vs ${z1.toFixed(3)} m`);
  check(zc > z1 * 1.3, `churned mud sinks more: ${zc.toFixed(3)} m vs ${z1.toFixed(3)} m`);
}

// ---- 2. parked in the bog
{
  const s = bog.length * 0.45, res = {};
  for (const [name, sp, aired] of [['stock', spec('lc70'), false], ['aired', spec('lc70'), true], ['heavy', spec('lc70', 800), false]]) {
    const W = newWorld(), car = place(W, sp, s);
    car.airedDown = aired;
    res[name] = settle(car);
  }
  console.log(`     parked Cruiser sinkage: stock ${res.stock.toFixed(3)} m, aired down ${res.aired.toFixed(3)} m, +800 kg ${res.heavy.toFixed(3)} m`);
  check(res.aired < res.stock * 0.9, 'aired down sinks less than at road pressure');
  check(res.heavy > res.stock * 1.12, 'a heavier truck sinks deeper');
}

// ---- 3. spinning digs, rolling presses (on the field directly, one tyre for 2 s)
{
  const W = newWorld(), f = W.terrain.mud, p = pathPoint(bog, bog.length * 0.6), out = {};
  const run = (x, z, slip) => { for (let i = 0; i < 400; i++) f.work(x, z, p.tx, p.tz, 0.3, 0.5, 0.15, slip ? 0.2 : 1.0, slip, H); return f.sample(x, z, out) && { ...out }; };
  const a = run(p.x - p.tz * 1.5, p.z + p.tx * 1.5, 0), b = run(p.x + p.tz * 1.5, p.z - p.tx * 1.5, 4);
  console.log(`     rolling: rut ${a.r.toFixed(3)} dug ${a.e.toFixed(3)} churn ${a.w.toFixed(2)}; spinning 4 m/s: rut ${b.r.toFixed(3)} dug ${b.e.toFixed(3)} churn ${b.w.toFixed(2)}`);
  check(a.r > 0.1 && a.e === 0, 'a rolling tyre presses a rut without digging');
  check(b.e > 0.15 && b.r > a.r + 0.1 && b.w > a.w, 'a spinning tyre digs a deeper hole and churns the mud');
}

// ---- autopilot along the bog: steer down the centreline (lateral offset lat), speed-held throttle
function drive(car, s0, s1, secs, mode) {
  let s = s0, best = s0, thr = 0, stuckT = 0, maxSink = 0;
  for (let i = 0; i < secs / H; i++) {
    if (i % 20 === 0) {
      const p = car.chassis.translation();
      let bs = s, bd = 1e9; for (let q = Math.max(0, s - 8); q < Math.min(bog.length, s + 16); q += 0.5) { const pp = pathPoint(bog, q), dd = Math.hypot(pp.x - p.x, pp.z - p.z); if (dd < bd) { bd = dd; bs = q; } }
      s = bs; best = Math.max(best, s);
      const lk = pathPoint(bog, Math.min(bog.length, s + 4 + car.spec.wheelbase));
      let err = Math.atan2(-(lk.x - p.x), -(lk.z - p.z)) - car.attitude().heading; err = Math.atan2(Math.sin(err), Math.cos(err));
      const v = car.speed();
      if (mode === 'floor') thr = 1;
      else thr = v < 0.8 ? Math.min(0.75, thr + 0.03) : v > 2.0 ? Math.max(0.1, thr - 0.05) : thr; // steady: no stabbing the throttle
      car._inp = { throttle: thr, brake: 0, steer: Math.max(-1, Math.min(1, err * 2.2)) };
      stuckT = Math.abs(v) < 0.15 ? stuckT + 0.1 : 0;
      maxSink = Math.max(maxSink, ...car.wheelState.map((w) => w.sink));
      if (s >= s1 || stuckT > 12) break;
    }
    car.step(car._inp, H);
  }
  return { best, maxSink, stuck: stuckT > 12 };
}

// ---- 4. ruts persist and deepen pass by pass
{
  const W = newWorld(), f = W.terrain.mud, s0 = bog.length * (m0 + 0.04), s1 = s0 + 14, out = {};
  // sample points under the left wheel track part way along
  const probe = () => { let r = 0; for (let k = 0; k < 10; k++) { const q = s0 + 4 + k * 0.6, p = pathPoint(bog, q); let m = 0; for (let l = -1.2; l <= 0; l += NODE / 2) { f.sample(p.x - p.tz * l, p.z + p.tx * l, out); m = Math.max(m, out.r); } r += m; } return r / 10; };
  const depths = [];
  for (let pass = 0; pass < 3; pass++) {
    const car = place(W, spec('lc70'), s0 - 3);
    const d = car.dt; d.range = 'low'; d.gear = 1; d.lockF = d.lockR = true; car.airedDown = true;
    settle(car, 200);
    drive(car, s0 - 3, s1, 30, 'steady');
    car.destroy();
    depths.push(probe());
  }
  for (let i = 0; i < 400; i++) W.world.step(); // time passes
  const later = probe();
  console.log(`     rut depth under the left track after passes 1-3: ${depths.map((x) => x.toFixed(3)).join(', ')} m; later ${later.toFixed(3)} m`);
  check(depths[0] > 0.05, 'the first pass leaves a rut');
  check(depths[1] > depths[0] + 0.003 && depths[2] > depths[1], 'each pass deepens it');
  check(Math.abs(later - depths[2]) < 1e-6, 'ruts persist');
}

// ---- 5. crossing the bog
{
  const s0 = bog.length * m0 - 4, s1 = bog.length * m1 + 2;
  const runs = [
    ['Cruiser, 4-Low, lockers, aired down, steady', 'lc70', (car) => { const d = car.dt; d.range = 'low'; d.gear = 1; d.lockF = d.lockR = true; car.airedDown = true; }, 'steady', 220],
    ['Cruiser, 2WD, open diffs, high range, full throttle', 'lc70', (car) => { const d = car.dt; d.range = 'high'; d.gear = 1; d.fourWD = false; d.lockF = d.lockR = false; }, 'floor', 120],
  ];
  const res = [];
  for (const [name, id, setup, mode, secs] of runs) {
    const W = newWorld(), car = place(W, spec(id), s0);
    setup(car); settle(car, 200);
    const r = drive(car, s0, s1, secs, mode);
    res.push(r);
    console.log(`     ${name}: ${(r.best - s0).toFixed(0)}/${(s1 - s0).toFixed(0)} m${r.stuck ? ' (stuck)' : ''}, deepest sinkage ${r.maxSink.toFixed(2)} m`);
  }
  { // the Rally Sedan, driven as well as it can be (AWD, aired down, steady): reported, not judged
    const W = newWorld(), car = place(W, spec('wrx'), s0);
    car.airedDown = true; car.dt.gear = 1; settle(car, 200);
    const r = drive(car, s0, s1, 160, 'steady');
    console.log(`     Rally Sedan, AWD, aired down, steady (floor ${car.spec.chassis.floor ?? 'frame box'}): ${(r.best - s0).toFixed(0)}/${(s1 - s0).toFixed(0)} m${r.stuck ? ' (stuck)' : ''}, deepest sinkage ${r.maxSink.toFixed(2)} m`);
  }
  check(res[0].best >= s1 - 0.5, 'a locked 4-Low Cruiser driven steadily crosses the bog');
  check(res[1].best < s1 - 10 && res[1].stuck, 'an open-diff 2WD full-throttle attempt bogs down');
}
// ---- 6. damping stability, worst case. The game always steps physics at a fixed 1/200 s.
{
  let worst = 0;
  for (const v of ALL_VEHICLES) {
    const t = v.tire, bw = t.width * MUD.WIDE_AIRED, A = bw * (MUD.LEN * Math.sqrt(2 * t.radius * 0.7) + MUD.FLAT_AIRED); // deepest sinkage, aired down
    worst = Math.max(worst, (mudDamping(A, t.mass, H) * H) / t.mass);
  }
  check(worst <= MUD.DAMP_MAX + 1e-9, `explicit mud damping c h / m at most ${worst.toFixed(2)} (stable below 2)`);
  // the heaviest rig, aired down, dropped into fully churned deep mud (softest: deepest sinkage,
  // biggest footprint) and into mud dug out to the floor: it settles. Measured as how far each
  // wheel still moves up and down over the last second (the solver's own micro-jitter on firm
  // ground is 1-4 mm; a damping instability would grow to centimetres and blow up).
  const p = pathPoint(bog, bog.length * 0.5);
  for (const [name, slip, roll] of [['churned', 0, 100], ['dug-out', 20, 0]]) {
    const W = newWorld(), f = W.terrain.mud;
    for (let a = -3; a <= 3; a += 0.15) for (let l = -1.5; l <= 1.5; l += 0.15) f.work(p.x + p.tx * a - p.tz * l, p.z + p.tz * a + p.tx * l, p.tx, p.tz, 0.2, 0.2, 0.15, roll, slip, 0.5);
    const car = place(W, spec('lc70', 800), bog.length * 0.5);
    car.airedDown = true;
    const lo = [1e9, 1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9, -1e9];
    let ok = true;
    for (let i = 0; i < 800; i++) {
      car.step({ throttle: 0, brake: 1, steer: 0 }, H);
      car.wheels.forEach((w, k) => { const y = w.translation().y; if (!Number.isFinite(y)) ok = false; if (i >= 600) { lo[k] = Math.min(lo[k], y); hi[k] = Math.max(hi[k], y); } });
    }
    const sink = car.wheelState.reduce((a, w) => a + w.sink, 0) / 4, move = Math.max(...hi.map((h, k) => h - lo[k]));
    console.log(`     +800 kg Cruiser aired down in ${name} mud: sinkage ${sink.toFixed(3)} m, wheels move ${(move * 1000).toFixed(1)} mm over the last second`);
    check(ok && move < 0.006, `settles without oscillating (${name})`);
  }
}
// ---- 7. parked in the bog (a 10% grade here) with the parking brake on, in neutral, for 20 s,
// after rolling to a stop on the footbrake (the drop from the spawn height settles first)
{
  const W = newWorld(), car = place(W, spec('lc70'), bog.length * 0.45);
  car.dt.gear = 0;
  settle(car, 1000);
  const inp = { throttle: 0, brake: 0, steer: 0, handbrake: true };
  let p5 = null, y10 = 0, ok = true, yLo = 1e9, yHi = -1e9;
  for (let i = 0; i < 20 / H; i++) {
    car.step(inp, H);
    const p = car.chassis.translation();
    if (!Number.isFinite(p.y)) { ok = false; break; }
    if (i === 5 / H) p5 = { ...p };
    if (i === 10 / H) y10 = p.y;
    if (i >= 15 / H) { yLo = Math.min(yLo, p.y); yHi = Math.max(yHi, p.y); }
  }
  const p = car.chassis.translation(), creep = Math.hypot(p.x - p5.x, p.z - p5.z), sank = y10 - p.y, sink = car.wheelState.reduce((a, w) => a + w.sink, 0) / 4;
  console.log(`     parked Cruiser on the 10% bog, parking brake, 20 s: sinkage ${sink.toFixed(3)} m, creep after 5 s ${(creep * 1000).toFixed(1)} mm, sank ${(sank * 1000).toFixed(1)} mm from 10 to 20 s, bounce over the last 5 s ${((yHi - yLo) * 1000).toFixed(1)} mm`);
  check(ok && creep < 0.02 && Math.abs(sank) < 0.01 && yHi - yLo < 0.005, 'parked in the bog it settles and sits still');
}
console.log(fails ? `${fails} FAILED` : 'all mud checks passed');
process.exit(fails ? 1 : 0);
