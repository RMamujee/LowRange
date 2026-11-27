// The Gauntlet's side courses (src/maps/crawl_courses.js) by the numbers, the sibling of
// test/crawlcheck.mjs: per course and section the length, climb, steepest grade and steepest
// side slope; every slab ledge's real lip height (raycast: lip vs the slope just below it) per
// line; the tallest crawl-over rocks (cobbles, kickers, the rib); a clear lane in every metre;
// spawn points; the access tracks' grades; and the guard round The Gauntlet (no course rock or
// course ground near its trail, bypass or spurs; tracks far enough from the trail that the bake
// can't touch its tread). Exits non-zero if a limit is broken.
// Limits come from measurements: test/tipangle.mjs (Cruiser tips at about 38 deg of side slope
// parked, 0.3 m ridge under the high side at 30 deg rolls it 40 deg), test/stairgrade.mjs.
// usage: node test/coursecheck.mjs
process.env.MAP = 'crawl';
const T = await import('../src/terrain.js');
import RAPIER from '@dimforge/rapier3d-compat';
const { COURSES, ROADS, TRAILS, MAP, GRID, SIZE, RES, heightAt, pathPoint, generateRocks, generateTrees, buildTerrainPhysics } = T;
const S = await import('../src/spawns.js');
await RAPIER.init();
let fail = 0;
const bad = (m) => { fail++; console.log('  FAIL ' + m); };
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const rocks = generateRocks(), trees = generateTrees();
const terrain = buildTerrainPhysics(RAPIER, world, rocks, trees);
world.step();
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
const surf = (x, z) => { const g = heightAt(x, z); ray.origin = { x, y: g + 6, z }; const hit = world.castRay(ray, 8, true, undefined, undefined, undefined, undefined, (c) => terrain.rockHandles.has(c.handle)); return Math.max(g, hit ? g + 6 - hit.timeOfImpact : -1e9); };
// how far a rock stands proud of the ground right under it (its hull points in world space, so a
// rock tilted to a steep slope isn't counted as tall)
const topOf = (r) => {
  const c = Math.cos(r.rotY), s = Math.sin(r.rotY);
  let t = -1e9;
  for (let i = 0; i < r.pts.length; i += 3) { const x = r.x + r.pts[i] * c + r.pts[i + 2] * s, z = r.z - r.pts[i] * s + r.pts[i + 2] * c; t = Math.max(t, r.y + r.pts[i + 1] - heightAt(x, z)); }
  return t;
};
const LIM = { sideDeg: 31, ledge: 0.6, easy: 0.32, cobble: 0.66, kicker: 0.28, rib: 0.24, lane: 1.86, roadGrade: 0.26, descent: 0.45, trackStep: 0.26, courseStep: 0.5, bank: 0.6 };
// a point on a path at arc length s, carried straight on past either end
const along = (P, s) => { if (s >= 0 && s <= P.length) return pathPoint(P, s); const e = pathPoint(P, s < 0 ? 0 : P.length), d = s < 0 ? s : s - P.length; return { x: e.x + e.tx * d, z: e.z + e.tz * d, h: e.h }; };

