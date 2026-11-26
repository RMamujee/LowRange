// Generates the app icon procedurally: a 32x32 pixel-art lifted 4x4 cresting a golden hill at sunset,
// scaled with nearest-neighbour so the pixels stay crisp.
// Writes build/icon.png (512x512) and build/icon.ico (16, 24, 32, 48, 64, 128, 256; PNG-compressed entries).
// No dependencies: PNG via node:zlib, ICO container written by hand.
//   node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const N = 32;
const hex = (h, a = 255) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
const C = {
  skyTop: hex('#f7d27a'), skyMid: hex('#f2a65a'), skyLow: hex('#e47c45'),
  sun: hex('#fff3c8'), sunRim: hex('#ffe08a'),
  ridge: hex('#c4763a'),
  hillLit: hex('#f4c95d'), hill: hex('#d99a35'), hillShade: hex('#a8692a'), hillDeep: hex('#7a4a22'),
  rock: hex('#8c6a4a'), rockLit: hex('#b48c62'),
  ink: hex('#24160e'),
  body: hex('#c23b22'), bodyLit: hex('#e8603a'), bodyDark: hex('#8a2616'),
  glass: hex('#9fd6e3'), glassLit: hex('#e6f7fb'),
  tyre: hex('#2e2622'), tread: hex('#4a3e36'), hub: hex('#c9c1b0'),
  steel: hex('#5b4f46'), lamp: hex('#fff3c8'),
};

const px = Array.from({ length: N * N }, () => [0, 0, 0, 0]);
const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < N && y < N) px[y * N + x] = c; };
const get = (x, y) => (x >= 0 && y >= 0 && x < N && y < N ? px[y * N + x] : null);
const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c); };

// rounded-square tile, sky banded (pixel-art dithering, no smooth gradients)
const R = 5;
const inTile = (x, y) => {
  const cx = x < R ? R - 0.5 : x > N - 1 - R ? N - 1 - R + 0.5 : x + 0.5;
  const cy = y < R ? R - 0.5 : y > N - 1 - R ? N - 1 - R + 0.5 : y + 0.5;
  return (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= R * R;
};
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  if (!inTile(x, y)) continue;
  let c = y < 8 ? C.skyTop : y < 15 ? C.skyMid : C.skyLow;
  if ((y === 7 || y === 14) && (x + y) % 2 === 0) c = y === 7 ? C.skyMid : C.skyLow; // dithered band edge
  set(x, y, c);
}

// sun
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const d = Math.hypot(x + 0.5 - 25.5, y + 0.5 - 5.5);
  if (d <= 3.6 && get(x, y)[3]) set(x, y, d <= 2.6 ? C.sun : C.sunRim);
}

// distant ridge
for (let x = 0; x < N; x++) {
  const top = Math.round(18 + 1.6 * Math.sin(x * 0.55) + (x > 20 ? -1 : 0));
  for (let y = top; y < N; y++) if (get(x, y)[3]) set(x, y, C.ridge);
}

// golden hill: crest under the truck, falling away to both sides
const hillY = (x) => Math.round(22 + 0.15 * Math.max(0, Math.abs(x - 15.5) - 7) ** 2);
for (let x = 0; x < N; x++) {
  const top = hillY(x);
  for (let y = top; y < N; y++) {
    if (!get(x, y)[3]) continue;
    const depth = y - top;
    let c = depth === 0 ? C.hillLit : depth < 3 ? C.hill : depth < 6 ? C.hillShade : C.hillDeep;
    if (depth === 3 && x % 2 === 0) c = C.hill;
    if (depth === 6 && x % 2 === 1) c = C.hillShade;
    set(x, y, c);
  }
}
// a couple of rocks on the slope
for (const [rx, ry] of [[4, hillY(4) - 1], [27, hillY(27) - 1]]) {
  rect(rx - 1, ry, rx + 1, ry + 1, C.rock); set(rx - 1, ry, C.rockLit); set(rx, ry, C.rockLit);
}

