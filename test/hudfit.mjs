// Browser check of the HUD layout across window sizes: on Trail Park, The Gauntlet and the Race Track,
// at every size in the matrix (and at 125% / 150% display scaling) it drives, shows a long toast plus a
// big centre message, then measures every visible HUD canvas: nothing may leave the window and no two
// may overlap. The big map and the controls board are opened too and must fit the window. Live resize
// is exercised: one page per map and scaling, resized through the whole matrix.
// Usage: CHROME=... PORT=5218 node test/hudfit.mjs [outdir-for-screenshots]
import { chromium } from 'playwright';
const out = process.argv[2] || '';
const base = `http://localhost:${process.env.PORT || 5199}/`;
const SIZES = [[1920, 1080], [1366, 768], [1280, 720], [1024, 600], [800, 600], [640, 360], [320, 240], [800, 1600], [2560, 1080]];
const DPR_SIZES = { 1: SIZES, 1.25: [[1536, 864], [1366, 768], [1024, 600], [640, 360]], 1.5: [[1280, 720], [1280, 800], [800, 600], [640, 360]] };
const MAPS = [['park', ''], ['crawl', '?map=crawl'], ['race', '?map=race']];
const LONG = 'Stage 7/12 · Boulder Garden (black). A long line of big rocks that wants a careful driver and a slow, steady throttle foot.';
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
let fails = 0;
const check = (ok, msg) => { if (!ok) { console.log('  FAIL', msg); fails++; } };

for (const [dpr, sizes] of Object.entries(DPR_SIZES)) {
  for (const [mapName, qs] of MAPS) {
    const ctx = await browser.newContext({ viewport: { width: sizes[0][0], height: sizes[0][1] }, deviceScaleFactor: +dpr });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + qs, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const tap = async (c) => { dispatchEvent(new KeyboardEvent('keydown', { code: c })); await sleep(60); dispatchEvent(new KeyboardEvent('keyup', { code: c })); await sleep(60); };
      document.querySelectorAll('.card')[0].click(); document.getElementById('goBtn').click(); await sleep(2500);
      if (window.__game.parkBrake) await tap('KeyP');
      await tap('ArrowUp');
      dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })); // keep driving while measuring
    });
    for (const [w, h] of sizes) {
      await page.setViewportSize({ width: w, height: h });
      const tag = `${mapName} ${w}x${h}@${dpr}`;
      for (const big of [['10:23.4', 'best'], ['WRONG WAY', 'warn']]) {
        const res = await page.evaluate(async ([long, big]) => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const hud = window.__game.hud;
          if (hud.mapOpen) hud.closeMap();
          hud.bigMsg(big[0], 30, big[1]); hud.toast(long, 30);
          await sleep(250);
          const vis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0 && el.getBoundingClientRect().width > 0; };
          const rects = [...document.querySelectorAll('#hud > canvas.px')].filter(vis).map((el) => { const r = el.getBoundingClientRect(); return { n: el.className.replace('px ', '').replace(' show', ''), x: r.left, y: r.top, w: r.width, h: r.height }; });
          const scale = window.__game.hud.debug().layout;
          return { rects, W: innerWidth, H: innerHeight, scale };
        }, [LONG, big]);
        const E = 0.01;
        for (const r of res.rects) check(r.x >= -E && r.y >= -E && r.x + r.w <= res.W + E && r.y + r.h <= res.H + E, `${tag}: ${r.n} off-screen ${JSON.stringify(r)}`);
        for (let i = 0; i < res.rects.length; i++) for (let j = i + 1; j < res.rects.length; j++) {
          const a = res.rects[i], b = res.rects[j];
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          check(!(ox > E && oy > E), `${tag}: ${a.n} overlaps ${b.n} by ${ox.toFixed(1)}x${oy.toFixed(1)} px`);
        }
        if (big[1] === 'best') {
          console.log(`${tag}: ${JSON.stringify(res.scale)} ${res.rects.map((r) => r.n.replace('hud-', '') + ' ' + [r.x, r.y, r.w, r.h].map((v) => Math.round(v)).join(',')).join(' | ')}`);
          if (out) await page.screenshot({ path: `${out}/${mapName}_${w}x${h}_dpr${dpr}.png` });
        }
      }
      // overlays: big map (info + spawn list) and the controls board must fit the window
      const ov = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const hud = window.__game.hud, fit = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
        hud.openSpawns(); await sleep(150);
        const map = fit(document.querySelector('.hud-map'));
        hud.closeMap(); hud.toggleHelp(); await sleep(150);
        const help = fit(document.querySelector('.hud-help'));
        hud.toggleHelp();
        return { map, help, W: innerWidth, H: innerHeight };
      });
      for (const [n, r] of [['big map', ov.map], ['controls board', ov.help]]) check(r.x >= -0.01 && r.y >= -0.01 && r.x + r.w <= ov.W + 0.01 && r.y + r.h <= ov.H + 0.01, `${tag}: ${n} off-screen ${JSON.stringify(r)}`);
    }
    check(!errors.length, `${mapName}@${dpr}: page errors ${errors.slice(0, 3)}`);
    await ctx.close();
  }
}
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
