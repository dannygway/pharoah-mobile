/**
 * Headless smoke test.
 *
 * Serves the production build, drives a real browser through boot, builds a small but
 * complete city programmatically, runs the simulation, and asserts that the things
 * which make this a game actually happen: people arrive, walkers walk, services land,
 * houses evolve, and nothing throws.
 *
 * Run with: npm run build && npm run smoke
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = 4178;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = join(root, p);
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

const fail = [];
const note = (m) => console.log('  ' + m);

await new Promise((r) => server.listen(PORT, r));
console.log(`serving dist on :${PORT}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

// An iPhone-shaped viewport, so the layout is exercised the way it will ship.
const ctx = await browser.newContext({
  viewport: { width: 402, height: 874 },
  // A logic test, not a visual one: 1x keeps software GL fast enough to be useful.
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

// ---------------------------------------------------------------- boot

try {
  await page.waitForFunction(() => !!window.kemet?.game, null, { timeout: 30000 });
  note('✓ booted, atlas built, WebGL2 context alive');
} catch (e) {
  fail.push('game never booted: ' + e.message);
}

const atlasInfo = await page.evaluate(() => ({
  w: window.kemet.atlas.width,
  h: window.kemet.atlas.height,
  sprites: window.kemet.atlas.sprites.size,
}));
note(`  atlas ${atlasInfo.w}×${atlasInfo.h}, ${atlasInfo.sprites} sprites`);
// Terrain and roads moved to the ground pass, which took ~60 tile sprites with them.
if (atlasInfo.sprites < 200) fail.push(`atlas only has ${atlasInfo.sprites} sprites`);

// ------------------------------------------------------- build a city

const built = await page.evaluate(() => {
  const { game, ui } = window.kemet;
  ui.closeModal();
  const c = game.city;
  const w = game.world;
  const FLOODPLAIN = 1;

  // Find a block that is both mostly floodplain and mostly buildable. Scoring only on
  // floodplain picks blocks the river cuts in half, which splits the road grid into
  // disconnected components and stops every cart in the city.
  const WATER = 0, ROCK = 4;
  let ox = -1, oy = -1, bestScore = -1;
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
      if (score > bestScore) { bestScore = score; ox = x; oy = y; }
    }
  }
  if (ox < 0) return { error: 'no usable block found' };

  c.funds = 200000;

  // A fully connected grid with roads every 5 tiles, so each cell is 4x4 — big enough
  // for a granary or a storage yard, which a tighter grid cannot fit at all.
  const BLOCK = 30;
  for (let y = 0; y <= BLOCK; y += 5) for (let x = 0; x <= BLOCK; x++) c.place('road', ox + x, oy + y);
  for (let x = 0; x <= BLOCK; x += 5) for (let y = 0; y <= BLOCK; y++) c.place('road', ox + x, oy + y);

  // Keep only the cells sitting on the largest connected road component. A grid laid
  // over broken ground fragments, and a fragmented network delivers nothing.
  let bestComp = new Set();
  for (let i = 0; i < w.area && bestComp.size < 200; i++) {
    if (!w.road[i] || bestComp.has(i)) continue;
    const comp = new Set();
    w.forEachRoadInComponent(i, (t) => comp.add(t));
    if (comp.size > bestComp.size) bestComp = comp;
  }

  /** Top-left tile of every 4x4 cell whose bordering roads are on the main network. */
  const cells = [];
  for (let cy = 0; cy + 5 <= BLOCK; cy += 5) {
    for (let cx = 0; cx + 5 <= BLOCK; cx += 5) {
      const x = ox + cx + 1;
      const y = oy + cy + 1;
      if (!bestComp.has(w.idx(x - 1, y)) && !bestComp.has(w.idx(x, y - 1))) continue;
      cells.push([x, y]);
    }
  }
  if (cells.length < 8) return { error: `road grid fragmented: only ${cells.length} usable cells` };

  // Plan the district around a centre: services in the middle, housing wrapped around
  // them, so every roamer's route passes real houses. A city laid out any other way is
  // a legitimate thing for a player to build and a bad thing for a test to assert on.
  const mid = cells[Math.floor(cells.length / 2)];
  const byDistance = cells
    .map((cell, k) => ({ cell, k, d: Math.hypot(cell[0] - mid[0], cell[1] - mid[1]) }))
    .sort((a, b) => a.d - b.d);

  // Wells are not in this list: they serve a radius, so they go inside the housing
  // cells rather than in the civic centre where they would reach nobody.
  // Sized to a labour budget this district can actually meet: granary 5, bazaar 5,
  // water 4, temple 6, firehouse 5, and a work camp of 10 whose peasants work the two
  // floodplain farms — which, as in Pharaoh, hire no one themselves. Thirty-five jobs.
  const wanted = [
    'granary', 'bazaar', 'water_supply', 'temple_osiris', 'firehouse', 'work_camp',
  ];
  // Services are interleaved with the cells left for housing rather than massed in
  // the middle. A roamer spends twenty-odd road tiles and turns for home, and cells sit
  // five tiles apart, so a civic centre five cells across has its far side out of reach
  // of its own bazaar. Every second cell keeps housing beside every service.
  const placedSvc = [];
  const usedCells = new Set();
  for (const id of wanted) {
    let placed = false;
    for (let pass = 0; pass < 2 && !placed; pass++) {
      for (let n = 0; n < byDistance.length; n++) {
        // First pass takes alternating cells; second pass takes whatever is left.
        if (pass === 0 && n % 2 === 1) continue;
        const { cell, k } = byDistance[n];
        if (usedCells.has(k)) continue;
        if (c.place(id, cell[0], cell[1]) !== -1) {
          placedSvc.push(id);
          usedCells.add(k);
          placed = true;
          break;
        }
      }
    }
  }

  // A shrine to each of the five, tucked into the corners of the housing cells. They
  // cost sixty deben, need no workers and deliver no service — but a god left neglected
  // for two years acts on it, and Seth's answer is an invasion the district has no army
  // to meet. Four angry gods will wipe a city that is otherwise running perfectly.
  const shrineGods = ['osiris', 'ra', 'ptah', 'seth', 'bast'];

  let farms = 0;
  for (const id of ['farm_grain', 'farm_chickpea']) {
    for (let k = 0; k < cells.length; k++) {
      if (usedCells.has(k)) continue;
      const [x, y] = cells[k];
      if (!w.canPlace(x, y, 3, 'floodplain', false)) continue;
      if (c.place(id, x, y) !== -1) { farms++; usedCells.add(k); break; }
    }
  }

  // Housing goes in the cells nearest the services, and only as many as a starting
  // city could plausibly fill. Marking out far more lots than you have people for is a
  // real mistake, but it is not the mistake this test is meant to make.
  // Housing wraps the bazaar, not the geometric centre of the plan.
  //
  // A seller roams twenty-two road tiles and then turns for home. Cells chosen by
  // distance from the middle of the district put the nearest housing six cells out,
  // which is further than that budget reaches: the bazaar sits on full shelves while
  // every house around it reports no food. That is a real mistake a player makes, and
  // it is exactly what the reachability halo was added to make visible — but it is not
  // the mistake this test is here to make.
  const baz = c.liveBuildings.map((i) => c.buildings[i]).find((b) => b && b.defId === 'bazaar');
  const anchor = baz ? [baz.x, baz.y] : mid;
  const housingCells = cells
    .map((cell, k) => ({ cell, k, d: Math.hypot(cell[0] - anchor[0], cell[1] - anchor[1]) }))
    .filter((e) => !usedCells.has(e.k))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5);

  let houses = 0;
  let wells = 0;
  for (const { cell } of housingCells) {
    const [x, y] = cell;
    // One well per housing cell, in the corner, so its radius covers its own street;
    // and a garden, because packed housing will not rise past a cottage without one.
    if (c.place('well', x + 3, y + 3) !== -1) wells++;
    c.place('garden', x + 3, y + 0);
    const shrine = shrineGods.shift();
    if (!shrine || c.place(`shrine_${shrine}`, x + 0, y + 3) === -1) c.place('garden', x + 0, y + 3);
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        if ((dx === 3 && dy === 3) || (dx === 3 && dy === 0) || (dx === 0 && dy === 3)) continue;
        if (c.place('house', x + dx, y + dy) !== -1) houses++;
      }
    }
  }

  c.markDirty();
  c.recomputeDesirability();
  // The test drives the clock itself (below), so the frame loop must not also run it.
  game.setSpeed(0);

  const hs = c.liveBuildings.map((i) => c.buildings[i]).filter((b) => b.house);
  return {
    ox, oy, houses, farms, services: placedSvc.length,
    buildings: c.liveBuildings.length,
    housesOnRoad: hs.filter((b) => b.hasRoad).length,
    cells: cells.length,
    wells,
    mainNetwork: bestComp.size,
  };
});

