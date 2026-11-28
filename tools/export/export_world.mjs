// Export a LowRange map for Blender (tools/blender/world/build_world.py).
//
//   node tools/export/export_world.mjs <map>        map = park | race | crawl | jungle | desert
//   node tools/export/export_world.mjs all          every map
//
// Imports the game's own modules (src/terrain.js, src/maps/*, src/world_view.js, src/race_view.js,
// src/crawl_view.js, src/art/jungle/view.js, src/desert/view.js, src/art/*, src/gfx/*, src/spawns.js)
// and runs the same view builders main.js runs, headless, so every placement, rock, plant, sign,
// structure and ground cell is what the game builds. Stand-ins:
//   - `document.createElement('canvas')` is a small software canvas (fillRect / putImageData /
//     drawImage), so sign faces and other canvas textures come out as the game's pixels;
//   - glTF props are tagged boxes (one per public/models/*.glb), so the dressing makes the same
//     random draws and variant picks as in the browser and Blender instances the real model;
//   - src/art/signs.js is loaded with one extra line that stamps each sign canvas with its title
//     (for naming the sign objects in Blender). Nothing under src/ is changed on disk.
// Writes tools/blender/world/export/<map>/ (gitignored):
//   world.json      map info, look (sky, fog, toon bands), materials, paths, rocks, dressing,
//                   markers, structures, water, points (spawns, gates, places), cameras
//   blob.bin        binary arrays referenced from world.json as [byteOffset, count, dtype]
//   grid_vis.f32    visual heights, (RES+1)^2 float32, ix-major (index = ix * (RES+1) + iz)
//   grid_h.f32      physics heights
//   grid_mat.u8     gameplay surface per grid vertex (MAT index)
//   grid_look.u8    RGBA per grid vertex, exactly the game's ground lookup texture
//                   (gfx/terrain_look.js terrainMaterial): R shown surface, G trail tread,
//                   B slow tone drift, A = 255 - rut/mud tone
//   grid_nrm.i8     the game's terrain shading normals (xyz * 127, three.js axes)
//   grid_tint.u8    the game's terrain vertex colour (RGB * 128; the desert's painted dune light)
//   tiles/*.png     the generated 128 x 128 ground tiles (4 m each, 32 px/m)
//   tex/*.png       canvas textures (sign faces, plank backs, ...)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAP_IDS = ['park', 'race', 'crawl', 'jungle', 'desert'];
const mapArg = process.argv[2] || process.env.MAP || 'park';
if (mapArg === 'all') { // one process per map (each map module bakes at import)
  for (const id of MAP_IDS) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), id], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  process.exit(0);
}
if (!MAP_IDS.includes(mapArg)) { console.error(`unknown map "${mapArg}" (${MAP_IDS.join(' | ')} | all)`); process.exit(1); }
process.env.MAP = mapArg; // read by src/terrain.js at import

// ---------- sign titles: one extra line in src/art/signs.js, in memory only ----------
const SIGN_HOOK = 'const S = surface(w, h);';
let signHooked = false;
registerHooks({
  load(url, context, nextLoad) {
    const r = nextLoad(url, context);
    if (url.endsWith('/src/art/signs.js')) {
      const src = String(r.source);
      if (src.includes(SIGN_HOOK)) { signHooked = true; return { ...r, source: src.replace(SIGN_HOOK, `${SIGN_HOOK} S.cv.__sign = { title, sub: sub ?? null, diff: diff ?? null, num: num ?? null, style };`) }; }
    }
    return r;
  },
});

