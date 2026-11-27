// Stored map waypoints: junk or off-map entries must be dropped on load, legal ones kept, on every
// map (each has its own size). Fast (no physics, no browser): node test/waypoints.mjs
// The map is picked at import (MAP env var), so the script runs itself once per map.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.MAP) {
  let failed = 0;
  for (const map of ['park', 'race', 'crawl']) {
    try { process.stdout.write(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, MAP: map }, encoding: 'utf8' })); }
    catch (e) { failed++; process.stdout.write(e.stdout || ''); console.log(`  FAIL ${map}: ${e.message.split('\n')[0]}`); }
  }
  console.log(failed ? `${failed} MAP(S) FAILED` : 'waypoints: all checks passed on every map');
  process.exit(failed ? 1 : 0);
}

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { SIZE, MAP_ID } = await import('../src/terrain.js');
const { Waypoints } = await import('../src/hud/mapview.js');

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log(`  FAIL [${MAP_ID}]`, msg); } };
const KEY = `lowrange.waypoints.${MAP_ID}`;
const load = (raw) => { mem.set(KEY, raw); try { return new Waypoints(MAP_ID).list; } catch (e) { fails++; console.log(`  FAIL [${MAP_ID}] new Waypoints with ${raw} ->`, e.message); return []; } };
const edge = SIZE / 2;

// off-map (the playtest's x = 1e9 showed "1414213738 M"), non-numbers and nulls go; legal entries stay
const l = load(JSON.stringify([{ x: 1e9, z: 0 }, null, { x: '5', z: 5 }, { x: 10, z: -20 }, 7, { x: -edge, z: edge }, { z: 3 }]));
check(JSON.stringify(l) === JSON.stringify([{ x: 10, z: -20 }, { x: -edge, z: edge }]), `junk dropped, legal kept: ${JSON.stringify(l)}`);
check(load(JSON.stringify([{ x: edge + 1, z: 0 }, { x: 0, z: -edge - 1 }])).length === 0, 'points just off the map are dropped');
check(load(JSON.stringify([{ x: 1, z: 1, junk: 'x'.repeat(100) }]))[0].junk === undefined, 'only x / z are kept from a stored point');
check(load(JSON.stringify([{ x: 1, z: 1 }, { x: 2, z: 2 }, { x: 3, z: 3 }, { x: 4, z: 4 }])).length === 3, 'at most max waypoints');
for (const raw of ['{not json', 'null', '5', '{"x":1}', '']) check(load(raw).length === 0, `unreadable store ${raw} -> empty`);

console.log(`  ${MAP_ID} (size ${SIZE} m): ${fails ? fails + ' failures' : 'ok'}`);
process.exit(fails ? 1 : 0);
