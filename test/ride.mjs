// Ride: how each rig's body moves after a disturbance, measured in a headless world, checked
// against real-vehicle reference bands (docs/HANDOFF.md, "Ride and damping").
//  1. Spec numbers: ride frequency front / rear, damping ratios, tyre and wheel rates, wheel hop.
//  2. Release tests: push the body down / lift it (whole body, front end, rear end, pitch, roll)
//     with a steady force for 2 s, let go, and measure the free response: ride frequency
//     front / rear, damping ratio in bump and rebound (from the decay of each half swing),
//     overshoot, second overshoot, half-cycles until within 5 mm, settle time.
//  3. Drops of 0.3 / 0.5 / 1.0 m onto flat ground: total energy (motion, height, springs and
//     stops) must never rise (no solver energy gain), rebound after the bottom-out, settle.
//  4. Tyres landing on rock and on a bouncy prop (restitution 0.2): the wheel's rebound speed.
//  5. Articulation: a block rising under the front-left tyre, parked: how high it lifts before
//     a wheel unloads (crawling flex must not shrink).
//  6. Driving cases, logged: a 0.3 m ledge drop at crawl, 0.5 m at 20 km/h, a 0.15 m bump at 30
//     and 60 km/h, whoops at 50 km/h, a hard stop from 60 km/h, a lane change at 60 km/h and
//     creeping over a boulder.
// usage: node test/ride.mjs [rigs=lc70,taco,wrx] [sections=spec,release,drop,tyre,flex,drive]
//        RIDE_BASE=<dir holding an older src/> also runs that code and prints before / after.
//        RIDE_NOASSERT=1 prints only. RIDE_CASES=whoops,lane,... picks driving cases.
//        RIDE_TRACE=<mode><dir> (e.g. heave-1) prints one release response.
import RAPIER from '@dimforge/rapier3d-compat';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { rideEnergy } from '../src/ride.js';
await RAPIER.init();
const H = 1 / 200, G = 9.81;
const rigs = (process.argv[2] || 'lc70,taco,wrx').split(',');
const sections = (process.argv[3] || 'spec,release,drop,tyre,flex,drive').split(',');
const has = (s) => sections.includes(s);

async function load(dir) {
  const u = (f) => pathToFileURL(path.resolve(dir, f)).href;
  const [{ ALL_VEHICLES }, { Vehicle }, { GROUP_WORLD }] = await Promise.all([import(u('specs.js')), import(u('vehicle.js')), import(u('terrain.js'))]);
  return { ALL_VEHICLES, Vehicle, GROUP_WORLD };
}
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const codes = { after: await load(path.join(here, '../src')) };
if (process.env.RIDE_BASE) codes.before = await load(path.join(process.env.RIDE_BASE, 'src'));

// ---------------------------------------------------------------- helpers
const qconj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const qmul = (a, b) => ({ x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z });
function qrot(q, p) {
  const { x, y, z, w } = q, ix = w * p.x + y * p.z - z * p.y, iy = w * p.y + z * p.x - x * p.z, iz = w * p.z + x * p.y - y * p.x, iw = -x * p.x - y * p.y - z * p.z;
  return { x: ix * w + iw * -x + iy * -z - iz * -y, y: iy * w + iw * -y + iz * -x - ix * -z, z: iz * w + iw * -z + ix * -y - iy * -x };
}
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

