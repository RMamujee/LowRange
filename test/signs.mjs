// In-world sign legibility: parks the truck on the approach to each kind of sign at near, mid and
// far distances, at each pixel size, and measures from the rendered frame the on-screen letter
// height (px) and the text / background contrast (WCAG ratio of the 90th / 10th luminance
// percentiles inside the main text line), plus a motion-compensated shimmer figure from a burst
// of frames while the truck creeps towards a sign. Saves crops of every case.
//   CHROME=... PORT=5961 node test/signs.mjs <outdir> [tag] [cases filter regex] [pixel sizes, e.g. 1,2,3]
import { chromium } from 'playwright';
import fs from 'node:fs';

const out = process.argv[2] || 'signs_out';
const tag = process.argv[3] || 'now';
const filt = new RegExp(process.argv[4] || '.');
const sizes = (process.argv[5] || '1,2,3').split(',').map(Number);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const errors = [];

// sign kinds: map, how to find the face and the road centre beside it, distances (truck to sign, m)
const CASES = [
  { id: 'trail', map: '', kind: 'board', dists: [5, 15, 30], where: `const t = T.TRAILS[0]; const p = T.pathPoint(t, 6); return { road: [p.x, p.z], dir: [-p.tx, -p.tz] };` },
  { id: 'gate', map: '', kind: 'banner', dists: [6, 15, 40], where: `const t = T.TRAILS[0]; const p = T.pathPoint(t, 3); return { road: [p.x, p.z], dir: [-p.tx, -p.tz] };` },
  { id: 'trailhead', map: '', kind: 'board', dists: [6, 11, 30], where: `const p = T.TRAILHEAD; return { road: [p.x + 6, p.z - 10], dir: null };` },
  { id: 'stagegate', map: 'crawl', kind: 'banner', dists: [6, 20, 60], where: `const t = T.TRAILS[0], st = T.MAP.STAGES[2]; const p = T.pathPoint(t, st.gateS); return { road: [p.x, p.z], dir: [-p.tx, -p.tz], at: (d) => T.pathPoint(t, st.gateS - d) };` },
  { id: 'stagesign', map: 'crawl', kind: 'board', dists: [5, 15, 30], where: `const t = T.TRAILS[0], st = T.MAP.STAGES[2]; const p = T.pathPoint(t, st.s0 - 1); return { road: [p.x, p.z], dir: [-p.tx, -p.tz], at: (d) => T.pathPoint(t, st.s0 - 1 - d) };` },
  { id: 'checkpoint', map: 'race', kind: 'banner', dists: [6, 20, 40], where: `const c = T.CHECKPOINTS[1]; return { road: [c.x, c.z], dir: [-c.tx, -c.tz], at: (d) => T.MAP.trackFrame(c.s - d) };` },
  { id: 'gantry', map: 'race', kind: 'banner', dists: [8, 20, 40], where: `const c = T.CHECKPOINTS[0]; return { road: [c.x, c.z], dir: [-c.tx, -c.tz], at: (d) => T.MAP.trackFrame(c.s - d) };` },
  { id: 'venue', map: 'race', kind: 'board', dists: [8, 15, 30], where: `const f = T.MAP.trackFrame(T.CHECKPOINTS[0].s - 30); return { road: [f.x, f.z], dir: window.__venueAny ? null : [-f.tx, -f.tz], at: window.__venueAny ? null : (d) => T.MAP.trackFrame(T.CHECKPOINTS[0].s - 30 - d) };` },
].filter((c) => filt.test(c.id));

