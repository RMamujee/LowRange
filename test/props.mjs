// Physics props (src/physics_props.js) against the tyre solver (src/vehicle.js). Only small
// stones (under DYNAMIC_MAX_WIDTH, 0.4 m) are loose; logs (trail-crew edging), stumps and bigger
// rocks are fixed colliders.
//  a) crawl taco / lc70 / wrx over a loose 0.32 m stone and a fixed 0.3 m edging log
//  b) spin a tyre on a small loose stone: the stone goes backwards, the truck doesn't rocket
//  c) nose into a fixed log barrier / rock with the bumper: it stays put
//  d) park with one tyre on a stone for 5 s: no drift / jitter
//  e) loose-stone hits vs a fixed log vs a wall (damage proportionate), drops onto a
//     heightfield (no tunnelling)
//  g) high-centring on a fixed log
//  h) the real set dressing (Trail Park, procedural art): only small stones loose, no loose
//     logs, every log clear of the paths
//  f) physics step time with ~50 awake stones
//   node test/props.mjs
import RAPIER from '@dimforge/rapier3d-compat';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import * as THREE from 'three';
import * as T from '../src/terrain.js';
import { PropPhysics, adoptDressing, DYNAMIC_MAX_WIDTH } from '../src/physics_props.js';
import { buildSetDressing, gridClearance } from '../src/art/dressing.js';
const { GROUP_WORLD } = T;
await RAPIER.init();
const H = 1 / 200;
let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const f2 = (x) => x.toFixed(2);

// a stone hull like the dressing's: an irregular dome `w` wide and `h` tall on a flat-ish
// base at y=0 (the glTF stones sit on a broad base, a few cm embedded)
function rockPts(w, h, seed = 1) {
  let s = seed; const R = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (let i = 0; i < 40; i++) {
    const u = R(), th = R() * Math.PI * 2, r = Math.sqrt(1 - u * u), k = 0.85 + R() * 0.15;
    out.push(Math.cos(th) * r * w / 2 * k, u * h * k, Math.sin(th) * r * w / 2 * k);
  }
  for (let i = 0; i < 6; i++) { const th = (i / 6) * Math.PI * 2 + 0.3; out.push(Math.cos(th) * w * 0.4, 0, Math.sin(th) * w * 0.4); }
  out.push(0, h, 0);
  return new Float32Array(out);
}
// a log: 12-sided prism of diameter d and length L along X, resting on y=0
function logPts(d, L) {
  const out = [];
  for (const x of [-L / 2, L / 2]) for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; out.push(x, d / 2 + Math.cos(a) * d / 2, Math.sin(a) * d / 2); }
  return new Float32Array(out);
}

function scene(ground = 'flat') {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
  let g, heightAt = () => 0;
  if (ground === 'flat') g = world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUP_WORLD));
  else { // bumpy heightfield, 1 m cells
    const N = 80, S = 80, hs = new Float32Array((N + 1) ** 2);
    const hf = (x, z) => 0.3 * Math.sin(x * 0.7) * Math.cos(z * 0.5);
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) hs[i * (N + 1) + j] = hf(-S / 2 + i, -S / 2 + j);
    g = world.createCollider(RAPIER.ColliderDesc.heightfield(N, N, hs, { x: S, y: 1, z: S }).setFriction(1).setCollisionGroups(GROUP_WORLD));
    heightAt = hf;
  }
  const terrain = { ground: g, rockHandles: new Set() };
  const props = new PropPhysics(RAPIER, world, terrain, { heightAt });
  return { world, terrain, props, heightAt };
}
const yawQ = (a) => ({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) });
const finite = (b) => { const t = b.translation(), l = b.linvel(); return [t.x, t.y, t.z, l.x, l.y, l.z].every(Number.isFinite); };

