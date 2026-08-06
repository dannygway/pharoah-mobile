import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const file = '/tmp/claude-0/-home-user-AI-Outreach/ac3e3c64-9b62-5fd8-9ba2-4317a47353a5/scratchpad/kemet.html';
const body = readFileSync(file, 'utf8');
const page_html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`;
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const ctx = await b.newContext({ viewport:{width:402,height:874}, deviceScaleFactor:2, isMobile:true, hasTouch:true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
await p.setContent(page_html, { waitUntil: 'load' });
try {
  await p.waitForFunction(() => !!window.kemet?.game, null, { timeout: 40000 });
  console.log('✓ single-file build boots');
} catch (e) { console.log('✗ did not boot:', e.message); }
const info = await p.evaluate(() => {
  const g = window.kemet?.game;
  return g ? { sprites: window.kemet.atlas.sprites.size, cats: document.querySelectorAll('.cat').length,
               mission: g.mission.name, drawn: g.renderer.lastSpriteCount } : null;
});
console.log(JSON.stringify(info));
await p.evaluate(() => window.kemet.ui.closeModal());
await p.waitForTimeout(2500);
await p.screenshot({ path: 'single-check.png', timeout: 120000 });
const real = errs.filter(e => !/sw\.js|ServiceWorker|manifest|favicon|icons\//i.test(e));
console.log(real.length ? 'ERRORS: ' + real.slice(0,5).join(' | ') : '✓ no console errors');
await b.close();
