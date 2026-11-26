import RAPIER from '@dimforge/rapier3d-compat';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const H=1/200;
const fmt=c=>`tyre ${c.health.tire.map(x=>x.toFixed(2)).join('/')} susp ${c.health.susp.map(x=>x.toFixed(2)).join('/')} eng ${c.health.engine.toFixed(2)} body ${c.health.body.toFixed(2)} broken ${c.broken.filter(Boolean).length} dents ${c.dents.length}`;
for (const spec of VEHICLES){
  const out=[];
  for (const drop of [1,2.5,5]){
    const world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H;
    const ground=world.createCollider(RAPIER.ColliderDesc.cuboid(200,1,200).setTranslation(0,-1,0).setCollisionGroups(GROUP_WORLD));
    const car=new Vehicle(RAPIER, world, spec, {ground, rockHandles:new Set()}, {x:0,y:spec.tire.radius-spec.axleY+0.05+drop,z:0}, 0); car.grace=0;
    for(let i=0;i<600;i++) car.step({throttle:0,brake:0,steer:0},H);
    out.push(`drop ${drop}m: ${fmt(car)}`);
  }
  for (const kmh of [10,30]){
    const world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H;
    const ground=world.createCollider(RAPIER.ColliderDesc.cuboid(200,1,200).setTranslation(0,-1,0).setCollisionGroups(GROUP_WORLD));
    const wall=world.createCollider(RAPIER.ColliderDesc.cuboid(10,2,0.5).setTranslation(0,2,-12).setCollisionGroups(GROUP_WORLD));
    const car=new Vehicle(RAPIER, world, spec, {ground, rockHandles:new Set()}, {x:0,y:spec.tire.radius-spec.axleY+0.05,z:0}, 0);
    for(let i=0;i<200;i++) car.step({throttle:0,brake:0,steer:0},H);
    const v=kmh/3.6; for (const b of car.allBodies) { const l=b.linvel(); b.setLinvel({x:0,y:l.y,z:-v},true); }
    for(let i=0;i<600;i++) car.step({throttle:0,brake:0,steer:0},H);
    out.push(`wall ${kmh}km/h: ${fmt(car)}`);
  }
  console.log(spec.id+'\n  '+out.join('\n  '));
}