function makeCar(sc, id, z0 = 0, x0 = 0) {
  const spec = VEHICLES.find((v) => v.id === id);
  const car = new Vehicle(RAPIER, sc.world, spec, sc.terrain, { x: x0, y: spec.tire.radius - spec.axleY + 0.05, z: z0 }, 0);
  return { car, spec };
}
// crawl forward (-Z) at `kmh` in 4-Low 1st with a P throttle; tick(t) per step
function crawl(car, secs, kmh, tick, inp = { throttle: 0, brake: 0, steer: 0 }) {
  car.dt.range = car.spec.ranges.low ? 'low' : 'high'; car.dt.fourWD = true; car.dt.gear = 1;
  for (let i = 0; i < secs / H; i++) {
    const err = kmh / 3.6 - car.speed();
    inp.throttle = Math.max(0, Math.min(1, 0.25 + err * 0.8)); inp.brake = err < -0.6 ? 0.3 : 0;
    car.step(inp, H);
    if (tick && tick(i * H) === false) break;
  }
}
const settle = (car, s = 1) => { for (let i = 0; i < s / H; i++) car.step({ throttle: 0, brake: 1, steer: 0 }, H); };

console.log('a) crawling over a loose 0.32 m stone and a fixed 0.3 m edging log');
for (const id of ['taco', 'lc70', 'wrx']) {
  for (const what of ['rock', 'log']) {
    const sc = scene();
    const { car, spec } = makeCar(sc, id);
    const fz = -spec.wheelbase / 2;            // front axle z
    const it = what === 'rock'
      ? sc.props.add({ kind: 'rock', pos: { x: -spec.track / 2, y: 0, z: fz - 4 }, rot: yawQ(0.4), pts: rockPts(0.32, 0.2, 7) })
      : sc.props.add({ kind: 'log', pos: { x: 0, y: 0, z: fz - 4 }, rot: yawQ(0.1), pts: logPts(0.3, 2.6) });
    sc.props.update(car.chassis.translation());
    settle(car);
    const p0 = { ...it.body.translation() };
    let maxVy = 0, maxProp = 0, ok = true, touched = false;
    crawl(car, 30, 3, () => {
      sc.props.sync();
      if (!finite(car.chassis) || !finite(it.body)) { ok = false; return false; }
      maxVy = Math.max(maxVy, Math.abs(car.chassis.linvel().y));
      const lv = it.body.linvel(); maxProp = Math.max(maxProp, Math.hypot(lv.x, lv.y, lv.z));
      if (car.patches.some((p) => p.ob)) touched = true;
      if (car.chassis.translation().z < fz - 4 - spec.wheelbase - 4) return false;
    });
    const p1 = it.body.translation(), cz = car.chassis.translation().z;
    const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    check(ok && (touched || what !== 'rock') && cz < fz - 4 - spec.wheelbase - 3 && maxVy < 2 && maxProp < 6 && moved < 4 && p1.y > -0.2 && it.dynamic === (what === 'rock') && (what === 'rock' || moved < 1e-4),
      `${id.padEnd(5)} over ${what.padEnd(4)}: truck z ${f2(cz)}, prop moved ${f2(moved)} m (dy ${f2(p1.y - p0.y)}), max prop speed ${f2(maxProp)} m/s, max chassis |vy| ${f2(maxVy)} m/s, tyre touched prop ${touched}`);
  }
}

