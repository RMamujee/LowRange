// Pixel-art ground and gameplay rocks.
//
// Ground: one material for the whole heightfield. The baked 1 m material grid (GRID.mat) and the
// trail-tread mask go to the GPU as a small data texture; each fragment looks up its surface
// material after jittering its position on a 1/8 m pixel lattice, so borders between surfaces are
// pixel-stepped and dithered rather than smoothly blended. The material picks a layer of the
// generated ground tiles (pixeltex.js), mapped in world space at 32 px/m. Where a texel would
// shrink below a screen pixel the texture fades to that material's flat average colour (its
// smallest mip), so distant ground stays calm instead of crawling.
//
// Rocks: keep their exact convex-hull geometry; get the rock tile box-projected in world space
// (dominant axis, no blending), smoothed normals so the toon bands round them off, and vertex
// shading that lightens tops and darkens bases.
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { groundTextureArray, GROUND_GLSL as SAMPLE } from './pixeltex.js';
import { toonPatch, OUTLINE_ID } from './toon.js';

export function terrainMaterial({ GRID, RES, SIZE, NROADS, MAT }) {
  const N1 = RES + 1;
  // per grid vertex: R = material, G = trail tread, B = gentle large-scale tone variation
  const data = new Uint8Array(N1 * N1 * 4);
  for (let ix = 0; ix < N1; ix++) for (let iz = 0; iz < N1; iz++) {
    const g = ix * N1 + iz, o = (ix * N1 + iz) * 4, m = GRID.mat[g];
    data[o] = m;
    data[o + 1] = GRID.path[g] >= NROADS && m !== MAT.MUD ? 255 : 0;
    const n = Math.sin(ix * 0.071 + Math.sin(iz * 0.05) * 2.1) * Math.sin(iz * 0.063 + Math.sin(ix * 0.045) * 1.7);
    data[o + 2] = Math.round((n * 0.5 + 0.5) * 255);
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
    shader.uniforms.uGround = { value: groundTextureArray() };
    shader.uniforms.uGrid = { value: grid };
    shader.uniforms.uGridInfo = { value: new THREE.Vector3(SIZE / 2, SIZE / RES, RES) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = mat3(modelMatrix) * objectNormal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\nuniform highp sampler2D uGrid;\nuniform vec3 uGridInfo;\n${SAMPLE}`)
      .replace('#include <map_fragment>', /* glsl */ `
        {
          // pixel-stepped material lookup: the position is snapped to a 1/16 m (2 texel) lattice and
          // pushed by a wobbly noise plus a little per-step grain, then takes the nearest grid vertex,
          // so borders between surfaces are organic, ragged, pixel-stepped lines
          vec2 lat = floor(vWPos.xz * 16.0) / 16.0;
          vec2 j = (vec2(pxNoise(lat * 0.9), pxNoise(lat * 0.9 + 17.3)) - 0.5) * 1.3
                 + (vec2(pxHash(lat * 16.0), pxHash(lat * 16.0 + 31.7)) - 0.5) * 0.35;
          vec2 gp = (vWPos.xz + uGridInfo.x) / uGridInfo.y + j;
          ivec2 gi = clamp(ivec2(floor(gp + 0.5)), ivec2(0), ivec2(int(uGridInfo.z)));
          vec4 cell = texelFetch(uGrid, ivec2(gi.y, gi.x), 0); // row = ix, column = iz
          float layer = floor(cell.r * 255.0 + 0.5);
          // steep faces take the tile from the side (dominant axis, no blend) instead of stretching it
          vec3 an = abs(vWNrm);
          vec2 tp = an.y > max(an.x, an.z) * 0.9 ? vWPos.xz : an.x > an.z ? vWPos.zy : vWPos.xy;
          vec3 g = groundTex(tp, layer);
          // worn trail tread one step darker; slow, stepped tone drift so big areas aren't flat
          g *= cell.g > 0.5 ? 0.84 : 1.0;
          g *= 0.94 + 0.04 * floor(cell.b * 3.0);
          diffuseColor.rgb *= g;
        }`);
  };
  mat.customProgramCacheKey = () => 'pixel_terrain';
  return mat;
}

// Rocks: shared material, world-space box projection of the rock tile.
let rockMat = null;
export function rockMaterial() {
  if (rockMat) return rockMat;
  rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  rockMat.name = 'pixel_rock';
  rockMat.userData.outlineId = OUTLINE_ID.ROCK;
  rockMat.onBeforeCompile = (shader) => {
    toonPatch(shader, rockMat);
    shader.uniforms.uGround = { value: groundTextureArray() };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\n${SAMPLE}`)
      .replace('#include <map_fragment>', /* glsl */ `
        {
          vec3 an = abs(vWNrm);
          vec2 p = an.y > max(an.x, an.z) ? vWPos.xz : an.x > an.z ? vWPos.zy : vWPos.xy;
          diffuseColor.rgb *= groundTex(p, 2.0);
        }`);
  };
  rockMat.customProgramCacheKey = () => 'pixel_rock';
  return rockMat;
}

// Prepare one convex rock geometry (already placed in world space): welded vertices with smooth
// normals, and a stepped vertical tone (lit crown, darker base) as vertex colours.
export function shapeRockGeometry(g, ledge = false, seed = 0) {
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const m = mergeVertices(g, 1e-4);
  m.computeVertexNormals();
  m.computeBoundingBox();
  const { min, max } = m.boundingBox, h = Math.max(0.01, max.y - min.y);
  const p = m.attributes.position, cols = new Float32Array(p.count * 3);
  const tint = ledge ? 1.0 : 0.94 + ((seed * 0.618) % 1) * 0.12;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - min.y) / h;
    const k = (t > 0.6 ? 1.14 : t > 0.25 ? 0.98 : 0.76) * tint;
    cols[i * 3] = k; cols[i * 3 + 1] = k; cols[i * 3 + 2] = k * 0.98;
  }
  m.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return m;
}

// Shading normals for the ground from a softened copy of the heightfield (box blur, `passes`
// cells), written over the mesh's own normals. Toon bands then follow the shape of hills in calm,
// broad steps instead of flickering triangle by triangle over every bump. Geometry is unchanged.
export function softenTerrainNormals(geo, { GRID, RES, SIZE }, passes = 2) {
  const N1 = RES + 1, cell = SIZE / RES;
  let h = Float32Array.from(GRID.vis), t = new Float32Array(h.length);
  const at = (a, ix, iz) => a[Math.min(RES, Math.max(0, ix)) * N1 + Math.min(RES, Math.max(0, iz))];
  for (let p = 0; p < passes; p++) {
    for (let ix = 0; ix < N1; ix++) for (let iz = 0; iz < N1; iz++) {
      let s = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) s += at(h, ix + dx, iz + dz);
      t[ix * N1 + iz] = s / 9;
    }
    [h, t] = [t, h];
  }
  const pos = geo.attributes.position, nrm = geo.attributes.normal, v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const ix = Math.round((pos.getX(i) + SIZE / 2) / cell), iz = Math.round((pos.getZ(i) + SIZE / 2) / cell);
    v.set(at(h, ix - 1, iz) - at(h, ix + 1, iz), 2 * cell, at(h, ix, iz - 1) - at(h, ix, iz + 1)).normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
  nrm.needsUpdate = true;
}
