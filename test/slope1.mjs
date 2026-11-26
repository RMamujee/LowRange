import RAPIER from '@dimforge/rapier3d-compat';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H=1/200, id=process.argv[2]||'lc70', deg=+(process.argv[3]||25);
const world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H; world.numSolverIterations=8;
const ground=world.createCollider(RAPIER.ColliderDesc.cuboid(200,1,200).setTranslation(0,-1,0).setFriction(1).setCollisionGroups(GROUP_WORLD));
const rockHandles=new Set(); const a=deg/57.3;
if (deg>0){ const c=world.createCollider(RAPIER.ColliderDesc.cuboid(6,0.5,30).setTranslation(0,Math.sin(a)*30-0.5*Math.cos(a)-0.02,-8-Math.cos(a)*30).setRotation({x:Math.sin(a/2),y:0,z:0,w:Math.cos(a/2)}).setFriction(1).setCollisionGroups(GROUP_WORLD)); rockHandles.add(c.handle);}
const spec=ALL_VEHICLES.find(v=>v.id===id);
const car=new Vehicle(RAPIER, world, spec, {ground, rockHandles}, {x:0,y:spec.tire.radius-spec.axleY+0.05,z:0}, 0);
const d=car.dt; let t=0;
const inp={throttle:0,brake:0,steer:0}; const step=()=>{car.step(inp,H);t+=H;};
for(let i=0;i<200;i++)step(); d.range='low'; d.gear=1; inp.throttle=+(process.argv[4]||0.5);
for(let k=0;k<20;k++){ for(let i=0;i<100;i++)step(); const p=car.chassis.translation(), at=car.attitude();
 const wv=car.wheels.map(w=>{const l=w.linvel(); return Math.hypot(l.x,l.y,l.z)*3.6;});
 console.log(`t=${t.toFixed(1)} y=${p.y.toFixed(2)} z=${p.z.toFixed(1)} v=${(car.speed()*3.6).toFixed(1)} rpm=${d.rpm.toFixed(0)} eng=${d.engagement.toFixed(2)} slip=${d.clutchSlip} pitch=${(at.pitch*57.3).toFixed(0)} spin=${car.wheelState.map(w=>(w.spin*spec.tire.radius*3.6).toFixed(1)).join(',')} wheelv=${wv.map(x=>x.toFixed(1)).join(',')} T=${d.wheelTorque.map(x=>x.toFixed(0)).join(',')} np=${(car.patches||[]).length} ny=${(car.patches||[]).map(p=>p.n.y.toFixed(2)).join(",")} N=${(car.patches||[]).map(p=>(p.N/1000).toFixed(1)).join(",")}`);}
