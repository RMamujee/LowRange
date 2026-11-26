// Pixel-art ground and gameplay rocks.
//
// Ground: one material for the whole heightfield. Each fragment looks up a surface on a 1 m grid
// after jittering its position on a pixel lattice, so borders between surfaces are pixel-stepped,
// organic lines rather than smooth blends, and picks that surface's ground tile (pixeltex.js),
// mapped in world space at 32 px/m. Where a texel would shrink below a screen pixel the tile fades
// to its flat average colour, so distant ground stays calm instead of crawling.
//
// Which surface: on roads, trails, the race track and anything gameplay owns outright (mud, water,
// sand, tarmac) the look shows the baked gameplay grid (GRID.mat) exactly, plus one cell of verge,
// so what a tyre grips is what the player sees. Off the paths the gameplay grid flips between
// rock, gravel, dirt and grass cell by cell with slope noise, which reads as orange-and-grey shards;
// there the look uses a calm "visual surface" instead (visualSurface below): large areas of grass
// or ochre dirt from low-frequency noise and a softened slope, rock only as outcrops and cliff bands
// on the steepest ground, cleaned of single-cell specks. Grass gets a darker rim where it meets
// another surface, like the painted edges of the reference art.
//
// Lighting: shading normals come from a softened copy of the heightfield (softenTerrainNormals),
// more softened off the paths, and the terrain uses a soft 3-step toon ramp (toon.js TOON_SOFT),
// so bands follow the big shape of a hill instead of flickering triangle by triangle.
//
// Rocks: keep their exact convex-hull geometry; get a boulder tile box-projected in world space
// (dominant axis, no blending), smoothed normals so the toon bands round them off, and vertex
// shading that lightens tops and darkens bases.
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm } from '../maps/common.js';
import { groundUniforms, GROUND_GLSL as SAMPLE, LAYER_BOULDER } from './pixeltex.js';
import { toonPatch, OUTLINE_ID } from './toon.js';

// Box blur of a (RES+1)^2 field, `passes` times with the given radius (separable).
function blurField(src, N1, radius, passes) {
  let a = Float32Array.from(src), b = new Float32Array(a.length);
  const w = 1 / (2 * radius + 1);
  for (let p = 0; p < passes; p++) {
    for (let ix = 0; ix < N1; ix++) for (let iz = 0; iz < N1; iz++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += a[Math.min(N1 - 1, Math.max(0, ix + k)) * N1 + iz];
      b[ix * N1 + iz] = s * w;
    }
    for (let ix = 0; ix < N1; ix++) for (let iz = 0; iz < N1; iz++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += b[ix * N1 + Math.min(N1 - 1, Math.max(0, iz + k))];
      a[ix * N1 + iz] = s * w;
    }
  }
  return a;
}

// Distance in cells (chamfer) from every grid vertex to the nearest vertex gameplay owns.
function pathDistance({ GRID, RES, MAT }) {
  const N1 = RES + 1, d = new Float32Array(N1 * N1);
  const owned = new Set([MAT.ROAD, MAT.TARMAC, MAT.MUD, MAT.SAND, MAT.WATER]);
  for (let i = 0; i < d.length; i++) d[i] = GRID.path[i] >= 0 || owned.has(GRID.mat[i]) ? 0 : 1e9;
  const D = 1.4142;
  for (let ix = 0; ix < N1; ix++) for (let iz = 0; iz < N1; iz++) {
    const i = ix * N1 + iz; let v = d[i];
    if (ix > 0) { v = Math.min(v, d[i - N1] + 1); if (iz > 0) v = Math.min(v, d[i - N1 - 1] + D); if (iz < RES) v = Math.min(v, d[i - N1 + 1] + D); }
    if (iz > 0) v = Math.min(v, d[i - 1] + 1);
    d[i] = v;
  }
  for (let ix = RES; ix >= 0; ix--) for (let iz = RES; iz >= 0; iz--) {
    const i = ix * N1 + iz; let v = d[i];
    if (ix < RES) { v = Math.min(v, d[i + N1] + 1); if (iz > 0) v = Math.min(v, d[i + N1 - 1] + D); if (iz < RES) v = Math.min(v, d[i + N1 + 1] + D); }
    if (iz < RES) v = Math.min(v, d[i + 1] + 1);
    d[i] = v;
  }
  return d;
}