// ---------- headless canvas: a tiny software rasteriser for the 2D calls the game's textures use ----------
const NAMED = { white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], transparent: [0, 0, 0, 0] };
function parseColor(c) {
  if (typeof c !== 'string') return [128, 128, 128, 255];
  const s = c.trim().toLowerCase();
  if (s[0] === '#') {
    const h = s.slice(1);
    const x = h.length <= 4 ? [...h].map((d) => parseInt(d + d, 16)) : h.match(/../g).map((d) => parseInt(d, 16));
    return [x[0], x[1], x[2], x.length > 3 ? x[3] : 255];
  }
  const m = s.match(/^rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? Math.round(p[3] * 255) : 255]; }
  const n = NAMED[s];
  return n ? [...n, n[3] ?? 255].slice(0, 4) : [128, 128, 128, 255];
}
class FakeCanvas {
  constructor() { this._w = 300; this._h = 150; this.data = null; this.texts = []; this.__fake = true; this._ctx = null; }
  get width() { return this._w; } set width(v) { this._w = Math.max(1, v | 0); this.data = null; }
  get height() { return this._h; } set height(v) { this._h = Math.max(1, v | 0); this.data = null; }
  buf() { return (this.data ||= new Uint8ClampedArray(this._w * this._h * 4)); }
  getContext() { return (this._ctx ||= makeCtx(this)); }
}
function makeCtx(cv) {
  let fill = '#000', rgba = [0, 0, 0, 255];
  const gradient = () => ({ addColorStop() {} });
  const span = (x, w, max) => { let a = Math.round(x), b = Math.round(x + w); if (b < a) [a, b] = [b, a]; return [Math.max(0, a), Math.min(max, b)]; };
  const base = {
    globalAlpha: 1, imageSmoothingEnabled: false, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', lineWidth: 1, strokeStyle: '#000',
    get canvas() { return cv; },
    get fillStyle() { return fill; },
    set fillStyle(v) { fill = v; rgba = parseColor(v); },
    fillRect(x, y, w, h) {
      const d = cv.buf(), [x0, x1] = span(x, w, cv._w), [y0, y1] = span(y, h, cv._h);
      const a = (rgba[3] / 255) * this.globalAlpha;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const o = (yy * cv._w + xx) * 4;
        for (let k = 0; k < 3; k++) d[o + k] = rgba[k] * a + d[o + k] * (1 - a);
        d[o + 3] = 255 * a + d[o + 3] * (1 - a);
      }
    },
    clearRect(x, y, w, h) { const d = cv.buf(), [x0, x1] = span(x, w, cv._w), [y0, y1] = span(y, h, cv._h); for (let yy = y0; yy < y1; yy++) d.fill(0, (yy * cv._w + x0) * 4, (yy * cv._w + x1) * 4); },
    createImageData(w, h) { if (typeof w === 'object') ({ width: w, height: h } = w); return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    getImageData(x, y, w, h) { const d = cv.buf(), out = new Uint8ClampedArray(w * h * 4); for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) { const sx = x + xx, sy = y + yy; if (sx < 0 || sy < 0 || sx >= cv._w || sy >= cv._h) continue; for (let k = 0; k < 4; k++) out[(yy * w + xx) * 4 + k] = d[(sy * cv._w + sx) * 4 + k]; } return { width: w, height: h, data: out }; },
    putImageData(img, x, y) { const d = cv.buf(); for (let yy = 0; yy < img.height; yy++) for (let xx = 0; xx < img.width; xx++) { const dx = x + xx, dy = y + yy; if (dx < 0 || dy < 0 || dx >= cv._w || dy >= cv._h) continue; for (let k = 0; k < 4; k++) d[(dy * cv._w + dx) * 4 + k] = img.data[(yy * img.width + xx) * 4 + k]; } },
    drawImage(src, ...a) {
      if (!src || !src.__fake) return;
      let [sx, sy, sw, sh, dx, dy, dw, dh] = a.length === 2 ? [0, 0, src._w, src._h, a[0], a[1], src._w, src._h] : a.length === 4 ? [0, 0, src._w, src._h, ...a] : a;
      const s = src.buf(), d = cv.buf();
      for (let yy = 0; yy < Math.round(dh); yy++) for (let xx = 0; xx < Math.round(dw); xx++) {
        const X = Math.round(dx) + xx, Y = Math.round(dy) + yy;
        if (X < 0 || Y < 0 || X >= cv._w || Y >= cv._h) continue;
        const u = Math.min(src._w - 1, Math.floor(sx + ((xx + 0.5) / dw) * sw)), v = Math.min(src._h - 1, Math.floor(sy + ((yy + 0.5) / dh) * sh));
        const so = (v * src._w + u) * 4, o = (Y * cv._w + X) * 4, al = s[so + 3] / 255;
        for (let k = 0; k < 3; k++) d[o + k] = s[so + k] * al + d[o + k] * (1 - al);
        d[o + 3] = Math.max(d[o + 3], s[so + 3]);
      }
    },
    fillText(t) { if (String(t).trim()) cv.texts.push({ text: String(t), color: fill }); },
    measureText(t) { return { width: String(t).length * 6 }; },
    createLinearGradient: gradient, createRadialGradient: gradient, createPattern: () => null,
  };
  return new Proxy(base, { get(t, k) { return k in t ? t[k] : () => {}; }, set(t, k, v) { t[k] = v; return true; } });
}
globalThis.document = { createElement: () => new FakeCanvas() };

const THREE = await import('three');
const { ConvexGeometry } = await import('three/examples/jsm/geometries/ConvexGeometry.js');
const assets = await import('../../src/art/assets.js');

// stand-in glTF assets: same names as public/models, a tiny box each, material named after the file
const MODELS = path.join(ROOT, 'public/models');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.glb$/i.test(e.name) ? [path.join(d, e.name)] : []));
const modelFiles = walk(MODELS).map((f) => path.relative(MODELS, f).split(path.sep).join('/')).sort();
const ASSETS = await assets.loadArtAssets(); // the module's own map (stays empty without a browser)
for (const f of modelFiles) {
  const key = f.replace(/\.glb$/i, '');
  if (key.startsWith('vehicles/')) continue;
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial(); m.name = 'asset:' + key;
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), m));
  ASSETS.set(key, g);
}

const T = await import('../../src/terrain.js');
const WV = await import('../../src/world_view.js');
const PAL = await import('../../src/gfx/palette.js');
const TOON = (await import('../../src/gfx/toon.js')).TOON;
const { groundTextureArray, LAYERS, LEVELS, TILE, TILE_M } = await import('../../src/gfx/pixeltex.js');
const { shapeRockGeometry, visualSurface, softenTerrainNormals } = await import('../../src/gfx/terrain_look.js');
const { baseVertexHeight } = await import('../../src/fx/mud_view.js');
const { buildSpawnPoints } = await import('../../src/spawns.js');
if (!signHooked) console.warn('[export] src/art/signs.js changed: sign objects will be named by their place only');

const { GRID, SIZE, RES, MAP_ID } = T;
const N1 = RES + 1;
const OUT = path.join(ROOT, 'tools/blender/world/export', MAP_ID);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'tiles'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'tex'), { recursive: true });
const r3 = (v) => Math.round(v * 1e3) / 1e3;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const hex = (c) => '#' + c.getHexString();
const hexi = (n) => '#' + n.toString(16).padStart(6, '0');
const write = (name, a) => fs.writeFileSync(path.join(OUT, name), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
const warnings = [];

// ---------- binary blob ----------
const blob = []; let blobLen = 0;
const DT = (a) => (a instanceof Float32Array ? 'f4' : a instanceof Uint32Array ? 'u4' : a instanceof Uint8Array ? 'u1' : a instanceof Int32Array ? 'i4' : 'f4');
function put(arr) {
  const a = ArrayBuffer.isView(arr) ? arr : Float32Array.from(arr);
  const b = Buffer.from(a.buffer, a.byteOffset, a.byteLength), off = blobLen;
  blob.push(b); blobLen += b.length;
  const pad = (4 - (blobLen % 4)) % 4; if (pad) { blob.push(Buffer.alloc(pad)); blobLen += pad; }
  return [off, a.length, DT(a)];
}

// ---------- PNG ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function png(file, w, h, rgba) {
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}
const texFiles = new Map();
function texRef(t) {
  const img = t && t.image;
  if (!img) return null;
  let w, h, data;
  if (img.__fake) { w = img._w; h = img._h; data = img.buf(); }
  else if (img.data && img.width && img.height && img.data.length === img.width * img.height * 4) { w = img.width; h = img.height; data = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length); }
  else return null;
  const key = crypto.createHash('sha1').update(Buffer.from(data.buffer, data.byteOffset, data.byteLength)).update(`${w}x${h}`).digest('hex').slice(0, 12);
  if (!texFiles.has(key)) { png(path.join(OUT, 'tex', key + '.png'), w, h, data); texFiles.set(key, `tex/${key}.png`); }
  return texFiles.get(key);
}

