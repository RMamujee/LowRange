// Winch physics and rules (src/winch/), headless on the Trail Park (and The Gauntlet for A):
//  A. (The Gauntlet, in a child process) a Pickup stuck at the Waterfall's first tier, which it can't
//     climb, gets up the whole Waterfall with its winch: hooked to the anchor the game offers, re-hooked
//     each time the line is in, the driver helping in first, 4-Low
//  B. a Cruiser bogged in Bog Run (2WD, open diffs, dug in) winches out to the far-bank recovery post
//     in neutral
//  C. the tension never exceeds the rated pull: winching in against the engine reversing in 4-Low stalls
//     the drum (STALLED) at the cap; a truck held on a slope by a taut, braked line for 30 s moves under
//     MAX_CREEP; releasing that taut line adds no energy (no launch toward the anchor)
//  D. a slack line applies zero force: a hooked truck with slack drives exactly like one without a
//     winch, and a stowed winch is bit-identical to none
//  E. a pull at an angle yaws the truck toward the anchor without flipping it
//  F. unhook / teleport / repair clean up (no row, line stowed, motor quiet); assisted-run marking
// Every scenario checks the peak line load (tension / rated pull) stays at or under 1.
//   node test/winch.mjs
const LEDGE = process.argv[2] === '--ledge';
process.env.MAP = LEDGE ? 'crawl' : 'park';
const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
const { generateRocks, generateTrees, buildTerrainPhysics, heightAt, TRAILS, ROADS, pathPoint, materialAt, MAT } = await import('../src/terrain.js');
const { ALL_VEHICLES } = await import('../src/specs.js');
const { Vehicle } = await import('../src/vehicle.js');
const { Winch, WINCH_AUDIO, surfaceProbe } = await import('../src/winch/winch.js');
const { buildAnchors, AnchorFinder } = await import('../src/winch/anchors.js');
const { buildRecoveryPoints } = await import('../src/winch/recovery_points.js');
const { WinchController } = await import('../src/winch/controller.js');
await RAPIER.init();
const H = 1 / 200, G = 9.81, MAX_CREEP = 0.005;
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const spec = (id) => structuredClone(ALL_VEHICLES.find((v) => v.id === id));
const rocks = generateRocks(), trees = generateTrees(rocks);
const RPS = buildRecoveryPoints({ rocks, trees });
const ANCHORS = buildAnchors({ rocks, trees, posts: RPS.posts, heightAt });
function newWorld() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
  const terrain = buildTerrainPhysics(RAPIER, world, rocks, trees);
  return { world, terrain, probe: surfaceProbe(RAPIER, world), finder: null };
}
const finderFor = (W) => (W.finder ||= new AnchorFinder(ANCHORS, { R: RAPIER, world: W.world, probe: W.probe, terrain: W.terrain }));
const yawAlong = (p, dir = 1) => Math.atan2(-p.tx * dir, -p.tz * dir);
const placeAt = (W, id, x, z, yaw, lift = 0.15) => { const sp = spec(id); return new Vehicle(RAPIER, W.world, sp, W.terrain, { x, y: heightAt(x, z) + sp.tire.radius - sp.axleY + lift, z }, yaw); };
const placeOn = (W, id, path, s, dir = 1) => { const p = pathPoint(path, s); return placeAt(W, id, p.x, p.z, yawAlong(p, dir)); };
const settle = (car, n = 300) => { for (let i = 0; i < n; i++) car.step({ throttle: 0, brake: 1, steer: 0, handbrake: true }, H); };
const fwdOf = (car) => { const a = car.attitude().heading; return { x: -Math.sin(a), z: -Math.cos(a) }; };
// arc length of the nearest path point to (x, z), searched around a hint
function along(path, x, z, hint) {
  let bs = hint, bd = Infinity;
  for (let q = Math.max(0, hint - 12); q <= Math.min(path.length, hint + 20); q += 0.25) { const p = pathPoint(path, q), d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; bs = q; } }
  return bs;
}
// steer towards a point 6 m on along the path
function steerOn(car, path, s) {
  const p = car.chassis.translation(), lk = pathPoint(path, Math.min(path.length, s + 6));
  let e = Math.atan2(-(lk.x - p.x), -(lk.z - p.z)) - car.attitude().heading; e = Math.atan2(Math.sin(e), Math.cos(e));
  return Math.max(-1, Math.min(1, e * 2));
}
const noseS = (car, path, hint) => { const p = car.chassis.translation(), f = fwdOf(car), k = car.spec.wheelbase / 2 + 0.3; return along(path, p.x + f.x * k, p.z + f.z * k, hint); };
const manualPost = (x, z) => ({ kind: 'post', x, z, ground: heightAt(x, z), r: 0.08, h: 0.75 });
const hookTo = (W, car, a) => { const w = car.winch, F = w.fairlead(); const A = finderFor(W).attach(a, F); return w.hook(A); };

