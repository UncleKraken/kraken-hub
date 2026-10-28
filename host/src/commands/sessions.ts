import { z } from 'zod';
import type { DB } from '../db/index.js';
import { pricePrepaid, priceTime, PricePlanConfig, rateFor } from '../domain/pricing.js';
import {
  liveSessionForStation,
  openTabForStation,
  planForStation,
  segmentsOf,
  sessionOrThrow,
  stationOrThrow,
  type SessionRow,
} from '../domain/venue.js';
import { AppError } from '../errors.js';
import { clearRecoveryEvent, readRecoveryEvent } from '../recovery.js';
import { defineCommand, type CommandContext } from './bus.js';
import { openTab, postLedger } from './ledger-helpers.js';

const both = ['operator', 'manager'] as const;

function minutesLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

function liveOrThrow(db: DB, id: string): SessionRow {
  const s = sessionOrThrow(db, id);
  if (s.status === 'ended') throw new AppError('error.session_ended', 409);
  return s;
}

function hourlyPlan(s: SessionRow) {
  const plan = PricePlanConfig.parse(JSON.parse(s.plan));
  if (plan.kind !== 'hourly') throw new AppError('error.not_hourly', 409);
  return plan;
}

function closeOpenSegment(ctx: CommandContext, sessionId: string): void {
  ctx.db.prepare('UPDATE session_segments SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL').run(ctx.now, sessionId);
}

function openSegment(ctx: CommandContext, sessionId: string, players: number, rate: number): void {
  ctx.db
    .prepare('INSERT INTO session_segments (id, session_id, players, rate_minor_per_hour, started_at) VALUES (?, ?, ?, ?, ?)')
    .run(ctx.id(), sessionId, players, rate, ctx.now);
}

/**
 * Creates one session on `station` posting to `tab`, with its opening segment and any up-front
 * time charge (per-session price or prepaid block). Shared by single and group starts; `groupId`
 * ties a session to its group (null for a normal single session). Caller validates the station.
 */
