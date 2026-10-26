import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The hub's small database, on Node's built-in SQLite (same zero-build approach as the branch).
 * It holds only per-branch daily rollups — no customer-level data ever reaches here.
 */
export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

const migrations: string[] = [
  `
  CREATE TABLE branches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret_hash TEXT NOT NULL,           -- sha256 of the shared secret this branch pushes with
    tz_offset_min INTEGER NOT NULL DEFAULT 0,
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL
  );

  -- One row per branch per local day: the daily money summary the branch pushes.
  CREATE TABLE day_summaries (
    branch_id TEXT NOT NULL REFERENCES branches(id),
    day TEXT NOT NULL,                   -- 'YYYY-MM-DD' in the branch's local time
    revenue_minor INTEGER NOT NULL,
    cash_minor INTEGER NOT NULL,
    card_minor INTEGER NOT NULL,
    tip_minor INTEGER NOT NULL,
    refund_minor INTEGER NOT NULL,
    payment_count INTEGER NOT NULL,
    session_count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (branch_id, day)
  );

  -- Per-branch, per-day product totals, keyed by product name (the cross-branch key).
  CREATE TABLE product_days (
    branch_id TEXT NOT NULL REFERENCES branches(id),
    day TEXT NOT NULL,
    name TEXT NOT NULL,
    qty INTEGER NOT NULL,
    revenue_minor INTEGER NOT NULL,
    PRIMARY KEY (branch_id, day, name)
  );
  CREATE INDEX product_days_by_day ON product_days(day);
  `,
];

export class DB {
  private readonly raw: DatabaseSync;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
  }

  prepare(sql: string): Statement {
    const stmt = this.raw.prepare(sql);
    return {
      run: (...p) => {
        const r = stmt.run(...(p as never[]));
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      },
      get: (...p) => stmt.get(...(p as never[])),
      all: (...p) => stmt.all(...(p as never[])),
    };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const r = fn(...args);
        this.raw.exec('COMMIT');
        return r;
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw e;
      }
    };
  }

  close(): void {
    this.raw.close();
  }
}

export function openDatabase(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DB(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const current = Number((db.prepare('PRAGMA user_version').get() as Record<string, number> | undefined)?.user_version ?? 0);
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  return db;
}
