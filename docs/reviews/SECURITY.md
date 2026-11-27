# LowRange security review

Date: 2026-11-26. Code: `integration` at `570a89c`, plus the fixes on branch `security-review`.
Threat model: a single-player game with no backend and no accounts. The things worth protecting
are the player's machine (desktop build: files, programs, network), the integrity of the shipped
build, and the owner's personal data in a public repository. Local saves count as
attacker-controlled input, but tampering with them only hurts the player who did it.

**Summary: 0 Critical, 0 High, 1 Medium, 8 Low, 12 Info.** The Electron shell was already well
locked down. I could not get out of `dist/`, reach the network, use Node, or get any
non-allow-listed URL opened, either in unit tests or live in Electron. The real issues are
hygiene ones: a Windows user path inside shipped PNGs, real vehicle model names in game text,
missing licence notices, and repository settings that only the owner can change.

| # | Sev | Finding | Status |
|---|---|---|---|
| M1 | Medium | Real make/model names in user-facing text and asset ids | needs code owner + owner |
| L1 | Low | Packaged build accepted `--remote-debugging-port` (full CDP control) | **fixed** |
| L2 | Low | Windows user name and local path inside shipped PNG metadata | check added; strip needs code owner |
| L3 | Low | Prototype key in saved settings (`quality: "constructor"`) breaks rendering | patch suggested |
| L4 | Low | Absolute local paths with user name in committed docs and tests | test fixed; docs suggested |
| L5 | Low | No third-party licence notices in builds; no LICENSE file | desktop **fixed**; web + LICENSE need owner |
| L6 | Low | Dependabot alerts off, no branch protection, no CI | config **added**; settings need owner |
| L7 | Low | Unsigned Windows binaries (SmartScreen) | owner decision |
| L8 | Low | `npm audit` (dev): 6 moderate, minimatch via electron-builder | accepted (build-time only) |
| I1-I12 | Info | Verified controls, see below | n/a |

---

## Medium

### M1. Real vehicle make/model names in game text and asset ids
Evidence:
- `src/specs.js:9`: blurb "…pickup in the **Tacoma** mould…"
- `src/specs.js:31`: "Boxy **70-series** style wagon", shown as name `Cruiser 76` (`src/specs.js:30`), which reads as "Land Cruiser 76"
- `src/specs.js:51`: "…turbo AWD sedan, **WRX** style…"
- Vehicle ids and files `taco`, `lc70`, `wrx` (`src/specs.js:29,32,49,52`, `public/models/vehicles/*.glb`,
  `public/loading/{lc70,taco,wrx}.png`), and `docs/MODELING_SPEC.md:10,86-88`.

Impact: not a security issue. Tacoma, Land Cruiser and WRX are registered trademarks, and the
blurbs appear on the vehicle select cards in a public, distributed game. That invites a takedown
or a request to rename, which hurts more after release than before. The models themselves appear
unbranded (MODELING_SPEC forbids badges; I found no logo text in the glTF JSON), but I did not
review textures by eye.

Fix (code owners, `src/specs.js`):
```diff
-    blurb: 'Mid-size double-cab pickup in the Tacoma mould. Independent front, solid rear with an e-locker, 6-speed manual.',
+    blurb: 'Mid-size double-cab pickup. Independent front, solid rear with an e-locker, 6-speed manual.',
-    name: 'Cruiser 76',
-    blurb: 'Boxy 70-series style wagon. Solid axles both ends, …
+    name: 'Outback Wagon',
+    blurb: 'Boxy old-school wagon. Solid axles both ends, …
-    blurb: 'Gravel-spec turbo AWD sedan, WRX style. Independent all round, …
+    blurb: 'Gravel-spec turbo AWD sedan. Independent all round, …
```
Renaming the internal ids (`taco`/`lc70`/`wrx`) is optional because players don't see them, but
they do appear in file names inside the shipped build and in URLs (`?shot=`). If the owner wants
the build fully clean, rename them in a single pass (specs, models, loading art, tests, docs).

---

## Low

