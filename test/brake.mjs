import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt, ROADS, pathPoint } from '../src/terrain.js';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
await RAPIER.init();
const H=1/200;
const world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H; world.numSolverIterations=8;
const rocks=generateRocks(), terrain=buildTerrainPhysics(RAPIER, world, rocks, generateTrees());
for (const spec of VEHICLES){
  const car=new Vehicle(RAPIER, world, spec, terrain, {x:-4,y:heightAt(-4,4)+spec.tire.radius-spec.axleY+0.4,z:4}, -Math.PI*0.3);
  const inp={throttle:0,brake:0,steer:0}; const run=s=>{for(let i=0;i<s/H;i++)car.step(inp,H);};
  run(1); car.dt.range='low'; car.dt.gear=1; inp.throttle=0.7; run(2.5); const v1=car.speed()*3.6;
  inp.throttle=0; inp.brake=1; run(0.8); const v2=car.speed()*3.6; run(2); const v3=car.speed()*3.6;
  inp.brake=0; car.dt.range='high'; car.dt.gear=2; inp.throttle=1; run(4); const v4=car.speed()*3.6; inp.throttle=0; inp.brake=1; let t=0; while(Math.abs(car.speed())>0.1 && t<6){run(0.05); t+=0.05;}
  console.log(spec.id.padEnd(7), `L1: ${v1.toFixed(1)} km/h -> after 0.8s brake ${v2.toFixed(1)}, after 2.8s ${v3.toFixed(1)} | H2 ${v4.toFixed(1)} km/h stops in ${t.toFixed(2)}s`);
  car.destroy();
}
