import { z } from 'zod';
import type { DB } from '../db/index.js';
import { baseCurrency, listCurrencies, openShiftFor, requireOpenShift, type ShiftRow } from '../domain/venue.js';
import { AppError } from '../errors.js';
import { defineCommand, type CommandContext } from './bus.js';

const both = ['operator', 'manager'] as const;
const Amounts = z.record(z.string().length(3), z.number().int().min(0));
type Amounts = Record<string, number>;

/** What the last closed shift left in the drawer: the next shift's suggested opening float. */
export function suggestedFloat(db: DB): Amounts {
  const row = db.prepare("SELECT float_left FROM shifts WHERE status = 'closed' AND float_left IS NOT NULL ORDER BY closed_at DESC LIMIT 1").get() as
    | { float_left: string }
    | undefined;
  return row ? (JSON.parse(row.float_left) as Amounts) : {};
}

function drawerByCurrency(db: DB, shiftId: string): Amounts {
  const rows = db.prepare('SELECT currency, SUM(amount_minor) AS s FROM cash_movements WHERE shift_id = ? GROUP BY currency').all(shiftId) as {
    currency: string;
    s: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.currency, r.s]));
}

export interface ShiftSummary {
  shiftId: string;
  openedAt: number;
  closedAt: number | null;
  baseCurrency: string;
  openingFloat: Amounts;
  /** Cash that should be in the drawer now, per currency (before tip payouts). */
  expectedCash: Amounts;
  salesMinor: number;
  refundsMinor: number;
  collectedCashMinor: number;
  collectedCardMinor: number;
  changeGivenMinor: number;
  tips: { checkoutCashMinor: number; cardMinor: number; markedMinor: number; totalMinor: number };
  paymentsCount: number;
  openTabs: { id: string; stationId: string | null; label: string; balanceMinor: number }[];
  closing?: {
    counted: Amounts;
    overShort: Amounts;
    floatLeft: Amounts;
    dropped: Amounts;
  };
}