for (const C of COURSES) {
  const at = (s, lat) => { const p = pathPoint(C, s); return [p.x - p.tz * lat, p.z + p.tx * lat]; };
  console.log(`${C.name} (${C.id}, ${C.diff}): ${C.length.toFixed(0)} m, climbs ${(C.pts.at(-1).h - C.pts[0].h).toFixed(1)} m (high point +${(Math.max(...C.pts.map((p) => p.h)) - C.pts[0].h).toFixed(1)}, low point ${(Math.min(...C.pts.map((p) => p.h)) - C.pts[0].h).toFixed(1)})`);
  console.log('   #  section        len  climb  up / down   side slope  lane');
  for (const st of C.stages) {
    let up = 0, down = 0, side = 0, lane = 99;
    for (let s = st.s0; s < st.s1 - 2; s += 0.5) { const g = (pathPoint(C, s + 2).h - pathPoint(C, s).h) / 2; up = Math.max(up, g); down = Math.min(down, g); }
    for (let s = st.s0 + 1; s < st.s1 - 1; s += 1) {
      const hw = C.pts[Math.round(s / 0.5)].w / 2, [ax, az] = at(s, -hw + 0.6), [bx, bz] = at(s, hw - 0.6);
      side = Math.max(side, Math.abs(heightAt(bx, bz) - heightAt(ax, az)) / (2 * hw - 1.2));
      // clear lane: the widest run across the tread where rocks stand under 0.65 m (crawlable)
      let run = 0, bestRun = 0;
      for (let lat = -hw; lat <= hw; lat += 0.1) { const [x, z] = at(s, lat); const ok = surf(x, z) - heightAt(x, z) < 0.65; run = ok ? run + 0.1 : 0; bestRun = Math.max(bestRun, run); }
      lane = Math.min(lane, bestRun);
    }
    const sd = Math.atan(side) * 57.3;
    console.log(`  ${String(st.n).padStart(2)}  ${st.name.padEnd(12)} ${st.len.toFixed(0).padStart(4)} ${(pathPoint(C, st.s1).h - pathPoint(C, st.s0).h).toFixed(1).padStart(6)}  ${(up * 100).toFixed(0).padStart(3)}% / ${(down * 100).toFixed(0).padStart(3)}%  ${sd.toFixed(0).padStart(4)} deg  ${lane.toFixed(1)} m`);
    if (sd > LIM.sideDeg) bad(`${C.id} ${st.name}: side slope ${sd.toFixed(0)} deg over ${LIM.sideDeg}`);
    if (-down > LIM.descent) bad(`${C.id} ${st.name}: descent ${(-down * 100).toFixed(0)}%`);
    if (lane < LIM.lane) bad(`${C.id} ${st.name}: clear lane ${lane.toFixed(1)} m`);
  }
  // slab ledges: lip over the slope just below, per line
  const steps = rocks.filter((r) => r.cstep && r.cstep.course === C.id);
  if (steps.length) {
    const st = C.stages.find((q) => q.ledges), lines = st.lines || [];
    console.log('  ledges (lip over the slope below, m) per line: ' + lines.map(([lc, nm]) => {
      const hs = steps.filter((r) => Math.abs(r.cstep.lat - lc) < 3.2).map((r) => {
        const s = st.s0 + r.cstep.u, g = (pathPoint(C, s + 1).h - pathPoint(C, s - 1).h) / 2;
        const out = [];
        for (const dl of [-0.6, 0, 0.6]) { const [bx, bz] = at(s - 0.9, r.cstep.lat + dl), [lx, lz] = at(s + 0.45, r.cstep.lat + dl); out.push(surf(lx, lz) - surf(bx, bz) - g * 1.35); }
        return Math.max(...out);
      });
      const top = Math.max(...hs);
      if (top > LIM.ledge) bad(`${C.id} ${nm} line: a ${top.toFixed(2)} m ledge`);
      if (nm === 'EASY' && top > LIM.easy) bad(`${C.id} easy line: a ${top.toFixed(2)} m ledge (over ${LIM.easy})`);
      return `${nm.toLowerCase()} ${Math.min(...hs).toFixed(2)}-${top.toFixed(2)}`;
    }).join(', '));
  }
  const tall = (tag) => rocks.filter((r) => r[tag] && r[tag].course === C.id).reduce((m, r) => Math.max(m, topOf(r)), 0);
  const tc = tall('cobble'), tk = tall('kicker'), tr = tall('rib');
  if (tc || tk || tr) console.log(`  crawl-over rocks, tallest: ${tc ? `cobbles ${tc.toFixed(2)} m ` : ''}${tk ? `kickers ${tk.toFixed(2)} m ` : ''}${tr ? `rib ${tr.toFixed(2)} m` : ''}`);
  if (tc > LIM.cobble) bad(`${C.id}: a ${tc.toFixed(2)} m cobble`);
  if (tk > LIM.kicker) bad(`${C.id}: a ${tk.toFixed(2)} m kicker`);
  if (tr > LIM.rib) bad(`${C.id}: a ${tr.toFixed(2)} m rib`);
}

