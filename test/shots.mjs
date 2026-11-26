// Headless browser check: load the game, report errors, drive each rig, take screenshots.
import { chromium } from 'playwright';
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(process.env.URL || 'http://localhost:5199/', { waitUntil: 'load' }); // e.g. URL=http://localhost:5199/?map=race
await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 60000 });
await page.screenshot({ path: `${out}/menu.png` });
const plan = JSON.parse(process.argv[3] || '[]');
for (const step of plan) {
  const res = await page.evaluate(async (step) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const kd = (c) => dispatchEvent(new KeyboardEvent('keydown', { code: c })), ku = (c) => dispatchEvent(new KeyboardEvent('keyup', { code: c }));
    if (step.vehicle !== undefined) { document.querySelectorAll('.card')[step.vehicle].click(); if (!document.getElementById('menu').classList.contains('hidden')) document.getElementById('goBtn').click(); else { kd('Escape'); await sleep(100); document.querySelectorAll('.card')[step.vehicle].click(); document.getElementById('goBtn').click(); } await sleep(1500); }
    if (step.teleport) { const T = await import('/src/terrain.js'); const t = T.TRAILS[step.teleport[0]]; const p = T.pathPoint(t, step.teleport[1]); const c = window.__game.car; c.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.8, z: p.z }, Math.atan2(-p.tx, -p.tz)); await sleep(1500); }
    if (step.track !== undefined) { const M = await import('/src/maps/racetrack.js'); const f = M.trackFrame(step.track[0]), lat = step.track[1] || 0; const x = f.x - f.tz * lat, z = f.z + f.tx * lat; window.__game.car.reset({ x, y: M.heightAt(x, z) + 1.8, z }, Math.atan2(-f.tx, -f.tz)); window.__game.race?.teleported(); await sleep(1500); }
    if (step.eval) await (0, eval)(step.eval);
    for (const w of step.wheel || []) { dispatchEvent(new WheelEvent('wheel', { deltaY: w, cancelable: true })); await sleep(200); }
    if (step.damage) { const c = window.__game.car; c.health.susp[0] = 0.4; c.health.engine = 0.3; c.dt.powerScale = 0.5; }
    for (const k of step.keys || []) { kd(k); await sleep(60); ku(k); await sleep(60); }
    if (step.hold) { for (const k of step.hold[0]) kd(k); await sleep(step.hold[1]); for (const k of step.hold[0]) ku(k); }
    if (step.cam) { const c = window.__game.cam; c.yaw = step.cam[0]; c.pitch = step.cam[1]; c.dist = step.cam[2]; c.lastDrag = 1e9; }
    if (step.hideBody !== undefined) window.__game.view.body.children.forEach((m) => { if (m.isMesh && m.geometry.type === 'BoxGeometry' && !step.keepFrame?.includes(1)) m.visible = !step.hideBody; else if (m.isGroup) m.visible = !step.hideBody; });
    if (step.wait) await sleep(step.wait);
    const c = window.__game.car;
    const r = window.__game.race; return { name: c.spec.name, active: window.__game.activeTrail, race: r && { state: r.state, lap: r.lap, next: r.next, lapTime: +r.lapTime.toFixed(1), wrong: r.wrong }, pos: [c.chassis.translation().x.toFixed(1), c.chassis.translation().z.toFixed(1)], kmh: (c.speed() * 3.6).toFixed(1), gear: c.dt.gearLabel, health: c.health, broken: c.broken };
  }, step);
  if (step.shot) await page.screenshot({ path: `${out}/${step.shot}.png` });
  console.log(JSON.stringify(res));
}
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
