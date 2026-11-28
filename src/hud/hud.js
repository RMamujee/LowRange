// LowRange driving HUD, all pixel art: a wooden instrument board (tach, speedo, H-pattern stick,
// transfer lever, locker rockers, parking brake, pedal bars, lamps and buttons), the chassis board
// (pitch / roll inclinometers, wheels + suspension + surface card, damage), the engine board above the
// cluster (temperature gauge, oil / coolant / drive lamps, seized engine), the framed minimap with a
// guidance plaque (or the race lap readout), the expandable map with waypoints, plank toasts, big race
// messages, the controls board (H) and the pause buttons on the menu.
// main.js owns the simulation; it hands this module a state snapshot every frame and gets actions back.
import './hud.css';
import * as THREE from 'three';
import { TRAILS, CHECKPOINTS, SIZE, heightAt, pathPoint } from '../terrain.js';
import { P, mk, rect, px, board, paper, inset, tiny, sign, drawText, measure, text, fitText, nice, LINE, clamp, fmtT, fmtLap, spriteFrom, rotSprite, shape } from './px.js';
import { Dial, Shifter, TransferLever, ParkLever, drawLockers, drawPedals, drawLamp, lampWidth, LAMP_H, drawIncl } from './instruments.js';
import { MapBases, BigMap, Waypoints, drawMinimap } from './mapview.js';
import { Beacons } from './waypoint_pillars.js';
import { TEMP, engineStatus, engineLamps, EngineWarnings } from './engine_state.js';
import { BOARDS, BIG_MAX, hudLayout, fitToast, fitBig, fitScale } from './layout.js';
import { drawTyreGauge, tyreSig } from './tyre_gauge.js'; // [tyre pressure]

const $ = (id) => document.getElementById(id);

// pixel canvas element sized by whole device pixels per HUD pixel
function pixCanvas(cls, parent) {
  const cv = document.createElement('canvas'); cv.className = 'px ' + cls;
  parent.appendChild(cv);
  const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
  return { cv, g, w: 0, h: 0, hits: [] };
}
function sizeCanvas(c, w, h, s) {
  const dpr = devicePixelRatio || 1;
  if (c.cv.width !== w || c.cv.height !== h) { c.cv.width = w; c.cv.height = h; c.g.imageSmoothingEnabled = false; }
  c.w = w; c.h = h; c.s = s;
  c.cv.style.width = `${(w * s) / dpr}px`; c.cv.style.height = `${(h * s) / dpr}px`;
}
// event -> canvas pixel coords
function local(c, e) { const r = c.cv.getBoundingClientRect(); return [(e.clientX - r.left) * c.w / r.width, (e.clientY - r.top) * c.h / r.height]; }
function hitTest(c, e) { const [x, y] = local(c, e); return c.hits.find((h) => x >= h.x && y >= h.y && x < h.x + h.w && y < h.y + h.h) || null; }

function guideArrow() {
  const f = mk(13, 13);
  shape(f.g, 1, 1, 11, 11, (x, y) => {
    const dx = x - 6, t = (y - 1) / 10;
    if (t < 0 || t > 1) return null;
    const half = t * 5.2, notch = t > 0.7 && Math.abs(dx) < (t - 0.7) * 8;
    if (Math.abs(dx) > half + 0.2 || notch) return null;
    return dx < 0 ? P.redHi : P.red;
  });
  return spriteFrom(f.cv);
}

