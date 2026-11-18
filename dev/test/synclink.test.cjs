// Device sync engine (synclink.js): several devices, each with the real Library, Courses and Marks modules and an
// in-memory io, talking to the REAL sync store (sync-server/functions/api/sync.js over the SQLite stand-in for D1),
// with node's WebCrypto and one fake clock. Hand-written cases, then three devices with random edits
// (SEED=n to repeat one run, ROUNDS=n for more). Plain node.
const assert = require('assert');
const zlib = require('zlib');
const { webcrypto, createHash, createDecipheriv } = require('crypto');
global.Core = require('../src/core.js');
global.Feeds = require('../src/feeds.js');
global.Courses = require('../src/courses.js');
global.Sync = require('../src/sync.js');
const Sync = global.Sync;
const Library = require('../src/library.js');
const Courses = global.Courses;
const Marks = require('../src/marks.js');
const SyncLink = require('../src/synclink.js');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const clone = (x) => JSON.parse(JSON.stringify(x));
const DOCS = SyncLink.DOCS;
const URL0 = 'https://sync.test/api/sync';
let clock = Date.parse('2026-11-18T09:00:00Z');
const tick = (ms) => { clock += ms == null ? 1 : ms; return clock; };
const SEED = +(process.env.SEED || Math.floor(Math.random() * 1e9));
const ROUNDS = +(process.env.ROUNDS || 400);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ----- Pretend internet for the modules: podcast feeds and one playlist page -----
const feedXml = (url) => { const name = decodeURIComponent(url.split('/').pop()); return `<rss><channel><title>${name}</title><item><title>E1</title><guid>${name}-e1</guid><enclosure url="https://a.example/1.mp3"/><pubDate>Sun, 04 Oct 2026 11:00:00 GMT</pubDate></item></channel></rss>`; };
const PL = { PLpeds0000000000: 'Pediatrics', PLobgyn000000000: 'OBGYN' };
const vidsOf = (pid) => Array.from({ length: 8 }, (_, i) => pid.slice(2, 6) + String(i).padStart(6, '0') + 'q');
const plHtml = (url) => {
  const pid = (url.match(/list=(\w+)/) || [])[1];
  const vr = (id, i) => ({ playlistVideoRenderer: { videoId: id, title: { runs: [{ text: 'HY USMLE Q #' + (100 + i) + ' - ' + PL[pid] } ] }, lengthSeconds: '600', isPlayable: true } });
  return 'var ytInitialData = ' + JSON.stringify({ metadata: { playlistMetadataRenderer: { title: 'HY USMLE Qs - ' + PL[pid] } }, contents: { list: { contents: vidsOf(pid).map(vr) } } }) + ';';
};
const plUrl = (pid) => 'https://www.youtube.com/playlist?list=' + pid;
// The channel's Playlists page, for the seed list (Courses.seed)
const lockup = (id, title) => ({ lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', metadata: { lockupMetadataViewModel: { title: { content: title } } }, contentImage: { badge: { text: '8 videos' } } } });
const chanHtml = 'var ytInitialData = ' + JSON.stringify({ tabs: Object.keys(PL).map((pid) => lockup(pid, 'HY USMLE Qs - ' + PL[pid])) }) + ';';

(async () => {
  const { onRequest } = await import('../../sync-server/functions/api/sync.js');
  const { FakeD1 } = await import('../../sync-server/test/fake-d1.mjs');
  const DB = new FakeD1();
  const wipe = () => { try { DB.db.exec('DELETE FROM shelves; DELETE FROM docs;'); } catch (e) {} };
  async function serverPost(url, text) {
    const request = new Request(url, { method: 'POST', body: text, headers: { 'content-type': 'text/plain' } });
    const res = await onRequest({ request, env: { DB } });
    return { status: res.status, text: await res.text() };
  }

  // ----- One device: real modules, a videos map and its removals, podcast places, prefs (stamped like app.js) -----
  const PREF_SHARED = Sync.PREF_FIELDS.concat(['rates', 'at']);
  function prefShared(p) { const o = {}, r = p.rates || {}; Sync.PREF_FIELDS.forEach((k) => { o[k] = JSON.stringify(p[k]); }); Object.keys(r).forEach((k) => { o['rates.' + k] = JSON.stringify(r[k]); }); return o; }
  function device(name, opts = {}) {
    const store = {};
    const dv = { name, store, posts: [], statuses: [], net: 'ok', hook: null, backups: 0, backupOk: true, adopts: {}, saves: 0 };
    const sio = { load: (k) => (k in store ? store[k] : null), save: (k, v) => { store[k] = v; dv.saves++; }, now: () => clock };
    dv.lib = Library.create(Object.assign({}, sio, { fetchText: async (url) => feedXml(url) }));
    // dv.chanGate: a promise the seed list's channel page waits for (a seed still loading)
    dv.cs = Courses.create(Object.assign({}, sio, { fetchText: async (url) => { if (/\/playlists$/.test(url)) { if (dv.chanGate) await dv.chanGate; return chanHtml; } return plHtml(url); }, apiKey: () => '', watched: () => false }));
    dv.mk = Marks.create(sio);
    dv.videos = {}; dv.gone = { v: {} }; dv.audio = {};
    dv.prefs = { look: 'dark', apiKey: 'SECRETKEY123', open: { med: true } };
    dv.snap = prefShared(dv.prefs);
    dv.savePrefs = () => { const cur = prefShared(dv.prefs), t = clock; Object.keys(Object.assign({}, dv.snap, cur)).forEach((k) => { if (dv.snap[k] !== cur[k]) { dv.prefs.at = dv.prefs.at || {}; dv.prefs.at[k] = t; } }); dv.snap = cur; };
    const inPlace = (into, from) => {
      Object.keys(into).forEach((k) => { if (!(k in from)) delete into[k]; });
      Object.keys(from).forEach((k) => { if (into[k] && typeof into[k] === 'object') { const o = into[k]; Object.keys(o).forEach((x) => delete o[x]); Object.assign(o, from[k]); } else into[k] = from[k]; });
    };
    const count = (d) => { dv.adopts[d] = (dv.adopts[d] || 0) + 1; };
    dv.docs = {
      videos: { read: () => ({ items: dv.videos, gone: dv.gone }), adopt: (m) => { count('videos'); inPlace(dv.videos, m.items); dv.gone = clone(m.gone); } },
      audio: { read: () => dv.audio, adopt: (m) => { count('audio'); inPlace(dv.audio, m); } },
      library: { read: () => dv.lib.exportState(), adopt: (m) => { count('library'); dv.lib.adopt(m); } },
      courses: { read: () => dv.cs.exportState(), adopt: (m) => { count('courses'); dv.cs.adopt(m); } },
      marks: { read: () => dv.mk.exportState(), adopt: (m) => { count('marks'); dv.mk.adopt(m); } },
      // As app.js: only the shared fields are copied in, and the snapshot is taken again so nothing gets a new time
      prefs: { read: () => dv.prefs, adopt: (m) => { count('prefs'); PREF_SHARED.forEach((k) => { if (k in m) dv.prefs[k] = clone(m[k]); else delete dv.prefs[k]; }); dv.snap = prefShared(dv.prefs); } }
    };
    const io = {
      get: sio.load, set: (k, v) => { store[k] = v; }, del: (k) => { delete store[k]; },
      post: async (url, text) => {
        const msg = JSON.parse(text);
        dv.posts.push(msg);
        await new Promise((r) => setImmediate(r));
        if (dv.net === 'down') throw new TypeError('Load failed');
        if (dv.net === 500) return { status: 500, text: '{"ok":false,"error":"server"}' };
        const r = await serverPost(url, text);
        if (dv.net === 'garble' && msg.op === 'get' && r.status === 200) {
          const j = JSON.parse(r.text), names = DOCS.filter((d) => j.docs[d]);
          if (names.length) j.docs[names[names.length - 1]].body = 'z1:' + Buffer.from('this is not a sealed doc at all, not at all').toString('base64');
          r.text = JSON.stringify(j);
        }
        if (dv.hook) { const h = dv.hook; dv.hook = null; await h(msg, r); }
        if (dv.each) await dv.each(msg, r);
        dv.statuses.push(r.status);
        return r;
      },
      now: () => clock, subtle: webcrypto.subtle, random: (k) => webcrypto.getRandomValues(new Uint8Array(k)),
      url: URL0, linkBase: 'https://shelf.test/', docs: dv.docs,
      backup: () => { dv.backups++; return dv.backupOk; }, changed: () => {}
    };
    Object.assign(io, opts.io || {});
    dv.engine = SyncLink.create(io);
    dv.key = () => (dv.engine.state().link.split('#sync=')[1] || '');
    dv.read = (d) => clone(dv.docs[d].read());
    dv.all = () => { const o = {}; DOCS.forEach((d) => { o[d] = Sync.canon(dv.docs[d].read(), d); }); return o; };
    dv.puts = (d) => dv.posts.filter((p) => p.op === 'put' && (!d || p.doc === d)).length;
    // Edits, as the app makes them (each one tells the engine, as rawSet does)
    dv.spot = (id, t) => { tick(); dv.videos[id] = Object.assign(dv.videos[id] || { id, dur: 600, title: 'Video ' + id }, { t, updated: clock }); dv.engine.touched('videos'); };
    dv.dropVideo = (id) => { tick(); const v = dv.videos[id]; delete dv.videos[id]; dv.gone.v[id] = clock; dv.engine.touched('videos'); return v; };
    dv.undoVideo = (id, v) => { tick(); dv.videos[id] = Object.assign(v, { updated: clock }); delete dv.gone.v[id]; dv.engine.touched('videos'); };
    dv.place = (g, t) => { tick(); dv.audio[g] = Object.assign(dv.audio[g] || { url: 'https://a.example/' + g + '.mp3', title: 'Episode ' + g }, { t, updated: clock }); dv.engine.touched('audio'); };
    dv.speed = (k, r) => { tick(); dv.prefs.rates = dv.prefs.rates || {}; dv.prefs.rates[k] = r; dv.savePrefs(); dv.engine.touched('prefs'); };
    dv.addChannel = async (nm) => { tick(); const s = await dv.lib.add('https://feeds.example/' + encodeURIComponent(nm), 'med'); dv.engine.touched('library'); return s; };
    dv.dropChannel = (id) => { tick(); dv.lib.remove(id); dv.engine.touched('library'); };
    dv.addCourse = async (pid) => { tick(); try { await dv.cs.add(plUrl(pid), { name: PL[pid] }); } catch (e) {} dv.engine.touched('courses'); };
    dv.tick = (pid, i, on) => { tick(); dv.cs.tick(pid, vidsOf(pid)[i], on); dv.engine.touched('courses'); };
    dv.mark = (title) => { tick(); const m = dv.mk.add({ vid: 'abcdefghijk', title, t: 30 }); dv.engine.touched('marks'); return m; };
    dv.dropMark = (id) => { tick(); const m = dv.mk.remove(id); dv.engine.touched('marks'); return m; };
    dv.undoMark = (m) => { tick(); dv.mk.restore(m); dv.engine.touched('marks'); };
    dv.note = (id, s) => { tick(); dv.mk.setNote(id, s); dv.engine.touched('marks'); };
    return dv;
  }
  const isTicked = (dv, pid, i) => { const c = dv.cs.get(pid); return !!c && c.ticks[vidsOf(pid)[i]] === 1; };
  const allSame = (devs) => DOCS.every((d) => devs.every((x) => Sync.same(x.docs[d].read(), devs[0].docs[d].read(), d)));
  const diffDocs = (a, b) => DOCS.filter((d) => !Sync.same(a.docs[d].read(), b.docs[d].read(), d));
  // Every device checks (pushing at once) until nothing changes
  async function settle(devs) { for (let i = 0; i < 4; i++) for (const x of devs) await x.engine.flush(); }

  // What the store holds for a shelf, opened with the shelf key the way the wire format says, independently of the engine
  const shaHex = (s) => createHash('sha256').update(s).digest('hex');
  function stored(key, doc) {
    const row = DB.db.prepare('SELECT body FROM docs WHERE shelf = ? AND doc = ? AND slot = 0').get(shaHex('shelf sync id:' + key), doc);
    if (!row) return null;
    const b = Buffer.from(row.body.slice(3), 'base64'), aes = createHash('sha256').update('shelf sync aes:' + key).digest();
    const dc = createDecipheriv('aes-256-gcm', aes, b.subarray(0, 12)); dc.setAAD(Buffer.from(doc)); dc.setAuthTag(b.subarray(b.length - 16));
    return zlib.gunzipSync(Buffer.concat([dc.update(b.subarray(12, b.length - 16)), dc.final()])).toString();
  }
  const rows = (key) => DB.db.prepare('SELECT doc, body FROM docs WHERE shelf = ? AND slot = 0').all(shaHex('shelf sync id:' + key));

  // A device with a bit of everything
  async function filled(name, tag) {
    const dv = device(name);
    await dv.addChannel('Channel ' + tag);
    await dv.addCourse('PLpeds0000000000');
    dv.tick('PLpeds0000000000', tag === 'A' ? 0 : 1, true);
    dv.mark('Mark from ' + tag);
    dv.spot('vid' + tag + 'aaaaaaa', 120);
    dv.place('ep' + tag, 300);
    dv.speed('v:UC' + tag, tag === 'A' ? 1.5 : 1.75);
    return dv;
  }

  // ================================================================ Start
  {
    wipe(); tick(60000);
    const A = await filled('A', 'A');
    const r = await A.engine.start();
    ok(r.ok && A.engine.state().on && /^https:\/\/shelf\.test\/#sync=[0-9a-f]{64}$/.test(A.engine.state().link), 'start: on, with a link: ' + JSON.stringify(r));
    eq(DOCS.map((d) => A.puts(d)), [1, 1, 1, 1, 1, 1], 'start: one put for each of the six docs');
    eq(A.backups, 1, 'start: a backup was made first');
    const rs = rows(A.key());
    eq(rs.map((x) => x.doc).sort(), DOCS.slice().sort(), 'start: the store holds the six docs');
    // (words with a space, a colon or a quote can't turn up in base64 by chance)
    const words = ['Channel A', 'Mark from A', 'Video vidA', 'Episode epA', 'SECRETKEY123', 'Pediatrics', 'vidAaaaaaaa', 'v:UCA', '"dark"'];
    ok(rs.every((x) => /^z1:[A-Za-z0-9+/=]+$/.test(x.body) && words.every((w) => !x.body.includes(w) && !Buffer.from(x.body.slice(3), 'base64').toString('latin1').includes(w))), 'start: the stored bodies are sealed: no name from the data can be read');
    const posts = JSON.stringify(A.posts);
    ok(!posts.includes(A.key()) && words.every((w) => !posts.includes(w)), 'start: the key and the data never go out in the clear');
    ok(JSON.parse(stored(A.key(), 'library')).sources && stored(A.key(), 'marks').includes('Mark from A'), 'start: opened with the key, the stored docs hold the data');
    const p = JSON.parse(stored(A.key(), 'prefs'));
    ok(!('apiKey' in p) && !('look' in p) && !('open' in p) && p.rates['v:UCA'] === 1.5 && p.at['rates.v:UCA'] > 0, 'prefs: only shared fields leave: ' + JSON.stringify(p));
    ok(!stored(A.key(), 'prefs').includes('SECRETKEY') && !stored(A.key(), 'library').includes('seedMisses'), 'prefs: apiKey never in the plaintext; device-only fields never leave');
    const again = await A.engine.start();
    ok(!again.ok && A.engine.state().on, 'start: a second start is refused while on');
    const before = A.posts.length; await A.engine.check();
    eq(A.posts.length - before, 1, 'start: a check with nothing new is one get and no put');
    ok(A.engine.state().lastOk === clock && !A.engine.state().lastErr && !A.engine.state().busy, 'start: lastOk set, no error');
    // Empty stores push too
    wipe(); const E = device('E'); await E.engine.start();
    eq(DOCS.map((d) => E.puts(d)), [1, 1, 1, 1, 1, 1], 'start: an empty device pushes all six docs too');
    // No backup, no sync
    const F = device('F'); F.backupOk = false;
    const rf = await F.engine.start();
    ok(!rf.ok && /copy of this device/.test(rf.reason) && !F.engine.state().on && F.posts.length === 0, 'start: when the backup fails, sync does not start and nothing goes out');
    // A device that can't scramble can't sync
    const G = device('G', { io: { CompressionStream: null } });
    const rg = await G.engine.start();
    ok(!rg.ok && /too old/.test(rg.reason) && !G.engine.state().on && G.posts.length === 0 && G.backups === 0, 'start: no CompressionStream: a plain reason, nothing else happens');
    const H = device('H', { io: { subtle: null } });
    ok(!(await H.engine.join('a'.repeat(64), 'add')).ok && H.posts.length === 0, 'join: no crypto.subtle: refused, nothing sent');
  }

  // ================================================================ Join with Add
  {
    wipe(); tick(60000);
    const A = await filled('A', 'A'), B = await filled('B', 'B');
    await A.engine.start();
    const bMark = B.mk.list()[0];
    const r = await B.engine.join(A.key(), 'add');
    ok(r.ok && B.engine.state().on && B.key() === A.key(), 'join add: B is on the same shelf: ' + JSON.stringify(r));
    eq(B.backups, 1, 'join add: B made a backup first');
    await A.engine.check();
    ok(allSame([A, B]), 'join add: after A checks, both devices are the same for every doc: ' + diffDocs(A, B));
    for (const x of [A, B]) {
      ok(isTicked(x, 'PLpeds0000000000', 0) && isTicked(x, 'PLpeds0000000000', 1), 'join add: both ticks on ' + x.name);
      ok(x.lib.sources().length === 2 && x.mk.count === 2 && x.videos.vidAaaaaaaa && x.videos.vidBaaaaaaa && x.audio.epA && x.audio.epB, 'join add: channels, marks, spots and places from both on ' + x.name);
      ok(x.prefs.rates['v:UCA'] === 1.5 && x.prefs.rates['v:UCB'] === 1.75, 'join add: both speeds on ' + x.name);
    }
    ok(B.mk.get(bMark.id) === bMark, 'join add: the mark object B already had is the same object after the merge');
    ok(B.prefs.look === 'dark' && B.prefs.apiKey === 'SECRETKEY123', 'join add: device-only prefs stay');
    // Changes flow both ways on the next checks
    tick(10000); B.dropMark(bMark.id); A.tick('PLpeds0000000000', 5, true); await A.addChannel('Channel A2');
    tick(9000); await B.engine.check(); await A.engine.check(); await B.engine.check();
    ok(allSame([A, B]) && !A.mk.get(bMark.id) && isTicked(B, 'PLpeds0000000000', 5) && B.lib.sources().length === 3, 'join add: a removal, a tick and a channel cross over after the next checks');
    // Joining the shelf it is already on is just a check
    const again = await B.engine.join(A.key(), 'add');
    ok(again.ok && again.same && B.backups === 1, 'join: the same link again is just a check, no new backup');
  }

  // ================================================================ An unstamped tick here against a stamped untick on the shelf
  {
    wipe(); tick(60000);
    const A = device('A');
    await A.addCourse('PLpeds0000000000');
    A.tick('PLpeds0000000000', 3, true); tick(1000); A.tick('PLpeds0000000000', 3, false);
    await A.engine.start();
    // B has the course from old code: ticked, no times at all
    const B = device('B');
    await B.addCourse('PLpeds0000000000');
    const raw = JSON.parse(B.store[Courses.KEY]); raw.courses.PLpeds0000000000.ticks[vidsOf('PLpeds0000000000')[3]] = 1; B.store[Courses.KEY] = JSON.stringify(raw);
    B.cs = Courses.create({ load: (k) => B.store[k] || null, save: (k, v) => { B.store[k] = v; }, now: () => clock, fetchText: async (u) => plHtml(u), apiKey: () => '', watched: () => false });
    ok(isTicked(B, 'PLpeds0000000000', 3) && !(B.cs.get('PLpeds0000000000').onAt || {})[vidsOf('PLpeds0000000000')[3]], 'unstamped: B has the tick with no time');
    // (the same pair merged plainly: the stamped untick would win)
    ok(Sync.mergeCourses(B.cs.exportState(), A.cs.exportState(), clock).courses.PLpeds0000000000.ticks[vidsOf('PLpeds0000000000')[3]] !== 1, 'unstamped: a plain merge would lose it');
    tick(5000);
    const r = await B.engine.join(A.key(), 'add');
    await A.engine.check();
    ok(r.ok && isTicked(B, 'PLpeds0000000000', 3) && isTicked(A, 'PLpeds0000000000', 3), 'unstamped: joining with Add keeps the tick, and it reaches A');
  }

  // ================================================================ Join with Replace
  {
    wipe(); tick(60000);
    const A = await filled('A', 'A'), B = await filled('B', 'B');
    A.prefs.goal = { name: 'Step 2 CK', date: '2026-12-22' }; A.savePrefs();
    await A.engine.start();
    const r = await B.engine.join(A.key(), 'replace');
    // (A's library has no removals record yet and a merged copy always has one, empty: the same shelf all the same)
    const MERGE = { videos: Sync.mergeVideos, audio: Sync.mergeAudio, library: Sync.mergeLibrary, courses: Sync.mergeCourses, marks: Sync.mergeMarks, prefs: Sync.mergePrefs };
    ok(r.ok && DOCS.every((d) => Sync.same(B.docs[d].read(), MERGE[d](A.read(d), A.read(d), clock), d)), 'join replace: B ends the same as A for every doc');
    ok(!B.videos.vidBaaaaaaa && !B.audio.epB && B.lib.sources().length === 1 && B.mk.count === 1 && !isTicked(B, 'PLpeds0000000000', 1), 'join replace: B\'s own things are gone (they are in its backup)');
    ok(B.prefs.look === 'dark' && B.prefs.apiKey === 'SECRETKEY123' && B.prefs.goal.date === '2026-12-22' && !B.prefs.rates['v:UCB'], 'join replace: device-only prefs stay, shared ones are the shelf\'s');
    await A.engine.check();
    ok(allSame([A, B]) && !A.videos.vidBaaaaaaa && !A.audio.epB && A.lib.sources().length === 1, 'join replace: after A\'s next check both are the same, and nothing of B\'s reached A');
    // A doc the shelf lacks is merged the Add way
    wipe(); tick(60000);
    const C = device('C'); await C.engine.start();
    DB.db.prepare('DELETE FROM docs WHERE shelf = ? AND doc = ?').run(shaHex('shelf sync id:' + C.key()), 'marks');
    const D = device('D'); const dm = D.mark('Kept mark');
    const rd = await D.engine.join(C.key(), 'replace');
    ok(rd.ok && D.mk.get(dm.id) && stored(C.key(), 'marks').includes('Kept mark'), 'join replace: a doc the shelf lacks is kept and pushed');
  }

  // ================================================================ A tick made while the get is in the air
  {
    wipe(); tick(60000);
    const A = device('A'), B = device('B');
    await A.addCourse('PLpeds0000000000');
    await A.engine.start(); await B.engine.join(A.key(), 'add');
    tick(20000); A.tick('PLpeds0000000000', 1, true); tick(9000); await A.engine.check(); // the shelf now has vid 1 ticked
    let made = false;
    B.hook = (msg) => { if (msg.op === 'get') { B.tick('PLpeds0000000000', 2, true); made = true; } };
    const adopts = B.adopts.courses || 0;
    await B.engine.check();
    ok(made && B.adopts.courses === adopts + 1, 'in the air: B ticked while its get was out, and the check then merged courses');
    ok(isTicked(B, 'PLpeds0000000000', 1) && isTicked(B, 'PLpeds0000000000', 2), 'in the air: B has both the shelf\'s tick and its own');
    tick(9000); await B.engine.check(); await A.engine.check();
    ok(isTicked(A, 'PLpeds0000000000', 2) && allSame([A, B]), 'in the air: the tick reaches A');
    // The same for a put: a tick while a put is out is pushed next time
    let putTick = false;
    B.each = (msg) => { if (msg.op === 'put' && !putTick) { putTick = true; B.tick('PLpeds0000000000', 4, true); } };
    B.mark('x'); tick(9000); await B.engine.check(); B.each = null;
    ok(putTick && isTicked(B, 'PLpeds0000000000', 4), 'in the air: a tick made while a put is out stays');
    tick(9000); await B.engine.check(); await A.engine.check();
    ok(isTicked(A, 'PLpeds0000000000', 4), 'in the air: and reaches A after the next check');
  }

  // ================================================================ Two devices pushing on the same base (409)
  {
    wipe(); tick(60000);
    const A = device('A'), B = device('B');
    await A.addCourse('PLpeds0000000000');
    await A.engine.start(); await B.engine.join(A.key(), 'add'); await A.engine.check();
    A.tick('PLpeds0000000000', 0, true); B.tick('PLpeds0000000000', 1, true); A.mark('A1'); B.mark('B1'); A.spot('v1', 10); B.spot('v2', 20);
    tick(100000);
    await Promise.all([A.engine.flush(), B.engine.flush()]);
    ok(A.statuses.concat(B.statuses).includes(409), 'same base: the race really happened (a 409)');
    await settle([A, B]);
    ok(allSame([A, B]) && [0, 1].every((i) => isTicked(A, 'PLpeds0000000000', i) && isTicked(B, 'PLpeds0000000000', i)) && A.mk.count === 2 && A.videos.v1 && A.videos.v2, 'same base: both converge with both edits');
    ok(!A.engine.state().lastErr && !B.engine.state().lastErr, 'same base: no error left');
  }

  // ================================================================ Store down, 500, a body that won't open; a wrong link
  {
    wipe(); tick(60000);
    const A = await filled('A', 'A'), B = await filled('B', 'B');
    await A.engine.start(); await B.engine.join(A.key(), 'add'); await A.engine.check();
    tick(20000); A.mark('new on A'); A.tick('PLpeds0000000000', 6, true); A.spot('v9', 99); A.speed('v:UCA', 2); await A.addChannel('Late channel');
    tick(100000); await A.engine.flush();
    for (const how of ['down', 500, 'garble']) {
      const snap = JSON.stringify(B.all()), adopts = JSON.stringify(B.adopts);
      B.net = how; tick(30000);
      await B.engine.check();
      const st = B.engine.state();
      ok(st.lastErr && st.errSince && JSON.stringify(B.all()) === snap && JSON.stringify(B.adopts) === adopts, 'failure ' + how + ': recorded (' + st.lastErr + '), nothing changed on the device');
    }
    const since = B.engine.state().errSince;
    ok(since > 0 && B.engine.state().lastOk < since, 'failure: errSince is the first failure');
    B.net = 'ok'; tick(30000);
    await B.engine.check();
    ok(!B.engine.state().lastErr && !B.engine.state().errSince && B.engine.state().lastOk === clock, 'failure: the next good check clears the error');
    ok(B.mk.list().some((m) => m.title === 'new on A') && isTicked(B, 'PLpeds0000000000', 6) && B.videos.v9 && B.prefs.rates['v:UCA'] === 2 && B.lib.sources().some((s) => s.name === 'Late channel'), 'failure: and brings everything over');
    // A wrong link: nothing changes, also when already on a shelf
    const C = await filled('C', 'C'), snapC = JSON.stringify(C.all());
    const rc = await C.engine.join('ab'.repeat(32), 'add');
    ok(!rc.ok && rc.reason === "That link doesn't match a shelf." && !C.engine.state().on && JSON.stringify(C.all()) === snapC && C.backups === 0, 'wrong link: 404, a plain reason, nothing changed, no backup');
    const keyB = B.key(), snapB = JSON.stringify(B.all());
    const rb = await B.engine.join('cd'.repeat(32), 'replace');
    ok(!rb.ok && B.key() === keyB && JSON.stringify(B.all()) === snapB, 'wrong link: a device already on a shelf stays on it, unchanged');
    ok(!(await C.engine.join('xyz', 'add')).ok, 'wrong link: a broken key is refused');
    // The store goes away (dropped): the next check puts everything back
    DB.db.exec('DELETE FROM shelves; DELETE FROM docs;');
    tick(100000); await A.engine.check();
    ok(!A.engine.state().lastErr && rows(A.key()).length === 6, 'store emptied: the next check puts every doc back');
    tick(100000); await B.engine.check(); await A.engine.check();
    ok(allSame([A, B]), 'store emptied: the devices carry on together');
  }

  // ================================================================ Off
  {
    wipe(); tick(60000);
    const A = device('A'), B = device('B');
    await A.engine.start(); await B.engine.join(A.key(), 'add');
    B.engine.off();
    ok(!B.engine.state().on && !(SyncLink.LINK in B.store), 'off: the link record is forgotten');
    const n0 = B.posts.length;
    B.mark('after off'); tick(100000); await B.engine.check(); await B.engine.flush(); B.engine.touched('marks');
    eq(B.posts.length, n0, 'off: no request after it');
    ok(B.mk.count === 1, 'off: local data stays');
    // Off while a check is out: that request finishes, nothing more goes and nothing is adopted
    A.mark('from A'); tick(100000); await A.engine.flush();
    const C = device('C'); await C.engine.join(A.key(), 'add');
    A.mark('second from A'); tick(100000); await A.engine.flush();
    C.hook = () => { C.engine.off(); };
    const n1 = C.posts.length, adopts = JSON.stringify(C.adopts);
    await C.engine.check();
    ok(C.posts.length === n1 + 1 && JSON.stringify(C.adopts) === adopts && !C.mk.list().some((m) => m.title === 'second from A'), 'off: during a check, the one request out ends it; nothing adopted, nothing more sent');
    // Started again: a new shelf
    const r = await B.engine.start();
    ok(r.ok && B.key() !== A.key(), 'off: starting again makes a new shelf');
  }

  // ================================================================ When things are pushed
  {
    wipe(); tick(60000);
    const A = device('A');
    await A.engine.start(); // pushes everything at once
    const p = (d) => A.puts(d);
    tick(10000); A.spot('v1', 10); await A.engine.check();
    eq(p('videos'), 1, 'timing: a spot 10 s after the last videos push waits');
    tick(70000); A.spot('v1', 80); await A.engine.check();
    eq(p('videos'), 1, 'timing: still within 90 s: waits');
    tick(11000); await A.engine.check();
    eq(p('videos'), 2, 'timing: 91 s after the last push: pushed');
    tick(5000); A.place('g1', 5); await A.engine.check();
    eq(p('audio'), 2, 'timing: audio pushed 96 s after its last push (the first was at start)');
    tick(1000); A.place('g1', 9); await A.engine.check();
    eq(p('audio'), 2, 'timing: audio again 1 s later waits');
    tick(1000); A.mark('m'); await A.engine.check();
    eq(p('marks'), 1, 'timing: a mark 1 s ago waits');
    tick(5000); await A.engine.check();
    eq(p('marks'), 1, 'timing: 5 s after the write still waits');
    tick(3000); await A.engine.check();
    eq(p('marks'), 2, 'timing: 8 s after the write: pushed');
    tick(1000); A.mark('m2'); A.speed('v:x', 2); A.spot('v1', 120);
    await A.engine.flush();
    eq([p('marks'), p('prefs'), p('videos')], [3, 2, 3], 'timing: flush pushes everything that differs at once');
    tick(1000); await A.engine.flush();
    eq([p('marks'), p('prefs'), p('videos')], [3, 2, 3], 'timing: nothing differs: flush pushes nothing');
    // Never two checks at once: a second call while one runs is run once after it
    let inflight = 0, most = 0;
    A.mark('m3'); tick(9000);
    const gets0 = A.posts.filter((x) => x.op === 'get').length;
    A.each = async () => { inflight++; most = Math.max(most, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; };
    await Promise.all([A.engine.check(), A.engine.check(), A.engine.check()]);
    A.each = null;
    eq(A.posts.filter((x) => x.op === 'get').length - gets0, 2, 'one at a time: three calls during one check make two checks in a row');
    ok(most <= 1, 'one at a time: never two requests out at once');
  }

  // ================================================================ Prefs: adopting writes no times
  {
    wipe(); tick(60000);
    const A = device('A'), B = device('B');
    A.speed('v:UCx', 1.25); A.prefs.autoNext = false; A.savePrefs();
    await A.engine.start(); await B.engine.join(A.key(), 'add');
    const atA = clone(A.prefs.at);
    eq([B.prefs.rates['v:UCx'], B.prefs.autoNext, B.prefs.at], [1.25, false, atA], 'prefs: B takes A\'s speeds with A\'s times, none of its own');
    tick(5000); B.prefs.look = 'light'; B.savePrefs();
    eq(B.prefs.at, atA, 'prefs: a later save of a device-only pref on B stamps nothing for what it adopted');
    tick(9000); await B.engine.check(); await A.engine.check();
    eq(A.prefs.at, atA, 'prefs: nothing flows back to A');
    ok(A.prefs.look === 'dark', 'prefs: look stays on its device');
  }

  // ================================================================ Too much to sync (413)
  {
    wipe(); tick(60000);
    const A = device('A'), B = device('B');
    await A.engine.start(); await B.engine.join(A.key(), 'add');
    // About 1.6 MB of text that doesn't shrink much
    const big = Array.from({ length: 40 }, () => require('crypto').randomBytes(30000).toString('base64'));
    big.forEach((t, i) => { A.videos['big' + String(i).padStart(8, '0')] = { id: 'big' + i, t: 1, updated: tick(), title: t }; });
    A.engine.touched('videos'); A.mark('small and fine');
    const snap = JSON.stringify(A.read('videos'));
    tick(100000); await A.engine.check();
    const st = A.engine.state();
    ok(A.statuses.includes(413) && /Too much to sync \(spots\)/.test(st.lastErr), 'too big: reported: ' + st.lastErr);
    ok(JSON.stringify(A.read('videos')) === snap, 'too big: nothing lost on the device');
    await B.engine.check();
    ok(B.mk.list().some((m) => m.title === 'small and fine'), 'too big: the other docs still went');
    big.forEach((t, i) => { delete A.videos['big' + String(i).padStart(8, '0')]; }); A.engine.touched('videos');
    tick(100000); await A.engine.check();
    ok(!A.engine.state().lastErr, 'too big: once smaller, the error clears');
  }

  // ================================================================ A new device that seeded itself joins: removals and unticks hold
  // A removed the seeded course Paeds and unticked three seeded OBGYN episodes. A fresh device seeds itself (the seed
  // list's ticks carry no times and the course no change time), then joins: none of it comes back, on either device.
  {
    const PE = 'PLpeds0000000000', OB = 'PLobgyn000000000', OFF = [1, 2, 3];
    const seedNow = async (dv) => { await dv.cs.seed(); await dv.cs.loadAll(); dv.engine.touched('courses'); };
    const setUpA = async () => {
      const A = device('A');
      await seedNow(A);
      ok(A.cs.get(PE) && A.cs.get(OB) && [0, 1, 2, 3, 4, 5, 6, 7].every((i) => isTicked(A, OB, i)) && isTicked(A, PE, 0), 'seeded join: A has both seeded courses, OBGYN all ticked');
      await A.engine.start();
      tick(60000); A.cs.remove(PE); A.engine.touched('courses');
      OFF.forEach((i) => A.tick(OB, i, false));
      await A.engine.flush();
      return A;
    };
    const holds = (x, what) => {
      ok(!x.cs.get(PE) && !x.cs.list().some((c) => c.id === PE), what + ': Paeds stays removed on ' + x.name);
      ok(OFF.every((i) => !isTicked(x, OB, i)), what + ': the three unticked OBGYN episodes stay unticked on ' + x.name + ': ' + JSON.stringify(x.cs.get(OB) && x.cs.get(OB).ticks));
      ok([0, 4, 5, 6, 7].every((i) => isTicked(x, OB, i)), what + ': the other OBGYN ticks stay on ' + x.name);
    };
    // Add: B seeded fully first
    wipe(); tick(60000);
    let A = await setUpA();
    tick(3 * 864e5);
    const B = device('B');
    await seedNow(B);
    ok(B.cs.get(PE) && isTicked(B, OB, 1) && Object.keys(JSON.parse(B.store[Courses.KEY]).auto || {}).length === 2, 'seeded join add: B seeded both courses itself and knows which ticks the seed list made');
    tick(1000);
    const r = await B.engine.join(A.key(), 'add');
    ok(r.ok, 'seeded join add: joined ' + JSON.stringify(r));
    for (let i = 0; i < 2; i++) { tick(10000); await A.engine.check(); await B.engine.check(); }
    for (const x of [A, B]) holds(x, 'seeded join add');
    ok(allSame([A, B]), 'seeded join add: both the same: ' + diffDocs(A, B));
    ok(!/"auto"/.test(stored(A.key(), 'courses')), 'seeded join add: the seed list\'s record of its own ticks is never sent');
    // B ticks one of them on purpose: that one is Mo's and goes everywhere
    tick(5000); B.tick(OB, 2, true); await B.engine.flush(); await A.engine.check();
    ok(isTicked(A, OB, 2) && isTicked(B, OB, 2) && !isTicked(A, OB, 1), 'seeded join add: a tick made on purpose afterwards still crosses');
    await B.cs.seed(); await B.cs.loadAll();
    ok(!B.cs.get(PE), 'seeded join add: seeding again on B leaves Paeds removed');

    // Replace, while the new device's seed is still loading
    wipe(); tick(60000);
    A = await setUpA();
    tick(3 * 864e5);
    const C = device('C');
    let open; C.chanGate = new Promise((res) => { open = res; });
    const seeding = seedNow(C);
    await new Promise((res) => setImmediate(res));
    tick(1000);
    const rc = await C.engine.join(A.key(), 'replace');
    ok(rc.ok, 'seeded join replace: joined while the seed list was still loading ' + JSON.stringify(rc));
    open(); await seeding;
    ok(!C.cs.get(PE), 'seeded join replace: the seed list, finishing after the join, does not add back the course Mo removed');
    for (let i = 0; i < 2; i++) { tick(10000); await C.engine.check(); await A.engine.check(); }
    for (const x of [A, C]) holds(x, 'seeded join replace');
    ok(allSame([A, C]), 'seeded join replace: both the same: ' + diffDocs(A, C));
  }

  // ================================================================ Real modules: exportState and adopt
  {
    tick(60000);
    const dv = device('M');
    const s1 = await dv.addChannel('Keep me'), s2 = await dv.addChannel('Drop me');
    const sec = dv.lib.section('med');
    const st = dv.lib.exportState(); st.sources[s1.id].name = 'changed'; ok(dv.lib.source(s1.id).name === 'Keep me', 'exportState is a deep copy (library)');
    const m = Sync.mergeLibrary(dv.lib.exportState(), { sections: [{ id: 'med', name: 'Renamed', kind: 'video' }, { id: 'new', name: 'New', kind: 'audio' }], sources: { [s1.id]: Object.assign(clone(s1), { name: 'Kept, renamed' }) }, at: { src: { [s1.id]: clock + 5 }, sec: { med: clock + 5, new: clock + 5 }, order: clock + 5 }, gone: { src: { [s2.id]: clock + 5 }, sec: {} } }, clock);
    const at0 = JSON.stringify(dv.lib.exportState().at), saves0 = dv.saves, rev0 = dv.lib.exportState().rev;
    dv.lib.adopt(m);
    ok(dv.lib.source(s1.id) === s1 && s1.name === 'Kept, renamed' && !dv.lib.source(s2.id), 'library adopt: the channel object is the same, refilled; the removed one is gone');
    ok(dv.lib.section('med') === sec && sec.name === 'Renamed' && dv.lib.section('new'), 'library adopt: the section object is the same, refilled; the new one is there');
    const after = dv.lib.exportState();
    ok(Sync.same(after, m, 'library') && JSON.stringify(after.at) === JSON.stringify(m.at) && JSON.stringify(after.at) !== at0, 'library adopt: the state is the merged copy, with its times and none new');
    ok(dv.saves === saves0 + 1 && after.rev === rev0 + 1 && JSON.parse(dv.store[Library.KEY]).sources[s1.id].name === 'Kept, renamed', 'library adopt: saved once');

    await dv.addCourse('PLpeds0000000000'); await dv.addCourse('PLobgyn000000000');
    dv.tick('PLpeds0000000000', 0, true);
    const c1 = dv.cs.get('PLpeds0000000000'), items = dv.cs.items('PLpeds0000000000');
    const cm = clone(dv.cs.exportState()); delete cm.courses.PLobgyn000000000; cm.courses.PLpeds0000000000.ticks[vidsOf('PLpeds0000000000')[3]] = 1; cm.courses.PLpeds0000000000.onAt[vidsOf('PLpeds0000000000')[3]] = clock - 5; cm.misses = [{ name: 'x' }];
    const csaves = dv.saves;
    dv.cs.adopt(cm);
    ok(dv.cs.get('PLpeds0000000000') === c1 && c1.ticks[vidsOf('PLpeds0000000000')[3]] === 1 && !dv.cs.get('PLobgyn000000000'), 'courses adopt: the course object is the same, refilled; the removed one is gone');
    ok(dv.cs.items('PLpeds0000000000') === items && items.length === 8, 'courses adopt: the episode lists stay as they are');
    const ce = dv.cs.exportState();
    ok(Sync.same(ce, cm, 'courses') && ce.courses.PLpeds0000000000.onAt[vidsOf('PLpeds0000000000')[3]] === clock - 5 && dv.cs.misses.length === 0, 'courses adopt: the merged copy, no new times, misses stay this device\'s');
    ok(dv.saves === csaves + 1 && JSON.parse(dv.store[Courses.KEY]).courses.PLpeds0000000000.ticks[vidsOf('PLpeds0000000000')[3]] === 1, 'courses adopt: saved once');

    const k1 = dv.mark('keep'), k2 = dv.mark('drop');
    const mm = clone(dv.mk.exportState()); mm.items = mm.items.filter((x) => x.id !== k2.id); mm.items[0].note = 'from elsewhere'; mm.items[0].m = clock + 1; mm.gone = { [k2.id]: clock + 1 };
    const msaves = dv.saves;
    dv.mk.adopt(mm);
    ok(dv.mk.get(k1.id) === k1 && k1.note === 'from elsewhere' && !dv.mk.get(k2.id) && dv.mk.count === 1, 'marks adopt: the mark object is the same, refilled; the removed one is gone');
    ok(Sync.same(dv.mk.exportState(), mm, 'marks') && dv.saves === msaves + 1 && JSON.parse(dv.store[Marks.KEY]).gone[k2.id] === clock + 1, 'marks adopt: the merged copy, saved once, no new times');
    tick(); const gm = dv.mk.remove(k1.id); tick(); dv.mk.restore(gm);
    ok(dv.mk.get(k1.id).m === clock && JSON.parse(dv.store[Marks.KEY]).items[0].m === clock, 'marks restore: an Undo stamps m now, so it beats its own removal');
    ok(Sync.mergeMarks(dv.mk.exportState(), { items: [], gone: { [k1.id]: clock - 1 } }, clock).items.length === 1, 'marks restore: against its removal on another device, the restored mark stays');
  }

  // ================================================================ Three devices, random edits and checks
  {
    wipe(); tick(60000);
    const R = rng(SEED);
    const pick = (a) => a[Math.floor(R() * a.length)];
    const devs = [device('A'), device('B'), device('C')];
    await devs[0].addCourse('PLpeds0000000000');
    await devs[0].engine.start();
    await devs[1].addCourse('PLpeds0000000000'); devs[1].tick('PLpeds0000000000', 7, true);
    await devs[1].engine.join(devs[0].key(), 'add');
    await devs[2].engine.join(devs[0].key(), 'add');
    // What the last action on each thing says it must end as (one clock, so the last action is the latest time)
    const want = { ticks: {}, chans: {}, marks: {}, spots: {}, places: {}, rates: {} };
    want.ticks['PLpeds0000000000:7'] = true;
    const markIds = [], chanNames = ['Alpha', 'Beta', 'Gamma', 'Delta'], removedMarks = {}, removedVideos = {};
    const plOf = (dv, pid) => !!dv.cs.get(pid);
    let checks = 0, conflicts = 0;
    async function edit(dv) {
      const what = R();
      if (what < 0.25) { // a tick or untick
        const pid = R() < 0.7 || !plOf(dv, 'PLobgyn000000000') ? 'PLpeds0000000000' : 'PLobgyn000000000';
        if (!plOf(dv, pid)) { if (pid === 'PLpeds0000000000') return; }
        const i = Math.floor(R() * 8), on = R() < 0.6;
        dv.tick(pid, i, on); want.ticks[pid + ':' + i] = on;
      } else if (what < 0.3) {
        if (!plOf(dv, 'PLobgyn000000000')) await dv.addCourse('PLobgyn000000000');
      } else if (what < 0.42) { // a mark: add, remove, Undo, note
        const r = R();
        const mine = dv.mk.list();
        if (r < 0.4 || !mine.length) { const m = dv.mark('Mark ' + markIds.length); markIds.push(m.id); want.marks[m.id] = { note: '' }; }
        else if (r < 0.65) { const m = pick(mine); removedMarks[m.id] = dv.dropMark(m.id); delete want.marks[m.id]; }
        else if (r < 0.8) { const id = pick(Object.keys(removedMarks)); if (id && !dv.mk.get(id)) { const m = clone(removedMarks[id]); dv.undoMark(m); want.marks[id] = { note: m.note || '' }; } }
        else { const m = pick(mine); const s = 'note ' + Math.floor(R() * 1000); dv.note(m.id, s); want.marks[m.id] = { note: s }; }
      } else if (what < 0.62) { // a spot, a removal, an Undo
        const id = 'vid' + Math.floor(R() * 6) + 'xxxxxxx', r = R();
        if (r < 0.7) { const t = Math.floor(R() * 600); dv.spot(id, t); want.spots[id] = t; }
        else if (r < 0.85) { if (dv.videos[id]) { removedVideos[id] = clone(dv.dropVideo(id)); delete want.spots[id]; } }
        else if (removedVideos[id] && !dv.videos[id]) { const v = clone(removedVideos[id]); dv.undoVideo(id, v); want.spots[id] = v.t; }
      } else if (what < 0.72) {
        const g = 'ep' + Math.floor(R() * 4), t = Math.floor(R() * 3000); dv.place(g, t); want.places[g] = t;
      } else if (what < 0.82) {
        // (as in the app, picking the speed a channel already has here is no change, so it gets no time)
        const k = 'v:UC' + Math.floor(R() * 3), r = pick([1, 1.25, 1.5, 1.75, 2]);
        if ((dv.prefs.rates || {})[k] !== r) { dv.speed(k, r); want.rates[k] = r; }
      } else { // a channel added or removed
        const nm = pick(chanNames), have = dv.lib.sources().filter((s) => s.name === nm)[0];
        if (have && R() < 0.5) { dv.dropChannel(have.id); want.chans[nm] = false; } else { await dv.addChannel(nm); want.chans[nm] = true; }
      }
    }
    for (let round = 0; round < ROUNDS; round++) {
      const r = R(), dv = pick(devs);
      dv.net = R() < 0.06 ? pick(['down', 500, 'garble']) : 'ok';
      // Sometimes Mo changes something while a request is out
      if (R() < 0.15) dv.hook = () => edit(dv);
      if (r < 0.45) await edit(dv);
      else if (r < 0.7) { checks++; await dv.engine.check(); }
      else if (r < 0.8) { checks++; await dv.engine.flush(); }
      else if (r < 0.9) { checks += 3; await Promise.all(devs.map((x) => (R() < 0.5 ? x.engine.flush() : x.engine.check()))); }
      else tick(Math.floor(R() * 120000));
      dv.hook = null;
    }
    devs.forEach((x) => { x.net = 'ok'; x.hook = null; });
    conflicts = devs.reduce((s, x) => s + x.statuses.filter((st) => st === 409).length, 0);
    tick(200000);
    await settle(devs);
    ok(allSame(devs), 'random: all three devices end the same for every doc: ' + diffDocs(devs[0], devs[1]) + ' / ' + diffDocs(devs[0], devs[2]));
    ok(devs.every((x) => !x.engine.state().lastErr), 'random: no error left after the settling checks');
    const key = devs[0].key();
    ok(DOCS.every((d) => Sync.same(JSON.parse(stored(key, d)), devs[0].docs[d].read(), d)), 'random: the store holds the same as the devices');
    for (const dv of devs) {
      const lost = Object.keys(want.ticks).filter((k) => { const [pid, i] = k.split(':'); return isTicked(dv, pid, +i) !== want.ticks[k]; });
      ok(!lost.length, 'random: every tick and untick on ' + dv.name + ' is the last one made anywhere (wrong: ' + lost.join(', ') + ')');
      const badM = Object.keys(want.marks).filter((id) => !dv.mk.get(id) || dv.mk.get(id).note !== want.marks[id].note).concat(markIds.filter((id) => !want.marks[id] && dv.mk.get(id)));
      ok(!badM.length, 'random: marks on ' + dv.name + ' as last left (wrong: ' + badM.join(', ') + ')');
      const badS = Object.keys(want.spots).filter((id) => !dv.videos[id] || dv.videos[id].t !== want.spots[id]).concat(Object.keys(removedVideos).filter((id) => !(id in want.spots) && dv.videos[id]));
      ok(!badS.length, 'random: spots on ' + dv.name + ' as last left (wrong: ' + badS.join(', ') + ')');
      ok(Object.keys(want.places).every((g) => dv.audio[g] && dv.audio[g].t === want.places[g]), 'random: podcast places on ' + dv.name);
      ok(Object.keys(want.rates).every((k) => dv.prefs.rates[k] === want.rates[k]), 'random: speeds on ' + dv.name);
      ok(Object.keys(want.chans).every((nm) => dv.lib.sources().some((s) => s.name === nm) === want.chans[nm]), 'random: channels on ' + dv.name);
    }
    console.log('  random: ' + ROUNDS + ' rounds, ' + checks + ' checks, ' + conflicts + ' conflicts (409), ' + Object.keys(want.ticks).length + ' ticks, ' + markIds.length + ' marks');
  }

  console.log('synclink: all ' + n + ' checks passed (seed ' + SEED + ')');
})().catch((e) => { console.error(e); console.error('seed ' + SEED); process.exit(1); });
