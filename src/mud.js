// Deformable mud: the state of every bog on the map (ruts, dug holes, churned slurry, berms) and
// the soft-soil numbers the tyre model reads from it. Headless (no three.js), so the physics tests
// run it in Node; src/fx/mud_view.js draws the same state as the mud's visible surface.
//
// The baked map gives each bog a shown surface (GRID.vis: the top of the mud) and, lower down, a
// firm floor (GRID.h, the heightfield the physics engine collides with). Between the two is soft
// mud. A tyre in it is held up by the mud's bearing pressure, which grows with how deep it has
// sunk (Bekker style, p = k z), over a footprint that lengthens as it sinks and that airing down
// widens and lengthens. So it settles where the mud carries its load: heavy, narrow, hard tyres
// sink deeper. Driving works the mud on a 0.2 m lattice of nodes, kept only over the bogs:
//
//   r     rut: how far the shown surface is pressed down (the tyre's track, kept for good)
//   e     excavated: mud a spinning tyre has dug out and thrown (the bearing surface drops)
//   w     churn: remoulded slurry; every pass and every spin softens the mud (k / (1 + w)), so a
//         rut gets deeper with each pass and a spinning wheel digs itself in
//   berm  mud squeezed up beside a rut
//   t     when the node was last worked (the view keeps fresh ruts wet and dark)
//
// Sinkage costs: the work of pressing the rut (compaction resistance, b k z^2 / 2 per tyre) and a
// viscous drag that grows with depth; the truck's belly dragging in the mud carries weight off the
// tyres. src/vehicle.js applies all of these (look for [mud]).

export const NODE = 0.2;          // lattice spacing (m)
export const TILE = 32;           // nodes per tile side (6.4 m)
export const MUD = {
  K: 240e3,        // bearing modulus of fresh bog mud (Pa per m of sinkage)
  LEN: 1.3,        // footprint length = LEN * sqrt(2 R z) + flat patch
  FLAT: 0.06,      // flat patch of a tyre at road pressure (m)
  FLAT_AIRED: 0.2, // aired down: a longer flat patch...
  WIDE_AIRED: 1.12, // ...and a wider one
  DAMP: 3.5e4,     // vertical damping of the mud (N s/m per m^2 of footprint)
  PLOUGH: 1.0,     // compaction resistance scale (b k z^2 / 2)
  VISC: 260,       // viscous drag per tyre of 0.35 m width up to 0.15 m sinkage, rising to 1.5x (N per m/s)
  RR_FLOOR: 0.03,  // rolling resistance left once compaction resistance takes over from the surface's rr
  DAMP_MAX: 0.8,   // explicit damping on the wheel body kept to c h / m <= this (stable below 2)
  PLASTIC: 0.85,   // share of the sinkage that stays as a rut
  CHURN_PASS: 0.12, // churn added by one pass of a tyre sunk 0.15 m
  CHURN_SPIN: 1.0, // churn per second per m/s of wheelspin beyond SPIN0
  CHURN_MAX: 1.2,  // fully churned slurry bears k / 2.2
  SPIN0: 0.5,      // wheelspin (m/s of slip) below which a tyre doesn't dig
  DIG: 0.045,      // m of mud dug out per second per m/s of wheelspin beyond SPIN0
  BERM: 0.18,      // share of a new rut's depth squeezed up beside it
  BERM_MAX: 0.12,
  BELLY_K: 50e3,   // bearing modulus under a flat belly (Pa per m)
  BELLY_MU: 0.4,   // belly sliding on mud: drag per unit of weight it carries
};

const key = (ti, tj) => (ti + 4096) * 8192 + (tj + 4096);
const N2 = TILE * TILE;

export class MudField {
  // grid: a map's baked grid ({ GRID, SIZE, RES, N1, CELL, heightAt, visualHeightAt })
  constructor(grid) {
    this.grid = grid;
    this.tiles = new Map();
    this.clock = 0;
    const { GRID, SIZE, RES } = grid, N1 = RES + 1, CELL = SIZE / RES;
    this.CELL = CELL; this.N1 = N1; this.half = SIZE / 2;
    // a tile for every patch of the lattice within 1.2 m of a mud vertex
    for (let gx = 0; gx < N1; gx++) for (let gz = 0; gz < N1; gz++) {
      if (GRID.mat[gx * N1 + gz] !== 3) continue; // MAT.MUD
      const x = gx * CELL - this.half, z = gz * CELL - this.half;
      const t0 = Math.floor((x - 1.2) / NODE / TILE), t1 = Math.floor((x + 1.2) / NODE / TILE);
      const u0 = Math.floor((z - 1.2) / NODE / TILE), u1 = Math.floor((z + 1.2) / NODE / TILE);
      for (let ti = t0; ti <= t1; ti++) for (let tj = u0; tj <= u1; tj++) this.tile(ti, tj, true);
    }
  }

