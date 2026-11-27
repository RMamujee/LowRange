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
// ---- the side courses (src/maps/crawl_courses.js) on the same class, and the CourseSet ----
{
  const { COURSES } = await import('../src/terrain.js');
  const { CourseSet } = await import('../src/crawl_course.js');
  const atC = (C, s, lat = 0) => { const p = pathPoint(C, Math.max(0, Math.min(C.length, s))); const ext = s < 0 ? s : s > C.length ? s - C.length : 0; const x = p.x + p.tx * ext - p.tz * lat, z = p.z + p.tz * ext + p.tx * lat; return { x, y: heightAt(x, z) + 0.9, z }; };
  const driveC = (c, C, s0, s1, v = 1, dt = 0.05) => { const out = []; for (let s = s0; s <= s1; s += v * dt) out.push(...c.update(atC(C, s), dt)); return out; };
  const mk = (C) => new CrawlCourse(C, C.stages, { key: `lowrange.course.${C.id}`, unit: 'Section', finish: 'FINISH', id: C.id });
  ok(COURSES.length >= 3 && COURSES.every((C) => C.stages.length >= 3 && C.stages.at(-1).finish), `${COURSES.length} side courses: ${COURSES.map((C) => `${C.name} (${C.diff}, ${C.stages.length - 1} sections)`).join(', ')}`);
  const gauntletBefore = globalThis.localStorage.getItem('lowrange.crawl.testrig2');
  for (const C of COURSES) {
    const N = C.stages.length, c = mk(C); c.setRig('testrig2');
    let e = driveC(c, C, -3, C.stages[0].gateS + 2);
    ok(e.some((q) => q.type === 'start') && c.running && c.guide().unit === 'SECTION' && c.guide().stage === 1, `${C.name}: the start gate starts the run; HUD reads SECTION 1/${N}`);
    e = driveC(c, C, C.stages[0].gateS + 2, C.stages[N - 1].gateS + 2);
    const fin = e.find((q) => q.type === 'finish');
    ok(fin && fin.clean && fin.best && e.filter((q) => q.type === 'split').length === N - 1, `${C.name}: a split per section, the finish gate ends a clean run (${fin && fin.time.toFixed(0)} s), first best`);
    ok(c.guide().name === 'FINISH' && c.guide().next === 'COURSE DONE', `${C.name}: the HUD says FINISH, course done`);
    const c2 = mk(C); c2.setRig('testrig2');
    ok(c2.rec.best === fin.time && c2.rec.splits.length === N - 1, `${C.name}: best + splits saved for the rig (key lowrange.course.${C.id}.testrig2)`);
    c2.setRig('otherrig2'); ok(c2.rec.best == null, `${C.name}: another rig has its own record`);
    // Y mid-course: back to the gate of the section you're in; in section 1: the course start
    const c3 = mk(C); c3.update(atC(C, -3), 0.05); driveC(c3, C, -3, C.stages[1].gateS + 3);
    const r3 = c3.restartPose();
    ok(r3.stage.n === 2 && c3.retry === 2, `${C.name}: Y in section 2 goes back to its gate`);
    const c4 = mk(C); c4.update(atC(C, -3), 0.05); driveC(c4, C, -3, C.stages[0].gateS + 3);
    const r4 = c4.restartPose(), p0 = atC(C, 0.5);
    ok(r4.stage.n === 1 && Math.hypot(r4.x - p0.x, r4.z - p0.z) < 1 && !c4.running, `${C.name}: Y in section 1 goes back to the course start, run reset`);
  }
  ok(globalThis.localStorage.getItem('lowrange.crawl.testrig2') === gauntletBefore, 'side course runs leave the Gauntlet\'s saved bests alone');

  // CourseSet: focus, one run at a time, spawns + Y
  const G = new CrawlCourse(t, STAGES), sides = COURSES.map(mk), set = new CourseSet(G, sides);
  set.setRig('testrig3');
  const slab = COURSES[0], camber = COURSES.find((C) => C.id === 'camber') || COURSES[1];
  set.update({ x: MAP.SPAWN.x, y: heightAt(MAP.SPAWN.x, MAP.SPAWN.z) + 0.9, z: MAP.SPAWN.z }, 0.05);
  ok(set.focus === G && set.guide().unit === 'STAGE', 'at the trailhead the HUD follows The Gauntlet (STAGE n/12)');
  set.update(at(0), 0.05); let ev2 = []; for (let s = 0; s <= 10; s += 0.1) ev2.push(...set.update(at(s), 0.05));
  ok(G.running && ev2.some((q) => q.type === 'start' && q.course === G), 'a Gauntlet run starts at its gate');
  // spawn at the Camber Ridge start: the Gauntlet run is cancelled, the HUD follows the course
  set.spawnAt({ kind: 'course', course: camber.id, stage: 1 });
  set.update(atC(camber, -2.5), 0.05);
  ok(!G.running && set.focus.id === camber.id && set.guide().name === camber.name.toUpperCase() && set.guide().next === 'START GATE', 'a course start spawn: no run, the HUD points at its start gate and names it');
  ok(set.restartPose().stage.n === 1 && set.restartPose().course.id === camber.id, 'Y right after the start spawn: the course start');
  // a mid-course spawn, Y before driving: back to that section's gate (the playtest bug's class)
  set.spawnAt({ kind: 'course', course: camber.id, stage: 3 });
  set.update(atC(camber, camber.stages[2].s0 - 2), 0.05);
  const r5 = set.restartPose();
  ok(r5.course.id === camber.id && r5.stage.n === 3 && r5.joined && set.guide().next === 'GATE 3', 'a section 3 spawn, Y at once: back at section 3\'s gate, the HUD still points at gate 3');
  // the finish spawn: Y goes to the course start
  set.spawnAt({ kind: 'course', course: camber.id, stage: 0 });
  set.update(atC(camber, camber.stages.at(-1).gateS + 5.5), 0.05);
  ok(set.focus.id === camber.id && set.restartPose().stage.n === 1, 'the finish spawn: Y takes you to the course start');
  // one run at a time: start the slab while a camber run is going
  set.reset(); const sc = set.byId(camber.id), ss = set.byId(slab.id);
  for (let s = -3; s < camber.stages[0].gateS + 4; s += 0.1) set.update(atC(camber, s), 0.05);
  ok(sc.running, 'a Camber Ridge run is going');
  ev2 = []; ss.s = null; for (let s = -3; s < slab.stages[0].gateS + 4; s += 0.1) ev2.push(...set.update(atC(slab, s), 0.05));
  ok(ss.running && !sc.running && ev2.some((q) => q.type === 'cancel' && q.course === sc), 'starting Broken Slab cancels the Camber Ridge run');
  const snap = set.snapshot();
  ok(snap.course && snap.course.id === slab.id && snap.course.running && snap.of === STAGES.length, 'the map snapshot: The Gauntlet\'s stages plus the course in focus');
  // regression (review): the whole Gauntlet driven through the CourseSet stays The Gauntlet's: the
  // trailhead (Camber Track starts at its lot) and the summit (Gully Track starts at its pad) must
  // not hand the HUD or Y to a side course
  {
    const G2 = new CrawlCourse(t, STAGES), set2 = new CourseSet(G2, COURSES.map(mk)); set2.setRig('testrig4');
    const evs = [], foci = new Set();
    for (let x = MAP.SPAWN.x; x < t.pts[0].x; x += 0.1) { evs.push(...set2.update({ x, y: heightAt(x, MAP.SPAWN.z) + 0.9, z: MAP.SPAWN.z }, 0.05)); foci.add(set2.focus.id); }
    ok(set2.focus === G2 && set2.guide().unit === 'STAGE', 'leaving the trailhead: The Gauntlet in focus');
    for (let s = 0; s <= STAGES[N - 1].gateS + 8; s += 0.1) { evs.push(...set2.update(at(s), 0.05)); foci.add(set2.focus.id); }
    ok(evs.some((e) => e.type === 'start' && e.course === G2) && evs.every((e) => e.course === G2) && evs.some((e) => e.type === 'finish' && e.course === G2), 'a full Gauntlet run: every event is The Gauntlet\'s, start to finish');
    ok(foci.size === 1 && foci.has('gauntlet'), `focus never left The Gauntlet (${[...foci].join(', ')})`);
    const gd = set2.guide();
    ok(set2.focus === G2 && gd.name === 'SUMMIT' && gd.next === 'COURSE DONE' && gd.unit === 'STAGE', 'at the summit: HUD says SUMMIT, COURSE DONE');
    for (const [x, z] of [[MAP.SUMMIT.x, MAP.SUMMIT.z], [MAP.SUMMIT.x + 12, MAP.SUMMIT.z - 8], [MAP.SUMMIT.x - 10, MAP.SUMMIT.z - 10]]) set2.update({ x, y: heightAt(x, z) + 0.9, z }, 0.05);
    const r = set2.restartPose();
    ok(set2.focus === G2 && r.course === G2 && r.stage.n === 1, 'driving round the summit pad: still The Gauntlet, Y goes to its start');
  }
  // review: after a side course's finish, driving off along its exit track, Y still goes to that
  // course's start until the truck is well away
  {
    const set3 = new CourseSet(new CrawlCourse(t, STAGES), COURSES.map(mk)), cam = set3.byId(camber.id); set3.setRig('testrig5');
    for (let s = -3; s <= camber.stages.at(-1).gateS + 3; s += 0.1) set3.update(atC(camber, s), 0.05);
    ok(cam.done, 'Camber Ridge driven to its finish');
    const exit = MAP.ACCESS.find((r) => r.course === camber.id && r.access === 'out');
    for (let s = 0; s <= exit.length * 0.8; s += 0.5) { const p = pathPoint(exit, s); set3.update({ x: p.x, y: heightAt(p.x, p.z) + 0.9, z: p.z }, 0.05); }
    const r3 = set3.restartPose();
    ok(r3.course.id === camber.id && r3.stage.n === 1, 'off along Camber Exit: Y goes to the Camber Ridge start');
    set3.update({ x: MAP.SPAWN.x, y: heightAt(MAP.SPAWN.x, MAP.SPAWN.z) + 0.9, z: MAP.SPAWN.z }, 0.05);
    ok(set3.focus === set3.gauntlet, 'back at the trailhead, far away: The Gauntlet again');
  }
  // re-review: back on The Gauntlet after a side course, The Gauntlet wins over the held course
  {
    const finishThen = (C, where, label) => {
      const set4 = new CourseSet(new CrawlCourse(t, STAGES), COURSES.map(mk)); set4.setRig('testrig6');
      for (let s = -3; s <= C.stages.at(-1).gateS + 3; s += 0.1) set4.update(atC(C, s), 0.05);
      const done = set4.byId(C.id).done;
      set4.update(where, 0.05); set4.update(where, 0.05);
      const r = set4.restartPose();
      ok(done && set4.focus === set4.gauntlet && r.course === set4.gauntlet && r.stage.n === 1, `${label}: The Gauntlet in focus, Y to its start`);
    };
    const slabC = COURSES.find((C) => C.id === 'slab'), gullyC = COURSES.find((C) => C.id === 'gully');
    finishThen(slabC, at(STAGES[10].s0 + 20), 'Broken Slab finished, then mid-stage on stage 11');
    finishThen(gullyC, at(STAGES[11].s0 + 15), 'Cobble Gully finished, then on stage 12');
    finishThen(camber, at(STAGES[0].s0 + 30), 'Camber Ridge finished, then on stage 1');
    // after a Gauntlet finish, round the summit pad and over the mouth of the Slab Track
    const set5 = new CourseSet(new CrawlCourse(t, STAGES), COURSES.map(mk)); set5.setRig('testrig7');
    for (let s = 0; s <= STAGES[N - 1].gateS + 8; s += 0.1) set5.update(at(s), 0.05);
    const track = MAP.ACCESS.find((r) => r.name === 'Slab Track'), foci5 = new Set();
    for (let a = 0; a < Math.PI * 2; a += 0.2) { const x = MAP.SUMMIT.x + Math.cos(a) * 15, z = MAP.SUMMIT.z + Math.sin(a) * 15; set5.update({ x, y: heightAt(x, z) + 0.9, z }, 0.05); foci5.add(set5.focus.id); }
    const upd = (p) => set5.update({ x: p.x, y: heightAt(p.x, p.z) + 0.9, z: p.z }, 0.05);
    for (let s = 0; s <= 2; s += 0.5) { upd(pathPoint(track, s)); foci5.add(set5.focus.id); }
    const hud5 = set5.guide().name, r5b = set5.restartPose(); // (Y resets the finished run: read the HUD first)
    ok(foci5.size === 1 && foci5.has('gauntlet') && r5b.course === set5.gauntlet && r5b.stage.n === 1 && hud5 === 'SUMMIT', `after the summit, 15 m round the pad and over the Slab Track's mouth: still The Gauntlet (${[...foci5].join(', ')}; HUD ${hud5}), Y to its start`);
    // ...but heading on down the Slab Track does mean Broken Slab, and back on the pad The Gauntlet again
    for (let s = 2; s <= 12; s += 0.5) upd(pathPoint(track, s));
    const onTrack = set5.focus.id;
    upd(MAP.SUMMIT);
    ok(onTrack === 'slab' && set5.focus === set5.gauntlet, `10 m down the Slab Track: ${onTrack}; back on the summit pad: The Gauntlet`);
  }
  // regression: past a course's last point (out along its line, at its height) is not "on" it; the
  // last point has no next one, which used to make every such spot read as dead centre
  for (const C of COURSES) {
    const e = pathPoint(C, C.length), x = e.x + e.tx * 40, z = e.z + e.tz * 40;
    ok(!mk(C).project({ x, y: e.h + 0.9, z }).on, `${C.name}: 40 m past its end is off the course`);
  }
}
console.log(fails ? `${fails} failure(s)` : 'all crawl course checks passed');
process.exit(fails ? 1 : 0);
