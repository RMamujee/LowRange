// Set dressing as real physics: only SMALL stones (fist to football size, under
// DYNAMIC_MAX_WIDTH across) are loose, dynamic Rapier bodies the tyres kick, fling and roll
// over; everything bigger (medium and large rocks), the trail-crew log edging and stumps are
// fixed, solid colliders. (Trail rocks/ledges, embedded rocks and trees are untouched: they live
// in maps/common.js buildTerrainPhysics and define trail difficulty.)
//
// Cost control: every prop is a cheap record; only those within `radius` of the truck get a
// body (created asleep, removed again once far away and at rest, keeping wherever it was
// pushed to), so hundreds of props cost nothing. Sleeping bodies are skipped by Rapier.
//
// The core (PropPhysics) is three.js-free so headless tests can use it. adoptDressing() binds
// it to the instanced dressing from src/art/dressing.js: it reads each stone/log/stump
// instance (same geometry, material, colour, transform), builds the matching hull, and moves
// that very instance while its body is awake, so the look is identical and nothing is drawn twice.
//
// vehicle.js reads terrain.propInfo (collider handle -> { mat, body, lowest(), arm() }) to
// treat a tyre on a loose prop as a two-body contact (see Vehicle.postPhysics).
import * as THREE from 'three';
import { MAT, GROUP_WORLD } from './maps/common.js';

const DENSITY = { rock: 2500, log: 600 };      // kg/m³: granite-ish, seasoned softwood
const FRICTION = { rock: 0.8, log: 0.6, boulder: 1.0, stump: 0.7 };
// stones wider than this are fixed boulders: a 0.4 m stone weighs ~25 kg, the most a tyre
// should bat about; anything bigger is a rock the truck climbs, not one it kicks
export const DYNAMIC_MAX_WIDTH = 0.4;

// world-space rotate p by unit quaternion q
function qrot(q, p) {
  const { x, y, z, w } = q;
  const ix = w * p.x + y * p.z - z * p.y, iy = w * p.y + z * p.x - x * p.z;
  const iz = w * p.z + x * p.y - y * p.x, iw = -x * p.x - y * p.y - z * p.z;
  return { x: ix * w + iw * -x + iy * -z - iz * -y, y: iy * w + iw * -y + iz * -x - ix * -z, z: iz * w + iw * -z + ix * -y - iy * -x };
}

export class PropPhysics {
  // terrain: the object from buildTerrainPhysics (gets .propInfo); heightAt: physics ground height
  constructor(RAPIER, world, terrain, { radius = 60, hysteresis = 12, maxActive = 300, heightAt = null } = {}) {
    this.R = RAPIER; this.world = world; this.terrain = terrain;
    this.radius = radius; this.hysteresis = hysteresis; this.maxActive = maxActive; this.heightAt = heightAt;
    this.items = [];
    this.active = [];
    this.flushers = [];
    this.lastScan = null;
    terrain.propInfo ||= new Map();
  }

