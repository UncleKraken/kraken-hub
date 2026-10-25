import type { Actor } from './auth.js';
import { suggestedFloat, summarizeShift, type ShiftSummary } from './commands/shifts.js';
import type { DB } from './db/index.js';
import { PricePlanConfig } from './domain/pricing.js';
import {
  listCurrencies,
  liveSessionForStation,
  openShiftFor,
  openTabForStation,
  readSettings,
  tabOrThrow,
  tabTotals,
  viewSession,
  type CurrencyRow,
  type LiveSessionView,
  type StationRow,
  type VenueSettings,
} from './domain/venue.js';

export interface StationView {
  id: string;
  name: string;
  kind: StationRow['kind'];
  zone: string;
  control: StationRow['control'];
  outOfOrder: boolean;
  plan: { id: string; name: string; config: PricePlanConfig };
  session: LiveSessionView | null;
  tab: { id: string; chargedMinor: number; paidMinor: number; balanceMinor: number; lineCount: number } | null;
  /** The paired customer PC, for stations controlled by the Kraken Hub client. */
  device: { id: string; hostname: string; online: boolean; lastSeenAt: number | null; ip: string; version: string } | null;
}

export interface ClientRequestView {
  id: string;
  kind: 'guest' | 'help' | 'order' | 'extend';
  stationId: string | null;
  stationName: string | null;
  payload: { topic?: string; items?: { productId: string; qty: number }[]; minutes?: number };
  createdAt: number;
}

export interface FloorState {
  now: number;
  settings: VenueSettings;
  currencies: CurrencyRow[];
  me: Actor;
  shift: { id: string; openedAt: number } | null;
  suggestedFloat: Record<string, number>;
  stations: StationView[];
  counterTabs: { id: string; label: string; openedAt: number; balanceMinor: number; lineCount: number }[];
  products: { id: string; name: string; category: string; priceMinor: number }[];
  /** PCs asking to join, waiting for an operator to approve them. */
  pendingDevices: { id: string; hostname: string; ip: string; mac: string; createdAt: number }[];
  /** Open requests from customer PCs: guest sessions, help, orders, more time. */
  requests: ClientRequestView[];
}

function lineCount(db: DB, tabId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE tab_id = ? AND kind IN ('item', 'time', 'adjustment', 'transfer')").get(tabId) as { n: number }).n;
}

export function floorState(db: DB, me: Actor, now: number, online: Set<string> = new Set()): FloorState {
  const devices = new Map(
    (db.prepare("SELECT id, station_id, hostname, last_seen_at, last_ip, client_version FROM devices WHERE status = 'approved' AND station_id IS NOT NULL").all() as {
      id: string;
      station_id: string;
      hostname: string;
      last_seen_at: number | null;
      last_ip: string;
      client_version: string;
    }[]).map((d) => [d.station_id, { id: d.id, hostname: d.hostname, online: online.has(d.id), lastSeenAt: d.last_seen_at, ip: d.last_ip, version: d.client_version }]),
  );
  const plans = new Map(
    (db.prepare('SELECT id, name, config FROM price_plans').all() as { id: string; name: string; config: string }[]).map((p) => [
      p.id,
      { id: p.id, name: p.name, config: PricePlanConfig.parse(JSON.parse(p.config)) },
    ]),
  );
  const stations = (db.prepare('SELECT * FROM stations WHERE active = 1 ORDER BY sort, name').all() as StationRow[]).map((s): StationView => {
    const session = liveSessionForStation(db, s.id);
    const tab = openTabForStation(db, s.id);
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      zone: s.zone,
      control: s.control,
      outOfOrder: !!s.out_of_order,
      plan: plans.get(s.price_plan_id)!,
      session: session ? viewSession(db, session, now) : null,
      tab: tab ? { id: tab.id, ...tabTotals(db, tab.id), lineCount: lineCount(db, tab.id) } : null,
      device: devices.get(s.id) ?? null,
    };
  });
  const counterTabs = (db.prepare("SELECT id, label, opened_at FROM tabs WHERE status = 'open' AND station_id IS NULL ORDER BY opened_at").all() as {
    id: string;
    label: string;
    opened_at: number;
  }[]).map((t) => ({ id: t.id, label: t.label, openedAt: t.opened_at, balanceMinor: tabTotals(db, t.id).balanceMinor, lineCount: lineCount(db, t.id) }));
  const shift = openShiftFor(db, me.id);
  return {
    now,
    settings: readSettings(db),
    currencies: listCurrencies(db).filter((c) => c.enabled),
    me,
    shift: shift ? { id: shift.id, openedAt: shift.opened_at } : null,
    suggestedFloat: suggestedFloat(db),
    stations,
    counterTabs,
    products: db
      .prepare('SELECT id, name, category, price_minor AS priceMinor FROM products WHERE active = 1 ORDER BY category, sort, name')
      .all() as FloorState['products'],
    pendingDevices: db
      .prepare("SELECT id, hostname, last_ip AS ip, mac, created_at AS createdAt FROM devices WHERE status = 'pending' ORDER BY created_at")
      .all() as FloorState['pendingDevices'],
    requests: (db
      .prepare(
        `SELECT r.id, r.kind, r.station_id AS stationId, s.name AS stationName, r.payload, r.created_at AS createdAt
         FROM client_requests r LEFT JOIN stations s ON s.id = r.station_id
         WHERE r.status = 'pending' ORDER BY r.created_at`,
      )
      .all() as (Omit<ClientRequestView, 'payload'> & { payload: string })[]).map((r) => ({ ...r, payload: JSON.parse(r.payload) as ClientRequestView['payload'] })),
  };
}

