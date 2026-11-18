// Sync: merging two devices' copies of each store. Hand-written cases for every rule, a seeded random test
// (SEED=n to repeat one run), and the times the real modules write down. Plain node.
const assert = require('assert');
global.Core = require('../src/core.js');
global.Feeds = require('../src/feeds.js');
global.Courses = require('../src/courses.js');
const Sync = require('../src/sync.js');
const Library = require('../src/library.js');
const Courses = global.Courses;
const Marks = require('../src/marks.js');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const DAY = 864e5, NOW = Date.parse('2026-11-18T12:00:00Z');
const clone = (x) => JSON.parse(JSON.stringify(x));
const MERGE = { videos: Sync.mergeVideos, audio: Sync.mergeAudio, library: Sync.mergeLibrary, courses: Sync.mergeCourses, marks: Sync.mergeMarks, prefs: Sync.mergePrefs };

// Device 1 (A) merges the server's copy (B); device 2 then pulls device 1's result. Both must end the same,
// merging a result with itself changes nothing, and neither argument is changed.
// (Hand-written cases use small times, so their clock is small too; the 180-day cases pass NOW.)
function both(kind, A, B, now = 1e6) {
  const merge = MERGE[kind], a0 = JSON.stringify(A), b0 = JSON.stringify(B);
  const M = merge(A, B, now);
  assert.strictEqual(JSON.stringify(A), a0, kind + ': local copy unchanged'); assert.strictEqual(JSON.stringify(B), b0, kind + ': remote copy unchanged');
  const m0 = JSON.stringify(M);
  const MM = merge(M, M, now), BM = merge(B, M, now);
  assert.strictEqual(JSON.stringify(M), m0, kind + ': the result is not changed by merging it again');
  assert.ok(Sync.same(MM, M, kind), kind + ': merge(M, M) = M\n' + JSON.stringify(MM) + '\n' + JSON.stringify(M));
  assert.ok(Sync.same(BM, M, kind), kind + ': merge(B, M) = M\n' + JSON.stringify(BM) + '\n' + JSON.stringify(M));
  n += 3;
  return M;
}

// ---------------------------------------------------------------- Videos
{
  const v = (id, updated, extra) => Object.assign({ id, t: 10, dur: 600, updated }, extra || {});
  // Old data on both sides (no removals recorded): a union, nothing lost
  let M = both('videos', { items: { aaaaaaaaaaa: v('aaaaaaaaaaa', 10) } }, { items: { bbbbbbbbbbb: v('bbbbbbbbbbb', 20) } });
  eq(Object.keys(M.items).sort(), ['aaaaaaaaaaa', 'bbbbbbbbbbb'], 'videos: old copies merge as a union');
  eq(M.gone, { v: {} }, 'videos: no removals');
  // The later spot wins; a tie goes to remote; an empty title is filled from the other copy
  M = both('videos', { items: { x: v('x', 30, { t: 300, title: '' , author: 'Me' }) } }, { items: { x: v('x', 20, { t: 200, title: 'Real title', author: '' }) } });
  eq([M.items.x.t, M.items.x.title, M.items.x.author], [300, 'Real title', 'Me'], 'videos: newer spot wins, title kept from the other copy');
  M = both('videos', { items: { x: v('x', 20, { t: 1 }) } }, { items: { x: v('x', 20, { t: 2 }) } });
  eq(M.items.x.t, 2, 'videos: a tie goes to remote');
  // Removed after the last play: stays removed. Played after the removal: comes back.
  M = both('videos', { items: {}, gone: { v: { x: 50 } } }, { items: { x: v('x', 40), y: v('y', 60) } });
  ok(!M.items.x && M.items.y, 'videos: a removal newer than the record removes it; an older one does not');
  eq(M.gone.v, { x: 50 }, 'videos: removals union');
  M = both('videos', { items: { x: v('x', 40) }, gone: { v: { y: 10 } } }, { items: {}, gone: { v: { x: 30, y: 20 } } });
  ok(M.items.x, 'videos: played again after the other device removed it: kept');
  eq(M.gone.v, { x: 30, y: 20 }, 'videos: removal times union by max');
  // A plain {id: ms} map is read too
  M = both('videos', { items: { x: v('x', 40) } }, { items: {}, gone: { x: 45 } });
  ok(!M.items.x, 'videos: a removal map without the v wrapper is read');
  // Removals older than 180 days are dropped (and no longer remove anything)
  M = both('videos', { items: { x: v('x', NOW - 300 * DAY) }, gone: { v: { z: NOW - 181 * DAY } } }, { items: {}, gone: { v: { x: NOW - 200 * DAY, w: NOW - 179 * DAY } } }, NOW);
  eq(M.gone.v, { w: NOW - 179 * DAY }, 'videos: removals older than 180 days dropped');
  ok(M.items.x, 'videos: a dropped removal no longer removes');
  // Missing or broken copies
  M = both('videos', null, { items: { x: v('x', 1), bad: null, s: 'str' } });
  eq(Object.keys(M.items), ['x'], 'videos: a missing copy and stray entries are fine');
}

// ---------------------------------------------------------------- Podcast places
{
  let M = both('audio', { g1: { t: 5, updated: 10, url: 'u1', title: '' }, g2: { t: 1, updated: 1 } }, { g1: { t: 9, updated: 9, title: 'T', podcast: 'P', image: 'i', source: 's' }, g3: { t: 3, updated: 3 } });
  eq(Object.keys(M).sort(), ['g1', 'g2', 'g3'], 'audio: union');
  eq(M.g1, { t: 5, updated: 10, url: 'u1', title: 'T', podcast: 'P', image: 'i', source: 's' }, 'audio: newer place wins, missing fields filled from the other');
  M = both('audio', { g: { t: 1, updated: 5 } }, { g: { t: 2, updated: 5 } });
  eq(M.g.t, 2, 'audio: tie goes to remote');
}