  // it: { kind: 'rock'|'log'|'stump'|'boulder', pos {x,y,z}, rot {x,y,z,w}, pts: Float32Array of
  //       hull points in the body frame (metres), onPose?(pos, rot) }
  // Only 'rock' (a small stone) is dynamic; logs, stumps and boulders are fixed.
  add(it) {
    it.dynamic = it.kind === 'rock';
    it.mat = it.kind === 'log' || it.kind === 'stump' ? MAT.WOOD : MAT.ROCK;
    // local bounds: rough size, the long axis (logs) and the tipping arm (rocks)
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < it.pts.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], it.pts[i + k]); hi[k] = Math.max(hi[k], it.pts[i + k]); }
    const ext = [0, 1, 2].map((k) => (hi[k] - lo[k]) / 2);
    it.halfExt = ext;
    it.longAxis = ext[0] >= ext[2] ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
    it.halfLen = Math.max(ext[0], ext[2]);
    it.rockArm = 0.35 * Math.min(ext[0], ext[2]);
    it.body = null; it.settled = false;
    this.items.push(it);
    return it;
  }

  // Create/remove bodies around `center` (the truck). Cheap: rescans after moving 2 m.
  update(center) {
    if (this.lastScan && Math.hypot(center.x - this.lastScan.x, center.z - this.lastScan.z) < 2) return;
    this.lastScan = { x: center.x, z: center.z };
    const r2 = this.radius * this.radius, far = (this.radius + this.hysteresis) ** 2;
    const want = [];
    for (const it of this.items) {
      const dx = it.pos.x - center.x, dz = it.pos.z - center.z, d2 = dx * dx + dz * dz;
      if (it.body) {
        if (d2 > far && (!it.dynamic || it.body.isSleeping() || d2 > 4 * far)) this.deactivate(it);
      } else if (d2 < r2) want.push([d2, it]);
    }
    want.sort((a, b) => a[0] - b[0]);
    for (const [, it] of want) { if (this.active.length >= this.maxActive) break; this.activate(it); }
  }

  activate(it) {
    const { R, world } = this;
    if (!it.settled && this.heightAt) {
      // sit the lowest hull point on the physics ground (dressing is placed on the visual
      // ground, a few cm off in places), so a woken prop neither pops up nor drops
      let gap = Infinity;
      for (let i = 0; i < it.pts.length; i += 3) {
        const w = qrot(it.rot, { x: it.pts[i], y: it.pts[i + 1], z: it.pts[i + 2] });
        gap = Math.min(gap, it.pos.y + w.y - this.heightAt(it.pos.x + w.x, it.pos.z + w.z));
      }
      if (Number.isFinite(gap)) it.pos = { x: it.pos.x, y: it.pos.y - gap + 0.004, z: it.pos.z };
      it.settled = true;
      it.onPose?.(it.pos, it.rot);
    }
    const bd = (it.dynamic ? R.RigidBodyDesc.dynamic() : R.RigidBodyDesc.fixed())
      .setTranslation(it.pos.x, it.pos.y, it.pos.z).setRotation(it.rot);
    if (it.dynamic) {
      bd.setSleeping(true).setLinearDamping(0.05).setAngularDamping(it.kind === 'log' ? 0.5 : 0.3);
      // small fast stones are the ones that could tunnel through the heightfield
      if (Math.max(...it.halfExt) < 0.45) bd.setCcdEnabled(true);
    }
    const body = world.createRigidBody(bd);
    const cd = R.ColliderDesc.convexHull(it.pts) || R.ColliderDesc.ball(Math.max(0.05, Math.min(...it.halfExt)));
    cd.setFriction(FRICTION[it.kind]).setRestitution(0.05).setCollisionGroups(GROUP_WORLD);
    if (it.dynamic) cd.setDensity(DENSITY[it.kind]);
    const col = world.createCollider(cd, body);
    it.body = body; it.collider = col; it.awake = false;
    this.active.push(it);
    this.terrain.propInfo.set(col.handle, {
      mat: it.mat, kind: it.kind, body,
      // world point of the lowest hull vertex: where the prop rests on the ground
      lowest: () => {
        const t = body.translation(), q = body.rotation();
        let best = null;
        for (let i = 0; i < it.pts.length; i += 3) {
          const w = qrot(q, { x: it.pts[i], y: it.pts[i + 1], z: it.pts[i + 2] });
          if (!best || w.y < best.y) best = w;
        }
        return { x: t.x + best.x, y: t.y + best.y, z: t.z + best.z };
      },
      // lever arm (m) the resting prop's footprint gives against tipping about world axis u:
      // a log rolls freely about its long axis but not end over end; a stone sits on a base
      arm: (u) => {
        if (it.kind !== 'log') return it.rockArm;
        const L = qrot(body.rotation(), it.longAxis), c = u.x * L.x + u.y * L.y + u.z * L.z;
        return c * c * 0.015 + (1 - c * c) * it.halfLen * 0.8;
      },
    });
  }

  deactivate(it) {
    if (!it.body) return;
    const t = it.body.translation(), q = it.body.rotation();
    it.pos = { x: t.x, y: t.y, z: t.z }; it.rot = { x: q.x, y: q.y, z: q.z, w: q.w };
    it.onPose?.(it.pos, it.rot);
    this.terrain.propInfo.delete(it.collider.handle);
    this.world.removeRigidBody(it.body);
    it.body = null; it.collider = null;
    this.active.splice(this.active.indexOf(it), 1);
  }

  // Push awake bodies' poses to their visuals; returns how many are awake.
  sync() {
    let awake = 0;
    for (const it of this.active) {
      if (!it.dynamic) continue;
      const b = it.body;
      const sleeping = b.isSleeping();
      if (sleeping && !it.awake) continue;
      it.awake = !sleeping;
      if (!sleeping) awake++;
      let t = b.translation();
      // safety net: anything that ends up under the ground or flying off is put back gently
      const lv = b.linvel(), sp = Math.hypot(lv.x, lv.y, lv.z);
      if (sp > 40) b.setLinvel({ x: lv.x * 40 / sp, y: lv.y * 40 / sp, z: lv.z * 40 / sp }, true);
      if (this.heightAt && t.y < this.heightAt(t.x, t.z) - 1.5) {
        b.setTranslation({ x: t.x, y: this.heightAt(t.x, t.z) + it.halfExt[1] * 2 + 0.2, z: t.z }, true);
        b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
        t = b.translation();
      }
      it.onPose?.(t, b.rotation());
    }
    for (const f of this.flushers) f();
    return awake;
  }

  stats() {
    let awake = 0;
    for (const it of this.active) if (it.dynamic && !it.body.isSleeping()) awake++;
    return { total: this.items.length, active: this.active.length, awake };
  }
}

