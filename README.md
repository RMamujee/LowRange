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
- **Tyres:** a custom friction model on every contact patch, so a tyre pushing into a rock face can climb it. Grip and side force share one friction budget (spinning tyres lose sideways grip), and grip varies by surface: rock, dirt, gravel, sand, mud.
- **Tyre pressure:** an on-board inflation system lets you air down and up while driving (about 2 psi/s down, 1 psi/s up from the compressor), from about 8-10 psi crawl pressure to 32-36 psi road pressure. It is one continuous effect: lower pressure grips rock better (a longer patch that wraps edges), floats on mud and deep sand, and the tyres flatten and bulge at the patch; it costs rolling drag, vaguer steering and cornering at speed, and below about 14 psi a hard corner or side hit at speed can pop a bead off the rim (a flat; Backspace repairs). The tyre board above the cluster shows the pressure, CRAWL / TRAIL / ROAD zones and the compressor. The garage sets the starting pressure; the live pressure is remembered per rig.
- **Crash damage** (`src/damage/`): crawling, bumps and small drops are damage-free; only real impacts count. Each hit on the body or axles is measured as energy (contact impulse times closing speed over the whole contact, per kg of truck), so a resting or sliding contact, a light loose rock or a wedged tyre never damages anything, and nothing under about 11 km/h of closing speed does. Energy past an elastic share crumples the body through a deformation cage at the actual contact point: soft crumple zones front and rear, a stiff cabin, roofs that cave in on landings and tumbles, fenders folding onto tyres, buckling metal. Glass cracks, then drops out; lamps break; bumpers, mirrors, spare wheels, roof racks and wings tear off as loose parts. Where the hit lands decides the consequences: radiator holed (overheating, steam, power loss, then a seized engine), engine pushed back, a corner's suspension bent (pull to one side, sag, a wobbling bent wheel, only a violent hit takes a wheel off), a fender rubbing a tyre, a bent or snapped rear driveshaft, a cracked oil pan or diff. The engine board above the instrument cluster shows it coming: a temperature strip (normal, hot with steam, overheating), the power you have left, oil and coolant lamps with the level once they leak, a drive lamp when an axle loses drive, and ENGINE SEIZED with the cause. A warning blinks briefly when it first comes on or gets worse. Backspace repairs on the spot, and so do Restart and Y.
- **Terrain:** five maps, picked in the menu or with `?map=park|race|crawl|jungle|desert` (see *Maps*). The ground is physically lumpy, not just textured: rolling humps, hollows, wheel ruts and potholes baked into the 1 m heightfield, plus hundreds of low, rounded embedded rocks (fixed convex hulls sunk into the tread, 0.3-1.2 m across, up to 0.3 m proud) for the sub-metre bumps the grid can't hold. It escalates with difficulty on the Gauntlet and the park trails; roads and the race track stay graded but carry washboard, braking bumps and shallow potholes. Mud is deep and deformable: tyres sink in by their load and footprint (airing down helps), plough ruts that stay and deepen with every pass, dig themselves in when they spin, and a truck that sinks to its belly bogs down; momentum, steady throttle, lockers and low range get you through.
- **Loose stones:** small stones (under 0.4 m) are real bodies that tyres kick, fling and roll over; bigger rocks, stumps and the log edging are fixed (`src/physics_props.js`). Logs only appear as tidy trail-crew edging (bend outsides, trail entrances, trailhead parking bumpers), never in a driving line.
- **Tyre effects:** a soft dust haze behind a car on dry dirt, gravel, sand and road (denser with speed and wheelspin, faded near the camera), many small wet mud lumps and flecks flung off the tread that splat where they land, water spray in fords and surf, and mud caking the tyres and lower bodywork until a ford washes it off. Asphalt (tarmac) makes no dust.
- **Water:** fords, the creek and the shallow surf off a beach are drivable (water drag on the tyres, spray). On Coralume Island the sea is the edge of the map: once the cab has been under for a second in deep water, the truck is towed back to the nearest road, repaired.

## Maps

