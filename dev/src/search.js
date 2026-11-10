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

  // The page's data as an object: find ytInitialData, cut out the {...} after it (counting braces, skipping
  // strings) and parse it. null when anything is off.
  function pageData(html) {
    html = String(html || '');
    var m = /ytInitialData["\]]*\s*=\s*/.exec(html);
    if (!m) return null;
    var start = m.index + m[0].length;
    if (html.charAt(start) !== '{') return null;
    var depth = 0, inStr = false, i, c;
    for (i = start; i < html.length; i++) {
      c = html.charAt(i);
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
    return null;
  }
  var SKIP = { shortsLockupViewModel: 1, reelShelfRenderer: 1, reelItemRenderer: 1, adSlotRenderer: 1, searchPyvRenderer: 1, promotedSparklesWebRenderer: 1 };
  function firstUC(node) { return (JSON.stringify(node || '').match(/"browseId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/) || [])[1] || ''; }
  function textOf(t) {
    if (!t) return '';
    if (t.simpleText != null) return String(t.simpleText);
    return (t.runs || []).map(function (r) { return r && r.text || ''; }).join('');
  }
  // One videoRenderer -> a result (or null). Joint videos ("A and 2 more") name their channels in a dialog.
  function readVideo(v) {
    var id = v && v.videoId;
    if (typeof id !== 'string' || id.length !== 11) return null;
    var by = v.ownerText || v.longBylineText || v.shortBylineText, run = by && by.runs && by.runs[0] || {};
    var be = run.navigationEndpoint && run.navigationEndpoint.browseEndpoint, channel = '', channelId = '';
    if (be && /^UC/.test(be.browseId || '')) { channel = run.text || ''; channelId = be.browseId; }
    else {
      var items, li, dlg;
      try { items = run.navigationEndpoint.showDialogCommand.panelLoadingStrategy.inlineContent.dialogViewModel.customContent.listViewModel.listItems; } catch (e) { items = null; }
      li = items && items[0] && items[0].listItemViewModel;
      if (li && li.title && li.title.content) { channel = li.title.content; channelId = firstUC(li); }
      if (!channel || !channelId) {
        if (!channel) channel = String(run.text || '').replace(/\s+and\s+(?:\d+\s+more|.+)$/, '');
        if (!channelId) channelId = firstUC(v);
      }
    }
    var out = { kind: 'video', id: id, title: textOf(v.title), channel: channel, channelId: channelId, thumb: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg', dur: v.lengthText ? Feeds.duration(textOf(v.lengthText)) : 0 };
    if (!v.lengthText && /LIVE/.test(JSON.stringify(v.badges || ''))) out.live = true;
    return out;
  }
  // YouTube's newer card for a video
  function readLockupVideo(l) {
    var id = l.contentId;
    if (typeof id !== 'string' || id.length !== 11) return null;
    var md = l.metadata && l.metadata.lockupMetadataViewModel || {}, chan = '';
    try { chan = md.metadata.contentMetadataViewModel.metadataRows[0].metadataParts[0].text.content || ''; } catch (e) {}
    var badge = (JSON.stringify(l.contentImage || '').match(/"text"\s*:\s*"(\d+(?::\d\d)+)"/) || [])[1] || '';
    return { kind: 'video', id: id, title: md.title && md.title.content || '', channel: chan, channelId: firstUC(l), thumb: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg', dur: badge ? Feeds.duration(badge) : 0 };
  }
  function fromData(data) {
    var vids = [], chans = [], shows = [], seen = {};
    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 80) return;
      if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) walk(node[i], depth + 1); return; }
      Object.keys(node).forEach(function (k) {
        var v = node[k];
        if (SKIP[k]) return;
        if (k === 'videoRenderer') {
          var r = readVideo(v);
          if (r) { if (!seen[r.id]) { seen[r.id] = 1; vids.push(r); } }
          else walk(v, depth + 1);
        } else if (k === 'channelRenderer') {
          if (v && /^UC/.test(v.channelId || '') && chans.length < 3) chans.push({ kind: 'channel', id: v.channelId, title: textOf(v.title), thumb: '' });
        } else if (k === 'lockupViewModel' && v && typeof v === 'object') {
          if (v.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
            var lv = readLockupVideo(v);
            if (lv && !seen[lv.id]) { seen[lv.id] = 1; vids.push(lv); }
          } else if (v.contentType === 'LOCKUP_CONTENT_TYPE_PODCAST') {
            var md = v.metadata && v.metadata.lockupMetadataViewModel;
            shows.push({ title: md && md.title && md.title.content || '', channelId: firstUC(v), list: v.contentId || '' });
          }
        } else walk(v, depth + 1);
      });
    }
    walk(data, 0);
    var out = chans.concat(vids.slice(0, 20));
    out.shows = shows;
    return out;
  }
  // Pull results out of the page: as JSON when it parses, else by text patterns
  function fromPage(html) {
    var data = pageData(html);
    if (!data) { try { var t = String(html).trim(); if (t.charAt(0) === '{') data = JSON.parse(t); } catch (e) {} }
    if (data) { var r = fromData(data); if (r.length) return r; }
    return fromText(html);
  }
  // The old way: patterns over the raw text (also serves bare fragments)
  function fromText(html) {
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
    var res = chans.concat(out);
    res.shows = [];
    return res;
  }
  // The phone page keeps ytInitialData in a '\x7b\x22…' string: turn it back into plain JSON text
  function unescapePage(html) {
    var m = String(html).match(/ytInitialData\s*=\s*'([\s\S]*?)';/);
    if (!m) return '';
    return m[1].replace(/\\x([0-9a-f]{2})/gi, function (x, h) { return String.fromCharCode(parseInt(h, 16)); }).replace(/\\\\/g, '\\');
  }
  function unjson(s) { try { return JSON.parse('"' + s + '"'); } catch (e) { return s; } }
  function withoutKey(io, q) {
    return io.fetchText('https://www.youtube.com/results?search_query=' + encodeURIComponent(q), CONSENT).then(function (html) {
      if (Feeds.isConsentPage(html)) throw new Error('YouTube showed its cookie page instead of results. Try again in a minute.');
      var r = fromPage(html);
      if (!r.length) { var plain = unescapePage(html); if (plain) r = fromPage(plain); }
      if (!r.shows) r.shows = [];
      if (!r.length && !/ytInitialData/.test(html)) throw new Error("YouTube's results page has changed and basic search can't read it. Adding a Google key in Settings fixes this.");
      return r;
    });
  }
  function run(io, q, key) {
    q = String(q || '').trim();
    if (!q) return Promise.resolve([]);
    return key ? withKey(io, key, q) : withoutKey(io, q);
  }
  return { run: run, isoDuration: isoDuration, fromPage: fromPage, fromText: fromText, pageData: pageData, unescapePage: unescapePage };
})();
if (typeof module !== 'undefined') module.exports = Search;
