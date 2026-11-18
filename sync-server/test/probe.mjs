// Walks the sync protocol against a live address, on a throwaway shelf it drops at the end.
// Usage: node sync-server/test/probe.mjs https://<address>
// Prints PASS/FAIL lines and exits non-zero on any FAIL.
// The node tests (server.test.mjs) run the same walk() against the function directly.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'cache-control': 'no-store',
};

export const hex = (n) => randomBytes(n).toString('hex');

// Makes check() and a send wrapper that also checks the CORS headers on every answer.
// send(method, data, type) -> { status, headers, json }; data is an object (sent as JSON) or raw text.
export function harness(rawSend) {
  const fails = [];
  let passes = 0;
  let corsBad = 0;
  let answers = 0;
  function check(name, ok, detail) {
    if (ok) { passes++; console.log('PASS ' + name); }
    else { fails.push(name); console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 300))); }
  }
  async function send(method, data, type = 'text/plain') {
    const r = await rawSend(method, data == null ? null : typeof data === 'string' ? data : JSON.stringify(data), type);
    answers++;
    for (const [k, v] of Object.entries(CORS)) if (r.headers.get(k) !== v) { corsBad++; console.log(`  (no ${k} on a ${r.status} answer to ${method})`); }
    if (r.headers.get('set-cookie')) { corsBad++; console.log('  (a cookie was set)'); }
    return r;
  }
  function corsCheck() { check(`CORS headers and no cookies on every answer (${answers} answers)`, answers > 0 && corsBad === 0, { corsBad }); }
  return { check, send, corsCheck, result: () => ({ passes, fails }) };
}

// The protocol walk shared by the probe and the node tests. Leaves no shelf behind.
export async function walk({ check, send }, shelf = hex(16)) {
  const token = hex(32);
  const wrong = hex(32);
  const post = (msg) => send('POST', { v: 1, shelf, token, ...msg });
  try {
    await steps(check, send, post, shelf, token, wrong);
  } finally {
    // Drop the throwaway shelf whichever token holds it, even if a step threw
    for (const t of [token, wrong]) await send('POST', { v: 1, shelf, token: t, op: 'drop' }).catch(() => {});
  }
}

