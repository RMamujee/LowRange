import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt } from '../src/terrain.js';
import { VEHICLES } from '../src/specs.js';
import { Vehicle, qrot } from '../src/vehicle.js';
await RAPIER.init();
const H=1/200, world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H; world.numSolverIterations=8;
const rocks=generateRocks(), terrain=buildTerrainPhysics(RAPIER, world, rocks, generateTrees());
for (const spec of VEHICLES){
  const car=new Vehicle(RAPIER, world, spec, terrain, {x:6,y:heightAt(6,-4)+spec.tire.radius-spec.axleY+0.4,z:-4}, -Math.PI*0.31);
  const d=car.dt; const inp={throttle:0,brake:0,steer:0}; const run=s=>{for(let i=0;i<s/H;i++)car.step(inp,H);};
  run(1); d.range='low'; d.gear=1; inp.throttle=1; run(0.6); const sq=car.attitude().pitch*57.3, comp=car.compression();
  d.range='high'; d.gear=1; inp.throttle=0.5; run(2); inp.steer=1; run(2.5);
  const a=car.attitude(); const c2=car.compression();
  console.log(spec.id.padEnd(7), `launch pitch ${sq.toFixed(1)}° comp ${comp.map(x=>x.toFixed(2)).join(',')} | turn @${(car.speed()*3.6).toFixed(0)}km/h body roll ${(a.roll*57.3).toFixed(1)}° comp ${c2.map(x=>x.toFixed(2)).join(',')}`);
  car.destroy();
}