// ---------------------------------------------------------------- Library
const sec = (id, name, kind) => ({ id, name: name || id, kind: kind || 'video' });
const src = (id, section, added, extra) => Object.assign({ id, type: 'youtube', name: id, section, added, seenUpTo: added }, extra || {});
function lib(sections, sources, extra) { const o = { sections, sources: {}, seeded: true, seedV: 4, born: 1, rev: 1 }; sources.forEach((s) => { o.sources[s.id] = s; }); return Object.assign(o, extra || {}); }
{
  // Old data, no times at all: channels and sections union, nothing lost; sections in remote's order then local's extras
  const A = lib([sec('med'), sec('ent'), sec('mine')], [src('c1', 'med', 10), src('c2', 'mine', 11)], { rev: 7, seedMisses: [{ input: 'x' }], born: 5 });
  const B = lib([sec('ent'), sec('med'), sec('sleep', 'Sleep', 'audio')], [src('c1', 'ent', 10, { seenUpTo: 99 }), src('c3', 'sleep', 12)], { rev: 3, seedV: 3, seeded: false, born: 2 });
  let M = both('library', A, B);
  eq(M.sections.map((s) => s.id), ['ent', 'med', 'sleep', 'mine'], 'library: old copies: sections union, remote order first');
  eq(Object.keys(M.sources).sort(), ['c1', 'c2', 'c3'], 'library: old copies: channels union');
  eq([M.sources.c1.section, M.sources.c1.seenUpTo], ['ent', 99], 'library: no times on either: remote wins, the larger seenUpTo kept');
  eq([M.rev, M.seedMisses, M.seeded, M.seedV, M.born], [7, [{ input: 'x' }], true, 4, 2], 'library: rev and seedMisses stay local; seeded either, seedV larger, born smaller');

  // Moved channel: the later move wins whole; seenUpTo larger, added smaller
  M = both('library', lib([sec('med'), sec('ent')], [src('c1', 'ent', 50, { seenUpTo: 5, hideShorts: false })], { at: { src: { c1: 300 }, sec: {} } }),
    lib([sec('med'), sec('ent')], [src('c1', 'med', 40, { seenUpTo: 9, hideShorts: true })], { at: { src: { c1: 200 }, sec: {} } }));
  eq([M.sources.c1.section, M.sources.c1.hideShorts, M.sources.c1.seenUpTo, M.sources.c1.added], ['ent', false, 9, 40], 'library: later move wins; seenUpTo larger, added smaller');
  // No time: "added" stands in. A channel added on one device only is kept.
  M = both('library', lib([sec('med')], [src('c1', 'med', 500)]), lib([sec('med')], [src('c1', 'med', 100, { name: 'old' }), src('c9', 'med', 1)], { at: { src: { c1: 400 }, sec: {} } }));
  eq([M.sources.c1.name, !!M.sources.c9, M.sources.c1.added], ['old', true, 100], 'library: no stamp counts as 0 (not its added time), so a stamped copy wins; a channel on one side only is kept');
  // Two unstamped copies of a moved channel (old code, or the seed list): remote's
  M = both('library', lib([sec('med'), sec('ent')], [src('c1', 'ent', 900)]), lib([sec('med'), sec('ent')], [src('c1', 'med', 10)]));
  eq(M.sources.c1.section, 'med', 'library: two unstamped copies of a moved channel end as remote\'s');
  M = both('library', lib([sec('med'), sec('ent')], [src('c1', 'med', 10)]), lib([sec('med'), sec('ent')], [src('c1', 'ent', 900)]));
  eq(M.sources.c1.section, 'ent', 'library: ...whichever side holds which');

  // A removed channel stays removed (removed after the other device last changed it)
  const before = lib([sec('med')], [src('c1', 'med', 100), src('c2', 'med', 100)]);
  const rem = clone(before); delete rem.sources.c1; rem.gone = { src: { c1: 200 }, sec: {} };
  M = both('library', before, rem);
  ok(!M.sources.c1 && M.sources.c2, 'library: a removed channel stays removed');
  M = both('library', rem, before);
  ok(!M.sources.c1, 'library: ...whichever side is local');
  eq(M.gone.src, { c1: 200 }, 'library: removal kept');
  // ...but re-added later on the other device, it comes back
  const readd = clone(before); readd.at = { src: { c1: 300 }, sec: {} };
  M = both('library', rem, readd);
  ok(M.sources.c1, 'library: removed, then re-added later elsewhere: back');
  M = both('library', readd, rem);
  ok(M.sources.c1, 'library: ...whichever side is local');
  // Removed and re-added on the same device: the removal entry went with the re-add
  const again = clone(rem); again.sources.c1 = src('c1', 'med', 100); again.at = { src: { c1: 250 }, sec: {} }; delete again.gone.src.c1;
  M = both('library', again, rem);
  ok(M.sources.c1, 'library: re-added after its removal: kept against a copy that still has the removal');
  // Any removal stamp beats an unstamped channel on the other side, however late it was added (the seed list re-adding
  // a show Mo removed elsewhere must not bring it back)
  const u1 = lib([sec('med')], [src('c1', 'med', 5000)]), u2 = lib([sec('med')], []); u2.gone = { src: { c1: 1 }, sec: {} };
  ok(!both('library', u1, u2).sources.c1 && !both('library', u2, u1).sources.c1, 'library: a removal stamp beats an unstamped channel');
  // Three devices: the winning time carries through later merges
  const r1 = lib([sec('med')], [src('c1', 'med', 500)], { at: { src: { c1: 500 }, sec: {} } }), r2 = lib([sec('med')], [src('c1', 'med', 100)], { at: { src: { c1: 300 }, sec: {} } });
  const r3 = lib([sec('med')], []); r3.gone = { src: { c1: 400 }, sec: {} };
  ok(both('library', both('library', r1, r2), r3).sources.c1, 'library: the winning time is kept through later merges');
  // A removal older than 180 days is dropped
  const oldRem = clone(rem); oldRem.gone.src.c1 = NOW - 181 * DAY;
  M = both('library', oldRem, before, NOW);
  ok(M.sources.c1 && !('c1' in M.gone.src), 'library: removals older than 180 days dropped');

  // Sections: renamed later wins; removed section goes and its channels move to the first section
  const s0 = lib([sec('med', 'Medicine'), sec('ent', 'Ents'), sec('sleep')], [src('c1', 'ent', 10), src('c2', 'sleep', 10)]);
  const s1 = clone(s0); s1.sections[1].name = 'Entertainment'; s1.at = { src: {}, sec: { ent: 100 } };
  const s2 = clone(s0); s2.sections = s2.sections.filter((s) => s.id !== 'sleep'); s2.sources.c2.section = 'med'; s2.at = { src: { c2: 110 }, sec: {}, order: 110 }; s2.gone = { src: {}, sec: { sleep: 110 } };
  M = both('library', s1, s2);
  eq(M.sections.map((s) => s.id + ':' + s.name), ['med:Medicine', 'ent:Entertainment'], 'library: rename kept, removed section gone');
  eq(M.sources.c2.section, 'med', 'library: its channel in the first section');
  // A channel in a removed section, moved there by old code only: still lands in the first section
  const s3 = clone(s0); s3.sources.c3 = src('c3', 'sleep', 120);
  M = both('library', s3, s2);
  ok(M.sources.c3 && M.sources.c3.section === 'med', 'library: a channel whose section went moves to the first one');
  // An old section (no time) removed on the other device goes; renamed after the removal it stays
  const s4 = clone(s0); s4.at = { src: {}, sec: { sleep: 200 } };
  M = both('library', s4, s2);
  ok(M.sections.some((s) => s.id === 'sleep'), 'library: a section changed after its removal elsewhere stays');

  // Order: the later move wins; tie or none goes to remote
  const o1 = clone(s0); o1.sections.reverse(); o1.at = { src: {}, sec: {}, order: 50 };
  const o2 = clone(s0); o2.at = { src: {}, sec: {}, order: 40 };
  eq(both('library', o1, o2).sections.map((s) => s.id), ['sleep', 'ent', 'med'], 'library: order from the later move');
  o2.at.order = 50;
  eq(both('library', o1, o2).sections.map((s) => s.id), ['med', 'ent', 'sleep'], 'library: order tie goes to remote');
  // The last section never disappears
  const l1 = lib([sec('only')], [src('c1', 'only', 10)]);
  const l2 = lib([sec('only')], [src('c1', 'only', 10)], { gone: { src: {}, sec: { only: 99 } } }); l2.sections = [];
  M = both('library', l1, l2);
  eq(M.sections.map((s) => s.id), ['only'], 'library: the last section never disappears');
  eq(M.sources.c1.section, 'only', 'library: its channel stays in it');
  const l3 = lib([sec('a'), sec('b')], []), l4 = lib([sec('c')], [], { gone: { src: {}, sec: { a: 9, b: 9 } } });
  const l5 = clone(l3); l5.gone = { src: {}, sec: { c: 9 } };
  M = both('library', l5, l4);
  eq(M.sections.map((s) => s.id), ['c'], 'library: every section removed somewhere: remote\'s first stays');
  // Missing pieces
  M = both('library', { sections: [sec('med')], sources: {} }, { sections: [sec('med')] });
  ok(Array.isArray(M.sections) && M.sources, 'library: copies without sources or times are fine');
}

