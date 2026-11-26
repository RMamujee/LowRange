// Crash model: turns contacts on the chassis / axles into absorbed energy, body deformation
// (a free-form-deformation cage, lattice.js) and mechanical consequences that depend on where
// the hit landed. Plain JS on the physics side (no three.js): the view samples the cage.
//
// Energy measure. For every step with a contact on a body collider, the work the contact did
// against the vehicle is  W = J_n * v_close,  where J_n is the normal impulse of the step (from
// Rapier's contact-force event) and v_close the closing speed of the contact point along the
// push direction, averaged over the step (pre-step velocity snapshot and post-step velocity;
// the other body's velocity is subtracted, so a rolling log is hit at the relative speed).
// Contacts with one obstacle are grouped into an impact event that stays open while contact
// lasts (a window, not a single-step peak); the event's energy per kg of vehicle is the measure:
// e = 0.5 v^2 for a full stop, so 10 km/h = 3.9 J/kg, 30 = 35, 60 = 139.
//  - resting / sliding contact does no normal work (v_close ~ 0) -> no damage. Sliding instead
//    accrues scrape work mu * J_n * v_slide (scuffs, mirrors), reported separately.
//  - a light loose prop can't take a big impulse, so it can't absorb much energy either.
//  - the first E_ELASTIC J/kg of each event is soaked up elastically (bumpers, tyres, mounts).
// Plastic energy becomes crush depth by a stiffness per body zone: d = sqrt(d0^2 + e / kappa),
// d0 the crush already there (a crumpled zone densifies: the next hit dents it less).

import { DeformLattice } from './lattice.js';

export const E_ELASTIC = 4.0;  // (a full stop from 9 km/h)   // J/kg absorbed without permanent damage per impact event
export const V_DAMAGE = 3.0;    // m/s: an event that never closed faster than this does no damage (11 km/h)
const EVENT_GAP = 0.06;         // s without contact that closes an impact event
const EVENT_MAX = 0.35;         // s: a longer contact (a slide, a roll) is split into new events
const EVENT_MOVE = 0.55;        // m the contact may wander before a new event starts (rolling)
const NAMES = ['front-left', 'front-right', 'rear-left', 'rear-right'];

// Per-rig body layout (chassis-local, -Z forward, +Y up; metres). cab: cabin z span; belt: top
// of the doors; roof: roof skin height; front / rear: nose and tail of the art (the collider
// boxes don't match the art exactly: a hit is placed on the art's surface, see progress()). parts: pieces of the glTF Body that can tear off, as boxes
// that fully contain them (the view assigns every mesh island inside a box to that part).
//   limit: cage crush (m) inside the box that rips it off; hit: plastic J/kg of a single event
//   landing on it that knocks it off; scrape: scrape J/kg that knocks it off (mirrors).
const MIRROR = (s, x0, x1, y0, y1, z0, z1) => ({ id: s < 0 ? 'mirrorL' : 'mirrorR', name: (s < 0 ? 'left' : 'right') + ' mirror', lo: [s < 0 ? -x1 : x0, y0, z0], hi: [s < 0 ? -x0 : x1, y1, z1], limit: 0.09, hit: 0.6, scrape: 2.5, mass: 2 });
export const BODY_LAYOUT = {
  taco: {
    cab: [-1.12, 0.95], belt: 0.64, roof: 1.3, front: -2.62, rear: 2.73,
    parts: [
      { id: 'bumperF', name: 'front bumper', lo: [-0.92, -0.3, -2.72], hi: [0.92, 0.3, -2.3], limit: 0.3, hit: 60, mass: 30 },
      { id: 'bumperR', name: 'rear bumper', lo: [-0.95, -0.35, 2.5], hi: [0.95, 0.05, 2.85], limit: 0.26, hit: 45, mass: 22 },
      MIRROR(-1, 0.78, 1.1, 0.6, 1.0, -1.05, -0.7), MIRROR(1, 0.78, 1.1, 0.6, 1.0, -1.05, -0.7),
      { id: 'spare', name: 'spare wheel', lo: [-0.45, 0.1, 0.8], hi: [0.05, 1.2, 1.85], limit: 0.22, hit: 30, mass: 28 },
    ],
  },
  lc70: {
    cab: [-0.95, 1.9], belt: 0.66, roof: 1.28, front: -2.45, rear: 2.43, // (the cargo bay behind the rear doors crumples)
    parts: [
      { id: 'bumperF', name: 'front bumper', lo: [-1.05, -0.36, -2.5], hi: [1.05, 0.0, -1.98], limit: 0.3, hit: 60, mass: 32 },
      { id: 'bumperR', name: 'rear bumper', lo: [-1.05, -0.32, 1.95], hi: [1.05, 0.0, 2.45], limit: 0.26, hit: 45, mass: 26 },
      MIRROR(-1, 0.8, 1.15, 0.65, 1.0, -0.75, -0.45), MIRROR(1, 0.8, 1.15, 0.65, 1.0, -0.75, -0.45),
      { id: 'spare', name: 'spare wheel', lo: [-0.2, 0.0, 2.15], hi: [0.8, 0.95, 2.5], limit: 0.2, hit: 30, mass: 28 },
      { id: 'rack', name: 'roof rack', lo: [-0.85, 1.36, -0.75], hi: [0.85, 1.52, 2.25], limit: 0.2, hit: 20, mass: 18 },
    ],
  },
  wrx: {
    cab: [-1.05, 1.5], belt: 0.4, roof: 0.9, front: -2.34, rear: 2.2,
    parts: [
      MIRROR(-1, 0.74, 1.0, 0.35, 0.6, -0.95, -0.65), MIRROR(1, 0.74, 1.0, 0.35, 0.6, -0.95, -0.65),
      { id: 'wing', name: 'rear wing', lo: [-0.8, 0.4, 1.65], hi: [0.8, 0.95, 2.2], limit: 0.14, hit: 12, mass: 8 },
      { id: 'lip', name: 'front lip', lo: [-0.75, -0.42, -2.3], hi: [0.75, -0.34, -2.05], limit: 0.14, hit: 25, mass: 4 },
      { id: 'lampL', name: 'left driving lamp', lo: [-0.6, -0.36, -2.42], hi: [-0.2, -0.02, -2.2], limit: 0.12, hit: 25, mass: 3 },
      { id: 'lampR', name: 'right driving lamp', lo: [0.2, -0.36, -2.42], hi: [0.6, -0.02, -2.2], limit: 0.12, hit: 25, mass: 3 },
    ],
  },
};

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const V = (x, y, z) => ({ x, y, z });

