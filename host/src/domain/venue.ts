import type { DB } from '../db/index.js';
import { getSetting } from '../db/index.js';
import { AppError, notFound } from '../errors.js';
import type { CurrencyInfo } from './money.js';
import { PricePlanConfig, priceTime, type Segment } from './pricing.js';

export interface CurrencyRow extends CurrencyInfo {
  symbol: string;
  isBase: boolean;
  enabled: boolean;
  cashDenominations: number[];
  sort: number;
}

export function listCurrencies(db: DB): CurrencyRow[] {
  const rows = db
    .prepare('SELECT code, symbol, decimals, rate, is_base, enabled, cash_denominations, sort FROM currencies ORDER BY is_base DESC, sort, code')
    .all() as { code: string; symbol: string; decimals: number; rate: number; is_base: number; enabled: number; cash_denominations: string; sort: number }[];
  return rows.map((r) => ({
    code: r.code,
    symbol: r.symbol,
    decimals: r.decimals,
    rate: r.is_base ? 1 : r.rate,
    isBase: !!r.is_base,
    enabled: !!r.enabled,
    cashDenominations: JSON.parse(r.cash_denominations) as number[],
    sort: r.sort,
  }));
}

export function baseCurrency(db: DB): CurrencyRow {
  const base = listCurrencies(db).find((c) => c.isBase);
  if (!base) throw new AppError('error.no_base_currency', 500);
  return base;
}

export function currencyOrThrow(db: DB, code: string): CurrencyRow {
  const c = listCurrencies(db).find((x) => x.code === code && x.enabled);
  if (!c) throw new AppError('error.currency_not_accepted', 400, { code });
  return c;
}

export interface VenueSettings {
  venueName: string;
  /** Totals and change round to this many base minor units at cash checkout (e.g. 1000 = 10 L). */
  cashRoundingMinor: number;
  /** Minutes an operator may remove their own item without manager approval. */
  operatorFixWindowMinutes: number;
  defaultLanguage: string;
  /** How shared-shift tips are split: collector | equal | hours. */
  tipSplitRule: 'collector' | 'equal' | 'hours';
  blindCount: boolean;
  /** A station shows "Reserved" this many minutes before a booking starts. */
  reservedHoldMinutes: number;
  /** Minutes after a booking's start before it counts as a no-show. */
  noShowGraceMinutes: number;
  /** Points a member earns per 100 base minor units they pay. 0 turns earning off. */
  pointsPer100: number;
  /** Base minor units each point is worth when redeemed. 0 turns redemption off. */
  redeemValueMinor: number;
  /** A PC's free disk at or below this percent raises a low-disk alert. */
  diskWarnPct: number;
  /** A PC reporting a CPU/GPU temperature at or above this (°C) raises a hot-PC alert. */
  tempWarnC: number;
}

export function readSettings(db: DB): VenueSettings {
  return {
    venueName: getSetting(db, 'venue_name') ?? 'Kraken Hub',
    cashRoundingMinor: Number(getSetting(db, 'cash_rounding_minor') ?? '1'),
    operatorFixWindowMinutes: Number(getSetting(db, 'operator_fix_window_minutes') ?? '5'),
    defaultLanguage: getSetting(db, 'default_language') ?? 'en',
    tipSplitRule: (getSetting(db, 'tip_split_rule') as VenueSettings['tipSplitRule']) ?? 'collector',
    blindCount: getSetting(db, 'blind_count') === '1',
    reservedHoldMinutes: Number(getSetting(db, 'reserved_hold_minutes') ?? '15'),
    noShowGraceMinutes: Number(getSetting(db, 'no_show_grace_minutes') ?? '15'),
    pointsPer100: Number(getSetting(db, 'points_per_100') ?? '0'),
    redeemValueMinor: Number(getSetting(db, 'redeem_value_minor') ?? '0'),
    diskWarnPct: Number(getSetting(db, 'disk_warn_pct') ?? '10'),
    tempWarnC: Number(getSetting(db, 'temp_warn_c') ?? '85'),
  };
}

export interface ShiftRow {
  id: string;
  user_id: string;
  status: 'open' | 'closed';
  opened_at: number;
  closed_at: number | null;
  opening_float: string;
  counted: string | null;
  float_left: string | null;
  tips_marked_minor: number;
  notes: string;
}

