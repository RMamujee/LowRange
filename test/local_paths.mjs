// Repo hygiene: no tracked file may carry an absolute user-home path or this machine's user name (a
// public repo; agents and tools like to paste full paths into docs, tests and image metadata).
// Scans every tracked text file and the text chunks (tEXt / iTXt / zTXt) of every tracked PNG.
// .blend files have their own check (test/blend_paths.mjs). Write paths as <home>\... in docs.
//   node test/local_paths.mjs [file ...]    (default: every file tracked by git)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { inflateSync } from 'node:zlib';

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const user = (() => { try { return userInfo().username; } catch { return process.env.USERNAME || process.env.USER || ''; } })();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FAIL = [
  // drive + Users + a name, in \ or / or doubled (escaped in JS / JSON strings) form
  ['home path', /[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[A-Za-z0-9 _.-]+/g],
  ['home path', /\/(?:home|Users)\/[A-Za-z0-9_.-]+\//g],
  ...(user.length >= 3 ? [['user name', new RegExp(`(?<![A-Za-z0-9])${esc(user)}(?![A-Za-z0-9])`, 'gi')]] : []),
];

// text chunks of a PNG (tEXt raw, zTXt / compressed iTXt inflated)
function pngText(b) {
  const out = [];
  for (let i = 8; i + 12 <= b.length;) {
    const n = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8), d = b.subarray(i + 8, i + 8 + n);
    if (type === 'tEXt') out.push(d.toString('latin1'));
    else if (type === 'zTXt') { const k = d.indexOf(0); try { out.push(d.toString('latin1', 0, k) + ' ' + inflateSync(d.subarray(k + 2)).toString('latin1')); } catch { out.push(d.toString('latin1')); } }
    else if (type === 'iTXt') {
      const k = d.indexOf(0), comp = d[k + 1], rest = d.subarray(k + 3), a = rest.indexOf(0), b2 = rest.indexOf(0, a + 1), txt = rest.subarray(b2 + 1);
      try { out.push(d.toString('latin1', 0, k) + ' ' + (comp ? inflateSync(txt) : txt).toString('utf8')); } catch { out.push(d.toString('latin1')); }
    }
    i += 12 + n;
  }
  return out.join('\n');
}

let bad = 0, scanned = 0;
for (const f of files) {
  if (/\.blend1?$/i.test(f)) continue;
  let b;
  try { b = readFileSync(f); } catch { continue; } // deleted in the working tree
  let s;
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) s = pngText(b);
  else if (b.subarray(0, 8000).includes(0)) continue; // other binary
  else s = b.toString('utf8');
  scanned++;
  for (const [kind, re] of FAIL) for (const m of s.matchAll(re)) {
    bad++;
    const line = s.slice(0, m.index).split('\n').length;
    console.log(`  FAIL ${f}:${line}: ${kind} (write it as <home>\\...)`);
  }
}
if (bad) { console.log(`${bad} local path / user name hit(s)`); process.exit(1); }
console.log(`ok: ${scanned} tracked files, no user-home paths or user names`);