  tile(ti, tj, make = false) {
    const k = key(ti, tj);
    let t = this.tiles.get(k);
    if (!t && make) {
      t = { ti, tj, e: new Float32Array(N2), r: new Float32Array(N2), w: new Float32Array(N2), berm: new Float32Array(N2), t: new Float32Array(N2).fill(-1e9), m: new Float32Array(N2), ver: 0 };
      for (let a = 0; a < TILE; a++) for (let b = 0; b < TILE; b++) t.m[a * TILE + b] = this.mudness((ti * TILE + a) * NODE, (tj * TILE + b) * NODE);
      this.tiles.set(k, t);
    }
    return t;
  }

  // share of mud at (x, z): bilinear over the baked material grid, 0..1
  mudness(x, z) {
    const { GRID } = this.grid, N1 = this.N1;
    const fx = Math.min(N1 - 1.001, Math.max(0, (x + this.half) / this.CELL)), fz = Math.min(N1 - 1.001, Math.max(0, (z + this.half) / this.CELL));
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const M = (a, b) => (GRID.mat[a * N1 + b] === 3 ? 1 : 0);
    return M(ix, iz) * (1 - tx) * (1 - tz) + M(ix + 1, iz) * tx * (1 - tz) + M(ix, iz + 1) * (1 - tx) * tz + M(ix + 1, iz + 1) * tx * tz;
  }

  // node (ix, iz) of the global lattice: its index in tile this.nt, or -1 outside the bogs
  // (no allocation: this runs hundreds of thousands of times a second while rutting)
  node(ix, iz) {
    const ti = Math.floor(ix / TILE), tj = Math.floor(iz / TILE);
    const t = this.tiles.get(key(ti, tj));
    if (!t) return -1;
    this.nt = t;
    return (ix - ti * TILE) * TILE + (iz - tj * TILE);
  }

  // bilinear state at (x, z) into `out` ({ e, w, berm, r, m }); m = 0 off the bogs
  sample(x, z, out) {
    const fx = x / NODE, fz = z / NODE, ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    out.e = out.w = out.berm = out.r = out.m = 0;
    for (let k = 0; k < 4; k++) {
      const a = k & 1, b = k >> 1, i = this.node(ix + a, iz + b);
      if (i < 0) continue;
      const t = this.nt, wt = (a ? tx : 1 - tx) * (b ? tz : 1 - tz);
      out.e += t.e[i] * wt; out.w += t.w[i] * wt; out.berm += t.berm[i] * wt; out.r += t.r[i] * wt; out.m += t.m[i] * wt;
    }
    return out;
  }

  // height of the shown mud surface (the view draws this)
  surfaceAt(x, z, s = this._s || (this._s = {})) {
    this.sample(x, z, s);
    return this.grid.visualHeightAt(x, z) - s.r + s.berm;
  }

  // Soft-soil contact of one tyre whose lowest point is at (x, yb, z): radius R, width b.
  // Fills `out` with z (sinkage into the bearing surface), F (bearing force, N), A (footprint
  // area, m^2), plough (compaction resistance, N), visc (viscous drag coefficient, N per m/s),
  // m (mud share), k (effective modulus); F = 0 when the tyre is above the mud.
  // aired: the tyre pressure's air fraction f (src/tyres/pressure.js: 0 at road pressure, 1 at crawl
  // pressure, more below), or the old true / false. The footprint is mix(road, crawl, f).
  tyre(x, z, yb, R, b, aired, out) {
    const s = this.sample(x, z, out);
    out.z = 0; out.F = 0; out.A = 0; out.plough = 0; out.visc = 0; out.k = 0;
    if (s.m < 0.01) return out;
    const Z = Math.min(0.7, this.grid.visualHeightAt(x, z) - s.e + s.berm - yb);
    if (Z <= 0) return out;
    const { bw, flat } = footprint(b, aired);
    const L = MUD.LEN * Math.sqrt(2 * R * Z) + flat;
    const k = (MUD.K * s.m) / (1 + s.w);
    out.z = Z; out.A = bw * L; out.k = k;
    out.F = k * Z * out.A;
    out.plough = MUD.PLOUGH * bw * k * Z * Z * 0.5;
    // at least the old flat mud drag in shallow mud (the race track's verge), more when deep
    out.visc = MUD.VISC * s.m * (bw / 0.35) * Math.min(1.5, Math.max(1, Z / 0.15));
    out.L = L; out.bw = bw;
    return out;
  }