if (built.error) fail.push(built.error);
else note(`✓ built ${built.buildings} buildings on a ${built.mainNetwork}-tile road network (${built.houses} houses, ${built.housesOnRoad} road-linked, ${built.farms} farms, ${built.services} services, ${built.wells} wells)`);
if (built.farms < 2) fail.push(`only ${built.farms} farms could be placed — the test city cannot feed itself`);

// -------------------------------------------------------------- simulate

const samples = [];
// Long enough to matter. The housing ladder adds one requirement per level and a
// delivered service goes stale in forty game days, so two game years shows only that
// people arrive; it takes several more before a block settles and climbs.
for (let i = 0; i < 22; i++) {
  // Step the simulation directly: about five weeks per sample. Waiting on the wall
  // clock tied the test's reach to how fast this machine can render, which under
  // software GL is not very.
  await page.evaluate(() => {
    const { game } = window.kemet;
    for (let t = 0; t < 420; t++) { game.city.step(); game.systems.step(); }
  });
  await page.waitForTimeout(150);
  const s = await page.evaluate(() => {
    const c = window.kemet.game.city;
    let evolved = 0, serviced = 0, maxLevel = 0, food = 0;
    const blockers = {};
    for (const id of c.liveBuildings) {
      const b = c.buildings[id];
      if (!b?.house) continue;
      if (b.house.level > 1) evolved++;
      maxLevel = Math.max(maxLevel, b.house.level);
      if (Object.keys(b.house.services).length) serviced++;
      for (const k of Object.keys(b.house.foods)) food += b.house.foods[k];
      if (b.house.people > 0 && b.house.blocker) {
        blockers[b.house.blocker] = (blockers[b.house.blocker] ?? 0) + 1;
      }
    }
    const topBlocker = Object.entries(blockers).sort((a, b) => b[1] - a[1])[0];
    return {
      year: c.year, month: c.month, season: c.season,
      pop: c.population, walkers: c.walkers.count,
      funds: Math.round(c.funds), flood: +c.floodLevel.toFixed(2),
      evolved, serviced, maxLevel, food: Math.round(food),
      fps: +window.kemet.game.scene.fps.toFixed(0),
      sprites: window.kemet.game.renderer.lastSpriteCount,
      blocker: topBlocker ? `${topBlocker[1]}× ${topBlocker[0]}` : '',
      problems: window.kemet.game.systems.cityProblems(40).length,
    };
  });
  samples.push(s);
  note(`  yr ${s.year + 1} ${s.season}\tpop ${String(s.pop).padStart(4)}\twalkers ${String(s.walkers).padStart(3)}\tserviced ${s.serviced}\tevolved ${s.evolved} (max L${s.maxLevel})\tfood ${s.food}\t${s.fps}fps\t${s.problems} faults\t${s.blocker}`);
}

