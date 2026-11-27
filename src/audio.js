// Synthesised engine, tyre and winch sound (WebAudio). Everything is generated in code.
//
// Engine voice (per rig, from spec.engine: `sound` picks a profile, `idle` / `redline` set the range,
// optional `cyl` / `diesel` override the profile):
//   - Three looping buffers are pre-rendered once per engine: DRIVE (firm firing pulses with a little
//     combustion noise), COAST (soft, uneven overrun pulses with the odd miss) and CLATTER (diesel
//     knock clicks, or exhaust rasp on a petrol). Each holds about 3 s of firing events at idle
//     (rpm / 60 x cylinders / 2 per second), every event a band-limited pressure pulse with its own
//     per-cylinder strength and timing offset plus cycle-to-cycle jitter, so the note thumps and
//     never settles into a pure tone. They play in lock step with playbackRate = rpm / idle (a pulse
//     lasts a fixed crank angle, so it shortens with rpm, as a real exhaust pulse does).
//   - Body: soft saturation (more drive under load) -> three FIXED resonances (exhaust, block,
//     intake; low Q, they never move with rpm, only the intake's gain follows load) -> a low-pass
//     with no resonance that opens with load (much less with rpm, and held low in 4-Low at crawl) ->
//     plus a fixed sub-bass branch that is strongest at idle.
//   - Load matters more than rpm: effort = max(load, throttle / 2), smoothed, crossfades COAST ->
//     DRIVE, raises level, saturation and brightness.
// Tyres: low, textured loops by surface (dirt / grass rumble, gravel crunch, rock crackle, tarmac
// hum, sand hush, mud squelch, water splash), scrub grains when a tyre slips on hard ground, and a
// scrape voice driven by the chassis' scrape work (car.crash.scrape). Winch: a low motor buzz and gear
// growl, only built once a winch state object shows up.
// Master: engine and effects buses -> high shelf (-8 dB above 4.5 kHz) -> low-pass 7 kHz ->
// compressor -> master gain (volume, mute, pause fade). No per-sample JS runs at play time:
// update() only moves AudioParams with smooth ramps. The context is created on the first user
// gesture, suspended while paused, and closed on page hide.

import { MAT } from './maps/common.js';

// ---------------- engine profiles ----------------
// strengths / offsets: one entry per firing slot (offset as a fraction of the firing interval)
// pulse: pulse width as a fraction of the firing interval; jitter: timing sd (fraction of the interval)
// exhaust / block / intake: [Hz, Q, dB] fixed resonances; lp: [closed, open] low-pass Hz
const PROFILES = {
  // V8 diesel (Cruiser): deep, uneven bank-to-bank thump, knock clatter strongest at idle
  diesel: {
    cyl: 8, diesel: true, pulse: 0.7, jitter: 0.05, ampJit: 0.12,
    strengths: [1, 0.74, 0.94, 0.7, 0.98, 0.78, 0.9, 0.72], offsets: [0, 0.06, -0.03, 0.08, 0.01, 0.05, -0.02, 0.07],
    knock: 0.55, rasp: 0.08, exhaust: [88, 0.9, 7], block: [210, 1.0, 3], intake: [400, 1.0, 3],
    lp: [280, 820], sub: 1.0, sat: 1.3, level: 1.0,
  },
  // petrol V6 (Pickup): throaty, smoother than the diesel, rasp under load
  v6: {
    cyl: 6, diesel: false, pulse: 0.5, jitter: 0.05, ampJit: 0.1,
    strengths: [1, 0.84, 0.95, 0.8, 0.9, 0.86], offsets: [0, 0.04, -0.02, 0.05, 0.01, 0.03],
    knock: 0, rasp: 0.3, exhaust: [105, 0.9, 6.5], block: [270, 1.0, 3], intake: [620, 1.1, 4],
    lp: [340, 1400], sub: 0.8, sat: 1.5, level: 0.95,
  },
  // flat four with unequal-length headers (Rally Sedan): pulses bunched in pairs = the burble
  boxer: {
    cyl: 4, diesel: false, pulse: 0.44, jitter: 0.05, ampJit: 0.1,
    strengths: [1, 0.66, 0.94, 0.6], offsets: [0, -0.18, 0.02, -0.14],
    knock: 0, rasp: 0.34, exhaust: [96, 0.9, 6.5], block: [250, 1.0, 3], intake: [600, 1.1, 4],
    lp: [360, 1500], sub: 0.85, sat: 1.5, level: 0.95,
  },
  // cross-plane petrol V8 (parked rig)
  v8: {
    cyl: 8, diesel: false, pulse: 0.48, jitter: 0.04, ampJit: 0.1,
    strengths: [1, 0.66, 0.92, 0.6, 1, 0.7, 0.86, 0.62], offsets: [0, 0.06, 0, -0.07, 0, 0.08, 0, -0.06],
    knock: 0, rasp: 0.3, exhaust: [90, 0.9, 7], block: [240, 1.0, 3], intake: [560, 1.1, 4],
    lp: [330, 1350], sub: 1.0, sat: 1.5, level: 1.0,
  },
};

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);

