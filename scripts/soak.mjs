/**
 * Soak test: run a city hard for a long time and report anything that looks wrong.
 *
 * The smoke test asks "does the chain work". This asks "does anything break, drift or
 * spiral if you leave it running" — which is where a simulation like this actually
 * fails, and which will not show up in a two-minute session.
 *
 * It asserts nothing about how well the city does. It watches for states that should
 * never occur at all: NaN, negative counts, walker leaks, orphaned buildings, save/load
 * divergence, unbounded arrays, and a punishment cadence that outpaces the player.
 */

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const srv = createServer((req, res) => {
  let p = join(root, decodeURIComponent(req.url.split('?')[0]));
  if (p.endsWith('/')) p = join(p, 'index.html');
  if (!existsSync(p)) p = join(root, 'index.html');
  res.setHeader('content-type', MIME[extname(p)] ?? 'application/octet-stream');
  res.end(readFileSync(p));
});
await new Promise((r) => srv.listen(4180, r));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 1 });

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto('http://localhost:4180/', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.kemet?.game, null, { timeout: 60000 });
await page.evaluate(() => {
  document.querySelector('.modal')?.classList.add('hidden');
  window.kemet.game.suspended = false;
});

// Build the same district the smoke test does, then leave it alone.
const setup = await page.evaluate(() => {
  const { game } = window.kemet;
  const c = game.city;
  const w = game.world;
  const FLOODPLAIN = 1, WATER = 0, ROCK = 4;
  let ox = -1, oy = -1, best = -1;
  for (let y = 4; y < w.size - 34; y += 2) {
    for (let x = 4; x < w.size - 34; x += 2) {
      let fp = 0, blocked = 0;
      for (let dy = 0; dy < 31; dy += 2) {
        for (let dx = 0; dx < 31; dx += 2) {
          const t = w.terrain[w.idx(x + dx, y + dy)];
          if (t === FLOODPLAIN) fp++;
          if (t === WATER || t === ROCK) blocked++;
        }
      }
      const score = fp - blocked * 6;
      if (score > best) { best = score; ox = x; oy = y; }
    }
  }
  c.funds = 200000;
  const BLOCK = 30;
  for (let y = 0; y <= BLOCK; y += 5) for (let x = 0; x <= BLOCK; x++) c.place('road', ox + x, oy + y);
  for (let x = 0; x <= BLOCK; x += 5) for (let y = 0; y <= BLOCK; y++) c.place('road', ox + x, oy + y);

  const cells = [];
  for (let cy = 0; cy + 5 <= BLOCK; cy += 5) {
    for (let cx = 0; cx + 5 <= BLOCK; cx += 5) cells.push([ox + cx + 1, oy + cy + 1]);
  }
  const used = new Set();
  const mid = cells[Math.floor(cells.length / 2)];
  const byD = cells.map((cell, k) => ({ cell, k, d: Math.hypot(cell[0] - mid[0], cell[1] - mid[1]) }))
    .sort((a, b) => a.d - b.d);
  for (const id of ['granary', 'bazaar', 'water_supply', 'temple_osiris', 'firehouse', 'architect_post', 'work_camp']) {
    for (let n = 0; n < byD.length; n += 2) {
      const { cell, k } = byD[n];
      if (used.has(k)) continue;
      if (c.place(id, cell[0], cell[1]) !== -1) { used.add(k); break; }
    }
  }
  for (const id of ['farm_grain', 'farm_chickpea']) {
    for (let k = 0; k < cells.length; k++) {
      if (used.has(k)) continue;
      const [x, y] = cells[k];
      if (!w.canPlace(x, y, 3, 'floodplain', false)) continue;
      if (c.place(id, x, y) !== -1) { used.add(k); break; }
    }
  }
  const baz = c.liveBuildings.map((i) => c.buildings[i]).find((b) => b && b.defId === 'bazaar');
  const anchor = baz ? [baz.x, baz.y] : mid;
  const gods = ['osiris', 'ra', 'ptah', 'seth', 'bast'];
  const housing = cells.map((cell, k) => ({ cell, k, d: Math.hypot(cell[0] - anchor[0], cell[1] - anchor[1]) }))
    .filter((e) => !used.has(e.k)).sort((a, b) => a.d - b.d).slice(0, 5);
  for (const { cell } of housing) {
    const [x, y] = cell;
    c.place('well', x + 3, y + 3);
    c.place('garden', x + 3, y + 0);
    const g = gods.shift();
    if (!g || c.place(`shrine_${g}`, x + 0, y + 3) === -1) c.place('garden', x + 0, y + 3);
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        if ((dx === 3 && dy === 3) || (dx === 3 && dy === 0) || (dx === 0 && dy === 3)) continue;
        c.place('house', x + dx, y + dy);
      }
    }
  }
  c.markDirty();
  c.recomputeDesirability();
  game.setSpeed(4);
  return { buildings: c.liveBuildings.length };
});