console.log('b) spinning a tyre on a small loose rock');
for (const id of ['taco', 'lc70', 'wrx']) {
  const sc = scene();
  const { car, spec } = makeCar(sc, id);
  // stuck: front tyres chocked against a fixed kerb, rear axle spinning in 2WD; the
  // rear-left tyre sits on a 0.12 m, ~5 kg stone
  const fz = -spec.wheelbase / 2;
  sc.world.createCollider(RAPIER.ColliderDesc.cuboid(3, 0.5, 0.5).setTranslation(0, 0.5, fz - spec.tire.radius - 0.52).setCollisionGroups(GROUP_WORLD));
  const it = sc.props.add({ kind: 'rock', pos: { x: -spec.track / 2, y: 0, z: spec.wheelbase / 2 }, rot: yawQ(0), pts: rockPts(0.24, 0.12, 3) });
  for (const b of car.allBodies) { const t = b.translation(); b.setTranslation({ x: t.x, y: t.y + 0.14, z: t.z }, true); }
  sc.props.update(car.chassis.translation());
  settle(car, 0.5);
  const m = it.body.mass(), p0 = { ...it.body.translation() }, c0 = car.chassis.translation().z;
  car.dt.range = 'high'; car.dt.fourWD = false; car.dt.gear = 1; car.dt.lockR = true;
  let maxRockV = 0, rockBack = 0, ok = true, maxCarV = 0, maxSpin = 0;
  for (let i = 0; i < 2 / H; i++) {
    car.step({ throttle: 1, brake: 0, steer: 0 }, H); sc.props.sync();
    if (!finite(car.chassis) || !finite(it.body)) { ok = false; break; }
    const lv = it.body.linvel(); maxRockV = Math.max(maxRockV, Math.hypot(lv.x, lv.y, lv.z)); rockBack = Math.max(rockBack, lv.z);
    maxCarV = Math.max(maxCarV, Math.abs(car.speed())); maxSpin = Math.max(maxSpin, car.wheelState[2].spin);
  }
  const p1 = it.body.translation(), dc = Math.abs(car.chassis.translation().z - c0);
  check(ok && p1.z - p0.z > 0.5 && rockBack > 1 && maxRockV < 30 && maxCarV < 0.8 && dc < 0.3,
    `${id.padEnd(5)} ${f2(m)} kg stone at a spinning tyre (${maxSpin.toFixed(0)} rad/s): flung ${f2(p1.z - p0.z)} m back (max +z ${f2(rockBack)} m/s, max ${f2(maxRockV)}); stuck truck max speed ${f2(maxCarV)} m/s, moved ${f2(dc)} m`);
}

console.log('c) nosing into fixed edging with the bumper');
for (const [id, what] of [['lc70', 'log'], ['taco', 'boulder']]) {
  const sc = scene();
  const { car, spec } = makeCar(sc, id);
  settle(car, 0.5);
  const cl = spec.chassis.size[2], cb = car.chassis.translation().y - spec.chassis.size[1] / 2; // chassis box bottom
  const front = -cl / 2 - 2.5;
  // a log barrier across the way at bumper height, or a 0.9 m rock straight ahead: both fixed
  const it = what === 'log'
    ? sc.props.add({ kind: 'log', pos: { x: 0, y: 0, z: front - 0.4 }, rot: yawQ(0), pts: logPts(Math.max(0.5, cb + 0.35), 3.0) })
    : sc.props.add({ kind: 'boulder', pos: { x: 0, y: 0, z: front - 0.5 }, rot: yawQ(0), pts: rockPts(0.9, Math.max(0.6, cb + 0.3), 5) });
  sc.props.update(car.chassis.translation());
  const p0 = { ...it.body.translation() };
  let ok = true, bodyHit = false;
  crawl(car, 8, 4, () => {
    sc.props.sync();
    if (!finite(car.chassis) || !finite(it.body)) { ok = false; return false; }
  });
  for (const h of car.bodyHandles) sc.world.contactPair(sc.world.getCollider(h), it.collider, (mf) => { if (mf.numContacts()) bodyHit = true; });
  const p1 = it.body.translation(), moved = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
  check(ok && !it.dynamic && moved < 1e-4 && car.chassis.translation().z > p0.z && car.health.body > 0.97,
    `${id.padEnd(5)} against a fixed ${what}: it moved ${(moved * 1000).toFixed(2)} mm, truck held at z ${f2(car.chassis.translation().z)} (barrier ${f2(p0.z)}, body contact ${bodyHit}), body health ${f2(car.health.body)}`);
}

