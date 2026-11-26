// LowRange loading / title screen.
// A BeamNG-style showcase: one vehicle posed on simple blocks with its suspension flexed, rendered in Blender
// (art/blender/loading_screen.blend -> public/loading/<id>.png, 480x270) and integer-scaled with hard pixels.
// The body gently bobs on its springs (an 8-frame strip, <id>_settle.png). Usage:
//   const loader = createLoadingScreen();
//   loader.setStage('Grading the trails');   // marks earlier stages done
//   loader.setProgress(0.3);                 // optional finer progress inside a stage
//   await loader.finish();                   // waits for "press any key", then dissolves away
// Pick a shot with ?shot=lc70|taco|wrx (otherwise random per launch).
import { drawText, eachPixel, measure, wrap, FONT_H } from './pixelfont.js';
import './loading.css';

export const STAGES = [
  { label: 'Waking the physics', to: 0.2 },
  { label: 'Grading the trails', to: 0.45 },
  { label: 'Planting trees', to: 0.7 },
  { label: 'Fuelling up', to: 1 },
];

const TIPS = [
  'Air down with T for grip on rock.',
  'Lock the diffs before the ledge, not on it.',
  '4-Low, first gear, feather the throttle.',
  'Backspace repairs you where you stand.',
  'Scroll the mouse wheel to shift.',
  'Hold Shift for a gentle crawl throttle.',
  'Put the tyres on the rocks, not between them.',
  'Climb straight. Sideways is how rigs roll.',
  'Stalled? Tap I to fire the engine back up.',
];

// the rendered shots (see art/blender/README.md)
const SHOTS = { lc70: 'Cruiser 76', taco: 'Trail Pickup', wrx: 'Rally Sedan' };
const ART_W = 480, ART_H = 270, FRAMES = 8, FPS = 5;
const EDGE_COLS = 48, EDGE_ROWS = 40;   // clean backdrop strips used to extend the art past its edges
// [gfx comfort] the rendered shots were made with the first, brighter ground palette: a per-pixel
// colour grade (no blur) brings them in line with the in-game Soft look (gfx/toon.js uWorldGrade)
const ART_GRADE = 'saturate(0.86) brightness(0.95) contrast(0.96)';

// ---------------------------------------------------------------- palette
const C = {
  b0: '#2b1910', b1: '#55321e', b2: '#7d4b27', b3: '#a86c38', b4: '#cf9757',
  r0: '#463e3b', r3: '#cdc1aa', white: '#fff3da', red: '#df4f3b',
  paint: '#f8e8b8', paintShade: '#dfae5e', gold: '#ffd866', ink: '#2a1a14',
  track: '#9a5f24', fill: '#f6eed8', fillLit: '#fffaf0', fillShade: '#c9bd9c',
};

