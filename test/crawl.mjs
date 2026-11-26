// Autopilot on The Gauntlet (MAP=crawl): drive the course from the start gate (or from any
// stage gate) and report, per rig, the furthest stage reached and the time spent in each stage.
// Unlike test/trails.mjs it drives each rig as it comes (its own lockers, 4WD, low range if it
// has one) and paces by stage: brisk on the bog, slow on ledges.
// usage: node test/crawl.mjs [ids=lc70,taco,wrx] [fromStage=1] [toStage=12] [stuckSecs=45]
//   e.g. node test/crawl.mjs lc70 11 11   -> just the Waterfall, from its gate
process.env.MAP = 'crawl';
import RAPIER from '@dimforge/rapier3d-compat';
const T = await import('../src/terrain.js');
const { generateRocks, generateTrees, buildTerrainPhysics, heightAt, TRAILS, MAP, pathPoint } = T;
const { ALL_VEHICLES } = await import('../src/specs.js');
const { Vehicle } = await import('../src/vehicle.js');
await RAPIER.init();
const H = 1 / 200;
const t = TRAILS[0], STAGES = MAP.STAGES;
const ids = (process.argv[2] || 'lc70,taco,wrx').split(',');
const from = +(process.argv[3] || 1), to = +(process.argv[4] || STAGES.length), stuckSecs = +(process.argv[5] || 45);
// autopilot pace (m/s, upper bound of the speed window) per stage
const PACE = { 'Warm-up': 3, Articulation: 1.8, 'Ledges I': 1.6, 'Side-slope': 1.8, 'Boulder Garden I': 1.5, 'The Climb': 1.6, 'Ledges II': 1.4, 'Bog & Ford': 3.2, 'Notches & Squeezes': 1.2, 'Boulder Garden II': 1.2, 'The Waterfall': 1.2, Summit: 2 };

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
const rocks = generateRocks();
for (const r of rocks) { let m = 0, top = -1e9; for (let i = 0; i < r.pts.length; i += 3) { m = Math.max(m, Math.hypot(r.pts[i], r.pts[i + 2])); top = Math.max(top, r.pts[i + 1]); } r.rad = m; r.topH = r.y + top - heightAt(r.x, r.z); }
// line choice keys on the rocks worth avoiding; low crawl-over rocks (under 0.33 m) are driven over
const near = rocks.filter((r) => !r.ledge && r.topH > 0.33);
function pickLine(s, spec) { // lateral offset with the most clearance from boulders over the next 8 m
  const st = MAP.stageAt(s), hw = st.width / 2; let bestO = 0, bestC = -1e9;
  for (let o = -hw + 0.6; o <= hw - 0.6; o += 0.25) {
    let c = 1e9;
    for (let q = s; q < s + 8; q += 1) {
      const p = pathPoint(t, q), x = p.x - p.tz * o, z = p.z + p.tx * o;
      for (const r of near) {
        if (Math.abs(r.x - x) > 4 || Math.abs(r.z - z) > 4) continue;
        // tall rocks: keep the whole truck clear; knee-high ones (notch flanks, crawl-overs) the
        // tyres can ride, so only keep the diffs (the middle 0.6 m) off them
        const d = r.topH > 0.62 ? Math.hypot(r.x - x, r.z - z) - r.rad - spec.track / 2 - 0.15 : Math.hypot(r.x - x, r.z - z) - r.rad * 0.75 - 0.3;
        if (d < c) c = d;
      }
    }
    c = Math.min(c, 2.5) - Math.abs(o) * 0.05; if (c > bestC) { bestC = c; bestO = o; }
  }
  return bestO;
}
const terrain = buildTerrainPhysics(RAPIER, world, rocks, generateTrees());
const fmt = (x) => (x == null ? '   -  ' : `${x.toFixed(0).padStart(4)}s `);
const summary = [];
for (const id of ids) {
  const spec = ALL_VEHICLES.find((v) => v.id === id);
  const st0 = STAGES[from - 1];
  const sStart = from === 1 ? -14 : st0.s0 - 1;
  const p0 = sStart < 0 ? { x: MAP.SPAWN.x, z: MAP.SPAWN.z, tx: 1, tz: 0 } : pathPoint(t, sStart);
  const car = new Vehicle(RAPIER, world, spec, terrain, { x: p0.x, y: heightAt(p0.x, p0.z) + spec.tire.radius - spec.axleY + 0.3, z: p0.z }, Math.atan2(-p0.tx, -p0.tz));
  car.airedDown = true; const d = car.dt; d.range = spec.ranges.low ? 'low' : 'high'; d.fourWD = true; d.gear = 1;
  d.lockF = !!spec.lockers.front; d.lockR = !!spec.lockers.rear;
  const inp = { throttle: 0, brake: 0, steer: 0 };
  let s = Math.max(0, sStart), best = s, lastGain = 0, flips = 0, el = 0, stage = from - 1;
  const entered = []; // time each stage gate was crossed
  if (from > 1) entered[from - 1] = 0;
  const finishS = to >= STAGES.length ? STAGES.at(-1).gateS : STAGES[to].gateS;
  for (let i = 0; el < 1500; i++) {
    el = i * H;
    if (i % 20 === 0) {
      const p = car.chassis.translation();
      let bs = s, bd = 1e9;
      for (let q = Math.max(0, s - 10); q < Math.min(t.length, s + 20); q += 0.5) { const pp = pathPoint(t, q); const dd = Math.hypot(pp.x - p.x, pp.z - p.z); if (dd < bd) { bd = dd; bs = q; } }
      if (sStart < 0 && best < 5 && p.x < t.pts[0].x) bs = 0;
      s = bs;
      if (s > best + 0.5) { best = s; lastGain = el; }
      while (stage < STAGES.length && best >= STAGES[stage].gateS) { entered[stage] = el; stage++; }
      if (best >= finishS) break;
      if (el - lastGain > stuckSecs) break;
      if (i % 100 === 0) car._line = pickLine(s + 2, spec);
      const lk = pathPoint(t, Math.min(t.length, Math.max(s, 0) + 4 + spec.wheelbase)), o = car._line || 0;
      const look = sStart < 0 && best < 5 && p.x < t.pts[0].x - 2 ? { x: t.pts[0].x, z: t.pts[0].z } : { x: lk.x - lk.tz * o, z: lk.z + lk.tx * o };
      const { heading } = car.attitude(), want = Math.atan2(-(look.x - p.x), -(look.z - p.z));
      let err = want - heading; err = Math.atan2(Math.sin(err), Math.cos(err));
      inp.steer = Math.max(-1, Math.min(1, err * 2.2));
      const v = car.speed(), hi = PACE[MAP.stageAt(s).name] || 1.6, lo = hi * 0.4;
      // a driver holds more throttle the steeper it gets, so the engine doesn't bog and roll back
      const floor = Math.min(0.7, 0.05 + Math.max(0, Math.sin(car.attitude().pitch)) * 0.7);
      inp.throttle = v < 0 ? Math.min(1, inp.throttle + 0.05) : v < lo * 0.5 ? Math.min(1.0, inp.throttle + 0.02) : v < lo ? Math.min(0.75, inp.throttle + 0.02) : v > hi ? Math.max(floor, inp.throttle - 0.03) : inp.throttle;
      // a crawler, not a rally driver: well over pace it lifts and brakes instead of bouncing up
      if (v > hi * 1.5) { inp.throttle = Math.min(inp.throttle, floor * 0.6); inp.brake = 0.4; } else inp.brake = 0;
      if (process.env.TRACE && i % 200 === 0) { const a = car.attitude(), sa = MAP.stageAt(s); console.log(`  t=${el.toFixed(0)} st${sa.n} u=${(s - sa.s0).toFixed(1)} v=${v.toFixed(2)} thr=${inp.throttle.toFixed(2)} pitch=${(a.pitch * 57.3).toFixed(0)} roll=${(a.roll * 57.3).toFixed(0)} rpm=${d.rpm.toFixed(0)} ${car.wheelState.map((w) => (w.grounded ? 'g' : '-') + w.mat + ' s' + (w.slip ?? 0).toFixed(1) + ' N' + ((w.load ?? 0) / 1000).toFixed(1)).join(' ')} T=${(d.wheelTorque||[]).map((x) => x.toFixed(0)).join(',')}`); }
      if (car.upsideDown()) { flips++; const pp = pathPoint(t, s); car.reset({ x: pp.x, y: heightAt(pp.x, pp.z) + 2, z: pp.z }, Math.atan2(-pp.tx, -pp.tz)); }
    }
    car.step(inp, H);
  }
  if (process.env.TRACE) { // what the chassis and axles are touching at the end
    const p = car.chassis.translation(), pp = pathPoint(t, s);
    console.log(`  end: lat ${((p.x - pp.x) * -pp.tz + (p.z - pp.z) * pp.tx).toFixed(2)} line ${(car._line || 0).toFixed(2)}`);
    for (const [nm, b] of [['chassis', car.chassis], ['frontAxle', car.axles[0]?.body], ['rearAxle', car.axles[1]?.body]].filter((q) => q[1])) {
      for (let k = 0; k < b.numColliders(); k++) {
        const col = b.collider(k);
        world.contactPairsWith(col, (o) => world.contactPair(col, o, (m) => {
          let n = 0; for (let q = 0; q < m.numContacts(); q++) if (m.contactDist(q) < 0.02) n++;
          if (!n) return;
          const r = terrain.rockHandles.has(o.handle) ? rocks.find((rr) => { const tp = o.parent()?.translation(); return tp && Math.abs(rr.x - tp.x) < 1e-3 && Math.abs(rr.z - tp.z) < 1e-3; }) : null;
          console.log(`  contact: ${nm}#${k} with ${r ? `rock r=${r.rad.toFixed(2)}${r.ledge ? ' ledge' : ''}` : o.handle === terrain.ground.handle ? 'ground' : 'other'} (${n} pts)`);
        }));
      }
    }
  }
  const reached = stage; // stages whose gate was crossed
  const done = best >= finishS;
  const times = STAGES.map((st, k) => (entered[k] != null && (entered[k + 1] != null || (k === STAGES.length - 1)) ? (entered[k + 1] ?? entered[k]) - entered[k] : null));
  const lastSt = MAP.stageAt(best);
  const where = done ? (to >= STAGES.length ? 'FINISHED' : `through stage ${to}`) : `stuck in stage ${lastSt.n} ${lastSt.name} at u=${(best - lastSt.s0).toFixed(1)} m`;
  console.log(`${id.padEnd(5)} ${where}  (${el.toFixed(0)} s${flips ? `, ${flips} flip resets` : ''})`);
  console.log('      per stage: ' + STAGES.slice(from - 1, Math.max(reached, from)).map((st) => `${st.n}:${times[st.n - 1] == null ? 'stuck' : times[st.n - 1].toFixed(0) + 's'}`).join(' '));
  summary.push({ id, reached: done && to >= STAGES.length ? STAGES.length : lastSt.n, done, flips });
  car.destroy();
}
console.log('furthest stage: ' + summary.map((r) => `${r.id} ${r.done && to >= STAGES.length ? 'finished' : r.reached + '/' + STAGES.length}`).join(', '));
