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

## 2. HIGH: Rally Sedan (`wrx`) tears a wheel off at race pace. FIXED upstream (vehicle.js)

**Status (re-checked 2026-11-26):** both parts of the patch below are in `src/vehicle.js`: the
bent-arm toe offset only goes to the front steer joints (`i < 2 ? ... : 0`), and wheel damage reads
the low-passed contact force `this.wheelF`.

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

## 3. MEDIUM: finishing a trail at once starts a new, reversed run at the finish gate. FIXED upstream (main.js)

**Status (re-checked 2026-11-26):** `updateTrails` has the suggested `game.finishGate` guard;
`test/browser-qa.mjs` check 5 passes.

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

## 4. MEDIUM: the upside-down hint tells the player to press R, which switches range. FIXED upstream (main.js)

**Status (re-checked 2026-11-26):** the toast says `Press Backspace to recover`. The toast is a
canvas now, so check 4 reads `hud.debug().lastToast` instead of the old `#toast` element (it threw).
It also passed without testing anything (the start-up parking-brake toast was read instead): it now
requires the truck to be on its roof and the hint to show, and prints `NOT RUN` otherwise.

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

## 8. LOW: Y (restart trail) goes to a trail you abandoned, not the one you are on. FIXED 2026-11-26 (main.js)

**Status:** reproduced in headless Chrome before the fix (playtest Medium #4): start trail 0, teleport
to `pathPoint(TRAILS[1], 30)`, press Y gave `{"trail":0,"from":0}` and put the truck 130 m from trail
1's start. **Fix:** `trailUnderTruck` (`src/main.js`, about line 300) looks up the corridor first and
returns the active run only when the truck is on that run's trail or off every trail corridor (still
mid-run, just off the line); on another trail's corridor it returns that trail, and `restartTrail`
replaces the stale run. Checked that no trail's centreline sits on another trail's corridor cell
(only road cells near some trail mouths). Covered by `test/browser-qa.mjs` check 6 (abandoned run,
and a far-end run on its own trail still restarts at the far end); both parts fail on the old code.

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

## Playtest 2026-11-26 (the remaining Low items)

Numbering below continues this file. The playtest's High #1/#2, Medium #3 and the corrupted
Gauntlet best were handled separately (vehicle.js / crawl_course.js).

## 10. LOW: stored waypoints aren't range-checked; the Gauntlet map's key hints overlap CLEAR ALL. FIXED 2026-11-26 (hud/mapview.js)

**What happens:** `lowrange.waypoints.<map>` = `[{"x":1e9,"z":0}]` is accepted: the HUD shows
`1414213738 M` and the 3D pillar is placed far off the map. A `null` entry made the whole list
throw and load empty. On the Gauntlet's big map, `CLEAR ALL` and the `CLICK / SET WAYPOINT` hint
are drawn over each other.

**Repro:** `node test/waypoints.mjs` (3 failures on the old code). The overlap is not only corrupted
data: the Gauntlet sidebar lists 12 stages, so 2-3 ordinary waypoints already push `CLEAR ALL` into
the hint block (playtest shot `r1_crawl_corrupt_bigmap.png`).

**Root cause:** `Waypoints` constructor (`mapview.js:84`) only checked `Number.isFinite`, so any finite
number passed and `p.x` on `null` threw. The sidebar's hints are pinned to the bottom of the panel
whatever the content above them reaches.

**Fix:** the constructor keeps entries whose `x` / `z` are numbers within `±SIZE / 2` and copies only
`x` / `z`. The sidebar draws only the hints that fit under the content (the last ones, so
`M / ESC CLOSE` stays). Covered by `test/waypoints.mjs` (park, race and Gauntlet bounds) and `test/browser-qa.mjs` check 7.

## 11. LOW: HUD panels overlap or leave the screen in small / tall windows. FIXED upstream (2ea00dc, src/hud/layout.js)

**Status (re-checked 2026-11-27):** the layout rework scales from width and height, restacks the
chassis board and hides boards when there is no room. `node test/hudlayout.mjs` checks every size
in this report (640x360, 800x600, 320x240, 800x1600) plus a sweep at 1 / 1.25 / 1.5 / 2 dpr: all
318255 checks pass. The analysis below is kept for history.

