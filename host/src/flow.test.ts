import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from './auth.js';
import { adminCommands } from './commands/admin.js';
import { CommandBus } from './commands/bus.js';
import { expirePrepaidSessions, sessionCommands } from './commands/sessions.js';
import { shiftCommands } from './commands/shifts.js';
import { tabCommands } from './commands/tabs.js';
import { openDatabase, type DB } from './db/index.js';
import { currentShift, floorState, tabDetail } from './queries.js';
import { seedDemo } from './seed.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 16, 0, 0);

let db: DB;
let now: number;
let bus: CommandBus;
let manager: Actor;
let operator: Actor;

function actor(username: string): Actor {
  return db.prepare('SELECT id, username, display_name AS displayName, role FROM users WHERE username = ?').get(username) as Actor;
}
function run<T = Record<string, unknown>>(who: Actor, type: string, payload: unknown, extra: { requestId?: string; approval?: { username: string; password: string } } = {}): T {
  return bus.execute(who, { type, requestId: extra.requestId ?? randomUUID(), payload, approval: extra.approval }) as T;
}
function station(name: string) {
  return floorState(db, operator, now).stations.find((s) => s.name === name)!;
}
function expectError(fn: () => unknown, code: string) {
  expect(fn).toThrow(expect.objectContaining({ code }));
}

beforeEach(() => {
  db = openDatabase(':memory:');
  now = T0;
  seedDemo(db, now);
  bus = new CommandBus(db, () => now).register(...sessionCommands, ...tabCommands, ...shiftCommands, ...adminCommands);
  manager = actor('admin');
  operator = actor('operator');
});