// ---------- the scene, built as main.js builds it ----------
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(PAL.FOG, 140, 520); // main.js
const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 900);
const hemi = new THREE.HemisphereLight(0xfff1dc, 0x5a4a38, 1.25);
const sun = new THREE.DirectionalLight(0xfff0d4, 2.4);
scene.add(hemi, sun);
const rocks = T.generateRocks();
const trees = T.generateTrees(rocks);
const mapView = MAP_ID === 'jungle' ? await import('../../src/art/jungle/view.js') : MAP_ID === 'desert' ? await import('../../src/desert/view.js') : null;

let terrainMesh = null, water = new THREE.Group();
if (mapView?.buildTerrain) {
  const tr = mapView.buildTerrain(scene, camera);
  for (const c of [...tr.children]) if (!c.isMesh) water.add(c); // the sea and the creek (the chunks are rebuilt from the grid)
} else {
  terrainMesh = WV.buildTerrainMesh();
  scene.add(terrainMesh);
}
const dressingRoot = mapView?.buildDressing ? mapView.buildDressing(trees, { scene, camera, sun }) : WV.buildTrees(trees);
// Coralume Island: each tree chunk has an instanced near level and a merged far copy: keep the near one
dressingRoot.traverse((o) => { if (o.name === 'trees_jungle') for (const c of [...o.children]) { if (c.isMesh) o.remove(c); else c.visible = true; } });
const markerScene = new THREE.Group();
if (T.MAP_KIND === 'race') (await import('../../src/race_view.js')).buildRaceDressing(markerScene);
else if (MAP_ID === 'crawl') (await import('../../src/crawl_view.js')).buildCrawlView(markerScene, null);
else if (mapView?.buildMarkers) mapView.buildMarkers(markerScene);
else WV.buildMarkers(markerScene);
// structures: Coralume Island's bridges / dock / huts / lookout / lighthouse / road paint, the desert camp
const structures = new THREE.Group();
for (const c of [...markerScene.children]) if (c.name === 'structures') structures.add(c);
for (const c of [...dressingRoot.children]) if (c.name === 'camp') structures.add(c);
// water sheets the map views put in with the markers (the Gauntlet's ford, the race splash)
const isWaterMat = (m) => m && m.transparent && m.color && ['#4a6f78'].includes(hex(m.color));
markerScene.traverse((o) => { if (o.isMesh && isWaterMat(o.material)) o.userData.water = true; });
const backdrop = MAP_ID !== 'jungle' ? WV.buildBackdrop() : null;

// ---------- grid ----------
write('grid_vis.f32', GRID.vis);
write('grid_h.f32', GRID.h);
write('grid_mat.u8', GRID.mat); // gameplay surface (what the tyres grip); the shown one is in grid_look
const vs = visualSurface({ GRID, RES, SIZE, MAT: T.MAT });
{
  // the ground lookup texture, as gfx/terrain_look.js terrainMaterial builds it
  const NROADS = T.ROADS.length, look = new Uint8Array(N1 * N1 * 4);
  for (let ix = 0; ix < N1; ix++) for (let iz = 0; iz < N1; iz++) {
    const g = ix * N1 + iz, o = g * 4, m = vs.mat[g];
    look[o] = m;
    look[o + 1] = GRID.path[g] >= NROADS && m !== T.MAT.MUD ? 255 : 0;
    const nz = Math.sin(ix * 0.071 + Math.sin(iz * 0.05) * 2.1) * Math.sin(iz * 0.063 + Math.sin(ix * 0.045) * 1.7);
    look[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    look[o + 3] = 255 - (GRID.tone ? GRID.tone[g] : 0);
  }
  write('grid_look.u8', look);
  // shading normals and vertex colour per grid vertex, from the game's own terrain mesh
  const nrm = new Int8Array(N1 * N1 * 3), tint = new Uint8Array(N1 * N1 * 3).fill(128);
  let geo = terrainMesh?.geometry;
  if (!geo) { // Coralume Island draws chunks: run the same normal softening over the whole grid
    const pos = new Float32Array(N1 * N1 * 3);
    for (let ix = 0; ix < N1; ix++) for (let iz = 0; iz < N1; iz++) { const i = (ix * N1 + iz) * 3; pos[i] = -SIZE / 2 + ix * (SIZE / RES); pos[i + 1] = baseVertexHeight(GRID, N1, ix, iz); pos[i + 2] = -SIZE / 2 + iz * (SIZE / RES); }
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N1 * N1 * 3), 3));
    softenTerrainNormals(geo, { GRID, RES, SIZE, MAT: T.MAT });
  }
  const P = geo.attributes.position, Nn = geo.attributes.normal, Cc = geo.attributes.color, cell = SIZE / RES;
  for (let i = 0; i < P.count; i++) {
    const ix = Math.round((P.getX(i) + SIZE / 2) / cell), iz = Math.round((P.getZ(i) + SIZE / 2) / cell), g = (ix * N1 + iz) * 3;
    nrm[g] = Math.round(Nn.getX(i) * 127); nrm[g + 1] = Math.round(Nn.getY(i) * 127); nrm[g + 2] = Math.round(Nn.getZ(i) * 127);
    if (Cc && MAP_ID === 'desert') for (let k = 0; k < 3; k++) tint[g + k] = Math.min(255, Math.round(Cc.array[i * 3 + k] * 128));
  }
  write('grid_nrm.i8', nrm);
  write('grid_tint.u8', tint);
}

// ---------- ground tiles (src/gfx/pixeltex.js, generated exactly as in the game, with this map's ramps) ----------
// (the array holds LEVELS detail levels per layer, layer * LEVELS + level: level 0 is the full tile)
const tiles = groundTextureArray().image.data, LS = TILE * TILE * 4;
LAYERS.forEach((name, i) => png(path.join(OUT, 'tiles', `${name}.png`), TILE, TILE, tiles.subarray(i * LEVELS * LS, (i * LEVELS + 1) * LS)));

