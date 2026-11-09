import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth.js';
import { openDatabase, type DB } from '../db/index.js';
import { tabTotals } from '../domain/venue.js';
import { runSetup } from './admin.js';
import { CommandBus } from './bus.js';
import { memberCommands } from './members.js';
import { tabCommands } from './tabs.js';

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
let db: DB;
let bus: CommandBus;
let manager: Actor;

beforeEach(() => {
  db = openDatabase(':memory:');
  runSetup(db, { venueName: 'Kraken', language: 'en', baseCurrency: { code: 'ALL', symbol: 'L', decimals: 0 }, manager: { username: 'boss', displayName: 'Boss', password: 'secret1' } }, T0);
  bus = new CommandBus(db, () => T0).register(...memberCommands, ...tabCommands);
  manager = db.prepare("SELECT id, username, display_name AS displayName, role FROM users WHERE username = 'boss'").get() as Actor;
});

const run = (type: string, payload: unknown) => bus.execute(manager, { type, requestId: randomUUID(), payload }) as Record<string, unknown>;
const balance = (tabId: string) => tabTotals(db, tabId).balanceMinor;
const tabWith = (amountMinor: number) => {
  const { tabId } = run('tab.openCounter', { label: 'Test' });
  run('tab.addCustom', { tabId, description: 'Charge', amountMinor });
  return tabId as string;
};

describe('member VIP discount', () => {
  it('applies the member percentage as a discount line', () => {
    const { id } = run('member.create', { name: 'VIP Ana', discountPct: 15 });
    const tabId = tabWith(1000);
    run('tab.setMember', { tabId, memberId: id });
    const res = run('member.applyDiscount', { tabId });
    expect(res).toMatchObject({ discountMinor: 150, pct: 15 });
    expect(balance(tabId)).toBe(850);
  });

  it('re-applying reconciles: it reverses the old discount and recomputes on the new total', () => {
    const { id } = run('member.create', { name: 'VIP Ben', discountPct: 15 });
    const tabId = tabWith(1000);
    run('tab.setMember', { tabId, memberId: id });
    run('member.applyDiscount', { tabId }); // -150 -> 850
    run('tab.addCustom', { tabId, description: 'More', amountMinor: 1000 }); // 1850
    const res = run('member.applyDiscount', { tabId }); // reverse +150, then 15% of 2000 = 300
    expect(res).toMatchObject({ discountMinor: 300 });
    expect(balance(tabId)).toBe(1700);
    // Exactly one live discount line remains (old one reversed).
    const live = db
      .prepare("SELECT COUNT(*) AS n FROM ledger l WHERE l.tab_id = ? AND l.description LIKE 'Member discount%' AND l.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM ledger r WHERE r.reverses_id = l.id)")
      .get(tabId) as { n: number };
    expect(live.n).toBe(1);
  });

  it('never discounts more than the balance', () => {
    const { id } = run('member.create', { name: 'VIP Cia', discountPct: 90 });
    const tabId = tabWith(100);
    run('tab.setMember', { tabId, memberId: id });
    const res = run('member.applyDiscount', { tabId });
    expect(res.discountMinor).toBe(90);
    expect(balance(tabId)).toBe(10);
  });

  it('rejects when the tab has no member or the member has no discount', () => {
    const plain = run('member.create', { name: 'No Deal', discountPct: 0 });
    const noMemberTab = tabWith(500);
    expect(() => run('member.applyDiscount', { tabId: noMemberTab })).toThrow(/no_member/);
    run('tab.setMember', { tabId: noMemberTab, memberId: plain.id });
    expect(() => run('member.applyDiscount', { tabId: noMemberTab })).toThrow(/no_member_discount/);
  });
});
