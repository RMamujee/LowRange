# Loading screen art (`loading_screen.blend`)

BeamNG-style studio shots: each vehicle posed on simple blocks so the suspension visibly flexes.
The game shows one of them at random on the loading screen (`src/ui/loading.js`).

## Scenes

| Scene | Vehicle | Pose |
|---|---|---|
| `Loading_lc70` | cream wagon, solid axles | front-left tyre on a 0.56 m cube; front axle tilted, rear counter-flexed |
| `Loading_taco` | olive pickup, IFS front + solid rear | crossed up: front-left on a ramp, rear-right on a cube |
| `Loading_wrx` | blue rally sedan, independent | front-left on a low half-cylinder kerb, a little body roll |

Each scene has the collections `Vehicle_<id>`, `Terrain_<id>`, `Backdrop_<id>`, `Lights_<id>`, `Camera_<id>`.

## Posing (the rig)

Everything in the vehicle hangs off `<id>_Rig`. Move/rotate the rig to place the whole vehicle.

- **Solid axles** (`<id>_AxleFront`, `<id>_AxleRear`): move **Z** to lift the axle and rotate **Y** to tilt it
  (positive Y raises the left side). The two wheels are children and follow.
- **Independent corners** (`<id>_HubFL` ... `<id>_HubRR`, circle empties): move **Z** for bump/droop.
- **Steering**: rotate the front wheels (solid axle) or front hubs (independent) about **Z**.
- **The body follows automatically.** `<id>_Body` location Z and rotation X/Y are driven from the axles/hubs
  (heave = average lift, pitch = front minus rear, roll = left minus right). Don't key the body directly;
  to offset it, change the Rig's custom properties `settle_z` (m) and `settle_roll` (rad).
- **Springs and shocks** use a *Stretch To* constraint aimed at mount empties on the body, so they stretch
  with any pose.
- Terrain blocks are plain meshes: move them so the tyre sits on top after you change the pose.

Keep the flex believable: suspension travel per corner is in `docs/MODELING_SPEC.md` (lc70: 0.13 bump / 0.18 droop).

## Look

Every material is the toon setup: pixel texture x a constant colour ramp (`ToonBands`) on a Shader-to-RGB of a
diffuse BSDF, as emission. Outlines are a flipped Solidify modifier (`Outline`) using the `Outline` material.
The backdrop bands live in the `WallBands` ramp of the `Backdrop` material. Light comes from one sun per scene.
Render: EEVEE, 1 sample, pixel filter 0, 480x270, Standard view transform, so the pixels stay hard.

## Rendering

From the .blend, keeping your edits:

```
"C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background art/blender/loading_screen.blend --python tools/blender/render_loading.py
```

Add `-- lc70` (or `taco`, `wrx`) to render one scene. Set `LOADING_STRIP=0` to skip the animation strip.
Outputs:

- `public/loading/<id>.png` - the 480x270 still the game shows
- `public/loading/<id>_settle.png` - 8 frames side by side (3840x270), the body bobbing on its springs
  (frames 1-8, keys on the Rig's `settle_z`/`settle_roll`); the game plays it as a loop
- `docs/previews/loading_<id>.png` - the still at 3x for review

Save the .blend after editing (packed textures; `File > External Data > Pack Resources` if you add images), then
strip the local paths Blender stores in it (File Browser folder, packed-from paths) before committing:
`blender --background --factory-startup art/blender/loading_screen.blend --python tools/blender/blend_save.py`,
checked by `node test/blend_paths.mjs`.

## Rebuilding from scratch

`tools/blender/build_loading.py` rebuilds the whole file from `public/models/vehicles/*.glb` (use it after a
vehicle model changes). **It overwrites `loading_screen.blend`**, so move hand edits into the `SHOTS` table at the
top of that script first, or re-apply them after.

```
"C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --python tools/blender/build_loading.py
```

A new scene for another vehicle = one more entry in `SHOTS` and a matching `<id>.glb`; also add the id to
`SHOTS` in `src/ui/loading.js`.
# LowRange in Blender

## World files: `world_park.blend`, `world_race.blend`

The whole game world in Blender, in the game's pixel-art look, for review and art direction:
terrain, roads and trails, gameplay rocks, trees and props, signs, gates and markers, the race venue
and the three vehicles.

### Regenerate (do this whenever the game's maps, props or vehicles change)

```
node tools/export/export_world.mjs park
node tools/export/export_world.mjs race
"C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --python tools/blender/world/build_world.py -- park
"C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --python tools/blender/world/build_world.py -- race
```

- The exporter imports the game's own modules (`src/terrain.js`, `src/maps/*`, `src/world_view.js`,
  `src/race_view.js`, `src/art/*`, `src/gfx/pixeltex.js`) and runs them headless, so every placement,
  rock and ground tile is exactly what the game builds. Output goes to `tools/blender/world/export/<map>/`
  (gitignored).
