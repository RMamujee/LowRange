// The loading screen's bitmap font (ui/pixelfont.js) as a real web font, built in code at startup.
// Every lit pixel becomes a square in a tiny TrueType font, so menus can use ordinary DOM text
// (selectable, wraps, read by screen readers) that renders exactly like the canvas text.
// One font pixel is 128 units and the em is 9 font pixels (the glyph cell), so at
// font-size: 9 * k px each font pixel is exactly k px: crisp at any whole-number scale.
//
//   import { FONT_FAMILY, fontReady } from './pixelwebfont.js';   // registers the face on import
import { GLYPHS, SPACE_W, GLYPH_GAP, FONT_H, CAP_H } from './pixelfont.js';

export const FONT_FAMILY = 'LowRangePixel';
const U = 128;                      // units per font pixel
const EM = FONT_H * U;              // 1152
const ASC = (CAP_H + 1) * U;        // one pixel of headroom above the caps
const DESC = (FONT_H - CAP_H) * U;  // two descender rows

// lit pixels -> rectangles: horizontal runs per row, merged downwards while the run repeats
function rects(g) {
  const out = [], open = new Map();
  for (let r = 0; r < FONT_H; r++) {
    const row = g.rows[r], runs = [];
    for (let c = 0; c < g.w; c++) if (row[c] === '#') { const s = c; while (c < g.w && row[c] === '#') c++; runs.push([s, c]); }
    const next = new Map();
    for (const [a, b] of runs) {
      const k = a + ',' + b, prev = open.get(k);
      if (prev) { prev.r1 = r + 1; next.set(k, prev); } else { const q = { a, b, r0: r, r1: r + 1 }; out.push(q); next.set(k, q); }
    }
    open.clear(); for (const [k, v] of next) open.set(k, v);
  }
  // font units, y up from the baseline (which sits under row CAP_H - 1)
  return out.map((q) => ({ x0: q.a * U, x1: q.b * U, y0: (CAP_H - q.r1) * U, y1: (CAP_H - q.r0) * U }));
}

class Buf {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 255); return this; }
  u16(v) { this.b.push((v >> 8) & 255, v & 255); return this; }
  i16(v) { return this.u16(v < 0 ? v + 65536 : v); }
  u32(v) { this.b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return this; }
  tag(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); return this; }
  bytes(a) { for (const x of a) this.b.push(x); return this; }
  pad() { while (this.b.length % 4) this.b.push(0); return this; }
  get length() { return this.b.length; }
}
const checksum = (b) => { let s = 0; for (let i = 0; i < b.length; i += 4) s = (s + ((b[i] << 24) | ((b[i + 1] || 0) << 16) | ((b[i + 2] || 0) << 8) | (b[i + 3] || 0))) >>> 0; return s; };

