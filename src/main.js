import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt, visualHeightAt, MAT, MAT_INFO, SIZE, RES, GRID, ROADS, TRAILS, DIFF, pathPoint } from './terrain.js';
import { MAPS, MAP_ID, MAP_KIND, MAP_NAME, SPAWN, TRACK, CHECKPOINTS } from './terrain.js';
import { RaceLaps, fmtLap } from './race.js';
import { buildRaceDressing } from './race_view.js';
import { VEHICLES } from './specs.js';
import { Vehicle } from './vehicle.js';
import { VehicleView } from './vehicle_view.js';
import { buildTerrainMesh, buildRocks, buildTrees, buildMarkers, buildMinimapBase, setGateDone } from './world_view.js';
import { EngineAudio } from './audio.js';
import { applyBuild, loadBuild, isStock, stats } from './garage.js';
import { Garage } from './garage_ui.js';
import { initSettings } from './settings.js';
import './platform.js';

const H = 1 / 200;           // physics step
const MAX_STEPS = 12;        // per frame; beyond this the game slows down instead of spiralling
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

await RAPIER.init();

// ---------------- world ----------------
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = H;
world.numSolverIterations = 8;
await window.__loadStage?.('Planting trees');
const rocks = generateRocks();
const trees = generateTrees(rocks);
const terrain = buildTerrainPhysics(RAPIER, world, rocks, trees);

// ---------------- rendering ----------------
await window.__loadStage?.('Fuelling up');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = 0xc9b79a;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 90, 330);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 900);

scene.add(new THREE.HemisphereLight(0xfff1dc, 0x5a4a38, 1.25));
const sun = new THREE.DirectionalLight(0xffe2b8, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -28; sc.right = 28; sc.top = 28; sc.bottom = -28; sc.near = 1; sc.far = 160;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(-0.45, 0.8, 0.35).normalize();

scene.add(buildTerrainMesh());
scene.add(buildRocks(rocks));
scene.add(buildTrees(trees));
const isRace = MAP_KIND === 'race';
const gates = isRace ? [] : buildMarkers(scene); // [start0, end0, start1, end1, ...]
const raceView = isRace ? buildRaceDressing(scene) : null;
const minimap = buildMinimapBase(220);
// distant ground beyond the map edge
const outer = new THREE.Mesh(new THREE.RingGeometry(SIZE * 0.68, 900, 32), new THREE.MeshStandardMaterial({ color: 0x6f6250, flatShading: true }));
outer.rotation.x = -Math.PI / 2; outer.position.y = 18;
scene.add(outer);

// ---------------- particles (dust, mud, sand) ----------------
const PMAX = 700;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(PMAX * 3), pCol = new Float32Array(PMAX * 3);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const pMat = new THREE.PointsMaterial({ size: 0.2, vertexColors: true, transparent: true, opacity: 0.32, depthWrite: false });
const points = new THREE.Points(pGeo, pMat);
points.frustumCulled = false;
scene.add(points);
const parts = Array.from({ length: PMAX }, () => ({ life: 0, x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0, r: 0, g: 0, b: 0 }));
let pNext = 0;
const dustAcc = [0, 0, 0, 0];
function emit(x, y, z, vx, vy, vz, col, life) {
  const p = parts[pNext]; pNext = (pNext + 1) % PMAX;
  Object.assign(p, { x, y, z, vx, vy, vz, life, r: col[0], g: col[1], b: col[2] });
}
function updateParticles(dt) {
  for (let i = 0; i < PMAX; i++) {
    const p = parts[i];
    if (p.life > 0) {
      p.life -= dt; p.vy -= 1.5 * dt; const drag = Math.exp(-2.5 * dt); p.vx *= drag; p.vz *= drag; p.vy *= drag;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.life <= 0) p.y = -999;
    }
    pPos[i * 3] = p.x; pPos[i * 3 + 1] = p.y; pPos[i * 3 + 2] = p.z;
    pCol[i * 3] = p.r; pCol[i * 3 + 1] = p.g; pCol[i * 3 + 2] = p.b;
  }
  pGeo.attributes.position.needsUpdate = true; pGeo.attributes.color.needsUpdate = true;
}

// ---------------- game state ----------------
const audio = new EngineAudio();
initSettings({ renderer, scene, sun, camera, audio });
let car = null, view = null, spec = null;
let selected = 0;
let playing = false;
let started = false;
// Trails: drive through either end gate to start, out the other end to finish.
const game = { time: 0, dist: 0, done: false, trails: TRAILS.map(() => ({ done: false, best: null })), active: null };
const SYM = { green: '●', blue: '■', black: '◆', dblack: '◆◆' };
const symHtml = (d) => `<span class="sym" style="width:22px;color:${d === 'green' || d === 'blue' ? DIFF[d].color : '#111'};text-shadow:0 0 2px #fff">${SYM[d]}</span>`;
const trailEnds = TRAILS.map((t) => [pathPoint(t, 3), pathPoint(t, t.length - 3)]);
const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function updateTrails(p) {
  TRAILS.forEach((t, i) => {
    trailEnds[i].forEach((e, end) => {
      const near = Math.hypot(e.x - p.x, e.z - p.z) < t.width / 2 + 2.5 && Math.abs(heightAt(e.x, e.z) - p.y) < 4;
      if (!near) return;
      const a = game.active;
      if (a && a.trail === i && a.from !== end && a.t > 4) {
        // finished
        const st = game.trails[i];
        const first = !st.done;
        st.done = true; st.best = st.best === null ? a.t : Math.min(st.best, a.t);
        setGateDone(gates[i * 2]); setGateDone(gates[i * 2 + 1]);
        toast(`${t.name} complete in ${fmtT(a.t)}${first ? '' : ' (best ' + fmtT(st.best) + ')'}`, 4);
        game.active = null;
        if (game.trails.every((x) => x.done) && !game.done) { game.done = true; toast(`All five trails conquered! Total ${fmtT(game.time)}`, 6); }
      } else if (!a || a.trail !== i) {
        game.active = { trail: i, from: end, t: 0 };
        toast(`${t.name} · ${DIFF[t.diff].label}. Good luck!`, 2.5);
      }
    });
  });
}
const input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const keys = new Set();
let crawlLimit = false;

