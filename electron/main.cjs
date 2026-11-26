// LowRange desktop shell (Electron main process).
//
// Serves the Vite production build (dist/) from a privileged custom scheme, app://lowrange/,
// so the game gets a stable, secure origin (localStorage persists under it in userData) and
// nothing is ever fetched from the network.
'use strict';

const { app, BrowserWindow, Menu, protocol, session, shell, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const APP_ID = 'com.rmamujee.lowrange';
const SCHEME = 'app';
const HOST = 'lowrange';
const ORIGIN = `${SCHEME}://${HOST}`;
const DIST = path.join(__dirname, '..', 'dist');
const IS_DEV = !app.isPackaged;

// Only these sites may be opened, and only in the user's own browser.
const EXTERNAL_ALLOW = new Set(['github.com', 'threejs.org', 'rapier.rs']);

const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
};

app.setAppUserModelId(APP_ID);
app.enableSandbox();
Menu.setApplicationMenu(null);

// must run before 'ready'
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
}]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(start);
}

// ---------------- window state ----------------
const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  const def = { width: 1600, height: 900, maximized: true, fullscreen: false };
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    const ok = (n) => Number.isFinite(n);
    if (!ok(s.width) || !ok(s.height)) return def;
    const st = { width: Math.max(800, s.width), height: Math.max(500, s.height), maximized: !!s.maximized, fullscreen: !!s.fullscreen };
    // only restore the position if it is still on a connected display
    if (ok(s.x) && ok(s.y)) {
      const wa = screen.getDisplayMatching({ x: s.x, y: s.y, width: st.width, height: st.height }).workArea;
      const visible = s.x < wa.x + wa.width - 100 && s.x + st.width > wa.x + 100 && s.y >= wa.y - 20 && s.y < wa.y + wa.height - 100;
      if (visible) { st.x = s.x; st.y = s.y; }
    }
    return st;
  } catch {
    return def;
  }
}

function saveWindowState(win) {
  try {
    const b = win.getNormalBounds();
    const s = { ...b, maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify(s));
  } catch { /* non-fatal: next launch uses defaults */ }
}

// ---------------- helpers ----------------
function isAppUrl(url) {
  try { const u = new URL(url); return u.protocol === `${SCHEME}:` && u.host === HOST; } catch { return false; }
}

function openExternalIfAllowed(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && EXTERNAL_ALLOW.has(u.hostname.replace(/^www\./, ''))) shell.openExternal(u.toString());
  } catch { /* malformed: ignore */ }
}

function fromApp(event) {
  return event.senderFrame && isAppUrl(event.senderFrame.url);
}

function toggleFullscreen(win) {
  if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
}

