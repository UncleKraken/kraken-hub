import { z } from 'zod';
import type { DB } from '../db/index.js';
import { liveSessionForStation, stationOrThrow } from '../domain/venue.js';
import { AppError, notFound } from '../errors.js';
import { defineCommand, type CommandContext } from './bus.js';
import { startSession } from './sessions.js';

const both = ['operator', 'manager'] as const;

export interface BookingRow {
  id: string;
  customer_name: string;
  phone: string;
  starts_at: number;
  duration_minutes: number;
  notes: string;
  source: string;
  deposit_minor: number;
  status: 'booked' | 'checked_in' | 'cancelled' | 'no_show' | 'done';
  created_at: number;
  created_by: string;
  checked_in_at: number | null;
  checked_in_by: string | null;
}

function bookingOrThrow(db: DB, id: string): BookingRow {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as BookingRow | undefined;
  if (!b) throw notFound('booking');
  return b;
}

function setStations(ctx: CommandContext, bookingId: string, stationIds: string[]): void {
  ctx.db.prepare('DELETE FROM booking_stations WHERE booking_id = ?').run(bookingId);
  const ins = ctx.db.prepare('INSERT INTO booking_stations (booking_id, station_id) VALUES (?, ?)');
  for (const sid of stationIds) {
    stationOrThrow(ctx.db, sid); // reject unknown/inactive stations
    ins.run(bookingId, sid);
  }
}

function stationsOf(db: DB, bookingId: string): string[] {
  return (db.prepare('SELECT station_id FROM booking_stations WHERE booking_id = ?').all(bookingId) as { station_id: string }[]).map((r) => r.station_id);
}

const BookingInput = z.object({
  customerName: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(40).default(''),
  startsAt: z.number().int().positive(),
  durationMinutes: z.number().int().min(15).max(24 * 60),
  stationIds: z.array(z.string()).min(1).max(40),
  notes: z.string().trim().max(500).default(''),
  source: z.enum(['phone', 'message', 'instagram', 'walk_in', 'other']).default('phone'),
  depositMinor: z.number().int().min(0).default(0),
});

export const createBooking = defineCommand({
  type: 'booking.create',
  roles: ['manager'],
  schema: BookingInput,
  handler(ctx, p) {
    const id = ctx.id();
    ctx.db
      .prepare(
        `INSERT INTO bookings (id, customer_name, phone, starts_at, duration_minutes, notes, source, deposit_minor, status, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)`,
      )
      .run(id, p.customerName, p.phone, p.startsAt, p.durationMinutes, p.notes, p.source, p.depositMinor, ctx.now, ctx.actor.id);
    setStations(ctx, id, p.stationIds);
    ctx.audit({ action: 'booking.create', entity: 'booking', entityId: id, after: { name: p.customerName, startsAt: p.startsAt, stations: p.stationIds } });
    return { id };
  },
});

export const updateBooking = defineCommand({
  type: 'booking.update',
  roles: ['manager'],
  schema: BookingInput.extend({ id: z.string() }),
  handler(ctx, p) {
    const before = bookingOrThrow(ctx.db, p.id);
    if (before.status === 'cancelled' || before.status === 'done') throw new AppError('error.booking_closed', 409);
    ctx.db
      .prepare('UPDATE bookings SET customer_name = ?, phone = ?, starts_at = ?, duration_minutes = ?, notes = ?, source = ?, deposit_minor = ? WHERE id = ?')
      .run(p.customerName, p.phone, p.startsAt, p.durationMinutes, p.notes, p.source, p.depositMinor, p.id);
    setStations(ctx, p.id, p.stationIds);
    ctx.audit({ action: 'booking.update', entity: 'booking', entityId: p.id, before: { startsAt: before.starts_at }, after: { startsAt: p.startsAt, stations: p.stationIds } });
    return { id: p.id };
  },
});

export const cancelBooking = defineCommand({
  type: 'booking.cancel',
  roles: ['manager'],
  schema: z.object({ id: z.string() }),
  handler(ctx, p) {
    const b = bookingOrThrow(ctx.db, p.id);
    if (b.status === 'checked_in' || b.status === 'done') throw new AppError('error.booking_closed', 409);
    ctx.db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(p.id);
    ctx.audit({ action: 'booking.cancel', entity: 'booking', entityId: p.id, after: { name: b.customer_name } });
    return { ok: true };
  },
});

