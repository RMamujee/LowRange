// Wide rock crawls (BeamNG-style crawl areas) for the island and the desert: a broad corridor of
// obstacles between a start gate and a finish gate where the driver reads the ground and picks a
// line, instead of one narrow tread with one answer. Used only by src/maps/jungle.js and
// src/maps/desert.js (the Trail Park and The Gauntlet build their trails their own way).
//
// The model:
// - The trail's centreline is the EASY line and stays the reference path (progress, Y restart,
//   autopilot, gates). `t.width` stays the gate mouth: the corridor pinches to it at both ends, so
//   the gates, their spawn points and the junctions with the roads behave as before.
// - Each path point carries the corridor's half-widths: `wl` on the +lat side (the side of
//   (-tz, tx), the side every map offsets with `p.x - p.tz * lat, p.z + p.tx * lat`) and `wr` on the
//   other side. The bake labels every cell inside them as the trail (GRID.path), so the whole
//   corridor counts as "on the trail".
// - Cruxes: along the trail, each with lanes side by side (easy at lat 0, then hard, extreme), each
//   lane with its own feature (ledges, a boulder field, a slab, an off-camber shelf, cross-axle
//   holes, V-notches, crawl rocks, a slot between fins, step-ups). The harder lines are
//   `t.lines.hard(s)` / `t.lines.extreme(s)` (a lateral offset from the centreline, held through
//   each crux and blended between them) and every feature is listed in `t.cruxes` (for recovery
//   points, previews and tests), so nothing exists only in the baked grid.
import { clamp, smooth, lerp, pathPoint } from './common.js';

export const LANE_W = 4.4;      // default lane width (rigs are 1.8-2.1 m wide)
const LINE_NAMES = ['easy', 'hard', 'extreme'];
const pickLane = (c, line) => {
  const order = line === 'extreme' ? ['extreme', 'hard', 'easy'] : line === 'hard' ? ['hard', 'easy'] : ['easy'];
  for (const n of order) { const l = c.lanes.find((q) => q.line === n); if (l) return l; }
  return c.lanes[0];
};
const bump = (d, r) => (d >= r ? 0 : (1 - (d / r) ** 2) ** 2);

// Index of the path point at or before arc length s (binary search).
function idxAt(pts, s) {
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].s <= s) lo = m; else hi = m; }
  return lo;
}