**What happens:** at 640x360 and 800x600 the cluster and chassis boards overlap; at 800x1600 the
cluster is 1132 px wide; at 320x240 the chassis board starts at x = -90 and the minimap covers it.

**Root cause:** `src/hud/hud.js` `layout()`:
`scale = Math.max(2, Math.floor((innerHeight * dpr) / 400))` depends on height only, never drops
below 2 and never looks at the width. The bottom row needs `(283 + 200) * scale + 30` px
(cluster 283 + chassis 200 canvas px, 10 px margins + a gap) and the right column
`(146 + 60) * scale + 30` px of height (minimap + chassis). So scale 2 breaks below 996 px wide or
442 px high, scale 3 (heights 1200-1599) below 1479 px wide, scale 4 (800x1600) gives the 1132 px
cluster. Numbers check against the shots: 283 * 4 = 1132; 320 - 10 - 200 * 2 = -90.

**Proposed fix (for after the engine-gauges merge, using whatever widths the new boards have):**
```js
const fitW = Math.floor((innerWidth * dpr - 30) / (CLUSTER_W + CHASSIS_W));
const fitH = Math.floor((innerHeight * dpr - 30) / (MINI_H + CHASSIS_H));
scale = Math.max(1, Math.min(Math.floor((innerHeight * dpr) / 400), fitW, fitH));
```
and, when even scale 1 does not fit (under ~515 css px wide at dpr 1), stack the chassis board
above the cluster on the left (or hide it) instead of letting it run off the left edge. The toast
and big-message canvases use the same `scale`, so they shrink with it.

## 12. LOW: the camera has no world collision (Spotter inside a tree, Chase through signs). FIXED 2026-11-26 (new src/cam_clear.js)

**What happens:** after a crash the Spotter camera stood inside a tree canopy (screen all leaves);
the Chase camera cuts through trail sign boards (`c2_tree_spot_0.png`, `c1_tree_0.png`).

**Root cause:** `src/main.js` `updateCamera` only kept the Chase camera above the ground at its own
position, and the Spotter stand (9 m ahead, 3 m to the side) was never checked against anything.
The things the camera ends up in mostly have no collider: canopies (only a 3 m trunk cylinder) and
sign boards / banners (none), so a physics ray alone would not catch them.

