// Garage: vehicle builds. A build is a flat set of choices layered onto a deep copy of a base
// spec from specs.js; applyBuild(base, build) returns the spec the physics and view consume.
// No DOM or three.js here, so node tests can use it directly.
import { Drivetrain } from './drivetrain.js';

const IN = 0.0254;

// Tread compounds: [mu, rr] multipliers per surface (keys are MAT names in terrain.js).
// All-terrain is the baseline the terrain tuning was done with.
export const TREADS = {
  at: { name: 'All-terrain', note: 'Balanced; best on roads and gravel', grip: {} },
  mt: { name: 'Mud-terrain', note: 'Mud +22%, sand +4%; slower and slippier on road, rock -5%',
    grip: { MUD: [1.22, 0.85], SAND: [1.04, 1], DIRT: [1.03, 1], ROCK: [0.95, 1], ROAD: [0.9, 1.3], GRAVEL: [0.97, 1.1] } },
  rock: { name: 'Rock compound', note: 'Sticky: rock +15%; mud -10%, sand -5%',
    grip: { ROCK: [1.15, 1], GRAVEL: [1.02, 1], ROAD: [1.02, 1.1], MUD: [0.9, 1.05], SAND: [0.95, 1.05], GRASS: [0.97, 1] } },
};

export const PAINTS = [0xb33a2b, 0xe46a1e, 0xe8a020, 0xd9c84a, 0x6b7a3a, 0x3c6e3a, 0x3f7f8f, 0x1f4fa8, 0x7a2e8c, 0xe9e4d4, 0xc9c2b0, 0xd2d4d8, 0x5a5d62, 0x232427];
export const RIMS = [0x232427, 0x9aa0a6, 0x8f7550, 0xc9a43a, 0xc03020, 0xe9e4d4];

const LIFTS = [0, 0.05, 0.1];                       // m of extra ride height (2", 4")
const SPRINGS = { soft: 0.85, stock: 1, stiff: 1.18 }; // susp.freq multiplier
const DAMPING = { soft: 0.75, stock: 1, firm: 1.3 };   // susp.zeta multiplier
const ENGINES = {
  stock: { t: 1, rl: 1, pk: 1 },
  tune: { t: 1.12, rl: 1.04, pk: 1 },
  built: { t: 1.28, rl: 1.08, pk: 1.05 },
};
const ARMOUR = { // extra mass as a fraction of chassis mass, damage multipliers
  skid: { mass: 0.035, under: 0.45, wheel: 0.8 },
  sliders: { mass: 0.03, side: 0.45 },
  bumpers: { mass: 0.05, end: 0.5 },
};

const isDiesel = (b) => b.engine.sound === 'diesel';
const maxTyre = (b) => (b.tire.radius < 0.4 ? 1 : 2);
const r2 = (x) => Math.round(x * 100) / 100;
const finals = (b) => [1, 0.88, 1.12, 1.25].map((m) => r2(b.final * m));
const lows = (b) => (b.ranges.low ? [b.ranges.low, r2(b.ranges.low * 1.35), r2(b.ranges.low * 1.7)] : [0, 2.0, 2.72]);
const stockDiff = (b, end) => (b.lockers[end] ? 'locker' : b.lsd && b.lsd[end] ? 'lsd' : 'open');
const inches = (r) => Math.round((r * 2) / IN);

export function defaultBuild(base) {
  return {
    tyreSize: 0, tread: 'at',
    lift: 0, springs: 'stock', damping: 'stock', travel: 'stock',
    engine: 'stock', turbo: false,
    final: base.final, low: base.ranges.low || 0,
    front: stockDiff(base, 'front'), rear: stockDiff(base, 'rear'),
    skid: false, sliders: false, bumpers: false,
    paint: null, rim: null,
  };
}