// The surface the ground *shows* per grid vertex (MAT indices). Equal to GRID.mat on and right
// next to every path; calm, low-frequency grass / dirt / rock elsewhere. Cached per grid.
const VERGE = 1.5; // cells around a path that keep the gameplay material
let vsCache = null;
export function visualSurface({ GRID, RES, SIZE, MAT }) {
  if (vsCache && vsCache.GRID === GRID) return vsCache;
  const N1 = RES + 1, cell = SIZE / RES, n = N1 * N1;
  const dist = pathDistance({ GRID, RES, MAT });
  const hs = blurField(GRID.vis, N1, 2, 3); // ~5 m softened landform
  const at = (a, ix, iz) => a[Math.min(RES, Math.max(0, ix)) * N1 + Math.min(RES, Math.max(0, iz))];
  const cls = new Uint8Array(n);
  for (let ix = 0; ix < N1; ix++) for (let iz = 0; iz < N1; iz++) {
    const i = ix * N1 + iz, x = -SIZE / 2 + ix * cell, z = -SIZE / 2 + iz * cell;
    const s = Math.hypot(at(hs, ix + 1, iz) - at(hs, ix - 1, iz), at(hs, ix, iz + 1) - at(hs, ix, iz - 1)) / (2 * cell);
    const big = fbm(x * 0.016 + 31.7, z * 0.016 - 17.3, 3);  // ~60 m patches of bare earth
    const mid = fbm(x * 0.05 - 5.1, z * 0.05 + 11.9, 2);     // ~20 m wobble of the outcrop edges
    const m = GRID.mat[i];
    let c;
    // the ring of steep hills at the map edge reads as far green slopes, not a wall of rock
    const edge = Math.min(1, Math.max(0, (Math.max(Math.abs(x), Math.abs(z)) - SIZE * 0.38) / (SIZE * 0.08)));
    if (s + mid * 0.14 > 0.72 + edge * 0.6) c = MAT.ROCK;                       // cliff bands, outcrops
    else if (big * 0.9 + (s - 0.28) * 1.1 + mid * 0.12 - edge * 0.6 > 0.2) c = MAT.DIRT; // bare, steeper earth
    else c = MAT.GRASS;
    if (m === MAT.GRAVEL && s < 0.25) c = MAT.GRAVEL; // laid gravel (pits, pads) is flat: keep it
    cls[i] = c;
  }
  // majority filter: no single-cell specks of one surface inside another
  const tmp = new Uint8Array(n), cnt = new Uint8Array(16);
  for (let pass = 0; pass < 2; pass++) {
    for (let ix = 0; ix < N1; ix++) for (let iz = 0; iz < N1; iz++) {
      cnt.fill(0);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) cnt[at(cls, ix + dx, iz + dz)]++;
      const own = cls[ix * N1 + iz];
      let best = own;
      for (let k = 0; k < 16; k++) if (cnt[k] > cnt[best]) best = k;
      tmp[ix * N1 + iz] = cnt[best] >= 5 ? best : own;
    }
    cls.set(tmp);
  }
  const mat = new Uint8Array(n);
  for (let i = 0; i < n; i++) mat[i] = dist[i] <= VERGE ? GRID.mat[i] : cls[i];
  const materialAt = (x, z) => {
    const ix = Math.min(RES, Math.max(0, Math.round((x + SIZE / 2) / cell))), iz = Math.min(RES, Math.max(0, Math.round((z + SIZE / 2) / cell)));
    return mat[ix * N1 + iz];
  };
  vsCache = { GRID, mat, dist, materialAt };
  return vsCache;
}