**Fix:** `src/cam_clear.js` (`CamClear`), built once after the scene: tree canopies as cylinders
from the tree list (sizes from `src/art/props.js`), every object tagged `userData.camBlock` as its
own oriented box (signposts and banner boards are tagged in `src/art/signs.js`, so Trail Park,
Gauntlet and race signs are all covered), fixed colliders (rocks, trunks, barriers) by one Rapier ray
with dynamic bodies excluded, and the visual ground. Chase: after the usual camera lerp, the
camera's distance from the look-at point is clamped to a smoothed clear distance that drops at once
when the sight line is blocked (to just short of the blocker, never under 2.2 m) and grows back at
1.5 m/s, so a tree passing behind gives one pull-in and a slow release; blocker edges are refined
to a few cm so the 0.3 m march doesn't show as steps. Leaves nearer than 2.65 m along the sight
line (driving under or right past a tree, where the camera can't get in front of them) are
ignored and the camera keeps its distance; solid things (ground, rocks, trunks, sign boards) always
count. Spotter: the first of a few stands ahead of the truck that is clear and can see it.
`main.js` changes: the import, one constructor line, one line after the Chase lerp, one line
replacing the Spotter stand. Covered by `test/camclear.mjs` (node: canopy, sign, hill, spotter,
and a 60 fps drive past and under a tree checking the monotonic pull-in, the 1.5 m/s release and
the normal distance under the canopy) and `test/browser-qa.mjs` check 9 (both cameras inside the
tree on the old code).
**Limits:** right after driving out from under a tree the camera pulls in once (to 2.2 m in front of
the canopy) and then eases back; an obstacle closer than about 2.2 m plus its own radius behind the
truck can still clip the camera; Hood and Wheel cameras are mounted on the truck and unchanged.

## 13. LOW: the default Trail Park spawn faces Widowmaker Falls; far-end spawns face a FINISH banner; sign backs look blank. FIXED 2026-11-26 (maps/trailpark.js, world_view.js, art/signs.js)

**What happens:** the trailhead spawn (`SPAWN.yaw = -0.31 pi`, along the loop road) points at
Widowmaker Falls' far gate 30 m ahead, 21 degrees off the nose, so W starts a double-black run
backwards within seconds; you look at the plain backs of the boards. Every far-end spawn faces a
banner that says FINISH although driving through it starts a run. Signpost backs were a flat dark
brown panel that read as a blank sign.

**Root cause:** data. The spawn yaw followed the loop road; `gate()` in `world_view.js` put one face
(`START` at the start, `FINISH` at the far end) on both sides of the banner, while
`updateTrails` starts a run at whichever gate you enter.

**Fix:** `SPAWN.yaw = 2.4`: down the spur road towards the green Pinyon Two-Track, whose START banner
and signpost front are in view 27 m ahead (the only gate within 45 m / 40 degrees of the nose).
Gate banners now read START from outside the trail and FINISH from inside at both ends. Signpost
backs are horizontal planks with dark seams. Covered by `test/browser-qa.mjs` check 8 (banner faces
at all 10 gates, and what the default spawn faces); `test/spawns.mjs` still settles every rig at the
trailhead.

---

## Bug-fix pass 2026-11-27 (base c18ccfa)

Old entries re-checked on the current code: 1-10, 12 and 13 stay fixed (`node test/storage.mjs`,
`node test/waypoints.mjs`, `node test/camclear.mjs` and every `test/browser-qa.mjs` check pass);
11 is fixed by the HUD layout rework (see above). Check 5 of `browser-qa` reported OPEN once in this
pass: not the bug, but the check (it needs the run to be over 4 s old and waited a fixed 5 s, which
a software-GL frame rate did not reach); it now waits for the run's clock.

All five maps were loaded in headless Chromium and driven: W, Y, Backspace, every spawn point
followed by Y, the big map, the spawn list, the pause menu and Restart at trailhead. No page errors
or console errors on any map; renderer geometries / textures, scene objects and Rapier bodies stay
flat over three rounds of every spawn point + Backspace + Y on each map.

### 14. LOW: the Cruiser never settles at the Trail Park's Boulder Alley start. FIXED (src/spawns.js)

**Repro:** `MAP=park node test/spawns.mjs` failed: `lc70 @ Boulder Alley: start ... moved 0.016 m in
the last 0.5 s` (limit 0.015). A probe printing the truck every 0.25 s showed it is not sliding: it
rocks in roll between -1.2 and -2.5 degrees with a period of about 2 s and never stops.

**Root cause:** the footing. The spot (nudge 2 of the fan) passed the footprint check at grade 0.119
(limit 0.12) and roughness 0.075, but the ground under the wheels is twisted: front left 1.590 m,
front right 1.496 m below the datum, the rear axle level, a 0.10 m cross-axle twist. A least-squares
plane can't see a twist. On it the Cruiser's soft solid axles keep rocking on the parking brake. No
rock touches the truck (the nearest is 3 m to the side of the footprint).

**Fix:** `checkSpot` also measures the twist at the Cruiser's wheel contacts (wheelbase 3.24 m, track
1.62 m) and rejects over 0.08 m (`LIMITS.twist`). Every other spawn on every map was already under
0.07 m, so only this point moves (to nudge 6, 1.7 m further out: twist 0.03 m; the Cruiser moves
0.8 mm in the last 0.5 s, the Pickup 1.6 mm, the Sedan 0.2 mm). **Test:** `test/spawns.mjs` checks
the twist at every point on every map and that the old pose is rejected for its twist.

### 15. LOW: a "Stage 12: Summit" spawn point joined The Gauntlet at its finish gate. FIXED (src/spawns.js)

**Repro:** in the game, `?map=crawl` logs `[spawns] crawl: skipped "Stage 12: Summit": no safe spot
nearby (tries failed on: rock x7, rough x1, grade x6, loose x1)`, while `MAP=crawl node test/spawns.mjs`
listed 28 points including it. Joining there (`CrawlCourse.joinAt(12)`, then driving through the
gate) gives `{"type":"finish","time":0,"clean":false}`: "Summit in 0:00".

