// Library: sections, adding channels/podcasts, refresh, new counts. Fake storage and network.
const assert = require('assert');
const fs = require('fs');
global.Core = require('../src/core.js');
global.Feeds = require('../src/feeds.js');
const Library = require('../src/library.js');
const fx = (n) => fs.readFileSync(__dirname + '/fixtures/' + n, 'utf8');

function setup(routes, store) {
  store = store || {};
  const calls = [];
  const t = Date.parse('2026-10-04T12:00:00Z');
  const io = {
    load: (k) => (k in store ? store[k] : null),
    save: (k, v) => { store[k] = v; },
    now: () => t,
    fetchText: (url, headers) => {
      calls.push({ url, headers });
      for (const [re, body] of routes) if (re.test(url)) return typeof body === 'function' ? body(url) : Promise.resolve(body);
      return Promise.reject(new Error('offline: ' + url));
    }
  };
  return { lib: Library.create(io), store, calls };
}
const ytFeed = fx('yt-feed.xml');
const pod = fx('podcast.xml');
const page = fx('channel.html');

(async () => {
  // Seeds and sections
  let { lib, store } = setup([]);
  assert.deepStrictEqual(lib.sections().map((s) => s.name), ['Medicine', 'Entertainment', 'Sleep']);
  assert.strictEqual(lib.section('sleep').kind, 'audio');
  const rev = lib.addSection('Revision', 'video');
  assert.strictEqual(rev.id, 'revision');
  assert.throws(() => lib.addSection('medicine'), /already have/);
  assert.throws(() => lib.addSection('  '), /name/);
  assert.ok(lib.moveSection('revision', -1));
  assert.deepStrictEqual(lib.sections().map((s) => s.id), ['med', 'ent', 'revision', 'sleep']);
  assert.ok(lib.renameSection('revision', 'Step 2'));
  assert.strictEqual(Library.create({ load: (k) => store[k], save() {} }).section('revision').name, 'Step 2', 'persists');

  // Add by @handle: page fetch with consent cookie, then the Shorts-free feed
  let r = setup([[/youtube\.com\/@/, page], [/playlist_id=UULF/, ytFeed]]);
  const ch = await r.lib.add('https://www.youtube.com/@DirtyMedicine', 'med');
  assert.strictEqual(ch.id, 'UCbbbbbbbbbbbbbbbbbbbbbb', 'id from the channel page');
  assert.strictEqual(ch.type, 'youtube');
  assert.strictEqual(ch.section, 'med');
  assert.ok(/SOCS/.test(r.calls[0].headers.Cookie), 'consent cookie sent');
  assert.ok(r.calls[1].url.includes('UULFbbbbbbbbbbbbbbbbbbbbbb'));
  assert.strictEqual(r.lib.items(ch.id).length, 2);
  assert.strictEqual(r.lib.newCount(ch.id), 0, 'nothing is "new" the moment you add a channel');

  // New upload appears on refresh -> counted, then seen
  const newer = ytFeed.replace('<entry>', '<entry><yt:videoId>aaaaaaaaaa3</yt:videoId><title>Hyponatremia</title><published>2026-10-04T11:00:00+00:00</published></entry><entry>');
  const lib2 = Library.create({ load: (k) => r.store[k] ?? null, save: (k, v) => { r.store[k] = v; }, now: () => Date.parse('2026-10-04T13:00:00Z'),
    fetchText: (u) => /UULF/.test(u) ? Promise.resolve(newer) : Promise.reject(new Error('x')) });
  await lib2.refreshAll(true);
  assert.strictEqual(lib2.newCount(ch.id), 1);
  assert.strictEqual(lib2.sectionNewCount('med'), 1);
  assert.strictEqual(lib2.fresh()[0].id, 'aaaaaaaaaa3');
  assert.strictEqual(lib2.fresh()[0].sourceName, ch.name);
  lib2.markSeen(ch.id);
  assert.strictEqual(lib2.newCount(ch.id), 0);

  // Refresh failure keeps the old list and reports the error
  const lib3 = Library.create({ load: (k) => r.store[k] ?? null, save() {}, now: () => 0, fetchText: () => Promise.reject(new Error('offline')) });
  const c3 = await lib3.refresh(ch.id, true);
  assert.strictEqual(c3.ok, false);
  assert.strictEqual(lib3.status(ch.id).error, 'offline');

  // Cache survives a relaunch
  lib2.saveCache();
  const lib4 = Library.create({ load: (k) => r.store[k] ?? null, save() {}, now: () => 0, fetchText: () => Promise.reject(new Error('offline')) });
  assert.strictEqual(lib4.items(ch.id).length, 3);

  // Empty Shorts-free feed falls back to the full channel feed
  const empty = ytFeed.replace(/<entry>[\s\S]*<\/entry>/, '');
  r = setup([[/UULF/, empty], [/channel_id=/, ytFeed]]);
  const ch2 = await r.lib.add('UCgF2C3zwV2-Ycq9fxXDZqmA', 'ent');
  assert.strictEqual(r.lib.items(ch2.id).length, 2);
  assert.strictEqual(ch2.name, 'Dirty Medicine', 'name from the feed author');

  // Consent page -> plain-words error
  r = setup([[/youtube\.com\/@/, '<html><form action="https://consent.youtube.com/save"></form></html>']]);
  await assert.rejects(r.lib.add('@DirtyMedicine', 'med'), /cookie page/);

  // Podcast by feed URL (private Patreon link is flagged)
  r = setup([[/megaphone|patreon/, pod]]);
  const p1 = await r.lib.add('https://feeds.megaphone.fm/finvshistory', 'sleep');
  assert.strictEqual(p1.type, 'podcast');
  assert.strictEqual(p1.name, 'Fin vs History');
  assert.strictEqual(p1.private, false);
  const p2 = await r.lib.add('https://www.patreon.com/rss/finvshistory?auth=secret123', 'sleep');
  assert.strictEqual(p2.private, true);
  assert.notStrictEqual(p1.id, p2.id);

  // Podcast by name in an audio section -> Apple search
  r = setup([[/itunes\.apple\.com/, JSON.stringify({ results: [{ feedUrl: 'https://example.com/foc.xml' }] })], [/example\.com\/foc/, pod]]);
  const p3 = await r.lib.add('Fall of Civilizations', 'sleep');
  assert.strictEqual(p3.url, 'https://example.com/foc.xml');
  r = setup([[/itunes\.apple\.com/, JSON.stringify({ results: [] })]]);
  await assert.rejects(r.lib.add('Nothing Here', 'sleep'), /No podcast called/);

  // Channel by name in a video section -> YouTube's channel search page
  r = setup([[/results\?/, '..."channelRenderer":{"channelId":"UCcccccccccccccccccccccc","title"...'], [/UULF/, ytFeed]]);
  const c5 = await r.lib.add('Breaking Points', 'ent');
  assert.strictEqual(c5.id, 'UCcccccccccccccccccccccc');
  r = setup([[/results\?/, '<html>no results</html>']]);
  await assert.rejects(r.lib.add('zzzz', 'ent'), /Paste a link/);

  // Removing a section moves its channels rather than deleting them
  r = setup([[/UULF/, ytFeed]]);
  await r.lib.add('UCgF2C3zwV2-Ycq9fxXDZqmA', 'ent');
  assert.strictEqual(r.lib.removeSection('ent'), 'med');
  assert.strictEqual(r.lib.source('UCgF2C3zwV2-Ycq9fxXDZqmA').section, 'med');

  // First-run seeding reports misses in plain words and runs once
  r = setup([[/megaphone/, pod]]);
  const out = await r.lib.seed();
  assert.strictEqual(out.length, Library.SEED_SOURCES.length);
  assert.strictEqual(out.filter((x) => x.ok).length, 1, 'only the reachable feed resolves offline');
  assert.ok(r.lib.seedMisses.every((m) => m.error && m.section));
  assert.deepStrictEqual(await r.lib.seed(), [], 'seeds only once');

  // Garbage input
  await assert.rejects(r.lib.add('', 'med'), /doesn't look like/);

  console.log('library: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
