import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth.js';
import { openDatabase, type DB } from '../db/index.js';
import { tabTotals } from '../domain/venue.js';
import { businessReport } from '../queries.js';
import { runSetup } from './admin.js';
import { CommandBus } from './bus.js';
import { walletBalance } from './members.js';
import { memberCommands } from './members.js';
import { shiftCommands } from './shifts.js';
import { tabCommands } from './tabs.js';
import { walletCommands } from './wallet.js';

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
let db: DB;
let bus: CommandBus;
let manager: Actor;

beforeEach(() => {
  db = openDatabase(':memory:');
  runSetup(db, { venueName: 'Kraken', language: 'en', baseCurrency: { code: 'ALL', symbol: 'L', decimals: 0 }, manager: { username: 'boss', displayName: 'Boss', password: 'secret1' } }, T0);
  bus = new CommandBus(db, () => T0).register(...memberCommands, ...tabCommands, ...walletCommands, ...shiftCommands);
  manager = db.prepare("SELECT id, username, display_name AS displayName, role FROM users WHERE username = 'boss'").get() as Actor;
  run('shift.open', { openingFloat: {} });
});

const run = (type: string, payload: unknown) => bus.execute(manager, { type, requestId: randomUUID(), payload }) as Record<string, unknown>;
const drawerCash = () => (db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS s FROM cash_movements WHERE currency = 'ALL'").get() as { s: number }).s;
const member = (discountPct = 0) => run('member.create', { name: 'Ana', discountPct }).id as string;
const tabWith = (amountMinor: number, memberId?: string) => {
  const { tabId } = run('tab.openCounter', { label: 'T' });
  run('tab.addCustom', { tabId, description: 'Charge', amountMinor });
  if (memberId) run('tab.setMember', { tabId, memberId });
  return tabId as string;
};

describe('member wallet', () => {
  it('a cash top-up adds credit and puts the cash in the drawer', () => {
    const id = member();
    const res = run('member.topup', { memberId: id, amountMinor: 1000, method: 'cash' });
    expect(res.balanceMinor).toBe(1000);
    expect(walletBalance(db, id)).toBe(1000);
    expect(drawerCash()).toBe(1000);
  });

  it('a card top-up adds credit but never touches the drawer', () => {
    const id = member();
    run('member.topup', { memberId: id, amountMinor: 1000, method: 'card' });
    expect(walletBalance(db, id)).toBe(1000);
    expect(drawerCash()).toBe(0);
  });

  it('paying from the wallet settles the tab and draws the balance down', () => {
    const id = member();
    run('member.topup', { memberId: id, amountMinor: 1000, method: 'cash' });
    const tabId = tabWith(600, id);
    const res = run('member.payFromWallet', { tabId });
    expect(res).toMatchObject({ spentMinor: 600, remainingMinor: 0, walletBalanceMinor: 400, closed: true });
    expect(tabTotals(db, tabId).balanceMinor).toBe(0);
    expect(db.prepare("SELECT status FROM tabs WHERE id = ?").get(tabId)).toMatchObject({ status: 'closed' });
  });

  it('never spends more than the balance; the rest stays owed', () => {
    const id = member();
    run('member.topup', { memberId: id, amountMinor: 500, method: 'cash' });
    const tabId = tabWith(800, id);
    const res = run('member.payFromWallet', { tabId });
    expect(res).toMatchObject({ spentMinor: 500, remainingMinor: 300, walletBalanceMinor: 0, closed: false });
    expect(walletBalance(db, id)).toBe(0);
  });

  it('rejects paying from an empty wallet or a tab with no member', () => {
    const id = member();
    const noMember = tabWith(300);
    expect(() => run('member.payFromWallet', { tabId: noMember })).toThrow(/no_member/);
    const tabId = tabWith(300, id); // member has no credit
    expect(() => run('member.payFromWallet', { tabId })).toThrow(/wallet_empty/);
  });

  it('a manager correction adjusts the balance but cannot drive it negative', () => {
    const id = member();
    run('member.topup', { memberId: id, amountMinor: 1000, method: 'cash' });
    run('member.walletAdjust', { memberId: id, amountMinor: -200, reason: 'loaded too much' });
    expect(walletBalance(db, id)).toBe(800);
    expect(() => run('member.walletAdjust', { memberId: id, amountMinor: -1000, reason: 'oops' })).toThrow(/wallet_would_go_negative/);
  });

  it('the report counts wallet spend as revenue and shows top-ups loaded, not as revenue', () => {
    const id = member();
    run('member.topup', { memberId: id, amountMinor: 1000, method: 'cash' }); // loaded, not revenue
    const tabId = tabWith(600, id);
    run('member.payFromWallet', { tabId }); // 600 revenue via wallet
    const rep = businessReport(db, T0 - 1000, T0 + 86_400_000, 0);
    expect(rep.walletLoadedMinor).toBe(1000);
    expect(rep.walletMinor).toBe(600);
    expect(rep.revenueMinor).toBe(600); // no cash/card payments, only wallet spend
    expect(rep.cashMinor).toBe(0);
  });
});
