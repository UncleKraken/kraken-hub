import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../auth.js';
import type { CommandBus } from '../commands/bus.js';
import type { DB } from '../db/index.js';
import { PricePlanConfig } from '../domain/pricing.js';
import { baseCurrency, liveSessionForStation, openTabForStation, readSettings, tabTotals, viewSession, type StationRow } from '../domain/venue.js';
import { AppError } from '../errors.js';
import { deviceOrThrow, type DeviceOutbox, type DeviceRow, type RemoteAction } from './commands.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The built-in account that signs actions coming from customer PCs. */
export const CLIENT_ACTOR: Actor = { id: 'system-client', username: 'system-client', displayName: 'Customer PC', role: 'operator' };

/** A PC is treated as offline after this long without a heartbeat. */
export const OFFLINE_AFTER_MS = 30_000;
/** Open time on a PC that stays offline this long is paused, so nobody pays for a crashed PC. */
export const AUTO_PAUSE_AFTER_MS = 90_000;

export const PairInput = z.object({
  machineId: z.string().min(8).max(128),
  hostname: z.string().min(1).max(64),
  mac: z.string().max(64).default(''),
  secret: z.string().min(32).max(256),
  version: z.string().max(32).default(''),
});

const AgentMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heartbeat') }),
  z.object({
    type: z.literal('request'),
    requestId: z.uuid(),
    kind: z.enum(['guest', 'help', 'order', 'extend']),
    payload: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({ type: z.literal('endSession'), requestId: z.uuid() }),
  z.object({ type: z.literal('ack'), id: z.string(), ok: z.boolean(), error: z.string().optional() }),
]);

interface Socket {
  send: (s: string) => void;
  close: (code?: number, reason?: string) => void;
  readyState: number;
}

export interface DeviceState {
  type: 'state';
  now: number;
  venueName: string;
  defaultLanguage: string;
  currency: { code: string; symbol: string; decimals: number };
  paired: boolean;
  station: { id: string; name: string; outOfOrder: boolean } | null;
  locked: boolean;
  reason: 'idle' | 'paused' | 'outOfOrder' | 'unpaired' | 'session';
  session: ReturnType<typeof viewSession> | null;
  planKind: 'hourly' | 'per_session' | null;
  tab: { balanceMinor: number; lines: { description: string; qty: number; amountMinor: number; reversed: boolean }[] } | null;
  products: { id: string; name: string; category: string; priceMinor: number }[];
  guestRequest: { id: string; status: string; result: unknown; createdAt: number } | null;
  openRequests: { id: string; kind: string; createdAt: number }[];
}

export class AgentHub implements DeviceOutbox {
  private readonly sockets = new Map<string, Set<Socket>>();
  private readonly lastBeat = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private bus: CommandBus | null = null;

  constructor(
    private readonly db: DB,
    private readonly clock: () => number,
  ) {}

  attach(bus: CommandBus): void {
    this.bus = bus;
    bus.onChange(() => this.pushAll());
  }

  /** Called when a PC connects or disconnects, so operator screens refresh. */
  onPresenceChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  // ---- Pairing -------------------------------------------------------------------------