// ---------------------------------------------------------------- Courses
const course = (id, extra) => Object.assign({ id, name: id, title: 'T ' + id, channel: 'Mehlman Medical', section: 'med', added: 10, touched: 0, ticks: {}, pins: {} }, extra || {});
const cstate = (list, extra) => { const o = { courses: {}, found: true, misses: [], saved: 1 }; list.forEach((c) => { o.courses[c.id] = c; }); return Object.assign(o, extra || {}); };
{
  // Old data, no times: ticks and pins union, nothing lost
  let A = cstate([course('P1', { ticks: { v1: 1, v2: 0, v4: 0 }, pins: { v1: 1 } }), course('P2', { ticks: { v9: 1 } })], { misses: [{ name: 'X' }], saved: 5 });
  let B = cstate([course('P1', { ticks: { v2: 1, v3: 1, v4: 0 }, pins: { v3: 1 } }), course('P3', { ticks: { v7: 1 } })], { saved: 9, dropped: { Pharm: 1 } });
  let M = both('courses', A, B);
  eq(Object.keys(M.courses).sort(), ['P1', 'P2', 'P3'], 'courses: old copies: courses union');
  eq(M.courses.P1.ticks, { v1: 1, v2: 1, v3: 1, v4: 0 }, 'courses: old copies: ticked on either side stays ticked');
  eq(M.courses.P1.pins, { v1: 1, v3: 1 }, 'courses: old copies: pins union');
  eq([M.misses, M.saved, M.dropped, M.found], [[{ name: 'X' }], 5, { Pharm: 1 }, true], 'courses: misses and saved stay local; dropped union; found either');

  // A tick on one device, a later untick on the other: unticked
  A = cstate([course('P1', { ticks: { v1: 1 }, onAt: { v1: 100 }, ticksAt: { v1: 100 }, touched: 100 })]);
  B = cstate([course('P1', { ticks: { v1: 0 }, offAt: { v1: 200 }, touched: 200 })]);
  M = both('courses', A, B);
  eq([M.courses.P1.ticks.v1, M.courses.P1.ticksAt], [0, {}], 'courses: tick then a later untick elsewhere: unticked (and off the tally)');
  eq(both('courses', B, A).courses.P1.ticks.v1, 0, 'courses: ...whichever side is local');
  // An untick, then a later tick: ticked
  A = cstate([course('P1', { ticks: { v1: 0 }, offAt: { v1: 100 } })]);
  B = cstate([course('P1', { ticks: { v1: 1 }, onAt: { v1: 200 }, ticksAt: { v1: 200 } })]);
  M = both('courses', A, B);
  eq([M.courses.P1.ticks.v1, M.courses.P1.ticksAt.v1, M.courses.P1.onAt.v1, M.courses.P1.offAt.v1], [1, 200, 200, 100], 'courses: untick then a later tick: ticked; times union');
  eq(both('courses', B, A).courses.P1.ticks.v1, 1, 'courses: ...whichever side is local');
  // Set place (tick up to) on one device against an older single untick on the other
  A = cstate([course('P1', { ticks: { v1: 1, v2: 1, v3: 1 }, onAt: { v1: 300, v2: 300, v3: 300 } })]);
  B = cstate([course('P1', { ticks: { v1: 1, v2: 0 }, offAt: { v2: 250 } })]);
  eq(both('courses', A, B).courses.P1.ticks, { v1: 1, v2: 1, v3: 1 }, 'courses: tick up to beats an older untick');
  eq(both('courses', B, A).courses.P1.ticks, { v1: 1, v2: 1, v3: 1 }, 'courses: ...whichever side is local');
  // ...and a newer untick beats an older tick up to
  B.courses.P1.offAt.v2 = 350;
  eq(both('courses', A, B).courses.P1.ticks, { v1: 1, v2: 0, v3: 1 }, 'courses: a newer untick beats tick up to');
  // An old tick (no time) against a new untick: the untick was made after this update, so it stays
  A = cstate([course('P1', { ticks: { v1: 1 } })]);
  B = cstate([course('P1', { ticks: { v1: 0 }, offAt: { v1: 50 } })]);
  eq(both('courses', A, B).courses.P1.ticks.v1, 0, 'courses: an untick made after the update beats an old tick');
  // Seed ticks carry no time: they lose to a stamped untick, and join as a union against an unstamped copy
  A = cstate([course('P1', { ticks: { v1: 1, v2: 1 } })]);
  B = cstate([course('P1', { ticks: { v1: 0 }, offAt: { v1: 50 } })]);
  eq(both('courses', A, B).courses.P1.ticks, { v1: 0, v2: 1 }, 'courses: an unstamped seed tick loses to a stamped untick on the other side');
  eq(both('courses', B, A).courses.P1.ticks, { v1: 0, v2: 1 }, 'courses: ...whichever side is local');
  eq(both('courses', A, cstate([course('P1', { ticks: { v1: 0, v3: 1 } })])).courses.P1.ticks, { v1: 1, v2: 1, v3: 1 }, 'courses: ...and joins as a union against an unstamped copy');
  // On one device: Mo unticked, then a seed note ticked it again with no time. The untick wins even when the other
  // copy doesn't have the course, so merging the result again changes nothing.
  M = both('courses', cstate([course('P1', { ticks: { v1: 1, v2: 1 }, onAt: { v1: 10 }, offAt: { v1: 20 } })]), cstate([]));
  eq(M.courses.P1.ticks, { v2: 1 }, 'courses: a seed tick after an untick on the same device loses, on one side only too');
  // Same time on and off: ticked (never lose a tick on a tie)
  A = cstate([course('P1', { ticks: { v1: 1 }, onAt: { v1: 70 } })]);
  B = cstate([course('P1', { ticks: { v1: 0 }, offAt: { v1: 70 } })]);
  eq(both('courses', A, B).courses.P1.ticks.v1, 1, 'courses: tick and untick at the same moment: ticked');

  // Pins by their times; no times: either
  A = cstate([course('P1', { pins: { v1: 1 }, pinAt: { v1: 100 } })]);
  B = cstate([course('P1', { pins: {}, pinAt: { v1: 200, v2: 5 } })]);
  eq(both('courses', A, B).courses.P1.pins, {}, 'courses: a later unpin wins');
  B.courses.P1.pinAt.v1 = 100; B.courses.P1.pins = {};
  eq(both('courses', A, B).courses.P1.pins, {}, 'courses: pin tie goes to remote');
  eq(both('courses', B, A).courses.P1.pins, { v1: 1 }, 'courses: ...remote pinned');

  // Name, section and seed from the side with the later m; added smaller, touched larger
  A = cstate([course('P1', { name: 'Paeds', section: 'ent', m: 300, added: 50, touched: 10, seed: { upTo: 5 }, seedName: 'Paeds' })]);
  B = cstate([course('P1', { name: 'Old', section: 'med', m: 200, added: 40, touched: 90 })]);
  M = both('courses', A, B);
  eq([M.courses.P1.name, M.courses.P1.section, M.courses.P1.seed, M.courses.P1.seedName, M.courses.P1.added, M.courses.P1.touched, M.courses.P1.m], ['Paeds', 'ent', undefined, 'Paeds', 40, 90, 300], 'courses: later m wins the names; added smaller, touched larger; a seed only one copy holds is dropped');
  B.courses.P1.seed = { upTo: 9 };
  eq(both('courses', A, B).courses.P1.seed, { upTo: 5 }, 'courses: a seed both copies hold stays (the later m\'s)');
  eq(both('courses', cstate([course('P1', { m: 900 })]), B).courses.P1.seed, undefined, 'courses: a copy that used up its seed wins over one that still holds it, whatever the m');
  eq(both('courses', cstate([course('P9', { seed: { all: true } })]), cstate([])).courses.P9.seed, { all: true }, 'courses: a course on one side only keeps its seed');
  delete B.courses.P1.seed;
  delete A.courses.P1.m; delete B.courses.P1.m;
  eq(both('courses', A, B).courses.P1.name, 'Old', 'courses: no m on either: remote');

  // A course removed on one device but ticked afterwards on the other: stays, with every tick
  const kept = { v1: 1, v2: 1 };
  A = cstate([], { removed: { P1: kept }, removedAt: { P1: 100 } });
  B = cstate([course('P1', { ticks: { v1: 1, v3: 1 }, onAt: { v3: 150 }, touched: 150 })]);
  M = both('courses', A, B);
  ok(M.courses.P1, 'courses: removed, then ticked later elsewhere: stays');
  eq(M.courses.P1.ticks, { v1: 1, v2: 1, v3: 1 }, 'courses: ...with the ticks it had where it was removed');
  ok(!M.removedAt || !M.removedAt.P1, 'courses: ...and its removal is forgotten');
  ok(!M.removed || !M.removed.P1, 'courses: ...and so are its kept ticks');
  M = both('courses', B, A);
  ok(M.courses.P1 && M.courses.P1.ticks.v2 === 1, 'courses: ...whichever side is local');
  // Pinned or moved after the removal elsewhere also counts as a later change
  ok(both('courses', A, cstate([course('P1', { pinAt: { v1: 150 }, pins: { v1: 1 } })])).courses.P1, 'courses: pinned after the removal elsewhere: stays');
  ok(both('courses', A, cstate([course('P1', { m: 150, section: 'ent' })])).courses.P1, 'courses: moved after the removal elsewhere: stays');
  ok(both('courses', A, cstate([course('P1', { offAt: { v1: 150 } })])).courses.P1, 'courses: unticked after the removal elsewhere: stays');
  // Removed after its last change elsewhere: goes, its ticks kept for a re-add
  B.courses.P1.touched = 50; B.courses.P1.onAt.v3 = 60;
  M = both('courses', A, B);
  ok(!M.courses.P1, 'courses: removed after its last change elsewhere: gone');
  eq(M.removed.P1, { v1: 1, v2: 1, v3: 1 }, 'courses: ...its ticks from both kept for a re-add');
  eq(M.removedAt, { P1: 100 }, 'courses: ...removal kept');
  // An unstamped course (old code) removed by the new code: goes
  M = both('courses', A, cstate([course('P1', { ticks: { v5: 1 } })]));
  ok(!M.courses.P1 && M.removed.P1.v5 === 1, 'courses: an old course removed after the update goes, ticks kept');
  // A removal made before this update (no removedAt) never removes a course with any change time
  M = both('courses', cstate([], { removed: { P1: { v2: 1 } } }), cstate([course('P1', { touched: 5, ticks: { v1: 1 } })]));
  ok(M.courses.P1 && M.courses.P1.ticks.v1 === 1 && M.courses.P1.ticks.v2 === 1, 'courses: an old removal never removes a course with a time; its ticks join the course');
  M = both('courses', cstate([], { removed: { P1: { v2: 1 } } }), cstate([course('P1', { touched: 0, ticks: {}, onAt: { v3: 7 } })]));
  ok(M.courses.P1 && !(M.removed && M.removed.P1), 'courses: ...a tick time counts as a time too');
  // ...but a course with no change time at all (the seed list's, on a new device) goes, its ticks kept for a re-add
  for (const [x, y] of [[cstate([], { removed: { P1: { v2: 1, v4: 0 } } }), cstate([course('P1', { ticks: { v1: 1, v4: 1 }, seed: { upTo: 3 } })])], [cstate([course('P1', { ticks: { v1: 1, v4: 1 } })]), cstate([], { removed: { P1: { v2: 1, v4: 0 } } })]]) {
    M = both('courses', x, y);
    ok(!M.courses.P1, 'courses: a course with no time goes when the other copy removed it, even with no removedAt');
    eq(M.removed.P1, { v1: 1, v2: 1, v4: 1 }, 'courses: ...its ticks from both kept for a re-add');
    ok(Sync.same(both('courses', M, M), M, 'courses'), 'courses: ...and merging that again changes nothing');
  }
  // ...and the same when it was removed with a time that has since expired
  M = both('courses', cstate([], { removed: { P1: { v2: 1 } }, removedAt: { P1: NOW - 200 * DAY } }), cstate([course('P1', { ticks: { v1: 1 } })]), NOW);
  ok(!M.courses.P1 && M.removed.P1.v1 === 1 && !(M.removedAt && M.removedAt.P1), 'courses: an untouched course removed over 180 days ago elsewhere: gone too');
  // A removal older than 180 days is dropped
  M = both('courses', cstate([], { removed: { P1: { v2: 1 } }, removedAt: { P1: NOW - 200 * DAY } }), cstate([course('P1', { touched: NOW - 300 * DAY })]), NOW);
  ok(M.courses.P1 && !(M.removedAt && M.removedAt.P1), 'courses: removals older than 180 days dropped');
  // Courses on one side only, and a missing copy
  M = both('courses', null, cstate([course('P5')]));
  ok(M.courses.P5, 'courses: a missing copy is fine');
}