// Resolve a trail's wide-crawl definition onto the built path `t` (pts with s and h).
// def: { mouth, base: [left, right], ends, cruxes: [{ name, at (0..1) | s, len, lanes: [...] }], widen: [[at, left, right]] }
export function setupWide(t, def) {
  const L = t.length, ends = def.ends ?? 13;
  const cruxes = def.cruxes.map((c, i) => {
    const sc = c.s ?? c.at * L, len = Math.min(c.len ?? 14, L - 2 * ends - 4); // (len longer than the trail: the whole trail between its mouths)
    const s0 = clamp(sc - len / 2, ends + 2, L - ends - 2 - len), s1 = s0 + len;
    return { n: i + 1, name: c.name, s0, s1, lanes: c.lanes.map((l) => ({ w: LANE_W, ...l })), features: [] };
  });
  // the lines: lateral offset from the centreline, held through each crux, blended between them
  const lines = {};
  for (const name of LINE_NAMES) {
    const anchors = [{ s: 0, lat: 0 }, { s: ends + 1, lat: 0 }];
    // (each line lined up on its lane up to 5 m before the crux and 2 m after, as far as the gaps between cruxes allow)
    cruxes.forEach((c, k) => {
      const l = pickLane(c, name), gapB = k ? c.s0 - cruxes[k - 1].s1 : 99, gapA = k < cruxes.length - 1 ? cruxes[k + 1].s0 - c.s1 : 99;
      anchors.push({ s: Math.max(ends + 1.5, c.s0 - Math.min(5, gapB * 0.35)), lat: l.lat }, { s: Math.min(L - ends - 1.5, c.s1 + Math.min(2, gapA * 0.15)), lat: l.lat });
    });
    anchors.push({ s: L - ends - 1, lat: 0 }, { s: L, lat: 0 });
    for (const [a, b] of def.pinch ?? []) anchors.push({ s: a - 4, lat: 0 }, { s: b + 4, lat: 0 }); // (every line through a pinch on the centreline)
    anchors.sort((p, q) => p.s - q.s);
    lines[name] = (s) => {
      let k = 0; while (k < anchors.length - 2 && anchors[k + 1].s <= s) k++;
      const a = anchors[k], b = anchors[k + 1];
      return lerp(a.lat, b.lat, smooth(a.s, b.s, s));
    };
  }
  // corridor half-widths at every path point
  const P = t.pts, base = def.base ?? [t.width / 2, t.width / 2], mouth = t.width / 2;
  const wl = new Float64Array(P.length), wr = new Float64Array(P.length), reqL = new Float64Array(P.length), reqR = new Float64Array(P.length);
  // (open: [from, to] arc lengths where the corridor keeps its base width; elsewhere only the cruxes and lines widen it)
  const open = def.open ?? [0, L];
  P.forEach((p, i) => {
    const s = p.s, inOpen = smooth(open[0] - 8, open[0], s) * smooth(open[1] + 8, open[1], s);
    let l = lerp(mouth, base[0], inOpen), r = lerp(mouth, base[1], inOpen);
    for (const c of cruxes) {
      const env = smooth(c.s0 - 12, c.s0 - 2, s) * smooth(c.s1 + 12, c.s1 + 2, s);
      if (env <= 0) continue;
      for (const ln of c.lanes) {
        const hi = ln.lat + ln.w / 2 + 1.6, lo = ln.lat - ln.w / 2 - 1.6;
        l = Math.max(l, lerp(base[0], hi, env)); r = Math.max(r, lerp(base[1], -lo, env));
      }
    }
    for (const name of LINE_NAMES) { const v = lines[name](s); reqL[i] = Math.max(reqL[i], v + LANE_W / 2 + 1.2); reqR[i] = Math.max(reqR[i], -v + LANE_W / 2 + 1.2); }
    l = Math.max(l, reqL[i]); r = Math.max(r, reqR[i]);
    for (const [at, wL, wR] of def.widen ?? []) { const e = bump(Math.abs(s - at * L), 26); l = Math.max(l, lerp(l, wL, e)); r = Math.max(r, lerp(r, wR, e)); }
    // the gate mouths: pinched to the trail's own width at both ends (and over def.pinch [s0, s1]
    // stretches, e.g. where the trail crosses a road: the road keeps its own surface)
    let pin = smooth(ends, ends + 12, Math.min(s, L - s));
    for (const [a, b] of def.pinch ?? []) pin = Math.min(pin, 1 - smooth(a - 12, a, s) * smooth(b + 12, b, s));
    wl[i] = lerp(mouth, Math.max(mouth, l), pin); wr[i] = lerp(mouth, Math.max(mouth, r), pin); p.pin = pin;
    reqL[i] = lerp(mouth, Math.max(mouth, reqL[i]), pin); reqR[i] = lerp(mouth, Math.max(mouth, reqR[i]), pin);
  });
  // soften the edges along the trail (a corridor, not a staircase of widths)
  for (const arr of [wl, wr]) {
    const src = Float64Array.from(arr);
    for (let i = 0; i < P.length; i++) {
      let a = 0, n = 0;
      for (let j = i - 1; j >= 0 && P[i].s - P[j].s < 5; j--) { a += src[j]; n++; }
      for (let j = i; j < P.length && P[j].s - P[i].s < 5; j++) { a += src[j]; n++; }
      arr[i] = Math.max(src[i] * 0.6 + (a / n) * 0.4, Math.min(src[i], a / n), (arr === wl ? reqL : reqR)[i]);
    }
  }
  P.forEach((p, i) => { p.wl = wl[i]; p.wr = wr[i]; });
  t.wide = true;
  t.lines = lines;
  t.cruxes = cruxes;
  t.maxHalf = Math.max(...wl, ...wr);
  t.halfWidthAt = (s) => { const i = idxAt(P, s), a = P[i], b = P[Math.min(P.length - 1, i + 1)], f = clamp((s - a.s) / Math.max(1e-6, b.s - a.s), 0, 1); return { left: lerp(a.wl, b.wl, f), right: lerp(a.wr, b.wr, f) }; };
  t.pinAt = (s) => { const i = idxAt(P, s), a = P[i], b = P[Math.min(P.length - 1, i + 1)], f = clamp((s - a.s) / Math.max(1e-6, b.s - a.s), 0, 1); return lerp(a.pin, b.pin, f); }; // 0 at the gate mouths and pinches, 1 where the corridor is free to widen
  return t;
}

