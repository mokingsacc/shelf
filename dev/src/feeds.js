// Feeds: YouTube channel Atom feeds, podcast RSS, channel pages. Pure parsing (no DOM), tested in test/feeds.test.cjs.
var Feeds = (function () {
  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decode(s) {
    if (s == null) return '';
    s = String(s);
    var cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    if (cdata) return cdata[1].trim();
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e[0] === '#') { var n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isNaN(n) ? m : String.fromCodePoint(n); }
      return ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : m;
    }).trim();
  }
  function esc(name) { return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // Inner text of the first <tag>…</tag> (namespaced names allowed)
  function tag(xml, name) {
    var m = xml.match(new RegExp('<' + esc(name) + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + esc(name) + '>', 'i'));
    return m ? decode(m[1]) : '';
  }
  // Attribute of the first <tag …>
  function attr(xml, name, a) {
    var m = xml.match(new RegExp('<' + esc(name) + '\\s[^>]*?\\b' + esc(a) + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i'));
    return m ? decode(m[2] != null ? m[2] : m[3]) : '';
  }
  function blocks(xml, name) {
    return xml.match(new RegExp('<' + esc(name) + '(?:\\s[^>]*)?>[\\s\\S]*?</' + esc(name) + '>', 'gi')) || [];
  }
  function stripHtml(s) { return decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }

  // "1:02:03", "62:03", "3723", "3723.5" -> seconds
  function duration(v) {
    v = String(v || '').trim();
    if (!v) return 0;
    if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v));
    if (/^\d+(:\d{1,2}){1,2}$/.test(v)) return v.split(':').reduce(function (a, p) { return a * 60 + parseInt(p, 10); }, 0);
    return 0;
  }

  // ----- YouTube channel feed (Atom) -----
  function parseYouTube(xml) {
    if (!/<feed[\s>]/i.test(xml)) throw new Error('not a YouTube feed');
    var head = xml.split(/<entry[\s>]/i)[0];
    var out = { channelId: tag(head, 'yt:channelId'), title: tag(head, 'title'), author: tag(tag(head, 'author'), 'name'), items: [] };
    if (out.channelId && !/^UC/.test(out.channelId)) out.channelId = 'UC' + out.channelId;
    blocks(xml, 'entry').forEach(function (e) {
      var id = tag(e, 'yt:videoId');
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return;
      out.items.push({
        id: id,
        title: tag(e, 'title') || tag(e, 'media:title'),
        published: Date.parse(tag(e, 'published')) || 0,
        thumb: attr(e, 'media:thumbnail', 'url') || 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
        description: tag(e, 'media:description').slice(0, 400),
        author: tag(e, 'name')
      });
    });
    out.items.sort(function (a, b) { return b.published - a.published; });
    return out;
  }
  // Uploads without Shorts first; plain channel feed as the fallback
  function youtubeFeedUrls(channelId) {
    var rest = channelId.replace(/^UC/, '');
    return ['https://www.youtube.com/feeds/videos.xml?playlist_id=UULF' + rest, 'https://www.youtube.com/feeds/videos.xml?channel_id=' + channelId];
  }

  // ----- Podcast RSS -----
  function parsePodcast(xml) {
    if (!/<rss[\s>]|<channel[\s>]/i.test(xml)) throw new Error('not a podcast feed');
    var head = xml.split(/<item[\s>]/i)[0];
    var out = {
      title: tag(head, 'title'),
      image: attr(head, 'itunes:image', 'href') || tag(tag(head, 'image'), 'url'),
      author: tag(head, 'itunes:author'),
      items: []
    };
    blocks(xml, 'item').forEach(function (it) {
      var url = attr(it, 'enclosure', 'url');
      if (!url) return;
      var title = tag(it, 'title');
      out.items.push({
        guid: tag(it, 'guid') || url,
        title: title,
        url: url,
        type: attr(it, 'enclosure', 'type'),
        duration: duration(tag(it, 'itunes:duration')),
        published: Date.parse(tag(it, 'pubDate')) || 0,
        image: attr(it, 'itunes:image', 'href') || out.image,
        description: stripHtml(tag(it, 'itunes:summary') || tag(it, 'description')).slice(0, 400),
        episode: parseInt(tag(it, 'itunes:episode'), 10) || 0
      });
    });
    out.items.sort(function (a, b) { return b.published - a.published; });
    return out;
  }

  // ----- A YouTube channel's podcast twin (the same show as audio, which can play with the phone locked) -----
  var STOP = { the: 1, and: 1, for: 1, with: 1, from: 1, this: 1, that: 1, are: 1, was: 1, you: 1, your: 1, full: 1, show: 1, episode: 1, podcast: 1, official: 1, video: 1, audio: 1 };
  function words(s, drop) {
    var seen = {};
    return decode(s).toLowerCase().split(/[^a-z0-9]+/).filter(function (w) {
      if (w.length < 3 || /^\d+$/.test(w) || STOP[w] || (drop && drop[w]) || seen[w]) return false;
      seen[w] = 1; return true;
    });
  }
  function nameKey(s) { return words(s).join(''); }
  // The podcast with the channel's name (Apple's search results), or ''
  function podcastFor(name, results) {
    var k = nameKey(name);
    if (k.length < 4) return '';
    var hit = (results || []).filter(function (r) {
      var c = r && r.feedUrl ? nameKey(r.collectionName || r.trackName || '') : '';
      return c && (c === k || c.indexOf(k) >= 0); // the podcast's name holds the channel's (never just a word of it)
    })[0];
    return hit ? hit.feedUrl : '';
  }
  // The episode that is this video: most title words shared, published within 4 days. null when unsure.
  function episodeFor(video, items, channel) {
    var drop = {}; words(channel).forEach(function (w) { drop[w] = 1; });
    var a = words(video && video.title, drop), best = null, bs = 0;
    if (a.length < 2) return null;
    (items || []).forEach(function (it) {
      if (video.published && it.published && Math.abs(it.published - video.published) > 4 * 864e5) return;
      var b = words(it.title, drop);
      var n = a.filter(function (w) { return b.indexOf(w) >= 0; }).length, sc = b.length ? n / Math.min(a.length, b.length) : 0;
      // Both titles mostly shared: a short clip title doesn't match the full show it was cut from
      if (n >= 2 && n >= 0.5 * b.length && n >= 0.5 * a.length && sc > bs) { bs = sc; best = it; }
    });
    return bs >= (video.published ? 0.75 : 0.9) ? best : null;
  }
  // A title's part number: "Part 2", "Pt. 3", "Chapter IV", a roman numeral at the end ("… in the East II"); 0 when none
  var ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
  function partOf(title) {
    var t = decode(title).toLowerCase(), m = t.match(/\b(?:part|pt|chapter|ch|vol|volume|book)\.?\s*(\d+|[ivx]+)\b/);
    if (m) return +m[1] || ROMAN[m[1]] || 0;
    m = t.replace(/[\s|:)\]-]+$/, '').match(/\s([ivx]+)$/);
    return m && ROMAN[m[1]] || 0;
  }
  // Does this channel name hold the podcast's name (or the other way round)? pk is the podcast's nameKey.
  function channelIsShow(channel, pk) {
    var ck = nameKey(channel || '');
    return pk.length >= 4 && ck.length >= 4 && (ck === pk || ck.indexOf(pk) >= 0 || pk.indexOf(ck) >= 0);
  }
  // The YouTube video that is this podcast episode, among YouTube search results: most title words shared, a little
  // easier when the channel has the podcast's name, and never a different length when both are known. null when unsure.
  function videoFor(ep, results, podcast) {
    var drop = {}; words(podcast).forEach(function (w) { drop[w] = 1; });
    var a = words(ep && ep.title, drop), pk = nameKey(podcast), best = null, bs = 0, pa = partOf(ep && ep.title);
    if (a.length < 2) return null;
    (results || []).forEach(function (r) {
      if (!r || r.kind !== 'video' || r.live) return;
      var pb = partOf(r.title);
      if (pa !== pb && !(pa === 1 && pb === 0) && !(pa === 0 && pb === 1)) return; // Part 1 is never Part 2 (the words alone can't tell them apart)
      var b = words(r.title, drop);
      var n = a.filter(function (w) { return b.indexOf(w) >= 0; }).length, sc = b.length ? n / Math.min(a.length, b.length) : 0;
      if (n < 2 || n < 0.5 * b.length || n < 0.5 * a.length) return; // a clip or a different episode
      var own = channelIsShow(r.channel, pk);
      var d = ep.duration || 0, fits = d && r.dur ? Math.abs(d - r.dur) <= Math.max(600, 0.25 * d) : null;
      if (fits === false) return;
      var need = own ? (fits ? 0.6 : 0.75) : (fits ? 0.75 : 0.9), score = sc + (own ? 0.1 : 0) + (fits ? 0.05 : 0);
      if (sc >= need && score > bs) { bs = score; best = r; }
    });
    return best;
  }
  // For when no title matches: the videos that could be this episode, own channel first, at most 6.
  // shows: the podcast cards of the search ({ title, channelId }), which name the show's channels.
  function videoChoices(ep, results, podcast, shows) {
    var pk = nameKey(podcast), d = (ep && ep.duration) || 0, ids = {}, out = [], others = 0;
    (shows || []).forEach(function (sh) { if (pk.length >= 4 && nameKey(sh && sh.title) === pk && sh.channelId) ids[sh.channelId] = 1; });
    (results || []).forEach(function (r) {
      if (!r || r.kind !== 'video' || r.live) return;
      var own = channelIsShow(r.channel, pk) || !!(r.channelId && ids[r.channelId]), fits = null;
      if (d && r.dur) {
        if (Math.abs(d - r.dur) > Math.max(300, 0.15 * d)) return;
        fits = true;
      } else if (!r.dur) {
        if (!own) return;
      } else if (!own && ++others > 3) return; // episode length unknown: the first 3 others
      out.push({ id: r.id, title: r.title, channel: r.channel, channelId: r.channelId, dur: r.dur || 0, own: own, fits: fits });
    });
    var first = out.filter(function (x) { return x.own; });
    return first.concat(out.filter(function (x) { return !x.own; })).slice(0, 6);
  }

  // ----- What did Mo paste into "Add channel"? -----
  function parseChannelInput(text) {
    text = String(text || '').trim();
    if (!text) return null;
    if (/^UC[A-Za-z0-9_-]{22}$/.test(text)) return { kind: 'id', value: text };
    if (/^@[\w.-]{2,}$/.test(text)) return { kind: 'handle', value: text };
    var u; try { u = new URL(/^[a-z]+:\/\//i.test(text) ? text : 'https://' + text); } catch (e) { return { kind: 'name', value: text }; }
    if (/(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname)) {
      var parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'channel' && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1] || '')) return { kind: 'id', value: parts[1] };
      if (parts[0] && parts[0][0] === '@') return { kind: 'handle', value: decodeURIComponent(parts[0]) };
      if ((parts[0] === 'c' || parts[0] === 'user') && parts[1]) return { kind: 'page', value: 'https://www.youtube.com/' + parts[0] + '/' + parts[1] };
      if (Core.parseLink(text)) return { kind: 'video', value: Core.parseLink(text).id };
      return null;
    }
    if (/^https?:/i.test(text) || /\.(xml|rss)|feed|rss|megaphone|libsyn|anchor|buzzsprout|patreon|podbean|simplecast|acast|transistor/i.test(u.hostname + u.pathname)) return { kind: 'feed', value: u.href };
    return { kind: 'name', value: text };
  }
  function pageUrl(input) {
    if (input.kind === 'handle') return 'https://www.youtube.com/' + input.value;
    if (input.kind === 'page') return input.value;
    if (input.kind === 'video') return 'https://www.youtube.com/watch?v=' + input.value;
    return '';
  }

  // ----- Channel page -> id, name, picture -----
  function channelFromHtml(html) {
    var id = (html.match(/<meta\s+itemprop="(?:identifier|channelId)"\s+content="(UC[A-Za-z0-9_-]{22})"/i) || [])[1]
      || (html.match(/<link\s+rel="alternate"\s+type="application\/rss\+xml"[^>]*channel_id=(UC[A-Za-z0-9_-]{22})/i) || [])[1]
      || (html.match(/"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/) || [])[1]
      || (html.match(/"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/) || [])[1]
      || (html.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/) || [])[1];
    if (!id) return null;
    var name = (html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) || [])[1] || (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    name = decode(name).replace(/\s*-\s*YouTube\s*$/, '');
    var avatar = (html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/i) || [])[1] || '';
    var handle = (html.match(/"canonicalBaseUrl"\s*:\s*"\/(@[^"]+)"/) || [])[1] || '';
    return { id: id, name: name, avatar: decode(avatar), handle: handle };
  }
  // Consent page instead of the channel (served in some regions without the SOCS cookie)
  function isConsentPage(html) { return /consent\.youtube\.com|consent\.google\.com/i.test(html) && !/itemprop="identifier"/i.test(html); }

  return { decode: decode, duration: duration, parseYouTube: parseYouTube, youtubeFeedUrls: youtubeFeedUrls, parsePodcast: parsePodcast,
    parseChannelInput: parseChannelInput, pageUrl: pageUrl, channelFromHtml: channelFromHtml, isConsentPage: isConsentPage, stripHtml: stripHtml,
    podcastFor: podcastFor, episodeFor: episodeFor, videoFor: videoFor, videoChoices: videoChoices };
})();
if (typeof module !== 'undefined') module.exports = Feeds;
