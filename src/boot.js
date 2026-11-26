// Entry point: put the loading screen up first, then load the game in stages, yielding a frame between
// the heavy synchronous steps so the screen can actually paint its progress.
import { createLoadingScreen } from './ui/loading.js';

const loader = createLoadingScreen();
// resolve after the next frame has been painted (rAF fires before paint; the timeout runs after it)
const painted = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
// main.js calls this between its own heavy steps
window.__loadStage = async (label) => { loader.setStage(label); await painted(); };

try {
  await window.__loadStage('Waking the physics');
  const [{ default: RAPIER }] = await Promise.all([import('@dimforge/rapier3d-compat'), import('three')]);
  loader.setProgress(0.1);
  await RAPIER.init();
  await window.__loadStage('Grading the trails');
  await import('./terrain.js');   // the heightfield bakes at import time
  await import('./main.js');      // reports 'Planting trees' and 'Fuelling up' itself
  delete window.__loadStage;
  await loader.finish();
} catch (err) {
  loader.fail(err);
  throw err;
}
