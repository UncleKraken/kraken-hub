import { z } from 'zod';
import { baseCurrency, requireOpenShift, tabOrThrow, tabTotals } from '../domain/venue.js';
import { AppError } from '../errors.js';
import { defineCommand } from './bus.js';
import { postLedger } from './ledger-helpers.js';
import { addPoints, memberOrThrow, pointsForSpend, walletBalance } from './members.js';

const both = ['operator', 'manager'] as const;

/** Stable English prefix on the settlement line a wallet payment posts to a tab. */
export const WALLET_PAY_PREFIX = 'Paid from wallet';

/**
 * Loads prepaid credit onto a member's wallet. Cash top-ups are the café holding the customer's
 * money, so they go into the drawer (a cash movement) but are NOT a sale — revenue is recognised
 * later, when the credit is spent on a tab. Card top-ups never touch the drawer.
 */
export const topUpWallet = defineCommand({
  type: 'member.topup',
  roles: [...both],
  schema: z.object({
    memberId: z.string(),
    amountMinor: z.number().int().positive().max(1_000_000_00),
    method: z.enum(['cash', 'card']),
  }),
  handler(ctx, p) {
    const member = memberOrThrow(ctx, p.memberId);
    const base = baseCurrency(ctx.db);
    const id = ctx.id();
    if (p.method === 'cash') {
      const shift = requireOpenShift(ctx.db, ctx.actor.id);
      ctx.db
        .prepare("INSERT INTO cash_movements (id, shift_id, currency, amount_minor, kind, ref_id, actor_id, created_at) VALUES (?, ?, ?, ?, 'adjustment', ?, ?, ?)")
        .run(ctx.id(), shift.id, base.code, p.amountMinor, id, ctx.actor.id, ctx.now);
    }
    ctx.db
      .prepare("INSERT INTO member_wallet (id, member_id, kind, amount_minor, method, note, actor_id, created_at) VALUES (?, ?, 'topup', ?, ?, '', ?, ?)")
      .run(id, member.id, p.amountMinor, p.method, ctx.actor.id, ctx.now);
    ctx.audit({ action: 'member.topup', entity: 'member', entityId: member.id, after: { amountMinor: p.amountMinor, method: p.method } });
    return { balanceMinor: walletBalance(ctx.db, member.id) };
  },
});

/**
 * Settles part or all of a tab from the attached member's wallet. Posts a non-reversible 'transfer'
 * line on the tab (so the bill drops and the tab can close) and a matching 'spend' on the wallet.
 * The spend is clamped so it never exceeds the balance or what's owed. Points are earned on it, the
 * same as a cash or card payment.
 */
export const payFromWallet = defineCommand({
  type: 'member.payFromWallet',
  roles: [...both],
  schema: z.object({ tabId: z.string(), amountMinor: z.number().int().positive().optional() }),
  handler(ctx, p) {
    const tab = tabOrThrow(ctx.db, p.tabId);
    if (tab.status !== 'open') throw new AppError('error.tab_closed', 409);
    if (!tab.member_id) throw new AppError('error.no_member', 409);
    const member = memberOrThrow(ctx, tab.member_id);

    const owed = tabTotals(ctx.db, tab.id).balanceMinor;
    if (owed <= 0) throw new AppError('error.nothing_to_pay', 409);
    const balance = walletBalance(ctx.db, member.id);
    if (balance <= 0) throw new AppError('error.wallet_empty', 409);
    const spend = Math.min(balance, owed, p.amountMinor ?? owed);
    if (spend <= 0) throw new AppError('error.nothing_to_pay', 409);

    postLedger(ctx, { tabId: tab.id, kind: 'transfer', description: WALLET_PAY_PREFIX, unitMinor: -spend, amountMinor: -spend });
    ctx.db
      .prepare("INSERT INTO member_wallet (id, member_id, kind, amount_minor, tab_id, note, actor_id, created_at) VALUES (?, ?, 'spend', ?, ?, '', ?, ?)")
      .run(ctx.id(), member.id, -spend, tab.id, ctx.actor.id, ctx.now);

    const pointsEarned = pointsForSpend(ctx, spend);
    if (pointsEarned > 0) addPoints(ctx, member.id, pointsEarned, 'earn', { refId: tab.id });

    const after = tabTotals(ctx.db, tab.id);
    const closed = after.balanceMinor === 0;
    if (closed) ctx.db.prepare("UPDATE tabs SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?").run(ctx.now, ctx.actor.id, tab.id);

    ctx.audit({ action: 'member.payFromWallet', entity: 'member', entityId: member.id, after: { tabId: tab.id, spentMinor: spend, closed } });
    return { spentMinor: spend, remainingMinor: after.balanceMinor, walletBalanceMinor: walletBalance(ctx.db, member.id), closed, pointsEarned };
  },
});

/**
 * Manager correction to a wallet balance (append-only, like all money corrections). Balance-only —
 * it does not move drawer cash, so a cash refund is handled separately; this is for fixing a
 * mistaken load or recording a gesture of credit, and the reason is kept in the audit log.
 */
export const adjustWallet = defineCommand({
  type: 'member.walletAdjust',
  roles: ['manager'],
  schema: z.object({
    memberId: z.string(),
    amountMinor: z.number().int().refine((n) => n !== 0, 'nonzero'),
    reason: z.string().trim().min(1).max(120),
  }),
  handler(ctx, p) {
    const member = memberOrThrow(ctx, p.memberId);
    const balance = walletBalance(ctx.db, member.id);
    if (balance + p.amountMinor < 0) throw new AppError('error.wallet_would_go_negative', 409);
    ctx.db
      .prepare("INSERT INTO member_wallet (id, member_id, kind, amount_minor, note, actor_id, created_at) VALUES (?, ?, 'adjust', ?, ?, ?, ?)")
      .run(ctx.id(), member.id, p.amountMinor, p.reason, ctx.actor.id, ctx.now);
    ctx.audit({ action: 'member.walletAdjust', entity: 'member', entityId: member.id, after: { amountMinor: p.amountMinor, reason: p.reason } });
    return { balanceMinor: walletBalance(ctx.db, member.id) };
  },
});

export const walletCommands = [topUpWallet, payFromWallet, adjustWallet];