function rng(seed) {
  let s = seed >>> 0;
  const r = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.g = () => { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  return r;
}

// RBJ biquad, used only while building buffers
function biquad(x, type, f, Q, sr) {
  const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; } else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; } else { b0 = al; b1 = 0; b2 = -al; }
  const a0 = 1 + al, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  b0 /= a0; b1 /= a0; b2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i], y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y; }
  return x;
}
// a looping buffer is filtered twice over so its seam carries the filter's settled state
function loopFilter(x, type, f, Q, sr) {
  const n = x.length, y = new Float32Array(n * 2);
  y.set(x); y.set(x, n);
  biquad(y, type, f, Q, sr);
  x.set(y.subarray(n));
  return x;
}
const peakNorm = (a, to = 1) => { let m = 1e-9; for (const v of a) m = Math.max(m, Math.abs(v)); for (let i = 0; i < a.length; i++) a[i] *= to / m; return a; };

function profileFor(engine) {
  const e = typeof engine === 'string' ? { sound: engine } : engine || {};
  const base = PROFILES[e.sound] || PROFILES.v8;
  const P = { ...base, key: e.sound in PROFILES ? e.sound : 'v8' };
  if (Number.isFinite(e.cyl) && e.cyl !== base.cyl) { // spec override: re-spread the pattern
    P.cyl = e.cyl;
    P.strengths = Array.from({ length: e.cyl }, (_, i) => base.strengths[i % base.strengths.length]);
    P.offsets = Array.from({ length: e.cyl }, (_, i) => base.offsets[i % base.offsets.length]);
  }
  if (typeof e.diesel === 'boolean') P.diesel = e.diesel;
  return { P, idle: e.idle || 750, redline: e.redline || 6000 };
}

// Build the DRIVE / COAST / CLATTER loops for one engine at its idle rpm.
function buildEngine(ctx, engine) {
  const { P, idle, redline } = profileFor(engine);
  const sr = ctx.sampleRate;
  const cycle = Math.round(sr * 120 / idle);          // samples per 4-stroke cycle at idle
  const nc = Math.max(8, Math.round(3 / (120 / idle))); // ~3 s of cycles
  const len = cycle * nc, fire = cycle / P.cyl;
  const drive = new Float32Array(len), coast = new Float32Array(len), clat = new Float32Array(len);
  const r = rng(P.key.length * 7919 + P.cyl * 131 + idle);
  const add = (buf, start, shape, n) => { const s0 = Math.floor(start); for (let i = 0; i < n; i++) { const v = shape(i); if (v) buf[((s0 + i) % len + len) % len] += v; } };
  const width = P.pulse * fire;
  // exhaust pressure pulse: raised-cosine push then a longer, weaker suck (no DC to speak of)
  const pulse = (w, amp, sharp) => (i) => {
    if (i < w) { const u = Math.sin(Math.PI * i / w); return amp * Math.pow(u, sharp); }
    const j = i - w, w2 = w * 1.7;
    if (j < w2) { const u = Math.sin(Math.PI * j / w2); return -amp * 0.32 * u * u; }
    return 0;
  };
  // cycle-to-cycle speed drift: each cycle's length wanders by ~1.5% (the crank never turns
  // perfectly evenly), rescaled so the loop still closes; it broadens the higher orders
  const starts = [0]; let wob = 0;
  for (let c = 0; c < nc; c++) { wob = 0.7 * wob + 0.3 * r.g(); starts.push(starts[c] + 1 + 0.015 * wob); }
  const scale = nc / starts[nc];
  let slow = 0;
  for (let c = 0; c < nc; c++) {
    slow = 0.6 * slow + 0.4 * r.g();                    // cycle-to-cycle swell
    const c0 = starts[c] * scale * cycle, cl = (starts[c + 1] - starts[c]) * scale * cycle / P.cyl;
    for (let k = 0; k < P.cyl; k++) {
      const at = c0 + (k + P.offsets[k] + P.jitter * r.g()) * cl;
      const amp = P.strengths[k] * (1 + P.ampJit * r.g()) * (1 + 0.06 * slow);
      // DRIVE: firm, a touch narrower, plus a short combustion-noise burst
      add(drive, at, pulse(width * 0.85, amp, 2), Math.ceil(width * 3));
      const nb = Math.round(sr * 0.004);
      let lp = 0;
      add(drive, at + width * 0.1, (i) => { lp += 0.3 * (r() * 2 - 1 - lp); return 0.22 * amp * lp * Math.exp(-i / (sr * 0.0018)); }, nb);
      // COAST: soft and wide, uneven, some events almost missing; petrol gets the odd small pop
      const miss = r() < 0.14 ? 0.2 : 1;
      add(coast, at, pulse(width * 1.25, amp * 0.55 * miss * (1 + 0.25 * r.g()), 2), Math.ceil(width * 3.6));
      if (!P.diesel && r() < 0.05) { let l2 = 0; add(coast, at + width * 0.6, (i) => { l2 += 0.35 * (r() * 2 - 1 - l2); return 0.45 * l2 * Math.exp(-i / (sr * 0.003)); }, Math.round(sr * 0.012)); }
      // CLATTER: diesel knock click (own timing jitter so it never lines up into a tone) or petrol rasp
      const kat = at + (0.04 + 0.05 * r.g()) * fire;
      if (P.diesel) { let l3 = 0; const ka = amp * (0.7 + 0.5 * r()); add(clat, kat, (i) => { l3 += 0.5 * (r() * 2 - 1 - l3); return ka * l3 * Math.exp(-i / (sr * 0.0015)); }, Math.round(sr * 0.008)); }
      else { let l3 = 0; add(clat, kat, (i) => { l3 += 0.25 * (r() * 2 - 1 - l3); return amp * l3 * Math.exp(-i / (sr * 0.005)); }, Math.round(sr * 0.02)); }
    }
  }
  // band-limit so playback up to redline cannot alias (linear-interpolated resampling)
  const maxRate = (redline / idle) * 1.1;
  const cap = Math.min(3000, 0.42 * sr / maxRate);
  for (const b of [drive, coast]) { loopFilter(b, 'hp', 18, 0.7, sr); loopFilter(b, 'lp', cap, 0.7071, sr); loopFilter(b, 'lp', cap, 0.7071, sr); }
  loopFilter(clat, 'hp', P.diesel ? 300 : 120, 0.7, sr); loopFilter(clat, 'lp', Math.min(cap, P.diesel ? 1800 : 1200), 0.7071, sr); loopFilter(clat, 'lp', Math.min(cap, 1800), 0.7071, sr);
  peakNorm(drive); peakNorm(coast, 0.75); peakNorm(clat);
  const mk = (d) => { const b = ctx.createBuffer(1, len, sr); b.getChannelData(0).set(d); return b; };
  return { P, idle, redline, drive: mk(drive), coast: mk(coast), clat: mk(clat) };
}

