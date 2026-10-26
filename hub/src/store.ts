import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DB } from './db.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A branch is considered online if it reported within this window. */
export const ONLINE_WINDOW_MS = 15 * 60_000;

export const IngestInput = z.object({
  branchId: z.string().trim().min(1).max(64),
  branchName: z.string().trim().min(1).max(80),
  secret: z.string().min(16).max(256),
  tzOffsetMin: z.number().int().min(-720).max(840).default(0),
  days: z
    .array(
      z.object({
        summary: z.object({
          day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          revenueMinor: z.number().int(),
          cashMinor: z.number().int(),
          cardMinor: z.number().int(),
          tipMinor: z.number().int(),
          refundMinor: z.number().int(),
          paymentCount: z.number().int().min(0),
          sessionCount: z.number().int().min(0),
        }),
        products: z
          .array(
            z.object({
              day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              name: z.string().trim().min(1).max(80),
              qty: z.number().int(),
              revenueMinor: z.number().int(),
            }),
          )
          .max(2000)
          .default([]),
      }),
    )
    .max(1000),
});

export type Ingest = z.infer<typeof IngestInput>;

export class AuthError extends Error {}

/**
 * Accepts a branch's push. Trust-on-first-use: an unknown branch id registers with the secret it
 * first presents; after that every push must carry the same secret. Each day in the push fully
 * replaces that branch's stored data for that day (idempotent, so re-pushes and catch-ups are safe).
 */
export function ingest(db: DB, input: Ingest, now: number): { days: number } {
  const hash = sha256(input.secret);
  const existing = db.prepare('SELECT secret_hash FROM branches WHERE id = ?').get(input.branchId) as { secret_hash: string } | undefined;
  if (existing && existing.secret_hash !== hash) throw new AuthError('secret mismatch');

  db.transaction(() => {
    if (existing) {
      db.prepare('UPDATE branches SET name = ?, tz_offset_min = ?, last_seen_at = ? WHERE id = ?').run(input.branchName, input.tzOffsetMin, now, input.branchId);
    } else {
      db.prepare('INSERT INTO branches (id, name, secret_hash, tz_offset_min, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        input.branchId,
        input.branchName,
        hash,
        input.tzOffsetMin,
        now,
        now,
      );
    }

    const upsertDay = db.prepare(
      `INSERT INTO day_summaries (branch_id, day, revenue_minor, cash_minor, card_minor, tip_minor, refund_minor, payment_count, session_count, updated_at)
       VALUES (@b, @day, @rev, @cash, @card, @tip, @refund, @pc, @sc, @now)
       ON CONFLICT(branch_id, day) DO UPDATE SET
         revenue_minor = excluded.revenue_minor, cash_minor = excluded.cash_minor, card_minor = excluded.card_minor,
         tip_minor = excluded.tip_minor, refund_minor = excluded.refund_minor, payment_count = excluded.payment_count,
         session_count = excluded.session_count, updated_at = excluded.updated_at`,
    );
    const clearProducts = db.prepare('DELETE FROM product_days WHERE branch_id = ? AND day = ?');
    const insertProduct = db.prepare('INSERT INTO product_days (branch_id, day, name, qty, revenue_minor) VALUES (?, ?, ?, ?, ?)');

    for (const d of input.days) {
      const s = d.summary;
      upsertDay.run({ b: input.branchId, day: s.day, rev: s.revenueMinor, cash: s.cashMinor, card: s.cardMinor, tip: s.tipMinor, refund: s.refundMinor, pc: s.paymentCount, sc: s.sessionCount, now });
      clearProducts.run(input.branchId, s.day);
      for (const p of d.products) insertProduct.run(input.branchId, s.day, p.name, p.qty, p.revenueMinor);
    }
  })();

  return { days: input.days.length };
}

export interface Overview {
  from: string;
  to: string;
  totals: { revenueMinor: number; cashMinor: number; cardMinor: number; tipMinor: number; refundMinor: number; paymentCount: number; sessionCount: number };
  branches: { id: string; name: string; lastSeenAt: number | null; online: boolean; revenueMinor: number; cashMinor: number; cardMinor: number; tipMinor: number; sessionCount: number }[];
  daily: { day: string; revenueMinor: number }[];
  topProducts: { name: string; qty: number; revenueMinor: number }[];
}

/** Combined rollup across all branches for a day range (inclusive 'YYYY-MM-DD' strings). */
export function overview(db: DB, from: string, to: string, now: number): Overview {
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(revenue_minor),0) AS revenue, COALESCE(SUM(cash_minor),0) AS cash, COALESCE(SUM(card_minor),0) AS card,
              COALESCE(SUM(tip_minor),0) AS tip, COALESCE(SUM(refund_minor),0) AS refund,
              COALESCE(SUM(payment_count),0) AS pc, COALESCE(SUM(session_count),0) AS sc
       FROM day_summaries WHERE day >= ? AND day <= ?`,
    )
    .get(from, to) as { revenue: number; cash: number; card: number; tip: number; refund: number; pc: number; sc: number };

  const branches = (
    db
      .prepare(
        `SELECT b.id, b.name, b.last_seen_at AS lastSeenAt,
                COALESCE(SUM(s.revenue_minor),0) AS revenue, COALESCE(SUM(s.cash_minor),0) AS cash,
                COALESCE(SUM(s.card_minor),0) AS card, COALESCE(SUM(s.tip_minor),0) AS tip, COALESCE(SUM(s.session_count),0) AS sc
         FROM branches b LEFT JOIN day_summaries s ON s.branch_id = b.id AND s.day >= ? AND s.day <= ?
         GROUP BY b.id ORDER BY revenue DESC, b.name`,
      )
      .all(from, to) as { id: string; name: string; lastSeenAt: number | null; revenue: number; cash: number; card: number; tip: number; sc: number }[]
  ).map((b) => ({
    id: b.id,
    name: b.name,
    lastSeenAt: b.lastSeenAt,
    online: b.lastSeenAt !== null && now - b.lastSeenAt < ONLINE_WINDOW_MS,
    revenueMinor: b.revenue,
    cashMinor: b.cash,
    cardMinor: b.card,
    tipMinor: b.tip,
    sessionCount: b.sc,
  }));

  const daily = db
    .prepare('SELECT day, SUM(revenue_minor) AS rev FROM day_summaries WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day')
    .all(from, to) as { day: string; rev: number }[];

  const topProducts = db
    .prepare(
      `SELECT name, SUM(qty) AS qty, SUM(revenue_minor) AS rev FROM product_days
       WHERE day >= ? AND day <= ? GROUP BY name HAVING SUM(qty) <> 0 ORDER BY rev DESC LIMIT 15`,
    )
    .all(from, to) as { name: string; qty: number; rev: number }[];

  return {
    from,
    to,
    totals: { revenueMinor: totals.revenue, cashMinor: totals.cash, cardMinor: totals.card, tipMinor: totals.tip, refundMinor: totals.refund, paymentCount: totals.pc, sessionCount: totals.sc },
    branches,
    daily: daily.map((d) => ({ day: d.day, revenueMinor: d.rev })),
    topProducts: topProducts.map((p) => ({ name: p.name, qty: p.qty, revenueMinor: p.rev })),
  };
}