// ---------- rocks: the game's exact convex hulls and vertex tone (world_view.buildRocks) ----------
const rockOut = [];
for (const r of rocks) {
  const pts = [];
  for (let i = 0; i < r.pts.length; i += 3) pts.push(new THREE.Vector3(r.pts[i], r.pts[i + 1], r.pts[i + 2]));
  let g;
  try { g = new ConvexGeometry(pts); } catch { continue; }
  const m = shapeRockGeometry(g, r.ledge, rockOut.length); // in the rock's own frame (yaw / position on the object)
  const c = m.attributes.color;
  rockOut.push({
    x: r4(r.x), y: r4(r.y), z: r4(r.z), rotY: r4(r.rotY), ledge: !!r.ledge, embedded: !!r.embedded, kind: r.kind ?? null,
    v: put(Float32Array.from(m.attributes.position.array)), i: put(Uint32Array.from(m.index.array)), tone: put(Float32Array.from({ length: c.count }, (_, k) => c.getX(k))),
  });
}

// ---------- generic three.js scene -> JSON ----------
const geoms = [], geomIdx = new Map(), mats = [], matIdx = new Map();
function geomRef(g, wantUV) {
  const key = g.uuid + (wantUV ? ':uv' : '');
  if (geomIdx.has(key)) return geomIdx.get(key);
  g.computeBoundingBox();
  const p = g.attributes.position, col = g.attributes.color, uv = g.attributes.uv;
  const rec = {
    type: g.type, n: p.count,
    v: put(Float32Array.from({ length: p.count * 3 }, (_, k) => p.getComponent(Math.floor(k / 3), k % 3))),
    i: g.index ? put(Uint32Array.from(g.index.array)) : null,
    groups: g.groups.map((q) => [q.start, q.count, q.materialIndex ?? 0]),
    color: col ? put(Float32Array.from({ length: col.count * col.itemSize }, (_, k) => col.getComponent(Math.floor(k / col.itemSize), k % col.itemSize))) : null,
    colorSize: col ? col.itemSize : 0,
    uv: wantUV && uv ? put(Float32Array.from({ length: uv.count * 2 }, (_, k) => uv.getComponent(Math.floor(k / 2), k % 2))) : null,
    bbox: [...g.boundingBox.min.toArray(), ...g.boundingBox.max.toArray()].map(r4),
    params: g.parameters ? Object.fromEntries(Object.entries(g.parameters).filter(([, v]) => typeof v === 'number')) : null,
  };
  geomIdx.set(key, geoms.push(rec) - 1);
  return geomIdx.get(key);
}
function matRef(m, extra = {}) {
  if (matIdx.has(m.uuid)) return matIdx.get(m.uuid);
  const rec = {
    name: m.name || '', type: m.type, color: m.color ? hex(m.color) : '#ffffff', emissive: m.emissive ? hex(m.emissive) : '#000000',
    emissiveMap: !!m.emissiveMap, opacity: m.opacity, transparent: !!m.transparent, vertexColors: !!m.vertexColors,
    doubleSided: m.side === THREE.DoubleSide, flat: !!m.flatShading, basic: m.type === 'MeshBasicMaterial', fog: m.fog !== false, ...extra,
  };
  if (m.map) { rec.map = texRef(m.map); const img = m.map.image; if (img?.__sign) rec.sign = img.__sign; if (img?.texts?.length) rec.texts = img.texts; }
  matIdx.set(m.uuid, mats.push(rec) - 1);
  return matIdx.get(m.uuid);
}
const mat16 = (m) => Array.from(m.elements);
const signOf = (o) => { let s = null; o.traverse((q) => { if (s || !q.material) return; for (const m of Array.isArray(q.material) ? q.material : [q.material]) if (m.map?.image?.__sign) { s = m.map.image.__sign; break; } }); return s; };
const hasPlaneSign = (o) => { let y = false; o.traverse((q) => { if (q.isMesh && q.geometry.type === 'PlaneGeometry' && (Array.isArray(q.material) ? q.material : [q.material]).some((m) => m.map?.image?.__sign)) y = true; }); return y; };
const groupNames = new Map();
function uniq(name) { const n = (groupNames.get(name) || 0) + 1; groupNames.set(name, n); return n === 1 ? name : `${name} ${n}`; }
const moved = (a) => a.position.lengthSq() > 1e-10 || Math.abs(a.rotation.x) + Math.abs(a.rotation.y) + Math.abs(a.rotation.z) > 1e-9 || Math.abs(a.scale.x - 1) + Math.abs(a.scale.y - 1) + Math.abs(a.scale.z - 1) > 1e-9;

