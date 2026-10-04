// Shelf v2 (Day Sheet): Home bands, section/channel/search pages, YouTube player, night player, self-check.
(function () {
  var KEY = 'resume.shelf.v1', PREF = 'resume.prefs.v1', AKEY = 'shelf.v2.audio';
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var reduced = function () { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  var isPhone = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  var feedsOn = Native.inApp; // browsers can't read YouTube's channel lists (no cross-site permission); the app can

  // ---------- storage ----------
  var canSave = (function () {
    try { localStorage.setItem('shelf.probe', '1'); var ok = localStorage.getItem('shelf.probe') === '1'; localStorage.removeItem('shelf.probe'); return ok; }
    catch (e) { return false; }
  })();
  var mem = {};
  function rawGet(k) { try { return canSave ? localStorage.getItem(k) : (k in mem ? mem[k] : null); } catch (e) { return null; } }
  var lastSaveError = '';
  function rawSet(k, s, mirror) {
    if (mirror !== false) Native.prefSet(k, s);
    if (!canSave) { mem[k] = s; return Native.inApp; }
    try { localStorage.setItem(k, s); lastSaveError = ''; return true; } catch (e) { lastSaveError = (e && e.name) || 'error'; return false; }
  }
  function load(k, d) { try { var v = JSON.parse(rawGet(k) || 'null'); return v && typeof v === 'object' ? v : d; } catch (e) { return d; } }
  function store(k, v) { return rawSet(k, JSON.stringify(v)); }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) {}

  var videos, prefs, arec, lib, aMeta = {};
  var lastSavedAt = 0;
  function saveVideos() { if (store(KEY, videos)) lastSavedAt = Date.now(); renderSoon(); }
  function saveAudio() { if (store(AKEY, arec)) lastSavedAt = Date.now(); }
  function savePrefs() { store(PREF, prefs); }

  // ---------- network ----------
  function withTimeout(p, ms, msg) {
    return new Promise(function (res, rej) { var t = setTimeout(function () { rej(new Error(msg)); }, ms); p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); }); });
  }
  function netError(e) {
    if (e && e.name === 'TypeError') return new Error(Native.inApp ? "Couldn't reach the internet. Check your connection." : 'This needs the Shelf app on your iPhone. Browsers aren\'t allowed to read YouTube\'s channel lists.');
    return e;
  }
  // In the app every read goes through iOS networking (Native.httpGet); in a browser, plain fetch
  function get(url, headers) {
    var p = Native.inApp ? Native.httpGet(url, headers).catch(function () { throw new Error("Couldn't reach the internet. Check your connection."); })
      : fetch(url, { credentials: 'omit' }).then(function (r) { return r.text().then(function (t) { return { ok: r.ok, status: r.status, text: t }; }); }, function (e) { throw netError(e); });
    return withTimeout(p, 20000, 'No answer after 20 seconds. Check your internet.');
  }
  function fetchText(url, headers) {
    return get(url, headers).then(function (r) {
      if (!r.ok) throw new Error(r.status === 404 ? 'Not found (it may have moved or been deleted).' : 'The server said ' + r.status + '.');
      if (r.unreadable) throw new Error('It sent something Shelf can\'t read.');
      return r.text;
    });
  }
  function fetchJSON(url) { return get(url); }

  // ---------- model helpers ----------
  function sectionIndex(id) { var s = lib.sections(); for (var i = 0; i < s.length; i++) if (s[i].id === id) return i; return -1; }
  function bandClass(id) { var i = sectionIndex(id); return i < 0 ? 'c0' : 'c' + (i % 3 + 1); }
  function videoSection(v) {
    if (v.channelId && lib.source(v.channelId)) return lib.source(v.channelId).section;
    if (v.section && lib.section(v.section)) return v.section;
    if (v.author) { var a = v.author.toLowerCase(), hit = lib.sources().filter(function (s) { return s.name.toLowerCase() === a; })[0]; if (hit) return hit.section; }
    return null;
  }
  function entryFromItem(src, it) {
    if (src.type === 'podcast') return { type: 'audio', key: it.guid, title: it.title, src: src.id, srcName: src.name, published: it.published, dur: it.duration, image: it.image || src.image, url: it.url, section: src.section };
    var v = videos[it.id];
    return { type: 'video', key: it.id, title: it.title, src: src.id, srcName: src.name, published: it.published, dur: (v && v.dur) || 0, thumb: it.thumb, section: src.section };
  }
  function entryFromVideo(v) { return { type: 'video', key: v.id, title: v.title || 'YouTube video', src: v.channelId || '', srcName: v.author || '', published: v.added || 0, dur: v.dur, section: videoSection(v), updated: v.updated }; }
  function entryFromAudio(g, r) { var s = r.source && lib.source(r.source); return { type: 'audio', key: g, title: r.title || 'Episode', src: r.source || '', srcName: r.podcast || (s && s.name) || '', published: r.published || 0, dur: r.dur, image: r.image || (s && s.image) || '', url: r.url, section: s ? s.section : null, updated: r.updated }; }
  function prog(e) { return e.type === 'video' ? videos[e.key] : arec[e.key]; }
  function started(e) { var p = prog(e); return !!p && !p.done && p.t > 5; }
  function isDoneE(e) { var p = prog(e); return !!p && !!p.done; }
  function isNew(e) { var s = lib.source(e.src), p = prog(e); return !!s && e.published > (s.seenUpTo || 0) && !(p && (p.t > 5 || p.done)); }
  function feedEntries(sectionId) {
    var out = [];
    lib.sources(sectionId).forEach(function (s) { lib.items(s.id).forEach(function (it) { out.push(entryFromItem(s, it)); }); });
    return out.sort(function (a, b) { return b.published - a.published; });
  }
  function startedEntries(sectionId) {
    var out = [];
    Object.keys(videos).forEach(function (id) { var e = entryFromVideo(videos[id]); if (started(e) && e.section === sectionId) out.push(e); });
    Object.keys(arec).forEach(function (g) { var e = entryFromAudio(g, arec[g]); if (started(e) && (sectionId === undefined || e.section === sectionId)) out.push(e); });
    return out.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
  }
  function newCountFor(sectionId) { return feedEntries(sectionId).filter(isNew).length; }
  function srcNewCount(id) { var s = lib.source(id); return s ? lib.items(id).map(function (it) { return entryFromItem(s, it); }).filter(isNew).length : 0; }
  function thumbOf(e) { return e.type === 'video' ? (e.thumb || 'https://i.ytimg.com/vi/' + e.key + '/mqdefault.jpg') : (e.image || ''); }

  // Entries on screen, looked up by the code on each button
  var reg = { h: [], p: [] };
  function regE(scope, e) { reg[scope].push(e); return scope + (reg[scope].length - 1); }
  function regGet(code) { return code ? reg[code[0]][+code.slice(1)] : null; }

  // ---------- Home ----------
  var renderTimer = null;
  function renderSoon() { clearTimeout(renderTimer); renderTimer = setTimeout(renderAll, 60); }
  function renderAll() { renderHome(); if (stack.length) renderPage(); }
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function durText(e) {
    var p = prog(e), d = (p && p.dur) || e.dur;
    if (started(e)) return d ? Core.fmt(p.t) + ' / ' + Core.fmt(d) : Core.fmt(p.t);
    return d ? Core.fmt(d) : shortAgo(e.published);
  }
  function agoLong(ts) { var s = (Date.now() - ts) / 1000; return s < 3600 ? Math.max(1, Math.round(s / 60)) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Core.ago(ts); }
  // "3h", "2d": fits the narrow number column
  function shortAgo(ts) {
    if (!ts) return '';
    var s = (Date.now() - ts) / 1000;
    return s < 3600 ? Math.max(1, Math.round(s / 60)) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd';
  }
  function bandRow(e, scope) {
    var p = prog(e), pc = p && p.dur ? Core.pct(p) : 0;
    return '<li><button type="button" data-act="play" data-e="' + regE(scope, e) + '"><span>' + (isNew(e) ? '<span class="nw">NEW</span>' : '') +
      '<b>' + esc(e.title) + '</b><br><span class="src">' + esc(e.srcName) + (started(e) && p.dur ? ' · ' + esc(Core.left(p.t, p.dur).toLowerCase()) : '') + '</span>' +
      (started(e) ? '<span class="pr"><i style="width:' + pc.toFixed(1) + '%"></i></span>' : '') +
      '</span><span class="n mono">' + esc(durText(e)) + '</span></button></li>';
  }
  var refreshing = false;
  function renderHome() {
    reg.h = [];
    var d = new Date();
    $('#dayNum').textContent = (d.getDate() < 10 ? '0' : '') + d.getDate();
    $('#dayName').textContent = DAYS[d.getDay()];
    $('#monthName').textContent = MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    var allNew = 0, unfinished = startedEntries(undefined).length;
    Object.keys(videos).forEach(function (id) { var e = entryFromVideo(videos[id]); if (started(e)) unfinished++; });
    var html = '';
    lib.sections().forEach(function (sec) {
      var fresh = feedEntries(sec.id).filter(isNew), go = startedEntries(sec.id);
      allNew += fresh.length;
      var list = fresh.slice(0, 2).concat(go.slice(0, 2));
      fresh.slice(2).concat(go.slice(2)).forEach(function (e) { if (list.length < 4) list.push(e); });
      var srcs = lib.sources(sec.id).length;
      html += '<section class="band ' + bandClass(sec.id) + '" aria-label="' + esc(sec.name) + '">' +
        '<button type="button" class="hd" data-act="open-section" data-id="' + esc(sec.id) + '"><h2>' + esc(sec.name) + '</h2><span class="tm mono">' +
        (fresh.length ? fresh.length + ' new' : srcs ? srcs + (srcs === 1 ? ' channel' : ' channels') : 'empty') + ' ›</span></button>';
      if (list.length) html += '<ul>' + list.map(function (e) { return bandRow(e, 'h'); }).join('') + '</ul>';
      else if (!srcs && !feedsOn) html += '<p class="empty">Your channels show here in the Shelf app on your iPhone.</p>';
      else if (!srcs) html += '<p class="empty">No channels yet. <button type="button" data-act="add-channel" data-id="' + esc(sec.id) + '">Add one</button></p>';
      else html += '<p class="empty">' + (refreshing && !lib.sources(sec.id).some(function (s) { return lib.items(s.id).length; }) ? 'Checking for new uploads…' : 'Nothing new. All caught up.') + '</p>';
      html += '</section>';
    });
    // Pasted videos that belong to no section
    var loose = Object.keys(videos).map(function (id) { return entryFromVideo(videos[id]); }).filter(function (e) { return !e.section && !isDoneE(e); })
      .sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    if (loose.length) {
      html += '<section class="band c0" aria-label="Pasted"><button type="button" class="hd" data-act="open-pasted"><h2>Pasted</h2><span class="tm mono">' + loose.length + ' ›</span></button>' +
        '<ul>' + loose.slice(0, 4).map(function (e) { return bandRow(e, 'h'); }).join('') + '</ul></section>';
    }
    $('#bands').innerHTML = html;
    fitAll($('#bands'));
    // Resume strip: the most recent unfinished thing anywhere
    var all = startedEntries(undefined).concat(Object.keys(videos).map(function (id) { return entryFromVideo(videos[id]); }).filter(started))
      .sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    var top = all[0];
    $('#cont').hidden = !top;
    if (top) {
      var p = prog(top);
      $('#cont').setAttribute('data-e', regE('h', top));
      $('#contTitle').textContent = top.title;
      $('#contMeta').textContent = (top.srcName ? top.srcName + ' · ' : '') + Core.fmt(p.t) + (p.dur ? ' / ' + Core.fmt(p.dur) : '');
      $('#contBar').style.width = 'calc((100% - 2 * var(--g)) * ' + (Core.pct(p) / 100).toFixed(3) + ')';
      $('#cont').setAttribute('aria-label', 'Resume ' + top.title + ' from ' + Core.fmt(p.t));
    }
    $('#summary').textContent = refreshing ? 'Checking for new uploads…' : allNew + ' new · ' + unfinished + ' unfinished';
    var wn = $('#webNote');
    if (!feedsOn) { wn.hidden = false; wn.textContent = isPhone ? 'New uploads and channels load in the Shelf app. Here you can paste a link and pick up where you left off.' : 'New uploads and channels load in the Shelf app on your iPhone. On this Mac you can paste a link (⌘V) and pick up where you left off.'; }
    else wn.hidden = true;
  }

  // ---------- Pages ----------
  var stack = [];
  function push(view) { stack.push(view); renderPage(); $('#page').scrollTop = 0; try { history.pushState({ shelf: stack.length }, ''); } catch (e) {} }
  function pop() { stack.pop(); if (stack.length) renderPage(); else { $('#page').hidden = true; renderHome(); } }
  window.addEventListener('popstate', function () { if (stack.length) pop(); });
  function back() { try { history.back(); } catch (e) { pop(); } }
  function itemHTML(e, scope, opts) {
    opts = opts || {};
    var p = prog(e), done = isDoneE(e), pc = p && p.dur ? Core.pct(p) : 0, th = thumbOf(e);
    var meta;
    if (started(e)) meta = '<b>' + esc(Core.fmt(p.t)) + (p.dur ? ' / ' + esc(Core.fmt(p.dur)) : '') + '</b> · resume';
    else meta = [e.dur ? '<b>' + esc(Core.fmt(e.dur)) + '</b>' : '', e.published ? esc(agoLong(e.published)) : '', done ? 'finished' : ''].filter(Boolean).join(' · ');
    return '<button type="button" class="item' + (done ? ' watched' : '') + '" data-act="play" data-e="' + regE(scope, e) + '">' +
      '<span class="th">' + (th ? '<img src="' + esc(th) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' : '') + '</span>' +
      '<span><span class="ch"><span>' + esc(e.srcName || (e.type === 'audio' ? 'Podcast' : 'YouTube')) + '</span>' + (opts.fresh || isNew(e) ? '<span class="nw">NEW</span>' : '') + '</span>' +
      '<span class="t" style="display:block">' + esc(e.title) + '</span>' +
      '<span class="meta mono" style="display:block">' + meta + '</span>' +
      (started(e) ? '<span class="pr"><i style="width:' + pc.toFixed(1) + '%"></i></span>' : '') + '</span></button>';
  }
  function eyebrow(backLabel, right) {
    return '<div class="eyebrow mono"><button type="button" data-act="back">← ' + esc(backLabel) + '</button><span>' + esc(right) + '</span></div>';
  }
  function shortDate() { var d = new Date(); return (d.getDate() < 10 ? '0' : '') + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3).toUpperCase(); }
  function h1(name) { return '<h1 class="fit">' + esc(name) + '</h1>'; }
  // Long names get narrower letters first (Archivo has a width axis), then smaller, so a word never breaks mid-way
  function fit(el, maxSize, minSize) {
    el.style.fontStretch = ''; el.style.fontSize = ''; el.classList.remove('wrap');
    if (el.scrollWidth <= el.clientWidth + 1) return;
    var stretch = 125, size = maxSize;
    while (el.scrollWidth > el.clientWidth + 1 && stretch > 75) { stretch -= 10; el.style.fontStretch = stretch + '%'; }
    while (el.scrollWidth > el.clientWidth + 1 && size > minSize) { size -= 2; el.style.fontSize = size + 'px'; }
    if (el.scrollWidth > el.clientWidth + 1) el.classList.add('wrap'); // several words: let it wrap between them
  }
  function fitAll(scope) {
    Array.prototype.forEach.call(scope.querySelectorAll('.band .hd h2'), function (h) { fit(h, innerWidth >= 900 ? 58 : 46, 26); });
    Array.prototype.forEach.call(scope.querySelectorAll('.top h1.fit'), function (h) { fit(h, 62, 30); });
  }
  window.addEventListener('resize', function () { fitAll(document); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fitAll(document); });
  var chanNew = {}; // keys that were new when the channel page opened
  var confirmRemove = null;
  function renderPage() {
    var v = stack[stack.length - 1], pg = $('#page'), html = '';
    if (!v) return;
    reg.p = [];
    pg.hidden = false;
    if (v.name === 'section') {
      var sec = lib.section(v.id);
      if (!sec) { stack.pop(); return renderPage(); }
      var srcs = lib.sources(sec.id), nn = newCountFor(sec.id);
      html += '<div class="top band ' + bandClass(sec.id) + '">' + eyebrow(shortDate(), srcs.length + (srcs.length === 1 ? ' CHANNEL' : ' CHANNELS') + (nn ? ' · ' + nn + ' NEW' : '')) + h1(sec.name) +
        '<p>Newest first. Finished ones drop off this sheet and stay in their channel.</p><div class="acts">' +
        '<button type="button" class="btn" data-act="add-channel" data-id="' + esc(sec.id) + '">+ Add channel</button>' +
        (nn ? '<button type="button" class="btn" data-act="seen-section" data-id="' + esc(sec.id) + '">Mark all seen</button>' : '') +
        '<button type="button" class="btn" data-act="edit-section" data-id="' + esc(sec.id) + '">Edit</button></div></div>';
      lib.seedMisses.filter(function (m) { return m.section === sec.id && !alreadyHave(m.input); }).forEach(function (m) {
        html += '<p class="pnote err">Couldn\'t find ' + esc(m.input) + ' automatically (' + esc(m.error) + ') <button type="button" data-act="fix-seed" data-in="' + esc(m.input) + '" data-id="' + esc(sec.id) + '">Fix</button></p>';
      });
      if (!feedsOn) html += '<p class="pnote">Channels load in the Shelf app on your iPhone.</p>';
      var items = feedEntries(sec.id).filter(function (e) { return !isDoneE(e); });
      var have = {}; items.forEach(function (e) { have[e.key] = 1; });
      startedEntries(sec.id).forEach(function (e) { if (!have[e.key]) items.unshift(e); });
      if (srcs.length && !items.length) html += '<p class="pnote">' + (refreshing ? 'Checking for new uploads…' : 'Nothing waiting here. Open a channel below to see older videos.') + '</p>';
      html += items.slice(0, 40).map(function (e) { return itemHTML(e, 'p'); }).join('');
      html += '<h2 class="sub-h"><span>Channels</span><span class="mono">' + srcs.length + '</span></h2>';
      if (!srcs.length) html += '<p class="pnote">No channels here yet. <button type="button" data-act="add-channel" data-id="' + esc(sec.id) + '">Add one</button></p>';
      srcs.forEach(function (s) {
        var st = lib.status(s.id), n = srcNewCount(s.id);
        var sub = st && !st.ok ? '<span class="err">Couldn\'t update: ' + esc(st.error) + '</span>' : n ? n + ' new' : st ? 'Updated ' + esc(Core.ago(st.fetched)) : 'Not checked yet';
        html += '<button type="button" class="chrow" data-act="open-channel" data-id="' + esc(s.id) + '"><span class="av">' + (s.image ? '<img src="' + esc(s.image) + '" alt="" loading="lazy" onerror="this.remove()">' : esc(s.name.charAt(0))) + '</span>' +
          '<span><b>' + esc(s.name) + '</b><small>' + (s.type === 'podcast' ? (s.private ? 'Private podcast · ' : 'Podcast · ') : '') + sub + '</small></span><span aria-hidden="true">›</span></button>';
      });
      html += '<button type="button" class="more" data-act="add-channel" data-id="' + esc(sec.id) + '"><span>+ Add channel</span><span class="mono">paste a channel link</span></button>';
    } else if (v.name === 'channel') {
      var s = lib.source(v.id);
      if (!s) { stack.pop(); return renderPage(); }
      var sec2 = lib.section(s.section), st2 = lib.status(s.id), list = lib.items(s.id).map(function (it) { return entryFromItem(s, it); });
      html += '<div class="top band ' + bandClass(s.section) + '">' + eyebrow(sec2 ? sec2.name.toUpperCase() : 'BACK', s.type === 'podcast' ? (s.private ? 'PRIVATE PODCAST' : 'PODCAST') : 'YOUTUBE') + h1(s.name) +
        '<p>' + (st2 && !st2.ok ? 'Couldn\'t update: ' + esc(st2.error) : (s.type === 'podcast' ? 'Latest episodes.' : 'Latest ' + list.length + ' videos.') + (st2 ? ' Updated ' + esc(Core.ago(st2.fetched)) + '.' : '')) + '</p>' +
        '<div class="acts"><button type="button" class="btn" data-act="refresh-channel" data-id="' + esc(s.id) + '">Refresh</button>' +
        '<button type="button" class="btn danger" data-act="remove-channel" data-id="' + esc(s.id) + '">' + (confirmRemove === s.id ? 'Tap again to remove' : 'Remove') + '</button></div>' +
        '<div class="acts">' + lib.sections().map(function (x) { return '<button type="button" class="btn' + (x.id === s.section ? ' solid' : '') + '" data-act="move-channel" data-id="' + esc(s.id) + '" data-to="' + esc(x.id) + '" aria-pressed="' + (x.id === s.section) + '">' + esc(x.name) + '</button>'; }).join('') + '</div></div>';
      if (!list.length) html += '<p class="pnote">' + (st2 && !st2.ok ? 'Nothing loaded. Tap Refresh to try again.' : 'Loading…') + '</p>';
      html += list.map(function (e) { return itemHTML(e, 'p', { fresh: chanNew[e.key] }); }).join('');
      if (s.type === 'youtube') html += '<p class="pnote">YouTube lists only the latest 15 uploads here. For older ones, use Search.</p>';
    } else if (v.name === 'pasted') {
      var vids = Object.keys(videos).map(function (id) { return entryFromVideo(videos[id]); }).filter(function (e) { return !e.section; })
        .sort(function (a, b) { return (isDoneE(a) - isDoneE(b)) || (b.updated || 0) - (a.updated || 0); });
      html += '<div class="top band c0">' + eyebrow(shortDate(), vids.length + ' VIDEOS') + h1('Pasted') + '<p>Links you pasted from channels you don\'t follow. Finished ones stay at the bottom.</p></div>';
      if (!vids.length) html += '<p class="pnote">Nothing pasted yet.</p>';
      vids.forEach(function (e) { html += itemHTML(e, 'p') + '<button type="button" class="more" data-act="remove-video" data-id="' + esc(e.key) + '"><span class="mono">Remove ' + esc(e.title.slice(0, 40)) + '</span><span>×</span></button>'; });
    } else if (v.name === 'search') {
      html += '<div class="top band c2">' + eyebrow(shortDate(), prefs.apiKey ? 'GOOGLE KEY' : 'NO KEY NEEDED') + h1('Search') +
        '<form class="sform" id="sform"><input id="sq" type="search" enterkeyhint="search" autocomplete="off" placeholder="hyperkalemia, Emu War…" value="' + esc(v.q || '') + '" aria-label="Search YouTube"><button type="submit">Go</button></form></div>';
      if (v.msg) html += '<p class="pnote' + (v.err ? ' err' : '') + '">' + esc(v.msg) + '</p>';
      (v.results || []).forEach(function (r) {
        if (r.kind === 'channel') {
          var have2 = !!lib.source(r.id);
          html += '<div class="item"><span class="th">' + (r.thumb ? '<img src="' + esc(r.thumb) + '" alt="" loading="lazy" onerror="this.remove()">' : '') + '</span><span><span class="ch"><span>Channel</span></span><span class="t" style="display:block">' + esc(r.title) + '</span>' +
            (have2 ? '<span class="meta" style="display:block">Already on your shelf</span>' : '<button type="button" class="btn addch" data-act="add-channel" data-in="' + esc(r.id) + '">+ Add channel</button>') + '</span></div>';
        } else {
          var e = { type: 'video', key: r.id, title: r.title, src: r.channelId, srcName: r.channel, published: r.published || 0, dur: r.dur || 0, thumb: r.thumb, section: lib.source(r.channelId) ? lib.source(r.channelId).section : null };
          html += itemHTML(e, 'p');
        }
      });
    }
    pg.className = 'page' + ({ c1: ' d1', c2: ' d2' }[v.name === 'section' ? bandClass(v.id) : v.name === 'channel' && lib.source(v.id) ? bandClass(lib.source(v.id).section) : ''] || '');
    pg.innerHTML = html;
    fitAll(pg);
    if (v.name === 'search') {
      var f = $('#sform');
      f.addEventListener('submit', function (ev) { ev.preventDefault(); runSearch($('#sq').value); });
      if (!v.results && !v.msg) setTimeout(function () { var q = $('#sq'); if (q) q.focus(); }, 50);
    }
  }
  function alreadyHave(input) { return lib.have(input); }
  function openSection(id) { push({ name: 'section', id: id }); }
  function openChannel(id) {
    var s = lib.source(id); chanNew = {};
    if (s) lib.items(id).forEach(function (it) { var e = entryFromItem(s, it); if (isNew(e)) chanNew[e.key] = 1; });
    confirmRemove = null;
    push({ name: 'channel', id: id });
    lib.markSeen(id);
    if (feedsOn) lib.refresh(id).then(function () { lib.saveCache(); renderAll(); });
  }

  // ---------- Search ----------
  var searchSeq = 0;
  function runSearch(q) {
    var v = stack[stack.length - 1]; if (!v || v.name !== 'search') return;
    v.q = q; v.msg = 'Searching…'; v.err = false; v.results = null; renderPage();
    var my = ++searchSeq;
    Search.run({ fetchJSON: fetchJSON, fetchText: fetchText }, q, prefs.apiKey).then(function (r) {
      if (my !== searchSeq) return;
      v.results = r; v.msg = r.length ? '' : 'No results for "' + q + '".'; renderPage();
    }, function (e) {
      if (my !== searchSeq) return;
      var m = e && e.message || 'Search failed.';
      if (!Native.inApp && !prefs.apiKey && /Shelf app/.test(m)) m = 'Search without a key works in the Shelf app on your iPhone. Here, add a Google key (self-check, Search key), or search on YouTube and paste the link.';
      v.msg = m; v.err = true; renderPage();
    });
  }

  // ---------- Feeds ----------
  function refreshAll(force) {
    if (!feedsOn || refreshing) return Promise.resolve();
    refreshing = true; renderSoon();
    var first = lib.seed();
    return first.then(function () { return lib.refreshAll(force, function () { renderSoon(); }); })
      .then(function () { refreshing = false; lib.saveCache(); lastRefresh = Date.now(); renderAll(); updateDot(); }, function () { refreshing = false; renderAll(); });
  }
  var lastRefresh = 0;

  // ---------- Video player ----------
  var player = null, playerReady = false, ytLoaded = false, ytFailed = false, current = null, pending = null, tick = null, lastErr = '';
  var armed = false, sawPlaying = false, loadStart = 0, startTimer = null, lastCaptureAt = 0, vTimer = null, vTimerMsg = '', wake = null, uiTick = null;
  window.onYouTubeIframeAPIReady = function () {
    ytLoaded = true; updateDot();
    var vars = { rel: 0, playsinline: 1, modestbranding: 1, autoplay: 1 };
    if (/^https?:$/.test(location.protocol)) vars.origin = location.origin;
    player = new YT.Player('player', {
      width: '100%', height: '100%', playerVars: vars,
      events: {
        onReady: function () { playerReady = true; if (pending) { var p = pending; pending = null; loadVideo(p); } },
        onStateChange: onState,
        onPlaybackRateChange: function (e) { prefs.rate = e.data; savePrefs(); },
        onError: onError
      }
    });
  };
  function loadYT() {
    var s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = function () { ytFailed = true; updateDot(); };
    document.head.appendChild(s);
    setTimeout(function () { if (!ytLoaded) { ytFailed = true; updateDot(); } }, 12000);
  }
  function ytLink(v) { return 'https://www.youtube.com/watch?v=' + v.id + (v.t > 5 && !v.done ? '&t=' + Math.floor(v.t) + 's' : ''); }
  function ensureVideo(o) {
    var now = Date.now(), v = videos[o.id];
    if (!v) v = videos[o.id] = { id: o.id, t: o.t || 0, dur: o.dur || 0, title: o.title || '', author: o.author || '', added: now, updated: now, done: false };
    if (o.title && !v.title) v.title = o.title;
    if (o.author && !v.author) v.author = o.author;
    if (o.channelId && !v.channelId) v.channelId = o.channelId;
    if (o.section && !v.section) v.section = o.section;
    if (o.t) { v.t = o.t; v.done = false; }
    return v;
  }
  function openSheet(id) {
    var el = $(id); el.classList.add('open'); el.setAttribute('aria-hidden', 'false');
    var b = el.querySelector('[data-act^="close"]'); if (b) setTimeout(function () { try { b.focus({ preventScroll: true }); } catch (e) {} }, 300);
  }
  function closeSheet(id) { var el = $(id); el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); }
  function openVideo(o) {
    if (engine && engine.state().playing) engine.pause();
    var v = ensureVideo(o);
    if (current && current !== v.id) capture(true);
    lastErr = ''; $('#perr').hidden = true;
    v.updated = Date.now(); saveVideos();
    $('#vTitle').textContent = v.title || 'YouTube video';
    $('#vCh').textContent = v.author || '';
    $('#ytLink').href = ytLink(v);
    openSheet('#vsheet');
    clearInterval(uiTick); uiTick = setInterval(videoTick, 1000);
    renderTimerUI('v');
    if (ytFailed && !playerReady) {
      current = null;
      showError("Can't reach YouTube. Check your internet, or turn off any content blocker, then reopen Shelf.", v);
      return;
    }
    current = v.id; armed = false; sawPlaying = false;
    if (!playerReady) { pending = v.id; return; }
    loadVideo(v.id);
  }
  function loadVideo(id) {
    var v = videos[id]; if (!v) return;
    var start = Core.resumeAt(v);
    if (v.done) { v.done = false; v.t = 0; saveVideos(); }
    loadStart = start;
    player.loadVideoById({ videoId: id, startSeconds: start });
    if (prefs.rate && prefs.rate !== 1) { try { player.setPlaybackRate(prefs.rate); } catch (e) {} }
    clearTimeout(startTimer);
    startTimer = setTimeout(function () { if (current === id && !sawPlaying) $('#vCh').textContent = 'Tap the video to start.'; }, 3500);
  }
  function capture(final) {
    if (!player || !current || !playerReady || !videos[current]) return;
    var v = videos[current], t, d;
    try {
      var vd = player.getVideoData && player.getVideoData();
      if (vd && vd.video_id && vd.video_id !== current) return;
      t = player.getCurrentTime(); d = player.getDuration();
      if (vd) { if (vd.title && !v.title) { v.title = vd.title; $('#vTitle').textContent = v.title; } if (vd.author && !v.author) v.author = vd.author; }
    } catch (e) { return; }
    if (typeof t !== 'number' || isNaN(t)) return;
    if (!armed) {
      if (!sawPlaying || t < loadStart - 3 || t > loadStart + 60) return;
      armed = true;
    }
    if (v.dur > 0 && d > 0 && d < v.dur * 0.9) return; // an ad or another video reporting
    if (d > 0) v.dur = d;
    if (t < 1 && v.t > 5) return; // the 0 reported while loading
    v.t = t; v.updated = Date.now(); lastCaptureAt = Date.now();
    saveVideos();
  }
  function onState(e) {
    var S = YT.PlayerState;
    var playing = e.data === S.PLAYING;
    $('#vPlay').textContent = playing ? '❚❚' : '▶';
    $('#vPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('#vPlay').classList.toggle('on', playing);
    if (playing) {
      sawPlaying = true; clearTimeout(startTimer);
      clearInterval(tick); tick = setInterval(capture, 5000);
      if (prefs.rate && player.getPlaybackRate && player.getPlaybackRate() !== prefs.rate) { try { player.setPlaybackRate(prefs.rate); } catch (er) {} }
      capture(); keepAwake(true);
      var v = videos[current]; if (v) $('#vCh').textContent = (v.author ? v.author + ' · ' : '') + (wake ? 'screen stays on' : 'saving your spot');
    } else {
      clearInterval(tick); keepAwake(false);
      if (e.data === S.ENDED && current && videos[current] && armed) {
        var w = videos[current]; w.t = w.dur || w.t; w.done = true; w.updated = Date.now();
        if (vTimer && vTimer.mode === 'end') vTimer = null;
        saveVideos(); closeVideo(true);
        toast('Finished. It stays in its channel, marked as watched.');
      } else if (e.data === S.PAUSED) capture(true);
    }
  }
  function onError(e) {
    if (!current) return;
    var v = videos[current];
    var msg = {
      2: "That link doesn't point to a real video. Check you copied the whole address.",
      5: "This video couldn't play here. Try opening it on YouTube.",
      100: 'This video was removed or made private by its owner.',
      101: "This video's owner only lets it play on YouTube itself.",
      150: "This video's owner only lets it play on YouTube itself.",
      153: 'YouTube needs Shelf opened from its web address. Close and reopen Shelf.'
    }[e.data] || 'YouTube had a problem playing this video (code ' + e.data + ').';
    clearTimeout(startTimer);
    showError(msg, e.data !== 153 ? v : null);
  }
  function showError(msg, v) {
    lastErr = msg;
    var html = '<span>' + esc(msg) + '</span>';
    if (v) html += '<a href="' + esc(ytLink(v)) + '" target="_blank" rel="noopener">Open on YouTube' + (v.t > 5 && !v.done ? ' at ' + Core.fmt(v.t) : '') + '</a>';
    var box = $('#perr'); box.innerHTML = html; box.hidden = false;
    updateDot();
  }
  function closeVideo(silent) {
    capture(true);
    try { player && player.pauseVideo(); } catch (e) {}
    clearInterval(tick); clearInterval(uiTick); clearTimeout(startTimer); keepAwake(false);
    current = null; vTimer = null; vTimerMsg = ''; lastErr = '';
    closeSheet('#vsheet');
    renderAll();
  }
  function keepAwake(on) {
    try {
      if (on && !wake && navigator.wakeLock) navigator.wakeLock.request('screen').then(function (w) { wake = w; w.addEventListener('release', function () { wake = null; }); }, function () {});
      else if (!on && wake) { wake.release(); wake = null; }
    } catch (e) {}
  }
  function videoTick() {
    if (!player || !current || !playerReady) return;
    var t = 0, d = 0, st = -1;
    try { t = player.getCurrentTime() || 0; d = player.getDuration() || 0; st = player.getPlayerState(); } catch (e) {}
    $('#vLine').style.width = d ? Math.min(100, t / d * 100).toFixed(2) + '%' : '0';
    $('#vT').textContent = Core.fmt(t);
    $('#vLeft').textContent = d ? '−' + Core.fmt(Math.max(0, d - t)) : '';
    if (vTimer && SleepTimer.tick(vTimer, Date.now(), false) === 'stop') {
      vTimer = null; capture(true);
      try { player.pauseVideo(); } catch (e) {}
      vTimerMsg = 'Paused by the sleep timer. Sleep well.';
      renderTimerUI('v');
      return;
    }
    renderTimerUI('v');
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      capture(true);
      if (engine) engine.capture(true);
      // YouTube doesn't allow its videos to keep playing in the background, so pause when Shelf is hidden
      if ((Native.inApp || isPhone) && current) { try { player.pauseVideo(); } catch (e) {} }
    } else {
      if (Date.now() - lastRefresh > 30 * 60000) refreshAll(false);
      renderAll();
    }
  });
  window.addEventListener('pagehide', function () { capture(true); if (engine) engine.capture(true); });

  // ---------- Sleep timer UI (shared by both players) ----------
  var SEGS = [15, 30, 45, 60, 'end'];
  // Press and hold a number for a 1-minute test timer (for the done test)
  var holdT = null, held = false;
  function holdStart(e) {
    var b = e.target.closest('[data-act="timer"]'); if (!b) return;
    held = false; clearTimeout(holdT);
    holdT = setTimeout(function () { held = true; setTimer(b.getAttribute('data-p'), 1); toast('Test timer: 1 minute.'); }, 600);
  }
  function holdEnd() { clearTimeout(holdT); }
  ['#vSeg', '#nSeg'].forEach(function (sel) {
    var el = document.querySelector(sel);
    el.addEventListener('pointerdown', holdStart); el.addEventListener('pointerup', holdEnd); el.addEventListener('pointerleave', holdEnd); el.addEventListener('pointercancel', holdEnd);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  });
  function buildSeg(sel, which) {
    $(sel).innerHTML = SEGS.map(function (m) { return '<button type="button" data-act="timer" data-p="' + which + '" data-m="' + m + '" aria-pressed="false">' + (m === 'end' ? 'End' : m) + '</button>'; }).join('');
  }
  function timerFor(which) { return which === 'v' ? vTimer : engine.state().timer; }
  function setTimer(which, m) {
    var cur = timerFor(which), same = cur && (cur.mode === 'end' ? m === 'end' : cur.minutes === +m);
    var val = same ? null : m === 'end' ? 'end' : +m;
    if (which === 'v') { vTimer = val == null ? null : SleepTimer.start(val); vTimerMsg = ''; }
    else engine.setTimer(val);
    renderTimerUI(which);
    if (which === 'a') renderAudio();
  }
  function renderTimerUI(which, msg) {
    var t = timerFor(which), now = Date.now();
    var seg = which === 'v' ? '#vSeg' : '#nSeg', cd = which === 'v' ? '#vCd' : '#nCd';
    Array.prototype.forEach.call(document.querySelectorAll(seg + ' button'), function (b) {
      var m = b.getAttribute('data-m');
      b.setAttribute('aria-pressed', String(!!t && (t.mode === 'end' ? m === 'end' : String(t.minutes) === m)));
    });
    var el = $(cd);
    if (!t) {
      el.className = (which === 'v' ? 'cd' : 'ncd') + ' mono off';
      el.textContent = msg || (which === 'v' && vTimerMsg) || (which === 'v' ? 'Off. Tap a number to stop the video after that many minutes.' : 'No sleep timer');
      if (which === 'v') $('#vStops').textContent = '';
      return;
    }
    el.className = (which === 'v' ? 'cd' : 'ncd') + ' mono';
    var small = which === 'v' ? 'remaining' : 'lights out in';
    if (t.mode === 'end') el.innerHTML = '<small>' + small + '</small>' + (which === 'v' ? 'End of video' : 'End');
    else el.innerHTML = '<small>' + small + '</small>' + SleepTimer.countdown(SleepTimer.remaining(t, now));
    if (t.mode === 'end') el.style.fontSize = which === 'v' ? '40px' : '64px'; else el.style.fontSize = '';
    if (which === 'v') $('#vStops').textContent = t.mode === 'min' ? 'stops at ' + SleepTimer.clock(t.endsAt).replace('about ', '') : 'stops when it ends';
  }

  // ---------- Night player (podcasts) ----------
  var engine = null, aTick = null, nightOpen = false;
  var RATES = [1, 1.25, 1.5, 2, 0.8];
  function initAudio() {
    engine = AudioEngine.create({
      el: $('#audio'),
      load: function (g) { return arec[g] || null; },
      save: function (g, r) { arec[g] = Object.assign({}, arec[g] || {}, aMeta[g] || {}, r); saveAudio(); },
      onChange: function () { renderAudio(); renderSoon(); }
    });
    if (prefs.arate) engine.setRate(prefs.arate);
    $('#audio').addEventListener('play', function () { clearInterval(aTick); aTick = setInterval(function () { engine.tick(); renderAudio(); }, 1000); });
    $('#audio').addEventListener('pause', function () { clearInterval(aTick); renderAudio(); });
  }
  function openAudio(e) {
    if (current) closeVideo(true);
    aMeta[e.key] = { source: e.src, image: e.image || '', published: e.published || 0, podcast: e.srcName };
    nightOpen = true; openSheet('#nsheet');
    var st = engine.state();
    if (st.episode && st.episode.guid === e.key) { if (!st.playing) engine.toggle(); renderAudio(); return; }
    engine.play({ guid: e.key, url: e.url, title: e.title, podcast: e.srcName, image: e.image, duration: e.dur });
    renderAudio();
  }
  function renderAudio() {
    if (!engine) return;
    var st = engine.state(), ep = st.episode;
    var mini = $('#mini');
    mini.hidden = !ep || nightOpen;
    document.body.classList.toggle('mini-on', !mini.hidden);
    if (!ep) return;
    var left = st.dur ? Math.max(0, st.dur - st.t) : 0;
    $('#miniTitle').textContent = ep.title;
    $('#miniSub').textContent = (st.timer ? (st.timer.mode === 'end' ? 'stops at the end' : SleepTimer.countdown(SleepTimer.remaining(st.timer)) + ' to sleep') : (ep.podcast || '')) + (st.dur ? ' · ' + Core.fmt(left) + ' left' : '');
    $('#miniPlay').textContent = st.playing ? '❚❚' : '▶';
    $('#miniPlay').setAttribute('aria-label', st.playing ? 'Pause' : 'Play');
    if (!nightOpen) return;
    var r = arec[ep.guid] || {}, m = aMeta[ep.guid] || {};
    var src = lib.source(r.source || m.source);
    $('#nCh').textContent = 'Sleep · ' + (ep.podcast || '') + (src && src.private ? ' · Private' : '');
    $('#nTitle').textContent = ep.title;
    $('#nEp').textContent = Core.fmt(st.t) + (st.dur ? ' / ' + Core.fmt(st.dur) : '') + (Native.inApp ? '' : ' · keep this tab open');
    var art = $('#nArt'); if (ep.image) { if (art.getAttribute('src') !== ep.image) art.src = ep.image; art.hidden = false; } else art.hidden = true;
    $('#nMsg').hidden = !st.message; $('#nMsg').textContent = st.message || '';
    $('#nLine').style.width = st.dur ? Math.min(100, st.t / st.dur * 100).toFixed(2) + '%' : '0';
    $('#nT').textContent = Core.fmt(st.t);
    $('#nLeft').textContent = st.dur ? '−' + Core.fmt(left) : '';
    $('#nPlay').textContent = st.playing ? '❚❚' : '▶';
    $('#nPlay').setAttribute('aria-label', st.playing ? 'Pause' : 'Play');
    $('#nRate').textContent = 'Speed ' + st.rate + '×';
    $('#nLock').textContent = Native.inApp ? 'Plays on the lock screen' : '';
    renderTimerUI('a');
  }
  function closeNight() { nightOpen = false; closeSheet('#nsheet'); renderAudio(); renderAll(); }

  // ---------- Play anything ----------
  function play(e) {
    if (!e) return;
    if (e.type === 'audio') {
      if (!e.url) { var r = arec[e.key]; if (r && r.url) e.url = r.url; }
      if (!e.url) { toast("This episode's audio link is missing. Open its podcast and play it from there.", 'warn'); return; }
      openAudio(e);
    } else openVideo({ id: e.key, title: e.title, author: e.srcName, channelId: lib.source(e.src) ? e.src : '', section: e.section, dur: e.dur });
  }

  // ---------- Paste ----------
  function handleText(text, from) {
    text = String(text || '').trim();
    var shelf = text.match(/#shelf=([A-Za-z0-9_-]+)/);
    if (shelf) { importShelf(shelf[1]); renderAll(); return true; }
    var found = Core.findLinks(text);
    if (found.length === 1) {
      openVideo({ id: found[0].id, t: found[0].t });
      return true;
    }
    if (found.length > 1) {
      found.forEach(function (f) { ensureVideo({ id: f.id, t: f.t }); });
      saveVideos(); toast('Added ' + found.length + ' videos. They\'re under Pasted.');
      return true;
    }
    var c = text && Feeds.parseChannelInput(text);
    if (c && c.kind !== 'name') { openAdd(text); return true; }
    toast(text ? "That doesn't look like a YouTube link. Copy the address from YouTube and try again." : 'Nothing to paste. Copy a YouTube link first.', 'warn');
    return false;
  }
  function doPaste() {
    var fallback = function () { openDlg($('#pasteDlg')); $('#pasteInput').value = ''; setTimeout(function () { $('#pasteInput').focus(); }, 50); };
    try {
      Native.readClipboard().then(function (txt) {
        if (txt && txt.trim()) return handleText(txt);
        // Universal Clipboard can take a moment to arrive from the Mac: try once more
        setTimeout(function () { Native.readClipboard().then(function (t2) { if (t2 && t2.trim()) handleText(t2); else fallback(); }, fallback); }, 1200);
      }, fallback);
    } catch (e) { fallback(); }
  }
  $('#pasteForm').addEventListener('submit', function (e) { e.preventDefault(); if (handleText($('#pasteInput').value)) $('#pasteDlg').close(); });
  document.addEventListener('paste', function (e) {
    var t = e.target, cd = e.clipboardData || window.clipboardData, txt = cd ? cd.getData('text') : '';
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
    if (txt) { e.preventDefault(); handleText(txt); }
  });

  // ---------- Add channel ----------
  var addSec = null, adding = false;
  function openAdd(prefill, sectionId) {
    var secs = lib.sections();
    addSec = sectionId && lib.section(sectionId) ? sectionId : (stack.length && stack[stack.length - 1].name === 'section' ? stack[stack.length - 1].id : secs[0].id);
    $('#addPicks').innerHTML = secs.map(function (s) { return '<button type="button" data-act="add-pick" data-id="' + esc(s.id) + '" aria-pressed="' + (s.id === addSec) + '">' + esc(s.name) + '</button>'; }).join('');
    $('#addInput').value = prefill || '';
    $('#addMsg').textContent = feedsOn ? '' : 'Adding channels works in the Shelf app on your iPhone.';
    $('#addMsg').className = 'msgline';
    openDlg($('#addDlg'));
    if (!prefill && !isPhone) setTimeout(function () { $('#addInput').focus(); }, 50);
  }
  $('#addForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (adding) return;
    var val = $('#addInput').value.trim(), msg = $('#addMsg');
    if (!val) { msg.textContent = 'Paste a channel link first.'; msg.className = 'msgline err'; return; }
    adding = true; msg.textContent = 'Looking it up…'; msg.className = 'msgline'; $('#addGo').disabled = true;
    lib.add(val, addSec).then(function (s) {
      adding = false; $('#addGo').disabled = false;
      msg.textContent = 'Added ' + s.name + ' to ' + lib.section(s.section).name + '.'; msg.className = 'msgline ok';
      lib.saveCache(); renderAll();
      setTimeout(function () { if ($('#addDlg').open) $('#addDlg').close(); }, 900);
    }, function (err) {
      adding = false; $('#addGo').disabled = false;
      msg.textContent = (err && err.message) || "Couldn't add that."; msg.className = 'msgline err';
    });
  });

  // ---------- Sections ----------
  var editing = null, secKind = 'video', confirmDel = false;
  function openSec(id) {
    editing = id || null; confirmDel = false;
    var s = id && lib.section(id);
    $('#secH').textContent = s ? 'Edit section' : 'New section';
    $('#secName').value = s ? s.name : '';
    secKind = s ? s.kind : 'video'; paintKind();
    $('#secMore').hidden = !s;
    $('#secDel').textContent = 'Delete section';
    $('#secMsg').textContent = ''; $('#secMsg').className = 'msgline';
    openDlg($('#secDlg'));
    if (!s && !isPhone) setTimeout(function () { $('#secName').focus(); }, 50);
  }
  function paintKind() { Array.prototype.forEach.call(document.querySelectorAll('#secKind button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-kind') === secKind)); }); }
  $('#secKind').addEventListener('click', function (e) { var b = e.target.closest('[data-kind]'); if (b) { secKind = b.getAttribute('data-kind'); paintKind(); } });
  $('#secForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = $('#secMsg');
    try {
      if (editing) { if (!lib.renameSection(editing, $('#secName').value)) throw new Error('Give the section a name.'); lib.setKind(editing, secKind); }
      else { var s = lib.addSection($('#secName').value, secKind); toast('Added ' + s.name + '. Tap it to add channels.'); }
      $('#secDlg').close(); renderAll();
    } catch (err) { msg.textContent = err.message; msg.className = 'msgline err'; }
  });

  // ---------- Clicks ----------
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    switch (act) {
      case 'play': case 'resume': play(regGet(b.getAttribute('data-e'))); break;
      case 'open-section': openSection(id); break;
      case 'open-channel': openChannel(id); break;
      case 'open-pasted': push({ name: 'pasted' }); break;
      case 'back': back(); break;
      case 'search': if (!stack.length || stack[stack.length - 1].name !== 'search') push({ name: 'search', q: prefs.lastQ || '' }); else { var q = $('#sq'); if (q) q.focus(); } break;
      case 'paste': doPaste(); break;
      case 'refresh': refreshAll(true); break;
      case 'refresh-channel': lib.refresh(id, true).then(function () { lib.saveCache(); renderAll(); }); toast('Checking for new uploads…'); break;
      case 'add-channel': openAdd(b.getAttribute('data-in') || '', id); break;
      case 'fix-seed': openAdd(b.getAttribute('data-in'), id); break;
      case 'add-pick': addSec = id; Array.prototype.forEach.call(document.querySelectorAll('#addPicks button'), function (x) { x.setAttribute('aria-pressed', String(x === b)); }); break;
      case 'add-paste': Native.readClipboard().then(function (t) { $('#addInput').value = (t || '').trim(); }, function () { $('#addInput').focus(); toast('Tap the box, then tap Paste.'); }); break;
      case 'add-section': openSec(null); break;
      case 'edit-section': openSec(id); break;
      case 'sec-up': case 'sec-down': lib.moveSection(editing, act === 'sec-up' ? -1 : 1); renderAll(); break;
      case 'sec-delete':
        if (!confirmDel) { confirmDel = true; var to = lib.sections().filter(function (s) { return s.id !== editing; })[0]; b.textContent = 'Tap again: channels move to ' + (to ? to.name : '?'); break; }
        try { lib.removeSection(editing); $('#secDlg').close(); if (stack.length) { stack = []; $('#page').hidden = true; } renderAll(); toast('Section deleted. Its channels moved.'); }
        catch (err) { $('#secMsg').textContent = err.message; $('#secMsg').className = 'msgline err'; }
        break;
      case 'seen-section': lib.sources(id).forEach(function (s) { lib.markSeen(s.id); }); renderAll(); break;
      case 'move-channel': lib.setSection(id, b.getAttribute('data-to')); renderAll(); break;
      case 'remove-channel':
        if (confirmRemove !== id) { confirmRemove = id; renderPage(); break; }
        var nm = lib.source(id).name; lib.remove(id); confirmRemove = null; lib.saveCache(); back(); toast('Removed ' + nm + '.'); break;
      case 'remove-video':
        var gone = videos[id]; delete videos[id]; saveVideos(); renderAll();
        toast('Removed.', '', { label: 'Undo', fn: function () { videos[id] = gone; saveVideos(); renderAll(); } });
        break;
      case 'close-video': closeVideo(); break;
      case 'v-toggle': try { if (player.getPlayerState() === 1) player.pauseVideo(); else player.playVideo(); } catch (er) {} break;
      case 'v-back': case 'v-fwd': try { player.seekTo(Math.max(0, player.getCurrentTime() + (act === 'v-back' ? -15 : 15)), true); videoTick(); } catch (er) {} break;
      case 'timer': if (held) { held = false; break; } setTimer(b.getAttribute('data-p'), b.getAttribute('data-m')); break;
      case 'open-night': nightOpen = true; openSheet('#nsheet'); renderAudio(); break;
      case 'close-night': closeNight(); break;
      case 'audio-toggle': engine.toggle(); break;
      case 'a-back': engine.seekBy(-engine.BACK); break;
      case 'a-fwd': engine.seekBy(engine.FWD); break;
      case 'a-rate': var cr = engine.state().rate, nr = RATES[(RATES.indexOf(cr) + 1) % RATES.length]; engine.setRate(nr); prefs.arate = nr; savePrefs(); break;
      case 'check': openCheck(); break;
      case 'dismiss': var d = b.closest('dialog'); if (d) d.close(); break;
      case 'settings': $('#checkDlg').close(); $('#keyInput').value = prefs.apiKey || ''; $('#keyMsg').textContent = ''; openDlg($('#keyDlg')); break;
      case 'key-remove': delete prefs.apiKey; savePrefs(); $('#keyInput').value = ''; $('#keyMsg').textContent = 'Removed. Search reads YouTube\'s results page.'; $('#keyMsg').className = 'msgline ok'; break;
      case 'send': copyShelf(b); break;
      case 'tone':
        if (Native.tonePlaying) { Native.stopTone(); b.textContent = 'Test lock-screen sound'; fillCheck(); return; }
        if (engine.state().playing) engine.pause();
        if (current) closeVideo();
        Native.playTone().then(function () { b.textContent = 'Stop the sound test'; fillCheck(); toast('Now lock your phone for 10 seconds, then come back.'); },
          function () { toast("The sound test couldn't start. Turn the volume up and try again.", 'warn'); });
        break;
    }
  });
  // Tap on a scrub line seeks
  function scrubAt(el, ev, dur, fn) { var r = el.getBoundingClientRect(); if (!dur || !r.width) return; fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * dur); }
  $('#vScrub').addEventListener('click', function (ev) { try { var d = player.getDuration(); scrubAt(this, ev, d, function (t) { player.seekTo(t, true); videoTick(); }); } catch (e) {} });
  $('#nScrub').addEventListener('click', function (ev) { var st = engine.state(); scrubAt(this, ev, st.dur, function (t) { engine.seek(t); }); });
  $('#keyForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var k = $('#keyInput').value.trim();
    if (k && !/^AIza[0-9A-Za-z_-]{20,}$/.test(k)) { $('#keyMsg').textContent = 'That doesn\'t look like a Google key. They start with "AIza".'; $('#keyMsg').className = 'msgline err'; return; }
    if (k) prefs.apiKey = k; else delete prefs.apiKey;
    savePrefs(); $('#keyDlg').close(); toast(k ? 'Saved. Search now uses your Google key.' : 'No key. Search reads YouTube\'s results page.');
  });
  // Backdrop click closes a dialog
  Array.prototype.forEach.call(document.querySelectorAll('dialog'), function (d) {
    d.addEventListener('click', function (e) {
      if (e.target !== d) return;
      var r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if ($('#vsheet').classList.contains('open')) closeVideo();
    else if (nightOpen) closeNight();
    else if (stack.length) back();
  });
  function openDlg(d) { if (d.showModal) { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); }

  // ---------- Toast ----------
  var toastTimer = null;
  function toast(msg, kind, action) {
    var t = $('#toast');
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button type="button">' + esc(action.label) + '</button>' : '');
    if (action) t.querySelector('button').onclick = function () { action.fn(); t.className = 'toast'; };
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast'; }, action ? 6000 : 4000);
  }

  // ---------- Self-check ----------
  function checks() {
    var out = [];
    out.push(/^https?:$/.test(location.protocol) ? { ok: 1, text: 'Opened from its web address' }
      : { ok: 0, text: 'You opened the file directly. YouTube only plays when Shelf is opened from its web address.' });
    out.push(canSave && !lastSaveError ? { ok: 1, text: 'Saving works' }
      : !canSave && !Native.inApp ? { ok: 0, text: 'Your browser is blocking saving, so nothing will be remembered. In Safari, go to Settings, Privacy, and turn off "Block all cookies".' }
      : lastSaveError ? { ok: 0, text: 'Saving just failed. Storage may be full; remove a few pasted videos.' } : { ok: 1, text: 'Saving works' });
    out.push(navigator.onLine === false ? { ok: 0, text: "You're offline. Videos and new uploads need the internet; your spots are safe." } : { ok: 1, text: 'Connected to the internet' });
    out.push(ytLoaded ? { ok: 1, text: 'YouTube player is ready' }
      : ytFailed ? { ok: 0, text: "Can't reach YouTube. Check your internet, or turn off any content blocker, then reopen Shelf." }
      : { ok: 2, text: 'Still loading the YouTube player…' });
    if (lastErr) out.push({ ok: 2, text: 'Last video: ' + lastErr });
    if (current) {
      var ago = lastCaptureAt && armed ? Math.round((Date.now() - lastCaptureAt) / 1000) : null, playingNow = false;
      try { playingNow = player && player.getPlayerState() === 1; } catch (e) {}
      out.push(ago == null ? { ok: 2, text: 'Your spot saves a few seconds after the video starts' }
        : playingNow && ago > 20 ? { ok: 0, text: "Your spot hasn't saved for " + ago + ' seconds. Close the video and open it again; your last spot is kept.' }
        : { ok: 1, text: 'Saved your spot ' + (ago < 3 ? 'just now' : ago + ' seconds ago') });
    }
    if (feedsOn) {
      var srcs = lib.sources(), failed = srcs.filter(function (s) { var st = lib.status(s.id); return st && !st.ok; });
      if (refreshing) out.push({ ok: 2, text: 'Checking your channels for new uploads…' });
      else if (srcs.length && failed.length === srcs.length) out.push({ ok: 0, text: "Couldn't check any of your channels. Check your internet, then tap the date's \"new\" line to try again." });
      else if (failed.length) out.push({ ok: 0, text: "Couldn't update " + failed.map(function (s) { return s.name + ' (' + lib.status(s.id).error + ')'; }).join(', ') + '. Open the channel and tap Refresh.' });
      else if (srcs.length) out.push({ ok: 1, text: 'Checked ' + srcs.length + ' channels for new uploads' + (lastRefresh ? ' ' + Core.ago(lastRefresh) : '') });
      lib.seedMisses.filter(function (m) { return !alreadyHave(m.input); }).forEach(function (m) {
        var sec = lib.section(m.section);
        out.push({ ok: 0, text: "Couldn't find " + m.input + ' automatically. Open ' + (sec ? sec.name : 'its section') + ' and tap Fix next to it.' });
      });
    } else out.push({ ok: 1, text: 'Channels and new uploads load in the Shelf app on your iPhone; here you can paste and resume' });
    out.push({ ok: 1, text: prefs.apiKey ? 'Search uses your Google key' : 'Search reads YouTube\'s results page (no key needed)' });
    if (Native.inApp) {
      out.push({ ok: 1, text: 'Running inside the Shelf app' });
      if (Native.prefError) out.push({ ok: 0, text: "The phone's storage refused a save. Close and reopen Shelf; your last saved spots are kept." });
      var fs = Native.feedStatus;
      out.push(fs.state === 'ok' ? { ok: 1, text: fs.text } : fs.state === 'bad' ? { ok: 0, text: fs.text } : { ok: 2, text: 'Checking podcast feeds…' });
      var tr = Native.toneResult;
      out.push(Native.tonePlaying ? { ok: 2, text: 'Sound test playing. Lock your phone for 10 seconds, then come back.' }
        : !tr ? { ok: 1, text: 'Lock-screen sound: optional test below (tap it, lock the phone for 10 seconds, come back)' }
        : tr.ok ? { ok: 1, text: 'Sound keeps playing on the lock screen' }
        : { ok: 0, text: 'Sound stopped when the screen locked. The app shell needs a fix and a rebuild in Xcode; tell Claude.' });
    }
    var n = Object.keys(videos).length + Object.keys(arec).length, ch = lib.sources().length;
    out.push({ ok: 1, text: ch + ' channel' + (ch === 1 ? '' : 's') + ' in ' + lib.sections().length + ' sections, ' + n + ' saved spot' + (n === 1 ? '' : 's') + ', kept ' + (Native.inApp ? 'on this phone' : 'in this browser') });
    return out;
  }
  var checkedAt = 0;
  function updateDot() {
    var c = checks(), bad = c.filter(function (x) { return x.ok === 0; }), wait = c.some(function (x) { return x.ok === 2; });
    var state = bad.length ? 'bad' : wait ? 'wait' : 'good';
    $('#statusDot').className = 'dot ' + state;
    var label = bad.length ? 'Needs a look' : wait ? 'Getting ready' : 'All good';
    $('#statusText').textContent = label;
    checkedAt = Date.now();
    var d = new Date(checkedAt);
    $('#statusSub').textContent = 'checked ' + (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    $('#statusBtn').setAttribute('aria-label', 'Self-check: ' + label + '. Show details.');
    if ($('#checkDlg').open) fillCheck();
  }
  function fillCheck() {
    $('#checkList').innerHTML = checks().map(function (x) {
      return '<li class="' + (x.ok === 1 ? 'ok' : x.ok === 2 ? 'wait' : 'bad') + '"><span class="ic" aria-hidden="true">' + (x.ok === 1 ? '✓' : x.ok === 2 ? '…' : '!') + '</span><span>' + esc(x.text) + '</span></li>';
    }).join('');
  }
  function openCheck() { updateDot(); fillCheck(); openDlg($('#checkDlg')); }

  // ---------- Shelf link (spots to another device) ----------
  function copyShelf(btn) {
    capture(true);
    var link = location.origin + location.pathname + '#shelf=' + Core.encodeShelf(videos);
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy shelf link'; }, 2000); toast(isPhone ? 'Copied. Send it to your Mac and open it in Safari.' : 'Copied. Send it to your iPhone and paste it into Shelf.'); };
    try { navigator.clipboard.writeText(link).then(done, function () { Native.call('Clipboard', 'write', { string: link }).then(done, function () { toast("Couldn't copy. Try again.", 'warn'); }); }); }
    catch (e) { toast("Couldn't copy. Try again.", 'warn'); }
  }
  function importShelf(code) {
    try {
      var r = Core.merge(videos, Core.decodeShelf(code));
      videos = r.videos; saveVideos();
      var n = r.added + r.updated;
      toast(n ? 'Got your spots: ' + r.added + ' new, ' + r.updated + ' updated.' : 'Your spots were already up to date.');
    } catch (e) { toast('That shelf link looks broken. Make a new one with Copy shelf link.', 'warn'); }
  }

  // ---------- Start ----------
  var restored = false;
  function restoreFromPhone() {
    if (!Native.inApp) return Promise.resolve();
    var keys = [KEY, PREF, AKEY, Library.KEY];
    return withTimeout(Promise.all(keys.map(Native.prefGet)), 2000, 'slow').then(function (r) {
      try {
        if (r[0]) { var local = load(KEY, {}), m = Core.merge(local, JSON.parse(r[0])); if (m.added || m.updated || !rawGet(KEY)) rawSet(KEY, JSON.stringify(m.videos), false); }
        if (r[1] && !rawGet(PREF)) rawSet(PREF, r[1], false);
        if (r[2]) { var la = load(AKEY, {}), pa = JSON.parse(r[2]); Object.keys(pa).forEach(function (g) { if (!la[g] || (pa[g].updated || 0) > (la[g].updated || 0)) la[g] = pa[g]; }); rawSet(AKEY, JSON.stringify(la), false); }
        if (r[3] && !rawGet(Library.KEY)) rawSet(Library.KEY, r[3], false);
        restored = true;
      } catch (e) {}
    }, function () {});
  }
  function boot() {
    videos = load(KEY, {}); prefs = load(PREF, {}); arec = load(AKEY, {});
    lib = Library.create({
      load: rawGet,
      save: function (k, v) { rawSet(k, v, k === Library.KEY); }, // the feed cache stays in the web view; the library itself is mirrored to the phone
      fetchText: fetchText
    });
    // Keep the phone's copy complete even before anything changes
    // Only after the phone's copy was read and merged, so a slow or empty start can't overwrite it
    if (Native.inApp && restored) { if (Object.keys(videos).length) Native.prefSet(KEY, JSON.stringify(videos)); if (rawGet(Library.KEY)) Native.prefSet(Library.KEY, rawGet(Library.KEY)); }
    buildSeg('#vSeg', 'v'); buildSeg('#nSeg', 'a');
    initAudio();
    if (Native.inApp) $('#toneBtn').hidden = false;
    $('#pasteIntro').textContent = isPhone ? 'Tap the box, then tap Paste. A YouTube video plays straight away; a channel link opens Add channel.' : 'Press ⌘V. A YouTube video plays straight away; a channel link opens Add channel.';
    if (!isPhone) $('#pasteBtn').querySelector('small').textContent = 'or press ⌘V';
    var m = location.hash.match(/^#shelf=([A-Za-z0-9_-]+)/);
    if (m) { importShelf(m[1]); try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
    renderHome(); renderAudio();
    loadYT();
    updateDot();
    setInterval(updateDot, 5000);
    setInterval(function () { if (!stack.length && document.visibilityState === 'visible') renderHome(); }, 60000);
    window.addEventListener('online', updateDot); window.addEventListener('offline', updateDot);
    if (!canSave && !Native.inApp) setTimeout(function () { toast('Your browser is blocking saving, so nothing will be remembered. Tap the self-check for how to fix it.', 'warn'); }, 600);
    refreshAll(false);
    // Test hook
    window.__shelf = { get videos() { return videos; }, get audio() { return arec; }, get lib() { return lib; }, get engine() { return engine; }, checks: checks, capture: capture,
      get current() { return current; }, get vTimer() { return vTimer; }, refreshAll: refreshAll, handleText: handleText, get stack() { return stack; }, get busy() { return refreshing || !lib.sources().length && feedsOn && !lib.seedMisses.length; } };
  }
  restoreFromPhone().then(boot);
})();
