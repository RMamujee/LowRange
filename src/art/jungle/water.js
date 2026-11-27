// Water for Coralume Island: the sea round the island, the creek, its plunge pool and Ember Falls.
// Stylised in the game's look: flat stepped colours (turquoise over sand, deeper blue off the
// shelf), a pixel-stepped foam band where the water meets the beach, slow drifting glints on a
// fixed world lattice (no smooth gradients, nothing that crawls), and white water on the falls.
// Water is transparent and kept off the outline layer (gfx/pipeline.js noOutline).
import * as THREE from 'three';
import { SIZE, heightAt, MAP } from '../../terrain.js';

const SHALLOW = new THREE.Color(0x6fd0c8), MID = new THREE.Color(0x3fa8b8), DEEP = new THREE.Color(0x2a6f9a), FOAM = new THREE.Color(0xf4f6ee);
export const WATER_TIME = { value: 0 };

// a transparent standard material (so the toon pass, fog and the sun light it like everything
// else) with stepped depth colour, foam and glints written in before lighting
function waterMaterial({ opacity = 0.82, rapids = false } = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity, roughness: 0.6, metalness: 0, depthWrite: false });
  m.userData.world = true;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = WATER_TIME;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nuniform float uTime;
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // glints: short dashes on a 1/4 m lattice that drift slowly with the swell
          vec2 L = floor(vWPos.xz * 4.0 + vec2(uTime * ${rapids ? '6.0' : '0.6'}, uTime * ${rapids ? '0.0' : '0.25'}));
          float g = wHash(floor(L / vec2(3.0, 1.0)));
          float swell = sin(vWPos.x * 0.21 + vWPos.z * 0.13 + uTime * 0.9) * 0.5 + 0.5;
          if (g > ${rapids ? '0.72' : '0.965'} - swell * 0.02) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.98, 0.97), ${rapids ? '0.7' : '0.55'});
        }`);
  };
  m.customProgramCacheKey = () => 'jungle_water' + (rapids ? '_r' : '');
  return m;
}

// The sea: a grid over the map (2 m near the island, coloured from the depth of the seabed under it,
// with foam where it is only a few centimetres deep) inside a far ring out to the horizon.
export function buildSea() {
  const g = new THREE.Group(); g.name = 'sea';
  const depthAt = (x, z) => -heightAt(x, z);
  const colour = (d, c) => {
    if (d < 0.12) return c.copy(FOAM);
    if (d < 0.5) return c.copy(SHALLOW).lerp(FOAM, 0.25);
    if (d < 1.6) return c.copy(SHALLOW);
    if (d < 4) return c.copy(MID);
    return c.copy(DEEP);
  };
  // inner grid, adaptive: 16 m quads over deep water, 4 m over the shelf, 2 m along the shore
  // (where the foam band is); cells that are dry at every corner are left out
  const pos = [], col = [], c = new THREE.Color();
  // alpha by depth: clear over the sand, opaque out to sea (beyond the map there is no seabed to show)
  const alpha = (d) => (d < 0.12 ? 0.85 : d < 0.5 ? 0.5 : d < 1.6 ? 0.62 : d < 4 ? 0.82 : 1);
  const vtx = (x, z) => { const d = depthAt(x, z); pos.push(x, MAP.SEA.y, z); colour(d, c); col.push(c.r, c.g, c.b, alpha(d)); };
  const quad = (x0, z0, S) => { const x1 = x0 + S, z1 = z0 + S; vtx(x0, z0); vtx(x0, z1); vtx(x1, z0); vtx(x1, z0); vtx(x0, z1); vtx(x1, z1); };
  const cell = (x0, z0, S) => {
    const ds = [depthAt(x0, z0), depthAt(x0 + S, z0), depthAt(x0, z0 + S), depthAt(x0 + S, z0 + S), depthAt(x0 + S / 2, z0 + S / 2)];
    const lo = Math.min(...ds), hi = Math.max(...ds);
    if (hi < -0.05 && S <= 4) return;                        // dry land
    if (S === 16 && lo > 4) return quad(x0, z0, S);          // deep and uniform
    if (S === 4 && (lo > 1.6 || hi < -0.3)) return hi < -0.3 ? undefined : quad(x0, z0, S);
    if (S === 2) return quad(x0, z0, S);
    const h = S / (S === 16 ? 4 : 2);
    for (let i = 0; i < S / h; i++) for (let j = 0; j < S / h; j++) cell(x0 + i * h, z0 + j * h, h);
  };
  for (let x = -SIZE / 2; x < SIZE / 2; x += 16) for (let z = -SIZE / 2; z < SIZE / 2; z += 16) cell(x, z, 16);
  // outer ring: the same water surface, continued from the map's edge to the horizon (same height,
  // colour and alpha as the deep water it meets, in the same mesh: no seam). Under it an opaque floor,
  // well below the deepest sea bed, so the pipeline sky (it fills every pixel left at the far depth)
  // can't show through where there is no ground under the water.
  const floor = [];
  const ringQuads = (R0, R1, y, out, colour) => {
    const SEG = 64;
    for (let k = 0; k < SEG; k++) {
      const a0 = (k / SEG) * Math.PI * 2, a1 = ((k + 1) / SEG) * Math.PI * 2;
      // a square hole the size of the map, so the ring meets the inner grid (64 segments: every
      // eighth lands on a corner, so no chord cuts across one)
      const sq = (a) => { const cx = Math.cos(a), cz = Math.sin(a), m = Math.max(Math.abs(cx), Math.abs(cz)); return [cx / m * R0, cz / m * R0]; };
      const [ax, az] = sq(a0), [bx, bz] = sq(a1);
      const ox = Math.cos(a0) * R1, oz = Math.sin(a0) * R1, px = Math.cos(a1) * R1, pz = Math.sin(a1) * R1;
      for (const [x, z] of [[ax, az], [bx, bz], [ox, oz], [bx, bz], [px, pz], [ox, oz]]) { out.push(x, y, z); if (colour) colour.push(DEEP.r, DEEP.g, DEEP.b, 1); }
    }
  };
  ringQuads(SIZE / 2, 4000, MAP.SEA.y, pos, col);
  ringQuads(SIZE / 2 - 2, 4000, -16, floor, null);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, waterMaterial({ opacity: 1 }));
  mesh.frustumCulled = false; mesh.renderOrder = 1;
  g.add(mesh);
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(floor, 3));
  fg.computeVertexNormals();
  const fm = new THREE.MeshStandardMaterial({ color: DEEP, roughness: 1 }); fm.userData.outlineId = 1;
  const under = new THREE.Mesh(fg, fm); under.frustumCulled = false;
  g.add(under);
  return g;
}

// The creek: a ribbon at the channel's water level, a disc for the pool, a sheet of white water for
// the falls with a little spray at its foot
export function buildCreek() {
  const g = new THREE.Group(); g.name = 'creek';
  const R = MAP.RIVER, P = R.pts, half = R.chanW + 1.2;
  const pos = [], col = [];
  const blue = new THREE.Color(0x58b8c0), white = new THREE.Color(0xdff0ec), c = new THREE.Color();
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i];
    if (a.s > R.fallsS - 1 && a.s < R.fallsS + 3) continue; // the falls are their own sheet
    const tx = b.x - a.x, tz = b.z - a.z, L = Math.hypot(tx, tz) || 1, nx = -tz / L, nz = tx / L;
    const steep = Math.abs(b.w - a.w) / L;
    c.copy(blue).lerp(white, Math.min(0.8, steep * 4)); // white water on the steep runs
    const quad = [[a, -1], [a, 1], [b, -1], [b, -1], [a, 1], [b, 1]];
    for (const [p, sd] of quad) { pos.push(p.x + nx * half * sd, p.w + 0.02, p.z + nz * half * sd); col.push(c.r, c.g, c.b); }
  }
  // the pool
  const PL = MAP.POOL, SEG = 20;
  for (let k = 0; k < SEG; k++) {
    const a0 = (k / SEG) * Math.PI * 2, a1 = ((k + 1) / SEG) * Math.PI * 2;
    for (const [x, z] of [[PL.x, PL.z], [PL.x + Math.cos(a0) * PL.r, PL.z + Math.sin(a0) * PL.r], [PL.x + Math.cos(a1) * PL.r, PL.z + Math.sin(a1) * PL.r]]) { pos.push(x, PL.w + 0.03, z); col.push(blue.r, blue.g, blue.b); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const ribbon = new THREE.Mesh(geo, waterMaterial({ opacity: 0.85, rapids: false }));
  ribbon.renderOrder = 1;
  g.add(ribbon);
  // Ember Falls: a curtain from the lip down to the pool, white water streaming down it
  const F = R.falls, w = 4.2, top = F.top - R.chanD + R.depth + 0.05, bot = PL.w;
  const fg = new THREE.PlaneGeometry(w, top - bot, 2, 6);
  const fc = [];
  for (let i = 0; i < fg.attributes.position.count; i++) { c.copy(white).lerp(blue, (i % 3) * 0.12); fc.push(c.r, c.g, c.b); }
  fg.setAttribute('color', new THREE.Float32BufferAttribute(fc, 3));
  const falls = new THREE.Mesh(fg, waterMaterial({ opacity: 0.9, rapids: true }));
  falls.position.set(F.x + F.tx * 1.2, (top + bot) / 2, F.z + F.tz * 1.2);
  falls.rotation.y = Math.atan2(F.tx, F.tz);
  falls.renderOrder = 1;
  g.add(falls);
  g.userData.fallsFoot = { x: F.x + F.tx * 2, y: bot, z: F.z + F.tz * 2 };
  return g;
}
