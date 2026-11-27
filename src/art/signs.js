// In-world sign faces (trail signposts, gate banners, Gauntlet stage signs, race gantry /
// checkpoint / venue boards), shared by world_view.js, crawl_view.js and race_view.js.
//
// Legibility recipe (see test/signs.mjs for the measurements behind it):
// - Text is the game's pixel bitmap font (src/ui/pixelfont.js, as on the HUD and menus), drawn on
//   a grid of sign pixels: one font pixel of a title = one sign pixel = TEX x TEX texels, every
//   rectangle on a whole number of half sign pixels. Strokes are solid blocks, never anti-aliased
//   smudges, and the first mip levels (box-filtered by the GPU) are exact copies at half, quarter
//   and eighth size, so a letter stays a solid letter until a font pixel is smaller than a screen
//   pixel; past that, trilinear + anisotropic filtering melts it smoothly instead of shimmering.
// - Dark ink on a light parchment panel inset in a wood (or steel / chequer) frame: the contrast
//   survives the toon shade band and the display grade, and a little self-light (emissive = the
//   face itself) keeps a board that faces away from the sun readable.
// - Faces opt out of the world grade (toon.js markWorld: userData.world = false), which would
//   otherwise sample them a mip coarser and blend them towards a blurred copy (texture calm).
// - Few words, big letters: titles are capitals at full size (split over two lines when long),
//   secondary lines at half size, and boards are sized around their text.
import * as THREE from 'three';
import { measure, eachPixel, GLYPHS, SPACE_W, GLYPH_GAP } from '../ui/pixelfont.js';
import { DIFF, heightAt } from '../terrain.js';
import { toonPatch } from '../gfx/toon.js';

export const TEX = 8; // texels per sign pixel

// the HUD / menu palette (src/hud/px.js)
const C = {
  ol: '#2a1a14', w0: '#2b1910', w1: '#55321e', w2: '#7d4b27', w3: '#a86c38',
  paper: '#f4e5b9', paperShade: '#e0c68d', paperEdge: '#b4915a', ink: '#2a1a14', inkSoft: '#6e5034',
  m1: '#24211e', m2: '#33302c', m3: '#4a4640', m4: '#776c64', red: '#d8483a',
};

// title and secondary-line scales (in sign pixels per font pixel)
const T1 = 1, T2 = 0.5;
const CAP = 7, LINE_GAP = 3;

function surface(wS, hS) {
  const cv = document.createElement('canvas'); cv.width = Math.round(wS * TEX); cv.height = Math.round(hS * TEX);
  const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
  return { cv, g, rect: (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x * TEX), Math.round(y * TEX), Math.round(w * TEX), Math.round(h * TEX)); } };
}
// Titles and numbers are drawn bold: every lit font pixel also lights the cell to its right
// unless that would close a one-pixel gap (so M, W, N, counters keep their shape), giving
// two-pixel vertical strokes that stay solid when a font pixel shrinks towards one screen pixel.
// Each glyph gets one column wider (M, N and W two).
const glyphOf = (ch) => GLYPHS[ch] || GLYPHS['?'];
// (hand-made bold capitals where the rule would leave a one-pixel middle stroke that vanishes
// at a distance: W read as N)
const BOLD = {
  M: '##...## ###.### ####### ##.#.## ##...## ##...## ##...##',
  W: '##...## ##...## ##.#.## ##.#.## ####### ###.### ##...##',
  N: '##...## ###..## ####.## ##.#### ##..### ##...## ##...##',
};
function boldRows(ch) {
  if (BOLD[ch]) return [...BOLD[ch].split(' '), ...Array(2).fill('.'.repeat(BOLD[ch].indexOf(' ')))];
  const g = glyphOf(ch);
  return g.rows.map((r) => {
    const out = [...r + '.'];
    for (let c = 0; c < r.length; c++) if (r[c] === '#' && r[c + 1] !== '#' && r[c + 2] !== '#') out[c + 1] = '#';
    return out.join('');
  });
}
function textW(s, scale, bold = false) {
  if (!bold) return measure(s) * scale;
  let w = 0;
  for (const ch of s) w += (ch === ' ' ? SPACE_W : boldRows(ch)[0].length) + GLYPH_GAP;
  return Math.max(0, w - GLYPH_GAP) * scale;
}
function text(S, s, x, y, scale, color, bold = false) {
  S.g.fillStyle = color;
  const k = scale * TEX;
  if (!bold) { eachPixel(s, Math.round(x * TEX), Math.round(y * TEX), k, (px, py) => S.g.fillRect(px, py, k, k)); return; }
  let cx = x;
  for (const ch of s) {
    if (ch === ' ') { cx += (SPACE_W + GLYPH_GAP) * scale; continue; }
    const rows = boldRows(ch);
    rows.forEach((r, ry) => { for (let c = 0; c < r.length; c++) if (r[c] === '#') S.g.fillRect(Math.round((cx + c * scale) * TEX), Math.round((y + ry * scale) * TEX), k, k); });
    cx += (rows[0].length + GLYPH_GAP) * scale;
  }
}