describe('a full operator shift', () => {
  it('runs sessions, orders and a mixed-currency checkout, then reconciles the drawer', () => {
    run(operator, 'shift.open', { openingFloat: { ALL: 5000 } });

    // PC-03: postpaid, 47 minutes, plus a Coke.
    const pc = station('PC-03');
    const { sessionId, tabId } = run<{ sessionId: string; tabId: string }>(operator, 'session.start', { stationId: pc.id });
    now += 47 * MIN;
    expect(station('PC-03').session!.pendingMinor).toBe(157); // 47 min × 200/h = 156.67
    const coke = floorState(db, operator, now).products.find((p) => p.name === 'Coca-Cola')!;
    run(operator, 'tab.addItem', { stationId: pc.id, productId: coke.id });
    run(operator, 'session.end', { sessionId });

    let tab = tabDetail(db, tabId);
    expect(tab.totals.balanceMinor).toBe(157 + 150);

    // Checkout: 307 L rounds to 310 L; customer pays €5 (= 500 L) → 190 L change.
    const res = run<{ changeMinor: number; closed: boolean }>(operator, 'tab.checkout', {
      tabId,
      method: 'cash',
      tenders: [{ currency: 'EUR', amountMinor: 500 }],
    });
    expect(res.changeMinor).toBe(190);
    expect(res.closed).toBe(true);
    tab = tabDetail(db, tabId);
    expect(tab.lines.some((l) => l.kind === 'rounding' && l.amountMinor === 3)).toBe(true);

    // Pool 1 prepaid 1 hour, card payment with a 50 L tip.
    const pool = station('Pool 1');
    const s2 = run<{ tabId: string }>(operator, 'session.start', { stationId: pool.id, mode: 'prepaid', prepaidMinutes: 60 });
    now += 60 * MIN;
    expect(expirePrepaidSessions(db, now)).toBe(1);
    run(operator, 'tab.checkout', { tabId: s2.tabId, method: 'card', tenders: [{ currency: 'ALL', amountMinor: 450 }], tipMinor: 50 });

    // Drawer: 5000 L + 1 EUR note of €5, minus 190 L change.
    const shift = currentShift(db, operator)!;
    expect(shift.expectedCash).toEqual({ ALL: 4810, EUR: 500 });
    expect(shift.tips.cardMinor).toBe(50);
    expect(shift.collectedCardMinor).toBe(400);

    // Counted exactly; card tip paid out of the drawer; leave 5000 L float.
    const report = run<{ closing: { overShort: Record<string, number>; dropped: Record<string, number> } }>(operator, 'shift.close', {
      counted: { ALL: 4810, EUR: 500 },
      floatLeft: { ALL: 4000 },
    });
    expect(report.closing.overShort).toEqual({ ALL: 0, EUR: 0 });
    expect(report.closing.dropped).toEqual({ ALL: 760, EUR: 500 }); // 4810 − 50 tip − 4000 float

    // Drawer ledger nets to zero after close.
    const net = db.prepare('SELECT currency, SUM(amount_minor) AS s FROM cash_movements GROUP BY currency').all() as { currency: string; s: number }[];
    for (const r of net) expect(r.s).toBe(0);

    // The next shift is offered what was left.
    expect(floorState(db, manager, now).suggestedFloat).toEqual({ ALL: 4000 });
  });

  it('runs a group of stations on one shared tab and checks out once', () => {
    run(operator, 'shift.open', { openingFloat: {} });
    const pcs = ['PC-01', 'PC-02', 'PC-03'].map((n) => station(n));
    const grp = run<{ groupId: string; tabId: string; sessionIds: string[] }>(operator, 'session.startGroup', {
      stationIds: pcs.map((s) => s.id),
      mode: 'postpaid',
    });
    expect(grp.sessionIds).toHaveLength(3);

    // One shared tab (no single station), three sessions all pointing at it.
    const groupTab = tabDetail(db, grp.tabId);
    expect(groupTab.stationId).toBeNull();
    const sess = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE tab_id = ?').get(grp.tabId) as { n: number };
    expect(sess.n).toBe(3);

    // Every member station shows the same shared tab and is marked as a group.
    for (const name of ['PC-01', 'PC-02', 'PC-03']) {
      const st = station(name);
      expect(st.tab?.id).toBe(grp.tabId);
      expect(st.groupId).toBe(grp.groupId);
      expect(st.session).not.toBeNull();
    }

    // An item ordered from any member lands on the shared tab, not a new one.
    const coke = floorState(db, operator, now).products.find((p) => p.name === 'Coca-Cola')!;
    run(operator, 'tab.addItem', { stationId: pcs[1]!.id, productId: coke.id, qty: 2 });
    expect(tabDetail(db, grp.tabId).totals.chargedMinor).toBe(300);

    // While any session is live, the shared tab can't be checked out.
    now += 30 * MIN;
    expectError(() => run(operator, 'tab.checkout', { tabId: grp.tabId, method: 'cash', tenders: [{ currency: 'ALL', amountMinor: 10000 }] }), 'error.session_running');

    // Stop the whole group: each station's time posts to the shared tab and all free up.
    run(operator, 'session.endGroup', { groupId: grp.groupId });
    for (const name of ['PC-01', 'PC-02', 'PC-03']) {
      const st = station(name);
      expect(st.session).toBeNull();
      expect(st.groupId).toBeNull();
      expect(st.tab).toBeNull();
    }
    // 3 PCs × 30 min × 200/h = 300 L of time + 300 L of drinks.
    const finalTab = tabDetail(db, grp.tabId);
    expect(finalTab.totals.chargedMinor).toBe(300 + 300);

    // The unpaid group tab appears in the counter-tabs strip for checkout.
    expect(floorState(db, operator, now).counterTabs.some((t) => t.id === grp.tabId)).toBe(true);

    const res = run<{ closed: boolean }>(operator, 'tab.checkout', { tabId: grp.tabId, method: 'cash', tenders: [{ currency: 'ALL', amountMinor: 600 }] });
    expect(res.closed).toBe(true);
    expect(tabDetail(db, grp.tabId).status).toBe('closed');
  });

  it('moves a live session to another station, keeping its time and tab', () => {
    run(operator, 'shift.open', { openingFloat: {} });
    const from = station('PC-01');
    const { sessionId, tabId } = run<{ sessionId: string; tabId: string }>(operator, 'session.start', { stationId: from.id, mode: 'postpaid' });
    const coke = floorState(db, operator, now).products.find((p) => p.name === 'Coca-Cola')!;
    run(operator, 'tab.addItem', { stationId: from.id, productId: coke.id });
    now += 20 * MIN;

    const to = station('PC-05');
    run(operator, 'session.move', { sessionId, toStationId: to.id });

    // The session, its running clock and its tab are now on PC-05; PC-01 is free.
    expect(station('PC-01').session).toBeNull();
    expect(station('PC-01').tab).toBeNull();
    const moved = station('PC-05');
    expect(moved.session?.id).toBe(sessionId);
    expect(moved.tab?.id).toBe(tabId);
    expect(moved.tab?.chargedMinor).toBe(150); // the Coke followed; time still accruing

    // Ending on the new station bills the whole 20 minutes once, no double charge.
    now += 10 * MIN;
    run(operator, 'session.end', { sessionId });
    const tab = tabDetail(db, tabId);
    const timeLines = tab.lines.filter((l) => l.kind === 'time');
    expect(timeLines).toHaveLength(1);
    expect(tab.totals.chargedMinor).toBe(150 + 100); // 150 drink + 30 min × 200/h = 100
  });

  it('refuses to move onto a busy station', () => {
    run(operator, 'shift.open', { openingFloat: {} });
    const a = run<{ sessionId: string }>(operator, 'session.start', { stationId: station('PC-01').id });
    run(operator, 'session.start', { stationId: station('PC-02').id });
    expectError(() => run(operator, 'session.move', { sessionId: a.sessionId, toStationId: station('PC-02').id }), 'error.station_busy');
  });

  it('refuses to group a busy or missing station', () => {
    run(operator, 'shift.open', { openingFloat: {} });
    const pc1 = station('PC-01');
    run(operator, 'session.start', { stationId: pc1.id });
    expectError(
      () => run(operator, 'session.startGroup', { stationIds: [pc1.id, station('PC-02').id] }),
      'error.station_busy',
    );
  });

  it('splits a bill across several payments and closes only when fully paid', () => {
    run(operator, 'shift.open', { openingFloat: {} });
    // A counter tab with three Cokes = 450 L, to split three ways.
    const { tabId } = run<{ tabId: string }>(operator, 'tab.openCounter', {});
    const coke = floorState(db, operator, now).products.find((p) => p.name === 'Coca-Cola')!;
    run(operator, 'tab.addItem', { tabId, productId: coke.id, qty: 3 });
    expect(tabDetail(db, tabId).totals.balanceMinor).toBe(450);

    // First person pays 150 L: the tab stays open with 300 L left.
    const p1 = run<{ remainingMinor: number; closed: boolean }>(operator, 'tab.checkout', {
      tabId,
      method: 'cash',
      tenders: [{ currency: 'ALL', amountMinor: 150 }],
      applyMinor: 150,
    });
    expect(p1).toMatchObject({ remainingMinor: 300, closed: false });
    expect(tabDetail(db, tabId).status).toBe('open');

    // Second person pays 150 L by card.
    const p2 = run<{ remainingMinor: number; closed: boolean }>(operator, 'tab.checkout', {
      tabId,
      method: 'card',
      tenders: [{ currency: 'ALL', amountMinor: 150 }],
      applyMinor: 150,
    });
    expect(p2).toMatchObject({ remainingMinor: 150, closed: false });

    // Last person settles the rest (no applyMinor): the tab closes.
    const p3 = run<{ remainingMinor: number; closed: boolean }>(operator, 'tab.checkout', { tabId, method: 'cash', tenders: [{ currency: 'ALL', amountMinor: 150 }] });
    expect(p3).toMatchObject({ remainingMinor: 0, closed: true });
    expect(tabDetail(db, tabId).status).toBe('closed');

    // Three separate payments were recorded, summing to the whole bill.
    const paid = db.prepare('SELECT COUNT(*) AS n, SUM(applied_minor) AS total FROM payments WHERE tab_id = ?').get(tabId) as { n: number; total: number };
    expect(paid).toEqual({ n: 3, total: 450 });
  });

  it('treats a marked surplus as tips and reports the rest as over/short', () => {
    run(operator, 'shift.open', { openingFloat: { ALL: 1000 } });
    const report = run<{ tips: { markedMinor: number }; closing: { overShort: Record<string, number> } }>(operator, 'shift.close', {
      counted: { ALL: 1300 },
      tipsMarkedMinor: 200,
    });
    expect(report.tips.markedMinor).toBe(200);
    expect(report.closing.overShort.ALL).toBe(100);
  });
});

