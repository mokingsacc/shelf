// Screens for eyeballing: phone, light and dark, with the pretend internet and the faked iPhone shell.
// Usage: node dev/test/preview.mjs <outdir> [fontsDir]
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { installFakes, CAP } from './fakenet.mjs';
const root = new URL('../../', import.meta.url).pathname, OUT = process.argv[2], FONTS = process.argv[3];
const server = http.createServer((q, r) => { fs.readFile(path.join(root, q.url.split('?')[0].replace(/\/$/, '/index.html')), (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': q.url.endsWith('.png') ? 'image/png' : 'text/html' }); r.end(d); }); }).listen(8767);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
for (const scheme of ['light', 'dark']) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await installFakes(ctx, { fresh: true, fontsDir: FONTS });
  await ctx.addInitScript(CAP({}, ''));
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8767/'); await p.waitForTimeout(2500);
  await p.evaluate(() => window.__shelf.refreshAll(true)); await p.waitForTimeout(800);
  // a started video and a started episode so Resume and progress show
  await p.evaluate(() => { const v = window.__shelf.videos; const id = Object.keys(v)[0]; });
  const shot = async (n) => { await p.waitForTimeout(350); await p.screenshot({ path: `${OUT}/v2-${n}-${scheme}.png` }); };
  await shot('home');
  await p.screenshot({ path: `${OUT}/v2-homefull-${scheme}.png`, fullPage: true });
  await p.locator('.band .hd').first().click(); await shot('section');
  await p.evaluate(() => document.querySelector('#page').scrollTo(0, 99999)); await shot('section-bottom');
  await p.locator('.chrow').first().click(); await shot('channel');
  await p.locator('#page .item').first().click(); await p.waitForTimeout(600);
  await p.evaluate(() => window.__fake.advance(140));
  await p.locator('#vSeg button[data-m="30"]').click(); await shot('player');
  await p.locator('[data-act="close-video"]').click(); await p.waitForTimeout(400);
  await p.locator('[data-act="back"]').click(); await p.waitForTimeout(200);
  await p.locator('[data-act="back"]').click(); await p.waitForTimeout(300);
  await shot('home-resume');
  await p.locator('.band.c3 li button').first().click(); await p.waitForTimeout(800);
  await p.locator('#nSeg button[data-m="45"]').click(); await shot('night');
  await p.locator('[data-act="close-night"]').click(); await shot('home-mini');
  await p.locator('#searchBtn').click(); await p.fill('#sq', 'hy arrows'); await p.press('#sq', 'Enter'); await p.waitForTimeout(500); await shot('search');
  await p.locator('[data-act="back"]').click(); await p.waitForTimeout(300);
  await p.locator('#statusBtn').click(); await shot('check');
  await ctx.close();
}
await b.close(); server.close();
console.log(errs.length ? 'ERRORS: ' + errs.join(' | ') : 'no errors');
