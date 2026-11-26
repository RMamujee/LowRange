import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt } from '../src/terrain.js';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
await RAPIER.init();
const H=1/200, world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H;
const rocks=generateRocks(), terrain=buildTerrainPhysics(RAPIER, world, rocks, generateTrees(rocks));
const spec=VEHICLES[0];
const car=new Vehicle(RAPIER, world, spec, terrain, {x:0,y:heightAt(0,4)+spec.tire.radius-spec.axleY+0.3,z:4}, 0);
for (const c of car.wheelColliders){ c.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS); c.setContactForceEventThreshold(0); }
const q=new RAPIER.EventQueue(true);
const inp={throttle:0,brake:0,steer:0};
for(let i=0;i<300;i++){car.prePhysics(inp,H);world.step(q);car.postPhysics(inp,H); if(i===299) q.drainContactForceEvents(e=>{ const w=car.wheelColliders.map(c=>c.handle); console.log('wheelIsC1', w.includes(e.collider1()), 'wheelIsC2', w.includes(e.collider2()), 'totalForce', JSON.stringify(e.totalForce())); }); else q.drainContactForceEvents(()=>{});}
