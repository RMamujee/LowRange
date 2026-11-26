// Auto-clutch: no creep at zero throttle on the flat, engine braking still works downhill.
import RAPIER from '@dimforge/rapier3d-compat';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H=1/200;
for (const id of ['taco','lc70','wrx']) {
  for (const deg of [0, -15]) {
    const world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H;
    const a=deg/57.3;
    world.createCollider(RAPIER.ColliderDesc.cuboid(200,1,200).setTranslation(0,-1,0).setRotation({x:Math.sin(a/2),y:0,z:0,w:Math.cos(a/2)}).setFriction(1).setCollisionGroups(GROUP_WORLD));
    const spec=ALL_VEHICLES.find(v=>v.id===id);
    const car=new Vehicle(RAPIER, world, spec, {ground:{handle:-1}, rockHandles:new Set()}, {x:0,y:spec.tire.radius-spec.axleY+0.3+Math.abs(Math.tan(a))*0,z:0}, 0);
    const inp={throttle:0,brake:1,steer:0}; const run=s=>{for(let i=0;i<s/H;i++)car.step(inp,H);};
    run(1); car.dt.range='low'; car.dt.gear=1; inp.brake=0; inp.throttle=0.5; run(1.5); const vThr=car.speed()*3.6;
    inp.throttle=0; run(12); const v=car.speed()*3.6;
    console.log(id.padEnd(5), deg===0?'flat    ':'downhill', `with 50% throttle ${vThr.toFixed(1)} km/h -> 12 s after lifting: ${v.toFixed(2)} km/h, rpm ${car.dt.rpm.toFixed(0)}, clutch ${car.dt.engagement.toFixed(2)}`);
  }
}
