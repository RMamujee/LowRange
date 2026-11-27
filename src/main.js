import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt, visualHeightAt, MAT, MAT_INFO, SIZE, RES, GRID, ROADS, TRAILS, DIFF, pathPoint } from './terrain.js';
import { MAPS, MAP_ID, MAP_KIND, MAP_NAME, SPAWN, TRACK, CHECKPOINTS } from './terrain.js';
import { RaceLaps, fmtLap } from './race.js';
import { buildRaceDressing } from './race_view.js';
import { VEHICLES } from './specs.js';
import { Vehicle } from './vehicle.js';
import { VehicleView } from './vehicle_view.js';
import { buildTerrainMesh, buildRocks, buildTrees, buildMarkers, buildMinimapBase, setGateDone, buildBackdrop } from './world_view.js';
import { EngineAudio } from './audio.js';
import { applyBuild, loadBuild, isStock, stats } from './garage.js';
import { Garage } from './garage_ui.js';
import { initSettings } from './settings.js';
import { PixelPipeline, noOutline } from './gfx/pipeline.js';
import { markWorld } from './gfx/toon.js'; // [gfx comfort]
import { SKY as SKY_COL, FOG as FOG_COL, SKY_BANDS } from './gfx/palette.js';
import { createHud } from './hud/hud.js';
import './platform.js';
import { mountMenuChrome, rigRating, enableArrowNav } from './menu/menu.js';
import { PropPhysics, adoptDressing } from './physics_props.js'; // [physics props]
import { CrawlCourse } from './crawl_course.js'; // [crawl] The Gauntlet's stages, splits and guidance
import { buildCrawlView } from './crawl_view.js'; // [crawl]
import { buildSpawnPoints, loadLastSpawn, saveLastSpawn, liftFor } from './spawns.js'; // [spawns] named spawn points
import { CamClear } from './cam_clear.js';
import { materialAt } from './terrain.js'; // [tyre fx]
import { getSettings } from './settings.js'; // [tyre fx]
import { TyreFx } from './fx/tyre_fx.js'; // [tyre fx]
import { MudView } from './fx/mud_view.js'; // [tyre fx] the bogs' rutted surface
import { MudCoat } from './fx/mud_coat.js'; // [tyre fx] mud caked on the truck

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
// no MSAA: the scene is drawn into the pixel pipeline's low-res target (src/gfx/pipeline.js),
// which also owns pixel ratio, sizing and tone mapping
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const pixels = new PixelPipeline(renderer, { sky: SKY_BANDS }); // stepped, dithered sky where nothing is drawn
pixels.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY_COL); // clear sky (gfx/palette.js)
// [gfx clarity] light aerial perspective: starts well past the play area, capped (toon.js uFogMax)
scene.fog = new THREE.Fog(FOG_COL, 140, 520);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 900);