  pair(input: z.infer<typeof PairInput>, ip: string): { deviceId: string; status: DeviceRow['status'] } {
    const now = this.clock();
    const secretHash = sha256(input.secret);
    const known = this.db
      .prepare("SELECT * FROM devices WHERE machine_id = ? AND secret_hash = ? AND status IN ('pending', 'approved') ORDER BY created_at DESC LIMIT 1")
      .get(input.machineId, secretHash) as DeviceRow | undefined;
    if (known) return { deviceId: known.id, status: known.status };

    const pending = (this.db.prepare("SELECT COUNT(*) AS n FROM devices WHERE status = 'pending'").get() as { n: number }).n;
    if (pending >= 100) throw new AppError('error.too_many_pending', 429);

    const id = randomUUID();
    this.db.transaction(() => {
      // A new request from the same PC replaces its older unanswered one.
      this.db.prepare("UPDATE devices SET status = 'rejected' WHERE machine_id = ? AND status = 'pending'").run(input.machineId);
      this.db
        .prepare(
          `INSERT INTO devices (id, machine_id, hostname, mac, secret_hash, status, client_version, last_ip, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(id, input.machineId, input.hostname, input.mac, secretHash, input.version, ip, now);
      this.db
        .prepare("INSERT INTO audit_log (at, actor_id, action, entity, entity_id, after) VALUES (?, 'system-client', 'device.pairRequest', 'device', ?, ?)")
        .run(now, id, JSON.stringify({ hostname: input.hostname, ip }));
    })();
    this.notifyPresence();
    return { deviceId: id, status: 'pending' };
  }

  /** Returns the device if the id and secret match an approved or pending PC. */
  authenticate(deviceId: string, secret: string): DeviceRow | null {
    const d = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as DeviceRow | undefined;
    if (!d || d.secret_hash !== sha256(secret)) return null;
    return d;
  }

  // ---- Live link ----------------------------------------------------------------------------

  connect(device: DeviceRow, socket: Socket, ip: string, version: string): void {
    const set = this.sockets.get(device.id) ?? new Set();
    set.add(socket);
    this.sockets.set(device.id, set);
    this.lastBeat.set(device.id, this.clock());
    this.db.prepare('UPDATE devices SET last_seen_at = ?, last_ip = ?, client_version = ? WHERE id = ?').run(this.clock(), ip, version || device.client_version, device.id);
    this.send(device.id, this.stateFor(device.id));
    this.notifyPresence();
  }

  disconnect(deviceId: string, socket: Socket): void {
    const set = this.sockets.get(deviceId);
    set?.delete(socket);
    if (set && set.size === 0) {
      this.sockets.delete(deviceId);
      this.notifyPresence();
    }
  }

  /** Handles one message from a PC; returns the reply to send back (if any). */
  handle(deviceId: string, raw: string): object | null {
    let msg: z.infer<typeof AgentMessage>;
    try {
      msg = AgentMessage.parse(JSON.parse(raw));
    } catch {
      return { type: 'error', code: 'error.invalid_input' };
    }
    const now = this.clock();
    this.lastBeat.set(deviceId, now);
    if (msg.type === 'heartbeat') {
      this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, deviceId);
      return null;
    }
    if (msg.type === 'ack') return null;
    if (!this.bus) return { type: 'error', code: 'error.internal' };
    const run = (type: string, payload: unknown) => {
      try {
        const result = this.bus!.executeInternal(CLIENT_ACTOR, { type, requestId: msg.requestId!, payload });
        return { type: 'result', requestId: msg.requestId, ok: true, result };
      } catch (e) {
        const code = e instanceof AppError ? e.code : 'error.internal';
        return { type: 'result', requestId: msg.requestId, ok: false, code };
      }
    };
    if (msg.type === 'request') return run('client.request', { deviceId, kind: msg.kind, payload: msg.payload });
    return run('client.endSession', { deviceId });
  }

  isOnline(deviceId: string): boolean {
    const beat = this.lastBeat.get(deviceId);
    return this.sockets.has(deviceId) && beat !== undefined && this.clock() - beat < OFFLINE_AFTER_MS;
  }

  onlineIds(): Set<string> {
    return new Set([...this.sockets.keys()].filter((id) => this.isOnline(id)));
  }

  sendCommand(deviceId: string, action: RemoteAction, text?: string): void {
    this.send(deviceId, { type: 'command', id: randomUUID(), action, text: text ?? null });
  }

  /** Sends every connected PC what it should show now. */
  pushAll(): void {
    for (const id of this.sockets.keys()) {
      try {
        this.send(id, this.stateFor(id));
      } catch {
        // A removed device keeps its socket until it reconnects; ignore.
      }
    }
  }

  /**
   * Periodic housekeeping (run by the server's ticker):
   * drops silent sockets and pauses open time on PCs that have been gone too long.
   * Returns true if anything changed that operator screens should show.
   */
  tick(): boolean {
    const now = this.clock();
    let changed = false;
    for (const [id, set] of this.sockets) {
      const beat = this.lastBeat.get(id) ?? 0;
      if (now - beat > OFFLINE_AFTER_MS * 2) {
        for (const s of set) s.close(4408, 'heartbeat timeout');
        this.sockets.delete(id);
        changed = true;
      }
    }
    if (this.bus) {
      const candidates = this.db
        .prepare(
          `SELECT s.id AS sessionId, d.id AS deviceId, d.last_seen_at AS lastSeen, s.plan
           FROM sessions s JOIN devices d ON d.station_id = s.station_id AND d.status = 'approved'
           WHERE s.status = 'active' AND s.mode = 'postpaid'`,
        )
        .all() as { sessionId: string; deviceId: string; lastSeen: number | null; plan: string }[];
      for (const c of candidates) {
        if (this.isOnline(c.deviceId)) continue;
        if (PricePlanConfig.parse(JSON.parse(c.plan)).kind !== 'hourly') continue;
        const seen = Math.max(this.lastBeat.get(c.deviceId) ?? 0, c.lastSeen ?? 0);
        if (seen === 0 || now - seen < AUTO_PAUSE_AFTER_MS) continue;
        try {
          this.bus.executeInternal(CLIENT_ACTOR, { type: 'session.pause', requestId: randomUUID(), payload: { sessionId: c.sessionId } });
          changed = true;
        } catch {
          // Already paused or ended in the meantime.
        }
      }
    }
    if (changed) this.notifyPresence();
    return changed;
  }

  stateFor(deviceId: string): DeviceState {
    const now = this.clock();
    const d = deviceOrThrow(this.db, deviceId);
    const settings = readSettings(this.db);
    const base = baseCurrency(this.db);
    const station =
      d.status === 'approved' && d.station_id
        ? (this.db.prepare('SELECT * FROM stations WHERE id = ? AND active = 1').get(d.station_id) as StationRow | undefined)
        : undefined;
    const sessionRow = station ? liveSessionForStation(this.db, station.id) : undefined;
    const session = sessionRow ? viewSession(this.db, sessionRow, now) : null;
    const tabRow = station ? openTabForStation(this.db, station.id) : undefined;
    const tab = tabRow
      ? {
          balanceMinor: tabTotals(this.db, tabRow.id).balanceMinor,
          lines: (
            this.db
              .prepare(
                `SELECT description, qty, amount_minor AS amountMinor,
                        (reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM ledger r WHERE r.reverses_id = l.id)) AS reversed
                 FROM ledger l WHERE tab_id = ? ORDER BY created_at, rowid`,
              )
              .all(tabRow.id) as { description: string; qty: number; amountMinor: number; reversed: number }[]
          ).map((l) => ({ ...l, reversed: !!l.reversed })),
        }
      : null;
    const guest = station
      ? (this.db
          .prepare("SELECT id, status, result, created_at FROM client_requests WHERE device_id = ? AND kind = 'guest' AND created_at > ? ORDER BY created_at DESC LIMIT 1")
          .get(d.id, now - 180_000) as { id: string; status: string; result: string | null; created_at: number } | undefined)
      : undefined;
    const planKind = station
      ? (PricePlanConfig.parse(JSON.parse((this.db.prepare('SELECT config FROM price_plans WHERE id = ?').get(station.price_plan_id) as { config: string }).config)).kind)
      : null;

    let reason: DeviceState['reason'] = 'idle';
    if (!station) reason = 'unpaired';
    else if (session?.status === 'paused') reason = 'paused';
    else if (session) reason = 'session';
    else if (station.out_of_order) reason = 'outOfOrder';

    return {
      type: 'state',
      now,
      venueName: settings.venueName,
      defaultLanguage: settings.defaultLanguage,
      currency: { code: base.code, symbol: base.symbol, decimals: base.decimals },
      paired: !!station,
      station: station ? { id: station.id, name: station.name, outOfOrder: !!station.out_of_order } : null,
      locked: reason !== 'session',
      reason,
      session,
      planKind,
      tab,
      products: this.db
        .prepare('SELECT id, name, category, price_minor AS priceMinor FROM products WHERE active = 1 ORDER BY category, sort, name')
        .all() as DeviceState['products'],
      guestRequest: guest ? { id: guest.id, status: guest.status, result: guest.result ? JSON.parse(guest.result) : null, createdAt: guest.created_at } : null,
      openRequests: this.db
        .prepare("SELECT id, kind, created_at AS createdAt FROM client_requests WHERE device_id = ? AND status = 'pending' AND kind <> 'guest' ORDER BY created_at")
        .all(d.id) as DeviceState['openRequests'],
    };
  }

  private send(deviceId: string, msg: object): void {
    const set = this.sockets.get(deviceId);
    if (!set) return;
    const text = JSON.stringify(msg);
    for (const s of set) if (s.readyState === 1) s.send(text);
  }

  private notifyPresence(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }
}
