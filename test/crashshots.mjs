// Crash previews in the real game (needs a dev server): for each rig, before/after shots of
// frontal hits into the race track's concrete barriers (10 / 30 / 60 km/h), 5 m drops onto the
// wheels and onto the roof, a tumble, and (park map) a sideways slide into a tree at 40 km/h.
// Each scenario starts from an in-place repair (vehicle.repair() + view.repairDamage()), which
// is exercised (and shot) along the way.
// usage: CHROME=... PORT=5931 node test/crashshots.mjs <outdir> [rigs=0,1,2] [scenarios=wall10,wall30,wall60,drop5,roof5,roll,tree40,repair]
import { chromium } from 'playwright';
const out = process.argv[2] || 'test/shots';
const rigs = (process.argv[3] || '0,1,2').split(',').map(Number);
const want = (process.argv[4] || 'wall10,wall30,wall60,drop5,roof5,roll,tree40,repair').split(',');
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const errors = [];
const NAMES = ['taco', 'lc70', 'wrx'];

async function open(qs) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${process.env.PORT || 5931}/${qs}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
  return page;
}
async function pick(page, idx) {
  await page.evaluate(async (idx) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const kd = (c) => dispatchEvent(new KeyboardEvent('keydown', { code: c })), ku = (c) => dispatchEvent(new KeyboardEvent('keyup', { code: c }));
    if (document.getElementById('menu').classList.contains('hidden')) { kd('Escape'); await sleep(150); }
    document.querySelectorAll('.card')[idx].click();
    document.getElementById('goBtn').click();
    await sleep(1500);
    if (window.__game.parkBrake) { kd('KeyP'); await sleep(50); ku('KeyP'); }
  }, idx);
}
// page-side helpers, injected once per page
const HELPERS = `
window.__crash = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  fresh() { const g = window.__game; g.car.repair(); g.view.repairDamage(); },
  async place(x, z, yaw, lift = 0.4) {
    const T = await import('/src/terrain.js'); const c = window.__game.car;
    c.reset({ x, y: T.heightAt(x, z) + c.spec.tire.radius - c.spec.axleY + lift, z }, yaw);
    window.__game.cam.heading = yaw; await this.sleep(2200); c.grace = 0; // settle (damage grace off)
  },
  // whole rig to a velocity (wheels spun up to match so they roll instead of skidding)
  launch(vx, vy, vz, w) {
    const c = window.__game.car;
    for (const b of c.allBodies) { b.setLinvel({ x: vx, y: vy, z: vz }, true); if (w) b.setAngvel(w, true); }
    if (!w) {
      const q = c.chassis.rotation(), sp = Math.hypot(vx, vz);
      c.wheels.forEach((wb, i) => { const ax = c.wheelAxis(i); wb.setAngvel({ x: -ax.x * sp / c.spec.tire.radius, y: -ax.y * sp / c.spec.tire.radius, z: -ax.z * sp / c.spec.tire.radius }, true); });
    }
  },
  cam(yaw, pitch, dist) { const c = window.__game.cam; c.yaw = yaw; c.pitch = pitch; c.dist = dist; c.lastDrag = 1e9; c.mode = 0; },
  report() {
    const c = window.__game.car, r = c.crash.report(), d = window.__game.view.damage.stats();
    return { body: +c.health.body.toFixed(2), eng: +c.health.engine.toFixed(2), dead: c.dt.dead, susp: c.health.susp.map((x) => +x.toFixed(2)), broken: c.broken.filter(Boolean).length,
      mesh: +d.max.toFixed(2), front: +d.zones.front.max.toFixed(2), roof: +d.zones.roof.max.toFixed(2), left: +d.zones.left.max.toFixed(2), glass: d.glass, lamps: d.lamps, off: r.detached, rad: +r.radiator.toFixed(2), frameMs: +c.crash.peak.frameMs.toFixed(2) };
  },
};`;
async function shot(page, name) { await page.screenshot({ path: `${out}/${name}.png` }); }