// ---------------- tyre / ground textures ----------------
function buildTextures(ctx) {
  const sr = ctx.sampleRate, n = Math.round(sr * 2.5);
  const r = rng(4242);
  const mk = (d) => { const b = ctx.createBuffer(1, d.length, sr); b.getChannelData(0).set(d); return b; };
  // white
  const white = new Float32Array(n); for (let i = 0; i < n; i++) white[i] = r() * 2 - 1;
  // brown (leaky integrated white): the rolling rumble
  const brown = new Float32Array(n); { let y = 0; for (let i = 0; i < n; i++) { y = 0.995 * y + 0.06 * (r() * 2 - 1); brown[i] = y; } loopFilter(brown, 'hp', 20, 0.7, sr); peakNorm(brown, 0.9); }
  // crunch: dense short grains of random size (gravel, rock grit, scrape)
  const crunch = new Float32Array(n); {
    for (let g = 0; g < 2.5 * 320; g++) {
      const at = Math.floor(r() * n), dur = Math.round(sr * (0.0015 + 0.005 * r())), a = Math.pow(r(), 2.2);
      let l = 0; const k = 0.25 + 0.6 * r();
      for (let i = 0; i < dur; i++) { l += k * (r() * 2 - 1 - l); crunch[(at + i) % n] += a * l * Math.sin(Math.PI * i / dur); }
    }
    loopFilter(crunch, 'lp', 2600, 0.7071, sr); peakNorm(crunch, 0.9);
  }
  // squelch: wet low blobs with a downward glide (mud), some with a slurpy noise tail
  const squelch = new Float32Array(n); {
    for (let g = 0; g < 2.5 * 9; g++) {
      const at = Math.floor(r() * n), dur = Math.round(sr * (0.05 + 0.1 * r())), f0 = 150 + 120 * r(), f1 = 55 + 30 * r(), a = 0.4 + 0.6 * r();
      let ph = 0, l = 0;
      for (let i = 0; i < dur; i++) {
        const u = i / dur, f = f0 + (f1 - f0) * u; ph += 2 * Math.PI * f / sr;
        l += 0.08 * (r() * 2 - 1 - l);
        squelch[(at + i) % n] += a * (Math.sin(ph) * Math.sin(Math.PI * u) * (1 - u) + 1.5 * l * u * (1 - u));
      }
    }
    loopFilter(squelch, 'lp', 900, 0.7071, sr); peakNorm(squelch, 0.9);
  }
  // splash: water noise in slow, overlapping swells
  const splash = new Float32Array(n); {
    for (let g = 0; g < 2.5 * 7; g++) {
      const at = Math.floor(r() * n), dur = Math.round(sr * (0.08 + 0.3 * r())), a = 0.3 + 0.7 * r();
      for (let i = 0; i < dur; i++) { const u = i / dur; splash[(at + i) % n] += a * (r() * 2 - 1) * Math.pow(Math.sin(Math.PI * u), 2) * (1 - 0.6 * u); }
    }
    loopFilter(splash, 'bp', 600, 0.6, sr); loopFilter(splash, 'lp', 1800, 0.7071, sr); peakNorm(splash, 0.9);
  }
  return { white: mk(white), brown: mk(brown), crunch: mk(crunch), squelch: mk(squelch), splash: mk(splash) };
}