const last = samples[samples.length - 1];
// Assert on peaks, not on one snapshot. A city sampled in the middle of the
// inundation legitimately has an empty granary and houses sliding back down the
// ladder — that is the flood cycle working, not a broken chain.
const peak = (k) => Math.max(...samples.map((s) => s[k]));

// ------------------------------------------------------------- assertions

if (peak('pop') <= 0) fail.push('nobody ever moved in — immigration is broken');
else note(`✓ population reached ${peak('pop')} (${last.pop} at the end of the run)`);

if (peak('walkers') <= 0) fail.push('no walkers were ever spawned');
else note(`✓ up to ${peak('walkers')} walkers active at once`);

if (peak('serviced') < 15) fail.push(`only ${peak('serviced')} houses received any service — the walker service model is not reaching the district`);
else note(`✓ ${peak('serviced')} houses receiving services`);

// When the ladder stalls, say what stalled it. A bare "never got past level 2" sends
// the next reader hunting through the simulation for a bug that may not be there.
const ladder = await page.evaluate(() => {
  const c = window.kemet.game.city;
  const byLevel = {};
  for (const id of c.liveBuildings) {
    const b = c.buildings[id];
    if (!b?.house || b.house.people === 0) continue;
    const k = b.house.level;
    byLevel[k] = byLevel[k] ?? { n: 0, blockers: {} };
    byLevel[k].n++;
    const bl = b.house.blocker || '(none)';
    byLevel[k].blockers[bl] = (byLevel[k].blockers[bl] ?? 0) + 1;
  }
  return byLevel;
});
// The food chain, building by building. When houses report no food the question is
// always which link is empty: the farm, the granary, or the bazaar.
const chain = await page.evaluate(() => {
  const c = window.kemet.game.city;
  const out = [];
  for (const id of c.liveBuildings) {
    const b = c.buildings[id];
    if (!b) continue;
    const def = c.def(b);
    if (!['granary', 'bazaar', 'storage_yard'].includes(def.id) && def.cat !== 'food') continue;
    const stock = Object.entries(b.store).filter(([, v]) => v > 0.5)
      .map(([g, v]) => `${g} ${Math.floor(v)}`).join(', ') || 'empty';
    out.push(`${def.id} road=${b.hasRoad} staff=${b.workers}/${def.workers} ${stock}`);
  }
  return out;
});
for (const line of chain) note(`    chain ${line}`);

