// Screenshots of the HUD and the maps for legibility work: per map, window size and display scaling it
// drives a little (HUD + minimap), then opens the big map at every zoom level (info sidebar) and on the
// spawn list, and saves full-window shots plus crops of the minimap, the cluster and the big map. It also
// reports the HUD scale, the big map's scale and the device-pixel height of the small HUD letters.
//   CHROME=<chrome.exe> PORT=5231 node test/mapshots.mjs <outdir> [maps] [sizes]
//   maps: park,crawl,desert,jungle,race (default park,crawl,desert)
//   sizes: WxH@dpr list (default 1920x1080@1,1366x768@1,1024x600@1,1280x720@1.5,1024x600@1.5)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] || 'test/shots/maps';
mkdirSync(out, { recursive: true });
const maps = (process.argv[3] || 'park,crawl,desert').split(',');
const sizes = (process.argv[4] || '1920x1080@1,1366x768@1,1024x600@1,1280x720@1.5,1024x600@1.5').split(',').map((s) => { const [wh, d] = s.split('@'); const [w, h] = wh.split('x').map(Number); return [w, h, +(d || 1)]; });
const base = `http://localhost:${process.env.PORT || 5199}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let errs = 0;
for (const map of maps) {
  for (const [w, h, dpr] of sizes) {
    const tag = `${map}_${w}x${h}_dpr${dpr}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(base + (map === 'park' ? '' : `?map=${map}`), { waitUntil: 'load' });
    await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 120000 });
    await page.evaluate(async () => {
      const s = (ms) => new Promise((r) => setTimeout(r, ms));
      const tap = async (c) => { dispatchEvent(new KeyboardEvent('keydown', { code: c })); await s(60); dispatchEvent(new KeyboardEvent('keyup', { code: c })); await s(60); };
      document.querySelectorAll('.card')[0].click(); document.getElementById('goBtn').click(); await s(2000);
      const hud = window.__game.hud, p = window.__game.car.chassis.translation();
      hud.waypoints.clear(); hud.waypoints.add(p.x + 60, p.z - 40); hud.waypoints.add(p.x - 90, p.z + 70);
      if (window.__game.parkBrake) await tap('KeyP');
      await tap('ArrowUp');
      dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })); await s(1800);
      dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    });
    const clip = async (sel, name) => {
      const r = await page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return b.width ? { x: b.left, y: b.top, width: b.width, height: b.height } : null; }, sel);
      if (r) await page.screenshot({ path: `${out}/${tag}_${name}.png`, clip: r });
    };
    await page.screenshot({ path: `${out}/${tag}_hud.png` });
    await clip('.hud-mini', 'mini'); await clip('.hud-cluster', 'cluster'); await clip('.hud-chassis', 'chassis');
    const info = await page.evaluate(() => { const d = window.__game.hud.debug(); return { ...d.layout, zooms: d.map.zooms }; });
    console.log(tag, JSON.stringify(info), errors.length ? 'errors: ' + errors.slice(0, 2).join(' | ') : '');
    errs += errors.length;
    await page.evaluate(() => window.__game.hud.toggleMap());
    for (let zi = 0; zi < info.zooms.length; zi++) {
      await page.evaluate((zi) => { const m = window.__game.hud.debug().map, p = window.__game.car.chassis.translation(); m.zi = zi; if (zi === 0) m.centreOn(0, 0); else { m.centreOn(p.x, p.z); m.clampView(); } }, zi);
      await sleep(250);
      await clip('.hud-map', `map_z${zi}`);
    }
    await page.evaluate(() => window.__game.hud.closeMap());
    await page.evaluate(() => window.__game.hud.openSpawns());
    await sleep(300);
    await clip('.hud-map', 'spawns');
    await page.evaluate(() => { const m = window.__game.hud.debug().map; m.prompt = Math.max(0, m.sel); });
    await sleep(250);
    await clip('.hud-map', 'prompt');
    await ctx.close();
  }
}
await browser.close();
console.log(errs ? `${errs} page errors` : 'no page errors');
