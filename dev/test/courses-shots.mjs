// Course screens for eyeballing: node dev/test/courses-shots.mjs <outdir> [fontsDir]
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { installFakes, CAP } from './fakenet.mjs';
const root = new URL('../../', import.meta.url).pathname, OUT = process.argv[2], FONTS = process.argv[3];
const server = http.createServer((q, r) => { fs.readFile(path.join(root, q.url.split('?')[0].replace(/\/$/, '/index.html')), (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': 'text/html' }); r.end(d); }); }).listen(8768);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
for (const scheme of ['light', 'dark']) {
  const ctx = await b.newContext({ viewport: { width: 375, height: 760 }, colorScheme: scheme, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await installFakes(ctx, { fontsDir: FONTS });
  await ctx.addInitScript(CAP({}, ''));
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:8768/');
  await p.waitForFunction(() => window.__shelf && !window.__shelf.busy, null, { timeout: 15000 }); await p.waitForTimeout(500);
  const shot = async (n, full) => { await p.waitForTimeout(300); await p.screenshot({ path: `${OUT}/c-${n}-${scheme}.png`, fullPage: !!full }); };
  await p.waitForTimeout(5200); console.log(scheme, JSON.stringify(await p.evaluate(() => window.__shelf.checks().filter((x) => x.ok !== 1))));
  await shot('home');
  await p.locator('.course .cr').first().click(); await p.locator('.course.open').first().scrollIntoViewIfNeeded(); await shot('open');
  await p.locator('[data-act="course-grid"]').first().click(); await shot('grid', true);
  await p.locator('[data-act="course-grid"]').first().click();
  await p.locator('.chd').first().click(); await shot('page'); await shot('pagefull', true);
  await p.locator('[data-act="back"]').click(); await p.waitForTimeout(200);
  await p.locator('.course .cgo').first().click(); await p.waitForTimeout(600); await shot('player');
  await p.evaluate(() => window.__fake.seekTo(600)); await p.waitForTimeout(400); await shot('nextup');
  await p.locator('.sh-top [data-act="close-video"]').click(); await p.waitForTimeout(300);
  await p.locator('.chd').first().click(); await p.locator('[data-act="add-course"]').first().click(); await p.waitForTimeout(600);
  await p.fill('#courseInput', 'surg'); await p.waitForTimeout(200); await shot('add');
  await ctx.close();
}
await b.close(); server.close();
console.log(errs.length ? 'ERRORS: ' + errs.join(' | ') : 'no errors');