async function steps(check, send, post, shelf, token, wrong) {
  let r = await send('GET');
  check('health: GET answers ok, v 1', r.status === 200 && r.json?.ok === true && r.json?.v === 1, r);
  r = await send('OPTIONS');
  check('OPTIONS answers 204', r.status === 204, r.status);

  r = await send('POST', '{not json');
  check('bad JSON is 400', r.status === 400 && r.json?.error === 'bad', r);
  r = await send('POST', { v: 1, shelf: 'ABC' + shelf.slice(3), token, op: 'get' });
  check('bad shelf (capitals) is 400', r.status === 400, r);
  r = await send('POST', { v: 1, shelf: shelf.slice(0, 31), token, op: 'get' });
  check('bad shelf (too short) is 400', r.status === 400, r);
  r = await send('POST', { v: 1, shelf, token: token + 'z', op: 'get' });
  check('bad token is 400', r.status === 400, r);
  r = await post({ op: 'list' });
  check('unknown op is 400', r.status === 400, r);
  r = await post({ op: 'put', doc: 'Lib', base: 0, body: 'x' });
  check('bad doc name is 400', r.status === 400, r);
  r = await post({ op: 'put', doc: 'abcdefghijklm', base: 0, body: 'x' });
  check('doc name over 12 letters is 400', r.status === 400, r);

  r = await post({ op: 'get', docs: {} });
  check('get of an unknown shelf is 404', r.status === 404 && r.json?.error === 'none', r);
  r = await post({ op: 'drop' });
  check('drop of an unknown shelf is 404', r.status === 404, r);

  r = await post({ op: 'put', doc: 'lib', base: 0, body: 'one' });
  check('first put makes the shelf, ver 1', r.status === 200 && r.json?.ok === true && r.json?.ver === 1, r);
  r = await post({ op: 'get', docs: {} });
  check('get after first put returns the doc', r.status === 200 && r.json?.docs?.lib?.ver === 1 && r.json.docs.lib.body === 'one' && typeof r.json.docs.lib.at === 'number', r);

  r = await send('POST', { v: 1, shelf, token: wrong, op: 'get', docs: {} });
  check('wrong token: get is 403', r.status === 403 && r.json?.error === 'denied', r);
  r = await send('POST', { v: 1, shelf, token: wrong, op: 'put', doc: 'lib', base: 1, body: 'evil' });
  check('wrong token: put is 403', r.status === 403, r);
  r = await send('POST', { v: 1, shelf, token: wrong, op: 'drop' });
  check('wrong token: drop is 403', r.status === 403, r);
  r = await post({ op: 'get', docs: {} });
  check('wrong-token calls changed nothing', r.json?.docs?.lib?.ver === 1 && r.json.docs.lib.body === 'one', r);

  r = await post({ op: 'put', doc: 'lib', base: 1, body: 'two' });
  check('put with the right base stores, ver 2', r.status === 200 && r.json?.ver === 2, r);
  r = await post({ op: 'put', doc: 'lib', base: 1, body: 'stale' });
  check('put with a stale base is 409 with the stored doc', r.status === 409 && r.json?.ok === false && r.json?.ver === 2 && r.json?.body === 'two' && typeof r.json?.at === 'number', r);
  r = await post({ op: 'put', doc: 'lib', base: 0, body: 'stale' });
  check('put with base 0 on an existing doc is 409', r.status === 409 && r.json?.ver === 2, r);
  r = await post({ op: 'get', docs: {} });
  check('stale puts changed nothing', r.json?.docs?.lib?.ver === 2 && r.json.docs.lib.body === 'two', r);

  const [a, b] = await Promise.all([
    post({ op: 'put', doc: 'lib', base: 2, body: 'A' }),
    post({ op: 'put', doc: 'lib', base: 2, body: 'B' }),
  ]);
  const wins = [a, b].filter((x) => x.status === 200);
  const loses = [a, b].filter((x) => x.status === 409);
  check('two puts on the same base: exactly one wins', wins.length === 1 && loses.length === 1, [a.status, b.status]);
  const winner = a.status === 200 ? 'A' : 'B';
  r = await post({ op: 'get', docs: {} });
  check('the winner is what is stored, ver 3', r.json?.docs?.lib?.ver === 3 && r.json.docs.lib.body === winner, r);

  r = await post({ op: 'get', docs: {}, prev: true });
  check('prev: true returns the kept previous version', r.status === 200 && r.json?.docs?.lib?.ver === 2 && r.json.docs.lib.body === 'two', r);

  r = await post({ op: 'put', doc: 'pos', base: 0, body: 'p1' });
  check('second doc stored', r.status === 200 && r.json?.ver === 1, r);
  r = await post({ op: 'get', docs: { lib: 3 } });
  check('get with known versions returns only changed or unnamed docs', r.status === 200 && Object.keys(r.json?.docs || {}).join() === 'pos', r);
  r = await post({ op: 'get', docs: { lib: 3, pos: 1 } });
  check('get with all versions known returns nothing', r.status === 200 && Object.keys(r.json?.docs || {}).length === 0, r);
  r = await post({ op: 'get', docs: { lib: 2, pos: 1 } });
  check('get with an old known version returns that doc', Object.keys(r.json?.docs || {}).join() === 'lib' && r.json.docs.lib.ver === 3, r);

  let made = 2;
  for (const name of ['da', 'db', 'dc', 'dd', 'de', 'df', 'dg', 'dh', 'di', 'dj']) {
    r = await post({ op: 'put', doc: name, base: 0, body: name });
    if (r.status === 200) made++;
  }
  check('12 docs can be stored', made === 12, made);
  r = await post({ op: 'put', doc: 'dk', base: 0, body: 'dk' });
  check('a 13th doc is refused with 400', r.status === 400, r);
  r = await post({ op: 'put', doc: 'da', base: 1, body: 'da2' });
  check('existing docs still take puts at 12', r.status === 200 && r.json?.ver === 2, r);

  r = await post({ op: 'put', doc: 'lib', base: 3, body: 'x'.repeat(1400001) });
  check('a body over 1,400,000 characters is 413', r.status === 413 && r.json?.error === 'big', r.status);
  r = await post({ op: 'put', doc: 'lib', base: 3, body: 'x'.repeat(1400000) });
  check('a body of exactly 1,400,000 characters is stored', r.status === 200 && r.json?.ver === 4, r.status);
  r = await post({ op: 'put', doc: 'lib', base: 4, body: 'y'.repeat(1600001) });
  check('a request over 1,600,000 bytes is 413', r.status === 413, r.status);

  r = await post({ op: 'drop' });
  check('drop with the right token', r.status === 200 && r.json?.ok === true, r);
  r = await post({ op: 'get', docs: {} });
  check('after drop the shelf is gone (404)', r.status === 404, r);
  r = await send('POST', { v: 1, shelf, token: wrong, op: 'put', doc: 'lib', base: 0, body: 'new' });
  check('the id can be made again, with a new token', r.status === 200 && r.json?.ver === 1, r);
  r = await send('POST', { v: 1, shelf, token: wrong, op: 'get', docs: {}, prev: true });
  check('nothing from before the drop is left', r.status === 200 && Object.keys(r.json?.docs || {}).length === 0, r);
  r = await send('POST', { v: 1, shelf, token: wrong, op: 'get', docs: {} });
  check('the remade shelf holds only the new doc', Object.keys(r.json?.docs || {}).join() === 'lib' && r.json.docs.lib.body === 'new', r);
  r = await send('POST', { v: 1, shelf, token, op: 'get', docs: {} });
  check('the old token no longer works', r.status === 403, r);
  r = await send('POST', { v: 1, shelf, token: wrong, op: 'drop' });
  check('final drop', r.status === 200, r);
}

async function main() {
  const base = (process.argv[2] || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) { console.log('FAIL usage: node probe.mjs <base url>'); process.exit(2); }
  const url = base + '/api/sync';
  const rawSend = async (method, body, type) => {
    const res = await fetch(url, { method, body, headers: body == null ? {} : { 'content-type': type } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, json };
  };
  const h = harness(rawSend);
  const shelf = hex(16);
  try {
    await walk(h, shelf);
    h.corsCheck();
  } catch (e) {
    h.check('probe ran to the end', false, String(e));
  }
  const { passes, fails } = h.result();
  console.log(`${passes} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