console.log('d) parked with one tyre on a rock for 5 s (vs the same rock fixed in place; a 0.5 m stone, bigger than any loose one in game: a solver stability check)');
const park = (id, kind) => {
  const sc = scene();
  const { car, spec } = makeCar(sc, id);
  const fz = -spec.wheelbase / 2;
  const it = sc.props.add({ kind, pos: { x: -spec.track / 2, y: 0, z: fz - 2.5 }, rot: yawQ(0.3), pts: rockPts(0.5, 0.22, 11) });
  sc.props.update(car.chassis.translation());
  settle(car, 0.5);
  // drive the front-left tyre up onto the rock and stop on it
  crawl(car, 15, 2, () => { sc.props.sync(); const w = car.wheels[0].translation(); if (w.z < it.body.translation().z + 0.02) return false; });
  settle(car, 2);
  const lift = car.wheels[0].translation().y - spec.tire.radius;
  const c0 = { ...car.chassis.translation() }, r0 = { ...it.body.translation() };
  let maxW = 0, maxRv = 0, lateRv = 0, r2 = null, c2 = null;
  for (let i = 0; i < 5 / H; i++) {
    car.step({ throttle: 0, brake: 1, steer: 0 }, H); sc.props.sync();
    const w = car.chassis.angvel(); maxW = Math.max(maxW, Math.hypot(w.x, w.y, w.z));
    const rv = it.body.linvel(), sp = Math.hypot(rv.x, rv.y, rv.z); maxRv = Math.max(maxRv, sp);
    if (i * H >= 2) { lateRv = Math.max(lateRv, sp); r2 ||= { ...it.body.translation() }; c2 ||= { ...car.chassis.translation() }; }
  }
  const c1 = car.chassis.translation(), r1 = it.body.translation(), d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  return { lift, drift: d(c1, c0), driftLate: d(c1, c2), rd: d(r1, r0), rdLate: d(r1, r2), maxW, maxRv, lateRv };
};
for (const id of ['taco', 'lc70', 'wrx']) {
  const a = park(id, 'rock'), b = park(id, 'boulder');
  check(a.lift > 0.11 && a.driftLate < b.driftLate * 2 + 0.005 && a.rd < 0.03 && a.rdLate < 0.003 && a.lateRv < 0.02 && a.maxW < Math.max(0.03, b.maxW * 2),
    `${id.padEnd(5)} FL tyre up ${f2(a.lift)} m on a loose rock: chassis drift ${(a.drift * 1000).toFixed(1)} mm, ${(a.driftLate * 1000).toFixed(1)} in the last 3 s (same rock fixed: ${(b.drift * 1000).toFixed(1)}, ${(b.driftLate * 1000).toFixed(1)}), max chassis rate ${a.maxW.toFixed(3)} rad/s (fixed ${b.maxW.toFixed(3)}); rock moves ${(a.rd * 1000).toFixed(1)} mm (max ${a.maxRv.toFixed(3)} m/s), ${(a.rdLate * 1000).toFixed(1)} mm in the last 3 s (late max ${a.lateRv.toFixed(3)} m/s)`);
}