// ---------------------------------------------------------------- ground features (bake)
// Height offset and rock flag the cruxes' heightfield features add at (s, lat) on trail t:
// slabs (a smooth rock hump on a lane), off-camber shelves (the corridor tilts up outward from
// the easy lane), cross-axle holes (dips under alternate wheels), a gully (a V-trough).
const SH = { dh: 0, rock: false, lane: null };
export function shapeAt(t, s, lat, holeR = 1.3) {
  SH.dh = 0; SH.rock = false; SH.lane = null;
  if (!t.cruxes) return SH;
  for (const c of t.cruxes) {
    if (s < c.s0 - 10 || s > c.s1 + 10) continue;
    const env = smooth(c.s0 - 6, c.s0 + 1, s) * smooth(c.s1 + 6, c.s1 - 1, s);
    for (const ln of c.lanes) {
      const dl = lat - ln.lat, hw = ln.w / 2;
      if (Math.abs(dl) < hw && s >= c.s0 && s <= c.s1) SH.lane = ln;
      if (ln.f === 'slab') {
        // up face at ln.up (grade), flat top, down at ln.down; the sides fall away at ln.side
        const along = Math.min(ln.h, (s - c.s0) * ln.up, (c.s1 - s) * (ln.down ?? ln.up));
        if (along <= 0) continue;
        const h = Math.max(0, along - Math.max(0, Math.abs(dl) - hw) * (ln.side ?? 0.7));
        if (h > 0) { SH.dh += h; SH.rock = true; }
      } else if (ln.f === 'camber') {
        // the ground rises outward from ln.from (lat, signed: the side it rises to) at ln.tilt
        const sg = Math.sign(ln.lat) || 1, u = clamp(sg * lat - ln.from, 0, ln.span ?? (Math.abs(ln.lat) + hw - ln.from));
        SH.dh += ln.tilt * u * env; if (u > 0 && env > 0.5) SH.rock = true;
      } else if (ln.f === 'holes') {
        if (Math.abs(dl) > hw + 1.5) continue;
        const every = ln.every ?? 3.2;
        for (let k = 0, ss = c.s0 + 1.5; ss < c.s1 - 1; k++, ss += every) {
          const side = k % 2 ? 1 : -1, d = Math.hypot(s - ss, dl - side * 0.95);
          if (d < holeR) SH.dh -= ln.depth * bump(d, holeR);
        }
      } else if (ln.f === 'gully') {
        // a V-trough along the lane: its floor ln.depth under the corridor, sides at ln.side
        if (Math.abs(dl) < hw) SH.dh -= Math.max(0, ln.depth - Math.abs(dl) * (ln.side ?? 0.45)) * env;
      }
    }
  }
  return SH;
}

