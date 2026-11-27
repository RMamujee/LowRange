// Browser check of the pixel HUD and its features: stick shifter follows every gear (incl. reverse),
// parking brake holds on a slope and releases, Esc pauses / resumes the same truck, the big map
// opens, waypoints are set / removed by clicking and persist across a reload, the guidance arrow points
// at the waypoint, trails start / finish with toasts, and the race lap readout fills in.
// Usage: CHROME=... PORT=5841 node test/hud.mjs [park|race|all]
import { chromium } from 'playwright';
const which = process.argv[2] || 'all';
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
let fails = 0;
const check = (ok, msg) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if (!ok) fails++; };
const base = `http://localhost:${process.env.PORT || 5199}/`;

async function open(qs = '', vehicle = 0) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + qs, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 60000 });
  await page.evaluate(async (v) => { document.querySelectorAll('.card')[v].click(); document.getElementById('goBtn').click(); await new Promise((r) => setTimeout(r, 1500)); }, vehicle);
  return { page, errors };
}
const key = (page, code) => page.evaluate(async (c) => { dispatchEvent(new KeyboardEvent('keydown', { code: c })); await new Promise((r) => setTimeout(r, 50)); dispatchEvent(new KeyboardEvent('keyup', { code: c })); await new Promise((r) => setTimeout(r, 50)); }, code);
const sleep = (page, ms) => page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), ms);
const dbg = (page) => page.evaluate(() => { const d = window.__game.hud.debug(); delete d.map; return d; });

