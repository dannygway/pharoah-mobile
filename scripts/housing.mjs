/**
 * Housing growth test.
 *
 * Drives a block of houses up the ladder by supplying every need directly, then checks
 * the thing that makes Pharaoh's housing what it is: a house grows onto a larger plot
 * by absorbing its neighbours — 2×2 for a residence, 3×3 for a manor, 4×4 for an
 * estate — and a house with no room around it stops and says why.
 *
 * The smoke city never gets rich enough to reach a residence on its own, so this is
 * the only place the mechanic is exercised end to end.
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
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 874, height: 402 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.kemet?.game, null, { timeout: 60000 });
await page.evaluate(() => {
  document.querySelector('.modal')?.classList.add('hidden');
  window.kemet.game.suspended = false;
  window.kemet.game.setSpeed(0);
});

const result = await page.evaluate(() => {
  const { game } = window.kemet;
  const c = game.city;
  const w = game.world;
  c.funds = 1e6;

  // Find open dry ground for a 6×6 block plus a road ring.
  let ox = -1, oy = -1;
  search: for (let y = 6; y < w.size - 20; y++) {
    for (let x = 6; x < w.size - 20; x++) {
      let ok = true;
      for (let dy = -1; dy <= 13 && ok; dy++) {
        for (let dx = -1; dx <= 13 && ok; dx++) {
          const t = w.terrain[w.idx(x + dx, y + dy)];
          if (!(t === 2 || t === 6) || w.building[w.idx(x + dx, y + dy)] >= 0 || w.road[w.idx(x + dx, y + dy)]) ok = false;
        }
      }
      if (ok) { ox = x; oy = y; break search; }
    }
  }
  if (ox < 0) return { error: 'no open ground' };

  // Block A: a 4×4 of lots with a road ring — room to grow all the way.
  for (let i = -1; i <= 4; i++) {
    c.place('road', ox + i, oy - 1); c.place('road', ox + i, oy + 4);
    c.place('road', ox - 1, oy + i); c.place('road', ox + 4, oy + i);
  }
  for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) c.place('house', ox + dx, oy + dy);

  // Block B: one lot boxed in by road on every side — nowhere to grow.
  const bx = ox + 8, by = oy + 8;
  for (let i = -1; i <= 1; i++) {
    c.place('road', bx + i, by - 1); c.place('road', bx + i, by + 1);
    c.place('road', bx - 1, by + i); c.place('road', bx + 1, by + i);
  }
  c.place('house', bx, by);

  const houses = () => c.liveBuildings.map((i) => c.buildings[i]).filter((b) => b && b.house);
  for (const b of houses()) { b.house.people = 6; b.house.level = 1; c.population += 6; }

  // Everything a house could want, every month: every service, three foods, all goods,
  // and the highest desirability on the board.
  const SERVICES = ['water', 'wellWater', 'religionOsiris', 'religionRa', 'religionPtah',
    'religionSeth', 'religionBast', 'school', 'library', 'booth', 'bandstand', 'pavilion',
    'senet', 'apothecary', 'physician', 'dentist', 'mortuary', 'magistrate', 'tax'];
  const supply = () => {
    for (const b of houses()) {
      const h = b.house;
      for (const s of SERVICES) h.services[s] = 99999;
      h.foods.grain = 200; h.foods.lettuce = 200; h.foods.figs = 200;
      for (const g of ['pottery', 'beer', 'linen', 'luxury', 'chests']) h.goods[g] = 200;
      h.health = 100;
      h.people = Math.max(h.people, 1);
    }
    for (let dy = -3; dy < 16; dy++) for (let dx = -3; dx < 16; dx++) {
      if (w.inBounds(ox + dx, oy + dy)) w.desirability[w.idx(ox + dx, oy + dy)] = 100;
    }
  };

  const timeline = [];
  for (let month = 0; month < 40; month++) {
    supply();
    c.evolveHousing();
    const big = houses().filter((b) => b.x >= ox && b.x < ox + 4 && b.y >= oy && b.y < oy + 4)
      .sort((a, b) => b.house.level - a.house.level)[0];
    timeline.push(`${big.house.level}:${big.size}`);
  }

  const blockA = houses().filter((b) => b.x >= ox && b.x < ox + 4 && b.y >= oy && b.y < oy + 4);
  const top = blockA.sort((a, b) => b.house.level - a.house.level)[0];
  const boxed = houses().find((b) => b.x === bx && b.y === by);

  // Every tile of the grown estate must belong to it, and to nothing else.
  let owned = 0;
  for (let dy = 0; dy < top.size; dy++) for (let dx = 0; dx < top.size; dx++) {
    if (w.building[w.idx(top.x + dx, top.y + dy)] === top.id) owned++;
  }

  // And the grown house must survive a save and load with its plot intact.
  const data = JSON.parse(JSON.stringify(game.serialize()));
  game.load(data);
  const after = game.city.buildings[top.id];

  return {
    timeline: timeline.join(' '),
    blockAHouses: blockA.length,
    topLevel: top.house.level, topSize: top.size, owned,
    capacity: c.houseCapacity(top),
    boxedLevel: boxed.house.level, boxedSize: boxed.size, boxedBlocker: boxed.house.blocker,
    afterLoad: after ? { size: after.size, level: after.house?.level } : null,
  };
});

const fail = [];
const note = (s) => console.log(s);
if (result.error) fail.push(result.error);
else {
  note(`  level:size by month  ${result.timeline}`);
  if (result.topLevel !== 20 || result.topSize !== 4) {
    fail.push(`the block should become one 4×4 palatial estate; got level ${result.topLevel} on a ${result.topSize}×${result.topSize} plot`);
  } else note('✓ four by four lots grew into one palatial estate on a 4×4 plot');
  if (result.blockAHouses !== 1) fail.push(`the estate should have absorbed the whole block; ${result.blockAHouses} houses remain`);
  else note('✓ the estate absorbed every house in its block');
  if (result.owned !== 16) fail.push(`the estate owns ${result.owned} of its 16 tiles`);
  else note(`✓ every tile of the plot belongs to it (holds ${result.capacity})`);
  if (result.boxedLevel !== 10 || result.boxedSize !== 1 || !/No room to expand/.test(result.boxedBlocker)) {
    fail.push(`a boxed-in house should stop at level 10 and say why; got level ${result.boxedLevel}, "${result.boxedBlocker}"`);
  } else note('✓ a house boxed in by roads stops at level 10 and says there is no room to expand');
  if (!result.afterLoad || result.afterLoad.size !== 4 || result.afterLoad.level !== 20) {
    fail.push(`the estate did not survive save and load: ${JSON.stringify(result.afterLoad)}`);
  } else note('✓ the estate survives a save and load with its plot intact');
}
if (errors.length) fail.push('page errors: ' + errors.slice(0, 3).join(' | '));

await browser.close();
srv.close();
if (fail.length) {
  console.log('\nFAILED:');
  for (const f of fail) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('\nHousing checks passed.');