function mkWorld(code, spec, start, obst = [], groundRest = 0) {
  const world = new RAPIER.World({ x: 0, y: -G, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
  // flat heightfield ground, 5 m cells, like the maps' (a single 800 m cuboid loses contacts with
  // the sedan's small tyres now and then: Rapier precision on a huge box, not the ride)
  const N = 160, ground = world.createCollider(RAPIER.ColliderDesc.heightfield(N, N, new Float32Array((N + 1) * (N + 1)), { x: 800, y: 1, z: 800 })
    .setFriction(1).setRestitution(groundRest).setCollisionGroups(code.GROUP_WORLD));
  const rockHandles = new Set([ground.handle]);
  const cols = obst.map((o) => { const c = world.createCollider(o.setFriction(1).setCollisionGroups(code.GROUP_WORLD)); rockHandles.add(c.handle); return c; });
  const car = new code.Vehicle(RAPIER, world, spec, { ground, rockHandles }, start, 0);
  car.grace = 1e9; // damage off: this measures the ride
  return { world, car, cols };
}
const startPos = (spec, lift = 0, z = 0) => ({ x: 0, y: spec.tire.radius - spec.axleY + 0.05 + lift, z });
const idle = { throttle: 0, brake: 0, steer: 0 };

// half swings of a free response x(t) released at t = 0 (x[0] = release displacement)
function swings(xs) {
  const ext = [[0, xs[0]]];
  let i0 = 0;
  for (let i = 1; i < xs.length; i++) {
    const last = ext[ext.length - 1][1];
    if (Math.sign(xs[i]) !== Math.sign(last) && Math.sign(xs[i]) !== 0) { // crossed: find this lobe's extremum
      let j = i, best = i;
      while (j < xs.length && Math.sign(xs[j]) === Math.sign(xs[i])) { if (Math.abs(xs[j]) > Math.abs(xs[best])) best = j; j++; }
      ext.push([best * H, xs[best]]);
      i = j - 1; i0 = j;
      if (ext.length > 6) break;
    }
  }
  return ext;
}
function settle(xs, tol = 0.005) {
  let last = -1, n = 0, sign = 0;
  for (let i = 0; i < xs.length; i++) if (Math.abs(xs[i]) > tol) { last = i; const s = Math.sign(xs[i]); if (s !== sign) { n++; sign = s; } }
  return { t: (last + 1) * H, half: n };
}
const zetaOf = (a, b) => { const d = Math.log(Math.abs(a) / Math.max(1e-9, Math.abs(b))); return d / Math.sqrt(Math.PI ** 2 + d * d); };

// ---------------------------------------------------------------- energy (for the drop test)
function energy(car) {
  let E = 0;
  for (const b of car.allBodies) {
    const m = b.mass(), v = b.linvel(), c = b.worldCom ? b.worldCom() : b.translation();
    let w = b.angvel();
    const wi = car.wheels.indexOf(b);
    if (wi >= 0) { // a wheel's spin is the drivetrain's (it sets it each step): count only how it swings with its knuckle
      const ax = qrot(car.knuckles[wi].rotation(), { x: 1, y: 0, z: 0 }), sp = dot(sub(w, car.knuckles[wi].angvel()), ax);
      w = { x: w.x - ax.x * sp, y: w.y - ax.y * sp, z: w.z - ax.z * sp };
    }
    const I = b.principalInertia(), q = qmul(b.rotation(), b.principalInertiaLocalFrame()), wl = qrot(qconj(q), w);
    E += 0.5 * m * dot(v, v) + 0.5 * (I.x * wl.x ** 2 + I.y * wl.y ** 2 + I.z * wl.z ** 2) + m * G * c.y;
  }
  const cb = car.chassis, cq = cb.rotation(), inv = qconj(cq), cp = cb.translation(), spec = car.spec;
  const xOf = (body) => qrot(inv, sub(body.translation(), cp)).y - spec.axleY;
  car.axles.forEach((ax, a) => {
    const P = car.rideP && car.rideP[a];
    const springE = (x, share) => P ? rideEnergy(P, x) : 0.5 * (car.suspKC.k / share) * (x + car.sag) ** 2;
    if (ax.independent) {
      const xs = ax.carriers.map(xOf);
      E += springE(xs[0], 2) + springE(xs[1], 2);
      if (spec.susp.arb) E += 0.5 * spec.susp.arb * (xs[0] - xs[1]) ** 2;
    } else {
      E += springE(xOf(ax.slider), 1);
      const qr = qmul(qconj(cq), ax.body.rotation()), th = 2 * Math.atan2(qr.z, qr.w);
      const kr = P ? P.k * car.sp2[a] : car.suspKC.k * car.suspKC.sp2;
      E += 0.5 * kr * th * th;
    }
  });
  return E;
}

// ---------------------------------------------------------------- 1. spec numbers
function specRow(code, spec) {
  const { car, world } = mkWorld(code, spec, startPos(spec));
  const s = spec.susp, t = spec.tire, M = spec.chassis.mass, ind = spec.independent || [false, false];
  const out = {};
  for (const a of [0, 1]) {
    const P = car.rideP ? car.rideP[a] : null, share = ind[a] ? 2 : 1;
    const k = P ? P.k * share : car.suspKC.k, m = M / 2;
    const cB = P ? P.cB * share : car.suspKC.c, cR = P ? P.cR * share : car.suspKC.c;
    const kT = 2 * (t.rate || 250e3);
    const kS = P ? P.kS * share : k; // old code: the tyre was not part of the rate (rigid)
    // unsprung mass per wheel and wheel-hop frequency a real tyre would give (spring + tyre)
    const mu = ind[a] ? spec.axleMass * 0.35 + 25 + t.mass : (spec.axleMass * 1.15 + 2 * (25 + t.mass)) / 2;
    const kw = kS / 2, kt1 = kT / 2, fHop = Math.sqrt((kw + kt1) / mu) / (2 * Math.PI);
    const zHop = (cB / 2) / (2 * Math.sqrt((kw + kt1) * mu));
    out[a ? 'rear' : 'front'] = { f: Math.sqrt(k / m) / (2 * Math.PI), zB: cB / (2 * Math.sqrt(k * m)), zR: cR / (2 * Math.sqrt(k * m)), kTyre: kt1, kWheel: kw, mu, fHop, zHop, sag: (m * G) / k };
  }
  world.free();
  return out;
}

// ---------------------------------------------------------------- 2. release tests
// mode: heave | front | rear | pitch | roll; dir +1 = pushed down / nose down / right side down
function release(code, spec, mode, dir, scale = 1) {
  const { car, world } = mkWorld(code, spec, startPos(spec));
  // a ride rig: the tyres stand on free-floating pads (no grip at all), so the tyre grip solve, the
  // static hold and the drivetrain stay out of the measurement (the suspension is vertical: grip
  // plays no part in its heave, pitch or roll)
  car.treadMul = car.treadMul.map(() => [0, 0]);
  const braked = idle;
  for (let i = 0; i < 600; i++) car.step(braked, H);
  const M = spec.chassis.mass, wb = spec.wheelbase, tr = spec.track;
  const zF = -wb / 2, zR = wb / 2;
  const ptY = (z) => { const q = car.chassis.rotation(), p = car.chassis.translation(); return p.y + qrot(q, { x: 0, y: 0, z }).y; };
  const meas = () => {
    const a = car.attitude();
    if (mode === 'heave') return car.chassis.translation().y;
    if (mode === 'front') return ptY(zF);
    if (mode === 'rear') return ptY(zR);
    if (mode === 'pitch') return -a.pitch * wb / 2; // + = nose up... sign kept so that dir=+1 gives a negative start
    return -a.roll * tr / 2;
  };
  const eq = meas();
  const F = 0.3 * M * G * scale;
  for (let i = 0; i < 400; i++) {
    const q = car.chassis.rotation(), c = car.chassis.translation();
    const at = (z) => { const p = qrot(q, { x: 0, y: 0, z }); return { x: c.x + p.x, y: c.y + p.y, z: c.z + p.z }; };
    if (mode === 'heave') car.chassis.applyImpulse({ x: 0, y: -dir * F * H, z: 0 }, true);
    if (mode === 'front') car.chassis.applyImpulseAtPoint({ x: 0, y: -dir * F * 0.5 * H, z: 0 }, at(zF), true);
    if (mode === 'rear') car.chassis.applyImpulseAtPoint({ x: 0, y: -dir * F * 0.5 * H, z: 0 }, at(zR), true);
    if (mode === 'pitch') car.chassis.applyTorqueImpulse(qrot(q, { x: -dir * F * wb / 4 * H, y: 0, z: 0 }), true);
    if (mode === 'roll') car.chassis.applyTorqueImpulse(qrot(q, { x: 0, y: 0, z: dir * F * 0.8 * tr / 4 * H }), true);
    car.step(braked, H);
  }
  const xs = [];
  for (let i = 0; i < 800; i++) { car.step(braked, H); xs.push(meas() - eq); if (process.env.RIDE_TRACE === mode + dir && i % 8 === 0) console.log(i, (xs[i] * 1000).toFixed(1), car.compression().map((c) => (c * 1000).toFixed(0)).join(","), car.wheelState.map((w) => (w.contact ? 1 : 0)).join(""), car.chassis.linvel().z.toFixed(3)); }
  world.free();
  const sw = swings(xs), st = settle(xs);
  const x0 = sw[0][1], p1 = sw[1] ? sw[1][1] : 0, p2 = sw[2] ? sw[2][1] : 0;
  const z1 = sw[1] ? zetaOf(x0, p1) : 1;
  const T1 = sw[1] ? sw[1][0] : NaN;
  const fn = sw[1] ? (Math.PI / T1) / Math.sqrt(1 - Math.min(0.95, z1) ** 2) / (2 * Math.PI) : NaN;
  return { x0, os1: Math.abs(p1 / x0), os2: Math.abs(p2 / x0), z1, fn, settle: st.t, half: st.half };
}

// ---------------------------------------------------------------- 3. drops
function drop(code, spec, dh) {
  let eq;
  { const { car, world } = mkWorld(code, spec, startPos(spec)); for (let i = 0; i < 800; i++) car.step(idle, H); eq = car.chassis.translation().y; world.free(); }
  const { car, world } = mkWorld(code, spec, startPos(spec, dh));
  const ys = [], braked = { throttle: 0, brake: 1, steer: 0 };
  car.step(braked, H); // (masses are only known to Rapier after a step)
  let Emin = energy(car), gain = 0, landed = -1, bottom = 0, bi = 0;
  const E0 = Emin;
  for (let i = 0; i < 600; i++) {
    car.step(braked, H);
    const y = car.chassis.translation().y - eq;
    ys.push(y);
    const E = energy(car);
    if (E > Emin) gain = Math.max(gain, E - Emin); else Emin = E;
    if (landed < 0 && car.wheelState.some((w) => w.contact)) landed = i;
    if (landed >= 0 && y < bottom) { bottom = y; bi = i; }
  }
  world.free();
  const after = ys.slice(bi);
  const up = Math.max(...after);
  const st = settle(after);
  const mTot = car.mass;
  return { bottom, rebound: up, ratio: up / Math.abs(bottom), gainJ: gain, gainPct: (100 * gain) / (mTot * G * dh), settle: st.t, half: st.half, E0 };
}

// ---------------------------------------------------------------- 4. tyre landing on rock / prop
function tyreLanding(code, spec, rest) {
  // a rock slab (convex hull, restitution `rest`) under the whole truck, dropped from 0.5 m:
  // how far each tyre hops back up off it in the first 0.2 s after it touches (mm), and the
  // equivalent coefficient of restitution sqrt(hop / fall)
  const pts = []; for (const x of [-4, 4]) for (const z of [-5, 5]) for (const y of [-0.5, 0]) pts.push(x, y, z);
  const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(pts)).setTranslation(0, 0.2, 0).setRestitution(rest);
  const { car, world } = mkWorld(code, spec, startPos(spec, 0.5 + 0.2), [hull]);
  const first = [-1, -1, -1, -1], y0 = car.wheels.map((w) => w.translation().y), ys = [[], [], [], []];
  for (let i = 0; i < 400; i++) {
    car.step(idle, H);
    for (let k = 0; k < 4; k++) {
      const y = car.wheels[k].translation().y;
      if (first[k] < 0 && car.wheelState[k].contact) first[k] = i;
      if (first[k] >= 0 && i - first[k] <= 40) ys[k].push(y);
    }
  }
  // hop: how far above its final resting height the tyre rises after touching down (the
  // engine first pushes a tyre that sank in a few mm back out: that is not a bounce)
  const yr = car.wheels.map((w) => w.translation().y);
  world.free();
  const hop = ys.map((a, k) => Math.max(0, ...a.map((y) => y - yr[k])));
  const k = hop.indexOf(Math.max(...hop)), fall = Math.max(0.05, y0[k] - yr[k]);
  return { hop: hop[k], e: Math.sqrt(hop[k] / fall) };
}

// ---------------------------------------------------------------- 5. articulation
function flex(code, spec) {
  const { car, world } = mkWorld(code, spec, startPos(spec));
  const inp = { throttle: 0, brake: 1, steer: 0, handbrake: true };
  for (let i = 0; i < 400; i++) car.step(inp, H);
  const fl = car.wheels[0].translation();
  const kb = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(fl.x, -0.5, fl.z));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.35, 0.5, 0.35).setFriction(1).setCollisionGroups(code.GROUP_WORLD), kb);
  const Wst = (car.mass * G) / 4;
  // lift until FR or RL carries under 5% of its static load, averaged over 0.1 s, for 0.3 s
  let lift = 0, h = 0, low = 0, roll = 0;
  const acc = [0, 0, 0, 0];
  for (let i = 1; i < 25 / H; i++) {
    h = Math.min(0.9, i * H * 0.04);
    kb.setNextKinematicTranslation({ x: fl.x, y: -0.5 + h, z: fl.z });
    car.step(inp, H);
    car.wheelState.forEach((w, k) => { acc[k] += w.load || 0; });
    if (i % 20 === 0) {
      const L = acc.map((x) => x / 20); acc.fill(0);
      low = Math.min(L[1], L[2]) < 0.05 * Wst ? low + 1 : 0;
      if (low === 1) lift = h;
      if (low >= 3) break;
      roll = Math.abs(car.attitude().roll);
    }
  }
  if (low < 3) lift = h;
  world.free();
  return { lift, roll };
}