function qrot(q, p) {
  const { x, y, z, w } = q;
  const ix = w * p.x + y * p.z - z * p.y, iy = w * p.y + z * p.x - x * p.z;
  const iz = w * p.z + x * p.y - y * p.x, iw = -x * p.x - y * p.y - z * p.z;
  return V(ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x);
}
const qinv = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

export class CrashModel {
  constructor(vehicle) {
    this.v = vehicle;
    const spec = vehicle.spec;
    const [cw, ch, cl] = spec.chassis.size;
    this.cw = cw; this.ch = ch; this.cl = cl;
    const lay = BODY_LAYOUT[spec.body] || {
      cab: spec.body === 'truck' ? [-cl / 2, -cl / 2 + 2] : [-0.9, 1.0], belt: ch / 2 + 0.35, roof: ch / 2 + 1.1, parts: [],
    };
    this.layout = lay;
    this.parts = lay.parts.map((p) => ({ ...p, detached: false }));
    // cage around the body: generous bounds (bumpers, mirrors, roof racks stick out of the colliders)
    const xh = Math.max(cw / 2, spec.track / 2 + spec.tire.width / 2) + 0.3;
    const min = V(-xh, Math.min(-ch / 2, spec.axleY - spec.tire.radius * 0.5) - 0.3, -cl / 2 - 0.5);
    const max = V(xh, lay.roof + 0.4, cl / 2 + 0.5);
    const [c0, c1] = lay.cab, belt = lay.belt, roof = lay.roof;
    // how far a node may travel: crumple zones front/rear (more the further out), a stiff cabin
    // shell, a roof that can come down towards the beltline
    const cap = (x, y, z) => {
      if (z < c0) return Math.min(0.7, 0.14 + (c0 - z) * 0.42);
      if (z > c1) return Math.min(0.55, 0.12 + (z - c1) * 0.4);
      if (y > belt) return Math.min(0.42, 0.16 + 0.32 * (y - belt) / Math.max(0.2, roof - belt));
      return 0.3;
    };
    this.lattice = new DeformLattice(min, max, 0.2, cap);
    this.lattice.centre = V(0, (belt - ch / 2) / 2, 0);
    this.events = new Map();
    this.fx = [];           // crash effects for main.js: { p (world), n (world), e (J/kg), kind, glass }
    this.shake = 0;         // camera shake, 0..1, decays
    this.plastic = 0;       // total plastic energy absorbed (J/kg): drives health.body
    this.scrape = 0;        // total scrape work (J/kg)
    this.time = 0;
    this.lastHit = null;    // last impact event summary (for tests / debugging)
    this.peak = { e: 0, frameMs: 0 };
    this.debris = [];       // detached parts as rigid bodies: { part, body }
    this.mech = this.freshMech();
    this.boxes = null;
    this.flags = new Set(); // one-shot messages already shown
  }

  freshMech() {
    return {
      radiator: 1, coolant: 1, temp: 0,  // temp: 0 normal .. 1 overheating
      oilPan: 1, oil: 1,
      diff: [1, 1], driveshaft: [1, 1], driveLost: [false, false],
      wheelDrag: [0, 0, 0, 0], // N·m of drag from a fender crushed onto the tyre
      bend: [0, 0, 0, 0],      // bent wheel / hub (0..1): wobble, then failure
      crush: { front: 0, rear: 0, roof: 0, left: 0, right: 0, radiator: 0, engine: 0 },
    };
  }

