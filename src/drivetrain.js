// Drivetrain + tyre friction solver.
//
// Rotating parts are 1-D angular velocity DOFs:
//   0 engine, 1 rear driveshaft, 2 front driveshaft, 3 FL, 4 FR, 5 RL, 6 RR wheel spin
// plus one linear DOF per tyre contact patch (the vehicle's velocity along the rolling
// direction at that patch, with the share of vehicle mass resting on it).
//
// Diffs, lockers, transfer case and gearbox are equality constraints; the clutch, brakes,
// rolling resistance and tyre grip are friction constraints with box limits. Everything is
// solved together, exactly, every physics substep, so tyre grip "feels" the engine through
// a 70:1 crawl ratio and a braked truck holds on a slope.
//
// Wheel spin is "forward-positive" (rad/s) relative to the knuckle.

const RPM = 60 / (2 * Math.PI);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Exact solve of the velocity constraints J·(w + W Jᵀ λ) = 0 with box limits on λ.
// Iterative solvers converge terribly here (light driveshafts between a huge reflected
// engine inertia and the wheels), so we solve the small dense system directly and use
// an active set: constraints whose impulse exceeds its limit (slipping clutch, brakes
// at capacity) are clamped to the limit and the rest are re-solved.
function solveBoxed(C, w, I) {
  const n = C.length, D = w.length;
  if (!n) return;
  const A = [];
  for (let i = 0; i < n; i++) {
    A.push(new Float64Array(n));
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let d = 0; d < D; d++) if (C[i].j[d] && C[j].j[d]) s += (C[i].j[d] * C[j].j[d]) / I[d];
      A[i][j] = s;
    }
    if (C[i].cfm) A[i][i] += C[i].cfm; // a slightly compliant row (a standing tyre's tread)
  }
  // b = -(current constraint velocity). Rows may supply it directly (v0), e.g. tyre slip
  // measured from the physics engine, where some DOFs only carry velocity *changes*.
  const b = C.map((c) => { if (c.v0 !== undefined) return -c.v0; let s = 0; for (let d = 0; d < D; d++) s += c.j[d] * w[d]; return -s; });
  const lam = new Float64Array(n);
  const clampedAt = new Float64Array(n); // 0 = free, else the clamped value
  const isClamped = new Uint8Array(n);
  // Principal-pivoting style active set: each pass flips the single worst violator.
  //  - a free limited constraint whose impulse exceeds its bound gets clamped there;
  //  - a clamped constraint that overshoots (drives its relative velocity past zero,
  //    i.e. would inject energy) is released back to "stick".
  for (let pass = 0; pass < 4 * n + 4; pass++) {
    const free = [];
    for (let i = 0; i < n; i++) if (!isClamped[i]) free.push(i);
    const m = free.length;
    // build reduced system M x = r
    const M = free.map((i, fi) => { const row = new Float64Array(m + 1); free.forEach((j, k) => { row[k] = A[i][j]; }); row[fi] += A[i][i] * 1e-7 + 1e-9; let r = b[i]; for (let j = 0; j < n; j++) if (isClamped[j]) r -= A[i][j] * clampedAt[j]; row[m] = r; return row; });
    // Gaussian elimination with partial pivoting
    for (let c = 0; c < m; c++) {
      let p = c;
      for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const piv = M[c][c];
      if (Math.abs(piv) < 1e-14) continue;
      for (let r = 0; r < m; r++) {
        if (r === c) continue;
        const f = M[r][c] / piv;
        if (f) for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k];
      }
    }
    free.forEach((i, k) => { lam[i] = Math.abs(M[k][k]) < 1e-14 ? 0 : M[k][m] / M[k][k]; });
    for (let i = 0; i < n; i++) if (isClamped[i]) lam[i] = clampedAt[i];
    let worst = -1, worstV = 1e-9;
    for (let i = 0; i < n; i++) {
      let viol;
      if (!isClamped[i]) viol = Math.max(lam[i] - C[i].hi, C[i].lo - lam[i]);
      else {
        // residual relative velocity of this constraint after applying all impulses
        let r = -b[i];
        for (let j = 0; j < n; j++) r += A[i][j] * lam[j];
        viol = (clampedAt[i] > 0 ? r : -r) / A[i][i];
      }
      if (viol > worstV) { worstV = viol; worst = i; }
    }
    if (worst < 0) break;
    if (isClamped[worst]) isClamped[worst] = 0;
    else { isClamped[worst] = 1; clampedAt[worst] = lam[worst] > C[worst].hi ? C[worst].hi : C[worst].lo; }
  }
  for (let i = 0; i < n; i++) {
    const L = isClamped[i] ? clampedAt[i] : lam[i];
    C[i].acc = L; C[i].clamped = !!isClamped[i];
    for (let d = 0; d < D; d++) if (C[i].j[d]) w[d] += (C[i].j[d] * L) / I[d];
  }
}

