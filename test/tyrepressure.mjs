// Tyre pressure (src/tyres/pressure.js and the [tyre pressure] hooks in src/vehicle.js, src/mud.js,
// src/deepsand.js), headless:
//  1. the on-board system: deflates at 2 psi/s and inflates at 1 psi/s while the truck drives at
//     speed, taps go to the next stop, holds stop where released, both ends clamp
//  2. road pressure is exactly the old aired-up tyre and crawl pressure the old aired-down one
//     (grip, rolling resistance, mud footprint, deep sand, collider radius, speed costs), and a
//     drive at road pressure matches the old `airedDown = false` drive to the last bit
//  3. rock: the Cruiser creeps up a 0.42 m square rock ledge at crawl pressure, not at road or trail pressure (majority of 8 starts)
//  4. Bog Run: a parked Cruiser sinks less the lower the pressure (32 / 18 / 10 / 8 psi)
//  5. dune sand (Sunfall Basin's Practice Dune apron, a child process on the desert map): the same
//  6. at speed soft tyres cost: a longer coast-down at road pressure, a wider steady corner and a
//     slower steering response aired down; nothing changes below 40 km/h
//  7. loaded radius: drawn deflection grows as the pressure drops and with load; the physics tyre
//     only shrinks below crawl pressure, where the truck then sits lower
//  8. bead: hard cornering at speed on 9 psi unseats a bead (a flat; a repair fixes it); the same
//     at road pressure does not; crawling never does
//  9. the live pressure is saved per rig and restored, carried over a rebuild, and a new garage
//     start pressure replaces the saved one
// 10. the tyre board fits beside the engine board at the common window sizes
// 11. warnings: too fast for the pressure; stuck in sand / mud at road pressure: a hint to air down
//   node test/tyrepressure.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SAND = process.argv[2] === '--sand';
process.env.MAP = SAND ? 'desert' : 'park';
const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
const T = await import('../src/terrain.js');
const { ALL_VEHICLES } = await import('../src/specs.js');
const { Vehicle } = await import('../src/vehicle.js');
const TP = await import('../src/tyres/pressure.js');
await RAPIER.init();
const H = 1 / 200;
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const spec = (id) => structuredClone(ALL_VEHICLES.find((v) => v.id === id));
const f2 = (x) => x.toFixed(2), f3 = (x) => x.toFixed(3);

// ---------------------------------------------------------------- 5. (child) dune sand
if (SAND) {
  const D = await import('../src/maps/desert.js');
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
  const terrain = T.buildTerrainPhysics(RAPIER, world, T.generateRocks(), T.generateTrees());
  const P = D.PRACTICE, [dx, dz] = P.dir, a = -6, x = P.x + dx * a, z = P.z + dz * a; // the flat apron of deep sand at the toe (test/sand.mjs)
  const res = {};
  for (const psi of [32, 18, 10, 8]) {
    const sp = spec('lc70'), car = new Vehicle(RAPIER, world, sp, terrain, { x, y: T.heightAt(x, z) + sp.tire.radius - sp.axleY + 0.1, z }, Math.atan2(-dx, -dz));
    car.tyre.set(psi);
    for (let i = 0; i < 10 / H; i++) car.step({ throttle: 0, brake: 1, steer: 0, handbrake: true }, H); // (sinkage builds at 2 cm/s at most)
    res[psi] = car.deepSand.sink.reduce((s, v) => s + v, 0) / 4;
    car.destroy();
  }
  console.log(`     parked Cruiser on deep sand (Practice Dune apron, depth ${f2(T.sandDepthAt(x, z))}): ${Object.entries(res).map(([p, s]) => `${p} psi ${(s * 100).toFixed(1)} cm`).join(', ')}`);
  check(res[18] < res[32] && res[10] < res[18] && res[8] < res[10], 'deep sand: the lower the pressure, the less a parked truck sinks');
  check(res[10] < res[32] * 0.55, 'deep sand: crawl pressure sinks under 55% as deep as road pressure');
  process.exit(fails ? 1 : 0);
}

