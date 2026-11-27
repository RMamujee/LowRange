// Browser check of the spawn points (src/spawns.js + the big map + the pause menu), on each map:
// J opens the map on the spawn list; keyboard (arrows + Enter, Enter) and mouse (signpost click +
// second click, list row + SPAWN button) both teleport; the truck lands on the point repaired, at rest,
// parking brake on, neutral; driving forward through the gate then starts a run (trail / stage /
// checkpoint); click-to-place and right-click-remove waypoints still work; the pause menu's
// "Spawn points" and "Restart at <last spawn>" work; saved ids are validated; teleports don't leak.
// Screenshots go to OUT (default test/shots).
// Usage: CHROME=... PORT=5951 node test/spawnsbrowser.mjs [park|race|crawl|all]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const which = process.argv[2] || 'all';
const OUT = process.env.OUT || 'test/shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
let fails = 0;
const check = (ok, msg) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if (!ok) fails++; };
const base = `http://localhost:${process.env.PORT || 5951}/`;

async function open(qs = '', vehicle = 0) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [], warns = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (m.type() === 'warning' && /\[spawns\]/.test(m.text())) warns.push(m.text()); });
  await page.goto(base + qs, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
  await page.evaluate(async (v) => { localStorage.removeItem(`lowrange.spawn.${window.__game.map}`); document.querySelectorAll('.card')[v].click(); document.getElementById('goBtn').click(); await new Promise((r) => setTimeout(r, 1500)); }, vehicle);
  return { page, errors, warns };
}
const sleep = (page, ms) => page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), ms);
const key = (page, code) => page.evaluate(async (c) => { dispatchEvent(new KeyboardEvent('keydown', { code: c, cancelable: true })); await new Promise((r) => setTimeout(r, 40)); dispatchEvent(new KeyboardEvent('keyup', { code: c })); await new Promise((r) => setTimeout(r, 60)); }, code);
const hold = (page, code, on) => page.evaluate(([c, on]) => dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code: c })), [code, on]);
const dbg = (page) => page.evaluate(() => { const d = window.__game.hud.debug(); delete d.map; return d; });
const truck = (page) => page.evaluate(() => {
  const g = window.__game, c = g.car, p = c.chassis.translation(), v = c.chassis.linvel(), h = c.health;
  return { x: p.x, z: p.z, speed: Math.hypot(v.x, v.y, v.z), gear: c.dt.gear, park: g.parkBrake, healthy: h.engine === 1 && h.body === 1 && h.tire.every((q) => q === 1) && h.susp.every((q) => q === 1) && !c.broken.some(Boolean), up: !c.upsideDown(), active: g.activeTrail, last: g.lastSpawn?.id };
});
// client point of a map-canvas pixel
const canvasPt = (page, vx, vy) => page.evaluate(([vx, vy]) => { const cv = document.querySelector('.hud-map'), r = cv.getBoundingClientRect(); return [r.left + (vx + 0.5) * r.width / cv.width, r.top + (vy + 0.5) * r.height / cv.height]; }, [vx, vy]);
const worldPt = (page, wx, wz) => page.evaluate(([wx, wz]) => { const m = window.__game.hud.debug().map, f = m.frame(); return m.toView(f, wx, wz); }, [wx, wz]);
async function clickWorld(page, wx, wz, button = 'left', dy = 0) { const [vx, vy] = await worldPt(page, wx, wz); const [x, y] = await canvasPt(page, vx, vy + dy); await page.mouse.click(x, y, { button }); await sleep(page, 150); }
async function clickHit(page, pred) {
  const h = await page.evaluate((src) => { const m = window.__game.hud.debug().map; const f = new Function('h', `return (${src})(h)`); return [...m.hits, ...m.promptHits].find((h) => f(h)) || null; }, pred.toString());
  if (!h) return false;
  const [x, y] = await canvasPt(page, h.x + h.w / 2, h.y + h.h / 2); await page.mouse.click(x, y); await sleep(page, 150); return true;
}
async function landed(page, sp, label) {
  await sleep(page, 2600);
  const t = await truck(page), d = await dbg(page);
  const dist = Math.hypot(t.x - sp.x, t.z - sp.z);
  check(dist < 1.2 && t.healthy && t.park && (t.gear === 0 || (sp.kind === 'grid' && t.gear === 1)) && t.up && t.speed < 0.15 && !t.active && !d.mapOpen && t.last === sp.id,
    `${label}: landed on "${sp.name}" (${dist.toFixed(2)} m off, speed ${t.speed.toFixed(2)}), repaired ${t.healthy}, parking brake ${t.park}, gear ${t.gear}, no run ${!t.active}, map closed ${!d.mapOpen}`);
  check(d.lastToast.includes(sp.name), `${label}: toast names the point ("${d.lastToast}")`);
  return t;
}
// drive straight ahead until cond() or timeout
async function driveUntil(page, cond, secs) {
  await key(page, 'KeyP'); // release the parking brake
  await page.evaluate(() => dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))); await sleep(page, 300);
  await hold(page, 'KeyW', true);
  let ok = false;
  for (let k = 0; k < secs * 4 && !ok; k++) { await sleep(page, 250); ok = await page.evaluate(cond); }
  await hold(page, 'KeyW', false);
  return ok;
}