// ---------------------------------------------------------------- Marks
{
  const mk = (id, at, extra) => Object.assign({ id, vid: 'abcdefghijk', title: 'T', t: 5, note: '', course: '', at }, extra || {});
  let M = both('marks', { items: [mk('m1', 10), mk('m2', 20)], saved: 3 }, { items: [mk('m3', 15), mk('m2', 20)], saved: 9 });
  eq([M.items.map((m) => m.id), M.saved], [['m1', 'm3', 'm2'], 3], 'marks: union, oldest first; saved stays local');
  M = both('marks', { items: [mk('m1', 10, { note: 'mine', m: 50 })] }, { items: [mk('m1', 10, { note: 'theirs', m: 40 })] });
  eq(M.items[0].note, 'mine', 'marks: the later note wins');
  M = both('marks', { items: [mk('m1', 10, { note: 'mine' })] }, { items: [mk('m1', 10, { note: 'theirs' })] });
  eq(M.items[0].note, 'theirs', 'marks: no times: remote');
  M = both('marks', { items: [mk('m1', 10, { note: 'x', m: 30 })] }, { items: [], gone: { m1: 40 } });
  ok(!M.items.length && M.gone.m1 === 40, 'marks: removed after the last change: gone');
  M = both('marks', { items: [mk('m1', 10, { note: 'x', m: 50 })] }, { items: [], gone: { m1: 40 } });
  ok(M.items.length === 1, 'marks: noted after the removal elsewhere: kept');
  M = both('marks', { items: [mk('m1', 10)] }, { items: [], gone: { m1: NOW - 181 * DAY, m9: NOW - DAY } }, NOW);
  ok(M.items.length === 1 && Object.keys(M.gone).join() === 'm9', 'marks: removals older than 180 days dropped');
}

// ---------------------------------------------------------------- Prefs
{
  // Speeds differing with no times: both devices end on remote's
  const A = { rate: 1.5, arate: 1, look: 'dark', rates: { 'v:UC1': 2, 'v:UC2': 1.25 }, apiKey: 'k' };
  const B = { rate: 2, rates: { 'v:UC1': 1.75, 'a:pod': 1.5 }, look: 'light' };
  let M = both('prefs', A, B);
  eq([M.rate, M.arate, M.rates, M.look, M.apiKey], [2, 1, { 'v:UC1': 1.75, 'v:UC2': 1.25, 'a:pod': 1.5 }, 'dark', 'k'], 'prefs: no times: remote\'s speeds; a field only one side has is kept; device fields stay local');
  const D2 = Sync.mergePrefs(B, M);
  eq([D2.rate, D2.rates, D2.look], [2, M.rates, 'light'], 'prefs: device 2 ends on the same speeds, keeping its own look');
  // The later change wins, per field and per channel
  M = both('prefs', { rate: 1.25, autoNext: false, rates: { 'v:UC1': 2 }, at: { rate: 300, 'rates.v:UC1': 100 } }, { rate: 2, autoNext: true, rates: { 'v:UC1': 1 }, at: { rate: 200, autoNext: 50, 'rates.v:UC1': 150 } });
  eq([M.rate, M.autoNext, M.rates['v:UC1'], M.at], [1.25, true, 1, { rate: 300, autoNext: 50, 'rates.v:UC1': 150 }], 'prefs: later change wins per field; times union');
  // Goal reset (field removed) later than the other device's goal: stays reset
  M = both('prefs', { at: { goal: 500 } }, { goal: { name: 'Step 2 CK', date: '2026-12-22' }, at: { goal: 400 } });
  ok(!('goal' in M), 'prefs: a goal reset later than the other\'s change stays reset');
  M = both('prefs', { goal: { name: 'X', date: '2026-12-01' } }, { arate: 1.5 });
  eq([M.goal, M.arate], [{ name: 'X', date: '2026-12-01' }, 1.5], 'prefs: fields one side has are kept');
}