export function createHud({ action, camera, isRace, mapId, mapName, trees, scene, noOutline, controls, onResume, onRestart, spawns = [], onSpawn, lastSpawn }) {
  const root = $('hud');
  const cluster = pixCanvas('hud-cluster', root);
  const chassis = pixCanvas('hud-chassis', root);
  const engine = pixCanvas('hud-engine', root);
  const tyreC = pixCanvas('hud-tyre', root); tyreC.cv.style.cursor = 'pointer'; // [tyre pressure] beside the engine board
  const mini = pixCanvas('hud-mini', root);
  const toastC = pixCanvas('hud-toast', root);
  const bigC = pixCanvas('hud-big', root);
  const mapWrap = document.createElement('div'); mapWrap.className = 'hud-mapwrap hidden'; root.appendChild(mapWrap);
  const mapC = pixCanvas('hud-map', mapWrap);
  const helpWrap = $('help');
  helpWrap.innerHTML = '';
  const helpC = pixCanvas('hud-help', helpWrap);

  const tach = new Dial(55), speedo = new Dial(55), shifter = new Shifter(), transfer = new TransferLever(), park = new ParkLever();
  const bases = new MapBases(trees);
  const waypoints = new Waypoints(mapId);
  const big = new BigMap({ bases, waypoints, isRace, mapName, spawns });
  const beacons = scene ? new Beacons(scene, heightAt, noOutline) : null;
  beacons?.sync(waypoints.list);
  waypoints.onChange = (l) => beacons?.sync(l);
  const warnings = new EngineWarnings();
  const ARROW = guideArrow();
  const trailEnds = TRAILS.map((t) => [pathPoint(t, 3), pathPoint(t, t.length - 3)]);

  let spec = null, scale = 2, mapScale = 2, clock = 0, acc = 0, last = null, L = null;
  let toastT = 0, bigT = 0, mapOpen = false, helpOpen = false, lastToast = '', guideAng = null;
  let toastMsg = null, toastWait = false, toastMoved = false, bigArgs = null, bigBox = null;

  // ------------------------------------------------------------ layout
  // layout.js picks the scale from the window's width and height, and moves or hides boards that
  // would overlap in small windows; at normal sizes it gives the scale and spots the HUD always had.
  function layout() {
    const dpr = devicePixelRatio || 1;
    L = hudLayout({ W: innerWidth, H: innerHeight, dpr, centre: BIG_MAX });
    scale = L.scale;
    mapScale = fitScale(innerWidth, innerHeight, dpr, big.W, big.H);
    sizeCanvas(cluster, ...BOARDS.cluster, scale);
    sizeCanvas(chassis, ...BOARDS.chassis, scale);
    sizeCanvas(engine, ...BOARDS.engine, scale); engineSig = '';
    engine.cv.style.bottom = `${10 + ((cluster.h + 3) * scale) / dpr}px`; // stacked on the cluster's left end
    sizeCanvas(mini, ...BOARDS.mini, scale);
    chassis.cv.style.bottom = L.chassis === 'stacked' ? `${L.chassisBottom}px` : '';
    chassis.cv.style.display = L.chassis === 'hidden' ? 'none' : '';
    engine.cv.style.display = L.engine ? '' : 'none';
    sizeCanvas(tyreC, ...BOARDS.tyre, scale); tyreSigLast = ''; // [tyre pressure]
    tyreC.cv.style.display = L.tyre ? '' : 'none';
    if (L.tyre) { tyreC.cv.style.left = `${L.rects.tyre.x}px`; tyreC.cv.style.top = `${L.rects.tyre.y}px`; }
    mini.cv.style.display = L.mini ? '' : 'none';
    sizeCanvas(mapC, big.W, big.H, mapScale);
    if (bigArgs) renderBig();
    if (toastMsg) renderToast();
    renderHelp();
    renderPause();
  }

  // ------------------------------------------------------------ spec
  function setSpec(s) {
    spec = s;
    const e = s.engine, maxR = Math.ceil((e.redline * 1.12) / 1000) * 1000;
    tach.configure({ max: maxR, major: 1000, minor: maxR > 6000 ? 1000 : 500, div: 1000, red: e.redline, title: 'RPM' });
    // top speed in high range, top gear, at redline
    const topGeared = (e.redline * 2 * Math.PI / 60) / (s.gears[s.gears.length - 1] * (s.ranges.high || 1) * s.final) * s.tire.radius * 3.6;
    const top = Math.min(200, topGeared); // gearing alone over-promises: drag caps them well below
    let max = 60, step = 20;
    for (const st of [20, 30, 40, 50, 60]) { const n = Math.ceil(top / st - 1e-6); if (n <= 4) { max = Math.max(60, n * st); step = st; break; } }
    speedo.configure({ max, major: step, minor: step / 2, title: 'KM/H' });
    shifter.configure(s.gears.length);
  }

  // ------------------------------------------------------------ cluster
  function drawCluster(S, dt) {
    const { car, input } = S, d = car.dt, g = cluster.g;
    cluster.hits = [];
    board(g, 0, 0, cluster.w, cluster.h, { seed: 4 });
    const rpm = Math.max(0, d.rpm), kmh = Math.abs(car.speed() * 3.6);
    tach.draw(g, 5, 5, rpm, String(Math.round(rpm / 10) * 10), dt, rpm > spec.engine.redline);
    speedo.draw(g, 62, 5, kmh, kmh < 10 ? kmh.toFixed(1) : String(Math.round(kmh)), dt);
    shifter.setGear(d.gear); shifter.update(dt);
    shifter.draw(g, 120, 6, { clutchIn: d.clutchPedal > 0.5 || d.engagement < 0.5 });
    cluster.hits.push({ x: 120, y: 6, w: shifter.W, h: shifter.H, act: 'shift' });
    const tc = d.range === 'low' ? '4L' : d.fourWD ? '4H' : '2H';
    transfer.update(dt, tc);
    transfer.draw(g, 175, 6, { has2H: !spec.awd, has4L: !!spec.ranges.low });
    cluster.hits.push({ x: 175, y: 6, w: transfer.W, h: transfer.H, act: 'transfer' });
    const lk = drawLockers(g, 202, 6, { front: d.lockF, rear: d.lockR, hasF: !!spec.lockers.front, hasR: !!spec.lockers.rear });
    cluster.hits.push({ x: 202 + lk.f[0], y: 6 + lk.f[1], w: lk.f[2], h: lk.f[3], act: 'lockF' }, { x: 202 + lk.r[0], y: 6 + lk.r[1], w: lk.r[2], h: lk.r[3], act: 'lockR' });
    park.update(dt, S.parkBrake || input.handbrake);
    park.draw(g, 229, 6, { park: S.parkBrake, held: input.handbrake });
    cluster.hits.push({ x: 229, y: 6, w: park.W, h: park.H, act: 'park' });
    drawPedals(g, 261, 6, { t: input.throttle, b: input.brake, c: 1 - d.engagement });
    // lamp strip + buttons (body text, mixed case)
    const LY = 62;
    let x = 5;
    const lamp = (label, state, act) => { const w = drawLamp(g, x, LY, label, state); cluster.hits.push({ x, y: LY, w, h: LAMP_H, act }); x += w + 2; };
    lamp('4WD', d.fourWD ? 'on' : null, '4wd');
    { const T = car.tyre; lamp(`${Math.round(T.psi)} PSI`, T.moving ? (Math.floor(clock * 4) % 2 ? 'on' : null) : T.psi < (T.P.trail + T.P.road) / 2 ? 'on' : null, 'tyres'); } // [tyre pressure] lit below road pressure, blinks while changing; click: crawl / road
    if (spec.rearSteer) lamp('R-steer', car.rearSteerOn ? 'on' : null, 'rsteer');
    lamp(d.autoClutch ? 'Auto-cl' : 'Manual', d.autoClutch ? 'good' : null, 'autoclutch');
    const stalled = !d.running;
    lamp(d.dead ? 'Dead' : stalled ? 'Stall I' : 'Engine', stalled ? (Math.floor(clock * 3) % 2 ? 'warn' : 'on') : null, 'ignition');
    const btns = [['Recover', 'recover'], ['Cam', 'camera'], ['Map', 'map'], ['Help', 'help']];
    let bx = Math.max(x + 3, cluster.w - 5 - btns.reduce((a, [l]) => a + lampWidth(l) + 2, -2));
    for (const [l, act] of btns) { const w = drawLamp(g, bx, LY, l, (act === 'map' && mapOpen) || (act === 'help' && helpOpen) ? 'on' : null, 'button'); cluster.hits.push({ x: bx, y: LY, w, h: LAMP_H, act }); bx += w + 2; }
  }

  // ------------------------------------------------------------ chassis board
  function drawChassis(S) {
    const { car } = S, g = chassis.g;
    board(g, 0, 0, chassis.w, chassis.h, { seed: 6 });
    const att = car.attitude(), pd = att.pitch * 57.3, rd = att.roll * 57.3;
    drawIncl(g, 5, 4, pd, 'pitch', 38, clock);
    drawIncl(g, 52, 4, rd, 'roll', 30, clock);
    // painted lettering under each dial (body text, outlined so it reads on the planks): "Pitch 12°↑", "Roll 4°→"
    const pl = `Pitch ${Math.abs(pd).toFixed(0)}°${pd > 0.5 ? '↑' : pd < -0.5 ? '↓' : ''}`, rl = `Roll ${Math.abs(rd).toFixed(0)}°${rd > 0.5 ? '→' : rd < -0.5 ? '←' : ''}`;
    text(g, pl, 27, 50, Math.abs(pd) > 38 ? P.redHi : P.paint, { align: 'center', outline: P.ol });
    text(g, rl, 74, 50, Math.abs(rd) > 30 ? P.redHi : P.paint, { align: 'center', outline: P.ol });
    // wheels card
    const X = 99, Y = 5, W = chassis.w - X - 5, H = 52, cx = X + Math.floor(W / 2);
    paper(g, X, Y, W, H, 5);
    const d = car.dt, axY = [Y + 10, Y + 30];
    rect(g, cx, axY[0], 1, axY[1] - axY[0], P.inkSoft);
    for (const [i, ay] of axY.entries()) {
      rect(g, cx - 7, ay, 15, 1, P.inkSoft);
      const locked = i === 0 ? d.lockF : d.lockR, driven = i === 1 || d.fourWD;
      rect(g, cx - 2, ay - 2, 5, 5, P.ink); rect(g, cx - 1, ay - 1, 3, 3, locked ? P.red : driven ? P.paperShade : P.paper);
    }
    const comp = car.compression(), s = spec.susp, names = car.wheelState.map((ws) => ws);
    for (let i = 0; i < 4; i++) {
      const left = i % 2 === 0, front = i < 2, ws = names[i];
      const tx = left ? cx - 13 : cx + 7, ty = front ? Y + 4 : Y + 24;
      const broken = car.broken[i], flat = car.health.tire[i] < 0.35, suspHurt = car.health.susp[i] < 0.75;
      const rim = broken ? P.red : !ws.grounded ? P.paperEdge : ws.slip > 0.7 ? P.amber : P.green;
      if (!broken) {
        const fw = flat ? 8 : 7, fx = tx - (flat ? (left ? 1 : 0) : 0);
        rect(g, fx - 1, ty - 1, fw + 2, 15, suspHurt ? P.red : rim);
        rect(g, fx, ty, fw, 13, ws.grounded ? P.m1 : P.m3);
        for (let k = 1; k < 13; k += 3) rect(g, fx + 1, ty + k, fw - 2, 1, ws.grounded ? P.m3 : P.m4);
      } else {
        for (let k = 0; k < 7; k++) { px(g, tx + k, ty + 3 + k, P.red); px(g, tx + 6 - k, ty + 3 + k, P.red); }
      }
      // suspension travel: marker in a slot, centre line at static
      const bx = left ? cx - 18 : cx + 17;
      inset(g, bx, ty, 3, 13, P.paperShade);
      const c = clamp(comp[i], -s.droop - 0.15, s.bump + 0.15), f = clamp(0.5 - c / (s.bump + s.droop + 0.3), 0, 1);
      rect(g, bx, ty + 6, 3, 1, P.paperEdge);
      rect(g, bx - 1, ty + 1 + Math.round(f * 10), 5, 2, ws.grounded ? P.ink : P.inkSoft);
      // surface + status labels on the outside (body text), the surface's swatch under it;
      // a hurt corner's label alternates with "Susp" (its tyre frame is red too)
      const MAT_NAME = S.matInfo[ws.mat];
      const susp = suspHurt && !broken && Math.floor(clock * 1.5) % 2 === 0;
      const lab = broken ? 'Gone' : flat ? 'Flat' : susp ? 'Susp' : ws.grounded ? MAT_NAME.name : 'Air';
      const col = broken || flat || susp ? P.textWarn : ws.grounded ? P.text : P.text2;
      const sw = MAT_NAME.color.map((v) => Math.round(v * 255)), swc = `rgb(${sw.join(',')})`;
      const lx = left ? cx - 22 : cx + 23;
      text(g, lab, lx, ty, col, { align: left ? 'right' : 'left' });
      if (ws.grounded && !broken) { const sx = left ? lx - 6 : lx; rect(g, sx, ty + 10, 6, 4, P.ink); rect(g, sx + 1, ty + 11, 4, 2, swc); }
    }
    // damage
    const H2 = car.health, pct = (v) => Math.round(v * 100), dc = (v) => (v > 0.75 ? P.textGood : v > 0.35 ? P.textHot : P.textWarn);
    text(g, d.dead ? 'Eng dead' : `Eng ${pct(H2.engine)}%`, X + 5, Y + 41, d.dead ? P.textWarn : dc(H2.engine));
    text(g, `Body ${pct(H2.body)}%`, X + W - 5, Y + 41, dc(H2.body), { align: 'right' });
  }

  // ------------------------------------------------------------ engine board
  // Temperature strip (zones at the damage model's thresholds, engine_state.js), a status line with
  // power loss, and oil / coolant / drive lamps. Quiet when healthy (needle on the cold stop, lamps
  // dark); a warning blinks for a moment when it first comes on or gets worse. Redrawn only when
  // what it shows changes.
  const SEIZE_TEXT = { oil: 'No oil', heat: 'Overheated', damage: 'Wrecked' };
  const ZONE = { normal: ['Normal', P.text2], hot: ['Hot', P.textHot], overheat: ['Overheating', P.textWarn] };
  const BAND_COOK = [P.red, P.red, P.redDark], BAND_HOT = [P.amber, P.amber, P.amberDark], BAND_OK = [P.paperShade, P.paperShade, P.paperShade];
  const TEMP_TICKS = [0, 0.25, 0.5, TEMP.hot, TEMP.cook, TEMP.max], LAMP_KEYS = ['oil', 'coolant', 'drive'];
  let engineSig = '';
  function drawEngine(S) {
    const { car } = S, g = engine.g, W = engine.w, xs = 34, xe = W - 9, span = xe - xs;
    const st = engineStatus(car.crash.mech, car.dt), w = warnings.update(st, clock, car.crash.mech), L = engineLamps(st);
    const nx = xs + Math.round(st.tempFrac * span), pw = Math.round(st.power * 100);
    const sig = st.seized ? `S${w.cause}${w.lit.seized}` : `${st.zone}${nx}${w.lit.temp}${st.lowPower && w.lit.power ? pw : ''}`;
    const lamps = LAMP_KEYS.map((k) => `${L[k].label}${w.lit[k] ? L[k].state : ''}`).join();
    if (sig + lamps === engineSig) return;
    engineSig = sig + lamps;
    board(g, 0, 0, W, engine.h, { seed: 14 });
    paper(g, 4, 4, W - 8, 25, 15);
    if (st.seized) {
      if (w.lit.seized) text(g, 'ENGINE SEIZED', W / 2, 6, P.textWarn, { align: 'center' });
      text(g, SEIZE_TEXT[w.cause] || SEIZE_TEXT.damage, 8, 17, P.textWarn);
      text(g, 'Bksp: repair', W - 9, 17, P.text2, { align: 'right' });
    } else {
      text(g, 'Temp', 8, 6, P.text2);
      for (let x = xs; x <= xe; x++) {
        const v = ((x - xs) / span) * TEMP.max;
        const band = v > TEMP.cook ? BAND_COOK : v > TEMP.hot ? BAND_HOT : BAND_OK;
        for (let k = 0; k < 3; k++) px(g, x, 8 + k, band[k]);
      }
      rect(g, xs, 11, span + 1, 1, P.inkSoft);
      for (const v of TEMP_TICKS) {
        const major = v === 0 || v === TEMP.hot || v === TEMP.cook || v === TEMP.max;
        rect(g, xs + Math.round((v / TEMP.max) * span), 12, 1, major ? 2 : 1, major ? P.ink : P.inkSoft);
      }
      rect(g, nx + 1, 7, 1, 6, P.ol); rect(g, nx, 6, 1, 7, P.red); px(g, nx, 6, P.redHi);
      const [zw, zc] = ZONE[st.zone];
      if (w.lit.temp) text(g, zw, 8, 17, zc);
      if (st.lowPower && w.lit.power) text(g, `Power ${pw}%`, W - 9, 17, st.power < 0.5 ? P.textWarn : P.textHot, { align: 'right' });
    }
    // lamp labels in sentence case ('NO DRIVE F' -> 'No drive F'); if all three are long at once, the
    // compact forms ('Oil', 'Drive F') keep them on the board (the lamp colour still says how bad)
    const lab = (k, compact) => { let s = L[k].label; if (compact) s = s.replace(/ \d+%$/, '').replace(/^NO DRIVE/, 'DRIVE'); return s.charAt(0) + s.slice(1).toLowerCase().replace(/ ([fr])$/, (m, c) => ' ' + c.toUpperCase()); };
    const compact = LAMP_KEYS.reduce((a, k) => a + lampWidth(lab(k, false)) + 2, 3) > W - 4;
    let x = 5;
    for (const k of LAMP_KEYS) x += drawLamp(g, x, 31, lab(k, compact), w.lit[k] ? L[k].state : null) + 2;
  }

  // ------------------------------------------------------------ [tyre pressure] tyre board
  let tyreSigLast = '';
  function drawTyre(S) {
    if (!L.tyre) return;
    const sig = tyreSig(S.car, clock);
    if (sig === tyreSigLast) return;
    tyreSigLast = sig;
    tyreC.hits = drawTyreGauge(tyreC.g, tyreC.w, tyreC.h, S.car, clock);
  }

  // ------------------------------------------------------------ guidance
  const camDir = new THREE.Vector3();
  let lastWpCheck = 0;
  function guidance(S, p) {
    const wp = waypoints.active;
    if (wp) return { target: wp, label: `Waypoint 1${waypoints.list.length > 1 ? ` of ${waypoints.list.length}` : ''}`, sub: '', wp: true };
    if (isRace) { const r = S.race; if (!r) return null; const c = CHECKPOINTS[r.next]; return { target: c, label: r.next ? `Checkpoint ${r.next}/${CHECKPOINTS.length - 1}` : 'Start / finish' }; }
    const G = S.game;
    if (G.guide) return G.guide; // [crawl] The Gauntlet: next stage gate, with progress
    if (G.active) { const t = TRAILS[G.active.trail]; return { target: trailEnds[G.active.trail][1 - G.active.from], label: nice(t.name), sub: 'Finish' }; }
    let best = null, bd = Infinity;
    TRAILS.forEach((t, i) => { if (G.trails[i].done) return; trailEnds[i].forEach((e) => { const dd = Math.hypot(e.x - p.x, e.z - p.z); if (dd < bd) { bd = dd; best = { target: e, label: nice(t.name), sub: 'Trail' }; } }); });
    return best;
  }
  // 'GATE 3' -> 'Gate 3', 'COURSE DONE' -> 'Course done' (strings the Gauntlet hands over in caps)
  const sentence = (s) => (s == null ? '' : /[a-z]/.test(s) ? String(s) : String(s).charAt(0) + String(s).slice(1).toLowerCase());

  // The minimap board: the map square (MINI_S game px) and the parchment plaque under it, four body
  // lines at LINE pitch: what the arrow points at, how far, the clock, and a key hint.
  const MINI_S = BOARDS.mini[0] - 8, PLAQUE_Y = MINI_S + 7;
  function drawMini(S) {
    const { car } = S, g = mini.g, p = car.chassis.translation(), { heading } = car.attitude();
    mini.hits = [{ x: 0, y: 0, w: mini.w, h: MINI_S + 6, act: 'map' }];
    board(g, 0, 0, mini.w, mini.h, { seed: 8, nails: false });
    inset(g, 3, 3, MINI_S + 2, MINI_S + 2, P.m1);
    drawMinimap(g, 4, 4, MINI_S, { bases, p, heading, waypoints: waypoints.list, raceCp: isRace && S.race && S.race.racing ? CHECKPOINTS[S.race.next] : S.game.guide?.target ?? null, t: clock }); // [crawl] ring the next gate
    // compass N
    rect(g, 6, 6, 9, 11, P.ol); rect(g, 7, 7, 7, 9, P.paper); text(g, 'N', 11, 8, P.textWarn, { align: 'center' });
    // plaque
    const PW = mini.w - 8, PH = mini.h - PLAQUE_Y - 3;
    paper(g, 4, PLAQUE_Y, PW, PH, 11);
    const gd = guidance(S, p);
    camera.getWorldDirection(camDir);
    const tx = 4 + 11, ty = PLAQUE_Y + 11;
    rect(g, tx - 8, ty - 8, 17, 17, P.paperShade);
    if (gd) {
      const ang = Math.atan2(gd.target.x - p.x, -(gd.target.z - p.z)) - Math.atan2(camDir.x, -camDir.z);
      rotSprite(g, ARROW, tx, ty, ang); guideAng = Math.atan2(Math.sin(ang), Math.cos(ang));
    }
    const x0 = 28, xr = 4 + PW - 4, mw = xr - x0;
    let y = PLAQUE_Y + 3;
    const line = (txt, col) => { text(g, fitText(txt, mw), x0, y, col); y += LINE; };
    const row = (a, b, ca = P.text2, cb = P.text) => { const bw = text(g, b, xr, y, cb, { align: 'right' }); text(g, fitText(a, mw - bw - 4), x0, y, ca); y += LINE; };
    const dist = gd ? `${Math.round(Math.hypot(gd.target.x - p.x, gd.target.z - p.z))} m` : '';
    const hint = (s) => text(g, s, x0, PLAQUE_Y + 3 + 3 * LINE, P.text2);
    if (isRace && S.race) {
      const r = S.race;
      if (r.wrong) line('Wrong way!', Math.floor(clock * 4) % 2 ? P.textWarn : P.text);
      else if (gd) row(gd.wp ? 'Waypoint' : r.next ? `CP ${r.next}/${CHECKPOINTS.length - 1}` : 'Finish', dist, P.text, P.text2);
      else y += LINE;
      row(r.lap ? `Lap ${r.lap}` : r.holding ? 'Wait' : 'Go to line', r.started ? fmtLap(r.lapTime) : '-:--.-');
      row('Last', fmtLap(r.last));
      row('Best', fmtLap(r.best), P.text2, r.best != null ? P.textWarn : P.text2);
    } else if (gd && gd.of) {
      // [crawl] stage progress: Stage 7/12 + distance to the next gate, stage name, run clock
      const unit = sentence(gd.unit || 'STAGE'); // side courses: Section n/N
      row(gd.stage ? `${unit} ${gd.stage}/${gd.of}` : `${gd.of} ${unit.toLowerCase()}s`, dist, P.textWarn, P.text2);
      line(nice(gd.name || ''), P.text);
      line(gd.run != null ? `Run ${fmtT(gd.run)}` : sentence(gd.next), gd.run != null ? P.textWarn : P.text2);
      hint('M map   Y retry');
    } else {
      if (gd) {
        line(gd.label, gd.wp ? P.textWarn : P.text);
        row(gd.sub || '', dist);
      } else { line('Every trail done!', P.textGood); y += LINE; }
      const G = S.game;
      if (G.active) line(`Run ${fmtT(G.active.t)}`, P.textWarn);
      else row(fmtT(G.time), `${(G.dist / 1000).toFixed(2)} km`, P.text2, P.text2);
      hint('M map   H help');
    }
    // waypoint arrival
    if (waypoints.active && clock - lastWpCheck > 0.2) {
      lastWpCheck = clock;
      const w = waypoints.active;
      if (Math.hypot(w.x - p.x, w.z - p.z) < 8) { waypoints.remove(0); toast(waypoints.active ? 'Waypoint reached. On to the next one' : 'Waypoint reached', 2.2); }
    }
  }

  // ------------------------------------------------------------ toast + big message
  function toast(msg, secs = 2.2) {
    toastMsg = String(msg); lastToast = toastMsg;
    toastT = secs;
    renderToast();
  }
  // In a window too small for both, a toast waits (hidden, its clock stopped) while a big message shows.
  function renderToast() {
    const fit = fitToast(L, toastMsg.replace(/[·•—–]/g, '-').replace(/✓/g, ''), bigT > 0 && bigBox ? [bigBox] : []);
    toastWait = !fit.ok; toastMoved = fit.moved;
    toastC.cv.style.transition = toastWait ? 'none' : ''; // held back behind a big message: gone at once, no fade over it
    toastC.cv.classList.toggle('show', toastT > 0 && !toastWait);
    const { lines, w, h } = fit;
    sizeCanvas(toastC, w, h, scale);
    toastC.cv.style.left = fit.moved ? `${fit.x + fit.box.w / 2}px` : ''; // hud.css centres it on left / top
    toastC.cv.style.top = fit.moved ? `${fit.y}px` : '';
    const g = toastC.g;
    g.clearRect(0, 0, w, h);
    board(g, 0, 0, w, h, { seed: 12, plankH: 30 });
    paper(g, 5, 4, w - 10, h - 8, 13);
    lines.forEach((l, i) => drawText(g, l, Math.round((w - measure(l)) / 2), 6 + i * 10, P.ink));
  }
  const BIG_COL = { count: [P.red, P.redDeep], go: [P.greenHi, P.greenDeep], best: [P.gold, P.w0], warn: [P.red, P.redDeep], '': [P.paint, P.ol] };
  function bigMsg(text, secs = 1.2, cls = '') {
    const was = bigT > 0 && bigBox ? `${bigBox.x},${bigBox.y},${bigBox.w}` : '';
    bigArgs = [text, cls];
    bigT = secs;
    renderBig();
    bigC.cv.classList.add('show');
    if (toastT > 0 && toastMsg && `${bigBox.x},${bigBox.y},${bigBox.w}` !== was) renderToast(); // keep the toast clear of it
  }
  function renderBig() {
    const [text, cls] = bigArgs, { sc, w, h, moved, box } = fitBig(L, text, cls === 'warn' ? 3 : 5);
    bigBox = box;
    sizeCanvas(bigC, w, h, scale);
    bigC.cv.style.left = moved ? `${box.x + box.w / 2}px` : ''; // hud.css centres it on left / top
    bigC.cv.style.top = moved ? `${box.y + box.h / 2}px` : '';
    const g = bigC.g, [col, ol] = BIG_COL[cls] || BIG_COL[''];
    g.clearRect(0, 0, w, h);
    drawText(g, text, 4, 4, ol, { scale: sc, outline: ol });
    drawText(g, text, 4, 4, col, { scale: sc, shadow: ol });
  }

  // ------------------------------------------------------------ help (controls board)
  function renderHelp() {
    const rows = controls();
    // keycaps: body caps on a light wooden key (ink 7.9:1); descriptions: body text on parchment
    const keyW = Math.max(...rows.map(([k]) => measure(k.toUpperCase()))) + 8;
    const descW = Math.max(...rows.map(([, v]) => measure(v)));
    const per = Math.ceil(rows.length / 2), colW = keyW + 6 + descW, RP = 14;
    const W = colW * 2 + 30, H = per * RP + 40;
    const dpr = devicePixelRatio || 1;
    sizeCanvas(helpC, W, H, fitScale(innerWidth, innerHeight, dpr, W, H));
    const g = helpC.g;
    board(g, 0, 0, W, H, { seed: 21 });
    sign(g, 'CONTROLS', 10, 6);
    text(g, 'H or Esc to close', W - 10, 6, P.paint, { align: 'right', outline: P.ol });
    paper(g, 6, 18, W - 12, H - 24, 22);
    rows.forEach(([k, v], i) => {
      const col = i < per ? 0 : 1, r = i % per, x = 12 + col * (colW + 8), y = 23 + r * RP;
      const kw = measure(k.toUpperCase()) + 7;
      rect(g, x, y, kw, 12, P.ol); rect(g, x + 1, y + 1, kw - 2, 10, P.w5); rect(g, x + 1, y + 1, kw - 2, 1, P.cream); rect(g, x + 1, y + 10, kw - 2, 1, P.w4);
      text(g, k.toUpperCase(), x + 4, y + 2, P.ol);
      drawText(g, v, x + keyW + 6, y + 2, P.ink);
    });
  }

  // ------------------------------------------------------------ pause buttons (on the menu)
  const pauseBar = $('pauseBar');
  const pauseTitle = pauseBar ? pixCanvas('pause-title', pauseBar) : null;
  const pauseBtns = pauseBar ? [pixCanvas('pause-btn resume', pauseBar), pixCanvas('pause-btn restart', pauseBar)] : [];
  function plankButton(c, text, hot, sc) {
    const s = hot ? 2 : 1, w = measure(text) * s + 24, h = 9 * s + 12;
    sizeCanvas(c, w, h, sc);
    const g = c.g;
    board(g, 0, 0, w, h, { seed: hot ? 31 : 32, plankH: 40 });
    if (hot) { rect(g, 2, 2, w - 4, h - 4, P.amber); rect(g, 2, 2, w - 4, 1, P.amberHi); rect(g, 2, h - 3, w - 4, 1, P.amberDark); }
    drawText(g, text, 12, 6 + (hot ? 0 : 1), hot ? P.ink : P.paint, { scale: s, shadow: hot ? P.amberDark : P.ol });
  }
  function renderPause() {
    if (!pauseBar) return;
    const sc = scale;
    const t = pauseTitle, w = measure('PAUSED') * 2 + 8;
    sizeCanvas(t, w, 9 * 2 + 14, sc);
    t.g.clearRect(0, 0, t.w, t.h);
    sign(t.g, 'PAUSED', 4, 2, P.paint, P.ol, 2);
    text(t.g, 'Esc resumes', 4, 22, P.paint, { outline: P.ol });
    plankButton(pauseBtns[0], 'RESUME', true, sc);
    plankButton(pauseBtns[1], isRace ? 'BACK TO THE GRID (REPAIR)' : 'RESTART AT TRAILHEAD (REPAIR)', false, sc);
  }
  if (pauseBar) {
    pauseBtns[0].cv.addEventListener('click', () => onResume?.());
    pauseBtns[1].cv.addEventListener('click', () => onRestart?.());
  }

  // ------------------------------------------------------------ overlays
  function setMapOpen(v, S) {
    mapOpen = v;
    mapWrap.classList.toggle('hidden', !v);
    if (!v) { big.prompt = -1; big.hover = -1; big.rowHover = -1; big.tab = 'info'; mapC.cv.style.cursor = ''; } // [spawns]
    // whole-map zoom shows the whole map; zoomed in, it opens on the truck
    if (v && S) { const p = S.car.chassis.translation(); if (big.zi === 0) big.centreOn(0, 0); else { big.centreOn(p.x, p.z); big.clampView(); } }
  }
  function setHelpOpen(v) { helpOpen = v; helpWrap.classList.toggle('hidden', !v); if (v) renderHelp(); }

  // ------------------------------------------------------------ input on the HUD canvases
  let lastS = null;
  const gearTo = (target) => {
    if (!lastS) return;
    for (let k = 0; k < 9; k++) {
      const gNow = lastS.car.dt.gear;
      if (gNow === target) break;
      action(target > gNow ? 'up' : 'down');
      if (lastS.car.dt.gear === gNow) break;   // refused (grind etc.)
    }
  };
  const transferTo = (pos) => {
    if (!lastS) return;
    const d = lastS.car.dt;
    const cur = () => (d.range === 'low' ? '4L' : d.fourWD ? '4H' : '2H');
    if (cur() === pos) return;
    if (pos === '4L') { if (d.range !== 'low') action('range'); return; }
    if (d.range === 'low') { action('range'); if (d.range === 'low') return; }
    if (pos === '2H' && d.fourWD) action('4wd');
    if (pos === '4H' && !d.fourWD) action('4wd');
  };
  cluster.cv.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    const h = hitTest(cluster, e); if (!h) return;
    const [lx, ly] = local(cluster, e);
    if (h.act === 'shift') { const gr = shifter.hit(lx - h.x, ly - h.y); if (gr !== null) gearTo(gr); }
    else if (h.act === 'transfer') { const pos = transfer.hit(lx - h.x, ly - h.y); if (pos) transferTo(pos); }
    else action(h.act);
  });
  mini.cv.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); action('map'); });
  tyreC.cv.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); const h = hitTest(tyreC, e); if (h) action(h.act); }); // [tyre pressure] AIR- / AIR+
  helpC.cv.addEventListener('pointerdown', (e) => { e.stopPropagation(); setHelpOpen(false); });

  // big map: click = waypoint, right-click = remove, drag = pan, wheel = zoom
  let drag = null;
  mapC.cv.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    const [x, y] = local(mapC, e);
    drag = { x, y, sx: x, sy: y, moved: false, button: e.button };
    mapC.cv.setPointerCapture(e.pointerId);
  });
  mapC.cv.addEventListener('pointermove', (e) => {
    if (!drag) { // [spawns] hover: signposts and list rows
      const [x, y] = local(mapC, e), inBox = (q) => q && x >= q.x && y >= q.y && x < q.x + q.w && y < q.y + q.h;
      const mk = big.inView(x, y) && !inBox(big.promptBox) ? big.markerHits.slice().reverse().find(inBox) : null;
      const row = big.hits.find((q) => q.act === 'spawnrow' && inBox(q));
      big.hover = mk ? mk.i : -1; big.rowHover = row ? row.i : -1;
      mapC.cv.style.cursor = mk || row || big.promptHits.some(inBox) || big.hits.some(inBox) ? 'pointer' : '';
      return;
    }
    const [x, y] = local(mapC, e);
    if (!drag.moved && Math.hypot(x - drag.sx, y - drag.sy) > 3 && big.inView(drag.sx, drag.sy)) drag.moved = true;
    if (drag.moved) { big.pan(x - drag.x, y - drag.y); drag.x = x; drag.y = y; }
  });
  mapC.cv.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.moved) return;
    const [x, y] = [d.sx, d.sy];
    const inBox = (q) => q && x >= q.x && y >= q.y && x < q.x + q.w && y < q.y + q.h;
    // [spawns] an open prompt takes the click: SPAWN / CANCEL, anything else just closes it
    if (big.prompt >= 0) {
      const ph = big.promptHits.find(inBox);
      if (ph && d.button === 0) { if (ph.act === 'confirm') confirmSpawn(); else big.prompt = -1; return; }
      if (inBox(big.promptBox)) return;
      const again = big.markerHits.slice().reverse().find(inBox) || big.hits.find((q) => q.act === 'spawnrow' && inBox(q));
      if (again && again.i === big.prompt && d.button === 0) { confirmSpawn(); return; } // a second click on the same point confirms
      big.prompt = -1;
      if (d.button === 0 && !again && big.inView(x, y)) return; // a click on the map only closes the prompt
    }
    const h = big.hits.find(inBox);
    if (h && d.button === 0) {
      if (h.act === 'tab') { big.tab = h.tab; big.prompt = -1; if (h.tab === 'spawn') { big.lastId = lastSpawn?.()?.id ?? null; if (big.sel < 0) selectSpawn(currentSpawnIndex(), false); } }
      else if (h.act === 'spawnrow') { selectSpawn(h.i, true); big.prompt = h.i; }
      else if (h.act === 'close') setMapOpen(false);
      else if (h.act === 'zin') big.zoomAt(big.mx + big.VW / 2, big.my + big.VH / 2, 1);
      else if (h.act === 'zout') big.zoomAt(big.mx + big.VW / 2, big.my + big.VH / 2, -1);
      else if (h.act === 'clear') { waypoints.clear(); toast('Waypoints cleared', 1.4); }
      else if (h.act === 'trail') { const t = TRAILS[h.i], m = pathPoint(t, t.length / 2); big.zi = Math.max(big.zi, 1); big.centreOn(m.x, m.z); big.clampView(); }
      return;
    }
    if (!big.inView(x, y)) return;
    const mk = d.button === 0 ? big.markerHits.slice().reverse().find(inBox) : null; // [spawns] topmost signpost
    if (mk) { selectSpawn(mk.i, false); big.prompt = mk.i; return; }
    const [wx, wz] = big.toWorld(x, y), r = 7 / big.z;
    const near = waypoints.nearest(wx, wz, r);
    if (d.button === 2) { if (near >= 0) { waypoints.remove(near); toast('Waypoint removed', 1.2); } return; }
    if (d.button !== 0) return;
    if (near >= 0) { waypoints.remove(near); toast('Waypoint removed', 1.2); return; }
    if (Math.abs(wx) > SIZE / 2 || Math.abs(wz) > SIZE / 2) return;
    const replaced = waypoints.add(wx, wz);
    toast(replaced ? `Waypoint limit is ${waypoints.max}: replaced the last one` : waypoints.list.length === 1 ? 'Waypoint set. Follow the red arrow' : `Waypoint ${waypoints.list.length} set`, 1.8);
  });
  mapC.cv.addEventListener('wheel', (e) => {
    e.stopPropagation(); e.preventDefault();
    const [x, y] = local(mapC, e);
    if (big.list && x >= big.mx + big.VW + 4) { big.scrollBy((e.deltaY > 0 ? 4 : -4) * big.list.rowH); return; } // [spawns] scroll the list, four rows a notch
    big.zoomAt(big.inView(x, y) ? x : big.mx + big.VW / 2, big.inView(x, y) ? y : big.my + big.VH / 2, e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  mapWrap.addEventListener('pointerdown', (e) => { if (e.target === mapWrap) setMapOpen(false); });

  // ------------------------------------------------------------ [spawns] spawn point picker
  // the row the list opens on: the last spawn point used, else the one nearest the truck
  function currentSpawnIndex() {
    const last = lastSpawn?.(), li = last ? spawns.findIndex((s) => s.id === last.id) : -1;
    if (li >= 0 && !last.default) return li;
    const p = lastS?.car?.chassis.translation();
    if (!p) return Math.max(0, li);
    let bi = 0, bd = Infinity;
    spawns.forEach((s, i) => { const dd = Math.hypot(s.x - p.x, s.z - p.z); if (dd < bd) { bd = dd; bi = i; } });
    return bi;
  }
  function selectSpawn(i, pan) {
    if (!spawns.length) return;
    big.sel = clamp(i, 0, spawns.length - 1);
    big.revealSel();
    if (pan && big.zi > 0) { const sp = spawns[big.sel]; big.centreOn(sp.x, sp.z); big.clampView(); }
  }
  function confirmSpawn() {
    const sp = spawns[big.prompt];
    big.prompt = -1;
    if (sp) onSpawn?.(sp);
  }
  function openSpawns() {
    if (!spawns.length) return;
    if (!mapOpen) setMapOpen(true, lastS);
    big.tab = 'spawn'; big.prompt = -1; big.lastId = lastSpawn?.()?.id ?? null;
    if (lastS) big.draw(mapC.g, mapSnapshot(lastS)); // lay the list out now so the selection can scroll into view
    selectSpawn(currentSpawnIndex(), true);
  }
  // Keys while the map shows the spawn list: arrows / PageUp / PageDown / Home / End select, Enter
  // opens the prompt, Enter again spawns. Returns true when the key was used (main.js then skips it).
  function mapKey(e) {
    if (!mapOpen || big.tab !== 'spawn' || !spawns.length) return false;
    const n = spawns.length, step = { ArrowUp: -1, ArrowDown: 1, PageUp: -8, PageDown: 8 }[e.code];
    if (step !== undefined) { big.prompt = -1; selectSpawn(big.sel < 0 ? 0 : clamp(big.sel + step, 0, n - 1), true); return true; }
    if (e.code === 'Home' || e.code === 'End') { big.prompt = -1; selectSpawn(e.code === 'Home' ? 0 : n - 1, true); return true; }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (e.repeat) return true;
      if (big.prompt >= 0) confirmSpawn(); else { if (big.sel < 0) selectSpawn(0, true); big.prompt = big.sel; }
      return true;
    }
    return false;
  }

  addEventListener('resize', layout);
  layout();

  // ------------------------------------------------------------ per-frame
  function mapSnapshot(S) { return { p: S.car.chassis.translation(), heading: S.car.attitude().heading, trails: S.game.trails, active: S.game.active, time: S.game.time, dist: S.game.dist, race: S.race, crawl: S.game.crawl }; }
  function update(dt, S) {
    lastS = S;
    clock += dt;
    if (toastT > 0 && !toastWait) { toastT -= dt; if (toastT <= 0) toastC.cv.classList.remove('show'); }
    if (bigT > 0) { bigT -= dt; if (bigT <= 0) { bigC.cv.classList.remove('show'); if (toastT > 0 && (toastWait || toastMoved)) renderToast(); } } // back home
    beacons?.update(clock);
    warnings.note(S.car.damageEvents); // [crash] seize / destroy messages, before main.js turns them into toasts
    acc += dt;
    if (acc < 1 / 30) return;
    const step = acc; acc = 0;
    drawCluster(S, step);
    drawChassis(S);
    drawEngine(S);
    drawTyre(S); // [tyre pressure]
    drawMini(S);
    if (mapOpen) big.draw(mapC.g, mapSnapshot(S));
  }

  return {
    update, setSpec, toast, bigMsg,
    nudgeShifter: () => shifter.nudge(),
    toggleMap: () => setMapOpen(!mapOpen, lastS),
    // [spawns] J: the map straight on the spawn list (again: close it); main.js routes keys through mapKey
    toggleSpawns() { if (mapOpen && big.tab === 'spawn') setMapOpen(false); else openSpawns(); },
    openSpawns, mapKey, closeMap: () => setMapOpen(false),
    toggleHelp: () => setHelpOpen(!helpOpen),
    // Esc: close the top overlay; true if one was open
    closeOverlay() { if (mapOpen && big.prompt >= 0) { big.prompt = -1; return true; } if (mapOpen) { setMapOpen(false); return true; } if (helpOpen) { setHelpOpen(false); return true; } return false; },
    get mapOpen() { return mapOpen; },
    waypoints,
    // for tests: stick position vs. the slot it should travel to, overlays, last toast, guidance angle
    debug: () => ({ layout: { scale, chassis: L.chassis, engine: L.engine, mini: L.mini, tyre: !!L.tyre, winch: !!L.winch, mapScale }, knob: [shifter.kx, shifter.ky], slot: shifter.slotOf(shifter.gear), gear: shifter.gear, moving: shifter.path.length > 0, mapOpen, helpOpen, lastToast, guideAng, wps: waypoints.list.slice(), map: big, spawn: { tab: big.tab, sel: big.sel, prompt: big.prompt, hover: big.hover, scroll: big.scroll } }),
  };
}
