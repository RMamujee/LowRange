# LowRange art style contract

Target: the reference concept image (kept outside the repo)
translated into real 3D. Cozy farm-sim pixel art: warm, saturated, chunky, friendly. Every asset and the
in-game renderer follow this file so separately built pieces match.

## Look

- **Form:** real 3D with rounded, slightly chunky proportions (soft bevels, puffy canopies, rounded boulders). Not flat boxes, not sprites.
- **Surface:** hand-pixelled textures at **32 texture pixels per metre**, nearest-neighbour sampling, no mipmap blur. Texture detail carries the pixel-art feel: 3 to 4 tone ramps per material (highlight, base, shade, deep shade) placed deliberately (lighter tops, darker undersides, panel lines, rivets, tread blocks), plus sparse dither. Avoid uniform random noise.
- **Light:** stepped (2 to 3 band) toon lighting. Shadows are warm and hue-shifted (towards purple-brown), never grey or black.
- **Outline:** a warm line on every object's silhouette, about 2 to 3 cm: the surface's own colour taken well down and half way to the outline brown (`#2a1a14`), not near-black. Lighter on ground ridges, fading out with distance.
- **Frame:** default **HD 1x**: native resolution, geometry edges anti-aliased (4x MSAA), every pixel-art texture kept at the Fine 2x texel size (HD-2D: smooth silhouettes, chunky hard texels). The Fine 2x / 3x / Chunky 4x pixel sizes render low-res and upscale with hard pixels: every game pixel an exact block of device pixels, never resampled by the browser.
- **Sky and distance:** a clear sky (warm cream horizon stepping up into soft blue) and light aerial perspective: far ground leans towards the horizon haze but never more than about half way, so distant hills keep their colour instead of washing out to beige.
- **Comfort (eye strain):** big areas sit back, small things pop. Ground and world props are a step calmer in saturation and value than the vehicles, lamps and flowers; no large area may be bright and strongly saturated at once (aim: under 5% of the frame at V > 0.75 and S > 0.55). Saturation drains with distance before any haze. Display grade looks Soft (default) / Standard / Vivid. Rationale and measurements: `docs/reviews/GRAPHICS_RESEARCH.md`.
- **Effects and mud are the exception to "chunky":** they aim for physical believability and fine grain inside the palette. Particles are never squares and never outlined: mud, water and grit are many small irregular lumps and flecks (1-8 cm, a few bigger clods), streaked along their motion, lit from above in two toon steps; dust, smoke and mist are soft, semi-transparent, noisy puffs that grow, drift and thin out, tinted from the ground's own ramp lifted towards the haze. Nothing is drawn smaller than about 1.5 game pixels, so effects stay grains at every Pixel size. The bogs are a smooth, deformable surface (ruts, berms, dug holes) rather than flat tiles: wet-dark fresh ruts, sparse stepped glints instead of specular, a faint 32 px/m grain so the mud still reads as pixel-art ground. Mud caked on a truck is blotches on the same 32 px/m lattice.
- **No brand names, logos, badges or readable plate text** anywhere. Generic grilles and original liveries only.

## Palette (sRGB hex; each row is highlight, base, shade, deep shade)

| Material | Ramp |
|---|---|
| Dirt / trail | `#dcb074` `#ca9757` `#ab7b45` `#815d36` (the reference's golden ochre, kept warm but a step darker and calmer for comfort: the screen's biggest area) |
| Grass | `#9fc865` `#77a846` `#588d39` `#3d6c30` (warm meadow green, less lime) |
| Leaf canopy | `#7cc843` `#4fa032` `#2f7d2c` `#1f5a27` |
| Pine | `#4f9f4a` `#2f7f3f` `#1f6236` `#164a2e` |
| Bark / wood | `#c98a4e` `#a5683a` `#7d4a2a` `#55301f` |
| Rock (trail rock, cliff bands) | `#c2b296` `#a29278` `#80725e` `#5e5446` (warm sandstone slab) |
| Boulder (gameplay rocks, stones) | `#b5a29c` `#917c78` `#6f5d5c` `#4f4146` (cooler mauve-grey, as the Blender props, so boulders stand off the slab) |
| Rally blue | `#4f7fe8` `#2f58c8` `#2140a0` `#172d74` |
| Olive (pickup) | `#a8a56a` `#8a8650` `#6b683c` `#4c4a2c` |
| Cream (wagon) | `#f6eed8` `#e6dcc0` `#c9bd9c` `#a2977a` |
| Black trim / tyre | `#4a4640` `#33302c` `#24211e` `#161412` |
| Glass | `#7fa6c4` `#3f5f7a` `#2a4258` `#1c2d3e` |
| Gold (wheels, livery) | `#ffd866` `#e6b23a` `#b9862a` `#86601f` |
| Lamp | `#fff6cf` `#ffe08a`; amber `#ffb347`; tail red `#e0453a` |
| Flowers | pink `#f7a8c4`, white `#fff4e6`, yellow `#ffd95a` |