// ---- race map: barriers, drops, roof, tumble
const SCEN = {
  // concrete barrier row along z ~ 122 west of the start; come at it from the north (yaw 0 = facing -z)
  wall: (kmh) => `(async () => { const C = window.__crash; C.fresh(); await C.place(-61.5, 127.5, 0); C.cam(Math.PI * 0.68, 0.2, 4.6); await C.sleep(400); return 'ready'; })()`,
  wallGo: (kmh) => `(async () => { const C = window.__crash; C.launch(0, 0, -${kmh} / 3.6); await C.sleep(2600); C.cam(Math.PI * 0.68, 0.2, 4.6); await C.sleep(1200); return C.report(); })()`,
  drop: `(async () => { const C = window.__crash; C.fresh(); const S = window.__game.car.chassis.translation(); await C.place(-40, 131, -1.66, 0.3); C.cam(0.9, 0.25, 7.5); await C.sleep(300); return 'ready'; })()`,
  dropGo: (h) => `(async () => { const C = window.__crash; const c = window.__game.car, p = c.chassis.translation(); c.reset({ x: p.x, y: p.y + ${h}, z: p.z }, c.attitude().heading); c.grace = 0; await C.sleep(3200); C.cam(0.9, 0.25, 7.5); await C.sleep(500); return C.report(); })()`,
  roofGo: `(async () => { const C = window.__crash; const c = window.__game.car, p = c.chassis.translation(); c.reset({ x: p.x, y: p.y + 5.6, z: p.z }, c.attitude().heading);
    const q = c.chassis.rotation(), cq = { x: q.x, y: q.y, z: q.z, w: q.w }, f = { x: 0, y: 0, z: 1, w: 0 }; // roll 180 about the truck's own forward axis
    const qm = (a, b) => ({ x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z });
    const rot = qm(qm(cq, f), { x: -cq.x, y: -cq.y, z: -cq.z, w: cq.w }), c0 = c.chassis.translation();
    const rv = (r, v) => { const t = qm(qm(r, { x: v.x, y: v.y, z: v.z, w: 0 }), { x: -r.x, y: -r.y, z: -r.z, w: r.w }); return t; };
    for (const b of c.allBodies) { const bp = b.translation(), d = rv(rot, { x: bp.x - c0.x, y: bp.y - c0.y, z: bp.z - c0.z }); b.setTranslation({ x: c0.x + d.x, y: c0.y + d.y, z: c0.z + d.z }, true); b.setRotation(qm(rot, b.rotation()), true); }
    c.grace = 0; await C.sleep(3500); C.cam(1.2, 0.35, 7); await C.sleep(500); return C.report(); })()`,
  rollGo: `(async () => { const C = window.__crash; const c = window.__game.car, p = c.chassis.translation(); c.reset({ x: p.x, y: p.y + 1.6, z: p.z }, c.attitude().heading); c.grace = 0;
    const q = c.chassis.rotation(), rx = 2 * (q.x * q.y + q.w * q.z), right = { x: 1 - 2 * (q.y * q.y + q.z * q.z), y: 0, z: 2 * (q.x * q.z - q.w * q.y) }, fwd = { x: -2 * (q.x * q.z + q.w * q.y), z: -(1 - 2 * (q.x * q.x + q.y * q.y)) };
    // thrown sideways (to its left) with a roll towards that side, like a tripped slide
    for (const b of c.allBodies) { b.setLinvel({ x: -right.x * 10, y: -1, z: -right.z * 10 }, true); b.setAngvel({ x: fwd.x * 6, y: 0, z: fwd.z * 6 }, true); }
    await C.sleep(5000); C.cam(1.0, 0.35, 8); await C.sleep(500); return C.report(); })()`,
  repaired: `(async () => { const C = window.__crash; C.fresh(); await C.sleep(1600); C.cam(Math.PI * 0.8, 0.3, 6.5); await C.sleep(400); return C.report(); })()`,
};

if (want.some((w) => w !== 'tree40')) {
  const page = await open('?map=race');
  await page.evaluate(HELPERS);
  for (const i of rigs) {
    const id = NAMES[i];
    await pick(page, i);
    for (const kmh of [10, 30, 60]) {
      if (!want.includes('wall' + kmh)) continue;
      await page.evaluate(SCEN.wall(kmh));
      if (kmh === 30) await shot(page, `crash_${id}_wall_before`);
      const r = await page.evaluate(SCEN.wallGo(kmh));
      await shot(page, `crash_${id}_wall${kmh}`);
      console.log(id, `wall ${kmh}`, JSON.stringify(r));
    }
    if (want.includes('repair')) { const r = await page.evaluate(SCEN.repaired); await shot(page, `crash_${id}_repaired`); console.log(id, 'repaired', JSON.stringify(r)); }
    if (want.includes('drop5')) { await page.evaluate(SCEN.drop); const r = await page.evaluate(SCEN.dropGo(5)); await shot(page, `crash_${id}_drop5`); console.log(id, 'drop 5 m', JSON.stringify(r)); }
    if (want.includes('roof5')) { await page.evaluate(SCEN.drop); const r = await page.evaluate(SCEN.roofGo); await shot(page, `crash_${id}_roof5`); console.log(id, 'roof 5 m', JSON.stringify(r)); }
    if (want.includes('roll')) { await page.evaluate(SCEN.drop); const r = await page.evaluate(SCEN.rollGo); await shot(page, `crash_${id}_roll`); console.log(id, 'tumble', JSON.stringify(r)); }
  }
  await page.close();
}
// ---- park map: sideways into a tree (tree at 2.39, 27.19, r 0.22 * 1.39)
if (want.includes('tree40')) {
  const page = await open('');
  await page.evaluate(HELPERS);
  for (const i of rigs) {
    const id = NAMES[i];
    await pick(page, i);
    await page.evaluate(`(async () => { const C = window.__crash; C.fresh(); const cw = window.__game.car.spec.chassis.size[0]; await C.place(2.39 + cw / 2 + 2.2, 27.19 + 0.9, 0); C.cam(-Math.PI / 2 + 0.5, 0.3, 7); await C.sleep(300); })()`);
    await shot(page, `crash_${id}_tree_before`);
    const r = await page.evaluate(`(async () => { const C = window.__crash; C.launch(-40 / 3.6, 0, 0, { x: 0, y: 0, z: 0 }); await C.sleep(2500); C.cam(-Math.PI / 2 + 0.6, 0.3, 6.5); await C.sleep(900); return C.report(); })()`);
    await shot(page, `crash_${id}_tree40`);
    console.log(id, 'tree 40 km/h', JSON.stringify(r));
  }
  await page.close();
}
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
