// build-single.mjs — package the vite multi-file build into ONE inlined HTML
// file (the Unity Ads deliverable): the JS bundle goes inline, every sprite +
// the manifest become a window.__RR_ASSETS data-URI map, the coin HUD <img>
// becomes a data URI, and three.js's createElementNS("http://...xhtml") call
// is rewritten to the equivalent document.createElement so the packaged file
// contains no insecure-http token (the namespace string is not a network
// fetch; in an HTML document the two calls are identical).
//
// Run AFTER `npx vite build`:  node scripts/build-single.mjs
// Output: dist-single/index.html (+ dist-single/reef-rush.zip for Google)
//
// Every transform ASSERTS it matched (a silent no-op packager ships a broken
// file that still exits 0 — the exact false-pass shape this repo's linter
// exists to catch).

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const out = path.join(root, 'dist-single');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
}

// --- 1. the vite outputs ------------------------------------------------------
let html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const jsFiles = readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js'));
assert(jsFiles.length === 1, `expected exactly 1 JS bundle, found ${jsFiles.length}`);
let js = readFileSync(path.join(dist, 'assets', jsFiles[0]), 'utf8');

// --- 2. rewrite the one three.js namespace-URI call (see header) --------------
const NS_CALL = /document\.createElementNS\("http:\/\/www\.w3\.org\/1999\/xhtml",([A-Za-z_$][\w$]*)\)/g;
const nsMatches = [...js.matchAll(NS_CALL)];
assert(nsMatches.length === 1, `expected exactly 1 createElementNS(xhtml) call, found ${nsMatches.length}`);
js = js.replace(NS_CALL, 'document.createElement($1)');
assert(!/http:\/\//.test(js), 'bundle still contains an http:// token after the rewrite');
assert(!js.includes('</script'), 'bundle contains a </script token and cannot be inlined verbatim');

// --- 3. build the inline asset map from the SOURCE assets (same files vite
//        copied into dist/assets — read from public/ where the paths are the
//        manifest-relative originals) --------------------------------------
const assetsDir = path.join(root, 'public', 'assets');
const manifest = JSON.parse(readFileSync(path.join(assetsDir, 'manifest.json'), 'utf8'));
const files = {};
for (const s of manifest.sprites) {
  const p = path.join(assetsDir, s.path);
  assert(statSync(p).isFile(), `manifest sprite missing on disk: ${s.path}`);
  files[s.path] = 'data:image/png;base64,' + readFileSync(p).toString('base64');
}
// The manifest itself is BUNDLED (assets.js imports the JSON), so only the
// data-URI file map is injected — assets.js reads __RR_ASSETS.files.
const inlineBlock =
  `<script>window.__RR_ASSETS=${JSON.stringify({ files })};</script>`;

// --- 4. splice the HTML --------------------------------------------------------
// coin HUD <img>: runtime-fetched file -> data URI
const coinRef = /src="assets\/sprites\/coin\.png"/;
assert(coinRef.test(html), 'coin HUD img reference not found in dist/index.html');
html = html.replace(coinRef, `src="${files['sprites/coin.png']}"`);

// module script tag -> the asset map + the inlined bundle
const tag = /<script type="module" crossorigin src="\/assets\/[^"]+\.js"><\/script>/;
assert(tag.test(html), 'vite module script tag not found in dist/index.html');
html = html.replace(tag, () => `${inlineBlock}\n<script type="module">${js}</script>`);

// nothing else may point at a shipped file (mraid.js is the container's)
const localRefs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
  .map((m) => m[1])
  .filter((v) => !/^(?:https?:|data:|#)/i.test(v));
assert(localRefs.length === 1 && localRefs[0] === 'mraid.js',
  `unexpected local file references remain: ${JSON.stringify(localRefs)}`);

// --- 5. write + zip ------------------------------------------------------------
mkdirSync(out, { recursive: true });
const outFile = path.join(out, 'index.html');
writeFileSync(outFile, html);
const bytes = statSync(outFile).size;
console.log(`dist-single/index.html: ${bytes} bytes (${(bytes / 1048576).toFixed(2)} MB)`);
assert(bytes <= 5242880, 'single file exceeds the 5 MB extracted limit');
try {
  execFileSync('zip', ['-j', '-q', path.join(out, 'reef-rush.zip'), outFile]);
  const zbytes = statSync(path.join(out, 'reef-rush.zip')).size;
  console.log(`dist-single/reef-rush.zip: ${zbytes} bytes (${(zbytes / 1048576).toFixed(2)} MB)`);
} catch {
  console.log('zip unavailable — reef-rush.zip not written (Google pack check needs it)');
}
console.log('single-file package OK');
