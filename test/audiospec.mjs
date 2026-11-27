// Engine and tyre audio by the numbers: renders the synth offline (OfflineAudioContext in headless
// Chromium) at fixed operating points per rig, measures each render and asserts the comfort rules.
// Runs the old synth (test/lib/audio_baseline.js, the voice before the heavy-engine rework) through
// the same points and prints a before / after table, so the whine detector can be seen to fail on
// the old voice and pass on the new one.
//
// usage: node test/audiospec.mjs            (asserts; exit 1 on a failure)
//        WAV=<dir> node test/audiospec.mjs  (also writes short 22 kHz mono previews per rig: new_*.wav;
//                                            old_*.wav go to WAV_OLD=<dir> if given, else they are skipped)
//        CHROME=<chrome / edge exe>         (use a specific browser)
//
// Measures per render: peak, RMS, spectral centroid, share of energy below 400 Hz, the strongest
// partials, and the whine score: the loudest NARROW partial above 1 kHz (stands 12 dB over the
// spectrum around it, less than 25 Hz wide) relative to the loudest partial below 400 Hz, in dB.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { ALL_VEHICLES } from '../src/specs.js';

// both voices are served from the repo on a routed origin, so their relative imports resolve
const ROOT = new URL('../', import.meta.url);
const srcs = { old: 'http://audio.test/test/lib/audio_baseline.js', new: 'http://audio.test/src/audio.js' };
const RIGS = ['lc70', 'taco', 'wrx'].map((id) => { const v = ALL_VEHICLES.find((x) => x.id === id); return { id, engine: v.engine, radius: v.tire.radius }; });
const WAV_DIR = process.env.WAV || '', WAV_OLD = process.env.WAV_OLD || '';

// limits (new voice). The old voice is measured against the same numbers for the table.
const LIM = {
  peak: 0.89,            // -1 dBFS: headroom, no clipping
  centroidIdle: 120,     // Hz, idle
  centroidCrawl: 200,    // Hz, crawl under load in 4-Low
  below400Crawl: 0.9,    // share of energy below 400 Hz at crawl
  whine: -30,            // dB: no narrow partial above 1 kHz within 30 dB of the low engine note
  whineMid: -10,         // dB: no narrow partial at 450-1000 Hz within 10 dB of it (the old voice's buzz)
};

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console error', m.text()); });
await page.route('http://audio.test/**', (route) => {
  const p = new URL(route.request().url()).pathname.slice(1);
  const f = new URL(p, ROOT);
  if (!p || !fs.existsSync(f)) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>audio</title>' });
  route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f, 'utf8') });
});
await page.goto('http://audio.test/');

