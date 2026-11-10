// The real extension in a real Chromium (no internet needed). Usage: node dev/test/ext.mjs
// A copy of extension/ is loaded with http://localhost:8765/* added to its content-script matches (the test page stands in
// for the Shelf page) and localhost to its host permissions. Part 1: the bridge and the fetch rules. Part 2: the YouTube redirect rules.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = new URL('../../', import.meta.url).pathname;
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) failures++; };

// The extension, copied, with the test page added to its matches
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-ext-'));
const extDir = path.join(tmp, 'extension');
fs.cpSync(path.join(root, 'extension'), extDir, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
mf.content_scripts[0].matches.push('http://localhost:8765/*');
mf.host_permissions.push('http://localhost/*', 'http://127.0.0.1/*'); // the real one reads https only; the test's other site is plain http
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(mf, null, 2));

// Two local servers: the "Shelf page" (8765) and another site that gives a page no permission to read it (8766, no CORS headers)
const seen = [];
const page = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/app' ? fs.readFileSync(path.join(root, 'index.html')) : '<!doctype html><title>stub</title><p>page</p>');
}).listen(8765);
const other = http.createServer((req, res) => {
  seen.push({ url: req.url, method: req.method, headers: req.headers });
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'a=b' }); res.end('secret from the other site ' + req.method + ' ' + body); });
}).listen(8766);

let ctx;
try {
  ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium', headless: true,
    args: ['--disable-extensions-except=' + extDir, '--load-extension=' + extDir]
  });
} catch (e) {
  console.log('  FAIL could not start Chromium with the extension: ' + e.message.split('\n')[0]);
  process.exit(1);
}
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
ok(!!sw && /^chrome-extension:\/\/[a-z]+\/background\.js$/.test(sw.url()), 'the extension loads and its service worker runs: ' + (sw && sw.url()));
if (!sw) { console.log('\nThe extension could not be loaded in this Chromium.'); process.exit(1); }

// Shelf's own pages are stubbed (there is no internet here)
await ctx.route('https://mokingsacc.github.io/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Shelf stub</title><p>shelf</p>' }));

const ask = (pg, op, args, ms = 4000) => pg.evaluate(([op, args, ms]) => new Promise((res) => {
  const id = 'q' + Math.random();
  const t = setTimeout(() => { removeEventListener('message', f); res({ timeout: true }); }, ms);
  const f = (e) => { const m = e.data; if (e.source === window && m && m.shelfExt === 'answer' && m.id === id) { clearTimeout(t); removeEventListener('message', f); res(m); } };
  addEventListener('message', f);
  postMessage({ shelfExt: 'ask', id, op, args }, location.origin);
}), [op, args, ms]);