// ---------------- garage builds ----------------
// The spec that gets driven: the base rig from specs.js with its saved garage build applied.
const builtSpec = (i) => applyBuild(VEHICLES[i], loadBuild(VEHICLES[i]));
const buildKey = (s) => s.id + JSON.stringify(s.build);

function spawn(i, opts) {
  if (car) { car.destroy(); view.dispose(); }
  spec = builtSpec(i);
  const y = heightAt(SPAWN.x, SPAWN.z) + spec.tire.radius - spec.axleY + 0.15;
  car = new Vehicle(RAPIER, world, spec, terrain, { x: SPAWN.x, y, z: SPAWN.z }, SPAWN.yaw);
  view = new VehicleView(scene, car);
  car.dt.autoClutch = opts.auto;
  car.airedDown = opts.air;
  if (opts.low && spec.ranges.low) { car.dt.range = 'low'; car.dt.fourWD = true; }
  car.dt.gear = 0;
  camState.heading = 0;
  if (isRace) raceOnSpawn();
  buildWheelHud();
}

// Swap in a brand-new (fully repaired) truck at a pose, keeping the driver's settings.
function respawnFresh(x, z, yaw, lift = 0.3) {
  const old = car.dt, aired = car.airedDown, rsteer = car.rearSteerOn;
  car.destroy(); view.dispose();
  const y = heightAt(x, z) + spec.tire.radius - spec.axleY + lift;
  car = new Vehicle(RAPIER, world, spec, terrain, { x, y, z }, yaw);
  view = new VehicleView(scene, car);
  const d = car.dt;
  d.autoClutch = old.autoClutch; d.range = old.range; d.fourWD = old.fourWD; d.lockF = old.lockF; d.lockR = old.lockR; d.gear = 0;
  car.airedDown = aired; car.rearSteerOn = rsteer;
  camState.heading = yaw; camState.yaw = 0;
}

// Which trail (if any) the truck is on: the active run, else the trail corridor under it.
function trailUnderTruck() {
  if (game.active) return { trail: game.active.trail, from: game.active.from };
  const p = car.chassis.translation();
  const ix = clamp(Math.round((p.x + SIZE / 2) / (SIZE / RES)), 0, RES), iz = clamp(Math.round((p.z + SIZE / 2) / (SIZE / RES)), 0, RES);
  const id = GRID.path[ix * (RES + 1) + iz] - ROADS.length;
  return id >= 0 && id < TRAILS.length ? { trail: id, from: 0 } : null;
}

// Backspace: right the truck and repair it on the spot (trail run keeps going).
function recover() {
  if (!car) return;
  if (isRace) { raceRecover(); return; }
  const p = car.chassis.translation();
  const { heading } = car.attitude();
  const keep = game.active;
  respawnFresh(p.x, p.z, heading, 1.0);
  game.active = keep;
  toast('Repaired and back on your wheels', 2);
}

// Y: restart the trail you're on from its start.
function restartTrail() {
  if (!car) return;
  if (isRace) { raceRestart(); return; }
  const on = trailUnderTruck();
  if (!on) { toast('You are not on a trail'); return; }
  {
    // on a trail: back to the start you entered from, repaired, timer restarted
    const t = TRAILS[on.trail];
    const p = pathPoint(t, on.from === 0 ? 7 : t.length - 7);
    const yaw = on.from === 0 ? Math.atan2(-p.tx, -p.tz) : Math.atan2(p.tx, p.tz);
    respawnFresh(p.x, p.z, yaw);
    game.active = { trail: on.trail, from: on.from, t: 0 };
    toast(`Back to the start of ${t.name}, fully repaired`, 2.5);
  }
}

// ---------------- race mode ----------------
// Lap timing lives in race.js; this glues it to the truck, the HUD and the gantry lights.
let race = null, bigTimer = 0, goLights = 0, shownCp = null;
const raceHold = { throttle: 0, brake: 1, steer: 0, handbrake: true }; // held on the line during the countdown
function bigMsg(text, secs = 1.2, cls = '') { const el = $('bigmsg'); el.textContent = text; el.className = 'show ' + cls; bigTimer = secs; }
function raceGearing() { const d = car.dt; d.range = 'high'; d.fourWD = true; d.gear = d.autoClutch ? 1 : 0; }

function raceOnSpawn() {
  raceGearing();
  camState.heading = SPAWN.yaw;
  race = new RaceLaps(TRACK, CHECKPOINTS, spec.id);
  raceView.setLights(0);
}
function raceStart() { race.startCountdown(3); bigMsg('3', 1, 'count'); goLights = 0; }

// Backspace: repaired, back just past the last checkpoint you passed; the clock keeps running
function raceRecover() {
  const r = race.poseForReset();
  respawnFresh(r.x, r.z, r.yaw, 0.6);
  raceGearing();
  race.teleported();
  toast(race.lastCp ? `Back at checkpoint ${race.lastCp}, repaired` : 'Back at the start line, repaired', 2);
}
// Y: back to the grid for a fresh countdown
function raceRestart() {
  respawnFresh(SPAWN.x, SPAWN.z, SPAWN.yaw, 0.15);
  raceGearing();
  race.teleported();
  raceStart();
  toast('Race restarted. Wait for the lights.', 2);
}

