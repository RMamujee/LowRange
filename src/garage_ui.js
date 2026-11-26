// Garage panel: upgrade chips, live stat readouts and a turntable preview of the build.
// The preview is a real Vehicle settling in its own tiny physics world, drawn by VehicleView,
// so lift, sag, tyre size and paint all show exactly as they will on the trail.
import * as THREE from 'three';
import { Vehicle } from './vehicle.js';
import { VehicleView } from './vehicle_view.js';
import { GROUP_WORLD } from './terrain.js';
import { applyBuild, buildOptions, defaultBuild, loadBuild, saveBuild, stats } from './garage.js';
import { PixelPipeline } from './gfx/pipeline.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const H = 1 / 200;

// [label, value text, numeric value, sub text, higher is better?]
const STATS = [
  ['Power', (s) => `${s.powerKW.toFixed(0)} kW`, (s) => s.powerKW, (s) => `${s.torque} N·m`, true],
  ['Weight', (s) => `${Math.round(s.weight).toLocaleString()} kg`, (s) => s.weight, () => '', false],
  ['Crawl ratio', (s) => `${s.crawl.toFixed(0)}:1`, (s) => s.crawl, (s) => `${s.crawlKmh.toFixed(1)} km/h at idle`, true],
  ['Clearance', (s) => `${(s.clearance * 100).toFixed(0)} cm`, (s) => s.clearance, (s) => `belly ${(s.belly * 100).toFixed(0)} cm`, true],
  ['Tyres', (s) => `${s.tyreIn.toFixed(0)}"`, (s) => s.tyreIn, (s) => s.tread, true],
  ['Articulation', (s) => `${(s.travel * 100).toFixed(0)} cm`, (s) => s.travel, (s) => (s.flexDeg ? `±${s.flexDeg.toFixed(0)}° axle twist` : 'independent'), true],
];

