# Art assets: how the game loads glTF models

The modelling contract (names, units, axes, pivots, markers, budgets) is **docs/MODELING_SPEC.md**.
This page only describes what the code does with the files.

## Discovery

- Drop `.glb` files in `public/models/` (props) or `public/models/vehicles/` (vehicles). No manifest.
- A small Vite plugin in `vite.config.js` lists them as the virtual module `virtual:lowrange-models`,
  so only files that exist are fetched (no 404s). In dev, refresh the browser after adding a model.
- `src/art/assets.js` loads them all at import time (top-level await, browser only) with `GLTFLoader`.
  A file that fails to load logs a warning and falls back to procedural art. Headless (Node tests) loads nothing.
- Imported textures get nearest-neighbour magnification so pixel art stays crisp.

## Props (`src/art/dressing.js`, `src/art/props.js`)

| File(s) | Used for | Placement scale |
|---|---|---|
| `tree_round[_a/_b/_c].glb` | deciduous trees on the physics tree positions | authored size x tree scale (0.7-1.5) |
| `tree_pine[_x].glb` | pines on the physics tree positions | same |
| `bush[_x].glb`, `bush_flower[_x].glb` | bushes / flowering bushes | x0.8-1.5 |
| `grass_tuft[_x].glb` | plain grass tufts (thousands, instanced) | x0.85-1.7 |
| `rock_small/medium/large[_x].glb` | decorative stones only (trail rocks stay procedural) | x0.75-1.25 |
| `fence_segment[_x].glb` | split-rail fences near the trailhead; segments chained from the left-post origin, stretched along X to the post spacing (~2 m) and tilted to follow the slope | |
| `signpost[_x].glb` | the wooden fingerposts round the trailhead | x1 |
| `log[_x].glb`, `stump[_x].glb` | logs and stumps | x0.85-1.25 / x0.7-1.3 |

Every variant found is used round-robin. All props are instanced in 100 m chunks (frustum culling),
use the asset's first material per mesh, and have no colliders (trees keep the colliders made in terrain.js).
Origin = base centre on the ground, Y up.

## Vehicles (`src/vehicle_view.js`, `useVehicleAsset`)

`public/models/vehicles/<id>.glb`, visuals only (physics unchanged, markers/extras not read yet):

- `Body` replaces the procedural body; its meshes become the dentable shell (subdivide panels).
- `Wheel` replaces each procedural wheel, mirrored (scale.x = -1) on the left side; spin axis X.
- `AxleFront` / `AxleRear` replace the procedural axle housings on solid-axle rigs.
- `Hub` (optional) replaces the brake disc / knuckle on each corner (mirrored on the left).
- A material named `TailLight` glows when braking.
- Node transforms are reset to the pivot: each part's origin must be where the spec says (chassis centre,
  hub centre, axle centre). Suspension links, springs and shafts stay procedural.
