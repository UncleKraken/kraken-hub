import { getSetting, setSetting, type DB } from './db/index.js';

/**
 * Power-cut / crash recovery. The host writes a heartbeat timestamp every few seconds and on a
 * clean shutdown. When it starts up and finds that timestamp is old while sessions were still
 * running, the host was interrupted (power loss, crash, forced restart): it pauses those sessions
 * at the last heartbeat so nobody is charged for the dead time, and raises an event so the operator
 * sees "Power restored — N sessions interrupted" and can resume them.
 *
 * Only postpaid (open-time) sessions are paused here — their charge is time-based, so dead time
 * must not be billed. Prepaid time was paid up front and is handled by the normal expiry path.
 */

/** A gap longer than this between heartbeats means the host was down, not just quickly restarted. */
export const GAP_THRESHOLD_MS = 60_000;

export interface RecoveryEvent {
  interrupted: string[]; // session ids paused by recovery
  downSince: number;
  downUntil: number;
  at: number;
}

/** Records that the host is alive now. Called on the ticker and at clean shutdown. */
export function recordAlive(db: DB, now: number): void {
  setSetting(db, 'host_alive_at', String(now));
}

export function readRecoveryEvent(db: DB): RecoveryEvent | null {
  const raw = getSetting(db, 'recovery_event');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RecoveryEvent;
  } catch {
    return null;
  }
}

export function clearRecoveryEvent(db: DB): void {
  db.prepare("DELETE FROM settings WHERE key = 'recovery_event'").run();
}

/**
 * Runs once at startup. If the previous run ended abruptly while sessions were active, pauses those
 * open-time sessions at the last heartbeat and records a recovery event. Returns the event, or null
 * when the restart was clean/quick or nothing was running.
 */
export function recoverOnStartup(db: DB, now: number): RecoveryEvent | null {
  const lastRaw = getSetting(db, 'host_alive_at');
  recordAlive(db, now); // start a fresh heartbeat regardless
  if (!lastRaw) return null; // first ever run
  const lastAlive = Number(lastRaw);
  if (!Number.isFinite(lastAlive) || now - lastAlive < GAP_THRESHOLD_MS) return null; // clean/quick restart

  const active = db.prepare("SELECT id FROM sessions WHERE status = 'active' AND mode = 'postpaid'").all() as { id: string }[];
  if (active.length === 0) return null;

  const interrupted: string[] = [];
  db.transaction(() => {
    for (const { id } of active) {
      // Stop the clock at the last heartbeat so the outage isn't billed, then pause.
      db.prepare('UPDATE session_segments SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL').run(lastAlive, id);
      db.prepare("UPDATE sessions SET status = 'paused' WHERE id = ?").run(id);
      db.prepare("INSERT INTO audit_log (at, action, entity, entity_id, after) VALUES (?, 'session.interrupted', 'session', ?, ?)").run(
        now,
        id,
        JSON.stringify({ downSince: lastAlive, downUntil: now }),
      );
      interrupted.push(id);
    }
    const event: RecoveryEvent = { interrupted, downSince: lastAlive, downUntil: now, at: now };
    setSetting(db, 'recovery_event', JSON.stringify(event));
  })();

  return { interrupted, downSince: lastAlive, downUntil: now, at: now };
}