for (const map of which === 'all' ? ['park', 'crawl', 'race'] : [which]) {
  console.log(map);
  const { page, errors, warns } = await open(map === 'park' ? '' : `?map=${map}`, map === 'race' ? 2 : 1);
  const list = await page.evaluate(() => window.__game.spawns);
  check(list.length >= { park: 6, race: 7, crawl: 14 }[map], `${list.length} spawn points: ${list.map((s) => s.id).join(', ')}`);
  if (warns.length) console.log('    (skipped with a warning: ' + warns.map((w) => w.replace(/.*skipped /, '')).join(' | ') + ')');

  // ---- map with signposts (info tab), one hovered so its name shows
  await key(page, 'KeyM');
  const hov = list[Math.min(2, list.length - 1)];
  { const [vx, vy] = await worldPt(page, hov.x, hov.z); const [x, y] = await canvasPt(page, vx, vy - 9); await page.mouse.move(x, y); await sleep(page, 250); }
  let d = await dbg(page);
  check(d.mapOpen && d.spawn.hover === list.indexOf(list.find((s) => s.id === hov.id)), `M map shows signposts; hovering one names it (hover ${d.spawn.hover})`);
  await page.screenshot({ path: `${OUT}/spawn_map_${map}.png` });
  await page.mouse.move(5, 5);
  // ---- waypoints still work alongside the signposts: click empty map, right-click removes
  await page.evaluate(() => window.__game.hud.waypoints.clear());
  const empty = await page.evaluate(() => { // a spot far from every spawn point and the truck
    const g = window.__game, p = g.car.chassis.translation();
    for (let r = 30; r < 160; r += 10) for (let a = 0; a < 6.28; a += 0.4) { const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r; if (Math.abs(x) < 170 && Math.abs(z) < 170 && g.spawns.every((s) => Math.hypot(s.x - x, s.z - z) > 30)) return [x, z]; }
    return [0, 0];
  });
  await clickWorld(page, empty[0], empty[1]);
  d = await dbg(page);
  check(d.wps.length === 1 && d.spawn.prompt < 0, `click on empty map still places a waypoint (${d.wps.length}), no spawn prompt`);
  await clickWorld(page, empty[0], empty[1], 'right');
  d = await dbg(page);
  check(d.wps.length === 0, 'right-click on the waypoint still removes it');
  await key(page, 'KeyM');

  // ---- keyboard: J opens the list, arrows select, Enter asks, Enter spawns
  await key(page, 'KeyJ');
  d = await dbg(page);
  check(d.mapOpen && d.spawn.tab === 'spawn' && d.spawn.sel >= 0, `J opens the map on the spawn list (selected ${d.spawn.sel})`);
  // target: a trail start (park), a mid-course stage (crawl), a checkpoint (race)
  const target = map === 'park' ? list.find((s) => s.kind === 'trail' && s.end === 0 && s.diff !== 'green') || list.find((s) => s.kind === 'trail')
    : map === 'crawl' ? list.find((s) => s.id === 'stage-3')
    : await page.evaluate(() => { const g = window.__game; let best = null, bd = Infinity; return import('/src/terrain.js').then((T) => { for (const s of g.spawns) if (s.cp) { const c = T.CHECKPOINTS[s.cp], d = Math.hypot(c.x - s.x, c.z - s.z); if (d < bd) { bd = d; best = s; } } return best; }); }); // the checkpoint spawn nearest its line
  const ti = list.findIndex((s) => s.id === target.id);
  for (let k = 0; k < 30 && (await dbg(page)).spawn.sel !== ti; k++) await key(page, (await dbg(page)).spawn.sel < ti ? 'ArrowDown' : 'ArrowUp');
  d = await dbg(page);
  check(d.spawn.sel === ti, `arrow keys select "${target.name}" (${d.spawn.sel}/${ti})`);
  const before = await truck(page);
  await page.screenshot({ path: `${OUT}/spawn_list_${map}.png` });
  await key(page, 'Enter');
  d = await dbg(page);
  check(d.spawn.prompt === ti && d.mapOpen, 'Enter opens the "Spawn here?" prompt');
  check(Math.hypot((await truck(page)).x - before.x, (await truck(page)).z - before.z) < 0.5, 'the truck did not move or drive while arrows / Enter worked the list');
  await page.screenshot({ path: `${OUT}/spawn_prompt_${map}.png` });
  await key(page, 'Escape');
  d = await dbg(page);
  check(d.mapOpen && d.spawn.prompt < 0, 'Esc closes the prompt first, the map stays open');
  await key(page, 'Enter'); await key(page, 'Enter');
  await landed(page, target, 'keyboard');
  if (map !== 'race') { const g = await dbg(page); check(g.guideAng !== null && Math.abs(g.guideAng) < 0.35, `the HUD arrow points ahead at the gate (${g.guideAng?.toFixed(2)} rad)`); }
  if (map === 'park') await page.screenshot({ path: `${OUT}/spawn_trail_start.png` });
  if (map === 'crawl') await page.screenshot({ path: `${OUT}/spawn_stage_crawl.png` });

  // ---- driving forward through the gate starts a run
  if (map === 'park') {
    const ok = await driveUntil(page, () => !!window.__game.activeTrail, 30);
    const t = await truck(page), d2 = await dbg(page);
    check(ok && t.active.trail === target.trail && t.active.from === 0, `driving into the gate starts ${target.name.split(':')[0]} (${JSON.stringify(t.active)}, “${d2.lastToast}”)`);
  } else if (map === 'crawl') {
    const ok = await driveUntil(page, () => { const c = window.__game.crawl; return c && c.stage === 3; }, 30);
    const c = await page.evaluate(() => window.__game.crawl);
    check(ok && c.running && !c.clean && c.stage === 3, `driving through gate 3 starts a run that does not count as a best (${JSON.stringify({ stage: c.stage, running: c.running, clean: c.clean })})`);
  } else {
    const ok = await driveUntil(page, () => window.__game.race.next !== (window.__game.lastSpawn.cp), 30);
    const r = await page.evaluate(() => ({ next: window.__game.race.next, started: window.__game.race.started, lap: window.__game.race.lap, state: window.__game.race.state }));
    check(ok && r.next === (target.cp + 1) % 7 && !r.started && r.lap === 0, `driving through checkpoint ${target.cp} counts it, no lap credit (${JSON.stringify(r)})`);
  }

  // ---- mouse: signpost click opens the prompt, a second click spawns; list row + SPAWN button
  const mt = list.find((s) => s.default);
  await key(page, 'KeyM');
  await clickWorld(page, mt.x, mt.z, 'left', -9);
  d = await dbg(page);
  check(d.spawn.prompt === list.indexOf(mt), `clicking the "${mt.name}" signpost opens its prompt`);
  await clickWorld(page, mt.x, mt.z, 'left', -9);
  await landed(page, mt, 'signpost click x2');
  const rt = list[list.length - 1];
  await key(page, 'KeyJ');
  // scroll until the last row is drawn (six notches were enough before the Gauntlet's side courses
  // lengthened its list; the last row stayed off the bottom and every check after this failed)
  for (let k = 0; k < 40; k++) {
    if (k >= 6 && await page.evaluate(() => window.__game.hud.debug().map.hits.some((h) => h.act === 'spawnrow' && h.i === window.__game.spawns.length - 1))) break;
    await page.evaluate(() => { const cv = document.querySelector('.hud-map'), r = cv.getBoundingClientRect(); cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: r.right - 40, clientY: r.top + r.height / 2, cancelable: true })); });
    if (k >= 5) await sleep(page, 120); // (hits are rebuilt on the next drawn frame)
  }
  d = await dbg(page);
  { const L = await page.evaluate(() => { const l = window.__game.hud.debug().map.list; return [l.content, l.h]; }); check(L[0] <= L[1] ? d.spawn.scroll === 0 : d.spawn.scroll > 0, `wheel scrolls the list when it overflows (content ${L[0]} / ${L[1]} px, scroll ${d.spawn.scroll})`); }
  check(await clickHit(page, (h) => h.act === 'spawnrow' && h.i === window.__game.spawns.length - 1), `clicked the "${rt.name}" row`);
  d = await dbg(page);
  check(d.spawn.prompt === list.length - 1, 'a list row opens its prompt');
  check(await clickHit(page, (h) => h.act === 'confirm'), 'clicked SPAWN');
  await landed(page, rt, 'list row + SPAWN');

  // ---- pause menu: Spawn points, Restart at <last spawn>
  await page.evaluate(async () => { const c = window.__game.car, p = c.chassis.translation(); c.reset({ x: p.x + 6, y: p.y + 1, z: p.z + 6 }, 0); c.health.engine = 0.6; await new Promise((r) => setTimeout(r, 800)); });
  await key(page, 'Escape'); await sleep(page, 500);
  const pm = await page.evaluate(() => ({ paused: window.__game.paused, sp: !document.getElementById('spawnBtn').classList.contains('hidden'), last: !document.getElementById('lastSpawnBtn').classList.contains('hidden'), label: document.getElementById('lastSpawnBtn').textContent }));
  check(pm.paused && pm.sp && pm.last && pm.label.includes(rt.name), `pause menu shows "Spawn points" and "${pm.label}"`);
  if (map === 'park') await page.screenshot({ path: `${OUT}/spawn_pause.png` });
  await page.evaluate(() => document.getElementById('lastSpawnBtn').click());
  await landed(page, rt, 'pause: Restart at last spawn');
  await key(page, 'Escape'); await sleep(page, 400);
  await page.evaluate(() => document.getElementById('spawnBtn').click()); await sleep(page, 400);
  d = await dbg(page);
  check(!(await page.evaluate(() => window.__game.paused)) && d.mapOpen && d.spawn.tab === 'spawn', 'pause: "Spawn points" resumes and opens the spawn list');
  await key(page, 'KeyJ');
  d = await dbg(page);
  check(!d.mapOpen, 'J again closes it');

  // ---- no leaks after many teleports
  const leak = await page.evaluate(async () => {
    // loose stones / logs near the truck become bodies and go back to sleep (src/physics_props.js):
    // count them out, so what's left is the world + the truck
    const g = window.__game, count = () => { let b = 0, c = 0, o = 0; g.world.forEachRigidBody(() => b++); g.world.forEachCollider(() => c++); g.gfx.scene.traverse(() => o++); const lp = window.__props?.active?.length ?? 0; return [b - lp, c - lp, o]; };
    const a = count();
    for (let k = 0; k < 25; k++) { g.spawnAt(g.spawns[k % g.spawns.length]); await new Promise((r) => setTimeout(r, 30)); }
    g.spawnAt(g.lastSpawn); await new Promise((r) => setTimeout(r, 300));
    return [a, count()];
  });
  // loose props near the truck come and go with its position, so compare at the same spot
  check(leak[1][0] - leak[0][0] <= 2 && leak[1][1] - leak[0][1] <= 2 && leak[1][2] === leak[0][2], `25 teleports: bodies / colliders / scene objects ${leak[0]} -> ${leak[1]}`);

  // ---- saved id validation across a reload
  await page.evaluate((m) => localStorage.setItem(`lowrange.spawn.${m}`, 'no-such-point'), map);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
  const v = await page.evaluate(() => ({ def: window.__game.lastSpawn.default, hidden: document.getElementById('lastSpawnBtn').classList.contains('hidden') }));
  check(v.def && v.hidden, 'an unknown saved spawn id falls back to the default (no "Restart at" button)');
  await page.evaluate((id) => localStorage.setItem(`lowrange.spawn.${window.__game.map}`, id), rt.id);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
  check((await page.evaluate(() => window.__game.lastSpawn.id)) === rt.id, 'the last spawn point is remembered per map across a reload');
  check(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ')})`);
  await page.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
