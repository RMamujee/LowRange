// Winch anchors: what a line may be hooked to, and which of them are on offer from where the truck is.
//
// Anchors (built once per map): fixed trees (the trunk, with a strap at TREE_H; not cacti or yuccas),
// big fixed rocks and boulders (at least ROCK_W across and ROCK_H tall; loose stones under
// DYNAMIC_MAX_WIDTH in src/physics_props.js, low embedded relief and trail ledge slabs are not anchors),
// and the map's recovery posts (src/winch/recovery_points.js).
//
// Candidates: anchors within the line's reach of the fairlead, in front of the truck (within FRONT
// of straight ahead, a front winch), whose line is clear: it may bend over one crest of ground or rock
// (src/winch/winch.js lineGeometry) but must not cut the ground again after that bend, and no trunk,
// rock or prop may stand across it (Rapier rays along both legs). Sorted by how well placed they are
// (near straight ahead, about IDEAL x the line length away), recovery posts first among equals; the
// player cycles through them.
import { DYNAMIC_MAX_WIDTH } from '../physics_props.js';
import { rockRecords } from './recovery_points.js';
import { lineGeometry, qrot } from './winch.js';

export const ANCHOR = {
  TREE_H: 0.6,        // strap height on a trunk (m)
  ROCK_W: 1.0,        // m across, at least
  ROCK_H: 0.6,        // m above the ground, at least
  ROCK_STRAP: 0.5,    // strap height on a rock, at most (m), and at most half its height
  FRONT: (80 * Math.PI) / 180, // widest angle off the nose
  MAX: 8,             // candidates offered at once
  MIN: 3,             // m: anything closer gives too little line to pull with
  TRY: 16,            // best-placed anchors checked per refresh (line of sight is ray casts)
  SPARE: 0.4,         // m of line kept in hand: an anchor must be this much inside the line's reach
  POST_BONUS: 3,      // m: recovery posts sort ahead of a tree or rock this much worse placed
  IDEAL: 0.55,        // best anchor distance, as a share of the line length
};
const NOT_TREES = new Set(['cactus', 'yucca']);

// opts: { rocks, trees, props (PropPhysics items), posts, heightAt }
export function buildAnchors({ rocks = [], trees = [], props = [], posts = [], heightAt }) {
  const out = [];
  for (const t of trees) {
    if (NOT_TREES.has(t.kind)) continue;
    out.push({ kind: 'tree', x: t.x, z: t.z, ground: t.y ?? heightAt(t.x, t.z), r: 0.22 * (t.s ?? 1), h: ANCHOR.TREE_H });
  }
  for (const r of rockRecords(rocks)) {
    if (r.embed || r.ledge || r.r * 2 < ANCHOR.ROCK_W || r.top - r.ground < ANCHOR.ROCK_H) continue;
    out.push({ kind: 'rock', x: r.x, z: r.z, ground: r.ground, r: r.r, h: Math.min(ANCHOR.ROCK_STRAP, (r.top - r.ground) * 0.5) });
  }
  for (const it of props) {
    if (it.dynamic || it.kind !== 'boulder') continue;
    const w = Math.max(it.halfExt[0], it.halfExt[2]) * 2, tall = it.halfExt[1] * 2;
    if (w < Math.max(ANCHOR.ROCK_W, DYNAMIC_MAX_WIDTH) || tall < ANCHOR.ROCK_H) continue;
    const g = heightAt(it.pos.x, it.pos.z);
    out.push({ kind: 'rock', x: it.pos.x, z: it.pos.z, ground: g, r: w / 2, h: Math.min(ANCHOR.ROCK_STRAP, tall * 0.5) });
  }
  for (const p of posts) out.push({ kind: 'post', x: p.x, z: p.z, ground: p.ground, r: 0.08, h: p.y - p.ground, id: p.id, name: p.name });
  out.forEach((a, i) => { a.i = i; });
  return out;
}

export class AnchorFinder {
  // R: RAPIER, world, probe: surfaceProbe(...), terrain: { ground } (its collider is not "in the way")
  constructor(anchors, { R, world, probe, terrain }) {
    this.anchors = anchors; this.R = R; this.world = world; this.probe = probe; this.terrain = terrain;
    this.cell = 16; this.grid = new Map();
    for (const a of anchors) { const k = this.key(Math.floor(a.x / this.cell), Math.floor(a.z / this.cell)); let l = this.grid.get(k); if (!l) this.grid.set(k, l = []); l.push(a); }
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  }
  key(i, j) { return i * 100003 + j; }
  near(x, z, r) {
    const out = [];
    for (let i = Math.floor((x - r) / this.cell); i <= Math.floor((x + r) / this.cell); i++) for (let j = Math.floor((z - r) / this.cell); j <= Math.floor((z + r) / this.cell); j++) for (const a of this.grid.get(this.key(i, j)) ?? []) out.push(a);
    return out;
  }