// main text line of the original (pre-pixel-font) textures, where the texture carries no
// userData.text: cap height and centre as fractions of the texture height, u range
const LEGACY = {
  trail: { cap: (56 * 0.7) / 256, cy: 0.4, u0: 0.3, u1: 0.95 },
  gate: { cap: (46 * 0.7) / 160, cy: 0.4, u0: 0.25, u1: 0.9 },
  trailhead: { cap: (56 * 0.7) / 256, cy: 0.4, u0: 0.25, u1: 0.75 },
  stagegate: { cap: (65 * 0.7) / 140, cy: 0.38, u0: 0.35, u1: 0.75 },
  stagesign: { cap: (56 * 0.7) / 256, cy: 0.38, u0: 0.45, u1: 0.9 },
  checkpoint: { cap: (64 * 0.7) / 128, cy: 0.53, u0: 0.3, u1: 0.7 },
  gantry: { cap: (64 * 0.7) / 128, cy: 0.53, u0: 0.3, u1: 0.7 },
  venue: { cap: (80 * 0.7) / 160, cy: 0.53, u0: 0.2, u1: 0.8 },
  // the stage signpost's big number (the other signs had their numbers in the title line)
  'stagesign#': { cap: (159 * 0.7) / 256, cy: 0.52, u0: 0.12, u1: 0.3 },
};

const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const lum = (r, g, b) => { const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };

const rows = [];
for (const px of sizes) {
  const byMap = {};
  for (const c of CASES) (byMap[c.map] ||= []).push(c);
  for (const [map, cases] of Object.entries(byMap)) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 969 } });
    await ctx.addInitScript(([px, look]) => { localStorage.setItem('lowrange.settings.v1', JSON.stringify({ pixelSize: px, look, quality: 'high', volume: 0 })); }, [px, process.env.LOOK || 'soft']);
    if (process.env.VENUE_ANY) await ctx.addInitScript(() => { window.__venueAny = true; });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://localhost:${process.env.PORT || 5961}/${map ? '?map=' + map : ''}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
    await page.evaluate(async () => { document.querySelectorAll('.card')[0].click(); document.getElementById('goBtn')?.click(); await new Promise((r) => setTimeout(r, 1500)); });
    for (const c of cases) {
      const shots = [];
      const dl = [...c.dists.map((d) => ({ d, name: String(d) }))];
      // shimmer burst: creeping in from the mid-far distance in small steps
      const far = c.dists[c.dists.length - 1], burst = px === 1 ? Array.from({ length: 10 }, (_, i) => ({ d: far * 0.8 - i * 0.37, name: `burst${i}` })) : [];
      for (const { d, name } of [...dl, ...burst]) {
        const m = await page.evaluate(async ({ where, kind, d, id, LEG }) => {
          const T = await import('/src/terrain.js');
          const THREE = { Vector3: window.__game.gfx.camera.position.constructor, DoubleSide: 2 };
          const g = window.__game, cam = g.gfx.camera, scene = g.gfx.scene;
          const w = new Function('T', where)(T);
          // candidate faces: meshes with a canvas-drawn sign texture
          let best = null;
          const v = new THREE.Vector3(), nrm = new THREE.Vector3();
          scene.traverse((o) => {
            if (!o.isMesh) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            const fi = mats.findIndex((m) => m.map && (m.map.isCanvasTexture || m.map.userData?.text));
            if (fi < 0) return;
            const isBox = o.geometry.type === 'BoxGeometry';
            if ((kind === 'board') !== isBox && !(kind === 'board' && o.geometry.type === 'PlaneGeometry' && mats[fi].map.userData?.text?.board)) return;
            if (isBox && fi !== 4) return;
            const P = o.geometry.parameters;
            o.updateWorldMatrix(true, false);
            v.set(0, 0, isBox ? P.depth / 2 : 0).applyMatrix4(o.matrixWorld);
            nrm.set(0, 0, 1).transformDirection(o.matrixWorld);
            const dist = Math.hypot(v.x - w.road[0], v.z - w.road[1]);
            if (dist > 16) return;
            // the face that looks back down the approach (or either face of a double-sided one)
            let facing = w.dir ? nrm.x * w.dir[0] + nrm.z * w.dir[1] : 1;
            const ds = mats[fi].side === THREE.DoubleSide;
            if (facing < 0.2 && !ds) return;
            const score = dist - (facing > 0.2 ? 5 : 0);
            if (!best || score < best.score) best = { o, fi, score, isBox, P, c: v.clone(), n: nrm.clone(), mirrored: ds && facing < 0 };
          });
          if (!best) return { err: 'no sign face found' };
          const n = best.mirrored ? best.n.clone().negate() : best.n;
          const nh = Math.hypot(n.x, n.z);
          const dir = [n.x / nh, n.z / nh];
          // road centre beside the sign, then back along the facing direction
          const lat = [w.road[0] - best.c.x, w.road[1] - best.c.z];
          const along = lat[0] * dir[0] + lat[1] * dir[1];
          const base = [best.c.x + lat[0] - dir[0] * along, best.c.z + lat[1] - dir[1] * along];
          let x = base[0] + dir[0] * d, z = base[1] + dir[1] * d, yaw = Math.atan2(dir[0], dir[1]);
          // where the sign stands on a course, the truck comes up the course itself (s - d)
          if (w.at) { const q = w.at(d); x = q.x; z = q.z; yaw = Math.atan2(-q.tx, -q.tz); }
          g.car.reset({ x, y: T.heightAt(x, z) + 1.8, z }, yaw);
          g.cam.yaw = 0; g.cam.pitch = 0.32; g.cam.dist = 9; g.cam.lastDrag = -10;
          await new Promise((r) => setTimeout(r, d < 0 ? 0 : 1700));
          // text band from the texture (pixel-font signs describe themselves) or the legacy table
          const mat = (Array.isArray(best.o.material) ? best.o.material : [best.o.material])[best.fi];
          const tx = mat.map.userData?.text || LEG[id];
          const W = best.isBox ? best.P.width : best.P.width, H = best.isBox ? best.P.height : best.P.height, zf = best.isBox ? best.P.depth / 2 : 0;
          const proj = (u, vv) => { const p = new THREE.Vector3((u - 0.5) * W * (best.mirrored ? -1 : 1), (vv - 0.5) * H, zf * (best.mirrored ? -1 : 1)).applyMatrix4(best.o.matrixWorld).project(cam); return [(p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight, p.z]; };
          const band = (tx) => {
            const vc = 1 - tx.cy; // canvas y down, texture v up
            const a = proj(0.5 * (tx.u0 + tx.u1), vc + tx.cap / 2), b = proj(0.5 * (tx.u0 + tx.u1), vc - tx.cap / 2);
            // sample grid over the line (a little taller than the caps), in screen px
            const grid = [];
            for (let j = 0; j < 12; j++) for (let i = 0; i < 60; i++) { const q = proj(tx.u0 + (tx.u1 - tx.u0) * (i + 0.5) / 60, vc - tx.cap * 0.65 + tx.cap * 1.3 * (j + 0.5) / 12); grid.push([q[0], q[1]]); }
            return { letter: Math.hypot(a[0] - b[0], a[1] - b[1]), grid };
          };
          const main = band(tx), nt = mat.map.userData?.num || LEG[id + '#'];
          const num = nt ? band(nt) : null;
          const letter = main.letter, grid = num ? main.grid.concat(num.grid) : main.grid;
          const corners = [proj(0, 0), proj(1, 0), proj(1, 1), proj(0, 1)];
          const cp = cam.getWorldPosition(new THREE.Vector3());
          return { letter, numLetter: num ? num.letter : null, nMain: main.grid.length, grid, corners, camDist: cp.distanceTo(best.c), offscreen: corners.some((q) => q[2] > 1), mirrored: best.mirrored };
        }, { where: c.where, kind: c.kind, d, id: c.id, LEG: LEGACY });
        if (m.err) { console.log(c.id, d, m.err); continue; }
        const buf = await page.screenshot();
        // analyse in the page: decode the PNG on a canvas, sample the grid, crop the sign
        const r = await page.evaluate(async ({ b64, m, crop }) => {
          const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
          const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
          const x = cv.getContext('2d'); x.drawImage(img, 0, 0);
          const d = x.getImageData(0, 0, img.width, img.height).data;
          const samples = m.grid.map(([gx, gy]) => { const i = (Math.round(Math.min(img.height - 1, Math.max(0, gy))) * img.width + Math.round(Math.min(img.width - 1, Math.max(0, gx)))) * 4; return [d[i], d[i + 1], d[i + 2]]; });
          let out = null;
          if (crop) {
            const xs = m.corners.map((q) => q[0]), ys = m.corners.map((q) => q[1]);
            const pad = 12, x0 = Math.max(0, Math.floor(Math.min(...xs) - pad)), y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
            const x1 = Math.min(img.width, Math.ceil(Math.max(...xs) + pad)), y1 = Math.min(img.height, Math.ceil(Math.max(...ys) + pad));
            const w = x1 - x0, h = y1 - y0;
            if (w > 2 && h > 2) {
              // enlarged with hard pixels so small far signs can still be inspected
              const k = Math.max(1, Math.min(8, Math.floor(360 / Math.max(h, 1)), Math.floor(900 / Math.max(w, 1))));
              const c2 = document.createElement('canvas'); c2.width = w * k; c2.height = h * k;
              const y = c2.getContext('2d'); y.imageSmoothingEnabled = false; y.drawImage(cv, x0, y0, w, h, 0, 0, w * k, h * k);
              out = c2.toDataURL('image/png').split(',')[1];
            }
          }
          return { samples, crop: out };
        }, { b64: buf.toString('base64'), m, crop: !/^burst/.test(name) });
        const LL = r.samples.map(([R, G, B]) => lum(R, G, B));
        const L = LL.slice(0, m.nMain), LN = LL.slice(m.nMain);
        const ratio = (A) => (pct(A, 0.9) + 0.05) / (pct(A, 0.1) + 0.05);
        const contrast = ratio(L), numContrast = LN.length ? ratio(LN) : null;
        if (r.crop) fs.writeFileSync(`${out}/${tag}_${c.id}_${name}m_${px}x.png`, Buffer.from(r.crop, 'base64'));
        shots.push({ name, d, letter: m.letter, contrast, numLetter: m.numLetter, numContrast, camDist: m.camDist, L, mirrored: m.mirrored, offscreen: m.offscreen });
      }
      // shimmer: mean absolute luminance change between consecutive burst frames at the same
      // points on the sign (the sample grid moves with the sign), relative to the text contrast span
      const b = shots.filter((s) => /^burst/.test(s.name));
      let shimmer = null;
      if (b.length > 1) {
        let acc = 0, nn = 0;
        for (let i = 1; i < b.length; i++) for (let k = 0; k < b[i].L.length; k++) { acc += Math.abs(Math.sqrt(b[i].L[k]) - Math.sqrt(b[i - 1].L[k])); nn++; }
        const span = Math.sqrt(pct(b[0].L, 0.9)) - Math.sqrt(pct(b[0].L, 0.1));
        shimmer = acc / nn / Math.max(span, 1e-3);
      }
      for (const s of shots.filter((s) => !/^burst/.test(s.name))) {
        const row = { tag, case: c.id, px, dist: s.d, camDist: +s.camDist.toFixed(1), letterPx: +s.letter.toFixed(1), contrast: +s.contrast.toFixed(2), numPx: s.numLetter === null ? null : +s.numLetter.toFixed(1), numContrast: s.numContrast === null ? null : +s.numContrast.toFixed(2), mirrored: s.mirrored, shimmer: shimmer === null ? null : +shimmer.toFixed(3) };
        rows.push(row); console.log(JSON.stringify(row));
      }
    }
    await ctx.close();
  }
}
fs.writeFileSync(`${out}/${tag}_results.json`, JSON.stringify(rows, null, 1));
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