// Walk a built group: glTF stand-ins become asset placements, everything else meshes
// (InstancedMesh -> one record with many matrices). Hidden parts are skipped. Parts that share a
// placed parent group (a signpost, a gate, a hut) carry its id, so Blender can parent them.
function serialize(root, label = (o, cat) => o.name || cat) {
  root.updateMatrixWorld(true);
  const out = { assets: {}, meshes: [], groups: {} };
  const tmp = new THREE.Matrix4(), col = new THREE.Color();
  const hidden = (o) => { for (let a = o; a && a !== root; a = a.parent) if (a.visible === false) return true; return false; };
  root.traverse((o) => {
    if (!o.isMesh || hidden(o) || (o.isInstancedMesh && o.count === 0)) return;
    const mlist = Array.isArray(o.material) ? o.material : [o.material];
    const asset = mlist[0]?.name?.startsWith('asset:') ? mlist[0].name.slice(6) : null;
    let cat = 'misc'; for (let a = o; a && a !== root; a = a.parent) if (a.name && a.name !== 'props') { cat = a.name; break; }
    const items = [];
    if (o.isInstancedMesh) {
      for (let k = 0; k < o.count; k++) {
        o.getMatrixAt(k, tmp); tmp.premultiply(o.matrixWorld);
        const it = { m: mat16(tmp) };
        if (o.instanceColor) { o.getColorAt(k, col); it.c = hex(col); }
        items.push(it);
      }
    } else items.push({ m: mat16(o.matrixWorld) });
    if (asset) { const k = asset + '|' + cat; (out.assets[k] ||= { asset, category: cat, items: [] }).items.push(...items); return; }
    const wantUV = mlist.some((m) => m.map);
    const rec = { name: label(o, cat), category: cat, geom: geomRef(o.geometry, wantUV), mats: mlist.map((m) => matRef(m)), water: !!o.userData.water, items };
    if (!o.isInstancedMesh) {
      // the nearest placed parent group (signpost, gate, hut, camp building)
      let grp = null;
      for (let a = o.parent; a && a !== root; a = a.parent) if (!a.isMesh && moved(a)) grp = a; // the outermost one
      if (grp) {
        if (!out.groups[grp.uuid]) {
          const s = signOf(grp);
          const base = s ? `${hasPlaneSign(grp) ? 'Gate' : 'Sign'} ${s.title}${s.num != null && !String(s.title).includes(String(s.num)) ? ` (${s.num})` : ''}` : grp.name || `${cat} group`;
          out.groups[grp.uuid] = { name: uniq(base), m: mat16(grp.matrixWorld), category: cat, sign: s };
        }
        rec.group = grp.uuid;
      }
    }
    const same = o.isInstancedMesh && out.meshes.find((q) => q.geom === rec.geom && q.name === rec.name && q.mats.join() === rec.mats.join());
    if (same) same.items.push(...items); else out.meshes.push(rec);
  });
  // matrices and tints go to the blob
  const pack = (items) => {
    const m = new Float32Array(items.length * 16); items.forEach((it, k) => m.set(it.m, k * 16));
    const res = { n: items.length, m: put(m) };
    if (items.some((it) => it.c)) { const c = new Uint8Array(items.length * 3); items.forEach((it, k) => { const q = new THREE.Color(it.c || '#ffffff'); c[k * 3] = Math.round(q.r * 255); c[k * 3 + 1] = Math.round(q.g * 255); c[k * 3 + 2] = Math.round(q.b * 255); }); res.c = put(c); }
    return res;
  };
  for (const a of Object.values(out.assets)) a.items = pack(a.items);
  for (const r of out.meshes) r.items = pack(r.items);
  return out;
}

// part names: what a thing is, from its shape / colour (signs and gates are named by their group)
const PART_COLOR = {
  '#f2f2ee': 'Edge post', '#ff3b2f': 'Edge post reflector', '#6b5a44': 'Trail marker post', '#ffb340': 'Gate lamp', '#4a3420': 'Sign post',
  '#b9b4aa': 'Concrete barrier', '#c0392b': 'Barrier stripe', '#1c1c1c': 'Tyre wall', '#eeeeea': 'White tyre / paint', '#ff6a13': 'Apex cone',
  '#3a3d42': 'Steel (gantry / venue sign)', '#8a8f96': 'Grandstand step', '#9da2a8': 'Grandstand step', '#c23b22': 'Red (roof / tent / flag)',
  '#55585c': 'Pole', '#9aa0a6': 'Catch fence', '#ffd21f': 'Spectator tape', '#777777': 'Tent pole', '#888888': 'Flag pole', '#4a6f78': 'Water',
  '#220a08': 'Start light', '#3fae4f': 'Gate post', '#2f7fd8': 'Gate post', '#2b2b2b': 'Gate post', '#d8d4c8': 'Flag pole', '#9a8f80': 'Cairn stone',
  '#9a6a3e': 'Deck planks', '#6e4a2a': 'Deck planks (dark)', '#b9bcb4': 'Guard rail', '#c8a25c': 'Thatch roof', '#d8c49a': 'Hut wall', '#efeee6': 'Lighthouse (white)', '#c84a3c': 'Lighthouse (red)', '#fff2c0': 'Lamp room',
  '#e8e4d8': 'Road paint (white)', '#e0b84a': 'Road paint (yellow)',
};
function partName(o, cat) {
  const ms = Array.isArray(o.material) ? o.material : [o.material];
  if (ms.some((m) => m.map?.image?.__sign)) return o.geometry.type === 'PlaneGeometry' ? 'Banner face' : 'Sign board';
  if (o.isInstancedMesh && o.geometry.type === 'BoxGeometry') {
    const w = o.geometry.parameters.width;
    const k = { 0.46: 'Spectator', 0.24: 'Spectator head', 0.12: 'Marker post', 0.14: 'Marker post top', 0.2: 'Marker post top' }[w];
    if (k && !(w === 0.12 && hex(ms[0].color) !== '#ffffff')) return k === 'Marker post top' ? 'Trail marker top' : k;
  }
  const c = ms[0].color ? hex(ms[0].color) : null;
  if (o.geometry.type === 'PlaneGeometry' && ms[0].map) return 'Start line (chequered)';
  if (o.geometry.type === 'PlaneGeometry' && c === '#eeeeea') return 'Grid line';
  if (c && PART_COLOR[c]) {
    if (c === '#6b5a44' && o.geometry.type === 'BoxGeometry' && o.geometry.parameters.height < 1) return 'Trail marker top';
    return PART_COLOR[c];
  }
  if (o.name) return o.name;
  if (cat !== 'misc') return cat;
  if (o.isInstancedMesh && o.geometry.type === 'BoxGeometry' && o.geometry.parameters.width === 0.2) return 'Trail marker top';
  return o.geometry.type.replace('Geometry', '') || 'Part';
}

