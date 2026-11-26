# LowRange QA pass: bugs found by playing the game

Branch `qa-bughunt`, based on `integration` @ 5054c12. Every entry below was reproduced, either with
the headless Node tests (`test/*.mjs`) or with scripted headless-Chromium sessions against `npx vite`
(Playwright, key/wheel events dispatched on `window`, state read through `window.__game`).
Ordered by severity. Fixed entries name their commit; the rest are in files owned by other agents
and include a suggested patch.

Regression tests added: `test/storage.mjs` (node, about 1 s) and `test/browser-qa.mjs` (needs a dev
server; it prints `FAIL` for a fixed bug that came back and `OPEN` for the main.js bugs below).

---

## 1. HIGH: corrupted or legacy garage save data stops the game from booting. FIXED in 727660d

**What happens:** if `lowrange.builds.v1` holds `null` for any rig, the loading screen never
finishes. The console shows `Cannot read properties of null (reading 'tyreSize') at garage.js:103`.
Other junk was also mishandled: a store that parses to a number or a string made `saveBuild` throw
(`Cannot create property 'taco' on number '5'`), and an array store silently dropped every build.

**Repro:** `localStorage.setItem('lowrange.builds.v1', '{"lc70":null}')`, then reload.
Automated: `node test/storage.mjs` (10 failures before the fix, 0 after) and check 1 in
`test/browser-qa.mjs`.

**Root cause:** `src/garage.js:100` `sanitizeBuild(base, build = {})`. The default only applies
to `undefined`, so `null` reaches `build[it.key]`. `main.js:148/590` calls it for every card at boot.
`readAll()` (`garage.js:207`) returned whatever JSON parsed to.

**Fix:** `sanitizeBuild` returns the default build for any non-object. `readAll` returns `{}` unless
the store parses to a plain object.

## 2. HIGH: Rally Sedan (`wrx`) tears a wheel off at race pace. Patch proposed (vehicle.js)

**What happens:** `node test/race.mjs` gives `wrx no lap | resets 7 | susp 0.62/0.88/0.00/0.26
eng 0.20 body 0.20 broken 1`. lc70 and taco lap cleanly.

**Repro / evidence** (`DMG=1 node test/race.mjs wrx`, plus a probe that wraps `damageWheel` and
`bodyImpact` to log track position `s`, lateral offset and speed):

| s (m) | event |
|---|---|
| 520-560 (whoops) | rear arms bend over and over: RL 1.00 -> 0.53, RR -> 0.58. Single substeps cost up to 0.22 susp (gi ≈ 81 g on one wheel) |
| 612 | truck is at **lat 11.6 m** (track half-width 6) and hits the outside tyre wall at 10 m/s: body impact 237 g |
| 745-760 | leaves the track again at 16 m/s, ends at **lat 23 m**, 347 g body hit, RL snaps |

Neither the splash (s 762) nor the hairpin tyre wall is the cause. The walls sit on the outside
of the bends, 9.2 m off the centreline (checked with a geometry probe), and only get hit by a car
that has already left the road. The racetrack geometry is fine, so `src/maps/racetrack.js` is not changed.

Experiments that isolate the cause:
- Damage disabled (`damageWheel`/`bodyImpact` as no-ops): wrx laps in **1:25.4** at full pace, no resets.
- Front suspension pre-bent to [0.55, 0.6]: still laps.
- **Rear** suspension pre-bent to [0.55, 0.6] at 80% pace: flips at s 377, 2 wheels torn off, 30 resets.

**Root cause 1 (main): `src/vehicle.js:264-265`.** When `health.susp < 0.75`, the bent-arm toe
offset `(1 - h) * 0.16 * (i % 2 ? -1 : 1)` is applied to **all four** steer joints with the
front-wheel sign. On the rear wheels that means toe-out (about 4° per side at h = 0.55): passive
rear steer that makes the car snap-oversteer, so it runs wide into the walls and off the track.
The wrx has independent rear suspension, so its rear knuckles really do steer.

**Root cause 2 (secondary): `src/vehicle.js:408-416`.** Wheel damage is checked every 5 ms
substep against the *peak* contact force. A rigid bump stop turns an ordinary bottom-out into a
one-substep spike of 60-80 g, and several such substeps add up per landing. The wrx has the
shortest bump travel (0.11 m), so the 0.2 m whoops at 17 m/s (about 2.1 Hz, near its 1.7 Hz
body frequency) bottom it out on nearly every whoop. Light weight is *not* the cause:
`Wst = mass * G / 4` already normalises for mass.

