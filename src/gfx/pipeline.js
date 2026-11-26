// The pixel-art frame: render the 3D scene into a low-resolution target (settings Pixel size:
// device pixels per game pixel on a 1080-tall screen), find silhouettes from its depth, and blow
// it up to the canvas's exact device pixels with hard, integer-sized, uniform pixels. The HUD is
// DOM on top, so it stays crisp at native resolution.
//
//   const px = new PixelPipeline(renderer, { pixelHeight: 320, sky: SKY_BANDS });  // sky optional
//   px.setPixelSize(2);                        // or keep the pixelHeight target
//   px.setSize(innerWidth, innerHeight);       // on resize
//   px.render(scene, camera, sun);             // instead of renderer.render
//
// Outlines: a pixel is outlined when it sits on the near side of a depth break. The test is
// a planarity check on 1/z (which is linear across any flat surface in screen space), so ground
// seen at a grazing angle never outlines itself while every silhouette does, one internal pixel
// thick (two close to the camera when game pixels are fine). Outlines darken the object's own colour towards the warm outline brown (so thin
// rails and bars read as dark wood rather than black blobs) and fade out with the fog.
// Objects marked with noOutline() (grass tufts, particles) don't write depth and draw after the
// rest of the opaque scene, so they never get outlined and never outline what's behind them.
import * as THREE from 'three';
import { OUTLINE, SKY_BANDS } from './palette.js';
import { installToon, setToonSun, OUTLINE_ID } from './toon.js';
import { TEX_BIAS } from './pixeltex.js';

export const NO_OUTLINE_ORDER = 10; // renderOrder for noOutline() objects: after other opaques
// outline colour: surface colour x LINE[0], LINE[1] of the way to the outline brown, LINE[2] strength
// (was 0.3 / 0.7 / 1: a near-black line on everything, the main source of edge density)
export const LINE = [0.38, 0.5, 1.0];

// Display grade shared by every pipeline (game and garage preview), set by settings.js (COMFORT
// presets and the Brightness / Contrast / Saturation sliders): see the end of FRAG.
const GRADE = { brightness: 1, contrast: 1, saturation: 1, knee: 1, lift: 0, vignette: 0 };
export function setDisplayGrade(g) { Object.assign(GRADE, g); }

const VERT = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform highp sampler2D tDepth;
uniform vec2 uSize;       // internal resolution
uniform vec2 uNearFar;
uniform vec2 uFog;        // fog near, far (view distance)
uniform vec3 uOutline;
uniform float uEdge;      // outline threshold (relative 1/z error); <= 0 disables outlines
uniform vec2 uThick;     // closer than x (m), outlines are two pixels thick (0: never); y: strength of that inner pixel
uniform vec3 uLine;       // outline: own-colour factor, share of outline brown, strength
uniform vec3 uGrade;      // display grade: brightness (gain), contrast, saturation
uniform vec3 uKnee;       // shoulder knee (1 = off), black lift, vignette strength
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
    bool edge2 = false;
    if (edge < 0.5 && dist < uThick.x) {
      edge2 = true;
      // near the camera at fine pixel sizes: a second pixel of line inside the silhouette, so the
      // truck and close props keep the bold outline of the Blender previews (the same tests two
      // pixels out; a little stricter, as curved surfaces drift further from flat over two pixels)
      float e2 = max(2.0 * w - invZ(ip + ivec2(2, 0)) - invZ(ip + ivec2(-2, 0)), 2.0 * w - invZ(ip + ivec2(0, 2)) - invZ(ip + ivec2(0, -2)));
      edge = max(step(uEdge * 1.5, e2 / w), max(max(idEdge(id, w, ip + ivec2(-2, 0)), idEdge(id, w, ip + ivec2(2, 0))),
                                                  max(idEdge(id, w, ip + ivec2(0, -2)), idEdge(id, w, ip + ivec2(0, 2)))));
    }
    float fogF = smoothstep(uFog.x, uFog.y, dist);
    // fade with distance (far silhouettes are a pixel or two wide and would only flicker); ground
    // against ground (a ridge over the valley behind it) only outlines close by
    float fade = id == 1.0 ? 1.0 - smoothstep(18.0, 55.0, dist) : 1.0 - smoothstep(40.0, 140.0, dist);
    // a feature one pixel thin (rack bar, rail, post, far branch: farther on both opposite sides)
    // is all outline; at this resolution it pops in and out from frame to frame, so it only gets
    // a light darkening and the flicker is a small tone change instead of a dark line blinking
    bool thin = (w > wl * 1.01 && w > wr * 1.01) || (w > wu * 1.01 && w > wd * 1.01);
    // (comfort) a coloured line: the surface's own colour taken well down and nudged towards the
    // warm outline brown, rather than near-black; firm near the camera, lighter on ground ridges,
    // and the second (inner) pixel of the bold near line is half strength so it tapers
    float a = edge * (1.0 - fogF * 0.7) * fade * (thin ? 0.45 : 1.0) * (id == 1.0 ? 0.6 : 1.0) * (edge2 ? uThick.y : 1.0);
    c = mix(c, mix(c * uLine.x, uOutline, uLine.y), a * uLine.z);
  }
  c = sRGBTransferOETF(vec4(c, 1.0)).rgb; // graded and stored display-ready in an 8-bit target
  // comfort grade (settings: Brightness / Contrast / Saturation, Soft / Standard / Vivid):
  // contrast pivots on a mid value so neither end clips; a soft shoulder rolls the brightest
  // values off instead of clipping them; a lift keeps the deepest shades from going inky
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uGrade.z);
  c = (c - 0.45) * uGrade.y + 0.45;
  c *= uGrade.x;
  c = mix(c, 1.0 - (1.0 - uKnee.x) * exp(-(c - uKnee.x) / max(1.0 - uKnee.x, 1e-3)), step(uKnee.x, c)); // soft shoulder above the knee
  c = uKnee.y + c * (1.0 - uKnee.y);
  // vignette: a gentle darkening into the corners keeps the eye on the middle of the frame
  // (r: 0 at the centre, 1 in the corners)
  vec2 asp = vec2(uSize.x / uSize.y, 1.0);
  float r = length(((vec2(ip) + 0.5) / uSize - 0.5) * asp) / (0.5 * length(asp));
  c *= 1.0 - uKnee.z * smoothstep(0.55, 1.0, r);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