function raceUpdate(dt) {
  for (const e of race.update(dt, car.chassis.translation(), car.chassis.linvel())) {
    if (e.type === 'count') bigMsg(String(e.n), 1, 'count');
    else if (e.type === 'go') { bigMsg('GO!', 1.2, 'go'); raceView.setLights('go'); goLights = 2.5; }
    else if (e.type === 'lapstart') toast('Lap 1: the clock is running', 1.6);
    else if (e.type === 'cp') toast(`Checkpoint ${e.cp}/${e.of} · ${fmtLap(e.split)}`, 1.4);
    else if (e.type === 'lap') { bigMsg(fmtLap(e.time), 2.5, e.best ? 'best' : ''); toast(`Lap ${e.lap}: ${fmtLap(e.time)}${e.best ? ' · NEW BEST' : ` (best ${fmtLap(race.best)})`}`, 3.5); }
    else if (e.type === 'missed') toast(`Missed checkpoint ${e.cp}! Go back through it`, 3);
  }
  if (race.holding) raceView.setLights(Math.min(5, Math.floor((3 - race.count) / 0.6) + 1));
  else if (goLights > 0) { goLights -= dt; if (goLights <= 0) raceView.setLights(0); }
  const cp = race.racing ? race.next : -1;
  if (cp !== shownCp) { raceView.setNextCp(cp); shownCp = cp; }
  if (race.wrong) bigMsg('WRONG WAY', 0.3, 'warn');
  if (bigTimer > 0) { bigTimer -= dt; if (bigTimer <= 0) $('bigmsg').className = ''; }
}

function raceHud(p) {
  const row = (nm, val, cls = '') => `<div class="tr ${cls}"><span class="nm">${nm}</span><em>${val}</em></div>`;
  $('trailList').innerHTML = [
    row(race.lap ? `Lap ${race.lap}` : race.holding ? 'Wait for the lights' : 'Cross the start line', race.started ? fmtLap(race.lapTime) : '—', 'act'),
    row('Last lap', fmtLap(race.last)),
    row(`Best · ${spec.name}`, fmtLap(race.best), race.best != null ? 'done' : ''),
  ].join('');
  $('timer').textContent = `Race ${fmtLap(race.total)} · ${(game.dist / 1000).toFixed(2)} km`;
  const c = CHECKPOINTS[race.next];
  const dist = Math.hypot(c.x - p.x, c.z - p.z);
  $('nextFlag').textContent = race.wrong ? 'Wrong way! Turn around' : `${race.next ? 'Checkpoint ' + race.next + '/' + (CHECKPOINTS.length - 1) : 'Start / finish'} · ${dist.toFixed(0)} m`;
  const camDir = new THREE.Vector3(); camera.getWorldDirection(camDir);
  $('arrow').style.transform = `rotate(${Math.atan2(c.x - p.x, -(c.z - p.z)) - Math.atan2(camDir.x, -camDir.z)}rad)`;
}

// ---------------- HUD ----------------
let toastTimer = 0;
function toast(msg, secs = 2.2) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); toastTimer = secs; }

const arcPath = (cx, cy, r, a0, a1) => {
  const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};
const TA0 = Math.PI * 0.8, TA1 = Math.PI * 2.2;
$('tachBg').setAttribute('d', arcPath(85, 72, 58, TA0, TA1));

function buildWheelHud() {
  const names = ['FL', 'FR', 'RL', 'RR'];
  $('wheels').innerHTML = names.map((n, i) => `
    <div class="wh">${i % 2 === 0 ? `<div class="m"><b id="wm${i}">—</b>${n}</div>` : ''}
      <div class="trav"><i id="wt${i}"></i></div><div class="tyre" id="wy${i}"></div>
      ${i % 2 === 1 ? `<div class="m"><b id="wm${i}">—</b>${n}</div>` : ''}</div>`).join('');
  const redFrom = TA0 + (TA1 - TA0) * (spec.engine.redline * 0.92) / (spec.engine.redline * 1.1);
  $('tachRed').setAttribute('d', arcPath(85, 72, 58, redFrom, TA1));
}