  // the world point the line is tied to: a strap round the trunk / rock on the side facing F, or the ring
  attach(a, F) {
    const dx = F.x - a.x, dz = F.z - a.z, d = Math.hypot(dx, dz) || 1;
    let k = a.kind === 'post' ? 0 : a.kind === 'rock' ? a.r * 0.75 : a.r;
    const y = a.ground + a.h;
    if (a.kind === 'rock') { // a rock is no disc: find its face towards the truck at strap height
      const ray = this.ray, ox = a.x + (dx / d) * (a.r + 1), oz = a.z + (dz / d) * (a.r + 1);
      ray.origin = { x: ox, y, z: oz }; ray.dir = { x: -dx / d, y: 0, z: -dz / d };
      const hit = this.world.castRay(ray, a.r + 1, true, this.R.QueryFilterFlags.EXCLUDE_DYNAMIC, 0xffff0001);
      if (hit && hit.collider.handle !== this.terrain.ground.handle) k = Math.max(0.1, a.r + 1 - hit.timeOfImpact + 0.04);
    }
    return { x: a.x + (dx / d) * k, y, z: a.z + (dz / d) * k, r: a.kind === 'post' ? 0.1 : a.r, kind: a.kind, anchor: a };
  }

  // does a straight leg from p to q hit a trunk, rock or prop (not the ground, not near its ends)?
  blocked(p, q, skip0, skip1) {
    const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z, L = Math.hypot(dx, dy, dz);
    if (L < skip0 + skip1 + 0.05) return false;
    const R = this.R, ray = this.ray;
    let from = skip0;
    while (from < L - skip1) {
      ray.origin = { x: p.x + (dx / L) * from, y: p.y + (dy / L) * from, z: p.z + (dz / L) * from };
      ray.dir = { x: dx / L, y: dy / L, z: dz / L };
      const hit = this.world.castRay(ray, L - skip1 - from, true, R.QueryFilterFlags.EXCLUDE_DYNAMIC, 0xffff0001);
      if (!hit) return false;
      if (hit.collider.handle !== this.terrain.ground.handle) return true;
      from += hit.timeOfImpact + 0.3; // grazing the ground (the crest test owns the ground): look on past it
    }
    return false;
  }

  // check one anchor from the fairlead F: returns the hook-up { A, geo, d } or null with a reason
  check(a, F, ws) {
    const A = this.attach(a, F);
    const ignore = (x, z) => Math.hypot(x - a.x, z - a.z) < a.r + 0.35;
    const geo = lineGeometry(F, A, this.probe, ignore);
    if (geo.d > ws.line - ANCHOR.SPARE) return { why: 'out of reach' };
    if (!geo.clear) return { why: 'ground in the way' };
    const end = a.r + 0.35;
    if (geo.P) { if (this.blocked(F, geo.P, 0.3, 0.4) || this.blocked(geo.P, A, 0.4, end)) return { why: 'blocked' }; }
    else if (this.blocked(F, A, 0.3, end)) return { why: 'blocked' };
    return { A, geo, d: geo.d };
  }

  // candidates in front of the truck, best first: [{ a, A, geo, d, ang }]
  candidates(car, ws, F) {
    const q = car.chassis.rotation(), fwd = qrot(q, { x: 0, y: 0, z: -1 });
    const fl = Math.hypot(fwd.x, fwd.z) || 1, fx = fwd.x / fl, fz = fwd.z / fl;
    const out = [];
    for (const a of this.near(F.x, F.z, ws.line)) {
      const dx = a.x - F.x, dz = a.z - F.z, dh = Math.hypot(dx, dz);
      if (dh > ws.line - ANCHOR.SPARE || dh < ANCHOR.MIN) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / dh)));
      if (ang > ANCHOR.FRONT) continue;
      // best: straight ahead, a good length of line out (more pull on the first layer, more travel per
      // hook-up, a flatter line), recovery posts first among equals
      out.push({ a, dh, ang, score: Math.abs(dh - ANCHOR.IDEAL * ws.line) + 16 * ang - (a.kind === 'post' ? ANCHOR.POST_BONUS : 0) });
    }
    out.sort((u, v) => u.score - v.score);
    const res = [];
    let tried = 0;
    for (const c of out) {
      if (res.length >= ANCHOR.MAX || tried++ >= ANCHOR.TRY) break; // each check casts up to ~100 rays
      const r = this.check(c.a, F, ws);
      if (r.A) res.push({ a: c.a, A: r.A, geo: r.geo, d: r.d, ang: c.ang });
    }
    return res;
  }
}
