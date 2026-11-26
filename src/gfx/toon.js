// Stepped toon lighting for every MeshStandardMaterial (and MeshPhysicalMaterial) in the game.
//
// installToon() patches MeshStandardMaterial.prototype.onBeforeCompile once, so procedural
// materials, glTF materials and anything created later (new trucks, the garage preview) all
// get it with no traversal or material swapping: maps, vertex/instance colours, emissive,
// transparency, instancing, flat shading and the dent system's geometry edits are untouched,
// because only the final light sum is replaced.
//
// How: three still runs its normal light loop (so real-time shadows, spot/point lights etc. all
// count); we read how much direct light reached the surface relative to a fully lit, sun-facing
// surface, then snap that to 3 bands (warm hue-shifted shade, lit, highlight). Undersides get a
// slightly deeper shade so forms read as light tops / dark bases. Specular is dropped (flat paint).
import * as THREE from 'three';
import { GROUND_GLSL, groundTextureArray, LAYER_BOULDER } from './pixeltex.js';

const col = (hex) => new THREE.Color(hex); // stored linear (ColorManagement converts from sRGB hex)

// Shared uniform objects: every patched program references these, so one write retunes all.
export const TOON = {
  uSunRad: { value: new THREE.Color(1, 1, 1) },     // sun colour * intensity (linear), set per render
  uToonShade: { value: col(0xccb0a8) },             // multiplier in shadow: warm, nudged towards mauve, not too dark
  uToonLit: { value: col(0xfff8ec) },               // multiplier when lit
  uToonHi: { value: col(0xfffbe8) },                // multiplier on the brightest, sun-facing band
  uToonUnder: { value: 0.82 },                      // extra shade factor for down-facing surfaces
  uToonBands: { value: new THREE.Vector2(0.22, 0.86) }, // lit thresholds: shade|lit, lit|highlight
};

const FRAG = /* glsl */ `
#ifndef TOON_OFF
{
  vec3 toonRef = material.diffuseColor * RECIPROCAL_PI * uSunRad;
  float toonDen = max(toonRef.r + toonRef.g + toonRef.b, 1e-5);
  vec3 dd = reflectedLight.directDiffuse;
  float lit = (dd.r + dd.g + dd.b) / toonDen;
  vec3 wN = inverseTransformDirection(normal, viewMatrix);
  vec3 shade = uToonShade * mix(uToonUnder, 1.0, smoothstep(-0.6, 0.2, wN.y));
  #ifdef TOON_SOFT
    // terrain: shade, a half-step, lit; thresholds sit away from flat ground's sun angle so
    // gentle bumps never flip a band, and the half-step widens the turn of a hill
    vec3 k = lit < 0.16 ? shade : lit < 0.42 ? mix(shade, uToonLit, 0.55) : uToonLit;
  #else
    vec3 k = lit < uToonBands.x ? shade : lit < uToonBands.y ? uToonLit : uToonHi;
  #endif
  outgoingLight = diffuseColor.rgb * k + totalEmissiveRadiance;
}
#endif
#include <opaque_fragment>
if (uOutlineId >= 0.0) gl_FragColor.a = uOutlineId;`;

// Outline ids. Opaque surfaces write an integer id into the (otherwise unused) alpha of the
// pipeline's half-float target; the outline pass draws a line where ids change, so a boulder
// gets its silhouette against the ground it is half buried in even with no depth step there.
// 0 = matches anything (tufts), 1 = ground, 2 = gameplay rocks, others: one per material.
// Transparent materials keep their real alpha (-1 here) and blend into non-integer ids that the
// outline pass ignores.
export const OUTLINE_ID = { ANY: 0, GROUND: 1, ROCK: 2 };
const outlineId = (m) => (m.transparent ? -1 : m.userData.outlineId ?? 3 + (m.id % 2000));

// Patch one compiled shader of `material` (used by the prototype hook, and by materials that
// add their own onBeforeCompile on top, like the terrain).
export function toonPatch(shader, material) {
  Object.assign(shader.uniforms, TOON);
  shader.uniforms.uOutlineId = { value: outlineId(material) }; // per material
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 uSunRad, uToonShade, uToonLit, uToonHi;\nuniform float uToonUnder, uOutlineId;\nuniform vec2 uToonBands;')
    .replace('#include <opaque_fragment>', FRAG);
}

// Pixel detail for untextured, vertex-coloured props (the procedural trees, bushes, logs, stones,
// fences of src/art): their flat colours are modulated by the luminance of a ground tile,
// box-projected in world space at 32 px/m (instancing aware), so they carry the same hand-pixelled
// texture density as everything else. Leafy (green) colours take the grass tile, the rest the
// boulder tile. Opt in with material.userData.pixelDetail = true; the shared dressing materials are
// recognised by name. Textured (glTF) materials never get it: their own pixels are the art.
function wantsDetail(m) {
  return !m.map && (m.userData.pixelDetail === true || (m.userData.pixelDetail !== false && m.name === 'dressing_solid'));
}
function detailPatch(shader) {
  shader.uniforms.uGround = { value: groundTextureArray() };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vDPos;\nvarying vec3 vDNrm;')
    .replace('#include <project_vertex>', `#include <project_vertex>
      {
        vec4 dp = vec4(transformed, 1.0); vec3 dn = objectNormal;
        #ifdef USE_INSTANCING
          dp = instanceMatrix * dp; dn = mat3(instanceMatrix) * dn;
        #endif
        vDPos = (modelMatrix * dp).xyz; vDNrm = mat3(modelMatrix) * dn;
      }`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
varying vec3 vDPos;
varying vec3 vDNrm;
${GROUND_GLSL}`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      {
        vec3 an = abs(vDNrm);
        vec2 p = an.y > max(an.x, an.z) ? vDPos.xz : an.x > an.z ? vDPos.zy : vDPos.xy;
        float layer = diffuseColor.g > diffuseColor.r * 1.15 ? 0.0 : ${LAYER_BOULDER.toFixed(1)};
        const vec3 LUM = vec3(0.3, 0.59, 0.11);
        float k = dot(groundTex(p, layer), LUM) / max(dot(textureLod(uGround, vec3(p / 4.0, layer), 7.0).rgb, LUM), 1e-3);
        diffuseColor.rgb *= clamp(mix(1.0, k, 0.85), 0.5, 1.5);
      }`);
}

let installed = false;
export function installToon() {
  if (installed) return;
  installed = true;
  const proto = THREE.MeshStandardMaterial.prototype;
  proto.onBeforeCompile = function (shader) { toonPatch(shader, this); if (wantsDetail(this)) detailPatch(shader); };
  proto.customProgramCacheKey = function () { return wantsDetail(this) ? 'toon+detail' : 'toon'; };
}

// Call before rendering a scene lit by `sun` (a DirectionalLight).
export function setToonSun(sun) {
  if (sun) TOON.uSunRad.value.copy(sun.color).multiplyScalar(sun.intensity);
}
