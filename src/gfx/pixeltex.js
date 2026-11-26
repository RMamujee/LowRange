// Hand-pixelled ground tiles, generated once at load: one 128 x 128 tile (4 m at 32 px/m)
// per surface material, in MAT order, stacked into a texture array. Each tile is drawn with its
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
    t.patches(G, 2, 11, -0.38, 0.5, half(G[1], G[2]), half(G[1], G[0]), 0.05);
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
    t.patches(D, 2, 21, -0.5, 0.55, half(D[1], D[2]), half(D[1], D[0]), 0.05);
    for (let k = 0; k < 12; k++) t.pebble(Math.floor(R() * TILE), Math.floor(R() * TILE), 2 + Math.floor(R() * 2), 2, R() < 0.5 ? RAMP.rock : [D[0], D[1], D[2]], D[2]);
  },
  // 2 rock (bare trail rock, cliff bands): weathered slab in broad tone areas with a few long
  // bedding cracks (lit lip above, shaded line below)
  rock(t, R) {
    const K = RAMP.rock;
    t.fill(K[1]);
    t.patches(K, 2, 23, -0.4, 0.42, half(K[1], K[2]), half(K[1], K[0]), 0.05);
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
    t.patches(M, 2, 31, -0.3, 0.55, M[2], M[0], 0.05);
    t.patches(M, 3, 37, -0.62, 9, M[3], null, 0.05);
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
    t.patches(D, 2, 51, -0.4, 9, half(D[1], D[2]), null, 0.05);
    for (let k = 0; k < 150; k++) t.pebble(Math.floor(R() * TILE), Math.floor(R() * TILE), 2 + Math.floor(R() * 2), 2, R() < 0.5 ? [K[0], K[1], K[2]] : [K[1], K[1], K[2]], D[2]);
  },
  // 6 graded road: compacted pale dirt, broad worn areas, a few pebbles
  road(t, R) {
    const D = RAMP.road;
    t.fill(D[1]);
    t.patches(D, 2, 61, -0.45, 9, half(D[1], D[2]), null, 0.05);
    for (let k = 0; k < 10; k++) t.pebble(Math.floor(R() * TILE), Math.floor(R() * TILE), 2, 2, RAMP.rock, D[2]);
  },
  // 7 tarmac: warm dark grey with soft patching and the odd crack
  tarmac(t, R) {
    const A = RAMP.tarmac;
    t.fill(A[1]);
    t.patches(A, 2, 71, -0.4, 0.45, A[2], A[0], 0.05);
    for (let k = 0; k < 3; k++) { let x = Math.floor(R() * TILE), y = Math.floor(R() * TILE); for (let i = 0; i < 14; i++) { t.set(x, y, A[2]); x += 1; if (R() < 0.4) y += R() < 0.5 ? 1 : -1; } }
  },
  // 8 water: teal with a few glinting dashes
  water(t, R) {
    const W = RAMP.water;
    t.fill(W[1]);
    t.patches(W, 2, 81, -0.3, 9, W[2], null, 0.05);
    for (let k = 0; k < 24; k++) { const x = Math.floor(R() * TILE), y = Math.floor(R() * TILE), n = 2 + Math.floor(R() * 5); for (let i = 0; i < n; i++) t.set(x + i, y, W[0]); }
  },
  // 9 boulder skin (gameplay rocks, untextured props): soft mottling and a few short cracks with
  // a lit edge. The rock's vertex tone and the toon bands do the light-top / dark-base shaping
  boulder(t, R) {
    const K = RAMP.rock;
    t.fill(K[1]);
    t.patches(K, 3, 91, -0.42, 0.32, K[2], K[0], 0.06);
    for (let k = 0; k < 9; k++) {
      let x = Math.floor(R() * TILE), y = Math.floor(R() * TILE);
      const n = 3 + Math.floor(R() * 5), dx = R() < 0.5 ? 1 : -1;
      for (let i = 0; i < n; i++) { t.set(x, y - 1, K[0]); t.set(x, y, K[3]); x += dx; if (R() < 0.45) y += 1; }
    }
  },
};
export const LAYERS = ['grass', 'dirt', 'rock', 'mud', 'sand', 'gravel', 'road', 'tarmac', 'water', 'boulder']; // = MAT order, then extras
export const LAYER_BOULDER = 9;

// GLSL: sample a ground layer at a world-space position, 32 px/m. Steps down whole mips as texels
// shrink below a screen pixel, then fades to the layer's flat average colour (its 1x1 mip), so
// distant surfaces stay calm instead of crawling.
export const GROUND_GLSL = /* glsl */ `
uniform highp sampler2DArray uGround;
vec3 groundTex(vec2 wp, float layer) {
  vec2 uv = wp / ${TILE_M.toFixed(1)};
  vec2 d = fwidth(uv * ${TILE.toFixed(1)});
  // texels per screen pixel along the most squashed axis (ground is strongly foreshortened under
  // a chase camera): a texel never gets smaller than about a pixel and a half, so nothing crawls
  float lod = log2(max(max(d.x, d.y), 1e-6));
  // whole mip steps (box-averaged pixel art stays pixel art) down the full chain: the broad tone
  // areas survive into the distance as soft blocks, the sparse marks drop out first
  vec3 c = textureLod(uGround, vec3(uv, layer), clamp(floor(lod + 0.9), 0.0, 7.0)).rgb;
  vec3 cf = textureLod(uGround, vec3(uv, layer), 7.0).rgb;
  return mix(c, cf, smoothstep(3.0, 4.5, lod));
}
float pxHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float pxNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(pxHash(i), pxHash(i + vec2(1.0, 0.0)), f.x), mix(pxHash(i + vec2(0.0, 1.0)), pxHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

let cached = null;
// All ground tiles as one sRGB texture array (layer = MAT index), nearest-sampled, with mips
// (the shader uses the smallest mip as each material's flat average colour for far ground).
export function groundTextureArray() {
  if (cached) return cached;
  const data = new Uint8Array(TILE * TILE * 4 * LAYERS.length);
  LAYERS.forEach((name, i) => {
    const t = canvasTile();
    DRAW[name](t, rng(1000 + i * 77));
    data.set(t.px, i * TILE * TILE * 4);
  });
  const tex = new THREE.DataArrayTexture(data, TILE, TILE, LAYERS.length);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapNearestFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}