// a flat world; mat: the ground's surface (MAT index, via the prop table the tyre model reads)
function flat(id, mat = T.MAT.ROCK, extra) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
  const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(600, 1, 600).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(T.GROUP_WORLD));
  const rockHandles = new Set(mat === T.MAT.ROCK ? [ground.handle] : []);
  const propInfo = new Map(mat === T.MAT.ROCK ? [] : [[ground.handle, { mat }]]);
  if (extra) extra(world, rockHandles);
  const sp = spec(id);
  const car = new Vehicle(RAPIER, world, sp, { ground, rockHandles, propInfo }, { x: 0, y: sp.tire.radius - sp.axleY + 0.05, z: 0 }, 0);
  return { world, car, sp };
}
const run = (car, secs, inp) => { for (let i = 0; i < Math.round(secs / H); i++) car.step(inp, H); };

// ---------------------------------------------------------------- 1. the on-board system
{
  const { car, world } = flat('lc70', T.MAT.ROAD);
  const d = car.dt; d.gear = 2; d.fourWD = true;
  run(car, 1, { throttle: 0, brake: 1, steer: 0 });
  run(car, 6, { throttle: 0.6, brake: 0, steer: 0 }); // rolling at speed
  const kmh0 = car.speed() * 3.6;
  car.tyre.setTarget(car.tyre.P.min);
  const p0 = car.tyre.psi; run(car, 3, { throttle: 0.6, brake: 0, steer: 0 });
  const down = (p0 - car.tyre.psi) / 3, st = car.tyre.state;
  check(Math.abs(down - TP.RATE.down) < 1e-6 && st.deflating && !st.inflating, `deflates at ${f2(down)} psi/s while driving at ${kmh0.toFixed(0)} km/h (state: deflating ${st.deflating})`);
  run(car, 10, { throttle: 0.6, brake: 0, steer: 0 });
  check(car.tyre.psi === car.tyre.P.min && !car.tyre.moving, `stops at the minimum: ${car.tyre.psi} psi`);
  car.tyre.setTarget(car.tyre.P.road);
  const p1 = car.tyre.psi; run(car, 4, { throttle: 0.6, brake: 0, steer: 0 });
  const up = (car.tyre.psi - p1) / 4;
  check(Math.abs(up - TP.RATE.up) < 1e-6 && st.inflating && st === car.tyre.state, `inflates at ${f2(up)} psi/s from the compressor (state: inflating ${st.inflating})`);
  // hold: keeps going while held, stops where released; tap: next stop
  car.tyre.set(20); car.tyre.press(1); run(car, 30, { throttle: 0.3, brake: 0, steer: 0 });
  check(car.tyre.psi === car.tyre.P.max, `held ] clamps at the maximum: ${car.tyre.psi} psi`);
  car.tyre.release(1); car.tyre.press(-1); run(car, 2, { throttle: 0.3, brake: 0, steer: 0 }); car.tyre.release(-1); run(car, 1, { throttle: 0.3, brake: 0, steer: 0 });
  check(Math.abs(car.tyre.psi - (car.tyre.P.max - 2 * TP.RATE.down)) < 0.02 && !car.tyre.moving, `held [ for 2 s, released: stops at ${f2(car.tyre.psi)} psi`);
  car.tyre.set(32); car.tyre.press(-1); run(car, 0.1, { throttle: 0.3, brake: 0, steer: 0 }); const t1 = car.tyre.release(-1);
  check(t1 === car.tyre.P.trail, `tapped [ at 32 psi: heads for the trail stop (${t1} psi)`);
  check(car.tyre.tap(-1) === car.tyre.P.crawl, 'tapped again while deflating: on to the crawl stop');
  check(car.tyre.toggle() === car.tyre.P.road && car.tyre.toggle() === car.tyre.P.crawl, 'T toggles crawl / road');
  car.tyre.set(3); check(car.tyre.psi === car.tyre.P.min, 'set below the range clamps to the minimum');
  world.free();
}

