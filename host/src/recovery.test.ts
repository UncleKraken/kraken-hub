import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from './auth.js';
import { CommandBus } from './commands/bus.js';
import { sessionCommands } from './commands/sessions.js';
import { shiftCommands } from './commands/shifts.js';
import { tabCommands } from './commands/tabs.js';
import { openDatabase, setSetting, type DB } from './db/index.js';
import { floorState } from './queries.js';
import { GAP_THRESHOLD_MS, readRecoveryEvent, recoverOnStartup } from './recovery.js';
import { seedDemo } from './seed.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
let db: DB;
let now: number;
let bus: CommandBus;
let op: Actor;

beforeEach(() => {
  db = openDatabase(':memory:');
  now = T0;
  seedDemo(db, now);
  bus = new CommandBus(db, () => now).register(...sessionCommands, ...tabCommands, ...shiftCommands);
  op = db.prepare("SELECT id, username, display_name AS displayName, role FROM users WHERE username = 'operator'").get() as Actor;
  bus.execute(op, { type: 'shift.open', requestId: randomUUID(), payload: {} });
});

const run = (type: string, payload: unknown) => bus.execute(op, { type, requestId: randomUUID(), payload }) as Record<string, unknown>;
const station = (name: string) => floorState(db, op, now).stations.find((s) => s.name === name)!;
const openSegEnd = (sessionId: string) =>
  (db.prepare('SELECT ended_at FROM session_segments WHERE session_id = ? ORDER BY started_at DESC LIMIT 1').get(sessionId) as { ended_at: number | null }).ended_at;

describe('power-cut recovery', () => {
  it('pauses running open-time sessions at the last heartbeat and raises an event', () => {
    const { sessionId } = run('session.start', { stationId: station('PC-01').id, mode: 'postpaid' }) as { sessionId: string };
    // Host was alive 5 minutes in, then power was lost; it comes back 30 minutes later.
    const lastAlive = T0 + 5 * MIN;
    setSetting(db, 'host_alive_at', String(lastAlive));
    now = T0 + 35 * MIN;

    const event = recoverOnStartup(db, now);
    expect(event).not.toBeNull();
    expect(event!.interrupted).toEqual([sessionId]);

    // The session is paused and its clock stopped at the last heartbeat (dead time not billed).
    expect(station('PC-01').session!.status).toBe('paused');
    expect(openSegEnd(sessionId)).toBe(lastAlive);

    // The floor surfaces the banner.
    const fs = floorState(db, op, now);
    expect(fs.powerEvent).toMatchObject({ interrupted: 1, downSince: lastAlive, downUntil: now });
  });

  it('resumes all interrupted sessions and clears the banner', () => {
    const { sessionId } = run('session.start', { stationId: station('PC-02').id, mode: 'postpaid' }) as { sessionId: string };
    setSetting(db, 'host_alive_at', String(T0 + MIN));
    now = T0 + 20 * MIN;
    recoverOnStartup(db, now);
    expect(station('PC-02').session!.status).toBe('paused');

    const res = run('recovery.resumeAll', {}) as { resumed: number };
    expect(res.resumed).toBe(1);
    expect(station('PC-02').session!.status).toBe('active');
    expect(floorState(db, op, now).powerEvent).toBeNull();
    // A fresh segment opened at resume time; the old one stays closed at the heartbeat.
    expect(openSegEnd(sessionId)).toBeNull();
  });

  it('does nothing on a clean, quick restart', () => {
    run('session.start', { stationId: station('PC-03').id, mode: 'postpaid' });
    setSetting(db, 'host_alive_at', String(now - (GAP_THRESHOLD_MS - 5_000))); // under the gap threshold
    expect(recoverOnStartup(db, now)).toBeNull();
    expect(station('PC-03').session!.status).toBe('active');
    expect(readRecoveryEvent(db)).toBeNull();
  });

  it('leaves prepaid sessions alone (paid up front)', () => {
    run('session.start', { stationId: station('PC-04').id, mode: 'prepaid', prepaidMinutes: 60 });
    setSetting(db, 'host_alive_at', String(T0 + MIN));
    now = T0 + 20 * MIN;
    const event = recoverOnStartup(db, now);
    expect(event).toBeNull(); // no open-time sessions to pause
    expect(station('PC-04').session!.status).toBe('active');
  });
});
