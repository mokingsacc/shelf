// End-to-end run of the v2 "done" test (done-test.md) in Chromium, with the iPhone shell and the internet faked.
// Usage: node dev/test/e2e.mjs
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { installFakes, CAP, CHANNELS } from './fakenet.mjs';

const root = new URL('../../', import.meta.url).pathname;
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(d); });
}).listen(8765);
const URL0 = 'http://localhost:8765/';
const SHOTS = '/tmp/claude-0/-home-claude/37d1ef24-0e4b-56e8-ae27-d473dfebb3f7/scratchpad';

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) failures++; };
const errors = [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function appPage({ prefs = {}, clip = '', fakes = {}, ctxOpts = {} } = {}) {
  const ctx = await browser.newContext({ ...phone, ...ctxOpts });
  await installFakes(ctx, fakes);
  await ctx.addInitScript(CAP(prefs, clip));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  await p.goto(URL0);
  return { ctx, p };
}
const settle = (p) => p.waitForFunction(() => window.__shelf && !window.__shelf.busy, null, { timeout: 10000 }).then(() => p.waitForTimeout(150)).catch(() => {});
const shelf = (p, fn) => p.evaluate(fn);

console.log('\n== 1 Open');
let { ctx, p } = await appPage({ fakes: { fresh: true } });
await settle(p);
const names = await p.locator('.band .hd h2').allTextContents();
ok(names.join(',') === 'Medicine,Entertainment,Sleep', '1 sections in day order: ' + names.join(', '));
ok(await shelf(p, () => window.__shelf.lib.sources().length) === 6, '1 all six of Mo\'s channels found on first run');
await p.waitForFunction(() => document.querySelector('#statusDot').classList.contains('good'), null, { timeout: 6000 }).catch(() => {});
ok(await p.locator('#statusDot.good').count() === 1 && (await p.locator('#statusText').textContent()) === 'All good', '1 corner says All good');
ok(await p.locator('.band .nw').count() === 0, '1 nothing marked new on the very first run');
const calls = await shelf(p, () => window.__httpCalls);
ok(calls.some((c) => /youtube\.com\/@/.test(c.url) && /SOCS=/.test(c.headers.Cookie) && /Safari/.test(c.headers['User-Agent'])), '1 channel pages are read natively, with the consent cookie and a Safari identity');

console.log('\n== 2 New uploads');
await shelf(p, () => window.__shelf.refreshAll(true)); await settle(p);
ok(await p.locator('.band.c1 .nw').count() === 2, '2 Medicine shows 2 NEW uploads');
ok((await p.locator('.band.c1 .tm').textContent()).includes('2 new'), '2 Medicine header says 2 new');
ok(/6 new/.test(await p.locator('#summary').textContent()), '2 date line counts new uploads: ' + await p.locator('#summary').textContent());
await p.locator('.band.c1 .hd').click();
ok(await p.locator('#page .top h1').textContent() === 'Medicine' && await p.locator('#page .chrow').count() === 2, '2 Medicine page lists its 2 channels');
await p.locator('#page .chrow', { hasText: 'Dirty Medicine' }).click();
ok(await p.locator('#page .item').count() === 3 && await p.locator('#page .item .nw').count() === 1, '2 channel shows its latest videos with the new one marked (' + await p.locator('#page .item').count() + ' items, ' + await p.locator('#page .item .nw').count() + ' new)');
ok(!(await p.content()).toLowerCase().includes('recommended'), '2 no recommendations anywhere');
await p.locator('[data-act="back"]').click(); await p.waitForTimeout(150);
await p.locator('[data-act="back"]').click(); await p.waitForTimeout(150);
ok(await p.locator('.band.c1 .nw').count() === 1, '2 opening the channel clears its new mark');
const savedPrefs = await shelf(p, () => window.__prefs);
ok(!!savedPrefs['shelf.v2.library'], '2 channel list saved on the phone');

console.log('\n== 3 Paste');
await p.evaluate(() => { window.__clip = 'https://youtu.be/dQw4w9WgXcQ?si=xyz'; });
await p.locator('#pasteBtn').click(); await p.waitForTimeout(500);
ok(await p.locator('#vsheet.open').count() === 1 && await shelf(p, () => window.__shelf.current) === 'dQw4w9WgXcQ', '3 Paste plays the copied video');
ok(await shelf(p, () => window.__fake.getPlayerState()) === 1, '3 it is playing');

console.log('\n== 4 Resume');
await p.evaluate(() => window.__fake.advance(60));
await p.waitForTimeout(5400);
const t = await shelf(p, () => window.__shelf.videos.dQw4w9WgXcQ.t);
ok(t > 55 && t < 80, '4 spot saved around 1:00 (got ' + t.toFixed(1) + ')');
await p.waitForTimeout(400);
const prefs4 = await shelf(p, () => window.__prefs);
await ctx.close();
({ ctx, p } = await appPage({ prefs: prefs4 })); // web storage gone, phone storage kept: like a fresh launch
await p.waitForTimeout(1200);
ok(await p.locator('#cont').isVisible() && /1:\d\d/.test(await p.locator('#contMeta').textContent()), '4 Resume strip shows it at ' + await p.locator('#contMeta').textContent());
await p.locator('#cont').click(); await p.waitForTimeout(400);
const start = await shelf(p, () => window.__lastStart);
ok(Math.abs(start - (t - 3)) < 2, '4 one tap carries on from the saved spot (start ' + start + ')');

console.log('\n== 5 Sleep timer (video)');
await p.locator('#vSeg [data-m="15"]').click();
ok(/14:5\d|15:00/.test(await p.locator('#vCd').textContent()) && (await p.locator('#vStops').textContent()).startsWith('stops at'), '5 countdown shows: ' + (await p.locator('#vCd').textContent()).replace('remaining', ''));
await p.evaluate(() => { window.__shelf.vTimer.endsAt = Date.now() + 1200; });
await p.waitForTimeout(2600);
ok(await shelf(p, () => window.__fake.getPlayerState()) === 2, '5 video pauses when the timer hits zero');
ok((await p.locator('#vCd').textContent()).includes('Paused by the sleep timer'), '5 says it was the sleep timer');
const b15 = p.locator('#vSeg [data-m="15"]').first(); const bb = await b15.boundingBox();
await p.mouse.move(bb.x + 10, bb.y + 10); await p.mouse.down(); await p.waitForTimeout(800); await p.mouse.up(); await p.waitForTimeout(100);
ok(await shelf(p, () => window.__shelf.vTimer && window.__shelf.vTimer.minutes) === 1 && /[01]:\d\d/.test(await p.locator('#vCd').textContent()), '5 press and hold sets a 1-minute test timer');
await p.locator('#vSeg [data-m="30"]').click(); await p.locator('#vSeg [data-m="30"]').click();
ok((await p.locator('#vCd').textContent()).startsWith('Off'), '5 tapping the chosen number again turns the timer off');
// guards from v1: video swap and pre-roll ads must not overwrite a spot
await p.evaluate(() => { window.__lag = true; window.__clip = 'https://youtu.be/swapswapswa'; });
await p.locator('[data-act="close-video"]').click();
await p.locator('#pasteBtn').click(); await p.waitForTimeout(100);
await shelf(p, () => window.__shelf.capture(true));
ok((await shelf(p, () => window.__shelf.videos.swapswapswa.t)) < 5, 'swap: the new video keeps its own spot');
await p.waitForTimeout(600); await p.evaluate(() => { window.__lag = false; window.__ad = true; });
await p.locator('[data-act="close-video"]').click();
await shelf(p, () => window.__shelf.handleText('https://youtu.be/dQw4w9WgXcQ'));
await shelf(p, () => window.__shelf.capture(true));
const adV = await shelf(p, () => ({ ...window.__shelf.videos.dQw4w9WgXcQ }));
ok(!adV.done && adV.t > 50 && adV.dur === 600, 'ad: spot kept (t ' + adV.t.toFixed(0) + ', dur ' + adV.dur + ')');
await p.waitForTimeout(600); await p.evaluate(() => { window.__ad = false; });
await p.locator('[data-act="close-video"]').click();
await ctx.close();

console.log('\n== 6 Sleep audio and lock screen');
({ ctx, p } = await appPage({ fakes: { fresh: false } }));
await settle(p);
ok((await p.locator('.band.c3').textContent()).includes('All caught up'), '6 Sleep band shows nothing new when nothing is new');
await p.locator('.band.c3 .hd').click();
await p.locator('#page .item', { hasText: 'Rome' }).click(); await p.waitForTimeout(1200);
ok(await p.locator('#nsheet.open').count() === 1, '6 night player opens');
ok(await p.evaluate(() => !document.querySelector('#audio').paused), '6 episode is playing');
ok(await p.evaluate(() => navigator.mediaSession && navigator.mediaSession.metadata && navigator.mediaSession.metadata.title) === 'Rome: The Fall of the Western Empire', '6 lock screen shows the episode title');
await p.locator('#nSeg [data-m="15"]').click();
ok(/1[45]:\d\d/.test(await p.locator('#nCd').textContent()), '6 "lights out in" countdown shows');
await p.locator('[data-act="close-night"]').click();
await p.locator('[data-act="back"]').click(); await p.waitForTimeout(150);
ok(await p.locator('#mini').isVisible() && /to sleep/.test(await p.locator('#miniSub').textContent()), '6 keeps playing with a mini bar after closing: ' + await p.locator('#miniSub').textContent());
await p.evaluate(() => { window.__shelf.engine.state().timer.endsAt = Date.now() + 1500; });
await p.waitForTimeout(3000);
ok(await p.evaluate(() => document.querySelector('#audio').paused), '6 stops when the timer runs out');
const ep = await shelf(p, () => Object.values(window.__shelf.audio)[0]);
ok(ep && ep.t > 1 && ep.source, '6 episode spot saved (' + (ep && ep.t.toFixed(1)) + 's)');
ok(await p.evaluate(() => document.querySelector('#audio').volume) === 1, '6 volume back to normal for next time');

console.log('\n== 7 Search and add');
await p.locator('#searchBtn').click();
await p.fill('#sq', 'renal'); await p.press('#sq', 'Enter'); await p.waitForTimeout(500);
ok(await p.locator('#page .item').count() >= 1 && (await p.locator('#page .item').first().textContent()).includes('Renal'), '7 search shows results');
await p.locator('#page .item').first().click(); await p.waitForTimeout(400);
ok(await p.locator('#vsheet.open').count() === 1 && await shelf(p, () => window.__fake.getPlayerState()) === 1, '7 a result plays');
await p.locator('[data-act="close-video"]').click();
await p.locator('[data-act="back"]').click(); await p.waitForTimeout(150);
await p.locator('[data-act="add-section"]').click();
await p.fill('#secName', 'Revision'); await p.locator('#secForm [type="submit"]').click(); await p.waitForTimeout(150);
ok((await p.locator('.band .hd h2').allTextContents()).includes('Revision'), '7 new section appears');
await p.locator('.band', { hasText: 'Revision' }).locator('[data-act="add-channel"]').click();
await p.fill('#addInput', 'https://www.youtube.com/@MehlmanMedical'); await p.locator('#addGo').click();
await p.waitForTimeout(600);
ok(/Added Mehlman Medical to Revision/.test(await p.locator('#addMsg').textContent()), '7 add channel by pasting its link: ' + await p.locator('#addMsg').textContent());
await p.waitForTimeout(800);
await p.locator('.band', { hasText: 'Revision' }).locator('.hd').click();
await p.locator('[data-act="add-channel"]').first().click();
await p.fill('#addInput', 'https://www.youtube.com/@NoSuchChannel'); await p.locator('#addGo').click(); await p.waitForTimeout(500);
ok(/Not found/.test(await p.locator('#addMsg').textContent()), '7 a bad channel is explained: ' + await p.locator('#addMsg').textContent());
await p.keyboard.press('Escape');
await p.locator('[data-act="back"]').click(); await p.waitForTimeout(150);

console.log('\n== 8 Self-check');
await p.locator('#statusBtn').click(); await p.waitForTimeout(150);
const txt = await p.locator('#checkList').textContent();
ok(await p.locator('#checkList li.ok').count() >= 6 && txt.includes('Running inside the Shelf app'), '8 green ticks in the app');
ok(await p.locator('#toneBtn').isVisible(), '8 lock-screen sound test is offered in the app');
await p.screenshot({ path: SHOTS + '/e2e-check.png' });
await p.keyboard.press('Escape');
ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'phone: no sideways scroll');
await ctx.close();

