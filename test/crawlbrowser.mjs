// Browser check of The Gauntlet's run flow (needs a dev server): drive the Cruiser through the
// start gate (run starts, stage toast, HUD guidance), drive into stage 2 by its gate, press Y
// (back at stage 2's gate, repaired), reload the stored best. Reports console errors.
// usage: CHROME=<chrome.exe> PORT=5911 node test/crawlbrowser.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${process.env.PORT || 5911}/?map=crawl`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 60000 });
let fails = 0;
const ok = (c, msg) => { if (!c) fails++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${msg}`); };
const r = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const kd = (c) => dispatchEvent(new KeyboardEvent('keydown', { code: c })), ku = (c) => dispatchEvent(new KeyboardEvent('keyup', { code: c }));
  const tap = async (c) => { kd(c); await sleep(60); ku(c); await sleep(60); };
  const G = window.__game, T = await import('/src/terrain.js');
  const out = {};
  document.querySelectorAll('.card')[1].click(); document.getElementById('goBtn').click(); await sleep(1500);
  await tap('KeyP'); dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true })); await sleep(300);
  // drive east off the pad and through the start gate (19 m)
  kd('KeyW');
  for (let i = 0; i < 60 && !G.activeTrail; i++) await sleep(250);
  ku('KeyW');
  out.started = !!G.activeTrail; out.toast1 = G.hud.debug().lastToast;
  await sleep(1500);
  out.toast2 = G.hud.debug().lastToast;
  // put the truck just before stage 2's gate (teleports cross nothing), drive through it
  const st2 = T.MAP.STAGES[1], p = T.pathPoint(T.TRAILS[0], st2.s0 - 4);
  G.car.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.2, z: p.z }, Math.atan2(-p.tx, -p.tz)); await sleep(1200);
  kd('KeyW'); await sleep(4500); ku('KeyW'); await sleep(1600);
  out.toast3 = G.hud.debug().lastToast;
  // Y: back to stage 2's gate
  await tap('KeyY'); await sleep(400);
  const c = G.car.chassis.translation();
  out.toastY = G.hud.debug().lastToast;
  out.yDist = Math.hypot(c.x - st2.gate.x, c.z - st2.gate.z);
  out.active = !!G.activeTrail;
  return out;
});
console.log(JSON.stringify(r));
ok(r.started, 'driving through the start gate starts the run');
ok(/clock is running/.test(r.toast1), `start toast: "${r.toast1}"`);
ok(/Stage 1\/12|Stage 1 /.test(r.toast1 + r.toast2), 'stage 1 announced');
ok(/Stage 1 Warm-up|Stage 2\/12/.test(r.toast3), `entering stage 2: "${r.toast3}"`);
ok(/Back at stage 2/.test(r.toastY) && r.yDist < 6 && r.active, `Y: back at stage 2's gate (${r.yDist.toFixed(1)} m), run still on`);
ok(!errors.length, `console errors: ${errors.length ? errors.slice(0, 5).join(' | ') : 'none'}`);
await browser.close();
process.exit(fails ? 1 : 0);
