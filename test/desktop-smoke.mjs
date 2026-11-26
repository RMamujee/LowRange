// Desktop smoke test: launch the Electron app, wait for the game to boot, check the console, screenshot, quit.
//   node test/desktop-smoke.mjs            -> dev shell (electron .), needs `npm run build` first
//   node test/desktop-smoke.mjs --packaged -> release/win-unpacked/LowRange.exe (after `npm run dist:win`)
// The packaged exe has the Node inspect fuse disabled, so Playwright's _electron launcher can't attach to it;
// it is driven over Chromium's DevTools protocol instead (--remote-debugging-port).
import { _electron as electron, chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const exe = join(root, 'release', 'win-unpacked', 'LowRange.exe');
if (packaged && !existsSync(exe)) { console.error('missing ' + exe + ' (run npm run dist:win)'); process.exit(1); }

let win, close, winTitle;
if (packaged) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(exe, [`--remote-debugging-port=${port}`], { stdio: 'ignore' });
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 500));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  }
  if (!browser) { child.kill(); console.error('could not connect to the packaged app'); process.exit(1); }
  const context = browser.contexts()[0];
  win = context.pages()[0] || await context.waitForEvent('page');
  close = async () => { await win.evaluate(() => window.lowrange.quit()).catch(() => {}); await new Promise((r) => child.once('exit', r)); };
} else {
  const app = await electron.launch({ args: [root], cwd: root });
  win = await app.firstWindow();
  winTitle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()).catch(() => '(n/a)');
  close = () => app.close();
}
const errors = [];
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
win.on('pageerror', (e) => errors.push(String(e)));

await win.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 60000 });
await win.waitForTimeout(1500);
const info = await win.evaluate(() => ({
  url: location.href,
  title: document.title,
  desktop: !!(window.lowrange && window.lowrange.isDesktop),
  version: window.lowrange && window.lowrange.version,
  nodeLeak: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
  quitButton: !!document.querySelector('#lrMenuBar'),
  storage: (() => { try { localStorage.setItem('lowrange.smoke', '1'); const ok = localStorage.getItem('lowrange.smoke') === '1'; localStorage.removeItem('lowrange.smoke'); return ok; } catch { return false; } })(),
}));
// settings overlay: F10 opens, a preset click persists, Esc closes it (and only it)
const before = await win.evaluate(() => localStorage.getItem('lowrange.settings.v1'));
await win.keyboard.press('F10');
info.settingsOpens = await win.isVisible('#lrSettings .box');
await win.click('#lrSettings [data-v=low]');
info.settingsSaved = JSON.parse(await win.evaluate(() => localStorage.getItem('lowrange.settings.v1'))).quality === 'low';
await win.keyboard.press('Escape');
info.settingsClosesOnEsc = !(await win.isVisible('#lrSettings .box'));
await win.evaluate((v) => { if (v) localStorage.setItem('lowrange.settings.v1', v); else localStorage.removeItem('lowrange.settings.v1'); }, before);
mkdirSync(join(root, 'test', 'shots'), { recursive: true });
const shot = join(root, 'test', 'shots', packaged ? 'desktop-packaged.png' : 'desktop-dev.png');
await win.screenshot({ path: shot });
console.log(JSON.stringify({ ...info, winTitle, errors, shot }, null, 2));
await close();
process.exit(errors.length || !info.desktop || info.nodeLeak ? 1 : 0);
