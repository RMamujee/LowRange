// The bogs' visible surface: a fine mesh (0.2 m, one per 6.4 m tile of src/mud.js) laid over every
// mud area, following the deformable mud state: ruts pressed by the tyres, holes dug by spinning
// wheels, berms squeezed up beside them. Fresh ruts are dark and wet (a stepped sun glint on the
// wettest, standing water in dug holes) and dry back a little over a minute; untouched mud keeps a
// soft tonal variation. Lit by the toon bands like the rest of the world (the rut walls catch the
// light), with a faint 32 px/m world-space grain so it still reads as pixel-art ground.
//
// Under the bogs the terrain mesh drops to the firm floor (baseVertexHeight, used by
// world_view.buildTerrainMesh) so ruts can go as deep as the mud does; near the bog edge, where the
// mud thins out, the terrain mesh stays put and the mud surface never goes below it.
import * as THREE from 'three';
import { NODE, TILE } from '../mud.js';
import { toonPatch, OUTLINE_ID } from '../gfx/toon.js';
import { RAMP } from '../gfx/palette.js';
import { fbm } from '../maps/common.js';

const MUD = 3;
const lin = (hex) => new THREE.Color(hex);
const C_HI = lin(RAMP.mud[0]), C_BASE = lin(RAMP.mud[1]), C_SHADE = lin(RAMP.mud[2]), C_DEEP = lin(RAMP.mud[3]);
const C_POOL = lin(RAMP.mud[3]).lerp(lin(RAMP.water[3]), 0.18).multiplyScalar(0.8); // muddy water
const V = TILE + 1;          // vertices per tile side
const FRESH = 40;            // seconds a worked node stays wet-dark

// Terrain mesh height at grid vertex (ix, iz): interior bog vertices (mud all round) sit on the
// firm floor, everything else on the shown surface.
export function baseVertexHeight(GRID, N1, ix, iz) {
  const g = ix * N1 + iz;
  if (GRID.mat[g] !== MUD || ix < 1 || iz < 1 || ix >= N1 - 1 || iz >= N1 - 1) return GRID.vis[g];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (GRID.mat[(ix + a) * N1 + iz + b] !== MUD) return GRID.vis[g];
  return GRID.h[g] - 0.02;
}

