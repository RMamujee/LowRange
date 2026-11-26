// Settings: graphics preset, pixel size, master volume, fullscreen, FPS counter.
// Self-contained: persists to localStorage, owns a small overlay (F10, or openSettings()),
// and applies itself through initSettings({ renderer, scene, sun, camera, audio, pipeline }).
//
// main.js needs only:
//   import { initSettings } from './settings.js';
//   initSettings({ renderer, scene, sun, camera, audio });   // after those exist

const KEY = 'lowrange.settings.v1';

// fogScale / farScale multiply whatever fog and camera far the scene was built with,
// so retuning the world's look elsewhere doesn't fight these presets.
// pixelRatio is only used when there is no pipeline.
export const PRESETS = {
  low:    { label: 'Low',    pixelRatio: 1.0,  shadowMap: 1024, fogScale: 0.7,  farScale: 0.6 },
  medium: { label: 'Medium', pixelRatio: 1.25, shadowMap: 2048, fogScale: 0.85, farScale: 0.8 },
  high:   { label: 'High',   pixelRatio: 1.75, shadowMap: 2048, fogScale: 1.0,  farScale: 1.0 },
};
// Pixel size of the pixel-art frame (src/gfx/pipeline.js): device pixels per game pixel on a
// 1080-tall screen, scaled in proportion on others. Separate from the quality preset.
export const PIXEL_SIZES = { 4: 'CHUNKY 4x', 3: '3x', 2: 'FINE 2x', 1: 'SHARP 1x' };

const DEFAULTS = { quality: 'high', pixelSize: 2, volume: 0.8, showFps: false };

const desktop = () => (typeof window !== 'undefined' && window.lowrange && window.lowrange.isDesktop) ? window.lowrange : null;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      quality: Object.hasOwn(PRESETS, s.quality) ? s.quality : DEFAULTS.quality,
      pixelSize: Object.hasOwn(PIXEL_SIZES, s.pixelSize) ? +s.pixelSize : DEFAULTS.pixelSize,
      volume: Number.isFinite(s.volume) ? Math.min(1, Math.max(0, s.volume)) : DEFAULTS.volume,
      showFps: typeof s.showFps === 'boolean' ? s.showFps : DEFAULTS.showFps,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const state = load();
const listeners = new Set();
let ctx = null;   // { renderer, scene, sun, camera, audio }
let base = null;  // the scene's own fog/far, captured at init

export function getSettings() { return { ...state }; }

export function setSetting(key, value) {
  if (!(key in DEFAULTS)) return;
  if (key === 'quality' && !Object.hasOwn(PRESETS, value)) return;
  if (key === 'pixelSize') { if (!Object.hasOwn(PIXEL_SIZES, value)) return; value = +value; }
  if (key === 'volume') value = Math.min(1, Math.max(0, Number(value) || 0));
  if (key === 'showFps') value = !!value;
  state[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage full/blocked: keep in memory */ }
  apply();
  for (const fn of listeners) fn(getSettings());
  syncUi();
}

export function onSettingsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ---- hooks: each can be called on its own ----
export function applyGraphics({ renderer, scene, sun, camera, pipeline } = ctx || {}) {
  const p = Object.hasOwn(PRESETS, state.quality) ? PRESETS[state.quality] : PRESETS.high;
  if (pipeline) pipeline.setPixelSize(state.pixelSize); // owns pixel ratio and canvas size
  else if (renderer) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.pixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  if (sun && sun.shadow && sun.shadow.mapSize.x !== p.shadowMap) {
    sun.shadow.mapSize.set(p.shadowMap, p.shadowMap);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } // re-allocated on next render
  }
  if (base && scene && scene.fog && base.fog) { scene.fog.near = base.fog.near * p.fogScale; scene.fog.far = base.fog.far * p.fogScale; }
  if (base && camera && base.far) { camera.far = base.far * p.farScale; camera.updateProjectionMatrix(); }
}

export function applyAudio(audio = ctx && ctx.audio) {
  if (audio && typeof audio.setVolume === 'function') audio.setVolume(state.volume);
}

function apply() {
  if (!ctx) return;
  applyGraphics(ctx);
  applyAudio(ctx.audio);
  fpsEl.style.display = state.showFps ? 'block' : 'none';
}

export async function toggleFullscreen() {
  const d = desktop();
  if (d) { await d.toggleFullscreen(); return; }
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { /* not allowed here */ }
}

export function initSettings(c) {
  ctx = c;
  base = {
    fog: c.scene && c.scene.fog ? { near: c.scene.fog.near, far: c.scene.fog.far } : null,
    far: c.camera ? c.camera.far : 0,
  };
  mount();
  apply();
}