// ---------------- state from the game ----------------
// One call per frame from main.js: everything the voices need, read from the car.
export function audioStateFrom(car, kmh) {
  const d = car.dt, sp = car.spec;
  const rpm = d.rpm, mt = typeof d.maxTorqueAt === 'function' ? d.maxTorqueAt(rpm) : (sp.engine.peakT || 1);
  const engaged = d.gear !== 0 && (d.engagement ?? 1) > 0.5;
  const load = clamp((d.engineTorque || 0) / Math.max(1, mt)) * (engaged ? 1 : 0.4);
  const w = car.winch;
  return {
    rpm, throttle: d.throttleEff, running: d.running, load, gear: d.gear, range: d.range,
    kmh: kmh ?? Math.abs(car.speed()) * 3.6, radius: sp.tire.radius, wheels: car.wheelState,
    scrape: car.crash ? car.crash.scrape : 0,
    winch: w ? (w.state && typeof w.state === 'object' ? w.state : w) : null,
  };
}

// ---------------- the voice ----------------
export class EngineAudio {
  // opts.context: render into a given (e.g. Offline) context, created at once (tests)
  constructor(opts = {}) {
    this.ctx = null; this.muted = false; this.volume = 1;
    this.mix = { engine: 1, effects: 1, mute: false };
    this.engine = null; this.voice = null; this.cache = new Map(); this.nodes = new Set();
    this._given = opts.context || null;
    if (!this._given && typeof window !== 'undefined') window.__audio = this; // console / browser-test handle
    this._x = 0; this._slip = 0; this._scrape = 0; this._lastScrape = null; this._t = 0; this._wander = 0; this._rnd = rng(99);
  }

  get nodeCount() { return this.nodes.size; }
  _n(node) { this.nodes.add(node); return node; }

