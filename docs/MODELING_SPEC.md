# LowRange modelling spec (for the Blender session)

This is the contract between the Blender modelling work and the game code. Read it fully before modelling.
The game is a physics sim: the trucks are driven by invisible rigid bodies (chassis box, axles, round
wheels) and the models are drawn on top of them. Models can change shape and proportions freely,
**as long as they carry the markers below so the game can read their dimensions**.

> Art direction: cozy pixel-textured 3D, matching the reference concept image
> (`Version 1 Stardew valley offroad art.png`): warm ochre dirt, saturated greens, chunky rounded shapes,
> crisp low-res textures. Vehicles are *styled after* a Tacoma-style pickup, a 70-series-style wagon
> and a WRX-style rally car. **No brand names, logos, badges or licence-plate text anywhere** (the
> reference shows some; leave them out or use generic shapes).

---

## 1. Units, axes, export

| Rule | Value |
|---|---|
| Format | glTF 2.0 binary, `.glb` (Blender: File > Export > glTF 2.0, format "glTF Binary") |
| Units | metres (Blender unit scale 1.0). Build at real size. |
| Up axis | Export with **+Y Up** on (the default). In Blender you model Z-up as normal. |
| Vehicle forward | **Faces +Y in Blender**, so it exports as **-Z forward** in the game. Right side = +X. |
| Transforms | Apply all (Ctrl+A > All Transforms) before export. No negative scales. |
| Modifiers | Apply on export; triangulation is fine. |
| Textures | Small (64–256 px) PNG, embedded in the `.glb`. Set image nodes to **Closest** interpolation so pixels stay crisp. A shared palette across all assets is ideal. |
| Materials | Principled BSDF, base colour (+ optional emission for lights). Roughness high, metallic 0 for the pixel look. |

Files go in the repo under `public/models/` (see section 5 for names). Do **not** edit anything in `src/`;
the code side picks the files up.

---

## 2. Vehicles: one `.glb` per vehicle, with named parts and markers

File: `public/models/vehicles/<id>.glb`, where `<id>` is `taco`, `lc70`, `wrx`, `goat` or `mule`.

### 2a. Required objects (names must match exactly)

| Object | What it is | Origin / pivot |
|---|---|---|
| `Body` | Everything that rides on the chassis: body, cab, bed, bumpers, lights, roof rack, frame rails. May have child meshes. | At the **chassis centre**: x = 0 (centreline), y = 0 (midway between the axles), height = see "ride height" below. |
| `Wheel` | **One** wheel + tyre, used four times (mirrored for the left side by the game). | At the **hub centre**. Axle (spin axis) along **X**. |
| `AxleFront`, `AxleRear` | Solid-axle housings incl. diff pumpkin (only for solid-axle rigs; see table). | At the axle centre (on the centreline, at wheel-centre height). |
| `Hub` *(optional)* | Brake disc/caliper/knuckle; turns with steering but does not spin. | At the hub centre. |
| `Marker_WheelFL`, `Marker_WheelFR`, `Marker_WheelRL`, `Marker_WheelRR` | **Empties** placed exactly at each wheel's hub centre, with the vehicle at rest on flat ground (normal ride height). | — |
| `Marker_Ground` | An empty at ground level directly under the chassis centre (x = 0, y = 0, z = ground). | — |

Leave suspension links, coil springs, shocks, wishbones, driveshafts and tie rods **out**. The game draws
and animates them procedurally between the chassis and the moving axles, so they flex correctly.
(Brackets and mounts welded to the body or frame can stay in `Body`.)

### 2b. Required custom properties (Object Properties > Custom Properties, on `Wheel`)

| Property | Meaning |
|---|---|
| `tyre_radius` | Outer tyre radius in metres (centre to tread). |
| `tyre_width` | Tyre section width in metres. |

The game reads the markers and properties and **derives the physics from the model**: track and
wheelbase from the wheel markers, ride height from `Marker_WheelFL` minus `Marker_Ground`, tyre size from
the properties, and collision boxes from the `Body` bounds. After a model changes size, the code side
retunes gearing and springs and reruns the test suite. So **proportions are yours to change**: chunkier
tyres, shorter overhangs, taller cabs are all fine. Just keep the markers truthful.

### 2c. Practical constraints (these keep the physics sane)

- **Wheel arches must clear the tyre at full bump.** Leave at least `bump + 0.06 m` of space above the tyre top at rest,
  and about 0.05 m at the sides (the front wheels also steer up to ~0.6 rad, about 34°, so the front arches need
  room for a turned tyre).
- **The underside sets ground clearance.** The lowest point of `Body` is the chassis' belly: it will hit
  rocks. Keep it at or above the current "frame bottom" height unless a lower body is intended.
- **Collision is boxes.** The game approximates `Body` with up to three boxes (lower body, cab, bed/rear).
  Big thin protrusions (snorkels, mirrors, light bars, antennas) are drawn but do not collide, which is fine.
- **Body panels need some vertices for dents.** Crash damage dents the body by pushing vertices.
  Subdivide large flat panels to roughly a 0.25 m grid, or dents won't show.
