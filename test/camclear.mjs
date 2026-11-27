// Camera vs. scenery (src/cam_clear.js): the Chase camera is pulled in short of tree canopies,
// sign boards and hills, and the Spotter never stands inside a tree (playtest: Spotter cam inside a
// tree after a crash, Chase cam through a trail sign). Fast (no driving): node test/camclear.mjs
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { generateRocks, generateTrees, buildTerrainPhysics, visualHeightAt } from '../src/terrain.js';
import { CamClear } from '../src/cam_clear.js';
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const rocks = generateRocks(), trees = generateTrees(rocks);
buildTerrainPhysics(RAPIER, world, rocks, trees);
world.step();

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const G = (x, z) => visualHeightAt(x, z);

// a big tree with open ground around it (no other tree within 8 m, no rock within 6 m), on gentle ground
const tree = trees.filter((t) => t.s > 1.2).find((t) => trees.every((u) => u === t || Math.hypot(u.x - t.x, u.z - t.z) > 8)
  && Math.abs(G(t.x + 8, t.z) - G(t.x - 8, t.z)) < 1.5 && Math.abs(G(t.x, t.z + 8) - G(t.x, t.z - 8)) < 1.5
  && rocks.every((r) => Math.hypot(r.x - t.x, r.z - t.z) > 6));
// a sign board on open ground away from everything, turned 40 degrees (a thin oriented box)
const open = (x, z) => trees.every((u) => Math.hypot(u.x - x, u.z - z) > 15) && rocks.every((r) => Math.hypot(r.x - x, r.z - z) > 15) && Math.abs(G(x + 10, z) - G(x - 10, z)) < 1.2 && Math.abs(G(x, z + 10) - G(x, z - 10)) < 1.2;
let sx = 0, sz = 0;
for (let k = 0; k < 4000 && !open(sx, sz); k++) { sx = ((k * 37) % 300) - 150; sz = ((k * 91) % 300) - 150; }
const scene = new THREE.Scene();
const sign = new THREE.Group(); sign.userData.camBlock = true;
const board = new THREE.Mesh(new THREE.BoxGeometry(3, 1.2, 0.1)); board.position.y = 2.2; sign.add(board);
sign.position.set(sx, G(sx, sz), sz); sign.rotation.y = 0.7; scene.add(sign);
const cc = new CamClear({ RAPIER, world, trees, scene, groundAt: visualHeightAt });
console.log(`tree at ${tree.x.toFixed(1)},${tree.z.toFixed(1)} s ${tree.s.toFixed(2)}; sign at ${sx},${sz}`);

// one Chase frame from scratch (dt 0 = a teleport: no smoothing): where the camera may sit on the line
const pull = (target, want) => { cc.S = null; return cc.chase(target, want.clone(), want, 0); };

// canopy
const cy = tree.y + 3.6 * tree.s;
check(cc.blocked(tree.x + 1, cy, tree.z), 'a point in the canopy is blocked');
check(!cc.blocked(tree.x + 1, tree.y + 0.8, tree.z), 'under the canopy, beside the trunk, is clear');
// Chase: truck 7 m one side of the tree, camera wanted 7 m the other side at canopy height
{
  const target = V(tree.x - 7, cy, tree.z), want = V(tree.x + 7, cy, tree.z);
  const got = pull(target, want);
  check(got.x < tree.x - 2.3 * tree.s + 0.1 && got.distanceTo(target) >= 2.2 - 1e-6, `chase pulled in short of the canopy (x ${(got.x - tree.x).toFixed(2)} m from the trunk)`);
  check(!cc.blocked(got.x, got.y, got.z), 'pulled-in chase camera is not in the tree');
}
// sign: the line through the board is cut short; a point inside its axis-aligned box but off the
// thin board itself stays clear (the box is oriented, not the board's world AABB)
{
  const n = V(Math.sin(0.7), 0, Math.cos(0.7)), y = G(sx, sz) + 2.2;
  const target = V(sx, y, sz).addScaledVector(n, 5), want = V(sx, y, sz).addScaledVector(n, -6);
  const got = pull(target, want);
  check(got.distanceTo(target) < 5 - 0.2, `chase stops in front of the sign board (${got.distanceTo(target).toFixed(2)} of 5 m)`);
  check(cc.blocked(sx, y, sz), 'the board itself is blocked');
  const t = V(Math.cos(0.7), 0, -Math.sin(0.7)); // along the board
  check(!cc.blocked(sx + n.x * 1.0 + t.x * 1.0, y, sz + n.z * 1.0 + t.z * 1.0), 'beside the turned board (inside its world AABB) is clear');
}
// open ground: nothing to dodge, the wanted position is kept
{
  const target = V(sx + 30, G(sx + 30, sz) + 1.5, sz), want = V(sx + 30, G(sx + 30, sz) + 4, sz + 8);
  const ok = open(sx + 30, sz) ? pull(target, want).distanceTo(want) < 1e-6 : true;
  check(ok, 'in the open the chase camera is left alone');
}
// a hill between the truck and the camera: the sight line under the ground gets cut
{
  const target = V(sx, G(sx, sz) + 1, sz), want = V(sx + 6, G(sx + 6, sz) - 3, sz);
  const got = pull(target, want);
  check(got.y > G(got.x, got.z), 'chase camera never ends up under the ground');
}
// Spotter: the old rule (9 m ahead, 3 m to the side) puts the stand right in the tree's canopy;
// spot() picks another stand that is clear and sees the truck
{
  const fwd = V(1, 0, 0), side = V(fwd.z, 0, -fwd.x);
  const p = V(tree.x - 9, 0, tree.z - 3 * side.z); p.y = G(p.x, p.z) + 1;
  const old = V(p.x, 0, p.z).addScaledVector(fwd, 9).addScaledVector(side, 3); old.y = G(old.x, old.z) + 1.7;
  const target = V(p.x, p.y + 0.9, p.z);
  check(Math.hypot(old.x - tree.x, old.z - tree.z) < 0.01 && cc.blocked(old.x, old.y, old.z), 'repro: the old Spotter stand is inside the tree');
  const s = cc.spot(p, fwd, side, 1.7, target);
  check(!cc.blocked(s.x, s.y, s.z) && cc.clearDist(target, s) >= s.distanceTo(target) - 0.05, `spot() stand is clear and sees the truck (${s.distanceTo(target).toFixed(1)} m away)`);
}

