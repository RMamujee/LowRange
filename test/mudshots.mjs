// Tyre-effect scenes for judging mud, ruts and dust by eye: a truck spinning and ploughing through
// the Trail Park's Bog Run, the Gauntlet's Bog & Ford, the race track's splash mud, and dust at
// speed on a dry park road and on the race track. Each scene saves a short frame sequence and
// reports the average frame interval while it runs.
//
//   CHROME=<chrome.exe> PORT=5213 node test/mudshots.mjs <outdir> [scene,...]
//   scenes: bog, ruts, crawl, splash, road, race (default: all); PERF=1: frame timing only, no shots;
//   PX=2|3|4: pixel size (default HD 1x)
import { chromium } from 'playwright';
const out = process.argv[2];
if (!out) { console.error('usage: node test/mudshots.mjs <outdir> [scenes]'); process.exit(1); }
const want = (process.argv[3] || 'bog,ruts,crawl,splash,road,race').split(',');
const PERF = !!process.env.PERF; // no screenshots: time the frames over the whole drive
const PX_TAG = process.env.PX ? `_px${process.env.PX}` : '';
const PORT = process.env.PORT || 5213;
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

// place: in-page setup returning { x, z, yaw } (yaw: heading, as spawn points use it)
const SCENES = {
  bog: { qs: '?map=park', car: 1, place: `const T = await import('/src/terrain.js'); const t = T.TRAILS.find((q) => q.name === 'Bog Run'); const p = T.pathPoint(t, t.length * 0.3); window.__mudPath = { path: t, pp: T.pathPoint, lat: 0 }; return { x: p.x, z: p.z, yaw: Math.atan2(-p.tx, -p.tz) };`,
    drive: { gear: 1, range: 'high', lock: true, keys: ['KeyW'], ms: 6000 }, cam: [0.9, 0.28, 7.5], frames: [1500, 3000, 4500, 6000] },
  ruts: { qs: '?map=park', car: 1, place: `const T = await import('/src/terrain.js'); const t = T.TRAILS.find((q) => q.name === 'Bog Run'); const p = T.pathPoint(t, t.length * 0.2); window.__mudPath = { path: t, pp: T.pathPoint, lat: 0 }; return { x: p.x, z: p.z, yaw: Math.atan2(-p.tx, -p.tz) };`,
    drive: { gear: 1, range: 'low', lock: true, keys: ['KeyW'], ms: 12000 }, cam: [2.5, 0.5, 9], frames: [4000, 8000, 12000] },
  crawl: { qs: '?map=crawl', car: 1, place: `const T = await import('/src/maps/crawl.js'); const C = await import('/src/terrain.js'); const st = T.STAGES[7]; const p = C.pathPoint(T.TRAILS[0], st.s0 + st.bog.from + 2); window.__mudPath = { path: T.TRAILS[0], pp: C.pathPoint, lat: 0 }; return { x: p.x, z: p.z, yaw: Math.atan2(-p.tx, -p.tz) };`,
    drive: { gear: 1, range: 'high', lock: false, keys: ['KeyW'], ms: 6000 }, cam: [-0.8, 0.3, 7.5], frames: [1500, 3000, 4500, 6000] },
  splash: { qs: '?map=race', car: 2, place: `const M = await import('/src/maps/racetrack.js'); const f = M.trackFrame(742); const lat = 6; window.__mudPath = { path: M.TRACK, pp: (t, q) => M.trackFrame(q), lat }; return { x: f.x - f.tz * lat, z: f.z + f.tx * lat, yaw: Math.atan2(-f.tx, -f.tz), v: 10 };`,
    drive: { gear: 2, range: 'high', keys: ['KeyW'], ms: 4500 }, cam: [0.5, 0.25, 8], frames: [1500, 2500, 3500, 4500] },
  road: { qs: '?map=park', car: 0, place: `const T = await import('/src/terrain.js'); const r = T.ROADS[0]; const p = T.pathPoint(r, 625); window.__mudPath = { path: r, pp: T.pathPoint, lat: 1.2 }; return { x: p.x, z: p.z, yaw: Math.atan2(-p.tx, -p.tz), v: 16 };`,
    drive: { gear: 3, range: 'high', keys: ['KeyW'], ms: 4000 }, cam: [0.35, 0.22, 9], frames: [1000, 2000, 3000, 4000] },
  race: { qs: '?map=race', car: 2, place: `const M = await import('/src/maps/racetrack.js'); const f = M.trackFrame(152); window.__mudPath = { path: M.TRACK, pp: (t, q) => M.trackFrame(q), lat: 0 }; return { x: f.x, z: f.z, yaw: Math.atan2(-f.tx, -f.tz), v: 20 };`,
    drive: { gear: 4, range: 'high', keys: ['KeyW'], ms: 4000 }, cam: [0.25, 0.2, 9], frames: [1000, 2000, 3000, 4000] },
};