export function buildFont() {
  // glyph 0: .notdef (hollow box), 1: space, then every bitmap glyph in code-point order
  const chars = Object.keys(GLYPHS).sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
  const notdef = { w: 4, rows: ['####', '#..#', '#..#', '#..#', '#..#', '#..#', '####', '....', '....'] };
  const list = [{ g: notdef, cp: null }, { g: null, cp: 32 }, ...chars.map((ch) => ({ g: GLYPHS[ch], cp: ch.codePointAt(0) }))];
  const n = list.length;

  const glyf = new Buf(), loca = [], hmtx = new Buf();
  let maxPts = 0, maxCont = 0, xMaxAll = 0, advMax = 0;
  for (const { g } of list) {
    loca.push(glyf.length);
    const adv = ((g ? g.w : SPACE_W) + GLYPH_GAP) * U;
    advMax = Math.max(advMax, adv);
    const rs = g ? rects(g) : [];
    if (!rs.length) { hmtx.u16(adv).i16(0); continue; }
    const xMin = Math.min(...rs.map((q) => q.x0)), xMax = Math.max(...rs.map((q) => q.x1));
    const yMin = Math.min(...rs.map((q) => q.y0)), yMax = Math.max(...rs.map((q) => q.y1));
    xMaxAll = Math.max(xMaxAll, xMax);
    hmtx.u16(adv).i16(xMin);
    glyf.i16(rs.length).i16(xMin).i16(yMin).i16(xMax).i16(yMax);
    rs.forEach((_, i) => glyf.u16(i * 4 + 3));          // endPtsOfContours
    glyf.u16(0);                                         // no instructions
    const pts = rs.flatMap((q) => [[q.x0, q.y0], [q.x0, q.y1], [q.x1, q.y1], [q.x1, q.y0]]); // clockwise
    pts.forEach(() => glyf.u8(1));                       // on-curve, full-size coordinates
    let px = 0; for (const [x] of pts) { glyf.i16(x - px); px = x; }
    let py = 0; for (const [, y] of pts) { glyf.i16(y - py); py = y; }
    glyf.pad();
    maxPts = Math.max(maxPts, pts.length); maxCont = Math.max(maxCont, rs.length);
  }
  loca.push(glyf.length);

  const tables = {};
  tables.head = new Buf().u32(0x10000).u32(0x10000).u32(0).u32(0x5F0F3CF5).u16(0x000B).u16(EM)
    .u32(0).u32(0).u32(0).u32(0).i16(0).i16(-DESC).i16(xMaxAll).i16(ASC).u16(0).u16(8).i16(2).i16(1).i16(0);
  tables.hhea = new Buf().u32(0x10000).i16(ASC).i16(-DESC).i16(0).u16(advMax).i16(0).i16(0).i16(xMaxAll)
    .i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(n);
  tables.maxp = new Buf().u32(0x10000).u16(n).u16(maxPts).u16(maxCont).u16(0).u16(0).u16(2)
    .u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);
  tables.hmtx = hmtx;
  const lo = new Buf(); loca.forEach((o) => lo.u32(o)); tables.loca = lo;
  tables.glyf = glyf;

  // cmap: format 4, one segment per code point (all glyphs are in the BMP)
  const map = list.map((e, gid) => [e.cp, gid]).filter(([cp]) => cp !== null).sort((a, b) => a[0] - b[0]);
  const segs = [...map.map(([cp, gid]) => ({ s: cp, e: cp, d: (gid - cp + 65536) % 65536 })), { s: 0xFFFF, e: 0xFFFF, d: 1 }];
  const sc = segs.length, sr = 2 * 2 ** Math.floor(Math.log2(sc)), es = Math.log2(sr / 2);
  const f4 = new Buf().u16(4).u16(16 + sc * 8).u16(0).u16(sc * 2).u16(sr).u16(es).u16(sc * 2 - sr);
  segs.forEach((q) => f4.u16(q.e)); f4.u16(0);
  segs.forEach((q) => f4.u16(q.s)); segs.forEach((q) => f4.u16(q.d)); segs.forEach(() => f4.u16(0));
  tables.cmap = new Buf().u16(0).u16(1).u16(3).u16(1).u32(12).bytes(f4.b);

  const cps = map.map(([cp]) => cp);
  tables['OS/2'] = new Buf().u16(4).i16(5 * U).u16(400).u16(5).u16(0)
    .i16(EM / 2).i16(EM / 2).i16(0).i16(U).i16(EM / 2).i16(EM / 2).i16(0).i16(3 * U).i16(U).i16(3 * U).i16(0)
    .bytes([2, 11, 6, 9, 0, 0, 0, 0, 0, 0]).u32(1 | 2).u32(0x02000000).u32(0).u32(0).tag('LRNG')
    .u16(0x40 | 0x80).u16(Math.min(...cps)).u16(Math.min(0xFFFF, Math.max(...cps))).i16(ASC).i16(-DESC).i16(0).u16(ASC).u16(DESC)
    .u32(1).u32(0).i16(5 * U).i16(CAP_H * U).u16(0).u16(32).u16(1);

  const names = [[1, FONT_FAMILY], [2, 'Regular'], [3, FONT_FAMILY + '-1'], [4, FONT_FAMILY], [6, FONT_FAMILY]];
  const strs = names.map(([, s]) => [...s].flatMap((ch) => [0, ch.charCodeAt(0)]));
  const nm = new Buf().u16(0).u16(names.length).u16(6 + names.length * 12);
  let off = 0; names.forEach(([id], i) => { nm.u16(3).u16(1).u16(0x409).u16(id).u16(strs[i].length).u16(off); off += strs[i].length; });
  strs.forEach((s) => nm.bytes(s)); tables.name = nm;
  tables.post = new Buf().u32(0x30000).u32(0).i16(-U).i16(U).u32(0).u32(0).u32(0).u32(0).u32(0);

  // assemble: table directory (tags in byte order) then 4-byte aligned tables
  const tags = Object.keys(tables).sort();
  const nt = tags.length, srch = 16 * 2 ** Math.floor(Math.log2(nt));
  const out = new Buf().u32(0x10000).u16(nt).u16(srch).u16(Math.log2(srch / 16)).u16(nt * 16 - srch);
  let at = 12 + nt * 16;
  const placed = tags.map((t) => { const b = tables[t].b, o = at; at += Math.ceil(b.length / 4) * 4; return { t, b, o }; });
  placed.forEach(({ t, b, o }) => out.tag(t).u32(checksum(b)).u32(o).u32(b.length));
  placed.forEach(({ b }) => { out.bytes(b); out.pad(); });
  const bytes = new Uint8Array(out.b);
  const headAt = placed.find((p) => p.t === 'head').o;
  const adj = (0xB1B0AFBA - checksum(out.b)) >>> 0;
  bytes[headAt + 8] = adj >>> 24; bytes[headAt + 9] = (adj >>> 16) & 255; bytes[headAt + 10] = (adj >>> 8) & 255; bytes[headAt + 11] = adj & 255;
  return bytes.buffer;
}

let face = null;
export const fontReady = (() => {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return Promise.resolve(false);
  try {
    face = new FontFace(FONT_FAMILY, buildFont(), { style: 'normal', weight: '400', display: 'block' });
    document.fonts.add(face);
    return face.load().then(() => true, (e) => { console.warn('pixel web font failed to load', e); return false; });
  } catch (e) {
    console.warn('pixel web font failed to build', e);
    return Promise.resolve(false);
  }
})();
