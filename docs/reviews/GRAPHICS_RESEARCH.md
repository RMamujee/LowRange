# Graphics research: clean, HD and restful, but still cozy pixel art

Written for the "slightly hard on the eyes, maybe too bright or too contrasted" feedback (Nov 2026).
Goal: a high-definition, clean picture that still reads as Stardew-style pixel art, and that is
comfortable to look at for hours.

## Method

- **Real screenshots, measured.** 55 official store screenshots were fetched from the Steam store
  API (`store.steampowered.com/api/appdetails?appids=...&filters=screenshots`) for Stardew Valley,
  Sea of Stars, Eastward, Octopath Traveler, Triangle Strategy, A Short Hike, Tunic, Alba, Lonely
  Mountains: Downhill, Art of Rally and Dinkum. The ones that are daytime outdoor gameplay with
  little UI were kept (1 to 4 per game). Interiors, battle UIs and menus were left out. These are
  curated marketing shots, so they are a best-case version of each game.
- **Not on Steam, so not measured:** Zelda: Link's Awakening (2019) and Animal Crossing. They are
  discussed from knowledge only.
- **The same metric on every image** (`py tools/clarity_metrics.py comfort <images...>`): each
  image is box-resampled to 480 x 270 so sources compare on equal terms. Columns:
  - L5, L50, L95: Rec.709 luminance percentiles (display-encoded, 0 to 1).
  - white, black: share of pixels with L > 0.9 and L < 0.08.
  - sat, sat95: mean and 95th-percentile HSV saturation.
  - loud: share of pixels that are both bright and strongly saturated (V > 0.75 and S > 0.55).
  - rms: global luminance contrast.
  - local: mean standard deviation of L in 4x4 blocks.
  - edges: share of pixels with a Sobel gradient above 0.25.
  - hues: number of 15-degree hue bins holding at least 2% of the coloured pixels.
  - skygap: mean L of the top 22% minus the bottom half.
- **Our frames** are the internal render (no HUD) from `test/clarity.mjs` at the player's
  1920x969 browser window. There are five scenes: trailhead, Granite Steps, Widowmaker,
  Gauntlet stage 3 and the race track.

## Numbers

| source | L5 | L50 | L95 | white | black | sat | sat95 | loud | rms | local | edges | hues |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Stardew Valley (3) | 0.18 | 0.52 | 0.78 | 0.066 | 0.006 | 0.71 | 0.93 | 0.30 | 0.21 | 0.084 | 0.142 | 8.7 |
| Sea of Stars (2) | 0.09 | 0.20 | 0.56 | 0 | 0.032 | 0.53 | 0.88 | 0.00 | 0.14 | 0.043 | 0.040 | 12 |
| Eastward (1) | 0.39 | 0.67 | 0.83 | 0.014 | 0 | 0.24 | 0.55 | 0.00 | 0.13 | 0.022 | 0.038 | 4 |
| Octopath Traveler (1) | 0.04 | 0.24 | 0.77 | 0.007 | 0.201 | 0.43 | 0.94 | 0.00 | 0.23 | 0.063 | 0.111 | 7 |
| Triangle Strategy (2) | 0.01 | 0.26 | 0.60 | 0.002 | 0.229 | 0.49 | 0.99 | 0.00 | 0.18 | 0.049 | 0.056 | 12.5 |
| A Short Hike (4) | 0.31 | 0.52 | 0.80 | 0.016 | 0 | 0.56 | 0.79 | 0.18 | 0.16 | 0.034 | 0.027 | 6.8 |
| Tunic (2) | 0.16 | 0.53 | 0.83 | 0.013 | 0.025 | 0.47 | 0.84 | 0.12 | 0.22 | 0.033 | 0.042 | 15.5 |
| Alba (3) | 0.32 | 0.55 | 0.81 | 0.045 | 0 | 0.29 | 0.52 | 0.05 | 0.16 | 0.031 | 0.038 | 7 |
| Lonely Mountains: Downhill (3) | 0.23 | 0.55 | 0.80 | 0.004 | 0.001 | 0.38 | 0.68 | 0.20 | 0.17 | 0.023 | 0.025 | 7.3 |
| Art of Rally (4) | 0.23 | 0.45 | 0.76 | 0.003 | 0 | 0.42 | 0.68 | 0.15 | 0.17 | 0.024 | 0.011 | 10 |
| Dinkum (3) | 0.25 | 0.53 | 0.86 | 0.026 | 0 | 0.50 | 0.77 | 0.20 | 0.19 | 0.077 | 0.114 | 9.7 |
| Reference concept art | 0.20 | 0.51 | 0.73 | 0 | 0 | 0.66 | 0.81 | 0.39 | 0.19 | 0.068 | 0.104 | 13 |
| **LowRange before** (5 scenes) | 0.20 | 0.54 | 0.75 | 0.000 | 0.002 | **0.54** | 0.71 | **0.26** | 0.16 | 0.035 | **0.050** | 5.6 |
| **LowRange after** (5 scenes, Soft, HD 1x) | 0.23 | 0.52 | 0.70 | 0 | 0.000 | 0.44 | 0.60 | **0.02** | 0.13 | 0.025 | **0.023** | 5.6 |