export const markNoShow = defineCommand({
  type: 'booking.noShow',
  roles: [...both],
  schema: z.object({ id: z.string() }),
  handler(ctx, p) {
    const b = bookingOrThrow(ctx.db, p.id);
    if (b.status !== 'booked') throw new AppError('error.booking_closed', 409);
    ctx.db.prepare("UPDATE bookings SET status = 'no_show' WHERE id = ?").run(p.id);
    ctx.audit({ action: 'booking.noShow', entity: 'booking', entityId: p.id, after: { name: b.customer_name } });
    return { ok: true };
  },
});

/**
 * Starts sessions on the booked stations when the customer arrives. Any station already
 * busy is skipped and reported, so the operator can place that person elsewhere.
 * The deposit, if any, is applied against the first started station's tab.
 */
export const checkInBooking = defineCommand({
  type: 'booking.checkIn',
  roles: [...both],
  schema: z.object({
    id: z.string(),
    mode: z.enum(['prepaid', 'postpaid']).default('postpaid'),
    players: z.number().int().min(1).max(16).default(1),
  }),
  handler(ctx, p) {
    const b = bookingOrThrow(ctx.db, p.id);
    if (b.status !== 'booked') throw new AppError('error.booking_closed', 409);
    const stationIds = stationsOf(ctx.db, b.id);
    const started: { stationId: string; sessionId: string; tabId: string }[] = [];
    const busy: string[] = [];
    for (const sid of stationIds) {
      const station = stationOrThrow(ctx.db, sid);
      if (station.out_of_order || liveSessionForStation(ctx.db, sid)) {
        busy.push(station.name);
        continue;
      }
      const prepaidMinutes = p.mode === 'prepaid' ? b.duration_minutes : undefined;
      const res = startSession.handler(ctx, { stationId: sid, mode: p.mode, players: p.players, prepaidMinutes }) as { sessionId: string; tabId: string };
      started.push({ stationId: sid, sessionId: res.sessionId, tabId: res.tabId });
    }
    if (started.length === 0) throw new AppError('error.all_stations_busy', 409);

    if (b.deposit_minor > 0 && started[0]) {
      // The deposit was already paid; it reduces what's owed on the first tab.
      const shift = ctx.db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'open'").get(ctx.actor.id) as { id: string } | undefined;
      if (!shift) throw new AppError('error.no_open_shift', 409);
      const paymentId = ctx.id();
      ctx.db
        .prepare("INSERT INTO payments (id, tab_id, shift_id, method, applied_minor, actor_id, created_at) VALUES (?, ?, ?, 'cash', ?, ?, ?)")
        .run(paymentId, started[0].tabId, shift.id, b.deposit_minor, ctx.actor.id, ctx.now);
      ctx.db
        .prepare("INSERT INTO payment_tenders (id, payment_id, currency, amount_minor, rate, base_minor) SELECT ?, ?, code, ?, 1, ? FROM currencies WHERE is_base = 1")
        .run(ctx.id(), paymentId, b.deposit_minor, b.deposit_minor);
      ctx.audit({ action: 'booking.deposit', entity: 'payment', entityId: paymentId, after: { bookingId: b.id, depositMinor: b.deposit_minor } });
    }

    ctx.db.prepare("UPDATE bookings SET status = 'checked_in', checked_in_at = ?, checked_in_by = ? WHERE id = ?").run(ctx.now, ctx.actor.id, b.id);
    ctx.audit({ action: 'booking.checkIn', entity: 'booking', entityId: b.id, after: { started: started.map((s) => s.stationId), busy } });
    return { started, busy };
  },
});

/**
 * Marks bookings whose start time passed by the grace period as no-shows, so held stations
 * free up. Run by the host ticker. The operator and manager still see it happen on the floor.
 */
export function expireNoShows(db: DB, now: number, graceMinutes: number): number {
  const res = db
    .prepare("UPDATE bookings SET status = 'no_show' WHERE status = 'booked' AND starts_at + ? <= ?")
    .run(graceMinutes * 60_000, now);
  if (res.changes > 0) {
    db.prepare("INSERT INTO audit_log (at, action, entity, after) VALUES (?, 'booking.autoNoShow', 'booking', ?)").run(now, JSON.stringify({ count: res.changes }));
  }
  return res.changes;
}

export const bookingCommands = [createBooking, updateBooking, cancelBooking, markNoShow, checkInBooking];
