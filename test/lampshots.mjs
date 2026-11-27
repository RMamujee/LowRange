// Rear lamp screenshots: each rig from a rear three-quarter view in reverse, in drive and braking,
// at the given pixel sizes. Also the garage preview of each rig (lamps should be off there).
//   CHROME=<chrome.exe> PORT=5238 node test/lampshots.mjs <outdir> [rigs=0,1,2] [pixels=1,4] [states=reverse,drive,brake,park]
// Writes <outdir>/<rig>_<state>_px<n>.png and <outdir>/<rig>_garage.png; prints the lamp state the
// view reports for each shot (src/art/lamps.js), so a shot can be matched with what the code thinks.
import { chromium } from 'playwright';
import fs from 'fs';
const out = process.argv[2] || 'test/shots/lamps';
const rigs = (process.argv[3] || '0,1,2').split(',').map(Number);
const pixels = (process.argv[4] || '1,4').split(',').map(Number);
const states = (process.argv[5] || 'reverse,drive,brake').split(',');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: +(process.env.VW || 1280), height: +(process.env.VH || 720) } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${process.env.PORT || 5238}/${process.env.QS || ''}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
for (const rig of rigs) {
  for (const px of pixels) {
    for (const state of states) {
      const res = await page.evaluate(async ({ rig, px, state }) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const kd = (c) => dispatchEvent(new KeyboardEvent('keydown', { code: c })), ku = (c) => dispatchEvent(new KeyboardEvent('keyup', { code: c }));
        const S = await import('/src/settings.js');
        S.setSetting('pixelSize', px);
        const g = window.__game;
        if (!g.car || g.car.spec !== undefined) {
          const menuUp = !document.getElementById('menu').classList.contains('hidden');
          if (!menuUp) { kd('Escape'); ku('Escape'); await sleep(200); }
          document.querySelectorAll('.card')[rig].click();
          document.getElementById('goBtn').click();
          await sleep(1800);
        }
        const car = g.car;
        if (state === 'park') { /* fresh truck: parking brake on, neutral */ } else {
          if (g.parkBrake) { kd('KeyP'); await sleep(60); ku('KeyP'); }
          car.dt.gear = state === 'reverse' ? -1 : 1;
        }
        if (state === 'brake') kd('KeyS');
        const c = g.cam; c.yaw = 0.62; c.pitch = 0.12; c.dist = 6.2; c.lastDrag = 1e9;
        await sleep(900);
        // hide the HUD canvas so it never covers the truck
        for (const el of document.querySelectorAll('canvas')) if (el !== g.gfx.renderer.domElement) el.style.visibility = 'hidden';
        await sleep(120);
        const L = g.view.lamps;
        return { rig: car.spec.id, state, px, gear: car.dt.gearLabel, running: car.dt.running, parkBrake: g.parkBrake, lamps: L ? L.state() : null };
      }, { rig, px, state });
      await page.screenshot({ path: `${out}/${res.rig}_${state}_px${px}.png` });
      await page.evaluate(() => {
        dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyS' }));
        for (const el of document.querySelectorAll('canvas')) el.style.visibility = '';
      });
      console.log(JSON.stringify(res));
    }
  }
  // garage preview of this rig
  const gid = await page.evaluate(async (rig) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const S = await import('/src/settings.js'); S.setSetting('pixelSize', 1);
    if (document.getElementById('menu').classList.contains('hidden')) { dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })); dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape' })); await sleep(300); }
    document.querySelectorAll('.card')[rig].click();
    document.getElementById('garageBtn').click();
    await sleep(1500);
    const G = window.__game.garage;
    G.angle = 0.5; G.lastDrag = performance.now() + 1e7; // turn the preview to show the rear, hold it there
    await sleep(600);
    return { id: G.spec?.id, lamps: G.view?.lamps ? G.view.lamps.state() : null };
  }, rig);
  await page.screenshot({ path: `${out}/${gid.id}_garage.png` });
  console.log(JSON.stringify({ garage: gid }));
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById('gBack')?.click();
    await sleep(400);
  });
}
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
