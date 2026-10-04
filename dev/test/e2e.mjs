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

async function appPage({ prefs = {}, clip = '', fakes = {}, ctxOpts = {}, shell = {} } = {}) {
  const ctx = await browser.newContext({ ...phone, ...ctxOpts });
  await installFakes(ctx, fakes);
  await ctx.addInitScript(CAP(prefs, clip, shell));
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
ok(calls.some((c) => /youtube\.com\/@/.test(c.url) && /SOCS=/.test(c.headers.Cookie) && /Macintosh/.test(c.headers['User-Agent'])), '1 channel pages are read natively, with the consent cookie and a desktop identity (the phone page is shaped differently)');

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
ok(txt.includes('Signed in to YouTube') && (await p.locator('#ytBtn').textContent()) === 'Sign out of YouTube', '8 says it is signed in to YouTube, with a way out');
ok(!(await p.locator('#retryBtn').isVisible()), '8 no Try again when phone storage is fine');
await p.screenshot({ path: SHOTS + '/e2e-check.png' });
await p.keyboard.press('Escape');
ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'phone: no sideways scroll');
await ctx.close();

console.log('\n== YouTube sign-in (Premium without ads)');
({ ctx, p } = await appPage({ shell: { ytSignedIn: false } }));
await settle(p);
await p.locator('#statusBtn').click(); await p.waitForTimeout(150);
ok(/Not signed in to YouTube, so videos play with ads/.test(await p.locator('#checkList').textContent()) && await p.locator('#statusDot.bad').count() === 1, 'YT signed out is explained and the corner needs a look');
ok(await p.locator('#ytBtn').isVisible() && (await p.locator('#ytBtn').textContent()) === 'Sign in to YouTube', 'YT offers Sign in to YouTube');
const reloaded = p.waitForEvent('load', { timeout: 5000 }).then(() => true, () => false);
await p.locator('#ytBtn').click();
ok(await reloaded, 'YT after the sheet closes signed in, the page reloads so the player sees the account');
await settle(p);
await p.waitForFunction(() => document.querySelector('#statusDot').classList.contains('good'), null, { timeout: 6000 }).catch(() => {});
ok(await shelf(p, () => window.__ytCalls.length) === 0 && await p.locator('#statusDot.good').count() === 1, 'YT fresh page is all good');
await p.locator('#statusBtn').click(); await p.waitForTimeout(150);
ok(/Signed in to YouTube.*Allow Cross-Website Tracking/.test(await p.locator('#checkList').textContent()), 'YT signed in, and says what else Premium needs');
await p.locator('#trackBtn').click(); await p.waitForTimeout(100);
ok(await shelf(p, () => window.__ytCalls.includes('openSettings')), 'YT the settings button opens Shelf\'s iPhone settings');
await p.locator('#ytBtn').click(); await p.waitForTimeout(200);
ok(/Not signed in to YouTube/.test(await p.locator('#checkList').textContent()) && (await p.locator('#ytBtn').textContent()) === 'Sign in to YouTube', 'YT sign out forgets the account');
await ctx.close();
// Google refuses to finish: explained, with the YouTube app as the way to Premium
({ ctx, p } = await appPage({ shell: { ytSignedIn: false, ytRefuse: true } }));
await settle(p);
await p.locator('#statusBtn').click(); await p.waitForTimeout(150);
await p.locator('#ytBtn').click(); await p.waitForTimeout(300);
ok(/Google didn't finish signing you in.*YouTube app/.test(await p.locator('#toast').textContent()) && await shelf(p, () => window.__ytCalls.includes('signIn')), 'YT a refused sign-in is explained, no reload');
await ctx.close();
// A shell built before the sign-in plugin
({ ctx, p } = await appPage({ shell: { oldShell: true } }));
await settle(p);
await p.locator('#statusBtn').click(); await p.waitForTimeout(150);
ok(/older than the website.*run the installer again/.test(await p.locator('#checkList').textContent()) && !(await p.locator('#ytBtn').isVisible()), 'YT an old shell is told to re-run the installer, no dead button');
await ctx.close();

console.log('\n== Phone storage safety');
const LIBK = 'shelf.v2.library', VK = 'resume.shelf.v1';
const libWith = (extra, rev) => JSON.stringify({ sections: [{ id: 'med', name: 'Medicine', kind: 'video' }, { id: 'ent', name: 'Entertainment', kind: 'video' }, { id: 'sleep', name: 'Sleep', kind: 'audio' }].concat(extra ? [{ id: 'x', name: extra, kind: 'video' }] : []),
  sources: {}, seeded: true, seedV: 2, seedMisses: [], rev: rev });
const phoneSpot = JSON.stringify({ dQw4w9WgXcQ: { id: 'dQw4w9WgXcQ', title: 'Phone spot', t: 600, dur: 1200, updated: Date.now() - 60000 } });
// Phone reads fail: nothing is written to the phone, the self-check says so and offers Try again
({ ctx, p } = await appPage({ prefs: { [VK]: phoneSpot, [LIBK]: libWith('Phone only', 7) }, shell: { prefFail: true } }));
await p.waitForFunction(() => !!window.__shelf, null, { timeout: 12000 }); await p.waitForTimeout(1200);
ok(/didn't answer/.test(await p.locator('#toast').textContent()), 'store: a warning says the phone storage didn\'t answer');
await settle(p);
await shelf(p, () => window.__shelf.handleText('https://youtu.be/swapswapswa')); await p.waitForTimeout(400);
await p.evaluate(() => window.__fake.advance(40)); await p.waitForTimeout(5400);
await p.locator('[data-act="close-video"]').first().click(); await p.waitForTimeout(500);
ok(await shelf(p, () => window.__prefWrites) === 0, 'store: with unreadable phone storage nothing is written over it');
await p.locator('#statusBtn').click(); await p.waitForTimeout(150);
ok(/didn't answer at start/.test(await p.locator('#checkList').textContent()) && await p.locator('#retryBtn').isVisible(), 'store: self-check explains it and offers Try again');
// The phone answers again: Try again reloads, merges both copies, and only then writes
await p.evaluate(() => localStorage.setItem('fake.prefFail', '0'));
const again = p.waitForEvent('load', { timeout: 5000 }).then(() => true, () => false);
await p.locator('#retryBtn').click();
ok(await again, 'store: Try again restarts Shelf');
await settle(p); await p.waitForTimeout(800);
const merged = await shelf(p, () => ({ v: window.__shelf.videos, phone: JSON.parse(window.__prefs['resume.shelf.v1'] || '{}'), secs: window.__shelf.lib.sections().map((x) => x.name) }));
ok(merged.v.dQw4w9WgXcQ && merged.v.swapswapswa && merged.phone.dQw4w9WgXcQ && merged.phone.swapswapswa, 'store: after Try again the phone keeps its spot and gets the new one');
ok(merged.secs.includes('Phone only'), 'store: the phone\'s newer channel list was kept');
await ctx.close();
// Library: the copy with more saves wins, whichever side it is on
({ ctx, p } = await appPage({ prefs: { [LIBK]: libWith('Phone newer', 9) }, shell: { web: { [LIBK]: libWith('Web older', 4) } } }));
await settle(p); await p.waitForTimeout(600);
let secs = await shelf(p, () => window.__shelf.lib.sections().map((x) => x.name));
ok(secs.includes('Phone newer') && !secs.includes('Web older'), 'store: a newer phone channel list beats a stale web copy (' + secs.join(', ') + ')');
ok(/Phone newer/.test(await shelf(p, () => window.__prefs['shelf.v2.library'])), 'store: and the stale copy is not mirrored over it');
await ctx.close();
({ ctx, p } = await appPage({ prefs: { [LIBK]: libWith('Phone older', 2) }, shell: { web: { [LIBK]: libWith('Web newer', 5) } } }));
await settle(p); await p.waitForTimeout(600);
secs = await shelf(p, () => window.__shelf.lib.sections().map((x) => x.name));
ok(secs.includes('Web newer') && /Web newer/.test(await shelf(p, () => window.__prefs['shelf.v2.library'])), 'store: a newer web copy wins and is backed up to the phone');
await ctx.close();
// Copies from before save counting: the phone's copy is trusted
({ ctx, p } = await appPage({ prefs: { [LIBK]: libWith('Phone legacy') }, shell: { web: { [LIBK]: libWith('Web legacy') } } }));
await settle(p);
secs = await shelf(p, () => window.__shelf.lib.sections().map((x) => x.name));
ok(secs.includes('Phone legacy') && !secs.includes('Web legacy'), 'store: legacy copies (no save count) prefer the phone');
await ctx.close();
// A damaged phone record is ignored, the rest still restores
({ ctx, p } = await appPage({ prefs: { [VK]: '{broken', [LIBK]: libWith('Phone ok', 3) } }));
await settle(p); await p.waitForTimeout(600);
await p.locator('#statusBtn').click(); await p.waitForTimeout(150);
ok(await shelf(p, () => window.__shelf.lib.sections().some((x) => x.name === 'Phone ok')) && !/didn't answer/.test(await p.locator('#checkList').textContent()), 'store: a damaged phone record is skipped and the rest restores');
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
// Turned sideways, the video fills the screen; upright again, the player is back
await p.setViewportSize({ width: 667, height: 375 }); await p.waitForTimeout(150);
const land = await p.locator('#vsheet .vid').boundingBox();
ok(land && land.x === 0 && land.y === 0 && land.width === 667 && land.height === 375, 'sideways: the video fills the screen (' + (land && [land.width, land.height].join('x')) + ')');
await p.setViewportSize({ width: 375, height: 667 }); await p.waitForTimeout(150);
const up = await p.locator('#vsheet .vid').boundingBox();
ok(up && Math.round(up.height) === Math.round(375 * 9 / 16) && await p.locator('#vsheet .ctl').isVisible(), 'upright again: normal player');
await p.locator('[data-act="close-video"]').click();
await p.locator('#statusBtn').click(); await p.waitForTimeout(150);
await p.locator('#sendBtn').scrollIntoViewIfNeeded();
const sb = await p.locator('#sendBtn').boundingBox();
ok(sb && sb.y + sb.height <= 667, 'SE: self-check buttons reachable');
await ctx.close();


console.log('\n== Courses (Mehlman playlists)');
({ ctx, p } = await appPage());
await settle(p);
const cinfo = await shelf(p, () => window.__shelf.courses.list().map((c) => { const pr = window.__shelf.courses.progress(c.id); return c.name + ':' + pr.done + '/' + pr.total + ':' + pr.state; }));
ok(cinfo.join(' ') === 'Paeds:91/130:go OBGYN:60/60:done Ophthal:12/12:done Internal Med:0/150:new Pharm:0/80:new Family Med:0/40:new', 'C six playlists found and ticked from Mo\'s note: ' + cinfo.join(' '));
ok(await shelf(p, () => window.__httpCalls.some((c) => c.method === 'POST' && /youtubei\/v1\/browse/.test(c.url))), 'C long playlists load past the first 100 (native POST)');
ok(await shelf(p, () => { const c = window.__shelf.courses, ob = c.list()[1], pid = Object.keys(ob.pins)[0]; return c.items(ob.id).find((x) => x.id === pid).n; }) === 1607, 'C OBGYN 1607 carries the ‼ pin');
ok(await p.locator('.band.c1 .courses .course').count() === 1 && /1 on the go/.test(await p.locator('.band.c1 .chd').textContent()), 'C Medicine band shows only the course on the go');
ok(/91\/130/.test(await p.locator('.band.c1 .course .cn').textContent()) && /Next · 1115/.test(await p.locator('.band.c1 .course .cx').textContent()), 'C Paeds row: 91/130, next is 1115');
await p.locator('.band.c1 .course .cr').click(); await p.waitForTimeout(150);
ok(await p.locator('.course.open .epr').count() === 6 && (await p.locator('.course.open .epr.n .no').textContent()).includes('1115'), 'C expands to a short window around where you are (' + await p.locator('.course.open .epr').count() + ' rows)');
await p.locator('.course.open .epr.n .tk').click(); await p.waitForTimeout(150);
ok(/92\/130/.test(await p.locator('.band.c1 .course .cn').textContent()), 'C tapping a tick ticks it');
await p.locator('.course.open [data-act="course-later"]').click(); await p.waitForTimeout(100);
ok(await p.locator('.course.open .epr').count() === 16, 'C "more" reveals 10 more, not the whole list');
// hold a later tick: everything above it is ticked, with Undo
const tk = p.locator('.course.open .epr .tk').nth(10); await tk.evaluate((e) => e.scrollIntoView({ block: 'center' })); const tb = await tk.boundingBox();
await p.mouse.move(tb.x + 10, tb.y + 10); await p.mouse.down(); await p.waitForTimeout(700); await p.mouse.up(); await p.waitForTimeout(200);
const afterHold = await shelf(p, () => window.__shelf.courses.progress('PLpeds0000000000').done);
ok(afterHold === 101 && /Ticked everything up to/.test(await p.locator('#toast').textContent()), 'C hold ticks everything up to it (' + afterHold + ')');
await p.locator('#toast button').click(); await p.waitForTimeout(150);
ok(await shelf(p, () => window.__shelf.courses.progress('PLpeds0000000000').done) === 92, 'C Undo puts it back');
// set place by episode number
await p.locator('.course.open [data-act="course-place"]').click(); await p.waitForTimeout(100);
await p.fill('#pl-PLpeds0000000000', '1203'); await p.press('#pl-PLpeds0000000000', 'Enter'); await p.waitForTimeout(150);
ok(await shelf(p, () => window.__shelf.courses.progress('PLpeds0000000000').done) === 103 && /1203 is 103 of 130. Ticked everything up to it/.test(await p.locator('#toast').textContent()), 'C Set place 1203 ticks down to it in playlist order');
// play next from the row, finish it, Next up
await p.locator('.band.c1 .course .cgo').click(); await p.waitForTimeout(500);
ok(/PAEDS · 104 OF 130/.test(await p.locator('#vCh').textContent()), 'C player says which course and where: ' + await p.locator('#vCh').textContent());
ok(await p.locator('#vCourse').isVisible(), 'C player shows the course ruler');
const firstId = await shelf(p, () => window.__shelf.current);
await p.evaluate(() => window.__fake.seekTo(600)); await p.waitForTimeout(300);
ok(await p.locator('#vNext').isVisible() && /Next up/i.test(await p.locator('#vNext').textContent()) && await shelf(p, () => window.__shelf.courses.isDone('PLpeds0000000000', window.__shelf.current)), 'C finishing ticks it and offers the next one');
await p.locator('#vNext [data-act="ep-play"]').click(); await p.waitForTimeout(400);
ok(await shelf(p, () => window.__shelf.current) !== firstId && /105 OF 130/.test(await p.locator('#vCh').textContent()), 'C Play next plays the next episode');
await p.locator('.sh-top [data-act="close-video"]').click(); await p.waitForTimeout(200);
// Courses page and adding one
await p.locator('.band.c1 .chd').click(); await p.waitForTimeout(150);
ok((await p.locator('#page .sub-h').allTextContents()).map((x) => x.replace(/\d+/g, '').trim()).join(',') === 'On the go,Not started,Done', 'C Courses page groups: on the go, not started, done');
await p.locator('#page .top [data-act="add-course"]').click(); await p.waitForTimeout(500);
await p.fill('#courseInput', 'surg'); await p.waitForTimeout(150);
ok(await p.locator('#coursePicks [data-pl]').count() === 1, 'C typing finds Mehlman\'s Surgery playlist');
await p.locator('#coursePicks [data-pl]').click(); await p.locator('#courseGo').click(); await p.waitForTimeout(600);
ok(/Added Surgery · 25 videos/.test(await p.locator('#courseMsg').textContent()), 'C added: ' + await p.locator('#courseMsg').textContent());
await p.waitForTimeout(500);
await p.evaluate(() => { window.__clip = 'https://www.youtube.com/playlist?list=PLs1pharm0000000'; });
await p.locator('#pasteBtn').click(); await p.waitForTimeout(300);
ok(await p.locator('#courseDlg[open]').count() === 1 && (await p.inputValue('#courseInput')).includes('PLs1pharm'), 'C pasting a playlist link opens Add course');
await p.keyboard.press('Escape');
await p.locator('[data-act="back"]').click(); await p.waitForTimeout(150);
// Watched the newest Internal Med video first (the last in its playlist): Home still draws, next is the first gap
await shelf(p, () => { const c = window.__shelf.courses, it = c.items('PLim000000000000'); c.tick('PLim000000000000', it[it.length - 1].id, true); });
await p.locator('.band.c2 .hd').click(); await p.waitForTimeout(150); await p.locator('[data-act="back"]').click(); await p.waitForTimeout(200);
ok(await p.locator('.band.c1 .course').count() === 2 && /Next · 100 /.test(await p.locator('.band.c1 .course', { hasText: 'Internal Med' }).locator('.cx').textContent()), 'C last video ticked first: Home still draws, next is the first one still open');
await p.locator('#statusBtn').click(); await p.waitForTimeout(150);
ok(/Tracking 7 courses/.test(await p.locator('#checkList').textContent()), 'C self-check counts the courses');
await p.keyboard.press('Escape');
ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'C no sideways scroll');
await p.waitForTimeout(500);
const cprefs = await shelf(p, () => window.__prefs);
await ctx.close();
// ticks survive a relaunch (phone storage only)
({ ctx, p } = await appPage({ prefs: cprefs }));
await settle(p);
const kept = await shelf(p, () => window.__shelf.courses.progress('PLpeds0000000000').done); ok(kept === 104, 'C ticks kept after closing the app (' + kept + ')');
await ctx.close();
// YouTube refuses the playlist: explained, ticks kept
({ ctx, p } = await appPage({ prefs: cprefs, fakes: { plDown: true } }));
await settle(p);
await shelf(p, () => window.__shelf.courses.load('PLpeds0000000000', true)); await p.waitForTimeout(100);
await p.locator('#statusBtn').click(); await p.waitForTimeout(150);
ok(/Couldn't load Paeds/.test(await p.locator('#checkList').textContent()), 'C a playlist that won\'t load is named in the self-check');
await ctx.close();
// iPhone SE: the open course fits
({ ctx, p } = await appPage({ ctxOpts: { viewport: { width: 375, height: 667 } } }));
await settle(p);
await p.locator('.band.c1 .course .cr').click(); await p.waitForTimeout(150);
ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'SE: open course has no sideways scroll');
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
ok(!(await m.locator('#toneBtn').isVisible()) && !(await m.locator('#ytBtn').isVisible()) && !(await m.locator('#retryBtn').isVisible()) && await m.locator('#statusDot.good').count() === 1, 'mac: all good, no app-only buttons');
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