export class Drivetrain {
  constructor(spec, wheelInertia) {
    this.spec = spec;
    const e = spec.engine;
    this.I = [e.inertia, 0.06, 0.05, wheelInertia, wheelInertia, wheelInertia, wheelInertia];
    this.w = new Float64Array(7);
    this.w[0] = e.idle / RPM;
    this.running = true;
    this.gear = 0;             // -1 reverse, 0 neutral, 1..n
    this.range = 'high';       // 'high' | 'low'
    this.fourWD = true;
    this.lockF = false;
    this.lockR = false;
    this.autoClutch = true;
    this.clutchPedal = 0;      // 0 = released (engaged), 1 = pressed
    this.engagement = 1;
    this.shiftTimer = 0;
    this.crankTimer = 0;
    this.throttleEff = 0;
    this.engineTorque = 0;
    this.clutchSlip = false;
    this.wheelTorque = [0, 0, 0, 0];
    this.clutchMaxT = e.peakT * 1.9;
    this.govI = 0;
  }

  get rpm() { return this.w[0] * RPM; }
  get gearLabel() { return this.gear === 0 ? 'N' : this.gear < 0 ? 'R' : String(this.gear); }

  totalRatio() {
    const s = this.spec;
    if (this.gear === 0) return 0;
    const g = this.gear < 0 ? -s.reverse : s.gears[this.gear - 1];
    return g * (s.ranges[this.range] ?? 1);
  }

  maxTorqueAt(rpm) {
    const e = this.spec.engine;
    const x = (rpm - e.peakRpm) / (e.redline - e.idle);
    const t = 1 - 1.15 * x * x;
    const low = smooth(0, e.idle * 1.2, rpm);
    return e.peakT * clamp(t, 0.35, 1) * (0.45 + 0.55 * low);
  }

  // Returns a short message if the action fails or needs feedback.
  shift(dir, speedKmh) {
    const n = this.spec.gears.length;
    const target = clamp(this.gear + dir, -1, n);
    if (target === this.gear) return null;
    if (!this.autoClutch && this.clutchPedal < 0.7) return 'GRIND! Press the clutch (Space) to shift';
    if (target === -1 && speedKmh > 4) return 'GRIND! Stop before selecting reverse';
    if (this.gear === -1 && target === 0) { /* R -> N ok */ }
    this.gear = target;
    this.shiftTimer = 0.28;
    return null;
  }

  toggleRange(speedKmh) {
    if (!this.spec.ranges.low) return 'No low range on this one: it is a rally car';
    const clutchFree = this.gear === 0 || this.clutchPedal > 0.7 || this.autoClutch;
    if (!clutchFree || speedKmh > 3) return 'Transfer case: stop, then shift range in neutral';
    this.range = this.range === 'high' ? 'low' : 'high';
    if (this.range === 'low') this.fourWD = true;
    this.shiftTimer = 0.4;
    return null;
  }

  toggle4WD() {
    if (this.spec.awd) return 'Permanent all-wheel drive';
    if (this.range === 'low') return '4WD is required in low range';
    this.fourWD = !this.fourWD;
    return null;
  }

