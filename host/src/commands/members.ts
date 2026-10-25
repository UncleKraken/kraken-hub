import { z } from 'zod';
import { readSettings, tabOrThrow } from '../domain/venue.js';
import { AppError, notFound } from '../errors.js';
import { defineCommand, type CommandContext } from './bus.js';
import { postLedger } from './ledger-helpers.js';

const both = ['operator', 'manager'] as const;

export interface MemberRow {
  id: string;
  name: string;
  phone: string;
  code: string | null;
  points: number;
  notes: string;
  active: number;
}

function memberOrThrow(ctx: CommandContext, id: string): MemberRow {
  const m = ctx.db.prepare('SELECT * FROM members WHERE id = ?').get(id) as MemberRow | undefined;
  if (!m) throw notFound('member');
  return m;
}

/** Records a points change and updates the member's cached total, in the current transaction. */
export function addPoints(ctx: CommandContext, memberId: string, delta: number, reason: 'earn' | 'redeem' | 'adjust', opts: { refId?: string; note?: string } = {}): void {
  if (delta === 0) return;
  ctx.db
    .prepare('INSERT INTO point_movements (id, member_id, delta, reason, ref_id, note, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ctx.id(), memberId, delta, reason, opts.refId ?? null, opts.note ?? null, ctx.actor.id, ctx.now);
  ctx.db.prepare('UPDATE members SET points = points + ? WHERE id = ?').run(delta, memberId);
}

/** Points earned for paying `appliedMinor` toward a tab, by the venue's rate. */
export function pointsForSpend(ctx: CommandContext, appliedMinor: number): number {
  const rate = readSettings(ctx.db).pointsPer100;
  if (rate <= 0 || appliedMinor <= 0) return 0;
  return Math.floor((appliedMinor / 100) * rate);
}

export const createMember = defineCommand({
  type: 'member.create',
  roles: [...both],
  schema: z.object({
    name: z.string().trim().min(1).max(80),
    phone: z.string().trim().max(40).default(''),
    code: z.string().trim().max(32).optional(),
    notes: z.string().trim().max(500).default(''),
  }),
  handler(ctx, p) {
    const code = p.code?.trim() || null;
    if (code && ctx.db.prepare('SELECT 1 FROM members WHERE code = ? COLLATE NOCASE').get(code)) throw new AppError('error.code_taken', 409);
    const id = ctx.id();
    ctx.db
      .prepare('INSERT INTO members (id, name, phone, code, notes, active, created_at, created_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, p.name, p.phone, code, p.notes, ctx.now, ctx.actor.id);
    ctx.audit({ action: 'member.create', entity: 'member', entityId: id, after: { name: p.name, code } });
    return { id };
  },
});

export const updateMember = defineCommand({
  type: 'member.update',
  roles: ['manager'],
  schema: z.object({
    id: z.string(),
    name: z.string().trim().min(1).max(80),
    phone: z.string().trim().max(40).default(''),
    code: z.string().trim().max(32).optional(),
    notes: z.string().trim().max(500).default(''),
    active: z.boolean().default(true),
  }),
  handler(ctx, p) {
    const before = memberOrThrow(ctx, p.id);
    const code = p.code?.trim() || null;
    if (code && ctx.db.prepare('SELECT 1 FROM members WHERE code = ? COLLATE NOCASE AND id <> ?').get(code, p.id)) throw new AppError('error.code_taken', 409);
    ctx.db.prepare('UPDATE members SET name = ?, phone = ?, code = ?, notes = ?, active = ? WHERE id = ?').run(p.name, p.phone, code, p.notes, p.active ? 1 : 0, p.id);
    ctx.audit({ action: 'member.update', entity: 'member', entityId: p.id, before: { name: before.name }, after: { name: p.name, code, active: p.active } });
    return { id: p.id };
  },
});

/** Attaches a member to an open tab (or detaches with memberId null). */
export const setTabMember = defineCommand({
  type: 'tab.setMember',
  roles: [...both],
  schema: z.object({ tabId: z.string(), memberId: z.string().nullable() }),
  handler(ctx, p) {
    const tab = tabOrThrow(ctx.db, p.tabId);
    if (tab.status !== 'open') throw new AppError('error.tab_closed', 409);
    if (p.memberId) {
      const m = memberOrThrow(ctx, p.memberId);
      if (!m.active) throw new AppError('error.member_inactive', 409);
    }
    ctx.db.prepare('UPDATE tabs SET member_id = ? WHERE id = ?').run(p.memberId, p.tabId);
    ctx.audit({ action: 'tab.setMember', entity: 'tab', entityId: p.tabId, after: { memberId: p.memberId } });
    return { ok: true };
  },
});

/** Redeems points on an open tab, posting a discount line and deducting the points. */
export const redeemPoints = defineCommand({
  type: 'member.redeem',
  roles: [...both],
  schema: z.object({ tabId: z.string(), points: z.number().int().min(1) }),
  handler(ctx, p) {
    const tab = tabOrThrow(ctx.db, p.tabId);
    if (tab.status !== 'open') throw new AppError('error.tab_closed', 409);
    if (!tab.member_id) throw new AppError('error.no_member', 409);
    const { redeemValueMinor } = readSettings(ctx.db);
    if (redeemValueMinor <= 0) throw new AppError('error.redeem_off', 409);
    const member = memberOrThrow(ctx, tab.member_id);
    if (member.points < p.points) throw new AppError('error.not_enough_points', 409);

    // Don't let a discount exceed what's currently owed.
    const charged = (ctx.db.prepare('SELECT COALESCE(SUM(amount_minor),0) AS s FROM ledger WHERE tab_id = ?').get(p.tabId) as { s: number }).s;
    const paid = (ctx.db.prepare('SELECT COALESCE(SUM(applied_minor),0) AS s FROM payments WHERE tab_id = ?').get(p.tabId) as { s: number }).s;
    const balance = charged - paid;
    const wanted = p.points * redeemValueMinor;
    const discount = Math.min(wanted, Math.max(0, balance));
    if (discount <= 0) throw new AppError('error.nothing_to_pay', 409);
    const usedPoints = Math.ceil(discount / redeemValueMinor);

    postLedger(ctx, { tabId: p.tabId, kind: 'adjustment', description: `Points redeemed (${usedPoints})`, unitMinor: -discount, amountMinor: -discount });
    addPoints(ctx, member.id, -usedPoints, 'redeem', { refId: p.tabId });
    ctx.audit({ action: 'member.redeem', entity: 'member', entityId: member.id, after: { points: usedPoints, discountMinor: discount, tabId: p.tabId } });
    return { usedPoints, discountMinor: discount };
  },
});

export const adjustPoints = defineCommand({
  type: 'member.adjustPoints',
  roles: ['manager'],
  schema: z.object({ id: z.string(), delta: z.number().int(), note: z.string().trim().max(120).default('') }),
  handler(ctx, p) {
    const m = memberOrThrow(ctx, p.id);
    if (m.points + p.delta < 0) throw new AppError('error.not_enough_points', 409);
    addPoints(ctx, m.id, p.delta, 'adjust', { note: p.note });
    ctx.audit({ action: 'member.adjustPoints', entity: 'member', entityId: m.id, after: { delta: p.delta, note: p.note } });
    return { points: m.points + p.delta };
  },
});

export const memberCommands = [createMember, updateMember, setTabMember, redeemPoints, adjustPoints];
