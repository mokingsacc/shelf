// Pure logic: no DOM, no YouTube. Tested in test/core.test.mjs.
var Core = (function () {
  var ID = /^[A-Za-z0-9_-]{11}$/;
  var HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;

  // "90", "90s", "1m30s", "1h2m3s", "01:30" -> seconds
  function parseTime(v) {
    if (v == null || v === '') return 0;
    v = String(v).trim();
    if (/^\d+(\.\d+)?s?$/.test(v)) return Math.floor(parseFloat(v));
    if (/^\d+(:\d{1,2}){1,2}$/.test(v)) {
      return v.split(':').reduce(function (a, p) { return a * 60 + parseInt(p, 10); }, 0);
    }
    var m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
    if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    return 0;
  }

  // One link -> {id, t} or null
  function parseLink(text) {
    if (!text) return null;
    text = String(text).trim();
    if (ID.test(text)) return { id: text, t: 0 };
    if (!/^[a-z]+:\/\//i.test(text)) text = 'https://' + text;
    var u;
    try { u = new URL(text); } catch (e) { return null; }
    if (!HOSTS.test(u.hostname)) return null;
    var id = null;
    var parts = u.pathname.split('/').filter(Boolean);
    if (/youtu\.be$/i.test(u.hostname)) id = parts[0];
    else if (u.searchParams.get('v')) id = u.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v', 'e'].indexOf(parts[0]) !== -1) id = parts[1];
    else if (parts[0] === 'attribution_link' && u.searchParams.get('u')) return parseLink('https://www.youtube.com' + u.searchParams.get('u'));
    if (!id || !ID.test(id)) return null;
    var t = u.searchParams.get('t') || u.searchParams.get('start') || '';
    if (!t && u.hash) { var h = u.hash.match(/t=([^&]+)/); if (h) t = h[1]; }
    return { id: id, t: parseTime(t) };
  }

  // Any pasted text -> list of {id, t}, unique, in order
  function findLinks(text) {
    if (!text) return [];
    var out = [], seen = {};
    var tokens = String(text).match(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:youtube\.com|youtube-nocookie\.com|youtu\.be)\/[^\s<>"']+/gi) || [];
    if (!tokens.length && ID.test(String(text).trim())) tokens = [String(text).trim()];
    tokens.forEach(function (tok) {
      var r = parseLink(tok.replace(/[).,;!?]+$/, ''));
      if (r && !seen[r.id]) { seen[r.id] = 1; out.push(r); }
    });
    return out;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var ss = (s < 10 ? '0' : '') + s;
    return h ? h + ':' + (m < 10 ? '0' : '') + m + ':' + ss : m + ':' + ss;
  }

  // "12 min left", "1 hr 5 min left", "Less than a minute left"
  function left(t, dur) {
    if (!dur) return '';
    var r = Math.max(0, dur - (t || 0));
    if (r < 60) return 'Less than a minute left';
    var mins = Math.round(r / 60);
    if (mins < 60) return mins + ' min left';
    var h = Math.floor(mins / 60), m = mins % 60;
    return h + ' hr' + (m ? ' ' + m + ' min' : '') + ' left';
  }

  function pct(v) { return v && v.dur ? Math.min(100, Math.max(0, (v.t || 0) / v.dur * 100)) : 0; }

  // Close enough to the end to count as watched
  function isDone(t, dur) { return !!dur && dur > 0 && t >= dur - Math.min(20, dur * 0.05); }

  // Where to start when resuming: a couple of seconds back for context
  function resumeAt(v) { return v && !v.done && v.t > 5 ? Math.max(0, Math.floor(v.t) - 3) : 0; }

  // When you last watched, in words
  function ago(ts, now) {
    if (!ts) return '';
    now = now || Date.now();
    var d = new Date(ts), n = new Date(now), s = (now - ts) / 1000;
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var days = Math.round((day(n) - day(d)) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    if (days < 14) return 'last week';
    if (days < 60) return Math.floor(days / 7) + ' weeks ago';
    return Math.floor(days / 30) + ' months ago';
  }

  function sorted(videos) {
    var list = Object.keys(videos || {}).map(function (k) { return videos[k]; });
    var by = function (a, b) { return (b.updated || 0) - (a.updated || 0); };
    return {
      watching: list.filter(function (v) { return !v.done; }).sort(by),
      finished: list.filter(function (v) { return v.done; }).sort(by)
    };
  }

  // Newer edit wins, per video
  function merge(local, incoming) {
    var out = {}, k;
    for (k in local) out[k] = local[k];
    var added = 0, updated = 0;
    for (k in incoming) {
      var a = out[k], b = incoming[k];
      if (!a) { out[k] = b; added++; }
      else if ((b.updated || 0) > (a.updated || 0)) {
        out[k] = Object.assign({}, a, b, { title: b.title || a.title, author: b.author || a.author });
        updated++;
      }
    }
    return { videos: out, added: added, updated: updated };
  }

  // Shelf -> short text for a link/QR. Titles dropped first if it gets long.
  function b64e(s) {
    var bytes = new TextEncoder().encode(s), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64d(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function encodeShelf(videos, max, titles) {
    max = max || 2200;
    var s = sorted(videos), list = s.watching.concat(s.finished);
    function pack(items, titles) {
      return b64e(JSON.stringify(items.map(function (v) {
        var row = [v.id, Math.floor(v.t || 0), Math.floor(v.dur || 0), v.done ? 1 : 0, Math.floor((v.updated || 0) / 1000)];
        if (titles) row.push((v.title || '').slice(0, 48));
        return row;
      })));
    }
    var out = pack(list, titles !== false);
    if (out.length > max) out = pack(list, false);
    while (out.length > max && list.length > 1) { list = list.slice(0, list.length - 1); out = pack(list, false); }
    return out;
  }
  function decodeShelf(code) {
    var rows = JSON.parse(b64d(code)), out = {};
    if (!Array.isArray(rows)) throw new Error('bad');
    rows.forEach(function (r) {
      if (!Array.isArray(r) || !ID.test(r[0])) return;
      out[r[0]] = { id: r[0], t: +r[1] || 0, dur: +r[2] || 0, done: !!r[3], updated: (+r[4] || 0) * 1000, title: r[5] || '', added: (+r[4] || 0) * 1000 };
    });
    return out;
  }

  return { parseTime: parseTime, parseLink: parseLink, findLinks: findLinks, fmt: fmt, left: left, pct: pct,
    isDone: isDone, resumeAt: resumeAt, ago: ago, sorted: sorted, merge: merge, encodeShelf: encodeShelf, decodeShelf: decodeShelf };
})();
if (typeof module !== 'undefined') module.exports = Core;
