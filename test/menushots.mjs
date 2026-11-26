// Menu screenshots + behaviour checks: first launch, paused, other rig picked while paused, garage,
// settings, controls, and the race map, at several window sizes.
//   PORT=5901 CHROME=<chrome.exe> node test/menushots.mjs <outDir> [1920x1080,1280x720]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] || 'test/shots';
mkdirSync(out, { recursive: true });
const sizes = (process.argv[3] || '1920x1080,1600x900,1280x720').split(',').map((s) => s.split('x').map(Number));
const base = process.env.URL || `http://localhost:${process.env.PORT || 5901}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const errors = [];
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(w, h, qs = '') {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + qs, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
  await sleep(600);
  return page;
}

for (const [w, h] of sizes) {
  const tag = `${w}x${h}`;
  const page = await open(w, h);
  await page.screenshot({ path: `${out}/menu_main_${tag}.png` });
  // menu fits without scrolling
  const fit = await page.evaluate(() => { const m = document.querySelector('.menu-inner'); const r = m.getBoundingClientRect(); return { b: r.bottom, r: r.right, h: innerHeight, w: innerWidth }; });
  check(fit.b <= fit.h + 1 && fit.r <= fit.w + 1, `${tag}: main menu fits the window (${JSON.stringify(fit)})`);
  // nothing spills out of its box (long stats, button labels)
  const spill = () => page.evaluate(() => [...document.querySelectorAll('#menu .card, #menu .pbtn, #menu .m-paper, #garage .pbtn, #garage .gstat')]
    .filter((el) => el.offsetParent && el.scrollWidth > el.clientWidth + 1).map((el) => el.id || el.className + ':' + el.textContent.trim().slice(0, 24)));
  let sp = await spill();
  check(!sp.length, `${tag}: no text overflows its box on the main menu ${JSON.stringify(sp)}`);
  // controls view
  await page.click('#ctrlBtn');
  await sleep(200);
  await page.screenshot({ path: `${out}/menu_controls_${tag}.png` });
  await page.click('#rigsBtn');
  // drive, then pause
  await page.evaluate(() => document.getElementById('goBtn').click());
  await sleep(1500);
  await page.keyboard.press('Escape');
  await sleep(500);
  const p = await page.evaluate(() => ({ paused: window.__game.paused, label: document.getElementById('goBtn').textContent.trim() }));
  check(p.paused && /resume/i.test(p.label), `${tag}: Esc pauses, primary button says Resume ("${p.label}")`);
  await page.screenshot({ path: `${out}/menu_paused_${tag}.png` });
  // another rig while paused
  await page.evaluate(() => document.querySelectorAll('.card')[1].click());
  await sleep(150);
  const l2 = await page.evaluate(() => document.getElementById('goBtn').textContent.trim());
  check(/drive this rig/i.test(l2), `${tag}: picking another rig while paused relabels the button ("${l2}")`);
  await page.screenshot({ path: `${out}/menu_paused_other_${tag}.png` });
  sp = await spill();
  check(!sp.length, `${tag}: no text overflows its box on the pause menu ${JSON.stringify(sp)}`);
  await page.evaluate(() => document.querySelectorAll('.card')[0].click());
  // garage
  await page.click('#garageBtn');
  await sleep(900);
  await page.screenshot({ path: `${out}/menu_garage_${tag}.png` });
  sp = await spill();
  check(!sp.length, `${tag}: no text overflows in the garage ${JSON.stringify(sp)}`);
  await page.click('#gBack');
  await sleep(100);
  // settings
  await page.click('#setBtn');
  await sleep(200);
  await page.screenshot({ path: `${out}/menu_settings_${tag}.png` });
  await page.keyboard.press('Escape');
  await sleep(100);
  check(await page.evaluate(() => document.getElementById('lrSettings').classList.contains('hidden') && window.__game.paused), `${tag}: Esc closes settings, still paused`);
  await page.keyboard.press('Escape');
  await sleep(300);
  check(await page.evaluate(() => !window.__game.paused && document.getElementById('menu').classList.contains('hidden')), `${tag}: Esc resumes`);
  await page.close();
}

// race map variant + keyboard navigation
{
  const [w, h] = sizes[0];
  const page = await open(w, h, '?map=race');
  await page.screenshot({ path: `${out}/menu_race_${w}x${h}.png` });
  await page.keyboard.press('Tab');
  const f1 = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.className));
  check(!!f1 && f1 !== 'BODY', `keyboard: Tab focuses a menu control (${f1})`);
  await page.focus('.card');
  await page.keyboard.press('ArrowRight');
  const sel = await page.evaluate(() => [...document.querySelectorAll('.card')].findIndex((c) => c.classList.contains('sel')));
  check(sel === 1, `keyboard: ArrowRight on the rig cards selects the next rig (${sel})`);
  await page.screenshot({ path: `${out}/menu_focus_${w}x${h}.png` });
  await page.close();
}

console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
process.exit(fails || errors.length ? 1 : 0);