- **Trail Park** (`park`): graded roads and five rated trails: green Pinyon Two-Track, blue Granite Steps and Bog Run, black Boulder Alley, and double-black Widowmaker Falls.
- **Race Track** (`race`): the Dust Bowl Circuit, 1.3 km of dirt with jumps, whoops, a rock garden and a splash; laps, checkpoints and best laps.
- **The Gauntlet** (`crawl`): a physics and driving test course. You spawn at the foot of one 783 m rock trail that climbs 54 m up a mountainside in 12 numbered stages, each harder than the last and each testing one skill: Warm-up, Articulation, Ledges I (0.2-0.3 m), Side-slope (up to 20°), Boulder Garden I, The Climb (20°/28°/35° slab, then loose gravel), Ledges II (0.4-0.55 m), Bog & Ford, Notches & Squeezes, Boulder Garden II, The Waterfall (stacked 0.5-0.58 m steps on a 28% pitch), and the Summit. Every stage has a gate and a signpost; the run is timed from the start gate to the summit, with a split per stage, and your best total and best splits are saved per rig. The HUD points to the next gate and shows "STAGE n/12". **Y** takes you back to the gate of the stage you're in. A graded bypass track runs alongside with a spur into every stage gate, for skipping a stage or getting out; a run that skips stages still records splits but doesn't count as a best. Tuning lives in the `STAGE_DEFS` table at the top of `src/maps/crawl.js`, ground relief per stage in the `RELIEF` table below it.
  - **Side courses** on the same map: three separate, timed rock-crawling courses where going slowly and placing the tyres is the skill. Each has a start gate, numbered section gates and a finish gate with signs, its own best time and best splits per rig, and a graded access track (white edge posts, a "TO ..." sign where it starts). The HUD reads "SECTION n/N" on a course; **Y** takes you back to the gate of the section you're in (the course start in the first section). Only one run at a time: starting a course cancels a run on any other.
    - **Broken Slab** (Moderate, 110 m, climbs 14 m; north of the summit, Slab Track from the summit pad): a 22 m wide slab face at up to 32% with six broken ledge bands, cracks and boulders. Pick your line: the left line has 0.2-0.3 m ledges (any rig), the middle 0.3-0.45 m, the right 0.4-0.5 m with boulders piled beside it.
    - **Camber Ridge** (Hard, 157 m; south of the trailhead, Camber Track from the trailhead lot): an off-camber traverse that leans from 6 to 29 degrees: Lean-in, Rib Walk (straddle a rock spine on a 20 degree lean while holes drop one wheel at a time), Knife Edge (near 30 degrees with kickers under the high side). Tuned against measured tip-over angles (`node test/tipangle.mjs`: the Cruiser tips at about 38 degrees parked).
    - **Cobble Gully** (Extreme, 194 m, drops 19 m (finishes 13 m below its start); east of the summit, Gully Track off the Slab Track just below the summit, Gully Exit back to the Slab Track): a gully choked with rounded boulders you drive on: Drop-in (35%), Cobble Run, The Chute (42% down on engine braking), Creek Bed, Climb-out (30% over boulder steps).
    - Course data (sections, ground shaping, rocks, access tracks) is in the `COURSE_DEFS` table of `src/maps/crawl_courses.js`.

