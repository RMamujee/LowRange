// Screenshots of the loading screen at a few moments: node test/loading.mjs [outDir] [port]
import { chromium } from 'playwright';
const out = process.argv[2] || 'test/shots/loading';
const port = process.argv[3] || '5599';
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const errors = [];
for (const [w, h] of [[1600, 900], [1280, 720]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/?loader`, { waitUntil: 'commit' });
  for (const ms of [400, 1200, 2500]) {
    await page.waitForTimeout(Math.max(0, ms - (Date.now() - t0)));
    await page.screenshot({ path: `${out}/${w}-${ms}ms.png` });
  }
  await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#lr-load.ready'), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${w}-ready.png` });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${out}/${w}-dissolve.png` });
  await page.waitForFunction(() => !document.getElementById('lr-load'), null, { timeout: 5000 });
  const menuOpen = await page.evaluate(() => !document.getElementById('menu').classList.contains('hidden'));
  await page.screenshot({ path: `${out}/${w}-menu.png` });
  console.log(w, 'loaded in', Date.now() - t0, 'ms; menu open after gate:', menuOpen);
  await page.close();
}
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
