import type { Actor } from './auth.js';
import { suggestedFloat, summarizeShift, type ShiftSummary } from './commands/shifts.js';
import type { DB } from './db/index.js';
import { summarize, type DeviceEventRow, type DeviceHealthRow, type HealthSummary } from './devices/health.js';
import { deviceOrThrow } from './devices/commands.js';
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
  device: {
    id: string;
    hostname: string;
    online: boolean;
    lastSeenAt: number | null;
    ip: string;
    version: string;
    /** Latest reported PC health, or null if it hasn't reported yet. */
    health: HealthSummary | null;
    /** Distinct kinds of open (unacknowledged) health alerts on this PC. */
    alerts: string[];
  } | null;
  /** The next booking that holds this station soon (within the reserved-hold window), if any. */
  reserved: { bookingId: string; customerName: string; startsAt: number } | null;
}

export interface BookingView {
  id: string;
  customerName: string;
  phone: string;
  startsAt: number;
  durationMinutes: number;
  notes: string;
  source: string;
  depositMinor: number;
  status: 'booked' | 'checked_in' | 'cancelled' | 'no_show' | 'done';
  stations: { id: string; name: string }[];
  /** Past its start time by the no-show grace period but not yet checked in. */
  overdue: boolean;
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
  /** Bookings not yet done: today's and upcoming, newest-start first handled in the UI. */
  bookings: BookingView[];
  /** Tracked products at or below their minimum, so the manager knows to restock. */
  lowStock: { id: string; name: string; stockQty: number; minQty: number }[];
  /** How many customer PCs have an open (unacknowledged) health alert. */
  pcAlerts: number;
}

/** Reads active bookings (booked or checked-in) with their stations, soonest first. */
export function activeBookings(db: DB, now: number, graceMinutes: number): BookingView[] {
  const rows = db
    .prepare("SELECT * FROM bookings WHERE status IN ('booked', 'checked_in') ORDER BY starts_at")
    .all() as {
    id: string;
    customer_name: string;
    phone: string;
    starts_at: number;
    duration_minutes: number;
    notes: string;
    source: string;
    deposit_minor: number;
    status: BookingView['status'];
  }[];
  const stationStmt = db.prepare('SELECT bs.station_id AS id, s.name FROM booking_stations bs JOIN stations s ON s.id = bs.station_id WHERE bs.booking_id = ?');
  return rows.map((b) => ({
    id: b.id,
    customerName: b.customer_name,
    phone: b.phone,
    startsAt: b.starts_at,
    durationMinutes: b.duration_minutes,
    notes: b.notes,
    source: b.source,
    depositMinor: b.deposit_minor,
    status: b.status,
    stations: stationStmt.all(b.id) as { id: string; name: string }[],
    overdue: b.status === 'booked' && b.starts_at + graceMinutes * 60_000 <= now,
  }));
}

function lineCount(db: DB, tabId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE tab_id = ? AND kind IN ('item', 'time', 'adjustment', 'transfer')").get(tabId) as { n: number }).n;
}

