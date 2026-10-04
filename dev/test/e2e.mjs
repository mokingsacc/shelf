// End-to-end run of the "done" test in Chromium, with YouTube faked (no internet here).
// Usage: node test/e2e.mjs  (serves dist/ on :8765)
import { chromium, webkit } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const root = new URL('../../', import.meta.url).pathname;
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(d); });
}).listen(8765);

const FAKE_YT = `
window.YT = { PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } };
YT.Player = function (el, opts) {
  var self = this, node = document.getElementById(el);
  node.innerHTML = '<div id="fakeplayer" style="width:100%;height:100%;background:#000;color:#fff;display:grid;place-items:center">fake player</div>';
  var t0 = 0, base = 0, state = -1, id = null, rate = 1, dur = 600;
  window.__fake = self;
  function now() { return state === 1 ? base + (Date.now() - t0) / 1000 * rate * (window.__speed || 1) : base; }
  function set(s) { state = s; opts.events.onStateChange && opts.events.onStateChange({ data: s, target: self }); }
  self.loadVideoById = function (o) {
    if (window.__lag) { var oldT = now(); id = o.videoId; state = 3; base = oldT; dur = 600; setTimeout(function () { base = o.startSeconds || 0; t0 = Date.now(); set(1); }, 400); return; }
    if (window.__ad) { id = o.videoId; dur = 30; base = 25; t0 = Date.now(); set(1); setTimeout(function () { dur = 600; base = o.startSeconds || 0; t0 = Date.now(); set(1); }, 400); return; }
    id = o.videoId; base = o.startSeconds || 0; t0 = Date.now(); window.__lastStart = base; window.__lastId = id;
    if (id === 'blockedxxxx') { setTimeout(function(){ opts.events.onError({ data: 150 }); }, 50); return; }
    setTimeout(function () { t0 = Date.now(); set(1); }, 50); };
  self.getCurrentTime = function () { var t = now(); if (t >= dur) { t = dur; } return t; };
  self.getDuration = function () { return id ? dur : 0; };
  self.getPlayerState = function () { return state; };
  self.getVideoData = function () { return { video_id: id || '', title: 'Fake title ' + id, author: 'Fake channel' }; };
  self.getPlaybackRate = function () { return rate; };
  self.setPlaybackRate = function (r) { rate = r; };
  self.stopVideo = function () { base = now(); set(5); };
  self.pauseVideo = function () { base = now(); set(2); };
  self.advance = function (n) { base += n; };
  self.seekTo = function (s) { base = s; t0 = Date.now(); if (s >= dur) { base = dur; set(0); } };
  setTimeout(function () { opts.events.onReady && opts.events.onReady({ target: self }); if (window.__errOnCreate) opts.events.onError({ data: 2 }); }, 30);
};
setTimeout(function(){ window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(); }, 20);
`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) failures++; };

async function setup(ctx, { ytDown = false } = {}) {
  await ctx.route('https://www.youtube.com/iframe_api', (r) => ytDown ? r.abort() : r.fulfill({ contentType: 'text/javascript', body: FAKE_YT }));
  await ctx.route('https://i.ytimg.com/**', (r) => r.fulfill({ contentType: 'image/png', body: PNG }));
  await ctx.route('https://noembed.com/**', (r) => { const u = new URL(r.request().url()); const id = new URL(u.searchParams.get('url')).searchParams.get('v'); r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ title: 'Noembed title for ' + id, author_name: 'Channel ' + id }) }); });
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
}

