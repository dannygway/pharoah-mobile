/**
 * Performance bench: a big city, measured.
 *
 * Builds a dense city of several thousand people on the sandbox map, runs it until the
 * streets fill, then times the things a phone has to do every frame and every month:
 * a simulation tick, the month boundary, the JavaScript side of a render (sprite
 * batching, with the GPU calls stubbed out so the number means something off-device),
 * the fault sweep, and a full UI refresh.
 *
 * Software GL makes absolute GPU numbers meaningless here, so the render figure is the
 * CPU cost only — which is the half a phone is most likely to choke on.
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
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--enable-precise-memory-info'],
});
const page = await browser.newPage({ viewport: { width: 874, height: 402 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const t0 = Date.now();
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.kemet?.game, null, { timeout: 60000 });
const bootMs = Date.now() - t0;
const atlasMs = await page.evaluate(() => window.kemet.bootTimings ?? null);

await page.evaluate(() => {
  document.querySelector('.modal')?.classList.add('hidden');
  window.kemet.ui.onNewGame('sandbox');
});
await page.waitForTimeout(500);

const built = await page.evaluate(() => {
  const { game } = window.kemet;
  game.suspended = false;
  game.setSpeed(0);
  const c = game.city, w = game.world;
  c.funds = 1e7;
  const dry = (t) => t === 2 || t === 3 || t === 6;
  // The biggest square of mostly dry ground.
  let best = 0, ox = 0, oy = 0;
  for (let y = 2; y < w.size - 50; y += 2) for (let x = 2; x < w.size - 50; x += 2) {
    let n = 0;
    for (let dy = 0; dy < 50; dy += 2) for (let dx = 0; dx < 50; dx += 2) if (dry(w.terrain[w.idx(x + dx, y + dy)])) n++;
    if (n > best) { best = n; ox = x; oy = y; }
  }
  const S = 50;
  for (let y = 0; y <= S; y += 5) for (let x = 0; x <= S; x++) c.place('road', ox + x, oy + y);
  for (let x = 0; x <= S; x += 5) for (let y = 0; y <= S; y++) c.place('road', ox + x, oy + y);
  const services = ['bazaar', 'granary', 'temple_osiris', 'water_supply', 'firehouse', 'architect_post',
    'scribal_school', 'booth', 'physician', 'tax_collector', 'temple_ra', 'storage_yard', 'courthouse', 'dentist'];
  let k = 0, lots = 0;
  for (let cy = 0; cy + 5 <= S; cy += 5) for (let cx = 0; cx + 5 <= S; cx += 5) {
    const x = ox + cx + 1, y = oy + cy + 1;
    if (((cx / 5) + (cy / 5) * 3) % 4 === 0) { c.place(services[k++ % services.length], x, y); continue; }
    c.place('well', x + 3, y + 3);
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) if (c.place('house', x + dx, y + dy) !== -1) lots++;
  }
  // Farms and camps wherever there is black land.
  let farms = 0;
  for (let y = 2; y < w.size - 4 && farms < 30; y += 3) for (let x = 2; x < w.size - 4 && farms < 30; x += 3) {
    if (c.place(farms % 2 ? 'farm_grain' : 'farm_chickpea', x, y) !== -1) farms++;
  }
  // Move people in directly: the bench is about load, not about immigration.
  let pop = 0;
  for (const id of c.liveBuildings) {
    const b = c.buildings[id];
    if (!b?.house) continue;
    b.house.level = 5; b.house.people = 10; pop += 10;
    b.house.foods.grain = 40;
  }
  c.population = pop;
  c.markDirty();
  c.recomputeDesirability();
  // Run three months so walkers fill the streets.
  for (let t = 0; t < 360 * 3; t++) { c.step(); game.systems.step(); }
  game.scene.camera.centreOnTile(ox + 25, oy + 25);
  game.scene.camera.tzoom = game.scene.camera.zoom = 0.55;
  return { lots, pop: c.population, buildings: c.liveBuildings.length, walkers: c.walkers.count, farms };
});

const timing = await page.evaluate(() => {
  const { game } = window.kemet;
  const c = game.city;
  const now = () => performance.now();
  const stats = (xs) => {
    const s = xs.slice().sort((a, b) => a - b);
    return { mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3), p95: +s[Math.floor(s.length * 0.95)].toFixed(3), max: +s[s.length - 1].toFixed(3) };
  };

  // Simulation: per tick, over five months, so month boundaries are in the sample.
  const ticks = [];
  for (let t = 0; t < 360 * 5; t++) {
    const a = now();
    c.step(); game.systems.step();
    ticks.push(now() - a);
  }

  // What the month boundary spends its time on.
  const parts = {};
  const wrap = (obj, name, label) => {
    const fn = obj[name];
    if (typeof fn !== 'function') return;
    obj[name] = function (...args) {
      const a = now();
      const r = fn.apply(this, args);
      parts[label] = (parts[label] ?? 0) + (now() - a);
      return r;
    };
  };
  for (const n of ['allocateLabor', 'consumeHousehold', 'evolveHousing', 'collectTaxes', 'payWages',
    'updateImmigration', 'updateHealth', 'updateStats', 'updateSentiment', 'checkLogistics',
    'recomputeDesirability', 'stepDay']) wrap(c, n, n);
  for (const n of ['runMonth', 'runLogistics', 'runWorkCamps', 'runMonuments', 'runPerformers', 'runGetOrders']) wrap(game.systems, n, 'systems.' + n);
  for (let t = 0; t < 360 * 3; t++) { c.step(); game.systems.step(); }
  const monthParts = Object.entries(parts).map(([k, v]) => [k, +(v / 3).toFixed(2)]).sort((a, b) => b[1] - a[1]);

  // Render, CPU side only: stub the GPU calls.
  const r = game.renderer;
  const realFlush = r.flush.bind(r);
  const realGround = r.ground.draw.bind(r.ground);
  r.flush = () => { r.lastSpriteCount = r.count ?? r.lastSpriteCount; r.count = 0; };
  r.ground.draw = () => {};
  const frames = [];
  for (let i = 0; i < 120; i++) {
    const a = now();
    game.scene.render(c, game.systems, i / 60, 1 / 60);
    frames.push(now() - a);
  }
  r.flush = realFlush;
  r.ground.draw = realGround;

  // The fault sweep and a full UI refresh.
  const sweeps = [];
  for (let i = 0; i < 20; i++) { const a = now(); game.systems.cityProblems(40); sweeps.push(now() - a); }
  const refreshes = [];
  for (let i = 0; i < 20; i++) { const a = now(); window.kemet.ui.refresh(); refreshes.push(now() - a); }
  const ticksUi = [];
  for (let i = 0; i < 120; i++) { const a = now(); window.kemet.ui.tick(1 / 60); ticksUi.push(now() - a); }

  const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
  return {
    tick: stats(ticks), render: stats(frames), sprites: game.renderer.lastSpriteCount,
    problems: stats(sweeps), uiRefresh: stats(refreshes), uiTick: stats(ticksUi),
    walkers: c.walkers.count, heapMB: mem, monthParts,
  };
});

console.log(`boot to playable: ${bootMs} ms${atlasMs ? `  (${JSON.stringify(atlasMs)})` : ''}`);
console.log(`city: ${built.lots} lots, ${built.pop} people, ${built.buildings} buildings, ${built.farms} farms`);
console.log(`walkers on the streets: ${timing.walkers}   JS heap: ${timing.heapMB} MB`);
console.log('');
console.log(`sim tick         mean ${timing.tick.mean} ms   p95 ${timing.tick.p95}   worst ${timing.tick.max}   (30 ticks/s at 1×, 150 at 5×)`);
console.log(`render (CPU)     mean ${timing.render.mean} ms   p95 ${timing.render.p95}   worst ${timing.render.max}   ${timing.sprites} sprites`);
console.log(`fault sweep      mean ${timing.problems.mean} ms   worst ${timing.problems.max}`);
console.log(`UI refresh       mean ${timing.uiRefresh.mean} ms   worst ${timing.uiRefresh.max}`);
console.log(`UI per frame     mean ${timing.uiTick.mean} ms   worst ${timing.uiTick.max}`);
console.log('');
console.log('per game month, ms:  ' + timing.monthParts.slice(0, 8).map(([k, v]) => `${k} ${v}`).join('  ·  '));
const at5x = timing.tick.mean * 150 / 60;
console.log('');
console.log(`At 5× and 60fps the sim costs ~${at5x.toFixed(2)} ms of every frame on this machine; budget is 16.7 ms.`);
if (errors.length) console.log('page errors:', errors.slice(0, 3));
await browser.close();
srv.close();