console.log('e) impacts and drops');
{
  const res = [];
  for (const target of ['rock', 'log', 'wall']) {
    const sc = scene();
    const { car, spec } = makeCar(sc, 'taco');
    for (let i = 0; i < 200; i++) car.step({ throttle: 0, brake: 0, steer: 0 }, H);
    car.grace = 0;
    const cb = car.chassis.translation().y - spec.chassis.size[1] / 2, zf = -spec.chassis.size[2] / 2 - 6;
    if (target === 'wall') sc.world.createCollider(RAPIER.ColliderDesc.cuboid(10, 2, 0.5).setTranslation(0, 2, zf).setCollisionGroups(GROUP_WORLD));
    else if (target === 'rock') sc.props.add({ kind: 'rock', pos: { x: 0, y: 0, z: zf }, rot: yawQ(0), pts: rockPts(0.36, Math.max(0.3, cb + 0.2), 9) });
    else sc.props.add({ kind: 'log', pos: { x: 0, y: 0, z: zf - 1.3 }, rot: yawQ(Math.PI / 2), pts: logPts(Math.max(0.5, cb + 0.3), 2.6) });
    sc.props.update(car.chassis.translation());
    const mass = sc.props.items[0]?.body.mass();
    const v = 30 / 3.6; for (const b of car.allBodies) { const l = b.linvel(); b.setLinvel({ x: 0, y: l.y, z: -v }, true); }
    for (let i = 0; i < 600; i++) { car.step({ throttle: 0, brake: 0, steer: 0 }, H); sc.props.sync(); }
    res.push({ target, mass, body: car.health.body, dents: car.dents.length, ok: finite(car.chassis) });
  }
  const [r, l, w] = res;
  console.log(`  30 km/h into: ${res.map((x) => `${x.target}${x.mass ? ` (${x.mass.toFixed(0)} kg)` : ''} body ${f2(x.body)} dents ${x.dents}`).join(' | ')}`);
  check(r.ok && l.ok && r.body > 0.99 && l.body < r.body && w.body < r.body, 'hits do proportionate damage (loose stone < fixed log, wall)');
  // 30 small stones thrown down at 12 m/s onto a bumpy heightfield
  const sc = scene('hf');
  for (let i = 0; i < 30; i++) {
    const x = (i % 6) * 2 - 5, z = Math.floor(i / 6) * 2 - 5;
    sc.props.add({ kind: 'rock', pos: { x, y: sc.heightAt(x, z) + 1 + (i % 3), z }, rot: yawQ(i), pts: rockPts(0.12 + (i % 4) * 0.08, 0.1 + (i % 3) * 0.06, i + 2) });
  }
  sc.props.update({ x: 0, y: 0, z: 0 });
  for (const it of sc.props.items) { it.body.wakeUp(); it.body.setLinvel({ x: 3, y: -12, z: 1 }, true); }
  let below = 0, minGap = 9;
  for (let i = 0; i < 4 / H; i++) {
    sc.world.step();
    for (const it of sc.props.items) { const t = it.body.translation(); const gap = t.y - sc.heightAt(t.x, t.z); minGap = Math.min(minGap, gap); if (gap < -0.15) below++; }
  }
  sc.props.sync();
  const asleep = sc.props.items.filter((it) => it.body.isSleeping()).length;
  check(below === 0, `30 stones thrown at 12 m/s onto a heightfield: none fell through (min origin-to-ground gap ${f2(minGap)} m), ${asleep}/30 asleep after 4 s`);
}

