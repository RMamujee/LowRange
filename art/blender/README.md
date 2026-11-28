# Blender sources

- `loading_screen.blend`: the loading screen's studio shots (this section). Built from the vehicle `.glb`
  files, which have not changed since it was made, so it is current.
- `world_park.blend`, `world_race.blend`, `world_crawl.blend`, `world_jungle.blend`, `world_desert.blend`:
  the five game maps (see *LowRange in Blender: the world files* below).

# Loading screen art (`loading_screen.blend`)

Studio shots: each vehicle posed on simple blocks so the suspension visibly flexes.
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

# LowRange in Blender: the world files

## World files: `world_park.blend`, `world_race.blend`, `world_crawl.blend`, `world_jungle.blend`, `world_desert.blend`

The game's five maps in Blender, in the game's pixel-art look, for review and art direction. Each file
has one scene, `LowRange <map name>`, with the same collections, and opens looking through its
*Overview* camera in Material Preview (lit by the scene's sun and sky).

| File | Map | Size | Objects | Instances | Terrain | Cameras |
|---|---|---|---|---|---|---|
| `world_park.blend` | Trail Park (`park`) | 10.2 MB | 2588 | 7931 | 401 x 401 at 1 m | 8 |
| `world_race.blend` | Race Track (`race`) | 9.3 MB | 1693 | 9476 | 401 x 401 at 1 m | 10 |
| `world_crawl.blend` | The Gauntlet and its three side courses (`crawl`) | 11.2 MB | 3573 | 7748 | 401 x 401 at 1 m | 19 |
| `world_jungle.blend` | Coralume Island (`jungle`) | 21.4 MB | 1475 | 25553 | 1025 x 1025 at 1 m, decimated to 300k vertices | 12 |
| `world_desert.blend` | Sunfall Basin (`desert`) | 18.5 MB | 1944 | 5098 | 601 x 601 at 2 m, decimated to 300k vertices | 11 |

"Instances" counts collection instances and geometry-node instances (plants, tufts, posts, crowd).

### Regenerate (whenever the game's maps, props or vehicles change)

Once per checkout: `npm ci --omit=dev --ignore-scripts` (the exporter needs `three`). Then, for one map:

```
node tools/export/export_world.mjs park
"C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --factory-startup --python tools/blender/world/build_world.py -- park
```

and the same with `race`, `crawl`, `jungle` or `desert`. `node tools/export/export_world.mjs all` exports
all five. Build times on this laptop: 15 to 75 s per file, plus 1 to 2 minutes of preview renders.

- The exporter imports the game's own modules and runs the same view builders `main.js` runs, headless:
  `src/terrain.js` and `src/maps/*`, `src/world_view.js` (terrain, dressing, markers, distant ranges),
  `src/race_view.js`, `src/crawl_view.js`, `src/art/jungle/view.js` (sea, creek, jungle, structures),
  `src/desert/view.js` (desert plants, camp, signs, dune shading), `src/gfx/*` (ground tiles, ground
  lookup grid, shading normals, palette, toon bands) and `src/spawns.js` (the spawn list). So every
  placement, rock, plant, sign, structure and ground cell is what the game builds. Sign faces are the
  game's own pixel-font canvases (a small software canvas stands in for the browser's), saved as PNGs.
  Output goes to `tools/blender/world/export/<map>/` (gitignored). Nothing under `src/` or `public/` is
  written.
- The Blender script rebuilds the `.blend` from scratch (saved through `tools/blender/blend_save.py`, so no
  local path is stored) and renders preview stills to `docs/previews/world_<map>_<camera>.png`. Add
  `--no-render` after the map id to skip the stills, `LR_CAMS=Overview,Trailhead` to render only some
  cameras, `LR_ALL_CAMS=1` to render every camera (by default the cameras marked `preview` render).
  `LR_TERRAIN_MAX_VERTS` (default 300000) sets where terrain decimation starts.
- Always pass `--factory-startup`: without it Blender loads your own add-ons (including the MCP add-on)
  into the background process.
- Rebuilding **overwrites** `world_<map>.blend`. Save your own changes to another file.
- How stale is a file? With a fresh export, run the comparison on the file (read-only, it never saves):

  ```
  "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --factory-startup art/blender/world_park.blend --python tools/blender/world/compare_world.py -- park
  ```

  It reports terrain height changes at every vertex, changed gameplay surfaces, paths, rocks, prop
  placements, signs and gameplay points.

### What's inside (every file)

