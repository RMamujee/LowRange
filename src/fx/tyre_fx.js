// Tyre effects: mud flung off the tread, splats where it lands, water spray, grit, dust, and the
// crash debris / smoke main.js asks for. Two pooled, instanced particle systems, one draw each:
//
//  - lumps: small solid bits (mud lumps and flecks, water drops, grit, paint flakes), each an
//    irregular blob with its own outline shape, streaked along its screen-space motion, lit from
//    above in two toon steps (+ a wet glint on fresh mud). Ballistic: gravity and a little air drag.
//    Mud lumps that hit the ground turn into flat splats that stay a few seconds.
//  - puffs: soft, semi-transparent dust / smoke / mist: procedural noisy blobs that grow, rise a
//    touch, drift downwind and thin out; faded where they meet the ground and near the camera.
//
// Particles are never square, never outlined (alpha 0 = the pipeline's "any" outline id, and no
// depth writes) and never smaller than about one and a half game pixels, so they stay grains at any
// Pixel size instead of vanishing or turning into blocks. Counts scale with the graphics preset.
// No allocation per frame in this module: fixed pools, struct-of-arrays state, scratch objects,
// one buffer upload per system (Rapier's translation() / linvel() still return fresh objects).
import * as THREE from 'three';
import { noOutline } from '../gfx/pipeline.js';
import { RAMP, FOG } from '../gfx/palette.js';

const BUDGET = { low: 0.45, medium: 0.7, high: 1 };
const LMAX = 2400, PMAX = 1100;  // pool sizes (high preset)
const G = 9.81;

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const MUDC = RAMP.mud.map(lin), WATERC = lin(0xdcecf0), FOGC = lin(FOG);
const rand = Math.random;