## What the numbers say about our frame (before)

1. **Brightness on its own was not the outlier.** Median luminance 0.54 is right where the
   restful outdoor 3D games sit (Alba 0.55, LMD 0.55, Short Hike 0.52). Nothing clipped to white.
2. **Saturation spread was the outlier.** Our mean saturation was 0.54 but the 95th percentile
   only 0.71: almost every pixel was nearly as saturated as the most saturated one. The calm
   references keep a wide gap between the two. Art of Rally is 0.42 against 0.68, LMD 0.38
   against 0.68, Alba 0.29 against 0.52. That means big areas are muted and the strong colour
   sits on small things. Our "loud" share was 0.26 on average and 0.55 at the Gauntlet: a
   quarter to half of the screen was bright and saturated at the same time (ochre dirt, lime
   grass). LMD is 0.20 and Art of Rally 0.15, and those are mostly their accent flowers. In
   our frame the olive truck was *less* saturated than the ground, so the hierarchy was upside
   down.
3. **Edge density was double the HD-clean games.** We measured 0.050, against 0.011 to 0.042 for
   Art of Rally, Short Hike, LMD, Alba and Tunic. Most of it was the near-black 1 to 2 px outline
   on every silhouette and ridge. Stardew and Dinkum are higher still (0.11 to 0.14), but there
   the edges are small, low-amplitude detail inside top-down tiles, not long dark lines across a
   perspective view.
4. **Hue count was already low (5 to 6 bins)**, which is good: the palette was coherent. The
   problem was intensity, not variety.

## Game by game: transferable techniques

**Stardew Valley.** It is far more saturated than its reputation (mean S 0.71). It stays
restful for other reasons:
- The camera is top-down and orthographic, so no single flat field of colour stretches to the
  horizon.
- Grass is a *mid-dark* green and only the paths are bright, so the bright colour is on the
  smaller area.
- Outlines are coloured: dark green on bushes, dark brown on wood, never black.
- Lighting is flat, so there are no hard light/shade jumps on big surfaces.
- The small-scale detail is dense but low in amplitude.

Transferable here: coloured outlines, and keep the brightest ground colour off the biggest areas.

**Eastward and Sea of Stars.** These are pixel art with real dynamic light. The light is
painted, with soft gradients and big pools of mid-dark, and the brightest values are kept for
light sources and characters. Sea of Stars' median L is only 0.20, with highlights on lamps,
water glints and party members. Bloom is restrained and local, as a halo around lamps rather
than a global glow. Transferable: brightest value on small accents, a soft roll-off rather than
clipping, and no global bloom.

**Octopath Traveler and Triangle Strategy (HD-2D).** These put crisp, nearest-sampled pixel
art (sprites and textures) into a high-resolution 3D scene. Geometry and lighting are drawn at
native resolution with smooth edges, while texels stay big and hard. They also use a strong
tilt-shift depth of field, a vignette, bloom and dark crushed blacks (20% of pixels are near
black). The core trick transfers: native-resolution geometry with chunky texels. The heavy DoF
and crushed blacks don't transfer here, because the user has disliked blur and haze before.
Their sat95 of 0.94 to 0.99 against a modest mean shows the same accent rule again.

**A Short Hike.** This is the closest match to our tech: a low-resolution 3D render, upscaled.
- No outlines at all. Forms read through value and hue steps.
- Grass is yellow-olive, not blue-lime, and dirt is a terracotta *darker* than the grass.
- L5 sits at 0.31: the shadows are lifted, never inky.
- Edge density is 0.027.

Transferable: warmer, more olive greens, lifted darks, and far fewer dark lines.

**Tunic.** Flat-shaded 3D with soft colour ramps, big calm shapes, and saturated hue on the
level's focal points. It has the biggest sky/ground gap (0.19): a clear, bright sky over a
calmer ground.