### L1. Packaged build could be driven over the DevTools protocol (fixed)
Evidence: `test/desktop-smoke.mjs:20` launches the shipped `LowRange.exe --remote-debugging-port=N`
and attaches Playwright over CDP. That works because the `enableNodeCliInspectArguments` fuse only
covers Node's `--inspect`, not Chromium's remote-debugging switches. Before the fix, any process
that launched the exe with that switch (a modified shortcut, a launcher, another program) got a
CDP endpoint on 127.0.0.1. Any local process, including other Windows users' processes, could
use it to run script in the page and read its localStorage. It could **not** get Node, because
the renderer stays sandboxed with no Node.

Fix: `electron/main.cjs:44-51` removes `remote-debugging-port`, `remote-debugging-pipe`,
`remote-debugging-address` and `remote-allow-origins` in packaged builds before `ready`. The packaged
smoke test opts back in with `LOWRANGE_ALLOW_CDP=1` (`test/desktop-smoke.mjs`). The opt-in only
stops accidental or argument-only exposure. A process that can set environment variables as you
can already do anything as you.
Verified on a freshly packaged `release/win-unpacked/LowRange.exe`:
```
default: no CDP endpoint
with LOWRANGE_ALLOW_CDP=1: CDP OPEN: Chrome/156.0.8078.109
```

### L2. Local path with the Windows user name inside shipped PNGs
Evidence (`node scripts/png-metadata.mjs`):
```
public/loading/lc70.png: File=<home>\...\art\blender\loading_screen.blend | Date=… | Scene=Loading_lc70 …
public/loading/taco.png: (same)
public/loading/wrx.png:  (same)
```
Blender writes the `.blend` path into a PNG `tEXt` chunk. These files are copied into `dist/` and the
desktop ASAR, so every build ships the owner's first name and directory layout, and so does git
history from `ffa2dfd`. Impact is small (a first name and folder names, no credentials), but the
owner has scrubbed history for less before.
Fix:
- Added `scripts/png-metadata.mjs` (lists PNGs with text chunks, exit 1; `--strip` removes them
  without touching pixels) and wired it into CI. **Code owners** (loading screen) should run
  `node scripts/png-metadata.mjs --strip` and commit `public/loading/*.png`. Until they do, the CI
  step fails on purpose.
- In `tools/blender/render_loading.py`, before `render.render` (line ~66), add
  `sc.render.use_stamp_filename = False` (or set all of `sc.render.use_stamp_*` to False) so new
  renders come out clean.
- History: the path stays in old blobs. Rewriting history for this is optional and the owner's call.

### L3. A prototype key in saved settings breaks rendering until the player resets it
Evidence: `src/settings.js:29` `PRESETS[s.quality] ? s.quality : DEFAULTS.quality`, and the same
pattern at `:47` and `:60`. `PRESETS['constructor']` is `Object`, which is truthy, so a save of
`{"quality":"constructor"}` is accepted. `applyGraphics` then passes `undefined` to
`pipeline.setPixelHeight`. Live check in Electron: the pixel pipeline's `scale`, `w` and `h` all became
`NaN`. The game still boots, with no exception, but the render target is broken until the player
picks a preset in F10. There is no injection. Same-origin script or hand-edited saves only.
Suggested patch (code owners):
```diff
-      quality: PRESETS[s.quality] ? s.quality : DEFAULTS.quality,
+      quality: Object.hasOwn(PRESETS, s.quality) ? s.quality : DEFAULTS.quality,
…
-  if (key === 'quality' && !PRESETS[value]) return;
+  if (key === 'quality' && !Object.hasOwn(PRESETS, value)) return;
```
Everything else read from storage is already validated. Garage builds are matched with `===`
against an allow-list (`src/garage.js:100-105`). Best laps are `Number.isFinite` (`src/race.js:17-18`).
Volume is clamped. `window-state.json` (desktop) is `isFinite`-checked, and a live test with
`1e300` sizes gave a normal 800x600 window.

