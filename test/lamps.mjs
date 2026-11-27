// Rear lamps (src/art/lamps.js), headless. For each road rig, on the procedural body and on the
// glTF body (public/models/vehicles/<id>.glb):
//  - one or two reverse lenses exist, sit at the rear beside the tail lamps, mirrored left / right;
//  - reverse lamps are lit exactly when reverse is selected with the engine running (not in
//    neutral / a forward gear, not stalled, not seized, not in the garage preview: input null);
//  - brake lamps are lit when braking or with the parking brake / handbrake set, else tail level;
//  - after crash damage breaks the lamps (dents through the crash cage), neither shows;
//  - the mud coat keeps the reverse material shared, so the view still drives the lens glow.
//   node test/lamps.mjs
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { VEHICLES } from '../src/specs.js';
import { Vehicle } from '../src/vehicle.js';
import { VehicleView } from '../src/vehicle_view.js';
import { GROUP_WORLD } from '../src/terrain.js';
import { MudCoat } from '../src/fx/mud_coat.js';
import { loadAllVehicles } from './lib/glb.mjs';
await RAPIER.init();

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log('  FAIL', msg); } return ok; };
const RIGS = ['taco', 'lc70', 'wrx'];

function build(spec) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = 1 / 200;
  const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(50, 1, 50).setTranslation(0, -1, 0).setCollisionGroups(GROUP_WORLD));
  const car = new Vehicle(RAPIER, world, spec, { ground, rockHandles: new Set() }, { x: 0, y: spec.tire.radius - spec.axleY + 0.05, z: 0 }, 0);
  const view = new VehicleView(new THREE.Scene(), car);
  for (let i = 0; i < 40; i++) { car.step({ throttle: 0, brake: 0, steer: 0, handbrake: true }, 1 / 200); }
  return { car, view };
}

