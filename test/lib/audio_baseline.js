// Synthesised engine sound (WebAudio). Everything is generated in code.
//
// Approach: one full 4-stroke cycle (2 crank revolutions) of exhaust pulses is
// pre-rendered once per engine type into a looping AudioBuffer, then played back
// with playbackRate = rpm / BASE_RPM. Each cylinder firing is a damped
// low-frequency thump with its own strength and timing offset, so the cross-plane
// V8 burble, flat-four unequal-header rumble and diesel knock come from the
// pattern itself rather than from tuned oscillators. Two loops are layered:
//   body    - the low thumps (heavy low-pass, low shelf, soft saturation)
//   texture - noise bursts keyed to the same pulses (exhaust rasp / diesel clatter)
// plus a quiet intake noise bed that only appears with throttle at high rpm.
// No per-sample JS runs at play time; update() only moves AudioParams.

const BASE_RPM = 750;

// One entry per firing event in the 2-rev cycle:
// [slot position (0..n, fractional = timing irregularity), strength]
const ENGINES = {
  // Cross-plane V8: even 90 degree spacing but bank-alternating strength gives the burble.
  v8: {
    n: 8, f: 52, tau: 0.030, knock: 0.0, rasp: 0.55,
    pulses: [[0, 1.0], [1.06, 0.62], [2, 0.92], [2.92, 0.55], [4, 1.0], [5.08, 0.66], [6, 0.84], [6.94, 0.58]],
  },
  // 90 degree V6 style: smoother, lighter, slightly higher.
  v6: {
    n: 6, f: 66, tau: 0.024, knock: 0.0, rasp: 0.4,
    pulses: [[0, 1.0], [1.03, 0.86], [2, 0.95], [3, 0.9], [4.04, 0.84], [5, 0.92]],
  },
  // Heavy diesel: deep fat thump plus a sharp knock at every firing.
  diesel: {
    n: 6, f: 40, tau: 0.045, knock: 0.9, rasp: 0.3,
    pulses: [[0, 1.0], [1, 0.95], [2, 1.0], [3, 0.92], [4, 1.0], [5, 0.95]],
  },
  // Flat-four with unequal-length headers: pairs of pulses bunched together.
  boxer: {
    n: 4, f: 58, tau: 0.034, knock: 0.0, rasp: 0.5,
    pulses: [[0, 1.0], [0.72, 0.7], [2, 0.95], [2.8, 0.62]],
  },
};

function buildLoops(ctx, kind) {
  const e = ENGINES[kind] || ENGINES.v8;
  const sr = ctx.sampleRate;
  const len = Math.round(sr * 120 / BASE_RPM);
  const body = new Float32Array(len), tex = new Float32Array(len);
  const slot = len / e.n;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (const [pos, amp] of e.pulses) {
    const start = pos * slot;
    const dur = Math.min(len, Math.floor(sr * e.tau * 7));
    let lp = 0;
    for (let i = 0; i < dur; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.0025) * Math.exp(-t / e.tau);
      // fundamental thump with a slightly falling pitch, plus a little 2nd harmonic
      const ph = 2 * Math.PI * e.f * (t - 0.4 * Math.min(t, 0.05) * Math.min(t, 0.05) / 0.05);
      const s = (Math.sin(ph) + 0.8 * Math.sin(2 * ph + 0.6) + 0.55 * Math.sin(3 * ph + 1.3) + 0.3 * Math.sin(5 * ph)) * env * amp;
      // noise burst, one-pole low-passed, much shorter than the thump
      lp += 0.35 * (rnd() - lp);
      const nenv = Math.exp(-t / (e.knock > 0 ? 0.006 : 0.014)) * amp;
      const idx = (Math.floor(start) + i) % len;
      body[idx] += s;
      tex[idx] += lp * nenv * (e.knock > 0 ? 1.0 : 0.8);
    }
  }
  const norm = (a) => { let m = 1e-6; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); for (let i = 0; i < a.length; i++) a[i] /= m; };
  norm(body); norm(tex);
  const mk = (data) => { const b = ctx.createBuffer(1, len, sr); b.getChannelData(0).set(data); return b; };
  return { body: mk(body), tex: mk(tex), cfg: e };
}

export class EngineAudio {
  constructor() { this.ctx = null; this.muted = false; this.loopKind = null; this.volume = 1; }

  // master volume 0..1 (settings); everything, one-shots included, goes through this.out
  setVolume(v) { this.volume = v; if (this.out) this.out.gain.value = v; }

