import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt } from '../src/terrain.js';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
await RAPIER.init();
const H=1/200, world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H;
const rocks=generateRocks(), terrain=buildTerrainPhysics(RAPIER, world, rocks, generateTrees(rocks));
const spec=VEHICLES[0];
const car=new Vehicle(RAPIER, world, spec, terrain, {x:0,y:heightAt(0,4)+spec.tire.radius-spec.axleY+0.3,z:4}, 0);
const inp={throttle:0,brake:0,steer:0};
for(let i=0;i<300;i++){car.step(inp,H);}
const col=car.wheelColliders[0];
world.contactPairsWith(col, o=>{ world.contactPair(col,o,(m,f)=>{ const n=m.numContacts(); const arr=[]; for(let k=0;k<n;k++) arr.push(m.contactDist(k).toFixed(3)+'/'+m.contactImpulse(k).toFixed(2)); console.log('n',n,'solver',m.numSolverContacts(),arr.join(' '), 'normal', JSON.stringify(m.normal())); }); });
console.log('patches', car.patches.length, 'wheel y', car.wheels[0].translation().y.toFixed(3), 'ground', heightAt(car.wheels[0].translation().x, car.wheels[0].translation().z).toFixed(3));
