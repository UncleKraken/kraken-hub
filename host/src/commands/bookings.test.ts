import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth.js';
import { adminCommands } from './admin.js';
import { bookingCommands, expireNoShows } from './bookings.js';
import { CommandBus } from './bus.js';
import { sessionCommands } from './sessions.js';
import { shiftCommands } from './shifts.js';
import { tabCommands } from './tabs.js';
import { openDatabase, type DB } from '../db/index.js';
import { activeBookings, floorState, tabDetail } from '../queries.js';
import { seedDemo } from '../seed.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 16, 0, 0);

let db: DB;
let now: number;
let bus: CommandBus;
let manager: Actor;
let operator: Actor;

function actor(username: string): Actor {
  return db.prepare('SELECT id, username, display_name AS displayName, role FROM users WHERE username = ?').get(username) as Actor;
}
function run<T = Record<string, unknown>>(who: Actor, type: string, payload: unknown): T {
  return bus.execute(who, { type, requestId: randomUUID(), payload }) as T;
}
const station = (name: string) => floorState(db, operator, now).stations.find((s) => s.name === name)!;
const expectError = (fn: () => unknown, code: string) => expect(fn).toThrow(expect.objectContaining({ code }));

beforeEach(() => {
  db = openDatabase(':memory:');
  now = T0;
  seedDemo(db, now);
  bus = new CommandBus(db, () => now).register(...sessionCommands, ...tabCommands, ...shiftCommands, ...adminCommands, ...bookingCommands);
  manager = actor('admin');
  operator = actor('operator');
});

describe('bookings', () => {
  it('holds a station only inside the reserved window, then checks the customer in', () => {
    run(operator, 'shift.open', { openingFloat: { ALL: 5000 } });
    const pc = station('PC-05');
    run(manager, 'admin.settings.update', { reservedHoldMinutes: 15, noShowGraceMinutes: 15 });

    // Booking two hours out: not held yet.
    const { id } = run<{ id: string }>(manager, 'booking.create', {
      customerName: 'Besa',
      phone: '069',
      startsAt: now + 120 * MIN,
      durationMinutes: 60,
      stationIds: [pc.id],
    });
    expect(station('PC-05').reserved).toBeNull();

    // Ten minutes before start: now reserved.
    now += 110 * MIN;
    const reserved = station('PC-05').reserved;
    expect(reserved?.customerName).toBe('Besa');

    // Check in: a session starts on the booked PC and the booking is marked checked-in.
    const res = run<{ started: { stationId: string }[]; busy: string[] }>(operator, 'booking.checkIn', { id, mode: 'postpaid' });
    expect(res.started).toHaveLength(1);
    expect(res.busy).toEqual([]);
    expect(station('PC-05').session).not.toBeNull();
    expect(activeBookings(db, now, 15).find((b) => b.id === id)?.status).toBe('checked_in');
  });

  it('checks in the free stations of a group and reports the busy ones', () => {
    run(operator, 'shift.open', {});
    const a = station('PC-06');
    const b = station('PC-07');
    run(operator, 'session.start', { stationId: a.id }); // already busy
    const { id } = run<{ id: string }>(manager, 'booking.create', {
      customerName: 'Group',
      startsAt: now,
      durationMinutes: 120,
      stationIds: [a.id, b.id],
    });
    const res = run<{ started: { stationId: string }[]; busy: string[] }>(operator, 'booking.checkIn', { id });
    expect(res.started.map((s) => s.stationId)).toEqual([b.id]);
    expect(res.busy).toEqual(['PC-06']);
  });

  it('applies a prepaid deposit against the first tab', () => {
    run(operator, 'shift.open', { openingFloat: { ALL: 2000 } });
    const pc = station('PC-08');
    const { id } = run<{ id: string }>(manager, 'booking.create', {
      customerName: 'Deposit',
      startsAt: now,
      durationMinutes: 60,
      stationIds: [pc.id],
      depositMinor: 300,
    });
    const res = run<{ started: { tabId: string }[] }>(operator, 'booking.checkIn', { id, mode: 'prepaid' });
    const tab = tabDetail(db, res.started[0]!.tabId);
    // Prepaid hour at 200/h = 200 charged, 300 deposit paid → 100 credit (balance -100).
    expect(tab.totals.paidMinor).toBe(300);
    expect(tab.totals.balanceMinor).toBe(-100);
  });

  it('auto-marks a no-show after the grace period and frees the hold', () => {
    run(manager, 'admin.settings.update', { noShowGraceMinutes: 15 });
    const pc = station('PC-09');
    const { id } = run<{ id: string }>(manager, 'booking.create', { customerName: 'Late', startsAt: now, durationMinutes: 60, stationIds: [pc.id] });
    now += 10 * MIN;
    expect(expireNoShows(db, now, 15)).toBe(0);
    now += 6 * MIN;
    expect(expireNoShows(db, now, 15)).toBe(1);
    expect(station('PC-09').reserved).toBeNull();
    expectError(() => run(operator, 'booking.checkIn', { id }), 'error.booking_closed');
  });

  it('keeps bookings a manager-only job', () => {
    const pc = station('PC-10');
    expectError(() => run(operator, 'booking.create', { customerName: 'X', startsAt: now, durationMinutes: 60, stationIds: [pc.id] }), 'error.forbidden');
  });

  it('lets the manager move a booking to other stations', () => {
    const a = station('PC-01');
    const b = station('PC-02');
    const { id } = run<{ id: string }>(manager, 'booking.create', { customerName: 'Move', startsAt: now + 30 * MIN, durationMinutes: 60, stationIds: [a.id] });
    run(manager, 'booking.update', { id, customerName: 'Move', startsAt: now + 30 * MIN, durationMinutes: 60, stationIds: [b.id] });
    const booking = activeBookings(db, now, 15).find((x) => x.id === id)!;
    expect(booking.stations.map((s) => s.name)).toEqual(['PC-02']);
  });
});