// final blit: each internal pixel becomes an exact uScale x uScale block on the canvas
const BLIT = /* glsl */ `
uniform sampler2D tPost;
uniform float uScale;
void main() { gl_FragColor = texelFetch(tPost, ivec2(floor(gl_FragCoord.xy / uScale)), 0); }`;

export class PixelPipeline {
  constructor(renderer, { pixelHeight = 320, pixelSize = 0, outline = true, sky = null } = {}) {
    installToon();
    this.renderer = renderer;
    this.pixelHeight = pixelHeight;
    this.pixelSize = pixelSize; // when set, wins over pixelHeight
    this.outline = outline;
    renderer.toneMapping = THREE.NoToneMapping; // the palette is authored; don't let a curve remap it
    // Exact device pixels: the drawing buffer must match the canvas's on-screen size in device
    // pixels exactly, or the browser resamples the whole frame (bilinear) and every hard pixel
    // edge smears. CSS px * devicePixelRatio is fractional at 110% zoom or 125% Windows scaling,
    // so the size comes from the device-pixel-content-box ResizeObserver where available, and the
    // canvas is marked pixelated so any residual browser scaling stays nearest-neighbour.
    renderer.setPixelRatio(1);
    const cv = renderer.domElement;
    cv.style.imageRendering = 'pixelated';
    this.observed = null; // { cssW, cssH, w, h } from the observer
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver((entries) => {
        const e = entries[entries.length - 1], b = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
        const cssW = e.contentRect.width, cssH = e.contentRect.height, dpr = window.devicePixelRatio || 1;
        if (!cssW || !cssH) return;
        // (device-scale emulation in automation reports CSS pixels here: only trust a value
        // within a pixel or two of css * dpr)
        const ok = b && Math.abs(b.inlineSize - cssW * dpr) <= 2 && Math.abs(b.blockSize - cssH * dpr) <= 2;
        this.observed = { cssW, cssH, w: ok ? b.inlineSize : Math.round(cssW * dpr), h: ok ? b.blockSize : Math.round(cssH * dpr) };
        if (this.cssW) this.setSize(this.cssW, this.cssH, this.updateStyle);
      });
      try { ro.observe(cv, { box: 'device-pixel-content-box' }); } catch { ro.observe(cv); }
    }
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
        uFog: { value: new THREE.Vector2(1e6, 1e6) }, uOutline: { value: new THREE.Color(OUTLINE) }, uEdge: { value: 0.1 }, uThick: { value: new THREE.Vector2() },
        uLine: { value: new THREE.Vector3(...LINE) }, uGrade: { value: new THREE.Vector3(1, 1, 1) }, uKnee: { value: new THREE.Vector3(1, 0, 0) },
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

  // internal height target; the pixel scale is the integer that brings the canvas closest to it
  setPixelHeight(h) { this.pixelHeight = h; this.pixelSize = 0; this.resize(); }
  // pixel size (settings.js PIXEL_SIZES): device pixels per game pixel on a 1080-pixel-tall
  // screen, in proportion on others, so a game pixel is about the same physical size everywhere
  setPixelSize(n) { this.pixelSize = n; this.resize(); }
  resize() { this.setSize(this.cssW || innerWidth, this.cssH || innerHeight, this.updateStyle); }

