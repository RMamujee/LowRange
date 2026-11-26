// The pixel-art frame: render the 3D scene into a low-resolution target (about 270 to 360 px
// tall), find silhouettes from its depth, and blow it up to the canvas with hard, integer-sized
// pixels. The HUD is DOM on top, so it stays crisp at native resolution.
//
//   const px = new PixelPipeline(renderer, { pixelHeight: 320, sky: SKY_BANDS });  // sky optional
//   px.setSize(innerWidth, innerHeight);       // on resize
//   px.render(scene, camera, sun);             // instead of renderer.render
//
// Outlines: a pixel is outlined when it sits on the near side of a depth break. The test is
// a planarity check on 1/z (which is linear across any flat surface in screen space), so ground
// seen at a grazing angle never outlines itself while every silhouette does, exactly one internal
// pixel thick. Outlines darken the object's own colour towards the warm outline brown (so thin
// rails and bars read as dark wood rather than black blobs) and fade out with the fog.
// Objects marked with noOutline() (grass tufts, particles) don't write depth and draw after the
// rest of the opaque scene, so they never get outlined and never outline what's behind them.
import * as THREE from 'three';
import { OUTLINE, SKY_BANDS } from './palette.js';
import { installToon, setToonSun, OUTLINE_ID } from './toon.js';

export const NO_OUTLINE_ORDER = 10; // renderOrder for noOutline() objects: after other opaques

