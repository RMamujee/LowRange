// Single step-up ledge, per rig: the tallest one each rig climbs, at crawl pace and with a run-up.
// The ledge is a flat-topped slab across the track, 4 m deep (longer than any wheelbase, so the
// whole rig has to get up onto it), either square (vertical face) or chamfered like the trail
// ledges in src/maps/common.js (the face leans back 0.7 m per metre of height). Each rig drives
// as it comes: its own lockers, 4WD, low range where it has one. Crawl: throttle governed to
// 0.6-1.6 m/s, as in test/ledgegrade.mjs. Run-up: 1st gear high range, held at about 4 m/s
// (14 km/h) into the face, more throttle if it stalls against it. "Clear" = the rear axle is on
// top of the slab.
//
// A single run is close to a coin flip near a rig's limit (a stall at the face that breaks loose
// or not), so every height is driven from START_OFFSETS different start distances and counts as
// climbed only if at least MAJORITY of them clear it. The pass count per height is printed so the
// luck is visible. The sweep stops at the first height that misses the majority (plus one more,
// to show the edge). For the crawl cases it also measures the lowest throttle cap (instead of the
// test's 0.6) that clears the limit height and the next one up by the same majority: a stable,
// continuous number for how much margin a rig has.
// usage: node test/ledgeclimb.mjs [ids=lc70,taco,wrx] [shapes=square,chamfer] [modes=crawl,speed] [heights comma]
//        LEDGE_ASSERT=1 also checks the expected limits (exit 1 on a miss); NO_THR=1 skips the throttle search
//        JOBS=n parallel processes (default: cores - 1)
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const START_OFFSETS = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5]; // m further from the ledge
const MAJORITY = 6;

// ---------------------------------------------------------------- one run (child process)
async function runOne(id, shape, mode, top, z0, cap) {
  const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
  const { ALL_VEHICLES } = await import('../src/specs.js');
  const { Vehicle } = await import('../src/vehicle.js');
  const { GROUP_WORLD } = await import('../src/terrain.js');
  await RAPIER.init();
  const H = 1 / 200;
  const spec = ALL_VEHICLES.find((v) => v.id === id);
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
  const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUP_WORLD));
  const rockHandles = new Set([ground.handle]); // rock ground too, as on the Gauntlet's ledge stages
  const face = (mode === 'speed' ? -16 : -6) - z0, hw = 4, depth = 4, Hh = top + 0.6, pts = [];
  // slab from z = face (lip) back to face - depth, base buried 0.6 m; chamfer leans both faces back
  const lean = shape === 'chamfer' ? 0.7 : 0;
  for (const sx of [-1, 1]) for (const [zt, zb] of [[0, Hh * lean], [-depth, -depth - Hh * lean]]) { pts.push(sx * hw, top, zt); pts.push(sx * hw, -0.6, zb); }
  const c = world.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(pts)).setTranslation(0, 0, face).setFriction(1).setCollisionGroups(GROUP_WORLD));
  rockHandles.add(c.handle);
  const car = new Vehicle(RAPIER, world, spec, { ground, rockHandles }, { x: 0, y: spec.tire.radius - spec.axleY + 0.05, z: 0 }, 0);
  car.airedDown = true; car.grace = 1e9; // damage off: this measures climbing, not crash tolerance
  const d = car.dt; d.fourWD = true; d.lockF = !!spec.lockers.front; d.lockR = !!spec.lockers.rear; d.gear = 1;
  d.range = mode === 'crawl' && spec.ranges.low ? 'low' : 'high';
  const inp = { throttle: 0, brake: 1, steer: 0 };
  for (let i = 0; i < 200; i++) car.step(inp, H);
  inp.brake = 0;
  const lo = mode === 'crawl' ? 0.6 : 3.6, hi = mode === 'crawl' ? 1.6 : 4.4;
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

if (process.argv[2] === '--one') {
  const [, , , id, shape, mode, top, z0, cap] = process.argv;
  process.stdout.write(await runOne(id, shape, mode, +top, +z0, +cap) + '\n');
  process.exit(0);
}