function run(kind) {
  for (const id of RIGS) {
    const spec = VEHICLES.find((s) => s.id === id);
    const { car, view } = build(spec);
    const L = view.lamps, d = car.dt;
    const [cw, , cl] = spec.chassis.size;
    const gl = view.assetWheel ? 'glTF' : 'procedural';
    check(gl === kind, `${id}: expected the ${kind} body, got ${gl}`);
    // --- placement
    const lenses = L.lenses;
    const pos = lenses.map((m) => m.position);
    console.log(`${id} ${kind}: ${lenses.length} reverse lens(es) at ${pos.map((p) => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`).join(' ')}, size ${lenses.map((m) => `${m.userData.size[0].toFixed(2)}x${m.userData.size[1].toFixed(2)}`).join(' ')}`);
    check(lenses.length >= 1 && lenses.length <= 2, `${id} ${kind}: ${lenses.length} reverse lenses (want 1 or 2)`);
    for (const p of pos) {
      check(p.z > cl * 0.35, `${id} ${kind}: lens at z ${p.z.toFixed(2)} is not at the rear (length ${cl})`);
      check(Math.abs(p.x) < cw / 2 + 0.1, `${id} ${kind}: lens at x ${p.x.toFixed(2)} outside the body`);
    }
    if (lenses.length === 2) {
      const [a, b] = pos;
      check(Math.abs(a.x + b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.z - b.z) < 0.01, `${id} ${kind}: lenses not mirrored left / right (${a.x.toFixed(3)} vs ${b.x.toFixed(3)}, y ${a.y.toFixed(3)} / ${b.y.toFixed(3)}, z ${a.z.toFixed(3)} / ${b.z.toFixed(3)})`);
      check(Math.sign(a.x) !== Math.sign(b.x), `${id} ${kind}: both lenses on one side`);
    }
    // the lens sits just proud of the body: a ray from just in front of the lens face, going into the
    // truck, meets the body within 3 cm (it is not floating off the surface)
    const targets = [];
    view.body.traverse((o) => { if (o.isMesh && o.visible && !lenses.includes(o)) { let vis = true; for (let p = o; p && p !== view.body; p = p.parent) if (!p.visible) vis = false; if (vis) targets.push(o); } });
    view.body.updateMatrixWorld(true);
    for (const m of lenses) {
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(m.quaternion);
      const o = m.position.clone().applyMatrix4(view.body.matrixWorld);
      const hit = new THREE.Raycaster(o, n.clone().negate().transformDirection(view.body.matrixWorld), 0, 0.2).intersectObjects(targets, false)[0];
      check(hit && hit.distance < 0.03, `${id} ${kind}: lens ${m.userData.side} not on the body surface (${hit ? hit.distance.toFixed(3) + ' m' : 'no surface'} behind it)`);
      // and nothing of the body covers it from behind the truck
      const back = o.clone().addScaledVector(n.clone().transformDirection(view.body.matrixWorld), 1.5);
      const cover = new THREE.Raycaster(back, n.clone().negate().transformDirection(view.body.matrixWorld), 0, 1.5).intersectObjects([...targets, m], false)[0];
      check(cover && cover.object === m, `${id} ${kind}: lens ${m.userData.side} hidden behind ${cover ? cover.object.name || cover.object.material.name : '?'}`);
    }
    // --- reverse logic
    const st = (input) => { view.update(input); return L.state(); };
    d.running = true; d.dead = false;
    const drive = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    d.gear = -1; check(st(drive).reverse === true, `${id} ${kind}: reverse selected, engine running: lamps off`);
    check(L.state().pool > 0, `${id} ${kind}: reverse on but no light pool`);
    check(L.mat.emissiveIntensity > 1, `${id} ${kind}: reverse on but the lens is not glowing`);
    d.gear = 0; check(st(drive).reverse === false, `${id} ${kind}: neutral: reverse lamps on`);
    d.gear = 1; check(st(drive).reverse === false, `${id} ${kind}: 1st: reverse lamps on`);
    check(L.state().pool === 0 && L.mat.emissiveIntensity === 0, `${id} ${kind}: 1st: lens / pool still lit`);
    d.gear = -1; d.running = false; check(st(drive).reverse === false, `${id} ${kind}: reverse, engine stalled: lamps on`);
    d.running = true; d.dead = true; check(st(drive).reverse === false, `${id} ${kind}: reverse, engine seized: lamps on`);
    d.dead = false; check(st(null).reverse === false, `${id} ${kind}: garage preview (no input): reverse lamps on`);
    // --- brake logic
    const tailK = () => (view.tailMats.length ? view.tailMats[0] : view.body.userData.lights.tail).emissiveIntensity;
    d.gear = 1;
    check(st({ ...drive, brake: 0.6 }).brake === true && tailK() > 1, `${id} ${kind}: braking: brake lamps off`);
    check(st({ ...drive, handbrake: true }).brake === true && tailK() > 1, `${id} ${kind}: parking brake / handbrake set: brake lamps off`);
    check(st(drive).brake === false && tailK() < 0.5, `${id} ${kind}: no brake: brake lamps lit`);
    check(st(null).brake === false && tailK() < 0.5, `${id} ${kind}: garage preview: brake lamps lit`);
    // --- mud coat keeps the reverse lens material shared (the view drives its glow)
    const mud = new MudCoat(); mud.adopt(view);
    check(lenses.every((m) => (Array.isArray(m.material) ? m.material[0] : m.material) === L.mat), `${id} ${kind}: mud coat replaced the reverse lens material`);
    for (const m of mud.own) m.dispose();
    // --- crash damage: dent every tail / reverse pane through the crash cage
    const before = L.state();
    check(before.reverseLenses === lenses.length && before.tailPanes > 0, `${id} ${kind}: lamps not tracked by the damage view (${JSON.stringify(before)})`);
    const lamp = (m) => m === L.mat || (m && m.name === 'TailLight');
    for (const r of view.damage.meshes) {
      if (!r.panes || !lamp(Array.isArray(r.mesh.material) ? r.mesh.material[0] : r.mesh.material)) continue;
      for (const p of r.panes) {
        let x = 0, y = 0, z = 0;
        for (let i = p.start; i < p.start + p.count; i++) { x += r.bodyPos[i * 3]; y += r.bodyPos[i * 3 + 1]; z += r.bodyPos[i * 3 + 2]; }
        x /= p.count; y /= p.count; z /= p.count;
        const n = new THREE.Vector3(-x, -y * 0.3, -z).normalize();
        car.crash.lattice.intrude({ x, y, z }, n, 0.3, 0.08, 0.2);
      }
    }
    d.gear = -1; d.running = true;
    const after = st({ ...drive, brake: 0.8 });
    console.log(`  intact: ${JSON.stringify(before)}\n  dented: ${JSON.stringify(after)}`);
    check(after.reverse === false && after.reverseLit === 0 && after.pool === 0, `${id} ${kind}: reverse lamps still lit after they broke`);
    check(after.brake === false && after.brakeLit === 0, `${id} ${kind}: brake lamps still lit after they broke`);
    // repair: back on
    car.repair(); view.repairDamage();
    d.gear = -1; d.running = true; d.dead = false;
    check(st({ ...drive, brake: 0.8 }).reverse === true && L.state().brake === true, `${id} ${kind}: lamps not back after a repair`);
    view.dispose(); car.destroy();
  }
}

run('procedural');
await loadAllVehicles(RIGS);
run('glTF');
console.log(fails ? `lamps: ${fails} FAILED` : 'lamps: all passed');
process.exit(fails ? 1 : 0);
