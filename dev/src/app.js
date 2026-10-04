// App: storage, YouTube player, shelf, self-check, Send to iPhone.
(function () {
  var KEY = 'resume.shelf.v1', PREF = 'resume.prefs.v1';
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var reduced = function () { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

  // ---------- storage ----------
  var canSave = (function () {
    try { localStorage.setItem('resume.probe', '1'); var ok = localStorage.getItem('resume.probe') === '1'; localStorage.removeItem('resume.probe'); return ok; }
    catch (e) { return false; }
  })();
  var mem = {};
  function load(k, d) {
    try { var s = canSave ? localStorage.getItem(k) : mem[k]; var v = s ? JSON.parse(s) : d; return v && typeof v === 'object' ? v : d; } catch (e) { return d; }
  }
  var lastSaveError = '';
  function store(k, v) {
    var s = JSON.stringify(v);
    Native.prefSet(k, s);
    if (!canSave) { mem[k] = s; return Native.inApp; }
    try { localStorage.setItem(k, s); lastSaveError = ''; return true; }
    catch (e) { lastSaveError = (e && e.name) || 'error'; return false; }
  }
  var videos = load(KEY, {});
  var prefs = load(PREF, {});
  var lastSavedAt = 0, lastCaptureAt = 0;
  function save() { if (store(KEY, videos)) { lastSavedAt = Date.now(); pulse(); } updateDot(); }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) {}

  // Another tab changed the shelf
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) { videos = load(KEY, {}); render(); }
  });

  // ---------- titles and pictures ----------
  function fetchTitle(id) {
    if (!window.fetch) return;
    var url = 'https://noembed.com/embed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id);
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      var v = videos[id];
      if (!v || !j || j.error) return;
      if (j.title && !v.title) v.title = j.title;
      if (j.author_name && !v.author) v.author = j.author_name;
      save(); render();
    }).catch(function () {});
  }
  function thumb(id, big) { return 'https://i.ytimg.com/vi/' + id + '/' + (big ? 'maxresdefault' : 'mqdefault') + '.jpg'; }
  // maxresdefault doesn't exist for every video; YouTube then sends a tiny 120px grey image
  function fixPoster(img) {
    var fallback = function () { var id = img.getAttribute('data-id'); if (id && img.src.indexOf('hqdefault') === -1) img.src = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'; };
    img.onerror = fallback;
    img.onload = function () { if (img.naturalWidth && img.naturalWidth <= 120) fallback(); };
  }
  function ytLink(v) { return 'https://www.youtube.com/watch?v=' + v.id + (v.t > 5 && !v.done ? '&t=' + Math.floor(v.t) + 's' : ''); }

  // ---------- adding ----------
  function add(text, opts) {
    var shelf = String(text || '').match(/#shelf=([A-Za-z0-9_-]+)/);
    if (shelf) { importShelf(shelf[1]); render(); return true; }
    var found = Core.findLinks(text);
    if (!found.length) {
      toast(text && String(text).trim() ? "That doesn't look like a YouTube link. Copy the address from YouTube and paste it here." : 'Paste a YouTube link first.', 'warn');
      return false;
    }
    var now = Date.now(), fresh = [];
    found.forEach(function (f, i) {
      var v = videos[f.id];
      if (!v) {
        v = videos[f.id] = { id: f.id, t: f.t || 0, dur: 0, title: '', author: '', added: now + i, updated: now + found.length - i, done: false };
        fetchTitle(f.id); fresh.push(f.id);
      } else {
        v.updated = now + found.length - i;
        if (f.t) { v.t = f.t; v.done = false; }
      }
    });
    justAdded = fresh;
    save(); render();
    if (found.length === 1) { if (!opts || opts.play !== false) play(found[0].id); }
    else toast('Added ' + found.length + ' videos to your shelf.');
    return true;
  }
  var justAdded = [];
  var isPhone = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  var standalone = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

  // ---------- player ----------
  var player = null, playerReady = false, ytLoaded = false, ytFailed = false, current = null, pending = null, tick = null, lastErr = '';
  // A spot is only trusted once this video is really playing near where we asked it to start
  // (stops ads and the previous video's time from overwriting it)
  var armed = false, sawPlaying = false, loadStart = 0, startTimer = null;
  window.onYouTubeIframeAPIReady = function () {
    ytLoaded = true; updateDot();
    var vars = { rel: 0, playsinline: 1, modestbranding: 1, autoplay: 1 };
    if (/^https?:$/.test(location.protocol)) vars.origin = location.origin;
    player = new YT.Player('player', {
      width: '100%', height: '100%', playerVars: vars,
      events: {
        onReady: function () { playerReady = true; if (pending) { var p = pending; pending = null; play(p); } },
        onStateChange: onState,
        onPlaybackRateChange: function (e) { prefs.rate = e.data; store(PREF, prefs); },
        onError: onError
      }
    });
  };
  (function loadYT() {
    var s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = function () { ytFailed = true; updateDot(); };
    document.head.appendChild(s);
    setTimeout(function () { if (!ytLoaded) { ytFailed = true; updateDot(); } }, 12000);
  })();

  function play(id) {
    var v = videos[id]; if (!v) return;
    if (current && current !== id) capture(true);
    lastErr = '';
    $('#playerError').hidden = true;
    if (ytFailed && !playerReady) {
      // No player: say so where they're looking, and offer YouTube itself
      current = null; document.body.classList.remove('playing'); render();
      showError("Can't reach YouTube from this page. Check your internet, or turn off any ad blocker or content blocker for this page, then reload.", v);
      return;
    }
    current = id; armed = false; sawPlaying = false;
    v.updated = Date.now(); save();
    document.body.classList.add('playing');
    render();
    var hero = $('#hero');
    if (hero.scrollIntoView && hero.getBoundingClientRect().top < 0) hero.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
    if (!playerReady) { pending = id; hint('Loading the YouTube player…'); return; }
    var start = Core.resumeAt(v);
    if (v.done) { v.done = false; v.t = 0; save(); }
    loadStart = start;
    player.loadVideoById({ videoId: id, startSeconds: start });
    if (prefs.rate && prefs.rate !== 1) { try { player.setPlaybackRate(prefs.rate); } catch (e) {} }
    // Safari sometimes wants a tap on the video itself before it plays
    clearTimeout(startTimer);
    startTimer = setTimeout(function () { if (current === id && !sawPlaying) hint('Tap the video to start.'); }, 3000);
  }
  function hint(text) { $('#heroMeta').textContent = text; }
  function capture(final) {
    if (!player || !current || !playerReady || !videos[current]) return;
    var v = videos[current], t, d;
    try {
      // Only trust the player once it is on this video
      var vd = player.getVideoData && player.getVideoData();
      if (vd && vd.video_id && vd.video_id !== current) return;
      t = player.getCurrentTime(); d = player.getDuration();
      if (vd) { if (vd.title && !v.title) v.title = vd.title; if (vd.author && !v.author) v.author = vd.author; }
    } catch (e) { return; }
    if (typeof t !== 'number' || isNaN(t)) return;
    if (!armed) {
      if (!sawPlaying || t < loadStart - 3 || t > loadStart + 60) return;
      armed = true;
    }
    // A much shorter duration than before means an ad or another video is reporting
    if (v.dur > 0 && d > 0 && d < v.dur * 0.9) return;
    if (d > 0) v.dur = d;
    // Ignore the 0 the player reports while a video loads
    if (t < 1 && v.t > 5) return;
    v.t = t;
    v.updated = Date.now();
    lastCaptureAt = Date.now();
    save(); renderSoon();
  }
  function onState(e) {
    var S = YT.PlayerState;
    if (e.data === S.PLAYING) {
      sawPlaying = true; clearTimeout(startTimer);
      clearInterval(tick); tick = setInterval(capture, 5000);
      if (prefs.rate && player.getPlaybackRate && player.getPlaybackRate() !== prefs.rate) { try { player.setPlaybackRate(prefs.rate); } catch (er) {} }
      capture();
    } else {
      clearInterval(tick);
      if (e.data === S.ENDED && current && videos[current] && armed) {
        var v = videos[current]; v.t = v.dur || v.t; v.done = true; v.updated = Date.now();
        current = null; document.body.classList.remove('playing');
        save(); render();
        toast('Finished. Moved to your Finished list.');
      } else if (e.data === S.PAUSED) capture(true);
    }
  }
  function onError(e) {
    // The empty player can complain before anything is played; ignore that
    if (!current) return;
    var v = videos[current];
    var msg = {
      2: "That link doesn't point to a real video. Check you copied the whole address.",
      5: "Your browser couldn't play this video. Try opening it on YouTube.",
      100: 'This video was removed or made private by its owner.',
      101: "This video's owner only lets it play on YouTube itself.",
      150: "This video's owner only lets it play on YouTube itself.",
      153: 'YouTube needs this page opened from its web address, not as a file.'
    }[e.data] || 'YouTube had a problem playing this video (code ' + e.data + ').';
    clearTimeout(startTimer);
    showError(msg, e.data !== 153 ? v : null);
  }
  function showError(msg, v) {
    lastErr = msg;
    var html = '<span>' + esc(msg) + '</span>';
    if (v) html += '<a href="' + esc(ytLink(v)) + '" target="_blank" rel="noopener">Open on YouTube' + (v.t > 5 && !v.done ? ' at ' + Core.fmt(v.t) : '') + '</a>';
    var box = $('#playerError'); box.innerHTML = html; box.hidden = false;
    updateDot();
  }
  // Save on the way out
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'hidden') return;
    capture(true);
    // YouTube doesn't allow its videos to keep playing in the background, so pause when the app is hidden
    if ((Native.inApp || isPhone) && current) { try { player.pauseVideo(); } catch (e) {} }
  });
  window.addEventListener('pagehide', function () { capture(true); });

  function closeNow() {
    capture(true);
    try { player && player.pauseVideo(); } catch (e) {}
    clearInterval(tick); current = null;
    document.body.classList.remove('playing');
    $('#playerError').hidden = true;
    render();
  }

  // ---------- shelf ----------
  var renderTimer = null;
  function renderSoon() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 60); }
  function featured(s) { return (current && videos[current]) || s.watching[0] || null; }
  function leftHTML(v) {
    if (v.dur) {
      var r = Math.max(0, v.dur - (v.t || 0)), m = Math.round(r / 60);
      var big = r < 60 ? '<1 min' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' hr ' + (m % 60 ? (m % 60) + ' min' : '');
      return '<b>' + esc(big.trim()) + '</b>left';
    }
    return v.t > 5 ? '<b>' + Core.fmt(v.t) + '</b>stopped' : '<b>New</b>';
  }
  function row(v) {
    var p = Core.pct(v), fresh = justAdded.indexOf(v.id) !== -1;
    var sub = v.done ? 'Finished ' + Core.ago(v.updated) : (v.author ? v.author + ' · ' : '') + (v.t > 5 ? 'stopped at ' + Core.fmt(v.t) : 'not started');
    var label = (v.done ? 'Watch again: ' : v.t > 5 ? 'Resume from ' + Core.fmt(v.t) + ': ' : 'Play: ') + (v.title || 'YouTube video');
    return '<li class="row' + (fresh ? ' fresh' : '') + '" data-id="' + esc(v.id) + '">' +
      '<button class="row-main" type="button" data-act="play" aria-label="' + esc(label) + '">' +
        '<span class="th"><img data-id="' + esc(v.id) + '" src="' + thumb(v.id) + '" alt="" loading="lazy" decoding="async"></span>' +
        '<span class="row-text"><span class="row-title">' + esc(v.title || 'YouTube video') + '</span>' +
        '<span class="row-sub">' + esc(sub) + '</span>' +
        (v.done ? '' : '<span class="bar"><i style="width:' + p.toFixed(1) + '%"></i></span>') + '</span>' +
        (v.done ? '<span class="ring" aria-hidden="true"><svg viewBox="0 0 12 12"><path d="M3 6.3l2 2 4-4.6"/></svg></span>'
          : '<span class="left">' + leftHTML(v) + '</span>') +
      '</button>' +
      '<span class="row-tools">' +
        (v.done ? '' : '<button class="tool" type="button" data-act="done" title="Mark as finished" aria-label="Mark as finished"><svg viewBox="0 0 16 16"><path d="M3.5 8.4l3 3 6-6.8"/></svg></button>') +
        '<button class="tool" type="button" data-act="remove" title="Remove from shelf" aria-label="Remove from shelf"><svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></button>' +
      '</span></li>';
  }
  var heroId = null;
  function render() {
    var s = Core.sorted(videos), f = featured(s), playing = !!current;
    var any = s.watching.length + s.finished.length;
    // header
    $('#count').textContent = s.watching.length ? '· ' + s.watching.length + ' to finish' : any ? '· all caught up' : '';
    // hero
    $('#hero').hidden = !f;
    $('#empty').hidden = !!any;
    $('#caught').hidden = !(any && !f);
    if (f) {
      var img = $('#posterImg');
      if (heroId !== f.id) { img.setAttribute('data-id', f.id); fixPoster(img); img.src = thumb(f.id, true); heroId = f.id; }
      $('#poster').hidden = playing;
      $('#poster').setAttribute('aria-label', (f.t > 5 ? 'Resume from ' + Core.fmt(f.t) : 'Play') + ': ' + (f.title || 'video'));
      $('#chip').hidden = !(f.t > 5 && !f.done);
      $('#chipTime').textContent = Core.fmt(f.t);
      $('#heroBar').style.width = Core.pct(f).toFixed(2) + '%';
      $('#heroTitle').textContent = f.title || 'YouTube video';
      var meta = [];
      if (f.author) meta.push(esc(f.author));
      if (playing) meta.push(lastCaptureAt && armed && f.t > 1 ? 'Spot saved at <b>' + Core.fmt(f.t) + '</b>' : 'Saves your spot as you watch');
      else {
        if (f.dur) meta.push('<b>' + esc(Core.left(f.t, f.dur)) + '</b>');
        if (f.t > 5) meta.push('you stopped here ' + esc(Core.ago(f.updated)));
      }
      $('#heroMeta').innerHTML = meta.join(' · ');
      $('#resumeText').textContent = f.t > 5 ? 'Resume from ' + Core.fmt(f.t) : 'Play';
      $('#heroYouTube').href = ytLink(f);
    }
    // lists
    var rest = s.watching.filter(function (v) { return !f || v.id !== f.id; });
    $('#watching').innerHTML = rest.map(row).join('');
    $('#watchingWrap').hidden = !rest.length;
    var total = rest.reduce(function (a, v) { return a + Math.max(0, (v.dur || 0) - (v.t || 0)); }, 0);
    $('#watchingSum').textContent = rest.length + (rest.length === 1 ? ' video' : ' videos') + (total > 60 ? ' · ' + Core.left(0, total) : '');
    $('#finished').innerHTML = s.finished.map(row).join('');
    $('#finishedWrap').hidden = !s.finished.length;
    $('#finishedCount').textContent = s.finished.length;
    $('#sendBtn').disabled = !any;
    Array.prototype.forEach.call(document.querySelectorAll('.row .th img'), function (im) {
      im.onerror = function () { im.style.visibility = 'hidden'; };
    });
    justAdded = [];
    updateFoot();
  }
  var undo = null;
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var li = b.closest('[data-id]'), id = li && li.getAttribute('data-id'), act = b.getAttribute('data-act');
    var f = featured(Core.sorted(videos));
    if (act === 'play' && id) play(id);
    else if (act === 'play-featured' && f) play(f.id);
    else if ((act === 'done' && id) || (act === 'done-featured' && f)) {
      var did = id || f.id;
      if (did === current) { capture(true); try { player.pauseVideo(); } catch (er) {} current = null; document.body.classList.remove('playing'); }
      videos[did].done = true; videos[did].updated = Date.now(); save(); render(); toast('Moved to Finished.');
    }
    else if (act === 'remove' && id) {
      undo = { id: id, v: videos[id] }; if (id === current) closeNow();
      delete videos[id]; save(); render();
      toast('Removed from your shelf.', '', { label: 'Undo', fn: function () { if (undo) { videos[undo.id] = undo.v; undo = null; save(); render(); } } });
    }
    else if (act === 'close') closeNow();
    else if (act === 'check') openCheck();
    else if (act === 'send') openSend();
    else if (act === 'dismiss') { var d = b.closest('dialog'); if (d) d.close(); }
    else if (act === 'copy') copyText($('#sendLink').value, $('#sendLink'));
    else if (act === 'tone') {
      if (Native.tonePlaying) { Native.stopTone(); b.textContent = 'Test lock-screen sound'; fillCheck(); return; }
      if (current) closeNow();
      Native.playTone().then(function () { b.textContent = 'Stop the sound test'; fillCheck(); toast('Now lock your phone for 10 seconds, then come back.'); },
        function () { toast("The sound test couldn't start. Turn the volume up and try again.", 'warn'); });
    }
  });
  // Click on the dimmed backdrop closes a dialog
  Array.prototype.forEach.call(document.querySelectorAll('dialog'), function (d) {
    d.addEventListener('click', function (e) {
      if (e.target !== d) return;
      var r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    });
  });

  // ---------- paste ----------
  var form = $('#addForm'), input = $('#paste'), addBtn = $('#addBtn');
  function syncBtn() { addBtn.textContent = input.value.trim() ? 'Add' : 'Paste'; }
  input.addEventListener('input', syncBtn);
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (input.value.trim()) { if (add(input.value)) input.value = ''; syncBtn(); return; }
    // Empty box: read the clipboard (Safari shows a small Paste bubble to tap)
    var touch = /iPhone|iPad|Android/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent) && !matchMedia('(pointer: fine)').matches);
    var fallback = function () { input.focus(); toast(touch ? 'Tap the box, then tap Paste.' : 'Press ⌘V to paste your link.'); };
    try {
      Native.readClipboard().then(function (txt) {
        if (txt && txt.trim()) return add(txt);
        // Universal Clipboard can take a moment to arrive from the Mac: try once more
        setTimeout(function () { Native.readClipboard().then(function (t2) { if (t2 && t2.trim()) add(t2); else fallback(); }, fallback); }, 1200);
      }, fallback);
    } catch (er) { fallback(); }
  });
  document.addEventListener('paste', function (e) {
    var t = e.target, cd = e.clipboardData || window.clipboardData;
    var txt = cd ? cd.getData('text') : '';
    if (t && t.id === 'paste') {
      if (Core.findLinks(txt).length || /#shelf=/.test(txt)) { e.preventDefault(); add(txt); t.value = ''; syncBtn(); }
      return;
    }
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
    if (txt) { e.preventDefault(); add(txt); }
  });
  document.addEventListener('keydown', function (e) {
    var t = e.target, editable = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    // Safari only pastes into a text field, so move focus to the box first
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'v' || e.key === 'V') && !editable && !document.querySelector('dialog[open]')) input.focus({ preventScroll: true });
    if (e.key === 'Escape' && !document.querySelector('dialog[open]') && current) closeNow();
  });

  // ---------- toast ----------
  var toastTimer = null;
  function toast(msg, kind, action) {
    var t = $('#toast');
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button type="button" class="toast-act">' + esc(action.label) + '</button>' : '');
    if (action) t.querySelector('button').onclick = function () { action.fn(); t.className = 'toast'; };
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast'; }, action ? 6000 : 4000);
  }

  // ---------- self-check ----------
  function checks() {
    var out = [];
    var web = /^https?:$/.test(location.protocol);
    out.push(web ? { ok: 1, text: 'Opened from its web address' }
      : { ok: 0, text: 'You opened the file directly. YouTube only plays when this page is opened from its web address, so use the link instead.' });
    out.push(canSave && !lastSaveError ? { ok: 1, text: 'Saves your spots in this browser (a private window forgets them when it closes)' }
      : !canSave ? { ok: 0, text: 'Your browser is blocking saving, so nothing will be remembered. In Safari, go to Settings, Privacy, and turn off "Block all cookies".' }
      : { ok: 0, text: 'Saving just failed. Your browser storage may be full; remove a few finished videos.' });
    out.push(navigator.onLine === false ? { ok: 0, text: "You're offline. Videos need the internet, but your shelf is safe." } : { ok: 1, text: 'Connected to the internet' });
    out.push(ytLoaded ? { ok: 1, text: 'YouTube player is ready' }
      : ytFailed ? { ok: 0, text: "Can't reach YouTube. Check your internet, or turn off any ad blocker or content blocker for this page, then reload." }
      : { ok: 2, text: 'Still loading the YouTube player…' });
    if (lastErr) out.push({ ok: 2, text: 'Last video: ' + lastErr });
    if (current) {
      var ago = lastCaptureAt && armed ? Math.round((Date.now() - lastCaptureAt) / 1000) : null;
      var playingNow = false; try { playingNow = player && player.getPlayerState() === 1; } catch (e) {}
      out.push(ago == null ? { ok: 2, text: 'Your spot saves a few seconds after the video starts' }
        : playingNow && ago > 20 ? { ok: 0, text: "Your spot hasn't saved for " + ago + ' seconds. Reload the page; your last spot is kept.' }
        : { ok: 1, text: 'Saved your spot ' + (ago < 3 ? 'just now' : ago + ' seconds ago') });
    }
    if (Native.inApp) {
      out.push({ ok: 1, text: 'Running inside the Shelf app' });
      if (Native.prefError) out.push({ ok: 0, text: "The phone's storage refused a save. Close and reopen Shelf; your last saved spots are kept." });
      var fs = Native.feedStatus;
      out.push(fs.state === 'ok' ? { ok: 1, text: fs.text } : fs.state === 'bad' ? { ok: 0, text: fs.text } : { ok: 2, text: 'Checking podcast feeds…' });
      var tr = Native.toneResult;
      out.push(Native.tonePlaying ? { ok: 2, text: 'Sound test playing. Lock your phone for 10 seconds, then come back.' }
        : !tr ? { ok: 2, text: 'Lock-screen sound not tested yet. Tap "Test lock-screen sound" below, lock the phone for 10 seconds, then come back.' }
        : tr.ok ? { ok: 1, text: 'Sound keeps playing on the lock screen' }
        : { ok: 0, text: 'Sound stopped when the screen locked. The app shell needs a fix and a rebuild in Xcode; tell Claude.' });
    }
    var n = Object.keys(videos).length;
    out.push({ ok: 1, text: n + ' video' + (n === 1 ? '' : 's') + ' on your shelf, saved ' + (Native.inApp ? 'on this phone' : 'in this browser') });
    return out;
  }
  function updateDot() {
    var dot = $('#statusDot'); if (!dot) return;
    var c = checks(), bad = c.filter(function (x) { return x.ok === 0; }), wait = c.some(function (x) { return x.ok === 2; });
    var state = bad.length ? 'bad' : wait ? 'wait' : 'good';
    dot.className = 'dot ' + state;
    var label = bad.length ? 'Needs a look' : wait ? 'Getting ready' : current ? 'All good: saving your spot' : 'All good';
    $('#statusText').textContent = label;
    $('#statusBtn').setAttribute('aria-label', 'Self-check: ' + label + '. Show details.');
    if ($('#checkDlg').open) fillCheck();
    updateFoot();
  }
  function pulse() { var d = $('#statusDot'); if (!d || reduced()) return; d.classList.remove('pulse'); void d.offsetWidth; d.classList.add('pulse'); }
  function updateFoot() {
    var el = $('#lastSaved'); if (!el) return;
    if (!lastSavedAt) { el.textContent = ''; return; }
    var s = Math.round((Date.now() - lastSavedAt) / 1000);
    el.textContent = 'Last saved ' + (s < 5 ? 'just now' : s < 60 ? s + ' seconds ago' : Core.ago(lastSavedAt));
  }
  function fillCheck() {
    $('#checkList').innerHTML = checks().map(function (x) {
      return '<li class="' + (x.ok === 1 ? 'ok' : x.ok === 2 ? 'wait' : 'bad') + '"><span class="ic" aria-hidden="true">' + (x.ok === 1 ? '✓' : x.ok === 2 ? '…' : '!') + '</span><span>' + esc(x.text) + '</span></li>';
    }).join('');
  }
  function openDlg(d) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  if (!window.HTMLDialogElement) document.addEventListener('click', function (e) { if (e.target.closest('[data-act="dismiss"]')) { var d = e.target.closest('dialog'); if (d) d.removeAttribute('open'); } });
  function openCheck() { fillCheck(); openDlg($('#checkDlg')); }
  setInterval(updateDot, 5000);
  window.addEventListener('online', updateDot); window.addEventListener('offline', updateDot);

  // ---------- Send to iPhone ----------
  function openSend() {
    capture(true);
    var base = location.origin + location.pathname + '#shelf=';
    var total = Object.keys(videos).length;
    var full = Core.encodeShelf(videos), inLink = Object.keys(Core.decodeShelf(full)).length;
    $('#sendLink').value = base + full;
    var note = [];
    if (!isPhone) {
      var box = $('#qr');
      try {
        // The code leaves out titles and old videos so a camera can read it easily; the phone looks titles up
        var small = Core.encodeShelf(videos, 600, false), inCode = Object.keys(Core.decodeShelf(small)).length;
        var q = qrcode(0, 'L'); q.addData(base + small); q.make();
        box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        if (inCode < total) note.push('The code carries your ' + inCode + ' most recent videos. The link below carries ' + (inLink < total ? inLink : 'all ' + total) + '.');
      } catch (e) { box.innerHTML = '<p class="qr-fail">Your shelf is too big for one code. Use Copy link and send it to yourself instead.</p>'; }
    }
    if (inLink < total && (isPhone || !note.length)) note.push('The link carries your ' + inLink + ' most recent videos.');
    $('#qrNote').textContent = note.join(' ');
    $('#qrNote').hidden = !note.length;
    openDlg($('#sendDlg'));
  }
  function copyText(text, el) {
    var manual = function () { el.focus(); el.select(); toast(isPhone ? 'Tap and hold the link to copy it.' : 'Press ⌘C to copy the selected link.'); };
    try { navigator.clipboard.writeText(text).then(function () { toast(isPhone ? 'Link copied. Send it to your Mac (AirDrop or Messages) and open it there.' : 'Link copied. Send it to your iPhone and open it there.'); }, manual); }
    catch (e) { manual(); }
  }
  function importFromHash() {
    var m = location.hash.match(/^#shelf=([A-Za-z0-9_-]+)/);
    if (!m) return;
    importShelf(m[1]);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }
  function importShelf(code) {
    try {
      var r = Core.merge(videos, Core.decodeShelf(code));
      videos = r.videos; save();
      Object.keys(videos).forEach(function (id) { if (!videos[id].title) fetchTitle(id); });
      var n = r.added + r.updated;
      toast(n ? 'Got your shelf: ' + r.added + ' new, ' + r.updated + ' updated.' : 'Your shelf was already up to date.');
    } catch (e) { toast('That shelf link looks broken. Make a new one on your Mac with Send to iPhone.', 'warn'); }
  }

  // ---------- start ----------
  if (Native.inApp) {
    $('#toneBtn').hidden = false;
    $('#saveWhere').textContent = 'Saved on this phone';
    // The phone's own storage is the safe copy: bring anything it has into this page
    Promise.all([Native.prefGet(KEY), Native.prefGet(PREF)]).then(function (r) {
      try {
        var changed = false;
        if (r[0]) { var m = Core.merge(videos, JSON.parse(r[0])); if (m.added || m.updated) { videos = m.videos; changed = true; } }
        if (r[1]) { var p = JSON.parse(r[1]); for (var k in p) if (!(k in prefs)) prefs[k] = p[k]; }
        if (changed) { save(); render(); }
        else if (!r[0] && Object.keys(videos).length) save();
      } catch (e) {}
    });
  }
  if (isPhone) {
    // On the phone the button sends the other way
    $('#sendLabel').textContent = 'Send to Mac';
    $('#sendH').textContent = 'Send to Mac';
    $('#sendIntro').textContent = "Copy this link and open it on your Mac, for example with AirDrop or Messages. Your Mac's shelf picks up the spots you reached on this phone.";
    $('#qr').hidden = true; $('#sendTip').hidden = true;
    $('#copyLabel').textContent = 'Your shelf link';
  }
  if (standalone) $('#homeHint').hidden = false;
  importFromHash();
  render();
  syncBtn();
  updateDot();
  // On a Mac the box is ready for ⌘V straight away (not on phones: it would pop up the keyboard)
  try { if (matchMedia('(hover: hover) and (pointer: fine)').matches) input.focus({ preventScroll: true }); } catch (e) {}
  if (!canSave) setTimeout(function () { toast('Your browser is blocking saving, so nothing will be remembered. Click the dot for how to fix it.', 'warn'); }, 600);
  // Test hook
  window.__resume = { get videos() { return videos; }, checks: checks, capture: capture, get current() { return current; } };
})();
