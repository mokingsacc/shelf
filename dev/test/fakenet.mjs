import fs from 'fs';
// A pretend internet for tests and screenshots: YouTube (player, channel pages, feeds, search page),
// Apple podcast search, podcast feeds, audio files, thumbnails. Nothing here leaves the machine.
const H = 3600e3, D = 24 * H;
const id = (s) => ('UC' + s.replace(/[^A-Za-z0-9]/g, '') + 'xxxxxxxxxxxxxxxxxxxxxx').slice(0, 24);
export const CHANNELS = {
  '@DirtyMedicine': { id: id('DirtyMedicine'), name: 'Dirty Medicine', videos: [['Hyperkalemia Mnemonics and Treatment', 2 * H], ['Acid-Base Disorders Made Ridiculously Easy', 3 * D], ['Pediatric Milestones in 10 Minutes', 9 * D]] },
  '@MehlmanMedical': { id: id('MehlmanMedical'), name: 'Mehlman Medical', videos: [['HY Arrows: Renal Physiology', 5 * H], ['HY Arrows: Endocrine', 2 * D], ['Step 2 CK Psychiatry Pearls', 6 * D]] },
  '@AJsMnemonics': { id: id('AJsMnemonics'), name: 'AJmonics', videos: [['Dermatology COMPLETE Review for the USMLE', 3 * H], ['How to EASILY Memorize the Cranial Nerves', 5 * D]] },
  '@BreakingPoints': { id: id('BreakingPoints'), name: 'Breaking Points', videos: [['Krystal and Saagar: Fed Cuts Rates Again', 1 * H], ['Full Show: Shutdown Week Two', 1 * D], ['Saagar on the Polling Mess', 2 * D]] },
  '@EzraKleinShow': { id: id('EzraKleinShow'), name: 'The Ezra Klein Show', videos: [['Why the Housing Market Is Stuck', 20 * H], ['The Case for Boredom', 4 * D]] }
};
const yt = Object.values(CHANNELS);
// Mehlman's playlists: "HY USMLE Q #n - Topic". Paeds #1107 is the 91st of 130 (70%); OBGYN ends on #1607.
const range = (from, n, step) => Array.from({ length: n }, (_, i) => from + i * step);
export const PLAYLISTS = {
  PLpeds0000000000: { title: 'HY USMLE Qs - Pediatrics', topic: 'Pediatrics', nums: range(387, 130, 8) },
  PLobgyn000000000: { title: 'HY USMLE Qs - OBGYN', topic: 'OBGYN', nums: range(1430, 60, 3) },
  PLoph00000000000: { title: 'Ophthalmology', topic: 'Ophthalmology', nums: range(200, 12, 5) },
  PLim000000000000: { title: 'HY USMLE Qs - Internal Medicine', topic: 'Internal Medicine', nums: range(100, 150, 4) },
  PLpharm000000000: { title: 'Step 2 CK Pharmacology Qs', topic: 'Pharmacology', nums: range(50, 80, 9) },
  PLs1pharm0000000: { title: 'Step 1 Pharmacology', topic: 'Step 1 Pharm', nums: range(10, 30, 2) },
  PLfm000000000000: { title: 'Family Medicine Qs', topic: 'Family Medicine', nums: range(700, 40, 3) },
  PLsurg0000000000: { title: 'HY USMLE Qs - Surgery', topic: 'Surgery', nums: range(900, 25, 7) }
};
export const plVid = (pid, i) => pid.slice(2, 6) + String(i).padStart(6, '0') + 'q';
function plPage(pid, k) {
  const p = PLAYLISTS[pid];
  const vids = p.nums.slice(k * 100, k * 100 + 100).map((n, j) => ({ playlistVideoRenderer: { videoId: plVid(pid, k * 100 + j), title: { runs: [{ text: 'HY USMLE Q #' + n + ' - ' + p.topic }] }, lengthSeconds: String(420 + (n % 9) * 40), isPlayable: true } }));
  if ((k + 1) * 100 < p.nums.length) vids.push({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: pid + ':' + (k + 1) } } } });
  return vids;
}
export const PODCASTS = {
  'https://feeds.megaphone.fm/finvshistory': { title: 'Fin vs History', eps: [['Ep. 212: The Shortest War in History', 3851, 6 * H], ['Ep. 211: The Great Emu War', 3420, 7 * D]] },
  'https://feeds.example.com/ezra': { title: 'The Ezra Klein Show', eps: [['Why the Housing Market Is Stuck', 840, 20 * H], ['The Case for Boredom', 3810, 4 * D]] },
  'https://feeds.example.com/foc': { title: 'Fall of Civilizations Podcast', eps: [['Rome: The Fall of the Western Empire', 13732, 30 * D], ['The Bronze Age Collapse', 12010, 60 * D]] }
};
const ITUNES = { 'The Ezra Klein Show': 'https://feeds.example.com/ezra', 'Fall of Civilizations': 'https://feeds.example.com/foc' };
const COLS = ['#B8334A', '#1C8A99', '#D08A2B', '#1E6B52', '#6E4FB3', '#2F6FB0', '#9A5A2B', '#4B5868'];
const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const vidId = (ch, i) => ch.id.slice(2, 10) + 'v' + i + 'x';