// groups with no sign on them: name them from the collider they stand on, or from their parts
const PROP_NAME = { 'camp-shack': 'Camp shack', 'camp-pump': 'Fuel pump', 'camp-post': 'Canopy post', 'camp-tank': 'Water tank', 'camp-trailer': 'Old trailer', hut: 'Stilt hut', lighthouse: 'Lighthouse', lookout: 'Summit lookout' };
function nameGroups(out) {
  groupNames.clear();
  for (const [id, g] of Object.entries(out.groups)) {
    if (g.sign) { g.name = uniq(g.name.replace(/ \d+$/, '')); continue; }
    const e = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(g.m));
    const parts = new Set(out.meshes.filter((r) => r.group === id).map((r) => r.name));
    const near = (T.PROPS || []).filter((b) => b.kind && Math.hypot(b.x - e.x, b.z - e.z) < 1.5).sort((a, b) => Math.hypot(a.x - e.x, a.z - e.z) - Math.hypot(b.x - e.x, b.z - e.z))[0];
    let n = near && PROP_NAME[near.kind];
    if (!n) n = parts.has('Lighthouse (white)') ? 'Lighthouse' : parts.has('Hut wall') ? 'Stilt hut' : parts.has('Thatch roof') ? 'Summit lookout' : T.MAP_KIND === 'race' ? 'Grandstand' : g.name.replace(/ group( \d+)?$/, '');
    g.name = uniq(n);
  }
  if (T.MAP_KIND === 'race') for (const g of Object.values(out.groups)) {
    if (g.sign?.title?.startsWith('START')) g.name = 'Start-finish gantry';
    else if (g.sign?.title === 'CHECKPOINT') g.name = `Arch Checkpoint ${g.sign.num}`;
  }
  return out;
}
const dressing = nameGroups(serialize(dressingRoot, (o, cat) => (o.name && o.name !== cat ? o.name : partName(o, cat) !== cat && /sign/i.test(cat) ? partName(o, cat) : cat)));
const markers = nameGroups(serialize(markerScene, partName));
const struct = nameGroups(serialize(structures, partName));
const waterOut = serialize(water, (o, cat) => o.name || cat);
const backdropOut = backdrop ? serialize(backdrop, () => 'Distant ranges') : null;

// ---------- paths ----------
const pathOut = (p, kind) => ({
  name: p.name, kind, surface: p.surface ?? null, diff: p.diff ?? null, diffLabel: p.diff ? T.DIFF[p.diff].label : null, diffColor: p.diff ? T.DIFF[p.diff].color : null,
  width: p.width ?? null, shoulder: p.shoulder ?? null, length: r3(p.length ?? 0), closed: !!p.closed, mud: p.mud ?? null, graded: p.graded ?? null,
  pts: p.pts.map((q) => [r3(q.x), r3(q.h ?? T.visualHeightAt(q.x, q.z)), r3(q.z)]),
});
const paths = [...T.ROADS.map((p) => pathOut(p, p.course ? 'access' : 'road')), ...T.TRAILS.map((p) => pathOut(p, 'trail'))];
if (T.TRACK) paths.push(pathOut(T.TRACK, 'track'));
for (const C of T.COURSES) paths.push(pathOut({ ...C, pts: C.pts }, 'course'));
if (T.MAP.RIVER) paths.push({ ...pathOut({ name: 'Ember Creek', pts: T.MAP.RIVER.pts.map((q) => ({ x: q.x, z: q.z, h: T.visualHeightAt(q.x, q.z) })), width: T.MAP.RIVER.bedW, length: 0 }, 'creek') });

// ---------- gameplay points ----------
const points = [];
const H = (x, z) => T.surfaceAt(x, z);
const pt = (name, kind, x, z, extra = {}) => points.push({ name: kind === 'landmark' ? `Landmark ${name}` : name, kind, x: r3(x), y: r3(extra.y ?? H(x, z)), z: r3(z), yaw: extra.yaw ?? null, ...extra });
pt('Spawn', 'spawn', T.SPAWN.x, T.SPAWN.z, { yaw: T.SPAWN.yaw });
if (T.TRAILHEAD) pt(T.TRAILHEAD.name ? `Trailhead (${T.TRAILHEAD.name})` : 'Trailhead lot', 'lot', T.TRAILHEAD.x, T.TRAILHEAD.z, { r: T.TRAILHEAD.r });
for (const t of T.TRAILS) {
  if (t.stages || t.graded === false) continue;
  for (const [end, s] of [['start', 3], ['end', t.length - 3]]) { const p = T.pathPoint(t, s); pt(`${t.name} ${end} gate`, 'trail-end', p.x, p.z, { yaw: Math.atan2(p.tx, p.tz), diff: t.diff, trail: t.name, end }); }
}
if (MAP_ID === 'crawl') {
  const t = T.TRAILS[0];
  for (const st of T.MAP.STAGES) { const p = T.pathPoint(t, st.gateS); pt(`Stage ${st.n} gate (${st.name})`, 'stage-gate', p.x, p.z, { yaw: Math.atan2(p.tx, p.tz), diff: st.diff, stage: st.n }); }
  pt('Summit pad', 'place', T.MAP.SUMMIT.x, T.MAP.SUMMIT.z, { r: T.MAP.SUMMIT.r });
  for (const C of T.COURSES) for (const st of C.stages) { const p = T.pathPoint(C, st.gateS); pt(`${C.name} gate ${st.n} (${st.finish ? 'finish' : st.name})`, 'course-gate', p.x, p.z, { yaw: Math.atan2(p.tx, p.tz), diff: st.diff ?? C.diff, course: C.name }); }
}
for (const c of T.CHECKPOINTS) pt(`Checkpoint ${c.i}${c.i === 0 ? ' (start-finish)' : ''}`, 'checkpoint', c.x, c.z, { yaw: Math.atan2(c.tx, c.tz), s: c.s });
for (const p of T.MAP.PLACES ?? []) pt(`Place ${p.name}`, 'place', p.x, p.z, { yaw: p.yaw ?? null, note: p.note ?? null });
if (MAP_ID === 'jungle') {
  const M = T.MAP, D = M.DECOR;
  if (D.lighthouse) pt('Lava Point Light', 'landmark', D.lighthouse.x, D.lighthouse.z, { y: D.lighthouse.y });
  if (D.lookout) pt('Summit lookout', 'landmark', D.lookout.x, D.lookout.z, { y: D.lookout.y });
  if (D.dock) pt('Palm Cove Dock', 'landmark', (D.dock.x0 + D.dock.x1) / 2, (D.dock.z0 + D.dock.z1) / 2, { y: D.dock.y });
  D.bridges.forEach((b, k) => { const r = T.ROADS.find((q) => q.name === b.road); if (r) { const p = T.pathPoint(r, (b.s0 + b.s1) / 2); pt(`Bridge ${k + 1} (${b.road})`, 'landmark', p.x, p.z, { yaw: Math.atan2(p.tx, p.tz) }); } });
  pt('Ember Falls plunge pool', 'landmark', M.POOL.x, M.POOL.z, { y: M.POOL.w });
  pt('Crater', 'landmark', M.PEAK.x, M.PEAK.z);
}
if (MAP_ID === 'desert') {
  const M = T.MAP, L = M.LANDMARKS;
  pt('Arch', 'landmark', L.arch.x, L.arch.z, { yaw: L.arch.rotY });
  pt('Hoodoos', 'landmark', L.hoodoos.x, L.hoodoos.z);
  pt('Bonewhite Flat (dry lake)', 'landmark', M.PLAYA.x, M.PLAYA.z);
  pt('Saffron Sea (dunes)', 'landmark', M.ERG.x, M.ERG.z);
  pt('Practice Dune', 'landmark', M.PRACTICE.x, M.PRACTICE.z);
  pt('Dome', 'landmark', M.DOME.x, M.DOME.z);
  (M.MESAS ?? []).forEach((m, k) => pt(m.name ? `Mesa ${m.name}` : `Mesa ${k + 1}`, 'landmark', m.x, m.z));
}
// gates and signs at a trail end: say which end
for (const g of Object.values(markers.groups)) {
  const e = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(g.m));
  const t = g.sign && points.filter((p) => p.kind === 'trail-end' && p.trail === g.sign.title).sort((a, b) => Math.hypot(a.x - e.x, a.z - e.z) - Math.hypot(b.x - e.x, b.z - e.z))[0];
  if (t && Math.hypot(t.x - e.x, t.z - e.z) < 25) g.name = g.name.replace(/ \d+$/, '') + ` (${t.end === 'start' ? 'start' : 'far end'})`;
}
const spawnWarn = [];
const spawns = buildSpawnPoints({ rocks, trees, warn: (m) => spawnWarn.push(m) });
for (const s of spawns) pt(`Spawn point: ${s.name}`, 'spawn-point', s.x, s.z, { yaw: s.yaw, group: s.groupLabel ?? s.group, default: !!s.default });

