// Free-form deformation cage for crash damage (plain JS, no three.js: the physics side owns it,
// the view samples it).
//
// A regular grid of control nodes is laid around the vehicle body in chassis-local space
// (-Z forward, +Y up). Each node stores a permanent displacement. Impacts push nodes; every body
// vertex then moves by the trilinear blend of its cell's eight nodes, so a hit bends a whole
// region of the body coherently (the front end folds, the roof sags, a door caves in) instead of
// pushing isolated vertices into spikes.
//
// Three rules keep it looking like metal, not noise:
//  - per-node travel caps by body zone (crumple zones travel far, the cabin barely does),
//  - no inversion: neighbouring nodes must keep their order and at least MIN_GAP of their rest
//    spacing along each grid axis, so the cage (and the mesh inside it) never folds through
//    itself; that constraint is also what propagates a deep crush backwards through the structure,
//  - a light smoothing pass over the touched region (removes single-node kinks).

const MIN_GAP = 0.18; // fraction of rest spacing two neighbouring nodes keep along each axis

export class DeformLattice {
  // min/max: chassis-local bounds {x,y,z}; step: target node spacing (m);
  // capFn(x, y, z) -> max travel (m) of a node at that rest position
  constructor(min, max, step, capFn) {
    this.min = { ...min }; this.max = { ...max };
    const n = (a) => Math.max(2, Math.round((max[a] - min[a]) / step) + 1);
    this.nx = n('x'); this.ny = n('y'); this.nz = n('z');
    this.sx = (max.x - min.x) / (this.nx - 1);
    this.sy = (max.y - min.y) / (this.ny - 1);
    this.sz = (max.z - min.z) / (this.nz - 1);
    const N = this.nx * this.ny * this.nz;
    this.count = N;
    this.rest = new Float32Array(N * 3);
    this.disp = new Float32Array(N * 3);
    this.cap = new Float32Array(N);
    for (let k = 0; k < this.nz; k++) for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) {
      const id = this.id(i, j, k);
      const x = min.x + i * this.sx, y = min.y + j * this.sy, z = min.z + k * this.sz;
      this.rest[id * 3] = x; this.rest[id * 3 + 1] = y; this.rest[id * 3 + 2] = z;
      this.cap[id] = capFn ? capFn(x, y, z) : 0.5;
    }
    this.version = 0;   // bumps whenever the displacement field changes (the view re-deforms then)
    this.centre = { x: 0, y: 0, z: 0 }; // body centre line (buckles bulge away from it)
    this.buckle = 0.35;                  // sideways bulge per metre of crush
    this.maxDisp = 0;
  }

  id(i, j, k) { return (k * this.ny + j) * this.nx + i; }

  reset() { this.disp.fill(0); this.maxDisp = 0; this.version++; this.markDirty({ i0: 0, i1: this.nx - 1, j0: 0, j1: this.ny - 1, k0: 0, k1: this.nz - 1 }); }

  // Trilinear displacement at chassis-local (x, y, z); points outside the cage take the border value.
  sample(x, y, z, out) {
    const fx = Math.min(this.nx - 1.0001, Math.max(0, (x - this.min.x) / this.sx));
    const fy = Math.min(this.ny - 1.0001, Math.max(0, (y - this.min.y) / this.sy));
    const fz = Math.min(this.nz - 1.0001, Math.max(0, (z - this.min.z) / this.sz));
    const i = fx | 0, j = fy | 0, k = fz | 0;
    const u = fx - i, v = fy - j, w = fz - k;
    const d = this.disp, nx = this.nx, nxy = nx * this.ny;
    const b = (k * this.ny + j) * nx + i;
    let ox = 0, oy = 0, oz = 0;
    for (let c = 0; c < 8; c++) {
      const di = c & 1, dj = (c >> 1) & 1, dk = c >> 2;
      const wt = (di ? u : 1 - u) * (dj ? v : 1 - v) * (dk ? w : 1 - w);
      if (wt === 0) continue;
      const q = (b + di + dj * nx + dk * nxy) * 3;
      ox += d[q] * wt; oy += d[q + 1] * wt; oz += d[q + 2] * wt;
    }
    out.x = ox; out.y = oy; out.z = oz;
    return out;
  }

  // Largest displacement component along `dir` among nodes within `radius` of p (rest positions).
  crushAlong(p, dir, radius) {
    let best = 0;
    this.forNodesNear(p, radius, (id) => {
      const q = id * 3, a = this.disp[q] * dir.x + this.disp[q + 1] * dir.y + this.disp[q + 2] * dir.z;
      if (a > best) best = a;
    });
    return best;
  }

  // Displacement statistics of the field itself (what body vertices there get), sampled on an
  // n x n x n grid inside the box [lo, hi]: max magnitude, and mean component along `dir`.
  sampleBox(lo, hi, dir = null, n = 4) {
    const o = { x: 0, y: 0, z: 0 };
    let max = 0, sum = 0, cnt = 0;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) {
      const t = (k) => (k + 0.5) / n;
      this.sample(lo.x + (hi.x - lo.x) * t(a), lo.y + (hi.y - lo.y) * t(b), lo.z + (hi.z - lo.z) * t(c), o);
      max = Math.max(max, Math.hypot(o.x, o.y, o.z));
      if (dir) sum += o.x * dir.x + o.y * dir.y + o.z * dir.z;
      cnt++;
    }
    return { max, mean: dir ? sum / cnt : 0 };
  }

  // Node-index box changed since the view last asked (the view only re-deforms vertices in it).
  takeDirty() { const d = this.dirty; this.dirty = null; return d; }
  markDirty(r) {
    const d = this.dirty;
    this.dirty = d ? { i0: Math.min(d.i0, r.i0), i1: Math.max(d.i1, r.i1), j0: Math.min(d.j0, r.j0), j1: Math.max(d.j1, r.j1), k0: Math.min(d.k0, r.k0), k1: Math.max(d.k1, r.k1) } : { ...r };
  }

  // Max displacement magnitude of nodes whose rest position lies inside the box [lo, hi].
  maxIn(lo, hi) {
    let best = 0;
    const r = this.range(lo, hi);
    for (let k = r.k0; k <= r.k1; k++) for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) {
      const q = this.id(i, j, k) * 3, m = Math.hypot(this.disp[q], this.disp[q + 1], this.disp[q + 2]);
      if (m > best) best = m;
    }
    return best;
  }
  // Mean of the displacement component along `dir` inside a box (how far a region moved, e.g. the roof down).
  meanAlong(lo, hi, dir) {
    let s = 0, n = 0;
    const r = this.range(lo, hi);
    for (let k = r.k0; k <= r.k1; k++) for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) {
      const q = this.id(i, j, k) * 3;
      s += this.disp[q] * dir.x + this.disp[q + 1] * dir.y + this.disp[q + 2] * dir.z; n++;
    }
    return n ? s / n : 0;
  }

  range(lo, hi) {
    const c = (v, m, s, n, f) => Math.min(n - 1, Math.max(0, f((v - m) / s)));
    return {
      i0: c(lo.x, this.min.x, this.sx, this.nx, Math.ceil), i1: c(hi.x, this.min.x, this.sx, this.nx, Math.floor),
      j0: c(lo.y, this.min.y, this.sy, this.ny, Math.ceil), j1: c(hi.y, this.min.y, this.sy, this.ny, Math.floor),
      k0: c(lo.z, this.min.z, this.sz, this.nz, Math.ceil), k1: c(hi.z, this.min.z, this.sz, this.nz, Math.floor),
    };
  }

  forNodesNear(p, radius, fn) {
    const r = this.range({ x: p.x - radius, y: p.y - radius, z: p.z - radius }, { x: p.x + radius, y: p.y + radius, z: p.z + radius });
    for (let k = r.k0; k <= r.k1; k++) for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) fn(this.id(i, j, k), i, j, k);
    return r;
  }

  // An obstacle intrudes `depth` metres into the body at contact point p (rest-space, on the
  // body surface), moving along unit `dir` (into the vehicle). Nodes in front of the intruding
  // face are pushed back onto it (flattened against a wall, wrapped around a tree); the face's
  // footprint is `core` m wide (full push) fading out over a further `edge` m; with `axis` (a
  // pole / tree trunk) the footprint is a band along that axis instead of a disc. Returns the
  // number of nodes moved.
  intrude(p, dir, depth, core, edge, axis = null) {
    if (!(depth > 1e-4)) return 0;
    const reach = core + edge;
    const R = reach + depth + 0.3;
    const d = this.disp, rest = this.rest;
    let moved = 0;
    const r = this.forNodesNear(p, R, (id) => {
      const q = id * 3;
      const rx = rest[q] - p.x, ry = rest[q + 1] - p.y, rz = rest[q + 2] - p.z;
      let along = rx * dir.x + ry * dir.y + rz * dir.z;
      if (along > depth + 0.05 || along < -0.6) return;
      let lx = rx - along * dir.x, ly = ry - along * dir.y, lz = rz - along * dir.z;
      if (axis) { const a = lx * axis.x + ly * axis.y + lz * axis.z; lx -= a * axis.x; ly -= a * axis.y; lz -= a * axis.z; }
      const lat = Math.hypot(lx, ly, lz);
      if (lat >= reach) return;
      // footprint: full inside the core, smooth fall-off (smoothstep) across the edge
      const t = lat <= core ? 0 : (lat - core) / edge;
      const wLat = 1 - t * t * (3 - 2 * t);
      // body sticking out past the contact point was already up against the obstacle: it takes
      // the same push as the contact surface (never more, so a protruding lamp isn't flattened
      // by a tap)
      along = Math.max(along, 0);
      const want = Math.max(0, depth - along) * wLat;
      const cur = d[q] * dir.x + d[q + 1] * dir.y + d[q + 2] * dir.z;
      if (want <= cur + 1e-4) return;
      const add = want - cur;
      d[q] += dir.x * add; d[q + 1] += dir.y * add; d[q + 2] += dir.z * add;
      // buckling: metal squeezed along the push bulges sideways, most in the middle of the
      // crush band (a hood tents up, fenders flare, a door creases) like a crushed can
      if (this.buckle && depth > 0.04) {
        const c = this.centre;
        let ox = rest[q] - c.x, oy = rest[q + 1] - c.y, oz = rest[q + 2] - c.z;
        const a2 = ox * dir.x + oy * dir.y + oz * dir.z;
        ox -= a2 * dir.x; oy -= a2 * dir.y; oz -= a2 * dir.z;
        const ol = Math.hypot(ox, oy, oz);
        if (ol > 0.05) {
          const wave = Math.sin(Math.PI * Math.min(1, along / depth));
          const b = this.buckle * add * wave * wLat / ol;
          d[q] += ox * b; d[q + 1] += oy * b; d[q + 2] += oz * b;
        }
      }
      moved++;
    });
    if (moved) { this.relax(r, 2); this.version++; }
    return moved;
  }

  // Constraint + smoothing passes over a node range (grown by a margin so propagation can spread).
  relax(r0, smoothIters = 1) {
    const g = 3;
    const r = {
      i0: Math.max(0, r0.i0 - g), i1: Math.min(this.nx - 1, r0.i1 + g),
      j0: Math.max(0, r0.j0 - g), j1: Math.min(this.ny - 1, r0.j1 + g),
      k0: Math.max(0, r0.k0 - g), k1: Math.min(this.nz - 1, r0.k1 + g),
    };
    this.markDirty(r);
    const d = this.disp;
    const S = [this.sx, this.sy, this.sz];
    const strides = [1, this.nx, this.nx * this.ny];
    const clamp = (id) => {
      const q = id * 3, m = Math.hypot(d[q], d[q + 1], d[q + 2]), c = this.cap[id];
      if (m > c) { const s = c / m; d[q] *= s; d[q + 1] *= s; d[q + 2] *= s; }
    };
    const each = (fn) => { for (let k = r.k0; k <= r.k1; k++) for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) fn(this.id(i, j, k), i, j, k); };
    for (let it = 0; it < 6; it++) {
      each(clamp);
      // order / minimum-gap constraint along each axis. The correction is shared in proportion to
      // each node's remaining freedom (its cap), so a stiff cabin node mostly holds and the soft
      // crumple-zone node in front of it takes the squeeze.
      each((id, i, j, k) => {
        const idx = [i, j, k], n = [this.nx, this.ny, this.nz];
        for (let a = 0; a < 3; a++) {
          if (idx[a] + 1 >= n[a]) continue;
          const o = id + strides[a];
          const gap = S[a] + d[o * 3 + a] - d[id * 3 + a];
          const need = MIN_GAP * S[a] - gap;
          if (need <= 0) continue;
          const ca = this.cap[id] + 1e-3, cb = this.cap[o] + 1e-3;
          d[id * 3 + a] -= need * (ca / (ca + cb));
          d[o * 3 + a] += need * (cb / (ca + cb));
        }
      });
    }
    // smoothing: blend each displaced node a little towards its 6-neighbour average
    const tmp = new Float32Array(3);
    for (let it = 0; it < smoothIters; it++) {
      each((id, i, j, k) => {
        const q = id * 3;
        tmp[0] = tmp[1] = tmp[2] = 0;
        let cnt = 0;
        const nb = (ii, jj, kk) => {
          if (ii < 0 || jj < 0 || kk < 0 || ii >= this.nx || jj >= this.ny || kk >= this.nz) return;
          const o = this.id(ii, jj, kk) * 3;
          tmp[0] += d[o]; tmp[1] += d[o + 1]; tmp[2] += d[o + 2]; cnt++;
        };
        nb(i - 1, j, k); nb(i + 1, j, k); nb(i, j - 1, k); nb(i, j + 1, k); nb(i, j, k - 1); nb(i, j, k + 1);
        if (!cnt) return;
        // only smooth up to the neighbours' level (never pull a node deeper than its surroundings
        // average): that removes kinks without blurring a flattened face into the cabin
        for (let a = 0; a < 3; a++) d[q + a] += (tmp[a] / cnt - d[q + a]) * 0.3;
      });
    }
    each(clamp);
    let mx = this.maxDisp;
    each((id) => { const q = id * 3; const m = Math.hypot(d[q], d[q + 1], d[q + 2]); if (m > mx) mx = m; });
    this.maxDisp = mx;
  }
}
