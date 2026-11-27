// Fails if any file the browser can fetch has a name that ad / privacy blockers block by URL alone.
// Why: uBlock Origin (Lite)'s default EasyPrivacy list has the generic rule `/beacon.js`, which blocked
// src/hud/beacon.js on localhost. One blocked module fails the whole dynamic import in src/boot.js, so
// the game sat on its loading screen with "Failed to fetch dynamically imported module: .../src/main.js"
// in any browser with the extension, while clean test browsers loaded fine. Fixed by renaming the file
// to src/hud/waypoint_pillars.js; this check keeps a new file from walking into the same trap.
//
// How the words were chosen: from the generic (not domain-anchored) block rules in uBlock Origin Lite's
// default rulesets (ublock-filters, easylist, easyprivacy, pgl, badware, urlhaus: ~5,700 rules). Those
// rules almost always put the word between delimiters ("/beacon.js", "-banner-ads-", "/ads/", ".prebid."),
// so we match whole tokens of each path segment split on / . - _ and never substrings: pixelfont.js,
// pixeltex.js and racetrack.js are fine. Ambiguous words that those lists only block inside a longer
// pattern (log, props, tag, event, stat, hit, collect, share, social, promo) are left out because this
// project has log.glb, props.js and so on, all of which load fine. pixel and px are blocked only as
// tracking-pixel names (pixel.gif, px.png, a pixel/ folder), so only those forms are flagged.
//
// Usage: node test/blocklist_names.mjs   (no browser, no server; also scans dist/ if it exists)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// whole tokens that blockers block wherever they appear between delimiters in a URL path
const WORDS = new Set([
  'ad', 'ads', 'adserver', 'advert', 'adverts', 'advertisement', 'advertising', 'adblock', 'adsense', 'adframe',
  'banner', 'banners', 'sponsor', 'sponsored', 'popup', 'popunder', 'doubleclick', 'prebid', 'affiliate',
  'beacon', 'beacons', 'analytics', 'analytic', 'tracking', 'tracker', 'track', 'clicktrack', 'telemetry',
  'metrics', 'stats', 'counter', 'pageview', 'impression', 'fingerprint', 'gtag', 'piwik', 'matomo', 'adobedtm',
]);
// tracking-pixel names: a pixel/px file stem with an image or script extension, or a pixel(s) folder
const PIXELISH = /^(?:(?:pixel|pixels)\.(?:gif|png|jpe?g|webp|js|php)|(?:px|1x1|spacer|blank)\.(?:gif|png|jpe?g|webp))$/i;
const PIXEL_DIR = /^(pixel|pixels)$/i;

function problems(urlPath) {
  const out = [];
  const segs = urlPath.split('/').filter(Boolean);
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (last && PIXELISH.test(seg)) out.push(`tracking-pixel name "${seg}"`);
    if (!last && PIXEL_DIR.test(seg)) out.push(`tracking-pixel folder "${seg}/"`);
    for (const tok of seg.toLowerCase().split(/[._-]+/)) if (WORDS.has(tok)) out.push(`token "${tok}" in "${seg}"`);
  });
  return out;
}

let fails = 0;
const check = (ok, msg) => { if (!ok) { console.log('  FAIL', msg); fails++; } };

// self-test: names a blocker really blocks must be caught, names this project uses must pass
for (const p of ['/src/hud/beacon.js', '/ads/x.png', '/img/banner-top.png', '/pixel.gif', '/js/analytics.js', '/src/tracking_view.js', '/a/pixel/x.png'])
  check(problems(p).length > 0, `self-test: ${p} should be flagged`);
for (const p of ['/src/ui/pixelfont.js', '/src/gfx/pixeltex.js', '/src/ui/pixelwebfont.js', '/src/hud/px.js', '/src/maps/racetrack.js', '/models/log.glb', '/src/art/props.js', '/src/hud/waypoint_pillars.js', '/src/hud/instruments.js', '/src/spawns.js'])
  check(problems(p).length === 0, `self-test: ${p} should pass (${problems(p).join('; ')})`);

// every file the browser can request: src/ (dev server), public/ (served at /), index.html refs, dist/ (web build)
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
const urls = new Set();
for (const f of walk(path.join(root, 'src'))) urls.add('/' + path.relative(root, f).split(path.sep).join('/'));
for (const f of walk(path.join(root, 'public'))) urls.add('/' + path.relative(path.join(root, 'public'), f).split(path.sep).join('/'));
for (const f of walk(path.join(root, 'dist'))) urls.add('/dist/' + path.relative(path.join(root, 'dist'), f).split(path.sep).join('/'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)) if (!/^(data:|https?:|#)/.test(m[1])) urls.add('/' + m[1].replace(/^\.?\//, ''));

for (const u of [...urls].sort()) { const p = problems(u); check(p.length === 0, `${u}: ${p.join('; ')} (ad/privacy blockers may block it; rename the file)`); }

console.log(fails ? `${fails} failure(s)` : `ok: ${urls.size} browser-fetchable paths, none match ad/privacy blocklist names`);
process.exit(fails ? 1 : 0);