export function terrainMaterial({ GRID, RES, SIZE, NROADS, MAT }) {
  const N1 = RES + 1;
  const vs = visualSurface({ GRID, RES, SIZE, MAT });
  // per grid vertex: R = shown surface, G = trail tread, B = gentle large-scale tone variation
  const data = new Uint8Array(N1 * N1 * 4);
  for (let ix = 0; ix < N1; ix++) for (let iz = 0; iz < N1; iz++) {
    const g = ix * N1 + iz, o = g * 4, m = vs.mat[g];
    data[o] = m;
    data[o + 1] = GRID.path[g] >= NROADS && m !== MAT.MUD ? 255 : 0;
    const nz = Math.sin(ix * 0.071 + Math.sin(iz * 0.05) * 2.1) * Math.sin(iz * 0.063 + Math.sin(ix * 0.045) * 1.7);
    data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    data[o + 3] = 255;
  }
  const grid = new THREE.DataTexture(data, N1, N1, THREE.RGBAFormat, THREE.UnsignedByteType);
  grid.magFilter = grid.minFilter = THREE.NearestFilter;
  grid.needsUpdate = true;

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.name = 'pixel_terrain';
  mat.userData.outlineId = OUTLINE_ID.GROUND;
  mat.onBeforeCompile = (shader) => {
    toonPatch(shader, mat);
    Object.assign(shader.uniforms, groundUniforms());
    shader.uniforms.uGrid = { value: grid };
    shader.uniforms.uGridInfo = { value: new THREE.Vector3(SIZE / 2, SIZE / RES, RES) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = mat3(modelMatrix) * objectNormal;');
    shader.fragmentShader = '#define TOON_SOFT\n' + shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\nuniform highp sampler2D uGrid;\nuniform vec3 uGridInfo;\n${SAMPLE}
float surfAt(ivec2 gi) {
  gi = clamp(gi, ivec2(0), ivec2(int(uGridInfo.z)));
  return floor(texelFetch(uGrid, ivec2(gi.y, gi.x), 0).r * 255.0 + 0.5); // row = ix, column = iz
}
// The surface with the largest bilinear weight among the four grid vertices round gp, and that
// weight. Borders run as soft curves and diagonals between vertices instead of a 1 m staircase
// (which a steep cut bank would stretch into tall teeth).
float surfVote(vec2 gp, out float share) {
  vec2 b = floor(gp), f = gp - b;
  ivec2 i = ivec2(b);
  float l00 = surfAt(i), l10 = surfAt(i + ivec2(1, 0)), l01 = surfAt(i + ivec2(0, 1)), l11 = surfAt(i + ivec2(1, 1));
  float w00 = (1.0 - f.x) * (1.0 - f.y), w10 = f.x * (1.0 - f.y), w01 = (1.0 - f.x) * f.y, w11 = f.x * f.y;
  float s00 = w00 + (l10 == l00 ? w10 : 0.0) + (l01 == l00 ? w01 : 0.0) + (l11 == l00 ? w11 : 0.0);
  float s10 = w10 + (l00 == l10 ? w00 : 0.0) + (l01 == l10 ? w01 : 0.0) + (l11 == l10 ? w11 : 0.0);
  float s01 = w01 + (l00 == l01 ? w00 : 0.0) + (l10 == l01 ? w10 : 0.0) + (l11 == l01 ? w11 : 0.0);
  float s11 = w11 + (l00 == l11 ? w00 : 0.0) + (l10 == l11 ? w10 : 0.0) + (l01 == l11 ? w01 : 0.0);
  float l = l00; share = s00;
  if (s10 > share) { l = l10; share = s10; }
  if (s01 > share) { l = l01; share = s01; }
  if (s11 > share) { l = l11; share = s11; }
  return l;
}`)
      .replace('#include <map_fragment>', /* glsl */ `
        {
          // pixel-stepped surface lookup: the position snaps to a fixed 1/8 m world lattice (so the
          // steps never move with the camera), is pushed by a smooth two-scale wobble (no grain:
          // no salt-and-pepper fringe), then takes the surface voted by the four grid vertices
          // round it: soft, organic borders
          float L = 0.125;
          vec2 lat = (floor(vWPos.xz / L) + 0.5) * L;
          vec2 j = (vec2(pxNoise(lat * 0.32), pxNoise(lat * 0.32 + 17.3)) - 0.5) * 1.2
                 + (vec2(pxNoise(lat * 1.1 + 5.0), pxNoise(lat * 1.1 + 41.0)) - 0.5) * 0.45;
          vec2 gp = (vWPos.xz + uGridInfo.x) / uGridInfo.y + j;
          float share;
          float layer = surfVote(gp, share);
          ivec2 gi = clamp(ivec2(floor(gp + 0.5)), ivec2(0), ivec2(int(uGridInfo.z)));
          vec4 cell = texelFetch(uGrid, ivec2(gi.y, gi.x), 0); // tread + tone of the nearest vertex
          // the tile is projected from above except on near-vertical faces (dominant axis, no blend)
          vec3 an = abs(normalize(vWNrm));
          vec2 tp = an.y > 0.55 ? vWPos.xz : an.x > an.z ? vWPos.zy : vWPos.xy;
          vec3 g = groundTex(tp, layer);
          // grass: a darker painted rim where it meets another surface
          // (the band near the border where the vote is close: about a quarter metre up close,
          // widening with distance so it never thins below about a pixel)
          if (layer < 0.5 && share < 1.0) {
            float rim = min(0.5 + 0.6 * max(0.25, 1.3 * length(fwidth(vWPos.xz))) / uGridInfo.y, 0.95);
            if (share < rim) g *= vec3(0.62, 0.72, 0.64);
          }
          // worn trail tread one step darker; slow, stepped tone drift so big areas aren't flat
          g *= cell.g > 0.5 ? 0.86 : 1.0;
          g *= 0.95 + 0.035 * floor(cell.b * 3.0);
          diffuseColor.rgb *= g;
        }`);
  };
  mat.customProgramCacheKey = () => 'pixel_terrain';
  return mat;
}

// Rocks: shared material, world-space box projection of the boulder tile.
let rockMat = null;
export function rockMaterial() {
  if (rockMat) return rockMat;
  rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  rockMat.name = 'pixel_rock';
  rockMat.userData.outlineId = OUTLINE_ID.ROCK;
  rockMat.onBeforeCompile = (shader) => {
    toonPatch(shader, rockMat);
    Object.assign(shader.uniforms, groundUniforms());
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\n${SAMPLE}`)
      .replace('#include <map_fragment>', /* glsl */ `
        {
          vec3 an = abs(vWNrm);
          vec2 p = an.y > max(an.x, an.z) ? vWPos.xz : an.x > an.z ? vWPos.zy : vWPos.xy;
          diffuseColor.rgb *= groundTex(p, ${LAYER_BOULDER.toFixed(1)});
        }`);
  };
  rockMat.customProgramCacheKey = () => 'pixel_rock';
  return rockMat;
}