console.log('\n== a The bridge');
const p = await ctx.newPage();
await p.addInitScript(() => { window.__early = document.documentElement && document.documentElement.getAttribute('data-shelf-ext'); });
await p.goto('http://localhost:8765/');
ok(await p.evaluate(() => document.documentElement.getAttribute('data-shelf-ext')) === '1.0.0', 'the content script marks the page with the extension version');
const a1 = await ask(p, 'fetch', { url: 'http://localhost:8766/feed.xml' });
ok(a1.r && a1.r.ok && a1.r.status === 200 && /secret from the other site GET/.test(a1.r.text), 'a read of another site (no CORS headers) comes back through the bridge: ' + JSON.stringify(a1).slice(0, 200));
ok(await p.evaluate(() => fetch('http://localhost:8766/feed.xml').then(() => 'read', () => 'blocked')) === 'blocked', 'the page alone cannot read that site (so the extension is what makes it work)');
const a2 = await ask(p, 'fetch', { url: 'http://localhost:8766/post', method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json', 'X-Mine': 'yes', Cookie: 'sneaky=1', Origin: 'https://evil.example', Referer: 'https://evil.example/', 'User-Agent': 'Nope', 'Sec-Fetch-Mode': 'x', 'Proxy-Authorization': 'x' } });
ok(a2.r && /POST \{"a":1\}/.test(a2.r.text), 'a POST goes through with its body');
const last = seen[seen.length - 1];
ok(!last.headers.origin, 'Shelf\'s own reads go out without an Origin header, as the phone app\'s do: ' + last.headers.origin);
ok(last.headers['x-mine'] === 'yes' && !last.headers.cookie && last.headers.origin !== 'https://evil.example' && last.headers.referer !== 'https://evil.example/' && last.headers['user-agent'] !== 'Nope' && !last.headers['proxy-authorization'], 'headers a page must not set are dropped, others kept: ' + JSON.stringify({ cookie: last.headers.cookie, origin: last.headers.origin, ua: (last.headers['user-agent'] || '').slice(0, 20) }));
for (const bad of ['file:///etc/hostname', 'ftp://example.com/x', 'http://example.com/', 'data:text/plain,hi', 'javascript:1', 'not a url']) {
  const a = await ask(p, 'fetch', { url: bad });
  ok(!!a.error && !a.r, 'refused: ' + bad + ' (' + (a.error || 'ANSWERED') + ')');
}
const a3 = await ask(p, 'fetch', { url: 'http://localhost:8766/x', method: 'PUT' });
ok(!!a3.error, 'refused: a PUT');
const before = seen.length;
await ask(p, 'fetch', { url: 'http://localhost:8766/cookie-check' });
const cc = seen[seen.length - 1];
ok(seen.length === before + 1 && !cc.headers.cookie, 'other sites are read without cookies (credentials omitted)');
const a4 = await ask(p, 'nope', {});
ok(a4.timeout || a4.error, 'an unknown question gets no data: ' + JSON.stringify(a4).slice(0, 80));
const st = await ask(p, 'state', {});
ok(st.r && st.r.bounceOffUntil === 0, 'state: the redirect is on');
// A page that is not Shelf gets no bridge and no answers
const p2 = await ctx.newPage();
await p2.goto('http://127.0.0.1:8765/');
ok(await p2.evaluate(() => document.documentElement.getAttribute('data-shelf-ext')) === null, 'a page that is not Shelf is not marked');
ok((await ask(p2, 'fetch', { url: 'http://localhost:8766/x' }, 1500)).timeout === true, 'and a message from it is never answered');
await p2.close();

// The real Shelf page with the real extension: Shelf sees the extension and its first read goes through it
const app = await ctx.newPage();
await ctx.route('https://www.youtube.com/iframe_api', (rt) => rt.abort());
await app.goto('http://localhost:8765/app'); await app.waitForTimeout(2500);
const selfCheck = await app.evaluate(() => window.__shelf.checks().map((c) => c.text));
ok(selfCheck.some((t) => /Shelf extension v1\.0\.0/.test(t)) && await app.evaluate(() => document.querySelector('#webNote').hidden), 'Shelf itself sees the real extension: ' + selfCheck.find((t) => /extension/.test(t)));
await app.close();

console.log('\n== b Pass and state');
const pass = await ask(p, 'pass', {});
ok(pass.r && pass.r.bounceOffUntil > Date.now() + 14 * 60e3 && pass.r.bounceOffUntil < Date.now() + 16 * 60e3, 'pass: the redirect is off for 15 minutes');
ok(await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets()).then((r) => r.length === 0), 'the ruleset is switched off');
ok((await sw.evaluate(() => chrome.alarms.get('bounce-on'))) !== null, 'an alarm is set to turn it back on');
const st2 = await ask(p, 'state', {});
ok(st2.r.bounceOffUntil === pass.r.bounceOffUntil, 'state reports the end time');
// the time passes: the alarm turns it back on
await sw.evaluate(() => chrome.storage.local.set({ bounceOffUntil: Date.now() - 1000 }));
await sw.evaluate(() => new Promise((res) => chrome.alarms.create('bounce-on', { when: Date.now() + 50 }, res)));
await p.waitForTimeout(1200);
ok(await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets()).then((r) => r.join() === 'bounce'), 'when the time has passed the alarm turns the redirect back on');
ok((await ask(p, 'state', {})).r.bounceOffUntil === 0, 'state is back to 0');

