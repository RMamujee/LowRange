// Hand-pixelled ground tiles, generated once at load: one 128 x 128 tile (4 m at 32 px/m)
// per surface material, in MAT order, stacked into a texture array with hand-made coarser levels. Each tile is drawn with its
// ART_STYLE ramp (highlight / base / shade / deep shade) as deliberate marks: pebbles with a lit
// top and a dark underside, grass blades and tiny flowers, cracked rock plates, sand ripples.
// Every pattern wraps, so the tiles repeat seamlessly in world space.
import * as THREE from 'three';
import { RAMP, FLOWERS, rgb } from './palette.js';

export const TILE = 128;          // texels per tile side
export const TILE_M = 4;          // metres per tile (=> 32 px/m)

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function ihash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const wrap = (v) => ((v % TILE) + TILE) % TILE;
// tileable value noise: `cells` lattice cells across the tile, smooth-interpolated, -1..1
function pnoise(x, y, cells, seed) {
  const f = cells / TILE, gx = x * f, gy = y * f;
  const ix = Math.floor(gx), iy = Math.floor(gy), tx = gx - ix, ty = gy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const h = (a, b) => ihash(((a % cells) + cells) % cells, ((b % cells) + cells) % cells, seed);
  const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
  return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1;
}
const fbm = (x, y, cells, seed) => (pnoise(x, y, cells, seed) * 0.6 + pnoise(x, y, cells * 2, seed + 1) * 0.3 + pnoise(x, y, cells * 4, seed + 2) * 0.1);
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
// the colour halfway between two ramp steps: broad tone areas use it so they stay gentle
const half = (a, b) => { const p = rgb(a), q = rgb(b); return (((p[0] + q[0]) >> 1) << 16) | (((p[1] + q[1]) >> 1) << 8) | ((p[2] + q[2]) >> 1); };

// A tile under construction: an RGBA byte array plus a few pixel-art drawing helpers.
function canvasTile() {
  const px = new Uint8Array(TILE * TILE * 4);
  const set = (x, y, hex) => { const o = (wrap(y) * TILE + wrap(x)) * 4, c = rgb(hex); px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255; };
  const fill = (hex) => { for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) set(x, y, hex); };
  // noise-thresholded patches with an ordered-dither fringe (stepped, not blurred)
  const patches = (ramp, cells, seed, lo, hi, loHex, hiHex, fringe = 0.06) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const n = fbm(x, y, cells, seed), d = bayer(x, y) * fringe * 2 - fringe;
      if (loHex !== null && n + d < lo) set(x, y, loHex);
      else if (hiHex !== null && n + d > hi) set(x, y, hiHex);
    }
  };
  // a small stone: lit top row, base body, dark underside and a cast-shadow pixel row
  const pebble = (x, y, w, h, ramp, shadowHex) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      if ((j === 0 || j === h - 1) && (i === 0 || i === w - 1) && w > 2 && h > 2) continue; // round the corners
      set(x + i, y + j, j === 0 ? ramp[0] : j === h - 1 ? ramp[2] : ramp[1]);
    }
    for (let i = (w > 2 ? 1 : 0); i < w - (w > 2 ? 1 : 0); i++) set(x + i, y + h, shadowHex);
  };
  return { px, set, fill, patches, pebble };
}

