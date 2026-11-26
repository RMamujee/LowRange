// Frame-clarity probe: loads the game in headless Chromium at realistic browser viewports and
// records what actually reaches the screen, so blur / washed-out / shimmer can be measured
// instead of guessed. Analyse the output with `py tools/clarity_metrics.py <outdir>`.
//   CHROME=... PORT=5881 node test/clarity.mjs <outdir> [configs] [scenes]
// configs: comma list of name=WxH@dsf (default: the user's 1080p Chrome window at 100%, plus
//   Windows 125% / 150% and browser zoom 90% / 110%); a dsf other than 1 also stands in for
//   browser zoom, which changes devicePixelRatio and the CSS viewport the same way.
// For each config: diagnostics (dpr, CSS size, drawing buffer, pipeline scale and internal size),
// a device-pixel screenshot per scene. For the first config also: the internal low-res frame per
// scene, and two bursts of consecutive internal frames (slow orbit, steady drive) rendered
// deterministically in one synchronous block, for a temporal-noise metric.
import { chromium } from 'playwright';
import fs from 'node:fs';
const out = process.argv[2] || 'clarity_out';
fs.mkdirSync(out, { recursive: true });
const DEF = 'win100=1920x969@1,win125=1536x775@1.25,win150=1280x646@1.5,zoom90=2133x1077@0.9,zoom110=1745x881@1.1';
const configs = (process.argv[3] || DEF).split(',').map((s) => { const [name, r] = s.split('='); const [wh, d] = r.split('@'); const [w, h] = wh.split('x').map(Number); return { name, w, h, dsf: +d }; });
// scenes: [trailIdx, s, camYaw, camPitch, camDist]
const SCENES = JSON.parse(process.argv[4] || '{"trailhead":[0,6,0.6,0.32,9],"granite":[1,60,2.4,0.3,10],"widow":[4,90,0.4,0.36,11]}');
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const report = {};
for (const [ci, cfg] of configs.entries()) {
  const page = await browser.newPage({ viewport: { width: cfg.w, height: cfg.h }, deviceScaleFactor: cfg.dsf });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // PIXEL=n: start with that pixel size (through the saved settings, as a player would have it)
  if (process.env.PIXEL) await page.addInitScript((v) => localStorage.setItem('lowrange.settings.v1', JSON.stringify({ pixelSize: v })), +process.env.PIXEL);
  await page.goto(`http://localhost:${process.env.PORT || 5881}/${process.env.QS || ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
  await page.evaluate(async () => { document.getElementById('goBtn').click(); await new Promise((r) => setTimeout(r, 2000)); });
  const rep = { cfg, scenes: {} };
  for (const [name, sc] of Object.entries(SCENES)) {
    const diag = await page.evaluate(async (sc) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const T = await import('/src/terrain.js'), c = window.__game.car;
      if (sc[0] === 'track') { // race map: [ 'track', s along the track, ... ]
        const M = await import('/src/maps/racetrack.js'), f = M.trackFrame(sc[1]);
        c.reset({ x: f.x, y: M.heightAt(f.x, f.z) + 1.8, z: f.z }, Math.atan2(-f.tx, -f.tz)); window.__game.race?.teleported();
      } else {
        const t = T.TRAILS[sc[0]], p = T.pathPoint(t, sc[1]);
        c.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.8, z: p.z }, Math.atan2(-p.tx, -p.tz));
      }
      const cam = window.__game.cam; cam.yaw = sc[2]; cam.pitch = sc[3]; cam.dist = sc[4]; cam.lastDrag = 1e9;
      await sleep(2500);
      const { renderer, pixels } = window.__game.gfx, cv = renderer.domElement, cs = getComputedStyle(cv);
      return { dpr: devicePixelRatio, inner: [innerWidth, innerHeight], css: [cv.clientWidth, cv.clientHeight], cssStyle: [cs.width, cs.height, cs.imageRendering],
        buffer: [cv.width, cv.height], bufferOverCssDpr: [+(cv.width / (cv.clientWidth * devicePixelRatio)).toFixed(4), +(cv.height / (cv.clientHeight * devicePixelRatio)).toFixed(4)],
        scale: pixels.scale, internal: [pixels.w, pixels.h], leftover: [pixels.w * pixels.scale - cv.width, pixels.h * pixels.scale - cv.height] };
    }, sc);
    await page.screenshot({ path: `${out}/${cfg.name}_${name}.png` });
    if (ci === 0) {
      // internal frame + temporal bursts
      const data = await page.evaluate(async () => {
        const { renderer, pixels, scene, camera, sun } = window.__game.gfx;
        const W = pixels.w, H = pixels.h, buf = new Uint8Array(W * H * 4);
        const grab = () => {
          pixels.render(scene, camera, sun);
          renderer.readRenderTargetPixels(pixels.rtPost, 0, 0, W, H, buf);
          const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
          const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H);
          for (let y = 0; y < H; y++) img.data.set(buf.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
          ctx.putImageData(img, 0, 0);
          return cv.toDataURL('image/png');
        };
        const still = grab();
        const p0 = camera.position.clone(), q0 = camera.quaternion.clone();
        const tgt = window.__game.car.chassis.translation();
        const T = { x: tgt.x, y: tgt.y + 1, z: tgt.z };
        const off = p0.clone().sub(T); const r = Math.hypot(off.x, off.z), a0 = Math.atan2(off.z, off.x);
        const orbit = [], drive = [];
        for (let i = 0; i < 10; i++) { // slow orbit: 0.3 deg per frame (18 deg/s at 60 fps)
          const a = a0 + i * 0.3 * Math.PI / 180;
          camera.position.set(T.x + Math.cos(a) * r, p0.y, T.z + Math.sin(a) * r); camera.lookAt(T.x, T.y, T.z); camera.updateMatrixWorld();
          orbit.push(grab());
        }
        const fwd = { x: -off.x / r, z: -off.z / r };
        for (let i = 0; i < 10; i++) { // steady drive: 8 m/s at 60 fps, camera and target together
          const d = i * 8 / 60;
          camera.position.set(p0.x + fwd.x * d, p0.y, p0.z + fwd.z * d); camera.lookAt(T.x + fwd.x * d, T.y, T.z + fwd.z * d); camera.updateMatrixWorld();
          drive.push(grab());
        }
        camera.position.copy(p0); camera.quaternion.copy(q0);
        return { still, orbit, drive };
      });
      const save = (f, url) => fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
      save(`${out}/internal_${name}.png`, data.still);
      fs.mkdirSync(`${out}/burst_${name}`, { recursive: true });
      data.orbit.forEach((u, i) => save(`${out}/burst_${name}/orbit_${String(i).padStart(2, '0')}.png`, u));
      data.drive.forEach((u, i) => save(`${out}/burst_${name}/drive_${String(i).padStart(2, '0')}.png`, u));
    }
    rep.scenes[name] = diag;
  }
  rep.errors = errors;
  report[cfg.name] = rep;
  console.log(cfg.name, JSON.stringify(Object.values(rep.scenes)[0]), 'errors:', errors.length ? errors.slice(0, 3) : 'none');
  await page.close();
}
fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
await browser.close();