const lamp = (id, on, cls = 'on') => { const el = $(id); el.className = 'lamp' + (on ? ' ' + cls : ''); };
let hudAcc = 0;
function updateHud(dt) {
  if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $('toast').classList.remove('show'); }
  hudAcc += dt;
  if (hudAcc < 1 / 30) return;
  hudAcc = 0;
  const d = car.dt, e = spec.engine;
  const rpm = Math.max(0, d.rpm);
  const frac = clamp(rpm / (e.redline * 1.1), 0, 1);
  $('tachFg').setAttribute('d', frac > 0.002 ? arcPath(85, 72, 58, TA0, TA0 + (TA1 - TA0) * frac) : '');
  $('tachFg').setAttribute('stroke', rpm > e.redline * 0.92 ? '#ff5a3d' : '#ffb340');
  $('rpmTxt').textContent = Math.round(rpm);
  $('gear').textContent = d.gearLabel;
  $('range').textContent = d.range === 'low' ? '4-LO' : d.fourWD ? '4-HI' : '2-HI';
  $('range').style.color = d.range === 'low' ? '#ffb340' : '';
  const kmh = car.speed() * 3.6;
  $('speed').innerHTML = `${Math.abs(kmh).toFixed(1)}<small>km/h</small>`;
  lamp('l4wd', d.fourWD); lamp('lF', d.lockF); lamp('lR', d.lockR);
  lamp('lAir', car.airedDown); lamp('lRS', car.rearSteerOn);
  lamp('lEng', !d.running, 'warn'); $('lEng').textContent = d.running ? 'ENGINE' : 'STALLED · I';
  lamp('lAC', d.autoClutch); $('lAC').textContent = d.autoClutch ? 'AUTO-CL' : 'MANUAL CL';
  $('bT').style.height = `${input.throttle * 100}%`;
  $('bB').style.height = `${input.brake * 100}%`;
  $('bC').style.height = `${(1 - d.engagement) * 100}%`;
  const att = car.attitude();
  const pd = att.pitch * 57.3, rd = att.roll * 57.3;
  $('pitchIcon').setAttribute('transform', `rotate(${(-pd).toFixed(1)})`);
  $('rollIcon').setAttribute('transform', `rotate(${(rd).toFixed(1)})`);
  $('pitchTxt').textContent = `${Math.abs(pd).toFixed(0)}° ${pd > 0.5 ? 'up' : pd < -0.5 ? 'down' : ''}`;
  $('rollTxt').textContent = `${Math.abs(rd).toFixed(0)}°`;
  $('pitchTxt').className = Math.abs(pd) > 38 ? 'warn' : '';
  $('rollTxt').className = Math.abs(rd) > 30 ? 'warn' : '';
  const H2 = car.health, pct = (x) => Math.round(x * 100);
  const cls = (x) => (x > 0.75 ? '' : x > 0.35 ? 'mid' : 'bad');
  $('dmg').innerHTML = `<span class="${cls(H2.engine)}">ENGINE ${car.dt.dead ? 'DEAD' : pct(H2.engine) + '%'}</span><span class="${cls(H2.body)}">BODY ${pct(H2.body)}%</span>`;
  const comp = car.compression();
  const s = spec.susp;
  for (let i = 0; i < 4; i++) {
    const ws = car.wheelState[i];
    const c = clamp(comp[i], -s.droop - 0.15, s.bump + 0.15);
    const f = 0.5 - c / ((s.bump + s.droop + 0.3)) ; // 0 top .. 1 bottom
    $(`wt${i}`).style.top = `${clamp(f, 0, 1) * 40}px`;
    const tyre = $(`wy${i}`);
    tyre.className = 'tyre ' + (!ws.grounded ? 'air' : ws.slip > 0.7 ? 'slip' : 'grip');
    const col = MAT_INFO[ws.mat].color;
    tyre.style.background = `rgb(${col.map((x) => Math.round(x * 255)).join(',')})`;
    $(`wm${i}`).textContent = car.broken[i] ? 'GONE' : car.health.tire[i] < 0.35 ? 'FLAT' : ws.grounded ? MAT_INFO[ws.mat].name : 'Air';
    tyre.style.outline = car.broken[i] ? '2px solid #c0392b' : car.health.susp[i] < 0.75 ? '2px solid #ff7a3d' : 'none';
  }
  // objectives
  if (isRace) { const p = car.chassis.translation(); raceHud(p); drawMinimap(p); return; }
  $('trailList').innerHTML = TRAILS.map((t, i) => {
    const st = game.trails[i], act = game.active && game.active.trail === i;
    return `<div class="tr${st.done ? ' done' : ''}${act ? ' act' : ''}">${symHtml(t.diff)}<span class="nm">${t.name}</span><em>${act ? fmtT(game.active.t) : st.done ? '✓ ' + fmtT(st.best) : ''}</em></div>`;
  }).join('');
  $('timer').textContent = `${fmtT(game.time)} · ${(game.dist / 1000).toFixed(2)} km`;
  const p = car.chassis.translation();
  // guide arrow: to the active trail's far end, else the nearest unfinished trail end
  let target = null, label = '';
  if (game.active) { const t = TRAILS[game.active.trail]; target = trailEnds[game.active.trail][1 - game.active.from]; label = 'Finish: ' + t.name; }
  else {
    let bestD = Infinity;
    TRAILS.forEach((t, i) => { if (game.trails[i].done) return; trailEnds[i].forEach((e) => { const d = Math.hypot(e.x - p.x, e.z - p.z); if (d < bestD) { bestD = d; target = e; label = t.name; } }); });
  }
  if (target) {
    const dist = Math.hypot(target.x - p.x, target.z - p.z);
    $('nextFlag').textContent = `${label} · ${dist.toFixed(0)} m`;
    const camDir = new THREE.Vector3(); camera.getWorldDirection(camDir);
    const ang = Math.atan2(target.x - p.x, -(target.z - p.z)) - Math.atan2(camDir.x, -camDir.z);
    $('arrow').style.transform = `rotate(${ang}rad)`;
  } else $('nextFlag').textContent = 'Every trail done!';
  drawMinimap(p);
}

const mmCtx = $('minimap').getContext('2d');
function drawMinimap(p) {
  mmCtx.drawImage(minimap.canvas, 0, 0);
  if (isRace && race) { // ring the checkpoint you need next
    const c = CHECKPOINTS[race.next];
    mmCtx.strokeStyle = '#ffb340'; mmCtx.lineWidth = 2.5; mmCtx.beginPath(); mmCtx.arc(minimap.toPx(c.x), minimap.toPx(c.z), 9, 0, Math.PI * 2); mmCtx.stroke();
  }
  const { heading } = car.attitude();
  const x = minimap.toPx(p.x), y = minimap.toPx(p.z);
  mmCtx.save(); mmCtx.translate(x, y); mmCtx.rotate(-heading);
  mmCtx.fillStyle = '#ffb340'; mmCtx.strokeStyle = '#000'; mmCtx.lineWidth = 1.5;
  mmCtx.beginPath(); mmCtx.moveTo(0, -8); mmCtx.lineTo(5, 6); mmCtx.lineTo(0, 3); mmCtx.lineTo(-5, 6); mmCtx.closePath(); mmCtx.fill(); mmCtx.stroke();
  mmCtx.restore();
}

