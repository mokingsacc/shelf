// Sleep timer maths. Pure; the player code calls tick() once a second and acts on what it returns.
var SleepTimer = (function () {
  var PRESETS = [15, 30, 45, 60];
  function start(minutes, now) {
    now = now || Date.now();
    if (minutes === 'end') return { mode: 'end', startedAt: now };
    minutes = Number(minutes);
    if (!(minutes > 0)) return null;
    return { mode: 'min', minutes: minutes, startedAt: now, endsAt: now + minutes * 60000 };
  }
  // ms left, or null for "end of video" / no timer
  function remaining(state, now) {
    if (!state || state.mode !== 'min') return null;
    return Math.max(0, state.endsAt - (now || Date.now()));
  }
  function countdown(ms) {
    var s = Math.ceil(ms / 1000), m = Math.floor(s / 60), r = s % 60;
    if (m >= 60) return Math.floor(m / 60) + ':' + pad(m % 60) + ':' + pad(r);
    return m + ':' + pad(r);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // "about 10:31 pm"
  function clock(ts) {
    var d = new Date(ts), h = d.getHours(), m = d.getMinutes();
    return 'about ' + ((h % 12) || 12) + ':' + pad(m) + ' ' + (h < 12 ? 'am' : 'pm');
  }
  // Volume for a gentle fade over the last minute (audio only); 1 before that
  function volume(state, now, fadeMs) {
    var left = remaining(state, now); fadeMs = fadeMs || 60000;
    if (left == null) return 1;
    return Math.max(0, Math.min(1, left / fadeMs));
  }
  // What should happen now: 'stop' when time is up, else null.
  // For 'end' mode the player stops itself at the end of the video or episode (endOfMedia = true).
  function tick(state, now, endOfMedia) {
    if (!state) return null;
    if (state.mode === 'end') return endOfMedia ? 'stop' : null;
    return remaining(state, now) <= 0 ? 'stop' : null;
  }
  // Text for the button/readout
  function label(state, now) {
    if (!state) return 'Sleep timer off';
    if (state.mode === 'end') return 'Stops at the end';
    return countdown(remaining(state, now)) + ' left';
  }
  return { PRESETS: PRESETS, start: start, remaining: remaining, countdown: countdown, clock: clock, volume: volume, tick: tick, label: label };
})();
if (typeof module !== 'undefined') module.exports = SleepTimer;
