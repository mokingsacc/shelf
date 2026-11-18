// Node tests for the sync function: the probe's walk run against onRequest with a SQLite stand-in for D1,
// plus what the probe skips (the 8-shelf limit, making room from a shelf unused for 30 days, seen) and a thrown error.
// Run: node sync-server/test/server.test.mjs
import { onRequest } from '../functions/api/sync.js';
import { FakeD1 } from './fake-d1.mjs';
import { harness, walk, hex } from './probe.mjs';

const DB = new FakeD1();

function sender(env) {
  return async (method, body, type) => {
    const request = new Request('https://sync.test/api/sync', { method, body, headers: body == null ? {} : { 'content-type': type } });
    const res = await onRequest({ request, env });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, json };
  };
}

const h = harness(sender({ DB }));
const { check, send } = h;
const count = (sql) => DB.db.prepare(sql).get().n;

try {
  await walk(h);
  check('the walk left no rows behind', count('SELECT COUNT(*) n FROM shelves') === 0 && count('SELECT COUNT(*) n FROM docs') === 0);

  // Only hashes are stored, never the token
  const shelf = hex(16), token = hex(32);
  await send('POST', { v: 1, shelf, token, op: 'put', doc: 'lib', base: 0, body: 'x' });
  const row = DB.db.prepare('SELECT tok FROM shelves WHERE id = ?').get(shelf);
  check('only the token hash is stored', row && row.tok !== token && /^[0-9a-f]{64}$/.test(row.tok));
  let r = await send('POST', { v: 1, shelf, token, op: 'get' });
  check('get with no docs field returns everything', r.status === 200 && r.json?.docs?.lib?.body === 'x', r);
  r = await send('POST', { v: 2, shelf, token, op: 'get' });
  check('a wrong protocol version is 400', r.status === 400, r);
  r = await send('POST', { v: 1, shelf, token, op: 'put', doc: 'lib', base: -1, body: 'x' });
  check('a negative base is 400', r.status === 400, r);
  r = await send('POST', { v: 1, shelf, token, op: 'put', doc: 'lib', base: 1, body: 5 });
  check('a body that is not text is 400', r.status === 400, r);
  r = await send('POST', { v: 1, shelf, token, op: 'put', doc: 'new', base: 4, body: 'x' });
  check('put with base > 0 on a missing doc is 409 with ver 0', r.status === 409 && r.json?.ver === 0, r);
  r = await send('POST', JSON.stringify({ v: 1, shelf, token, op: 'get' }), 'application/json');
  check('JSON content type works as well as text/plain', r.status === 200, r);
  r = await send('PUT', null);
  check('other methods are refused', r.status === 405, r);

  // 8 shelves at most; the one already made counts
  const fillers = [];
  while (count('SELECT COUNT(*) n FROM shelves') < 8) {
    const s = { shelf: hex(16), token: hex(32) };
    r = await send('POST', { v: 1, ...s, op: 'put', doc: 'lib', base: 0, body: 'f' });
    if (r.status !== 200) break;
    fillers.push(s);
  }
  check('8 shelves can be made', count('SELECT COUNT(*) n FROM shelves') === 8);
  const extra = { shelf: hex(16), token: hex(32) };
  r = await send('POST', { v: 1, ...extra, op: 'put', doc: 'lib', base: 0, body: 'x' });
  check('the 9th shelf is 507', r.status === 507 && r.json?.error === 'full', r);
  r = await send('POST', { v: 1, ...extra, op: 'get' });
  check('the refused shelf was not made', r.status === 404, r);
  r = await send('POST', { v: 1, shelf, token, op: 'put', doc: 'lib', base: 1, body: 'y' });
  check('existing shelves still take puts when full', r.status === 200 && r.json?.ver === 2, r);
  r = await send('POST', { v: 1, shelf, token, op: 'put', doc: 'pos', base: 0, body: 'p' });
  check('existing shelves still take new docs when full', r.status === 200, r);
  r = await send('POST', { v: 1, ...fillers[0], op: 'get' });
  check('existing shelves still answer get when full', r.status === 200 && r.json?.docs?.lib?.body === 'f', r);
  r = await send('POST', { v: 1, ...fillers[0], op: 'drop' });
  r = await send('POST', { v: 1, ...extra, op: 'put', doc: 'lib', base: 0, body: 'x' });
  check('after a drop a new shelf can be made again', r.status === 200, r);
  for (const s of [...fillers.slice(1), extra, { shelf, token }]) await send('POST', { v: 1, ...s, op: 'drop' });
  check('drops cleared every row', count('SELECT COUNT(*) n FROM shelves') === 0 && count('SELECT COUNT(*) n FROM docs') === 0);

  // A full store: the shelf seen longest ago makes room for a new one, only once nobody has used it for 30 days
  const DAY = 864e5, made = [];
  const seenOf = (s) => DB.db.prepare('SELECT seen FROM shelves WHERE id = ?').get(s.shelf)?.seen;
  const setSeen = (s, t) => DB.db.prepare('UPDATE shelves SET seen = ? WHERE id = ?').run(t, s.shelf);
  for (let i = 0; i < 8; i++) {
    const s = { shelf: hex(16), token: hex(32) };
    r = await send('POST', { v: 1, ...s, op: 'put', doc: 'lib', base: 0, body: 'f' + i });
    await send('POST', { v: 1, ...s, op: 'put', doc: 'pos', base: 0, body: 'p' + i });
    made.push(s);
  }
  const row0 = DB.db.prepare('SELECT born, seen FROM shelves WHERE id = ?').get(made[0].shelf);
  check('a new shelf is seen when it is made', row0 && row0.seen === row0.born && row0.seen > Date.now() - 60000, row0);
  const late = () => ({ shelf: hex(16), token: hex(32) });
  r = await send('POST', { v: 1, ...late(), op: 'put', doc: 'lib', base: 0, body: 'x' });
  check('a full store of fresh shelves is still 507', r.status === 507 && r.json?.error === 'full', r);
  setSeen(made[3], Date.now() - 29 * DAY);
  r = await send('POST', { v: 1, ...late(), op: 'put', doc: 'lib', base: 0, body: 'x' });
  check('a shelf unused for 29 days stays', r.status === 507 && seenOf(made[3]) > 0 && count('SELECT COUNT(*) n FROM shelves') === 8, r);
  setSeen(made[3], Date.now() - 31 * DAY); setSeen(made[5], Date.now() - 20 * DAY);
  const comer = late();
  r = await send('POST', { v: 1, ...comer, op: 'put', doc: 'lib', base: 0, body: 'new' });
  check('a full store with a 31-day-old shelf lets a new one in', r.status === 200 && r.json?.ver === 1, r);
  check('...and only that old one goes, with its docs', seenOf(made[3]) === undefined && count('SELECT COUNT(*) n FROM shelves') === 8
    && count(`SELECT COUNT(*) n FROM docs WHERE shelf = '${made[3].shelf}'`) === 0 && count('SELECT COUNT(*) n FROM docs') === 7 * 2 + 1);
  r = await send('POST', { v: 1, ...made[3], op: 'get' });
  check('...the old shelf answers 404 now', r.status === 404, r);
  let all = true;
  for (const s of made.filter((x, i) => i !== 3)) { r = await send('POST', { v: 1, ...s, op: 'get' }); all = all && r.status === 200 && /^f\d$/.test(r.json?.docs?.lib?.body || ''); }
  check('...every other shelf keeps its docs', all);
  r = await send('POST', { v: 1, ...comer, op: 'get' });
  check('...the new shelf works', r.status === 200 && r.json?.docs?.lib?.body === 'new', r);
  r = await send('POST', { v: 1, ...late(), op: 'put', doc: 'lib', base: 0, body: 'x' });
  check('...and the next one is 507 again (the 20-day-old shelf stays)', r.status === 507 && seenOf(made[5]) > 0, r);

  // seen moves at most once a day, and only for the right token
  const t2h = Date.now() - 2 * 3600e3, t25h = Date.now() - 25 * 3600e3;
  setSeen(made[0], t2h);
  await send('POST', { v: 1, ...made[0], op: 'get' });
  await send('POST', { v: 1, ...made[0], op: 'put', doc: 'lib', base: 1, body: 'g' });
  check('seen does not move twice in a day', seenOf(made[0]) === t2h, seenOf(made[0]));
  setSeen(made[0], t25h);
  let before = Date.now();
  await send('POST', { v: 1, ...made[0], op: 'get' });
  check('a get a day later moves seen', seenOf(made[0]) >= before, seenOf(made[0]));
  setSeen(made[1], t25h); before = Date.now();
  await send('POST', { v: 1, ...made[1], op: 'put', doc: 'lib', base: 1, body: 'g' });
  check('a put a day later moves seen', seenOf(made[1]) >= before, seenOf(made[1]));
  setSeen(made[2], t25h);
  await send('POST', { v: 1, shelf: made[2].shelf, token: hex(32), op: 'get' });
  await send('POST', { v: 1, shelf: made[2].shelf, token: hex(32), op: 'put', doc: 'lib', base: 1, body: 'z' });
  check('a wrong token never moves seen', seenOf(made[2]) === t25h, seenOf(made[2]));
  for (const s of [...made, comer]) await send('POST', { v: 1, ...s, op: 'drop' });
  check('drops cleared every row again', count('SELECT COUNT(*) n FROM shelves') === 0 && count('SELECT COUNT(*) n FROM docs') === 0);

  // A thrown error is a JSON 500 with CORS, never an HTML page
  const broken = harness(sender({ DB: { prepare() { throw new Error('boom'); }, batch() { throw new Error('boom'); } } }));
  r = await broken.send('POST', { v: 1, shelf, token, op: 'get' });
  check('a thrown error is 500 { ok:false, error:"server" }', r.status === 500 && r.json?.ok === false && r.json?.error === 'server', r);
  check('the 500 answer carries CORS', r.headers.get('access-control-allow-origin') === '*' && r.headers.get('access-control-allow-methods') === 'GET, POST, OPTIONS'
    && r.headers.get('access-control-allow-headers') === 'content-type' && r.headers.get('cache-control') === 'no-store');
} catch (e) {
  check('tests ran to the end', false, String(e && e.stack || e));
}
h.corsCheck();

const { passes, fails } = h.result();
console.log(`${passes} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