// Problems are explained in plain words
({ ctx, p } = await appPage({ fakes: { ytDown: true } }));
await p.waitForTimeout(13000);
await p.locator('#statusBtn').click(); await p.waitForTimeout(150);
ok((await p.locator('#checkList').textContent()).includes("Can't reach YouTube"), '8 YouTube blocked is explained');
await p.keyboard.press('Escape');
await shelf(p, () => window.__shelf.handleText('https://youtu.be/dQw4w9WgXcQ'));
ok(await p.locator('#perr').isVisible() && (await p.locator('#perr').textContent()).includes('Open on YouTube'), '8 playing then offers Open on YouTube');
await ctx.close();
({ ctx, p } = await appPage());
await settle(p);
await ctx.route('https://www.youtube.com/feeds/**', (r) => r.abort());
await shelf(p, () => window.__shelf.refreshAll(true)); await settle(p);
await p.locator('#statusBtn').click(); await p.waitForTimeout(150);
const ft = await p.locator('#checkList').textContent();
ok(/Couldn't update .*Dirty Medicine/.test(ft) && await p.locator('#statusDot.bad').count() === 1, '8 channel update failures name the channels');
await p.keyboard.press('Escape');
await shelf(p, () => window.__shelf.handleText('https://youtu.be/blockedxxxx')); await p.waitForTimeout(300);
ok((await p.locator('#perr').textContent()).includes('only lets it play on YouTube'), 'embed-blocked video explained, with Open on YouTube');
await ctx.close();

// Small phone (iPhone SE): player controls and dialog buttons stay reachable
({ ctx, p } = await appPage({ ctxOpts: { viewport: { width: 375, height: 667 } } }));
await settle(p);
await shelf(p, () => window.__shelf.handleText('https://youtu.be/dQw4w9WgXcQ')); await p.waitForTimeout(500);
const ctlBox = await p.locator('#vsheet .ctl').boundingBox();
ok(ctlBox && ctlBox.y + ctlBox.height <= 667 + 1, 'SE: pause button visible without scrolling (bottom ' + (ctlBox && Math.round(ctlBox.y + ctlBox.height)) + ')');
await p.locator('[data-act="close-video"]').click();
await p.locator('#statusBtn').click(); await p.waitForTimeout(150);
await p.locator('#sendBtn').scrollIntoViewIfNeeded();
const sb = await p.locator('#sendBtn').boundingBox();
ok(sb && sb.y + sb.height <= 667, 'SE: self-check buttons reachable');
await ctx.close();

console.log('\n== Mac browser (no app)');
const mctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] });
await installFakes(mctx);
const m = await mctx.newPage(); m.on('pageerror', (e) => errors.push('mac: ' + e.message));
await m.goto(URL0); await m.waitForTimeout(500);
ok(await m.locator('#webNote').isVisible(), 'mac: says channels load in the iPhone app');
await m.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'https://www.youtube.com/watch?v=9bZkp7q19f0&t=1m'); document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); });
await m.waitForTimeout(400);
ok(await m.evaluate(() => window.__shelf.current) === '9bZkp7q19f0' && await m.evaluate(() => window.__lastStart) === 57, 'mac: ⌘V plays the link from its &t= time');
await m.keyboard.press('Escape');
ok(await m.locator('.band.c0').count() === 1, 'mac: pasted video shows under Pasted');
await m.locator('#statusBtn').click();
ok(!(await m.locator('#toneBtn').isVisible()) && await m.locator('#statusDot.good').count() === 1, 'mac: all good, no app-only buttons');
await m.locator('#sendBtn').click(); await m.waitForTimeout(200);
const link = await m.evaluate(() => navigator.clipboard.readText());
ok(/#shelf=/.test(link), 'mac: shelf link copied');
await m.keyboard.press('Escape');
await m.screenshot({ path: SHOTS + '/e2e-mac.png' });
// the link carries the spot into the phone app
({ ctx, p } = await appPage({ clip: link }));
await p.waitForTimeout(800);
await p.locator('#pasteBtn').click(); await p.waitForTimeout(300);
ok(await shelf(p, () => !!window.__shelf.videos['9bZkp7q19f0']), 'phone: pasting the shelf link brings the spots over');
await ctx.close();
// opened as a file
const fctx = await browser.newContext(); await installFakes(fctx);
const fp = await fctx.newPage(); await fp.goto('file://' + root + 'index.html'); await fp.waitForTimeout(400);
await fp.locator('#statusBtn').click(); await fp.waitForTimeout(150);
ok((await fp.locator('#checkList').textContent()).includes('opened the file directly'), 'file: opened-as-file is explained');

ok(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
