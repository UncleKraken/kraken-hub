import { describe, expect, it } from 'vitest';
import { floorToUnit, roundToUnit, toBase, fromBase } from './money.js';
import { pricePrepaid, priceTime, rateFor, type PricePlanConfig } from './pricing.js';

type Hourly = Extract<PricePlanConfig, { kind: 'hourly' }>;
const MIN = 60_000;
const plan = (over: Partial<Hourly> = {}): Hourly => ({ kind: 'hourly', rates: { '1': 200 }, billingUnitMinutes: 1, minimumMinutes: 0, ...over });

describe('rateFor', () => {
  const console4 = plan({ rates: { '1': 300, '2': 400, '4': 600 } });
  it('uses the exact player rate', () => expect(rateFor(console4, 2)).toBe(400));
  it('falls back to the highest defined count below', () => expect(rateFor(console4, 3)).toBe(400));
  it('caps at the highest defined count', () => expect(rateFor(console4, 8)).toBe(600));
});

describe('priceTime', () => {
  it('bills per minute', () => {
    const r = priceTime(plan(), [{ startedAt: 0, endedAt: 30 * MIN, rateMinorPerHour: 200 }], 0);
    expect(r.amountMinor).toBe(100);
  });

  it('rounds up to the billing unit with a 5 second grace', () => {
    const p = plan({ billingUnitMinutes: 15, rates: { '1': 400 } });
    expect(priceTime(p, [{ startedAt: 0, endedAt: 15 * MIN + 4_000, rateMinorPerHour: 400 }], 0).amountMinor).toBe(100);
    expect(priceTime(p, [{ startedAt: 0, endedAt: 16 * MIN, rateMinorPerHour: 400 }], 0).amountMinor).toBe(200);
  });

  it('applies the minimum', () => {
    const r = priceTime(plan({ minimumMinutes: 15 }), [{ startedAt: 0, endedAt: 3 * MIN, rateMinorPerHour: 200 }], 0);
    expect(r.billedMs).toBe(15 * MIN);
    expect(r.amountMinor).toBe(50);
  });

  it('adds segments at their own rates and skips paused gaps', () => {
    const segs = [
      { startedAt: 0, endedAt: 30 * MIN, rateMinorPerHour: 300 }, // 150
      { startedAt: 40 * MIN, endedAt: 70 * MIN, rateMinorPerHour: 600 }, // 300
    ];
    const r = priceTime(plan(), segs, 0);
    expect(r.usedMs).toBe(60 * MIN);
    expect(r.amountMinor).toBe(450);
  });

  it('prices a running segment up to now', () => {
    expect(priceTime(plan(), [{ startedAt: 0, endedAt: null, rateMinorPerHour: 200 }], 90 * MIN).amountMinor).toBe(300);
  });

  it('prices prepaid blocks', () => {
    expect(pricePrepaid(plan({ rates: { '1': 300, '2': 400 } }), 90, 2)).toBe(600);
  });
});

describe('money', () => {
  const ALL = { code: 'ALL', decimals: 0, rate: 1 };
  const EUR = { code: 'EUR', decimals: 2, rate: 100 };
  it('converts euro cents to lek', () => expect(toBase(2000, EUR, ALL)).toBe(2000));
  it('converts awkward rates with rounding', () => expect(toBase(1999, { ...EUR, rate: 98.5 }, ALL)).toBe(1969));
  it('converts lek to euro cents for display', () => expect(fromBase(2450, EUR, ALL)).toBe(2450));
  it('rounds totals to the cash unit', () => {
    expect(roundToUnit(1845, 10)).toBe(1850);
    expect(roundToUnit(1844, 10)).toBe(1840);
  });
  it('floors change', () => expect(floorToUnit(155, 10)).toBe(150));
});
