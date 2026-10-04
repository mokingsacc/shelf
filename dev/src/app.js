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
  var PHONE_KEYS = function () { return [KEY, PREF, AKEY, Library.KEY, Courses.KEY, Marks.KEY]; };
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
    Object.keys(arec).forEach(function (g) { var e = entryFromAudio(g, arec[g]); if (started(e) && (sectionId === undefined || e.section === sectionId)) out.push(e); });
    return out.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
  }
  function newCountFor(sectionId) { return feedEntries(sectionId).filter(isNew).length; }
  function srcNewCount(id) { var s = lib.source(id); return s ? itemsOf(s).map(function (it) { return entryFromItem(s, it); }).filter(isNew).length : 0; }
  function thumbOf(e) { return e.type === 'video' ? 'https://i.ytimg.com/vi/' + e.key + '/mqdefault.jpg' : (e.image || ''); }
  // Shorts (and clips under 90 s) stay off the sheet when the channel says so (on unless turned off)
  function hidesShorts(s) { return !!s && s.type !== 'podcast' && s.hideShorts !== false; }
  function isShort(it) { var v = videos[it.id]; return /#shorts?\b/i.test(it.title || '') || !!(v && v.dur > 0 && v.dur < 90); }
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
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  // Day or night: after 21:30 (and until 05:00) Sleep comes first and Continue becomes Bedtime
  function hourNow() { if (typeof window.__hour === 'number') return window.__hour; var d = new Date(); return d.getHours() + d.getMinutes() / 60; }
  function dayPart() { var h = hourNow(); return h >= 21.5 || h < 5 ? 'night' : h >= 18 ? 'evening' : 'day'; }
  function isNight() { return dayPart() === 'night'; }
  function daySections() {
    var secs = lib.sections();
    if (!isNight()) return secs;
    return secs.filter(function (x) { return x.kind === 'audio'; }).concat(secs.filter(function (x) { return x.kind !== 'audio'; }));
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
    return (days ? '<b>' + days + (days === 1 ? ' day' : ' days') + '</b> to Step 2 CK' : '<b>Step 2 CK</b> today') +
      (pc ? ' · ' + esc(c.name) + ' ' + pc.left + ' left' + (pc.perDay ? ' · ' + Courses.perDay(pc.perDay) : '') : td.left ? ' · ' + td.left + ' left · ' + Courses.perDay(td.perDay) : '');
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
      var rest = fresh.length + go.length - list.length, srcs = lib.sources(sec.id).length;
      html += '<section class="band ' + bandClass(sec.id) + '" aria-label="' + esc(sec.name) + '">' +
        '<button type="button" class="hd" data-act="open-section" data-id="' + esc(sec.id) + '"><h2>' + esc(sec.name) + '</h2><span class="tm mono">' +
        (fresh.length ? fresh.length + ' new' : srcs ? srcs + (srcs === 1 ? ' channel' : ' channels') : 'empty') + ' ›</span></button>';
      if (sec.id === Courses.SEED.section) { var sub = examSub(); if (sub) html += '<p class="sub mono">' + sub + '</p>'; }
      if (list.length) html += '<ul>' + list.map(function (e) { return bandRow(e, 'h'); }).join('') + '</ul>';
      else if (!srcs && !feedsOn) html += '<p class="empty">Your channels show here in the Shelf app on your iPhone.</p>';
      else if (!srcs) html += '<p class="empty">No channels yet. <button type="button" data-act="add-channel" data-id="' + esc(sec.id) + '">Add one</button></p>';
      else html += '<p class="empty">' + (refreshing && !lib.sources(sec.id).some(function (s) { return lib.items(s.id).length; }) ? 'Checking for new uploads…' : 'Nothing new. All caught up.') + '</p>';
      if (rest > 0) html += '<button type="button" class="more" data-act="open-section" data-id="' + esc(sec.id) + '"><span>+' + rest + ' more in ' + esc(sec.name) + '</span><span aria-hidden="true">›</span></button>';
      html += '</section>';
    });
    // Pasted videos that belong to no section
    var loose = Object.keys(videos).map(function (id) { return entryFromVideo(videos[id]); }).filter(function (e) { return !e.section && !isDoneE(e); })
      .sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    if (loose.length) {
      html += '<section class="band c0" aria-label="Pasted"><button type="button" class="hd" data-act="open-pasted"><h2>Pasted</h2><span class="tm mono">' + loose.length + ' ›</span></button>' +
        '<ul>' + loose.slice(0, 3).map(function (e) { return bandRow(e, 'h'); }).join('') + '</ul>' +
        (loose.length > 3 ? '<button type="button" class="more" data-act="open-pasted"><span>+' + (loose.length - 3) + ' more pasted</span><span aria-hidden="true">›</span></button>' : '') + '</section>';
    }
    $('#bands').innerHTML = html;
    fitAll($('#bands'));
    // Continue: the most recent unfinished thing anywhere. At night, the last podcast you fell asleep to (Bedtime).
    var all = startedEntries(undefined).concat(Object.keys(videos).map(function (id) { return entryFromVideo(videos[id]); }).filter(started))
      .sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    var top = all[0], bed = night && all.filter(function (e) { return e.type === 'audio'; })[0];
    if (bed) top = bed;
    $('#cont').hidden = !top;
    if (top) {
      var p = prog(top), th = thumbOf(top), img = $('#contImg');
      $('#cont').setAttribute('data-e', regE('h', top));
      $('#cont').setAttribute('data-bed', bed ? '1' : '');
      $('#contThumb').className = 'th' + (top.type === 'audio' ? ' sq' : '');
      if (th) { if (img.getAttribute('src') !== th) { img.hidden = false; img.onerror = function () { this.hidden = true; }; img.src = th; } } else img.hidden = true;
      $('#contLen').hidden = !p.dur; $('#contLen').textContent = p.dur ? Core.fmt(p.dur) : '';
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
    $('#summary').textContent = refreshing ? 'Checking for new uploads…' : allNew + ' new · ' + unfinished + ' unfinished';
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
  window.addEventListener('popstate', function () { if (skipPops) { skipPops--; return; } if (stack.length) pop(); });
  function back() { try { history.back(); } catch (e) { pop(); } }
  // Tabs: Today is Home; Courses and Search each start a fresh page stack
  function goHome() {
    var n = stack.length;
    if (!n) { try { window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }); } catch (e) {} return; }
    stack = []; $('#page').hidden = true; renderHome(); renderTabs();
    skipPops++; try { history.go(-n); } catch (e) { skipPops--; }
  }
  function openTab(view) {
    var v = stack[stack.length - 1];
    if (v && stack.length === 1 && v.name === view.name && v.id === view.id) { $('#page').scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }); return false; }
    stack = []; push(view); return true;
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
  function fold(label, html, n) { return n ? '<details class="fold"><summary><span>' + esc(label) + ' · ' + n + '</span>' + I.down + '</summary>' + html + '</details>' : ''; }
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
      html += topHTML(bandClass(sec.id), sec.name, '<b>' + srcs.length + (srcs.length === 1 ? ' channel' : ' channels') + '</b>' + (nn ? ' · ' + nn + ' new' : '') + (med ? ' · ' + cs.daysLeft() + ' days to Step 2 CK' : ''),
        ib('add-channel', sec.id, I.plus, 'Add channel') + (nn ? ib('seen-section', sec.id, I.check, 'Mark all seen') : '') + (med ? ib('open-marks', null, I.mark, 'Marks') : '') + ib('edit-section', sec.id, I.dots, 'Edit section'));
      lib.seedMisses.filter(function (m) { return m.section === sec.id && !alreadyHave(m.input); }).forEach(function (m) {
        html += '<p class="pnote err">Couldn\'t find ' + esc(m.input) + ' automatically (' + esc(m.error) + ') <button type="button" data-act="fix-seed" data-in="' + esc(m.input) + '" data-id="' + esc(sec.id) + '">Fix</button></p>';
      });
      if (!feedsOn) html += '<p class="pnote">Channels load in the Shelf app on your iPhone.</p>';
      var items = feedEntries(sec.id);
      var have = {}; items.forEach(function (e) { have[e.key] = 1; });
      startedEntries(sec.id).forEach(function (e) { if (!have[e.key]) items.unshift(e); });
      items.sort(function (a, b) { return (started(b) - started(a)) || (started(a) ? (b.updated || 0) - (a.updated || 0) : 0); });
      if (srcs.length && !items.length) html += '<p class="pnote">' + (refreshing ? 'Checking for new uploads…' : 'Nothing here yet. Open a channel below to see its videos.') + '</p>';
      else if (items.length) html += listHTML(items, 'p', null, 'Latest');
      html += '<h2 class="subh"><span>Channels</span><span class="mono">' + srcs.length + '</span></h2>';
      if (!srcs.length) html += '<p class="pnote">No channels here yet. <button type="button" data-act="add-channel" data-id="' + esc(sec.id) + '">Add one</button></p>';
      srcs.forEach(function (s) {
        var st = lib.status(s.id), n = srcNewCount(s.id), hid = hidesShorts(s) ? lib.items(s.id).filter(isShort).length : 0;
        var sub = st && !st.ok ? '<span class="err">Couldn\'t update: ' + esc(st.error) + '</span>' : (n ? n + ' new' : st ? 'Updated ' + esc(Core.ago(st.fetched)) : 'Not checked yet') + (hid ? ' · ' + hid + ' Shorts hidden' : '');
        html += '<button type="button" class="chrow" data-act="open-channel" data-id="' + esc(s.id) + '"><span class="av">' + esc(s.name.charAt(0)) + (s.image ? '<img src="' + esc(s.image) + '" alt="" loading="lazy" onerror="this.remove()">' : '') + '</span>' +
          '<span class="tx"><b>' + esc(s.name) + '</b><small>' + (s.type === 'podcast' ? (s.private ? 'Private podcast · ' : 'Podcast · ') : '') + sub + '</small></span><span class="chev">' + I.chev + '</span></button>';
      });
      html += '<button type="button" class="more" data-act="add-channel" data-id="' + esc(sec.id) + '"><span>+ Add channel</span><span class="mono">a link, @handle or name</span></button>';
    } else if (v.name === 'channel') {
      var s = lib.source(v.id);
      if (!s) { stack.pop(); return renderPage(); }
      var st2 = lib.status(s.id), list = itemsOf(s).map(function (it) { return entryFromItem(s, it); });
      var kind = s.type === 'podcast' ? (s.private ? 'Private podcast' : 'Podcast') : 'YouTube';
      html += topHTML(bandClass(s.section), s.name, st2 && !st2.ok ? '<span class="err">Couldn\'t update: ' + esc(st2.error) + '</span>' : '<b>' + kind + '</b> · latest ' + list.length + (st2 ? ' · updated ' + esc(Core.ago(st2.fetched)) : ''),
        ib('refresh-channel', s.id, I.refresh, 'Check for new uploads') + ib('channel-menu', s.id, I.dots, 'Section, Shorts or remove'));
      if (!list.length) html += '<p class="pnote">' + (st2 && !st2.ok ? 'Nothing loaded. Tap ↻ to try again.' : 'Loading…') + '</p>';
      else html += listHTML(list, 'p', function (e) { return { fresh: chanNew[e.key] }; }, s.type === 'podcast' ? 'Episodes' : 'Videos');
      if (s.type === 'youtube') html += '<p class="pnote">YouTube lists only the latest 15 uploads here. For older ones, use Search.</p>';
    } else if (v.name === 'pasted') {
      var vids = Object.keys(videos).map(function (id) { return entryFromVideo(videos[id]); }).filter(function (e) { return !e.section; })
        .sort(function (a, b) { return (isDoneE(a) - isDoneE(b)) || (b.updated || 0) - (a.updated || 0); });
      html += topHTML('c0', 'Pasted', vids.length + (vids.length === 1 ? ' video' : ' videos') + ' from channels you don\'t follow');
      if (!vids.length) html += '<p class="pnote">Nothing pasted yet.</p>';
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
      if (!v.results && !v.msg) setTimeout(function () { var q = $('#sq'); if (q) q.focus(); }, 50);
    }
  }
  // A pasted link in Search plays (or adds) instead of searching
  function isLinkish(q) {
    if (!q) return false;
    if (/#shelf=/.test(q) || Core.findLinks(q).length || Courses.playlistId(q)) return true;
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
      .then(function () { refreshing = false; lib.saveCache(); lastRefresh = Date.now(); renderAll(); updateDot(); }, function () { refreshing = false; renderAll(); });
  }
  var lastRefresh = 0;

  // ---------- Video player ----------
  var player = null, playerReady = false, ytLoaded = false, ytFailed = false, current = null, pending = null, tick = null, lastErr = '';
  var wantRate = 1, loadAt = 0, nextTimer = null, scrubbing = null;
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
          // A change made in YouTube's own menu sticks to the channel too; the reset YouTube does while loading doesn't
          if (!current || !sawPlaying || Date.now() - loadAt < 2500 || e.data === wantRate) return;
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
    behindSheets(true); document.body.classList.add('sheet-on');
    var b = el.querySelector('[data-act^="close"]'); if (b) setTimeout(function () { try { b.focus({ preventScroll: true }); } catch (e) {} }, 300);
  }
  function closeSheet(id) {
    var el = $(id), wasOpen = el.classList.contains('open');
    el.classList.remove('open'); el.setAttribute('aria-hidden', 'true');
    var still = document.querySelector('.sheet.open');
    behindSheets(false); if (still) behindSheets(true);
    document.body.classList.toggle('sheet-on', !!still);
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
    $('#ytLink').href = ytLink(v);
    wantRate = rateFor(v); renderRateUI(); renderMarkBtn(Core.resumeAt(v));
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
    $('#vPlay').innerHTML = playing ? I.pause : I.play;
    $('#vPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('#vPlay').classList.toggle('on', playing);
    if (playing) {
      sawPlaying = true; clearTimeout(startTimer);
      clearInterval(tick); tick = setInterval(capture, 5000);
      if (player.getPlaybackRate && player.getPlaybackRate() !== wantRate) { try { player.setPlaybackRate(wantRate); } catch (er) {} }
      capture(); keepAwake(true);
      var v = videos[current], tag = v && courseTag(v.id); if (v) $('#vCh').textContent = (tag || v.author || '') + (tag || v.author ? ' · ' : '') + (wake ? 'screen stays on' : 'saving your spot');
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
    clearInterval(tick); clearInterval(uiTick); clearTimeout(startTimer); clearTimeout(nextTimer); keepAwake(false);
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
    if (!scrubbing) paintScrub('v', t, d, wantRate);
    renderMarkBtn(t);
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
    $(sel).innerHTML = SEGS.map(function (m) { return '<button type="button" data-act="timer" data-p="' + which + '" data-m="' + m + '" aria-pressed="false"' + (m === 'end' ? ' aria-label="Stop at the end"' : ' aria-label="' + m + ' minutes"') + '>' + (m === 'end' ? 'End' : m) + '</button>'; }).join('');
  }
  function buildRates() {
    $('#vRate').innerHTML = VRATES.map(function (r) { return '<button type="button" data-act="v-rate" data-r="' + r + '" aria-pressed="false" aria-label="Speed ' + r + '"> ' + (r === 1 || r === 2 ? r + '×' : r) + '</button>'; }).join('');
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
    Array.prototype.forEach.call(document.querySelectorAll((which === 'v' ? '#vSeg' : '#nSeg') + ' button'), function (b) {
      var m = b.getAttribute('data-m');
      b.setAttribute('aria-pressed', String(!!t && (t.mode === 'end' ? m === 'end' : String(t.minutes) === m)));
    });
    if (which === 'v') {
      var lab = $('#vStops');
      if (!t) lab.textContent = msg || vTimerMsg || 'Off';
      else lab.innerHTML = t.mode === 'end' ? 'stops when it ends' : '<b>' + SleepTimer.countdown(SleepTimer.remaining(t, now)) + '</b> · stops ' + esc(clockText(t.endsAt));
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
  function rateFor(v) { var r = prefs.rates && prefs.rates['v:' + chanKey(v)]; return r > 0 ? r : 1; }
  function setRateFor(id, r) {
    var v = videos[id]; if (!v) return;
    prefs.rates = prefs.rates || {}; prefs.rates['v:' + chanKey(v)] = r; savePrefs();
    wantRate = r; renderRateUI();
  }
  function renderRateUI() {
    var v = current && videos[current];
    Array.prototype.forEach.call(document.querySelectorAll('#vRate button'), function (b) { b.setAttribute('aria-pressed', String(+b.getAttribute('data-r') === wantRate)); });
    $('#vRateLab').textContent = !v ? '' : wantRate === 1 ? chanName(v) + ' plays at 1×' : chanName(v) + ' remembers ' + wantRate + '×';
  }
  function podKey(guid) { var r = arec[guid] || {}, m = aMeta[guid] || {}; return 'a:' + (r.source || m.source || r.podcast || 'pod'); }
  function podRate(guid) { var r = prefs.rates && prefs.rates[podKey(guid)]; return r > 0 ? r : 1; }

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
      if (e.button > 0 || !e.target.closest(handles)) return;
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
    toast('Marked ' + Core.fmt(m.t) + '.', '', { label: 'Add note', fn: function () { openNote(m.id); } });
    if (stack.length && stack[stack.length - 1].name === 'marks') renderPage();
  }
  function openNote(id) {
    var m = marks.get(id); if (!m) return;
    noteFor = id; $('#noteWhat').textContent = Core.fmt(m.t) + ' · ' + m.title; $('#noteInput').value = m.note || '';
    openDlg($('#noteDlg')); setTimeout(function () { $('#noteInput').focus(); }, 60);
  }
  $('#noteForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (noteFor) marks.setNote(noteFor, $('#noteInput').value);
    $('#noteDlg').close(); toast('Note saved.');
    if (stack.length && stack[stack.length - 1].name === 'marks') renderPage();
  });
  function marksPage() {
    var list = marks.list(), h = topHTML('c1', 'Marks', list.length ? list.length + (list.length === 1 ? ' moment' : ' moments') + ' saved from the player' : 'Moments saved from the player');
    if (!list.length) return h + '<p class="pnote">Nothing marked yet. While a video plays, tap Mark when something should become a card.</p>';
    h += '<div class="pad"><button type="button" class="primary" data-act="marks-copy">Copy for Anki</button><span class="small">Copies one card a line: the moment on the front, its YouTube link on the back. In Anki on the Mac, File › Import, fields separated by Tab.</span></div>';
    h += '<h2 class="subh"><span>Newest first</span><span class="mono">' + list.length + '</span></h2>';
    list.forEach(function (m) {
      h += '<div class="mrow"><button type="button" data-act="mark-play" data-id="' + esc(m.id) + '"><b><span class="mono">' + Core.fmt(m.t) + '</span> · ' + esc(m.title) + '</b>' +
        '<small>' + (m.note ? esc(m.note) : (m.course ? esc(m.course) + ' · ' : '') + 'no note yet') + '</small></button>' +
        '<span class="iconrow">' + ib('mark-note', m.id, I.dots, 'Note for ' + Core.fmt(m.t)) + ib('mark-remove', m.id, I.x, 'Remove the mark at ' + Core.fmt(m.t)) + '</span></div>';
    });
    return h;
  }
  function copyText(text, done) {
    var fail = function () { toast("Couldn't copy. Try again.", 'warn'); };
    try { navigator.clipboard.writeText(text).then(done, function () { Native.call('Clipboard', 'write', { string: text }).then(done, fail); }); }
    catch (e) { fail(); }
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
    if (isNight() && !engine.state().timer) { engine.setTimer(45); setTimeout(function () { toast('45-minute sleep timer on. Tap a number to change it.'); }, 400); }
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
  function courseSub(c, pr, arr) {
    var st = cs.status(c.id);
    if (!arr.length) return st.loading ? 'Loading episodes…' : !st.ok ? 'Couldn\'t load it. Tap to see why.' : c.seed ? 'Loading episodes…' : feedsOn || prefs.apiKey ? 'Not loaded yet' : 'Episodes load in the Shelf app on your iPhone';
    if (pr.state === 'done') return 'Done · ' + pr.done + '/' + pr.total;
    var pc = cs.pace(c.id), per = pc && pc.perDay ? Courses.perDay(pc.perDay) : '';
    if (pr.state === 'new') return pr.total + ' videos' + (pr.hours ? ' · ' + pr.hours : '') + (per ? ' · <b>' + per + '</b> by the exam' : '');
    var late = pc.finishBy && pc.finishBy > Courses.EXAM.getTime();
    return '<b>' + pc.left + ' left</b>' + (per ? ' · ' + per : '') + (pc.finishBy ? ' · <span' + (late ? ' class="late"' : '') + '>done ' + shortDay(pc.finishBy) + ' at this week\'s pace</span>' : '');
  }
  function courseRow(c) {
    var arr = cs.items(c.id), pr = cs.progress(c.id), open = openC === c.id, nx = pr.next;
    var h = '<div class="course ' + pr.state + (open ? ' open' : '') + '">' +
      '<button type="button" class="cr" data-act="course-open" data-id="' + esc(c.id) + '" aria-expanded="' + open + '" aria-label="' + esc(c.name + ', ' + pr.done + ' of ' + pr.total + ' watched. ' + (open ? 'Close' : 'Open')) + '">' +
      '<span class="cl">' + esc(c.name) + '</span>' + rulerHTML(c, pr, arr) + '<span class="cn mono">' + (arr.length ? pr.done + '/' + pr.total : '–') + '</span>' +
      '<span class="cx mono">' + courseSub(c, pr, arr) + '</span>' + (nx && pr.state !== 'new' ? '<span class="cx mono">Next · ' + esc(epLabel(nx, pr.notch)) + ' · ' + esc(shortTitle(nx.title)) + (spotOf(nx) ? ' · ' + esc(spotOf(nx)) : '') + '</span>' : '') + '</button>';
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
      if (cplace[c.id]) h += '<form class="cplace" data-id="' + esc(c.id) + '"><label for="pl-' + esc(c.id) + '">Where are you? Episode № from the title</label>' +
        '<input id="pl-' + esc(c.id) + '" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="e.g. ' + esc(epLabel(arr[Math.max(0, pr.notch)] || arr[0], 0)) + '">' +
        '<span class="row"><button type="submit" class="cbtn solid">Tick up to here</button><button type="button" class="cbtn" data-act="course-pin-no" data-id="' + esc(c.id) + '">Pin ‼</button></span></form>';
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
      var x = arr[i], d = cs.isDone(c.id, x.id), lab = epLabel(x, i), da = ' data-id="' + esc(c.id) + '" data-v="' + esc(x.id) + '" data-i="' + i + '"';
      h += '<li class="epr' + (d ? ' d' : '') + (i === pr.notch ? ' n' : '') + '">' +
        '<button type="button" class="tk" data-act="ep-tick" data-hold="upto"' + da + ' aria-pressed="' + d + '" aria-label="' + esc((d ? 'Untick ' : 'Tick ') + lab + '. Hold to tick everything up to here.') + '"><span>' + (d ? '✓' : '') + '</span></button>' +
        '<span class="no mono">' + (c.pins[x.id] ? '<span class="pin">‼</span> ' : '') + esc(lab) + '</span>' +
        '<button type="button" class="et" data-act="ep-play" data-hold="pin"' + da + '>' + esc(titleFor(c, x)) + '</button>' +
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
    var td = cs.today(), days = cs.daysLeft(), max = Math.max.apply(null, td.week.concat([1]));
    return '<div class="exam"><div class="big mono"><small>Days to Step 2 CK</small>' + days + '</div><div class="nums mono">' +
      '<p><b>' + esc(DAYS[Courses.EXAM.getDay()].slice(0, 3) + ' ' + shortDay(Courses.EXAM.getTime())) + '</b> · ' + td.left + ' left</p>' +
      '<p>' + (td.left ? '<b>' + esc(Courses.perDay(td.perDay)) + '</b> to finish in time' : '<b>Every course done.</b>') + '</p>' +
      '<p>Today <b>' + td.n + (td.secs ? ' · ' + Math.round(td.secs / 60) + ' min' : '') + '</b> · this week <b>' + td.weekN + '</b></p>' +
      '<div class="week" role="img" aria-label="Episodes ticked each day, last 7 days: ' + td.week.join(', ') + '">' + td.week.map(function (n) { return '<i class="' + (n ? '' : 'z') + '" style="height:' + (n ? Math.max(15, Math.round(n / max * 100)) : 8) + '%"></i>'; }).join('') + '</div>' +
      '</div></div>';
  }
  function courseGroups(list) {
    var groups = { go: [], new: [], done: [] }, h = '';
    list.forEach(function (c) { var s = cs.progress(c.id).state; (groups[s === 'empty' ? (c.touched || c.seed ? 'go' : 'new') : s] || groups.new).push(c); });
    groups.go.sort(function (a, b) { return (b.touched || 0) - (a.touched || 0); });
    [['go', 'On the go'], ['new', 'Not started'], ['done', 'Done']].forEach(function (g) {
      if (!groups[g[0]].length) return;
      h += '<h2 class="subh"><span>' + g[1] + '</span><span class="mono">' + groups[g[0]].length + '</span></h2><div class="cgroup">' + groups[g[0]].map(courseRow).join('') + '</div>';
    });
    return h;
  }
  function coursesPage(v) {
    var sec = lib.section(v.id) || lib.sections()[0], all = cs.list().filter(function (c) { return courseSec(c) === sec.id; }), h = '';
    var chans = {}; all.forEach(function (c) { if (c.channel) chans[c.channel] = 1; });
    var who = Object.keys(chans).length === 1 ? Object.keys(chans)[0] : sec.name;
    h += topHTML(bandClass(sec.id), 'Courses', esc(who) + ' · ' + all.length + (all.length === 1 ? ' course' : ' courses'),
      ib('open-marks', null, I.mark, 'Marks') + ib('add-course', sec.id, I.plus, 'Add course'), cs.list().length ? examHTML() : '');
    if (sec.id === Courses.SEED.section) cs.misses.forEach(function (m) {
      h += '<p class="pnote err">Couldn\'t find your ' + esc(m.name) + ' playlist on Mehlman\'s channel (' + esc(m.error) + '). <button type="button" data-act="add-course" data-id="' + esc(sec.id) + '" data-fix="' + esc(m.name) + '">Fix</button></p>';
    });
    if (!feedsOn && !prefs.apiKey) h += '<p class="pnote">Episodes load in the Shelf app on your iPhone.</p>';
    h += courseGroups(all);
    if (!all.length) h += '<p class="pnote">No courses yet. Add a playlist and Shelf ticks it episode by episode.</p>';
    // Courses kept in other sections follow under their own band colour
    lib.sections().forEach(function (o) {
      if (o.id === sec.id) return;
      var mine = cs.list().filter(function (c) { return courseSec(c) === o.id; });
      if (mine.length) h += '<h2 class="subh band ' + bandClass(o.id) + '"><span>' + esc(o.name) + '</span><span class="mono">' + mine.length + '</span></h2><div class="cgroup">' + mine.map(courseRow).join('') + '</div>';
    });
    h += '<button type="button" class="more" data-act="add-course" data-id="' + esc(sec.id) + '"><span>+ Add course</span><span class="mono">a playlist link, or type a name</span></button>';
    return h;
  }
  function courseSec(c) { return lib.section(c.section) ? c.section : lib.sections()[0].id; }
  function openCourses(secId) { push({ name: 'courses', id: secId || 'med' }); }
  // Re-render without losing what's being typed in a Set place box
  function keepTyping(fn) {
    var a = document.activeElement, id = a && a.id && /^pl-/.test(a.id) ? a.id : null, val = id ? a.value : '';
    fn();
    if (id) { var n = document.getElementById(id); if (n) { n.value = val; try { n.focus({ preventScroll: true }); } catch (e) {} } }
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
    if (!c || !n) { toast('Type the episode number from the video title, like 1107.', 'warn'); return; }
    var hits = cs.findNumber(cid, n), arr = cs.items(cid);
    if (!hits.length) { toast('No episode ' + n + ' in ' + c.name + '. Check the number in the video title.', 'warn'); return; }
    var before = cs.tickUpTo(cid, hits[0]);
    cplace[cid] = false; cwin[cid] = null;
    renderAll();
    toast(n + ' is ' + (hits[0] + 1) + ' of ' + arr.length + '. Ticked everything up to it' + (hits.length > 1 ? ' (first of ' + hits.length + ')' : '') + '.', '', { label: 'Undo', fn: function () { cs.restore(cid, before); renderAll(); } });
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
      openC = c.id; renderAll(); updateDot();
      setTimeout(function () { if ($('#courseDlg').open) $('#courseDlg').close(); }, 900);
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
    b.hidden = !n;
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
        if (current !== vid || !cdn || box.hidden || document.visibilityState !== 'visible') return;
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
      case 'edit-section': openSec(id); break;
      case 'sec-up': case 'sec-down': lib.moveSection(editing, act === 'sec-up' ? -1 : 1); renderAll(); break;
      case 'sec-delete':
        if (!confirmDel) { confirmDel = true; var to = lib.sections().filter(function (s) { return s.id !== editing; })[0]; b.textContent = 'Tap again: channels move to ' + (to ? to.name : '?'); break; }
        try { var toSec = lib.removeSection(editing); cs.list().forEach(function (c) { if (c.section === editing) cs.move(c.id, toSec); }); $('#secDlg').close(); if (stack.length) { stack = []; $('#page').hidden = true; } renderAll(); toast('Section deleted. Its channels moved.'); }
        catch (err) { $('#secMsg').textContent = err.message; $('#secMsg').className = 'msgline err'; }
        break;
      case 'seen-section': lib.sources(id).forEach(function (s) { lib.markSeen(s.id); }); renderAll(); break;
      case 'channel-menu': openChanMenu(id); break;
      case 'move-channel': lib.setSection(id, b.getAttribute('data-to')); openChanMenu(id); renderAll(); break;
      case 'toggle-shorts': var ts = lib.source(id); if (ts) { lib.setHideShorts(id, !hidesShorts(ts)); openChanMenu(id); renderAll(); } break;
      case 'remove-channel':
        if (confirmRemove !== id) { confirmRemove = id; b.textContent = 'Tap again to remove'; break; }
        var nm = lib.source(id).name; lib.remove(id); confirmRemove = null; lib.saveCache(); $('#chanDlg').close(); back(); toast('Removed ' + nm + '.'); break;
      case 'remove-video':
        var gone = videos[id]; delete videos[id]; saveVideos(); renderAll();
        if (!Object.keys(videos).some(function (k) { return !entryFromVideo(videos[k]).section; }) && stack.length && stack[stack.length - 1].name === 'pasted') back();
        toast('Removed.', '', { label: 'Undo', fn: function () { videos[id] = gone; saveVideos(); renderAll(); } });
        break;
      case 'close-video': closeVideo(); break;
      case 'open-courses': if (b.id === 'coursesBtn') openTab({ name: 'courses', id: id || 'med' }); else openCourses(id); break;
      case 'open-marks': push({ name: 'marks' }); break;
      case 'mark': doMark(); break;
      case 'mark-play': var mk = marks.get(id); if (mk) openVideo({ id: mk.vid, t: Math.max(1, mk.t), title: mk.title }); break;
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
  // YouTube ↗ opens at the spot playing now, not where the video was when the player opened
  $('#ytLink').addEventListener('click', function () { capture(true); var v = current && videos[current]; if (v) this.href = ytLink(v); });
  scrubKeys($('#vScrub'), 15, function (s) { try { player.seekTo(Math.max(0, player.getCurrentTime() + s), true); videoTick(); } catch (e) {} });
  scrubKeys($('#nScrub'), 30, function (s) { engine.seekBy(s); });
  scrubDrag($('#vScrub'), 'v', function () { try { return player && current ? player.getDuration() : 0; } catch (e) { return 0; } }, function () { return wantRate; }, function (t) { try { player.seekTo(t, true); } catch (e) {} videoTick(); });
  scrubDrag($('#nScrub'), 'n', function () { return engine ? engine.state().dur : 0; }, function () { return engine.state().rate; }, function (t) { engine.seek(t); renderAudio(); });
  // Swipe down on the grabber or the top bar closes a player or a sheet
  sheetSwipe($('#vsheet'), '.grab,.sh-top', function () { closeVideo(); });
  sheetSwipe($('#nsheet'), '.grab,.sh-top', function () { closeNight(); });
  Array.prototype.forEach.call(document.querySelectorAll('dialog'), function (d) { sheetSwipe(d, '.grab,.dh', function () { d.close(); }); });
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
      else if (srcs.length && failed.length === srcs.length) out.push({ ok: 0, text: "Couldn't check any of your channels. Check your internet, then tap the date at the top to try again." });
      else if (failed.length) out.push({ ok: 0, text: "Couldn't update " + failed.map(function (s) { return s.name + ' (' + lib.status(s.id).error + ')'; }).join(', ') + '. Open the channel and tap Refresh.' });
      else if (srcs.length) out.push({ ok: 1, text: 'Checked ' + srcs.length + ' channels for new uploads' + (lastRefresh ? ' ' + Core.ago(lastRefresh) : '') });
      lib.seedMisses.filter(function (m) { return !alreadyHave(m.input); }).forEach(function (m) {
        var sec = lib.section(m.section);
        out.push({ ok: 0, text: "Couldn't find " + m.input + ' automatically. Open ' + (sec ? sec.name : 'its section') + ' and tap Fix next to it.' });
      });
    } else out.push({ ok: 1, text: 'Channels and new uploads load in the Shelf app on your iPhone; here you can paste and resume' });
    if (cs && cs.list().length && (feedsOn || prefs.apiKey)) {
      var cbad = cs.list().filter(function (c) { return !cs.status(c.id).ok; });
      if (cs.busy) out.push({ ok: 2, text: 'Loading your courses…' });
      else if (cbad.length) out.push({ ok: 0, text: "Couldn't load " + cbad.map(function (c) { return c.name; }).join(', ') + ' from YouTube. Open Courses and tap Retry; your ticks are safe.' });
      else out.push({ ok: 1, text: 'Tracking ' + cs.list().length + (cs.list().length === 1 ? ' course' : ' courses') + ' episode by episode' });
    }
    if (cs && feedsOn) cs.misses.forEach(function (m) { out.push({ ok: 0, text: "Couldn't find your " + m.name + " playlist on Mehlman's channel. Open Courses and tap Fix next to it." }); });
    out.push({ ok: 1, text: prefs.apiKey ? 'Search uses your Google key' : 'Search reads YouTube\'s results page (no key needed)' });
    if (Native.inApp) {
      out.push({ ok: 1, text: 'Running inside the Shelf app' });
      var ya = Native.ytAccount.state;
      out.push(ya === 'in' ? { ok: 1, text: 'Signed in to YouTube. With "Allow Cross-Website Tracking" on for Shelf (iPhone Settings for Shelf, below), the player uses your Premium. If ads still show, YouTube ↗ opens the video in the YouTube app.' }
        : ya === 'out' ? { ok: 0, text: 'Not signed in to YouTube, so videos play with ads even with Premium.', fix: 'yt' }
        : ya === 'old' ? { ok: 0, text: "This copy of the Shelf app is older than the website, so it can't sign in to YouTube yet. On your Mac, run the installer again." }
        : ya === 'wait' ? { ok: 2, text: 'Checking your YouTube sign-in…' }
        : { ok: 0, text: "Couldn't check your YouTube sign-in. Close and reopen Shelf." });
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
    // The square shows only colour when all is well; a problem widens it to say so
    btn.classList.toggle('bad', vd.state === 'bad');
    txt.textContent = vd.state === 'bad' ? (vd.bad.length === 1 ? '1 problem' : vd.bad.length + ' problems') : vd.label;
    txt.className = vd.state === 'bad' ? '' : 'sr';
    checkedAt = Date.now();
    btn.setAttribute('aria-label', 'Self-check: ' + vd.label + '. Show details.');
    if ($('#checkDlg').open) fillCheck();
  }
  function fixBtn(kind) {
    var ya = Native.ytAccount.state;
    if (kind === 'yt') return '<button type="button" class="fix" id="ytBtn" data-act="yt-sign">' + (signingIn ? 'Signing in…' : ya === 'in' ? 'Sign out of YouTube' : 'Sign in to YouTube') + '</button>';
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
    $('#trackBtn').hidden = !signIn;
    $('#checkAllSum').textContent = 'Show all ' + c.length + ' checks';
    $('#checkList').innerHTML = c.map(function (x) {
      return '<li class="' + (x.ok === 1 ? 'ok' : x.ok === 2 ? 'wait' : 'bad') + '"><span class="ic" aria-hidden="true">' + (x.ok === 1 ? '✓' : x.ok === 2 ? '…' : '!') + '</span><span>' + esc(x.text) + '</span></li>';
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
      else toast("Google didn't finish signing you in. Videos still play; for Premium without ads, open them in the YouTube app (YouTube ↗ in the player).", 'warn');
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
        writes.forEach(function (w) { rawSet(w[0], w[1], false); });
        restored = true; restoreFailed = false;
      } catch (e) { restoreFailed = true; }
    }, function () { if (wait < 6000) return restoreFromPhone(6000); restoreFailed = true; }); // slow phone: one longer try, then a Try again in the self-check
  }
  // Only entries shaped like records (a null or stray value in a phone copy is dropped, not merged)
  function records(o) { var out = {}; if (o && typeof o === 'object' && !Array.isArray(o)) Object.keys(o).forEach(function (k) { if (o[k] && typeof o[k] === 'object') out[k] = o[k]; }); return out; }
  function boot() {
    videos = load(KEY, {}); prefs = load(PREF, {}); arec = load(AKEY, {});
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
    setInterval(function () { if (!stack.length && document.visibilityState === 'visible') keepTyping(renderHome); }, 60000);
    window.addEventListener('online', updateDot); window.addEventListener('offline', updateDot);
    if (!canSave && !Native.inApp) setTimeout(function () { toast('Your browser is blocking saving, so nothing will be remembered. Tap the self-check for how to fix it.', 'warn'); }, 600);
    refreshAll(false);
    // Test hook
    window.__shelf = { get videos() { return videos; }, get audio() { return arec; }, get lib() { return lib; }, get engine() { return engine; }, checks: checks, capture: capture,
      get current() { return current; }, get vTimer() { return vTimer; }, get marks() { return marks; }, get prefs() { return prefs; }, refreshAll: refreshAll, handleText: handleText, get stack() { return stack; }, get courses() { return cs; }, get busy() { return refreshing || cs.busy || !lib.sources().length && feedsOn && !lib.seedMisses.length; } };
  }
  // Home must draw whatever the phone's storage did
  restoreFromPhone().catch(function () { restoreFailed = true; }).then(boot);
})();
