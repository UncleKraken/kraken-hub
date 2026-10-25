import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations.js';

/** A prepared statement. Rows come back untyped; callers cast them to the row shape they selected. */
export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * The database, on Node's built-in SQLite (node:sqlite).
 * Built-in means nothing to compile when installing on a café PC — no Visual Studio,
 * no native build step that can fail on Windows.
 *
 * This small wrapper keeps the familiar prepare / transaction / pragma API.
 */
export class DB {
  private readonly raw: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
  }

  prepare(sql: string): Statement {
    const stmt = this.raw.prepare(sql);
    return {
      run: (...params) => {
        const r = stmt.run(...(params as never[]));
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      },
      get: (...params) => stmt.get(...(params as never[])),
      all: (...params) => stmt.all(...(params as never[])),
    };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** `pragma('journal_mode = WAL')` sets; `pragma('user_version', { simple: true })` reads one value. */
  pragma(text: string, opts: { simple?: boolean } = {}): unknown {
    if (text.includes('=')) {
      this.raw.exec(`PRAGMA ${text}`);
      return undefined;
    }
    const rows = this.raw.prepare(`PRAGMA ${text}`).all() as Record<string, unknown>[];
    if (opts.simple) {
      const first = rows[0];
      return first ? Object.values(first)[0] : undefined;
    }
    return rows;
  }

  /**
   * Wraps `fn` so it runs atomically: everything commits together or nothing does.
   * Nested calls use savepoints, so a transaction inside a transaction is safe.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const outer = this.depth === 0;
      const savepoint = `sp_${this.depth}`;
      this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      this.depth++;
      try {
        const result = fn(...args);
        this.depth--;
        this.raw.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (err) {
        this.depth--;
        this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw err;
      }
    };
  }

  close(): void {
    this.raw.close();
  }
}

/**
 * Opens (or creates) the database with crash-safe settings and applies pending migrations.
 * Pass ':memory:' for tests.
 */
export function openDatabase(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DB(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL'); // survive power loss without losing committed transactions
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = Number(db.pragma('user_version', { simple: true }) ?? 0);
  for (let v = current; v < migrations.length; v++) {
    const sql = migrations[v]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function getSetting(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