// ---------------------------------------------------------------- 6. driving cases
const box = (hx, hy, hz, x, y, z) => RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z);
const bumpC = (h, c, z) => { const R = ((c / 2) ** 2 + h * h) / (2 * h); return RAPIER.ColliderDesc.cylinder(4, R).setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }).setTranslation(0, h - R, z); };
function cruise(car, spec, inp, vt, range = 'high') {
  const d = car.dt; d.range = range; d.fourWD = true; d.autoClutch = true;
  if (d.gear < 1) d.gear = 1;
  const v = car.speed();
  inp.throttle = v < vt - 0.5 ? 1 : v < vt ? 0.35 : 0;
  inp.brake = v > vt + 1.5 ? 0.4 : 0;
  const rpm = d.rpm, e = spec.engine;
  if (rpm > e.redline * 0.85 && d.gear < spec.gears.length) d.gear++;
  else if (rpm < e.peakRpm * 0.45 && d.gear > 1) d.gear--;
}
const coast = (car, inp) => { inp.throttle = 0; inp.brake = 0; car.dt.gear = 0; };
function driveCases(code, spec) {
  const out = {};
  const wb = spec.wheelbase, tr = spec.track;
  let eq;
  { const { car, world } = mkWorld(code, spec, startPos(spec)); for (let i = 0; i < 800; i++) car.step(idle, H); eq = car.chassis.translation().y; world.free(); }
  const pitchM = (car) => car.attitude().pitch * wb / 2, rollM = (car) => car.attitude().roll * tr / 2;
  // about where the body ends up (the mean of the last 0.5 s): coasting to a stop pitches it a little
  const sum = (xs0) => { const n = Math.min(100, xs0.length), m = xs0.slice(-n).reduce((a, b) => a + b, 0) / n, xs = xs0.map((x) => x - m);
    const s = settle(xs), sw = swings(xs); return { t: s.t, half: s.half, pk: sw.slice(0, 4).map((e) => Math.round(e[1] * 1000)) }; };
  // follow a run: approach at vt (cruise until zCoast, then neutral), record from trigger
  const run = (obst, z0, vt, range, zCoast, trigger, secs = 4, lift = 0) => {
    const { car, world } = mkWorld(code, spec, startPos(spec, lift, z0), obst);
    const inp = { throttle: 0, brake: 0, steer: 0 };
    const hs = [], ps = [], rs = [];
    let t0 = -1, p0 = 0, air = 0;
    for (let i = 0; i < 60 / H; i++) {
      const z = car.chassis.translation().z;
      if (z > zCoast || vt < 2) { if (i % 10 === 0) { cruise(car, spec, inp, vt, range); if (vt < 2) { car.dt.gear = 1; inp.throttle = Math.min(0.6, inp.throttle); inp.brake = 0; } } } else coast(car, inp);
      if (t0 < 0 && z < zCoast + 2) p0 = pitchM(car);
      car.step(inp, H);
      if (t0 < 0 && trigger(car)) t0 = i;
      if (t0 >= 0) {
        hs.push(car.chassis.translation().y - eq); ps.push(pitchM(car) - p0); rs.push(rollM(car));
        if (car.wheelState.filter((w) => w.contact).length < 4) air++;
        if (i - t0 >= secs / H) break;
      }
    }
    const v = car.speed() * 3.6, up = car.upsideDown();
    world.free();
    return { heave: sum(hs), pitch: sum(ps), roll: sum(rs), air: air * H, v, up };
  };
  // ledge drops
  const want = (k) => !process.env.RIDE_CASES || process.env.RIDE_CASES.split(',').includes(k);
  if (want('ledge03')) out.ledge03 = run([box(5, 0.15, 7, 0, 0.15, 0)], 4, 1.0, spec.ranges.low ? 'low' : 'high', -99, (c) => c.wheels[3].translation().z < -7.3 && c.wheels[3].translation().y < spec.tire.radius + 0.05, 4, 0.3);
  if (want('ledge05')) out.ledge05 = run([box(5, 0.25, 30, 0, 0.25, 0)], 26, 20 / 3.6, 'high', -24, (c) => c.wheels[3].translation().z < -30.3 && c.wheels[3].translation().y < spec.tire.radius + 0.05, 4, 0.5);
  // single bump 0.15 m (0.9 m chord) at 30 and 60 km/h
  for (const kmh of [30, 60]) if (want('bump' + kmh)) out['bump' + kmh] = run([bumpC(0.15, 0.9, -60)], 60, kmh / 3.6, 'high', -50, (c) => c.wheels[3].translation().z < -60.6);
  // whoops: 10 x 0.12 m, 3 m apart, at 50 km/h
  if (want('whoops')) { const ob = []; for (let k = 0; k < 10; k++) ob.push(bumpC(0.12, 1.4, -40 - k * 3));
    out.whoops = run(ob, 60, 50 / 3.6, 'high', -32, (c) => c.chassis.translation().z < -38, 2.5); }
  // hard stop from 60 km/h: pitch after the truck stops
  if (want('brake')) {
    const { car, world } = mkWorld(code, spec, startPos(spec, 0, 100));
    const inp = { throttle: 0, brake: 0, steer: 0 };
    for (let i = 0; i < 25 / H && !(car.speed() > 60 / 3.6 - 0.3 && i > 3 / H); i++) { if (i % 10 === 0) cruise(car, spec, inp, 60 / 3.6); car.step(inp, H); }
    for (let k = 0; k < 200; k++) { if (k % 10 === 0) cruise(car, spec, inp, 60 / 3.6); car.step(inp, H); }
    inp.throttle = 0; inp.brake = 1; car.dt.gear = 0;
    let dive = 0, st = -1; const ps = [];
    for (let k = 0; k < 10 / H; k++) {
      car.step(inp, H); dive = Math.min(dive, car.attitude().pitch);
      if (st < 0 && Math.abs(car.speed()) < 0.05) st = k;
      if (st >= 0) { ps.push(pitchM(car)); if (k - st > 3 / H) break; }
    }
    out.brake = { dive: dive * 57.3, pitch: sum(ps) };
    world.free();
  }
  // lane change at 60 km/h (about 0.4 g): roll overshoot once the wheel is straight
  if (want('lane')) {
    const { car, world } = mkWorld(code, spec, startPos(spec, 0, 150));
    const inp = { throttle: 0, brake: 0, steer: 0 };
    for (let i = 0; i < 25 / H && !(car.speed() > 60 / 3.6 - 0.3 && i > 3 / H); i++) { if (i % 10 === 0) cruise(car, spec, inp, 60 / 3.6); car.step(inp, H); }
    for (let k = 0; k < 200; k++) { if (k % 10 === 0) cruise(car, spec, inp, 60 / 3.6); car.step(inp, H); }
    let maxRoll = 0, maxAy = 0; const rs = [];
    coast(car, inp);
    const st = 0.15;
    for (let k = 0; k < 6 / H; k++) {
      const t = k * H;
      inp.steer = t < 0.7 ? st : t < 1.6 ? -st : t < 2.0 ? st * 0.5 : 0;
      car.step(inp, H);
      maxRoll = Math.max(maxRoll, Math.abs(car.attitude().roll));
      const w = car.chassis.angvel().y; maxAy = Math.max(maxAy, Math.abs(w * car.speed()));
      if (t > 2.0) rs.push(rollM(car));
    }
    out.lane = { roll: maxRoll * 57.3, ay: maxAy / G, after: sum(rs) };
    world.free();
  }
  // creeping over a 0.35 m boulder under the left wheels at about 1 m/s
  if (want('boulder')) {
    const r = 0.35, pts = [];
    for (let k = 0; k < 40; k++) { const a = k * 2.4, yy = k / 39, rr = Math.sqrt(1 - yy * yy) * r * 1.3; pts.push(Math.cos(a) * rr, yy * r, Math.sin(a) * rr); }
    const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(pts)).setTranslation(-tr / 2, 0, -10);
    out.boulder = run([hull], 0, 1.0, spec.ranges.low ? 'low' : 'high', -99, (c) => c.wheels[3].translation().z < -10.6);
  }
  return out;
}

