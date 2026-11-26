// Pixel size setting (F10): each option applies live, gives a whole-number upscale whose blocks
// tile the canvas exactly, and survives a reload.
//   CHROME=... PORT=5881 node test/pixelsize.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 969 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const url = `http://localhost:${process.env.PORT || 5199}/`;
await page.goto(url);
await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${msg}`); if (!c) fails++; };
const state = () => page.evaluate(() => { const p = window.__game.gfx.pixels, cv = window.__game.gfx.renderer.domElement; return { scale: p.scale, w: p.w, h: p.h, bw: cv.width, bh: cv.height, img: getComputedStyle(cv).imageRendering, saved: JSON.parse(localStorage.getItem('lowrange.settings.v1') || '{}').pixelSize }; });
const s0 = await state();
ok(s0.scale === 2 && s0.img === 'pixelated', `default: Fine 2x on a 1080p window (scale ${s0.scale}, ${s0.w}x${s0.h}, ${s0.img})`);
await page.keyboard.press('F10');
for (const [v, want] of [[4, 4], [3, 3], [1, 1], [2, 2]]) {
  await page.click(`#lrSettings [data-k=pixelSize] button[data-v="${v}"]`);
  const s = await state();
  ok(s.scale === want && s.w * s.scale >= s.bw && (s.w - 1) * s.scale < s.bw && s.h * s.scale >= s.bh && (s.h - 1) * s.scale < s.bh && s.saved === v,
    `pixel size ${v}: x${s.scale}, ${s.w}x${s.h} internal for a ${s.bw}x${s.bh} canvas, saved ${s.saved}`);
}
await page.click('#lrSettings [data-k=pixelSize] button[data-v="3"]');
await page.reload();
await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
const s1 = await state();
ok(s1.scale === 3, `pixel size persists across a reload (x${s1.scale})`);
await page.evaluate(() => localStorage.removeItem('lowrange.settings.v1'));
ok(!errors.length, `no console errors (${errors.slice(0, 3).join(' | ')})`);
console.log(fails ? `${fails} failed` : 'all passed');
await browser.close();
process.exit(fails ? 1 : 0);
