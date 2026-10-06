// Library: sections, channels and podcasts, plus feed refresh and "new upload" counts.
// No DOM. Storage and networking are passed in, so node tests can drive it (test/library.test.cjs).
var Library = (function () {
  var KEY = 'shelf.v2.library';
  var TTL = 30 * 60000; // refresh a feed at most every 30 minutes unless asked
  var SEED_SECTIONS = [
    { id: 'med', name: 'Medicine', kind: 'video' },
    { id: 'ent', name: 'Entertainment', kind: 'video' },
    { id: 'sleep', name: 'Sleep', kind: 'audio' }
  ];
  // Mo's channels, looked up on first run in the app. A miss shows as "Couldn't find …" with a Fix button.
  var SEED_SOURCES = [
    { input: '@DirtyMedicine', section: 'med' },
    { input: '@MehlmanMedical', section: 'med' },
    { input: '@AJsMnemonics', section: 'med', since: 3 }, // AJmonics
    { input: '@BreakingPoints', section: 'ent' },
    { input: 'The Ezra Klein Show', section: 'ent', since: 2 }, // the video show (was its podcast before seed version 2)
    { input: 'https://feeds.megaphone.fm/finvshistory', section: 'sleep' },
    { input: 'Fall of Civilizations', section: 'sleep', audio: true }
  ];
  var SEED_V = 3; // seeds marked since: n are added once to libraries seeded before version n
  var CONSENT = { Cookie: 'SOCS=CAI; CONSENT=YES+1' };

  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 'p' + (h >>> 0).toString(36); }
  function slug(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'section'; }

  // io: { load(key) -> string|null, save(key, string), fetchText(url, headers) -> Promise<string>, now() }
  function create(io) {
    var now = io.now || Date.now;
    var state = read();
    var cache = {}; // sourceId -> { fetched, ok, error, items }

    function read() {
      var s = null;
      try { s = JSON.parse(io.load(KEY) || 'null'); } catch (e) { s = null; }
      if (!s || !Array.isArray(s.sections)) s = { sections: SEED_SECTIONS.map(function (x) { return Object.assign({}, x); }), sources: {}, seeded: false, born: now() };
      s.sources = s.sources || {};
      return s;
    }
    // rev counts saves, so the phone's copy and the web view's copy can tell which is newer; born marks a
    // list started from scratch, so a fresh list made while the phone couldn't be read never beats the real one
    function save() { state.rev = (state.rev || 0) + 1; io.save(KEY, JSON.stringify(state)); }

    // ----- Sections -----
    function sections() { return state.sections.slice(); }
    function section(id) { return state.sections.filter(function (s) { return s.id === id; })[0] || null; }
    function addSection(name, kind) {
      name = String(name || '').trim();
      if (!name) throw new Error('Give the section a name.');
      if (state.sections.some(function (s) { return s.name.toLowerCase() === name.toLowerCase(); })) throw new Error('You already have a section called ' + name + '.');
      var id = slug(name), n = 2;
      while (section(id)) id = slug(name) + '-' + n++;
      var s = { id: id, name: name, kind: kind === 'audio' ? 'audio' : 'video' };
      state.sections.push(s); save(); return s;
    }
    function renameSection(id, name) {
      var s = section(id); name = String(name || '').trim();
      if (!s || !name) return false;
      s.name = name; save(); return true;
    }
    function setKind(id, kind) { var s = section(id); if (!s) return false; s.kind = kind === 'audio' ? 'audio' : 'video'; save(); return true; }
    // Channels in a removed section move to the first remaining one, so nothing is lost by accident
    function removeSection(id) {
      if (state.sections.length < 2) throw new Error("Shelf needs at least one section.");
      state.sections = state.sections.filter(function (s) { return s.id !== id; });
      var to = state.sections[0].id;
      Object.keys(state.sources).forEach(function (k) { if (state.sources[k].section === id) state.sources[k].section = to; });
      save(); return to;
    }
    function moveSection(id, delta) {
      var i = state.sections.findIndex(function (s) { return s.id === id; }), j = i + delta;
      if (i < 0 || j < 0 || j >= state.sections.length) return false;
      var t = state.sections[i]; state.sections[i] = state.sections[j]; state.sections[j] = t; save(); return true;
    }

    // ----- Sources (YouTube channels and podcasts) -----
    function sources(sectionId) {
      return Object.keys(state.sources).map(function (k) { return state.sources[k]; })
        .filter(function (s) { return !sectionId || s.section === sectionId; })
        .sort(function (a, b) { return a.added - b.added; });
    }
    function source(id) { return state.sources[id] || null; }
    function setSection(id, sectionId) { var s = source(id); if (!s || !section(sectionId)) return false; s.section = sectionId; save(); return true; }
    // Shorts and clips under 90 s stay off the sheet unless this is turned off for the channel
    function setHideShorts(id, on) { var s = source(id); if (!s) return false; s.hideShorts = !!on; save(); return true; }
    function remove(id) { if (!state.sources[id]) return false; delete state.sources[id]; delete cache[id]; save(); return true; }
    // A private feed (Patreon) is never put in Send links or shown in full
    function isPrivate(url) { return /patreon|[?&](auth|token|key)=/i.test(url); }

    function fetchFirst(urls, headers) {
      var i = 0, lastErr;
      function next() {
        if (i >= urls.length) return Promise.reject(lastErr || new Error('no feed'));
        return io.fetchText(urls[i++], headers).catch(function (e) { lastErr = e; return next(); });
      }
      return next();
    }
    function youtubeFeed(channelId, before) {
      var urls = Feeds.youtubeFeedUrls(channelId);
      // The Shorts-free list can be empty for channels that only post Shorts or live streams
      return fetchFirst(urls).then(function (xml) {
        var f = Feeds.parseYouTube(xml);
        if (f.items.length) return f;
        return io.fetchText(urls[1]).then(Feeds.parseYouTube, function () { return f; });
      }).catch(function (e) { return videosPage(channelId, before, e); });
    }
    // YouTube's feeds fail for some channels at times: read the channel's Videos tab instead.
    // Videos seen before keep their earlier time, so "new" counts don't jump about.
    function videosPage(channelId, before, why) {
      return io.fetchText('https://www.youtube.com/channel/' + channelId + '/videos', CONSENT).then(function (html) {
        var items = typeof Courses !== 'undefined' ? Courses.channelVideos(html, now()) : null;
        if (!items || !items.length) throw why || new Error("Couldn't read the channel's videos.");
        var known = {};
        ((before && before.items) || []).forEach(function (x) { known[x.id] = x.published; });
        items.forEach(function (x) { if (known[x.id]) x.published = known[x.id]; });
        // Rough times are always newer than the real ones: keep each just under the one above it on the page
        for (var i = 1; i < items.length; i++) if (items[i].published >= items[i - 1].published) items[i].published = items[i - 1].published - 1000;
        var ch = Feeds.channelFromHtml(html);
        return { channelId: channelId, title: (ch && ch.name) || '', items: items.slice(0, 15), viaPage: true };
      }, function () { throw why; });
    }
    function channelIdFromPage(url) {
      return io.fetchText(url, CONSENT).then(function (html) {
        if (Feeds.isConsentPage(html)) throw new Error('YouTube showed its cookie page instead of the channel. Try again in a minute.');
        var c = Feeds.channelFromHtml(html);
        if (!c) throw new Error("Couldn't find a channel at that link.");
        return c;
      });
    }
    function findPodcast(name) {
      return io.fetchText('https://itunes.apple.com/search?media=podcast&limit=5&term=' + encodeURIComponent(name)).then(function (t) {
        var r = JSON.parse(t).results || [];
        var hit = r.filter(function (x) { return x.feedUrl; })[0];
        if (!hit) throw new Error('No podcast called "' + name + '" found.');
        return hit.feedUrl;
      });
    }
    // Without a Google key: YouTube's own channel search page, first result
    function findChannel(name) {
      return io.fetchText('https://www.youtube.com/results?sp=EgIQAg%253D%253D&search_query=' + encodeURIComponent(name), CONSENT).then(function (html) {
        var id = (html.match(/"channelRenderer"\s*:\s*\{\s*"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/) || [])[1];
        if (!id) throw new Error('No YouTube channel called "' + name + '" found. Paste a link to the channel instead.');
        return { id: id };
      });
    }

    // Add whatever Mo pasted: a channel link, @handle, video link, podcast feed, or a name.
    // Resolves to the stored source. opts: { audio: true } makes a bare name search podcasts.
    function add(input, sectionId, opts) {
      opts = opts || {};
      var sec = section(sectionId) || state.sections[0];
      var p = Feeds.parseChannelInput(input);
      if (!p) return Promise.reject(new Error("That doesn't look like a channel, a podcast, or a name."));
      var audio = opts.audio || (p.kind === 'name' && sec.kind === 'audio');
      if (p.kind === 'feed' || (p.kind === 'name' && audio)) {
        var feedUrl = p.kind === 'feed' ? Promise.resolve(p.value) : findPodcast(p.value);
        return feedUrl.then(function (url) {
          return io.fetchText(url).then(function (xml) {
            var f = Feeds.parsePodcast(xml), id = hash(url);
            var s = state.sources[id] = Object.assign(state.sources[id] || {}, {
              id: id, type: 'podcast', url: url, name: f.title || 'Podcast', image: f.image, section: opts.keepSection && state.sources[id] ? state.sources[id].section : sec.id,
              private: isPrivate(url), added: (state.sources[id] && state.sources[id].added) || now(), seenUpTo: newest(f.items)
            });
            cache[id] = { fetched: now(), ok: true, items: f.items };
            save(); return s;
          });
        });
      }
      var idP = p.kind === 'id' ? Promise.resolve({ id: p.value }) : p.kind === 'name' ? findChannel(p.value) : channelIdFromPage(Feeds.pageUrl(p));
      return idP.then(function (c) {
        return youtubeFeed(c.id).then(function (f) {
          var prior = state.sources[c.id];
          var s = state.sources[c.id] = Object.assign(prior || {}, {
            id: c.id, type: 'youtube', name: c.name || f.author || f.title || 'Channel', handle: c.handle || (prior && prior.handle) || '',
            image: c.avatar || (prior && prior.image) || '', section: opts.keepSection && prior ? prior.section : sec.id, added: (prior && prior.added) || now(),
            seenUpTo: prior ? prior.seenUpTo : newest(f.items)
          });
          cache[c.id] = { fetched: now(), ok: true, items: f.items };
          save(); return s;
        });
      });
    }
    // Already on the shelf under this handle, name or feed? (Mo may have fixed a miss by hand)
    function have(input, type) {
      var lc = String(input).toLowerCase().replace(/^@/, '').replace(/\s+/g, '');
      return sources().some(function (x) { return (!type || x.type === type) && ((x.handle || '').toLowerCase().replace(/^@/, '') === lc || x.name.toLowerCase().replace(/\s+/g, '') === lc || x.url === input); });
    }
    function newest(items) { return items.reduce(function (m, x) { return Math.max(m, x.published || 0); }, 0); }

    // ----- First run: Mo's channels -----
    // Returns [{input, ok, error}] so the UI can show what didn't resolve.
    // Runs fully once; after that, retries only the ones that failed (a first launch on bad Wi-Fi heals itself)
    function seed() {
      function kind(x) { return x.audio || /^https?:/.test(x.input) ? 'podcast' : 'youtube'; }
      var todo = state.seeded ? (state.seedMisses || []).map(function (m) { return SEED_SOURCES.filter(function (x) { return x.input === m.input; })[0]; }).filter(function (x) { return x && !have(x.input, kind(x)); }) : SEED_SOURCES;
      if (state.seeded && (state.seedV || 1) < SEED_V) {
        todo = todo.concat(SEED_SOURCES.filter(function (x) { return x.since > (state.seedV || 1) && todo.indexOf(x) < 0 && !have(x.input, kind(x)); }));
        if (!todo.length) { state.seedV = SEED_V; save(); }
      }
      if (!todo.length) return Promise.resolve([]);
      var out = [];
      return todo.reduce(function (p, s) {
        return p.then(function () {
          return add(s.input, s.section, { audio: s.audio, keepSection: true }).then(function () { out.push({ input: s.input, ok: true }); },
            function (e) { out.push({ input: s.input, section: s.section, ok: false, error: e.message }); });
        });
      }, Promise.resolve()).then(function () {
        state.seeded = true; state.seedV = SEED_V; state.seedMisses = out.filter(function (x) { return !x.ok; }); save(); return out;
      });
    }

    // ----- Refresh -----
    function refresh(id, force) {
      var s = source(id); if (!s) return Promise.reject(new Error('gone'));
      var c = cache[id];
      if (!force && c && c.ok && now() - c.fetched < TTL) return Promise.resolve(c);
      var p = s.type === 'podcast' ? io.fetchText(s.url).then(Feeds.parsePodcast) : youtubeFeed(s.id, c);
      return p.then(function (f) {
        cache[id] = { fetched: now(), ok: true, items: f.items };
        return cache[id];
      }, function (e) {
        cache[id] = { fetched: now(), ok: false, error: e && e.message || 'failed', items: (c && c.items) || [] };
        return cache[id];
      });
    }
    // A few at a time so the phone stays responsive
    function refreshAll(force, onEach) {
      var ids = Object.keys(state.sources), i = 0;
      function worker() {
        if (i >= ids.length) return Promise.resolve();
        var id = ids[i++];
        return refresh(id, force).then(function (c) { if (onEach) onEach(id, c); }, function () {}).then(worker);
      }
      return Promise.all([worker(), worker(), worker()]);
    }
    function items(id) { return (cache[id] && cache[id].items) || []; }
    function status(id) { var c = cache[id]; return c ? { ok: c.ok, error: c.error, fetched: c.fetched } : null; }
    function newCount(id) {
      var s = source(id); if (!s) return 0;
      return items(id).filter(function (x) { return x.published > (s.seenUpTo || 0); }).length;
    }
    function sectionNewCount(sectionId) { return sources(sectionId).reduce(function (n, s) { return n + newCount(s.id); }, 0); }
    function markSeen(id) {
      var s = source(id); if (!s) return;
      var n = newest(items(id)); if (n > (s.seenUpTo || 0)) { s.seenUpTo = n; save(); }
    }
    // Everything new across all channels, newest first (the "New" list)
    function fresh() {
      var out = [];
      sources().forEach(function (s) {
        items(s.id).forEach(function (x) { if (x.published > (s.seenUpTo || 0)) out.push(Object.assign({ source: s.id, sourceName: s.name }, x)); });
      });
      return out.sort(function (a, b) { return b.published - a.published; });
    }

    // Cache survives a relaunch so the shelf isn't empty while feeds load
    function saveCache() {
      var slim = {};
      Object.keys(cache).forEach(function (k) { slim[k] = { fetched: cache[k].fetched, ok: cache[k].ok, items: cache[k].items.slice(0, 15) }; });
      try { io.save(KEY + '.cache', JSON.stringify(slim)); } catch (e) {}
    }
    function loadCache() {
      try { var c = JSON.parse(io.load(KEY + '.cache') || 'null'); if (c) Object.keys(c).forEach(function (k) { if (state.sources[k]) cache[k] = c[k]; }); } catch (e) {}
    }
    loadCache();

    return {
      sections: sections, section: section, addSection: addSection, renameSection: renameSection, setKind: setKind, removeSection: removeSection, moveSection: moveSection,
      sources: sources, source: source, have: have, setSection: setSection, setHideShorts: setHideShorts, remove: remove, add: add, seed: seed,
      refresh: refresh, refreshAll: refreshAll, items: items, status: status, newCount: newCount, sectionNewCount: sectionNewCount,
      markSeen: markSeen, fresh: fresh, saveCache: saveCache, get seedMisses() { return state.seedMisses || []; }
    };
  }
  return { create: create, KEY: KEY, SEED_SOURCES: SEED_SOURCES };
})();
if (typeof module !== 'undefined') module.exports = Library;
