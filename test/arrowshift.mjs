// Browser check of keyboard shifting (no mouse needed): Arrow Up / Arrow Down shift one gear per
// press through the same path as PageUp / PageDown and the mouse wheel (clutch / grind rules included),
// a held arrow does not machine-gun through the gears, the arrows no longer feed the throttle / brake
// (W / S do), the page doesn't scroll, and the arrows keep their own job (no shifting) while the spawn
// list, the pause menu or the settings overlay is up.
// Usage: CHROME=... PORT=5199 node test/arrowshift.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
let fails = 0;
const check = (ok, msg) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if (!ok) fails++; };
const base = `http://localhost:${process.env.PORT || 5199}/`;

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
await page.evaluate(async () => { document.querySelectorAll('.card')[0].click(); document.getElementById('goBtn').click(); await new Promise((r) => setTimeout(r, 1500)); });

const sleep = (ms) => page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), ms);
const gear = () => page.evaluate(() => window.__game.car.dt.gear);
const press = async (code) => { await page.keyboard.press(code); await sleep(60); };
const nGears = await page.evaluate(() => window.__game.car.dt.spec.gears.length);
await page.evaluate(() => { window.__game.car.dt.autoClutch = true; });

// --- down through every gear to reverse, one per press
const down = [await gear()];
for (let i = 0; i < nGears + 2; i++) { await press('ArrowDown'); down.push(await gear()); }
check(down.at(-1) === -1, `Arrow Down reaches reverse (${down.join(' ')})`);
check(down.every((g, i) => i === 0 || g === Math.max(-1, down[i - 1] - 1)), 'Arrow Down: exactly one gear per press');
// --- up through every gear to top
const up = [await gear()];
for (let i = 0; i < nGears + 2; i++) { await press('ArrowUp'); up.push(await gear()); }
check(up.at(-1) === nGears, `Arrow Up reaches top gear ${nGears} (${up.join(' ')})`);
check(up.every((g, i) => i === 0 || g === Math.min(nGears, up[i - 1] + 1)), 'Arrow Up: exactly one gear per press, through R, N, 1..top');

// --- holding the key (auto-repeat keydowns) shifts once
for (let i = 0; i < 3; i++) await press('ArrowDown');
let g0 = await gear();
await page.keyboard.down('ArrowDown');
for (let i = 0; i < 8; i++) { await page.keyboard.down('ArrowDown'); await sleep(40); } // Playwright marks these repeat: true
check(await page.evaluate(() => window.__game.input.brake) === 0, 'held Arrow Down does not press the brake');
await page.keyboard.up('ArrowDown');
check(await gear() === g0 - 1, `held Arrow Down shifts once, no repeat (${g0} -> ${await gear()})`);
g0 = await gear();
await page.keyboard.down('ArrowUp');
for (let i = 0; i < 8; i++) { await page.keyboard.down('ArrowUp'); await sleep(40); }
check(await page.evaluate(() => window.__game.input.throttle) === 0, 'held Arrow Up does not press the throttle');
await page.keyboard.up('ArrowUp');
check(await gear() === g0 + 1, `held Arrow Up shifts once, no repeat (${g0} -> ${await gear()})`);

// --- W / S are still the pedals
await page.keyboard.down('KeyW'); await sleep(400);
check(await page.evaluate(() => window.__game.input.throttle) > 0.2, 'W still works the throttle');
await page.keyboard.up('KeyW');
await page.keyboard.down('KeyS'); await sleep(300);
check(await page.evaluate(() => window.__game.input.brake) > 0.2, 'S still works the brake');
await page.keyboard.up('KeyS');

// --- PageUp / PageDown still shift; the arrows don't scroll the page
g0 = await gear(); await press('PageDown'); await press('PageUp');
check(await gear() === g0, 'PageDown / PageUp still shift');
const prevented = await page.evaluate(() => ['ArrowUp', 'ArrowDown'].map((c) => {
  const ok = !dispatchEvent(new KeyboardEvent('keydown', { code: c, cancelable: true })); dispatchEvent(new KeyboardEvent('keyup', { code: c })); return ok;
}));
check(prevented.every(Boolean) && (await page.evaluate(() => scrollY)) === 0, 'arrow keydowns are preventDefault-ed, page stays at the top');

// --- same clutch rule as every other shift: manual clutch with the pedal up grinds, Space lets it in
await page.evaluate(() => { window.__game.car.dt.autoClutch = false; });
g0 = await gear(); await press('ArrowDown');
check(await gear() === g0, 'manual clutch, pedal up: Arrow Down is refused (grind)');
await page.keyboard.down('Space'); await sleep(400); await press('ArrowDown'); await page.keyboard.up('Space');
check(await gear() === g0 - 1, 'manual clutch, Space held: Arrow Down shifts');
await page.evaluate(() => { window.__game.car.dt.autoClutch = true; });

// --- spawn list (J): arrows move the selection, not the gear
await press('KeyJ'); await sleep(300);
const dbg = () => page.evaluate(() => { const d = window.__game.hud.debug(); return { open: d.mapOpen, tab: d.spawn.tab, sel: d.spawn.sel }; });
let s = await dbg(); g0 = await gear();
await press(s.sel > 0 ? 'ArrowUp' : 'ArrowDown');
let s2 = await dbg();
check(s.open && s.tab === 'spawn' && s2.sel !== s.sel, `spawn list: arrow moves the selection (${s.sel} -> ${s2.sel})`);
await press('ArrowDown'); await press('ArrowUp');
check(await gear() === g0, 'spawn list open: arrows do not shift');
await press('KeyJ'); await sleep(200);
check(!(await dbg()).open, 'J closes the list');
await press('ArrowDown');
check(await gear() === g0 - 1, 'list closed: Arrow Down shifts again');

// --- pause menu: arrows navigate, no shifting
g0 = await gear();
await press('Escape'); await sleep(300);
check(await page.evaluate(() => window.__game.paused), 'Esc pauses');
await press('ArrowDown'); await press('ArrowDown'); await press('ArrowUp');
check(await gear() === g0, 'pause menu: arrows do not shift');
await press('Escape'); await sleep(300);

// --- settings overlay swallows keys
await press('F10'); await sleep(200);
await press('ArrowDown'); await press('ArrowUp'); await press('ArrowUp');
check(await gear() === g0, 'settings overlay: arrows do not shift');
await press('F10'); await sleep(200);

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
