// Tyre pressure on the truck you see: each tyre flattens at its contact patch and its sidewall
// bulges out as the pressure drops and the load rises. The flat is the physics tyre's own
// deflection (src/tyres/pressure.js defl: the wheel collider shrinks by the same amount), so a
// soft tyre sits on the ground instead of sinking into it, and the truck rides a touch lower.
//
// Done in the vertex shader of the tyre materials, procedural and glTF wheels alike: every vertex
// of a wheel mesh is pushed back to the patch plane (R - deflection below the wheel centre, along
// the contact direction) and, on the lower sidewall, outwards along the axle. The wheels spin, so
// the deformation is worked out in world space from four shared uniforms (one per wheel); a vertex
// belongs to the nearest wheel centre. Only the in-game truck's material copies are patched (the
// mud coat, src/fx/mud_coat.js, gives the truck its own materials first), never the shared glTF
// originals, so the garage preview is untouched.
import * as THREE from 'three';

const U = {
  uTyreC: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, -1e4, 0, 0.4)) },  // centre xyz, radius
  uTyreDn: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, -1, 0, 0)) },     // contact direction xyz, flat depth
  uTyreAx: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(1, 0, 0, 0)) },      // axle xyz, bulge
};
const BULGE = 2.0; // sidewall bulge per metre of deflection (drawn larger than life so it reads at pixel scale)

const GLSL_HEAD = /* glsl */ `
uniform vec4 uTyreC[4];
uniform vec4 uTyreDn[4];
uniform vec4 uTyreAx[4];`;
const GLSL_BODY = /* glsl */ `
{
  vec4 tq = modelMatrix * vec4(transformed, 1.0);
  int tk = 0; float tb = 1e9;
  for (int i = 0; i < 4; i++) { float d = distance(tq.xyz, uTyreC[i].xyz); if (d < tb) { tb = d; tk = i; } }
  float tdl = uTyreDn[tk].w;
  if (tdl > 0.0) {
    vec3 tc = uTyreC[tk].xyz, tdn = uTyreDn[tk].xyz, tax = uTyreAx[tk].xyz;
    float tR = uTyreC[tk].w;
    vec3 tr = tq.xyz - tc;
    float th = dot(tr, tdn), ta = dot(tr, tax);
    float trad = length(tr - tax * ta);
    vec3 toff = vec3(0.0);
    if (th > tR - tdl) toff -= tdn * (th - (tR - tdl));                       // the flat patch
    float tlow = smoothstep(0.15 * tR, 0.95 * tR, th) * smoothstep(0.62 * tR, 0.9 * tR, trad); // lower sidewall
    toff += tax * sign(ta) * uTyreAx[tk].w * tlow;                             // bulge out along the axle
    tq.xyz += toff;
    transformed = (inverse(modelMatrix) * tq).xyz;
  }
}`;

function patch(shader) {
  Object.assign(shader.uniforms, U);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>' + GLSL_HEAD)
    .replace('#include <begin_vertex>', '#include <begin_vertex>' + GLSL_BODY);
}

export class TyreView {
  constructor() { this.done = new WeakSet(); this.view = null; this.hidden = false; }

  // wrap the tyre materials' shader hooks (once per material copy)
  adopt(view) {
    const proto = THREE.MeshStandardMaterial.prototype;
    view.wheels.forEach((w) => w.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m.isMeshStandardMaterial || this.done.has(m)) continue;
        this.done.add(m);
        m.onBeforeCompile = function (sh, r) { proto.onBeforeCompile.call(this, sh, r); patch(sh); };
        m.customProgramCacheKey = function () { return proto.customProgramCacheKey.call(this) + '+tyre'; };
        m.needsUpdate = true;
      }
    }));
  }

  update(car, view) {
    if (!car || !view) return;
    if (view !== this.view) { this.view = view; this.frames = 0; }
    if (this.frames++ < 2 || this.frames % 30 === 0) this.adopt(view); // after the mud coat's copies; again now and then (a repaired truck's parts)
    const R = car.spec.tire.radius, T = car.tyre;
    // the deflection the physics tyre doesn't take (above crawl pressure, pressure.js PHYS_DEFL_FROM)
    // is drawn: the whole truck drawn that much lower, so the flattened tyres meet the ground
    let off = 0, n = 0;
    for (let i = 0; i < 4; i++) if (!car.broken[i]) { off += T.defl[i] - T.deflPhys[i]; n++; }
    off = n ? off / n : 0;
    view.root.position.y = -off;
    for (let i = 0; i < 4; i++) {
      const c = car.wheels[i].translation(), ax = car.wheelAxis(i);
      // contact direction: against the patch normals, else straight down; square to the axle
      let dx = 0, dy = 0, dz = 0;
      for (const pt of car.patches || []) if (pt.wheel === i) { dx -= pt.n.x * pt.N; dy -= pt.n.y * pt.N; dz -= pt.n.z * pt.N; }
      if (dx * dx + dy * dy + dz * dz < 1) { dx = 0; dy = -1; dz = 0; }
      const k = dx * ax.x + dy * ax.y + dz * ax.z;
      dx -= ax.x * k; dy -= ax.y * k; dz -= ax.z * k;
      const l = Math.hypot(dx, dy, dz) || 1;
      const flat = car.broken[i] || car.health.tire[i] < 0.35 ? 0 : T.defl[i]; // (a flat tyre sags its own way, vehicle_view.js)
      U.uTyreC.value[i].set(c.x, c.y - off, c.z, R);
      U.uTyreDn.value[i].set(dx / l, dy / l, dz / l, flat);
      U.uTyreAx.value[i].set(ax.x, ax.y, ax.z, flat * BULGE);
    }
  }
}
