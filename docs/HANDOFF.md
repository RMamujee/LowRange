# LowRange: session handoff

State of the project for the next working session, which will have the Blender MCP tools loaded.

## What's in `main` now

| Area | State |
|---|---|
| Physics | Custom tyre and drivetrain solver on Rapier. Solid axles and independent suspension, manual gearbox, high/low range, lockers, LSD and traction control, damage. Verified by the `test/*.mjs` suite. |
| Maps | **Trail Park** (graded roads plus 5 rated trails) and **Race Track** ("Dust Bowl Circuit": laps, checkpoints, countdown, best laps). Select in the menu; the `?map=race` URL parameter loads the track directly. |
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

## Checks after any change

```bash
node test/view.mjs && node test/garage.mjs && node test/brake.mjs && node test/creep.mjs && node test/damage.mjs
node test/trails.mjs lc70,taco,wrx 400         # trail autopilot (slow); 4th arg filters green|blue|black|dblack
node test/trailaudit.mjs                        # rock / ledge heights in each trail corridor
node test/race.mjs                              # race autopilot
CHROME=<chromium.exe> PORT=5199 node test/shots.mjs <outdir> '<plan>'   # screenshots; QS='?map=race' for the track
```

## Repo hygiene

- Public repo: github.com/RMamujee/LowRange. Commit as `RMamujee <133895954+RMamujee@users.noreply.github.com>`, with **no AI co-author lines**. Run gitleaks before pushing.
- `.claude/`, `node_modules/`, `release/`, `test/shots/` and `Claude outputs/` are ignored.
