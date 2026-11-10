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

    // The phone-shaped page hides ytInitialData in an escaped string; still readable
  {
    const data = { contents: [{ videoRenderer: { videoId: 'abcdefghijk', title: { runs: [{ text: 'Fin vs History: Emu War' }] }, lengthText: { simpleText: '1:02:03' }, ownerText: { runs: [{ text: 'Fin vs History', navigationEndpoint: { browseEndpoint: { browseId: 'UCaaaaaaaaaaaaaaaaaaaaaa' } } }] } } }] };
    const html = "<script>var ytInitialData = '" + JSON.stringify(data).replace(/[{}"\[\]:]/g, (c) => '\\x' + c.charCodeAt(0).toString(16)) + "';</script>";
    const r = await Search.run({ fetchText: async () => html }, 'fin vs history', '');
    assert.strictEqual(r.length, 1); assert.strictEqual(r[0].dur, 3723);
  }

  // Real results pages (trimmed): joint bylines, lengths, Shorts, shows
  {
    const fs = require('fs');
    const fx = (n) => fs.readFileSync(__dirname + '/fixtures/' + n, 'utf8');
    const ezra = Search.fromPage(fx('yt-results-ezra.html')), vids = ezra.filter((x) => x.kind === 'video');
    assert.deepStrictEqual(vids.map((x) => x.id), ['9GLdGc9OX-A', 'A_156w0aYtU', 'YW7T88lOitY', 'wvYKx-USiZQ', 'HjurAWAr_nY']);
    assert.strictEqual(ezra[0].kind, 'channel'); assert.strictEqual(ezra[0].title, 'The Ezra Klein Show');
    assert.strictEqual(vids[0].dur, 4015);
    assert.strictEqual(vids[0].channel, 'The Ezra Klein Show'); assert.strictEqual(vids[0].channelId, 'UCnxuOd8obvLLtf5_-YKFbiQ');
    assert.strictEqual(vids[1].channelId, 'UCnxuOd8obvLLtf5_-YKFbiQ');
    assert.strictEqual(vids[2].channel, 'The Majority Report w/ Sam Seder'); assert.strictEqual(vids[2].channelId, 'UC-3jIAlnQmbbVMV6gR7K8aQ'); // single channel: browseEndpoint
    assert.strictEqual(vids[2].dur, 1867);
    assert.ok(vids.every((x) => x.dur > 0 && x.channelId && x.thumb.indexOf(x.id) > 0));
    assert.deepStrictEqual(ezra.shows, []);
    const fin = Search.fromPage(fx('yt-results-fin.html')), fv = fin.filter((x) => x.kind === 'video');
    assert.deepStrictEqual(fv.map((x) => x.id), ['wCSVyeUoQIg', 'VHOh2OtXX3g', 'IKHL3Fy-EmI']);
    assert.deepStrictEqual(fv.map((x) => x.dur), [2690, 3613, 1638]);
    assert.strictEqual(fv[0].channel, 'FinTaylor'); assert.strictEqual(fv[0].channelId, 'UCcQdXzWsosXv_e_wpfZHZlw');
    assert.strictEqual(fv[2].channel, 'Drew Binsky'); assert.strictEqual(fv[2].channelId, 'UC0Ize0RLIbGdH5x4wI45G-A');
    assert.strictEqual(fin[0].kind, 'channel'); assert.strictEqual(fin[0].id, 'UCcQdXzWsosXv_e_wpfZHZlw');
    assert.strictEqual(fin.shows.length, 1);
    assert.strictEqual(fin.shows[0].title, 'Fin vs History'); assert.strictEqual(fin.shows[0].channelId, 'UCcQdXzWsosXv_e_wpfZHZlw');
    assert.strictEqual(fin.shows[0].list, 'PLcolhncWEZ9lIkp2Y2QpoAkoR_gsTw-QF');
    // No Short and no video from inside a show card comes out; every result is a video or a channel
    for (const r of [ezra, fin]) {
      assert.ok(r.every((x) => x.kind === 'video' || x.kind === 'channel'));
      assert.ok(!r.some((x) => /^(S-sdqO_zR_E|pIZtaqPqxyM)$/.test(x.id)));
    }
    const shortIds = Array.from(new Set((fx('yt-results-ezra.html').match(/\/shorts\/[\w-]{11}/g) || []).map((t) => t.slice(8))));
    assert.ok(shortIds.length > 0);
    for (const id of shortIds) assert.ok(!ezra.some((x) => x.id === id), 'a Short came out: ' + id);
    // The text route still serves bare fragments, and pageData reads both spellings
    assert.strictEqual(Search.fromPage('"channelRenderer":{"channelId":"UCcccccccccccccccccccccc","title":{"simpleText":"Bare"}}')[0].title, 'Bare');
    assert.strictEqual(Search.fromText('x').shows.length, 0);
    assert.deepStrictEqual(Search.pageData('window["ytInitialData"] = {"a":"}\\"{","b":{}};'), { a: '}"{', b: {} });
    assert.strictEqual(Search.pageData('var ytInitialData = {"a":'), null);
    // A joint byline without its dialog: the name is cut, the id is found elsewhere in the renderer
    const odd = Search.fromPage(JSON.stringify({ x: [{ videoRenderer: { videoId: 'zzzzzzzzzz1', title: { simpleText: 'Odd' }, ownerText: { runs: [{ text: 'Show A and 2 more' }] }, t: { browseId: 'UCeeeeeeeeeeeeeeeeeeeeee' } } }] }));
    assert.strictEqual(odd[0].channel, 'Show A'); assert.strictEqual(odd[0].channelId, 'UCeeeeeeeeeeeeeeeeeeeeee'); assert.strictEqual(odd[0].dur, 0);
  }
console.log('search: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