console.log('g) high-centring on a log');
for (const [id, dia] of [['wrx', 0.45], ['lc70', 0.45]]) {
  const sc = scene();
  const { car, spec } = makeCar(sc, id);
  const it = sc.props.add({ kind: 'log', pos: { x: 0, y: 0, z: -spec.wheelbase / 2 - 3 }, rot: yawQ(0), pts: logPts(dia, 3.2) });
  sc.props.update(car.chassis.translation());
  settle(car, 0.5);
  let bellyT = 0, ok = true, minLoad = 1e9;
  crawl(car, 40, 2, () => {
    sc.props.sync();
    if (!finite(car.chassis) || !finite(it.body)) { ok = false; return false; }
    let belly = false;
    for (const h of car.bodyHandles) sc.world.contactPair(sc.world.getCollider(h), it.collider, (mf) => { if (mf.numContacts()) belly = true; });
    if (belly) { bellyT += H; minLoad = Math.min(minLoad, car.wheelState.reduce((s, w) => s + (w.load || 0), 0)); }
  });
  const cz = car.chassis.translation().z, passed = cz < it.body.translation().z - spec.wheelbase;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${id.padEnd(5)} over a ${dia} m log: belly/axle on the log for ${bellyT.toFixed(1)} s${bellyT ? ` (tyre load down to ${(minLoad / (car.mass * 9.81) * 100).toFixed(0)}% of the truck's weight)` : ''}, ${passed ? 'got over' : 'not past it'} (truck z ${f2(cz)}, log z ${f2(it.body.translation().z)}, speed ${f2(car.speed())} m/s)`);
  if (!ok) fails++;
}

console.log('h) the Trail Park set dressing (procedural art)');
{
  const clear = gridClearance({ size: T.SIZE, res: T.RES, path: T.GRID.path }, T.TRAILHEAD);
  const root = buildSetDressing({
    size: T.SIZE, heightAt: T.visualHeightAt, matAt: T.materialAt, trees: T.generateTrees(),
    clear, paths: [...T.ROADS, ...T.TRAILS], trailhead: T.TRAILHEAD,
  });
  const props = new PropPhysics(RAPIER, null, {});
  const n = adoptDressing(root, props);
  const by = {};
  for (const it of props.items) { const k = `${it.kind}${it.dynamic ? ' (loose)' : ' (fixed)'}`; by[k] = (by[k] || 0) + 1; }
  const loose = props.items.filter((it) => it.dynamic);
  const width = (it) => { let w = 0; for (let i = 0; i < it.pts.length; i += 3) w = Math.max(w, Math.hypot(it.pts[i], it.pts[i + 2]) * 2); return w; };
  const maxLoose = Math.max(...loose.map(width));
  const logs = props.items.filter((it) => it.kind === 'log');
  // every log's ends and middle at least 0.8 m (+ its ~0.3 m radius) off every drivable path
  const q = new THREE.Quaternion(), badLogs = logs.filter((it) => {
    q.set(it.rot.x, it.rot.y, it.rot.z, it.rot.w);
    const ax = new THREE.Vector3(it.halfExt[0], 0, 0).applyQuaternion(q);
    return [-1, 0, 1].some((k) => !clear(it.pos.x + ax.x * k, it.pos.z + ax.z * k, 1.1));
  });
  console.log(`  ${n} props: ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')}; widest loose stone ${maxLoose.toFixed(2)} m`);
  check(loose.every((it) => it.kind === 'rock') && maxLoose < DYNAMIC_MAX_WIDTH && !logs.some((it) => it.dynamic), `only stones under ${DYNAMIC_MAX_WIDTH} m are loose; ${logs.length} logs, all fixed`);
  check(logs.length > 10 && badLogs.length === 0, `log edging keeps 1.1 m off every path (${badLogs.length} too close)`);
}

console.log('f) step time');
{
  const time = (n) => {
    const sc = scene();
    const { car } = makeCar(sc, 'lc70');
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, r = 4 + (i % 5);
      sc.props.add({ kind: 'rock', pos: { x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r }, rot: yawQ(a), pts: rockPts(0.2 + (i % 3) * 0.08, 0.15 + (i % 2) * 0.06, i) });
    }
    sc.props.update({ x: 0, y: 0, z: 0 });
    // keep them all awake: throw them about
    const kick = () => { for (const it of sc.props.items) { it.body.wakeUp(); it.body.setLinvel({ x: 0, y: 2.5, z: 0 }, true); } };
    for (let i = 0; i < 100; i++) car.step({ throttle: 0, brake: 1, steer: 0 }, H);
    let t = 0, awake = 0;
    for (let k = 0; k < 4; k++) {
      kick();
      const t0 = performance.now();
      for (let i = 0; i < 100; i++) { car.step({ throttle: 0.4, brake: 0, steer: 0.3 }, H); sc.props.sync(); }
      t += performance.now() - t0; awake += sc.props.stats().awake;
    }
    return { ms: t / 400, awake: awake / 4 };
  };
  const a = time(0), b = time(50);
  console.log(`  per physics step (vehicle + world): no props ${a.ms.toFixed(3)} ms | 50 props (${b.awake.toFixed(0)} awake) ${b.ms.toFixed(3)} ms`);
}

console.log(fails ? `${fails} FAILED` : 'all props checks passed');
process.exit(fails ? 1 : 0);