// Upgrade categories for the UI (and for tests to enumerate every choice).
// Each item: { key, label, choices: [{ value, label, note? }], swatch? }
export function buildOptions(base) {
  const st = (v, stock) => (v === stock ? ' (stock)' : '');
  const diff = (end) => ['open', 'lsd', 'locker'].map((v) => ({
    value: v, label: { open: 'Open', lsd: 'LSD', locker: 'Locker' }[v] + st(v, stockDiff(base, end)),
    note: { open: 'Open diff: power goes to the wheel with least grip', lsd: 'Limited-slip: biases torque to the gripping wheel', locker: 'Selectable locker (Q / E): both wheels turn together' }[v],
  }));
  const groups = [
    { id: 'tyres', label: 'Tyres', items: [
      { key: 'tyreSize', label: 'Size', choices: Array.from({ length: maxTyre(base) + 1 }, (_, k) => ({ value: k, label: `${inches(base.tire.radius + k * IN)}"${k ? '' : ' (stock)'}`, note: k ? 'Taller tyres: more clearance, taller effective gearing, more unsprung weight' : 'Stock size' })) },
      { key: 'tread', label: 'Tread', choices: Object.entries(TREADS).map(([v, t]) => ({ value: v, label: t.name + st(v, 'at'), note: t.note })) },
    ] },
    { id: 'susp', label: 'Suspension', items: [
      { key: 'lift', label: 'Lift', choices: LIFTS.map((l, k) => ({ value: k, label: k ? `+${Math.round(l / IN)}"` : 'Stock', note: k ? 'Raises the body: more belly clearance, higher centre of gravity' : 'Stock ride height' })) },
      { key: 'springs', label: 'Springs', choices: ['soft', 'stock', 'stiff'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1), note: { soft: 'Softer: more flex and grip, more body roll', stock: 'Stock rate', stiff: 'Stiffer: less roll, faster on roads, less compliant' }[v] })) },
      { key: 'damping', label: 'Damping', choices: ['soft', 'stock', 'firm'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1), note: { soft: 'Plush but bouncy', stock: 'Stock shocks', firm: 'Controlled, but harsh over rocks' }[v] })) },
      { key: 'travel', label: 'Travel', choices: [{ value: 'stock', label: 'Stock' }, { value: 'long', label: 'Long-travel kit', note: 'More droop and axle twist; disconnects most of the sway bar' }] },
    ] },
    { id: 'engine', label: 'Engine', items: [
      { key: 'engine', label: 'Tune', choices: [{ value: 'stock', label: 'Stock' }, { value: 'tune', label: 'Tune', note: '+12% torque, higher rev limit' }, { value: 'built', label: 'Built', note: '+28% torque, +8% rev limit' }] },
      ...(isDiesel(base) ? [{ key: 'turbo', label: 'Turbo', choices: [{ value: false, label: 'Stock' }, { value: true, label: 'Bigger turbo', note: '+20% torque' }] }] : []),
    ] },
    { id: 'gears', label: 'Gearing', items: [
      { key: 'final', label: 'Final drive', choices: [...finals(base)].sort((a, b) => a - b).map((v) => ({ value: v, label: v.toFixed(2) + st(v, base.final), note: v > base.final ? 'Shorter: more crawl, lower top speed' : v < base.final ? 'Taller: faster, less low-end grunt' : 'Stock ring and pinion' })) },
      { key: 'low', label: 'Low range', choices: lows(base).map((v) => ({ value: v, label: v ? v.toFixed(2) + ':1' + st(v, base.ranges.low || 0) : 'None (stock)', note: v ? (v === base.ranges.low ? 'Stock transfer case' : 'Crawler gears in the transfer case') : 'No low range' })) },
    ] },
    { id: 'diffs', label: 'Diffs', items: [
      { key: 'front', label: 'Front', choices: diff('front') },
      { key: 'rear', label: 'Rear', choices: diff('rear') },
    ] },
    { id: 'armour', label: 'Armour', items: [
      { key: 'skid', label: 'Skid plates', choices: [{ value: false, label: 'None' }, { value: true, label: `Fitted +${Math.round(base.chassis.mass * ARMOUR.skid.mass)} kg`, note: 'Belly / diff hits do 55% less damage, steering 20% less' }] },
      { key: 'sliders', label: 'Rock sliders', choices: [{ value: false, label: 'None' }, { value: true, label: `Fitted +${Math.round(base.chassis.mass * ARMOUR.sliders.mass)} kg`, note: 'Side hits do 55% less damage' }] },
      { key: 'bumpers', label: 'Bumpers', choices: [{ value: false, label: 'Stock' }, { value: true, label: `Steel +${Math.round(base.chassis.mass * ARMOUR.bumpers.mass)} kg`, note: 'Front / rear hits do half the damage (protects the engine)' }] },
    ] },
    { id: 'paint', label: 'Paint', items: [
      { key: 'paint', label: 'Body', swatch: true, choices: [{ value: null, label: 'Stock', color: base.color }, ...PAINTS.map((c) => ({ value: c, label: '#' + c.toString(16).padStart(6, '0'), color: c }))] },
      { key: 'rim', label: 'Wheels', swatch: true, choices: [{ value: null, label: 'Stock', color: null }, ...RIMS.map((c) => ({ value: c, label: '#' + c.toString(16).padStart(6, '0'), color: c }))] },
    ] },
  ];
  return groups;
}

// Fill gaps / drop stale values (e.g. old localStorage) so every key holds a legal choice.
export function sanitizeBuild(base, build) {
  const out = defaultBuild(base);
  if (!build || typeof build !== 'object') return out; // null / string / number from corrupted storage
  for (const g of buildOptions(base)) for (const it of g.items) {
    if (it.choices.some((c) => c.value === build[it.key])) out[it.key] = build[it.key];
  }
  return out;
}

export function isStock(base, build) {
  return JSON.stringify(sanitizeBuild(base, build)) === JSON.stringify(defaultBuild(base));
}

