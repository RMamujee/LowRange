// The ART_STYLE.md palette (sRGB hex), each ramp ordered highlight, base, shade, deep shade.
// Single source for the renderer's generated textures, light tints and sky.
export const RAMP = {
  dirt:   [0xf2c25a, 0xe0a440, 0xc4832e, 0x9a5f24],
  grass:  [0x8fd14a, 0x5fae36, 0x3f8a2e, 0x2a6628],
  leaf:   [0x7cc843, 0x4fa032, 0x2f7d2c, 0x1f5a27],
  pine:   [0x4f9f4a, 0x2f7f3f, 0x1f6236, 0x164a2e],
  bark:   [0xc98a4e, 0xa5683a, 0x7d4a2a, 0x55301f],
  rock:   [0xb7aa98, 0x948775, 0x73685c, 0x544b45],
  trim:   [0x4a4640, 0x33302c, 0x24211e, 0x161412],
  // not in the contract table; derived from it (dirt pushed darker / paler, glass pushed teal)
  mud:    [0x9a6a3c, 0x7a4f2c, 0x5c3a22, 0x402818],
  sand:   [0xf8e2a4, 0xeecb7e, 0xd8ac5e, 0xb88a44],
  road:   [0xf6d07a, 0xe8b85e, 0xcf9a46, 0xa87632],
  tarmac: [0x6a645a, 0x4f4a43, 0x3b3732, 0x2a2724],
  water:  [0x9fdcec, 0x5bb0cc, 0x3c88aa, 0x2a6488],
};
export const FLOWERS = [0xf7a8c4, 0xfff4e6, 0xffd95a];
export const OUTLINE = 0x2a1a14;
// warm golden haze: the sky and the fog it fades the far ground into
export const SKY = 0xf3d58e;
export const FOG = 0xeac47c;
// sky bands drawn by the pixel pipeline where nothing was rendered, horizon (= fog) to zenith
export const SKY_BANDS = [FOG, 0xefcd86, SKY, 0xf8dea0, 0xfbe6b0];

export const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