  setVolume(v) { this.volume = clamp(+v || 0); this._applyMaster(); }
  // { engine 0..1, effects 0..1, mute bool } from the settings screen
  setMix(m = {}) {
    if (Number.isFinite(m.engine)) this.mix.engine = clamp(m.engine);
    if (Number.isFinite(m.effects)) this.mix.effects = clamp(m.effects);
    if (typeof m.mute === 'boolean') this.mix.mute = m.mute;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engBus.gain.setTargetAtTime(this.mix.engine, t, 0.05);
    this.fxBus.gain.setTargetAtTime(this.mix.effects, t, 0.05);
    this._applyMaster();
  }
  // game mute (M key) and pause; a paused realtime context is suspended after the fade
  setMuted(m) {
    this.muted = !!m;
    this._applyMaster();
  }
  _silent() { return this.muted || this.mix.mute; }
  _applyMaster() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, target = this._silent() ? 0 : this.volume;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(target, t, 0.04);
    if (!this.realtime) return;
    clearTimeout(this._suspendTimer);
    if (target === 0) this._suspendTimer = setTimeout(() => { if (this._silent() && ctx.state === 'running') ctx.suspend().catch(() => {}); }, 400);
    else if (ctx.state === 'suspended' && this._gestured()) ctx.resume().catch(() => {});
  }
  _gestured() { const ua = typeof navigator !== 'undefined' && navigator.userActivation; return !ua || ua.hasBeenActive; }

  // engine: spec.engine ({ sound, idle, redline, cyl?, diesel? }) or a sound name
  start(engine) {
    this.engine = engine;
    if (!this.ctx) {
      if (this._given) this._create(this._given);
      else if (!this._gestured()) { this._waitGesture(); return; }
      else this._create(null);
      if (!this.ctx) return;
    }
    this._setVoice(engine);
  }
  _waitGesture() {
    if (this._waiting) return;
    this._waiting = true;
    const go = () => {
      removeEventListener('pointerdown', go, true); removeEventListener('keydown', go, true);
      this._waiting = false;
      if (!this.ctx) { this._create(null); if (this.ctx && this.engine) this._setVoice(this.engine); }
    };
    addEventListener('pointerdown', go, true); addEventListener('keydown', go, true);
  }

  _create(given) {
    let ctx = given;
    if (!ctx) {
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return;
      ctx = new AC({ latencyHint: 'interactive' });
      addEventListener('pagehide', () => this.dispose(), { once: true });
      if (ctx.state === 'suspended') { // the autoplay policy held it back: resume on the next gesture
        const go = () => { removeEventListener('pointerdown', go, true); removeEventListener('keydown', go, true); if (this.ctx === ctx && !this._silent()) ctx.resume().catch(() => {}); };
        addEventListener('pointerdown', go, true); addEventListener('keydown', go, true);
      }
    }
    this.ctx = ctx;
    this.realtime = !given && typeof ctx.close === 'function';
    const n = (x) => this._n(x);
    // ---- master ----
    this.master = n(ctx.createGain()); this.master.gain.value = 0;
    const shelf = n(ctx.createBiquadFilter()); shelf.type = 'highshelf'; shelf.frequency.value = 4500; shelf.gain.value = -8;
    const top = n(ctx.createBiquadFilter()); top.type = 'lowpass'; top.frequency.value = 7000; top.Q.value = 0.5;
    const comp = n(ctx.createDynamicsCompressor());
    comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.008; comp.release.value = 0.25;
    this.mixIn = n(ctx.createGain()); this.mixIn.gain.value = 0.9;
    this.mixIn.connect(shelf); shelf.connect(top); top.connect(comp); comp.connect(this.master); this.master.connect(ctx.destination);
    this.engBus = n(ctx.createGain()); this.engBus.gain.value = this.mix.engine; this.engBus.connect(this.mixIn);
    this.fxBus = n(ctx.createGain()); this.fxBus.gain.value = this.mix.effects; this.fxBus.connect(this.mixIn);
    this.oneShot = n(ctx.createGain()); this.oneShot.gain.value = 0.8; this.oneShot.connect(this.fxBus);

    // ---- engine body chain (shared by every voice) ----
    this.engIn = n(ctx.createGain());
    this.pre = n(ctx.createGain()); this.pre.gain.value = 1;
    const shaper = n(ctx.createWaveShaper());
    const curve = new Float32Array(1025);
    for (let i = 0; i < curve.length; i++) { const x = (i / 512) - 1; curve[i] = Math.tanh(x * 1.4) / Math.tanh(1.4); }
    shaper.curve = curve; shaper.oversample = '2x';
    this.exhaust = n(ctx.createBiquadFilter()); this.exhaust.type = 'peaking';
    this.block = n(ctx.createBiquadFilter()); this.block.type = 'peaking';
    this.intake = n(ctx.createBiquadFilter()); this.intake.type = 'peaking';
    this.engLP = n(ctx.createBiquadFilter()); this.engLP.type = 'lowpass'; this.engLP.Q.value = 0.6; this.engLP.frequency.value = 400;
    this.subLP = n(ctx.createBiquadFilter()); this.subLP.type = 'lowpass'; this.subLP.frequency.value = 85; this.subLP.Q.value = 0.6;
    this.subG = n(ctx.createGain()); this.subG.gain.value = 0;
    this.clatIn = n(ctx.createGain());
    this.clatBP = n(ctx.createBiquadFilter()); this.clatBP.type = 'bandpass'; this.clatBP.Q.value = 0.7;
    this.clatG = n(ctx.createGain()); this.clatG.gain.value = 0;
    this.engOut = n(ctx.createGain()); this.engOut.gain.value = 0;
    this.engIn.connect(this.pre); this.pre.connect(shaper); shaper.connect(this.exhaust); this.exhaust.connect(this.block); this.block.connect(this.intake); this.intake.connect(this.engLP); this.engLP.connect(this.engOut);
    this.engIn.connect(this.subLP); this.subLP.connect(this.subG); this.subG.connect(this.engOut);
    this.clatIn.connect(this.clatBP); this.clatBP.connect(this.clatG); this.clatG.connect(this.engLP);
    this.engOut.connect(this.engBus);

    // ---- tyres and ground ----
    const T = this.tex = buildTextures(ctx);
    const loop = (buf, rate = 1) => { const s = n(ctx.createBufferSource()); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.loopStart = 0; s.start(0, Math.random() * buf.duration * (this.realtime ? 1 : 0)); return s; };
    const filt = (type, f, Q) => { const b = n(ctx.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = Q; return b; };
    const gain = () => { const g = n(ctx.createGain()); g.gain.value = 0; g.connect(this.fxBus); return g; };
    this.tyre = {};
    const brown = loop(T.brown), white = loop(T.white), crunch = loop(T.crunch), squelch = loop(T.squelch), splash = loop(T.splash), grit = loop(T.crunch, 0.55);
    this.tyre.src = { crunch, squelch, splash, grit };
    const branch = (src, chain, name) => { let a = src; for (const f of chain) { a.connect(f); a = f; } const g = gain(); a.connect(g); this.tyre[name] = g; };
    branch(brown, [filt('lowpass', 240, 0.6)], 'dirt');                    // dirt / grass / dirt road rumble
    branch(brown, [filt('bandpass', 110, 0.7)], 'tarmac');                 // tarmac hum, kept low
    branch(white, [filt('bandpass', 480, 0.5), filt('lowpass', 1100, 0.6)], 'sand'); // sand hush
    branch(crunch, [filt('bandpass', 620, 0.55), filt('lowpass', 1500, 0.6)], 'gravel');               // gravel crunch
    branch(grit, [filt('lowpass', 520, 0.6)], 'rock');                     // rock: low crackle and thumps
    branch(squelch, [filt('lowpass', 700, 0.6)], 'mud');                   // mud squelch / slurp
    branch(splash, [filt('lowpass', 1300, 0.6)], 'water');                 // water splash
    branch(grit, [filt('bandpass', 620, 0.9), filt('lowpass', 1400, 0.6)], 'scrub'); // tyre scrub / chirp on hard ground
    branch(crunch, [filt('bandpass', 420, 0.8)], 'scrape');                // chassis / diff on rock
    this.winchV = null;
    this._applyMaster();
  }

  _setVoice(engine) {
    const ctx = this.ctx, t = ctx.currentTime;
    const prof = profileFor(engine);
    const key = prof.P.key + ':' + prof.P.cyl + ':' + prof.idle + ':' + prof.redline + ':' + prof.P.diesel;
    if (this.voice && this.voice.key === key) return;
    if (!this.cache.has(key)) this.cache.set(key, buildEngine(ctx, engine));
    const L = this.cache.get(key);
    // fixed resonances for this rig
    const P = L.P;
    for (const [f, d] of [[this.exhaust, P.exhaust], [this.block, P.block], [this.intake, P.intake]]) { f.frequency.setValueAtTime(d[0], t); f.Q.setValueAtTime(d[1], t); }
    this.exhaust.gain.setValueAtTime(P.exhaust[2], t); this.block.gain.setValueAtTime(P.block[2], t); this.intake.gain.setValueAtTime(0, t);
    this.clatBP.frequency.setValueAtTime(P.diesel ? 1050 : 650, t);
    // crossfade: the old voice fades out and is released, the new one fades in
    const old = this.voice;
    if (old) {
      old.out.gain.cancelScheduledValues(t); old.out.gain.setTargetAtTime(0, t, 0.03);
      for (const s of old.srcs) { try { s.stop(t + 0.25); } catch { /* stopped */ } }
      old.srcs[0].onended = () => { for (const x of [...old.srcs, ...old.gains, old.out]) { x.disconnect(); this.nodes.delete(x); } };
    }
    const mkSrc = (buf) => { const s = this._n(ctx.createBufferSource()); s.buffer = buf; s.loop = true; return s; };
    const out = this._n(ctx.createGain()); out.gain.value = 0; out.gain.setTargetAtTime(1, t, 0.04);
    const srcs = [mkSrc(L.drive), mkSrc(L.coast), mkSrc(L.clat)];
    const gains = srcs.map(() => { const g = this._n(ctx.createGain()); g.gain.value = 0; return g; });
    srcs[0].connect(gains[0]); srcs[1].connect(gains[1]); srcs[2].connect(gains[2]);
    gains[0].connect(out); gains[1].connect(out); out.connect(this.engIn);
    gains[2].connect(this.clatIn);
    for (const s of srcs) s.start(t);
    this.voice = { key, L, srcs, gains, out };
  }

  // state: see audioStateFrom(); the old positional form update(rpm, throttle, running, wheelSpin) still works
  update(s, throttle, running, wheelSpin) {
    if (typeof s === 'number') s = { rpm: s, throttle, running, load: throttle, kmh: Math.abs(wheelSpin || 0) * 0.45 * 3.6 };
    if (!this.ctx || !this.voice) return;
    if (this.realtime && this.ctx.state !== 'running') return; // paused / suspended: don't pile up ramps on a frozen clock
    if (this.engine && this.engine !== this._lastEngine) { this._lastEngine = this.engine; this._setVoice(this.engine); }
    const ctx = this.ctx, t = ctx.currentTime;
    const dt = clamp(s.dt ?? (t - this._t), 0.001, 0.1); this._t = t;
    const v = this.voice, L = v.L, P = L.P;

    // ---------- engine ----------
    const on = s.running && s.rpm > 100 ? 1 : 0;
    const rpm = Math.max(60, s.rpm || 0);
    const rn = clamp((rpm - L.idle) / (L.redline - L.idle));
    const thr = clamp(s.throttle || 0), load = clamp(s.load ?? thr);
    const target = clamp(Math.max(load, thr * 0.5));
    this._x += (target - this._x) * (1 - Math.exp(-dt / (target > this._x ? 0.1 : 0.25))); // rises quicker than it falls: no pumping
    const x = this._x;
    const crawl = s.range === 'low' && (s.kmh ?? 0) < 10;
    this._wander = 0.92 * this._wander + 0.08 * (this._rnd() * 2 - 1);
    const rate = (rpm / L.idle) * (1 + 0.012 * this._wander * (1 - rn));
    for (const src of v.srcs) src.playbackRate.setTargetAtTime(rate, t, 0.03);
    const k = 0.06;
    v.gains[0].gain.setTargetAtTime(on * (0.2 + 0.8 * x), t, k);
    v.gains[1].gain.setTargetAtTime(on * (0.08 + 0.62 * (1 - x)), t, k);
    const open = clamp(0.1 * rn + x * (0.2 + 0.65 * rn) * (crawl ? 0.45 : 1));
    this.engLP.frequency.setTargetAtTime(P.lp[0] * Math.pow(P.lp[1] / P.lp[0], open), t, 0.08);
    const drv = P.sat * x * (1 - 0.5 * rn);           // growl is a low-rpm, high-load thing
    this.pre.gain.setTargetAtTime(0.75 + drv, t, k);
    this.intake.gain.setTargetAtTime(P.intake[2] * x * (crawl ? 0.5 : 1), t, 0.1);
    const clat = P.diesel ? P.knock * (0.55 + 0.45 * x) * (1 - 0.65 * rn) : P.rasp * x * (0.25 + 0.75 * rn);
    v.gains[2].gain.setTargetAtTime(on, t, k);
    this.clatG.gain.setTargetAtTime(on * clat, t, k);
    this.subG.gain.setTargetAtTime(on * P.sub * (1 - rn) * (1 - rn) * (0.8 + 0.4 * x) * 1.6, t, 0.1);
    const lvl = on * P.level * 0.21 * (0.5 + 0.5 * x) * (0.9 + 0.25 * rn) / (0.75 + drv * 0.55);
    this.engOut.gain.setTargetAtTime(lvl, t, 0.1);

    // ---------- tyres and ground ----------
    const W = s.wheels || [], R = s.radius || 0.45;
    const mix = { dirt: 0, tarmac: 0, sand: 0, gravel: 0, rock: 0, mud: 0, water: 0 };
    let roll = 0, nG = 0, scrub = 0, mudSpin = 0;
    for (const w of W) {
      if (!w || !w.grounded) continue;
      nG++;
      const vs = Math.abs(w.spin || 0) * R, slip = w.slip || 0;
      roll += vs;
      const m = w.mat;
      const hard = m === MAT.ROCK || m === MAT.TARMAC || m === MAT.WOOD;
      if (m === MAT.MUD) { mix.mud++; mudSpin += vs + slip; } else if (m === MAT.WATER) { mix.water++; mix.dirt += 0.6; }
      else if (m === MAT.SAND) mix.sand++; else if (m === MAT.GRAVEL) { mix.gravel++; mix.dirt += 0.5; }
      else if (m === MAT.ROCK) mix.rock++; else if (m === MAT.TARMAC) mix.tarmac++;
      else if (m === MAT.WOOD) { mix.tarmac += 0.5; mix.rock += 0.5; } else if (m === MAT.ROAD) { mix.dirt += 0.6; mix.gravel += 0.4; } else mix.dirt++;
      // scrub: slip past a threshold, weighted by load; hard ground scrubs, loose ground sprays
      const ex = clamp((slip - 0.35) / 2.2) * clamp((w.load ?? 4000) / 6000, 0.3, 1.2);
      scrub += hard ? ex : 0;
      if (!hard && m !== MAT.MUD && m !== MAT.WATER) mix.gravel += 0.5 * ex, mix.dirt += 0.5 * ex;
    }
    const kmh = Math.max(s.kmh ?? 0, nG ? (roll / nG) * 3.6 : 0);
    const sp = clamp(kmh / 50), spd = Math.pow(sp, 0.8), sil = nG ? 1 / Math.max(1, nG) : 0;
    const crawlRoll = clamp(kmh / 4);                   // even at walking pace the tyres say something
    const tg = (name, val, tau = 0.08) => this.tyre[name].gain.setTargetAtTime(val, t, tau);
    tg('dirt', mix.dirt * sil * (0.05 * crawlRoll + 0.2 * spd));
    tg('tarmac', mix.tarmac * sil * 0.08 * spd);
    tg('sand', mix.sand * sil * (0.02 * crawlRoll + 0.1 * spd));
    tg('gravel', mix.gravel * sil * (0.06 * crawlRoll + 0.3 * spd));
    tg('rock', mix.rock * sil * (0.22 * crawlRoll + 0.25 * spd));
    tg('mud', mix.mud * sil * clamp(0.1 + (mudSpin / Math.max(1, mix.mud)) / 6) * 0.5 * crawlRoll);
    tg('water', mix.water * sil * (0.05 * crawlRoll + 0.4 * spd));
    const tr = (src, r) => src.playbackRate.setTargetAtTime(r, t, 0.1);
    tr(this.tyre.src.crunch, 0.7 + 0.6 * sp); tr(this.tyre.src.grit, 0.45 + 0.4 * sp); tr(this.tyre.src.squelch, 0.75 + 0.5 * clamp(mudSpin / 8)); tr(this.tyre.src.splash, 0.8 + 0.4 * sp);
    this._slip += ((scrub * sil) - this._slip) * (1 - Math.exp(-dt / (scrub * sil > this._slip ? 0.03 : 0.09)));
    tg('scrub', 0.55 * this._slip, 0.02);
    // chassis / diff scrape on rock: rate of the crash model's scrape work
    if (Number.isFinite(s.scrape)) {
      const d = this._lastScrape == null || s.scrape < this._lastScrape ? 0 : (s.scrape - this._lastScrape) / dt;
      this._lastScrape = s.scrape;
      this._scrape += (clamp(d / 6) - this._scrape) * (1 - Math.exp(-dt / 0.05));
      tg('scrape', 0.6 * this._scrape, 0.03);
    }

    // ---------- winch ----------
    this._winch(s.winch, t);
  }

  _winch(w, t) {
    if (!w && !this.winchV) return;
    const ctx = this.ctx;
    if (!this.winchV) {
      const n = (x) => this._n(x);
      const motor = n(ctx.createOscillator()); motor.type = 'sawtooth'; motor.frequency.value = 45;
      const sub = n(ctx.createOscillator()); sub.type = 'sine'; sub.frequency.value = 22.5;
      const lp = n(ctx.createBiquadFilter()); lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 0.5;
      const gear = n(ctx.createBufferSource()); gear.buffer = this.tex.brown; gear.loop = true;
      const gbp = n(ctx.createBiquadFilter()); gbp.type = 'bandpass'; gbp.frequency.value = 160; gbp.Q.value = 0.7;
      const gg = n(ctx.createGain()); gg.gain.value = 0;
      const mg = n(ctx.createGain()); mg.gain.value = 0;
      const out = n(ctx.createGain()); out.gain.value = 0;
      motor.connect(lp); sub.connect(lp); lp.connect(mg); mg.connect(out);
      gear.connect(gbp); gbp.connect(gg); gg.connect(out); out.connect(this.fxBus);
      motor.start(); sub.start(); gear.start();
      this.winchV = { motor, sub, mg, gg, out };
    }
    const V = this.winchV;
    const run = w && w.running ? 1 : 0, load = clamp(w ? +w.load || 0 : 0);
    const dir = w ? w.direction : 0, out = dir === 'out' || dir < 0;
    const speed = 1 - 0.45 * load;                     // a DC motor slows under load
    const f = (out ? 40 : 46) * (0.6 + 0.4 * speed);
    V.motor.frequency.setTargetAtTime(f, t, 0.15); V.sub.frequency.setTargetAtTime(f / 2, t, 0.15);
    V.mg.gain.setTargetAtTime(0.5, t, 0.1);
    V.gg.gain.setTargetAtTime(0.6 + 1.6 * load, t, 0.1);
    V.out.gain.setTargetAtTime(run * (0.04 + 0.07 * load) * (out && load < 0.1 ? 0.6 : 1), t, run ? 0.08 : 0.12);
  }

  // ---------------- one-shots (temporary nodes, released when they end) ----------------
  _temp(nodes, endAt) {
    const first = nodes[0];
    first.onended = () => { for (const x of nodes) x.disconnect(); };
    return endAt;
  }
  grind() {   // gear grind / damage: short gritty low-mid scrape, no squeal
    if (!this.ctx || this._silent()) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.tex.crunch; src.playbackRate.value = 1.4;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.8;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1600; lp.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    src.connect(bp).connect(lp).connect(g).connect(this.oneShot);
    src.start(t, Math.random()); src.stop(t + 0.35);
    this._temp([src, bp, lp, g]);
  }
  clunk() {   // a low thud
    if (!this.ctx || this._silent()) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(78, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.1);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.004); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    const nz = ctx.createBufferSource(); nz.buffer = this.tex.crunch;
    const nlp = ctx.createBiquadFilter(); nlp.type = 'lowpass'; nlp.frequency.value = 900;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.5, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(g).connect(this.oneShot); nz.connect(nlp).connect(ng).connect(this.oneShot);
    o.start(t); o.stop(t + 0.18); nz.start(t, Math.random()); nz.stop(t + 0.06);
    this._temp([o, g]); this._temp([nz, nlp, ng]);
  }
  starter() { // starter motor: low, lumpy churn
    if (!this.ctx || this._silent()) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(18, t);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 9; const lg = ctx.createGain(); lg.gain.value = 6;
    lfo.connect(lg).connect(o.frequency);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.03); g.gain.setValueAtTime(0.35, t + 0.6); g.gain.exponentialRampToValueAtTime(0.001, t + 0.75);
    o.connect(f).connect(g).connect(this.oneShot); o.start(t); lfo.start(t); o.stop(t + 0.8); lfo.stop(t + 0.8);
    this._temp([o, f, g]); this._temp([lfo, lg]);
  }

  dispose() {
    if (!this.ctx) return;
    clearTimeout(this._suspendTimer);
    for (const x of this.nodes) { try { x.disconnect(); } catch { /* gone */ } }
    this.nodes.clear();
    if (this.realtime) this.ctx.close().catch(() => {});
    this.ctx = null; this.voice = null; this.winchV = null;
  }
}
