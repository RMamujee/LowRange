// Coralume Island (src/maps/jungle.js) by the numbers: road and crawl lengths, climbs and grades on
// the baked ground, every junction (path ends meet the road they join with no step or drop), the
// bridges (deck level with the road at both ends; wheel lines and a driven pass), the muddy dips (the shared
// mud field: parked, driven), the Ember Stairs step-ups against the measured
// climbing limit, the sea edge (deep water all round, nothing dry at the map border) and the grid
// itself (no NaN). Exits non-zero if a limit is broken.
// usage: node test/junglecheck.mjs
process.env.MAP = 'jungle';
const t0 = Date.now();
const T = await import('../src/terrain.js');
const tBake = Date.now() - t0;
import RAPIER from '@dimforge/rapier3d-compat';
const { MAP, ROADS, TRAILS, GRID, SIZE, RES, heightAt, materialAt, MAT, pathPoint } = T;
await RAPIER.init();
let fail = 0;
const bad = (msg) => { fail++; console.log('  FAIL ' + msg); };
const onBridge = (p, s) => (p.bridges || []).some((b) => s > b.s0 - 1 && s < b.s1 + 1);

console.log(`${T.MAP_NAME}: ${SIZE} m square, ${RES + 1}^2 grid; bake ${tBake} ms`);
// ---- the grid: finite, and the sea all round the border ----
let nan = 0, dryEdge = 0, minEdge = 0;
for (let i = 0; i < GRID.h.length; i++) if (!Number.isFinite(GRID.h[i])) nan++;
for (let k = 0; k <= RES; k++) for (const [ix, iz] of [[k, 0], [k, RES], [0, k], [RES, k]]) { const h = GRID.h[ix * (RES + 1) + iz]; if (h > -2) dryEdge++; minEdge = Math.max(minEdge, h); }
console.log(`grid: ${nan} NaN, border shallowest ${(-minEdge).toFixed(1)} m deep`);
if (nan) bad(`${nan} NaN heights`);
if (dryEdge) bad(`${dryEdge} border cells shallower than 2 m (the sea must be the edge)`);

// ---- paths: lengths, climbs, steepest grade on the baked ground (over 3 m along the centre, so a pothole or
// a ledge ramp under its slab is not a grade; water crossings skipped) ----
// (the profile limits plus the surface's own relief: washboard, ruts, potholes, crawl lumps)
const LIMIT = { paved: 0.145, dirt: 0.26, track: 0.3, sand: 0.18, green: 0.32, blue: 0.45, black: 0.48, dblack: 0.5 };
const km = { paved: 0, dirt: 0, track: 0, sand: 0, crawl: 0 };
console.log(' path                     kind     length  climb  steepest(ground)  road-vs-ground');
for (const p of [...ROADS, ...TRAILS]) {
  const kind = p.kind === 'trail' ? p.diff : p.surface;
  let gmax = 0, gAt = 0, dev = 0, dAt = 0;
  for (let s = 1; s < p.length - 3; s += 1) {
    if (onBridge(p, s) || onBridge(p, s + 3)) continue;
    const a = pathPoint(p, s), b = pathPoint(p, s + 3);
    if ([a, b].some((q) => [MAT.WATER, MAT.MUD].includes(materialAt(q.x, q.z)))) continue; // (fords, bog sink edges)
    const g = Math.abs(heightAt(b.x, b.z) - heightAt(a.x, a.z)) / Math.hypot(b.x - a.x, b.z - a.z);
    if (g > gmax) { gmax = g; gAt = s; }
    const d = heightAt(a.x, a.z) - a.h;
    const nearMud = (p.fords || []).some((sf) => Math.abs(s - sf) < 10) || [-2, 0, 2].some((k) => { const c = pathPoint(p, s + k); return [MAT.MUD, MAT.WATER].includes(materialAt(c.x, c.z)); });
    // (fords and bogs are dips by design; junction mouths, the first / last 35 m, blend with the host road's shoulders: checked below)
    if (Math.abs(d) > Math.abs(dev) && p.kind === 'road' && !nearMud && (p.closed || (s > 35 && s < p.length - 35))) { dev = d; dAt = s; }
  }
  const climb = Math.max(...p.pts.map((q) => q.h)) - Math.min(...p.pts.map((q) => q.h));
  console.log(` ${p.name.padEnd(24)} ${kind.padEnd(7)} ${p.length.toFixed(0).padStart(6)} m ${climb.toFixed(0).padStart(5)} m  ${(gmax * 100).toFixed(0).padStart(4)}% @${gAt.toFixed(0).padStart(4)}     ${p.kind === 'road' ? dev.toFixed(2) + ' @' + dAt.toFixed(0) : ''}`);
  if (gmax > LIMIT[kind]) bad(`${p.name}: ${(gmax * 100).toFixed(0)}% at s=${gAt.toFixed(0)} is steeper than ${(LIMIT[kind] * 100).toFixed(0)}% for ${kind}`);
  if (p.kind === 'road' && Math.abs(dev) > 0.35) bad(`${p.name}: the ground strays ${dev.toFixed(2)} m from the road profile at s=${dAt.toFixed(0)}`);
  if (p.kind === 'trail') km.crawl += p.length; else km[p.surface] += p.length;
}
console.log(`totals: paved ${(km.paved / 1000).toFixed(2)} km, dirt ${(km.dirt / 1000).toFixed(2)} km, two-track ${(km.track / 1000).toFixed(2)} km, sand ${(km.sand / 1000).toFixed(2)} km, crawls ${(km.crawl / 1000).toFixed(2)} km`);

