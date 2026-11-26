// Unit test for the desktop shell's URL / path policy (electron/policy.cjs): app:// path
// traversal and the shell.openExternal allow-list. No Electron needed: node test/electron-policy.mjs
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveAppPath, isAllowedExternal } = require('../electron/policy.cjs');

let fails = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ' (want ' + JSON.stringify(want) + ')'}`);
};

// ---- app:// -> dist/ ----
// Pathnames are passed raw (still %-encoded and NOT dot-normalised), which is stricter than
// what Chromium hands the handler for a standard scheme.
for (const [p, root] of [[path.win32, 'C:\\Apps\\LowRange\\resources\\app.asar\\dist'], [path.posix, '/opt/LowRange/resources/app.asar/dist']]) {
  const tag = p === path.win32 ? 'win' : 'posix';
  const r = (pathname) => resolveAppPath(root, pathname, p);
  check(`${tag} root -> index.html`, r('/'), p.join(root, 'index.html'));
  check(`${tag} plain asset`, r('/assets/index-abc.js'), p.join(root, 'assets', 'index-abc.js'));
  check(`${tag} encoded space`, r('/models/a%20b.glb'), p.join(root, 'models', 'a b.glb'));
  const denied = [
    '/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/%2e%2e%2f%2e%2e%2fpackage.json',
    '/assets/../../electron/main.cjs', '/%252e%252e/x' /* double-encoded stays literal: allowed below */,
    '/index.html%00.png', '/%00', '/%', '/%E0%A4%A', '/..', '/%2e%2e',
    '/..%2f..%2f..%2f..%2fWindows%2fwin.ini', '/../dist-evil/x', '/..%2fdist2%2fx',
    // backslash is a separator only on Windows (on POSIX it is part of a file name inside dist)
    ...(p === path.win32 ? ['/%2E%2E%5Cpackage.json', '/..\\..\\x', '/assets%5C..%5C..%5Cx'] : []),
  ];
  for (const d of denied) {
    const got = r(d);
    if (d === '/%252e%252e/x') { check(`${tag} double-encoded is a literal name inside dist`, got, p.join(root, '%2e%2e', 'x')); continue; }
    check(`${tag} deny ${d}`, got, null);
  }
  if (p === path.win32) {
    // absolute / UNC / drive paths are joined *under* dist, never replace it
    for (const d of ['/C:/Windows/win.ini', '/C:%5CWindows%5Cwin.ini', '//server/share/x', '/%5C%5Cserver%5Cshare%5Cx', '/%5C%5C%3F%5CC:%5Cx']) {
      const got = r(d);
      check(`win absolute/UNC ${d} stays in dist`, got !== null && got.startsWith(root + '\\'), true);
    }
    // case: a different-case root prefix is not accepted as "inside"
    check('win case trick', resolveAppPath(root, '/..%2fDIST%2fx', p), null);
  }
}

// ---- shell.openExternal allow-list ----
const allow = ['https://github.com/RMamujee/LowRange', 'https://www.github.com/', 'https://threejs.org/docs/', 'https://rapier.rs/', 'https://GITHUB.COM/x', 'https://github%2ecom/' /* host is percent-decoded to github.com */];
const deny = [
  'http://github.com/', 'https://github.com.evil.tld/', 'https://evil.tld/github.com', 'https://github.com@evil.tld/',
  'https://user:pass@github.com/', 'https://github.com:8443/', 'https://evilgithub.com/', 'https://gist.github.com/',
  'https://github.com./', 'https://www.www.github.com/', 'javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe',
  'ms-settings:', 'search-ms:query=x', 'app://lowrange/index.html', 'https://xn--gthub-n4a.com/',
  'https://[::1]/', 'https://127.0.0.1/', '', 'not a url', '\\\\server\\share',
];
for (const u of allow) check(`allow ${u}`, isAllowedExternal(u), true);
for (const u of deny) check(`deny ${u}`, isAllowedExternal(u), false);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
