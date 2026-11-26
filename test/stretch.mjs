// Measure joint separation: axle/wheel positions in the chassis frame vs where the joints say they should be.
import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt, TRAILS, pathPoint } from '../src/terrain.js';
import { VEHICLES } from '../src/specs.js';
import { Vehicle, qrot } from '../src/vehicle.js';
await RAPIER.init();
const H=1/200, world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H; world.numSolverIterations=+(process.argv[3]||8);
const rocks=generateRocks(), terrain=buildTerrainPhysics(RAPIER, world, rocks, generateTrees());
const spec=VEHICLES.find(v=>v.id===(process.argv[2]||'ranger'));
const t=TRAILS[1]; const p0=pathPoint(t,4);
const car=new Vehicle(RAPIER, world, spec, terrain, {x:p0.x,y:heightAt(p0.x,p0.z)+spec.tire.radius-spec.axleY+0.5,z:p0.z}, Math.atan2(-p0.tx,-p0.tz));
const d=car.dt; d.range='low'; d.gear=1; d.lockR=true;
const inp={throttle:0.5,brake:0,steer:0};
const inv=q=>({x:-q.x,y:-q.y,z:-q.z,w:q.w});
let worst={ax:0,wh:0}; const t0=Date.now();
for(let i=0;i<4000;i++){ if(i===2500) {inp.throttle=0; inp.brake=1;} car.step(inp,H);
  if(i%10) continue;
  const cq=car.chassis.rotation(), cp=car.chassis.translation(), iq=inv(cq);
  for(let a=0;a<2;a++){ const ap=car.axles[a].body.translation(); const l=qrot(iq,{x:ap.x-cp.x,y:ap.y-cp.y,z:ap.z-cp.z});
    const e=Math.hypot(l.x, l.z-car.axles[a].localZ); worst.ax=Math.max(worst.ax,e); }
  for(let w=0;w<4;w++){ const wp=car.wheels[w].translation(), kp=car.knuckles[w].translation(); const e=Math.hypot(wp.x-kp.x,wp.y-kp.y,wp.z-kp.z); worst.wh=Math.max(worst.wh,e);
    const ap=car.axles[w>>1].body.translation(), aq=car.axles[w>>1].body.rotation(); const kl=qrot(inv(aq),{x:kp.x-ap.x,y:kp.y-ap.y,z:kp.z-ap.z}); worst.kn=Math.max(worst.kn||0, Math.hypot(Math.abs(kl.x)-spec.track/2, kl.y, kl.z)); }
}
console.log(spec.id, 'iters', world.numSolverIterations, 'max axle drift (cm)', (worst.ax*100).toFixed(1), 'knuckle-axle', ((worst.kn||0)*100).toFixed(1), 'wheel-knuckle', (worst.wh*100).toFixed(1), 'ms', Date.now()-t0);