### L4. Absolute local paths in committed files
- `test/audio.mjs:7` hard-coded `<home>/AppData/Local/ms-playwright/chromium-1234/…`. **Fixed**:
  it now uses Playwright's default browser, or `CHROME=…`.
- `docs/ART_STYLE.md:3` and `docs/HANDOFF.md:19`: `<home>\Downloads\Version 1 Stardew valley offroad art.png`.
  Suggested: refer to it as "the reference concept image (not in the repo)". This one matters a
  little: it is the only place the user name appears in Markdown on the repo's front page.
- `tools/blender/*.py:2-3` mention `C:\Program Files\Blender Foundation\Blender 5.3\blender.exe`.
  That is a generic install path with no user data. Fine.

### L5. Licence notices
- The production bundle strips licence comments (no `@license` / MIT text in `dist/assets/*.js`),
  but it contains three.js (MIT, which requires the notice in copies) and Rapier (Apache-2.0).
  **Fixed for desktop:** `package.json` `build.extraResources` now ships
  `resources/licenses/three.LICENSE.txt` and `rapier3d-compat.LICENSE.txt` (verified in
  `release/win-unpacked`). electron-builder already ships `LICENSE.electron.txt` and
  `LICENSES.chromium.html`.
- Web build: still has no notices. Suggest adding a `public/licenses/` copy, or an About link
  (code owners).
- The repo has no `LICENSE` file (GitHub reports `license: null`), while `package.json` says `ISC`.
  **Owner decision:** add the licence you intend, or set `"license": "UNLICENSED"` to reserve all rights.
- Fonts: system fonts only (`index.html:12`) and a code-drawn pixel font (`src/ui/pixelfont.js`).
  Nothing is bundled, so nothing to attribute.
- `docs/MODELING_SPEC.md:9` names another game ("Stardew valley") as a style reference. That is fine
  as an internal note. Keep it out of store and marketing text.

### L6. Repository settings and CI (read-only `gh` queries)
```
secret_scanning: enabled, push_protection: enabled       (good)
dependabot_security_updates: disabled, vulnerability-alerts: 404 (off)
branches/main/protection: "Branch not protected"
no .github/ directory, no releases
```
Added: `.github/workflows/ci.yml`. It runs `npm ci`, `npm audit --omit=dev`, `npm audit signatures`,
the PNG-metadata check, `test/electron-policy.mjs`, the headless Node tests (brake, garage, damage,
race) and `vite build`. Permissions are `contents: read` and `persist-credentials: false`, and
actions are pinned to full SHAs (checkout v7.0.1, setup-node v7.1.0). Also added
`.github/dependabot.yml` (npm weekly with grouped dev minor/patch updates, actions monthly) and
`SECURITY.md` (private reporting).
**Owner:** turn on Dependabot alerts and security updates and private vulnerability reporting
(the root `SECURITY.md` points to it). Optionally protect `main` by requiring the CI check and
blocking force-pushes. Note that blocking force-pushes conflicts with the history scrubs done before.

### L7. Unsigned Windows binaries
`electron-builder` logs `no code signing certificate configured, signing is skipped`. Effect:
SmartScreen shows "Windows protected your PC / Unknown publisher" for both the NSIS installer and the
portable exe until each file builds enough reputation, and some antivirus tools score unsigned
Electron apps higher. Players also can't verify that a download came from you. Options (owner):
Azure Trusted Signing (cheapest current route; needs identity validation, then `win.azureSignOptions`
in the build config), or an OV/EV certificate on a hardware token (`win.signtoolOptions`). Until
then, publish SHA-256 hashes next to each release asset. The ASAR integrity fuse protects only
against tampering *after* install, not against a swapped download.

### L8. Dev-dependency audit
`npm audit --omit=dev`: **0 vulnerabilities.** Full `npm audit`: 6 moderate, all
`minimatch` (GHSA-g3hv-75wg-m249, ReDoS) pulled in through `electron-builder` → `app-builder-lib`
/ `@electron/universal`. It is only reachable at build time with our own glob patterns.
`npm audit fix --force` would downgrade electron-builder to 25.x, so leave it. Dependabot will pick
up the upstream fix.

