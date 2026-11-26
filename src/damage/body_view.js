// Crash damage on the vehicle's visual body: samples the crash model's deformation cage
// (src/damage/lattice.js) into every body mesh, cracks and drops glass, breaks lamps and builds
// the torn-off parts as separate meshes that follow their rigid bodies.
//
// Works on the glTF Body (one mesh per material: paint, glass, trim, lamps, cargo, spare) and on
// the procedural fallback bodies. Vertices move by the cage's smooth trilinear field, so every
// copy of a vertex along a hard edge or UV seam moves identically and the mesh stays closed.
// Normals are not recomputed from scratch (that would change the models' authored smooth/flat
// shading): each triangle's authored normals are rotated by however much that triangle turned.
// All of it runs only when the cage changed (impact frames); a quiet frame costs one compare.
import * as THREE from 'three';
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const TESS = new TessellateModifier(0.3, 4);
const kindOf = (mat) => {
  const n = (mat && mat.name) || '';
  if (/glass/i.test(n)) return 'glass';
  if (/lamp|light/i.test(n)) return 'lamp';
  return 'panel';
};
// glass breaks on distortion (shear of the pane), not on rigid motion of the whole region
const GLASS_CRACK = 0.012, GLASS_GONE = 0.045, GLASS_CRACK_ABS = 0.07, GLASS_GONE_ABS = 0.2;
const LAMP_BREAK = 0.015, LAMP_BREAK_ABS = 0.08;

// island id per vertex (connected triangles, vertices welded by position)
function islands(geo) {
  const pos = geo.attributes.position, idx = geo.index, n = pos.count;
  const weld = new Map(), wid = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    let w = weld.get(k); if (w === undefined) { w = weld.size; weld.set(k, w); }
    wid[i] = w;
  }
  const par = Int32Array.from({ length: weld.size }, (_, i) => i);
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  const tc = idx ? idx.count : n;
  for (let t = 0; t < tc; t += 3) {
    const a = find(wid[idx ? idx.getX(t) : t]);
    for (let k = 1; k < 3; k++) { const b = find(wid[idx ? idx.getX(t + k) : t + k]); if (a !== b) par[b] = a; }
  }
  const remap = new Map(), out = new Int32Array(n);
  for (let i = 0; i < n; i++) { const r = find(wid[i]); let id = remap.get(r); if (id === undefined) { id = remap.size; remap.set(r, id); } out[i] = id; }
  return { id: out, count: remap.size };
}

// reorder a non-indexed geometry's triangles so each island is contiguous; one draw group each
function groupByIsland(geo, isl) {
  const n = geo.attributes.position.count, tris = n / 3;
  const order = Array.from({ length: tris }, (_, t) => t).sort((a, b) => isl.id[a * 3] - isl.id[b * 3]);
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name], s = a.itemSize, src = a.array.slice(), dst = a.array;
    order.forEach((t, k) => { for (let j = 0; j < 3 * s; j++) dst[k * 3 * s + j] = src[t * 3 * s + j]; });
    a.needsUpdate = true;
  }
  const ids = new Int32Array(n);
  order.forEach((t, k) => { for (let j = 0; j < 3; j++) ids[k * 3 + j] = isl.id[t * 3 + j]; });
  geo.clearGroups();
  const groups = [];
  let start = 0;
  for (let v = 3; v <= n; v += 3) {
    if (v === n || ids[v] !== ids[start]) { geo.addGroup(start, v - start, 0); groups.push({ start, count: v - start, island: ids[start] }); start = v; }
  }
  return { id: ids, count: isl.count, groups };
}