// ---- junctions: each joined end sits on its host's surface, and the ground has no step on the way in ----
console.log('junctions (end: host, biggest step on the baked ground from the host\'s centre line into the path, steepest grade in the first / last 20 m):');
for (const p of [...ROADS, ...TRAILS]) {
  if (p.closed) continue;
  for (const end of [0, 1]) {
    if ((end ? p.end : p.start) === 'free') continue;
    const q = end ? p.pts.at(-1) : p.pts[0];
    const host = [...ROADS, ...TRAILS].find((h) => h !== p && h.pts.some((pt) => Math.hypot(pt.x - q.x, pt.z - q.z) < h.width / 2 + 3))
      || MAP.PADS.find((pd) => Math.hypot(pd.x - q.x, pd.z - q.z) < pd.r + 2);
    if (!host) { bad(`${p.name} ${end ? 'end' : 'start'} joins nothing`); continue; }
    // the host's own baked surface: walk the ground from the host's centre line (or the pad's middle)
    // out to the path's end and 8 m into it, every 0.25 m; a step is a jump between neighbours
    let c = null;
    if (host.pts) for (const pt of host.pts) { const d = Math.hypot(pt.x - q.x, pt.z - q.z); if (!c || d < c.d) c = { d, x: pt.x, z: pt.z }; }
    else c = { x: host.x, z: host.z };
    const line = [];
    const seg = (ax, az, bx, bz) => { const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 0.25)); for (let k = 0; k <= n; k++) line.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]); };
    seg(c.x, c.z, q.x, q.z);
    for (let k = 0.25; k <= 8; k += 0.25) { const a = pathPoint(p, end ? p.length - k : k); line.push([a.x, a.z]); }
    let step = 0;
    for (let k = 1; k < line.length; k++) { const [ax, az] = line[k - 1], [bx, bz] = line[k]; if (materialAt(ax, az) === MAT.WATER) continue; step = Math.max(step, Math.abs(heightAt(bx, bz) - heightAt(ax, az))); }
    let worst = 0;
    for (let k = 0; k < 20; k += 0.5) {
      const s0 = end ? p.length - k - 2 : k, a = pathPoint(p, s0), b = pathPoint(p, s0 + 2);
      if (materialAt(a.x, a.z) === MAT.WATER) continue;
      worst = Math.max(worst, Math.abs(heightAt(b.x, b.z) - heightAt(a.x, a.z)) / 2);
    }
    const lim = p.kind === 'trail' ? 0.5 : 0.28;
    console.log(`  ${(p.name + (end ? ' end' : ' start')).padEnd(30)} ${(host.name || '?').padEnd(18)} step ${step.toFixed(2)} m  steepest ${(worst * 100).toFixed(0)}%`);
    if (step > 0.12) bad(`${p.name} ${end ? 'end' : 'start'}: ${step.toFixed(2)} m step between ${host.name} and the path`);
    if (worst > lim) bad(`${p.name} ${end ? 'end' : 'start'}: ${(worst * 100).toFixed(0)}% in the junction's last 20 m`);
  }
}

