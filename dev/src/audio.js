// Podcast player engine: one <audio> element, resume per episode, sleep timer, lock-screen controls.
// No layout here; the UI calls these functions and redraws on onChange. Tested in test/audio.test.cjs with a fake element.
var AudioEngine = (function () {
  var BACK = 15, FWD = 30;

  // opts: { el, load(guid) -> record|null, save(guid, record), now(), onChange(state), mediaSession, MediaMetadata }
  function create(opts) {
    var el = opts.el, now = opts.now || Date.now;
    var ms = opts.mediaSession === undefined ? (typeof navigator !== 'undefined' && navigator.mediaSession) : opts.mediaSession;
    var MM = opts.MediaMetadata || (typeof MediaMetadata !== 'undefined' ? MediaMetadata : null);
    var ep = null, armed = false, startAt = 0, timer = null, lastSave = 0, rate = 1, stopReason = '';

    function changed() { if (opts.onChange) opts.onChange(state()); }
    function rec() { return ep ? opts.load(ep.guid) : null; }

    // Save the spot, but only once playback really started where we asked (same guard as the YouTube player)
    function capture(force) {
      if (!ep || !armed) return;
      var t = el.currentTime, dur = el.duration;
      if (!(t >= 1) || !isFinite(t)) return;
      var r = rec() || {};
      var d = isFinite(dur) && dur > 0 ? dur : (ep.duration || r.dur || 0);
      var done = !!r.done || Core.isDone(t, d);
      if (!force && Math.abs((r.t || 0) - t) < 1 && r.done === done) return;
      opts.save(ep.guid, { t: t, dur: d, done: done, updated: now(), podcast: ep.podcast || '', title: ep.title || '', url: ep.url });
      lastSave = now();
    }

    function play(episode, from) {
      if (ep && ep.guid !== episode.guid) capture(true);
      ep = episode; armed = false; stopReason = '';
      var r = rec();
      startAt = from != null ? from : Core.resumeAt(r);
      if (el.src !== episode.url) { el.src = episode.url; if (el.load) el.load(); }
      el.playbackRate = rate;
      var go = function () {
        try { if (startAt > 0) el.currentTime = startAt; } catch (e) {}
        return el.play();
      };
      // Seeking before metadata is ignored on iOS, so wait for it when needed
      var p = el.readyState >= 1 ? go() : new Promise(function (res, rej) {
        var once = function () { el.removeEventListener('loadedmetadata', once); Promise.resolve(go()).then(res, rej); };
        el.addEventListener('loadedmetadata', once);
      });
      setSession();
      changed();
      return Promise.resolve(p).catch(function (e) { stopReason = 'Tap play to start (' + (e && e.name || 'blocked') + ').'; changed(); });
    }
    function toggle() { if (!ep) return; if (el.paused) el.play(); else el.pause(); }
    function pause() { if (ep && !el.paused) el.pause(); }
    function seek(t) {
      if (!ep) return;
      var d = el.duration; t = Math.max(0, isFinite(d) ? Math.min(t, d - 1) : t);
      el.currentTime = t; armed = true; capture(true); changed();
    }
    function seekBy(s) { seek((el.currentTime || 0) + s); }
    function setRate(r) { rate = r; el.playbackRate = r; changed(); }

    // ----- Sleep timer -----
    function setTimer(minutes) {
      timer = minutes == null ? null : SleepTimer.start(minutes, now());
      el.volume = 1;
      changed();
      return timer;
    }
    function check(ended) {
      if (!timer) return;
      el.volume = SleepTimer.volume(timer, now());
      if (SleepTimer.tick(timer, now(), ended) === 'stop') {
        timer = null; capture(true);
        if (!el.paused) el.pause();
        el.volume = 1;
        stopReason = 'Sleep timer stopped it.';
        changed();
      }
    }

    // ----- Lock screen -----
    function setSession() {
      if (!ms || !ep) return;
      try {
        if (MM) ms.metadata = new MM({ title: ep.title || 'Episode', artist: ep.podcast || '', album: 'Shelf',
          artwork: ep.image ? [{ src: ep.image, sizes: '512x512' }] : [] });
        var h = {
          play: function () { el.play(); }, pause: function () { el.pause(); },
          seekbackward: function () { seekBy(-BACK); }, seekforward: function () { seekBy(FWD); },
          seekto: function (d) { if (d && d.seekTime != null) seek(d.seekTime); },
          previoustrack: null, nexttrack: null
        };
        Object.keys(h).forEach(function (k) { try { ms.setActionHandler(k, h[k]); } catch (e) {} });
      } catch (e) {}
    }
    function setPosition() {
      if (!ms || !ms.setPositionState || !ep) return;
      var d = el.duration;
      if (!(isFinite(d) && d > 0)) return;
      try { ms.setPositionState({ duration: d, position: Math.min(el.currentTime || 0, d), playbackRate: el.playbackRate || 1 }); } catch (e) {}
    }

    // ----- Element events -----
    el.addEventListener('playing', function () {
      if (!armed && Math.abs((el.currentTime || 0) - startAt) < 15) armed = true;
      if (ms) try { ms.playbackState = 'playing'; } catch (e) {}
      setPosition(); changed();
    });
    el.addEventListener('pause', function () { capture(true); if (ms) try { ms.playbackState = 'paused'; } catch (e) {} changed(); });
    // timeupdate keeps firing while the phone is locked, so the timer is checked here as well as by the UI's clock
    el.addEventListener('timeupdate', function () {
      check(false);
      if (now() - lastSave >= 5000) capture(false);
    });
    el.addEventListener('ended', function () {
      armed = true;
      if (ep) { var r = rec() || {}; opts.save(ep.guid, Object.assign({}, r, { t: el.duration || r.t || 0, dur: el.duration || r.dur || 0, done: true, updated: now(), url: ep.url, title: ep.title || '', podcast: ep.podcast || '' })); }
      check(true); changed();
    });
    el.addEventListener('error', function () {
      stopReason = "Couldn't play this episode. The podcast's server didn't send audio; check your internet, or the link may have expired.";
      changed();
    });
    el.addEventListener('ratechange', setPosition);
    el.addEventListener('durationchange', setPosition);

    function state() {
      return {
        episode: ep, playing: !!ep && !el.paused, t: el.currentTime || 0, dur: isFinite(el.duration) ? el.duration : (ep && ep.duration) || 0,
        rate: rate, timer: timer, timerLabel: SleepTimer.label(timer, now()), timerClock: timer && timer.mode === 'min' ? SleepTimer.clock(timer.endsAt) : '',
        message: stopReason
      };
    }
    return { play: play, toggle: toggle, pause: pause, seek: seek, seekBy: seekBy, setRate: setRate, setTimer: setTimer,
      tick: function () { check(false); }, capture: capture, state: state, BACK: BACK, FWD: FWD };
  }
  return { create: create };
})();
if (typeof module !== 'undefined') module.exports = AudioEngine;
