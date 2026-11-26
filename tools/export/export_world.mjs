// Export a LowRange map for Blender (tools/blender/world/build_world.py).
//
//   node tools/export/export_world.mjs            -> the Trail Park  (map id 'park')
//   MAP=race node tools/export/export_world.mjs   -> the Race Track  (or: node ... race)
//
// Imports the game's own modules (src/terrain.js, src/maps/*, src/world_view.js,
// src/race_view.js, src/art/*, src/gfx/pixeltex.js), so the export always matches what the game
// builds. The view builders run headless against a stand-in `document` (sign/banner canvases
// only record their text) and stand-in glTF assets (one tagged box per public/models/*.glb), so
// set dressing makes the same random draws and variant picks as in the browser with the real
// models loaded. Writes tools/blender/world/export/<map>/ (gitignored):
//
//   world.json        map info, materials, paths, rocks, trees, dressing, markers, cameras
//   grid_vis.f32      visual heights (what the game draws), (RES+1)^2 float32, ix-major
//   grid_h.f32        physics heights, same layout
//   grid_mat.u8       surface material per grid vertex (MAT index), same layout
//   grid_path.i16     path id per grid vertex (-1 = none; < roads.length = road, else trail)
//   tiles/<name>.png  the generated 128 x 128 ground tiles (4 m each, 32 px/m), one per MAT
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mapArg = process.argv[2] || process.env.MAP || 'park';
if (!['park', 'race'].includes(mapArg)) { console.error(`unknown map "${mapArg}" (park | race)`); process.exit(1); }
process.env.MAP = mapArg; // read by src/terrain.js at import

// ---------- headless stand-ins ----------
// Canvas 2D context that records what is drawn as text (sign boards, banners, labels).
function fakeCanvas() {
  const rec = { texts: [], bg: null, check: false };
  let fill = '#000';
  const ctx = new Proxy({}, {
    get(_, k) {
      if (k === 'fillStyle') return fill;
      if (k === 'fillRect') return (x, y, w, h) => { if (rec.bg === null) rec.bg = fill; else if (fill === '#111') rec.check = true; };
      if (k === 'fillText') return (t) => { if (String(t).trim()) rec.texts.push({ text: String(t), color: fill }); };
      if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      return () => {};
    },
    set(_, k, v) { if (k === 'fillStyle') fill = v; return true; },
  });
  return { width: 0, height: 0, getContext: () => ctx, __rec: rec };
}
globalThis.document = { createElement: () => fakeCanvas() };

const THREE = await import('three');
const { ConvexGeometry } = await import('three/examples/jsm/geometries/ConvexGeometry.js');
const assets = await import('../../src/art/assets.js');

// stand-in glTF assets: same names as public/models, a tiny box each, material named after the file
const MODELS = path.join(ROOT, 'public/models');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.glb$/i.test(e.name) ? [path.join(d, e.name)] : []));
const modelFiles = walk(MODELS).map((f) => path.relative(MODELS, f).split(path.sep).join('/'));
const ASSETS = await assets.loadArtAssets(); // the module's own map (stays empty without a real browser)
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
const { groundTextureArray, LAYERS, TILE, TILE_M } = await import('../../src/gfx/pixeltex.js');
const { shapeRockGeometry } = await import('../../src/gfx/terrain_look.js');

const OUT = path.join(ROOT, 'tools/blender/world/export', T.MAP_ID);
fs.mkdirSync(path.join(OUT, 'tiles'), { recursive: true });
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r3 = (v) => Math.round(v * 1e3) / 1e3;

// ---------- grid ----------
const { GRID, SIZE, RES } = T;
fs.writeFileSync(path.join(OUT, 'grid_vis.f32'), Buffer.from(GRID.vis.buffer, GRID.vis.byteOffset, GRID.vis.byteLength));
fs.writeFileSync(path.join(OUT, 'grid_h.f32'), Buffer.from(GRID.h.buffer, GRID.h.byteOffset, GRID.h.byteLength));
fs.writeFileSync(path.join(OUT, 'grid_mat.u8'), Buffer.from(GRID.mat.buffer, GRID.mat.byteOffset, GRID.mat.byteLength));
fs.writeFileSync(path.join(OUT, 'grid_path.i16'), Buffer.from(GRID.path.buffer, GRID.path.byteOffset, GRID.path.byteLength));

