import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth.js';
import { openDatabase, type DB } from '../db/index.js';
import { floorState } from '../queries.js';
import { seedDemo } from '../seed.js';
import { CommandBus } from '../commands/bus.js';
import { sessionCommands } from '../commands/sessions.js';
import { tabCommands } from '../commands/tabs.js';
import { shiftCommands } from '../commands/shifts.js';
import { dayAggregates } from './aggregate.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
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
const prod = (name: string) => state().products.find((p) => p.name === name)!;
const bal = (tabId: string) => (db.prepare('SELECT COALESCE(SUM(amount_minor), 0) AS c FROM ledger WHERE tab_id = ?').get(tabId) as { c: number }).c;

function sale(station: string, items: { n: string; q: number }[], method: 'cash' | 'card', tip = 0) {
  const sid = state().stations.find((s) => s.name === station)!.id;
  run('session.start', { stationId: sid, mode: 'postpaid', players: 1 });
  for (const it of items) run('tab.addItem', { stationId: sid, productId: prod(it.n).id, qty: it.q });
  const live = state().stations.find((s) => s.id === sid)!.session!;
  const ended = run('session.end', { sessionId: live.id }) as { tabId: string };
  const due = bal(ended.tabId);
  run('tab.checkout', { tabId: ended.tabId, method, tenders: [{ currency: 'ALL', amountMinor: due + tip }], tipMinor: tip });
  return due;
}

describe('dayAggregates', () => {
  it('summarizes each local day with activity and ranks products by name', () => {
    const d1a = sale('PC-01', [{ n: 'Red Bull', q: 2 }], 'cash');
    const d1b = sale('PC-02', [{ n: 'Coca-Cola', q: 1 }], 'card', 50);
    now += DAY;
    const d2 = sale('PC-03', [{ n: 'Red Bull', q: 1 }], 'cash');

    const agg = dayAggregates(db, T0 - DAY, now + DAY, 0);
    expect(agg).toHaveLength(2);

    const day1 = agg[0]!;
    expect(day1.summary.revenueMinor).toBe(d1a + d1b);
    expect(day1.summary.cashMinor).toBe(d1a);
    expect(day1.summary.cardMinor).toBe(d1b);
    expect(day1.summary.tipMinor).toBe(50);
    expect(day1.summary.paymentCount).toBe(2);
    expect(day1.summary.sessionCount).toBe(2);
    const rb1 = day1.products.find((p) => p.name === 'Red Bull')!;
    expect(rb1.qty).toBe(2);

    const day2 = agg[1]!;
    expect(day2.summary.revenueMinor).toBe(d2);
    expect(day2.products.find((p) => p.name === 'Red Bull')!.qty).toBe(1);
  });

  it('keeps a whole local day in one bucket under a timezone offset', () => {
    sale('PC-01', [{ n: 'Water', q: 1 }], 'cash');
    now += 90_000;
    sale('PC-02', [{ n: 'Water', q: 1 }], 'card');
    const agg = dayAggregates(db, T0 - DAY, now + DAY, 60);
    expect(agg).toHaveLength(1);
    expect(agg[0]!.products.find((p) => p.name === 'Water')!.qty).toBe(2);
  });

  it('returns nothing for a quiet window', () => {
    sale('PC-01', [{ n: 'Water', q: 1 }], 'cash');
    expect(dayAggregates(db, T0 - 2 * DAY, T0 - DAY, 0)).toHaveLength(0);
  });
});
