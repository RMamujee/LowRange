// Recovery points (src/winch/recovery_points.js) on every map: each map yields posts, every post passes
// its footprint check (and an independent one: not inside any fixed rock's hull, not in water or a bog,
// off every path's tread, on ground no steeper than allowed, clear of trunks and props), and every crux
// the map lists (steps, climbs, bogs, fords, course sections) has a post ahead of the stuck truck within
// reach and in sight.
//   node test/recovery_points.mjs            all five maps, each in its own process (maps bake at import)
//   node test/recovery_points.mjs crawl      one map
const MAPS = ['park', 'race', 'crawl', 'jungle', 'desert'];
const one = process.argv[2];
if (!one) {
  const { spawnSync } = await import('node:child_process');
  const file = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  let fails = 0;
  for (const m of MAPS) {
    const r = spawnSync(process.execPath, [file, m], { encoding: 'utf8', env: { ...process.env, MAP: m } });
    process.stdout.write(r.stdout || ''); if (r.stderr) process.stdout.write(r.stderr);
    const n = (r.stdout.match(/^FAIL/gm) || []).length;
    fails += n || (r.status !== 0 ? 1 : 0);
  }
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall recovery point checks passed');
  process.exit(fails ? 1 : 0);
}
process.env.MAP = one;
const T = await import('../src/terrain.js');
const { buildRecoveryPoints, rockRecords, RP } = await import('../src/winch/recovery_points.js');
const { MAT, heightAt, materialAt, TRAILS, ROADS, COURSES, TRACK, PROPS } = T;
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} [${one}] ${msg}`); if (!ok) fails++; };
const rocks = T.generateRocks(), trees = T.generateTrees(rocks);
const t0 = Date.now();
const r = buildRecoveryPoints({ rocks, trees });
const ms = Date.now() - t0;
const kinds = {}; for (const c of r.cruxes) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
console.log(`     ${one}: ${r.posts.length} recovery posts for ${r.cruxes.length} cruxes (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}), built in ${ms} ms`);
check(r.posts.length > 0, 'the map yields recovery points');
check(r.cruxes.length > 0, 'the map lists cruxes');

// 1. each post passes the footprint check it was placed under
const bad = r.posts.filter((P) => r.footprint(P.x, P.z, P.slope, P.margin));
check(!bad.length, `every post passes its footprint check${bad.length ? ': ' + bad.slice(0, 4).map((P) => `${P.id} (${r.footprint(P.x, P.z, P.slope, P.margin)})`).join(', ') : ''}`);
// 2. independent checks
const recs = rockRecords(rocks);
const inHull = (H, x, z) => { for (let i = 0; i < H.length; i++) { const a = H[i], b = H[(i + 1) % H.length]; if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false; } return H.length >= 3; };
const paths = [...TRAILS, ...COURSES, ...ROADS, ...(TRACK ? [TRACK] : [])];
const treadDist = (x, z) => {
  let best = Infinity;
  for (const p of paths) for (let i = 1; i < p.pts.length; i++) {
    const a = p.pts[i - 1], b = p.pts[i], ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / L2));
    best = Math.min(best, Math.hypot(x - a.x - ex * t, z - a.z - ez * t) - p.width / 2);
  }
  return best;
};
const issues = [];
for (const P of r.posts) {
  const why = [];
  if (recs.some((q) => Math.hypot(P.x - q.x, P.z - q.z) < q.r && inHull(q.hull, P.x, P.z))) why.push('inside a rock');
  const m = materialAt(P.x, P.z); if (m === MAT.WATER || m === MAT.MUD) why.push(m === MAT.WATER ? 'in water' : 'in a bog');
  const td = treadDist(P.x, P.z); if (td < RP.EDGE - 0.01) why.push(`on the tread (${td.toFixed(2)} m from its edge)`);
  const g = Math.hypot(heightAt(P.x + 0.7, P.z) - heightAt(P.x - 0.7, P.z), heightAt(P.x, P.z + 0.7) - heightAt(P.x, P.z - 0.7)) / 1.4; if (g > RP.BANK_SLOPE + 1e-6) why.push(`grade ${g.toFixed(2)}`);
  if (trees.some((t) => Math.hypot(P.x - t.x, P.z - t.z) < 0.22 * (t.s ?? 1) + RP.POST_R)) why.push('in a trunk');
  if (PROPS.some((b) => Math.hypot(P.x - b.x, P.z - b.z) < Math.min(b.hx, b.hz) + RP.POST_R)) why.push('in a prop');
  if (why.length) issues.push(`${P.id} ${why.join(', ')}`);
}
check(!issues.length, `no post inside a rock, in water or a bog, on a tread, too steep, in a trunk or a prop${issues.length ? ': ' + issues.slice(0, 5).join('; ') : ''}`);
const edgePosts = r.posts.filter((P) => P.margin < RP.TREAD_MARGIN).length, bankPosts = r.posts.filter((P) => P.slope > RP.POST_SLOPE).length;
console.log(`     placement: ${r.posts.length - bankPosts} on ground up to ${RP.POST_SLOPE}, ${bankPosts} driven into a bank (up to ${RP.BANK_SLOPE}), ${edgePosts} of those right at a tread edge (${RP.EDGE} m out)`);
// 3. every crux has a post within reach, ahead of the stuck nose, not far below it, in sight
const byId = new Map(r.posts.map((P) => [P.id, P]));
const missing = [];
for (const cx of r.cruxes) {
  const P = byId.get(cx.post);
  if (!P) { missing.push(`${cx.kind} ${cx.pathName} s=${cx.s}`); continue; }
  const d = Math.hypot(P.x - cx.B.x, P.z - cx.B.z), ahead = (P.x - cx.B.x) * cx.dir.x + (P.z - cx.B.z) * cx.dir.z;
  if (d > RP.REACH + 1e-6 || ahead <= RP.AHEAD - 1e-6 || P.y < cx.B.y - RP.BELOW || !r.sight(cx.B, P)) missing.push(`${cx.kind} ${cx.pathName} s=${cx.s} (post ${P.id} at ${d.toFixed(1)} m, ${ahead.toFixed(1)} m ahead)`);
}
check(!missing.length && !r.uncovered.length, `every crux has a recovery post within ${RP.REACH} m, ahead and in sight${missing.length ? ': ' + missing.slice(0, 5).join('; ') : ''}`);
// the obvious ones by name, where the map has them
const want = { park: [['Bog Run', 'bog'], ['Granite Steps', 'step'], ['Widowmaker Falls', 'step']], crawl: [['The Gauntlet', 'ford'], ['The Gauntlet', 'bog'], ['The Gauntlet', 'section'], ['Cobble Gully', 'section']], jungle: [['Ember Stairs', 'step'], ['Riverbed Run', 'ford']], desert: [['Redwall Stairway', 'step']], race: [['Dust Bowl Circuit', 'ford']] }[one] ?? [];
for (const [name, kind] of want) check(r.cruxes.some((c) => c.pathName === name && c.kind === kind && c.post), `${name}: its ${kind} cruxes are found and covered`);
process.exit(fails ? 1 : 0);
