// The Gauntlet's run logic (src/maps/crawl.js): where the truck is along the course, which
// stage it is in, the run clock, per-stage split times and per-rig bests (kept in
// localStorage, or in memory in Node). No three.js and no DOM, so tests can drive it.
// The same class runs the side courses (src/maps/crawl_courses.js: Broken Slab, Camber Ridge,
// Cobble Gully), whose "stages" are their sections, each with its own storage key; CourseSet
// below ties them together on the map (one run at a time, which course the HUD and Y follow).
//
// Rules: crossing the stage 1 gate starts a run; each later gate crossed in order ends the
// previous stage's split; the Summit gate (the last stage) finishes the run. Driving in by a
// bypass spur, past a gate you skipped, still times the stages you drive, but the run's total
// doesn't count as a best. Y (restartPose) puts you back at the gate of the stage you are in and
// restarts that stage's split; the run clock keeps going. After a spawn at a later stage's gate
// (joinAt), Y comes back to that gate until a gate is crossed.
import { heightAt, GRID, ROADS, SIZE, RES, MAP } from './terrain.js';

const memStore = new Map();
const store = {
  get: (k) => { try { return globalThis.localStorage ? globalThis.localStorage.getItem(k) : memStore.get(k) ?? null; } catch { return null; } },
  set: (k, v) => { try { if (globalThis.localStorage) globalThis.localStorage.setItem(k, v); else memStore.set(k, v); } catch { /* storage blocked: session only */ } },
};

export class CrawlCourse {
  // opts (side courses): key = storage key prefix (per rig: `${key}.${rig}`), unit = what a stage
  // is called ('Section'), finish = the finish gate's name, id
  constructor(trail, stages, opts = {}) {
    this.trail = trail; this.stages = stages;
    this.pts = trail.pts;
    this.key = opts.key ?? 'lowrange.crawl'; this.unit = opts.unit ?? 'Stage'; this.finish = opts.finish ?? 'SUMMIT'; this.id = opts.id ?? 'gauntlet';
    this.rig = null; this.rec = { best: null, splits: [] };
    this.reset();
  }

  // forget the current run (fresh spawn at the trailhead)
  reset() {
    this.stage = 0;            // stages entered so far: 0 = not started, n = in stage n
    this.running = false; this.clean = true; this.done = false;
    this.t = 0;                // run clock
    this.stageT = 0;           // time in the current stage
    this.splits = [];          // this run's split per stage (s)
    this.s = null; this.lat = 0; this.on = false; this.retry = null;
    this.joined = null;        // spawned at a later stage's gate (n), until a gate is crossed
    this.assisted = false;     // [winch] the winch line pulled during this run: its times are kept apart
  }

  // a spawn point facing stage n's gate (n > 1): until a gate is crossed, the HUD points at that
  // gate and Y comes back to it rather than to the course start
  joinAt(n) { this.joined = n > 1 && n <= this.stages.length ? n : null; }

  // a stored time is a real record only if it is a finite, positive number no faster than
  // 40 m/s over the distance (a corrupted "-5", "0" or "1e-9" would be unbeatable)
  plausible(t, metres) { return Number.isFinite(t) && t > 0 && t >= metres / 40; }

  setRig(id) {
    if (id === this.rig) return;
    this.rig = id;
    let rec = null;
    try { rec = JSON.parse(store.get(`${this.key}.${id}`) || 'null'); } catch { rec = null; }
    const st = this.stages, total = st.at(-1).gateS - st[0].gateS;
    this.rec = rec && typeof rec === 'object' && !Array.isArray(rec)
      ? { best: this.plausible(rec.best, total) ? rec.best : null,
        splits: Array.isArray(rec.splits) ? rec.splits.slice(0, st.length - 1).map((x, k) => (this.plausible(x, st[k + 1].gateS - st[k].gateS) ? x : null)) : [] }
      : { best: null, splits: [] };
    // [winch] the best winch-assisted run, kept apart from the unassisted record
    let recA = null;
    try { recA = JSON.parse(store.get(`${this.key}.assisted.${id}`) || 'null'); } catch { recA = null; }
    this.recA = { best: recA && this.plausible(recA.best, total) ? recA.best : null };
  }
  save() { if (this.rig) store.set(`${this.key}.${this.rig}`, JSON.stringify(this.rec)); }
  saveA() { if (this.rig) store.set(`${this.key}.assisted.${this.rig}`, JSON.stringify(this.recA)); } // [winch]