// Every tile follows the Blender props' recipe: mostly one flat ramp colour, broad soft tone
// areas, and sparse, deliberate marks (a tuft, a pebble, a crack) rather than speckle. Contrast
// inside a tile stays low so the ground sits back behind the vehicles and props.
const DRAW = {
  // 0 grass: broad sunny / shaded areas, a few blade tufts with a dark root, the odd flower
  grass(t, R) {
    const G = RAMP.grass;
    t.fill(G[1]);
    t.patches(G, 2, 11, -0.38, 0.5, half(G[1], G[2]), half(G[1], G[0]), 0.02);
    for (let k = 0; k < 26; k++) { // tufts: a fan of 3 to 5 blades from a dark root
      const x = Math.floor(R() * TILE), y = Math.floor(R() * TILE), n = 3 + Math.floor(R() * 3);
      t.set(x - 1, y + 1, G[2]); t.set(x, y + 1, G[2]); t.set(x + 1, y + 1, G[2]);
      for (let b = 0; b < n; b++) { const bx = x + b - (n >> 1), h = 2 + Math.floor(R() * 2); for (let j = 0; j < h; j++) t.set(bx + (j === h - 1 ? Math.sign(bx - x) : 0), y - j, j === h - 1 ? G[0] : G[1]); }
    }
    for (let k = 0; k < 6; k++) { // flowers: a plus of petals round a centre, shadow pixel underneath
      const x = Math.floor(R() * TILE), y = Math.floor(R() * TILE), p = FLOWERS[k % 2];
      t.set(x, y, FLOWERS[2]); t.set(x - 1, y, p); t.set(x + 1, y, p); t.set(x, y - 1, p); t.set(x, y + 1, p); t.set(x, y + 2, G[2]);
    }
  },
  // 1 dirt / trail: flat ochre, a couple of broad worn patches, sparse pebbles
  dirt(t, R) {
    const D = RAMP.dirt;
    t.fill(D[1]);
    t.patches(D, 2, 21, -0.5, 0.55, half(D[1], D[2]), half(D[1], D[0]), 0.02);
    for (let k = 0; k < 12; k++) t.pebble(Math.floor(R() * TILE), Math.floor(R() * TILE), 2 + Math.floor(R() * 2), 2, R() < 0.5 ? RAMP.rock : [D[0], D[1], D[2]], D[2]);
  },
  // 2 rock (bare trail rock, cliff bands): weathered slab in broad tone areas with a few long
  // bedding cracks (lit lip above, shaded line below)
  rock(t, R) {
    const K = RAMP.rock;
    t.fill(K[1]);
    t.patches(K, 2, 23, -0.4, 0.42, half(K[1], K[2]), half(K[1], K[0]), 0.02);
    for (let k = 0; k < 6; k++) {
      let x = Math.floor(R() * TILE), y = Math.floor(R() * TILE);
      const n = 14 + Math.floor(R() * 22);
      for (let i = 0; i < n; i++) { t.set(x, y - 1, K[0]); t.set(x, y, K[2]); x += 1; if (R() < 0.2) y += R() < 0.5 ? 1 : -1; }
    }
  },
  // 3 mud: dark, a few wet glints and puddle blobs
  mud(t, R) {
    const M = RAMP.mud;
    t.fill(M[1]);
    t.patches(M, 2, 31, -0.3, 0.55, M[2], M[0], 0.02);
    t.patches(M, 3, 37, -0.62, 9, M[3], null, 0.02);
    for (let k = 0; k < 14; k++) { const x = Math.floor(R() * TILE), y = Math.floor(R() * TILE), n = 2 + Math.floor(R() * 3); for (let i = 0; i < n; i++) t.set(x + i, y, M[0]); }
  },
  // 4 sand: pale with soft wind ripples
  sand(t) {
    const S = RAMP.sand;
    t.fill(S[1]);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const v = (y + pnoise(x, y, 4, 41) * 6 + 128) / 9.14; // 14 ripples per tile, wrapping
      if (v - Math.floor(v) < 0.1) t.set(x, y, S[2]);
    }
  },
  // 5 gravel: warm dirt with scattered small stones (lit top, dark underside)
  gravel(t, R) {
    const K = RAMP.rock, D = RAMP.dirt;
    t.fill(D[1]);
    t.patches(D, 2, 51, -0.4, 9, half(D[1], D[2]), null, 0.02);
    for (let k = 0; k < 150; k++) t.pebble(Math.floor(R() * TILE), Math.floor(R() * TILE), 2 + Math.floor(R() * 2), 2, R() < 0.5 ? [K[0], K[1], K[2]] : [K[1], K[1], K[2]], D[2]);
  },
  // 6 graded road: compacted pale dirt, broad worn areas, a few pebbles
  road(t, R) {
    const D = RAMP.road;
    t.fill(D[1]);
    t.patches(D, 2, 61, -0.45, 9, half(D[1], D[2]), null, 0.02);
    for (let k = 0; k < 10; k++) t.pebble(Math.floor(R() * TILE), Math.floor(R() * TILE), 2, 2, RAMP.rock, D[2]);
  },
  // 7 tarmac: warm dark grey with soft patching and the odd crack
  tarmac(t, R) {
    const A = RAMP.tarmac;
    t.fill(A[1]);
    t.patches(A, 2, 71, -0.4, 0.45, A[2], A[0], 0.02);
    for (let k = 0; k < 3; k++) { let x = Math.floor(R() * TILE), y = Math.floor(R() * TILE); for (let i = 0; i < 14; i++) { t.set(x, y, A[2]); x += 1; if (R() < 0.4) y += R() < 0.5 ? 1 : -1; } }
  },
  // 8 water: teal with a few glinting dashes
  water(t, R) {
    const W = RAMP.water;
    t.fill(W[1]);
    t.patches(W, 2, 81, -0.3, 9, W[2], null, 0.02);
    for (let k = 0; k < 24; k++) { const x = Math.floor(R() * TILE), y = Math.floor(R() * TILE), n = 2 + Math.floor(R() * 5); for (let i = 0; i < n; i++) t.set(x + i, y, W[0]); }
  },
  // 9 boulder skin (gameplay rocks, untextured props): soft mottling and a few short cracks with
  // a lit edge. The rock's vertex tone and the toon bands do the light-top / dark-base shaping
  boulder(t, R) {
    const K = RAMP.boulder;
    t.fill(K[1]);
    t.patches(K, 3, 91, -0.42, 0.32, K[2], K[0], 0.02);
    for (let k = 0; k < 9; k++) {
      let x = Math.floor(R() * TILE), y = Math.floor(R() * TILE);
      const n = 3 + Math.floor(R() * 5), dx = R() < 0.5 ? 1 : -1;
      for (let i = 0; i < n; i++) { t.set(x, y - 1, K[0]); t.set(x, y, K[3]); x += dx; if (R() < 0.45) y += 1; }
    }
  },
};
export const LAYERS = ['grass', 'dirt', 'rock', 'mud', 'sand', 'gravel', 'road', 'tarmac', 'water', 'boulder']; // = MAT order, then extras
export const LAYER_BOULDER = 9;

