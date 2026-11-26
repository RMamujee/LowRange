// Picture settings (F10): Soft is the default look; each look and slider applies live to the
// pipeline's display grade, survives a reload, and an old save holding the former Fine 2x default
// moves to HD 1x while other choices are kept.
//   CHROME=... PORT=5921 node test/comfort.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 969 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const url = `http://localhost:${process.env.PORT || 5199}/`;
const boot = async () => page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${msg}`); if (!c) fails++; };
// the grade the pipeline actually draws with (uniforms are refreshed every render)
const grade = () => page.evaluate(async () => {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const u = window.__game.gfx.pixels.post.uniforms, s = JSON.parse(localStorage.getItem('lowrange.settings.v1') || '{}');
  const on = [...document.querySelectorAll('#lrSettings [data-k=look] button.on')].map((b) => b.dataset.v);
  return { g: u.uGrade.value.toArray().map((v) => +v.toFixed(3)), k: u.uKnee.value.toArray().map((v) => +v.toFixed(3)), saved: s, on, scale: window.__game.gfx.pixels.scale };
});
await page.goto(url); await boot();
await page.keyboard.press('F10');
let s = await grade();
ok(s.g.join() === '0.98,0.95,1' && s.k[0] < 1 && s.on.join() === 'soft', `default look Soft (grade ${s.g}, knee/lift/vignette ${s.k}, lit ${s.on})`);
await page.click('#lrSettings [data-k=look] button[data-v="vivid"]');
s = await grade();
ok(s.g.join() === '1.02,1.08,1.14' && s.saved.look === 'vivid' && s.on.join() === 'vivid', `Vivid applies live and saves (grade ${s.g})`);
await page.click('#lrSettings [data-k=look] button[data-v="standard"]');
s = await grade();
ok(s.g.join() === '1,1,1' && s.on.join() === 'standard', `Standard applies live (grade ${s.g})`);
await page.$eval('#lrSettings [data-k=brightness]', (el) => { el.value = 85; el.dispatchEvent(new Event('input')); });
s = await grade();
ok(s.g[0] === 0.85 && s.saved.brightness === 0.85 && s.on.length === 0, `brightness slider 85%: live, saved, look shows custom (grade ${s.g})`);
await page.reload(); await boot();
s = await grade();
ok(s.g.join() === '0.85,1,1' && s.saved.look === 'standard', `picture settings persist across a reload (grade ${s.g})`);
// legacy save: the old full save with the old default pixel size
await page.evaluate(() => localStorage.setItem('lowrange.settings.v1', JSON.stringify({ quality: 'high', pixelSize: 2, volume: 0.5, showFps: false })));
await page.reload(); await boot();
s = await grade();
ok(s.scale === 1 && s.g.join() === '0.98,0.95,1', `old save at Fine 2x moves to HD 1x + Soft (x${s.scale}, grade ${s.g})`);
await page.evaluate(() => localStorage.setItem('lowrange.settings.v1', JSON.stringify({ quality: 'high', pixelSize: 3, volume: 0.5, showFps: false })));
await page.reload(); await boot();
s = await grade();
ok(s.scale === 3, `old save at 3x keeps 3x (x${s.scale})`);
await page.evaluate(() => localStorage.removeItem('lowrange.settings.v1'));
ok(!errors.length, `no console errors (${errors.slice(0, 3).join(' | ')})`);
console.log(fails ? `${fails} failed` : 'all passed');
await browser.close();
process.exit(fails ? 1 : 0);