console.log(`soak: ${setup.buildings} buildings, running…\n`);

const SAMPLES = Number(process.argv[2] ?? 40);
const MONTHS_PER_SAMPLE = Number(process.argv[3] ?? 6);
const anomalies = [];
const seenMessages = new Map();
let peakWalkers = 0;
let prev = null;
let lastMessageId = 0;

for (let i = 0; i < SAMPLES; i++) {
  // Step the simulation directly rather than waiting on the clock. Wall-clock soaking
  // at 5x covers about a game year a minute, which is nowhere near long enough to see
  // the drift this test is looking for.
  await page.evaluate((months) => {
    const { game } = window.kemet;
    const ticks = months * 360;
    for (let t = 0; t < ticks; t++) {
      game.city.step();
      game.systems.step();
    }
  }, MONTHS_PER_SAMPLE);
  const s = await page.evaluate((lastMessageId) => {
    const { game } = window.kemet;
    const c = game.city;
    const bad = [];
    const finite = (v, name) => { if (!Number.isFinite(v)) bad.push(`${name} is ${v}`); };

    finite(c.funds, 'funds');
    finite(c.population, 'population');
    finite(c.floodLevel, 'floodLevel');
    finite(c.sentiment, 'sentiment');
    for (const k of Object.keys(c.ratings)) finite(c.ratings[k], `ratings.${k}`);
    if (c.population < 0) bad.push(`population is negative: ${c.population}`);
    if (c.floodLevel < 0 || c.floodLevel > 1.001) bad.push(`floodLevel out of range: ${c.floodLevel}`);
    if (c.sentiment < -0.01 || c.sentiment > 100.01) bad.push(`sentiment out of range: ${c.sentiment}`);

    // Every live building must own its tiles, and every tile must point at a live one.
    let orphanTiles = 0, badFootprint = 0, negStore = 0, popMismatch = 0;
    let housed = 0;
    for (const id of c.liveBuildings) {
      const b = c.buildings[id];
      if (!b) { badFootprint++; continue; }
      if (c.world.building[c.world.idx(b.x, b.y)] !== id) badFootprint++;
      for (const [g, v] of Object.entries(b.store)) {
        if (v < -0.001 || !Number.isFinite(v)) negStore++;
      }
      if (b.house) {
        housed += b.house.people;
        if (b.house.people < 0) popMismatch++;
        if (b.house.level < 0 || b.house.level > 20) popMismatch++;
      }
      if (b.workers < 0 || b.workers > c.def(b).workers + 0.01) bad.push(`${b.defId} has ${b.workers} workers`);
    }
    for (let t = 0; t < c.world.area; t++) {
      const id = c.world.building[t];
      if (id >= 0 && !c.buildings[id]) orphanTiles++;
    }
    if (orphanTiles) bad.push(`${orphanTiles} tiles point at a demolished building`);
    if (badFootprint) bad.push(`${badFootprint} buildings do not own their own tile`);
    if (negStore) bad.push(`${negStore} negative or non-finite stock entries`);
    if (popMismatch) bad.push(`${popMismatch} houses with impossible state`);
    if (Math.abs(housed - c.population) > 0.5) {
      bad.push(`population ${c.population} but houses hold ${housed}`);
    }

    // Walker hygiene: no orphans, no stuck walkers, no leak.
    let orphanWalkers = 0, ancient = 0;
    for (const id of c.walkers.live) {
      const wk = c.walkers.get(id);
      if (!wk) { orphanWalkers++; continue; }
      if (wk.home >= 0 && !c.buildings[wk.home]) orphanWalkers++;
      if (wk.age > wk.maxAge * 3) ancient++;
      if (!Number.isFinite(wk.px) || !Number.isFinite(wk.py)) bad.push('walker at a non-finite position');
    }
    if (orphanWalkers) bad.push(`${orphanWalkers} walkers from buildings that no longer exist`);
    if (ancient) bad.push(`${ancient} walkers far past their lifetime`);

    return {
      year: c.year, season: c.season, pop: c.population, funds: Math.round(c.funds),
      walkers: c.walkers.count, buildings: c.liveBuildings.length,
      sentiment: Math.round(c.sentiment), messages: c.messages.length,
      gods: Object.fromEntries(Object.entries(c.godMood).map(([k, v]) => [k, Math.round(v)])),
      recent: c.messages.filter((m) => m.kind === 'bad' && m.id > lastMessageId)
        .map((m) => ({ id: m.id, title: m.title })),
      newestMessageId: c.messages[0]?.id ?? lastMessageId,
      safety: (() => {
        const fh = c.liveBuildings.map((i) => c.buildings[i])
          .filter((b) => b && (b.defId === 'firehouse' || b.defId === 'architect_post'));
        let maxFire = 0, atRisk = 0, covered = 0, total = 0;
        for (const id of c.liveBuildings) {
          const b = c.buildings[id];
          if (!b) continue;
          total++;
          maxFire = Math.max(maxFire, b.fire);
          if (b.fire > 70) atRisk++;
          if (b.fire < 30) covered++;
        }
        return `fh ${fh.map((b) => `${b.defId[0]}${b.workers}/${c.def(b).workers}`).join(',') || 'none'}` +
          ` maxFire ${Math.round(maxFire)} atRisk ${atRisk}/${total} cool ${covered}`;
      })(),
      fps: +game.scene.fps.toFixed(0),
      heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0,
      bad,
    };
  }, lastMessageId);
  lastMessageId = s.newestMessageId;

  peakWalkers = Math.max(peakWalkers, s.walkers);
  for (const b of s.bad) anomalies.push(`yr ${s.year + 1}: ${b}`);
  for (const m of s.recent) seenMessages.set(m.title, (seenMessages.get(m.title) ?? 0) + 1);

  if (i % 5 === 0 || s.bad.length) {
    const gods = Object.entries(s.gods).map(([g, v]) => `${g[0]}${v}`).join(' ');
    console.log(
      `  yr ${String(s.year + 1).padStart(2)} ${s.season}\tpop ${String(s.pop).padStart(4)}` +
      `\t${String(s.funds).padStart(7)}d\tbld ${s.buildings}\twlk ${s.walkers}` +
      `\tmood ${s.sentiment}\t${gods}\t${s.fps}fps\n      ${s.safety}` +
      (s.bad.length ? `\n      ⚠ ${s.bad.join('; ')}` : ''));
  }
  prev = s;
}

