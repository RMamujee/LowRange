// Top-down previews of the rated crawls: hill-shaded ground in its surface colours, every rock
// coloured by how far it stands above the ground (raycast, as test/trailaudit.mjs), the trail's
// corridor (path cells) tinted, the reference line (centreline, the easy line) in white and any
// harder lines the map lists (t.lines) in orange / red. Writes one PNG per trail.
// usage: MAP=jungle node test/crawlpreview.mjs <outdir> [prefix] [trailIndex]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt, materialAt, MAT_INFO, GRID, SIZE, RES, ROADS, TRAILS, pathPoint } from '../src/terrain.js';

const out = process.argv[2] || 'previews';
const prefix = process.argv[3] || '';
fs.mkdirSync(out, { recursive: true });
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const rocks = generateRocks();
const terrain = buildTerrainPhysics(RAPIER, world, rocks, generateTrees(rocks));
world.step();
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
const rockUp = (x, z) => {
  const g = heightAt(x, z);
  ray.origin = { x, y: g + 6, z };
  const hit = world.castRay(ray, 8, true, undefined, undefined, undefined, undefined, (c) => terrain.rockHandles.has(c.handle));
  return hit ? Math.max(0, 6 - hit.timeOfImpact) : 0;
};

function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// rock height ramp: < 0.15 m pale, then yellow, orange, red, magenta (0.15 m steps to 0.75 m), white over
const RAMP = [[0.15, [205, 195, 170]], [0.3, [240, 214, 60]], [0.45, [242, 150, 40]], [0.6, [222, 60, 40]], [0.75, [170, 40, 150]], [99, [60, 20, 80]]];
const rampAt = (u) => RAMP.find(([lim]) => u < lim)[1];

const only = process.argv[4] !== undefined ? [TRAILS[+process.argv[4]]] : TRAILS.filter((t) => t.graded !== false);
for (const t of only) {
  const ti = TRAILS.indexOf(t), pid = ROADS.length + ti;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of t.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  const pad = 22; x0 -= pad; x1 += pad; z0 -= pad; z1 += pad;
  const mpp = Math.max(0.25, Math.max(x1 - x0, z1 - z0) / 900);
  const W = Math.ceil((x1 - x0) / mpp), H = Math.ceil((z1 - z0) / mpp), img = Buffer.alloc(W * H * 3);
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const x = x0 + (px + 0.5) * mpp, z = z0 + (py + 0.5) * mpp;
    const h = heightAt(x, z), dx = heightAt(x + 0.5, z) - heightAt(x - 0.5, z), dz = heightAt(x, z + 0.5) - heightAt(x, z - 0.5);
    const shade = Math.max(0.35, Math.min(1.25, 0.95 - dx * 0.9 - dz * 0.6));
    let c = MAT_INFO[materialAt(x, z)].color.map((v) => v * 255 * shade);
    const ix = Math.round((x + SIZE / 2) / (SIZE / RES)), iz = Math.round((z + SIZE / 2) / (SIZE / RES));
    if (GRID.path[ix * (RES + 1) + iz] === pid) c = c.map((v, k) => v * 0.8 + [255, 255, 255][k] * 0.12);
    const up = rockUp(x, z);
    if (up > 0.02) c = rampAt(up).map((v) => v * Math.min(1.1, 0.75 + up * 0.3));
    // contour every 1 m
    if (Math.floor(h) !== Math.floor(heightAt(x + mpp, z)) || Math.floor(h) !== Math.floor(heightAt(x, z + mpp))) c = c.map((v) => v * 0.8);
    const o = (py * W + px) * 3; img[o] = Math.min(255, c[0]); img[o + 1] = Math.min(255, c[1]); img[o + 2] = Math.min(255, c[2]);
  }
  const dot = (x, z, col, r = 1) => { const px = Math.round((x - x0) / mpp), py = Math.round((z - z0) / mpp); for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) { const X = px + a, Y = py + b; if (X >= 0 && Y >= 0 && X < W && Y < H) { const o = (Y * W + X) * 3; img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2]; } } };
  for (let s = 0; s < t.length; s += mpp * 2) { const p = pathPoint(t, s); dot(p.x, p.z, [255, 255, 255], 0); }
  const LC = { hard: [255, 140, 0], extreme: [230, 20, 20] };
  for (const [name, fn] of Object.entries(t.lines || {})) {
    if (!LC[name]) continue;
    for (let s = 0; s < t.length; s += mpp * 2) { const lat = fn(s); if (lat === null) continue; const p = pathPoint(t, s); dot(p.x - p.tz * lat, p.z + p.tx * lat, LC[name], 0); }
  }
  for (const end of [3, t.length - 3]) { const p = pathPoint(t, end); dot(p.x, p.z, [40, 220, 255], 2); }
  const file = path.join(out, `${prefix}${process.env.MAP}_${t.name.toLowerCase().replace(/[^a-z]+/g, '_')}.png`);
  fs.writeFileSync(file, png(W, H, img));
  console.log(`${t.name}: ${W}x${H} px at ${mpp.toFixed(2)} m/px -> ${file}`);
}
