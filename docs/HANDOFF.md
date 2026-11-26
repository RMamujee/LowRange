# LowRange: session handoff

State of the project for the next working session, which will have the Blender MCP tools loaded.

## What's in `main` now

| Area | State |
|---|---|
| Physics | Custom tyre and drivetrain solver on Rapier. Solid axles and independent suspension, manual gearbox, high/low range, lockers, LSD and traction control, damage. Verified by the `test/*.mjs` suite. |
| Maps | **Trail Park** (graded roads plus 5 rated trails) and **Race Track** ("Dust Bowl Circuit": laps, checkpoints, countdown, best laps). Select in the menu; the `?map=race` URL parameter loads the track directly. **The Gauntlet** (`?map=crawl`, `src/maps/crawl.js`): one 783 m, 12-stage test trail that keeps getting harder, with stage gates, splits, per-rig bests, a bypass track with spurs, and Y back to the current stage's gate (`src/crawl_course.js`, `src/crawl_view.js`). |
| Spawn points | BeamNG-style teleport: J / pause menu / map signposts. `src/spawns.js` derives the points from map data (trailhead, both trail ends outside the gates, Gauntlet stage gates + summit + bypass, race grid / paddock / checkpoints) and footprint-checks them at load (grade, bumpiness, water/bog, rock/tree/prop/loose-prop discs; nudged along the path, skipped with a console warning if nothing is safe). Teleport = `spawnAt` in `src/main.js` (respawnFresh, park brake, neutral, cancels runs, camera snap, last point per map in localStorage). Tests: `node test/spawns.mjs`, `test/spawnsbrowser.mjs`. |
| Garage | Tyres, tread, lift, springs, damping, travel, engine, gearing, diffs, armour and paint, saved per rig (`src/garage.js`, `src/garage_ui.js`). |
| Loading screen | Pixel-art "LowRange" title scene with staged boot (`src/boot.js`, `src/ui/`). |
| Desktop | Electron offline game. `npm run desktop` runs it; `npm run dist:win` builds the installer and portable exe into `release/`. The builds are unsigned. F10 opens settings. |
| Art | Interim procedural vehicles styled after the reference (`src/vehicle_view.js`). Set dressing: trees, bushes, flowers, fences, logs and stumps (`src/art/`). The glTF loader picks up `public/models/**.glb` automatically (`docs/MODELING_SPEC.md`, `docs/ASSETS.md`). |

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

## Known gaps

- The Rally Sedan breaks a wheel at full race pace in the race autopilot (`node test/race.mjs`); tune its damage or suspension.
- Trails were made tougher (taller/longer ledges, denser boulders, more camber, a longer, uneven bog). Autopilot, 400 s budget: green done by all three; blue done by Cruiser and Pickup, the Rally Sedan crawls through Granite Steps (164 s) and sinks in Bog Run; black done by Cruiser (165 s) and Pickup (237 s); double black done only by the Cruiser (309 s, so it times out under the usual 240 s), Pickup stops at 129/144 m. `node test/trailaudit.mjs` prints real rock and ledge heights per trail.
- The Rally Sedan's physics box is still taller than its 0.25 m sills; green rocks are capped at 0.20 m so the model never visibly scrapes.
- Desktop builds are unsigned (SmartScreen warning).
- The Gauntlet, crawl autopilot (`node test/crawl.mjs`): Cruiser finishes (722 s), Pickup stops in stage 10 (Boulder Garden II; from its gate it also fails the Waterfall), Rally Sedan clears stages 1-4 and stops at stage 5's 0.55 m gatekeeper ledges. The sim's sedan is stronger than the brief expected: it walks 0.45-0.5 m chamfered ledges on 0.33 m tyres and climbs a 35° slab, so it can't be stopped by stage 3 without putting taller obstacles out of order. This is worth a look in the tyre/step physics. Rigs walk staircases better than single ledges at speed; the Waterfall is tuned against `test/stairgrade.mjs` (Cruiser: 0.6 m OK up to a 28% tread, nothing at 33%).
- Spawn points: the far ends of Pinyon Two-Track, Bog Run and Widowmaker Falls are skipped (console warning): the baked terrain drops 3-5 m in the last metres of those trails, so their far gates are not reachable from the road at all (a map issue: the trail end heights are pinned to the road but the carve does not meet it). Fix the junctions in `src/maps/trailpark.js` and the spawns appear on their own.

## Checks after any change

```bash
node test/view.mjs && node test/garage.mjs && node test/brake.mjs && node test/creep.mjs && node test/damage.mjs
node test/trails.mjs lc70,taco,wrx 400         # trail autopilot (slow); 4th arg filters green|blue|black|dblack
node test/trailaudit.mjs                        # rock / ledge heights in each trail corridor
node test/race.mjs                              # race autopilot
node test/crawlcheck.mjs && node test/crawlcourse.mjs   # The Gauntlet: numbers + run logic
node test/spawns.mjs                            # spawn points: every rig settled at every point on all three maps
node test/crawl.mjs lc70,taco,wrx               # The Gauntlet autopilot, per stage (slow)
CHROME=<chromium.exe> PORT=5199 node test/shots.mjs <outdir> '<plan>'   # screenshots; QS='?map=race' for the track
```

## Repo hygiene

- Public repo: github.com/RMamujee/LowRange. Commit as `RMamujee <133895954+RMamujee@users.noreply.github.com>`, with **no AI co-author lines**. Run gitleaks before pushing.
- `.claude/`, `node_modules/`, `release/`, `test/shots/` and `Claude outputs/` are ignored.