export function openShiftFor(db: DB, userId: string): ShiftRow | undefined {
  return db.prepare("SELECT * FROM shifts WHERE user_id = ? AND status = 'open'").get(userId) as ShiftRow | undefined;
}

export function requireOpenShift(db: DB, userId: string): ShiftRow {
  const s = openShiftFor(db, userId);
  if (!s) throw new AppError('error.no_open_shift', 409);
  return s;
}

export interface TabRow {
  id: string;
  station_id: string | null;
  label: string;
  status: 'open' | 'closed';
  opened_at: number;
  opened_by: string;
  closed_at: number | null;
  closed_by: string | null;
  member_id: string | null;
  group_id: string | null;
}

export function tabOrThrow(db: DB, id: string): TabRow {
  const t = db.prepare('SELECT * FROM tabs WHERE id = ?').get(id) as TabRow | undefined;
  if (!t) throw notFound('tab');
  return t;
}

export function openTabForStation(db: DB, stationId: string): TabRow | undefined {
  return db.prepare("SELECT * FROM tabs WHERE station_id = ? AND status = 'open'").get(stationId) as TabRow | undefined;
}

/** The open group tab a station is part of, via its live session. Undefined once its session ends. */
export function groupTabForStation(db: DB, stationId: string): TabRow | undefined {
  return db
    .prepare(
      `SELECT t.* FROM tabs t JOIN sessions s ON s.tab_id = t.id
       WHERE s.station_id = ? AND s.status <> 'ended' AND t.status = 'open' AND t.group_id IS NOT NULL LIMIT 1`,
    )
    .get(stationId) as TabRow | undefined;
}

/** The tab shown for a station: its own open tab, or the group tab it's currently part of. */
export function tabForStation(db: DB, stationId: string): TabRow | undefined {
  return openTabForStation(db, stationId) ?? groupTabForStation(db, stationId);
}

/** Charged (ledger), paid (payments applied) and balance, all in base minor units. */
export function tabTotals(db: DB, tabId: string): { chargedMinor: number; paidMinor: number; balanceMinor: number } {
  const charged = (db.prepare('SELECT COALESCE(SUM(amount_minor), 0) AS s FROM ledger WHERE tab_id = ?').get(tabId) as { s: number }).s;
  const paid = (db.prepare('SELECT COALESCE(SUM(applied_minor), 0) AS s FROM payments WHERE tab_id = ?').get(tabId) as { s: number }).s;
  return { chargedMinor: charged, paidMinor: paid, balanceMinor: charged - paid };
}

export interface StationRow {
  id: string;
  name: string;
  kind: 'pc' | 'sim' | 'console' | 'table' | 'other';
  zone: string;
  control: 'agent' | 'manual';
  price_plan_id: string;
  sort: number;
  out_of_order: number;
  active: number;
  layout: string | null;
}

/** The silhouettes a station can be drawn as on the floor map. */
export const STATION_SHAPES = ['desk', 'seat', 'sofa', 'round', 'rect', 'counter', 'plain'] as const;
export type StationShape = (typeof STATION_SHAPES)[number];

/** Where and how a station sits on the floor map. Coordinates are in design units (see FLOOR_CANVAS). */
export interface StationLayout {
  x: number;
  y: number;
  shape: StationShape;
  /** Optional size override in design units; the client falls back to a per-shape default. */
  w?: number;
  h?: number;
}

/** A labelled, purely-cosmetic region behind the stations (a room, the bar, "VIP corner"). */
export interface FloorArea {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** One of a small named palette; the client maps it to a colour. */
  color?: string;
}

/** The design-unit canvas the floor map is laid out on; the client scales it to fit. */
export const FLOOR_CANVAS = { w: 1000, h: 680 } as const;

export interface FloorPlan {
  w: number;
  h: number;
  areas: FloorArea[];
}

/** Décor areas + canvas size for the map, from the 'floor_plan' setting. Stations carry their own layout. */
export function readFloorPlan(db: DB): FloorPlan {
  const raw = getSetting(db, 'floor_plan');
  if (!raw) return { w: FLOOR_CANVAS.w, h: FLOOR_CANVAS.h, areas: [] };
  try {
    const p = JSON.parse(raw) as Partial<FloorPlan>;
    return {
      w: typeof p.w === 'number' && p.w > 0 ? p.w : FLOOR_CANVAS.w,
      h: typeof p.h === 'number' && p.h > 0 ? p.h : FLOOR_CANVAS.h,
      areas: Array.isArray(p.areas) ? p.areas : [],
    };
  } catch {
    return { w: FLOOR_CANVAS.w, h: FLOOR_CANVAS.h, areas: [] };
  }
}

