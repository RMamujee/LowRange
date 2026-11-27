// Engine board on the HUD (src/hud/engine_state.js): drives a real truck's mechanical damage
// (car.crash.mech, src/damage/crash.js) through healthy -> radiator holed -> overheating -> seized,
// oil loss, a snapped driveshaft and repairs, and checks what the board shows at each step: the
// temperature zone, the oil / coolant / drive lamps, the power readout, the seized state and the
// blink when a warning first comes on. The zones must flip exactly where the damage model acts.
import RAPIER from '@dimforge/rapier3d-compat';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
import { TEMP, LOW, BLINK, engineStatus, engineLamps, EngineWarnings, seizeCause, causeFromEvent } from '../src/hud/engine_state.js';
await RAPIER.init();
const H = 1 / 200;
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log('  FAIL', msg); } };

// ---- pure mapping at the threshold edges (no physics)
{
  const fresh = { radiator: 1, coolant: 1, temp: 0, oilPan: 1, oil: 1, driveLost: [false, false] };
  const st = (m = {}, dt = {}) => engineStatus({ ...fresh, ...m }, dt);
  const s0 = st();
  check(s0.zone === 'normal' && s0.oil.state === 'ok' && s0.coolant.state === 'ok' && s0.drive === 'ok' && !s0.seized && !s0.lowPower && s0.tempFrac === 0, 'fresh mech: all quiet');
  const L0 = engineLamps(s0);
  check(L0.oil.state === null && L0.coolant.state === null && L0.drive.state === null && L0.oil.label === 'OIL' && L0.coolant.label === 'COOL' && L0.drive.label === 'DRIVE', 'fresh mech: lamps dark');
  check(st({ temp: TEMP.hot }).zone === 'normal' && st({ temp: TEMP.hot + 1e-3 }).zone === 'hot', 'hot zone starts where the model says "overheating" (temp > 0.75)');
  check(st({ temp: TEMP.cook }).zone === 'hot' && st({ temp: TEMP.cook + 1e-3 }).zone === 'overheat', 'overheat zone starts where the engine wears (temp > 1.0)');
  check(!st({ temp: TEMP.derate }).derate && st({ temp: TEMP.derate + 1e-3 }).derate, 'heat derate flag at temp > 0.85 (crash.js powerScale)');
  check(st({ temp: TEMP.max }).tempFrac === 1 && st({ temp: 5 }).tempFrac === 1, 'needle pinned at the hot stop');
  check(st({ radiator: 0.69 }).coolant.state === 'leak' && st({ radiator: 0.9 }).coolant.state === 'ok' && st({ radiator: 0.9, coolant: 0.97 }).coolant.state === 'leak', 'coolant leak: radiator holed (< 0.7) or level visibly down');
  check(st({ oil: LOW - 1e-3, oilPan: 0.2 }).oil.state === 'low' && st({ oil: 0 }).oil.state === 'empty', 'oil low under 0.25 (starvation), then empty');
  check(engineLamps(st({ oil: 0.5, oilPan: 0.3 })).oil.label === 'OIL 50%' && engineLamps(st({ oil: 1, oilPan: 0.3 })).oil.label === 'OIL 99%' && engineLamps(st({ oil: 0 })).oil.label === 'NO OIL', 'oil lamp level readout');
  check(engineLamps(st({ driveLost: [true, false] })).drive.label === 'NO DRIVE F' && engineLamps(st({ driveLost: [false, true] })).drive.label === 'NO DRIVE R' && engineLamps(st({ driveLost: [true, true] })).drive.label === 'NO DRIVE', 'drive lamp per axle');
  check(st({}, { powerScale: 0.9 }).lowPower && !st({}, { powerScale: 0.9, dead: true }).lowPower, 'power readout only while running');
  check(seizeCause(st({ oil: 0.1 })) === 'oil' && seizeCause(st({ temp: 1.1, coolant: 0 })) === 'heat' && seizeCause(st({ coolant: 0.1 })) === 'heat' && seizeCause(st()) === 'damage', 'seize cause');
  // blink: on a rise in severity for BLINK seconds, steady after, again after a repair
  check(causeFromEvent('Engine seized: overheated') === 'heat' && causeFromEvent('Engine seized: no oil') === 'oil' && causeFromEvent('Engine destroyed') === 'damage' && causeFromEvent('Radiator holed: watch the temperature') === null, 'cause from the damage model messages');
  // blink: on a rise past the worst level since the last repair, for BLINK seconds; again after a repair
  const m1 = {}, m2 = {}, w = new EngineWarnings();
  w.update(s0, 0, m1);
  const a = w.update(st({ radiator: 0.3 }), 1, m1);
  check(a.blinking.coolant && a.lit.coolant && !a.blinking.oil, 'coolant blinks when it first comes on');
  check(!w.update(st({ radiator: 0.3 }), 1 + 1 / 8 + 1e-3, m1).lit.coolant, 'blink has a dark phase');
  check(!w.update(st({ radiator: 0.3 }), 1 + BLINK + 0.01, m1).blinking.coolant, 'blink stops after BLINK seconds');
  check(w.update(st({ radiator: 0.3, coolant: 0.1 }), 5, m1).blinking.coolant, 'blinks again when it gets worse (leak -> low)');
  check(!w.update(st({ radiator: 0.3, coolant: 0.4 }), 5 + BLINK + 0.1, m1).blinking.coolant, 'no blink when it gets better');
  // temperature hovering around a threshold blinks once per escalation, not on every crossing
  check(w.update(st({ radiator: 0.3, temp: 0.9 }), 10, m1).blinking.temp, 'HOT blinks when first reached');
  w.update(st({ radiator: 0.3, temp: 0.7 }), 13, m1);
  check(!w.update(st({ radiator: 0.3, temp: 0.8 }), 14, m1).blinking.temp, 'HOT does not blink again after dipping under 0.75 and back');
  w.update(st({ radiator: 0.3, temp: 0.9 }, { powerScale: 0.9 }), 15, m1); w.update(st({ radiator: 0.3, temp: 0.8 }), 18, m1);
  check(!w.update(st({ radiator: 0.3, temp: 0.9 }, { powerScale: 0.9 }), 19, m1).blinking.power, 'POWER does not blink again after recovering and dropping again');
  check(w.update(st({ radiator: 0.3, temp: 1.05 }), 20, m1).blinking.temp, 'OVERHEATING still blinks (a new escalation)');
  w.update(s0, 30, m2);
  check(w.update(st({ radiator: 0.3 }), 31, m2).blinking.coolant && w.update(st({ radiator: 0.3, temp: 0.8 }), 31, m2).blinking.temp, 'a repair (fresh mech) re-arms every warning');
  // seize cause: the model's message wins over the guess from temperature / oil
  const wc = new EngineWarnings();
  wc.note(['Engine destroyed']);
  check(wc.update(st({ temp: 0.9, coolant: 0.1, oil: 0.1 }, { dead: true }), 0, m1).cause === 'damage', 'destroyed message beats a hot / dry guess');
  wc.update(s0, 1, m1);
  check(wc.update(st({ temp: 0.9 }, { dead: true }), 2, m1).cause === 'heat', 'no message: falls back to the guess');
  wc.note(['Engine destroyed']);
  check(wc.update(st({ temp: 0.9 }, { dead: true }), 2.1, m1).cause === 'damage', 'a message arriving a frame later still wins');
}

