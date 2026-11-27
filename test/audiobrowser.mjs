// Browser check of the game audio on a running dev server: on every map the game loads with no
// console errors, no AudioContext exists before a real user gesture, audio starts on one, the voice's
// parameters move while driving (playback rate, low-pass, level), the context is suspended in the
// pause menu and resumed after, a rig swap keeps the node count steady, and a page hide (what a map
// change does: it reloads the page) releases every node and closes the context.
// Usage: CHROME=<chrome / edge exe> PORT=5234 node test/audiobrowser.mjs [maps]
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=user-gesture-required'] });
const base = `http://localhost:${process.env.PORT || 5234}/`;
const maps = (process.argv[2] || 'park,race,crawl,jungle,desert').split(',');
let fails = 0;
const check = (ok, msg) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if (!ok) fails++; };

for (const map of maps) {
  console.log(`map ${map}`);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    window.__acs = [];
    const AC = window.AudioContext;
    window.AudioContext = class extends AC { constructor(...a) { super(...a); window.__acs.push(this); } };
  });
  await page.goto(base + '?map=' + map, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.car && !document.getElementById('loading'), null, { timeout: 120000 });
  const sleep = (ms) => page.waitForTimeout(ms);
  check(await page.evaluate(() => window.__acs.length === 0), 'no AudioContext before a user gesture');
  await page.click('.card >> nth=0');
  await page.click('#goBtn');
  await sleep(1200);
  const st0 = await page.evaluate(() => ({ n: window.__acs.length, state: window.__acs[0]?.state, nodes: window.__audio?.nodeCount }));
  check(st0.n === 1 && st0.state === 'running', `audio starts on the click (contexts ${st0.n}, state ${st0.state}, ${st0.nodes} nodes)`);
  const probe = () => page.evaluate(() => { const a = window.__audio; return { rate: a.voice.srcs[0].playbackRate.value, lp: a.engLP.frequency.value, lvl: a.engOut.gain.value, drive: a.voice.gains[0].gain.value, rpm: window.__game.car.dt.rpm, kmh: Math.abs(window.__game.car.speed() * 3.6), tyre: Object.fromEntries(['dirt', 'gravel', 'rock', 'tarmac', 'sand', 'mud', 'water'].map((k) => [k, +a.tyre[k].gain.value.toFixed(4)])) }; });
  await page.evaluate(() => { window.__game.car.dt.autoClutch = true; });
  const idle = await probe();
  if (await page.evaluate(() => window.__game.parkBrake)) await page.keyboard.press('KeyP'); // the parking brake may be on at a spawn
  await page.keyboard.press('ArrowUp'); await sleep(200);
  await page.keyboard.down('KeyW'); await sleep(2500);
  const drive = await probe();
  await page.keyboard.up('KeyW'); await sleep(600);
  const coast = await probe();
  check(drive.rate > idle.rate * 1.05 && drive.lp > idle.lp && drive.drive > idle.drive, `parameters move with throttle: rate ${idle.rate.toFixed(2)} -> ${drive.rate.toFixed(2)}, low-pass ${idle.lp.toFixed(0)} -> ${drive.lp.toFixed(0)} Hz, drive layer ${idle.drive.toFixed(2)} -> ${drive.drive.toFixed(2)} (rpm ${idle.rpm.toFixed(0)} -> ${drive.rpm.toFixed(0)}, ${drive.kmh.toFixed(1)} km/h)`);
  check(coast.drive < drive.drive, `off throttle the drive layer drops: ${drive.drive.toFixed(2)} -> ${coast.drive.toFixed(2)}`);
  const tyreSum = Object.values(drive.tyre).reduce((a, b) => a + b, 0);
  check(drive.kmh < 1 || tyreSum > 0, `tyres speak when rolling: ${JSON.stringify(drive.tyre)}`);
  // pause menu suspends, resume brings it back
  await page.keyboard.press('Escape'); await sleep(900);
  const ps = await page.evaluate(() => window.__acs[0].state);
  await page.keyboard.press('Escape'); await sleep(500);
  const rs = await page.evaluate(() => window.__acs[0].state);
  check(ps === 'suspended' && rs === 'running', `pause suspends the context (${ps}), resume runs it again (${rs})`);
  // rig swap in place: node count steady once the old voice has faded out
  const n1 = await page.evaluate(() => window.__audio.nodeCount);
  await page.evaluate(async () => { const a = window.__audio; const e = window.__game.car.spec.engine; a.start({ ...e, sound: e.sound === 'diesel' ? 'v6' : 'diesel' }); a.update({ rpm: 900, throttle: 0, running: true }); await new Promise((r) => setTimeout(r, 600)); a.start(e); a.update({ rpm: 900, throttle: 0, running: true }); await new Promise((r) => setTimeout(r, 600)); });
  const n2 = await page.evaluate(() => window.__audio.nodeCount);
  check(n2 === n1, `rig swaps keep the node count steady (${n1} -> ${n2})`);
  // settings overlay (F10): engine / effects volume and mute reach the voice
  if (map === maps[0]) {
    await page.keyboard.press('F10'); await sleep(200);
    await page.evaluate(() => { const r = document.getElementById('lrSettings'); const set = (k, v) => { const el = r.querySelector(`[data-k=${k}]`); el.value = v; el.dispatchEvent(new Event('input')); }; set('engineVolume', 40); set('effectsVolume', 70); });
    await page.click('#lrSettings [data-k=mute]'); await sleep(300);
    const m = await page.evaluate(() => ({ mix: { ...window.__audio.mix }, master: window.__audio.master.gain.value, saved: JSON.parse(localStorage.getItem('lowrange.settings.v1')) }));
    await page.click('#lrSettings [data-k=mute]'); await sleep(200);
    await page.keyboard.press('F10');
    check(m.mix.engine === 0.4 && m.mix.effects === 0.7 && m.mix.mute === true && m.master < 0.01 && m.saved.mute === true && m.saved.engineVolume === 0.4, `settings: engine ${m.mix.engine}, effects ${m.mix.effects}, mute ${m.mix.mute} (master ${m.master.toFixed(3)}), saved`);
  }
  // a map change reloads the page: pagehide must release everything
  const hide = await page.evaluate(async () => { dispatchEvent(new Event('pagehide')); await new Promise((r) => setTimeout(r, 200)); return { state: window.__acs[0].state, nodes: window.__audio.nodeCount }; });
  check(hide.state === 'closed' && hide.nodes === 0, `page hide closes the context (${hide.state}) and releases all nodes (${hide.nodes})`);
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await page.close();
}
// a map switch (?go=1 reload) must not start audio before a gesture
{
  console.log('map switch reload (?go=1)');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => { window.__acs = []; const AC = window.AudioContext; window.AudioContext = class extends AC { constructor(...a) { super(...a); window.__acs.push(this); } }; });
  await page.goto(base + '?map=race&car=1&go=1', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.car && !document.getElementById('loading'), null, { timeout: 120000 });
  await page.waitForTimeout(800);
  // (headless Chrome may report sticky activation after a navigation; then the context may start, and must be running)
  const pre = await page.evaluate(() => ({ n: window.__acs.length, ua: navigator.userActivation.hasBeenActive, state: window.__acs[0]?.state }));
  check(pre.ua ? pre.n <= 1 && (pre.n === 0 || pre.state === 'running') : pre.n === 0, `driving after a reload: no AudioContext until the page has user activation (activation ${pre.ua}, contexts ${pre.n}${pre.n ? ', ' + pre.state : ''})`);
  await page.keyboard.press('KeyW'); await page.waitForTimeout(800);
  const s = await page.evaluate(() => ({ n: window.__acs.length, state: window.__acs[0]?.state, voice: !!window.__audio?.voice }));
  check(s.n === 1 && s.state === 'running' && s.voice, `first key press starts it (contexts ${s.n}, ${s.state}, voice ${s.voice})`);
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await page.close();
}
await browser.close();
console.log(fails ? `${fails} check(s) FAILED` : 'all browser audio checks passed');
process.exit(fails ? 1 : 0);