const topFaults = await page.evaluate(() => window.kemet.game.systems.cityProblems(40)
  .slice(0, 6).map((p) => `${p.severity} ${p.title}: ${p.cause}`));
for (const f of topFaults) note(`    fault ${f}`);
for (const [lvl, d] of Object.entries(ladder).sort((a, b) => b[0] - a[0])) {
  const top = Object.entries(d.blockers).sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([k, n]) => `${n}× ${k}`).join(' | ');
  note(`    L${lvl}: ${d.n} houses — ${top}`);
}

if (peak('maxLevel') < 3) fail.push(`housing never evolved past level ${peak('maxLevel')}`);
else note(`✓ housing evolved to level ${peak('maxLevel')}`);

if (peak('food') <= 0) fail.push('no food ever reached a house — the distribution chain is broken');
else note(`✓ up to ${peak('food')} units of food held in houses at once`);

if (samples.some((s) => s.flood > 0.05)) note('✓ the Nile flooded');
else note('  (no flood observed in this window — expected only if the run spanned Akhet)');

// The ground is a per-pixel shader, which software GL runs on the CPU, so this number
// says almost nothing about a phone. It is kept only as a floor that catches a render
// loop that has stalled outright.
if (peak('fps') < 5) fail.push(`render loop is stalled: ${last.fps} fps`);
else note(`✓ ${peak('fps')} fps under software rendering`);

// ------------------------------------------------------- save / load

const saveOk = await page.evaluate(() => {
  const { game } = window.kemet;
  const before = { pop: game.city.population, buildings: game.city.liveBuildings.length, tick: game.city.tick };
  const data = game.serialize();
  const ok = game.load(JSON.parse(JSON.stringify(data)));
  const after = { pop: game.city.population, buildings: game.city.liveBuildings.length, tick: game.city.tick };
  return { ok, before, after };
});
if (!saveOk.ok) fail.push('save/load round-trip failed');
else if (saveOk.before.buildings !== saveOk.after.buildings) {
  fail.push(`save/load lost buildings: ${saveOk.before.buildings} -> ${saveOk.after.buildings}`);
} else {
  note(`✓ save/load round-trip preserved ${saveOk.after.buildings} buildings and ${saveOk.after.pop} people`);
}

// ------------------------------------------------------------- UI checks

