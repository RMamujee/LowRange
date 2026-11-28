// Autopilot on the Gauntlet's side courses (src/maps/crawl_courses.js), the sibling of
// test/crawl.mjs: each rig as it comes (its own lockers, 4WD, low range if it has one, aired
// down) drives a named course from its start spawn and reports, per section, the time it took,
// how far it got, the worst roll it saw and any flip resets (a flipped truck is put back on its
// wheels and counted; a run with a flip doesn't count as finished).
// Line choice: tall boulders and the gully banks are avoided; the crawl-over rocks (cobbles,
// kickers, the rib) are driven over or straddled, as a driver would. On the slab face, and on the
// sections with lanes (Camber Ridge, Cobble Gully), the autopilot takes a named line
// (LINE=easy|hard|extreme, default easy).
// usage: node test/coursedrive.mjs <course=slab|camber|gully|all> [ids=lc70,taco,wrx] [fromSection=1] [stuckSecs=45]
process.env.MAP = 'crawl';
import RAPIER from '@dimforge/rapier3d-compat';
const T = await import('../src/terrain.js');
const { generateRocks, generateTrees, buildTerrainPhysics, heightAt, COURSES, pathPoint } = T;
const { ALL_VEHICLES } = await import('../src/specs.js');
const { Vehicle } = await import('../src/vehicle.js');
await RAPIER.init();
const H = 1 / 200;
const which = process.argv[2] || 'all';
const ids = (process.argv[3] || 'lc70,taco,wrx').split(',');
const from = +(process.argv[4] || 1), stuckSecs = +(process.argv[5] || 45);
const LINE = (process.env.LINE || 'easy').toUpperCase();
// pace (m/s, top of the speed window) by section difficulty; benches and finish brisker
const PACE = { green: 2.2, blue: 1.5, black: 1.2, dblack: 1.0 };

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
const rocks = generateRocks();
for (const r of rocks) { let m = 0, top = -1e9; for (let i = 0; i < r.pts.length; i += 3) { m = Math.max(m, Math.hypot(r.pts[i], r.pts[i + 2])); top = Math.max(top, r.pts[i + 1]); } r.rad = m; r.topH = r.y + top - heightAt(r.x, r.z); }
const terrain = buildTerrainPhysics(RAPIER, world, rocks, generateTrees());

