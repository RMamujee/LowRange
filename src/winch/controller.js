// The winch in the game: keys and HUD buttons, picking an anchor, the line's commands, the rules.
//
// Keys (edge-detected from main.js's held-key set each frame):
//   K       tap: show the best anchor ahead (marker + line preview); tap again: the next one;
//           hold (HOLD_K s): hook up to the one shown
//   U       hold: winch in        O  hold: pay out        L  unhook and stow the line
// HUD buttons on the winch board do the same (NEXT, HOOK, IN and OUT latch on / off, OFF).
// The motor runs only with the engine running. The truck may be in neutral or in gear with the
// driver helping with the wheels: the line and the tyres are solved together (src/winch/winch.js).
//
// Rules: a new truck (teleport, restart, repair, rig change) has its line stowed; a run (trail,
// Gauntlet, side course, race lap) during which the line pulled is marked assisted (assist()).
// No three.js and no DOM.
import { Winch, winchSpec, surfaceProbe, quietAudio, WINCH_AUDIO } from './winch.js';
import { AnchorFinder } from './anchors.js';

export const CTRL = { HOLD_K: 0.45, REFRESH: 0.25 };

export class WinchController {
  // anchors: buildAnchors(...); toast(msg, secs)
  constructor({ R, world, terrain, anchors, toast = () => {} }) {
    this.R = R; this.world = world; this.toast = toast;
    this.probe = surfaceProbe(R, world);
    this.finder = new AnchorFinder(anchors, { R, world, probe: this.probe, terrain });
    this.anchors = anchors;
    this.car = null; this.w = null;
    this.aiming = false; this.cands = []; this.sel = 0; this.refreshT = 0;
    this.kDown = -1; this.kStart = false; this.latch = 0;
    this.prev = new Set();
    this.audio = WINCH_AUDIO;
    this.hint = null; this.hintT = 0;
  }

  get winch() { return this.w; }
  get has() { return !!this.w; }

  // a new truck: its line is stowed (teleport, restart, repair, rig change, map start)
  attach(car) {
    if (car === this.car && (!car || car.chassis === this.chassis)) return;
    if (car === this.car) { this.chassis = car.chassis; if (this.w?.hooked) { this.unhook(); } return; } // rebuilt in place (Vehicle.reset / repair)
    const was = this.w && this.w.hooked;
    if (this.car && this.car.winch) this.car.winch = null;
    this.car = car; this.chassis = car?.chassis ?? null; this.w = null; this.aiming = false; this.cands = []; this.latch = 0; this.kDown = -1;
    quietAudio();
    if (car && winchSpec(car.spec, car.mass)) { this.w = new Winch(car, this.probe); car.winch = this.w; }
    if (was) this.toast('Winch line unhooked and stowed', 2);
  }

  candidate() { return this.aiming ? this.cands[this.sel] ?? null : null; }

  refresh(keep = true) {
    const w = this.w; if (!w) return;
    const prev = keep ? this.candidate()?.a : null;
    this.cands = this.finder.candidates(this.car, w.ws, w.fairlead());
    const k = prev ? this.cands.findIndex((c) => c.a === prev) : -1;
    this.sel = k >= 0 ? k : 0;
  }

  aim() {
    if (!this.w) { this.toast(`No winch on the ${this.car?.spec.name ?? 'truck'}`); return; }
    if (this.w.hooked) { this.toast('Already hooked up: L unhooks the line', 2); return; }
    if (!this.aiming) {
      this.aiming = true; this.refresh(false);
      if (!this.cands.length) { this.aiming = false; this.toast(`No anchor ahead within ${Math.round(this.w.ws.line)} m: face a tree, a big rock or a recovery post`, 3); return; }
      this.say();
    } else this.next();
  }
  next() {
    if (!this.aiming) { this.aim(); return; }
    this.refresh(true);
    if (!this.cands.length) { this.aiming = false; this.toast('No anchor in reach any more', 2); return; }
    this.sel = (this.sel + 1) % this.cands.length;
    this.say();
  }
  say() {
    const c = this.candidate(); if (!c) return;
    const name = c.a.kind === 'post' ? 'Recovery post' : c.a.kind === 'tree' ? 'Tree' : 'Rock';
    this.toast(`${name}, ${c.d.toFixed(0)} m${this.cands.length > 1 ? ` (${this.sel + 1} of ${this.cands.length})` : ''}. Hold K to hook up, tap K for the next`, 2.4);
  }
  hook() {
    if (!this.w || this.w.hooked) return;
    if (!this.aiming) { this.aim(); if (!this.aiming) return; }
    this.refresh(true);
    const c = this.candidate();
    if (!c) { this.aiming = false; this.toast('That anchor is out of reach now', 2); return; }
    this.w.hook(c.A);
    this.aiming = false; this.cands = []; this.latch = 0;
    this.toast(`Hooked to the ${c.a.kind === 'post' ? 'recovery post' : c.a.kind}. Hold U to winch in, O to pay out, L to unhook`, 3);
  }
  unhook() {
    if (this.aiming && (!this.w || !this.w.hooked)) { this.aiming = false; this.cands = []; return; }
    if (!this.w || !this.w.hooked) return;
    this.w.unhook(); this.latch = 0; quietAudio();
    this.toast('Line unhooked and stowed', 1.6);
  }

