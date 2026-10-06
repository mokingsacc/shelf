// Shelf v3 (Day Sheet): Home bands, section/channel/courses/search/marks pages, YouTube player, night player, self-check.
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
  // Nothing is written to the phone until the phone's own copy was read and merged, so a slow or failed
  // start can't replace good spots, ticks or channels with the web view's (possibly stale) copy
  var guarded = function (k) { return Native.inApp && !restored && PHONE_KEYS().indexOf(k) >= 0; };
  var PHONE_KEYS = function () { return [KEY, PREF, AKEY, Library.KEY, Courses.KEY, Marks.KEY, AI.KEY]; };
  function rawSet(k, s, mirror) {
    if (mirror !== false && !guarded(k)) Native.prefSet(k, s);
    if (!canSave) { mem[k] = s; return Native.inApp; }
    try { localStorage.setItem(k, s); lastSaveError = ''; return true; } catch (e) { lastSaveError = (e && e.name) || 'error'; return false; }
  }
  function load(k, d) { try { var v = JSON.parse(rawGet(k) || 'null'); return v && typeof v === 'object' ? v : d; } catch (e) { return d; } }
  function store(k, v) { return rawSet(k, JSON.stringify(v)); }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) {}

  var videos, prefs, arec, lib, marks, aMeta = {};
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
    lib.sources(sectionId).forEach(function (s) { itemsOf(s).forEach(function (it) { out.push(entryFromItem(s, it)); }); });
    return out.sort(function (a, b) { return b.published - a.published; });
  }
  function startedEntries(sectionId) {
    var out = [];
    Object.keys(videos).forEach(function (id) { var e = entryFromVideo(videos[id]); if (started(e) && e.section === sectionId) out.push(e); });
    Object.keys(arec).forEach(function (g) { if (arec[g].video) return; var e = entryFromAudio(g, arec[g]); if (started(e) && (sectionId === undefined || e.section === sectionId)) out.push(e); });
    return out.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
  }
  function newCountFor(sectionId) { return feedEntries(sectionId).filter(isNew).length; }
  function srcNewCount(id) { var s = lib.source(id); return s ? itemsOf(s).map(function (it) { return entryFromItem(s, it); }).filter(isNew).length : 0; }
  function thumbOf(e) { return e.type === 'video' ? 'https://i.ytimg.com/vi/' + e.key + '/mqdefault.jpg' : (e.image || ''); }
  // Shorts (and clips under 90 s) stay off the sheet when the channel says so (on unless turned off)
  function hidesShorts(s) { return !!s && s.type !== 'podcast' && s.hideShorts !== false; }
  function isShort(it) { var v = videos[it.id]; return /#shorts?\b/i.test(it.title || '') || !!(v && v.dur > 0 && v.dur < 90); }
  // A channel added twice where only one copy loads (Mo has two "The Ezra Klein Show"): the failing copy is a
  // broken duplicate. It stays off Home and the self-check, and its section page offers one tap to remove it.
  function brokenDup(s) {
    var st = s && lib.status(s.id); if (!st || st.ok) return null;
    var nm = s.name.toLowerCase();
    return lib.sources().filter(function (t) { var tt = lib.status(t.id); return t.id !== s.id && t.type === s.type && t.name.toLowerCase() === nm && (!tt || tt.ok); })[0] || null;
  }
  function itemsOf(s) { var all = lib.items(s.id); return hidesShorts(s) ? all.filter(function (it) { return !isShort(it); }) : all; }

  // Icons (inline, so nothing extra loads)
  var I = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4l14 8-14 8z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M4 12l5 5L20 6"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="6" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="18" cy="12" r="2"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>',
    mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"/></svg>'
  };

  // Day or night: after 21:30 (and until 05:00) Sleep comes first and Continue becomes Bedtime
  function hourNow() { if (typeof window.__hour === 'number') return window.__hour; var d = new Date(); return d.getHours() + d.getMinutes() / 60; }
  function dayPart() { var h = hourNow(); return h >= 21.5 || h < 5 ? 'night' : h >= 18 ? 'evening' : 'day'; }
  function isNight() { return dayPart() === 'night'; }
  // Home's order (Mo's): Entertainment, Medicine, Sleep, then any new categories; Pasted always last
  var ORDER = { ent: 0, med: 1, sleep: 2 };
  function daySections() {
    var secs = lib.sections();
    return secs.map(function (x, i) { return { s: x, r: x.id in ORDER ? ORDER[x.id] : 3 + i }; }).sort(function (a, b) { return a.r - b.r; }).map(function (x) { return x.s; });
  }
  function shortDay(t) { var d = new Date(t); return d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3); }

  // Entries on screen, looked up by the code on each button
  var reg = { h: [], p: [] };
  function regE(scope, e) { reg[scope].push(e); return scope + (reg[scope].length - 1); }
  function regGet(code) { return code ? reg[code[0]][+code.slice(1)] : null; }

  // ---------- Home ----------
  var renderTimer = null;
  function renderSoon() { clearTimeout(renderTimer); renderTimer = setTimeout(renderAll, 60); }
  function renderAll() { keepTyping(function () { renderHome(); if (stack.length) renderPage(); }); }
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
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function leftText(p) { return p && p.dur ? Core.left(p.t, p.dur).toLowerCase() : ''; }
  function bandRow(e, scope) {
    var p = prog(e), pc = p && p.dur ? Core.pct(p) : 0, go = started(e);
    return '<li><button type="button" class="row" data-act="play" data-e="' + regE(scope, e) + '"><span class="tx">' +
      '<b>' + esc(e.title) + '</b><small>' + (isNew(e) ? '<span class="nw">NEW</span>' : '') + esc(e.srcName) + (go && p.dur ? ' · ' + esc(leftText(p)) : '') + '</small>' +
      (go ? '<span class="pr"><i style="width:' + pc.toFixed(1) + '%"></i></span>' : '') +
      '</span><span class="n mono">' + esc(durText(e)) + '</span></button></li>';
  }
  // The course on the go: the one touched last that still has an episode to watch
  function upNextCourse() {
    if (!cs) return null;
    return cs.list().filter(function (c) { var pr = cs.progress(c.id); return pr.state === 'go' && pr.next; })
      .sort(function (a, b) { return (b.touched || 0) - (a.touched || 0); })[0] || null;
  }
  // Under Medicine's heading: days to the exam and the course's pace (day), or what today counted (night)
  function examSub() {
    if (!cs || !cs.list().length) return '';
    var c = upNextCourse(), pc = c && cs.pace(c.id), td = cs.today(), days = cs.daysLeft();
    if (isNight()) return '<b>Today</b> ' + td.n + (td.n === 1 ? ' episode' : ' episodes') + (td.secs ? ' · ' + Math.round(td.secs / 60) + ' min' : '') + (pc ? ' · ' + esc(c.name) + ' ' + pc.left + ' left' : '');
    if (cs.examPast()) return pc ? esc(c.name) + ' ' + pc.left + ' left' : '';
    return (days ? '<b>' + days + (days === 1 ? ' day' : ' days') + '</b> to ' + esc(goalName()) : '<b>' + esc(goalName()) + '</b> today') +
      (pc ? ' · ' + esc(c.name) + ' ' + pc.left + ' left' + (pc.perDay ? ' · ' + Courses.perDay(pc.perDay) : '') : td.left ? ' · ' + td.left + ' left' + (td.perDay ? ' · ' + Courses.perDay(td.perDay) : '') : '');
  }
  // Home's sections start folded: the name opens and closes one (remembered), the count on the right opens its page
  function isOpenBand(id) { return !!(prefs.open && prefs.open[id]); }
  function bandHead(id, cls, name, count, act, open, extra) {
    return '<section class="band ' + cls + (open ? ' open' : '') + '" aria-label="' + esc(name) + '"><div class="hd' + (extra ? ' x3' : '') + '">' +
      '<button type="button" class="tg" data-act="toggle-band" data-id="' + esc(id) + '" aria-expanded="' + open + '"><h2>' + esc(name) + '</h2><span class="car" aria-hidden="true">' + I.down + '</span></button>' + (extra || '') +
      '<button type="button" class="tm mono" data-act="' + act + '" data-id="' + esc(id) + '" aria-label="Open ' + esc(name) + ': ' + esc(count) + '">' + esc(count) + ' ›</button></div>';
  }
  function bandChannel(s) {
    var its = itemsOf(s), last = its.reduce(function (a, x) { return x.published > (a ? a.published : 0) ? x : a; }, null), n = srcNewCount(s.id), st = lib.status(s.id);
    var sub = st && !st.ok ? "Couldn't update" : last ? (n ? n + ' new · ' : '') + 'latest ' + Core.ago(last.published) + ' · ' + last.title : refreshing || !st ? 'Checking…' : 'No videos yet';
    return '<button type="button" data-act="open-channel" data-id="' + esc(s.id) + '"><span class="tx"><b>' + esc(s.name) + '</b><small>' + esc(sub) + '</small></span><span aria-hidden="true">›</span></button>';
  }
  var refreshing = false;
  function renderHome() {
    reg.h = [];
    var d = new Date(), night = isNight();
    $('#dayNum').textContent = pad2(d.getDate());
    $('#dayName').textContent = DAYS[d.getDay()] + (night ? ' night' : '');
    $('#monthName').textContent = MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    var allNew = 0, unfinished = startedEntries(undefined).length;
    Object.keys(videos).forEach(function (id) { var e = entryFromVideo(videos[id]); if (started(e)) unfinished++; });
    var html = '';
    daySections().forEach(function (sec) {
      var fresh = feedEntries(sec.id).filter(isNew), go = startedEntries(sec.id);
      allNew += fresh.length;
      // At most three: the newest uploads and the one you're in the middle of, then "+N more"
      var list = fresh.slice(0, go.length ? 2 : 3).concat(go.slice(0, 1));
      fresh.slice(list.length - Math.min(go.length, 1)).concat(go.slice(1)).forEach(function (e) { if (list.length < 3 && list.indexOf(e) < 0) list.push(e); });
      var rest = fresh.length + go.length - list.length, srcs = lib.sources(sec.id).length, open = isOpenBand(sec.id);
      html += bandHead(sec.id, bandClass(sec.id), sec.name, fresh.length ? fresh.length + ' new' : srcs ? srcs + (srcs === 1 ? ' channel' : ' channels') : 'empty', 'open-section', open);
      if (!open) { html += '</section>'; return; }
      if (list.length) html += '<ul>' + list.map(function (e) { return bandRow(e, 'h'); }).join('') + '</ul>';
      else if (!srcs && !feedsOn) html += '<p class="empty">Your channels show here in the Shelf app on your iPhone.</p>';
      else if (!srcs) html += '<p class="empty">No channels yet. <button type="button" data-act="add-channel" data-id="' + esc(sec.id) + '">Add one</button></p>';
      if (rest > 0) html += '<button type="button" class="more" data-act="open-section" data-id="' + esc(sec.id) + '"><span>+' + rest + ' more in ' + esc(sec.name) + '</span><span aria-hidden="true">›</span></button>';
      // Its channels, one line each: tap one for its videos, newest first
      if (srcs) html += '<div class="chl' + (list.length ? '' : ' first') + '">' + lib.sources(sec.id).filter(function (x) { return !brokenDup(x); }).map(bandChannel).join('') + '</div>';
      html += '</section>';
    });
    // Pasted videos that belong to no section
    var loose = Object.keys(videos).map(function (id) { return entryFromVideo(videos[id]); }).filter(function (e) { return !e.section && !isDoneE(e); })
      .sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    // Pasted always shows, with a URL button to play any YouTube link
    var urlBtn = '<button type="button" class="urlb" data-act="paste-url" aria-label="Play a YouTube link">+ URL</button>';
    if (!loose.length) html += '<section class="band c0" aria-label="Pasted"><div class="hd x3"><button type="button" class="tg" data-act="paste-url" aria-label="Pasted: nothing yet. Play a YouTube link"><h2>Pasted</h2></button>' + urlBtn + '<button type="button" class="tm mono" data-act="open-pasted" aria-label="Open Pasted: 0">0 ›</button></div></section>';
    else if (!isOpenBand('_pasted')) html += bandHead('_pasted', 'c0', 'Pasted', String(loose.length), 'open-pasted', false, urlBtn) + '</section>';
    else {
      html += bandHead('_pasted', 'c0', 'Pasted', String(loose.length), 'open-pasted', true, urlBtn) +
        '<ul>' + loose.slice(0, 3).map(function (e) { return bandRow(e, 'h'); }).join('') + '</ul>' +
        (loose.length > 3 ? '<button type="button" class="more" data-act="open-pasted"><span>+' + (loose.length - 3) + ' more pasted</span><span aria-hidden="true">›</span></button>' : '') + '</section>';
    }
    // Make a new category (it lands after Sleep, above Pasted)
    html += '<button type="button" class="addcat" data-act="add-section"><span>+ Add category</span><span aria-hidden="true">›</span></button>';
    $('#bands').innerHTML = html;
    fitAll($('#bands'));
    // Continue: the most recent unfinished thing anywhere. At night, the last podcast you fell asleep to (Bedtime).
    var all = startedEntries(undefined).concat(Object.keys(videos).map(function (id) { return entryFromVideo(videos[id]); }).filter(started))
      .sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    var top = all[0], bed = night && all.filter(function (e) { return e.type === 'audio'; })[0];
    if (bed) top = bed;
    // The podcast bar at the bottom already is "continue" for the episode it holds
    var held = engine && engine.state().episode;
    if (held && arec[held.guid] && arec[held.guid].done) held = null;
    if (held) { top = all.filter(function (e) { return !(e.type === 'audio' && e.key === held.guid); })[0]; bed = null; }
    if (held && top && top.type === 'audio') top = null;
    $('#cont').hidden = !top;
    if (top) {
      var p = prog(top);
      $('#cont').setAttribute('data-e', regE('h', top));
      $('#cont').setAttribute('data-bed', bed ? '1' : '');
      $('#contK').textContent = (bed ? 'Bedtime' : 'Continue') + (top.srcName ? ' · ' + top.srcName : '');
      $('#contTitle').textContent = top.title;
      var tm = engine && engine.state().timer, lights = tm && tm.mode === 'min' ? tm.endsAt : Date.now() + (p.dur ? Math.min(45 * 60, (p.dur - p.t)) * 1000 : 45 * 60000);
      $('#contMeta').textContent = bed ? (leftText(p) || Core.fmt(p.t)) + (tm ? ' · lights out ' + clockText(lights) : ' · 45-min timer, lights out ' + clockText(lights))
        : Core.fmt(p.t) + (p.dur ? ' · ' + leftText(p) : '');
      $('#contBar').style.width = Core.pct(p).toFixed(1) + '%';
      $('#cont').setAttribute('aria-label', (bed ? 'Bedtime: ' : 'Continue ') + top.title + ' from ' + Core.fmt(p.t));
    }
    // Up next: the next episode of the course on the go (not at night, and not when Continue already is it)
    var nc = !night && upNextCourse(), npr = nc && cs.progress(nc.id), nx = npr && npr.next;
    if (nx && top && top.key === nx.id) nx = null;
    $('#next').hidden = !nx;
    if (nx) {
      $('#next').setAttribute('data-id', nc.id); $('#next').setAttribute('data-v', nx.id);
      $('#nextK').textContent = 'Up next · ' + nc.name + ' · ' + (npr.notch + 1) + ' of ' + npr.total;
      $('#nextT').innerHTML = esc(epLabel(nx, npr.notch)) + ' · ' + esc(shortTitle(nx.title)) + (nx.dur ? ' <span class="mono">' + Core.fmt(nx.dur) + '</span>' : '');
      $('#next').setAttribute('aria-label', 'Play next in ' + nc.name + ': ' + epLabel(nx, npr.notch));
    }
    $('#summary').textContent = refreshing ? 'Checking for new uploads…' : '';
    var wn = $('#webNote');
    if (!feedsOn) { wn.hidden = false; wn.textContent = isPhone ? 'New uploads and channels load in the Shelf app. Here you can pick up where you left off, or paste a YouTube link into Search.' : 'New uploads and channels load in the Shelf app on your iPhone. On this Mac you can pick up where you left off, or press ⌘V to play a YouTube link.'; }
    else wn.hidden = true;
  }
  // "11:57 pm"
  function clockText(t) { return SleepTimer.clock(t).replace('about ', ''); }

  // ---------- Pages ----------
  var stack = [], skipPops = 0;
  function push(view) { stack.push(view); renderPage(); $('#page').scrollTop = 0; renderTabs(); try { history.pushState({ shelf: stack.length }, ''); } catch (e) {} }
  function pop() { stack.pop(); if (stack.length) renderPage(); else { $('#page').hidden = true; renderHome(); } renderTabs(); }
  window.addEventListener('popstate', function () { if (skipPops) { skipPops--; if (afterUnwind) afterUnwind(); return; } if (stack.length) pop(); });
  // Close every open page and take their history entries with them, then run "then" (a new tab's first page)
  var afterUnwind = null;
  function unwind(then) {
    var n = stack.length; stack = [];
    if (!n) { if (then) then(); return; }
    var fired = false, go = function () { if (fired) return; fired = true; if (afterUnwind === go) afterUnwind = null; if (then) then(); };
    skipPops++; afterUnwind = go;
    try { history.go(-n); } catch (e) { skipPops--; go(); return; }
    // If the browser never answers, don't leave the next Back swallowed
    setTimeout(function () { if (!fired) { skipPops = Math.max(0, skipPops - 1); go(); } }, 800);
  }
  function back() { try { history.back(); } catch (e) { pop(); } }
  // Tabs: Today is Home; Courses and Search each start a fresh page stack
  function goHome() {
    var n = stack.length;
    if (!n) { try { window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }); } catch (e) {} return; }
    unwind(); $('#page').hidden = true; renderHome(); renderTabs();
  }
  function openTab(view) {
    var v = stack[stack.length - 1];
    if (v && stack.length === 1 && v.name === view.name && v.id === view.id) { $('#page').scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }); return false; }
    unwind(function () { push(view); }); return true;
  }
  function renderTabs() {
    var v = stack[stack.length - 1], on = v && v.name === 'courses' ? 'coursesBtn' : v && v.name === 'search' ? 'searchBtn' : 'todayBtn';
    ['todayBtn', 'coursesBtn', 'searchBtn'].forEach(function (id) { var b = document.getElementById(id); if (id === on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  }
  function itemHTML(e, scope, opts) {
    opts = opts || {};
    var p = prog(e), done = isDoneE(e), pc = p && p.dur ? Core.pct(p) : 0, th = thumbOf(e), d = (p && p.dur) || e.dur;
    var meta;
    if (started(e)) meta = '<b>' + esc(Core.fmt(p.t)) + (p.dur ? ' / ' + esc(Core.fmt(p.dur)) : '') + '</b> · resume';
    else meta = [d ? '<b>' + esc(Core.fmt(d)) + '</b>' : '', e.published ? esc(agoLong(e.published)) : '', done ? 'watched' : ''].filter(Boolean).join(' · ');
    return '<button type="button" class="item' + (done ? ' watched' : '') + '" data-act="play" data-e="' + regE(scope, e) + '">' +
      '<span class="th' + (e.type === 'audio' ? ' sq' : '') + '">' + (th ? '<img src="' + esc(th) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' : '') + (d ? '<span class="len mono">' + esc(Core.fmt(d)) + '</span>' : '') + '</span>' +
      '<span class="tx"><span class="ch"><span>' + esc(e.srcName || (e.type === 'audio' ? 'Podcast' : 'YouTube')) + '</span>' + (opts.fresh || isNew(e) ? '<span class="nw">NEW</span>' : '') + '</span>' +
      '<span class="t">' + esc(e.title) + '</span>' +
      '<span class="meta mono">' + meta + '</span>' +
      (started(e) ? '<span class="pr"><i style="width:' + pc.toFixed(1) + '%"></i></span>' : '') + '</span></button>';
  }
  // A folded list: "Watched · 12", "Older · 8"
  // A folded list; it stays open or shut across re-renders of the same page
  var foldOpen = {};
  function foldKey(label) { var v = stack[stack.length - 1]; return (v ? v.name + ':' + (v.id || '') : 'home') + ':' + label; }
  function fold(label, html, n, open) {
    if (!n && !open) return '';
    var k = foldKey(label);
    if (!(k in foldOpen)) foldOpen[k] = !!open;
    var on = foldOpen[k];
    return '<details class="fold" data-k="' + esc(k) + '"' + (on ? ' open' : '') + '><summary><span>' + esc(label) + ' · ' + n + '</span>' + I.down + '</summary>' + html + '</details>';
  }
  document.addEventListener('toggle', function (e) { var d = e.target; if (d && d.classList && d.classList.contains('fold') && d.getAttribute('data-k')) foldOpen[d.getAttribute('data-k')] = d.open; }, true);
  function viewLabel(v) {
    if (!v) return 'Today';
    if (v.name === 'section') { var s = lib.section(v.id); return s ? s.name : 'Back'; }
    if (v.name === 'channel') { var c = lib.source(v.id); return c ? c.name : 'Back'; }
    return { courses: 'Courses', search: 'Search', marks: 'Marks', pasted: 'Pasted' }[v.name] || 'Back';
  }
  function ib(act, id, icon, label, on) { return '<button type="button" class="ib' + (on ? ' on' : '') + '" data-act="' + act + '"' + (id != null ? ' data-id="' + esc(id) + '"' : '') + ' aria-label="' + esc(label) + '">' + icon + '</button>'; }
  function topHTML(cls, title, meta, icons, extra) {
    return '<div class="top band ' + cls + '"><div class="eyebrow"><button type="button" class="back" data-act="back">' + I.back + '<span>' + esc(viewLabel(stack[stack.length - 2])) + '</span></button>' +
      (icons ? '<span class="iconrow">' + icons + '</span>' : '') + '</div>' + h1(title) + (meta ? '<div class="meta mono">' + meta + '</div>' : '') + (extra || '') + '</div>';
  }
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
    Array.prototype.forEach.call(scope.querySelectorAll('.band .hd h2'), function (h) { fit(h, innerWidth >= 900 ? 38 : 30, 22); });
    Array.prototype.forEach.call(scope.querySelectorAll('.top h1.fit'), function (h) { fit(h, 38, 24); });
  }
  window.addEventListener('resize', function () { fitAll(document); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fitAll(document); });
  var chanNew = {}, confirmRemove = null; // keys that were new when the channel page opened
  // Unwatched first (the ones you're in the middle of on top), then the rest folded: at most 8 showing
  function listHTML(items, scope, opts, label) {
    var todo = items.filter(function (e) { return !isDoneE(e); }), done = items.filter(isDoneE), h = '';
    var shown = todo.slice(0, 8), older = todo.slice(8);
    h += '<h2 class="subh"><span>' + label + '</span><span class="mono">' + todo.length + '</span></h2>';
    h += shown.map(function (e) { return itemHTML(e, scope, opts && opts(e)); }).join('');
    h += fold('Older', older.map(function (e) { return itemHTML(e, scope, opts && opts(e)); }).join(''), older.length);
    h += fold('Watched', done.slice(0, 30).map(function (e) { return itemHTML(e, scope); }).join(''), done.length);
    return h;
  }
  function renderPage() {
    var v = stack[stack.length - 1], pg = $('#page'), html = '';
    if (!v) return;
    reg.p = [];
    pg.hidden = false;
    if (v.name === 'section') {
      var sec = lib.section(v.id);
      if (!sec) { stack.pop(); return renderPage(); }
      var srcs = lib.sources(sec.id), nn = newCountFor(sec.id), med = sec.id === Courses.SEED.section && cs && cs.list().length;
      html += topHTML(bandClass(sec.id), sec.name, '<b>' + srcs.length + (srcs.length === 1 ? ' channel' : ' channels') + '</b>' + (nn ? ' · ' + nn + ' new' : ''),
        ib('add-channel', sec.id, I.plus, 'Add channel') + (nn ? ib('seen-section', sec.id, I.check, 'Mark all seen') : '') + (med ? ib('open-marks', null, I.mark, 'Marks') : '') + ib('edit-section', sec.id, I.dots, 'Edit section'));
      var misses = lib.seedMisses.filter(function (m) { return m.section === sec.id && !alreadyHave(m.input); });
      if (!feedsOn) html += '<p class="pnote">Channels load in the Shelf app on your iPhone.</p>';
      var items = feedEntries(sec.id);
      var have = {}; items.forEach(function (e) { have[e.key] = 1; });
      startedEntries(sec.id).forEach(function (e) { if (!have[e.key]) items.unshift(e); });
      items.sort(function (a, b) { return (started(b) - started(a)) || (started(a) ? (b.updated || 0) - (a.updated || 0) : 0); });
      if (srcs.length && !items.length) html += '<p class="pnote">' + (refreshing ? 'Checking for new uploads…' : 'Nothing here yet. Open a channel below to see its videos.') + '</p>';
      else if (items.length) html += listHTML(items, 'p', null, 'Latest');
      // Channels sit folded under the videos (open straight away when there are no videos yet)
      var ch = '';
      if (!srcs.length) ch += '<p class="pnote">No channels here yet. <button type="button" data-act="add-channel" data-id="' + esc(sec.id) + '">Add one</button></p>';
      srcs.forEach(function (s) {
        var st = lib.status(s.id), n = srcNewCount(s.id), hid = hidesShorts(s) ? lib.items(s.id).filter(isShort).length : 0;
        var sub = st && !st.ok ? '<span class="err">Couldn\'t update: ' + esc(st.error) + '</span>' : (n ? n + ' new' : st ? 'Updated ' + esc(Core.ago(st.fetched)) : 'Not checked yet') + (hid ? ' · ' + hid + ' Shorts hidden' : '');
        ch += '<button type="button" class="chrow" data-act="open-channel" data-id="' + esc(s.id) + '"><span class="av">' + esc(s.name.charAt(0)) + (s.image ? '<img src="' + esc(s.image) + '" alt="" loading="lazy" onerror="this.remove()">' : '') + '</span>' +
          '<span class="tx"><b>' + esc(s.name) + '</b><small>' + (s.type === 'podcast' ? (s.private ? 'Private podcast · ' : 'Podcast · ') : '') + sub + '</small></span><span class="chev">' + I.chev + '</span></button>';
        if (brokenDup(s)) ch += '<button type="button" class="more quiet" data-act="remove-dup" data-id="' + esc(s.id) + '"><span>' + esc(s.name) + ' is in here twice and this copy doesn\'t load</span><span class="mono">' + (confirmRemove === s.id ? 'Tap again' : 'Remove it') + '</span></button>';
      });
      // A channel Shelf couldn't find on its own is one quiet line with a way to add it
      misses.forEach(function (m) { ch += '<button type="button" class="more quiet" data-act="fix-seed" data-in="' + esc(m.input) + '" data-id="' + esc(sec.id) + '"><span>' + esc(m.input.replace(/^@/, '')) + ' · not found</span><span class="mono">+ Add it</span></button>'; });
      ch += '<button type="button" class="more" data-act="add-channel" data-id="' + esc(sec.id) + '"><span>+ Add channel</span><span class="mono">a link, @handle or name</span></button>';
      html += fold('Channels', ch, srcs.length, !items.length);
    } else if (v.name === 'channel') {
      var s = lib.source(v.id);
      if (!s) { stack.pop(); return renderPage(); }
      var st2 = lib.status(s.id), list = itemsOf(s).map(function (it) { return entryFromItem(s, it); }).sort(function (a, b) { return (b.published || 0) - (a.published || 0); }); // newest first
      var kind = s.type === 'podcast' ? (s.private ? 'Private podcast' : 'Podcast') : 'YouTube';
      html += topHTML(bandClass(s.section), s.name, st2 && !st2.ok ? '<span class="err">Couldn\'t update: ' + esc(st2.error) + '</span>' : '<b>' + kind + '</b> · latest ' + list.length + (st2 ? ' · updated ' + esc(Core.ago(st2.fetched)) : ''),
        ib('refresh-channel', s.id, I.refresh, 'Check for new uploads') + ib('channel-menu', s.id, I.dots, 'Section, Shorts or remove'));
      if (!list.length) html += '<p class="pnote">' + (st2 && !st2.ok ? 'Nothing loaded. Tap ↻ to try again.' : 'Loading…') + '</p>';
      else html += listHTML(list, 'p', function (e) { return { fresh: chanNew[e.key] }; }, s.type === 'podcast' ? 'Episodes' : 'Videos');
      if (s.type === 'youtube') html += '<p class="pnote">YouTube lists only the latest 15 uploads here. For older ones, use Search.</p>';
    } else if (v.name === 'pasted') {
      var vids = Object.keys(videos).map(function (id) { return entryFromVideo(videos[id]); }).filter(function (e) { return !e.section; })
        .sort(function (a, b) { return (isDoneE(a) - isDoneE(b)) || (b.updated || 0) - (a.updated || 0); });
      html += topHTML('c0', 'Pasted', vids.length + (vids.length === 1 ? ' video' : ' videos') + ' from channels you don\'t follow', ib('paste-url', null, I.plus, 'Play a YouTube link'));
      if (!vids.length) html += '<p class="pnote">Nothing pasted yet. Tap + to play a YouTube link.</p>';
      vids.forEach(function (e) { html += '<div class="irow">' + itemHTML(e, 'p') + ib('remove-video', e.key, I.x, 'Remove ' + e.title) + '</div>'; });
    } else if (v.name === 'courses') {
      html += coursesPage(v);
    } else if (v.name === 'search') {
      html += topHTML('c2', 'Search', '', '', '<form class="sform" id="sform"><input id="sq" type="search" enterkeyhint="search" autocomplete="off" placeholder="hyperkalemia, or paste a link" value="' + esc(v.q || '') + '" aria-label="Search YouTube, or paste a link"><button type="submit">Go</button></form>');
      if (v.msg) html += '<p class="pnote' + (v.err ? ' err' : '') + '">' + esc(v.msg) + '</p>';
      (v.results || []).forEach(function (r) {
        if (r.kind === 'channel') {
          var have2 = !!lib.source(r.id);
          html += '<div class="item"><span class="th sq">' + (r.thumb ? '<img src="' + esc(r.thumb) + '" alt="" loading="lazy" onerror="this.remove()">' : '') + '</span><span class="tx"><span class="ch"><span>Channel</span></span><span class="t">' + esc(r.title) + '</span>' +
            (have2 ? '<span class="meta">Already on your shelf</span>' : '<button type="button" class="btn addch" data-act="add-channel" data-in="' + esc(r.id) + '">+ Add channel</button>') + '</span></div>';
        } else {
          var e = { type: 'video', key: r.id, title: r.title, src: r.channelId, srcName: r.channel, published: r.published || 0, dur: r.dur || 0, thumb: r.thumb, section: lib.source(r.channelId) ? lib.source(r.channelId).section : null };
          html += itemHTML(e, 'p');
        }
      });
    } else if (v.name === 'marks') {
      html += marksPage();
    }
    pg.className = 'page';
    pg.innerHTML = html;
    fitAll(pg);
    if (v.name === 'search') {
      var f = $('#sform');
      f.addEventListener('submit', function (ev) { ev.preventDefault(); var q = $('#sq').value.trim(); if (isLinkish(q)) { prefs.lastQ = ''; handleText(q); } else runSearch(q); });
      if (!v.results && !v.msg && !v.focused) { v.focused = true; setTimeout(function () { var q = $('#sq'); if (q) q.focus(); }, 50); }
    }
  }
  // A pasted link in Search plays (or adds) instead of searching
  function isLinkish(q) {
    if (!q) return false;
    if (/#shelf=/.test(q) || Courses.playlistId(q)) return true;
    // "hypokalemia" is 11 letters like a video id: only a real link counts
    if (/youtu\.?be|youtube\.com|^https?:\/\//i.test(q) && Core.findLinks(q).length) return true;
    var c = Feeds.parseChannelInput(q);
    return !!c && (c.kind === 'id' || c.kind === 'handle' || c.kind === 'page' || (c.kind === 'feed' && /^https?:\/\//i.test(q)));
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
    return first.then(function () { return Promise.all([lib.refreshAll(force, function () { renderSoon(); }), syncCourses(force)]); })
      .then(function () { refreshing = false; lib.saveCache(); lastRefresh = Date.now(); renderAll(); updateDot(); autoSummaries(); }, function () { refreshing = false; renderAll(); });
  }
  var lastRefresh = 0;

  // ---------- Video player ----------
  var player = null, playerReady = false, ytLoaded = false, ytFailed = false, current = null, pending = null, tick = null, lastErr = '';
  var wantRate = 1, loadAt = 0, nextTimer = null, scrubbing = null, startOnce = null, keepSpot = null;
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
        onPlaybackRateChange: function (e) {
          // A change made in YouTube's own menu sticks to the channel too. Resets don't: YouTube's own while loading,
          // an ad's (its length isn't the video's), and any drop back to 1× (pick 1× with Shelf's buttons instead)
          if (!current || !sawPlaying || Date.now() - loadAt < 2500 || e.data === wantRate || !(e.data > 1)) return;
          var vv = videos[current], pd = 0; try { pd = player.getDuration(); } catch (er) {}
          if (vv && vv.dur && pd && Math.abs(pd - vv.dur) > 2) return;
          setRateFor(current, e.data);
        },
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
  // The players are modal: while one is open the page behind it is inert (no focus, no taps, hidden from VoiceOver),
  // and closing hands focus back to whatever opened it
  var sheetOpener = {};
  function behindSheets(on) { ['#home', '#page', '#mini', 'nav.tabs', '#vsheet', '#nsheet'].forEach(function (q) { var e = $(q); if (e && !e.classList.contains('open')) e.inert = on; }); }
  function openSheet(id) {
    var el = $(id), a = document.activeElement;
    if (!el.classList.contains('open')) sheetOpener[id] = a && a !== document.body && !el.contains(a) ? a : null;
    el.classList.add('open'); el.setAttribute('aria-hidden', 'false'); el.inert = false; el.style.transform = '';
    behindSheets(true); document.body.classList.add('sheet-on'); statusBar();
    var b = el.querySelector('[data-act^="close"]'); if (b) setTimeout(function () { try { b.focus({ preventScroll: true }); } catch (e) {} }, 300);
  }
  function closeSheet(id) {
    var el = $(id), wasOpen = el.classList.contains('open');
    el.classList.remove('open'); el.setAttribute('aria-hidden', 'true');
    var still = document.querySelector('.sheet.open');
    behindSheets(false); if (still) behindSheets(true);
    document.body.classList.toggle('sheet-on', !!still); statusBar();
    el.inert = !!still; el.style.transform = '';
    if (!wasOpen) return;
    var o = sheetOpener[id]; sheetOpener[id] = null;
    if (el.contains(document.activeElement) || document.activeElement === document.body) {
      try { if (o && o.isConnected && !o.closest('[hidden],[inert]') && o.getClientRects().length) o.focus({ preventScroll: true }); else if (document.activeElement && el.contains(document.activeElement)) document.activeElement.blur(); } catch (e) {}
    }
  }
  function openVideo(o) {
    if (engine && engine.state().playing) engine.pause();
    var v = ensureVideo(o);
    if (current && current !== v.id) capture(true);
    lastErr = ''; $('#perr').hidden = true;
    v.updated = Date.now(); saveVideos();
    $('#vTitle').textContent = v.title || 'YouTube video';
    $('#vCh').textContent = courseTag(v.id) || v.author || '';
    $('#vNext').hidden = true; clearTimeout(nextTimer); renderPlayerCourse(v.id); renderNextBtn(v.id);
    renderListen(v);
    $('#ytLink').href = ytLink(v);
    wantRate = rateFor(v); renderRateUI(v); renderMarkBtn(Core.resumeAt(v));
    openSheet('#vsheet');
    clearInterval(uiTick); uiTick = setInterval(videoTick, 1000);
    vTmOpen = false; renderTimerUI('v');
    aiSumOpen = false; current = v.id; renderAiUI();
    if (ytFailed && !playerReady) {
      current = null;
      showError("Can't reach YouTube. Check your internet, or turn off any content blocker, then reopen Shelf.", v);
      return;
    }
    current = v.id; armed = false; sawPlaying = false; startOnce = o.start > 0 ? { id: v.id, t: o.start } : null; keepSpot = startOnce && v.t > o.start ? { id: v.id, t: v.t } : null;
    if (!playerReady) { pending = v.id; return; }
    loadVideo(v.id);
  }
  function loadVideo(id) {
    var v = videos[id]; if (!v) return;
    var start = startOnce && startOnce.id === id ? startOnce.t : Core.resumeAt(v); startOnce = null;
    if (v.done) { v.done = false; v.t = 0; saveVideos(); }
    loadStart = start;
    loadAt = Date.now();
    player.loadVideoById({ videoId: id, startSeconds: start });
    if (wantRate !== 1) { try { player.setPlaybackRate(wantRate); } catch (e) {} }
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
      if (vd) { if (vd.title && !v.title) { v.title = vd.title; $('#vTitle').textContent = v.title; } if (vd.author && !v.author) { v.author = vd.author; if (current === v.id) renderListen(v); } }
    } catch (e) { return; }
    if (typeof t !== 'number' || isNaN(t)) return;
    if (!armed) {
      if (!sawPlaying || t < loadStart - 3 || t > loadStart + 60) return;
      armed = true;
    }
    if (v.dur > 0 && d > 0 && d < v.dur * 0.9) return; // an ad or another video reporting
    if (d > 0) v.dur = d;
    if (t < 1 && v.t > 5) return; // the 0 reported while loading
    // Playing from a Mark: the saved spot further on stays until you watch past it
    if (keepSpot && keepSpot.id === current) { if (t < keepSpot.t && !v.done) return; keepSpot = null; }
    v.t = t; v.updated = Date.now(); lastCaptureAt = Date.now();
    saveVideos();
  }
  function onState(e) {
    var S = YT.PlayerState;
    var playing = e.data === S.PLAYING;
    $('#vPlay').innerHTML = playing ? I.pause : I.play;
    $('#vPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('#vPlay').classList.toggle('on', playing);
    if (playing) {
      sawPlaying = true; clearTimeout(startTimer);
      if (seekOnPlay) { var sp = seekOnPlay; seekOnPlay = null; try { if (sp.id === current && Math.abs(player.getCurrentTime() - sp.t) > 30) player.seekTo(sp.t, true); } catch (er) {} }
      clearInterval(tick); tick = setInterval(capture, 5000);
      if (player.getPlaybackRate && player.getPlaybackRate() !== wantRate) { try { player.setPlaybackRate(wantRate); } catch (er) {} }
      capture(); keepAwake(true);
      var v = videos[current], tag = v && courseTag(v.id); if (v) $('#vCh').textContent = (tag || v.author || '') + (tag || v.author ? ' · ' : '') + (wake || Native.device ? 'screen stays on' : 'saving your spot');
    } else {
      clearInterval(tick); keepAwake(false);
      if (e.data === S.ENDED && current && videos[current] && armed) {
        var w = videos[current]; w.t = w.dur || w.t; w.done = true; w.updated = Date.now();
        var endTimer = vTimer && vTimer.mode === 'end', inCourse = courseOf(w.id);
        if (endTimer) vTimer = null;
        saveVideos();
        if (inCourse) cs.tick(inCourse.course.id, w.id, true);
        // In a course: offer the next episode instead of closing (unless the sleep timer said "end")
        if (inCourse && !endTimer) { showNextUp(inCourse); renderAll(); }
        else { closeVideo(true); toast(inCourse ? 'Finished and ticked. Sleep well.' : 'Finished. It stays in its channel, marked as watched.'); }
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
    // Closed in the last few seconds (end screen): it counts as watched, and ticks its course
    var cv = current && videos[current];
    if (cv && !cv.done && Core.isDone(cv.t, cv.dur)) { var cw = courseOf(cv.id); if (cw) { cv.done = true; cv.t = cv.dur; saveVideos(); cs.tick(cw.course.id, cv.id, true); } }
    try { player && player.pauseVideo(); } catch (e) {}
    clearInterval(tick); clearInterval(uiTick); clearTimeout(startTimer); clearTimeout(nextTimer); keepAwake(false); sleepDim(false);
    current = null; vTimer = null; vTimerMsg = ''; lastErr = '';
    closeSheet('#vsheet');
    renderAll();
  }
  // ---------- Listen: the same show as a podcast, which keeps playing with the phone locked ----------
  // Only for channels that publish their videos as a podcast too (matched by name, then episode title and date).
  var twins = {};
  function twinSource(v) {
    var s = v.channelId && lib.source(v.channelId);
    if (!s && v.author) s = lib.sources().filter(function (x) { return x.type === 'youtube' && x.name.toLowerCase() === v.author.toLowerCase(); })[0];
    return s && s.type === 'youtube' ? s : null;
  }
  // A clip of a longer show (or a different cut) isn't its twin: lengths must be close (podcasts add a few minutes of ads)
  function twinFits(v, ep) { var d = v.dur || 0; return !!ep && (!d || !ep.duration || Math.abs(d - ep.duration) <= Math.max(600, 0.25 * d)); }
  // Listen shows on every YouTube video in the app; the podcast is looked up as the video opens, so a tap is usually instant
  function twinWho(v) { var s = twinSource(v); return s ? s.id : (v.author || ''); }
  function twinLook(v) {
    var tw = twins[v.id], who = twinWho(v);
    if (tw && (tw.busy || tw.r && !tw.r.offline && (tw.r.ep || Date.now() - tw.at < 10 * 60000))) return tw; // misses are asked again after 10 minutes, failures at once
    var it = (twinSource(v) && lib.items(twinSource(v).id).filter(function (x) { return x.id === v.id; })[0]) || null;
    var title = v.title || (it && it.title);
    if (!who || !title) return null;
    tw = twins[v.id] = { busy: true, at: Date.now(), r: null, published: it ? it.published : 0 };
    lib.twinLookup(who, { title: title, published: tw.published }).then(function (r) { tw.r = r; }, function () { tw.r = { offline: true }; })
      .then(function () { var w = tw.waiting; tw.busy = false; tw.waiting = false; tw.at = Date.now(); if (current === v.id) { listenLabel(v); if (w) offerTwin(v, tw.r); } });
    return tw;
  }
  function listenLabel(v) { var tw = v && twins[v.id]; $('#vListen').querySelector('span').textContent = tw && tw.waiting ? 'Finding podcast…' : 'Listen'; }
  function renderListen(v) {
    var on = Native.inApp && !!twinWho(v);
    $('#vListen').hidden = !on; layoutTwin();
    if (on) twinLook(v);
    listenLabel(v);
  }
  // Two buttons a row; an odd last one takes the whole row
  function layoutTwin() {
    var vis = Array.prototype.filter.call($('#vTwin').children, function (b) { b.style.gridColumn = ''; return !b.hidden; });
    if (vis.length > 1 && vis.length % 2) vis[vis.length - 1].style.gridColumn = '1 / -1';
  }
  function listen() {
    var v = current && videos[current];
    if (!v) return;
    var tw = twinLook(v);
    if (!tw) { toast("Shelf doesn't know this video's channel, so it can't look for its podcast.", 'warn'); return; }
    if (tw.busy) { tw.waiting = true; listenLabel(v); return; }
    // Sure of the episode: play now, inside the tap (iOS only starts audio from a tap)
    if (tw.r && tw.r.ep && twinFits(v, tw.r.ep)) { playTwin(v, tw.r.ep, true); return; }
    offerTwin(v, tw.r);
  }
  function offerTwin(v, r) {
    if (!r || r.offline) { toast("Couldn't reach the podcast directory. Check your internet and tap Listen again.", 'warn'); return; }
    if (r.none) { toast("This channel doesn't put its videos out as a podcast. Play locked opens it in YouTube instead.", '', { label: 'Play locked', fn: function () { $('#ytLink').click(); } }, 8000); return; }
    var fit = r.ep && twinFits(v, r.ep), list = (r.ep ? [r.ep] : []).concat(r.items || []);
    twinPick = { vid: v.id, list: list };
    var h = '<p>' + (fit ? 'This looks like the same episode:' : r.ep ? 'Closest episode (a different length, so it may be a longer cut):' : "Shelf isn't sure which episode this is. Pick it:") + '</p><div class="tw-list">';
    list.forEach(function (ep, i) {
      h += '<button type="button" class="tw-ep' + (i === 0 && r.ep ? ' best' : '') + '" data-act="twin-pick" data-i="' + i + '"><b>' + esc(ep.title) + '</b><small class="mono">' +
        esc([ep.published ? Core.ago(ep.published) : '', ep.duration ? Core.fmt(ep.duration) : ''].filter(Boolean).join(' · ')) + '</small></button>';
    });
    h += '</div><p class="cnote">' + esc(r.podcast) + ' · plays with the phone locked, with the sleep timer.</p>';
    $('#twinBody').innerHTML = h; openDlg($('#twinDlg'));
  }
  var twinPick = null;
  function pickTwin(i) {
    var v = twinPick && videos[twinPick.vid], ep = twinPick && twinPick.list[i];
    $('#twinDlg').close();
    if (v && ep) playTwin(v, ep, twinFits(v, ep));
  }
  // linked: the same show as the video, so it starts at the video's spot and moves the video's place as it plays.
  // Otherwise (a longer cut) it starts where that episode was left, and the video's place is left alone.
  function playTwin(v, ep, linked) {
    if (current === v.id) capture(true);
    var t = v.t || 0;
    try { var pt = player.getCurrentTime(); if (current === v.id && armed && pt > 0) t = pt; } catch (e) {}
    if (ep.duration && t > ep.duration - 30) t = Math.max(0, ep.duration - 60); // a shorter cut: start near its end, not past it
    var old = arec[ep.guid] || {};
    arec[ep.guid] = Object.assign({}, old, { url: ep.url, title: ep.title, podcast: ep.podcast, image: ep.image || '', dur: ep.duration || old.dur || 0, updated: Date.now() },
      linked ? { video: v.id, t: t, done: false } : { video: '' });
    saveAudio();
    if (current) closeVideo(true);
    openAudio({ key: ep.guid, url: ep.url, title: ep.title, srcName: ep.podcast, image: ep.image, dur: ep.duration, src: '' });
    setTimeout(function () {
      var tm = engine.state().timer;
      toast((linked ? 'Podcast version from ' + Core.fmt(t) + '. You can lock the phone. The two can be a minute apart, so nudge it if needed.' : 'Playing the podcast episode. Your place in the video stays as it was.') + (tm ? ' 45-minute sleep timer on.' : ''));
    }, 450);
  }
  // Listening moves the video's place along with it, never to the very end (so it is never ticked by the audio;
  // a podcast cut differently could otherwise finish a video that isn't finished)
  function syncTwin(r) {
    var v = r && r.video && videos[r.video];
    if (!v || v.done || r.done || !(r.t > 0)) return;
    var t = v.dur > 0 ? Math.min(r.t, v.dur - 30) : r.t;
    if (t <= (v.t || 0) + 1) return; // forward only: an older listen replayed later never rewinds the video
    v.t = t; v.updated = Date.now(); saveVideos();
  }
  function keepAwake(on) {
    Native.keepAwake(on); // the sure way, in shells from 6 Oct 2026; the web wake lock below for older ones
    try {
      if (on && !wake && navigator.wakeLock) navigator.wakeLock.request('screen').then(function (w) { wake = w; w.addEventListener('release', function () { wake = null; }); }, function () {});
      else if (!on && wake) { wake.release(); wake = null; }
    } catch (e) {}
  }
  function videoTick() {
    if (!player || !current || !playerReady) return;
    var t = 0, d = 0, st = -1;
    try { t = player.getCurrentTime() || 0; d = player.getDuration() || 0; st = player.getPlayerState(); } catch (e) {}
    if (!scrubbing) paintScrub('v', t, d, wantRate);
    renderMarkBtn(t);
    sleepDim(!!vTimer && st === 1);
    if (vTimer && SleepTimer.tick(vTimer, Date.now(), false) === 'stop') {
      vTimer = null; capture(true); sleepDim(false);
      try { player.pauseVideo(); } catch (e) {}
      vTimerMsg = 'Paused by the sleep timer. Sleep well.';
      renderTimerUI('v');
      return;
    }
    renderTimerUI('v');
  }
  // Sleep dim (shells from 6 Oct 2026): while a video plays with its sleep timer on, the screen drops to its lowest
  // after a minute untouched. A touch brings it back; the timer ending, a pause or closing the player undims it,
  // and the shell itself gives the brightness back whenever Shelf goes to the background.
  var dimmed = false, touchedAt = Date.now();
  function sleepDim(running) {
    var want = Native.device && running && Date.now() - touchedAt > 60000;
    if (want !== dimmed) { dimmed = want; Native.dim(want); }
  }
  ['pointerdown', 'keydown'].forEach(function (t) { document.addEventListener(t, function () { touchedAt = Date.now(); if (dimmed) { dimmed = false; Native.dim(false); } }, true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      dimmed = false;
      clearTimeout(appFallback); // the YouTube app opened
      var handing = false;
      try { var h = JSON.parse(rawGet(HAND_KEY) || 'null'); if (h && !h.armed && Date.now() - h.at < 5000) { h.armed = true; h.at = Date.now(); rawSet(HAND_KEY, JSON.stringify(h), false); handing = true; } } catch (e) {}
      var wasPlaying = false; try { wasPlaying = !!current && player.getPlayerState() === YT.PlayerState.PLAYING; } catch (e) {}
      capture(true);
      if (engine) engine.capture(true);
      // YouTube doesn't allow its videos to keep playing in the background, so pause when Shelf is hidden
      if ((Native.inApp || isPhone) && current) { try { player.pauseVideo(); } catch (e) {} }
      lockPaused = wasPlaying && !handing && (Native.inApp || isPhone) ? current : null;
    } else {
      if (Date.now() - lastRefresh > 30 * 60000) refreshAll(false);
      applyLook();
      renderAll();
      catchUp();
      // Locked while playing in Shelf: say how to keep it going next time
      if (lockPaused && lockPaused === current) toast('YouTube stops videos inside other apps when the phone locks. Play locked opens it in the YouTube app, where Premium keeps playing.', '', { label: 'Play locked', fn: function () { $('#ytLink').click(); } }, 10000);
      lockPaused = null;
    }
  });
  window.addEventListener('pagehide', function () { capture(true); if (engine) engine.capture(true); });

  // Back from the YouTube app: move the place on by the time away (at this video's speed), never past the end.
  // An Undo puts it back, and the scrub bar fine-tunes it.
  var HAND_KEY = 'shelf.handoff', HAND_LAG = 22, seekOnPlay = null, lockPaused = null;
  function catchUp() {
    var h = null; try { h = JSON.parse(rawGet(HAND_KEY) || 'null'); } catch (e) {}
    if (!h) return;
    rawSet(HAND_KEY, 'null', false);
    var v = videos[h.id], away = (Date.now() - h.at) / 1000;
    // Only when Shelf really went to YouTube (armed as it left), not after a night away or a cancelled tap
    if (!h.armed || !v || v.done || away < 15 || away > 8 * 3600 || Math.abs((v.t || 0) - h.t) > 30) return;
    // Opening YouTube and getting it playing takes a little while, so land 22 s earlier (a second or two
    // repeated beats a gap)
    var to = h.t + away * (h.rate || 1) - HAND_LAG;
    if (v.dur > 0) to = Math.min(to, Math.max(h.t, v.dur - 30)); // short of the end, so it isn't counted as watched
    if (to - h.t < 5) return;
    function put(t) {
      v.t = t; v.updated = Date.now(); saveVideos();
      if (current === v.id && playerReady) { try { player.seekTo(t, true); keepSpot = null; } catch (e) {} videoTick(); }
      seekOnPlay = { id: v.id, t: t };
      renderAll();
    }
    put(to);
    toast('Moved your place to ' + Core.fmt(to) + ' for the time you were in YouTube' + ((h.rate || 1) !== 1 ? ' at ' + rateTxt(h.rate) : '') + '.', '', { label: 'Undo', fn: function () { put(h.t); toast('Back at ' + Core.fmt(h.t) + '.'); } }, 20000);
    // Once: the phone can lock itself after Play locked
    if (prefs.autoLock == null && !prefs.lockOffered) { prefs.lockOffered = true; savePrefs(); setTimeout(function () { toast('Want the phone to lock by itself after Play locked?', '', { label: 'Set up', fn: openLockDlg }, 10000); }, 21000); }
  }

  // ---------- Auto-lock after Play locked (an iPhone Shortcut, made once) ----------
  var LOCK_SHORTCUT = 'Shelf Play Locked';
  function openLockDlg() { renderLockDlg(); openDlg($('#lockDlg')); }
  function renderLockDlg() {
    var on = !!prefs.autoLock, b = $('#lockToggle');
    b.textContent = on ? 'Auto-lock is on' : 'Turn on auto-lock';
    b.className = on ? 'ghost' : 'primary';
    $('#lockMsg').textContent = on ? 'Play locked now opens YouTube and locks the phone 3 seconds later. Tap again to turn it off.' : '';
  }

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
    $(sel).innerHTML = SEGS.map(function (m) { return '<button type="button" data-act="timer" data-p="' + which + '" data-m="' + m + '" aria-pressed="false"' + (m === 'end' ? ' aria-label="Stop at the end"' : ' aria-label="' + m + ' minutes"') + '>' + (m === 'end' ? 'End' : m) + '</button>'; }).join('');
  }
  function buildRates() {
    $('#vRate').innerHTML = VRATES.map(function (r) { return '<button type="button" data-act="v-rate" data-r="' + r + '" aria-pressed="false" aria-label="Speed ' + r + '"> ' + (r === 1 || r === 2 ? r + '×' : r) + '</button>'; }).join('');
  }
  function timerFor(which) { return which === 'v' ? vTimer : engine.state().timer; }
  function setTimer(which, m) {
    var cur = timerFor(which), same = cur && (cur.mode === 'end' ? m === 'end' : cur.minutes === +m);
    var val = same ? null : m === 'end' ? 'end' : +m;
    if (which === 'v') { vTimer = val == null ? null : SleepTimer.start(val); vTimerMsg = ''; vTmOpen = true; }
    else engine.setTimer(val);
    renderTimerUI(which);
    if (which === 'a') renderAudio();
  }
  var vTmOpen = false;
  function renderTimerUI(which, msg) {
    var t = timerFor(which), now = Date.now();
    Array.prototype.forEach.call(document.querySelectorAll((which === 'v' ? '#vSeg' : '#nSeg') + ' button'), function (b) {
      var m = b.getAttribute('data-m');
      b.setAttribute('aria-pressed', String(!!t && (t.mode === 'end' ? m === 'end' : String(t.minutes) === m)));
    });
    if (which === 'v') {
      // The numbers stay folded until you open them, or while a timer runs
      var lab = $('#vStops'), show = !!t || vTmOpen;
      $('#vSeg').hidden = !show; $('#vTmBtn').setAttribute('aria-expanded', String(show));
      if (!t) lab.textContent = msg || vTimerMsg || 'Off';
      else lab.innerHTML = t.mode === 'end' ? 'stops when it ends' : '<b>' + SleepTimer.countdown(SleepTimer.remaining(t, now)) + '</b> · stops ' + esc(clockText(t.endsAt));
      if (t && Native.device) lab.innerHTML += ' · dims after 1 min';
      return;
    }
    var cd = $('#nCd'), off = $('#nOff');
    cd.hidden = !t; off.hidden = !!t;
    if (!t) { off.textContent = msg || 'No sleep timer · tap a number'; return; }
    cd.innerHTML = '<small>Lights out in</small>' + (t.mode === 'end' ? 'End' : SleepTimer.countdown(SleepTimer.remaining(t, now))) +
      '<span class="at">' + (t.mode === 'end' ? 'when this episode ends' : 'about ' + esc(clockText(t.endsAt)) + ' · the volume fades over the last minute') + '</span>';
  }

  // ---------- Speed (remembered per channel and per podcast) ----------
  var VRATES = [1, 1.25, 1.5, 1.75, 2];
  function chanKey(v) {
    if (v.channelId) return v.channelId;
    var a = (v.author || '').toLowerCase(), s = a && lib.sources().filter(function (x) { return x.name.toLowerCase() === a; })[0];
    return s ? s.id : a || 'yt';
  }
  function chanName(v) { var s = v.channelId && lib.source(v.channelId); return (s && s.name) || v.author || 'This channel'; }
  function rateFor(v) { var r = prefs.rates && prefs.rates['v:' + chanKey(v)]; return r > 0 ? r : prefs.rate > 0 ? prefs.rate : 1; }
  function setRateFor(id, r) {
    var v = videos[id]; if (!v) return;
    prefs.rates = prefs.rates || {}; prefs.rates['v:' + chanKey(v)] = r; savePrefs();
    wantRate = r; renderRateUI(v);
  }
  function renderRateUI(v) {
    v = v || current && videos[current];
    Array.prototype.forEach.call(document.querySelectorAll('#vRate button'), function (b) { b.setAttribute('aria-pressed', String(+b.getAttribute('data-r') === wantRate)); });
    $('#vRate').setAttribute('aria-label', !v ? 'Speed' : 'Speed for ' + chanName(v) + ', remembered for the channel');
  }
  function podKey(guid) { var r = arec[guid] || {}, m = aMeta[guid] || {}; return 'a:' + (r.source || m.source || r.podcast || 'pod'); }
  function podRate(guid) { var r = prefs.rates && prefs.rates[podKey(guid)]; return r > 0 ? r : prefs.arate > 0 ? prefs.arate : 1; }

  // ---------- Time lines (tap or drag to seek) ----------
  function paintScrub(w, t, d, rate) {
    var pc = d ? Math.min(100, Math.max(0, t / d * 100)) : 0, left = Math.max(0, d - t);
    $('#' + w + 'Line').style.width = pc.toFixed(2) + '%'; $('#' + w + 'Knob').style.left = pc.toFixed(2) + '%';
    $('#' + w + 'T').textContent = Core.fmt(t); scrubAria($('#' + w + 'Scrub'), t, d);
    $('#' + w + 'Left').textContent = d ? '−' + Core.fmt(left) + (rate && rate !== 1 ? ' · at ' + rate + '× −' + Core.fmt(left / rate) : '') : '';
  }
  function scrubDrag(el, w, durOf, rateOf, seek) {
    var at = 0;
    function frac(e) { var r = el.querySelector('.line').getBoundingClientRect(); return r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0; }
    function move(e) { if (scrubbing !== w) return; var d = durOf(); at = frac(e) * d; paintScrub(w, at, d, rateOf()); }
    el.addEventListener('pointerdown', function (e) {
      if (e.button > 0 || !durOf()) return;
      scrubbing = w; try { el.setPointerCapture(e.pointerId); } catch (er) {}
      move(e);
    });
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', function (e) { if (scrubbing !== w) return; move(e); scrubbing = null; seek(at); });
    el.addEventListener('pointercancel', function () { scrubbing = null; });
  }

  // ---------- Swipe a sheet down to close it ----------
  // Past 120 px, or a quick flick, closes; less springs back. Only from the grabber and the top bar, so the
  // video, the chips and scrolling the sheet behave as normal.
  var swallowClick = 0;
  function sheetSwipe(el, handles, close) {
    var y0 = 0, t0 = 0, dy = 0, live = false, moved = false, pid = null;
    el.addEventListener('pointerdown', function (e) {
      if (e.button > 0 || !e.target.closest(handles) || e.target.closest('a')) return; // a link in the bar is a tap, never a swipe
      y0 = e.clientY; t0 = Date.now(); dy = 0; live = true; moved = false; pid = e.pointerId;
    });
    el.addEventListener('pointermove', function (e) {
      if (!live || e.pointerId !== pid) return;
      dy = Math.max(0, e.clientY - y0);
      if (!moved && dy > 8) { moved = true; el.classList.add('drag'); try { el.setPointerCapture(pid); } catch (er) {} }
      if (moved) { el.style.transform = 'translateY(' + dy + 'px)'; e.preventDefault(); }
    });
    function end(e) {
      if (!live || e.pointerId !== pid) return;
      live = false;
      if (!moved) return;
      swallowClick = Date.now() + 400;
      var fast = dy > 40 && dy / Math.max(1, Date.now() - t0) > 0.6;
      el.classList.remove('drag');
      el.style.transform = '';
      if (dy > 120 || fast) close();
    }
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    // A mouse drag on the bar must not turn into a text or link drag (that cancels the swipe)
    el.addEventListener('dragstart', function (e) { if (e.target.closest && e.target.closest(handles)) e.preventDefault(); });
  }
  document.addEventListener('click', function (e) { if (Date.now() < swallowClick) { e.stopPropagation(); e.preventDefault(); } }, true);

  // ---------- Mark (that's a card) ----------
  var noteFor = null;
  function renderMarkBtn(t) { var sp = $('#vMark span'); if (sp) sp.textContent = 'Mark ' + Core.fmt(t || 0); }
  function doMark() {
    if (!current || !videos[current]) return;
    var v = videos[current], t = 0, w = courseOf(current);
    try { t = player.getCurrentTime() || 0; } catch (e) {}
    var m = marks.add({ vid: current, title: v.title || 'YouTube video', t: t, course: w ? w.course.name : '' });
    try { navigator.vibrate && navigator.vibrate(12); } catch (e) {}
    var card = aiOn() && aiKey && isMed(current);
    toast('Marked ' + Core.fmt(m.t) + (card ? ' · drafting a card' : '.'), '', { label: 'Add note', fn: function () { openNote(m.id); } });
    if (card) queueCard(m.id);
    if (stack.length && stack[stack.length - 1].name === 'marks') renderPage();
  }
  function openNote(id) {
    var m = marks.get(id); if (!m) return;
    noteFor = id; $('#noteWhat').textContent = Core.fmt(m.t) + ' · ' + m.title; $('#noteInput').value = m.note || '';
    openDlg($('#noteDlg')); setTimeout(function () { $('#noteInput').focus(); }, 60);
  }
  // Closed without saving: the waiting card is drafted anyway
  $('#noteDlg').addEventListener('close', function () { var nf = noteFor; if (nf && cardTimers[nf] !== undefined) queueCard(nf, true); });
  $('#noteForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (noteFor) marks.setNote(noteFor, $('#noteInput').value);
    var nf = noteFor; $('#noteDlg').close();
    if (nf && cardTimers[nf] !== undefined) { queueCard(nf, true); toast('Note saved · drafting the card with it'); } else toast('Note saved.');
    if (stack.length && stack[stack.length - 1].name === 'marks') renderPage();
  });
  function marksPage() {
    var list = marks.list(), h = topHTML('c1', 'Marks', list.length ? list.length + (list.length === 1 ? ' moment' : ' moments') + ' saved from the player' : 'Moments saved from the player');
    if (!list.length) return h + '<p class="pnote">Nothing marked yet. While a video plays, tap Mark when something should become a card.</p>';
    h += '<div class="pad"><button type="button" class="primary" data-act="marks-copy">Copy for Anki</button><span class="small">Copies one card a line: a drafted card as it is, otherwise the moment on the front and its YouTube link on the back. In Anki on the Mac, File › Import, fields separated by Tab, allow HTML.</span></div>';
    h += '<h2 class="subh"><span>Newest first</span><span class="mono">' + list.length + '</span></h2>';
    list.forEach(function (m) {
      h += '<div class="mrow"><button type="button" data-act="mark-play" data-id="' + esc(m.id) + '"><b><span class="mono">' + Core.fmt(m.t) + '</span> · ' + esc(m.title) + '</b>' +
        '<small>' + (m.note ? esc(m.note) : (m.course ? esc(m.course) + ' · ' : '') + 'no note yet') + '</small></button>' +
        '<span class="iconrow">' + ib('mark-note', m.id, I.dots, 'Note for ' + Core.fmt(m.t)) + ib('mark-remove', m.id, I.x, 'Remove the mark at ' + Core.fmt(m.t)) + '</span>' + markCardHTML(m) + '</div>';
    });
    return h;
  }
  // A drafted card under its mark, folded
  function markCardHTML(m) {
    if (drafting[m.id]) return '<p class="mcard small" role="status">Drafting a card…</p>';
    if (m.card) {
      var c = m.card;
      return '<details class="mcard"><summary>Card drafted</summary>' + (c.stem ? '<p>' + esc(c.stem) + '</p>' : '') + '<p><b>' + esc([].concat(c.questions || []).join(' ')) + '</b></p>' +
        '<p>' + esc(String(c.answer || '').replace(/\*\*/g, '')) + (c.management ? ' ' + esc(String(c.management).replace(/\*\*/g, '')) : '') + '</p>' + (c.vs ? '<p>' + esc(c.vs) + '</p>' : '') + (c.why ? '<p class="small">Why: ' + esc(c.why) + '</p>' : '') +
        (aiOn() && aiKey ? '<button type="button" class="cbtn" data-act="mark-draft" data-id="' + esc(m.id) + '">Draft again</button>' : '') + '</details>';
    }
    if (aiOn() && aiKey && isMed(m.vid)) return '<div class="mcard"><button type="button" class="cbtn" data-act="mark-draft" data-id="' + esc(m.id) + '">Draft a card</button></div>';
    return '';
  }
  function copyText(text, done) {
    var fail = function () { toast("Couldn't copy. Try again.", 'warn'); };
    try { navigator.clipboard.writeText(text).then(done, function () { Native.call('Clipboard', 'write', { string: text }).then(done, fail); }); }
    catch (e) { fail(); }
  }

  // ---------- Gemini (summaries, notes, drafted cards) ----------
  // Works in the app only: the key stays in the phone's storage and the requests go through iOS networking
  var ai = null, aiKey = '', aiHealth = { state: 'none', msg: '' }, aiSumOpen = false, aiAsk = {}, aiRenderT = null, cardTimers = {}, drafting = {};
  function aiOn() { return Native.inApp && !!ai; }
  function isMed(vid) {
    if (courseOf(vid)) return true;
    var v = videos[vid], sec = v && videoSection(v), s = sec && lib.section(sec);
    return sec === 'med' || !!(s && /medic/i.test(s.name || ''));
  }
  // A video's length (seconds) and whether anyone can watch it: the player or the course knows, else its YouTube page
  function videoSecs(vid) {
    var v = videos[vid], w = courseOf(vid), it = w && cs.items(w.course.id)[w.i];
    if (v && v.dur > 0) return Promise.resolve({ secs: v.dur, open: true });
    if (it && it.dur > 0) return Promise.resolve({ secs: it.dur, open: true });
    if (ai.len(vid)) return Promise.resolve(ai.len(vid));
    return fetchText('https://www.youtube.com/watch?v=' + vid).then(function (h) { var r = AI.parseWatch(h); if (r.secs || !r.open) ai.setLen(vid, r); return r; }, function () { return { secs: 0, open: true }; });
  }
  function aiPost(url, body, headers) {
    // A long video can take Gemini a couple of minutes; no answer after 4 is treated as busy
    return withTimeout(Native.httpPost(url, body, headers), 240000, 'slow').then(function (r) { return { status: r.status, text: r.text }; },
      function (e) { if (e && e.message === 'slow') return { status: 504, text: 'slow' }; throw e; });
  }
  var marksDirty = false;
  function renderAiSoon() { clearTimeout(aiRenderT); aiRenderT = setTimeout(function () { renderAiUI(); if ($('#notesDlg').open) fillNotes(); if (marksDirty && stack.length && stack[stack.length - 1].name === 'marks') renderPage(); marksDirty = false; }, 60); }
  function setHTML(el, h) { if (el.__h !== h) { el.__h = h; el.innerHTML = h; } }
  function testAi() {
    if (!aiOn() || !aiKey) { aiHealth = { state: 'none', msg: '' }; return Promise.resolve(); }
    aiHealth = { state: 'wait', msg: '' };
    return ai.test().then(function (r) { aiHealth = r.ok ? { state: 'ok', msg: '' } : { state: r.kind === 'offline' ? 'offline' : 'bad', msg: r.msg }; updateDot(); renderAiSoon(); });
  }
  function setAiKey(k) { aiKey = k; Native.prefSet(AI.KEY_PREF, k); if (ai) ai.clearErrors(); }
  function aiCheck() {
    if (!Native.inApp) return { ok: 1, text: AI.MSG.web };
    if (!aiKey) return { ok: 1, text: AI.MSG.nokey, fix: 'ai-key' };
    var used = AI.hours(ai.usedToday()) + ' of 8 video hours used today';
    if (aiHealth.state === 'wait') return { ok: 2, text: 'Checking your Gemini key…' };
    if (aiHealth.state === 'offline') return { ok: 1, text: 'Gemini: will check the key when you\'re online · ' + used, fix: 'ai-key' };
    if (aiHealth.state === 'bad' && aiHealth.msg === AI.MSG.key) return { ok: 0, text: 'Gemini: ' + AI.MSG.key, fix: 'ai-key' };
    var last = ai.last;
    if (last && last.kind === 'key') return { ok: 0, text: 'Gemini: ' + AI.MSG.key, fix: 'ai-key' };
    if (aiHealth.state === 'bad') return { ok: 1, text: 'Gemini: ' + aiHealth.msg + ' · ' + used, fix: 'ai-key' };
    if (last && /daily|busy/.test(last.kind) && Date.now() - last.at < 3600e3) return { ok: 1, text: 'Gemini: ' + last.msg + ' · ' + used, fix: 'ai-key' };
    return { ok: 1, text: 'Gemini: working · ' + used, fix: 'ai-key' };
  }
  // What the folded Summary row says on the right
  function aiShort(st, kind) {
    if (!aiKey) return 'add a key';
    if (st.state === 'ready') return kind === 'summary' ? 'ready' : '';
    if (st.state === 'queued' || st.state === 'working') return 'watching…';
    if (st.state === 'busy') return 'busy, retrying';
    if (st.state === 'offline') return 'offline';
    if (st.state === 'error') return "didn't work";
    return 'tap to make';
  }
  function renderAiUI() {
    var on = aiOn() && !!current;
    $('#vAiBtn').hidden = !on; $('#vNotes').hidden = !on; $('#vTwin').classList.toggle('ai', on); layoutTwin();
    if (!on) { $('#vAi').hidden = true; return; }
    var st = ai.status(current, 'summary');
    $('#vAiSt').textContent = aiShort(st, 'summary');
    $('#vAiBtn').setAttribute('aria-expanded', String(aiSumOpen));
    $('#vAi').hidden = !aiSumOpen;
    if (aiSumOpen) setHTML($('#vAi'), aiBodyHTML('summary', st));
  }
  // Shared states for Summary (in the player) and Notes (in its sheet)
  function aiBodyHTML(kind, st) {
    var vid = kind === 'notes' ? notesFor : current;
    if (!aiKey) return '<p class="msg">' + esc(AI.MSG.nokey) + '</p><button type="button" class="cbtn" data-act="ai-key">Add Gemini key</button>';
    if (st.state === 'ready') return kind === 'summary' ? summaryHTML(ai.get(vid, 'summary')) : notesHTML(ai.get(vid, 'notes'), vid);
    if (st.state === 'queued' || st.state === 'working') return '<p class="msg" role="status">Gemini is watching the video. A long one can take a minute or two.</p>';
    if (st.state === 'busy' || st.state === 'offline') return '<p class="msg" role="status">' + esc(st.msg) + '</p>';
    if (st.state === 'error') return '<p class="msg err" role="alert">' + esc(st.msg) + '</p>' + (st.msg === AI.MSG.key ? '<button type="button" class="cbtn" data-act="ai-key">Paste the key again</button>' : /it isn't public|resets at|longer than/.test(st.msg) ? '' : '<button type="button" class="cbtn" data-act="ai-go" data-id="' + kind + '">Try again</button>');
    var ask = aiAsk[vid + kind];
    if (ask && ask.err) return '<p class="msg err" role="alert">' + esc(ask.msg) + '</p>';
    if (ask) return '<p class="msg">' + esc(ask.msg) + '</p><button type="button" class="cbtn" data-act="ai-go" data-id="' + kind + '" data-force="1">Make it anyway</button>';
    return '<button type="button" class="cbtn" data-act="ai-go" data-id="' + kind + '">Make ' + (kind === 'summary' ? 'a summary' : 'notes') + '</button>';
  }
  function tt(t) { return t == null ? '' : '<button type="button" class="tt mono" data-act="ai-seek" data-t="' + t + '" aria-label="Play from ' + AI.fmt(t) + '">' + AI.fmt(t) + '</button>'; }
  function summaryHTML(s) {
    return (s.gist ? '<p class="gist">' + esc(s.gist) + '</p>' : '') + '<ol class="pts">' + s.points.map(function (p) { return '<li>' + (p.t == null ? '<span></span>' : tt(p.t)) + '<span>' + esc(p.text) + '</span></li>'; }).join('') + '</ol>';
  }
  function lines(list, f) { return list.length ? '<ul>' + list.map(f).join('') + '</ul>' : ''; }
  function at(t) { return t == null ? '' : '<span class="mono">' + AI.fmt(t) + '</span> '; }
  function notesHTML(n, vid) {
    var h = '<div class="nts">' + (n.topic ? '<p class="topic">' + esc(n.topic) + '</p>' : '');
    if (n.facts.length) h += '<h3>High-yield</h3>' + lines(n.facts, function (f) { return '<li>' + at(f.t) + esc(f.text) + '</li>'; });
    if (n.bullets.length) h += lines(n.bullets, function (f) { return '<li>' + at(f.t) + esc(f.text) + '</li>'; });
    if (n.tested.length) h += '<h3>How it\'s tested</h3>' + lines(n.tested, function (x) { return '<li>' + esc([x.clue, x.dx, x.next].filter(Boolean).join(' → ')) + '</li>'; });
    if (n.versus.length) h += '<h3>Versus</h3>' + lines(n.versus, function (x) { return '<li><b>' + esc(x.name) + '</b>' + (x.feature ? ': ' + esc(x.feature) : '') + '</li>'; });
    if (n.questions.length) h += '<h3>Questions</h3>' + lines(n.questions, function (x) { return '<li>' + at(x.t) + esc((x.clue ? x.clue + ' → ' : '') + x.answer) + (x.why ? ' <span class="small">' + esc(x.why) + '</span>' : '') + '</li>'; });
    h += '</div>';
    if (n.cards.length) h += '<button type="button" class="primary" data-act="notes-anki">Copy ' + n.cards.length + (n.cards.length === 1 ? ' card' : ' cards') + ' for Anki</button>';
    h += '<button type="button" class="ghost" data-act="notes-text">Copy as text</button>';
    if (n.cards.length) h += '<p class="small">Anki on the Mac: File › Import, fields separated by Tab, allow HTML. Text is for OneNote or Claude.</p>';
    return h;
  }
  var notesFor = null;
  function fillNotes() {
    var vid = notesFor; if (!vid) return;
    var v = videos[vid] || {};
    $('#notesH').textContent = 'Notes';
    setHTML($('#notesBody'), '<p class="small">' + esc(v.title || 'YouTube video') + '</p>' + aiBodyHTML('notes', ai.status(vid, 'notes')));
  }
  // Start a summary or notes for the open video. A long one asks first: it uses up the free hours
  function aiStart(kind, force) {
    var vid = kind === 'notes' ? notesFor : current; if (!vid || !aiKey) return;
    var v = videos[vid] || {};
    videoSecs(vid).then(function (r) {
      if (!r.open) { aiAsk[vid + kind] = { err: true, msg: AI.MSG.private }; renderAiSoon(); return; }
      var secs = r.secs || (player && current === vid ? safeDur() : 0);
      if (!force && secs > 5400) {
        aiAsk[vid + kind] = { msg: 'This video is ' + AI.hours(secs) + ' h long, so it uses ' + AI.hours(secs) + ' of today\'s 8 free video hours (' + AI.hours(ai.usedToday()) + ' used so far).' };
        renderAiSoon(); return;
      }
      delete aiAsk[vid + kind];
      // Refused before it started (today's free hours, or too long): say so where the button was
      ai.request({ vid: vid, kind: kind, title: v.title || '', med: isMed(vid), secs: secs || 600 }).catch(function (e) {
        if (e && e.msg && ai.status(vid, kind).state === 'none') aiAsk[vid + kind] = { err: true, msg: e.msg };
      }).then(renderAiSoon);
      renderAiSoon();
    });
  }
  function safeDur() { try { return player.getDuration() || 0; } catch (e) { return 0; } }
  // Automatic summaries after a refresh: new Medicine uploads and the course's next episode, one at a time
  var autoRunning = false;
  function autoSummaries() {
    if (!aiOn() || !aiKey || autoRunning) return;
    var list = feedEntries('med').filter(function (e) { return e.type === 'video' && isNew(e); }).slice(0, 10).map(function (e) { return { vid: e.key, title: e.title }; });
    var c = upNextCourse(), pr = c && cs.progress(c.id);
    if (pr && pr.next) list.unshift({ vid: pr.next.id, title: pr.next.title, secs: pr.next.dur });
    list = list.filter(function (x) { return ai.status(x.vid, 'summary').state === 'none'; });
    if (!list.length) return;
    autoRunning = true;
    (function next() {
      var x = list.shift();
      if (!x || ai.autoBlock(60) === 'count' || ai.autoBlock(60) === 'budget' || !aiKey) { autoRunning = false; return; }
      (x.secs ? Promise.resolve({ secs: x.secs, open: true }) : videoSecs(x.vid)).then(function (r) {
        if (!r.open || ai.autoBlock(r.secs)) return;
        return ai.request({ vid: x.vid, kind: 'summary', title: x.title, med: true, secs: r.secs, auto: true }).catch(function () {});
      }).then(next, next);
    })();
  }
  // Mark in a Medicine video: draft one card from the two minutes around it (after a moment, so a note can join it)
  function queueCard(mid, now) {
    clearTimeout(cardTimers[mid]);
    if (now) return draftCard(mid);
    cardTimers[mid] = setTimeout(function () { if (noteFor !== mid || !$('#noteDlg').open) draftCard(mid); }, 6000);
  }
  function draftCard(mid) {
    var m = marks.get(mid); if (!m || !aiOn() || !aiKey) return;
    clearTimeout(cardTimers[mid]); delete cardTimers[mid];
    drafting[mid] = true; marksDirty = true; renderAiSoon();
    videoSecs(m.vid).then(function (r) {
      return ai.request({ vid: m.vid, kind: 'card', t: m.t, secs: r.secs || 0, note: m.note, title: m.title, med: true, force: true });
    }).then(function (card) {
      delete drafting[mid]; marks.setCard(mid, card); marksDirty = true;
      toast('Marked ' + Core.fmt(m.t) + ' · card drafted');
      renderAiSoon();
    }, function (e) {
      delete drafting[mid]; marksDirty = true; renderAiSoon();
      if (e && e.kind !== 'nokey') toast("Couldn't draft the card for " + Core.fmt(m.t) + ': ' + ((e && e.msg) || 'try again later.'), 'warn');
    });
  }

  // ---------- Night player (podcasts) ----------
  var engine = null, aTick = null, nightOpen = false;
  var RATES = [1, 1.25, 1.5, 2, 0.8];
  function initAudio() {
    engine = AudioEngine.create({
      el: $('#audio'),
      load: function (g) { return arec[g] || null; },
      save: function (g, r) { arec[g] = Object.assign({}, arec[g] || {}, aMeta[g] || {}, r); syncTwin(arec[g]); saveAudio(); },
      onChange: function () { renderAudio(); renderSoon(); }
    });
    // A podcast starting ends the self-check's sound test (the engine then takes the lock-screen controls back)
    $('#audio').addEventListener('play', function () { if (Native.tonePlaying) { Native.stopTone(); if ($('#checkDlg').open) fillCheck(); } clearInterval(aTick); aTick = setInterval(function () { engine.tick(); renderAudio(); }, 1000); });
    $('#audio').addEventListener('pause', function () { clearInterval(aTick); renderAudio(); });
  }
  function openAudio(e) {
    if (current) closeVideo(true);
    aMeta[e.key] = { source: e.src, image: e.image || '', published: e.published || 0, podcast: e.srcName };
    nightOpen = true; openSheet('#nsheet');
    var st = engine.state(), same = st.episode && st.episode.guid === e.key;
    if (!same) engine.play({ guid: e.key, url: e.url, title: e.title, podcast: e.srcName, image: e.image, duration: e.dur });
    else if (!st.playing) engine.toggle();
    engine.setRate(podRate(e.key));
    // At night a podcast starts with a 45-minute sleep timer, so it never has to be remembered half asleep
    if (!same && isNight() && !engine.state().timer) { engine.setTimer(45); setTimeout(function () { toast('45-minute sleep timer on. Tap a number to change it.'); }, 400); }
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
    var mp = st.playing ? 'pause' : 'play'; if ($('#miniPlay').getAttribute('data-g') !== mp) { $('#miniPlay').innerHTML = I[mp]; $('#miniPlay').setAttribute('data-g', mp); }
    $('#miniPlay').setAttribute('aria-label', st.playing ? 'Pause' : 'Play');
    if (!nightOpen) return;
    var r = arec[ep.guid] || {}, m = aMeta[ep.guid] || {};
    var src = lib.source(r.source || m.source);
    var nsec = src && lib.section(src.section);
    $('#nCh').textContent = (nsec ? nsec.name + ' · ' : '') + (ep.podcast || '') + (src && src.private ? ' · Private' : '');
    $('#nTitle').textContent = ep.title;
    $('#nEp').textContent = Core.fmt(st.t) + (st.dur ? ' / ' + Core.fmt(st.dur) + ' · ' + Core.left(st.t, st.dur).toLowerCase() : '') + (Native.inApp ? '' : ' · keep this tab open');
    var art = $('#nArt'); if (ep.image) { if (art.getAttribute('src') !== ep.image) art.src = ep.image; art.hidden = false; } else art.hidden = true;
    $('#nMsg').hidden = !st.message; $('#nMsg').textContent = st.message || '';
    if (scrubbing !== 'n') paintScrub('n', st.t, st.dur, st.rate);
    if ($('#nPlay').getAttribute('data-g') !== mp) { $('#nPlay').innerHTML = I[mp]; $('#nPlay').setAttribute('data-g', mp); }
    $('#nPlay').setAttribute('aria-label', st.playing ? 'Pause' : 'Play');
    $('#nRate').innerHTML = '<span>Speed <b>' + st.rate + '×</b></span><span>' + (st.rate === 1 ? 'tap to change' : 'remembered for this podcast') + '</span>';
    $('#nRate').setAttribute('aria-label', 'Speed ' + st.rate + ' times. Tap to change.');
    $('#nLock').hidden = !Native.inApp;
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

  // ---------- A pasted link (Search box, ⌘V on the Mac, a shelf link) ----------
  function handleText(text, from) {
    text = String(text || '').trim();
    var shelf = text.match(/#shelf=([A-Za-z0-9_-]+)/);
    if (shelf) { importShelf(shelf[1]); renderAll(); return true; }
    var found = Core.findLinks(text), pl = Courses.playlistId(text);
    if (pl && !found.length) { openCourseAdd(text); return true; }
    if (found.length === 1) {
      openVideo({ id: found[0].id, t: found[0].t });
      if (pl && cs && !cs.get(pl)) setTimeout(function () { toast('This video is in a playlist.', '', { label: 'Track it', fn: function () { openCourseAdd(text); } }); }, 600);
      return true;
    }
    if (found.length > 1) {
      found.forEach(function (f) { ensureVideo({ id: f.id, t: f.t }); });
      saveVideos(); toast('Added ' + found.length + ' videos. They\'re under Pasted.');
      return true;
    }
    var c = text && Feeds.parseChannelInput(text);
    if (c && c.kind !== 'name') { openAdd(text); return true; }
    toast(text ? "That doesn't look like a YouTube link. Copy the address from YouTube and try again." : 'Nothing to open. Copy a YouTube link first.', 'warn');
    return false;
  }
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
    $('#addGo').textContent = 'Add to ' + lib.section(addSec).name;
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

  // Channel options: its section, Shorts, remove
  function openChanMenu(id) {
    var s = lib.source(id); if (!s) return;
    if (!$('#chanDlg').open) confirmRemove = null;
    $('#chanH').textContent = s.name;
    $('#chanPicks').innerHTML = lib.sections().map(function (x) { return '<button type="button" data-act="move-channel" data-id="' + esc(s.id) + '" data-to="' + esc(x.id) + '" aria-pressed="' + (x.id === s.section) + '">' + esc(x.name) + '</button>'; }).join('');
    var hid = lib.items(s.id).filter(isShort).length;
    $('#chanShorts').innerHTML = s.type === 'podcast' ? '' : '<button type="button" class="ghost" style="width:100%" data-act="toggle-shorts" data-id="' + esc(s.id) + '" aria-pressed="' + hidesShorts(s) + '">' +
      (hidesShorts(s) ? 'Shorts hidden' + (hid ? ' (' + hid + ')' : '') + ' · tap to show them' : 'Shorts showing · tap to hide them') + '</button>';
    $('#chanDel').setAttribute('data-id', s.id); $('#chanDel').textContent = confirmRemove === s.id ? 'Tap again to remove' : 'Remove channel';
    openDlg($('#chanDlg'));
  }

  // ---------- Sections ----------
  var editing = null, secKind = 'video', confirmDel = false;
  function openSec(id) {
    editing = id || null; confirmDel = false;
    var s = id && lib.section(id);
    $('#secH').textContent = s ? 'Edit category' : 'New category';
    $('#secName').value = s ? s.name : '';
    secKind = s ? s.kind : 'video'; paintKind();
    $('#secMore').hidden = !s; $('#secNew').hidden = !s;
    $('#secDel').textContent = 'Delete category';
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

  // ---------- Courses (playlists ticked episode by episode) ----------
  var cs = null, openC = null, cwin = {}, cgrid = {}, cplace = {}, confirmCourse = null;
  function postJSON(url, body, headers) {
    if (!Native.inApp) return Promise.reject(new Error('This needs the Shelf app on your iPhone.'));
    return withTimeout(Native.httpPost(url, body, headers), 20000, 'No answer after 20 seconds.').then(function (r) {
      if (!r.ok) throw new Error('YouTube said ' + r.status + '.');
      return r.text;
    });
  }
  function epLabel(x, i) { return x.n ? String(x.n) : String(i + 1); }
  // "HY USMLE Q #1107 - Pediatrics" -> "Pediatrics"
  function shortTitle(t) { var s = String(t || '').replace(/^.*?#\s*\d+\s*[-–—:|]*\s*/, '').trim(); return s || String(t || ''); }
  // When every title shortens to the same words, the full title says more
  var repCache = {};
  function titleFor(c, x) {
    var arr = cs.items(c.id), key = c.id + arr.length;
    if (repCache[c.id] == null || repCache[c.id].key !== key) {
      var seen = {}, n = 0; arr.forEach(function (y) { var s = shortTitle(y.title); if (!seen[s]) { seen[s] = 1; n++; } });
      repCache[c.id] = { key: key, rep: arr.length > 3 && n < arr.length * 0.3 };
    }
    return repCache[c.id].rep ? x.title : shortTitle(x.title);
  }
  function spotOf(x) { var v = videos[x.id]; return v && !v.done && v.t > 5 ? Core.fmt(v.t) + ' / ' + Core.fmt(v.dur || x.dur) : x.dur ? Core.fmt(x.dur) : ''; }
  function rulerHTML(c, pr, arr) {
    var n = arr.length;
    if (!n) return '<span class="rl" aria-hidden="true"><i></i></span>';
    if (n <= 60) return '<span class="rl" aria-hidden="true">' + arr.map(function (x, i) { return '<i class="' + (cs.isDone(c.id, x.id) ? 'd' : '') + (i === pr.notch ? ' n' : '') + (c.pins[x.id] ? ' p' : '') + '"></i>'; }).join('') + '</span>';
    var h = '', run = -1, pc = function (v) { return (v / n * 100).toFixed(2) + '%'; };
    for (var i = 0; i <= n; i++) {
      var d = i < n && cs.isDone(c.id, arr[i].id);
      if (d && run < 0) run = i;
      if (!d && run >= 0) { h += '<b style="left:' + pc(run) + ';width:' + pc(i - run) + '"></b>'; run = -1; }
    }
    arr.forEach(function (x, j) { if (c.pins[x.id]) h += '<span class="pk" style="left:' + pc(j + 0.5) + '"></span>'; });
    if (pr.notch >= 0) h += '<span class="nk" style="left:' + pc(pr.notch + 0.5) + '"></span>';
    return '<span class="rl dense" aria-hidden="true">' + h + '</span>';
  }
  function courseShort(c, pr, arr) {
    var st = cs.status(c.id);
    if (!arr.length) return st.loading ? 'Loading episodes…' : !st.ok ? 'Couldn\'t load it. Tap to see why.' : c.seed ? 'Loading episodes…' : feedsOn || prefs.apiKey ? 'Not loaded yet' : 'Episodes load in the Shelf app';
    if (pr.state === 'done') return 'Done';
    if (pr.state === 'new') return pr.total + ' videos' + (pr.hours ? ' · ' + pr.hours : '');
    return (pr.total - pr.done) + ' left';
  }
  function courseSub(c, pr, arr) {
    if (!arr.length || pr.state === 'done') return courseShort(c, pr, arr);
    var pc = cs.pace(c.id), per = pc && pc.perDay ? Courses.perDay(pc.perDay) : '';
    if (pr.state === 'new') return pr.total + ' videos' + (pr.hours ? ' · ' + pr.hours : '') + (per ? ' · <b>' + per + '</b> by ' + esc(goalName()) : '');
    var late = pc.finishBy && pc.finishBy > Courses.exam().getTime();
    return '<b>' + pc.left + ' left</b>' + (per ? ' · ' + per : '') + (pc.finishBy ? ' · <span' + (late ? ' class="late"' : '') + '>done ' + shortDay(pc.finishBy) + ' at this week\'s pace</span>' : '');
  }
  function courseRow(c) {
    var arr = cs.items(c.id), pr = cs.progress(c.id), open = openC === c.id, nx = pr.next;
    var h = '<div class="course ' + pr.state + (open ? ' open' : '') + '">' +
      '<button type="button" class="cr" data-act="course-open" data-id="' + esc(c.id) + '" aria-expanded="' + open + '" aria-label="' + esc(c.name + ', ' + pr.done + ' of ' + pr.total + ' watched. ' + (open ? 'Close' : 'Open')) + '">' +
      '<span class="cl">' + esc(c.name) + '</span>' + rulerHTML(c, pr, arr) + '<span class="cn mono">' + (arr.length ? pr.done + '/' + pr.total : '–') + '</span>' +
      '<span class="cx mono">' + (open ? courseSub(c, pr, arr) : courseShort(c, pr, arr)) + '</span>' + (open && nx && pr.state !== 'new' ? '<span class="cx mono">Next · ' + esc(epLabel(nx, pr.notch)) + ' · ' + esc(shortTitle(nx.title)) + (spotOf(nx) ? ' · ' + esc(spotOf(nx)) : '') + '</span>' : '') + '</button>';
    if (nx) h += '<button type="button" class="cgo" data-act="ep-play" data-id="' + esc(c.id) + '" data-v="' + esc(nx.id) + '" aria-label="' + esc((pr.state === 'new' ? 'Start ' : 'Play next: ') + epLabel(nx, pr.notch)) + '">' + I.play + '</button>';
    else h += '<span class="cgo" aria-hidden="true">' + (pr.state === 'done' ? '✓' : '') + '</span>';
    var pins = arr.map(function (x, i) { return c.pins[x.id] ? { x: x, i: i } : null; }).filter(Boolean);
    if (pins.length && !open) h += '<span class="cpin mono"><span class="pin">‼</span> ' + esc(epLabel(pins[0].x, pins[0].i)) + ' · ' + esc(shortTitle(pins[0].x.title)) + (pins.length > 1 ? ' · +' + (pins.length - 1) : '') + '</span>';
    if (open) h += courseBody(c, pr, arr);
    return h + '</div>';
  }
  function courseBody(c, pr, arr) {
    var st = cs.status(c.id), link = 'https://www.youtube.com/playlist?list=' + encodeURIComponent(c.id), h = '<div class="cbody">';
    if (!st.ok && st.error) h += '<p class="cnote err">' + (/private or gone/.test(st.error) ? 'YouTube says this playlist is private or gone. Your ticks are kept.' : "Couldn't load this playlist from YouTube: " + esc(st.error) + ' Your ticks are safe.') +
      ' <button type="button" data-act="course-retry" data-id="' + esc(c.id) + '">Retry</button></p>';
    if (st.partial) h += '<p class="cnote">YouTube sent only the first ' + arr.length + (st.partial > 0 ? ' of ' + st.partial : '') + ' videos' + (c.seed ? ', so your place from the note waits for the rest' : '') + '. <button type="button" data-act="course-retry" data-id="' + esc(c.id) + '">Load the rest</button></p>';
    if (c.note) h += '<p class="cnote">' + esc(c.note) + '</p>';
    if (arr.length) {
      if (cplace[c.id]) h += '<form class="cplace" data-id="' + esc(c.id) + '"><label for="pl-' + esc(c.id) + '">Watched up to? The episode № from the title, or how many videos in</label>' +
        '<input id="pl-' + esc(c.id) + '" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="e.g. ' + esc(epLabel(arr[Math.max(0, pr.notch)] || arr[0], 0)) + '">' +
        '<span class="row"><button type="submit" class="cbtn solid">Tick up to here</button>' + (pr.done ? '' : '<button type="button" class="cbtn" data-act="course-place" data-id="' + esc(c.id) + '">Not started</button>') + '<button type="button" class="cbtn" data-act="course-pin-no" data-id="' + esc(c.id) + '">Pin ‼</button>' + '</span></form>';
      else if (pr.state === 'new') h += '<p class="cnote">Not started. Tap ▶ to start at the top, or Set place if you\'ve watched some on YouTube.</p>';
      h += cgrid[c.id] ? gridHTML(c, pr, arr) : windowHTML(c, pr, arr);
    }
    h += '<div class="cedge">' + (arr.length ? '<button type="button" data-act="course-grid" data-id="' + esc(c.id) + '">' + (cgrid[c.id] ? 'List' : 'Grid · ' + arr.length) + '</button>' +
      '<button type="button" data-act="course-place" data-id="' + esc(c.id) + '">Set place №</button>' : '') +
      '<a href="' + esc(link) + '" target="_blank" rel="noopener">YouTube ↗</a>' +
      '<button type="button" class="danger" data-act="course-remove" data-id="' + esc(c.id) + '">' + (confirmCourse === c.id ? 'Tap again to remove' : 'Remove') + '</button></div>';
    return h + '</div>';
  }
  function windowHTML(c, pr, arr) {
    var w = cwin[c.id] || (cwin[c.id] = { b: 2, a: 3 });
    var center = pr.notch >= 0 ? pr.notch : arr.length - 1;
    var from = Math.max(0, center - w.b), to = Math.min(arr.length - 1, center + w.a), h = '';
    if (from > 0) h += '<button type="button" class="cmore" data-act="course-earlier" data-id="' + esc(c.id) + '"><span>▲ ' + from + ' earlier</span></button>';
    h += '<ul class="eps">';
    for (var i = from; i <= to; i++) {
      var x = arr[i], d = cs.isDone(c.id, x.id), lab = epLabel(x, i), bare = x.n != null && (titleFor(c, x), repCache[c.id].rep), da = ' data-id="' + esc(c.id) + '" data-v="' + esc(x.id) + '" data-i="' + i + '"';
      h += '<li class="epr' + (d ? ' d' : '') + (i === pr.notch ? ' n' : '') + '">' +
        '<button type="button" class="tk" data-act="ep-tick" data-hold="upto"' + da + ' aria-pressed="' + d + '" aria-label="' + esc((d ? 'Untick ' : 'Tick ') + lab + '. Hold to tick everything up to here.') + '"><span>' + (d ? '✓' : '') + '</span></button>' +
        // Titles that only repeat the number and the course's topic ("HY USMLE Q #1099 - Pediatrics") show just the number
        (bare ? '<span class="no"></span><button type="button" class="et bare mono" data-act="ep-play" data-hold="pin"' + da + ' aria-label="Play ' + esc(x.title) + '">' + (c.pins[x.id] ? '<span class="pin">‼</span> ' : '') + esc(lab) + '</button>'
          : '<span class="no mono">' + (c.pins[x.id] ? '<span class="pin">‼</span> ' : '') + esc(lab) + '</span>' +
        '<button type="button" class="et" data-act="ep-play" data-hold="pin"' + da + '>' + esc(titleFor(c, x)) + '</button>') +
        '<span class="du mono">' + esc(spotOf(x)) + '</span></li>';
    }
    h += '</ul>';
    if (to < arr.length - 1) h += '<button type="button" class="cmore" data-act="course-later" data-id="' + esc(c.id) + '"><span>▼ ' + (arr.length - 1 - to) + ' more</span></button>';
    return h;
  }
  function gridHTML(c, pr, arr) {
    return '<p class="cnote">Tap to tick one. Hold to tick everything up to it.</p><div class="epgrid">' + arr.map(function (x, i) {
      var d = cs.isDone(c.id, x.id), lab = epLabel(x, i);
      return '<button type="button" class="' + (d ? 'd' : '') + (i === pr.notch ? ' n' : '') + (c.pins[x.id] ? ' p' : '') + '" data-act="ep-tick" data-hold="upto" data-id="' + esc(c.id) + '" data-v="' + esc(x.id) + '" data-i="' + i + '" aria-pressed="' + d + '" aria-label="' + esc(lab + ': ' + shortTitle(x.title)) + '">' + esc(lab) + '</button>';
    }).join('') + '</div>';
  }
  function examHTML() {
    var td = cs.today(), days = cs.daysLeft(), past = cs.examPast(), max = Math.max.apply(null, td.week.concat([1]));
    return '<div class="exam"><div class="big mono"><small>' + esc(past ? goalName() : 'Days to ' + goalName()) + '</small>' + (past ? '✓' : days) + '</div><div class="nums mono">' +
      '<p><b>' + esc(DAYS[Courses.exam().getDay()].slice(0, 3) + ' ' + shortDay(Courses.exam().getTime())) + '</b> · ' + td.left + ' left</p>' +
      '<p>' + (past ? '<b>Date passed. Tap Goal to set a new one.</b>' : !td.left ? '<b>Every course done.</b>' : td.perDay ? '<b>' + esc(Courses.perDay(td.perDay)) + '</b> to finish in time' : '<b>It\'s today. Good luck.</b>') + '</p>' +
      '<p>Today <b>' + td.n + (td.secs ? ' · ' + Math.round(td.secs / 60) + ' min' : '') + '</b> · this week <b>' + td.weekN + '</b></p>' +
      '<div class="week" role="img" aria-label="Episodes ticked each day, last 7 days: ' + td.week.join(', ') + '">' + td.week.map(function (n) { return '<i class="' + (n ? '' : 'z') + '" style="height:' + (n ? Math.max(15, Math.round(n / max * 100)) : 8) + '%"></i>'; }).join('') + '</div>' +
      '</div></div>';
  }
  // The goal the pace counts down to: Step 2 CK on 22 Dec unless Mo changes it (prefs.goal)
  function goalName() { return (prefs.goal && prefs.goal.name) || 'Step 2 CK'; }
  function applyGoal() { var g = prefs.goal, d = g && g.date && /^\d{4}-\d\d-\d\d$/.test(g.date) ? new Date(+g.date.slice(0, 4), +g.date.slice(5, 7) - 1, +g.date.slice(8, 10)) : null; Courses.setExam(d); }
  function isoOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function goalISO() { return isoOf(Courses.exam()); }
  function todayISO() { return isoOf(new Date()); }
  function longDay(d) { return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
  // Pace: everything with numbers lives here, one tap away from Courses
  function leftSecs(c) { return cs.items(c.id).reduce(function (a, x) { return a + (cs.isDone(c.id, x.id) ? 0 : x.dur || 0); }, 0); }
  function hrs(sec) { var h = sec / 3600; return h >= 10 ? Math.round(h) + ' h' : h >= 1 ? (Math.round(h * 10) / 10) + ' h' : Math.max(1, Math.round(sec / 60)) + ' min'; }
  function paceHTML() {
    var h = '<button type="button" class="goal" data-act="edit-goal"><span><small>Goal</small><b>' + esc(goalName()) + '</b> · ' + esc(shortDay(Courses.exam().getTime())) + '</span><span class="mono">Edit</span></button>' + examHTML(), open = cs.list().filter(function (c) { var pr = cs.progress(c.id); return pr.total && pr.state !== 'done'; }), tot = 0, tsec = 0;
    h += '<ul class="plist">' + open.map(function (c) {
      var pr = cs.progress(c.id), pc = cs.pace(c.id), left = pr.total - pr.done, sec = leftSecs(c); tot += left; tsec += sec;
      var late = pc && pc.finishBy && pc.finishBy > Courses.exam().getTime();
      return '<li><b>' + esc(c.name) + '</b><span class="mono">' + left + ' left' + (sec ? ' · ' + hrs(sec) : '') + (pc && pc.perDay ? ' · ' + esc(Courses.perDay(pc.perDay)) : '') +
        (pc && pc.finishBy ? '<br><span' + (late ? ' class="late"' : '') + '>done ' + esc(shortDay(pc.finishBy)) + ' at this week\'s pace</span>' : '') + '</span></li>';
    }).join('');
    var td = cs.today();
    if (open.length > 1) h += '<li class="tot"><b>All</b><span class="mono">' + tot + ' left' + (tsec ? ' · ' + hrs(tsec) : '') + (td.perDay ? ' · ' + esc(Courses.perDay(td.perDay)) : '') + '</span></li>';
    return h + '</ul>';
  }
  function paceText() {
    var d = new Date(), days = cs.daysLeft(), td = cs.today(), lines = [];
    lines.push('My study plan, from my Shelf app (' + longDay(d) + ').');
    lines.push(cs.examPast() ? 'My goal, ' + goalName() + ', was on ' + longDay(Courses.exam()) + '.' : 'Goal: ' + goalName() + ' on ' + longDay(Courses.exam()) + ', ' + days + (days === 1 ? ' day' : ' days') + ' from today.');
    lines.push('Video courses (YouTube playlists):');
    cs.list().forEach(function (c) {
      var pr = cs.progress(c.id); if (!pr.total) return;
      var sec = leftSecs(c);
      lines.push('- ' + c.name + (c.channel ? ' (' + c.channel + ')' : '') + ': ' + pr.done + ' of ' + pr.total + ' watched' + (pr.state === 'done' ? ' (done)' : ', ' + (pr.total - pr.done) + ' left' + (sec ? ', about ' + hrs(sec) + ' of video' : '')));
    });
    lines.push('Watched today: ' + td.n + '. Last 7 days: ' + td.weekN + '.');
    lines.push('Work out how many videos a day I need to finish before ' + goalName() + ', which order to do the courses in, and a simple week-by-week schedule that leaves the last week for review. Keep it short.');
    return lines.join('\n');
  }
  function courseGroups(list) {
    var groups = { go: [], new: [], done: [] }, h = '';
    list.forEach(function (c) { var s = cs.progress(c.id).state; (groups[s === 'empty' ? (c.touched || c.seed ? 'go' : 'new') : s] || groups.new).push(c); });
    groups.go.sort(function (a, b) { return (b.touched || 0) - (a.touched || 0); });
    ['go', 'new', 'done'].forEach(function (g) {
      if (groups[g].length) h += '<div class="cgroup g-' + g + '">' + groups[g].map(courseRow).join('') + '</div>';
    });
    return h;
  }
  function coursesPage(v) {
    var sec = lib.section(v.id) || lib.sections()[0], all = cs.list().filter(function (c) { return courseSec(c) === sec.id; }), h = '';
    var chans = {}; all.forEach(function (c) { if (c.channel) chans[c.channel] = 1; });
    var who = Object.keys(chans).length === 1 ? Object.keys(chans)[0] : sec.name;
    h += topHTML(bandClass(sec.id), 'Courses', esc(who) + ' · ' + all.length + (all.length === 1 ? ' course' : ' courses'),
      ib('open-marks', null, I.mark, 'Marks') + ib('add-course', sec.id, I.plus, 'Add a playlist'));
    if (cs.list().length) h += '<button type="button" class="more" data-act="open-pace"><span>Pace</span><span class="mono">' + (cs.examPast() ? 'what\'s left' : cs.daysLeft() + ' days to ' + esc(goalName())) + ' ›</span></button>';
    if (!feedsOn && !prefs.apiKey) h += '<p class="pnote">Episodes load in the Shelf app on your iPhone.</p>';
    h += courseGroups(all);
    if (!all.length) h += '<p class="pnote">No courses yet. Add a playlist and Shelf ticks it episode by episode.</p>';
    // A Mehlman playlist Shelf couldn't find on its own: one quiet line that adds it
    if (sec.id === Courses.SEED.section) cs.misses.forEach(function (m) {
      h += '<button type="button" class="more quiet" data-act="add-course" data-id="' + esc(sec.id) + '" data-fix="' + esc(m.name) + '"><span>' + esc(m.name) + ' · not found</span><span class="mono">+ Add playlist</span></button>';
    });
    // Courses kept in other sections follow under their own band colour
    lib.sections().forEach(function (o) {
      if (o.id === sec.id) return;
      var mine = cs.list().filter(function (c) { return courseSec(c) === o.id; });
      if (mine.length) h += '<h2 class="subh band ' + bandClass(o.id) + '"><span>' + esc(o.name) + '</span><span class="mono">' + mine.length + '</span></h2><div class="cgroup">' + mine.map(courseRow).join('') + '</div>';
    });
    h += '<button type="button" class="more" data-act="add-course" data-id="' + esc(sec.id) + '"><span>+ Add a playlist</span><span class="mono">a link, or type a name</span></button>';
    return h;
  }
  function courseSec(c) { return lib.section(c.section) ? c.section : lib.sections()[0].id; }
  function openCourses(secId) { push({ name: 'courses', id: secId || 'med' }); }
  // Re-render without losing what's being typed in a Set place box
  function keepTyping(fn) {
    var a = document.activeElement, id = a && a.id && /^(pl-|sq$)/.test(a.id) ? a.id : null, val = id ? a.value : '', sel = id ? [a.selectionStart, a.selectionEnd] : null;
    var sq = $('#sq'), sqVal = sq ? sq.value : null;
    fn();
    // The Search box keeps what's typed even when it isn't focused
    var sq2 = $('#sq'); if (sq2 && sqVal !== null && sq2.value !== sqVal) sq2.value = sqVal;
    if (id) { var n = document.getElementById(id); if (n) { n.value = val; try { n.focus({ preventScroll: true }); if (sel && sel[0] != null) n.setSelectionRange(sel[0], sel[1]); } catch (e) {} } }
  }
  function syncCourses(force) {
    if (!cs || !(feedsOn || prefs.apiKey)) return Promise.resolve();
    return (feedsOn ? cs.seed() : Promise.resolve()).then(function () { return cs.loadAll(force, function () { renderSoon(); }); }).then(function () { renderSoon(); updateDot(); });
  }
  // Tick (or untick) one episode; the video's own saved spot agrees
  function setTick(cid, vid, on) {
    cs.tick(cid, vid, on);
    var v = videos[vid];
    if (v && on && !v.done) { v.done = true; v.updated = Date.now(); saveVideos(); }
    else if (v && !on && v.done) { v.done = false; if (v.dur && v.t >= v.dur - 20) v.t = 0; saveVideos(); } // keeps a half-watched spot
    renderAll();
  }
  function playEp(cid, vid) {
    var c = cs.get(cid), x = c && cs.items(cid).filter(function (y) { return y.id === vid; })[0];
    if (!x) return;
    var src = lib.sources().filter(function (s) { return c.channel && s.name.toLowerCase() === c.channel.toLowerCase(); })[0];
    cs.touch(cid);
    openVideo({ id: vid, title: x.title, author: c.channel || '', channelId: src ? src.id : '', section: c.section, dur: x.dur });
  }
  function holdAct(el) {
    var cid = el.getAttribute('data-id'), vid = el.getAttribute('data-v'), i = +el.getAttribute('data-i'), c = cs.get(cid);
    if (!c) return;
    var arr = cs.items(cid), x = arr[i], lab = x ? epLabel(x, i) : '';
    try { navigator.vibrate && navigator.vibrate(12); } catch (e) {}
    if (el.getAttribute('data-hold') === 'upto') {
      var before = cs.tickUpTo(cid, i);
      renderAll();
      toast('Ticked everything up to ' + lab + ' (' + (i + 1) + ' of ' + arr.length + ').', '', { label: 'Undo', fn: function () { cs.restore(cid, before); renderAll(); } });
    } else {
      var on = !c.pins[vid];
      cs.pin(cid, vid, on); renderAll();
      toast(on ? 'Pinned ‼ ' + lab + '. It stays on ' + c.name + '\'s row.' : 'Unpinned ' + lab + '.');
    }
  }
  // Press and hold: 'upto' on a tick, 'pin' on a title
  var cHoldT = null, cHoldXY = null, cHeld = false, cSwallowUntil = 0;
  document.addEventListener('pointerdown', function (e) {
    var el = e.target.closest && e.target.closest('[data-hold]'); if (!el) return;
    cHoldXY = [e.clientX, e.clientY]; cHeld = false; clearTimeout(cHoldT);
    cHoldT = setTimeout(function () { cHeld = true; cSwallowUntil = Date.now() + 1500; holdAct(el); }, 600);
  });
  document.addEventListener('pointermove', function (e) { if (cHoldXY && Math.abs(e.clientX - cHoldXY[0]) + Math.abs(e.clientY - cHoldXY[1]) > 12) clearTimeout(cHoldT); });
  ['pointerup', 'pointercancel'].forEach(function (t) { document.addEventListener(t, function () { clearTimeout(cHoldT); cHoldXY = null; if (cHeld) { cHeld = false; cSwallowUntil = Date.now() + 450; } }); });
  document.addEventListener('contextmenu', function (e) { if (e.target.closest && e.target.closest('[data-hold]')) e.preventDefault(); });
  // Set place: an episode number from the titles
  document.addEventListener('submit', function (e) {
    var f = e.target.closest && e.target.closest('.cplace'); if (!f) return;
    e.preventDefault();
    var cid = f.getAttribute('data-id'), c = cs.get(cid), n = parseInt(f.querySelector('input').value, 10);
    if (!c || !n) { toast('Type a number: the episode № from the title, or how many videos in you are.', 'warn'); return; }
    var hits = cs.findNumber(cid, n), arr = cs.items(cid), numbered = arr.some(function (x) { return x.n != null; });
    function tickTo(i, said) {
      var before = cs.tickUpTo(cid, i);
      cplace[cid] = false; cwin[cid] = null;
      renderAll();
      toast(said + ' Ticked everything up to it.', '', { label: 'Undo', fn: function () { cs.restore(cid, before); renderAll(); } });
    }
    if (hits.length) return tickTo(hits[0], n + ' is ' + (hits[0] + 1) + ' of ' + arr.length + (hits.length > 1 ? ' (first of ' + hits.length + ')' : '') + '.');
    if (n > arr.length) { toast('No episode ' + n + ' in ' + c.name + ', and it has only ' + arr.length + ' videos.', 'warn'); return; }
    // Titles without numbers: the number is how many videos in
    if (!numbered) return tickTo(n - 1, 'Video ' + n + ' of ' + arr.length + '.');
    // Numbered titles but no match: could be a typo, so ask before ticking by count
    toast('No episode ' + n + ' in ' + c.name + '. Meant the first ' + n + ' videos?', 'warn', { label: 'Tick ' + n, fn: function () { tickTo(n - 1, 'Video ' + n + ' of ' + arr.length + '.'); } });
  });

  // URL: play (or add) whatever YouTube link goes in the box
  $('#urlForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var t = $('#urlInput').value.trim();
    if (!t) { $('#urlMsg').textContent = 'Paste a YouTube link first.'; $('#urlMsg').className = 'msgline err'; return; }
    if (!isLinkish(t)) { $('#urlMsg').textContent = "That isn't a YouTube link. It should start with youtube.com or youtu.be."; $('#urlMsg').className = 'msgline err'; return; }
    $('#urlDlg').close(); handleText(t);
  });
  // Edit the goal: a name and a date
  $('#goalForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('#goalName').value.trim().slice(0, 40), date = $('#goalDate').value;
    if (!name) { $('#goalMsg').textContent = 'Give it a name, like Step 2 CK or Paeds rotation.'; $('#goalMsg').className = 'msgline err'; return; }
    if (!/^\d{4}-\d\d-\d\d$/.test(date)) { $('#goalMsg').textContent = 'Pick a date.'; $('#goalMsg').className = 'msgline err'; return; }
    if (date < todayISO()) { $('#goalMsg').textContent = 'That date has passed. Pick today or later.'; $('#goalMsg').className = 'msgline err'; return; }
    prefs.goal = { name: name, date: date }; savePrefs(); applyGoal();
    $('#goalDlg').close(); renderAll();
    $('#paceBody').innerHTML = paceHTML(); openDlg($('#paceDlg'));
    toast(cs.examPast() ? 'Goal saved.' : 'Goal saved: ' + cs.daysLeft() + ' days to ' + name + '.');
  });

  // Add a course
  var cAddSec = 'med', cFix = null, cAdding = false, chanLists = null;
  function openCourseAdd(prefill, secId, fixName) {
    cFix = fixName || null;
    var secs = lib.sections();
    cAddSec = secId && lib.section(secId) ? secId : lib.section('med') ? 'med' : secs[0].id;
    $('#courseSec').innerHTML = secs.map(function (s) { return '<button type="button" data-act="course-sec" data-id="' + esc(s.id) + '" aria-pressed="' + (s.id === cAddSec) + '">' + esc(s.name) + '</button>'; }).join('');
    $('#courseInput').value = prefill || '';
    $('#courseName').value = fixName || ''; $('#courseName').removeAttribute('data-auto');
    $('#courseMsg').textContent = feedsOn || prefs.apiKey ? '' : 'Adding courses works in the Shelf app on your iPhone.';
    $('#courseMsg').className = 'msgline';
    $('#courseH').textContent = fixName ? 'Find ' + fixName : 'Add a course';
    openDlg($('#courseDlg'));
    renderCoursePicks();
    if (feedsOn && !chanLists) cs.channelPlaylists(Courses.SEED.channel).then(function (l) { chanLists = l; renderCoursePicks(); }, function () {});
    if (!prefill && !isPhone) setTimeout(function () { $('#courseInput').focus(); }, 50);
  }
  function renderCoursePicks() {
    var q = $('#courseInput').value.trim().toLowerCase(), box = $('#coursePicks');
    if (!chanLists || Courses.playlistId(q) || /^https?:|youtu/.test(q)) { box.innerHTML = ''; return; }
    var have = {}; cs.list().forEach(function (c) { have[c.id] = 1; });
    var words = q.split(/\s+/).filter(Boolean);
    var hits = chanLists.filter(function (p) { var t = p.title.toLowerCase(); return !have[p.id] && words.every(function (w) { return t.indexOf(w) >= 0; }); });
    box.innerHTML = (hits.length ? '<span class="small">' + (q ? 'Mehlman playlists matching "' + esc(q) + '"' : 'From Mehlman Medical (type to narrow)') + '</span>' : q ? '<span class="small">No Mehlman playlist matches "' + esc(q) + '". Paste a link instead.</span>' : '') +
      hits.slice(0, 4).map(function (p) { return '<button type="button" data-act="course-pick" data-pl="' + esc(p.id) + '" data-t="' + esc(p.title) + '" aria-pressed="false"><span>' + esc(p.title) + '</span><span class="mono">' + (p.count || '') + '</span></button>'; }).join('') +
      (hits.length > 4 ? '<span class="small">+ ' + (hits.length - 4) + ' more. Type to narrow.</span>' : '');
  }
  $('#courseInput').addEventListener('input', renderCoursePicks);
  $('#courseName').addEventListener('input', function () { this.removeAttribute('data-auto'); });
  $('#courseForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (cAdding) return;
    var val = $('#courseInput').value.trim(), msg = $('#courseMsg'), name = $('#courseName').value.trim();
    var pid = Courses.playlistId(val);
    if (!pid && chanLists && val) {
      var only = Array.prototype.map.call(document.querySelectorAll('#coursePicks [data-pl]'), function (b) { return b.getAttribute('data-pl'); });
      if (only.length === 1) pid = only[0];
    }
    if (!pid) { msg.textContent = val ? "That's not a playlist link. It should contain list=." : 'Paste a playlist link first.'; msg.className = 'msgline err'; return; }
    cAdding = true; msg.textContent = 'Looking it up…'; msg.className = 'msgline'; $('#courseGo').disabled = true;
    var fromChan = chanLists && chanLists.some(function (p) { return p.id === pid; });
    cs.add(pid, { name: name || cFix || '', section: cAddSec, channel: fromChan ? 'Mehlman Medical' : '' }).then(function (c) {
      cAdding = false; $('#courseGo').disabled = false;
      if (cFix) cs.fixMiss(cFix, c);
      var pr = cs.progress(c.id);
      msg.textContent = 'Added ' + c.name + ' · ' + pr.total + ' videos' + (pr.hours ? ' · ' + pr.hours : '') + '.'; msg.className = 'msgline ok';
      openC = c.id; cplace[c.id] = pr.total > 0; renderAll(); updateDot();
      setTimeout(function () {
        if ($('#courseDlg').open) $('#courseDlg').close();
        // Straight to the new course, asking how far in you already are
        var v = stack[stack.length - 1], sid = c.section || cAddSec || 'med';
        if (!v || v.name !== 'courses' || (v.id && v.id !== sid)) openTab({ name: 'courses', id: sid });
        var tries = 0;
        (function focusRow() {
          var row = document.getElementById('pl-' + c.id);
          if (row && row.offsetParent) { row.scrollIntoView({ block: 'center' }); row.focus({ preventScroll: true }); }
          else if (++tries < 20) setTimeout(focusRow, 100);
        })();
      }, 900);
    }, function (err) {
      cAdding = false; $('#courseGo').disabled = false;
      msg.textContent = (err && err.message) || "Couldn't add that."; msg.className = 'msgline err';
    });
  });

  // In the player: which course this video is in, and what's next
  function courseOf(vid) { return cs ? cs.where(vid) : null; }
  function courseTag(vid) {
    var w = courseOf(vid); if (!w) return '';
    return w.course.name.toUpperCase() + ' · ' + (w.i + 1) + ' OF ' + cs.items(w.course.id).length;
  }
  function renderPlayerCourse(vid) {
    var w = courseOf(vid), box = $('#vCourse');
    if (!w) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = rulerHTML(w.course, cs.progress(w.course.id), cs.items(w.course.id));
  }
  // The next unticked episode after position i (or the first gap earlier on)
  function nextAfter(c, i) {
    var arr = cs.items(c.id);
    for (var k = i + 1; k < arr.length; k++) if (!cs.isDone(c.id, arr[k].id)) return { x: arr[k], i: k };
    for (var j = 0; j < arr.length; j++) if (j !== i && !cs.isDone(c.id, arr[j].id)) return { x: arr[j], i: j };
    return null;
  }
  // In the player: "Next: 1123 ▶" beside Mark, inside a course
  function renderNextBtn(vid) {
    var w = courseOf(vid), n = w && nextAfter(w.course, w.i), b = $('#vNextBtn');
    b.hidden = !n; layoutTwin();
    if (!n) return;
    b.setAttribute('data-id', w.course.id); b.setAttribute('data-v', n.x.id);
    b.innerHTML = '<span>Next: ' + esc(epLabel(n.x, n.i)) + '</span>' + I.play;
    b.setAttribute('aria-label', 'Play next: ' + epLabel(n.x, n.i) + ' ' + shortTitle(n.x.title));
  }
  function showNextUp(w) {
    var c = w.course, n = nextAfter(c, w.i), box = $('#vNext'), pr = cs.progress(c.id), auto = prefs.autoNext !== false && n && document.visibilityState === 'visible';
    clearTimeout(nextTimer);
    if (n) box.innerHTML = '<small>Next up · ' + esc(c.name) + '</small><b>' + esc(epLabel(n.x, n.i)) + ' · ' + esc(shortTitle(n.x.title)) + (n.x.dur ? ' · ' + Core.fmt(n.x.dur) : '') + '</b>' +
      '<span class="cdn">' + (auto ? 'Plays in 5 s' : '') + '</span>' +
      '<div class="twin"><button type="button" class="act solid" data-act="ep-play" data-id="' + esc(c.id) + '" data-v="' + esc(n.x.id) + '"><span>Play next</span>' + I.play + '</button>' +
      (auto ? '<button type="button" class="act" data-act="next-cancel">Stop</button>' : '<button type="button" class="act" data-act="close-video">Done for now</button>') + '</div>' +
      '<button type="button" class="auto" data-act="auto-toggle">Autoplay next: ' + (prefs.autoNext === false ? 'off' : 'on') + '</button>';
    else box.innerHTML = '<small>' + esc(c.name) + '</small><b>Course done · ' + pr.done + '/' + pr.total + '</b><div class="twin"><button type="button" class="act solid" data-act="course-back" data-id="' + esc(c.section || 'med') + '">Back to courses</button></div>';
    box.hidden = false;
    $('#vNextBtn').hidden = true;
    renderPlayerCourse(w.course.id && cs.items(c.id)[w.i] ? cs.items(c.id)[w.i].id : '');
    try { box.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); } catch (e) {}
    // A question-bank session flows on: the next one starts after a 5-second countdown (Stop, or turn it off)
    if (auto) {
      var left = 5, vid = current;
      var step = function () {
        var cdn = $('#vNext .cdn');
        if (current !== vid || !cdn || box.hidden) return;
        if (document.visibilityState !== 'visible') { nextTimer = setTimeout(step, 1000); return; }
        if (--left <= 0) { playEp(c.id, n.x.id); return; }
        cdn.textContent = 'Plays in ' + left + ' s'; nextTimer = setTimeout(step, 1000);
      };
      nextTimer = setTimeout(step, 1000);
    }
  }

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
      case 'home': goHome(); break;
      case 'search': if (!openTab({ name: 'search', q: prefs.lastQ || '' })) { var q = $('#sq'); if (q) q.focus(); } break;
      case 'refresh': refreshAll(true); break;
      case 'refresh-channel': lib.refresh(id, true).then(function () { lib.saveCache(); renderAll(); }); toast('Checking for new uploads…'); break;
      case 'add-channel': openAdd(b.getAttribute('data-in') || '', id); break;
      case 'fix-seed': openAdd(b.getAttribute('data-in'), id); break;
      case 'add-pick': addSec = id; Array.prototype.forEach.call(document.querySelectorAll('#addPicks button'), function (x) { x.setAttribute('aria-pressed', String(x === b)); }); $('#addGo').textContent = 'Add to ' + lib.section(id).name; break;
      case 'add-section': openSec(null); break;
      case 'v-timer-toggle': vTmOpen = !vTmOpen; renderTimerUI('v'); break;
      case 'paste-url': $('#urlInput').value = ''; $('#urlMsg').textContent = ''; openDlg($('#urlDlg')); setTimeout(function () { $('#urlInput').focus(); }, 60); break;
      case 'url-paste':
        Native.readClipboard().then(function (t) {
          t = (t || '').trim();
          if (!t) { $('#urlMsg').textContent = 'Nothing copied yet. Copy a YouTube link first, or type it in.'; $('#urlMsg').className = 'msgline err'; return; }
          $('#urlInput').value = t; $('#urlForm').requestSubmit ? $('#urlForm').requestSubmit() : $('#urlForm').dispatchEvent(new Event('submit', { cancelable: true }));
        }, function () { $('#urlMsg').textContent = "Couldn't read what you copied. Long-press the box and tap Paste."; $('#urlMsg').className = 'msgline err'; });
        break;
      case 'open-pace': $('#paceBody').innerHTML = paceHTML(); openDlg($('#paceDlg')); break;
      case 'edit-goal': $('#goalName').value = goalName(); $('#goalDate').min = todayISO(); $('#goalDate').value = goalISO(); $('#goalMsg').textContent = ''; if ($('#paceDlg').open) $('#paceDlg').close(); openDlg($('#goalDlg')); break;
      case 'goal-reset': delete prefs.goal; savePrefs(); applyGoal(); $('#goalDlg').close(); renderAll(); $('#paceBody').innerHTML = paceHTML(); openDlg($('#paceDlg')); toast('Goal back to Step 2 CK on 22 December.'); break;
      case 'pace-copy': copyText(paceText(), function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy for Claude'; }, 2500); toast('Copied. Paste it into Claude.'); }); break;
      case 'toggle-band': prefs.open = prefs.open || {}; if (prefs.open[id]) delete prefs.open[id]; else prefs.open[id] = 1; savePrefs(); renderHome(); var tg = document.querySelector('.band [data-act="toggle-band"][data-id="' + id + '"]'); if (tg) tg.focus({ preventScroll: true }); break;
      case 'edit-section': openSec(id); break;
      case 'sec-up': case 'sec-down': lib.moveSection(editing, act === 'sec-up' ? -1 : 1); renderAll(); break;
      case 'sec-delete':
        if (!confirmDel) { confirmDel = true; var to = lib.sections().filter(function (s) { return s.id !== editing; })[0]; b.textContent = 'Tap again: channels move to ' + (to ? to.name : '?'); break; }
        try { var toSec = lib.removeSection(editing); cs.list().forEach(function (c) { if (c.section === editing) cs.move(c.id, toSec); }); $('#secDlg').close(); if (stack.length) { unwind(); $('#page').hidden = true; } renderAll(); toast('Category deleted. Its channels moved.'); }
        catch (err) { $('#secMsg').textContent = err.message; $('#secMsg').className = 'msgline err'; }
        break;
      case 'seen-section': lib.sources(id).forEach(function (s) { lib.markSeen(s.id); }); renderAll(); break;
      case 'channel-menu': openChanMenu(id); break;
      case 'move-channel': lib.setSection(id, b.getAttribute('data-to')); openChanMenu(id); renderAll(); break;
      case 'toggle-shorts': var ts = lib.source(id); if (ts) { lib.setHideShorts(id, !hidesShorts(ts)); openChanMenu(id); renderAll(); } break;
      case 'remove-channel':
        if (confirmRemove !== id) { confirmRemove = id; b.textContent = 'Tap again to remove'; break; }
        var nm = lib.source(id).name; lib.remove(id); confirmRemove = null; lib.saveCache(); $('#chanDlg').close(); back(); toast('Removed ' + nm + '.'); break;
      case 'remove-dup':
        if (confirmRemove !== id) { confirmRemove = id; renderPage(); break; }
        var dn = lib.source(id); if (dn) { lib.remove(id); lib.saveCache(); toast('Removed the broken copy of ' + dn.name + '.'); } confirmRemove = null; renderAll(); break;
      case 'remove-video':
        var gone = videos[id]; delete videos[id]; saveVideos(); renderAll();
        if (!Object.keys(videos).some(function (k) { return !entryFromVideo(videos[k]).section; }) && stack.length && stack[stack.length - 1].name === 'pasted') back();
        toast('Removed.', '', { label: 'Undo', fn: function () { videos[id] = gone; saveVideos(); renderAll(); } });
        break;
      case 'close-video': closeVideo(); break;
      case 'open-courses': if (b.id === 'coursesBtn') openTab({ name: 'courses', id: id || 'med' }); else openCourses(id); break;
      case 'open-marks': push({ name: 'marks' }); break;
      case 'mark': doMark(); break;
      case 'listen': listen(); break;
      case 'lock-setup': openLockDlg(); break;
      case 'lock-toggle': prefs.autoLock = !prefs.autoLock; savePrefs(); renderLockDlg(); if (prefs.autoLock) toast('Auto-lock on. Try Play locked on any video.'); break;
      case 'twin-pick': pickTwin(+b.getAttribute('data-i')); break;
      case 'ai-sum':
        aiSumOpen = !aiSumOpen; renderAiUI();
        if (aiSumOpen && aiKey && current && ai.status(current, 'summary').state === 'none' && !aiAsk[current + 'summary']) aiStart('summary');
        break;
      case 'ai-go': if (b.getAttribute('data-force')) delete aiAsk[(id === 'notes' ? notesFor : current) + id]; aiStart(id, !!b.getAttribute('data-force')); break;
      case 'ai-seek': try { player.seekTo(+b.getAttribute('data-t'), true); player.playVideo(); videoTick(); } catch (er) {} break;
      case 'ai-notes':
        if (!current) break;
        notesFor = current; fillNotes(); openDlg($('#notesDlg'));
        if (aiKey && ai.status(current, 'notes').state === 'none' && !aiAsk[current + 'notes']) aiStart('notes');
        break;
      case 'notes-anki': var na = ai.get(notesFor, 'notes'); if (na) copyText(AI.notesAnki(na), function () { toast('Copied ' + na.cards.length + (na.cards.length === 1 ? ' card' : ' cards') + '. In Anki: File › Import.'); }); break;
      case 'notes-text': var nt = ai.get(notesFor, 'notes'), nv = videos[notesFor] || {}; if (nt) copyText(AI.notesText(nt, nv.title, notesFor), function () { toast('Copied the notes as text.'); }); break;
      case 'ai-key':
        if ($('#checkDlg').open) $('#checkDlg').close(); if ($('#notesDlg').open) $('#notesDlg').close();
        $('#aiKeyInput').value = aiKey; $('#aiKeyMsg').textContent = ''; $('#aiKeyMsg').className = 'msgline'; openDlg($('#aiKeyDlg'));
        break;
      case 'ai-key-paste': Native.readClipboard().then(function (t) { $('#aiKeyInput').value = String(t || '').trim(); }, function () { $('#aiKeyMsg').textContent = 'Couldn\'t read the clipboard. Press and hold in the box, then Paste.'; $('#aiKeyMsg').className = 'msgline err'; }); break;
      case 'ai-key-remove': setAiKey(''); aiHealth = { state: 'none', msg: '' }; $('#aiKeyInput').value = ''; $('#aiKeyMsg').textContent = 'Removed. Summaries and notes are off until you add a key.'; $('#aiKeyMsg').className = 'msgline ok'; updateDot(); renderAiSoon(); break;
      case 'mark-draft': queueCard(id, true); break;
      case 'mark-play': var mk = marks.get(id); if (mk) openVideo({ id: mk.vid, start: Math.max(1, mk.t), title: mk.title }); break;
      case 'mark-note': openNote(id); break;
      case 'mark-remove': var gm = marks.remove(id); renderPage(); if (gm) toast('Mark removed.', '', { label: 'Undo', fn: function () { marks.restore(gm); renderAll(); } }); break;
      case 'marks-copy': var n0 = marks.count; copyText(marks.anki(), function () { b.textContent = 'Copied ' + n0 + (n0 === 1 ? ' card' : ' cards'); setTimeout(function () { b.textContent = 'Copy for Anki'; }, 2500); toast('Copied. In Anki: File › Import, then paste or pick the text.'); }); break;
      case 'v-rate': var vr = +b.getAttribute('data-r'); if (current) { setRateFor(current, vr); try { player.setPlaybackRate(vr); } catch (er) {} videoTick(); } break;
      case 'next-cancel': clearTimeout(nextTimer); var cdn = $('#vNext .cdn'); if (cdn) cdn.textContent = 'Autoplay stopped for this one.'; b.remove(); break;
      case 'auto-toggle': prefs.autoNext = prefs.autoNext === false; savePrefs(); b.textContent = 'Autoplay next: ' + (prefs.autoNext === false ? 'off' : 'on'); if (prefs.autoNext === false) { clearTimeout(nextTimer); var cd2 = $('#vNext .cdn'); if (cd2) cd2.textContent = ''; } break;
      case 'course-open':
        openC = openC === id ? null : id; confirmCourse = null;
        if (openC && !cs.items(id).length && !cs.status(id).loading && (feedsOn || prefs.apiKey)) cs.load(id, true).then(renderAll);
        renderAll(); break;
      case 'ep-play': if (Date.now() < cSwallowUntil) break; playEp(id, b.getAttribute('data-v')); break;
      case 'ep-tick': if (Date.now() < cSwallowUntil) break; setTick(id, b.getAttribute('data-v'), !cs.isDone(id, b.getAttribute('data-v'))); break;
      case 'course-earlier': case 'course-later': var cw2 = cwin[id] || (cwin[id] = { b: 2, a: 3 }); if (act === 'course-earlier') cw2.b += 10; else cw2.a += 10; renderAll(); break;
      case 'course-grid': cgrid[id] = !cgrid[id]; renderAll(); break;
      case 'course-place': cplace[id] = !cplace[id]; renderAll(); if (cplace[id]) setTimeout(function () { var inp = document.getElementById('pl-' + id); if (inp) inp.focus(); }, 30); break;
      case 'course-pin-no':
        var pf = b.closest('.cplace'), pn = parseInt(pf && pf.querySelector('input').value, 10), pc2 = cs.get(id), ph = pn ? cs.findNumber(id, pn) : [];
        if (!ph.length) { toast(pn ? 'No episode ' + pn + ' in ' + pc2.name + '. Check the number in the video title.' : 'Type the episode number first, like 1607.', 'warn'); break; }
        var pv = cs.items(id)[ph[0]].id, pon = !pc2.pins[pv]; cs.pin(id, pv, pon); cplace[id] = false; renderAll();
        toast(pon ? 'Pinned ‼ ' + pn + '. It stays on ' + pc2.name + '\'s row.' : 'Unpinned ' + pn + '.'); break;
      case 'course-remove':
        if (confirmCourse !== id) { confirmCourse = id; renderAll(); break; }
        cs.remove(id); confirmCourse = null; openC = null; renderAll(); toast('Removed. Its ticks come back if you add it again.'); break;
      case 'course-retry': cs.load(id, true).then(function () { renderAll(); updateDot(); }); renderAll(); toast('Loading the playlist…'); break;
      case 'course-back': closeVideo(); openCourses(id); break;
      case 'add-course': openCourseAdd('', id, b.getAttribute('data-fix') || ''); break;
      case 'course-sec': cAddSec = id; Array.prototype.forEach.call(document.querySelectorAll('#courseSec button'), function (x) { x.setAttribute('aria-pressed', String(x === b)); }); break;
      case 'course-pick':
        $('#courseInput').value = 'https://www.youtube.com/playlist?list=' + b.getAttribute('data-pl');
        if (!$('#courseName').value.trim() || $('#courseName').getAttribute('data-auto') === '1') { $('#courseName').value = Courses.shortName(b.getAttribute('data-t')); $('#courseName').setAttribute('data-auto', '1'); }
        $('#coursePicks').innerHTML = '<span class="small">Picked: ' + esc(b.getAttribute('data-t')) + '. Tap Add.</span>'; break;
      case 'v-toggle': try { if (player.getPlayerState() === 1) player.pauseVideo(); else player.playVideo(); } catch (er) {} break;
      case 'v-back': case 'v-fwd': try { player.seekTo(Math.max(0, player.getCurrentTime() + (act === 'v-back' ? -15 : 15)), true); videoTick(); } catch (er) {} break;
      case 'timer': if (held) { held = false; break; } setTimer(b.getAttribute('data-p'), b.getAttribute('data-m')); break;
      case 'open-night': nightOpen = true; openSheet('#nsheet'); renderAudio(); break;
      case 'close-night': closeNight(); break;
      case 'audio-toggle': engine.toggle(); break;
      case 'a-back': engine.seekBy(-engine.BACK); break;
      case 'a-fwd': engine.seekBy(engine.FWD); break;
      case 'a-rate': var ast = engine.state(), nr = RATES[(RATES.indexOf(ast.rate) + 1) % RATES.length]; engine.setRate(nr); if (ast.episode) { prefs.rates = prefs.rates || {}; prefs.rates[podKey(ast.episode.guid)] = nr; savePrefs(); } break;
      case 'check': openCheck(); break;
      case 'look': $('#lookMsg').textContent = ''; $('#lookDlg [data-act="look-here"]').hidden = Native.inApp && !Native.canLocate; fillLook(); openDlg($('#lookDlg')); break;
      case 'look-set': prefs.look = id; savePrefs(); applyLook(); fillLook(); break;
      case 'look-here': lookHere(); break;
      case 'dismiss': var d = b.closest('dialog'); if (d) d.close(); break;
      case 'settings': $('#checkDlg').close(); $('#keyInput').value = prefs.apiKey || ''; $('#keyMsg').textContent = ''; openDlg($('#keyDlg')); break;
      case 'key-remove': delete prefs.apiKey; savePrefs(); $('#keyInput').value = ''; $('#keyMsg').textContent = 'Removed. Search reads YouTube\'s results page.'; $('#keyMsg').className = 'msgline ok'; break;
      case 'send': copyShelf(b); break;
      case 'yt-sign': signInYT(b); break;
      case 'yt-settings': Native.openSettings().catch(function () { toast("Open the iPhone's Settings app, scroll down to Shelf, and turn on Allow Cross-Website Tracking.", 'warn'); }); break;
      case 'phone-retry': if (navigator.onLine === false) { toast("You're offline. Reconnect, then tap Try again.", 'warn'); break; } b.textContent = 'Reopening…'; capture(true); if (engine) engine.capture(true); setTimeout(function () { location.reload(); }, 300); break; // a fresh start reads the phone's copy again and merges it
      case 'tone':
        if (Native.tonePlaying) { Native.stopTone(); if (engine) engine.session(); fillCheck(); return; }
        if (engine.state().playing) engine.pause();
        if (current) closeVideo();
        Native.playTone().then(function () { fillCheck(); toast('Now lock your phone for 10 seconds, then come back.'); },
          function () { toast("The sound test couldn't start. Turn the volume up and try again.", 'warn'); });
        break;
    }
  });
  // A tap or a drag on a time line seeks (pointer events, above). Space or Enter on it does nothing (a keyboard "click"
  // has no position); the arrow keys step back and forward instead (the line is a slider for VoiceOver and keyboards).
  function scrubKeys(el, fwd, step) { // same steps as the player's own buttons: back 15 s, forward 15 s (video) or 30 s (podcast)
    el.addEventListener('keydown', function (ev) {
      var d = { ArrowLeft: -15, ArrowDown: -15, ArrowRight: fwd, ArrowUp: fwd }[ev.key];
      if (d != null) { ev.preventDefault(); step(d); }
    });
  }
  function scrubAria(el, t, d) { el.setAttribute('aria-valuemin', '0'); el.setAttribute('aria-valuemax', String(Math.round(d || 0))); el.setAttribute('aria-valuenow', String(Math.round(t || 0))); el.setAttribute('aria-valuetext', Core.fmt(t || 0) + (d ? ' of ' + Core.fmt(d) : '')); }
  // Play locked ↗ opens the video in the YouTube app at the spot playing now, where Premium keeps playing with
  // the phone locked (YouTube stops its embedded player in the background). In the iPhone app it uses the
  // youtube:// address, so iOS can't send it to Safari instead (Safari pauses on lock too); if no app opens
  // within 1.5 s, the web page opens. Back in Shelf, the place moves on by the time spent away (see catchUp).
  // YouTube's links can't set its speed, so whenever this video's speed differs from the one YouTube was last set to,
  // a sheet says to set YouTube to the same speed (it usually keeps it); the catch-up counts the time away at that speed.
  var appFallback = null, pendingHand = null;
  function handTarget() {
    var v = current && videos[current]; if (!v) return null;
    var t = v.t || 0; // the spot playing now (after a Mark, the saved spot can be further on)
    try { var pt = player.getCurrentTime(); if (armed && typeof pt === 'number' && pt > 0) t = pt; } catch (e) {}
    var web = ytLink({ id: v.id, t: t, done: v.done }), app = web.replace(/^https:/, 'youtube:');
    // Auto-lock on: the "Shelf Play Locked" iPhone Shortcut opens YouTube, waits, then locks the phone (apps can't lock it themselves)
    var href = !Native.inApp ? web : prefs.autoLock ? 'shortcuts://run-shortcut?name=' + encodeURIComponent(LOCK_SHORTCUT) + '&input=text&text=' + encodeURIComponent(app) : app;
    return { v: v, t: t, web: web, href: href, rate: wantRate || 1 };
  }
  function handOff(h) {
    clearTimeout(appFallback);
    if (Native.inApp && !prefs.autoLock) appFallback = setTimeout(function () { if (document.visibilityState === 'visible') window.open(h.web, '_blank'); }, 1500);
    try { player.pauseVideo(); } catch (e) {}
    rawSet(HAND_KEY, JSON.stringify({ id: h.v.id, t: h.t, at: Date.now(), rate: h.rate }), false);
  }
  function rateTxt(r) { return r + '×'; }
  $('#ytLink').addEventListener('click', function (e) {
    capture(true); var h = handTarget(); if (!h) { e.preventDefault(); return; }
    this.href = h.href;
    if ((prefs.ytRate || 1) !== h.rate) {
      e.preventDefault(); pendingHand = h;
      Array.prototype.forEach.call(document.querySelectorAll('.rateNow'), function (el) { el.textContent = rateTxt(h.rate); });
      $('#rateGo').href = h.href;
      try { player.pauseVideo(); } catch (e2) {}
      openDlg($('#rateDlg'));
      return;
    }
    handOff(h);
  });
  $('#rateGo').addEventListener('click', function () {
    var h = pendingHand; pendingHand = null; $('#rateDlg').close();
    if (!h) return;
    prefs.ytRate = h.rate; savePrefs();
    handOff(h);
  });
  scrubKeys($('#vScrub'), 15, function (s) { try { player.seekTo(Math.max(0, player.getCurrentTime() + s), true); videoTick(); } catch (e) {} });
  scrubKeys($('#nScrub'), 30, function (s) { engine.seekBy(s); });
  scrubDrag($('#vScrub'), 'v', function () { try { return player && current ? player.getDuration() : 0; } catch (e) { return 0; } }, function () { return wantRate; }, function (t) { try { player.seekTo(t, true); } catch (e) {} videoTick(); });
  scrubDrag($('#nScrub'), 'n', function () { return engine ? engine.state().dur : 0; }, function () { return engine.state().rate; }, function (t) { engine.seek(t); renderAudio(); });
  // Swipe down on the grabber or the top bar closes a player or a sheet
  sheetSwipe($('#vsheet'), '.grab,.sh-top', function () { closeVideo(); });
  sheetSwipe($('#nsheet'), '.grab,.sh-top', function () { closeNight(); });
  Array.prototype.forEach.call(document.querySelectorAll('dialog'), function (d) { sheetSwipe(d, '.grab,.dh', function () { d.close(); }); });
  $('#aiKeyForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var k = $('#aiKeyInput').value.trim(), msg = $('#aiKeyMsg');
    if (!k) { msg.textContent = 'Paste the key first.'; msg.className = 'msgline err'; return; }
    // Any shape Google uses: the test call with Google decides whether it works
    k = k.replace(/\s+/g, '').replace(/^["']|["']$/g, ''); $('#aiKeyInput').value = k;
    if (k.length < 20) { msg.textContent = 'That\'s too short to be a key. Copy the whole key and paste it again.'; msg.className = 'msgline err'; return; }
    setAiKey(k); msg.textContent = 'Checking it with Google…'; msg.className = 'msgline';
    testAi().then(function () {
      if (aiHealth.state === 'ok') { $('#aiKeyDlg').close(); toast('Gemini key works. Summaries are on.'); autoSummaries(); }
      else if (aiHealth.state === 'offline') { msg.textContent = 'Saved. No internet to check it right now.'; msg.className = 'msgline'; }
      else { msg.textContent = aiHealth.msg; msg.className = 'msgline err'; }
    });
  });
  $('#keyForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var k = $('#keyInput').value.trim();
    k = k.replace(/\s+/g, '').replace(/^["']|["']$/g, '');
    if (k && k.length < 20) { $('#keyMsg').textContent = 'That\'s too short to be a key. Copy the whole key and paste it again.'; $('#keyMsg').className = 'msgline err'; return; }
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

  // ---------- Day or night look ----------
  // Auto (the default): light from an hour after sunrise, dark from an hour before sunset, by the sun where Mo is
  // (the town he typed, or his location, otherwise London). Light and Dark stay put. In the app, when Shelf's look
  // differs from the iPhone's own, the strip under the clock takes the iPhone's colours so the time stays readable.
  var LONDON = { name: 'London', lat: 51.5074, lon: -0.1278 }, lookTimer = null;
  var sysDark = (function () { try { return matchMedia('(prefers-color-scheme: dark)'); } catch (e) { return null; } })();
  // Tests set window.__hour (today at that hour) and window.__look
  function nowMs() { if (typeof window.__hour !== 'number') return Date.now(); var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() + window.__hour * 36e5; }
  function lookPlace() { var l = prefs.loc; return l && isFinite(l.lat) && isFinite(l.lon) && l.name ? l : LONDON; }
  function lookMode() { var m = typeof window.__look === 'string' ? window.__look : prefs.look; return m === 'light' || m === 'dark' ? m : 'auto'; }
  function lookState() {
    var pl = lookPlace(), t = nowMs(), sun = Core.sunLook(t, pl.lat, pl.lon), mode = lookMode();
    return { mode: mode, light: mode === 'auto' ? sun.light : mode === 'light', sun: sun, place: pl, t: t };
  }
  function applyLook() {
    if (!prefs) return;
    var st = lookState(), theme = st.light ? 'light' : 'dark', root = document.documentElement, phoneDark = !!(sysDark && sysDark.matches);
    if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme);
    // Kept for the next launch's first paint, with the time it stops being right (Auto only)
    try { localStorage.setItem('shelf.look', JSON.stringify({ t: theme, u: st.mode === 'auto' ? st.sun.next : 0, app: Native.inApp && !Native.device ? 1 : 0 })); } catch (e) {}
    root.classList.toggle('app', Native.inApp && !Native.device); root.classList.toggle('ph-dark', phoneDark); root.classList.toggle('ph-light', !phoneDark);
    statusBar();
    Array.prototype.forEach.call(document.querySelectorAll('meta[name="theme-color"]'), function (m) { m.setAttribute('content', theme === 'light' ? '#FFFFFF' : '#0A0A0E'); });
    var b = $('#lookBtn');
    if (b.getAttribute('data-g') !== theme) { b.innerHTML = theme === 'light' ? I.sun : I.moon; b.setAttribute('data-g', theme); }
    b.setAttribute('aria-label', 'Look: ' + theme + (st.mode === 'auto' ? ', by the sun' : '') + '. Change it.');
    // Wake up for the next change (and at least every half hour, as timers sleep while the phone does)
    clearTimeout(lookTimer);
    if (st.mode === 'auto') lookTimer = setTimeout(applyLook, Math.max(1000, Math.min(st.sun.next - st.t + 1000, 30 * 60000)));
    if ($('#lookDlg').open) fillLook();
  }
  // In shells from 6 Oct 2026 the clock itself changes colour: dark on the light look, white on the dark look and over the players
  function statusBar() { if (Native.device) Native.statusBar(document.body.classList.contains('sheet-on') || document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }
  function sameDay(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }
  function fillLook() {
    var st = lookState(), s = st.sun;
    Array.prototype.forEach.call(document.querySelectorAll('#lookPicks button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-id') === st.mode)); });
    var when, at = function (t) { return esc(clockText(t)); };
    if (st.mode !== 'auto') when = (st.light ? 'Light' : 'Dark') + ' all the time.';
    else if (s.to <= s.from && !st.light) when = 'Dark all day today: the sun is up for under two hours.';
    else if (st.light) when = 'Light until ' + at(s.next) + ', then dark.';
    else when = 'Dark until ' + at(s.next) + (sameDay(s.next, st.t) ? '' : ' tomorrow') + ', then light.';
    $('#lookWhen').innerHTML = when;
    $('#lookRule').textContent = 'Auto is light from an hour after sunrise to an hour before sunset' + (s.to > s.from ? ': ' + clockText(s.from) + ' to ' + clockText(s.to) + ' today.' : '.');
    $('#lookWhere').textContent = 'Sun times for ' + st.place.name;
  }
  function setPlace(pl) { prefs.loc = pl; savePrefs(); applyLook(); fillLook(); }
  // A town typed in the sheet: Open-Meteo's free place search (no key), British places first
  $('#lookForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = $('#lookTown').value.trim(), msg = $('#lookMsg');
    if (!q) { msg.textContent = 'Type your town first.'; msg.className = 'msgline err'; return; }
    msg.textContent = 'Looking it up…'; msg.className = 'msgline';
    get('https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=' + encodeURIComponent(q)).then(function (r) {
      var list = []; try { list = JSON.parse(r.text).results || []; } catch (er) {}
      var hit = list.filter(function (x) { return x.country_code === 'GB'; })[0] || list[0];
      if (!r.ok) { msg.textContent = "Couldn't look it up: the place search said " + r.status + '. Try again later.'; msg.className = 'msgline err'; return; }
      if (!hit || !isFinite(hit.latitude) || !isFinite(hit.longitude)) { msg.textContent = 'No town called "' + q + '" found. Try the nearest bigger town.'; msg.className = 'msgline err'; return; }
      setPlace({ name: String(hit.name).slice(0, 40), lat: Math.round(hit.latitude * 100) / 100, lon: Math.round(hit.longitude * 100) / 100 });
      msg.textContent = 'Using ' + hit.name + (hit.admin1 ? ', ' + hit.admin1 : '') + '.'; msg.className = 'msgline ok';
      $('#lookTown').value = '';
    }, function (er) { msg.textContent = (er && er.message) || "Couldn't look it up. Check your internet."; msg.className = 'msgline err'; });
  });
  function lookHere() {
    var msg = $('#lookMsg');
    var no = function (why) { msg.textContent = why + ' Type your town instead.'; msg.className = 'msgline err'; };
    if (Native.device) {
      msg.textContent = 'Asking where you are…'; msg.className = 'msgline';
      return Native.locate().then(function (p) {
        setPlace({ name: 'your location', lat: Math.round(p.lat * 100) / 100, lon: Math.round(p.lon * 100) / 100 });
        msg.textContent = 'Using your location.'; msg.className = 'msgline ok';
      }, function (er) { msg.textContent = ((er && er.message) || "Couldn't get your location.") + ' Or type your town.'; msg.className = 'msgline err'; });
    }
    if (!navigator.geolocation) return no("This phone won't share its location with Shelf.");
    msg.textContent = 'Asking where you are…'; msg.className = 'msgline';
    try {
      navigator.geolocation.getCurrentPosition(function (p) {
        setPlace({ name: 'your location', lat: Math.round(p.coords.latitude * 100) / 100, lon: Math.round(p.coords.longitude * 100) / 100 });
        msg.textContent = 'Using your location.'; msg.className = 'msgline ok';
      }, function (er) {
        no(er && er.code === 1 ? (Native.inApp ? "The Shelf app isn't allowed to use location." : 'Location is turned off for this page.') : "Couldn't get your location.");
      }, { timeout: 10000, maximumAge: 864e5 });
    } catch (er) { no("Couldn't get your location."); }
  }
  if (sysDark && sysDark.addEventListener) sysDark.addEventListener('change', function () { applyLook(); });
  function lookCheck() {
    var st = lookState(), pl = st.place === LONDON && !prefs.loc ? "London's sun times (set your town with the sun button)" : st.place.name + "'s sun times";
    return { ok: 1, text: st.mode === 'auto' ? 'Look: ' + (st.light ? 'light' : 'dark') + ' by the sun, using ' + pl : 'Look: ' + st.mode + ' all the time (tap the sun button for Auto)' };
  }

  // ---------- Toast ----------
  var toastTimer = null;
  function toast(msg, kind, action, ms) {
    var t = $('#toast');
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button type="button">' + esc(action.label) + '</button>' : '');
    if (action) t.querySelector('button').onclick = function () { action.fn(); t.className = 'toast'; };
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast'; }, ms || (action ? 6000 : 4000));
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
      var srcs = lib.sources(), failed = srcs.filter(function (s) { var st = lib.status(s.id); return st && !st.ok && !brokenDup(s); });
      if (refreshing) out.push({ ok: 2, text: 'Checking your channels for new uploads…' });
      else if (srcs.length && failed.length === srcs.length) out.push({ ok: 0, text: "Couldn't check any of your channels. Check your internet, then tap the date at the top to try again." });
      else if (failed.length) out.push({ ok: 0, text: "Couldn't update " + failed.map(function (s) { return s.name + ' (' + lib.status(s.id).error + ')'; }).join(', ') + '. Open the channel and tap Refresh.' });
      else if (srcs.length) out.push({ ok: 1, text: 'Checked ' + srcs.length + ' channels for new uploads' + (lastRefresh ? ' ' + Core.ago(lastRefresh) : '') });
    } else out.push({ ok: 1, text: 'Channels and new uploads load in the Shelf app on your iPhone; here you can paste and resume' });
    if (cs && cs.list().length && (feedsOn || prefs.apiKey)) {
      var cbad = cs.list().filter(function (c) { return !cs.status(c.id).ok; });
      if (cs.busy) out.push({ ok: 2, text: 'Loading your courses…' });
      else if (cbad.length) out.push({ ok: 0, text: "Couldn't load " + cbad.map(function (c) { return c.name; }).join(', ') + ' from YouTube. Open Courses and tap Retry; your ticks are safe.' });
      else out.push({ ok: 1, text: 'Tracking ' + cs.list().length + (cs.list().length === 1 ? ' course' : ' courses') + ' episode by episode' });
    }
    out.push({ ok: 1, text: prefs.apiKey ? 'Search uses your Google key' : 'Search reads YouTube\'s results page (no key needed)' });
    out.push(aiCheck());
    out.push(lookCheck());
    if (Native.inApp) {
      out.push({ ok: 1, text: 'Running inside the Shelf app' });
      out.push({ ok: 1, text: prefs.autoLock ? 'Play locked locks the phone by itself (Shortcut "' + LOCK_SHORTCUT + '")' : 'Play locked: the phone can lock by itself with a one-time Shortcut', fix: 'lock' });
      var ya = Native.ytAccount.state;
      out.push(ya === 'in' ? { ok: 1, text: 'Signed in to YouTube. With "Allow Cross-Website Tracking" on for Shelf (iPhone Settings for Shelf, below), the player uses your Premium. If ads still show, Play locked ↗ in the player opens the video in the YouTube app.' }
        : ya === 'out' ? { ok: 0, text: 'Not signed in to YouTube, so videos play with ads even with Premium.', fix: 'yt' }
        : ya === 'old' ? { ok: 0, text: "This copy of the Shelf app is older than the website, so it can't sign in to YouTube yet. On your Mac, run the installer again." }
        : ya === 'wait' ? { ok: 2, text: 'Checking your YouTube sign-in…' }
        : { ok: 0, text: "Couldn't check your YouTube sign-in. Close and reopen Shelf." });
      if (!Native.device) out.push({ ok: 1, text: 'An app update is ready: plug in your iPhone and run the install command again for the screen staying on during videos, Sleep dim and the clock colour' });
      if (!restored) out.push({ ok: 0, text: "The phone's storage didn't answer at start, so nothing is being backed up to it (your spots, ticks and channels stay in Shelf for now).", fix: 'retry' });
      if (Native.prefError) out.push({ ok: 0, text: "The phone's storage refused a save. Close and reopen Shelf; your last saved spots are kept." });
      var fs = Native.feedStatus;
      out.push(fs.state === 'ok' ? { ok: 1, text: fs.text } : fs.state === 'bad' ? { ok: 0, text: fs.text } : { ok: 2, text: 'Checking podcast feeds…' });
      var tr = Native.toneResult;
      out.push(Native.tonePlaying ? { ok: 2, text: 'Sound test playing. Lock your phone for 10 seconds, then come back.' }
        : !tr ? { ok: 1, text: 'Lock-screen sound: optional Sound test below (tap it, lock the phone for 10 seconds, come back)' }
        : tr.ok ? { ok: 1, text: 'Sound keeps playing on the lock screen' }
        : { ok: 0, text: 'Sound stopped when the screen locked. The app shell needs a fix and a rebuild in Xcode; tell Claude.' });
    }
    var n = Object.keys(videos).length + Object.keys(arec).length, ch = lib.sources().length;
    out.push({ ok: 1, text: ch + ' channel' + (ch === 1 ? '' : 's') + ' in ' + lib.sections().length + ' sections, ' + n + ' saved spot' + (n === 1 ? '' : 's') + ', kept ' + (Native.inApp ? 'on this phone' : 'in this browser') });
    return out;
  }
  var checkedAt = 0;
  function verdictOf(c) {
    var bad = c.filter(function (x) { return x.ok === 0; }), wait = c.some(function (x) { return x.ok === 2; });
    return { bad: bad, state: bad.length ? 'bad' : wait ? 'wait' : 'good',
      label: bad.length ? (bad.length === 1 ? 'One thing to fix' : bad.length + ' things to fix') : wait ? 'Getting ready' : 'All good' };
  }
  function updateDot() {
    var c = checks(), vd = verdictOf(c), btn = $('#statusBtn'), txt = $('#statusText');
    $('#statusDot').className = 'dot ' + vd.state;
    // Just the coloured square: green, amber while starting, red when something needs a look
    txt.textContent = vd.state === 'bad' ? (vd.bad.length === 1 ? '1 problem' : vd.bad.length + ' problems') : vd.label;
    txt.className = 'sr';
    checkedAt = Date.now();
    btn.setAttribute('aria-label', 'Self-check: ' + vd.label + '. Show details.');
    if ($('#checkDlg').open) fillCheck();
  }
  function fixBtn(kind) {
    var ya = Native.ytAccount.state;
    if (kind === 'yt') return '<button type="button" class="fix" id="ytBtn" data-act="yt-sign">' + (signingIn ? 'Signing in…' : ya === 'in' ? 'Sign out of YouTube' : 'Sign in to YouTube') + '</button>';
    if (kind === 'ai-key') return '<button type="button" class="fix" data-act="ai-key">' + (aiKey ? 'Gemini key' : 'Add Gemini key') + '</button>';
    if (kind === 'lock') return '<button type="button" class="fix" data-act="lock-setup">Auto-lock</button>';
    if (kind === 'retry') return '<button type="button" class="fix" id="retryBtn" data-act="phone-retry">Try again</button>';
    return '';
  }
  function fillCheck() {
    var c = checks(), vd = verdictOf(c), d = new Date(checkedAt || Date.now());
    var ok = c.filter(function (x) { return x.ok === 1; }).length;
    $('#checkVerdict').className = 'verdict ' + vd.state;
    $('#checkVerdict').innerHTML = '<i></i><span><b>' + esc(vd.label) + '</b><small class="mono">' + ok + ' of ' + c.length + ' checks passed · ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + '</small></span>';
    // Only what's wrong (or still loading), each with its fix
    $('#checkProblems').innerHTML = c.filter(function (x) { return x.ok !== 1; }).map(function (x) {
      return '<div class="prob' + (x.ok === 2 ? ' wait' : '') + '"><span class="ic" aria-hidden="true">' + (x.ok === 2 ? '…' : '!') + '</span><span>' + esc(x.text) + (x.fix ? '<br>' + fixBtn(x.fix) : '') + '</span></div>';
    }).join('');
    var ya = Native.ytAccount.state, signIn = Native.inApp && ya !== 'old', acts = '';
    if (Native.inApp) acts += '<button type="button" class="ghost" id="toneBtn" data-act="tone">' + (Native.tonePlaying ? 'Stop the sound test' : 'Sound test') + '</button>';
    acts += '<button type="button" class="ghost" id="sendBtn" data-act="send">Copy shelf link</button>';
    if (signIn && ya === 'in') acts += '<button type="button" class="ghost" id="ytBtn" data-act="yt-sign">' + (signingIn ? 'Signing in…' : 'Sign out of YouTube') + '</button>';
    $('#checkActs').innerHTML = acts;
    $('#trackBtn').hidden = !signIn; $('#aiKeyBtn').hidden = !Native.inApp;
    $('#checkAllSum').textContent = 'Show all ' + c.length + ' checks';
    $('#checkList').innerHTML = c.map(function (x) {
      return '<li class="' + (x.ok === 1 ? 'ok' : x.ok === 2 ? 'wait' : 'bad') + '"><span class="ic" aria-hidden="true">' + (x.ok === 1 ? '✓' : x.ok === 2 ? '…' : '!') + '</span><span>' + esc(x.text) + (x.fix === 'ai-key' && x.ok === 1 && !aiKey ? '<br>' + fixBtn(x.fix) : '') + '</span></li>';
    }).join('');
  }
  var signingIn = false;
  function signInYT(b) {
    if (signingIn) return;
    if (Native.ytAccount.state === 'in') {
      Native.signOutYT().then(function () { fillCheck(); updateDot(); toast('Signed out of YouTube.'); }, function () { toast("Couldn't sign out. Close and reopen Shelf.", 'warn'); });
      return;
    }
    signingIn = true; b.textContent = 'Signing in…'; fillCheck();
    Native.signInYT().then(function (a) {
      signingIn = false; fillCheck(); updateDot();
      // The player was made before the sign-in: a fresh page gives YouTube a player that knows the account
      if (a.state === 'in') { toast('Signed in to YouTube. Reloading so the player notices…'); setTimeout(function () { location.reload(); }, 900); }
      else toast("Google didn't finish signing you in. Videos still play; for Premium without ads, open them in the YouTube app (Play locked ↗ in the player).", 'warn');
    }, function () { signingIn = false; fillCheck(); toast("Couldn't open the sign-in page. Close and reopen Shelf.", 'warn'); });
  }
  function openCheck() { updateDot(); fillCheck(); openDlg($('#checkDlg')); }

  // ---------- Shelf link (spots to another device) ----------
  function copyShelf(btn) {
    capture(true);
    var link = location.origin + location.pathname + '#shelf=' + Core.encodeShelf(videos);
    copyText(link, function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy shelf link'; }, 2000); toast(isPhone ? 'Copied. Send it to your Mac and open it in Safari.' : 'Copied. Send it to your iPhone and paste it into Search in Shelf.'); });
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
  var restored = false, restoreFailed = false;
  function parseOr(s, bad) { try { var v = JSON.parse(s); return v && typeof v === 'object' ? v : bad; } catch (e) { return bad; } }
  // Which channel list to keep. Copies of the same list (same born): the one with more saves wins, and on a tie of
  // two copies from before save counting the phone's (it was written first). Two different lists: the older one,
  // since a list started from scratch while the phone couldn't be read must not replace the real one.
  function pickLibrary(web, phone) {
    if (!phone) return null; if (!web) return phone;
    if (web.born !== phone.born) return (phone.born || 0) < (web.born || 0) ? phone : null;
    var wr = web.rev || 0, pr = phone.rev || 0;
    return pr > wr || (pr === wr && !wr) ? phone : null;
  }
  function restoreFromPhone(wait) {
    if (!Native.inApp) return Promise.resolve();
    var keys = PHONE_KEYS();
    wait = wait || 2000;
    return withTimeout(Promise.all(keys.map(Native.prefGet)), wait, 'slow').then(function (r) {
      // Read and check everything first; a damaged phone record is ignored (the web copy then replaces it).
      // Nothing in here may throw: an exception would stop boot() and leave Home blank with no way out.
      try {
        var BAD = {}, ph = r.map(function (x) { return x == null ? null : parseOr(x, BAD); });
        ph = ph.map(function (x) { return x === BAD ? null : x; });
        var writes = [];
        if (ph[0]) { var m = Core.merge(load(KEY, {}), records(ph[0])); if (m.added || m.updated || !rawGet(KEY)) writes.push([KEY, JSON.stringify(m.videos)]); }
        if (ph[1] && !rawGet(PREF)) writes.push([PREF, r[1]]);
        if (ph[2]) { var la = load(AKEY, {}), pa = records(ph[2]); Object.keys(pa).forEach(function (g) { if (!la[g] || (pa[g].updated || 0) > (la[g].updated || 0)) la[g] = pa[g]; }); writes.push([AKEY, JSON.stringify(la)]); }
        if (ph[3] && pickLibrary(load(Library.KEY, null), ph[3])) writes.push([Library.KEY, r[3]]);
        if (ph[4]) { var lc = load(Courses.KEY, null); if (!lc || (ph[4].saved || 0) > (lc.saved || 0)) writes.push([Courses.KEY, r[4]]); }
        if (ph[5]) { var lm = load(Marks.KEY, null); if (!lm || (ph[5].saved || 0) > (lm.saved || 0)) writes.push([Marks.KEY, r[5]]); }
        if (ph[6]) { var lg = load(AI.KEY, null); if (!lg || (ph[6].saved || 0) > (lg.saved || 0)) writes.push([AI.KEY, r[6]]); }
        writes.forEach(function (w) { rawSet(w[0], w[1], false); });
        restored = true; restoreFailed = false;
      } catch (e) { restoreFailed = true; }
    }, function () { if (wait < 6000) return restoreFromPhone(6000); restoreFailed = true; }); // slow phone: one longer try, then a Try again in the self-check
  }
  // Only entries shaped like records (a null or stray value in a phone copy is dropped, not merged)
  function records(o) { var out = {}; if (o && typeof o === 'object' && !Array.isArray(o)) Object.keys(o).forEach(function (k) { if (o[k] && typeof o[k] === 'object') out[k] = o[k]; }); return out; }
  function boot() {
    videos = load(KEY, {}); prefs = load(PREF, {}); arec = load(AKEY, {});
    // Step 2 CK is on 22 Dec (an early default said 30 Nov): a goal saved with that old date moves to the real one
    if (prefs.goal && prefs.goal.date === '2026-11-30' && /step\s*2/i.test(prefs.goal.name || '')) { prefs.goal.date = '2026-12-22'; savePrefs(); }
    applyGoal(); applyLook();
    lib = Library.create({
      load: rawGet,
      save: function (k, v) { rawSet(k, v, k === Library.KEY); }, // the feed cache stays in the web view; the library itself is mirrored to the phone
      fetchText: fetchText
    });
    cs = Courses.create({
      load: rawGet,
      save: function (k, v) { rawSet(k, v, k === Courses.KEY); }, // ticks go to the phone too; the episode lists stay here
      fetchText: fetchText, postJSON: postJSON, now: function () { return Date.now(); },
      apiKey: function () { return prefs.apiKey || ''; },
      watched: function (vid) { return !!(videos[vid] && videos[vid].done); }
    });
    // Keep the phone's copy complete even before anything changes
    // Only after the phone's copy was read and merged, so a slow or empty start can't overwrite it
    if (Native.inApp && restored) PHONE_KEYS().forEach(function (k) { var v = rawGet(k); if (v) Native.prefSet(k, v); });
    marks = Marks.create({ load: rawGet, save: function (k, v) { rawSet(k, v); } });
    ai = AI.create({ load: rawGet, save: function (k, v) { rawSet(k, v); }, now: function () { return Date.now(); }, key: function () { return aiKey; }, post: aiPost, onChange: renderAiSoon });
    if (Native.inApp) Native.prefGet(AI.KEY_PREF).then(function (k) { aiKey = k || ''; testAi(); updateDot(); if (lastRefresh) autoSummaries(); }, function () {});
    if (restoreFailed) setTimeout(function () { toast("The phone's storage didn't answer, so changes aren't backed up to it yet. Tap the self-check to try again.", 'warn'); }, 800);
    buildSeg('#vSeg', 'v'); buildSeg('#nSeg', 'a'); buildRates();
    initAudio();
    var m = location.hash.match(/^#shelf=([A-Za-z0-9_-]+)/);
    if (m) { importShelf(m[1]); try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
    renderHome(); renderAudio(); renderTabs();
    loadYT();
    updateDot();
    if (Native.inApp) Native.checkYT().then(updateDot); // the corner turns green as soon as the sign-in is known
    setInterval(updateDot, 5000);
    setInterval(function () { if (document.visibilityState === 'visible') applyLook(); if (!stack.length && document.visibilityState === 'visible') keepTyping(renderHome); }, 60000);
    window.addEventListener('online', function () { updateDot(); if (ai) ai.retryHeld(); }); window.addEventListener('offline', updateDot);
    if (!canSave && !Native.inApp) setTimeout(function () { toast('Your browser is blocking saving, so nothing will be remembered. Tap the self-check for how to fix it.', 'warn'); }, 600);
    refreshAll(false);
    catchUp(); // Shelf was closed by iOS while the video played in YouTube
    // Test hook
    window.__shelf = { get videos() { return videos; }, get audio() { return arec; }, get lib() { return lib; }, get engine() { return engine; }, checks: checks, capture: capture, catchUp: catchUp,
      get current() { return current; }, get vTimer() { return vTimer; }, get marks() { return marks; }, get prefs() { return prefs; }, refreshAll: refreshAll, handleText: handleText, get stack() { return stack; }, get courses() { return cs; }, get ai() { return ai; }, get twins() { return twins; }, syncTwin: syncTwin, applyLook: applyLook, lookState: lookState, idle: function () { touchedAt = 0; videoTick(); }, get busy() { return refreshing || cs.busy || !lib.sources().length && feedsOn && !lib.seedMisses.length; } };
  }
  // Home must draw whatever the phone's storage did
  restoreFromPhone().catch(function () { restoreFailed = true; }).then(boot);
})();
