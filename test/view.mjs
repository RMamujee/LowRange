import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { VehicleView } from '../src/vehicle_view.js';
import { GROUP_WORLD } from '../src/terrain.js';
await RAPIER.init();
const world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=1/200;
const ground=world.createCollider(RAPIER.ColliderDesc.cuboid(200,1,200).setTranslation(0,-1,0).setCollisionGroups(GROUP_WORLD));
const scene=new THREE.Scene();
for (const spec of VEHICLES){ const t0=Date.now(); const car=new Vehicle(RAPIER, world, spec, {ground, rockHandles:new Set()}, {x:0,y:2,z:0},0); const v=new VehicleView(scene,car); console.log(spec.id,'build ms',Date.now()-t0); const t1=Date.now(); for(let i=0;i<20;i++){car.step({throttle:0,brake:0,steer:0},1/200); v.update({brake:0});} car.dents.push({p:{x:0,y:0.5,z:-2},n:{x:0,y:0,z:1},amount:0.1}); v.update({brake:0}); console.log('  update ms', Date.now()-t1, 'meshes', (()=>{let n=0; v.root.traverse(o=>{if(o.isMesh)n++;}); return n;})()); v.dispose(); car.destroy(); }
