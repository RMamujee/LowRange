// The winch board on the HUD: a small wooden board like the engine and tyre boards, with the state
// (Stowed / Aiming / Hooked / Pulling / Paying out / Stalled), the line out in metres, the load as a bar
// with a red zone, the anchor on offer while aiming, Assisted (as its title) during a run the line has
// helped, and clickable keys (Next, Hook, In, Out, Off) like the cluster's Recover / Cam / Map.
// It follows the HUD legibility rules: the HUD's own board / parchment / lamp helpers, body text
// (7 px caps, mixed case) in the text colours (src/hud/px.js, src/hud/instruments.js). Its size
// (BOARDS.winch) and its spot (above the chassis board on the right) come from the pure layout in
// src/hud/layout.js, like every other board, so toasts and big messages keep clear of it and
// test/hudlayout.mjs / test/hudfit.mjs cover it; where the layout has no room for it, it is hidden.
import { P, rect, px, board, paper, inset, text } from '../hud/px.js';
import { drawLamp, LAMP_H } from '../hud/instruments.js';
import { BIG_MAX, BOARDS, hudLayout } from '../hud/layout.js';

export const WBOARD = BOARDS.winch;
const STATE = { STOWED: ['Stowed', P.text2], AIMING: ['Aiming', P.textHot], HOOKED: ['Hooked', P.text], PULLING: ['Pulling', P.textGood], 'PAYING OUT': ['Paying out', P.text], STALLED: ['Stalled', P.textWarn] };
const RED_ZONE = 0.85;
const LY = 31; // key row, as on the engine and tyre boards

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

  // the same pure layout as hud.js (same inputs, so the same answer): its rect, or hidden
  layout() {
    const dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
    const L = hudLayout({ W, H, dpr, centre: BIG_MAX }), q = L.rects.winch;
    this.spot = q ? { x: q.x, y: q.y } : null;
    if (q) {
      this.cv.style.left = `${q.x}px`; this.cv.style.top = `${q.y}px`;
      this.cv.style.width = `${q.w}px`; this.cv.style.height = `${q.h}px`;
    }
    this.shown = null; // re-apply display on the next update
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
    paper(g, 4, 4, W - 8, 25, 18);
    // the title, or Assisted while the current run has had help from the line
    if (info.assisted) text(g, 'Assisted', 8, 6, P.textHot);
    else text(g, info.kind === 'compact' ? 'Compact' : 'Winch', 8, 6, P.text2);
    const st = info.state, [word, col] = STATE[st] ?? [st, P.text];
    if (!(st === 'STALLED' && blink)) text(g, word, W - 9, 6, col, { align: 'right' });
    // second line: line out + load bar, or the anchor on offer while aiming
    if (st === 'AIMING' && info.cand) {
      const c = info.cand, name = c.kind === 'post' ? 'Post' : c.kind === 'tree' ? 'Tree' : 'Rock';
      text(g, `${name} ${c.d.toFixed(0)} m`, 8, 17, P.text);
      text(g, `${c.i + 1}/${c.n}`, W - 9, 17, P.text2, { align: 'right' });
    } else {
      const out = info.out > 0;
      const bx = 8 + text(g, out ? `${info.out.toFixed(1)} m` : `${Math.round(info.line)} m`, 8, 17, out ? P.text : P.text2) + 5;
      const bw = W - 9 - bx, by = 18, fill = Math.round(Math.min(1, info.load) * (bw - 2)), red = Math.round(RED_ZONE * (bw - 2));
      inset(g, bx, by, bw, 6, P.paperShade);
      rect(g, bx + 1 + red, by + 1, bw - 2 - red, 4, P.warnFace);
      if (fill > 0) {
        rect(g, bx + 1, by + 1, Math.min(fill, red), 4, P.green);
        if (fill > red) rect(g, bx + 1 + red, by + 1, fill - red, 4, P.red);
        rect(g, bx + 1, by + 1, fill, 1, fill > red ? P.redHi : P.greenHi);
      }
      px(g, bx + 1 + red, by, P.redDark); px(g, bx + 1 + red, by + 5, P.redDark);
    }
    // keys, and their keyboard keys painted on the wood (outlined body text, like the chassis board)
    this.hits = [];
    const aim = st === 'STOWED' || st === 'AIMING';
    const btns = aim
      ? [['Next', 'winchNext', st === 'AIMING'], ['Hook', 'winchHook', false]]
      : [['In', 'winchIn', info.latch === 1], ['Out', 'winchOut', info.latch === -1], ['Off', 'winchOff', false]];
    let x = 5;
    for (const [label, act, on] of btns) { const w = drawLamp(g, x, LY, label, on ? 'on' : null, 'button'); this.hits.push({ x, y: LY, w, h: LAMP_H, act }); x += w + 2; }
    text(g, aim ? 'K' : 'U O L', W - 7, LY + 2, P.paint, { align: 'right', outline: P.ol });
  }
}
