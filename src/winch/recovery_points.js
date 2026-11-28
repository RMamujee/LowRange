// Recovery points: ground anchor posts the maps put where trucks get stuck, derived from the map data
// the way src/spawns.js derives spawn points, so every map (and any new one) gets them for free.
//
// Cruxes, per path (rated trails, The Gauntlet and its side courses, the race track; roads only for
// bogs and fords), scanned along the centreline and both wheel tracks every STEP_DS m:
//   step     the tread (ground, or the top of a fixed rock / ledge slab) rises by STEP_RISE m or more
//            within STEP_RUN m: a ledge, step, waterfall tier or boulder crawl-over
//   climb    the tread climbs at CLIMB_GRADE or steeper for CLIMB_LEN m or more (a climb-out); long
//            climbs get a crux every CHUNK m
//   bog/ford a span of mud or water on the tread; the crux is its far bank (long spans get one every
//            CHUNK m, so a truck bogged anywhere has a point within reach)
//   section  the gate at the end of each Gauntlet stage / side-course section
// Two-way trails are scanned both ways (a drop one way is a climb the other way); The Gauntlet, the
// side courses and the race track only in their driving direction.
//
// Each crux needs a post ahead of the stuck truck within REACH m (a winch line is 20-28 m), in line of
// sight past rocks and trunks. An existing post that qualifies is reused, otherwise one is placed past
// the crux's top beside the tread, searching forward and out to either side until the footprint check
// passes: inside the map, off every tread (path centreline further than width/2 + TREAD_MARGIN),
// dry and firm (no water / bog within a metre), on ground no steeper than POST_SLOPE (BANK_SLOPE where
// nothing flatter is in reach), no more than BELOW m under the stuck nose, and clear of every
// rock, trunk, box prop and loose prop. A crux with no such spot is reported (`uncovered`), never
// silently dropped. Deterministic; no three.js and no DOM, so Node tests use it as is.
import { MAP, MAP_ID, SIZE, TRAILS, ROADS, COURSES, TRACK, PROPS, MAT, heightAt, materialAt, pathPoint } from '../terrain.js';

export const RP = {
  STEP_DS: 0.5, STEP_RISE: 0.3, STEP_RUN: 1.5,
  CLIMB_GRADE: 0.3, CLIMB_LEN: 6, CHUNK: 15,
  REACH: 22,            // m from the stuck truck's nose to the post (lines are 20-28 m)
  TREAD_MARGIN: 0.7,    // m beyond a path's half width: posts stay off the tread
  POST_R: 0.35,         // post footprint radius (m)
  POST_SLOPE: 0.8,      // max ground grade at a post...
  BANK_SLOPE: 1.4,      // ...or, where nothing flatter is in reach (a trail on an embankment), driven into the bank
  EDGE: 0.45,           // last resort (a trail on a causeway): a post this far outside the tread edge
  BELOW: 2.5,
  BANK_PAST: 5,         // m past a bog's / ford's far bank a post is tried first (a truck length: winched up to it, the rear is out too)
  AHEAD: 5,             // m a post must be ahead of the stuck nose (along the trail), and PAST_TOP m past
  PAST_TOP: 3,          // the crux's top (counting at most TOP_CAP m to the top): a post beside the obstacle pulls sideways, one past its top
                        // pulls the truck up and over it
  TOP_CAP: 8,           // m a post may sit below the stuck nose (a line pulling down into a gully is no use)
  RING: 0.75,           // ring height above the ground (m): the hook's anchor point
  NOSE: 0.65,           // fairlead height used for the line-of-sight check (m)
  ROCK_OVER: 0.9,       // m a rock may stand above the straight line (the line bends over it)
};

// ---------------------------------------------------------------- spatial helpers
function hashGrid(cell) {
  const m = new Map();
  const key = (i, j) => i * 100003 + j;
  return {
    add(x, z, r, item) {
      for (let i = Math.floor((x - r) / cell); i <= Math.floor((x + r) / cell); i++) for (let j = Math.floor((z - r) / cell); j <= Math.floor((z + r) / cell); j++) {
        const k = key(i, j); let a = m.get(k); if (!a) m.set(k, a = []); a.push(item);
      }
    },
    near(x, z, r, out = []) {
      out.length = 0; const seen = new Set();
      for (let i = Math.floor((x - r) / cell); i <= Math.floor((x + r) / cell); i++) for (let j = Math.floor((z - r) / cell); j <= Math.floor((z + r) / cell); j++) {
        for (const it of m.get(key(i, j)) ?? []) if (!seen.has(it)) { seen.add(it); out.push(it); }
      }
      return out;
    },
  };
}