**Alba, Lonely Mountains: Downhill, Art of Rally.** Clean flat colour and almost no texture
noise (local contrast 0.023 to 0.031). Silhouettes read by value, not by line. Atmospheric
perspective is strong: the distance desaturates and shifts towards a soft sky tint, which is
also why their hue count stays low far away. Saturation is restrained on big areas (0.29 to
0.42 mean), and the strong colours are flowers, the rider and the car. Art of Rally has the
lowest edge density of all (0.011). Transferable: fewer and lighter lines, saturation that drains
with distance, and the rig as the most saturated object.

**Dinkum and Animal Crossing.** Soft ambient light and rounded forms. Shadows are tinted rather
than grey (Animal Crossing's are blue-violet). Nothing in the frame is pure black or pure white.

**Zelda: Link's Awakening (2019).** From knowledge. A strong tilt-shift blur at the top and
bottom makes a toy diorama, with soft bloom and a plastic-toy palette. It is very restful, but
the blur is the main tool, and blur is exactly what the user rejected earlier.

## Rules applied to LowRange

1. **Large areas sit back, small things pop.** The ground (dirt, grass, road) is a step darker
   and less saturated. All world materials get a small saturation and value grade, while
   vehicles and flowers are left alone (`toon.js uWorldGrade` / `markWorld`). Target: mean
   saturation 0.40 to 0.48 with a 95th percentile about 0.15 above it, and loud < 5% of the
   frame. Result: 0.44 / 0.60, loud 0.02.
2. **Keep the warmth, lose the glare.** The dirt stays the reference's golden ochre, just darker
   and calmer (S 0.67 to 0.57, V 0.87 to 0.79). It is not desaturated towards tan, which read as
   the beige wash the user disliked before. Grass moves from blue-lime to a warmer meadow green.
3. **Coloured, thinner, fading lines.** The outline is now the surface's own colour taken well
   down and half-way to the warm outline brown, instead of near-black. Ground ridges get a
   lighter line, the inner pixel of the bold near line tapers, and lines fade out sooner with
   distance. Edge density went from 0.050 to 0.023, in line with Short Hike, LMD and Alba.
4. **Calm texture.** World prop textures move a little towards their neighbourhood average,
   more with distance, so the canopy speckle drops while every texel stays a crisp pixel. The
   procedural props' world-space detail is softened too.
5. **Atmospheric perspective by saturation, not haze.** Fog first drains saturation with
   distance, then leans towards the (slightly dimmer) horizon tint, still capped at 45%.
6. **A soft display curve.** Contrast pivots around mid-grey, a soft shoulder rolls the top
   values off instead of clipping them, there is a tiny black lift and a gentle vignette.
   Players can tune this: Soft / Standard / Vivid plus Brightness, Contrast and Saturation.
7. **HD-2D resolution recipe.** The default pixel size is now **HD 1x**: native resolution with
   4x MSAA on geometry edges, while every pixel-art texture keeps the Fine 2x texel size (a mip
   bias). The result is clean, smooth silhouettes with chunky, hard texels, which is Octopath's
   recipe. Outlines at 1x are two pixels thick out to 90 m, so the line weight on screen matches
   Fine 2x. Fine 2x and the chunkier sizes are still there for anyone who prefers the hard-pixel
   upscale.
8. **Rejected:** depth of field / tilt-shift (the Link's Awakening and Octopath tool) and global
   bloom. Both soften the frame, and the user's earlier complaints were blur and haze. Lamps
   already read as emissive accents without bloom. Both stay open if wanted later; they were not
   built or tested in this pass.

## Before / after (5 scenes; flicker on the three trail-park scenes)

| metric | before | after |
|---|---|---|
| luminance L5 / L50 / L95 | 0.20 / 0.54 / 0.75 | 0.23 / 0.52 / 0.70 |
| near-white / near-black share | 0.0002 / 0.0016 | 0 / 0.0002 |
| saturation mean / p95 | 0.54 / 0.71 | 0.44 / 0.60 |
| loud (bright and saturated) share | 0.26 (Gauntlet 0.55) | 0.02 (Gauntlet 0.07) |
| RMS contrast / local contrast | 0.157 / 0.035 | 0.131 / 0.025 |
| edge density | 0.050 | 0.023 |
| hue bins | 5.6 | 5.6 |
| flicker A-B-A share (orbit/drive, 3 scenes) | 0.013-0.018 | 0.012-0.018 |
| mean abs frame difference while moving | 4.9-8.2 | 3.9-6.8 |
