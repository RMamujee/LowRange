// Offline render of engine audio (old git HEAD vs current) -> spectral stats + WAVs.
// usage: node test/audio.mjs [path/to/old_audio.js]
import { chromium } from 'playwright';
import fs from 'fs';
const oldSrc = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : null;
const newSrc = fs.readFileSync(new URL('../src/audio.js', import.meta.url), 'utf8');
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {}); // CHROME=path/to/chrome.exe to use a specific browser
const page = await browser.newPage();
const out = new URL('./audio-samples/', import.meta.url);
fs.mkdirSync(out, { recursive: true });
const cases = [['idle', 800, 0.12], ['cruise', 3000, 0.5], ['high', 6500, 1.0]];
const engines = { v8: 800, v6: 800, diesel: 700, boxer: 900 };
const res = await page.evaluate(async ({ srcs, cases, engines }) => {
  const results = [];
  function fft(re, im) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let l = 2; l <= n; l <<= 1) { const a = -2 * Math.PI / l; for (let i = 0; i < n; i += l) for (let k = 0; k < l / 2; k++) { const wr = Math.cos(a * k), wi = Math.sin(a * k); const ur = re[i + k], ui = im[i + k]; const vr = re[i + k + l / 2] * wr - im[i + k + l / 2] * wi, vi = re[i + k + l / 2] * wi + im[i + k + l / 2] * wr; re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + l / 2] = ur - vr; im[i + k + l / 2] = ui - vi; } } }
  function stats(x, sr) {
    const N = 32768, re = new Float64Array(N), im = new Float64Array(N);
    const off = x.length - N; let peak = 0, rms = 0;
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); re[i] = x[off + i] * w; }
    for (const v of x) { peak = Math.max(peak, Math.abs(v)); rms += v * v; } rms = Math.sqrt(rms / x.length);
    fft(re, im);
    let num = 0, den = 0, best = 0, bi = 0, lo = 0, tot = 0, hi = 0; const sp = [];
    for (let i = 1; i < N / 2; i++) { const f = i * sr / N, m = re[i] * re[i] + im[i] * im[i]; if (f > 20 && f < 12000) { num += f * m; den += m; tot += m; if (f < 200) lo += m; if (f > 1000) hi += m; sp.push([f, m]); if (m > best) { best = m; bi = f; } } }
    let acc = 0, roll = 0; for (const [f, m] of sp) { acc += m; if (acc >= 0.95 * tot) { roll = f; break; } }
    return { roll95: roll, pctAbove1k: 100 * hi / tot, centroid: num / den, dominant: bi, pctBelow200: 100 * lo / tot, peak, rms };
  }
  for (const [label, src] of Object.entries(srcs)) {
    if (!src) continue;
    const mod = await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    for (const [kind, idle] of Object.entries(engines)) for (const [cn, rpm0, thr] of cases) {
      const rpm = cn === 'idle' ? idle : rpm0 * (kind === 'diesel' ? 0.45 : 1);
      const off = new OfflineAudioContext(1, 44100 * 2.5, 44100);
      const orig = window.AudioContext; window.AudioContext = function () { return off; };
      const a = new mod.EngineAudio(); a.start(kind); window.AudioContext = orig;
      a.update(rpm, thr, true, 3);
      const buf = await off.startRendering();
      const x = buf.getChannelData(0);
      results.push({ label, kind, case: cn, rpm: Math.round(rpm), ...stats(x.subarray(22050), 44100), pcm: Array.from(x.subarray(22050, 22050 + 44100 * 2)).map(v => Math.round(Math.max(-1, Math.min(1, v)) * 32767)) });
    }
  }
  return results;
}, { srcs: { old: oldSrc, new: newSrc }, cases, engines });
await browser.close();
function wav(pcm) { const b = Buffer.alloc(44 + pcm.length * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(44100, 24); b.writeUInt32LE(88200, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(pcm.length * 2, 40); pcm.forEach((v, i) => b.writeInt16LE(v, 44 + i * 2)); return b; }
console.log('label kind case rpm | centroid Hz | dominant Hz | %energy<200Hz | peak | rms | 95% rolloff Hz | %>1kHz');
for (const r of res) {
  console.log(`${r.label.padEnd(3)} ${r.kind.padEnd(6)} ${r.case.padEnd(6)} ${String(r.rpm).padStart(4)} | ${r.centroid.toFixed(0).padStart(5)} | ${r.dominant.toFixed(0).padStart(5)} | ${r.pctBelow200.toFixed(0).padStart(3)}% | ${r.peak.toFixed(2)} | ${r.rms.toFixed(3)} | ${r.roll95.toFixed(0)} | ${r.pctAbove1k.toFixed(2)}%`);
  if (r.kind === 'v8' || r.case !== 'cruise') fs.writeFileSync(new URL(`${r.label}_${r.kind}_${r.case}.wav`, out), wav(r.pcm));
}
