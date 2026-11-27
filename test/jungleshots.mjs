// Coralume Island (src/maps/jungle.js) in a real browser: load time, console errors, frame cost,
// and a set of named screenshots: drives (the truck teleported to a spawn point, chase camera),
// the big map and the spawn list, then free-camera views (the game loop is stopped and frames are
// rendered from fixed poses: aerial, summit view, crawls from above).
//   CHROME=<chrome.exe> PORT=5215 node test/jungleshots.mjs <outdir> [only=name,name] [rig=0|1|2]
import { chromium } from 'playwright';
import fs from 'node:fs';
const out = process.argv[2] || 'test/shots/jungle';
const only = process.argv[3] && process.argv[3] !== 'all' ? new Set(process.argv[3].split(',')) : null;
const rig = +(process.argv[4] || 1);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: process.env.GPU === '1' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: +(process.env.VW || 1600), height: +(process.env.VH || 900) } });
const errors = [], warns = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (m.type() === 'warning') warns.push(m.text()); });
const t0 = Date.now();
await page.goto(`http://localhost:${process.env.PORT || 5215}/?map=jungle`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 180000 });
const loadMs = Date.now() - t0;
console.log(JSON.stringify({ loadMs }));
const want = (n) => !only || only.has(n);
const shot = async (name) => { await page.screenshot({ path: `${out}/${name}.png` }); console.log('shot', name); };

// start driving with the chosen rig
await page.evaluate(async (rig) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelectorAll('.card')[rig]?.click();
  document.getElementById('goBtn').click();
  await sleep(2500);
}, rig);

// ---- drives: spawn point + chase camera (yaw offset, pitch, distance) ----
const drives = [
  ['village', 'trailhead', [2.6, 0.32, 11]],
  ['coast_road', 'north-cliffs', [0.5, 0.22, 10]],
  ['hairpin', 'pass', [2.4, 0.3, 13]],
  ['dirt_track', 'fern-gully', [0.3, 0.3, 9]],
  ['plantation_falls', 'falls', [-0.6, 0.35, 13]],
  ['beach', 'crescent-beach', [1.2, 0.25, 10]],
  ['surf', 'sunrise-beach', [-1.2, 0.28, 12]],
  ['dock', 'dock', [0.4, 0.4, 14]],
  ['west_cove', 'west-cove', [3.14, 0.22, 10]],
  ['summit_lot', 'summit', [3.1, 0.3, 14]],
  ['rim_view', 'rim', [3.14, 0.18, 9]],
  ['lighthouse', 'lighthouse', [2.5, 0.35, 16]],
  ['crawl_ledge', 'cliffside-ledge-start', [3.1, 0.35, 12]],
  ['crawl_riverbed', 'riverbed-run-start', [3.1, 0.35, 12]],
  ['crawl_basalt', 'basalt-garden-start', [3.1, 0.35, 12]],
  ['crawl_stairs', 'ember-stairs-start', [3.1, 0.4, 14]],
];
for (const [name, id, cam] of drives) {
  if (!want(name)) continue;
  const r = await page.evaluate(async ({ id, cam }) => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const g = window.__game, sp = g.spawns.find((s) => s.id === id);
    if (!sp) return { missing: id, have: g.spawns.map((s) => s.id) };
    g.spawnAt(sp);
    await sleep(1800);
    Object.assign(g.cam, { yaw: cam[0], pitch: cam[1], dist: cam[2], lastDrag: 1e9 });
    await sleep(1600);
    const p = g.car.chassis.translation();
    return { id, pos: [p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1)] };
  }, { id, cam });
  console.log(JSON.stringify(r));
  if (!r.missing) await shot(name);
}

// ---- frame cost at the village (pipeline render timed with a 1 px readback) ----
if (want('perf')) {
  const perf = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const g = window.__game; g.spawnAt(g.spawns[0]); await sleep(2500);
    const { renderer, pixels, scene, camera, sun } = g.gfx, gl = renderer.getContext(), px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let i = 0; i < 5; i++) pixels.render(scene, camera, sun);
    sync(); const t = performance.now(); for (let i = 0; i < 30; i++) { pixels.render(scene, camera, sun); sync(); }
    const ms = (performance.now() - t) / 30;
    renderer.info.autoReset = false; renderer.info.reset(); pixels.render(scene, camera, sun);
    const r = { frameMs: +ms.toFixed(2), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    renderer.info.autoReset = true;
    return r;
  });
  console.log(JSON.stringify({ perf }));
}

// ---- big map and the spawn list ----
if (want('bigmap')) {
  await page.evaluate(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' })); await sleep(60); dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyM' })); await sleep(1500); });
  await shot('bigmap');
  await page.evaluate(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' })); await sleep(60); dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyM' })); await sleep(500); });
}
if (want('spawnlist')) {
  await page.evaluate(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' })); await sleep(60); dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ' })); await sleep(1500); });
  await shot('spawnlist');
  await page.evaluate(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' })); await sleep(60); dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ' })); await sleep(500); });
}

// ---- free camera: stop the loop, render fixed poses ----
const views = [
  ['aerial', [520, 380, 640], [20, 0, -20]],
  ['aerial_south', [60, 160, 620], [20, 20, 120]],
  ['summit_view', null, null], // from the crater rim, looking out over the bay
  ['aerial_lava', [480, 90, -60], [330, 5, -215]],
  ['aerial_falls', [300, 70, -30], [245, 30, -88]],
];
if (views.some(([n]) => want(n))) {
  await page.evaluate(() => { window.__raf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; });
  await new Promise((r) => setTimeout(r, 300));
  for (const [name, pos, look] of views) {
    if (!want(name)) continue;
    await page.evaluate(async ({ pos, look }) => {
      const T = await import('/src/terrain.js'), V = await import('/src/art/jungle/view.js');
      const { pixels, scene, camera, sun } = window.__game.gfx;
      if (!pos) { const R = T.MAP.RIM, B = T.MAP.VILLAGE; pos = [R.x, R.h + 9, R.z]; look = [B.x, 0, B.z + 60]; }
      camera.position.set(...pos); camera.lookAt(...look); camera.updateMatrixWorld();
      // aerials: thin the haze so the whole island reads (the game's fog is tuned for driving)
      scene.fog.near = pos[1] > 120 ? 700 : 190; scene.fog.far = pos[1] > 120 ? 2400 : 860;
      sun.position.set(look[0] - 36, look[1] + 64, look[2] + 28); sun.target.position.set(...look);
      V.update(camera, 10, null);
      pixels.render(scene, camera, sun);
    }, { pos, look });
    await shot(name);
  }
}
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
console.log('warnings:', warns.filter((w) => !/GPU stall|Automatic fallback/.test(w)).slice(0, 8));
await browser.close();