describe('reliability guarantees', () => {
  it('ignores a repeated requestId (double tap / network retry)', () => {
    const pc = station('PC-01');
    const coke = floorState(db, operator, now).products[0]!;
    const requestId = randomUUID();
    const a = run(operator, 'tab.addItem', { stationId: pc.id, productId: coke.id }, { requestId });
    const b = run(operator, 'tab.addItem', { stationId: pc.id, productId: coke.id }, { requestId });
    expect(b).toEqual(a);
    expect(tabDetail(db, (a as { tabId: string }).tabId).lines).toHaveLength(1);
  });

  it('refuses edits to money rows at the database level', () => {
    const pc = station('PC-01');
    const coke = floorState(db, operator, now).products[0]!;
    run(operator, 'tab.addItem', { stationId: pc.id, productId: coke.id });
    expect(() => db.prepare('UPDATE ledger SET amount_minor = 0').run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM ledger').run()).toThrow(/append-only/);
  });

  it('never starts two sessions on one station', () => {
    const pc = station('PC-02');
    run(operator, 'session.start', { stationId: pc.id });
    expectError(() => run(operator, 'session.start', { stationId: pc.id }), 'error.station_busy');
  });

  it('will not check out while time is still running', () => {
    run(operator, 'shift.open', {});
    const { tabId } = run<{ tabId: string }>(operator, 'session.start', { stationId: station('PC-04').id });
    expectError(() => run(operator, 'tab.checkout', { tabId, method: 'cash', tenders: [{ currency: 'ALL', amountMinor: 1000 }] }), 'error.session_running');
  });

  it('requires an open shift to take money', () => {
    const coke = floorState(db, operator, now).products[0]!;
    const { tabId } = run<{ tabId: string }>(operator, 'tab.addItem', { stationId: station('PC-05').id, productId: coke.id });
    expectError(() => run(operator, 'tab.checkout', { tabId, method: 'cash', tenders: [{ currency: 'ALL', amountMinor: 1000 }] }), 'error.no_open_shift');
  });
});

describe('corrections and permissions', () => {
  it('lets an operator undo their own item within the window, then needs a manager', () => {
    const coke = floorState(db, operator, now).products[0]!;
    const pc = station('PC-06');
    const first = run<{ entryId: string }>(operator, 'tab.addItem', { stationId: pc.id, productId: coke.id });
    run(operator, 'tab.reverseEntry', { entryId: first.entryId, reason: 'wrong item' });

    const second = run<{ entryId: string; tabId: string }>(operator, 'tab.addItem', { stationId: pc.id, productId: coke.id });
    now += 10 * MIN;
    expectError(() => run(operator, 'tab.reverseEntry', { entryId: second.entryId, reason: 'late' }), 'error.needs_manager');
    expectError(
      () => run(operator, 'tab.reverseEntry', { entryId: second.entryId, reason: 'late' }, { approval: { username: 'admin', password: 'nope' } }),
      'error.approval_failed',
    );
    run(operator, 'tab.reverseEntry', { entryId: second.entryId, reason: 'late' }, { approval: { username: 'admin', password: 'admin123' } });

    const tab = tabDetail(db, second.tabId);
    expect(tab.totals.balanceMinor).toBe(0);
    expect(tab.lines.filter((l) => l.reversesId)).toHaveLength(2);
    const approved = db.prepare("SELECT approved_by FROM audit_log WHERE action = 'ledger.post' AND approved_by IS NOT NULL").get();
    expect(approved).toBeTruthy();
  });

  it('keeps operators out of manager commands', () => {
    expect(() => run(operator, 'admin.product.upsert', { name: 'X', priceMinor: 1 })).toThrow(expect.objectContaining({ code: 'error.forbidden' }));
  });

  it('refunds a paid item from the current drawer', () => {
    run(manager, 'shift.open', { openingFloat: { ALL: 1000 } });
    const coke = floorState(db, manager, now).products[0]!;
    const { tabId, entryId } = run<{ tabId: string; entryId: string }>(manager, 'tab.addItem', { stationId: station('PC-07').id, productId: coke.id });
    run(manager, 'tab.checkout', { tabId, method: 'cash', tenders: [{ currency: 'ALL', amountMinor: 150 }] });
    run(manager, 'tab.refundEntry', { entryId, reason: 'flat drink' });
    expect(currentShift(db, manager)!.expectedCash).toEqual({ ALL: 1000 });
    expect(tabDetail(db, tabId).totals).toEqual({ chargedMinor: 0, paidMinor: 0, balanceMinor: 0 });
  });
});

describe('consoles and groups', () => {
  it('charges each player-count segment at its own rate', () => {
    const ps = station('PS5-1');
    const { sessionId, tabId } = run<{ sessionId: string; tabId: string }>(operator, 'session.start', { stationId: ps.id, players: 2 });
    now += 30 * MIN; // 2P: 200
    run(operator, 'session.setPlayers', { sessionId, players: 4 });
    now += 30 * MIN; // 4P: 300
    run(operator, 'session.pause', { sessionId });
    now += 20 * MIN; // paused: free
    run(operator, 'session.resume', { sessionId });
    now += 15 * MIN; // 4P: 150
    const { chargedMinor } = run<{ chargedMinor: number }>(operator, 'session.end', { sessionId });
    expect(chargedMinor).toBe(650);
    expect(tabDetail(db, tabId).totals.balanceMinor).toBe(650);
  });

  it('merges a tab into another line by line', () => {
    const coke = floorState(db, operator, now).products.find((p) => p.name === 'Coca-Cola')!;
    const a = run<{ tabId: string }>(operator, 'tab.addItem', { stationId: station('PC-08').id, productId: coke.id, qty: 2 });
    const b = run<{ tabId: string }>(operator, 'tab.addItem', { stationId: station('PC-09').id, productId: coke.id });
    run(operator, 'tab.merge', { fromTabId: a.tabId, intoTabId: b.tabId });
    expect(tabDetail(db, b.tabId).totals.balanceMinor).toBe(3 * coke.priceMinor);
    expect(tabDetail(db, b.tabId).lines.filter((l) => l.kind === 'transfer')).toHaveLength(1);
    expect(tabDetail(db, a.tabId).status).toBe('closed');
    expect(tabDetail(db, a.tabId).totals.balanceMinor).toBe(0);
  });
});