/** Parse a station's stored layout JSON, or null if unplaced / unreadable. */
export function parseLayout(raw: string | null): StationLayout | null {
  if (!raw) return null;
  try {
    const l = JSON.parse(raw) as Partial<StationLayout>;
    if (typeof l.x !== 'number' || typeof l.y !== 'number') return null;
    const shape = (STATION_SHAPES as readonly string[]).includes(l.shape as string) ? (l.shape as StationShape) : 'plain';
    return { x: l.x, y: l.y, shape, ...(typeof l.w === 'number' ? { w: l.w } : {}), ...(typeof l.h === 'number' ? { h: l.h } : {}) };
  } catch {
    return null;
  }
}

export function stationOrThrow(db: DB, id: string): StationRow {
  const s = db.prepare('SELECT * FROM stations WHERE id = ?').get(id) as StationRow | undefined;
  if (!s || !s.active) throw notFound('station');
  return s;
}

export function planForStation(db: DB, station: StationRow): { id: string; name: string; config: PricePlanConfig } {
  const row = db.prepare('SELECT id, name, config FROM price_plans WHERE id = ?').get(station.price_plan_id) as
    | { id: string; name: string; config: string }
    | undefined;
  if (!row) throw notFound('price_plan');
  return { id: row.id, name: row.name, config: PricePlanConfig.parse(JSON.parse(row.config)) };
}

export interface SessionRow {
  id: string;
  tab_id: string;
  station_id: string;
  mode: 'prepaid' | 'postpaid';
  plan: string;
  prepaid_minutes: number | null;
  status: 'active' | 'paused' | 'ended';
  started_at: number;
  started_by: string;
  ended_at: number | null;
  ended_by: string | null;
  end_reason: string | null;
  group_id: string | null;
}

export function sessionOrThrow(db: DB, id: string): SessionRow {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  if (!s) throw notFound('session');
  return s;
}

export function liveSessionForStation(db: DB, stationId: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE station_id = ? AND status <> 'ended'").get(stationId) as SessionRow | undefined;
}

export function segmentsOf(db: DB, sessionId: string): (Segment & { id: string; players: number })[] {
  const rows = db
    .prepare('SELECT id, players, rate_minor_per_hour, started_at, ended_at FROM session_segments WHERE session_id = ? ORDER BY started_at')
    .all(sessionId) as { id: string; players: number; rate_minor_per_hour: number; started_at: number; ended_at: number | null }[];
  return rows.map((r) => ({ id: r.id, players: r.players, rateMinorPerHour: r.rate_minor_per_hour, startedAt: r.started_at, endedAt: r.ended_at }));
}

export interface LiveSessionView {
  id: string;
  tabId: string;
  mode: 'prepaid' | 'postpaid';
  status: 'active' | 'paused';
  planKind: 'hourly' | 'per_session';
  players: number;
  startedAt: number;
  usedMs: number;
  /** Postpaid hourly: what the time would cost if ended now (not yet on the tab). */
  pendingMinor: number;
  /** Prepaid: when time runs out. */
  endsAt: number | null;
  prepaidMinutes: number | null;
}

export function viewSession(db: DB, s: SessionRow, now: number): LiveSessionView {
  const plan = PricePlanConfig.parse(JSON.parse(s.plan));
  const segs = segmentsOf(db, s.id);
  const last = segs[segs.length - 1];
  let usedMs = 0;
  for (const seg of segs) usedMs += Math.max(0, (seg.endedAt ?? now) - seg.startedAt);
  let pendingMinor = 0;
  if (plan.kind === 'hourly' && s.mode === 'postpaid') pendingMinor = priceTime(plan, segs, now).amountMinor;
  return {
    id: s.id,
    tabId: s.tab_id,
    mode: s.mode,
    status: s.status === 'paused' ? 'paused' : 'active',
    planKind: plan.kind,
    players: last?.players ?? 1,
    startedAt: s.started_at,
    usedMs,
    pendingMinor,
    endsAt: s.mode === 'prepaid' && s.prepaid_minutes != null ? s.started_at + s.prepaid_minutes * 60_000 : null,
    prepaidMinutes: s.prepaid_minutes,
  };
}
