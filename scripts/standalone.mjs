/**
 * Fold the built site into one self-contained index.html.
 *
 * The point is a file that can be AirDropped, emailed or dropped into iCloud Drive and
 * opened straight from Safari with no server and no sibling files. Everything — script,
 * stylesheet, manifest, icons — is inlined, so the whole game is one document.
 *
 * The service worker is deliberately left out: it cannot register from a file:// origin,
 * and a failed registration writes a scary console error for no benefit.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = process.argv[2] ?? join(root, 'kemet-standalone.html');

if (!existsSync(join(dist, 'index.html'))) {
  console.error('No dist/ to fold up. Run `npm run build` first.');
  process.exit(1);
}

let html = readFileSync(join(dist, 'index.html'), 'utf8');

const dataUri = (file, mime) =>
  `data:${mime};base64,${readFileSync(join(dist, file)).toString('base64')}`;

// Stylesheet.
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_m, href) => {
  const css = readFileSync(join(dist, href.replace(/^\.?\//, '')), 'utf8');
  return `<style>${css}</style>`;
});

// Module script. `</script>` inside a string literal would close the tag early.
html = html.replace(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g, (_m, src) => {
  const js = readFileSync(join(dist, src.replace(/^\.?\//, '')), 'utf8');
  return `<script type="module">${js.replace(/<\/script>/g, '<\\/script>')}</script>`;
});

// Icons and manifest become data URIs so the home-screen install still works.
html = html.replace(/href="\.?\/?(icons\/[^"]+\.png)"/g, (_m, f) => `href="${dataUri(f, 'image/png')}"`);
html = html.replace(/href="\.?\/?(manifest\.webmanifest)"/g, () => {
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons ?? []) {
    const f = icon.src.replace(/^\.?\//, '');
    if (existsSync(join(dist, f))) icon.src = dataUri(f, 'image/png');
  }
  return `href="data:application/manifest+json;base64,${Buffer.from(JSON.stringify(manifest)).toString('base64')}"`;
});

// No service worker off a file:// origin.
html = html.replace(/<script[^>]*>[^<]*serviceWorker[^<]*<\/script>/g, '');

writeFileSync(out, html);
console.log(`${out} — ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, self-contained`);
