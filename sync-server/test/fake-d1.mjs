// A small stand-in for a D1 database, over Node's built-in SQLite, with only what the server uses:
// prepare(sql).bind(...).first() / run() / all(), and batch([...]) run inside one transaction.
import { DatabaseSync } from 'node:sqlite';

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  write() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(r.changes) }, results: [] };
  }
  read() {
    const rows = this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r }));
    return { success: true, meta: { changes: 0 }, results: rows };
  }
  async first(col) {
    const row = this.read().results[0];
    if (!row) return null;
    return col == null ? row : row[col];
  }
  async run() { return /^\s*select/i.test(this.sql) ? this.read() : this.write(); }
  async all() { return this.read(); }
}

export class FakeD1 {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => (/^\s*select/i.test(s.sql) ? s.read() : s.write()));
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
