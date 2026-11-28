// Lap timing for the race track: countdown, ordered checkpoints (index 0 is the
// start / finish line), lap / last / best times, wrong-way and missed-checkpoint hints.
// No DOM or three.js, so it runs headless in tests. Best laps persist per vehicle.

const KEY = (vid) => `lowrange.bestlap.race.${vid}`;
const KEY_A = (vid) => `lowrange.bestlap.race.assisted.${vid}`; // [winch] best winch-assisted lap, kept apart
const memStore = new Map();
const store = {
  get: (k) => { try { return globalThis.localStorage ? globalThis.localStorage.getItem(k) : memStore.get(k) ?? null; } catch { return null; } },
  set: (k, v) => { try { if (globalThis.localStorage) globalThis.localStorage.setItem(k, v); else memStore.set(k, v); } catch { /* storage full / blocked: keep the session best only */ } },
};

export const fmtLap = (t) => (t == null ? '—' : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`);

export class RaceLaps {
  constructor(track, checkpoints, vehicleId) {
    this.track = track; this.cps = checkpoints; this.vid = vehicleId;
    const b = parseFloat(store.get(KEY(vehicleId)));
    this.best = Number.isFinite(b) && b > 0 ? b : null; // a corrupted "-5" / "0" would be unbeatable
    const ba = parseFloat(store.get(KEY_A(vehicleId)));
    this.bestAssisted = Number.isFinite(ba) && ba > 0 ? ba : null; // [winch]
    this.reset();
  }

  // back to the grid, waiting for the countdown
  reset() {
    this.state = 'idle';      // idle | countdown | racing
    this.count = 0;           // countdown seconds left
    this.lap = 0;             // current lap number (0 = not over the line yet)
    this.lapTime = 0; this.total = 0; this.last = null;
    this.next = 0;            // index of the checkpoint that must be crossed next
    this.lastCp = 0;          // most recently passed checkpoint (for Backspace resets)
    this.started = false;     // crossed the start line at least once
    this.prev = null;         // signed distance past each checkpoint plane, last update
    this.sIdx = 0;            // nearest track point (search hint)
    this.wrongT = 0; this.wrong = false;
    this.missedT = 0;
    this.assisted = false;    // [winch] the winch line pulled during this lap
  }

  startCountdown(secs = 3) { this.reset(); this.state = 'countdown'; this.count = secs; }
  get holding() { return this.state === 'countdown'; }
  get racing() { return this.state === 'racing'; }

  // call after the truck is teleported, so the jump doesn't register as a crossing
  teleported() { this.prev = null; this.wrongT = 0; this.wrong = false; this.sIdx = -1; }

  // where Backspace puts you: just past the last checkpoint you passed, facing on
  poseForReset() {
    const cp = this.cps[this.lastCp];
    const s = this.started || this.lastCp > 0 ? cp.s + 4 : cp.s - 13;
    return { s, ...this._frame(s) };
  }

  _frame(s) {
    const pts = this.track.pts, L = this.track.length;
    s = ((s % L) + L) % L;
    let i = 1; while (i < pts.length - 1 && pts[i].s < s) i++;
    const a = pts[i - 1], b = pts[i], t = (s - a.s) / Math.max(1e-6, b.s - a.s);
    const tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, tx: tx / l, tz: tz / l, yaw: Math.atan2(-tx, -tz) };
  }

  // nearest centreline point: local search around last frame's, global after a teleport
  _nearest(x, z) {
    const pts = this.track.pts, n = pts.length - 1;
    let lo = this.sIdx - 25, hi = this.sIdx + 25;
    if (this.sIdx < 0) { lo = 0; hi = n - 1; }
    let best = 1e18, bi = 0;
    for (let k = lo; k <= hi; k++) { const i = ((k % n) + n) % n, p = pts[i]; const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < best) { best = d; bi = i; } }
    this.sIdx = bi;
    const a = pts[bi], b = pts[bi + 1];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { i: bi, d: Math.sqrt(best), tx: (b.x - a.x) / l, tz: (b.z - a.z) / l };
  }

  // pos: chassis position, vel: chassis linear velocity. Returns HUD events.
  update(dt, pos, vel) {
    const ev = [];
    if (this.state === 'countdown') {
      const before = Math.ceil(this.count);
      this.count -= dt;
      if (Math.ceil(this.count) !== before && this.count > 0) ev.push({ type: 'count', n: Math.ceil(this.count) });
      if (this.count <= 0) { this.state = 'racing'; ev.push({ type: 'go' }); }
      return ev;
    }
    if (this.state !== 'racing') return ev;
    this.total += dt;
    if (this.started) this.lapTime += dt;
    if (this.missedT > 0) this.missedT -= dt;

    // checkpoint planes
    const along = this.cps.map((c) => (pos.x - c.x) * c.tx + (pos.z - c.z) * c.tz);
    if (this.prev) {
      this.cps.forEach((c, i) => {
        const a0 = this.prev[i], a1 = along[i];
        if (!(a0 < 0 && a1 >= 0) || a1 - a0 > 6) return; // forward crossing, not a teleport
        const lat = (pos.x - c.x) * -c.tz + (pos.z - c.z) * c.tx;
        if (Math.abs(lat) > c.hw + 2) return;
        if (i === this.next) this._pass(i, ev);
        else if (i !== this.lastCp && this.missedT <= 0) { ev.push({ type: 'missed', cp: this.next }); this.missedT = 3; }
      });
    }
    this.prev = along;

    // wrong way: moving against the track direction for a while
    const nr = this._nearest(pos.x, pos.z);
    const vAlong = vel.x * nr.tx + vel.z * nr.tz;
    this.wrongT = vAlong < -1.5 && nr.d < 20 ? this.wrongT + dt : Math.max(0, this.wrongT - dt * 2);
    const wrong = this.wrongT > 1.2;
    if (wrong && !this.wrong) ev.push({ type: 'wrongway' });
    this.wrong = wrong;
    return ev;
  }

  _pass(i, ev) {
    this.lastCp = i;
    this.next = (i + 1) % this.cps.length;
    if (i !== 0) { ev.push({ type: 'cp', cp: i, of: this.cps.length - 1, split: this.lapTime }); return; }
    if (!this.started) { this.started = true; this.lap = 1; this.lapTime = 0; ev.push({ type: 'lapstart', lap: 1 }); return; }
    const t = this.lapTime;
    this.last = t;
    if (this.assisted) { // [winch] an assisted lap never replaces the unassisted best; it has its own
      const bestA = this.bestAssisted === null || t < this.bestAssisted;
      if (bestA) { this.bestAssisted = t; store.set(KEY_A(this.vid), String(t)); }
      ev.push({ type: 'lap', lap: this.lap, time: t, best: false, assisted: true, bestA });
      this.assisted = false; this.lap++; this.lapTime = 0;
      return;
    }
    const pb = this.best === null || t < this.best;
    if (pb) { this.best = t; store.set(KEY(this.vid), String(t)); }
    ev.push({ type: 'lap', lap: this.lap, time: t, best: pb });
    this.lap++; this.lapTime = 0;
  }

  // distance (m) along the track to the next checkpoint
  toNext(pos) {
    const c = this.cps[this.next];
    return Math.hypot(c.x - pos.x, c.z - pos.z);
  }
}