  // Full repair in place: cage, parts, mechanicals (the vehicle resets health / wheels itself).
  repair() {
    this.lattice.reset();
    for (const p of this.parts) p.detached = false;
    this.removeDebris();
    this.events.clear();
    this.mech = this.freshMech();
    this.plastic = 0; this.scrape = 0; this.shake = 0; this.fx.length = 0; this.flags.clear();
    this.lastHit = null;
    if (this.boxes) this.applyColliders();
  }

  removeDebris() {
    for (const d of this.debris) if (d.body) { try { this.v.world.removeRigidBody(d.body); } catch { /* already gone */ } d.body = null; }
    this.debris.length = 0;
  }

  // vehicle.build(): the chassis boxes (for collider crush) — the cage and damage survive a rebuild
  onBuild(boxes) {
    this.boxes = boxes;
    this.events.clear();
    this.applyColliders();
  }

  // pre-step velocity snapshot of the bodies that carry damage colliders
  snapshot(bodies) {
    this.pre = new Map();
    for (const b of bodies) {
      if (!b) continue;
      const lv = b.linvel(), av = b.angvel(), c = b.worldCom();
      this.pre.set(b.handle, { lv: V(lv.x, lv.y, lv.z), av: V(av.x, av.y, av.z), c: V(c.x, c.y, c.z) });
    }
  }