// ---------------------------------------------------------------- rocks
// Place every crux's rock features and the corridor filler. kit: rockKit(R, heightAt).
// env: { stepCap(g), grade(t, s), skip(x, z) (water etc.), spec: { fill, edge, crawlTop } }
export function wideRocks(t, kit, R, env) {
  const { shape, put, reach, ledge } = kit;
  const at = (s, lat) => { const p = pathPoint(t, s); return { x: p.x - p.tz * lat, z: p.z + p.tx * lat, p, nx: -p.tz, nz: p.tx, yaw: Math.atan2(p.tx, p.tz) }; };
  const g = (s) => env.grade(t, s);
  for (const c of t.cruxes) {
    for (const ln of c.lanes) {
      const hw = ln.w / 2, f = ln.f;
      if (f === 'ledge') {
        const n = ln.n ?? 1, every = ln.every ?? (c.s1 - c.s0 - 3) / Math.max(1, n - 1 || 1);
        for (let k = 0; k < n; k++) {
          const s = n === 1 ? (c.s0 + c.s1) / 2 : c.s0 + 1.5 + k * every, q = at(s, ln.lat + (ln.wiggle ? (R() - 0.5) * ln.wiggle : 0));
          const top = Math.min(Array.isArray(ln.top) ? lerp(ln.top[0], ln.top[1], R()) : ln.top, env.stepCap(g(s)));
          const skew = (ln.skew ?? 0) * (k % 2 && ln.alt ? -1 : 1);
          if (env.skip(q.x, q.z) || top < 0.06) continue;
          const depth = ln.depth ?? 3.2 + R() * 0.8;
          ledge(q.x, q.z, q.yaw + skew, ln.w + 0.4, depth, top);
          c.features.push({ type: 'ledge', line: ln.line, s, lat: ln.lat, top: +top.toFixed(3), skew, x: q.x, z: q.z });
        }
      } else if (f === 'boulders') {
        // a rock garden across the lane: staggered rows; `keep` holds the lane's line clear by that
        // half-width (the easy line weaves between rocks crowding it), else the gaps are `gap`
        const [a, b] = ln.size, pitchS = (a + b) / 2 + ln.gap, pitchL = (a + b) / 2 + ln.gap;
        let row = 0;
        for (let s = c.s0 + 1; s < c.s1 - 0.5; s += pitchS * (0.85 + R() * 0.3), row++) {
          for (let o = -hw + (row % 2 ? pitchL / 2 : 0) + 0.3; o <= hw - 0.3; o += pitchL) {
            const lat = ln.lat + o + (R() - 0.5) * 0.5, sz = a + Math.pow(R(), 1.3) * (b - a);
            const r = shape(sz, ln.flat ?? 0.8, 0.35, Math.min(ln.top, env.stepCap(g(s)) + 0.15));
            const side = Math.sign(o) || 1, rr = reach(r, -at(s, 0).nx * side, -at(s, 0).nz * side);
            if (ln.keep !== undefined && Math.abs(lat - ln.lat) < ln.keep + rr) continue;
            const q = at(s, lat);
            if (env.skip(q.x, q.z)) continue;
            put(r, q.x, q.z, true);
            c.features.push({ type: 'boulder', line: ln.line, s, lat, size: +sz.toFixed(2), x: q.x, z: q.z });
          }
        }
        if (ln.keep !== undefined && ln.crawl) addCrawl(c, ln, ln.crawl);
      } else if (f === 'notch') {
        const every = ln.every ?? 6;
        for (let s = c.s0 + 2; s < c.s1 - 1; s += every * (0.85 + R() * 0.3)) {
          const top = Math.min(ln.top, env.stepCap(g(s))), sz = 1.1 + R() * 0.35, base = at(s, 0);
          for (const sd of [1, -1]) {
            const r = shape(sz, 0.55, 0.3, top), lat = ln.lat + sd * ((ln.gap ?? 1.0) / 2 + reach(r, -base.nx * sd, -base.nz * sd)), q = at(s, lat);
            if (!env.skip(q.x, q.z)) put(r, q.x, q.z, true);
          }
          c.features.push({ type: 'notch', line: ln.line, s, lat: ln.lat, top: +top.toFixed(3) });
        }
      } else if (f === 'crawl') addCrawl(c, ln, ln);
      else if (f === 'fin') {
        // a rock fin standing along the lane (a wall between two channels), in pieces
        for (let s = c.s0 + 3.5; s < c.s1 - 2.5; s += ln.piece ?? 4.5) {
          const q = at(s, ln.lat + (R() - 0.5) * 0.6), len = (ln.piece ?? 4.5) * 0.62, hgt = ln.h * (0.8 + R() * 0.4), wid = ln.w / 2, pts = [];
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
            pts.push(sx * wid * (0.85 + R() * 0.3), -0.8, sz * len * (0.9 + R() * 0.2));
            pts.push(sx * wid * (0.45 + R() * 0.3), hgt * (0.85 + R() * 0.15), sz * len * (0.6 + R() * 0.25));
          }
          pts.push((R() - 0.5) * wid * 0.4, hgt * (1 + R() * 0.12), (R() - 0.5) * len * 0.5);
          kit.rocks.push({ x: q.x, y: env.heightAt(q.x, q.z), z: q.z, rotY: q.yaw, pts, fin: true });
          c.features.push({ type: 'fin', s, lat: ln.lat, h: +hgt.toFixed(2) });
        }
      } else if (f === 'slab' || f === 'camber' || f === 'holes' || f === 'gully') {
        c.features.push({ type: f, line: ln.line, s0: c.s0, s1: c.s1, lat: ln.lat, ...(ln.h ? { h: ln.h } : {}), ...(ln.tilt ? { tilt: ln.tilt } : {}), ...(ln.depth ? { depth: ln.depth } : {}) });
        if (ln.crawl) addCrawl(c, ln, ln.crawl);
      }
    }
  }
  function addCrawl(c, ln, o) {
    // crawl rocks in the tyre tracks of a lane (a rock to put a wheel on, every few metres)
    for (let s = c.s0 + 1.5; s < c.s1 - 1; s += (o.every ?? 2.6) * (0.75 + R() * 0.5)) {
      const top = Math.min(o.top, env.stepCap(g(s))), r = shape(0.35 + R() * 0.3, 0.8, 0.35, top), lat = ln.lat + (R() < 0.5 ? -1 : 1) * (0.75 + R() * 0.25), q = at(s, lat);
      if (!env.skip(q.x, q.z)) { put(r, q.x, q.z, true); c.features.push({ type: 'crawl', line: ln.line, s, lat, top: +top.toFixed(3) }); }
    }
  }
  // ---- filler: scattered boulders in the open corridor, never on a line; rocks on the edges ----
  const fill = env.spec.fill, edge = env.spec.edge;
  const lineLats = (s) => LINE_NAMES.map((n) => t.lines[n](s));
  const inCrux = (s) => t.cruxes.some((c) => s > c.s0 - 1 && s < c.s1 + 1);
  if (fill) for (let s = t.cruxes.length ? 16 : 14; s < t.length - 14; s += fill.every * (0.7 + R() * 0.6)) {
    if (inCrux(s)) continue;
    const { left, right } = t.halfWidthAt(s), lat = lerp(-right + 0.8, left - 0.8, R());
    const sz = fill.size[0] + Math.pow(R(), 1.5) * (fill.size[1] - fill.size[0]), r = shape(sz, 0.8, 0.35, fill.top);
    const rr = Math.max(reach(r, 1, 0), reach(r, -1, 0), reach(r, 0, 1), reach(r, 0, -1));
    if (lineLats(s).some((v) => Math.abs(v - lat) < LANE_W / 2 + rr + 0.2)) continue;
    const q = at(s, lat);
    if (!env.skip(q.x, q.z)) put(r, q.x, q.z, true);
  }
  if (edge) for (let s = 10; s < t.length - 8; s += edge.every * (0.7 + R() * 0.6)) {
    const sd = R() < 0.5 ? -1 : 1, { left, right } = t.halfWidthAt(s), w = sd > 0 ? left : right;
    if (w < t.width / 2 + 1.5) continue; // (the gate mouths stay as they were: no rocks by the gates)
    const r = shape(edge.size[0] + R() * (edge.size[1] - edge.size[0]), 0.8), q0 = at(s, 0), lat = sd * (w + 0.2 + reach(r, -q0.nx * sd, -q0.nz * sd) * (0.4 + R() * 0.5)), q = at(s, lat);
    if (lineLats(s).some((v) => Math.abs(v - lat) < LANE_W / 2 + 1)) continue;
    if (!env.skip(q.x, q.z)) put(r, q.x, q.z, true);
  }
}