// ---- the real damage model, on a real truck
const spec = VEHICLES.find((v) => v.id === 'lc70') || VEHICLES[0];
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H; world.numSolverIterations = 8;
const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUP_WORLD));
const car = new Vehicle(RAPIER, world, spec, { ground, rockHandles: new Set() }, { x: 0, y: spec.tire.radius - spec.axleY + 0.05, z: 0 }, 0);
const warn = new EngineWarnings();
let clock = 0;
// like hud.js + main.js: the HUD sees the damage messages, then they are drained (into toasts there, a log here)
const log = [];
const view = () => {
  warn.note(car.damageEvents); log.push(...car.damageEvents.splice(0));
  const st = engineStatus(car.crash.mech, car.dt);
  return { st, lamps: engineLamps(st), w: warn.update(st, clock, car.crash.mech) };
};
// one physics step at a time until pred() (to find exactly where the model starts acting)
function stepUntil(secs, input, pred) {
  for (let i = 0; i < secs / H; i++) { car.step(input, H); clock += H; if (pred()) return true; }
  return false;
}
// run until pred(view) or a time limit; the HUD samples at 30 Hz like hud.js
function run(secs, input, until = null) {
  let v = view();
  for (let i = 0; i < secs / H; i++) {
    car.step(input, H); clock += H;
    if (i % 7 === 0) { v = view(); if (until && until(v)) return v; }
  }
  return view();
}
const idle = { throttle: 0, brake: 0, steer: 0 }, rev = { throttle: 0.6, brake: 0, steer: 0 }; // neutral: revving loads the engine
run(1.5, idle); car.grace = 0; car.damageEvents.length = 0; log.length = 0;
const fmt = (v) => `zone ${v.st.zone} temp ${v.st.temp.toFixed(2)} cool ${v.lamps.coolant.label}/${v.lamps.coolant.state} oil ${v.lamps.oil.label}/${v.lamps.oil.state} drive ${v.lamps.drive.label} power ${v.st.power.toFixed(2)} seized ${v.st.seized}${v.w.cause ? ' (' + v.w.cause + ')' : ''}`;