  startEngine() {
    if (this.dead) return 'The engine is wrecked. Head to the garage (Esc) to repair';
    if (this.running) return null;
    if (this.gear !== 0 && this.clutchPedal < 0.7 && !this.autoClutch) return 'Press the clutch or select neutral to start';
    this.crankTimer = 0.7;
    return null;
  }

  // Mechanical links (diffs, lockers, transfer case) as unlimited equality constraints.
  linkConstraints(D = 7) {
    const FD = this.spec.final, C = [];
    const row = (pairs, lo = -Infinity, hi = Infinity) => {
      const j = new Float64Array(D);
      for (let k = 0; k < pairs.length; k += 2) j[pairs[k]] = pairs[k + 1];
      return { j, lo, hi };
    };
    const B = this.broken || [false, false, false, false];
    // An axle's diff. With a wheel torn off, an open diff just spins that side (no drive
    // to the axle at all); a locked diff still drives the remaining wheel.
    const diff = (shaft, l, r, locked) => {
      const bl = B[l - 3], br = B[r - 3];
      if (!bl && !br) { C.push(row([shaft, 1, l, -FD / 2, r, -FD / 2])); if (locked) C.push(row([l, 1, r, -1])); }
      else if (locked && !(bl && br)) C.push(row([shaft, 1, bl ? r : l, -FD]));
    };
    diff(1, 5, 6, this.lockR); // rear: shaft = FD * avg(RL,RR)
    if (this.fourWD) {
      diff(2, 3, 4, this.lockF);
      C.push(row([1, -1, 2, 1])); // locked transfer case / centre coupling
    }
    C.row = row;
    return C;
  }