function createSession(
  ctx: CommandContext,
  station: ReturnType<typeof stationOrThrow>,
  tabId: string,
  opts: { mode: 'prepaid' | 'postpaid'; players: number; prepaidMinutes?: number },
  groupId: string | null,
): string {
  const plan = planForStation(ctx.db, station);
  let mode = opts.mode;
  if (plan.config.kind === 'per_session') mode = 'postpaid';
  if (mode === 'prepaid' && !opts.prepaidMinutes) throw new AppError('error.prepaid_needs_minutes', 400);

  const sessionId = ctx.id();
  ctx.db
    .prepare(
      `INSERT INTO sessions (id, tab_id, station_id, mode, plan, prepaid_minutes, status, started_at, started_by, group_id)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .run(sessionId, tabId, station.id, mode, JSON.stringify(plan.config), mode === 'prepaid' ? opts.prepaidMinutes! : null, ctx.now, ctx.actor.id, groupId);

  const rate = plan.config.kind === 'hourly' ? rateFor(plan.config, opts.players) : 0;
  openSegment(ctx, sessionId, opts.players, rate);

  const playersTag = opts.players > 1 ? ` · ${opts.players}P` : '';
  if (plan.config.kind === 'per_session') {
    postLedger(ctx, { tabId, kind: 'time', description: `${station.name} · ${plan.name}${playersTag}`, unitMinor: plan.config.priceMinor, amountMinor: plan.config.priceMinor, sessionId });
  } else if (mode === 'prepaid') {
    const amount = pricePrepaid(plan.config, opts.prepaidMinutes!, opts.players);
    postLedger(ctx, { tabId, kind: 'time', description: `${station.name} · ${minutesLabel(opts.prepaidMinutes!)} prepaid${playersTag}`, unitMinor: amount, amountMinor: amount, sessionId });
  }

  ctx.audit({ action: 'session.start', entity: 'session', entityId: sessionId, after: { stationId: station.id, mode, players: opts.players, prepaidMinutes: opts.prepaidMinutes ?? null, groupId } });
  return sessionId;
}

export const startSession = defineCommand({
  type: 'session.start',
  roles: [...both],
  schema: z.object({
    stationId: z.string(),
    mode: z.enum(['prepaid', 'postpaid']).default('postpaid'),
    players: z.number().int().min(1).max(16).default(1),
    prepaidMinutes: z.number().int().min(1).max(24 * 60).optional(),
  }),
  handler(ctx, p) {
    const station = stationOrThrow(ctx.db, p.stationId);
    if (station.out_of_order) throw new AppError('error.station_out_of_order', 409);
    if (liveSessionForStation(ctx.db, station.id)) throw new AppError('error.station_busy', 409);
    const tab = openTabForStation(ctx.db, station.id) ?? openTab(ctx, station.id);
    const sessionId = createSession(ctx, station, tab.id, { mode: p.mode, players: p.players, prepaidMinutes: p.prepaidMinutes }, null);
    return { sessionId, tabId: tab.id };
  },
});

/** Starts several stations on one shared tab (a party on linked PCs). Same plan/mode for all. */
export const startGroup = defineCommand({
  type: 'session.startGroup',
  roles: [...both],
  schema: z.object({
    stationIds: z.array(z.string()).min(2).max(16),
    mode: z.enum(['prepaid', 'postpaid']).default('postpaid'),
    players: z.number().int().min(1).max(16).default(1),
    prepaidMinutes: z.number().int().min(1).max(24 * 60).optional(),
  }),
  handler(ctx, p) {
    const ids = [...new Set(p.stationIds)];
    if (ids.length < 2) throw new AppError('error.invalid_input', 400, { detail: 'need at least 2 stations' });
    const stations = ids.map((id) => stationOrThrow(ctx.db, id));
    for (const s of stations) {
      if (s.out_of_order) throw new AppError('error.station_out_of_order', 409);
      if (liveSessionForStation(ctx.db, s.id)) throw new AppError('error.station_busy', 409);
    }
    const groupId = ctx.id();
    // One shared tab (station_id NULL), labelled with the stations so it reads clearly if it ends
    // up in the counter-tabs strip before being paid.
    const tab = openTab(ctx, null, stations.map((s) => s.name).join(', '), groupId);
    const sessionIds = stations.map((s) => createSession(ctx, s, tab.id, { mode: p.mode, players: p.players, prepaidMinutes: p.prepaidMinutes }, groupId));
    ctx.audit({ action: 'session.startGroup', entity: 'tab', entityId: tab.id, after: { groupId, stations: stations.map((s) => s.name), mode: p.mode, players: p.players } });
    return { groupId, tabId: tab.id, sessionIds };
  },
});

/** Ends every live session in a group at once, posting each station's time to the shared tab. */
export const endGroup = defineCommand({
  type: 'session.endGroup',
  roles: [...both],
  schema: z.object({ groupId: z.string() }),
  handler(ctx, p) {
    const sessions = ctx.db.prepare("SELECT * FROM sessions WHERE group_id = ? AND status <> 'ended'").all(p.groupId) as SessionRow[];
    if (sessions.length === 0) throw new AppError('error.session_ended', 409);
    for (const s of sessions) finishSession(ctx, s, 'operator');
    return { tabId: sessions[0]!.tab_id };
  },
});

export const extendSession = defineCommand({
  type: 'session.extend',
  roles: [...both],
  schema: z.object({ sessionId: z.string(), minutes: z.number().int().min(1).max(24 * 60) }),
  handler(ctx, p) {
    const s = liveOrThrow(ctx.db, p.sessionId);
    if (s.mode !== 'prepaid') throw new AppError('error.not_prepaid', 409);
    const plan = hourlyPlan(s);
    const segs = segmentsOf(ctx.db, s.id);
    const players = segs[segs.length - 1]?.players ?? 1;
    const station = stationOrThrow(ctx.db, s.station_id);
    const amount = pricePrepaid(plan, p.minutes, players);
    postLedger(ctx, {
      tabId: s.tab_id,
      kind: 'time',
      description: `${station.name} · +${minutesLabel(p.minutes)} extension${players > 1 ? ` · ${players}P` : ''}`,
      unitMinor: amount,
      amountMinor: amount,
      sessionId: s.id,
    });
    const before = s.prepaid_minutes;
    ctx.db.prepare('UPDATE sessions SET prepaid_minutes = prepaid_minutes + ? WHERE id = ?').run(p.minutes, s.id);
    ctx.audit({ action: 'session.extend', entity: 'session', entityId: s.id, before: { prepaidMinutes: before }, after: { prepaidMinutes: (before ?? 0) + p.minutes } });
    return { ok: true };
  },
});

export const setPlayers = defineCommand({
  type: 'session.setPlayers',
  roles: [...both],
  schema: z.object({ sessionId: z.string(), players: z.number().int().min(1).max(16) }),
  handler(ctx, p) {
    const s = liveOrThrow(ctx.db, p.sessionId);
    if (s.mode !== 'postpaid') throw new AppError('error.players_prepaid', 409);
    const plan = hourlyPlan(s);
    const segs = segmentsOf(ctx.db, s.id);
    const before = segs[segs.length - 1]?.players ?? 1;
    if (before === p.players) return { ok: true };
    if (s.status === 'active') {
      closeOpenSegment(ctx, s.id);
      openSegment(ctx, s.id, p.players, rateFor(plan, p.players));
    } else {
      // Paused: the new count applies from resume. Record it on a zero-length segment.
      ctx.db
        .prepare('INSERT INTO session_segments (id, session_id, players, rate_minor_per_hour, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ctx.id(), s.id, p.players, rateFor(plan, p.players), ctx.now, ctx.now);
    }
    ctx.audit({ action: 'session.setPlayers', entity: 'session', entityId: s.id, before: { players: before }, after: { players: p.players } });
    return { ok: true };
  },
});

export const pauseSession = defineCommand({
  type: 'session.pause',
  roles: [...both],
  schema: z.object({ sessionId: z.string() }),
  handler(ctx, p) {
    const s = liveOrThrow(ctx.db, p.sessionId);
    if (s.mode !== 'postpaid') throw new AppError('error.pause_prepaid', 409);
    hourlyPlan(s);
    if (s.status === 'paused') return { ok: true };
    closeOpenSegment(ctx, s.id);
    ctx.db.prepare("UPDATE sessions SET status = 'paused' WHERE id = ?").run(s.id);
    ctx.audit({ action: 'session.pause', entity: 'session', entityId: s.id });
    return { ok: true };
  },
});

export const resumeSession = defineCommand({
  type: 'session.resume',
  roles: [...both],
  schema: z.object({ sessionId: z.string() }),
  handler(ctx, p) {
    const s = liveOrThrow(ctx.db, p.sessionId);
    if (s.status === 'active') return { ok: true };
    const segs = segmentsOf(ctx.db, s.id);
    const last = segs[segs.length - 1];
    openSegment(ctx, s.id, last?.players ?? 1, last?.rateMinorPerHour ?? 0);
    ctx.db.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(s.id);
    ctx.audit({ action: 'session.resume', entity: 'session', entityId: s.id });
    return { ok: true };
  },
});

/** Ends a session and, for postpaid hourly time, posts the time charge to the tab. */
export function finishSession(ctx: CommandContext, s: SessionRow, reason: string): number {
  closeOpenSegment(ctx, s.id);
  let charged = 0;
  const plan = PricePlanConfig.parse(JSON.parse(s.plan));
  if (plan.kind === 'hourly' && s.mode === 'postpaid') {
    const segs = segmentsOf(ctx.db, s.id);
    const { billedMs, amountMinor } = priceTime(plan, segs, ctx.now);
    const station = stationOrThrow(ctx.db, s.station_id);
    const players = Math.max(...segs.map((x) => x.players));
    postLedger(ctx, {
      tabId: s.tab_id,
      kind: 'time',
      description: `${station.name} · ${minutesLabel(Math.round(billedMs / 60_000))}${players > 1 ? ` · up to ${players}P` : ''}`,
      unitMinor: amountMinor,
      amountMinor,
      sessionId: s.id,
    });
    charged = amountMinor;
  }
  ctx.db
    .prepare("UPDATE sessions SET status = 'ended', ended_at = ?, ended_by = ?, end_reason = ? WHERE id = ?")
    .run(ctx.now, ctx.actor.id, reason, s.id);
  ctx.audit({ action: 'session.end', entity: 'session', entityId: s.id, after: { reason, chargedMinor: charged } });
  return charged;
}

export const endSession = defineCommand({
  type: 'session.end',
  roles: [...both],
  schema: z.object({ sessionId: z.string() }),
  handler(ctx, p) {
    const s = liveOrThrow(ctx.db, p.sessionId);
    const chargedMinor = finishSession(ctx, s, 'operator');
    return { tabId: s.tab_id, chargedMinor };
  },
});

/**
 * Ends prepaid sessions whose time is up. Run by the host's ticker, outside the
 * command bus (there is no user action), with its own audit entries.
 */
export function expirePrepaidSessions(db: DB, now: number): number {
  const due = db
    .prepare("SELECT id FROM sessions WHERE mode = 'prepaid' AND status = 'active' AND started_at + prepaid_minutes * 60000 <= ?")
    .all(now) as { id: string }[];
  if (due.length === 0) return 0;
  db.transaction(() => {
    for (const { id } of due) {
      db.prepare('UPDATE session_segments SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL').run(now, id);
      db.prepare("UPDATE sessions SET status = 'ended', ended_at = ?, end_reason = 'time_up' WHERE id = ?").run(now, id);
      db.prepare("INSERT INTO audit_log (at, action, entity, entity_id, after) VALUES (?, 'session.expire', 'session', ?, ?)").run(
        now,
        id,
        JSON.stringify({ reason: 'time_up' }),
      );
    }
  })();
  return due.length;
}

/**
 * Moves a live session (and its tab) to another station, keeping its time and plan — the one-tap
 * fix when a PC freezes or dies and the customer carries on at a working one. No re-charge: the
 * accrued time and the original rate follow the session. Group sessions are moved as a whole only
 * by ending them, so a single member can't be split off here.
 */
export const moveSession = defineCommand({
  type: 'session.move',
  roles: [...both],
  schema: z.object({ sessionId: z.string(), toStationId: z.string() }),
  handler(ctx, p) {
    const s = liveOrThrow(ctx.db, p.sessionId);
    if (s.group_id) throw new AppError('error.group_move', 409);
    const target = stationOrThrow(ctx.db, p.toStationId);
    if (target.id === s.station_id) return { ok: true, tabId: s.tab_id };
    if (target.out_of_order) throw new AppError('error.station_out_of_order', 409);
    if (liveSessionForStation(ctx.db, target.id)) throw new AppError('error.station_busy', 409);
    if (openTabForStation(ctx.db, target.id)) throw new AppError('error.station_has_tab', 409);
    ctx.db.prepare('UPDATE sessions SET station_id = ? WHERE id = ?').run(target.id, s.id);
    ctx.db.prepare('UPDATE tabs SET station_id = ? WHERE id = ?').run(target.id, s.tab_id);
    ctx.audit({ action: 'session.move', entity: 'session', entityId: s.id, before: { stationId: s.station_id }, after: { stationId: target.id } });
    return { ok: true, tabId: s.tab_id, toStationId: target.id };
  },
});

/** Resumes every session paused by power-cut recovery, then clears the recovery banner. */
export const resumeInterrupted = defineCommand({
  type: 'recovery.resumeAll',
  roles: [...both],
  schema: z.object({}),
  handler(ctx) {
    const event = readRecoveryEvent(ctx.db);
    let resumed = 0;
    if (event) {
      for (const id of event.interrupted) {
        const s = sessionOrThrow(ctx.db, id);
        if (s.status !== 'paused') continue;
        const segs = segmentsOf(ctx.db, s.id);
        const last = segs[segs.length - 1];
        openSegment(ctx, s.id, last?.players ?? 1, last?.rateMinorPerHour ?? 0);
        ctx.db.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(s.id);
        ctx.audit({ action: 'session.resume', entity: 'session', entityId: s.id, after: { via: 'recovery' } });
        resumed++;
      }
    }
    clearRecoveryEvent(ctx.db);
    return { resumed };
  },
});

/** Dismisses the recovery banner, leaving the interrupted sessions paused for the operator to handle. */
export const dismissRecovery = defineCommand({
  type: 'recovery.dismiss',
  roles: [...both],
  schema: z.object({}),
  handler(ctx) {
    clearRecoveryEvent(ctx.db);
    return { ok: true };
  },
});

export const sessionCommands = [startSession, startGroup, endGroup, moveSession, extendSession, setPlayers, pauseSession, resumeSession, endSession, resumeInterrupted, dismissRecovery];