// access tracks: grades, and kept off The Gauntlet's trail (the bake blends a road into the ground
// out to half its width + 5 m, so that must end short of the trail's tread: its half width + 0.5 m)
const trail = TRAILS[0];
for (const r of MAP.ACCESS) {
  let g = 0, margin = 1e9;
  for (let i = 4; i < r.pts.length; i++) g = Math.max(g, Math.abs(r.pts[i].h - r.pts[i - 4].h) / Math.max(0.1, r.pts[i].s - r.pts[i - 4].s));
  for (const p of r.pts) for (let i = 0; i < trail.pts.length; i += 2) { const q = trail.pts[i]; margin = Math.min(margin, Math.hypot(q.x - p.x, q.z - p.z) - (r.width / 2 + 5) - (q.w / 2 + 0.5)); }
  // ground truth: the baked ground along the track, metre by metre (where it meets The Gauntlet's
  // protected ground too, which is put back as baked), from 2 m before its start to 2 m past its end
  let step = 0, stepAt = 0, off = 0;
  // (not on past an end that tees into another track: that track is checked on its own)
  for (let s = r.joinFrom ? 0 : -2; s < r.length + (r.joinTo ? -1 : 2); s += 1) {
    const a = along(r, s), b = along(r, s + 1), d = Math.abs(heightAt(b.x, b.z) - heightAt(a.x, a.z));
    if (d > step) { step = d; stepAt = s; }
    if (s >= 0 && s <= r.length) off = Math.max(off, Math.abs(heightAt(a.x, a.z) - a.h));
  }
  console.log(`  ${r.name}: ${r.length.toFixed(0)} m, steepest ${(g * 100).toFixed(0)}% planned, ground ${(step * 100).toFixed(0)}% per metre at its steepest (s=${stepAt}), ground within ${off.toFixed(2)} m of the plan; its blend ends ${margin.toFixed(1)} m short of The Gauntlet's tread`);
  if (g > LIM.roadGrade) bad(`${r.name} grade ${(g * 100).toFixed(0)}%`);
  if (step > LIM.trackStep) bad(`${r.name}: the ground steps ${step.toFixed(2)} m in a metre at s=${stepAt}`);
  if (margin < 0) bad(`${r.name} reaches The Gauntlet's tread`);
}
// ground truth across: no cliff beside a track or a course's finish bench. Out to 8 m past the tread
// edge either side, the ground may fall or rise at most `bank` per metre: 0.6 (31 degrees), below
// the side slope every rig tips at parked (38-42 degrees, test/tipangle.mjs) and about what they
// climb straight up on rock, so a truck that slides off the edge can drive back or press Y rather
// than tumble. (Where a track crosses into The Gauntlet's protected ground, the ground is The
// Gauntlet's own as baked and is not judged here; course interiors are exempt: steep is the point.)
{
  const gp = [...ROADS.filter((r) => !r.course).flatMap((r) => r.pts), ...TRAILS[0].pts];
  // (within 15 m of a Gauntlet path centre the ground is The Gauntlet's own, as baked, put back by
  // the restore: not ours to judge)
  const nearG = (x, z) => gp.some((q, i) => i % 2 === 0 && Math.hypot(q.x - x, q.z - z) < 15);
  const across = (P, s0, s1, hw, label) => {
    let worst = 0, at = '';
    for (let s = s0; s <= s1; s += 2) {
      const p = pathPoint(P, s);
      if (nearG(p.x, p.z)) continue;
      for (const sd of [-1, 1]) {
        let prev = null;
        for (let e = hw; e <= hw + 8; e += 1) {
          const x = p.x - p.tz * e * sd, z = p.z + p.tx * e * sd, h = heightAt(x, z);
          if (nearG(x, z)) break;
          if (prev !== null && prev - h > worst) { worst = prev - h; at = `s=${s.toFixed(0)} ${sd < 0 ? 'left' : 'right'} ${e.toFixed(0)} m out`; }
          prev = h;
        }
      }
    }
    console.log(`  ${label}: steepest bank within 8 m of the edge ${(worst * 100).toFixed(0)}% (${at})`);
    if (worst > LIM.bank) bad(`${label}: a ${(worst * 100).toFixed(0)}% drop beside the tread at ${at}`);
  };
  for (const r of MAP.ACCESS) across(r, 3, r.length - 3, r.width / 2, r.name);
  for (const C of COURSES) { const f = C.stages.at(-1); across(C, f.s0, C.length, f.width / 2, `${C.name} finish bench`); }
}
// ground truth on the courses' centrelines, too (the ledges and boulders are rocks, not ground)
for (const C of COURSES) {
  let step = 0, stepAt = 0;
  for (let s = -2; s < C.length + 2; s += 1) { const a = along(C, s), b = along(C, s + 1), d = Math.abs(heightAt(b.x, b.z) - heightAt(a.x, a.z)); if (d > step) { step = d; stepAt = s; } }
  console.log(`  ${C.name}: centreline ground ${(step * 100).toFixed(0)}% per metre at its steepest (s=${stepAt})`);
  if (step > LIM.courseStep) bad(`${C.name}: the ground steps ${step.toFixed(2)} m in a metre at s=${stepAt}`);
}
// the guard: no course rock near a Gauntlet path (trail, bypass, spurs), no course ground on one
{
  const gRoads = ROADS.filter((r) => !r.course), gp = [...gRoads.flatMap((r) => r.pts), ...trail.pts];
  const courseRocks = rocks.filter((r) => COURSES.some((C) => C.pts.some((p, i) => i % 4 === 0 && Math.hypot(p.x - r.x, p.z - r.z) < p.w / 2 + 6)));
  let worst = 1e9;
  for (const r of courseRocks) for (let i = 0; i < gp.length; i += 3) worst = Math.min(worst, Math.hypot(gp[i].x - r.x, gp[i].z - r.z));
  console.log(`  course rocks: ${courseRocks.length}, nearest to a Gauntlet path centre ${worst.toFixed(1)} m`);
  if (worst < 12) bad('a course rock is within 12 m of a Gauntlet path');
  const trailId = ROADS.length, gIds = new Set([...gRoads.map((r) => ROADS.indexOf(r)), trailId]);
  let courseCells = 0, clash = 0;
  const N1 = RES + 1;
  for (let i = 0; i < GRID.path.length; i++) {
    if (GRID.path[i] <= trailId) continue;
    courseCells++;
    const ix = Math.floor(i / N1), iz = i % N1;
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) { const j = (ix + dx) * N1 + iz + dz; if (j >= 0 && j < GRID.path.length && gIds.has(GRID.path[j])) clash++; }
  }
  console.log(`  course tread cells: ${courseCells}, Gauntlet path cells within 3 m of them: ${clash}`);
  if (clash) bad('course ground touches a Gauntlet path');
}
// spawn points: start, every section gate but the finish, the finish; all footprint-checked
{
  const warns = [], list = S.buildSpawnPoints({ rocks, trees, warn: (m) => warns.push(m) });
  for (const C of COURSES) {
    const want = [`${C.id}-start`, ...C.stages.slice(1, -1).map((q) => `${C.id}-${q.n}`), `${C.id}-finish`];
    const miss = want.filter((id) => !list.some((s) => s.id === id));
    console.log(`  ${C.name}: spawn points ${want.length - miss.length}/${want.length}${miss.length ? ` (missing ${miss.join(', ')})` : ''}`);
    if (miss.length) bad(`${C.id}: spawn points missing: ${miss.join(', ')}`);
  }
  if (warns.length) { warns.forEach((w) => console.log('  warn ' + w)); bad(`${warns.length} spawn warning(s)`); }
}
// inside the map, clear of the rising edge
let ext = 0; for (const C of COURSES) for (const p of C.pts) ext = Math.max(ext, Math.abs(p.x), Math.abs(p.z));
console.log(`  furthest course point ${ext.toFixed(0)} m from the centre (map half-size ${SIZE / 2})`);
if (ext > 165) bad('a course runs too close to the map edge');
console.log(fail ? `${fail} problem(s)` : 'all course checks passed');
process.exit(fail ? 1 : 0);
