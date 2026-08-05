/**
 * Post-build: bake the real hashed asset list into the service worker.
 *
 * Vite emits content-hashed filenames, so the precache list cannot be written by hand.
 * This walks dist/, collects everything worth caching, and rewrites the
 * `self.__PRECACHE__` placeholder in dist/sw.js.
 */

import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(dist)
  .map((p) => './' + relative(dist, p).split('\\').join('/'))
  // The worker itself must not be in its own precache list.
  .filter((p) => p !== './sw.js');

const precache = ['./', './index.html', ...files.filter((f) => f !== './index.html')];

const swPath = join(dist, 'sw.js');
let sw = readFileSync(swPath, 'utf8');
sw = sw.replace(
  'self.__PRECACHE__ || ',
  `${JSON.stringify(precache)} || `,
);
// Bust the cache name whenever the asset set changes, so an update actually lands.
const stamp = files.join('|').length.toString(36) + '-' + Date.now().toString(36);
sw = sw.replace("const VERSION = 'kemet-v1';", `const VERSION = 'kemet-${stamp}';`);
writeFileSync(swPath, sw);

const total = walk(dist).reduce((n, p) => n + statSync(p).size, 0);
console.log(`precached ${precache.length} files · ${(total / 1024).toFixed(0)} KB total`);
