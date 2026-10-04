// Screenshots with sample data, light + dark, desktop + phone
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
const root = new URL('../../', import.meta.url).pathname, S = process.argv[2];
const server = http.createServer((q, r) => { fs.readFile(path.join(root, q.url.split('?')[0].replace(/\/$/, '/index.html')), (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': q.url.endsWith('.png') ? 'image/png' : 'text/html' }); r.end(d); }); }).listen(8766);
const cols = ['#B8334A', '#1C8A99', '#D08A2B', '#1E6B52', '#6E4FB3', '#2F6FB0', '#9A5A2B', '#4B5868'];
const now = Date.now();
const sample = {};
[['aaaaaaaaaa1', 'Heart murmurs in 12 minutes', 'Zero To Finals', 462, 724, 20], ['aaaaaaaaaa2', 'Nephrotic vs nephritic syndrome, explained', 'Ninja Nerd', 300, 1380, 3000], ['aaaaaaaaaa3', 'Acid-base made simple: the 4-step approach', 'Strong Medicine', 800, 1760, 90000], ['aaaaaaaaaa4', 'ECG basics: reading rhythm strips', 'Dr. Matt & Dr. Mike', 500, 680, 200000], ['aaaaaaaaaa5', 'How to make a proper cup of chai', 'Bong Eats', 30, 400, 400000], ['aaaaaaaaaa6', 'Pharmacology of beta blockers', 'Pharmacology Lectures', 900, 900, 500000, 1], ['aaaaaaaaaa7', 'Chest X-ray in 10 minutes', 'Radiology Channel', 600, 600, 900000, 1]]
  .forEach(([id, title, author, t, dur, ago, done]) => sample[id] = { id, title, author, t, dur, updated: now - ago * 1000, added: now - ago * 1000, done: !!done });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const scheme of ['light', 'dark']) for (const [w, h, n] of [[1280, 820, 'desk'], [390, 844, 'phone']]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 1 });
  await ctx.route('https://www.youtube.com/**', r => r.fulfill({ contentType: 'text/javascript', body: 'window.YT={PlayerState:{}};YT.Player=function(el,o){this.getPlayerState=()=>-1;setTimeout(()=>o.events.onReady(),10)};onYouTubeIframeAPIReady()' }));
  await ctx.route('https://i.ytimg.com/**', r => { const i = parseInt(r.request().url().match(/aaaaaaaaaa(\d)/)?.[1] || 1) - 1; r.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${cols[i]}"/><stop offset="1" stop-color="#111"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><text x="80" y="620" font-size="90" font-family="sans-serif" fill="#fff" opacity=".8">sample ${i + 1}</text></svg>` }); });
  await ctx.route('https://noembed.com/**', r => r.abort());
  await ctx.route('https://fonts.**', r => r.abort());
  await ctx.addInitScript((d) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('resume.shelf.v1', d); sessionStorage.setItem('seeded', 1); } }, JSON.stringify(process.argv[3] === 'empty' ? {} : sample));
  const p = await ctx.newPage(); await p.goto('http://localhost:8766/'); await p.waitForTimeout(500);
  await p.locator('#paste').blur();
  await p.screenshot({ path: `${S}/app-${n}-${scheme}.png`, fullPage: true });
  if (n === 'desk' && scheme === 'light') { await p.locator('#statusBtn').click(); await p.waitForTimeout(200); await p.screenshot({ path: `${S}/app-check.png` }); await p.keyboard.press('Escape'); await p.locator('#sendBtn').click(); await p.waitForTimeout(200); await p.screenshot({ path: `${S}/app-send.png` }); }
  await ctx.close();
}
await b.close(); server.close();
