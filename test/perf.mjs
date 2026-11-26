// Rough render cost: times the pixel pipeline (src/gfx/pipeline.js) against a plain full-res
// render of the same scene, each followed by a 1 px readback so the GPU work is included.
//   CHROME=... PORT=5199 [GPU=1] [QS='?map=race'] node test/perf.mjs
// GPU=1 asks headless Chromium for the real GPU (D3D11); SW=1 forces SwiftShader (a CPU
// rasteriser: fill-rate bound like a weak iGPU, so only the ratio between the two numbers means
// anything); neither = the shots.mjs default flags.
import { chromium } from 'playwright';
const args = process.env.GPU === '1' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
  : process.env.SW === '1' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : ['--use-gl=angle', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ executablePath: process.env.CHROME, args });
const page = await browser.newPage({ viewport: { width: +(process.env.W || 1600), height: +(process.env.H || 900) } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${process.env.PORT || 5199}/${process.env.QS || ''}`);
await page.waitForFunction(() => window.__game && window.__game.car, null, { timeout: 90000 });
const r = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  document.getElementById('goBtn').click();
  await sleep(2500);
  const { renderer, pixels, scene, camera, sun } = window.__game.gfx;
  const gl = renderer.getContext(), px = new Uint8Array(4);
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const time = (fn, n = 40) => {
    for (let i = 0; i < 5; i++) fn();
    sync();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { fn(); sync(); }
    return +((performance.now() - t0) / n).toFixed(2);
  };
  const pipeMs = time(() => pixels.render(scene, camera, sun));
  renderer.info.reset();
  renderer.info.autoReset = false;
  pixels.render(scene, camera, sun);
  const calls = renderer.info.render.calls, tris = renderer.info.render.triangles;
  renderer.info.autoReset = true;
  renderer.setRenderTarget(null);
  const directMs = time(() => renderer.render(scene, camera));
  return {
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?',
    canvas: [renderer.domElement.width, renderer.domElement.height], internal: [pixels.w, pixels.h, 'x' + pixels.scale],
    pipelineMs: pipeMs, directFullResMs: directMs, drawCalls: calls, triangles: tris,
  };
});
console.log(JSON.stringify(r));
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