const LUMP_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aCol;   // rgb, wetness
attribute vec3 aMisc;  // size (m), seed, flat (ground splat)
uniform float uResY;   // internal frame height in game pixels
uniform float uStreak; // seconds of motion smeared into a streak
varying vec2 vUv;
varying vec2 vLight;
varying vec4 vCol;
varying float vSeed;
varying float vFlat;
#include <fog_pars_vertex>
void main() {
  vUv = position.xy * 2.0;
  vLight = vUv;
  vCol = aCol; vSeed = aMisc.y; vFlat = aMisc.z;
  float size = aMisc.x;
  vec4 mvPosition;
  if (aMisc.z > 0.5) {
    float a = aMisc.y * 6.2832, c = cos(a), s = sin(a);
    vec2 o = mat2(c, s, -s, c) * position.xy * size;
    mvPosition = modelViewMatrix * vec4(aPos + vec3(o.x, 0.0, o.y), 1.0);
  } else {
    mvPosition = modelViewMatrix * vec4(aPos, 1.0);
    size = max(size, 1.5 * max(-mvPosition.z, 0.1) * 2.0 / (projectionMatrix[1][1] * uResY));
    vec3 vv = mat3(modelViewMatrix) * aVel;
    float sp = length(vv.xy);
    vec2 ax = sp > 1e-3 ? vv.xy / sp : vec2(1.0, 0.0);
    vec2 ay = vec2(-ax.y, ax.x);
    float len = size + sp * uStreak;
    mvPosition.xy += ax * position.x * len + ay * position.y * size;
    vLight = ax * vUv.x * (len / size) + ay * vUv.y; // screen-space offset: y is up on screen
  }
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const LUMP_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec2 vLight;
varying vec4 vCol;
varying float vSeed;
varying float vFlat;
#include <fog_pars_fragment>
void main() {
  float a = vSeed * 6.2832, c = cos(a), s = sin(a);
  vec2 p = mat2(c, s, -s, c) * vUv;
  float th = atan(p.y, p.x), r = length(p);
  float edge = vFlat > 0.5
    ? 0.6 + 0.16 * sin(th * 5.0 + vSeed * 40.0) + 0.12 * sin(th * 9.0 + vSeed * 17.0) + 0.1 * sin(th * 3.0 + vSeed * 7.0)
    : 0.8 + 0.12 * sin(th * 3.0 + vSeed * 31.0) + 0.08 * sin(th * 5.0 + vSeed * 11.0);
  if (r > edge) discard;
  vec3 col = vCol.rgb;
  if (vFlat < 0.5) {
    // a small round lump lit from above: two toon steps, and a glint on wet mud
    float lit = vLight.y * 0.7 + 0.35 - r * 0.25;
    col *= lit > 0.0 ? 1.0 : 0.74;
    if (vCol.a > 0.3 && vLight.y > 0.3 && vLight.x < 0.1 && r < edge * 0.6) col = mix(col, vec3(0.86, 0.82, 0.74), 0.4 * vCol.a);
  } else {
    // a splat: a wet, darker heart with a lighter thrown rim
    col *= r < edge * 0.55 ? 0.86 : 1.0;
  }
  gl_FragColor = vec4(col, 0.0); // alpha 0: matches any outline id (particles are never outlined)
  #ifdef USE_FOG
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(fogNear, fogFar, vFogDepth) * 0.45);
  #endif
}`;

const PUFF_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aCol;   // rgb, alpha
attribute vec3 aMisc;  // size (m), seed, ground height (m)
uniform vec2 uNear;    // fade in between these view distances (never a wall of dust in the chase view)
varying vec2 vUv;
varying vec4 vCol;
varying float vSeed;
varying float vY;
varying float vRel;
varying float vGround;
#include <fog_pars_vertex>
void main() {
  vUv = position.xy * 2.0;
  vCol = aCol; vSeed = aMisc.y; vGround = aMisc.z;
  vec4 mvPosition = modelViewMatrix * vec4(aPos, 1.0);
  float a = aMisc.y * 6.2832, c = cos(a), s = sin(a);
  vec2 o = mat2(c, s, -s, c) * position.xy * aMisc.x;
  mvPosition.xy += o;
  vec3 wo = (vec4(o, 0.0, 0.0) * viewMatrix).xyz; // view offset back to world
  vY = aPos.y + wo.y;
  vRel = wo.y / max(aMisc.x, 1e-3);
  vCol.a *= smoothstep(uNear.x, uNear.y, -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const PUFF_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec4 vCol;
varying float vSeed;
varying float vY;
varying float vRel;
varying float vGround;
#include <fog_pars_fragment>
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + 1.0), f.x), f.y);
}
void main() {
  float r = length(vUv);
  vec2 q = vUv * 1.6 + vSeed * 17.0;
  float n = vn(q) * 0.6 + vn(q * 2.3 + 3.1) * 0.4;
  float a = smoothstep(1.0, 0.1, r + (n - 0.5) * 0.7) * vCol.a;
  a *= smoothstep(vGround - 0.05, vGround + 0.3, vY); // soft where it meets the ground
  if (a < 0.004) discard;
  vec3 col = vCol.rgb * (0.88 + 0.22 * clamp(vRel + 0.5, 0.0, 1.0)); // lit from above
  gl_FragColor = vec4(col, a);
  #ifdef USE_FOG
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(fogNear, fogFar, vFogDepth) * 0.45);
  #endif
}`;

function instanced(max, layout) {
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index; geo.setAttribute('position', quad.attributes.position);
  const arrs = {};
  for (const [name, n] of Object.entries(layout)) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a); arrs[name] = a;
  }
  geo.instanceCount = 0;
  return { geo, arrs };
}