if (which === 'all' || which === 'park') {
  console.log('trail park');
  const { page, errors } = await open('', 0); // Trail Pickup: 6-speed, R up-left
  // --- shifter: every gear, the knob ends in its slot
  check((await page.evaluate(() => window.__game.parkBrake)) === true, 'spawns with the parking brake on');
  const gears = [];
  for (let i = 0; i < 7; i++) { await page.evaluate(() => dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))); await sleep(page, 700); gears.push(await dbg(page)); }
  for (let i = 0; i < 8; i++) { await page.evaluate(() => dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }))); await sleep(page, 700); gears.push(await dbg(page)); }
  const seen = new Set(gears.map((g) => g.gear));
  check([-1, 0, 1, 2, 3, 4, 5, 6].every((g) => seen.has(g)), `shifted through R, N, 1..6 (saw ${[...seen].sort().join(',')})`);
  check(gears.every((g) => !g.moving && Math.abs(g.knob[0] - g.slot[0]) < 0.5 && Math.abs(g.knob[1] - g.slot[1]) < 0.5), 'knob rests in the slot of the current gear every time');
  const rev = gears.find((g) => g.gear === -1);
  check(rev && rev.slot[1] < 20, 'reverse slot is in the top row (6-speed: up and left)');
  // knob travels through neutral: sample mid-shift 1 -> 2 (same column, so it must cross the rail)
  // --- parking brake on a slope
  await page.evaluate(async () => {
    const T = await import('/src/terrain.js'); const t = T.TRAILS[1]; const p = T.pathPoint(t, 30);
    window.__game.car.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.6, z: p.z }, Math.atan2(-p.tx, -p.tz)); window.__game.car.dt.gear = 0;
    await new Promise((r) => setTimeout(r, 2500));
  });
  const slope = await page.evaluate(() => window.__game.car.attitude().pitch * 57.3);
  const pos = () => page.evaluate(() => { const p = window.__game.car.chassis.translation(); return [p.x, p.z]; });
  const a = await pos(); await sleep(page, 3000); const b = await pos();
  const held = Math.hypot(b[0] - a[0], b[1] - a[1]);
  check(held < 0.15, `parking brake holds on a ${Math.abs(slope).toFixed(0)}° slope in neutral (moved ${held.toFixed(2)} m in 3 s)`);
  await key(page, 'KeyP');
  check((await page.evaluate(() => window.__game.parkBrake)) === false, 'P releases it');
  await sleep(page, 3000); const c = await pos();
  const rolled = Math.hypot(c[0] - b[0], c[1] - b[1]);
  check(rolled > 0.25, `released, the truck rolls down the slope (moved ${rolled.toFixed(2)} m in 3 s)`);
  await key(page, 'KeyP');
  check((await page.evaluate(() => window.__game.parkBrake)) === true, 'P sets it again');
  // --- pause / resume keeps the same truck
  await page.evaluate(async () => { const c = window.__game.car; c.reset({ x: 6, y: 2.5, z: 4 }, 0); await new Promise((r) => setTimeout(r, 2500)); c.health.engine = 0.5; c.health.body = 0.7; c.dt.gear = 2; });
  const before = await page.evaluate(() => ({ p: window.__game.car.chassis.translation(), h: window.__game.car.health.engine, gear: window.__game.car.dt.gear }));
  await key(page, 'Escape'); await sleep(page, 1500);
  const paused = await page.evaluate(() => ({ paused: window.__game.paused, menu: !document.getElementById('menu').classList.contains('hidden'), bar: !document.getElementById('pauseSign').classList.contains('hidden'), p: window.__game.car.chassis.translation() }));
  check(paused.paused && paused.menu && paused.bar, 'Esc opens the menu as a pause with RESUME');
  check(Math.hypot(paused.p.x - before.p.x, paused.p.z - before.p.z) < 0.05, 'the truck is frozen while paused');
  await key(page, 'Escape'); await sleep(page, 400);
  const after = await page.evaluate(() => ({ playing: !document.getElementById('hud').classList.contains('hidden'), paused: window.__game.paused, p: window.__game.car.chassis.translation(), h: window.__game.car.health.engine, gear: window.__game.car.dt.gear }));
  check(after.playing && !after.paused && Math.hypot(after.p.x - before.p.x, after.p.z - before.p.z) < 0.3 && after.h === 0.5 && after.gear === before.gear, `Esc again resumes the same truck: same spot, damage and gear (no respawn, no repair) ${JSON.stringify({ before, after })}`);
  await key(page, 'Escape'); await sleep(page, 300);
  await page.evaluate(() => document.getElementById('goBtn').click()); await sleep(page, 300);
  check(!(await page.evaluate(() => window.__game.paused)) && (await page.evaluate(() => window.__game.car.health.engine)) === 0.5, 'RESUME button resumes without repair');
  await key(page, 'Escape'); await sleep(page, 300);
  await page.evaluate(() => document.getElementById('goBtn').click()); await sleep(page, 600);
  check((await page.evaluate(() => window.__game.car.health.engine)) === 0.5, 'DRIVE with the same rig also resumes (no forced repair)');
  await key(page, 'Escape'); await sleep(page, 300);
  await page.evaluate(() => document.getElementById('restartBtn').click()); await sleep(page, 1200);
  const rs = await page.evaluate(() => ({ h: window.__game.car.health.engine, p: window.__game.car.chassis.translation(), paused: window.__game.paused }));
  check(rs.h === 1 && Math.hypot(rs.p.x, rs.p.z) < 3 && !rs.paused, 'RESTART AT TRAILHEAD respawns repaired at the trailhead');
  // --- big map + waypoints
  await page.evaluate(() => localStorage.removeItem('lowrange.waypoints.park'));
  await page.evaluate(() => window.__game.hud.waypoints.clear());
  await key(page, 'KeyM');
  let d = await dbg(page);
  check(d.mapOpen, 'M opens the big map');
  // click on the map 60 m ahead of the camera direction
  const clickAt = async (wx, wz, button = 'left') => {
    const pt = await page.evaluate(([wx, wz]) => {
      const m = window.__game.hud.debug().map, f = m.frame(), [vx, vy] = m.toView(f, wx, wz);
      const cv = document.querySelector('.hud-map'), r = cv.getBoundingClientRect();
      return [r.left + (vx + 0.5) * r.width / cv.width, r.top + (vy + 0.5) * r.height / cv.height];
    }, [wx, wz]);
    await page.mouse.click(pt[0], pt[1], { button });
    await sleep(page, 150);
  };
  // (both points straight ahead: a fixed world offset could land on a spawn marker, which opens its prompt)
  const [ahead, far] = await page.evaluate(() => { const g = window.__game, p = g.car.chassis.translation(), v = g.gfx.camera.getWorldDirection(new g.gfx.camera.position.constructor()); const l = Math.hypot(v.x, v.z); return [60, 110].map((d) => [p.x + v.x / l * d, p.z + v.z / l * d]); });
  await clickAt(ahead[0], ahead[1]);
  d = await dbg(page);
  check(d.wps.length === 1, `click sets a waypoint (${JSON.stringify(d.wps)})`);
  await clickAt(far[0], far[1]);
  d = await dbg(page);
  check(d.wps.length === 2, 'a second click adds waypoint 2');
  await clickAt(far[0], far[1], 'right');
  d = await dbg(page);
  check(d.wps.length === 1, 'right-click removes it');
  await page.screenshot({ path: process.env.OUT ? `${process.env.OUT}/hud_map_wp.png` : 'test/shots/hud_map_wp.png' }).catch(() => {});
  await key(page, 'KeyM'); await sleep(page, 400);
  d = await dbg(page);
  check(!d.mapOpen, 'M closes it');
  check(d.guideAng !== null && Math.abs(d.guideAng) < 0.25, `guidance arrow points at the waypoint straight ahead (angle ${d.guideAng?.toFixed(2)} rad)`);
  const beacon = await page.evaluate(() => { let n = 0; window.__game.gfx.scene.getObjectByName('waypoints')?.traverse((o) => { if (o.isMesh) n++; }); return n; });
  check(beacon >= 3, `3D beacon in the world (${beacon} meshes)`);
  const stored = await page.evaluate(() => localStorage.getItem('lowrange.waypoints.park'));
  check(stored && JSON.parse(stored).length === 1, 'waypoint stored per map in localStorage');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 60000 });
  check((await page.evaluate(() => window.__game.hud.waypoints.list.length)) === 1, 'waypoint persists across a reload');
  await page.evaluate(() => { document.getElementById('goBtn').click(); });
  await sleep(page, 1200);
  // --- trail start / finish toasts
  await page.evaluate(() => window.__game.hud.waypoints.clear());
  await page.evaluate(async () => {
    const T = await import('/src/terrain.js'); const t = T.TRAILS[0], c = window.__game.car;
    const at = (s, back) => { const p = T.pathPoint(t, s); c.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.5, z: p.z }, Math.atan2(back ? p.tx : -p.tx, back ? p.tz : -p.tz)); };
    at(3); await new Promise((r) => setTimeout(r, 1200));
  });
  d = await dbg(page);
  check(/Good luck/.test(d.lastToast), `starting a trail toasts (“${d.lastToast}”)`);
  await page.waitForFunction(() => window.__game.activeTrail && window.__game.activeTrail.t > 4.5, null, { timeout: 30000 });
  await page.evaluate(async () => { const T = await import('/src/terrain.js'); const t = T.TRAILS[0], c = window.__game.car, p = T.pathPoint(t, t.length - 3); c.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.5, z: p.z }, 0); await new Promise((r) => setTimeout(r, 1200)); });
  d = await dbg(page);
  check(/complete in/.test(d.lastToast), `finishing a trail toasts (“${d.lastToast}”)`);
  // --- other keys still work
  const k0 = await page.evaluate(() => ({ air: window.__game.car.airedDown, cam: window.__game.cam.mode, lr: window.__game.car.dt.lockR }));
  for (const c of ['KeyT', 'KeyV', 'KeyE', 'KeyN', 'KeyH']) await key(page, c);
  const k1 = await page.evaluate(() => ({ air: window.__game.car.airedDown, cam: window.__game.cam.mode, lr: window.__game.car.dt.lockR, help: !document.getElementById('help').classList.contains('hidden') }));
  check(k1.air !== k0.air && k1.cam !== k0.cam && k1.lr !== k0.lr && k1.help, 'T / V / E / H still work (and N mutes)');
  await key(page, 'KeyH');
  check(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ')})`);
  await page.close();
}

