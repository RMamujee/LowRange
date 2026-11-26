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
import { GROUND_GLSL, groundUniforms, LAYER_BOULDER, TEX_BIAS } from './pixeltex.js';
import { FOG_MAX } from './palette.js';

const col = (hex) => new THREE.Color(hex); // stored linear (ColorManagement converts from sRGB hex)

// Shared uniform objects: every patched program references these, so one write retunes all.
export const TOON = {
  uSunRad: { value: new THREE.Color(1, 1, 1) },     // sun colour * intensity (linear), set per render
  uToonShade: { value: col(0xc0a29e) },             // multiplier in shadow: warm, nudged towards mauve; deep enough that forms and cast shadows read
  uToonLit: { value: col(0xfff8ec) },               // multiplier when lit
  uToonHi: { value: col(0xfffbe8) },                // multiplier on the brightest, sun-facing band
  uToonUnder: { value: 0.82 },                      // extra shade factor for down-facing surfaces
  uToonBands: { value: new THREE.Vector2(0.22, 0.86) }, // lit thresholds: shade|lit, lit|highlight
  uFogMax: { value: FOG_MAX },                      // fog never takes more than this share of a surface
  uFogDesat: { value: 0.35 },                       // far surfaces lose this share of their saturation (atmospheric perspective)
  // World grade (comfort): the big world surfaces (ground, rocks, trees, props: materials marked
  // userData.world, see markWorld) sit back a step in saturation and value, so the vehicles, lamps
  // and flowers, which are not marked, stay the most saturated things on screen.
  uWorldGrade: { value: new THREE.Vector2(0.96, 0.98) }, // saturation, value
  uTexCalm: { value: new THREE.Vector2(0.12, 0.3) },      // world prop texture contrast cut: near, extra far
};

const FRAG = /* glsl */ `
#ifndef TOON_OFF
{
  #ifdef TOON_WORLD
    diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), diffuseColor.rgb, uWorldGrade.x) * uWorldGrade.y;
  #endif
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
// fog as light aerial perspective: capped, so far hills lean towards the haze but keep their colour
const FOG_FRAG = /* glsl */ `
#ifdef USE_FOG
{
  float fogF = smoothstep(fogNear, fogFar, vFogDepth);
  // colour first drains towards grey with distance, then leans towards the haze (capped)
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722))), fogF * uFogDesat);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogF * uFogMax);
}
#endif`;

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
  if (material.userData.fade) fadePatch(shader, material.userData.fade);
  if (material.userData.world) {
    shader.fragmentShader = '#define TOON_WORLD\n' + shader.fragmentShader;
    // calmer textures on world props (canopies, bushes, stones): each texel keeps its own crisp
    // pixel but moves part way towards the average of its neighbourhood (a coarser mip), so the
    // hand-pixelled pattern stays while its speckle contrast drops; a little more with distance
    // (uTexBias: at Sharp 1x the textures keep the Fine 2x texel density, pixeltex.js TEX_BIAS)
    if (material.map) {
      shader.uniforms.uTexBias = TEX_BIAS;
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTexBias;').replace('#include <map_fragment>', /* glsl */ `
      #ifdef USE_MAP
      {
        vec4 sdc = texture(map, vMapUv, uTexBias);
        vec3 avg = texture(map, vMapUv, 2.5 + uTexBias).rgb;
        float calm = uTexCalm.x + uTexCalm.y * smoothstep(15.0, 80.0, -vViewPosition.z);
        sdc.rgb = mix(sdc.rgb, avg, calm);
        diffuseColor *= sdc;
      }
      #endif`);
    }
  }
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 uSunRad, uToonShade, uToonLit, uToonHi;\nuniform float uToonUnder, uOutlineId, uFogMax, uFogDesat;\nuniform vec2 uToonBands, uWorldGrade, uTexCalm;')
    .replace('#include <opaque_fragment>', FRAG)
    .replace('#include <fog_fragment>', FOG_FRAG);
}

// Distance thinning for small instanced scatter (grass tufts, flowers, pebbles): material.userData
// .fade = [near, far]. Each instance disappears at its own distance between near and far (hashed
// from its position, fixed in the world), so a field of tufts thins out gradually instead of
// turning into one-pixel speckle that crawls as the camera moves.
function fadePatch(shader, [near, far]) {
  shader.uniforms.uFade = { value: new THREE.Vector2(near, far) };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform vec2 uFade;')
    .replace('#include <project_vertex>', `#include <project_vertex>
      #ifdef USE_INSTANCING
      {
        vec3 io = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float h = fract(sin(dot(floor(io.xz * 4.0), vec2(12.9898, 78.233))) * 43758.5453);
        if (distance(io, cameraPosition) > mix(uFade.x, uFade.y, h)) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }
      #endif`);
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
  Object.assign(shader.uniforms, groundUniforms());
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
        float k = dot(groundTex(p, layer), LUM) / max(dot(groundFlat(layer), LUM), 1e-3);
        diffuseColor.rgb *= clamp(mix(1.0, k, 0.55), 0.7, 1.3); // (comfort: softer than the ground's own marks)
      }`);
}

// Crisp texels: textures sampled with a blend between two mip levels (NearestMipmapLinear, the
// glTF loader's setting) mix neighbouring texel colours into soft in-between tones whenever a
// texture is a little minified, which at this resolution is most of the time. Pick one mip
// (NearestMipmapNearest): every screen pixel is then one real texel colour. Runs once per
// material, the first time it is drawn (three asks every material for its program key then).
const CRISP = ['map', 'emissiveMap'];
function crispMaps(m) {
  for (const k of CRISP) {
    const t = m[k];
    if (t && t.minFilter === THREE.NearestMipmapLinearFilter) { t.minFilter = THREE.NearestMipmapNearestFilter; t.needsUpdate = true; }
    if (t && (t.minFilter === THREE.LinearMipmapLinearFilter || t.minFilter === THREE.LinearFilter) && t.userData.crisp !== false) {
      t.minFilter = THREE.NearestMipmapNearestFilter; t.magFilter = THREE.NearestFilter; t.anisotropy = 1; t.needsUpdate = true;
    }
  }
}

let installed = false;
export function installToon() {
  if (installed) return;
  installed = true;
  const proto = THREE.MeshStandardMaterial.prototype;
  proto.onBeforeCompile = function (shader) { toonPatch(shader, this); if (wantsDetail(this)) detailPatch(shader); };
  proto.customProgramCacheKey = function () {
    crispMaps(this);
    return (wantsDetail(this) ? 'toon+detail' : 'toon') + (this.userData.fade ? '+fade' : '') + (this.userData.world ? '+world' : '');
  };
}

// Mark every standard material under `root` as world (graded back, TOON.uWorldGrade). Materials
// left unmarked (vehicles, lamps, the garage preview) keep their full colour; objects whose name,
// or whose parent's name, matches `keep` (flowers) are skipped so the small accents stay bright.
export function markWorld(root, keep = /flower/i) {
  root.traverse((o) => {
    if (!o.material || keep.test(o.name || '') || (o.parent && keep.test(o.parent.name || ''))) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m.isMeshStandardMaterial && !m.userData.world) { m.userData.world = true; m.needsUpdate = true; }
    }
  });
}

// Call before rendering a scene lit by `sun` (a DirectionalLight).
export function setToonSun(sun) {
  if (sun) TOON.uSunRad.value.copy(sun.color).multiplyScalar(sun.intensity);
}