// ---------------- camera ----------------
const CAM_MODES = ['Chase', 'Hood', 'Spotter', 'Wheel'];
const camState = { mode: 0, yaw: 0, pitch: 0.32, dist: 9, lastDrag: -10, heading: 0, spot: null, dragging: false };
let clock = 0;
renderer.domElement.addEventListener('pointerdown', (e) => { camState.dragging = true; camState.px = e.clientX; camState.py = e.clientY; });
addEventListener('pointerup', () => { camState.dragging = false; });
addEventListener('pointermove', (e) => {
  if (!camState.dragging) return;
  camState.yaw -= (e.clientX - camState.px) * 0.006;
  camState.pitch = clamp(camState.pitch + (e.clientY - camState.py) * 0.004, -0.15, 1.35);
  camState.px = e.clientX; camState.py = e.clientY; camState.lastDrag = clock;
});

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _t = new THREE.Vector3();
// frame-rate independent exponential smoothing factor
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const camTarget = new THREE.Vector3();
let camTargetInit = false;
function updateCamera(dt) {
  const p = car.chassis.translation(), q = car.chassis.rotation();
  _q.set(q.x, q.y, q.z, q.w);
  // smoothed look-at point: follows the truck closely sideways, but soaks up the
  // vertical bounce of crawling over rocks so the picture doesn't shake
  if (!camTargetInit || camTarget.distanceTo(_t.set(p.x, p.y + 0.9, p.z)) > 15) { camTarget.set(p.x, p.y + 0.9, p.z); camTargetInit = true; }
  camTarget.x += (p.x - camTarget.x) * damp(14, dt);
  camTarget.z += (p.z - camTarget.z) * damp(14, dt);
  camTarget.y += (p.y + 0.9 - camTarget.y) * damp(4, dt);
  const target = _t.copy(camTarget);
  const mode = CAM_MODES[camState.mode];
  if (mode === 'Chase') {
    const { heading } = car.attitude();
    let dh = heading - camState.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    camState.heading += dh * damp(2.2, dt);
    if (clock - camState.lastDrag > 2.5 && !camState.dragging) camState.yaw *= Math.max(0, 1 - dt * 1.5);
    const yaw = camState.heading + camState.yaw;
    const cp = Math.cos(camState.pitch), d = camState.dist;
    _v.set(target.x + Math.sin(yaw) * cp * d, target.y + Math.sin(camState.pitch) * d, target.z + Math.cos(yaw) * cp * d);
    _v.y = Math.max(_v.y, visualHeightAt(_v.x, _v.z) + 0.6);
    camera.position.lerp(_v, damp(7, dt));
    camera.lookAt(target);
  } else if (mode === 'Hood') {
    const [, ch] = spec.chassis.size;
    const seat = spec.body === 'buggy' ? 0.95 : spec.body === 'pickup' ? 1.2 : 1.5;
    const zz = spec.body === 'truck' ? -spec.chassis.size[2] * 0.36 : spec.body === 'pickup' ? -0.3 : 0.25;
    camera.position.set(-0.3, ch / 2 + seat, zz).applyQuaternion(_q).add(p);
    // seat-mounted view: filter the cab's rattle out of the rotation
    const want = _q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.12 + camState.pitch * 0.2 - 0.064, camState.yaw, 0, 'YXZ')));
    camera.quaternion.slerp(want, damp(9, dt));
  } else if (mode === 'Spotter') {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_q); fwd.y = 0; fwd.normalize();
    if (!camState.spot || camState.spot.distanceTo(target) > 22 || camState.spot.distanceTo(target) < 3) {
      const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
      camState.spot = new THREE.Vector3(p.x, 0, p.z).addScaledVector(fwd, 9).addScaledVector(side, 3);
      camState.spot.y = visualHeightAt(camState.spot.x, camState.spot.z) + 1.7;
    }
    camera.position.copy(camState.spot);
    camera.lookAt(target.x, p.y + 0.3, target.z);
  } else {
    const w = car.wheels[0].translation();
    camera.position.set(-(spec.track / 2 + 0.9), spec.axleY + 0.35, -spec.wheelbase / 2 - 1.3).applyQuaternion(_q).add(p);
    camera.lookAt(w.x, w.y, w.z);
  }
  // shadow camera follows the truck
  sun.position.copy(target).addScaledVector(SUN_DIR, 80);
  sun.target.position.copy(target);
}

// ---------------- input ----------------
const CONTROLS = [
  ['W / S', 'throttle / brake'], ['A / D', 'steer'], ['Space', 'clutch (hold)'], ['Shift', 'crawl throttle (35%)'],
  ['Mouse wheel', 'shift up / down'], ['R', 'high / low range'], ['Q / E', 'front / rear locker'], ['F', '2WD / 4WD'],
  ['G', 'rear steer (Goat)'], ['T', 'air down / up'], ['B', 'handbrake'], ['I', 'start engine'],
  ['C', 'auto-clutch on/off'], ['Backspace', isRace ? 'repair, back to last checkpoint' : 'repair + right the truck, on the spot'], ['Y', isRace ? 'restart the race' : 'restart current trail'], ['V', 'camera'], ['Z / X', 'zoom in / out'],
  ['Mouse drag', 'orbit camera'], ['M', 'mute'], ['Gamepad', 'RT/LT pedals, RB/LB shift, X clutch'], ['H / Esc', 'help / garage'],
];
const controlsHtml = CONTROLS.map(([k, v]) => `<span><kbd>${k}</kbd> ${v}</span>`).join('');
$('helpBox').innerHTML = controlsHtml;
$('menuControls').innerHTML = controlsHtml;

// keyboard key -> action
const KEYMAP = {
  KeyR: 'range', KeyQ: 'lockF', KeyE: 'lockR', KeyF: '4wd', KeyG: 'rsteer', KeyT: 'tyres', KeyI: 'ignition',
  KeyC: 'autoclutch', Backspace: 'recover', KeyY: 'restart', KeyV: 'camera', KeyM: 'mute', KeyH: 'help',
  PageUp: 'up', PageDown: 'down',
};