  // nearest point on the trail to p: searches near the last fix, or the whole trail after a jump
  project(p) {
    const P = this.pts;
    const scan = (i0, i1, step) => {
      let bi = -1, bd = Infinity;
      for (let i = Math.max(0, i0); i <= Math.min(P.length - 1, i1); i += step) {
        const d = (P[i].x - p.x) ** 2 + (P[i].z - p.z) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      return [bi, Math.sqrt(bd)];
    };
    let i, d;
    if (this.s !== null) { const c = this.idx; [i, d] = scan(c - 40, c + 60, 1); }
    if (this.s === null || d > 10) { [i] = scan(0, P.length - 1, 4); [i, d] = scan(i - 6, i + 6, 1); }
    this.idx = i;
    // tangent from this point to the next (from the one before at the last point, which has no next)
    const a = P[i], last = i >= P.length - 1, q0 = last ? P[i - 1] : a, q1 = last ? a : P[i + 1];
    const tx = q1.x - q0.x, tz = q1.z - q0.z, L = Math.hypot(tx, tz) || 1;
    const lat = ((p.x - a.x) * -tz + (p.z - a.z) * tx) / L, along = ((p.x - a.x) * tx + (p.z - a.z) * tz) / L;
    const st = this.stageOf(a.s);
    // on the course: inside the corridor (as wide as it is here: stages and sections open up between
    // their gates) and at its height (the switchback legs are far apart), and not out past either end
    this.on = Math.abs(lat) < (a.w ?? st.width) / 2 + 3.5 && Math.abs(p.y - heightAt(a.x, a.z)) < 3.5 && !(i === 0 && along < -1) && !(last && along > 1);
    this.s = a.s; this.lat = lat;
    return { s: a.s, lat, on: this.on };
  }
  stageOf(s) { let k = 0; while (k < this.stages.length - 1 && s >= this.stages[k + 1].s0) k++; return this.stages[k]; }

  // per frame: p = truck position; returns events for toasts
  update(p, dt) {
    const ev = [];
    if (this.running) { this.t += dt; this.stageT += dt; }
    const prev = this.s;
    const { s, on } = this.project(p);
    if (prev === null || !on || s - prev > 6 || s < prev) return ev; // only forward driving crosses gates (no teleports)
    for (const st of this.stages) {
      if (!(prev < st.gateS && s >= st.gateS)) continue;
      if (st.n <= this.stage && !(st.n === 1)) continue; // re-crossing a gate already passed this run
      ev.push(...this.enter(st));
    }
    return ev;
  }

  enter(st) {
    const ev = [];
    const last = this.stages.length;
    this.joined = null;
    if (st.n === 1) {
      // the start gate: a new run
      this.reset(); this.s = st.gateS; this.running = true; this.stage = 1;
      ev.push({ type: 'start', stage: st });
      return ev;
    }
    if (this.retry === st.n) { // back through the gate after Y: that stage starts over
      this.retry = null; this.stage = st.n; this.stageT = 0;
      ev.push({ type: 'stage', stage: st, retry: true });
      return ev;
    }
    if (!this.running) { this.running = true; this.clean = false; this.t = 0; } // joined by a spur
    if (this.stage && st.n === this.stage + 1) {
      const split = this.stageT, k = this.stage - 1;
      this.splits[k] = split;
      const prevBest = this.rec.splits[k];
      const best = !this.assisted && (prevBest == null || split < prevBest); // [winch] an assisted split is not a record
      if (best) { this.rec.splits[k] = split; this.save(); }
      ev.push({ type: 'split', stage: this.stages[k], split, best, prevBest });
    } else this.clean = false; // skipped one or more stages
    this.stage = st.n; this.stageT = 0;
    if (st.n === last) {
      this.running = false; this.done = true;
      const prevBest = this.rec.best, best = this.clean && !this.assisted && (prevBest == null || this.t < prevBest);
      if (best) { this.rec.best = this.t; this.save(); }
      // [winch] an assisted run never replaces the unassisted best; it has its own
      const prevBestA = this.recA?.best ?? null, bestA = this.clean && this.assisted && (prevBestA == null || this.t < prevBestA);
      if (bestA) { this.recA.best = this.t; this.saveA(); }
      ev.push({ type: 'finish', time: this.t, clean: this.clean, best, prevBest, assisted: this.assisted, bestA, prevBestA });
    } else ev.push({ type: 'stage', stage: st });
    return ev;
  }

  // Y: the gate of the stage you are in (or the start, before the first gate), facing uphill
  restartPose() {
    // spawned at a later stage's gate and not through any gate yet: back to that gate, still
    // joining there (nothing is running, so there is nothing to retry)
    const join = this.joined && !this.running && !this.done && this.stage === 0 ? this.joined : null;
    const n = join ?? (this.done || this.stage <= 1 ? 1 : this.stage);
    const st = this.stages[n - 1];
    const s = Math.max(0.5, st.s0 - 1.5);
    let i = this.pts.findIndex((q) => q.s >= s); if (i < 1) i = 1;
    const a = this.pts[i - 1], b = this.pts[i];
    this.s = null; this.stageT = 0; this.retry = null;
    if (join) { /* unchanged: driving through the gate joins the course there */ }
    else if (n === 1) { this.stage = 0; this.running = false; this.done = false; } // the start gate begins a new run
    else { this.stage = n - 1; this.retry = n; } // drive back through the gate to restart the stage
    return { x: a.x, z: a.z, yaw: Math.atan2(-(b.x - a.x), -(b.z - a.z)), stage: st, joined: !!join };
  }

  // HUD guidance: the next gate, with progress
  guide() {
    const n = this.stages.length;
    const next = this.stages[Math.min(this.stage, n - 1)];
    const cur = this.stage ? this.stages[this.stage - 1] : null;
    const unit = this.unit.toUpperCase(); // the HUD reads "STAGE 7/12" / "SECTION 2/4"
    if (this.joined && !this.running && !this.stage) { const j = this.stages[this.joined - 1]; return { target: j.gate, stage: 0, of: n, unit, name: j.name.toUpperCase(), next: `GATE ${j.n}`, run: null }; }
    if (this.done) return { target: this.stages[n - 1].gate, stage: n, of: n, unit, name: this.finish, next: 'COURSE DONE', run: this.t };
    if (this.retry) { const r = this.stages[this.retry - 1]; return { target: r.gate, stage: r.n, of: n, unit, name: r.name.toUpperCase(), next: `GATE ${r.n}`, run: this.running ? this.t : null }; }
    return {
      target: next.gate, stage: this.stage, of: n, unit,
      name: cur ? cur.name.toUpperCase() : 'START GATE',
      next: next.n === n ? `${this.finish} GATE` : `GATE ${next.n}`,
      run: this.running ? this.t : null,
    };
  }

  // for the big map's sidebar
  snapshot() { return { stage: this.stage, of: this.stages.length, splits: this.splits, best: this.rec.best, bestSplits: this.rec.splits, t: this.t, running: this.running, clean: this.clean, done: this.done, assisted: this.assisted, bestAssisted: this.recA?.best ?? null }; } // [winch] assisted, bestAssisted
}

// All the timed courses on one map: The Gauntlet and its side courses. One run at a time (starting
// or joining one cancels a run on any other); the HUD, the big map and Y follow the course in
// focus: the one running, else the one a spawn joined, else a side course the truck is on or
// close to the start of, else The Gauntlet.
export class CourseSet {
  constructor(gauntlet, sides = []) {
    this.gauntlet = gauntlet; this.sides = sides; this.all = [gauntlet, ...sides];
    this.p = null;
    this.held = null; // the side course last in focus, kept until the truck is well away from it
    // each side course's tracks (path ids in the grid): the way in, and both ways
    const ids = (c, inOnly) => new Set(ROADS.map((r, i) => (r.course === c.id && (!inOnly || r.access === 'in') ? i : -1)).filter((i) => i >= 0));
    this.trackIn = new Map(sides.map((c) => [c, ids(c, true)])); this.tracks = new Map(sides.map((c) => [c, ids(c, false)]));
  }
  get running() { return this.all.some((c) => c.running); }
  byId(id) { return this.all.find((c) => c.id === id) || null; }
  setRig(id) { for (const c of this.all) c.setRig(id); }
  reset() { for (const c of this.all) c.reset(); this.held = null; }
  // per frame: every course watches its own gates; events carry their course
  update(p, dt) {
    this.p = p;
    const was = new Map(this.all.map((c) => [c, c.running])), out = [];
    for (const c of this.all) for (const e of c.update(p, dt)) out.push({ ...e, course: c });
    const started = this.all.find((c) => c.running && !was.get(c));
    if (started) for (const c of this.all) if (c !== started && (c.running || c.joined || c.done)) { c.reset(); out.push({ type: 'cancel', course: c }); }
    // hold a side course in focus after its finish (or after driving off it) until well away, or
    // until the truck is back on The Gauntlet (its trail, the trailhead lot or the summit pad)
    const claim = this.claim();
    if (claim && claim !== this.gauntlet) this.held = claim;
    else if (claim === this.gauntlet || this.onGauntlet() || (this.held && !this.near(this.held, 40))) this.held = null;
    return out;
  }
  // on The Gauntlet's trail corridor, or on the trailhead lot or the summit pad (and their margins)
  onGauntlet() {
    const p = this.p; if (!p) return false;
    if (this.gauntlet.on) return true;
    return [MAP.TRAILHEAD, MAP.SUMMIT].some((q) => q && Math.hypot(p.x - q.x, p.z - q.z) < q.r + 4);
  }
  // the grid path id under the truck
  pathId() { const p = this.p, n = RES + 1, k = SIZE / RES; if (!p) return -1; const ix = Math.max(0, Math.min(RES, Math.round((p.x + SIZE / 2) / k))), iz = Math.max(0, Math.min(RES, Math.round((p.z + SIZE / 2) / k))); return GRID.path[ix * n + iz]; }
  // about to start a side course: on its way-in track, or within 12 m of its start gate
  nearStart(c) {
    const p = this.p, g = c.stages[0].gate;
    return !!p && ((Math.hypot(p.x - g.x, p.z - g.z) < 12 && Math.abs(p.y - g.h) < 6) || this.trackIn.get(c).has(this.pathId()));
  }
  // within r m of a side course (or on one of its tracks)
  near(c, r) {
    const p = this.p; if (!p) return false;
    if (this.tracks.get(c)?.has(this.pathId())) return true;
    for (let i = 0; i < c.pts.length; i += 4) if (Math.hypot(c.pts[i].x - p.x, c.pts[i].z - p.z) < r) return true;
    return false;
  }
  // the course that claims the truck right now (null: none in particular). On The Gauntlet only a
  // side course's own corridor claims it, not its access track or the reach of its start gate.
  claim() {
    const onG = this.onGauntlet();
    return this.all.find((c) => c.running) || this.all.find((c) => c.joined) || this.sides.find((c) => c.on || (!onG && this.nearStart(c))) || null;
  }
  get focus() { return this.claim() || this.held || this.gauntlet; }
  guide() {
    const c = this.focus, g = c.guide();
    if (c === this.gauntlet) return { ...g, course: null };
    const name = c.trail.name.toUpperCase();
    // before the start gate the plaque names the course
    return { ...g, course: name, ...(!c.stage && !c.joined && !c.done ? { name, next: 'START GATE' } : {}) };
  }
  // The Gauntlet's snapshot as before, plus the side course in focus (for the big map's sidebar)
  snapshot() {
    const c = this.focus, snap = this.gauntlet.snapshot();
    snap.course = c === this.gauntlet ? null : { id: c.id, name: c.trail.name, diff: c.trail.diff, sections: c.stages.map((q) => ({ n: q.n, name: q.name, diff: q.diff })), ...c.snapshot() };
    return snap;
  }
  // Y: the course in focus
  restartPose() { const c = this.focus; return { ...c.restartPose(), course: c }; }
  // a spawn point: every run cancelled; a stage / section gate spawn joins that course there
  spawnAt(sp) {
    this.reset();
    if (sp.kind === 'stage') this.gauntlet.joinAt(sp.stage);
    else if (sp.kind === 'course') this.byId(sp.course)?.joinAt(sp.stage ?? 0);
  }
}