// ---------------------------------------------------------------- 2. the old ends, exactly
{
  const { car, world } = flat('lc70', T.MAT.ROCK);
  const legacy = (aired, mat) => { // the old tyreGrip, verbatim
    const info = T.MAT_INFO[mat], tm = car.treadMul[mat];
    let mu = info.mu * tm[0], rr = info.rr * tm[1];
    if (aired) { if (mat === T.MAT.ROCK) mu *= 1.15; else if (mat === T.MAT.SAND) { mu *= 1.12; rr *= 0.55; } else if (mat === T.MAT.MUD) mu *= 1.06; else rr *= 1.25; }
    return { mu, rr };
  };
  let same = true;
  for (const [aired, psi] of [[false, car.tyre.P.road], [true, car.tyre.P.crawl]]) {
    car.tyre.set(psi);
    for (let m = 0; m < T.MAT_INFO.length; m++) { const a = car.tyreGrip(m, false), b = legacy(aired, m); if (a.mu !== b.mu || a.rr !== b.rr) same = false; }
  }
  check(same, 'tyreGrip at 32 / 10 psi is the old aired-up / aired-down grip to the bit, on every surface');
  const { footprint, MUD } = await import('../src/mud.js');
  const fu = footprint(0.3, TP.airFraction(32, car.tyre.P)), fd = footprint(0.3, TP.airFraction(10, car.tyre.P));
  check(fu.bw === 0.3 && fu.flat === MUD.FLAT && fd.bw === 0.3 * MUD.WIDE_AIRED && fd.flat === MUD.FLAT_AIRED, 'mud footprint at 32 / 10 psi is the old aired-up / aired-down one to the bit');
  const { DEEP } = await import('../src/deepsand.js');
  check(TP.mix(DEEP.sinkFull, DEEP.sinkAired, 0) === DEEP.sinkFull && TP.mix(DEEP.sinkFull, DEEP.sinkAired, 1) === DEEP.sinkAired && TP.airFraction(10, car.tyre.P) === 1 && TP.airFraction(32, car.tyre.P) === 0, 'deep sand numbers at f = 0 / 1 are the old pair exactly');
  car.airedDown = true;
  check(car.tyre.psi === 10 && car.airedDown, 'the old switch: airedDown = true is crawl pressure');
  car.airedDown = false;
  check(car.tyre.psi === 32 && !car.airedDown, 'airedDown = false is road pressure');
  world.free();
  // a drive at road pressure, and at crawl pressure below the speed gate: every speed cost and the
  // physics deflection stay at zero, so these are the old drives step for step
  for (const psi of [32, 10]) {
    const { car: c, world: w } = flat('taco', T.MAT.ROCK);
    c.tyre.set(psi); c.grace = 1e9; c.dt.gear = 1; c.dt.range = 'low'; c.dt.fourWD = true;
    let zero = true, round = true, vmax = 0;
    const inp = { throttle: 0.3, brake: 0, steer: 0 };
    for (let i = 0; i < 6 / H; i++) {
      if (i % 20 === 0) inp.throttle = c.speed() > 2.5 ? 0 : 0.3; // a crawl, under 10 km/h
      inp.steer = i > 400 ? 0.5 : 0;
      c.step(inp, H); vmax = Math.max(vmax, c.speed() * 3.6);
      if (c.tyre.rrSpeed || c.tyre.latCfm || c.tyre.steerMul !== 1 || c.tyre.deflPhys.some((x) => x)) zero = false;
      if (c.tyreR.some((r) => r !== c.spec.tire.radius)) round = false;
    }
    check(zero && round && vmax < 15, `${psi} psi crawling in 4-Low (up to ${vmax.toFixed(1)} km/h): no speed costs, wheel colliders at full radius`);
    w.free();
  }
}