// ---------- ground tiles (src/gfx/pixeltex.js, generated exactly as in the game) ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function png(file, w, h, rgba) {
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}
const tiles = groundTextureArray().image.data;
// PNG rows top-down = texture data rows 0..127 (the texture's v = 0 row is the first PNG row)
LAYERS.forEach((name, i) => png(path.join(OUT, 'tiles', `${name}.png`), TILE, TILE, tiles.subarray(i * TILE * TILE * 4, (i + 1) * TILE * TILE * 4)));

// ---------- rocks: the game's exact convex hulls and vertex tone (world_view.buildRocks) ----------
const rocks = T.generateRocks();
const rockOut = [];
for (const r of rocks) {
  const pts = [];
  for (let i = 0; i < r.pts.length; i += 3) pts.push(new THREE.Vector3(r.pts[i], r.pts[i + 1], r.pts[i + 2]));
  let g;
  try { g = new ConvexGeometry(pts); } catch { continue; }
  // hull in the rock's own frame (yaw and position go on the Blender object); the tone only
  // depends on height, which a yaw doesn't change
  const m = shapeRockGeometry(g, r.ledge, rockOut.length);
  const p = m.attributes.position, c = m.attributes.color;
  rockOut.push({
    x: r4(r.x), y: r4(r.y), z: r4(r.z), rotY: r4(r.rotY), ledge: !!r.ledge,
    v: Array.from(p.array, r4), i: Array.from(m.index.array), tone: Array.from({ length: c.count }, (_, k) => r3(c.getX(k))),
  });
}
const trees = T.generateTrees(rocks);

// ---------- generic three.js scene -> JSON (procedural markers, race dressing, procedural props) ----------
const geoms = [], geomIdx = new Map(), mats = [], matIdx = new Map();
const hex = (c) => '#' + c.getHexString();
function geomRef(g) {
  if (geomIdx.has(g.uuid)) return geomIdx.get(g.uuid);
  g.computeBoundingBox();
  const p = g.attributes.position, col = g.attributes.color;
  const rec = {
    type: g.type, v: Array.from(p.array, r4),
    i: g.index ? Array.from(g.index.array) : null,
    groups: g.groups.map((q) => [q.start, q.count, q.materialIndex]),
    color: col ? Array.from(col.array, r3) : null, // linear vertex colours
    bbox: [...g.boundingBox.min.toArray(), ...g.boundingBox.max.toArray()].map(r4),
  };
  geomIdx.set(g.uuid, geoms.push(rec) - 1);
  return geomIdx.get(g.uuid);
}
function matRef(m) {
  if (matIdx.has(m.uuid)) return matIdx.get(m.uuid);
  const rec = { name: m.name || '', color: hex(m.color), emissive: m.emissive ? hex(m.emissive) : '#000000', opacity: m.opacity, transparent: m.transparent, vertexColors: !!m.vertexColors, doubleSided: m.side === THREE.DoubleSide };
  const img = m.map && m.map.image;
  if (img && img.__rec) Object.assign(rec, { texts: img.__rec.texts, bg: img.__rec.bg, check: img.__rec.check });
  matIdx.set(m.uuid, mats.push(rec) - 1);
  return matIdx.get(m.uuid);
}
const mat16 = (m) => m.elements.map(r4);
// Walk a built group: glTF stand-ins become asset instances, everything else becomes meshes
// (InstancedMesh -> one mesh with many matrices). `label(obj, path)` names the result.
function serialize(root, label) {
  root.updateMatrixWorld(true);
  const assetsOut = {}, meshes = [];
  const tmp = new THREE.Matrix4(), col = new THREE.Color();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mlist = Array.isArray(o.material) ? o.material : [o.material];
    const asset = mlist[0].name.startsWith('asset:') ? mlist[0].name.slice(6) : null;
    let cat = 'misc', grp = null; for (let a = o; a && a !== root; a = a.parent) if (a.name && a.name !== 'props') { cat = a.name; grp = a; break; }
    const items = [];
    if (o.isInstancedMesh) {
      for (let k = 0; k < o.count; k++) {
        o.getMatrixAt(k, tmp); tmp.premultiply(o.matrixWorld);
        const it = { m: mat16(tmp) };
        if (o.instanceColor) { o.getColorAt(k, col); it.c = hex(col); }
        items.push(it);
      }
    } else items.push({ m: mat16(o.matrixWorld) });
    if (asset) { (assetsOut[asset] ||= { category: cat, items: [] }).items.push(...items); return; }
    const rec = { name: label(o, cat), category: cat, geom: geomRef(o.geometry), mats: mlist.map(matRef), items };
    if (grp && grp.isGroup && !o.isInstancedMesh) rec.groupM = mat16(grp.matrixWorld); // sign / gate / stand: parts share a parent
    // one record per distinct part (the instancer splits a scatter into 100 m chunks)
    const same = o.isInstancedMesh && meshes.find((q) => q.geom === rec.geom && q.name === rec.name && q.mats.join() === rec.mats.join());
    if (same) same.items.push(...items); else meshes.push(rec);
  });
  return { assets: assetsOut, meshes };
}