// Driving past the tree, frame by frame (60 fps, 5 m/s, main.js's chase maths: lerp towards the
// wanted spot 9 m back, then chase()). The truck passes 1.2 m beside the trunk, so it drives under
// the canopy and the tree then sits on the camera's line behind it.
{
  const dt = 1 / 60, pitch = 0.32, D = 9, damp = 1 - Math.exp(-7 * dt);
  const cam = V(), want = V(), target = V();
  const dtree = tree, lat = dtree.z + 1.2;
  const series = [];
  cc.S = null;
  // drive from 8 m before the trunk to 16 m past it, then stand there for 6 s
  for (let i = 0, k = 0; k < 6 / dt; i++) {
    const x = Math.min(dtree.x - 8 + 5 * dt * i, dtree.x + 16);
    if (x === dtree.x + 16) k++;
    target.set(x, G(x, lat) + 1.6, lat);
    want.set(x - Math.cos(pitch) * D, target.y + Math.sin(pitch) * D, lat);
    want.y = Math.max(want.y, G(want.x, want.z) + 0.6);
    if (i === 0) cam.copy(want); else cam.lerp(want, damp);
    cc.chase(target, cam, want, i === 0 ? 0 : dt);
    series.push({ x: x - dtree.x, d: cam.distanceTo(target), h: cc.hit(cam.x, cam.y, cam.z) });
  }
  const steady = series[0].d;
  const under = series.filter((s) => Math.abs(s.x) < 1.5);
  check(under.length > 0 && under.every((s) => Math.abs(s.d - steady) < 0.3), `under the canopy the camera keeps its normal distance (${Math.min(...under.map((s) => s.d)).toFixed(2)}-${Math.max(...under.map((s) => s.d)).toFixed(2)} m, normal ${steady.toFixed(2)})`);
  const behind = series.filter((s) => s.x >= 1.5);
  const inside = behind.filter((s) => s.h !== 0);
  check(!inside.length, `with the tree behind, the camera is never inside it${inside.length ? ` (${inside.length} frames, first at ${inside[0].x.toFixed(2)} m past the trunk, ${inside[0].d.toFixed(2)} m back)` : ''}`);
  // one pull-in, then a slow release: no increase before the minimum, no decrease after it
  const ds = series.map((s) => s.d), iMin = ds.indexOf(Math.min(...ds));
  let ups = 0, downs = 0, fastest = 0;
  for (let i = 1; i < ds.length; i++) {
    const dd = ds[i] - ds[i - 1];
    if (i <= iMin && dd > 1e-4) ups++;
    if (i > iMin && dd < -1e-4) downs++;
    if (i > iMin) fastest = Math.max(fastest, dd / dt);
  }
  check(ds[iMin] < steady - 2, `the tree behind pulls the camera in (to ${ds[iMin].toFixed(2)} m)`);
  check(ups === 0 && downs === 0, `monotonic pull-in then release, no oscillation (${ups} rises before the minimum, ${downs} drops after it)`);
  check(fastest <= 1.5 * 1.05 + 1e-6, `release is slow (fastest ${fastest.toFixed(2)} m/s, limit 1.5)`);
  check(Math.abs(ds[ds.length - 1] - steady) < 0.3, `back to the normal distance once the tree is far behind (${ds[ds.length - 1].toFixed(2)} m)`);
}

console.log(fails ? `${fails} FAILURES` : 'camclear: all checks passed');
process.exit(fails ? 1 : 0);
