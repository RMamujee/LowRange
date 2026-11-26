import RAPIER from '@dimforge/rapier3d-compat';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle, qrot } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H=1/200, id=process.argv[2]||'lc70', mode=process.argv[3]||'full';
const world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H; world.numSolverIterations=8;
const ground=world.createCollider(RAPIER.ColliderDesc.cuboid(200,1,200).setTranslation(0,-1,0).setFriction(1).setCollisionGroups(GROUP_WORLD));
const spec=ALL_VEHICLES.find(v=>v.id===id);
const car=new Vehicle(RAPIER, world, spec, {ground, rockHandles:new Set()}, {x:0,y:spec.tire.radius-spec.axleY+0.05,z:0}, 0);
const inp={throttle:0,brake:0,steer:0};
const f=(a)=>`(${a.x.toFixed(1)},${a.y.toFixed(1)},${a.z.toFixed(1)})`;
for(let i=0;i<400;i++){ if(mode!=='raw') car.prePhysics(inp,H); world.step(); if(mode==='full') car.postPhysics(inp,H);
 if(i%40===0||(i>150&&i<156)) console.log(i,'wheel0 w',f(car.wheels[0].angvel()),'knuckle0 w',f(car.knuckles[0].angvel()),'axle0 w',f(car.axles[0].body.angvel()),'chassis w',f(car.chassis.angvel()), 'spin', [0,1,2,3].map(k=>car.wheelSpin(k).toFixed(1)).join(','));}