// ---------- set dressing (world_view.buildTrees -> art/dressing.js), exactly as the game builds it ----------
const dressing = serialize(WV.buildTrees(trees), (o, cat) => cat);

// ---------- trail-park markers (world_view.buildMarkers) / race dressing (race_view.buildRaceDressing) ----------
const RACE_NAMES = { // race_view.js material colours -> what the part is
  '#b9b4aa': 'Concrete barrier', '#c0392b': 'Barrier stripe', '#1c1c1c': 'Tyre wall', '#eeeeea': 'White tyre / paint', '#f2f2ee': 'Marker post / arch pole',
  '#ff6a13': 'Apex cone', '#3a3d42': 'Steel (gantry / venue sign)', '#8a8f96': 'Grandstand step', '#9da2a8': 'Grandstand step', '#c23b22': 'Red (roof / tent / flag)',
  '#55585c': 'Pole', '#9aa0a6': 'Catch fence', '#ffd21f': 'Spectator tape', '#777777': 'Tent pole', '#888888': 'Flag pole', '#4a6f78': 'Water splash',
  '#220a08': 'Start light', '#dadada': 'Trailer', '#2b2b2b': 'Trailer', '#9e2a1e': 'Trailer', '#1f4fa8': 'Trailer', '#f2efe6': 'Tent / flag', '#2f6fb5': 'Tent / flag', '#f2c94c': 'Tent / flag',
};
let markers;
const scene = new THREE.Group();
if (T.MAP_KIND === 'race') {
  const { buildRaceDressing } = await import('../../src/race_view.js');
  buildRaceDressing(scene);
  let stand = 0;
  for (const c of scene.children) {
    if (!c.isGroup) continue;
    let t = null;
    c.traverse((o) => { const r = o.material?.map?.image?.__rec; if (r && r.texts.length) t = r.texts[0].text; });
    c.name = t ? (t.startsWith('CHECKPOINT') ? `Arch ${t}` : 'Start-finish gantry') : `Grandstand ${++stand}`;
  }
  markers = serialize(scene, (o) => {
    const m = Array.isArray(o.material) ? o.material : [o.material];
    const t = m.map((q) => q.map?.image?.__rec?.texts?.[0]?.text).find(Boolean);
    if (t) return t;
    if (o.isInstancedMesh && o.geometry.type === 'BoxGeometry') {
      const w = o.geometry.parameters.width;
      const kind = { 0.46: 'Spectator', 0.24: 'Spectator head', 0.12: 'Marker post', 0.14: 'Marker post top' }[w];
      if (kind) return kind;
    }
    if (o.geometry.type === 'PlaneGeometry' && !o.isInstancedMesh && m[0].map) return 'Start line (chequered)';
    if (o.geometry.type === 'PlaneGeometry' && hex(m[0].color) === '#eeeeea') return 'Grid line';
    return RACE_NAMES[hex(m[0].color)] || o.geometry.type.replace('Geometry', '');
  });
} else {
  WV.buildMarkers(scene);
  // name each part from what it is: sign boards / gate banners carry their text
  const groupText = (g) => { let t = null; g.traverse((o) => { const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []; for (const q of ms) { const r = q.map?.image?.__rec; if (r && r.texts.length && !t) t = r.texts.map((x) => x.text); } }); return t; };
  const seen = {};
  for (const c of scene.children) {
    const t = c.isGroup ? groupText(c) : null;
    if (!t) continue;
    if (t.includes('START') || t.includes('FINISH')) c.name = `Gate ${t[0]} (${t.includes('START') ? 'start' : 'finish'})`;
    else { const n = (seen[t[0]] = (seen[t[0]] || 0) + 1); c.name = t[0] === 'LOW RANGE' ? 'Sign Trailhead' : `Sign ${t[0]} (${n === 1 ? 'start' : 'finish'})`; }
  }
  markers = serialize(scene, (o, cat) => {
    if (cat !== 'misc') return cat + (o.geometry.type === 'PlaneGeometry' ? ' banner' : o.geometry.parameters?.height > 2 ? ' post' : o.geometry.type === 'BoxGeometry' && o.geometry.parameters.width > 2 ? ' board' : ' part');
    const c = o.material.color.getHex();
    if (c === 0xf2f2ee) return 'Road edge post';
    if (c === 0xff3b2f) return 'Road post reflector';
    if (c === 0x6b5a44) return 'Trail marker post';
    return 'Trail marker top';
  });
}