function drive(C, id) {
  const spec = ALL_VEHICLES.find((v) => v.id === id);
  // rocks worth steering round on this course: not the crawl-overs, not ledge pieces, not embedded
  const near = rocks.filter((r) => !r.embed && !r.cobble && !r.kicker && !r.rib && !r.cstep && r.topH > 0.33 && C.pts.some((p, i) => i % 8 === 0 && Math.hypot(p.x - r.x, p.z - r.z) < 16));
  const lineOf = (st) => { const l = st.lines?.find((q) => q[1] === LINE); return l ? l[0] : null; };
  function pickLine(s) {
    const st = C.stageAt(s), u = s - st.s0, ln = LINE.toLowerCase();
    // sections with lanes (Camber Ridge, Cobble Gully): keep to the chosen lane's line, picking a way
    // round the boulders within 1.4 m of it
    const lanes = C.lineAt && st.bands?.length, L = lanes ? C.lineAt(ln, s) : 0;
    if (st.ribs && (!lanes || (st.ribs.lane ?? 'hard') === ln)) return L; // straddle the spine
    const want = lineOf(st);
    if (want !== null) return want * Math.min(1, smooth01((u - 3) / 9)) * Math.min(1, smooth01((st.len - u - 3) / 8)); // onto the line once the face widens
    const hw = C.pts[Math.min(C.pts.length - 1, Math.round(s / 0.5))].w / 2;
    let bestO = L, bestC = -1e9;
    for (let o = lanes ? Math.max(-hw + 0.9, L - 1.4) : -hw + 0.9; o <= (lanes ? Math.min(hw - 0.9, L + 1.4) : hw - 0.9); o += 0.25) {
      let c = 1e9;
      for (let q = s; q < s + 8; q += 1) {
        const p = pathPoint(C, q), x = p.x - p.tz * o, z = p.z + p.tx * o;
        for (const r of near) { if (Math.abs(r.x - x) > 4 || Math.abs(r.z - z) > 4) continue; const d = Math.hypot(r.x - x, r.z - z) - r.rad - spec.track / 2 - 0.15; if (d < c) c = d; }
      }
      c = Math.min(c, 2.5) - Math.abs(o - L) * 0.08; if (c > bestC) { bestC = c; bestO = o; }
    }
    return bestO;
  }
  const st0 = C.stages[from - 1];
  const sStart = st0.s0 - 2, p0 = sStart < 0 ? (() => { const a = pathPoint(C, 0); return { x: a.x + a.tx * sStart, z: a.z + a.tz * sStart, tx: a.tx, tz: a.tz }; })() : pathPoint(C, sStart);
  const car = new Vehicle(RAPIER, world, spec, terrain, { x: p0.x, y: heightAt(p0.x, p0.z) + spec.tire.radius - spec.axleY + 0.3, z: p0.z }, Math.atan2(-p0.tx, -p0.tz));
  car.airedDown = true; const d = car.dt; d.range = spec.ranges.low ? 'low' : 'high'; d.fourWD = true; d.gear = 1;
  d.lockF = !!spec.lockers.front; d.lockR = !!spec.lockers.rear;
  const inp = { throttle: 0, brake: 0, steer: 0 };
  let s = Math.max(0, sStart), best = s, lastGain = 0, flips = 0, el = 0, stage = from - 1, maxRoll = 0;
  const entered = []; if (from > 1) entered[from - 1] = 0;
  const finishS = C.stages.at(-1).gateS;
  for (let i = 0; el < 900; i++) {
    el = i * H;
    if (i % 20 === 0) {
      const p = car.chassis.translation();
      let bs = s, bd = 1e9;
      for (let q = Math.max(0, s - 10); q < Math.min(C.length, s + 20); q += 0.5) { const pp = pathPoint(C, q); const dd = Math.hypot(pp.x - p.x, pp.z - p.z); if (dd < bd) { bd = dd; bs = q; } }
      s = bs;
      if (s > best + 0.5) { best = s; lastGain = el; }
      while (stage < C.stages.length && best >= C.stages[stage].gateS) { entered[stage] = el; stage++; }
      if (best >= finishS) break;
      if (el - lastGain > stuckSecs) break;
      if (i % 100 === 0) car._line = pickLine(s + 2);
      const lk = pathPoint(C, Math.min(C.length, Math.max(s, 0) + 3 + spec.wheelbase)), o = car._line || 0;
      const look = { x: lk.x - lk.tz * o, z: lk.z + lk.tx * o };
      const att = car.attitude(), want = Math.atan2(-(look.x - p.x), -(look.z - p.z));
      maxRoll = Math.max(maxRoll, Math.abs(att.roll));
      let err = want - att.heading; err = Math.atan2(Math.sin(err), Math.cos(err));
      inp.steer = Math.max(-1, Math.min(1, err * 2.2));
      const sec = C.stageAt(s), u = s - sec.s0, onBench = u < 4 || u > sec.len - 4;
      const v = car.speed(), hi = onBench && !sec.finish ? Math.min(1.6, PACE[sec.diff] * 1.3) : PACE[sec.diff], lo = hi * 0.4;
      const floor = Math.min(0.7, 0.05 + Math.max(0, Math.sin(att.pitch)) * 0.7);
      inp.throttle = v < 0 ? Math.min(1, inp.throttle + 0.05) : v < lo * 0.5 ? Math.min(1.0, inp.throttle + 0.02) : v < lo ? Math.min(0.75, inp.throttle + 0.02) : v > hi ? Math.max(floor, inp.throttle - 0.03) : inp.throttle;
      // downhill: off the throttle and on the brakes if it runs away (engine braking does the rest)
      if (v > hi * 1.5) { inp.throttle = Math.min(inp.throttle, floor * 0.6); inp.brake = att.pitch < -0.1 ? 0.6 : 0.4; } else inp.brake = 0;
      if (process.env.TRACE && i % 200 === 0) console.log(`  t=${el.toFixed(0)} sec${sec.n} u=${u.toFixed(1)} v=${v.toFixed(2)} thr=${inp.throttle.toFixed(2)} pitch=${(att.pitch * 57.3).toFixed(0)} roll=${(att.roll * 57.3).toFixed(0)} line=${o.toFixed(1)}`);
      if (car.upsideDown() || Math.abs(att.roll) > 1.2) { flips++; const pp = pathPoint(C, s); car.reset({ x: pp.x, y: heightAt(pp.x, pp.z) + 2, z: pp.z }, Math.atan2(-pp.tx, -pp.tz)); }
    }
    car.step(inp, H);
  }
  if (process.env.TRACE) { // what the chassis and axles are touching at the end
    for (const [nm, b] of [['chassis', car.chassis], ['frontAxle', car.axles?.[0]?.body], ['rearAxle', car.axles?.[1]?.body]].filter((q) => q[1])) {
      for (let k = 0; k < b.numColliders(); k++) {
        const col = b.collider(k);
        world.contactPairsWith(col, (o) => world.contactPair(col, o, (m) => {
          let n = 0; for (let q = 0; q < m.numContacts(); q++) if (m.contactDist(q) < 0.02) n++;
          if (!n) return;
          const tp = o.parent()?.translation(), r = terrain.rockHandles.has(o.handle) && tp ? rocks.find((rr) => Math.abs(rr.x - tp.x) < 1e-3 && Math.abs(rr.z - tp.z) < 1e-3) : null;
          console.log(`  contact: ${nm}#${k} with ${r ? `rock top ${r.topH.toFixed(2)}${r.rib ? ' RIB' : r.cobble ? ' cobble' : r.kicker ? ' kicker' : r.cstep ? ' ledge' : r.embed ? ' embedded' : ''}` : o.handle === terrain.ground.handle ? 'ground' : 'other'} (${n} pts)`);
        }));
      }
    }
  }
  const done = best >= finishS;
  const times = C.stages.map((q, k) => (entered[k] != null && entered[k + 1] != null ? entered[k + 1] - entered[k] : null));
  const last = C.stageAt(best);
  car.destroy();
  return { id, done: done && !flips, reached: done, flips, el, times, last, u: best - last.s0, maxRoll: maxRoll * 57.3 };
}
function smooth01(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

const list = which === 'all' ? COURSES : COURSES.filter((C) => C.id === which);
const summary = [];
for (const C of list) {
  console.log(`${C.name} (${C.id}, ${C.diff}, ${C.length.toFixed(0)} m)${C.stages.some((q) => q.lines) || C.lineAt ? `, ${LINE.toLowerCase()} line` : ''}`);
  for (const id of ids) {
    const r = drive(C, id);
    const where = r.reached ? `FINISHED in ${r.times.filter((x) => x != null).reduce((a, b) => a + b, 0).toFixed(0)} s` : `stuck in section ${r.last.n} ${r.last.name} at u=${r.u.toFixed(1)} m`;
    console.log(`  ${id.padEnd(5)} ${where}${r.flips ? `, ${r.flips} FLIP reset(s)` : ''}, max roll ${r.maxRoll.toFixed(0)} deg`);
    console.log(`        per section: ${C.stages.slice(from - 1, -1).map((q) => `${q.n}:${r.times[q.n - 1] == null ? '-' : r.times[q.n - 1].toFixed(0) + 's'}`).join(' ')}`);
    summary.push(`${C.id}/${id} ${r.done ? 'finished' : r.reached ? 'finished with flips' : 'stuck ' + r.last.n + '/' + C.stages.length}`);
  }
}
console.log('summary: ' + summary.join(', '));