function ytFeed(ch, now, hideNewest) {
  const vids = ch.videos.map((v, i) => ({ id: vidId(ch, i), title: v[0], at: now - v[1] })).slice(hideNewest ? 1 : 0);
  return `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
<yt:channelId>${ch.id.slice(2)}</yt:channelId><title>Videos</title><author><name>${xmlEsc(ch.name)}</name></author>
${vids.map((v) => `<entry><yt:videoId>${v.id}</yt:videoId><title>${xmlEsc(v.title)}</title><published>${new Date(v.at).toISOString()}</published><author><name>${xmlEsc(ch.name)}</name></author><media:group><media:thumbnail url="https://i.ytimg.com/vi/${v.id}/hqdefault.jpg"/><media:description>x</media:description></media:group></entry>`).join('\n')}</feed>`;
}
function podFeed(url, p, now, hideNewest) {
  const eps = p.eps.slice(hideNewest ? 1 : 0);
  return `<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>${xmlEsc(p.title)}</title><itunes:image href="https://img.example.com/${encodeURIComponent(p.title)}.png"/>
${eps.map((e, i) => `<item><title>${xmlEsc(e[0])}</title><guid>${url}#${i}${hideNewest ? 1 : 0}</guid><enclosure url="https://audio.example.com/ep${i}.wav" type="audio/wav"/><itunes:duration>${e[1]}</itunes:duration><pubDate>${new Date(now - e[2]).toUTCString()}</pubDate></item>`).join('\n')}</channel></rss>`;
}
// A quiet two-minute WAV that the browser really plays
function wav(seconds = 120) {
  const rate = 4000, n = rate * seconds, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(3 * Math.sin(i / 7));
  return b;
}
const WAV = wav();
const svg = (label, i) => `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${COLS[i % COLS.length]}"/><stop offset="1" stop-color="#111"/></linearGradient></defs><rect width="480" height="360" fill="url(#g)"/><circle cx="${120 + (i * 53) % 240}" cy="150" r="70" fill="#fff" opacity=".35"/><text x="30" y="320" font-size="34" font-family="sans-serif" fill="#fff" opacity=".85">${xmlEsc(label)}</text></svg>`;