---

## Info (verified, no action needed)

**I1. `app://` protocol handler: no path traversal.** Tested 60 unit cases (`test/electron-policy.mjs`,
raw undecoded pathnames, win32 and posix) and 19 live `fetch()` calls from the page in Electron.
Results: `..`, `%2e%2e`, `%2f`, `%5c`, mixed `..%5C..%5C`, `/C:%5CWindows%5Cwin.ini`, `//C:/…`, UNC
`%5C%5Chost%5Cc$…`, `\\?\` and case tricks (`..%2fDIST%2f`) either returned 403 or resolved
*inside* `dist/` (404). `app://other/…` is blocked by `webRequest`. Hardening applied
(`electron/policy.cjs`): a malformed escape (`/%`) used to throw `URIError` out of the handler and
now returns 403, and a NUL byte (`index.html%00.js`) now returns 403. Not exploitable before
either. Symlinks can't occur inside the ASAR. In dev, `dist/` is a plain folder written by `vite build`.
Dev-only quirks that stay inside `dist/`: `INDEX.HTML` and `index.html::$DATA` serve index.html,
and `con`/`nul` return 404.

**I2. `shell.openExternal` allow-list.** `https:` only, exact host `github.com` / `threejs.org` /
`rapier.rs` (optionally with a `www.` prefix). Tested: `github.com.evil.tld`, `github.com@evil.tld`,
`evilgithub.com`, `gist.github.com`, `github.com.`, `www.www.github.com`, punycode look-alikes,
`http:`, `file:`, `javascript:`, `ms-settings:`, `search-ms:`, IPs and UNC paths are all rejected.
Tightened: URLs with userinfo (`https://user:pass@github.com`) or a non-default port are now rejected
too. Live: five `window.open` attempts led to exactly one `openExternal('https://github.com/RMamujee/LowRange')`.
Paths on github.com are not restricted. That is acceptable because only first-party page code can
trigger it.

**I3. BrowserWindow / session.** `contextIsolation`, `sandbox`, `nodeIntegration(InWorker): false`,
`webSecurity`, `webviewTag: false`, `devTools` only when unpackaged, and `app.enableSandbox()`
(`electron/main.cjs:54,186-200`). Live checks: `typeof require/process === 'undefined'`; the only
global is the frozen `window.lowrange` with 7 members; `fetch('https://example.com')` was blocked;
`getUserMedia` returned `NotAllowedError`. Navigation: `will-navigate` and `will-redirect` are
restricted to `app://lowrange`, `setWindowOpenHandler` denies (main window and every future
webContents), and `will-attach-webview` is prevented. The permission request and check handlers
allow only `fullscreen` and `pointerLock` from the app origin. HID, serial and USB fall through to
Electron's default deny.

**I4. IPC.** Three channels (`toggle-fullscreen`, `is-fullscreen`, `quit`). All take no arguments,
all check `senderFrame.url` is `app://lowrange`, and the preload exposes no `ipcRenderer`
(`electron/preload.cjs`).

**I5. Process level.** The `second-instance` handler ignores argv and only focuses the window. No
`setAsDefaultProtocolClient` and no file associations, so there is no deep-link surface. No
`autoUpdater` or `electron-updater`, and every build script uses `--publish never`, so no update
channel exists that could be hijacked. NSIS: `perMachine: false`, `allowElevation: false`, per-user
install. Fuses read from the packaged exe: RunAsNode off, NODE_OPTIONS off, inspect args off, cookie
encryption on, embedded ASAR integrity on, only-load-from-ASAR on, file-protocol extra privileges off.
Electron 45.5.0 is the current `latest`.

