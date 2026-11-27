// Wide crawls (src/maps/widecrawl.js, the island and the desert): drive a chosen line through each
// wide trail with the autopilot of test/trails.mjs (4-Low, lockers, aired down, no flip resets),
// and audit what stands on each line.
//   LINE=easy|hard|extreme (default easy): the easy line is the centreline (as test/trails.mjs);
//   hard / extreme follow t.lines[LINE] (a lateral offset, held through each crux), picking the
//   clearest spot within 1.4 m of it among the boulders.
// usage: MAP=jungle LINE=hard node test/widelines.mjs [rigs] [seconds] [trail name filter]
//        MAP=jungle node test/widelines.mjs audit      (no driving: per line, the cruxes' features and the corridor)
import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt, TRAILS, ROADS, GRID, SIZE, RES, pathPoint } from '../src/terrain.js';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
await RAPIER.init();
const H = 1 / 200;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
const rocks = generateRocks();
for (const r of rocks) { let m = 0; for (let i = 0; i < r.pts.length; i += 3) m = Math.max(m, Math.hypot(r.pts[i], r.pts[i + 2])); r.rad = m; }
const terrain = buildTerrainPhysics(RAPIER, world, rocks, generateTrees(rocks));
const LINE = process.env.LINE || 'easy';
const wide = TRAILS.filter((t) => t.wide && (!process.argv[4] || t.name.toLowerCase().includes(process.argv[4].toLowerCase())));
const cellPath = (x, z) => GRID.path[Math.round((x + SIZE / 2) / (SIZE / RES)) * (RES + 1) + Math.round((z + SIZE / 2) / (SIZE / RES))];

if (process.argv[2] === 'audit') {
  world.step();
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const up = (x, z) => { const g = heightAt(x, z); ray.origin = { x, y: g + 6, z }; const hit = world.castRay(ray, 8, true, undefined, undefined, undefined, undefined, (c) => terrain.rockHandles.has(c.handle)); return hit ? Math.max(0, 6 - hit.timeOfImpact) : 0; };
  for (const t of wide) {
    const pid = ROADS.length + TRAILS.indexOf(t);
    let minW = 1e9, maxW = 0, off = 0, n = 0;
    for (let s = 0; s <= t.length; s += 1) {
      const w = t.halfWidthAt(s), tot = w.left + w.right;
      if (s > 25 && s < t.length - 25) { minW = Math.min(minW, tot); maxW = Math.max(maxW, tot); }
      for (const name of ['easy', 'hard', 'extreme']) { const lat = t.lines[name](s), p = pathPoint(t, s); n++; if (cellPath(p.x - p.tz * lat, p.z + p.tx * lat) !== pid) off++; }
    }
    console.log(`${t.name} (${t.diff}) ${t.length.toFixed(0)} m, gate mouth ${t.width} m, corridor ${minW.toFixed(1)}-${maxW.toFixed(1)} m wide (25 m in from the ends), line samples off the corridor ${off}/${n}`);
    for (const c of t.cruxes) {
      const per = {};
      for (const f of c.features) { const k = f.line || '-'; (per[k] ||= []).push(f.type + (f.top !== undefined ? ' ' + f.top.toFixed(2) : f.h !== undefined ? ' h' + f.h : f.tilt !== undefined ? ' tilt' + f.tilt : f.depth !== undefined ? ' -' + f.depth : f.size !== undefined ? ' ' + f.size.toFixed(1) : '')); }
      console.log(`  ${c.n} ${c.name} s ${c.s0.toFixed(0)}-${c.s1.toFixed(0)}: ${c.lanes.map((l) => `${l.line}@${l.lat} ${l.f}`).join(', ')}`);
      for (const [k, v] of Object.entries(per)) {
        const cnt = {}; for (const x of v) { const key = x.split(' ')[0]; cnt[key] = cnt[key] || []; cnt[key].push(x.split(' ')[1] ?? ''); }
        console.log(`      ${k.padEnd(8)} ${Object.entries(cnt).map(([a, b]) => `${a} x${b.length}${b[0] ? ' [' + b.join(' ') + ']' : ''}`).join('; ')}`);
      }
    }
    // the tallest rock each line's tyre tracks meet (outside ledges / step slabs, which the cruxes list)
    for (const name of ['easy', 'hard', 'extreme']) {
      let mx = 0, at = 0;
      for (let s = 6; s < t.length - 6; s += 0.5) { const p = pathPoint(t, s), b = t.lines[name](s); for (const o of [-0.85, 0.85]) { const u = up(p.x - p.tz * (b + o), p.z + p.tx * (b + o)); if (u > mx) { mx = u; at = s; } } }
      console.log(`  ${name.padEnd(8)} tallest rock under a tyre track ${mx.toFixed(2)} m (s=${at.toFixed(1)})`);
    }
  }
  process.exit(0);
}

