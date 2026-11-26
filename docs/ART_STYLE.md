# LowRange art style contract

Target: the reference concept image (kept outside the repo)
translated into real 3D. Cozy farm-sim pixel art: warm, saturated, chunky, friendly. Every asset and the
in-game renderer follow this file so separately built pieces match.

## Look

- **Form:** real 3D with rounded, slightly chunky proportions (soft bevels, puffy canopies, rounded boulders). Not flat boxes, not sprites.
- **Surface:** hand-pixelled textures at **32 texture pixels per metre**, nearest-neighbour sampling, no mipmap blur. Texture detail carries the pixel-art feel: 3 to 4 tone ramps per material (highlight, base, shade, deep shade) placed deliberately (lighter tops, darker undersides, panel lines, rivets, tread blocks), plus sparse dither. Avoid uniform random noise.
- **Light:** stepped (2 to 3 band) toon lighting. Shadows are warm and hue-shifted (towards purple-brown), never grey or black.
- **Outline:** dark warm outline (`#2a1a14`), about 2 to 3 cm, on every object's silhouette.
- **Frame:** the game renders at a low internal resolution and upscales with hard pixels.
- **No brand names, logos, badges or readable plate text** anywhere. Generic grilles and original liveries only.

## Palette (sRGB hex; each row is highlight, base, shade, deep shade)

| Material | Ramp |
|---|---|
| Dirt / trail | `#ecc77e` `#d9aa5e` `#bd8c4e` `#91693f` (softened from `#e0a440` base: less glare) |
| Grass | `#94c95c` `#67a641` `#488a36` `#316a2e` (a touch less lime than the canopies) |
| Leaf canopy | `#7cc843` `#4fa032` `#2f7d2c` `#1f5a27` |
| Pine | `#4f9f4a` `#2f7f3f` `#1f6236` `#164a2e` |
| Bark / wood | `#c98a4e` `#a5683a` `#7d4a2a` `#55301f` |
| Rock | `#b7aa98` `#948775` `#73685c` `#544b45` |
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

- `pipeline.js`: the scene renders at about 300 px tall (settings `pixelHeight`: low 225, medium 300, high 360), is outlined at that resolution and blown up by a whole number with hard pixels. Sky is drawn there too (stepped, dithered golden bands).
- `toon.js`: every `MeshStandardMaterial` (glTF included) is patched once, globally: three warm bands from the real light and shadow, undersides a touch darker, specular dropped, emissive kept. Nothing to do per asset.
- Outlines come from depth breaks and from **material changes**: each opaque material gets its own outline id, so separate materials on one model (body / glass / tyre) get a dark line where they meet. Use separate materials where you want a line, one material where you don't. A material can opt out with `material.userData.outlineId = 0`.
- Metallic must stay 0 (the toon pass reads diffuse light; a fully metallic surface would sit in the shade band).
- Untextured vertex-coloured props can opt into a world-space pixel texture with `material.userData.pixelDetail = true` (the procedural dressing does); textured materials never get it.
- Ground tiles are generated in `pixeltex.js` from the ramps above (one per surface material, 32 px/m). Eye comfort first: like the Blender props, a tile is mostly one flat ramp colour with broad half-step tone areas and sparse deliberate marks; no salt-and-pepper speckle. Texels never get smaller than about 1.5 screen pixels (whole mip steps), so the ground never crawls.
- `terrain_look.js`: on roads, trails and the race track the ground shows the gameplay material grid exactly (what the tyres grip); off the paths it shows a calm visual surface (large grass / dirt areas, rock only as outcrops and cliff bands on the steepest ground). Borders are wobbly, pixel-stepped on a fixed world lattice, and grass gets a darker painted rim. Terrain lighting uses softened normals and a soft 3-step ramp so bands follow the big shape of hills.
- Outlines fade out with distance (terrain ridges sooner than objects), and 1-pixel-thin features (racks, rails, posts) get only a light darkening so their frame-to-frame popping stays a small tone change. The shadow camera is snapped to whole shadow texels so shadow edges hold still while driving.