// difficulty symbol on a size x size block of sign pixels, ink outlined
function diffSymbol(S, diff, x0, y0, size) {
  const n = size, inside = (x, y) => {
    const u = (x + 0.5) / n * 2 - 1, v = (y + 0.5) / n * 2 - 1;
    if (diff === 'green') return u * u + v * v <= 0.92;
    if (diff === 'blue') return Math.abs(u) <= 0.82 && Math.abs(v) <= 0.82;
    if (diff === 'black') return Math.abs(u) + Math.abs(v) <= 1.0;
    const a = Math.abs(u * 1.9 + 0.95) + Math.abs(v * 1.2), b = Math.abs(u * 1.9 - 0.95) + Math.abs(v * 1.2); // two diamonds
    return Math.min(a, b) <= 1.0;
  };
  const fill = diff === 'black' || diff === 'dblack' ? '#1c1814' : DIFF[diff].color;
  for (let y = -1; y <= n; y++) for (let x = -1; x <= n; x++) {
    if (inside(x, y)) S.rect(x0 + x, y0 + y, 1, 1, fill);
    else if (inside(x - 1, y) || inside(x + 1, y) || inside(x, y - 1) || inside(x, y + 1)) S.rect(x0 + x, y0 + y, 1, 1, C.ink);
  }
}

// frame + parchment panel; returns the panel's inner rectangle
function frame(S, w, h, style, F) {
  if (style === 'steel') {
    S.rect(0, 0, w, h, C.m1); S.rect(1, 1, w - 2, h - 2, C.m3); S.rect(1, 1, w - 2, 1, C.m4);
  } else if (style === 'check') {
    S.rect(0, 0, w, h, '#111');
    const q = F / 2;
    for (let y = 0; y < h; y += q) for (let x = 0; x < w; x += q) if (((x + y) / q) % 2 === 0) S.rect(x, y, q, q, C.paper);
  } else {
    // wood: dark rim, planks with a lighter grain line and a few knots
    S.rect(0, 0, w, h, C.w0);
    S.rect(1, 1, w - 2, h - 2, C.w2);
    for (let y = 2; y < h - 1; y += 4) S.rect(1, y, w - 2, 0.5, C.w1);
    for (let y = 3; y < h - 1; y += 4) for (let x = 2 + (y % 7); x < w - 2; x += 11) S.rect(x, y, 2, 0.5, C.w3);
  }
  S.rect(F - 0.5, F - 0.5, w - 2 * F + 1, h - 2 * F + 1, style === 'wood' ? C.w0 : C.ol); // panel edge
  S.rect(F, F, w - 2 * F, h - 2 * F, C.paper);
  S.rect(F, F, w - 2 * F, 0.5, C.paperShade); // inset shadow along the top
  return { x: F, y: F, w: w - 2 * F, h: h - 2 * F };
}

// split a title into at most two lines, balanced, when it is wider than maxW sign pixels
function splitTitle(s, maxW) {
  if (textW(s, T1, true) <= maxW || !s.includes(' ')) return [s];
  let best = null;
  const words = s.split(' ');
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const w = Math.max(textW(a, T1, true), textW(b, T1, true));
    if (!best || w < best.w) best = { w, lines: [a, b] };
  }
  return best.lines;
}

