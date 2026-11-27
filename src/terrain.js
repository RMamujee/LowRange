// The active map. Each map module (src/maps/*.js) bakes its heightfield, materials and
// paths at import; this facade loads the one chosen by `?map=` in the browser (or the MAP
// env var in Node) and re-exports it under one interface, so physics, views and tests
// don't care which map they run on. Switching maps reloads the page with a new ?map=.
import * as common from './maps/common.js';
import { MudField } from './mud.js';
export { MAT, MAT_INFO, MUD_SINK, DIFF, fbm, rng, pathPoint, GROUP_WORLD, GROUP_VEHICLE } from './maps/common.js';

export const MAPS = [
  { id: 'park', name: 'Trail Park' },
  { id: 'race', name: 'Race Track' },
  { id: 'crawl', name: 'The Gauntlet' },
  { id: 'jungle', name: 'Coralume Island' }, // [jungle] src/maps/jungle.js
  { id: 'desert', name: 'Sunfall Basin' }, // [desert] src/maps/desert.js
];
const want = (globalThis.location && new URLSearchParams(globalThis.location.search).get('map')) || globalThis.process?.env?.MAP || 'park';
// only known ids map to fixed module paths; if the chosen map fails to load, fall back to the park
let M;
try {
  M = want === 'race' ? await import('./maps/racetrack.js') : want === 'crawl' ? await import('./maps/crawl.js') : want === 'jungle' ? await import('./maps/jungle.js') : want === 'desert' ? await import('./maps/desert.js') : await import('./maps/trailpark.js');
} catch (e) {
  console.warn(`Map "${want}" failed to load, falling back to the Trail Park`, e);
  M = await import('./maps/trailpark.js');
}
export const MAP_ID = M.ID;

export const MAP = M;
export const MAP_NAME = M.NAME;
export const MAP_KIND = M.KIND;           // 'trails' | 'race'
export const SIZE = M.SIZE, RES = M.RES, GRID = M.GRID;
export const heightAt = M.heightAt, visualHeightAt = M.visualHeightAt, materialAt = M.materialAt;
export const surfaceAt = M.surfaceAt ?? M.heightAt; // where a truck is placed: a map with decks above its ground (bridges, a dock) gives the top surface
export const SPAWN = M.SPAWN;             // { x, z, yaw } where a fresh truck is placed
export const ROADS = M.ROADS ?? [];
export const TRAILS = M.TRAILS ?? [];
export const TRAILHEAD = M.TRAILHEAD ?? null;
export const COURSES = M.COURSES ?? [];   // timed side courses with sections (The Gauntlet map)
export const TRACK = M.TRACK ?? null;     // race map: the closed-loop centreline
export const CHECKPOINTS = M.CHECKPOINTS ?? [];
export const PROPS = M.PROPS ?? [];       // box colliders (barriers, tyre walls)
export const generateRocks = M.generateRocks;
export const generateTrees = M.generateTrees;
export const sandDepthAt = M.sandDepthAt ?? null; // [deep sand] the desert's dune sand depth (src/deepsand.js); null on other maps

// [mud] each physics world gets the map's deformable mud (src/mud.js): ruts, dug holes, churn
export function buildTerrainPhysics(RAPIER, world, rocks, trees) {
  const t = common.buildTerrainPhysics(RAPIER, world, M, rocks, trees, PROPS);
  t.mud = new MudField(M);
  return t;
}