**Suggested patch** (tested here, not committed: file is owned elsewhere):
```diff
@@ vehicle.js:264 @@
-      this.steerJoints[i].configureMotorPosition(targets[i] + (this.health.susp[i] < 0.75 ? bend : 0), ks, cs);
+      // a bent rear arm should not turn the rear into a passive rear-steer: front toe-out, mild rear toe-in
+      this.steerJoints[i].configureMotorPosition(targets[i] + (this.health.susp[i] < 0.75 ? (i < 2 ? bend : -bend * 0.5) : 0), ks, cs);
@@ vehicle.js:414 @@
-      const gi = F / Wst;
+      // low-pass over ~20 ms: a one-substep bump-stop spike is not an 80 g hit
+      const wf = this.wheelF || (this.wheelF = [0, 0, 0, 0]);
+      wf[i] += (F - wf[i]) * Math.min(1, h / 0.02);
+      const gi = wf[i] / Wst;
```
(Also reset `this.wheelF` in `build()`.) Results:
- Toe fix alone: `wrx lap1 1:26.4`, 0 resets, 0 broken. The rear still wears to 0.15/0.11 in one lap.
- Both changes: `wrx lap1 1:25.4 lap2 1:26.1`, susp 1.00/1.00/0.90/0.99. lc70/taco unchanged
  (2 laps, about 1:29.9 / 1:29.3).
- Side effect of the low-pass, for the owner to tune: `test/damage.mjs` 5 m drops do about half the
  suspension damage (lc70 0.63/0.55/0.50/0.40 -> 0.84/0.85/0.78/0.78). The goat's 30 km/h wall hit
  no longer tears both front wheels off (0.00/0.00 -> 0.03/0.28). Lowering the 18 g threshold to
  about 14 would restore the old drop damage.

## 3. MEDIUM: finishing a trail at once starts a new, reversed run at the finish gate (main.js)

**What happens:** you drive out through the far gate and get `Pinyon Two-Track complete in 0:09`.
About 10 ms later the toast is replaced with `Pinyon Two-Track · Easy. Good luck!`. A new run is
now active from the gate you just finished at, and its timer never stops. The HUD arrow says
`Finish: Pinyon Two-Track · 113 m`, pointing back down the trail you just completed. The trail
list shows the ticking timer instead of the ✓.

**Repro:** `test/browser-qa.mjs` check 5. By hand: drive any trail end to end and watch the toast
and the `nextFlag` text after the finish gate.

**Root cause:** `src/main.js:120-140` `updateTrails`. After a finish it sets `game.active = null`.
The next frame the truck is still within `t.width / 2 + 2.5` of the same gate, so the
`!a || a.trail !== i` branch starts a run there.

**Suggested patch:**
```js
// main.js updateTrails, inside trailEnds[i].forEach((e, end) => { ... })
const gate = i * 2 + end;
if (!near) { if (game.lastGate === gate) game.lastGate = null; return; }
if (game.lastGate === gate) return;          // still rolling out of the gate we just finished at
...
        game.active = null; game.lastGate = gate; // in the "finished" branch
```

## 4. MEDIUM: the upside-down hint tells the player to press R, which switches range (main.js)

**What happens:** on its roof the HUD says `On your lid! Press R to recover`. Pressing R gives
`HIGH range` (or `Transfer case: ...`) and the truck stays upside down. Recover is Backspace
(KEYMAP and the controls list both say so).

**Repro:** flip any rig and wait for the toast, or run `test/browser-qa.mjs` check 4.

**Root cause / patch:** `src/main.js:694`: `toast('On your lid! Press Backspace to recover', 1.5)`.

## 5. LOW-MEDIUM: garage close then open before the next frame doubles its render/physics loop. FIXED in 727660d

**What happens:** `Garage.open()` starts a rAF loop when `!wasOpen`. The old loop only exits at its
next frame, so close() + open() inside one frame leaves two loops running. Each cycle adds one
more: garage frames per display frame went 1 -> 2 -> 4. The turntable spins faster, physics steps
double, and the preview renders 2-4x per frame.

**Repro:** `g = __game.garage; g.open(0); g.close(); g.open(0)`, then count `g.frame` calls per
rAF. `test/browser-qa.mjs` check 2 (fails with 3.00 before the fix).

**Root cause / fix:** `src/garage_ui.js:77-82, 152`. The loop is now tracked with `this.looping`,
which only clears when the loop actually exits.

## 6. LOW: garage preview stretches after a window resize. FIXED in 727660d

**What happens:** the preview buffer and camera aspect are only set in `open()`. After resizing the
window with the garage open, the canvas box was 551x461 while the buffer stayed 546x532
(aspect 1.026 vs 1.195), so the truck is squashed.

**Repro:** open the garage, resize the window. `test/browser-qa.mjs` check 3.

**Fix:** `src/garage_ui.js`: a window `resize` listener calls `this.resize()` while the garage is open.

## 7. LOW: corrupted best lap becomes an unbeatable record. FIXED in 727660d

**What happens:** `lowrange.bestlap.race.<rig>` = `-5` (or `0`) is accepted. The HUD shows
`Best · Trail Pickup -1:-5.0` and no lap can ever beat it.

**Root cause / fix:** `src/race.js:22` accepted any finite `parseFloat`. It now requires `> 0`.
Covered by `test/storage.mjs`.

