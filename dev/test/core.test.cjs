const assert = require('assert');
const C = require('../src/core.js');
const L = (s) => C.parseLink(s);
const cases = [
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', 0],
  ['https://youtu.be/dQw4w9WgXcQ?t=90', 'dQw4w9WgXcQ', 90],
  ['https://youtu.be/dQw4w9WgXcQ?si=abc&t=1m30s', 'dQw4w9WgXcQ', 90],
  ['youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s', 'dQw4w9WgXcQ', 3723],
  ['https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=2', 'dQw4w9WgXcQ', 0],
  ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ', 0],
  ['https://www.youtube.com/live/dQw4w9WgXcQ?feature=share', 'dQw4w9WgXcQ', 0],
  ['https://www.youtube.com/embed/dQw4w9WgXcQ?start=42', 'dQw4w9WgXcQ', 42],
  ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ', 0],
  ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', 0],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=30', 'dQw4w9WgXcQ', 30],
  ['dQw4w9WgXcQ', 'dQw4w9WgXcQ', 0],
];
for (const [s, id, t] of cases) { const r = L(s); assert.ok(r, s); assert.strictEqual(r.id, id, s); assert.strictEqual(r.t, t, s); }
for (const bad of ['', 'hello', 'https://vimeo.com/123', 'https://www.youtube.com/', 'https://www.youtube.com/@channel', 'https://evil.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ'])
  assert.strictEqual(L(bad), null, bad);
const many = C.findLinks('look at https://youtu.be/dQw4w9WgXcQ, and (https://www.youtube.com/watch?v=9bZkp7q19f0&t=10). Again https://youtu.be/dQw4w9WgXcQ');
assert.deepStrictEqual(many, [{id:'dQw4w9WgXcQ',t:0},{id:'9bZkp7q19f0',t:10}]);
assert.deepStrictEqual(C.findLinks('no links here'), []);
assert.strictEqual(C.fmt(65), '1:05'); assert.strictEqual(C.fmt(3723), '1:02:03'); assert.strictEqual(C.fmt(0), '0:00');
assert.strictEqual(C.left(0, 600), '10 min left'); assert.strictEqual(C.left(590, 600), 'Less than a minute left'); assert.strictEqual(C.left(0, 3900), '1 hr 5 min left');
assert.ok(C.isDone(595, 600)); assert.ok(!C.isDone(300, 600)); assert.ok(!C.isDone(10, 0));
assert.strictEqual(C.resumeAt({t: 63}), 60); assert.strictEqual(C.resumeAt({t: 3}), 0); assert.strictEqual(C.resumeAt({t: 100, done: true}), 0);
const shelf = {
  a: { id: 'dQw4w9WgXcQ', t: 61, dur: 212, updated: 2000000, title: 'Heart murmurs in 12 minutes — Ünïcödé' },
  b: { id: '9bZkp7q19f0', t: 252, dur: 252, done: true, updated: 1000000, title: 'Done one' },
};
const shelfById = { dQw4w9WgXcQ: shelf.a, '9bZkp7q19f0': shelf.b };
const back = C.decodeShelf(C.encodeShelf(shelfById));
assert.strictEqual(back.dQw4w9WgXcQ.t, 61); assert.strictEqual(back.dQw4w9WgXcQ.title, shelf.a.title); assert.ok(back['9bZkp7q19f0'].done);
// big shelf stays under QR size
const big = {}; for (let i = 0; i < 300; i++) { const id = ('vid' + i).padEnd(11, 'x'); big[id] = { id, t: i * 10, dur: 4000, updated: i * 1000, title: 'A fairly long lecture title number ' + i }; }
const code = C.encodeShelf(big); assert.ok(code.length <= 2200, 'len ' + code.length);
const dec = C.decodeShelf(code); assert.ok(Object.keys(dec).length > 50); assert.ok(dec['vid299xxxxx'], 'newest kept');
// merge: newer wins, keeps title
const m = C.merge({ x: { id: 'x', t: 10, updated: 5, title: 'T' } }, { x: { id: 'x', t: 50, updated: 9, title: '' }, y: { id: 'y', t: 1, updated: 1 } });
assert.strictEqual(m.videos.x.t, 50); assert.strictEqual(m.videos.x.title, 'T'); assert.strictEqual(m.added, 1); assert.strictEqual(m.updated, 1);
const m2 = C.merge({ x: { id: 'x', t: 10, updated: 9 } }, { x: { id: 'x', t: 50, updated: 5 } });
assert.strictEqual(m2.videos.x.t, 10);
assert.throws(() => C.decodeShelf('!!!'));
const N = new Date(2026, 9, 4, 15, 0).getTime();
assert.strictEqual(C.ago(N - 30e3, N), 'just now'); assert.strictEqual(C.ago(N - 20 * 60e3, N), '20 min ago');
assert.strictEqual(C.ago(N - 3 * 3600e3, N), 'today'); assert.strictEqual(C.ago(N - 20 * 3600e3, N), 'yesterday');
assert.strictEqual(C.ago(N - 3 * 86400e3, N), '3 days ago'); assert.strictEqual(C.ago(N - 9 * 86400e3, N), 'last week'); assert.strictEqual(C.ago(0, N), '');
const nt = C.decodeShelf(C.encodeShelf(shelfById, 900, false)); assert.strictEqual(nt.dQw4w9WgXcQ.title, ''); assert.strictEqual(nt.dQw4w9WgXcQ.t, 61);
console.log('core: all tests passed');