// Embedded relief (low domes) along every line's wheel tracks, and sparse over the open corridor.
export function wideRelief(t, E, R, e, env) {
  for (const name of LINE_NAMES) {
    if (name !== 'easy' && LINE_NAMES.slice(0, LINE_NAMES.indexOf(name)).every((m) => Math.abs(t.lines[m](t.length / 2) - t.lines[name](t.length / 2)) < 0.01) && !t.cruxes.some((c) => c.lanes.some((l) => l.line === name))) continue;
    for (let s = 8; s < t.length - 6; s += e.every * (name === 'easy' ? 1 : 1.4) * (0.6 + R() * 0.8)) {
      const base = t.lines[name](s);
      if (name !== 'easy' && Math.abs(base) < 1.5) continue; // (where it runs with the easy line, that one's relief is enough)
      const lat = base + (R() < 0.75 ? (R() < 0.5 ? -1 : 1) * (0.8 + (R() - 0.5) * 0.6) : (R() * 2 - 1) * 1.6);
      const p = pathPoint(t, s), x = p.x - p.tz * lat, z = p.z + p.tx * lat;
      if (env.skip(x, z, s)) continue;
      const k = R();
      E.embedded(x, z, lerp(e.size[0], e.size[1], k), lerp(e.proud[0], e.proud[1], 0.3 * R() + 0.7 * k) * (name === 'easy' ? 1 : 1.15));
    }
  }
}

// Does (x, z) lie within `margin` of any line of a wide trail (for keeping rubble and props off them)?
export function nearLine(t, x, z, margin) {
  if (!t.lines) return false;
  let best = null;
  for (const q of t.pts) { const d = (q.x - x) ** 2 + (q.z - z) ** 2; if (!best || d < best.d) best = { d, q }; }
  const p = pathPoint(t, best.q.s), lat = (x - p.x) * -p.tz + (z - p.z) * p.tx;
  return LINE_NAMES.some((n) => Math.abs(t.lines[n](best.q.s) - lat) < margin);
}