## 8. LOW: Y (restart trail) goes to a trail you abandoned, not the one you are on (main.js)

**What happens:** `game.active` is only cleared by finishing. Start trail 0, leave it mid-run (drive
cross-country, no gate), get onto trail 1 partway along, press Y: you get `Back to the start of
Pinyon Two-Track` (trail 0), a long way away. The abandoned run's timer also keeps running and the
HUD keeps pointing at its finish.

**Repro:** in the browser session, start trail 0, teleport the car to `pathPoint(TRAILS[1], 30)`,
then press Y. The result was `{"trail":0,"from":0}` at trail 0's start.

**Root cause:** `src/main.js:180-186` `trailUnderTruck` returns `game.active` before checking the
corridor under the truck.

**Suggested patch:** do the `GRID.path` lookup first. Return `game.active` only if there is no
corridor under the truck or it belongs to the same trail; otherwise return the corridor's trail
(and drop the stale run).

## 9. LOW (tests): four headless tests crashed or gave misleading results. FIXED in 5bc3cfb

- `test/obstacle.mjs`, `test/stretch.mjs`, `test/trails.mjs` crashed with
  `Cannot read properties of undefined (reading 'tire')`. Their default rig `ranger` no longer
  exists in `specs.js`; replaced with `taco` (or `lc70`, since `stretch.mjs` needs a solid front axle).
- `test/trails.mjs` reported **every** rig `STUCK` on every trail. That was only its 120 s default:
  runs take 120-220 s. At 300 s, goat, taco and mule finish all five trails (mule does not get past
  s = 84 on Widowmaker Falls with this simple autopilot).
- `test/perf.mjs` / `test/loading.mjs` need `CHROME=<path to chrome.exe>` and a server port.
  `loading.mjs` takes the port as its *second* argument (`node test/loading.mjs <outDir> <port>`).
  Not a bug, but easy to misread as broken.

---

## Exercised with no bug found

- **Every key binding and HUD lamp/button** (R, Q, E, F, G, T, I, C, V, M, H, Backspace, Y, wheel,
  PageUp/Down, Space, Shift, B, Z/X; l4wd, lF, lR, lAir, lRS, lEng, range, lAC, bUp, bDn, bCam).
  Each gives the right state change or refusal message per rig (no front locker on taco, 4WD
  required in low, rally car has no low range, rear steer only on the goat).
- **Gears:** reverse via N, `GRIND!` without the clutch when auto-clutch is off, stall on a clutch
  dump, `I` refused in gear without the clutch, restart with the clutch held. Dead engine: `I`
  refused, throttle does nothing, Backspace or menu re-drive repairs it.
- **Damage to failure:** a 40 m drop snaps all four wheels; 40 front hits kill the engine.
  Backspace, Y and menu re-drive all give a fully repaired truck.
- **Race:** countdown holds the truck (throttle ignored), GO, wrong way (`WRONG WAY` and
  `nextFlag`), missed checkpoint toast, checkpoint order, lap counting, best lap stored and
  reloaded per rig, garbage value ignored, Y restarts the countdown, rig switch on the race map.
- **Trails:** start from either end, Y from the far end puts you at the far end facing in,
  Backspace keeps the run going.
- **Settings (F10):** Low/Medium/High (fog, far plane and shadow map change), volume 0, FPS
  counter, keys and wheel blocked while it is open, Esc closes it without opening the menu,
  corrupted settings JSON falls back to defaults, persists across reload.
- **Garage:** every chip on every rig at min and max, reset, persistence across reload, maxed taco
  drives. Corrupted builds now load (see 1).
- **Leaks over 10 vehicle switches, 10 Backspace respawns and 2 full garage passes:** main scene
  objects 767 -> 767, geometries 176 -> 176, Rapier bodies/colliders/joints 826/827/12 unchanged,
  textures 49 -> 56 after the first round (per-rig cache), then flat. Garage preview geometries
  grow on the first pass per rig (82 -> 229) and stay flat on the second.
- **Focus loss:** `blur` with W+A held zeroes throttle and steer. No gamepad: no errors.
- **Resize** to 1x1, 200x100, 3840x2160 and 500x2000: projection stays finite, no errors.
- **Low frame rate:** CPU throttled 6x (8 fps) and 20x (1.4 fps). No NaN. The sim and the race
  clock slow together (dt is capped at 50 ms, so `MAX_STEPS = 12` is never reached), which keeps
  lap times consistent with physics time.
- **Extreme physics inputs (node, all 5 rigs):** over-range and NaN inputs, 120 m/s into the
  ground, 120 rad/s spin, all four wheels torn off with lockers on, 3 wheels off in reverse,
  clutch dump at 9000 rpm in low. No NaN anywhere.
- **Loading screen gate** (`test/loading.mjs`, 1280 and 1600 wide) and **desktop smoke**
  (`npm run build` + `node test/desktop-smoke.mjs`): pass, no console errors.
- No console errors or warnings in any browser session.