// Every layer is stored at LEVELS detail levels, each a full 128 x 128 tile, as consecutive array
// layers (layer * LEVELS + level). Level k is the tile simplified to 2^k-texel blocks by majority
// vote: every block is one real palette colour from the tile (no box-averaged in-between tones),
// so far ground is coarser pixel art with hard edges, not a blurred version of the near tile.
// Past the last level the ground takes the tile's dominant colour, flat (a uniform, no fetch).
export const LEVELS = 5;

// GLSL: sample a ground layer at a world-space position, 32 px/m. Steps to a coarser level as
// texels shrink (a block never gets smaller than about 1.15 screen pixels: texels any smaller
// reshuffle from frame to frame as the camera moves, the main ground shimmer), then to the
// flat colour, so distant surfaces stay calm instead of crawling, and every pixel stays crisp.
// Materials using it take groundUniforms().
export const GROUND_GLSL = /* glsl */ `
uniform highp sampler2DArray uGround;
uniform vec3 uGroundFlat[${LAYERS.length}];
uniform float uTexBias;
vec3 groundFlat(float layer) { return uGroundFlat[int(layer + 0.5)]; }
vec3 groundTex(vec2 wp, float layer) {
  vec2 uv = wp / ${TILE_M.toFixed(1)};
  vec2 d = fwidth(uv * ${TILE.toFixed(1)});
  // texels per screen pixel along the most squashed axis (ground is strongly foreshortened under
  // a chase camera); uTexBias (TEX_BIAS) keeps texels at least two device pixels at Sharp 1x
  float lod = log2(max(max(d.x, d.y), 1e-6)) + uTexBias;
  float k = max(floor(lod + 1.2), 0.0);
  if (k >= ${LEVELS.toFixed(1)}) return groundFlat(layer);
  return textureLod(uGround, vec3(uv, layer * ${LEVELS.toFixed(1)} + k), 0.0).rgb;
}
float pxHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float pxNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(pxHash(i), pxHash(i + vec2(1.0, 0.0)), f.x), mix(pxHash(i + vec2(0.0, 1.0)), pxHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

// Simplify a tile to 2x coarser blocks: each block takes the colour most of its four cells have
// (ties: the one nearest the four's mean), so only real tile colours survive.
function coarser(src, n) { // src: n x n RGBA, returns n/2 x n/2
  const m = n >> 1, out = new Uint8Array(m * m * 4);
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const idx = [((2 * y) * n + 2 * x) * 4, ((2 * y) * n + 2 * x + 1) * 4, ((2 * y + 1) * n + 2 * x) * 4, ((2 * y + 1) * n + 2 * x + 1) * 4];
    const mean = [0, 1, 2].map((c) => (src[idx[0] + c] + src[idx[1] + c] + src[idx[2] + c] + src[idx[3] + c]) / 4);
    let best = idx[0], bestScore = -1;
    for (const a of idx) {
      let votes = 0;
      for (const b of idx) if (src[a] === src[b] && src[a + 1] === src[b + 1] && src[a + 2] === src[b + 2]) votes++;
      const dist = Math.abs(src[a] - mean[0]) + Math.abs(src[a + 1] - mean[1]) + Math.abs(src[a + 2] - mean[2]);
      const score = votes * 1000 - dist;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    out.set(src.subarray(best, best + 4), (y * m + x) * 4);
  }
  return out;
}
// the tile's most frequent colour
function dominant(px) {
  const count = new Map();
  let best = 0, bestN = 0;
  for (let i = 0; i < px.length; i += 4) {
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2], c = (count.get(k) || 0) + 1;
    count.set(k, c);
    if (c > bestN) { bestN = c; best = k; }
  }
  return best;
}

let cached = null, flat = null;
// Texture detail bias in mip levels, shared by every ground sampler and world prop texture
// (toon.js): the pipeline sets log2(2 / pixel scale) at Sharp 1x, so the scene is drawn at native
// resolution while its pixel-art textures keep the Fine 2x density (the HD-2D recipe: crisp HD
// geometry, chunky texels), 0 at coarser sizes.
export const TEX_BIAS = { value: 0 };
// uniforms for GROUND_GLSL
export function groundUniforms() { groundTextureArray(); return { uGround: { value: cached }, uGroundFlat: { value: flat }, uTexBias: TEX_BIAS }; }
// All ground tiles as one sRGB texture array: layer = MAT index * LEVELS + detail level,
// nearest-sampled, no mipmaps (the levels are hand-made mips, see LEVELS).
export function groundTextureArray() {
  if (cached) return cached;
  const LS = TILE * TILE * 4;
  const data = new Uint8Array(LS * LAYERS.length * LEVELS);
  flat = [];
  LAYERS.forEach((name, i) => {
    const t = canvasTile();
    DRAW[name](t, rng(1000 + i * 77));
    let cur = t.px, n = TILE;
    flat.push(new THREE.Color(dominant(t.px))); // sRGB hex -> linear, like the sRGB texture decode
    for (let k = 0; k < LEVELS; k++) {
      const o = (i * LEVELS + k) * LS;
      if (k > 0) { cur = coarser(cur, n); n >>= 1; }
      const b = TILE / n; // block size in texels
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const s = (Math.floor(y / b) * n + Math.floor(x / b)) * 4;
        data.set(cur.subarray(s, s + 4), o + (y * TILE + x) * 4);
      }
    }
  });
  const tex = new THREE.DataArrayTexture(data, TILE, TILE, LAYERS.length * LEVELS);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}
