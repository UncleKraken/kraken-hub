import { z } from 'zod';
import { floorToUnit, roundToUnit, toBase } from '../domain/money.js';
import {
  baseCurrency,
  currencyOrThrow,
  openTabForStation,
  readSettings,
  requireOpenShift,
  stationOrThrow,
  tabOrThrow,
  tabTotals,
  type TabRow,
} from '../domain/venue.js';
import { AppError, notFound } from '../errors.js';
import { defineCommand, type CommandContext } from './bus.js';
import { openTab, postLedger } from './ledger-helpers.js';

const both = ['operator', 'manager'] as const;

function openTabOrThrow(ctx: CommandContext, tabId: string): TabRow {
  const t = tabOrThrow(ctx.db, tabId);
  if (t.status !== 'open') throw new AppError('error.tab_closed', 409);
  return t;
}

function hasLiveSession(ctx: CommandContext, tabId: string): boolean {
  return !!ctx.db.prepare("SELECT 1 FROM sessions WHERE tab_id = ? AND status <> 'ended' LIMIT 1").get(tabId);
}

/** Resolves a tab by id, or the station's open tab (creating one), or a new counter tab. */
function resolveTab(ctx: CommandContext, p: { tabId?: string | undefined; stationId?: string | undefined }): TabRow {
  if (p.tabId) return openTabOrThrow(ctx, p.tabId);
  if (p.stationId) {
    const station = stationOrThrow(ctx.db, p.stationId);
    return openTabForStation(ctx.db, station.id) ?? openTab(ctx, station.id);
  }
  throw new AppError('error.invalid_input', 400, { detail: 'tabId or stationId required' });
}

export const openCounterTab = defineCommand({
  type: 'tab.openCounter',
  roles: [...both],
  schema: z.object({ label: z.string().trim().max(40).default('') }),
  handler(ctx, p) {
    const tab = openTab(ctx, null, p.label);
    return { tabId: tab.id };
  },
});

export const addItem = defineCommand({
  type: 'tab.addItem',
  roles: [...both],
  schema: z.object({
    tabId: z.string().optional(),
    stationId: z.string().optional(),
    productId: z.string(),
    qty: z.number().int().min(1).max(99).default(1),
  }),
  handler(ctx, p) {
    const product = ctx.db.prepare('SELECT id, name, price_minor FROM products WHERE id = ? AND active = 1').get(p.productId) as
      | { id: string; name: string; price_minor: number }
      | undefined;
    if (!product) throw notFound('product');
    const tab = resolveTab(ctx, p);
    const entryId = postLedger(ctx, {
      tabId: tab.id,
      kind: 'item',
      description: product.name,
      qty: p.qty,
      unitMinor: product.price_minor,
      amountMinor: product.price_minor * p.qty,
      productId: product.id,
    });
    return { tabId: tab.id, entryId };
  },
});

export const addCustomCharge = defineCommand({
  type: 'tab.addCustom',
  roles: [...both],
  schema: z.object({
    tabId: z.string().optional(),
    stationId: z.string().optional(),
    description: z.string().trim().min(1).max(80),
    amountMinor: z.number().int().positive(),
  }),
  handler(ctx, p) {
    ctx.requireManager();
    const tab = resolveTab(ctx, p);
    const entryId = postLedger(ctx, { tabId: tab.id, kind: 'adjustment', description: p.description, unitMinor: p.amountMinor, amountMinor: p.amountMinor });
    return { tabId: tab.id, entryId };
  },
});

interface LedgerRow {
  id: string;
  tab_id: string;
  kind: string;
  description: string;
  product_id: string | null;
  session_id: string | null;
  qty: number;
  unit_minor: number;
  amount_minor: number;
  reverses_id: string | null;
  actor_id: string;
  created_at: number;
}

function reversibleEntry(ctx: CommandContext, entryId: string): LedgerRow {
  const e = ctx.db.prepare('SELECT * FROM ledger WHERE id = ?').get(entryId) as LedgerRow | undefined;
  if (!e) throw notFound('entry');
  if (e.reverses_id) throw new AppError('error.cannot_reverse_reversal', 409);
  if (ctx.db.prepare('SELECT 1 FROM ledger WHERE reverses_id = ?').get(e.id)) throw new AppError('error.already_reversed', 409);
  if (e.kind === 'rounding' || e.kind === 'transfer') throw new AppError('error.cannot_reverse_kind', 409);
  return e;
}

