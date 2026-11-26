// Named spawn points for the current map (BeamNG-style: open the map, pick a point, drive from there).
// Everything is derived from the map data in src/terrain.js: the trailhead / default spawn, BOTH ends
// of every trail (a few metres outside the gate, facing in, so driving forward starts a run), every
// Gauntlet stage gate plus the summit and the bypass track, and on the race track the grid, every
// checkpoint (facing the racing direction) and the paddock.
//
// Each candidate is checked numerically before it is offered: the ground under a vehicle-sized
// footprint must be flat enough (plane fit grade and bumpiness), dry and firm (no water / bog), inside
// the map and clear of every rock, tree trunk and box prop collider (plus any extra obstacles the
// caller passes, e.g. loose physics props). A candidate that fails is nudged along its path until it
// is clear; one that can't be made safe is skipped with a console warning. Deterministic: same map
// data, same list. No three.js and no DOM, so Node tests use it as is.
import { MAP, MAP_ID, SIZE, SPAWN, TRAILS, ROADS, CHECKPOINTS, TRACK, PROPS, DIFF, MAT, heightAt, materialAt, pathPoint } from './terrain.js';

// Footprint checked under a spawn: covers the longest rig (6.4 m) with a margin.
export const FOOT = { hl: 3.5, hw: 1.35, margin: 0.35 };
export const LIMITS = { grade: 0.12, rough: 0.14 };
const DIFF_ORDER = ['green', 'blue', 'black', 'dblack'];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const yawOf = (dx, dz) => Math.atan2(-dx, -dz);   // vehicle yaw that faces along (dx, dz)

// Point on a path at arc length s, extended straight past either end (spawns sit just outside gates).
function along(path, s) {
  if (s >= 0 && s <= path.length) return pathPoint(path, s);
  const end = s < 0 ? pathPoint(path, 0) : pathPoint(path, path.length), d = s < 0 ? s : s - path.length;
  return { x: end.x + end.tx * d, z: end.z + end.tz * d, h: end.h, tx: end.tx, tz: end.tz };
}

// Obstacles as discs { x, z, r } (r = horizontal reach of the collider).
export function obstaclesFrom({ rocks = [], trees = [], props = PROPS, extra = [] } = {}) {
  const out = [];
  for (const r of rocks) {
    let reach = 0, top = -Infinity;
    for (let i = 0; i < r.pts.length; i += 3) { reach = Math.max(reach, Math.hypot(r.pts[i], r.pts[i + 2])); top = Math.max(top, r.pts[i + 1]); }
    if (r.y + top < heightAt(r.x, r.z) + 0.05) continue; // (nearly) buried: part of the ground
    out.push({ x: r.x, z: r.z, r: reach, kind: 'rock' });
  }
  for (const t of trees) out.push({ x: t.x, z: t.z, r: 0.22 * (t.s ?? 1), kind: 'tree' });
  for (const b of props) out.push({ x: b.x, z: b.z, r: Math.hypot(b.hx, b.hz), kind: 'prop' });
  // loose stones / logs the map scatters (the Gauntlet's early stages): physical props in game
  for (const st of MAP.LOOSE?.stones ?? []) out.push({ x: st.x, z: st.z, r: 0.35 * (st.s ?? 1), kind: 'loose stone' });
  for (const lg of MAP.LOOSE?.logs ?? []) out.push({ x: lg.x, z: lg.z, r: (lg.sx ?? 2.5) / 2, kind: 'loose log' });
  for (const e of extra) {
    const x = e.x ?? e.pos?.x, z = e.z ?? e.pos?.z;
    if (Number.isFinite(x) && Number.isFinite(z)) out.push({ x, z, r: e.r ?? e.halfLen ?? 0.5, kind: 'loose' });
  }
  return out;
}

