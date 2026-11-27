// The Gauntlet's run logic (src/crawl_course.js) without physics: walk a point along the trail
// and check the events: start gate, splits, finish + best (persisted per rig), a stage skipped
// via a spur (run doesn't count), Y back to the stage gate (that stage's split restarts).
// usage: node test/crawlcourse.mjs
process.env.MAP = 'crawl';
const { TRAILS, MAP, heightAt, pathPoint } = await import('../src/terrain.js');
const { CrawlCourse } = await import('../src/crawl_course.js');
const t = TRAILS[0], STAGES = MAP.STAGES, N = STAGES.length;
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('  FAIL ' + msg); } else console.log('  ok   ' + msg); };
const at = (s, lat = 0) => { const p = pathPoint(t, s); const x = p.x - p.tz * lat, z = p.z + p.tx * lat; return { x, y: heightAt(x, z) + 0.9, z }; };
// drive from s0 to s1 at v m/s, collecting events
function drive(c, s0, s1, v = 2, dt = 0.05) {
  const ev = [];
  for (let s = s0; s <= s1; s += v * dt) ev.push(...c.update(at(s), dt));
  return ev;
}

const c = new CrawlCourse(t, STAGES);
c.setRig('testrig');
// from the spawn pad, along the approach, through the start gate
let ev = [];
for (let x = MAP.SPAWN.x; x < t.pts[0].x; x += 0.1) ev.push(...c.update({ x, y: heightAt(x, MAP.SPAWN.z) + 0.9, z: MAP.SPAWN.z }, 0.05));
ev.push(...drive(c, 0, 20));
ok(ev.some((e) => e.type === 'start') && c.stage === 1 && c.running, 'start gate starts the run, stage 1');
ok(c.guide().stage === 1 && c.guide().next === 'GATE 2', 'guidance: stage 1/12, next gate 2');
ev = drive(c, 20, STAGES[2].s0 + 5);
const splits = ev.filter((e) => e.type === 'split');
ok(splits.length === 2 && splits[0].stage.n === 1 && splits[1].stage.n === 2 && c.stage === 3, 'gates 2 and 3 split stages 1 and 2');
ok(Math.abs(splits[0].split - (STAGES[1].gateS - STAGES[0].gateS) / 2) < 0.5, `stage 1 split ~ length / speed (${splits[0].split.toFixed(1)} s)`);
// Y in stage 3: back before its gate, drive through again: no split, stage restarts
const before = c.splits.slice();
const r = c.restartPose();
ok(r.stage.n === 3 && c.guide().stage === 3, 'Y puts you back at stage 3\'s gate');
ev = drive(c, STAGES[2].s0 - 1.5, STAGES[2].s0 + 8);
ok(ev.some((e) => e.type === 'stage' && e.retry) && !ev.some((e) => e.type === 'split') && c.stage === 3 && c.stageT < 4, 'driving back through: a retry, no bogus split');
ok(JSON.stringify(c.splits) === JSON.stringify(before), 'earlier splits untouched');
// the rest of the course, at the same speed: finish
ev = drive(c, STAGES[2].s0 + 8, STAGES[N - 1].gateS + 2);
const fin = ev.find((e) => e.type === 'finish');
ok(fin && fin.clean && fin.best && c.done && !c.running, `summit gate finishes a clean run (${fin && fin.time.toFixed(0)} s), first best`);
ok(c.splits.filter((x) => x != null).length === N - 1, 'a split for every stage');
// persisted for the rig
const c2 = new CrawlCourse(t, STAGES); c2.setRig('testrig');
ok(c2.rec.best != null && Math.abs(c2.rec.best - fin.time) < 1e-6 && c2.rec.splits.length === N - 1, 'best + best splits persist per rig');
c2.setRig('otherrig');
ok(c2.rec.best == null, 'another rig has its own record');
// joined by a spur at stage 6: times stages, but the run is not clean
const c3 = new CrawlCourse(t, STAGES); c3.setRig('testrig');
c3.update(at(STAGES[5].s0 - 2, 0), 0.05);
ev = drive(c3, STAGES[5].s0 - 2, STAGES[7].gateS + 2);
ok(c3.running && !c3.clean && c3.stage === 8 && ev.filter((e) => e.type === 'split').length === 2, 'spur entry at stage 6: stages timed, run marked not clean');
ev = drive(c3, STAGES[7].gateS + 2, STAGES[N - 1].gateS + 2, 4);
const fin3 = ev.find((e) => e.type === 'finish');
ok(fin3 && !fin3.clean && !fin3.best && c3.rec.best === fin.time, 'its finish is no best, even though faster');
// teleports and reversing don't cross gates
const c4 = new CrawlCourse(t, STAGES);
c4.update(at(5), 0.05);
ok(c4.update(at(STAGES[4].gateS + 1), 0.05).length === 0, 'a teleport past gates crosses nothing');
ok(drive(c4, STAGES[4].gateS + 1, STAGES[4].gateS - 3, -1).length === 0, 'reversing back through a gate crosses nothing');
// Y before stage 2 (or after the finish): back to the course start, run reset
const c5 = new CrawlCourse(t, STAGES); c5.update(at(0), 0.05); drive(c5, 0, 30);
const r5 = c5.restartPose();
ok(r5.stage.n === 1 && !c5.running && c5.stage === 0, 'Y in stage 1: back to the start, run reset');
// the off-course check: a point on the next switchback leg (far below/above) is not "on" the trail
const leg = at(STAGES[6].s0 + 20);
ok(!new CrawlCourse(t, STAGES).project({ x: leg.x, y: leg.y + 20, z: leg.z }).on, 'off the corridor height: not on the course');
// regression (playtest): spawned at stage 5's gate (spawnAt: reset + joinAt), Y before driving
// through it went back to the course start; it must come back to stage 5's gate
{
  const c6 = new CrawlCourse(t, STAGES); c6.setRig('testrig');
  c6.reset(); c6.joinAt(5);
  ok(c6.guide().target === STAGES[4].gate && c6.guide().next === 'GATE 5', 'stage 5 spawn: the HUD points at gate 5');
  c6.update(at(STAGES[4].s0 - 4), 0.05);
  const r6 = c6.restartPose();
  ok(r6.stage.n === 5 && r6.joined && Math.hypot(r6.x - at(STAGES[4].s0 - 1.5).x, r6.z - at(STAGES[4].s0 - 1.5).z) < 1, 'Y right after a stage 5 spawn: back at stage 5\'s gate, not the start');
  ok(c6.guide().next === 'GATE 5' && !c6.running, 'still pointing at gate 5, nothing running');
  ok(c6.restartPose().stage.n === 5, 'Y again: still stage 5');
  ev = drive(c6, STAGES[4].s0 - 1.5, STAGES[5].gateS + 2);
  ok(c6.running && !c6.clean && c6.stage === 6 && ev.filter((e) => e.type === 'split').length === 1 && ev.find((e) => e.type === 'split').stage.n === 5, 'driving through: joins at stage 5 (timed, not clean)');
  ok(c6.restartPose().stage.n === 6 && !c6.joined, 'after a gate, Y works per stage as before');
  // a fresh trailhead start (reset) forgets the join
  c6.reset();
  ok(c6.restartPose().stage.n === 1, 'after reset (trailhead restart): Y goes to the course start');
  // a stage 1 spawn is no join at all
  c6.reset(); c6.joinAt(1);
  ok(c6.restartPose().stage.n === 1 && c6.guide().next === 'GATE 1', 'stage 1 spawn: Y goes to the start gate');
}
// regression (playtest): corrupted saved bests (negative, zero, absurdly small, NaN, wrong type)
// are not records, so they can't make a best unbeatable
{
  const key = 'lowrange.crawl.junkrig';
  // a localStorage stand-in (crawl_course.js reads it when present, as in the browser)
  const ls = new Map();
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) };
  const setStored = (k, v) => ls.set(k, v);
  const mem = () => new CrawlCourse(t, STAGES);
  const cases = [['{"best":-5,"splits":[-1,0,1e-9,"3",null,5]}', null], ['{"best":0}', null], ['{"best":0.001}', null], ['{"best":"120"}', null], ['[1,2]', null], ['"x"', null], ['{"best":null,"splits":{}}', null], ['{"best":600,"splits":[40]}', 600]];
  for (const [raw, want] of cases) {
    setStored(key, raw);
    const c = mem(raw); c.setRig('junkrig');
    const junkSplits = c.rec.splits.every((x) => x == null || (x > 1 && Number.isFinite(x)));
    ok(c.rec.best === want && junkSplits, `stored ${raw}: best ${c.rec.best}, splits ${JSON.stringify(c.rec.splits)}`);
  }
  // a real run then sets a best over the junk
  setStored(key, '{"best":-5,"splits":[-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1]}');
  const c7 = new CrawlCourse(t, STAGES); c7.setRig('junkrig');
  c7.update(at(0), 0.05);
  ev = drive(c7, 0, STAGES[N - 1].gateS + 2, 4);
  const fin7 = ev.find((e) => e.type === 'finish');
  ok(fin7 && fin7.best && c7.rec.best === fin7.time && ev.filter((e) => e.type === 'split').every((e) => e.best), 'a clean run beats a junk record (total and every split)');
}
console.log(fails ? `${fails} failure(s)` : 'all crawl course checks passed');
process.exit(fails ? 1 : 0);
