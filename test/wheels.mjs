// Headless check of the glTF wheels: on every vehicle all four wheel instances must show their
// modelled rim face outwards (the left pair mirrored, the right pair not), match the physics tyre
// size, hide the procedural brake disc/caliper, and take the garage rim colour.
// CHROME=<chromium exe> PORT=5891 node test/wheels.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${process.env.PORT || 5199}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 60000 });

const check = (vehicle) => page.evaluate(async (vehicle) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!document.getElementById('menu').classList.contains('hidden')) { document.querySelectorAll('.card')[vehicle].click(); document.getElementById('goBtn').click(); }
  else { dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })); await sleep(100); document.querySelectorAll('.card')[vehicle].click(); document.getElementById('goBtn').click(); }
  await sleep(1500);
  const view = window.__game.view, spec = window.__game.car.spec;
  const fails = [];
  view.body.updateMatrixWorld(true);
  const toBody = view.body.matrixWorld.clone().invert(); // (bare 'three' isn't importable from the page)
  const p = view.body.position.clone(), centre = p.clone(), rimC = p.clone();
  let rimSeen = 0;
  view.wheels.forEach((w, i) => {
    const side = i % 2 ? 1 : -1; // FL, FR, RL, RR: left is -X
    const assets = w.children.filter((c) => c.visible && c.userData.wheelAsset);
    if (assets.length !== 1) { fails.push(`wheel ${i}: ${assets.length} visible glTF wheels`); return; }
    const m = assets[0];
    m.updateMatrixWorld(true);
    if (Math.sign(m.matrixWorld.determinant()) !== side) fails.push(`wheel ${i}: mirrored=${m.matrixWorld.determinant() < 0} on the ${side < 0 ? 'left' : 'right'}`);
    centre.setFromMatrixPosition(w.matrixWorld).applyMatrix4(toBody);
    // the rim centre (faces near the spin axis) must sit on the outboard face of the tyre
    rimC.set(0, 0, 0); let n = 0, rMax = 0;
    const R0 = m.userData.tyre_radius;
    m.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      if (o.name === 'WheelRim') rimSeen++;
      const pos = o.geometry.attributes.position;
      for (let k = 0; k < pos.count; k++) {
        const r = Math.hypot(pos.getY(k), pos.getZ(k));
        p.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld).applyMatrix4(toBody);
        rMax = Math.max(rMax, p.clone().sub(centre).setX(0).length());
        if (r < R0 * 0.3) { rimC.add(p); n++; }
      }
    });
    rimC.divideScalar(Math.max(n, 1));
    const out = (rimC.x - centre.x) * side;
    if (!(out > 0.02)) fails.push(`wheel ${i}: rim centre ${out.toFixed(3)} m outboard (rim faces the inside)`);
    if (Math.abs(rMax - spec.tire.radius) > spec.tire.radius * 0.08) fails.push(`wheel ${i}: drawn radius ${rMax.toFixed(3)} vs tyre ${spec.tire.radius}`);
  });
  view.hubs.forEach((h, i) => { if (h.children[0].visible || h.children[1].visible) fails.push(`hub ${i}: procedural disc/caliper still visible`); });
  return { id: spec.id, rimColor: spec.rimColor, rimSeen, fails };
}, vehicle);

let bad = 0;
const report = (r, wantRim) => {
  if (wantRim && r.rimSeen !== 4) r.fails.push(`garage rim colour: ${r.rimSeen}/4 wheels have a tinted rim mesh`);
  if (!wantRim && r.rimSeen) r.fails.push('stock build should keep the modelled rim texture');
  console.log(r.id, wantRim ? `rim #${r.rimColor.toString(16)}` : 'stock', r.fails.length ? 'FAIL\n  ' + r.fails.join('\n  ') : 'ok');
  bad += r.fails.length;
};
await page.evaluate(() => localStorage.removeItem('lowrange.builds.v1'));
for (const v of [0, 1, 2]) report(await check(v), false);
// garage: bigger tyres + a rim colour on every rig
await page.evaluate(() => localStorage.setItem('lowrange.builds.v1', JSON.stringify({ taco: { tyreSize: 2, rim: 0xc03020 }, lc70: { tyreSize: 1, rim: 0xe9e4d4 }, wrx: { tyreSize: 1, rim: 0x232427 } })));
for (const v of [0, 1, 2]) report(await check(v), true);
await page.evaluate(() => localStorage.removeItem('lowrange.builds.v1'));
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
process.exit(bad || errors.length ? 1 : 0);