// ---- A. ledge (child process on The Gauntlet): the Pickup stuck at the Waterfall's first tier
// (it can't climb it, see the "without the winch" check) winches up the whole Waterfall, re-hooking to
// the best anchor on offer each time the line is in, the driver helping in first, 4-Low
if (LEDGE) {
  const T = TRAILS[0], st = T.stages.find((q) => q.name === 'The Waterfall');
  const sEnd = st.s0 + st.steps.at.at(-1) + st.steps.depth + 1.5; // the body past the top tier
  const W = newWorld(), car = placeOn(W, 'taco', T, st.s0 + 2);
  settle(car);
  const d = car.dt; d.range = 'low'; d.gear = 1; d.lockR = true; car.airedDown = true;
  let s = st.s0 + 2, cs = s, best = s, thr = 0;
  const drive = (secs, thrMax, stop) => {
    for (let i = 0; i < secs / H; i++) {
      if (i % 20 === 0) {
        s = noseS(car, T, s); const c = car.chassis.translation(); cs = along(T, c.x, c.z, s - 2); best = Math.max(best, cs);
        const v = car.speed(); thr = v < 0.4 ? Math.min(thrMax, thr + 0.02) : v > 1.0 ? Math.max(0.05, thr - 0.05) : thr;
        if (stop && stop()) return;
      }
      car.step({ throttle: Math.min(thr, thrMax), brake: 0, steer: steerOn(car, T, s), handbrake: false }, H);
    }
  };
  drive(40, 0.8);
  check(best < sEnd - 10, `without the winch the Pickup stalls at the Waterfall: body reached u=${(best - st.s0).toFixed(1)} m of ${(sEnd - st.s0).toFixed(1)}`);
  car.winch = new Winch(car, W.probe);
  let maxLoad = 0, pulls = 0, maxPitch = 0;
  const log = [];
  for (; pulls < 6 && cs < sEnd; pulls++) {
    const cands = finderFor(W).candidates(car, car.winch.ws, car.winch.fairlead());
    if (!cands.length) { log.push('no anchor on offer'); break; }
    const c = cands[0];
    car.winch.hook(c.A); car.winch.cmd = 1; thr = 0;
    const u0 = cs;
    let stallT = 0;
    drive(60, 0.3, () => {
      maxLoad = Math.max(maxLoad, car.winch.load); maxPitch = Math.max(maxPitch, Math.abs(car.attitude().pitch) * 57.3);
      stallT = car.winch.state === 'STALLED' ? stallT + 0.1 : 0;
      return cs >= sEnd || car.winch.L <= 1.5 || stallT > 8;
    });
    log.push(`${c.a.kind}${c.a.id ? ' ' + c.a.id : ''} at ${c.d.toFixed(1)} m${c.geo.P ? ' over a crest' : ''}: u ${(u0 - st.s0).toFixed(1)} -> ${(cs - st.s0).toFixed(1)}${stallT > 8 ? ' (stalled)' : ''}`);
    car.winch.unhook();
  }
  console.log(`     pulls: ${log.join('; ')}`);
  check(cs >= sEnd, `with the winch the Pickup is up the Waterfall (body at u=${(cs - st.s0).toFixed(1)} m after ${pulls} hook-up${pulls === 1 ? '' : 's'})`);
  check(maxLoad <= 1.0005, `line load never over the rated pull (peak ${(maxLoad * 100).toFixed(1)}%)`);
  check(!car.upsideDown() && maxPitch < 50, `still upright (max pitch ${maxPitch.toFixed(0)} deg, now pitch ${(car.attitude().pitch * 57.3).toFixed(0)} roll ${(car.attitude().roll * 57.3).toFixed(0)} deg)`);
  process.exit(fails ? 1 : 0);
}
{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--ledge'], { encoding: 'utf8', env: { ...process.env, MAP: 'crawl' } });
  process.stdout.write(r.stdout || ''); if (r.stderr) process.stdout.write(r.stderr);
  const n = (r.stdout.match(/^FAIL/gm) || []).length;
  if (r.status !== 0 && !n) check(false, `the Waterfall run crashed (exit ${r.status})`);
  fails += n;
}

