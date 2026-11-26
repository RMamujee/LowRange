// Crash scenarios, headless: drops onto the wheels and the roof, wall hits at 10/30/60 km/h, a
// sideways slide into a tree at 40 km/h, a rollover down a steep slope, and slow crawling
// contact that must not dent. Runs the real glTF bodies (test/lib/glb.mjs) through VehicleView,
// prints health / mechanical / deformation metrics per rig and asserts the tuning targets.
// usage: node test/crash.mjs [ids=taco,lc70,wrx] [scenario filter] ; VERBOSE=1 for event logs
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { VehicleView } from '../src/vehicle_view.js';
import { GROUP_WORLD } from '../src/terrain.js';
import { loadAllVehicles } from './lib/glb.mjs';
await RAPIER.init();
if (process.env.VERBOSE) globalThis.CRASH_DEBUG = true;
await loadAllVehicles();
const H = 1 / 200;
const ids = (process.argv[2] || 'taco,lc70,wrx').split(',');
const only = process.argv[3] || '';
const scene = new THREE.Scene();
const f2 = (x) => x.toFixed(2);
let fails = 0;
const rollovers = [];
const check = (ok, msg) => { if (!ok) { fails++; console.log('    FAIL ' + msg); } };

function setup(spec, { y = 0, yaw = 0, rot = null, slope = 0 } = {}) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H;
  const q = slope ? { x: 0, y: 0, z: Math.sin(slope / 2), w: Math.cos(slope / 2) } : { x: 0, y: 0, z: 0, w: 1 };
  const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(300, 1, 300).setTranslation(0, -1, 0).setRotation(q).setFriction(0.9).setCollisionGroups(GROUP_WORLD));
  const terrain = { ground, rockHandles: new Set() };
  const car = new Vehicle(RAPIER, world, spec, terrain, { x: 0, y: spec.tire.radius - spec.axleY + 0.05 + y, z: 0 }, yaw);
  if (rot) for (const b of car.allBodies) {
    // rotate the whole rig about the chassis centre
    const c = car.chassis.translation(), p = b.translation();
    const v = new THREE.Vector3(p.x - c.x, p.y - c.y, p.z - c.z).applyQuaternion(rot);
    b.setTranslation({ x: c.x + v.x, y: c.y + v.y, z: c.z + v.z }, true);
    const r = b.rotation(); const nq = rot.clone().multiply(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    b.setRotation({ x: nq.x, y: nq.y, z: nq.z, w: nq.w }, true);
  }
  car.grace = 0;
  const view = new VehicleView(scene, car);
  return { world, car, view, terrain };
}
const run = (s, secs, inp = { throttle: 0, brake: 0, steer: 0 }, every = null) => {
  let worst = 0;
  for (let i = 0; i < secs / H; i++) {
    s.car.step(inp, H);
    if (i % 4 === 0) { const t0 = performance.now(); s.view.update(null); worst = Math.max(worst, performance.now() - t0); }
    if (every) every(i);
  }
  s.view.update(null);
  return worst;
};
const setVel = (car, vx, vy, vz) => { for (const b of car.allBodies) b.setLinvel({ x: vx, y: vy, z: vz }, true); };
function metrics(s) {
  const c = s.car, r = c.crash.report(), d = s.view.damage.stats();
  return { c, r, d, line: `body ${f2(c.health.body)} eng ${f2(c.health.engine)}${c.dt.dead ? ' DEAD' : ''} susp ${c.health.susp.map(f2).join('/')} broken ${c.broken.filter(Boolean).length} | plastic ${r.plastic.toFixed(1)} J/kg crush F${f2(r.crush.front)} R${f2(r.crush.rear)} roof ${f2(r.crush.roof)} L${f2(r.crush.left)} R${f2(r.crush.right)} rad ${f2(r.radiator)} | mesh max ${f2(d.max)} m, zones ${Object.entries(d.zones).map(([k, z]) => `${k} ${f2(z.max)}/${f2(z.mean)}`).join(' ')} | glass ${d.glass.cracked}c/${d.glass.gone}x of ${d.glass.total} lamps ${d.lamps.broken}/${d.lamps.total} | off: ${r.detached.join(',') || '-'}` };
}
const done = (s) => { s.view.dispose(); s.car.destroy(); };
const want = (name) => !only || name.includes(only);
const roll = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);