// convex hull (monotone chain) of [x, z] points
function hull2(P) {
  const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
const inHull = (H, x, z) => {
  for (let i = 0; i < H.length; i++) { const a = H[i], b = H[(i + 1) % H.length]; if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false; }
  return H.length >= 3;
};

// Fixed rocks as world-space records: centre, reach, top, hull and the points of their upper surface.
export function rockRecords(rocks) {
  const out = [];
  for (const r of rocks) {
    const c = Math.cos(r.rotY), s = Math.sin(r.rotY), W = [];
    let reach = 0, top = -Infinity, bot = Infinity;
    for (let i = 0; i < r.pts.length; i += 3) {
      const px = r.pts[i], py = r.pts[i + 1], pz = r.pts[i + 2];
      // three.js / Rapier yaw about +y: x' = x cos + z sin, z' = -x sin + z cos
      const wx = r.x + px * c + pz * s, wz = r.z - px * s + pz * c, wy = r.y + py;
      W.push([wx, wy, wz]); reach = Math.max(reach, Math.hypot(px, pz)); top = Math.max(top, wy); bot = Math.min(bot, wy);
    }
    const ground = heightAt(r.x, r.z);
    if (top < ground + 0.05) continue; // buried: part of the ground
    const cut = top - 0.35 * (top - bot);
    out.push({ x: r.x, z: r.z, r: reach, top, ground, embed: !!r.embed, ledge: !!r.ledge, hull: hull2(W.map((q) => [q[0], q[2]])), upper: W.filter((q) => q[1] >= cut) });
  }
  return out;
}

// Half width of a path's tread at arc length s: wide crawl corridors carry a width per point
// (pts[i].w, with pts[i].s); every other path has one width.
function halfWidthAt(p, s) {
  const P = p.pts;
  if (!P?.length || P[0].w == null || P[0].s == null) return p.width / 2;
  let lo = 0, hi = P.length - 1;
  if (s <= P[0].s) return P[0].w / 2;
  if (s >= P[hi].s) return P[hi].w / 2;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].s <= s) lo = m; else hi = m; }
  const f = (s - P[lo].s) / Math.max(1e-6, P[hi].s - P[lo].s);
  return (P[lo].w + (P[hi].w - P[lo].w) * f) / 2;
}
// The lines a truck may be on along a path: a wide corridor's marked lines (easy / hard / extreme:
// p.lineAt(name, s), lateral offset from the centreline), each line that strays more than half a
// metre from the others; else just the centreline.
function pathLines(p) {
  if (!p.lines || typeof p.lineAt !== 'function') return [{ name: '', lat: () => 0 }];
  const out = [];
  for (const name of ['easy', 'hard', 'extreme']) {
    const L = p.lines[name]; if (!L) continue;
    if (out.some((o) => L.every(([, lat], i) => Math.abs(lat - o.arr[i][1]) < 0.5))) continue;
    out.push({ name, arr: L, lat: (s) => p.lineAt(name, s) });
  }
  return out.length ? out : [{ name: '', lat: () => 0 }];
}

