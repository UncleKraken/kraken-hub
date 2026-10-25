import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from './db/index.js';

/**
 * Local backups of the whole database. Money lives in an append-only ledger, so the one thing a
 * real café cannot afford to lose is this file. We take consistent snapshots (VACUUM INTO) on a
 * schedule and at every shift close, keep a rolling window of them next to the live database, and
 * let the manager download one at any time. Restoring is a documented manual step (replace the
 * live file while the host is stopped) — deliberately not a one-click action.
 */

const PREFIX = 'kraken-';
const SUFFIX = '.sqlite';

export interface BackupInfo {
  name: string;
  at: number; // parsed from the filename
  sizeBytes: number;
}

/** Where backups live: a `backups/` folder beside the live database file. */
export function backupDir(dbPath: string): string {
  return join(dirname(dbPath), 'backups');
}

/** kraken-20261025-174233-004.sqlite — sortable, with milliseconds to avoid collisions. */
function nameFor(now: number): string {
  const d = new Date(now);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}`;
  return `${PREFIX}${stamp}${SUFFIX}`;
}

/** Recovers the timestamp a backup filename encodes (UTC), or null if it isn't one of ours. */
function timeOf(name: string): number | null {
  const m = name.match(/^kraken-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})\.sqlite$/);
  if (!m) return null;
  const g = m.slice(1).map(Number);
  return Date.UTC(g[0]!, g[1]! - 1, g[2]!, g[3]!, g[4]!, g[5]!, g[6]!);
}

export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, at: timeOf(name) }))
    .filter((b): b is { name: string; at: number } => b.at !== null)
    .map((b) => ({ name: b.name, at: b.at, sizeBytes: statSync(join(dir, b.name)).size }))
    .sort((a, b) => b.at - a.at);
}

/**
 * Keeps recent backups dense and older ones sparse: every one of the last `keepRecent`, then at
 * most one per calendar day going back `keepDays` days; everything else is removed.
 */
export function pruneBackups(dir: string, now: number, keepRecent = 24, keepDays = 14): string[] {
  const all = listBackups(dir);
  const removed: string[] = [];
  const seenDay = new Set<string>();
  const cutoff = now - keepDays * 24 * 60 * 60_000;
  all.forEach((b, i) => {
    if (i < keepRecent) return; // always keep the newest N
    const day = new Date(b.at).toISOString().slice(0, 10);
    const tooOld = b.at < cutoff;
    if (tooOld || seenDay.has(day)) {
      try {
        rmSync(join(dir, b.name));
        removed.push(b.name);
      } catch {
        // A backup we couldn't delete isn't worth failing the whole operation.
      }
    } else {
      seenDay.add(day);
    }
  });
  return removed;
}

/** Writes one snapshot into the backups folder and prunes old ones. Returns the new file's info. */
export function createBackup(db: DB, now: number): BackupInfo {
  const dir = backupDir(db.path);
  mkdirSync(dir, { recursive: true });
  const name = nameFor(now);
  const full = join(dir, name);
  db.backupTo(full);
  const sizeBytes = statSync(full).size;
  pruneBackups(dir, now);
  return { name, at: now, sizeBytes };
}

/** A fast consistency check. Returns 'ok' when the database is healthy, else the first problem. */
export function integrityCheck(db: DB): string {
  const rows = db.prepare('PRAGMA quick_check').all() as Record<string, unknown>[];
  const first = rows[0] ? String(Object.values(rows[0])[0]) : 'ok';
  return first;
}
