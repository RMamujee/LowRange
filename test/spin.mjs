import RAPIER from '@dimforge/rapier3d-compat';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H=1/200, id=process.argv[2]||'mule';
const world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H; world.numSolverIterations=8;
const ground=world.createCollider(RAPIER.ColliderDesc.cuboid(200,1,200).setTranslation(0,-1,0).setFriction(1).setCollisionGroups(GROUP_WORLD));
const spec=VEHICLES.find(v=>v.id===id);
const car=new Vehicle(RAPIER, world, spec, {ground, rockHandles:new Set()}, {x:0,y:spec.tire.radius-spec.axleY+0.05,z:0}, 0);
const inp={throttle:0,brake:0,steer:0};
for(let i=0;i<400;i++){ car.prePhysics(inp,H); const pre=[0,1,2,3].map(k=>car.wheelSpin(k)); world.step(); const mid=[0,1,2,3].map(k=>car.wheelSpin(k)); car.postPhysics(inp,H);
 if(i>=150&&i<162) console.log(i,'preStep',pre.map(x=>x.toFixed(2)).join(','),'afterRapier',mid.map(x=>x.toFixed(2)).join(','),'afterSolve',car.wheelState.map(w=>w.spin.toFixed(2)).join(','),'rowsL v0/imp',car.patches.map(p=>p.rowL.v0.toFixed(2)+'/'+p.rowL.imp.toFixed(1)+(p.rowL.clamped?'C':'')).join(' '), 'N',car.patches.map(p=>(p.N/1000).toFixed(0)).join(','));}
