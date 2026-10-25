import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth.js';
import { adminCommands } from './admin.js';
import { CommandBus } from './bus.js';
import { memberCommands } from './members.js';
import { sessionCommands } from './sessions.js';
import { shiftCommands } from './shifts.js';
import { tabCommands } from './tabs.js';
import { openDatabase, type DB } from '../db/index.js';
import { floorState, memberDetail, searchMembers, tabDetail } from '../queries.js';
import { seedDemo } from '../seed.js';

let db: DB;
let now: number;
let bus: CommandBus;
let manager: Actor;
let operator: Actor;

function actor(username: string): Actor {
  return db.prepare('SELECT id, username, display_name AS displayName, role FROM users WHERE username = ?').get(username) as Actor;
}
function run<T = Record<string, unknown>>(who: Actor, type: string, payload: unknown): T {
  return bus.execute(who, { type, requestId: randomUUID(), payload }) as T;
}
const station = (name: string) => floorState(db, operator, now).stations.find((s) => s.name === name)!;
const points = (id: string) => (db.prepare('SELECT points FROM members WHERE id = ?').get(id) as { points: number }).points;
const expectError = (fn: () => unknown, code: string) => expect(fn).toThrow(expect.objectContaining({ code }));

beforeEach(() => {
  db = openDatabase(':memory:');
  now = Date.UTC(2026, 10, 1, 16, 0, 0);
  seedDemo(db, now);
  bus = new CommandBus(db, () => now).register(...sessionCommands, ...tabCommands, ...shiftCommands, ...adminCommands, ...memberCommands);
  manager = actor('admin');
  operator = actor('operator');
  run(manager, 'admin.settings.update', { pointsPer100: 1, redeemValueMinor: 5 });
});

describe('members and points', () => {
  it('earns points on what a member pays', () => {
    run(operator, 'shift.open', {});
    const { id } = run<{ id: string }>(operator, 'member.create', { name: 'Ardit', phone: '069', code: 'A100' });
    const coke = floorState(db, operator, now).products.find((p) => p.name === 'Coca-Cola')!; // 150
    const { tabId, entryId } = run<{ tabId: string; entryId: string }>(operator, 'tab.addItem', { stationId: station('PC-01').id, productId: coke.id, qty: 4 });
    expect(entryId).toBeTruthy();
    run(operator, 'tab.setMember', { tabId, memberId: id });
    // 600 L paid → 600/100 * 1 = 6 points.
    const res = run<{ pointsEarned: number }>(operator, 'tab.checkout', { tabId, method: 'cash', tenders: [{ currency: 'ALL', amountMinor: 600 }] });
    expect(res.pointsEarned).toBe(6);
    expect(points(id)).toBe(6);
  });

  it('redeems points as a discount, capped at the balance', () => {
    run(operator, 'shift.open', {});
    const { id } = run<{ id: string }>(operator, 'member.create', { name: 'Besa' });
    run(manager, 'member.adjustPoints', { id, delta: 100, note: 'welcome' });
    const coke = floorState(db, operator, now).products.find((p) => p.name === 'Coca-Cola')!;
    const { tabId } = run<{ tabId: string }>(operator, 'tab.addItem', { stationId: station('PC-02').id, productId: coke.id }); // 150
    run(operator, 'tab.setMember', { tabId, memberId: id });
    // Redeem 50 points × 5 = 250, but only 150 is owed → 30 points used, 150 discount.
    const res = run<{ usedPoints: number; discountMinor: number }>(operator, 'member.redeem', { tabId, points: 50 });
    expect(res.discountMinor).toBe(150);
    expect(res.usedPoints).toBe(30);
    expect(points(id)).toBe(70);
    expect(tabDetail(db, tabId).totals.balanceMinor).toBe(0);
  });

  it('refuses redemption without a member or when turned off', () => {
    run(operator, 'shift.open', {});
    const coke = floorState(db, operator, now).products.find((p) => p.name === 'Coca-Cola')!;
    const { tabId } = run<{ tabId: string }>(operator, 'tab.addItem', { stationId: station('PC-03').id, productId: coke.id });
    expectError(() => run(operator, 'member.redeem', { tabId, points: 1 }), 'error.no_member');
    run(manager, 'admin.settings.update', { redeemValueMinor: 0 });
    const { id } = run<{ id: string }>(operator, 'member.create', { name: 'X' });
    run(operator, 'tab.setMember', { tabId, memberId: id });
    run(manager, 'member.adjustPoints', { id, delta: 10, note: '' });
    expectError(() => run(operator, 'member.redeem', { tabId, points: 1 }), 'error.redeem_off');
  });

  it('searches members and shows their history; movements are append-only', () => {
    const { id } = run<{ id: string }>(operator, 'member.create', { name: 'Driton', phone: '0691234', code: 'D1' });
    expect(searchMembers(db, 'drit').map((m) => m.id)).toContain(id);
    expect(searchMembers(db, 'D1').map((m) => m.id)).toContain(id);
    run(manager, 'member.adjustPoints', { id, delta: 15, note: 'correction' });
    const detail = memberDetail(db, id)!;
    expect(detail.points).toBe(15);
    expect(detail.movements).toHaveLength(1);
    expect(() => db.prepare('UPDATE point_movements SET delta = 0').run()).toThrow(/append-only/);
  });

  it('keeps member edits and point adjustments manager-only', () => {
    const { id } = run<{ id: string }>(operator, 'member.create', { name: 'Y' });
    expectError(() => run(operator, 'member.update', { id, name: 'Z' }), 'error.forbidden');
    expectError(() => run(operator, 'member.adjustPoints', { id, delta: 5 }), 'error.forbidden');
  });

  it('rejects a duplicate member code', () => {
    run(operator, 'member.create', { name: 'A', code: 'DUP' });
    expectError(() => run(operator, 'member.create', { name: 'B', code: 'dup' }), 'error.code_taken');
  });
});