// ---------- binding to the instanced dressing (three.js) ----------
const HULL_DIRS = (() => { // ~64 evenly spread directions (Fibonacci sphere)
  const d = [], n = 64, ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) { const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y); d.push([Math.cos(ga * i) * r, y, Math.sin(ga * i) * r]); }
  return d;
})();
const hullCache = new Map(); // geometry uuid list -> support points (unscaled)
// support points of a set of geometries: the extreme vertex along each direction, deduped.
// An inner approximation of their convex hull with <= 64 points (glTF rocks have ~800 verts).
function supportPoints(geos) {
  const key = geos.map((g) => g.uuid).join();
  if (hullCache.has(key)) return hullCache.get(key);
  const best = HULL_DIRS.map(() => [-Infinity, 0, 0, 0]);
  for (const g of geos) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      HULL_DIRS.forEach((d, k) => { const s = d[0] * x + d[1] * y + d[2] * z; if (s > best[k][0]) best[k] = [s, x, y, z]; });
    }
  }
  const seen = new Set(), out = [];
  for (const [, x, y, z] of best) { const k = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`; if (!seen.has(k)) { seen.add(k); out.push(x, y, z); } }
  hullCache.set(key, out);
  return out;
}

// Take over the stones / logs / stumps of a dressing root (src/art/dressing.js
// buildSetDressing). Returns the number of props registered.
export function adoptDressing(root, props) {
  if (!root) return 0;
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const dirty = new Set();
  let n = 0;
  for (const group of root.children) {
    const kind0 = { stones: 'stone', logs: 'log', stumps: 'stump' }[group.name];
    if (!kind0) continue;
    // one InstancedMesh per template part per chunk; the parts of one prop share its matrix
    const items = new Map();
    for (const im of group.children) {
      if (!im.isInstancedMesh) continue;
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m);
        const e = m.elements, key = `${e[12].toFixed(3)},${e[13].toFixed(3)},${e[14].toFixed(3)}`;
        let it = items.get(key);
        if (!it) items.set(key, it = { matrix: m.clone(), refs: [], geos: [] });
        it.refs.push([im, i]);
        if (!it.geos.includes(im.geometry)) it.geos.push(im.geometry);
      }
    }
    for (const it of items.values()) {
      it.matrix.decompose(p, q, s);
      const base = supportPoints(it.geos);
      const pts = new Float32Array(base.length);
      for (let i = 0; i < base.length; i += 3) { pts[i] = base[i] * s.x; pts[i + 1] = base[i + 1] * s.y; pts[i + 2] = base[i + 2] * s.z; }
      let w = 0;
      for (let i = 0; i < pts.length; i += 3) w = Math.max(w, Math.hypot(pts[i], pts[i + 2]) * 2);
      const kind = kind0 === 'stone' ? (w < DYNAMIC_MAX_WIDTH ? 'rock' : 'boulder') : kind0;
      const scl = s.clone(), refs = it.refs;
      const tp = new THREE.Vector3(), tq = new THREE.Quaternion(), tm = new THREE.Matrix4();
      props.add({
        kind, pts, pos: { x: p.x, y: p.y, z: p.z }, rot: { x: q.x, y: q.y, z: q.z, w: q.w },
        onPose: (t, r) => {
          tm.compose(tp.set(t.x, t.y, t.z), tq.set(r.x, r.y, r.z, r.w), scl);
          for (const [im, i] of refs) { im.setMatrixAt(i, tm); dirty.add(im); }
        },
      });
      n++;
    }
  }
  props.flushers.push(() => {
    for (const im of dirty) { im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); }
    dirty.clear();
  });
  return n;
}