export class MudView {
  constructor(scene, field) {
    this.field = field;
    this.tiles = [];
    const grid = field.grid, { GRID, SIZE, RES } = grid, N1 = RES + 1, CELL = SIZE / RES, half = SIZE / 2;
    // exact height of the terrain mesh (its triangles: PlaneGeometry splits each cell along the
    // (x, z+1)-(x+1, z) diagonal), so the mud surface can sit just above it at the bog edges
    const bv = (ix, iz) => baseVertexHeight(GRID, N1, Math.max(0, Math.min(RES, ix)), Math.max(0, Math.min(RES, iz)));
    this.baseAt = (x, z) => {
      const fx = (x + half) / CELL, fz = (z + half) / CELL, ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz;
      const A = bv(ix, iz), B = bv(ix, iz + 1), C = bv(ix + 1, iz + 1), D = bv(ix + 1, iz);
      return u + v <= 1 ? A + (D - A) * u + (B - A) * v : C + (B - C) * (1 - u) + (D - C) * (1 - v);
    };
    const s = {};
    // where the mud surface is drawn: past a wobbly threshold of mud share (an organic edge)
    this.surfaceAt = (x, z) => {
      field.sample(x, z, s);
      if (s.m < 0.5 + 0.15 * fbm(x * 0.9 + 5, z * 0.9 - 3, 2)) return null;
      return Math.max(grid.visualHeightAt(x, z) - s.r + s.berm, this.baseAt(x, z) + 0.015);
    };
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    this.mat.userData.outlineId = OUTLINE_ID.GROUND; // one surface with the ground: no line where they meet
    this.mat.onBeforeCompile = (sh) => {
      toonPatch(sh, this.mat);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float wet;\nvarying float vWet;\nvarying vec3 vMudW;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWet = wet;\nvMudW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vWet;\nvarying vec3 vMudW;\nfloat mudHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }')
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            // faint pixel grain on the 32 px/m lattice, in 2x2 clusters: ground texture, not noise
            vec2 px = floor(vMudW.xz * 32.0);
            float g = mudHash(floor(px * 0.5)) * 0.6 + mudHash(px) * 0.4;
            diffuseColor.rgb *= 0.95 + 0.08 * step(0.55, g) - 0.05 * step(g, 0.12);
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          #if NUM_DIR_LIGHTS > 0
          {
            // wet sheen: a stepped glint where the sun reflects off wet mud (toon lighting drops specular)
            // on scattered texels only (wet mud glints in specks, it is not a mirror)
            vec3 hv = normalize(directionalLights[0].direction + normalize(vViewPosition));
            float sp = pow(max(dot(normal, hv), 0.0), 40.0) * vWet;
            float speck = mudHash(floor(vMudW.xz * 16.0) + 7.0);
            totalEmissiveRadiance += vec3(0.09, 0.075, 0.05) * step(0.55, sp) * step(0.86, speck) + vec3(0.03, 0.025, 0.018) * step(0.3, sp);
          }
          #endif`);
    };
    this.mat.customProgramCacheKey = () => 'mud_surface';
    this.group = new THREE.Group(); this.group.name = 'mud-surface';
    // one index buffer per tile, only the cells that can show mud
    for (const t of field.tiles.values()) {
      const x0 = t.ti * TILE * NODE, z0 = t.tj * TILE * NODE;
      // static per vertex: shown height, mesh base height, mud share threshold, tone noise, baked tone
      const n = V * V, s0 = new Float32Array(n), base = new Float32Array(n), show = new Uint8Array(n), noise = new Float32Array(n), tone = new Float32Array(n);
      for (let a = 0; a < V; a++) for (let b = 0; b < V; b++) {
        const x = x0 + a * NODE, z = z0 + b * NODE, k = a * V + b;
        s0[k] = grid.visualHeightAt(x, z); base[k] = this.baseAt(x, z);
        show[k] = field.mudness(x, z) >= 0.5 + 0.15 * fbm(x * 0.9 + 5, z * 0.9 - 3, 2) ? 1 : 0;
        noise[k] = fbm(x * 0.55 + 31, z * 0.55 - 17, 3);
        const gx = Math.round((x + half) / CELL), gz = Math.round((z + half) / CELL);
        tone[k] = GRID.tone ? GRID.tone[Math.max(0, Math.min(RES, gx)) * N1 + Math.max(0, Math.min(RES, gz))] / 255 : 0;
      }
      const idx = [];
      for (let a = 0; a < TILE; a++) for (let b = 0; b < TILE; b++) {
        const k = a * V + b;
        if (!(show[k] || show[k + 1] || show[k + V] || show[k + V + 1])) continue;
        idx.push(k, k + 1, k + V, k + 1, k + V + 1, k + V);
      }
      if (!idx.length) continue;
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3), wet = new Float32Array(n);
      for (let a = 0; a < V; a++) for (let b = 0; b < V; b++) { const k = a * V + b; pos[k * 3] = x0 + a * NODE; pos[k * 3 + 2] = z0 + b * NODE; }
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('wet', new THREE.BufferAttribute(wet, 1).setUsage(THREE.DynamicDrawUsage));
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, this.mat);
      mesh.receiveShadow = true;
      const tile = { t, mesh, x0, z0, s0, base, show, noise, tone, ver: -1, lastT: -1e9, h: new Float32Array((V + 2) * (V + 2)) };
      this.tiles.push(tile);
      this.refresh(tile);
      geo.computeBoundingSphere();
      geo.boundingSphere.radius += 1;
      this.group.add(mesh);
    }
    scene.add(this.group);
    this.byKey = new Map(this.tiles.map((x) => [x.t.ti * 100003 + x.t.tj, x]));
    this.next = 0;
  }

  // rebuild one tile's heights, normals, colours and wetness from the mud state
  refresh(tile) {
    const f = this.field, clock = f.clock, { t, x0, z0, s0, base, show, noise, tone, h } = tile;
    const geo = tile.mesh.geometry, pos = geo.attributes.position.array, nrm = geo.attributes.normal.array, col = geo.attributes.color.array, wet = geo.attributes.wet.array;
    const W = V + 2, i0 = t.ti * TILE - 1, j0 = t.tj * TILE - 1;
    // heights with a one-node ring for the normals
    for (let a = 0; a < W; a++) for (let b = 0; b < W; b++) {
      const ni = f.node(i0 + a, j0 + b), nt = f.nt, ka = a - 1, kb = b - 1;
      const dz = ni >= 0 ? nt.r[ni] - nt.berm[ni] : 0;
      let y;
      if (ka >= 0 && kb >= 0 && ka < V && kb < V) {
        const k = ka * V + kb;
        y = show[k] ? Math.max(s0[k] - dz, base[k] + 0.015) : base[k] - 0.05;
      } else {
        const x = (i0 + a) * NODE, z = (j0 + b) * NODE;
        y = f.grid.visualHeightAt(x, z) - dz;
      }
      h[a * W + b] = y;
    }
    let lastT = -1e9;
    const c = this._c || (this._c = new THREE.Color());
    for (let a = 0; a < V; a++) for (let b = 0; b < V; b++) {
      const k = a * V + b, hk = (a + 1) * W + b + 1;
      pos[k * 3 + 1] = h[hk];
      // normal from central differences
      const nx = h[hk - W] - h[hk + W], nz = h[hk - 1] - h[hk + 1], ny = 2 * NODE, nl = Math.hypot(nx, ny, nz);
      nrm[k * 3] = nx / nl; nrm[k * 3 + 1] = ny / nl; nrm[k * 3 + 2] = nz / nl;
      const ni = f.node(t.ti * TILE + a, t.tj * TILE + b), nt = f.nt;
      const r = ni >= 0 ? nt.r[ni] : 0, e = ni >= 0 ? nt.e[ni] : 0, berm = ni >= 0 ? nt.berm[ni] : 0, wt = ni >= 0 ? nt.t[ni] : -1e9;
      if (wt > lastT) lastT = wt;
      const fresh = Math.max(0, 1 - (clock - wt) / FRESH);
      // untouched mud: base tone with broad lighter / darker areas and the baked churn darkening
      c.copy(C_BASE).lerp(noise[k] > 0 ? C_HI : C_SHADE, Math.min(1, Math.abs(noise[k]) * 1.3) * 0.5).lerp(C_SHADE, tone[k] * 0.45);
      let w = 0.3 + 0.2 * Math.max(0, -noise[k]);
      if (berm > 0.005) c.lerp(C_HI, Math.min(0.6, berm * 8)); // squeezed-up mud, a lighter lip
      if (r > 0.01) { // a rut: darker with depth, wet-dark while fresh
        const d = Math.min(1, r / 0.25);
        c.lerp(C_SHADE, 0.35 + 0.35 * d).lerp(C_DEEP, (0.25 + 0.4 * d) * (0.4 + 0.6 * fresh));
        w = Math.max(w, 0.45 + 0.55 * fresh);
      }
      if (e > 0.1) { c.lerp(C_POOL, Math.min(0.8, (e - 0.1) * 4) * (0.5 + 0.5 * fresh)); w = Math.max(w, 1.2 * Math.min(1, (e - 0.1) * 5)); } // water seeps into a dug hole
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      wet[k] = w;
    }
    tile.ver = t.ver; tile.lastT = lastT;
    for (const k of ['position', 'normal', 'color', 'wet']) geo.attributes[k].needsUpdate = true;
  }

  // per frame: tiles the tyres worked (and all 8 neighbours: they share edge nodes and the normals'
  // one-node ring), plus a slow
  // round of recently worked tiles so fresh ruts dry back; at most 6 tile rebuilds a frame (the
  // rest wait for the next one), so a truck churning across tile corners never spikes a frame
  update() {
    const t0 = performance.now();
    const f = this.field, pend = this._pend || (this._pend = new Set());
    for (const tile of this.tiles) {
      if (tile.ver === tile.t.ver || tile.queued === tile.t.ver) continue;
      tile.queued = tile.t.ver;
      pend.add(tile);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { if (!a && !b) continue; const nb = this.byKey.get((tile.t.ti + a) * 100003 + tile.t.tj + b); if (nb) pend.add(nb); }
    }
    if (this.tiles.length) {
      for (let k = 0; k < 2; k++) { // two tiles a frame, round robin
        const tile = this.tiles[this.next = (this.next + 1) % this.tiles.length];
        if (f.clock - tile.lastT < FRESH + 2) pend.add(tile);
      }
    }
    let n = 0;
    for (const tile of pend) { if (n++ >= 6) break; pend.delete(tile); this.refresh(tile); }
    this.cpu = (this.cpu || 0) + performance.now() - t0; this.cpuN = (this.cpuN || 0) + 1;
  }

  // tile / vertex counts and the average CPU time per frame spent in update (ms) since the last call
  stats() {
    const s = { tiles: this.tiles.length, verts: this.tiles.length * V * V, tris: this.tiles.reduce((a, t) => a + t.mesh.geometry.index.count / 3, 0), cpuMs: this.cpuN ? +(this.cpu / this.cpuN).toFixed(3) : 0 };
    this.cpu = 0; this.cpuN = 0;
    return s;
  }
}