| Collection | Contents |
|---|---|
| Terrain | The heightfield with the game's visual heights. Its material rebuilds the game's ground: a pixel tile per surface (32 px/m, Closest) chosen by the game's own ground lookup grid (shown surface, trail tread, slow tone drift, ruts and churned mud), ragged pixel-stepped borders, tiles projected from the side on steep faces, the soft 3-step ground toon ramp, and the game's shading normals (and the desert's painted dune light) read from grid textures. Face attribute `surface` holds the shown surface id. *Distant ranges*: the game's backdrop rings, plus a flat ground ring between the map edge and them (Blender only, so overviews don't show sky under the corners). Coralume Island has no ranges: its sea runs to the horizon. |
| Water | Coralume Island's sea (depth-stepped colour and transparency, foam band), creek, plunge pool and falls; The Gauntlet's ford and the race track's splash. |
| Paths | Roads, tracks, trails, the Gauntlet's bypass and spurs, side-course access tracks, side courses, the race track and Ember Creek as named curves, tagged with kind, surface, difficulty, width and length (viewport only, hidden in renders). |
| Rocks | Every gameplay rock with the game's exact convex hull and lit-top tone, boulder tile (desert: the arch and hoodoos are rocks too). |
| Trees, Props | glTF props from `public/models` as **collection instances** of the models in *Library* (Trail Park, Race Track, Gauntlet). Procedural plants and scatter (jungle palms, broadleaf and emergent trees, ferns, bananas, hibiscus; desert cacti, yuccas, snags, shrubs, barrel cacti, tumbleweed, sand grass; flowering tufts, stones) as **geometry-node instances** of one source mesh each (in *Library / PROC procedural parts*), per-instance tints kept. The race venue (barriers, tyre walls, stands, crowd, paddock). |
| Structures | Coralume Island: bridge decks and pilings, the Palm Cove dock, guard rails, stilt huts, the summit lookout, the lighthouse, road paint. Sunfall Basin: the camp (shack, canopy and pumps, water tank, trailer, fence). |
| Markers | Signposts and gate arches with the game's sign faces, trail / road / course marker posts, checkpoint arches, gantry and start line, the summit flag and cairn. *Gameplay points*: named empties for the spawn, trailhead, trail gates, Gauntlet stage gates, side-course gates, checkpoints, named places and landmarks. *Spawn points*: one arrow empty per entry of the game's spawn list (J menu), pointing the way the truck faces. |
| Vehicles | `public/models/vehicles/*.glb`, parked side by side at the spawn, wheels at their `Marker_Wheel*` (left side mirrored, as in the game). |
| Lights & Cameras | Sun (game direction and colour), the stepped sky (world), cameras: *Trailhead* / *Race grid*, each trail start, Gauntlet stages and side courses, checkpoints, landmarks (bridge, dock, falls, lighthouse, summit, arch, hoodoos, dunes, camp), *Overview* and *Top (ortho)*. |
| Library (instance sources) | Excluded from the view layer. One `PROP <name>` collection per prop model, and the procedural part sources. Edit one and every instance updates. |

Collections a map has no content for (Water, Structures) are left out of that file.

Look: every material runs through the node group **LowRange Toon**: stepped 3-band light with the game's
warm mauve shade (`src/gfx/toon.js`; the colours are read from the game at export), the ground's soft
3-step ramp, and the game's capped aerial perspective (smoothstep fog over the map's own range, 35%
desaturation, at most 45% haze). Change it once and the whole world follows. Objects (not the terrain,
water or tufts) get inverted-hull outlines in `#2a1a14`. Renders are 480 x 270, upscaled 4x with hard
pixels for the stills. A 1-pixel Freestyle line set is configured but **off** (over a whole map it runs
out of memory); turn it on (Render > Freestyle, or `--freestyle`) only for close-ups. Textures are packed.

### What flows back into the game, and what doesn't

- **Prop and vehicle models do flow back, but only through `public/models`.** The game loads
  `public/models/*.glb` and `public/models/vehicles/*.glb`, built by the scripts in `tools/blender/`
  (`build_props.py`, `build_lc70_v2.py`, `build_taco.py`, `build_wrx.py`). Checked 2026-11-27 by running
  them into a scratch copy: they still reproduce the committed `.glb` files (the props and the rally
  sedan byte for byte, the wagon and the pickup with identical geometry and only the triangle order
  different) and their `docs/previews/<id>_*.png` byte for byte. Editing the imported copies in
  `world_<map>.blend` changes nothing in the game.
- **Terrain, rocks, paths, placements, structures, signs and markers do NOT flow back.** They are generated
  by the game's code (`src/maps/*.js`, `src/art/*`, `src/desert/*`, the view modules). Sculpting the terrain
  or moving a tree in Blender is for mock-ups and paint-overs only. To make a change real, change the code,
  then regenerate.

### Known differences from the game

- Coralume Island's and Sunfall Basin's terrain meshes are decimated (collapse, about 300k vertices each,
  to keep the files under 25 MB); the surface lookup, normals and dune light still come from the full grid.
  Thin features such as the creek channel and the Ember Stairs steps are softer in the geometry than in the
  game.
- Far ground: the game steps each tile to coarser hand-made levels and finally to a flat colour with
  distance; Blender keeps the full tile, so far ground is noisier. Grass has no darker painted rim.
- Ragged surface borders use Blender noise, close to the game's shader noise but not identical; the game's
  four-vertex surface vote is a nearest-vertex lookup here.
- The procedural props' world-space pixel detail (`pixelDetail`) and the world grade (`markWorld`) are not
  applied. Water has no drifting glints. Bogs show the shown mud surface, not the deformable mud mesh.
- Outlines: the game draws a 1-pixel line at depth and material breaks; the hull outlines here are 2 to 4 cm
  thick, so they show close up and vanish in overviews.
- No particles, dust, tyre marks, mud on the trucks or HUD. Vegetation density follows the game's default
  graphics preset (High), so Coralume Island has its full undergrowth.