  // A tyre working the mud for h seconds at its lowest point (x, z), rolling along (dx, dz)
  // (unit, horizontal) at roll m/s, spinning at slip m/s, sunk Z into width bw over length L.
  work(x, z, dx, dz, bw, L, Z, roll, slip, h) {
    const spin = Math.max(0, Math.abs(slip) - MUD.SPIN0);
    const churn = (MUD.CHURN_PASS * (Z / 0.15) * Math.abs(roll)) / Math.max(0.2, L) * h + MUD.CHURN_SPIN * spin * h;
    const dig = MUD.DIG * spin * h;
    const hw = bw / 2, reach = hw + 0.32, along = Math.max(0.12, L / 2);
    const ex = -dz, ez = dx; // across the tyre
    const i0 = Math.floor((x - reach - along) / NODE), i1 = Math.ceil((x + reach + along) / NODE);
    const j0 = Math.floor((z - reach - along) / NODE), j1 = Math.ceil((z + reach + along) / NODE);
    for (let ix = i0; ix <= i1; ix++) for (let iz = j0; iz <= j1; iz++) {
      const i = this.node(ix, iz);
      if (i < 0) continue;
      const t = this.nt;
      if (t.m[i] < 0.01) continue;
      const px = ix * NODE - x, pz = iz * NODE - z;
      const lon = Math.abs(px * dx + pz * dz), lat = Math.abs(px * ex + pz * ez);
      if (lon > along + NODE) continue;
      const fl = lon <= along ? 1 : 1 - (lon - along) / NODE;
      if (lat < hw + 0.1) { // under the tread: dig, churn, press the rut
        const prof = fl * (lat < hw - 0.03 ? 1 : 0.5 + 0.5 * Math.cos(((lat - hw + 0.03) / 0.13) * Math.PI));
        if (dig > 0) {
          const nx = ix * NODE, nz = iz * NODE, room = this.grid.visualHeightAt(nx, nz) - this.grid.heightAt(nx, nz) - 0.02;
          t.e[i] = Math.min(Math.max(0, room), t.e[i] + dig * prof);
        }
        t.w[i] = Math.min(MUD.CHURN_MAX, t.w[i] + churn * prof);
        const rut = (t.e[i] + MUD.PLASTIC * Z) * prof;
        if (rut > t.r[i] + 1e-4) {
          const grow = rut - t.r[i];
          t.r[i] = rut;
          t.berm[i] = Math.max(0, t.berm[i] - grow); // pressed flat again
          this.berm(ix, iz, ex, ez, hw, grow * fl);
        }
        t.t[i] = this.clock; t.ver++;
      }
    }
  }

  // squeeze mud up into the nodes 0.08-0.3 m beyond the tread edge, on the side of (ix, iz)
  berm(ix, iz, ex, ez, hw, grow) {
    const px = ix * NODE, pz = iz * NODE;
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const d = hw + 0.18;
      const i = this.node(Math.round((px + ex * sgn * d) / NODE), Math.round((pz + ez * sgn * d) / NODE));
      if (i < 0) continue;
      const t = this.nt;
      if (t.r[i] > 0.02 || t.m[i] < 0.01) continue; // not into the neighbouring rut
      t.berm[i] = Math.min(MUD.BERM_MAX, t.berm[i] + grow * MUD.BERM * 0.5);
      t.ver++;
    }
  }

  // forget every rut (a fresh map)
  clear() {
    for (const t of this.tiles.values()) { t.e.fill(0); t.r.fill(0); t.w.fill(0); t.berm.fill(0); t.t.fill(-1e9); t.ver++; }
  }
}

// [tyre pressure] footprint width and flat patch length for a tyre of width b: the road-pressure
// numbers at f = 0, exactly the old aired-down ones at f = 1 (a * (1 - f) + b * f), longer and
// wider still below crawl pressure. f may also be the old boolean.
export function footprint(b, aired) {
  const f = aired === true ? 1 : aired === false || aired === undefined ? 0 : aired;
  return { bw: b * Math.max(0.9, 1 * (1 - f) + MUD.WIDE_AIRED * f), flat: Math.max(0.03, MUD.FLAT * (1 - f) + MUD.FLAT_AIRED * f) };
}

// Vertical damping coefficient of the mud under a tyre (N s/m): DAMP x footprint, capped so the
// explicit impulse on a wheel body of mass m over a step h stays well inside stability
// (c h / m <= DAMP_MAX; the limit is 2) even deep in the mud, aired down, on the lightest wheel.
export function mudDamping(A, m, h) {
  return Math.min(MUD.DAMP * A, (MUD.DAMP_MAX * m) / h);
}

// Static sinkage of a tyre carrying `load` N in fresh (w = 0) or churned mud: where k z A(z) = load.
// aired: true / false, or the tyre pressure's air fraction f (see MudField.tyre).
export function staticSinkage(load, R, b, aired = false, w = 0) {
  const { bw, flat } = footprint(b, aired), k = MUD.K / (1 + w);
  let lo = 0, hi = 0.7;
  for (let i = 0; i < 50; i++) { const z = (lo + hi) / 2; if (k * z * bw * (MUD.LEN * Math.sqrt(2 * R * z) + flat) > load) hi = z; else lo = z; }
  return (lo + hi) / 2;
}
