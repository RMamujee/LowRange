// Garage builds: every rig with stock / min / max / soft-and-heavy options must settle at a sane
// ride height, drive, and climb a ledge without the sim blowing up.
import RAPIER from '@dimforge/rapier3d-compat';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
import { applyBuild, buildOptions, defaultBuild, sanitizeBuild, isStock, stats } from '../src/garage.js';
await RAPIER.init();
const H = 1 / 200;
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log('  FAIL', msg); } };

// pure-data checks
for (const base of VEHICLES) {
  const before = JSON.stringify(base);
  const opts = buildOptions(base);
  const pick = (f) => Object.fromEntries(opts.flatMap((g) => g.items).map((it) => [it.key, f(it.choices).value]));
  applyBuild(base, pick((c) => c[c.length - 1]));
  check(JSON.stringify(base) === before, `${base.id}: applyBuild mutated the base spec`);
  check(isStock(base, defaultBuild(base)) && isStock(base, {}) && isStock(base, { tyreSize: 99, tread: 'slick', final: 1.234 }), `${base.id}: stale values should sanitize to stock`);
  check(JSON.stringify(applyBuild(base, {})) !== before && applyBuild(base, {}).final === base.final, `${base.id}: stock build differs from base`);
  const s0 = stats(base);
  check(Object.values(s0).every((x) => typeof x === 'string' || Number.isFinite(x)), `${base.id}: stats not finite`);
}

function builds(base) {
  const items = buildOptions(base).flatMap((g) => g.items);
  const pick = (f) => Object.fromEntries(items.map((it) => [it.key, f(it.choices).value]));
  const min = pick((c) => c[0]), max = pick((c) => c[c.length - 1]);
  return { stock: defaultBuild(base), min, max, softHeavy: { ...max, springs: 'soft', damping: 'soft' } };
}

function setup(spec, ledge) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
  const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUP_WORLD));
  const rockHandles = new Set();
  if (ledge) { const h = ledge; const c = world.createCollider(RAPIER.ColliderDesc.cuboid(5, h / 2, 10).setTranslation(0, h / 2, -16).setFriction(1).setCollisionGroups(GROUP_WORLD)); rockHandles.add(c.handle); }
  const car = new Vehicle(RAPIER, world, spec, { ground, rockHandles }, { x: 0, y: spec.tire.radius - spec.axleY + 0.05, z: 0 }, 0);
  return car;
}
const finite = (car) => car.allBodies.every((b) => { const p = b.translation(), v = b.linvel(); return [p.x, p.y, p.z, v.x, v.y, v.z].every(Number.isFinite); });
const run = (car, secs, inp) => { for (let i = 0; i < Math.round(secs / H); i++) car.step(inp, H); };