// ---------------------------------------------------------------- the build
// opts: { rocks, trees, extra (loose / dressing props with pos + halfLen or x, z, r), warn }
export function buildRecoveryPoints(opts = {}) {
  const warn = opts.warn ?? (() => {});
  const lim = SIZE / 2 - 6;
  const rockRecs = rockRecords(opts.rocks ?? []);
  const rockGrid = hashGrid(8);
  for (const r of rockRecs) rockGrid.add(r.x, r.z, r.r, r);
  // obstacles for the post footprint and the line of sight: discs with a top height
  const obsGrid = hashGrid(8);
  const addObs = (x, z, r, top, kind, rock = null) => obsGrid.add(x, z, r, { x, z, r, top, kind, rock });
  for (const r of rockRecs) addObs(r.x, r.z, r.r, r.top, r.embed ? 'embedded rock' : 'rock', r); // rocks: tested against their hull
  for (const t of opts.trees ?? []) addObs(t.x, t.z, 0.22 * (t.s ?? 1), Infinity, 'tree');
  for (const b of PROPS) addObs(b.x, b.z, Math.hypot(b.hx, b.hz), (b.y ?? heightAt(b.x, b.z)) + (b.hy ?? 1), 'prop');
  for (const st of MAP.LOOSE?.stones ?? []) addObs(st.x, st.z, 0.35 * (st.s ?? 1), heightAt(st.x, st.z) + 0.4, 'loose stone');
  for (const lg of MAP.LOOSE?.logs ?? []) addObs(lg.x, lg.z, (lg.sx ?? 2.5) / 2, heightAt(lg.x, lg.z) + 0.5, 'loose log');
  for (const e of opts.extra ?? []) {
    const x = e.x ?? e.pos?.x, z = e.z ?? e.pos?.z;
    if (Number.isFinite(x) && Number.isFinite(z)) addObs(x, z, e.r ?? e.halfLen ?? 0.5, (e.pos?.y ?? heightAt(x, z)) + (e.halfExt?.[1] ?? 0.4) * 2, 'loose');
  }

  // every path's tread, for the "off the tread" rule
  const all = [...TRAILS, ...COURSES, ...ROADS, ...(TRACK ? [TRACK] : [])];
  const segGrid = hashGrid(16);
  for (const p of all) for (let i = 1; i < p.pts.length; i++) {
    const a = p.pts[i - 1], b = p.pts[i];
    const hw = Math.max(a.w ?? p.width, b.w ?? p.width, p.width) / 2; // a wide crawl corridor is tread across its width
    segGrid.add((a.x + b.x) / 2, (a.z + b.z) / 2, Math.hypot(b.x - a.x, b.z - a.z) / 2 + hw + 2, { a, b, hw });
  }
  const tmp = [];
  const onTread = (x, z, margin = RP.TREAD_MARGIN) => {
    for (const q of segGrid.near(x, z, 1, tmp)) {
      const ex = q.b.x - q.a.x, ez = q.b.z - q.a.z, L2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - q.a.x) * ex + (z - q.a.z) * ez) / L2));
      if (Math.hypot(x - q.a.x - ex * t, z - q.a.z - ez * t) < q.hw + margin) return true;
    }
    return false;
  };

  // tread height: ground, or the top of a fixed rock standing on it (embedded rocks are low relief)
  const rk = [];
  const rockTop = (x, z) => {
    let best = -Infinity;
    for (const r of rockGrid.near(x, z, 0.1, rk)) {
      if (r.embed || Math.hypot(x - r.x, z - r.z) > r.r || !inHull(r.hull, x, z)) continue;
      let sw = 0, sy = 0;
      for (const q of r.upper) { const w = 1 / (0.05 + (q[0] - x) ** 2 + (q[2] - z) ** 2); sw += w; sy += w * q[1]; }
      best = Math.max(best, sy / sw);
    }
    return best;
  };
  const tread = (x, z) => Math.max(heightAt(x, z), rockTop(x, z));
  // a rock's own top at (x, z) (its upper surface), and how far (x, z) is outside its hull (0 inside)
  const topOf = (r, x, z) => { let sw = 0, sy = 0; for (const q of r.upper) { const w = 1 / (0.05 + (q[0] - x) ** 2 + (q[2] - z) ** 2); sw += w; sy += w * q[1]; } return sy / sw; };
  const hullDist = (r, x, z) => {
    if (inHull(r.hull, x, z)) return 0;
    let d = Infinity;
    for (let i = 0; i < r.hull.length; i++) {
      const a = r.hull[i], b = r.hull[(i + 1) % r.hull.length], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
      d = Math.min(d, Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t));
    }
    return d;
  };

  // post footprint
  const ob = [];
  const footprint = (x, z, slope = RP.POST_SLOPE, margin = RP.TREAD_MARGIN) => {
    if (!(Math.abs(x) < lim && Math.abs(z) < lim)) return 'outside the map';
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const m = materialAt(x + dx, z + dz);
      if (m === MAT.WATER || m === MAT.MUD) return m === MAT.WATER ? 'water' : 'bog';
    }
    if (onTread(x, z, margin)) return 'tread';
    const g = Math.hypot(heightAt(x + 0.7, z) - heightAt(x - 0.7, z), heightAt(x, z + 0.7) - heightAt(x, z - 0.7)) / 1.4;
    if (g > slope) return 'slope';
    for (const o of obsGrid.near(x, z, RP.POST_R + 0.3, ob)) {
      if (Math.hypot(o.x - x, o.z - z) >= o.r + RP.POST_R + 0.15) continue;
      if (!o.rock || hullDist(o.rock, x, z) < RP.POST_R + 0.15) return o.kind;
    }
    return null;
  };
  const ob2 = [];
  // line of sight from a stuck nose B to a ring Q: no trunk, prop or rock standing above the line
  const sight = (B, Q) => {
    const L = Math.hypot(Q.x - B.x, Q.z - B.z);
    const seen = new Set();
    for (let s = 0; s <= L; s += 2) {
      const t = s / Math.max(L, 1e-6), x = B.x + (Q.x - B.x) * t, z = B.z + (Q.z - B.z) * t;
      for (const o of obsGrid.near(x, z, 1.5, ob2)) {
        if (seen.has(o)) continue; seen.add(o);
        const ex = Q.x - B.x, ez = Q.z - B.z, L2 = ex * ex + ez * ez || 1;
        const u = Math.max(0, Math.min(1, ((o.x - B.x) * ex + (o.z - B.z) * ez) / L2));
        if (u * L < 0.8 || (1 - u) * L < 0.6) continue; // touching the truck's nose or the post itself
        if (o.rock) {
          // a rock: walk the line across its hull; the line may ride over it where it stands no more
          // than ROCK_OVER m above the line (it bends over one crest in game, src/winch/winch.js)
          for (let k = 0; k <= 1; k += 0.25 / Math.max(L, 1e-6)) {
            const x2 = B.x + ex * k, z2 = B.z + ez * k;
            if (k * L < 0.8 || (1 - k) * L < 0.6 || Math.hypot(x2 - o.x, z2 - o.z) > o.r || !inHull(o.rock.hull, x2, z2)) continue;
            if (topOf(o.rock, x2, z2) > B.y + (Q.y - B.y) * k + RP.ROCK_OVER) { sight.blocker = o; return false; }
          }
          continue;
        }
        if (Math.hypot(o.x - B.x - ex * u, o.z - B.z - ez * u) > o.r * 0.8) continue;
        // a trunk or prop blocks if it stands above the line
        if (o.top > B.y + (Q.y - B.y) * u) { sight.blocker = o; return false; }
      }
    }
    return true;
  };

  const posts = [], cruxes = [], uncovered = [];
  const ahead = (cx, P) => (P.x - cx.B.x) * cx.dir.x + (P.z - cx.B.z) * cx.dir.z > Math.max(RP.AHEAD, Math.min(RP.TOP_CAP, Math.abs(cx.sTop - cx.s)) + RP.PAST_TOP);
  const covers = (P, cx) => Math.hypot(P.x - cx.B.x, P.z - cx.B.z) <= RP.REACH && P.y > cx.B.y - RP.BELOW && ahead(cx, P) && sight(cx.B, P);

  // place (or reuse) a post for a crux: cx = { path, sTop, sig, B (nose, with y), dir (unit, travel) }
  function cover(cx) {
    const found = posts.find((P) => covers(P, cx));
    if (found) { cx.post = found.id; found.cruxes.push(cx.id); return true; }
    const p = cx.path;
    // offsets out from the tread edge where the post is tried (its half width is taken at the try's own
    // s, so a wide corridor's posts go beyond its edge, not into it); a = metres past the crux's top
    const tries = [];
    for (const a of [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]) for (const off of [1.0, 1.8, 2.8, 4, 5.5, 7.5, 10]) for (const side of [1, -1]) tries.push([a, off, side]);
    // nearest straight ahead of the stuck nose first: the pull angle matters more than the distance
    const aTop = Math.abs(cx.sTop - cx.s), latOf = (a, off, side) => side * (halfWidthAt(p, cx.sTop + cx.sig * a) + off);
    const cost = ([a, off, side]) => { const d = Math.abs(latOf(a, off, side) - (cx.lat ?? 0)); return d / (aTop + a) * 12 + a * 0.3 + d * 0.3; };
    // a bog's or ford's post stands at least BANK_PAST m past the far bank where it can, so a truck
    // winched right up to it has its rear tyres out of the mud too
    const wet = cx.kind === 'bog' || cx.kind === 'ford', near = ([a]) => (wet && a < RP.BANK_PAST ? 1 : 0);
    tries.sort((u, w) => near(u) - near(w) || cost(u) - cost(w));
    const why = cx.why = {};
    const no = (w) => { why[w] = (why[w] || 0) + 1; };
    const edge = [];
    for (const a of [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]) for (const side of [1, -1]) edge.push([a, RP.EDGE + 0.05, side]);
    // last of all, short of the crux's top (still AHEAD / PAST_TOP ahead of the nose): a long, wide bog's
    // first stretch, where the bank past the top is out of reach from a line far out to one side
    const short = [];
    for (const a of [0, -2, -4, -6]) for (const off of [1.0, 1.8, 2.8, 4, 5.5, 7.5]) for (const side of [1, -1]) short.push([a, off, side]);
    short.sort((u, w) => cost(u) - cost(w));
    for (const [slope, margin, list] of [[RP.POST_SLOPE, RP.TREAD_MARGIN, tries], [RP.BANK_SLOPE, RP.TREAD_MARGIN, tries], [RP.BANK_SLOPE, RP.EDGE, edge], [RP.POST_SLOPE, RP.TREAD_MARGIN, short], [RP.BANK_SLOPE, RP.TREAD_MARGIN, short]]) for (const [a, off, side] of list) {
      const s = cx.sTop + cx.sig * a;
      if (!p.closed && (s < 0 || s > p.length)) { no('path end'); continue; }
      const lat = latOf(a, off, side);
      const q = pathPoint(p, p.closed ? ((s % p.length) + p.length) % p.length : s);
      const x = +(q.x - q.tz * lat).toFixed(2), z = +(q.z + q.tx * lat).toFixed(2); // (checked where it is stored)
      const f = footprint(x, z, slope, margin);
      if (f) { no(f); continue; }
      const P = { x, z, y: heightAt(x, z) + RP.RING };
      if (Math.hypot(P.x - cx.B.x, P.z - cx.B.z) > RP.REACH) { no('reach'); continue; }
      if (P.y < cx.B.y - RP.BELOW) { no('below'); continue; }
      if (!ahead(cx, P)) { no('behind'); continue; }
      if (!sight(cx.B, P)) { no('sight'); continue; }
      const post = { id: `rp-${posts.length + 1}`, x, z, ground: +heightAt(x, z).toFixed(3), y: +P.y.toFixed(3), kind: 'post', r: RP.POST_R, path: p.name, cruxes: [cx.id], slope, margin };
      posts.push(post); cx.post = post.id;
      return true;
    }
    return false;
  }

  const scanPaths = [];
  for (const t of TRAILS) if (t.graded !== false) scanPaths.push({ p: t, dirs: t.oneWay ? [1] : [1, -1], obstacles: true });
  for (const c of COURSES) scanPaths.push({ p: c, dirs: [1], obstacles: true, sections: true });
  if (TRACK) scanPaths.push({ p: TRACK, dirs: [1], obstacles: true });
  for (const r of ROADS) scanPaths.push({ p: r, dirs: [1, -1], obstacles: false });
  // The Gauntlet: its stages are sections too
  for (const sp of scanPaths) if (sp.p.stages) sp.sections = true;

  for (const { p, dirs, obstacles, sections } of scanPaths) {
    const L = p.length, ds = RP.STEP_DS, n = Math.floor(L / ds);
    // a wide crawl corridor is scanned along each of its marked lines (a truck stuck on the deep line
    // of a bog, or in a pit off it, needs a post it can reach from there); other paths along the centreline
    const lines = pathLines(p);
    for (const line of lines) {
    const S = [], H = [], M = [], LAT = [];
    for (let i = 0; i <= n; i++) {
      const s = i * ds, c = pathPoint(p, s), lx = -c.tz, lz = c.tx, lat = line.lat(s);
      const q = { ...c, x: c.x + lx * lat, z: c.z + lz * lat };
      S.push(q); LAT.push(lat);
      let h = -Infinity;
      for (const o of [0, -0.8, 0.8]) h = Math.max(h, tread(q.x + lx * o, q.z + lz * o));
      H.push(h);
      M.push(materialAt(q.x, q.z));
    }
    const mk = (kind, sig, iBot, iTop, extra = {}) => {
      const qb = S[iBot], dir = { x: qb.tx * sig, z: qb.tz * sig };
      const B = { x: qb.x, z: qb.z, y: H[iBot] + RP.NOSE };
      const cx = { id: `${MAP_ID}:${p.name}${line.name ? '/' + line.name : ''}:${kind}:${sig > 0 ? 'up' : 'down'}:${(iBot * ds).toFixed(1)}`, kind, path: p, pathName: p.name, line: line.name || null, lat: LAT[iBot], sig, s: +(iBot * ds).toFixed(1), sTop: iTop * ds, B, dir, ...extra };
      cruxes.push(cx);
      if (!cover(cx)) uncovered.push(cx);
    };
    for (const sig of dirs) {
      const order = sig > 0 ? [...Array(n + 1).keys()] : [...Array(n + 1).keys()].reverse();
      const at = (k) => order[k];
      const run = Math.round(RP.STEP_RUN / ds);
      if (obstacles) {
        // steps
        for (let k = 0; k + run < order.length; k++) {
          const i0 = at(k), i1 = at(k + run);
          if (H[i1] - H[i0] >= RP.STEP_RISE) {
            const iBot = at(Math.max(0, k - Math.round(1 / ds)));
            mk('step', sig, iBot, i1, { rise: +(H[i1] - H[i0]).toFixed(2) });
            k += run + Math.round(2 / ds);
          }
        }
        // climbs: grade over 4 m windows
        const w = Math.round(4 / ds);
        let k0 = -1;
        for (let k = 0; k + w < order.length + 1; k++) {
          const steep = k + w < order.length && (H[at(k + w)] - H[at(k)]) / (w * ds) >= RP.CLIMB_GRADE;
          if (steep && k0 < 0) k0 = k;
          if (!steep && k0 >= 0) {
            const kEnd = Math.min(order.length - 1, k + w - 1), len = (kEnd - k0) * ds;
            if (len >= RP.CLIMB_LEN) {
              for (let kb = k0 + Math.round(Math.min(len / 2, RP.CHUNK / 2) / ds); kb < kEnd; kb += Math.round(RP.CHUNK / ds)) {
                mk('climb', sig, at(kb), at(Math.min(kEnd, kb + Math.round(RP.CHUNK / ds))));
              }
            }
            k0 = -1;
          }
        }
      }
      // bogs and fords: far bank (and every CHUNK m along a long one)
      let k0 = -1;
      for (let k = 0; k <= order.length; k++) {
        const m = k < order.length ? M[at(k)] : -1, wet = m === MAT.MUD || m === MAT.WATER;
        if (wet && k0 < 0) k0 = k;
        if (!wet && k0 >= 0) {
          const kEnd = k - 1, kind = M[at(k0)] === MAT.WATER || M[at(kEnd)] === MAT.WATER ? 'ford' : 'bog';
          if ((kEnd - k0) * ds >= 2) {
            const step = Math.round(RP.CHUNK / ds), marks = [];
            for (let kb = kEnd; kb > k0; kb -= step) marks.push(kb);
            for (const kb of marks.reverse()) mk(kind, sig, at(Math.max(k0, kb - Math.round(Math.min(RP.CHUNK, (kEnd - k0) * ds) / ds))), at(kb), { far: kb === kEnd });
          }
          k0 = -1;
        }
      }
    }
    if (sections && line === lines[0]) {
      for (const st of p.stages) {
        if (st.n === 1) continue;
        const iTop = Math.min(n, Math.round(st.gateS / ds)), iBot = Math.max(0, Math.round((st.gateS - 6) / ds));
        mk('section', 1, iBot, iTop, { section: st.n, name: st.name });
      }
    }
    }
  }
  for (const cx of uncovered) warn(`[winch] ${MAP_ID}: no recovery point for the ${cx.kind} at ${cx.pathName} s=${cx.s} (tries failed on: ${Object.entries(cx.why || {}).map(([k, v]) => `${k} x${v}`).join(', ')})`);
  posts.forEach((P, i) => { P.name = `Recovery point ${i + 1}`; });
  return { posts, cruxes, uncovered, footprint, sight, tread };
}
