/**
 * Audio check: the engine starts, the score and ambience make sound, every effect
 * plays without throwing, and the mix settings reach the buses.
 *
 * Headless Chromium has a real WebAudio graph, so an analyser on the master bus tells
 * us whether anything is actually coming out.
 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const srv = createServer((req, res) => {
  let p = join(root, decodeURIComponent(req.url.split('?')[0]));
  if (p.endsWith('/')) p = join(p, 'index.html');
  if (!existsSync(p)) p = join(root, 'index.html');
  res.setHeader('content-type', MIME[extname(p)] ?? 'application/octet-stream');
  res.end(readFileSync(p));
});
await new Promise((r) => srv.listen(0, r));
const PORT = srv.address().port;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 874, height: 402 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.kemet?.game, null, { timeout: 60000 });
await page.mouse.click(400, 200); // the unlock gesture
await page.evaluate(() => {
  document.querySelector('.modal')?.classList.add('hidden');
  window.kemet.game.suspended = false;
});
await page.waitForFunction(() => window.kemet.game.audio.ctx?.state === 'running', null, { timeout: 10000 });

const level = (ms) => page.evaluate((ms) => new Promise((done) => {
  const a = window.kemet.game.audio;
  const ctx = a.ctx;
  if (!a.__an) { a.__an = ctx.createAnalyser(); a.__an.fftSize = 2048; a.master.connect(a.__an); }
  const buf = new Float32Array(a.__an.fftSize);
  let peak = 0, sum = 0, n = 0;
  const t0 = performance.now();
  const iv = setInterval(() => {
    a.__an.getFloatTimeDomainData(buf);
    for (const v of buf) { peak = Math.max(peak, Math.abs(v)); sum += v * v; n++; }
    if (performance.now() - t0 > ms) { clearInterval(iv); done({ peak: +peak.toFixed(3), rms: +Math.sqrt(sum / n).toFixed(4) }); }
  }, 50);
}), ms);

// Let the score get going over farmland and river.
await page.waitForTimeout(2500);
const score = await level(5000);

// Every effect, one after another.
const fx = await page.evaluate(async () => {
  const a = window.kemet.game.audio;
  const names = ['tap', 'panel', 'build', 'road', 'demolish', 'error', 'coins', 'evolve', 'devolve', 'grow',
    'chime', 'fireAlarm', 'collapse', 'horn', 'blessing', 'thunder', 'fanfare'];
  const failed = [];
  for (const n of names) {
    try { n === 'coins' ? a.coins(400) : n === 'evolve' ? a.evolve(8) : a[n](); } catch (e) { failed.push(`${n}: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { names: names.length, failed };
});
const effects = await level(1500);

// City events reach the speakers through the game.
const events = await page.evaluate(() => {
  const g = window.kemet.game;
  const before = g.city.events.length;
  g.city.emit('tax', -1, 250);
  g.city.emit('blessing', -1, 0);
  return before;
});
await page.waitForTimeout(400);
const drained = await page.evaluate(() => window.kemet.game.city.events.length);

// Mute, then the mix settings.
await page.evaluate(() => window.kemet.updateSettings ? window.kemet.updateSettings({ muted: true }) : window.kemet.game.audio.setMix(0.5, 0.5, 0.5, true));
await page.waitForTimeout(800);
const muted = await level(1200);
await page.evaluate(() => window.kemet.updateSettings ? window.kemet.updateSettings({ muted: false }) : window.kemet.game.audio.setMix(0.55, 0.8, 0.6, false));

const listener = await page.evaluate(() => window.kemet.game.audio.listener);

console.log('score + ambience      ', JSON.stringify(score));
console.log('effects               ', JSON.stringify(effects), fx.failed.length ? 'FAILED ' + fx.failed.join('; ') : `all ${fx.names} played`);
console.log('events drained        ', drained === 0 ? 'yes' : `no (${drained} left)`);
console.log('muted                 ', JSON.stringify(muted));
console.log('listener              ', JSON.stringify(listener));
const ok = score.rms > 0.002 && effects.peak > 0.05 && muted.peak < 0.01 && !fx.failed.length && drained === 0 && !errors.length;
if (errors.length) console.log('page errors:', errors.slice(0, 5));
console.log(ok ? 'AUDIO OK' : 'AUDIO FAILED');
await browser.close();
srv.close();
process.exit(ok ? 0 : 1);