- The Blender script rebuilds the `.blend` from scratch and renders preview stills to
  `docs/previews/world_<map>_*.png`. Add `--no-render` after the map id to skip the stills, or set
  `LR_CAMS=Overview,Trailhead` to render only some cameras.
- Rebuilding **overwrites** `world_<map>.blend`. Save any of your own changes to another file.

### What's inside

| Collection | Contents |
|---|---|
| Terrain | 400 m x 400 m heightfield at 1 m, with the game's visual heights and softened shading normals. Its material rebuilds the game's ground: a pixel tile per surface (32 px/m, Closest) chosen by the baked material grid, ragged pixel-stepped borders, darker trail tread, tiles projected from the side on steep faces. The face attribute `surface` holds the material id. Also the distant ground ring. |
| Paths | Roads, trails and the race track as curves, named and tagged with difficulty, width and length (viewport only, hidden in renders). |
| Rocks | Every gameplay rock, using the game's exact convex hull and lit-top tone, with the rock tile. |
| Trees, Props | glTF props from `public/models` placed as **collection instances** of the models in *Library*. Grass tufts and flowering tufts are geometry-node instances, because there are thousands of them. The race venue (barriers, tyre walls, stands, crowd, paddock, water) is built from the game's procedural geometry. |
| Markers | Signposts and gates with their text, road and trail posts, race checkpoint arches, gantry and start line, plus empties for the spawn, trailhead lot, trail starts and ends, and checkpoints. |
| Vehicles | `public/models/vehicles/*.glb`, parked side by side at the spawn, with wheels placed at their `Marker_Wheel*` (left side mirrored, as in the game). |
| Lights & Cameras | Sun (game direction), plus cameras: *Trailhead* / *Race grid*, one per trail start (park) or checkpoint (race), *Start-finish gantry* (race), *Overview* and *Top (ortho)*. |
| Library (instance sources) | Excluded from the view layer. One `PROP <name>` collection per prop model. Edit one and every instance updates. |

Look: every material runs through the node group **LowRange Toon**, which gives stepped 3-band
lighting with a warm mauve shade (`src/gfx/toon.js`) and the 90 to 330 m golden fog. Change it once
and the whole world follows. Objects (not the terrain or tufts) get inverted-hull outlines in `#2a1a14`. Renders are
480 x 270, and the stills are upscaled 4x with hard pixels. A 1-pixel Freestyle outline line set is
already configured but turned **off**: over the whole map it ran past 15 GB of memory. Turn it on
(Render > Freestyle, or pass `--freestyle` to the build) only for close-up shots. The rendered viewport uses 4 px preview pixels. Textures are packed.

### What flows back into the game, and what doesn't

- **Prop and vehicle models do flow back, but only through `public/models`.** The game loads
  `public/models/*.glb` and `public/models/vehicles/*.glb`. To change a prop or vehicle, edit its
  source build script or blend (see `tools/blender/`), re-export the `.glb`, then regenerate the
  world. Editing the imported copies in `world_<map>.blend` changes nothing in the game.
- **Terrain, rocks, paths, placements, signs and markers do NOT flow back.** They are generated by the game's
  code (`src/maps/*.js`, `src/art/dressing.js`, `src/world_view.js`, `src/race_view.js`). Sculpting the
  terrain or moving a tree in Blender is useful for mock-ups and paint-overs only. To make a change
  real, change the code, then regenerate.

### Known differences from the game

- Ground far away: the game fades distant ground to each surface's flat average colour, so it
  doesn't shimmer. Blender keeps the pixel tile at every distance, so far ground looks noisier.
- Ragged borders between surfaces use Blender noise, which is similar to the game's shader
  noise but not identical.
- Per-instance colour tints on bushes and tufts are not applied. Race spectators and posts keep
  theirs. Text on signs uses Blender's default font, not the game's canvas text.
- Outlines: the game draws a 1-pixel line wherever depth or material changes on screen. The hull
  outlines here are 2 to 4 cm thick, so they show up close but disappear in distant and overview shots.
- The sky is a flat haze colour, not the game's dithered bands. There are no particles, dust or HUD.