// ---------- cameras (named; previews render the ones marked render) ----------
const cams = [];
const VH = (x, z) => T.visualHeightAt(x, z);
const cam = (name, eye, target, o = {}) => cams.push({ name, eye: eye.map(r3), target: target.map(r3), fov: o.fov ?? 62, ortho: o.ortho ?? null, fog: o.fog ?? true, render: o.render ?? true });
function chase(name, x, z, fx, fz, { back = 11, up = 5, ahead = 8, render = true } = {}) {
  const L = Math.hypot(fx, fz) || 1; fx /= L; fz /= L;
  const ex = x - fx * back, ez = z - fz * back;
  cam(name, [ex, Math.max(VH(x, z), VH(ex, ez)) + up, ez], [x + fx * ahead, VH(x + fx * ahead, z + fz * ahead) + 1, z + fz * ahead], { render });
}
function orbit(name, x, z, { dist = 40, up = 18, bearing = 0.6, lift = 2, y = null, render = true, fov = 50 } = {}) {
  const ty = (y ?? VH(x, z)) + lift, ex = x + Math.sin(bearing) * dist, ez = z + Math.cos(bearing) * dist;
  cam(name, [ex, Math.max(ty, VH(ex, ez) + 2) + up, ez], [x, ty, z], { render, fov });
}
const sp = T.SPAWN, fwd = [-Math.sin(sp.yaw), -Math.cos(sp.yaw)];
if (T.MAP_KIND === 'race') {
  chase('Race grid', sp.x, sp.z, fwd[0], fwd[1], { back: 16, up: 6, ahead: 18 });
  const c0 = T.CHECKPOINTS[0], y0 = VH(c0.x, c0.z);
  cam('Start-finish view', [c0.x - c0.tz * 22 + c0.tx * 18, y0 + 9, c0.z + c0.tx * 22 + c0.tz * 18].map((v, k) => (k === 1 ? v : v)), [c0.x, y0 + 3, c0.z]);
  for (const c of T.CHECKPOINTS.slice(1)) chase(`Checkpoint ${c.i}`, c.x, c.z, c.tx, c.tz, { back: 20, up: 7, ahead: 4 });
} else {
  chase('Trailhead', sp.x, sp.z, fwd[0], fwd[1], { back: 13, up: 6, ahead: 12 });
  for (const t of T.TRAILS) {
    if (t.stages || t.graded === false) continue;
    const p = T.pathPoint(t, 3);
    chase(`Trail start ${t.name}`, p.x, p.z, p.tx, p.tz, { back: 12, up: 6, ahead: 14, render: MAP_ID === 'park' || MAP_ID === 'desert' || MAP_ID === 'jungle' });
  }
}
if (MAP_ID === 'crawl') {
  const t = T.TRAILS[0];
  for (const st of T.MAP.STAGES) { const p = T.pathPoint(t, Math.max(0, st.gateS - 2)); chase(`Stage ${st.n} ${st.name}`, p.x, p.z, p.tx, p.tz, { back: 12, up: 6, ahead: 14, render: [1, 4, 8, 12].includes(st.n) }); }
  for (const C of T.COURSES) { const p = T.pathPoint(C, Math.max(0, C.stages[0].gateS - 2)); chase(`Course ${C.name}`, p.x, p.z, p.tx, p.tz, { back: 18, up: 12, ahead: 22 }); }
  orbit('Summit', T.MAP.SUMMIT.x, T.MAP.SUMMIT.z, { dist: 45, up: 22, bearing: 2.4 });
}
if (MAP_ID === 'jungle') {
  const M = T.MAP, D = M.DECOR;
  if (D.lighthouse) orbit('Lava Point Light', D.lighthouse.x, D.lighthouse.z, { y: D.lighthouse.y, dist: 34, up: 10, bearing: Math.atan2(-D.lighthouse.x, -D.lighthouse.z) + 0.5, lift: 5 });
  const br = D.bridges[0], r = br && T.ROADS.find((q) => q.name === br.road);
  if (r) { const p = T.pathPoint(r, (br.s0 + br.s1) / 2); orbit('Coast Road bridge', p.x, p.z, { dist: 34, up: 16, bearing: Math.atan2(p.tx, p.tz) + 0.35 }); } // (from along the road: the creek banks are wooded)
  if (D.dock) orbit('Palm Cove Dock', (D.dock.x0 + D.dock.x1) / 2, (D.dock.z0 + D.dock.z1) / 2, { y: D.dock.y, dist: 38, up: 12, bearing: Math.atan2(D.dock.x1, D.dock.z1) + 1.6 });
  orbit('Ember Falls', M.POOL.x, M.POOL.z, { y: M.POOL.w, dist: 30, up: 10, bearing: 1.2, lift: 3 });
  orbit('Summit Viewpoint', M.SUMMIT_LOT.x, M.SUMMIT_LOT.z, { dist: 60, up: 25, bearing: Math.atan2(M.SUMMIT_LOT.x - M.PEAK.x, M.SUMMIT_LOT.z - M.PEAK.z) });
}
if (MAP_ID === 'desert') {
  const M = T.MAP, L = M.LANDMARKS;
  orbit('Arch', L.arch.x, L.arch.z, { dist: 42, up: 6, bearing: L.arch.rotY + Math.PI / 2 + 0.3, lift: 6 });
  orbit('Hoodoos', L.hoodoos.x, L.hoodoos.z, { dist: 70, up: 16, bearing: 0.8, lift: 3 });
  orbit('Saffron Sea', M.ERG.x, M.ERG.z, { dist: 300, up: 85, bearing: -1.25, lift: 0, fov: 50 });
  orbit('Sunfall Station camp', T.TRAILHEAD.x, T.TRAILHEAD.z + 10, { dist: 48, up: 16, bearing: 2.6 });
}
const S4 = (MAP_ID === 'jungle' ? SIZE * 0.78 : SIZE) / 400; // (the island fills about 80% of its map)
cam('Overview', [0, 230 * S4, 300 * S4], [0, 0, -10 * S4], { fov: 50, fog: false });
cam('Top (ortho)', [0, 400 * S4 + 100, 0.001], [0, 0, 0], { ortho: SIZE * (MAP_ID === 'jungle' ? 0.86 : 1.05), fog: false });