// Footprint check at a pose. Returns { ok, why, grade, rough }.
export function checkSpot(x, z, yaw, obstacles, foot = FOOT, limits = LIMITS) {
  const lim = SIZE / 2 - 12;
  if (!(Math.abs(x) < lim && Math.abs(z) < lim)) return { ok: false, why: 'outside the map' };
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), lx = -fz, lz = fx;
  // ground: least-squares plane over a 7 x 4 grid of samples
  const A = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1].map((k) => k * foot.hl), B = [-1, -1 / 3, 1 / 3, 1].map((k) => k * foot.hw);
  const S = [];
  for (const a of A) for (const b of B) {
    const px = x + fx * a + lx * b, pz = z + fz * a + lz * b, m = materialAt(px, pz);
    if (m === MAT.WATER || m === MAT.MUD) return { ok: false, why: m === MAT.WATER ? 'water' : 'bog' };
    S.push([a, b, heightAt(px, pz)]);
  }
  const c = S.reduce((q, s) => q + s[2], 0) / S.length;
  const ga = S.reduce((q, s) => q + s[0] * (s[2] - c), 0) / S.reduce((q, s) => q + s[0] * s[0], 0);
  const gb = S.reduce((q, s) => q + s[1] * (s[2] - c), 0) / S.reduce((q, s) => q + s[1] * s[1], 0);
  const grade = Math.hypot(ga, gb), rough = Math.max(...S.map(([a, b, h]) => Math.abs(h - (c + ga * a + gb * b))));
  if (grade > limits.grade) return { ok: false, why: `grade ${grade.toFixed(2)}`, grade, rough };
  if (rough > limits.rough) return { ok: false, why: `rough ${rough.toFixed(2)} m`, grade, rough };
  // colliders: disc vs. the footprint rectangle grown by the margin
  const hl = foot.hl + foot.margin, hw = foot.hw + foot.margin, R = Math.hypot(hl, hw);
  for (const o of obstacles) {
    const dx = o.x - x, dz = o.z - z;
    if (dx * dx + dz * dz > (R + o.r) ** 2) continue;
    const a = dx * fx + dz * fz, b = dx * lx + dz * lz;
    const ea = Math.max(0, Math.abs(a) - hl), eb = Math.max(0, Math.abs(b) - hw);
    if (Math.hypot(ea, eb) < o.r) return { ok: false, why: `${o.kind} at ${o.x.toFixed(1)},${o.z.toFixed(1)}`, grade, rough };
  }
  return { ok: true, grade, rough };
}

// cost term for ranking candidate spots: the ground's grade under the footprint (0 = level)
const flatness = (x, z, yaw) => { const r = checkSpot(x, z, yaw, [], FOOT, { grade: Infinity, rough: Infinity }); return r.grade === undefined ? 50 : r.grade * 40 + r.rough * 20; };

// spawn height: lift the truck so its highest wheel clears the ground by `clear` (slopes!), as the
// lift argument of main.js respawnFresh (which adds it to the ground height under the centre)
export function liftFor(sp, spec, clear = 0.15) {
  const fx = -Math.sin(sp.yaw), fz = -Math.cos(sp.yaw), lx = -fz, lz = fx, h0 = heightAt(sp.x, sp.z);
  let up = 0;
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    const x = sp.x + fx * a * spec.wheelbase / 2 + lx * b * (spec.track / 2), z = sp.z + fz * a * spec.wheelbase / 2 + lz * b * (spec.track / 2);
    up = Math.max(up, heightAt(x, z) - h0);
  }
  return up + clear;
}

