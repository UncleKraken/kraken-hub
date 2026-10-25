import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { actorFromToken, issueToken, revokeToken, verifyPassword, type Actor } from './auth.js';
import { adminCommands, needsSetup, runSetup, SetupInput } from './commands/admin.js';
import { bookingCommands, expireNoShows } from './commands/bookings.js';
import { CommandBus, CommandEnvelope } from './commands/bus.js';
import { inventoryCommands } from './commands/inventory.js';
import { expirePrepaidSessions, sessionCommands } from './commands/sessions.js';
import { shiftCommands, summarizeShift } from './commands/shifts.js';
import { tabCommands } from './commands/tabs.js';
import type { DB } from './db/index.js';
import { deviceCommands, expireGuestRequests } from './devices/commands.js';
import { AgentHub, PairInput } from './devices/hub.js';
import type { ShiftRow } from './domain/venue.js';
import { readSettings } from './domain/venue.js';
import { AppError, forbidden, notFound, unauthorized } from './errors.js';
import { adminLists, auditPage, currentShift, floorState, inventoryView, tabDetail } from './queries.js';

export interface ServerOptions {
  db: DB;
  clock?: () => number;
  /** Directory with the built web app (index.html). Served at / when present. */
  webDir?: string;
  logger?: boolean;
  /** How often to check for expired prepaid sessions. 0 disables (tests). */
  tickMs?: number;
}

const LoginInput = z.object({ username: z.string().min(1), password: z.string().min(1) });

/** Simple in-memory brake on password guessing: 8 failures per username per 5 minutes. */
class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  check(key: string, now: number): void {
    const recent = (this.failures.get(key) ?? []).filter((t) => now - t < 5 * 60_000);
    this.failures.set(key, recent);
    if (recent.length >= 8) throw new AppError('error.too_many_attempts', 429);
  }
  fail(key: string, now: number): void {
    this.failures.set(key, [...(this.failures.get(key) ?? []), now]);
  }
  clear(key: string): void {
    this.failures.delete(key);
  }
}

