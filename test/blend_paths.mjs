// Repo hygiene: no tracked .blend may carry an absolute local path or the user's name (Blender stores the
// last Save As folder, recent files and absolute image paths in the file). Decompresses zstd .blends.
//   node test/blend_paths.mjs [file.blend ...]    (default: every .blend tracked by git)
//   VERBOSE=1 also lists the informational hits (bare "Users", "Documents", ... without a drive letter)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : execFileSync('git', ['ls-files', '*.blend'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const user = (() => { try { return userInfo().username; } catch { return process.env.USERNAME || process.env.USER || ''; } })();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// fail: absolute paths (drive letter, UNC, home dirs) and the current user's name
const FAIL = [
  // a NUL-terminated string (as Blender stores them); mesh/float data would otherwise give random "X:/" hits
  ['drive path', /(?<![\x20-\x7e])[A-Za-z]:[\\/][A-Za-z0-9 _.~()\\/-]{3,}(?=\x00)/g],
  ['UNC path', /(?<![\x20-\x7e])\\\\[A-Za-z0-9_.-]{2,}\\[A-Za-z0-9 _.~()\\/-]{2,}(?=\x00)/g],
  ['home dir', /\/(?:home|Users)\/[A-Za-z0-9_.-]+/g],
  ...(user.length >= 3 ? [['user name', new RegExp(esc(user), 'gi')]] : []),
  ['email', /[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,10}(?=[\x00\s>)"'])/g],
];
// report only: words that usually travel with a local path
const INFO = [['path word', /Users|Documents|AppData|\bTemp\b|Desktop|OneDrive/g]];

// Blender writes zstd in the "seekable" format: many independent frames + a seek table in a trailing
// skippable frame. zstdDecompressSync stops after the first frame, so walk the table.
function unzstd(b) {
  const n = b.length;
  if (b.readUInt32LE(n - 4) !== 0x8f92eab1) return zstdDecompressSync(b);
  const frames = b.readUInt32LE(n - 9), desc = b[n - 5], entry = desc & 0x80 ? 12 : 8;
  let tab = n - 9 - frames * entry, off = 0;
  const out = [];
  for (let i = 0; i < frames; i++, tab += entry) {
    const c = b.readUInt32LE(tab);
    out.push(zstdDecompressSync(b.subarray(off, off + c)));
    off += c;
  }
  return Buffer.concat(out);
}

function raw(path) {
  const b = readFileSync(path);
  if (b.readUInt32LE(0) === 0xfd2fb528) return unzstd(b);  // zstd magic
  if (b[0] === 0x1f && b[1] === 0x8b) throw new Error(`${path}: gzip .blend (pre-3.0), re-save it`);
  return b;
}
const ctx = (s, i, n) => s.slice(Math.max(0, i - 40), i + n + 40).replace(/[^\x20-\x7e]/g, '.');

let bad = 0;
for (const f of files) {
  const s = raw(f).toString('latin1');
  const hits = [];
  for (const [kind, re] of FAIL) for (const m of s.matchAll(re)) hits.push([kind, m.index, m[0]]);
  console.log(`${f}: ${s.length} bytes, ${hits.length} forbidden hit(s)`);
  for (const [kind, i, m] of hits.slice(0, 40)) console.log(`  ${kind} @${i}: ${m.replace(/[^\x20-\x7e]/g, '.')}`);
  if (hits.length > 40) console.log(`  ... ${hits.length - 40} more`);
  if (process.env.VERBOSE) for (const [kind, re] of INFO) for (const m of s.matchAll(re)) console.log(`  (info) ${kind} @${m.index}: ...${ctx(s, m.index, m[0].length)}...`);
  bad += hits.length;
}
if (bad) { console.log(`FAIL: ${bad} local path / user hit(s); clean with: blender --background --factory-startup <file.blend> --python tools/blender/blend_save.py`); process.exit(1); }
console.log('ok: no absolute local paths or user names in', files.length, '.blend file(s)');