// ---------- look: sky, haze, toon bands (gfx/palette.js, gfx/toon.js, the map view's fog) ----------
const c3 = (v) => '#' + new THREE.Color(v.r ?? v.x, v.g ?? v.y, v.b ?? v.z).getHexString();
const look = {
  sky: hexi(PAL.SKY), skyBands: PAL.SKY_BANDS.map(hexi), fog: hex(scene.fog.color), fogNear: scene.fog.near, fogFar: scene.fog.far, fogMax: PAL.FOG_MAX,
  backdrop: PAL.BACKDROP.map(hexi), outline: hexi(PAL.OUTLINE),
  sun: hex(sun.color), sunDir: [-0.45, 0.8, 0.35], hemiSky: hex(hemi.color), hemiGround: hex(hemi.groundColor),
  toonShade: c3(TOON.uToonShade.value), toonLit: c3(TOON.uToonLit.value), toonHi: c3(TOON.uToonHi.value), toonUnder: TOON.uToonUnder.value, toonBands: [TOON.uToonBands.value.x, TOON.uToonBands.value.y],
  cameraFar: camera.far,
};

const world = {
  map: { id: MAP_ID, name: T.MAP_NAME, kind: T.MAP_KIND, size: SIZE, res: RES, cell: SIZE / RES, nRoads: T.ROADS.length, sea: T.MAP.SEA?.y ?? null, layout: 'ix-major: index = ix * (res + 1) + iz; x = -size/2 + ix * cell, z = -size/2 + iz * cell (three.js axes, y up)' },
  look,
  materials: T.MAT_INFO.map((m, i) => ({ id: i, name: m.name, color: m.color, mu: m.mu, layer: LAYERS[i] })),
  layers: LAYERS.map((l) => ({ name: l, tile: `tiles/${l}.png` })),
  tile: { px: TILE, metres: TILE_M },
  spawn: T.SPAWN, trailhead: T.TRAILHEAD, startS: T.MAP.START_S ?? null,
  paths, points, cameras: cams,
  colliderProps: T.PROPS,
  rocks: rockOut,
  trees: trees.map((t) => ({ x: r3(t.x), y: r3(t.y), z: r3(t.z), s: r3(t.s), kind: t.kind ?? null })),
  dressing, markers, structures: struct, water: waterOut, backdrop: backdropOut, geoms, mats,
  modelFiles,
  warnings: [...warnings, ...spawnWarn],
};
fs.writeFileSync(path.join(OUT, 'blob.bin'), Buffer.concat(blob));
fs.writeFileSync(path.join(OUT, 'world.json'), JSON.stringify(world));

const count = (s) => (s ? Object.values(s.assets).reduce((a, b) => a + b.items.n, 0) + s.meshes.reduce((a, b) => a + b.items.n, 0) : 0);
console.log(`[export] ${T.MAP_NAME} -> ${path.relative(ROOT, OUT)} (${(blobLen / 1e6).toFixed(1)} MB blob)`);
console.log(`  grid ${N1}^2 at ${SIZE / RES} m, ${paths.length} paths, ${rockOut.length}/${rocks.length} rocks, ${trees.length} trees, ${points.length} points (${spawns.length} spawn points), ${cams.length} cameras`);
console.log(`  dressing: ${count(dressing)} placements (${Object.values(dressing.assets).map((v) => `${v.asset} ${v.items.n}`).join(', ')}; procedural: ${dressing.meshes.map((m) => `${m.name} ${m.items.n}`).join(', ') || 'none'})`);
console.log(`  markers: ${count(markers)} placements, ${markers.meshes.length} part kinds, ${Object.keys(markers.groups).length} groups; structures ${count(struct)}; water ${count(waterOut)}; ${geoms.length} geometries, ${mats.length} materials, ${texFiles.size} textures`);
if (world.warnings.length) console.log('  warnings:\n   ' + world.warnings.join('\n   '));
