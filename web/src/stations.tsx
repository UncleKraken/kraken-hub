import type { StationKind, StationView } from './types';

export type StationState = 'free' | 'busy' | 'ending' | 'paused' | 'unpaid' | 'outOfOrder';

const ENDING_MS = 10 * 60_000;

export function stationState(s: StationView, now: number): StationState {
  if (s.session) {
    if (s.session.status === 'paused') return 'paused';
    if (s.session.endsAt && s.session.endsAt - now <= ENDING_MS) return 'ending';
    return 'busy';
  }
  if (s.tab && s.tab.balanceMinor > 0) return 'unpaid';
  if (s.outOfOrder) return 'outOfOrder';
  return 'free';
}

/** Elapsed time for open-time sessions, or time left for prepaid ones, as of `now`. */
export function sessionClock(s: StationView, now: number, fetchedAt: number): { ms: number; counting: 'up' | 'down' } | null {
  const sess = s.session;
  if (!sess) return null;
  if (sess.endsAt) return { ms: Math.max(0, sess.endsAt - now), counting: 'down' };
  const live = sess.status === 'active' ? Math.max(0, now - fetchedAt) : 0;
  return { ms: sess.usedMs + live, counting: 'up' };
}

/** Live estimate of open-time cost between refreshes; the host recalculates exactly at the end. */
export function pendingEstimate(s: StationView, now: number, fetchedAt: number): number {
  const sess = s.session;
  if (!sess || sess.mode !== 'postpaid' || s.plan.config.kind !== 'hourly') return 0;
  if (sess.status !== 'active') return sess.pendingMinor;
  const rates = s.plan.config.rates;
  const keys = Object.keys(rates).map(Number).filter((n) => n <= sess.players).sort((a, b) => b - a);
  const rate = rates[String(keys[0] ?? 1)] ?? rates['1'] ?? 0;
  return sess.pendingMinor + Math.round((Math.max(0, now - fetchedAt) / 3_600_000) * rate);
}

/** Small line glyphs for station kinds; drawn, not emoji, so they stay crisp and quiet. */
export function KindIcon({ kind, className }: { kind: StationKind; className?: string }) {
  const common = { className, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (kind) {
    case 'pc':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </svg>
      );
    case 'console':
      return (
        <svg {...common}>
          <path d="M7 8h10a4 4 0 0 1 3.9 4.8l-.7 3.4a2.4 2.4 0 0 1-4.2 1L14.5 15h-5L8 17.2a2.4 2.4 0 0 1-4.2-1l-.7-3.4A4 4 0 0 1 7 8Z" />
          <path d="M8 11v3M6.5 12.5h3M15.5 12h.01M17.5 13.5h.01" />
        </svg>
      );
    case 'sim':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="2" />
          <path d="M4.5 10h5.5M14 10h5.5M12 14v6" />
        </svg>
      );
    case 'table':
      return (
        <svg {...common}>
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <circle cx="9" cy="12" r="1.5" />
          <circle cx="14" cy="11" r="1.5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
  }
}