## Export rules (glTF, see also `docs/MODELING_SPEC.md`)

- Materials are plain **Principled BSDF with the pixel texture in Base Color** (image node set to Closest, texture embedded). Toon bands, outlines and pixelation are applied by the game renderer, so do not bake lighting bands into textures beyond gentle painted shading, and do not export outline shells.
- Roughness 1, metallic 0, except glass (roughness 0.2) and lamps (emission). Brake lights use a material named `TailLight`.
- One small atlas or a few small textures per asset (64 to 256 px). UVs laid out so texels stay square at about 32 px/m.
- Blender previews of an asset should use the toon + outline + low-res look so it can be judged against the reference.

## In-game renderer (`src/gfx/`)

- `pipeline.js`: the scene renders at a low internal resolution set by the **Pixel size** setting (F10: Chunky 4x, 3x, Fine 2x, HD 1x: device pixels per game pixel on a 1080-tall screen, in proportion on others; default HD 1x, which keeps the Fine 2x texel size through a mip bias, `pixeltex.js TEX_BIAS`), is outlined at that resolution and blown up by a whole number with hard pixels. The drawing buffer is sized to the canvas's exact device pixels (device-pixel-content-box ResizeObserver, `image-rendering: pixelated`), so browser zoom or Windows display scaling never resamples the frame. Sky is drawn there too (stepped, dithered bands).
- `toon.js`: every `MeshStandardMaterial` (glTF included) is patched once, globally: three warm bands from the real light and shadow, undersides a touch darker, specular dropped, emissive kept, fog drains saturation then leans towards the haze (capped, `FOG_MAX`). Materials marked world (`markWorld`, everything built before the vehicle in `main.js`, minus flowers) are graded back a little (`uWorldGrade`) and their textures move part way to a coarser mip (`uTexCalm`, less speckle, each texel still crisp). Texture maps are switched to one-mip nearest sampling (`NearestMipmapNearest`). Nothing to do per asset.
- Outlines come from depth breaks and from **material changes**: each opaque material gets its own outline id, so separate materials on one model (body / glass / tyre) get a dark line where they meet. Use separate materials where you want a line, one material where you don't. A material can opt out with `material.userData.outlineId = 0`.
- Metallic must stay 0 (the toon pass reads diffuse light; a fully metallic surface would sit in the shade band).
- Untextured vertex-coloured props can opt into a world-space pixel texture with `material.userData.pixelDetail = true` (the procedural dressing does); textured materials never get it.
- Ground tiles are generated in `pixeltex.js` from the ramps above (one per surface material, 32 px/m). Eye comfort first: like the Blender props, a tile is mostly one flat ramp colour with broad half-step tone areas and sparse deliberate marks; no salt-and-pepper speckle. Each tile also has hand-made coarser levels (majority vote over 2x2 blocks, so only real palette colours survive: no box-averaged blur) and a flat dominant colour; the shader steps to a coarser level before texels shrink below about 1.15 screen pixels, so distant ground is calmer, coarser pixel art rather than a blurred copy, and never crawls.
- `terrain_look.js`: on roads, trails and the race track the ground shows the gameplay material grid exactly (what the tyres grip); off the paths it shows a calm visual surface (large grass / dirt areas, rock only as outcrops and cliff bands on the steepest ground). Borders are wobbly, pixel-stepped on a fixed world lattice, and grass gets a darker painted rim. Terrain lighting uses softened normals and a soft 3-step ramp so bands follow the big shape of hills.
- Tyre effects (`src/fx/tyre_fx.js`) are two instanced draws on the no-outline layer: solid lumps (alpha-tested irregular blobs, alpha 0 = "any" outline id) and soft puffs (alpha-blended, faded near the camera and where they meet the ground). The mud surface (`src/fx/mud_view.js`) shares the ground's outline id so no line is drawn where it meets the terrain; the truck's mud coat (`src/fx/mud_coat.js`) is applied inside the toon patch for materials marked `userData.mudCoat`.
- Small scatter (tufts, flowers, stones, bushes) thins out with distance by size (`world_view.js` + `toon.js` fade, chunks culled past it), so nothing is drawn once it would be only two or three pixels big.
- Outlines are a coloured line near the camera (two pixels thick within about 24 m at Fine 2x, 90 m at HD 1x, the inner pixel lighter), fade out with distance (terrain ridges sooner and lighter than objects), and 1-pixel-thin features (racks, rails, posts) get only a light darkening so their frame-to-frame popping stays a small tone change. The pipeline ends with the display grade (brightness, contrast, saturation, soft shoulder, black lift, vignette; settings Picture looks and sliders), shared with the garage preview. The shadow camera is snapped to whole shadow texels so shadow edges hold still while driving.