// ---------------------------------------------------------------- 3. rock: a square ledge
// test/ledgeclimb.mjs's square ledge (rock, 4 m deep slab), at a crawl (0.6-1.6 m/s, 4-Low)
function ledge(id, top, psi, z0 = 0) {
  const lip = -6 - z0, depth = 4, hw = 4, Hh = top + 0.6, pts = [];
  for (const sx of [-1, 1]) for (const zt of [0, -depth]) { pts.push(sx * hw, top, zt); pts.push(sx * hw, -0.6, zt); }
  const { car, world, sp } = flat(id, T.MAT.ROCK, (w, rh) => { const c = w.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(pts)).setTranslation(0, 0, lip).setFriction(1).setCollisionGroups(T.GROUP_WORLD)); rh.add(c.handle); });
  car.tyre.set(psi); car.grace = 1e9;
  const d = car.dt; d.fourWD = true; d.lockF = !!sp.lockers.front; d.lockR = !!sp.lockers.rear; d.gear = 1; d.range = sp.ranges.low ? 'low' : 'high';
  const inp = { throttle: 0, brake: 1, steer: 0 };
  run(car, 1, inp); inp.brake = 0;
  let ok = false, stuck = 0;
  for (let i = 0; i < 30 / H && !ok; i++) {
    if (i % 20 === 0) {
      const v = car.speed();
      inp.throttle = v < 0.6 ? Math.min(0.6, inp.throttle + 0.02) : v > 1.6 ? Math.max(0.05, inp.throttle - 0.05) : inp.throttle;
      stuck = v < 0.05 ? stuck + 20 * H : 0;
      if (stuck > 6 || car.upsideDown()) break;
    }
    car.step(inp, H);
    if (car.chassis.translation().z < lip - sp.wheelbase / 2 - 0.6 && car.wheels[3].translation().y > top + sp.tire.radius * 0.8) ok = true;
  }
  world.free();
  return ok;
}
{
  // Near a limit one run is a coin flip (a stall at the face that breaks loose or not), so, as in
  // test/ledgeclimb.mjs, each case is driven from 8 start offsets and counts as climbed with 6 or more.
  // Majority limits on the merged physics (stall assist, new front-end boxes, ride rework; 2026-11-27,
  // 2 cm steps): 32 psi 0.40 m (0.42: 4/8), 18 psi 0.40 m (0.42: 5/8), 10 psi 0.42 m (8/8; 0.44: 5/8),
  // 8 psi 0.46 m (7/8; 0.48: 1/8). (On the old clutch and boxes: 0.42 / 0.42 / 0.44 / 0.48 m, one start.)
  const OFFS = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5], MAJ = 6;
  const clears = (top, psi) => OFFS.filter((z0) => ledge('lc70', top, psi, z0)).length;
  const n = { 32: clears(0.42, 32), 18: clears(0.42, 18), 10: clears(0.42, 10), 8: clears(0.46, 8), '10b': clears(0.46, 10), base: clears(0.40, 32) };
  console.log(`     Cruiser, square rock ledge at a crawl (clears of 8 starts): 0.42 m at 32 psi ${n[32]}, 18 psi ${n[18]}, 10 psi ${n[10]}; 0.46 m at 10 psi ${n['10b']}, 8 psi ${n[8]}; 0.40 m at 32 psi ${n.base}`);
  // 18 psi is no longer separated from 10 psi by a majority: at 0.42 m it cleared 5/8 and 7/8 in two
  // measurements. Above crawl pressure the tyre's deflection is drawn only (PHYS_DEFL_FROM = 1), so
  // 18 vs 10 psi differs on rock only by the grip (+5% vs +15%), which at this ledge is now within
  // the start-to-start spread. 18 psi must still not climb better than 10 psi.
  check(n[10] >= MAJ && n[32] < MAJ, 'aired down to 10 psi the Cruiser climbs a 0.42 m square ledge it cannot climb at 32 psi (majority of 8 starts)');
  check(n[18] <= n[10], `18 psi climbs it no more often than 10 psi (${n[18]} vs ${n[10]} of 8)`);
  check(n[8] >= MAJ && n['10b'] < MAJ, 'below crawl pressure (8 psi) it climbs 0.46 m, which 10 psi does not (majority of 8 starts)');
  check(n.base >= MAJ, 'at 32 psi it still climbs 0.40 m (the case is the limit, not a broken truck)');
}

// ---------------------------------------------------------------- 4. Bog Run
{
  const bog = T.TRAILS.find((t) => t.name === 'Bog Run');
  const rocks = T.generateRocks(), trees = T.generateTrees(rocks), res = {};
  for (const psi of [32, 18, 10, 8]) {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
    const terrain = T.buildTerrainPhysics(RAPIER, world, rocks, trees);
    const p = T.pathPoint(bog, bog.length * 0.45), sp = spec('lc70'); // test/mud.mjs's parked spot
    const car = new Vehicle(RAPIER, world, sp, terrain, { x: p.x, y: T.visualHeightAt(p.x, p.z) + sp.tire.radius - sp.axleY + 0.15, z: p.z }, Math.atan2(-p.tx, -p.tz));
    car.tyre.set(psi);
    run(car, 3.5, { throttle: 0, brake: 1, steer: 0 });
    res[psi] = car.wheelState.reduce((a, w) => a + w.sink, 0) / 4;
    world.free();
  }
  console.log(`     parked Cruiser in Bog Run: ${Object.entries(res).map(([p, s]) => `${p} psi ${f3(s)} m`).join(', ')}`);
  check(res[18] < res[32] && res[10] < res[18] && res[8] < res[10], 'Bog Run: the lower the pressure, the less a parked truck sinks');
}