// ---- bridges: the deck meets the road surface at both ends ----
for (const b of MAP.DECOR.bridges) {
  const r = ROADS.find((q) => q.name === b.road);
  for (const s of [b.s0 - 1.5, b.s1 + 1.5]) {
    const p = pathPoint(r, s), g = heightAt(p.x, p.z);
    const deck = b.segs.reduce((best, d) => (Math.hypot(d.x - p.x, d.z - p.z) < Math.hypot(best.x - p.x, best.z - p.z) ? d : best));
    const top = deck.y + deck.hy, step = top - g;
    console.log(`bridge on ${b.road} s ${b.s0.toFixed(0)}-${b.s1.toFixed(0)}: deck top ${top.toFixed(2)} vs ground ${g.toFixed(2)} at s=${s.toFixed(0)}`);
    if (Math.abs(step) > 0.2) bad(`bridge on ${b.road}: ${step.toFixed(2)} m step at s=${s.toFixed(0)}`);
  }
}

// ---- Ember Stairs: every step-up's real lip over the tread, against the Cruiser's measured limit ----
// (test/stairgrade.mjs lc70: 0.6 m up to a 28% tread; less on steeper treads)
const stepCap = (g) => (g <= 0.285 ? 0.6 : g < 0.33 ? 0.6 - ((g - 0.285) / 0.045) * 0.3 : 0.3);
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const rocks = T.generateRocks();
const terrain = T.buildTerrainPhysics(RAPIER, world, rocks, T.generateTrees(rocks));
world.step();
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
const surf = (x, z) => { const g = heightAt(x, z); ray.origin = { x, y: g + 6, z }; const hit = world.castRay(ray, 8, true, undefined, undefined, undefined, undefined, (c) => terrain.rockHandles.has(c.handle)); return Math.max(g, hit ? g + 6 - hit.timeOfImpact : -1e9); };
for (const r of rocks.filter((q) => q.step)) {
  const t = TRAILS.find((q) => q.name === r.step.trail), { s, rise, grade } = r.step;
  const hs = [-1, 0, 1].map((lat) => { const a = pathPoint(t, s - 0.7), b = pathPoint(t, s + 0.25); return surf(b.x - b.tz * lat, b.z + b.tx * lat) - surf(a.x - a.tz * lat, a.z + a.tx * lat) - grade * 0.95; });
  const cap = stepCap(grade);
  console.log(`  ${t.name} step @${s.toFixed(1)} rise ${rise.toFixed(2)}: lip ${hs.map((h) => h.toFixed(2)).join('/')} on ${(grade * 100).toFixed(0)}% (cap ${cap.toFixed(2)})`);
  if (Math.min(...hs) > cap) bad(`${t.name} step at s=${s.toFixed(1)}: ${Math.min(...hs).toFixed(2)} m over cap ${cap.toFixed(2)}`);
}
// ---- bridges, driven: the surface under each wheel line (ground or deck, whichever is higher) has
// no step across either deck end and for 20 m either side; a short scripted pass at 60 and 90 km/h
// with the Cruiser and the Rally Sedan keeps the roll small ----
const top = (x, z) => { ray.origin = { x, y: heightAt(x, z) + 4, z }; const hit = world.castRay(ray, 8, true); return hit ? heightAt(x, z) + 4 - hit.timeOfImpact : heightAt(x, z); };
for (const b of MAP.DECOR.bridges) {
  const r = ROADS.find((q) => q.name === b.road);
  for (const lat of [-2.6, -0.9, 0.9, 2.6]) {
    let worst = 0, at = 0, prev = null;
    for (let s = b.s0 - 20; s <= b.s1 + 20; s += 0.25) {
      const p = pathPoint(r, s), h = top(p.x - p.tz * lat, p.z + p.tx * lat) - p.h;
      if (prev !== null && Math.abs(h - prev) > worst) { worst = Math.abs(h - prev); at = s; }
      prev = h;
    }
    console.log(`bridge on ${b.road}, wheel line ${lat} m: biggest step ${(worst * 100).toFixed(1)} cm at s=${at.toFixed(1)}`);
    if (worst > 0.06) bad(`bridge on ${b.road}: ${(worst * 100).toFixed(1)} cm step on the ${lat} m wheel line at s=${at.toFixed(1)}`);
  }
}
{
  const { ALL_VEHICLES } = await import('../src/specs.js');
  const { Vehicle } = await import('../src/vehicle.js');
  world.timestep = 1 / 200; world.numSolverIterations = 8;
  for (const b of MAP.DECOR.bridges) for (const id of ['lc70', 'wrx']) for (const vt of [60 / 3.6, 90 / 3.6]) {
    const r = ROADS.find((q) => q.name === b.road), spec = ALL_VEHICLES.find((v) => v.id === id), sA = b.s0 - 90, p0 = pathPoint(r, sA);
    const car = new Vehicle(RAPIER, world, spec, terrain, { x: p0.x, y: heightAt(p0.x, p0.z) + spec.tire.radius - spec.axleY + 0.4, z: p0.z }, Math.atan2(-p0.tx, -p0.tz));
    const d = car.dt; d.range = 'high'; d.fourWD = true; d.autoClutch = true; d.gear = 1;
    const inp = { throttle: 0, brake: 0, steer: 0 };
    let s = sA, roll = 0;
    for (let i = 0; i < 40 * 200 && s < b.s1 + 30; i++) {
      if (i % 10 === 0) {
        const p = car.chassis.translation();
        let bs = s, bd = 1e9; for (let q = s - 5; q < s + 15; q += 0.25) { const f = pathPoint(r, q); const dd = Math.hypot(f.x - p.x, f.z - p.z); if (dd < bd) { bd = dd; bs = q; } } s = bs;
        const v = car.speed(), look = pathPoint(r, s + 5 + Math.abs(v) * 0.6), att = car.attitude();
        let err = Math.atan2(-(look.x - p.x), -(look.z - p.z)) - att.heading; err = Math.atan2(Math.sin(err), Math.cos(err));
        inp.steer = Math.max(-1, Math.min(1, err * 2.5));
        inp.throttle = v < vt - 1 ? 1 : v < vt ? 0.4 : 0; inp.brake = v > vt + 2 ? 0.6 : 0;
        if (d.rpm > spec.engine.redline * 0.9 && d.gear < spec.gears.length) d.gear++; else if (d.rpm < spec.engine.peakRpm * 0.45 && d.gear > 1) d.gear--;
        if (s > b.s0 - 25) roll = Math.max(roll, Math.abs(att.roll));
      }
      car.step(inp, 1 / 200);
    }
    const lim = vt < 20 ? 12 : 16;
    console.log(`bridge on ${b.road}: ${id} at ${(vt * 3.6).toFixed(0)} km/h, worst roll ${(roll * 57.3).toFixed(1)} deg from 25 m before the deck to 30 m past it`);
    if (roll * 57.3 > lim || s < b.s1 + 30) bad(`bridge on ${b.road}: ${id} at ${(vt * 3.6).toFixed(0)} km/h rolled ${(roll * 57.3).toFixed(1)} deg (limit ${lim})${s < b.s1 + 30 ? ' and did not get across' : ''}`);
    car.destroy();
  }
}
// ---- mud: Plantation Road's muddy dips are bog cells, so the shared deformable mud (src/mud.js) covers
// them: a parked Cruiser (parking brake, neutral) settles and sits still, and in 4-Low with its
// lockers it drives through ----
{
  const { ALL_VEHICLES } = await import('../src/specs.js');
  const { Vehicle } = await import('../src/vehicle.js');
  const P = ROADS.find((q) => q.name === 'Plantation Road'), [m0, m1] = P.mud[0], spec = ALL_VEHICLES.find((v) => v.id === 'lc70');
  const bogCells = (() => { let n = 0; for (let i = 0; i < GRID.mat.length; i++) if (GRID.mat[i] === MAT.MUD) n++; return n; })();
  console.log(`mud: ${bogCells} bog cells, ${terrain.mud ? 'mud field on' : 'NO mud field'}`);
  if (!terrain.mud || !bogCells) bad('the muddy dips are not bog cells under the shared mud field');
  const place = (s) => { const p = pathPoint(P, s); return new Vehicle(RAPIER, world, spec, terrain, { x: p.x, y: T.visualHeightAt(p.x, p.z) + spec.tire.radius - spec.axleY + 0.15, z: p.z }, Math.atan2(-p.tx, -p.tz)); };
  {
    const car = place(P.length * (m0 + m1) / 2);
    car.dt.gear = 0;
    for (let i = 0; i < 1000; i++) car.step({ throttle: 0, brake: 1, steer: 0 }, 1 / 200);
    const inp = { throttle: 0, brake: 0, steer: 0, handbrake: true };
    let p5 = null, y10 = 0, yLo = 1e9, yHi = -1e9;
    for (let i = 0; i < 20 * 200; i++) {
      car.step(inp, 1 / 200);
      const p = car.chassis.translation();
      if (i === 5 * 200) p5 = { ...p };
      if (i === 10 * 200) y10 = p.y;
      if (i >= 15 * 200) { yLo = Math.min(yLo, p.y); yHi = Math.max(yHi, p.y); }
    }
    const p = car.chassis.translation(), creep = Math.hypot(p.x - p5.x, p.z - p5.z), sank = y10 - p.y, sink = car.wheelState.reduce((a, w) => a + w.sink, 0) / 4;
    console.log(`mud: parked Cruiser in Plantation Road's first dip, 20 s: sinkage ${sink.toFixed(3)} m, creep after 5 s ${(creep * 1000).toFixed(1)} mm, sank ${(sank * 1000).toFixed(1)} mm from 10 to 20 s, bounce ${((yHi - yLo) * 1000).toFixed(1)} mm`);
    if (!(creep < 0.02 && Math.abs(sank) < 0.01 && yHi - yLo < 0.005 && sink > 0)) bad('parked in the Plantation dip the Cruiser does not settle and sit still');
    car.destroy();
  }
  {
    const sA = P.length * m0 - 25, car = place(sA), d = car.dt;
    d.range = 'low'; d.fourWD = true; d.lockF = true; d.lockR = true; d.gear = 1;
    const inp = { throttle: 0.6, brake: 0, steer: 0 };
    let s = sA;
    for (let i = 0; i < 60 * 200 && s < P.length * m1 + 10; i++) {
      if (i % 10 === 0) {
        const p = car.chassis.translation();
        let bs = s, bd = 1e9; for (let q = s - 4; q < s + 8; q += 0.25) { const f = pathPoint(P, q); const dd = Math.hypot(f.x - p.x, f.z - p.z); if (dd < bd) { bd = dd; bs = q; } } s = bs;
        const look = pathPoint(P, s + 6), att = car.attitude();
        let err = Math.atan2(-(look.x - p.x), -(look.z - p.z)) - att.heading; err = Math.atan2(Math.sin(err), Math.cos(err));
        inp.steer = Math.max(-1, Math.min(1, err * 2.2));
      }
      car.step(inp, 1 / 200);
    }
    console.log(`mud: Cruiser (4-Low, lockers) through the first dip: ${s >= P.length * m1 + 10 ? 'through' : `stopped at s=${s.toFixed(0)}`}`);
    if (s < P.length * m1 + 10) bad("the Cruiser bogged in Plantation Road's first dip");
    car.destroy();
  }
}
// ---- trucks placed on decks: recover (Backspace) and Y restart place a truck with main.js
// respawnFresh, at surfaceAt + the same lift; along the bridge and on the dock it must come to rest on
// the planks, upright and not sunk into them. The deep-sea tow never targets a deck. ----
{
  const { ALL_VEHICLES } = await import('../src/specs.js');
  const { Vehicle } = await import('../src/vehicle.js');
  const spec = ALL_VEHICLES.find((v) => v.id === 'lc70'), pts = [];
  for (const b of MAP.DECOR.bridges) { const r = ROADS.find((q) => q.name === b.road); for (let s = b.s0 + 1; s < b.s1; s += 4) for (const lat of [-1.5, 0, 1.5]) { const p = pathPoint(r, s); pts.push({ where: `${b.road} bridge s=${s.toFixed(0)} lat ${lat}`, x: p.x - p.tz * lat, z: p.z + p.tx * lat, yaw: Math.atan2(-p.tx, -p.tz) }); } }
  { const D = MAP.DECOR.dock; for (const k of [0.3, 0.55, 0.8]) pts.push({ where: `dock ${k}`, x: D.x0 + (D.x1 - D.x0) * k, z: D.z0 + (D.z1 - D.z0) * k, yaw: D.yaw + Math.PI }); }
  let worst = 0;
  for (const P of pts) {
    const top = T.surfaceAt(P.x, P.z);
    if (top <= heightAt(P.x, P.z) + 0.05) { bad(`surfaceAt finds no deck at ${P.where}`); continue; }
    const car = new Vehicle(RAPIER, world, spec, terrain, { x: P.x, y: top + spec.tire.radius - spec.axleY + 1.0, z: P.z }, P.yaw);
    for (let i = 0; i < 600; i++) car.step({ throttle: 0, brake: 1, steer: 0 }, 1 / 200);
    const a = car.attitude(), wy = Math.min(...car.wheels.map((w) => w.translation().y)) - spec.tire.radius, off = wy - top;
    worst = Math.max(worst, Math.abs(off));
    if (car.upsideDown() || Math.abs(a.roll) > 0.2 || Math.abs(a.pitch) > 0.2 || Math.abs(off) > 0.12) bad(`recover at ${P.where}: roll ${(a.roll * 57.3).toFixed(0)} pitch ${(a.pitch * 57.3).toFixed(0)}, lowest tyre ${off.toFixed(2)} m from the deck top`);
    car.destroy();
  }
  console.log(`recover on decks: ${pts.length} placements on the bridge and the dock, lowest tyre within ${worst.toFixed(3)} m of the planks`);
  let towBad = 0, n = 0;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 36) for (const out of [8, 40]) {
    const r = MAP.coastR(a) + out, t = MAP.towTarget(Math.cos(a) * r, Math.sin(a) * r); n++;
    if (T.surfaceAt(t.x, t.z) > heightAt(t.x, t.z) + 0.05 || ROADS.some((q) => q.bridges.some((b) => { const p0 = pathPoint(q, b.s0 - 2), p1 = pathPoint(q, b.s1 + 2); return Math.hypot(t.x - (p0.x + p1.x) / 2, t.z - (p0.z + p1.z) / 2) < Math.hypot(p1.x - p0.x, p1.z - p0.z) / 2 + 3; }))) towBad++;
  }
  console.log(`tow: ${n} sea points, ${towBad} towed onto a deck`);
  if (towBad) bad(`${towBad} tows target a bridge or dock deck`);
}
console.log(`${rocks.length} rocks (${rocks.filter((r) => r.embed).length} embedded), ${MAP.PROPS.length} box colliders`);
console.log(fail ? `${fail} FAILED` : 'all checks passed');
process.exit(fail ? 1 : 0);