// A sign face: title (capitals, one or two lines), optional secondary line, optional difficulty
// symbol and big number on the left.
//   opts: title, sub, diff, num, style ('wood' | 'steel' | 'check'), frame (sign px),
//         maxTitleW (sign px before the title splits), minW / minH (sign px: pad the panel out),
//         align ('left' | 'center'), numScale (smallest number scale, default 2)
// Returns { texture, w, h } with w / h in sign pixels; the caller picks metres per sign pixel.
export function signFace(opts) {
  const { title, sub, diff, num, style = 'wood', maxTitleW = 1e9, minW = 0, minH = 0 } = opts;
  const F = opts.frame ?? 3, PAD = 2;
  const lines = splitTitle(title.toUpperCase(), maxTitleW);
  const titleW = Math.max(...lines.map((l) => textW(l, T1, true)));
  const subW = sub ? textW(sub, T2) : 0;
  const textH = lines.length * CAP + (lines.length - 1) * LINE_GAP + (sub ? LINE_GAP + 4.5 : 0);
  const blockW = Math.max(titleW, subW);
  // left column: big number (as tall as the text block) and / or the difficulty symbol
  const numScale = num !== undefined ? Math.max(opts.numScale || 2, Math.floor(textH / CAP)) : 0;
  const numW = num !== undefined ? textW(String(num), numScale, true) : 0;
  const symSize = diff ? Math.min(11, Math.max(7, Math.floor(textH))) : 0;
  const leftW = numW + (numW && symSize ? 2 : 0) + symSize;
  const contentW = leftW + (leftW ? 3 : 0) + blockW;
  const contentH = Math.max(textH, num !== undefined ? numScale * CAP : 0, symSize);
  const w = Math.max(minW, 2 * F + 2 * PAD + contentW), h = Math.max(minH, 2 * F + 2 * PAD + contentH);
  const S = surface(w, h);
  const P = frame(S, w, h, style, F);
  const x0 = Math.round(P.x + (P.w - contentW) / 2), cy = P.y + P.h / 2;
  let x = x0;
  const ny = Math.round(cy - (numScale * CAP) / 2);
  if (num !== undefined) { text(S, String(num), x, ny, numScale, C.ink, true); x += numW + (symSize ? 2 : 0); }
  if (diff) { diffSymbol(S, diff, x, Math.round(cy - symSize / 2), symSize); x += symSize; }
  if (leftW) x += 3;
  const ty = Math.round(cy - textH / 2);
  const center = opts.align === 'center' || !leftW;
  lines.forEach((l, i) => text(S, l, center ? Math.round(x + (blockW - textW(l, T1, true)) / 2) : x, ty + i * (CAP + LINE_GAP), T1, C.ink, true));
  if (sub) text(S, sub, center ? Math.round((x + (blockW - subW) / 2) * 2) / 2 : x, ty + lines.length * (CAP + LINE_GAP), T2, C.inkSoft);
  // where the first title line (and the number) sit, for test/signs.mjs: cap height and centre
  // as fractions of the texture height, u range
  const texture = signTexture(S.cv, { cap: CAP / h, cy: (ty + CAP / 2) / h, u0: x / w, u1: (x + blockW) / w });
  if (num !== undefined) texture.userData.num = { cap: (numScale * CAP) / h, cy: (ny + (numScale * CAP) / 2) / h, u0: x0 / w, u1: (x0 + numW) / w };
  return { texture, w, h };
}

// signFace sized in metres: m metres per sign pixel (the title's cap height is 7 m), shrunk if
// the face would be wider than maxW, padded out to at least minW (metres).
// Returns { texture, w, h, m } in metres.
export function fitFace(opts, { m, minW = 0, maxW = Infinity }) {
  let f = signFace(opts);
  if (f.w * m > maxW) m = maxW / f.w;
  const padW = Math.ceil(minW / m);
  if (padW > f.w) { f.texture.dispose(); f = signFace({ ...opts, minW: padW }); }
  return { texture: f.texture, w: f.w * m, h: f.h * m, m };
}

