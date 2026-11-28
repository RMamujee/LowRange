// Top-down previews of the rated crawls: hill-shaded height, the path cells, and every rock coloured
// by how far it stands above the ground (embedded relief grey, under 0.3 m yellow, 0.3-0.5 m orange,
// 0.5-0.7 m red, taller dark red), ledges outlined; marked lines drawn on top (easy green, hard
// blue, extreme magenta) where the map publishes them (trail.lines). No dependencies (own PNG writer).
// usage: MAP=park|crawl node test/trailmap.mjs <outdir> [prefix] [pxPerMetre=4] [whole]
//   one PNG per trail (park) or per Gauntlet stage group and side course (crawl); `whole` adds the map
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
const T = await import('../src/terrain.js');
const { GRID, SIZE, RES, TRAILS, ROADS, COURSES, MAP, MAT, heightAt, pathPoint } = T;
const out = process.argv[2] || 'test/shots/trailmap', prefix = process.argv[3] || T.MAP_ID, PX = +(process.argv[4] || 4), whole = process.argv[5] === 'whole';
mkdirSync(out, { recursive: true });
const rocks = T.generateRocks();

// ---- PNG ----
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// world-space hull points of a rock and its top above the ground
const N1 = RES + 1, CELL = SIZE / RES;
const info = rocks.map((r) => {
  const c = Math.cos(r.rotY), s = Math.sin(r.rotY), P = [];
  let top = -1e9;
  for (let i = 0; i < r.pts.length; i += 3) { const x = r.x + r.pts[i] * c + r.pts[i + 2] * s, z = r.z - r.pts[i] * s + r.pts[i + 2] * c, y = r.y + r.pts[i + 1]; P.push([x, z]); top = Math.max(top, y - heightAt(x, z)); }
  // 2D convex hull (monotone chain)
  P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of P) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
  for (const p of P.slice().reverse()) { while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), p) <= 0) hi.pop(); hi.push(p); }
  return { r, hull: lo.slice(0, -1).concat(hi.slice(0, -1)), top };
});
const rockCol = (o) => (o.r.embed ? [150, 150, 150] : o.top < 0.3 ? [235, 205, 60] : o.top < 0.5 ? [240, 140, 40] : o.top < 0.7 ? [215, 50, 40] : [120, 20, 25]);

function render(name, x0, z0, x1, z1, overlays) {
  const w = Math.round((x1 - x0) * PX), h = Math.round((z1 - z0) * PX), img = Buffer.alloc(w * h * 3);
  const set = (px, py, c, a = 1) => { if (px < 0 || py < 0 || px >= w || py >= h) return; const k = (py * w + px) * 3; for (let q = 0; q < 3; q++) img[k + q] = Math.round(img[k + q] * (1 - a) + c[q] * a); };
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const x = x0 + (px + 0.5) / PX, z = z0 + (py + 0.5) / PX;
    const gx = (heightAt(x + 0.5, z) - heightAt(x - 0.5, z)), gz = (heightAt(x, z + 0.5) - heightAt(x, z - 0.5));
    const shade = Math.max(0.25, Math.min(1.25, 0.85 - gx * 0.6 - gz * 0.6));
    const ix = Math.max(0, Math.min(RES, Math.round((x + SIZE / 2) / CELL))), iz = Math.max(0, Math.min(RES, Math.round((z + SIZE / 2) / CELL))), g = ix * N1 + iz;
    const m = GRID.mat[g], pid = GRID.path[g];
    let c = m === MAT.MUD ? [110, 75, 45] : m === MAT.WATER ? [80, 150, 190] : m === MAT.ROCK ? [150, 140, 128] : m === MAT.ROAD ? [215, 190, 140] : m === MAT.GRAVEL ? [170, 158, 135] : m === MAT.DIRT ? [180, 145, 100] : [120, 160, 80];
    if (pid >= ROADS.length) c = c.map((v) => v * 0.85 + 20);
    const tone = GRID.tone[g] / 255; c = c.map((v) => v * (1 - 0.3 * tone));
    // contour every metre
    const hh = heightAt(x, z), frac = hh - Math.floor(hh);
    const k = (frac < 0.06 ? 0.8 : 1) * shade;
    const o = (py * w + px) * 3; img[o] = Math.min(255, c[0] * k); img[o + 1] = Math.min(255, c[1] * k); img[o + 2] = Math.min(255, c[2] * k);
  }
  const toPx = (x, z) => [(x - x0) * PX, (z - z0) * PX];
  // rocks: filled hulls
  for (const o of info) {
    if (o.r.x < x0 - 4 || o.r.x > x1 + 4 || o.r.z < z0 - 4 || o.r.z > z1 + 4) continue;
    const H = o.hull.map(([x, z]) => toPx(x, z)), col = rockCol(o);
    const ya = Math.floor(Math.min(...H.map((p) => p[1]))), yb = Math.ceil(Math.max(...H.map((p) => p[1])));
    for (let py = ya; py <= yb; py++) {
      let xa = Infinity, xb = -Infinity;
      for (let i = 0; i < H.length; i++) {
        const [ax, ay] = H[i], [bx, by] = H[(i + 1) % H.length];
        if ((ay <= py + 0.5 && by > py + 0.5) || (by <= py + 0.5 && ay > py + 0.5)) { const xx = ax + (py + 0.5 - ay) / (by - ay) * (bx - ax); xa = Math.min(xa, xx); xb = Math.max(xb, xx); }
      }
      for (let px = Math.floor(xa); px <= Math.ceil(xb); px++) set(px, py, col, o.r.embed ? 0.55 : 0.9);
    }
    if (o.r.ledge || o.r.cstep) for (let i = 0; i < H.length; i++) { const [ax, ay] = H[i], [bx, by] = H[(i + 1) % H.length], n = Math.ceil(Math.hypot(bx - ax, by - ay)); for (let q = 0; q <= n; q++) set(Math.round(ax + (bx - ax) * q / n), Math.round(ay + (by - ay) * q / n), [30, 30, 30]); }
  }
  // overlays: polylines [[x, z], ...] with a colour
  for (const [pl, col] of overlays) for (let i = 1; i < pl.length; i++) {
    const [ax, ay] = toPx(...pl[i - 1]), [bx, by] = toPx(...pl[i]), n = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let q = 0; q <= n; q++) { const px = Math.round(ax + (bx - ax) * q / n), py = Math.round(ay + (by - ay) * q / n); set(px, py, col); set(px + 1, py, col); }
  }
  const file = join(out, `${prefix}_${name}.png`);
  writeFileSync(file, png(w, h, img));
  console.log(`${file}  ${w}x${h}`);
}

