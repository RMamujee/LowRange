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
console.log(fails ? `${fails} failure(s)` : 'all crawl course checks passed');
process.exit(fails ? 1 : 0);
