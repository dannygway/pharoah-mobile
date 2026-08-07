import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const ctx = await b.newContext({ viewport:{width:402,height:874}, deviceScaleFactor:2, isMobile:true, hasTouch:true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
await p.goto('file:///home/user/kemet-standalone.html', { waitUntil: 'load' });
try {
  await p.waitForFunction(() => !!window.kemet?.game, null, { timeout: 40000 });
  console.log('✓ boots from a bare file:// with no sibling files');
} catch (e) { console.log('✗ FAILED:', e.message); }
const meta = await p.evaluate(() => ({
  appCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
  title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content,
  iconOk: (document.querySelector('link[rel="apple-touch-icon"]')?.href || '').startsWith('data:image/png;base64,'),
  viewportFit: /viewport-fit=cover/.test(document.querySelector('meta[name=viewport]')?.content || ''),
  sprites: window.kemet?.atlas.sprites.size,
  drawn: window.kemet?.game.renderer.lastSpriteCount,
}));
console.log(JSON.stringify(meta));
const real = errs.filter(e => !/favicon|sw\.js|ServiceWorker|manifest/i.test(e));
console.log(real.length ? 'ERRORS: ' + real.slice(0,3).join(' | ') : '✓ no console errors');
await b.close();
