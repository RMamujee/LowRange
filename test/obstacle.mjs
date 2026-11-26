import RAPIER from '@dimforge/rapier3d-compat';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H=1/200;
function setup(id, build){
  const world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H; world.numSolverIterations=8;
  const ground=world.createCollider(RAPIER.ColliderDesc.cuboid(200,1,200).setTranslation(0,-1,0).setFriction(1).setCollisionGroups(GROUP_WORLD));
  const rockHandles=new Set(); build(world, rockHandles);
  const spec=VEHICLES.find(v=>v.id===id);
  const car=new Vehicle(RAPIER, world, spec, {ground, rockHandles}, {x:0,y:spec.tire.radius-spec.axleY+0.05,z:0}, 0);
  car.airedDown=true;
  return {world, car, spec};
}
const box=(world,set,hx,hy,hz,x,y,z)=>{const c=world.createCollider(RAPIER.ColliderDesc.cuboid(hx,hy,hz).setTranslation(x,y,z).setFriction(1).setCollisionGroups(GROUP_WORLD)); set.add(c.handle); return c;};
function drive({world,car}, secs, input, cb){ let t=0; for(let i=0;i<Math.round(secs/H);i++){car.step(input,H);t+=H; if(cb&&i%100===0)cb(t);} }
const mode=process.argv[2]||'ledge';
for (const id of ['goat','taco','mule']){
  if (mode==='ledge'){
    const res=[];
    for (const k of [0.6,0.9,1.2,1.5]){
      let S; S=setup(id,(w,s)=>{ const R=VEHICLES.find(v=>v.id===id).tire.radius; const h=k*R; box(w,s,5,h/2,10,0,h/2,-6-10); });
      const d=S.car.dt; d.range='low'; d.gear=1; d.lockF=d.lockR=true;
      const inp={throttle:0.25,brake:0,steer:0,handbrake:false};
      drive(S,1,{throttle:0,brake:0,steer:0}); drive(S,25,inp);
      const p=S.car.chassis.translation();
      res.push(`${k}R:${p.z< -6-S.spec.wheelbase ? 'OK':'stuck z='+p.z.toFixed(1)}`);
    }
    console.log(id.padEnd(7),'ledge (lockers, L1, 25% thr):',res.join('  '));
  } else if (mode==='flex'){
    // ramp under front-left wheel: measure lift before other wheels leave ground
    const S=setup(id,(w,s)=>{});
    // static rising block under FL: lift it gradually by kinematic body
    const spec=S.spec; const kb=S.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(-spec.track/2,-0.5,-spec.wheelbase/2));
    S.world.createCollider(RAPIER.ColliderDesc.cuboid(0.4,0.5,0.4).setFriction(1).setCollisionGroups(GROUP_WORLD),kb);
    drive(S,1.5,{throttle:0,brake:1,steer:0});
    let lift=0, out='';
    for(let y=-0.5;y<1.5;y+=0.01){ kb.setNextKinematicTranslation({x:-spec.track/2,y,z:-spec.wheelbase/2}); drive(S,0.05,{throttle:0,brake:1,steer:0});
      const g=S.car.wheelState.map(w=>w.grounded?1:0); if(!g[1]||!g[2]||!g[3]){ lift=y+0.5; out=g.join(''); break;} }
    console.log(id.padEnd(7),'RTI: FL lifted',lift.toFixed(2),'m before another wheel left the ground',out, 'roll',(S.car.attitude().roll*57.3).toFixed(1));
  } else if (mode==='slope'){
    const res=[];
    for (const deg of [25,35,42,48]){
      const S=setup(id,(w,s)=>{ const a=deg/57.3; const c=w.createCollider(RAPIER.ColliderDesc.cuboid(6,0.5,30).setTranslation(0,Math.sin(a)*30-0.5*Math.cos(a)-0.02,-8-Math.cos(a)*30).setRotation({x:Math.sin(a/2),y:0,z:0,w:Math.cos(a/2)}).setFriction(1).setCollisionGroups(GROUP_WORLD)); s.add(c.handle);});
      const d=S.car.dt; d.range='low'; d.gear=1;
      drive(S,1,{throttle:0,brake:0,steer:0}); drive(S,18,{throttle:0.5,brake:0,steer:0});
      const p=S.car.chassis.translation(); res.push(`${deg}°:${p.y>8?'OK':'fail y='+p.y.toFixed(1)}${S.car.upsideDown()?'(flipped)':''}`);
    }
    console.log(id.padEnd(7),'rock slope climb:',res.join('  '));
  }
}
