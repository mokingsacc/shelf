// Shelf sync store: a small versioned blob store for one person's devices.
// It only holds text the device has already scrambled and never sees a key. No accounts:
// a shelf is made by its first put, and every later call must carry the same token.
// Protocol and limits are described in the tests (test/server.test.mjs).

const MAX_REQ = 1600000; // request bytes
const MAX_BODY = 1400000; // body characters
const MAX_SHELVES = 8; // one person needs one; a few spare for the probe
const MAX_DOCS = 12;
const HEX = /^[0-9a-f]{32,64}$/;
const DOC = /^[a-z]{1,12}$/;

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};

function reply(status, data) {
  return new Response(data == null ? null : JSON.stringify(data), { status, headers: HEADERS });
}
const bad = () => reply(400, { ok: false, error: 'bad' });
const denied = () => reply(403, { ok: false, error: 'denied' });
const none = () => reply(404, { ok: false, error: 'none' });
const big = () => reply(413, { ok: false, error: 'big' });
const full = () => reply(507, { ok: false, error: 'full' });

// Tables are made once per isolate, on the first call that needs them
let ready = null;
function setup(db) {
  if (!ready) {
    ready = db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS shelves (id TEXT PRIMARY KEY, tok TEXT, born INTEGER)'),
      db.prepare('CREATE TABLE IF NOT EXISTS docs (shelf TEXT, doc TEXT, slot INTEGER, ver INTEGER, body TEXT, at INTEGER, PRIMARY KEY (shelf, doc, slot))'),
    ]).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 'ok', 'none' (no such shelf) or 'denied' (wrong token)
async function shelfState(db, shelf, tok) {
  const row = await db.prepare('SELECT tok FROM shelves WHERE id = ?').bind(shelf).first();
  if (!row) return 'none';
  return row.tok === tok ? 'ok' : 'denied';
}

async function opGet(db, shelf, msg) {
  const known = msg.docs == null ? {} : msg.docs;
  if (typeof known !== 'object' || Array.isArray(known)) return bad();
  const slot = msg.prev === true ? 1 : 0;
  const { results } = await db.prepare('SELECT doc, ver, body, at FROM docs WHERE shelf = ? AND slot = ?').bind(shelf, slot).all();
  const docs = {};
  for (const r of results) {
    if (Object.prototype.hasOwnProperty.call(known, r.doc) && known[r.doc] === r.ver) continue;
    docs[r.doc] = { ver: r.ver, body: r.body, at: r.at };
  }
  return reply(200, { ok: true, docs });
}

async function opPut(db, shelf, tok, msg) {
  const { doc, base, body } = msg;
  if (typeof doc !== 'string' || !DOC.test(doc)) return bad();
  if (!Number.isSafeInteger(base) || base < 0) return bad();
  if (typeof body !== 'string') return bad();
  if (body.length > MAX_BODY) return big();

  // Make the shelf if it is new, unless there are already 8
  let state = await shelfState(db, shelf, tok);
  if (state === 'none') {
    const made = await db.prepare('INSERT OR IGNORE INTO shelves (id, tok, born) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM shelves) < ?4')
      .bind(shelf, tok, Date.now(), MAX_SHELVES).run();
    if (!made.meta.changes) {
      state = await shelfState(db, shelf, tok); // another call may have made it just now
      if (state === 'none') return full();
    } else state = 'ok';
  }
  if (state === 'denied') return denied();

  // Check and store in one go: each write only happens if the stored version still equals base
  // and the shelf still has this token, and the changed-row count says whether it did.
  const at = Date.now();
  const owner = 'EXISTS (SELECT 1 FROM shelves WHERE id = ?1 AND tok = ?2)';
  let changes;
  if (base === 0) {
    const r = await db.prepare(
      `INSERT OR IGNORE INTO docs (shelf, doc, slot, ver, body, at) SELECT ?1, ?3, 0, 1, ?4, ?5
       WHERE ${owner} AND (SELECT COUNT(*) FROM docs WHERE shelf = ?1 AND slot = 0) < ?6`
    ).bind(shelf, tok, doc, body, at, MAX_DOCS).run();
    changes = r.meta.changes;
  } else {
    const [, r] = await db.batch([
      db.prepare(
        `INSERT OR REPLACE INTO docs (shelf, doc, slot, ver, body, at) SELECT shelf, doc, 1, ver, body, at FROM docs
         WHERE shelf = ?1 AND doc = ?3 AND slot = 0 AND ver = ?4 AND ${owner}`
      ).bind(shelf, tok, doc, base),
      db.prepare(
        `UPDATE docs SET ver = ver + 1, body = ?5, at = ?6
         WHERE shelf = ?1 AND doc = ?3 AND slot = 0 AND ver = ?4 AND ${owner}`
      ).bind(shelf, tok, doc, base, body, at),
    ]);
    changes = r.meta.changes;
  }
  if (changes === 1) return reply(200, { ok: true, ver: base + 1 });

  // Nothing stored: say why
  state = await shelfState(db, shelf, tok);
  if (state === 'none') return none();
  if (state === 'denied') return denied();
  const cur = await db.prepare('SELECT ver, body, at FROM docs WHERE shelf = ? AND doc = ? AND slot = 0').bind(shelf, doc).first();
  if (!cur && base === 0) return bad(); // the shelf already has 12 docs
  return reply(409, cur ? { ok: false, ver: cur.ver, body: cur.body, at: cur.at } : { ok: false, ver: 0, body: null, at: 0 });
}

async function opDrop(db, shelf) {
  await db.batch([
    db.prepare('DELETE FROM docs WHERE shelf = ?').bind(shelf),
    db.prepare('DELETE FROM shelves WHERE id = ?').bind(shelf),
  ]);
  return reply(200, { ok: true });
}

async function handle(request, env) {
  const method = request.method;
  if (method === 'OPTIONS') return reply(204, null);
  if (method === 'GET') return reply(200, { ok: true, v: 1 });
  if (method !== 'POST') return reply(405, { ok: false, error: 'bad' });

  if (Number(request.headers.get('content-length')) > MAX_REQ) return big();
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_REQ) return big();
  let msg;
  try { msg = JSON.parse(new TextDecoder().decode(raw)); } catch { return bad(); }
  if (!msg || typeof msg !== 'object' || msg.v !== 1) return bad();
  const { shelf, token, op } = msg;
  if (typeof shelf !== 'string' || !HEX.test(shelf)) return bad();
  if (typeof token !== 'string' || !HEX.test(token)) return bad();
  if (op !== 'get' && op !== 'put' && op !== 'drop') return bad();

  const db = env.DB;
  await setup(db);
  const tok = await sha256(token);
  if (op === 'put') return opPut(db, shelf, tok, msg);
  const state = await shelfState(db, shelf, tok);
  if (state === 'none') return none();
  if (state === 'denied') return denied();
  return op === 'get' ? opGet(db, shelf, msg) : opDrop(db, shelf);
}

export async function onRequest(context) {
  try {
    return await handle(context.request, context.env);
  } catch {
    return reply(500, { ok: false, error: 'server' });
  }
}
