// Browser regressions from the QA pass (docs/reviews/BUGS.md). Needs a dev server:
//   npx vite --port 5199 --strictPort   then   CHROME=<chrome.exe> node test/browser-qa.mjs
// FAIL = a fixed bug came back. OPEN = a reported bug in a file this test can't fix (see BUGS.md).
// NOT RUN = the setup didn't happen (e.g. the truck didn't flip), so the check proves nothing.
import { chromium } from 'playwright';
const PORT = process.env.PORT || 5199;
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
let fails = 0, open = 0, notRun = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };
const known = (ok, msg) => { if (!ok) { open++; console.log('  OPEN', msg); } else console.log('  ok  ', msg, '(fixed upstream)'); };

async function session(init, qs = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (init) await page.addInitScript(init);
  await page.goto(`http://localhost:${PORT}/${qs}`, { waitUntil: 'load' });
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
// 4. the upside-down hint names the recover key (BUGS.md #4). Only counts if the truck really is on
// its roof and the hint itself was shown (the start-up parking-brake toast covers the first ~7 s).
{
  await key(page, 'Enter'); await page.waitForTimeout(3800);
  await page.evaluate(() => { const c = window.__game.car; c.grace = 1e9; c.chassis.applyImpulse({ x: 0, y: c.mass * 6, z: 0 }, true); c.chassis.applyTorqueImpulse({ x: 0, y: 0, z: c.mass * 5 }, true); }); // half a roll: lands on the roof (9 rolled it over twice, back onto its wheels)
  // on its roof and at rest for a full second (the top of the roll is upside down and slow for a moment too)
  const flipped = await page.waitForFunction(() => { const c = window.__game.car, w = window; w.__lid = c.upsideDown() && Math.abs(c.speed()) < 0.5 ? (w.__lid || 0) + 1 : 0; return w.__lid >= 10; }, null, { timeout: 12000, polling: 100 }).then(() => true, () => false);
  const t = flipped ? await page.waitForFunction(() => /lid/i.test(window.__game.hud.debug().lastToast) && window.__game.hud.debug().lastToast, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => null) : null;
  if (!flipped || !t) { notRun++; console.log('  NOT RUN', `upside-down hint: ${flipped ? 'the truck flipped but the hint never showed (last toast "' + (await page.evaluate(() => window.__game.hud.debug().lastToast)) + '")' : 'the truck did not end up on its roof'}`); }
  else check(!/Press R\b/.test(t) && /Backspace/.test(t), `upside-down toast names Backspace, not R (range): "${t}"`);
  await key(page, 'Backspace'); await page.waitForTimeout(500);
}
// 5. (open, main.js) finishing a trail must not immediately start a new run at the finish gate
{
  await page.evaluate(async () => { const T = await import('/src/terrain.js'); const t = T.TRAILS[0], p = T.pathPoint(t, 3); window.__game.car.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.2, z: p.z }, Math.atan2(-p.tx, -p.tz)); });
  // the run must be over 4 s old to finish (a slow software-GL frame rate made a fixed 5 s wait too short)
  await page.waitForFunction(() => window.__game.activeTrail?.t > 4.5, null, { timeout: 30000, polling: 100 }).catch(() => {});
  await page.evaluate(async () => { const T = await import('/src/terrain.js'); const t = T.TRAILS[0], p = T.pathPoint(t, t.length - 3); window.__game.car.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.2, z: p.z }, Math.atan2(-p.tx, -p.tz)); });
  await page.waitForTimeout(800);
  const a = await page.evaluate(() => window.__game.activeTrail);
  known(a === null, `no trail run active right after finishing (got ${JSON.stringify(a)})`);
}
// 6. (BUGS.md #8) Y restarts the trail the truck is on, not a run it abandoned on another trail;
// on the run's own trail it still goes back to the end that run started from
{
  const tp = (trail, s) => page.evaluate(async ([trail, s]) => { const T = await import('/src/terrain.js'); const t = T.TRAILS[trail], p = T.pathPoint(t, s < 0 ? t.length + s : s); window.__game.car.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.2, z: p.z }, Math.atan2(-p.tx, -p.tz)); }, [trail, s]);
  const startDist = (trail, s) => page.evaluate(async ([trail, s]) => { const T = await import('/src/terrain.js'); const t = T.TRAILS[trail], q = T.pathPoint(t, s < 0 ? t.length + s : s), p = window.__game.car.chassis.translation(); return Math.hypot(q.x - p.x, q.z - p.z); }, [trail, s]);
  await tp(2, 40); await page.waitForTimeout(300); // away from every gate
  await tp(0, 3); await page.waitForTimeout(1500);
  const a0 = await page.evaluate(() => window.__game.activeTrail);
  await tp(1, 30); await page.waitForTimeout(1000);
  await key(page, 'KeyY'); await page.waitForTimeout(400);
  const a1 = await page.evaluate(() => window.__game.activeTrail), d1 = await startDist(1, 7);
  check(a0?.trail === 0 && a1?.trail === 1 && d1 < 3, `Y on trail 1 after abandoning trail 0 restarts trail 1 (run ${JSON.stringify(a1)}, ${d1.toFixed(1)} m from its start)`);
  await tp(2, 40); await page.waitForTimeout(300);
  await tp(0, -3); await page.waitForTimeout(1500);
  await tp(0, 60); await page.waitForTimeout(1000);
  await key(page, 'KeyY'); await page.waitForTimeout(400);
  const a2 = await page.evaluate(() => window.__game.activeTrail), d2 = await startDist(0, -7);
  check(a2?.trail === 0 && a2.from === 1 && d2 < 3, `Y mid-run on the same trail goes back to the far end it started from (run ${JSON.stringify(a2)}, ${d2.toFixed(1)} m)`);
}
// 8. Trail Park gates read START from outside the trail (where every trail-end spawn faces them) and
// FINISH from inside, at both ends; the default spawn looks at the green trail, not Widowmaker Falls
{
  const r = await page.evaluate(async () => {
    const T = await import('/src/terrain.js'), sc = window.__game.gfx.scene;
    const THREE = { Vector3: sc.position.constructor, Quaternion: sc.quaternion.constructor }; // the page's three
    const ends = T.TRAILS.flatMap((t) => [0, 1].map((end) => { const p = T.pathPoint(t, end ? t.length - 3 : 3); return { name: t.name, end, x: p.x, z: p.z, ox: end ? p.tx : -p.tx, oz: end ? p.tz : -p.tz }; }));
    const res = { start: 0, finish: 0, bad: [] }, n = new THREE.Vector3(), q = new THREE.Quaternion(), w = new THREE.Vector3();
    window.__game.gfx.scene.traverse((o) => {
      const kind = o.material?.name === 'gate-start' ? 'start' : o.material?.name === 'gate-finish' ? 'finish' : null;
      if (!kind || !o.isMesh) return;
      o.getWorldPosition(w); o.getWorldQuaternion(q); n.set(0, 0, 1).applyQuaternion(q);
      const e = ends.reduce((a, b) => (Math.hypot(b.x - w.x, b.z - w.z) < Math.hypot(a.x - w.x, a.z - w.z) ? b : a));
      const out = (n.x * e.ox + n.z * e.oz) / Math.hypot(e.ox, e.oz);
      res[kind]++;
      if (kind === 'start' ? out < 0.9 : out > -0.9) res.bad.push(`${e.name} ${e.end ? 'far end' : 'start'} ${kind} faces ${out.toFixed(2)}`);
    });
    const S = T.SPAWN, f = [-Math.sin(S.yaw), -Math.cos(S.yaw)];
    const ahead = ends.map((e) => { const dx = e.x - S.x, dz = e.z - S.z, d = Math.hypot(dx, dz); return { ...e, d, ang: Math.acos((dx * f[0] + dz * f[1]) / d) * 57.3, diff: T.TRAILS.find((t) => t.name === e.name).diff }; }).filter((e) => e.d < 45 && e.ang < 40).sort((a, b) => a.d - b.d);
    return { ...res, ends: ends.length, ahead: ahead.map((e) => `${e.name} ${e.diff} ${e.d.toFixed(0)} m ${e.ang.toFixed(0)} deg`), firstDiff: ahead[0]?.diff };
  });
  check(r.start === r.ends && r.finish === r.ends && r.bad.length === 0, `gates read START outside / FINISH inside at both ends (${r.start}/${r.finish} of ${r.ends}${r.bad.length ? '; ' + r.bad.join(', ') : ''})`);
  check(r.firstDiff === 'green' && r.ahead.length === 1, `default spawn faces only the green trail's gate (${r.ahead.join('; ') || 'none ahead'})`);
}
// 9. camera vs. scenery (src/cam_clear.js): the Spotter's usual stand (9 m ahead, 3 m right) lands in a
// tree, and a tree 6.5 m behind the truck sits on the Chase camera's line; neither camera may end up
// inside the canopy (the playtest found the Spotter inside a tree after a crash)
{
  const pose = (mode, place) => page.evaluate(async ([mode, place]) => {
    const T = await import('/src/terrain.js'), G = window.__game;
    const rocks = T.generateRocks(), trees = T.generateTrees(rocks);
    const tree = trees.filter((t) => t.s > 1.2).find((t) => trees.every((u) => u === t || Math.hypot(u.x - t.x, u.z - t.z) > 8) && rocks.every((r) => Math.hypot(r.x - t.x, r.z - t.z) > 6)
      && Math.abs(T.heightAt(t.x + 10, t.z) - T.heightAt(t.x - 10, t.z)) < 1.5);
    // facing +x (yaw -pi/2): spotter case puts the truck 9 m before and 3 m left of the tree, chase case
    // 6.5 m past it (closer than ~2.2 m + the canopy radius the camera can't get out of the leaves)
    const x = place === 'spot' ? tree.x - 9 : tree.x + 6.5, z = place === 'spot' ? tree.z + 3 : tree.z;
    G.spawnAt({ id: 'qa-cam', name: 'QA camera', x, z, yaw: -Math.PI / 2 });
    G.cam.mode = mode; G.cam.spot = null;
    return { tree, trees: trees.filter((t) => Math.hypot(t.x - x, t.z - z) < 30) };
  }, [mode, place]);
  const inTree = ({ trees }) => page.evaluate((trees) => {
    const c = window.__game.gfx.camera.position;
    const t = trees.find((t) => c.y > t.y + 1.3 * t.s && c.y < t.y + 6.6 * t.s && Math.hypot(c.x - t.x, c.z - t.z) < 2.3 * t.s);
    return t ? `inside the tree at ${t.x.toFixed(1)},${t.z.toFixed(1)}` : null;
  }, trees);
  const s = await pose(2, 'spot'); await page.waitForTimeout(800);
  check(!(await inTree(s)), `Spotter camera is not inside a tree (${(await inTree(s)) || 'clear'})`);
  const c = await pose(0, 'chase'); await page.waitForTimeout(2500);
  const d = await page.evaluate(() => { const c = window.__game.gfx.camera.position, p = window.__game.car.chassis.translation(); return Math.hypot(c.x - p.x, c.z - p.z); });
  check(!(await inTree(c)) && d < 4, `Chase camera pulled in short of the tree behind the truck (${(await inTree(c)) || 'clear'}, ${d.toFixed(1)} m from the truck)`);
  await page.evaluate(() => { window.__game.cam.mode = 0; });
}
// 10. "All N trails conquered!" fires once per session: after every trail is done, a restart at the
// trailhead (or a rig change) used to reset only the clock, so finishing any one trail again showed it
// at once with the new, short "Total"
{
  const run = async (i) => {
    const tp = (i, far) => page.evaluate(async ([i, far]) => { const T = await import('/src/terrain.js'), t = T.TRAILS[i], p = T.pathPoint(t, far ? t.length - 3 : 3); window.__game.car.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.2, z: p.z }, Math.atan2(-p.tx, -p.tz)); }, [i, far]);
    const away = () => page.evaluate(async () => { const T = await import('/src/terrain.js'), t = T.TRAILS[2], p = T.pathPoint(t, 40); window.__game.car.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.2, z: p.z }, 0); });
    await away(); await page.waitForTimeout(200);
    await tp(i, false);
    const started = await page.waitForFunction((i) => window.__game.activeTrail?.trail === i && window.__game.activeTrail.t > 4.5, i, { timeout: 30000, polling: 100 }).then(() => true, () => false);
    await tp(i, true); await page.waitForTimeout(600);
    return started && (await page.evaluate(() => window.__game.activeTrail)) === null;
  };
  const n = await page.evaluate(async () => (await import('/src/terrain.js')).TRAILS.length);
  let ok = true, conquered = 0;
  for (let i = 0; i < n; i++) { ok = (await run(i)) && ok; if (/conquered/.test(await page.evaluate(() => window.__game.hud.debug().lastToast))) conquered++; }
  await key(page, 'Escape'); await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('restartBtn').click()); await page.waitForTimeout(1500);
  ok = (await run(0)) && ok;
  const again = /conquered/.test(await page.evaluate(() => window.__game.hud.debug().lastToast));
  if (!ok) { notRun++; console.log('  NOT RUN', 'all-trails toast: a trail run did not start or finish'); }
  else check(conquered === 1 && !again, `"all trails conquered" shown once (${conquered} time(s) in the first round, ${again ? 'again' : 'not again'} after a restart and one more trail)`);
}
check(errors.length === 0, `no console errors${errors.length ? ': ' + errors[0] : ''}`);
await page.close();
// 7. Gauntlet big map: an off-map stored waypoint is dropped, and with all 3 waypoints set the
// sidebar's key hints stay below the CLEAR ALL button (they used to be drawn over it)
{
  const { page, errors, booted } = await session(() => {
    if (sessionStorage.getItem('qaSeeded')) return;
    sessionStorage.setItem('qaSeeded', '1');
    localStorage.setItem('lowrange.waypoints.crawl', '[{"x":1e9,"z":0},{"x":10,"z":10},{"x":-20,"z":15},{"x":5,"z":-30}]');
  }, '?map=crawl');
  const wps = booted ? await page.evaluate(() => window.__game.hud.waypoints.list) : [];
  check(wps.length === 3 && wps.every((w) => Math.abs(w.x) < 1000), `off-map stored waypoint dropped (${JSON.stringify(wps)})`);
  await key(page, 'Enter'); await page.waitForTimeout(1500);
  await page.evaluate(() => window.__game.hud.toggleMap()); await page.waitForTimeout(500);
  const r = await page.evaluate(() => { const m = window.__game.hud.debug().map, c = m.hits.find((h) => h.act === 'clear'); return { tab: m.tab, clearBottom: c ? c.y + c.h : null, hintsTop: m.hintsTop }; });
  check(r.clearBottom !== null && r.hintsTop >= r.clearBottom, `Gauntlet map hints clear of CLEAR ALL (${JSON.stringify(r)})`);
  // 11. a Gauntlet run, then into a side course through a later section gate: the side course's run takes
  // over game.active (it kept the Gauntlet's, so the big map showed The Gauntlet running on its clock)
  {
    await page.evaluate(() => window.__game.hud.toggleMap());
    const walk = (which, s0, s1) => page.evaluate(async ([which, s0, s1]) => {
      const T = await import('/src/terrain.js'), path = which < 0 ? T.TRAILS[0] : T.COURSES[which];
      for (let s = s0; s <= s1; s += 0.5) { const p = T.pathPoint(path, s); window.__game.car.reset({ x: p.x, y: T.heightAt(p.x, p.z) + 1.0, z: p.z }, Math.atan2(-p.tx, -p.tz)); await new Promise((r) => requestAnimationFrame(r)); }
    }, [which, s0, s1]);
    const [g0, s2, id] = await page.evaluate(async () => { const T = await import('/src/terrain.js'); return [T.TRAILS[0].stages[0].gateS, T.COURSES[0].stages[1].gateS, T.COURSES[0].id]; });
    await walk(-1, g0 - 4, g0 + 4);
    const a0 = await page.evaluate(() => window.__game.activeTrail);
    await walk(0, s2 - 4, s2 + 4);
    const a1 = await page.evaluate(() => window.__game.activeTrail);
    if (!a0 || a0.course !== null) { notRun++; console.log('  NOT RUN', `side course join: the Gauntlet run did not start (${JSON.stringify(a0)})`); }
    else check(a1?.course === id, `joining ${id} at section 2 during a Gauntlet run: the run is the side course's (${JSON.stringify(a1)})`);
  }
  check(errors.length === 0, `no console errors on the Gauntlet map${errors.length ? ': ' + errors[0] : ''}`);
}
await browser.close();
const nr = notRun ? `, ${notRun} NOT RUN` : '';
console.log(fails ? `${fails} FAILURES, ${open} open${nr}` : notRun ? `browser-qa: ${notRun} check(s) NOT RUN (setup failed), the rest passed, ${open} open` : `browser-qa: all fixed checks passed, ${open} open (see docs/reviews/BUGS.md)`);
process.exit(fails || notRun ? 1 : 0);
