// The side courses (src/maps/crawl_courses.js) must leave The Gauntlet exactly as it was. Builds the
// crawl map twice in child processes, with the courses and without them (LOWRANGE_NO_COURSES=1),
// and compares: every grid cell within 6 m of a Gauntlet path cell (trail, bypass, spurs: height,
// shown height, material, path tag), every Gauntlet rock and every tree. The only differences
// allowed are boulders and trees removed where the courses or their tracks reshaped the ground,
// and those must be well away (8 m) from The Gauntlet's paths.
// usage: node test/gauntletsame.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

if (process.env.GS_OUT) {
  // child: dump this build
  process.env.MAP = 'crawl';
  const T = await import('../src/terrain.js');
  const { GRID, ROADS, SIZE, RES, COURSES } = T;
  const N1 = RES + 1, trailId = ROADS.length;
  const tag = (id) => (id < 0 ? '' : id < trailId ? ROADS[id].name : id === trailId ? 'trail' : 'course');
  const rocks = T.generateRocks().map((r) => `${r.x.toFixed(5)},${r.y.toFixed(5)},${r.z.toFixed(5)},${r.rotY.toFixed(5)},${r.pts.length}`);
  const trees = T.generateTrees().map((t) => `${t.x.toFixed(5)},${t.y.toFixed(5)},${t.z.toFixed(5)},${t.s.toFixed(5)}`);
  const cells = [];
  for (let i = 0; i < N1 * N1; i++) cells.push([GRID.h[i], GRID.vis[i], GRID.mat[i], tag(GRID.path[i])]);
  writeFileSync(process.env.GS_OUT, JSON.stringify({ N1, SIZE, cells, rocks, trees, courses: COURSES.length }));
  process.exit(0);
}

const run = (noCourses) => {
  const out = join(tmpdir(), `lowrange-gs-${process.pid}-${noCourses ? 'before' : 'after'}.json`);
  const env = { ...process.env, GS_OUT: out };
  if (noCourses) env.LOWRANGE_NO_COURSES = '1'; else delete env.LOWRANGE_NO_COURSES;
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit' });
  if (r.status !== 0) { console.log('build failed'); process.exit(1); }
  const d = JSON.parse(readFileSync(out, 'utf8')); rmSync(out); return d;
};
const A = run(true), B = run(false);
let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
check(A.courses === 0 && B.courses >= 3, `built without the courses (${A.courses}) and with them (${B.courses})`);
// distance (in cells, chessboard) from The Gauntlet's path cells in the build without courses
const { N1 } = A, gauntlet = (t) => t !== '' && t !== 'course';
const near = new Uint8Array(N1 * N1);
const R = 6, idx = [];
for (let i = 0; i < N1 * N1; i++) if (gauntlet(A.cells[i][3])) idx.push(i);
for (const i of idx) { const ix = Math.floor(i / N1), iz = i % N1; for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) { const x = ix + dx, z = iz + dz; if (x >= 0 && z >= 0 && x < N1 && z < N1 && dx * dx + dz * dz <= R * R) near[x * N1 + z] = 1; } }
let n = 0, diff = 0, first = null;
for (let i = 0; i < N1 * N1; i++) {
  if (!near[i]) continue; n++;
  const a = A.cells[i], b = B.cells[i];
  if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3]) { diff++; first ||= { x: Math.floor(i / N1) - (N1 - 1) / 2, z: (i % N1) - (N1 - 1) / 2, before: a, after: b }; }
}
check(diff === 0, `${n} grid cells within ${R} m of The Gauntlet's trail, bypass and spurs: ${diff} differ${first ? ` (first at ${first.x},${first.z}: ${JSON.stringify(first.before)} -> ${JSON.stringify(first.after)})` : ''}`);
// the bog (Bog & Ford): every mud cell over the whole map, before and after, with the same floor and
// shown surface, so the deformable mud field built from them (src/mud.js) is the same too
{
  const MUD = 3, mudA = [], mudB = [];
  for (let i = 0; i < N1 * N1; i++) { if (A.cells[i][2] === MUD) mudA.push(`${i}:${A.cells[i][0]}:${A.cells[i][1]}`); if (B.cells[i][2] === MUD) mudB.push(`${i}:${B.cells[i][0]}:${B.cells[i][1]}`); }
  check(mudA.length > 0 && mudA.join() === mudB.join(), `mud cells (the bog): ${mudA.length} before, ${mudB.length} after, ${mudA.join() === mudB.join() ? 'identical' : 'DIFFERENT'}`);
}
// rocks and trees: every one from before is still there, unless it was removed away from the paths
const nearPath = (x, z, m) => { const ix = Math.round(x + (N1 - 1) / 2), iz = Math.round(z + (N1 - 1) / 2); for (let dx = -m; dx <= m; dx++) for (let dz = -m; dz <= m; dz++) { const k = (ix + dx) * N1 + iz + dz; if (k >= 0 && k < N1 * N1 && gauntlet(A.cells[k][3])) return true; } return false; };
for (const [what, a, b] of [['rocks', A.rocks, B.rocks], ['trees', A.trees, B.trees]]) {
  const after = new Set(b), gone = a.filter((k) => !after.has(k));
  const bad = gone.filter((k) => { const [x, , z] = k.split(',').map(Number); return nearPath(x, z, 8); });
  check(bad.length === 0, `${what}: ${a.length} before, ${a.length - gone.length} unchanged, ${gone.length} removed where the courses run, ${bad.length} of them within 8 m of a Gauntlet path${bad.length ? ` (${bad.slice(0, 3).join(' | ')})` : ''}`);
}
console.log(fails ? `${fails} FAILED` : 'The Gauntlet is unchanged');
process.exit(fails ? 1 : 0);
