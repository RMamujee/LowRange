import RAPIER from '@dimforge/rapier3d-compat';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H=1/200, id=process.argv[2]||'lc70', mode=process.argv[3]||'full';
const world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H; world.numSolverIterations=+(process.argv[4]||8);
const ground=world.createCollider(RAPIER.ColliderDesc.cuboid(200,1,200).setTranslation(0,-1,0).setFriction(1).setCollisionGroups(GROUP_WORLD));
const spec=ALL_VEHICLES.find(v=>v.id===id);
const car=new Vehicle(RAPIER, world, spec, {ground, rockHandles:new Set()}, {x:0,y:spec.tire.radius-spec.axleY+0.05,z:0}, 0);
const inp={throttle:0,brake:0,steer:0};
let ys=[];
for(let i=0;i<600;i++){ if(mode!=='raw') car.prePhysics(inp,H); world.step(); if(mode==='full') car.postPhysics(inp,H);
  if(i>=300) ys.push(car.chassis.translation().y); }
const mn=Math.min(...ys), mx=Math.max(...ys);
const wy=car.wheels.map(w=>w.translation().y.toFixed(3));
console.log(id, mode, 'chassis y range after settle', mn.toFixed(3), mx.toFixed(3), 'wheel y', wy.join(','), 'comp', car.compression().map(c=>c.toFixed(3)).join(','));