function action(name) {
  if (!car) return;
  const d = car.dt;
  const kmh = Math.abs(car.speed() * 3.6);
  let msg = null;
  switch (name) {
    case 'up': msg = d.shift(1, kmh); msg ? audio.grind() : audio.clunk(); break;
    case 'down': msg = d.shift(-1, kmh); msg ? audio.grind() : audio.clunk(); break;
    case 'range': msg = d.toggleRange(kmh); if (msg) audio.grind(); else { audio.clunk(); toast(d.range === 'low' ? '4-LOW: crawl ratio ' + (spec.gears[0] * spec.ranges.low * spec.final).toFixed(0) + ':1' : 'HIGH range'); } break;
    case '4wd': msg = d.toggle4WD(); if (!msg) toast(d.fourWD ? '4WD engaged' : '2WD (rear only)'); break;
    case 'lockF': if (!spec.lockers.front) msg = 'No front locker on the ' + spec.name; else { d.lockF = !d.lockF; audio.clunk(); toast(d.lockF ? 'Front locker ON' : 'Front locker off'); } break;
    case 'lockR': if (!spec.lockers.rear) msg = 'No rear locker on the ' + spec.name; else { d.lockR = !d.lockR; audio.clunk(); toast(d.lockR ? 'Rear locker ON' : 'Rear locker off'); } break;
    case 'rsteer': if (!spec.rearSteer) msg = 'Rear steer is only on the Billy Goat'; else { car.rearSteerOn = !car.rearSteerOn; toast(car.rearSteerOn ? 'Rear steer ON (counter-phase)' : 'Rear steer locked'); } break;
    case 'tyres': if (kmh > 3) msg = 'Stop to change tyre pressure'; else { car.airedDown = !car.airedDown; toast(car.airedDown ? 'Aired down to 10 psi: more grip on rock and sand' : 'Aired up to 32 psi'); } break;
    case 'ignition': if (d.running) msg = 'Engine already running'; else { msg = d.startEngine(); if (!msg) audio.starter(); } break;
    case 'autoclutch': d.autoClutch = !d.autoClutch; toast(d.autoClutch ? 'Auto-clutch ON' : 'Manual clutch: Space is your clutch pedal. Stalls are real now.'); break;
    case 'recover': recover(); break;
    case 'restart': restartTrail(); break;
    case 'camera': camState.mode = (camState.mode + 1) % CAM_MODES.length; camState.spot = null; toast(CAM_MODES[camState.mode] + ' camera', 1.2); break;
    case 'mute': audio.setMuted(!audio.muted); toast(audio.muted ? 'Muted' : 'Sound on', 1.2); break;
    case 'help': $('help').classList.toggle('hidden'); break;
  }
  if (msg) toast(msg);
}

addEventListener('keydown', (e) => {
  if (e.code === 'Escape' || e.code === 'Tab') { e.preventDefault(); keys.clear(); if (playing) openMenu(); return; }
  if (!playing) { if (e.code === 'Enter') startDrive(); return; }
  if (['Space', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(e.code)) e.preventDefault();
  if (!e.repeat && KEYMAP[e.code]) action(KEYMAP[e.code]);
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));
// never leave a pedal held when the page loses focus or the key-up is swallowed
addEventListener('blur', () => keys.clear());
document.addEventListener('visibilitychange', () => keys.clear());
addEventListener('contextmenu', (e) => e.preventDefault());

// mouse wheel shifts gears: one notch = one gear (trackpads send many small deltas)
let wheelAcc = 0, wheelCool = 0;
addEventListener('wheel', (e) => {
  if (!playing) return;
  e.preventDefault();
  wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  const now = performance.now();
  if (now < wheelCool) return;
  if (Math.abs(wheelAcc) >= 40) {
    action(wheelAcc < 0 ? 'up' : 'down');
    wheelAcc = 0; wheelCool = now + 140;
  }
}, { passive: false });

// the cluster lamps are buttons too
for (const [id, name] of [['l4wd', '4wd'], ['lF', 'lockF'], ['lR', 'lockR'], ['lAir', 'tyres'], ['lRS', 'rsteer'], ['lEng', 'ignition'], ['range', 'range'], ['lAC', 'autoclutch'], ['bUp', 'up'], ['bDn', 'down'], ['bRec', 'recover'], ['bCam', 'camera']]) {
  const el = $(id);
  if (el) el.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); action(name); });
}

// Gamepads: only trust a standard-mapped pad once its triggers have been seen at rest,
// so a virtual / non-standard device whose "trigger" idles at a non-zero value can't hold the throttle.
const padPrev = [];
const padReady = new Set();
function readInput(dt) {
  const k = (c) => keys.has(c);
  crawlLimit = k('ShiftLeft') || k('ShiftRight');
  const maxT = crawlLimit ? 0.35 : 1;
  let thr = input.throttle, brk = input.brake, st = input.steer;
  const up = k('KeyW') || k('ArrowUp'), dn = k('KeyS') || k('ArrowDown');
  thr = up ? Math.min(maxT, thr + dt * 1.1) : Math.max(0, thr - dt * 4);
  if (thr > maxT) thr = Math.max(maxT, thr - dt * 4);
  brk = dn ? Math.min(1, brk + dt * 3) : Math.max(0, brk - dt * 6);
  const l = k('KeyA') || k('ArrowLeft'), r = k('KeyD') || k('ArrowRight');
  const sTarget = (l ? 1 : 0) - (r ? 1 : 0);
  st += clamp(sTarget - st, -dt * (sTarget ? 2.2 : 3), dt * (sTarget ? 2.2 : 3));
  let clutch = car.dt.clutchPedal;
  const clutchDown = k('Space');
  let hb = k('KeyB');
  if (k('KeyZ')) camState.dist = clamp(camState.dist * (1 - dt * 1.2), 3.5, 40);
  if (k('KeyX')) camState.dist = clamp(camState.dist * (1 + dt * 1.2), 3.5, 40);

  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((g) => g && g.connected && g.mapping === 'standard') : [];
  const pad = pads[0];
  if (pad) {
    const b = (i) => (pad.buttons[i] ? pad.buttons[i].value : 0);
    if (!padReady.has(pad.index) && b(6) < 0.02 && b(7) < 0.02) padReady.add(pad.index);
    if (padReady.has(pad.index)) {
      const rt = b(7), lt = b(6), sx = pad.axes[0] || 0;
      if (rt > 0.04) thr = Math.max(thr, rt * maxT);
      if (lt > 0.04) brk = Math.max(brk, lt);
      if (Math.abs(sx) > 0.12) st = -sx * Math.abs(sx) ** 0.4;
      const pressed = (i) => b(i) > 0.5 && !padPrev[i];
      if (pressed(5)) action('up'); if (pressed(4)) action('down'); if (pressed(3)) action('range');
      if (pressed(12)) action('4wd'); if (pressed(14)) action('lockF'); if (pressed(15)) action('lockR');
      if (pressed(8)) action('camera'); if (pressed(13)) action('recover'); if (pressed(9)) openMenu();
      if (b(2) > 0.1) clutch = Math.max(clutch, b(2));
      if (b(1) > 0.5) hb = true;
      pad.buttons.forEach((x, i) => { padPrev[i] = x.value > 0.5; });
    }
  }
  // clutch: pushed in quickly, released slowly so you can feather it
  clutch = clutchDown ? Math.min(1, clutch + dt * 7) : Math.max(0, clutch - dt * 1.6);
  car.dt.clutchPedal = clutch;
  input.throttle = thr; input.brake = brk; input.steer = st; input.handbrake = hb;
}