function pickLine(t, s, spec, base) { // lateral offset with most clearance from boulders over the next 8 m, near the line
  let bestO = base, bestC = -1e9;
  for (let o = base - 1.4; o <= base + 1.4; o += 0.2) {
    let c = 1e9;
    for (let q = s; q < s + 8; q += 1) {
      const p = pathPoint(t, q), b = t.lines[LINE](q) - base, x = p.x - p.tz * (o + b), z = p.z + p.tx * (o + b);
      for (const r of rocks) { if (r.ledge || r.embed || Math.abs(r.x - x) > 6 || Math.abs(r.z - z) > 6) continue; const d = Math.hypot(r.x - x, r.z - z) - r.rad - spec.track / 2; if (d < c) c = d; }
    }
    c = Math.min(c, 2.5) - Math.abs(o - base) * 0.05; if (c > bestC) { bestC = c; bestO = o; }
  }
  return bestO;
}
const ids = (process.argv[2] || 'lc70,taco,wrx').split(','), secs = +(process.argv[3] || 400);
for (const id of ids) {
  const spec = ALL_VEHICLES.find((v) => v.id === id), res = [];
  for (const t of wide) {
    const pid = ROADS.length + TRAILS.indexOf(t), p0 = pathPoint(t, 4);
    const car = new Vehicle(RAPIER, world, spec, terrain, { x: p0.x, y: heightAt(p0.x, p0.z) + spec.tire.radius - spec.axleY + 0.5, z: p0.z }, Math.atan2(-p0.tx, -p0.tz));
    car.airedDown = true; const d = car.dt; d.range = spec.ranges.low ? 'low' : 'high'; d.gear = 1; d.lockF = spec.lockers.front; d.lockR = true;
    const inp = { throttle: 0, brake: 0, steer: 0 };
    let s = 4, best = 4, el = 0, maxRoll = 0, offT = 0, flips = 0;
    for (let i = 0; i < secs / H; i++) {
      el = i * H;
      if (i % 20 === 0) {
        const p = car.chassis.translation();
        let bs = s, bd = 1e9; for (let q = Math.max(0, s - 10); q < Math.min(t.length, s + 20); q += 0.5) { const pp = pathPoint(t, q); const dd = Math.hypot(pp.x - p.x, pp.z - p.z); if (dd < bd) { bd = dd; bs = q; } }
        s = bs; best = Math.max(best, s);
        if (cellPath(p.x, p.z) !== pid) offT += 20 * H;
        if (i % 100 === 0) car._line = pickLine(t, s + 2, spec, t.lines[LINE](s + 2));
        const la = Math.min(t.length, s + 4 + spec.wheelbase), lk = pathPoint(t, la), o = (car._line ?? 0) + t.lines[LINE](la) - t.lines[LINE](s + 2);
        const look = { x: lk.x - lk.tz * o, z: lk.z + lk.tx * o };
        const { heading, roll } = car.attitude(); maxRoll = Math.max(maxRoll, Math.abs(roll));
        let err = Math.atan2(-(look.x - p.x), -(look.z - p.z)) - heading; err = Math.atan2(Math.sin(err), Math.cos(err));
        inp.steer = Math.max(-1, Math.min(1, err * 2.2));
        const v = car.speed();
        inp.throttle = v < 0.3 ? Math.min(1.0, inp.throttle + 0.02) : v < 0.6 ? Math.min(0.6, inp.throttle + 0.02) : v > 1.6 ? Math.max(0.05, inp.throttle - 0.05) : inp.throttle;
        if (car.upsideDown()) { flips++; break; }
        if (s >= t.length - 6) break;
      }
      car.step(inp, H);
    }
    res.push(`${t.name.split(' ')[0]}(${t.diff},${LINE}) ${best.toFixed(0)}/${t.length.toFixed(0)}m ${best >= t.length - 6 ? 'done ' + el.toFixed(0) + 's' : flips ? 'ROLLED' : 'STUCK'} roll ${(maxRoll * 57.3).toFixed(0)}deg${offT > 1 ? ` off-corridor ${offT.toFixed(0)}s` : ''}`);
    car.destroy();
  }
  console.log(id.padEnd(7), res.join(' | '));
}
