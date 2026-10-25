import { z } from 'zod';
import type { DB } from '../db/index.js';
import { defineCommand, type CommandContext } from '../commands/bus.js';
import { extendSession, finishSession, startSession } from '../commands/sessions.js';
import { addItem } from '../commands/tabs.js';
import { liveSessionForStation, stationOrThrow } from '../domain/venue.js';
import { AppError, notFound } from '../errors.js';

/** What the device link needs from the outside world; the AgentHub implements it. */
export interface DeviceOutbox {
  sendCommand(deviceId: string, action: RemoteAction, text?: string): void;
}

export type RemoteAction = 'restart' | 'shutdown' | 'message' | 'logoff';

export interface DeviceRow {
  id: string;
  machine_id: string;
  hostname: string;
  mac: string;
  secret_hash: string;
  status: 'pending' | 'approved' | 'rejected' | 'removed';
  station_id: string | null;
  client_version: string;
  last_ip: string;
  last_seen_at: number | null;
  created_at: number;
}

export function deviceOrThrow(db: DB, id: string): DeviceRow {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  if (!d) throw notFound('device');
  return d;
}

export function deviceForStation(db: DB, stationId: string): DeviceRow | undefined {
  return db.prepare("SELECT * FROM devices WHERE station_id = ? AND status = 'approved'").get(stationId) as DeviceRow | undefined;
}

interface RequestRow {
  id: string;
  device_id: string;
  station_id: string | null;
  kind: 'guest' | 'help' | 'order' | 'extend';
  payload: string;
  status: 'pending' | 'done' | 'declined' | 'expired';
  created_at: number;
}

function pendingRequest(ctx: CommandContext, id: string): RequestRow {
  const r = ctx.db.prepare('SELECT * FROM client_requests WHERE id = ?').get(id) as RequestRow | undefined;
  if (!r) throw notFound('request');
  if (r.status !== 'pending') throw new AppError('error.request_handled', 409);
  return r;
}

function resolve(ctx: CommandContext, r: RequestRow, status: 'done' | 'declined', result: unknown) {
  ctx.db
    .prepare('UPDATE client_requests SET status = ?, result = ?, resolved_at = ?, resolved_by = ? WHERE id = ?')
    .run(status, JSON.stringify(result), ctx.now, ctx.actor.id, r.id);
  ctx.audit({ action: `request.${r.kind}.${status}`, entity: 'client_request', entityId: r.id, after: result });
}

