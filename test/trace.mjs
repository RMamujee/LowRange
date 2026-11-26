import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt } from '../src/terrain.js';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
await RAPIER.init();
const H=1/200, world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H; world.numSolverIterations=8;
const rocks=generateRocks(), terrain=buildTerrainPhysics(RAPIER, world, rocks, generateTrees(rocks));
const spec=ALL_VEHICLES.find(v=>v.id===(process.argv[2]||'lc70'));
const car=new Vehicle(RAPIER, world, spec, terrain, {x:0,y:heightAt(0,0)+spec.tire.radius-spec.axleY+0.3,z:0}, 0);
const input={throttle:0,brake:0,steer:0,handbrake:false}; const d=car.dt;
let tt=0; const run=(s)=>{for(let i=0;i<Math.round(s/H);i++){car.step(input,H);tt+=H;}};
run(2); d.range='low'; d.gear=1; input.throttle=+(process.argv[3]||0.6);
for(let k=0;k<16;k++){ run(0.5); const p=car.chassis.translation(),a=car.attitude();
 console.log(`t=${tt.toFixed(1)} z=${p.z.toFixed(1)} ground=${heightAt(p.x,p.z).toFixed(2)} slope=${((heightAt(p.x,p.z-1)-heightAt(p.x,p.z+1))/2*57.3).toFixed(0)}deg v=${(car.speed()*3.6).toFixed(1)} rpm=${d.rpm.toFixed(0)} pitch=${(a.pitch*57.3).toFixed(1)} spins=${car.wheelState.map(w=>(w.spin*spec.tire.radius*3.6).toFixed(1)).join(',')} T=${d.wheelTorque.map(x=>x.toFixed(0)).join(',')} g=${car.wheelState.map(w=>w.grounded?1:0).join('')}`);}
