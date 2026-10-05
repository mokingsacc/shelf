// Gemini: summaries, Step 2 notes and drafted Anki cards from a YouTube link. The key stays on the phone and only
// the link, the prompt and Mo's short mark note are sent. Pure helpers are exported for the Node tests.
var AI = (function () {
  var KEY = 'shelf.v3.ai', KEY_PREF = 'gemini.key', PROMPT_VERSION = 1;
  // Free models, best first. The second name in each list is Google's moving alias, used if the first is retired.
  var MODELS = ['gemini-3.8-flash', 'gemini-flash-latest'], LITE = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest'];
  var API = 'https://generativelanguage.googleapis.com/v1beta/models/';
  var DAY_SECS = 8 * 3600, AUTO_STOP = 6 * 3600, AUTO_MAX = 10, AUTO_MAX_LEN = 3600, AGENTIC_OVER = 1200, CACHE_MAX = 300;
  var CLIP_BEFORE = 90, CLIP_AFTER = 30, CACHE_BYTES = 400000;

  var MSG = {
    key: 'Google says the key is wrong. Paste it again.',
    nokey: 'No Gemini key yet. Tap to add one.',
    busy: 'Gemini is busy. Trying again in a minute.',
    busyGave: 'Gemini is still busy. Try again in a few minutes.',
    daily: 'Free video limit used for today. It resets at 8am.',
    private: "Gemini can't watch this video (it isn't public).",
    offline: "No internet. Will try when you're back online.",
    garbled: "Gemini's answer came back garbled. Try again.",
    slow: 'Gemini took too long on this one. Try again later.',
    blocked: "Gemini wouldn't answer for this video.",
    model: "Google renamed its Gemini models, so Shelf can't reach one. Tell Claude.",
    web: 'AI works in the iPhone app'
  };

  // ----- time and dates -----
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  // "3:12", "03:12", "1:02:03", 192 or "192" -> seconds (null when it isn't a time)
  function parseT(t) {
    if (typeof t === 'number') return isFinite(t) && t >= 0 ? Math.floor(t) : null;
    var m = String(t || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (m) return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]);
    return /^\d+$/.test(String(t || '').trim()) ? +String(t).trim() : null;
  }
  // Google's free day runs on Pacific time (midnight there is 8am in the UK, 7am for the week the clocks differ)
  var pacFmt = null;
  function pacificDay(t) {
    try {
      pacFmt = pacFmt || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
      return pacFmt.format(new Date(t));
    } catch (e) { var d = new Date(t - 8 * 3600e3); return d.toISOString().slice(0, 10); }
  }
  function nextReset(t) {
    var day = pacificDay(t), h = Math.ceil(t / 3600e3) * 3600e3;
    for (var i = 0; i < 27; i++, h += 3600e3) if (pacificDay(h) !== day) return h;
    return t + 24 * 3600e3;
  }
  function resetText(t) {
    var d = new Date(nextReset(t)), h = d.getHours(), m = d.getMinutes();
    return (h % 12 || 12) + (m ? ':' + (m < 10 ? '0' : '') + m : '') + (h < 12 ? 'am' : 'pm');
  }
  function hours(secs) { var h = secs / 3600; return h > 0 && h < 0.1 ? '0.1' : String(Math.round(h * 10) / 10); }

  // ----- prompts -----
  var CARD_SHAPE = '{"stem":"a short case with only the findings that matter, under 30 words, in full sentences",' +
    '"questions":["What is the diagnosis?","What is the next step?"],' +
    '"answer":"one full spoken sentence answering the first question, key words in **bold**",' +
    '"management":"one full spoken sentence answering the second question (empty string if there is only one question)",' +
    '"vs":"Versus <one look-alike>: <the finding you would see>, so <what changes>.",' +
    '"why":"one easy-to-remember sentence giving the reason"}';
  var JSON_ONLY = ' Reply with JSON only, no other text.';
  function isQuestionVideo(title) { return /\bHY\b|\bQ\s*#|#\s*\d|question|\bQs?\b/i.test(title || ''); }
  function summaryPrompt(o) {
    return 'Watch this YouTube video' + (o.title ? ' ("' + o.title + '")' : '') + ' and summarise it' +
      (o.med ? ' for a medical student preparing for USMLE Step 2 CK. Keep what is high-yield for the exam' : '') + '.' +
      ' Give a one-line gist (under 20 words) and 3 to 5 key points in the order they come, each with the time (m:ss or h:mm:ss) where that point starts in the video.' +
      ' Keep drug and disease names exactly as said.' + JSON_ONLY +
      ' Shape: {"gist":"…","points":[{"t":"3:12","text":"one short sentence"}]}';
  }
  function notesPrompt(o) {
    if (!o.med) {
      return 'Watch this YouTube video' + (o.title ? ' ("' + o.title + '")' : '') + ' and make short notes: the topic in a few words and 5 to 10 plain bullets in order, each with the time (m:ss) it comes up.' +
        JSON_ONLY + ' Shape: {"topic":"…","bullets":[{"t":"3:12","text":"…"}]}';
    }
    return 'Watch this medical YouTube video' + (o.title ? ' ("' + o.title + '")' : '') + ' and make USMLE Step 2 CK study notes.' +
      ' topic: the topic in a few words. facts: 5 to 12 high-yield facts as short lines, each with the time (m:ss) it is said.' +
      ' tested: 1 to 4 ways it is tested, each as the classic vignette clue, the diagnosis, and the next best step.' +
      ' versus: 1 to 3 look-alikes, each with the one feature that separates them.' +
      (isQuestionVideo(o.title) ? ' questions: this video works through exam questions, so give every question with its time, the stem\'s key clue, the answer, and why in one line.'
        : ' questions: if the video works through exam questions, give each with its time, the key clue, the answer and why; otherwise an empty list.') +
      ' cards: 1 to 5 Anki cards for the most testable points, each a short case with one or two questions (what is it, then what do you do).' +
      JSON_ONLY + ' Shape: {"topic":"…","facts":[{"t":"3:12","text":"…"}],"tested":[{"clue":"…","dx":"…","next":"…"}],"versus":[{"name":"…","feature":"…"}],' +
      '"questions":[{"t":"3:12","clue":"…","answer":"…","why":"…"}],"cards":[' + CARD_SHAPE + ']}';
  }
  function cardPrompt(o) {
    return 'This is a clip of a medical YouTube video' + (o.title ? ' ("' + o.title + '")' : '') + '. The student marked the moment ' + CLIP_AFTER + ' seconds before the clip ends because it should become an Anki card for USMLE Step 2 CK.' +
      (o.note ? ' Their note on the moment, which is what the card must be about: "' + String(o.note).slice(0, 200) + '".' : ' Make the card about the main testable point at that moment.') +
      ' Draft ONE card: a short case, then one or two questions (what is it, then what do you do). Never a mechanism question unless the mechanism is the tested fact.' +
      JSON_ONLY + ' Shape: ' + CARD_SHAPE;
  }

  // ----- the request (one place, so a change in Google's API is one edit) -----
  function videoUrl(vid) { return 'https://www.youtube.com/watch?v=' + vid; }
  function clip(t, dur) {
    t = Math.max(0, Math.floor(t || 0));
    var s = Math.max(0, t - CLIP_BEFORE), e = t + CLIP_AFTER;
    if (dur > 0) { e = Math.min(e, Math.floor(dur)); if (e - s < 30) s = Math.max(0, e - 30); }
    if (e <= s) e = s + 30;
    return { start: s, end: e };
  }
  // processing: 'AGENTIC', 'STATIC' or '' (leave it to Gemini)
  function requestBody(o) {
    var video = { fileData: { fileUri: videoUrl(o.vid) } };
    if (o.clip) video.videoMetadata = { startOffset: o.clip.start + 's', endOffset: o.clip.end + 's' };
    if (o.processing) video.mediaProcessing = o.processing;
    return { contents: [{ role: 'user', parts: [video, { text: o.prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } };
  }
  function endpoint(model) { return API + model + ':generateContent'; }
  function testBody() { return { contents: [{ role: 'user', parts: [{ text: 'Reply OK' }] }], generationConfig: { maxOutputTokens: 20 } }; }

  // ----- replies -----
  function parseJSON(text) {
    if (text && typeof text === 'object') return text;
    var s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    try { return JSON.parse(s); } catch (e) {}
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
    return null;
  }
  // The model's text out of a generateContent reply; { blocked } when Gemini refused
  function replyText(raw) {
    var r = parseJSON(raw); if (!r) return { text: null };
    var c = r.candidates && r.candidates[0];
    if (!c) return { text: null, blocked: !!(r.promptFeedback && r.promptFeedback.blockReason) };
    var parts = (c.content && c.content.parts) || [];
    var t = parts.filter(function (p) { return p && p.text && !p.thought; }).map(function (p) { return p.text; }).join('');
    return { text: t || null, blocked: !t && /SAFETY|BLOCK|PROHIBITED|RECITATION/.test(c.finishReason || '') };
  }
  function str(x, n) { return String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n || 600); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function timed(list) { return arr(list).map(function (p) { return p && { t: parseT(p.t), text: str(p.text) }; }).filter(function (p) { return p && p.text; }); }
  function normCard(c) {
    if (!c || typeof c !== 'object') return null;
    var qs = (Array.isArray(c.questions) ? c.questions : [c.questions]).map(function (q) { return str(q, 200); }).filter(Boolean).slice(0, 2);
    var card = { stem: str(c.stem, 400), questions: qs, answer: str(c.answer), management: qs.length > 1 ? str(c.management) : '', vs: str(c.vs, 400), why: str(c.why, 400) };
    return card.answer && qs.length ? card : null;
  }
  // Checked, trimmed results (null = not usable, ask again)
  function clean(kind, v) {
    if (!v || typeof v !== 'object') return null;
    if (kind === 'summary') {
      var pts = timed(v.points).slice(0, 6);
      return pts.length ? { gist: str(v.gist, 200), points: pts } : null;
    }
    if (kind === 'card') return normCard(v.card || v);
    if (kind === 'notes') {
      var n = { topic: str(v.topic, 120), facts: timed(v.facts).slice(0, 15), bullets: timed(v.bullets).slice(0, 12),
        tested: arr(v.tested).map(function (x) { return x && { clue: str(x.clue), dx: str(x.dx, 200), next: str(x.next) }; }).filter(function (x) { return x && (x.clue || x.dx); }).slice(0, 6),
        versus: arr(v.versus).map(function (x) { return x && { name: str(x.name, 120), feature: str(x.feature) }; }).filter(function (x) { return x && x.name; }).slice(0, 4),
        questions: arr(v.questions).map(function (x) { return x && { t: parseT(x.t), clue: str(x.clue), answer: str(x.answer, 300), why: str(x.why) }; }).filter(function (x) { return x && x.answer; }).slice(0, 40),
        cards: arr(v.cards).map(normCard).filter(Boolean).slice(0, 8) };
      return n.facts.length || n.bullets.length || n.cards.length ? n : null;
    }
    return null;
  }
  // Errors in plain words. kind: key, busy, daily, private, offline, model, other
  function classify(status, text) {
    var t = String(text || ''), err = parseJSON(t), m = (err && err.error && (err.error.message + ' ' + (err.error.status || '') + ' ' + JSON.stringify(err.error.details || ''))) || t;
    if (!status) return { kind: 'offline', msg: MSG.offline };
    if (status === 504 && t === 'slow') return { kind: 'slow', msg: MSG.slow };
    if (/API.?key|API_KEY|unregistered callers|credential/i.test(m) && status !== 429) return { kind: 'key', msg: MSG.key };
    if (status === 404 || /models\/[^ ]* is not found|not supported for generateContent|model.*not found/i.test(m)) return { kind: 'model', msg: MSG.model };
    if (status === 429) return /per.?day|PerDay|daily/i.test(m) ? { kind: 'daily', msg: MSG.daily } : { kind: 'busy', msg: MSG.busy };
    if (status >= 500) return { kind: 'busy', msg: MSG.busy };
    if (/media.?processing|AGENTIC|STATIC/i.test(m) && status === 400) return { kind: 'processing', msg: MSG.garbled };
    if (/youtube|video|file.?uri|file.?data|url|private|unavailable|not accessible|cannot (be )?(fetch|access)/i.test(m)) return { kind: 'private', msg: MSG.private };
    if (status === 401 || status === 403) return { kind: 'key', msg: MSG.key };
    return { kind: 'other', msg: "Gemini couldn't do this one (error " + status + '). Try again later.' };
  }
  // The watch page tells a video's length and whether anyone can watch it
  function parseWatch(html) {
    var s = String(html || ''), len = s.match(/"lengthSeconds":"(\d+)"/), ps = s.match(/"playabilityStatus":\{"status":"([A-Z_]+)"/);
    return { secs: len ? +len[1] : 0, open: !ps || ps[1] === 'OK' };
  }

  // ----- turning results into text -----
  function notesText(n, title, vid) {
    var L = ['# ' + (title || 'Video notes'), ''];
    if (n.topic) L.push(n.topic, '');
    var at = function (t) { return t != null ? '[' + fmt(t) + '] ' : ''; };
    if (n.facts.length) { L.push('## High-yield'); n.facts.forEach(function (f) { L.push('- ' + at(f.t) + f.text); }); L.push(''); }
    if (n.bullets.length) { n.bullets.forEach(function (f) { L.push('- ' + at(f.t) + f.text); }); L.push(''); }
    if (n.tested.length) { L.push("## How it's tested"); n.tested.forEach(function (x) { L.push('- ' + [x.clue, x.dx, x.next].filter(Boolean).join(' → ')); }); L.push(''); }
    if (n.versus.length) { L.push('## Versus'); n.versus.forEach(function (x) { L.push('- ' + x.name + (x.feature ? ': ' + x.feature : '')); }); L.push(''); }
    if (n.questions.length) { L.push('## Questions'); n.questions.forEach(function (x) { L.push('- ' + at(x.t) + (x.clue ? x.clue + ' → ' : '') + x.answer + (x.why ? ' (' + x.why + ')' : '')); }); L.push(''); }
    if (vid) L.push(videoUrl(vid));
    return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function cardLine(c) { var M = typeof Marks !== 'undefined' ? Marks : require('./marks.js'); return M.cardLine(c); }
  function notesAnki(n) { return n.cards.map(cardLine).filter(Boolean).join('\n'); }

  function cacheKey(vid, kind) { return vid + '|' + kind + '|v' + PROMPT_VERSION; }

  // io: { load(k), save(k, s), now(), post(url, body, headers) -> Promise<{status, text}>, key() -> string,
  //       wait(ms) -> Promise, onChange() }
  function create(io) {
    var now = io.now || Date.now, wait = io.wait || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var state = read(), jobs = {}, queue = [], running = false, waiting = false, held = [];
    function read() {
      var s = null;
      try { s = JSON.parse(io.load(KEY) || 'null'); } catch (e) { s = null; }
      if (!s || typeof s !== 'object') s = {};
      if (!s.cache || typeof s.cache !== 'object') s.cache = {};
      if (!s.used || typeof s.used !== 'object') s.used = {};
      if (!s.auto || typeof s.auto !== 'object') s.auto = {};
      if (!s.lens || typeof s.lens !== 'object') s.lens = {};
      s.mi = s.mi | 0; s.li = s.li | 0;
      return s;
    }
    function save() {
      var keep = Object.keys(state.used).concat(Object.keys(state.auto)).sort().slice(-14)[0] || '', u = {}, a = {};
      Object.keys(state.used).forEach(function (d) { if (d >= keep) u[d] = state.used[d]; });
      Object.keys(state.auto).forEach(function (d) { if (d >= keep) a[d] = state.auto[d]; });
      state.used = u; state.auto = a;
      var ks = Object.keys(state.cache).sort(function (x, y) { return state.cache[x].at - state.cache[y].at; });
      if (ks.length > CACHE_MAX) ks.splice(0, ks.length - CACHE_MAX).forEach(function (k) { delete state.cache[k]; });
      var lk = Object.keys(state.lens); if (lk.length > 500) lk.slice(0, lk.length - 500).forEach(function (k) { delete state.lens[k]; });
      state.saved = now();
      // Kept small: it's mirrored to the phone and shares the web view's storage with your spots
      var out = JSON.stringify(state);
      while (out.length > CACHE_BYTES && ks.length) { delete state.cache[ks.shift()]; out = JSON.stringify(state); }
      io.save(KEY, out);
    }
    function changed() { if (io.onChange) try { io.onChange(); } catch (e) {} }
    function today() { return pacificDay(now()); }
    function usedToday() { return state.used[today()] || 0; }
    function autoToday() { return state.auto[today()] || 0; }
    function get(vid, kind) { var c = state.cache[cacheKey(vid, kind)]; return c ? c.v : null; }
    function put(vid, kind, v) { state.cache[cacheKey(vid, kind)] = { at: now(), v: v }; }
    function status(vid, kind) {
      var j = jobs[cacheKey(vid, kind)];
      if (get(vid, kind) && (!j || j.state === 'done')) return { state: 'ready' };
      return j ? { state: j.state, msg: j.msg || '' } : { state: 'none' };
    }
    // Why an automatic summary would not run now ('' = it can)
    function autoBlock(secs) {
      if (!io.key()) return 'nokey';
      if (!(secs > 0)) return 'length';
      if (secs > AUTO_MAX_LEN) return 'long';
      if (autoToday() >= AUTO_MAX) return 'count';
      if (usedToday() + secs > AUTO_STOP) return 'budget';
      return '';
    }
    function dailyMsg() { return MSG.daily.replace('8am', resetText(now())); }

    // o: { vid, kind: summary|notes|card, title, med, secs (video length), t (card), note, auto, force }
    function request(o) {
      var kind = o.kind, ck = cacheKey(o.vid, kind === 'card' ? 'card@' + Math.floor(o.t || 0) : kind);
      if (!o.force && kind !== 'card' && get(o.vid, kind)) return Promise.resolve(get(o.vid, kind));
      if (jobs[ck] && jobs[ck].promise && /queued|working|busy/.test(jobs[ck].state)) {
        if (!o.auto && jobs[ck].auto) { jobs[ck].auto = false; queue.sort(order); }
        return jobs[ck].promise;
      }
      if (!io.key()) return Promise.reject({ kind: 'nokey', msg: MSG.nokey });
      var c = kind === 'card' ? clip(o.t, o.secs) : null, secs = c ? c.end - c.start : (o.secs || 0);
      if (secs > DAY_SECS) return Promise.reject({ kind: 'daily', msg: 'This video is longer than the 8 free video hours a day.' });
      if (usedToday() + secs > DAY_SECS) return Promise.reject({ kind: 'daily', msg: dailyMsg() });
      var job = { key: ck, o: o, kind: kind, clip: c, secs: secs, auto: !!o.auto, tries: 0, state: 'queued', msg: '', at: now(), notBefore: 0 };
      job.promise = new Promise(function (res, rej) { job.res = res; job.rej = rej; });
      job.promise.catch(function () {});
      jobs[ck] = job; queue.push(job); queue.sort(order);
      changed(); pump();
      return job.promise;
    }
    // Taps first, then automatic ones newest first
    function order(a, b) { return (a.auto - b.auto) || (a.auto ? b.at - a.at : a.at - b.at); }
    function pump() {
      if (running) return;
      var t = now(), i = 0;
      while (i < queue.length && queue[i].notBefore > t) i++;
      if (i >= queue.length) {
        // Only jobs waiting out a busy spell: look again then (a new tap meanwhile still goes straight away)
        if (queue.length && !waiting) { var soon = Math.min.apply(null, queue.map(function (j) { return j.notBefore; })); waiting = true; wait(Math.max(50, soon - t)).then(function () { waiting = false; pump(); }); }
        return;
      }
      var job = queue.splice(i, 1)[0];
      if (job.auto && autoBlock(job.secs)) { finish(job, null, { kind: 'skipped', msg: '' }); return pump(); }
      running = true; job.state = 'working'; job.msg = ''; changed();
      if (job.auto && !job.counted) { job.counted = true; state.auto[today()] = autoToday() + 1; save(); }
      var done = function () { running = false; pump(); };
      run(job).then(function (v) { finish(job, v); }, function (e) { failed(job, e); }).then(done, done);
    }
    function finish(job, v, err) {
      if (err) { job.state = err.kind === 'skipped' ? 'none' : 'error'; job.msg = err.msg; job.rej(err); }
      else { job.state = 'done'; job.msg = ''; job.res(v); }
      if (job.state === 'none') delete jobs[job.key];
      changed();
    }
    function failed(job, e) {
      e = e && e.kind ? e : { kind: 'other', msg: "Gemini couldn't do this one. Try again later." };
      if (e.kind === 'busy' && job.tries < 3) {
        job.tries++; job.lite = true; job.notBefore = now() + 60e3; job.state = 'busy'; job.msg = MSG.busy; queue.push(job); queue.sort(order); changed(); return;
      }
      if (e.kind === 'busy') e = { kind: 'busy', msg: MSG.busyGave };
      // No internet: summaries and notes wait for it; a card says so (its mark offers Draft again)
      if (e.kind === 'offline' && job.kind !== 'card') { job.state = 'offline'; job.msg = MSG.offline; held.push(job); changed(); return; }
      if (e.kind === 'daily') e = { kind: 'daily', msg: dailyMsg() };
      state.last = { kind: e.kind, msg: e.msg, at: now() }; save();
      finish(job, null, e);
    }
    // Back online: the ones that failed for want of internet go again
    function retryHeld() { var h = held; held = []; h.forEach(function (j) { j.state = 'queued'; j.msg = ''; queue.push(j); }); queue.sort(order); if (h.length) { changed(); pump(); } }

    function post(body, lite) {
      var list = lite ? LITE : MODELS, idx = lite ? 'li' : 'mi';
      var model = list[Math.min(state[idx], list.length - 1)];
      return Promise.resolve().then(function () { return io.post(endpoint(model), body, { 'x-goog-api-key': io.key() }); })
        .then(function (r) { return r || { status: 0, text: '' }; }, function () { return { status: 0, text: '' }; })
        .then(function (r) {
          if (r.status >= 200 && r.status < 300) return r;
          var c = classify(r.status, r.text);
          if (c.kind === 'model' && state[idx] < list.length - 1) { state[idx]++; save(); return post(body, lite); }
          throw c;
        });
    }
    function run(job) {
      var o = job.o, prompt = job.kind === 'summary' ? summaryPrompt(o) : job.kind === 'notes' ? notesPrompt(o) : cardPrompt(o);
      var processing = job.clip ? 'STATIC' : (!state.noAgentic && job.secs > AGENTIC_OVER ? 'AGENTIC' : '');
      // Every answer that came back means Gemini watched the video: each one counts against the free hours
      var spend = function () { state.used[today()] = usedToday() + job.secs; save(); };
      var attempt = function (proc, again) {
        return post(requestBody({ vid: o.vid, prompt: prompt, clip: job.clip, processing: proc }), job.lite).then(function (r) {
          spend();
          var rt = replyText(r.text);
          if (rt.blocked) throw { kind: 'blocked', msg: MSG.blocked };
          var v = clean(job.kind, parseJSON(rt.text));
          if (!v) { if (!again) return attempt(proc, true); throw { kind: 'garbled', msg: MSG.garbled }; }
          return v;
        }, function (e) {
          if (e.kind === 'slow') spend();
          // Refused with a processing setting (whatever the wording): once without it
          if (proc && /processing|private|other/.test(e.kind)) { if (proc === 'AGENTIC') { state.noAgentic = true; save(); } return attempt('', again); }
          throw e;
        });
      };
      return attempt(processing, false).then(function (v) {
        if (job.kind !== 'card') put(o.vid, job.kind, v);
        state.last = { kind: 'ok', msg: '', at: now() };
        save();
        return v;
      });
    }
    // The self-check's tiny text-only call
    function test() {
      if (!io.key()) return Promise.resolve({ ok: false, kind: 'nokey', msg: MSG.nokey });
      return post(testBody(), false).then(function () { state.last = { kind: 'ok', msg: '', at: now() }; save(); return { ok: true }; },
        function (e) { var r = { ok: false, kind: e.kind, msg: e.kind === 'daily' ? dailyMsg() : e.msg }; if (e.kind !== 'offline') { state.last = { kind: e.kind, msg: r.msg, at: now() }; save(); } return r; });
    }
    // Video lengths read from YouTube, kept so a refresh doesn't fetch the same pages again
    function len(vid) { return state.lens[vid] || null; }
    function setLen(vid, r) { state.lens[vid] = { secs: r.secs | 0, open: !!r.open }; save(); }
    function forget(vid, kind) { delete state.cache[cacheKey(vid, kind)]; delete jobs[cacheKey(vid, kind)]; save(); }
    function clearErrors() { Object.keys(jobs).forEach(function (k) { if (jobs[k].state === 'error') delete jobs[k]; }); state.last = null; save(); changed(); }
    return { request: request, get: get, status: status, autoBlock: autoBlock, test: test, retryHeld: retryHeld, forget: forget, clearErrors: clearErrors, len: len, setLen: setLen,
      usedToday: usedToday, autoToday: autoToday, dailyMsg: dailyMsg, get last() { return state.last || null; }, get busy() { return running || queue.length > 0; },
      get size() { return Object.keys(state.cache).length; } };
  }

  return { create: create, KEY: KEY, KEY_PREF: KEY_PREF, PROMPT_VERSION: PROMPT_VERSION, MODELS: MODELS, LITE: LITE, MSG: MSG, DAY_SECS: DAY_SECS,
    fmt: fmt, parseT: parseT, pacificDay: pacificDay, nextReset: nextReset, resetText: resetText, hours: hours,
    summaryPrompt: summaryPrompt, notesPrompt: notesPrompt, cardPrompt: cardPrompt, isQuestionVideo: isQuestionVideo,
    clip: clip, requestBody: requestBody, endpoint: endpoint, parseJSON: parseJSON, replyText: replyText, clean: clean, classify: classify,
    parseWatch: parseWatch, notesText: notesText, notesAnki: notesAnki, cacheKey: cacheKey };
})();
if (typeof module !== 'undefined') module.exports = AI;