// ---- truck layer (drawn into its own mask so it can be outlined) ----
const truck = new Map();
const t = (x, y, c) => truck.set((y + 1) * N + x, c); // +1: whole rig sits one row lower
const trect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) t(x, y, c); };

// tyres: big and chunky, sitting on the crest
const wheel = (cx, cy) => {
  for (let y = cy - 3; y <= cy + 3; y++) for (let x = cx - 3; x <= cx + 3; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= 3.3) t(x, y, d <= 1.1 ? C.hub : (x + y) % 2 === 0 && d > 2.4 ? C.tread : C.tyre);
  }
};
const WY = 18; // (+1 from t()) // wheel centre row; crest top is y=21
wheel(10, WY); wheel(21, WY);
// lift: visible links/shocks between axles and body
trect(10, 14, 10, 15, C.steel); trect(21, 14, 21, 15, C.steel);
trect(11, 15, 20, 15, C.steel);
// body (lifted: bottom edge at y=13, above the tyre tops)
trect(6, 10, 25, 13, C.body);
trect(6, 10, 25, 10, C.bodyLit);
trect(6, 13, 25, 13, C.bodyDark);
// cab + roof
trect(12, 6, 20, 9, C.body);
trect(12, 6, 20, 6, C.bodyLit);
trect(13, 7, 15, 9, C.glass); trect(17, 7, 19, 9, C.glass);
t(13, 7, C.glassLit); t(17, 7, C.glassLit);
// roof rack + light bar
trect(11, 5, 21, 5, C.steel);
t(13, 4, C.lamp); t(15, 4, C.lamp); t(17, 4, C.lamp); t(19, 4, C.lamp);
// headlight, tail light, bumper
t(25, 11, C.lamp); t(6, 11, C.bodyDark);
trect(26, 12, 26, 13, C.steel); trect(5, 12, 5, 13, C.steel);

// outline: every empty neighbour of a truck pixel becomes ink
const outline = new Set();
for (const k of truck.keys()) {
  const x = k % N, y = (k / N) | 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nk = (y + dy) * N + (x + dx);
    if (x + dx >= 0 && x + dx < N && y + dy >= 0 && y + dy < N && !truck.has(nk)) outline.add(nk);
  }
}
for (const k of outline) if (px[k][3]) px[k] = C.ink;
for (const [k, c] of truck) px[k] = c;

// ---------------- encoders ----------------
function scale(size) {
  const out = Buffer.alloc(size * size * 4);
  if (size < N) { // box filter for the small sizes
    const f = N / size;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0]; let n = 0;
      for (let sy = Math.floor(y * f); sy < Math.floor((y + 1) * f); sy++) for (let sx = Math.floor(x * f); sx < Math.floor((x + 1) * f); sx++) {
        const p = px[sy * N + sx]; const a = p[3] / 255;
        acc[0] += p[0] * a; acc[1] += p[1] * a; acc[2] += p[2] * a; acc[3] += p[3]; n++;
      }
      const a = acc[3] / n, o = (y * size + x) * 4, w = a > 0 ? 255 / a : 0;
      out[o] = Math.round(acc[0] / n * w); out[o + 1] = Math.round(acc[1] / n * w); out[o + 2] = Math.round(acc[2] / n * w); out[o + 3] = Math.round(a);
    }
  } else {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const p = px[Math.floor(y * N / size) * N + Math.floor(x * N / size)];
      out.set(p, (y * size + x) * 4);
    }
  }
  return out;
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const rgba = scale(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function ico(sizes) {
  const imgs = sizes.map(png);
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(imgs[i].length, 8); e.writeUInt32LE(offset, 12);
    offset += imgs[i].length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...imgs]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'icon.png'), png(512));
writeFileSync(join(outDir, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
console.log('wrote build/icon.png (512) and build/icon.ico (16-256)');