// ---------------------------------------------------------------- candidates per map
// pose(k): the k-th nudge (k = 0 is the preferred spot); returns { x, z, yaw } or null when out of tries.
function candidates() {
  const C = [];
  const add = (o) => C.push(o);
  const fixed = (x, z, yaw) => (k) => (k === 0 ? { x, z, yaw } : null);
  // nudges along a path: 0, then the listed offsets (metres of arc length)
  const onPath = (path, s0, offs, face) => (k) => {
    if (k > offs.length) return null;
    const p = along(path, s0 + (k ? offs[k - 1] : 0));
    return { x: p.x, z: p.z, yaw: face > 0 ? yawOf(p.tx, p.tz) : yawOf(-p.tx, -p.tz) };
  };
  const range = (a, b, step) => { const o = []; for (let v = a; step > 0 ? v <= b : v >= b; v += step) o.push(v); return o; };

  if (MAP.KIND === 'race') {
    add({ id: 'grid', name: 'Starting grid', short: 'STARTING GRID', kind: 'grid', group: 'start', note: 'Wait for the lights', pose: fixed(SPAWN.x, SPAWN.z, SPAWN.yaw), required: true });
    const pad = MAP.DECOR?.paddock;
    if (pad) add({ id: 'paddock', name: 'Paddock', short: 'PADDOCK', kind: 'paddock', group: 'start', note: 'Infield paddock. Drive to the start line for a timed lap',
      pose: (k) => { const offs = [[0, 4], [0, 1], [-3, 4], [3, 4], [0, 7]]; if (k >= offs.length) return null; return { x: pad.x + offs[k][0], z: pad.z + offs[k][1], yaw: Math.PI }; } });
    CHECKPOINTS.forEach((c, i) => {
      if (!i) return;
      // the flattest spot in the 8-70 m before the checkpoint (the turns are banked), closer is better
      const spots = [];
      for (let d = 8; d <= 70; d += 2) { const p = along(TRACK, c.s - d), yaw = yawOf(p.tx, p.tz); spots.push({ x: p.x, z: p.z, yaw, cost: flatness(p.x, p.z, yaw) + d * 0.04 }); }
      spots.sort((a, b) => a.cost - b.cost);
      add({ id: `cp-${i}`, name: `Checkpoint ${i}`, short: `CHECKPOINT ${i}`, kind: 'checkpoint', group: 'checkpoints', cp: i,
        note: 'Rolling start: the lap clock starts at the line',
        limits: { grade: 0.16, rough: LIMITS.rough }, pose: (k) => spots[k] ?? null }); // the track is graded smooth but banked
    });
    return C;
  }

  const crawlCourse = TRAILS.length === 1 && TRAILS[0].stages;
  add({ id: 'trailhead', name: 'Trailhead', short: 'TRAILHEAD', kind: 'trailhead', group: 'start', pose: fixed(SPAWN.x, SPAWN.z, SPAWN.yaw), required: true });
  if (crawlCourse) {
    const T = TRAILS[0], road = ROADS[0];
    if (road) add({ id: 'bypass', name: 'Bypass Track', short: 'BYPASS TRACK', kind: 'road', group: 'start', note: 'Graded track with a spur into every stage gate',
      pose: onPath(road, 24, range(2, 16, 2), 1) });
    for (const st of T.stages) {
      // a few metres before the gate (gate at s0 + 3), facing up the course; nudged back if needed
      const offs = [...range(-1, -12, -1), 1, 1.5];
      const onTrail = onPath(T, st.s0 - 2, offs, 1);
      // fallback: on the stage's bypass spur, facing along it towards the trail (it joins 5 m before the gate)
      const spur = st.spur !== undefined ? ROADS[st.spur] : null;
      const onSpur = spur ? onPath(spur, spur.length - 6, range(-1, -14, -1), 1) : () => null;
      const n0 = offs.length + 1;
      add({ id: `stage-${st.n}`, name: `Stage ${st.n}: ${st.name}`, short: `${st.n} ${st.name.toUpperCase()}`, kind: 'stage', group: 'stages', diff: st.diff, stage: st.n,
        note: st.n === 1 ? 'The start gate: a full, timed run' : 'Joining here: stages are timed, but the run total does not count as a best',
        pose: (k) => (k < n0 ? onTrail(k) : onSpur(k - n0)) });
    }
    add({ id: 'summit', name: 'Summit', short: 'SUMMIT', kind: 'summit', group: 'stages', diff: 'green', note: 'The top of The Gauntlet',
      pose: onPath(T, T.length - 13, range(-1, -6, -1), 1) });
    return C;
  }
  TRAILS.forEach((t, i) => {
    // Trail gates sit 3 m in from each end with radius width/2 + 2.5 (main.js updateTrails). The
    // spawn goes just outside, facing the gate, so driving forward enters it and starts the run.
    // Trails start on a road, often at an angle, so the spot is searched on a fan behind the
    // trail mouth: straight back first, then swinging out to either side and further away.
    const R = t.width / 2 + 2.5, id = slug(t.name);
    for (const end of [0, 1]) {
      const g = pathPoint(t, end ? t.length - 3 : 3), m = pathPoint(t, end ? t.length : 0);
      const ox = end ? m.tx : -m.tx, oz = end ? m.tz : -m.tz; // pointing out of the trail
      const fan = [];
      for (const d of [R + 2.5, R + 4, R + 5.5, R + 7, R + 9]) for (const deg of [0, 15, -15, 30, -30, 45, -45, 60, -60, 75, -75, 90, -90]) {
        const a = (deg * Math.PI) / 180, dx = ox * Math.cos(a) - oz * Math.sin(a), dz = ox * Math.sin(a) + oz * Math.cos(a);
        const x = g.x + dx * d, z = g.z + dz * d;
        const yaw = yawOf(g.x - x, g.z - z);
        fan.push({ x, z, yaw, gate: m, cost: d + Math.abs(deg) * 0.08 + flatness(x, z, yaw) });
      }
      // and the road the trail meets, every metre within reach of the gate
      for (const r of ROADS) for (let s = 0; s <= r.length; s += 1) {
        const p = pathPoint(r, s), d = Math.hypot(p.x - g.x, p.z - g.z);
        if (d > R + 1.5 && d < R + 14) { const yaw = yawOf(g.x - p.x, g.z - p.z); fan.push({ x: p.x, z: p.z, yaw, gate: m, cost: d + 4 + flatness(p.x, p.z, yaw) }); }
      }
      fan.sort((p, q) => p.cost - q.cost);
      add({ id: `${id}-${end ? 'end' : 'start'}`, name: `${t.name}: ${end ? 'far end' : 'start'}`, short: t.name.toUpperCase(), tag: end ? 'FAR END' : 'START',
        kind: 'trail', group: t.diff, diff: t.diff, trail: i, end, pose: (k) => fan[k] ?? null });
    }
  });
  return C;
}

