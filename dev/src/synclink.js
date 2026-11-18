// Device sync: keeps this device's six stores the same as the shelf kept on the sync store (sync-server/), using the
// merges in sync.js. Everything is scrambled on the device before it leaves (AES-GCM, with a key only the devices
// hold; the store gets an id and a token made from it, never the key). The engine touches the outside only through
// io, so node tests can run several of them against the real store (test/synclink.test.cjs). It never throws into
// the app: every failure ends as lastErr, and a failed check changes nothing on the device.
var SyncLink = (function () {
  var LINK = 'shelf.sync.link';
  var DOCS = ['videos', 'audio', 'library', 'courses', 'marks', 'prefs'];
  var MERGE = { videos: 'mergeVideos', audio: 'mergeAudio', library: 'mergeLibrary', courses: 'mergeCourses', marks: 'mergeMarks', prefs: 'mergePrefs' };
  var WORDS = { videos: 'spots', audio: 'podcast places', library: 'channels', courses: 'course ticks', marks: 'marks', prefs: 'speeds' };
  var SLOW = { videos: 90000, audio: 90000 }; // spots change all the time while something plays
  var QUIET = 8000; // other stores go 8 s after their last change
  var TRIES = 3; // puts that meet another device's newer copy, in one check
  var HEX64 = /^[0-9a-f]{64}$/;

  function Stop(msg) { this.msg = msg; } // ends a check: with msg it is recorded, without it the check just ends

  // ----- Small helpers -----
  function hex(b) { var s = ''; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
  function utf8(s) { return new TextEncoder().encode(s); }
  function b64(b) { var s = ''; for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { var t = atob(s), b = new Uint8Array(t.length); for (var i = 0; i < t.length; i++) b[i] = t.charCodeAt(i); return b; }
  // A short checksum of a text (two 32-bit hashes)
  function sum(s) {
    var h1 = 0xdeadbeef ^ s.length, h2 = 0x41c6ce57 ^ s.length;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16) + '.' + (h1 >>> 0).toString(16);
  }
  function errFor(status) {
    if (!status) return "Couldn't reach the sync store. Check your internet.";
    if (status === 403) return "The sync store doesn't know this device's link any more. Turn sync off, then join again.";
    if (status === 507) return 'The sync store is full.';
    return 'The sync store had a problem (' + status + ').';
  }

  // io: see the top of this file and test/synclink.test.cjs
  function create(io) {
    var CS = 'CompressionStream' in io ? io.CompressionStream : typeof CompressionStream !== 'undefined' ? CompressionStream : null;
    var DS = 'DecompressionStream' in io ? io.DecompressionStream : typeof DecompressionStream !== 'undefined' ? DecompressionStream : null;
    var rec = readRec(), keys = null, gen = 0, busy = false, running = null, again = false, force = false;
    var touchedAt = {}, pushedAt = {};

    function changed() { try { if (io.changed) io.changed(); } catch (e) {} }
    // The one record: { key, joined, docs: { name: { ver, sum } }, lastOk, lastErr, errSince }
    function readRec() {
      var r = null;
      try { r = JSON.parse(io.get(LINK) || 'null'); } catch (e) { r = null; }
      if (!r || typeof r !== 'object' || !HEX64.test(r.key || '')) return null;
      r.docs = r.docs && typeof r.docs === 'object' ? r.docs : {};
      return r;
    }
    function saveRec(r) { if (r === rec) { try { io.set(LINK, JSON.stringify(r)); } catch (e) {} } }
    function cannot() {
      if (!io.subtle || !io.random || !CS || !DS) return "This device can't sync: its browser is too old for it. Update it, then try again.";
      return '';
    }

    // ----- Scrambling -----
    function sha(text) { return io.subtle.digest('SHA-256', utf8(text)).then(function (b) { return new Uint8Array(b); }); }
    // The shelf id and token (what the store sees) and the AES key (what it never sees), all from the shelf key
    function derive(key) {
      return Promise.all([sha('shelf sync id:' + key), sha('shelf sync token:' + key), sha('shelf sync aes:' + key)]).then(function (h) {
        return io.subtle.importKey('raw', h[2], { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']).then(function (aes) { return { key: key, id: hex(h[0]), token: hex(h[1]), aes: aes }; });
      });
    }
    function keysFor(key) {
      if (!keys || keys.key !== key) {
        var p = derive(key), mine = keys = { key: key, p: p };
        p.then(null, function () { if (keys === mine) keys = null; });
      }
      return keys.p;
    }
    function pipe(bytes, stream) { return new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer().then(function (b) { return new Uint8Array(b); }); }
    // 'z1:' + base64(iv + AES-GCM(gzip(text))); the doc's name is bound in, so one doc can't stand in for another
    function seal(k, doc, text) {
      var iv = io.random(12);
      return pipe(utf8(text), new CS('gzip')).then(function (z) { return io.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: utf8(doc) }, k.aes, z); }).then(function (c) {
        var b = new Uint8Array(12 + c.byteLength); b.set(iv, 0); b.set(new Uint8Array(c), 12);
        return 'z1:' + b64(b);
      });
    }
    function open(k, doc, body) {
      return Promise.resolve().then(function () {
        if (typeof body !== 'string' || body.slice(0, 3) !== 'z1:') throw new Error('not ours');
        var b = unb64(body.slice(3));
        if (b.length < 29) throw new Error('short');
        return io.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: utf8(doc) }, k.aes, b.subarray(12));
      }).then(function (z) { return pipe(new Uint8Array(z), new DS('gzip')); }).then(function (t) { return JSON.parse(new TextDecoder().decode(t)); });
    }

    // ----- Talking to the store -----
    // Resolves { status, json }; status 0 when the store couldn't be reached. Nothing goes out once sync is off.
    function call(g, k, msg) {
      if (g !== gen) return Promise.reject(new Stop());
      msg.v = 1; msg.shelf = k.id; msg.token = k.token;
      return Promise.resolve().then(function () { return io.post(io.url, JSON.stringify(msg)); }).then(function (r) {
        var j = null; try { j = JSON.parse(r && r.text); } catch (e) { j = null; }
        return { status: (r && +r.status) || 0, json: j && typeof j === 'object' ? j : null };
      }, function () { return { status: 0, json: null }; }).then(function (r) { if (g !== gen) throw new Stop(); return r; });
    }

    // ----- One merge, in one synchronous stretch: nothing Mo does can land between the read and the adopt -----
    function take(r, d, remote, ver, mode) {
      var now = io.now(), doc = io.docs[d], local = doc.read(), base = local;
      if (mode === 'replace') base = Sync.empty(d, local);
      else if (mode === 'add' && d === 'courses') base = tickedNow(local, now);
      var merged = Sync[MERGE[d]](base, remote, now);
      if (!Sync.same(merged, local, d)) doc.adopt(merged);
      r.docs[d] = { ver: ver, sum: sum(Sync.canon(remote, d)) };
      return !Sync.same(merged, remote, d);
    }
    // Joining with Add counts as ticking now every tick this device has with no time, so an older untick elsewhere can't
    // take it away. Not the ones the seed list made here (auto): they stay untimed, so an untick made elsewhere wins.
    function tickedNow(local, now) {
      var c = JSON.parse(JSON.stringify(local || {})), all = c.courses && typeof c.courses === 'object' ? c.courses : {};
      var auto = c.auto && typeof c.auto === 'object' ? c.auto : {};
      Object.keys(all).forEach(function (pid) {
        var x = all[pid], au = auto[pid] && typeof auto[pid] === 'object' ? auto[pid] : {};
        if (!x || typeof x !== 'object' || !x.ticks || typeof x.ticks !== 'object') return;
        Object.keys(x.ticks).forEach(function (v) {
          if (x.ticks[v] !== 1 || (x.onAt && x.onAt[v] != null) || au[v]) return;
          x.onAt = x.onAt && typeof x.onAt === 'object' ? x.onAt : {}; x.onAt[v] = now;
        });
      });
      return c;
    }
    function due(d, now) { return SLOW[d] ? !(pushedAt[d] > now - SLOW[d]) : !(touchedAt[d] > now - QUIET); }

    // One check: get what changed, merge it in, put back what differs. pre: a get already made (join), mode: join's first merge.
    function once(pre, mode) {
      var r = rec, g = gen, f = force, k;
      if (!r) return Promise.resolve();
      force = false; busy = true; changed();
      var differs = {}, big = [];
      return keysFor(r.key).then(function (kk) {
        k = kk;
        if (pre) return pre;
        var known = {};
        DOCS.forEach(function (d) { var x = r.docs[d]; if (x && x.ver) known[d] = x.ver; });
        return call(g, k, { op: 'get', docs: known }).then(function (res) {
          // No shelf there (made only by a first put): everything goes up again
          if (res.status === 404) { r.docs = {}; return { names: [], plain: [], got: {} }; }
          if (res.status !== 200 || !res.json || !res.json.docs || typeof res.json.docs !== 'object') throw new Stop(errFor(res.status));
          return unpack(k, res.json.docs);
        });
      }).then(function (got) {
        if (g !== gen) throw new Stop();
        got.names.forEach(function (d, i) { differs[d] = take(r, d, got.plain[i], got.got[d].ver, mode); });
        saveRec(r);
        var now = io.now();
        var todo = DOCS.filter(function (d) {
          var x = r.docs[d];
          var need = !x || !x.ver || differs[d] || sum(Sync.canon(io.docs[d].read(), d)) !== x.sum;
          return need && (f || due(d, now));
        });
        return todo.reduce(function (p, d) { return p.then(function () { return put(r, g, k, d, 0, big); }); }, Promise.resolve());
      }).then(function () {
        if (g !== gen) return;
        if (big.length) throw new Stop('Too much to sync (' + big.map(function (d) { return WORDS[d]; }).join(', ') + ')');
        r.lastOk = io.now(); r.lastErr = ''; r.errSince = 0; saveRec(r);
      }).catch(function (e) {
        if (g !== gen) return;
        if (f) force = true; // a first check that failed still pushes everything next time
        r.lastErr = e instanceof Stop ? e.msg || '' : "Sync stopped on something unexpected. It tries again by itself.";
        if (!r.lastErr) return;
        r.errSince = r.errSince || io.now(); saveRec(r);
      }).then(function () { if (g === gen) { busy = false; changed(); } });
    }
    // Decrypt every doc the store sent; one that won't open stops the check before anything changes
    function unpack(k, docs) {
      var names = DOCS.filter(function (d) { return docs[d] && typeof docs[d] === 'object' && typeof docs[d].ver === 'number'; });
      return Promise.all(names.map(function (d) { return open(k, d, docs[d].body); })).then(function (plain) {
        return { names: names, plain: plain, got: docs };
      }, function () { throw new Stop("Couldn't read what the sync store sent. Nothing was changed here."); });
    }
    function put(r, g, k, d, tries, big) {
      var text = Sync.canon(io.docs[d].read(), d), x = r.docs[d] || {};
      return seal(k, d, text).then(function (body) {
        return call(g, k, { op: 'put', doc: d, base: x.ver || 0, body: body });
      }).then(function (res) {
        if (res.status === 200 && res.json && typeof res.json.ver === 'number') {
          r.docs[d] = { ver: res.json.ver, sum: sum(text) }; pushedAt[d] = io.now(); saveRec(r); return;
        }
        if (res.status === 413) { big.push(d); return; }
        if (res.status === 409 && res.json && typeof res.json.ver === 'number') {
          // Another device got there first: merge its copy in, then put again on top of it (at most 3 times a check)
          var p = res.json.body == null ? Promise.resolve(null) : open(k, d, res.json.body).catch(function () { throw new Stop("Couldn't read what the sync store sent. Nothing was changed here."); });
          return p.then(function (remote) {
            if (g !== gen) throw new Stop();
            if (remote == null) r.docs[d] = { ver: 0, sum: '' };
            else take(r, d, remote, res.json.ver, null);
            saveRec(r);
            if (tries >= TRIES) throw new Stop('Another device kept saving at the same moment. Trying again soon.');
            return put(r, g, k, d, tries + 1, big);
          });
        }
        throw new Stop(errFor(res.status));
      });
    }

    // Runs fn when no check is running; a check asked for meanwhile runs once after it
    function serial(fn) {
      var p = (running || Promise.resolve()).then(function () { return fn(); }).then(null, function () { return { ok: false, reason: 'Something went wrong. Try again.' }; });
      var q = p.then(function (v) {
        if (running === q) running = null;
        if (again && rec && !running) { again = false; return check().then(function () { return v; }); }
        return v;
      });
      running = q;
      return q;
    }
    function check() {
      if (!rec) return Promise.resolve(state());
      if (running) { again = true; return running.then(state); }
      return serial(function () { return once(null, null); }).then(state);
    }
    // Leaving the page: everything that differs goes now
    function flush() { if (!rec) return Promise.resolve(state()); force = true; return check(); }
    function touched(doc) { touchedAt[doc] = io.now(); }

    function result() { return rec && !rec.lastErr ? { ok: true } : { ok: false, reason: rec ? rec.lastErr : 'Sync is off.' }; }
    function start() {
      if (rec) return Promise.resolve({ ok: false, reason: 'Sync is already on here.' });
      var why = cannot();
      if (why) return Promise.resolve({ ok: false, reason: why });
      return serial(function () {
        if (rec) return { ok: false, reason: 'Sync is already on here.' };
        var key = hex(io.random(32));
        return Promise.resolve(io.backup()).then(function (ok) {
          if (!ok) return { ok: false, reason: "Couldn't keep a copy of this device first, so sync didn't start." };
          gen++; rec = { key: key, joined: io.now(), docs: {} }; saveRec(rec); force = true; changed();
          return once(null, null).then(result);
        });
      });
    }
    function join(key, mode) {
      key = String(key || '').trim().toLowerCase();
      if (!HEX64.test(key)) return Promise.resolve({ ok: false, reason: "That link isn't complete. Copy it again on the other device." });
      if (rec && rec.key === key) return check().then(function () { return { ok: true, same: true }; });
      var why = cannot();
      if (why) return Promise.resolve({ ok: false, reason: why });
      mode = mode === 'replace' ? 'replace' : 'add';
      return serial(function () {
        var g0 = gen, k;
        return derive(key).then(function (kk) {
          k = kk;
          return call(g0, k, { op: 'get', docs: {} });
        }).then(function (res) {
          if (res.status === 404) return { ok: false, reason: "That link doesn't match a shelf." };
          if (res.status !== 200 || !res.json || !res.json.docs || typeof res.json.docs !== 'object') return { ok: false, reason: errFor(res.status) };
          return unpack(k, res.json.docs).then(function (got) {
            return Promise.resolve(io.backup()).then(function (ok) {
              if (!ok) return { ok: false, reason: "Couldn't keep a copy of this device first, so it didn't join." };
              if (g0 !== gen) return { ok: false, reason: 'Sync changed meanwhile. Try again.' };
              gen++; keys = { key: key, p: Promise.resolve(k) };
              rec = { key: key, joined: io.now(), docs: {} }; saveRec(rec); force = true; changed();
              return once(got, mode).then(result);
            });
          });
        }).then(null, function (e) {
          return { ok: false, reason: e instanceof Stop ? e.msg || 'Sync changed meanwhile. Try again.' : "Couldn't join on this device. Try again." };
        });
      });
    }
    // Forgets the link; everything on the device stays. No request goes out after this.
    function off() {
      gen++; rec = null; keys = null; again = false; force = false; busy = false;
      try { io.del(LINK); } catch (e) {}
      changed();
    }
    function state() {
      return { on: !!rec, busy: busy, lastOk: (rec && rec.lastOk) || 0, lastErr: (rec && rec.lastErr) || '', errSince: (rec && rec.errSince) || 0,
        joined: (rec && rec.joined) || 0, link: rec ? (io.linkBase || '') + '#sync=' + rec.key : '' };
    }

    return { start: start, join: join, check: check, flush: flush, touched: touched, off: off, state: state };
  }
  return { create: create, LINK: LINK, DOCS: DOCS };
})();
if (typeof module !== 'undefined') module.exports = SyncLink;