export interface TabDetail {
  id: string;
  stationId: string | null;
  stationName: string | null;
  label: string;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt: number | null;
  totals: { chargedMinor: number; paidMinor: number; balanceMinor: number };
  lines: {
    id: string;
    kind: string;
    description: string;
    qty: number;
    unitMinor: number;
    amountMinor: number;
    reversesId: string | null;
    reversed: boolean;
    reason: string | null;
    actorName: string;
    actorId: string;
    createdAt: number;
  }[];
  payments: {
    id: string;
    method: 'cash' | 'card';
    appliedMinor: number;
    tipMinor: number;
    changeMinor: number;
    actorName: string;
    createdAt: number;
    tenders: { currency: string; amountMinor: number }[];
  }[];
}

export function tabDetail(db: DB, tabId: string): TabDetail {
  const tab = tabOrThrow(db, tabId);
  const station = tab.station_id ? (db.prepare('SELECT name FROM stations WHERE id = ?').get(tab.station_id) as { name: string } | undefined) : undefined;
  const lines = db
    .prepare(
      `SELECT l.id, l.kind, l.description, l.qty, l.unit_minor AS unitMinor, l.amount_minor AS amountMinor,
              l.reverses_id AS reversesId, l.reason, u.display_name AS actorName, l.actor_id AS actorId, l.created_at AS createdAt,
              EXISTS (SELECT 1 FROM ledger r WHERE r.reverses_id = l.id) AS reversed
       FROM ledger l JOIN users u ON u.id = l.actor_id
       WHERE l.tab_id = ? ORDER BY l.created_at, l.rowid`,
    )
    .all(tabId) as (Omit<TabDetail['lines'][number], 'reversed'> & { reversed: number })[];
  const payments = db
    .prepare(
      `SELECT p.id, p.method, p.applied_minor AS appliedMinor, p.tip_minor AS tipMinor, p.change_minor AS changeMinor,
              u.display_name AS actorName, p.created_at AS createdAt
       FROM payments p JOIN users u ON u.id = p.actor_id WHERE p.tab_id = ? ORDER BY p.created_at`,
    )
    .all(tabId) as Omit<TabDetail['payments'][number], 'tenders'>[];
  const tenderStmt = db.prepare('SELECT currency, amount_minor AS amountMinor FROM payment_tenders WHERE payment_id = ?');
  return {
    id: tab.id,
    stationId: tab.station_id,
    stationName: station?.name ?? null,
    label: tab.label,
    status: tab.status,
    openedAt: tab.opened_at,
    closedAt: tab.closed_at,
    totals: tabTotals(db, tabId),
    lines: lines.map((l) => ({ ...l, reversed: !!l.reversed })),
    payments: payments.map((p) => ({ ...p, tenders: tenderStmt.all(p.id) as { currency: string; amountMinor: number }[] })),
  };
}

/** The operator's current shift; expected cash is hidden when blind count is on (until closed). */
export function currentShift(db: DB, me: Actor): (ShiftSummary & { blind: boolean }) | null {
  const shift = openShiftFor(db, me.id);
  if (!shift) return null;
  const summary = summarizeShift(db, shift);
  const blind = readSettings(db).blindCount && me.role !== 'manager';
  return { ...summary, expectedCash: blind ? {} : summary.expectedCash, blind };
}

export function adminLists(db: DB) {
  return {
    plans: (db.prepare('SELECT id, name, config, active FROM price_plans ORDER BY name').all() as { id: string; name: string; config: string; active: number }[]).map((p) => ({
      id: p.id,
      name: p.name,
      config: JSON.parse(p.config) as PricePlanConfig,
      active: !!p.active,
    })),
    stations: (db.prepare('SELECT * FROM stations ORDER BY sort, name').all() as StationRow[]).map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      zone: s.zone,
      control: s.control,
      pricePlanId: s.price_plan_id,
      sort: s.sort,
      active: !!s.active,
    })),
    products: (db.prepare('SELECT id, name, category, price_minor, sort, active FROM products ORDER BY category, sort, name').all() as {
      id: string;
      name: string;
      category: string;
      price_minor: number;
      sort: number;
      active: number;
    }[]).map((p) => ({ id: p.id, name: p.name, category: p.category, priceMinor: p.price_minor, sort: p.sort, active: !!p.active })),
    currencies: listCurrencies(db),
    users: (db.prepare("SELECT id, username, display_name, role, active FROM users WHERE id <> 'system-client' ORDER BY role DESC, display_name").all() as {
      id: string;
      username: string;
      display_name: string;
      role: string;
      active: number;
    }[]).map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role, active: !!u.active })),
    settings: readSettings(db),
  };
}

export function auditPage(db: DB, beforeSeq: number | null, limit = 100) {
  return db
    .prepare(
      `SELECT a.seq, a.at, a.action, a.entity, a.entity_id AS entityId, a.before, a.after,
              u.display_name AS actorName, m.display_name AS approvedByName
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN users m ON m.id = a.approved_by
       WHERE (? IS NULL OR a.seq < ?) ORDER BY a.seq DESC LIMIT ?`,
    )
    .all(beforeSeq, beforeSeq, limit);
}