export async function buildServer(opts: ServerOptions): Promise<{ app: FastifyInstance; bus: CommandBus; hub: AgentHub }> {
  const { db } = opts;
  const clock = opts.clock ?? Date.now;
  const hub = new AgentHub(db, clock);
  const bus = new CommandBus(db, clock).register(...sessionCommands, ...tabCommands, ...shiftCommands, ...adminCommands, ...bookingCommands, ...inventoryCommands, ...deviceCommands(hub));
  hub.attach(bus);
  const limiter = new LoginLimiter();
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024 });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, params: err.params } });
    }
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (e.validation || e.statusCode === 400) {
      return reply.status(400).send({ error: { code: 'error.invalid_input', params: { detail: e.message ?? '' } } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'error.internal', params: {} } });
  });

  const tokenOf = (req: FastifyRequest): string | undefined => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) return h.slice(7);
    const q = (req.query as Record<string, string> | undefined)?.token;
    return q || undefined;
  };
  const requireActor = (req: FastifyRequest): Actor => {
    const actor = actorFromToken(db, tokenOf(req), clock());
    if (!actor) throw unauthorized();
    return actor;
  };
  const requireManager = (req: FastifyRequest): Actor => {
    const actor = requireActor(req);
    if (actor.role !== 'manager') throw forbidden();
    return actor;
  };

  // ---- Live updates ----------------------------------------------------------
  await app.register(fastifyWebsocket);
  const sockets = new Set<{ send: (s: string) => void; readyState: number }>();
  const broadcast = (msg: object) => {
    const text = JSON.stringify(msg);
    for (const ws of sockets) if (ws.readyState === 1) ws.send(text);
  };
  bus.onChange((info) => broadcast({ type: 'changed', command: info.type, at: clock() }));
  hub.onPresenceChange(() => broadcast({ type: 'changed', command: 'device.presence', at: clock() }));

  app.get('/ws', { websocket: true }, (socket, req) => {
    const actor = actorFromToken(db, tokenOf(req), clock());
    if (!actor) {
      socket.close(4401, 'unauthorized');
      return;
    }
    sockets.add(socket);
    socket.send(JSON.stringify({ type: 'hello', at: clock() }));
    socket.on('close', () => sockets.delete(socket));
  });

  let ticker: NodeJS.Timeout | undefined;
  const tickMs = opts.tickMs ?? 5_000;
  if (tickMs > 0) {
    ticker = setInterval(() => {
      try {
        const grace = readSettings(db).noShowGraceMinutes;
        const expired = expirePrepaidSessions(db, clock()) + expireGuestRequests(db, clock()) + expireNoShows(db, clock(), grace);
        const devicesChanged = hub.tick();
        if (expired > 0 || devicesChanged) {
          hub.pushAll();
          broadcast({ type: 'changed', command: 'tick', at: clock() });
        }
      } catch (err) {
        app.log.error(err);
      }
    }, tickMs);
    ticker.unref();
  }
  app.addHook('onClose', async () => {
    if (ticker) clearInterval(ticker);
  });

  // ---- Public ------------------------------------------------------------------
  app.get('/api/health', async () => ({ ok: true, now: clock() }));

  app.get('/api/setup', async () => ({ needsSetup: needsSetup(db) }));

  app.post('/api/setup', async (req) => {
    if (!needsSetup(db)) throw new AppError('error.already_set_up', 409);
    const input = SetupInput.safeParse(req.body);
    if (!input.success) throw new AppError('error.invalid_input', 400, { detail: input.error.issues[0]?.message ?? '' });
    const userId = runSetup(db, input.data, clock());
    return { token: issueToken(db, userId, clock()) };
  });

  app.post('/api/login', async (req) => {
    const input = LoginInput.safeParse(req.body);
    if (!input.success) throw new AppError('error.invalid_input', 400);
    const key = input.data.username.toLowerCase();
    const now = clock();
    limiter.check(key, now);
    const row = db.prepare('SELECT id, password_hash FROM users WHERE username = ? AND active = 1').get(input.data.username) as
      | { id: string; password_hash: string }
      | undefined;
    if (!row || !verifyPassword(input.data.password, row.password_hash)) {
      limiter.fail(key, now);
      throw new AppError('error.bad_credentials', 401);
    }
    limiter.clear(key);
    const token = issueToken(db, row.id, now);
    db.prepare("INSERT INTO audit_log (at, actor_id, action, entity, entity_id) VALUES (?, ?, 'user.login', 'user', ?)").run(now, row.id, row.id);
    return { token };
  });

  // ---- Authenticated -------------------------------------------------------------
  app.post('/api/logout', async (req) => {
    const token = tokenOf(req);
    if (token) revokeToken(db, token);
    return { ok: true };
  });

  app.get('/api/state', async (req) => floorState(db, requireActor(req), clock(), hub.onlineIds()));

  // ---- Customer PCs ----------------------------------------------------------------------
  // PCs pair with a secret they generate themselves; the operator approves them on the floor.
  app.post('/api/agent/pair', async (req) => {
    const input = PairInput.safeParse(req.body);
    if (!input.success) throw new AppError('error.invalid_input', 400, { detail: input.error.issues[0]?.message ?? '' });
    return hub.pair(input.data, req.ip);
  });

  app.get('/api/agent/status', async (req) => {
    const q = req.query as { deviceId?: string; secret?: string };
    const d = q.deviceId && q.secret ? hub.authenticate(q.deviceId, q.secret) : null;
    if (!d) throw unauthorized();
    return { status: d.status };
  });

  app.get('/api/agent/ws', { websocket: true }, (socket, req) => {
    const q = req.query as { deviceId?: string; secret?: string; version?: string };
    const d = q.deviceId && q.secret ? hub.authenticate(q.deviceId, q.secret) : null;
    if (!d || d.status !== 'approved') {
      socket.close(4401, d ? d.status : 'unauthorized');
      return;
    }
    hub.connect(d, socket, req.ip, q.version ?? '');
    socket.on('message', (data: Buffer) => {
      const reply = hub.handle(d.id, data.toString());
      if (reply) socket.send(JSON.stringify(reply));
    });
    socket.on('close', () => hub.disconnect(d.id, socket));
  });

  app.get('/api/tabs/:id', async (req) => {
    requireActor(req);
    return tabDetail(db, (req.params as { id: string }).id);
  });

  app.get('/api/shift/current', async (req) => ({ shift: currentShift(db, requireActor(req)) }));

  app.post('/api/commands', async (req) => {
    const actor = requireActor(req);
    const env = CommandEnvelope.safeParse(req.body);
    if (!env.success) throw new AppError('error.invalid_input', 400, { detail: env.error.issues[0]?.message ?? '' });
    return { result: bus.execute(actor, env.data) };
  });

  // ---- Manager -------------------------------------------------------------------
  app.get('/api/admin', async (req) => {
    requireManager(req);
    return adminLists(db);
  });

  app.get('/api/shifts', async (req) => {
    requireManager(req);
    return db
      .prepare(
        `SELECT s.id, s.status, s.opened_at AS openedAt, s.closed_at AS closedAt, u.display_name AS userName
         FROM shifts s JOIN users u ON u.id = s.user_id ORDER BY s.opened_at DESC LIMIT 100`,
      )
      .all();
  });

  app.get('/api/shifts/:id', async (req) => {
    requireManager(req);
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get((req.params as { id: string }).id) as ShiftRow | undefined;
    if (!shift) throw notFound('shift');
    return summarizeShift(db, shift);
  });

  app.get('/api/audit', async (req) => {
    requireManager(req);
    const before = Number((req.query as { before?: string }).before);
    return auditPage(db, Number.isFinite(before) && before > 0 ? before : null);
  });

  // Inventory page data (tracked products, low stock, open orders) for both roles.
  app.get('/api/inventory', async (req) => {
    requireActor(req);
    return inventoryView(db);
  });

  // Booking history for the manager: everything from the last day onward, any status.
  app.get('/api/bookings', async (req) => {
    requireManager(req);
    const since = clock() - 24 * 60 * 60_000;
    const rows = db.prepare('SELECT id FROM bookings WHERE starts_at >= ? OR status IN (\'booked\', \'checked_in\') ORDER BY starts_at DESC LIMIT 200').all(since) as { id: string }[];
    const stationStmt = db.prepare('SELECT bs.station_id AS id, s.name FROM booking_stations bs JOIN stations s ON s.id = bs.station_id WHERE bs.booking_id = ?');
    const detail = db.prepare('SELECT * FROM bookings WHERE id = ?');
    return rows.map((r) => {
      const b = detail.get(r.id) as Record<string, unknown>;
      return {
        id: b.id,
        customerName: b.customer_name,
        phone: b.phone,
        startsAt: b.starts_at,
        durationMinutes: b.duration_minutes,
        notes: b.notes,
        source: b.source,
        depositMinor: b.deposit_minor,
        status: b.status,
        stations: stationStmt.all(r.id),
      };
    });
  });

  // ---- Web app -------------------------------------------------------------------
  if (opts.webDir && existsSync(opts.webDir)) {
    await app.register(fastifyStatic, { root: opts.webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        return reply.status(404).send({ error: { code: 'error.not_found', params: { what: 'route' } } });
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, bus, hub };
}