// ---------------- menu ----------------
// cards show each rig as currently built in the garage
let cards = [];
function renderCards() {
  $('cards').innerHTML = VEHICLES.map((b, i) => {
    const s = builtSpec(i), st = stats(s);
    return `
  <div class="card panel" data-i="${i}">
    <h3>${s.name}</h3><p>${s.blurb}</p>
    <dl class="stats">
      <dt>Weight</dt><dd>${Math.round(st.weight).toLocaleString()} kg</dd>
      <dt>Engine</dt><dd>${s.engine.peakT} N·m @ ${s.engine.peakRpm} rpm</dd>
      <dt>Tyres</dt><dd>${Math.round(st.tyreIn)}" </dd>
      <dt>Gears</dt><dd>${s.gears.length}-speed${s.ranges.low ? ' + low range' : ''}</dd>
      <dt>Crawl ratio</dt><dd>${st.crawl.toFixed(0)}:1</dd>
      <dt>Lockers</dt><dd>${[s.lockers.front && 'front', s.lockers.rear && 'rear'].filter(Boolean).join(' + ') || 'none'}</dd>
    </dl>${isStock(b, s.build) ? '' : '<div class="mod">GARAGE BUILD</div>'}
  </div>`;
  }).join('');
  cards = [...document.querySelectorAll('.card')];
  cards.forEach((c, i) => { c.addEventListener('click', () => selectCard(i)); c.addEventListener('dblclick', () => { selectCard(i); startDrive(); }); });
  selectCard(selected);
}
const selectCard = (i) => { selected = i; cards.forEach((c, j) => c.classList.toggle('sel', j === i)); };
renderCards();
$('goBtn').addEventListener('click', () => startDrive());
const garage = new Garage(RAPIER, VEHICLES, { onChange: renderCards, onDrive: () => startDrive() });
$('garageBtn').addEventListener('click', () => garage.open(selected));

// Map selector. Each map bakes its own terrain at load, so switching reloads the page on
// the chosen map (?map=), carrying the rig and options over and driving straight off.
const MAP_TAGS = {
  park: 'Solid axles, lockers and crawl ratios up to 83:1. Five rated trails, from a gentle two-track to Widowmaker Falls. Pick a rig.',
  race: `${TRACK ? TRACK.name : 'Dust Bowl Circuit'}: 1.3 km of graded dirt with banked turns, whoops, a tabletop, a step-up, a rock garden and a splash. Set a best lap for every rig.`,
};
let selectedMap = MAP_ID;
$('maps').innerHTML = MAPS.map((m) => `<button class="mapbtn" data-id="${m.id}">${m.name}</button>`).join('');
const mapBtns = [...document.querySelectorAll('.mapbtn')];
function selectMap(id) {
  selectedMap = id;
  mapBtns.forEach((b) => b.classList.toggle('sel', b.dataset.id === id));
  $('tagline').textContent = MAP_TAGS[id];
}
mapBtns.forEach((b) => b.addEventListener('click', () => selectMap(b.dataset.id)));
selectMap(MAP_ID);
function switchMap() {
  const o = ['optAuto', 'optLow', 'optAir'].map((id) => ($(id).checked ? 1 : 0)).join('');
  const q = new URLSearchParams({ map: selectedMap, car: String(selected), o, go: '1' });
  const cover = document.createElement('div');
  cover.id = 'loading'; cover.textContent = `LOADING ${MAPS.find((m) => m.id === selectedMap).name.toUpperCase()}…`;
  document.body.appendChild(cover);
  location.search = q.toString();
}

function openMenu() {
  playing = false;
  $('menu').classList.remove('hidden');
  $('hud').classList.add('hidden');
}
function startDrive() {
  if (selectedMap !== MAP_ID) { switchMap(); return; }
  const opts = { auto: $('optAuto').checked, low: $('optLow').checked, air: $('optAir').checked };
  const damaged = car && (car.broken.some(Boolean) || car.health.engine < 1 || car.health.body < 1 || car.health.susp.some((x) => x < 1) || car.health.tire.some((x) => x < 1));
  garage.close();
  const sameRig = car && buildKey(car.spec) === buildKey(builtSpec(selected));
  if (!started || !sameRig || damaged) {
    if (started && damaged && sameRig) setTimeout(() => toast(isRace ? 'Repaired and back on the grid' : 'Repaired and back at the trailhead', 2.5), 3600);
    started = true;
    spawn(selected, opts);
    game.time = 0; game.dist = 0; game.done = false; game.active = null;
    if (isRace) raceStart();
  } else {
    car.dt.autoClutch = opts.auto;
  }
  audio.start(spec.engine.sound);
  audio.kind = spec.engine.sound;
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  playing = true;
  if (isRace) toast(`${spec.name} on the grid: 4-HI, ${car.dt.gearLabel === 'N' ? 'neutral' : '1st gear'}. Go on green; scroll the wheel to shift.`, 3.5);
  else toast(`${spec.name}: ${car.dt.range === 'low' ? '4-LOW' : 'HIGH'} range, neutral. Scroll the mouse wheel up for first gear.`, 3.5);
}