const LINE_COL = { easy: [30, 170, 60], hard: [40, 90, 230], extreme: [220, 40, 200] };
// a path's marked lines as world polylines: path.lines = { easy: [[s, lat], ...], ... }
const lineOverlays = (P) => [[P.pts.map((p) => [p.x, p.z]), [250, 250, 250]], ...Object.entries(P.lines || {}).map(([k, ctl]) => {
  const pl = [];
  for (let s = 0; s <= P.length; s += 1) { const lat = latOf(ctl, s), p = pathPoint(P, s); pl.push([p.x - p.tz * lat, p.z + p.tx * lat]); }
  return [pl, LINE_COL[k] || [255, 255, 255]];
})];
function latOf(ctl, s) { if (s <= ctl[0][0]) return ctl[0][1]; for (let i = 1; i < ctl.length; i++) if (s <= ctl[i][0]) { const t = (s - ctl[i - 1][0]) / (ctl[i][0] - ctl[i - 1][0]); return ctl[i - 1][1] + (ctl[i][1] - ctl[i - 1][1]) * (t * t * (3 - 2 * t)); } return ctl.at(-1)[1]; }
const boxOf = (pts, m) => { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); } return [x0 - m, z0 - m, x1 + m, z1 + m].map((v) => Math.max(-SIZE / 2, Math.min(SIZE / 2, v))); };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

if (whole) render('map', -SIZE / 2, -SIZE / 2, SIZE / 2, SIZE / 2, []);
if (T.MAP_ID === 'crawl') {
  const t = TRAILS[0];
  // the Gauntlet in groups of stages (the switchback legs), then each side course
  const groups = [[1, 4], [5, 8], [9, 12]];
  for (const [a, b] of groups) {
    const st = MAP.STAGES.slice(a - 1, b), pts = t.pts.filter((p) => p.s >= st[0].s0 && p.s <= st.at(-1).s1);
    const [x0, z0, x1, z1] = boxOf(pts, 16);
    render(`stages${a}-${b}`, x0, z0, x1, z1, lineOverlays(t));
  }
  for (const C of COURSES) { const [x0, z0, x1, z1] = boxOf(C.pts, 16); render(C.id, x0, z0, x1, z1, lineOverlays(C)); }
} else {
  for (const t of TRAILS) { if (t.graded === false) continue; const [x0, z0, x1, z1] = boxOf(t.pts, 14); render(slug(t.name), x0, z0, x1, z1, lineOverlays(t)); }
}