export class TyreFx {
  // opts: { heightAt(x, z) shown ground height, surfaceAt(x, z) mud surface or null,
  //         materialAt(x, z), MAT, MAT_INFO, quality: () => 'low'|'medium'|'high', pixels }
  constructor(scene, opts) {
    this.o = opts;
    this.MAT = opts.MAT;
    // ---- lumps ----
    this.L = { n: 0, x: new Float32Array(LMAX), y: new Float32Array(LMAX), z: new Float32Array(LMAX), vx: new Float32Array(LMAX), vy: new Float32Array(LMAX), vz: new Float32Array(LMAX),
      life: new Float32Array(LMAX), size: new Float32Array(LMAX), seed: new Float32Array(LMAX), flat: new Uint8Array(LMAX), drag: new Float32Array(LMAX), kind: new Uint8Array(LMAX),
      r: new Float32Array(LMAX), g: new Float32Array(LMAX), b: new Float32Array(LMAX), wet: new Float32Array(LMAX) };
    const lg = instanced(LMAX, { aPos: 3, aVel: 3, aCol: 4, aMisc: 3 });
    this.lumpArrs = lg.arrs;
    this.lumpMat = new THREE.ShaderMaterial({
      vertexShader: LUMP_VERT, fragmentShader: LUMP_FRAG, fog: true, side: THREE.DoubleSide,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uResY: { value: 720 }, uStreak: { value: 0.012 } }]),
    });
    this.lumps = new THREE.Mesh(lg.geo, this.lumpMat);
    this.lumps.frustumCulled = false; this.lumps.name = 'tyre-lumps';
    noOutline(this.lumps);
    scene.add(this.lumps);
    // ---- puffs ----
    this.P = { n: 0, x: new Float32Array(PMAX), y: new Float32Array(PMAX), z: new Float32Array(PMAX), vx: new Float32Array(PMAX), vy: new Float32Array(PMAX), vz: new Float32Array(PMAX),
      life: new Float32Array(PMAX), life0: new Float32Array(PMAX), s0: new Float32Array(PMAX), grow: new Float32Array(PMAX), a: new Float32Array(PMAX), seed: new Float32Array(PMAX),
      ground: new Float32Array(PMAX), rise: new Float32Array(PMAX), drag: new Float32Array(PMAX), r: new Float32Array(PMAX), g: new Float32Array(PMAX), b: new Float32Array(PMAX) };
    const pg = instanced(PMAX, { aPos: 3, aCol: 4, aMisc: 3 });
    this.puffArrs = pg.arrs;
    this.puffMat = new THREE.ShaderMaterial({
      vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG, fog: true, transparent: true, depthWrite: false,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uNear: { value: new THREE.Vector2(2.0, 5.5) } }]),
    });
    this.puffs = new THREE.Mesh(pg.geo, this.puffMat);
    this.puffs.frustumCulled = false; this.puffs.name = 'tyre-puffs';
    noOutline(this.puffs);
    this.puffs.renderOrder += 1; // after the lumps
    scene.add(this.puffs);
    // per wheel: emission accumulators and the mud each tyre carries (read by the mud coat)
    this.acc = new Float32Array(16);
    this.tyreMud = new Float32Array(4); // 0..1: mud caked on each tyre
    this.bodyMud = 0;                   // 0..1: mud thrown up the lower bodywork
    this.mudAge = 0;                    // seconds since the last fresh mud (it dries lighter)
    this.cpu = 0; this.cpuN = 0;
    // scratch (no allocation per frame): tread point, colour, the current wheel's frame
    this._t = { px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0 }; this._col = new Float32Array(3); this._w8 = new Float64Array(7);
    // dust per surface: dryness (none in mud or water)
    this.dry = new Float32Array(16); const M = opts.MAT;
    this.dry[M.ROAD] = 1.0; this.dry[M.DIRT] = 0.85; this.dry[M.SAND] = 0.7; this.dry[M.GRAVEL] = 0.55;
  }

  // a point on the current wheel's tread at angle th from the bottom towards the back, and its
  // velocity (hub velocity + spin x radius), into this._t
  tread(th) {
    const W = this._w8, c = this._c, lv = this._lv, av = this._av, out = this._t, R = W[6];
    const ca = Math.cos(th), sa = Math.sin(th);
    const rx = (W[0] * ca + W[3] * sa) * R, ry = (W[1] * ca + W[4] * sa) * R, rz = (W[2] * ca + W[5] * sa) * R;
    out.px = c.x + rx; out.py = c.y + ry; out.pz = c.z + rz;
    out.vx = lv.x + av.y * rz - av.z * ry; out.vy = lv.y + av.z * rx - av.x * rz; out.vz = lv.z + av.x * ry - av.y * rx;
    return out;
  }

  budget() { return BUDGET[this.o.quality ? this.o.quality() : 'high'] ?? 1; }
  reset() { this.tyreMud.fill(0); this.bodyMud = 0; this.L.n = 0; this.P.n = 0; }

  // ---------------------------------------------------------------- spawning
  lump(x, y, z, vx, vy, vz, size, col, life, drag, kind, wet = 0) {
    const L = this.L;
    if (L.n >= LMAX * this.budget()) return;
    const i = L.n++;
    L.x[i] = x; L.y[i] = y; L.z[i] = z; L.vx[i] = vx; L.vy[i] = vy; L.vz[i] = vz;
    L.size[i] = size; L.life[i] = life; L.drag[i] = drag; L.kind[i] = kind; L.flat[i] = 0; L.seed[i] = rand();
    L.r[i] = col[0]; L.g[i] = col[1]; L.b[i] = col[2]; L.wet[i] = wet;
  }
  puff(x, y, z, vx, vy, vz, size, grow, col, alpha, life, rise = 0.12, drag = 1.6) {
    const P = this.P;
    if (P.n >= PMAX * this.budget()) return;
    const i = P.n++;
    P.x[i] = x; P.y[i] = y; P.z[i] = z; P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz;
    P.s0[i] = size; P.grow[i] = grow; P.a[i] = alpha; P.life[i] = life; P.life0[i] = life; P.seed[i] = rand();
    P.ground[i] = this.o.heightAt(x, z); P.rise[i] = rise; P.drag[i] = drag;
    P.r[i] = col[0]; P.g[i] = col[1]; P.b[i] = col[2];
  }
  // crash flakes / glass (main.js crashFx): small tumbling flakes
  debris(x, y, z, vx, vy, vz, col, life) { this.lump(x, y, z, vx, vy, vz, 0.035 + rand() * 0.04, col, life, 0.6, 2); }
  // steam and engine smoke (main.js): soft rising puffs
  smoke(x, y, z, vx, vy, vz, col, life) { this.puff(x, y, z, vx, vy * 0.6, vz, 0.25, 2.2, col, 0.28, life * 1.4, 0.9, 1.2); }

  // ---------------------------------------------------------------- per-wheel emission
  // car: the Vehicle; spec its spec; dt: frame time. Called every frame while driving.
  wheels(car, dt) {
    const t0 = performance.now();
    const { MAT } = this, MI = this.o.MAT_INFO, spec = car.spec, R = spec.tire.radius, Wt = spec.tire.width, B = this.budget();
    const cv = car.chassis.linvel(), sp = Math.hypot(cv.x, cv.z);
    let anyMud = false, anyWater = false;
    const T = this._t, col = this._col;
    for (let i = 0; i < 4; i++) {
      const ws = car.wheelState[i];
      if (car.broken[i]) continue;
      const wb = car.wheels[i], c = wb.translation(), lv = wb.linvel(), av = wb.angvel(), ax = car.wheelAxis(i);
      // the tyre's frame: down (square to the axle), and "back": the way the tread at the bottom moves
      let dx = ax.x * ax.y, dy = ax.y * ax.y - 1, dz = ax.z * ax.y;
      const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
      const sgn = ws.spin >= 0 ? 1 : -1;
      // forward = axle x down (right-handed, wheels spin forward about -x)
      let fx = ax.y * dz - ax.z * dy, fy = ax.z * dx - ax.x * dz, fz = ax.x * dy - ax.y * dx;
      const bx = -fx * sgn, by = -fy * sgn, bz = -fz * sgn;
      const surf = Math.abs(ws.spin) * R;            // tread speed around the hub (m/s)
      const ground = this.o.heightAt(c.x, c.z);
      const mat = ws.grounded ? ws.mat : -1;
      const inMud = mat === MAT.MUD, inWater = mat === MAT.WATER;
      // a point on the tread at angle th from the bottom, towards the back, and its velocity (into T)
      const W = this._w8; W[0] = dx; W[1] = dy; W[2] = dz; W[3] = bx; W[4] = by; W[5] = bz; W[6] = R;
      this._c = c; this._lv = lv; this._av = av;
      // ---- mud: thrown off the tread once it spins fast enough to shed it (centripetal
      // acceleration past the mud's grip on the rubber), more with wheelspin and wetter mud
      const carried = this.tyreMud[i];
      if (inMud || carried > 0.05) {
        const shed = Math.min(1, Math.max(0, (surf * surf / R - 14) / 70)); // v^2/R: sticks below ~1.5 g
        const slip = ws.slip || 0;
        let rate = inMud ? 3 + shed * (14 + surf * 4) + Math.min(24, slip * 4) : carried * shed * (10 + surf * 2);
        if (inMud && (ws.sink || 0) > 0.05 && sp > 3) rate += (ws.sink * 50) * Math.min(1, (sp - 3) / 6); // bow wave
        this.acc[i] += Math.min(70, rate) * B * dt;
        const ramp = MUDC;
        while (this.acc[i] >= 1) {
          this.acc[i] -= 1;
          const bow = inMud && (ws.sink || 0) > 0.05 && sp > 3 && rand() < 0.25;
          const lat = (rand() - 0.5) * Wt;
          let px, py, pz, vx, vy, vz;
          if (bow) { // squeezed out ahead and to the sides of a tyre ploughing at speed
            const side = rand() < 0.5 ? -1 : 1, k = 0.3 + rand() * 0.5;
            px = c.x + dx * R * 0.85 - bx * R * 0.5 + ax.x * side * Wt * 0.6; py = Math.max(ground, c.y + dy * R * 0.85); pz = c.z + dz * R * 0.85 - bz * R * 0.5 + ax.z * side * Wt * 0.6;
            vx = lv.x * k + ax.x * side * (1 + rand() * 1.5); vy = 0.8 + rand() * 1.6; vz = lv.z * k + ax.z * side * (1 + rand() * 1.5);
          } else { // off the tread, tangential, a little slower than the rubber (it slides as it lets go)
            this.tread(0.35 + rand() * 1.9);
            const k = 0.3 + rand() * 0.4;
            px = T.px + ax.x * lat; py = Math.max(ground + 0.03, T.py); pz = T.pz + ax.z * lat;
            vx = lv.x + (T.vx - lv.x) * k + (rand() - 0.5) * 0.8; vy = lv.y + (T.vy - lv.y) * k + rand() * 0.6; vz = lv.z + (T.vz - lv.z) * k + (rand() - 0.5) * 0.8;
          }
          // mostly small: flecks 1-3 cm, lumps up to 8 cm, now and then a clod
          const u = rand(), size = u < 0.55 ? 0.012 + rand() * 0.02 : u < 0.93 ? 0.03 + rand() * 0.04 : 0.07 + rand() * 0.05;
          const shade = rand(), base = shade < 0.5 ? ramp[2] : shade < 0.85 ? ramp[1] : ramp[3];
          const wv = 0.8 + rand() * 0.25; // wet mud is darker
          col[0] = base[0] * wv; col[1] = base[1] * wv; col[2] = base[2] * wv;
          this.lump(px, py, pz, vx, vy, vz, size, col, 2.5, size < 0.03 ? 0.9 : 0.3, 0, inMud ? 1 : 0.4);
        }
      }
      // ---- water: drops off the tread and a bow splash, plus mist at speed
      if (inWater) {
        const rate = Math.min(120, 6 + surf * 8 + sp * 6) * B;
        this.acc[i] += rate * dt;
        while (this.acc[i] >= 1) {
          this.acc[i] -= 1;
          if (rand() < 0.6) { this.tread(0.3 + rand() * 1.8); this.lump(T.px + ax.x * (rand() - 0.5) * Wt, Math.max(ground + 0.05, T.py), T.pz + ax.z * (rand() - 0.5) * Wt, lv.x + (T.vx - lv.x) * 0.8, lv.y + (T.vy - lv.y) * 0.8 + rand() * 0.5, lv.z + (T.vz - lv.z) * 0.8, 0.012 + rand() * 0.025, WATERC, 1.2, 0.6, 1, 1); }
          else { const side = rand() < 0.5 ? -1 : 1; this.lump(c.x + ax.x * side * Wt * 0.6, ground + 0.08, c.z + ax.z * side * Wt * 0.6, lv.x * 0.5 + ax.x * side * (0.8 + rand() * 2), 1.2 + rand() * 2.2, lv.z * 0.5 + ax.z * side * (0.8 + rand() * 2), 0.015 + rand() * 0.03, WATERC, 1.2, 0.6, 1, 1); }
        }
        if (sp > 4) {
          this.acc[8 + i] += Math.min(14, (sp - 4) * 1.5) * B * dt;
          while (this.acc[8 + i] >= 1) { this.acc[8 + i] -= 1; this.puff(c.x, ground + 0.3, c.z, lv.x * 0.25 + (rand() - 0.5), 0.5 + rand() * 0.5, lv.z * 0.25 + (rand() - 0.5), 0.35, 1.6, WATERC, 0.16, 0.9 + rand() * 0.5, 0.1, 2); }
        }
      }
      if (inMud) anyMud = true;
      if (inWater) anyWater = true;
      // ---- dust: many small soft puffs off the tread on dry ground, in proportion to speed and
      // wheelspin; each surface its own dryness and grain; none in mud or water
      const dry = mat >= 0 ? this.dry[mat] : 0;
      if (dry) {
        const rear = i >= 2 ? 1 : 0.45;
        const slip = ws.slip || 0;
        const rate = dry * rear * (Math.min(34, Math.max(0, sp - 3.5) * 1.5) + (slip > 0.6 ? Math.min(26, slip * 5) : 0));
        this.acc[8 + i] += rate * B * dt;
        const base = MI[mat].color;
        while (this.acc[8 + i] >= 1) {
          this.acc[8 + i] -= 1;
          // the ground's own colour, lifted towards the haze: fine dust is paler than the ground
          const lift = 0.5 + rand() * 0.12;
          for (let k = 0; k < 3; k++) { const s = base[k] * base[k]; col[k] = s + (FOGC[k] - s) * lift; } // base is sRGB: square ~ linear
          const fast = Math.min(1, sp / 25);
          const kick = 0.4 + Math.min(1.4, slip * 0.35);
          const life = 1.4 + rand() * 1.0 + fast * (2.2 + rand() * 1.5);
          const heavy = mat === MAT.SAND ? 1.6 : 1; // sand drops back sooner
          this.puff(c.x + (rand() - 0.5) * Wt, ground + 0.12 + rand() * 0.2, c.z + (rand() - 0.5) * Wt,
            cv.x * 0.3 + bx * kick + (rand() - 0.5) * 1.2, 0.6 + rand() * 0.8 + fast * 0.5, cv.z * 0.3 + bz * kick + (rand() - 0.5) * 1.2,
            0.35 + rand() * 0.25 + fast * 0.4, 3.5 + fast * 3.5 + rand() * 1.5, col, (0.16 + rand() * 0.1) * (0.7 + 0.3 * dry) * (1 + slip * 0.04), life / heavy, (0.16 + fast * 0.14) / heavy, 1.5 * heavy);
        }
        // grit: a few grains with the dust when spinning or fast on gravel / sand
        const grit = (slip > 1 ? Math.min(30, slip * 6) : 0) + (mat === MAT.GRAVEL || mat === MAT.SAND ? Math.max(0, sp - 6) * 0.8 : 0);
        this.acc[4 + i] += grit * B * dt;
        while (this.acc[4 + i] >= 1) {
          this.acc[4 + i] -= 1;
          this.tread(0.3 + rand() * 1.3);
          for (let k = 0; k < 3; k++) col[k] = base[k] * base[k] * (0.75 + rand() * 0.35);
          this.lump(T.px, Math.max(ground + 0.03, T.py), T.pz, lv.x + (T.vx - lv.x) * 0.5, lv.y + (T.vy - lv.y) * 0.5 + rand(), lv.z + (T.vz - lv.z) * 0.5, 0.01 + rand() * 0.018, col, 1.2, 0.4, 2);
        }
      } else if (mat >= 0 && !inMud && !inWater && (ws.slip || 0) > 1) {
        // a wheel spinning on rock or grass: a little grit / torn turf
        this.acc[4 + i] += Math.min(14, 2 + ws.slip * 2) * B * dt;
        const base = MI[mat].color;
        while (this.acc[4 + i] >= 1) {
          this.acc[4 + i] -= 1;
          this.tread(0.3 + rand() * 1.2);
          for (let k = 0; k < 3; k++) col[k] = base[k] * base[k] * (0.7 + rand() * 0.3);
          this.lump(T.px, Math.max(ground + 0.03, T.py), T.pz, lv.x + (T.vx - lv.x) * 0.45, lv.y + (T.vy - lv.y) * 0.45 + rand() * 0.5, lv.z + (T.vz - lv.z) * 0.45, 0.012 + rand() * 0.02, col, 1, 0.4, 2);
        }
      }
      // ---- mud the tyre carries: picked up in mud, shed on firm ground as it spins, washed in water
      const tm = this.tyreMud[i];
      if (inMud) this.tyreMud[i] = Math.min(1, tm + dt * (0.35 + Math.min(1, (ws.slip || 0) * 0.3)));
      else if (inWater) this.tyreMud[i] = Math.max(0, tm - dt * (0.15 + surf * 0.05));
      else this.tyreMud[i] = Math.max(0, tm - dt * surf * surf * 0.0015);
    }
    // lower bodywork: spray from spinning / fast tyres in mud builds up; fords wash it slowly
    if (anyMud) {
      let spray = 0;
      for (const ws of car.wheelState) if (ws.grounded && ws.mat === MAT.MUD) spray += Math.abs(ws.spin) * R * 0.004 + (ws.slip || 0) * 0.008;
      this.bodyMud = Math.min(1, this.bodyMud + spray * dt);
      this.mudAge = 0;
    } else this.mudAge += dt;
    if (anyWater) this.bodyMud = Math.max(0, this.bodyMud - dt * 0.04 * (1 + sp * 0.15));
    this.cpu += performance.now() - t0;
  }

  // ---------------------------------------------------------------- update + upload
  update(dt, camera) {
    const t0 = performance.now();
    const L = this.L, la = this.lumpArrs, P = this.P, pa = this.puffArrs;
    const surfaceAt = this.o.surfaceAt, heightAt = this.o.heightAt, materialAt = this.o.materialAt, WATER = this.MAT.WATER;
    // lumps: ballistic; mud that lands becomes a splat; everything else is gone on landing
    let n = 0;
    const aP = la.aPos.array, aV = la.aVel.array, aC = la.aCol.array, aM = la.aMisc.array;
    for (let i = 0; i < L.n; i++) {
      let life = L.life[i] - dt;
      if (life <= 0) continue;
      let x = L.x[i], y = L.y[i], z = L.z[i], vx = L.vx[i], vy = L.vy[i], vz = L.vz[i], size = L.size[i], flat = L.flat[i];
      if (!flat) {
        const k = Math.exp(-L.drag[i] * dt);
        vx *= k; vz *= k; vy = vy * k - G * dt;
        x += vx * dt; y += vy * dt; z += vz * dt;
        if (vy < 0) {
          const gy = (surfaceAt && surfaceAt(x, z)) ?? heightAt(x, z);
          if (y <= gy) {
            if (L.kind[i] !== 0 || materialAt(x, z) === WATER) continue; // drops, grit and flakes: gone
            flat = 1; y = gy + 0.025; vx = vy = vz = 0;
            size *= 1.5 + rand() * 0.8; life = 1.5 + rand() * 2.5;
            L.r[i] *= 0.9; L.g[i] *= 0.9; L.b[i] *= 0.9;
          }
        }
      } else if (life < 1.2) size *= 1 - dt * 0.9; // a splat soaks in
      // compact the live particles to the front of the pool
      L.x[n] = x; L.y[n] = y; L.z[n] = z; L.vx[n] = vx; L.vy[n] = vy; L.vz[n] = vz; L.life[n] = life; L.size[n] = size; L.flat[n] = flat;
      if (n !== i) { L.seed[n] = L.seed[i]; L.drag[n] = L.drag[i]; L.kind[n] = L.kind[i]; L.r[n] = L.r[i]; L.g[n] = L.g[i]; L.b[n] = L.b[i]; L.wet[n] = L.wet[i]; }
      aP[n * 3] = x; aP[n * 3 + 1] = y; aP[n * 3 + 2] = z;
      aV[n * 3] = vx; aV[n * 3 + 1] = vy; aV[n * 3 + 2] = vz;
      aC[n * 4] = L.r[n]; aC[n * 4 + 1] = L.g[n]; aC[n * 4 + 2] = L.b[n]; aC[n * 4 + 3] = flat ? 0 : L.wet[n];
      aM[n * 3] = size; aM[n * 3 + 1] = L.seed[n]; aM[n * 3 + 2] = flat;
      n++;
    }
    L.n = n;
    this.lumps.geometry.instanceCount = n;
    for (const k of ['aPos', 'aVel', 'aCol', 'aMisc']) { const a = la[k]; a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; }
    // puffs: slow down fast, rise a touch, drift downwind, spread and thin out
    n = 0;
    const bP = pa.aPos.array, bC = pa.aCol.array, bM = pa.aMisc.array;
    for (let i = 0; i < P.n; i++) {
      const life = P.life[i] - dt;
      if (life <= 0) continue;
      const k = Math.exp(-P.drag[i] * dt);
      const vx = P.vx[i] * k + 0.35 * dt, vz = P.vz[i] * k + 0.15 * dt, vy = P.vy[i] * k + P.rise[i] * dt;
      const x = P.x[i] + vx * dt, y = Math.max(P.ground[i] + 0.05, P.y[i] + vy * dt), z = P.z[i] + vz * dt;
      const u = 1 - life / P.life0[i];
      const a = P.a[i] * Math.min(1, u * 8) * (1 - u) * (1 - u * 0.6);
      const size = P.s0[i] * (1 + P.grow[i] * Math.sqrt(u));
      P.x[n] = x; P.y[n] = y; P.z[n] = z; P.vx[n] = vx; P.vy[n] = vy; P.vz[n] = vz; P.life[n] = life;
      if (n !== i) { P.life0[n] = P.life0[i]; P.s0[n] = P.s0[i]; P.grow[n] = P.grow[i]; P.a[n] = P.a[i]; P.seed[n] = P.seed[i]; P.ground[n] = P.ground[i]; P.rise[n] = P.rise[i]; P.drag[n] = P.drag[i]; P.r[n] = P.r[i]; P.g[n] = P.g[i]; P.b[n] = P.b[i]; }
      bP[n * 3] = x; bP[n * 3 + 1] = y; bP[n * 3 + 2] = z;
      bC[n * 4] = P.r[n]; bC[n * 4 + 1] = P.g[n]; bC[n * 4 + 2] = P.b[n]; bC[n * 4 + 3] = a;
      bM[n * 3] = size; bM[n * 3 + 1] = P.seed[n]; bM[n * 3 + 2] = P.ground[n];
      n++;
    }
    P.n = n;
    this.puffs.geometry.instanceCount = n;
    for (const k of ['aPos', 'aCol', 'aMisc']) { const a = pa[k]; a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; }
    if (this.o.pixels) this.lumpMat.uniforms.uResY.value = this.o.pixels.h || 720;
    this.cpu += performance.now() - t0; this.cpuN++;
  }

  // live counts and the average CPU time per frame spent here (ms), since the last call
  stats() {
    const s = { lumps: this.L.n, puffs: this.P.n, cpuMs: this.cpuN ? +(this.cpu / this.cpuN).toFixed(3) : 0, tyreMud: [...this.tyreMud].map((x) => +x.toFixed(2)), bodyMud: +this.bodyMud.toFixed(2) };
    this.cpu = 0; this.cpuN = 0;
    return s;
  }
}
