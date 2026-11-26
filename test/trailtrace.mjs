// Trace one vehicle on one trail: node test/trailtrace.mjs <id> <secs> _ <trailIndex> [s0] [s1]
import RAPIER from '@dimforge/rapier3d-compat';
import { generateRocks, generateTrees, buildTerrainPhysics, heightAt, TRAILS, pathPoint } from '../src/terrain.js';
import { ALL_VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
await RAPIER.init();
const H=1/200;
const world=new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=H; world.numSolverIterations=8;
const rocks=generateRocks();
for (const r of rocks){ let m=0; for(let i=0;i<r.pts.length;i+=3) m=Math.max(m,Math.hypot(r.pts[i],r.pts[i+2])); r.rad=m; let ym=-1e9; for(let i=1;i<r.pts.length;i+=3) ym=Math.max(ym,r.pts[i]); r.top=r.y+ym; }
function pickLine(t,s,spec){ // lateral offset with most clearance from boulders over the next 8 m
  const hw=t.width/2; let bestO=0,bestC=-1e9;
  for(let o=-hw+0.6;o<=hw-0.6;o+=0.25){ let c=1e9;
    for(let q=s;q<s+8;q+=1){ const p=pathPoint(t,q); const x=p.x-p.tz*o, z=p.z+p.tx*o;
      for(const r of rocks){ if(r.ledge) continue; const d=Math.hypot(r.x-x,r.z-z)-r.rad-spec.track/2; if(d<c) c=d; } }
    c = Math.min(c, 2.5) - Math.abs(o)*0.05; if(c>bestC){bestC=c;bestO=o;} } // past 2.5 m of room, stay central
  return bestO; }
const terrain=buildTerrainPhysics(RAPIER, world, rocks, generateTrees());
const ids=[process.argv[2]]; const TI=+process.argv[5]; const T0=+(process.argv[6]||0), T1=+(process.argv[7]||1e9);
const secs=+(process.argv[3]||120);
for (const id of ids) {
  const spec=ALL_VEHICLES.find(v=>v.id===id); const res=[];
  for (const t of [TRAILS[TI]]) {
    const p0=pathPoint(t,4);
    const car=new Vehicle(RAPIER, world, spec, terrain, {x:p0.x,y:heightAt(p0.x,p0.z)+spec.tire.radius-spec.axleY+0.5,z:p0.z}, Math.atan2(-p0.tx,-p0.tz));
    car.airedDown=true; const d=car.dt; d.range=spec.ranges.low?'low':'high'; d.gear=1; d.lockF=spec.lockers.front; d.lockR=true;
    const inp={throttle:0,brake:0,steer:0}; let s=4, stuckT=0, best=4, flips=0;
    for (let i=0;i<secs/H;i++){
      if (i%20===0){
        const p=car.chassis.translation();
        // nearest s
        let bs=s, bd=1e9; for (let q=Math.max(0,s-10); q<Math.min(t.length,s+20); q+=0.5){ const pp=pathPoint(t,q); const dd=Math.hypot(pp.x-p.x,pp.z-p.z); if(dd<bd){bd=dd;bs=q;} }
        s=bs; best=Math.max(best,s);
        if (i%100===0) car._line=pickLine(t,s+2,spec);
        const lk=pathPoint(t,Math.min(t.length,s+4+spec.wheelbase)); const o=car._line||0; const look={x:lk.x-lk.tz*o,z:lk.z+lk.tx*o};
        const {heading}=car.attitude(); const want=Math.atan2(-(look.x-p.x),-(look.z-p.z));
        let err=want-heading; err=Math.atan2(Math.sin(err),Math.cos(err));
        inp.steer=Math.max(-1,Math.min(1,err*2.2));
        const v=car.speed();
        inp.throttle = v<0.3 ? Math.min(1.0, inp.throttle+0.02) : v<0.6 ? Math.min(0.6, inp.throttle+0.02) : v>1.6 ? Math.max(0.05, inp.throttle-0.05) : inp.throttle;
        if (car.upsideDown()) { flips++; const pp=pathPoint(t,s); car.reset({x:pp.x,y:heightAt(pp.x,pp.z)+2,z:pp.z},Math.atan2(-pp.tx,-pp.tz)); }
        if (s>=t.length-6) break; if (i%100===0 && s>=T0 && s<=T1){ const pp=pathPoint(t,s); const lat=(p.x-pp.x)*-pp.tz+(p.z-pp.z)*pp.tx; const at=car.attitude(); console.log(`t=${(i*H).toFixed(1)} s=${s.toFixed(1)} lat=${lat.toFixed(2)} line=${(car._line||0).toFixed(2)} pitch=${(at.pitch*57.3).toFixed(0)} roll=${(at.roll*57.3).toFixed(0)} v=${v.toFixed(2)} rpm=${car.dt.rpm.toFixed(0)} w=${car.wheelState.map(w=>(w.grounded?"g":"-")+(w.load/1000).toFixed(1)).join(",")}`); }
      }
      car.step(inp,H);
    }
    { const p=car.chassis.translation(), a=car.attitude(); console.log(`  stuck@${t.name} s=${best.toFixed(1)} pitch=${(a.pitch*57.3).toFixed(0)} roll=${(a.roll*57.3).toFixed(0)} rpm=${car.dt.rpm.toFixed(0)} v=${car.speed().toFixed(2)} thr=${inp.throttle.toFixed(2)} steer=${inp.steer.toFixed(2)} wheels=${car.wheelState.map(w=>(w.grounded?"g":"-")+w.mat+" slip"+w.slip.toFixed(1)+" N"+(w.load/1000).toFixed(1)).join(", ")} `); for(const pt of car.patches) console.log("    patch w"+pt.wheel, "mat",pt.mat,"n",[pt.n.x,pt.n.y,pt.n.z].map(x=>x.toFixed(2)).join(","),"N",(pt.N/1000).toFixed(1),"k",pt.k.toFixed(2),"cap/h",(pt.cap/H/1000).toFixed(1),"impL/h",(pt.imp/H/1000).toFixed(1),"d",[pt.d.x,pt.d.y,pt.d.z].map(x=>x.toFixed(2)).join(",")); const parts=[["chassis",car.chassis],["frontAxle",car.axles[0].body],["rearAxle",car.axles[1].body]]; for(const [nm,b] of parts.filter(p=>p[1])){ for(let k=0;k<b.numColliders();k++){ const col=b.collider(k); world.contactPairsWith(col,o=>world.contactPair(col,o,(m)=>{ let n=0; for(let q=0;q<m.numContacts();q++) if(m.contactDist(q)<0.02) n++; if(n) console.log("    contact:",nm,"collider",k,"with",terrain.rockHandles.has(o.handle)?"ROCK":o.handle===terrain.ground.handle?"GROUND":"other", n,"pts"); })); } } }
    res.push(`${t.name.split(' ')[0]}(${t.diff}) ${best.toFixed(0)}/${t.length.toFixed(0)}m${flips?' flips:'+flips:''}`);
    car.destroy();
  }
  console.log(id.padEnd(7), res.join(' | '));
}
