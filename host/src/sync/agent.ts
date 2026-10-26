import type { DB } from '../db/index.js';
import { dayAggregates } from './aggregate.js';

/**
 * Pushes this branch's daily rollup to the central hub for multi-branch reporting.
 *
 * Design for reliability: every push RECOMPUTES aggregates from the branch's own append-only
 * tables, so there is no outbound queue to corrupt or lose. If the hub is unreachable the branch
 * keeps running untouched; the next successful push simply carries the latest recomputed truth.
 * A short trailing window is pushed often (to keep today fresh and absorb brief outages), and the
 * full history is pushed on startup (to recover after a long outage).
 *
 * Only summary numbers leave the branch — never customer-level data. Entirely optional: with no
 * hub configured, a single-branch café runs exactly as before.
 */

export interface SyncConfig {
  hubUrl: string;
  branchId: string;
  branchName: string;
  secret: string;
  /** Minutes to add to UTC for the branch's local day boundaries. */
  tzOffsetMin: number;
  /** How often to push the trailing window. Default 5 minutes. */
  intervalMs?: number;
  /** How many trailing days each routine push covers. Default 4. */
  windowDays?: number;
}

const DAY_MS = 86_400_000;

export function readSyncConfig(env: NodeJS.ProcessEnv = process.env): SyncConfig | null {
  const hubUrl = env.KRAKEN_HUB_URL?.trim();
  const branchId = env.KRAKEN_BRANCH_ID?.trim();
  const secret = env.KRAKEN_BRANCH_SECRET?.trim();
  if (!hubUrl || !branchId || !secret) return null; // no hub configured → single-branch mode
  return {
    hubUrl: hubUrl.replace(/\/+$/, ''),
    branchId,
    secret,
    branchName: env.KRAKEN_BRANCH_NAME?.trim() || branchId,
    tzOffsetMin: -new Date().getTimezoneOffset(),
    intervalMs: env.KRAKEN_SYNC_INTERVAL_MS ? Number(env.KRAKEN_SYNC_INTERVAL_MS) : undefined,
  };
}

export class SyncAgent {
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;

  constructor(
    private readonly db: DB,
    private readonly cfg: SyncConfig,
    private readonly clock: () => number,
    private readonly log: (msg: string, err?: unknown) => void = () => {},
  ) {}

  start(): void {
    // Startup: push the full history once so a long outage is fully reconciled.
    void this.push(0).catch(() => {});
    const interval = this.cfg.intervalMs ?? 5 * 60_000;
    const windowDays = this.cfg.windowDays ?? 4;
    this.timer = setInterval(() => void this.push(this.clock() - windowDays * DAY_MS).catch(() => {}), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Recomputes aggregates from `from` to now and sends them. Never throws. Returns days sent. */
  async push(from: number): Promise<number> {
    if (this.inFlight) return 0; // don't overlap a slow push with the next tick
    this.inFlight = true;
    try {
      const to = this.clock() + DAY_MS; // include all of today, offset-safe
      const days = dayAggregates(this.db, Math.max(0, from), to, this.cfg.tzOffsetMin);
      const res = await fetch(`${this.cfg.hubUrl}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          branchId: this.cfg.branchId,
          branchName: this.cfg.branchName,
          secret: this.cfg.secret,
          tzOffsetMin: this.cfg.tzOffsetMin,
          days,
        }),
      });
      if (!res.ok) {
        this.log(`sync rejected by hub: ${res.status}`);
        return 0;
      }
      return days.length;
    } catch (err) {
      this.log('sync push failed (hub unreachable); will retry', err);
      return 0;
    } finally {
      this.inFlight = false;
    }
  }
}