  // One substep.
  //  wheels:  wheel spin rates (forward positive), updated in place
  //  brakes:  per-wheel friction torque capacity (brake + rolling resistance), N·m
  //  extra:   { I: inertias of extra DOFs (indices 7..), rows: [{ pairs: [dof, coef, ...],
  //           v0: current velocity of the row, lo, hi }] } -- the tyre grip rows coupling
  //           wheel spin to the chassis body. Extra DOFs carry velocity changes only.
  //           -> on return each row gets .imp (its impulse) and .clamped
  // Returns per-wheel driveline+brake impulse on the wheel spin (for the axle reaction),
  // and leaves the extra DOFs' velocity changes in this.extraDelta.
  step(dt, throttle, wheels, brakes, extra) {
    const s = this.spec, e = s.engine;
    const X = extra.I.length, D = 7 + X;
    const w = new Float64Array(D);
    const I = new Float64Array(D);
    for (let d = 0; d < 7; d++) { w[d] = this.w[d]; I[d] = this.I[d]; }
    for (let i = 0; i < 4; i++) w[3 + i] = wheels[i];
    for (let x = 0; x < X; x++) I[7 + x] = extra.I[x];
    // --- clutch engagement ---
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const rpm = this.rpm;
    let engage = 1 - this.clutchPedal;
    if (this.autoClutch) {
      // bite point rises with throttle so a hard launch slips at useful rpm;
      // once the clutch has locked it stays locked until the engine bogs down.
      const loRpm = e.idle * (0.62 + throttle * 1.2);
      const hiRpm = loRpm + 400 + throttle * (e.peakRpm - e.idle) * 0.5;
      let a = smooth(loRpm, hiRpm, rpm);
      // once locked it stays locked until the engine bogs below the bite point, then it
      // slips so the engine can rev back up into its torque band (instead of lugging)
      if (this.wasLocked && rpm > loRpm) a = 1;
      engage = Math.min(engage, a);
      if (this.shiftTimer > 0) engage = 0;
      // braking with no throttle: the clutch drops out so idle torque through a
      // crawl ratio can't fight the brakes (like an anti-stall / auto box)
      if ((this.brakePedal || 0) > 0.25 && throttle < 0.05) engage = Math.min(engage, 0);
      // No idle creep with the auto-clutch: off the throttle, the idling engine may not
      // push the truck along (that felt like a stuck throttle). It still engages when the
      // wheels overrun the engine, so engine braking down a descent keeps working.
      const G0 = this.totalRatio();
      if (throttle >= 0.03 || (G0 !== 0 && G0 * w[1] > w[0] * 1.04)) this.creepBlock = false;
      else if ((this.lastClutchAcc || 0) < -1e-4) this.creepBlock = true;
      if (this.creepBlock) engage = 0;
    }
    this.engagement = engage;

    // --- engine ---
    if (this.crankTimer > 0) {
      this.crankTimer -= dt;
      w[0] = Math.max(w[0], (e.idle * 0.5) / RPM);
      if (this.crankTimer <= 0 && !this.dead) { this.running = true; w[0] = Math.max(w[0], e.idle / RPM); }
    }
    let thr = throttle;
    if (this.running) {
      // idle governor (PI) keeps the engine alive under crawl loads
      const err = (e.idle - rpm) / e.idle;
      this.govI = clamp(this.govI + err * dt * 4, 0, 0.6);
      const gov = clamp(err * 6 + this.govI, 0, 0.85);
      thr = Math.max(thr, gov);
      if (rpm > e.redline) thr = 0;
      if (rpm < e.idle * 0.42) { this.running = false; this.govI = 0; }
    } else thr = 0;
    this.throttleEff = thr;
    const drive = this.running ? thr * this.maxTorqueAt(rpm) * (this.powerScale ?? 1) : 0;
    // internal friction + closed-throttle pumping losses (engine braking)
    const pump = this.running ? (1 - thr) * e.friction * (rpm / 1400) : 0;
    const fric = (e.friction * (0.35 + rpm / 3000) * (this.running ? 1 - thr * 0.8 : 1.6) + pump) * Math.sign(w[0] || 1);
    this.engineTorque = drive - fric;
    w[0] += (this.engineTorque * dt) / I[0];
    if (!this.running && w[0] < 0) w[0] = 0;

    // --- constraints ---
    const G = this.totalRatio();
    const C = this.linkConstraints(D);
    const nDrive = () => C.length;
    let clutchC = null;
    if (G !== 0 && engage > 0.001) {
      const cap = this.clutchMaxT * engage * dt;
      clutchC = C.row([0, 1, 1, -G], -cap, cap);
      C.push(clutchC);
    }
    for (let i = 0; i < 4; i++) {
      const cap = brakes[i] * dt;
      if (cap > 0) C.push(C.row([3 + i, 1], -cap, cap));
    }
    // limited-slip / brake-based traction control on open diffs: a torque-limited
    // coupling between the two wheels of an axle
    const lsd = s.lsd || {};
    const B = this.broken || [false, false, false, false];
    if (lsd.front && this.fourWD && !this.lockF && !B[0] && !B[1]) C.push(C.row([3, 1, 4, -1], -lsd.front * dt, lsd.front * dt));
    if (lsd.rear && !this.lockR && !B[2] && !B[3]) C.push(C.row([5, 1, 6, -1], -lsd.rear * dt, lsd.rear * dt));
    const nDriveline = nDrive();
    // tyre grip rows
    for (const r of extra.rows) { const c = C.row(r.pairs, r.lo, r.hi); c.v0 = r.v0; c.cfm = r.cfm; C.push(c); }
    solveBoxed(C, w, I);
    this.clutchSlip = !!clutchC && clutchC.clamped;
    this.lastClutchAcc = clutchC ? clutchC.acc : 0;
    this.wasLocked = !!clutchC && !this.clutchSlip && engage > 0.95;

    for (let d = 0; d < 7; d++) this.w[d] = w[d];
    // impulse each wheel received from driveline + brakes (reacts on the axle housing)
    const driveImp = [0, 0, 0, 0];
    for (let c = 0; c < nDriveline; c++) for (let i = 0; i < 4; i++) driveImp[i] += C[c].j[3 + i] * C[c].acc;
    for (let i = 0; i < 4; i++) { wheels[i] = w[3 + i]; this.wheelTorque[i] = driveImp[i] / dt; }
    extra.rows.forEach((r, k) => { r.imp = C[nDriveline + k].acc; r.clamped = C[nDriveline + k].clamped; });
    this.extraDelta = w.subarray(7);
    return driveImp;
  }
}