// A signpost: a board with the face on its front (local +z), on two posts, the board's bottom
// `lift` metres above the ground at (x, z); the posts run a little into the ground for slopes.
// (shared: one material for every post / core, and one for every board back)
let WOOD = null, PLANK = null;
const wood = () => (WOOD ||= new THREE.MeshStandardMaterial({ color: 0x4a3420, flatShading: true }));
// the board's back: horizontal planks with dark seams (a flat brown panel read as a blank sign)
function plankBack() {
  if (!PLANK) {
    const cv = document.createElement('canvas'); cv.width = 16; cv.height = 12;
    const g = cv.getContext('2d');
    ['#6a4a2c', '#5c3f25', '#664629', '#57391f'].forEach((c, i) => {
      g.fillStyle = c; g.fillRect(0, i * 3, 16, 3);
      g.fillStyle = '#2e1d10'; g.fillRect(0, i * 3 + 2, 16, 1);
      g.fillRect((i * 7 + 3) % 16, i * 3, 1, 2); // a butt joint per plank, staggered
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    PLANK = new THREE.MeshStandardMaterial({ map: tex, flatShading: true });
  }
  return PLANK;
}
export function signpost(x, z, yaw, face, { lift = 1.0 } = {}) {
  const g = new THREE.Group();
  g.position.set(x, heightAt(x, z), z);
  g.rotation.y = yaw;
  const w = wood();
  const top = lift + face.h + 0.12;
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.16, top + 0.5, 0.16), w);
    p.position.set(sx * (face.w / 2 - 0.2), (top - 0.5) / 2, -0.09); p.castShadow = true; g.add(p);
  }
  const board = new THREE.Mesh(new THREE.BoxGeometry(face.w, face.h, 0.1), [w, w, w, w, signMaterial(face.texture), plankBack()]);
  board.position.y = lift + face.h / 2; board.castShadow = true;
  g.add(board);
  g.userData.camBlock = true; // src/cam_clear.js keeps the camera out of it
  return g;
}

// A banner board for a gate: a thin wooden core with the face on both sides (two single-sided
// planes, so each side reads the right way round). Centred on the group's origin.
export function bannerBoard(face, material = signMaterial(face.texture)) {
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.BoxGeometry(face.w, face.h, 0.08), wood());
  core.castShadow = true; g.add(core);
  for (const ry of [0, Math.PI]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(face.w, face.h), material);
    p.rotation.y = ry; p.position.z = ry ? -0.045 : 0.045; g.add(p);
  }
  g.userData.material = material;
  g.userData.camBlock = true; // src/cam_clear.js keeps the camera out of it
  return g;
}

// yaw that turns a face (local +z) towards `dir` (x, z), toed in by `toe` radians towards the
// point (cx, cz) from (x, z): a roadside sign angled a little towards the road
export function faceYaw(dir, x, z, cx, cz, toe = 0) {
  const L = Math.hypot(dir[0], dir[1]) || 1, dx = dir[0] / L, dz = dir[1] / L;
  const ox = cx - x, oz = cz - z, O = Math.hypot(ox, oz) || 1;
  const nx = dx * Math.cos(toe) + (ox / O) * Math.sin(toe), nz = dz * Math.cos(toe) + (oz / O) * Math.sin(toe);
  return Math.atan2(nx, nz);
}

// canvas -> texture with deliberate filtering: linear magnification (a sign pixel is 8 texels, so
// a 1-texel blend at the block edges is invisible), trilinear + anisotropic minification over
// exact box-filtered mips; userData.crisp = false keeps toon.js crispMaps from forcing nearest.
export function signTexture(cv, text) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.userData.crisp = false;
  if (text) t.userData.text = text;
  return t;
}

// sign face material: lit like everything else, plus a little of its own light so a board in the
// shade band stays readable; out of the world grade
// The face is sampled a fraction of a mip level sharper than the GPU would pick (MIP_BIAS): the
// letters are solid blocks several texels wide, so this keeps strokes dark a little further out
// (most useful at the coarse pixel sizes, where every letter is minified one to two levels more)
// without bringing back the shimmer.
export const SIGN_GLOW = 0x8c8c8c;
const MIP_BIAS = -0.6;
export function signMaterial(texture, extra = {}) {
  const m = new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: SIGN_GLOW, roughness: 0.9, ...extra });
  m.userData.world = false;
  m.onBeforeCompile = (shader) => {
    toonPatch(shader, m);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', `#ifdef USE_MAP\n  diffuseColor *= texture(map, vMapUv, ${MIP_BIAS.toFixed(2)});\n#endif`)
      .replace('#include <emissivemap_fragment>', `#ifdef USE_EMISSIVEMAP\n  totalEmissiveRadiance *= texture(emissiveMap, vEmissiveMapUv, ${MIP_BIAS.toFixed(2)}).rgb;\n#endif`);
  };
  m.customProgramCacheKey = () => 'toon+sign';
  return m;
}
