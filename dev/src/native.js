// The iPhone shell (Capacitor) adds native helpers to this page. Everything here also works without them.
var Native = (function () {
  var Cap = window.Capacitor;
  var inApp = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());

  function call(plugin, method, opts) {
    try {
      var P = Cap && Cap.Plugins && Cap.Plugins[plugin];
      if (P && typeof P[method] === 'function') return Promise.resolve(P[method](opts || {}));
      if (Cap && Cap.nativePromise) return Cap.nativePromise(plugin, method, opts || {});
    } catch (e) { return Promise.reject(e); }
    return Promise.reject(new Error('not in the app'));
  }

  // Durable storage on the phone (survives the web view clearing its own storage)
  function prefGet(key) {
    if (!inApp) return Promise.resolve(null);
    // A failed read rejects (it is not the same as "nothing saved"), so a restore never mistakes it for an empty phone
    return call('Preferences', 'get', { key: key }).then(function (r) { return r && r.value != null ? r.value : null; });
  }
  var pendingSet = {};
  function prefSet(key, value) {
    if (!inApp) return;
    // Coalesce rapid saves into one write per key
    if (pendingSet[key]) { pendingSet[key].value = value; return; }
    pendingSet[key] = { value: value };
    setTimeout(function () {
      var v = pendingSet[key].value; delete pendingSet[key];
      call('Preferences', 'set', { key: key, value: v }).catch(function () { prefError = true; });
    }, 300);
  }
  var prefError = false;

  // Clipboard without Safari's paste bubble
  function readClipboard() {
    if (inApp) return call('Clipboard', 'read').then(function (r) { return (r && r.value) || ''; });
    if (navigator.clipboard && navigator.clipboard.readText) return navigator.clipboard.readText();
    return Promise.reject(new Error('no clipboard'));
  }

  // Web reads from the app go straight to iOS networking. (Plain fetch() GETs get routed through
  // capacitor://localhost, which a page served from github.io can't read, and browsers drop Cookie headers.)
  var SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  // YouTube sends phones a different page (m.youtube.com, data hidden in an escaped string); the desktop one is what Shelf reads
  var DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
  function httpGet(url, headers) {
    var h = { 'User-Agent': /^https:\/\/(www\.|m\.)?youtube\.com\/(?!feeds\/)/.test(url) ? DESKTOP_UA : SAFARI_UA, 'Accept-Language': 'en-GB,en;q=0.9' };
    for (var k in headers || {}) h[k] = headers[k];
    return call('CapacitorHttp', 'request', { url: url, method: 'GET', headers: h, responseType: 'text' }).then(function (r) {
      var d = r && r.data;
      if (d != null && typeof d !== 'string') d = JSON.stringify(d); // iOS pre-parses JSON replies
      return { status: (r && r.status) || 0, ok: r && r.status >= 200 && r.status < 300, text: d == null ? '' : d, unreadable: d == null };
    });
  }

  // A JSON POST (YouTube's "load more" for long playlists), same native route as httpGet
  function httpPost(url, body, headers) {
    var h = { 'User-Agent': SAFARI_UA, 'Accept-Language': 'en-GB,en;q=0.9', 'Content-Type': 'application/json' };
    for (var k in headers || {}) h[k] = headers[k];
    return call('CapacitorHttp', 'request', { url: url, method: 'POST', headers: h, data: body, responseType: 'text' }).then(function (r) {
      var d = r && r.data;
      if (d != null && typeof d !== 'string') d = JSON.stringify(d);
      return { status: (r && r.status) || 0, ok: r && r.status >= 200 && r.status < 300, text: d == null ? '' : d, unreadable: d == null };
    });
  }

  // Can the app read a podcast feed? (needs the shell's native networking: feeds don't allow browser reads)
  var feedStatus = { state: inApp ? 'wait' : 'web', text: '' };
  function testFeed() {
    if (!inApp) return;
    var done = false;
    setTimeout(function () { if (!done) { feedStatus = { state: 'bad', text: "Couldn't reach the Fin vs History feed in 20 seconds. Check your internet." }; } }, 20000);
    httpGet('https://feeds.megaphone.fm/finvshistory').then(function (r) {
      done = true;
      if (!r.ok) { feedStatus = { state: 'bad', text: "Couldn't read the Fin vs History feed (the server said " + r.status + ').' }; return; }
      feedStatus = /<rss|<channel/i.test(r.text) ? { state: 'ok', text: 'Can read podcast feeds' } : { state: 'bad', text: 'The Fin vs History feed came back in a shape Shelf doesn\'t understand.' };
    }).catch(function () { done = true; feedStatus = { state: 'bad', text: "Couldn't read podcast feeds. Check your internet, then close and reopen Shelf. If it keeps happening, tell Claude." }; });
  }

  // Lock-screen sound test: a soft 45-second tone with lock-screen info.
  var TONE_KEY = 'shelf.toneTest';
  var tone = null, toneHiddenAt = 0, toneTimeAtHide = 0;
  function toneResult() { try { return JSON.parse(localStorage.getItem(TONE_KEY) || 'null'); } catch (e) { return null; } }
  function setToneResult(ok, why) { try { localStorage.setItem(TONE_KEY, JSON.stringify({ ok: ok, why: why, at: Date.now() })); } catch (e) {} prefSet(TONE_KEY, JSON.stringify({ ok: ok, why: why, at: Date.now() })); }
  function makeTone(seconds) {
    var rate = 8000, n = rate * seconds, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
    var w = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true);
    v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
    for (var i = 0; i < n; i++) {
      var t = i / rate, pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.5 * t);
      v.setUint8(44 + i, 128 + Math.round(18 * pulse * Math.sin(2 * Math.PI * 330 * t)));
    }
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  function playTone() {
    stopTone();
    tone = new Audio(makeTone(45));
    tone.setAttribute('playsinline', '');
    try {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: 'Lock-screen sound test', artist: 'Shelf', album: 'Self-check' });
        navigator.mediaSession.setActionHandler('pause', function () { tone && tone.pause(); });
        navigator.mediaSession.setActionHandler('play', function () { tone && tone.play(); });
      }
    } catch (e) {}
    tone.addEventListener('ended', function () { if (toneHiddenAt) setToneResult(true, 'played to the end with the screen locked'); stopTone(); });
    return tone.play();
  }
  function stopTone() { if (tone) { try { tone.pause(); } catch (e) {} tone = null; } toneHiddenAt = 0; }
  document.addEventListener('visibilitychange', function () {
    if (!tone) return;
    if (document.visibilityState === 'hidden') { toneHiddenAt = Date.now(); toneTimeAtHide = tone.currentTime; }
    else if (toneHiddenAt) {
      var away = (Date.now() - toneHiddenAt) / 1000, moved = tone.currentTime - toneTimeAtHide;
      if (away > 4) setToneResult(moved > away * 0.6 || tone.ended, moved > away * 0.6 ? 'kept playing while locked' : 'stopped when the screen locked');
      toneHiddenAt = 0;
    }
  });

  // YouTube's consent choice, put in iOS's own cookie store as well as the request header: once YouTube sets
  // cookies of its own, iOS sends the stored ones and drops a hand-written Cookie header
  function consentCookies() {
    var exp = new Date(Date.now() + 365 * 864e5).toUTCString();
    ['https://www.youtube.com', 'https://youtube.com'].forEach(function (u) {
      [['SOCS', 'CAI'], ['CONSENT', 'YES+1']].forEach(function (c) { call('CapacitorCookies', 'setCookie', { url: u, key: c[0], value: c[1], path: '/', expires: exp }).catch(function () {}); });
    });
  }

  // YouTube sign-in, so Premium applies to the player: a sheet in the Shelf shell that shares the web view's
  // cookies (ios/App/App/ShelfSignIn.swift). Older shells don't have it, and the bridge never answers a call to
  // a plugin it doesn't know, so the shell's plugin list is checked first.
  // state: web (a browser), old (shell without the plugin), wait, in, out, unknown (the shell didn't answer)
  function hasPlugin(name) {
    try { return (Cap.PluginHeaders || []).some(function (h) { return h.name === name; }) || !!(Cap.Plugins && Cap.Plugins[name]); } catch (e) { return false; }
  }
  var ytAccount = { state: !inApp ? 'web' : hasPlugin('ShelfSignIn') ? 'wait' : 'old' };
  function setYT(r) { ytAccount = { state: r && r.signedIn ? 'in' : 'out' }; return ytAccount; }
  function checkYT() {
    if (ytAccount.state === 'web' || ytAccount.state === 'old') return Promise.resolve(ytAccount);
    var done = false;
    return new Promise(function (res) {
      setTimeout(function () { if (!done) { done = true; ytAccount = { state: 'unknown' }; res(ytAccount); } }, 5000);
      call('ShelfSignIn', 'status').then(function (r) { if (!done) { done = true; res(setYT(r)); } }, function () { if (!done) { done = true; ytAccount = { state: 'unknown' }; res(ytAccount); } });
    });
  }
  // Opens the sign-in sheet; settles when it closes, saying whether an account is signed in now
  function signInYT() { return call('ShelfSignIn', 'signIn').then(setYT); }
  function signOutYT() { return call('ShelfSignIn', 'signOut').then(function () { return setYT(null); }); }
  // Settings > Shelf, where "Allow Cross-Website Tracking" lets the player see the sign-in
  function openSettings() { return call('ShelfSignIn', 'openSettings'); }

  // Shelf's phone helpers (ios/App/App/ShelfDevice.swift): screen stays on, Sleep dim, the clock's colour, location.
  // Shells installed before 6 Oct 2026 don't have them; then everything carries on without (web wake lock, a strip under the clock).
  var device = inApp && hasPlugin('ShelfDevice');
  function dev(method, opts) { return device ? call('ShelfDevice', method, opts).catch(function () { return null; }) : Promise.resolve(null); }
  function keepAwake(on) { return dev('keepAwake', { on: !!on }); }
  function dim(on) { return dev('dim', { on: !!on }); }
  function statusBar(style) { return dev('statusBar', { style: style }); }
  // A youtube.com page read as the signed-in account (null when this copy of the app can't)
  function youtubeGet(url) { return device ? call('ShelfDevice', 'youtubeGet', { url: url }) : Promise.resolve(null); }
  // Sleep timer for the YouTube app after Play locked: pause it after this many minutes (0 cancels)
  function stopOthersAfter(minutes) { return dev('stopOthersAfter', { minutes: Math.max(0, minutes || 0) }); }
  function locate() { return device ? call('ShelfDevice', 'locate') : Promise.reject(new Error('This copy of the Shelf app has no location yet.')); }

  if (inApp) {
    document.documentElement.classList.add('in-app');
    try { consentCookies(); } catch (e) {}
    setTimeout(testFeed, 1500);
    checkYT();
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkYT(); });
  }
  return { inApp: inApp, call: call, httpGet: httpGet, httpPost: httpPost, prefGet: prefGet, prefSet: prefSet, get prefError() { return prefError; },
    readClipboard: readClipboard, get feedStatus() { return feedStatus; }, playTone: playTone, stopTone: stopTone,
    get toneResult() { return toneResult(); }, get tonePlaying() { return !!tone; },
    get ytAccount() { return ytAccount; }, checkYT: checkYT, signInYT: signInYT, signOutYT: signOutYT, openSettings: openSettings,
    device: device, canLocate: device, keepAwake: keepAwake, dim: dim, statusBar: statusBar, locate: locate, youtubeGet: youtubeGet, stopOthersAfter: stopOthersAfter };
})();