// ---- B. bogged in Bog Run, winched out to the far bank
{
  const T = TRAILS.find((t) => t.name === 'Bog Run');
  // the truck is placed on the centreline: on a wide bog that is the deep middle line ('hard'),
  // so its far-bank crux is the one for that line (a narrow bog has one crux, line null)
  const onCentre = (c) => !c.line || Math.abs(c.lat ?? 0) < 0.5;
  const cx = RPS.cruxes.find((c) => c.pathName === T.name && c.kind === 'bog' && c.sig > 0 && c.far && onCentre(c));
  check(!!cx && !!cx.post, `Bog Run has a far-bank recovery post (${cx?.post} for the bank at s=${cx?.sTop.toFixed(1)})`);
  if (cx) {
    const W = newWorld(), s0 = cx.sTop - 12, car = placeOn(W, 'lc70', T, s0);
    settle(car, 300);
    const d = car.dt; d.range = 'high'; d.gear = 1; d.fourWD = false; d.lockF = d.lockR = false;
    let s = s0, best = s0;
    for (let i = 0; i < 10 / H; i++) {
      if (i % 20 === 0) { s = noseS(car, T, s); best = Math.max(best, s); }
      car.step({ throttle: 1, brake: 0, steer: steerOn(car, T, s), handbrake: false }, H);
    }
    const sinkAvg = car.wheelState.reduce((a, w) => a + w.sink, 0) / 4;
    const p0 = car.chassis.translation();
    const s1 = along(T, p0.x, p0.z, s0);
    check(s1 - s0 < 6, `2WD, open diffs, full throttle: dug in (moved ${(s1 - s0).toFixed(1)} m in 10 s, sinkage ${sinkAvg.toFixed(2)} m)`);
    car.winch = new Winch(car, W.probe);
    const cands = finderFor(W).candidates(car, car.winch.ws, car.winch.fairlead());
    const post = cands.find((c) => c.a.kind === 'post' && c.a.id === cx.post) ?? cands.find((c) => c.a.kind === 'post');
    check(!!post, `the far-bank post is on offer: ${cands.map((c) => `${c.a.kind}${c.a.id ? ' ' + c.a.id : ''} ${c.d.toFixed(1)} m`).join(', ') || 'none'}`);
    if (post) {
      car.winch.hook(post.A); car.winch.cmd = 1; d.gear = 0;
      let maxLoad = 0, t = 0, out = false;
      for (let i = 0; i < 90 / H; i++) {
        car.step({ throttle: 0, brake: 0, steer: steerOn(car, T, s), handbrake: false }, H);
        maxLoad = Math.max(maxLoad, car.winch.load);
        // out: the body past the bank, or (a wide bog's post stands off to the side of the bank) all
        // four tyres on firm ground out of the mud
        const firm = () => car.wheels.every((w) => { const q = w.translation(); return materialAt(q.x, q.z) !== MAT.MUD; });
        if (i % 20 === 0) { s = noseS(car, T, s); const p = car.chassis.translation(); if (along(T, p.x, p.z, s - 2) > cx.sTop + 0.5 || firm()) { out = true; t = (i + 1) * H; break; } }
        if (car.winch.L <= 1.3) { t = (i + 1) * H; out = firm(); break; }
      }
      const p = car.chassis.translation();
      const onMud = car.wheels.filter((w) => { const q = w.translation(); return materialAt(q.x, q.z) === MAT.MUD; }).length;
      console.log(`     winching in neutral: body at s=${along(T, p.x, p.z, s - 2).toFixed(1)} after ${t.toFixed(1)} s (bank at ${cx.sTop.toFixed(1)}, post ${cx.post}), ${onMud} tyre(s) still on mud, peak load ${(maxLoad * 100).toFixed(0)}%`);
      check(out, 'the Cruiser is winched out of the bog onto the far bank');
      check(maxLoad <= 1.0005, `line load never over the rated pull (peak ${(maxLoad * 100).toFixed(1)}%)`);
    }
  }
}