**Root cause:** the stage loop in `candidates()` made a gate spawn for every stage, including the
last one, which is the summit pad whose gate is the finish (the side courses already skip their
finish gate). Its only clear nudge was blocked in the browser by a loose dressing pebble, which the
headless test can't see (it has no dressing).

**Fix:** no gate spawn for the last stage; the separate Summit point covers the pad. **Test:**
`test/spawns.mjs` asserts there is no `stage-12`.

### 16. LOW: "All five trails conquered!" again after a restart, with a short total. FIXED (src/main.js)

**Repro:** finish every trail, Esc, Restart at trailhead (or pick another rig), finish any one trail:
the toast says `All five trails conquered! Total 0:12`. `test/browser-qa.mjs` check 10 (fails on the
old code).

**Root cause:** `startDrive` resets `game.done` and the clock on a fresh start but keeps each trail's
done mark (and its green gate caps), so `game.trails.every(done) && !game.done` is true again at the
next finish.

**Fix:** a session flag `game.conquered`: the toast shows once per session.

### 17. LOW: joining a side course at a section gate during a Gauntlet run kept the Gauntlet's run state. FIXED (src/main.js)

**Repro:** start a Gauntlet run, then drive into Broken Slab through its section 2 gate:
`__game.activeTrail` stays `{ course: null }` (The Gauntlet's) though the Gauntlet run was cancelled,
so the big map's Gauntlet row shows a running clock on the side course's time.
`test/browser-qa.mjs` check 11.

**Root cause:** `updateCrawl`'s `stage` event only created `game.active` when there was none.

**Fix:** it replaces `game.active` when it belongs to another course.

### Found, not fixed

- **LOW, src/main.js `updateCrawl`:** the stage and finish toasts are delayed with `setTimeout`
  (1.2 s / 1.5 s) and never cancelled, so a teleport (J), Y or a pause right after a gate is
  followed by a stale "Stage n/12 ..." or "Summit! ..." toast over the spawn / restart message.
  Suggested patch: a counter bumped in `spawnAt`, `restartTrail` and `spawn`, captured when the
  timeout is set; the callback returns if it changed.
- **Test gap:** `test/spawns.mjs` builds no dressing, so loose dressing stones (`looseProps.items`,
  passed as `extra` in the game) never block a spawn headless. Bug 15 was only visible in the
  browser. `test/spawnsbrowser.mjs` and the console-warning check in a browser sweep cover it.
- **Off limits, not touched:** the Pickup's square-ledge regression (0.30 m to 0.25 m) in the hold
  code, as listed in HANDOFF.
- **Off limits (static hold), MEDIUM for parked trucks:** `node test/props.mjs` fails part (d), "parked
  with one tyre on a rock for 5 s": with the tyre on a loose (dynamic) 0.5 m stone instead of the
  same stone fixed, the chassis drifts 8-38 mm (fixed: 0.1-3.3 mm): Pickup 18.2 mm (9.2 in the last
  3 s), Cruiser 8.4 mm (the stone itself moves 48 mm), Rally Sedan 38.1 mm (24.8 in the last 3 s)
  while its stone moves only 0.6 mm. None of the files that test loads changed in this pass, so it
  fails on c18ccfa too. Likely cause, unverified: the hold in `postPhysics` only anchors patches
  standing on fixed ground, so a tyre on a loose stone gets no hold and slowly walks off it (the
  Sedan case, where the stone barely moves, points that way). Suggested: let the hold anchor on a
  dynamic collider that is asleep or slower than its standing threshold, anchored in that body's
  frame, or relax the test for loose props if creeping off a loose stone is acceptable.
- **Test, fixed:** `test/spawnsbrowser.mjs crawl` failed 8 checks on c18ccfa: it scrolled the spawn
  list six wheel notches to reach the last row, which stopped being enough when the side courses
  lengthened the Gauntlet's list. It now scrolls until the last row is drawn; all three maps pass.

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
