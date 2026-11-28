// HUD layout maths (src/hud/layout.js), no browser: across a matrix of window sizes and display
// scalings, no board leaves the window, no two overlap, the big centre messages and long toasts find a
// clear spot (and miss each other), and the common sizes keep exactly the scale and spots the HUD had
// before layout.js (scale = max(2, floor(device height / 400)), chassis board bottom-right).
// Usage: node test/hudlayout.mjs
import { BOARDS, BIG_MAX, BIGMAP_SIZE, MARGIN, hudLayout, fitToast, fitBig, fitScale, overlaps } from '../src/hud/layout.js';

let fails = 0, checks = 0;
const check = (ok, msg) => { checks++; if (!ok) { console.log('  FAIL', msg); fails++; } };
const E = 1e-6;
const waits = new Set();
const onScreen = (q, W, H) => q.x >= -E && q.y >= -E && q.x + q.w <= W + E && q.y + q.h <= H + E;

const MATRIX = [[1920, 1080], [1366, 768], [1280, 720], [1024, 600], [800, 600], [640, 360], [320, 240], [800, 1600], [2560, 1080]];
const COMMON = [[1920, 1080], [1366, 768], [1280, 720], [2560, 1080], [1536, 864], [1440, 900], [1600, 900]];
const BIGS = [['3', 5], ['GO!', 5], ['1:23.4', 5], ['10:23.4', 5], ['WRONG WAY', 3]];
const TOASTS = [
  'Waypoint set. Follow the red arrow',
  'Manual clutch: Space is your clutch pedal. Stalls are real now.',
  'Trail Pickup on the grid: 4-HI, neutral. Go on green; Up / Down arrows or the mouse wheel shift.',
  'Retry: Stage 7/12 - Boulder Garden (black). A long line of big rocks that wants a careful driver and a slow, steady throttle foot.',
];

function checkSize(W, H, dpr, tag) {
  const L = hudLayout({ W, H, dpr, centre: BIG_MAX });
  const R = Object.entries(L.rects);
  check(L.scale >= 1 && Number.isInteger(L.scale), `${tag}: whole scale >= 1 (got ${L.scale})`);
  for (const [n, q] of R) check(onScreen(q, W, H), `${tag}: ${n} on screen ${JSON.stringify(q)}`);
  for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) check(!overlaps(R[i][1], R[j][1]), `${tag}: ${R[i][0]} clear of ${R[j][0]}`);
  const boards = R.map(([, q]) => q);
  for (const [text, sc] of BIGS) {
    const b = fitBig(L, text, sc);
    check(b.ok && onScreen(b.box, W, H) && boards.every((q) => !overlaps(b.box, q)), `${tag}: big "${text}" clear ${JSON.stringify(b.box)}`);
    for (const t of TOASTS) {
      for (const avoid of [[], [b.box]]) {
        const f = fitToast(L, t, avoid), q = f.box;
        if (avoid.length && !f.ok) { waits.add(`${tag} "${t.slice(0, 20)}..." + "${text}"`); continue; } // no room for both: hud.js holds the toast back until the big message is gone
        check(f.ok && onScreen(q, W, H) && boards.every((r) => !overlaps(q, r)) && avoid.every((r) => !overlaps(q, r)), `${tag}: toast "${t.slice(0, 24)}..." ${avoid.length ? 'with' : 'without'} "${text}" clear ${JSON.stringify(q)}`);
      }
    }
  }
  return L;
}