export function applyBuild(base, build) {
  const b = sanitizeBuild(base, build);
  const s = structuredClone(base);
  s.build = b;
  s.bodyAxleY = base.axleY; // body panels stay where they were designed; lift moves the axles down

  // tyres: one size = +2" diameter; mass scales with the tyre's volume-ish
  const t = s.tire, r0 = t.radius, w0 = t.width;
  t.radius = r0 + b.tyreSize * IN;
  t.width = w0 * (1 + 0.05 * b.tyreSize);
  t.mass = Math.round(t.mass * (t.radius / r0) ** 2 * (t.width / w0));
  t.tread = b.tread;
  if (Object.keys(TREADS[b.tread].grip).length) t.grip = TREADS[b.tread].grip;

  // suspension
  s.axleY = base.axleY - LIFTS[b.lift];
  const su = s.susp;
  // [ride] springs scale both axles' ride frequency, damping both bump and rebound (src/ride.js)
  su.freq *= SPRINGS[b.springs];
  if (su.freqR) su.freqR *= SPRINGS[b.springs];
  su.zeta *= DAMPING[b.damping];
  if (su.zetaR) su.zetaR *= DAMPING[b.damping];
  if (b.travel === 'long') {
    su.bump += 0.02; su.droop += 0.08; su.articulation += 0.1;
    if (su.arb) su.arb *= 0.6;
  }

  // engine
  const e = s.engine, E = ENGINES[b.engine];
  e.peakT = Math.round(e.peakT * E.t * (b.turbo ? 1.2 : 1));
  e.redline = Math.round(e.redline * E.rl / 50) * 50;
  e.peakRpm = Math.round(Math.min(e.peakRpm * E.pk, e.redline * 0.85));

  // gearing
  s.final = b.final;
  if (b.low) s.ranges.low = b.low; else delete s.ranges.low;

  // diffs
  const lsdT = (end) => (base.lsd && base.lsd[end]) || Math.round(base.chassis.mass * 0.45);
  s.lockers = { front: b.front === 'locker', rear: b.rear === 'locker' };
  const lsd = {};
  for (const end of ['front', 'rear']) {
    if (b[end] === 'lsd' || (b[end] === 'locker' && base.lsd && base.lsd[end])) lsd[end] = lsdT(end);
  }
  if (Object.keys(lsd).length) s.lsd = lsd; else delete s.lsd;

  // armour: weight + damage multipliers by hit direction
  const ar = { under: 1, side: 1, end: 1, wheel: 1 };
  let extra = 0;
  for (const k of ['skid', 'sliders', 'bumpers']) {
    if (!b[k]) continue;
    const a = ARMOUR[k];
    extra += base.chassis.mass * a.mass;
    for (const d of ['under', 'side', 'end', 'wheel']) if (a[d]) ar[d] = a[d];
  }
  s.chassis.mass = Math.round(base.chassis.mass + extra);
  if (extra) s.armour = ar;

  if (b.paint !== null) s.color = b.paint;
  if (b.rim !== null) s.rimColor = b.rim;
  return s;
}

// Readouts for the garage (also used by the menu cards).
export function stats(spec) {
  const e = spec.engine, R = spec.tire.radius;
  let pk = 0;
  const dt = { spec };
  for (let rpm = e.idle; rpm <= e.redline; rpm += 25) pk = Math.max(pk, Drivetrain.prototype.maxTorqueAt.call(dt, rpm) * rpm);
  const low = spec.ranges.low || spec.ranges.high;
  const crawl = spec.gears[0] * low * spec.final;
  const ind = spec.independent || [false, false];
  // lowest hard point: solid-axle diff pumpkins, IFS diffs (on the chassis), the frame itself
  const belly = R - spec.axleY + (spec.chassis.floor ?? -spec.chassis.size[1] / 2);
  const diffs = ind.map((i) => (i ? R + 0.06 - 0.3 * R : R - 0.32 * R));
  const s = spec.susp;
  return {
    powerKW: (pk * Math.PI) / 30 / 1000,
    torque: e.peakT,
    weight: spec.chassis.mass + 2 * spec.axleMass + 4 * spec.tire.mass,
    crawl,
    crawlKmh: ((e.idle / crawl) * (2 * Math.PI) / 60) * R * 3.6,
    clearance: Math.min(belly, ...diffs),
    belly,
    tyreIn: (R * 2) / IN,
    tread: TREADS[spec.tire.tread || 'at'].name,
    travel: s.bump + s.droop,
    flexDeg: ind.every(Boolean) ? 0 : (s.articulation * 180) / Math.PI,
    lockers: [spec.lockers.front && 'F', spec.lockers.rear && 'R'].filter(Boolean).join('+') || 'none',
  };
}

// ---- persistence (per vehicle id) ----
const KEY = 'lowrange.builds.v1';
const store = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };
function readAll() {
  const ls = store();
  if (!ls) return {};
  try {
    const all = JSON.parse(ls.getItem(KEY) || '{}');
    // anything but a plain object (e.g. "5", "[]", a bare string) would make saveBuild throw or drop builds
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  } catch { return {}; }
}
export function loadBuild(base) { return sanitizeBuild(base, readAll()[base.id]); }
export function saveBuild(base, build) {
  const ls = store();
  if (!ls) return;
  const all = readAll();
  if (isStock(base, build)) delete all[base.id]; else all[base.id] = sanitizeBuild(base, build);
  try { ls.setItem(KEY, JSON.stringify(all)); } catch { /* storage full / disabled: build lives for this session only */ }
}