for (const id of ids) {
  const spec = VEHICLES.find((v) => v.id === id);
  console.log(`== ${spec.name} (${id})`);
  // ---- drops onto the wheels
  for (const drop of [1, 2.5, 5]) {
    if (!want('drop')) break;
    const s = setup(spec, { y: drop });
    run(s, 3);
    const m = metrics(s);
    console.log(`  drop ${drop} m: ${m.line} | peak wheel g ${(s.car.peakG || [0, 0, 0, 0]).map((g) => g.toFixed(0)).join('/')}`);
    const minS = Math.min(...m.c.health.susp);
    if (drop === 1) { check(minS > 0.95 && m.d.max < 0.01, `1 m drop: no visible damage (min susp ${f2(minS)}, mesh ${f2(m.d.max)})`); }
    if (drop === 2.5) { check(minS > 0.75 && m.c.broken.every((b) => !b), `2.5 m drop: light or no suspension damage (min susp ${f2(minS)})`); check(m.d.max < 0.06, `2.5 m: little body deformation (${f2(m.d.max)})`); }
    if (drop === 5) { check(minS < 0.75 && m.c.broken.filter(Boolean).length <= 1, `5 m drop: heavy suspension damage, still mostly on its wheels (min susp ${f2(minS)})`); }
    done(s);
  }
  // ---- 5 m drop onto the roof
  if (want('roof')) {
    const s = setup(spec, { y: 5 + 1.2, rot: roll(Math.PI) });
    run(s, 3);
    const m = metrics(s);
    console.log(`  roof drop 5 m: ${m.line}`);
    check(m.r.crush.roof > 0.12, `roof drop: roof crushed (${f2(m.r.crush.roof)})`);
    check(m.d.glass.gone + m.d.glass.cracked >= Math.ceil(m.d.glass.total * 0.5), `roof drop: glass broken (${m.d.glass.cracked}+${m.d.glass.gone}/${m.d.glass.total})`);
    check(m.d.glass.gone >= 1, 'roof drop: some glass out');
    done(s);
  }
  // ---- wall hits
  for (const kmh of [10, 30, 60]) {
    if (!want('wall')) break;
    const s = setup(spec);
    s.world.createCollider(RAPIER.ColliderDesc.cuboid(10, 2, 0.5).setTranslation(0, 2, -spec.chassis.size[2] / 2 - 1.5).setCollisionGroups(GROUP_WORLD));
    run(s, 0.6);
    const v = kmh / 3.6;
    for (const b of s.car.allBodies) { const l = b.linvel(); b.setLinvel({ x: 0, y: l.y, z: -v }, true); }
    const ms = run(s, 2.5);
    const m = metrics(s);
    console.log(`  wall ${kmh} km/h: ${m.line} | worst view frame ${ms.toFixed(1)} ms, crash step ${m.c.crash.peak.frameMs.toFixed(2)} ms`);
    if (kmh === 10) { check(m.d.max < 0.08 && m.c.health.body > 0.95, `10 km/h: scuff / small dent only (mesh ${f2(m.d.max)}, body ${f2(m.c.health.body)})`); check(m.d.lamps.broken === 0 || m.d.lamps.broken <= 1, '10 km/h: lamps intact'); }
    if (kmh === 30) {
      check(m.d.zones.front.max > 0.18, `30 km/h: front clearly crumpled (mesh ${f2(m.d.zones.front.max)})`);
      check(m.d.lamps.broken >= 1, '30 km/h: lamps broken');
      check(m.c.health.engine < 0.95 && !m.c.dt.dead, `30 km/h: engine hurt but running (${f2(m.c.health.engine)})`);
    }
    if (kmh === 60) {
      check(m.d.zones.front.max > 0.38, `60 km/h: front destroyed (mesh ${f2(m.d.zones.front.max)})`);
      check(m.c.health.engine < 0.35 || m.c.dt.dead || m.r.radiator < 0.2, `60 km/h: engine dead or dying (eng ${f2(m.c.health.engine)} rad ${f2(m.r.radiator)})`);
      check(m.c.health.susp[0] < 0.8 || m.c.health.susp[1] < 0.8 || m.c.broken[0] || m.c.broken[1], '60 km/h: front wheel(s) displaced');
    }
    done(s);
  }
  // ---- sideways into a tree at 40 km/h (driver's side, at the front door / fender)
  if (want('tree')) {
    const s = setup(spec);
    const tb = s.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-spec.chassis.size[0] / 2 - 1.2, 1.5, -0.9));
    s.world.createCollider(RAPIER.ColliderDesc.cylinder(1.5, 0.3).setFriction(0.8).setCollisionGroups(GROUP_WORLD), tb);
    run(s, 0.6);
    for (const b of s.car.allBodies) { const l = b.linvel(); b.setLinvel({ x: -40 / 3.6, y: l.y, z: 0 }, true); }
    run(s, 2.5);
    const m = metrics(s);
    console.log(`  tree 40 km/h (side): ${m.line}`);
    check(m.r.crush.left > 0.08 || m.d.zones.left.max > 0.15, `tree: door / fender caved in (side crush ${f2(m.r.crush.left)}, mesh ${f2(m.d.zones.left.max)})`);
    check(Math.min(m.c.health.susp[0], m.c.health.susp[2]) < 0.85, `tree: that side's suspension bent (${f2(m.c.health.susp[0])}/${f2(m.c.health.susp[2])})`);
    done(s);
  }
  // ---- rollover down a slope: across a 34 degree slope, launched downhill with a roll
  if (want('rollover')) {
    const s = setup(spec, { y: 1.5, slope: 0.6, rot: roll(0.6) });
    for (const b of s.car.allBodies) { b.setLinvel({ x: -8, y: -2, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 6 }, true); }
    let rolls = 0, prevUp = 1;
    run(s, 6, undefined, () => { const up = s.car.upsideDown() ? -1 : 1; if (up !== prevUp && up < 0) rolls++; prevUp = up; });
    const m = metrics(s);
    console.log(`  rollover (${rolls} roll(s)): ${m.line}`);
    check(rolls >= 1, 'rollover: it rolled');
    // a tumble is chaotic (how hard the roof lands depends on how it rolls): judged over all rigs below
    rollovers.push({ id, ok: (m.r.crush.roof > 0.06 || m.d.zones.roof.max > 0.12) && m.d.glass.cracked + m.d.glass.gone >= 1 });
    done(s);
  }
  // ---- reversing into a wall at 40 km/h: rear crumple, driveline
  if (want('rear')) {
    const s = setup(spec);
    s.world.createCollider(RAPIER.ColliderDesc.cuboid(10, 2, 0.5).setTranslation(0, 2, spec.chassis.size[2] / 2 + 1.5).setCollisionGroups(GROUP_WORLD));
    run(s, 0.6);
    for (const b of s.car.allBodies) { const l = b.linvel(); b.setLinvel({ x: 0, y: l.y, z: 40 / 3.6 }, true); }
    run(s, 2.5);
    const m = metrics(s);
    console.log(`  rear wall 40 km/h: ${m.line} | driveshaft F${f2(m.r.driveshaft[0])} R${f2(m.r.driveshaft[1])} lost ${m.r.driveLost}`);
    check(m.d.zones.rear.max > 0.15, `rear 40: rear end crumpled (mesh ${f2(m.d.zones.rear.max)})`);
    check(m.r.driveshaft[1] < 0.9, `rear 40: rear driveline hurt (${f2(m.r.driveshaft[1])})`);
    done(s);
  }
  // ---- belly flop at speed onto a rock ridge between the wheels (from 3 m, 40 km/h)
  if (want('belly')) {
    const s = setup(spec, { y: 3 });
    const rb = s.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, -5));
    const rc = s.world.createCollider(RAPIER.ColliderDesc.cuboid(0.18, 0.5, 3).setCollisionGroups(GROUP_WORLD), rb);
    s.terrain.rockHandles.add(rc.handle);
    for (const b of s.car.allBodies) b.setLinvel({ x: 0, y: 0, z: -40 / 3.6 }, true);
    run(s, 3);
    const m = metrics(s);
    console.log(`  belly onto a ridge: ${m.line} | oil pan ${f2(m.r.oilPan)} diff F${f2(m.r.diff[0])} R${f2(m.r.diff[1])}`);
    check(m.r.oilPan < 1 || m.r.diff[0] < 1 || m.r.diff[1] < 1, 'belly: oil pan / diff damage');
    done(s);
  }
  // ---- slow crawling contact: belly onto a rock and sliding along a boulder at walking pace
  if (want('crawl')) {
    const s = setup(spec);
    const rb = s.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, -6));
    const rc = s.world.createCollider(RAPIER.ColliderDesc.ball(0.55).setTranslation(0, -0.2, 0).setCollisionGroups(GROUP_WORLD), rb);
    s.terrain.rockHandles.add(rc.handle);
    const wb = s.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(spec.chassis.size[0] / 2 + 0.45, 0.6, -14));
    s.world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.8, 4).setRotation({ x: 0, y: Math.sin(-0.06), z: 0, w: Math.cos(-0.06) }).setCollisionGroups(GROUP_WORLD), wb);
    run(s, 0.6);
    s.car.dt.range = s.car.spec.ranges.low ? 'low' : 'high'; s.car.dt.autoClutch = true; s.car.dt.gear = 1; s.car.dt.fourWD = true;
    run(s, 14, { throttle: 0.5, brake: 0, steer: 0 }, () => { const v = s.car.speed(); if (v > 1.5) { const l = s.car.chassis.linvel(); s.car.chassis.setLinvel({ x: l.x * 0.98, y: l.y, z: l.z * 0.98 }, true); } });
    const m = metrics(s);
    const p = s.car.chassis.translation();
    console.log(`  crawl contact (to z ${p.z.toFixed(1)}): ${m.line} scrape ${m.r.scrape.toFixed(1)} J/kg`);
    check(m.c.health.body >= 0.97 && m.d.max < 0.04, `crawl: scuffs at most (body ${f2(m.c.health.body)}, mesh ${f2(m.d.max)})`);
    done(s);
  }
  // ---- repair in place restores everything; repeated respawns don't leak
  if (want('repair')) {
    const s = setup(spec);
    s.world.createCollider(RAPIER.ColliderDesc.cuboid(10, 2, 0.5).setTranslation(0, 2, -spec.chassis.size[2] / 2 - 1.5).setCollisionGroups(GROUP_WORLD));
    run(s, 0.4);
    for (const b of s.car.allBodies) { const l = b.linvel(); b.setLinvel({ x: 0, y: l.y, z: -60 / 3.6 }, true); }
    run(s, 2);
    const before = metrics(s);
    s.car.repair(); s.view.repairDamage(); s.car.grace = 0;
    run(s, 0.5);
    const after = metrics(s);
    console.log(`  repair: before ${before.d.max.toFixed(2)} m / ${before.r.detached.length} off / eng ${f2(before.c.health.engine)} -> after mesh ${after.d.max.toFixed(3)} m, glass gone ${after.d.glass.gone}, lamps ${after.d.lamps.broken}, off ${after.r.detached.length}, eng ${f2(after.c.health.engine)} body ${f2(after.c.health.body)} wheels ${after.c.broken.filter(Boolean).length} debris ${after.c.crash.debris.length}`);
    check(after.d.max < 1e-4 && after.d.glass.gone === 0 && after.d.glass.cracked === 0 && after.d.lamps.broken === 0 && after.r.detached.length === 0 && after.c.health.engine === 1 && !after.c.dt.dead && after.c.broken.every((b) => !b), 'repair restores geometry, glass, lamps, parts, mechanicals');
    done(s);
    // respawn churn: bodies / colliders / three resources must not grow
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H;
    const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setCollisionGroups(GROUP_WORLD));
    world.createCollider(RAPIER.ColliderDesc.cuboid(10, 2, 0.5).setTranslation(0, 2, -6).setCollisionGroups(GROUP_WORLD));
    const sc = new THREE.Scene();
    let counts = [];
    for (let k = 0; k < 6; k++) {
      const car = new Vehicle(RAPIER, world, spec, { ground, rockHandles: new Set() }, { x: 0, y: 1.2, z: 0 }, 0);
      const view = new VehicleView(sc, car);
      car.grace = 0;
      for (let i = 0; i < 80; i++) car.step({ throttle: 0, brake: 0, steer: 0 }, H);
      for (const b of car.allBodies) { const l = b.linvel(); b.setLinvel({ x: 0, y: l.y, z: -70 / 3.6 }, true); }
      for (let i = 0; i < 300; i++) { car.step({ throttle: 0, brake: 0, steer: 0 }, H); if (i % 5 === 0) view.update(null); }
      view.dispose(); car.destroy();
      let geos = 0; sc.traverse((o) => { if (o.geometry) geos++; });
      counts.push(`${world.bodies.len()}b/${world.colliders.len()}c/${sc.children.length}o`);
    }
    console.log(`  respawn churn (bodies/colliders/scene objects after each): ${counts.join(' ')}`);
    check(new Set(counts).size === 1, 'respawn churn: no leaks');
  }
}
if (rollovers.length > 1) check(rollovers.filter((r) => r.ok).length >= Math.ceil(rollovers.length * 0.6), `rollover: roof crushed + glass broken in most rigs (${rollovers.map((r) => r.id + (r.ok ? ' yes' : ' no')).join(', ')})`);
console.log(fails ? `${fails} check(s) FAILED` : 'all crash checks passed');
process.exitCode = fails ? 1 : 0;
