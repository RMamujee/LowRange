// The winch in 3D: recovery posts with a ring, the winch drum and fairlead on the bumper (procedural
// and glTF bodies alike: mounted on the view's chassis group at the spec's fairlead point), the line
// (taut = straight, slack = sagging curve, over the crest when it bends), the hook, a strap round a
// tree or rock, and while aiming a highlighted marker on the candidate anchor with a dashed preview.
// Plain MeshStandardMaterial, so the toon pass, outlines and display grade treat it like everything
// else; the thin line and the preview go on the no-outline layer (a 1-pixel feature would only pop).
import * as THREE from 'three';

const SEG = 28;                               // line segments
const COL = {
  post: 0x5e5446, band: 0xe6b23a, ring: 0x9a9da2, rope: 0xb0503a, hook: 0x33302c, drum: 0x24211e,
  strap: 0xd8b020, mark: 0xffb347, preview: 0xffe08a,
};
const std = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, ...opts });

export class WinchView {
  // posts: recovery points ({ x, z, ground, y }); noOutline(obj) from the pixel pipeline
  constructor(scene, { posts = [], noOutline = () => {} } = {}) {
    this.scene = scene; this.noOutline = noOutline;
    this.root = new THREE.Group(); this.root.name = 'winch';
    scene.add(this.root);
    this.buildPosts(posts);
    // the line: one instanced thin box per segment
    const segGeo = new THREE.BoxGeometry(0.035, 0.035, 1);
    this.rope = new THREE.InstancedMesh(segGeo, std(COL.rope), SEG);
    this.rope.frustumCulled = false; this.rope.count = 0;
    this.root.add(this.rope); noOutline(this.rope);
    this.preview = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 0.03, 1), new THREE.MeshBasicMaterial({ color: COL.preview, transparent: true, opacity: 0.85, depthWrite: false, fog: false }), SEG);
    this.preview.frustumCulled = false; this.preview.count = 0;
    this.root.add(this.preview); noOutline(this.preview);
    // hook at the anchor end
    this.hook = new THREE.Group();
    const hookMat = std(COL.hook);
    const shank = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.05), hookMat); shank.position.y = -0.07;
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.018, 4, 8, Math.PI * 1.4), hookMat); bow.position.y = -0.17; bow.rotation.z = Math.PI * 0.8;
    this.hook.add(shank, bow); this.hook.visible = false; this.root.add(this.hook);
    // strap round a trunk / rock (scaled per anchor)
    this.strap = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 4, 18), std(COL.strap));
    this.strap.rotation.x = Math.PI / 2; this.strap.visible = false; this.root.add(this.strap);
    // aiming marker: a bobbing chevron and a ground ring over the candidate
    this.mark = new THREE.Group();
    const mm = new THREE.MeshBasicMaterial({ color: COL.mark, fog: false });
    const chev = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.4, 4), mm); chev.rotation.x = Math.PI; chev.position.y = 0.2;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.04, 4, 20), new THREE.MeshBasicMaterial({ color: COL.mark, transparent: true, opacity: 0.8, depthWrite: false, fog: false }));
    ring.rotation.x = Math.PI / 2; ring.name = 'ring';
    this.mark.add(chev, ring); this.mark.visible = false; this.root.add(this.mark); noOutline(this.mark);
    this.markRing = ring; this.markChev = chev;
    this.mounted = null; // { view, group }
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this._s = new THREE.Vector3();
    this.pts = Array.from({ length: SEG + 1 }, () => new THREE.Vector3());
  }

  buildPosts(posts) {
    if (!posts.length) return;
    const n = posts.length;
    const postGeo = new THREE.CylinderGeometry(0.09, 0.1, 0.95, 6); postGeo.translate(0, 0.475, 0);
    const bandGeo = new THREE.CylinderGeometry(0.103, 0.103, 0.2, 6); bandGeo.translate(0, 0.42, 0);
    const capGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.07, 6); capGeo.translate(0, 0.97, 0);
    const ringGeo = new THREE.TorusGeometry(0.17, 0.03, 4, 12); ringGeo.rotateX(Math.PI / 2); // a collar ring the hook goes round
    const padGeo = new THREE.CylinderGeometry(0.28, 0.32, 0.08, 8); padGeo.translate(0, 0.02, 0); // concrete footing
    const mk = (geo, mat) => { const m = new THREE.InstancedMesh(geo, mat, n); m.castShadow = true; m.receiveShadow = true; return m; };
    const post = mk(postGeo, std(COL.post)), band = mk(bandGeo, std(COL.band)), cap = mk(capGeo, std(COL.post)), ring = mk(ringGeo, std(COL.ring)), pad = mk(padGeo, std(0xa29278));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    posts.forEach((P, i) => {
      const g = P.ground - 0.08; // sunk a little into the ground
      m.compose(p.set(P.x, g, P.z), q.identity(), one);
      post.setMatrixAt(i, m); band.setMatrixAt(i, m); cap.setMatrixAt(i, m); pad.setMatrixAt(i, m);
      // the collar ring at the anchor height, tipped a little as if the last hook pulled it
      e.set(0.25, (i * 1.7) % Math.PI, 0); q.setFromEuler(e);
      m.compose(p.set(P.x, P.y, P.z), q, one); ring.setMatrixAt(i, m);
    });
    const g = new THREE.Group(); g.name = 'recovery-posts';
    g.add(pad, post, band, cap, ring);
    this.root.add(g);
    this.posts = g;
  }

  // the drum and fairlead on the truck's bumper (re-mounted on every new VehicleView)
  mount(view, ws) {
    if (this.mounted?.view === view) return;
    this.mounted = { view, group: null };
    if (!view || !ws) return;
    const g = new THREE.Group(); g.name = 'winch-drum';
    const drumMat = std(COL.drum), steel = std(0x776c64);
    const big = ws.kind !== 'compact';
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(big ? 0.085 : 0.05, big ? 0.085 : 0.05, big ? 0.42 : 0.2, 8), drumMat);
    drum.rotation.z = Math.PI / 2; drum.position.set(0, 0.02, 0.09);
    const ends = new THREE.Mesh(new THREE.BoxGeometry(big ? 0.58 : 0.3, big ? 0.17 : 0.1, 0.12), steel); ends.position.set(0, 0.02, 0.1);
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(big ? 0.07 : 0.042, big ? 0.07 : 0.042, big ? 0.3 : 0.14, 8), std(COL.rope)); rope.rotation.z = Math.PI / 2; rope.position.set(0, 0.02, 0.09);
    const lead = new THREE.Mesh(new THREE.BoxGeometry(big ? 0.24 : 0.12, 0.09, 0.03), steel); lead.position.set(0, 0, 0.0);
    const hole = new THREE.Mesh(new THREE.BoxGeometry(big ? 0.12 : 0.06, 0.035, 0.035), drumMat); hole.position.set(0, 0, -0.012);
    g.add(drum, rope, ends, lead, hole);
    g.position.set(ws.fl.x, ws.fl.y, ws.fl.z);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    view.body.add(g);
    this.mounted.group = g;
  }

  // place n segment instances along this.pts[0..n]; dashed: every other one
  lay(mesh, n, dashed = false) {
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (dashed && i % 2) continue;
      const a = this.pts[i], b = this.pts[i + 1], L = a.distanceTo(b);
      if (L < 1e-4) continue;
      this._a.addVectors(a, b).multiplyScalar(0.5);
      this._q.setFromUnitVectors(this._s.set(0, 0, 1), this._b.subVectors(b, a).divideScalar(L));
      this._m.compose(this._a, this._q, this._b.set(1, 1, L));
      mesh.setMatrixAt(k++, this._m);
    }
    mesh.count = k; mesh.instanceMatrix.needsUpdate = true;
  }

  // a polyline F -> (P) -> A with the slack shared out as parabolic sag on each leg
  curve(F, P, A, slack) {
    const legs = P ? [[F, P], [P, A]] : [[F, A]];
    const total = legs.reduce((s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z), 0) || 1;
    let i = 0;
    legs.forEach(([a, b], li) => {
      const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const n = li === legs.length - 1 ? SEG - i : Math.max(2, Math.round((SEG * L) / total));
      const sag = slack > 0.005 ? Math.sqrt((3 * L * slack * (L / total)) / 8) : 0; // arc ~ chord + 8 sag^2 / (3 chord)
      for (let k = li === 0 ? 0 : 1; k <= n; k++) {
        const t = k / n;
        this.pts[i++].set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t - 4 * sag * t * (1 - t), a.z + (b.z - a.z) * t);
      }
    });
    return i - 1;
  }

  // per frame: ctl = WinchController, view = the truck's VehicleView
  update(ctl, view, t = 0) {
    const w = ctl.winch;
    this.mount(view, w?.ws);
    if (!w) { this.rope.count = 0; this.preview.count = 0; this.hook.visible = this.strap.visible = this.mark.visible = false; return; }
    const F = w.fairlead();
    // the line
    if (w.hooked) {
      const A = w.anchor, P = w.geo?.P ?? null;
      const d = P ? Math.hypot(P.x - F.x, P.y - F.y, P.z - F.z) + Math.hypot(A.x - P.x, A.y - P.y, A.z - P.z) : Math.hypot(A.x - F.x, A.y - F.y, A.z - F.z);
      const n = this.curve(F, P, A, Math.max(0, w.L - d));
      this.lay(this.rope, n);
      this.hook.visible = true; this.hook.position.set(A.x, A.y + 0.02, A.z);
      const a = A.anchor;
      if (a && a.kind !== 'post') {
        const r = a.kind === 'tree' ? a.r + 0.03 : Math.max(0.15, Math.hypot(A.x - a.x, A.z - a.z));
        this.strap.visible = true; this.strap.position.set(a.x, A.y, a.z); this.strap.scale.set(r, r, a.kind === 'tree' ? 1.4 : 1.8);
      } else this.strap.visible = false;
    } else { this.rope.count = 0; this.hook.visible = false; this.strap.visible = false; }
    // aiming: marker + dashed preview to the candidate
    const c = ctl.candidate();
    if (c) {
      const A = c.A, n = this.curve(F, c.geo.P, A, 0);
      this.lay(this.preview, n, true);
      this.mark.visible = true;
      this.mark.position.set(c.a.x, c.a.ground, c.a.z);
      this.markChev.position.y = (c.a.kind === 'tree' ? 2.2 : c.a.kind === 'rock' ? A.y - c.a.ground + 1.4 : 1.5) + Math.sin(t * 4) * 0.08;
      this.markRing.position.y = 0.06; const s = c.a.kind === 'post' ? 1 : Math.max(1, c.a.r * 1.6 + 0.4); this.markRing.scale.set(s, s, 1);
    } else { this.preview.count = 0; this.mark.visible = false; }
  }

  dispose() { this.scene.remove(this.root); }
}