export function floorState(db: DB, me: Actor, now: number, online: Set<string> = new Set()): FloorState {
  const healthByDevice = new Map((db.prepare('SELECT * FROM device_health').all() as DeviceHealthRow[]).map((h) => [h.device_id, summarize(h)]));
  const alertsByDevice = new Map<string, string[]>();
  for (const r of db.prepare('SELECT device_id, kind FROM device_events WHERE acknowledged_at IS NULL ORDER BY at').all() as { device_id: string; kind: string }[]) {
    const list = alertsByDevice.get(r.device_id) ?? [];
    if (!list.includes(r.kind)) list.push(r.kind);
    alertsByDevice.set(r.device_id, list);
  }
  const devices = new Map(
    (db.prepare("SELECT id, station_id, hostname, last_seen_at, last_ip, client_version FROM devices WHERE status = 'approved' AND station_id IS NOT NULL").all() as {
      id: string;
      station_id: string;
      hostname: string;
      last_seen_at: number | null;
      last_ip: string;
      client_version: string;
    }[]).map((d) => [
      d.station_id,
      {
        id: d.id,
        hostname: d.hostname,
        online: online.has(d.id),
        lastSeenAt: d.last_seen_at,
        ip: d.last_ip,
        version: d.client_version,
        health: healthByDevice.get(d.id) ?? null,
        alerts: alertsByDevice.get(d.id) ?? [],
      },
    ]),
  );
  const plans = new Map(
    (db.prepare('SELECT id, name, config FROM price_plans').all() as { id: string; name: string; config: string }[]).map((p) => [
      p.id,
      { id: p.id, name: p.name, config: PricePlanConfig.parse(JSON.parse(p.config)) },
    ]),
  );
  const settings = readSettings(db);
  const bookings = activeBookings(db, now, settings.noShowGraceMinutes);
  // Soonest upcoming "booked" booking per station, within the reserved-hold window.
  const holdUntil = now + settings.reservedHoldMinutes * 60_000;
  const reservedByStation = new Map<string, { bookingId: string; customerName: string; startsAt: number }>();
  for (const b of bookings) {
    if (b.status !== 'booked') continue;
    if (b.startsAt > holdUntil) continue; // too far away to hold yet
    for (const st of b.stations) {
      const current = reservedByStation.get(st.id);
      if (!current || b.startsAt < current.startsAt) reservedByStation.set(st.id, { bookingId: b.id, customerName: b.customerName, startsAt: b.startsAt });
    }
  }
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
      reserved: reservedByStation.get(s.id) ?? null,
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
    settings,
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
    bookings,
    lowStock: lowStock(db),
    pcAlerts: [...devices.values()].filter((d) => d.alerts.length > 0).length,
  };
}

export interface DeviceHealthDetail {
  deviceId: string;
  hostname: string;
  online: boolean;
  lastSeenAt: number | null;
  ip: string;
  version: string;
  health: HealthSummary | null;
  events: {
    id: string;
    at: number;
    severity: 'info' | 'warn' | 'crit';
    kind: string;
    detail: Record<string, unknown>;
    acknowledgedAt: number | null;
  }[];
}

/** Full health for one PC: latest snapshot plus its recent events (newest first), for the panel. */
export function deviceHealthDetail(db: DB, deviceId: string, online: Set<string>): DeviceHealthDetail {
  const d = deviceOrThrow(db, deviceId);
  const h = db.prepare('SELECT * FROM device_health WHERE device_id = ?').get(deviceId) as DeviceHealthRow | undefined;
  const events = (db.prepare('SELECT * FROM device_events WHERE device_id = ? ORDER BY at DESC LIMIT 40').all(deviceId) as DeviceEventRow[]).map((e) => ({
    id: e.id,
    at: e.at,
    severity: e.severity,
    kind: e.kind,
    detail: JSON.parse(e.detail) as Record<string, unknown>,
    acknowledgedAt: e.acknowledged_at,
  }));
  return {
    deviceId: d.id,
    hostname: d.hostname,
    online: online.has(d.id),
    lastSeenAt: d.last_seen_at,
    ip: d.last_ip,
    version: d.client_version,
    health: h ? summarize(h) : null,
    events,
  };
}

export interface BusinessReport {
  from: number;
  to: number;
  revenueMinor: number; // net of refunds, base currency
  cashMinor: number;
  cardMinor: number;
  tipMinor: number;
  refundMinor: number; // total refunded (positive number)
  paymentCount: number;
  sessionCount: number;
  topProducts: { productId: string; name: string; qty: number; revenueMinor: number }[];
  daily: { day: string; revenueMinor: number }[];
}

/**
 * A manager's business overview for a time range, from the append-only money tables.
 * Revenue is net (refunds subtract). Days are bucketed in the venue's local time via `tzOffsetMin`
 * (minutes to add to UTC), so a late-night session lands on the right calendar day.
 */