scene.add(new THREE.HemisphereLight(0xfff1dc, 0x5a4a38, 1.25));
const sun = new THREE.DirectionalLight(0xfff0d4, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -28; sc.right = 28; sc.top = 28; sc.bottom = -28; sc.near = 1; sc.far = 160;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(-0.45, 0.8, 0.35).normalize();

scene.add(buildTerrainMesh());
const mudView = new MudView(scene, terrain.mud); // [tyre fx] ruts drawn over the bogs (src/fx/mud_view.js)
scene.add(buildRocks(rocks));
scene.add(buildTrees(trees));
// [physics props] loose stones and logs near the truck become real bodies (src/physics_props.js)
const looseProps = new PropPhysics(RAPIER, world, terrain, { heightAt });
adoptDressing(scene.getObjectByName('dressing'), looseProps);
window.__props = looseProps;
// grass tufts are too small for outlines: draw them on the pipeline's no-outline layer
scene.traverse((o) => { if (o.name === 'tufts' || o.name === 'flowers') noOutline(o); });
const isRace = MAP_KIND === 'race';
const isCrawl = MAP_ID === 'crawl'; // [crawl] The Gauntlet brings its own stage gates and signs
const crawlView = isCrawl ? buildCrawlView(scene, looseProps) : null;
const gates = isRace ? [] : isCrawl ? crawlView.gates : buildMarkers(scene); // [start0, end0, start1, end1, ...]
const raceView = isRace ? buildRaceDressing(scene) : null;
const camClear = new CamClear({ RAPIER, world, trees, scene, groundAt: visualHeightAt }); // keeps the camera out of canopies, signs, rocks
// distant ranges beyond the map edge (layered silhouettes, world_view.js)
scene.add(buildBackdrop());
// [gfx comfort] everything built so far is world: graded a step back so the vehicle (added
// later, unmarked) stays the most saturated thing on screen (gfx/toon.js markWorld)
markWorld(scene);

// ---------------- particles (dust, mud, water, debris) ----------------
// [tyre fx] tyre effects, crash debris and smoke live in src/fx/tyre_fx.js; the bogs' deformable
// surface (ruts) in src/fx/mud_view.js, mud caked on the truck in src/fx/mud_coat.js
const fx = new TyreFx(scene, { heightAt: visualHeightAt, surfaceAt: mudView.surfaceAt, materialAt, MAT, MAT_INFO, quality: () => getSettings().quality, pixels });
const mudCoat = new MudCoat();
// [crash] one crash effect (src/damage/crash.js fx): flakes of paint and grit plus a dust puff at
// the hit, glass glitter when a pane drops out; a clunk / grind on the audio module's one-shots
const _paint = new THREE.Color();
function crashFx(f) {
  const glass = f.kind === 'glass' || f.kind === 'crack';
  const n = Math.min(26, Math.round((glass ? 6 : 3) + f.e * 0.5));
  _paint.set(spec.color ?? 0x888888);
  for (let i = 0; i < n; i++) {
    const r = Math.random();
    const col = glass ? [0.78, 0.86, 0.9] : r < 0.4 ? [_paint.r, _paint.g, _paint.b] : r < 0.65 ? [0.22, 0.22, 0.24] : [0.62, 0.55, 0.45];
    const s = glass ? 1.2 : 1.6 + Math.min(2, f.e * 0.05);
    fx.debris(f.p.x + (Math.random() - 0.5) * 0.3, f.p.y + (Math.random() - 0.5) * 0.3, f.p.z + (Math.random() - 0.5) * 0.3,
      (Math.random() - 0.5) * s - (f.n ? f.n.x : 0) * 0.8, Math.random() * s * 0.8 + 0.4, (Math.random() - 0.5) * s - (f.n ? f.n.z : 0) * 0.8, col, 0.6 + Math.random() * 0.6);
  }
  if (f.kind === 'crack' || clock - crashSoundAt < 0.15) return;
  crashSoundAt = clock;
  if (f.e > 6 || f.kind === 'detach') audio.clunk(); else if (f.kind === 'scrape') audio.grind();
}
let crashSoundAt = -1;
// ---------------- game state ----------------
const audio = new EngineAudio();
initSettings({ renderer, scene, sun, camera, audio, pipeline: pixels });
let car = null, view = null, spec = null;
let selected = 0;
let playing = false;
let started = false;
// Trails: drive through either end gate to start, out the other end to finish.
const game = { time: 0, dist: 0, done: false, trails: TRAILS.map(() => ({ done: false, best: null })), active: null };
const trailEnds = TRAILS.map((t) => [pathPoint(t, 3), pathPoint(t, t.length - 3)]);
const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function updateTrails(p) {
  TRAILS.forEach((t, i) => {
    trailEnds[i].forEach((e, end) => {
      const near = Math.hypot(e.x - p.x, e.z - p.z) < t.width / 2 + 2.5 && Math.abs(heightAt(e.x, e.z) - p.y) < 4;
      const gate = i * 2 + end;
      if (!near) { if (game.finishGate === gate) game.finishGate = -1; return; }
      if (game.finishGate === gate) return; // just finished here: don't restart the trail until you drive out of the gate
      const a = game.active;
      if (a && a.trail === i && a.from !== end && a.t > 4) {
        // finished
        const st = game.trails[i];
        const first = !st.done;
        st.done = true; st.best = st.best === null ? a.t : Math.min(st.best, a.t);
        setGateDone(gates[i * 2]); setGateDone(gates[i * 2 + 1]);
        toast(`${t.name} complete in ${fmtT(a.t)}${first ? '' : ' (best ' + fmtT(st.best) + ')'}`, 4);
        game.active = null; game.finishGate = gate;
        if (game.trails.every((x) => x.done) && !game.done) { game.done = true; toast(`All five trails conquered! Total ${fmtT(game.time)}`, 6); }
      } else if (!a || a.trail !== i) {
        game.active = { trail: i, from: end, t: 0 };
        toast(`${t.name} · ${DIFF[t.diff].label}. Good luck!`, 2.5);
      }
    });
  });
}
// [crawl] The Gauntlet: one timed run from the start gate to the summit, split at every stage
// gate (src/crawl_course.js). game.active mirrors the run so the HUD's run clock works;
// game.guide points the HUD arrow at the next gate; game.crawl feeds the big map's sidebar.
const crawl = isCrawl ? new CrawlCourse(TRAILS[0], TRAILS[0].stages) : null;
function updateCrawl(p, dt) {
  if (crawl.running && !game.active) { crawl.reset(); crawlView.resetAll(); } // respawned at the trailhead
  crawl.setRig(spec.id);
  for (const e of crawl.update(p, dt)) {
    if (e.type === 'start') { crawlView.resetAll(); game.active = { trail: 0, from: 0, t: 0 }; toast(`${TRAILS[0].name}: the clock is running. Stage 1 · ${e.stage.name}`, 3); }
    else if (e.type === 'split') { crawlView.setDone(e.stage.n); toast(`Stage ${e.stage.n} ${e.stage.name}: ${fmtT(e.split)}${e.best ? (e.prevBest != null ? ' · NEW BEST' : '') : ` (best ${fmtT(e.prevBest)})`}`, 2.5); }
    else if (e.type === 'stage') {
      if (!game.active) game.active = { trail: 0, from: 0, t: crawl.t };
      const st = e.stage, d = DIFF[st.diff].label;
      setTimeout(() => toast(`${e.retry ? 'Retry: ' : ''}Stage ${st.n}/${TRAILS[0].stages.length} · ${st.name} (${d}). ${st.blurb}`, 4), e.retry ? 0 : 1200);
    } else if (e.type === 'finish') {
      crawlView.setDone(TRAILS[0].stages.length - 1); crawlView.setDone(TRAILS[0].stages.length);
      const st = game.trails[0];
      if (e.clean) { st.done = true; st.best = st.best === null ? e.time : Math.min(st.best, e.time); }
      game.active = null;
      setTimeout(() => toast(e.clean ? `Summit! ${TRAILS[0].name} in ${fmtT(e.time)}${e.best ? ' · NEW BEST for the ' + spec.name : ` (best ${fmtT(e.prevBest)})`}` : `Summit in ${fmtT(e.time)}. Stages were skipped, so it doesn't count as a best`, 6), 1500);
    }
  }
  if (game.active) game.active.t = crawl.t;
  game.guide = crawl.guide(); // [spawns] after a stage spawn it points at that gate (crawl.joinAt)
  game.crawl = crawl.snapshot();
}
const input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const keys = new Set();
let crawlLimit = false;
let parkBrake = true;   // latching parking brake (P); every fresh truck starts with it on
let paused = false;     // Esc mid-drive: menu up, simulation frozen, nothing respawned
let muted = false;

// ---------------- garage builds ----------------
// The spec that gets driven: the base rig from specs.js with its saved garage build applied.
const builtSpec = (i) => applyBuild(VEHICLES[i], loadBuild(VEHICLES[i]));
const buildKey = (s) => s.id + JSON.stringify(s.build);

function spawn(i, opts) {
  if (car) { car.destroy(); view.dispose(); }
  terrain.mud.clear(); // [mud] a fresh truck at the trailhead: unrutted bogs
  spec = builtSpec(i);
  const y = heightAt(SPAWN.x, SPAWN.z) + spec.tire.radius - spec.axleY + 0.15;
  car = new Vehicle(RAPIER, world, spec, terrain, { x: SPAWN.x, y, z: SPAWN.z }, SPAWN.yaw);
  view = new VehicleView(scene, car);
  car.dt.autoClutch = opts.auto;
  car.airedDown = opts.air;
  if (opts.low && spec.ranges.low) { car.dt.range = 'low'; car.dt.fourWD = true; }
  car.dt.gear = 0;
  camState.heading = 0;
  parkBrake = true;
  if (crawl) { crawl.reset(); crawlView.resetAll(); } // [crawl] fresh at the trailhead: no run, no stage join for Y
  if (isRace) raceOnSpawn();
  hud.setSpec(spec);
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

// Which trail (if any) the truck is on: the trail corridor under it, else the active run (off the
// line mid-run). A run on a different trail than the corridor was abandoned, so it doesn't count.
// (One label per grid cell: trails that cross would need a distance-to-line test instead.)
function trailUnderTruck() {
  const p = car.chassis.translation();
  const ix = clamp(Math.round((p.x + SIZE / 2) / (SIZE / RES)), 0, RES), iz = clamp(Math.round((p.z + SIZE / 2) / (SIZE / RES)), 0, RES);
  const id = GRID.path[ix * (RES + 1) + iz] - ROADS.length;
  const onTrail = id >= 0 && id < TRAILS.length;
  if (game.active && (!onTrail || id === game.active.trail)) return { trail: game.active.trail, from: game.active.from };
  return onTrail ? { trail: id, from: 0 } : null;
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
  terrain.mud.clear(); // [mud] a restart (trail, Gauntlet stage, race) gets fresh, unrutted bogs
  if (isRace) { raceRestart(); return; }
  if (crawl) { // [crawl] back to the gate of the stage you're in (the start before stage 2)
    const r = crawl.restartPose();
    respawnFresh(r.x, r.z, r.yaw);
    if (r.stage.n === 1) { game.active = null; crawlView.resetAll(); }
    toast(r.stage.n === 1 ? `Back at the start of ${TRAILS[0].name}, fully repaired` : `Back at stage ${r.stage.n} · ${r.stage.name}, repaired.${r.joined ? '' : ' The run clock keeps going'}`, 2.5);
    return;
  }
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
let race = null, goLights = 0, shownCp = null;
const raceHold = { throttle: 0, brake: 1, steer: 0, handbrake: true }; // held on the line during the countdown
const bigMsg = (text, secs = 1.2, cls = '') => hud.bigMsg(text, secs, cls);
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
    else if (e.type === 'cp') toast(race.started ? `Checkpoint ${e.cp}/${e.of} · ${fmtLap(e.split)}` : `Checkpoint ${e.cp}/${e.of}. The lap clock starts at the line`, 1.4); // [spawns] rolling start: no split yet
    else if (e.type === 'lap') { bigMsg(fmtLap(e.time), 2.5, e.best ? 'best' : ''); toast(`Lap ${e.lap}: ${fmtLap(e.time)}${e.best ? ' · NEW BEST' : ` (best ${fmtLap(race.best)})`}`, 3.5); }
    else if (e.type === 'missed') toast(`Missed checkpoint ${e.cp}! Go back through it`, 3);
  }
  if (race.holding) raceView.setLights(Math.min(5, Math.floor((3 - race.count) / 0.6) + 1));
  else if (goLights > 0) { goLights -= dt; if (goLights <= 0) raceView.setLights(0); }
  const cp = race.racing ? race.next : -1;
  if (cp !== shownCp) { raceView.setNextCp(cp); shownCp = cp; }
  if (race.wrong) bigMsg('WRONG WAY', 0.3, 'warn');
}

// ---------------- [spawns] named spawn points (BeamNG-style) ----------------
// src/spawns.js derives and footprint-checks the points (trailhead, both ends of every trail, Gauntlet
// stage gates, race grid / checkpoints / paddock); the big map shows them (J opens the list) and the
// pause menu offers the list and "Restart at <last spawn>". Loose physics props count as obstacles.
const SPAWNS = buildSpawnPoints({ rocks, trees, extra: looseProps.items });
let lastSpawn = loadLastSpawn(SPAWNS);   // validated: an unknown saved id falls back to the default
let camSnap = false;                     // next camera update jumps behind the truck (no swoop)

// Teleport: a fresh, repaired truck at rest on the point (parking brake on, neutral, driver settings
// kept by respawnFresh); any trail / stage / race run is cancelled so only driving through a gate
// starts one, and nothing is credited for the jump.
function spawnAt(sp) {
  if (!car || !sp) return;
  terrain.mud.clear(); // [mud] a teleport is a fresh attempt: unrutted bogs
  respawnFresh(sp.x, sp.z, sp.yaw, liftFor(sp, spec));
  parkBrake = true;
  keys.clear(); input.throttle = 0; input.brake = 0; input.steer = 0;
  camState.yaw = 0; camState.spot = null; camTargetInit = false; camSnap = true;
  game.active = null; game.finishGate = -1;
  if (crawl) {
    crawl.reset(); crawlView.resetAll();
    crawl.joinAt(sp.kind === 'stage' ? sp.stage : 0); // Y and the HUD keep to that gate until a gate is crossed
    game.guide = crawl.guide(); game.crawl = crawl.snapshot();
  }
  if (isRace) {
    const d = car.dt; d.range = 'high'; d.fourWD = true;
    if (sp.kind === 'grid') { raceGearing(); race.teleported(); raceStart(); }   // as Y: lights and a countdown
    else {
      // rolling start: the next checkpoint is the one ahead, the lap clock starts at the line
      race.reset(); race.state = 'racing'; race.next = sp.cp ?? 0; race.lastCp = sp.cp ? sp.cp - 1 : 0; race.teleported();
      raceView.setLights(0); goLights = 0;
    }
    shownCp = null;
  }
  lastSpawn = sp; saveLastSpawn(sp);
  hud.closeMap();
  updateSpawnButtons();
  toast(`${sp.name}: repaired, parking brake on.${sp.note ? ' ' + sp.note : ''}`, 3.5);
}

// pause menu: "Spawn points" (opens the list on the map) and "Restart at <last spawn>"
const spawnBtn = document.createElement('button'), lastSpawnBtn = document.createElement('button');
spawnBtn.id = 'spawnBtn'; lastSpawnBtn.id = 'lastSpawnBtn';
spawnBtn.className = lastSpawnBtn.className = 'pbtn hidden';
spawnBtn.innerHTML = `<span>Spawn points<small>Pick ${isRace ? 'a checkpoint' : isCrawl ? 'a stage' : 'a trailhead'} (J)</small></span>`;
$('restartBtn').after(spawnBtn, lastSpawnBtn);
function updateSpawnButtons() {
  spawnBtn.classList.toggle('hidden', !paused || !SPAWNS.length);
  lastSpawnBtn.classList.toggle('hidden', !paused || !lastSpawn || lastSpawn.default);
  if (lastSpawn) lastSpawnBtn.innerHTML = `<span>Restart at last spawn<small>${lastSpawn.name}</small></span>`;
}
const resumeForSpawn = () => { if (selectedMap !== MAP_ID) selectMap(MAP_ID); startDrive(); return playing; };
spawnBtn.addEventListener('click', () => { if (resumeForSpawn()) hud.openSpawns(); });
lastSpawnBtn.addEventListener('click', () => { if (resumeForSpawn()) spawnAt(lastSpawn); });

// ---------------- HUD ----------------
// The HUD itself lives in src/hud/ (pixel canvases); main.js feeds it a snapshot each frame.
let toastTimer = 0;
function toast(msg, secs = 2.2) { hud.toast(msg, secs); toastTimer = secs; }
const hudState = () => ({ car, spec, input, game, race, parkBrake, matInfo: MAT_INFO });
function updateHud(dt) {
  if (toastTimer > 0) toastTimer -= dt;
  hud.update(dt, hudState());
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
    if (camSnap) camera.position.copy(_v); else camera.position.lerp(_v, damp(7, dt)); // [spawns] a teleport snaps the camera
    camClear.chase(target, camera.position, _v, camSnap ? 0 : dt); // out of trees, signs, rocks
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
      camState.spot = camClear.spot(p, fwd, side, 1.7, target); // first stand ahead that isn't in a tree or a sign
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
  camSnap = false; // [spawns]
}

// ---------------- input ----------------
const CONTROLS = [
  ['W / S', 'throttle / brake'], ['A / D', 'steer (or Left / Right arrows)'], ['Space', 'clutch (hold)'], ['Shift', 'crawl throttle (35%)'],
  ['Up / Down', 'shift up / down (arrow keys, or PgUp / PgDn)'], ['Mouse wheel', 'shift up / down'], ['R', 'high / low range'], ['Q / E', 'front / rear locker'], ['F', '2WD / 4WD'],
  ['G', 'rear steer (Goat)'], ['T', 'air down / up'], ['P', 'parking brake on / off'], ['B', 'handbrake (hold)'], ['I', 'start engine'],
  ['C', 'auto-clutch on/off'], ['Backspace', isRace ? 'repair, back to last checkpoint' : 'repair + right the truck, on the spot'], ['Y', isRace ? 'restart the race' : isCrawl ? 'restart the stage you are in' : 'restart current trail'], ['V', 'camera'], ['Z / X', 'zoom in / out'],
  ['Mouse drag', 'orbit camera'], ['M', 'map + waypoints'], ['J', 'spawn points (map list)'], ['N', 'mute'], ['Gamepad', 'RT/LT pedals, RB/LB shift, X clutch, A park brake, R3 map'], ['H', 'help'], ['Esc', 'pause / resume'],
];
const controlsHtml = CONTROLS.map(([k, v]) => `<div class="ck"><kbd><span>${k}</span></kbd><span>${v}</span></div>`).join('');
$('menuControls').innerHTML = controlsHtml;
const hud = createHud({
  action: (n) => action(n), camera, isRace, mapId: MAP_ID, mapName: MAP_NAME, trees, scene, noOutline,
  controls: () => CONTROLS, onResume: () => resumeDrive(), onRestart: () => startDrive({ fresh: true }),
  spawns: SPAWNS, onSpawn: (sp) => spawnAt(sp), lastSpawn: () => lastSpawn, // [spawns]
});

// keyboard key -> action
const KEYMAP = {
  KeyR: 'range', KeyQ: 'lockF', KeyE: 'lockR', KeyF: '4wd', KeyG: 'rsteer', KeyT: 'tyres', KeyI: 'ignition',
  KeyC: 'autoclutch', Backspace: 'recover', KeyY: 'restart', KeyV: 'camera', KeyN: 'mute', KeyM: 'map', KeyJ: 'spawns', KeyH: 'help', KeyP: 'park',
  PageUp: 'up', PageDown: 'down', ArrowUp: 'up', ArrowDown: 'down',
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
    case 'mute': muted = !muted; audio.setMuted(muted); toast(audio.muted ? 'Muted' : 'Sound on', 1.2); break;
    case 'help': hud.toggleHelp(); break;
    case 'map': hud.toggleMap(); break;
    case 'spawns': hud.toggleSpawns(); break; // [spawns]
    case 'park': parkBrake = !parkBrake; audio.clunk(); toast(parkBrake ? 'Parking brake ON' : 'Parking brake released', 1.4); break;
  }
  if (msg && (name === 'up' || name === 'down')) hud.nudgeShifter();
  if (msg) toast(msg);
}