const VERT = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform highp sampler2D tDepth;
uniform vec2 uSize;       // internal resolution
uniform vec2 uNearFar;
uniform vec2 uFog;        // fog near, far (view distance)
uniform vec3 uOutline;
uniform float uEdge;      // outline threshold (relative 1/z error); <= 0 disables outlines
uniform bool uSkyOn;
uniform vec3 uSky[5];     // stepped sky bands, horizon .. zenith (linear)
uniform mat4 uProjInv, uCamWorld;
const float BAYER[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
ivec2 clampP(ivec2 p) { return clamp(p, ivec2(0), ivec2(uSize) - 1); }
float invZ(ivec2 p) {
  float d = texelFetch(tDepth, clampP(p), 0).r;
  float n = uNearFar.x, f = uNearFar.y;
  return (f - d * (f - n)) / (n * f); // 1 / view-space distance
}
// surface id from the colour target's alpha; -1 when it isn't a clean integer (blended / wildcard)
float idAt(ivec2 p) {
  float a = texelFetch(tColor, clampP(p), 0).a;
  return (abs(a - floor(a + 0.5)) < 0.02 && a > 0.5) ? floor(a + 0.5) : -1.0;
}
// 1 when this pixel is the near side of an id change towards neighbour n
float idEdge(float id, float w, ivec2 n) {
  float idn = idAt(n);
  if (id < 0.0 || idn < 0.0 || idn == id) return 0.0;
  float wn = invZ(n);
  return (w > wn * 1.004 || (abs(w - wn) <= wn * 0.004 && id > idn)) ? 1.0 : 0.0;
}
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec4 src = texelFetch(tColor, ip, 0);
  vec3 c = src.rgb;
  if (uSkyOn && texelFetch(tDepth, ip, 0).r >= 1.0) {
    // sky: golden bands by view elevation, ordered-dither seams on the internal pixel grid
    vec2 ndc = (vec2(ip) + 0.5) / uSize * 2.0 - 1.0;
    vec4 v = uProjInv * vec4(ndc, 1.0, 1.0);
    float el = normalize(mat3(uCamWorld) * (v.xyz / v.w)).y;
    float t = clamp(el / 0.42, 0.0, 1.0) * 4.0;
    float d = (BAYER[(ip.y & 3) * 4 + (ip.x & 3)] + 0.5) / 16.0;
    int i = int(floor(t)); i = fract(t) > d ? i + 1 : i;
    c = uSky[min(i, 4)];
  }
  if (uEdge > 0.0) {
    float w = invZ(ip);
    float wl = invZ(ip + ivec2(-1, 0)), wr = invZ(ip + ivec2(1, 0));
    float wd = invZ(ip + ivec2(0, -1)), wu = invZ(ip + ivec2(0, 1));
    // depth: how much farther the neighbours are than a flat continuation predicts
    // (positive only on the near side of a break, so the outline sits inside the silhouette)
    float e = max(2.0 * w - wr - wl, 2.0 * w - wu - wd);
    float edge = step(uEdge, e / w);
    // surface id changes (a rock on the ground, glass in a door)
    float id = idAt(ip);
    edge = max(edge, max(max(idEdge(id, w, ip + ivec2(-1, 0)), idEdge(id, w, ip + ivec2(1, 0))),
                         max(idEdge(id, w, ip + ivec2(0, -1)), idEdge(id, w, ip + ivec2(0, 1)))));
    float dist = 1.0 / w;
    float fogF = smoothstep(uFog.x, uFog.y, dist);
    float a = edge * (1.0 - fogF) * 0.9;
    c = mix(c, mix(c * 0.35, uOutline, 0.6), a);
  }
  gl_FragColor = sRGBTransferOETF(vec4(c, 1.0)); // stored display-ready in an 8-bit target
}`;
// final blit: each internal pixel becomes an exact uScale x uScale block on the canvas
const BLIT = /* glsl */ `
uniform sampler2D tPost;
uniform float uScale;
void main() { gl_FragColor = texelFetch(tPost, ivec2(floor(gl_FragCoord.xy / uScale)), 0); }`;

export class PixelPipeline {
  constructor(renderer, { pixelHeight = 320, outline = true, maxDpr = 3, sky = null } = {}) {
    installToon();
    this.renderer = renderer;
    this.pixelHeight = pixelHeight;
    this.maxDpr = maxDpr;
    this.outline = outline;
    renderer.toneMapping = THREE.NoToneMapping; // the palette is authored; don't let a curve remap it
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
    this.rt = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: true, generateMipmaps: false,
    });
    this.rt.depthTexture = new THREE.DepthTexture(4, 4, THREE.FloatType);
    // outlines + sky run at the internal resolution into this; the blit only copies pixels
    this.rtPost = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
    this.post = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tColor: { value: this.rt.texture }, tDepth: { value: this.rt.depthTexture },
        uSize: { value: new THREE.Vector2() }, uNearFar: { value: new THREE.Vector2() },
        uFog: { value: new THREE.Vector2(1e6, 1e6) }, uOutline: { value: new THREE.Color(OUTLINE) }, uEdge: { value: 0.1 },
        uSkyOn: { value: !!sky }, uSky: { value: (sky || SKY_BANDS).map((h) => new THREE.Color(h)) },
        uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      },
    });
    this.blit = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLIT, depthTest: false, depthWrite: false,
      uniforms: { tPost: { value: this.rtPost.texture }, uScale: { value: 1 } },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post);
    this.quad.frustumCulled = false;
    this.postScene = new THREE.Scene(); this.postScene.add(this.quad);
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scale = 1; this.w = 0; this.h = 0;
  }

  // internal height target (the settings presets choose it); the pixel scale is the integer
  // that brings the canvas closest to it
  setPixelHeight(h) { this.pixelHeight = h; this.setSize(this.cssW || innerWidth, this.cssH || innerHeight, this.updateStyle); }

  setSize(cssW, cssH, updateStyle = true) {
    this.cssW = cssW; this.cssH = cssH; this.updateStyle = updateStyle;
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.maxDpr));
    r.setSize(cssW, cssH, updateStyle);
    const dw = r.domElement.width, dh = r.domElement.height;
    this.scale = Math.max(1, Math.round(dh / this.pixelHeight));
    this.w = Math.ceil(dw / this.scale); this.h = Math.ceil(dh / this.scale);
    this.rt.setSize(this.w, this.h);
    this.rtPost.setSize(this.w, this.h);
    this.post.uniforms.uSize.value.set(this.w, this.h);
    this.blit.uniforms.uScale.value = this.scale;
  }

  render(scene, camera, sun) {
    const r = this.renderer;
    if (!this.w) this.setSize(innerWidth, innerHeight);
    setToonSun(sun);
    r.setRenderTarget(this.rt);
    r.render(scene, camera);

    const u = this.post.uniforms;
    u.uNearFar.value.set(camera.near, camera.far);
    u.uProjInv.value.copy(camera.projectionMatrixInverse); u.uCamWorld.value.copy(camera.matrixWorld);
    if (scene.fog && scene.fog.isFog) u.uFog.value.set(scene.fog.near, scene.fog.far); else u.uFog.value.set(1e6, 1e6);
    u.uEdge.value = this.outline ? this.edge ?? 0.1 : 0;
    this.quad.material = this.post;
    r.setRenderTarget(this.rtPost);
    r.render(this.postScene, this.postCam);
    this.quad.material = this.blit;
    r.setRenderTarget(null);
    r.render(this.postScene, this.postCam);
  }
}

// Exclude an object (and its children) from outlines: drawn last among opaques, without depth writes.
export function noOutline(obj) {
  obj.traverse((o) => {
    o.renderOrder = NO_OUTLINE_ORDER;
    if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) { m.depthWrite = false; m.userData.outlineId = OUTLINE_ID.ANY; m.needsUpdate = true; }
  });
}
