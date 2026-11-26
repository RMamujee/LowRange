// The ART_STYLE.md palette (sRGB hex), each ramp ordered highlight, base, shade, deep shade.
// Single source for the renderer's generated textures, light tints and sky.
export const RAMP = {
  dirt:   [0xdcb074, 0xca9757, 0xab7b45, 0x815d36], // comfort: the reference's golden ochre kept warm but a step darker and calmer (S .67 -> .57, V .87 -> .79), the screen's biggest area
  grass:  [0x9fc865, 0x77a846, 0x588d39, 0x3d6c30], // comfort: warmer, less lime meadow green (S .65 -> .57)
  leaf:   [0x7cc843, 0x4fa032, 0x2f7d2c, 0x1f5a27],
  pine:   [0x4f9f4a, 0x2f7f3f, 0x1f6236, 0x164a2e],
  bark:   [0xc98a4e, 0xa5683a, 0x7d4a2a, 0x55301f],
  rock:   [0xc2b296, 0xa29278, 0x80725e, 0x5e5446], // bare trail rock / cliff bands: warm sandstone slab
  boulder:[0xb5a29c, 0x917c78, 0x6f5d5c, 0x4f4146], // boulders and stones: cooler mauve-grey (as the Blender props), so they stand off the slab
  trim:   [0x4a4640, 0x33302c, 0x24211e, 0x161412],
  // not in the contract table; derived from it (dirt pushed darker / paler, glass pushed teal)
  mud:    [0x9a6a3c, 0x7a4f2c, 0x5c3a22, 0x402818],
  sand:   [0xf8e2a4, 0xeecb7e, 0xd8ac5e, 0xb88a44],
  road:   [0xe2c48c, 0xd2ac6e, 0xb69058, 0x8e6f45], // comfort: a step down from the first f2ce86 ramp, still the palest path
  tarmac: [0x6a645a, 0x4f4a43, 0x3b3732, 0x2a2724],
  water:  [0x9fdcec, 0x5bb0cc, 0x3c88aa, 0x2a6488],
};
export const FLOWERS = [0xf7a8c4, 0xfff4e6, 0xffd95a];
export const OUTLINE = 0x2a1a14;
// Clear sky: a warm cream horizon stepping up into soft blue. (The first golden-haze sky put the
// sky, the fog and the far hills all in the ground's own ochre, which read as one washed-out
// beige; the cool sky gives the warm ground and greens something to stand against.)
export const SKY = 0x9fcfe8;
export const FOG = 0xe4dcc0;   // horizon haze: the far ground leans towards it, never all the way
export const FOG_MAX = 0.45;   // the most fog any surface takes (aerial perspective, not a wash)
// sky bands drawn by the pixel pipeline where nothing was rendered, horizon (= fog) to zenith
export const SKY_BANDS = [FOG, 0xd2e4d8, 0xb6d9e6, SKY, 0x88c2e6];
// distant ranges beyond the map edge, nearest to farthest: flat, each a clear step towards the sky
export const BACKDROP = [0x6f9a4c, 0x88ae86, 0xa6c6c6];

export const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