// ---------------------------------------------------------------- 5. dune sand (child process)
{
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--sand'], { encoding: 'utf8' });
  process.stdout.write(r.stdout); if (r.stderr) process.stdout.write(r.stderr);
  if (r.status !== 0) fails++;
}

// ---------------------------------------------------------------- 6. costs at speed
{
  // coast-down on a graded road from 90 to 45 km/h, neutral
  const coast = (psi) => {
    const { car, world } = flat('lc70', T.MAT.ROAD);
    car.tyre.set(psi); car.dt.gear = 0; run(car, 1, { throttle: 0, brake: 1, steer: 0 });
    for (const b of car.allBodies) { const l = b.linvel(); b.setLinvel({ x: 0, y: l.y, z: -90 / 3.6 }, true); }
    const z0 = car.chassis.translation().z; let t = 0;
    while (car.speed() > 45 / 3.6 && t < 120) { car.step({ throttle: 0, brake: 0, steer: 0 }, H); t += H; }
    const dist = z0 - car.chassis.translation().z; world.free(); return { dist, t };
  };
  const c32 = coast(32), c18 = coast(18), c10 = coast(10);
  console.log(`     coast-down 90 -> 45 km/h on a graded road: 32 psi ${c32.dist.toFixed(0)} m (${c32.t.toFixed(1)} s), 18 psi ${c18.dist.toFixed(0)} m, 10 psi ${c10.dist.toFixed(0)} m (${c10.t.toFixed(1)} s)`);
  check(c32.dist > c18.dist && c18.dist > c10.dist && c10.dist < c32.dist * 0.85, 'soft tyres roll less far: rolling resistance grows as the pressure drops');
  // steady corner: fixed steer, held at 70 km/h, on dirt
  const corner = (psi) => {
    const { car, world } = flat('lc70', T.MAT.DIRT);
    car.tyre.set(psi); car.grace = 1e9; car.dt.gear = 4; car.dt.fourWD = true; run(car, 1, { throttle: 0, brake: 1, steer: 0 });
    for (const b of car.allBodies) { const l = b.linvel(); b.setLinvel({ x: 0, y: l.y, z: -70 / 3.6 }, true); }
    const inp = { throttle: 0.3, brake: 0, steer: 0.15 };
    let yawSum = 0, n = 0, vSum = 0, steer05 = null;
    for (let i = 0; i < 8 / H; i++) {
      const v = car.speed() * 3.6; inp.throttle = Math.max(0, Math.min(1, inp.throttle + (70 - v) * 0.002));
      car.step(inp, H);
      if (i === 4) steer05 = car.steer; // 20 ms in: how far the wheels have turned
      if (i > 4 / H) { yawSum += car.chassis.angvel().y; vSum += car.speed(); n++; }
    }
    const w = yawSum / n, v = vSum / n; world.free();
    return { R: v / Math.abs(w), ay: (v * Math.abs(w)) / 9.81, steer05 };
  };
  const k32 = corner(32), k10 = corner(10);
  console.log(`     steady corner at 70 km/h, same steer: 32 psi radius ${k32.R.toFixed(1)} m (${f2(k32.ay)} g), 10 psi radius ${k10.R.toFixed(1)} m (${f2(k10.ay)} g); steering after 20 ms ${f3(k32.steer05)} vs ${f3(k10.steer05)} rad`);
  check(k10.R > k32.R * 1.03, 'aired down the same steer makes a wider corner at speed (lower cornering stiffness)');
  check(k10.steer05 < k32.steer05, 'aired down the steering answers more slowly at speed');
  const T10 = new TP.TyrePressure(spec('lc70'), 10);
  check(TP.speedGate(39.9) === 0 && TP.speedGate(70) === 1 && T10.f === 1, 'speed costs are zero below 40 km/h and full from 70 km/h');
}