export const FAKE_YT = `
window.YT = { PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } };
YT.Player = function (el, opts) {
  var self = this, node = document.getElementById(el);
  node.innerHTML = '<div id="fakeplayer" style="width:100%;height:100%;background:linear-gradient(135deg,#333,#000);color:#fff;display:grid;place-items:center;font:14px sans-serif">video</div>';
  var t0 = 0, base = 0, state = -1, id = null, rate = 1, dur = 600;
  window.__fake = self;
  function now() { return state === 1 ? base + (Date.now() - t0) / 1000 * rate : base; }
  function set(s) { state = s; opts.events.onStateChange && opts.events.onStateChange({ data: s, target: self }); }
  self.loadVideoById = function (o) {
    if (window.__lag) { var oldT = now(); id = o.videoId; state = 3; base = oldT; dur = 600; setTimeout(function () { base = o.startSeconds || 0; t0 = Date.now(); set(1); }, 400); return; }
    if (window.__ad) { id = o.videoId; dur = 30; base = 25; t0 = Date.now(); set(1); setTimeout(function () { dur = 600; base = o.startSeconds || 0; t0 = Date.now(); set(1); }, 400); return; }
    id = o.videoId; base = o.startSeconds || 0; t0 = Date.now(); window.__lastStart = base; window.__lastId = id; dur = 600;
    if (id === 'blockedxxxx') { setTimeout(function(){ opts.events.onError({ data: 150 }); }, 50); return; }
    setTimeout(function () { t0 = Date.now(); set(1); }, 50); };
  self.getCurrentTime = function () { var t = now(); if (t >= dur) { t = dur; } return t; };
  self.getDuration = function () { return id ? dur : 0; };
  self.getPlayerState = function () { return state; };
  self.getVideoData = function () { return { video_id: id || '', title: 'Fake title ' + id, author: 'Fake channel' }; };
  self.getPlaybackRate = function () { return rate; };
  self.setPlaybackRate = function (r) { rate = r; };
  self.playVideo = function () { if (state !== 1) { t0 = Date.now(); set(1); } };
  self.pauseVideo = function () { if (state === 1) { base = now(); set(2); } };
  self.advance = function (n) { base += n; };
  self.seekTo = function (s) { base = s; t0 = Date.now(); if (s >= dur) { base = dur; set(0); } };
  setTimeout(function () { opts.events.onReady && opts.events.onReady({ target: self }); if (window.__errOnCreate) opts.events.onError({ data: 2 }); }, 30);
};
setTimeout(function(){ window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(); }, 20);
`;

// The iPhone shell, faked: phone storage, clipboard, native HTTP and the YouTube sign-in sheet.
// Like the real shell, a plain cross-site fetch() from the page fails (the bridge routes it through
// capacitor://localhost, which the github.io page can't read), so the app must use CapacitorHttp.
// Phone storage (Preferences) outlives a reload, like the real one. shell.prefFail: every read fails (the switch
// is localStorage 'fake.prefFail', so a test can heal it before a reload); shell.web: web-view storage to start with.
// shell.ytSignedIn: YouTube cookies already there (default yes); shell.ytRefuse: Google won't finish the
// sign-in; shell.oldShell: a shell built before the ShelfSignIn plugin (its plugin list lacks it).
export const CAP = (seed, clip, shell) => { shell = Object.assign({ ytSignedIn: true }, shell); return `window.__clip = ${JSON.stringify(clip || '')}; window.__httpCalls = []; window.__prefWrites = 0; window.__ytCalls = [];
  (function () {
    if (!sessionStorage.getItem('fake.started')) {
      sessionStorage.setItem('fake.started', '1');
      sessionStorage.setItem('fake.prefs', JSON.stringify(${JSON.stringify(seed || {})}));
      localStorage.setItem('fake.prefFail', ${shell.prefFail ? "'1'" : "'0'"});
      var web = ${JSON.stringify(shell.web || {})}; Object.keys(web).forEach(function (k) { localStorage.setItem(k, web[k]); });
    }
    window.__prefs = JSON.parse(sessionStorage.getItem('fake.prefs'));
    var keep = function () { sessionStorage.setItem('fake.prefs', JSON.stringify(window.__prefs)); };
    // The sheet's cookie jar outlives a page reload, like the real one
    var yt = { get signedIn() { var v = localStorage.getItem('fake.yt'); return v == null ? ${!!shell.ytSignedIn} : v === '1'; }, set signedIn(b) { localStorage.setItem('fake.yt', b ? '1' : '0'); } };
    var signIn = ${shell.oldShell ? '{}' : `{ PluginHeaders: [{ name: 'ShelfSignIn', methods: [] }], plugin: {
      status: async () => ({ signedIn: yt.signedIn }),
      signIn: async () => { window.__ytCalls.push('signIn'); if (!${!!shell.ytRefuse}) yt.signedIn = true; return { signedIn: yt.signedIn }; },
      signOut: async () => { window.__ytCalls.push('signOut'); yt.signedIn = false; return { signedIn: false }; },
      openSettings: async () => { window.__ytCalls.push('openSettings'); } } }`};
    var webFetch = window.fetch.bind(window);
    window.fetch = function (res, opts) {
      var u = typeof res === 'string' ? res : res.url;
      if (/^https?:/.test(u) && new URL(u).origin !== location.origin) return Promise.reject(new TypeError('Load failed'));
      return webFetch(res, opts);
    };
    window.Capacitor = { isNativePlatform: () => true, Plugins: {
      Preferences: { get: async ({ key }) => { if (localStorage.getItem('fake.prefFail') === '1') throw new Error('Preferences unavailable'); return { value: key in window.__prefs ? window.__prefs[key] : null }; },
        set: async ({ key, value }) => { window.__prefs[key] = value; window.__prefWrites++; keep(); } },
      Clipboard: { read: async () => ({ value: window.__clip, type: 'text/plain' }), write: async ({ string }) => { window.__clip = string; } },
      CapacitorHttp: { request: async ({ url, method, headers, data }) => {
        window.__httpCalls.push({ url: url, method: method, headers: headers, data: data });
        var r = await webFetch(url, method === 'POST' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : undefined);
        var t = await r.text(), ct = r.headers.get('content-type') || '';
        return { status: r.status, url: url, headers: { 'content-type': ct }, data: /json/.test(ct) ? JSON.parse(t) : t };
      } } } };
    if (signIn.plugin) { window.Capacitor.PluginHeaders = signIn.PluginHeaders; window.Capacitor.Plugins.ShelfSignIn = signIn.plugin; }
  })();`; };