  setSize(cssW, cssH, updateStyle = true) {
    this.cssW = cssW; this.cssH = cssH; this.updateStyle = updateStyle;
    const r = this.renderer, cv = r.domElement, dpr = window.devicePixelRatio || 1;
    if (updateStyle) { cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px'; }
    // device size: what the observer measured for this CSS size, else the best estimate
    const o = this.observed;
    const exact = o && Math.abs(o.cssW - cssW) < 0.5 && Math.abs(o.cssH - cssH) < 0.5;
    const dw = exact ? o.w : Math.round(cssW * dpr), dh = exact ? o.h : Math.round(cssH * dpr);
    if (cv.width !== dw || cv.height !== dh) r.setSize(dw, dh, false);
    else r.setViewport(0, 0, dw, dh);
    this.scale = this.pixelSize ? Math.max(1, Math.round((dh * this.pixelSize) / 1080)) : Math.max(1, Math.round(dh / this.pixelHeight));
    this.w = Math.ceil(dw / this.scale); this.h = Math.ceil(dh / this.scale);
    // HD at Sharp 1x: the scene is drawn at native resolution, so geometry edges get 4x
    // multisampling (as HD-2D does: silhouettes anti-aliased, textures still crisp nearest-sampled
    // pixel art, since MSAA only resolves coverage at triangle edges). At coarser pixel sizes every
    // pixel stays one hard colour.
    const samples = this.scale === 1 && this.msaa !== false ? 4 : 0;
    if (this.rt.samples !== samples) { this.rt.samples = samples; this.rt.dispose(); }
    this.texBias = Math.max(0, Math.log2(2 / this.scale));
    this.rt.setSize(this.w, this.h);
    this.rtPost.setSize(this.w, this.h);
    this.post.uniforms.uSize.value.set(this.w, this.h);
    this.blit.uniforms.uScale.value = this.scale;
  }

  render(scene, camera, sun) {
    const r = this.renderer;
    if (!this.w) this.setSize(innerWidth, innerHeight);
    applyCull(camera);
    setToonSun(sun);
    TEX_BIAS.value = this.texBias || 0; // (per pipeline: the garage preview has its own scale)
    if (sun && sun.castShadow) snapShadow(sun);
    r.setRenderTarget(this.rt);
    r.render(scene, camera);

    const u = this.post.uniforms;
    u.uNearFar.value.set(camera.near, camera.far);
    u.uProjInv.value.copy(camera.projectionMatrixInverse); u.uCamWorld.value.copy(camera.matrixWorld);
    if (scene.fog && scene.fog.isFog) u.uFog.value.set(scene.fog.near, scene.fog.far); else u.uFog.value.set(1e6, 1e6);
    u.uEdge.value = this.outline ? this.edge ?? 0.1 : 0;
    // bold near outlines only when game pixels are fine (over 400 rows); chunky pixels are bold enough.
    // At HD 1x a one-pixel line is half the width it is at Fine 2x, so the two-pixel line reaches
    // much further out and its inner pixel is firmer: about the same weight of line on screen
    if (this.scale === 1 && this.h > 700) u.uThick.value.set(90, 0.8);
    else u.uThick.value.set(this.h > 400 ? 24 : 0, 0.5);
    u.uGrade.value.set(GRADE.brightness, GRADE.contrast, GRADE.saturation);
    u.uKnee.value.set(GRADE.knee, GRADE.lift, this.vignette ?? GRADE.vignette);
    this.quad.material = this.post;
    r.setRenderTarget(this.rtPost);
    r.render(this.postScene, this.postCam);
    this.quad.material = this.blit;
    r.setRenderTarget(null);
    r.render(this.postScene, this.postCam);
  }
}

// A shadow camera that follows the truck slides its texel grid across the world every frame, so
// shadow edges crawl. Snap the light's target (and the light with it) to whole shadow texels in
// light space: the grid then stays put in the world and edges hold still.
const _sm = new THREE.Matrix4(), _sx = new THREE.Vector3(), _sy = new THREE.Vector3(), _sz = new THREE.Vector3(), _sd = new THREE.Vector3();
function snapShadow(sun) {
  const sc = sun.shadow.camera, t = sun.target.position;
  const texel = (sc.right - sc.left) / sun.shadow.mapSize.x;
  _sd.subVectors(sun.position, t);
  _sm.lookAt(sun.position, t, sun.up).extractBasis(_sx, _sy, _sz);
  const a = t.dot(_sx), b = t.dot(_sy);
  t.addScaledVector(_sx, Math.round(a / texel) * texel - a).addScaledVector(_sy, Math.round(b / texel) * texel - b);
  sun.position.copy(t).add(_sd);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();
}

// Distance culling for chunks of small scatter: an InstancedMesh registered here is skipped while
// every instance in it is farther than `far` from the camera (its instances fade out before that,
// see toon.js fadePatch), so far fields of tufts cost no vertex work at all.
const culled = [];
export function cullBeyond(mesh, far) {
  if (!mesh.boundingSphere) mesh.computeBoundingSphere();
  culled.push([mesh, far]);
}
function applyCull(camera) {
  const p = camera.position;
  for (const [m, far] of culled) m.visible = m.boundingSphere.center.distanceTo(p) - m.boundingSphere.radius < far;
}

// Exclude an object (and its children) from outlines: drawn last among opaques, without depth writes.
export function noOutline(obj) {
  obj.traverse((o) => {
    o.renderOrder = NO_OUTLINE_ORDER;
    if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) { m.depthWrite = false; m.userData.outlineId = OUTLINE_ID.ANY; m.needsUpdate = true; }
  });
}
