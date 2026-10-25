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
}

export interface Settings {
  venueName: string;
  cashRoundingMinor: number;
  operatorFixWindowMinutes: number;
  defaultLanguage: 'en' | 'sq';
  tipSplitRule: 'collector' | 'equal' | 'hours';
  blindCount: boolean;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  priceMinor: number;
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