// opts.fresh: hide the newest item on the first fetch of each feed, so a later refresh shows "new"
export async function installFakes(ctx, opts = {}) {
  const now = Date.now(), seen = {};
  const cors = { 'access-control-allow-origin': '*' };
  const first = (u) => { const f = !seen[u]; seen[u] = 1; return f && opts.fresh; };
  await ctx.route('https://www.youtube.com/**', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/iframe_api') return opts.ytDown ? r.abort() : r.fulfill({ contentType: 'text/javascript', body: FAKE_YT });
    if (u.pathname === '/feeds/videos.xml') {
      const key = u.searchParams.get('playlist_id') || u.searchParams.get('channel_id');
      const ch = yt.find((c) => key.endsWith(c.id.slice(2)));
      const down = (opts.feedDown || []).some((h) => CHANNELS[h] && CHANNELS[h].id === (ch && ch.id));
      if (!ch || down) return r.fulfill({ status: down ? 500 : 404, headers: cors, body: '' });
      return r.fulfill({ contentType: 'application/atom+xml', headers: cors, body: ytFeed(ch, now, first(ch.id)) });
    }
    if (u.pathname === '/@MehlmanMedical/playlists') {
      const data = { contents: Object.keys(PLAYLISTS).map((id) => ({ lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', metadata: { lockupMetadataViewModel: { title: { content: PLAYLISTS[id].title } } }, overlay: { text: PLAYLISTS[id].nums.length + ' videos' } } })) };
      return r.fulfill({ contentType: 'text/html', headers: cors, body: '<html><script>var ytInitialData = ' + JSON.stringify(data) + ';</script></html>' });
    }
    if (u.pathname === '/playlist') {
      const pid = u.searchParams.get('list');
      if (!PLAYLISTS[pid] || opts.plDown) return r.fulfill({ status: opts.plDown ? 500 : 404, headers: cors, body: '' });
      const data = { metadata: { playlistMetadataRenderer: { title: PLAYLISTS[pid].title } }, contents: plPage(pid, 0) };
      return r.fulfill({ contentType: 'text/html', headers: cors, body: '<html><script>ytcfg.set({"INNERTUBE_CLIENT_VERSION":"2.20260901.01.00","INNERTUBE_API_KEY":"AIzaFAKEKEY"});</script><script>var ytInitialData = ' + JSON.stringify(data) + ';</script></html>' });
    }
    if (u.pathname === '/youtubei/v1/browse' && r.request().method() === 'POST') {
      const tok = JSON.parse(r.request().postData() || '{}').continuation || '';
      const [pid, k] = tok.split(':');
      if (!PLAYLISTS[pid]) return r.fulfill({ status: 400, headers: cors, body: '{}' });
      return r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: plPage(pid, +k) } }] }) });
    }
    if (u.pathname === '/watch') {
      const v = u.searchParams.get('v') || '';
      const status = /priv/.test(v) ? 'LOGIN_REQUIRED' : 'OK', len = /long/.test(v) ? 3 * 3600 : 600;
      return r.fulfill({ contentType: 'text/html', headers: cors, body: `<html><script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"${status}"},"videoDetails":{"videoId":"${v}","lengthSeconds":"${len}"}};</script></html>` });
    }
    const vids = u.pathname.match(/^\/channel\/(UC[\w-]{22})\/videos$/);
    if (vids) { // a channel's Videos tab (newer lockup shape), used when its feed fails
      const ch = yt.find((c) => c.id === vids[1]);
      if (!ch) return r.fulfill({ status: 404, headers: cors, body: '' });
      const ago = (ms) => ms < D ? Math.round(ms / H) + ' hours ago' : Math.round(ms / D) + ' days ago';
      const data = { contents: ch.videos.map((v, i) => ({ lockupViewModel: { contentId: vidId(ch, i), contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        metadata: { lockupMetadataViewModel: { title: { content: v[0] }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: '9K views' } }, { text: { content: ago(v[1]) } }] }] } } } } } })) };
      return r.fulfill({ contentType: 'text/html', headers: cors, body: `<html><head><meta property="og:title" content="${ch.name}"><meta itemprop="identifier" content="${ch.id}"></head><script>var ytInitialData = ${JSON.stringify(data)};</script></html>` });
    }
    const handle = decodeURIComponent(u.pathname.slice(1));
    if (CHANNELS[handle]) {
      const ch = CHANNELS[handle];
      return r.fulfill({ contentType: 'text/html', headers: cors, body: `<html><head><meta property="og:title" content="${ch.name}"><meta property="og:image" content="https://yt3.example.com/${ch.id}.png"><meta itemprop="identifier" content="${ch.id}"></head><body><script>var ytInitialData={"canonicalBaseUrl":"/${handle}"}</script></body></html>` });
    }
    if (u.pathname === '/results') {
      const q = (u.searchParams.get('search_query') || '').toLowerCase();
      if (u.searchParams.get('sp')) { // channel search
        const ch = yt.find((c) => c.name.toLowerCase().includes(q));
        return r.fulfill({ contentType: 'text/html', headers: cors, body: ch ? `"channelRenderer":{"channelId":"${ch.id}","title":{"simpleText":"${ch.name}"}}` : 'var ytInitialData = {};' });
      }
      const hits = [];
      yt.forEach((c) => c.videos.forEach((v, i) => { if (v[0].toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) hits.push({ c, v, i }); }));
      const body = 'var ytInitialData = {"contents":[' + yt.filter((c) => c.name.toLowerCase().includes(q)).map((c) => `{"channelRenderer":{"channelId":"${c.id}","title":{"simpleText":"${c.name}"}}}`).concat(hits.map(({ c, v, i }) =>
        `{"videoRenderer":{"videoId":"${vidId(c, i)}","title":{"runs":[{"text":"${v[0]}"}]},"lengthText":{"accessibility":{},"simpleText":"${10 + i * 7}:0${i}"},"ownerText":{"runs":[{"text":"${c.name}","navigationEndpoint":{"browseEndpoint":{"browseId":"${c.id}"}}}]}}}`)).join(',') + ']};';
      return r.fulfill({ contentType: 'text/html', headers: cors, body });
    }
    return r.fulfill({ status: 404, body: '' });
  });
  await ctx.route('https://itunes.apple.com/**', (r) => {
    const term = new URL(r.request().url()).searchParams.get('term');
    const feed = ITUNES[term];
    r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ results: feed ? [{ feedUrl: feed, collectionName: PODCASTS[feed].title }] : [] }) });
  });
  const podRoute = (r) => {
    const url = r.request().url(), p = PODCASTS[url];
    if (!p) return r.fulfill({ status: 404, headers: cors, body: '' });
    r.fulfill({ contentType: 'application/rss+xml', headers: cors, body: podFeed(url, p, now, first(url)) });
  };
  await ctx.route('https://feeds.megaphone.fm/**', podRoute);
  await ctx.route('https://feeds.example.com/**', podRoute);
  await ctx.route('https://audio.example.com/**', (r) => r.fulfill({ contentType: 'audio/wav', headers: { ...cors, 'accept-ranges': 'bytes' }, body: WAV }));
  await ctx.route(/https:\/\/(i\.ytimg\.com|img\.example\.com|yt3\.example\.com)\/.*/, (r) => {
    const u = r.request().url(); let n = 0; for (const c of u) n = (n * 31 + c.charCodeAt(0)) % 997;
    r.fulfill({ contentType: 'image/svg+xml', body: svg('', n) });
  });
  // A pretend Gemini. opts.gemini = { mode: ok|slow|badkey|busy|daily, calls: [] } (shared with the test, so it can switch)
  const G = opts.gemini || { mode: 'ok', calls: [] };
  await ctx.route('https://generativelanguage.googleapis.com/**', async (r) => {
    const req = r.request(), body = JSON.parse(req.postData() || '{}'), parts = (body.contents && body.contents[0].parts) || [];
    const video = parts.find((p) => p.fileData), text = (parts.find((p) => p.text) || {}).text || '';
    G.calls.push({ url: req.url(), key: req.headers()['x-goog-api-key'], video: video && video.fileData.fileUri, clip: video && video.videoMetadata, processing: video && video.mediaProcessing, text });
    const err = (code, message, extra) => r.fulfill({ status: code, contentType: 'application/json', headers: cors, body: JSON.stringify({ error: Object.assign({ code, message }, extra || {}) }) });
    if (G.mode === 'badkey') return err(400, 'API key not valid. Please pass a valid API key.', { status: 'INVALID_ARGUMENT' });
    if (G.mode === 'busy') { G.mode = 'ok'; return err(429, 'Resource has been exhausted (e.g. check quota).', { status: 'RESOURCE_EXHAUSTED' }); }
    if (G.mode === 'daily') return err(429, 'Quota exceeded', { details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] });
    if (video && /priv/.test(video.fileData.fileUri)) return err(400, 'Cannot fetch content from the provided URL. The YouTube video may be private.');
    if (G.mode === 'slow') await new Promise((res) => setTimeout(res, 1500));
    let out;
    if (/Reply OK/.test(text)) out = 'OK';
    else if (/"points"/.test(text)) out = JSON.stringify({ gist: 'Fake gist for ' + (video ? video.fileData.fileUri.slice(-11) : ''), points: [{ t: '0:30', text: 'First point' }, { t: '2:05', text: 'Second point' }, { t: '4:40', text: 'Third point' }] });
    else if (/"bullets"/.test(text) && !/"cards"/.test(text)) out = JSON.stringify({ topic: 'Plain topic', bullets: [{ t: '1:00', text: 'A plain bullet' }, { t: '3:00', text: 'Another bullet' }] });
    else if (/"cards"/.test(text)) out = '```json\n' + JSON.stringify({ topic: 'Renal physiology', facts: [{ t: '1:10', text: 'Loop diuretics act on the thick ascending limb' }], tested: [{ clue: 'Hypokalaemia after furosemide', dx: 'Loop diuretic effect', next: 'Replace potassium' }], versus: [{ name: 'Thiazides', feature: 'cause hypercalcaemia' }], questions: [],
      cards: [{ stem: 'A man on furosemide has cramps and a low potassium.', questions: ['What is the cause?', 'What do you do next?'], answer: 'This is **loop diuretic hypokalaemia**.', management: 'Replace **potassium**.', vs: 'Versus thiazides: high calcium, so check calcium.', why: 'Loops waste potassium.' }] }) + '\n```';
    else if (/ONE card/.test(text)) out = JSON.stringify({ stem: 'A child has 5 days of fever and a strawberry tongue.', questions: ['What is the diagnosis?'], answer: 'This is **Kawasaki disease**.', management: '', vs: 'Versus scarlet fever: a sandpaper rash, so give penicillin.', why: 'Coronary aneurysms are the risk.' });
    else out = '{}';
    r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] }, finishReason: 'STOP' }] }) });
  });
  await ctx.route('https://www.googleapis.com/**', (r) => r.fulfill({ status: 403, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }) }));
  // opts.fontsDir: a folder with fonts.css + map.txt (downloaded once) so screenshots use the real faces
  let fontMap = null;
  if (opts.fontsDir) { fontMap = {}; fs.readFileSync(opts.fontsDir + '/map.txt', 'utf8').trim().split('\n').forEach((l) => { const [u, f] = l.split(' '); fontMap[u] = f; }); }
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fontMap ? fs.readFileSync(opts.fontsDir + '/fonts.css') : '' }));
  await ctx.route('https://fonts.gstatic.com/**', (r) => fontMap && fontMap[r.request().url()] ? r.fulfill({ contentType: 'font/woff2', headers: cors, body: fs.readFileSync(opts.fontsDir + '/' + fontMap[r.request().url()]) }) : r.abort());
}