// ---- C. the cap, a stall, holding on a slope, releasing a taut line
{
  // C1: the truck's nose against a fixed wall it can't climb, the anchor beyond it: the line bends over
  // the wall's top and the drum stalls at the cap
  const W = newWorld(), x0 = 2, z0 = 6, car = placeAt(W, 'lc70', x0, z0, 0);
  settle(car);
  car.winch = new Winch(car, W.probe);
  const w = car.winch, F0 = w.fairlead(), wallZ = F0.z - 0.6, gy = heightAt(x0, wallZ);
  W.world.createCollider(RAPIER.ColliderDesc.cuboid(2.5, 0.75, 0.3).setTranslation(x0, gy + 0.55, wallZ - 0.3).setFriction(0.8));
  settle(car, 2); // (a collider is in the query structure after a step)
  const geo = hookTo(W, car, manualPost(x0, z0 - 16));
  check(!!geo.P && geo.clear, `the line bends over the wall's top (pivot ${geo.P ? (geo.P.y - gy).toFixed(2) + ' m up' : 'none'})`);
  w.cmd = 1;
  let maxLoad = 0, stalled = false;
  for (let i = 0; i < 8 / H; i++) {
    car.step({ throttle: 0, brake: 0, steer: 0, handbrake: false }, H);
    maxLoad = Math.max(maxLoad, w.load);
    if (w.state === 'STALLED') stalled = true;
  }
  console.log(`     nose on the wall: peak tension ${(w.peakT / 1000).toFixed(1)} kN (rated ${(w.ws.pull / 1000).toFixed(1)} kN first layer, ${(w.cap() / 1000).toFixed(1)} kN on this layer), state ${w.state}`);
  check(maxLoad <= 1.0005, `tension capped at the rated pull (peak load ${(maxLoad * 100).toFixed(2)}%)`);
  check(w.peakT <= w.ws.pull * 1.0005, 'never above the first-layer rating');
  check(stalled, 'the drum stalls at the cap (STALLED), it does not snap');
}
let slopeCase = null;
{
  // C2: held on a slope by the braked line: find a stretch of Ridge Road at 9-13% grade
  const R0 = ROADS[0];
  let sBest = null;
  for (let s = 30; s < R0.length - 30 && sBest === null; s += 1) {
    const a = pathPoint(R0, s), b = pathPoint(R0, s + 10), g = (heightAt(b.x, b.z) - heightAt(a.x, a.z)) / 10;
    const c = pathPoint(R0, s + 20), g2 = (heightAt(c.x, c.z) - heightAt(b.x, b.z)) / 10;
    if (g > 0.09 && g2 > 0.07) sBest = s;
  }
  check(sBest !== null, `a slope on Ridge Road to park on (s=${sBest})`);
  if (sBest !== null) {
    const W = newWorld(), car = placeOn(W, 'lc70', R0, sBest);
    settle(car);
    car.winch = new Winch(car, W.probe);
    const up = pathPoint(R0, sBest + 18);
    hookTo(W, car, manualPost(up.x, up.z));
    const w = car.winch;
    // neutral, no brakes: it rolls back onto the line, which holds it
    for (let i = 0; i < 8 / H; i++) car.step({ throttle: 0, brake: 0, steer: 0, handbrake: false }, H);
    const p0 = car.chassis.translation(), T0 = w.T;
    let maxLoad = 0;
    for (let i = 0; i < 30 / H; i++) { car.step({ throttle: 0, brake: 0, steer: 0, handbrake: false }, H); maxLoad = Math.max(maxLoad, w.load); }
    const p1 = car.chassis.translation(), moved = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    const a = pathPoint(R0, sBest), b = pathPoint(R0, sBest + 10), grade = (heightAt(b.x, b.z) - heightAt(a.x, a.z)) / 10;
    console.log(`     held on a ${(grade * 100).toFixed(0)}% slope, neutral, no brakes: line tension ${(T0 / 1000).toFixed(1)} kN (m g sin = ${(car.mass * G * Math.sin(Math.atan(grade)) / 1000).toFixed(1)} kN), moved ${(moved * 1000).toFixed(2)} mm in 30 s`);
    check(T0 > 0.3 * car.mass * G * Math.sin(Math.atan(grade)), 'the line carries the truck');
    check(moved < MAX_CREEP, `parked on the taut, braked line for 30 s: under ${MAX_CREEP * 1000} mm`);
    check(maxLoad <= 1.0005, `line load capped (peak ${(maxLoad * 100).toFixed(1)}%)`);
    slopeCase = { W, car };
  }
}
if (slopeCase) {
  // C3: release the taut line: the truck rolls back by gravity alone, no kick towards the anchor
  const { car } = slopeCase, w = car.winch;
  const E = () => { const v = car.chassis.linvel(), p = car.chassis.translation(); return 0.5 * car.mass * (v.x * v.x + v.y * v.y + v.z * v.z) + car.mass * G * p.y; };
  const n0 = w.row?.n ?? (() => { const F = w.fairlead(), A = w.anchor, L = Math.hypot(A.x - F.x, A.y - F.y, A.z - F.z); return { x: (A.x - F.x) / L, y: (A.y - F.y) / L, z: (A.z - F.z) / L }; })();
  const e0 = E();
  w.unhook();
  let maxToward = -Infinity, eMax = -Infinity;
  for (let i = 0; i < 1.5 / H; i++) {
    car.step({ throttle: 0, brake: 0, steer: 0, handbrake: false }, H);
    const v = car.chassis.linvel();
    maxToward = Math.max(maxToward, v.x * n0.x + v.y * n0.y + v.z * n0.z);
    eMax = Math.max(eMax, E() - e0);
  }
  console.log(`     released: fastest motion towards the anchor ${(maxToward * 100).toFixed(2)} cm/s, energy gain at most ${eMax.toFixed(0)} J`);
  check(maxToward < 0.03, 'no launch towards the anchor when a taut line is released');
  check(eMax < 60, 'no energy gained (rolls back by gravity only)');
}

