import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt, TRAILS, pathPoint } from '../src/terrain.js';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
await RAPIER.init();
const H=1/200, world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H;
const rocks=generateRocks(), terrain=buildTerrainPhysics(RAPIER, world, rocks, generateTrees());
const t=TRAILS[1]; const spec=VEHICLES[0];
for (let s=4;s<=20;s+=2){ const p=pathPoint(t,s); console.log('s',s,'ground',heightAt(p.x,p.z).toFixed(2), 'pathH', p.h.toFixed(2)); }
const near=rocks.filter(r=>{const p=pathPoint(t,14); return Math.hypot(r.x-p.x,r.z-p.z)<6;});
for(const r of near){ let ymax=-1e9,ymin=1e9; for(let i=1;i<r.pts.length;i+=3){ymax=Math.max(ymax,r.pts[i]);ymin=Math.min(ymin,r.pts[i]);} const p=pathPoint(t,14); console.log('rock', r.ledge?'LEDGE':'boulder', 'dist',Math.hypot(r.x-p.x,r.z-p.z).toFixed(1), 'top above ground', (r.y+ymax-heightAt(r.x,r.z)).toFixed(2)); }