/**
 * Removes a line from an open tab by appending a reversing line.
 * Operators may undo their own line within the fix window; anything else needs a manager.
 */
export const reverseEntry = defineCommand({
  type: 'tab.reverseEntry',
  roles: [...both],
  schema: z.object({ entryId: z.string(), reason: z.string().trim().min(1).max(120) }),
  handler(ctx, p) {
    const e = reversibleEntry(ctx, p.entryId);
    const tab = openTabOrThrow(ctx, e.tab_id);
    const { operatorFixWindowMinutes } = readSettings(ctx.db);
    const ownRecent = e.actor_id === ctx.actor.id && ctx.now - e.created_at <= operatorFixWindowMinutes * 60_000;
    if (!ownRecent) ctx.requireManager();
    if (e.session_id && hasLiveSession(ctx, tab.id)) {
      // Allowed (e.g. wrong prepaid amount), but keep it explicit in the audit trail.
      ctx.audit({ action: 'tab.reverseEntry.liveSession', entity: 'ledger', entityId: e.id });
    }
    const id = postLedger(ctx, {
      tabId: tab.id,
      kind: e.kind as 'time' | 'item' | 'adjustment',
      description: e.description,
      qty: -e.qty,
      unitMinor: e.unit_minor,
      amountMinor: -e.amount_minor,
      productId: e.product_id,
      sessionId: e.session_id,
      reversesId: e.id,
      reason: p.reason,
    });
    return { entryId: id };
  },
});

/**
 * Refunds a line on a closed (already paid) tab: appends the reversing line and a
 * negative payment; cash refunds leave the actor's drawer.
 */