async function run(browserType, name) {
  console.log(`\n== ${name}`);
  const browser = await browserType.launch(browserType === chromium ? { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' } : {}).catch((e) => { console.log('  skip: ' + e.message.split('\n')[0]); return null; });
  if (!browser) return;
  const ctx = await browser.newContext({ permissions: name === 'chromium' ? ['clipboard-read', 'clipboard-write'] : [] });
  await setup(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto('http://localhost:8765/');
  await page.waitForTimeout(400);

  // 1 Open
  ok(await page.locator('#empty').isVisible(), '1 empty shelf shows a friendly start');
  await page.waitForFunction(() => document.querySelector('#statusDot').classList.contains('good'), null, { timeout: 4000 }).catch(() => {});
  ok(await page.locator('#statusDot.good').count() === 1, '1 status dot is green');

  // 2 Add by Cmd+V anywhere
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'https://youtu.be/dQw4w9WgXcQ?si=xyz');
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => Object.keys(window.__resume.videos).length) === 1, '2 pasted link is on the shelf');
  ok(await page.locator('#hero').isVisible() && await page.evaluate(() => document.body.classList.contains('playing')) && !(await page.locator('#poster').isVisible()), '2 player opens and plays');
  await page.waitForTimeout(400);
  ok((await page.locator('#heroTitle').textContent()).includes('title'), '2 shows a title: ' + await page.locator('#heroTitle').textContent());

  // 3 Remember: speed up fake time to ~60s then leave
  await page.evaluate(() => { window.__fake.advance(60); });
  await page.waitForTimeout(5300); // let the 5-second autosave fire on its own
  const t = await page.evaluate(() => window.__resume.videos.dQw4w9WgXcQ.t);
  ok(t > 50 && t < 90, '3 spot saved around 1:00 (got ' + t.toFixed(1) + ')');
  await page.close();

  // 4 Resume in a new tab
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto('http://localhost:8765/');
  await p2.waitForTimeout(400);
  const cta = await p2.locator('#resumeText').textContent();
  ok(/^Resume from 1:\d\d$/.test(cta), '4 button says "' + cta + '"');
  ok(await p2.locator('#chip').isVisible() && /1:\d\d/.test(await p2.locator('#chip').textContent()), '4 poster chip: ' + await p2.locator('#chip').textContent());
  ok(await p2.locator('#heroBar').evaluate((e) => parseFloat(e.style.width) > 5), '4 progress bar shows');
  await p2.locator('#poster').click();
  await p2.waitForTimeout(300);
  const start = await p2.evaluate(() => window.__lastStart);
  ok(Math.abs(start - (t - 3)) < 2, '4 resumes from saved spot (start ' + start + ')');

  // Swapping videos: the old video's time must not land on the new one
  await p2.evaluate(() => { window.__lag = true; });
  await p2.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'https://youtu.be/swapswapswa');
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await p2.evaluate(() => window.__resume.capture(true));
  const swapT = await p2.evaluate(() => window.__resume.videos.swapswapswa.t);
  ok(swapT < 5, 'swap: new video keeps its own spot (got ' + swapT + ')');
  await p2.waitForTimeout(600);
  await p2.evaluate(() => { window.__lag = false; });
  // A pre-roll ad must not overwrite the spot or finish the video
  await p2.evaluate(() => { window.__ad = true; });
  await p2.locator('#watching .row[data-id="dQw4w9WgXcQ"] .row-main').click();
  await p2.evaluate(() => window.__resume.capture(true));
  const adV = await p2.evaluate(() => ({ ...window.__resume.videos.dQw4w9WgXcQ }));
  ok(!adV.done && adV.t > 50 && adV.dur === 600, 'ad: spot kept (t ' + adV.t.toFixed(0) + ', dur ' + adV.dur + ', done ' + adV.done + ')');
  await p2.waitForTimeout(600);
  await p2.evaluate(() => { window.__ad = false; });

  // 5 Finish
  await p2.evaluate(() => { window.__fake.seekTo(600); });
  await p2.waitForTimeout(300);
  ok(await p2.locator('#finished .row[data-id="dQw4w9WgXcQ"]').count() === 1 && !(await p2.evaluate(() => window.__resume.current)), '5 finished video moves to Finished');

  // Add by typing in the box, multiple links, bad link
  await p2.fill('#paste', 'https://www.youtube.com/watch?v=9bZkp7q19f0&t=1m and https://youtu.be/kJQP7kiw5Fk');
  await p2.press('#paste', 'Enter');
  await p2.waitForTimeout(300);
  ok(await p2.evaluate(() => !!(window.__resume.videos['9bZkp7q19f0'] && window.__resume.videos['kJQP7kiw5Fk'])) && (await p2.locator('#heroTitle').textContent()).includes('9bZkp7q19f0'), 'box adds two links at once (first one featured)');
  ok((await p2.locator('#resumeText').textContent()) === 'Resume from 1:00', 'a link with &t=1m starts at 1:00');
  await p2.fill('#paste', 'https://vimeo.com/123');
  await p2.press('#paste', 'Enter');
  await p2.waitForTimeout(200);
  ok((await p2.locator('#toast').textContent()).includes("doesn't look like a YouTube link"), 'bad link explained in plain words');

  // Real keyboard paste with focus elsewhere (Safari-style path: focus moves to the box)
  if (name === 'chromium') {
    await p2.evaluate(() => navigator.clipboard.writeText('https://www.youtube.com/watch?v=3JZ_D3ELwOQ'));
    await p2.locator('h1').click();
    await p2.keyboard.press('ControlOrMeta+V');
    await p2.waitForTimeout(300);
    ok(await p2.evaluate(() => !!window.__resume.videos['3JZ_D3ELwOQ']), 'keyboard paste with nothing focused adds the video');
    await p2.locator('.only-playing[data-act="close"]').click();
    // Paste button reads the clipboard
    await p2.evaluate(() => navigator.clipboard.writeText('https://youtu.be/L_jWHffIx5E'));
    await p2.locator('#addBtn').click();
    await p2.waitForTimeout(300);
    ok(await p2.evaluate(() => !!window.__resume.videos['L_jWHffIx5E']), 'Paste button adds from the clipboard');
    await p2.locator('.only-playing[data-act="close"]').click();
  }

  // Blocked-embed video
  await p2.fill('#paste', 'https://youtu.be/blockedxxxx');
  await p2.press('#paste', 'Enter');
  await p2.waitForTimeout(400);
  ok(await p2.locator('#playerError').isVisible() && (await p2.locator('#playerError').textContent()).includes('Open on YouTube'), 'embed-blocked video offers Open on YouTube');
  await p2.locator('.only-playing[data-act="close"]').click();

  // Remove + undo
  const count = (pg) => pg.evaluate(() => Object.keys(window.__resume.videos).length);
  const before = await count(p2);
  await p2.locator('#watching .row').first().hover();
  await p2.locator('#watching .row [data-act="remove"]').first().click();
  ok(await count(p2) === before - 1, 'remove works');
  await p2.locator('#toast .toast-act').click();
  ok(await count(p2) === before, 'undo brings it back');

  // 6 Send to iPhone
  await p2.locator('#sendBtn').click();
  await p2.waitForTimeout(200);
  ok(await p2.locator('#sendDlg[open] #qr svg').count() === 1, '6 QR code shows');
  const link = await p2.locator('#sendLink').inputValue();
  await p2.locator('#sendDlg [data-act="dismiss"]').first().click();
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: name === 'chromium', hasTouch: true });
  await setup(phoneCtx);
  const phone = await phoneCtx.newPage();
  phone.on('pageerror', (e) => errors.push('phone: ' + e.message));
  await phone.goto(link);
  await phone.waitForTimeout(500);
  ok(await count(phone) === before, '6 phone gets the same shelf (' + await count(phone) + '/' + before + ')');
  ok(!(await phone.evaluate(() => location.hash)), '6 phone link cleaned from address bar');
  // Home Screen app path: paste the shelf link into the box
  const p3ctx = await browser.newContext(); await setup(p3ctx); const p3 = await p3ctx.newPage();
  await p3.goto('http://localhost:8765/'); await p3.waitForTimeout(300);
  await p3.fill('#paste', link); await p3.press('#paste', 'Enter'); await p3.waitForTimeout(300);
  ok(await count(p3) === before, '6 pasting the shelf link into the box imports it');
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok(!overflow, 'phone: no sideways scroll');
  await phone.screenshot({ path: `/tmp/claude-0/-home-claude/37d1ef24-0e4b-56e8-ae27-d473dfebb3f7/scratchpad/shot-${name}-phone.png`, fullPage: true });

  // 7 Self-check
  await p2.locator('#statusDot').click();
  await p2.waitForTimeout(150);
  ok(await p2.locator('#checkDlg[open] #checkList li.ok').count() >= 3, '7 self-check shows green ticks');
  await p2.screenshot({ path: `/tmp/claude-0/-home-claude/37d1ef24-0e4b-56e8-ae27-d473dfebb3f7/scratchpad/shot-${name}-check.png` });
  await p2.keyboard.press('Escape');
  await p2.screenshot({ path: `/tmp/claude-0/-home-claude/37d1ef24-0e4b-56e8-ae27-d473dfebb3f7/scratchpad/shot-${name}-desk.png`, fullPage: true });

  // An empty player complaining before anything is played shows nothing
  const eCtx = await browser.newContext(); await setup(eCtx); const ep = await eCtx.newPage();
  await ep.addInitScript(() => { window.__errOnCreate = true; });
  await ep.goto(link); await ep.waitForTimeout(500);
  ok(!(await ep.locator('#playerError').isVisible()) && await ep.locator('#statusDot.good').count() === 1, 'early player error ignored, dot green');

  // Self-check when YouTube is blocked
  const badCtx = await browser.newContext();
  await setup(badCtx, { ytDown: true });
  const bad = await badCtx.newPage();
  await bad.goto('http://localhost:8765/');
  await bad.waitForTimeout(500);
  await bad.locator('#statusDot').click();
  await bad.waitForTimeout(150);
  ok((await bad.locator('#checkList').textContent()).includes("Can't reach YouTube"), '7 YouTube blocked is explained');
  await bad.keyboard.press('Escape');
  await bad.waitForTimeout(12500);
  await bad.fill('#paste', 'https://youtu.be/dQw4w9WgXcQ'); await bad.press('#paste', 'Enter'); await bad.waitForTimeout(200);
  ok(await bad.locator('#playerError').isVisible() && (await bad.locator('#playerError').textContent()).includes("Can't reach YouTube") && await bad.locator('#poster').isVisible(), 'YouTube blocked: Play explains it and offers YouTube');

  // Self-check when opened as a file
  const fileCtx = await browser.newContext();
  await setup(fileCtx);
  const fp = await fileCtx.newPage();
  await fp.goto('file://' + root + 'index.html');
  await fp.waitForTimeout(400);
  await fp.locator('#statusDot').click();
  await fp.waitForTimeout(150);
  ok((await fp.locator('#checkList').textContent()).includes('opened the file directly'), '7 opened-as-file is explained');

  ok(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
}

await run(chromium, 'chromium');
await run(webkit, 'webkit');
server.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