// ---------------- startup ----------------
function start() {
  const ses = session.defaultSession; // persistent: lives in userData

  // app://lowrange/<path> -> dist/<path>, never outside dist/
  ses.protocol.handle(SCHEME, async (req) => {
    const u = new URL(req.url);
    if (u.host !== HOST) return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Opener-Policy': 'same-origin',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // no camera/mic/geolocation/notifications etc.; fullscreen and pointer lock are all a game needs
  const allowed = new Set(['fullscreen', 'pointerLock']);
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowed.has(perm) && isAppUrl(details.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((wc, perm, origin) => allowed.has(perm) && isAppUrl(origin || ''));
  // nothing may leave the machine
  ses.webRequest.onBeforeRequest((details, cb) => {
    const ok = isAppUrl(details.url) || details.url.startsWith('data:') || details.url.startsWith('blob:') || details.url.startsWith('devtools:');
    cb({ cancel: !ok });
  });

  ipcMain.handle('lowrange:toggle-fullscreen', (e) => {
    if (!fromApp(e)) return false;
    const win = BrowserWindow.fromWebContents(e.sender);
    toggleFullscreen(win);
    return win ? win.isFullScreen() : false;
  });
  ipcMain.handle('lowrange:is-fullscreen', (e) => {
    if (!fromApp(e)) return false;
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? win.isFullScreen() : false;
  });
  ipcMain.on('lowrange:quit', (e) => { if (fromApp(e)) app.quit(); });

  createWindow();
}

function createWindow() {
  const st = loadWindowState();
  // packaged builds take the window icon from the exe; in dev use the repo's build/icon.png
  const devIcon = path.join(__dirname, '..', 'build', 'icon.png');
  const win = new BrowserWindow({
    title: 'LowRange',
    icon: IS_DEV && fs.existsSync(devIcon) ? devIcon : undefined,
    x: st.x, y: st.y, width: st.width, height: st.height,
    minWidth: 800, minHeight: 500,
    backgroundColor: '#0d0c0b',
    show: false,
    autoHideMenuBar: true,
    fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: IS_DEV,
      backgroundThrottling: false,
      additionalArguments: [`--lowrange-version=${app.getVersion()}`],
    },
  });
  win.setMenuBarVisibility(false);
  if (st.maximized) win.maximize();
  if (st.fullscreen) win.setFullScreen(true);
  win.once('ready-to-show', () => win.show());

  const wc = win.webContents;
  // keep the document title from replacing the window title
  win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle('LowRange'); });

  // navigation: the game is one page; anything else goes to the system browser (allow-list) or nowhere
  wc.on('will-navigate', (e, url) => { if (!isAppUrl(url)) { e.preventDefault(); openExternalIfAllowed(url); } });
  wc.on('will-redirect', (e, url) => { if (!isAppUrl(url)) e.preventDefault(); });
  wc.setWindowOpenHandler(({ url }) => { openExternalIfAllowed(url); return { action: 'deny' }; });
  wc.on('will-attach-webview', (e) => e.preventDefault());

  // no page zoom (keyboard, ctrl+wheel or pinch)
  wc.on('did-finish-load', () => { wc.setZoomFactor(1); wc.setVisualZoomLevelLimits(1, 1); });
  wc.on('zoom-changed', () => wc.setZoomFactor(1));

  // Keys handled by the shell. Esc is NOT one of them: it belongs to the game (garage menu), and native
  // BrowserWindow fullscreen (unlike the HTML Fullscreen API) is not exited by Esc, so it can't kick you out.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key;
    const ctrl = input.control || input.meta;
    if (key === 'F11' || (input.alt && (key === 'Enter' || input.code === 'Enter' || input.code === 'NumpadEnter'))) {
      e.preventDefault(); if (!input.isAutoRepeat) toggleFullscreen(win); return;
    }
    if (ctrl && ['+', '=', '-', '_', '0', 'Add', 'Subtract'].includes(key)) { e.preventDefault(); return; }
    if (!IS_DEV) {
      // no reload / devtools / print / find in shipped builds
      if (key === 'F5' || key === 'F12' || (ctrl && ['r', 'R', 'p', 'P', 'f', 'F', 'g', 'G'].includes(key)) ||
          (ctrl && input.shift && ['i', 'I', 'j', 'J', 'c', 'C'].includes(key))) e.preventDefault();
    }
  });

  // persist size/position/fullscreen
  let saveTimer = null;
  const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveWindowState(win), 500); };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, queueSave);
  const notifyFs = () => { if (!wc.isDestroyed()) wc.send('lowrange:fullscreen-changed', win.isFullScreen()); };
  win.on('enter-full-screen', notifyFs);
  win.on('leave-full-screen', notifyFs);
  win.on('close', () => { clearTimeout(saveTimer); saveWindowState(win); });

  win.loadURL(`${ORIGIN}/index.html`);
  return win;
}

app.on('web-contents-created', (_e, contents) => {
  // belt and braces for any future webContents
  contents.setWindowOpenHandler(({ url }) => { openExternalIfAllowed(url); return { action: 'deny' }; });
});

app.on('window-all-closed', () => app.quit());
