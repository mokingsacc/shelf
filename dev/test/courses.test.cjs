// Courses: playlist pages, episode numbers, Mo's seeded progress, ticking. Fake storage and network.
const assert = require('assert');
const Courses = require('../src/courses.js');

// A YouTube playlist page: first 100 in ytInitialData, the rest via "load more" (POST browse)
const vr = (id, title, len) => ({ playlistVideoRenderer: { videoId: id, title: { runs: [{ text: title }] }, lengthSeconds: String(len || 600), isPlayable: true } });
const cont = (tok) => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: tok } } } });
function playlist(name, nums) {
  const vids = nums.map((n, i) => vr(name.slice(0, 4) + String(i).padStart(6, '0') + 'x', 'HY USMLE Q #' + n + ' - ' + name, 500 + i));
  const pages = []; for (let i = 0; i < vids.length; i += 100) pages.push(vids.slice(i, i + 100));
  const page = (k) => pages[k].concat(k + 1 < pages.length ? [cont(name + ':' + (k + 1))] : []);
  const html = '<html><script>var ytcfg={"INNERTUBE_CLIENT_VERSION":"2.20260101.00.00","INNERTUBE_API_KEY":"AIzaFAKE"};</script><script>var ytInitialData = ' +
    JSON.stringify({ metadata: { playlistMetadataRenderer: { title: 'HY USMLE Qs - ' + name } }, contents: { list: { contents: page(0) } } }) + ';</script></html>';
  const more = (tok) => { const k = +tok.split(':')[1]; return JSON.stringify({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: page(k) } }] }); };
  return { html, more };
}
const range = (from, n, step) => Array.from({ length: n }, (_, i) => from + i * step);
const PL = {
  PLpeds0000000000: playlist('Pediatrics', range(387, 130, 8)), // #1107 is the 91st of 130: 70%
  PLobgyn000000000: playlist('OBGYN', range(1430, 60, 3)),      // #1607 is the last
  PLoph00000000000: playlist('Ophthalmology', range(200, 12, 5)),
  PLim000000000000: playlist('Internal Medicine', range(100, 150, 4)),
  PLpharm000000000: playlist('Pharmacology', range(50, 80, 9)),
  PLs1pharm0000000: playlist('Step 1 Pharmacology', range(10, 200, 2)),
  PLfm000000000000: playlist('Family Medicine', range(700, 40, 3))
};
const lock = (id, title, n) => ({ lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', metadata: { lockupMetadataViewModel: { title: { content: title } } }, contentImage: { badge: { text: n + ' videos' } } } });
const titles = { PLpeds0000000000: 'HY USMLE Qs - Pediatrics', PLobgyn000000000: 'HY USMLE Qs - OBGYN', PLoph00000000000: 'Ophthalmology', PLim000000000000: 'HY USMLE Qs - Internal Medicine', PLpharm000000000: 'Step 2 CK Pharmacology Qs', PLs1pharm0000000: 'Step 1 Pharmacology', PLfm000000000000: 'Family Medicine Qs' };
const chanHtml = 'var ytInitialData = ' + JSON.stringify({ tabs: Object.keys(titles).map((id) => lock(id, titles[id], 10)) }) + ';';

function setup(store, opts = {}) {
  store = store || {};
  const calls = [];
  let t = Date.parse('2026-10-04T16:30:00Z');
  const io = {
    load: (k) => (k in store ? store[k] : null),
    save: (k, v) => { store[k] = v; },
    now: () => t,
    apiKey: () => opts.key || '',
    watched: (v) => !!(opts.watched && opts.watched[v]),
    fetchText: async (url, headers) => {
      calls.push({ url, headers });
      if (opts.offline) throw new Error('offline');
      if (/@MehlmanMedical\/playlists/.test(url)) return chanHtml;
      const m = url.match(/playlist\?list=(\w+)/);
      if (m && PL[m[1]]) return PL[m[1]].html;
      if (m && opts.descPeds && m[1] === 'PLdesc0000000000') return playlist('Pediatrics', range(387, 130, 8).reverse()).html;
      throw new Error('404 ' + url);
    },
    postJSON: async (url, body, headers) => {
      calls.push({ url, body, headers, post: true });
      if (opts.noMore) throw new Error('refused');
      const name = body.continuation.split(':')[0];
      const pl = Object.values(PL).find((p) => p.html.includes(' - ' + name + '"'));
      return pl.more(body.continuation);
    }
  };
  return { c: Courses.create(io), store, calls, tick: (ms) => { t += ms; } };
}

(async () => {
  // Episode numbers from titles
  assert.strictEqual(Courses.epNumber('HY USMLE Q #1107 - Pediatrics'), 1107);
  assert.strictEqual(Courses.epNumber('Episode 42: Neonatal jaundice'), 42);
  assert.strictEqual(Courses.epNumber('OBGYN 1607 bleeding in pregnancy'), 1607);
  assert.strictEqual(Courses.epNumber('Step 2 CK 2025 review'), 0, 'a year is not an episode');
  assert.strictEqual(Courses.epNumber('Febrile seizures'), 0);
  assert.strictEqual(Courses.playlistId('https://www.youtube.com/playlist?list=PLabcdefghijk123'), 'PLabcdefghijk123');
  assert.strictEqual(Courses.playlistId('https://youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghijk123&index=3'), 'PLabcdefghijk123');
  assert.strictEqual(Courses.playlistId('https://youtu.be/dQw4w9WgXcQ'), '');
  assert.strictEqual(Courses.shortName('HY USMLE Qs - Pediatrics | Mehlman Medical'), 'Pediatrics');
  // Phone-shaped page: ytInitialData as an escaped string
  const phone = "var ytInitialData = '" + JSON.stringify({ a: vr('abcdefghijk', 'Q #5 - x') }).replace(/[{}"]/g, (c) => '\\x' + c.charCodeAt(0).toString(16)) + "';";
  assert.strictEqual(Courses.readVideos(Courses.initialData(phone)).items[0].id, 'abcdefghijk');
  // New-style lockups for videos
  const lockv = { x: { lockupViewModel: { contentId: 'zzzzzzzzzzz', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: 'HY USMLE Q #9' } } } } } };
  assert.strictEqual(Courses.readVideos(lockv).items[0].title, 'HY USMLE Q #9');
  assert.strictEqual(Courses.shortName('HY USMLE Q - Internal Medicine'), 'Internal');
  assert.strictEqual(Courses.shortName('Family Medicine Qs'), 'Family Medicine');
  assert.ok(new RegExp(Courses.SEED.courses[2].match, 'i').test('Ophtho Qs'), 'Ophtho matches');
  assert.ok(new RegExp(Courses.SEED.courses[1].match, 'i').test('Gyn questions'), 'Gyn matches');

  // First run: finds Mo's six on the channel's Playlists page, Step 2 pharm over Step 1
  let { c, store, calls } = setup();
  const misses = await c.seed();
  assert.deepStrictEqual(misses, []);
  assert.deepStrictEqual(c.list().map((x) => x.name), ['Paeds', 'OBGYN', 'Ophthal', 'Internal Med', 'Pharm', 'Family Med']);
  assert.strictEqual(c.list().find((x) => x.name === 'Pharm').id, 'PLpharm000000000');
  assert.ok(/SOCS=/.test(calls[0].headers.Cookie) && /Macintosh/.test(calls[0].headers['User-Agent']), 'desktop page with the consent cookie');
  await c.loadAll(true);
  // Paeds: 130 episodes across two pages, ticked up to #1107 = 91 of 130
  let p = c.progress('PLpeds0000000000');
  assert.strictEqual(p.total, 130, 'loaded past the first 100');
  assert.ok(calls.some((x) => x.post && x.headers['X-YouTube-Client-Version'] === '2.20260101.00.00' && /key=AIzaFAKE/.test(x.url)), 'load more uses the page\'s client version');
  assert.strictEqual(p.done, 91);
  assert.strictEqual(p.state, 'go');
  assert.strictEqual(p.next.n, 1115, 'next up is the one after 1107');
  // OBGYN 100% with a pin on 1607; Ophthal 100%; the rest not started
  p = c.progress('PLobgyn000000000');
  assert.strictEqual(p.state, 'done'); assert.strictEqual(p.done, 60);
  const ob = c.get('PLobgyn000000000'), pinned = Object.keys(ob.pins);
  assert.strictEqual(pinned.length, 1); assert.strictEqual(c.items(ob.id).find((x) => x.id === pinned[0]).n, 1607);
  assert.strictEqual(c.progress('PLoph00000000000').state, 'done');
  assert.strictEqual(c.progress('PLim000000000000').state, 'new');
  assert.strictEqual(c.progress('PLim000000000000').hours, '24 h');

  // Ticking
  const peds = 'PLpeds0000000000', arr = c.items(peds);
  c.tick(peds, arr[91].id, true);
  assert.strictEqual(c.progress(peds).done, 92);
  c.tick(peds, arr[91].id, false);
  assert.strictEqual(c.progress(peds).done, 91);
  const undo = c.tickUpTo(peds, 99);
  assert.strictEqual(c.progress(peds).done, 100);
  c.restore(peds, undo);
  assert.strictEqual(c.progress(peds).done, 91, 'undo puts it back');
  assert.deepStrictEqual(c.findNumber(peds, 1203), [102]);
  assert.strictEqual(c.where(arr[5].id).course.name, 'Paeds');
  assert.strictEqual(c.where(arr[5].id).i, 5);

  // Last one ticked with gaps earlier: next is the first gap, not nothing (froze Home before)
  {
    const r = setup({}, {});
    await r.c.add('PLoph00000000000');
    const it = r.c.items('PLoph00000000000');
    r.c.tick('PLoph00000000000', it[it.length - 1].id, true);
    const pr = r.c.progress('PLoph00000000000');
    assert.strictEqual(pr.notch, 0); assert.strictEqual(pr.next.id, it[0].id); assert.strictEqual(pr.state, 'go');
  }

  // Survives a relaunch: ticks from the small store, episodes from the cache
  const c2 = Courses.create({ load: (k) => store[k] ?? null, save: (k, v) => { store[k] = v; }, now: () => Date.now() });
  assert.strictEqual(c2.progress(peds).done, 91);
  // Episodes cache lost (web view cleared): ticks are still there once it loads again
  delete store[Courses.IKEY];
  const r3 = setup(store);
  assert.strictEqual(r3.c.progress(peds).total, 0);
  await r3.c.load(peds); assert.strictEqual(r3.c.progress(peds).done, 91);

  // Watched to the end in the player counts, unless unticked by hand
  const r4 = setup(store, { watched: { [arr[95].id]: 1 } });
  assert.ok(r4.c.isDone(peds, arr[95].id));
  r4.c.tick(peds, arr[95].id, false);
  assert.ok(!r4.c.isDone(peds, arr[95].id));

  // Ticks follow the playlist's own order, not the numbers: a shuffled playlist ticks the videos above 1107
  const r5 = setup({}, { descPeds: true });
  await r5.c.add('https://www.youtube.com/playlist?list=PLdesc0000000000');
  const st = r5.c.raw(); st.courses.PLdesc0000000000.seed = { upTo: 1107, pct: 70 };
  await r5.c.load('PLdesc0000000000', true);
  assert.strictEqual(r5.c.items('PLdesc0000000000')[0].n, 1419, 'kept in YouTube\'s order');
  assert.strictEqual(r5.c.progress('PLdesc0000000000').done, 40, 'everything above 1107 in the list (40 of 130)');
  assert.strictEqual(r5.c.progress('PLdesc0000000000').next.n, 1099);

  // Load more refused: keeps the first 100, says so, and Mo's note waits for the full list
  const r6 = setup({}, { noMore: true });
  await r6.c.add('PLpeds0000000000');
  assert.strictEqual(r6.c.progress('PLpeds0000000000').total, 100);
  assert.strictEqual(r6.c.status('PLpeds0000000000').partial, -1);
  r6.c.raw().courses.PLpeds0000000000.seed = { upTo: 1107, pct: 70 };
  await r6.c.load('PLpeds0000000000', true);
  assert.ok(r6.c.get('PLpeds0000000000').seed, 'seed kept while the list is partial');
  assert.strictEqual(r6.c.progress('PLpeds0000000000').done, 0);

  // Adding: bad link, already there, offline
  await assert.rejects(r6.c.add('https://youtu.be/dQw4w9WgXcQ'), /not a playlist link/);
  await assert.rejects(r6.c.add('PLpeds0000000000'), /Already on your shelf/);
  const r7 = setup({}, { offline: true });
  await assert.rejects(r7.c.add('PLpeds0000000000'), /offline/);
  // First run offline: every name is a miss, retried next time
  const m7 = await r7.c.seed();
  assert.strictEqual(m7.length, 6);
  const r8 = setup(r7.store);
  assert.deepStrictEqual(await r8.c.seed(), []);
  assert.strictEqual(r8.c.list().length, 6, 'retried and found');

  // Remove keeps ticks for a re-add
  r8.c.remove(peds); assert.strictEqual(r8.c.get(peds), null);

  // Google key: the official list instead of the page
  const api = setup({}, { key: 'AIzaKEY' });
  api.c.raw(); // fetchText answers 404 for googleapis -> falls back to the page
  const ca = await api.c.add('PLoph00000000000');
  assert.strictEqual(api.c.progress(ca.id).total, 12);
  assert.ok(api.calls.some((x) => /googleapis/.test(x.url)) && api.calls.some((x) => /playlist\?list=/.test(x.url)), 'tries the key, falls back to the page');

  console.log('courses: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