**I6. CSP** (`electron/main.cjs:20-34`): `script-src 'self' 'wasm-unsafe-eval'`, no `unsafe-eval`,
`default-src 'none'`, `object-src 'none'`, `base-uri 'none'`. `wasm-unsafe-eval` is needed by Rapier,
which instantiates its inlined WASM. No `eval`, `new Function` or string `setTimeout` in `src/`.
`style-src 'unsafe-inline'` **is** needed: the `<style>` block in `index.html:8`, the injected
`<style>` in `src/settings.js:126`, and `style="…"` attributes in the templates
(`src/garage_ui.js:125,146`). With scripts locked down, the remaining risk is CSS-only injection,
and nothing untrusted reaches HTML anyway (I7). The **web** build ships no CSP. If it gets hosted,
send the same policy as a response header, adding `'self'` for the host's origin.

**I7. DOM sinks.** 12 `innerHTML` writes (`src/main.js:266,293,318,336,353,468,469,587,619`,
`src/garage_ui.js:118,139`, `src/settings.js:130`). Every interpolated value is a code constant
(vehicle and trail names, option labels) or a formatted number. No `insertAdjacentHTML`,
`document.write` or `outerHTML`. Dynamic `import()` only uses fixed specifiers (`src/terrain.js:16`
maps `?map=` to one of two literal paths). URL params: `?car=` is `parseInt`+`clamp`
(`src/main.js:742`), `?o=` is only compared to `'1'`, `?go=` only starts a drive, `?shot=` is
checked against known ids (`src/ui/loading.js:102-103`), and `?loader` is a regex test. Gamepad
ids are never rendered. Prototype pollution: saves are `JSON.parse`d and never merged
(`applyBuild` uses `structuredClone(base)` plus allow-listed values). Live test with
`{"__proto__":{"polluted":1}}` in the builds key: `({}).polluted === undefined`.

**I8. Vite.** `virtual:lowrange-models` (`vite.config.js:7-24`) lists `public/models/**/*.glb` at
build time. `Dirent.isDirectory()` does not follow symlinks, paths are made relative to the models
folder, and the list is emitted as JSON. glTF `extras` are read only as numbers and texture names.
The dev server uses Vite's defaults: binds `localhost` only, `server.fs.strict: true`.

**I9. Supply chain.** Lockfile v3, 298 packages, all resolved from `registry.npmjs.org` with
`integrity`. `npm audit signatures`: 298 verified signatures, 55 attestations. Install scripts:
only `electron-winstaller` (`select-7z-arch.js`, dev, via electron-builder) and `fsevents` (macOS,
optional). Electron 45 fetches its binary lazily on first use, from GitHub releases with checksum
verification. Runtime dependencies are just `three` and `@dimforge/rapier3d-compat` (WASM inlined
as base64, ~15 MB package). Neither phones home. The page can't reach the network in desktop builds
anyway (I3). Versions use caret ranges, and the lockfile plus `npm ci` pins them.

**I10. History.** gitleaks (`git --log-opts=--all` plus a working-tree scan): **no leaks**. All 44
commits have author and committer `133895954+RMamujee@users.noreply.github.com`. The largest blobs
are `art/blender/loading_screen.blend` and `.blend1` (1.1 MB each). I decompressed both (zstd) and
found no user name or absolute paths. The `.blend1` is a Blender autosave backup and should not be
tracked: I added `*.blend1` to `.gitignore`, and code owners should
`git rm --cached art/blender/loading_screen.blend1`. `.gitignore` now also covers
`.env*`, `*.pem`, `*.pfx`, `*.p12`, so a future signing certificate can't be committed by accident.

**I11. Build contents.** `vite build` emits no source maps, and two consecutive builds produced
identical `dist/` hashes. The ASAR holds only `dist/**`, `electron/{main,preload,policy}.cjs` and
`package.json`: no tests, no `node_modules`, no `.env`. `build.files` now also excludes `**/*.map`
and `**/.env*` as a guard. Unpacked app is 317 MB, ASAR 7.4 MB.

**I12. For code owners (not security):** `node test/desktop-smoke.mjs --packaged` times out at
`#lrSettings [data-v=low]` (the overlay does not open on F10 over CDP). It reproduces identically
with the pre-review `electron/main.cjs`, so this branch did not cause it. The dev-mode smoke test
passes.