for (const base of VEHICLES) {
  for (const [name, b] of Object.entries(builds(base))) {
    const spec = applyBuild(base, b);
    const st = stats(spec);
    const tag = `${base.id}/${name}`.padEnd(15);
    // 1. settle on flat ground: ride height = tyre radius - axleY (suspension at its static point)
    let car = setup(spec);
    run(car, 2.5, { throttle: 0, brake: 1, steer: 0 });
    const want = spec.tire.radius - spec.axleY;
    const y = car.chassis.translation().y;
    check(finite(car), `${tag} NaN after settling`);
    check(Math.abs(y - want) < 0.1, `${tag} ride height ${y.toFixed(3)} vs ${want.toFixed(3)}`);
    check(!car.upsideDown(), `${tag} not upright at rest`);
    // 2. drive: crawl in 1st (low if fitted), then high range 2nd flat out
    const d = car.dt;
    if (spec.ranges.low) d.range = 'low';
    d.gear = 1;
    const z0 = car.chassis.translation().z;
    run(car, 4, { throttle: 0.6, brake: 0, steer: 0 });
    const crawlM = z0 - car.chassis.translation().z;
    d.range = 'high'; d.gear = 2;
    run(car, 4, { throttle: 1, brake: 0, steer: 0.2 });
    const kmh = car.speed() * 3.6;
    check(finite(car), `${tag} NaN while driving`);
    check(crawlM > 1, `${tag} only crawled ${crawlM.toFixed(2)} m in 4 s`);
    check(kmh > 5 && kmh < 200, `${tag} high-range speed ${kmh.toFixed(1)} km/h`);
    check(!car.upsideDown(), `${tag} rolled while driving`);
    car.destroy();
    // 3. ledge of 0.6 x tyre radius, lockers in, crawl gear
    car = setup(spec, 0.6 * spec.tire.radius);
    run(car, 1, { throttle: 0, brake: 0, steer: 0 });
    car.dt.range = spec.ranges.low ? 'low' : 'high'; car.dt.gear = 1; car.dt.lockF = spec.lockers.front; car.dt.lockR = spec.lockers.rear;
    let vmax = 0;
    const past = () => car.chassis.translation().z < -6 - spec.wheelbase;
    for (let k = 0; k < 80 && !past(); k++) { run(car, 0.25, { throttle: 0.35, brake: 0, steer: 0 }); vmax = Math.max(vmax, Math.abs(car.speed() * 3.6)); }
    const pz = car.chassis.translation().z;
    const cleared = past();
    check(finite(car), `${tag} NaN on the ledge`);
    check(vmax < 40, `${tag} ledge run reached ${vmax.toFixed(1)} km/h (sim blew up?)`);
    check(!car.upsideDown(), `${tag} flipped on the ledge`);
    console.log(tag, `ride ${y.toFixed(3)}/${want.toFixed(3)} m · crawl ${crawlM.toFixed(1)} m · H2 ${kmh.toFixed(0)} km/h · ledge ${cleared ? 'cleared' : 'stuck z=' + pz.toFixed(1)} · ${Math.round(st.weight)} kg ${st.powerKW.toFixed(0)} kW ${st.crawl.toFixed(0)}:1 ${st.tyreIn.toFixed(0)}" clr ${(st.clearance * 100).toFixed(0)} cm`);
    car.destroy();
  }
}
// tread compounds change grip per surface; armour cuts damage from a wall hit
{
  const base = VEHICLES.find((v) => v.id === 'lc70');
  const grip = (tread, mat) => setup(applyBuild(base, { tread })).tyreGrip(mat, false).mu;
  check(grip('mt', 3) > grip('at', 3) && grip('at', 6) > grip('mt', 6) && grip('rock', 2) > grip('at', 2), 'tread grip ordering (MT mud, AT road, rock compound rock)');
  const wall = (build) => {
    const spec = applyBuild(base, build);
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H;
    const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setCollisionGroups(GROUP_WORLD));
    world.createCollider(RAPIER.ColliderDesc.cuboid(10, 2, 0.5).setTranslation(0, 2, -12).setCollisionGroups(GROUP_WORLD));
    const car = new Vehicle(RAPIER, world, spec, { ground, rockHandles: new Set() }, { x: 0, y: spec.tire.radius - spec.axleY + 0.05, z: 0 }, 0);
    run(car, 1, { throttle: 0, brake: 0, steer: 0 });
    for (const bd of car.allBodies) { const l = bd.linvel(); bd.setLinvel({ x: 0, y: l.y, z: -30 / 3.6 }, true); }
    run(car, 3, { throttle: 0, brake: 0, steer: 0 });
    return car.health;
  };
  const h0 = wall({}), h1 = wall({ bumpers: true });
  console.log(`wall 30 km/h: stock body ${h0.body.toFixed(2)} engine ${h0.engine.toFixed(2)} | bumpers body ${h1.body.toFixed(2)} engine ${h1.engine.toFixed(2)}`);
  check(h1.body > h0.body && h1.engine > h0.engine, 'bumpers should reduce wall damage');
}
console.log(fails ? `${fails} FAILURES` : 'garage: all checks passed');
process.exit(fails ? 1 : 0);
