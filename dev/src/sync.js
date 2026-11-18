// Sync: merges two copies of each store (this device's and the server's) so both devices end with the same thing.
// Pure: no storage, no clock (now is passed in), and the arguments are never changed. The sync engine (synclink.js) calls it.
// Rules for every store: nothing on either side is lost unless the other side removed it later than its newest
// change; ties and copies with no times go to remote (the server's copy), so every device ends the same;
// removal records older than 180 days are dropped. Tested in test/sync.test.cjs.
var Sync = (function () {
  var KEEP = 180 * 864e5;
  var PREF_FIELDS = ['rate', 'arate', 'autoNext', 'goal']; // shared prefs, plus each entry of prefs.rates
  var AUDIO_FILL = ['url', 'title', 'podcast', 'image', 'source'];
  // Fields that stay on their device: left as local's, and not compared by same()
  var DEVICE = { library: ['seedMisses', 'rev'], courses: ['misses', 'saved'], marks: ['saved'] };

  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function obj(x) { return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; }
  function has(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function num(x) { x = +x; return isFinite(x) ? x : 0; }
  // The keys of several maps, once each, sorted
  function keys() {
    var seen = {};
    for (var i = 0; i < arguments.length; i++) Object.keys(obj(arguments[i])).forEach(function (k) { seen[k] = 1; });
    return Object.keys(seen).sort();
  }
  // Only entries shaped like records
  function recs(o) { var out = {}; o = obj(o); Object.keys(o).forEach(function (k) { if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) out[k] = o[k]; }); return out; }
  // Two maps of times: the larger per key
  function maxMap(a, b) {
    var out = {};
    [obj(a), obj(b)].forEach(function (m) { Object.keys(m).forEach(function (k) { var v = num(m[k]); if (!has(out, k) || v > out[k]) out[k] = v; }); });
    return out;
  }
  // Removal times: the larger per key, minus those older than 180 days (dropped before they are used)
  function tombs(a, b, now) {
    var m = maxMap(a, b), cut = num(now) - KEEP;
    if (now != null) Object.keys(m).forEach(function (k) { if (m[k] < cut) delete m[k]; });
    return m;
  }
  function minOf(x, y) { var a = x == null ? null : num(x), b = y == null ? null : num(y); return a == null ? b : b == null ? a : Math.min(a, b); }
  function maxOf(x, y) { var a = x == null ? null : num(x), b = y == null ? null : num(y); return a == null ? b : b == null ? a : Math.max(a, b); }
  // Set a field when either side had it (so merging a copy with itself changes nothing), else leave it out
  function put(out, k, v, x, y) { if (has(x, k) || has(y, k)) out[k] = v; else delete out[k]; }

  // ----- Videos: { items: {id: record}, gone: { v: {id: ms} } } -----
  function goneOf(g) { g = obj(g); return g.v && typeof g.v === 'object' ? obj(g.v) : g; }
  function mergeVideos(local, remote, now) {
    var a = obj(clone(local)), b = obj(clone(remote));
    var ia = recs(a.items), ib = recs(b.items), gone = tombs(goneOf(a.gone), goneOf(b.gone), now), items = {};
    keys(ia, ib).forEach(function (id) {
      var x = ia[id], y = ib[id], w = !x ? y : !y ? x : num(x.updated) > num(y.updated) ? x : y, l = w === x ? y : x;
      if (l) { if (!w.title && l.title) w.title = l.title; if (!w.author && l.author) w.author = l.author; }
      if (has(gone, id) && gone[id] > num(w.updated)) return;
      items[id] = w;
    });
    return { items: items, gone: { v: gone } };
  }

  // ----- Podcast places: {guid: record} -----
  function mergeAudio(local, remote) {
    var a = recs(clone(local)), b = recs(clone(remote)), out = {};
    keys(a, b).forEach(function (g) {
      var x = a[g], y = b[g], w = !x ? y : !y ? x : num(x.updated) > num(y.updated) ? x : y, l = w === x ? y : x;
      if (l) AUDIO_FILL.forEach(function (f) { if (!w[f] && l[f]) w[f] = l[f]; });
      out[g] = w;
    });
    return out;
  }

  // ----- Library: sections and channels -----
  function mergeLibrary(local, remote, now) {
    var a = obj(clone(local)), b = obj(clone(remote));
    var la = Array.isArray(a.sections) ? a.sections.filter(isSec) : [], lb = Array.isArray(b.sections) ? b.sections.filter(isSec) : [];
    var atA = obj(a.at), atB = obj(b.at), gA = obj(a.gone), gB = obj(b.gone);
    var goneSrc = tombs(gA.src, gB.src, now), goneSec = tombs(gA.sec, gB.sec, now);
    var at = { src: maxMap(atA.src, atB.src), sec: maxMap(atA.sec, atB.sec) };
    var order = maxOf(atA.order, atB.order);
    if (order != null) at.order = order;

    // Sections by id: the later change wins whole (no time counts as 0)
    var sa = {}, sb = {}, win = {}, live = {};
    la.forEach(function (s) { if (!sa[s.id]) sa[s.id] = s; });
    lb.forEach(function (s) { if (!sb[s.id]) sb[s.id] = s; });
    keys(sa, sb).forEach(function (id) {
      var x = sa[id], y = sb[id], tx = x ? num(obj(atA.sec)[id]) : -1, ty = y ? num(obj(atB.sec)[id]) : -1;
      var w = !x ? y : !y ? x : tx > ty ? x : y;
      win[id] = w;
      if (!(has(goneSec, id) && goneSec[id] > Math.max(tx, ty))) live[id] = 1;
    });
    // Order: the side that moved sections last, then any it lacks in the other side's order
    var first = num(atA.order) > num(atB.order) ? la : lb, second = first === la ? lb : la, list = [], inList = {};
    first.concat(second).forEach(function (s) { if (live[s.id] && !inList[s.id]) { inList[s.id] = 1; list.push(win[s.id]); } });
    // Never no sections: remote's first stays
    if (!list.length && (lb[0] || la[0])) { var keep = win[(lb[0] || la[0]).id]; list.push(keep); inList[keep.id] = 1; }

    // Channels and podcasts by id: the later change wins whole (no time counts as 0: added by old code or the seed list)
    var ca = recs(a.sources), cb = recs(b.sources), sources = {};
    keys(ca, cb).forEach(function (id) {
      var x = ca[id], y = cb[id], tx = x ? num(obj(atA.src)[id]) : -1, ty = y ? num(obj(atB.src)[id]) : -1;
      var w = !x ? y : !y ? x : tx > ty ? x : y, t = Math.max(tx, ty);
      if (x && y) {
        if (x.seenUpTo != null || y.seenUpTo != null) w.seenUpTo = maxOf(x.seenUpTo, y.seenUpTo);
        if (x.added != null || y.added != null) w.added = minOf(x.added, y.added);
      }
      if (has(goneSrc, id) && goneSrc[id] > t) return;
      sources[id] = w;
    });
    // A channel whose section went moves to the first one
    if (list.length) Object.keys(sources).forEach(function (id) { if (!inList[sources[id].section]) sources[id].section = list[0].id; });

    var out = a;
    out.sections = list; out.sources = sources;
    put(out, 'seeded', !!(a.seeded || b.seeded), a, b);
    put(out, 'seedV', maxOf(a.seedV, b.seedV), a, b);
    put(out, 'born', minOf(a.born, b.born), a, b);
    out.at = at;
    out.gone = { src: goneSrc, sec: goneSec };
    return out;
  }
  function isSec(s) { return !!s && typeof s === 'object' && typeof s.id === 'string'; }

  // ----- Courses: playlists ticked episode by episode -----
  // The newest time anything in a course changed
  function newest(c) {
    var t = Math.max(num(c.touched), num(c.m));
    ['onAt', 'offAt', 'pinAt'].forEach(function (k) { var m = obj(c[k]); Object.keys(m).forEach(function (v) { t = Math.max(t, num(m[v])); }); });
    return t;
  }
  // Ticks kept from a removed course: ticked on either side stays ticked (1 beats 0)
  function addTicks(into, ticks) { ticks = obj(ticks); Object.keys(ticks).forEach(function (v) { if (ticks[v] === 1) into[v] = 1; else if (ticks[v] === 0 && into[v] !== 1) into[v] = 0; }); return into; }
  function mergeCourse(x, y) {
    var mx = num(x.m), my = num(y.m), w = mx > my ? x : y, c = clone(w);
    var onAt = maxMap(x.onAt, y.onAt), offAt = maxMap(x.offAt, y.offAt), pinAt = maxMap(x.pinAt, y.pinAt);
    var tx = obj(x.ticks), ty = obj(y.ticks), ticks = {};
    keys(tx, ty, onAt, offAt).forEach(function (v) {
      var on = num(onAt[v]), off = num(offAt[v]);
      var ticked = on || off ? !(off > on) : tx[v] === 1 || ty[v] === 1;
      if (ticked) ticks[v] = 1; else if (tx[v] === 0 || ty[v] === 0) ticks[v] = 0;
    });
    var ticksAt = maxMap(x.ticksAt, y.ticksAt);
    Object.keys(ticksAt).forEach(function (v) { if (ticks[v] !== 1) delete ticksAt[v]; });
    var px = obj(x.pins), py = obj(y.pins), pax = obj(x.pinAt), pay = obj(y.pinAt), pins = {};
    keys(px, py, pinAt).forEach(function (v) {
      var sx = num(pax[v]), sy = num(pay[v]);
      var on = !sx && !sy ? !!px[v] || !!py[v] : sx > sy ? !!px[v] : !!py[v];
      if (on) pins[v] = 1;
    });
    put(c, 'ticks', ticks, x, y); put(c, 'ticksAt', ticksAt, x, y);
    put(c, 'onAt', onAt, x, y); put(c, 'offAt', offAt, x, y);
    put(c, 'pins', pins, x, y); put(c, 'pinAt', pinAt, x, y);
    put(c, 'added', minOf(x.added, y.added), x, y);
    put(c, 'touched', maxOf(x.touched, y.touched), x, y);
    put(c, 'm', maxOf(x.m, y.m), x, y);
    // The seed note stays only while both copies still hold it (a copy without it has used it up, or never had one)
    if (!(x.seed && y.seed)) delete c.seed;
    return c;
  }
  // Ticks kept from a removal elsewhere go back into a course that stayed, where its own times don't say otherwise
  function foldTicks(c, kept) {
    var on = obj(c.onAt), off = obj(c.offAt);
    c.ticks = c.ticks && typeof c.ticks === 'object' ? c.ticks : {};
    Object.keys(kept).forEach(function (v) {
      if (has(on, v) || has(off, v)) return;
      if (kept[v] === 1) c.ticks[v] = 1; else if (kept[v] === 0 && c.ticks[v] !== 1) c.ticks[v] = 0;
    });
  }
  function mergeCourses(local, remote, now) {
    var a = obj(clone(local)), b = obj(clone(remote));
    var ca = recs(a.courses), cb = recs(b.courses), courses = {};
    var removedAt = tombs(a.removedAt, b.removedAt, now), removed = {};
    var ra = recs(a.removed), rb = recs(b.removed);
    keys(ra, rb).forEach(function (pid) { removed[pid] = addTicks(addTicks({}, ra[pid]), rb[pid]); });
    keys(ca, cb).forEach(function (pid) {
      // A course on one side only goes through the same rules on its own, so a seed tick made after an untick on that
      // device (no time, so the untick wins) comes out the same as it would against any other copy
      var c = ca[pid] && cb[pid] ? mergeCourse(ca[pid], cb[pid]) : mergeCourse(ca[pid] || cb[pid], ca[pid] || cb[pid]);
      // Removed on a device after its last change there: it goes, and its ticks are kept for a re-add
      if (has(removedAt, pid) && removedAt[pid] > newest(c)) { removed[pid] = addTicks(removed[pid] || {}, c.ticks); return; }
      courses[pid] = c;
    });
    Object.keys(courses).forEach(function (pid) {
      if (removed[pid]) { foldTicks(courses[pid], removed[pid]); delete removed[pid]; }
      delete removedAt[pid];
    });
    var out = a;
    out.courses = courses;
    put(out, 'removed', removed, a, b); if (Object.keys(removed).length) out.removed = removed;
    put(out, 'removedAt', removedAt, a, b); if (Object.keys(removedAt).length) out.removedAt = removedAt;
    put(out, 'found', !!(a.found || b.found), a, b);
    var dropped = {};
    [obj(a.dropped), obj(b.dropped)].forEach(function (d) { Object.keys(d).forEach(function (k) { if (d[k]) dropped[k] = 1; }); });
    put(out, 'dropped', dropped, a, b);
    return out;
  }

  // ----- Marks: saved moments -----
  function markTime(m) { return m.m != null ? num(m.m) : num(m.at); }
  function mergeMarks(local, remote, now) {
    var a = obj(clone(local)), b = obj(clone(remote)), ia = {}, ib = {};
    (Array.isArray(a.items) ? a.items : []).forEach(function (m) { if (m && typeof m === 'object' && m.id && !ia[m.id]) ia[m.id] = m; });
    (Array.isArray(b.items) ? b.items : []).forEach(function (m) { if (m && typeof m === 'object' && m.id && !ib[m.id]) ib[m.id] = m; });
    var gone = tombs(a.gone, b.gone, now), items = [];
    keys(ia, ib).forEach(function (id) {
      var x = ia[id], y = ib[id], tx = x ? markTime(x) : -1, ty = y ? markTime(y) : -1, w = !x ? y : !y ? x : tx > ty ? x : y;
      if (has(gone, id) && gone[id] > Math.max(tx, ty)) return;
      items.push(w);
    });
    // One order on every device: oldest first
    items.sort(function (p, q) { return num(p.at) - num(q.at) || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0); });
    var out = a;
    out.items = items;
    put(out, 'gone', gone, a, b); if (Object.keys(gone).length) out.gone = gone;
    return out;
  }

  // ----- Prefs: only the shared fields; everything else stays local's -----
  function mergePrefs(local, remote) {
    var a = obj(clone(local)), b = obj(clone(remote)), out = a, sa = obj(a.at), sb = obj(b.at);
    // The later change wins; with no times (or the same), remote's value if it has one
    function pick(f, hx, vx, hy, vy, set, drop) {
      var tx = num(sa[f]), ty = num(sb[f]), useY = ty > tx || (ty === tx && hy);
      if (useY ? hy : hx) set(useY ? vy : vx); else drop();
    }
    PREF_FIELDS.forEach(function (f) {
      pick(f, has(a, f), a[f], has(b, f), b[f], function (v) { out[f] = v; }, function () { delete out[f]; });
    });
    var ra = obj(a.rates), rb = obj(b.rates), rates = {};
    keys(ra, rb).forEach(function (k) { pick('rates.' + k, has(ra, k), ra[k], has(rb, k), rb[k], function (v) { rates[k] = v; }, function () {}); });
    put(out, 'rates', rates, a, b);
    put(out, 'at', maxMap(sa, sb), a, b);
    return out;
  }

  // ----- Comparing two copies (deep, keys sorted, device-only fields left out) -----
  function canon(x) {
    if (Array.isArray(x)) return x.map(canon);
    if (x && typeof x === 'object') { var o = {}; Object.keys(x).sort().forEach(function (k) { if (x[k] !== undefined) o[k] = canon(x[k]); }); return o; }
    return x;
  }
  function shared(x, kind) {
    x = obj(x);
    var o = {};
    if (kind === 'prefs') { PREF_FIELDS.concat(['rates', 'at']).forEach(function (k) { if (has(x, k)) o[k] = x[k]; }); return o; }
    Object.keys(x).forEach(function (k) { if ((DEVICE[kind] || []).indexOf(k) < 0) o[k] = x[k]; });
    return o;
  }
  function canonText(x, kind) { return JSON.stringify(canon(shared(x, kind))); }
  function same(x, y, kind) { return canonText(x, kind) === canonText(y, kind); }

  // An empty copy of a store, for "Replace" (this device ends as the shelf is). With from, the device-only fields
  // of that copy stay (for prefs: everything that isn't shared).
  function empty(kind, from) {
    var o = kind === 'videos' ? { items: {}, gone: { v: {} } } : kind === 'library' ? { sections: [], sources: {} }
      : kind === 'courses' ? { courses: {} } : kind === 'marks' ? { items: [] } : {};
    from = obj(clone(from));
    if (kind === 'prefs') { var sh = PREF_FIELDS.concat(['rates', 'at']); Object.keys(from).forEach(function (k) { if (sh.indexOf(k) < 0) o[k] = from[k]; }); }
    else (DEVICE[kind] || []).forEach(function (k) { if (has(from, k)) o[k] = from[k]; });
    return o;
  }

  return { mergeVideos: mergeVideos, mergeAudio: mergeAudio, mergeLibrary: mergeLibrary, mergeCourses: mergeCourses, mergeMarks: mergeMarks, mergePrefs: mergePrefs,
    same: same, canon: canonText, empty: empty, KEEP: KEEP, PREF_FIELDS: PREF_FIELDS, DEVICE: DEVICE };
})();
if (typeof module !== 'undefined') module.exports = Sync;