// ---------------- loop ----------------
let acc = 0, last = performance.now(), revHint = 0;
const idleInput = { throttle: 0, brake: 0, steer: 0, handbrake: true };
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now; clock += dt;
  if (car) {
    if (playing) readInput(dt);
    const inp = playing ? (race && race.holding ? raceHold : input) : idleInput;
    acc += dt;
    let n = 0;
    while (acc >= H && n < MAX_STEPS) {
      car.step(inp, H);
      acc -= H; n++;
    }
    if (n === MAX_STEPS) acc = 0;
    view.update(playing ? input : null);
    updateCamera(dt);
    if (playing) {
      game.dist += Math.abs(car.speed()) * dt;
      if (!game.done) game.time += dt;
      const p = car.chassis.translation();
      if (game.active) game.active.t += dt;
      if (isRace) raceUpdate(dt); else updateTrails(p);
      // stopped, holding the brake, in a forward gear: hint how to reverse
      if (input.brake > 0.9 && Math.abs(car.speed()) < 0.3 && car.dt.gear > 0) { revHint += dt; if (revHint > 1.2) { toast('To reverse: scroll the wheel down through N to R, then W', 2.5); revHint = -6; } } else if (revHint > 0) revHint = 0;
      if (car.upsideDown() && Math.abs(car.speed()) < 0.5) { if (!toastTimer || toastTimer < 0.1) toast('On your lid! Press R to recover', 1.5); }
      updateHud(dt);
      while (car.damageEvents.length) { toast(car.damageEvents.shift(), 3); audio.grind(); }
      if (car.health.engine < 0.5 && Math.random() < (0.5 - car.health.engine) * 1.5) {
        const hp = new THREE.Vector3(0, spec.chassis.size[1] / 2 + 0.6, -spec.chassis.size[2] * 0.35).applyQuaternion(_q).add(car.chassis.translation());
        const gsh = car.dt.dead ? 0.15 : 0.45;
        emit(hp.x, hp.y, hp.z, (Math.random() - 0.5) * 0.6, 1.2 + Math.random(), (Math.random() - 0.5) * 0.6, [gsh, gsh, gsh], 1.5);
      }
      // tyre spray: a gentle, rate-limited trickle (easy on the eyes)
      const sp = Math.abs(car.speed());
      car.wheelState.forEach((ws, i) => {
        if (!ws.grounded) return;
        const mat = ws.mat;
        const loose = mat === MAT.MUD || mat === MAT.SAND || mat === MAT.DIRT || mat === MAT.GRAVEL || mat === MAT.WATER;
        let rate = 0; // particles per second for this wheel
        if (ws.slip > 1.0) rate = Math.min(14, 3 + ws.slip * 2.5);
        else if (loose && sp > 5) rate = Math.min(8, (sp - 5) * 0.6);
        dustAcc[i] += rate * dt;
        while (dustAcc[i] >= 1) {
          dustAcc[i] -= 1;
          const w = car.wheels[i].translation();
          const base = MAT_INFO[mat].color;
          // soft, slightly lightened colour so puffs read as haze, not confetti
          const c = base.map((x) => Math.min(1, x * 0.85 + 0.12 + (Math.random() - 0.5) * 0.04));
          const back = new THREE.Vector3(0, 0, Math.sign(ws.spin || 1)).applyQuaternion(_q);
          const sv = 0.5 + Math.min(1.5, ws.slip * 0.3);
          emit(w.x + (Math.random() - 0.5) * 0.25, w.y - spec.tire.radius * 0.75, w.z + (Math.random() - 0.5) * 0.25,
            back.x * sv + (Math.random() - 0.5) * 0.3, 0.4 + Math.random() * 0.5, back.z * sv + (Math.random() - 0.5) * 0.3, c, 0.5 + Math.random() * 0.5);
        }
      });
    }
    updateParticles(dt);
    audio.update(car.dt.rpm, car.dt.throttleEff, car.dt.running, car.wheelState[2].spin);
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// show the world behind the garage menu
spawn(0, { auto: true, low: true, air: false });
camera.position.set(SPAWN.x + 10, heightAt(SPAWN.x + 10, SPAWN.z + 14) + 4, SPAWN.z + 14);
$('loading').remove();
if (isRace) { $('objTitle').textContent = `${MAP_NAME} · ${TRACK.name}`; }
// garage picks carried over a map switch
const qp = new URLSearchParams(location.search);
if (qp.has('car')) selectCard(clamp(parseInt(qp.get('car'), 10) || 0, 0, VEHICLES.length - 1));
if (qp.has('o')) ['optAuto', 'optLow', 'optAir'].forEach((id, i) => { const c = qp.get('o')[i]; if (c) $(id).checked = c === '1'; });
openMenu();
if (qp.get('go')) { qp.delete('go'); history.replaceState(null, '', '?' + qp.toString()); startDrive(); }
requestAnimationFrame(frame);
// expose for debugging in the console
window.__game = { get car() { return car; }, get view() { return view; }, get activeTrail() { return game.active; }, get race() { return race; }, map: MAP_ID, world, input, cam: camState, garage };
