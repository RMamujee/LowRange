// Debug: dump rocks and terrain cross-sections along a trail, heights relative to the path profile.
// usage: node test/trailscan.mjs <trailIndex> <s0> <s1> [step]
import { generateRocks, heightAt, TRAILS, pathPoint } from '../src/terrain.js';
const ti = +(process.argv[2] ?? 3), s0 = +(process.argv[3] ?? 0), s1 = +(process.argv[4] ?? 40), step = +(process.argv[5] ?? 1);
const t = TRAILS[ti];
console.log(`${t.name} (${t.diff}) length ${t.length.toFixed(1)} width ${t.width}`);
const rocks = generateRocks();
const near = [];
for (const r of rocks) {
  // project onto trail
  let bs = 0, bd = 1e9;
  for (let q = 0; q < t.length; q += 0.25) { const p = pathPoint(t, q); const d = Math.hypot(p.x - r.x, p.z - r.z); if (d < bd) { bd = d; bs = q; } }
  if (bs < s0 - 3 || bs > s1 + 3 || bd > t.width / 2 + 3) continue;
  const p = pathPoint(t, bs);
  const lat = (r.x - p.x) * -p.tz + (r.z - p.z) * p.tx;
  // top: how far the hull stands above the ground under each of its points (true protrusion)
  let top = -1e9, rad = 0; const c = Math.cos(r.rotY), sn = Math.sin(r.rotY);
  for (let i = 0; i < r.pts.length; i += 3) {
    const px = r.pts[i], pz = r.pts[i + 2], wx = r.x + px * c + pz * sn, wz = r.z - px * sn + pz * c;
    top = Math.max(top, r.y + r.pts[i + 1] - heightAt(wx, wz)); rad = Math.max(rad, Math.hypot(px, pz));
  }
  near.push({ s: bs, lat, top, rad, ledge: !!r.ledge });
}
near.sort((a, b) => a.s - b.s);
for (const n of near) console.log(`  rock s=${n.s.toFixed(1)} lat=${n.lat.toFixed(2)} rad=${n.rad.toFixed(2)} top=${n.top.toFixed(2)}${n.ledge ? ' LEDGE' : ''}`);
console.log('cross-sections: lat -4..4 step 1, height rel path h; grade');
for (let s = s0; s <= s1; s += step) {
  const p = pathPoint(t, s), p2 = pathPoint(t, s + 1);
  const row = [];
  for (let o = -4; o <= 4; o += 1) { const x = p.x - p.tz * o, z = p.z + p.tx * o; row.push((heightAt(x, z) - p.h).toFixed(2).padStart(6)); }
  console.log(`  s=${String(s).padStart(5)} g=${(p2.h - p.h).toFixed(2).padStart(5)} |${row.join('')}`);
}