// ---------------------------------------------------------------- helpers
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
function hash(x, y, s = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// ping-pong fold of v into [0, n): mirrored tiling, so extended edges have no seams
const fold = (v, n) => { const p = ((v % (2 * n)) + 2 * n) % (2 * n); return p < n ? p : 2 * n - 1 - p; };

// wooden plank with a seam, grain, knots and nails (drawn straight onto the context)
function plank(ctx, x, y, w, h) {
  const px = (i, j, c) => { ctx.fillStyle = c; ctx.fillRect(x + i, y + j, 1, 1); };
  ctx.fillStyle = C.b0; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  const seam = Math.floor(h / 2);
  for (let j = 0; j < h; j++) {
    let row = C.b2;
    if (j === 0 || j === seam + 1) row = C.b3; else if (j === seam) row = C.b0; else if (j === h - 1 || j === seam - 1) row = C.b1;
    ctx.fillStyle = row; ctx.fillRect(x, y + j, w, 1);
    if (row !== C.b2) continue;
    for (let i = 0; i < w; i++) {
      if (hash(i >> 3, j, 11) > 0.8 && hash(i, j, 12) > 0.3) px(i, j, C.b1);
      else if (hash(i >> 2, j, 13) > 0.9) px(i, j, C.b3);
    }
  }
  for (const [kx, ky] of [[Math.floor(w * 0.18), Math.floor(h * 0.7)], [Math.floor(w * 0.83), Math.floor(h * 0.25)]]) { px(kx, ky, C.b1); px(kx + 1, ky, C.b0); px(kx, ky + 1, C.b1); }
  for (const [nx, ny] of [[3, 2], [w - 4, 2], [3, h - 3], [w - 4, h - 3]]) { px(nx, ny, C.r3); px(nx + 1, ny + 1, C.r0); }
}

function rope(ctx, x, y0, y1) {
  for (let y = y0; y <= y1; y++) {
    const a = (y >> 1) & 1;
    ctx.fillStyle = C.b0; ctx.fillRect(x - 1, y, 4, 1);
    ctx.fillStyle = a ? C.b4 : C.b2; ctx.fillRect(x, y, 1, 1);
    ctx.fillStyle = a ? C.b2 : C.b4; ctx.fillRect(x + 1, y, 1, 1);
  }
}

// ---------------------------------------------------------------- the screen
export function createLoadingScreen({ title = 'LowRange' } = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const root = document.createElement('div');
  root.id = 'lr-load';
  root.setAttribute('role', 'progressbar');
  root.setAttribute('aria-valuemin', '0'); root.setAttribute('aria-valuemax', '100');
  const sr = document.createElement('div'); sr.className = 'sr'; sr.setAttribute('aria-live', 'polite');
  const cv = document.createElement('canvas');
  root.append(cv, sr);
  document.body.appendChild(root);
  const ctx = cv.getContext('2d');

  // ------------------------------------------------ the art
  const ids = Object.keys(SHOTS);
  const asked = new URLSearchParams(location.search).get('shot');
  const shot = ids.includes(asked) ? asked : ids[Math.floor(Math.random() * ids.length)];
  const base = import.meta.env.BASE_URL || '/';
  const still = new Image(), strip = new Image();
  let stillOk = false, stripOk = false;
  still.onload = () => { stillOk = true; build(); if (!reduced) strip.src = `${base}loading/${shot}_settle.png`; };
  strip.onload = () => { stripOk = true; };
  still.src = `${base}loading/${shot}.png`;

  let W = 0, H = 0, L = null; // logical size + layout
  const st = {
    stage: 0, from: 0, target: 0, stageT: 0, shown: 0, done: false, ready: false, failed: null,
    tip: Math.floor(Math.random() * TIPS.length), tipT: 0, t: 0, dissolve: -1,
  };

  // ------------------------------------------------ layout + static bake
  function build() {
    const dpr = devicePixelRatio || 1, vw = innerWidth * dpr, vh = innerHeight * dpr;
    // integer scale that covers the screen best: small crops or small margins, never blurry
    const s = Math.max(1, Math.round(Math.max(vw / ART_W, vh / ART_H)));
    W = Math.ceil(vw / s); H = Math.ceil(vh / s);
    cv.width = W; cv.height = H;
    cv.style.width = `${(W * s) / dpr}px`; cv.style.height = `${(H * s) / dpr}px`;
    cv.style.left = `${Math.floor((vw - W * s) / 2) / dpr}px`; cv.style.top = `${Math.floor((vh - H * s) / 2) / dpr}px`;
    ctx.imageSmoothingEnabled = false;
    const ox = Math.floor((W - ART_W) / 2), oy = Math.floor((H - ART_H) / 2);

    // backdrop: the still, extended past its edges by mirroring clean strips of the cyclorama
    let bg = null;
    if (stillOk) {
      const src = document.createElement('canvas'); src.width = ART_W; src.height = ART_H;
      const sctx = src.getContext('2d'); sctx.drawImage(still, 0, 0);
      const sp = new Uint32Array(sctx.getImageData(0, 0, ART_W, ART_H).data.buffer);
      bg = document.createElement('canvas'); bg.width = W; bg.height = H;
      const g = bg.getContext('2d'), img = g.createImageData(W, H), dp = new Uint32Array(img.data.buffer);
      for (let y = 0; y < H; y++) {
        const ay = y - oy, below = ay >= ART_H, sy = ay < 0 ? 0 : below ? ART_H - EDGE_ROWS + fold(ay - ART_H, EDGE_ROWS) : ay;
        for (let x = 0; x < W; x++) {
          // below the art, take the floor from the clean left strip too (props can reach the bottom rows)
          const ax = x - ox, sx = ax < 0 ? fold(-ax - 1, EDGE_COLS) : ax >= ART_W || below ? fold(ax - ART_W, EDGE_COLS) : ax;
          dp[y * W + x] = sp[sy * ART_W + sx];
        }
      }
      g.putImageData(img, 0, 0);
    }

    // title plank hanging from the top-left
    const ts = 3, tw = measure(title) * ts, pw = tw + 26, ph = FONT_H * ts + 12;
    const tx0 = Math.max(8, Math.round(W * 0.03)), ty0 = Math.max(6, Math.round(H * 0.035));
    const sign = document.createElement('canvas'); sign.width = pw + 4; sign.height = ty0 + ph + 4;
    const sg = sign.getContext('2d');
    rope(sg, 16, 0, ty0); rope(sg, pw - 18, 0, ty0);
    plank(sg, 1, ty0, pw, ph);
    const lx = 14, ly = ty0 + 5, lit = new Set();
    eachPixel(title, 0, 0, 1, (x, y) => lit.add(x + ',' + y));
    sg.fillStyle = C.b0;
    eachPixel(title, lx, ly, ts, (x, y) => sg.fillRect(x - 1, y - 1, ts + 2, ts + 2));   // carved edge
    eachPixel(title, lx, ly, ts, (x, y) => sg.fillRect(x + 1, y + 2, ts, ts));           // carved shadow
    eachPixel(title, 0, 0, 1, (gx, gy) => {
      const x = lx + gx * ts, y = ly + gy * ts;
      sg.fillStyle = C.paint; sg.fillRect(x, y, ts, ts);
      if (!lit.has(gx + ',' + (gy + 1))) { sg.fillStyle = C.paintShade; sg.fillRect(x, y + ts - 1, ts, 1); }
      if (!lit.has(gx + ',' + (gy - 1)) && hash(gx, gy, 8) > 0.5) { sg.fillStyle = C.white; sg.fillRect(x + 1, y, 1, 1); }
    });

    const barW = clamp(Math.round(W * 0.34), 110, 190);
    L = { ox, oy, bg, sign, signX: tx0 - 1, signBottom: ty0 + ph, caption: String(SHOTS[shot] ?? ''),
      px: tx0, barY: H - Math.max(16, Math.round(H * 0.07)), barW };
  }

  // ------------------------------------------------ live drawing
  const text = (s, x, y, color = C.paint, scale = 1) => drawText(ctx, s, x, y, color, { scale, outline: C.ink });

  function drawProgress() {
    const { px, barY, barW } = L;
    if (st.ready && !st.failed) {
      if (st.dissolve < 0 && (reduced || (st.t * 1.4) % 1 < 0.7)) text(coarse ? 'Tap to start' : 'Press any key', px, barY - 10, C.paint, 2);
      return;
    }
    // stage label with live dots
    const cur = STAGES[Math.min(st.stage, STAGES.length - 1)];
    let label = st.failed ? 'Stuck!' : cur.label;
    if (!st.failed) label += '.'.repeat(reduced ? 3 : 1 + (Math.floor(st.t * 3) % 3));
    text(label, px, barY - 13, st.failed ? C.red : C.paint);
    const pct = `${Math.round(st.shown * 100)}%`;
    text(pct, px + barW - measure(pct), barY - 13, C.gold);
    // the bar: dark frame, sunken track, cream fill with a lit top row
    const h = 5, fw = Math.round((barW - 2) * st.shown);
    ctx.fillStyle = C.ink; ctx.fillRect(px - 1, barY - 1, barW + 2, h + 2);
    ctx.fillStyle = C.track; ctx.fillRect(px, barY, barW, h);
    ctx.fillStyle = C.b1; ctx.fillRect(px, barY, barW, 1);
    if (fw > 0) {
      ctx.fillStyle = C.fill; ctx.fillRect(px + 1, barY + 1, fw, h - 2);
      ctx.fillStyle = C.fillLit; ctx.fillRect(px + 1, barY + 1, fw, 1);
      ctx.fillStyle = C.fillShade; ctx.fillRect(px + 1, barY + h - 2, fw, 1);
    }
    // stage notches
    for (const s of STAGES.slice(0, -1)) { ctx.fillStyle = C.ink; ctx.fillRect(px + Math.round(s.to * barW), barY + h - 1, 1, 2); }
  }

  function drawTip() {
    const maxW = clamp(Math.round(W * 0.36), 120, 200), right = W - L.px;
    const head = st.failed ? 'Something broke' : 'Trail tip';
    const y0 = Math.max(6, Math.round(H * 0.035)) + 2;
    text(head, right - measure(head), y0, st.failed ? C.red : C.gold);
    const msg = st.failed || TIPS[st.tip];
    let lines = wrap(msg, maxW);
    for (let w = maxW - 4; w > maxW * 0.5; w -= 4) { const t = wrap(msg, w); if (t.length > lines.length) break; lines = t; }  // even out ragged lines
    lines = lines.slice(0, st.failed ? 4 : 2);
    const reveal = reduced ? 1 : clamp(st.tipT / 0.35, 0, 1);
    ctx.save(); ctx.beginPath(); ctx.rect(right - maxW - 2, y0 + 10, maxW + 4, 12 * lines.length + 2); ctx.clip();
    ctx.globalAlpha = reveal;
    lines.forEach((ln, i) => text(ln, right - measure(ln), y0 + 12 + i * 11));
    ctx.restore();
  }

  let last = performance.now(), raf = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    st.t += dt; st.tipT += dt; st.stageT += dt;
    if (st.tipT > 6 && !st.failed) { st.tipT = 0; st.tip = (st.tip + 1) % TIPS.length; }
    // creep forward inside a stage so the bar keeps moving during long async waits, never past the stage end
    const stageEnd = STAGES[Math.min(st.stage, STAGES.length - 1)].to;
    const goal = st.done ? 1 : Math.max(st.target, lerp(st.from, stageEnd - 0.03, 1 - Math.exp(-st.stageT / 2.5)));
    st.shown = Math.min(goal, st.shown + dt * (0.22 + 1.6 * Math.max(0, goal - st.shown)));
    if (st.done && st.shown >= 0.999 && !st.ready) becomeReady();

    if (L.bg) {
      ctx.filter = ART_GRADE; // [gfx comfort]
      ctx.drawImage(L.bg, 0, 0);
      if (stripOk && !reduced) {
        const f = Math.floor(st.t * FPS) % FRAMES;
        ctx.drawImage(strip, f * ART_W, 0, ART_W, ART_H, L.ox, L.oy, ART_W, ART_H);
      }
      ctx.filter = 'none';
    } else { ctx.fillStyle = '#e2c085'; ctx.fillRect(0, 0, W, H); }
    ctx.drawImage(L.sign, L.signX, 0);
    text(L.caption, L.px + 2, L.signBottom + 6, C.paint);
    drawTip();
    drawProgress();
    if (st.dissolve >= 0) dissolveStep(dt);
    if (root.isConnected) raf = requestAnimationFrame(frame);
  }

  // ------------------------------------------------ finish: gate + transition
  let resolveFinish = null;
  const finished = new Promise((r) => { resolveFinish = r; });
  // automated browsers (tests) skip the gate unless the URL has ?loader
  const skipGate = navigator.webdriver && !/[?&]loader\b/.test(location.search);

  function becomeReady() {
    st.ready = true;
    sr.textContent = coarse ? 'Loaded. Tap to start.' : 'Loaded. Press any key to start.';
    root.setAttribute('aria-valuenow', '100');
    root.classList.add('ready');
  }
  function start() { if (st.ready && st.dissolve < 0) { st.dissolve = 0; root.style.background = 'transparent'; } }
  function onKey(e) {
    if (!root.isConnected) return;
    // swallow input while the screen is up so the menu underneath doesn't react
    e.stopImmediatePropagation();
    if (e.type === 'keydown') { if (e.key !== 'Tab') e.preventDefault(); if (!e.repeat) start(); }
  }
  addEventListener('keydown', onKey, true);
  addEventListener('keyup', onKey, true);
  root.addEventListener('pointerdown', start);

  // ordered pixel dissolve in 4x4 blocks, or a short fade when reduced motion is on
  const DUR = reduced ? 0.25 : 0.7;
  function dissolveStep(dt) {
    st.dissolve += dt;
    const k = st.dissolve / DUR;
    if (k >= 1) { close(); return; }
    if (reduced) { root.style.opacity = String(1 - k); return; }
    ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = '#000';
    const B = 4;
    for (let by = 0; by < H / B; by++) for (let bx = 0; bx < W / B; bx++) {
      const t = 0.55 * bayer(bx, by) + 0.45 * hash(bx, by, 21);
      if (t < k) ctx.fillRect(bx * B, by * B, B, B);
    }
    ctx.restore();
  }
  function close() {
    cancelAnimationFrame(raf);
    removeEventListener('keydown', onKey, true);
    removeEventListener('keyup', onKey, true);
    removeEventListener('resize', build);
    root.remove();
    resolveFinish();
  }

  addEventListener('resize', build);
  build();
  raf = requestAnimationFrame(frame);

  function setStage(label) {
    const i = STAGES.findIndex((s) => s.label === label);
    if (i < 0 || i < st.stage) return;
    if (i > st.stage) { st.stage = i; st.from = i ? STAGES[i - 1].to : 0; st.stageT = 0; st.target = Math.max(st.target, st.from); }
    sr.textContent = `${label}…`;
    root.setAttribute('aria-valuenow', String(Math.round(st.target * 100)));
  }
  return {
    setStage,
    setProgress(f) { st.target = Math.max(st.target, clamp(f, 0, 1)); },
    fail(err) { st.failed = String(err && err.message || err).slice(0, 120); st.tipT = 0; },
    // marks everything loaded; resolves once the player has pressed a key and the screen has dissolved
    finish() { st.done = true; st.stage = STAGES.length; st.target = 1; if (skipGate) close(); return finished; },
  };
}