addEventListener('keydown', (e) => {
  if (e.code === 'Escape' || (e.code === 'Tab' && playing)) {
    e.preventDefault(); keys.clear();
    if (playing && e.code === 'Escape' && hud.closeOverlay()) return;
    if (playing) openMenu(); else if (paused && e.code === 'Escape' && !garage.isOpen) resumeDrive();
    return;
  }
  if (!playing) { if (e.code === 'Enter' && !e.target.closest?.('button, input, label, .card')) startDrive(); return; }
  if (['Space', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(e.code)) e.preventDefault();
  if (hud.mapKey(e)) { e.preventDefault(); return; } // [spawns] the map's spawn list takes arrows / Enter
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

// Gamepads: only trust a standard-mapped pad once its triggers have been seen at rest,
// so a virtual / non-standard device whose "trigger" idles at a non-zero value can't hold the throttle.
const padPrev = [];
const padReady = new Set();
function readInput(dt) {
  const k = (c) => keys.has(c);
  crawlLimit = k('ShiftLeft') || k('ShiftRight');
  const maxT = crawlLimit ? 0.35 : 1;
  let thr = input.throttle, brk = input.brake, st = input.steer;
  const up = k('KeyW'), dn = k('KeyS'); // ArrowUp / ArrowDown shift gears (KEYMAP), they are not pedals
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
      if (pressed(0)) action('park'); if (pressed(11)) action('map');
      if (b(2) > 0.1) clutch = Math.max(clutch, b(2));
      if (b(1) > 0.5) hb = true;
      pad.buttons.forEach((x, i) => { padPrev[i] = x.value > 0.5; });
    }
  }
  // clutch: pushed in quickly, released slowly so you can feather it
  clutch = clutchDown ? Math.min(1, clutch + dt * 7) : Math.max(0, clutch - dt * 1.6);
  car.dt.clutchPedal = clutch;
  input.throttle = thr; input.brake = brk; input.steer = st; input.handbrake = hb || parkBrake;
}

// ---------------- menu ----------------
// Pixel-art menu (src/menu/): the cards show each rig as currently built in the garage.
mountMenuChrome();
let cards = [];
const fmtKg = (v) => Math.round(v).toLocaleString('en-US');
function renderCards() {
  $('cards').innerHTML = VEHICLES.map((b, i) => {
    const s = builtSpec(i), st = stats(s), r = rigRating(s, st);
    return `
  <div class="card" data-i="${i}" role="radio" aria-checked="false" tabindex="-1">
    <div class="c-head"><h3>${s.name}</h3><span class="c-tag">Selected</span></div>
    <div class="c-rate">Trails up to <i class="${r}" style="background-image:var(--img-diff-${r})" aria-hidden="true"></i><b>${DIFF[r].label}</b></div>
    <p class="c-blurb">${s.blurb}</p>
    <dl class="stats">
      <dt>Weight</dt><dd>${fmtKg(st.weight)} kg</dd>
      <dt>Engine</dt><dd>${s.engine.peakT} N·m @ ${s.engine.peakRpm} rpm</dd>
      <dt>Tyres</dt><dd>${Math.round(st.tyreIn)}"</dd>
      <dt>Gears</dt><dd>${s.gears.length}-speed${s.ranges.low ? ' + low range' : ''}</dd>
      <dt>Crawl</dt><dd>${st.crawl.toFixed(0)}:1</dd>
      <dt>Lockers</dt><dd>${[s.lockers.front && 'front', s.lockers.rear && 'rear'].filter(Boolean).join(' + ') || 'none'}</dd>
    </dl>${isStock(b, s.build) ? '' : '<div class="mod">Garage build</div>'}
  </div>`;
  }).join('');
  cards = [...document.querySelectorAll('.card')];
  cards.forEach((c, i) => {
    c.addEventListener('click', () => selectCard(i));
    c.addEventListener('focus', () => selectCard(i));
    c.addEventListener('dblclick', () => { selectCard(i); startDrive(); });
    c.addEventListener('keydown', (e) => {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); selectCard(i); startDrive(); }
      else if (e.code === 'Space') { e.preventDefault(); selectCard(i); }
    });
  });
  selectCard(selected);
}
function selectCard(i) {
  selected = i;
  const cur = paused && car ? car.spec.id : null;
  cards.forEach((c, j) => {
    const on = j === i, driving = VEHICLES[j].id === cur;
    c.classList.toggle('sel', on);
    c.classList.toggle('current', driving);
    c.setAttribute('aria-checked', String(on));
    c.tabIndex = on ? 0 : -1;
    c.querySelector('.c-tag').textContent = driving ? 'Driving' : 'Selected';
  });
  updateGo();
}
const garage = new Garage(RAPIER, VEHICLES, { onChange: renderCards, onDrive: () => startDrive() });
$('goBtn').addEventListener('click', () => startDrive());
$('garageBtn').addEventListener('click', () => garage.open(selected));
$('restartBtn').addEventListener('click', () => startDrive({ fresh: true }));
$('restartBtn').innerHTML = `<span>${isRace ? 'Back to the grid' : 'Restart at trailhead'}<small>Repairs your rig</small></span>`;

