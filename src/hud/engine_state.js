// What the engine board on the HUD shows, as plain data: a pure mapping from the crash model's
// mechanical state (car.crash.mech, src/damage/crash.js) plus two drivetrain fields (dead,
// powerScale) to a temperature zone, oil / coolant / drive warnings and the seized state. No DOM,
// so node tests can drive it (test/enginehud.mjs). hud.js draws the result.

// Thresholds, mirrored from the damage model:
//  - temp runs 0 (normal) .. 1.2 (cap). crash.js mechStep: past 0.75 the "overheating: steam"
//    message fires; powerScale: past 0.85 power fades (to 40% at 1.0); past 1.0 the engine wears
//    (vehicle.js setEngineHealth seizes it at 8% health).
//  - oil below 0.25 starves the engine (mechStep wear); coolant gets the same low mark.
//  - radiator / oilPan below 0.7: the model's "Radiator holed" / "Oil pan cracked" messages.
export const TEMP = { max: 1.2, hot: 0.75, derate: 0.85, cook: 1.0 };
export const LOW = 0.25;
export const HOLED = 0.7;
const LEAK = 0.98;   // a level visibly below full counts as leaking even if the part is only nicked
const EMPTY = 0.02;
const FULL_POWER = 0.97;

const fluid = (level, part) => (level <= EMPTY ? 'empty' : level < LOW ? 'low' : part < HOLED || level < LEAK ? 'leak' : 'ok');

// mech: car.crash.mech; dt: car.dt ({ dead, powerScale })
export function engineStatus(mech, dt = {}) {
  const temp = mech.temp || 0, lost = mech.driveLost || [false, false];
  const power = dt.powerScale ?? 1;
  return {
    temp,
    tempFrac: Math.min(1, Math.max(0, temp / TEMP.max)),
    zone: temp > TEMP.cook ? 'overheat' : temp > TEMP.hot ? 'hot' : 'normal',
    derate: temp > TEMP.derate,                  // heat is taking power away
    oil: { level: mech.oil, state: fluid(mech.oil, mech.oilPan ?? 1) },
    coolant: { level: mech.coolant, state: fluid(mech.coolant, mech.radiator ?? 1) },
    drive: lost[0] && lost[1] ? 'none' : lost[0] ? 'front' : lost[1] ? 'rear' : 'ok',
    seized: !!dt.dead,
    power,
    lowPower: !dt.dead && power < FULL_POWER,
  };
}

// Why the engine died, from the damage model's own message (vehicle.js setEngineHealth pushes
// "Engine seized: overheated" / "Engine seized: no oil" / "Engine destroyed" onto car.damageEvents).
export function causeFromEvent(msg) {
  if (/^Engine seized: no oil/i.test(msg)) return 'oil';
  if (/^Engine seized: overheated/i.test(msg)) return 'heat';
  if (/^Engine destroyed/i.test(msg)) return 'damage';
  return null;
}

// Fallback guess when no message was seen (latched by EngineWarnings at the moment it seizes,
// since the temperature falls again once the engine stops).
export function seizeCause(st) {
  if (st.oil.level < LOW) return 'oil';
  if (st.temp > TEMP.hot || st.coolant.level < LOW) return 'heat';
  return 'damage';
}

// Lamp label + state for drawLamp (instruments.js): null = dark, 'on' = amber, 'warn' = red.
const pctLabel = (v) => `${Math.min(99, Math.floor(v * 100))}%`;
export function engineLamps(st) {
  const f = (name, s) => ({
    label: s.state === 'empty' ? `NO ${name}` : s.state === 'ok' ? name : `${name} ${pctLabel(s.level)}`,
    state: s.state === 'ok' ? null : s.state === 'leak' ? 'on' : 'warn',
  });
  return {
    oil: f('OIL', st.oil),
    coolant: f('COOL', st.coolant),
    drive: { label: { ok: 'DRIVE', front: 'NO DRIVE F', rear: 'NO DRIVE R', none: 'NO DRIVE' }[st.drive], state: st.drive === 'ok' ? null : 'warn' },
  };
}

// Severity rank per warning: a warning blinks for BLINK seconds whenever its rank passes the worst
// it has reached since the last repair (first trigger or getting worse), then stays steady; a
// temperature dipping under a threshold and back does not blink again. A repair (a new
// car.crash.mech object: crash.js repair() builds a fresh one, and so does a new truck) re-arms
// every warning.
export const BLINK = 2.4, BLINK_HZ = 4;
const RANK = {
  temp: { normal: 0, hot: 1, overheat: 2 },
  fluid: { ok: 0, leak: 1, low: 2, empty: 3 },
  drive: { ok: 0, front: 1, rear: 1, none: 2 },
};
export function ranks(st) {
  return {
    temp: RANK.temp[st.zone], oil: RANK.fluid[st.oil.state], coolant: RANK.fluid[st.coolant.state],
    drive: RANK.drive[st.drive], seized: st.seized ? 1 : 0, power: st.lowPower ? 1 : 0,
  };
}

export class EngineWarnings {
  constructor() { this.worst = {}; this.onset = {}; this.cause = null; this.noted = null; this.mech = null; }
  // Feed the damage model's messages (car.damageEvents, before main.js drains them into toasts):
  // an engine seize / destroy message is the authoritative cause.
  note(events) {
    for (const e of events) { const c = causeFromEvent(e); if (c) this.noted = c; }
  }
  // mech: the car.crash.mech object (identity only), so a repair re-arms the blinks.
  // Returns { lit: { key: false while a blink is in its dark phase }, blinking: { key: bool }, cause }.
  update(st, clock, mech = null) {
    if (mech && mech !== this.mech) { this.mech = mech; this.worst = {}; this.onset = {}; }
    const r = ranks(st), lit = {}, blinking = {};
    for (const k of Object.keys(r)) {
      if (r[k] > (this.worst[k] || 0)) { this.onset[k] = clock; this.worst[k] = r[k]; }
      const age = r[k] > 0 && this.onset[k] != null ? clock - this.onset[k] : Infinity;
      blinking[k] = age < BLINK;
      lit[k] = !blinking[k] || Math.floor(age * BLINK_HZ * 2) % 2 === 0;
    }
    if (!st.seized) { this.cause = null; this.noted = null; }
    else this.cause = this.noted || this.cause || seizeCause(st);
    return { lit, blinking, cause: this.cause };
  }
}
