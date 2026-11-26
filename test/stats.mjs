import RAPIER from '@dimforge/rapier3d-compat';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H=1/200, id=process.argv[2]||'lc70';
const world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H; world.numSolverIterations=8;
const ground=world.createCollider(RAPIER.ColliderDesc.cuboid(200,1,200).setTranslation(0,-1,0).setFriction(1).setCollisionGroups(GROUP_WORLD));
const spec=ALL_VEHICLES.find(v=>v.id===id);
const car=new Vehicle(RAPIER, world, spec, {ground, rockHandles:new Set()}, {x:0,y:spec.tire.radius-spec.axleY+0.05,z:0}, 0);
const d=car.dt; const inp={throttle:0,brake:0,steer:0};
for(let i=0;i<1200;i++){ if(i===200){d.range='low'; d.gear=1; inp.throttle=0.3;}
  globalThis.__dtFail=0; globalThis.__dtPass=0;
  car.step(inp,H);
  if (i%50===0 || globalThis.__dtFail) console.log(i, 'passes', globalThis.__dtPass, 'fail', globalThis.__dtFail, 'N', car.patches.map(p=>(p.N/1000).toFixed(1)).join(','), 'spin', car.wheelState.map(w=>w.spin.toFixed(1)).join(','));
  if (i>260 && i%50!==0 && globalThis.__dtFail && i>400) break;
}
