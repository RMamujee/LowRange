// Spawn points (src/spawns.js), checked in a headless physics world: for the map, build the spawn
// list exactly as the game does, then for every rig drop a fresh truck at every spawn point (the
// same height and pose main.js respawnFresh uses), hold it on the parking brake in neutral for 3 s
// and assert: not flipped, at rest (under 3 cm in the last 0.5 s: the Cruiser idles with a few cm/s of chassis shimmy even on flat ground), no damage, all four wheels on the ground. Before that, a
// Rapier shape query over the footprint asserts no rock / tree / prop collider is in the way.
// Also: the list is deterministic, ids are unique, saved ids are validated, and 40 teleports leave
// the body / collider counts where they started (no leaks).
// usage: MAP=park|race|crawl node test/spawns.mjs [rigs=taco,lc70,wrx]   (no MAP: runs all three)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.MAP) {
  let failed = 0;
  for (const m of ['park', 'race', 'crawl']) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env: { ...process.env, MAP: m }, stdio: 'inherit' });
    if (r.status !== 0) failed++;
  }
  console.log(failed ? `${failed} map(s) FAILED` : 'all maps passed');
  process.exit(failed ? 1 : 0);
}

const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
const T = await import('../src/terrain.js');
const S = await import('../src/spawns.js');
const { VEHICLES } = await import('../src/specs.js');
const { Vehicle } = await import('../src/vehicle.js');
await RAPIER.init();

const rigs = (process.argv[2] || 'taco,lc70,wrx').split(',');
let fails = 0;
const check = (ok, msg) => { if (!ok) { console.log('  FAIL', msg); fails++; } return ok; };
console.log(`${T.MAP_NAME} (${T.MAP_ID})`);

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = 1 / 200; world.numSolverIterations = 8;
const rocks = T.generateRocks(), trees = T.generateTrees(rocks);
const terrain = T.buildTerrainPhysics(RAPIER, world, rocks, trees);
world.step();

const warns = [];
const list = S.buildSpawnPoints({ rocks, trees, warn: (m) => warns.push(m) });
warns.forEach((w) => console.log('  warn', w));
// structure
const ids = list.map((s) => s.id);
check(new Set(ids).size === ids.length, `unique ids (${ids.join(', ')})`);
check(list.filter((s) => s.default).length === 1 && list[0].default, 'exactly one default, listed first');
check(list.every((s) => typeof s.name === 'string' && s.name && Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.yaw) && !s.unsafe), 'every point has a name and a finite, checked pose');
const again = S.buildSpawnPoints({ rocks, trees, warn: () => {} });
check(JSON.stringify(again) === JSON.stringify(list), 'deterministic: same list on a second build');
const minimum = { park: 6, race: 7, crawl: 14 }[T.MAP_ID];
check(list.length >= minimum, `at least ${minimum} spawn points (${list.length})`);
if (T.MAP_ID === 'crawl') check(T.TRAILS[0].stages.every((st) => ids.includes(`stage-${st.n}`)) && ids.includes('summit') && ids.includes('bypass'), 'every stage gate, the summit and the bypass start');
if (T.MAP_ID === 'race') check(T.CHECKPOINTS.slice(1).every((c) => ids.includes(`cp-${c.i}`)) && ids.includes('grid') && ids.includes('paddock'), 'grid, paddock and every checkpoint');
if (T.MAP_ID === 'park') check(T.TRAILS.every((t, i) => list.some((s) => s.trail === i)), 'every trail has at least one end');
// saved ids: unknown / corrupt fall back to the default
S.saveLastSpawn({ id: 'no-such-spawn' });
check(S.loadLastSpawn(list).id === list[0].id, 'unknown saved id falls back to the default');
S.saveLastSpawn(list.at(-1));
check(S.loadLastSpawn(list).id === list.at(-1).id, 'a valid saved id is restored');

// trail spawns sit outside their gate and face it (driving forward enters it)
for (const sp of list.filter((s) => s.kind === 'trail')) {
  const t = T.TRAILS[sp.trail], g = T.pathPoint(t, sp.end ? t.length - 3 : 3), R = t.width / 2 + 2.5;
  const d = Math.hypot(g.x - sp.x, g.z - sp.z), fx = -Math.sin(sp.yaw), fz = -Math.cos(sp.yaw);
  const facing = ((g.x - sp.x) * fx + (g.z - sp.z) * fz) / d;
  check(d > R && d < R + 16 && facing > 0.95, `${sp.name}: ${d.toFixed(1)} m from the gate (radius ${R}), facing it (${facing.toFixed(2)})`);
}
if (T.MAP_ID === 'crawl') for (const sp of list.filter((s) => s.kind === 'stage')) {
  // ahead of the truck, the course reaches the stage gate: project onto the trail
  const st = T.TRAILS[0].stages[sp.stage - 1];
  let bi = 0, bd = Infinity; T.TRAILS[0].pts.forEach((p, i) => { const d = (p.x - sp.x) ** 2 + (p.z - sp.z) ** 2; if (d < bd) { bd = d; bi = i; } });
  const s = T.TRAILS[0].pts[bi].s, onTrail = Math.sqrt(bd) < 3;
  check(!onTrail || (s < st.gateS && s > st.gateS - 20), `${sp.name}: ${onTrail ? `${(st.gateS - s).toFixed(1)} m before its gate on the trail` : 'on the bypass spur'}`);
}