// A step-up band across a wide staircase: one slab per lane of the crux it falls in, side by side
// across the whole corridor, so the step can't be driven round, each lane with its own face: the
// easy lane `easy` m lower than the band's rise (the rest of the climb is the ramp behind its
// face), the hard lane the full rise, the extreme lane `lip` m proud of the tread behind it. The
// slabs are flat-topped like the narrow stairways', their top following the tread grade g (without the step ramps).
export function wideStep(t, st, g, kit, R, out, heightAt) {
  const c = t.cruxes.find((q) => st.s >= q.s0 - 0.5 && st.s <= q.s1 + 0.5), p = pathPoint(t, st.s), w = t.halfWidthAt(st.s);
  // (a band outside every crux, e.g. in a gate mouth: one slab across the corridor with the nearest crux's easy face)
  const near = t.cruxes.reduce((b, q) => (!b || Math.min(Math.abs(q.s0 - st.s), Math.abs(q.s1 - st.s)) < Math.min(Math.abs(b.s0 - st.s), Math.abs(b.s1 - st.s)) ? q : b), null);
  const easyLane = near?.lanes.find((l) => l.line === 'easy') ?? { line: 'easy', less: 0 };
  const lanes = (c ? c.lanes.filter((l) => l.line) : [{ ...easyLane, lat: 0, w: 0.1 }]).slice().sort((a, b) => a.lat - b.lat);
  // (the band spans the corridor, every lane and every line crossing it, even where the corridor pinches)
  const ls = LINE_NAMES.flatMap((n) => [t.lines[n](st.s), t.lines[n](st.s + st.depth)]), lo = Math.min(...ls) - LANE_W / 2, hi = Math.max(...ls) + LANE_W / 2;
  const edges = [-Math.max(w.right, -lanes[0].lat + lanes[0].w / 2, -lo) - 1.2];
  for (let k = 1; k < lanes.length; k++) edges.push((lanes[k - 1].lat + lanes[k - 1].w / 2 + lanes[k].lat - lanes[k].w / 2) / 2);
  edges.push(Math.max(w.left, lanes.at(-1).lat + lanes.at(-1).w / 2, hi) + 1.2);
  const faces = [];
  lanes.forEach((ln, k) => {
    const rise = Math.min(ln.line === 'easy' ? st.rise - (ln.less ?? 0.1) : ln.line === 'extreme' ? Math.min(st.rise + (ln.lip ?? 0.12), 0.68) : st.rise, ln.max ?? 9); // (ln.max: a cap on the lane's face)
    const a = edges[k], b = edges[k + 1], hwS = (b - a) / 2, mid = (a + b) / 2, pts = [], zf = -(rise + 0.35) * 0.62, d = st.depth;
    for (const sx of [-1, 1]) {
      for (const zt of [0, 0.06]) pts.push(sx * hwS * (0.97 + R() * 0.03), rise + R() * 0.02 + g * zt, zt + R() * 0.06);
      pts.push(sx * hwS, g * zf - 0.35, zf);
      pts.push(sx * hwS * (0.97 + R() * 0.03), rise + g * (d + 0.2) + 0.02, d + 0.2);
      pts.push(sx * hwS, Math.min(rise, st.rise) + g * (d + 0.7) - 0.45, d + 0.7);
    }
    for (let i = 0; i < 5; i++) { const zz = 0.4 + R() * (d - 0.4); pts.push((R() * 2 - 1) * hwS * 0.8, rise + g * zz + 0.01 + R() * 0.02, zz); }
    const x = p.x - p.tz * mid, z = p.z + p.tx * mid, f = pathPoint(t, st.s - 0.6), gx = f.x - f.tz * mid, gz = f.z + f.tx * mid;
    out.push({ x, y: heightAt(gx, gz) + g * 0.6, z, rotY: Math.atan2(p.tx, p.tz), pts, ledge: true, step: { trail: t.name, s: st.s, rise, grade: g, depth: st.depth, lat: ln.lat, line: ln.line } });
    faces.push({ line: ln.line, lat: ln.lat, rise: +rise.toFixed(3) });
  });
  if (c) c.features.push({ type: 'step', s: st.s, faces });
  // big rocks lock the band's ends so the step can't be driven round the corridor's edge
  for (const sd of [-1, 1]) { const r = kit.shape(1.1 + R() * 0.4, 0.9), q = pathPoint(t, st.s + st.depth * 0.5), e = sd > 0 ? edges.at(-1) : -edges[0], cc = sd * (e + kit.reach(r, q.tz * sd, -q.tx * sd) * 0.5); kit.put(r, q.x - q.tz * cc, q.z + q.tx * cc, true); }
}
