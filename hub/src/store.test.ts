import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from './db.js';
import { AuthError, ingest, overview } from './store.js';

let db: DB;
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

beforeEach(() => {
  db = openDatabase(':memory:');
});

function day(branchId: string, branchName: string, secret: string, day: string, rev: number, products: { name: string; qty: number; rev: number }[] = [], extra: Partial<{ cash: number; card: number; tip: number; sessions: number }> = {}) {
  return ingest(
    db,
    {
      branchId,
      branchName,
      secret,
      tzOffsetMin: 60,
      days: [
        {
          summary: {
            day,
            revenueMinor: rev,
            cashMinor: extra.cash ?? rev,
            cardMinor: extra.card ?? 0,
            tipMinor: extra.tip ?? 0,
            refundMinor: 0,
            paymentCount: 1,
            sessionCount: extra.sessions ?? 1,
          },
          products: products.map((p) => ({ day, name: p.name, qty: p.qty, revenueMinor: p.rev })),
        },
      ],
    },
    NOW,
  );
}

describe('hub ingest + overview', () => {
  it('sums revenue and products across branches', () => {
    day('b1', 'Tirana', 'secret-one-aaaaaaaa', '2026-11-10', 1000, [{ name: 'Red Bull', qty: 2, rev: 600 }], { cash: 1000 });
    day('b2', 'Durres', 'secret-two-bbbbbbbb', '2026-11-10', 500, [{ name: 'Red Bull', qty: 1, rev: 300 }, { name: 'Water', qty: 1, rev: 100 }], { cash: 200, card: 300 });

    const o = overview(db, '2026-11-01', '2026-11-30', NOW);
    expect(o.totals.revenueMinor).toBe(1500);
    expect(o.totals.cashMinor).toBe(1200);
    expect(o.totals.cardMinor).toBe(300);
    expect(o.branches).toHaveLength(2);
    expect(o.branches[0]).toMatchObject({ name: 'Tirana', revenueMinor: 1000, online: true });

    const rb = o.topProducts.find((p) => p.name === 'Red Bull')!;
    expect(rb.qty).toBe(3); // 2 + 1 across branches
    expect(o.topProducts[0]!.name).toBe('Red Bull'); // highest revenue
    expect(o.daily.find((d) => d.day === '2026-11-10')!.revenueMinor).toBe(1500);
  });

  it('is idempotent: re-pushing a day replaces it rather than doubling', () => {
    day('b1', 'Tirana', 'secret-one-aaaaaaaa', '2026-11-10', 1000, [{ name: 'Red Bull', qty: 2, rev: 600 }]);
    // Branch re-sends the same day with corrected (higher) numbers.
    day('b1', 'Tirana', 'secret-one-aaaaaaaa', '2026-11-10', 1200, [{ name: 'Red Bull', qty: 3, rev: 900 }]);
    const o = overview(db, '2026-11-01', '2026-11-30', NOW);
    expect(o.totals.revenueMinor).toBe(1200);
    expect(o.topProducts.find((p) => p.name === 'Red Bull')!.qty).toBe(3);
  });

  it('registers a branch on first push and rejects a later wrong secret', () => {
    day('b1', 'Tirana', 'the-real-secret-123456', '2026-11-10', 1000);
    expect(() => day('b1', 'Tirana', 'an-imposter-secret-9999', '2026-11-11', 500)).toThrow(AuthError);
    // The imposter's data never landed.
    const o = overview(db, '2026-11-01', '2026-11-30', NOW);
    expect(o.totals.revenueMinor).toBe(1000);
  });

  it('respects the day range and marks stale branches offline', () => {
    day('b1', 'Tirana', 'secret-one-aaaaaaaa', '2026-11-10', 1000);
    // A window after the data sees nothing.
    expect(overview(db, '2026-11-20', '2026-11-30', NOW).totals.revenueMinor).toBe(0);
    // Far in the future, the branch's last_seen is stale -> offline.
    const later = NOW + 60 * 60_000;
    expect(overview(db, '2026-11-01', '2026-11-30', later).branches[0]!.online).toBe(false);
  });
});