// Rigs / Controls pages of the main board
function showTab(which) {
  const ctrl = which === 'controls';
  $('rigView').classList.toggle('hidden', ctrl);
  $('ctrlView').classList.toggle('hidden', !ctrl);
  $('rigsBtn').classList.toggle('sel', !ctrl); $('rigsBtn').setAttribute('aria-selected', String(!ctrl));
  $('ctrlBtn').classList.toggle('sel', ctrl); $('ctrlBtn').setAttribute('aria-selected', String(ctrl));
}
$('rigsBtn').addEventListener('click', () => showTab('rigs'));
$('ctrlBtn').addEventListener('click', () => showTab('controls'));

// Map selector. Each map bakes its own terrain at load, so switching reloads the page on
// the chosen map (?map=), carrying the rig and options over and driving straight off.
const MAP_TAGS = {
  park: 'Solid axles, lockers and crawl ratios up to 83:1. Five rated trails, from a gentle two-track to Widowmaker Falls. Pick a rig.',
  race: `${TRACK ? TRACK.name : 'Dust Bowl Circuit'}: 1.3 km of graded dirt with banked turns, whoops, a tabletop, a step-up, a rock garden and a splash. Set a best lap for every rig.`,
  crawl: 'The Gauntlet: one 780 m rock trail in 12 stages that only gets harder, from a gentle two-track to the Waterfall. A physics and driving test course, with a bypass track and split times.', // [crawl]
};
let selectedMap = MAP_ID;
const mapName = (id) => MAPS.find((m) => m.id === id).name;
$('maps').innerHTML = MAPS.map((m) => `<button class="pbtn mapbtn" role="radio" aria-checked="false" data-id="${m.id}"><span>${m.name}</span></button>`).join('');
const mapBtns = [...document.querySelectorAll('.mapbtn')];
function selectMap(id) {
  selectedMap = id;
  mapBtns.forEach((b) => { b.classList.toggle('sel', b.dataset.id === id); b.setAttribute('aria-checked', String(b.dataset.id === id)); });
  $('tagline').textContent = MAP_TAGS[id];
  updateGo();
}
mapBtns.forEach((b) => b.addEventListener('click', () => selectMap(b.dataset.id)));
function switchMap() {
  const o = ['optAuto', 'optLow', 'optAir'].map((id) => ($(id).checked ? 1 : 0)).join('');
  const q = new URLSearchParams({ map: selectedMap, car: String(selected), o, go: '1' });
  const cover = document.createElement('div');
  cover.id = 'loading'; cover.className = 'm-cover'; cover.textContent = `Loading ${mapName(selectedMap)}…`;
  document.body.appendChild(cover);
  location.search = q.toString();
}

