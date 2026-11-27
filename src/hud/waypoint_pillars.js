// 3D waypoint markers: a wooden pole with a pixel pennant (numbered) and, for the active waypoint,
// a tall soft light column so it can be found from across the map.
import * as THREE from 'three';
import { P, mk, rect, tiny } from './px.js';

function flagTexture(n, active) {
  const f = mk(16, 10), g = f.g;
  rect(g, 0, 0, 16, 10, P.ol);
  rect(g, 1, 1, 14, 8, active ? P.red : P.paint);
  rect(g, 1, 1, 14, 1, active ? P.redHi : P.cream);
  rect(g, 1, 8, 14, 1, active ? P.redDark : P.paintShade);
  tiny(g, String(n), 8, 3, active ? P.cream : P.ink, { align: 'center' });
  const t = new THREE.CanvasTexture(f.cv);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Beacons {
  constructor(scene, heightAt, noOutline) {
    this.root = new THREE.Group(); this.root.name = 'waypoints';
    scene.add(this.root);
    this.heightAt = heightAt; this.noOutline = noOutline; this.items = []; this.key = '';
    this.poleGeo = new THREE.BoxGeometry(0.14, 3.4, 0.14);
    this.flagGeo = new THREE.BoxGeometry(1.4, 0.88, 0.05);
    this.pillarGeo = new THREE.CylinderGeometry(0.32, 0.32, 60, 8, 1, true);
    this.poleMat = new THREE.MeshStandardMaterial({ color: 0xa5683a, roughness: 1, metalness: 0 });
    this.pillarMat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, fog: false });
  }
  sync(list) {
    const key = JSON.stringify(list);
    if (key === this.key) return;
    this.key = key;
    for (const it of this.items) { this.root.remove(it.g); it.flagMat.map.dispose(); it.flagMat.dispose(); }
    this.items = list.map((w, i) => {
      const g = new THREE.Group();
      g.position.set(w.x, this.heightAt(w.x, w.z), w.z);
      const pole = new THREE.Mesh(this.poleGeo, this.poleMat); pole.position.y = 1.7; g.add(pole);
      const flagMat = new THREE.MeshStandardMaterial({ map: flagTexture(i + 1, i === 0), roughness: 1, metalness: 0 });
      const flag = new THREE.Mesh(this.flagGeo, flagMat); flag.position.set(0.72, 2.9, 0); g.add(flag);
      if (i === 0) { const pillar = new THREE.Mesh(this.pillarGeo, this.pillarMat); pillar.position.y = 30; this.noOutline?.(pillar); g.add(pillar); }
      this.root.add(g);
      return { g, flag, flagMat };
    });
  }
  update(t) {
    this.items.forEach((it, i) => { it.g.rotation.y = Math.sin(t * 0.8 + i) * 0.5; it.flag.position.y = 2.9 + Math.sin(t * 2 + i) * 0.04; });
    this.pillarMat.opacity = 0.26 + Math.sin(t * 2.4) * 0.08;
  }
}
