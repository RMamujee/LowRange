// The Gauntlet (src/maps/crawl.js), checked by numbers rather than by autopilot: per-stage
// length, climb and steepest grade; every step-up's real height (raycast: slab lip vs the tread
// just before it) against the climbing limit for its grade; the clear gap in the squeezes; the
// bypass track and spur grades; the map bounds. Exits non-zero if a limit is broken.
// usage: MAP=crawl node test/crawlcheck.mjs
process.env.MAP = 'crawl';
const t0 = Date.now();
const T = await import('../src/terrain.js');
const tBake = Date.now() - t0;
import RAPIER from '@dimforge/rapier3d-compat';
const { TRAILS, ROADS, MAP, heightAt, materialAt, MAT, pathPoint, generateRocks, generateTrees, buildTerrainPhysics } = T;
await RAPIER.init();
const t = TRAILS[0], STAGES = MAP.STAGES;
let fail = 0;
const bad = (msg) => { fail++; console.log('  FAIL ' + msg); };

// the tallest step-up the Cruiser (lc70: 36" tyres, both lockers) walks at this tread grade,
// measured on a 5-step staircase (test/stairgrade.mjs lc70 0.15,0.28,0.33 ...: 0.6 m OK up to
// 28%, 0.65-0.7 m fails; at 33% even 0.4 m fails)
const stepCap = (g) => (g <= 0.285 ? 0.6 : g < 0.33 ? 0.6 - ((g - 0.285) / 0.045) * 0.3 : 0.3);

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const rocks = generateRocks();
const terrain = buildTerrainPhysics(RAPIER, world, rocks, generateTrees());
world.step();
const ledgeHandles = new Set();
{
  const key = (x, y, z) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
  const ledges = new Set(rocks.filter((r) => r.ledge).map((r) => key(r.x, r.y, r.z)));
  world.forEachCollider((c) => { const p = c.parent()?.translation(); if (p && terrain.rockHandles.has(c.handle) && ledges.has(key(p.x, p.y, p.z))) ledgeHandles.add(c.handle); });
}
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
const surf = (x, z, noLedges = false) => {
  const g = heightAt(x, z);
  ray.origin = { x, y: g + 6, z };
  const hit = world.castRay(ray, 8, true, undefined, undefined, undefined, undefined, (c) => terrain.rockHandles.has(c.handle) && !(noLedges && ledgeHandles.has(c.handle)));
  return Math.max(g, hit ? g + 6 - hit.timeOfImpact : -1e9);
};
const at = (s, lat) => { const p = pathPoint(t, s); return [p.x - p.tz * lat, p.z + p.tx * lat]; };

console.log(`${t.name}: ${t.length.toFixed(0)} m, ${STAGES.length} stages, climbs ${(t.pts.at(-1).h - t.pts[0].h).toFixed(1)} m; bake ${tBake} ms; ${rocks.length} rocks`);
console.log(' #  stage                 s0    len   climb  max grade');
for (const st of STAGES) {
  let gmax = 0;
  for (let s = st.s0; s < st.s1 - 2; s += 0.5) gmax = Math.max(gmax, (pathPoint(t, s + 2).h - pathPoint(t, s).h) / 2);
  const climb = pathPoint(t, st.s1).h - pathPoint(t, st.s0).h;
  console.log(`${String(st.n).padStart(2)}  ${st.name.padEnd(20)} ${st.s0.toFixed(0).padStart(5)} ${st.len.toFixed(0).padStart(5)} ${climb.toFixed(1).padStart(6)}  ${(gmax * 100).toFixed(0)}% (${(Math.atan(gmax) * 57.3).toFixed(0)} deg)`);
}

// Wide stages carry one slab per lane (r.step.lane / lat): each is measured on its own line; the
// climbing cap holds for the easy (rated) line, and no line is taller than any rig walks.
console.log('step-ups: stage@u lane  rise(design)  lip over tread: left/line/right  tread grade  cap');
for (const r of rocks.filter((r) => r.step)) {
  const { stage, u, rise, grade, lane } = r.step, st = STAGES[stage - 1], lc = lane ? t.lineAt(lane, st.s0 + u) : 0;
  const hs = [lc - 0.8, lc, lc + 0.8].map((lat) => {
    const s = st.s0 + u;
    const [bx, bz] = at(s - 0.7, lat), [lx, lz] = at(s + 0.25, lat);
    return surf(lx, lz) - surf(bx, bz) - grade * 0.95;
  });
  const cap = stepCap(grade), top = Math.max(...hs), rated = !lane || lane === 'easy';
  const ok = !rated || Math.min(...hs) <= cap;
  console.log(`  ${stage}@${u.toFixed(1).padStart(4)} ${(lane ?? '-').padEnd(7)} ${rise.toFixed(2)}  ${hs.map((h) => h.toFixed(2)).join('/')}  ${(grade * 100).toFixed(0).padStart(3)}%  ${cap.toFixed(2)}${ok ? '' : '  OVER'}`);
  if (!ok) bad(`stage ${stage} step at u=${u}: lowest lip ${Math.min(...hs).toFixed(2)} m > cap ${cap.toFixed(2)} m at ${(grade * 100).toFixed(0)}%`);
  // (an optional extreme line may go past the staircase limit, up to the best single-ledge climb
  // measured: the Cruiser's 0.75 m chamfered run-up, test/ledgeclimb.mjs)
  const ceiling = lane === 'extreme' ? 0.75 : 0.68;
  if (top > ceiling) bad(`stage ${stage} step at u=${u}${lane ? ` (${lane})` : ''}: ${top.toFixed(2)} m is taller than any rig walks`);
}
for (const r of rocks.filter((r) => r.gate)) {
  const { stage, u, top, lane } = r.gate, st = STAGES[stage - 1], s = st.s0 + u, lc = lane ? t.lineAt(lane, s) : 0;
  const hd = 1.7, g = (pathPoint(t, s + 1).h - pathPoint(t, s - 1).h) / 2;
  const hs = [lc - 0.8, lc, lc + 0.8].map((lat) => { const [bx, bz] = at(s - hd - 1.2, lat), [lx, lz] = at(s - hd + 0.6, lat); return surf(lx, lz) - surf(bx, bz) - g * 1.8; });
  console.log(`  ledge ${stage}@${u} ${(lane ?? '-').padEnd(7)} ${top.toFixed(2)}  ${hs.map((h) => h.toFixed(2)).join('/')}  ${(g * 100).toFixed(0)}%`);
  if ((!lane || lane === 'easy') && Math.min(...hs) > stepCap(g)) bad(`ledge ${stage}@${u} too tall on the easy line`);
  if (Math.max(...hs) > 0.75) bad(`ledge ${stage}@${u} (${lane}): ${Math.max(...hs).toFixed(2)} m is taller than any rig walks`);
}
// spacing: a step's slab ends before the next face (no overlapping lips)
// (per lane: each lane climbs its own staircase)
for (const st of STAGES.filter((s) => s.steps)) for (const [lane, L] of Object.entries(st.steps.byLane)) L.at.slice(1).forEach((u, k) => { if (u - L.at[k] < st.steps.depth + 0.4) bad(`stage ${st.n} ${lane}: steps ${L.at[k]} and ${u} overlap`); });

