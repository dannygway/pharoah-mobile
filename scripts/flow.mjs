/**
 * Gameplay-flow check: the first-mission guide advances off the city's state, the
 * placement ghost reports reach and explains refusals, and floating feedback appears.
 * Screenshots go to the folder given as the first argument (default: flow-shots).
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { extname, join } from 'path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const out = process.argv[2] ?? 'flow-shots'; mkdirSync(out, { recursive: true });
const fails = [];
const expect = (ok, what) => { console.log(`  ${ok ? '✓' : '✗'} ${what}`); if (!ok) fails.push(what); };
const portrait = process.argv[3] === 'portrait';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const srv = createServer((req, res) => { let p = join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p = join(p, 'index.html'); if (!existsSync(p)) p = join(root, 'index.html'); res.setHeader('content-type', MIME[extname(p)] ?? 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => srv.listen(0, r));
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const vp = portrait ? { width: 402, height: 874 } : { width: 874, height: 402 };
const page = await b.newPage({ viewport: vp, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://localhost:${srv.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.kemet?.game, null, { timeout: 60000 });
await page.evaluate(() => { localStorage.removeItem('kemet.settings'); window.kemet.updateSettings({ guide: true }); window.kemet.ui.closeModal(); window.kemet.game.setSpeed(0); document.querySelectorAll('.toast').forEach((t) => t.remove()); });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/1-guide.png` });
const r1 = await page.evaluate(() => document.querySelector('.guide')?.innerText);
expect(/Lay a road/.test(r1 ?? ''), 'guide opens on "Lay a road"');
// Build the opening by hand at the settlement site.
const site = await page.evaluate(() => {
  const g = window.kemet.game; const c = g.city; c.funds = 20000;
  const [sx, sy] = g.findSettlementSite();
  let bx = sx - 6, by = sy - 6;
  for (let i = 0; i <= 10; i++) for (const yy of [0, 5, 10]) c.place('road', bx + i, by + yy);
  for (let i = 0; i <= 10; i++) for (const xx of [0, 5, 10]) c.place('road', bx + xx, by + i);
  for (const [cx, cy] of [[1, 1], [6, 1], [1, 6]]) for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) c.place('house', bx + cx + dx, by + cy + dy);
  c.markDirty();
  return [bx, by];
});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/2-step-advanced.png` });
expect(/Dig a well/.test(await page.evaluate(() => document.querySelector('.guide')?.innerText ?? '')), 'guide advances to "Dig a well" once roads and plots exist');
// Show me -> well armed; hover inside the block.
await page.evaluate(() => document.querySelector('.guide .g-show').click());
const hover = async (tx, ty) => page.evaluate(([tx, ty]) => {
  const g = window.kemet.game; const cam = g.scene.camera;
  const wx = (tx - ty) * 32, wy = (tx + ty) * 16 + 16;
  const [sx, sy] = cam.worldToScreen(wx, wy, g.renderer.viewW, g.renderer.viewH);
  g.updateCursor(sx, sy);
  return [g.armed, g.placeHint?.text, g.placeHint?.tone];
}, [tx, ty]);
await page.evaluate(([bx, by]) => { const cam = window.kemet.game.scene.camera; cam.centreOnTile(bx + 5, by + 5); cam.tzoom = cam.zoom = 1.0; }, site);
{ const h = await hover(site[0] + 6, site[1] + 6); expect(h[0] === 'well' && /^Waters [1-9]/.test(h[1] ?? ''), `Show me arms the well and its hint counts houses (${h[1]})`); }
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/3-well-reach.png` });
await page.evaluate(() => window.kemet.game.arm('bazaar'));
{ const h = await hover(site[0] + 6, site[1] + 6); expect(/^Reaches [1-9]/.test(h[1] ?? '') && h[2] === 'ok', `bazaar ghost shows its reach (${h[1]})`); }
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/4-bazaar-reach.png` });
{ const h = await hover(site[0] + 20, site[1] + 3); expect(/road/.test(h[1] ?? '') && h[2] === 'warn', `away from roads it warns (${h[1]})`); }
await page.evaluate(() => window.kemet.game.arm('farm_grain'));
{ const h = await hover(site[0] + 7, site[1] + 7); expect(h[2] === 'bad' && /floodplain/.test(h[1] ?? ''), `a farm on dry ground says why not (${h[1]})`); }
// Farm step: show me glides to the floodplain.
await page.evaluate(() => { window.kemet.game.arm(null); const c = window.kemet.game.city; });
// Floats.
await page.evaluate(([bx, by]) => {
  const g = window.kemet.game; const w = g.world;
  g.city.emit('evolve', w.idx(bx + 2, by + 2), 3);
  g.city.emit('grow', w.idx(bx + 7, by + 2), 2);
  g.city.emit('devolve', w.idx(bx + 2, by + 7), 1);
  g.city.emit('tax', -1, 85);
}, site);
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/5-floats.png` });
expect(await page.evaluate(() => document.querySelectorAll('.float').length) >= 3, 'floating text appears for city events');
expect(!errs.length, errs.length ? 'page errors: ' + errs.join(' | ') : 'no page errors');
await b.close(); srv.close();
console.log(fails.length ? `\n${fails.length} flow check(s) failed.` : '\nFlow checks passed.');
process.exit(fails.length ? 1 : 0);
