// Preload for the autopilot tests: node --import ./test/lib/damage_watch.mjs test/trails.mjs ...
// Watches every Vehicle the test builds and prints, at exit, the worst damage each rig took in
// that vehicle's lifetime (body health, suspension, engine, wheels torn off, parts torn off).
// Used to check that ordinary trail driving stays (nearly) damage-free.
const { Vehicle } = await import('../../src/vehicle.js');
const seen = [];
const post = Vehicle.prototype.postPhysics;
Vehicle.prototype.postPhysics = function (input, h) {
  post.call(this, input, h);
  if (!this.__watch) { this.__watch = { id: this.spec.id, body: 1, susp: 1, engine: 1, broken: 0, off: new Set(), plastic: 0 }; seen.push(this.__watch); }
  const w = this.__watch, H = this.health;
  w.body = Math.min(w.body, H.body); w.engine = Math.min(w.engine, H.engine);
  w.susp = Math.min(w.susp, ...H.susp); w.broken = Math.max(w.broken, this.broken.filter(Boolean).length);
  w.plastic = Math.max(w.plastic, this.crash.plastic);
  for (const p of this.crash.parts) if (p.detached) w.off.add(p.id);
  w.t = (w.t || 0) + h;
  w.msgs ||= [];
  const ev = this.damageEvents;
  if (ev.length > (w.seen || 0)) { // (autopilots don't drain the HUD queue; copy what's new)
    const p = this.chassis.translation();
    for (const m of ev.slice(w.seen || 0)) w.msgs.push(`${w.t.toFixed(0)}s @${p.x.toFixed(0)},${p.z.toFixed(0)}: ${m}`);
    w.seen = ev.length;
  }
};
process.on('exit', () => {
  const by = new Map();
  for (const w of seen) {
    const a = by.get(w.id) || { runs: 0, body: 1, susp: 1, engine: 1, broken: 0, off: new Set(), plastic: 0 };
    a.runs++; a.body = Math.min(a.body, w.body); a.susp = Math.min(a.susp, w.susp); a.engine = Math.min(a.engine, w.engine);
    a.broken = Math.max(a.broken, w.broken); a.plastic = Math.max(a.plastic, w.plastic); for (const o of w.off) a.off.add(o);
    by.set(w.id, a);
  }
  if (process.env.DAMAGE_LOG) seen.forEach((w, k) => { if (w.msgs && w.msgs.length) console.log(`[damage] ${w.id} run ${k + 1}: ${w.msgs.join(' | ')}`); });
  for (const [id, a] of by) console.log(`[damage] ${id}: ${a.runs} run(s), worst body ${a.body.toFixed(3)} engine ${a.engine.toFixed(2)} susp ${a.susp.toFixed(2)} wheels off ${a.broken} parts off ${[...a.off].join(',') || '-'} plastic ${a.plastic.toFixed(1)} J/kg`);
});
