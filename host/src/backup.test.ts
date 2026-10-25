import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDir, createBackup, integrityCheck, listBackups, pruneBackups } from './backup.js';
import { openDatabase, type DB } from './db/index.js';
import { seedDemo } from './seed.js';

const T0 = Date.UTC(2026, 10, 1, 16, 0, 0);
let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kh-backup-'));
  db = openDatabase(join(dir, 'kraken-hub.db'));
  seedDemo(db, T0);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A backup filename for an arbitrary time, matching backup.ts's format. */
function nameAt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `kraken-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}.sqlite`;
}

describe('database backups', () => {
  it('writes a consistent snapshot that opens and passes an integrity check', () => {
    const info = createBackup(db, T0);
    const file = join(backupDir(db.path), info.name);
    expect(existsSync(file)).toBe(true);
    expect(info.sizeBytes).toBeGreaterThan(0);

    // The snapshot is a real, readable database with the same data.
    const copy = openDatabase(file);
    expect(integrityCheck(copy)).toBe('ok');
    const stations = copy.prepare('SELECT COUNT(*) AS n FROM stations').get() as { n: number };
    const live = db.prepare('SELECT COUNT(*) AS n FROM stations').get() as { n: number };
    expect(stations.n).toBe(live.n);
    copy.close();
  });

  it('lists backups newest-first', () => {
    createBackup(db, T0);
    createBackup(db, T0 + 1000);
    const list = listBackups(backupDir(db.path));
    expect(list).toHaveLength(2);
    expect(list[0]!.at).toBeGreaterThan(list[1]!.at);
  });

  it('keeps recent backups dense and older ones one-per-day, dropping beyond the window', () => {
    const bdir = backupDir(db.path);
    mkdirSync(bdir, { recursive: true });
    const day = 24 * 60 * 60_000;
    const now = T0;
    const made: number[] = [];
    // 30 backups in the last few hours (within the "keep recent 24" window).
    for (let i = 0; i < 30; i++) made.push(now - i * 60_000);
    // Several per day for 20 days back (older than the recent window).
    for (let d = 1; d <= 20; d++) for (let k = 0; k < 3; k++) made.push(now - d * day - k * 60_000);
    for (const ms of made) writeFileSync(join(bdir, nameAt(ms)), 'x');

    pruneBackups(bdir, now, 24, 14);
    const kept = listBackups(bdir);
    // Newest 24 are all kept.
    const recentKept = kept.filter((b) => b.at > now - 24 * 60_000).length;
    expect(recentKept).toBe(24);
    // Nothing older than 14 days survives.
    expect(kept.every((b) => b.at >= now - 14 * day)).toBe(true);
    // For older-than-recent days, at most one per calendar day.
    const olderDays = kept.filter((b) => b.at <= now - 24 * 60_000).map((b) => new Date(b.at).toISOString().slice(0, 10));
    expect(new Set(olderDays).size).toBe(olderDays.length);
  });

  it('ignores unrelated files in the backup folder', () => {
    const bdir = backupDir(db.path);
    createBackup(db, T0);
    writeFileSync(join(bdir, 'notes.txt'), 'not a backup');
    writeFileSync(join(bdir, 'kraken-nonsense.sqlite'), 'x');
    expect(listBackups(bdir)).toHaveLength(1);
  });
});
