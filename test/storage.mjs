// Corrupted / old save data must never stop the game from booting or poison a record.
// Fast (no physics): node test/storage.mjs
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { VEHICLES, ALL_VEHICLES } = await import('../src/specs.js');
const { loadBuild, saveBuild, defaultBuild, sanitizeBuild } = await import('../src/garage.js');
const { RaceLaps } = await import('../src/race.js');

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log('  FAIL', msg); } };
const tryIt = (msg, fn) => { try { return fn(); } catch (e) { fails++; console.log('  FAIL', msg, '->', e.message); return undefined; } };

// garage builds: every rig must load (main.js renders every card from loadBuild at boot)
const BUILDS = 'lowrange.builds.v1';
const raws = [
  '{"taco":null,"lc70":"x","wrx":5,"goat":[1,2],"mule":{"tyreSize":99,"engine":"warp","final":1e9,"lift":2}}',
  'null', '5', '"a string"', '[]', '[{"tyreSize":1}]', '{not json', '',
];
for (const raw of raws) {
  mem.set(BUILDS, raw);
  for (const base of VEHICLES) {
    const b = tryIt(`loadBuild(${base.id}) with ${raw}`, () => loadBuild(base));
    if (b) check(Object.keys(b).length === Object.keys(defaultBuild(base)).length, `loadBuild(${base.id}) with ${raw}: incomplete build`);
  }
  // saving over corrupted data must work and round-trip
  const base = VEHICLES[0];
  tryIt(`saveBuild over ${raw}`, () => saveBuild(base, { ...defaultBuild(base), lift: 1 }));
  check(loadBuild(base).lift === 1, `saveBuild over ${raw} did not persist`);
}
mem.set(BUILDS, '{"mule":{"tyreSize":99,"lift":2}}');
const mule = ALL_VEHICLES.find((v) => v.id === 'mule');
check(loadBuild(mule).tyreSize === 0 && loadBuild(mule).lift === 2, 'stale values dropped, legal ones kept');
for (const junk of [null, undefined, 'x', 7, true]) tryIt(`sanitizeBuild(${junk})`, () => sanitizeBuild(mule, junk));

// race best laps: junk or impossible times must not become an unbeatable record
for (const [raw, want] of [['garbage', null], ['-5', null], ['0', null], ['NaN', null], ['Infinity', null], ['83.4', 83.4]]) {
  mem.set('lowrange.bestlap.race.taco', raw);
  const r = new RaceLaps({ pts: [{ x: 0, z: 0, s: 0 }, { x: 1, z: 0, s: 1 }], length: 1 }, [], 'taco');
  check(r.best === want, `stored best "${raw}" -> ${r.best}, want ${want}`);
}

console.log(fails ? `${fails} FAILURES` : 'storage: all checks passed');
process.exit(fails ? 1 : 0);
