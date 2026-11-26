// Find (and optionally strip) text metadata in the repo's PNGs. Blender's render
// output writes the absolute path of the .blend (including the Windows user name) into a
// tEXt "File" chunk, and those PNGs ship in dist/ and the desktop app.
//   node scripts/png-metadata.mjs            -> list PNGs with metadata, exit 1 if any
//   node scripts/png-metadata.mjs --strip    -> remove those chunks in place (pixels untouched)
//   node scripts/png-metadata.mjs a.png ...  -> only these files
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// text chunks only: eXIf here is just DPI, tIME just a timestamp
const DROP = new Set(['tEXt', 'iTXt', 'zTXt']);
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const strip = process.argv.includes('--strip');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = args.length ? args
  : execFileSync('git', ['ls-files', '-z', '*.png'], { encoding: 'utf8' }).split('\0').filter(Boolean);

let found = 0;
for (const f of files) {
  const b = fs.readFileSync(f);
  if (!b.subarray(0, 8).equals(SIG)) continue;
  const keep = [b.subarray(0, 8)], dropped = [];
  for (let o = 8; o + 12 <= b.length;) {
    const len = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8), end = o + 12 + len;
    if (DROP.has(type)) {
      const key = b.toString('latin1', o + 8, o + 8 + Math.min(len, 80)).split('\0');
      dropped.push(type === 'tEXt' ? `${key[0]}=${key[1] ?? ''}` : type);
    } else keep.push(b.subarray(o, end));
    o = end;
    if (type === 'IEND') break;
  }
  if (!dropped.length) continue;
  found++;
  console.log(`${f}: ${dropped.join(' | ')}`);
  if (strip) fs.writeFileSync(f, Buffer.concat(keep));
}
if (strip) console.log(`stripped ${found} file(s)`);
else if (found) console.log(`\n${found} PNG(s) carry metadata; run: node scripts/png-metadata.mjs --strip`);
process.exit(!strip && found ? 1 : 0);
