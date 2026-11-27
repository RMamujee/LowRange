// The Gauntlet's run logic (src/maps/crawl.js): where the truck is along the course, which
// stage it is in, the run clock, per-stage split times and per-rig bests (kept in
// localStorage, or in memory in Node). No three.js and no DOM, so tests can drive it.
//
// Rules: crossing the stage 1 gate starts a run; each later gate crossed in order ends the
// previous stage's split; the Summit gate (the last stage) finishes the run. Driving in by a
// bypass spur, past a gate you skipped, still times the stages you drive, but the run's total
// doesn't count as a best. Y (restartPose) puts you back at the gate of the stage you are in and
// restarts that stage's split; the run clock keeps going.
import { heightAt } from './terrain.js';

const memStore = new Map();
const store = {
  get: (k) => { try { return globalThis.localStorage ? globalThis.localStorage.getItem(k) : memStore.get(k) ?? null; } catch { return null; } },
  set: (k, v) => { try { if (globalThis.localStorage) globalThis.localStorage.setItem(k, v); else memStore.set(k, v); } catch { /* storage blocked: session only */ } },
};

export class CrawlCourse {
  constructor(trail, stages) {
    this.trail = trail; this.stages = stages;
    this.pts = trail.pts;
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
    try { rec = JSON.parse(store.get(`lowrange.crawl.${id}`) || 'null'); } catch { rec = null; }
    const st = this.stages, total = st.at(-1).gateS - st[0].gateS;
    this.rec = rec && typeof rec === 'object' && !Array.isArray(rec)
      ? { best: this.plausible(rec.best, total) ? rec.best : null,
        splits: Array.isArray(rec.splits) ? rec.splits.slice(0, st.length - 1).map((x, k) => (this.plausible(x, st[k + 1].gateS - st[k].gateS) ? x : null)) : [] }
      : { best: null, splits: [] };
  }
  save() { if (this.rig) store.set(`lowrange.crawl.${this.rig}`, JSON.stringify(this.rec)); }

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
    const a = P[i], b = P[Math.min(P.length - 1, i + 1)], tx = b.x - a.x, tz = b.z - a.z, L = Math.hypot(tx, tz) || 1;
    const lat = ((p.x - a.x) * -tz + (p.z - a.z) * tx) / L;
    const st = this.stageOf(a.s);
    // on the course: inside the corridor and at its height (the switchback legs are far apart)
    this.on = Math.abs(lat) < st.width / 2 + 3.5 && Math.abs(p.y - heightAt(a.x, a.z)) < 3.5;
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
      const best = prevBest == null || split < prevBest;
      if (best) { this.rec.splits[k] = split; this.save(); }
      ev.push({ type: 'split', stage: this.stages[k], split, best, prevBest });
    } else this.clean = false; // skipped one or more stages
    this.stage = st.n; this.stageT = 0;
    if (st.n === last) {
      this.running = false; this.done = true;
      const prevBest = this.rec.best, best = this.clean && (prevBest == null || this.t < prevBest);
      if (best) { this.rec.best = this.t; this.save(); }
      ev.push({ type: 'finish', time: this.t, clean: this.clean, best, prevBest });
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
    if (this.joined && !this.running && !this.stage) { const j = this.stages[this.joined - 1]; return { target: j.gate, stage: 0, of: n, name: j.name.toUpperCase(), next: `GATE ${j.n}`, run: null }; }
    if (this.done) return { target: this.stages[n - 1].gate, stage: n, of: n, name: 'SUMMIT', next: 'COURSE DONE', run: this.t };
    if (this.retry) { const r = this.stages[this.retry - 1]; return { target: r.gate, stage: r.n, of: n, name: r.name.toUpperCase(), next: `GATE ${r.n}`, run: this.running ? this.t : null }; }
    return {
      target: next.gate, stage: this.stage, of: n,
      name: cur ? cur.name.toUpperCase() : 'START GATE',
      next: next.n === n ? 'SUMMIT GATE' : `GATE ${next.n}`,
      run: this.running ? this.t : null,
    };
  }

  // for the big map's sidebar
  snapshot() { return { stage: this.stage, of: this.stages.length, splits: this.splits, best: this.rec.best, bestSplits: this.rec.splits, t: this.t, running: this.running, clean: this.clean, done: this.done }; }
}