console.log('\n== c The YouTube redirect');
// goto resolves on a redirect to the stubbed Shelf page; a navigation that was not redirected has nowhere to go (no internet)
async function nav(url) {
  const pg = await ctx.newPage();
  const asked = [];
  pg.on('request', (rq) => { if (rq.isNavigationRequest() && rq.frame() === pg.mainFrame()) asked.push(rq.url()); });
  let err = '';
  await pg.goto(url, { timeout: 15000, waitUntil: 'commit' }).catch((e) => { err = e.message; });
  await pg.waitForTimeout(250);
  const final = pg.url();
  await pg.close();
  return { final, err, asked };
}
// Not redirected: Shelf was never asked for, and YouTube was (whatever it answers, or the network error without internet)
const stays = (r, url) => r.asked[0] === url && !r.asked.some((u) => /mokingsacc/.test(u)) && !/mokingsacc/.test(r.final);
const W = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42';
let r = await nav(W);
ok(r.final === 'https://mokingsacc.github.io/shelf/#open=' + W, 'a watch link ends on Shelf with #open= and the whole link: ' + r.final);
r = await nav('https://www.youtube.com/');
ok(r.final === 'https://mokingsacc.github.io/shelf/', 'the YouTube home ends on the Shelf root: ' + r.final);
r = await nav('https://www.youtube.com/shorts/abc');
ok(r.final === 'https://mokingsacc.github.io/shelf/', 'Shorts end on the Shelf root: ' + r.final);
r = await nav('https://youtu.be/dQw4w9WgXcQ?t=5');
ok(r.final === 'https://mokingsacc.github.io/shelf/#open=https://youtu.be/dQw4w9WgXcQ?t=5', 'a youtu.be link ends on Shelf with #open=: ' + r.final);
r = await nav('https://www.youtube.com/playlist?list=PLabc123');
ok(r.final === 'https://mokingsacc.github.io/shelf/#open=https://www.youtube.com/playlist?list=PLabc123', 'a playlist link ends on Shelf with #open=: ' + r.final);
r = await nav('https://m.youtube.com/results?search_query=renal');
ok(r.final === 'https://mokingsacc.github.io/shelf/', 'the phone site is sent to Shelf too: ' + r.final);
// Not redirected: the navigation fails on the network, the address stays on YouTube
r = await nav('https://www.youtube.com/watch?v=dQw4w9WgXcQ&shelf=pass');
ok(stays(r, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&shelf=pass'), 'a link with shelf=pass is NOT redirected: ' + r.asked.join(' > ').slice(0, 120));
r = await nav('https://www.youtube.com/?shelf=pass');
ok(stays(r, 'https://www.youtube.com/?shelf=pass'), 'YouTube home with shelf=pass is NOT redirected');
r = await nav('https://music.youtube.com/');
ok(stays(r, 'https://music.youtube.com/'), 'music.youtube.com is NOT redirected');
// YouTube's own answer to /signin is a redirect back to its home page (which Shelf then takes), so the sign-in page is stubbed here
await ctx.route('https://www.youtube.com/signin**', (rt) => rt.fulfill({ contentType: 'text/html', body: '<!doctype html><title>sign in</title>' }));
r = await nav('https://www.youtube.com/signin?action_handle_signin=true');
ok(r.final === 'https://www.youtube.com/signin?action_handle_signin=true', 'YouTube sign-in is NOT redirected: ' + r.final);
r = await nav('https://accounts.youtube.com/accounts/SetSID');
ok(stays(r, 'https://accounts.youtube.com/accounts/SetSID'), 'accounts.youtube.com is NOT redirected');
r = await nav('https://studio.youtube.com/');
ok(stays(r, 'https://studio.youtube.com/'), 'studio.youtube.com is NOT redirected');
// The embedded player is a sub frame: never touched
const host = await ctx.newPage();
await host.route('http://localhost:8765/embed', (rt) => rt.fulfill({ contentType: 'text/html', body: '<!doctype html><iframe id="f" src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>' }));
await ctx.route('https://www.youtube.com/embed/**', (rt) => rt.fulfill({ contentType: 'text/html', body: '<!doctype html><p>player</p>' }));
await host.goto('http://localhost:8765/embed'); await host.waitForTimeout(500);
ok(host.frames().some((f) => f.url() === 'https://www.youtube.com/embed/dQw4w9WgXcQ'), 'the embedded player (a sub frame) is not redirected');
await host.close();
// Pass for 15 minutes: YouTube is reachable (the redirect is off), then back on
await ask(p, 'pass', {});
r = await nav(W);
ok(stays(r, W), 'with a pass on, a watch link is not redirected');
await sw.evaluate(() => chrome.storage.local.set({ bounceOffUntil: 0 }).then(() => chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['bounce'] })));
r = await nav(W);
ok(r.final.startsWith('https://mokingsacc.github.io/shelf/#open='), 'and the redirect works again after it');

console.log('\n== d The popup');
const extId = new URL(sw.url()).host;
const pop = await ctx.newPage();
await pop.goto('chrome-extension://' + extId + '/popup.html');
await pop.waitForTimeout(300);
ok(await pop.locator('#state').textContent() === 'YouTube opens Shelf' && await pop.locator('#toggle').textContent() === 'Allow YouTube for 15 minutes' && await pop.locator('#open').textContent() === 'Open Shelf', 'the popup says YouTube opens Shelf, with its two buttons');
await pop.locator('#toggle').click(); await pop.waitForTimeout(500);
ok(/^YouTube is open until \d\d:\d\d$/.test(await pop.locator('#state').textContent()) && await pop.locator('#toggle').textContent() === 'Send YouTube to Shelf again', 'Allow YouTube for 15 minutes: the line shows the end time: ' + await pop.locator('#state').textContent());
ok(await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets()).then((x) => x.length === 0), 'and the redirect is off');
await pop.locator('#toggle').click(); await pop.waitForTimeout(500);
ok(await pop.locator('#state').textContent() === 'YouTube opens Shelf' && await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets()).then((x) => x.join() === 'bounce'), 'Send YouTube to Shelf again turns it back on');
await pop.close();

await ctx.close();
page.close(); other.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
