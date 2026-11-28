// The winch board on the HUD: a small wooden board like the engine and chassis boards, with the state
// (STOWED / AIMING / HOOKED / PULLING / PAYING OUT / STALLED), the line out in metres, the load as a bar
// with a red zone, the anchor on offer while aiming, ASSISTED (as its title) during a run the line has helped, and
// clickable buttons (NEXT, HOOK, IN, OUT, OFF) like the cluster's RECOVER / CAM / MAP.
// It uses the HUD's own board / parchment / lamp helpers and tiny font (src/hud/px.js,
// src/hud/instruments.js), so it follows any restyle of those. It sits above the chassis board on the
// right, or wherever src/hud/layout.js placeBox finds room clear of the other boards; hidden if none.
import { P, rect, px, board, paper, inset, tiny } from '../hud/px.js';
import { drawLamp } from '../hud/instruments.js';
import { BIG_MAX, MARGIN, GAP, hudLayout, placeBox } from '../hud/layout.js';

export const WBOARD = [112, 40];
const STATE_COL = { STOWED: P.inkSoft, AIMING: P.amberDark, HOOKED: P.ink, PULLING: P.greenDark, 'PAYING OUT': P.blueDark, STALLED: P.red };
const RED_ZONE = 0.85;

export class WinchBoard {
  // root: the #hud element; action(name): main.js action()
  constructor(root, action) {
    this.action = action;
    const cv = document.createElement('canvas'); cv.className = 'px hud-winch';
    root.appendChild(cv);
    this.cv = cv; this.g = cv.getContext('2d'); this.g.imageSmoothingEnabled = false;
    this.hits = []; this.sig = ''; this.shown = false; this.clock = 0;
    cv.width = WBOARD[0]; cv.height = WBOARD[1];
    cv.style.display = 'none';
    cv.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      const r = cv.getBoundingClientRect(), x = ((e.clientX - r.left) * WBOARD[0]) / r.width, y = ((e.clientY - r.top) * WBOARD[1]) / r.height;
      const h = this.hits.find((q) => x >= q.x && y >= q.y && x < q.x + q.w && y < q.y + q.h);
      if (h) this.action(h.act);
    });
    this.layout();
    addEventListener('resize', () => this.layout());
  }

  // same scale and boards as the HUD (layout.js is pure, so this matches hud.js exactly)
  layout() {
    const dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
    const L = hudLayout({ W, H, dpr, centre: BIG_MAX }), u = L.u, w = WBOARD[0] * u, h = WBOARD[1] * u;
    const ch = L.rects.chassis;
    const home = ch ? [W - MARGIN - w, ch.y - GAP - h] : [W - MARGIN - w, H - MARGIN - h];
    const spot = placeBox(L, w, h, home[0], home[1]);
    this.spot = spot;
    if (spot) {
      this.cv.style.left = `${spot.x}px`; this.cv.style.top = `${spot.y}px`;
      this.cv.style.width = `${w}px`; this.cv.style.height = `${h}px`;
    }
    this.sig = '';
  }

  update(dt, info, playing = true) {
    this.clock += dt;
    const show = !!(info && info.has && this.spot && playing);
    if (show !== this.shown) { this.cv.style.display = show ? '' : 'none'; this.shown = show; }
    if (!show) return;
    const blink = Math.floor(this.clock * 3) % 2;
    const sig = [info.state, info.out.toFixed(1), Math.round(info.load * 40), info.cand ? `${info.cand.kind}${info.cand.d.toFixed(0)}${info.cand.i}/${info.cand.n}` : '', info.latch, info.assisted, info.state === 'STALLED' ? blink : 0].join('|');
    if (sig === this.sig) return;
    this.sig = sig;
    this.draw(info, blink);
  }

  draw(info, blink) {
    const g = this.g, [W, H] = WBOARD;
    g.clearRect(0, 0, W, H);
    board(g, 0, 0, W, H, { seed: 17 });
    paper(g, 4, 4, W - 8, 19, 18);
    // the title, or ASSISTED while the current run has had help from the line
    if (info.assisted) tiny(g, 'ASSISTED', 8, 7, P.amberDark);
    else tiny(g, info.kind === 'compact' ? 'COMPACT' : 'WINCH', 8, 7, P.inkSoft);
    const st = info.state, col = STATE_COL[st] ?? P.ink;
    if (!(st === 'STALLED' && blink)) tiny(g, st, W - 9, 7, col, { align: 'right' });
    // second line: line out + load bar, or the anchor on offer while aiming
    if (st === 'AIMING' && info.cand) {
      const c = info.cand, name = c.kind === 'post' ? 'POST' : c.kind === 'tree' ? 'TREE' : 'ROCK';
      tiny(g, `${name} ${c.d.toFixed(0)} M`, 8, 15, P.ink);
      tiny(g, `${c.i + 1}/${c.n}  HOLD K`, W - 9, 15, P.inkSoft, { align: 'right' });
    } else {
      tiny(g, info.out > 0 ? `${info.out.toFixed(1)} M` : `${Math.round(info.line)} M`, 8, 15, info.out > 0 ? P.ink : P.inkSoft);
      const bx = 38, bw = W - 9 - bx, by = 15, fill = Math.round(Math.min(1, info.load) * (bw - 2)), red = Math.round(RED_ZONE * (bw - 2));
      inset(g, bx, by, bw, 6, P.paperShade);
      rect(g, bx + 1 + red, by + 1, bw - 2 - red, 4, P.warnFace);
      if (fill > 0) {
        rect(g, bx + 1, by + 1, Math.min(fill, red), 4, P.green);
        if (fill > red) rect(g, bx + 1 + red, by + 1, fill - red, 4, P.red);
        rect(g, bx + 1, by + 1, fill, 1, fill > red ? P.redHi : P.greenHi);
      }
      px(g, bx + 1 + red, by, P.redDark); px(g, bx + 1 + red, by + 5, P.redDark);
    }
    // buttons
    this.hits = [];
    const btns = st === 'STOWED' || st === 'AIMING'
      ? [['NEXT', 'winchNext', st === 'AIMING'], ['HOOK', 'winchHook', false]]
      : [['IN', 'winchIn', info.latch === 1], ['OUT', 'winchOut', info.latch === -1], ['OFF', 'winchOff', false]];
    const keys = st === 'STOWED' || st === 'AIMING' ? 'K' : 'U  O  L';
    let x = 5;
    for (const [label, act, on] of btns) { const w = drawLamp(g, x, 26, label, on ? 'on' : null, 'button'); this.hits.push({ x, y: 26, w, h: 10, act }); x += w + 2; }
    tiny(g, keys, W - 6, 29, P.paint, { align: 'right', shadow: P.ol });
  }
}