// footprint clear of colliders (Rapier query, no vehicle in the world yet)
const box = new RAPIER.Cuboid(S.FOOT.hw, 0.9, S.FOOT.hl);
for (const sp of list) {
  const y = T.heightAt(sp.x, sp.z) + 1.0;
  let hit = null;
  world.intersectionsWithShape({ x: sp.x, y, z: sp.z }, { x: 0, y: Math.sin(sp.yaw / 2), z: 0, w: Math.cos(sp.yaw / 2) }, box, (c) => { hit = c; return false; }, undefined, undefined, terrain.ground);
  check(!hit, `${sp.name}: footprint clear of colliders${hit ? ` (hit collider at ${JSON.stringify(hit.translation())})` : ''}`);
}

// drop every rig at every point and let it settle on the parking brake
const hold = { throttle: 0, brake: 0, steer: 0, handbrake: true };
const rows = [];
for (const id of rigs) {
  const spec = VEHICLES.find((v) => v.id === id);
  if (!check(!!spec, `rig ${id} exists`)) continue;
  for (const sp of list) {
    const y = T.heightAt(sp.x, sp.z) + spec.tire.radius - spec.axleY + S.liftFor(sp, spec); // as main.js spawnAt -> respawnFresh
    const car = new Vehicle(RAPIER, world, spec, terrain, { x: sp.x, y, z: sp.z }, sp.yaw);
    car.dt.gear = 0; // (the game's 1.5 s spawn grace applies, as in respawnFresh)
    for (let i = 0; i < 500; i++) car.step(hold, 1 / 200);
    const p0 = { ...car.chassis.translation() };
    for (let i = 0; i < 100; i++) car.step(hold, 1 / 200);
    const p1 = car.chassis.translation(), v = car.chassis.linvel(), att = car.attitude();
    const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z), speed = Math.hypot(v.x, v.y, v.z);
    const h = car.health, healthy = h.engine === 1 && h.body === 1 && h.tire.every((x) => x === 1) && h.susp.every((x) => x === 1) && !car.broken.some(Boolean);
    const grounded = car.wheelState.filter((w) => w.grounded).length;
    const drift = Math.hypot(p1.x - sp.x, p1.z - sp.z);
    const ok = !car.upsideDown() && Math.abs(att.roll) < 0.3 && Math.abs(att.pitch) < 0.3 && moved < 0.03 && speed < 0.08 && healthy && grounded === 4 && drift < 1.0;
    check(ok, `${id} @ ${sp.name}: roll ${(att.roll * 57.3).toFixed(1)}° pitch ${(att.pitch * 57.3).toFixed(1)}° moved ${moved.toFixed(3)} m in the last 0.5 s, speed ${speed.toFixed(3)}, wheels down ${grounded}/4, healthy ${healthy ? 'yes' : JSON.stringify(h)}, ${drift.toFixed(2)} m from the point`);
    rows.push([id, sp.id, (att.roll * 57.3).toFixed(1), (att.pitch * 57.3).toFixed(1), moved.toFixed(3), grounded]);
    car.destroy();
  }
}
console.log(`  ${list.length} spawn points x ${rigs.length} rigs settled (${rows.length} drops)`);

// no leaks: 40 teleports with the same truck (respawnFresh = destroy + new Vehicle)
{
  const count = () => { let b = 0, c = 0; world.forEachRigidBody(() => b++); world.forEachCollider(() => c++); return [b, c]; };
  const spec = VEHICLES.find((v) => v.id === rigs[0]);
  const before = count();
  let car = new Vehicle(RAPIER, world, spec, terrain, { x: list[0].x, y: T.heightAt(list[0].x, list[0].z) + 2, z: list[0].z }, list[0].yaw);
  for (let k = 0; k < 40; k++) {
    const sp = list[k % list.length];
    car.destroy();
    car = new Vehicle(RAPIER, world, spec, terrain, { x: sp.x, y: T.heightAt(sp.x, sp.z) + spec.tire.radius - spec.axleY + 0.3, z: sp.z }, sp.yaw);
    for (let i = 0; i < 10; i++) car.step(hold, 1 / 200);
  }
  const during = count();
  car.destroy();
  const after = count();
  check(after[0] === before[0] && after[1] === before[1], `no leaked bodies / colliders after 40 teleports (before ${before}, with truck ${during}, after ${after})`);
}

console.log(fails ? `  ${fails} FAILED` : '  all passed');
process.exit(fails ? 1 : 0);
