# LowRange: session handoff

State of the project for the next working session, which will have the Blender MCP tools loaded.

## What's in `main` now

| Area | State |
|---|---|
| Physics | Custom tyre and drivetrain solver on Rapier. Solid axles and independent suspension, manual gearbox, high/low range, lockers, LSD and traction control, damage. Verified by the `test/*.mjs` suite. |
| Maps | **Trail Park** (graded roads plus 5 rated trails) and **Race Track** ("Dust Bowl Circuit": laps, checkpoints, countdown, best laps). Select in the menu; the `?map=race` URL parameter loads the track directly. **The Gauntlet** (`?map=crawl`, `src/maps/crawl.js`): one 783 m, 12-stage test trail that keeps getting harder, with stage gates, splits, per-rig bests, a bypass track with spurs, and Y back to the current stage's gate (`src/crawl_course.js`, `src/crawl_view.js`). |
| Garage | Tyres, tread, lift, springs, damping, travel, engine, gearing, diffs, armour and paint, saved per rig (`src/garage.js`, `src/garage_ui.js`). |
| Loading screen | Pixel-art "LowRange" title scene with staged boot (`src/boot.js`, `src/ui/`). |
| Desktop | Electron offline game. `npm run desktop` runs it; `npm run dist:win` builds the installer and portable exe into `release/`. The builds are unsigned. F10 opens settings. |
| Crash damage | `src/damage/`: impact energy per contact event (impulse x closing speed, per kg), a free-form deformation cage the glTF bodies follow (zone travel caps, no-inversion, buckling), glass / lamps / tear-off parts, location-based mechanical damage (radiator + overheating, engine, corner suspension, fender drag, driveshaft, oil pan, diffs, roof). Wheel damage is windowed AND gated on closing speed (wheel or the body above it): slow crawling can't bend or snap anything. `node test/crash.mjs`, `node test/slowcrawl.mjs`, `test/crashshots.mjs`, `test/lib/damage_watch.mjs`. HUD hook available: `car.crash.mech` (`temp`, `coolant`, `oil`, `radiator`, `driveLost`) and `car.crash.report()`. |
| Art | Interim procedural vehicles styled after the reference (`src/vehicle_view.js`). Set dressing: trees, bushes, flowers, fences, log edging and stumps (`src/art/`). The glTF loader picks up `public/models/**.glb` automatically (`docs/MODELING_SPEC.md`, `docs/ASSETS.md`). |

## Next: Blender pipeline (start here)

Goal (user): vehicles and terrain/rocks that look like the reference concept image
(kept outside the repo) but **in 3D**: warm palette, pixel-textured
surfaces, stepped toon lighting with warm shadows, dark outlines. No brand names or logos.

Work so far, in `tools/blender/`:

- `bridge.py`: talks to the Blender add-on socket (127.0.0.1:9876) without MCP tools, e.g. `py tools/blender/bridge.py get_scene_info` or `py tools/blender/bridge.py exec <script.py>`. With the Blender MCP loaded, use its tools instead.
- `lib.py`: helpers. Primitives with bevels, `parent_keep`, `arch_flare`, `build_wheel`, boolean arch cutters, preview camera and lights, `export_glb`. Materials store `base_rgb`, `emit_rgb`, `emit_str` and `rough` so the restyle can re-run.
- `build_lc70.py`: the 70-series-style wagon, built to the physics spec (named `Body`/`Wheel`/`AxleFront`/`AxleRear` parts, `Marker_*` empties, `tyre_radius`/`tyre_width` on `Wheel`). It goes into its own Blender scene, `LowRange_lc70`.
- `pixel_style.py`: the pixel-art restyle. Cube-projected UVs at 20 px/m, 16 px dithered pixel tiles with Closest sampling, a toon ramp with warm shadows via Shader-to-RGB, inverted-hull outlines, and a chunky-pixel rendered viewport. The first result works but needs stronger light/shadow bands, a richer palette, and more of the reference's softer, rounder shapes.

To-do, roughly in order:

1. Finish the lc70 look in Blender against the reference, then build `taco` (olive double-cab pickup) and `wrx` (blue rally sedan) the same way.
2. Export to `public/models/vehicles/<id>.glb` (follow `docs/MODELING_SPEC.md`), check in game, and keep the outline material (backface-culled) and `TailLight`.
3. Code: read the `Marker_*` empties and the `tyre_*` extras to derive physics numbers (track, wheelbase, tyre size, ride height, collision boxes) when a model is present, retune gearing and springs, and rerun the tests.
4. Terrain and rocks: more 3D form (sculpted, rounded boulders and layered ground) with the same pixel-texture treatment; in-trail rocks must stay physics-accurate (convex hulls from the model).
5. Merge the other session's pixel skin once it's on its own branch and renamed neutrally (`src/pixelskin/`, `installPixelSkin`, `docs/PIXEL_SKIN.md`).

## Ground relief, loose stones, log edging, tyre effects (latest)