// ---------------------------------------------------------------- run + report
const BANDS = { // reference bands (see docs/HANDOFF.md); trucks vs the rally sedan
  truck: { f: [1.2, 1.6], zB: [0.22, 0.42], zR: [0.38, 0.65] }, // measured bump swings read a little above the spec's 0.34: the bump stop and pitch coupling add some
  rally: { f: [1.6, 2.2], zB: [0.25, 0.45], zR: [0.42, 0.75] },
};
// articulation floors: what the stock rigs managed before the ride rework (FL block lift, m)
const FLEX_MIN = {};
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };
const f2 = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const rows = [];
const row = (id, what, vals) => { rows.push({ id, what, vals }); };

for (const id of rigs) {
  const R = {};
  for (const [tag, code] of Object.entries(codes)) {
    const spec = code.ALL_VEHICLES.find((v) => v.id === id);
    const r = (R[tag] = {});
    if (has('spec')) r.spec = specRow(code, spec);
    if (has('release')) {
      r.rel = {};
      for (const mode of ['heave', 'front', 'rear', 'pitch', 'roll']) for (const dir of [1, -1]) {
        let res = release(code, spec, mode, dir);
        if (mode === 'roll' && Math.abs(res.x0) < 0.02) res = release(code, spec, mode, dir, 0.025 / Math.max(0.002, Math.abs(res.x0)));
        r.rel[mode + (dir > 0 ? '+' : '-')] = res;
      }
    }
    if (has('drop')) { r.drop = {}; for (const dh of [0.3, 0.5, 1.0]) r.drop[dh] = drop(code, spec, dh); }
    if (has('tyre')) r.tyre = { rock: tyreLanding(code, spec, 0), prop: tyreLanding(code, spec, 0.2) };
    if (has('flex')) r.flex = flex(code, spec);
    if (has('drive')) r.drive = driveCases(code, spec);
  }
  // ----- print
  const tags = Object.keys(R);
  const line = (what, fn) => console.log(`${id.padEnd(5)} ${what.padEnd(26)} ` + tags.map((t) => `${t}: ${fn(R[t])}`).join('   |   '));
  if (has('spec')) {
    line('spec f F/R (Hz)', (r) => `${f2(r.spec.front.f)} / ${f2(r.spec.rear.f)}`);
    line('spec zeta bump/reb F', (r) => `${f2(r.spec.front.zB)} / ${f2(r.spec.front.zR)}`);
    line('tyre / wheel rate (N/mm)', (r) => `${f2(r.spec.front.kTyre / 1000, 0)} / ${f2(r.spec.front.kWheel / 1000, 0)}`);
    line('hop f F/R (Hz), zeta', (r) => `${f2(r.spec.front.fHop, 1)} / ${f2(r.spec.rear.fHop, 1)}, ${f2(r.spec.front.zHop)}`);
  }
  if (has('release')) {
    for (const mode of ['heave', 'front', 'rear', 'pitch', 'roll']) {
      line(`${mode} down / up`, (r) => {
        const a = r.rel[mode + '+'], b = r.rel[mode + '-'];
        return `fn ${f2(a.fn)}/${f2(b.fn)} OS ${f2(a.os1)}/${f2(b.os1)} OS2 ${f2(a.os2)}/${f2(b.os2)} z ${f2(a.z1)}/${f2(b.z1)} settle ${f2(a.settle)}/${f2(b.settle)}s (${a.half}/${b.half})`;
      });
    }
  }
  if (has('drop')) for (const dh of [0.3, 0.5, 1.0]) line(`drop ${dh} m`, (r) => { const d = r.drop[dh]; return `bottom ${f2(d.bottom * 1000, 0)} mm rebound ${f2(d.rebound * 1000, 0)} (${f2(d.ratio)}) settle ${f2(d.settle)}s/${d.half} gain ${f2(d.gainJ, 0)} J (${f2(d.gainPct, 1)}%)`; });
  if (has('tyre')) line('tyre hop on rock / prop', (r) => `${f2(r.tyre.rock.hop * 1000, 1)} / ${f2(r.tyre.prop.hop * 1000, 1)} mm (e ${f2(r.tyre.rock.e)} / ${f2(r.tyre.prop.e)})`);
  if (has('flex')) line('flex: FL block lift (m)', (r) => f2(r.flex.lift, 3));
  if (has('drive')) {
    const dv = (k, f) => { if (R.after.drive[k]) line(k, (r) => (r.drive[k] ? f(r.drive[k]) : '-')); };
    const hp = (x) => `heave ${x.heave.half}hc ${f2(x.heave.t)}s [${x.heave.pk}] pitch ${x.pitch.half}hc ${f2(x.pitch.t)}s [${x.pitch.pk}] air ${f2(x.air)}s${x.up ? ' UPSIDE DOWN' : ''}`;
    dv('ledge03', hp); dv('ledge05', hp); dv('bump30', hp); dv('bump60', hp); dv('whoops', hp);
    dv('brake', (x) => `dive ${f2(x.dive, 1)} deg, pitch after stop ${x.pitch.half}hc ${f2(x.pitch.t)}s [${x.pitch.pk}]`);
    dv('lane', (x) => `roll ${f2(x.roll, 1)} deg at ${f2(x.ay)} g, after ${x.after.half}hc ${f2(x.after.t)}s [${x.after.pk}]`);
    dv('boulder', (x) => `heave ${x.heave.half}hc ${f2(x.heave.t)}s pitch ${x.pitch.half}hc ${f2(x.pitch.t)}s [${x.pitch.pk}] roll ${x.roll.half}hc ${f2(x.roll.t)}s`);
  }
  // ----- checks (current code only)
  const r = R.after, spec = codes.after.ALL_VEHICLES.find((v) => v.id === id);
  const band = spec.independent && spec.independent.every(Boolean) ? BANDS.rally : BANDS.truck;
  if (r.spec) {
    for (const a of ['front', 'rear']) check(r.spec[a].f >= band.f[0] && r.spec[a].f <= band.f[1], `${id}: spec ${a} ride frequency ${f2(r.spec[a].f)} Hz outside ${band.f}`);
    check(r.spec.rear.f >= r.spec.front.f, `${id}: rear ride frequency should be at or above the front`);
    check(r.spec.front.zR >= 1.5 * r.spec.front.zB && r.spec.front.zR <= 3 * r.spec.front.zB, `${id}: rebound / bump damping ratio ${f2(r.spec.front.zR / r.spec.front.zB)} outside 1.5-3`);
    check(r.spec.front.kTyre >= 180e3 && r.spec.front.kTyre <= 320e3, `${id}: tyre rate ${f2(r.spec.front.kTyre / 1000, 0)} N/mm outside 180-320`);
  }
  if (r.rel) {
    for (const end of ['front', 'rear']) {
      const fn = (r.rel[end + '+'].fn + r.rel[end + '-'].fn) / 2;
      check(fn >= band.f[0] - 0.05 && fn <= band.f[1] + 0.1, `${id}: measured ${end} ride frequency ${f2(fn)} Hz outside ${band.f}`);
      // released from compression the first swing is rebound; from lifted it is bump
      const zR = r.rel[end + '+'].z1, zB = r.rel[end + '-'].z1;
      check(zR >= band.zR[0] && zR <= band.zR[1], `${id}: measured ${end} rebound damping ${f2(zR)} outside ${band.zR}`);
      check(zB >= band.zB[0] && zB <= band.zB[1], `${id}: measured ${end} bump damping ${f2(zB)} outside ${band.zB}`);
    }
    for (const k of ['heave+', 'heave-', 'front+', 'front-', 'rear+', 'rear-', 'pitch+', 'pitch-', 'roll+', 'roll-']) {
      const x = r.rel[k];
      if (Math.abs(x.x0) < 0.008) continue; // too small to judge (stiff roll on the sedan)
      check(x.os1 <= 0.32, `${id}: ${k} release overshoot ${f2(x.os1)} > 0.32`);
      check(x.os2 <= 0.1, `${id}: ${k} release second overshoot ${f2(x.os2)} > 0.10`);
      check(x.half <= 3, `${id}: ${k} release took ${x.half} half-cycles to get within 5 mm (max 3)`);
    }
  }
  if (r.drop) for (const dh of [0.3, 0.5, 1.0]) {
    const d = r.drop[dh];
    check(d.gainPct < 2, `${id}: drop ${dh} m gained ${f2(d.gainJ, 0)} J of energy (${f2(d.gainPct, 1)}% of the drop)`);
    check(d.ratio <= 0.4, `${id}: drop ${dh} m rebound ${f2(d.ratio)} of the bottom-out (max 0.40)`);
    check(d.half <= 4 && d.settle <= 1.6, `${id}: drop ${dh} m settles in ${d.half} half-cycles / ${f2(d.settle)} s (max 4 / 1.6 s)`);
  }
  if (r.tyre) {
    check(r.tyre.rock.hop <= 0.005, `${id}: tyre hopped ${f2(r.tyre.rock.hop * 1000, 1)} mm off rock (max 5 mm)`);
    check(r.tyre.prop.hop <= 0.005, `${id}: tyre hopped ${f2(r.tyre.prop.hop * 1000, 1)} mm off a 0.2-restitution prop (max 5 mm)`);
  }
  if (r.flex && R.before && R.before.flex) check(r.flex.lift >= R.before.flex.lift - 0.012, `${id}: articulation lift ${f2(r.flex.lift, 3)} m below before ${f2(R.before.flex.lift, 3)} m`);
  if (r.flex && FLEX_MIN[id]) check(r.flex.lift >= FLEX_MIN[id], `${id}: articulation lift ${f2(r.flex.lift, 3)} m below ${FLEX_MIN[id]} m`);
  if (r.drive) {
    const d = r.drive;
    for (const k of ['ledge03', 'ledge05', 'bump30', 'boulder']) {
      if (!d[k]) continue;
      check(!d[k].up, `${id}: ${k} rolled over`);
      check(d[k].heave.half <= 4 && d[k].pitch.half <= 5, `${id}: ${k} body still moving: heave ${d[k].heave.half} / pitch ${d[k].pitch.half} half-cycles`);
    }
    if (d.brake) check(d.brake.pitch.half <= 3, `${id}: pitch after a hard stop took ${d.brake.pitch.half} half-cycles`);
    if (d.lane) check(d.lane.after.half <= 3, `${id}: roll after a lane change took ${d.lane.after.half} half-cycles`);
  }
}
if (fails.length) { console.log(`\n${fails.length} ride check(s) failed:`); for (const f of fails) console.log('  FAIL', f); }
else console.log('\nride checks ok');
if (!process.env.RIDE_NOASSERT) process.exit(fails.length ? 1 : 0);