- **Coralume Island** (`jungle`): a jungle-covered volcanic island in open sea, about 800 m across on a 1 km map, built for free roaming (`src/maps/jungle.js`, art in `src/art/jungle/`). A paved **Coast Road** (2.1 km loop, painted lines, gravel shoulders, banked bends, guard rails on the cliff tops) rings the island and crosses Ember Creek on a timber bridge; the paved **Ember Pass Road** (1.1 km, 11% max) climbs the south flank in four hairpins with guard rails to the **Summit Viewpoint** at 120 m, under the crater rim. Graded dirt roads branch off: **Plantation Road** (fords the creek below Ember Falls, muddy dips), **Lighthouse Lane** out to the lighthouse on Lava Point, the **Ridge Track** up to a lookout over West Cove, and the rutted **Fern Gully Track** two-track. Sand tracks run along **Crescent Beach** (the bay, with the Palm Cove dock you can drive onto) and **Sunrise Beach** (surf and the creek mouth); air down for the soft sand, the wet sand at the waterline is darker, and the shallow surf drives with spray. Four rated crawls, signed and timed like the park's: green **Cliffside Ledge** (a shelf below the north cliffs), blue **Riverbed Run** (from the coast road down into Ember Creek, up its rocky bed through the Plantation ford to the plunge pool under the falls), black **Basalt Garden** (jagged lava boulders round Lava Point to the lighthouse) and double-black **Ember Stairs** (a spiral rock staircase of nine step-ups from the summit lot to the crater rim). Places in the spawn list: Palm Cove (the village, default), the dock, both beaches, West Cove, the summit, the rim, the hairpins, Ember Falls, the Ridge Lookout, Fern Gully, the north cliffs, Plantation Road and the lighthouse, plus both ends of every crawl. Vegetation (palms on the coast, broadleaf canopy and emergents with vines inland, banana plants, ferns, shrubs, hibiscus) thins with the graphics preset; near trees are instanced, far ones are one merged mesh per chunk, and the ground is drawn in 128 m chunks with a coarse far level.
- **Sunfall Basin** (`desert`, `src/maps/desert.js`, view in `src/desert/`): an open desert, 1.2 km square (2 m terrain grid), ringed by a red rimrock escarpment (no invisible walls: the cliffs are the edge). The **Saffron Sea** dune field fills the north-east: chains of crescent dunes up to about 20 m, long windward faces (7-22°), sharp brinks and slip faces at the angle of repose (about 32°). Five km of graded desert tracks link everything (the 2.4 km Basin Loop, Lakebed Road across the white **Bonewhite Flat** dry lake, the North Track, the Dune Road, the Canyon Road between Anvil and Redwall mesas): washboard straights, whoops, crests and dry-wash crossings. Rated and timed like the park's trails: blue **Saffron Sea Crossing** (a marked dune route, 580 m over three dunes: wooden posts, no grading), green **Coyote Wash**, blue **Whaleback Slickrock** (grippy red slab and off-camber traverses over a dome), black **Knucklebone Canyon** (a boulder-choked slot through Anvil Mesa) and double-black **Redwall Stairway** (16 rock steps up a ravine onto Redwall Mesa, to Eagle Point). Landmarks: Keyhole Arch (you can drive under it), the Goblin Row hoodoos, Needle, Chimney, Sentinel and Twin Buttes, and Sunfall Station, an old fuel stop at the trailhead. A Practice Dune by the Dune Road has one straight 15° face to learn on.
- **Deep sand** (Sunfall Basin's dunes only, `src/deepsand.js`): the dunes carry a sand depth. Tyres sink (an aired-up tyre about twice as deep as an aired-down one), sink less at speed, dig in when they spin and climb out slowly; the sinkage costs power as rolling resistance and grip, and sideways grip is weaker, so a side-slope slides. Air down (T) before the sand, use high range, carry momentum up the windward faces, ease off before a brink (crest too fast and you fly off the slip face) and go straight down slip faces. Aired up, a rig bogs on the Practice Dune's face from a standstill but makes it with a run-up; aired down it walks up. Sand tyre marks are left behind the wheels (visual only). Other maps' sand is unchanged.

**Spawn points** (BeamNG-style): press **J** (or pick *Spawn points* in the pause menu, or click a wooden "P" signpost on the big map) to jump to any named spot: the trailhead, either end of a trail (just outside its gate, facing in, so driving forward starts the run), every Gauntlet stage gate plus the summit and the bypass track, each side course's start, section gates and finish (a group per course), or the race grid, paddock and each checkpoint (a rolling start: the lap clock starts at the line). Arrow keys + Enter pick from the list, Enter again confirms. The truck arrives repaired, at rest, in neutral with the parking brake on, keeping your rig, garage build and driver settings; any run in progress is cancelled. The last point you used is remembered per map and offered as *Restart at ...* in the pause menu. Points are derived from the map data and footprint-checked at load (flat ground, no rock, tree or prop colliders); see `src/spawns.js`.

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
| [ / ] | tyres: air down / up. Tap for the next stop (crawl / trail / road), hold for any pressure. Works at any speed. The AIR- / AIR+ buttons on the tyre board do the same as a tap |
| T | tyres: crawl / road pressure |
| P | parking brake on / off (latching; every fresh truck starts with it on) |
| B | handbrake (hold) |
| I | start engine |
| C | auto-clutch on/off |
| Backspace | repair and right the truck where it is |
| Y | restart the current trail (The Gauntlet: the stage you're in; a side course: the section you're in) |
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
- `node test/slopehold.mjs`: parked on slopes (every rig, surfaces, brakes) must not creep; mud past the grip must slide
- `node test/parkbrake.mjs`: the parking brake holds the engine in first (4-Low) without stalling
- `node test/obstacle.mjs ledge`: ledge climbing
- `node test/trails.mjs lc70,taco,wrx 240`: an autopilot drives each trail
- `node test/damage.mjs`: drop and wall-impact damage
- `node test/crash.mjs [ids] [scenario]`: crash scenarios on the real glTF bodies (drops, roof drop, walls at 10/30/60 km/h, tree, rollover, rear hit, belly, crawling, repair, respawn leaks) with damage / deformation numbers and tuning asserts
- `node test/enginehud.mjs`: the HUD's engine board state (temperature zone, oil / coolant / drive lamps, seized, blink) through a real overheat-and-seize, oil loss, a snapped driveshaft and repairs
- `node test/tyrepressure.mjs`: tyre pressure (inflation rates and stops at speed, the old aired-up / aired-down tyre exactly at 32 / 10 psi, a ledge only climbed aired down, sinkage in Bog Run and on dune sand vs pressure, coast-down and cornering costs at speed, loaded radius and ride height, bead popping, the saved pressure)
- `node test/mud.mjs`: deformable mud (sinkage vs load and tyre pressure, spinning digs, ruts deepen and persist, a locked 4-Low Cruiser crosses Bog Run, a 2WD open-diff attempt bogs)
- `node test/slowcrawl.mjs`: slow-speed abuse (ledge drop, full-throttle ledge climb, wedged tyre, rock under a wheel, loose stones) must do no damage; `node --import ./test/lib/damage_watch.mjs test/trails.mjs ...` (or `test/crawl.mjs`, `test/race.mjs` with the matching `MAP=`) adds a worst-damage summary to any autopilot
- `node test/crawl.mjs lc70,taco,wrx [fromStage] [toStage]`: autopilot on The Gauntlet, furthest stage and time per stage
- `node test/crawlcheck.mjs`: The Gauntlet by the numbers (step heights against measured limits, clear lanes, grades); `node test/crawlcourse.mjs`: its run logic, the side courses' and the CourseSet (one run at a time, Y after a spawn, junk saved bests)
- `node test/stairgrade.mjs <ids> <grades> <rises>`: how tall a staircase each rig walks
- `node test/ledgeclimb.mjs [ids] [square,chamfer] [crawl,speed]`: the tallest single ledge each rig climbs (`LEDGE_ASSERT=1` checks the limits)
- `node test/tipangle.mjs [ids] [angles] [kick]`: side-slope tip-over per rig on a real tilted rock plane, parked and driving over a ridge under the uphill wheels
- `node test/coursecheck.mjs`: the Gauntlet side courses by the numbers (grades, side slopes, ledge lips per line, crawl-over rock heights, clear lanes, spawn points, access track grades, the guard round The Gauntlet)
- `node test/gauntletsame.mjs`: builds The Gauntlet with and without the side courses and checks its paths' surroundings, rocks and trees are unchanged
- `node test/coursedrive.mjs <slab|camber|gully|all> [ids] [fromSection]`: autopilot on a side course (`LINE=easy|hard|extreme` picks the slab line)
- `node test/spawns.mjs`: every spawn point on every map, each rig dropped and settled on it (upright, at rest, undamaged, wheels down, no colliders in the footprint)
- `node test/desertcheck.mjs`: Sunfall Basin by the numbers (rim boundary, track grades and junctions, dune slopes, the dune route, camp props); `node test/sand.mjs`: deep sand on the Practice Dune (aired down vs up, standing start vs run-up, wheelspin digging in); `node test/desert.mjs [tracks|dunes]`: autopilot over the desert tracks at speed and over the dune route with dune technique; crawls: `MAP=desert node test/trails.mjs lc70 300`
- `node test/junglecheck.mjs`: Coralume Island by the numbers (grades on the baked ground, every junction, bridges, Ember Stairs step lips, the sea edge); `node test/jungleroads.mjs [rigs] [road]`: road autopilot over every road and beach track; `MAP=jungle node test/trails.mjs lc70 240`: its crawls; in a browser `CHROME=<chrome.exe> PORT=<port> node test/jungleshots.mjs <outdir> [names]` (load time, frame cost and named screenshots)

With the dev server running (`npx vite --port 5841`), browser checks use Playwright with a Chromium path in `CHROME`:

- `PORT=5841 node test/crashshots.mjs <outdir>`: before/after crash shots per rig (barrier hits, drops, roof, tumble, tree, in-place repair); finals in `docs/previews/crash_*.png`
- `PORT=5841 node test/hud.mjs`: the pixel HUD (stick shifter through every gear, parking brake on a slope, pause / resume, map waypoints + persistence, trail toasts, race laps)
- `PORT=5841 node test/spawnsbrowser.mjs [park|race|crawl|all]`: spawn points through the map list, signposts, keyboard and the pause menu; runs start from the gate afterwards
- `PORT=5841 node scripts/hud-mockup.mjs`: regenerates the HUD review sheets in `docs/previews/hud_*.png`
