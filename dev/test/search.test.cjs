// Search: Data API path (with key) and results-page path (without).
const assert = require('assert');
global.Core = require('../src/core.js');
global.Feeds = require('../src/feeds.js');
const Search = require('../src/search.js');

assert.strictEqual(Search.isoDuration('PT1H2M3S'), 3723);
assert.strictEqual(Search.isoDuration('PT45S'), 45);
assert.strictEqual(Search.isoDuration('P1DT1M'), 86460);
assert.strictEqual(Search.isoDuration('nonsense'), 0);

const apiSearch = JSON.stringify({ items: [
  { id: { kind: 'youtube#channel', channelId: 'UCgF2C3zwV2-Ycq9fxXDZqmA' }, snippet: { title: 'Dirty Medicine', description: 'USMLE', thumbnails: { default: { url: 'https://yt3/c.jpg' } } } },
  { id: { kind: 'youtube#video', videoId: 'aaaaaaaaaa1' }, snippet: { title: 'Hyperkalemia &amp; ECG', channelTitle: 'Dirty Medicine', channelId: 'UCgF2C3zwV2-Ycq9fxXDZqmA', publishedAt: '2026-09-01T00:00:00Z', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/aaaaaaaaaa1/mqdefault.jpg' } }, liveBroadcastContent: 'none' } }
] });
const apiVideos = JSON.stringify({ items: [{ id: 'aaaaaaaaaa1', contentDetails: { duration: 'PT12M5S' } }] });

const page = 'var ytInitialData = {"contents":[{"channelRenderer":{"channelId":"UCcccccccccccccccccccccc","title":{"simpleText":"Breaking Points"}}},' +
  '{"videoRenderer":{"videoId":"bbbbbbbbbb1","thumbnail":{},"title":{"runs":[{"text":"Krystal \\u0026 Saagar: the week"}]},"lengthText":{"accessibility":{},"simpleText":"1:02:03"},' +
  '"ownerText":{"runs":[{"text":"Breaking Points","navigationEndpoint":{"browseEndpoint":{"browseId":"UCcccccccccccccccccccccc"}}}]}}},' +
  '{"videoRenderer":{"videoId":"bbbbbbbbbb2","title":{"runs":[{"text":"Second"}]},"longBylineText":{"runs":[{"text":"Other","navigationEndpoint":{"browseEndpoint":{"browseId":"UCdddddddddddddddddddddd"}}}]}}}]};';

(async () => {
  const urls = [];
  const io = {
    fetchJSON: (u) => { urls.push(u); return Promise.resolve(/\/search\?/.test(u) ? { ok: true, status: 200, text: apiSearch } : { ok: true, status: 200, text: apiVideos }); },
    fetchText: (u, h) => { urls.push(u); assert.ok(/SOCS/.test(h.Cookie)); return Promise.resolve(page); }
  };
  let r = await Search.run(io, 'hyperkalemia', 'KEY1');
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].kind, 'channel');
  assert.strictEqual(r[1].title, 'Hyperkalemia & ECG');
  assert.strictEqual(r[1].dur, 725);
  assert.ok(urls[0].includes('q=hyperkalemia') && urls[0].includes('key=KEY1'));
  assert.ok(urls[1].includes('id=aaaaaaaaaa1'));

  r = await Search.run(io, 'breaking points', '');
  assert.deepStrictEqual(r.map((x) => x.kind), ['channel', 'video', 'video']);
  assert.strictEqual(r[0].title, 'Breaking Points');
  assert.strictEqual(r[1].title, 'Krystal & Saagar: the week');
  assert.strictEqual(r[1].dur, 3723);
  assert.strictEqual(r[1].channelId, 'UCcccccccccccccccccccccc');
  assert.strictEqual(r[2].channel, 'Other');

  assert.deepStrictEqual(await Search.run(io, '   ', 'K'), []);

  // Plain-words errors
  const err = (status, reason) => ({ fetchJSON: () => Promise.resolve({ ok: false, status, text: JSON.stringify({ error: { errors: [{ reason }] } }) }) });
  await assert.rejects(Search.run(err(403, 'quotaExceeded'), 'x', 'K'), /free allowance/);
  await assert.rejects(Search.run(err(400, 'keyInvalid'), 'x', 'K'), /didn't accept/);
  await assert.rejects(Search.run(err(403, 'accessNotConfigured'), 'x', 'K'), /isn't switched on/);
  await assert.rejects(Search.run({ fetchText: () => Promise.resolve('<a href="https://consent.youtube.com/">') }, 'x', ''), /cookie page/);
  await assert.rejects(Search.run({ fetchText: () => Promise.resolve('<html>new layout</html>') }, 'x', ''), /Google key/);

  console.log('search: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
