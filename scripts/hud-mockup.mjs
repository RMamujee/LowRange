// HUD review sheets, rendered by the real HUD code in headless Chromium (so the mock-up is what ships):
//   docs/previews/hud_mockup.png   full HUD over the game at 1600x900 (plus hud_mockup_720.png at 1280x720)
//   docs/previews/hud_parts.png    every instrument drawn large: dials, shifter in several gears / boxes,
//                                  transfer lever, lockers, parking brake, inclinometers, map small + expanded
// Usage: npx vite --port 5841 --strictPort  (in another shell), then
//        CHROME=<chromium exe> PORT=5841 node scripts/hud-mockup.mjs
import { chromium } from 'playwright';
const OUT = 'docs/previews';
const base = `http://localhost:${process.env.PORT || 5841}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const sleep = (page, ms) => page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), ms);
const key = (page, code) => page.evaluate(async (c) => { dispatchEvent(new KeyboardEvent('keydown', { code: c })); await new Promise((r) => setTimeout(r, 60)); dispatchEvent(new KeyboardEvent('keyup', { code: c })); }, code);

async function drive(w, h, vehicle) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 60000 });
  await page.evaluate(async (v) => {
    localStorage.removeItem('lowrange.waypoints.park');
    document.querySelectorAll('.card')[v].click(); document.getElementById('goBtn').click();
    await new Promise((r) => setTimeout(r, 1500));
    const T = await import('/src/terrain.js'), g = window.__game, t = T.TRAILS[1], p = T.pathPoint(t, 24);
    g.car.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.6, z: p.z }, Math.atan2(-p.tx, -p.tz));
    g.hud.waypoints.add(p.x + 50, p.z - 60);
    await new Promise((r) => setTimeout(r, 2000));
  }, vehicle);
  await key(page, 'KeyP');
  await page.evaluate(() => { for (const d of [-100, -100]) dispatchEvent(new WheelEvent('wheel', { deltaY: d, cancelable: true })); });
  await key(page, 'KeyE');
  await page.evaluate(async () => { dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })); await new Promise((r) => setTimeout(r, 1800)); });
  return page;
}

// 1. full HUD mock-ups
let page = await drive(1600, 900, 1);
await page.evaluate(() => window.__game.hud.toast('Granite Steps · Moderate. Good luck!', 6));
await sleep(page, 500);
await page.screenshot({ path: `${OUT}/hud_mockup.png` });
await page.close();
page = await drive(1280, 720, 0);
await sleep(page, 300);
await page.screenshot({ path: `${OUT}/hud_mockup_720.png` });

// 2. parts sheet: the same drawing code, posed and drawn large
await page.setViewportSize({ width: 1700, height: 1450 });
await key(page, 'KeyM');
await sleep(page, 600);
await page.evaluate(async () => {
  const px = await import('/src/hud/px.js'), ins = await import('/src/hud/instruments.js');
  const { P, mk, board, sign, tiny } = px;
  const W = 560, H = 468, S = 3, f = mk(W, H), g = f.g;
  board(g, 0, 0, W, H, { seed: 40, nails: true });
  sign(g, 'LOWRANGE HUD PARTS', 8, 5);
  const cap = (t, x, y) => tiny(g, t, x, y, P.paint, { shadow: P.ol });
  // dials
  const tach = new ins.Dial(55), sp = new ins.Dial(55);
  tach.configure({ max: 7000, major: 1000, minor: 1000, div: 1000, red: 6000, title: 'RPM' });
  sp.configure({ max: 200, major: 50, minor: 25, title: 'KM/H' });
  tach.draw(g, 8, 22, 3400, '3400', 5); cap('TACHOMETER', 8, 80);
  sp.draw(g, 68, 22, 47, '47', 5); cap('SPEEDOMETER', 68, 80);
  const tach2 = new ins.Dial(55); tach2.configure({ max: 7000, major: 1000, minor: 1000, div: 1000, red: 6000, title: 'RPM' });
  tach2.draw(g, 128, 22, 6500, '6500', 5, true); cap('REDLINE', 132, 80);
  // shifters
  let x = 192;
  const shift = (n, gear, label, mid) => {
    const s = new ins.Shifter(); s.configure(n);
    if (mid) { s.setGear(mid[0]); s.update(5); s.setGear(mid[1]); s.update(mid[2]); } else { s.setGear(gear); s.update(5); }
    s.draw(g, x, 22, { clutchIn: label.includes('CLUTCH') });
    cap(label, x, 80); x += 58;
  };
  shift(6, 0, '6SP N'); shift(6, 1, '6SP 1ST'); shift(6, -1, '6SP R'); shift(6, 4, '6SP 4 CLUTCH');
  shift(6, null, '1-2 VIA N', [1, 2, 0.17]);
  x = 8;
  const row2 = 98;
  const s5 = new ins.Shifter(); s5.configure(5); s5.setGear(5); s5.update(5); s5.draw(g, x, row2); cap('5SP 5TH', x, row2 + 58); x += 58;
  const s4 = new ins.Shifter(); s4.configure(4); s4.setGear(-1); s4.update(5); s4.draw(g, x, row2); cap('4SP R', x, row2 + 58); x += 60;
  for (const pos of ['2H', '4H', '4L']) { const t = new ins.TransferLever(); t.update(5, pos); t.draw(g, x, row2, { has2H: true, has4L: true }); cap(pos, x + 6, row2 + 58); x += 30; }
  { const t = new ins.TransferLever(); t.update(5, '4H'); t.draw(g, x, row2, { has2H: false, has4L: false }); cap('AWD', x + 2, row2 + 58); x += 32; }
  ins.drawLockers(g, x, row2, { front: false, rear: false, hasF: true, hasR: true }); cap('OPEN', x + 2, row2 + 58); x += 30;
  ins.drawLockers(g, x, row2, { front: true, rear: true, hasF: true, hasR: true }); cap('LOCKED', x, row2 + 58); x += 30;
  ins.drawLockers(g, x, row2, { front: false, rear: true, hasF: false, hasR: true }); cap('NO F', x + 3, row2 + 58); x += 32;
  for (const on of [false, true]) { const p = new ins.ParkLever(); p.update(5, on); p.draw(g, x, row2, { park: on, held: false }); cap(on ? 'PARK ON' : 'PARK OFF', x, row2 + 58); x += 34; }
  ins.drawPedals(g, x, row2 + 4, { t: 0.7, b: 0.2, c: 0.5 }); cap('PEDALS', x - 4, row2 + 58); x += 26;
  x += 2;
  for (const [l, st, k] of [['4WD', 'on'], ['AIRED', null], ['AUTO-CL', 'good'], ['STALL I', 'warn'], ['RECOVER', null, 'button']]) { ins.drawLamp(g, x, row2 + 2, l, st, k); g.translate(0, 12); }
  g.setTransform(1, 0, 0, 1, 0, 0); cap('LAMPS', x, row2 + 62);
  // inclinometers
  x = 8; const row3 = 176;
  for (const [deg, kind] of [[0, 'pitch'], [22, 'pitch'], [-42, 'pitch'], [0, 'roll'], [18, 'roll'], [34, 'roll']]) {
    ins.drawIncl(g, x, row3, deg, kind, kind === 'pitch' ? 38 : 30, 0);
    cap(`${kind.toUpperCase()} ${deg}`, x + 2, row3 + 46); x += 50;
  }
  // map small + expanded, copied from the live HUD canvases
  const mini = document.querySelector('.hud-mini'), big = document.querySelector('.hud-map');
  g.drawImage(mini, 8, 236 - 0); cap('MINIMAP + GUIDE', 8, 236 + mini.height + 2);
  g.drawImage(big, 124, 236);
  cap('EXPANDED MAP (M)', 312, 226);
  const cv = f.cv; cv.id = 'partsSheet';
  Object.assign(cv.style, { position: 'fixed', left: '0', top: '0', width: `${W * S}px`, height: `${H * S}px`, imageRendering: 'pixelated', zIndex: 1000 });
  document.body.appendChild(cv);
});
await sleep(page, 200);
await page.screenshot({ path: `${OUT}/hud_parts.png`, clip: { x: 0, y: 0, width: 560 * 3, height: 468 * 3 } });
await browser.close();
console.log('wrote', `${OUT}/hud_mockup.png`, `${OUT}/hud_mockup_720.png`, `${OUT}/hud_parts.png`);
