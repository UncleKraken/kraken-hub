import type { CommandContext } from './bus.js';
import { openShiftFor, type TabRow } from '../domain/venue.js';

export interface LedgerInput {
  tabId: string;
  kind: 'time' | 'item' | 'adjustment' | 'rounding' | 'transfer';
  description: string;
  qty?: number;
  unitMinor: number;
  amountMinor: number;
  productId?: string | null;
  sessionId?: string | null;
  reversesId?: string | null;
  reason?: string | null;
}

/** Appends one ledger line, attributed to the actor and their open shift (sales belong to the shift they happened in). */
export function postLedger(ctx: CommandContext, input: LedgerInput): string {
  const id = ctx.id();
  const shift = openShiftFor(ctx.db, ctx.actor.id);
  ctx.db
    .prepare(
      `INSERT INTO ledger (id, tab_id, kind, description, product_id, session_id, qty, unit_minor, amount_minor, reverses_id, reason, actor_id, shift_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.tabId,
      input.kind,
      input.description,
      input.productId ?? null,
      input.sessionId ?? null,
      input.qty ?? 1,
      input.unitMinor,
      input.amountMinor,
      input.reversesId ?? null,
      input.reason ?? null,
      ctx.actor.id,
      shift?.id ?? null,
      ctx.now,
    );
  ctx.audit({ action: 'ledger.post', entity: 'ledger', entityId: id, after: input });
  return id;
}

/** Opens a tab for a station (or a counter tab when stationId is null). */
export function openTab(ctx: CommandContext, stationId: string | null, label = ''): TabRow {
  const id = ctx.id();
  ctx.db
    .prepare("INSERT INTO tabs (id, station_id, label, status, opened_at, opened_by) VALUES (?, ?, ?, 'open', ?, ?)")
    .run(id, stationId, label, ctx.now, ctx.actor.id);
  ctx.audit({ action: 'tab.open', entity: 'tab', entityId: id, after: { stationId, label } });
  return { id, station_id: stationId, label, status: 'open', opened_at: ctx.now, opened_by: ctx.actor.id, closed_at: null, closed_by: null };
}
