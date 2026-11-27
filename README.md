# LowRange: a 4x4 rock-crawling sim

An off-road game for Windows (offline desktop app) and the browser, with simple low-poly graphics and serious physics. Pick a rig, drop it into 4-Low,
lock the diffs and pick your line up rated rock trails.

Built with [Three.js](https://threejs.org/) for rendering and [Rapier](https://rapier.rs/) for rigid bodies,
plus a custom tyre and drivetrain solver.

## Run it

```bash
npm install
npm run dev      # http://localhost:5199
```

`npm run build` produces a static site in `dist/`.

## Download & play (Windows)

LowRange runs fully offline as a desktop game. There are two builds (see *Build from source* below to make them):

| File | What it is |
|---|---|
| `LowRange-Setup-0.1.0.exe` | Installer. Installs for your user only (no admin needed), lets you choose the folder, adds Desktop and Start Menu shortcuts, and uninstalls from *Settings > Apps*. |
| `LowRange-0.1.0-portable.exe` | Portable. One file, nothing installed: run it from anywhere, a USB stick included. It starts a little slower because it unpacks itself on each launch. |

**Windows SmartScreen:** the builds aren't code-signed yet, so the first launch shows *Windows protected your PC* with an *Unknown publisher*. Click **More info**, then **Run anyway**.

**Desktop keys:** F11 or Alt+Enter toggles fullscreen. F10 opens Settings (graphics preset, master volume, fullscreen, FPS counter). Esc opens the garage menu, the same as in the browser, and never drops you out of fullscreen. The garage menu has Settings and Quit buttons. The window's size, position and fullscreen state are remembered between launches.

**Where saves live:** settings, best times and garage builds are stored in the app's local storage under `%APPDATA%\LowRange\` (the `Local Storage` folder). The window position is in `%APPDATA%\LowRange\window-state.json`. The installer and the portable exe share that folder. Uninstalling keeps it, so delete the folder to reset everything. The browser version keeps its own separate saves in the browser.

The desktop app makes no network requests (everything, including the physics WASM, ships inside it), and it has no telemetry or auto-update.

## Build from source

You need Node.js 20+; the Windows packages must be built on Windows.

```bash
npm install
npm run dev            # browser version with hot reload, http://localhost:5199
npm run build          # static site in dist/
npm run desktop        # build, then run the desktop app from source (Electron)
npm run dist:win       # build the installer and portable exe into release/
npm run smoke:desktop  # launch the desktop app, wait for the game, screenshot to test/shots/
node test/desktop-smoke.mjs --packaged   # same, against release/win-unpacked/LowRange.exe
npm run icon           # regenerate build/icon.ico and build/icon.png (scripts/make-icon.mjs)
```

The first `dist:win` downloads the Electron runtime and the NSIS installer tools into electron-builder's cache.

The desktop shell is in `electron/`. `main.cjs` serves `dist/` over a private `app://lowrange` scheme with a strict Content-Security-Policy, and `preload.cjs` exposes a small `window.lowrange` API (version, platform, fullscreen, quit). The page is sandboxed and context-isolated with no Node access, and it can't navigate away or open windows. Allow-listed links (GitHub, three.js, Rapier) open in your browser.

## What's simulated

- **Suspension:** solid axles on links (articulation, diff hang-ups, axle wrap) or independent double-wishbone style, with springs, dampers, bump stops and anti-roll bars.
- **Drivetrain:** engine torque curve with an idle governor, a clutch you can slip or stall, a manual gearbox, a 2-speed transfer case (high/low), 2WD/4WD, open or locked front and rear diffs. Everything is solved as one exact constraint system each physics step, so 80:1 crawl ratios stay stable.
- **Tyres:** a custom friction model on every contact patch, so a tyre pushing into a rock face can climb it. Grip and side force share one friction budget (spinning tyres lose sideways grip), and grip varies by surface: rock, dirt, gravel, sand, mud. You can air down for more grip.
- **Crash damage** (`src/damage/`): crawling, bumps and small drops are damage-free; only real impacts count. Each hit on the body or axles is measured as energy (contact impulse times closing speed over the whole contact, per kg of truck), so a resting or sliding contact, a light loose rock or a wedged tyre never damages anything, and nothing under about 11 km/h of closing speed does. Energy past an elastic share crumples the body through a deformation cage at the actual contact point: soft crumple zones front and rear, a stiff cabin, roofs that cave in on landings and tumbles, fenders folding onto tyres, buckling metal. Glass cracks, then drops out; lamps break; bumpers, mirrors, spare wheels, roof racks and wings tear off as loose parts. Where the hit lands decides the consequences: radiator holed (overheating, steam, power loss, then a seized engine), engine pushed back, a corner's suspension bent (pull to one side, sag, a wobbling bent wheel, only a violent hit takes a wheel off), a fender rubbing a tyre, a bent or snapped rear driveshaft, a cracked oil pan or diff. The engine board above the instrument cluster shows it coming: a temperature strip (normal, hot with steam, overheating), the power you have left, oil and coolant lamps with the level once they leak, a drive lamp when an axle loses drive, and ENGINE SEIZED with the cause. A warning blinks briefly when it first comes on or gets worse. Backspace repairs on the spot, and so do Restart and Y.
- **Terrain:** three maps, picked in the menu or with `?map=park|race|crawl` (see *Maps*). The ground is physically lumpy, not just textured: rolling humps, hollows, wheel ruts and potholes baked into the 1 m heightfield, plus hundreds of low, rounded embedded rocks (fixed convex hulls sunk into the tread, 0.3-1.2 m across, up to 0.3 m proud) for the sub-metre bumps the grid can't hold. It escalates with difficulty on the Gauntlet and the park trails; roads and the race track stay graded but carry washboard, braking bumps and shallow potholes. Mud has soft holes and churned ruts the wheels sink into.
- **Loose stones:** small stones (under 0.4 m) are real bodies that tyres kick, fling and roll over; bigger rocks, stumps and the log edging are fixed (`src/physics_props.js`). Logs only appear as tidy trail-crew edging (bend outsides, trail entrances, trailhead parking bumpers), never in a driving line.
- **Tyre effects:** a soft dust plume behind a car at speed on dry dirt, gravel and road (denser with speed and wheelspin, faded near the camera), dark mud clods from spinning tyres, water spray in fords.

## Maps

- **Trail Park** (`park`): graded roads and five rated trails: green Pinyon Two-Track, blue Granite Steps and Bog Run, black Boulder Alley, and double-black Widowmaker Falls.
- **Race Track** (`race`): the Dust Bowl Circuit, 1.3 km of dirt with jumps, whoops, a rock garden and a splash; laps, checkpoints and best laps.
- **The Gauntlet** (`crawl`): a physics and driving test course. You spawn at the foot of one 783 m rock trail that climbs 54 m up a mountainside in 12 numbered stages, each harder than the last and each testing one skill: Warm-up, Articulation, Ledges I (0.2-0.3 m), Side-slope (up to 20°), Boulder Garden I, The Climb (20°/28°/35° slab, then loose gravel), Ledges II (0.4-0.55 m), Bog & Ford, Notches & Squeezes, Boulder Garden II, The Waterfall (stacked 0.5-0.58 m steps on a 28% pitch), and the Summit. Every stage has a gate and a signpost; the run is timed from the start gate to the summit, with a split per stage, and your best total and best splits are saved per rig. The HUD points to the next gate and shows "STAGE n/12". **Y** takes you back to the gate of the stage you're in. A graded bypass track runs alongside with a spur into every stage gate, for skipping a stage or getting out; a run that skips stages still records splits but doesn't count as a best. Tuning lives in the `STAGE_DEFS` table at the top of `src/maps/crawl.js`, ground relief per stage in the `RELIEF` table below it.

**Spawn points** (BeamNG-style): press **J** (or pick *Spawn points* in the pause menu, or click a wooden "P" signpost on the big map) to jump to any named spot: the trailhead, either end of a trail (just outside its gate, facing in, so driving forward starts the run), every Gauntlet stage gate plus the summit and the bypass track, or the race grid, paddock and each checkpoint (a rolling start: the lap clock starts at the line). Arrow keys + Enter pick from the list, Enter again confirms. The truck arrives repaired, at rest, in neutral with the parking brake on, keeping your rig, garage build and driver settings; any run in progress is cancelled. The last point you used is remembered per map and offered as *Restart at ...* in the pause menu. Points are derived from the map data and footprint-checked at load (flat ground, no rock, tree or prop colliders); see `src/spawns.js`.

## Rigs

| Rig | Style | Notes |
|---|---|---|
| Trail Pickup | lifted mid-size double cab | independent front, solid rear with locker, 6-speed |
| Cruiser 76 | 70-series style wagon | solid axles, front and rear lockers, V8 diesel |
| Rally Sedan | turbo AWD rally car | independent all round, permanent AWD, no low range |

Two more rigs, the Billy Goat rock buggy and the Mule expedition truck, are parked until they get
Blender models: their specs stay in `src/specs.js` with `enabled: false`. Delete that flag to bring one back.

## Controls

| Input | Action |
|---|---|
| W / S | throttle / brake |
| A / D (or Left / Right arrows) | steer |
| Space | clutch (hold) |
| Shift | crawl throttle (35%) |
| Arrow Up / Down (or PageUp / PageDown, Fn+Up / Fn+Down on most laptops) | shift up / down, one gear per press (no mouse needed) |
| Mouse wheel | shift up / down |
| R | high / low range |
| Q / E | front / rear locker |
| F | 2WD / 4WD |
| G | rear steer (parked buggy only) |
| T | air down / up |
| P | parking brake on / off (latching; every fresh truck starts with it on) |
| B | handbrake (hold) |
| I | start engine |
| C | auto-clutch on/off |
| Backspace | repair and right the truck where it is |
| Y | restart the current trail (The Gauntlet: the stage you're in) |
| V | camera |
| Z / X | zoom |
| Mouse drag | orbit the camera |
| M | map: click to set waypoints, right-click to remove, drag / wheel to pan / zoom |
| J | spawn points: the map opens on the list (arrows + Enter, or click a signpost); J again closes |
| N | mute |
| H | help |
| Esc | pause (RESUME returns to the same truck; "Restart at trailhead" repairs; "Spawn points" and "Restart at <last spawn>") |

A gamepad also works: RT/LT for the pedals, RB/LB to shift, X for the clutch, A for the parking brake, R3 for the map.

## Tests

Headless physics checks run in Node, for example:

- `node test/brake.mjs`: braking distances
- `node test/obstacle.mjs ledge`: ledge climbing
- `node test/trails.mjs lc70,taco,wrx 240`: an autopilot drives each trail
- `node test/damage.mjs`: drop and wall-impact damage
- `node test/crash.mjs [ids] [scenario]`: crash scenarios on the real glTF bodies (drops, roof drop, walls at 10/30/60 km/h, tree, rollover, rear hit, belly, crawling, repair, respawn leaks) with damage / deformation numbers and tuning asserts
- `node test/enginehud.mjs`: the HUD's engine board state (temperature zone, oil / coolant / drive lamps, seized, blink) through a real overheat-and-seize, oil loss, a snapped driveshaft and repairs
- `node test/slowcrawl.mjs`: slow-speed abuse (ledge drop, full-throttle ledge climb, wedged tyre, rock under a wheel, loose stones) must do no damage; `node --import ./test/lib/damage_watch.mjs test/trails.mjs ...` (or `test/crawl.mjs`, `test/race.mjs` with the matching `MAP=`) adds a worst-damage summary to any autopilot
- `node test/crawl.mjs lc70,taco,wrx [fromStage] [toStage]`: autopilot on The Gauntlet, furthest stage and time per stage
- `node test/crawlcheck.mjs`: The Gauntlet by the numbers (step heights against measured limits, clear lanes, grades); `node test/crawlcourse.mjs`: its run logic
- `node test/stairgrade.mjs <ids> <grades> <rises>`: how tall a staircase each rig walks
- `node test/spawns.mjs`: every spawn point on every map, each rig dropped and settled on it (upright, at rest, undamaged, wheels down, no colliders in the footprint)

With the dev server running (`npx vite --port 5841`), browser checks use Playwright with a Chromium path in `CHROME`:

- `PORT=5841 node test/crashshots.mjs <outdir>`: before/after crash shots per rig (barrier hits, drops, roof, tumble, tree, in-place repair); finals in `docs/previews/crash_*.png`
- `PORT=5841 node test/hud.mjs`: the pixel HUD (stick shifter through every gear, parking brake on a slope, pause / resume, map waypoints + persistence, trail toasts, race laps)
- `PORT=5841 node test/spawnsbrowser.mjs [park|race|crawl|all]`: spawn points through the map list, signposts, keyboard and the pause menu; runs start from the gate afterwards
- `PORT=5841 node scripts/hud-mockup.mjs`: regenerates the HUD review sheets in `docs/previews/hud_*.png`