const res = await page.evaluate(async ({ srcs, RIGS, WAV }) => {
  const SR = 44100;
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let l = 2; l <= n; l <<= 1) {
      const a = -2 * Math.PI / l;
      for (let i = 0; i < n; i += l) for (let k = 0; k < l / 2; k++) {
        const wr = Math.cos(a * k), wi = Math.sin(a * k), p = i + k, q = p + l / 2;
        const vr = re[q] * wr - im[q] * wi, vi = re[q] * wi + im[q] * wr;
        re[q] = re[p] - vr; im[q] = im[p] - vi; re[p] += vr; im[p] += vi;
      }
    }
  }
  // Welch power spectrum (Hann, 16384, 50% overlap)
  function spectrum(x, sr) {
    const N = 16384, P = new Float64Array(N / 2); let nseg = 0;
    for (let off = 0; off + N <= x.length; off += N / 2) {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) re[i] = x[off + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
      fft(re, im);
      for (let i = 0; i < N / 2; i++) P[i] += re[i] * re[i] + im[i] * im[i];
      nseg++;
    }
    for (let i = 0; i < N / 2; i++) P[i] /= Math.max(1, nseg);
    return { P, df: sr / N };
  }
  function stats(x, sr) {
    let peak = 0, ss = 0;
    for (const v of x) { peak = Math.max(peak, Math.abs(v)); ss += v * v; }
    const rms = Math.sqrt(ss / x.length);
    const { P, df } = spectrum(x, sr);
    let num = 0, den = 0, lo = 0, hi6 = 0;
    for (let i = 1; i < P.length; i++) { const f = i * df; if (f < 20) continue; num += f * P[i]; den += P[i]; if (f < 400) lo += P[i]; if (f > 6000) hi6 += P[i]; }
    const dB = (p) => 10 * Math.log10(p + 1e-30);
    // local maxima (partials)
    const peaks = [];
    for (let i = 3; i < P.length - 3; i++) {
      if (P[i] > P[i - 1] && P[i] >= P[i + 1] && P[i] > P[i - 2] && P[i] >= P[i + 2]) peaks.push(i);
    }
    const lowRef = Math.max(...peaks.filter((i) => i * df > 20 && i * df < 400).map((i) => P[i]), 1e-30);
    // narrow + prominent partials in [f0, f1): stand 12 dB over the median within +-200 Hz, under 25 Hz wide
    const narrow = (f0, f1) => {
      let best = -200, bf = 0;
      for (const i of peaks) {
        const f = i * df;
        if (f < f0 || f >= f1) continue;
        const w = Math.round(200 / df), arr = [];
        for (let k = Math.max(1, i - w); k < Math.min(P.length, i + w); k++) arr.push(P[k]);
        arr.sort((a, b) => a - b);
        if (dB(P[i]) - dB(arr[arr.length >> 1]) < 12) continue;
        let a = i, b = i; while (a > 1 && P[a] > P[i] / 2) a--; while (b < P.length - 1 && P[b] > P[i] / 2) b++;
        if ((b - a) * df > 25) continue;
        const rel = dB(P[i]) - dB(lowRef);
        if (rel > best) { best = rel; bf = f; }
      }
      return [best, bf];
    };
    const [whine, whineF] = narrow(1000, 20000), [whineMid, whineMidF] = narrow(450, 1000);
    const sorted = peaks.map((i) => [i * df, dB(P[i]) - dB(lowRef)]);
    sorted.sort((a, b) => b[1] - a[1]);
    return { peak, rms, centroid: num / den, below400: lo / den, above6k: hi6 / den, whine, whineF, whineMid, whineMidF, partials: sorted.slice(0, 5).map(([f, d]) => [Math.round(f), +d.toFixed(1)]) };
  }

  const wheels = (mat, kmh, radius, slip = 0.02) => [0, 1, 2, 3].map(() => ({ grounded: true, mat, spin: kmh / 3.6 / radius, slip, load: 5000 }));
  const MAT = { DIRT: 1, ROCK: 2, GRAVEL: 5 };
  function points(rig) {
    const e = rig.engine, r = (x) => Math.min(x, e.redline * 0.97);
    const P = [
      ['idle', { rpm: e.idle, throttle: 0.04, load: 0.05, gear: 0, kmh: 0 }],
      ['1500on', { rpm: r(1500), throttle: 1, load: 0.85, gear: 2, kmh: 0 }],
      ['1500off', { rpm: r(1500), throttle: 0, load: 0, gear: 2, kmh: 0 }],
      ['2500on', { rpm: r(2500), throttle: 1, load: 0.85, gear: 2, kmh: 0 }],
      ['2500off', { rpm: r(2500), throttle: 0, load: 0, gear: 2, kmh: 0 }],
      ['4000on', { rpm: r(4000), throttle: 1, load: 0.85, gear: 2, kmh: 0 }],
      ['4000off', { rpm: r(4000), throttle: 0, load: 0, gear: 2, kmh: 0 }],
      ['5500on', { rpm: r(5500), throttle: 1, load: 0.85, gear: 3, kmh: 0 }],
      ['crawl', { rpm: 1300, throttle: 0.7, load: 1, gear: 1, range: 'low', kmh: 3, mat: MAT.ROCK }],
      ['kmh20', { rpm: 2000, throttle: 0.3, load: 0.4, gear: 2, kmh: 20, mat: MAT.GRAVEL }],
      ['kmh60', { rpm: 2600, throttle: 0.35, load: 0.45, gear: 4, kmh: 60, mat: MAT.DIRT }],
    ];
    return P.map(([n, s]) => [n, { running: true, range: 'high', ...s, wheels: wheels(s.mat ?? MAT.DIRT, s.kmh, rig.radius) }]);
  }

  // Render one synth for `secs`, calling update(state(t)) every 1/30 s like the game loop does.
  async function render(label, rig, stateAt, secs, sr = SR, opts = {}) {
    const mod = await import(srcs[label]);
    const off = new OfflineAudioContext(1, Math.round(sr * secs), sr);
    let a;
    if (label === 'old') {
      const orig = window.AudioContext; window.AudioContext = function () { return off; };
      a = new mod.EngineAudio(); a.start(rig.engine.sound); window.AudioContext = orig;
    } else {
      a = new mod.EngineAudio({ context: off });
      a.start(rig.engine);
      if (opts.mute) a.setMix({ mute: true });
    }
    const step = 1 / 30;
    const upd = (t) => {
      if (opts.at) opts.at(a, t);
      const s = stateAt(t);
      if (label === 'old') a.update(s.rpm, s.throttle, s.running, s.kmh / 3.6 / rig.radius);
      else a.update({ ...s, dt: step });
    };
    upd(0);
    for (let t = step; t < secs - step; t += step) {
      const tt = Math.round(t * sr / 128) * 128 / sr; // suspend times must sit on render quanta
      off.suspend(tt).then(() => { upd(tt); off.resume(); });
    }
    const buf = await off.startRendering();
    return { x: buf.getChannelData(0), nodes: a.nodeCount ?? null, a };
  }

  const out = [];
  for (const rig of RIGS) for (const [name, st] of points(rig)) for (const label of ['old', 'new']) {
    const { x, nodes } = await render(label, rig, () => st, 3);
    const s = stats(x.subarray(SR * 1), SR);
    out.push({ label, rig: rig.id, pt: name, rpm: Math.round(st.rpm), cyl: null, nodes, ...s });
  }
  // level follows throttle and mute silences (new voice)
  const extra = {};
  for (const rig of RIGS) {
    const e = rig.engine;
    const st = (thr, load) => ({ running: true, rpm: 1800, throttle: thr, load, gear: 2, range: 'high', kmh: 0, wheels: wheels(1, 0, rig.radius) });
    const lv = [];
    for (const [thr, load] of [[0, 0], [0.5, 0.45], [1, 0.9]]) { const { x } = await render('new', rig, () => st(thr, load), 2); lv.push(stats(x.subarray(SR), SR).rms); }
    const { x: xm } = await render('new', rig, () => st(1, 0.9), 2, SR, { mute: true });
    extra[rig.id] = { rmsByThrottle: lv, mutedPeak: stats(xm.subarray(SR / 2), SR).peak, idleRpm: e.idle };
  }
  // tyres and ground alone (engine off), scrub on rock, winch, and a rig swap releasing the old voice
  const rig0 = RIGS[0], ground = {};
  const off = (kmh, mat, slip, extraS = {}) => () => ({ running: false, rpm: 0, throttle: 0, load: 0, gear: 0, range: 'high', kmh, wheels: wheels(mat, kmh, rig0.radius, slip), ...extraS });
  for (const [name, mat, kmh] of [['dirt', 1, 40], ['gravel', 5, 40], ['rock', 2, 6], ['tarmac', 7, 60], ['sand', 4, 30], ['mud', 3, 12], ['water', 8, 15]]) {
    const { x } = await render('new', rig0, off(kmh, mat, 0.05), 2.5);
    ground[name] = stats(x.subarray(SR), SR);
  }
  { const { x } = await render('new', rig0, off(3, 2, 2.0), 2.5); ground.scrub = stats(x.subarray(SR), SR); }
  { const { x } = await render('new', rig0, off(3, 2, 0.02), 2.5); ground.noScrub = stats(x.subarray(SR), SR); }
  { const { x } = await render('new', rig0, off(0, 1, 0, { winch: { running: true, load: 0.8, direction: 'in' } }), 2.5); ground.winch = stats(x.subarray(SR), SR); }
  const quiet = await render('new', rig0, off(0, 1, 0), 1);
  const swap = await render('new', rig0, () => ({ running: true, rpm: 1200, throttle: 0.3, load: 0.3, gear: 1, range: 'high', kmh: 0, wheels: wheels(1, 0, rig0.radius) }), 2, SR,
    { at: (a, t) => { if (Math.abs(t - 0.5) < 0.02) a.start(RIGS[1].engine); if (Math.abs(t - 1.0) < 0.02) a.start(RIGS[2].engine); } });
  // cost: render 10 s of the whole graph (engine under load + gravel + scrub) as fast as it goes, and time update()
  { let ut = 0, un = 0; const busy = (t) => ({ running: true, rpm: 1500 + 500 * Math.sin(t), throttle: 0.6, load: 0.7, gear: 2, range: 'high', kmh: 25, wheels: wheels(5, 25, rig0.radius, 0.5 + 0.5 * Math.sin(t * 3)), scrape: t * 2 });
    const t0 = performance.now();
    const timed = (a) => { if (a.__timed) return; a.__timed = true; const u = a.update; a.update = function (...x) { const q = performance.now(); u.apply(this, x); ut += performance.now() - q; un++; }; };
    await render('new', rig0, busy, 10, 48000, { at: timed });
    extra.cost = { msPerSec: (performance.now() - t0) / 10, updateMs: ut / Math.max(1, un) }; }
  extra.ground = ground; extra.nodesQuiet = quiet.nodes; extra.nodesAfterSwaps = swap.nodes; extra.swapPeak = stats(swap.x, SR).peak;
  // previews: idle, crawl under load, rev sweep (22 kHz mono), as 16-bit PCM arrays
  const wav = {};
  if (WAV) {
    for (const rig of RIGS) for (const label of ['old', 'new']) {
      const e = rig.engine;
      const idle = () => ({ running: true, rpm: e.idle, throttle: 0.04, load: 0.05, gear: 0, range: 'high', kmh: 0, wheels: wheels(1, 0, rig.radius) });
      const crawl = (t) => ({ running: true, rpm: 1150 + 250 * Math.sin(t * 1.3), throttle: 0.55 + 0.35 * Math.sin(t * 0.9), load: 0.9, gear: 1, range: 'low', kmh: 3 + Math.sin(t), wheels: wheels(2, 3 + Math.sin(t), rig.radius, t % 1.7 < 0.25 ? 0.4 : 0.03) });
      const sweep = (t) => { const u = Math.min(1, t / 2.2), d = Math.max(0, (t - 2.6) / 1.4), rpm = t < 2.6 ? e.idle + (e.redline * 0.95 - e.idle) * u * u : Math.max(e.idle, e.redline * 0.95 - (e.redline * 0.95 - e.idle) * d); return { running: true, rpm, throttle: t < 2.6 ? 1 : 0, load: t < 2.6 ? 0.8 : 0, gear: 2, range: 'high', kmh: 0, wheels: wheels(1, 0, rig.radius) }; };
      const drive = (t) => ({ running: true, rpm: 2200 + 200 * Math.sin(t), throttle: 0.4, load: 0.45, gear: 3, range: 'high', kmh: 45, wheels: wheels(t < 2 ? 5 : 1, 45, rig.radius) });
      for (const [n, f, secs] of [['idle', idle, 2.5], ['crawl', crawl, 3], ['sweep', sweep, 4.2], ['gravel45', drive, 3]]) {
        if (label === 'old' && n !== 'sweep') continue;
        const { x } = await render(label, rig, f, secs, 22050);
        wav[`${label}_${rig.id}_${n}`] = Array.from(x, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767));
      }
    }
  }
  return { out, extra, wav };
}, { srcs, RIGS, WAV: !!WAV_DIR });
await browser.close();

