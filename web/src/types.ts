/** Shapes returned by the host API (mirrors host/src/queries.ts). */

export type Role = 'operator' | 'manager';
export type StationKind = 'pc' | 'sim' | 'console' | 'table' | 'other';

export interface Actor {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

export interface Currency {
  code: string;
  symbol: string;
  decimals: number;
  rate: number;
  isBase: boolean;
  enabled: boolean;
  cashDenominations: number[];
}

export type PricePlanConfig =
  | { kind: 'hourly'; rates: Record<string, number>; billingUnitMinutes: number; minimumMinutes: number }
  | { kind: 'per_session'; priceMinor: number };

export interface SessionView {
  id: string;
  tabId: string;
  mode: 'prepaid' | 'postpaid';
  status: 'active' | 'paused';
  planKind: 'hourly' | 'per_session';
  players: number;
  startedAt: number;
  usedMs: number;
  pendingMinor: number;
  endsAt: number | null;
  prepaidMinutes: number | null;
}

export interface StationView {
  id: string;
  name: string;
  kind: StationKind;
  zone: string;
  control: 'agent' | 'manual';
  outOfOrder: boolean;
  plan: { id: string; name: string; config: PricePlanConfig };
  session: SessionView | null;
  tab: { id: string; chargedMinor: number; paidMinor: number; balanceMinor: number; lineCount: number } | null;
  device: {
    id: string;
    hostname: string;
    online: boolean;
    lastSeenAt: number | null;
    ip: string;
    version: string;
    health: HealthSummary | null;
    alerts: string[];
  } | null;
  reserved: { bookingId: string; customerName: string; startsAt: number } | null;
  groupId: string | null;
}

export interface HealthSummary {
  at: number;
  diskFreePct: number | null;
  diskFreeMb: number | null;
  diskTotalMb: number | null;
  diskGameFreePct: number | null;
  memPct: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  uptimeMs: number | null;
  cpuPct: number | null;
  tempC: number | null;
  cpuTempC: number | null;
  gpuTempC: number | null;
}

export type DeviceEventKind = 'unclean_shutdown' | 'client_crash' | 'low_disk' | 'high_temp' | string;

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
    kind: DeviceEventKind;
    detail: Record<string, unknown>;
    acknowledgedAt: number | null;
  }[];
}

export type BookingSource = 'phone' | 'message' | 'instagram' | 'walk_in' | 'other';
export type BookingStatus = 'booked' | 'checked_in' | 'cancelled' | 'no_show' | 'done';

export interface Booking {
  id: string;
  customerName: string;
  phone: string;
  startsAt: number;
  durationMinutes: number;
  notes: string;
  source: BookingSource;
  depositMinor: number;
  status: BookingStatus;
  stations: { id: string; name: string }[];
  overdue?: boolean;
}

export interface ClientRequest {
  id: string;
  kind: 'guest' | 'help' | 'order' | 'extend';
  stationId: string | null;
  stationName: string | null;
  payload: { topic?: string; items?: { productId: string; qty: number }[]; minutes?: number };
  createdAt: number;
}

export interface Settings {
  venueName: string;
  cashRoundingMinor: number;
  operatorFixWindowMinutes: number;
  defaultLanguage: 'en' | 'sq';
  tipSplitRule: 'collector' | 'equal' | 'hours';
  blindCount: boolean;
  reservedHoldMinutes: number;
  noShowGraceMinutes: number;
  pointsPer100: number;
  redeemValueMinor: number;
  diskWarnPct: number;
  tempWarnC: number;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  priceMinor: number;
}

export interface AdminReport {
  from: number;
  to: number;
  revenueMinor: number;
  cashMinor: number;
  cardMinor: number;
  tipMinor: number;
  refundMinor: number;
  paymentCount: number;
  sessionCount: number;
  topProducts: { productId: string; name: string; qty: number; revenueMinor: number }[];
  daily: { day: string; revenueMinor: number }[];
}

export interface AdminData {
  enabled: boolean;
  lastBackupAt: number | null;
  lastBackupReason: string | null;
  integrity: string;
  backups: { name: string; at: number; sizeBytes: number }[];
}

export interface FloorState {
  now: number;
  settings: Settings;
  currencies: Currency[];
  me: Actor;
  shift: { id: string; openedAt: number } | null;
  suggestedFloat: Record<string, number>;
  stations: StationView[];
  counterTabs: { id: string; label: string; openedAt: number; balanceMinor: number; lineCount: number }[];
  products: Product[];
  pendingDevices: { id: string; hostname: string; ip: string; mac: string; createdAt: number }[];
  requests: ClientRequest[];
  bookings: Booking[];
  lowStock: { id: string; name: string; stockQty: number; minQty: number }[];
  pcAlerts: number;
}

export interface Member {
  id: string;
  name: string;
  phone: string;
  code: string | null;
  points: number;
  notes: string;
  active: boolean;
}

export interface MemberDetail extends Member {
  movements: { delta: number; reason: 'earn' | 'redeem' | 'adjust'; note: string | null; createdAt: number; actorName: string | null }[];
  visits: { id: string; openedAt: number; stationName: string | null; chargedMinor: number }[];
}

export interface InventoryData {
  products: { id: string; name: string; category: string; stockQty: number; minQty: number }[];
  lowStock: { id: string; name: string; stockQty: number; minQty: number }[];
  orders: RestockOrder[];
}

export interface RestockOrder {
  id: string;
  status: string;
  notes: string;
  createdAt: number;
  createdBy: string;
  items: { id: string; productId: string; name: string; orderedQty: number; receivedQty: number | null; condition: string }[];
}

export interface TabLine {
  id: string;
  kind: 'time' | 'item' | 'adjustment' | 'rounding' | 'transfer';
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
  lines: TabLine[];
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

export interface AdminLists {
  plans: { id: string; name: string; config: PricePlanConfig; active: boolean }[];
  stations: { id: string; name: string; kind: StationKind; zone: string; control: 'agent' | 'manual'; pricePlanId: string; sort: number; active: boolean }[];
  products: { id: string; name: string; category: string; priceMinor: number; sort: number; active: boolean; trackStock: boolean; stockQty: number; minQty: number }[];
  currencies: Currency[];
  users: { id: string; username: string; displayName: string; role: Role; active: boolean }[];
  settings: Settings;
}

export interface ShiftListItem {
  id: string;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt: number | null;
  userName: string;
}

export interface AuditEntry {
  seq: number;
  at: number;
  action: string;
  entity: string;
  entityId: string | null;
  before: string | null;
  after: string | null;
  actorName: string | null;
  approvedByName: string | null;
}

export interface ShiftSummary {
  shiftId: string;
  openedAt: number;
  closedAt: number | null;
  baseCurrency: string;
  openingFloat: Record<string, number>;
  expectedCash: Record<string, number>;
  salesMinor: number;
  refundsMinor: number;
  collectedCashMinor: number;
  collectedCardMinor: number;
  changeGivenMinor: number;
  tips: { checkoutCashMinor: number; cardMinor: number; markedMinor: number; totalMinor: number };
  paymentsCount: number;
  openTabs: { id: string; stationId: string | null; label: string; balanceMinor: number }[];
  closing?: {
    counted: Record<string, number>;
    overShort: Record<string, number>;
    floatLeft: Record<string, number>;
    dropped: Record<string, number>;
  };
  blind?: boolean;
}
