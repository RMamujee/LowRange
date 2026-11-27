// Sunfall Basin (src/maps/desert.js) by the numbers, no driving: the heightfield, the boundary,
// the track network and its junctions, the dune shapes, the dune route, the crawls' corridors,
// spawn-relevant places and the camp props. Fast (a few seconds).
// usage: node test/desertcheck.mjs
process.env.MAP = 'desert';
const T = await import('../src/terrain.js');
const D = await import('../src/maps/desert.js');
const { MAT } = T;
let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const t0 = Date.now();
console.log(`${T.MAP_NAME}: ${T.SIZE} m square, ${T.RES}x${T.RES} cells of ${T.SIZE / T.RES} m`);

// ---- heightfield ----
{
  let bad = 0, lo = Infinity, hi = -Infinity;
  for (const h of T.GRID.h) { if (!Number.isFinite(h)) bad++; lo = Math.min(lo, h); hi = Math.max(hi, h); }
  check(bad === 0, `heightfield: every height finite (${bad} bad), range ${lo.toFixed(1)} to ${hi.toFixed(1)} m`);
}
// ---- boundary: a rimrock wall all round, no driving off the edge ----
{
  let minRise = Infinity, minSteep = Infinity, at = '';
  const S2 = T.SIZE / 2;
  for (let k = 0; k < 400; k++) {
    const u = (k / 400) * 4, side = Math.floor(u), f = (u - side) * 2 - 1;
    const [ex, ez] = [[f, -1], [1, f], [-f, 1], [-1, -f]][side];
    const outer = [ex * (S2 - 3), ez * (S2 - 3)], inner = [ex * (S2 - 90), ez * (S2 - 90)];
    let floor = Infinity; for (let d = S2 - 220; d < S2 - 20; d += 4) floor = Math.min(floor, T.heightAt(ex * d, ez * d));
    const rise = T.heightAt(...outer) - floor;
    // steepest 6 m step on the way out: the rim must have a face no rig can climb
    let steep = 0;
    for (let d = S2 - 90; d < S2 - 3; d += 2) { const a = T.heightAt(ex * d, ez * d), b = T.heightAt(ex * (d + 6), ez * (d + 6)); steep = Math.max(steep, (b - a) / 6); }
    if (rise < minRise) { minRise = rise; at = `${outer.map((v) => v.toFixed(0))}`; }
    minSteep = Math.min(minSteep, steep);
  }
  check(minRise > 30, `boundary: the rim stands at least 30 m over the basin all round (lowest ${minRise.toFixed(1)} m at ${at})`);
  check(minSteep > 1.2, `boundary: every way out meets a cliff steeper than 50° (gentlest ${(Math.atan(minSteep) * 57.3).toFixed(0)}°)`);
}
// ---- tracks: lengths, grades, smoothness along the centreline, junctions ----
const graded = [...T.ROADS, ...T.TRAILS.filter((t) => t.graded)];
{
  const total = T.ROADS.reduce((a, r) => a + r.length, 0);
  console.log(`  tracks: ${T.ROADS.map((r) => `${r.name} ${(r.length / 1000).toFixed(2)} km`).join(', ')}`);
  check(total > 5000, `tracks: ${(total / 1000).toFixed(1)} km of graded desert track (> 5 km)`);
  for (const r of T.ROADS) {
    let maxG = 0, maxStep = 0, at = 0;
    for (let s = 1; s < r.length - 1; s += 1) {
      const a = T.pathPoint(r, s), b = T.pathPoint(r, s + 1), h0 = T.heightAt(a.x, a.z), h1 = T.heightAt(b.x, b.z);
      const g = Math.abs(h1 - h0);
      if (g > maxStep) { maxStep = g; at = s; }
      const c = T.pathPoint(r, Math.min(r.length, s + 10)); maxG = Math.max(maxG, Math.abs(T.heightAt(c.x, c.z) - h0) / 10);
    }
    check(maxG < 0.15 && maxStep < 0.3, `${r.name}: steepest 10 m grade ${(maxG * 100).toFixed(0)}%, biggest 1 m step ${maxStep.toFixed(2)} m (at ${at.toFixed(0)} m)`);
  }
  // junctions: every open end of a road or graded trail meets the path it joins at the same height,
  // with no lip: the ground 6 m either side of the joint differs only by the grade
  for (const p of graded) {
    if (p.closed) continue;
    for (const end of [0, 1]) {
      const e = T.pathPoint(p, end ? p.length : 0);
      let best = null;
      for (const q of graded) if (q !== p) for (const pt of q.pts) { const d = Math.hypot(pt.x - e.x, pt.z - e.z); if (d < 14 && (!best || d < best.d)) best = { d, q, pt }; }
      const nearTH = Math.hypot(e.x - T.TRAILHEAD.x, e.z - T.TRAILHEAD.z) < T.TRAILHEAD.r + 6;
      if (!best && !nearTH) { console.log(`       ${p.name} ${end ? 'end' : 'start'}: open end (no junction)`); continue; }
      const i0 = T.pathPoint(p, end ? p.length - 8 : 8);
      const hIn = T.heightAt(i0.x, i0.z), hJ = T.heightAt(e.x, e.z);
      let lip = 0;
      for (let s = end ? p.length - 12 : 0; s < (end ? p.length : 12); s += 0.5) { const a = T.pathPoint(p, s), b = T.pathPoint(p, s + 0.5); lip = Math.max(lip, Math.abs(T.heightAt(b.x, b.z) - T.heightAt(a.x, a.z)) / 0.5); }
      check(lip < 0.36 && Math.abs(hJ - (best ? best.pt.h : hJ)) < 0.6, `junction ${p.name} ${end ? 'end' : 'start'}${best ? ` -> ${best.q.name}` : ' -> trailhead'}: steepest 0.5 m in the last 12 m ${(lip * 100).toFixed(0)}%, ${Math.abs(hJ - hIn).toFixed(1)} m over the last 8 m`);
    }
  }
}
// ---- dunes ----
{
  const N1 = T.RES + 1, C = T.SIZE / T.RES;
  let n = 0, slip = 0, steep = 0, wind = 0, maxDune = 0;
  for (let ix = 2; ix < T.RES - 2; ix++) for (let iz = 2; iz < T.RES - 2; iz++) {
    const k = ix * N1 + iz, x = -T.SIZE / 2 + ix * C, z = -T.SIZE / 2 + iz * C;
    if (T.GRID.mat[k] !== MAT.SAND || T.sandDepthAt(x, z) < 0.6) continue;
    const g = Math.hypot(T.GRID.h[k + N1] - T.GRID.h[k - N1], T.GRID.h[k + 1] - T.GRID.h[k - 1]) / (2 * C);
    n++;
    if (g > 0.55 && g < 0.72) slip++;
    if (g > 0.8) steep++;
    if (g > 0.12 && g < 0.4) wind++;
  }
  // tallest dune: crest height over the corridor floor within 120 m
  for (let k = 0; k < 4000; k++) {
    const x = D.ERG.x + (Math.cos(k * 2.4) * Math.sqrt(k / 4000)) * D.ERG.rx * 0.6, z = D.ERG.z + (Math.sin(k * 2.4) * Math.sqrt(k / 4000)) * D.ERG.rz * 0.6;
    let lo = Infinity; for (let a = 0; a < 6.28; a += 0.5) lo = Math.min(lo, T.heightAt(x + Math.cos(a) * 60, z + Math.sin(a) * 60));
    maxDune = Math.max(maxDune, T.heightAt(x, z) - lo);
  }
  console.log(`  dunes: ${n} deep-sand cells; windward faces (7-22°) ${(100 * wind / n).toFixed(0)}%, slip faces (29-36°) ${(100 * slip / n).toFixed(1)}%, steeper than 39° ${(100 * steep / n).toFixed(2)}%`);
  check(slip / n > 0.02, 'dunes: real slip faces near the angle of repose (> 2% of the deep sand)');
  check(steep / n < 0.01, 'dunes: almost nothing steeper than the angle of repose (< 1%)');
  check(wind / n > 0.25, 'dunes: long windward faces (> 25% of the deep sand at 7-22°)');
  check(maxDune > 14, `dunes: the tallest stands ${maxDune.toFixed(1)} m over the corridors around it (> 14 m)`);
  const P = D.PRACTICE;
  let pg = []; for (let a = 4; a < P.len - 4; a += 2) { const x = P.x + P.dir[0] * a, z = P.z + P.dir[1] * a; pg.push((T.heightAt(x + P.dir[0], z + P.dir[1]) - T.heightAt(x - P.dir[0], z - P.dir[1])) / 2); }
  check(pg.every((g) => Math.abs(g - P.grade) < 0.035), `practice dune: a straight ${(Math.atan(P.grade) * 57.3).toFixed(0)}° face (${Math.min(...pg).toFixed(3)}-${Math.max(...pg).toFixed(3)}), sand depth ${T.sandDepthAt(P.x + P.dir[0] * 20, P.z + P.dir[1] * 20).toFixed(2)}`);
}
// ---- the dune route: drivable by construction (A* limits), checked on the baked ground ----
{
  const t = T.TRAILS.find((q) => q.kind === 'trail' && !q.graded);
  let up = 0, down = 0, drops = 0, climb = 0, prev = null;
  for (let s = 0; s < t.length - 4; s += 2) {
    const a = T.pathPoint(t, s), b = T.pathPoint(t, s + 4), g = (T.heightAt(b.x, b.z) - T.heightAt(a.x, a.z)) / 4;
    up = Math.max(up, g); down = Math.min(down, g);
    if (g < -0.45 && !(prev < -0.45)) drops++;
    if (g > 0) climb += g * 2;
    prev = g;
  }
  check(up < 0.36 && down > -0.75, `${t.name}: ${t.length.toFixed(0)} m, steepest climb ${(Math.atan(up) * 57.3).toFixed(0)}°, steepest descent ${(Math.atan(-down) * 57.3).toFixed(0)}°`);
  check(drops >= 3 && climb > 30, `${t.name}: drops off ${drops} slip faces, ${climb.toFixed(0)} m of climbing`);
  const sand = []; for (let s = 10; s < t.length - 10; s += 5) { const p = T.pathPoint(t, s); sand.push(T.materialAt(p.x, p.z) === MAT.SAND); }
  check(sand.filter(Boolean).length / sand.length > 0.9, `${t.name}: on sand all the way (${(100 * sand.filter(Boolean).length / sand.length).toFixed(0)}%)`);
}
// ---- crawls ----
for (const t of T.TRAILS.filter((q) => q.graded)) {
  let maxG = 0;
  for (let s = 0; s < t.length - 3; s += 1) { const a = T.pathPoint(t, s), b = T.pathPoint(t, s + 3); maxG = Math.max(maxG, Math.abs(b.h - a.h) / 3); }
  console.log(`  ${t.name} (${t.diff}): ${t.length.toFixed(0)} m, climbs ${(t.pts.at(-1).h - t.pts[0].h).toFixed(1)} m, steepest 3 m of tread ${(maxG * 100).toFixed(0)}%`);
}
// ---- places and props ----
for (const pl of D.PLACES) { const p = pl; check(Math.abs(p.x) < T.SIZE / 2 - 30 && Math.abs(p.z) < T.SIZE / 2 - 30, `place ${pl.name} inside the basin`); }
for (const b of D.PROPS) {
  let onPath = false;
  for (const q of graded) for (const pt of q.pts) if (Math.hypot(pt.x - b.x, pt.z - b.z) < q.width / 2 + Math.hypot(b.hx, b.hz) + 1) onPath = true;
  check(!onPath, `camp ${b.kind} at ${b.x.toFixed(0)},${b.z.toFixed(0)} clear of every track`);
}
console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