// ---------------------------------------------------------------- Two devices, every store
// The phone and the laptop each changed things; the phone merges the laptop's copy, then the laptop pulls the result.
{
  const phone = {
    videos: { items: { aaaaaaaaaaa: { id: 'aaaaaaaaaaa', t: 300, updated: 500, title: 'Renal' }, ccccccccccc: { id: 'ccccccccccc', t: 5, updated: 100 } }, gone: { v: { ddddddddddd: 400 } } },
    audio: { g1: { t: 60, updated: 200, url: 'u' } },
    library: lib([sec('med'), sec('ent'), sec('rev')], [src('c1', 'rev', 10), src('c2', 'med', 10)], { at: { src: { c1: 300 }, sec: { rev: 290 }, order: 290 }, gone: { src: { c3: 350 }, sec: {} } }),
    courses: cstate([course('P1', { ticks: { v1: 1, v2: 1, v3: 0 }, onAt: { v2: 400 }, offAt: { v3: 410 } })]),
    marks: { items: [{ id: 'm1', vid: 'aaaaaaaaaaa', t: 5, note: 'phone note', at: 10, m: 420 }] },
    prefs: { rate: 1.5, rates: { 'v:c1': 2 }, at: { 'rates.v:c1': 300 }, look: 'dark' }
  };
  const laptop = {
    videos: { items: { aaaaaaaaaaa: { id: 'aaaaaaaaaaa', t: 100, updated: 300, title: 'Renal' }, bbbbbbbbbbb: { id: 'bbbbbbbbbbb', t: 9, updated: 250 }, ddddddddddd: { id: 'ddddddddddd', t: 1, updated: 300 } } },
    audio: { g2: { t: 1, updated: 1 } },
    library: lib([sec('med'), sec('ent')], [src('c2', 'ent', 10), src('c3', 'ent', 10), src('c4', 'med', 20)], { at: { src: { c2: 320 }, sec: {} } }),
    courses: cstate([course('P1', { ticks: { v1: 1, v3: 1, v4: 1 }, onAt: { v3: 300, v4: 300 }, offAt: { v2: 350 } }), course('P2', { ticks: { v1: 1 } })]),
    marks: { items: [{ id: 'm1', vid: 'aaaaaaaaaaa', t: 5, note: 'old', at: 10 }, { id: 'm2', vid: 'bbbbbbbbbbb', t: 9, note: '', at: 30 }] },
    prefs: { rate: 2, arate: 1.25, rates: { 'v:c1': 1, 'v:c4': 1.5 }, look: 'light' }
  };
  const p2 = {}, l2 = {};
  Object.keys(MERGE).forEach((k) => { p2[k] = MERGE[k](phone[k], laptop[k], 1e6); l2[k] = MERGE[k](laptop[k], p2[k], 1e6); ok(Sync.same(p2[k], l2[k], k), 'two devices: ' + k + ' the same on both'); });
  eq(Object.keys(p2.videos.items).sort(), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'], 'two devices: spots from both, the removed one stays removed');
  eq(p2.videos.items.aaaaaaaaaaa.t, 300, 'two devices: the newer spot');
  eq([p2.library.sections.map((s) => s.id), Object.keys(p2.library.sources).sort(), p2.library.sources.c1.section, p2.library.sources.c2.section], [['med', 'ent', 'rev'], ['c1', 'c2', 'c4'], 'rev', 'ent'], 'two devices: sections, channels and moves from both; the removed channel stays removed');
  eq([p2.courses.courses.P1.ticks, !!p2.courses.courses.P2], [{ v1: 1, v2: 1, v3: 0, v4: 1 }, true], 'two devices: every tick kept, later unticks and ticks win');
  eq([p2.marks.items.map((m) => m.id + ':' + m.note)], [['m1:phone note', 'm2:']], 'two devices: marks from both, the later note');
  eq([p2.prefs.rate, p2.prefs.arate, p2.prefs.rates, p2.prefs.look, l2.prefs.look], [2, 1.25, { 'v:c1': 2, 'v:c4': 1.5 }, 'dark', 'light'], 'two devices: speeds merged, each keeps its own look');
}

// ---------------------------------------------------------------- Random pairs
// A seeded generator: a shared starting copy, then random edits on each device the way the modules make them
// (old code first, with no times, then the new code), with clocks that often tie.
function rng(seed) { let a = seed >>> 0; const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; return { f, int: (lo, hi) => lo + Math.floor(f() * (hi - lo + 1)), pick: (arr) => arr[Math.floor(f() * arr.length)], chance: (p) => f() < p }; }
const SEED = +(process.env.SEED || 20261118), PAIRS = +(process.env.PAIRS || 2000);
// A device: its clock moves on in steps that often tie with the other device's; "old" until it updates
function device(r, t0, oldOps) { return { t: t0, ops: 0, oldOps, step() { this.t += r.pick([0, 0, 1, 2, 3 * DAY, 20 * DAY, 40 * DAY]); this.ops++; return !this.old(); }, old() { return this.ops <= this.oldOps; } }; }
function run(kind, gen, check) {
  for (let i = 0; i < PAIRS; i++) {
    const seed = SEED * 7919 + i * 104729 + kind.length;
    try {
      const r = rng(seed), p = gen(r);
      const a0 = JSON.stringify(p.A), b0 = JSON.stringify(p.B);
      const M = both(kind, p.A, p.B, NOW);
      assert.strictEqual(JSON.stringify(p.A), a0); assert.strictEqual(JSON.stringify(p.B), b0);
      check(p.A, p.B, M, r);
      const M2 = both(kind, p.B, p.A, NOW); // and with the sides the other way round
      check(p.B, p.A, M2, r);
    } catch (e) { console.error('sync random ' + kind + ' failed, seed ' + seed + ' (pair ' + i + ' of SEED=' + SEED + ')'); throw e; }
  }
  console.log('  random ' + kind + ': ' + PAIRS + ' pairs');
}
const live = (g, now) => { const o = {}; Object.keys(g || {}).forEach((k) => { if (g[k] >= now - 180 * DAY) o[k] = g[k]; }); return o; };
const T0 = NOW - 330 * DAY;

// Videos
run('videos', (r) => {
  const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee', 'fffffffffff'];
  const old = r.chance(0.4), base = { items: {}, gone: { v: {} } }, d0 = device(r, T0, old ? 99 : 0);
  ids.forEach((id) => { if (r.chance(0.6)) { d0.step(); base.items[id] = { id, t: r.int(0, 500), dur: 600, updated: d0.t, title: r.chance(0.3) ? '' : 'T' + id }; } });
  function edit(st, dv) {
    st = clone(st); const undo = [];
    for (let k = r.int(0, 6); k > 0; k--) {
      const stamped = dv.step(), id = r.pick(ids), op = r.int(0, 3);
      if (op <= 1) st.items[id] = Object.assign({}, st.items[id] || { id, dur: 600 }, { t: r.int(0, 600), updated: dv.t, title: r.chance(0.2) ? '' : 'N' + id });
      else if (op === 2 && st.items[id]) { undo.push(st.items[id]); delete st.items[id]; if (stamped) st.gone.v[id] = dv.t; }
      else if (op === 3 && undo.length) { const u = undo.pop(); if (!st.items[u.id]) { st.items[u.id] = u; delete st.gone.v[u.id]; } }
    }
    return st;
  }
  const t1 = d0.t;
  return { A: edit(base, device(r, t1, old ? r.int(0, 3) : 0)), B: edit(base, device(r, t1, old ? r.int(0, 3) : 0)) };
}, (A, B, M) => {
  const gone = live(Object.assign({}, A.gone.v), NOW); Object.keys(B.gone.v).forEach((k) => { gone[k] = Math.max(gone[k] || 0, B.gone.v[k]); }); const g = live(gone, NOW);
  new Set(Object.keys(A.items).concat(Object.keys(B.items))).forEach((id) => {
    const ua = A.items[id] ? A.items[id].updated : -1, ub = B.items[id] ? B.items[id].updated : -1, u = Math.max(ua, ub);
    // R1: kept unless removed later than its newest spot; the newest spot wins
    if (!(g[id] > u)) { ok(M.items[id] && M.items[id].updated === u, 'videos R1: ' + id + ' kept with its newest spot'); if (!(ua > ub)) eq(M.items[id].t, B.items[id].t, 'videos R2: tie goes to remote'); }
    else ok(!M.items[id], 'videos: removed later: gone');
  });
  Object.keys(M.items).forEach((id) => ok(A.items[id] || B.items[id], 'videos: nothing made up'));
});

// Podcast places
run('audio', (r) => {
  const g = ['g1', 'g2', 'g3', 'g4'], mk = () => { const o = {}; g.forEach((k) => { if (r.chance(0.6)) { o[k] = { t: r.int(0, 900), updated: r.int(1, 6) }; ['url', 'title', 'podcast', 'image', 'source'].forEach((f) => { if (r.chance(0.5)) o[k][f] = f + r.int(1, 3); }); } }); return o; };
  return { A: mk(), B: mk() };
}, (A, B, M) => {
  eq(Object.keys(M).sort(), [...new Set(Object.keys(A).concat(Object.keys(B)))].sort(), 'audio R1: every place kept');
  Object.keys(M).forEach((k) => {
    const a = A[k], b = B[k], w = !a ? b : !b ? a : a.updated > b.updated ? a : b;
    eq(M[k].t, w.t, 'audio: newest place wins (tie remote)');
    ['url', 'title', 'podcast', 'image', 'source'].forEach((f) => { if ((a && a[f]) || (b && b[f])) ok(M[k][f], 'audio: ' + f + ' filled'); });
  });
});

// Library
const SECS = ['med', 'ent', 'sleep', 's4', 's5'], SRCS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
function libEdit(r, st, dv) {
  st = clone(st);
  const at = () => (st.at = st.at || { src: {}, sec: {} }), gone = () => (st.gone = st.gone || { src: {}, sec: {} });
  const stampSrc = (id, s) => { if (s) { at().src[id] = dv.t; if (st.gone) delete st.gone.src[id]; } };
  const stampSec = (id, s) => { if (s) { at().sec[id] = dv.t; if (st.gone) delete st.gone.sec[id]; } };
  for (let k = r.int(0, 7); k > 0; k--) {
    const s = dv.step(), op = r.int(0, 10), ids = st.sections.map((x) => x.id), sid = r.pick(SECS), cid = r.pick(SRCS);
    st.rev = (st.rev || 0) + 1;
    if (op === 0 && ids.indexOf(sid) < 0) { st.sections.push({ id: sid, name: sid, kind: 'video' }); stampSec(sid, s); if (s) at().order = dv.t; }
    else if (op === 1 && ids.indexOf(sid) >= 0) { st.sections.find((x) => x.id === sid).name = 'N' + dv.t; stampSec(sid, s); }
    else if (op === 2 && ids.indexOf(sid) >= 0 && ids.length > 1) {
      st.sections = st.sections.filter((x) => x.id !== sid);
      Object.values(st.sources).forEach((x) => { if (x.section === sid) { x.section = st.sections[0].id; stampSrc(x.id, s); } });
      if (s) { gone().sec[sid] = dv.t; at().order = dv.t; }
    } else if (op === 3 && ids.length > 1) { const i = r.int(0, ids.length - 2); const t = st.sections[i]; st.sections[i] = st.sections[i + 1]; st.sections[i + 1] = t; if (s) at().order = dv.t; }
    else if (op === 4 && st.sources[cid]) { st.sources[cid].section = r.pick(ids); stampSrc(cid, s); }
    else if (op === 5 && st.sources[cid]) { st.sources[cid].hideShorts = r.chance(0.5); stampSrc(cid, s); }
    else if (op === 6 && st.sources[cid]) { delete st.sources[cid]; if (s) gone().src[cid] = dv.t; }
    else if (op === 7) { const prior = st.sources[cid]; st.sources[cid] = Object.assign(prior || {}, { id: cid, type: 'youtube', name: cid, section: prior ? prior.section : r.pick(ids), added: (prior && prior.added) || dv.t, seenUpTo: prior ? prior.seenUpTo : dv.t }); stampSrc(cid, s); }
    else if (op === 8 && st.sources[cid]) st.sources[cid].seenUpTo = dv.t + r.int(0, 5);
    else if (op === 9) st.seedMisses = r.chance(0.5) ? [{ input: 'x' + dv.t }] : [];
    // the seed list adding one of its shows: no time, and it leaves a removal record alone
    else if (op === 10 && !st.sources[cid] && !(st.gone && st.gone.src && st.gone.src[cid])) st.sources[cid] = { id: cid, type: 'podcast', name: cid, section: r.pick(ids), added: dv.t, seenUpTo: dv.t };
  }
  return st;
}
run('library', (r) => {
  const old = r.chance(0.4), d0 = device(r, T0, old ? 99 : 0);
  let base = { sections: [{ id: 'med', name: 'Medicine', kind: 'video' }, { id: 'ent', name: 'Entertainment', kind: 'video' }, { id: 'sleep', name: 'Sleep', kind: 'audio' }], sources: {}, seeded: r.chance(0.8), seedV: r.int(1, 4), born: T0 - r.int(0, 2), rev: 1 };
  base = libEdit(r, base, d0); base = libEdit(r, base, d0);
  const t1 = d0.t, sideOld = () => old ? r.int(0, 4) : 0;
  const A = libEdit(r, base, device(r, t1, sideOld())), B = libEdit(r, base, device(r, t1, sideOld()));
  if (r.chance(0.2)) A.seeded = !A.seeded;
  return { A, B };
}, (A, B, M) => {
  const g = (x, k) => (x.gone && x.gone[k]) || {}, a = (x, k) => (x.at && x.at[k]) || {};
  const gSrc = live(Object.assign({}, g(A, 'src')), NOW), gSec = {};
  Object.entries(g(B, 'src')).forEach(([k, v]) => { if (v >= NOW - 180 * DAY) gSrc[k] = Math.max(gSrc[k] || 0, v); });
  [g(A, 'sec'), g(B, 'sec')].forEach((m) => Object.entries(m).forEach(([k, v]) => { if (v >= NOW - 180 * DAY) gSec[k] = Math.max(gSec[k] || 0, v); }));
  // R1, channels: every one on either side stays unless a removal time exists that is larger than its at.src (0 if none)
  new Set(Object.keys(A.sources).concat(Object.keys(B.sources))).forEach((id) => {
    const st = (x) => (x.sources[id] ? a(x, 'src')[id] || 0 : -1), t = Math.max(st(A), st(B));
    if (gSrc[id] > t) { ok(!M.sources[id], 'library: removed later: gone'); return; }
    ok(M.sources[id], 'library R1: channel ' + id + ' kept');
    const seen = Math.max(A.sources[id] ? A.sources[id].seenUpTo : 0, B.sources[id] ? B.sources[id].seenUpTo : 0);
    eq(M.sources[id].seenUpTo, seen, 'library: seenUpTo the larger');
    ok(M.sections.some((s) => s.id === M.sources[id].section), 'library: every channel is in a section that exists');
  });
  // R1, sections
  new Set(A.sections.concat(B.sections).map((s) => s.id)).forEach((id) => {
    const st = (x) => (x.sections.some((s) => s.id === id) ? a(x, 'sec')[id] || 0 : -1), t = Math.max(st(A), st(B));
    if (!(gSec[id] > t)) ok(M.sections.some((s) => s.id === id), 'library R1: section ' + id + ' kept');
  });
  ok(M.sections.length >= 1, 'library: never no sections');
  eq(new Set(M.sections.map((s) => s.id)).size, M.sections.length, 'library: each section once');
  eq([M.rev, M.seedMisses], [A.rev, A.seedMisses], 'library: device fields stay local');
  eq(M.seeded, !!(A.seeded || B.seeded), 'library: seeded on either');
});

// Courses
const VIDS = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'], PIDS = ['P1', 'P2', 'P3', 'P4'];
function courseEdit(r, st, dv) {
  st = clone(st);
  const tickStamp = (c, v, on) => { const k = on ? 'onAt' : 'offAt', o = (c[on ? 'offAt' : 'onAt'] || {})[v] || 0; c[k] = c[k] || {}; c[k][v] = Math.max(dv.t, on ? o : o + 1); };
  for (let k = r.int(0, 8); k > 0; k--) {
    const s = dv.step(), op = r.int(0, 10), pid = r.pick(PIDS), c = st.courses[pid], v = r.pick(VIDS);
    if (op <= 1 && c) { const on = r.chance(0.6); c.ticks[v] = on ? 1 : 0; c.touched = dv.t; c.ticksAt = c.ticksAt || {}; if (on) c.ticksAt[v] = dv.t; else delete c.ticksAt[v]; if (s) tickStamp(c, v, on); }
    else if (op === 2 && c) {
      const before = Object.assign({}, c.ticks), upto = r.int(0, VIDS.length - 1);
      for (let j = 0; j <= upto; j++) { if (s && c.ticks[VIDS[j]] !== 1) tickStamp(c, VIDS[j], true); c.ticks[VIDS[j]] = 1; }
      c.touched = dv.t;
      if (r.chance(0.3)) { if (s) Object.keys(Object.assign({}, c.ticks, before)).forEach((x) => { const was = c.ticks[x] === 1, will = before[x] === 1; if (was !== will) tickStamp(c, x, will); }); c.ticks = before; }
    } else if (op === 3 && c) { const on = r.chance(0.5); if (on) c.pins[v] = 1; else delete c.pins[v]; if (s) { c.pinAt = c.pinAt || {}; c.pinAt[v] = dv.t; } }
    else if (op === 4 && c) { c.section = r.pick(['med', 'ent']); c.name = 'N' + dv.t; if (s) c.m = dv.t; }
    else if (op === 5 && c) { st.removed = st.removed || {}; st.removed[pid] = c.ticks; delete st.courses[pid]; if (s) { st.removedAt = st.removedAt || {}; st.removedAt[pid] = dv.t; } }
    else if (op === 6 && !c) {
      const prior = st.removed && st.removed[pid];
      st.courses[pid] = { id: pid, name: pid, title: 'T', channel: 'M', section: 'med', added: dv.t, touched: 0, ticks: prior || {}, pins: {} };
      if (s) st.courses[pid].m = dv.t;
      if (prior) delete st.removed[pid]; if (st.removedAt) delete st.removedAt[pid];
    } else if (op === 7 && c) c.touched = dv.t;
    // the seed list: adds a course with its note (no m), and applies the note later (ticks and pin with no times)
    else if (op === 9 && !c) {
      const prior = st.removed && st.removed[pid];
      st.courses[pid] = { id: pid, name: pid, title: 'T', channel: 'M', section: 'med', added: dv.t, touched: 0, ticks: prior || {}, pins: {}, seed: { upTo: r.int(0, 7) }, seedName: pid };
      if (prior) delete st.removed[pid]; if (st.removedAt) delete st.removedAt[pid];
    } else if (op === 10 && c && c.seed) { for (let j = 0; j <= c.seed.upTo; j++) c.ticks[VIDS[j]] = 1; if (r.chance(0.5)) c.pins[v] = 1; delete c.seed; if (!s) c.touched = dv.t; }
    else if (op === 8) { st.saved = dv.t; st.misses = r.chance(0.5) ? [{ name: 'X' }] : []; if (r.chance(0.3)) { st.dropped = st.dropped || {}; st.dropped[r.pick(['Pharm', 'IM'])] = 1; } }
  }
  return st;
}
run('courses', (r) => {
  const old = r.chance(0.4), d0 = device(r, T0, old ? 99 : 0);
  let base = { courses: {}, found: r.chance(0.7), misses: [], saved: T0 };
  PIDS.forEach((pid) => { if (r.chance(0.6)) { const c = base.courses[pid] = { id: pid, name: pid, title: 'T', channel: 'M', section: 'med', added: T0, touched: 0, ticks: {}, pins: {} }; if (r.chance(0.4)) c.seed = { upTo: r.int(0, 7) }; VIDS.forEach((v) => { if (r.chance(0.3)) c.ticks[v] = r.chance(0.8) ? 1 : 0; }); } });
  base = courseEdit(r, base, d0);
  const t1 = d0.t, sideOld = () => old ? r.int(0, 4) : 0;
  return { A: courseEdit(r, base, device(r, t1, sideOld())), B: courseEdit(r, base, device(r, t1, sideOld())) };
}, (A, B, M) => {
  const rem = {};
  [A.removedAt || {}, B.removedAt || {}].forEach((m) => Object.entries(m).forEach(([k, v]) => { if (v >= NOW - 180 * DAY) rem[k] = Math.max(rem[k] || 0, v); }));
  const newest = (c) => Math.max(c.touched || 0, c.m || 0, ...['onAt', 'offAt', 'pinAt'].flatMap((k) => Object.values(c[k] || {})));
  new Set(Object.keys(A.courses).concat(Object.keys(B.courses))).forEach((pid) => {
    const ca = A.courses[pid], cb = B.courses[pid], t = Math.max(ca ? newest(ca) : 0, cb ? newest(cb) : 0);
    const ticked = (v) => [ca, cb].some((c) => c && c.ticks[v] === 1);
    // ...or with no change time at all, held as removed by either copy (even with no removedAt)
    if (rem[pid] > t || (!t && [A, B].some((s) => s.removed && s.removed[pid]))) {
      // Removed later than its last change: gone, and every tick it had on either side is kept for a re-add
      ok(!M.courses[pid], 'courses: removed later: gone');
      VIDS.forEach((v) => { if (ticked(v)) ok(M.removed[pid][v] === 1, 'courses R1: a removed course keeps its ticks'); });
      return;
    }
    const c = M.courses[pid]; ok(c, 'courses R1: course ' + pid + ' kept');
    const max = (k, v) => Math.max((ca && ca[k] && ca[k][v]) || 0, (cb && cb[k] && cb[k][v]) || 0);
    const keptTicks = (v) => [A, B].some((s) => s.removed && s.removed[pid] && s.removed[pid][v] === 1);
    VIDS.forEach((v) => {
      const on = max('onAt', v), off = max('offAt', v);
      // R1: every video ticked on either side (or kept from a removal) with no newer untick is ticked
      if ((ticked(v) || keptTicks(v) || on) && !(off > on)) ok(c.ticks[v] === 1, 'courses R1: ' + pid + '/' + v + ' ticked');
      // ...and an untick newer than every tick stays unticked
      if (off > on) ok(c.ticks[v] !== 1, 'courses: ' + pid + '/' + v + ' a newer untick stays');
      if (c.ticks[v] !== 1) ok(!(c.ticksAt && c.ticksAt[v]), 'courses: no tally for an unticked video');
      // Pins: the later pin or unpin; with no times, pinned on either
      const pa = ca && ca.pinAt ? ca.pinAt[v] || 0 : 0, pb = cb && cb.pinAt ? cb.pinAt[v] || 0 : 0;
      if (!pa && !pb) eq(!!c.pins[v], !!((ca && ca.pins[v]) || (cb && cb.pins[v])), 'courses: pins union with no times');
      else eq(!!c.pins[v], pa > pb ? !!(ca && ca.pins[v]) : !!(cb && cb.pins[v]), 'courses: later pin wins');
    });
    ok(!(M.removedAt && M.removedAt[pid]) && !(M.removed && M.removed[pid]), 'courses: a course that stays has no removal record');
    // The seed note stays only while every copy that has the course still holds it
    eq(c.seed, ca && cb ? (ca.seed && cb.seed ? (((ca.m || 0) > (cb.m || 0)) ? ca : cb).seed : undefined) : (ca || cb).seed, 'courses: seed kept only when both hold it');
  });
  eq([M.misses, M.saved], [A.misses, A.saved], 'courses: device fields stay local');
});

// Marks
run('marks', (r) => {
  const old = r.chance(0.4), d0 = device(r, T0, old ? 99 : 0), base = { items: [], saved: T0 };
  for (let k = r.int(0, 5); k > 0; k--) { d0.step(); base.items.push({ id: 'm' + k, vid: 'abcdefghijk', t: k, note: '', at: d0.t }); }
  function edit(st, dv) {
    st = clone(st); const undo = [];
    for (let k = r.int(0, 6); k > 0; k--) {
      const s = dv.step(), op = r.int(0, 4), m = r.pick(st.items.concat([null]));
      if (op === 0) st.items.push({ id: 'n' + r.int(1, 4), vid: 'abcdefghijk', t: 1, note: '', at: dv.t });
      else if (op === 1 && m) { m.note = 'n' + dv.t; if (s) m.m = dv.t; }
      else if (op === 2 && m) { m.card = { answer: 'a' + dv.t }; if (s) m.m = dv.t; }
      else if (op === 3 && m) { st.items = st.items.filter((x) => x !== m); undo.push(m); if (s) { st.gone = st.gone || {}; st.gone[m.id] = dv.t; } }
      else if (op === 4 && undo.length) { const u = undo.pop(); if (!st.items.some((x) => x.id === u.id)) { st.items.push(u); if (st.gone) delete st.gone[u.id]; } }
      st.saved = dv.t;
    }
    // a device never holds two marks with one id
    const seen = {}; st.items = st.items.filter((x) => !seen[x.id] && (seen[x.id] = 1));
    return st;
  }
  const t1 = d0.t;
  return { A: edit(base, device(r, t1, old ? r.int(0, 3) : 0)), B: edit(base, device(r, t1, old ? r.int(0, 3) : 0)) };
}, (A, B, M) => {
  const gone = {}; [A.gone || {}, B.gone || {}].forEach((m) => Object.entries(m).forEach(([k, v]) => { if (v >= NOW - 180 * DAY) gone[k] = Math.max(gone[k] || 0, v); }));
  const st = (x) => (x ? (x.m != null ? x.m : x.at) : -1);
  new Set(A.items.concat(B.items).map((m) => m.id)).forEach((id) => {
    const a = A.items.find((m) => m.id === id), b = B.items.find((m) => m.id === id), t = Math.max(st(a), st(b)), got = M.items.find((m) => m.id === id);
    if (gone[id] > t) { ok(!got, 'marks: removed later: gone'); return; }
    ok(got, 'marks R1: mark ' + id + ' kept');
    eq(got, st(a) > st(b) ? a : b, 'marks: the later change wins (tie remote)');
  });
  eq(M.saved, A.saved, 'marks: saved stays local');
});

// Prefs
run('prefs', (r) => {
  const keys = ['rate', 'arate', 'autoNext', 'goal'], rk = ['v:UC1', 'v:UC2', 'a:pod'], val = (k) => (k === 'autoNext' ? r.chance(0.5) : k === 'goal' ? { name: 'G', date: '2026-12-' + r.int(10, 28) } : r.pick([1, 1.25, 1.5, 2]));
  const d0 = device(r, T0, r.chance(0.4) ? 99 : 0), base = { look: 'auto' };
  keys.forEach((k) => { if (r.chance(0.5)) base[k] = val(k); });
  function edit(st, dv) {
    st = clone(st);
    for (let k = r.int(0, 6); k > 0; k--) {
      const s = dv.step(), op = r.int(0, 3);
      if (op <= 1) { const f = r.pick(keys); st[f] = val(f); if (s) { st.at = st.at || {}; st.at[f] = dv.t; } }
      else if (op === 2) { const f = r.pick(rk); st.rates = st.rates || {}; st.rates[f] = val('rate'); if (s) { st.at = st.at || {}; st.at['rates.' + f] = dv.t; } }
      else { delete st.goal; if (s) { st.at = st.at || {}; st.at.goal = dv.t; } }
      st.look = r.pick(['light', 'dark']); if (r.chance(0.3)) st.apiKey = 'k' + dv.t;
    }
    return st;
  }
  const t1 = d0.t;
  return { A: edit(base, device(r, t1, r.int(0, 3))), B: edit(base, device(r, t1, r.int(0, 3))) };
}, (A, B, M) => {
  const at = (x, k) => (x.at && x.at[k]) || 0;
  ['rate', 'arate', 'autoNext', 'goal'].forEach((f) => {
    const ta = at(A, f), tb = at(B, f);
    // The later change wins; with no times (or a tie) remote's value, else local's
    const w = ta > tb ? A : tb > ta ? B : f in B ? B : A;
    eq(M[f], w[f], 'prefs: ' + f + ' from the later change');
    if (f in A && f in B && !ta && !tb) eq(M[f], B[f], 'prefs: no times: remote');
  });
  new Set(Object.keys(A.rates || {}).concat(Object.keys(B.rates || {}))).forEach((k) => {
    const ta = at(A, 'rates.' + k), tb = at(B, 'rates.' + k), ra = (A.rates || {})[k], rb = (B.rates || {})[k];
    eq(M.rates[k], ta > tb ? (ra !== undefined ? ra : rb) : rb !== undefined ? rb : ra, 'prefs R1: channel speed ' + k);
  });
  eq([M.look, M.apiKey], [A.look, A.apiKey], 'prefs: device fields stay local');
});

// ---------------------------------------------------------------- Times written by the real modules
(async () => {
  let clock = Date.parse('2026-11-18T09:00:00Z');
  const fakeIo = (store, extra) => Object.assign({ load: (k) => (k in store ? store[k] : null), save: (k, v) => { store[k] = v; }, now: () => clock }, extra || {});
  const tick = (ms) => { clock += ms || 1000; return clock; };

  // Library
  {
    const store = {}, pod = '<rss><channel><title>Pod</title><item><title>E1</title><guid>e1</guid><enclosure url="https://a.example/1.mp3"/><pubDate>Sun, 04 Oct 2026 11:00:00 GMT</pubDate></item></channel></rss>';
    const io = fakeIo(store, { fetchText: (url) => (/feed/.test(url) ? Promise.resolve(pod) : Promise.reject(new Error('offline'))) });
    let lib = Library.create(io);
    const raw = () => JSON.parse(store[Library.KEY]);
    let t = tick(); lib.addSection('Revision', 'video');
    eq([raw().at.sec.revision, raw().at.order], [t, t], 'library stamps: addSection stamps the section and the order');
    t = tick(); lib.renameSection('revision', 'Rev');
    eq(raw().at.sec.revision, t, 'library stamps: renameSection');
    t = tick(); lib.setKind('revision', 'audio');
    eq(raw().at.sec.revision, t, 'library stamps: setKind');
    t = tick(); lib.moveSection('revision', -1);
    eq(raw().at.order, t, 'library stamps: moveSection stamps the order');
    t = tick(); const s = await lib.add('https://feeds.example/pod', 'med');
    eq(raw().at.src[s.id], t, 'library stamps: add stamps the channel');
    t = tick(); lib.setSection(s.id, 'revision');
    eq(raw().at.src[s.id], t, 'library stamps: setSection');
    t = tick(); lib.setHideShorts(s.id, false);
    eq(raw().at.src[s.id], t, 'library stamps: setHideShorts');
    t = tick(); lib.markSeen(s.id); await lib.refresh(s.id, true); lib.markSeen(s.id);
    eq(raw().at.src[s.id], t - 1000, 'library stamps: seenUpTo changes are not stamped');
    t = tick(); lib.removeSection('revision');
    eq([raw().gone.sec.revision, raw().at.order, raw().at.src[s.id], raw().sources[s.id].section], [t, t, t, 'med'], 'library stamps: removeSection: the section\'s removal, the order, and the channel it moved');
    t = tick(); lib.remove(s.id);
    eq(raw().gone.src[s.id], t, 'library stamps: remove records the removal');
    t = tick(); await lib.add('https://feeds.example/pod', 'ent');
    ok(!(s.id in raw().gone.src) && raw().at.src[s.id] === t, 'library stamps: adding it again clears the removal');
    t = tick(); lib.addSection('Revision');
    ok(!('revision' in raw().gone.sec) && raw().at.sec.revision === t, 'library stamps: a section added again clears its removal');
    // The merge with an untouched copy keeps everything this device did
    const M = Sync.mergeLibrary(raw(), raw(), NOW);
    // The seed list's channels get no time
    {
      const ss = {}, sl = Library.create(fakeIo(ss, { fetchText: (url) => (/megaphone|libsyn/.test(url) ? Promise.resolve(pod) : Promise.reject(new Error('offline'))) }));
      const out = await sl.seed(), sr = JSON.parse(ss[Library.KEY]);
      eq(out.filter((x) => x.ok).length, 3, 'library seed: the three feeds were added');
      ok(sl.sources().length === 3 && sl.sources().every((x) => !(sr.at && sr.at.src && x.id in sr.at.src)), 'library seed: a channel the seed list adds has no at.src time');
    }
    ok(Sync.same(M, raw(), 'library'), 'library stamps: merging the saved list with itself changes nothing');
    // A list saved by the old code (no times) loads and works
    const oldStore = { [Library.KEY]: JSON.stringify({ sections: [{ id: 'med', name: 'Medicine', kind: 'video' }, { id: 'ent', name: 'E', kind: 'video' }], sources: { c1: { id: 'c1', type: 'youtube', name: 'C1', section: 'ent', added: 5, seenUpTo: 5 } }, seeded: true, seedV: 4, born: 1, rev: 3 }) };
    lib = Library.create(fakeIo(oldStore, { fetchText: () => Promise.reject(new Error('offline')) }));
    eq(lib.sources().length, 1, 'library: an old saved list loads');
    lib.removeSection('ent');
    const o = JSON.parse(oldStore[Library.KEY]);
    eq([o.sources.c1.section, o.gone.sec.ent, o.at.src.c1], ['med', clock, clock], 'library: and works, starting its times');
  }

  // Courses
  {
    const vr = (id, title) => ({ playlistVideoRenderer: { videoId: id, title: { runs: [{ text: title }] }, lengthSeconds: '600', isPlayable: true } });
    const vids = Array.from({ length: 6 }, (_, i) => 'vid' + String(i).padStart(8, '0'));
    const html = 'var ytInitialData = ' + JSON.stringify({ metadata: { playlistMetadataRenderer: { title: 'HY USMLE Qs - Pediatrics' } }, contents: { list: { contents: vids.map((v, i) => vr(v, 'HY USMLE Q #' + (100 + i))) } } }) + ';';
    const store = {}, io = fakeIo(store, { fetchText: async () => html, apiKey: () => '', watched: () => false });
    let cs = Courses.create(io);
    const pid = 'PLpeds0000000000';
    let t = tick(); let c = await cs.add('https://www.youtube.com/playlist?list=' + pid, { name: 'Paeds' });
    const raw = () => JSON.parse(store[Courses.KEY]), rc = () => raw().courses[pid];
    eq(rc().m, t, 'courses stamps: a new course has its m');
    t = tick(); cs.tick(pid, vids[0], true);
    eq([rc().onAt[vids[0]], rc().ticksAt[vids[0]]], [t, t], 'courses stamps: tick stamps onAt (ticksAt as before)');
    t = tick(); cs.tick(pid, vids[0], false);
    ok(rc().offAt[vids[0]] === t && !(vids[0] in rc().ticksAt), 'courses stamps: untick stamps offAt');
    cs.tick(pid, vids[0], true); cs.tick(pid, vids[0], false);
    ok(rc().offAt[vids[0]] > rc().onAt[vids[0]], 'courses stamps: an untick in the same millisecond still counts as later');
    t = tick(); cs.tick(pid, vids[1], true);
    const t1 = t; t = tick(); const before = cs.tickUpTo(pid, 3);
    eq([vids.slice(0, 4).map((v) => rc().onAt[v]), rc().ticksAt[vids[2]]], [[t, t1, t, t], undefined], 'courses stamps: tickUpTo stamps only the ones it turned on');
    t = tick(); cs.restore(pid, before);
    eq([rc().offAt[vids[0]], rc().offAt[vids[2]], rc().offAt[vids[3]], rc().offAt[vids[1]]], [t, t, t, undefined], 'courses stamps: restore stamps each one it turned off');
    t = tick(); cs.pin(pid, vids[4], true);
    eq(rc().pinAt[vids[4]], t, 'courses stamps: pin'); t = tick(); cs.pin(pid, vids[4], false); eq(rc().pinAt[vids[4]], t, 'courses stamps: unpin');
    t = tick(); cs.move(pid, 'ent');
    eq(rc().m, t, 'courses stamps: move');
    ok(Sync.same(Sync.mergeCourses(raw(), raw(), NOW), raw(), 'courses'), 'courses stamps: merging the saved copy with itself changes nothing');
    // fixMiss: Mo pasted the link, so m; the seed note it applies ticks with no times (70% of 6: the first 4)
    const onBefore = JSON.stringify(rc().onAt), pinBefore = JSON.stringify(rc().pinAt);
    t = tick(); cs.fixMiss('Paeds', cs.get(pid));
    eq([rc().m, vids.slice(0, 4).map((v) => rc().ticks[v]), JSON.stringify(rc().onAt), JSON.stringify(rc().pinAt), rc().seed], [t, [1, 1, 1, 1], onBefore, pinBefore, undefined], 'courses stamps: fixMiss stamps m; its seed ticks carry no times');
    // ...so the unticks Mo made before (restore above) still win when the copy is merged, even with itself
    eq(vids.slice(0, 4).map((v) => Sync.mergeCourses(raw(), raw(), NOW).courses[pid].ticks[v]), [undefined, 1, undefined, undefined], 'courses: unstamped seed ticks lose to the earlier stamped unticks');
    t = tick(); cs.remove(pid);
    eq(raw().removedAt[pid], t, 'courses stamps: remove records the removal');
    t = tick(); await cs.add('https://www.youtube.com/playlist?list=' + pid, { name: 'Paeds' });
    ok(!(pid in raw().removedAt) && rc().m === t, 'courses stamps: adding it again clears the removal and stamps m');
    // The seed list: its courses get no m, and applying its notes writes no onAt, pinAt or m
    {
      const lockup = (id, title) => ({ lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', metadata: { lockupMetadataViewModel: { title: { content: title } } }, contentImage: { badge: { text: '6 videos' } } } });
      const chan = 'var ytInitialData = ' + JSON.stringify({ tabs: [lockup('PLpeds0000000000', 'HY USMLE Qs - Pediatrics'), lockup('PLobgyn000000000', 'HY USMLE Qs - OBGYN')] }) + ';';
      const page = (name, first) => 'var ytInitialData = ' + JSON.stringify({ metadata: { playlistMetadataRenderer: { title: 'HY USMLE Qs - ' + name } }, contents: { list: { contents: vids.map((v, i) => vr(name.slice(0, 3) + v.slice(3), 'HY USMLE Q #' + (first + i))) } } }) + ';';
      const ss = {}, sc = Courses.create(fakeIo(ss, { apiKey: () => '', watched: () => false, fetchText: async (url) => (/playlists/.test(url) ? chan : /PLobgyn/.test(url) ? page('OBGYN', 1602) : page('Pediatrics', 100)) }));
      await sc.seed(); tick(); await sc.loadAll(true);
      const rs = JSON.parse(ss[Courses.KEY]).courses, ob = rs.PLobgyn000000000, pe = rs.PLpeds0000000000;
      ok(ob && pe && !ob.seed && !pe.seed, 'courses seed: both seed courses added and their notes applied');
      eq([Object.keys(ob.ticks).length, Object.keys(ob.pins).length, Object.keys(pe.ticks).length], [6, 1, 4], 'courses seed: OBGYN all ticked with its pin, Paeds 70%');
      ok([ob, pe].every((x) => x.m === undefined && !x.onAt && !x.pinAt && !x.offAt), 'courses seed: no m, onAt, pinAt from the seed list');
    }
    // Old data (no stamps) loads and works
    const oldStore = { [Courses.KEY]: JSON.stringify({ courses: { [pid]: { id: pid, name: 'Paeds', title: 'x', channel: 'M', section: 'med', added: 1, touched: 2, ticks: { [vids[0]]: 1 }, pins: {} } }, removed: { PLx: { a: 1 } }, found: true, misses: [] }), [Courses.IKEY]: JSON.stringify({ [pid]: { fetched: clock, ok: true, items: vids.map((v, i) => ({ id: v, title: 'Q #' + i, dur: 600, n: i })) } }) };
    cs = Courses.create(fakeIo(oldStore, { fetchText: async () => html, apiKey: () => '', watched: () => false }));
    eq(cs.progress(pid).done, 1, 'courses: an old saved copy loads');
    cs.tickUpTo(pid, 2); cs.remove(pid);
    const o = JSON.parse(oldStore[Courses.KEY]);
    eq([o.removed[pid][vids[2]], o.removedAt[pid], o.removed.PLx], [1, clock, { a: 1 }], 'courses: and works, starting its times');
  }

  // Marks
  {
    const store = {}; const mk = Marks.create(fakeIo(store));
    let t = tick(); const m = mk.add({ vid: 'abcdefghijk', title: 'T', t: 5 });
    const raw = () => JSON.parse(store[Marks.KEY]);
    ok(raw().items[0].at === t && raw().items[0].m === undefined, 'marks stamps: a new mark has only its at');
    t = tick(); mk.setNote(m.id, 'note'); eq(raw().items[0].m, t, 'marks stamps: setNote');
    t = tick(); mk.setCard(m.id, { answer: 'a' }); eq(raw().items[0].m, t, 'marks stamps: setCard');
    t = tick(); const gone = mk.remove(m.id); eq(raw().gone[m.id], t, 'marks stamps: remove records the removal');
    mk.restore(gone); ok(!(m.id in raw().gone) && raw().items.length === 1, 'marks stamps: restore clears it');
    const oldStore = { [Marks.KEY]: JSON.stringify({ items: [{ id: 'x', vid: 'abcdefghijk', t: 1, at: 1 }], saved: 1 }) };
    const om = Marks.create(fakeIo(oldStore)); om.setNote('x', 'hi'); om.remove('x');
    eq([om.count, JSON.parse(oldStore[Marks.KEY]).gone.x], [0, clock], 'marks: an old saved copy loads and works');
  }

  console.log('sync: all ' + n + ' checks passed (seed ' + SEED + ')');
})().catch((e) => { console.error(e); process.exit(1); });