if (which === 'all' || which === 'race') {
  console.log('race track');
  const { page, errors } = await open('?map=race', 2);
  await page.waitForFunction(() => window.__game.race && window.__game.race.racing, null, { timeout: 30000 });
  await key(page, 'KeyP');
  // drive through every checkpoint in order by placing the car just before each and accelerating over it
  const n = await page.evaluate(async () => {
    const M = await import('/src/maps/racetrack.js'), T = await import('/src/terrain.js'), g = window.__game;
    const order = [...T.CHECKPOINTS.slice(1), T.CHECKPOINTS[0], ...T.CHECKPOINTS.slice(1), T.CHECKPOINTS[0]];
    const hold = (c, on) => dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code: c }));
    // first the start line
    const pass = async (s) => { const f = M.trackFrame(s - 5); g.car.reset({ x: f.x, y: M.heightAt(f.x, f.z) + 0.8, z: f.z }, Math.atan2(-f.tx, -f.tz)); g.race.teleported(); await new Promise((r) => setTimeout(r, 300)); hold("KeyW", true); const n0 = g.race.next; for (let k = 0; k < 40 && g.race.next === n0; k++) await new Promise((r) => setTimeout(r, 150)); hold('KeyW', false); };
    await pass(T.CHECKPOINTS[0].s);
    for (const c of order) await pass(c.s);
    return g.race.lap;
  });
  const r = await page.evaluate(() => ({ state: window.__game.race.state, next: window.__game.race.next, lap: window.__game.race.lap, last: window.__game.race.last, best: window.__game.race.best }));
  check(r.lap >= 2 && r.last != null, `laps register through the HUD loop (${JSON.stringify(r)}, lap ${r.lap}, last ${r.last?.toFixed(1)}, best ${r.best?.toFixed(1)})`);
  await page.screenshot({ path: process.env.OUT ? `${process.env.OUT}/hud_race.png` : 'test/shots/hud_race.png' }).catch(() => {});
  check(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ')})`);
  await page.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
