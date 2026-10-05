// Gemini module: prompts, replies, errors, budget days, cache, clips, the Anki format. A fake Gemini, nothing leaves.
process.env.TZ = 'Europe/London';
const assert = require('assert');
const AI = require('../src/ai.js');
const Marks = require('../src/marks.js');

(async () => {
  // Times
  assert.strictEqual(AI.parseT('3:12'), 192); assert.strictEqual(AI.parseT('03:12'), 192); assert.strictEqual(AI.parseT('1:02:03'), 3723);
  assert.strictEqual(AI.parseT(45), 45); assert.strictEqual(AI.parseT('soon'), null); assert.strictEqual(AI.fmt(3723), '1:02:03');

  // Prompts per kind
  const sm = AI.summaryPrompt({ title: 'HY Arrows: Renal', med: true }), so = AI.summaryPrompt({ title: 'Fed cuts', med: false });
  assert.ok(/Step 2 CK/.test(sm) && !/Step 2/.test(so) && /JSON only/.test(so) && /"points"/.test(so), 'summary prompts');
  const nm = AI.notesPrompt({ title: 'HY USMLE Q #1115 - Pediatrics', med: true }), no = AI.notesPrompt({ title: 'Fed cuts', med: false });
  assert.ok(/tested/.test(nm) && /versus/.test(nm) && /every question/.test(nm) && /"cards"/.test(nm), 'Step 2 notes; HY question videos capture every question');
  assert.ok(!/every question/.test(AI.notesPrompt({ title: 'Acid-base made easy', med: true })), 'a lecture is not treated as a question video');
  assert.ok(/bullets/.test(no) && !/Step 2/.test(no), 'plain bullets outside Medicine');
  const cp = AI.cardPrompt({ title: 'X', note: 'Kawasaki: IVIG' });
  assert.ok(/Kawasaki: IVIG/.test(cp) && /ONE card/.test(cp) && /"vs"/.test(cp), 'card prompt uses the note as the focus');

  // Clip clamping
  assert.deepStrictEqual(AI.clip(252, 600), { start: 162, end: 282 });
  assert.deepStrictEqual(AI.clip(20, 600), { start: 0, end: 50 }, 'near the start');
  assert.deepStrictEqual(AI.clip(595, 600), { start: 505, end: 600 }, 'near the end');
  assert.deepStrictEqual(AI.clip(10, 25), { start: 0, end: 25 }, 'a very short video');
  const body = AI.requestBody({ vid: 'abcdefghijk', prompt: 'p', clip: { start: 162, end: 282 }, processing: 'STATIC' });
  assert.strictEqual(body.contents[0].parts[0].fileData.fileUri, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.deepStrictEqual(body.contents[0].parts[0].videoMetadata, { startOffset: '162s', endOffset: '282s' });
  assert.strictEqual(body.contents[0].parts[0].mediaProcessing, 'STATIC');
  assert.strictEqual(JSON.stringify(body).indexOf('AIza'), -1, 'the key never goes in the body');

  // Reply parsing: fenced, chatty and broken
  assert.deepStrictEqual(AI.parseJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(AI.parseJSON('Sure! {"a":2} hope that helps'), { a: 2 });
  assert.strictEqual(AI.parseJSON('{"a":'), null);
  const wrap = (t) => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: t }] } }] });
  assert.strictEqual(AI.replyText(wrap('{"x":1}')).text, '{"x":1}', 'thoughts are skipped');
  assert.ok(AI.replyText(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })).blocked);
  const s1 = AI.clean('summary', { gist: 'Renal', points: [{ t: '03:12', text: 'Loop diuretics' }, { t: 'x', text: 'no time' }, { text: '' }] });
  assert.deepStrictEqual(s1.points, [{ t: 192, text: 'Loop diuretics' }, { t: null, text: 'no time' }]);
  assert.strictEqual(AI.clean('summary', { gist: 'x', points: [] }), null, 'no points = ask again');
  assert.strictEqual(AI.clean('card', { questions: ['What is it?'] }), null, 'a card needs an answer');

  // Errors in plain words
  const E = (s, msg, extra) => AI.classify(s, JSON.stringify({ error: Object.assign({ code: s, message: msg }, extra || {}) })).kind;
  assert.strictEqual(E(400, 'API key not valid. Please pass a valid API key.', { status: 'INVALID_ARGUMENT' }), 'key');
  assert.strictEqual(E(429, 'Resource has been exhausted (e.g. check quota).', { status: 'RESOURCE_EXHAUSTED' }), 'busy');
  assert.strictEqual(E(429, 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0', { details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] }), 'daily');
  assert.strictEqual(E(400, 'Cannot fetch content from the provided URL. The YouTube video may be private.'), 'private');
  assert.strictEqual(E(404, 'models/gemini-3.8-flash is not found for API version v1beta'), 'model');
  assert.strictEqual(E(400, 'Invalid JSON payload received. Unknown name "mediaProcessing" at \'contents[0].parts[0]\''), 'processing');
  assert.strictEqual(AI.classify(0, '').kind, 'offline');
  assert.strictEqual(E(503, 'The model is overloaded.'), 'busy');
  Object.values(AI.MSG).forEach((m) => assert.ok(!/[{}]|stack|undefined/.test(m), 'messages are plain words: ' + m));

  // Pacific day: Google's free day turns over at Pacific midnight (8am in London in October)
  assert.strictEqual(AI.pacificDay(Date.parse('2026-10-05T06:59:00Z')), '2026-10-04');
  assert.strictEqual(AI.pacificDay(Date.parse('2026-10-05T07:00:00Z')), '2026-10-05');
  assert.strictEqual(AI.nextReset(Date.parse('2026-10-05T12:00:00Z')), Date.parse('2026-10-06T07:00:00Z'));
  assert.strictEqual(AI.nextReset(Date.parse('2026-12-01T12:00:00Z')), Date.parse('2026-12-02T08:00:00Z'), 'winter: 8am GMT');


  // Watch page: length and whether it's public
  assert.deepStrictEqual(AI.parseWatch('..."lengthSeconds":"754"...'), { secs: 754, open: true });
  assert.strictEqual(AI.parseWatch('"playabilityStatus":{"status":"LOGIN_REQUIRED"}').open, false);

  // Anki: a drafted card is one line, front TAB back
  const card = { stem: 'A 3-year-old has 5 days of fever,\tred eyes and a strawberry tongue.', questions: ['What is the diagnosis?', 'What is the next step?'], answer: 'This is **Kawasaki disease**.', management: 'Give **IVIG and aspirin**.', vs: 'Versus scarlet fever: a sandpaper rash and strep, so penicillin.', why: 'Coronary aneurysms.' };
  const line = Marks.cardLine(card);
  assert.strictEqual(line.split('\t').length, 2, 'exactly one tab'); assert.ok(!/\n/.test(line));
  assert.ok(/<br><br>What is the diagnosis\?<br>What is the next step\?\t/.test(line) && /<b>Kawasaki disease<\/b>/.test(line) && /<i>Why: Coronary aneurysms.<\/i>$/.test(line), line);
  const store = {}; let t = Date.parse('2026-10-05T12:00:00Z');
  const marks = Marks.create({ load: (k) => store[k] || null, save: (k, v) => { store[k] = v; }, now: () => t });
  const m1 = marks.add({ vid: 'abcdefghijk', title: 'Q', t: 252 }); t++; marks.add({ vid: 'zyxwvutsrqp', title: 'Plain', t: 5 });
  marks.setCard(m1.id, card);
  const lines = marks.anki().split('\n');
  assert.strictEqual(lines[1], line, 'the drafted card replaces the link line');
  assert.strictEqual(lines[0], 'Plain @ 0:05\thttps://www.youtube.com/watch?v=zyxwvutsrqp&t=5s', 'no card: the old line');

  // The queue against a fake Gemini
  const calls = []; let reply = null, key = 'AIzaFAKEFAKEFAKEFAKEFAKE1', now = Date.parse('2026-10-05T12:00:00Z');
  const db = {};
  const io = { load: (k) => db[k] || null, save: (k, v) => { db[k] = v; }, now: () => now, key: () => key, wait: (ms) => { now += ms; return Promise.resolve(); },
    post: (url, b, h) => { calls.push({ url, b, h }); return Promise.resolve(reply(url, b)); } };
  const ok = (v) => ({ status: 200, text: wrap(JSON.stringify(v)) });
  const SUM = { gist: 'Renal in 10 minutes', points: [{ t: '1:00', text: 'GFR' }, { t: '2:30', text: 'Loops' }, { t: '4:00', text: 'Thiazides' }] };
  reply = () => ok(SUM);
  const ai = AI.create(io);
  const r1 = await ai.request({ vid: 'vid00000001', kind: 'summary', title: 'Renal', med: true, secs: 600 });
  assert.strictEqual(r1.points.length, 3); assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].h['x-goog-api-key'], key); assert.ok(/gemini-3\.8-flash:generateContent$/.test(calls[0].url));
  assert.strictEqual(calls[0].b.contents[0].parts[0].mediaProcessing, undefined, 'short videos: default processing');
  await ai.request({ vid: 'vid00000001', kind: 'summary', secs: 600 });
  assert.strictEqual(calls.length, 1, 'cached: no second call');
  assert.strictEqual(ai.usedToday(), 600);
  assert.strictEqual(AI.create(io).get('vid00000001', 'summary').gist, 'Renal in 10 minutes', 'cache survives a relaunch');

  // Long videos ask for agentic processing; if refused, once without it and remembered
  reply = (u, b) => b.contents[0].parts[0].mediaProcessing === 'AGENTIC' ? { status: 400, text: JSON.stringify({ error: { code: 400, message: 'Unknown name "mediaProcessing"' } }) } : ok(SUM);
  calls.length = 0;
  await ai.request({ vid: 'vid00000002', kind: 'summary', secs: 2400 });
  assert.deepStrictEqual(calls.map((c) => c.b.contents[0].parts[0].mediaProcessing), ['AGENTIC', undefined]);
  calls.length = 0; await ai.request({ vid: 'vid00000003', kind: 'summary', secs: 2400 });
  assert.strictEqual(calls.length, 1, 'remembered: no second refusal');

  // A retired model name: the alias takes over and is remembered
  reply = (u) => /3\.8-flash/.test(u) ? { status: 404, text: JSON.stringify({ error: { code: 404, message: 'models/gemini-3.8-flash is not found for API version v1beta' } }) } : ok(SUM);
  const ai2 = AI.create({ ...io, load: () => null, save: () => {} });
  calls.length = 0; await ai2.request({ vid: 'vid00000004', kind: 'summary', secs: 60 });
  assert.ok(/gemini-flash-latest/.test(calls[1].url));

  // Garbled once, fine the second time
  let n = 0; reply = () => (n++ ? ok(SUM) : { status: 200, text: wrap('Here are the points: oops') });
  calls.length = 0; await ai.request({ vid: 'vid00000005', kind: 'summary', secs: 60 });
  assert.strictEqual(calls.length, 2);

  // Busy (429): waits, then Flash-Lite
  n = 0; reply = (u) => (n++ ? ok(SUM) : { status: 429, text: JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted' } }) });
  calls.length = 0; await ai.request({ vid: 'vid00000006', kind: 'summary', secs: 60 });
  assert.ok(/flash-lite/.test(calls[1].url), 'retries on Flash-Lite');

  // Bad key, private video, offline (held until back online)
  reply = () => ({ status: 400, text: JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }) });
  await assert.rejects(ai.request({ vid: 'vid00000007', kind: 'summary', secs: 60 }), (e) => e.msg === AI.MSG.key);
  assert.strictEqual(ai.status('vid00000007', 'summary').msg, AI.MSG.key);
  assert.strictEqual(ai.last.msg, AI.MSG.key);
  reply = () => ({ status: 400, text: JSON.stringify({ error: { code: 400, message: 'The YouTube video is private.' } }) });
  await assert.rejects(ai.request({ vid: 'vid00000008', kind: 'notes', secs: 60 }), (e) => e.kind === 'private');
  reply = () => Promise.reject(new Error('offline'));
  const off = ai.request({ vid: 'vid00000009', kind: 'summary', secs: 60 });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(ai.status('vid00000009', 'summary').msg, AI.MSG.offline);
  reply = () => ok(SUM); ai.retryHeld();
  assert.strictEqual((await off).gist, 'Renal in 10 minutes', 'back online: it goes again');

  // Budget: auto stops at 6 of 8 hours and at 10 a day; a tap still works; the day rolls over at Pacific midnight
  assert.strictEqual(ai.autoBlock(3700), 'long');
  assert.strictEqual(ai.autoBlock(0), 'length');
  const used = ai.usedToday();
  await ai.request({ vid: 'vid0000000a', kind: 'summary', secs: 6 * 3600 - used - 30 });
  assert.strictEqual(ai.autoBlock(20), '', 'room under 6 hours');
  assert.strictEqual(ai.autoBlock(60), 'budget', 'auto stops at 6 of 8 hours');
  await ai.request({ vid: 'vid0000000d', kind: 'summary', secs: 60 });
  await assert.rejects(ai.request({ vid: 'vid0000000b', kind: 'summary', secs: 3 * 3600 }), (e) => e.kind === 'daily' && /resets at 8am/.test(e.msg));
  now = Date.parse('2026-10-06T07:00:00Z');
  assert.strictEqual(ai.usedToday(), 0, 'a new free day at 8am UK');
  for (let i = 0; i < 10; i++) await ai.request({ vid: 'auto000000' + i, kind: 'summary', secs: 60, auto: true });
  assert.strictEqual(ai.autoToday(), 10); assert.strictEqual(ai.autoBlock(60), 'count');
  await assert.rejects(ai.request({ vid: 'auto0000010', kind: 'summary', secs: 60, auto: true }));
  assert.strictEqual(ai.status('auto0000010', 'summary').state, 'none', 'skipped quietly');

  // A Mark card: clip, static, not cached by time alone (Mo's note may change it)
  calls.length = 0; reply = () => ok(card);
  const c1 = await ai.request({ vid: 'vid0000000c', kind: 'card', t: 252, secs: 600, note: 'Kawasaki', med: true });
  assert.strictEqual(c1.answer, 'This is **Kawasaki disease**.');
  assert.deepStrictEqual(calls[0].b.contents[0].parts[0].videoMetadata, { startOffset: '162s', endOffset: '282s' });
  assert.strictEqual(calls[0].b.contents[0].parts[0].mediaProcessing, 'STATIC');
  assert.ok(/Kawasaki/.test(calls[0].b.contents[0].parts[1].text));

  // Review fixes: a timeout is final and counted; any refusal of the processing setting falls back; offline cards fail fast
  calls.length = 0; let u0 = ai.usedToday(); reply = () => ({ status: 504, text: 'slow' });
  await assert.rejects(ai.request({ vid: 'slowvid0001', kind: 'summary', secs: 600 }), (e) => e.kind === 'slow' && e.msg === AI.MSG.slow);
  assert.strictEqual(calls.length, 1, 'no retry after a timeout'); assert.strictEqual(ai.usedToday() - u0, 600, 'a timeout still counts the hour');
  const ai3 = AI.create({ ...io, load: () => null, save: () => {} });
  calls.length = 0; reply = (u, b) => b.contents[0].parts[0].mediaProcessing ? { status: 400, text: JSON.stringify({ error: { code: 400, message: 'Agentic video understanding is not available on this tier.' } }) } : ok(SUM);
  assert.strictEqual((await ai3.request({ vid: 'longvid0001', kind: 'summary', secs: 3000 })).gist, 'Renal in 10 minutes', 'falls back whatever the wording');
  reply = () => Promise.reject(new Error('offline'));
  await assert.rejects(ai.request({ vid: 'vid0000000e', kind: 'card', t: 100, secs: 600 }), (e) => e.kind === 'offline');
  n = 0; u0 = ai.usedToday(); reply = () => (n++ ? ok(SUM) : { status: 200, text: wrap('not json') });
  await ai.request({ vid: 'garbvid0001', kind: 'summary', secs: 100 });
  assert.strictEqual(ai.usedToday() - u0, 200, 'a garbled answer still used the video once');
  ai.setLen('lenvid00001', { secs: 754, open: true }); assert.deepStrictEqual(AI.create(io).len('lenvid00001'), { secs: 754, open: true }, 'lengths are kept');
  reply = () => ok(SUM);

  // Cache: version in the key, capped at 300
  assert.ok(AI.cacheKey('v', 'summary').endsWith('|v' + AI.PROMPT_VERSION));
  reply = () => ok(SUM);
  for (let i = 0; i < 310; i++) { now += 1000; await ai.request({ vid: 'cap' + String(i).padStart(8, '0'), kind: 'summary', secs: 1 }); }
  assert.ok(ai.size <= 300, 'cache capped: ' + ai.size);
  assert.strictEqual(ai.get('cap00000309', 'summary').gist, 'Renal in 10 minutes', 'newest kept');

  // Notes to text and Anki
  const notes = AI.clean('notes', { topic: 'Kawasaki', facts: [{ t: '1:00', text: 'Fever 5 days' }], tested: [{ clue: 'Strawberry tongue', dx: 'Kawasaki', next: 'Echo' }], versus: [{ name: 'Scarlet fever', feature: 'Sandpaper rash' }], questions: [], cards: [card, { questions: [] }] });
  assert.strictEqual(notes.cards.length, 1);
  const md = AI.notesText(notes, 'HY Q', 'abcdefghijk');
  assert.ok(/## High-yield\n- \[1:00\] Fever 5 days/.test(md) && /Strawberry tongue → Kawasaki → Echo/.test(md) && /Scarlet fever: Sandpaper rash/.test(md), md);
  assert.strictEqual(AI.notesAnki(notes), line);

  // Key test: tiny text call
  reply = () => ({ status: 200, text: wrap('OK') });
  assert.deepStrictEqual(await ai.test(), { ok: true });
  key = ''; assert.strictEqual((await ai.test()).msg, AI.MSG.nokey);
  console.log('ai: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