// Prepare one convex rock geometry (already placed in world space): welded vertices with smooth
// normals, and a stepped vertical tone (sunlit crown, body, shaded base) as vertex colours.
export function shapeRockGeometry(g, ledge = false, seed = 0) {
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const m = mergeVertices(g, 1e-4);
  m.computeVertexNormals();
  m.computeBoundingBox();
  const { min, max } = m.boundingBox, h = Math.max(0.01, max.y - min.y);
  const p = m.attributes.position, nr = m.attributes.normal, cols = new Float32Array(p.count * 3);
  const tint = ledge ? 1.0 : 0.95 + ((seed * 0.618) % 1) * 0.1;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - min.y) / h, up = nr.getY(i);
    // crown: high and facing up; base: the bottom fifth (where it sits in the dirt)
    const k = (t > 0.55 && up > 0.45 ? 1.16 : t > 0.2 ? 1.0 : 0.74) * tint;
    cols[i * 3] = k; cols[i * 3 + 1] = k * 0.99; cols[i * 3 + 2] = k * 0.96;
  }
  m.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return m;
}

// Shading normals for the ground from a softened copy of the heightfield, written over the mesh's
// own normals. Toon bands then follow the shape of hills in calm, broad steps instead of
// flickering triangle by triangle over every bump. On and next to paths the softening is lighter
// (the tread's bumps still read); off them it is strong. Geometry is unchanged.
export function softenTerrainNormals(geo, { GRID, RES, SIZE, MAT }) {
  const N1 = RES + 1, cell = SIZE / RES;
  const near = blurField(GRID.vis, N1, 1, 2), far = blurField(GRID.vis, N1, 2, 4);
  const { dist } = visualSurface({ GRID, RES, SIZE, MAT });
  const at = (a, ix, iz) => a[Math.min(RES, Math.max(0, ix)) * N1 + Math.min(RES, Math.max(0, iz))];
  const pos = geo.attributes.position, nrm = geo.attributes.normal, v = new THREE.Vector3(), w = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const ix = Math.round((pos.getX(i) + SIZE / 2) / cell), iz = Math.round((pos.getZ(i) + SIZE / 2) / cell);
    const f = Math.min(1, Math.max(0, (at(dist, ix, iz) - 1) / 4));
    v.set(at(near, ix - 1, iz) - at(near, ix + 1, iz), 2 * cell, at(near, ix, iz - 1) - at(near, ix, iz + 1)).normalize();
    w.set(at(far, ix - 1, iz) - at(far, ix + 1, iz), 2 * cell, at(far, ix, iz - 1) - at(far, ix, iz + 1)).normalize();
    v.lerp(w, f).normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
  nrm.needsUpdate = true;
}