  // HUD / gamepad actions; returns true when the name was a winch action
  action(name) {
    switch (name) {
      case 'winchNext': this.next(); return true;
      case 'winchHook': this.hook(); return true;
      case 'winchIn': this.latch = this.latch === 1 ? 0 : 1; if (!this.w?.hooked) { this.latch = 0; this.toast('Hook up first (K)', 1.6); } return true;
      case 'winchOut': this.latch = this.latch === -1 ? 0 : -1; if (!this.w?.hooked) { this.latch = 0; this.toast('Hook up first (K)', 1.6); } return true;
      case 'winchOff': this.unhook(); return true;
      default: return false;
    }
  }

  // per frame while driving: keys = main.js's held-key set
  update(car, dt, keys) {
    this.attach(car);
    const w = this.w;
    const down = (c) => keys.has(c) && !this.prev.has(c), up = (c) => !keys.has(c) && this.prev.has(c);
    if (down('KeyK')) { if (!this.aiming) { this.aim(); this.kStart = true; } else this.kStart = false; this.kDown = 0; }
    if (this.kDown >= 0) {
      this.kDown += dt;
      if (this.kDown >= CTRL.HOLD_K && this.aiming) { this.hook(); this.kDown = -1; }
      else if (up('KeyK')) { if (!this.kStart && this.aiming) this.next(); this.kDown = -1; }
      else if (!keys.has('KeyK')) this.kDown = -1;
    }
    if (down('KeyL')) this.unhook();
    if (down('KeyU') || down('KeyO')) { this.latch = 0; if (!w?.hooked) this.toast(w ? 'Hook up first: K picks an anchor' : `No winch on the ${car.spec.name}`, 2); }
    this.prev = new Set(keys);
    if (!w) return;
    // the anchor list follows the truck while aiming
    if (this.aiming && (this.refreshT -= dt) <= 0) { this.refreshT = CTRL.REFRESH; this.refresh(true); if (!this.cands.length) this.aiming = false; }
    if (!w.hooked) { w.cmd = 0; return; }
    const held = keys.has('KeyU') ? 1 : keys.has('KeyO') ? -1 : 0;
    const cmd = held || this.latch;
    const powered = car.dt.running;
    if (cmd && !powered && w.cmd !== cmd) this.toast('Start the engine (I) to run the winch', 2);
    if (cmd > 0 && w.L <= 1.21 && w.cmd > 0) { this.latch = 0; this.toast('Line is all the way in', 1.6); }
    if (cmd < 0 && w.L >= w.ws.line - 1e-3 && w.cmd < 0) { this.latch = 0; this.toast('All the line is out', 1.6); }
    w.cmd = cmd; w.powered = powered;
  }

  // the rules: a run during which the line pulled is assisted (it still counts, but as its own record)
  assist(game, courses, race) {
    const w = this.w;
    if (!w || !w.used) return false;
    w.used = false;
    if (game?.active) game.active.assisted = true;
    if (courses) for (const c of courses.all) if (c.running) c.assisted = true;
    if (race && race.racing && race.started) race.assisted = true;
    return true;
  }

  // snapshot for the HUD board
  info(runAssisted = false) {
    const w = this.w;
    if (!w) return { has: false };
    const c = this.candidate();
    return {
      has: true, kind: w.ws.kind, state: this.aiming && !w.hooked ? 'AIMING' : w.state, out: w.hooked ? w.L : 0, line: w.ws.line,
      load: w.hooked ? Math.min(1, w.load) : 0, tension: w.T, pull: w.ws.pull, latch: this.latch, powered: w.powered,
      cand: c ? { kind: c.a.kind, d: c.d, n: this.cands.length, i: this.sel } : null, assisted: runAssisted,
    };
  }
}
