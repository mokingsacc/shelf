// Marks: save a moment, add a note, copy for Anki. Fake storage and clock.
const assert = require('assert');
const Marks = require('../src/marks.js');
const store = {}; let t = Date.parse('2026-10-04T14:08:00Z');
const io = { load: (k) => (k in store ? store[k] : null), save: (k, v) => { store[k] = v; }, now: () => t };
const m = Marks.create(io);
assert.strictEqual(m.count, 0);
const a = m.add({ vid: 'abcdefghijk', title: 'HY USMLE Q #1115 - Pediatrics', t: 252.7, course: 'Paeds' });
assert.strictEqual(a.t, 252); assert.strictEqual(Marks.fmt(a.t), '4:12');
t += 1000; const b = m.add({ vid: 'zyxwvutsrqp', title: 'Long\tlecture\nname', t: 3725, note: '' });
assert.deepStrictEqual(m.list().map((x) => x.id), [b.id, a.id], 'newest first');
m.setNote(a.id, 'Kawasaki:\tIVIG +\naspirin');
const lines = m.anki().split('\n');
assert.strictEqual(lines.length, 2);
assert.strictEqual(lines[1], 'HY USMLE Q #1115 - Pediatrics @ 4:12: Kawasaki: IVIG + aspirin\thttps://www.youtube.com/watch?v=abcdefghijk&t=252s', 'front TAB back, one line');
assert.strictEqual(lines[0], 'Long lecture name @ 1:02:05\thttps://www.youtube.com/watch?v=zyxwvutsrqp&t=3725s', 'tabs and newlines in titles are flattened; hours shown');
assert.ok(lines.every((l) => l.split('\t').length === 2), 'exactly one tab a line');
// Survives a relaunch; damaged entries are dropped
const again = Marks.create(io); assert.strictEqual(again.count, 2);
const removed = again.remove(b.id); assert.strictEqual(again.count, 1); again.restore(removed); assert.strictEqual(again.count, 2, 'undo');
store[Marks.KEY] = JSON.stringify({ items: [null, { id: 'x' }, { id: 'y', vid: 'abcdefghijk', t: 5, at: 1 }] });
assert.strictEqual(Marks.create(io).count, 1);
store[Marks.KEY] = '{broken'; assert.strictEqual(Marks.create(io).count, 0);
console.log('marks: all checks passed');
