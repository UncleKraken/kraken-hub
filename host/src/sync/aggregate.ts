import type { DB } from '../db/index.js';

/**
 * Branch-side rollup for multi-branch reporting. Each branch recomputes compact daily
 * aggregates from its own append-only money tables and pushes them to the central hub, which
 * sums them across branches. Only summary numbers leave the branch — no customer-level data.
 *
 * Days are keyed as 'YYYY-MM-DD' in the venue's local time (via tzOffsetMin), so a late-night
 * sale lands on the right calendar day no matter where the hub runs. Products are keyed by name,
 * since product ids differ per branch but "best sellers across all sites" is by name.
 */

export interface DaySummary {
  day: string;
  revenueMinor: number;
  cashMinor: number;
  cardMinor: number;
  tipMinor: number;
  refundMinor: number;
  paymentCount: number;
  sessionCount: number;
}

export interface DayProduct {
  day: string;
  name: string;
  qty: number;
  revenueMinor: number;
}

export interface DayAggregate {
  summary: DaySummary;
  products: DayProduct[];
}

const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' for a local day index (days since epoch in local time). */
function dayLabel(dayIdx: number): string {
  return new Date(dayIdx * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Builds aggregates for every local day with activity in [from, to). Returns one entry per day
 * that had any payment or product sale. Safe to call repeatedly — it's a pure read.
 */
export function dayAggregates(db: DB, from: number, to: number, tzOffsetMin: number): DayAggregate[] {
  const off = tzOffsetMin * 60_000;

  const summaryRows = db
    .prepare(
      `SELECT CAST((created_at + ?) / 86400000 AS INTEGER) AS dayIdx,
              COALESCE(SUM(applied_minor), 0) AS revenue,
              COALESCE(SUM(CASE WHEN method = 'cash' THEN applied_minor ELSE 0 END), 0) AS cash,
              COALESCE(SUM(CASE WHEN method = 'card' THEN applied_minor ELSE 0 END), 0) AS card,
              COALESCE(SUM(tip_minor), 0) AS tip,
              COALESCE(-SUM(CASE WHEN applied_minor < 0 THEN applied_minor ELSE 0 END), 0) AS refund,
              COUNT(*) AS n
       FROM payments WHERE created_at >= ? AND created_at < ?
       GROUP BY dayIdx`,
    )
    .all(off, from, to) as { dayIdx: number; revenue: number; cash: number; card: number; tip: number; refund: number; n: number }[];

  const sessionRows = db
    .prepare(
      `SELECT CAST((started_at + ?) / 86400000 AS INTEGER) AS dayIdx, COUNT(*) AS n
       FROM sessions WHERE started_at >= ? AND started_at < ? GROUP BY dayIdx`,
    )
    .all(off, from, to) as { dayIdx: number; n: number }[];
  const sessionsByDay = new Map(sessionRows.map((r) => [r.dayIdx, r.n]));

  const productRows = db
    .prepare(
      `SELECT CAST((l.created_at + ?) / 86400000 AS INTEGER) AS dayIdx, p.name AS name,
              SUM(l.qty) AS qty, SUM(l.amount_minor) AS revenue
       FROM ledger l JOIN products p ON p.id = l.product_id
       WHERE l.kind = 'item' AND l.product_id IS NOT NULL AND l.created_at >= ? AND l.created_at < ?
       GROUP BY dayIdx, p.name
       HAVING SUM(l.qty) <> 0`,
    )
    .all(off, from, to) as { dayIdx: number; name: string; qty: number; revenue: number }[];

  // Any day index that shows up in payments, sessions or product sales gets an entry.
  const dayIdxs = new Set<number>([...summaryRows.map((r) => r.dayIdx), ...sessionRows.map((r) => r.dayIdx), ...productRows.map((r) => r.dayIdx)]);
  const summaryByDay = new Map(summaryRows.map((r) => [r.dayIdx, r]));
  const productsByDay = new Map<number, DayProduct[]>();
  for (const r of productRows) {
    const list = productsByDay.get(r.dayIdx) ?? [];
    list.push({ day: dayLabel(r.dayIdx), name: r.name, qty: r.qty, revenueMinor: r.revenue });
    productsByDay.set(r.dayIdx, list);
  }

  return [...dayIdxs]
    .sort((a, b) => a - b)
    .map((dayIdx) => {
      const s = summaryByDay.get(dayIdx);
      const day = dayLabel(dayIdx);
      return {
        summary: {
          day,
          revenueMinor: s?.revenue ?? 0,
          cashMinor: s?.cash ?? 0,
          cardMinor: s?.card ?? 0,
          tipMinor: s?.tip ?? 0,
          refundMinor: s?.refund ?? 0,
          paymentCount: s?.n ?? 0,
          sessionCount: sessionsByDay.get(dayIdx) ?? 0,
        },
        products: productsByDay.get(dayIdx) ?? [],
      };
    });
}