export const refundEntry = defineCommand({
  type: 'tab.refundEntry',
  roles: [...both],
  schema: z.object({ entryId: z.string(), reason: z.string().trim().min(1).max(120), method: z.enum(['cash', 'card']).default('cash') }),
  handler(ctx, p) {
    ctx.requireManager();
    const e = reversibleEntry(ctx, p.entryId);
    const tab = tabOrThrow(ctx.db, e.tab_id);
    if (tab.status !== 'closed') throw new AppError('error.refund_open_tab', 409);
    const shift = requireOpenShift(ctx.db, ctx.actor.id);
    const base = baseCurrency(ctx.db);
    postLedger(ctx, {
      tabId: tab.id,
      kind: e.kind as 'time' | 'item' | 'adjustment',
      description: e.description,
      qty: -e.qty,
      unitMinor: e.unit_minor,
      amountMinor: -e.amount_minor,
      productId: e.product_id,
      sessionId: e.session_id,
      reversesId: e.id,
      reason: p.reason,
    });
    const paymentId = ctx.id();
    ctx.db
      .prepare('INSERT INTO payments (id, tab_id, shift_id, method, applied_minor, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(paymentId, tab.id, shift.id, p.method, -e.amount_minor, ctx.actor.id, ctx.now);
    ctx.db
      .prepare('INSERT INTO payment_tenders (id, payment_id, currency, amount_minor, rate, base_minor) VALUES (?, ?, ?, ?, 1, ?)')
      .run(ctx.id(), paymentId, base.code, -e.amount_minor, -e.amount_minor);
    if (p.method === 'cash') {
      ctx.db
        .prepare("INSERT INTO cash_movements (id, shift_id, currency, amount_minor, kind, ref_id, actor_id, created_at) VALUES (?, ?, ?, ?, 'refund_out', ?, ?, ?)")
        .run(ctx.id(), shift.id, base.code, -e.amount_minor, paymentId, ctx.actor.id, ctx.now);
    }
    ctx.audit({ action: 'tab.refund', entity: 'payment', entityId: paymentId, after: { entryId: e.id, amountMinor: e.amount_minor, method: p.method, reason: p.reason } });
    return { paymentId, refundedMinor: e.amount_minor };
  },
});

export const moveTab = defineCommand({
  type: 'tab.move',
  roles: [...both],
  schema: z.object({ tabId: z.string(), toStationId: z.string() }),
  handler(ctx, p) {
    const tab = openTabOrThrow(ctx, p.tabId);
    if (hasLiveSession(ctx, tab.id)) throw new AppError('error.session_running', 409);
    const target = stationOrThrow(ctx.db, p.toStationId);
    if (openTabForStation(ctx.db, target.id)) throw new AppError('error.station_has_tab', 409);
    ctx.db.prepare('UPDATE tabs SET station_id = ? WHERE id = ?').run(target.id, tab.id);
    ctx.audit({ action: 'tab.move', entity: 'tab', entityId: tab.id, before: { stationId: tab.station_id }, after: { stationId: target.id } });
    return { ok: true };
  },
});

/** Moves everything owed on one tab onto another, line by line, and closes the source. */
export const mergeTab = defineCommand({
  type: 'tab.merge',
  roles: [...both],
  schema: z.object({ fromTabId: z.string(), intoTabId: z.string() }),
  handler(ctx, p) {
    if (p.fromTabId === p.intoTabId) throw new AppError('error.invalid_input', 400, { detail: 'same tab' });
    const from = openTabOrThrow(ctx, p.fromTabId);
    const into = openTabOrThrow(ctx, p.intoTabId);
    if (hasLiveSession(ctx, from.id)) throw new AppError('error.session_running', 409);
    if (tabTotals(ctx.db, from.id).paidMinor !== 0) throw new AppError('error.tab_has_payments', 409);

    const fromName = from.station_id ? stationOrThrow(ctx.db, from.station_id).name : from.label || 'Counter';
    const intoName = into.station_id ? stationOrThrow(ctx.db, into.station_id).name : into.label || 'Counter';
    const lines = ctx.db
      .prepare(
        `SELECT l.* FROM ledger l
         WHERE l.tab_id = ? AND l.reverses_id IS NULL AND l.kind <> 'transfer'
           AND NOT EXISTS (SELECT 1 FROM ledger r WHERE r.reverses_id = l.id)
         ORDER BY l.created_at`,
      )
      .all(from.id) as LedgerRow[];
    for (const l of lines) {
      postLedger(ctx, { tabId: into.id, kind: 'transfer', description: `${l.description} (from ${fromName})`, qty: l.qty, unitMinor: l.unit_minor, amountMinor: l.amount_minor, productId: l.product_id });
    }
    const { balanceMinor } = tabTotals(ctx.db, from.id);
    if (balanceMinor !== 0) {
      postLedger(ctx, { tabId: from.id, kind: 'transfer', description: `Moved to ${intoName}`, unitMinor: -balanceMinor, amountMinor: -balanceMinor });
    }
    ctx.db.prepare("UPDATE tabs SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?").run(ctx.now, ctx.actor.id, from.id);
    ctx.audit({ action: 'tab.merge', entity: 'tab', entityId: from.id, after: { intoTabId: into.id, movedMinor: balanceMinor } });
    return { intoTabId: into.id };
  },
});

export const closeTab = defineCommand({
  type: 'tab.close',
  roles: [...both],
  schema: z.object({ tabId: z.string() }),
  handler(ctx, p) {
    const tab = openTabOrThrow(ctx, p.tabId);
    if (hasLiveSession(ctx, tab.id)) throw new AppError('error.session_running', 409);
    if (tabTotals(ctx.db, tab.id).balanceMinor !== 0) throw new AppError('error.tab_not_settled', 409);
    ctx.db.prepare("UPDATE tabs SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?").run(ctx.now, ctx.actor.id, tab.id);
    ctx.audit({ action: 'tab.close', entity: 'tab', entityId: tab.id });
    return { ok: true };
  },
});

/**
 * Takes payment for a tab.
 * - Cash: any accepted currencies, mixed; change is always given in the base currency,
 *   rounded down to the cash rounding unit. Settling the full balance in cash rounds the
 *   total to the rounding unit with a visible 'rounding' line.
 * - Card: base currency only, exact amount (+ tip).
 * - `applyMinor` pays part of the balance (split bills); omit to settle everything.
 */
export const checkout = defineCommand({
  type: 'tab.checkout',
  roles: [...both],
  schema: z.object({
    tabId: z.string(),
    method: z.enum(['cash', 'card']),
    tenders: z.array(z.object({ currency: z.string().length(3), amountMinor: z.number().int().positive() })).min(1).max(5),
    tipMinor: z.number().int().min(0).default(0),
    applyMinor: z.number().int().positive().optional(),
  }),
  handler(ctx, p) {
    const shift = requireOpenShift(ctx.db, ctx.actor.id);
    const tab = openTabOrThrow(ctx, p.tabId);
    if (hasLiveSession(ctx, tab.id)) throw new AppError('error.session_running', 409);
    const base = baseCurrency(ctx.db);
    const { cashRoundingMinor } = readSettings(ctx.db);

    let { balanceMinor } = tabTotals(ctx.db, tab.id);
    if (balanceMinor <= 0) throw new AppError('error.nothing_to_pay', 409);

    const settlingAll = p.applyMinor === undefined || p.applyMinor >= balanceMinor;
    if (settlingAll && p.method === 'cash' && cashRoundingMinor > 1) {
      const rounded = roundToUnit(balanceMinor, cashRoundingMinor);
      if (rounded !== balanceMinor) {
        postLedger(ctx, { tabId: tab.id, kind: 'rounding', description: 'Rounding', unitMinor: rounded - balanceMinor, amountMinor: rounded - balanceMinor });
        balanceMinor = rounded;
      }
    }
    const apply = settlingAll ? balanceMinor : p.applyMinor!;

    const tenders = p.tenders.map((t) => {
      const cur = currencyOrThrow(ctx.db, t.currency);
      if (p.method === 'card' && !cur.isBase) throw new AppError('error.card_base_only', 400);
      return { ...t, rate: cur.rate, baseMinor: toBase(t.amountMinor, cur, base) };
    });
    const tendered = tenders.reduce((s, t) => s + t.baseMinor, 0);

    let changeMinor = 0;
    let appliedMinor = apply;
    if (p.method === 'card') {
      if (tendered !== apply + p.tipMinor) throw new AppError('error.card_amount_mismatch', 400);
    } else {
      if (tendered < apply + p.tipMinor) throw new AppError('error.not_enough_cash', 400, { missingMinor: apply + p.tipMinor - tendered });
      const rawChange = tendered - apply - p.tipMinor;
      changeMinor = floorToUnit(rawChange, cashRoundingMinor);
      const leftover = rawChange - changeMinor;
      if (leftover > 0) {
        // Coins we can't hand back (e.g. after euro conversion) stay as rounding on this tab.
        postLedger(ctx, { tabId: tab.id, kind: 'rounding', description: 'Rounding', unitMinor: leftover, amountMinor: leftover });
        appliedMinor += leftover;
      }
    }

    const paymentId = ctx.id();
    ctx.db
      .prepare('INSERT INTO payments (id, tab_id, shift_id, method, applied_minor, tip_minor, change_minor, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(paymentId, tab.id, shift.id, p.method, appliedMinor, p.tipMinor, changeMinor, ctx.actor.id, ctx.now);
    const insTender = ctx.db.prepare('INSERT INTO payment_tenders (id, payment_id, currency, amount_minor, rate, base_minor) VALUES (?, ?, ?, ?, ?, ?)');
    const insCash = ctx.db.prepare(
      'INSERT INTO cash_movements (id, shift_id, currency, amount_minor, kind, ref_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const t of tenders) {
      insTender.run(ctx.id(), paymentId, t.currency, t.amountMinor, t.rate, t.baseMinor);
      if (p.method === 'cash') insCash.run(ctx.id(), shift.id, t.currency, t.amountMinor, 'tender_in', paymentId, ctx.actor.id, ctx.now);
    }
    if (changeMinor > 0) insCash.run(ctx.id(), shift.id, base.code, -changeMinor, 'change_out', paymentId, ctx.actor.id, ctx.now);
    if (p.tipMinor > 0) {
      ctx.db
        .prepare('INSERT INTO tips (id, shift_id, source, base_minor, payment_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ctx.id(), shift.id, p.method === 'card' ? 'card' : 'checkout', p.tipMinor, paymentId, ctx.actor.id, ctx.now);
    }

    const after = tabTotals(ctx.db, tab.id);
    const closed = after.balanceMinor === 0;
    if (closed) {
      ctx.db.prepare("UPDATE tabs SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?").run(ctx.now, ctx.actor.id, tab.id);
    }
    ctx.audit({
      action: 'tab.checkout',
      entity: 'payment',
      entityId: paymentId,
      after: { tabId: tab.id, method: p.method, tenders: p.tenders, appliedMinor, tipMinor: p.tipMinor, changeMinor, closed },
    });
    return { paymentId, appliedMinor, changeMinor, remainingMinor: after.balanceMinor, closed };
  },
});

export const tabCommands = [openCounterTab, addItem, addCustomCharge, reverseEntry, refundEntry, moveTab, mergeTab, closeTab, checkout];