// ---------------- overlay ----------------
const CSS = `
#lrSettings { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; background: rgba(8,7,6,.6); font-family: var(--font, 'Segoe UI', system-ui, sans-serif); color: var(--ink, #e9e4d8); }
#lrSettings.hidden { display: none; }
#lrSettings .box { width: min(480px, 94vw); padding: 18px 20px; background: rgba(18,17,15,.94); border: 1px solid rgba(255,220,160,.16); border-radius: 6px; }
#lrSettings h2 { margin: 0 0 14px; font-size: 13px; letter-spacing: .2em; font-weight: 600; color: var(--amber, #ffb340); }
#lrSettings .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px 0; font-size: 14px; }
#lrSettings .seg { display: flex; gap: 4px; }
#lrSettings button { font-family: inherit; font-size: 12px; letter-spacing: .08em; padding: 5px 12px; color: var(--muted, #9a9384); background: rgba(255,255,255,.03); border: 1px solid rgba(255,220,160,.16); border-radius: 3px; cursor: pointer; }
#lrSettings button:hover { color: var(--ink, #e9e4d8); border-color: var(--amber, #ffb340); }
#lrSettings button.on { color: #1a1206; background: var(--amber, #ffb340); border-color: var(--amber, #ffb340); }
#lrSettings input[type=range] { width: 170px; accent-color: var(--amber, #ffb340); }
#lrSettings input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--amber, #ffb340); }
#lrSettings .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; font-size: 11px; color: var(--muted, #9a9384); }
#lrFps { position: fixed; top: 6px; left: 50%; transform: translateX(-50%); z-index: 41; font: 12px/1 ui-monospace, Consolas, monospace; color: #e9e4d8; background: rgba(0,0,0,.45); padding: 3px 7px; border-radius: 3px; pointer-events: none; display: none; }
`;

let root = null, fpsEl = null, volLbl = null, fsBtn = null;

function mount() {
  if (root) return;
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  fpsEl = document.createElement('div'); fpsEl.id = 'lrFps'; document.body.appendChild(fpsEl);

  root = document.createElement('div'); root.id = 'lrSettings'; root.className = 'hidden';
  root.innerHTML = `
    <div class="box" role="dialog" aria-label="Settings">
      <h2>SETTINGS</h2>
      <div class="row"><span>Graphics</span><span class="seg" data-k="quality">
        ${Object.entries(PRESETS).map(([k, p]) => `<button data-v="${k}">${p.label.toUpperCase()}</button>`).join('')}
      </span></div>
      <div class="row"><span>Pixel size</span><span class="seg" data-k="pixelSize">
        ${Object.entries(PIXEL_SIZES).map(([k, l]) => `<button data-v="${k}">${l}</button>`).join('')}
      </span></div>
      <div class="row"><span>Master volume <b data-vol></b></span><input type="range" min="0" max="100" step="1" data-k="volume"></div>
      <div class="row"><span>Fullscreen</span><button data-fs>TOGGLE</button></div>
      <div class="row"><span>Show FPS</span><input type="checkbox" data-k="showFps"></div>
      <div class="foot"><span>F10 or Esc to close${desktop() ? ' &middot; F11 / Alt+Enter fullscreen' : ''}</span><button data-close>CLOSE</button></div>
    </div>`;
  document.body.appendChild(root);
  volLbl = root.querySelector('[data-vol]');
  fsBtn = root.querySelector('[data-fs]');

  root.querySelectorAll('[data-k=quality] button').forEach((b) => b.addEventListener('click', () => setSetting('quality', b.dataset.v)));
  root.querySelectorAll('[data-k=pixelSize] button').forEach((b) => b.addEventListener('click', () => setSetting('pixelSize', +b.dataset.v)));
  root.querySelector('[data-k=volume]').addEventListener('input', (e) => setSetting('volume', e.target.value / 100));
  root.querySelector('[data-k=showFps]').addEventListener('change', (e) => setSetting('showFps', e.target.checked));
  fsBtn.addEventListener('click', () => toggleFullscreen());
  root.querySelector('[data-close]').addEventListener('click', closeSettings);
  root.addEventListener('mousedown', (e) => { if (e.target === root) closeSettings(); });

  // capture phase so the game never sees keys while the overlay is open
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F10') { e.preventDefault(); e.stopImmediatePropagation(); toggleSettings(); return; }
    if (!isSettingsOpen()) return;
    e.stopImmediatePropagation();
    if (e.code === 'Escape') { e.preventDefault(); closeSettings(); }
  }, true);
  window.addEventListener('wheel', (e) => { if (isSettingsOpen()) e.stopImmediatePropagation(); }, { capture: true, passive: true });

  window.addEventListener('resize', () => { if (ctx && ctx.renderer) applyGraphics(ctx); });
  const d = desktop();
  if (d) d.onFullscreenChange(syncUi); else document.addEventListener('fullscreenchange', syncUi);

  // FPS: frames presented per second, sampled twice a second
  let frames = 0, t0 = performance.now();
  const tick = (t) => {
    frames++;
    if (t - t0 >= 500) { if (state.showFps) fpsEl.textContent = Math.round((frames * 1000) / (t - t0)) + ' FPS'; frames = 0; t0 = t; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  syncUi();
}

async function syncUi() {
  if (!root) return;
  root.querySelectorAll('[data-k=quality] button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.quality));
  root.querySelectorAll('[data-k=pixelSize] button').forEach((b) => b.classList.toggle('on', +b.dataset.v === state.pixelSize));
  root.querySelector('[data-k=volume]').value = Math.round(state.volume * 100);
  volLbl.textContent = Math.round(state.volume * 100) + '%';
  root.querySelector('[data-k=showFps]').checked = state.showFps;
  const d = desktop();
  const fs = d ? await d.isFullscreen() : !!document.fullscreenElement;
  fsBtn.textContent = fs ? 'ON' : 'OFF';
  fsBtn.classList.toggle('on', fs);
}

export function isSettingsOpen() { return !!root && !root.classList.contains('hidden'); }
export function openSettings() { if (!root) mount(); root.classList.remove('hidden'); syncUi(); }
export function closeSettings() { if (root) root.classList.add('hidden'); }
export function toggleSettings() { if (isSettingsOpen()) closeSettings(); else openSettings(); }