// The primary button says what it will do: resume this run, or start a new drive (other rig / build / map).
function updateGo() {
  let label = 'Drive', note = '';
  const sel = builtSpec(selected);
  if (selectedMap !== MAP_ID) { label = `Drive on ${mapName(selectedMap)}`; note = `Loads the ${mapName(selectedMap)}${paused ? ' and ends this run' : ''}.`; }
  else if (paused && car) {
    if (buildKey(car.spec) === buildKey(sel)) label = 'Resume';
    else {
      label = 'Drive this rig';
      note = car.spec.id === sel.id ? 'Garage changes start a new drive. Esc returns to your run.' : `Starts a new drive in the ${sel.name}. Esc returns to your run.`;
    }
  }
  $('goBtn').firstElementChild.textContent = label;
  $('goNote').textContent = note;
}

function setPausedUi() {
  $('pauseSign').classList.toggle('hidden', !paused);
  $('restartBtn').classList.toggle('hidden', !paused);
  updateSpawnButtons(); // [spawns]
  selectCard(selected);
}
function openMenu() {
  if (playing && started) {
    paused = true; audio.setMuted(true);
    const ci = VEHICLES.findIndex((v) => v.id === car.spec.id);
    if (ci >= 0) selected = ci;   // the pause menu opens on the rig you're driving
  }
  playing = false;
  setPausedUi();
  $('menu').classList.remove('hidden');
  $('hud').classList.add('hidden');
  $('goBtn').focus({ preventScroll: true });
}
// Esc / RESUME: back to the exact same truck, pose, damage, gear and timers
function resumeDrive() {
  if (!paused) return;
  paused = false;
  garage.close();
  audio.setMuted(muted);
  $('menu').classList.add('hidden');
  if ($('menu').contains(document.activeElement)) document.activeElement.blur();   // no menu button keeps keyboard focus while driving
  setPausedUi();
  $('hud').classList.remove('hidden');
  last = performance.now(); acc = 0;
  playing = true;
}
function startDrive({ fresh = false } = {}) {
  if (selectedMap !== MAP_ID) { switchMap(); return; }
  const opts = { auto: $('optAuto').checked, low: $('optLow').checked, air: $('optAir').checked };
  garage.close();
  const sameRig = car && buildKey(car.spec) === buildKey(builtSpec(selected));
  // only a first start, a different rig / build, or the explicit restart button respawns (and repairs)
  if (!started || !sameRig || fresh) {
    if (started && fresh && sameRig) setTimeout(() => toast(isRace ? 'Repaired and back on the grid' : 'Repaired and back at the trailhead', 2.5), 3600);
    started = true;
    spawn(selected, opts);
    game.time = 0; game.dist = 0; game.done = false; game.active = null;
    if (isRace) raceStart();
  } else {
    car.dt.autoClutch = opts.auto;
    if (paused) { resumeDrive(); return; }
  }
  paused = false;
  audio.setMuted(muted);
  setPausedUi();
  audio.start(spec.engine.sound);
  audio.kind = spec.engine.sound;
  $('menu').classList.add('hidden');
  if ($('menu').contains(document.activeElement)) document.activeElement.blur();   // no menu button keeps keyboard focus while driving
  $('hud').classList.remove('hidden');
  playing = true;
  if (isRace) toast(`${spec.name} on the grid: 4-HI, ${car.dt.gearLabel === 'N' ? 'neutral' : '1st gear'}. Go on green; Up / Down arrows or the mouse wheel shift.`, 3.5);
  else toast(`${spec.name}: ${car.dt.range === 'low' ? '4-LOW' : 'HIGH'} range, neutral. Arrow Up (or mouse wheel up) for first gear.`, 3.5);
  if (parkBrake) setTimeout(() => { if (parkBrake && playing) toast('Parking brake is ON: press P to release it', 3.5); }, 3700);
}
renderCards();
selectMap(MAP_ID);
// arrow keys move focus around whichever menu layer is up (the settings overlay handles its own keys)
enableArrowNav(() => (garage.isOpen ? $('garage') : !$('menu').classList.contains('hidden') ? $('menu') : null));

