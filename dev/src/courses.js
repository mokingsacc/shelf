// Courses: YouTube playlists tracked episode by episode (Mo's Mehlman Medical playlists).
// No DOM. Storage and networking are passed in, so node tests can drive it (test/courses.test.cjs).
var Courses = (function () {
  var KEY = 'shelf.v2.courses';        // names, ticks, pins: small, mirrored to the phone
  var IKEY = 'shelf.v2.courses.items'; // episode lists: kept in the web view only, fetched again if lost
  var TTL = 12 * 3600e3;
  var MAX_PAGES = 40;                  // 100 episodes a page
  var CONSENT = 'SOCS=CAI; CONSENT=YES+1';
  // A desktop identity, so YouTube sends its full page (the phone one is shaped differently)
  var DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
  var YT_HEADERS = { Cookie: CONSENT, 'User-Agent': DESKTOP };
  var API = 'https://www.googleapis.com/youtube/v3/';

  // Mo's playlists (his note, 4 Oct 2026), found on the channel's Playlists page by name.
  // upTo: everything in the playlist's own order down to the video whose title holds this number. pct: his "70% complete", the fallback.
  var SEED = { channel: '@MehlmanMedical', section: 'med', courses: [
    { name: 'Paeds', match: 'pediatric|paediatric|\\bpa?eds?\\b', upTo: 1107, pct: 70 },
    { name: 'OBGYN', match: 'ob\\s*[/&-]?\\s*gyn|obstetric|gyn(a|e)?ecolog|\\bgyn\\b|women', all: true, pin: 1607 },
    { name: 'Ophthal', match: 'oph?th|\\beyes?\\b', all: true },
    { name: 'Internal Med', match: 'internal\\s*med|\\bim\\b' },
    { name: 'Pharm', match: 'pharm' },
    { name: 'Family Med', match: 'family\\s*med|primary\\s*care|\\bfm\\b' }
  ] };

  // ----- Reading YouTube pages -----
  // The JSON object that starts at s[i], or null
  function jsonAt(s, i) {
    if (s[i] !== '{') return null;
    var depth = 0, inStr = false, escp = false;
    for (var j = i; j < s.length; j++) {
      var c = s[j];
      if (inStr) { if (escp) escp = false; else if (c === '\\') escp = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; } }
    }
    return null;
  }
  // ytInitialData from a page (desktop or phone shape), or a plain JSON reply
  function initialData(html) {
    html = String(html || '');
    var m = html.match(/(?:var\s+ytInitialData|window\[["']ytInitialData["']\]|ytInitialData)\s*=\s*(['{])/);
    if (m) {
      var at = m.index + m[0].length - 1;
      if (m[1] === '{') return jsonAt(html, at);
      var end = html.indexOf("';", at + 1);
      if (end < 0) return null;
      var raw = html.slice(at + 1, end).replace(/\\x([0-9a-f]{2})/gi, function (x, h) { return String.fromCharCode(parseInt(h, 16)); }).replace(/\\\\/g, '\\');
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    var t = html.trim();
    if (t[0] === '{') { try { return JSON.parse(t); } catch (e) { return null; } }
    return null;
  }
  function walk(o, fn, d) {
    d = d || 0;
    if (!o || typeof o !== 'object' || d > 80) return;
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) walk(o[i], fn, d + 1); return; }
    for (var k in o) { if (fn(k, o[k]) !== false) walk(o[k], fn, d + 1); }
  }
  function txt(t) {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (t.simpleText) return t.simpleText;
    if (t.runs) return t.runs.map(function (r) { return r.text || ''; }).join('');
    if (t.content) return t.content;
    return '';
  }
  function countIn(o) {
    var n = 0;
    walk(o, function (k, v) { if (!n && typeof v === 'string') { var m = v.match(/^\s*([\d,]+)\s+(videos?|episodes?|lessons?)\b/i); if (m) n = parseInt(m[1].replace(/,/g, ''), 10); } });
    return n;
  }
  var GONE = /^\[(private|deleted) video\]$/i;
  // Episodes on a playlist page (or a "load more" reply), the token for the next lot, and the playlist's name
  function readVideos(data) {
    var out = { items: [], token: '', title: '', count: 0 };
    walk(data, function (k, v) {
      if (k === 'playlistVideoRenderer' && v && v.videoId) {
        var t = txt(v.title);
        if (!GONE.test(t) && v.isPlayable !== false) out.items.push({ id: v.videoId, title: t, dur: parseInt(v.lengthSeconds, 10) || 0 });
        return false;
      }
      if (k === 'lockupViewModel' && v && v.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && v.contentId) {
        var md = v.metadata && v.metadata.lockupMetadataViewModel, lt = txt(md && md.title), ld = 0;
        walk(v.contentImage, function (k2, v2) { if (!ld && typeof v2 === 'string' && /^\d{1,2}(:\d\d){1,2}$/.test(v2)) ld = v2.split(':').reduce(function (a, p) { return a * 60 + (+p); }, 0); });
        if (!GONE.test(lt)) out.items.push({ id: v.contentId, title: lt, dur: ld });
        return false;
      }
      if (k === 'continuationItemRenderer') {
        walk(v, function (k2, v2) { if (k2 === 'continuationCommand' && v2 && v2.token) out.token = v2.token; });
        return false;
      }
      if (k === 'playlistMetadataRenderer' && v && v.title && !out.title) out.title = txt(v.title);
      if (k === 'playlistHeaderRenderer' && v) { if (!out.title) out.title = txt(v.title); if (!out.count) out.count = countIn(v.numVideosText || v.stats); }
      if (k === 'pageHeaderViewModel' && v && !out.title) { var tt = v.title && v.title.dynamicTextViewModel && v.title.dynamicTextViewModel.text; if (tt) out.title = txt(tt); if (!out.count) out.count = countIn(v.metadata); }
    });
    return out;
  }
  // "3 days ago", "Streamed 2 weeks ago" -> a rough time (null for upcoming or unreadable)
  var UNIT = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };
  function agoTime(text, now) {
    var m = String(text || '').match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
    return m ? now - parseInt(m[1], 10) * UNIT[m[2].toLowerCase()] : null;
  }
  // Uploads on a channel's Videos tab (newest first): the backup when YouTube's feed fails.
  // Times are rough ("3 days ago"), so each one is kept just under the one above it.
  // Where the account's watch history says a video stopped (after Play locked, the YouTube app saves the spot to
  // the history): the resume link's start second (startTimeSeconds or &t=…s), else the red bar's percent.
  // Returns { t } or { pct } or null when the video isn't in the page.
  function historySpot(html, id) {
    if (!html || !id || html.indexOf(id) < 0) return null;
    var esc = id.replace(/[^\w-]/g, ''), m;
    var link = new RegExp('watch\\?v=' + esc + '(?:\\\\u0026|&amp;|&)(?:[^"]*?(?:\\\\u0026|&amp;|&))?t=(\\d+)s?');
    if ((m = html.match(link))) return { t: +m[1] };
    var re = new RegExp('"videoId":"' + esc + '"', 'g'), pct = null;
    while ((m = re.exec(html))) {
      // Only this video's own data: up to the next different video
      var rest = html.slice(m.index + m[0].length, m.index + 1500), next = rest.search(new RegExp('"videoId":"(?!' + esc + '")'));
      if (next >= 0) rest = rest.slice(0, next);
      var st = rest.match(/"startTimeSeconds":(\d+)/);
      if (st) return { t: +st[1] };
      var pc = rest.match(/"percentDurationWatched":(\d+)/);
      if (pc && pct == null) pct = +pc[1];
    }
    return pct == null ? null : { pct: pct };
  }

  // The newest video in the account's watch history page: { id, title, author, t, dur, pct } (t when YouTube saved a
  // spot), or null. History items list the title before the video's id (lockupViewModel) or after (videoRenderer).
  function historyLatest(html) {
    var start = html ? html.indexOf('ytInitialData') : -1; if (start < 0) return null;
    var re = /"(?:videoId|contentId)":"([\w-]{11})"/g; re.lastIndex = start;
    var m = re.exec(html); if (!m) return null;
    var id = m[1], from = m.index, to = Math.min(html.length, from + 6000), nx;
    while ((nx = re.exec(html)) && nx.index < to) { if (nx[1] !== id) { to = nx.index; break; } }
    var item = html.slice(Math.max(start, from - 50), to);
    function str(rx) { var r = item.match(rx); if (!r) return ''; try { return JSON.parse('"' + r[1] + '"'); } catch (e) { return r[1]; } }
    var title = str(/"title":\{"content":"((?:[^"\\]|\\.)*)"/) || str(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/) || str(/"title":\{"simpleText":"((?:[^"\\]|\\.)*)"/);
    var author = str(/"metadataParts":\[\{"text":\{"content":"((?:[^"\\]|\\.)*)"/) || str(/"(?:longBylineText|shortBylineText|ownerText)":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/);
    var len = item.match(/"(?:simpleText|text|content)":"(\d{1,2}:\d{2}(?::\d{2})?)"/), dur = 0;
    if (len) len[1].split(':').forEach(function (x) { dur = dur * 60 + +x; });
    var spot = historySpot(html.slice(Math.max(start, from - 50), to), id) || {}, t = spot.t != null ? spot.t : null;
    if (t == null && spot.pct != null && dur) t = Math.round(spot.pct / 100 * dur);
    return { id: id, title: title, author: author, t: t, dur: dur, pct: spot.pct != null ? spot.pct : null };
  }

  function channelVideos(html, now) {
    var data = initialData(html), out = [];
    if (!data) return null;
    function push(id, title, when, dur) {
      if (!/^[A-Za-z0-9_-]{11}$/.test(id) || when == null || GONE.test(title) || out.some(function (x) { return x.id === id; })) return;
      out.push({ id: id, title: title, published: when, dur: dur || 0, thumb: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg', description: '', author: '' });
    }
    walk(data, function (k, v) {
      if (k === 'videoRenderer' && v && v.videoId) {
        push(v.videoId, txt(v.title), v.upcomingEventData ? null : agoTime(txt(v.publishedTimeText), now), duration(txt(v.lengthText)));
        return false;
      }
      if (k === 'lockupViewModel' && v && v.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && v.contentId) {
        var md = v.metadata && v.metadata.lockupMetadataViewModel, when = null, ld = 0;
        walk(md && md.metadata, function (k2, v2) { if (when == null && typeof v2 === 'string') when = agoTime(v2, now); });
        walk(v.contentImage, function (k2, v2) { if (!ld && typeof v2 === 'string' && /^\d{1,2}(:\d\d){1,2}$/.test(v2)) ld = duration(v2); });
        push(v.contentId, txt(md && md.title), when, ld);
        return false;
      }
    });
    for (var i = 1; i < out.length; i++) if (out[i].published >= out[i - 1].published) out[i].published = out[i - 1].published - 1000;
    return out;
  }
  function duration(t) { return /^\d{1,2}(:\d\d){1,2}$/.test(t || '') ? t.split(':').reduce(function (a, p) { return a * 60 + (+p); }, 0) : 0; }
  // Playlists on a channel's Playlists page
  function readPlaylists(data) {
    var out = [], seen = {}, token = '';
    function push(id, title, count) { if (id && !seen[id] && /^(PL|OL|UU|FL)/.test(id)) { seen[id] = 1; out.push({ id: id, title: title, count: count || 0 }); } }
    walk(data, function (k, v) {
      if ((k === 'gridPlaylistRenderer' || k === 'playlistRenderer') && v && v.playlistId) {
        push(v.playlistId, txt(v.title), parseInt(String(v.videoCount || txt(v.videoCountText) || txt(v.videoCountShortText) || '').replace(/,/g, ''), 10));
        return false;
      }
      if (k === 'lockupViewModel' && v && v.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST') {
        var md = v.metadata && v.metadata.lockupMetadataViewModel;
        push(v.contentId, txt(md && md.title), countIn(v));
        return false;
      }
      if (k === 'continuationItemRenderer') { walk(v, function (k2, v2) { if (k2 === 'continuationCommand' && v2 && v2.token) token = v2.token; }); return false; }
    });
    return { items: out, token: token };
  }
  function clientInfo(html) {
    return {
      ver: (String(html).match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/) || String(html).match(/"clientVersion"\s*:\s*"(2\.[\d.]+)"/) || [])[1] || '2.20250101.00.00',
      key: (String(html).match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/) || [])[1] || ''
    };
  }

  // ----- Episode numbers -----
  // "HY USMLE Q #1107 - Pediatrics" -> 1107. Mehlman numbers his episodes in the title.
  function epNumber(title) {
    title = String(title || '');
    var m = title.match(/#\s*(\d{1,5})\b/) || title.match(/\b(?:ep(?:isode)?|q|no)\.?\s*(\d{1,5})\b/i) || title.match(/№\s*(\d{1,5})/);
    if (m) return parseInt(m[1], 10);
    m = title.match(/(?:^|[^\d:.])(\d{2,5})(?![\d:.])/);
    if (!m) return 0;
    var n = parseInt(m[1], 10);
    return n >= 1900 && n <= 2099 ? 0 : n; // a year, not an episode
  }
  // A playlist link (or bare id) -> its id
  function playlistId(text) {
    text = String(text || '').trim();
    if (/^(PL|OL|UU|FL)[A-Za-z0-9_-]{10,}$/.test(text)) return text;
    var m = text.match(/[?&]list=((?:PL|OL|UU|FL)[A-Za-z0-9_-]{10,})/);
    return m ? m[1] : '';
  }
  // "HY USMLE Qs - Pediatrics | Mehlman Medical" -> "Pediatrics"
  function shortName(title) {
    var t = String(title || '').replace(/mehlman\s*medical|mehlman|\bHY\b|USMLE|step\s*[123]\s*(ck)?|\bCK\b|\bQ'?s?\b|questions|playlist|podcast|shelf|review|nbme/gi, ' ')
      .replace(/[|:–—#()\[\]-]+/g, ' ').replace(/\s+/g, ' ').trim() || String(title || 'Course').trim();
    if (t.length <= 16) return t || 'Course';
    var cut = t.slice(0, 17).replace(/\s+\S*$/, ''); // whole words only
    return cut || t.slice(0, 16);
  }
  // The goal date: Step 2 CK, 22 Dec 2026 (local midnight) unless Mo sets another one
  var EXAM_DEFAULT = new Date(2026, 11, 22), EXAM = EXAM_DEFAULT;
  function setExam(d) { EXAM = d instanceof Date && !isNaN(d) ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : EXAM_DEFAULT; }
  function exam() { return EXAM; }
  // "1 a day", "2.6 a day", "1 every 3 days": rounded up so the plan never falls short
  function perDay(x) {
    if (!x) return '';
    if (x <= 1) return 1 / x < 2 ? '1 a day' : '1 every ' + Math.floor(1 / x) + ' days';
    var r = x >= 10 ? Math.ceil(x) : Math.ceil(x * 10) / 10;
    return String(r).replace(/\.0$/, '') + ' a day';
  }
  function fmtHours(sec) { var h = sec / 3600; return h >= 1 ? Math.round(h) + ' h' : Math.max(1, Math.round(sec / 60)) + ' min'; }

  // io: { load(key), save(key, string), fetchText(url, headers), postJSON(url, body, headers) -> Promise<string>, now(), apiKey(), watched(videoId) -> bool }
  function create(io) {
    var now = io.now || Date.now;
    var state = read(), cache = readCache(), busy = {}, order = {}, index = {};

    function read() {
      var s = null;
      try { s = JSON.parse(io.load(KEY) || 'null'); } catch (e) { s = null; }
      if (!s || typeof s.courses !== 'object') s = { courses: {}, found: false, misses: [] };
      return s;
    }
    function readCache() { try { return JSON.parse(io.load(IKEY) || 'null') || {}; } catch (e) { return {}; } }
    function save() { state.saved = now(); io.save(KEY, JSON.stringify(state)); }
    function saveCache() { try { io.save(IKEY, JSON.stringify(cache)); } catch (e) {} }

    function list() { return Object.keys(state.courses).map(function (k) { return state.courses[k]; }).sort(function (a, b) { return a.added - b.added; }); }
    function get(id) { return state.courses[id] || null; }
    function items(id) {
      var c = get(id), ch = cache[id];
      if (!c || !ch || !ch.items) return [];
      // Always YouTube's own playlist order (what Mo watches down), never sorted by number
      if (!order[id] || order[id].arr !== ch.items) {
        var ix = {};
        ch.items.forEach(function (x, i) { ix[x.id] = i; });
        order[id] = { arr: ch.items }; index[id] = ix;
      }
      return order[id].arr;
    }
    function status(id) { var ch = cache[id]; return { loading: !!busy[id], fetched: ch ? ch.fetched : 0, ok: ch ? ch.ok !== false : true, error: ch && ch.error || '', partial: ch && ch.partial || 0 }; }

    // ----- Ticks -----
    function isDone(c, vid) { var t = c.ticks[vid]; return t === 1 || (t !== 0 && !!(io.watched && io.watched(vid))); }
    function progress(id) {
      var c = get(id), arr = items(id), done = 0, last = -1, secs = 0;
      if (!c) return null;
      arr.forEach(function (x, i) { if (isDone(c, x.id)) { done++; last = i; } secs += x.dur || 0; });
      // You're here: just after the last tick; if the last one is ticked, the first one still open
      var notch = arr.length && last < arr.length - 1 ? last + 1 : -1;
      if (notch < 0 && done < arr.length) for (var g = 0; g < arr.length; g++) if (!isDone(c, arr[g].id)) { notch = g; break; }
      var st = !arr.length ? 'empty' : done === arr.length ? 'done' : done || c.touched ? 'go' : 'new';
      return { total: arr.length, done: done, notch: notch, next: notch >= 0 ? arr[notch] : null, state: st, secs: secs, hours: secs ? fmtHours(secs) : '' };
    }
    function where(vid) {
      var out = null;
      list().forEach(function (c) { items(c.id); if (!out && index[c.id] && index[c.id][vid] != null) out = { course: c, i: index[c.id][vid] }; });
      return out;
    }
    function touch(c) { c.touched = now(); }
    function tick(id, vid, on) {
      var c = get(id); if (!c) return;
      c.ticks[vid] = on ? 1 : 0; touch(c);
      // When each one was ticked, for the day's tally and the pace (ticking a block with Set place doesn't count)
      c.ticksAt = c.ticksAt || {};
      if (on) c.ticksAt[vid] = now(); else delete c.ticksAt[vid];
      save();
    }
    // Everything up to and including position i; returns what was there, for Undo
    function tickUpTo(id, i) {
      var c = get(id), arr = items(id); if (!c || i < 0 || i >= arr.length) return null;
      var before = Object.assign({}, c.ticks);
      for (var j = 0; j <= i; j++) c.ticks[arr[j].id] = 1;
      touch(c); save();
      return before;
    }
    function restore(id, ticks) { var c = get(id); if (!c || !ticks) return; c.ticks = ticks; save(); }
    function pin(id, vid, on) { var c = get(id); if (!c) return; if (on) c.pins[vid] = 1; else delete c.pins[vid]; save(); }
    // Episode number from the titles -> positions (first match first)
    function findNumber(id, n) {
      var arr = items(id), hits = [];
      arr.forEach(function (x, i) { if (x.n === n) hits.push(i); });
      return hits;
    }
    function touchCourse(id) { var c = get(id); if (c) { touch(c); save(); } }
    function move(id, sectionId) { var c = get(id); if (!c) return false; c.section = sectionId; save(); return true; }
    function remove(id) { if (!state.courses[id]) return false; state.removed = state.removed || {}; state.removed[id] = state.courses[id].ticks; delete state.courses[id]; save(); return true; }

    // ----- Loading a playlist -----
    function fromPage(pid) {
      return io.fetchText('https://www.youtube.com/playlist?list=' + pid, YT_HEADERS).then(function (html) {
        var data = initialData(html);
        if (!data) throw new Error(/consent\.(youtube|google)\.com/i.test(html) ? 'YouTube showed its cookie page. Try again in a minute.' : "YouTube's page came back in a shape Shelf can't read.");
        var first = readVideos(data), ci = clientInfo(html), all = first.items.slice(), pages = 1, partial = 0;
        if (!all.length && /"alerts"[\s\S]{0,400}(private|does not exist|unavailable)/i.test(html)) throw new Error('YouTube says this playlist is private or gone.');
        // Any chain that stops while YouTube still offers more (page limit, no way to ask, an empty or failed
        // answer) leaves the list partial, so Mo's note and progress never treat a short list as the whole thing
        function more(token) {
          if (!token) return Promise.resolve();
          if (pages >= MAX_PAGES || !io.postJSON) { partial = -1; return Promise.resolve(); }
          pages++;
          return io.postJSON('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false' + (ci.key ? '&key=' + ci.key : ''),
            { context: { client: { clientName: 'WEB', clientVersion: ci.ver, hl: 'en', gl: 'GB' } }, continuation: token },
            { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': ci.ver, Origin: 'https://www.youtube.com', Cookie: CONSENT, 'User-Agent': DESKTOP })
            .then(function (t) { var r = readVideos(initialData(t) || {}); all = all.concat(r.items); if (!r.items.length) { partial = -1; return null; } return more(r.token); },
              function () { partial = -1; });
        }
        // partial: how many YouTube says there are (or -1 if it didn't say) when "load more" failed
        return more(first.token).then(function () { return { title: first.title, items: all, partial: partial ? (first.count > all.length ? first.count : -1) : 0 }; });
      });
    }
    function fromApi(pid, key) {
      var all = [], title = '';
      function page(tok, n) {
        return io.fetchText(API + 'playlistItems?part=snippet&maxResults=50&playlistId=' + pid + '&key=' + encodeURIComponent(key) + (tok ? '&pageToken=' + tok : '')).then(function (t) {
          var j = JSON.parse(t);
          (j.items || []).forEach(function (it) { var sn = it.snippet || {}, v = sn.resourceId && sn.resourceId.videoId; if (v && !GONE.test('[' + String(sn.title).replace(/^\[|\]$/g, '') + ']')) all.push({ id: v, title: sn.title, dur: 0 }); });
          if (j.nextPageToken && n >= 80) cut = true;
          return j.nextPageToken && n < 80 ? page(j.nextPageToken, n + 1) : null;
        });
      }
      var cut = false;
      return io.fetchText(API + 'playlists?part=snippet&id=' + pid + '&key=' + encodeURIComponent(key)).then(function (t) {
        var j = JSON.parse(t); title = j.items && j.items[0] && j.items[0].snippet.title || '';
        return page('', 0);
      }).then(function () { return { title: title, items: all, partial: cut ? -1 : 0 }; });
    }
    function fetchList(pid) {
      var key = io.apiKey && io.apiKey();
      return key ? fromApi(pid, key).catch(function () { return fromPage(pid); }) : fromPage(pid);
    }
    function load(id, force) {
      var c = get(id), ch = cache[id];
      if (!c) return Promise.reject(new Error('gone'));
      if (busy[id]) return busy[id];
      if (!force && ch && ch.ok !== false && ch.items && !ch.partial && now() - ch.fetched < TTL) return Promise.resolve(c); // a partial list is tried again on the next sync
      busy[id] = fetchList(id).then(function (r) {
        var seen = {}, its = [];
        r.items.forEach(function (x) { if (!seen[x.id]) { seen[x.id] = 1; x.n = epNumber(x.title); its.push(x); } });
        if (!its.length) throw new Error('This playlist has no videos Shelf can play.');
        // A refresh that came back short never replaces a complete list (the later episodes would vanish)
        if (r.partial && ch && ch.items && ch.items.length && !ch.partial && ch.items.length >= its.length) cache[id] = Object.assign({}, ch, { fetched: now(), ok: true, shortRefresh: true });
        else cache[id] = { fetched: now(), ok: true, items: its, partial: r.partial };
        if (r.title) c.title = r.title;
        applySeed(c); // waits by itself until the whole list is known
        saveCache(); save();
        delete busy[id]; return c;
      }).catch(function (e) {
        cache[id] = Object.assign({}, ch || { items: null }, { fetched: now(), ok: false, error: e && e.message || 'failed' });
        delete busy[id]; return c;
      });
      return busy[id];
    }
    // Mo's note, applied once the episodes are known
    // It needs the whole list: with no list yet, or a partial one, the note is kept for a later full load.
    function applySeed(c) {
      var s = c.seed; if (!s) return;
      var ch = cache[c.id], arr = items(c.id);
      if (!ch || ch.partial || !arr.length) return;
      delete c.seed;
      if (s.all) arr.forEach(function (x) { c.ticks[x.id] = 1; });
      if (s.upTo) {
        var hitsN = findNumber(c.id, s.upTo), at = hitsN[0];
        if (at != null) { for (var j = 0; j <= at; j++) c.ticks[arr[j].id] = 1; c.note = hitsN.length > 1 ? s.upTo + ' appears ' + hitsN.length + ' times in this playlist, so it is ticked up to the first one. Check where you are.' : ''; }
        else if (s.pct) {
          var k = Math.round(arr.length * s.pct / 100);
          for (var q = 0; q < k; q++) c.ticks[arr[q].id] = 1;
          c.note = "Couldn't find episode " + s.upTo + ' in this playlist, so the first ' + s.pct + '% are ticked. Check where you are.';
        }
        touch(c);
      }
      if (s.pin) { var p = findNumber(c.id, s.pin)[0]; if (p != null) c.pins[arr[p].id] = 1; }
    }

    // ----- Adding -----
    function addCourse(pid, info) {
      var prior = state.removed && state.removed[pid];
      var c = state.courses[pid] = state.courses[pid] || {
        id: pid, name: info.name || 'Course', title: info.title || '', channel: info.channel || '', section: info.section || 'med',
        added: now(), touched: 0, ticks: prior || {}, pins: {}
      };
      if (info.seed) c.seed = info.seed;
      if (prior) delete state.removed[pid];
      save(); return c;
    }
    // A pasted link -> a loaded course. Resolves to the course; rejects with a plain-words reason.
    function add(input, opts) {
      opts = opts || {};
      var pid = playlistId(input);
      if (!pid) return Promise.reject(new Error("That's not a playlist link. It should contain list=."));
      if (get(pid)) return Promise.reject(new Error('Already on your shelf as ' + get(pid).name + '.'));
      return fetchList(pid).then(function (r) {
        var seen = {}, its = [];
        r.items.forEach(function (x) { if (!seen[x.id]) { seen[x.id] = 1; x.n = epNumber(x.title); its.push(x); } });
        if (!its.length) throw new Error('This playlist has no videos Shelf can play.');
        var c = addCourse(pid, { name: opts.name || shortName(r.title), title: r.title, section: opts.section, channel: opts.channel });
        cache[pid] = { fetched: now(), ok: true, items: its, partial: r.partial };
        saveCache(); save();
        return c;
      });
    }

    // ----- Channel playlists (for finding Mo's, and for the Add list) -----
    var chanCache = {};
    function channelPlaylists(handle) {
      if (chanCache[handle]) return Promise.resolve(chanCache[handle]);
      return io.fetchText('https://www.youtube.com/' + handle + '/playlists', YT_HEADERS).then(function (html) {
        var data = initialData(html);
        if (!data) throw new Error("Couldn't read " + handle + "'s playlists page.");
        var r = readPlaylists(data), ci = clientInfo(html), all = r.items.slice(), pages = 1;
        function more(token) {
          if (!token || pages >= 5 || !io.postJSON) return Promise.resolve();
          pages++;
          return io.postJSON('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false' + (ci.key ? '&key=' + ci.key : ''),
            { context: { client: { clientName: 'WEB', clientVersion: ci.ver, hl: 'en', gl: 'GB' } }, continuation: token },
            { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': ci.ver, Origin: 'https://www.youtube.com', Cookie: CONSENT, 'User-Agent': DESKTOP })
            .then(function (t) { var x = readPlaylists(initialData(t) || {}); var seen = {}; all.forEach(function (p) { seen[p.id] = 1; }); x.items.forEach(function (p) { if (!seen[p.id]) all.push(p); }); return x.items.length ? more(x.token) : null; }, function () {});
        }
        return more(r.token).then(function () { chanCache[handle] = all; return all; });
      });
    }
    // Best playlist for a name: Step 2 / question playlists first, then the biggest
    function pick(all, re) {
      var rx = new RegExp(re, 'i');
      var hits = all.filter(function (p) { return rx.test(p.title); });
      var score = function (p) { return (/step\s*2|\bck\b|shelf/i.test(p.title) ? 4 : 0) + (/step\s*1/i.test(p.title) ? -4 : 0) + (/\bq'?s?\b|question|qbank/i.test(p.title) ? 3 : 0) + (/\bhy\b|usmle/i.test(p.title) ? 1 : 0); };
      hits.sort(function (a, b) { return score(b) - score(a) || (b.count || 0) - (a.count || 0); });
      return hits[0] || null;
    }
    // First run in the app: find Mo's six playlists. Later runs retry only the misses.
    function seed() {
      var todo = SEED.courses.filter(function (s) {
        return !list().some(function (c) { return c.seedName === s.name; }) && (!state.found || (state.misses || []).some(function (m) { return m.name === s.name; }));
      });
      if (!todo.length) return Promise.resolve([]);
      return channelPlaylists(SEED.channel).then(function (all) {
        var misses = [];
        todo.forEach(function (s) {
          var p = pick(all, s.match);
          if (!p || get(p.id)) { if (!p) misses.push({ name: s.name, error: 'not on the channel\'s Playlists page' }); return; }
          var c = addCourse(p.id, { name: s.name, title: p.title, channel: 'Mehlman Medical', section: SEED.section, seed: { upTo: s.upTo, pct: s.pct, all: s.all, pin: s.pin } });
          c.seedName = s.name;
        });
        state.found = true; state.misses = misses; save();
        return misses;
      }, function (e) {
        state.misses = todo.map(function (s) { return { name: s.name, error: e && e.message || 'failed' }; });
        save(); return state.misses;
      });
    }
    // A miss fixed by hand (pasted link) clears it
    function fixMiss(name, c) { c.seedName = name; state.misses = (state.misses || []).filter(function (m) { return m.name !== name; }); var s = SEED.courses.filter(function (x) { return x.name === name; })[0]; if (s) { c.seed = { upTo: s.upTo, pct: s.pct, all: s.all, pin: s.pin }; applySeed(c); } save(); }
    function loadAll(force, onEach) {
      var ids = list().map(function (c) { return c.id; }), i = 0;
      function next() { if (i >= ids.length) return Promise.resolve(); var id = ids[i++]; return load(id, force).then(function () { if (onEach) onEach(id); }).then(next); }
      return Promise.all([next(), next()]);
    }
    // ----- Exam clock and pace -----
    var DAY = 864e5;
    function dayStart(t) { var d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
    function daysLeft(t) { return Math.max(0, Math.round((dayStart(EXAM.getTime()) - dayStart(t == null ? now() : t)) / DAY)); }
    function examPast(t) { return dayStart(t == null ? now() : t) > dayStart(EXAM.getTime()); }
    // Ticks done by hand (or by finishing a video) in [from, to)
    function ticksBetween(c, from, to) {
      var at = c.ticksAt || {}, n = 0, secs = 0, dur = {};
      items(c.id).forEach(function (x) { dur[x.id] = x.dur || 0; });
      Object.keys(at).forEach(function (v) { if (c.ticks[v] === 1 && at[v] >= from && at[v] < to) { n++; secs += dur[v] || 0; } });
      return { n: n, secs: secs };
    }
    // What's left, how many a day finish it by the exam, and when it finishes at this week's rate
    function pace(id, t) {
      t = t || now();
      var c = get(id), pr = progress(id); if (!c || !pr) return null;
      var left = pr.total - pr.done, days = daysLeft(t), rate7 = ticksBetween(c, dayStart(t) - 6 * DAY, dayStart(t) + DAY).n / 7;
      return { left: left, days: days, perDay: left && days ? left / days : 0, rate7: rate7,
        finishBy: left && rate7 ? dayStart(t) + Math.ceil(left / rate7) * DAY : 0 };
    }
    // All courses together: today, the last seven days (oldest first, today last), and what's left
    function today(t) {
      t = t || now();
      var d0 = dayStart(t), out = { n: 0, secs: 0, week: [0, 0, 0, 0, 0, 0, 0], weekN: 0, left: 0, days: daysLeft(t), perDay: 0 };
      list().forEach(function (c) {
        var td = ticksBetween(c, d0, d0 + DAY); out.n += td.n; out.secs += td.secs;
        for (var i = 0; i < 7; i++) out.week[i] += ticksBetween(c, d0 - (6 - i) * DAY, d0 - (5 - i) * DAY).n;
        var pr = progress(c.id); if (pr && pr.total) out.left += pr.total - pr.done;
      });
      out.weekN = out.week.reduce(function (a, b) { return a + b; }, 0);
      out.perDay = out.left && out.days ? out.left / out.days : 0;
      return out;
    }

    return {
      pace: pace, today: today, daysLeft: daysLeft, examPast: examPast,
      list: list, get: get, items: items, status: status, progress: progress, where: where, isDone: function (id, vid) { var c = get(id); return !!c && isDone(c, vid); },
      tick: tick, touch: touchCourse, tickUpTo: tickUpTo, restore: restore, pin: pin, findNumber: findNumber, move: move, remove: remove,
      load: load, loadAll: loadAll, add: add, seed: seed, fixMiss: fixMiss, channelPlaylists: channelPlaylists,
      get misses() { return state.misses || []; }, get busy() { return Object.keys(busy).length > 0; }, raw: function () { return state; }
    };
  }
  return { create: create, KEY: KEY, IKEY: IKEY, SEED: SEED, EXAM: EXAM_DEFAULT, exam: exam, setExam: setExam, perDay: perDay, epNumber: epNumber, playlistId: playlistId, shortName: shortName,
    initialData: initialData, readVideos: readVideos, channelVideos: channelVideos, agoTime: agoTime, readPlaylists: readPlaylists, fmtHours: fmtHours, historySpot: historySpot, historyLatest: historyLatest };
})();
if (typeof module !== 'undefined') module.exports = Courses;