export function summarizeShift(db: DB, shift: ShiftRow): ShiftSummary {
  const base = baseCurrency(db).code;
  const sales = db
    .prepare("SELECT COALESCE(SUM(amount_minor), 0) AS s FROM ledger WHERE shift_id = ? AND kind <> 'transfer' AND reverses_id IS NULL")
    .get(shift.id) as { s: number };
  const reversals = db
    .prepare("SELECT COALESCE(SUM(-amount_minor), 0) AS s FROM ledger WHERE shift_id = ? AND reverses_id IS NOT NULL")
    .get(shift.id) as { s: number };
  const pay = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN method = 'cash' AND applied_minor > 0 THEN applied_minor END), 0) AS cash,
         COALESCE(SUM(CASE WHEN method = 'card' AND applied_minor > 0 THEN applied_minor END), 0) AS card,
         COALESCE(SUM(change_minor), 0) AS change,
         COUNT(*) AS n
       FROM payments WHERE shift_id = ?`,
    )
    .get(shift.id) as { cash: number; card: number; change: number; n: number };
  const tipRows = db.prepare('SELECT source, SUM(base_minor) AS s FROM tips WHERE shift_id = ? GROUP BY source').all(shift.id) as {
    source: string;
    s: number;
  }[];
  const tip = (src: string) => tipRows.find((t) => t.source === src)?.s ?? 0;

  const movements = db
    .prepare(
      "SELECT currency, SUM(amount_minor) AS s FROM cash_movements WHERE shift_id = ? AND kind IN ('float_open', 'tender_in', 'change_out', 'refund_out') GROUP BY currency",
    )
    .all(shift.id) as { currency: string; s: number }[];
  const expectedCash: Amounts = Object.fromEntries(movements.map((m) => [m.currency, m.s]));

  const openTabs = db
    .prepare(
      `SELECT t.id, t.station_id AS stationId, t.label,
         (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger WHERE tab_id = t.id) -
         (SELECT COALESCE(SUM(applied_minor), 0) FROM payments WHERE tab_id = t.id) AS balanceMinor
       FROM tabs t WHERE t.status = 'open' ORDER BY t.opened_at`,
    )
    .all() as ShiftSummary['openTabs'];

  const summary: ShiftSummary = {
    shiftId: shift.id,
    openedAt: shift.opened_at,
    closedAt: shift.closed_at,
    baseCurrency: base,
    openingFloat: JSON.parse(shift.opening_float) as Amounts,
    expectedCash,
    salesMinor: sales.s,
    refundsMinor: reversals.s,
    collectedCashMinor: pay.cash,
    collectedCardMinor: pay.card,
    changeGivenMinor: pay.change,
    tips: {
      checkoutCashMinor: tip('checkout'),
      cardMinor: tip('card'),
      markedMinor: tip('marked'),
      totalMinor: tip('checkout') + tip('card') + tip('marked'),
    },
    paymentsCount: pay.n,
    openTabs,
  };
  if (shift.status === 'closed' && shift.counted && shift.float_left) {
    const counted = JSON.parse(shift.counted) as Amounts;
    const floatLeft = JSON.parse(shift.float_left) as Amounts;
    const overShort: Amounts = Object.fromEntries(Object.keys(counted).map((c) => [c, 0]));
    const dropped: Amounts = Object.fromEntries(Object.keys(counted).map((c) => [c, 0]));
    const rows = db.prepare("SELECT currency, kind, SUM(amount_minor) AS s FROM cash_movements WHERE shift_id = ? AND kind IN ('adjustment', 'drop') GROUP BY currency, kind").all(shift.id) as {
      currency: string;
      kind: string;
      s: number;
    }[];
    for (const r of rows) {
      if (r.kind === 'adjustment') overShort[r.currency] = r.s;
      if (r.kind === 'drop') dropped[r.currency] = -r.s;
    }
    // The booked adjustment is the raw difference; marked tips are not a surplus.
    overShort[base] = (overShort[base] ?? 0) - shift.tips_marked_minor;
    summary.closing = { counted, overShort, floatLeft, dropped };
  }
  return summary;
}

export const openShift = defineCommand({
  type: 'shift.open',
  roles: [...both],
  schema: z.object({ openingFloat: Amounts.default({}) }),
  handler(ctx, p) {
    if (openShiftFor(ctx.db, ctx.actor.id)) throw new AppError('error.shift_already_open', 409);
    const accepted = new Set(listCurrencies(ctx.db).filter((c) => c.enabled).map((c) => c.code));
    for (const code of Object.keys(p.openingFloat)) if (!accepted.has(code)) throw new AppError('error.currency_not_accepted', 400, { code });
    const id = ctx.id();
    ctx.db
      .prepare("INSERT INTO shifts (id, user_id, status, opened_at, opening_float) VALUES (?, ?, 'open', ?, ?)")
      .run(id, ctx.actor.id, ctx.now, JSON.stringify(p.openingFloat));
    const ins = ctx.db.prepare(
      "INSERT INTO cash_movements (id, shift_id, currency, amount_minor, kind, actor_id, created_at) VALUES (?, ?, ?, ?, 'float_open', ?, ?)",
    );
    for (const [code, amount] of Object.entries(p.openingFloat)) if (amount > 0) ins.run(ctx.id(), id, code, amount, ctx.actor.id, ctx.now);
    ctx.audit({ action: 'shift.open', entity: 'shift', entityId: id, after: { openingFloat: p.openingFloat, suggested: suggestedFloat(ctx.db) } });
    return { shiftId: id };
  },
});

/**
 * Closes the actor's shift.
 * `counted` is everything physically in the drawer, tips included (the café's habit:
 * count the cash, then work out tips). All tips are paid out to the operator from the
 * base-currency drawer; `tipsMarkedMinor` claims part of any surplus as extra tips.
 * Whatever is left after tips minus `floatLeft` goes to the office as the drop.
 */
export const closeShift = defineCommand({
  type: 'shift.close',
  roles: [...both],
  schema: z.object({
    counted: Amounts,
    floatLeft: Amounts.default({}),
    tipsMarkedMinor: z.number().int().min(0).default(0),
    notes: z.string().max(500).default(''),
  }),
  handler(ctx, p) {
    const shift = requireOpenShift(ctx.db, ctx.actor.id);
    return closeShiftInternal(ctx, shift, p);
  },
});

function closeShiftInternal(
  ctx: CommandContext,
  shift: ShiftRow,
  p: { counted: Amounts; floatLeft: Amounts; tipsMarkedMinor: number; notes: string },
) {
  const base = baseCurrency(ctx.db).code;
  const before = summarizeShift(ctx.db, shift);
  const expected = drawerByCurrency(ctx.db, shift.id);

  const codes = new Set([...Object.keys(expected), ...Object.keys(p.counted), ...Object.keys(p.floatLeft)]);
  codes.add(base);

  const payout = before.tips.checkoutCashMinor + before.tips.cardMinor + p.tipsMarkedMinor;
  const countedBase = p.counted[base] ?? 0;
  if (payout > countedBase) throw new AppError('error.tips_exceed_cash', 400);

  const ins = ctx.db.prepare('INSERT INTO cash_movements (id, shift_id, currency, amount_minor, kind, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const overShort: Amounts = {};
  const dropped: Amounts = {};
  for (const code of codes) {
    const exp = expected[code] ?? 0;
    const counted = p.counted[code] ?? 0;
    const tipsOut = code === base ? payout : 0;
    const marked = code === base ? p.tipsMarkedMinor : 0;
    // Drawer ledger: expected (float + tenders − change − refunds; cash tips are inside tenders)
    //   + difference (counted − expected) − tip payout − float left − drop = 0.
    // Over/short excludes the part of a surplus the operator marked as tips.
    const difference = counted - exp;
    const afterTips = counted - tipsOut;
    const floatLeft = p.floatLeft[code] ?? 0;
    if (floatLeft > afterTips) throw new AppError('error.float_exceeds_cash', 400, { code });
    const drop = afterTips - floatLeft;
    overShort[code] = difference - marked;
    dropped[code] = drop;
    if (difference) ins.run(ctx.id(), shift.id, code, difference, 'adjustment', ctx.actor.id, ctx.now);
    if (tipsOut) ins.run(ctx.id(), shift.id, code, -tipsOut, 'tip_payout', ctx.actor.id, ctx.now);
    if (drop) ins.run(ctx.id(), shift.id, code, -drop, 'drop', ctx.actor.id, ctx.now);
    if (floatLeft) ins.run(ctx.id(), shift.id, code, -floatLeft, 'float_left', ctx.actor.id, ctx.now);
  }

  if (p.tipsMarkedMinor > 0) {
    ctx.db
      .prepare("INSERT INTO tips (id, shift_id, source, base_minor, actor_id, created_at) VALUES (?, ?, 'marked', ?, ?, ?)")
      .run(ctx.id(), shift.id, p.tipsMarkedMinor, ctx.actor.id, ctx.now);
  }

  ctx.db
    .prepare("UPDATE shifts SET status = 'closed', closed_at = ?, counted = ?, float_left = ?, tips_marked_minor = ?, notes = ? WHERE id = ?")
    .run(ctx.now, JSON.stringify(p.counted), JSON.stringify(p.floatLeft), p.tipsMarkedMinor, p.notes, shift.id);
  ctx.audit({ action: 'shift.close', entity: 'shift', entityId: shift.id, after: { counted: p.counted, floatLeft: p.floatLeft, tipsMarkedMinor: p.tipsMarkedMinor, overShort, dropped } });

  const closed = ctx.db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id) as ShiftRow;
  return summarizeShift(ctx.db, closed);
}

export const shiftCommands = [openShift, closeShift];