// ---------- paths ----------
const pathOut = (p, kind) => ({
  name: p.name, kind, diff: p.diff ?? null, diffLabel: p.diff ? T.DIFF[p.diff].label : null, diffColor: p.diff ? T.DIFF[p.diff].color : null,
  width: p.width, shoulder: p.shoulder, length: r3(p.length), closed: !!p.closed, mud: p.mud ?? null,
  pts: p.pts.map((q) => [r3(q.x), r3(q.h), r3(q.z)]),
});
const paths = [...T.ROADS.map((p) => pathOut(p, 'road')), ...T.TRAILS.map((p) => pathOut(p, 'trail'))];
if (T.TRACK) paths.push(pathOut(T.TRACK, 'track'));

// trail starts/ends (where world_view puts the gates and signs)
const trailEnds = T.TRAILS.map((t) => {
  const a = T.pathPoint(t, 3), b = T.pathPoint(t, t.length - 3);
  return { name: t.name, diff: t.diff, start: { x: r3(a.x), y: r3(T.heightAt(a.x, a.z)), z: r3(a.z), tx: r4(a.tx), tz: r4(a.tz) }, end: { x: r3(b.x), y: r3(T.heightAt(b.x, b.z)), z: r3(b.z), tx: r4(b.tx), tz: r4(b.tz) } };
});

const world = {
  map: { id: T.MAP_ID, name: T.MAP_NAME, kind: T.MAP_KIND, size: SIZE, res: RES, cell: SIZE / RES, nRoads: T.ROADS.length, layout: 'ix-major: index = ix * (res + 1) + iz; x = -size/2 + ix * cell, z = -size/2 + iz * cell (three.js axes, y up)' },
  materials: T.MAT_INFO.map((m, i) => ({ id: i, name: m.name, color: m.color, mu: m.mu, layer: LAYERS[i], tile: `tiles/${LAYERS[i]}.png` })),
  tile: { px: TILE, metres: TILE_M },
  spawn: T.SPAWN, trailhead: T.TRAILHEAD, startS: T.MAP.START_S ?? null,
  paths, trailEnds,
  checkpoints: T.CHECKPOINTS.map((c) => ({ ...c, y: r3(T.heightAt(c.x, c.z)) })),
  colliderProps: T.PROPS,
  rocks: rockOut,
  trees: trees.map((t) => ({ x: r3(t.x), y: r3(t.y), z: r3(t.z), s: r3(t.s) })),
  dressing, markers, geoms, mats,
  modelFiles,
};
fs.writeFileSync(path.join(OUT, 'world.json'), JSON.stringify(world));

const count = (s) => Object.values(s.assets).reduce((a, b) => a + b.items.length, 0) + s.meshes.reduce((a, b) => a + b.items.length, 0);
console.log(`[export] ${T.MAP_NAME} -> ${path.relative(ROOT, OUT)}`);
console.log(`  grid ${RES + 1}^2, ${paths.length} paths, ${rockOut.length}/${rocks.length} rocks, ${trees.length} trees`);
console.log(`  dressing: ${count(dressing)} placements (${Object.entries(dressing.assets).map(([k, v]) => `${k} ${v.items.length}`).join(', ')}; procedural: ${dressing.meshes.map((m) => `${m.name} ${m.items.length}`).join(', ') || 'none'})`);
console.log(`  markers/race dressing: ${count(markers)} placements, ${markers.meshes.length} mesh kinds, ${geoms.length} geometries`);
