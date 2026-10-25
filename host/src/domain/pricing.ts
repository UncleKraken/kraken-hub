import { z } from 'zod';
import { roundHalfAway } from './money.js';

/**
 * A price plan decides what a station costs. Two kinds:
 * - hourly: a rate per hour, optionally different per player count (consoles).
 * - per_session: a fixed price each time a session is started (some table games).
 */
export const PricePlanConfig = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hourly'),
    /** Minor units per hour, keyed by player count as a string ("1", "2", "4"). Must include "1". */
    rates: z.record(z.string().regex(/^\d+$/), z.number().int().nonnegative()).refine((r) => '1' in r, {
      message: 'rates must include a 1-player rate',
    }),
    /** Bill in blocks of this many minutes, rounding up. 1 = per minute. */
    billingUnitMinutes: z.number().int().min(1).max(120).default(1),
    /** Minimum billed minutes for any session. */
    minimumMinutes: z.number().int().min(0).max(600).default(0),
  }),
  z.object({
    kind: z.literal('per_session'),
    priceMinor: z.number().int().nonnegative(),
  }),
]);
export type PricePlanConfig = z.infer<typeof PricePlanConfig>;

/** Rate for a player count: the exact key if set, else the highest defined count below it. */
export function rateFor(plan: Extract<PricePlanConfig, { kind: 'hourly' }>, players: number): number {
  const counts = Object.keys(plan.rates)
    .map(Number)
    .filter((n) => n <= players)
    .sort((a, b) => b - a);
  const key = String(counts[0] ?? 1);
  return plan.rates[key] ?? plan.rates['1']!;
}

export interface Segment {
  startedAt: number;
  /** null = still running; pass `now` to price it. */
  endedAt: number | null;
  rateMinorPerHour: number;
}

const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 3_600_000;

/**
 * Prices the time used across segments (pauses are simply gaps between segments).
 * Exact per-millisecond cost per segment, then the total is rounded up to the plan's
 * billing unit and minimum, with the extra time charged at the last segment's rate.
 */
export function priceTime(plan: Extract<PricePlanConfig, { kind: 'hourly' }>, segments: Segment[], now: number): {
  usedMs: number;
  billedMs: number;
  amountMinor: number;
} {
  let usedMs = 0;
  let exact = 0;
  for (const s of segments) {
    const end = s.endedAt ?? now;
    const ms = Math.max(0, end - s.startedAt);
    usedMs += ms;
    exact += (ms / MS_PER_HOUR) * s.rateMinorPerHour;
  }
  if (segments.length === 0) return { usedMs: 0, billedMs: 0, amountMinor: 0 };

  const unitMs = plan.billingUnitMinutes * MS_PER_MIN;
  // Grace of 5 seconds so a session ended at 15:00.4 isn't billed a whole extra block.
  const blocks = Math.ceil(Math.max(0, usedMs - 5_000) / unitMs);
  const billedMs = Math.max(plan.minimumMinutes * MS_PER_MIN, blocks * unitMs);
  const extraMs = Math.max(0, billedMs - usedMs);
  const lastRate = segments[segments.length - 1]!.rateMinorPerHour;
  exact += (extraMs / MS_PER_HOUR) * lastRate;

  return { usedMs, billedMs, amountMinor: Math.max(0, roundHalfAway(exact)) };
}

/** Price of buying `minutes` of prepaid time at the given player count. */
export function pricePrepaid(plan: Extract<PricePlanConfig, { kind: 'hourly' }>, minutes: number, players: number): number {
  return roundHalfAway((minutes / 60) * rateFor(plan, players));
}