let v = run(3, rev);
console.log(`healthy:      ${fmt(v)}`);
check(v.st.zone === 'normal' && v.st.temp === 0 && v.lamps.coolant.state === null && v.lamps.oil.state === null && v.lamps.drive.state === null && !v.st.lowPower && !v.st.seized, 'healthy truck at full revs: board quiet');

// radiator holed (as crash.js does on a frontal hit): coolant lamp on, still cool
car.crash.mech.radiator = 0.25;
v = run(0.2, rev);
console.log(`holed:        ${fmt(v)}`);
check(v.lamps.coolant.state === 'on' && v.w.blinking.coolant && v.st.zone === 'normal', 'radiator holed: amber coolant lamp, blinking');
// coolant mostly gone (fast-forward the leak), engine worked hard
car.crash.mech.coolant = 0.1;
v = run(60, rev, () => log.some((e) => /overheating/i.test(e)));
console.log(`steam:        ${fmt(v)}`);
check(v.lamps.coolant.state === 'warn' && /^(COOL \d+%|NO COOL)$/.test(v.lamps.coolant.label), `coolant low: red lamp with level (${v.lamps.coolant.label})`);
check(v.st.zone === 'hot' && v.w.blinking.temp, `the model's "overheating" message and the HOT zone arrive together (${v.st.temp.toFixed(3)})`);
// tie the HUD's thresholds to the model's real behaviour: power starts to fall right at the derate
// mark (engine health still full, so it is heat), and the HUD's POWER readout follows
const tempNow = () => car.crash.mech.temp;
check(stepUntil(60, rev, () => car.dt.powerScale < 1) && car.health.engine === 1 && tempNow() > TEMP.derate && tempNow() < TEMP.derate + 0.005 && engineStatus(car.crash.mech, car.dt).derate,
  `the model's power loss starts at the HUD's derate mark ${TEMP.derate} (temp ${tempNow().toFixed(4)})`);
v = run(60, rev, (x) => x.st.lowPower);
check(v.st.zone === 'hot' && v.st.derate && v.st.power < 0.97, `heat takes power past ${TEMP.derate}: the board shows POWER while in the HOT zone (temp ${v.st.temp.toFixed(3)}, power ${v.st.power.toFixed(3)})`);
// ...and the engine starts to wear exactly where the HUD's OVERHEATING zone begins
check(stepUntil(60, rev, () => car.health.engine < 1) && tempNow() > TEMP.cook && tempNow() < TEMP.cook + 0.005 && engineStatus(car.crash.mech, car.dt).zone === 'overheat',
  `engine health starts falling at the HUD's overheat mark ${TEMP.cook} (temp ${tempNow().toFixed(4)})`);
v = run(0.1, rev);
console.log(`overheating:  ${fmt(v)}`);
check(v.st.zone === 'overheat' && v.w.blinking.temp, 'overheating zone, blinking again');
v = run(120, rev, (x) => x.st.seized);
console.log(`seized:       ${fmt(v)}`);
check(v.st.seized && car.dt.dead && v.w.cause === 'heat' && v.w.blinking.seized && !v.st.lowPower, 'engine seizes: seized state, cause overheated');
v = run(20, idle);
check(v.st.seized && v.w.cause === 'heat', `still shows seized + overheated after it cools (${v.st.temp.toFixed(2)})`);

