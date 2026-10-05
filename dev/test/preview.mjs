// Screens for eyeballing, plus the v3 layout checks: both phone sizes, light and dark, pretend internet, faked iPhone shell.
// Usage: node dev/test/preview.mjs <outdir> [fontsDir]
// Checks on every screen: no sideways scroll, every button and link at least 44×44, headings not clipped.
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { installFakes, CAP } from './fakenet.mjs';
const root = new URL('../../', import.meta.url).pathname, OUT = process.argv[2], FONTS = process.argv[3];
const server = http.createServer((q, r) => { fs.readFile(path.join(root, q.url.split('?')[0].replace(/\/$/, '/index.html')), (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': q.url.endsWith('.png') ? 'image/png' : 'text/html' }); r.end(d); }); }).listen(8767);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const errs = [], problems = [];
// Everything tappable, at least 44×44 (text links inside the self-check sentences are the one exception)
const audit = (p, where) => p.evaluate((where) => {
  const out = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(where + ': sideways scroll ' + document.documentElement.scrollWidth);
  document.querySelectorAll('button, a, [data-act], summary').forEach((el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || el.closest('[hidden], [inert], .sheet:not(.open), dialog:not([open])')) return;
    if (el.closest('.cnote') || el.closest('.prob span') && el.tagName === 'A') return;
    if (r.width < 43.5 || r.height < 43.5) out.push(where + ': small target ' + Math.round(r.width) + '×' + Math.round(r.height) + ' ' + (el.id ? '#' + el.id : el.className || el.tagName) + ' "' + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30) + '"');
  });
  document.querySelectorAll('.band .hd h2, .top h1').forEach((h) => { if (h.closest('[hidden]')) return; if (h.scrollWidth > h.clientWidth + 1 && !h.classList.contains('wrap')) out.push(where + ': clipped heading ' + h.textContent); });
  const nb = document.querySelector('.now b'); if (nb && !document.querySelector('#cont').hidden) { const lh = parseFloat(getComputedStyle(nb).lineHeight); if (nb.getBoundingClientRect().height > lh * 2 + 1) out.push(where + ': Continue title over 2 lines'); }
  return out;
}, where);
for (const [w, h] of [[390, 844], [375, 667], [820, 1180], [1180, 820]]) for (const scheme of ['light', 'dark']) {
  const tag = `${w}-${scheme}`;
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await installFakes(ctx, { fresh: true, fontsDir: FONTS });
  await ctx.addInitScript('window.__hour = 14.13;');
  await ctx.addInitScript(CAP({}, ''));
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8767/'); await p.waitForTimeout(2500);
  await p.evaluate(() => window.__shelf.refreshAll(true)); await p.waitForTimeout(800);
  const shot = async (n) => { await p.waitForTimeout(350); await p.screenshot({ path: `${OUT}/v3-${n}-${tag}.png` }); problems.push(...await audit(p, n + ' ' + tag)); };
  // a half-watched lecture so Continue shows
  await p.evaluate(() => window.__shelf.handleText('https://youtu.be/dQw4w9WgXcQ')); await p.waitForTimeout(500);
  await p.evaluate(() => window.__fake.advance(140)); await p.waitForTimeout(5400);
  await p.locator('#vRate [data-r="1.5"]').click(); await shot('player-folded'); await p.locator('#vTmBtn').click(); await p.locator('#vSeg [data-m="30"]').click(); await p.waitForTimeout(1100);
  await shot('player');
  await p.locator('[data-act="close-video"]').click(); await p.waitForTimeout(400);
  await shot('home');
  await p.screenshot({ path: `${OUT}/v3-homefull-${tag}.png`, fullPage: true });
  await p.locator('.band .hd .tg').first().click(); await shot('home-open');
  await p.locator('.band .hd .tm').first().click(); await shot('section');
  await p.evaluate(() => document.querySelector('#page').scrollTo(0, 99999)); await shot('section-bottom');
  await p.locator('#page details.fold summary', { hasText: 'Channels' }).click(); await shot('section-channels');
  await p.locator('.chrow').first().click(); await shot('channel');
  await p.locator('[data-act="channel-menu"]').click(); await shot('channel-menu');
  await p.keyboard.press('Escape');
  await p.locator('#coursesBtn').click(); await shot('courses');
  await p.locator('.course .cr').first().click(); await shot('courses-open');
  await p.locator('[data-act="open-pace"]').click(); await shot('pace'); await p.locator('#paceBody .goal').click(); await shot('goal'); await p.keyboard.press('Escape');
  await p.locator('.course [data-act="course-place"]').first().click().catch(() => {}); await shot('courses-place');
  await p.locator('#searchBtn').click(); await p.fill('#sq', 'hy arrows'); await p.press('#sq', 'Enter'); await p.waitForTimeout(500); await shot('search');
  await p.locator('#todayBtn').click(); await p.waitForTimeout(300);
  await p.locator('.band.c3 .hd .tm').click(); await p.locator('#page .item').first().click(); await p.waitForTimeout(800);
  await p.locator('#nSeg button[data-m="45"]').click(); await shot('night');
  await p.locator('[data-act="close-night"]').click(); await shot('home-mini');
  await p.locator('#todayBtn').click(); await p.locator('[data-act="paste-url"]').first().click(); await shot('url'); await p.keyboard.press('Escape');
  await p.locator('#statusBtn').click(); await shot('check');
  await p.keyboard.press('Escape');
  
  const dark = await p.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('.band.c1')).backgroundColor]);
  if (scheme === 'dark' && (dark[0] !== 'rgb(10, 10, 14)' || dark[1] !== 'rgb(29, 27, 8)')) problems.push(tag + ': dark colours ' + dark.join(' '));
  await ctx.close();
}
// Night at 23:12: Sleep first, Bedtime card, a 45-minute timer
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await installFakes(ctx, { fresh: false, fontsDir: FONTS });
  await ctx.addInitScript('window.__hour = 23.2;');
  await ctx.addInitScript(CAP({}, ''));
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8767/'); await p.waitForTimeout(2500);
  await p.locator('.band.c3 .hd .tm').click(); await p.locator('#page .item', { hasText: 'Rome' }).click(); await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/v3-night-auto.png` });
  await p.locator('[data-act="close-night"]').click(); await p.evaluate(() => document.querySelector('#audio').pause()); await p.waitForTimeout(400);
  await p.evaluate(() => { window.__shelf.engine.capture(true); }); await p.waitForTimeout(200);
  await p.locator('#todayBtn').click(); await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/v3-home-night.png` });
  problems.push(...await audit(p, 'home-night'));
  await ctx.close();
}
await b.close(); server.close();
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'layout checks passed');
console.log(errs.length ? 'ERRORS: ' + errs.join(' | ') : 'no errors');
