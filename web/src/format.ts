import { getLang } from './i18n';
import type { Currency } from './types';

const locale = () => (getLang() === 'sq' ? 'sq-AL' : 'en-GB');

/** "1,250 L" / "€24.50". Symbol position follows common local use: € before, others after. */
export function money(minor: number, cur: Pick<Currency, 'symbol' | 'decimals' | 'code'>): string {
  const major = minor / 10 ** cur.decimals;
  const n = new Intl.NumberFormat(locale(), { minimumFractionDigits: cur.decimals, maximumFractionDigits: cur.decimals }).format(Math.abs(major));
  const sign = minor < 0 ? '−' : '';
  return cur.code === 'EUR' || cur.code === 'USD' || cur.code === 'GBP' ? `${sign}${cur.symbol}${n}` : `${sign}${n} ${cur.symbol}`;
}

/** Parses what an operator typed ("12,50" or "12.50") into minor units. */
export function parseMoney(text: string, decimals: number): number | null {
  const cleaned = text.replace(/\s/g, '').replace(',', '.');
  if (!/^\d*(\.\d*)?$/.test(cleaned) || cleaned === '' || cleaned === '.') return null;
  return Math.round(Number(cleaned) * 10 ** decimals);
}

export function toInput(minor: number, decimals: number): string {
  return decimals === 0 ? String(minor) : (minor / 10 ** decimals).toFixed(decimals);
}

/** 1:05:09 / 47:12 */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function clock(ts: number): string {
  return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
}

export function roundToUnit(minor: number, unit: number): number {
  if (unit <= 1) return minor;
  return Math.round(minor / unit) * unit;
}

export function floorToUnit(minor: number, unit: number): number {
  if (unit <= 1) return minor;
  return Math.floor(minor / unit) * unit;
}

export function toBase(amountMinor: number, from: Currency, base: Currency): number {
  if (from.code === base.code) return amountMinor;
  const x = (amountMinor / 10 ** from.decimals) * from.rate * 10 ** base.decimals;
  return Math.round(Math.abs(x) + 1e-9) * Math.sign(x);
}