- **Loose vs fixed** (`src/physics_props.js`): only stones under 0.4 m across (`DYNAMIC_MAX_WIDTH`) are dynamic; medium/large rocks, logs and stumps are fixed colliders. Dressing small stones are 0.16-0.34 m; medium/large ones keep 0.8 m clear of every path (`src/art/dressing.js`). The Gauntlet's loose stones (`LOOSE` in `src/maps/crawl.js`) are small and sparse on stages 1, 2, 4 and 5; it has no loose logs.
- **Logs** only as fixed trail-crew edging (`logEdging` in `src/art/dressing.js`): runs along the outside of trail bends tighter than 30 m radius, a pair at each trail entrance, and parking bumpers round the trailhead lot. Every log is 0.8 m + its radius clear of every path and sits on gentle ground. `test/props.mjs` (h) checks this on the Trail Park.
- **Relief** (real geometry): `lumps` / `potholes` in `src/maps/common.js` are baked into the 1 m heightfield; `rockKit.embedded` makes low, rounded, fixed rock hulls sunk into the ground for the sub-metre bumps (all embedded hulls share one fixed body). Gauntlet: per-stage `RELIEF` table (lumps, ruts, holes, embedded rocks in the wheel tracks, rubble beside the tread, rocks on the Ledges slab tops), faded out in front of every step and gatekeeper so `test/crawlcheck.mjs` step heights hold. Park trails: `RELIEF` by difficulty in `src/maps/trailpark.js` (green stays at or under 0.12 m). Open ground everywhere: lumps, sd 0.07 m. Roads and the bypass track: crown plus washboard / lumps / shallow potholes. Race track: washboard on straights, braking bumps before bends, potholes, a firmer swept line with loose gravel off it, and mud on the outer metre and verge around the splash. Bogs have churned ruts (60% visible). `GRID.tone` darkens ruts and mud in the ground shader (two calm steps, `src/gfx/terrain_look.js`). A finer heightfield was not used: the embedded hulls give the sub-metre bumps without a 4x bigger terrain mesh.
- **Tyre effects** (`src/main.js`, marked `[tyre fx]`): soft round dust puffs on dry dirt, gravel, road and sand, mostly from the rear wheels and only above about 16 km/h or with wheelspin, low alpha, faded within 5.5 m of the camera; dark mud clods from tyres in mud (more with wheelspin); water spray in fords.
- Gauntlet autopilot after this: Cruiser finishes (683 s), Pickup stops in stage 10, Rally Sedan clears stages 1-4. Park: the Rally Sedan no longer gets through Granite Steps (blue; stops at 80/142 m).

## Known gaps

- Crash model limits: the collision shape stays boxes (only shrinks a little as ends / roof crush), the deformation is visual + a cage, not a soft body; rollover damage depends a lot on how the tumble goes. The HUD doesn't yet show engine temperature / oil (fields are on `car.crash.mech`).
- Trails were made tougher (taller/longer ledges, denser boulders, more camber, a longer, uneven bog). Autopilot, 400 s budget: green done by all three; blue done by Cruiser and Pickup, the Rally Sedan crawls through Granite Steps (164 s) and sinks in Bog Run; black done by Cruiser (165 s) and Pickup (237 s); double black done only by the Cruiser (309 s, so it times out under the usual 240 s), Pickup stops at 129/144 m. `node test/trailaudit.mjs` prints real rock and ledge heights per trail.
- The Rally Sedan's physics box is still taller than its 0.25 m sills; green rocks are capped at 0.20 m so the model never visibly scrapes.
- Desktop builds are unsigned (SmartScreen warning).
- The Gauntlet, crawl autopilot (`node test/crawl.mjs`): Cruiser finishes (722 s), Pickup stops in stage 10 (Boulder Garden II; from its gate it also fails the Waterfall), Rally Sedan clears stages 1-4 and stops at stage 5's 0.55 m gatekeeper ledges. The sim's sedan is stronger than the brief expected: it walks 0.45-0.5 m chamfered ledges on 0.33 m tyres and climbs a 35° slab, so it can't be stopped by stage 3 without putting taller obstacles out of order. This is worth a look in the tyre/step physics. Rigs walk staircases better than single ledges at speed; the Waterfall is tuned against `test/stairgrade.mjs` (Cruiser: 0.6 m OK up to a 28% tread, nothing at 33%).

## Checks after any change

```bash
node test/view.mjs && node test/garage.mjs && node test/brake.mjs && node test/creep.mjs && node test/damage.mjs && node test/slowcrawl.mjs && node test/crash.mjs
node test/trails.mjs lc70,taco,wrx 400         # trail autopilot (slow); 4th arg filters green|blue|black|dblack
node test/trailaudit.mjs                        # rock / ledge heights in each trail corridor
node test/race.mjs                              # race autopilot
node test/crawlcheck.mjs && node test/crawlcourse.mjs   # The Gauntlet: numbers + run logic
node test/crawl.mjs lc70,taco,wrx               # The Gauntlet autopilot, per stage (slow)
CHROME=<chromium.exe> PORT=5199 node test/shots.mjs <outdir> '<plan>'   # screenshots; QS='?map=race' for the track
```

## Repo hygiene

- Public repo: github.com/RMamujee/LowRange. Commit as `RMamujee <133895954+RMamujee@users.noreply.github.com>`, with **no AI co-author lines**. Run gitleaks before pushing.
- `.claude/`, `node_modules/`, `release/`, `test/shots/` and `Claude outputs/` are ignored.
