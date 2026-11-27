// Tyre marks in sand (Sunfall Basin): each wheel rolling on sand lays a darker strip on the
// ground behind it. One ring buffer of quads in a single mesh (one draw call): a segment is
// added every ~0.5 m a wheel travels, the oldest are overwritten, and every 2 s the alphas are
// refreshed so marks fade with age; only the changed range of the buffers is uploaded. Visual only
// (the physics doesn't see them); drawn without outlines, just above the ground. Separate from
// the dust / mud effects (src/fx/), which mark nothing on the ground. clear() on a fresh attempt.
import * as THREE from 'three';
import { MAT, visualHeightAt } from '../terrain.js';
import { noOutline } from '../gfx/pipeline.js';

const N = 2400;        // quads in the ring (about 300 m of marks per wheel)
const STEP = 0.5;      // metres of travel per segment
const LIFE = 240;      // seconds for a mark to fade out

export class SandMarks {
  constructor(scene) {
    this.pos = new Float32Array(N * 4 * 3);
    this.col = new Float32Array(N * 4 * 4);
    this.born = new Float32Array(N).fill(-1e9);
    const idx = new Uint32Array(N * 6);
    for (let i = 0; i < N; i++) idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3], i * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    // lit like the ground (toon bands), a dark, slightly reddened sand tone at low opacity
    const m = new THREE.MeshStandardMaterial({ color: 0x6e4630, vertexColors: true, transparent: true, depthWrite: false, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    m.userData.world = true;
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false; this.mesh.receiveShadow = true; this.mesh.name = 'sand-marks';
    noOutline(this.mesh);
    scene.add(this.mesh);
    this.next = 0; this.t = 0; this.fadeT = 0;
    this.last = [null, null, null, null];
    this.dirty = false;  // new quads this frame: [lo, hi] (quad indices) are uploaded, nothing else
    this.lo = N; this.hi = -1; this.allColour = false; // allColour: the age fade touched every alpha
  }
  clear() { this.col.fill(0); this.born.fill(-1e9); this.last = [null, null, null, null]; this.allColour = true; }
  update(car, dt) {
    this.t += dt;
    if (!car) return;
    const w = car.spec.tire.width * 0.85;
    for (let i = 0; i < 4; i++) {
      const ws = car.wheelState[i], p = car.wheels[i].translation();
      if (!ws.grounded || ws.mat !== MAT.SAND) { this.last[i] = null; continue; }
      const L = this.last[i];
      if (!L) { this.last[i] = { x: p.x, z: p.z }; continue; }
      const dx = p.x - L.x, dz = p.z - L.z, d = Math.hypot(dx, dz);
      if (d < STEP) continue;
      if (d > 3) { this.last[i] = { x: p.x, z: p.z }; continue; } // teleport or airborne jump: no streak
      // a segment from the last point to here, `w` wide; deeper (darker) with wheelspin
      const nx = -dz / d * w / 2, nz = dx / d * w / 2, k = this.next;
      const a = 0.32 + Math.min(0.2, (ws.slip || 0) * 0.05);
      const quad = [[L.x + nx, L.z + nz], [L.x - nx, L.z - nz], [p.x + nx, p.z + nz], [p.x - nx, p.z - nz]];
      quad.forEach(([x, z], j) => {
        const o = (k * 4 + j) * 3;
        this.pos[o] = x; this.pos[o + 1] = visualHeightAt(x, z) + 0.035; this.pos[o + 2] = z;
        const c = (k * 4 + j) * 4; this.col[c] = 1; this.col[c + 1] = 1; this.col[c + 2] = 1; this.col[c + 3] = a;
      });
      this.born[k] = this.t; this.next = (k + 1) % N; this.last[i] = { x: p.x, z: p.z };
      this.dirty = true; this.lo = Math.min(this.lo, k); this.hi = Math.max(this.hi, k);
    }
    this.fadeT += dt;
    if (this.fadeT > 2) { // age fade (every 2 s: a 4 min fade needs no more), only if anything changed
      this.fadeT = 0;
      for (let k = 0; k < N; k++) {
        const age = this.t - this.born[k];
        if (age > LIFE * 1.2) continue;
        const f = Math.max(0, 1 - age / LIFE);
        for (let j = 0; j < 4; j++) { const c = (k * 4 + j) * 4 + 3; if (this.col[c] > 0.45 * f) { this.col[c] = 0.45 * f; this.allColour = true; } }
      }
    }
    // upload only what changed: the new quads' range (positions and colours), all colours after a fade
    const pa = this.mesh.geometry.attributes.position, ca = this.mesh.geometry.attributes.color;
    if (this.dirty) {
      pa.clearUpdateRanges(); pa.addUpdateRange(this.lo * 12, (this.hi - this.lo + 1) * 12); pa.needsUpdate = true;
      if (!this.allColour) { ca.clearUpdateRanges(); ca.addUpdateRange(this.lo * 16, (this.hi - this.lo + 1) * 16); ca.needsUpdate = true; }
    }
    if (this.allColour) { ca.clearUpdateRanges(); ca.needsUpdate = true; }
    this.dirty = false; this.allColour = false; this.lo = N; this.hi = -1;
  }
}
