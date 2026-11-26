// Pure URL / path policy for the desktop shell, kept free of Electron imports so
// test/electron-policy.mjs can exercise exactly the code main.cjs runs.
'use strict';

const path = require('node:path');

// Only these sites may be opened, and only in the user's own browser.
const EXTERNAL_ALLOW = new Set(['github.com', 'threejs.org', 'rapier.rs']);

// Map an app:// URL pathname to a file inside `root`, or null if it must not be served.
// `pathname` is still percent-encoded (URL#pathname); the URL parser has already resolved
// literal and %2e dot segments, but %2f / %5c / %00 survive until we decode them here.
function resolveAppPath(root, pathname, p = path) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; } // malformed %-escape
  if (rel.includes('\0')) return null;
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = p.normalize(p.join(root, rel));
  if (file === root || !file.startsWith(root + p.sep)) return null;
  return file;
}

// https only, exact host from the allow-list (optionally www.), no credentials, default port.
function isAllowedExternal(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
    EXTERNAL_ALLOW.has(u.hostname.replace(/^www\./, ''));
}

module.exports = { EXTERNAL_ALLOW, resolveAppPath, isAllowedExternal };
