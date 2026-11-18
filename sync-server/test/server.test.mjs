// Node tests for the sync function: the probe's walk run against onRequest with a SQLite stand-in for D1,
// plus what the probe skips (the 8-shelf limit) and a thrown error.
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
