// Search YouTube. With a Google key: the official Data API (about 100 searches a day free).
// Without one: YouTube's own results page, read by the app (best effort). Just the results, no suggestions.
var Search = (function () {
  var API = 'https://www.googleapis.com/youtube/v3/';
  var CONSENT = { Cookie: 'SOCS=CAI; CONSENT=YES+1' };

  // "PT1H2M3S" -> 3723
  function isoDuration(s) {
    var m = String(s || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
    if (!m) return 0;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }
  function apiError(text, status) {
    var reason = '';
    try { var j = JSON.parse(text); reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || (j.error && j.error.status) || ''; } catch (e) {}
    if (/quota/i.test(reason)) return new Error("Search has used today's free allowance. It comes back at 8 am UK time (midnight in California).");
    if (/keyInvalid|API_KEY_INVALID|badRequest/i.test(reason) || status === 400) return new Error("Google didn't accept the search key. Check it in Settings, or remove it to use basic search.");
    if (/accessNotConfigured|SERVICE_DISABLED|forbidden/i.test(reason) || status === 403) return new Error('The search key works but "YouTube Data API v3" isn\'t switched on for it in Google Cloud.');
    return new Error('Search failed (' + (reason || status || 'no answer') + ').');
  }

  // io: { fetchJSON(url) -> Promise<{ok, status, text}>, fetchText(url, headers) -> Promise<string> }
  function withKey(io, key, q) {
    var u = API + 'search?part=snippet&type=video,channel&maxResults=20&safeSearch=none&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(key);
    return io.fetchJSON(u).then(function (r) {
      if (!r.ok) throw apiError(r.text, r.status);
      var j = JSON.parse(r.text), out = [];
      (j.items || []).forEach(function (it) {
        var sn = it.snippet || {}, th = sn.thumbnails || {};
        var thumb = (th.medium || th.high || th.default || {}).url || '';
        if (it.id.kind === 'youtube#video') out.push({ kind: 'video', id: it.id.videoId, title: Feeds.decode(sn.title), channel: Feeds.decode(sn.channelTitle), channelId: sn.channelId, published: Date.parse(sn.publishedAt) || 0, thumb: thumb, live: sn.liveBroadcastContent === 'live' });
        else if (it.id.kind === 'youtube#channel') out.push({ kind: 'channel', id: it.id.channelId, title: Feeds.decode(sn.title), thumb: thumb, description: Feeds.decode(sn.description) });
      });
      var ids = out.filter(function (x) { return x.kind === 'video'; }).map(function (x) { return x.id; });
      if (!ids.length) return out;
      // Durations cost 1 unit; a failure here just leaves them blank
      return io.fetchJSON(API + 'videos?part=contentDetails&id=' + ids.join(',') + '&key=' + encodeURIComponent(key)).then(function (r2) {
        if (r2.ok) (JSON.parse(r2.text).items || []).forEach(function (v) {
          out.forEach(function (x) { if (x.id === v.id) x.dur = isoDuration(v.contentDetails && v.contentDetails.duration); });
        });
        return out;
      }, function () { return out; });
    });
  }

  // Pull results out of the page's ytInitialData without a full JSON parse of the page
  function fromPage(html) {
    var out = [], seen = {};
    var re = /"videoRenderer"\s*:\s*\{\s*"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"([\s\S]{0,6000}?)"(?:ownerText|longBylineText)"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"[\s\S]{0,600}?"browseId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/g, m;
    while ((m = re.exec(html)) && out.length < 20) {
      if (seen[m[1]]) continue; seen[m[1]] = 1;
      var title = (m[2].match(/"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1] || '';
      var len = (m[2].match(/"lengthText"\s*:\s*\{[\s\S]{0,300}?"simpleText"\s*:\s*"([\d:]+)"/) || [])[1] || '';
      out.push({ kind: 'video', id: m[1], title: unjson(title), channel: unjson(m[3]), channelId: m[4], thumb: 'https://i.ytimg.com/vi/' + m[1] + '/mqdefault.jpg', dur: Feeds.duration(len) });
    }
    var cre = /"channelRenderer"\s*:\s*\{\s*"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"[\s\S]{0,400}?"title"\s*:\s*\{\s*"simpleText"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    var chans = [];
    while ((m = cre.exec(html)) && chans.length < 3) chans.push({ kind: 'channel', id: m[1], title: unjson(m[2]), thumb: '' });
    return chans.concat(out);
  }
  function unjson(s) { try { return JSON.parse('"' + s + '"'); } catch (e) { return s; } }
  function withoutKey(io, q) {
    return io.fetchText('https://www.youtube.com/results?search_query=' + encodeURIComponent(q), CONSENT).then(function (html) {
      if (Feeds.isConsentPage(html)) throw new Error('YouTube showed its cookie page instead of results. Try again in a minute.');
      var r = fromPage(html);
      if (!r.length && !/ytInitialData/.test(html)) throw new Error("YouTube's results page has changed and basic search can't read it. Adding a Google key in Settings fixes this.");
      return r;
    });
  }
  function run(io, q, key) {
    q = String(q || '').trim();
    if (!q) return Promise.resolve([]);
    return key ? withKey(io, key, q) : withoutKey(io, q);
  }
  return { run: run, isoDuration: isoDuration, fromPage: fromPage };
})();
if (typeof module !== 'undefined') module.exports = Search;