export class Garage {
  constructor(RAPIER, VEHICLES, { onChange, onDrive }) {
    this.R = RAPIER; this.VEHICLES = VEHICLES; this.onChange = onChange;
    this.isOpen = false; this.angle = 0.6; this.car = null; this.view = null;
    $('gBack').addEventListener('click', () => this.close());
    $('gDrive').addEventListener('click', () => { this.close(); onDrive(); });
    $('gReset').addEventListener('click', () => { this.build = defaultBuild(this.base); this.changed(); });
    addEventListener('keydown', (e) => {
      if (!this.isOpen || e.code !== 'Escape') return;
      e.stopImmediatePropagation(); e.preventDefault(); this.close();
    }, true);
    const cv = $('gPreview');
    let drag = null;
    cv.addEventListener('pointerdown', (e) => { drag = e.clientX; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => { if (drag === null) return; this.angle -= (e.clientX - drag) * 0.01; drag = e.clientX; this.lastDrag = performance.now(); });
    cv.addEventListener('pointerup', () => { drag = null; });
  }

  initPreview() {
    const cv = $('gPreview');
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: false });
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap;
    // same pixel-art look as the game (src/gfx/pipeline.js): low-res, toon, outlines
    this.pixels = new PixelPipeline(r, { pixelHeight: 200 });
    const sc = this.scene = new THREE.Scene();
    sc.background = new THREE.Color(0x1c1915);
    sc.fog = new THREE.Fog(0x1c1915, 14, 30);
    sc.add(new THREE.HemisphereLight(0xfff1dc, 0x6a5a48, 1.7));
    const sun = new THREE.DirectionalLight(0xffe2b8, 2.6);
    sun.position.set(-5, 9, 4); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
    sc.add(sun); this.sun = sun;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshStandardMaterial({ color: 0x2a251f, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; sc.add(floor);
    const table = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.3, 0.04, 64), new THREE.MeshStandardMaterial({ color: 0x3b342b, roughness: 0.8 }));
    table.position.y = -0.02; table.receiveShadow = true; sc.add(table);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4.25, 0.025, 6, 96), new THREE.MeshBasicMaterial({ color: 0xffb340 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.01; sc.add(ring);
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    const R = this.R;
    this.world = new R.World({ x: 0, y: -9.81, z: 0 }); this.world.timestep = H;
    this.ground = this.world.createCollider(R.ColliderDesc.cuboid(30, 1, 30).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUP_WORLD));
  }

  open(i) {
    if (!this.renderer) this.initPreview();
    this.base = this.VEHICLES[i];
    this.build = loadBuild(this.base);
    $('gName').textContent = this.base.name;
    this.stock = stats(applyBuild(this.base, defaultBuild(this.base)));
    $('garage').classList.remove('hidden');
    const wasOpen = this.isOpen;
    this.isOpen = true;
    this.resize();
    this.changed(false);
    this.last = performance.now();
    if (!wasOpen) requestAnimationFrame((t) => this.frame(t));
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    $('garage').classList.add('hidden');
  }

  resize() {
    const cv = $('gPreview');
    const w = cv.clientWidth || 560, h = cv.clientHeight || 340;
    this.pixels.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  changed(save = true) {
    if (save) { saveBuild(this.base, this.build); this.onChange(); }
    this.spec = applyBuild(this.base, this.build);
    this.renderOptions();
    this.renderStats();
    this.rebuildPreview();
  }

  rebuildPreview() {
    if (this.car) { this.car.destroy(); this.view.dispose(); }
    const s = this.spec;
    this.car = new Vehicle(this.R, this.world, s, { ground: this.ground, rockHandles: new Set() }, { x: 0, y: s.tire.radius - s.axleY + 0.03, z: 0 }, 0);
    this.car.grace = 1e9; // never takes damage on the turntable
    for (let k = 0; k < 240; k++) this.car.step(IDLE, H); // settle onto its springs before the first frame
    this.view = new VehicleView(this.scene, this.car);
    this.view.update(null);
  }

  renderOptions() {
    const b = this.build, groups = buildOptions(this.base);
    $('gOpts').innerHTML = groups.map((g) => `
      <section class="gcat"><h4>${g.label}</h4>
        ${g.items.map((it) => `<div class="grow"><span class="glbl">${it.label}</span><div class="chips${it.swatch ? ' sw' : ''}">
          ${it.choices.map((c, k) => {
            const on = c.value === b[it.key];
            if (it.swatch) {
              const col = c.color === null ? '#4a4640' : hex(c.color);
              return `<button class="chip swatch${on ? ' on' : ''}${c.value === null ? ' stock' : ''}" data-key="${it.key}" data-k="${k}" title="${c.label}" style="background:${col}">${c.value === null ? 'STOCK' : ''}</button>`;
            }
            return `<button class="chip${on ? ' on' : ''}" data-key="${it.key}" data-k="${k}" data-note="${c.note || ''}">${c.label}</button>`;
          }).join('')}</div></div>`).join('')}
      </section>`).join('');
    const items = Object.fromEntries(groups.flatMap((g) => g.items).map((it) => [it.key, it]));
    $('gOpts').querySelectorAll('.chip').forEach((el) => {
      el.addEventListener('click', () => { this.build[el.dataset.key] = items[el.dataset.key].choices[+el.dataset.k].value; this.changed(); });
      el.addEventListener('mouseenter', () => { $('gNote').textContent = el.dataset.note || el.title || ''; });
    });
  }

  renderStats() {
    const s = stats(this.spec), s0 = this.stock;
    $('gStats').innerHTML = STATS.map(([label, txt, val, sub, up]) => {
      const v = val(s), v0 = val(s0);
      const d = v0 ? (v - v0) / v0 : 0;
      const frac = Math.min(1, v / (v0 * 1.8 || 1));
      const cls = Math.abs(d) < 0.005 ? '' : (d > 0) === up ? 'up' : 'down';
      const delta = Math.abs(d) < 0.005 ? '' : `${d > 0 ? '+' : ''}${(d * 100).toFixed(0)}%`;
      return `<div class="gstat"><span class="sl">${label}</span><b>${txt(s)}</b><em class="${cls}">${delta}</em>
        <div class="gbar"><i style="width:${(frac * 100).toFixed(1)}%" class="${cls}"></i><u style="left:${(100 / 1.8).toFixed(1)}%"></u></div>
        <small>${sub(s)}</small></div>`;
    }).join('') + `<div class="gstat gfoot"><span class="sl">Lockers</span><b>${s.lockers}</b><small>${this.spec.lsd ? 'LSD ' + Object.keys(this.spec.lsd).join(' + ') : ''}</small></div>`;
  }

  frame(now) {
    if (!this.isOpen) return;
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    if (!this.lastDrag || now - this.lastDrag > 1500) this.angle += dt * 0.35;
    for (let k = 0; k < Math.round(dt / H); k++) this.car.step(IDLE, H);
    this.view.update(null);
    const s = this.spec, L = s.chassis.size[2];
    const d = Math.max(7, L * 1.6 + 2), cy = this.car.chassis.translation().y;
    this.camera.position.set(Math.sin(this.angle) * d, cy + 1.4 + L * 0.1, Math.cos(this.angle) * d);
    this.camera.lookAt(0, cy + 0.3, 0);
    this.pixels.render(this.scene, this.camera, this.sun);
    requestAnimationFrame((t) => this.frame(t));
  }
}

const IDLE = { throttle: 0, brake: 0, steer: 0, handbrake: true };