  // One contact-force event on a damage collider. part: 'body' | 'axle0' | 'axle1';
  // body: the vehicle rigid body; col / other: colliders; F: force on the vehicle (world), h: step.
  contact(part, body, col, other, F, h) {
    const mag = Math.hypot(F.x, F.y, F.z);
    if (mag < 1) return;
    const n = V(F.x / mag, F.y / mag, F.z / mag); // push direction (into the vehicle)
    const J = mag * h;
    // contact points from the manifold (world space)
    const pts = [];
    this.v.world.contactPair(col, other, (m) => {
      for (let i = 0; i < m.numSolverContacts(); i++) { const p = m.solverContactPoint(i); if (p) pts.push(V(p.x, p.y, p.z)); }
    });
    let p;
    if (pts.length) {
      p = V(0, 0, 0);
      for (const q of pts) { p.x += q.x / pts.length; p.y += q.y / pts.length; p.z += q.z / pts.length; }
    } else { // no solver contact left after the step: the collider's surface point against the push
      const t = col.translation();
      p = V(t.x - n.x * 0.5, t.y - n.y * 0.5, t.z - n.z * 0.5);
    }
    let spread = 0;
    for (const q of pts) spread = Math.max(spread, Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z));
    // closing speed at the contact, averaged over the step, relative to the other body. A diff
    // strike is measured on the chassis above it: the light axle is stopped at once, the truck
    // then lands on it through the bump stops (that's what cracks a diff housing).
    if (part !== 'body') body = this.v.chassis;
    const pre = this.pre && this.pre.get(body.handle);
    const post = body.velocityAtPoint(p);
    let vx = post.x, vy = post.y, vz = post.z;
    if (pre) {
      const r = V(p.x - pre.c.x, p.y - pre.c.y, p.z - pre.c.z), w = pre.av;
      vx = (vx + pre.lv.x + w.y * r.z - w.z * r.y) / 2;
      vy = (vy + pre.lv.y + w.z * r.x - w.x * r.z) / 2;
      vz = (vz + pre.lv.z + w.x * r.y - w.y * r.x) / 2;
    }
    const ob = other.parent();
    let oMass = Infinity;
    if (ob && ob.isDynamic()) { const ov = ob.velocityAtPoint(p); vx -= ov.x; vy -= ov.y; vz -= ov.z; oMass = ob.mass(); }
    const vn = -(vx * n.x + vy * n.y + vz * n.z); // > 0: closing
    const vt = Math.hypot(vx + vn * n.x, vy + vn * n.y, vz + vn * n.z);
    const W = J * Math.max(0, vn);
    const Ws = 0.5 * J * vt;
    // obstacle footprint: round things (tree trunks, posts) are narrow, the rest is broad
    let radius = null, axis = null;
    const R = this.v.R, st = other.shapeType();
    if (st === R.ShapeType.Cylinder || st === R.ShapeType.Ball || st === R.ShapeType.Capsule || st === R.ShapeType.RoundCylinder) radius = other.radius();
    if (st !== R.ShapeType.Ball && radius !== null) axis = qrot(other.rotation(), V(0, 1, 0)); // a trunk / post: its long axis
    const prop = this.v.terrain.propInfo && this.v.terrain.propInfo.get(other.handle);
    const key = part + ':' + other.handle;
    // chassis-local contact point and push direction (the cage lives in chassis space)
    const cb = this.v.chassis, cq = cb.rotation(), ct = cb.translation(), iq = qinv(cq);
    const lp = qrot(iq, V(p.x - ct.x, p.y - ct.y, p.z - ct.z)), ln = qrot(iq, n);
    const la = axis ? qrot(iq, axis) : null;
    let ev = this.events.get(key);
    if (ev && (this.time - ev.t0 > EVENT_MAX || Math.hypot(lp.x - ev.anchor.x, lp.y - ev.anchor.y, lp.z - ev.anchor.z) > EVENT_MOVE)) {
      this.closeEvent(key, ev); ev = null;
    }
    if (!ev) {
      ev = { part, t0: this.time, tl: this.time, E: 0, Es: 0, J: 0, p: V(0, 0, 0), n: V(0, 0, 0), anchor: lp, spread: 0, radius, oMass,
        prop: !!prop, rock: this.v.terrain.rockHandles.has(other.handle), applied: 0, d0: null, pw: p, nw: n, axis: la };
      this.events.set(key, ev);
    }
    ev.tl = this.time;
    ev.E += W; ev.Es += Ws; ev.J += J;
    ev.vmax = Math.max(ev.vmax || 0, vn);
    // impulse-weighted contact point / direction, energy-weighted when there is energy
    const wgt = J * (0.05 + Math.max(0, vn));
    ev.p.x += lp.x * wgt; ev.p.y += lp.y * wgt; ev.p.z += lp.z * wgt; ev.wsum = (ev.wsum || 0) + wgt;
    ev.n.x += ln.x * wgt; ev.n.y += ln.y * wgt; ev.n.z += ln.z * wgt;
    ev.spread = Math.max(ev.spread, spread);
    ev.pw = p; ev.nw = n;
    ev.dirty = true;
  }

  // After the step's contacts: progress open events (deformation grows as energy comes in),
  // close stale ones, advance the slow mechanical processes.
  endStep(h) {
    this.time += h;
    let t0 = 0;
    for (const [key, ev] of this.events) {
      if (ev.dirty) { if (!t0) t0 = now(); this.progress(ev, false); ev.dirty = false; }
      if (this.time - ev.tl > EVENT_GAP) this.closeEvent(key, ev);
    }
    if (t0) this.peak.frameMs = Math.max(this.peak.frameMs, now() - t0);
    this.shake *= Math.exp(-h * 5);
    if (this.fx.length > 48) this.fx.splice(0, this.fx.length - 48); // nobody draining (menu up)
    this.mechStep(h);
  }

  closeEvent(key, ev) {
    this.progress(ev, true);
    this.events.delete(key);
    if (globalThis.CRASH_DEBUG && this.lastHit && !this.lastHit.logged) {
      const h = this.lastHit; h.logged = true;
      const f = (q) => `${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)}`;
      console.log(`    [crash] ${h.kind} ${ev.part} e ${h.e.toFixed(1)} plastic ${h.plastic.toFixed(1)} scrape ${h.scrape.toFixed(1)} J/kg dur ${(h.dur * 1000).toFixed(0)} ms at ${f(h.p)} push ${f(h.n)} r ${ev.radius ?? '-'} spread ${ev.spread.toFixed(2)}`);
    }
  }

  // Event energy -> plastic energy -> crush depth -> cage intrusion (+ consequences).
  progress(ev, final) {
    const M = this.v.mass;
    let e = ev.E / M;
    const es = ev.Es / M;
    const ar = this.v.spec.armour;
    const w = ev.wsum || 1;
    const p = V(ev.p.x / w, ev.p.y / w, ev.p.z / w);
    let n = V(ev.n.x, ev.n.y, ev.n.z);
    const nl = Math.hypot(n.x, n.y, n.z) || 1; n = V(n.x / nl, n.y / nl, n.z / nl);
    // a collider face standing proud of the art (the wagon's cab box includes its roof rack):
    // the crush starts at the art's skin
    const Ly = this.layout;
    if (n.y < -0.6 && p.y > Ly.roof) p.y = Ly.roof;
    if (Ly.front !== undefined && n.z > 0.6 && p.z < Ly.front) p.z = Ly.front;
    if (Ly.rear !== undefined && n.z < -0.6 && p.z > Ly.rear) p.z = Ly.rear;
    // The greenhouse (pillars, roof rails) also folds under the friction load of sliding on the
    // ground: in a roll, part of the scrape work above the beltline goes into crush. Below the
    // belt (doors, sills, belly) sliding only scuffs.
    if (p.y > Ly.belt) e += 0.35 * es;
    if (ar) e *= n.y > 0.6 ? ar.under : Math.abs(n.x) > Math.abs(n.z) ? ar.side : ar.end;
    // slow contact (crawling into a rock, resting, sliding) never deforms anything
    const plastic = (ev.vmax || 0) < V_DAMAGE && !(p.y > Ly.belt && es > 12) ? 0 : Math.max(0, e - E_ELASTIC);
    if (final) {
      this.scrape += es;
      if (e > 0.5 || es > 0.5) this.lastHit = { e, plastic, scrape: es, p, n, part: ev.part, dur: this.time - ev.t0, kind: classify(ev, e, es, this.time) };
      this.partHits(ev, p, plastic, es);
      // belly slammed onto a rock at speed: the oil pan takes it long before the panels dent
      if (ev.part === 'body' && n.y > 0.7 && p.y < 0 && (ev.vmax || 0) >= V_DAMAGE) this.bellyHit(p, Math.max(0, e - 3));
    }
    // re-deform as energy comes in (progressive crumple), but not every substep: every ~15% more
    if (!final && plastic < ev.applied * 1.15 + 0.5) return;
    if (plastic <= ev.applied) return;
    const dPl = plastic - ev.applied;
    ev.applied = plastic;
    this.plastic += dPl;
    this.v.health.body = Math.max(0, 1 - this.plastic / 120);
    if (ev.part !== 'body') { this.axleHit(ev, dPl); return; }
    // zone stiffness at the hit (J/kg per m^2 of crush): crumple zones soft, cabin stiff, belly stiffest
    const L = this.layout;
    let kappa;
    if (n.y > 0.7 && p.y < 0) kappa = 2600;                    // from below: belly / frame
    else if (n.y < -0.6) kappa = p.z > L.cab[0] && p.z < L.cab[1] ? 320 : 450; // roof / from above (roofs are weak)
    else if (p.z < L.cab[0] || p.z > L.cab[1]) kappa = Math.abs(n.z) > 0.6 ? 300 : 450; // front / rear ends, fenders
    else kappa = 480;                                           // cabin sides (door beams, pillars)
    const cage = this.lattice;
    if (ev.d0 === null) ev.d0 = cage.crushAlong(p, n, 0.35);
    const depth = Math.sqrt(ev.d0 * ev.d0 + plastic / kappa);
    // footprint: tree / pole radius, else the manifold spread (a wall flattens the whole face)
    const core = ev.radius !== null ? Math.max(0.12, ev.radius * 0.9) : Math.min(1.1, 0.25 + ev.spread * 0.9);
    const edge = 0.3 + depth * 0.9;
    // a trunk's axis, made perpendicular to the push (the band runs along the trunk)
    let ax = ev.axis;
    if (ax) { const a = ax.x * n.x + ax.y * n.y + ax.z * n.z; ax = V(ax.x - a * n.x, ax.y - a * n.y, ax.z - a * n.z); const l = Math.hypot(ax.x, ax.y, ax.z); ax = l > 0.3 ? V(ax.x / l, ax.y / l, ax.z / l) : null; }
    cage.intrude(p, n, depth, core, edge, ax);
    if (this.v.dents.length < 200) this.v.dents.push({ p, n, amount: depth, applied: true }); // a log of dents (the cage already has them)
    this.shake = Math.min(1, this.shake + Math.min(0.6, dPl / 40));
    const cq = this.v.chassis.rotation(), ct = this.v.chassis.translation();
    const pw = qrot(cq, p);
    this.fx.push({ p: V(pw.x + ct.x, pw.y + ct.y, pw.z + ct.z), n: ev.nw, e: dPl, kind: classify(ev, plastic, es, this.time) });
    if (this.fx.length > 32) this.fx.shift();
    this.cornerHits(p, n, dPl);
    // a frontal hit on the nose drives the radiator / fan / block back: direct engine damage
    if (n.z > 0.5 && p.z < L.cab[0]) this.v.setEngineHealth(this.v.health.engine - dPl * 0.0105, 'crush');
    this.updateMech();
  }

  // a body hit near a wheel bends that corner (suspension arm / steering), graded by energy
  cornerHits(p, n, dPl) {
    const s = this.v.spec;
    for (let i = 0; i < 4; i++) {
      const wx = (i % 2 ? 1 : -1) * s.track / 2, wz = i < 2 ? -s.wheelbase / 2 : s.wheelbase / 2;
      const dz = Math.abs(p.z - wz), dx = Math.abs(p.x - wx);
      if (dz > 1.1 || dx > 1.2) continue;
      // the corner is loaded when the push comes from that side or that end
      const side = (i % 2 ? -1 : 1) * n.x, end = (i < 2 ? 1 : -1) * n.z;
      const load = Math.max(side, end * 0.7, 0) * (1 - dz / 1.1);
      if (load > 0.05) this.v.damageWheel(i, dPl * load * 0.024, 0, dPl * load > 25);
    }
  }

  // a huge landing drives the tyre up into its wheel well: the arch / inner fender buckles a bit
  archPunch(i, amount) {
    const s = this.v.spec;
    const wx = (i % 2 ? 1 : -1) * s.track / 2, wz = i < 2 ? -s.wheelbase / 2 : s.wheelbase / 2;
    const p = V(wx, s.axleY + s.tire.radius + 0.06, wz);
    const cur = this.lattice.crushAlong(p, V(0, 1, 0), 0.25);
    this.lattice.intrude(p, V(0, 1, 0), Math.min(0.1, cur + amount), 0.22, 0.3);
    this.updateMech();
  }

  // diff pumpkin / axle tube strikes: diff damage, then no drive to that axle
  axleHit(ev, dPl) {
    const a = ev.part === 'axle0' ? 0 : 1, m = this.mech;
    const before = m.diff[a];
    m.diff[a] = Math.max(0, m.diff[a] - dPl * 0.04);
    if (before >= 0.5 && m.diff[a] < 0.5) this.v.damageEvents.push(`${a ? 'Rear' : 'Front'} diff cracked: it whines and leaks`);
    if (m.diff[a] <= 0.15 && !m.driveLost[a]) { m.driveLost[a] = true; this.v.damageEvents.push(`${a ? 'Rear' : 'Front'} diff smashed: no drive to the ${a ? 'rear' : 'front'} axle`); this.v.syncDriveline(); }
    this.shake = Math.min(1, this.shake + Math.min(0.4, dPl / 50));
  }

  // detachable parts hit directly or crushed past their limit
  partHits(ev, p, plastic, es) {
    for (const part of this.parts) {
      if (part.detached) continue;
      const inside = p.x > part.lo[0] - 0.3 && p.x < part.hi[0] + 0.3 && p.y > part.lo[1] - 0.3 && p.y < part.hi[1] + 0.3 && p.z > part.lo[2] - 0.3 && p.z < part.hi[2] + 0.3;
      if (inside && (plastic > part.hit || (part.scrape && es > part.scrape))) this.detach(part, ev.nw);
    }
  }

  // Derive zone crush from the cage and map it onto mechanical damage.
  updateMech() {
    const c = this.lattice, s = this.v.spec, L = this.layout, m = this.mech, h = this.v.health;
    const cw = this.cw, ch = this.ch, cl = this.cl;
    const zF = -cl / 2, zR = cl / 2;
    const cr = m.crush;
    // (sampled from the field inside the body shell: what the panels there actually got)
    const B = (x0, y0, z0, x1, y1, z1, dir) => c.sampleBox(V(x0, y0, z0), V(x1, y1, z1), dir);
    const top = Math.min(L.cab[1], L.cab[0] + 2.2);
    cr.front = B(-cw / 2 + 0.1, -ch / 2 + 0.05, zF + 0.1, cw / 2 - 0.1, L.belt - 0.05, L.cab[0]).max;
    cr.rear = B(-cw / 2 + 0.1, -ch / 2 + 0.05, L.cab[1], cw / 2 - 0.1, L.belt - 0.05, zR + 0.2).max;
    cr.roof = B(-cw * 0.35, L.roof - 0.12, L.cab[0] + 0.25, cw * 0.35, L.roof - 0.02, top, V(0, -1, 0)).mean;
    cr.left = B(-cw / 2 + 0.02, -ch / 2 + 0.1, L.cab[0], -cw / 2 + 0.12, L.belt - 0.05, L.cab[1], V(1, 0, 0)).max;
    cr.right = B(cw / 2 - 0.12, -ch / 2 + 0.1, L.cab[0], cw / 2 - 0.02, L.belt - 0.05, L.cab[1], V(-1, 0, 0)).max;
    // radiator right behind the nose, engine block further back between the frame rails
    const front = zF + 0.15;
    cr.radiator = B(-cw * 0.3, -0.1, front, cw * 0.3, L.belt - 0.1, front + 0.3, V(0, 0, 1)).mean;
    cr.engine = B(-cw * 0.25, -0.1, front + 0.35, cw * 0.25, L.belt - 0.1, front + 0.8, V(0, 0, 1)).mean;
    const rad = 1 - smooth(0.03, 0.25, cr.radiator);
    if (rad < m.radiator) {
      const before = m.radiator; m.radiator = rad;
      if (before >= 0.7 && rad < 0.7) this.v.damageEvents.push('Radiator holed: watch the temperature');
    }
    const eng = 1 - 0.95 * smooth(0.06, 0.3, cr.engine);
    if (eng < h.engine) this.v.setEngineHealth(eng, 'crush');
    // a front / rear end crushed back into a wheel shoves that wheel's suspension back
    for (let i = 0; i < 4; i++) {
      const wx = (i % 2 ? 1 : -1) * s.track / 2, wz = i < 2 ? -s.wheelbase / 2 : s.wheelbase / 2;
      // structure pushed into the tyre's leading / trailing face, or into its outer face
      const R = s.tire.radius, ez = i < 2 ? wz - R : wz + R, sx = Math.sign(wx);
      const wc = Math.max(B(wx - 0.15, s.axleY, ez - 0.12, wx + 0.15, s.axleY + 0.3, ez + 0.12).max,
        B(wx + sx * (s.tire.width / 2 - 0.05), s.axleY, wz - 0.2, wx + sx * (s.tire.width / 2 + 0.1), s.axleY + 0.3, wz + 0.2).max);
      const cap = 1 - smooth(0.04, 0.26, wc) * 0.95;
      if (cap < h.susp[i]) this.v.damageWheel(i, h.susp[i] - cap, 0, wc > 0.3);
    }
    // fenders crushed onto the tyres: drag, and a message
    for (let i = 0; i < 4; i++) {
      const sx = i % 2 ? 1 : -1, wz = i < 2 ? -s.wheelbase / 2 : s.wheelbase / 2;
      const x0 = sx * (s.track / 2 - s.tire.width), x1 = sx * (s.track / 2 + s.tire.width + 0.2);
      const intr = c.sampleBox(V(Math.min(x0, x1), s.axleY + s.tire.radius * 0.5, wz - s.tire.radius), V(Math.max(x0, x1), s.axleY + s.tire.radius + 0.15, wz + s.tire.radius)).max;
      const drag = smooth(0.12, 0.3, intr) * 250 * (s.chassis.mass / 1800);
      if (drag > m.wheelDrag[i]) {
        if (m.wheelDrag[i] < 40 && drag >= 40) this.v.damageEvents.push(`Fender crushed onto the ${NAMES[i]} tyre`);
        m.wheelDrag[i] = drag;
      }
    }
    // rear end pushed into the rear axle / driveshaft
    const ds = 1 - smooth(0.14, 0.5, cr.rear);
    if (ds < m.driveshaft[1]) this.setDriveshaft(1, ds);
    if (cr.roof > 0.12 && !this.flags.has('roof')) { this.flags.add('roof'); this.v.damageEvents.push('Roof caved in'); }
    if (cr.roof > 0.28 && !this.flags.has('cab')) { this.flags.add('cab'); this.v.damageEvents.push('Cab crushed: the pillars folded'); }
    // parts crushed past their limit tear off
    for (const part of this.parts) {
      if (part.detached) continue;
      const crush = c.sampleBox(V(...part.lo), V(...part.hi), null, 3).max;
      if (crush > part.limit) this.detach(part, null);
    }
    this.applyColliders();
    this.v.dt.powerScale = this.powerScale();
  }

  setDriveshaft(a, v) {
    const m = this.mech, before = m.driveshaft[a];
    m.driveshaft[a] = v;
    if (before >= 0.6 && v < 0.6) this.v.damageEvents.push(`${a ? 'Rear' : 'Front'} driveshaft bent: driveline vibration`);
    if (v <= 0.05 && !m.driveLost[a]) { m.driveLost[a] = true; this.v.damageEvents.push(`${a ? 'Rear' : 'Front'} driveshaft snapped: no drive to the ${a ? 'rear' : 'front'} axle`); this.v.syncDriveline(); }
  }

  // belly strike from below at speed: a chassis-mounted diff (independent axles), the oil pan
  // under the engine, or the driveshaft further back
  bellyHit(p, dPl) {
    const m = this.mech, spec = this.v.spec, ind = spec.independent || [false, false];
    for (let a = 0; a < 2; a++) {
      const az = a === 0 ? -spec.wheelbase / 2 : spec.wheelbase / 2;
      if (ind[a] && Math.abs(p.z - az) < 0.5) { this.axleHit({ part: 'axle' + a }, dPl); return; }
    }
    if (p.z < 0.3) {
      const before = m.oilPan;
      m.oilPan = Math.max(0, m.oilPan - dPl * 0.06);
      if (before >= 0.7 && m.oilPan < 0.7) this.v.damageEvents.push('Oil pan cracked: losing oil');
    } else this.setDriveshaft(1, Math.min(m.driveshaft[1], 1 - dPl * 0.03));
  }

  powerScale() {
    const h = this.v.health, m = this.mech;
    const heat = m.temp > 0.85 ? 1 - smooth(0.85, 1.0, m.temp) * 0.6 : 1;
    return (0.3 + 0.7 * h.engine) * heat;
  }

  // slow processes: coolant and oil leaks, overheating, a seizing engine
  mechStep(h) {
    const m = this.mech, dt = this.v.dt;
    if (m.radiator < 1) m.coolant = Math.max(0, m.coolant - (1 - m.radiator) * 0.012 * h);
    if (m.oilPan < 1) m.oil = Math.max(0, m.oil - (1 - m.oilPan) * 0.01 * h);
    if (m.radiator >= 1 && m.oilPan >= 1 && m.temp <= 0) return;
    const running = dt.running && !dt.dead;
    const load = running ? 0.25 + 0.75 * Math.min(1, (dt.rpm || 0) / 4000) * (0.3 + 0.7 * (dt.throttleEff || 0)) : 0;
    const cool = 0.35 * (0.15 + 0.85 * m.coolant) * (0.4 + 0.6 * m.radiator);
    m.temp = Math.max(0, Math.min(1.2, m.temp + (load * 0.22 - cool * 0.5) * h * (m.temp > 0 || load * 0.22 > cool * 0.5 ? 1 : 0)));
    if (m.temp > 0.75 && !this.flags.has('hot')) { this.flags.add('hot'); this.v.damageEvents.push('Engine overheating: steam from the radiator'); }
    if (running) {
      let wear = 0;
      if (m.temp > 1) wear += (m.temp - 1) * 0.15 + 0.01;
      if (m.oil < 0.25) wear += (0.25 - m.oil) * 0.2;
      if (wear > 0) this.v.setEngineHealth(this.v.health.engine - wear * h, m.oil < 0.25 ? 'oil' : 'heat');
    }
    dt.powerScale = this.powerScale();
  }

  // Tear a part off: it leaves as its own rigid body (collides with the world only).
  detach(part, push) {
    if (part.detached) return;
    part.detached = true;
    this.v.damageEvents.push(`The ${part.name} tore off`);
    const v = this.v, R = v.R, cb = v.chassis, cq = cb.rotation(), ct = cb.translation();
    const c = V((part.lo[0] + part.hi[0]) / 2, (part.lo[1] + part.hi[1]) / 2, (part.lo[2] + part.hi[2]) / 2);
    // the part rides where the crushed body put it
    const d = this.lattice.sample(c.x, c.y, c.z, V(0, 0, 0));
    const lc = V(c.x + d.x, c.y + d.y, c.z + d.z);
    const wp = qrot(cq, lc);
    const pos = V(wp.x + ct.x, wp.y + ct.y, wp.z + ct.z);
    const hx = Math.max(0.03, (part.hi[0] - part.lo[0]) * 0.45), hy = Math.max(0.03, (part.hi[1] - part.lo[1]) * 0.45), hz = Math.max(0.03, (part.hi[2] - part.lo[2]) * 0.45);
    const vel = cb.velocityAtPoint(pos);
    const out = qrot(cq, V(Math.sign(lc.x) * 0.6, 0.8, Math.sign(lc.z) * 0.4));
    const k = push ? 1.2 : 0;
    const body = v.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation(cq)
      .setLinvel(vel.x + out.x + (push ? -push.x * k : 0), vel.y + out.y, vel.z + out.z + (push ? -push.z * k : 0))
      .setAngvel(V((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4))
      .setLinearDamping(0.1).setAngularDamping(0.4).setCanSleep(true));
    const vol = 8 * hx * hy * hz;
    v.world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setDensity(part.mass / vol).setFriction(0.7).setRestitution(0.15)
      .setCollisionGroups(v.GROUP_VEHICLE), body);
    this.debris.push({ part, body, centre: c, offset: lc });
    if (this.debris.length > 12) { const old = this.debris.shift(); if (old.body) v.world.removeRigidBody(old.body); old.body = null; }
    this.fx.push({ p: pos, n: push || V(0, 1, 0), e: 20, kind: 'detach' });
  }

  // Crushed ends / roof shrink the chassis collider boxes so the vehicle sits crumpled. Only ever
  // shrinks (never grows into an obstacle), and keeps every box at least 40% of its size.
  applyColliders() {
    const cr = this.mech.crush;
    for (const b of this.boxes || []) {
      if (!b.col) continue;
      let { hx, hy, hz, ox, oy, oz } = b;
      let front = oz - hz, back = oz + hz, top = oy + hy;
      const f = Math.min(cr.front * 0.6, 0.35), r = Math.min(cr.rear * 0.6, 0.3), rf = Math.min(Math.max(0, cr.roof) * 0.7, 0.3);
      if (front < this.layout.cab[0] - 0.2) front = Math.min(front + f, oz - hz * 0.4);
      if (back > this.layout.cab[1] + 0.2) back = Math.max(back - r, oz + hz * 0.4);
      if (b.cab) top = Math.max(top - rf, oy - hy * 0.2);
      const nhz = (back - front) / 2, noz = (back + front) / 2, bot = oy - hy, nhy = (top - bot) / 2, noy = (top + bot) / 2;
      if (Math.abs(nhz - b.cur.hz) < 0.01 && Math.abs(nhy - b.cur.hy) < 0.01) continue;
      b.cur = { hz: nhz, hy: nhy };
      b.col.setHalfExtents(V(hx, nhy, nhz));
      b.col.setTranslationWrtParent(V(ox, noy, noz));
    }
  }

  // a summary for the HUD / tests
  report() {
    const m = this.mech;
    return {
      body: this.v.health.body, plastic: this.plastic, scrape: this.scrape, maxCrush: this.lattice.maxDisp,
      crush: { ...m.crush }, radiator: m.radiator, coolant: m.coolant, temp: m.temp, oilPan: m.oilPan, oil: m.oil,
      diff: [...m.diff], driveshaft: [...m.driveshaft], driveLost: [...m.driveLost], wheelDrag: [...m.wheelDrag], bend: [...m.bend],
      detached: this.parts.filter((p) => p.detached).map((p) => p.id),
    };
  }
}

// scrape: mostly sliding work; crush: a long, energetic contact (rolling onto the roof, a slow
// heavy squeeze); hit: a short sharp impact
function classify(ev, e, es, t) {
  const dur = t - ev.t0;
  if (es > e * 2 && e < E_ELASTIC * 2) return 'scrape';
  if (dur > 0.15) return e > 10 ? 'crush' : 'scrape';
  return 'hit';
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
