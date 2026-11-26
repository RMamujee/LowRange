// Browser regressions from the QA pass (docs/reviews/BUGS.md). Needs a dev server:
//   npx vite --port 5199 --strictPort   then   CHROME=<chrome.exe> node test/browser-qa.mjs
// FAIL = a fixed bug came back. OPEN = a reported bug in a file this test can't fix (see BUGS.md).
import { chromium } from 'playwright';
const PORT = process.env.PORT || 5199;
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
let fails = 0, open = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };
const known = (ok, msg) => { if (!ok) { open++; console.log('  OPEN', msg); } else console.log('  ok  ', msg, '(fixed upstream)'); };

async function session(init) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (init) await page.addInitScript(init);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  const booted = await page.waitForFunction(() => window.__game && window.__game.car && !document.getElementById('loading'), null, { timeout: 90000 }).then(() => true, () => false);
  return { page, errors, booted };
}
const key = (page, code) => page.evaluate((c) => { dispatchEvent(new KeyboardEvent('keydown', { code: c, cancelable: true })); dispatchEvent(new KeyboardEvent('keyup', { code: c })); }, code);

// 1. corrupted garage save data must not block boot (null entry crashed sanitizeBuild)
{
  const { page, errors, booted } = await session(() => {
    if (sessionStorage.getItem('qaSeeded')) return;
    sessionStorage.setItem('qaSeeded', '1');
    localStorage.setItem('lowrange.builds.v1', '{"taco":null,"lc70":"x","wrx":5,"goat":[1],"mule":{"tyreSize":99,"lift":2}}');
    localStorage.setItem('lowrange.settings.v1', '{"quality":"ultra","volume":"loud","showFps":"yes"}');
  });
  check(booted && errors.length === 0, `boots with corrupted save data${errors.length ? ': ' + errors[0] : ''}`);
  await page.close();
}

const { page, errors } = await session();
// 2. garage: close + reopen before the next frame must not start a second render/physics loop
{
  const perFrame = await page.evaluate(async () => {
    const g = window.__game.garage; let raf = 0; const tick = () => { raf++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    const measure = async () => { let n = 0; const orig = g.frame; g.frame = function (t) { n++; return orig.call(this, t); }; const r0 = raf; await new Promise((r) => setTimeout(r, 800)); g.frame = orig; return n / Math.max(1, raf - r0); };
    g.open(0); await new Promise((r) => setTimeout(r, 200));
    g.close(); g.open(0); g.close(); g.open(0);
    const k = await measure(); g.close(); return k;
  });
  check(perFrame < 1.3, `one garage loop after close/open cycles (${perFrame.toFixed(2)} garage frames per display frame)`);
}
// 3. garage preview follows window resizes
{
  await page.evaluate(() => window.__game.garage.open(0));
  await page.setViewportSize({ width: 700, height: 500 }); await page.waitForTimeout(300);
  const r = await page.evaluate(() => { const g = window.__game.garage, c = document.getElementById('gPreview'); return { a: g.camera.aspect, box: c.clientWidth / c.clientHeight }; });
  check(Math.abs(r.a - r.box) < 0.02, `garage preview aspect ${r.a.toFixed(3)} matches its box ${r.box.toFixed(3)} after resize`);
  await page.evaluate(() => window.__game.garage.close());
  await page.setViewportSize({ width: 1280, height: 720 });
}
// 4. (open, main.js) the upside-down hint names the recover key
{
  await key(page, 'Enter'); await page.waitForTimeout(3800);
  await page.evaluate(() => { const c = window.__game.car; c.grace = 1e9; c.chassis.applyImpulse({ x: 0, y: c.mass * 6, z: 0 }, true); c.chassis.applyTorqueImpulse({ x: 0, y: 0, z: c.mass * 9 }, true); });
  await page.waitForFunction(() => window.__game.car.upsideDown() && Math.abs(window.__game.car.speed()) < 0.5, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const t = await page.evaluate(() => document.getElementById('toast').textContent);
  known(!/Press R\b/.test(t), `upside-down toast does not send the player to R (range): "${t}"`);
  await key(page, 'Backspace'); await page.waitForTimeout(500);
}
// 5. (open, main.js) finishing a trail must not immediately start a new run at the finish gate
{
  await page.evaluate(async () => { const T = await import('/src/terrain.js'); const t = T.TRAILS[0], p = T.pathPoint(t, 3); window.__game.car.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.2, z: p.z }, Math.atan2(-p.tx, -p.tz)); });
  await page.waitForTimeout(5000);
  await page.evaluate(async () => { const T = await import('/src/terrain.js'); const t = T.TRAILS[0], p = T.pathPoint(t, t.length - 3); window.__game.car.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.2, z: p.z }, Math.atan2(-p.tx, -p.tz)); });
  await page.waitForTimeout(800);
  const a = await page.evaluate(() => window.__game.activeTrail);
  known(a === null, `no trail run active right after finishing (got ${JSON.stringify(a)})`);
}
check(errors.length === 0, `no console errors${errors.length ? ': ' + errors[0] : ''}`);
await browser.close();
console.log(fails ? `${fails} FAILURES, ${open} open` : `browser-qa: all fixed checks passed, ${open} open (see docs/reviews/BUGS.md)`);
process.exit(fails ? 1 : 0);