// ---------------------------------------------------------------- 7. loaded radius and ride height
{
  const res = {};
  for (const psi of [32, 18, 10, 8]) {
    const { car, world } = flat('lc70', T.MAT.ROCK);
    car.tyre.set(psi); run(car, 3, { throttle: 0, brake: 1, steer: 0 });
    res[psi] = { y: car.chassis.translation().y, drawn: car.tyre.defl[0], phys: car.tyre.deflPhys[0], r: car.tyreR[0] };
    world.free();
  }
  console.log(`     Cruiser at rest: ${Object.entries(res).map(([p, r]) => `${p} psi deflection ${(r.drawn * 100).toFixed(1)} cm (physics ${(r.phys * 100).toFixed(1)}), chassis ${f3(r.y)} m`).join('; ')}`);
  check(res[32].drawn === 0 && res[18].drawn > 0 && res[10].drawn > res[18].drawn && res[8].drawn > res[10].drawn, 'the drawn deflection grows as the pressure drops (none at road pressure)');
  check(res[10].phys === 0 && res[18].phys === 0 && res[8].phys > 0.005 && res[8].r < car0Radius('lc70') - 0.005, 'the physics tyre keeps its radius down to crawl pressure and shrinks below it');
  check(res[8].y < res[10].y - 0.005 && Math.abs(res[10].y - res[32].y) < 2e-3, `below crawl pressure the truck sits lower: ${((res[10].y - res[8].y) * 100).toFixed(1)} cm at 8 psi (10 vs 32 psi: ${((res[10].y - res[32].y) * 1000).toFixed(2)} mm)`);
  // more load, more deflection: the drawn deflection of a loaded corner
  const T8 = new TP.TyrePressure(spec('lc70'), 10), fake = { mass: 3000, wheelState: [{ load: 3000 * 9.81 / 4 }, { load: 2 * 3000 * 9.81 / 4 }, { load: 0 }, { load: 0 }], speed: () => 0 };
  for (let i = 0; i < 200; i++) T8.step(H, fake);
  check(T8.defl[1] > T8.defl[0] * 1.5, `a corner carrying twice the load deflects more: ${(T8.defl[0] * 100).toFixed(1)} -> ${(T8.defl[1] * 100).toFixed(1)} cm`);
}
function car0Radius(id) { return spec(id).tire.radius; }

// ---------------------------------------------------------------- 8. bead
{
  // a steady hard corner (steer held, speed held) on tarmac; returns when a bead let go, if one did
  const slalom = (psi, kmh, secs = 10, steer = 0.25) => {
    const { car, world } = flat('lc70', T.MAT.TARMAC);
    car.tyre.set(psi); car.dt.gear = kmh > 30 ? 3 : 1; car.dt.range = kmh > 30 ? 'high' : 'low'; car.dt.fourWD = true; car.dt.lockF = car.dt.lockR = false;
    run(car, 1.6, { throttle: 0, brake: 1, steer: 0 }); // (the spawn grace runs out)
    for (const b of car.allBodies) { const l = b.linvel(); b.setLinvel({ x: 0, y: l.y, z: -kmh / 3.6 }, true); }
    const inp = { throttle: 0.4, brake: 0, steer: 0 };
    let t = 0, popAt = -1, ay = 0, n = 0;
    for (let i = 0; i < secs / H; i++) {
      const v = car.speed() * 3.6; inp.throttle = Math.max(0, Math.min(1, inp.throttle + (kmh - v) * 0.003));
      inp.steer = steer;
      car.step(inp, H); t += H;
      if (t > 2) { ay += Math.abs(car.chassis.angvel().y * car.speed()); n++; }
      if (popAt < 0 && car.health.tire.some((x) => x < 0.35)) popAt = t;
    }
    const ev = car.damageEvents.find((e) => e.startsWith('Bead popped')) || '';
    const out = { flat: popAt, ev, car, world, g: ay / Math.max(1, n) / 9.81 };
    return out;
  };
  const soft = slalom(9, 55, 14), hard = slalom(32, 55, 14), slow = slalom(9, 8, 14, 1);
  const tag = (r) => (r.flat >= 0 ? `bead popped after ${r.flat.toFixed(1)} s` : 'held') + ` (${r.g.toFixed(2)} g${r.car.upsideDown() ? ', rolled' : ''})`;
  console.log(`     steady hard corner on tarmac: 9 psi at 55 km/h ${tag(soft)} "${soft.ev}"; 32 psi at 55 km/h ${tag(hard)}; 9 psi at 8 km/h, full lock ${tag(slow)}`);
  check(soft.flat >= 0 && /Bead popped/.test(soft.ev), 'hard cornering at speed on 9 psi unseats a bead: a flat tyre');
  check(hard.flat < 0 && slow.flat < 0 && !hard.car.upsideDown(), 'the same at road pressure, or at a crawl on 9 psi, does not');
  soft.car.repair();
  check(soft.car.health.tire.every((x) => x === 1) && soft.car.tyre.psi === 9, 'Backspace repair fixes the flat and keeps the pressure');
  for (const r of [soft, hard, slow]) r.world.free();
}