// ---------------------------------------------------------------- driver
const self = fileURLToPath(import.meta.url);
const JOBS = Math.max(1, Number(process.env.JOBS) || availableParallelism() - 1);
let running = 0; const queue = [];
function pump() {
  while (running < JOBS && queue.length) {
    const { args, resolve } = queue.shift(); running++;
    const p = spawn(process.execPath, [self, '--one', ...args.map(String)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (b) => { out += b; });
    p.on('close', () => { running--; resolve(out.trim() || 'ERR'); pump(); });
  }
}
const job = (...args) => new Promise((resolve) => { queue.push({ args, resolve }); pump(); });
// every start offset of one height: { n: clears, res: [...] }
async function height(id, shape, mode, top, cap) {
  const res = await Promise.all(START_OFFSETS.map((z0) => job(id, shape, mode, top, z0, cap)));
  return { n: res.filter((r) => r === 'ok').length, res };
}
const crawlCap = (mode) => (mode === 'crawl' ? 0.6 : 1);
// lowest throttle cap (0.2-1.0, to 0.05) that clears this height by the majority; null if not at 1.0
async function minThrottle(id, shape, top) {
  if ((await height(id, shape, 'crawl', top, 1)).n < MAJORITY) return null;
  let a = 0.2, b = 1; // b clears, a assumed not to
  while (b - a > 0.05 + 1e-9) {
    const m = Math.round(((a + b) / 2) * 100) / 100;
    if ((await height(id, shape, 'crawl', top, m)).n >= MAJORITY) b = m; else a = m;
  }
  return b;
}

const ids = (process.argv[2] || 'lc70,taco,wrx').split(',');
const shapes = (process.argv[3] || 'square,chamfer').split(',');
const modes = (process.argv[4] || 'crawl,speed').split(',');
const heights = (process.argv[5] || '0.2,0.25,0.3,0.35,0.4,0.45,0.5,0.55,0.6,0.65,0.7,0.75').split(',').map(Number);
const { ALL_VEHICLES } = await import('../src/specs.js');

const cases = [];
for (const id of ids) for (const shape of shapes) for (const mode of modes) cases.push({ id, shape, mode });
const results = {};
const t0 = Date.now();
await Promise.all(cases.map(async (cs) => {
  const { id, shape, mode } = cs;
  const row = [];
  let best = 0, failed = false, extra = 0;
  for (const top of heights) {
    const { n } = await height(id, shape, mode, top, crawlCap(mode));
    row.push(`${top}:${n}`);
    if (n >= MAJORITY && !failed) best = top;
    else if (n < MAJORITY) { failed = true; }
    if (failed && ++extra > 1) break; // the first miss and one more height
  }
  cs.best = best; cs.row = row;
  if (mode === 'crawl' && !process.env.NO_THR && best > 0) {
    const next = Math.round((best + 0.05) * 100) / 100;
    [cs.thr, cs.thrNext, cs.next] = [...(await Promise.all([minThrottle(id, shape, best), minThrottle(id, shape, next)])), next];
  }
}));
for (const cs of cases) {
  const spec = ALL_VEHICLES.find((v) => v.id === cs.id);
  results[`${cs.id}/${cs.shape}/${cs.mode}`] = cs.best;
  const fmt = (x) => (x == null ? 'over 1.0' : x.toFixed(2));
  const thr = cs.thr !== undefined ? `  min throttle: ${fmt(cs.thr)} at ${cs.best.toFixed(2)} m, ${fmt(cs.thrNext)} at ${cs.next.toFixed(2)} m` : '';
  console.log(`${cs.id.padEnd(5)} ${cs.shape.padEnd(7)} ${cs.mode.padEnd(5)} max ${cs.best.toFixed(2)} m (${(cs.best / spec.tire.radius).toFixed(2)} R)  clears/${START_OFFSETS.length}: ${cs.row.join(' ')}${thr}`);
}
console.log(`(a height counts with ${MAJORITY}/${START_OFFSETS.length} start offsets clear; ${((Date.now() - t0) / 1000).toFixed(0)} s, ${JOBS} jobs)`);
if (process.env.LEDGE_ASSERT) {
  // expected limits (m): [min, max] tallest single ledge cleared by the majority. The Rally
  // Sedan's floor pan and bumper sit 0.25-0.27 m up, so it stops at about its tyre radius.
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