  start(kind) {
    if (this.ctx) { this.kind = kind; return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.kind = kind;
    this.cache = {};

    // output: gentle compressor/limiter so nothing clips
    this.master = ctx.createGain(); this.master.gain.value = 0.0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 6; comp.attack.value = 0.005; comp.release.value = 0.15;
    this.out = ctx.createGain(); this.out.gain.value = this.volume; this.out.connect(ctx.destination);
    this.master.connect(comp); comp.connect(this.out);

    // body path: soft saturation -> low shelf -> low-pass (opens with throttle/rpm)
    this.bodyIn = ctx.createGain(); this.bodyIn.gain.value = 1;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) { const x = (i / 128) - 1; curve[i] = Math.tanh(x * 1.6); }
    shaper.curve = curve;
    const shelf = ctx.createBiquadFilter(); shelf.type = 'lowshelf'; shelf.frequency.value = 160; shelf.gain.value = 7;
    this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.Q.value = 0.8; this.filter.frequency.value = 160;
    this.bodyIn.connect(shaper); shaper.connect(shelf); shelf.connect(this.filter); this.filter.connect(this.master);

    // texture path: noise bursts, low-passed, level follows throttle
    this.texFilter = ctx.createBiquadFilter(); this.texFilter.type = 'lowpass'; this.texFilter.frequency.value = 400; this.texFilter.Q.value = 0.7;
    this.texGain = ctx.createGain(); this.texGain.gain.value = 0;
    this.texFilter.connect(this.texGain); this.texGain.connect(this.master);

    // intake / roar noise bed (only audible at high throttle)
    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;
    this.noise = ctx.createBufferSource(); this.noise.buffer = nb; this.noise.loop = true;
    this.noiseBand = ctx.createBiquadFilter(); this.noiseBand.type = 'lowpass'; this.noiseBand.frequency.value = 300; this.noiseBand.Q.value = 0.7;
    this.noiseGain = ctx.createGain(); this.noiseGain.gain.value = 0;
    this.noise.connect(this.noiseBand).connect(this.noiseGain).connect(this.master);
    this.noise.start();

    // very subtle low driveline hum, only at speed
    this.whine = ctx.createOscillator(); this.whine.type = 'sine'; this.whine.frequency.value = 70;
    this.whineGain = ctx.createGain(); this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain).connect(this.master);
    this.whine.start();

    this._loadLoops(this.kind);
  }

  // (Re)create the looping pulse sources for the current engine type.
  _loadLoops(kind) {
    const ctx = this.ctx;
    const k = ENGINES[kind] ? kind : 'v8';
    if (!this.cache[k]) this.cache[k] = buildLoops(ctx, k);
    const L = this.cache[k];
    for (const s of [this.bodySrc, this.texSrc]) if (s) { try { s.stop(); } catch (e) { /* already stopped */ } s.disconnect(); }
    this.bodySrc = ctx.createBufferSource(); this.bodySrc.buffer = L.body; this.bodySrc.loop = true;
    this.texSrc = ctx.createBufferSource(); this.texSrc.buffer = L.tex; this.texSrc.loop = true;
    this.bodySrc.playbackRate.value = this.texSrc.playbackRate.value = 1;
    this.bodySrc.connect(this.bodyIn); this.texSrc.connect(this.texFilter);
    this.bodySrc.start(); this.texSrc.start();
    this.loopKind = k;
  }

  setMuted(m) { this.muted = m; }

  update(rpm, throttle, running, wheelSpeed) {
    if (!this.ctx) return;
    const kind = ENGINES[this.kind] ? this.kind : 'v8';
    if (kind !== this.loopKind) this._loadLoops(kind);
    const cfg = ENGINES[kind];
    const t = this.ctx.currentTime;
    const on = running && rpm > 100 ? 1 : 0;
    const k = 0.06;
    const thr = Math.min(1, Math.max(0, throttle));
    const diesel = kind === 'diesel';
    const rate = Math.max(0.05, rpm / BASE_RPM);
    this.bodySrc.playbackRate.setTargetAtTime(rate, t, k);
    this.texSrc.playbackRate.setTargetAtTime(rate, t, k);

    // body low-pass: ~140-250 Hz at idle, opening to ~500-600 Hz under load and rpm
    const open = diesel ? 230 : 260;
    this.filter.frequency.setTargetAtTime(open + rpm * 0.05 + thr * (diesel ? 200 : 300), t, k);
    // texture: more rasp under load; off throttle just a soft burble
    this.texFilter.frequency.setTargetAtTime(220 + rpm * 0.06 + thr * 380, t, k);
    this.texGain.gain.setTargetAtTime(on * cfg.rasp * (0.25 + thr * 0.7) + on * cfg.knock * (0.22 + thr * 0.35), t, k);
    // intake roar: only with throttle and rpm
    const hi = Math.max(0, thr - 0.35) / 0.65 * Math.min(1, rpm / 4500);
    this.noiseBand.frequency.setTargetAtTime(200 + rpm * 0.05, t, k);
    this.noiseGain.gain.setTargetAtTime(on * 0.12 * hi * hi, t, k);
    // driveline hum, barely there
    const sp = Math.abs(wheelSpeed);
    this.whine.frequency.setTargetAtTime(55 + sp * 3, t, 0.15);
    this.whineGain.gain.setTargetAtTime(on * Math.min(0.012, sp * 0.0004), t, 0.15);
    // overall level: body is the main voice
    this.bodyIn.gain.setTargetAtTime(0.55 + thr * 0.35, t, k);
    const vol = this.muted ? 0 : on * (0.08 + thr * 0.045);
    this.master.gain.setTargetAtTime(vol, t, 0.08);
  }

  grind() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 4;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f).connect(g).connect(this.out);
    src.start(t); src.stop(t + 0.4);
  }

  clunk() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.08);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g).connect(this.out); o.start(t); o.stop(t + 0.15);
  }

  starter() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(18, t);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 9; const lg = ctx.createGain(); lg.gain.value = 6;
    lfo.connect(lg).connect(o.frequency);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.15, t); g.gain.setValueAtTime(0.15, t + 0.6); g.gain.exponentialRampToValueAtTime(0.001, t + 0.75);
    o.connect(f).connect(g).connect(this.out); o.start(t); lfo.start(t); o.stop(t + 0.8); lfo.stop(t + 0.8);
  }
}