export class BodyDamage {
  constructor(view, vehicle) {
    this.view = view; this.v = vehicle;
    this.cage = vehicle.crash.lattice;
    this.layout = vehicle.crash.layout;
    this.version = -1;
    this.ownMats = [];
    this.meshes = [];
    this.debris = [];   // { part, group, body }
    const body = view.body;
    body.updateMatrix();
    const parts = vehicle.crash.parts;
    body.traverse((o) => {
      if (!o.isMesh || !o.geometry.attributes.position) return;
      // hidden procedural pieces under a glTF body: skip (nothing to see, nothing to pay for)
      for (let p = o; p && p !== body; p = p.parent) if (!p.visible) return;
      o.updateMatrix();
      const m = o.matrix.clone();
      for (let p = o.parent; p && p !== body; p = p.parent) { p.updateMatrix(); m.premultiply(p.matrix); }
      const kind = kindOf(Array.isArray(o.material) ? o.material[0] : o.material);
      let geo = o.geometry;
      if (o.userData.dentable && kind !== 'lamp') {
        // glTF panels: split long edges so the cage has vertices to bend (0.3 m max)
        let longest = 0;
        const pos = geo.attributes.position, idx = geo.index, tc = idx ? idx.count : pos.count;
        for (let t = 0; t < tc && longest <= 0.3; t += 3) for (let k = 0; k < 3; k++) {
          const a = idx ? idx.getX(t + k) : t + k, b = idx ? idx.getX(t + (k + 1) % 3) : t + (k + 1) % 3;
          longest = Math.max(longest, Math.hypot(pos.getX(a) - pos.getX(b), pos.getY(a) - pos.getY(b), pos.getZ(a) - pos.getZ(b)));
        }
        // (re-indexed afterwards: tessellation leaves three copies of every vertex)
        if (longest > 0.3) { const g2 = mergeVertices(TESS.modify(geo), 1e-5); geo.dispose(); geo = g2; }
      }
      if (kind !== 'panel' && geo.index) { const g2 = geo.toNonIndexed(); geo.dispose(); geo = g2; }
      if (!geo.attributes.normal) geo.computeVertexNormals();
      o.geometry = geo;
      const rec = { mesh: o, kind, toBody: m, invLin: new THREE.Matrix3().setFromMatrix4(m.clone().invert()) };
      const pos = geo.attributes.position, n = pos.count;
      if (pos.usage !== THREE.DynamicDrawUsage) pos.setUsage(THREE.DynamicDrawUsage);
      let isl = islands(geo);
      if (kind !== 'panel') {
        isl = groupByIsland(geo, isl);
        const base = Array.isArray(o.material) ? o.material[0] : o.material;
        const alt = base.clone();
        if (kind === 'glass') { // crazed safety glass: pale and milky
          alt.color = base.color.clone().lerp(new THREE.Color(0xdfe8ee), 0.5);
          if (alt.emissive) { alt.emissive = new THREE.Color(0x3c4650); alt.emissiveIntensity = 1; }
          alt.name = base.name + '_cracked';
        } else { // broken lamp: dark, no glow
          alt.color = base.color.clone().multiplyScalar(0.35);
          if (alt.emissive) { alt.emissive = new THREE.Color(0); alt.emissiveIntensity = 0; }
          alt.name = (base.name || 'lamp') + '_broken';
        }
        this.ownMats.push(alt);
        o.material = [base, alt];
        rec.panes = isl.groups.map((g) => ({ ...g, state: 0 }));
      }
      rec.island = isl.id;
      rec.base = pos.array.slice();
      rec.baseNormal = geo.attributes.normal.array.slice();
      rec.bodyPos = new Float32Array(n * 3);
      const tv = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        tv.set(rec.base[i * 3], rec.base[i * 3 + 1], rec.base[i * 3 + 2]).applyMatrix4(m);
        rec.bodyPos[i * 3] = tv.x; rec.bodyPos[i * 3 + 1] = tv.y; rec.bodyPos[i * 3 + 2] = tv.z;
      }
      rec.disp = new Float32Array(n * 3); // body-space displacement of the last update
      // each vertex's cage cell and trilinear weights never change: precompute them
      const cage = this.cage;
      rec.cell = new Int32Array(n); rec.fw = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const fx = Math.min(cage.nx - 1.0001, Math.max(0, (rec.bodyPos[i * 3] - cage.min.x) / cage.sx));
        const fy = Math.min(cage.ny - 1.0001, Math.max(0, (rec.bodyPos[i * 3 + 1] - cage.min.y) / cage.sy));
        const fz = Math.min(cage.nz - 1.0001, Math.max(0, (rec.bodyPos[i * 3 + 2] - cage.min.z) / cage.sz));
        rec.cell[i] = cage.id(fx | 0, fy | 0, fz | 0);
        rec.fw[i * 3] = fx - (fx | 0); rec.fw[i * 3 + 1] = fy - (fy | 0); rec.fw[i * 3 + 2] = fz - (fz | 0);
      }
      rec.hidden = new Uint8Array(n);
      // which detachable part each vertex belongs to (whole islands inside a part's box)
      rec.part = new Int8Array(n).fill(-1);
      if (parts.length) {
        const bb = [];
        for (let i = 0; i < n; i++) {
          const k = rec.island[i];
          let b = bb[k]; if (!b) bb[k] = b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
          for (let a = 0; a < 3; a++) { const c = rec.bodyPos[i * 3 + a]; if (c < b[a]) b[a] = c; if (c > b[a + 3]) b[a + 3] = c; }
        }
        const owner = bb.map((b) => parts.findIndex((p) => b[0] >= p.lo[0] && b[1] >= p.lo[1] && b[2] >= p.lo[2] && b[3] <= p.hi[0] && b[4] <= p.hi[1] && b[5] <= p.hi[2]));
        for (let i = 0; i < n; i++) rec.part[i] = owner[rec.island[i]];
      }
      this.meshes.push(rec);
    });
    this.tmp = { x: 0, y: 0, z: 0 };
    this.collapse = new THREE.Vector3();
    this.zoneStats = null;
    this.full = true;
  }

  // Re-deform when the cage changed; spawn meshes for parts that tore off; move debris.
  update() {
    const crash = this.v.crash;
    if (this.debris.length < crash.debris.length || this.debris.some((d, i) => d.src !== crash.debris[i])) this.syncDebris();
    for (const d of this.debris) {
      if (!d.src.body) { d.group.visible = false; continue; }
      const p = d.src.body.translation(), q = d.src.body.rotation();
      d.group.position.set(p.x, p.y, p.z); d.group.quaternion.set(q.x, q.y, q.z, q.w);
    }
    if (this.cage.version === this.version) return false;
    this.version = this.cage.version;
    this.deform();
    return true;
  }

  deform() {
    const cage = this.cage, s = this.tmp, crash = this.v.crash;
    const detached = crash.parts.map((p) => p.detached);
    const zones = this.zoneStats = { front: Z(), rear: Z(), roof: Z(), left: Z(), right: Z() };
    const L = this.layout, [cw] = this.v.spec.chassis.size;
    let maxAll = 0;
    // only vertices whose cage cell touches the changed nodes need sampling again
    const dirty = cage.takeDirty();
    const full = this.full || !dirty;
    this.full = false;
    const x0 = full ? -1e9 : cage.min.x + (dirty.i0 - 1) * cage.sx, x1 = full ? 1e9 : cage.min.x + (dirty.i1 + 1) * cage.sx;
    const y0 = full ? -1e9 : cage.min.y + (dirty.j0 - 1) * cage.sy, y1 = full ? 1e9 : cage.min.y + (dirty.j1 + 1) * cage.sy;
    const z0 = full ? -1e9 : cage.min.z + (dirty.k0 - 1) * cage.sz, z1 = full ? 1e9 : cage.min.z + (dirty.k1 + 1) * cage.sz;
    const cd = cage.disp, nx = cage.nx, nxy = cage.nx * cage.ny;
    for (const r of this.meshes) {
      const pos = r.mesh.geometry.attributes.position, arr = pos.array, n = pos.count;
      const bp = r.bodyPos, d = r.disp, il = r.invLin.elements;
      let any = full;
      for (let i = 0; i < n; i++) {
        const i3 = i * 3, x = bp[i3], y = bp[i3 + 1], z = bp[i3 + 2];
        if (r.part[i] >= 0 && detached[r.part[i]] && !r.hidden[i]) { r.hidden[i] = 1; any = true; }
        if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1) continue;
        // trilinear blend of the cell's 8 nodes (cage.sample with precomputed cell / weights)
        const b = r.cell[i], u = r.fw[i3], v = r.fw[i3 + 1], w = r.fw[i3 + 2];
        let ox = 0, oy = 0, oz = 0;
        for (let c = 0; c < 8; c++) {
          const di = c & 1, dj = (c >> 1) & 1, dk = c >> 2;
          const wt = (di ? u : 1 - u) * (dj ? v : 1 - v) * (dk ? w : 1 - w);
          const q = (b + di + dj * nx + dk * nxy) * 3;
          ox += cd[q] * wt; oy += cd[q + 1] * wt; oz += cd[q + 2] * wt;
        }
        d[i3] = ox; d[i3 + 1] = oy; d[i3 + 2] = oz;
        any = true;
      }
      if (!any) { // untouched mesh: just its stats
        if (r.kind === 'panel') for (let i = 0; i < n; i++) if (!r.hidden[i]) {
          const i3 = i * 3, m = Math.hypot(d[i3], d[i3 + 1], d[i3 + 2]);
          if (m > maxAll) maxAll = m;
          const bx = bp[i3], by = bp[i3 + 1], bz = bp[i3 + 2];
          const zn = bz < L.cab[0] ? zones.front : bz > L.cab[1] ? zones.rear : by > L.belt ? zones.roof : bx < -cw / 4 ? zones.left : bx > cw / 4 ? zones.right : null;
          if (zn) { zn.max = Math.max(zn.max, m); zn.sum += m; zn.n++; }
        }
        continue;
      }
      // glass / lamps: judge each pane by how much it was bent (not moved)
      if (r.panes) for (const pn of r.panes) {
        if (pn.state === 2) continue;
        let mx = 0, my = 0, mz = 0, amax = 0;
        const v0 = pn.start, v1 = pn.start + pn.count;
        for (let i = v0; i < v1; i++) { mx += d[i * 3]; my += d[i * 3 + 1]; mz += d[i * 3 + 2]; }
        mx /= pn.count; my /= pn.count; mz /= pn.count;
        let dist = 0;
        for (let i = v0; i < v1; i++) {
          dist = Math.max(dist, Math.hypot(d[i * 3] - mx, d[i * 3 + 1] - my, d[i * 3 + 2] - mz));
          amax = Math.max(amax, Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]));
        }
        let st = pn.state;
        if (r.kind === 'glass') {
          if (dist > GLASS_GONE || amax > GLASS_GONE_ABS) st = 2;
          else if (dist > GLASS_CRACK || amax > GLASS_CRACK_ABS) st = Math.max(st, 1);
        } else if (dist > LAMP_BREAK || amax > LAMP_BREAK_ABS) st = 1;
        if (st !== pn.state) {
          if (r.kind === 'glass' && st === 2) {
            for (let i = v0; i < v1; i++) r.hidden[i] = 1;
            const c = this.worldOf(bp[v0 * 3], bp[v0 * 3 + 1], bp[v0 * 3 + 2]);
            crash.fx.push({ p: c, n: { x: 0, y: 1, z: 0 }, e: 6, kind: 'glass' });
          }
          if (st >= 1 && pn.state === 0) {
            r.mesh.geometry.groups.find((g) => g.start === pn.start).materialIndex = 1;
            if (r.kind === 'glass' && st === 1) crash.fx.push({ p: this.worldOf(bp[v0 * 3], bp[v0 * 3 + 1], bp[v0 * 3 + 2]), n: { x: 0, y: 1, z: 0 }, e: 2, kind: 'crack' });
          }
          pn.state = st;
        }
      }
      // write positions (mesh-local), hidden triangles collapsed to a point (zero area: not drawn)
      const base = r.base;
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        if (r.hidden[i]) { arr[i3] = base[0]; arr[i3 + 1] = base[1]; arr[i3 + 2] = base[2]; continue; }
        const x = d[i3], y = d[i3 + 1], z = d[i3 + 2];
        arr[i3] = base[i3] + il[0] * x + il[3] * y + il[6] * z;
        arr[i3 + 1] = base[i3 + 1] + il[1] * x + il[4] * y + il[7] * z;
        arr[i3 + 2] = base[i3 + 2] + il[2] * x + il[5] * y + il[8] * z;
        if (r.kind === 'panel') {
          const m = Math.hypot(x, y, z);
          if (m > maxAll) maxAll = m;
          const bx = bp[i3], by = bp[i3 + 1], bz = bp[i3 + 2];
          const zn = bz < L.cab[0] ? zones.front : bz > L.cab[1] ? zones.rear : by > L.belt ? zones.roof : bx < -cw / 4 ? zones.left : bx > cw / 4 ? zones.right : null;
          if (zn) { zn.max = Math.max(zn.max, m); zn.sum += m; zn.n++; }
        }
      }
      pos.needsUpdate = true;
      this.renormal(r);
      r.mesh.geometry.computeBoundingSphere();
    }
    for (const z of Object.values(zones)) z.mean = z.n ? z.sum / z.n : 0;
    this.maxDisp = maxAll;
  }

  // rotate each triangle's authored normals by the rotation that triangle went through
  renormal(r) {
    const geo = r.mesh.geometry, pos = geo.attributes.position.array, nrm = geo.attributes.normal, out = nrm.array;
    const base = r.base, bn = r.baseNormal, idx = geo.index;
    const tc = idx ? idx.count : pos.length / 3;
    const acc = this.acc && this.acc.length >= out.length ? this.acc : (this.acc = new Float32Array(out.length));
    acc.fill(0, 0, out.length);
    const touched = this.touched && this.touched.length >= out.length / 3 ? this.touched : (this.touched = new Uint8Array(out.length / 3));
    touched.fill(0, 0, out.length / 3);
    const fn = (p, a, b, c, o) => {
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
      const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
      o[0] = uy * vz - uz * vy; o[1] = uz * vx - ux * vz; o[2] = ux * vy - uy * vx;
      const l = Math.hypot(o[0], o[1], o[2]); if (l < 1e-12) return 0;
      o[0] /= l; o[1] /= l; o[2] /= l; return l;
    };
    const n0 = [0, 0, 0], n1 = [0, 0, 0];
    for (let t = 0; t < tc; t += 3) {
      const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
      let moved = false;
      for (const q of [a, b, c]) if (Math.abs(pos[q * 3] - base[q * 3]) + Math.abs(pos[q * 3 + 1] - base[q * 3 + 1]) + Math.abs(pos[q * 3 + 2] - base[q * 3 + 2]) > 1e-4) { moved = true; break; }
      if (!moved) continue;
      if (!fn(base, a, b, c, n0) || !fn(pos, a, b, c, n1)) continue;
      // axis-angle rotation n0 -> n1 (Rodrigues)
      let kx = n0[1] * n1[2] - n0[2] * n1[1], ky = n0[2] * n1[0] - n0[0] * n1[2], kz = n0[0] * n1[1] - n0[1] * n1[0];
      const sn = Math.hypot(kx, ky, kz), cs = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2];
      if (sn > 1e-9) { kx /= sn; ky /= sn; kz /= sn; }
      for (const q of [a, b, c]) {
        const x = bn[q * 3], y = bn[q * 3 + 1], z = bn[q * 3 + 2];
        let rx = x, ry = y, rz = z;
        if (sn > 1e-9) {
          const kd = kx * x + ky * y + kz * z;
          rx = x * cs + (ky * z - kz * y) * sn + kx * kd * (1 - cs);
          ry = y * cs + (kz * x - kx * z) * sn + ky * kd * (1 - cs);
          rz = z * cs + (kx * y - ky * x) * sn + kz * kd * (1 - cs);
        }
        acc[q * 3] += rx; acc[q * 3 + 1] += ry; acc[q * 3 + 2] += rz; touched[q] = 1;
      }
    }
    const n = out.length / 3;
    for (let i = 0; i < n; i++) {
      if (!touched[i]) { out[i * 3] = bn[i * 3]; out[i * 3 + 1] = bn[i * 3 + 1]; out[i * 3 + 2] = bn[i * 3 + 2]; continue; }
      const l = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]) || 1;
      out[i * 3] = acc[i * 3] / l; out[i * 3 + 1] = acc[i * 3 + 1] / l; out[i * 3 + 2] = acc[i * 3 + 2] / l;
    }
    nrm.needsUpdate = true;
  }

  worldOf(x, y, z) {
    const c = this.v.chassis, q = c.rotation(), t = c.translation();
    const p = new THREE.Vector3(x, y, z).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    return { x: p.x + t.x, y: p.y + t.y, z: p.z + t.z };
  }

  // a torn-off part: copy its (crumpled) triangles into a mesh that rides on its rigid body
  syncDebris() {
    for (const d of this.debris) this.disposeDebris(d);
    this.debris = [];
    const crash = this.v.crash;
    if (this.version !== this.cage.version) { this.version = this.cage.version; this.deform(); }
    for (const src of crash.debris) {
      const pi = crash.parts.indexOf(src.part);
      const group = new THREE.Group();
      for (const r of this.meshes) {
        const pos = r.mesh.geometry.attributes.position, idx = r.mesh.geometry.index;
        const tc = idx ? idx.count : pos.count;
        const tris = [];
        for (let t = 0; t < tc; t += 3) {
          const a = idx ? idx.getX(t) : t;
          if (r.part[a] === pi) tris.push(t);
        }
        if (!tris.length) continue;
        const geo = new THREE.BufferGeometry();
        const P = new Float32Array(tris.length * 9), N = new Float32Array(tris.length * 9);
        const uvA = r.mesh.geometry.attributes.uv, UV = uvA ? new Float32Array(tris.length * 6) : null;
        const nrm = r.mesh.geometry.attributes.normal;
        const tv = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(r.toBody);
        let k = 0;
        for (const t of tris) for (let j = 0; j < 3; j++) {
          const i = idx ? idx.getX(t + j) : t + j;
          // the deformed position (hidden vertices are collapsed now, so rebuild from base + disp)
          tv.set(r.bodyPos[i * 3] + r.disp[i * 3], r.bodyPos[i * 3 + 1] + r.disp[i * 3 + 1], r.bodyPos[i * 3 + 2] + r.disp[i * 3 + 2]);
          P[k * 3] = tv.x - src.offset.x; P[k * 3 + 1] = tv.y - src.offset.y; P[k * 3 + 2] = tv.z - src.offset.z;
          tv.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).applyMatrix3(nm).normalize();
          N[k * 3] = tv.x; N[k * 3 + 1] = tv.y; N[k * 3 + 2] = tv.z;
          if (UV) { UV[k * 2] = uvA.getX(i); UV[k * 2 + 1] = uvA.getY(i); }
          k++;
        }
        geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
        if (UV) geo.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
        const mat = Array.isArray(r.mesh.material) ? r.mesh.material[r.kind === 'lamp' ? 1 : 0] : r.mesh.material;
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = m.receiveShadow = true;
        group.add(m);
      }
      this.view.root.add(group);
      this.debris.push({ src, group });
    }
    // the parts' triangles are gone from the body now
    this.version = -1; this.full = true;
  }

  disposeDebris(d) {
    d.group.parent && d.group.parent.remove(d.group);
    d.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }

  // Full visual repair in place (pairs with vehicle.repair()).
  repair() {
    for (const d of this.debris) this.disposeDebris(d);
    this.debris = [];
    for (const r of this.meshes) {
      r.hidden.fill(0);
      if (r.panes) { for (const pn of r.panes) pn.state = 0; for (const g of r.mesh.geometry.groups) g.materialIndex = 0; }
    }
    this.version = -1; this.full = true;
    this.update();
  }

  stats() {
    const glass = { total: 0, cracked: 0, gone: 0 }, lamps = { total: 0, broken: 0 };
    for (const r of this.meshes) if (r.panes) for (const pn of r.panes) {
      if (r.kind === 'glass') { glass.total++; if (pn.state === 1) glass.cracked++; if (pn.state === 2) glass.gone++; }
      else { lamps.total++; if (pn.state) lamps.broken++; }
    }
    return { max: this.maxDisp || 0, zones: this.zoneStats || { front: Z(), rear: Z(), roof: Z(), left: Z(), right: Z() }, glass, lamps, debris: this.debris.length };
  }

  dispose() {
    for (const d of this.debris) this.disposeDebris(d);
    this.debris = [];
    for (const m of this.ownMats) m.dispose();
    this.ownMats = [];
  }
}

const Z = () => ({ max: 0, sum: 0, n: 0, mean: 0 });