// repair in place (Backspace): all quiet again; the player restarts the engine (I)
car.repair(); car.grace = 0; car.damageEvents.length = 0; car.dt.startEngine();
v = run(1, rev);
console.log(`repaired:     ${fmt(v)}`);
check(v.st.zone === 'normal' && v.st.temp === 0 && v.lamps.coolant.state === null && v.lamps.oil.state === null && v.lamps.drive.state === null && !v.st.seized && !v.st.lowPower && !Object.values(v.w.blinking).some(Boolean) && v.w.cause === null, 'repair: board back to normal');

// oil pan cracked: oil lamp, then starvation and a seized engine with the right cause
car.crash.mech.oilPan = 0.3;
v = run(0.5, rev);
console.log(`oil leak:     ${fmt(v)}`);
check(v.lamps.oil.state === 'on' && v.w.blinking.oil && v.lamps.oil.label === 'OIL 99%', `oil pan cracked: amber oil lamp with level (${v.lamps.oil.label})`);
car.crash.mech.oil = 0.2;
v = run(0.2, rev);
check(v.lamps.oil.state === 'warn' && v.w.blinking.oil && v.lamps.oil.label === 'OIL 19%', `oil low (starving): red oil lamp (${v.lamps.oil.label})`);
car.crash.mech.oil = 0;
v = run(200, rev, (x) => x.st.seized);
console.log(`oil seized:   ${fmt(v)}`);
check(v.lamps.oil.label === 'NO OIL' && v.lamps.oil.state === 'warn' && v.st.seized && v.w.cause === 'oil', 'no oil: seized, cause oil');
car.repair(); car.grace = 0; car.damageEvents.length = 0; car.dt.startEngine();

// engine destroyed by an impact (crash.js passes cause 'crush') while hot and low on coolant: WRECKED
v = run(0.5, rev);
Object.assign(car.crash.mech, { radiator: 0.2, coolant: 0.1, temp: 0.9 });
v = run(0.1, rev);
car.setEngineHealth(0, 'crush');
v = run(0.1, rev);
console.log(`hot, smashed: ${fmt(v)}`);
check(v.st.seized && v.w.cause === 'damage' && seizeCause(v.st) === 'heat', 'destroyed by impact while hot: WRECKED, not OVERHEATED');
car.repair(); car.grace = 0; car.dt.startEngine();
// destroyed by an impact with a cracked, nearly empty oil pan: WRECKED, not NO OIL
v = run(0.5, rev);
Object.assign(car.crash.mech, { oilPan: 0.2, oil: 0.1 });
car.setEngineHealth(0, 'crush');
v = run(0.1, rev);
console.log(`dry, smashed: ${fmt(v)}`);
check(v.st.seized && v.w.cause === 'damage' && seizeCause(v.st) === 'oil', 'destroyed by impact with a cracked oil pan: WRECKED, not NO OIL');
car.repair(); car.grace = 0; car.dt.startEngine();

// driveshaft snapped (crash.js setDriveshaft, as on a belly strike): drive lamp
v = run(0.5, rev);
car.crash.setDriveshaft(1, 0);
v = run(0.2, rev);
console.log(`drive lost:   ${fmt(v)}`);
check(car.crash.mech.driveLost[1] && v.lamps.drive.label === 'NO DRIVE R' && v.lamps.drive.state === 'warn' && v.w.blinking.drive && v.st.zone === 'normal' && !v.st.seized, 'rear driveshaft snapped: NO DRIVE R lamp, blinking');
v = run(BLINK + 0.2, rev);
check(!v.w.blinking.drive && v.lamps.drive.state === 'warn', 'drive lamp steady after the blink');
car.repair(); car.grace = 0;
v = run(0.5, rev);
check(v.lamps.drive.state === null && v.lamps.drive.label === 'DRIVE', 'repair restores the drive lamp');

car.destroy();
console.log(fails ? `${fails} FAILED` : 'engine HUD: all checks passed');
process.exit(fails ? 1 : 0);