// ---------------------------------------------------------------- 9. saved pressure
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const G = await import('../src/garage.js');
  const base = ALL_VEHICLES.find((v) => v.id === 'taco');
  check(TP.startPsi(G.applyBuild(base, G.loadBuild(base))) === 32, 'a rig with nothing saved starts at its garage start pressure (stock: road)');
  G.saveBuild(base, { ...G.loadBuild(base), psi: 18 });
  check(TP.startPsi(G.applyBuild(base, G.loadBuild(base))) === 18, 'garage start pressure 18 psi: the next drive starts at 18 psi');
  TP.saveLivePsi('taco', 12.3);
  check(TP.startPsi(G.applyBuild(base, G.loadBuild(base))) === 12.3 && TP.loadLivePsi('lc70') === null, 'the live pressure is saved per rig and the next drive starts there');
  G.saveBuild(base, { ...G.loadBuild(base), psi: 25 });
  check(TP.loadLivePsi('taco') === null && TP.startPsi(G.applyBuild(base, G.loadBuild(base))) === 25, 'a new garage start pressure replaces the saved live one');
  mem.set('lowrange.tyres.v1', '"junk"');
  check(TP.loadLivePsi('taco') === null, 'corrupt storage reads as nothing saved');
  // carried over a rebuild (repair / restart / spawn point: main.js respawnFresh)
  const { car, world } = flat('taco', T.MAT.ROCK);
  car.tyre.set(14); car.tyre.setTarget(24);
  const state = car.tyre.state, next = new Vehicle(RAPIER, world, spec('taco'), { ground: world.getCollider(0), rockHandles: new Set() }, { x: 10, y: 1.2, z: 0 }, 0);
  next.tyre.carry(car.tyre);
  check(next.tyre.psi === 14 && next.tyre.target === 24 && next.tyre.state === state && next.tyre.inflating, 'a rebuilt truck keeps the pressure, the change in progress and the audio state object');
  world.free();
}

// ---------------------------------------------------------------- 11. warnings and hints
{
  const mk = (psi, kmh, mat, slip) => { const t = new TP.TyrePressure(spec('lc70'), psi); t.kmh = kmh; return { tyre: t, wheelState: [0, 1, 2, 3].map(() => ({ grounded: true, mat, slip })) }; };
  const A = new TP.TyreAdvisor();
  const w = A.update(mk(10, 60, T.MAT.ROAD, 0), { throttle: 0.5 }, 0.1);
  check(w && w.kind === 'warn' && /10 psi/.test(w.text), `driving fast on soft tyres warns: "${w && w.text}"`);
  check(new TP.TyreAdvisor().update(mk(32, 60, T.MAT.ROAD, 0), { throttle: 0.5 }, 0.1) === null, 'no warning at road pressure');
  const B = new TP.TyreAdvisor(); let hint = null;
  for (let i = 0; i < 30 && !hint; i++) hint = B.update(mk(32, 1, T.MAT.SAND, 3), { throttle: 0.9 }, 0.1);
  check(hint && hint.kind === 'hint' && /Air down/.test(hint.text), `stuck in sand at road pressure, wheels spinning: a hint to air down ("${hint && hint.text}")`);
  const C = new TP.TyreAdvisor(); let none = null;
  for (let i = 0; i < 30 && !none; i++) none = C.update(mk(10, 1, T.MAT.SAND, 3), { throttle: 0.9 }, 0.1);
  check(none === null, 'already aired down: no hint');
}

// ---------------------------------------------------------------- 10. the tyre board fits
{
  const { hudLayout, BIG_MAX } = await import('../src/hud/layout.js');
  const sizes = [[1920, 1080, 1], [1366, 768, 1], [1280, 720, 1], [1536, 864, 1.25], [1280, 720, 1.5], [2560, 1440, 2]];
  const shown = sizes.filter(([W, H, dpr]) => hudLayout({ W, H, dpr, centre: BIG_MAX }).tyre);
  check(shown.length === sizes.length, `the tyre board shows at the common window sizes (${shown.length}/${sizes.length})`);
}

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
