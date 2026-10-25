import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from './auth.js';
import { openDatabase, type DB } from './db/index.js';
import { businessReport, floorState } from './queries.js';
import { seedDemo } from './seed.js';
import { CommandBus } from './commands/bus.js';
import { sessionCommands } from './commands/sessions.js';
import { tabCommands } from './commands/tabs.js';
import { shiftCommands } from './commands/shifts.js';

const DAY = 24 * 60 * 60_000;
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0); // a Monday morning, UTC

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
const state = () => floorState(db, op, now);
const stationId = (name: string) => state().stations.find((s) => s.name === name)!.id;
const product = (name: string) => state().products.find((p) => p.name === name)!;
const balance = (tabId: string) => (db.prepare('SELECT COALESCE(SUM(amount_minor), 0) AS c FROM ledger WHERE tab_id = ?').get(tabId) as { c: number }).c;

/** Runs a quick cash/card sale on a station: open time, add item(s), end, pay. */
function sale(station: string, items: { name: string; qty: number }[], method: 'cash' | 'card', tipMinor = 0) {
  const sid = stationId(station);
  run('session.start', { stationId: sid, mode: 'postpaid', players: 1 });
  for (const it of items) run('tab.addItem', { stationId: sid, productId: product(it.name).id, qty: it.qty });
  const live = state().stations.find((s) => s.id === sid)!.session!;
  const ended = run('session.end', { sessionId: live.id }) as { tabId: string };
  const due = balance(ended.tabId);
  const tenders = method === 'cash' ? [{ currency: 'ALL', amountMinor: due + tipMinor }] : [{ currency: 'ALL', amountMinor: due + tipMinor }];
  run('tab.checkout', { tabId: ended.tabId, method, tenders, tipMinor });
  return due;
}

describe('businessReport', () => {
  it('totals revenue, splits cash/card, sums tips, and ranks products across days', () => {
    // Day 1: two cash sales.
    const rb = product('Red Bull');
    const coke = product('Coca-Cola');
    const s1 = sale('PC-01', [{ name: 'Red Bull', qty: 2 }], 'cash');
    const s2 = sale('PC-02', [{ name: 'Coca-Cola', qty: 1 }], 'cash');

    // Day 2: one card sale with a tip.
    now += DAY;
    const s3 = sale('PC-03', [{ name: 'Red Bull', qty: 1 }], 'card', 100);

    const report = businessReport(db, T0 - DAY, now + DAY, 0);

    expect(report.revenueMinor).toBe(s1 + s2 + s3);
    expect(report.cashMinor).toBe(s1 + s2);
    expect(report.cardMinor).toBe(s3);
    expect(report.tipMinor).toBe(100);
    expect(report.paymentCount).toBe(3);
    expect(report.sessionCount).toBe(3);

    // Red Bull sold 3 total (2 + 1), Coca-Cola 1. Red Bull ranks first by revenue.
    const byId = Object.fromEntries(report.topProducts.map((p) => [p.productId, p]));
    expect(byId[rb.id]).toMatchObject({ qty: 3 });
    expect(byId[coke.id]).toMatchObject({ qty: 1 });
    expect(report.topProducts[0]!.productId).toBe(rb.id);

    // Two calendar days of revenue — and same-day sales share one bucket, not one each.
    expect(report.daily).toHaveLength(2);
    expect(report.daily[0]!.revenueMinor).toBe(s1 + s2); // both day-1 sales in one bucket
    expect(report.daily[1]!.revenueMinor).toBe(s3);
    expect(report.daily.reduce((n, d) => n + d.revenueMinor, 0)).toBe(report.revenueMinor);
  });

  it('buckets all of one local day together even with a timezone offset', () => {
    // Three sales minutes apart, with a +60-minute offset: must land in a single day bucket.
    sale('PC-01', [{ name: 'Water', qty: 1 }], 'cash');
    now += 60_000;
    sale('PC-02', [{ name: 'Water', qty: 1 }], 'cash');
    now += 60_000;
    sale('PC-03', [{ name: 'Water', qty: 1 }], 'card');
    const report = businessReport(db, T0 - DAY, now + DAY, 60);
    expect(report.daily).toHaveLength(1);
    expect(report.daily[0]!.revenueMinor).toBe(report.revenueMinor);
  });

  it('nets reversed items out of product totals', () => {
    const sid = stationId('PC-01');
    const rb = product('Red Bull');
    run('session.start', { stationId: sid, mode: 'postpaid', players: 1 });
    run('tab.addItem', { stationId: sid, productId: rb.id, qty: 3 });
    // Reverse one of the item lines (manager-style correction).
    const line = db.prepare("SELECT id FROM ledger WHERE product_id = ? ORDER BY created_at DESC LIMIT 1").get(rb.id) as { id: string };
    run('tab.reverseEntry', { entryId: line.id, reason: 'spilled' });

    const report = businessReport(db, T0 - DAY, now + DAY, 0);
    const rbRow = report.topProducts.find((p) => p.productId === rb.id);
    // The 3-unit line and its reversal net to zero, so Red Bull drops out (or shows 0).
    expect(rbRow).toBeUndefined();
  });

  it('respects the time window', () => {
    sale('PC-01', [{ name: 'Red Bull', qty: 1 }], 'cash');
    // A window entirely before the sale sees nothing.
    const empty = businessReport(db, T0 - 2 * DAY, T0 - DAY, 0);
    expect(empty.revenueMinor).toBe(0);
    expect(empty.paymentCount).toBe(0);
    expect(empty.topProducts).toHaveLength(0);
  });
});
