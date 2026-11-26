// LowRange driving HUD, all pixel art: a wooden instrument board (tach, speedo, H-pattern stick,
// transfer lever, locker rockers, parking brake, pedal bars, lamps and buttons), the chassis board
// (pitch / roll inclinometers, wheels + suspension + surface card, damage), the framed minimap with a
// guidance plaque (or the race lap readout), the expandable map with waypoints, plank toasts, big race
// messages, the controls board (H) and the pause buttons on the menu.
// main.js owns the simulation; it hands this module a state snapshot every frame and gets actions back.
import './hud.css';
import * as THREE from 'three';
import { TRAILS, CHECKPOINTS, SIZE, heightAt, pathPoint } from '../terrain.js';
import { P, mk, rect, px, board, paper, inset, tiny, tinyMeasure, sign, drawText, measure, wrap, clamp, fmtT, fmtLap, spriteFrom, rotSprite, shape } from './px.js';
import { Dial, Shifter, TransferLever, ParkLever, drawLockers, drawPedals, drawLamp, drawIncl } from './instruments.js';
import { MapBases, BigMap, Waypoints, drawMinimap } from './mapview.js';
import { Beacons } from './beacon.js';

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

export function createHud({ action, camera, isRace, mapId, mapName, trees, scene, noOutline, controls, onResume, onRestart }) {
  const root = $('hud');
  const cluster = pixCanvas('hud-cluster', root);
  const chassis = pixCanvas('hud-chassis', root);
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
  const big = new BigMap({ bases, waypoints, isRace, mapName });
  const beacons = scene ? new Beacons(scene, heightAt, noOutline) : null;
  beacons?.sync(waypoints.list);
  waypoints.onChange = (l) => beacons?.sync(l);
  const ARROW = guideArrow();
  const trailEnds = TRAILS.map((t) => [pathPoint(t, 3), pathPoint(t, t.length - 3)]);

  let spec = null, scale = 2, mapScale = 2, clock = 0, acc = 0, last = null;
  let toastT = 0, bigT = 0, mapOpen = false, helpOpen = false, lastToast = '', guideAng = null;

  // ------------------------------------------------------------ layout
  function layout() {
    const dpr = devicePixelRatio || 1;
    scale = Math.max(2, Math.floor((innerHeight * dpr) / 400));
    mapScale = Math.max(2, Math.floor(Math.min((innerWidth * dpr * 0.94) / big.W, (innerHeight * dpr * 0.9) / big.H)));
    sizeCanvas(cluster, 283, 77, scale);
    sizeCanvas(chassis, 200, 60, scale);
    sizeCanvas(mini, 108, 146, scale);
    sizeCanvas(mapC, big.W, big.H, mapScale);
    if (toastC.w) sizeCanvas(toastC, toastC.w, toastC.h, scale);
    if (bigC.w) sizeCanvas(bigC, bigC.w, bigC.h, scale);
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
    // lamp strip + buttons
    let x = 5;
    const lamp = (label, state, act) => { const w = drawLamp(g, x, 63, label, state); cluster.hits.push({ x, y: 63, w, h: 10, act }); x += w + 2; };
    lamp('4WD', d.fourWD ? 'on' : null, '4wd');
    lamp('AIRED', car.airedDown ? 'on' : null, 'tyres');
    if (spec.rearSteer) lamp('R-STEER', car.rearSteerOn ? 'on' : null, 'rsteer');
    lamp(d.autoClutch ? 'AUTO-CL' : 'MANUAL', d.autoClutch ? 'good' : null, 'autoclutch');
    const stalled = !d.running;
    lamp(d.dead ? 'DEAD' : stalled ? 'STALL I' : 'ENGINE', stalled ? (Math.floor(clock * 3) % 2 ? 'warn' : 'on') : null, 'ignition');
    const btns = [['RECOVER', 'recover'], ['CAM', 'camera'], ['MAP', 'map'], ['HELP', 'help']];
    let bx = cluster.w - 5 - btns.reduce((a, [l]) => a + tinyMeasure(l) + 9, -2);
    for (const [l, act] of btns) { const w = drawLamp(g, bx, 63, l, (act === 'map' && mapOpen) || (act === 'help' && helpOpen) ? 'on' : null, 'button'); cluster.hits.push({ x: bx, y: 63, w, h: 10, act }); bx += w + 2; }
  }

  // ------------------------------------------------------------ chassis board
  function drawChassis(S) {
    const { car } = S, g = chassis.g;
    board(g, 0, 0, chassis.w, chassis.h, { seed: 6 });
    const att = car.attitude(), pd = att.pitch * 57.3, rd = att.roll * 57.3;
    drawIncl(g, 5, 4, pd, 'pitch', 38, clock);
    drawIncl(g, 52, 4, rd, 'roll', 30, clock);
    const pl = `PITCH ${Math.abs(pd).toFixed(0)}°${pd > 0.5 ? ' UP' : pd < -0.5 ? ' DN' : ''}`, rl = `ROLL ${Math.abs(rd).toFixed(0)}°${rd > 0.5 ? ' R' : rd < -0.5 ? ' L' : ''}`;
    tiny(g, pl, 27, 50, Math.abs(pd) > 38 ? P.redHi : P.paint, { align: 'center', shadow: P.ol });
    tiny(g, rl, 74, 50, Math.abs(rd) > 30 ? P.redHi : P.paint, { align: 'center', shadow: P.ol });
    // wheels card
    const X = 99, Y = 5, W = 96, H = 50, cx = X + 48;
    paper(g, X, Y, W, H, 5);
    const d = car.dt, axY = [Y + 10, Y + 30];
    rect(g, cx, axY[0], 1, axY[1] - axY[0], P.inkSoft);
    for (const [i, ay] of axY.entries()) {
      rect(g, X + 41, ay, 15, 1, P.inkSoft);
      const locked = i === 0 ? d.lockF : d.lockR, driven = i === 1 || d.fourWD;
      rect(g, cx - 2, ay - 2, 5, 5, P.ink); rect(g, cx - 1, ay - 1, 3, 3, locked ? P.red : driven ? P.paperShade : P.paper);
    }
    const comp = car.compression(), s = spec.susp, names = car.wheelState.map((ws) => ws);
    for (let i = 0; i < 4; i++) {
      const left = i % 2 === 0, front = i < 2, ws = names[i];
      const tx = left ? X + 35 : X + 55, ty = front ? Y + 4 : Y + 24;
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
      const bx = left ? X + 30 : X + 65;
      inset(g, bx, ty, 3, 13, P.paperShade);
      const c = clamp(comp[i], -s.droop - 0.15, s.bump + 0.15), f = clamp(0.5 - c / (s.bump + s.droop + 0.3), 0, 1);
      rect(g, bx, ty + 6, 3, 1, P.paperEdge);
      rect(g, bx - 1, ty + 1 + Math.round(f * 10), 5, 2, ws.grounded ? P.ink : P.inkSoft);
      // surface + status labels on the outside
      const MAT_NAME = S.matInfo[ws.mat];
      const lab = broken ? 'GONE' : flat ? 'FLAT' : ws.grounded ? MAT_NAME.name.toUpperCase() : 'AIR';
      const col = broken || flat ? P.red : ws.grounded ? P.ink : P.inkSoft;
      const sw = MAT_NAME.color.map((v) => Math.round(v * 255)), swc = `rgb(${sw.join(',')})`;
      if (left) { tiny(g, lab, X + 27, ty + 2, col, { align: 'right' }); if (ws.grounded && !broken) { rect(g, X + 23, ty + 8, 5, 4, P.ink); rect(g, X + 24, ty + 9, 3, 2, swc); } }
      else { tiny(g, lab, X + 70, ty + 2, col); if (ws.grounded && !broken) { rect(g, X + 70, ty + 8, 5, 4, P.ink); rect(g, X + 71, ty + 9, 3, 2, swc); } }
      if (suspHurt && !broken) tiny(g, 'SUSP', left ? X + 21 : X + 76, ty + 8, P.red, { align: left ? 'right' : 'left' });
    }
    // damage
    const H2 = car.health, pct = (v) => Math.round(v * 100), dc = (v) => (v > 0.75 ? P.greenDark : v > 0.35 ? P.amberDark : P.red);
    tiny(g, d.dead ? 'ENG DEAD' : `ENG ${pct(H2.engine)}%`, X + 5, Y + 42, d.dead ? P.red : dc(H2.engine));
    tiny(g, `BODY ${pct(H2.body)}%`, X + W - 5, Y + 42, dc(H2.body), { align: 'right' });
  }

  // ------------------------------------------------------------ guidance
  const camDir = new THREE.Vector3();
  let lastWpCheck = 0;
  function guidance(S, p) {
    const wp = waypoints.active;
    if (wp) return { target: wp, label: `WAYPOINT 1${waypoints.list.length > 1 ? ` OF ${waypoints.list.length}` : ''}`, wp: true };
    if (isRace) { const r = S.race; if (!r) return null; const c = CHECKPOINTS[r.next]; return { target: c, label: r.next ? `CHECKPOINT ${r.next}/${CHECKPOINTS.length - 1}` : 'START / FINISH' }; }
    const G = S.game;
    if (G.active) { const t = TRAILS[G.active.trail]; return { target: trailEnds[G.active.trail][1 - G.active.from], label: 'FINISH ' + t.name.toUpperCase() }; }
    let best = null, bd = Infinity;
    TRAILS.forEach((t, i) => { if (G.trails[i].done) return; trailEnds[i].forEach((e) => { const dd = Math.hypot(e.x - p.x, e.z - p.z); if (dd < bd) { bd = dd; best = { target: e, label: t.name.toUpperCase() }; } }); });
    return best;
  }

  function fit(text, maxW) { if (tinyMeasure(text) <= maxW) return text; let t = text; while (t.length > 2 && tinyMeasure(t + '.') > maxW) t = t.slice(0, -1); return t + '.'; }

  function drawMini(S) {
    const { car } = S, g = mini.g, p = car.chassis.translation(), { heading } = car.attitude();
    mini.hits = [{ x: 0, y: 0, w: 108, h: 106, act: 'map' }];
    board(g, 0, 0, mini.w, mini.h, { seed: 8, nails: false });
    inset(g, 3, 3, 102, 102, P.m1);
    drawMinimap(g, 4, 4, 100, { bases, p, heading, waypoints: waypoints.list, raceCp: isRace && S.race && S.race.racing ? CHECKPOINTS[S.race.next] : null, t: clock });
    // compass N
    rect(g, 6, 6, 7, 9, P.ol); rect(g, 7, 7, 5, 7, P.paper); tiny(g, 'N', 10, 8, P.redDark, { align: 'center' });
    // plaque
    paper(g, 4, 107, 100, 36, 11);
    const gd = guidance(S, p);
    camera.getWorldDirection(camDir);
    const tx = 4 + 11, ty = 107 + 11;
    rect(g, tx - 8, ty - 8, 17, 17, P.paperShade);
    if (gd) {
      const ang = Math.atan2(gd.target.x - p.x, -(gd.target.z - p.z)) - Math.atan2(camDir.x, -camDir.z);
      rotSprite(g, ARROW, tx, ty, ang); guideAng = Math.atan2(Math.sin(ang), Math.cos(ang));
    }
    const x0 = 25, mw = 104 - x0 - 2;
    let y = 110;
    const line = (txt, col) => { tiny(g, fit(txt, mw), x0, y, col); y += 8; };
    if (isRace && S.race) {
      const r = S.race;
      const dist = gd ? Math.hypot(gd.target.x - p.x, gd.target.z - p.z) : 0;
      if (r.wrong) line('WRONG WAY!', Math.floor(clock * 4) % 2 ? P.red : P.redDark);
      else line(gd ? `${gd.wp ? 'WP' : r.next ? 'CP ' + r.next + '/' + (CHECKPOINTS.length - 1) : 'FINISH'} ${Math.round(dist)} M` : '', P.ink);
      const row = (a, b, col = P.ink) => { tiny(g, a, x0, y, P.inkSoft); tiny(g, b, 102, y, col, { align: 'right' }); y += 8; };
      row(r.lap ? `LAP ${r.lap}` : r.holding ? 'WAIT' : 'GO TO LINE', r.started ? fmtLap(r.lapTime) : '-:--.-', P.ink);
      row('LAST', fmtLap(r.last));
      row('BEST', fmtLap(r.best), r.best != null ? P.redDark : P.inkSoft);
    } else {
      if (gd) {
        line(gd.label, gd.wp ? P.redDark : P.ink);
        line(`${Math.round(Math.hypot(gd.target.x - p.x, gd.target.z - p.z))} M`, P.inkSoft);
      } else { line('EVERY TRAIL DONE!', P.greenDark); y += 8; }
      const G = S.game;
      if (G.active) line(`RUN ${fmtT(G.active.t)}`, P.redDark);
      else line(`${fmtT(G.time)}  ${(G.dist / 1000).toFixed(2)} KM`, P.inkSoft);
      tiny(g, 'M MAP  H HELP', x0, 135, P.paperEdge);
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
    const lines = wrap(String(msg).replace(/[·•—–]/g, '-').replace(/✓/g, ''), 300);
    const tw = Math.max(...lines.map(measure));
    const w = tw + 22, h = lines.length * 10 + 13;
    sizeCanvas(toastC, w, h, scale);
    const g = toastC.g;
    g.clearRect(0, 0, w, h);
    board(g, 0, 0, w, h, { seed: 12, plankH: 30 });
    paper(g, 5, 4, w - 10, h - 8, 13);
    lines.forEach((l, i) => drawText(g, l, Math.round((w - measure(l)) / 2), 6 + i * 10, P.ink));
    toastC.cv.classList.add('show'); lastToast = String(msg);
    toastT = secs;
  }
  const BIG_COL = { count: [P.red, P.redDeep], go: [P.greenHi, P.greenDeep], best: [P.gold, P.w0], warn: [P.red, P.redDeep], '': [P.paint, P.ol] };
  function bigMsg(text, secs = 1.2, cls = '') {
    const sc = cls === 'warn' ? 3 : 5, w = measure(text) * sc + 8, h = 9 * sc + 8;
    sizeCanvas(bigC, w, h, scale);
    const g = bigC.g, [col, ol] = BIG_COL[cls] || BIG_COL[''];
    g.clearRect(0, 0, w, h);
    drawText(g, text, 4, 4, ol, { scale: sc, outline: ol });
    drawText(g, text, 4, 4, col, { scale: sc, shadow: ol });
    bigC.cv.classList.add('show');
    bigT = secs;
  }

  // ------------------------------------------------------------ help (controls board)
  function renderHelp() {
    const rows = controls();
    const keyW = Math.max(...rows.map(([k]) => tinyMeasure(k.toUpperCase()))) + 8;
    const descW = Math.max(...rows.map(([, v]) => measure(v)));
    const per = Math.ceil(rows.length / 2), colW = keyW + 6 + descW;
    const W = colW * 2 + 30, H = per * 12 + 40;
    const dpr = devicePixelRatio || 1;
    sizeCanvas(helpC, W, H, Math.max(1, Math.floor(Math.min((innerWidth * dpr * 0.94) / W, (innerHeight * dpr * 0.9) / H))));
    const g = helpC.g;
    board(g, 0, 0, W, H, { seed: 21 });
    sign(g, 'CONTROLS', 10, 6);
    tiny(g, 'H OR ESC TO CLOSE', W - 10, 9, P.paint, { align: 'right', shadow: P.ol });
    paper(g, 6, 18, W - 12, H - 24, 22);
    rows.forEach(([k, v], i) => {
      const col = i < per ? 0 : 1, r = i % per, x = 12 + col * (colW + 8), y = 23 + r * 12;
      const kw = tinyMeasure(k.toUpperCase()) + 7;
      rect(g, x, y, kw, 10, P.ol); rect(g, x + 1, y + 1, kw - 2, 8, P.w4); rect(g, x + 1, y + 1, kw - 2, 1, P.w5); rect(g, x + 1, y + 8, kw - 2, 1, P.w2);
      tiny(g, k.toUpperCase(), x + 4, y + 3, P.ink);
      drawText(g, v, x + keyW + 6, y + 1, P.ink);
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
    tiny(t.g, 'ESC RESUMES', 4, 26, P.paint, { shadow: P.ol });
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
    if (!drag) return;
    const [x, y] = local(mapC, e);
    if (!drag.moved && Math.hypot(x - drag.sx, y - drag.sy) > 3 && big.inView(drag.sx, drag.sy)) drag.moved = true;
    if (drag.moved) { big.pan(x - drag.x, y - drag.y); drag.x = x; drag.y = y; }
  });
  mapC.cv.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.moved) return;
    const [x, y] = [d.sx, d.sy];
    const h = big.hits.find((q) => x >= q.x && y >= q.y && x < q.x + q.w && y < q.y + q.h);
    if (h && d.button === 0) {
      if (h.act === 'close') setMapOpen(false);
      else if (h.act === 'zin') big.zoomAt(big.mx + big.VW / 2, big.my + big.VH / 2, 1);
      else if (h.act === 'zout') big.zoomAt(big.mx + big.VW / 2, big.my + big.VH / 2, -1);
      else if (h.act === 'clear') { waypoints.clear(); toast('Waypoints cleared', 1.4); }
      else if (h.act === 'trail') { const t = TRAILS[h.i], m = pathPoint(t, t.length / 2); big.zi = Math.max(big.zi, 1); big.centreOn(m.x, m.z); big.clampView(); }
      return;
    }
    if (!big.inView(x, y)) return;
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
    big.zoomAt(big.inView(x, y) ? x : big.mx + big.VW / 2, big.inView(x, y) ? y : big.my + big.VH / 2, e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  mapWrap.addEventListener('pointerdown', (e) => { if (e.target === mapWrap) setMapOpen(false); });

  addEventListener('resize', layout);
  layout();

  // ------------------------------------------------------------ per-frame
  function update(dt, S) {
    lastS = S;
    clock += dt;
    if (toastT > 0) { toastT -= dt; if (toastT <= 0) toastC.cv.classList.remove('show'); }
    if (bigT > 0) { bigT -= dt; if (bigT <= 0) bigC.cv.classList.remove('show'); }
    beacons?.update(clock);
    acc += dt;
    if (acc < 1 / 30) return;
    const step = acc; acc = 0;
    drawCluster(S, step);
    drawChassis(S);
    drawMini(S);
    if (mapOpen) {
      const p = S.car.chassis.translation();
      big.draw(mapC.g, { p, heading: S.car.attitude().heading, trails: S.game.trails, active: S.game.active, time: S.game.time, dist: S.game.dist, race: S.race });
    }
  }

  return {
    update, setSpec, toast, bigMsg,
    nudgeShifter: () => shifter.nudge(),
    toggleMap: () => setMapOpen(!mapOpen, lastS),
    toggleHelp: () => setHelpOpen(!helpOpen),
    // Esc: close the top overlay; true if one was open
    closeOverlay() { if (mapOpen) { setMapOpen(false); return true; } if (helpOpen) { setHelpOpen(false); return true; } return false; },
    get mapOpen() { return mapOpen; },
    waypoints,
    // for tests: stick position vs. the slot it should travel to, overlays, last toast, guidance angle
    debug: () => ({ knob: [shifter.kx, shifter.ky], slot: shifter.slotOf(shifter.gear), gear: shifter.gear, moving: shifter.path.length > 0, mapOpen, helpOpen, lastToast, guideAng, wps: waypoints.list.slice(), map: big }),
  };
}
