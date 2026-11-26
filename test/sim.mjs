import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt } from '../src/terrain.js';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
await RAPIER.init();
const H = 1/200;
const id = process.argv[2] || 'lc70';
const scen = process.argv[3] || 'flat';
const world = new RAPIER.World({x:0,y:-9.81,z:0});
world.timestep = H; world.numSolverIterations = 8;
let t0=Date.now();
const rocks = generateRocks(), trees = generateTrees(rocks);
const terrain = buildTerrainPhysics(RAPIER, world, rocks, trees);
console.log('terrain built', Date.now()-t0,'ms rocks',rocks.length,'trees',trees.length);
const spec = ALL_VEHICLES.find(v=>v.id===id);
let sx=0, sz=0, yaw=0;
if (scen==='garden'){ sx=40; sz=-34; yaw=-Math.PI/2; } // drive +x into garden: forward is -Z rotated
const y0 = heightAt(sx,sz) + spec.tire.radius - spec.axleY + 0.3;
const car = new Vehicle(RAPIER, world, spec, terrain, {x:sx,y:y0,z:sz}, yaw);
const input = {throttle:0, brake:0, steer:0, handbrake:false};
const dt = car.dt;
let tt=0;
function run(sec, f){ const n=Math.round(sec/H); for(let i=0;i<n;i++){ f&&f(tt); car.step(input,H); tt+=H; } }
function report(tag){ const p=car.chassis.translation(); const a=car.attitude();
  console.log(tag.padEnd(14), `t=${tt.toFixed(1)} pos=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) v=${(car.speed()*3.6).toFixed(1)}km/h rpm=${dt.rpm.toFixed(0)} gear=${dt.gearLabel}${dt.range[0]} run=${dt.running} slip=${dt.clutchSlip} comp=${car.compression().map(c=>c.toFixed(2)).join(',')} pitch=${(a.pitch*57.3).toFixed(1)} roll=${(a.roll*57.3).toFixed(1)} mats=${car.wheelState.map(w=>w.mat+(w.grounded?'g':'-')).join('')}`); }
t0=Date.now();
run(2); report('settled');
const wp = car.wheels.map(w=>w.translation()); 
if (scen==='flat'){
  dt.range='low'; dt.gear=1; input.throttle=0;
  run(4); report('idle crawl L1');
  input.throttle=0.6; run(4); report('L1 60%');
  dt.range='high'; dt.gear=2; input.throttle=1; run(5); report('H2 100%');
  dt.gear=3; run(4); report('H3 100%');
  input.throttle=0; input.brake=1; run(4); report('braking');
  input.brake=0; dt.autoClutch=false; dt.gear=1; dt.range='high'; run(3); report('noAC stall?');
} else {
  dt.range='low'; dt.gear=1; dt.lockF=dt.lockR=true; input.throttle=0.45;
  for (let k=0;k<8;k++){ run(3); report('garden '+k); }
}
console.log('sim ms', Date.now()-t0);