// clear lane: in every metre of every stage there is a gap wide enough for the widest track +
// tyres (lc70 1.86 m) in which the surface stays within 0.62 m of the tread (crawlable)
console.log('narrowest clear lane per stage (m, rocks under 0.45 m above the tread count as drivable):');
const need = 1.86;
for (const st of STAGES) {
  let worst = 99, wAt = 0;
  for (let u = 7; u < st.len - 3; u += 1) {
    const s = st.s0 + u, hw = t.pts[Math.min(t.pts.length - 1, Math.round(s / 0.5))].w / 2 + 0.3, p = pathPoint(t, s);
    let run = 0, bestRun = 0;
    for (let lat = -hw; lat <= hw; lat += 0.1) {
      const [x, z] = at(s, lat);
      const ok = surf(x, z, true) - heightAt(x, z) < 0.45;
      run = ok ? run + 0.1 : 0; bestRun = Math.max(bestRun, run);
    }
    if (bestRun < worst) { worst = bestRun; wAt = u; }
  }
  // and near the easy (rated) line: the widest clear run within 3 m of it
  let worstE = 99, eAt = 0;
  for (let u = 7; u < st.len - 3; u += 1) {
    const s = st.s0 + u, o = t.lineAt('easy', s);
    let run = 0, bestRun = 0;
    for (let lat = o - 3; lat <= o + 3; lat += 0.1) { const [x, z] = at(s, lat); const ok = surf(x, z, true) - heightAt(x, z) < 0.45; run = ok ? run + 0.1 : 0; bestRun = Math.max(bestRun, run); }
    if (bestRun < worstE) { worstE = bestRun; eAt = u; }
  }
  const sq = st.squeezes ? ` (squeeze gaps ${JSON.stringify(st.squeezes.gap).replace(/"/g, '')} m)` : '';
  console.log(`  ${String(st.n).padStart(2)} ${st.name.padEnd(20)} ${worst.toFixed(1)} m at u=${wAt}; by the easy line ${worstE.toFixed(1)} m at u=${eAt}${sq}`);
  if (worst < need) bad(`stage ${st.n}: clear lane only ${worst.toFixed(1)} m at u=${wAt}`);
  if (worstE < need) bad(`stage ${st.n}: the easy line's clear lane only ${worstE.toFixed(1)} m at u=${eAt}`);
}

// bypass track + spurs: grades
for (const r of ROADS) {
  let g = 0;
  for (let i = 4; i < r.pts.length; i++) g = Math.max(g, Math.abs(r.pts[i].h - r.pts[i - 4].h) / Math.max(0.1, r.pts[i].s - r.pts[i - 4].s));
  const lim = r.name.startsWith('Spur') ? 0.32 : 0.26;
  if (r.name === 'Bypass Track' || g > lim) console.log(`  ${r.name}: ${r.length.toFixed(0)} m, steepest ${(g * 100).toFixed(0)}%`);
  if (g > lim) bad(`${r.name} grade ${(g * 100).toFixed(0)}%`);
}
// map bounds
let ext = 0;
for (const p of [...t.pts, ...ROADS.flatMap((r) => r.pts)]) ext = Math.max(ext, Math.abs(p.x), Math.abs(p.z));
console.log(`  furthest path point ${ext.toFixed(0)} m from the centre (map half-size ${T.SIZE / 2})`);
if (ext > 160) bad('course too close to the map edge');
// water: the ford is flooded, nothing else
let wet = 0; for (let x = -200; x <= 200; x += 1) for (let z = -200; z <= 200; z += 1) if (materialAt(x, z) === MAT.WATER) wet++;
console.log(`  ford: ${wet} flooded cells, water at ${MAP.WATER.y.toFixed(2)} m`);
if (!wet) bad('no water in the ford');
console.log(fail ? `${fail} problem(s)` : 'all checks passed');
process.exit(fail ? 1 : 0);
