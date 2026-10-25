/** Money helpers. All amounts are integer minor units. */

export interface CurrencyInfo {
  code: string;
  decimals: number;
  /** Base major units per 1 major unit of this currency. Base currency has rate 1. */
  rate: number;
}

/**
 * Converts an amount of a foreign currency into base-currency minor units.
 * Rounds half away from zero to the nearest base minor unit.
 */
export function toBase(amountMinor: number, from: CurrencyInfo, base: CurrencyInfo): number {
  if (from.code === base.code) return amountMinor;
  const major = amountMinor / 10 ** from.decimals;
  const baseMajor = major * from.rate;
  return roundHalfAway(baseMajor * 10 ** base.decimals);
}

/** Converts base-currency minor units into another currency's minor units (for display). */
export function fromBase(baseMinor: number, to: CurrencyInfo, base: CurrencyInfo): number {
  if (to.code === base.code) return baseMinor;
  const baseMajor = baseMinor / 10 ** base.decimals;
  return roundHalfAway((baseMajor / to.rate) * 10 ** to.decimals);
}

export function roundHalfAway(x: number): number {
  // Guard against floating noise like 1999.9999999 → 2000.
  const r = Math.round(Math.abs(x) + 1e-9);
  return x < 0 ? -r : r;
}

/** Rounds to the nearest multiple of `unit` (half up). unit <= 1 returns the amount unchanged. */
export function roundToUnit(amountMinor: number, unit: number): number {
  if (unit <= 1) return amountMinor;
  return roundHalfAway(amountMinor / unit) * unit;
}

/** Rounds down to a multiple of `unit` — used for change, so we never hand out more than owed. */
export function floorToUnit(amountMinor: number, unit: number): number {
  if (unit <= 1) return amountMinor;
  return Math.floor(amountMinor / unit) * unit;
}
