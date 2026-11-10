const assert = require('assert');
const fs = require('fs');
global.Core = require('../src/core.js');
const F = require('../src/feeds.js');
const fx = (n) => fs.readFileSync(__dirname + '/fixtures/' + n, 'utf8');
const yt = F.parseYouTube(fx('yt-feed.xml'));
assert.strictEqual(yt.channelId, 'UCgF2C3zwV2-Ycq9fxXDZqmA');
assert.strictEqual(yt.title, 'Dirty Medicine');
assert.strictEqual(yt.items.length, 2);
assert.strictEqual(yt.items[0].id, 'aaaaaaaaaa2', 'newest first');
assert.strictEqual(yt.items[1].title, 'Hyperkalemia Mnemonics & Treatment');
assert.strictEqual(yt.items[1].description, 'In this video we cover hyperkalemia <3');
assert.ok(yt.items[1].thumb.includes('aaaaaaaaaa1'));
assert.deepStrictEqual(F.youtubeFeedUrls('UCgF2C3zwV2-Ycq9fxXDZqmA'), ['https://www.youtube.com/feeds/videos.xml?playlist_id=UULFgF2C3zwV2-Ycq9fxXDZqmA', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCgF2C3zwV2-Ycq9fxXDZqmA']);
assert.throws(() => F.parseYouTube('<html></html>'));
const pod = F.parsePodcast(fx('podcast.xml'));
assert.strictEqual(pod.title, 'Fin vs History');
assert.strictEqual(pod.image, 'https://example.com/art.jpg');
assert.strictEqual(pod.items.length, 2, 'item without audio skipped');
assert.strictEqual(pod.items[0].title, 'Ep. 213: The Emu War');
assert.strictEqual(pod.items[0].duration, 2950);
assert.strictEqual(pod.items[0].image, 'https://example.com/ep213.jpg');
assert.strictEqual(pod.items[0].url, 'https://traffic.megaphone.fm/FIN213.mp3');
assert.strictEqual(pod.items[1].title, 'Ep. 212: The Shortest War in History');
assert.strictEqual(pod.items[1].duration, 3723);
assert.strictEqual(pod.items[1].guid, 'abc-212');
assert.strictEqual(pod.items[1].description, 'Fin and Horatio on the Anglo-Zanzibar war & more.');
assert.strictEqual(pod.items[1].image, 'https://example.com/art.jpg');
assert.strictEqual(pod.items[1].episode, 212);
assert.throws(() => F.parsePodcast('<feed></feed>'));
const P = F.parseChannelInput;
assert.deepStrictEqual(P('https://www.youtube.com/@DirtyMedicine'), { kind: 'handle', value: '@DirtyMedicine' });
assert.deepStrictEqual(P('youtube.com/@DirtyMedicine/videos'), { kind: 'handle', value: '@DirtyMedicine' });
assert.deepStrictEqual(P('@breakingpoints'), { kind: 'handle', value: '@breakingpoints' });
assert.deepStrictEqual(P('https://www.youtube.com/channel/UCgF2C3zwV2-Ycq9fxXDZqmA'), { kind: 'id', value: 'UCgF2C3zwV2-Ycq9fxXDZqmA' });
assert.deepStrictEqual(P('https://m.youtube.com/c/Mehlman'), { kind: 'page', value: 'https://www.youtube.com/c/Mehlman' });
assert.deepStrictEqual(P('https://youtu.be/dQw4w9WgXcQ'), { kind: 'video', value: 'dQw4w9WgXcQ' });
assert.deepStrictEqual(P('https://feeds.megaphone.fm/finvshistory'), { kind: 'feed', value: 'https://feeds.megaphone.fm/finvshistory' });
assert.deepStrictEqual(P('https://www.patreon.com/rss/fintaylor?auth=xyz'), { kind: 'feed', value: 'https://www.patreon.com/rss/fintaylor?auth=xyz' });
assert.deepStrictEqual(P('Fall of Civilizations'), { kind: 'name', value: 'Fall of Civilizations' });
assert.strictEqual(P(''), null);
assert.strictEqual(F.pageUrl({ kind: 'handle', value: '@x' }), 'https://www.youtube.com/@x');
const ch = F.channelFromHtml(fx('channel.html'));
assert.deepStrictEqual(ch, { id: 'UCbbbbbbbbbbbbbbbbbbbbbb', name: 'Mehlman Medical', avatar: 'https://yt3.googleusercontent.com/abc=s900-c-k', handle: '@MehlmanMedical' });
assert.strictEqual(F.channelFromHtml('<html>nothing</html>'), null);
assert.ok(F.isConsentPage('<form action="https://consent.youtube.com/save">'));
assert.ok(!F.isConsentPage(fx('channel.html')));
assert.strictEqual(F.duration('45:10'), 2710); assert.strictEqual(F.duration(''), 0); assert.strictEqual(F.duration('abc'), 0);
// Podcast twins: the channel's own podcast by name, then the episode by title words and date
const it = (feedUrl, collectionName) => ({ feedUrl, collectionName });
assert.strictEqual(F.podcastFor('The Ezra Klein Show', [it('https://x/other', 'Ezra Talks'), it('https://x/ezra', 'The Ezra Klein Show')]), 'https://x/ezra');
assert.strictEqual(F.podcastFor('Breaking Points', [it('https://x/bp', 'Breaking Points with Krystal and Saagar')]), 'https://x/bp');
assert.strictEqual(F.podcastFor('Dirty Medicine', [it('https://x/dm', 'Medicine Matters')]), '', 'a different show is not a twin');
assert.strictEqual(F.podcastFor('Dirty Medicine', []), '');
const T = Date.parse('2026-10-05T12:00:00Z'), eps = [
  { guid: 'a', title: 'Why the Housing Market Is Stuck', published: T + 3600e3 },
  { guid: 'b', title: 'The Case for Boredom', published: T - 4 * 864e5 },
  { guid: 'c', title: 'Why the Housing Market Was Fine in 2019', published: T - 300 * 864e5 }];
assert.strictEqual(F.episodeFor({ title: 'Why the Housing Market Is Stuck | The Ezra Klein Show', published: T }, eps, 'The Ezra Klein Show').guid, 'a', 'channel name in the video title is ignored');
assert.strictEqual(F.episodeFor({ title: 'Why the Housing Market Is Stuck', published: T + 40 * 864e5 }, eps, 'The Ezra Klein Show'), null, 'same title but published weeks apart');
assert.strictEqual(F.episodeFor({ title: 'Why the Housing Market Is Stuck (feat. Jenny Schuetz)', published: T }, eps, 'The Ezra Klein Show').guid, 'a', 'a guest added to the video title still matches');
assert.strictEqual(F.episodeFor({ title: 'Inflation Is Back and Nobody Noticed', published: T }, [{ guid: 'z', title: 'Inflation Explained', published: T }], 'x'), null, 'one shared word is not a match');
assert.strictEqual(F.episodeFor({ title: 'Saagar on the Polling Mess', published: T }, eps, 'Breaking Points'), null, 'no episode: no button');

// videoFor: a podcast episode's own video among YouTube search results
var res = [
  { kind: 'channel', id: 'UCx', title: 'Fin vs History' },
  { kind: 'video', id: 'clip1', title: 'Agincourt in 60 seconds', channel: 'Fin vs History', dur: 61 },
  { kind: 'video', id: 'other', title: 'The War of the Noses | Agincourt (Part 1) reaction', channel: 'Some Reactor', dur: 4100 },
  { kind: 'video', id: 'own', title: 'The War of The Noses | Agincourt (Part 1) | Fin vs History', channel: 'Fin vs History', dur: 3240 }
];
var agin = { title: 'The War of The Noses | Agincourt (Part 1)', duration: 3185 };
assert.strictEqual(F.videoFor(agin, res, 'Fin vs History').id, 'own', 'the channel with the podcast\'s name and the same length wins');
assert.strictEqual(F.videoFor(agin, res.slice(0, 3), 'Fin vs History'), null, 'a reaction video a different length is not it');
assert.strictEqual(F.videoFor({ title: 'The War of The Noses | Agincourt (Part 1)' }, [res[3]], 'Fin vs History').id, 'own', 'no length known: the title and channel decide');
assert.strictEqual(F.videoFor({ title: 'Agincourt', duration: 3185 }, res, 'Fin vs History'), null, 'a one-word title is too thin to match');
assert.strictEqual(F.videoFor({ title: '3. The Mayan Collapse - Ruins Among the Trees', duration: 3600 * 2 }, [{ kind: 'video', id: 'm', title: 'Fall of Civilizations: 3. The Mayan Collapse - Ruins Among the Trees', channel: 'Fall of Civilizations', dur: 3600 * 2 + 200 }], 'Fall of Civilizations Podcast').id, 'm', 'podcast name with "Podcast" on the end still finds its channel');
var two = { kind: 'video', id: 'p2', title: 'The War of The Noses | Agincourt (Part 2)', channel: 'Fin vs History', dur: 3300 };
assert.strictEqual(F.videoFor(agin, [two], 'Fin vs History'), null, 'Part 2 is never Part 1, however alike the titles');
assert.strictEqual(F.videoFor(agin, [two, res[3]], 'Fin vs History').id, 'own', 'Part 1 finds Part 1 beside Part 2');
assert.strictEqual(F.videoFor({ title: 'Supernova in the East I', duration: 18000 }, [{ kind: 'video', id: 'e2', title: 'Supernova in the East II', channel: 'Hardcore History', dur: 17000 }], 'Hardcore History'), null, 'roman numerals: I is not II');
assert.strictEqual(F.videoFor({ title: 'Supernova in the East II', duration: 17000 }, [{ kind: 'video', id: 'e2', title: 'Hardcore History 63 - Supernova in the East II', channel: 'Dan Carlin', dur: 17100 }], 'Hardcore History').id, 'e2', 'roman numerals that agree still match');
assert.strictEqual(F.videoFor(agin, [{ kind: 'video', id: 'live', live: true, title: agin.title, channel: 'Fin vs History' }], 'Fin vs History'), null, 'a live stream is never it');
assert.strictEqual(F.episodeFor({ title: 'The Case for Boredom', published: 0 }, eps, 'The Ezra Klein Show').guid, 'b', 'a pasted video (no date) needs a closer title');
assert.strictEqual(F.episodeFor({ title: 'Why the Housing Market Is Stuck', published: T }, [{ guid: 'n', title: 'Ep. 212: Why the Housing Market Is Stuck', published: T }], 'x').guid, 'n', 'episode numbers are ignored');
assert.strictEqual(F.episodeFor({ title: 'Boredom', published: T }, eps, 'x'), null, 'one word is too little to go on');
assert.strictEqual(F.podcastFor('Dirty Medicine', [it('https://x/m', 'Medicine')]), '', 'a podcast named with just one word of the channel is not its twin');
assert.strictEqual(F.episodeFor({ title: 'Krystal: Trump Tariffs DISASTER', published: T }, [{ guid: 'full', title: '10/6/25: Trump Tariffs Crash Markets, Israel Strikes, Shutdown Week Two, Polling Mess', published: T }], 'Breaking Points'), null, 'a clip is not the full show');

// Real results pages: a joint byline still reads, and an episode with another title gets a short list
{
  global.Feeds = F;
  const Search = require('../src/search.js');
  const ezraRes = Search.fromPage(fx('yt-results-ezra.html')), finRes = Search.fromPage(fx('yt-results-fin.html'));
  assert.strictEqual(F.videoFor({ title: 'Is There an A.I. Bubble? A Debate.', duration: 4245 }, ezraRes, 'The Ezra Klein Show').id, '9GLdGc9OX-A');
  const dingo = { title: 'Golden Grahams Are For Satanists | “A Dingo Ate My Baby!” (Part 1)', duration: 2842 };
  assert.strictEqual(F.videoFor(dingo, finRes, 'Fin vs History'), null, 'different titles: no title match');
  let ch = F.videoChoices(dingo, finRes, 'Fin vs History', finRes.shows);
  assert.strictEqual(ch.length, 1);
  assert.strictEqual(ch[0].id, 'wCSVyeUoQIg'); assert.ok(ch[0].own && ch[0].fits === true);
  assert.ok(!ch.some((c) => c.id === 'VHOh2OtXX3g' || c.id === 'IKHL3Fy-EmI'), 'too long and too short are left out');
  ch = F.videoChoices(dingo, finRes, 'Fin vs History');
  assert.deepStrictEqual(ch.map((c) => c.id), ['wCSVyeUoQIg']);
  assert.strictEqual(ch[0].own, false);
  // Own first, YouTube's order otherwise, at most 6, no live, no unknown length unless own, 3 others when the episode has no length
  const v = (id, channel, dur, x) => Object.assign({ kind: 'video', id, title: id, channel, channelId: 'UC' + 'x'.repeat(22), dur }, x || {});
  const many = [v('o1', 'Other', 1000), v('o2', 'Other', 1000), v('mine', 'Fin vs History', 1000), v('nolen', 'Other', 0), v('mylen', 'Fin vs History', 0), v('lv', 'Fin vs History', 0, { live: true }), v('o3', 'Other', 1000), v('o4', 'Other', 1000), { kind: 'channel', id: 'c' }];
  assert.deepStrictEqual(F.videoChoices({ title: 't' }, many, 'Fin vs History').map((c) => c.id), ['mine', 'mylen', 'o1', 'o2', 'o3']);
  assert.deepStrictEqual(F.videoChoices({ title: 't', duration: 1000 }, many, 'Fin vs History').map((c) => c.id), ['mine', 'mylen', 'o1', 'o2', 'o3', 'o4']);
  assert.deepStrictEqual(F.videoChoices({ title: 't', duration: 1000 }, [v('far', 'Fin vs History', 1400)], 'Fin vs History'), [], 'over 300 s off');
  assert.deepStrictEqual(F.videoChoices({ title: 't', duration: 1000 }, [v('near', 'Fin vs History', 1290)], 'Fin vs History').map((c) => c.id), ['near']);
  assert.deepStrictEqual(F.videoChoices({ title: 't', duration: 1000 }, [v('x', 'Other', 1000)], 'Fin vs History', [{ title: 'Fin Vs. History', channelId: 'UC' + 'x'.repeat(22) }]).map((c) => c.own), [true], 'a show card names the channel');
  assert.strictEqual(F.videoChoices({ title: 't', duration: 1000 }, Array.from({ length: 9 }, (_, i) => v('m' + i, 'Fin vs History', 1000)), 'Fin vs History').length, 6);
}
console.log('feeds: all tests passed');
