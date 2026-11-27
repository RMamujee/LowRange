// Mud caked on the truck: the tyres pick it up in the bogs and shed it on firm ground, spray from
// the wheels builds up on the lower bodywork, fords wash it off (amounts: TyreFx.tyreMud / bodyMud).
// Drawn in the truck's own materials by the toon shader (gfx/toon.js calls mudCoatPatch for
// materials marked userData.mudCoat = 'body' | 'tyre'): no extra meshes or draw calls. The body
// coat rises from the sills with the amount, in blotches on a 32 px/m lattice; tyres cake in
// object space, so the mud turns with the wheel. Fresh mud is dark and wet, and dries paler.
import * as THREE from 'three';
import { RAMP } from '../gfx/palette.js';

export const MUD_COAT = {
  uMudBody: { value: 0 },
  uMudTyre: { value: 0 },
  uMudCol: { value: new THREE.Color(RAMP.mud[2]) },
  uMudLine: { value: new THREE.Vector2(-0.6, 1) }, // chassis-local height of the coat at no mud, rise at full
  uMudInv: { value: new THREE.Matrix4() },          // world -> chassis
};

const NOISE = /* glsl */ `
float mudH3(vec3 p) { return fract(sin(dot(p, vec3(17.1, 113.7, 59.3))) * 43758.5453); }
float mudN3(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(mudH3(i), mudH3(i + vec3(1, 0, 0)), f.x), mix(mudH3(i + vec3(0, 1, 0)), mudH3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(mudH3(i + vec3(0, 0, 1)), mudH3(i + vec3(1, 0, 1)), f.x), mix(mudH3(i + vec3(0, 1, 1)), mudH3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`;

export function mudCoatPatch(shader, kind) {
  Object.assign(shader.uniforms, MUD_COAT);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform mat4 uMudInv;\nvarying vec3 vMudL;\nvarying vec3 vMudO;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvMudO = transformed;\nvMudL = (uMudInv * modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nuniform float uMudBody, uMudTyre;\nuniform vec3 uMudCol;\nuniform vec2 uMudLine;\nvarying vec3 vMudL;\nvarying vec3 vMudO;\n${NOISE}`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      {
        vec3 q = floor(vMudO * 32.0) / 32.0;              // crisp blotches on the texel lattice
        float n = mudN3(q * 7.0) * 0.65 + mudN3(q * 19.0) * 0.35;
        ${kind === 'tyre' ? `
        float m = step(1.0 - uMudTyre * 0.85, 0.25 + n * 0.75);` : `
        float line = uMudLine.x + uMudBody * uMudLine.y;
        float cover = smoothstep(line + 0.12, line - 0.3, vMudL.y + (n - 0.5) * 0.3);
        float near = smoothstep(line + 0.45, line, vMudL.y);
        float m = uMudBody > 0.01 ? step(1.0 - 0.6 * uMudBody, cover * 0.7 + near * n * 0.45) : 0.0;`}
        diffuseColor.rgb = mix(diffuseColor.rgb, uMudCol * (0.85 + 0.3 * step(0.62, n)), m);
      }`);
}

export class MudCoat {
  constructor() { this.view = null; this.own = []; }

  // Per vehicle view: the in-game truck gets its own copies of its materials and only those are
  // marked. glTF materials are one instance shared by every clone of a model (the garage preview's
  // included), so marking the originals would coat the preview too; a material used by both a
  // wheel and the body gets one copy per kind. Lamps keep their shared materials (the view drives
  // their glow). The copies are disposed when the next view replaces this one.
  adopt(view) {
    for (const m of this.own) m.dispose();
    this.own.length = 0;
    const wheels = new Set();
    view.wheels.forEach((w) => w.traverse((o) => wheels.add(o)));
    const keep = new Set([...view.tailMats, ...Object.values(view.body.userData.lights || {})]);
    const copies = new Map(); // original -> { body, tyre }
    const copy = (m, kind) => {
      if (!m || !m.isMeshStandardMaterial || m.transparent || keep.has(m)) return m;
      let c = copies.get(m);
      if (!c) copies.set(m, (c = {}));
      if (!c[kind]) { c[kind] = m.clone(); c[kind].userData = { ...m.userData, mudCoat: kind }; this.own.push(c[kind]); }
      return c[kind];
    };
    view.root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const kind = wheels.has(o) ? 'tyre' : 'body';
      o.material = Array.isArray(o.material) ? o.material.map((m) => copy(m, kind)) : copy(o.material, kind);
    });
  }

  // adopt a new truck's materials once, then feed the shared uniforms every frame
  update(car, view, fx) {
    if (!car || !view) return;
    if (view !== this.view) {
      this.view = view;
      fx.tyreMud.fill(0); fx.bodyMud = 0; // a fresh truck arrives clean
      this.adopt(view);
      const s = car.spec;
      MUD_COAT.uMudLine.value.set(s.axleY - s.tire.radius * 0.35, s.tire.radius * 1.5 + 0.2);
    }
    let tm = 0;
    for (const x of fx.tyreMud) tm = Math.max(tm, x);
    MUD_COAT.uMudTyre.value = tm;
    MUD_COAT.uMudBody.value = fx.bodyMud;
    const dry = Math.min(0.75, fx.mudAge / 90);
    MUD_COAT.uMudCol.value.set(RAMP.mud[2]).lerp(_dried.set(RAMP.mud[0]), dry);
    MUD_COAT.uMudInv.value.copy(view.body.matrixWorld).invert();
  }
}
const _dried = new THREE.Color();