// ---- D. slack line: zero force (and a stowed winch changes nothing)
{
  const runs = [];
  for (const mode of ['none', 'stowed', 'slack']) {
    const W = newWorld(), x0 = 2, z0 = 6, car = placeAt(W, 'lc70', x0, z0, 0);
    settle(car, 200);
    if (mode !== 'none') car.winch = new Winch(car, W.probe);
    if (mode === 'slack') { hookTo(W, car, manualPost(x0, z0 - 20)); car.winch.L += 1.2; }
    const d = car.dt; d.range = 'low'; d.gear = 1;
    let maxT = 0;
    const trace = [];
    for (let i = 0; i < 5 / H; i++) {
      car.step({ throttle: 0.25, brake: 0, steer: 0.1, handbrake: false }, H);
      if (car.winch) maxT = Math.max(maxT, car.winch.T);
      if (i % 50 === 0) { const p = car.chassis.translation(); trace.push(p.x, p.y, p.z); }
    }
    runs.push({ mode, trace, maxT, slack: car.winch?.hooked ? car.winch.L - Math.hypot(car.winch.anchor.x - car.winch.fairlead().x, car.winch.anchor.z - car.winch.fairlead().z) : null });
  }
  const same = (a, b) => a.trace.length === b.trace.length && a.trace.every((v, i) => v === b.trace[i]);
  check(same(runs[0], runs[1]), 'a stowed winch is bit-identical to no winch');
  check(runs[2].maxT === 0, `a slack line pulls with zero force (max tension ${runs[2].maxT} N, slack ${runs[2].slack?.toFixed(2)} m at the end)`);
  check(same(runs[0], runs[2]), 'driving on a slack line is bit-identical to driving without a winch');
}

// ---- E. a pull at an angle yaws the truck toward the anchor, without flipping it
{
  const W = newWorld(), x0 = 2, z0 = 8, car = placeAt(W, 'taco', x0, z0, 0);
  settle(car);
  car.winch = new Winch(car, W.probe);
  const ang = (50 * Math.PI) / 180, R = 16, ax = x0 + Math.sin(ang) * R, az = z0 - Math.cos(ang) * R; // ahead and 50 deg to the right
  hookTo(W, car, manualPost(ax, az));
  const bearing = () => { const p = car.chassis.translation(), f = fwdOf(car), dx = ax - p.x, dz = az - p.z; return Math.atan2(f.x * dz - f.z * dx, f.x * dx + f.z * dz) * 57.3; };
  const b0 = bearing(), h0 = car.attitude().heading;
  car.winch.cmd = 1;
  let maxRoll = 0, maxLoad = 0;
  for (let i = 0; i < 14 / H; i++) {
    car.step({ throttle: 0, brake: 0, steer: 0, handbrake: false }, H);
    maxRoll = Math.max(maxRoll, Math.abs(car.attitude().roll) * 57.3); maxLoad = Math.max(maxLoad, car.winch.load);
    if (car.winch.L <= 3) break;
  }
  const b1 = bearing(), dh = Math.atan2(Math.sin(car.attitude().heading - h0), Math.cos(car.attitude().heading - h0)) * 57.3;
  console.log(`     anchor ${b0.toFixed(0)} deg off the nose at the start (right is +); the truck turned ${(-dh).toFixed(0)} deg right (anchor now ${b1.toFixed(0)} deg off); max roll ${maxRoll.toFixed(1)} deg, peak load ${(maxLoad * 100).toFixed(0)}%`);
  check(-dh > 10, 'the pull yawed the truck toward the anchor (turned right, towards it)');
  check(maxRoll < 20 && !car.upsideDown(), 'without flipping it (roll under 20 deg)');
  check(maxLoad <= 1.0005, 'line load capped');
}