export function businessReport(db: DB, from: number, to: number, tzOffsetMin: number): BusinessReport {
  const off = tzOffsetMin * 60_000;
  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(applied_minor), 0) AS revenue,
         COALESCE(SUM(CASE WHEN method = 'cash' THEN applied_minor ELSE 0 END), 0) AS cash,
         COALESCE(SUM(CASE WHEN method = 'card' THEN applied_minor ELSE 0 END), 0) AS card,
         COALESCE(SUM(tip_minor), 0) AS tip,
         COALESCE(-SUM(CASE WHEN applied_minor < 0 THEN applied_minor ELSE 0 END), 0) AS refund,
         COUNT(*) AS n
       FROM payments WHERE created_at >= ? AND created_at < ?`,
    )
    .get(from, to) as { revenue: number; cash: number; card: number; tip: number; refund: number; n: number };

  const sessionCount = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE started_at >= ? AND started_at < ?').get(from, to) as { n: number }).n;

  const topProducts = db
    .prepare(
      `SELECT l.product_id AS productId, p.name AS name,
              SUM(l.qty) AS qty, SUM(l.amount_minor) AS revenueMinor
       FROM ledger l JOIN products p ON p.id = l.product_id
       WHERE l.kind = 'item' AND l.product_id IS NOT NULL AND l.created_at >= ? AND l.created_at < ?
       GROUP BY l.product_id
       HAVING SUM(l.qty) <> 0
       ORDER BY revenueMinor DESC
       LIMIT 10`,
    )
    .all(from, to) as BusinessReport['topProducts'];

  const daily = (
    db
      .prepare(
        // CAST keeps the bucket an integer day index; without it a bound offset can make the
        // division REAL, splitting one calendar day into several buckets.
        `SELECT CAST((created_at + ?) / 86400000 AS INTEGER) AS dayIdx, SUM(applied_minor) AS rev
         FROM payments WHERE created_at >= ? AND created_at < ?
         GROUP BY dayIdx ORDER BY dayIdx`,
      )
      .all(off, from, to) as { dayIdx: number; rev: number }[]
  ).map((r) => ({ day: new Date(r.dayIdx * 86400000).toISOString().slice(0, 10), revenueMinor: r.rev }));

  return {
    from,
    to,
    revenueMinor: totals.revenue,
    cashMinor: totals.cash,
    cardMinor: totals.card,
    tipMinor: totals.tip,
    refundMinor: totals.refund,
    paymentCount: totals.n,
    sessionCount,
    topProducts,
    daily,
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
  member: { id: string; name: string; points: number } | null;
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
  const member = tab.member_id ? (db.prepare('SELECT id, name, points FROM members WHERE id = ?').get(tab.member_id) as { id: string; name: string; points: number } | undefined) : undefined;
  return {
    id: tab.id,
    stationId: tab.station_id,
    stationName: station?.name ?? null,
    label: tab.label,
    status: tab.status,
    openedAt: tab.opened_at,
    closedAt: tab.closed_at,
    member: member ?? null,
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
    products: (db.prepare('SELECT id, name, category, price_minor, sort, active, track_stock, stock_qty, min_qty FROM products ORDER BY category, sort, name').all() as {
      id: string;
      name: string;
      category: string;
      price_minor: number;
      sort: number;
      active: number;
      track_stock: number;
      stock_qty: number;
      min_qty: number;
    }[]).map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      priceMinor: p.price_minor,
      sort: p.sort,
      active: !!p.active,
      trackStock: !!p.track_stock,
      stockQty: p.stock_qty,
      minQty: p.min_qty,
    })),
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

export interface LowStockItem {
  id: string;
  name: string;
  stockQty: number;
  minQty: number;
}

/** Active tracked products at or below their minimum. */
export function lowStock(db: DB): LowStockItem[] {
  return db
    .prepare('SELECT id, name, stock_qty AS stockQty, min_qty AS minQty FROM products WHERE active = 1 AND track_stock = 1 AND stock_qty <= min_qty ORDER BY (stock_qty - min_qty), name')
    .all() as LowStockItem[];
}

/** Everything the inventory page needs, for operators and managers alike. */
export function inventoryView(db: DB) {
  return {
    products: db
      .prepare('SELECT id, name, category, stock_qty AS stockQty, min_qty AS minQty FROM products WHERE active = 1 AND track_stock = 1 ORDER BY category, sort, name')
      .all() as { id: string; name: string; category: string; stockQty: number; minQty: number }[],
    lowStock: lowStock(db),
    orders: restockOrders(db),
  };
}

export function restockOrders(db: DB) {
  const orders = db.prepare("SELECT * FROM restock_orders WHERE status = 'ordered' ORDER BY created_at").all() as {
    id: string;
    status: string;
    notes: string;
    created_at: number;
    created_by: string;
  }[];
  const itemStmt = db.prepare(
    'SELECT ri.id, ri.product_id AS productId, p.name, ri.ordered_qty AS orderedQty, ri.received_qty AS receivedQty, ri.condition FROM restock_items ri JOIN products p ON p.id = ri.product_id WHERE ri.order_id = ?',
  );
  const who = db.prepare('SELECT display_name AS name FROM users WHERE id = ?');
  return orders.map((o) => ({
    id: o.id,
    status: o.status,
    notes: o.notes,
    createdAt: o.created_at,
    createdBy: (who.get(o.created_by) as { name: string } | undefined)?.name ?? '',
    items: itemStmt.all(o.id) as { id: string; productId: string; name: string; orderedQty: number; receivedQty: number | null; condition: string }[],
  }));
}

export interface MemberView {
  id: string;
  name: string;
  phone: string;
  code: string | null;
  points: number;
  notes: string;
  active: boolean;
}

/** Members matching a search (name, phone or code), or the most recent if the query is blank. */
export function searchMembers(db: DB, query: string, limit = 30): MemberView[] {
  const q = query.trim();
  const rows = q
    ? (db
        .prepare(
          `SELECT id, name, phone, code, points, notes, active FROM members
           WHERE active = 1 AND (name LIKE ? OR phone LIKE ? OR code = ? COLLATE NOCASE) ORDER BY name LIMIT ?`,
        )
        .all(`%${q}%`, `%${q}%`, q, limit) as (Omit<MemberView, 'active'> & { active: number })[])
    : (db.prepare('SELECT id, name, phone, code, points, notes, active FROM members WHERE active = 1 ORDER BY created_at DESC LIMIT ?').all(limit) as (Omit<MemberView, 'active'> & { active: number })[]);
  return rows.map((m) => ({ ...m, active: !!m.active }));
}

export function memberDetail(db: DB, id: string) {
  const m = db.prepare('SELECT id, name, phone, code, points, notes, active FROM members WHERE id = ?').get(id) as (Omit<MemberView, 'active'> & { active: number }) | undefined;
  if (!m) return null;
  const movements = db
    .prepare(
      `SELECT pm.delta, pm.reason, pm.note, pm.created_at AS createdAt, u.display_name AS actorName
       FROM point_movements pm LEFT JOIN users u ON u.id = pm.actor_id WHERE pm.member_id = ? ORDER BY pm.created_at DESC LIMIT 50`,
    )
    .all(id);
  const visits = db
    .prepare(
      `SELECT t.id, t.opened_at AS openedAt, s.name AS stationName,
              (SELECT COALESCE(SUM(amount_minor),0) FROM ledger WHERE tab_id = t.id) AS chargedMinor
       FROM tabs t LEFT JOIN stations s ON s.id = t.station_id
       WHERE t.member_id = ? ORDER BY t.opened_at DESC LIMIT 20`,
    )
    .all(id);
  return { ...m, active: !!m.active, movements, visits };
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