// the drive from a spawn to the trail mouth (p.gate) must be clear too: no collider across the approach
function approachClear(p, obstacles, hw = FOOT.hw + 0.2) {
  if (!p.gate) return true;
  const ax = p.x, az = p.z, bx = p.gate.x, bz = p.gate.z, L2 = (bx - ax) ** 2 + (bz - az) ** 2 || 1;
  for (const o of obstacles) {
    const t = Math.max(0, Math.min(1, ((o.x - ax) * (bx - ax) + (o.z - az) * (bz - az)) / L2));
    if (Math.hypot(o.x - (ax + (bx - ax) * t), o.z - (az + (bz - az) * t)) < hw + o.r) return false;
  }
  // and drivable: no step steeper than the trail limit along the way
  const n = Math.ceil(Math.sqrt(L2));
  for (let k = 1; k <= n; k++) {
    const t0 = (k - 1) / n, t1 = k / n;
    const h0 = heightAt(ax + (bx - ax) * t0, az + (bz - az) * t0), h1 = heightAt(ax + (bx - ax) * t1, az + (bz - az) * t1);
    if (Math.abs(h1 - h0) / (Math.sqrt(L2) / n) > 0.4) return false;
  }
  return true;
}

// trail gates (for the "don't spawn inside a gate" rule)
const GATES = TRAILS.length === 1 && TRAILS[0].stages ? [] : TRAILS.flatMap((t) => [pathPoint(t, 3), pathPoint(t, t.length - 3)].map((p) => ({ x: p.x, z: p.z, r: t.width / 2 + 2.5 })));