/** Builds the commands that need to reach customer PCs. */
export function deviceCommands(outbox: DeviceOutbox) {
  const both = ['operator', 'manager'] as const;

  const approve = defineCommand({
    type: 'device.approve',
    roles: [...both],
    schema: z.object({ deviceId: z.string(), stationId: z.string() }),
    handler(ctx, p) {
      const d = deviceOrThrow(ctx.db, p.deviceId);
      if (d.status !== 'pending') throw new AppError('error.device_not_pending', 409);
      const station = stationOrThrow(ctx.db, p.stationId);
      const current = deviceForStation(ctx.db, station.id);
      if (current) {
        // Re-pairing (new Windows install, new client): the old link is retired.
        ctx.db.prepare("UPDATE devices SET status = 'removed', station_id = NULL WHERE id = ?").run(current.id);
        ctx.audit({ action: 'device.replace', entity: 'device', entityId: current.id, after: { replacedBy: d.id } });
      }
      // The same PC may have an older approved record under another station.
      ctx.db.prepare("UPDATE devices SET status = 'removed', station_id = NULL WHERE machine_id = ? AND status = 'approved' AND id <> ?").run(d.machine_id, d.id);
      ctx.db
        .prepare("UPDATE devices SET status = 'approved', station_id = ?, approved_at = ?, approved_by = ? WHERE id = ?")
        .run(station.id, ctx.now, ctx.actor.id, d.id);
      if (station.control !== 'agent') ctx.db.prepare("UPDATE stations SET control = 'agent' WHERE id = ?").run(station.id);
      ctx.audit({ action: 'device.approve', entity: 'device', entityId: d.id, after: { hostname: d.hostname, stationId: station.id, name: station.name } });
      return { ok: true };
    },
  });

  const reject = defineCommand({
    type: 'device.reject',
    roles: [...both],
    schema: z.object({ deviceId: z.string() }),
    handler(ctx, p) {
      const d = deviceOrThrow(ctx.db, p.deviceId);
      if (d.status !== 'pending') throw new AppError('error.device_not_pending', 409);
      ctx.db.prepare("UPDATE devices SET status = 'rejected' WHERE id = ?").run(d.id);
      ctx.audit({ action: 'device.reject', entity: 'device', entityId: d.id, after: { hostname: d.hostname } });
      return { ok: true };
    },
  });

  /** Operator clears the open health alerts on a PC once they've dealt with them. */
  const ackHealth = defineCommand({
    type: 'device.ackHealth',
    roles: [...both],
    schema: z.object({ deviceId: z.string() }),
    handler(ctx, p) {
      const d = deviceOrThrow(ctx.db, p.deviceId);
      const res = ctx.db
        .prepare('UPDATE device_events SET acknowledged_at = ?, acknowledged_by = ? WHERE device_id = ? AND acknowledged_at IS NULL')
        .run(ctx.now, ctx.actor.id, d.id);
      if (res.changes > 0) ctx.audit({ action: 'device.ackHealth', entity: 'device', entityId: d.id, after: { cleared: res.changes } });
      return { cleared: res.changes };
    },
  });

  const unpair = defineCommand({
    type: 'device.remove',
    roles: ['manager'],
    schema: z.object({ deviceId: z.string() }),
    handler(ctx, p) {
      const d = deviceOrThrow(ctx.db, p.deviceId);
      ctx.db.prepare("UPDATE devices SET status = 'removed', station_id = NULL WHERE id = ?").run(d.id);
      ctx.audit({ action: 'device.remove', entity: 'device', entityId: d.id, before: { stationId: d.station_id }, after: { hostname: d.hostname } });
      return { ok: true };
    },
  });

  const remote = defineCommand({
    type: 'station.remote',
    roles: [...both],
    schema: z.object({
      stationId: z.string(),
      action: z.enum(['restart', 'shutdown', 'message', 'logoff']),
      text: z.string().trim().max(200).optional(),
    }),
    handler(ctx, p) {
      const station = stationOrThrow(ctx.db, p.stationId);
      const d = deviceForStation(ctx.db, station.id);
      if (!d) throw new AppError('error.no_device', 409);
      if (p.action === 'message' && !p.text) throw new AppError('error.invalid_input', 400, { detail: 'text' });
      ctx.audit({ action: `station.remote.${p.action}`, entity: 'station', entityId: station.id, after: { text: p.text ?? null } });
      ctx.afterCommit(() => outbox.sendCommand(d.id, p.action, p.text));
      return { ok: true };
    },
  });

  /** Operator answers a "Continue as guest" request from a PC. */
  const resolveGuest = defineCommand({
    type: 'request.resolveGuest',
    roles: [...both],
    schema: z.object({
      requestId: z.string(),
      decision: z.enum(['approve', 'move', 'deny']),
      mode: z.enum(['prepaid', 'postpaid']).default('postpaid'),
      prepaidMinutes: z.number().int().min(1).max(24 * 60).optional(),
      players: z.number().int().min(1).max(16).default(1),
      toStationId: z.string().optional(),
    }),
    handler(ctx, p) {
      const r = pendingRequest(ctx, p.requestId);
      if (r.kind !== 'guest') throw new AppError('error.invalid_input', 400, { detail: 'not a guest request' });
      if (!r.station_id) throw new AppError('error.no_device', 409);
      if (p.decision === 'approve') {
        const started = startSession.handler(ctx, {
          stationId: r.station_id,
          mode: p.mode,
          players: p.players,
          prepaidMinutes: p.prepaidMinutes,
        }) as { sessionId: string; tabId: string };
        resolve(ctx, r, 'done', { decision: 'approve', sessionId: started.sessionId });
        return started;
      }
      if (p.decision === 'move') {
        if (!p.toStationId) throw new AppError('error.invalid_input', 400, { detail: 'toStationId' });
        const target = stationOrThrow(ctx.db, p.toStationId);
        resolve(ctx, r, 'declined', { decision: 'move', toStationId: target.id, toStationName: target.name });
        return { ok: true };
      }
      resolve(ctx, r, 'declined', { decision: 'deny' });
      return { ok: true };
    },
  });

  /** Operator closes a help or order request; a delivered order is added to the station's tab. */
  const resolveRequest = defineCommand({
    type: 'request.resolve',
    roles: [...both],
    schema: z.object({ requestId: z.string(), decision: z.enum(['done', 'declined']) }),
    handler(ctx, p) {
      const r = pendingRequest(ctx, p.requestId);
      if (r.kind === 'guest') throw new AppError('error.invalid_input', 400, { detail: 'use request.resolveGuest' });
      if (r.kind === 'order' && p.decision === 'done') {
        if (!r.station_id) throw new AppError('error.no_device', 409);
        const items = (JSON.parse(r.payload) as { items?: { productId: string; qty: number }[] }).items ?? [];
        for (const it of items) addItem.handler(ctx, { stationId: r.station_id, productId: it.productId, qty: it.qty });
      }
      if (r.kind === 'extend' && p.decision === 'done') {
        // Open-time sessions just keep running; prepaid ones get the requested minutes (charged to the tab).
        const minutes = (JSON.parse(r.payload) as { minutes?: number }).minutes ?? 30;
        const s = r.station_id ? liveSessionForStation(ctx.db, r.station_id) : undefined;
        if (!s) throw new AppError('error.session_ended', 409);
        if (s.mode === 'prepaid') extendSession.handler(ctx, { sessionId: s.id, minutes });
      }
      resolve(ctx, r, p.decision, { decision: p.decision });
      return { ok: true };
    },
  });

  // ---- Sent by customer PCs (internal) ----------------------------------------------------

  const clientRequest = defineCommand({
    type: 'client.request',
    roles: ['operator'],
    internal: true,
    schema: z.object({
      deviceId: z.string(),
      kind: z.enum(['guest', 'help', 'order', 'extend']),
      payload: z
        .object({
          topic: z.enum(['pc', 'headphones', 'operator', 'other']).optional(),
          items: z.array(z.object({ productId: z.string(), qty: z.number().int().min(1).max(20) })).max(20).optional(),
          minutes: z.number().int().min(5).max(240).optional(),
        })
        .default({}),
    }),
    handler(ctx, p) {
      const d = deviceOrThrow(ctx.db, p.deviceId);
      if (d.status !== 'approved' || !d.station_id) throw new AppError('error.device_not_paired', 403);
      const station = stationOrThrow(ctx.db, d.station_id);
      const live = liveSessionForStation(ctx.db, station.id);
      if (p.kind === 'guest') {
        if (live) throw new AppError('error.station_busy', 409);
        if (station.out_of_order) throw new AppError('error.station_out_of_order', 409);
        const existing = ctx.db
          .prepare("SELECT id FROM client_requests WHERE device_id = ? AND kind = 'guest' AND status = 'pending'")
          .get(d.id) as { id: string } | undefined;
        if (existing) return { requestId: existing.id };
      } else if (!live) {
        throw new AppError('error.no_session', 409);
      }
      if (p.kind === 'order') {
        const items = p.payload.items ?? [];
        if (items.length === 0) throw new AppError('error.invalid_input', 400, { detail: 'items' });
        for (const it of items) {
          if (!ctx.db.prepare('SELECT 1 FROM products WHERE id = ? AND active = 1').get(it.productId)) throw notFound('product');
        }
      }
      const id = ctx.id();
      ctx.db
        .prepare("INSERT INTO client_requests (id, device_id, station_id, kind, payload, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
        .run(id, d.id, station.id, p.kind, JSON.stringify(p.payload), ctx.now);
      ctx.audit({ action: `request.${p.kind}`, entity: 'client_request', entityId: id, after: { station: station.name, ...p.payload } });
      return { requestId: id };
    },
  });

  const clientEndSession = defineCommand({
    type: 'client.endSession',
    roles: ['operator'],
    internal: true,
    schema: z.object({ deviceId: z.string() }),
    handler(ctx, p) {
      const d = deviceOrThrow(ctx.db, p.deviceId);
      if (d.status !== 'approved' || !d.station_id) throw new AppError('error.device_not_paired', 403);
      const s = liveSessionForStation(ctx.db, d.station_id);
      if (!s) return { ok: true };
      finishSession(ctx, s, 'customer');
      return { ok: true };
    },
  });

  return [approve, reject, ackHealth, unpair, remote, resolveGuest, resolveRequest, clientRequest, clientEndSession];
}

/** Guest requests nobody answered within two minutes expire; the PC tells the customer to come to the counter. */
export function expireGuestRequests(db: DB, now: number): number {
  const res = db
    .prepare("UPDATE client_requests SET status = 'expired', resolved_at = ? WHERE kind = 'guest' AND status = 'pending' AND created_at <= ?")
    .run(now, now - 120_000);
  return res.changes;
}