- **Glass and lights** as separate materials (lights can glow; the brake light material must be named
  `TailLight` so the game can light it up when braking).

### 2d. Current physics targets (starting point; you may deviate, see 2b)

Measured from the game today. The "frame bottom" is the lowest point of the chassis at rest.

| id | Style | Suspension | Tyre radius / width | Track | Wheelbase | Ride height (hub above ground = tyre radius) | Chassis centre above ground | Frame bottom above ground | Body envelope (L × W × roof height) | Bump / droop travel |
|---|---|---|---|---|---|---|---|---|---|---|
| `taco` | lifted Tacoma-style double-cab pickup | IFS front, solid rear axle (leaf springs look) | 0.465 / 0.32 | 1.62 | 3.24 | 0.465 | 0.83 | 0.53 | 5.35 × 1.85 × 2.08 | 0.12 / 0.16 |
| `lc70` | 70-series-style 4-door wagon | solid axles both ends | 0.455 / 0.30 | 1.56 | 2.73 | 0.455 | 0.86 | 0.53 | 4.90 × 1.80 × 2.42 | 0.13 / 0.18 |
| `wrx` | WRX-style rally sedan | independent all round (struts) | 0.33 / 0.21 | 1.52 | 2.62 | 0.33 | 0.59 | 0.39 | 4.40 × 1.70 × 1.69 | 0.11 / 0.12 |
| `goat` | tube-chassis rock buggy | solid axles both ends | 0.51 / 0.38 | 1.78 | 2.75 | 0.51 | 0.89 | 0.64 | 3.40 × 1.50 × 2.24 | 0.16 / 0.26 |
| `mule` | expedition truck with camper box | solid axles both ends | 0.60 / 0.45 | 2.00 | 3.90 | 0.60 | 1.10 | 0.65 | 6.40 × 2.10 × 2.85 | 0.15 / 0.20 |

Track = distance between the left and right wheel centres. Wheelbase = front-to-rear wheel-centre distance.
Solid-axle rigs need `AxleFront` and/or `AxleRear`: `taco` needs only `AxleRear`; `wrx` needs neither.

### 2e. Budgets

| Part | Triangles (max) |
|---|---|
| Vehicle `Body` | 15,000 |
| `Wheel` | 1,500 |
| Axle | 800 |

---

## 3. Props (decoration and obstacles)

Origin at the **base centre, on the ground**. Facing doesn't matter except for fences and signposts (long axis
along X). Multiple variants are welcome: add `_a`, `_b`, `_c` suffixes (e.g. `tree_round_a.glb`).

| File (`public/models/…`) | Size guide | Triangles (max) | Notes |
|---|---|---|---|
| `tree_round.glb` | 5–7 m tall, canopy ~4 m wide | 1,500 | Bushy deciduous, chunky clustered canopy, thick trunk. The game adds a 0.22 m-radius trunk collider. |
| `tree_pine.glb` | 6–9 m tall | 1,200 | Layered pine. |
| `bush.glb`, `bush_flower.glb` | 0.8–1.5 m | 600 | Pink/white flower specks on the flower variant. No collision. |
| `grass_tuft.glb` | 0.2–0.4 m | 80 | Scattered by the thousand (instanced), keep it tiny. |
| `rock_small.glb`, `rock_medium.glb`, `rock_large.glb` | ~0.5 / 1.2 / 2.5 m | 400 | **Decoration only.** The rocks you drive on in trails are generated in code, because their exact shape sets the trail difficulty. Chunky and rounded, with a light top and dark base. |
| `fence_segment.glb` | 2.0 m long along X, ~1.0 m tall | 300 | Origin at the base of the left post, so segments chain end to end. |
| `signpost.glb` | ~2.2 m tall | 300 | Leave the board face blank: the game prints trail names on it. |
| `log.glb` | ~3 m long along X | 300 | |
| `stump.glb` | ~0.6 m tall | 200 | |

---

## 4. Sanity checks before committing

1. Vehicles: in Blender, at rest the tyre bottoms touch `Marker_Ground`'s height, and the wheel markers sit at the hub centres.
2. Scale: a 0.465 m-radius tyre is 0.93 m tall; a person is ~1.75 m. Drop in a 1.75 m reference cube if unsure.
3. Export check: open the `.glb` in Blender again (File > Import) or <https://gltf-viewer.donmccurdy.com/>, confirm the orientation (front towards -Z, Y up), the names and the custom properties (exported as `extras`; tick "Custom Properties" in the glTF export options).

## 5. Handing over

- Put the files in `public/models/` (vehicles in `public/models/vehicles/`), then commit and push them on a branch named
  `models/<what>` (e.g. `models/lc70`) and open a pull request, or tell the main session where they are.
- Don't modify `src/`. The code session wires models in, derives physics from the markers, retunes and runs:
  `node test/brake.mjs`, `node test/damage.mjs`, `node test/trails.mjs goat,lc70,taco 240`, plus screenshots.
- If a model needs a physics change you care about (e.g. "the lc70 should sit 10 cm higher"), say so in the PR
  description: the markers carry the numbers, and the code side makes it drive right.