// ---------------- loop ----------------
let acc = 0, last = performance.now(), revHint = 0;
const idleInput = { throttle: 0, brake: 0, steer: 0, handbrake: true };
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now; clock += dt;
  if (car) {
    if (playing) readInput(dt);
    const inp = playing ? (race && race.holding ? raceHold : input) : idleInput;
    if (!paused) acc += dt; else acc = 0;   // paused: no physics steps at all, the truck is frozen in place
    let n = 0;
    while (acc >= H && n < MAX_STEPS) {
      car.step(inp, H);
      acc -= H; n++;
    }
    if (n === MAX_STEPS) acc = 0;
    looseProps.update(car.chassis.translation()); looseProps.sync(); // [physics props]
    view.update(playing ? input : null);
    updateCamera(dt);
    // [crash] a brief, gentle camera shake proportional to the crash energy (smooth, not jitter)
    const shk = car.crash.shake;
    if (shk > 0.01) camera.position.add(_v.set(Math.sin(clock * 37), Math.sin(clock * 29 + 1) * 0.6, Math.sin(clock * 41 + 2)).multiplyScalar(shk * 0.06));
    if (playing) {
      game.dist += Math.abs(car.speed()) * dt;
      if (!game.done) game.time += dt;
      const p = car.chassis.translation();
      if (game.active) game.active.t += dt;
      if (isRace) raceUpdate(dt); else if (crawl) updateCrawl(p, dt); else updateTrails(p); // [crawl]
      // stopped, holding the brake, in a forward gear: hint how to reverse
      if (input.brake > 0.9 && Math.abs(car.speed()) < 0.3 && car.dt.gear > 0) { revHint += dt; if (revHint > 1.2) { toast('To reverse: Arrow Down (or wheel down) through N to R, then W', 2.5); revHint = -6; } } else if (revHint > 0) revHint = 0;
      if (car.upsideDown() && Math.abs(car.speed()) < 0.5) { if (!toastTimer || toastTimer < 0.1) toast('On your lid! Press Backspace to recover', 1.5); }
      // pulling away against the parking brake: remind
      if (parkBrake && input.throttle > 0.3 && car.dt.gear !== 0 && toastTimer <= 0) toast('Parking brake is on: press P to release', 2); // repeats while you drive against it
      updateHud(dt);
      while (car.damageEvents.length) { toast(car.damageEvents.shift(), 3); audio.grind(); }
      // [crash] crash effects from src/damage/crash.js: debris and dust at the hit, glass glitter, steam
      for (const f of car.crash.fx.splice(0)) crashFx(f);
      const mech = car.crash.mech;
      if ((mech.temp > 0.7 || mech.radiator < 0.6) && car.dt.running && Math.random() < (mech.temp > 0.7 ? 0.6 : 0.25)) {
        const hp = new THREE.Vector3((Math.random() - 0.5) * 0.6, spec.chassis.size[1] / 2 + 0.3, -spec.chassis.size[2] * 0.42).applyQuaternion(_q).add(car.chassis.translation());
        fx.smoke(hp.x, hp.y, hp.z, (Math.random() - 0.5) * 0.5, 1.4 + Math.random(), (Math.random() - 0.5) * 0.5, [0.92, 0.93, 0.95], 1.1);
      }
      if (car.health.engine < 0.5 && Math.random() < (0.5 - car.health.engine) * 1.5) {
        const hp = new THREE.Vector3(0, spec.chassis.size[1] / 2 + 0.6, -spec.chassis.size[2] * 0.35).applyQuaternion(_q).add(car.chassis.translation());
        const gsh = car.dt.dead ? 0.15 : 0.45;
        fx.smoke(hp.x, hp.y, hp.z, (Math.random() - 0.5) * 0.6, 1.2 + Math.random(), (Math.random() - 0.5) * 0.6, [gsh, gsh, gsh], 1.5);
      }
      fx.wheels(car, dt); // [tyre fx] mud, water, dust and grit off each tyre (src/fx/tyre_fx.js)
    }
    fx.update(dt); mudView.update(); mudCoat.update(car, view, fx); // [tyre fx]
    audio.update(car.dt.rpm, car.dt.throttleEff, car.dt.running, car.wheelState[2].spin);
  }
  pixels.render(scene, camera, sun);
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  pixels.setSize(innerWidth, innerHeight);
});