export const GROUP_LABEL = { start: MAP_ID === 'race' ? 'START' : 'TRAILHEAD', green: DIFF.green.label.toUpperCase() + ' TRAILS', blue: DIFF.blue.label.toUpperCase() + ' TRAILS', black: DIFF.black.label.toUpperCase() + ' TRAILS', dblack: DIFF.dblack.label.toUpperCase() + ' TRAILS', stages: 'STAGES', checkpoints: 'CHECKPOINTS' };
const GROUP_ORDER = ['start', ...DIFF_ORDER, 'stages', 'checkpoints'];

// Build the validated list. opts: { rocks, trees, extra, warn }
export function buildSpawnPoints(opts = {}) {
  const warn = opts.warn ?? ((m) => console.warn(m));
  const obs = obstaclesFrom(opts);
  const list = [];
  for (const c of candidates()) {
    let pose = null, last = null;
    const why = {}; // failure reasons over all tries, for the warning
    for (let k = 0; ; k++) {
      const p = c.pose(k);
      if (!p) break;
      if (GATES.some((g) => Math.hypot(g.x - p.x, g.z - p.z) < g.r + 0.6)) { last = { why: 'inside a trail gate' }; why.gate = (why.gate || 0) + 1; continue; }
      const r = checkSpot(p.x, p.z, p.yaw, obs, FOOT, c.limits);
      if (r.ok && !approachClear(p, obs)) { last = { why: 'approach to the gate blocked' }; why.approach = (why.approach || 0) + 1; continue; }
      if (r.ok) { pose = { ...p, nudge: k, grade: r.grade, rough: r.rough }; break; }
      last = r; const w = r.why.split(' ')[0]; why[w] = (why[w] || 0) + 1;
    }
    if (!pose && c.required) { const p = c.pose(0); pose = { ...p, nudge: 0, unsafe: true }; warn(`[spawns] ${MAP_ID}: default spawn "${c.name}" failed its footprint check (${last?.why}); kept as the fallback`); }
    if (!pose) { warn(`[spawns] ${MAP_ID}: skipped "${c.name}": no safe spot nearby (tries failed on: ${Object.entries(why).map(([k, n]) => `${k} x${n}`).join(', ')})`); continue; }
    const { pose: _, required, limits: __, ...meta } = c;
    list.push({ ...meta, groupLabel: GROUP_LABEL[c.group], x: +pose.x.toFixed(2), z: +pose.z.toFixed(2), yaw: +pose.yaw.toFixed(4), note: c.note ?? (c.kind === 'trail' ? `${DIFF[c.diff].label}. Drive through the gate to start the run` : ''), nudge: pose.nudge, unsafe: !!pose.unsafe, default: !!required });
  }
  list.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)); // stable: keeps map order inside a group
  return list;
}

export const defaultSpawn = (list) => list.find((s) => s.default) || list[0] || null;

// ---------------------------------------------------------------- last-used spawn (per map)
const KEY = (mapId) => `lowrange.spawn.${mapId}`;
const mem = new Map();
const store = {
  get: (k) => { try { return globalThis.localStorage ? globalThis.localStorage.getItem(k) : mem.get(k) ?? null; } catch { return null; } },
  set: (k, v) => { try { if (globalThis.localStorage) globalThis.localStorage.setItem(k, v); else mem.set(k, v); } catch { /* storage blocked: session only */ } },
};
// the saved spawn point, validated against the current list (unknown / corrupt ids fall back to the default)
export function loadLastSpawn(list, mapId = MAP_ID) {
  const id = store.get(KEY(mapId));
  return (typeof id === 'string' && list.find((s) => s.id === id)) || defaultSpawn(list);
}
export function saveLastSpawn(sp, mapId = MAP_ID) { if (sp && sp.id) store.set(KEY(mapId), sp.id); }