// Save/load must be exact, not approximate.
const roundTrip = await page.evaluate(() => {
  const { game } = window.kemet;
  const snap = () => ({
    pop: game.city.population, funds: Math.round(game.city.funds),
    buildings: game.city.liveBuildings.length, tick: game.city.tick,
    gods: JSON.stringify(game.city.godMood),
  });
  const before = snap();
  const ok = game.load(JSON.parse(JSON.stringify(game.serialize())));
  return { ok, before, after: snap() };
});
for (const k of Object.keys(roundTrip.before)) {
  if (roundTrip.before[k] !== roundTrip.after[k]) {
    anomalies.push(`save/load changed ${k}: ${roundTrip.before[k]} -> ${roundTrip.after[k]}`);
  }
}

console.log(`\nfinal: year ${prev.year + 1}, pop ${prev.pop}, ${prev.buildings} buildings, ${prev.messages} messages kept`);
console.log(`peak walkers: ${peakWalkers}`);
console.log('\nbad news received, by kind (the log is capped, so these are lower bounds):');
for (const [t, n] of [...seenMessages].sort((a, b) => b[1] - a[1])) console.log(`  ${n}×  ${t}`);

if (consoleErrors.length) {
  console.log('\nconsole errors:');
  for (const e of [...new Set(consoleErrors)].slice(0, 10)) console.log(`  ${e}`);
}

console.log('');
if (anomalies.length) {
  console.log(`FOUND ${anomalies.length} ANOMALIES:`);
  for (const a of [...new Set(anomalies)]) console.log(`  ✗ ${a}`);
} else {
  console.log('No anomalies. State stayed consistent for the whole run.');
}

await browser.close();
srv.close();
process.exit(anomalies.length || consoleErrors.length ? 1 : 0);
