// Keeps the Chase and Spotter cameras out of the scenery. The camera has no collider of its own,
// and the things it ends up inside mostly have none either: tree canopies (only the trunk is a
// physics cylinder) and sign boards / gate banners (no collider at all). Blockers checked:
//  - the visual ground (a hill between the truck and the camera),
//  - fixed physics colliders (rocks, trunks, barriers) by one Rapier ray, dynamic bodies ignored,
//  - trees from the tree list: trunk (solid) and canopy (soft, see below; sizes from src/art/props.js),
//  - every object tagged userData.camBlock (signposts, banners; src/art/signs.js) as its own
//    oriented box.
// main.js: chase(target, camera.position, want, dt) after its usual lerp clamps the camera's
// distance from the look-at point to a smoothed clear distance: it drops at once when something
// blocks the sight line (the camera never sits inside it) and grows back at GROW m/s, so a tree
// passing behind the truck gives one pull-in and a slow release, not a swoop in and out.
// Canopies only count from UNDER metres out: driving under (or right past) a tree its leaves are
// around the look-at point, the camera can't get in front of them, and a camera on the roof is
// worse than a few leaves in the picture, so it keeps its distance. Solid things always count.
// spot(...) picks a Spotter stand that is not in a tree or a sign.
import * as THREE from 'three';

const CELL = 8;     // spatial hash cell (m)
const STEP = 0.3;   // march step along the sight line (m); the boundary is then refined
const MIN_D = 2.2;  // never closer to the look-at point than this
const PAD = 0.45;   // stop this far short of a blocker
const UNDER = MIN_D + PAD; // leaves nearer than this along the sight line are ignored (see above)
const GROW = 1.5;   // m/s: how fast the clear distance comes back once the sight line is free
const NONE = 0, LEAVES = 1, SOLID = 2;