// ---- F. unhook / teleport / repair clean up; assisted runs
{
  const W = newWorld(), msgs = [];
  const ctl = new WinchController({ R: RAPIER, world: W.world, terrain: W.terrain, anchors: ANCHORS, toast: (m) => msgs.push(m) });
  const x0 = 2, z0 = 6;
  let car = placeAt(W, 'lc70', x0, z0, 0);
  settle(car, 200);
  ctl.attach(car);
  check(car.winch === ctl.winch && !!car.winch, 'the controller fits the truck with its winch');
  hookTo(W, car, manualPost(x0, z0 - 15));
  car.winch.cmd = 1;
  for (let i = 0; i < 600; i++) car.step({ throttle: 0, brake: 0, steer: 0, handbrake: false }, H);
  const game = { active: { trail: 0, t: 12 } };
  ctl.assist(game, null, null);
  check(game.active.assisted === true, 'a run during which the line pulled is marked assisted');
  check(WINCH_AUDIO.running && WINCH_AUDIO.direction === 'in' && WINCH_AUDIO.load >= 0 && WINCH_AUDIO.load <= 1, `the audio state reads the running motor (running, winching in, load ${WINCH_AUDIO.load.toFixed(2)})`);
  const cw = car.winch; // where src/audio.js reads it: car.winch.running / .load / .direction
  check(cw.running === true && cw.direction === 'in' && cw.load >= 0 && cw.load <= 1 && typeof cw.state !== 'object', 'car.winch carries running, load (0-1) and direction (in / out) for the audio');
  ctl.action('winchOff');
  car.step({ throttle: 0, brake: 0, steer: 0, handbrake: false }, H);
  check(!car.winch.hooked && car.winch.row === null && car.winch.T === 0 && !WINCH_AUDIO.running && !car.winch.running && car.winch.direction === null, 'unhook (L / OFF): line stowed, no row, motor quiet');
  // teleport / repair: main.js swaps in a new Vehicle (respawnFresh); the controller sees the new truck
  hookTo(W, car, manualPost(x0, z0 - 15)); car.winch.cmd = 1;
  for (let i = 0; i < 100; i++) car.step({ throttle: 0, brake: 0, steer: 0, handbrake: false }, H);
  const old = car;
  old.destroy();
  car = placeAt(W, 'lc70', x0 + 1, z0, 0);
  ctl.attach(car);
  check(old.winch === null && !!car.winch && !car.winch.hooked && !WINCH_AUDIO.running, 'teleport / restart / repair: the new truck starts with the line stowed, the old one is let go');
  check(msgs.some((m) => /stowed/.test(m)), 'and the driver is told');
  hookTo(W, car, manualPost(x0 + 1, z0 - 15));
  car.reset({ x: x0 + 1, y: heightAt(x0 + 1, z0) + 1, z: z0 }, 0); // rebuilt in place (Vehicle.reset / repair)
  ctl.attach(car);
  check(!car.winch.hooked, 'a truck rebuilt in place (Vehicle.reset / repair) has its line stowed too');
  const wrx = placeAt(W, 'wrx', x0 + 6, z0, 0);
  ctl.attach(wrx);
  check(wrx.winch && wrx.winch.ws.kind === 'compact' && wrx.winch.ws.line === 20, `the Rally Sedan carries the compact winch (${wrx.winch?.ws.line} m, ${(wrx.winch?.ws.pull / 1000).toFixed(1)} kN)`);
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall winch checks passed');
process.exit(fails ? 1 : 0);
