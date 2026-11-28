// Obstacle audit: raycasts the trail corridors and reports how tall the rocks really stand
// above the ground in the drivable width, and the step each ledge presents on the line.
// usage: node test/trailaudit.mjs [trailIndex]
import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt, TRAILS, pathPoint } from '../src/terrain.js';
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const rocks = generateRocks();
const terrain = buildTerrainPhysics(RAPIER, world, rocks, generateTrees());
world.step();
const ledgeHandles = new Set();
{
  const key = (x, y, z) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
  const ledges = new Set(rocks.filter((r) => r.ledge).map((r) => key(r.x, r.y, r.z)));
  world.forEachCollider((c) => { const p = c.parent()?.translation(); if (p && terrain.rockHandles.has(c.handle) && ledges.has(key(p.x, p.y, p.z))) ledgeHandles.add(c.handle); });
}
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
// surface height and what made it (ground / rock / ledge)
const surf = (x, z) => {
  const g = heightAt(x, z);
  ray.origin = { x, y: g + 6, z };
  const hit = world.castRay(ray, 8, true, undefined, undefined, undefined, undefined, (c) => terrain.rockHandles.has(c.handle));
  const y = hit ? g + 6 - hit.timeOfImpact : -1e9;
  return y > g ? { y, up: y - g, kind: ledgeHandles.has(hit.collider.handle) ? 'ledge' : 'rock' } : { y: g, up: 0, kind: 'ground' };
};
const only = process.argv[2] !== undefined ? [TRAILS[+process.argv[2]]] : TRAILS;
// a crawl corridor (trail.lines / cruxes, src/maps/trailpark.js): per crux and line, the tallest
// rock within 1 m of the line and the step each ledge band presents on it; the transit's tallest
// rock in the middle of its tread
const strip = (t, name, s0, s1, half) => {
  let top = 0, at = '';
  for (let s = s0; s < s1; s += 0.5) {
    const p = pathPoint(t, s), L = t.lineAt(name, s);
    for (let o = -half; o <= half + 1e-6; o += 0.25) { const r = surf(p.x - p.tz * (L + o), p.z + p.tx * (L + o)); if (r.kind === 'rock' && r.up > top) { top = r.up; at = `s=${s.toFixed(0)}`; } }
  }
  return [top, at];
};
const gLine = (t, name, s, dl) => { const p = pathPoint(t, s), L = t.lineAt(name, s) + dl; return heightAt(p.x - p.tz * L, p.z + p.tx * L); };
const lineSteps = (t, name, s0, s1) => {
  const out = [];
  for (const dl of [-0.8, 0, 0.8]) {
    let k = 0;
    for (let s = s0, inLedge = false, base = 0, peak = 0, a0 = 0, grade = 0; s < s1; s += 0.25) {
      const L = t.lineAt(name, s) + dl, p = pathPoint(t, s), r = surf(p.x - p.tz * L, p.z + p.tx * L);
      // (the line's own ground grade comes off, not the centreline's: a corridor's cross slope varies)
      if (r.kind === 'ledge') {
        if (!inLedge) { inLedge = true; a0 = s; base = gLine(t, name, s - 0.6, dl); grade = (base - gLine(t, name, s - 2.6, dl)) / 2; peak = -1e9; }
        if (s - a0 <= 1) peak = Math.max(peak, r.y - grade * (s - a0 + 0.6));
        if (s - a0 === 1) { out[k] = Math.max(out[k] ?? 0, peak - base); k++; }
      } else inLedge = false;
    }
  }
  return out;
};
for (const t of only.filter((q) => q.corridor)) {
  const ws = t.pts.map((p) => p.w);
  console.log(`${t.name} (${t.diff}) ${t.length.toFixed(0)} m, corridor ${Math.min(...ws).toFixed(1)}-${Math.max(...ws).toFixed(1)} m wide, ${t.cruxes.length} cruxes`);
  let s = 6;
  const transit = [];
  for (const c of t.cruxes) { transit.push([s, c.s0 - 9]); s = c.s1 + 9; }
  transit.push([s, t.length - 6]);
  let tt = 0; for (const [a, b] of transit) if (b > a) tt = Math.max(tt, strip(t, 'easy', a, b, 1.2)[0]);
  console.log(`  transit: tallest rock within 1.2 m of the line ${tt.toFixed(2)} m`);
  for (const c of t.cruxes) {
    const parts = c.lanes.map((ln) => {
      const [top] = strip(t, ln.name, c.s0, c.s1, 1.0), st = lineSteps(t, ln.name, c.s0 - 1, c.s1 + 1);
      return `${ln.name} rock ${top.toFixed(2)}${st.length ? ` steps ${st.map((v) => v.toFixed(2)).join('/')}` : ''}`;
    });
    console.log(`  ${c.name} (s ${c.s0}-${c.s1}, ${c.w} m, ${c.lanes.length} lines): ${parts.join(' | ')}`);
  }
}
for (const t of only.filter((q) => !q.corridor)) {
  const hw = t.width / 2;
  let maxRock = 0, at = '', over25 = 0, n = 0;
  for (let s = 6; s < t.length - 6; s += 0.5) {
    const p = pathPoint(t, s);
    for (let o = -hw + 0.3; o <= hw - 0.3; o += 0.25) {
      const r = surf(p.x - p.tz * o, p.z + p.tx * o); n++;
      if (r.kind !== 'rock') continue;
      if (r.up > 0.25) over25++;
      if (r.up > maxRock) { maxRock = r.up; at = `s=${s.toFixed(1)} lat=${o.toFixed(2)}`; }
    }
  }
  // ledge steps: the ledge's leading metre vs the ground 0.6 m before its face, with the
  // trail's own grade over that run taken out; lowest / centre / highest across the width
  const stepAt = (o) => {
    const out = new Map();
    for (let s = 4, inLedge = false, base = 0, peak = 0, s0 = 0; s < t.length - 4; s += 0.25) {
      const p = pathPoint(t, s), x = p.x - p.tz * o, z = p.z + p.tx * o, r = surf(x, z);
      if (r.kind === 'ledge') {
        if (!inLedge) { inLedge = true; s0 = s; const q = pathPoint(t, s - 0.6); base = heightAt(q.x - q.tz * o, q.z + q.tx * o); peak = -1e9; }
        if (s - s0 <= 1) peak = Math.max(peak, r.y - (p.h - pathPoint(t, s0 - 0.6).h));
        if (s - s0 === 1) out.set(Math.round(s0 / 6), [s0, peak - base]);
      } else inLedge = false;
    }
    return out;
  };
  const centre = stepAt(0), lanes = [];
  for (let o = -hw + 1; o <= hw - 1 + 1e-6; o += 0.5) lanes.push(stepAt(o));
  const steps = [...centre.values()].map(([s0, h], i) => {
    const k = Math.round(s0 / 6), all = lanes.map((m) => m.get(k)?.[1]).filter((v) => v !== undefined);
    return `${s0.toFixed(0)}:${Math.min(...all).toFixed(2)}/${h.toFixed(2)}/${Math.max(...all).toFixed(2)}`;
  });
  console.log(`${t.name} (${t.diff}) ${t.length.toFixed(0)} m: tallest in-corridor rock ${maxRock.toFixed(2)} m (${at}), ${(100 * over25 / n).toFixed(1)}% of corridor above 0.25 m`);
  console.log(`  ledge steps (s:low/centre/high) ${steps.join(' ') || 'none'}`);
}