// ---------- report ----------
const row = (r) => `${r.rig.padEnd(5)} ${r.pt.padEnd(8)} ${String(r.rpm).padStart(4)} | ${r.label.padEnd(3)} | pk ${r.peak.toFixed(2)} rms ${r.rms.toFixed(3)} | cen ${r.centroid.toFixed(0).padStart(4)} | <400 ${(r.below400 * 100).toFixed(0).padStart(3)}% | >6k ${(r.above6k * 100).toFixed(2).padStart(5)}% | mid ${r.whineMid > -199 ? r.whineMid.toFixed(1).padStart(6) + ' dB @' + r.whineMidF.toFixed(0).padStart(4) : '  none       '} | hi ${r.whine > -199 ? r.whine.toFixed(1).padStart(6) + ' dB @' + r.whineF.toFixed(0).padStart(5) : '  none        '} | ${r.partials.map(([f, d]) => f + ':' + d).join(' ')}`;
console.log('rig   point     rpm | ver | level | centroid Hz | energy <400 Hz | >6 kHz | narrow partial 450-1000 Hz / above 1 kHz vs low note | top partials Hz:dB');
for (const r of res.out) console.log(row(r));

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const verdicts = { old: 0, new: 0 };
console.log('\nbefore / after (old -> new)');
console.log('rig   point    | centroid Hz    | <400 Hz      | mid whine dB (450-1000) | hi whine dB (>1k) | peak');
for (const rig of RIGS) for (const pt of [...new Set(res.out.map((r) => r.pt))]) {
  const o = res.out.find((r) => r.rig === rig.id && r.pt === pt && r.label === 'old');
  const n = res.out.find((r) => r.rig === rig.id && r.pt === pt && r.label === 'new');
  const w = (r) => (r.whine > -199 ? r.whine.toFixed(1) : 'none'), wm = (r) => (r.whineMid > -199 ? r.whineMid.toFixed(1) : 'none');
  console.log(`${rig.id.padEnd(5)} ${pt.padEnd(8)} | ${o.centroid.toFixed(0).padStart(5)} -> ${n.centroid.toFixed(0).padStart(4)} | ${(o.below400 * 100).toFixed(0).padStart(3)}% -> ${(n.below400 * 100).toFixed(0).padStart(3)}% | ${wm(o).padStart(6)} -> ${wm(n).padStart(6)}        | ${w(o).padStart(6)} -> ${w(n).padStart(6)} | ${o.peak.toFixed(2)} -> ${n.peak.toFixed(2)}`);
}
console.log('');
for (const label of ['old', 'new']) {
  const R = res.out.filter((r) => r.label === label);
  const tag = label === 'old' ? '[old voice, expected to fail] ' : '';
  let bad = 0;
  const c = (ok, msg) => { if (label === 'new') check(ok, msg); else { console.log(`${ok ? 'pass' : 'fail'} ${tag}${msg}`); if (!ok) bad++; } };
  const worstWhine = R.reduce((m, r) => (r.whine > m.whine ? r : m), R[0]);
  c(R.every((r) => r.peak <= LIM.peak), `no clipping: max peak ${Math.max(...R.map((r) => r.peak)).toFixed(2)} <= ${LIM.peak}`);
  const worstMid = R.reduce((m, r) => (r.whineMid > m.whineMid ? r : m), R[0]);
  c(worstMid.whineMid <= LIM.whineMid, `mid-band buzz: worst narrow partial at 450-1000 Hz ${worstMid.whineMid.toFixed(1)} dB (${worstMid.rig} ${worstMid.pt} @ ${worstMid.whineMidF.toFixed(0)} Hz) <= ${LIM.whineMid} dB`);
  c(worstWhine.whine <= LIM.whine, `whine detector: worst narrow partial above 1 kHz ${worstWhine.whine.toFixed(1)} dB (${worstWhine.rig} ${worstWhine.pt} @ ${worstWhine.whineF.toFixed(0)} Hz) <= ${LIM.whine} dB`);
  for (const rig of RIGS) {
    const idle = R.find((r) => r.rig === rig.id && r.pt === 'idle'), crawl = R.find((r) => r.rig === rig.id && r.pt === 'crawl');
    c(idle.centroid <= LIM.centroidIdle, `${rig.id} idle centroid ${idle.centroid.toFixed(0)} Hz <= ${LIM.centroidIdle}`);
    c(crawl.centroid <= LIM.centroidCrawl, `${rig.id} crawl centroid ${crawl.centroid.toFixed(0)} Hz <= ${LIM.centroidCrawl}`);
    c(crawl.below400 >= LIM.below400Crawl, `${rig.id} crawl energy below 400 Hz ${(crawl.below400 * 100).toFixed(0)}% >= ${LIM.below400Crawl * 100}%`);
  }
  verdicts[label] = bad;
}
for (const rig of RIGS) {
  const o = res.out.filter((r) => r.rig === rig.id && r.label === 'old'), n = res.out.filter((r) => r.rig === rig.id && r.label === 'new');
  for (const pt of ['idle', 'crawl']) {
    const a = o.find((r) => r.pt === pt).centroid, b = n.find((r) => r.pt === pt).centroid;
    // the old voice was already dark by centroid (its problem was tonal, see the whine rules): the new one must not be brighter
    check(b <= a, `${rig.id} ${pt} centroid not above the old voice: ${a.toFixed(0)} -> ${b.toFixed(0)} Hz`);
  }
  const x = res.extra[rig.id];
  check(x.rmsByThrottle[0] < x.rmsByThrottle[1] && x.rmsByThrottle[1] < x.rmsByThrottle[2], `${rig.id} level rises with throttle: rms ${x.rmsByThrottle.map((v) => v.toFixed(3)).join(' < ')}`);
  check(x.mutedPeak < 1e-4, `${rig.id} silent when muted: peak ${x.mutedPeak.toExponential(1)}`);
}
const G = res.extra.ground;
console.log('\nground (engine off): surface | rms | centroid Hz | energy <400 Hz | >6 kHz');
for (const [k, g] of Object.entries(G)) console.log(`  ${k.padEnd(8)} | ${g.rms.toFixed(3)} | ${g.centroid.toFixed(0).padStart(5)} | ${(g.below400 * 100).toFixed(0).padStart(3)}% | ${(g.above6k * 100).toFixed(2)}%`);
for (const k of ['dirt', 'gravel', 'rock', 'tarmac', 'sand', 'mud', 'water']) check(G[k].rms > 0.004 && G[k].centroid < 1100 && G[k].above6k < 0.01, `${k}: rolling sound present and low (rms ${G[k].rms.toFixed(3)}, centroid ${G[k].centroid.toFixed(0)} Hz < 1100, >6 kHz ${(G[k].above6k * 100).toFixed(2)}% < 1%)`);
check(G.tarmac.rms < G.gravel.rms, `tarmac hum kept below gravel crunch (${G.tarmac.rms.toFixed(3)} < ${G.gravel.rms.toFixed(3)})`);
check(G.scrub.rms > G.noScrub.rms * 1.5 && G.scrub.centroid < 1200 && G.scrub.whine < -30, `scrub on rock: slip raises it (rms ${G.noScrub.rms.toFixed(3)} -> ${G.scrub.rms.toFixed(3)}), low-mid (centroid ${G.scrub.centroid.toFixed(0)} Hz < 1200), no squeal (narrow partial ${G.scrub.whine.toFixed(0)} dB)`);
check(G.winch.rms > 0.01 && G.winch.centroid < 300 && G.winch.whine < -30, `winch: deep motor voice (rms ${G.winch.rms.toFixed(3)}, centroid ${G.winch.centroid.toFixed(0)} Hz < 300, narrow partial >1 kHz ${G.winch.whine.toFixed(0)} dB)`);
check(res.extra.nodesAfterSwaps === res.extra.nodesQuiet, `rig swaps release the old voice: ${res.extra.nodesAfterSwaps} nodes after two swaps vs ${res.extra.nodesQuiet} (no winch built without a winch state)`);
check(res.extra.swapPeak <= LIM.peak, `no clipping across rig swaps: peak ${res.extra.swapPeak.toFixed(2)}`);
const nodes = res.out.find((r) => r.label === 'new').nodes;
console.log(`cost: ${res.extra.cost.msPerSec.toFixed(1)} ms to render 1 s of the full graph offline at 48 kHz (about ${(res.extra.cost.msPerSec / 10).toFixed(1)}% of one core, upper bound incl. setup), update() ${(res.extra.cost.updateMs * 1000).toFixed(0)} us per call`);
if (nodes != null) console.log(`audio graph: ${nodes} persistent nodes (new voice)`);
console.log(`old voice: ${verdicts.old} rule(s) failed (the whine rules should fail on it)`);

if (WAV_DIR) {
  fs.mkdirSync(WAV_DIR, { recursive: true });
  const wav = (pcm, sr) => {
    const b = Buffer.alloc(44 + pcm.length * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(pcm.length * 2, 40);
    pcm.forEach((v, i) => b.writeInt16LE(v, 44 + i * 2));
    return b;
  };
  let total = 0;
  if (WAV_OLD) fs.mkdirSync(WAV_OLD, { recursive: true });
  for (const [k, pcm] of Object.entries(res.wav)) { if (k.startsWith('old_') && !WAV_OLD) continue; const p = path.join(k.startsWith('old_') ? WAV_OLD : WAV_DIR, k + '.wav'); const b = wav(pcm, 22050); fs.writeFileSync(p, b); total += b.length; }
  console.log(`wrote ${Object.keys(res.wav).length} previews to ${path.resolve(WAV_DIR)} (${(total / 1048576).toFixed(2)} MB)`);
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall audio checks passed');
process.exit(fails ? 1 : 0);