export class CamClear {
  constructor({ RAPIER, world, trees, scene, groundAt }) {
    this.R = RAPIER; this.world = world; this.groundAt = groundAt;
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this.cells = new Map();
    // canopy: round trees ~2.4 m radius from 2.2 m up, pines 1.9 m from 1.4 m, both up to ~6.5 m (scale 1)
    // (a map whose trees are shaped otherwise gives each one its own canopy at scale 1: { y1, y2, r1 })
    for (const t of trees) { const C = t.canopy; this.add(t.x, t.z, (C ? C.r1 + 0.3 : 2.6) * t.s, { cyl: true, x: t.x, z: t.z, y0: t.y - 0.5, y1: t.y + (C ? C.y1 : 1.3) * t.s, y2: t.y + (C ? C.y2 : 6.6) * t.s, r0: 0.45 * t.s, r1: (C ? C.r1 : 2.3) * t.s }); }
    scene.updateMatrixWorld(true);
    const m = new THREE.Matrix4(), bb = new THREE.Box3();
    scene.traverse((o) => {
      if (!o.userData.camBlock) return;
      const inv = o.matrixWorld.clone().invert(), box = new THREE.Box3();
      o.traverse((c) => { if (c.isMesh) { c.geometry.computeBoundingBox(); box.union(bb.copy(c.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(inv, c.matrixWorld))); } });
      if (box.isEmpty()) return;
      box.expandByScalar(0.3);
      const c = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld), r = box.getSize(new THREE.Vector3()).length() / 2 + 1;
      this.add(c.x, c.z, r, { inv, box });
    });
    this._p = new THREE.Vector3();
    this.S = null;                      // smoothed clear distance of the Chase camera (m)
    this.last = new THREE.Vector3();    // last look-at point, to spot teleports
  }

  add(x, z, r, b) {
    for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++)
      for (let k = Math.floor((z - r) / CELL); k <= Math.floor((z + r) / CELL); k++) {
        const key = i * 65536 + k;
        let l = this.cells.get(key); if (!l) this.cells.set(key, (l = []));
        l.push(b);
      }
  }

  // what is at a point: NONE, LEAVES (a canopy) or SOLID (ground, trunk, tagged box)
  hit(x, y, z) {
    if (y < this.groundAt(x, z) + 0.35) return SOLID;
    const l = this.cells.get(Math.floor(x / CELL) * 65536 + Math.floor(z / CELL));
    if (!l) return NONE;
    let h = NONE;
    for (const b of l) {
      if (b.cyl) {
        if (y < b.y0 || y > b.y2) continue;
        const r = Math.hypot(x - b.x, z - b.z);
        if (r < b.r0) return SOLID;
        if (y >= b.y1 && r < b.r1) h = LEAVES;
      } else if (b.box.containsPoint(this._p.set(x, y, z).applyMatrix4(b.inv))) return SOLID;
    }
    return h;
  }
  blocked(x, y, z) { return this.hit(x, y, z) !== NONE; }

  // along the sight line from -> to: distance to the first solid thing and to the first leaves
  // (L = the line's length when there are none), each refined to a few cm
  sight(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, L = Math.hypot(dx, dy, dz);
    if (L < 1e-3) return { L: 0, solid: 0, leaves: 0 };
    const ux = dx / L, uy = dy / L, uz = dz / L;
    const o = this.ray.origin, d = this.ray.dir;
    o.x = from.x; o.y = from.y; o.z = from.z; d.x = ux; d.y = uy; d.z = uz;
    const rh = this.world.castRay(this.ray, L, true, this.R.QueryFilterFlags.EXCLUDE_DYNAMIC, 0xffff0001);
    let solid = rh ? rh.timeOfImpact : L, leaves = L;
    const at = (s) => this.hit(from.x + ux * s, from.y + uy * s, from.z + uz * s);
    const edge = (a, b, lvl) => { for (let i = 0; i < 5; i++) { const m = (a + b) / 2; if (at(m) >= lvl) b = m; else a = m; } return b; };
    for (let s = 1, prev = 1; s < solid; prev = s, s += STEP) {
      const h = at(s);
      if (h === SOLID) { solid = s === 1 ? 1 : edge(prev, s, SOLID); if (leaves > solid) leaves = solid; break; }
      if (h === LEAVES && leaves === L) leaves = s === 1 ? 1 : edge(prev, s, LEAVES);
    }
    return { L, solid, leaves: Math.min(leaves, solid) };
  }

  // how far (m) from `from` towards `to` the sight line stays clear of everything
  clearDist(from, to) { const s = this.sight(from, to); return Math.min(s.solid, s.leaves); }

  // how far from the look-at point the camera may sit on the line towards `want`
  allowed(target, want) {
    const s = this.sight(target, want);
    const lim = s.leaves >= UNDER ? s.leaves : s.solid; // under a tree: ignore its leaves
    return lim >= s.L ? s.L : Math.min(s.L, Math.max(MIN_D, lim - PAD));
  }

  // Chase, after main.js has moved the camera: keep it within the smoothed clear distance of the
  // look-at point (drops at once, grows back at GROW m/s; resets on a teleport or a first frame)
  chase(target, cam, want, dt) {
    const a = this.allowed(target, want);
    const jump = this.S === null || !(dt > 0) || this.last.distanceTo(target) > 15;
    this.last.copy(target);
    this.S = jump || a < this.S ? a : Math.min(a, this.S + GROW * dt);
    const d = cam.distanceTo(target);
    if (d > this.S) cam.lerpVectors(target, cam, this.S / d);
    cam.y = Math.max(cam.y, this.groundAt(cam.x, cam.z) + 0.35); // MIN_D can leave it in a slope
    return cam;
  }

  // Spotter: the first stand (ahead of the truck, to one side) that is out of the scenery and can
  // see the truck; falls back to the preferred one pulled in towards the truck (not closer than
  // 3.5 m: main.js picks a new stand under 3 m, which would then happen every frame)
  spot(p, fwd, side, eyeY, target) {
    const tries = [[9, 3], [9, -3], [7, 4], [7, -4], [12, 2], [12, -2], [5, 5], [5, -5]];
    const s = new THREE.Vector3();
    for (const [a, b] of tries) {
      s.set(p.x, 0, p.z).addScaledVector(fwd, a).addScaledVector(side, b);
      s.y = this.groundAt(s.x, s.z) + eyeY;
      if (!this.blocked(s.x, s.y, s.z) && this.clearDist(target, s) >= s.distanceTo(target) - 0.05) return s;
    }
    s.set(p.x, 0, p.z).addScaledVector(fwd, 9).addScaledVector(side, 3);
    s.y = this.groundAt(s.x, s.z) + eyeY;
    const L = s.distanceTo(target), d = Math.max(MIN_D, this.clearDist(target, s) - PAD);
    return d >= L || d <= 3.5 ? s : s.clone().lerpVectors(target, s, d / L);
  }
}
