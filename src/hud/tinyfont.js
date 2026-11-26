// A 3x5 pixel font for the HUD's small labels and dial numerals (caps only; lower case maps to caps).
// Same row notation as ui/pixelfont.js: rows top-down, '#' lit.
const G = {
  0: '### #.# #.# #.# ###', 1: '.#. ##. .#. .#. ###', 2: '##. ..# .#. #.. ###', 3: '##. ..# .#. ..# ##.',
  4: '#.# #.# ### ..# ..#', 5: '### #.. ##. ..# ##.', 6: '.## #.. ### #.# ###', 7: '### ..# .#. .#. .#.',
  8: '### #.# ### #.# ###', 9: '### #.# ### ..# ##.',
  A: '.#. #.# ### #.# #.#', B: '##. #.# ##. #.# ##.', C: '.## #.. #.. #.. .##', D: '##. #.# #.# #.# ##.',
  E: '### #.. ##. #.. ###', F: '### #.. ##. #.. #..', G: '.## #.. #.# #.# .##', H: '#.# #.# ### #.# #.#',
  I: '### .#. .#. .#. ###', J: '..# ..# ..# #.# .#.', K: '#.# #.# ##. #.# #.#', L: '#.. #.. #.. #.. ###',
  M: '#...# ##.## #.#.# #...# #...#', N: '#..# ##.# #.## #..# #..#', O: '.#. #.# #.# #.# .#.', P: '##. #.# ##. #.. #..',
  Q: '.#. #.# #.# ##. .##', R: '##. #.# ##. #.# #.#', S: '.## #.. .#. ..# ##.', T: '### .#. .#. .#. .#.',
  U: '#.# #.# #.# #.# ###', V: '#.# #.# #.# #.# .#.', W: '#...# #...# #.#.# ##.## #...#', X: '#.# #.# .#. #.# #.#',
  Y: '#.# #.# .#. .#. .#.', Z: '### ..# .#. #.. ###',
  '.': '. . . . #', ',': '. . . # #', ':': '. # . # .', '-': '... ... ### ... ...', '+': '... .#. ### .#. ...',
  '/': '..# ..# .#. #.. #..', '%': '#.# ..# .#. #.. #.#', "'": '# # . . .', '!': '# # # . #', '?': '##. ..# .#. ... .#.',
  '(': '.# #. #. #. .#', ')': '#. .# .# .# #.', '<': '..# .#. #.. .#. ..#', '>': '#.. .#. ..# .#. #..',
  '°': '### #.# ### ... ...', '#': '#.# ### #.# ### #.#', '=': '... ### ... ### ...', '*': '... #.# .#. #.# ...',
  '&': '.#. #.# .#. #.# .##', '"': '#.# #.# ... ... ...', '|': '# # # # #', '_': '... ... ... ... ###',
};
export const TINY_H = 5;
const glyphs = {};
for (const [ch, src] of Object.entries(G)) { const rows = src.split(' '); glyphs[ch] = { w: rows[0].length, rows }; }
const get = (ch) => glyphs[ch] || glyphs[ch.toUpperCase()] || glyphs['?'];

export function tinyMeasure(text) {
  let w = 0;
  for (const ch of String(text)) w += (ch === ' ' ? 2 : get(ch).w) + 1;
  return Math.max(0, w - 1);
}

// Draws text in a single colour; returns the width drawn. align: 'left' | 'center' | 'right'.
export function tiny(ctx, text, x, y, color, { align = 'left', shadow = null } = {}) {
  text = String(text);
  const w = tinyMeasure(text);
  let cx = align === 'center' ? x - Math.floor(w / 2) : align === 'right' ? x - w : x;
  const plot = (px, py) => ctx.fillRect(px, py, 1, 1);
  const pass = (col, ox, oy) => {
    ctx.fillStyle = col;
    let gx = cx;
    for (const ch of text) {
      if (ch === ' ') { gx += 3; continue; }
      const g = get(ch);
      for (let r = 0; r < TINY_H; r++) for (let c = 0; c < g.w; c++) if (g.rows[r][c] === '#') plot(gx + c + ox, y + r + oy);
      gx += g.w + 1;
    }
  };
  if (shadow) pass(shadow, 1, 1);
  pass(color, 0, 0);
  return w;
}
