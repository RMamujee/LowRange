// Headless check of the garage: open it, pick upgrades, screenshot the panel and the built truck.
// CHROME=<chromium exe> PORT=5399 node test/garageshots.mjs <outdir>
import { chromium } from 'playwright';
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${process.env.PORT || 5199}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 60000 });
await page.evaluate(() => localStorage.clear());
const sleep = (ms) => page.waitForTimeout(ms);
// click the chip for item `key` whose label starts with `label`
const pick = (key, label) => page.evaluate(([key, label]) => {
  const el = [...document.querySelectorAll(`.chip[data-key="${key}"]`)].find((c) => (c.title || c.textContent).trim().startsWith(label));
  if (!el) throw new Error(`no chip ${key}=${label}`);
  el.click();
}, [key, label]);

for (const [i, name, picks] of [
  [0, 'taco', [['tyreSize', '41'], ['tread', 'Mud'], ['lift', '+4'], ['travel', 'Long'], ['engine', 'Built'], ['final', '5.38'], ['low', '5.1'], ['front', 'Locker'], ['skid', 'Fitted'], ['sliders', 'Fitted'], ['bumpers', 'Steel'], ['paint', '#3f7f8f'], ['rim', '#232427']]],
  [1, 'lc70', [['tyreSize', '40'], ['lift', '+2'], ['turbo', 'Bigger'], ['paint', '#e46a1e']]],
  [2, 'wrx', [['tyreSize', '28'], ['lift', '+4'], ['low', '2.00'], ['paint', '#d9c84a']]],
  [3, 'goat', [['tyreSize', '44'], ['lift', '+4'], ['travel', 'Long'], ['tread', 'Rock'], ['rim', '#c9a43a']]],
  [4, 'mule', [['tyreSize', '51'], ['tread', 'Mud'], ['lift', '+2'], ['paint', '#e9e4d4']]],
]) {
  await page.evaluate((i) => document.querySelectorAll('.card')[i].click(), i);
  await page.click('#garageBtn');
  await sleep(900);
  if (i === 0) await page.screenshot({ path: `${out}/garage-${name}-stock.png` });
  for (const [k, l] of picks) { await pick(k, l); await sleep(120); }
  await sleep(1500);
  await page.screenshot({ path: `${out}/garage-${name}-built.png` });
  const info = await page.evaluate(() => { const s = window.__game.garage.spec; return { axleY: s.axleY, R: s.tire.radius, mass: s.chassis.mass, final: s.final, low: s.ranges.low, lockers: s.lockers, color: s.color.toString(16) }; });
  console.log(name, JSON.stringify(info));
  await page.click('#gBack');
  await sleep(200);
}
// cards reflect the builds; persistence survives a reload
await page.screenshot({ path: `${out}/menu-builds.png` });
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 60000 });
const mods = await page.evaluate(() => document.querySelectorAll('.card .mod').length);
console.log('modified cards after reload:', mods);
// drive the built taco
await page.evaluate(() => { document.querySelectorAll('.card')[0].click(); document.getElementById('goBtn').click(); });
await sleep(2500);
await page.evaluate(() => { const c = window.__game.cam; c.yaw = 2.2; c.pitch = 0.15; c.dist = 8; c.lastDrag = 1e9; });
await sleep(1500);
const drv = await page.evaluate(() => { const c = window.__game.car; return { id: c.spec.id, axleY: c.spec.axleY, R: c.spec.tire.radius, y: c.chassis.translation().y.toFixed(2) }; });
console.log('driving', JSON.stringify(drv));
await page.screenshot({ path: `${out}/drive-taco-built.png` });
// reset to stock
await page.keyboard.press('Escape');
await sleep(300);
await page.click('#garageBtn');
await sleep(500);
await page.click('#gReset');
await sleep(800);
await page.screenshot({ path: `${out}/garage-taco-reset.png` });
console.log('stock after reset:', await page.evaluate(() => window.__game.garage.spec.tire.radius === 0.465 && !document.querySelectorAll('.card')[0].querySelector('.mod')));
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