const uiOk = await page.evaluate(() => {
  const q = (s) => !!document.querySelector(s);
  const { ui, game } = window.kemet;
  // Exercise the panels that exist only as code until something opens them.
  ui.openSheet('advisors');
  const chiefRendered = !!document.querySelector('.chief-mood');
  // The reachability halo, over whichever building sends a walker out.
  const svc = game.city.liveBuildings.map((i) => game.city.buildings[i])
    .find((b) => b && game.city.def(b).walkerRange);
  const haloOk = svc ? game.scene.setHalo(game.city, game.systems, svc.id) : false;
  const haloTiles = game.scene.halo ? game.scene.halo.roads.size : 0;
  const haloServed = game.scene.halo ? game.scene.halo.served.size : 0;
  // Storage orders: the hardest screen in the game to translate to touch.
  const yard = game.city.liveBuildings.map((i) => game.city.buildings[i])
    .find((b) => b && game.city.def(b).storage);
  if (yard) ui.openOrders(yard.id);
  const orderRows = document.querySelectorAll('.order-row').length;
  const segButtons = document.querySelectorAll('.seg .sg').length;
  ui.closeSheet();
  return {
    topBar: q('.top-bar'), bottomBar: q('.bottom-bar'),
    cats: document.querySelectorAll('.cat').length,
    strips: document.querySelectorAll('.strip').length,
    chiefRendered, haloOk, haloTiles, haloServed, orderRows, segButtons,
    problems: game.systems.cityProblems(40).length,
  };
});
if (!uiOk.topBar || !uiOk.bottomBar || uiOk.cats < 5) fail.push('UI chrome did not render: ' + JSON.stringify(uiOk));
else note(`✓ UI rendered with ${uiOk.cats} build categories`);

if (uiOk.strips < 3) fail.push(`status strip missing readings: ${uiOk.strips} of 3`);
else note('✓ Nilometer, sentiment and fault count on the status strip');

if (!uiOk.chiefRendered) fail.push('the chief advisor did not render');
else note(`✓ chief advisor ranks ${uiOk.problems} faults, each one tap from its location`);

if (!uiOk.haloOk || uiOk.haloTiles < 2) fail.push(`reachability halo covered only ${uiOk.haloTiles} road tiles`);
else note(`✓ reachability halo: ${uiOk.haloTiles} road tiles reachable, ${uiOk.haloServed} house tiles served`);

if (uiOk.orderRows < 5 || uiOk.segButtons < uiOk.orderRows * 3) {
  fail.push(`storage orders rendered ${uiOk.orderRows} rows with ${uiOk.segButtons} controls`);
} else {
  note(`✓ storage orders: ${uiOk.orderRows} goods, Reject/Accept/Get on each`);
}

// Exercise the sheets so their render paths are covered.
const panels = await page.evaluate(async () => {
  const { ui } = window.kemet;
  const errs = [];
  for (const fn of ['overlays', 'advisors', 'messages']) {
    try { ui.openSheet ? ui.openSheet(fn) : ui['openSheet'](fn); } catch (e) { errs.push(fn + ': ' + e.message); }
  }
  return errs;
});

// Drive a real touch gesture so the input layer is exercised end to end.
await page.touchscreen.tap(200, 400);
await page.waitForTimeout(300);

// Frame the actual city for the screenshot rather than whichever panel was last open.
await page.evaluate(() => {
  const { game, ui } = window.kemet;
  ui.closeSheet();
  const c = game.city;
  let sx = 0, sy = 0, n = 0;
  for (const id of c.liveBuildings) {
    const b = c.buildings[id];
    if (!b?.house || b.house.people === 0) continue;
    sx += b.x; sy += b.y; n++;
  }
  if (n) game.scene.camera.centreOnTile(sx / n, sy / n);
  game.scene.camera.tzoom = 1.5;
  game.scene.camera.zoom = 1.5;
});
await page.waitForTimeout(1500);

await page.screenshot({ path: 'smoke-city.png', timeout: 120000 });
note('✓ screenshot written to smoke-city.png');

// --------------------------------------------------------------- report

const realErrors = consoleErrors.filter((e) =>
  !/favicon|sw\.js|ServiceWorker|manifest/i.test(e));
if (realErrors.length) {
  fail.push(`${realErrors.length} console errors`);
  for (const e of realErrors.slice(0, 8)) note('  ! ' + e.slice(0, 200));
}

await browser.close();
server.close();

console.log('');
if (fail.length) {
  console.error('FAILED:');
  for (const f of fail) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('All smoke checks passed.');