for (const name of want) {
  const sc = SCENES[name];
  if (!sc) { console.log('unknown scene', name); continue; }
  const page = await browser.newPage({ viewport: { width: +(process.env.VW || 1280), height: +(process.env.VH || 720) } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/${sc.qs}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
  if (process.env.PX) await page.evaluate((px) => window.__game.gfx.pixels.setPixelSize(px), +process.env.PX); // pixel size: 1 (HD) .. 4 (Chunky)
  const gl = await page.evaluate(() => { const g = window.__game.gfx.renderer.getContext(); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; });
  await page.evaluate(async ({ car, place }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelectorAll('.card')[car].click();
    document.getElementById('goBtn').click();
    await sleep(1200);
    const sp = await (0, eval)(`(async () => { ${place} })()`);
    window.__game.spawnAt({ ...sp, name: 'shot', kind: 'shot' });
    await sleep(1200);
    window.__mudSpawn = sp;
  }, sc);
  await page.evaluate(async ({ drive, cam }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const g = window.__game, c = g.car, d = c.dt;
    dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP' })); await sleep(50); dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP' }));
    d.range = drive.range; d.gear = drive.gear; if (drive.lock) { d.lockF = !!c.spec.lockers.front; d.lockR = !!c.spec.lockers.rear; }
    const v = window.__mudSpawn.v || 0;
    if (v) { // rolling: every body moving forward, wheels turning to match
      const q = c.chassis.rotation(), fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      for (const b of c.allBodies) b.setLinvel({ x: fx * v, y: 0, z: fz * v }, true);
      c.wheels.forEach((w, i) => { const a = c.wheelAxis(i), s = v / c.spec.tire.radius; w.setAngvel({ x: -a.x * s, y: -a.y * s, z: -a.z * s }, true); });
    }
    // steer along the path (lateral offset lat): the tool wraps car.step so key handling stays as is
    const P = window.__mudPath;
    if (P) {
      let sNow = null; const step0 = c.step.bind(c);
      const near = (x, z) => { let bs = sNow ?? 0, bd = 1e9; const a = sNow == null ? 0 : sNow - 10, b = sNow == null ? P.path.length : sNow + 25; for (let q = Math.max(0, a); q < Math.min(P.path.length, b); q += 0.5) { const f = P.pp(P.path, q); const dd = Math.hypot(f.x - x, f.z - z); if (dd < bd) { bd = dd; bs = q; } } return bs; };
      let n = 0, steer = 0;
      c.step = (inp, h) => {
        if (n++ % 10 === 0) {
          const p = c.chassis.translation(); sNow = near(p.x, p.z);
          const f = P.pp(P.path, sNow + 5 + Math.abs(c.speed()) * 0.5), lx = f.x - f.tz * P.lat, lz = f.z + f.tx * P.lat;
          let err = Math.atan2(-(lx - p.x), -(lz - p.z)) - c.attitude().heading; err = Math.atan2(Math.sin(err), Math.cos(err));
          steer = Math.max(-1, Math.min(1, err * 2.2));
        }
        return step0({ ...inp, steer }, h);
      };
    }
    g.cam.yaw = cam[0]; g.cam.pitch = cam[1]; g.cam.dist = cam[2]; g.cam.lastDrag = 1e9;
  }, sc);
  // drive, capturing frames on schedule and timing frames meanwhile
  // frame cost: CPU time of every animation-frame callback (physics, effects, scene submit) and the
  // draw calls / triangles of the whole frame (shadow, scene, post passes)
  await page.evaluate(() => {
    const raf = window.requestAnimationFrame.bind(window), r = window.__game.gfx.renderer, px = window.__game.gfx.pixels, render = px.render.bind(px);
    window.__cpu = []; window.__calls = []; window.__tris = [];
    window.requestAnimationFrame = (cb) => raf((t) => { const s = performance.now(); cb(t); window.__cpu.push(performance.now() - s); });
    r.info.autoReset = false;
    px.render = (...a) => { r.info.reset(); render(...a); window.__calls.push(r.info.render.calls); window.__tris.push(r.info.render.triangles); };
  });
  await page.evaluate(({ keys }) => { for (const k of keys) dispatchEvent(new KeyboardEvent('keydown', { code: k })); window.__ft = []; let last = performance.now(); const tick = (t) => { window.__ft.push(t - last); last = t; if (window.__ft.length < 100000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }, sc.drive);
  const t0 = Date.now();
  for (let i = 0; i < sc.frames.length; i++) {
    const wait = sc.frames[i] - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    if (!PERF) await page.screenshot({ path: `${out}/${name}${PX_TAG}_${i + 1}.png` });
  }
  const res = await page.evaluate(({ keys }) => {
    for (const k of keys) dispatchEvent(new KeyboardEvent('keyup', { code: k }));
    const ft = window.__ft.slice(5).sort((a, b) => a - b), c = window.__game.car;
    const fx = window.__game.fx ? { ...window.__game.fx.stats(), mud: window.__game.mudView.stats() } : null;
    const avg = (a) => a.slice(5).reduce((x, y) => x + y, 0) / Math.max(1, a.length - 5);
    const cpu = { cpuMs: +avg(window.__cpu).toFixed(2), calls: Math.round(avg(window.__calls)), tris: Math.round(avg(window.__tris)) };
    return { ...cpu, frames: ft.length, avgMs: +(ft.reduce((a, b) => a + b, 0) / ft.length).toFixed(2), p95Ms: +ft[Math.floor(ft.length * 0.95)].toFixed(2), kmh: +(c.speed() * 3.6).toFixed(1),
      wheels: c.wheelState.map((w) => `${w.mat}/${w.slip.toFixed(1)}${w.sink !== undefined ? '/z' + w.sink.toFixed(2) : ''}`).join(' '), fx };
  }, sc.drive);
  console.log(name, JSON.stringify({ gl, ...res }), 'errors:', errors.length ? errors.slice(0, 4) : 'none');
  await page.close();
}
await browser.close();