// the matrix, at 100%, 125% and 150% display scaling
const rows = [];
for (const dpr of [1, 1.25, 1.5]) for (const [W, H] of MATRIX) {
  const L = checkSize(W, H, dpr, `${W}x${H}@${dpr}`);
  rows.push(`${W}x${H}@${dpr}: scale ${L.scale}, chassis ${L.chassis}${L.mini ? '' : ', minimap hidden'}${L.engine ? '' : ', engine board hidden'}`);
}
// common sizes: same scale and spots as before
for (const [W, H, dpr] of [...[1, 1.25, 1.5].flatMap((d) => COMMON.map(([w, h]) => [w, h, d])), [2560, 1440, 2], [3840, 2160, 2], [1280, 720, 2]]) {
  const tag = `${W}x${H}@${dpr}`, L = checkSize(W, H, dpr, tag), legacy = Math.max(2, Math.floor((H * dpr) / 400)), u = legacy / dpr;
  check(L.scale === legacy && L.chassis === 'side' && L.engine && L.mini, `${tag}: keeps scale ${legacy} with every board in its usual spot (got ${L.scale}, ${L.chassis})`);
  const B = BOARDS, want = { cluster: [MARGIN, H - MARGIN - B.cluster[1] * u], chassis: [W - MARGIN - B.chassis[0] * u, H - MARGIN - B.chassis[1] * u], engine: [MARGIN, H - MARGIN - (B.cluster[1] + 3) * u - B.engine[1] * u], mini: [W - MARGIN - B.mini[0] * u, MARGIN] };
  for (const [n, [x, y]] of Object.entries(want)) check(Math.abs(L.rects[n].x - x) < E && Math.abs(L.rects[n].y - y) < E && Math.abs(L.rects[n].w - BOARDS[n][0] * u) < E, `${tag}: ${n} unmoved`);
  check(!fitBig(L, '10:23.4', 5).moved && !fitBig(L, 'WRONG WAY', 3).moved, `${tag}: big message at its usual spot`);
  const f = fitToast(L, TOASTS[1]);
  check(!f.moved && f.lines.length === 1, `${tag}: short toast at its usual spot, unwrapped`);
}
// a sweep of odd sizes and scalings, to catch gaps between the matrix sizes
for (const dpr of [1, 1.25, 1.5, 2]) for (let W = 320; W <= 2600; W += 53) for (let H = 240; H <= 1700; H += 47) checkSize(W, H, dpr, `${W}x${H}@${dpr}`);
// a toast is never lost: where no spot is clear of the boards (here one board fills the window) it is
// still shown (ok) when no big message is up; only a big message in the way may hold it back
{
  const L = { W: 400, H: 300, u: 1, rects: { wall: { x: 0, y: 0, w: 400, h: 300 } } }, big = { x: 100, y: 100, w: 200, h: 50 };
  check(TOASTS.every((t) => fitToast(L, t).ok), 'no clear spot, no big message: toast shown anyway');
  check(TOASTS.every((t) => !fitToast(L, t, [big]).ok), 'no clear spot, big message up: toast waits for it');
}
// modal boards fit the window (fractional scale below 1)
for (const [W, H] of MATRIX) for (const dpr of [1, 1.5]) {
  const s = fitScale(W, H, dpr, 432, 226);
  check((432 * s) / dpr <= W && (226 * s) / dpr <= H, `${W}x${H}@${dpr}: big map fits at scale ${s.toFixed(2)}`);
}
check(fitScale(1920, 1080, 1, ...BIGMAP_SIZE) === 4 && fitScale(1366, 768, 1, ...BIGMAP_SIZE) === 2 && fitScale(1024, 600, 1, ...BIGMAP_SIZE) === 2, 'big map keeps its scale at common sizes (4 at 1080p, 2 at 1366x768 and 1024x600)');

console.log(rows.join('\n'));
console.log(`toast held back behind a big message (no room for both): ${waits.size ? [...waits].join('; ') : 'never'}`);
// (the legibility rework made the engine board 6 px taller, so a 373x240 window joined 320x240 here)
check([...waits].every((w) => { const [ww, hh] = w.split('@')[0].split('x').map(Number); return ww < 400 && hh <= 240; }), 'only windows under 400 x 240 ever hold a toast back');
console.log(fails ? `${fails} of ${checks} checks FAILED` : `all ${checks} checks ok`);
process.exit(fails ? 1 : 0);