// show the world behind the garage menu
spawn(0, { auto: true, low: true, air: false });
camera.position.set(SPAWN.x + 10, heightAt(SPAWN.x + 10, SPAWN.z + 14) + 4, SPAWN.z + 14);
$('loading').remove();
// garage picks carried over a map switch
const qp = new URLSearchParams(location.search);
if (qp.has('car')) selectCard(clamp(parseInt(qp.get('car'), 10) || 0, 0, VEHICLES.length - 1));
if (qp.has('o')) ['optAuto', 'optLow', 'optAir'].forEach((id, i) => { const c = qp.get('o')[i]; if (c) $(id).checked = c === '1'; });
openMenu();
if (qp.get('go')) { qp.delete('go'); history.replaceState(null, '', '?' + qp.toString()); startDrive(); }
requestAnimationFrame(frame);
// expose for debugging in the console
window.__game = { hud, get parkBrake() { return parkBrake; }, get paused() { return paused; }, get car() { return car; }, get view() { return view; }, get activeTrail() { return game.active; }, get race() { return race; }, map: MAP_ID, world, input, cam: camState, garage, spawns: SPAWNS, spawnAt, get lastSpawn() { return lastSpawn; }, get crawl() { return crawl?.snapshot() ?? null; }, fx, mudView, gfx: { renderer, pixels, scene, camera, sun } };
