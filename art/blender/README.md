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

Save the .blend after editing (packed textures; `File > External Data > Pack Resources` if you add images).

## Rebuilding from scratch

`tools/blender/build_loading.py` rebuilds the whole file from `public/models/vehicles/*.glb` (use it after a
vehicle model changes). **It overwrites `loading_screen.blend`**, so move hand edits into the `SHOTS` table at the
top of that script first, or re-apply them after.

```
"C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --python tools/blender/build_loading.py
```

A new scene for another vehicle = one more entry in `SHOTS` and a matching `<id>.glb`; also add the id to
`SHOTS` in `src/ui/loading.js`.
