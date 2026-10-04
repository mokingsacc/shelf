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
    parseChannelInput: parseChannelInput, pageUrl: pageUrl, channelFromHtml: channelFromHtml, isConsentPage: isConsentPage, stripHtml: stripHtml };
})();
if (typeof module !== 'undefined') module.exports = Feeds;
